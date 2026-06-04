import type { RunQueuePort, RunQueueClaimedJob } from "../ports/queue.js";
import type { RunStore } from "../ports/run-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { ProviderRuntimeMode, Run, SwitchyardEvent } from "@switchyard/contracts";
import { providerRuntimeModeSchema } from "@switchyard/contracts";
import {
  isRealHostedRuntimeMode,
  prepareHostedRunForExecution,
  type HostedRealRuntimeExecution
} from "./hosted-runtime-catalog.js";
import {
  buildProviderResolvedCommand,
  checkProviderSpendControlsForRun,
  type ProviderRuntimeActivationResult
} from "./provider-runtime-policy.js";

export interface HostedWorkerServiceDependencies {
  queue: RunQueuePort;
  runs: RunStore;
  events: EventStore;
  startRun: (runId: string) => Promise<Run>;
  hostedRuntimeAllowlist: string[];
  deploymentMode: string;
  hostedRealRuntimeExecution: HostedRealRuntimeExecution;
  providerActivation?: ProviderRuntimeActivationResult | undefined;
  providerEnvironment?: Readonly<Record<string, string | undefined>> | undefined;
  adapterRuntimeModes?: ReadonlySet<string> | undefined;
  now?: () => string;
  metrics?: { inc(path: string): void };
  logger?: {
    info(event: string, details?: Record<string, unknown>): void;
    warn(event: string, details?: Record<string, unknown>): void;
  };
}

export class HostedWorkerService {
  private readonly now: () => string;
  private readonly nowMs: () => number;

  constructor(private readonly deps: HostedWorkerServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.nowMs = () => {
      const iso = this.now();
      const parsed = Date.parse(iso);
      return Number.isFinite(parsed) ? parsed : Date.now();
    };
  }

  async processNext(): Promise<boolean> {
    const recovery = await this.deps.queue.recoverStaleClaims();
    await this.applyStaleClaimExhaustion(recovery.exhaustedClaims);
    const job = await this.deps.queue.claim();
    if (!job) {
      return false;
    }

    const run = await this.deps.runs.get(job.payload.runId);
    if (!run) {
      await this.deps.queue.fail(job.id, { reasonCode: "hosted_run_state_invalid", message: "run_not_found" });
      return true;
    }

    const prepared = prepareHostedRunForExecution({
      run,
      queuePayload: job.payload,
      allowlist: this.deps.hostedRuntimeAllowlist,
      deploymentMode: this.deps.deploymentMode,
      realRuntimeExecution: this.deps.hostedRealRuntimeExecution,
      providerActivation: this.deps.providerActivation
    });

    if (!prepared.ok) {
      this.deps.metrics?.inc("hostedRuntime.denied");
      this.emitLifecycle("denied", run.runtimeMode, prepared.reasonCode);
      this.deps.logger?.warn("hosted.worker.claim.rejected", {
        runId: run.id,
        runtimeMode: run.runtimeMode,
        reasonCode: prepared.reasonCode
      });
      await this.failRun(run, prepared.reasonCode);
      await this.deps.queue.fail(job.id, { reasonCode: prepared.reasonCode, message: prepared.reasonCode });
      return true;
    }

    const claimGuard = await this.revalidateClaimGuards(prepared.run);
    if (!claimGuard.ok) {
      this.deps.metrics?.inc("hostedRuntime.denied");
      this.emitLifecycle(claimGuard.outcome, run.runtimeMode, claimGuard.reasonCode);
      this.deps.logger?.warn("hosted.worker.claim.rejected", {
        runId: run.id,
        runtimeMode: run.runtimeMode,
        reasonCode: claimGuard.reasonCode
      });
      await this.failRun(run, claimGuard.reasonCode);
      await this.deps.queue.fail(job.id, { reasonCode: claimGuard.reasonCode, message: claimGuard.reasonCode });
      return true;
    }

    const persisted = await this.persistPreparedRun(run, prepared.run);
    if (!persisted.ok) {
      this.deps.metrics?.inc("hostedRuntime.denied");
      this.emitLifecycle("denied", run.runtimeMode, "hosted_run_state_invalid");
      this.deps.logger?.warn("hosted.worker.claim.rejected", {
        runId: run.id,
        runtimeMode: run.runtimeMode,
        reasonCode: "hosted_run_state_invalid"
      });
      await this.failRun(run, "hosted_run_state_invalid");
      await this.deps.queue.fail(job.id, { reasonCode: "hosted_run_state_invalid", message: persisted.message });
      return true;
    }

    try {
      this.emitLifecycle("accepted", run.runtimeMode, "claim_revalidated");
      const started = await this.deps.startRun(run.id);
      this.deps.metrics?.inc("hostedRuntime.started");
      if (started.status === "failed") {
        this.emitLifecycle("failed", run.runtimeMode, "runtime_failed");
      } else if (started.status === "timeout") {
        this.emitLifecycle("timed_out", run.runtimeMode, "runtime_timeout");
      } else if (started.status === "cancelled") {
        this.emitLifecycle("cancelled", run.runtimeMode, "runtime_cancelled");
      }
      this.deps.logger?.info("hosted.worker.claim.revalidated", {
        runId: run.id,
        runtimeMode: run.runtimeMode
      });
      await this.deps.queue.ack(job.id);
      return true;
    } catch (error) {
      return this.handleRunFailure(job, persisted.run, error);
    }
  }

  private async revalidateClaimGuards(
    run: Run
  ): Promise<
    | { ok: true }
    | {
      ok: false;
      reasonCode: string;
      outcome: "denied" | "spend_control_denied";
    }
  > {
    if (this.deps.deploymentMode !== "production") {
      return { ok: true };
    }

    if (!run.runtimeMode || !isRealHostedRuntimeMode(run.runtimeMode)) {
      return { ok: true };
    }
    const runtimeMode = toProviderRuntimeMode(run.runtimeMode);
    if (!runtimeMode) {
      return {
        ok: false,
        reasonCode: "provider_runtime_policy_unknown_mode",
        outcome: "denied"
      };
    }

    const activation = this.deps.providerActivation;
    if (!activation?.valid) {
      return {
        ok: false,
        reasonCode: activation?.reasons[0]?.code ?? "provider_runtime_policy_missing",
        outcome: "denied"
      };
    }
    if (!activation.enabledRealModes.includes(runtimeMode)) {
      return {
        ok: false,
        reasonCode: "provider_runtime_policy_disabled",
        outcome: "denied"
      };
    }

    if (this.deps.adapterRuntimeModes && !this.deps.adapterRuntimeModes.has(runtimeMode)) {
      return {
        ok: false,
        reasonCode: "hosted_runtime_adapter_unavailable",
        outcome: "denied"
      };
    }

    const activeRuns = await this.countActiveRunsForRuntimeMode(runtimeMode, run.id);
    const runsInPastHour = await this.countRunsInPastHourForRuntimeMode(runtimeMode, run.id);
    const spend = checkProviderSpendControlsForRun({
      activation,
      runtimeMode,
      promptBytes: Buffer.byteLength(run.task, "utf8"),
      activeRuns,
      runsInPastHour,
      timeoutSeconds: run.timeoutSeconds
    });
    if (!spend.ok) {
      return {
        ok: false,
        reasonCode: spend.code,
        outcome: "spend_control_denied"
      };
    }

    const command = buildProviderResolvedCommand({
      activation,
      runtimeMode,
      cwd: run.cwd,
      env: this.deps.providerEnvironment ?? process.env,
      metadata: run.metadata
    });
    if (!command.ok) {
      return {
        ok: false,
        reasonCode: command.code,
        outcome: "denied"
      };
    }

    return { ok: true };
  }

  private async countActiveRunsForRuntimeMode(runtimeMode: string, ignoreRunId: string): Promise<number> {
    const active = await this.deps.runs.list({
      status: ["starting", "running", "waiting_for_input", "waiting_for_approval"],
      placement: ["hosted"],
      limit: 5000
    });
    return active.runs.filter((candidate) => candidate.runtimeMode === runtimeMode && candidate.id !== ignoreRunId).length;
  }

  private async countRunsInPastHourForRuntimeMode(runtimeMode: string, ignoreRunId: string): Promise<number> {
    const since = new Date(this.nowMs() - 3_600_000).toISOString();
    const recent = await this.deps.runs.list({
      placement: ["hosted"],
      since,
      limit: 5000
    });
    return recent.runs.filter((candidate) => candidate.runtimeMode === runtimeMode && candidate.id !== ignoreRunId).length;
  }

  private async persistPreparedRun(
    sourceRun: Run,
    preparedRun: Run
  ): Promise<{ ok: true; run: Run } | { ok: false; message: string }> {
    const current = await this.deps.runs.get(sourceRun.id);
    if (!current) {
      return { ok: false, message: "run_not_found" };
    }

    if (!sameExecutionIdentity(current, sourceRun)) {
      return { ok: false, message: "run_changed_before_prepare_persist" };
    }

    if (JSON.stringify(current.metadata ?? {}) === JSON.stringify(preparedRun.metadata ?? {})) {
      return { ok: true, run: current };
    }

    if (!this.deps.runs.updatePreparedMetadataIfMatch) {
      return { ok: false, message: "prepared_metadata_guard_unsupported" };
    }

    const guarded = await this.deps.runs.updatePreparedMetadataIfMatch({
      expected: executionIdentity(sourceRun),
      metadata: preparedRun.metadata ?? {}
    });

    if (!guarded.ok) {
      return {
        ok: false,
        message: guarded.reason === "not_found" ? "run_not_found" : "run_changed_before_prepare_persist"
      };
    }

    return { ok: true, run: guarded.run };
  }

  private async handleRunFailure(job: RunQueueClaimedJob, run: Run, error: unknown): Promise<boolean> {
    const reasonCode = toReasonCode(error);
    if (isNonRetryableReason(reasonCode)) {
      await this.failRun(run, reasonCode);
      await this.deps.queue.fail(job.id, { reasonCode, message: reasonCode });
      this.emitLifecycle("failed", run.runtimeMode, reasonCode);
      return true;
    }
    const exhausted = job.attempts >= job.maxAttempts;

    if (exhausted) {
      await this.failRun(run, "worker_retry_exhausted");
      await this.deps.queue.fail(job.id, { reasonCode: "worker_retry_exhausted", message: reasonCode });
      this.emitLifecycle("failed", run.runtimeMode, "worker_retry_exhausted");
      return true;
    }

    await this.deps.queue.retry(job.id);
    return true;
  }

  private emitLifecycle(
    outcome: "accepted" | "denied" | "failed" | "timed_out" | "cancelled" | "spend_control_denied",
    runtimeMode: string | undefined,
    reasonCode: string
  ): void {
    const mode = sanitizeMetricLabel(runtimeMode ?? "unknown");
    const reason = sanitizeMetricLabel(reasonCode);
    this.deps.metrics?.inc(`hostedRuntime.lifecycle.outcome.${outcome}.runtime_mode.${mode}.reason.${reason}`);
  }

  private async failRun(run: Run, reasonCode: string): Promise<void> {
    if (isTerminalRun(run)) {
      return;
    }
    const endedAt = this.now();
    const failed: Run = {
      ...run,
      status: "failed",
      endedAt
    };
    await this.deps.runs.update(failed);
    const currentEvents = await this.deps.events.listByRun(run.id);
    const event: SwitchyardEvent = {
      id: `event_${crypto.randomUUID()}`,
      type: "run.failed",
      runId: run.id,
      sequence: currentEvents.length,
      payload: { reasonCode },
      createdAt: endedAt
    };
    await this.deps.events.append(event);
  }

  private async applyStaleClaimExhaustion(exhaustedClaims: Array<{ jobId: string; runId: string }>): Promise<void> {
    for (const claim of exhaustedClaims) {
      const run = await this.deps.runs.get(claim.runId);
      if (!run) {
        continue;
      }
      await this.failRun(run, "worker_retry_exhausted");
      await this.deps.queue.fail(claim.jobId, {
        reasonCode: "worker_retry_exhausted",
        message: "stale_claim_exhausted"
      });
    }
  }
}

function toReasonCode(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const reasonCode = record["reasonCode"];
    if (typeof reasonCode === "string" && reasonCode.length > 0) {
      return reasonCode;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("provider_")) {
    const direct = message.match(/provider_[a-z_]+/);
    if (direct?.[0]) {
      return direct[0];
    }
  }
  if (message.includes("hosted_input_bridge_unsupported")) {
    return "hosted_input_bridge_unsupported";
  }
  if (message.includes("hosted_approval_bridge_unsupported")) {
    return "hosted_approval_bridge_unsupported";
  }
  if (message.includes("provider_command_denied")) {
    return "provider_command_denied";
  }
  if (message.includes("object_store_write_failed")) {
    return "object_store_write_failed";
  }
  return "worker_job_failed";
}

function isNonRetryableReason(reasonCode: string): boolean {
  return reasonCode === "provider_runtime_policy_missing"
    || reasonCode === "provider_runtime_policy_empty"
    || reasonCode === "provider_runtime_policy_malformed"
    || reasonCode === "provider_runtime_policy_unknown_mode"
    || reasonCode === "provider_runtime_policy_disabled"
    || reasonCode === "provider_command_policy_invalid"
    || reasonCode === "provider_binary_unavailable"
    || reasonCode === "provider_credentials_missing"
    || reasonCode === "provider_credentials_invalid"
    || reasonCode === "provider_spend_controls_invalid"
    || reasonCode === "provider_prompt_too_large"
    || reasonCode === "provider_spend_limit_exceeded"
    || reasonCode === "provider_command_denied"
    || reasonCode === "hosted_runtime_adapter_unavailable"
    || reasonCode === "hosted_input_bridge_unsupported"
    || reasonCode === "hosted_approval_bridge_unsupported";
}

function sanitizeMetricLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96) || "unknown";
}

function toProviderRuntimeMode(value: string): ProviderRuntimeMode | undefined {
  const parsed = providerRuntimeModeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isTerminalRun(run: Run): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "timeout";
}

function sameExecutionIdentity(current: Run, expected: Run): boolean {
  const identity = executionIdentity(expected);
  return (
    current.id === identity.id &&
    current.status === identity.status &&
    current.placement === identity.placement &&
    current.runtime === identity.runtime &&
    current.runtimeMode === identity.runtimeMode &&
    current.provider === identity.provider &&
    current.adapterType === identity.adapterType
  );
}

function executionIdentity(run: Run): {
  id: string;
  status: Run["status"];
  placement: Run["placement"];
  runtime: Run["runtime"];
  runtimeMode: Run["runtimeMode"];
  provider: Run["provider"];
  adapterType: Run["adapterType"];
} {
  return {
    id: run.id,
    status: run.status,
    placement: run.placement,
    runtime: run.runtime,
    runtimeMode: run.runtimeMode,
    provider: run.provider,
    adapterType: run.adapterType
  };
}
