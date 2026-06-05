import { describe, expect, it } from "vitest";
import type { SwitchyardEvent } from "@switchyard/contracts";
import { EventBus } from "@switchyard/core";
import {
  formatSseEvent,
  formatSseHeartbeat,
  formatSseIdleClose,
  streamRunEvents
} from "../src/index.js";

function makeEvent(overrides: Partial<SwitchyardEvent> & { id: string; type: SwitchyardEvent["type"]; sequence: number }): SwitchyardEvent {
  return {
    runId: "run_test",
    payload: {},
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides
  } as SwitchyardEvent;
}

class FakeWritable {
  readonly chunks: string[] = [];
  ended = false;
  private closeListener?: () => void;

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  on(event: "close", listener: () => void): void {
    if (event === "close") this.closeListener = listener;
  }
  simulateClose(): void {
    this.closeListener?.();
  }
  body(): string {
    return this.chunks.join("");
  }
}

class ManualClock {
  now = 0;
  private nextHandle = 1;
  intervals = new Map<number, { fn: () => void; ms: number; nextAt: number }>();
  timeouts = new Map<number, { fn: () => void; firesAt: number }>();

  setInterval = (fn: () => void, ms: number): number => {
    const handle = this.nextHandle++;
    this.intervals.set(handle, { fn, ms, nextAt: this.now + ms });
    return handle;
  };
  clearInterval = (handle: unknown): void => {
    if (typeof handle === "number") this.intervals.delete(handle);
  };
  setTimeout = (fn: () => void, ms: number): number => {
    const handle = this.nextHandle++;
    this.timeouts.set(handle, { fn, firesAt: this.now + ms });
    return handle;
  };
  clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.timeouts.delete(handle);
  };
  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const candidates: Array<{ at: number; fire: () => void; reschedule?: () => void; handle: number; kind: "interval" | "timeout" }> = [];
      for (const [handle, info] of this.intervals) {
        if (info.nextAt <= target) {
          candidates.push({
            at: info.nextAt,
            fire: info.fn,
            reschedule: () => {
              const current = this.intervals.get(handle);
              if (current) current.nextAt += current.ms;
            },
            handle,
            kind: "interval"
          });
        }
      }
      for (const [handle, info] of this.timeouts) {
        if (info.firesAt <= target) {
          candidates.push({
            at: info.firesAt,
            fire: info.fn,
            handle,
            kind: "timeout"
          });
        }
      }
      if (candidates.length === 0) break;
      candidates.sort((left, right) => left.at - right.at);
      const next = candidates[0]!;
      this.now = next.at;
      if (next.kind === "timeout") {
        this.timeouts.delete(next.handle);
      }
      next.fire();
      if (next.reschedule) next.reschedule();
    }
    this.now = target;
  }
}

describe("streamRunEvents", () => {
  it("replay-only mode emits replay and closes", async () => {
    const destination = new FakeWritable();
    const replay = [makeEvent({ id: "event_a", type: "run.queued", sequence: 0 })];
    const handle = streamRunEvents({
      runId: "run_test",
      replay,
      destination,
      live: false
    });
    await handle.finished;
    expect(destination.ended).toBe(true);
    expect(destination.body()).toBe(formatSseEvent(replay[0]!));
  });

  it("bounded stopAfter closes after N total events", async () => {
    const destination = new FakeWritable();
    const replay = [
      makeEvent({ id: "event_a", type: "run.queued", sequence: 0 }),
      makeEvent({ id: "event_b", type: "run.started", sequence: 1 })
    ];
    const eventBus = new EventBus();
    const handle = streamRunEvents({
      runId: "run_test",
      replay,
      destination,
      live: true,
      stopAfter: 2,
      eventBus
    });
    await handle.finished;
    expect(destination.ended).toBe(true);
    const matches = destination.body().match(/^event: /gm)?.length ?? 0;
    expect(matches).toBe(2);
  });

  it("replay-then-live streams events as they reach the event bus", async () => {
    const destination = new FakeWritable();
    const replay = [makeEvent({ id: "event_a", type: "run.queued", sequence: 0 })];
    const eventBus = new EventBus();
    const handle = streamRunEvents({
      runId: "run_test",
      replay,
      destination,
      live: true,
      stopAfter: 3,
      eventBus
    });
    await eventBus.publish(makeEvent({ id: "event_b", type: "run.started", sequence: 1 }));
    await eventBus.publish(makeEvent({ id: "event_c", type: "run.completed", sequence: 2, payload: { status: "completed" } }));
    await handle.finished;
    expect(destination.body()).toContain("event: run.queued");
    expect(destination.body()).toContain("event: run.started");
    expect(destination.body()).toContain("event: run.completed");
  });

  it("Last-Event-ID resumption skips already-delivered replay", async () => {
    const destination = new FakeWritable();
    const replay = [
      makeEvent({ id: "event_a", type: "run.queued", sequence: 0 }),
      makeEvent({ id: "event_b", type: "run.started", sequence: 1 }),
      makeEvent({ id: "event_c", type: "run.completed", sequence: 2 })
    ];
    const handle = streamRunEvents({
      runId: "run_test",
      replay,
      destination,
      live: false,
      lastEventId: "event_a"
    });
    await handle.finished;
    expect(destination.body()).not.toContain("event: run.queued");
    expect(destination.body()).toContain("event: run.started");
    expect(destination.body()).toContain("event: run.completed");
  });

  it("emits heartbeat on the configured interval and idle-closes after the idle window", async () => {
    const destination = new FakeWritable();
    const eventBus = new EventBus();
    const clock = new ManualClock();
    const handle = streamRunEvents({
      runId: "run_test",
      replay: [],
      destination,
      live: true,
      eventBus,
      heartbeatIntervalMs: 15_000,
      idleTimeoutMs: 5 * 60 * 1000,
      setIntervalFn: clock.setInterval as unknown as typeof setInterval,
      clearIntervalFn: clock.clearInterval as unknown as typeof clearInterval,
      setTimeoutFn: clock.setTimeout as unknown as typeof setTimeout,
      clearTimeoutFn: clock.clearTimeout as unknown as typeof clearTimeout
    });
    clock.advance(15_000);
    expect(destination.body()).toContain(formatSseHeartbeat());
    clock.advance(15_000);
    const heartbeatCount = destination.body().match(/:\n\n/g)?.length ?? 0;
    expect(heartbeatCount).toBeGreaterThanOrEqual(2);
    clock.advance(5 * 60 * 1000);
    await handle.finished;
    expect(destination.body()).toContain(formatSseIdleClose());
    expect(destination.ended).toBe(true);
  });

  it("releases the event bus subscription on client disconnect", async () => {
    const destination = new FakeWritable();
    const eventBus = new EventBus();
    streamRunEvents({
      runId: "run_test",
      replay: [],
      destination,
      live: true,
      eventBus
    });
    const subscribersBefore = (eventBus as unknown as { subscribers: Set<unknown> }).subscribers.size;
    expect(subscribersBefore).toBe(1);
    destination.simulateClose();
    expect((eventBus as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(0);
  });
});
