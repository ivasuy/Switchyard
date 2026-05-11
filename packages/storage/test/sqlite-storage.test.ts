import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Artifact, RuntimeSession, Run, SwitchyardEvent } from "@switchyard/contracts";

import {
  SqliteArtifactStore,
  SqliteEventStore,
  SqliteRunStore,
  SqliteSessionStore,
  openSqliteStorage
} from "../src/index.js";

const startedAt = "2026-05-11T00:00:00.000Z";
const updatedAt = "2026-05-11T00:01:00.000Z";
const finishedAt = "2026-05-11T00:02:00.000Z";

function buildRun(overrides: Partial<Run>): Run {
  return {
    id: "run_storage",
    runtime: "test",
    provider: "test",
    model: "test-model",
    adapterType: "native",
    cwd: "/tmp",
    task: "Persistent store test",
    status: "queued",
    placement: "local",
    approvalPolicy: "default",
    timeoutSeconds: 30,
    metadata: { source: "test" },
    createdAt: startedAt,
    ...overrides
  };
}

function buildSession(overrides: Partial<RuntimeSession>): RuntimeSession {
  return {
    id: "session_storage",
    runId: "run_storage",
    runtime: "test",
    provider: "test",
    model: "test-model",
    protocol: "native",
    status: "active",
    state: { cursor: 1 },
    createdAt: startedAt,
    ...overrides
  };
}

function buildArtifact(overrides: Partial<Artifact>): Artifact {
  return {
    id: "artifact_storage",
    runId: "run_storage",
    type: "transcript",
    path: "/tmp/transcript.txt",
    metadata: { bytes: 12 },
    createdAt: startedAt,
    ...overrides
  };
}

describe("sqlite persistence stores", () => {
  it("persists runs, events, sessions, and artifacts across reopen", async () => {
    const run: Run = buildRun({ id: "run_storage_reopen" });
    const event: SwitchyardEvent = {
      id: "event_storage",
      type: "run.started",
      runId: run.id,
      sequence: 0,
      payload: { started: true },
      createdAt: startedAt
    };
    const session: RuntimeSession = buildSession({
      id: "session_storage_reopen",
      runId: run.id
    });
    const artifact: Artifact = buildArtifact({
      id: "artifact_storage_reopen",
      runId: run.id
    });
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-storage-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let firstConnection: ReturnType<typeof openSqliteStorage> | undefined;
    let secondConnection: ReturnType<typeof openSqliteStorage> | undefined;

    try {
      firstConnection = openSqliteStorage(dbPath);
      const firstRuns = new SqliteRunStore(firstConnection.db);
      const firstEvents = new SqliteEventStore(firstConnection.db);
      const firstSessions = new SqliteSessionStore(firstConnection.db);
      const firstArtifacts = new SqliteArtifactStore(firstConnection.db);

      await firstRuns.create(run);
      await firstEvents.append(event);
      await firstSessions.create(session);
      await firstArtifacts.create(artifact);

      firstConnection.sqlite.close();
      firstConnection = undefined;

      secondConnection = openSqliteStorage(dbPath);
      const secondRuns = new SqliteRunStore(secondConnection.db);
      const secondEvents = new SqliteEventStore(secondConnection.db);
      const secondSessions = new SqliteSessionStore(secondConnection.db);
      const secondArtifacts = new SqliteArtifactStore(secondConnection.db);

      expect(await secondRuns.get(run.id)).toEqual(run);
      expect(await secondEvents.listByRun(run.id)).toEqual([event]);
      expect(await secondSessions.getByRunId(run.id)).toEqual(session);
      expect(await secondArtifacts.get(artifact.id)).toEqual(artifact);
      expect(await secondArtifacts.listByRun(run.id)).toEqual([artifact]);
    } finally {
      firstConnection?.sqlite.close();
      secondConnection?.sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clears nullable fields on update for runs, sessions, and artifacts", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-storage-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let connection: ReturnType<typeof openSqliteStorage> | undefined;

    try {
      connection = openSqliteStorage(dbPath);
      const runs = new SqliteRunStore(connection.db);
      const sessions = new SqliteSessionStore(connection.db);
      const artifacts = new SqliteArtifactStore(connection.db);

      await runs.create(
        buildRun({
          id: "run_update",
          status: "running",
          startedAt,
          endedAt: updatedAt
        })
      );
      await sessions.create(
        buildSession({
          id: "session_update",
          status: "active",
          externalSessionKey: "session-token",
          processId: 42,
          updatedAt
        })
      );
      await artifacts.create(
        buildArtifact({
          id: "artifact_update",
          runId: "run_update",
          debateId: "debate_update",
          provider: "provider_update",
          model: "model_update"
        })
      );

      await runs.update(buildRun({ id: "run_update", runtime: "test", status: "completed" }));
      await sessions.update(
        buildSession({
          id: "session_update",
          runId: "run_update",
          runtime: "test",
          status: "active"
        })
      );
      await artifacts.update({
        id: "artifact_update",
        type: "transcript",
        path: "/tmp/transcript.txt",
        metadata: { bytes: 12 },
        createdAt: startedAt
      });

      await expect(runs.get("run_update")).resolves.toEqual(expect.not.objectContaining({ startedAt, endedAt: updatedAt }));
      await expect(sessions.get("session_update")).resolves.toEqual(
        expect.not.objectContaining({
          externalSessionKey: "session-token",
          processId: 42,
          updatedAt
        })
      );
      await expect(artifacts.get("artifact_update")).resolves.toEqual(
        expect.not.objectContaining({
          runId: "run_update",
          debateId: "debate_update",
          provider: "provider_update",
          model: "model_update"
        })
      );
    } finally {
      connection?.sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("orders run events by sequence and filters by run id", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-storage-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let connection: ReturnType<typeof openSqliteStorage> | undefined;

    try {
      connection = openSqliteStorage(dbPath);
      const events = new SqliteEventStore(connection.db);

      await events.append({
        id: "event_a_2",
        type: "runtime.output",
        runId: "run_storage",
        sequence: 2,
        payload: { step: 2 },
        createdAt: finishedAt
      });
      await events.append({
        id: "event_other",
        type: "runtime.status",
        runId: "other_run",
        sequence: 0,
        payload: { other: true },
        createdAt: startedAt
      });
      await events.append({
        id: "event_a_1",
        type: "runtime.output",
        runId: "run_storage",
        sequence: 1,
        payload: { step: 1 },
        createdAt: updatedAt
      });

      expect((await events.listByRun("run_storage")).map((event) => event.id)).toEqual(["event_a_1", "event_a_2"]);
    } finally {
      connection?.sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("lists artifacts for only the requested run", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-storage-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let connection: ReturnType<typeof openSqliteStorage> | undefined;

    try {
      connection = openSqliteStorage(dbPath);
      const artifacts = new SqliteArtifactStore(connection.db);

      await artifacts.create(
        buildArtifact({
          id: "artifact_1",
          runId: "run_storage",
          path: "/tmp/artifact_1.txt",
          createdAt: startedAt,
          metadata: { bytes: 10 }
        })
      );
      await artifacts.create(
        buildArtifact({
          id: "artifact_2",
          runId: "other_run",
          path: "/tmp/artifact_other.txt",
          createdAt: updatedAt,
          metadata: { bytes: 20 }
        })
      );
      await artifacts.create(
        buildArtifact({
          id: "artifact_3",
          runId: "run_storage",
          path: "/tmp/artifact_3.txt",
          createdAt: finishedAt,
          metadata: { bytes: 30 }
        })
      );

      expect((await artifacts.listByRun("run_storage")).map((artifact) => artifact.id)).toEqual(["artifact_1", "artifact_3"]);
    } finally {
      connection?.sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
