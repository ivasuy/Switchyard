import type { RunQueuePort, RunQueueClaimedJob } from "../ports/queue.js";
import type { RunStore } from "../ports/run-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { Run, SwitchyardEvent } from "@switchyard/contracts";

export interface HostedWorkerServiceDependencies {
  queue: RunQueuePort;
  runs: RunStore;
  events: EventStore;
  startRun: (runId: string) => Promise<Run>;
  hostedRuntimeAllowlist: string[];
  now?: () => string;
}

export class HostedWorkerService {
  private readonly now: () => string;

  constructor(private readonly deps: HostedWorkerServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async processNext(): Promise<boolean> {
    const job = await this.deps.queue.claim();
    if (!job) {
      return false;
    }

    const run = await this.deps.runs.get(job.payload.runId);
    if (!run) {
      await this.deps.queue.fail(job.id, { reasonCode: "hosted_run_state_invalid", message: "run_not_found" });
      await this.deps.queue.ack(job.id);
      return true;
    }

    const validationError = this.validateDurableRun(run);
    if (validationError) {
      await this.failRun(run, validationError);
      await this.deps.queue.fail(job.id, { reasonCode: validationError, message: validationError });
      await this.deps.queue.ack(job.id);
      return true;
    }

    try {
      await this.deps.startRun(run.id);
      await this.deps.queue.ack(job.id);
      return true;
    } catch (error) {
      return this.handleRunFailure(job, run, error);
    }
  }

  private validateDurableRun(run: Run): "hosted_runtime_not_allowed" | "hosted_run_state_invalid" | undefined {
    const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "timeout";
    if (terminal) {
      return "hosted_run_state_invalid";
    }
    if (run.placement !== "hosted") {
      return "hosted_run_state_invalid";
    }
    if (run.runtime !== "fake") {
      return "hosted_runtime_not_allowed";
    }
    if (run.runtimeMode !== "fake.deterministic") {
      return "hosted_runtime_not_allowed";
    }
    if (run.adapterType !== "process") {
      return "hosted_runtime_not_allowed";
    }
    if (!this.deps.hostedRuntimeAllowlist.includes("fake.deterministic")) {
      return "hosted_runtime_not_allowed";
    }
    return undefined;
  }

  private async handleRunFailure(job: RunQueueClaimedJob, run: Run, error: unknown): Promise<boolean> {
    const reasonCode = toReasonCode(error);
    const exhausted = job.attempts >= job.maxAttempts;

    if (exhausted) {
      await this.failRun(run, "worker_retry_exhausted");
      await this.deps.queue.fail(job.id, { reasonCode: "worker_retry_exhausted", message: reasonCode });
      await this.deps.queue.ack(job.id);
      return true;
    }

    await this.deps.queue.retry(job.id);
    await this.deps.queue.fail(job.id, { reasonCode, message: reasonCode });
    return true;
  }

  private async failRun(run: Run, reasonCode: string): Promise<void> {
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
}

function toReasonCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("object_store_write_failed")) {
    return "object_store_write_failed";
  }
  return "worker_job_failed";
}
