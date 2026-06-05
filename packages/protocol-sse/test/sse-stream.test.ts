import { describe, expect, it } from "vitest";
import type { SwitchyardEvent } from "@switchyard/contracts";
import { EventBus } from "@switchyard/core";
import { collectReplayAndLiveEvents, formatSseEvent, streamEntityEvents } from "../src/index.js";

describe("protocol-sse", () => {
  it("formats event payload for SSE output", () => {
    const event: SwitchyardEvent = {
      id: "event_queued",
      type: "run.queued",
      runId: "run_1",
      sequence: 0,
      payload: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    };

    expect(formatSseEvent(event)).toContain("event: run.queued");
    expect(formatSseEvent(event)).toContain("data: ");
  });

  it("combines replay and live events before stopping", async () => {
    const eventBus = new EventBus();
    const replay: SwitchyardEvent = {
      id: "event_queued",
      type: "run.queued",
      runId: "run_123",
      sequence: 0,
      payload: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    };
    const live: SwitchyardEvent = {
      id: "event_completed",
      type: "run.completed",
      runId: "run_123",
      sequence: 2,
      payload: { status: "completed" },
      createdAt: "2026-05-11T00:00:01.000Z"
    };

    const bodyPromise = collectReplayAndLiveEvents({
      runId: "run_123",
      replay: [replay],
      eventBus,
      stopAfter: 2
    });

    setTimeout(() => {
      void eventBus.publish(live);
    }, 0);

    const body = await bodyPromise;
    expect(body).toContain("event: run.queued");
    expect(body).toContain("event: run.completed");
  });

  it("filters events from other runs before stopping", async () => {
    const eventBus = new EventBus();
    const replay: SwitchyardEvent = {
      id: "event_queued",
      runId: "run_123",
      type: "run.queued",
      sequence: 0,
      payload: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    };

    const bodyPromise = collectReplayAndLiveEvents({
      runId: "run_123",
      replay: [replay],
      eventBus,
      stopAfter: 2
    });

    setTimeout(() => {
      void eventBus.publish({
        id: "event_other",
        runId: "run_999",
        type: "runtime.output",
        sequence: 1,
        payload: { text: "ignored" },
        createdAt: "2026-05-11T00:00:01.000Z"
      });
      void eventBus.publish({
        id: "event_completed",
        runId: "run_123",
        type: "run.completed",
        sequence: 2,
        payload: { status: "completed" },
        createdAt: "2026-05-11T00:00:02.000Z"
      });
    }, 0);

    const body = await bodyPromise;
    expect(body).toContain("event: run.queued");
    expect(body).toContain("event: run.completed");
    expect(body).not.toContain("ignored");
  });

  it("returns replay immediately when stopAfter is met", async () => {
    const eventBus = new EventBus();
    const replay: SwitchyardEvent = {
      id: "event_queued",
      runId: "run_123",
      type: "run.queued",
      sequence: 0,
      payload: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    };

    const body = await collectReplayAndLiveEvents({
      runId: "run_123",
      replay: [replay],
      eventBus,
      stopAfter: 1
    });

    expect(body).toBe(formatSseEvent(replay));
  });

  it("truncates replay to stopAfter when replay already exceeds limit", async () => {
    const eventBus = new EventBus();
    const first: SwitchyardEvent = {
      id: "event_queued",
      runId: "run_123",
      type: "run.queued",
      sequence: 0,
      payload: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    };
    const second: SwitchyardEvent = {
      id: "event_started",
      runId: "run_123",
      type: "run.started",
      sequence: 1,
      payload: {},
      createdAt: "2026-05-11T00:00:01.000Z"
    };

    const body = await collectReplayAndLiveEvents({
      runId: "run_123",
      replay: [first, second],
      eventBus,
      stopAfter: 1
    });

    expect(body).toContain("event: run.queued");
    expect(body).not.toContain("event: run.started");
  });

  it("normalizes fractional stopAfter to at least one event in replay", async () => {
    const eventBus = new EventBus();
    const first: SwitchyardEvent = {
      id: "event_queued",
      runId: "run_123",
      type: "run.queued",
      sequence: 0,
      payload: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    };
    const second: SwitchyardEvent = {
      id: "event_started",
      runId: "run_123",
      type: "run.started",
      sequence: 1,
      payload: {},
      createdAt: "2026-05-11T00:00:01.000Z"
    };

    const body = await collectReplayAndLiveEvents({
      runId: "run_123",
      replay: [first, second],
      eventBus,
      stopAfter: 0.5
    });

    expect(body).toContain(formatSseEvent(first));
    expect(body).not.toContain("event: run.started");
  });

  it("falls back to replay length for non-positive stopAfter", async () => {
    const eventBus = new EventBus();
    const first: SwitchyardEvent = {
      id: "event_queued",
      runId: "run_123",
      type: "run.queued",
      sequence: 0,
      payload: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    };
    const second: SwitchyardEvent = {
      id: "event_started",
      runId: "run_123",
      type: "run.started",
      sequence: 1,
      payload: {},
      createdAt: "2026-05-11T00:00:01.000Z"
    };

    const body = await collectReplayAndLiveEvents({
      runId: "run_123",
      replay: [first, second],
      eventBus,
      stopAfter: 0
    });

    expect(body).toContain(formatSseEvent(first));
    expect(body).toContain(formatSseEvent(second));
  });

  it("resolves via timeout when no matching live event arrives", async () => {
    const eventBus = new EventBus();
    const replay: SwitchyardEvent = {
      id: "event_queued",
      runId: "run_123",
      type: "run.queued",
      sequence: 0,
      payload: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    };

    const bodyPromise = collectReplayAndLiveEvents({
      runId: "run_123",
      replay: [replay],
      eventBus,
      stopAfter: 2,
      timeoutMs: 20
    });

    setTimeout(() => {
      void eventBus.publish({
        id: "event_other",
        runId: "run_999",
        type: "runtime.output",
        sequence: 1,
        payload: { text: "ignored" },
        createdAt: "2026-05-11T00:00:01.000Z"
      });
    }, 0);

    const body = await bodyPromise;
    expect(body).toBe(formatSseEvent(replay));
  });

  it("collects debate replay/live events through generic entity filtering", async () => {
    const eventBus = new EventBus();
    const replay: SwitchyardEvent = {
      id: "event_debate_queued",
      debateId: "debate_123",
      type: "debate.round.started",
      sequence: 0,
      payload: { round: 1 },
      createdAt: "2026-05-11T00:00:00.000Z"
    };
    const bodyPromise = collectReplayAndLiveEvents({
      runId: "run_unused",
      replay: [replay],
      eventBus,
      stopAfter: 2,
      match: (event) => event.debateId === "debate_123"
    });

    setTimeout(() => {
      void eventBus.publish({
        id: "event_other",
        debateId: "debate_other",
        type: "debate.agent.argument",
        sequence: 1,
        payload: { ignored: true },
        createdAt: "2026-05-11T00:00:01.000Z"
      });
      void eventBus.publish({
        id: "event_debate_next",
        debateId: "debate_123",
        type: "debate.agent.argument",
        sequence: 2,
        payload: { accepted: true },
        createdAt: "2026-05-11T00:00:01.000Z"
      });
    }, 0);

    const body = await bodyPromise;
    expect(body).toContain("event: debate.round.started");
    expect(body).toContain("event: debate.agent.argument");
    expect(body).not.toContain("ignored");
  });

  it("streams debate events with streamEntityEvents matcher", async () => {
    const eventBus = new EventBus();
    const chunks: string[] = [];
    const destination = {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      end() {},
      on(_event: "close", _listener: () => void) {}
    };

    const handle = streamEntityEvents({
      replay: [],
      destination,
      live: true,
      eventBus,
      stopAfter: 1,
      matches: (event) => event.debateId === "debate_stream"
    });
    await eventBus.publish({
      id: "event_stream_1",
      debateId: "debate_stream",
      type: "debate.round.started",
      sequence: 0,
      payload: { round: 1 },
      createdAt: "2026-05-11T00:00:00.000Z"
    });
    await handle.finished;

    expect(chunks.join("")).toContain("event: debate.round.started");
  });
});
