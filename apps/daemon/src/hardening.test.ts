import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexCatalogProbe } from "@switchyard/adapters";
import { openSqliteStorage } from "@switchyard/storage";
import { describe, expect, it } from "vitest";
import { createDaemonApp } from "./app.js";
import type { DaemonConfig } from "./config.js";

const unavailableCodexProbe = {
  ok: false,
  models: [],
  message: "codex unavailable"
} satisfies CodexCatalogProbe;

function tempConfig(prefix: string): DaemonConfig {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    sqlitePath: join(dir, "switchyard.sqlite"),
    artifactDir: join(dir, "artifacts"),
    opencode: { command: "opencode" },
    claudeCode: {
      command: "claude",
      liveProbe: false,
      maxBudgetUsd: 0.05,
      requestTimeoutMs: 5000
    },
    acp: {
      requestTimeoutMs: 5000,
      cancelTimeoutMs: 5000,
      maxMessageBytes: 1024 * 1024
    },
    genericHttp: {
      requestTimeoutMs: 5000,
      pollIntervalMs: 100,
      maxResponseBytes: 1024 * 1024
    },
    agentfield: {
      requestTimeoutMs: 5000,
      pollIntervalMs: 100,
      maxResponseBytes: 1024 * 1024
    }
  };
}

function insertActiveRun(sqlite: ReturnType<typeof openSqliteStorage>["sqlite"], id: string, status: string): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO runs (
        id, runtime, provider, model, adapter_type, cwd, task, status, placement, approval_policy,
        timeout_seconds, metadata_json, runtime_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      "fake",
      "test",
      "test-model",
      "process",
      "/repo",
      "recover me",
      status,
      "local",
      "default",
      600,
      "{}",
      "fake.deterministic",
      now
    );

  sqlite
    .prepare(
      `INSERT INTO runtime_sessions (
        id, run_id, runtime, provider, model, protocol, status, runtime_mode, state_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(`session_${id}`, id, "fake", "test", "test-model", "process", "active", "fake.deterministic", "{}", now);
}

describe("daemon hardening", () => {
  it("honors bounded inbound request ids and normalizes invalid request-id headers", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: unavailableCodexProbe });
    try {
      const accepted = await app.inject({
        method: "GET",
        url: "/runs/run_missing",
        headers: {
          "x-request-id": "req_valid-123"
        }
      });
      expect(accepted.statusCode).toBe(404);
      expect(accepted.headers["x-request-id"]).toBe("req_valid-123");
      const acceptedBody = accepted.json() as { error?: { requestId?: string } };
      expect(acceptedBody.error?.requestId).toBe("req_valid-123");

      const rejected = await app.inject({
        method: "GET",
        url: "/runs/run_missing",
        headers: {
          "x-request-id": "invalid request id with spaces"
        }
      });
      expect(rejected.statusCode).toBe(404);
      expect(rejected.headers["x-request-id"]).toMatch(/^req_[0-9a-f-]{36}$/);
      const rejectedBody = rejected.json() as { error?: { requestId?: string } };
      expect(rejectedBody.error?.requestId).toBe(rejected.headers["x-request-id"]);
    } finally {
      await app.close();
    }
  });

  it("exposes request/error metrics and run status counts", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: unavailableCodexProbe });
    try {
      await app.inject({ method: "GET", url: "/health" });
      await app.inject({ method: "GET", url: "/missing-route" });
      await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "metrics test"
        }
      });

      const metricsResponse = await app.inject({ method: "GET", url: "/metrics" });
      expect(metricsResponse.statusCode).toBe(200);
      const metrics = metricsResponse.json();
      expect(metrics.requestsTotal).toBeGreaterThanOrEqual(3);
      expect(metrics.errorsTotal).toBeGreaterThanOrEqual(1);
      expect(metrics.runStatusCounts.completed).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  it("recovers interrupted runs once and stays idempotent on next startup", async () => {
    const config = tempConfig("switchyard-recovery-");

    const storage = openSqliteStorage(config.sqlitePath);
    try {
      insertActiveRun(storage.sqlite, "run_starting", "starting");
      insertActiveRun(storage.sqlite, "run_running", "running");
      insertActiveRun(storage.sqlite, "run_waiting_input", "waiting_for_input");
      insertActiveRun(storage.sqlite, "run_waiting_approval", "waiting_for_approval");
    } finally {
      storage.sqlite.close();
    }

    const first = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const metrics = (await first.inject({ method: "GET", url: "/metrics" })).json();
      expect(metrics.startupRecovery.recoveredRuns).toBe(4);
      expect(metrics.startupRecovery.failedSessions).toBe(4);
      expect(metrics.runStatusCounts.failed).toBe(4);
    } finally {
      await first.close();
    }

    const second = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const metrics = (await second.inject({ method: "GET", url: "/metrics" })).json();
      expect(metrics.startupRecovery.recoveredRuns).toBe(0);
      expect(metrics.startupRecovery.duplicateStarts).toBe(0);
      expect(metrics.runStatusCounts.failed).toBe(4);
    } finally {
      await second.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });
});
