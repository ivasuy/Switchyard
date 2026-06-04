import path from "node:path";
import { z } from "zod";

export const PROVIDER_RUNTIME_MODES = [
  "codex.exec_json",
  "claude_code.sdk",
  "opencode.acp",
  "agentfield.async_rest",
  "generic_http.async_rest"
] as const;

export const providerRuntimeModeSchema = z.enum(PROVIDER_RUNTIME_MODES);

const providerEnvVarNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const hasOnlyNormalizedAbsolutePathSegments = (value: string): boolean => {
  if (!path.posix.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) {
    return false;
  }
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return !segments.includes("..") && !segments.includes(".");
};

const providerAbsolutePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => hasOnlyNormalizedAbsolutePathSegments(value),
    "provider_command_policy_invalid: path must be an absolute normalized path"
  );

const providerSpendControlsSchema = z
  .object({
    maxActiveRuns: z.number().int().positive(),
    maxRunsPerHour: z.number().int().positive(),
    maxRunTimeoutSeconds: z.number().int().positive(),
    maxPromptBytes: z.number().int().positive()
  })
  .strict();

const providerCommonModeEntrySchema = z
  .object({
    enabled: z.boolean(),
    executablePath: providerAbsolutePathSchema,
    cwdPrefixes: z.array(providerAbsolutePathSchema).min(1),
    envAllowlist: z.array(providerEnvVarNameSchema),
    requiredEnv: z.array(providerEnvVarNameSchema),
    allowUserArgs: z.literal(false),
    spendControls: providerSpendControlsSchema
  })
  .strict();

const codexProviderModePolicySchema = providerCommonModeEntrySchema
  .extend({
    fixedArgs: z.tuple([z.literal("exec"), z.literal("--json")]),
    sandbox: z.literal("read_only")
  })
  .strict();

const claudeDisabledToolSchema = z.enum(["Bash", "WebFetch", "WebSearch"]);

const claudeProviderModePolicySchema = providerCommonModeEntrySchema
  .extend({
    permissionMode: z.literal("read_only"),
    disabledTools: z.array(claudeDisabledToolSchema).superRefine((value, ctx) => {
      const requiredTools: readonly z.infer<typeof claudeDisabledToolSchema>[] = ["Bash", "WebFetch", "WebSearch"];
      for (const tool of requiredTools) {
        if (!value.includes(tool)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `provider_command_policy_invalid: missing claude disabled tool ${tool}`
          });
        }
      }
    })
  })
  .strict();

const openCodeProviderModePolicySchema = providerCommonModeEntrySchema
  .extend({
    fixedArgs: z.tuple([z.literal("acp")]),
    onePromptPerRun: z.literal(true)
  })
  .strict();

const wrapperAuthEnvReferenceSchema = z
  .object({
    type: z.literal("api_key"),
    env: providerEnvVarNameSchema
  })
  .strict();

const wrapperCommonModeEntrySchema = z
  .object({
    enabled: z.boolean(),
    baseUrlEnv: providerEnvVarNameSchema,
    auth: wrapperAuthEnvReferenceSchema,
    spendControls: providerSpendControlsSchema
  })
  .strict();

const agentFieldWrapperModePolicySchema = wrapperCommonModeEntrySchema
  .extend({
    targetEnv: providerEnvVarNameSchema
  })
  .strict();

const genericHttpWrapperModePolicySchema = wrapperCommonModeEntrySchema.strict();

const providerModeEntrySchemaByMode = {
  "codex.exec_json": codexProviderModePolicySchema,
  "claude_code.sdk": claudeProviderModePolicySchema,
  "opencode.acp": openCodeProviderModePolicySchema,
  "agentfield.async_rest": agentFieldWrapperModePolicySchema,
  "generic_http.async_rest": genericHttpWrapperModePolicySchema
} as const;

const providerModesSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    const keys = Object.keys(value);

    if (keys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider_runtime_policy_empty"
      });
      return;
    }

    for (const key of keys) {
      const modeParse = providerRuntimeModeSchema.safeParse(key);
      if (!modeParse.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `provider_runtime_policy_unknown_mode:${key}`,
          path: [key]
        });
        continue;
      }

      const parsedMode = modeParse.data;
      const entrySchema = providerModeEntrySchemaByMode[parsedMode];
      const entryResult = entrySchema.safeParse(value[key]);

      if (!entryResult.success) {
        for (const issue of entryResult.error.issues) {
          ctx.addIssue({
            ...issue,
            path: [key, ...issue.path]
          });
        }
      }
    }
  })
  .transform((value) => {
    const output: Partial<Record<ProviderRuntimeMode, ProviderRuntimeModePolicy>> = {};
    const keys = Object.keys(value);

    for (const key of keys) {
      const modeParse = providerRuntimeModeSchema.safeParse(key);
      if (!modeParse.success) {
        continue;
      }

      const mode = modeParse.data;
      const parseResult = providerModeEntrySchemaByMode[mode].safeParse(value[key]);
      if (parseResult.success) {
        output[mode] = parseResult.data;
      }
    }

    return output;
  });

export const providerRuntimePolicySchema = z
  .object({
    version: z.literal(1),
    modes: providerModesSchema
  })
  .strict();

export const providerResolvedCommandSchema = z
  .object({
    runtimeMode: providerRuntimeModeSchema,
    executablePath: providerAbsolutePathSchema,
    argv: z.array(z.string()),
    cwd: providerAbsolutePathSchema,
    env: z.record(z.string(), z.string()),
    envKeys: z.array(providerEnvVarNameSchema),
    allowUserArgs: z.literal(false),
    redactedSummary: z.record(z.string(), z.unknown())
  })
  .strict()
  .superRefine((value, ctx) => {
    const envKeys = Object.keys(value.env);
    const envKeySet = new Set(envKeys);
    const declaredEnvKeySet = new Set(value.envKeys);

    if (declaredEnvKeySet.size !== value.envKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider_command_policy_invalid: envKeys must be unique",
        path: ["envKeys"]
      });
      return;
    }

    for (const key of value.envKeys) {
      if (!envKeySet.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `provider_command_policy_invalid: envKeys contains unknown key ${key}`,
          path: ["envKeys"]
        });
      }
    }

    for (const key of envKeys) {
      if (!declaredEnvKeySet.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `provider_command_policy_invalid: env key ${key} missing from envKeys`,
          path: ["env"]
        });
      }
    }
  });

export const providerRuntimeFailureCodeSchema = z.enum([
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
]);

export type ProviderRuntimeMode = z.infer<typeof providerRuntimeModeSchema>;
export type ProviderRuntimeSpendControls = z.infer<typeof providerSpendControlsSchema>;
export type CodexProviderModePolicy = z.infer<typeof codexProviderModePolicySchema>;
export type ClaudeProviderModePolicy = z.infer<typeof claudeProviderModePolicySchema>;
export type OpenCodeProviderModePolicy = z.infer<typeof openCodeProviderModePolicySchema>;
export type AgentFieldWrapperModePolicy = z.infer<typeof agentFieldWrapperModePolicySchema>;
export type GenericHttpWrapperModePolicy = z.infer<typeof genericHttpWrapperModePolicySchema>;
export type ProviderRuntimeModePolicy =
  | CodexProviderModePolicy
  | ClaudeProviderModePolicy
  | OpenCodeProviderModePolicy
  | AgentFieldWrapperModePolicy
  | GenericHttpWrapperModePolicy;
export type ProviderRuntimePolicy = z.infer<typeof providerRuntimePolicySchema>;
export type ProviderResolvedCommand = z.infer<typeof providerResolvedCommandSchema>;
export type ProviderRuntimeFailureCode = z.infer<typeof providerRuntimeFailureCodeSchema>;
