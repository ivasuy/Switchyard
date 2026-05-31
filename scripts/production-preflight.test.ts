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
