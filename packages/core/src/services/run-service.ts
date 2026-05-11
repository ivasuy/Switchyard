import type { Run, SwitchyardEvent } from "@switchyard/contracts";
import type { EventStore } from "../ports/event-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { RuntimeAdapter } from "../ports/runtime-adapter.js";

export interface CreateRunInput {
  runtime: string;
  provider: string;
  model: string;
  adapterType: Run["adapterType"];
  cwd: string;
  task: string;
  placement: Run["placement"];
  approvalPolicy: string;
  timeoutSeconds: number;
  metadata: Record<string, unknown>;
}

export interface RunServiceDependencies {
  runs: RunStore;
  events: EventStore;
  adapters: Map<string, RuntimeAdapter>;
}

export class RunService {
  constructor(private readonly deps: RunServiceDependencies) {}

  async createRun(input: CreateRunInput): Promise<Run> {
    const now = new Date().toISOString();
    const run: Run = {
      id: `run_${crypto.randomUUID()}`,
      runtime: input.runtime,
      provider: input.provider,
      model: input.model,
      adapterType: input.adapterType,
      cwd: input.cwd,
      task: input.task,
      status: "queued",
      placement: input.placement,
      approvalPolicy: input.approvalPolicy,
      timeoutSeconds: input.timeoutSeconds,
      metadata: input.metadata,
      createdAt: now
    };

    await this.deps.runs.create(run);
    await this.deps.events.append(this.eventForRun(run, "run.queued", 0, {}));
    return run;
  }

  private eventForRun(run: Run, type: SwitchyardEvent["type"], sequence: number, payload: Record<string, unknown>): SwitchyardEvent {
    return {
      id: `event_${crypto.randomUUID()}`,
      type,
      runId: run.id,
      sequence,
      payload,
      createdAt: new Date().toISOString()
    };
  }
}
