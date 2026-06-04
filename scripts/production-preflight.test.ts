import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveHostedSandboxConfig } from "../packages/core/src/index.js";
import { parseProductionEnvFile } from "./production-env.js";
import { validateProductionManifest } from "./production-manifest.js";
import { runProductionPreflight } from "./production-preflight.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-production-preflight-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

const ACTIVE_COUNTS = {
  accounts: 1,
  tenants: 1,
  projects: 1,
  users: 1,
  apiKeys: 1,
  billingPlans: 1
};

function makeServerConfig(overrides: Record<string, unknown> = {}): any {
  return {
    deploymentMode: "production",
    serverAuthMode: "api_key",
    postgresUrl: "postgres://user:pw@db.example:5432/switchyard",
    redisUrl: "redis://:pw@redis.example:6379/0",
    queueName: "switchyard-hosted-runs",
    hostedRuntimeAllowlist: ["fake.deterministic"],
    hostedRealRuntimeExecution: "disabled",
    nodeSharedToken: "x".repeat(32),
    controlPlaneBootstrap: {
      active: { ...ACTIVE_COUNTS },
      nodeTokenBindings: [{ token: "x".repeat(32), apiKeyId: "api_key_1" }]
    },
    ...overrides
  };
}

function makeWorkerConfig(overrides: Record<string, unknown> = {}): any {
  return {
    deploymentMode: "production",
    redisUrl: "redis://:pw@redis.example:6379/0",
    queueName: "switchyard-hosted-runs",
    objectStore: { backend: "memory", probe: "write_read_delete", redactedSummary: { backend: "memory" } },
    sandbox: resolveHostedSandboxConfig({ deploymentMode: "production", env: {} }),
    tools: {
      hostedRealTools: "disabled",
      connectedNodeRealTools: "disabled",
      adapterMode: "fake",
      policySourceKind: "none",
      policy: {
        global: { enabled: false, allowedPlacements: ["local"] },
        hosted: { enabled: false, allowedToolTypes: [] },
        connectedLocalNode: { enabled: false, allowedToolTypes: [] },
        fetch: { enabled: false },
        webSearch: { enabled: false },
        github: { enabled: false },
        repo: { enabled: false },
        shell: { enabled: false, catalog: {} }
      }
    },
    ...overrides
  };
}

function makeToolPolicy(overrides: Record<string, unknown> = {}): any {
  return {
    global: {
      enabled: true,
      allowedPlacements: ["hosted", "connected_local_node"],
      approvalDefault: "required",
      approvalExpiresMs: 300000,
      maxConcurrentRealTools: 2,
      maxInputBytes: 65536,
      maxInlineOutputBytes: 32768,
      maxArtifactBytes: 1048576,
      defaultTimeoutMs: 30000
    },
    hosted: {
      enabled: true,
      allowedToolTypes: ["fetch", "web_search", "github", "shell"]
    },
    connectedLocalNode: {
      enabled: true,
      allowedToolTypes: ["fetch", "web_search", "github", "repo", "shell"]
    },
    fetch: {
      enabled: true,
      allowedHosts: ["example.com"],
      allowedMethods: ["GET", "HEAD"],
      allowedHeaders: [],
      allowedContentTypes: ["text/plain", "application/json"],
      maxRedirects: 3,
      timeoutMs: 30000,
      maxResponseBytes: 262144
    },
    webSearch: {
      enabled: true,
      maxResults: 10,
      timeoutMs: 20000,
      maxResponseBytes: 262144
    },
    github: {
      enabled: true,
      allowedRepos: ["example/repo"],
      timeoutMs: 30000,
      maxResponseBytes: 262144
    },
    repo: {
      enabled: true,
      gitBinary: "git",
      allowedCwdPrefixes: ["/repo"],
      maxPaths: 32,
      timeoutMs: 20000,
      maxOutputBytes: 262144
    },
    shell: {
      enabled: true,
      allowedCwdPrefixes: ["/repo"],
      timeoutMs: 20000,
      maxOutputBytes: 262144,
      catalog: {
        "switchyard.fake.echo": {
          commandId: "switchyard.fake.echo",
          executablePath: "/usr/bin/env",
          argv: ["echo"],
          env: {},
          maxArgs: 4
        }
      }
    },
    ...overrides
  };
}

function makeProviderActivation(
  overrides: {
    valid?: boolean;
    enabledRealModes?: string[];
    reasons?: Array<{ code: string; runtimeMode?: string }>;
    source?: "none" | "json" | "path";
    reasonCodes?: string[];
  } = {}
): any {
  const reasons = overrides.reasons ?? [];
  const reasonCodes = overrides.reasonCodes ?? reasons.map((entry) => entry.code);
  return {
    valid: overrides.valid ?? true,
    enabledRealModes: overrides.enabledRealModes ?? [],
    reasons,
    redactedSummary: {
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      realModeCount: 1,
      enabledRealModeCount: (overrides.enabledRealModes ?? []).length,
      source: { kind: overrides.source ?? "json" },
      modeStatuses: [
        {
          runtimeMode: "codex.exec_json",
          ready: (overrides.valid ?? true) && (overrides.enabledRealModes ?? []).includes("codex.exec_json"),
          reasons: reasonCodes
        }
      ],
      reasonCodes
    },
    policy: {
      version: 1,
      modes: {
        "codex.exec_json": {
          enabled: true,
          executablePath: "/bin/echo",
          cwdPrefixes: ["/srv/switchyard/work"],
          envAllowlist: ["OPENAI_API_KEY", "PATH"],
          requiredEnv: ["OPENAI_API_KEY"],
          fixedArgs: ["exec", "--json"],
          allowUserArgs: false,
          sandbox: "read_only",
          spendControls: {
            maxActiveRuns: 2,
            maxRunsPerHour: 20,
            maxRunTimeoutSeconds: 300,
            maxPromptBytes: 60000
          }
        }
      }
    }
  };
}

async function runDependencyPreflight(deps: Record<string, unknown>): Promise<Awaited<ReturnType<typeof runProductionPreflight>>> {
  return withTempResult(async (dir) => {
    const envPath = join(dir, "ok.env");
    await writeFile(envPath, "SWITCHYARD_DEPLOYMENT_MODE=production\n", "utf8");
    return runProductionPreflight({
      envFile: envPath,
      deps: {
        validateManifest: async () => ({ ok: true, manifest: {} as never }),
        loadServerConfig: () => makeServerConfig(),
        loadWorkerConfig: () => makeWorkerConfig(),
        openPostgresDatabase: () => ({ close: async () => undefined } as never),
        checkPostgresSchemaCompatibility: async () => ({ ok: true, code: "postgres_schema_ready", version: 19 }),
        queueStats: async () => undefined,
        probeObjectStore: async () => undefined,
        checkControlPlane: async () => ({ checks: [] }),
        checkHostedRuntimeGate: async () => ({
          ok: true,
          diagnostics: {
            hostedDebate: {
              ok: true
            }
          }
        }),
        ...deps
      }
    });
  });
}

async function withTempResult<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "switchyard-production-preflight-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function failedCodes(result: Awaited<ReturnType<typeof runProductionPreflight>>): string[] {
  return result.checks.filter((entry) => entry.status === "fail").map((entry) => entry.code);
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    services: {
      server: {
        deploymentMode: "production",
        command: ["node", "apps/server/dist/main.js"],
        requiredEnv: [
          "SWITCHYARD_DEPLOYMENT_MODE",
          "SWITCHYARD_SERVER_AUTH_MODE",
          "SWITCHYARD_CONTROL_PLANE_STORE",
          "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
          "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
          "SWITCHYARD_SANDBOX_REAL_EXECUTION"
        ],
        healthChecks: ["GET /health", "GET /ready"],
        policy: {
          runtimeAllowlist: ["fake.deterministic"],
          hostedRealRuntimeExecution: "disabled",
          objectStoreProbe: "write_read_delete",
          sandboxExecution: {
            realExecution: "disabled",
            commandPolicy: "required_when_enabled",
            networkPolicy: "disabled"
          }
        }
      },
      worker: {
        deploymentMode: "production",
        command: ["node", "apps/worker/dist/main.js"],
        requiredEnv: [
          "SWITCHYARD_DEPLOYMENT_MODE",
          "SWITCHYARD_OBJECT_STORE_PROBE",
          "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
          "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
          "SWITCHYARD_SANDBOX_REAL_EXECUTION"
        ],
        readinessGate: {
          command: ["node", "apps/worker/dist/ready.js"]
        },
        policy: {
          runtimeAllowlist: ["fake.deterministic"],
          hostedRealRuntimeExecution: "disabled",
          objectStoreProbe: "write_read_delete",
          sandboxExecution: {
            realExecution: "disabled",
            commandPolicy: "required_when_enabled",
            networkPolicy: "disabled"
          }
        }
      },
      node: {
        deploymentMode: "production",
        command: ["node", "apps/node/dist/main.js"],
        requiredEnv: [
          "SWITCHYARD_DEPLOYMENT_MODE",
          "SWITCHYARD_SERVER_URL",
          "SWITCHYARD_NODE_SHARED_TOKEN",
          "SWITCHYARD_NODE_CAPABILITIES",
          "SWITCHYARD_NODE_ALLOW_RUNTIME_MODES",
          "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES"
        ],
        policy: {
          runtimeAllowlist: ["fake.deterministic"],
          hostedRealRuntimeExecution: "disabled",
          realTools: "forbidden"
        }
      }
    },
    requiredEnv: [
      "SWITCHYARD_DEPLOYMENT_MODE",
      "SWITCHYARD_SERVER_AUTH_MODE",
      "SWITCHYARD_CONTROL_PLANE_STORE",
      "SWITCHYARD_POSTGRES_URL",
      "SWITCHYARD_REDIS_URL",
      "SWITCHYARD_OBJECT_STORE_BACKEND",
      "SWITCHYARD_OBJECT_STORE_PROBE",
      "SWITCHYARD_NODE_SHARED_TOKEN",
      "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
      "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
      "SWITCHYARD_SANDBOX_REAL_EXECUTION"
    ],
    forbiddenSurfaces: ["dashboard", "tui", "payment", "oauth", "browser", "/sandbox", "/exec", "/shell", "/process", "/command", "/pty", "/terminal"],
    ...overrides
  };
}

describe("parseProductionEnvFile", () => {
  test("parses comments, quoted values, and inline comments", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "production.env");
      await writeFile(
        envPath,
        [
          "# full-line comment",
          "KEY_A = value-a",
          "KEY_B='literal # value'",
          'KEY_C="escaped \\" quote and \\\\ slash" # allowed comment',
          "KEY_D=trimmed   # comment",
          "KEY_E=",
          "KEY_F='   '"
        ].join("\n"),
        "utf8"
      );

      const parsed = await parseProductionEnvFile(envPath);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      expect(parsed.values).toEqual({
        KEY_A: "value-a",
        KEY_B: "literal # value",
        KEY_C: 'escaped " quote and \\ slash',
        KEY_D: "trimmed",
        KEY_E: "",
        KEY_F: ""
      });
    });
  });

  test("returns env_duplicate_key for duplicate assignments", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "dup.env");
      await writeFile(envPath, "SWITCHYARD_PORT=4646\nSWITCHYARD_PORT=9999\n", "utf8");

      const parsed = await parseProductionEnvFile(envPath);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) {
        return;
      }
      expect(parsed.errors).toEqual([
        { code: "env_duplicate_key", key: "SWITCHYARD_PORT", line: 2 }
      ]);
    });
  });

  test("returns env_file_invalid_line for malformed lines and unterminated quotes", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "invalid.env");
      await writeFile(envPath, "NOT VALID\nKEY='unterminated\n", "utf8");

      const parsed = await parseProductionEnvFile(envPath);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) {
        return;
      }
      expect(parsed.errors).toEqual([
        { code: "env_file_invalid_line", line: 1 },
        { code: "env_file_invalid_line", line: 2 }
      ]);
    });
  });

  test("returns env_file_empty for zero-byte or whitespace-only files", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "empty.env");
      await writeFile(envPath, " \n\t\n", "utf8");

      const parsed = await parseProductionEnvFile(envPath);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) {
        return;
      }
      expect(parsed.errors).toEqual([{ code: "env_file_empty" }]);
    });
  });
});

describe("validateProductionManifest", () => {
  test("returns manifest_missing when manifest file path does not exist", async () => {
    const result = await validateProductionManifest("/definitely/missing/manifest.json");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors[0]?.code).toBe("manifest_missing");
  });

  test("returns manifest_invalid for malformed json", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      await writeFile(manifestPath, "{", "utf8");
      const result = await validateProductionManifest(manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors[0]?.code).toBe("manifest_invalid");
    });
  });

  test("returns manifest_forbidden_command and manifest_forbidden_surface", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          services: {
            server: {
              deploymentMode: "production",
              command: ["pnpm", "--filter", "@switchyard/server", "dev"],
              requiredEnv: ["SWITCHYARD_DEPLOYMENT_MODE"],
              healthChecks: ["GET /health", "GET /ready"]
            },
            worker: {
              deploymentMode: "production",
              command: ["node", "apps/worker/dist/main.js"],
              requiredEnv: ["SWITCHYARD_DEPLOYMENT_MODE", "SWITCHYARD_OBJECT_STORE_PROBE"],
              readinessChecks: ["worker-ready"]
            },
            dashboard: {
              deploymentMode: "production",
              command: ["node", "dashboard.js"],
              requiredEnv: []
            }
          },
          requiredEnv: ["SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST", "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"],
          forbiddenSurfaces: []
        }),
        "utf8"
      );

      const result = await validateProductionManifest(manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      const codes = result.errors.map((entry) => entry.code);
      expect(codes).toContain("manifest_forbidden_command");
      expect(codes).toContain("manifest_forbidden_surface");
    });
  });

  test("returns manifest_env_missing for missing required env keys", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify(validManifest({ requiredEnv: ["SWITCHYARD_DEPLOYMENT_MODE"] })),
        "utf8"
      );

      const result = await validateProductionManifest(manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors.map((entry) => entry.code)).toContain("manifest_env_missing");
    });
  });

  test("rejects missing worker readiness gate path or startup gate", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      const manifest = validManifest();
      delete (manifest.services as any).worker.readinessGate;
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

      const result = await validateProductionManifest(manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors).toContainEqual({ code: "manifest_invalid", service: "worker" });
    });
  });

  test("rejects free-text worker readiness substitutes", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      const manifest = validManifest();
      (manifest.services as any).worker.readinessGate = {
        command: ["P18-T4 worker startup/claim gate"]
      };
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

      const result = await validateProductionManifest(manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors).toContainEqual({ code: "manifest_invalid", service: "worker" });
    });
  });

  test("rejects non-fake runtime posture declared by services", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      const manifest = validManifest();
      (manifest.services as any).worker.policy = {
        runtimeAllowlist: ["fake.deterministic", "codex.exec_json"],
        hostedRealRuntimeExecution: "disabled",
        objectStoreProbe: "write_read_delete"
      };
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

      const result = await validateProductionManifest(manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors).toContainEqual({ code: "manifest_forbidden_surface", service: "worker" });
    });
  });

  test("rejects omitted explicit runtime posture", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      const manifest = validManifest();
      delete (manifest.services as any).server.policy.runtimeAllowlist;
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

      const result = await validateProductionManifest(manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors).toContainEqual({ code: "manifest_forbidden_surface", service: "server" });
    });
  });

  test("rejects missing forbidden execution surface posture entries", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      const manifest = validManifest();
      (manifest as any).forbiddenSurfaces = ["dashboard", "tui", "payment", "oauth", "browser", "/sandbox", "/exec", "/pty", "/terminal"];
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

      const result = await validateProductionManifest(manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors).toContainEqual({ code: "manifest_forbidden_surface", service: "forbiddenSurfaces" });
    });
  });

  test("rejects missing sandbox execution policy posture", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      const manifest = validManifest();
      delete (manifest.services as any).worker.policy.sandboxExecution;
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

      const result = await validateProductionManifest(manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors).toContainEqual({ code: "manifest_forbidden_surface", service: "worker" });
    });
  });

  test("rejects disabled object-store probe posture", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      const manifest = validManifest();
      (manifest.services as any).worker.policy = {
        runtimeAllowlist: ["fake.deterministic"],
        hostedRealRuntimeExecution: "disabled",
        objectStoreProbe: "disabled"
      };
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

      const result = await validateProductionManifest(manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors).toContainEqual({ code: "manifest_invalid", service: "worker" });
    });
  });

  test("rejects missing object-store probe posture", async () => {
    await withTempDir(async (dir) => {
      const manifestPath = join(dir, "manifest.json");
      const manifest = validManifest();
      delete (manifest.services as any).worker.policy.objectStoreProbe;
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

      const result = await validateProductionManifest(manifestPath);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors).toContainEqual({ code: "manifest_invalid", service: "worker" });
    });
  });
});

describe("runProductionPreflight", () => {
  test("marks provider runtime policy inactive for fake-only production", async () => {
    const result = await runDependencyPreflight({});
    const providerPolicy = result.checks.find((entry) => entry.name === "providerRuntimePolicy");
    expect(providerPolicy).toMatchObject({
      name: "providerRuntimePolicy",
      status: "pass",
      code: "provider_runtime_policy_inactive"
    });
  });

  test("passes fake no-spend hosted debate readiness when dependencies are ready", async () => {
    const result = await runDependencyPreflight({});

    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate",
      status: "pass",
      code: "hosted_debate_ready"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate.debateStore",
      status: "pass",
      code: "hosted_debate_store_ready"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate.debateExecutionOutbox",
      status: "pass",
      code: "hosted_debate_outbox_ready"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate.workerReadiness",
      status: "pass",
      code: "hosted_debate_worker_ready"
    }));
  });

  test("fails hosted debate worker readiness closed when readiness diagnostics are missing", async () => {
    const result = await runDependencyPreflight({
      checkHostedRuntimeGate: async () => ({ ok: true })
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate.workerReadiness",
      status: "fail",
      code: "hosted_debate_worker_unavailable"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate",
      status: "fail",
      code: "hosted_debate_worker_unavailable"
    }));
  });

  test("fails hosted debate preflight closed for missing auth, queue, quota, audit, object store, and worker readiness", async () => {
    const result = await runDependencyPreflight({
      loadServerConfig: () => makeServerConfig({ serverAuthMode: "none" }),
      queueStats: async () => {
        throw new Error("queue down");
      },
      probeObjectStore: async () => {
        throw new Error("object_store_unavailable");
      },
      checkControlPlane: async () => ({
        checks: [
          { name: "quotaStore", ok: false, code: "quota_store_unavailable" },
          { name: "auditStore", ok: false, code: "audit_store_unavailable" }
        ]
      }),
      checkHostedRuntimeGate: async () => ({
        ok: true,
        diagnostics: {
          hostedDebate: {
            ok: false,
            code: "hosted_debate_worker_unavailable"
          }
        }
      })
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate.auth",
      status: "fail",
      code: "hosted_debate_auth_required"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate.debateExecutionOutbox",
      status: "fail",
      code: "hosted_debate_queue_unavailable"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate.quota",
      status: "fail",
      code: "quota_store_unavailable"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate.audit",
      status: "fail",
      code: "audit_store_unavailable"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate.objectStore",
      status: "fail",
      code: "object_store_unavailable"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedDebate.workerReadiness",
      status: "fail",
      code: "hosted_debate_worker_unavailable"
    }));
  });

  test("fails closed when hosted runtime bridge dependencies are missing for Claude/OpenCode modes", async () => {
    const activation = makeProviderActivation({
      valid: true,
      enabledRealModes: ["claude_code.sdk", "opencode.acp"],
      reasons: [],
      reasonCodes: []
    });
    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          hostedRuntimeAllowlist: ["fake.deterministic", "claude_code.sdk", "opencode.acp"],
          hostedRealRuntimeExecution: "enabled",
          providerRuntimeActivation: activation
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          providerRuntimeActivation: activation
        }),
      checkHostedRuntimeGate: async () => ({
        ok: true,
        diagnostics: {
          bridgeReadiness: {
            checks: [
              { name: "command_store", ok: false, reasonCode: "hosted_runtime_bridge_store_unavailable" },
              { name: "command_outbox", ok: false, reasonCode: "hosted_runtime_bridge_queue_unavailable" },
              { name: "adapter_capability", ok: false, reasonCode: "hosted_runtime_bridge_operation_unsupported" },
              { name: "session_reconciliation", ok: false, reasonCode: "hosted_runtime_bridge_worker_unavailable" },
              { name: "approval_sender", ok: false, reasonCode: "hosted_runtime_bridge_worker_unavailable" }
            ]
          }
        }
      })
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "hostedRuntimeBridge",
      status: "fail",
      code: "hosted_runtime_bridge_store_unavailable",
      diagnostics: expect.objectContaining({
        bridgeModes: ["claude_code.sdk", "opencode.acp"],
        failedChecks: expect.arrayContaining(["command_store", "command_outbox", "adapter_capability", "session_reconciliation", "approval_sender"]),
        checks: expect.objectContaining({
          route_auth: "pass",
          command_store: "fail",
          command_outbox: "fail",
          adapter_capability: "fail",
          approval_sender: "fail"
        })
      })
    }));
  });

  test("passes hosted runtime bridge check when bridge dependencies are ready", async () => {
    const activation = makeProviderActivation({
      valid: true,
      enabledRealModes: ["claude_code.sdk", "opencode.acp"],
      reasons: [],
      reasonCodes: []
    });
    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          hostedRuntimeAllowlist: ["fake.deterministic", "claude_code.sdk", "opencode.acp"],
          hostedRealRuntimeExecution: "enabled",
          providerRuntimeActivation: activation
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          providerRuntimeActivation: activation
        }),
      checkHostedRuntimeGate: async () => ({
        ok: true,
        diagnostics: {
          bridgeReadiness: {
            checks: [
              { name: "command_store", ok: true },
              { name: "command_outbox", ok: true },
              { name: "worker_claim", ok: true },
              { name: "adapter_capability", ok: true },
              { name: "session_reconciliation", ok: true },
              { name: "approval_sender", ok: true }
            ]
          }
        }
      })
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "hostedRuntimeBridge",
        status: "pass",
        code: "hosted_runtime_bridge_ready"
      })
    );
  });

  test("fails with provider_runtime_policy_missing and skips adapter checks when real mode activation is invalid", async () => {
    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
          hostedRealRuntimeExecution: "enabled",
          providerRuntimeActivation: makeProviderActivation({
            valid: false,
            enabledRealModes: [],
            reasons: [{ code: "provider_runtime_policy_missing", runtimeMode: "codex.exec_json" }],
            reasonCodes: ["provider_runtime_policy_missing"]
          })
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          providerRuntimeActivation: makeProviderActivation({
            valid: false,
            enabledRealModes: [],
            reasons: [{ code: "provider_runtime_policy_missing", runtimeMode: "codex.exec_json" }],
            reasonCodes: ["provider_runtime_policy_missing"]
          })
        }),
      checkHostedRuntimeGate: async () => ({ ok: true })
    });

    expect(result.ok).toBe(false);
    const providerPolicy = result.checks.find((entry) => entry.name === "providerRuntimePolicy");
    expect(providerPolicy).toMatchObject({
      name: "providerRuntimePolicy",
      status: "fail",
      code: "provider_runtime_policy_missing"
    });
    expect(result.checks).toContainEqual({
      name: "providerAdapterChecks",
      status: "skip",
      code: "skipped_provider_policy_invalid"
    });
  });

  test("fails providerAdapterChecks when adapter availability check fails for real mode", async () => {
    const activation = makeProviderActivation({
      valid: true,
      enabledRealModes: ["codex.exec_json"],
      reasons: [],
      reasonCodes: []
    });

    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
          hostedRealRuntimeExecution: "enabled",
          providerRuntimeActivation: activation
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          providerRuntimeActivation: activation
        }),
      checkHostedRuntimeGate: async () => ({ ok: true }),
      checkProviderAdapters: async () => ({
        ok: false,
        modes: {
          "codex.exec_json": { ok: false, code: "provider_binary_unavailable" },
          "claude_code.sdk": { ok: true },
          "opencode.acp": { ok: true }
        }
      })
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual({
      name: "providerAdapterChecks",
      status: "fail",
      code: "provider_binary_unavailable",
      diagnostics: {
        modes: {
          "codex.exec_json": { ok: false, code: "provider_binary_unavailable" },
          "claude_code.sdk": { ok: true },
          "opencode.acp": { ok: true }
        }
      }
    });
  });

  test("redacts provider diagnostics for path and secret-like values", async () => {
    const activation = makeProviderActivation({
      valid: false,
      enabledRealModes: [],
      reasons: [{ code: "provider_runtime_policy_malformed", runtimeMode: "codex.exec_json" }],
      source: "path",
      reasonCodes: ["provider_runtime_policy_malformed"]
    });

    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
          hostedRealRuntimeExecution: "enabled",
          providerRuntimeActivation: activation
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          providerRuntimeActivation: activation
        }),
      checkHostedRuntimeGate: async () => ({
        ok: false,
        code: "hosted_runtime_gate_failed",
        diagnostics: {
          sourcePath: "/run/secrets/provider-policy.json",
          token: "replace-with-secret-token"
        }
      })
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/run/secrets/provider-policy.json");
    expect(serialized).not.toContain("replace-with-secret-token");
  });

  test("reports unreadable provider policy path with named code and skips adapter checks", async () => {
    const activation = makeProviderActivation({
      valid: false,
      enabledRealModes: [],
      reasons: [{ code: "provider_runtime_policy_missing", runtimeMode: "codex.exec_json" }],
      source: "path",
      reasonCodes: ["provider_runtime_policy_missing"]
    });
    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
          hostedRealRuntimeExecution: "enabled",
          providerRuntimeActivation: activation
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          providerRuntimeActivation: activation
        }),
      checkHostedRuntimeGate: async () => ({ ok: true })
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual({
      name: "providerRuntimePolicy",
      status: "fail",
      code: "provider_runtime_policy_missing",
      diagnostics: {
        source: "path",
        reasonCodes: ["provider_runtime_policy_missing"],
        modeStatuses: [
          {
            runtimeMode: "codex.exec_json",
            ready: false,
            reasons: ["provider_runtime_policy_missing"]
          }
        ]
      }
    });
    expect(result.checks).toContainEqual({
      name: "providerAdapterChecks",
      status: "skip",
      code: "skipped_provider_policy_invalid"
    });
  });

  test("reports invalid UTF-8 provider policy path with named code and skips adapter checks", async () => {
    const activation = makeProviderActivation({
      valid: false,
      enabledRealModes: [],
      reasons: [{ code: "provider_runtime_policy_malformed", runtimeMode: "codex.exec_json" }],
      source: "path",
      reasonCodes: ["provider_runtime_policy_malformed"]
    });
    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
          hostedRealRuntimeExecution: "enabled",
          providerRuntimeActivation: activation
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          providerRuntimeActivation: activation
        }),
      checkHostedRuntimeGate: async () => ({ ok: true })
    });

    expect(result.ok).toBe(false);
    const providerPolicy = result.checks.find((entry) => entry.name === "providerRuntimePolicy");
    expect(providerPolicy).toMatchObject({
      status: "fail",
      code: "provider_runtime_policy_malformed",
      diagnostics: {
        source: "path"
      }
    });
    expect(result.checks).toContainEqual({
      name: "providerAdapterChecks",
      status: "skip",
      code: "skipped_provider_policy_invalid"
    });
  });

  test("reports invalid spend controls with named code and skips adapter checks", async () => {
    const activation = makeProviderActivation({
      valid: false,
      enabledRealModes: [],
      reasons: [{ code: "provider_spend_controls_invalid", runtimeMode: "codex.exec_json" }],
      source: "json",
      reasonCodes: ["provider_spend_controls_invalid"]
    });
    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
          hostedRealRuntimeExecution: "enabled",
          providerRuntimeActivation: activation
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          providerRuntimeActivation: activation
        }),
      checkHostedRuntimeGate: async () => ({ ok: true })
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual({
      name: "providerRuntimePolicy",
      status: "fail",
      code: "provider_spend_controls_invalid",
      diagnostics: {
        source: "json",
        reasonCodes: ["provider_spend_controls_invalid"],
        modeStatuses: [
          {
            runtimeMode: "codex.exec_json",
            ready: false,
            reasons: ["provider_spend_controls_invalid"]
          }
        ]
      }
    });
    expect(result.checks).toContainEqual({
      name: "providerAdapterChecks",
      status: "skip",
      code: "skipped_provider_policy_invalid"
    });
  });

  test("returns input blockers and skips config/dependency checks", async () => {
    const loadServerConfig = vi.fn();
    const result = await runProductionPreflight({
      envFile: "/definitely/missing.env",
      manifestPath: "/definitely/missing-manifest.json",
      deps: {
        loadServerConfig
      }
    });

    expect(result.ok).toBe(false);
    const failedCodes = result.checks.filter((entry) => entry.status === "fail").map((entry) => entry.code);
    expect(failedCodes).toContain("env_file_missing");
    expect(failedCodes).toContain("manifest_missing");
    expect(result.checks.some((entry) => entry.status === "skip" && entry.code === "skipped_input_invalid")).toBe(true);
    expect(loadServerConfig).not.toHaveBeenCalled();
  });

  test("aggregates config failures and skips dependency checks", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "ok.env");
      await writeFile(envPath, "SWITCHYARD_DEPLOYMENT_MODE=production\n", "utf8");

      const result = await runProductionPreflight({
        envFile: envPath,
        includeNode: true,
        deps: {
          validateManifest: async () => ({ ok: true, manifest: {} as never }),
          loadServerConfig: () => {
            throw {
              code: "config_required:SWITCHYARD_API_KEY_PEPPER",
              redactedConfig: { hasApiKeyPepper: false }
            };
          },
          loadWorkerConfig: () => {
            throw {
              code: "config_required:SWITCHYARD_REDIS_URL",
              redactedConfig: { hasRedisUrl: false }
            };
          },
          loadNodeConfig: () => {
            throw {
              code: "config_required:SWITCHYARD_NODE_SHARED_TOKEN",
              redactedConfig: { hasSharedToken: false }
            };
          }
        }
      });

      const failedCodes = result.checks.filter((entry) => entry.status === "fail").map((entry) => entry.code);
      expect(failedCodes).toEqual(expect.arrayContaining([
        "config_required:SWITCHYARD_API_KEY_PEPPER",
        "config_required:SWITCHYARD_REDIS_URL",
        "config_required:SWITCHYARD_NODE_SHARED_TOKEN"
      ]));
      expect(result.checks.some((entry) => entry.status === "skip" && entry.code === "skipped_config_invalid")).toBe(true);
    });
  });

  test("emits sandboxGate failure when worker sandbox policy config is invalid", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "ok.env");
      await writeFile(envPath, "SWITCHYARD_DEPLOYMENT_MODE=production\n", "utf8");

      const result = await runProductionPreflight({
        envFile: envPath,
        deps: {
          validateManifest: async () => ({ ok: true, manifest: {} as never }),
          loadServerConfig: () => makeServerConfig(),
          loadWorkerConfig: () => {
            throw {
              code: "sandbox_policy_missing",
              redactedConfig: {
                sandbox: {
                  mode: "enabled"
                }
              }
            };
          }
        }
      });

      expect(result.ok).toBe(false);
      expect(result.checks).toContainEqual({
        name: "sandboxGate",
        status: "fail",
        code: "sandbox_policy_missing",
        diagnostics: {
          sandbox: {
            mode: "enabled"
          }
        }
      });
      expect(result.checks.some((entry) => entry.status === "skip" && entry.code === "skipped_sandbox_gate_failed")).toBe(true);
    });
  });

  test("aggregates dependency failures when config and manifest checks pass", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "ok.env");
      await writeFile(envPath, "SWITCHYARD_DEPLOYMENT_MODE=production\n", "utf8");

      const result = await runProductionPreflight({
        envFile: envPath,
        deps: {
          validateManifest: async () => ({ ok: true, manifest: {} as never }),
          loadServerConfig: () => ({
            deploymentMode: "production",
            postgresUrl: "postgres://user:pw@db.example:5432/switchyard",
            redisUrl: "redis://:pw@redis.example:6379/0",
            queueName: "switchyard-hosted-runs",
            hostedRuntimeAllowlist: ["fake.deterministic"],
            hostedRealRuntimeExecution: "disabled",
            nodeSharedToken: "x".repeat(32),
            controlPlaneBootstrap: {
              active: {
                accounts: 1,
                tenants: 1,
                projects: 1,
                users: 1,
                apiKeys: 1,
                billingPlans: 1
              },
              nodeTokenBindings: [{ token: "x".repeat(32), apiKeyId: "api_key_1" }]
            }
          }),
          loadWorkerConfig: () => ({
            deploymentMode: "production",
            redisUrl: "redis://:pw@redis.example:6379/0",
            queueName: "switchyard-hosted-runs",
            objectStore: { backend: "memory", probe: "write_read_delete", redactedSummary: { backend: "memory" } },
            sandbox: resolveHostedSandboxConfig({ deploymentMode: "production", env: {} })
          }),
          openPostgresDatabase: () => ({ close: async () => undefined } as never),
          checkPostgresSchemaCompatibility: async () => ({ ok: false, code: "postgres_schema_version_unsupported", version: 999 }),
          queueStats: async () => {
            throw new Error("queue down");
          },
          probeObjectStore: async () => {
            throw new Error("object_store_unavailable");
          },
          checkControlPlane: async () => ({
            checks: [
              { name: "quotaStore", ok: false, code: "quota_store_unavailable" },
              { name: "auditStore", ok: false, code: "audit_store_unavailable" },
              { name: "unownedResources", ok: false, code: "unowned_resources_present", diagnostics: { runs: 1 } }
            ]
          }),
          checkHostedRuntimeGate: async () => ({ ok: false, code: "hosted_runtime_gate_failed", diagnostics: { sourceCode: "hosted_real_runtime_disabled" } })
        }
      });

      expect(result.ok).toBe(false);
      const failedCodes = result.checks.filter((entry) => entry.status === "fail").map((entry) => entry.code);
      expect(failedCodes).toEqual(expect.arrayContaining([
        "postgres_schema_version_unsupported",
        "queue_unavailable",
        "object_store_unavailable",
        "quota_store_unavailable",
        "audit_store_unavailable",
        "unowned_resources_present",
        "hosted_runtime_gate_failed"
      ]));
      const sandboxGate = result.checks.find((entry) => entry.name === "sandboxGate");
      expect(sandboxGate).toMatchObject({ name: "sandboxGate", status: "pass", code: "sandbox_gate_disabled" });
    });
  });

  test("adds sandboxGate pass for safe disabled posture before dependency checks", async () => {
    const result = await runDependencyPreflight({});
    const sandboxGate = result.checks.find((entry) => entry.name === "sandboxGate");
    expect(sandboxGate).toMatchObject({ name: "sandboxGate", status: "pass", code: "sandbox_gate_disabled" });
  });

  test("fails sandboxGate with sandbox_policy_missing before dependencies when real execution is enabled without policy", async () => {
    const result = await runDependencyPreflight({
      loadWorkerConfig: () => makeWorkerConfig({
        sandbox: resolveHostedSandboxConfig({
          deploymentMode: "production",
          env: {
            SWITCHYARD_SANDBOX_REAL_EXECUTION: "enabled"
          }
        })
      })
    });

    expect(result.ok).toBe(false);
    const sandboxGate = result.checks.find((entry) => entry.name === "sandboxGate");
    expect(sandboxGate).toMatchObject({
      name: "sandboxGate",
      status: "fail",
      code: "sandbox_policy_missing"
    });
    expect(result.checks.some((entry) => entry.status === "skip" && entry.code === "skipped_sandbox_gate_failed")).toBe(true);
  });

  test("fails sandboxGate with sandbox_policy_invalid before dependencies when real execution policy is malformed", async () => {
    const result = await runDependencyPreflight({
      loadWorkerConfig: () => makeWorkerConfig({
        sandbox: resolveHostedSandboxConfig({
          deploymentMode: "production",
          env: {
            SWITCHYARD_SANDBOX_REAL_EXECUTION: "enabled",
            SWITCHYARD_SANDBOX_COMMAND_POLICY_JSON: "{\"oops\":true}"
          }
        })
      })
    });

    expect(result.ok).toBe(false);
    const sandboxGate = result.checks.find((entry) => entry.name === "sandboxGate");
    expect(sandboxGate).toMatchObject({
      name: "sandboxGate",
      status: "fail",
      code: "sandbox_policy_invalid"
    });
    expect(result.checks.some((entry) => entry.status === "skip" && entry.code === "skipped_sandbox_gate_failed")).toBe(true);
  });

  test("surfaces schema migration required and malformed codes", async () => {
    const migrationRequired = await runDependencyPreflight({
      checkPostgresSchemaCompatibility: async () => ({ ok: false, code: "postgres_schema_migration_required", version: 18 })
    });
    const malformed = await runDependencyPreflight({
      checkPostgresSchemaCompatibility: async () => ({ ok: false, code: "postgres_schema_malformed" })
    });

    expect(failedCodes(migrationRequired)).toContain("postgres_schema_migration_required");
    expect(failedCodes(malformed)).toContain("postgres_schema_malformed");
  });

  test("surfaces postgres unavailable when schema check rejects", async () => {
    const result = await runDependencyPreflight({
      checkPostgresSchemaCompatibility: async () => {
        throw new Error("database unavailable");
      }
    });

    expect(failedCodes(result)).toContain("postgres_unavailable");
  });

  test("surfaces each missing control-plane bootstrap entity code", async () => {
    const result = await runDependencyPreflight({
      checkControlPlane: async () => ({
        checks: [
          { name: "bootstrapAccount", ok: false, code: "control_plane_bootstrap_account_missing" },
          { name: "bootstrapTenant", ok: false, code: "control_plane_bootstrap_tenant_missing" },
          { name: "bootstrapProject", ok: false, code: "control_plane_bootstrap_project_missing" },
          { name: "bootstrapUser", ok: false, code: "control_plane_bootstrap_user_missing" },
          { name: "bootstrapApiKey", ok: false, code: "control_plane_bootstrap_api_key_missing" },
          { name: "bootstrapBillingPlan", ok: false, code: "control_plane_bootstrap_billing_plan_missing" },
          { name: "nodeTokenBinding", ok: false, code: "control_plane_node_token_unbound" }
        ]
      })
    });

    expect(failedCodes(result)).toEqual(expect.arrayContaining([
      "control_plane_bootstrap_account_missing",
      "control_plane_bootstrap_tenant_missing",
      "control_plane_bootstrap_project_missing",
      "control_plane_bootstrap_user_missing",
      "control_plane_bootstrap_api_key_missing",
      "control_plane_bootstrap_billing_plan_missing",
      "control_plane_node_token_unbound"
    ]));
  });

  test("surfaces missing control-plane bootstrap itself", async () => {
    const result = await runDependencyPreflight({
      checkControlPlane: async () => ({
        checks: [
          { name: "bootstrap", ok: false, code: "control_plane_bootstrap_missing" }
        ]
      })
    });

    expect(failedCodes(result)).toContain("control_plane_bootstrap_missing");
  });

  test("redacts diagnostics in output", async () => {
    await withTempDir(async (dir) => {
      const envPath = join(dir, "ok.env");
      await writeFile(envPath, "SWITCHYARD_DEPLOYMENT_MODE=production\n", "utf8");

      const result = await runProductionPreflight({
        envFile: envPath,
        deps: {
          validateManifest: async () => ({ ok: true, manifest: {} as never }),
          loadServerConfig: () => ({
            deploymentMode: "production",
            postgresUrl: "postgres://user:replace-with-password@db.example:5432/switchyard",
            redisUrl: "redis://:replace-with-password@redis.example:6379/0",
            queueName: "switchyard-hosted-runs",
            hostedRuntimeAllowlist: ["fake.deterministic"],
            hostedRealRuntimeExecution: "disabled",
            nodeSharedToken: "x".repeat(32),
            controlPlaneBootstrap: {
              active: {
                accounts: 1,
                tenants: 1,
                projects: 1,
                users: 1,
                apiKeys: 1,
                billingPlans: 1
              },
              nodeTokenBindings: [{ token: "x".repeat(32), apiKeyId: "api_key_1" }]
            }
          }),
          loadWorkerConfig: () => ({
            deploymentMode: "production",
            redisUrl: "redis://:replace-with-password@redis.example:6379/0",
            queueName: "switchyard-hosted-runs",
            objectStore: { backend: "memory", probe: "write_read_delete", redactedSummary: { backend: "memory" } },
            sandbox: resolveHostedSandboxConfig({ deploymentMode: "production", env: {} })
          }),
          openPostgresDatabase: () => ({ close: async () => undefined } as never),
          checkPostgresSchemaCompatibility: async () => ({ ok: false, code: "postgres_unavailable", diagnostics: { raw: "replace-with-password" } }),
          queueStats: async () => undefined,
          probeObjectStore: async () => undefined,
          checkControlPlane: async () => ({ checks: [] }),
          checkHostedRuntimeGate: async () => ({ ok: true })
        }
      });

      const serialized = JSON.stringify(result);
      expect(serialized.includes("replace-with-password")).toBe(false);
      expect(serialized.includes("postgres://user")).toBe(false);
    });
  });

  test("fails tools check when tools are enabled without explicit policy source", async () => {
    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          serverAuthMode: "api_key",
          tools: {
            hostedRealTools: "enabled",
            connectedNodeRealTools: "disabled",
            policySourceKind: "none",
            policy: makeToolPolicy()
          }
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          tools: {
            hostedRealTools: "enabled",
            connectedNodeRealTools: "disabled",
            adapterMode: "fake",
            policySourceKind: "none",
            policy: makeToolPolicy()
          }
        })
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "tools",
      status: "fail",
      code: "tool_policy_config_invalid"
    }));
  });

  test("fails tools check when hosted tools are enabled without api-key auth", async () => {
    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          serverAuthMode: "disabled",
          tools: {
            hostedRealTools: "enabled",
            connectedNodeRealTools: "disabled",
            policySourceKind: "json",
            policy: makeToolPolicy()
          }
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          tools: {
            hostedRealTools: "enabled",
            connectedNodeRealTools: "disabled",
            adapterMode: "fake",
            policySourceKind: "json",
            policy: makeToolPolicy()
          }
        })
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "tools",
      status: "fail",
      code: "tool_hosted_auth_required"
    }));
  });

  test("fails tools check when enabled tools are configured with real adapter mode", async () => {
    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          serverAuthMode: "api_key",
          tools: {
            hostedRealTools: "enabled",
            connectedNodeRealTools: "disabled",
            policySourceKind: "json",
            policy: makeToolPolicy()
          }
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          tools: {
            hostedRealTools: "enabled",
            connectedNodeRealTools: "disabled",
            adapterMode: "real",
            policySourceKind: "json",
            policy: makeToolPolicy()
          }
        })
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "tools",
      status: "fail",
      code: "tool_policy_config_invalid"
    }));
  });

  test("fails hosted policy when repo or browser are enabled, and fails connected-node when node checks are absent", async () => {
    const result = await runDependencyPreflight({
      loadServerConfig: () =>
        makeServerConfig({
          serverAuthMode: "api_key",
          tools: {
            hostedRealTools: "enabled",
            connectedNodeRealTools: "enabled",
            policySourceKind: "json",
            policy: makeToolPolicy({
              hosted: { enabled: true, allowedToolTypes: ["fetch", "repo", "browser"] }
            })
          }
        }),
      loadWorkerConfig: () =>
        makeWorkerConfig({
          tools: {
            hostedRealTools: "enabled",
            connectedNodeRealTools: "enabled",
            adapterMode: "fake",
            policySourceKind: "json",
            policy: makeToolPolicy({
              hosted: { enabled: true, allowedToolTypes: ["fetch", "repo", "browser"] }
            })
          }
        })
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "tools",
      status: "fail",
      code: "repo_hosted_unshipped"
    }));
  });

  test("fails connected-node tools when includeNode is required but node config is unavailable", async () => {
    const result = await withTempResult(async (dir) => {
      const envPath = join(dir, "ok.env");
      await writeFile(envPath, "SWITCHYARD_DEPLOYMENT_MODE=production\n", "utf8");
      return runProductionPreflight({
        envFile: envPath,
        includeNode: false,
        deps: {
          validateManifest: async () => ({ ok: true, manifest: {} as never }),
          loadServerConfig: () =>
            makeServerConfig({
              serverAuthMode: "api_key",
              tools: {
                hostedRealTools: "disabled",
                connectedNodeRealTools: "enabled",
                policySourceKind: "json",
                policy: makeToolPolicy()
              }
            }),
          loadWorkerConfig: () =>
            makeWorkerConfig({
              tools: {
                hostedRealTools: "disabled",
                connectedNodeRealTools: "enabled",
                adapterMode: "fake",
                policySourceKind: "json",
                policy: makeToolPolicy()
              }
            }),
          openPostgresDatabase: () => ({ close: async () => undefined } as never),
          checkPostgresSchemaCompatibility: async () => ({ ok: true, code: "postgres_schema_ready", version: 19 }),
          queueStats: async () => undefined,
          probeObjectStore: async () => undefined,
          checkControlPlane: async () => ({
            checks: [
              { name: "bootstrap", ok: true, code: "control_plane_bootstrap_ready" },
              { name: "quotaStore", ok: true, code: "quota_store_ready" },
              { name: "auditStore", ok: true, code: "audit_store_ready" },
              { name: "unownedResources", ok: true, code: "unowned_resources_absent" }
            ]
          }),
          checkHostedRuntimeGate: async () => ({ ok: true })
        }
      });
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "tools",
      status: "fail",
      code: "tool_node_unavailable"
    }));
  });
});
