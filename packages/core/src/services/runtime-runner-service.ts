import type { Run, RuntimeSession, RunStatus, SwitchyardEvent } from "@switchyard/contracts";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { RuntimeAdapter } from "../ports/runtime-adapter.js";
import type { SessionStore } from "../ports/session-store.js";
import type { EventBus } from "./event-bus.js";

export interface RuntimeRunnerDependencies {
  runs: RunStore;
  events: EventStore;
  sessions: SessionStore;
  adapters: Map<string, RuntimeAdapter>;
  artifacts?: ArtifactStore;
  eventBus?: EventBus;
}

export class RuntimeRunnerService {
  constructor(private readonly deps: RuntimeRunnerDependencies) {}

  async start(run: Run): Promise<Run> {
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
    await this.appendAndPublish(this.eventForRun(started, "run.started", sequence++, {}));

    let latest = started;
    let session: RuntimeSession | undefined;

    try {
      const startResult = await adapter.start({
        runId: started.id,
        runtime: started.runtime,
        provider: started.provider,
        model: started.model,
        cwd: started.cwd,
        task: started.task,
        metadata: started.metadata
      });

      const createdAt = new Date().toISOString();
      session = {
        id: startResult.sessionId,
        runId: started.id,
        runtime: started.runtime,
        provider: started.provider,
        model: started.model,
        protocol: started.adapterType,
        status: "active",
        state: {},
        createdAt
      };
      if (startResult.externalSessionKey) {
        session = { ...session, externalSessionKey: startResult.externalSessionKey };
      }
      if (startResult.processId) {
        session = { ...session, processId: startResult.processId };
      }
      await this.deps.sessions.create(session);

      for await (const event of adapter.events({ ...startResult, runId: started.id })) {
        if (await this.isCancelled(started.id)) {
          break;
        }

        const normalized = this.normalizeEvent(event, started.id, sequence++);

        if (normalized.type === "run.completed" || normalized.type === "run.failed") {
          const terminal = await this.terminalizeRunFromAdapterEvent(started, normalized, sequence - 1, session);
          if (!terminal) {
            break;
          }
          latest = terminal;
          if (normalized.type === "run.completed") {
            session = {
              ...session,
              status: "completed",
              updatedAt: terminal.endedAt
            };
          } else {
            session = {
              ...session,
              status: "failed",
              updatedAt: terminal.endedAt
            };
          }
          break;
        } else {
          await this.appendAndPublish(normalized);
        }
      }

      if (await this.isCancelled(started.id)) {
        const finalRun = await this.deps.runs.get(started.id);
        return finalRun ?? latest;
      }

      if (this.deps.artifacts && session) {
        const adapterArtifacts = await adapter.artifacts(this.adapterSession(session));
        for (const artifact of adapterArtifacts) {
          if (await this.isCancelled(started.id)) {
            break;
          }
          const storedArtifact = await this.deps.artifacts.create({
            ...artifact,
            id: this.uniqueArtifactId(artifact.id),
            runId: started.id,
            provider: artifact.provider ?? started.provider,
            model: artifact.model ?? started.model,
            createdAt: artifact.createdAt ?? new Date().toISOString()
          });
          const artifactEvent = this.eventForRun(
            latest,
            "artifact.created",
            sequence++,
            {
              artifactId: storedArtifact.id,
              path: storedArtifact.path,
              type: storedArtifact.type
            }
          );
          await this.appendAndPublish(artifactEvent);
        }
      }

      return latest;
    } catch (error) {
      return this.failRun(started, error, sequence, session);
    }
  }

  async sendInput(runId: string, input: Record<string, unknown>): Promise<void> {
    const run = await this.requireRun(runId);
    const adapter = this.requireAdapter(run.runtime);
    const session = await this.requireSession(runId);

    await adapter.send(this.adapterSession(session), input);
  }

  async cancel(runId: string): Promise<Run> {
    const run = await this.requireRun(runId);
    const adapter = this.requireAdapter(run.runtime);
    const session = await this.requireSession(runId);

    await adapter.cancel(this.adapterSession(session));

    const cancelledAt = new Date().toISOString();
    const cancelledRun: Run = {
      ...run,
      status: "cancelled",
      endedAt: cancelledAt
    };
    const cancelledSession: RuntimeSession = {
      ...session,
      status: "cancelled",
      updatedAt: cancelledAt
    };
    await this.deps.runs.update(cancelledRun);
    await this.deps.sessions.update(cancelledSession);
    await this.appendAndPublish(this.eventForRun(
      cancelledRun,
      "run.cancelled",
      (await this.deps.events.listByRun(runId)).length,
      { status: "cancelled" }
    ));

    return cancelledRun;
  }

  private async failRun(
    templateRun: Run,
    error: unknown,
    sequence: number,
    session?: RuntimeSession
  ): Promise<Run> {
    const currentRun = await this.deps.runs.get(templateRun.id);
    if (!currentRun || currentRun.status === "cancelled") {
      return currentRun ?? templateRun;
    }
    if (this.isTerminal(currentRun.status)) {
      return currentRun;
    }

    const failed: Run = {
      ...templateRun,
      status: "failed",
      endedAt: new Date().toISOString()
    };
    await this.deps.runs.update(failed);
    if (session) {
      await this.deps.sessions.update({
        ...session,
        status: "failed",
        updatedAt: new Date().toISOString()
      });
    }

    await this.appendAndPublish(this.eventForRun(
      failed,
      "run.failed",
      sequence,
      {
        status: "failed",
        error: this.errorPayload(error)
      }
    ));

    return failed;
  }

  private async terminalizeRunFromAdapterEvent(
    templateRun: Run,
    event: SwitchyardEvent,
    sequence: number,
    session: RuntimeSession
  ): Promise<Run | undefined> {
    const currentRun = await this.deps.runs.get(templateRun.id);
    if (!currentRun || this.isTerminal(currentRun.status)) {
      return undefined;
    }

    const terminalStatus: RunStatus = event.type === "run.completed" ? "completed" : "failed";
    const terminal: Run = {
      ...templateRun,
      status: terminalStatus,
      endedAt: new Date().toISOString()
    };

    const terminalSession: RuntimeSession = {
      ...session,
      status: terminalStatus,
      updatedAt: terminal.endedAt
    };

    await this.deps.runs.update(terminal);
    await this.deps.sessions.update(terminalSession);
    await this.appendAndPublish(this.eventForRun(
      terminal,
      event.type,
      sequence,
      event.payload
    ));

    return terminal;
  }

  private async isCancelled(runId: string): Promise<boolean> {
    const run = await this.deps.runs.get(runId);
    return run?.status === "cancelled";
  }

  private isTerminal(status: RunStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled" || status === "timeout";
  }

  private uniqueArtifactId(id: string): string {
    if (id.startsWith("artifact_")) {
      return `${id}_${crypto.randomUUID()}`;
    }
    return `artifact_${crypto.randomUUID()}`;
  }

  private errorPayload(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
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

  private async appendAndPublish(event: SwitchyardEvent): Promise<void> {
    await this.deps.events.append(event);
    try {
      await this.deps.eventBus?.publish(event);
    } catch {
      // Event bus should not prevent runtime execution flow; launchers may have best-effort listeners.
    }
  }

  private normalizeEvent(event: SwitchyardEvent, runId: string, sequence: number): SwitchyardEvent {
    return {
      ...event,
      id: `event_${crypto.randomUUID()}`,
      runId,
      sequence
    };
  }

  private requireAdapter(runtime: string): RuntimeAdapter {
    const adapter = this.deps.adapters.get(runtime);
    if (!adapter) {
      throw new Error(`Runtime adapter not found: ${runtime}`);
    }
    return adapter;
  }

  private async requireRun(runId: string): Promise<Run> {
    const run = await this.deps.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  private async requireSession(runId: string): Promise<RuntimeSession> {
    const session = await this.deps.sessions.getByRunId(runId);
    if (!session) {
      throw new Error(`Runtime session not found for run: ${runId}`);
    }
    return session;
  }

  private adapterSession(session: RuntimeSession): Record<string, unknown> {
    return {
      sessionId: session.id,
      runId: session.runId,
      runtime: session.runtime,
      provider: session.provider,
      model: session.model,
      protocol: session.protocol,
      externalSessionKey: session.externalSessionKey,
      processId: session.processId,
      state: session.state
    };
  }
}
