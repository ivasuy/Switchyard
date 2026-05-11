import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  Artifact,
  Approval,
  Model,
  Provider,
  RuntimeSession,
  RuntimeTarget,
  RoutedMessage,
  Run,
  SwitchyardEvent
} from "@switchyard/contracts";
import type { PlacementDecisionRecord } from "@switchyard/core";

import {
  SqliteApprovalStore,
  SqliteArtifactStore,
  SqliteEventStore,
  SqliteMessageStore,
  SqlitePlacementStore,
  SqliteRegistryStore,
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
  it("persists all sqlite stores across reopen", async () => {
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
    const message: RoutedMessage = {
      id: "message_storage",
      content: "hello",
      attachments: [{ role: "operator", body: "hello" }],
      deliveryStatus: "queued",
      createdAt: startedAt
    };
    const approval: Approval = {
      id: "approval_storage",
      approvalType: "before_commit",
      status: "pending",
      payload: { command: "git commit" },
      createdAt: startedAt
    };
    const provider: Provider = {
      id: "provider_storage",
      name: "Test",
      authMode: "local",
      status: "available"
    };
    const runtime: RuntimeTarget = {
      id: "runtime_storage",
      name: "Fake",
      adapterType: "native",
      status: "degraded"
    };
    const model: Model = {
      id: "model_storage",
      providerId: provider.id,
      modelName: "test-model",
      supportsTools: true,
      supportsStreaming: false,
      supportsBrowser: true,
      status: "available"
    };
    const placementDecision: PlacementDecisionRecord = {
      id: "placement_storage",
      runId: run.id,
      decision: "local",
      reason: "policy default",
      mode: "local",
      requiredCapabilities: ["storage", "routing"],
      deniedCapabilities: ["external"],
      approvalRequired: false,
      policyTrace: ["bootstrap", "allowed"],
      createdAt: startedAt
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
      const firstMessages = new SqliteMessageStore(firstConnection.db);
      const firstApprovals = new SqliteApprovalStore(firstConnection.db);
      const firstRegistry = new SqliteRegistryStore(firstConnection.db);
      const firstPlacement = new SqlitePlacementStore(firstConnection.db);

      await firstRuns.create(run);
      await firstEvents.append(event);
      await firstSessions.create(session);
      await firstArtifacts.create(artifact);
      await firstMessages.create(message);
      await firstApprovals.create(approval);
      await firstRegistry.createProvider(provider);
      await firstRegistry.createRuntime(runtime);
      await firstRegistry.createModel(model);
      await firstPlacement.create(placementDecision);

      firstConnection.sqlite.close();
      firstConnection = undefined;

      secondConnection = openSqliteStorage(dbPath);
      const secondRuns = new SqliteRunStore(secondConnection.db);
      const secondEvents = new SqliteEventStore(secondConnection.db);
      const secondSessions = new SqliteSessionStore(secondConnection.db);
      const secondArtifacts = new SqliteArtifactStore(secondConnection.db);
      const secondMessages = new SqliteMessageStore(secondConnection.db);
      const secondApprovals = new SqliteApprovalStore(secondConnection.db);
      const secondRegistry = new SqliteRegistryStore(secondConnection.db);
      const secondPlacement = new SqlitePlacementStore(secondConnection.db);

      expect(await secondRuns.get(run.id)).toEqual(run);
      expect(await secondEvents.listByRun(run.id)).toEqual([event]);
      expect(await secondSessions.getByRunId(run.id)).toEqual(session);
      expect(await secondArtifacts.get(artifact.id)).toEqual(artifact);
      expect(await secondArtifacts.listByRun(run.id)).toEqual([artifact]);
      expect(await secondMessages.get("message_storage")).toMatchObject({ content: "hello" });
      expect(await secondApprovals.get("approval_storage")).toMatchObject({ payload: { command: "git commit" } });
      expect(await secondRegistry.getProvider("provider_storage")).toMatchObject({ name: "Test" });
      expect(await secondRegistry.getRuntime("runtime_storage")).toMatchObject({ name: "Fake" });
      expect(await secondRegistry.getModel("model_storage")).toMatchObject({ modelName: "test-model" });
      expect(await secondPlacement.listByRun("run_storage_reopen")).toHaveLength(1);

      const persistedMessage = await secondMessages.get("message_storage");
      expect(persistedMessage).toMatchObject({
        id: "message_storage",
        attachments: [{ role: "operator", body: "hello" }]
      });
      expect(persistedMessage && "fromRunId" in persistedMessage).toBe(false);
      expect(persistedMessage && "toRunId" in persistedMessage).toBe(false);
      expect(persistedMessage && "channel" in persistedMessage).toBe(false);
      expect(persistedMessage && "deliveredAt" in persistedMessage).toBe(false);

      const persistedApproval = await secondApprovals.get("approval_storage");
      expect(persistedApproval).toMatchObject({
        approvalType: "before_commit",
        status: "pending"
      });
      expect(persistedApproval && "runId" in persistedApproval).toBe(false);
      expect(persistedApproval && "resolvedAt" in persistedApproval).toBe(false);

      const persistedModel = await secondRegistry.getModel("model_storage");
      expect(persistedModel).toMatchObject({
        supportsTools: true,
        supportsStreaming: false,
        supportsBrowser: true
      });

      const runPlacements = await secondPlacement.listByRun("run_storage_reopen");
      expect(runPlacements).toMatchObject([
        {
          id: "placement_storage",
          requiredCapabilities: ["storage", "routing"],
          deniedCapabilities: ["external"],
          approvalRequired: false,
          policyTrace: ["bootstrap", "allowed"]
        }
      ]);
      expect(runPlacements[0] && "targetNode" in runPlacements[0]).toBe(false);
      expect(await secondPlacement.listByRun("run_storage_missing")).toHaveLength(0);
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

  it("enforces placement records to always include runId", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-storage-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let connection: ReturnType<typeof openSqliteStorage> | undefined;

    try {
      connection = openSqliteStorage(dbPath);
      const placements = new SqlitePlacementStore(connection.db);

      const invalidCreate = {
        id: "placement_missing_run",
        decision: "local",
        reason: "policy default",
        mode: "local",
        requiredCapabilities: [],
        deniedCapabilities: [],
        approvalRequired: false,
        policyTrace: [],
        createdAt: startedAt
      } as PlacementDecisionRecord;

      await expect(placements.create(invalidCreate)).rejects.toThrow("placement records require a runId");

      await placements.create({
        id: "placement_update_target",
        runId: "run_update_scope",
        decision: "local",
        reason: "policy",
        mode: "local",
        requiredCapabilities: ["a"],
        deniedCapabilities: [],
        approvalRequired: false,
        policyTrace: [],
        createdAt: startedAt
      });

      const invalidUpdate = {
        id: "placement_update_target",
        decision: "reject",
        reason: "should fail",
        mode: "hybrid",
        requiredCapabilities: [],
        deniedCapabilities: [],
        approvalRequired: true,
        policyTrace: ["manual"],
        createdAt: startedAt
      } as PlacementDecisionRecord;

      await expect(placements.update(invalidUpdate)).rejects.toThrow("placement records require a runId");
    } finally {
      connection?.sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("filters placement decisions by runId and clears optional message and approval fields on update", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-storage-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let connection: ReturnType<typeof openSqliteStorage> | undefined;

    try {
      connection = openSqliteStorage(dbPath);
      const messages = new SqliteMessageStore(connection.db);
      const approvals = new SqliteApprovalStore(connection.db);
      const placements = new SqlitePlacementStore(connection.db);

      await messages.create({
        id: "message_update_scope",
        content: "hello",
        attachments: [{ role: "operator", body: "hello" }],
        deliveryStatus: "queued",
        fromRunId: "run_a",
        toRunId: "run_b",
        channel: "chat",
        deliveredAt: startedAt,
        createdAt: startedAt
      });
      await approvals.create({
        id: "approval_update_scope",
        runId: "run_a",
        approvalType: "before_commit",
        status: "pending",
        payload: { command: "git commit" },
        createdAt: startedAt,
        resolvedAt: startedAt
      });
      await placements.create({
        id: "placement_a_1",
        runId: "run_a",
        decision: "local",
        reason: "initial policy",
        mode: "local",
        requiredCapabilities: ["storage"],
        deniedCapabilities: ["network"],
        approvalRequired: false,
        policyTrace: ["start"],
        createdAt: startedAt
      });
      await placements.create({
        id: "placement_b_1",
        runId: "run_b",
        decision: "local",
        reason: "secondary",
        mode: "local",
        requiredCapabilities: ["runtime"],
        deniedCapabilities: [],
        approvalRequired: true,
        policyTrace: ["other"],
        createdAt: startedAt
      });

      await messages.update({
        id: "message_update_scope",
        content: "hello world",
        attachments: [],
        deliveryStatus: "delivered",
        createdAt: startedAt
      });
      await approvals.update({
        id: "approval_update_scope",
        approvalType: "before_commit",
        status: "approved",
        payload: {},
        createdAt: startedAt
      });
      await placements.update({
        id: "placement_a_1",
        runId: "run_a",
        decision: "local",
        reason: "updated policy",
        mode: "local",
        requiredCapabilities: ["storage", "approval"],
        deniedCapabilities: [],
        approvalRequired: true,
        policyTrace: ["start", "update"],
        createdAt: updatedAt
      });

      expect(await messages.get("message_update_scope")).toMatchObject({
        content: "hello world",
        attachments: []
      });
      expect(await messages.get("message_update_scope")).toEqual(
        expect.not.objectContaining({
          fromRunId: "run_a",
          toRunId: "run_b",
          channel: "chat",
          deliveredAt: startedAt
        })
      );

      expect(await approvals.get("approval_update_scope")).toMatchObject({
        approvalType: "before_commit",
        status: "approved",
        payload: {}
      });
      expect(await approvals.get("approval_update_scope")).toEqual(
        expect.not.objectContaining({
          runId: "run_a",
          resolvedAt: startedAt
        })
      );

      const runAPlacements = await placements.listByRun("run_a");
      expect(runAPlacements).toHaveLength(1);
      expect(runAPlacements[0]).toMatchObject({
        id: "placement_a_1",
        reason: "updated policy",
        approvalRequired: true,
        requiredCapabilities: ["storage", "approval"]
      });
      expect(await placements.listByRun("run_a")).toEqual(runAPlacements);
      expect(await placements.listByRun("run_b")).toHaveLength(1);
      expect(await placements.listByRun("run_b")).toMatchObject([{ id: "placement_b_1" }]);
      expect(await placements.listByRun("run_other")).toHaveLength(0);
    } finally {
      connection?.sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
