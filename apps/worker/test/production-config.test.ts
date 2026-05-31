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

  it("rejects unsafe runtime posture and invalid worker settings", () => {
    expect(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json"
        })
      )
    ).toThrow("hosted_real_runtime_production_forbidden");

    expect(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled"
        })
      )
    ).toThrow("config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION");

    expect(() => loadWorkerConfig(createProductionEnv({ SWITCHYARD_WORKER_IDLE_MS: "0" }))).toThrow(
      "config_invalid:SWITCHYARD_WORKER_IDLE_MS"
    );
  });

  it("surfaces sandbox policy missing when real execution is enabled without policy", () => {
    const error = expectConfigError(() =>
      loadWorkerConfig(
        createProductionEnv({
          SWITCHYARD_SANDBOX_REAL_EXECUTION: "enabled"
        })
      )
    );
    expect(error.code).toBe("sandbox_policy_missing");
  });

  it("keeps local defaults backwards-compatible", () => {
    const config = loadWorkerConfig({});
    expect(config.deploymentMode).toBe("local");
    expect(config.postgresUrl).toBeUndefined();
    expect(config.redisUrl).toBeUndefined();
    expect(config.hostedRuntimeAllowlist).toEqual(["fake.deterministic"]);
    expect(config.hostedRealRuntimeExecution).toBe("disabled");
  });
});
