import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import {
  MemoryArtifactContentStore,
  ObjectArtifactContentStore,
  LocalObjectArtifactContentStore,
  PostgresAssignmentStore,
  PostgresArtifactStore,
  PostgresEventStore,
  PostgresNodeStore,
  PostgresPlacementStore,
  PostgresRegistryStore,
  PostgresRunStore,
  PostgresSessionStore,
  openSqliteStorage,
  SqliteApprovalStore,
  SqliteDebateStore,
  SqliteEvidenceStore,
  SqliteMemoryStore,
  SqliteMessageStore,
  SqliteToolInvocationStore
} from "../src/index.js";

describe("storage package", () => {
  it("scopes AWS SDK dependencies to storage package only", () => {
    const rootPackageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const storagePackageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const serverPackageJson = JSON.parse(readFileSync(new URL("../../../apps/server/package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const workerPackageJson = JSON.parse(readFileSync(new URL("../../../apps/worker/package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const corePackageJson = JSON.parse(readFileSync(new URL("../../../packages/core/package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const protocolRestPackageJson = JSON.parse(readFileSync(new URL("../../../packages/protocol-rest/package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const contractsPackageJson = JSON.parse(readFileSync(new URL("../../../packages/contracts/package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const lockfile = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");

    expect(storagePackageJson.dependencies?.["@aws-sdk/client-s3"]).toBeTruthy();
    expect(storagePackageJson.dependencies?.["@smithy/node-http-handler"]).toBeTruthy();

    const disallowed = [
      rootPackageJson.dependencies,
      rootPackageJson.devDependencies,
      serverPackageJson.dependencies,
      workerPackageJson.dependencies,
      corePackageJson.dependencies,
      protocolRestPackageJson.dependencies,
      contractsPackageJson.dependencies
    ];
    for (const section of disallowed) {
      expect(section?.["@aws-sdk/client-s3"]).toBeFalsy();
      expect(section?.["@smithy/node-http-handler"]).toBeFalsy();
    }

    const storageImporterStart = lockfile.indexOf("  packages/storage:");
    expect(storageImporterStart).toBeGreaterThan(-1);
    const importersBlockEnd = lockfile.indexOf("\npackages:", storageImporterStart);
    const importersBlock = lockfile.slice(storageImporterStart, importersBlockEnd > -1 ? importersBlockEnd : undefined);
    expect(importersBlock).toContain("@aws-sdk/client-s3");
    expect(importersBlock).toContain("@smithy/node-http-handler");

    expect(lockfile).not.toMatch(/apps\/server:[\\s\\S]*@aws-sdk\/client-s3/);
    expect(lockfile).not.toMatch(/apps\/worker:[\\s\\S]*@aws-sdk\/client-s3/);
    expect(lockfile).not.toMatch(/packages\/core:[\\s\\S]*@aws-sdk\/client-s3/);
    expect(lockfile).not.toMatch(/packages\/protocol-rest:[\\s\\S]*@aws-sdk\/client-s3/);
    expect(lockfile).not.toMatch(/packages\/contracts:[\\s\\S]*@aws-sdk\/client-s3/);
  });

  it("opens sqlite storage and executes a query", () => {
    const opened = openSqliteStorage(":memory:");

    try {
      const row = opened.sqlite.prepare("SELECT 1 AS value").get() as { value: number };
      expect(opened).toHaveProperty("sqlite");
      expect(opened).toHaveProperty("db");
      expect(row.value).toBe(1);
    } finally {
      opened.sqlite.close();
    }
  });

  it("exports R10 postgres and artifact-content implementations", () => {
    expect(typeof PostgresRunStore).toBe("function");
    expect(typeof PostgresEventStore).toBe("function");
    expect(typeof PostgresSessionStore).toBe("function");
    expect(typeof PostgresArtifactStore).toBe("function");
    expect(typeof PostgresRegistryStore).toBe("function");
    expect(typeof PostgresPlacementStore).toBe("function");
    expect(typeof PostgresNodeStore).toBe("function");
    expect(typeof PostgresAssignmentStore).toBe("function");
    expect(typeof MemoryArtifactContentStore).toBe("function");
    expect(typeof ObjectArtifactContentStore).toBe("function");
    expect(typeof LocalObjectArtifactContentStore).toBe("function");
  });

  it("creates middleware tables and indexes in fresh sqlite databases", () => {
    const opened = openSqliteStorage(":memory:");
    try {
      const tables = opened.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const tableSet = new Set(tables.map((row) => row.name));
      expect(tableSet.has("memory_items")).toBe(true);
      expect(tableSet.has("evidence_items")).toBe(true);
      expect(tableSet.has("tool_invocations")).toBe(true);
      expect(tableSet.has("debates")).toBe(true);

      const toolIndexes = opened.sqlite
        .prepare("PRAGMA index_list('tool_invocations')")
        .all() as Array<{ name: string }>;
      const indexNames = toolIndexes.map((row) => row.name);
      expect(indexNames).toContain("tool_invocations_created_at_idx");
      expect(indexNames).toContain("tool_invocations_approval_id_idx");
      const debateIndexes = opened.sqlite
        .prepare("PRAGMA index_list('debates')")
        .all() as Array<{ name: string }>;
      const debateIndexNames = debateIndexes.map((row) => row.name);
      expect(debateIndexNames).toContain("debates_created_at_idx");
      expect(debateIndexNames).toContain("debates_status_idx");
    } finally {
      opened.sqlite.close();
    }
  });

  it("keeps middleware records available after reopening a file-backed database", async () => {
    const filePath = `${process.cwd()}/.tmp-storage-package-r7.sqlite`;
    const first = openSqliteStorage(filePath);
    try {
      const messageStore = new SqliteMessageStore(first.db);
      const memoryStore = new SqliteMemoryStore(first.db);
      const evidenceStore = new SqliteEvidenceStore(first.db);
      const approvalStore = new SqliteApprovalStore(first.db);
      const invocationStore = new SqliteToolInvocationStore(first.db);
      const debateStore = new SqliteDebateStore(first.db);

      await messageStore.create({
        id: "message_1",
        content: "hello",
        attachments: [],
        deliveryStatus: "delivered",
        createdAt: "2026-05-30T00:00:00.000Z",
        deliveredAt: "2026-05-30T00:00:00.000Z"
      });
      await memoryStore.create({
        id: "memory_1",
        scope: "project",
        content: "memory",
        metadata: {},
        createdAt: "2026-05-30T00:00:00.000Z"
      });
      await evidenceStore.create({
        id: "evidence_1",
        sourceType: "manual",
        title: "title",
        reliability: "primary",
        createdAt: "2026-05-30T00:00:00.000Z"
      });
      await approvalStore.create({
        id: "approval_1",
        approvalType: "before_external_web_action",
        status: "pending",
        payload: {},
        createdAt: "2026-05-30T00:00:00.000Z"
      });
      await invocationStore.create({
        id: "tool_1",
        type: "fake_echo",
        status: "queued",
        input: {},
        createdAt: "2026-05-30T00:00:00.000Z"
      });
      await debateStore.create({
        id: "debate_1",
        topic: "Persist me",
        mode: "same_provider_model_debate",
        status: "created",
        participants: [
          {
            id: "participant_1",
            runtime: "fake",
            provider: "test",
            model: "test-model",
            role: "affirmative",
            status: "created",
            turnsUsed: 0,
            runIds: []
          },
          {
            id: "participant_2",
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
        createdAt: "2026-05-30T00:00:00.000Z"
      });
    } finally {
      first.sqlite.close();
    }

    const reopened = openSqliteStorage(filePath);
    try {
      const messageStore = new SqliteMessageStore(reopened.db);
      const memoryStore = new SqliteMemoryStore(reopened.db);
      const evidenceStore = new SqliteEvidenceStore(reopened.db);
      const approvalStore = new SqliteApprovalStore(reopened.db);
      const invocationStore = new SqliteToolInvocationStore(reopened.db);
      const debateStore = new SqliteDebateStore(reopened.db);

      expect(await messageStore.get("message_1")).toBeTruthy();
      expect(await memoryStore.get("memory_1")).toBeTruthy();
      expect(await evidenceStore.get("evidence_1")).toBeTruthy();
      expect(await approvalStore.get("approval_1")).toBeTruthy();
      expect(await invocationStore.get("tool_1")).toBeTruthy();
      expect(await debateStore.get("debate_1")).toBeTruthy();
    } finally {
      reopened.sqlite.close();
      rmSync(filePath, { force: true });
    }
  });

  it("applies additive migrations on pre-R7 sqlite while preserving existing R6 rows", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "switchyard-r6-storage-"));
    const filePath = join(tempDir, "storage.sqlite");
    const preR7 = new Database(filePath);
    try {
      preR7.exec(`
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
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  protocol TEXT NOT NULL,
  status TEXT NOT NULL,
  external_session_key TEXT,
  process_id INTEGER,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE runtimes (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  from_run_id TEXT,
  to_run_id TEXT,
  channel TEXT,
  content TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  approval_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE memory_items (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  debate_id TEXT,
  provider TEXT,
  model TEXT,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  embedding_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE evidence_items (
  id TEXT PRIMARY KEY NOT NULL,
  debate_id TEXT,
  source_type TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL,
  snippet TEXT,
  fetched_content_path TEXT,
  reliability TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tool_invocations (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  approval_id TEXT,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
`);

      preR7
        .prepare(
          `INSERT INTO runs (id, runtime, provider, model, adapter_type, cwd, task, status, placement, approval_policy, timeout_seconds, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "run_r6",
          "fake",
          "test",
          "test-model",
          "native",
          "/repo",
          "task",
          "queued",
          "local",
          "default",
          30,
          "{\"source\":\"r6\"}",
          "2026-05-30T00:00:00.000Z"
        );
      preR7
        .prepare(
          `INSERT INTO runtime_sessions (id, run_id, runtime, provider, model, protocol, status, state_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "session_r6",
          "run_r6",
          "fake",
          "test",
          "test-model",
          "native",
          "active",
          "{\"cursor\":1}",
          "2026-05-30T00:00:00.000Z"
        );
      preR7
        .prepare(`INSERT INTO runtimes (id, name, adapter_type, status) VALUES (?, ?, ?, ?)`)
        .run("runtime_r6", "Fake", "native", "available");
    } finally {
      preR7.close();
    }

    const opened = openSqliteStorage(filePath);
    try {
      const runRow = opened.sqlite
        .prepare(`SELECT id, runtime_mode, metadata_json FROM runs WHERE id = ?`)
        .get("run_r6") as { id: string; runtime_mode: string | null; metadata_json: string };
      expect(runRow.id).toBe("run_r6");
      expect(runRow.runtime_mode).toBeNull();
      expect(runRow.metadata_json).toContain("\"r6\"");

      const sessionRow = opened.sqlite
        .prepare(`SELECT id, runtime_mode, state_json FROM runtime_sessions WHERE id = ?`)
        .get("session_r6") as { id: string; runtime_mode: string | null; state_json: string };
      expect(sessionRow.id).toBe("session_r6");
      expect(sessionRow.runtime_mode).toBeNull();
      expect(sessionRow.state_json).toContain("\"cursor\":1");

      const runtimeRow = opened.sqlite
        .prepare(`SELECT id, provider_id FROM runtimes WHERE id = ?`)
        .get("runtime_r6") as { id: string; provider_id: string | null };
      expect(runtimeRow.id).toBe("runtime_r6");
      expect(runtimeRow.provider_id).toBeNull();

      const indexesByTable: Record<string, string[]> = {};
      for (const table of ["messages", "approvals", "memory_items", "evidence_items", "tool_invocations"]) {
        const rows = opened.sqlite.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string }>;
        indexesByTable[table] = rows.map((row) => row.name);
      }

      expect(indexesByTable.messages).toEqual(
        expect.arrayContaining([
          "messages_from_run_id_idx",
          "messages_to_run_id_idx",
          "messages_channel_idx",
          "messages_created_at_idx"
        ])
      );
      expect(indexesByTable.approvals).toEqual(
        expect.arrayContaining(["approvals_run_id_idx", "approvals_status_idx", "approvals_type_idx", "approvals_created_at_idx"])
      );
      expect(indexesByTable.memory_items).toEqual(
        expect.arrayContaining([
          "memory_items_scope_idx",
          "memory_items_project_id_idx",
          "memory_items_run_id_idx",
          "memory_items_debate_id_idx",
          "memory_items_provider_idx",
          "memory_items_model_idx",
          "memory_items_created_at_idx"
        ])
      );
      expect(indexesByTable.evidence_items).toEqual(
        expect.arrayContaining([
          "evidence_items_debate_id_idx",
          "evidence_items_source_type_idx",
          "evidence_items_reliability_idx",
          "evidence_items_created_at_idx"
        ])
      );
      expect(indexesByTable.tool_invocations).toEqual(
        expect.arrayContaining([
          "tool_invocations_run_id_idx",
          "tool_invocations_type_idx",
          "tool_invocations_status_idx",
          "tool_invocations_approval_id_idx",
          "tool_invocations_created_at_idx"
        ])
      );
    } finally {
      opened.sqlite.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
