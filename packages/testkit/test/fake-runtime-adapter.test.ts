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
    const artifactRun123 = await artifacts.create({
      id: "artifact_memory_123",
      runId: "run_123",
      type: "transcript",
      path: "runs/run_123/transcript.jsonl",
      metadata: { source: "initial" },
      createdAt: "2026-05-11T00:00:00.000Z"
    });
    const artifactRun456 = await artifacts.create({
      id: "artifact_memory_456",
      runId: "run_456",
      type: "transcript",
      path: "runs/run_456/transcript.jsonl",
      metadata: { source: "secondary" },
      createdAt: "2026-05-11T00:00:00.000Z"
    });
    const placementRun123 = await placements.create({
      id: "placement_123",
      runId: "run_123",
      decision: "local",
      reason: "initial reason",
      mode: "local",
      requiredCapabilities: [],
      deniedCapabilities: [],
      approvalRequired: false,
      policyTrace: [],
      createdAt: "2026-05-11T00:00:00.000Z"
    });
    const placementRun456 = await placements.create({
      id: "placement_456",
      runId: "run_456",
      decision: "hosted",
      reason: "secondary reason",
      mode: "hosted",
      requiredCapabilities: ["remote"],
      deniedCapabilities: [],
      approvalRequired: false,
      policyTrace: [],
      createdAt: "2026-05-11T00:00:00.000Z"
    });

    const run123Artifacts = await artifacts.listByRun("run_123");
    const run123Placements = await placements.listByRun("run_123");
    const run456Artifacts = await artifacts.listByRun("run_456");
    const run456Placements = await placements.listByRun("run_456");

    expect(run123Artifacts).toHaveLength(1);
    expect(run456Artifacts).toHaveLength(1);
    expect(run123Placements).toHaveLength(1);
    expect(run456Placements).toHaveLength(1);
    expect(run123Artifacts).toEqual([artifactRun123]);
    expect(run456Artifacts).toEqual([artifactRun456]);
    expect(run123Placements).toEqual([placementRun123]);
    expect(run456Placements).toEqual([placementRun456]);

    await artifacts.update({
      ...artifactRun123,
      metadata: { source: "updated", reviewed: true }
    });
    await placements.update({
      ...placementRun123,
      reason: "updated reason",
      runId: "run_456"
    });

    const updatedArtifact = await artifacts.get("artifact_memory_123");
    const updatedPlacement = await placements.get("placement_123");
    const run123ArtifactsAfter = await artifacts.listByRun("run_123");
    const run456ArtifactsAfter = await artifacts.listByRun("run_456");
    const run123PlacementsAfter = await placements.listByRun("run_123");
    const run456PlacementsAfter = await placements.listByRun("run_456");

    expect(updatedArtifact?.metadata).toMatchObject({ source: "updated", reviewed: true });
    expect(run123ArtifactsAfter).toHaveLength(1);
    expect(run456ArtifactsAfter).toHaveLength(1);
    expect(run456ArtifactsAfter).toContainEqual(
      expect.objectContaining({
        id: "artifact_memory_456",
        runId: "run_456"
      })
    );
    expect(updatedPlacement).toMatchObject({
      id: "placement_123",
      runId: "run_456",
      reason: "updated reason"
    });
    expect(run123PlacementsAfter).toHaveLength(0);
    expect(run456PlacementsAfter).toHaveLength(2);
    await expect(placements.create({ ...placementRun456, id: "placement_no_run", runId: undefined })).rejects.toThrow(
      "placement records require a runId"
    );
  });
});
