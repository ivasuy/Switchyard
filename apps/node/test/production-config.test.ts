import { describe, expect, it } from "vitest";
import { ConfigError, loadNodeConfig } from "../src/config.js";

function secret32(prefix: string): string {
  return `${prefix}${"x".repeat(Math.max(0, 32 - prefix.length))}`;
}

function createProductionEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SWITCHYARD_DEPLOYMENT_MODE: "production",
    SWITCHYARD_SERVER_URL: "https://server.switchyard.example.com",
    SWITCHYARD_NODE_SHARED_TOKEN: secret32("node-shared-token-"),
    SWITCHYARD_NODE_CAPABILITIES: "runtime.fake.deterministic",
    SWITCHYARD_NODE_ALLOW_RUNTIME_MODES: "fake.deterministic",
    SWITCHYARD_NODE_ALLOW_CWD_PREFIXES: "/repo",
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

describe("production node config", () => {
  it("parses valid production env and keeps summary redacted", () => {
    const config = loadNodeConfig(createProductionEnv());

    expect(config.deploymentMode).toBe("production");
    expect(config.serverUrl).toBe("https://server.switchyard.example.com");
    expect(config.policy.allowRuntimeModes).toEqual(["fake.deterministic"]);
    expect(config.policy.allowCwdPrefixes).toEqual(["/repo"]);

    const serializedSummary = JSON.stringify(config.redactedSummary);
    expect(serializedSummary).not.toContain("node-shared-token-");
  });

  it("fails when required production vars are missing", () => {
    const env = createProductionEnv();
    delete env.SWITCHYARD_NODE_ALLOW_CWD_PREFIXES;

    expect(() => loadNodeConfig(env)).toThrow("config_required:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES");
  });

  it("rejects insecure production server URL", () => {
    expect(() => loadNodeConfig(createProductionEnv({ SWITCHYARD_SERVER_URL: "http://server.switchyard.example.com" }))).toThrow(
      "config_invalid:SWITCHYARD_SERVER_URL"
    );
  });

  it("rejects placeholder and too-short node tokens", () => {
    expect(() => loadNodeConfig(createProductionEnv({ SWITCHYARD_NODE_SHARED_TOKEN: "replace-me" }))).toThrow(
      "secret_placeholder:SWITCHYARD_NODE_SHARED_TOKEN"
    );
    expect(() => loadNodeConfig(createProductionEnv({ SWITCHYARD_NODE_SHARED_TOKEN: "switchyard-prod-token-1234567890123456" }))).toThrow(
      "secret_placeholder:SWITCHYARD_NODE_SHARED_TOKEN"
    );
    expect(() => loadNodeConfig(createProductionEnv({ SWITCHYARD_NODE_SHARED_TOKEN: "short-token" }))).toThrow(
      "secret_too_short:SWITCHYARD_NODE_SHARED_TOKEN"
    );
  });

  it("rejects non-fake runtime allowlist in production", () => {
    expect(() => loadNodeConfig(createProductionEnv({ SWITCHYARD_NODE_ALLOW_RUNTIME_MODES: "fake.deterministic,codex.exec_json" }))).toThrow(
      "hosted_real_runtime_production_forbidden"
    );
  });

  it("rejects broad and invalid cwd prefixes", () => {
    expect(() => loadNodeConfig(createProductionEnv({ SWITCHYARD_NODE_ALLOW_CWD_PREFIXES: "/" }))).toThrow(
      "config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES"
    );
    expect(() => loadNodeConfig(createProductionEnv({ SWITCHYARD_NODE_ALLOW_CWD_PREFIXES: ".." }))).toThrow(
      "config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES"
    );
    expect(() => loadNodeConfig(createProductionEnv({ SWITCHYARD_NODE_ALLOW_CWD_PREFIXES: "C:\\" }))).toThrow(
      "config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES"
    );
    expect(() => loadNodeConfig(createProductionEnv({ SWITCHYARD_NODE_ALLOW_CWD_PREFIXES: "/repo,   " }))).toThrow(
      "config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES"
    );
  });

  it("keeps local defaults backwards-compatible", () => {
    const config = loadNodeConfig({
      SWITCHYARD_DEPLOYMENT_MODE: "local"
    });

    expect(config.deploymentMode).toBe("local");
    expect(config.serverUrl).toBe("http://127.0.0.1:4646");
    expect(config.policy.allowRuntimeModes).toEqual(["fake.deterministic"]);
    expect(config.policy.allowCwdPrefixes).toEqual(["/repo"]);
  });

  it("redacts shared token in config errors", () => {
    const error = expectConfigError(() =>
      loadNodeConfig(
        createProductionEnv({
          SWITCHYARD_NODE_ALLOW_RUNTIME_MODES: "fake.deterministic,codex.exec_json"
        })
      )
    );

    expect(error.code).toBe("hosted_real_runtime_production_forbidden");
    expect(error.variable).toBe("SWITCHYARD_NODE_ALLOW_RUNTIME_MODES");
    expect(JSON.stringify(error.redactedConfig)).not.toContain("node-shared-token-");
  });

  it("rejects worker-config-only env inputs in node config", () => {
    expect(() => loadNodeConfig(createProductionEnv({
      SWITCHYARD_TOOL_ADAPTER_MODE: "real"
    }))).toThrow("config_invalid:SWITCHYARD_TOOL_ADAPTER_MODE");

    expect(() => loadNodeConfig(createProductionEnv({
      SWITCHYARD_HOSTED_REAL_TOOLS: "enabled"
    }))).toThrow("config_invalid:SWITCHYARD_HOSTED_REAL_TOOLS");
  });

  it("rejects hosted credential env in node config", () => {
    expect(() => loadNodeConfig(createProductionEnv({
      SWITCHYARD_GITHUB_TOKEN: "ghp_hosted_not_allowed"
    }))).toThrow("config_invalid:SWITCHYARD_GITHUB_TOKEN");
  });
});
