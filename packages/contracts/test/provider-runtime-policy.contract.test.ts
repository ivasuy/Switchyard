import { describe, expect, it } from "vitest";
import {
  providerResolvedCommandSchema,
  providerRuntimeFailureCodeSchema,
  providerRuntimeModeSchema,
  providerRuntimePolicySchema,
  type ProviderRuntimeFailureCode,
  type ProviderRuntimeMode,
  type ProviderRuntimePolicy,
  type ProviderResolvedCommand
} from "../src/index.js";

const validSpendControls = {
  maxActiveRuns: 2,
  maxRunsPerHour: 20,
  maxRunTimeoutSeconds: 300,
  maxPromptBytes: 60_000
} as const;

const validCodexEntry = {
  enabled: true,
  executablePath: "/usr/local/bin/codex",
  cwdPrefixes: ["/srv/switchyard/work"],
  envAllowlist: ["HOME", "PATH", "OPENAI_API_KEY"],
  requiredEnv: ["OPENAI_API_KEY"],
  fixedArgs: ["exec", "--json"],
  allowUserArgs: false,
  sandbox: "read_only",
  spendControls: validSpendControls
} as const;

const validClaudeEntry = {
  enabled: true,
  executablePath: "/usr/local/bin/claude",
  cwdPrefixes: ["/srv/switchyard/work"],
  envAllowlist: ["HOME", "PATH", "ANTHROPIC_API_KEY"],
  requiredEnv: ["ANTHROPIC_API_KEY"],
  allowUserArgs: false,
  permissionMode: "read_only",
  disabledTools: ["Bash", "WebFetch", "WebSearch"],
  spendControls: validSpendControls
} as const;

const validOpenCodeEntry = {
  enabled: true,
  executablePath: "/usr/local/bin/opencode",
  cwdPrefixes: ["/srv/switchyard/work"],
  envAllowlist: ["HOME", "PATH", "OPENCODE_CONFIG_DIR"],
  requiredEnv: [],
  fixedArgs: ["acp"],
  allowUserArgs: false,
  onePromptPerRun: true,
  spendControls: validSpendControls
} as const;

describe("provider runtime policy contracts", () => {
  it("parses valid codex policy", () => {
    const parsed = providerRuntimePolicySchema.parse({
      version: 1,
      modes: {
        "codex.exec_json": validCodexEntry
      }
    });

    expect(parsed.modes["codex.exec_json"]?.fixedArgs).toEqual(["exec", "--json"]);
  });

  it("parses valid claude policy", () => {
    const parsed = providerRuntimePolicySchema.parse({
      version: 1,
      modes: {
        "claude_code.sdk": validClaudeEntry
      }
    });

    expect(parsed.modes["claude_code.sdk"]?.disabledTools).toEqual(["Bash", "WebFetch", "WebSearch"]);
  });

  it("parses valid opencode policy", () => {
    const parsed = providerRuntimePolicySchema.parse({
      version: 1,
      modes: {
        "opencode.acp": validOpenCodeEntry
      }
    });

    expect(parsed.modes["opencode.acp"]?.fixedArgs).toEqual(["acp"]);
  });

  it("rejects empty and unknown modes", () => {
    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {}
      })
    ).toThrow(/provider_runtime_policy_empty/);

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "fake.deterministic": validCodexEntry
        }
      })
    ).toThrow(/provider_runtime_policy_unknown_mode/);

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "cursor.sdk": validCodexEntry
        }
      })
    ).toThrow(/provider_runtime_policy_unknown_mode/);

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "openclaw.sdk": validCodexEntry
        }
      })
    ).toThrow(/provider_runtime_policy_unknown_mode/);

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "paperclip.sdk": validCodexEntry
        }
      })
    ).toThrow(/provider_runtime_policy_unknown_mode/);

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          process: validCodexEntry
        }
      })
    ).toThrow(/provider_runtime_policy_unknown_mode/);

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          pty: validCodexEntry
        }
      })
    ).toThrow(/provider_runtime_policy_unknown_mode/);
  });

  it("rejects command policy escape hatches", () => {
    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "codex.exec_json": {
            ...validCodexEntry,
            allowUserArgs: true
          }
        }
      })
    ).toThrow();

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "codex.exec_json": {
            ...validCodexEntry,
            executablePath: "codex"
          }
        }
      })
    ).toThrow();

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "codex.exec_json": {
            ...validCodexEntry,
            cwdPrefixes: []
          }
        }
      })
    ).toThrow();

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "codex.exec_json": {
            ...validCodexEntry,
            cwdPrefixes: ["./work"]
          }
        }
      })
    ).toThrow();

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "codex.exec_json": {
            ...validCodexEntry,
            envAllowlist: ["OPENAI-API-KEY"]
          }
        }
      })
    ).toThrow();

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "codex.exec_json": {
            ...validCodexEntry,
            spendControls: undefined
          }
        }
      })
    ).toThrow();

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "codex.exec_json": {
            ...validCodexEntry,
            credentialValue: "sk-live-abc"
          }
        }
      })
    ).toThrow();
  });

  it("rejects codex unsafe settings", () => {
    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "codex.exec_json": {
            ...validCodexEntry,
            sandbox: "workspace_write"
          }
        }
      })
    ).toThrow();

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "codex.exec_json": {
            ...validCodexEntry,
            fixedArgs: ["exec"]
          }
        }
      })
    ).toThrow();
  });

  it("rejects claude unsafe settings", () => {
    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "claude_code.sdk": {
            ...validClaudeEntry,
            permissionMode: "workspace_write"
          }
        }
      })
    ).toThrow();

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "claude_code.sdk": {
            ...validClaudeEntry,
            disabledTools: ["Bash", "WebSearch"]
          }
        }
      })
    ).toThrow();
  });

  it("rejects opencode unsafe settings", () => {
    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "opencode.acp": {
            ...validOpenCodeEntry,
            fixedArgs: ["acp", "--interactive"]
          }
        }
      })
    ).toThrow();

    expect(() =>
      providerRuntimePolicySchema.parse({
        version: 1,
        modes: {
          "opencode.acp": {
            ...validOpenCodeEntry,
            onePromptPerRun: false
          }
        }
      })
    ).toThrow();
  });

  it("validates provider failure codes", () => {
    const knownCodes: ProviderRuntimeFailureCode[] = [
      "provider_runtime_policy_missing",
      "provider_runtime_policy_empty",
      "provider_runtime_policy_malformed",
      "provider_runtime_policy_unknown_mode",
      "provider_runtime_policy_disabled",
      "provider_command_policy_invalid",
      "provider_command_denied",
      "provider_binary_unavailable",
      "provider_credentials_missing",
      "provider_credentials_invalid",
      "provider_spend_controls_missing",
      "provider_spend_controls_invalid",
      "provider_spend_limit_exceeded",
      "provider_prompt_too_large",
      "hosted_runtime_adapter_unavailable",
      "hosted_approval_bridge_unsupported",
      "hosted_input_bridge_unsupported",
      "provider_canary_config_missing",
      "provider_canary_runtime_empty",
      "provider_canary_create_denied",
      "provider_canary_timeout",
      "provider_canary_run_failed",
      "provider_canary_artifact_missing",
      "provider_canary_metrics_failed",
      "provider_canary_audit_failed"
    ];

    for (const code of knownCodes) {
      expect(providerRuntimeFailureCodeSchema.parse(code)).toBe(code);
    }

    expect(() => providerRuntimeFailureCodeSchema.parse("made_up_provider_code")).toThrow();
  });

  it("parses provider resolved command handoff", () => {
    const parsed = providerResolvedCommandSchema.parse({
      runtimeMode: "codex.exec_json",
      executablePath: "/usr/local/bin/codex",
      argv: ["exec", "--json", "--model", "gpt-5"],
      cwd: "/srv/switchyard/work/project-a",
      env: {
        PATH: "/usr/bin",
        HOME: "/srv/switchyard"
      },
      envKeys: ["HOME", "PATH"],
      allowUserArgs: false,
      redactedSummary: {
        runtimeMode: "codex.exec_json",
        executable: "codex",
        argvCount: 4,
        envKeyCount: 2
      }
    });

    expect(parsed.allowUserArgs).toBe(false);
  });

  it("exports mode schema and inferred types", () => {
    const mode: ProviderRuntimeMode = providerRuntimeModeSchema.parse("codex.exec_json");
    expect(mode).toBe("codex.exec_json");

    const policy: ProviderRuntimePolicy = providerRuntimePolicySchema.parse({
      version: 1,
      modes: {
        "codex.exec_json": validCodexEntry,
        "claude_code.sdk": validClaudeEntry,
        "opencode.acp": validOpenCodeEntry
      }
    });

    const command: ProviderResolvedCommand = providerResolvedCommandSchema.parse({
      runtimeMode: "opencode.acp",
      executablePath: "/usr/local/bin/opencode",
      argv: ["acp"],
      cwd: "/srv/switchyard/work/project-b",
      env: {},
      envKeys: [],
      allowUserArgs: false,
      redactedSummary: {
        runtimeMode: "opencode.acp",
        executable: "opencode",
        argvCount: 1,
        envKeyCount: 0
      }
    });

    expect(Object.keys(policy.modes)).toHaveLength(3);
    expect(command.runtimeMode).toBe("opencode.acp");
  });
});
