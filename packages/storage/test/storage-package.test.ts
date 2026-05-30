import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import {
  openSqliteStorage,
  SqliteApprovalStore,
  SqliteEvidenceStore,
  SqliteMemoryStore,
  SqliteMessageStore,
  SqliteToolInvocationStore
} from "../src/index.js";

describe("storage package", () => {
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

      const toolIndexes = opened.sqlite
        .prepare("PRAGMA index_list('tool_invocations')")
        .all() as Array<{ name: string }>;
      const indexNames = toolIndexes.map((row) => row.name);
      expect(indexNames).toContain("tool_invocations_created_at_idx");
      expect(indexNames).toContain("tool_invocations_approval_id_idx");
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

      expect(await messageStore.get("message_1")).toBeTruthy();
      expect(await memoryStore.get("memory_1")).toBeTruthy();
      expect(await evidenceStore.get("evidence_1")).toBeTruthy();
      expect(await approvalStore.get("approval_1")).toBeTruthy();
      expect(await invocationStore.get("tool_1")).toBeTruthy();
    } finally {
      reopened.sqlite.close();
      rmSync(filePath, { force: true });
    }
  });
});
