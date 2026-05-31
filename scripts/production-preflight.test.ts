import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
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
    ...overrides
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
        checkHostedRuntimeGate: async () => ({ ok: true }),
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
          "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"
        ],
        healthChecks: ["GET /health", "GET /ready"],
        policy: {
          runtimeAllowlist: ["fake.deterministic"],
          hostedRealRuntimeExecution: "disabled",
          objectStoreProbe: "write_read_delete"
        }
      },
      worker: {
        deploymentMode: "production",
        command: ["node", "apps/worker/dist/main.js"],
        requiredEnv: [
          "SWITCHYARD_DEPLOYMENT_MODE",
          "SWITCHYARD_OBJECT_STORE_PROBE",
          "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
          "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"
        ],
        readinessGate: {
          command: ["node", "apps/worker/dist/ready.js"]
        },
        policy: {
          runtimeAllowlist: ["fake.deterministic"],
          hostedRealRuntimeExecution: "disabled",
          objectStoreProbe: "write_read_delete"
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
      "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"
    ],
    forbiddenSurfaces: ["dashboard", "tui", "payment", "oauth", "browser", "/sandbox", "/exec", "/pty", "/terminal"],
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
            objectStore: { backend: "memory", probe: "write_read_delete", redactedSummary: { backend: "memory" } }
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
    });
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
            objectStore: { backend: "memory", probe: "write_read_delete", redactedSummary: { backend: "memory" } }
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
});
