import { describe, expect, it, vi } from "vitest";
import {
  AdapterProtocolError,
  createNotImplementedError,
  EventBus,
  RegistryService,
  RuntimeCapabilityService,
  RuntimeDoctorService,
  RuntimeRunnerService,
  RunLauncherService,
  RunService,
  TimeoutError,
  withTimeout
} from "../src/index.js";
import type {
  ArtifactStore,
  EventStore,
  RegistryStore,
  RunStore,
  RuntimeAdapter,
  RuntimeAdapterManifest,
  SessionStore
} from "../src/index.js";
import type {
  Artifact,
  Run,
  RuntimeAvailability,
  RuntimeDoctorCheck,
  RuntimeMode,
  RuntimeSession,
  RuntimeTarget,
  SwitchyardEvent
} from "@switchyard/contracts";

describe("core service shells", () => {
  it("creates domain not-implemented errors with stable codes", () => {
    const error = createNotImplementedError("debate-service", "startRound");

    expect(error.code).toBe("adapter_protocol_failed");
    expect(error.message).toContain("debate-service.startRound");
  });

  it("creates adapter protocol errors with stable code and optional reason code", () => {
    const error = new AdapterProtocolError("unsupported input", {
      reasonCode: "generic_http_input_unsupported"
    });
    expect(error.code).toBe("adapter_protocol_failed");
    expect(error.reasonCode).toBe("generic_http_input_unsupported");
    expect(error.message).toBe("unsupported input");
  });

  it("withTimeout resolves successful promises and rejects hung promises with TimeoutError", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50)).resolves.toBe("ok");
    await expect(withTimeout(new Promise(() => undefined), 10)).rejects.toBeInstanceOf(TimeoutError);
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
    expect(cancelled.status).toBe("completed");
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
    expect(events.items.some((event) => event.type === "run.completed")).toBe(true);
    expect(events.items.some((event) => event.type === "artifact.created")).toBe(true);
  });

  it("emits terminal event before artifact.created with unique increasing sequence values", async () => {
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
    expect(completedIndex).toBeLessThan(artifactIndex);
    expect(new Set(sequences).size).toBe(sequences.length);
    const sorted = [...sequences].sort((a, b) => a - b);
    expect(sequences).toEqual(sorted);
  });

  it("persists and publishes run.completed before slow artifact persistence finishes", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new BlockingArtifactStore();
    const bus = new EventBus();
    const publishedTypes: string[] = [];
    const unsubscribe = bus.subscribe((event) => {
      publishedTypes.push(event.type);
    });
    const adapter = new ContentfulArtifactAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      eventBus: bus,
      adapters: new Map([["fake", adapter]])
    });

    const startPromise = runner.start(run);
    await waitFor(() => events.items.some((event) => event.type === "run.completed"));

    expect((await runs.get(run.id))?.status).toBe("completed");
    expect(publishedTypes).toContain("run.completed");
    expect(events.items.some((event) => event.type === "artifact.created")).toBe(false);

    artifacts.release();
    await startPromise;
    unsubscribe();

    expect(events.items.some((event) => event.type === "artifact.created")).toBe(true);
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

    const completed = await runner.start(run);

    expect(completed.status).toBe("completed");
    expect((await runs.get(run.id))?.status).toBe("completed");
    expect(events.items.some((event) => event.type === "run.completed")).toBe(true);
    expect(await artifacts.listByRun(run.id)).toHaveLength(0);
    expect(events.items.some((event) => event.type === "artifact.created")).toBe(false);
  });

  it("keeps completed run state when adapter artifact path is unsafe after terminalization", async () => {
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

    const completed = await runner.start(run);

    expect(completed.status).toBe("completed");
    expect((await runs.get(run.id))?.status).toBe("completed");
    expect(events.items.some((event) => event.type === "run.completed")).toBe(true);
    expect(await artifacts.listByRun(run.id)).toHaveLength(0);
  });

  it("keeps completed run state when artifact content persistence throws after terminalization", async () => {
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

    const completed = await runner.start(run);

    expect(completed.status).toBe("completed");
    expect((await runs.get(run.id))?.status).toBe("completed");
    expect(events.items.some((event) => event.type === "run.completed")).toBe(true);
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

    expect(eventRunStatuses.length).toBeGreaterThanOrEqual(1);
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

  it("times out runs when an adapter never emits an event", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const adapter = new HangingAdapter();
    const run = await createStoredRun(runs, { timeoutSeconds: 0.01 });
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", adapter]])
    });

    const timedOut = await runner.start(run);

    expect(timedOut.status).toBe("timeout");
    expect((await runs.get(run.id))?.status).toBe("timeout");
    expect((await sessions.getByRunId(run.id))?.status).toBe("failed");
    expect(adapter.cancelledSession?.["runId"]).toBe(run.id);
    expect(events.items.at(-1)).toMatchObject({
      type: "run.failed",
      payload: {
        status: "timeout",
        error: "runtime_timeout",
        timeoutSeconds: 0.01
      }
    });
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

    expect(received.some((event) => event.type === "run.completed")).toBe(true);
    expect(events.items.some((event) => event.type === "run.completed")).toBe(true);
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
    const adapter = new CancelBeforeCompleteAdapter();
    const run = await createStoredRun(runs);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", adapter]])
    });
    const running = runner.start(run);
    await waitFor(() => sessions.items.size > 0);
    const cancelled = await runner.cancel(run.id);
    await running;

    expect(adapter.cancelledSession?.["runId"]).toBe(run.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await sessions.getByRunId(run.id))?.status).toBe("cancelled");
    expect(events.items.some((event) => event.type === "run.cancelled")).toBe(true);
  });

  it("terminalizes adapter-emitted run.cancelled events and persists transcript artifacts", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const artifacts = new MemoryArtifactStore();
    const artifactContent = new InMemoryArtifactContentStore();
    const run = await createStoredRun(runs);
    const adapter = new CancelledEventAdapter();
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      artifacts,
      artifactContent,
      adapters: new Map([["fake", adapter]])
    });

    const terminal = await runner.start(run);

    expect(terminal.status).toBe("cancelled");
    expect((await sessions.getByRunId(run.id))?.status).toBe("cancelled");
    const terminalEvents = events.items.filter((event) => event.type === "run.cancelled");
    expect(terminalEvents).toHaveLength(1);
    expect(await artifacts.listByRun(run.id)).toHaveLength(1);
    expect(artifactContent.writes).toHaveLength(1);
  });

  it("keeps run state unchanged when adapter cancel throws AdapterProtocolError", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const run = await createStoredRun(runs);
    const adapter = new CancelFailureAdapter();
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", adapter]])
    });
    const running = runner.start(run);
    await waitFor(() => sessions.items.size > 0);

    await expect(runner.cancel(run.id)).rejects.toBeInstanceOf(AdapterProtocolError);
    await running;

    expect((await runs.get(run.id))?.status).toBe("completed");
    expect((await sessions.getByRunId(run.id))?.status).toBe("completed");
  });

  it("treats cancel on already terminal runs as idempotent and skips adapter cancel", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const run = await createStoredRun(runs);
    const adapter = new EventfulAdapter();
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", adapter]])
    });
    await runner.start(run);
    const callsBefore = adapter.cancelCalls;

    const result = await runner.cancel(run.id);

    expect(result.status).toBe("completed");
    expect(adapter.cancelCalls).toBe(callsBefore);
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

  it("seeds runtime modes from manifests and supports docsPath omissions", async () => {
    const registry = new MemoryRegistryStore();
    const service = new RuntimeCapabilityService({
      registry,
      clock: () => "2026-05-29T00:00:00.000Z"
    });

    await service.seedManifests([fakeRuntimeManifest, { ...codexRuntimeManifest, docsPath: undefined }], {
      "fake.deterministic": {
        state: "available",
        canRun: true,
        installed: true,
        auth: "not_required",
        version: null,
        checkedAt: "2026-05-29T00:00:00.000Z",
        reasonCode: null,
        message: null
      }
    });

    const fake = await registry.getRuntimeMode("fake.deterministic");
    const codex = await registry.getRuntimeMode("runtime_mode_codex_exec_json");
    expect(fake?.slug).toBe("fake.deterministic");
    expect(fake?.availability.state).toBe("available");
    expect(codex?.slug).toBe("codex.exec_json");
    expect(codex?.docsPath).toBeUndefined();
    expect(codex?.status).toBe("unknown");
  });

  it("maps codex checks to unavailable, partial, timeout, output bounds, and unsupported states", async () => {
    const registry = new MemoryRegistryStore();
    const capabilityService = new RuntimeCapabilityService({
      registry,
      clock: () => "2026-05-29T00:00:00.000Z"
    });
    await capabilityService.seedManifests([codexRuntimeManifest, fakeRuntimeManifest]);

    const emptyModelsAdapter = new ManifestTestAdapter(codexRuntimeManifest, async () => ({
      ok: true,
      details: { version: "codex 0.130.0", models: [] }
    }));
    const partialAdapter = new ManifestTestAdapter(codexRuntimeManifest, async () => ({
      ok: true,
      details: {
        version: "codex 0.130.0",
        models: [{ slug: "gpt-5.5" }],
        optionalChecks: {
          sandbox_policy_probe: { ok: false, message: "optional probe failed" }
        }
      }
    }));
    const hugeOutputAdapter = new ManifestTestAdapter(codexRuntimeManifest, async () => ({
      ok: false,
      message: "x".repeat(256),
      details: { reasonCode: "binary_unavailable", outputBytes: 256 }
    }));
    const hangingAdapter = new ManifestTestAdapter(codexRuntimeManifest, async () => await new Promise(() => undefined));

    const unavailableDoctor = new RuntimeDoctorService({
      registry,
      adapters: new Map([["codex", emptyModelsAdapter], ["fake", new ManifestTestAdapter(fakeRuntimeManifest, async () => ({ ok: true }))]]),
      clock: () => "2026-05-29T00:00:00.000Z",
      checkTimeoutMs: 20,
      maxDiagnosticBytes: 64
    });
    const unavailable = await unavailableDoctor.checkRuntimeMode("codex.exec_json");
    expect(unavailable.state).toBe("unavailable");
    expect(unavailable.reasonCode).toBe("model_catalog_unavailable");
    expect(unavailable.installed).toBe(true);

    const partialDoctor = new RuntimeDoctorService({
      registry,
      adapters: new Map([["codex", partialAdapter], ["fake", new ManifestTestAdapter(fakeRuntimeManifest, async () => ({ ok: true }))]]),
      clock: () => "2026-05-29T00:00:01.000Z",
      checkTimeoutMs: 20,
      maxDiagnosticBytes: 64
    });
    const partial = await partialDoctor.checkRuntimeMode("runtime_mode_codex_exec_json");
    expect(partial.state).toBe("partial");
    expect(partial.canRun).toBe(true);
    expect(partial.reasonCode).toBe("optional_check_failed");

    const boundedDoctor = new RuntimeDoctorService({
      registry,
      adapters: new Map([["codex", hugeOutputAdapter]]),
      clock: () => "2026-05-29T00:00:02.000Z",
      checkTimeoutMs: 20,
      maxDiagnosticBytes: 64
    });
    const bounded = await boundedDoctor.checkRuntimeMode("codex.exec_json");
    expect(bounded.reasonCode).toBe("check_output_too_large");
    expect(bounded.diagnostics[0]?.message.length ?? 0).toBeLessThanOrEqual(70);

    const timeoutDoctor = new RuntimeDoctorService({
      registry,
      adapters: new Map([["codex", hangingAdapter]]),
      clock: () => "2026-05-29T00:00:03.000Z",
      checkTimeoutMs: 20,
      maxDiagnosticBytes: 64
    });
    const timedOut = await timeoutDoctor.checkRuntimeMode("codex.exec_json");
    expect(timedOut.state).toBe("unknown");
    expect(timedOut.reasonCode).toBe("check_timeout");

    await registry.upsertRuntimeMode({
      ...(await registry.getRuntimeMode("runtime_mode_codex_exec_json"))!,
      id: "runtime_mode_unregistered",
      slug: "codex.unregistered",
      adapterId: "missing"
    });
    const unsupportedDoctor = new RuntimeDoctorService({
      registry,
      adapters: new Map([["codex", partialAdapter]]),
      clock: () => "2026-05-29T00:00:04.000Z"
    });
    const unsupported = await unsupportedDoctor.checkRuntimeMode("runtime_mode_unregistered");
    expect(unsupported.state).toBe("unsupported");
    expect(unsupported.reasonCode).toBe("adapter_not_registered");
  });

  it("maps generic_http http_health checks from adapter-provided availability details", async () => {
    const registry = new MemoryRegistryStore();
    const capabilityService = new RuntimeCapabilityService({
      registry,
      clock: () => "2026-05-29T00:00:00.000Z"
    });
    await capabilityService.seedManifests([genericHttpRuntimeManifest]);

    const token = "secret-r4-token";
    const adapter = new ManifestTestAdapter(genericHttpRuntimeManifest, async () => ({
      ok: true,
      details: {
        availability: {
          state: "available",
          canRun: true,
          installed: true,
          auth: "configured",
          reasonCode: null,
          message: `Bearer ${token} should be redacted`,
          version: "wrapper-v1"
        },
        diagnostics: [
          {
            code: "health_ok",
            severity: "info",
            message: `token=${token}`
          }
        ]
      }
    }));
    const loggerEntries: Array<Record<string, unknown>> = [];
    const doctor = new RuntimeDoctorService({
      registry,
      adapters: new Map([["generic_http", adapter]]),
      clock: () => "2026-05-29T00:00:10.000Z",
      checkTimeoutMs: 20,
      maxDiagnosticBytes: 256,
      logger: {
        info: (_event: string, payload?: Record<string, unknown>) => {
          if (payload) loggerEntries.push(payload);
        },
        warn: (_event: string, payload?: Record<string, unknown>) => {
          if (payload) loggerEntries.push(payload);
        },
        error: (_event: string, payload?: Record<string, unknown>) => {
          if (payload) loggerEntries.push(payload);
        }
      }
    });

    const check = await doctor.checkRuntimeMode("generic_http.async_rest");

    expect(check.state).toBe("available");
    expect(check.canRun).toBe(true);
    expect(check.auth).toBe("configured");
    expect(check.version).toBe("wrapper-v1");
    expect(check.message).not.toContain(token);
    expect(check.diagnostics[0]?.message ?? "").not.toContain(token);
    expect(JSON.stringify(check)).not.toContain(token);
    expect(JSON.stringify(loggerEntries)).not.toContain(token);
  });

  it("validates runtime mode inference and rejects runtime mode ids/mismatches", async () => {
    const registry = new MemoryRegistryStore();
    const capabilityService = new RuntimeCapabilityService({
      registry,
      clock: () => "2026-05-29T00:00:00.000Z"
    });
    await capabilityService.seedManifests([fakeRuntimeManifest, codexRuntimeManifest]);

    const service = new RegistryService({ registry });
    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "fake",
        provider: "test",
        adapterType: "process"
      })
    ).resolves.toBe("fake.deterministic");
    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "codex",
        provider: "openai",
        adapterType: "process"
      })
    ).resolves.toBe("codex.exec_json");
    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "fake",
        provider: "test",
        adapterType: "process",
        runtimeMode: "runtime_mode_codex_exec_json"
      })
    ).rejects.toMatchObject({ code: "invalid_input", details: [{ path: "runtimeMode", issue: expect.any(String) }] });
    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "fake",
        provider: "test",
        adapterType: "process",
        runtimeMode: "codex.exec_json"
      })
    ).rejects.toMatchObject({ code: "invalid_input", details: [{ path: "runtimeMode", issue: expect.any(String) }] });
  });

  it("stores runtimeMode on runs when provided and preserves old behavior when absent", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", new ManifestTestAdapter(fakeRuntimeManifest, async () => ({ ok: true }))]])
    });
    const service = new RunService({ runs, events, runner });

    const withMode = await service.createRun({
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "run with mode",
      placement: "local",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic"
    });
    const withoutMode = await service.createRun({
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "run without mode",
      placement: "local",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {}
    });

    expect(withMode.runtimeMode).toBe("fake.deterministic");
    expect(withoutMode.runtimeMode).toBeUndefined();
    expect((await runs.get(withMode.id))?.runtimeMode).toBe("fake.deterministic");
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

class BlockingArtifactStore extends MemoryArtifactStore {
  private released = false;
  private resolveRelease: (() => void) | undefined;
  private readonly releasePromise = new Promise<void>((resolve) => {
    this.resolveRelease = resolve;
  });

  override async create(artifact: Artifact): Promise<Artifact> {
    if (!this.released) {
      await this.releasePromise;
    }
    return super.create(artifact);
  }

  release(): void {
    this.released = true;
    this.resolveRelease?.();
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
  readonly manifest: RuntimeAdapterManifest = {
    adapterId: "fake",
    providerId: "provider_test",
    runtimeId: "runtime_fake",
    runtimeModeId: "runtime_mode_fake_deterministic",
    runtimeModeSlug: "fake.deterministic",
    name: "Fake deterministic runtime",
    adapterType: "process",
    kind: "deterministic_fake",
    capabilities: ["run.start", "run.cancel", "event.normalized", "event.streaming", "artifact.transcript", "tool.fake_echo", "auth.none"],
    limitations: [{ code: "deterministic_only", message: "Deterministic test adapter." }],
    placement: {
      local: { support: "supported", reason: "In-memory tests." },
      hosted: { support: "unsupported", reason: "Not implemented in tests." },
      connectedLocalNode: { support: "future", reason: "Not implemented in tests." }
    },
    check: {
      strategy: "none",
      required: [],
      optional: []
    }
  };

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
  cancelCalls = 0;

  override async start(request: Record<string, unknown>) {
    this.startedWith = request;
    return { sessionId: "session_1" };
  }

  override async send(session: Record<string, unknown>, input: Record<string, unknown>) {
    this.sentSession = session;
    this.sentInput = input;
  }

  override async cancel(session: Record<string, unknown>) {
    this.cancelCalls += 1;
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

class HangingAdapter extends EventfulAdapter {
  override events(): AsyncIterable<SwitchyardEvent> {
    return (async function* () {
      await new Promise(() => undefined);
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

const unknownAvailability: RuntimeAvailability = {
  state: "unknown",
  canRun: false,
  installed: false,
  auth: "unknown",
  version: null,
  checkedAt: "2026-05-29T00:00:00.000Z",
  reasonCode: null,
  message: null
};

const fakeRuntimeManifest: RuntimeAdapterManifest = {
  adapterId: "fake",
  providerId: "provider_test",
  runtimeId: "runtime_fake",
  runtimeModeId: "runtime_mode_fake_deterministic",
  runtimeModeSlug: "fake.deterministic",
  name: "Fake deterministic runtime",
  adapterType: "process",
  kind: "deterministic_fake",
  capabilities: ["run.start", "run.cancel", "event.normalized", "event.streaming", "artifact.transcript", "tool.fake_echo", "auth.none"],
  limitations: [
    {
      code: "deterministic_only",
      message: "Outputs are fixed for local smoke and contract tests."
    }
  ],
  placement: {
    local: { support: "supported", reason: "In-process deterministic test adapter." },
    hosted: { support: "unsupported", reason: "Hosted worker execution is not shipped in R3." },
    connectedLocalNode: { support: "future", reason: "Hybrid node execution is planned for R10." }
  },
  check: {
    strategy: "none",
    required: [],
    optional: []
  }
};

const codexRuntimeManifest: RuntimeAdapterManifest = {
  adapterId: "codex",
  providerId: "provider_openai",
  runtimeId: "runtime_codex",
  runtimeModeId: "runtime_mode_codex_exec_json",
  runtimeModeSlug: "codex.exec_json",
  name: "Codex exec JSON",
  adapterType: "process",
  kind: "one_shot_process",
  capabilities: [
    "run.start",
    "run.cancel",
    "run.timeout",
    "event.normalized",
    "event.streaming",
    "artifact.transcript",
    "artifact.raw_transcript",
    "model.catalog",
    "auth.local",
    "sandbox.read_only",
    "sandbox.workspace_write",
    "sandbox.danger_full_access"
  ],
  limitations: [
    { code: "one_shot_no_input", message: "codex.exec_json does not support post-start input." },
    { code: "local_only", message: "This mode runs a local Codex CLI process and is not hosted-safe in R3." }
  ],
  placement: {
    local: { support: "supported", reason: "Requires a PATH-reachable local codex binary and local workspace." },
    hosted: { support: "unsupported", reason: "Hosted subprocess execution is not shipped in R3." },
    connectedLocalNode: { support: "future", reason: "Hybrid node execution is planned for R10." }
  },
  docsPath: "docs/development/adapters/CODEX.md",
  check: {
    strategy: "binary_version_and_model_catalog",
    required: ["binary_version", "model_catalog"],
    optional: ["sandbox_policy_probe"]
  }
};

const genericHttpRuntimeManifest: RuntimeAdapterManifest = {
  adapterId: "generic_http",
  providerId: "provider_generic_http",
  runtimeId: "runtime_generic_http",
  runtimeModeId: "runtime_mode_generic_http_async_rest",
  runtimeModeSlug: "generic_http.async_rest",
  name: "Generic HTTP async REST",
  adapterType: "http",
  kind: "async_rest",
  capabilities: [
    "run.start",
    "run.cancel",
    "run.timeout",
    "event.normalized",
    "event.streaming",
    "artifact.transcript",
    "auth.none",
    "auth.api_key"
  ],
  limitations: [
    { code: "no_post_start_input", message: "generic_http.async_rest does not support post-start input in R4." }
  ],
  placement: {
    local: { support: "conditional", reason: "Requires configured base URL." },
    hosted: { support: "future", reason: "Hosted execution is not shipped in R4." },
    connectedLocalNode: { support: "future", reason: "Hybrid node execution is not shipped in R4." }
  },
  docsPath: "docs/development/adapters/GENERIC_HTTP.md",
  check: {
    strategy: "http_health",
    required: ["base_url_configured", "http_health"],
    optional: ["auth_token_present"]
  }
};

class CancelledEventAdapter extends EventfulAdapter {
  override events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    return (async function* () {
      yield {
        id: "event_adapter_cancelled",
        type: "run.cancelled",
        runId: String(session["runId"]),
        sequence: 99,
        payload: { status: "cancelled" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
    })();
  }

  override async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    return [
      {
        id: `adapter_cancelled_${String(session["runId"])}`,
        type: "transcript",
        path: `artifacts/${String(session["runId"])}/cancelled-transcript.jsonl`,
        metadata: {
          content: "{\"type\":\"run.cancelled\"}\n"
        },
        createdAt: "2026-05-11T00:00:00.000Z"
      }
    ];
  }
}

class CancelFailureAdapter extends EventfulAdapter {
  override async cancel(): Promise<void> {
    throw new AdapterProtocolError("cancel failed", { reasonCode: "generic_http_cancel_failed" });
  }

  override events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    return (async function* () {
      yield {
        id: "event_cancel_failure_running",
        type: "runtime.status",
        runId: String(session["runId"]),
        sequence: 99,
        payload: { status: "running" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield {
        id: "event_cancel_failure_completed",
        type: "run.completed",
        runId: String(session["runId"]),
        sequence: 100,
        payload: { status: "completed" },
        createdAt: "2026-05-11T00:00:00.000Z"
      };
    })();
  }
}

class ManifestTestAdapter extends NoopAdapter {
  override readonly id: string;
  readonly manifest: RuntimeAdapterManifest;
  private readonly impl: () => Promise<{ ok: boolean; message?: string; details?: Record<string, unknown> }>;

  constructor(
    manifest: RuntimeAdapterManifest,
    checkImpl: () => Promise<{ ok: boolean; message?: string; details?: Record<string, unknown> }>
  ) {
    super();
    this.manifest = manifest;
    this.id = manifest.adapterId;
    this.impl = checkImpl;
  }

  override async check(): Promise<{ ok: boolean; message?: string; details?: Record<string, unknown> }> {
    return this.impl();
  }
}

class MemoryRegistryStore implements RegistryStore {
  readonly providers = new Map<string, { id: string; name: string; authMode: "none" | "local" | "api_key" | "oauth" | "custom"; status: "available" | "unavailable" | "degraded" | "unknown" }>();
  readonly runtimes = new Map<string, RuntimeTarget>();
  readonly models = new Map<string, { id: string; providerId: string; modelName: string; supportsTools: boolean; supportsStreaming: boolean; supportsBrowser: boolean; status: "available" | "unavailable" | "degraded" | "unknown" }>();
  readonly runtimeModes = new Map<string, RuntimeMode>();
  readonly runtimeModesBySlug = new Map<string, string>();

  async createProvider(provider: { id: string; name: string; authMode: "none" | "local" | "api_key" | "oauth" | "custom"; status: "available" | "unavailable" | "degraded" | "unknown" }) {
    this.providers.set(provider.id, provider);
    return provider;
  }

  async createRuntime(runtime: RuntimeTarget): Promise<RuntimeTarget> {
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }

  async createModel(model: { id: string; providerId: string; modelName: string; supportsTools: boolean; supportsStreaming: boolean; supportsBrowser: boolean; status: "available" | "unavailable" | "degraded" | "unknown" }) {
    this.models.set(model.id, model);
    return model;
  }

  async getProvider(id: string) {
    return this.providers.get(id);
  }

  async getRuntime(id: string): Promise<RuntimeTarget | undefined> {
    return this.runtimes.get(id);
  }

  async getModel(id: string) {
    return this.models.get(id);
  }

  async listProviders(_filter: { limit: number; before?: { id: string } | undefined }) {
    return { providers: [...this.providers.values()], nextCursor: null };
  }

  async listRuntimes(_filter: { providerIds?: readonly string[]; adapterType?: readonly string[]; limit: number; before?: { id: string } | undefined }) {
    return { runtimes: [...this.runtimes.values()], nextCursor: null };
  }

  async listModels(_filter: { providerIds?: readonly string[]; limit: number; before?: { id: string } | undefined }) {
    return { models: [...this.models.values()], nextCursor: null };
  }

  async upsertRuntimeMode(mode: RuntimeMode): Promise<RuntimeMode> {
    this.runtimeModes.set(mode.id, mode);
    this.runtimeModesBySlug.set(mode.slug, mode.id);
    return mode;
  }

  async getRuntimeMode(idOrSlug: string): Promise<RuntimeMode | undefined> {
    if (idOrSlug.startsWith("runtime_mode_")) {
      return this.runtimeModes.get(idOrSlug);
    }
    const id = this.runtimeModesBySlug.get(idOrSlug);
    return id ? this.runtimeModes.get(id) : undefined;
  }

  async listRuntimeModes(_filter: {
    providerIds?: readonly string[];
    runtimeIds?: readonly string[];
    adapterType?: readonly string[];
    kind?: readonly string[];
    availability?: readonly string[];
    placement?: readonly string[];
    capability?: readonly string[];
    limit: number;
    before?: { id: string } | undefined;
  }): Promise<{ runtimeModes: RuntimeMode[]; nextCursor: { id: string } | null }> {
    return {
      runtimeModes: [...this.runtimeModes.values()],
      nextCursor: null
    };
  }

  async updateRuntimeModeAvailability(idOrSlug: string, availability: RuntimeAvailability): Promise<RuntimeMode | undefined> {
    const mode = await this.getRuntimeMode(idOrSlug);
    if (!mode) {
      return undefined;
    }
    const updated: RuntimeMode = {
      ...mode,
      availability,
      status: availability.state,
      updatedAt: availability.checkedAt
    };
    await this.upsertRuntimeMode(updated);
    return updated;
  }
}

async function createStoredRun(runs: RunStore, overrides: Partial<Run> = {}): Promise<Run> {
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
    createdAt: "2026-05-11T00:00:00.000Z",
    ...overrides
  };
  await runs.create(run);
  return run;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
