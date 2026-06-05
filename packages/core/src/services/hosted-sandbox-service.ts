import { createHash } from "node:crypto";
import path from "node:path";
import {
  SANDBOX_DEFAULT_RESOURCE_LIMITS,
  SANDBOX_FAKE_COMMAND_IDS,
  SANDBOX_MAX_RESOURCE_LIMITS,
  SANDBOX_REAL_COMMAND_DENYLIST,
  SANDBOX_REAL_EXECUTABLE_ABSOLUTE_DENYLIST,
  sandboxCommandPolicyEntrySchema,
  sandboxJobRequestSchema,
  sandboxNamedErrorSchema,
  sandboxRealExecutionModeSchema,
  type SandboxCapturedArtifact,
  type SandboxCommandPolicyEntry,
  type SandboxJobRequest,
  type SandboxJobResult,
  type SandboxNamedError,
  type SandboxPolicyDecision,
  type SandboxRealExecutionMode,
  type SandboxResolvedCommand,
  type SandboxResourceLimits,
  type SandboxResourceLimitsInput,
  type SandboxTerminalState
} from "@switchyard/contracts";
import type { ArtifactContentStore, StoredArtifactContent } from "../ports/artifact-content-store.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";
import { redactSecrets } from "./local-policy-gate.js";

export interface HostedSandboxExecutorOutput {
  status: SandboxTerminalState;
  reasonCode?: SandboxNamedError;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  artifacts?: Array<{ path: string; contentType?: string; content: string; metadata?: Record<string, unknown> }>;
  metadata?: Record<string, unknown>;
}

export interface HostedSandboxExecutorPort {
  execute(
    request: SandboxJobRequest & { resourceLimits: SandboxResourceLimits },
    options?: { signal?: AbortSignal; resolvedCommand?: SandboxResolvedCommand }
  ): Promise<HostedSandboxExecutorOutput>;
}

export interface SandboxMetricsSink {
  inc(path: string): void;
}

export interface ResolvedHostedSandboxConfig {
  enabled: boolean;
  valid: boolean;
  errors: string[];
  fakeCommandAllowlist: string[];
  defaultLimits: SandboxResourceLimits;
  maxLimits: SandboxResourceLimits;
  realExecution: {
    mode: SandboxRealExecutionMode;
    commandPolicy: SandboxCommandPolicyEntry[];
    ptyDriverConfigured: boolean;
    redactedSummary: Record<string, unknown>;
  };
  redactedSummary: Record<string, unknown>;
}

export interface HostedSandboxServiceDependencies {
  config: ResolvedHostedSandboxConfig;
  executor: HostedSandboxExecutorPort;
  policy?: HostedSandboxPolicy;
  artifactContent?: ArtifactContentStore;
  artifacts?: ArtifactStore;
  logger?: RuntimeLogger;
  metrics?: SandboxMetricsSink;
  now?: () => string;
}

interface ActiveJob {
  controller: AbortController;
  completion: Promise<SandboxJobResult>;
}

const REAL_COMMAND_DENYLIST = new Set<string>(SANDBOX_REAL_COMMAND_DENYLIST);
const REAL_EXECUTABLE_ABSOLUTE_DENYLIST = new Set<string>(SANDBOX_REAL_EXECUTABLE_ABSOLUTE_DENYLIST);
const FAKE_COMMANDS = new Set<string>(SANDBOX_FAKE_COMMAND_IDS);
const SANDBOX_PLACEHOLDER_PATH_SEGMENT_PATTERN = /(^|[-_.])(example|placeholder|changeme|todo|sample)([-_.]|$)/i;
const SECRET_QUERY_KEY_PATTERN = /(token|signature|secret|password|apikey|access_key|accesskey|refresh_token|id_token)/i;
const SWITCHYARD_SANDBOX_COMMAND_POLICY_MAX_JSON_BYTES = 65_536;
const SWITCHYARD_SANDBOX_COMMAND_POLICY_MAX_ENTRIES = 64;

type HostedSandboxPolicyDecision = SandboxPolicyDecision & { resolvedCommand?: SandboxResolvedCommand };

export class HostedSandboxPolicy {
  private readonly allowlist: Set<string>;
  private readonly realExecution: ResolvedHostedSandboxConfig["realExecution"];
  private readonly commandPolicyById: Map<string, SandboxCommandPolicyEntry>;

  constructor(input: { allowlist: string[]; realExecution?: ResolvedHostedSandboxConfig["realExecution"] }) {
    this.allowlist = new Set(input.allowlist);
    this.realExecution = input.realExecution ?? {
      mode: "disabled",
      commandPolicy: [],
      ptyDriverConfigured: false,
      redactedSummary: {
        mode: "disabled",
        commandPolicyCount: 0,
        ptyDriverConfigured: false
      }
    };
    this.commandPolicyById = new Map(
      this.realExecution.commandPolicy.map((entry) => [entry.commandId, entry] as const)
    );
  }

  decide(input: { request: SandboxJobRequest; limits: SandboxResourceLimits }): HostedSandboxPolicyDecision {
    const commandId = input.request.commandId.trim();
    if (!commandId) {
      return {
        decision: "deny",
        reasonCode: "sandbox_command_denied",
        policyTrace: [{ rule: "command_id_empty" }]
      };
    }
    if (REAL_COMMAND_DENYLIST.has(commandId)) {
      return {
        decision: "deny",
        reasonCode: "sandbox_command_denied",
        policyTrace: [{ rule: "real_command_denied", commandId }]
      };
    }

    if (FAKE_COMMANDS.has(commandId)) {
      if (!this.allowlist.has(commandId)) {
        return {
          decision: "deny",
          reasonCode: "sandbox_command_denied",
          policyTrace: [{ rule: "allowlist_denied", commandId }]
        };
      }
      return {
        decision: "allow",
        policyTrace: [{ rule: "fake_command_allowed", commandId }]
      };
    }

    if (this.realExecution.mode !== "enabled") {
      return {
        decision: "deny",
        reasonCode: "sandbox_real_execution_disabled",
        policyTrace: [{ rule: "real_execution_disabled", commandId }]
      };
    }

    const policy = this.commandPolicyById.get(commandId);
    if (!policy) {
      return {
        decision: "deny",
        reasonCode: "sandbox_command_denied",
        policyTrace: [{ rule: "policy_entry_missing", commandId }]
      };
    }

    if (input.request.adapterType !== policy.adapterType) {
      return {
        decision: "deny",
        reasonCode: "sandbox_command_denied",
        policyTrace: [{ rule: "adapter_type_denied", commandId }]
      };
    }

    if (policy.adapterType === "pty" && !this.realExecution.ptyDriverConfigured) {
      return {
        decision: "deny",
        reasonCode: "sandbox_pty_unavailable",
        policyTrace: [{ rule: "pty_driver_unavailable", commandId }]
      };
    }

    if (!isPathAllowedByPrefixes(input.request.cwd, policy.cwdPrefixes)) {
      return {
        decision: "deny",
        reasonCode: "sandbox_cwd_denied",
        policyTrace: [{ rule: "cwd_denied", commandId }]
      };
    }

    const envAllowlist = new Set(policy.envAllowlist);
    for (const key of Object.keys(input.request.env)) {
      if (!envAllowlist.has(key)) {
        return {
          decision: "deny",
          reasonCode: "sandbox_env_denied",
          policyTrace: [{ rule: "env_denied", commandId, key }]
        };
      }
    }

    if (input.request.stdin !== undefined && input.request.stdin.length > 0 && !policy.allowStdin) {
      return {
        decision: "deny",
        reasonCode: "sandbox_command_denied",
        policyTrace: [{ rule: "stdin_denied", commandId }]
      };
    }

    if (policy.adapterType === "pty" && input.request.pty) {
      const hasPtyInput = input.request.pty.inputFrames.some((frame) => frame.type === "input" && frame.data.length > 0);
      if (hasPtyInput && !policy.allowPtyInput) {
        return {
          decision: "deny",
          reasonCode: "sandbox_command_denied",
          policyTrace: [{ rule: "pty_input_denied", commandId }]
        };
      }
    }

    const argv = [...policy.fixedArgs];
    if (policy.allowUserArgs) {
      argv.push(...input.request.argv);
    } else if (input.request.argv.length > 0) {
      return {
        decision: "deny",
        reasonCode: "sandbox_command_denied",
        policyTrace: [{ rule: "argv_denied", commandId }]
      };
    }

    const resolvedCommand: SandboxResolvedCommand = {
      commandId: policy.commandId,
      adapterType: policy.adapterType,
      executablePath: policy.executablePath,
      argv,
      cwd: input.request.cwd,
      env: { ...input.request.env },
      allowStdin: policy.allowStdin,
      allowPtyInput: policy.allowPtyInput,
      isolation: policy.isolation,
      networkPolicy: policy.networkPolicy
    };

    return {
      decision: "allow",
      policyTrace: [{ rule: "real_policy_allowed", commandId }],
      resolvedCommand
    };
  }
}

export class HostedSandboxService {
  private readonly policy: HostedSandboxPolicy;
  private readonly now: () => string;
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly terminalResults = new Map<string, SandboxJobResult>();

  constructor(private readonly deps: HostedSandboxServiceDependencies) {
    this.policy = deps.policy ?? new HostedSandboxPolicy({
      allowlist: deps.config.fakeCommandAllowlist,
      realExecution: deps.config.realExecution
    });
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async execute(request: unknown, options?: { signal?: AbortSignal }): Promise<SandboxJobResult> {
    if (!this.deps.config.enabled) {
      return this.failClosedResult("sandbox_disabled", request);
    }
    if (!request) {
      return this.failClosedResult("sandbox_request_missing", request);
    }

    const parsed = sandboxJobRequestSchema.safeParse(request);
    if (!parsed.success) {
      return this.failClosedResult("sandbox_request_invalid", request, {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code }))
      });
    }

    const input = parsed.data;
    const limits = this.resolveAndValidateLimits(input.resourceLimits);
    if (!limits.ok) {
      return this.terminalFromRequest(input, "failed", limits.reasonCode);
    }

    const requestValidationReason = validateRequestPayload(input, limits.value);
    if (requestValidationReason) {
      return this.terminalFromRequest(input, "failed", requestValidationReason);
    }

    let decision: HostedSandboxPolicyDecision;
    try {
      decision = this.policy.decide({ request: input, limits: limits.value });
    } catch {
      this.deps.metrics?.inc("sandbox.failed");
      return this.terminalFromRequest(input, "failed", "sandbox_policy_failed");
    }

    if (decision.decision !== "allow") {
      this.deps.metrics?.inc("sandbox.denied");
      const denied = this.terminalFromRequest(input, "failed", decision.reasonCode ?? "sandbox_command_denied", {
        policyDecision: decision,
        metadata: { policyTrace: redactSandboxValue(decision.policyTrace) }
      });
      if (input.artifactPolicy.captureDeniedDecision) {
        return this.captureTranscript(input, denied, {
          policyDecision: decision,
          stdoutText: "",
          stderrText: ""
        });
      }
      return denied;
    }

    this.deps.metrics?.inc("sandbox.jobs");
    this.deps.metrics?.inc("sandbox.allowed");
    this.deps.logger?.info("sandbox.job.started", {
      jobId: input.jobId,
      runId: input.runId,
      runtimeMode: input.runtimeMode,
      adapterType: input.adapterType,
      commandId: input.commandId
    });

    const controller = new AbortController();
    if (options?.signal?.aborted) {
      controller.abort(options.signal.reason);
    } else if (options?.signal) {
      options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("sandbox_timeout"));
    }, limits.value.wallTimeMs);

    const startedAt = this.now();
    if (controller.signal.aborted) {
      clearTimeout(timeout);
      return this.terminalFromRequest(input, "cancelled", "sandbox_cancelled", { startedAt });
    }

    const completion = this.dispatchExecution(input, limits.value, decision, startedAt, controller.signal, () => timedOut);
    this.activeJobs.set(input.jobId, { controller, completion });

    try {
      const result = await completion;
      return result;
    } finally {
      clearTimeout(timeout);
      this.activeJobs.delete(input.jobId);
    }
  }

  async cancel(jobId: string): Promise<SandboxJobResult> {
    const existing = this.terminalResults.get(jobId);
    if (existing) {
      return existing;
    }

    const active = this.activeJobs.get(jobId);
    if (!active) {
      return {
        jobId,
        adapterType: "process",
        commandId: "switchyard.fake.echo",
        status: "failed",
        reasonCode: "sandbox_job_not_found",
        endedAt: this.now(),
        durationMs: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        combinedOutputBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        outputLimitExceeded: false,
        artifacts: [],
        lifecycle: [],
        metadata: {}
      };
    }

    try {
      active.controller.abort(new Error("sandbox_cancelled"));
      const result = await active.completion;
      return result.status === "cancelled"
        ? result
        : {
            ...result,
            status: "cancelled",
            reasonCode: "sandbox_cancelled"
          };
    } catch {
      const failed: SandboxJobResult = {
        jobId,
        adapterType: "process",
        commandId: "switchyard.fake.echo",
        status: "failed",
        reasonCode: "sandbox_cancel_failed",
        endedAt: this.now(),
        durationMs: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        combinedOutputBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        outputLimitExceeded: false,
        artifacts: [] as SandboxCapturedArtifact[],
        lifecycle: [],
        metadata: {}
      };
      this.terminalResults.set(jobId, failed);
      this.activeJobs.delete(jobId);
      return failed;
    }
  }

  private async dispatchExecution(
    request: SandboxJobRequest,
    limits: SandboxResourceLimits,
    decision: HostedSandboxPolicyDecision,
    startedAt: string,
    signal: AbortSignal,
    timedOut: () => boolean
  ): Promise<SandboxJobResult> {
    try {
      const executeOptions = decision.resolvedCommand
        ? { signal, resolvedCommand: decision.resolvedCommand }
        : { signal };
      const raw = await this.deps.executor.execute(
        {
          ...request,
          resourceLimits: limits
        },
        executeOptions
      );

      const transformed = await this.transformExecutorOutput(request, raw, startedAt, decision, limits);
      const final = await this.captureTranscript(request, transformed, {
        policyDecision: decision,
        stdoutText: raw.stdout ?? "",
        stderrText: raw.stderr ?? ""
      });
      this.terminalResults.set(request.jobId, final);
      this.countTerminalMetrics(final);
      return final;
    } catch (error) {
      if (timedOut()) {
        const timeoutResult = this.terminalFromRequest(request, "timeout", "sandbox_timeout", { startedAt, policyDecision: decision });
        const final = await this.captureTranscript(request, timeoutResult, {
          policyDecision: decision,
          stdoutText: "",
          stderrText: ""
        });
        this.terminalResults.set(request.jobId, final);
        this.countTerminalMetrics(final);
        return final;
      }
      if (signal.aborted) {
        const cancelled = this.terminalFromRequest(request, "cancelled", "sandbox_cancelled", { startedAt, policyDecision: decision });
        const final = await this.captureTranscript(request, cancelled, {
          policyDecision: decision,
          stdoutText: "",
          stderrText: ""
        });
        this.terminalResults.set(request.jobId, final);
        this.countTerminalMetrics(final);
        return final;
      }
      const failed = this.terminalFromRequest(request, "failed", "sandbox_process_failed", {
        startedAt,
        policyDecision: decision,
        metadata: { error: redactSandboxValue(errorPayload(error)) }
      });
      const final = await this.captureTranscript(request, failed, {
        policyDecision: decision,
        stdoutText: "",
        stderrText: ""
      });
      this.terminalResults.set(request.jobId, final);
      this.countTerminalMetrics(final);
      return final;
    }
  }

  private async transformExecutorOutput(
    request: SandboxJobRequest,
    output: HostedSandboxExecutorOutput,
    startedAt: string,
    policyDecision: HostedSandboxPolicyDecision,
    limits: SandboxResourceLimits
  ): Promise<SandboxJobResult> {
    const stdout = redactSandboxString(output.stdout ?? "");
    const stderr = redactSandboxString(output.stderr ?? "");
    const stdoutBytesTotal = Buffer.byteLength(stdout, "utf8");
    const stderrBytesTotal = Buffer.byteLength(stderr, "utf8");

    const stdoutBytes = Math.min(stdoutBytesTotal, limits.stdoutBytes);
    const stderrBytes = Math.min(stderrBytesTotal, limits.stderrBytes);
    const stdoutTruncated = stdoutBytesTotal > limits.stdoutBytes;
    const stderrTruncated = stderrBytesTotal > limits.stderrBytes;

    const combinedOutputBytes = stdoutBytes + stderrBytes;
    const outputLimitExceeded = combinedOutputBytes > limits.combinedOutputBytes;
    if (stdoutTruncated || stderrTruncated) {
      this.deps.metrics?.inc("sandbox.outputTruncated");
      this.deps.logger?.warn("sandbox.job.output_truncated", {
        jobId: request.jobId,
        stdoutBytes,
        stderrBytes,
        stdoutTruncated,
        stderrTruncated
      });
    }

    const endedAt = this.now();
    const durationMs = toDurationMs(startedAt, endedAt);

    if (outputLimitExceeded) {
      return {
        ...this.terminalFromRequest(request, "failed", "sandbox_output_limit_exceeded", {
          startedAt,
          endedAt,
          durationMs,
          policyDecision,
          stdoutBytes,
          stderrBytes,
          combinedOutputBytes,
          stdoutTruncated,
          stderrTruncated,
          outputLimitExceeded
        }),
        metadata: {
          outputSummary: {
            stdoutBytes,
            stderrBytes,
            combinedOutputBytes,
            stdoutTruncated,
            stderrTruncated
          }
        }
      };
    }

    const capturedArtifacts: SandboxCapturedArtifact[] = [];
    for (const artifact of output.artifacts ?? []) {
      const sizeBytes = Buffer.byteLength(artifact.content, "utf8");
      if (sizeBytes > limits.artifactBytes) {
        this.deps.metrics?.inc("sandbox.artifactTruncated");
        return this.terminalFromRequest(request, "failed", "sandbox_artifact_too_large", {
          startedAt,
          endedAt,
          durationMs,
          policyDecision,
          stdoutBytes,
          stderrBytes,
          combinedOutputBytes,
          stdoutTruncated,
          stderrTruncated,
          outputLimitExceeded,
          metadata: {
            artifactPath: artifact.path,
            artifactBytes: sizeBytes,
            artifactLimitBytes: limits.artifactBytes
          }
        });
      }

      const digest = createHash("sha256").update(artifact.content).digest("hex");
      capturedArtifacts.push({
        path: artifact.path,
        contentType: artifact.contentType ?? "text/plain",
        sizeBytes,
        sha256: digest,
        contentStored: false,
        truncated: false,
        metadata: redactSandboxValue(artifact.metadata ?? {})
      });
    }

    const status = output.status;
    const reasonCode = sandboxNamedErrorSchema.safeParse(output.reasonCode).success
      ? output.reasonCode
      : status === "failed"
        ? "sandbox_process_failed"
        : status === "cancelled"
          ? "sandbox_cancelled"
          : status === "timeout"
            ? "sandbox_timeout"
            : undefined;

    return {
      jobId: request.jobId,
      runId: request.runId,
      adapterType: request.adapterType,
      commandId: request.commandId,
      status,
      reasonCode,
      exitCode: output.exitCode,
      startedAt,
      endedAt,
      durationMs,
      stdoutBytes,
      stderrBytes,
      combinedOutputBytes,
      stdoutTruncated,
      stderrTruncated,
      outputLimitExceeded,
      artifacts: capturedArtifacts,
      policyDecision,
      lifecycle: [
        {
          timestamp: startedAt,
          state: "running",
          event: "sandbox.job.started",
          stream: "none",
          metadata: {}
        },
        {
          timestamp: endedAt,
          state: status,
          event: `sandbox.job.${status}`,
          stream: "none",
          metadata: {}
        }
      ],
      metadata: redactSandboxValue(output.metadata ?? {})
    };
  }

  private async captureTranscript(
    request: SandboxJobRequest,
    result: SandboxJobResult,
    input: { policyDecision: SandboxPolicyDecision; stdoutText: string; stderrText: string }
  ): Promise<SandboxJobResult> {
    if (!request.artifactPolicy.captureTranscript) {
      return result;
    }

    const transcriptRecords = [
      {
        event: "policy",
        payload: redactSandboxValue(input.policyDecision)
      },
      {
        event: "stdout",
        payload: redactSandboxString(input.stdoutText)
      },
      {
        event: "stderr",
        payload: redactSandboxString(input.stderrText)
      },
      {
        event: "result",
        payload: redactSandboxValue({
          status: result.status,
          reasonCode: result.reasonCode,
          exitCode: result.exitCode,
          output: {
            stdoutBytes: result.stdoutBytes,
            stderrBytes: result.stderrBytes,
            combinedOutputBytes: result.combinedOutputBytes,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            outputLimitExceeded: result.outputLimitExceeded
          }
        })
      }
    ];

    const transcript = `${transcriptRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const path = `sandbox/${request.jobId}/transcript.jsonl`;

    if (!this.deps.artifactContent) {
      return {
        ...result,
        transcriptArtifact: {
          path,
          contentType: "application/x-ndjson",
          sizeBytes: Buffer.byteLength(transcript, "utf8"),
          sha256: createHash("sha256").update(transcript).digest("hex"),
          contentStored: false,
          truncated: false,
          metadata: {}
        }
      };
    }

    try {
      const stored = await this.deps.artifactContent.writeText(path, transcript, { contentType: "application/x-ndjson" });
      const transcriptArtifact = storedArtifactToCapturedArtifact(stored, true);

      if (this.deps.artifacts) {
        await this.deps.artifacts.create({
          id: `artifact_${crypto.randomUUID()}`,
          runId: request.runId,
          type: "transcript",
          path: stored.path,
          metadata: {
            sandboxJobId: request.jobId,
            commandId: request.commandId,
            storageBackend: stored.storageBackend,
            objectKey: stored.objectKey,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            contentType: stored.contentType
          },
          createdAt: this.now()
        });
      }

      return {
        ...result,
        transcriptArtifact
      };
    } catch (error) {
      this.deps.logger?.warn("sandbox.job.artifact_capture_failed", {
        jobId: request.jobId,
        reasonCode: error instanceof Error ? error.message : "sandbox_artifact_capture_failed"
      });
      return {
        ...result,
        status: "failed",
        reasonCode: sandboxNamedErrorSchema.safeParse(error instanceof Error ? error.message : "").success
          ? (error as Error).message as SandboxNamedError
          : "sandbox_artifact_capture_failed"
      };
    }
  }

  private terminalFromRequest(
    request: Pick<SandboxJobRequest, "jobId" | "runId" | "adapterType" | "commandId">,
    status: SandboxTerminalState,
    reasonCode: SandboxNamedError,
    overrides?: Partial<SandboxJobResult>
  ): SandboxJobResult {
    const endedAt = overrides?.endedAt ?? this.now();
    const startedAt = overrides?.startedAt;
    const durationMs = overrides?.durationMs ?? (startedAt ? toDurationMs(startedAt, endedAt) : 0);
    return {
      jobId: request.jobId,
      runId: request.runId,
      adapterType: request.adapterType,
      commandId: request.commandId,
      status,
      reasonCode,
      startedAt,
      endedAt,
      durationMs,
      stdoutBytes: overrides?.stdoutBytes ?? 0,
      stderrBytes: overrides?.stderrBytes ?? 0,
      combinedOutputBytes: overrides?.combinedOutputBytes ?? 0,
      stdoutTruncated: overrides?.stdoutTruncated ?? false,
      stderrTruncated: overrides?.stderrTruncated ?? false,
      outputLimitExceeded: overrides?.outputLimitExceeded ?? false,
      artifacts: overrides?.artifacts ?? [],
      transcriptArtifact: overrides?.transcriptArtifact,
      policyDecision: overrides?.policyDecision,
      lifecycle: overrides?.lifecycle ?? [],
      metadata: overrides?.metadata ?? {}
    };
  }

  private failClosedResult(reasonCode: SandboxNamedError, request: unknown, metadata?: Record<string, unknown>): SandboxJobResult {
    this.deps.metrics?.inc("sandbox.failed");
    return {
      jobId: asFallbackJobId(request),
      adapterType: "process",
      commandId: "switchyard.fake.echo",
      status: "failed",
      reasonCode,
      endedAt: this.now(),
      durationMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      combinedOutputBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      outputLimitExceeded: false,
      artifacts: [],
      lifecycle: [],
      metadata: redactSandboxValue(metadata ?? {})
    };
  }

  private resolveAndValidateLimits(input: SandboxResourceLimitsInput):
  | { ok: true; value: SandboxResourceLimits }
  | { ok: false; reasonCode: SandboxNamedError } {
    const limits: SandboxResourceLimits = {
      wallTimeMs: input.wallTimeMs ?? this.deps.config.defaultLimits.wallTimeMs,
      stdoutBytes: input.stdoutBytes ?? this.deps.config.defaultLimits.stdoutBytes,
      stderrBytes: input.stderrBytes ?? this.deps.config.defaultLimits.stderrBytes,
      combinedOutputBytes: input.combinedOutputBytes ?? this.deps.config.defaultLimits.combinedOutputBytes,
      artifactBytes: input.artifactBytes ?? this.deps.config.defaultLimits.artifactBytes,
      stdinBytes: input.stdinBytes ?? this.deps.config.defaultLimits.stdinBytes,
      argvCount: input.argvCount ?? this.deps.config.defaultLimits.argvCount,
      argvEntryBytes: input.argvEntryBytes ?? this.deps.config.defaultLimits.argvEntryBytes,
      envKeys: input.envKeys ?? this.deps.config.defaultLimits.envKeys,
      envValueBytes: input.envValueBytes ?? this.deps.config.defaultLimits.envValueBytes,
      ptyCols: input.ptyCols ?? this.deps.config.defaultLimits.ptyCols,
      ptyRows: input.ptyRows ?? this.deps.config.defaultLimits.ptyRows,
      cpuMs: input.cpuMs ?? this.deps.config.defaultLimits.cpuMs,
      memoryMiB: input.memoryMiB ?? this.deps.config.defaultLimits.memoryMiB
    };

    const entries = Object.entries(limits) as Array<[keyof SandboxResourceLimits, number]>;
    for (const [key, value] of entries) {
      const max = this.deps.config.maxLimits[key];
      if (!Number.isFinite(value) || value <= 0 || value > max) {
        return { ok: false, reasonCode: "sandbox_resource_limit_invalid" };
      }
    }

    if (limits.combinedOutputBytes < limits.stdoutBytes || limits.combinedOutputBytes < limits.stderrBytes) {
      return { ok: false, reasonCode: "sandbox_resource_limit_invalid" };
    }

    return { ok: true, value: limits };
  }

  private countTerminalMetrics(result: SandboxJobResult): void {
    if (result.status === "completed") {
      this.deps.metrics?.inc("sandbox.completed");
    } else if (result.status === "failed") {
      this.deps.metrics?.inc("sandbox.failed");
    } else if (result.status === "timeout") {
      this.deps.metrics?.inc("sandbox.timeout");
    } else if (result.status === "cancelled") {
      this.deps.metrics?.inc("sandbox.cancelled");
    }
  }
}

export function checkHostedSandboxReadiness(config: ResolvedHostedSandboxConfig): { ok: boolean; code?: SandboxNamedError } {
  if (!config.enabled) {
    return { ok: false, code: "sandbox_disabled" };
  }
  if (!config.valid) {
    const readinessError = config.errors.find((entry) => sandboxNamedErrorSchema.safeParse(entry).success);
    if (readinessError) {
      return { ok: false, code: readinessError as SandboxNamedError };
    }
    return { ok: false, code: "sandbox_config_invalid" };
  }
  if (config.fakeCommandAllowlist.length === 0) {
    return { ok: false, code: "sandbox_policy_invalid" };
  }
  if (config.fakeCommandAllowlist.some((commandId) => !FAKE_COMMANDS.has(commandId))) {
    return { ok: false, code: "sandbox_policy_invalid" };
  }
  if (config.realExecution.mode === "enabled" && config.realExecution.commandPolicy.length === 0) {
    return { ok: false, code: "sandbox_policy_missing" };
  }
  return { ok: true };
}

export function resolveHostedSandboxConfig(input: { env?: NodeJS.ProcessEnv; deploymentMode: "local" | "test" | "staging" | "production" }): ResolvedHostedSandboxConfig {
  const env = input.env ?? process.env;
  const errors: string[] = [];
  const enabled = parseBooleanEnv(env["SWITCHYARD_SANDBOX_ENABLED"], true);
  const parsedRealExecutionMode = sandboxRealExecutionModeSchema.safeParse(env["SWITCHYARD_SANDBOX_REAL_EXECUTION"]?.trim() ?? "disabled");
  const realExecutionMode: SandboxRealExecutionMode = parsedRealExecutionMode.success
    ? parsedRealExecutionMode.data
    : "disabled";
  if (!parsedRealExecutionMode.success) {
    errors.push("sandbox_config_invalid");
  }
  const ptyDriverConfigured = parseBooleanEnv(env["SWITCHYARD_SANDBOX_PTY_DRIVER_CONFIGURED"], false);

  const allowlist = parseCsvEnv(
    env["SWITCHYARD_SANDBOX_FAKE_COMMAND_ALLOWLIST"],
    [...SANDBOX_FAKE_COMMAND_IDS]
  );

  const defaultLimits: SandboxResourceLimits = {
    wallTimeMs: parseLimitEnv(env["SWITCHYARD_SANDBOX_WALL_TIME_MS"], SANDBOX_DEFAULT_RESOURCE_LIMITS.wallTimeMs, SANDBOX_MAX_RESOURCE_LIMITS.wallTimeMs, errors, "SWITCHYARD_SANDBOX_WALL_TIME_MS"),
    stdoutBytes: parseLimitEnv(env["SWITCHYARD_SANDBOX_STDOUT_BYTES"], SANDBOX_DEFAULT_RESOURCE_LIMITS.stdoutBytes, SANDBOX_MAX_RESOURCE_LIMITS.stdoutBytes, errors, "SWITCHYARD_SANDBOX_STDOUT_BYTES"),
    stderrBytes: parseLimitEnv(env["SWITCHYARD_SANDBOX_STDERR_BYTES"], SANDBOX_DEFAULT_RESOURCE_LIMITS.stderrBytes, SANDBOX_MAX_RESOURCE_LIMITS.stderrBytes, errors, "SWITCHYARD_SANDBOX_STDERR_BYTES"),
    combinedOutputBytes: parseLimitEnv(env["SWITCHYARD_SANDBOX_COMBINED_OUTPUT_BYTES"], SANDBOX_DEFAULT_RESOURCE_LIMITS.combinedOutputBytes, SANDBOX_MAX_RESOURCE_LIMITS.combinedOutputBytes, errors, "SWITCHYARD_SANDBOX_COMBINED_OUTPUT_BYTES"),
    artifactBytes: parseLimitEnv(env["SWITCHYARD_SANDBOX_ARTIFACT_BYTES"], SANDBOX_DEFAULT_RESOURCE_LIMITS.artifactBytes, SANDBOX_MAX_RESOURCE_LIMITS.artifactBytes, errors, "SWITCHYARD_SANDBOX_ARTIFACT_BYTES"),
    stdinBytes: parseLimitEnv(env["SWITCHYARD_SANDBOX_STDIN_BYTES"], SANDBOX_DEFAULT_RESOURCE_LIMITS.stdinBytes, SANDBOX_MAX_RESOURCE_LIMITS.stdinBytes, errors, "SWITCHYARD_SANDBOX_STDIN_BYTES"),
    argvCount: parseLimitEnv(env["SWITCHYARD_SANDBOX_ARGV_COUNT"], SANDBOX_DEFAULT_RESOURCE_LIMITS.argvCount, SANDBOX_MAX_RESOURCE_LIMITS.argvCount, errors, "SWITCHYARD_SANDBOX_ARGV_COUNT"),
    argvEntryBytes: parseLimitEnv(env["SWITCHYARD_SANDBOX_ARGV_ENTRY_BYTES"], SANDBOX_DEFAULT_RESOURCE_LIMITS.argvEntryBytes, SANDBOX_MAX_RESOURCE_LIMITS.argvEntryBytes, errors, "SWITCHYARD_SANDBOX_ARGV_ENTRY_BYTES"),
    envKeys: parseLimitEnv(env["SWITCHYARD_SANDBOX_ENV_KEYS"], SANDBOX_DEFAULT_RESOURCE_LIMITS.envKeys, SANDBOX_MAX_RESOURCE_LIMITS.envKeys, errors, "SWITCHYARD_SANDBOX_ENV_KEYS"),
    envValueBytes: parseLimitEnv(env["SWITCHYARD_SANDBOX_ENV_VALUE_BYTES"], SANDBOX_DEFAULT_RESOURCE_LIMITS.envValueBytes, SANDBOX_MAX_RESOURCE_LIMITS.envValueBytes, errors, "SWITCHYARD_SANDBOX_ENV_VALUE_BYTES"),
    ptyCols: parseLimitEnv(env["SWITCHYARD_SANDBOX_PTY_COLS"], SANDBOX_DEFAULT_RESOURCE_LIMITS.ptyCols, SANDBOX_MAX_RESOURCE_LIMITS.ptyCols, errors, "SWITCHYARD_SANDBOX_PTY_COLS"),
    ptyRows: parseLimitEnv(env["SWITCHYARD_SANDBOX_PTY_ROWS"], SANDBOX_DEFAULT_RESOURCE_LIMITS.ptyRows, SANDBOX_MAX_RESOURCE_LIMITS.ptyRows, errors, "SWITCHYARD_SANDBOX_PTY_ROWS"),
    cpuMs: parseLimitEnv(env["SWITCHYARD_SANDBOX_CPU_MS"], SANDBOX_DEFAULT_RESOURCE_LIMITS.cpuMs, SANDBOX_MAX_RESOURCE_LIMITS.cpuMs, errors, "SWITCHYARD_SANDBOX_CPU_MS"),
    memoryMiB: parseLimitEnv(env["SWITCHYARD_SANDBOX_MEMORY_MIB"], SANDBOX_DEFAULT_RESOURCE_LIMITS.memoryMiB, SANDBOX_MAX_RESOURCE_LIMITS.memoryMiB, errors, "SWITCHYARD_SANDBOX_MEMORY_MIB")
  };

  const policyResolution = resolveCommandPolicyFromEnv({
    mode: realExecutionMode,
    env,
    ptyDriverConfigured
  });
  errors.push(...policyResolution.errors);

  const valid = errors.length === 0;
  const config: ResolvedHostedSandboxConfig = {
    enabled,
    valid,
    errors,
    fakeCommandAllowlist: allowlist,
    defaultLimits,
    maxLimits: { ...SANDBOX_MAX_RESOURCE_LIMITS },
    realExecution: {
      mode: realExecutionMode,
      commandPolicy: policyResolution.commandPolicy,
      ptyDriverConfigured,
      redactedSummary: policyResolution.redactedSummary
    },
    redactedSummary: {
      deploymentMode: input.deploymentMode,
      enabled,
      valid,
      errors,
      fakeCommandAllowlist: allowlist,
      defaultLimits,
      maxLimits: SANDBOX_MAX_RESOURCE_LIMITS,
      realExecution: {
        mode: realExecutionMode,
        commandPolicyCount: policyResolution.commandPolicy.length,
        ptyDriverConfigured,
        redactedSummary: policyResolution.redactedSummary
      }
    }
  };

  return config;
}

export function redactSandboxValue<T>(value: T): T {
  const redacted = redactSecrets(value);
  return redactStringLike(redacted) as T;
}

function redactStringLike(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSandboxString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactStringLike(entry));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = redactStringLike(entry);
    }
    return out;
  }
  return value;
}

function redactSandboxString(value: string): string {
  let out = value.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  out = out.replace(/(token|secret|password|apikey|accesskey|refreshToken|idToken)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  out = out.replace(/https?:\/\/[^\s]+/g, (urlLike) => redactUrl(urlLike));
  return out;
}

function redactUrl(urlLike: string): string {
  try {
    const parsed = new URL(urlLike);
    if (parsed.username || parsed.password) {
      parsed.username = "[REDACTED]";
      parsed.password = "[REDACTED]";
    }
    for (const [key] of parsed.searchParams.entries()) {
      if (SECRET_QUERY_KEY_PATTERN.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return parsed.toString();
  } catch {
    return urlLike;
  }
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function parseCsvEnv(value: string | undefined, fallback: string[]): string[] {
  const source = value?.trim();
  if (!source) {
    return fallback;
  }
  return source.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseLimitEnv(
  value: string | undefined,
  fallback: number,
  max: number,
  errors: string[],
  variable: string
): number {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    errors.push("sandbox_config_invalid");
    return fallback;
  }
  return parsed;
}

function isPathAllowedByPrefixes(cwd: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => cwd === prefix || cwd.startsWith(`${prefix}/`));
}

function validateExecutableCandidate(candidate: unknown): "ok" | "denied" | "unknown" {
  if (!candidate || typeof candidate !== "object") {
    return "unknown";
  }
  const rawExecutablePath = (candidate as Record<string, unknown>)["executablePath"];
  if (typeof rawExecutablePath !== "string") {
    return "unknown";
  }
  const trimmed = rawExecutablePath.trim();
  if (!trimmed) {
    return "denied";
  }

  const basename = path.posix.basename(trimmed).toLowerCase();
  if (REAL_COMMAND_DENYLIST.has(basename)) {
    return "denied";
  }

  if (!path.posix.isAbsolute(trimmed)) {
    return "unknown";
  }

  const normalized = path.posix.normalize(trimmed);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => SANDBOX_PLACEHOLDER_PATH_SEGMENT_PATTERN.test(segment))) {
    return "denied";
  }

  if (REAL_EXECUTABLE_ABSOLUTE_DENYLIST.has(normalized)) {
    return "denied";
  }

  return "ok";
}

function isIsolationDriverConfigured(driver: SandboxCommandPolicyEntry["isolation"]["driver"], ptyDriverConfigured: boolean): boolean {
  if (driver === "none") {
    return true;
  }
  if (driver === "external") {
    return ptyDriverConfigured;
  }
  return false;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveCommandPolicyFromEnv(input: {
  mode: SandboxRealExecutionMode;
  env: NodeJS.ProcessEnv;
  ptyDriverConfigured: boolean;
}): { commandPolicy: SandboxCommandPolicyEntry[]; errors: string[]; redactedSummary: Record<string, unknown> } {
  if (input.mode !== "enabled") {
    return {
      commandPolicy: [],
      errors: [],
      redactedSummary: {
        mode: input.mode,
        commandPolicyCount: 0,
        ptyDriverConfigured: input.ptyDriverConfigured
      }
    };
  }

  const errors: string[] = [];
  const diagnostics: Record<string, unknown> = {};
  const rawPolicy = input.env["SWITCHYARD_SANDBOX_COMMAND_POLICY_JSON"]?.trim();
  if (!rawPolicy) {
    errors.push("sandbox_policy_missing");
    diagnostics.code = "policy_missing";
    return {
      commandPolicy: [],
      errors,
      redactedSummary: {
        mode: input.mode,
        commandPolicyCount: 0,
        ptyDriverConfigured: input.ptyDriverConfigured,
        diagnostics
      }
    };
  }

  const policyJsonBytes = Buffer.byteLength(rawPolicy, "utf8");
  diagnostics.policyJsonBytes = policyJsonBytes;
  diagnostics.maxPolicyJsonBytes = SWITCHYARD_SANDBOX_COMMAND_POLICY_MAX_JSON_BYTES;
  if (policyJsonBytes > SWITCHYARD_SANDBOX_COMMAND_POLICY_MAX_JSON_BYTES) {
    errors.push("sandbox_policy_invalid");
    diagnostics.code = "policy_too_large";
    return {
      commandPolicy: [],
      errors,
      redactedSummary: {
        mode: input.mode,
        commandPolicyCount: 0,
        ptyDriverConfigured: input.ptyDriverConfigured,
        diagnostics
      }
    };
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(rawPolicy);
  } catch {
    errors.push("sandbox_policy_invalid");
    diagnostics.code = "policy_json_parse_failed";
    return {
      commandPolicy: [],
      errors,
      redactedSummary: {
        mode: input.mode,
        commandPolicyCount: 0,
        ptyDriverConfigured: input.ptyDriverConfigured,
        diagnostics
      }
    };
  }

  if (!Array.isArray(parsedRaw)) {
    errors.push("sandbox_policy_invalid");
    diagnostics.code = "policy_not_array";
    return {
      commandPolicy: [],
      errors,
      redactedSummary: {
        mode: input.mode,
        commandPolicyCount: 0,
        ptyDriverConfigured: input.ptyDriverConfigured,
        diagnostics
      }
    };
  }

  diagnostics.entryCount = parsedRaw.length;
  diagnostics.maxEntries = SWITCHYARD_SANDBOX_COMMAND_POLICY_MAX_ENTRIES;
  if (parsedRaw.length > SWITCHYARD_SANDBOX_COMMAND_POLICY_MAX_ENTRIES) {
    errors.push("sandbox_policy_invalid");
    diagnostics.code = "policy_too_many_entries";
    return {
      commandPolicy: [],
      errors,
      redactedSummary: {
        mode: input.mode,
        commandPolicyCount: 0,
        ptyDriverConfigured: input.ptyDriverConfigured,
        diagnostics
      }
    };
  }

  if (parsedRaw.length === 0) {
    errors.push("sandbox_policy_missing");
    diagnostics.code = "policy_empty";
    return {
      commandPolicy: [],
      errors,
      redactedSummary: {
        mode: input.mode,
        commandPolicyCount: 0,
        ptyDriverConfigured: input.ptyDriverConfigured,
        diagnostics
      }
    };
  }

  const commandPolicy: SandboxCommandPolicyEntry[] = [];
  const seenCommandIds = new Set<string>();
  const parseIssueSummary: Array<{ index: number; code: string; path: string }> = [];

  for (let index = 0; index < parsedRaw.length; index += 1) {
    const candidate = parsedRaw[index];
    const executableValidation = validateExecutableCandidate(candidate);
    if (executableValidation === "denied") {
      errors.push("sandbox_executable_denied");
      continue;
    }

    const parsedEntry = sandboxCommandPolicyEntrySchema.safeParse(candidate);
    if (!parsedEntry.success) {
      errors.push("sandbox_policy_invalid");
      for (const issue of parsedEntry.error.issues) {
        parseIssueSummary.push({
          index,
          code: issue.code,
          path: issue.path.join(".")
        });
      }
      continue;
    }

    const policyEntry = parsedEntry.data;
    if (seenCommandIds.has(policyEntry.commandId)) {
      errors.push("sandbox_policy_invalid");
      parseIssueSummary.push({
        index,
        code: "duplicate_command_id",
        path: "commandId"
      });
      continue;
    }
    seenCommandIds.add(policyEntry.commandId);

    if (policyEntry.isolation.required && !isIsolationDriverConfigured(policyEntry.isolation.driver, input.ptyDriverConfigured)) {
      errors.push("sandbox_isolation_unavailable");
      continue;
    }

    commandPolicy.push(policyEntry);
  }

  diagnostics.issueCount = parseIssueSummary.length;
  diagnostics.issues = parseIssueSummary;
  const uniqueErrors = dedupe(errors);
  const validPolicy = uniqueErrors.length === 0;
  if (!validPolicy) {
    diagnostics.code = diagnostics.code ?? "policy_invalid";
  }

  return {
    commandPolicy: validPolicy ? commandPolicy : [],
    errors: uniqueErrors,
    redactedSummary: {
      mode: input.mode,
      commandPolicyCount: validPolicy ? commandPolicy.length : 0,
      ptyDriverConfigured: input.ptyDriverConfigured,
      diagnostics
    }
  };
}

function validateRequestPayload(request: SandboxJobRequest, limits: SandboxResourceLimits): SandboxNamedError | undefined {
  if (request.stdin && Buffer.byteLength(request.stdin, "utf8") > limits.stdinBytes) {
    return "sandbox_stdin_too_large";
  }
  if (request.argv.length > limits.argvCount) {
    return "sandbox_argv_too_large";
  }
  if (request.argv.some((entry) => Buffer.byteLength(entry, "utf8") > limits.argvEntryBytes)) {
    return "sandbox_argv_too_large";
  }

  const envEntries = Object.entries(request.env);
  if (envEntries.length > limits.envKeys) {
    return "sandbox_env_too_large";
  }
  if (envEntries.some(([, value]) => Buffer.byteLength(value, "utf8") > limits.envValueBytes)) {
    return "sandbox_env_too_large";
  }

  if (request.adapterType === "pty" && request.pty) {
    if (request.pty.cols > limits.ptyCols || request.pty.rows > limits.ptyRows) {
      return "sandbox_pty_invalid";
    }
  }

  if (request.resourceLimits.cpuMs !== undefined && (request.resourceLimits.cpuMs <= 0 || request.resourceLimits.cpuMs > limits.cpuMs)) {
    return "sandbox_resource_limit_invalid";
  }
  if (request.resourceLimits.memoryMiB !== undefined && (request.resourceLimits.memoryMiB <= 0 || request.resourceLimits.memoryMiB > limits.memoryMiB)) {
    return "sandbox_resource_limit_invalid";
  }
  return undefined;
}

function storedArtifactToCapturedArtifact(stored: StoredArtifactContent, contentStored: boolean): SandboxCapturedArtifact {
  return {
    path: stored.path,
    contentType: stored.contentType,
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    storageBackend: stored.storageBackend,
    objectKey: stored.objectKey,
    contentStored,
    truncated: false,
    metadata: {}
  };
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }
  return {
    message: String(error)
  };
}

function asFallbackJobId(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as Record<string, unknown>)["jobId"] === "string") {
    return (value as Record<string, unknown>)["jobId"] as string;
  }
  return "sandbox_job_unknown";
}

function toDurationMs(startedAt: string, endedAt: string): number {
  const startedMs = Date.parse(startedAt);
  const endedMs = Date.parse(endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) {
    return 0;
  }
  return Math.max(0, endedMs - startedMs);
}
