import { describe, expect, it } from "vitest";
import {
  createNotImplementedError,
  EventBus,
  RunService
} from "../src/index.js";
import type { EventPublisher, EventStore, RunStore, RuntimeAdapter } from "../src/index.js";
import type { Run, SwitchyardEvent } from "@switchyard/contracts";

describe("core service shells", () => {
  it("creates domain not-implemented errors with stable codes", () => {
    const error = createNotImplementedError("debate-service", "startRound");

    expect(error.code).toBe("adapter_protocol_failed");
    expect(error.message).toContain("debate-service.startRound");
  });

  it("run service creates a queued run and emits an event through ports", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const adapter = new NoopAdapter();
    const service = new RunService({ runs, events, adapters: new Map([["fake", adapter]]) });

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
    const adapter = new EventfulAdapter();
    const service = new RunService({ runs, events, adapters: new Map([["fake", adapter]]) });
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

  override async start(request: Record<string, unknown>) {
    this.startedWith = request;
    return { sessionId: "session_1" };
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
