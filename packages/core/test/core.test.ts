import { describe, expect, it } from "vitest";
import {
  createNotImplementedError,
  EventBus,
  RuntimeRunnerService,
  RunService
} from "../src/index.js";
import type { ArtifactStore, EventStore, RunStore, RuntimeAdapter, SessionStore } from "../src/index.js";
import type { Artifact, Run, RuntimeSession, SwitchyardEvent } from "@switchyard/contracts";

describe("core service shells", () => {
  it("creates domain not-implemented errors with stable codes", () => {
    const error = createNotImplementedError("debate-service", "startRound");

    expect(error.code).toBe("adapter_protocol_failed");
    expect(error.message).toContain("debate-service.startRound");
  });

  it("run service creates a queued run and emits an event through ports", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const adapter = new NoopAdapter();
    const runner = new RuntimeRunnerService({ runs, events, sessions, adapters: new Map([["fake", adapter]]) });
    const service = new RunService({ runs, events, runner });

    const run = await service.createRun({
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "Test task",
      placement: "local",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {}
    });

    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe("queued");
    expect(await runs.get(run.id)).toEqual(run);
    expect(events.items[0]?.type).toBe("run.queued");
  });

  it("run service starts a queued run through its adapter and stores normalized events", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const adapter = new EventfulAdapter();
    const runner = new RuntimeRunnerService({ runs, events, sessions, adapters: new Map([["fake", adapter]]) });
    const service = new RunService({ runs, events, runner });
    const run = await service.createRun({
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "Test task",
      placement: "local",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {}
    });

    const completed = await service.startRun(run.id);

    expect(adapter.startedWith?.["task"]).toBe("Test task");
    expect(completed.status).toBe("completed");
    expect((await runs.get(run.id))?.status).toBe("completed");
    expect(events.items.map((event) => event.type)).toEqual([
      "run.queued",
      "run.started",
      "runtime.status",
      "runtime.output",
      "run.completed"
    ]);
    expect(events.items.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect([...sessions.items.values()][0]).toMatchObject({
      runId: run.id,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      protocol: "process",
      status: "completed"
    });
  });

  it("run service sends input and cancels through the runtime runner", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const adapter = new EventfulAdapter();
    const runner = new RuntimeRunnerService({ runs, events, sessions, adapters: new Map([["fake", adapter]]) });
    const service = new RunService({ runs, events, runner });
    const run = await service.createRun({
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "Test task",
      placement: "local",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {}
    });
    await service.startRun(run.id);

    await service.sendInput(run.id, { text: "continue" });
    const cancelled = await service.cancelRun(run.id);

    expect(adapter.sentInput).toEqual({ text: "continue" });
    expect(cancelled.status).toBe("cancelled");
  });

  it("runtime runner stores adapter session details before streaming events", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const run: Run = {
      id: "run_1",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "Test task",
      status: "queued",
      placement: "local",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    };
    await runs.create(run);
    await events.append({
      id: "event_queued",
      type: "run.queued",
      runId: run.id,
      sequence: 0,
      payload: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    });
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", new EventfulAdapter()]])
    });

    await runner.start(run);

    const session = [...sessions.items.values()][0];
    expect(session).toMatchObject({
      id: "session_1",
      runId: "run_1",
      protocol: "process",
      status: "completed"
    });
    expect(events.items.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
  });

  it("runtime runner sends input to the active session", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const adapter = new EventfulAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", adapter]])
    });
    await runner.start(run);

    await runner.sendInput(run.id, { text: "continue" });

    expect(adapter.sentInput).toEqual({ text: "continue" });
    expect(adapter.sentSession?.["runId"]).toBe(run.id);
  });

  it("runtime runner stores adapter artifacts and emits artifact events", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const adapter = new EventfulAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      adapters: new Map([["fake", adapter]])
    });

    await runner.start(run);

    expect(await artifacts.listByRun(run.id)).toHaveLength(1);
    expect(events.items.at(-1)?.type).toBe("artifact.created");
  });

  it("runtime runner publishes adapter stream events and artifact events to event bus", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const bus = new EventBus();
    const received: SwitchyardEvent[] = [];
    const unsubscribe = bus.subscribe((event) => {
      received.push(event);
    });
    const adapter = new EventfulAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      eventBus: bus,
      adapters: new Map([["fake", adapter]])
    });

    await runner.start(run);
    unsubscribe();

    expect(received.at(-1)?.type).toBe("artifact.created");
    expect(received.some((event) => event.type === "run.started")).toBe(true);
    expect(received.some((event) => event.type === "runtime.output")).toBe(true);
    expect(received.some((event) => event.type === "artifact.created")).toBe(true);
  });

  it("runtime runner cancels the active session and marks the run cancelled", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const adapter = new EventfulAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", adapter]])
    });
    await runner.start(run);

    const cancelled = await runner.cancel(run.id);

    expect(adapter.cancelledSession?.["runId"]).toBe(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await sessions.getByRunId(run.id))?.status).toBe("cancelled");
    expect(events.items.at(-1)?.type).toBe("run.cancelled");
  });

  it("event bus publishes events to subscribers", async () => {
    const received: SwitchyardEvent[] = [];
    const bus = new EventBus();
    const unsubscribe = bus.subscribe((event) => {
      received.push(event);
    });

    await bus.publish({
      id: "event_1",
      type: "runtime.output",
      runId: "run_1",
      sequence: 1,
      payload: { text: "hello" },
      createdAt: "2026-05-11T00:00:00.000Z"
    });
    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]?.payload).toEqual({ text: "hello" });
  });
});

class MemoryRunStore implements RunStore {
  readonly items = new Map<string, Run>();

  async create(run: Run): Promise<Run> {
    this.items.set(run.id, run);
    return run;
  }

  async get(id: string): Promise<Run | undefined> {
    return this.items.get(id);
  }

  async update(run: Run): Promise<Run> {
    this.items.set(run.id, run);
    return run;
  }
}

class MemoryEventStore implements EventStore {
  readonly items: SwitchyardEvent[] = [];

  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> {
    this.items.push(event);
    return event;
  }

  async listByRun(runId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((event) => event.runId === runId);
  }
}

class MemorySessionStore implements SessionStore {
  readonly items = new Map<string, RuntimeSession>();

  async create(session: RuntimeSession): Promise<RuntimeSession> {
    this.items.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<RuntimeSession | undefined> {
    return this.items.get(id);
  }

  async getByRunId(runId: string): Promise<RuntimeSession | undefined> {
    return [...this.items.values()].find((session) => session.runId === runId);
  }

  async update(session: RuntimeSession): Promise<RuntimeSession> {
    this.items.set(session.id, session);
    return session;
  }
}

class MemoryArtifactStore implements ArtifactStore {
  readonly items: Artifact[] = [];

  async create(artifact: Artifact): Promise<Artifact> {
    this.items.push(artifact);
    return artifact;
  }

  async get(id: string): Promise<Artifact | undefined> {
    return this.items.find((artifact) => artifact.id === id);
  }

  async update(artifact: Artifact): Promise<Artifact> {
    const index = this.items.findIndex((entry) => entry.id === artifact.id);
    if (index < 0) {
      this.items.push(artifact);
      return artifact;
    }
    this.items[index] = artifact;
    return artifact;
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    return this.items.filter((artifact) => artifact.runId === runId);
  }
}

class NoopAdapter implements RuntimeAdapter {
  readonly id = "fake";

  async check() {
    return { ok: true };
  }

  async start() {
    return { sessionId: "session_1" };
  }

  async send() {
    return undefined;
  }

  async cancel() {
    return undefined;
  }

  events(): AsyncIterable<SwitchyardEvent> {
    return (async function* () {})();
  }

  async tools() {
    return [];
  }

  async artifacts() {
    return [];
  }
}

class EventfulAdapter extends NoopAdapter {
  startedWith: Record<string, unknown> | undefined;
  sentSession: Record<string, unknown> | undefined;
  sentInput: Record<string, unknown> | undefined;
  cancelledSession: Record<string, unknown> | undefined;

  override async start(request: Record<string, unknown>) {
    this.startedWith = request;
    return { sessionId: "session_1" };
  }

  override async send(session: Record<string, unknown>, input: Record<string, unknown>) {
    this.sentSession = session;
    this.sentInput = input;
  }

  override async cancel(session: Record<string, unknown>) {
    this.cancelledSession = session;
  }

  override async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    return [
      {
        id: `adapter_artifact_${String(session["runId"])}`,
        type: "transcript",
        path: `artifacts/${String(session["runId"])}/transcript.jsonl`,
        metadata: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      }
    ];
  }

  override events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    return (async function* () {
      yield {
        id: "event_adapter_running",
        type: "runtime.status",
        runId: String(session["runId"]),
        sequence: 99,
        payload: { status: "running" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
      yield {
        id: "event_adapter_output",
        type: "runtime.output",
        runId: String(session["runId"]),
        sequence: 100,
        payload: { text: "hello" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
      yield {
        id: "event_adapter_completed",
        type: "run.completed",
        runId: String(session["runId"]),
        sequence: 101,
        payload: { status: "completed" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
    })();
  }
}

async function createStoredRun(runs: RunStore): Promise<Run> {
  const run: Run = {
    id: `run_${crypto.randomUUID()}`,
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "Test task",
    status: "queued",
    placement: "local",
    approvalPolicy: "default",
    timeoutSeconds: 60,
    metadata: {},
    createdAt: "2026-05-11T00:00:00.000Z"
  };
  await runs.create(run);
  return run;
}
