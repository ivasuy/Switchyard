import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ConfigError, loadWorkerConfig } from "../src/config.js";

function createProductionEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SWITCHYARD_DEPLOYMENT_MODE: "production",
    SWITCHYARD_POSTGRES_URL: "postgres://switchyard:worker-strong-credential@postgres.example.com:5432/switchyard",
    SWITCHYARD_REDIS_URL: "redis://default:worker-strong-credential@redis.example.com:6379/0",
    SWITCHYARD_OBJECT_STORE_BACKEND: "local",
    SWITCHYARD_OBJECT_STORE_DIR: "/var/switchyard/objects",
    SWITCHYARD_OBJECT_STORE_PROBE: "write_read_delete",
    SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
    SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "disabled",
    SWITCHYARD_WORKER_IDLE_MS: "200",
    ...overrides
  };
}

function expectConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected ConfigError");
}

function validCodexPolicy(overrides: {
  executablePath?: string;
  enabled?: boolean;
  spendControls?: {
    maxActiveRuns: number;
    maxRunsPerHour: number;
    maxRunTimeoutSeconds: number;
    maxPromptBytes: number;
  };
} = {}): string {
  return JSON.stringify({
    version: 1,
    modes: {
      "codex.exec_json": {
        enabled: overrides.enabled ?? true,
        executablePath: overrides.executablePath ?? "/bin/echo",
        cwdPrefixes: ["/srv/switchyard/work"],
        envAllowlist: ["OPENAI_API_KEY", "PATH"],
        requiredEnv: ["OPENAI_API_KEY"],
        fixedArgs: ["exec", "--json"],
        allowUserArgs: false,
        sandbox: "read_only",
        spendControls: overrides.spendControls ?? {
          maxActiveRuns: 2,
          maxRunsPerHour: 20,
          maxRunTimeoutSeconds: 120,
          maxPromptBytes: 1024
        }
      }
    }
  });
}

function validWrapperPolicy(): string {
  return JSON.stringify({
    version: 1,
    modes: {
      "generic_http.async_rest": {
        enabled: true,
        baseUrlEnv: "SWITCHYARD_GENERIC_HTTP_BASE_URL",
        auth: { type: "api_key", env: "SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN" },
        spendControls: {
          maxActiveRuns: 2,
          maxRunsPerHour: 20,
          maxRunTimeoutSeconds: 120,
          maxPromptBytes: 1024
        }
      },
      "agentfield.async_rest": {
        enabled: true,
        baseUrlEnv: "SWITCHYARD_AGENTFIELD_BASE_URL",
        auth: { type: "api_key", env: "SWITCHYARD_AGENTFIELD_API_KEY" },
        targetEnv: "SWITCHYARD_AGENTFIELD_TARGET",
        spendControls: {
          maxActiveRuns: 2,
          maxRunsPerHour: 20,
          maxRunTimeoutSeconds: 120,
          maxPromptBytes: 1024
        }
      }
    }
  });
}

describe("production worker config", () => {
  it("parses valid production env and keeps redacted summary", () => {
    const config = loadWorkerConfig(createProductionEnv());
    expect(config.deploymentMode).toBe("production");
    expect(config.hostedRuntimeAllowlist).toEqual(["fake.deterministic"]);
    expect(config.hostedRealRuntimeExecution).toBe("disabled");

    const serializedSummary = JSON.stringify(config.redactedSummary);
    expect(serializedSummary).not.toContain("worker-strong-credential");
  });

  it("fails when required production dependencies are missing", () => {
    const env = createProductionEnv();
    delete env.SWITCHYARD_REDIS_URL;

    expect(() => loadWorkerConfig(env)).toThrow("config_required:SWITCHYARD_REDIS_URL");
  });

  it("rejects placeholder postgres and redis URL passwords and redacts them", () => {
    const postgresError = expectConfigError(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_POSTGRES_URL: "postgres://switchyard:replace-with-worker-postgres-password@postgres.example.com:5432/switchyard"
        })
      )
    );
    expect(postgresError.code).toBe("secret_placeholder:SWITCHYARD_POSTGRES_URL");
    expect(JSON.stringify(postgresError.redactedConfig)).not.toContain("replace-with-worker-postgres-password");

    const redisError = expectConfigError(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_REDIS_URL: "redis://default:replace-with-worker-redis-password@redis.example.com:6379/0"
        })
      )
    );
    expect(redisError.code).toBe("secret_placeholder:SWITCHYARD_REDIS_URL");
    expect(JSON.stringify(redisError.redactedConfig)).not.toContain("replace-with-worker-redis-password");
  });

  it("rejects low-signal substrings in URL passwords and redacts them", () => {
    const postgresError = expectConfigError(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_POSTGRES_URL: "postgres://switchyard:my-secret-value-12345678901234567890@postgres.example.com:5432/switchyard"
        })
      )
    );
    expect(postgresError.code).toBe("secret_placeholder:SWITCHYARD_POSTGRES_URL");
    expect(JSON.stringify(postgresError.redactedConfig)).not.toContain("my-secret-value");

    const redisError = expectConfigError(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_REDIS_URL: "redis://default:example-key-12345678901234567890@redis.example.com:6379/0"
        })
      )
    );
    expect(redisError.code).toBe("secret_placeholder:SWITCHYARD_REDIS_URL");
    expect(JSON.stringify(redisError.redactedConfig)).not.toContain("example-key");
  });

  it("rejects placeholder object-store credentials and redacts them", () => {
    const error = expectConfigError(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_OBJECT_STORE_BACKEND: "s3-compatible",
          SWITCHYARD_OBJECT_STORE_ENDPOINT: "https://objects.example.com",
          SWITCHYARD_OBJECT_STORE_REGION: "auto",
          SWITCHYARD_OBJECT_STORE_BUCKET: "switchyard-artifacts",
          SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID: "replace-with-worker-access-key",
          SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY: "replace-with-worker-secret-key"
        })
      )
    );

    expect(error.code).toMatch(/secret_placeholder:SWITCHYARD_OBJECT_STORE_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
    const serialized = JSON.stringify(error.redactedConfig);
    expect(serialized).not.toContain("replace-with-worker-access-key");
    expect(serialized).not.toContain("replace-with-worker-secret-key");
  });

  it("rejects disabled object-store probe in production", () => {
    expect(() => loadWorkerConfig(createProductionEnv({ SWITCHYARD_OBJECT_STORE_PROBE: "disabled" }))).toThrow(
      "config_invalid:SWITCHYARD_OBJECT_STORE_PROBE"
    );
  });

  it("rejects invalid worker settings", () => {
    expect(() => loadWorkerConfig(createProductionEnv({ SWITCHYARD_WORKER_IDLE_MS: "0" }))).toThrow(
      "config_invalid:SWITCHYARD_WORKER_IDLE_MS"
    );
  });

  it("accepts production real mode only when provider activation is valid", () => {
    const config = loadWorkerConfig(
      createProductionEnv({
        SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
        SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
        SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: validCodexPolicy(),
        OPENAI_API_KEY: "present-openai-key"
      })
    );
    expect(config.providerRuntimeActivation.valid).toBe(true);
    expect(config.providerRuntimeActivation.enabledRealModes).toEqual(["codex.exec_json"]);
  });

  it("fails production real mode startup when policy is missing or malformed", () => {
    expect(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
          SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled"
        })
      )
    ).toThrow("provider_runtime_policy_missing");

    expect(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
          SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
          SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: "{"
        })
      )
    ).toThrow("provider_runtime_policy_malformed");
  });

  it("fails production real mode for disabled policy, missing credentials, invalid spend controls, and missing binary", () => {
    const error = expectConfigError(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
          SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
          SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: validCodexPolicy({ enabled: false }),
          OPENAI_API_KEY: "present-openai-key"
        })
      )
    );
    expect(error.code).toBe("provider_runtime_policy_disabled");

    const missingCredentials = expectConfigError(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
          SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
          SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: validCodexPolicy()
        })
      )
    );
    expect(missingCredentials.code).toBe("provider_credentials_missing");

    const invalidSpend = expectConfigError(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
          SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
          SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: validCodexPolicy({
            spendControls: {
              maxActiveRuns: 2,
              maxRunsPerHour: 20,
              maxRunTimeoutSeconds: 120,
              maxPromptBytes: 0
            }
          }),
          OPENAI_API_KEY: "present-openai-key"
        })
      )
    );
    expect(invalidSpend.code).toBe("provider_spend_controls_invalid");

    const missingBinary = expectConfigError(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
          SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
          SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: validCodexPolicy({ executablePath: "/definitely/missing/codex-bin" }),
          OPENAI_API_KEY: "present-openai-key"
        })
      )
    );
    expect(missingBinary.code).toBe("provider_binary_unavailable");
  });

  it("keeps local defaults backwards-compatible", () => {
    const config = loadWorkerConfig({});
    expect(config.deploymentMode).toBe("local");
    expect(config.postgresUrl).toBeUndefined();
    expect(config.redisUrl).toBeUndefined();
    expect(config.hostedRuntimeAllowlist).toEqual(["fake.deterministic"]);
    expect(config.hostedRealRuntimeExecution).toBe("disabled");
  });

  it("loads wrapper env values, validates numeric bounds, and redacts secrets", () => {
    const config = loadWorkerConfig({
      SWITCHYARD_GENERIC_HTTP_BASE_URL: "https://generic-user:generic-pass@generic.example.com/wrapper",
      SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN: "generic-token-secret",
      SWITCHYARD_GENERIC_HTTP_REQUEST_TIMEOUT_MS: "1111",
      SWITCHYARD_GENERIC_HTTP_POLL_INTERVAL_MS: "222",
      SWITCHYARD_GENERIC_HTTP_MAX_RESPONSE_BYTES: "3333",
      SWITCHYARD_AGENTFIELD_BASE_URL: "https://agent-user:agent-pass@agentfield.example.com/api",
      SWITCHYARD_AGENTFIELD_API_KEY: "agentfield-api-key-secret",
      SWITCHYARD_AGENTFIELD_TARGET: "api-key-like-target",
      SWITCHYARD_AGENTFIELD_REQUEST_TIMEOUT_MS: "4444",
      SWITCHYARD_AGENTFIELD_POLL_INTERVAL_MS: "555",
      SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES: "6666"
    });

    expect(config.genericHttp).toMatchObject({
      baseUrl: "https://generic-user:generic-pass@generic.example.com/wrapper",
      authToken: "generic-token-secret",
      requestTimeoutMs: 1111,
      pollIntervalMs: 222,
      maxResponseBytes: 3333
    });
    expect(config.agentfield).toMatchObject({
      baseUrl: "https://agent-user:agent-pass@agentfield.example.com/api",
      apiKey: "agentfield-api-key-secret",
      target: "api-key-like-target",
      requestTimeoutMs: 4444,
      pollIntervalMs: 555,
      maxResponseBytes: 6666
    });

    const summary = JSON.stringify(config.redactedSummary);
    expect(summary).not.toContain("generic-user");
    expect(summary).not.toContain("generic-pass");
    expect(summary).not.toContain("generic-token-secret");
    expect(summary).not.toContain("agent-user");
    expect(summary).not.toContain("agent-pass");
    expect(summary).not.toContain("agentfield-api-key-secret");
    expect(summary).not.toContain("api-key-like-target");

    expect(() => loadWorkerConfig({ SWITCHYARD_GENERIC_HTTP_REQUEST_TIMEOUT_MS: "0" })).toThrow(
      "config_invalid:SWITCHYARD_GENERIC_HTTP_REQUEST_TIMEOUT_MS"
    );
    expect(() => loadWorkerConfig({ SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES: "-1" })).toThrow(
      "config_invalid:SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES"
    );
  });

  it("accepts production wrapper modes only when policy env references are valid", () => {
    const config = loadWorkerConfig(
      createProductionEnv({
        SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,generic_http.async_rest,agentfield.async_rest",
        SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
        SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: validWrapperPolicy(),
        SWITCHYARD_GENERIC_HTTP_BASE_URL: "https://generic.example.com",
        SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN: "generic-token",
        SWITCHYARD_AGENTFIELD_BASE_URL: "https://agentfield.example.com",
        SWITCHYARD_AGENTFIELD_API_KEY: "agentfield-key",
        SWITCHYARD_AGENTFIELD_TARGET: "research-agent.deep_analysis"
      })
    );

    expect(config.providerRuntimeActivation.valid).toBe(true);
    expect(config.providerRuntimeActivation.enabledRealModes).toEqual([
      "generic_http.async_rest",
      "agentfield.async_rest"
    ]);

    expect(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,generic_http.async_rest",
          SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
          SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: validWrapperPolicy(),
          SWITCHYARD_GENERIC_HTTP_BASE_URL: "https://user:pass@generic.example.com",
          SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN: "generic-token"
        })
      )
    ).toThrow("provider_credentials_invalid");
  });

  it("fails closed for provider policy path loading states and json/path conflict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchyard-provider-policy-"));
    const unreadablePath = join(dir, "missing.json");
    const emptyPath = join(dir, "empty.json");
    const oversizedPath = join(dir, "oversized.json");
    const invalidJsonPath = join(dir, "invalid.json");
    const invalidUtf8Path = join(dir, "invalid-utf8.json");

    try {
      await writeFile(emptyPath, "");
      await writeFile(oversizedPath, "x".repeat(70_000));
      await writeFile(invalidJsonPath, "{");
      await writeFile(invalidUtf8Path, Buffer.from([0xff, 0xfe, 0xfd]));

      const unreadable = expectConfigError(() =>
        loadWorkerConfig(
          createProductionEnv({
            SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
            SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
            SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH: unreadablePath,
            OPENAI_API_KEY: "present-openai-key"
          })
        )
      );
      expect(unreadable.code).toBe("provider_runtime_policy_missing");
      assertPathDiagnosticsRedaction(unreadable, unreadablePath, undefined);

      const empty = expectConfigError(() =>
        loadWorkerConfig(
          createProductionEnv({
            SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
            SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
            SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH: emptyPath,
            OPENAI_API_KEY: "present-openai-key"
          })
        )
      );
      expect(empty.code).toBe("provider_runtime_policy_empty");
      assertPathDiagnosticsRedaction(empty, emptyPath, "");

      const oversized = expectConfigError(() =>
        loadWorkerConfig(
          createProductionEnv({
            SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
            SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
            SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH: oversizedPath,
            OPENAI_API_KEY: "present-openai-key"
          })
        )
      );
      expect(oversized.code).toBe("provider_runtime_policy_malformed");
      assertPathDiagnosticsRedaction(oversized, oversizedPath, "x".repeat(256));

      const invalidJson = expectConfigError(() =>
        loadWorkerConfig(
          createProductionEnv({
            SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
            SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
            SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH: invalidJsonPath,
            OPENAI_API_KEY: "present-openai-key"
          })
        )
      );
      expect(invalidJson.code).toBe("provider_runtime_policy_malformed");
      assertPathDiagnosticsRedaction(invalidJson, invalidJsonPath, undefined);

      const invalidUtf8 = expectConfigError(() =>
        loadWorkerConfig(
          createProductionEnv({
            SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
            SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
            SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH: invalidUtf8Path,
            OPENAI_API_KEY: "present-openai-key"
          })
        )
      );
      expect(invalidUtf8.code).toBe("provider_runtime_policy_malformed");
      assertPathDiagnosticsRedaction(invalidUtf8, invalidUtf8Path, undefined);

      const conflict = expectConfigError(() =>
        loadWorkerConfig(
          createProductionEnv({
            SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
            SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
            SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON: validCodexPolicy(),
            SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH: invalidJsonPath,
            OPENAI_API_KEY: "present-openai-key"
          })
        )
      );
      expect(conflict.code).toBe("provider_runtime_policy_malformed");
      const summary = JSON.stringify(conflict.redactedConfig);
      expect((conflict.redactedConfig["providerRuntimePolicy"] as Record<string, unknown>)?.["source"]).toBe("json");
      expect(summary).not.toContain(invalidJsonPath);
      expect(summary).not.toContain("SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON");
      expect(summary).not.toContain(validCodexPolicy());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function assertPathDiagnosticsRedaction(error: ConfigError, pathValue: string, rawContent: string | undefined): void {
  const providerRuntimePolicy = error.redactedConfig["providerRuntimePolicy"] as Record<string, unknown> | undefined;
  expect(providerRuntimePolicy?.["source"]).toBe("path");

  const summary = JSON.stringify(error.redactedConfig);
  expect(summary).not.toContain(pathValue);
  if (rawContent !== undefined && rawContent.length > 0) {
    expect(summary).not.toContain(rawContent);
  }
  expect(summary).not.toContain("SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH");
}
