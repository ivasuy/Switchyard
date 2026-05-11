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

describe("sqlite persistence stores", () => {
  it("persists runs, events, sessions, and artifacts across reopen", async () => {
    const createdAt = "2026-05-11T00:00:00.000Z";
    const run: Run = {
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
      createdAt
    };
    const event: SwitchyardEvent = {
      id: "event_storage",
      type: "run.started",
      runId: "run_storage",
      sequence: 0,
      payload: { started: true },
      createdAt
    };
    const session: RuntimeSession = {
      id: "session_storage",
      runId: "run_storage",
      runtime: "test",
      provider: "test",
      model: "test-model",
      protocol: "native",
      status: "active",
      state: { cursor: 1 },
      createdAt
    };
    const artifact: Artifact = {
      id: "artifact_storage",
      runId: "run_storage",
      type: "transcript",
      path: "/tmp/transcript.txt",
      metadata: { bytes: 12 },
      createdAt
    };
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
});
