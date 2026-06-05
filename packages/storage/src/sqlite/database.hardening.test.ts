import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SQLITE_SCHEMA_VERSION,
  assertSqliteMigrationStatementSafe,
  getSqliteMigrationPolicy,
  openSqliteStorage
} from "./database.js";

interface SnapshotFixture {
  name: string;
  sql: string;
  expectedRows: Record<string, number>;
}

const SNAPSHOTS: SnapshotFixture[] = [
  {
    name: "pre-r3",
    sql: `
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
CREATE TABLE run_events (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  run_id TEXT,
  sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
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
  external_session_key TEXT,
  process_id INTEGER,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  provider TEXT,
  model TEXT,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE providers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE runtimes (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE models (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  supports_tools INTEGER NOT NULL,
  supports_streaming INTEGER NOT NULL,
  supports_browser INTEGER NOT NULL,
  status TEXT NOT NULL
);
INSERT INTO runs VALUES ('run_pre_r3','fake','test','test-model','process','/repo','legacy run','completed','local','default',600,'{}','2026-05-01T00:00:00.000Z',NULL,NULL);
INSERT INTO run_events VALUES ('event_pre_r3','run.completed','run_pre_r3',1,'{}','2026-05-01T00:00:01.000Z');
INSERT INTO runtime_sessions VALUES ('session_pre_r3','run_pre_r3','fake','test','test-model','process','completed',NULL,NULL,'{}','2026-05-01T00:00:00.000Z',NULL);
INSERT INTO artifacts VALUES ('artifact_pre_r3','run_pre_r3','test','test-model','transcript','runs/run_pre_r3/transcript.jsonl','{}','2026-05-01T00:00:02.000Z');
INSERT INTO providers VALUES ('provider_test','Test','none','available');
INSERT INTO runtimes VALUES ('runtime_fake','Fake Runtime','process','available');
INSERT INTO models VALUES ('model_test','provider_test','test-model',0,1,0,'available');
`,
    expectedRows: {
      runs: 1,
      run_events: 1,
      runtime_sessions: 1,
      artifacts: 1,
      providers: 1,
      runtimes: 1,
      models: 1
    }
  },
  {
    name: "pre-r7",
    sql: `
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
  runtime_mode TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE TABLE runtime_modes (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  placement_json TEXT NOT NULL,
  availability_json TEXT NOT NULL,
  docs_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE placement_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  mode TEXT NOT NULL,
  target_node TEXT,
  required_capabilities_json TEXT NOT NULL,
  denied_capabilities_json TEXT NOT NULL,
  approval_required INTEGER NOT NULL,
  policy_trace_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO runs VALUES ('run_pre_r7','fake','test','test-model','process','/repo','legacy run','completed','local','default',600,'{}','fake.deterministic','2026-05-10T00:00:00.000Z',NULL,NULL);
INSERT INTO runtime_modes VALUES ('runtime_mode_fake_deterministic','fake.deterministic','Fake deterministic','provider_test','runtime_fake','fake','process','deterministic_fake','available','["run.start"]','[]','{"local":{"support":"supported","reason":"ok"},"hosted":{"support":"supported","reason":"ok"},"connectedLocalNode":{"support":"supported","reason":"ok"}}','{"state":"available","canRun":true,"installed":true,"auth":"not_required","version":null,"checkedAt":"2026-05-10T00:00:00.000Z","reasonCode":null,"message":null}','docs/development/API.md','2026-05-10T00:00:00.000Z','2026-05-10T00:00:00.000Z');
INSERT INTO placement_decisions VALUES ('placement_pre_r7','run_pre_r7','local','legacy','automatic',NULL,'[]','[]',0,'{}','2026-05-10T00:00:00.000Z');
`,
    expectedRows: {
      runs: 1,
      runtime_modes: 1,
      placement_decisions: 1
    }
  },
  {
    name: "pre-r9",
    sql: `
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
  runtime_mode TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
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
CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  approval_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
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
INSERT INTO runs VALUES ('run_pre_r9','fake','test','test-model','process','/repo','legacy run','completed','local','default',600,'{}','fake.deterministic','2026-05-15T00:00:00.000Z',NULL,NULL);
INSERT INTO messages VALUES ('message_pre_r9','run_pre_r9',NULL,'ops','hello','[]','delivered','2026-05-15T00:00:00.000Z',NULL);
INSERT INTO memory_items VALUES ('memory_pre_r9','project','project_1','run_pre_r9',NULL,'test','test-model','memory text','{}',NULL,'2026-05-15T00:00:00.000Z');
INSERT INTO evidence_items VALUES ('evidence_pre_r9',NULL,'manual',NULL,'title',NULL,NULL,'primary','2026-05-15T00:00:00.000Z');
INSERT INTO approvals VALUES ('approval_pre_r9','run_pre_r9','before_commit','approved','{}','2026-05-15T00:00:00.000Z','2026-05-15T00:00:00.000Z');
INSERT INTO tool_invocations VALUES ('tool_pre_r9','run_pre_r9','fake_echo','completed',NULL,'{}','{}',NULL,'2026-05-15T00:00:00.000Z','2026-05-15T00:00:00.000Z');
`,
    expectedRows: {
      runs: 1,
      messages: 1,
      memory_items: 1,
      evidence_items: 1,
      approvals: 1,
      tool_invocations: 1
    }
  },
  {
    name: "pre-r11",
    sql: `
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
  runtime_mode TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE TABLE run_events (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  run_id TEXT,
  debate_id TEXT,
  participant_id TEXT,
  provider TEXT,
  model TEXT,
  sequence INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
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
  external_session_key TEXT,
  process_id INTEGER,
  runtime_mode TEXT,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  debate_id TEXT,
  provider TEXT,
  model TEXT,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE providers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE runtimes (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT
);
CREATE TABLE models (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  supports_tools INTEGER NOT NULL,
  supports_streaming INTEGER NOT NULL,
  supports_browser INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE runtime_modes (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  placement_json TEXT NOT NULL,
  availability_json TEXT NOT NULL,
  docs_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  approval_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
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
CREATE TABLE debates (
  id TEXT PRIMARY KEY NOT NULL,
  topic TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  participants_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  message_ids_json TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  judge_json TEXT,
  final_report_artifact_id TEXT,
  final_report_path TEXT,
  stop_reason TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  completed_at TEXT
);
CREATE TABLE placement_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  mode TEXT NOT NULL,
  target_node TEXT,
  required_capabilities_json TEXT NOT NULL,
  denied_capabilities_json TEXT NOT NULL,
  approval_required INTEGER NOT NULL,
  policy_trace_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO runs VALUES ('run_pre_r11','fake','test','test-model','process','/repo','legacy run','completed','local','default',600,'{}','fake.deterministic','2026-05-20T00:00:00.000Z',NULL,NULL);
INSERT INTO run_events VALUES ('event_pre_r11','run.completed','run_pre_r11',NULL,NULL,'test','test-model',1,'{}','2026-05-20T00:00:01.000Z');
INSERT INTO runtime_sessions VALUES ('session_pre_r11','run_pre_r11','fake','test','test-model','process','completed',NULL,NULL,'fake.deterministic','{}','2026-05-20T00:00:00.000Z',NULL);
INSERT INTO artifacts VALUES ('artifact_pre_r11','run_pre_r11',NULL,'test','test-model','transcript','runs/run_pre_r11/transcript.jsonl','{}','2026-05-20T00:00:02.000Z');
INSERT INTO providers VALUES ('provider_test','Test','none','available');
INSERT INTO runtimes VALUES ('runtime_fake','Fake Runtime','process','available','provider_test');
INSERT INTO models VALUES ('model_test','provider_test','test-model',0,1,0,'available');
INSERT INTO runtime_modes VALUES ('runtime_mode_fake_deterministic','fake.deterministic','Fake deterministic','provider_test','runtime_fake','fake','process','deterministic_fake','available','["run.start"]','[]','{"local":{"support":"supported","reason":"ok"},"hosted":{"support":"supported","reason":"ok"},"connectedLocalNode":{"support":"supported","reason":"ok"}}','{"state":"available","canRun":true,"installed":true,"auth":"not_required","version":null,"checkedAt":"2026-05-20T00:00:00.000Z","reasonCode":null,"message":null}','docs/development/API.md','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
INSERT INTO messages VALUES ('message_pre_r11','run_pre_r11',NULL,'ops','hello','[]','delivered','2026-05-20T00:00:00.000Z',NULL);
INSERT INTO memory_items VALUES ('memory_pre_r11','project','project_1','run_pre_r11',NULL,'test','test-model','memory text','{}',NULL,'2026-05-20T00:00:00.000Z');
INSERT INTO evidence_items VALUES ('evidence_pre_r11',NULL,'manual',NULL,'title',NULL,NULL,'primary','2026-05-20T00:00:00.000Z');
INSERT INTO approvals VALUES ('approval_pre_r11','run_pre_r11','before_commit','approved','{}','2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
INSERT INTO tool_invocations VALUES ('tool_pre_r11','run_pre_r11','fake_echo','completed',NULL,'{}','{}',NULL,'2026-05-20T00:00:00.000Z','2026-05-20T00:00:00.000Z');
INSERT INTO debates (
  id, topic, mode, status, participants_json, limits_json, evidence_ids_json, message_ids_json,
  event_ids_json, budget_json, judge_json, final_report_artifact_id, final_report_path,
  stop_reason, error_json, created_at, updated_at, completed_at
) VALUES (
  'debate_pre_r11','topic','cross_provider_debate','completed','[]','{}','[]','[]','[]','{}',
  NULL,NULL,NULL,'completed',NULL,'2026-05-20T00:00:00.000Z',NULL,'2026-05-20T00:00:00.000Z'
);
INSERT INTO placement_decisions VALUES ('placement_pre_r11','run_pre_r11','local','legacy','automatic',NULL,'[]','[]',0,'{}','2026-05-20T00:00:00.000Z');
`,
    expectedRows: {
      runs: 1,
      run_events: 1,
      runtime_sessions: 1,
      artifacts: 1,
      providers: 1,
      runtimes: 1,
      models: 1,
      runtime_modes: 1,
      messages: 1,
      memory_items: 1,
      evidence_items: 1,
      approvals: 1,
      tool_invocations: 1,
      debates: 1,
      placement_decisions: 1
    }
  }
];

describe("sqlite database hardening", () => {
  it("migrates snapshot fixtures across pre-r3/pre-r7/pre-r9/pre-r11 and preserves rows across reopen", () => {
    for (const fixture of SNAPSHOTS) {
      const dir = mkdtempSync(join(tmpdir(), `switchyard-sqlite-${fixture.name}-`));
      const dbPath = join(dir, "switchyard.sqlite");
      try {
        writeSnapshotDatabase(dbPath, fixture.sql);

        const first = openSqliteStorage(dbPath);
        assertSchemaVersion(first.sqlite);
        assertTableCounts(first.sqlite, fixture.expectedRows);
        first.sqlite.close();

        const second = openSqliteStorage(dbPath);
        assertSchemaVersion(second.sqlite);
        assertTableCounts(second.sqlite, fixture.expectedRows);
        second.sqlite.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rejects zero-byte sqlite files", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-zero-byte-"));
    const dbPath = join(dir, "switchyard.sqlite");
    try {
      writeFileSync(dbPath, Buffer.alloc(0));
      expect(() => openSqliteStorage(dbPath)).toThrow(/zero-byte/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt sqlite files", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-corrupt-"));
    const dbPath = join(dir, "switchyard.sqlite");
    try {
      writeFileSync(dbPath, Buffer.from("not-a-sqlite-db", "utf8"));
      expect(() => openSqliteStorage(dbPath)).toThrow(/integrity check|file is not a database/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes destructive-migration policy and rejects destructive statements", () => {
    const policy = getSqliteMigrationPolicy();
    expect(policy.destructiveStatementsForbidden).toBe(true);
    expect(policy.forbiddenTokens).toContain("DROP TABLE");

    expect(() => assertSqliteMigrationStatementSafe("ALTER TABLE runs ADD COLUMN runtime_mode TEXT")).not.toThrow();
    expect(() => assertSqliteMigrationStatementSafe("DROP TABLE runs")).toThrow(/violates additive policy/i);
    expect(() => assertSqliteMigrationStatementSafe("ALTER TABLE runs RENAME TO runs_old")).toThrow(/violates additive policy/i);
  });
});

function writeSnapshotDatabase(path: string, sql: string): void {
  const sqlite = new Database(path);
  try {
    sqlite.exec(sql);
  } finally {
    sqlite.close();
  }
}

function assertSchemaVersion(sqlite: Database.Database): void {
  const metadata = sqlite.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").get() as { value?: string };
  expect(metadata.value).toBe(String(SQLITE_SCHEMA_VERSION));
}

function assertTableCounts(sqlite: Database.Database, expected: Record<string, number>): void {
  for (const [tableName, expectedCount] of Object.entries(expected)) {
    const row = sqlite.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as { count?: number };
    expect(row.count).toBe(expectedCount);
  }
}
