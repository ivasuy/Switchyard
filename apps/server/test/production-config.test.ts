import { describe, expect, it } from "vitest";
import { ConfigError, loadServerConfig } from "../src/config.js";

function secret32(prefix: string): string {
  return `${prefix}${"x".repeat(Math.max(0, 32 - prefix.length))}`;
}

function createBootstrapJson(nodeToken: string): string {
  return JSON.stringify({
    accounts: [{ id: "account_1", status: "active", billingPlanId: "billing_plan_1" }],
    tenants: [{ id: "tenant_1", accountId: "account_1", status: "active" }],
    projects: [{ id: "project_1", accountId: "account_1", tenantId: "tenant_1", status: "active" }],
    users: [{ id: "user_1", accountId: "account_1", tenantId: "tenant_1", status: "active" }],
    apiKeys: [{
      id: "api_key_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      userId: "user_1",
      keyPrefix: "sk_sw",
      secretHash: "hashed-secret",
      status: "active"
    }],
    billingPlans: [{ id: "billing_plan_1", status: "active" }],
    nodeTokenBindings: [{ token: nodeToken, apiKeyId: "api_key_1" }]
  });
}

function createProductionEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const nodeToken = secret32("node-token-");
  return {
    SWITCHYARD_DEPLOYMENT_MODE: "production",
    SWITCHYARD_POSTGRES_URL: "postgres://switchyard:really-strong-credential@postgres.example.com:5432/switchyard",
    SWITCHYARD_REDIS_URL: "redis://default:really-strong-credential@redis.example.com:6379/0",
    SWITCHYARD_OBJECT_STORE_BACKEND: "local",
    SWITCHYARD_OBJECT_STORE_DIR: "/var/switchyard/objects",
    SWITCHYARD_NODE_SHARED_TOKEN: nodeToken,
    SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
    SWITCHYARD_SERVER_AUTH_MODE: "api_key",
    SWITCHYARD_API_KEY_PEPPER: secret32("api-pepper-"),
    SWITCHYARD_CONTROL_PLANE_STORE: "postgres",
    SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON: createBootstrapJson(nodeToken),
    SWITCHYARD_PUBLIC_METRICS: "0",
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

describe("production server config", () => {
  it("parses valid production env and keeps summary redacted", () => {
    const config = loadServerConfig(createProductionEnv());

    expect(config.deploymentMode).toBe("production");
    expect(config.serverAuthMode).toBe("api_key");
    expect(config.controlPlaneStore).toBe("postgres");
    expect(config.hostedRuntimeAllowlist).toEqual(["fake.deterministic"]);
    expect(config.redactedSummary).toMatchObject({
      hasPostgresUrl: true,
      hasRedisUrl: true
    });

    const serializedSummary = JSON.stringify(config.redactedSummary);
    expect(serializedSummary).not.toContain("really-strong-credential");
    expect(serializedSummary).not.toContain("api-pepper-");
    expect(serializedSummary).not.toContain("node-token-");
  });

  it("fails when required production vars are missing", () => {
    const env = createProductionEnv();
    delete env.SWITCHYARD_POSTGRES_URL;

    expect(() => loadServerConfig(env)).toThrow("config_required:SWITCHYARD_POSTGRES_URL");
  });

  it("rejects placeholder and too-short API pepper", () => {
    expect(() => loadServerConfig(createProductionEnv({ SWITCHYARD_API_KEY_PEPPER: "replace-me" }))).toThrow(
      "secret_placeholder:SWITCHYARD_API_KEY_PEPPER"
    );

    expect(() => loadServerConfig(createProductionEnv({ SWITCHYARD_API_KEY_PEPPER: "short-pepper" }))).toThrow(
      "secret_too_short:SWITCHYARD_API_KEY_PEPPER"
    );
  });

  it("rejects low-signal substrings in direct production secrets", () => {
    expect(() =>
      loadServerConfig(createProductionEnv({ SWITCHYARD_API_KEY_PEPPER: "my-secret-value-12345678901234567890" }))
    ).toThrow("secret_placeholder:SWITCHYARD_API_KEY_PEPPER");

    expect(() =>
      loadServerConfig(createProductionEnv({ SWITCHYARD_NODE_SHARED_TOKEN: "switchyard-prod-token-1234567890123456" }))
    ).toThrow("secret_placeholder:SWITCHYARD_NODE_SHARED_TOKEN");
  });

  it("rejects placeholder and too-short node shared token", () => {
    expect(() => loadServerConfig(createProductionEnv({ SWITCHYARD_NODE_SHARED_TOKEN: "replace-with-token" }))).toThrow(
      "secret_placeholder:SWITCHYARD_NODE_SHARED_TOKEN"
    );

    expect(() => loadServerConfig(createProductionEnv({ SWITCHYARD_NODE_SHARED_TOKEN: "short-token" }))).toThrow(
      "secret_too_short:SWITCHYARD_NODE_SHARED_TOKEN"
    );
  });

  it("rejects placeholder postgres and redis URL passwords and redacts them", () => {
    const pgError = expectConfigError(() =>
      loadServerConfig(
        createProductionEnv({
          SWITCHYARD_POSTGRES_URL: "postgres://switchyard:replace-with-postgres-password@postgres.example.com:5432/switchyard"
        })
      )
    );
    expect(pgError.code).toBe("secret_placeholder:SWITCHYARD_POSTGRES_URL");
    expect(JSON.stringify(pgError.redactedConfig)).not.toContain("replace-with-postgres-password");

    const redisError = expectConfigError(() =>
      loadServerConfig(
        createProductionEnv({
          SWITCHYARD_REDIS_URL: "redis://default:replace-with-redis-password@redis.example.com:6379/0"
        })
      )
    );
    expect(redisError.code).toBe("secret_placeholder:SWITCHYARD_REDIS_URL");
    expect(JSON.stringify(redisError.redactedConfig)).not.toContain("replace-with-redis-password");
  });

  it("rejects low-signal substrings in URL passwords and redacts them", () => {
    const pgError = expectConfigError(() =>
      loadServerConfig(
        createProductionEnv({
          SWITCHYARD_POSTGRES_URL: "postgres://switchyard:my-secret-value-12345678901234567890@postgres.example.com:5432/switchyard"
        })
      )
    );
    expect(pgError.code).toBe("secret_placeholder:SWITCHYARD_POSTGRES_URL");
    expect(JSON.stringify(pgError.redactedConfig)).not.toContain("my-secret-value");

    const redisError = expectConfigError(() =>
      loadServerConfig(
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
      loadServerConfig(
        createProductionEnv({
          SWITCHYARD_OBJECT_STORE_BACKEND: "s3-compatible",
          SWITCHYARD_OBJECT_STORE_ENDPOINT: "https://objects.example.com",
          SWITCHYARD_OBJECT_STORE_REGION: "auto",
          SWITCHYARD_OBJECT_STORE_BUCKET: "switchyard-artifacts",
          SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID: "replace-with-access-key",
          SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY: "replace-with-secret-key"
        })
      )
    );

    expect(error.code).toMatch(/secret_placeholder:SWITCHYARD_OBJECT_STORE_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
    const serialized = JSON.stringify(error.redactedConfig);
    expect(serialized).not.toContain("replace-with-access-key");
    expect(serialized).not.toContain("replace-with-secret-key");
  });

  it("rejects unsafe production runtime and metrics posture", () => {
    expect(() =>
      loadServerConfig(
        createProductionEnv({
          SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
          SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled"
        })
      )
    ).toThrow(/hosted_real_runtime_production_forbidden|config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION/);

    expect(() => loadServerConfig(createProductionEnv({ SWITCHYARD_PUBLIC_METRICS: "1" }))).toThrow(
      "config_forbidden:SWITCHYARD_PUBLIC_METRICS"
    );
  });

  it("keeps local defaults backwards-compatible", () => {
    const config = loadServerConfig({});
    expect(config.deploymentMode).toBe("local");
    expect(config.serverAuthMode).toBe("disabled");
    expect(config.controlPlaneStore).toBe("memory");
    expect(config.postgresUrl).toBeUndefined();
    expect(config.redisUrl).toBeUndefined();
    expect(config.nodeSharedToken).toBeUndefined();
  });
});
