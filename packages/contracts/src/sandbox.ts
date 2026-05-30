import path from "node:path";
import { z } from "zod";
import { isoDateSchema, metadataSchema } from "./ids.js";

export const SANDBOX_FAKE_COMMAND_IDS = [
  "switchyard.fake.echo",
  "switchyard.fake.stderr",
  "switchyard.fake.exit",
  "switchyard.fake.sleep",
  "switchyard.fake.artifact",
  "switchyard.fake.output_flood",
  "switchyard.fake.pty_echo"
] as const;

export const SANDBOX_REAL_COMMAND_DENYLIST = [
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "go",
  "cargo",
  "npm",
  "pnpm",
  "yarn",
  "codex",
  "claude",
  "opencode",
  "git",
  "gh",
  "curl",
  "wget",
  "ssh",
  "scp",
  "browser",
  "web_search",
  "fetch",
  "repo",
  "github",
  "shell"
] as const;

export const SANDBOX_DEFAULT_RESOURCE_LIMITS = {
  wallTimeMs: 30_000,
  stdoutBytes: 65_536,
  stderrBytes: 65_536,
  combinedOutputBytes: 131_072,
  artifactBytes: 1_048_576,
  stdinBytes: 65_536,
  argvCount: 32,
  argvEntryBytes: 256,
  envKeys: 32,
  envValueBytes: 4_096,
  ptyCols: 80,
  ptyRows: 24,
  cpuMs: 1_000,
  memoryMiB: 256
} as const;

export const SANDBOX_MAX_RESOURCE_LIMITS = {
  wallTimeMs: 120_000,
  stdoutBytes: 1_048_576,
  stderrBytes: 1_048_576,
  combinedOutputBytes: 1_048_576,
  artifactBytes: 1_048_576,
  stdinBytes: 65_536,
  argvCount: 32,
  argvEntryBytes: 256,
  envKeys: 32,
  envValueBytes: 4_096,
  ptyCols: 240,
  ptyRows: 80,
  cpuMs: 120_000,
  memoryMiB: 16_384
} as const;

export const sandboxNamedErrorSchema = z.enum([
  "sandbox_disabled",
  "sandbox_config_invalid",
  "sandbox_policy_invalid",
  "sandbox_policy_missing",
  "sandbox_policy_failed",
  "sandbox_request_missing",
  "sandbox_request_invalid",
  "sandbox_resource_limit_invalid",
  "sandbox_stdin_too_large",
  "sandbox_argv_too_large",
  "sandbox_env_too_large",
  "sandbox_pty_invalid",
  "sandbox_command_denied",
  "sandbox_process_failed",
  "sandbox_timeout",
  "sandbox_cancelled",
  "sandbox_cancel_failed",
  "sandbox_job_not_found",
  "sandbox_output_limit_exceeded",
  "sandbox_artifact_too_large",
  "sandbox_artifact_capture_failed",
  "sandbox_redaction_failed",
  "object_store_write_failed",
  "object_store_unavailable",
  "object_store_auth_failed",
  "artifact_digest_mismatch",
  "artifact_content_empty"
]);

export const sandboxAdapterTypeSchema = z.enum(["process", "pty"]);
export const sandboxLifecycleStateSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "timeout"]);
export const sandboxTerminalStateSchema = z.enum(["completed", "failed", "cancelled", "timeout"]);

export const sandboxPtyInputFrameSchema = z.object({
  type: z.literal("input"),
  data: z.string().max(4_096)
});

export const sandboxPtyResizeFrameSchema = z.object({
  type: z.literal("resize"),
  cols: z.number().int().min(20).max(240),
  rows: z.number().int().min(5).max(80)
});

export const sandboxPtyFrameSchema = z.union([sandboxPtyInputFrameSchema, sandboxPtyResizeFrameSchema]);

export const sandboxPtyConfigSchema = z.object({
  cols: z.number().int().min(20).max(240),
  rows: z.number().int().min(5).max(80),
  inputFrames: z.array(sandboxPtyFrameSchema).default([])
});

export const sandboxArtifactPolicySchema = z.object({
  captureTranscript: z.boolean().default(false),
  captureDeniedDecision: z.boolean().default(false)
});

const sandboxCwdSchema = z.string().min(1).refine((value) => {
  if (!path.isAbsolute(value)) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) {
    return false;
  }
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return !segments.includes("..") && !segments.includes(".");
}, "cwd must be an absolute normalized path without traversal segments");

const sandboxResourceLimitNumberSchema = z.number().int().positive();

export const sandboxResourceLimitsInputSchema = z.object({
  wallTimeMs: sandboxResourceLimitNumberSchema.optional(),
  stdoutBytes: sandboxResourceLimitNumberSchema.optional(),
  stderrBytes: sandboxResourceLimitNumberSchema.optional(),
  combinedOutputBytes: sandboxResourceLimitNumberSchema.optional(),
  artifactBytes: sandboxResourceLimitNumberSchema.optional(),
  stdinBytes: sandboxResourceLimitNumberSchema.optional(),
  argvCount: sandboxResourceLimitNumberSchema.optional(),
  argvEntryBytes: sandboxResourceLimitNumberSchema.optional(),
  envKeys: sandboxResourceLimitNumberSchema.optional(),
  envValueBytes: sandboxResourceLimitNumberSchema.optional(),
  ptyCols: sandboxResourceLimitNumberSchema.optional(),
  ptyRows: sandboxResourceLimitNumberSchema.optional(),
  cpuMs: sandboxResourceLimitNumberSchema.optional(),
  memoryMiB: sandboxResourceLimitNumberSchema.optional()
}).default({});

export const sandboxResourceLimitsSchema = z.object({
  wallTimeMs: sandboxResourceLimitNumberSchema,
  stdoutBytes: sandboxResourceLimitNumberSchema,
  stderrBytes: sandboxResourceLimitNumberSchema,
  combinedOutputBytes: sandboxResourceLimitNumberSchema,
  artifactBytes: sandboxResourceLimitNumberSchema,
  stdinBytes: sandboxResourceLimitNumberSchema,
  argvCount: sandboxResourceLimitNumberSchema,
  argvEntryBytes: sandboxResourceLimitNumberSchema,
  envKeys: sandboxResourceLimitNumberSchema,
  envValueBytes: sandboxResourceLimitNumberSchema,
  ptyCols: sandboxResourceLimitNumberSchema,
  ptyRows: sandboxResourceLimitNumberSchema,
  cpuMs: sandboxResourceLimitNumberSchema,
  memoryMiB: sandboxResourceLimitNumberSchema
});

export const sandboxJobRequestSchema = z.object({
  jobId: z.string().min(1),
  runId: z.string().min(1).optional(),
  runtimeMode: z.string().min(1).optional(),
  adapterType: sandboxAdapterTypeSchema,
  commandId: z.string().min(1),
  argv: z.array(z.string()).default([]),
  cwd: sandboxCwdSchema,
  env: z.record(z.string(), z.string()).default({}),
  stdin: z.string().optional(),
  pty: sandboxPtyConfigSchema.optional(),
  resourceLimits: sandboxResourceLimitsInputSchema,
  artifactPolicy: sandboxArtifactPolicySchema.default({ captureTranscript: false, captureDeniedDecision: false }),
  createdAt: isoDateSchema,
  metadata: metadataSchema.optional()
}).superRefine((value, ctx) => {
  if (value.adapterType === "process" && value.pty) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "pty is not allowed when adapterType is process",
      path: ["pty"]
    });
  }
  if (value.adapterType === "pty" && !value.pty) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "pty is required when adapterType is pty",
      path: ["pty"]
    });
  }
  if (value.commandId === "switchyard.fake.pty_echo" && value.adapterType !== "pty") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "switchyard.fake.pty_echo requires adapterType pty",
      path: ["adapterType"]
    });
  }
});

export const sandboxFakeCommandIdSchema = z.enum(SANDBOX_FAKE_COMMAND_IDS);

export const sandboxPolicyDecisionSchema = z.object({
  decision: z.enum(["allow", "deny", "requires_approval"]),
  reasonCode: sandboxNamedErrorSchema.optional(),
  policyTrace: z.array(z.record(z.string(), z.unknown())).default([])
});

export const sandboxLifecycleEventSchema = z.object({
  timestamp: isoDateSchema,
  state: sandboxLifecycleStateSchema,
  event: z.string().min(1),
  stream: z.enum(["stdout", "stderr", "pty", "none"]).default("none"),
  text: z.string().optional(),
  metadata: metadataSchema.default({})
});

export const sandboxCapturedArtifactSchema = z.object({
  path: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  storageBackend: z.enum(["filesystem", "memory", "object"]).optional(),
  objectKey: z.string().min(1).optional(),
  contentStored: z.boolean().default(false),
  truncated: z.boolean().default(false),
  metadata: metadataSchema.default({})
});

export const sandboxJobResultSchema = z.object({
  jobId: z.string().min(1),
  runId: z.string().min(1).optional(),
  adapterType: sandboxAdapterTypeSchema,
  commandId: z.string().min(1),
  status: sandboxTerminalStateSchema,
  reasonCode: sandboxNamedErrorSchema.optional(),
  exitCode: z.number().int().optional(),
  startedAt: isoDateSchema.optional(),
  endedAt: isoDateSchema,
  durationMs: z.number().int().nonnegative(),
  stdoutBytes: z.number().int().nonnegative().default(0),
  stderrBytes: z.number().int().nonnegative().default(0),
  combinedOutputBytes: z.number().int().nonnegative().default(0),
  stdoutTruncated: z.boolean().default(false),
  stderrTruncated: z.boolean().default(false),
  outputLimitExceeded: z.boolean().default(false),
  artifacts: z.array(sandboxCapturedArtifactSchema).default([]),
  transcriptArtifact: sandboxCapturedArtifactSchema.optional(),
  policyDecision: sandboxPolicyDecisionSchema.optional(),
  lifecycle: z.array(sandboxLifecycleEventSchema).default([]),
  metadata: metadataSchema.default({})
});

export type SandboxNamedError = z.infer<typeof sandboxNamedErrorSchema>;
export type SandboxAdapterType = z.infer<typeof sandboxAdapterTypeSchema>;
export type SandboxLifecycleState = z.infer<typeof sandboxLifecycleStateSchema>;
export type SandboxTerminalState = z.infer<typeof sandboxTerminalStateSchema>;
export type SandboxPtyFrame = z.infer<typeof sandboxPtyFrameSchema>;
export type SandboxPtyConfig = z.infer<typeof sandboxPtyConfigSchema>;
export type SandboxArtifactPolicy = z.infer<typeof sandboxArtifactPolicySchema>;
export type SandboxResourceLimitsInput = z.infer<typeof sandboxResourceLimitsInputSchema>;
export type SandboxResourceLimits = z.infer<typeof sandboxResourceLimitsSchema>;
export type SandboxJobRequest = z.infer<typeof sandboxJobRequestSchema>;
export type SandboxPolicyDecision = z.infer<typeof sandboxPolicyDecisionSchema>;
export type SandboxLifecycleEvent = z.infer<typeof sandboxLifecycleEventSchema>;
export type SandboxCapturedArtifact = z.infer<typeof sandboxCapturedArtifactSchema>;
export type SandboxJobResult = z.infer<typeof sandboxJobResultSchema>;
