import { describe, expect, it } from "vitest";
import {
  buildProviderResolvedCommand,
  checkProviderSpendControlsForRun,
  resolveProviderRuntimePolicy,
  validateProviderRuntimeActivation
} from "../src/services/provider-runtime-policy.js";

const VALID_POLICY = JSON.stringify({
  version: 1,
  modes: {
    "codex.exec_json": {
      enabled: true,
      executablePath: "/opt/switchyard/bin/codex",
      cwdPrefixes: ["/srv/switchyard/work"],
      envAllowlist: ["PATH", "OPENAI_API_KEY"],
      requiredEnv: ["OPENAI_API_KEY"],
      fixedArgs: ["exec", "--json"],
      allowUserArgs: false,
      sandbox: "read_only",
      spendControls: {
        maxActiveRuns: 2,
        maxRunsPerHour: 20,
        maxRunTimeoutSeconds: 300,
        maxPromptBytes: 1024
      }
    }
  }
});

const VALID_GENERIC_HTTP_POLICY = JSON.stringify({
  version: 1,
  modes: {
    "generic_http.async_rest": {
      enabled: true,
      baseUrlEnv: "SWITCHYARD_GENERIC_HTTP_BASE_URL",
      auth: { type: "api_key", env: "SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN" },
      spendControls: {
        maxActiveRuns: 2,
        maxRunsPerHour: 20,
        maxRunTimeoutSeconds: 300,
        maxPromptBytes: 1024
      }
    }
  }
});

const VALID_AGENTFIELD_POLICY = JSON.stringify({
  version: 1,
  modes: {
    "agentfield.async_rest": {
      enabled: true,
      baseUrlEnv: "SWITCHYARD_AGENTFIELD_BASE_URL",
      auth: { type: "api_key", env: "SWITCHYARD_AGENTFIELD_API_KEY" },
      targetEnv: "SWITCHYARD_AGENTFIELD_TARGET",
      spendControls: {
        maxActiveRuns: 2,
        maxRunsPerHour: 20,
        maxRunTimeoutSeconds: 300,
        maxPromptBytes: 1024
      }
    }
  }
});

describe("provider runtime policy", () => {
  it("keeps production fake-only valid without policy", () => {
    const result = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "disabled",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      env: {}
    });

    expect(result.activation.valid).toBe(true);
    expect(result.activation.enabledRealModes).toEqual([]);
    expect(result.activation.reasons).toEqual([]);
    expect(result.activation.redactedSummary).toMatchObject({
      source: { kind: "none" },
      realModeCount: 0
    });
  });

  it("fails closed on unknown hosted runtime allowlist mode before policy lookup", () => {
    const result = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "cursor.sdk"],
      env: {}
    });

    expect(result.activation.valid).toBe(false);
    expect(result.activation.reasons[0]).toMatchObject({ code: "provider_runtime_policy_unknown_mode" });
  });

  it("rejects production real mode when gate is disabled", () => {
    const result = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "disabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      env: {}
    });

    expect(result.activation.valid).toBe(false);
    expect(result.activation.reasons[0]).toMatchObject({ code: "hosted_real_runtime_disabled" });
  });

  it("rejects source conflict and redacts source values", () => {
    const result = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: VALID_POLICY,
      policyPathContents: { state: "ok", contents: VALID_POLICY },
      env: { OPENAI_API_KEY: "secret-value" }
    });

    expect(result.activation.valid).toBe(false);
    expect(result.activation.reasons[0]).toMatchObject({ code: "provider_runtime_policy_malformed" });

    expect(result.activation.redactedSummary.source).toEqual({ kind: "json" });

    const summary = JSON.stringify(result.activation.redactedSummary);
    expect(summary).not.toContain("secret-value");
    expect(summary).not.toContain("/opt/switchyard/bin/codex");
    expect(summary).not.toContain(VALID_POLICY);
    expect(summary).not.toContain("policyBytes");
    expect(summary).not.toContain("\"state\"");
  });

  it("maps unreadable and invalid path policies to named failures without leaking path", () => {
    const unreadable = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyPathContents: { state: "unreadable" },
      env: {}
    });
    expect(unreadable.activation.valid).toBe(false);
    expect(unreadable.activation.reasons[0]).toMatchObject({ code: "provider_runtime_policy_missing" });

    const malformed = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyPathContents: { state: "invalid_utf8" },
      env: {}
    });
    expect(malformed.activation.valid).toBe(false);
    expect(malformed.activation.reasons[0]).toMatchObject({ code: "provider_runtime_policy_malformed" });
    expect(malformed.activation.redactedSummary.source).toEqual({ kind: "path" });
    expect(JSON.stringify(malformed.activation.redactedSummary)).not.toContain("/tmp/policy.json");
    expect(JSON.stringify(malformed.activation.redactedSummary)).not.toContain("\"state\"");
  });

  it("rejects empty and malformed policy payloads", () => {
    const empty = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: "   ",
      env: {}
    });
    expect(empty.activation.valid).toBe(false);
    expect(empty.activation.reasons[0]).toMatchObject({ code: "provider_runtime_policy_empty" });

    const malformed = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: "{",
      env: {}
    });
    expect(malformed.activation.valid).toBe(false);
    expect(malformed.activation.reasons[0]).toMatchObject({ code: "provider_runtime_policy_malformed" });
  });

  it("rejects disabled policy entry and missing required env", () => {
    const disabledPolicy = JSON.stringify({
      version: 1,
      modes: {
        "codex.exec_json": {
          enabled: false,
          executablePath: "/opt/switchyard/bin/codex",
          cwdPrefixes: ["/srv/switchyard/work"],
          envAllowlist: ["OPENAI_API_KEY"],
          requiredEnv: ["OPENAI_API_KEY"],
          fixedArgs: ["exec", "--json"],
          allowUserArgs: false,
          sandbox: "read_only",
          spendControls: {
            maxActiveRuns: 2,
            maxRunsPerHour: 20,
            maxRunTimeoutSeconds: 300,
            maxPromptBytes: 1024
          }
        }
      }
    });

    const disabled = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: disabledPolicy,
      env: { OPENAI_API_KEY: "present" }
    });
    expect(disabled.activation.valid).toBe(false);
    expect(disabled.activation.reasons[0]).toMatchObject({ code: "provider_runtime_policy_disabled" });

    const missingEnv = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: VALID_POLICY,
      env: {}
    });
    expect(missingEnv.activation.valid).toBe(false);
    expect(missingEnv.activation.reasons[0]).toMatchObject({ code: "provider_credentials_missing" });
  });

  it("allows selected known real mode when policy and binary probe pass", () => {
    const result = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: VALID_POLICY,
      env: { OPENAI_API_KEY: "present" },
      binaryProbe: ({ runtimeMode, executablePath }) => runtimeMode === "codex.exec_json" && executablePath.endsWith("codex")
    });

    expect(result.activation.valid).toBe(true);
    expect(result.activation.enabledRealModes).toEqual(["codex.exec_json"]);
  });

  it("activates valid wrapper policy without executable command resolution", () => {
    const result = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "generic_http.async_rest"],
      policyJson: VALID_GENERIC_HTTP_POLICY,
      env: {
        SWITCHYARD_GENERIC_HTTP_BASE_URL: "https://wrapper.example",
        SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN: "live-wrapper-token"
      },
      binaryProbe: () => false
    });

    expect(result.activation.valid).toBe(true);
    expect(result.activation.enabledRealModes).toEqual(["generic_http.async_rest"]);
    expect(result.activation.redactedSummary.modeStatuses).toEqual([
      { runtimeMode: "generic_http.async_rest", ready: true, reasons: [] }
    ]);

    const command = buildProviderResolvedCommand({
      activation: result.activation,
      runtimeMode: "generic_http.async_rest",
      cwd: "/srv/switchyard/work/project",
      env: {
        SWITCHYARD_GENERIC_HTTP_BASE_URL: "https://wrapper.example",
        SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN: "live-wrapper-token"
      }
    });
    expect(command.ok).toBe(false);
    if (command.ok) return;
    expect(command.code).toBe("provider_command_policy_invalid");
  });

  it("requires wrapper policy and required wrapper env references", () => {
    const missingPolicy = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "agentfield.async_rest"],
      env: {}
    });
    expect(missingPolicy.activation.valid).toBe(false);
    expect(missingPolicy.activation.reasons[0]).toMatchObject({ code: "provider_runtime_policy_missing" });

    const missingEnv = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "agentfield.async_rest"],
      policyJson: VALID_AGENTFIELD_POLICY,
      env: {
        SWITCHYARD_AGENTFIELD_BASE_URL: "https://agentfield.example",
        SWITCHYARD_AGENTFIELD_API_KEY: "present"
      }
    });
    expect(missingEnv.activation.valid).toBe(false);
    expect(missingEnv.activation.reasons[0]).toMatchObject({
      code: "provider_credentials_missing",
      runtimeMode: "agentfield.async_rest"
    });
  });

  it("rejects invalid wrapper spend controls, command fields, endpoint overrides, and credentialed base URLs", () => {
    const invalidSpend = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "generic_http.async_rest"],
      policyJson: JSON.stringify({
        version: 1,
        modes: {
          "generic_http.async_rest": {
            enabled: true,
            baseUrlEnv: "SWITCHYARD_GENERIC_HTTP_BASE_URL",
            auth: { type: "api_key", env: "SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN" },
            spendControls: {
              maxActiveRuns: 0,
              maxRunsPerHour: 20,
              maxRunTimeoutSeconds: 300,
              maxPromptBytes: 1024
            }
          }
        }
      }),
      env: {
        SWITCHYARD_GENERIC_HTTP_BASE_URL: "https://wrapper.example",
        SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN: "present"
      }
    });
    expect(invalidSpend.activation.valid).toBe(false);
    expect(invalidSpend.activation.reasons[0]).toMatchObject({ code: "provider_spend_controls_invalid" });

    for (const unsafeField of ["executablePath", "fixedArgs", "cwdPrefixes", "argv", "shell", "command", "processFactory", "pty", "env", "perRunBaseUrl", "perRunAuthToken", "baseUrl"]) {
      const unsafe = resolveProviderRuntimePolicy({
        deploymentMode: "production",
        hostedRealRuntimeExecution: "enabled",
        hostedRuntimeAllowlist: ["fake.deterministic", "agentfield.async_rest"],
        policyJson: JSON.stringify({
          version: 1,
          modes: {
            "agentfield.async_rest": {
              enabled: true,
              baseUrlEnv: "SWITCHYARD_AGENTFIELD_BASE_URL",
              auth: { type: "api_key", env: "SWITCHYARD_AGENTFIELD_API_KEY" },
              targetEnv: "SWITCHYARD_AGENTFIELD_TARGET",
              spendControls: {
                maxActiveRuns: 2,
                maxRunsPerHour: 20,
                maxRunTimeoutSeconds: 300,
                maxPromptBytes: 1024
              },
              [unsafeField]: unsafeField === "fixedArgs" || unsafeField === "cwdPrefixes" || unsafeField === "argv" ? [] : "unsafe"
            }
          }
        }),
        env: {}
      });
      expect(unsafe.activation.valid).toBe(false);
      expect(["provider_command_policy_invalid", "provider_runtime_policy_malformed"]).toContain(
        unsafe.activation.reasons[0]?.code
      );
    }

    const credentialedUrl = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "generic_http.async_rest"],
      policyJson: VALID_GENERIC_HTTP_POLICY,
      env: {
        SWITCHYARD_GENERIC_HTTP_BASE_URL: "https://user:secret@wrapper.example",
        SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN: "present"
      }
    });
    expect(credentialedUrl.activation.valid).toBe(false);
    expect(credentialedUrl.activation.reasons[0]).toMatchObject({ code: "provider_credentials_invalid" });
  });

  it("keeps wrapper activation summaries redacted to status and reason codes", () => {
    const result = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "agentfield.async_rest"],
      policyJson: VALID_AGENTFIELD_POLICY,
      env: {
        SWITCHYARD_AGENTFIELD_BASE_URL: "https://agentfield.example",
        SWITCHYARD_AGENTFIELD_API_KEY: "agentfield-secret-token",
        SWITCHYARD_AGENTFIELD_TARGET: "research-agent.deep_analysis"
      }
    });

    expect(result.activation.valid).toBe(true);
    expect(result.activation.redactedSummary.modeStatuses).toEqual([
      { runtimeMode: "agentfield.async_rest", ready: true, reasons: [] }
    ]);
    const summary = JSON.stringify(result.activation.redactedSummary);
    expect(summary).toContain("agentfield.async_rest");
    expect(summary).not.toContain("agentfield.example");
    expect(summary).not.toContain("agentfield-secret-token");
    expect(summary).not.toContain("research-agent.deep_analysis");
    expect(summary).not.toContain("SWITCHYARD_AGENTFIELD");
    expect(summary).not.toContain("executablePath");
    expect(summary).not.toContain("argv");
    expect(summary).not.toContain("cwd");
  });

  it("denies command policy injections and out-of-prefix cwd", () => {
    const resolved = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: VALID_POLICY,
      env: { OPENAI_API_KEY: "present" }
    });

    expect(resolved.activation.valid).toBe(true);
    if (!resolved.activation.valid) {
      return;
    }

    const outOfPrefix = buildProviderResolvedCommand({
      activation: resolved.activation,
      runtimeMode: "codex.exec_json",
      cwd: "/tmp",
      env: { OPENAI_API_KEY: "present" }
    });
    expect(outOfPrefix.ok).toBe(false);
    if (outOfPrefix.ok) {
      return;
    }
    expect(outOfPrefix.code).toBe("provider_command_denied");

    const withArgv = buildProviderResolvedCommand({
      activation: resolved.activation,
      runtimeMode: "codex.exec_json",
      cwd: "/srv/switchyard/work/repo",
      env: { OPENAI_API_KEY: "present" },
      argv: ["--danger"]
    });
    expect(withArgv.ok).toBe(false);
    if (withArgv.ok) {
      return;
    }
    expect(withArgv.code).toBe("provider_command_denied");
  });

  it("builds redacted resolved command for valid input", () => {
    const resolved = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: VALID_POLICY,
      env: { OPENAI_API_KEY: "present", PATH: "/usr/bin" }
    });

    expect(resolved.activation.valid).toBe(true);
    if (!resolved.activation.valid) {
      return;
    }

    const command = buildProviderResolvedCommand({
      activation: resolved.activation,
      runtimeMode: "codex.exec_json",
      cwd: "/srv/switchyard/work/project",
      env: { OPENAI_API_KEY: "present", PATH: "/usr/bin", IGNORED: "x" }
    });

    expect(command.ok).toBe(true);
    if (!command.ok) {
      return;
    }

    expect(command.command.argv).toEqual(["exec", "--json"]);
    expect(command.command.envKeys.sort()).toEqual(["OPENAI_API_KEY", "PATH"]);

    const summary = JSON.stringify(command.command.redactedSummary);
    expect(summary).not.toContain("present");
    expect(summary).not.toContain("/srv/switchyard/work/project");
    expect(summary).not.toContain("/opt/switchyard/bin/codex");
  });

  it("checks spend controls for prompt, active, hourly, and timeout limits", () => {
    const resolved = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: VALID_POLICY,
      env: { OPENAI_API_KEY: "present" }
    });

    expect(resolved.activation.valid).toBe(true);
    if (!resolved.activation.valid) {
      return;
    }

    expect(
      checkProviderSpendControlsForRun({
        activation: resolved.activation,
        runtimeMode: "codex.exec_json",
        promptBytes: 1025,
        activeRuns: 0,
        runsInPastHour: 0,
        timeoutSeconds: 60
      })
    ).toMatchObject({ ok: false, code: "provider_prompt_too_large" });

    expect(
      checkProviderSpendControlsForRun({
        activation: resolved.activation,
        runtimeMode: "codex.exec_json",
        promptBytes: 100,
        activeRuns: 2,
        runsInPastHour: 0,
        timeoutSeconds: 60
      })
    ).toMatchObject({ ok: false, code: "provider_spend_limit_exceeded" });

    expect(
      checkProviderSpendControlsForRun({
        activation: resolved.activation,
        runtimeMode: "codex.exec_json",
        promptBytes: 100,
        activeRuns: 0,
        runsInPastHour: 20,
        timeoutSeconds: 60
      })
    ).toMatchObject({ ok: false, code: "provider_spend_limit_exceeded" });

    expect(
      checkProviderSpendControlsForRun({
        activation: resolved.activation,
        runtimeMode: "codex.exec_json",
        promptBytes: 100,
        activeRuns: 0,
        runsInPastHour: 0,
        timeoutSeconds: 301
      })
    ).toMatchObject({ ok: false, code: "provider_spend_limit_exceeded" });
  });

  it("parses and validates explicitly supplied staging policy", () => {
    const valid = resolveProviderRuntimePolicy({
      deploymentMode: "staging",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: VALID_POLICY,
      env: { OPENAI_API_KEY: "present" }
    });
    expect(valid.activation.valid).toBe(true);

    const invalid = resolveProviderRuntimePolicy({
      deploymentMode: "staging",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: "{",
      env: { OPENAI_API_KEY: "present" }
    });
    expect(invalid.activation.valid).toBe(false);
    expect(invalid.activation.reasons[0]).toMatchObject({ code: "provider_runtime_policy_malformed" });
  });

  it("exposes validateProviderRuntimeActivation for direct validation", () => {
    const resolved = resolveProviderRuntimePolicy({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policyJson: VALID_POLICY,
      env: { OPENAI_API_KEY: "present" }
    });

    expect(resolved.policy).toBeDefined();
    if (!resolved.policy) {
      return;
    }

    const activation = validateProviderRuntimeActivation({
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      policy: resolved.policy,
      env: { OPENAI_API_KEY: "present" }
    });

    expect(activation.valid).toBe(true);
    expect(activation.enabledRealModes).toEqual(["codex.exec_json"]);
  });
});
