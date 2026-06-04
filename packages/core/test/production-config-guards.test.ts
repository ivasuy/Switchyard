import { describe, expect, it } from "vitest";
import {
  isPlaceholderSecret,
  validateProductionCwdPrefixes,
  validateProductionHostedRuntimeAllowlist,
  validateProductionHttpsUrl,
  validateProductionSecret,
  validateProductionUrlCredential
} from "../src/services/production-config-guards.js";

describe("production config guards", () => {
  it("detects placeholder secrets case-insensitively", () => {
    expect(isPlaceholderSecret(" replace-me ")).toBe(true);
    expect(isPlaceholderSecret("replace-with-api-key-pepper")).toBe(true);
    expect(isPlaceholderSecret("SECRET")).toBe(true);
    expect(isPlaceholderSecret("switchyard-prod-token-1234567890123456")).toBe(true);
    expect(isPlaceholderSecret("my-secret-value-12345678901234567890")).toBe(true);
    expect(isPlaceholderSecret("example-key-12345678901234567890")).toBe(true);
    expect(isPlaceholderSecret("real-credential-value-1234567890")).toBe(false);
  });

  it("rejects missing, placeholder, and short production secrets", () => {
    expect(validateProductionSecret({ variable: "SWITCHYARD_API_KEY_PEPPER" })).toEqual({
      ok: false,
      code: "config_required:SWITCHYARD_API_KEY_PEPPER",
      variable: "SWITCHYARD_API_KEY_PEPPER"
    });
    expect(validateProductionSecret({ variable: "SWITCHYARD_API_KEY_PEPPER", value: "replace-me" })).toEqual({
      ok: false,
      code: "secret_placeholder:SWITCHYARD_API_KEY_PEPPER",
      variable: "SWITCHYARD_API_KEY_PEPPER"
    });
    expect(validateProductionSecret({ variable: "SWITCHYARD_API_KEY_PEPPER", value: "my-secret-value-12345678901234567890", minLength: 32 })).toEqual({
      ok: false,
      code: "secret_placeholder:SWITCHYARD_API_KEY_PEPPER",
      variable: "SWITCHYARD_API_KEY_PEPPER"
    });
    expect(validateProductionSecret({ variable: "SWITCHYARD_API_KEY_PEPPER", value: "1234567890123456789012345678901", minLength: 32 })).toEqual({
      ok: false,
      code: "secret_too_short:SWITCHYARD_API_KEY_PEPPER",
      variable: "SWITCHYARD_API_KEY_PEPPER"
    });
    expect(validateProductionSecret({ variable: "SWITCHYARD_API_KEY_PEPPER", value: "12345678901234567890123456789012", minLength: 32 })).toEqual({
      ok: true
    });
  });

  it("rejects malformed urls and placeholder URL password credentials", () => {
    expect(validateProductionUrlCredential({ variable: "SWITCHYARD_REDIS_URL", value: "not-a-url", credential: "password" })).toEqual({
      ok: false,
      code: "config_invalid:SWITCHYARD_REDIS_URL",
      variable: "SWITCHYARD_REDIS_URL"
    });

    expect(validateProductionUrlCredential({
      variable: "SWITCHYARD_REDIS_URL",
      value: "redis://default:replace-with-redis-password@redis:6379/0",
      credential: "password"
    })).toEqual({
      ok: false,
      code: "secret_placeholder:SWITCHYARD_REDIS_URL",
      variable: "SWITCHYARD_REDIS_URL"
    });

    expect(validateProductionUrlCredential({
      variable: "SWITCHYARD_REDIS_URL",
      value: "redis://default:example-key-12345678901234567890@redis:6379/0",
      credential: "password"
    })).toEqual({
      ok: false,
      code: "secret_placeholder:SWITCHYARD_REDIS_URL",
      variable: "SWITCHYARD_REDIS_URL"
    });

    expect(validateProductionUrlCredential({
      variable: "SWITCHYARD_POSTGRES_URL",
      value: "postgres://switchyard:prod-credential-1234567890@db:5432/switchyard",
      credential: "password"
    })).toEqual({
      ok: true
    });
  });

  it("enforces provider-aware production runtime allowlist while preserving fake-only defaults", () => {
    expect(
      validateProductionHostedRuntimeAllowlist({
        allowlist: ["fake.deterministic"],
        hostedRealRuntimeExecution: "disabled"
      })
    ).toEqual({ ok: true });

    expect(
      validateProductionHostedRuntimeAllowlist({
        allowlist: ["fake.deterministic", "codex.exec_json"],
        hostedRealRuntimeExecution: "disabled"
      })
    ).toEqual({
      ok: false,
      code: "hosted_real_runtime_disabled",
      variable: "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"
    });

    expect(
      validateProductionHostedRuntimeAllowlist({
        allowlist: ["fake.deterministic", "codex.exec_json"],
        hostedRealRuntimeExecution: "enabled"
      })
    ).toEqual({
      ok: false,
      code: "provider_runtime_policy_missing",
      variable: "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"
    });

    expect(
      validateProductionHostedRuntimeAllowlist({
        allowlist: ["fake.deterministic", "codex.exec_json"],
        hostedRealRuntimeExecution: "enabled",
        providerActivation: {
          valid: true,
          enabledRealModes: ["codex.exec_json"],
          reasons: [],
          redactedSummary: {}
        }
      })
    ).toEqual({ ok: true });

    expect(
      validateProductionHostedRuntimeAllowlist({
        allowlist: ["codex.exec_json"],
        hostedRealRuntimeExecution: "enabled",
        variable: "SWITCHYARD_NODE_ALLOW_RUNTIME_MODES"
      })
    ).toEqual({
      ok: false,
      code: "provider_runtime_policy_missing",
      variable: "SWITCHYARD_NODE_ALLOW_RUNTIME_MODES"
    });
  });

  it("requires activation for known wrapper runtime allowlist entries", () => {
    expect(
      validateProductionHostedRuntimeAllowlist({
        allowlist: ["fake.deterministic", "generic_http.async_rest"],
        hostedRealRuntimeExecution: "enabled"
      })
    ).toEqual({
      ok: false,
      code: "provider_runtime_policy_missing",
      variable: "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"
    });

    expect(
      validateProductionHostedRuntimeAllowlist({
        allowlist: ["fake.deterministic", "generic_http.async_rest"],
        hostedRealRuntimeExecution: "enabled",
        providerActivation: {
          valid: true,
          enabledRealModes: ["generic_http.async_rest"],
          reasons: [],
          redactedSummary: {}
        }
      })
    ).toEqual({ ok: true });
  });

  it("fails closed on unknown hosted runtime allowlist entries before policy checks", () => {
    expect(
      validateProductionHostedRuntimeAllowlist({
        allowlist: ["fake.deterministic", "cursor.sdk"],
        hostedRealRuntimeExecution: "enabled"
      })
    ).toEqual({
      ok: false,
      code: "config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
      variable: "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"
    });
  });

  it("requires production https urls", () => {
    expect(validateProductionHttpsUrl({ variable: "SWITCHYARD_SERVER_URL", value: "http://hosted.example.com" })).toEqual({
      ok: false,
      code: "config_invalid:SWITCHYARD_SERVER_URL",
      variable: "SWITCHYARD_SERVER_URL"
    });
    expect(validateProductionHttpsUrl({ variable: "SWITCHYARD_SERVER_URL", value: "https://hosted.example.com" })).toEqual({
      ok: true
    });
  });

  it("rejects broad and invalid cwd prefixes", () => {
    expect(validateProductionCwdPrefixes(["/repo"]).ok).toBe(true);
    expect(validateProductionCwdPrefixes(["/"])).toEqual({
      ok: false,
      code: "config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES",
      variable: "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES"
    });
    expect(validateProductionCwdPrefixes([".."])).toEqual({
      ok: false,
      code: "config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES",
      variable: "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES"
    });
    expect(validateProductionCwdPrefixes(["C:\\"])).toEqual({
      ok: false,
      code: "config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES",
      variable: "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES"
    });
  });
});
