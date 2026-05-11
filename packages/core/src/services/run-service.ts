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

  async startRun(runId: string): Promise<Run> {
    const run = await this.deps.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    const adapter = this.deps.adapters.get(run.runtime);
    if (!adapter) {
      throw new Error(`Runtime adapter not found: ${run.runtime}`);
    }

    let sequence = (await this.deps.events.listByRun(run.id)).length;
    const started: Run = {
      ...run,
      status: "running",
      startedAt: new Date().toISOString()
    };
    await this.deps.runs.update(started);
    await this.deps.events.append(this.eventForRun(started, "run.started", sequence++, {}));

    const session = await adapter.start({
      runId: started.id,
      runtime: started.runtime,
      provider: started.provider,
      model: started.model,
      cwd: started.cwd,
      task: started.task,
      metadata: started.metadata
    });

    let latest = started;
    for await (const event of adapter.events({ ...session, runId: started.id })) {
      const normalized = {
        ...event,
        id: `event_${crypto.randomUUID()}`,
        runId: started.id,
        sequence: sequence++,
        createdAt: event.createdAt ?? new Date().toISOString()
      };
      await this.deps.events.append(normalized);

      if (event.type === "run.completed") {
        latest = {
          ...started,
          status: "completed",
          endedAt: new Date().toISOString()
        };
        await this.deps.runs.update(latest);
      }
      if (event.type === "run.failed") {
        latest = {
          ...started,
          status: "failed",
          endedAt: new Date().toISOString()
        };
        await this.deps.runs.update(latest);
      }
    }

    return latest;
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
