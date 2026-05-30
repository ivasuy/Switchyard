import { describe, expect, it } from "vitest";
import {
  PostgresArtifactStore,
  PostgresAssignmentStore,
  PostgresEventStore,
  PostgresNodeStore,
  PostgresPlacementStore,
  PostgresRegistryStore,
  PostgresRunStore,
  PostgresSessionStore,
  openPostgresDatabase
} from "../src/index.js";

describe("postgres storage", () => {
  it("provides Postgres-shaped stores through in-memory deterministic behavior", async () => {
    const runs = new PostgresRunStore();
    const events = new PostgresEventStore();
    const sessions = new PostgresSessionStore();
    const artifacts = new PostgresArtifactStore();
    const registry = new PostgresRegistryStore();
    const placements = new PostgresPlacementStore();
    const nodes = new PostgresNodeStore();
    const assignments = new PostgresAssignmentStore();

    const run = await runs.create({
      id: "run_pg_1",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "task",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-05-30T00:00:00.000Z"
    });

    expect((await runs.get(run.id))?.id).toBe("run_pg_1");

    await events.append({
      id: "event_pg_1",
      type: "run.queued",
      runId: run.id,
      sequence: 0,
      payload: {},
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    expect((await events.listByRun(run.id)).length).toBe(1);

    await sessions.create({
      id: "session_pg_1",
      runId: run.id,
      runtime: "fake",
      provider: "test",
      model: "test-model",
      protocol: "process",
      status: "active",
      state: {},
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    expect((await sessions.getByRunId(run.id))?.id).toBe("session_pg_1");

    await artifacts.create({
      id: "artifact_pg_1",
      runId: run.id,
      type: "transcript",
      path: "runs/run_pg_1/transcript.jsonl",
      metadata: {},
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    expect((await artifacts.listByRun(run.id)).length).toBe(1);

    await registry.createProvider({ id: "provider_test", name: "Test", authMode: "none", status: "available" });
    expect((await registry.getProvider("provider_test"))?.id).toBe("provider_test");

    await placements.create({
      id: "placement_pg_1",
      runId: run.id,
      decision: "hosted",
      reason: "default_hosted",
      mode: "hosted",
      requiredCapabilities: [],
      deniedCapabilities: [],
      approvalRequired: false,
      policyTrace: [],
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    expect((await placements.listByRun(run.id)).length).toBe(1);

    await nodes.upsert({
      id: "node_1",
      mode: "hybrid",
      status: "online",
      capabilities: ["runtime.fake.deterministic"],
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await assignments.create({
      id: "assignment_pg_1",
      runId: run.id,
      nodeId: "node_1",
      status: "pending",
      retryCount: 0,
      lastEventSequence: 0,
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    expect((await assignments.listClaimable("node_1", "2026-05-30T00:00:00.000Z")).length).toBe(1);
  });

  it("skips real postgres when SWITCHYARD_TEST_POSTGRES_URL is missing", async () => {
    const url = process.env["SWITCHYARD_TEST_POSTGRES_URL"];
    if (!url) {
      expect("SKIPPED_SWITCHYARD_TEST_POSTGRES_URL_UNSET").toContain("SKIPPED");
      return;
    }

    const opened = openPostgresDatabase(url);
    try {
      const row = await opened.pool.query("SELECT 1 as value");
      expect(row.rows[0]?.value).toBe(1);
    } finally {
      await opened.close();
    }
  });
});
