import { describe, expect, it } from "vitest";
import {
  FakeRuntimeAdapter,
  InMemoryArtifactStore,
  InMemoryEventStore,
  InMemoryPlacementStore,
  InMemoryRunStore,
  createFixtureRun
} from "../src/index.js";

describe("testkit fake runtime adapter", () => {
  it("satisfies the runtime adapter lifecycle contract", async () => {
    const adapter = new FakeRuntimeAdapter();
    const check = await adapter.check();
    const session = await adapter.start({ runId: "run_123" });
    const events = [];

    for await (const event of adapter.events({ runId: "run_123" })) {
      events.push(event);
    }

    await adapter.send(session, { text: "continue" });
    await adapter.cancel(session);
    const artifacts = await adapter.artifacts(session);

    expect(check.ok).toBe(true);
    expect(session.sessionId).toMatch(/^session_/);
    expect(events.map((event) => event.type)).toEqual(["runtime.status", "runtime.output", "run.completed"]);
    expect(artifacts[0]?.type).toBe("transcript");
  });

  it("provides in-memory stores for core service tests", async () => {
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const artifacts = new InMemoryArtifactStore();
    const placements = new InMemoryPlacementStore();
    const run = createFixtureRun();

    await runs.create(run);
    await events.append({
      id: "event_fixture",
      type: "run.queued",
      runId: run.id,
      sequence: 0,
      payload: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    });

    expect(await runs.get(run.id)).toEqual(run);
    expect(await events.listByRun(run.id)).toHaveLength(1);
    expect(await artifacts.listByRun(run.id)).toHaveLength(0);
    expect(await placements.listByRun(run.id)).toHaveLength(0);
  });

  it("provides in-memory artifact and placement stores", async () => {
    const artifacts = new InMemoryArtifactStore();
    const placements = new InMemoryPlacementStore();

    await artifacts.create({
      id: "artifact_memory",
      runId: "run_123",
      type: "transcript",
      path: "runs/run_123/transcript.jsonl",
      metadata: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    });
    await placements.create({
      id: "placement_123",
      runId: "run_123",
      decision: "local",
      reason: "test",
      mode: "local",
      requiredCapabilities: [],
      deniedCapabilities: [],
      approvalRequired: false,
      policyTrace: [],
      createdAt: "2026-05-11T00:00:00.000Z"
    });

    expect(await artifacts.listByRun("run_123")).toHaveLength(1);
    expect(await placements.listByRun("run_123")).toHaveLength(1);
  });
});
