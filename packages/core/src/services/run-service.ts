import type { Run, SwitchyardEvent } from "@switchyard/contracts";
import type { EventStore } from "../ports/event-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { RuntimeRunnerService } from "./runtime-runner-service.js";

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
  runtimeMode?: string;
}

export interface RunServiceDependencies {
  runs: RunStore;
  events: EventStore;
  runner: RuntimeRunnerService;
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
      runtimeMode: input.runtimeMode,
      createdAt: now
    };

    await this.deps.runs.create(run);
    await this.deps.events.append(this.eventForRun(run, "run.queued", 0, {}));
    return run;
  }

  async startRun(runId: string): Promise<Run> {
    const run = await this.deps.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    return this.deps.runner.start(run);
  }

  async sendInput(runId: string, input: Record<string, unknown>): Promise<void> {
    await this.deps.runner.sendInput(runId, input);
  }

  async cancelRun(runId: string): Promise<Run> {
    return this.deps.runner.cancel(runId);
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
