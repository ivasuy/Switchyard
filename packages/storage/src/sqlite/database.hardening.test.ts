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

describe("sqlite database hardening", () => {
  it("writes schema_version metadata and remains stable across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-sqlite-hardening-"));
    const dbPath = join(dir, "switchyard.sqlite");
    try {
      const first = openSqliteStorage(dbPath);
      first.sqlite
        .prepare(
          "INSERT INTO runs (id, runtime, provider, model, adapter_type, cwd, task, status, placement, approval_policy, timeout_seconds, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          "run_pre_r11",
          "fake",
          "test",
          "model",
          "process",
          "/repo",
          "task",
          "completed",
          "local",
          "default",
          600,
          "{}",
          "2026-05-30T00:00:00.000Z"
        );
      const metadata = first.sqlite.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").get() as { value?: string };
      expect(metadata.value).toBe(String(SQLITE_SCHEMA_VERSION));
      first.sqlite.close();

      const second = openSqliteStorage(dbPath);
      const rowCount = second.sqlite.prepare("SELECT COUNT(*) as count FROM runs").get() as { count?: number };
      const metadataAgain = second.sqlite.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").get() as { value?: string };
      expect(rowCount.count).toBe(1);
      expect(metadataAgain.value).toBe(String(SQLITE_SCHEMA_VERSION));
      second.sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
