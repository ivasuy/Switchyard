import type { RunQueuePort, RunQueueClaimedJob } from "../ports/queue.js";
import type { RunStore } from "../ports/run-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { Run, SwitchyardEvent } from "@switchyard/contracts";
import {
  prepareHostedRunForExecution,
  type HostedRealRuntimeExecution
} from "./hosted-runtime-catalog.js";

export interface HostedWorkerServiceDependencies {
  queue: RunQueuePort;
  runs: RunStore;
  events: EventStore;
  startRun: (runId: string) => Promise<Run>;
  hostedRuntimeAllowlist: string[];
  deploymentMode: string;
  hostedRealRuntimeExecution: HostedRealRuntimeExecution;
  now?: () => string;
  metrics?: { inc(path: string): void };
  logger?: {
    info(event: string, details?: Record<string, unknown>): void;
    warn(event: string, details?: Record<string, unknown>): void;
  };
}

export class HostedWorkerService {
  private readonly now: () => string;

  constructor(private readonly deps: HostedWorkerServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
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
      realRuntimeExecution: this.deps.hostedRealRuntimeExecution
    });

    if (!prepared.ok) {
      this.deps.metrics?.inc("hostedRuntime.denied");
      this.deps.logger?.warn("hosted.worker.claim.rejected", {
        runId: run.id,
        runtimeMode: run.runtimeMode,
        reasonCode: prepared.reasonCode
      });
      await this.failRun(run, prepared.reasonCode);
      await this.deps.queue.fail(job.id, { reasonCode: prepared.reasonCode, message: prepared.reasonCode });
      return true;
    }

    const persisted = await this.persistPreparedRun(run, prepared.run);
    if (!persisted.ok) {
      this.deps.metrics?.inc("hostedRuntime.denied");
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
      await this.deps.startRun(run.id);
      this.deps.metrics?.inc("hostedRuntime.started");
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
    const exhausted = job.attempts >= job.maxAttempts;

    if (exhausted) {
      await this.failRun(run, "worker_retry_exhausted");
      await this.deps.queue.fail(job.id, { reasonCode: "worker_retry_exhausted", message: reasonCode });
      return true;
    }

    await this.deps.queue.retry(job.id);
    return true;
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
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("object_store_write_failed")) {
    return "object_store_write_failed";
  }
  return "worker_job_failed";
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
