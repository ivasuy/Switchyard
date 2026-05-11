import { describe, expect, it, vi } from "vitest";
import {
  createNotImplementedError,
  EventBus,
  RuntimeRunnerService,
  RunLauncherService,
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
    expect(events.items.at(-1)?.type).toBe("run.completed");
    expect(events.items.some((event) => event.type === "artifact.created")).toBe(true);
  });

  it("emits artifact.created before run.completed with unique increasing sequence values", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const adapter = new ContentfulArtifactAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      adapters: new Map([["fake", adapter]])
    });

    await runner.start(run);

    const orderedTypes = events.items.map((event) => event.type);
    const artifactIndex = orderedTypes.indexOf("artifact.created");
    const completedIndex = orderedTypes.lastIndexOf("run.completed");
    const sequences = events.items.map((event) => event.sequence);

    expect(artifactIndex).toBeGreaterThan(-1);
    expect(completedIndex).toBeGreaterThan(-1);
    expect(artifactIndex).toBeLessThan(completedIndex);
    expect(new Set(sequences).size).toBe(sequences.length);
    const sorted = [...sequences].sort((a, b) => a - b);
    expect(sequences).toEqual(sorted);
  });

  it("stores adapter artifact content when artifact content store is available", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const artifactContent = new InMemoryArtifactContentStore();
    const adapter = new ContentfulArtifactAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      artifactContent,
      adapters: new Map([["fake", adapter]])
    });

    await runner.start(run);

    const [storedArtifact] = await artifacts.listByRun(run.id);
    expect(storedArtifact).toMatchObject({
      metadata: {
        contentStored: true
      }
    });
    expect(storedArtifact?.path).toBe(`stored/${adapter.artifactPath}`);
    expect(storedArtifact?.metadata).not.toHaveProperty("content");
    expect(artifactContent.writes.at(-1)).toEqual({
      path: adapter.artifactPath,
      content: adapter.artifactContent
    });
  });

  it("stores explicit empty artifact content when artifact content store is available", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const artifactContent = new InMemoryArtifactContentStore();
    const adapter = new EmptyContentArtifactAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      artifactContent,
      adapters: new Map([["fake", adapter]])
    });

    await runner.start(run);

    const [storedArtifact] = await artifacts.listByRun(run.id);
    expect(storedArtifact).toMatchObject({
      path: `stored/${adapter.artifactPath}`,
      metadata: {
        contentStored: true
      }
    });
    expect(storedArtifact?.metadata).not.toHaveProperty("content");
    expect(artifactContent.writes.at(-1)).toEqual({
      path: adapter.artifactPath,
      content: adapter.artifactContent
    });
  });

  it("does not attempt content persistence when artifact content store is unavailable", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const adapter = new ContentfulArtifactAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      adapters: new Map([["fake", adapter]])
    });

    await runner.start(run);

    const [storedArtifact] = await artifacts.listByRun(run.id);
    expect(storedArtifact?.path).toBe(adapter.artifactPath);
    expect(storedArtifact?.metadata).toMatchObject({
      contentStored: false
    });
    expect(storedArtifact?.metadata).not.toHaveProperty("content");
  });

  it("does not attempt empty artifact content persistence when artifact content store is unavailable", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const adapter = new EmptyContentArtifactAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      adapters: new Map([["fake", adapter]])
    });

    await runner.start(run);

    const [storedArtifact] = await artifacts.listByRun(run.id);
    expect(storedArtifact?.path).toBe(adapter.artifactPath);
    expect(storedArtifact?.metadata).toMatchObject({
      contentStored: false
    });
    expect(storedArtifact?.metadata).not.toHaveProperty("content");
  });

  it("prevents partial artifact commits when later artifact persistence fails", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const adapter = new TwoArtifactAdapter();
    const artifactContent = new ThrowingAfterFirstArtifactContentStore();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      artifactContent,
      adapters: new Map([["fake", adapter]])
    });

    const failed = await runner.start(run);

    expect(failed.status).toBe("failed");
    expect((await runs.get(run.id))?.status).toBe("failed");
    expect(events.items.at(-1)?.type).toBe("run.failed");
    expect((events.items.at(-1)?.payload as { error?: string }).error).toBe("artifact write failed");
    expect(await artifacts.listByRun(run.id)).toHaveLength(0);
    expect(events.items.some((event) => event.type === "artifact.created")).toBe(false);
  });

  it("fails run when adapter artifact path is unsafe and no artifact content store is configured", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const adapter = new UnsafePathArtifactAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      adapters: new Map([["fake", adapter]])
    });

    const failed = await runner.start(run);

    expect(failed.status).toBe("failed");
    expect((await runs.get(run.id))?.status).toBe("failed");
    expect(events.items.at(-1)?.type).toBe("run.failed");
    expect(await artifacts.listByRun(run.id)).toHaveLength(0);
    expect((events.items.at(-1)?.payload as { error?: string }).error).toBe("Artifact path escapes root");
  });

  it("fails run when artifact content persistence throws during terminalization", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const adapter = new ContentfulArtifactAdapter();
    const artifactContent = new ThrowingArtifactContentStore();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      artifactContent,
      adapters: new Map([["fake", adapter]])
    });

    const failed = await runner.start(run);

    expect(failed.status).toBe("failed");
    expect((await runs.get(run.id))?.status).toBe("failed");
    expect(events.items.at(-1)?.type).toBe("run.failed");
    expect((events.items.at(-1)?.payload as { error?: string }).error).toBe("artifact write failed");
    expect(await artifacts.listByRun(run.id)).toHaveLength(0);
  });

  it("publishes completed events after persisting completed run state", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const bus = new EventBus();
    const eventRunStatuses: string[] = [];
    const unsubscribe = bus.subscribe(async () => {
      const persisted = await runs.get(run.id);
      if (persisted?.status === "completed") {
        eventRunStatuses.push(persisted.status);
      }
    });

    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      eventBus: bus,
      adapters: new Map([[
        "fake",
        new EventfulAdapter()
      ]])
    });

    await runner.start(run);
    unsubscribe();

    expect(eventRunStatuses).toEqual(["completed"]);
    expect((await runs.get(run.id))?.status).toBe("completed");
  });

  it("terminalizes adapter startup failures to failed run state", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const adapter = new FailingStartAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([[
        "fake",
        adapter
      ]])
    });

    const failed = await runner.start(run);

    expect(failed.status).toBe("failed");
    expect((await runs.get(run.id))?.status).toBe("failed");
    expect(events.items.at(-1)?.type).toBe("run.failed");
    expect((events.items.at(-1)?.payload as { error?: string }).error).toBe("startup failure");
  });

  it("keeps launch fire-and-forget start calls from creating unhandled rejections", async () => {
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
    const runService = {
      startRun: vi.fn().mockRejectedValue(new Error("launch failed"))
    } as unknown as RunService;
    const launcher = new RunLauncherService(runService);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    launcher.launch(run);

    await Promise.resolve();
    await Promise.resolve();
    process.off("unhandledRejection", onUnhandled);

    expect(unhandled).toHaveLength(0);
    expect(runService.startRun).toHaveBeenCalledWith(run.id);
  });

  it("does not collect artifacts after cancellation", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const adapter = new CancelBeforeCompleteAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      adapters: new Map([[
        "fake",
        adapter
      ]])
    });

    const running = runner.start(run);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runner.cancel(run.id);
    await running;

    expect(adapter.artifactsCalled).toBe(false);
    expect(await artifacts.listByRun(run.id)).toHaveLength(0);
    expect((await runs.get(run.id))?.status).toBe("cancelled");
    expect(events.items.some((event) => event.type === "artifact.created")).toBe(false);
  });

  it("deduplicates persisted artifact ids when adapter returns duplicate artifact ids", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const adapter = new DuplicateArtifactAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      adapters: new Map([[
        "fake",
        adapter
      ]])
    });

    await runner.start(run);

    const storedArtifacts = await artifacts.listByRun(run.id);
    expect(storedArtifacts).toHaveLength(2);
    expect(storedArtifacts[0]!.id).not.toBe(storedArtifacts[1]!.id);
    expect(storedArtifacts[0]?.id.startsWith("artifact_")).toBe(true);
    expect(storedArtifacts[1]?.id.startsWith("artifact_")).toBe(true);
  });

  it("isolates event bus subscriber failures from runtime execution", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const bus = new EventBus();
    const received: SwitchyardEvent[] = [];
    bus.subscribe((event) => {
      received.push(event);
    });
    bus.subscribe(() => {
      throw new Error("subscriber failed");
    });

    const adapter = new EventfulAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      eventBus: bus,
      adapters: new Map([[
        "fake",
        adapter
      ]])
    });

    await runner.start(run);

    expect(received.at(-1)?.type).toBe("run.completed");
    expect(events.items.at(-1)?.type).toBe("run.completed");
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

    expect(received.some((event) => event.type === "artifact.created")).toBe(true);
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

class InMemoryArtifactContentStore {
  readonly writes: Array<{ path: string; content: string }> = [];

  async writeText(path: string, content: string): Promise<string> {
    this.writes.push({ path, content });
    return `stored/${path}`;
  }
}

class ThrowingArtifactContentStore {
  async writeText(): Promise<string> {
    throw new Error("artifact write failed");
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

class ContentfulArtifactAdapter extends NoopAdapter {
  readonly artifactPath = `artifacts/${crypto.randomUUID()}/transcript.jsonl`;
  readonly artifactContent = "{\"type\":\"runtime.output\",\"text\":\"hello\"}\n";

  override async start() {
    return { sessionId: "session_1" };
  }

  override events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    return (async function* () {
      yield {
        id: "event_content_adapter_running",
        type: "runtime.status",
        runId: String(session["runId"]),
        sequence: 99,
        payload: { status: "running" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
      yield {
        id: "event_content_adapter_output",
        type: "runtime.output",
        runId: String(session["runId"]),
        sequence: 100,
        payload: { text: "hello" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
      yield {
        id: "event_content_adapter_completed",
        type: "run.completed",
        runId: String(session["runId"]),
        sequence: 101,
        payload: { status: "completed" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
    })();
  }

  override async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    return [
      {
        id: `adapter_content_${String(session["runId"])}`,
        type: "transcript",
        path: this.artifactPath,
        metadata: {
          content: this.artifactContent,
          source: "unit-test"
        },
        createdAt: "2026-05-11T00:00:00.000Z"
      }
    ];
  }
}

class EmptyContentArtifactAdapter extends NoopAdapter {
  readonly artifactPath = `artifacts/${crypto.randomUUID()}/transcript.jsonl`;
  readonly artifactContent = "";

  override async start() {
    return { sessionId: "session_1" };
  }

  override events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    return (async function* () {
      yield {
        id: "event_content_adapter_running",
        type: "runtime.status",
        runId: String(session["runId"]),
        sequence: 99,
        payload: { status: "running" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
      yield {
        id: "event_content_adapter_output",
        type: "runtime.output",
        runId: String(session["runId"]),
        sequence: 100,
        payload: { text: "hello" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
      yield {
        id: "event_content_adapter_completed",
        type: "run.completed",
        runId: String(session["runId"]),
        sequence: 101,
        payload: { status: "completed" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
    })();
  }

  override async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    return [
      {
        id: `adapter_empty_${String(session["runId"])}`,
        type: "transcript",
        path: this.artifactPath,
        metadata: {
          content: this.artifactContent
        },
        createdAt: "2026-05-11T00:00:00.000Z"
      }
    ];
  }
}

class UnsafePathArtifactAdapter extends EventfulAdapter {
  readonly artifactPath = "../unsafe/transcript.jsonl";

  override async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    return [
      {
        id: `adapter_unsafe_${String(session["runId"])}`,
        type: "transcript",
        path: this.artifactPath,
        metadata: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      }
    ];
  }
}

class FailingStartAdapter extends EventfulAdapter {
  override async start(request: Record<string, unknown>) {
    this.startedWith = request;
    throw new Error("startup failure");
  }
}

class DuplicateArtifactAdapter extends EventfulAdapter {
  override async artifacts(_session: Record<string, unknown>): Promise<Artifact[]> {
    return [
      {
        id: "artifact_duplicate",
        type: "transcript",
        path: "artifacts/duplicate/transcript.jsonl",
        metadata: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      {
        id: "artifact_duplicate",
        type: "transcript",
        path: "artifacts/duplicate/transcript-2.jsonl",
        metadata: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      }
    ];
  }
}

class CancelBeforeCompleteAdapter extends EventfulAdapter {
  artifactsCalled = false;

  override async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    this.artifactsCalled = true;
    return [{
      id: `artifact_cancel_${String(session["runId"])}`,
      type: "transcript",
      path: "artifacts/cancelled/transcript.jsonl",
      metadata: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    }];
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
      await new Promise((resolve) => setTimeout(resolve, 30));
      yield {
        id: "event_adapter_completed",
        type: "run.completed",
        runId: String(session["runId"]),
        sequence: 100,
        payload: { status: "completed" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
    })();
  }
}

class TwoArtifactAdapter extends EventfulAdapter {
  readonly firstArtifactPath = `artifacts/${crypto.randomUUID()}/first.jsonl`;
  readonly secondArtifactPath = `artifacts/${crypto.randomUUID()}/second.jsonl`;

  override async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    return [
      {
        id: `adapter_two_${String(session["runId"])}_first`,
        type: "transcript",
        path: this.firstArtifactPath,
        metadata: {
          content: "{\"type\":\"runtime.output\",\"text\":\"first\"}\n"
        },
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      {
        id: `adapter_two_${String(session["runId"])}_second`,
        type: "transcript",
        path: this.secondArtifactPath,
        metadata: {
          content: "{\"type\":\"runtime.output\",\"text\":\"second\"}\n"
        },
        createdAt: "2026-05-11T00:00:00.000Z"
      }
    ];
  }
}

class ThrowingAfterFirstArtifactContentStore {
  readonly writes: Array<{ path: string; content: string }> = [];

  async writeText(path: string, content: string): Promise<string> {
    this.writes.push({ path, content });
    if (this.writes.length > 1) {
      throw new Error("artifact write failed");
    }
    return `stored/${path}`;
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
