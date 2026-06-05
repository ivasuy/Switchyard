import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type {
  Artifact,
  Approval,
  Debate,
  Model,
  Provider,
  RuntimeAvailability,
  RuntimeMode,
  RuntimeSession,
  RuntimeTarget,
  RoutedMessage,
  Run,
  SwitchyardEvent
} from "@switchyard/contracts";
import type { PlacementDecisionRecord } from "@switchyard/core";

import {
  SqliteApprovalStore,
  SqliteDebateStore,
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
    runtimeMode: "fake.deterministic",
    state: { cursor: 1 },
    createdAt: startedAt,
    ...overrides
  };
}

function buildRuntimeMode(overrides: Partial<RuntimeMode>): RuntimeMode {
  return {
    id: "runtime_mode_fake_deterministic",
    slug: "fake.deterministic",
    name: "Fake deterministic runtime",
    providerId: "provider_test",
    runtimeId: "runtime_fake",
    adapterId: "fake",
    adapterType: "process",
    kind: "deterministic_fake",
    status: "available",
    capabilities: ["run.start", "run.cancel", "event.normalized", "event.streaming", "artifact.transcript", "tool.fake_echo", "auth.none"],
    limitations: [{ code: "deterministic_only", message: "Outputs are fixed for local smoke and contract tests." }],
    placement: {
      local: { support: "supported", reason: "In-process deterministic test adapter." },
      hosted: { support: "unsupported", reason: "Hosted worker execution is not shipped in R3." },
      connectedLocalNode: { support: "future", reason: "Hybrid node execution is planned for R10." }
    },
    availability: {
      state: "available",
      canRun: true,
      installed: true,
      auth: "not_required",
      version: null,
      checkedAt: startedAt,
      reasonCode: null,
      message: null
    },
    createdAt: startedAt,
    updatedAt: startedAt,
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

function buildDebate(overrides: Partial<Debate>): Debate {
  return {
    id: "debate_storage",
    topic: "Should fake debate ship first?",
    mode: "same_provider_model_debate",
    status: "created",
    participants: [
      {
        id: "participant_storage_1",
        runtime: "fake",
        provider: "test",
        model: "test-model",
        role: "affirmative",
        status: "created",
        turnsUsed: 0,
        runIds: []
      },
      {
        id: "participant_storage_2",
        runtime: "fake",
        provider: "test",
        model: "test-model",
        role: "skeptic",
        status: "created",
        turnsUsed: 0,
        runIds: []
      }
    ],
    limits: {
      maxRounds: 2,
      maxTurnsPerAgent: 2,
      maxSearchesPerAgent: 0,
      maxTotalMessages: 4,
      maxDurationSeconds: 30,
      maxCostUsd: 0,
      requireCitations: false,
      requireDisagreementSummary: true,
      stopOnConsensus: false,
      stopOnLowNewInformation: false,
      humanStopAllowed: false
    },
    evidenceIds: [],
    messageIds: [],
    eventIds: [],
    budget: {
      status: "within_budget",
      maxCostUsd: 0,
      spentCostUsd: 0
    },
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

  it("guard-updates prepared metadata only when execution identity still matches", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-storage-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let connection: ReturnType<typeof openSqliteStorage> | undefined;

    try {
      connection = openSqliteStorage(dbPath);
      const runs = new SqliteRunStore(connection.db);
      await runs.create(
        buildRun({
          id: "run_guard_sqlite",
          placement: "hosted",
          runtime: "codex",
          provider: "openai",
          adapterType: "process",
          runtimeMode: "codex.exec_json",
          status: "queued",
          metadata: { before: true }
        })
      );

      const updated = await runs.updatePreparedMetadataIfMatch({
        expected: {
          id: "run_guard_sqlite",
          status: "queued",
          placement: "hosted",
          runtime: "codex",
          runtimeMode: "codex.exec_json",
          provider: "openai",
          adapterType: "process"
        },
        metadata: { sandbox: "read-only" }
      });

      expect(updated).toMatchObject({
        ok: true,
        run: { id: "run_guard_sqlite", metadata: { sandbox: "read-only" } }
      });

      const mismatch = await runs.updatePreparedMetadataIfMatch({
        expected: {
          id: "run_guard_sqlite",
          status: "queued",
          placement: "hosted",
          runtime: "codex",
          runtimeMode: "opencode.acp",
          provider: "openai",
          adapterType: "process"
        },
        metadata: { sandbox: "workspace-write" }
      });
      expect(mismatch).toEqual({ ok: false, reason: "identity_mismatch" });
      expect((await runs.get("run_guard_sqlite"))?.metadata).toEqual({ sandbox: "read-only" });
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

  it("persists debates and supports listByDebate for events and artifacts", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-storage-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let connection: ReturnType<typeof openSqliteStorage> | undefined;

    try {
      connection = openSqliteStorage(dbPath);
      const debates = new SqliteDebateStore(connection.db);
      const events = new SqliteEventStore(connection.db);
      const artifacts = new SqliteArtifactStore(connection.db);

      const debate = buildDebate({ id: "debate_storage_1" });
      await debates.create(debate);
      await events.append({
        id: "event_debate_1",
        debateId: debate.id,
        type: "debate.round.started",
        sequence: 0,
        payload: { round: 1 },
        createdAt: startedAt
      });
      await artifacts.create({
        id: "artifact_debate_1",
        debateId: debate.id,
        type: "summary",
        path: `debates/${debate.id}/final-report.md`,
        metadata: { contentStored: false },
        createdAt: startedAt
      });

      expect(await debates.get(debate.id)).toEqual(debate);
      expect(await events.listByDebate(debate.id)).toHaveLength(1);
      expect(await artifacts.listByDebate(debate.id)).toHaveLength(1);
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

  it("persists runtime modes and runtimeMode fields across reopen", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-runtime-modes-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let firstConnection: ReturnType<typeof openSqliteStorage> | undefined;
    let secondConnection: ReturnType<typeof openSqliteStorage> | undefined;
    try {
      firstConnection = openSqliteStorage(dbPath);
      const registry = new SqliteRegistryStore(firstConnection.db);
      const runs = new SqliteRunStore(firstConnection.db);
      const sessions = new SqliteSessionStore(firstConnection.db);
      await registry.upsertRuntimeMode(buildRuntimeMode({}));
      await registry.upsertRuntimeMode(
        buildRuntimeMode({
          id: "runtime_mode_codex_exec_json",
          slug: "codex.exec_json",
          name: "Codex exec JSON",
          providerId: "provider_openai",
          runtimeId: "runtime_codex",
          adapterId: "codex",
          kind: "one_shot_process",
          status: "unavailable",
          capabilities: ["run.start", "run.cancel", "model.catalog", "auth.local"],
          limitations: [{ code: "one_shot_no_input", message: "codex.exec_json does not support post-start input." }],
          availability: {
            state: "unavailable",
            canRun: false,
            installed: true,
            auth: "configured",
            version: "codex 0.130.0",
            checkedAt: startedAt,
            reasonCode: "model_catalog_unavailable",
            message: "No models returned."
          }
        })
      );
      await runs.create(buildRun({ id: "run_runtime_mode", runtimeMode: "fake.deterministic" }));
      await sessions.create(buildSession({ id: "session_runtime_mode", runId: "run_runtime_mode", runtimeMode: "fake.deterministic" }));
      await registry.updateRuntimeModeAvailability("codex.exec_json", {
        state: "partial",
        canRun: true,
        installed: true,
        auth: "configured",
        version: "codex 0.130.0",
        checkedAt: updatedAt,
        reasonCode: "optional_check_failed",
        message: "Optional check failed."
      });

      firstConnection.sqlite.close();
      firstConnection = undefined;

      secondConnection = openSqliteStorage(dbPath);
      const reopenedRegistry = new SqliteRegistryStore(secondConnection.db);
      const reopenedRuns = new SqliteRunStore(secondConnection.db);
      const reopenedSessions = new SqliteSessionStore(secondConnection.db);
      expect((await reopenedRegistry.getRuntimeMode("runtime_mode_fake_deterministic"))?.slug).toBe("fake.deterministic");
      expect((await reopenedRegistry.getRuntimeMode("codex.exec_json"))?.availability.state).toBe("partial");
      expect((await reopenedRuns.get("run_runtime_mode"))?.runtimeMode).toBe("fake.deterministic");
      expect((await reopenedSessions.get("session_runtime_mode"))?.runtimeMode).toBe("fake.deterministic");
    } finally {
      firstConnection?.sqlite.close();
      secondConnection?.sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("adds runtime mode table and nullable run/session runtime_mode columns on pre-R3 databases", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-pre-r3-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let connection: ReturnType<typeof openSqliteStorage> | undefined;
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY NOT NULL,
          runtime TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          adapter_type TEXT NOT NULL,
          cwd TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL,
          placement TEXT NOT NULL,
          approval_policy TEXT NOT NULL,
          timeout_seconds INTEGER NOT NULL,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE runtime_sessions (
          id TEXT PRIMARY KEY NOT NULL,
          run_id TEXT NOT NULL,
          runtime TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          protocol TEXT NOT NULL,
          status TEXT NOT NULL,
          state_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      legacy.close();

      connection = openSqliteStorage(dbPath);
      const runColumns = connection.sqlite.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
      const sessionColumns = connection.sqlite.prepare("PRAGMA table_info(runtime_sessions)").all() as Array<{ name: string }>;
      const runtimeModeTable = connection.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_modes'")
        .get() as { name?: string } | undefined;

      expect(runColumns.some((column) => column.name === "runtime_mode")).toBe(true);
      expect(sessionColumns.some((column) => column.name === "runtime_mode")).toBe(true);
      expect(runtimeModeTable?.name).toBe("runtime_modes");
    } finally {
      connection?.sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("filters runtime modes by availability, placement, capability, and pagination", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-runtime-mode-filters-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let connection: ReturnType<typeof openSqliteStorage> | undefined;
    try {
      connection = openSqliteStorage(dbPath);
      const registry = new SqliteRegistryStore(connection.db);
      await registry.upsertRuntimeMode(buildRuntimeMode({}));
      await registry.upsertRuntimeMode(
        buildRuntimeMode({
          id: "runtime_mode_codex_exec_json",
          slug: "codex.exec_json",
          name: "Codex exec JSON",
          providerId: "provider_openai",
          runtimeId: "runtime_codex",
          adapterId: "codex",
          kind: "one_shot_process",
          status: "partial",
          capabilities: ["run.start", "run.cancel", "model.catalog", "auth.local"],
          placement: {
            local: { support: "supported", reason: "Local only." },
            hosted: { support: "unsupported", reason: "Not hosted." },
            connectedLocalNode: { support: "conditional", reason: "Hybrid support planned." }
          },
          availability: {
            state: "partial",
            canRun: true,
            installed: true,
            auth: "configured",
            version: "codex 0.130.0",
            checkedAt: startedAt,
            reasonCode: "optional_check_failed",
            message: "Optional check failed."
          }
        })
      );
      await registry.upsertRuntimeMode(
        buildRuntimeMode({
          id: "runtime_mode_fake_secondary",
          slug: "fake.secondary",
          name: "Fake secondary",
          status: "unknown",
          availability: {
            state: "unknown",
            canRun: false,
            installed: false,
            auth: "unknown",
            version: null,
            checkedAt: startedAt,
            reasonCode: null,
            message: null
          }
        })
      );

      expect((await registry.listRuntimeModes({ limit: 10, availability: ["partial"] })).runtimeModes.map((row) => row.slug)).toEqual([
        "codex.exec_json"
      ]);
      expect((await registry.listRuntimeModes({ limit: 10, placement: ["connected_local_node"] })).runtimeModes.map((row) => row.slug)).toEqual([
        "codex.exec_json"
      ]);
      expect((await registry.listRuntimeModes({ limit: 10, capability: ["run.start", "model.catalog"] })).runtimeModes.map((row) => row.slug)).toEqual([
        "codex.exec_json"
      ]);

      const firstPage = await registry.listRuntimeModes({ limit: 1, adapterType: ["process"] });
      expect(firstPage.runtimeModes).toHaveLength(1);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage =
        firstPage.nextCursor === null
          ? await registry.listRuntimeModes({ limit: 1, adapterType: ["process"] })
          : await registry.listRuntimeModes({ limit: 1, adapterType: ["process"], before: firstPage.nextCursor });
      expect(secondPage.runtimeModes).toHaveLength(1);
      expect(secondPage.runtimeModes[0]?.id).not.toBe(firstPage.runtimeModes[0]?.id);
    } finally {
      connection?.sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws for malformed runtime mode JSON columns", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-runtime-mode-malformed-"));
    const dbPath = join(tempDir, "storage.sqlite");
    let connection: ReturnType<typeof openSqliteStorage> | undefined;
    try {
      connection = openSqliteStorage(dbPath);
      const registry = new SqliteRegistryStore(connection.db);
      const mode = buildRuntimeMode({});
      await registry.upsertRuntimeMode(mode);

      connection.sqlite.prepare("UPDATE runtime_modes SET availability_json = ? WHERE id = ?").run("{bad-json", mode.id);
      await expect(registry.getRuntimeMode(mode.id)).rejects.toThrow();

      connection.sqlite
        .prepare("UPDATE runtime_modes SET availability_json = ?, capabilities_json = ? WHERE id = ?")
        .run(JSON.stringify(mode.availability), "{\"bad\":\"shape\"}", mode.id);
      await expect(registry.getRuntimeMode(mode.id)).rejects.toThrow();

      connection.sqlite
        .prepare("UPDATE runtime_modes SET capabilities_json = ?, placement_json = ? WHERE id = ?")
        .run(JSON.stringify(mode.capabilities), "{\"bad\":\"shape\"}", mode.id);
      await expect(registry.getRuntimeMode(mode.id)).rejects.toThrow();
    } finally {
      connection?.sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
