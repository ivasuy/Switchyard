import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type FastifyInstance } from "fastify";
import { createDaemonApp } from "../src/app.js";
import type { DaemonConfig } from "../src/config.js";
import { openSqliteStorage } from "@switchyard/storage";

type CodexProbe = NonNullable<Parameters<typeof createDaemonApp>[1]>["codexProbe"];

const unavailableCodexProbe = {
  ok: false,
  models: [],
  message: "codex not installed"
} satisfies CodexProbe;

const availableCodexProbe = {
  ok: true,
  version: "codex 0.0.0-test",
  models: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high"] }]
} satisfies CodexProbe;

describe("daemon app", () => {
  it("creates a fake run through the local REST API", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: unavailableCodexProbe });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "Smoke test run"
        }
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().run.status).toBe("completed");
    } finally {
      try {
        await app.close();
      } catch {
        // Ensure test cleanup continues if close fails.
      }
    }
  });

  it("persists fake run events and artifacts when configured with local storage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-daemon-"));
    const config: DaemonConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      sqlitePath: join(dir, "switchyard.sqlite"),
      artifactDir: join(dir, "artifacts")
    };

    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    let reopened: FastifyInstance | undefined;
    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "Persistent smoke test"
        }
      });
      expect(response.statusCode).toBe(201);
      const run = response.json().run;
      expect(run).toMatchObject({ id: expect.any(String) });
      const runId = run.id;

      await app.close();
      reopened = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      const getRun = await reopened.inject({ method: "GET", url: `/runs/${runId}` });
      const artifacts = await reopened.inject({ method: "GET", url: `/runs/${runId}/artifacts` });
      const events = await reopened.inject({ method: "GET", url: `/runs/${runId}/events` });
      const provider = await reopened.inject({ method: "GET", url: "/providers/provider_test" });
      const runtime = await reopened.inject({ method: "GET", url: "/runtimes/runtime_fake" });
      const model = await reopened.inject({ method: "GET", url: "/models/model_test" });

      expect(events.statusCode).toBe(200);
      expect(provider.statusCode).toBe(200);
      expect(runtime.statusCode).toBe(200);
      expect(model.statusCode).toBe(200);
      expect(artifacts.statusCode).toBe(200);
      expect(artifacts.json().artifacts).toHaveLength(1);
      expect(getRun.statusCode).toBe(200);
      expect(getRun.json().run.status).toBe("completed");
      expect(events.body).toContain("event: run.queued");
      expect(events.body).toContain("event: run.completed");
      const artifact = artifacts.json().artifacts[0];
      expect(artifact).toMatchObject({ runId, type: "transcript" });
      expect(readFileSync(join(config.artifactDir, artifact.path), "utf8")).toContain("fake runtime output");
      expect(provider.json().provider.name).toBe("Test Provider");
      expect(runtime.json().runtime.name).toBe("Fake Runtime");
      expect(model.json().model.modelName).toBe("test-model");
    } finally {
      try {
        await app.close();
      } catch {
        // Ensure temp data cleanup runs even if app close fails.
      }

      if (reopened) {
        try {
          await reopened.close();
        } catch {
          // Keep cleanup resilient for repeated-run assertions.
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Do not fail cleanup on best-effort temp cleanup.
      }
    }
  });

  it("marks codex provider/runtime unavailable and does not seed codex models when probe is unavailable", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: unavailableCodexProbe });
    try {
      const provider = await app.inject({ method: "GET", url: "/providers/provider_openai" });
      const runtime = await app.inject({ method: "GET", url: "/runtimes/runtime_codex" });
      const model = await app.inject({ method: "GET", url: "/models/model_gpt_5_5" });

      expect(provider.statusCode).toBe(200);
      expect(runtime.statusCode).toBe(200);
      expect(provider.json().provider).toMatchObject({
        id: "provider_openai",
        name: "OpenAI",
        authMode: "local"
      });
      expect(runtime.json().runtime).toMatchObject({
        id: "runtime_codex",
        name: "Codex",
        adapterType: "process"
      });
      expect(provider.json().provider.status).toBe("unavailable");
      expect(runtime.json().runtime.status).toBe("unavailable");
      expect(model.statusCode).toBe(404);
    } finally {
      try {
        await app.close();
      } catch {
        // Keep test cleanup resilient if close throws.
      }
    }
  });

  it("marks codex provider/runtime available and seeds codex model records when probe is available", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: availableCodexProbe });
    try {
      const provider = await app.inject({ method: "GET", url: "/providers/provider_openai" });
      const runtime = await app.inject({ method: "GET", url: "/runtimes/runtime_codex" });
      const model = await app.inject({ method: "GET", url: "/models/model_gpt_5_5" });

      expect(provider.statusCode).toBe(200);
      expect(runtime.statusCode).toBe(200);
      expect(model.statusCode).toBe(200);
      expect(provider.json().provider.status).toBe("available");
      expect(runtime.json().runtime.status).toBe("available");
      expect(model.json().model).toMatchObject({
        id: "model_gpt_5_5",
        providerId: "provider_openai",
        modelName: "gpt-5.5",
        supportsTools: true,
        supportsStreaming: true,
        supportsBrowser: false,
        status: "available"
      });
    } finally {
      try {
        await app.close();
      } catch {
        // Keep test cleanup resilient if close throws.
      }
    }
  });

  it("refreshes codex provider/runtime status on startup when persistent storage is reused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-daemon-codex-status-"));
    const config: DaemonConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      sqlitePath: join(dir, "switchyard.sqlite"),
      artifactDir: join(dir, "artifacts")
    };

    let first: FastifyInstance | undefined;
    let second: FastifyInstance | undefined;
    try {
      first = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      let provider = await first.inject({ method: "GET", url: "/providers/provider_openai" });
      let runtime = await first.inject({ method: "GET", url: "/runtimes/runtime_codex" });
      expect(provider.json().provider.status).toBe("unavailable");
      expect(runtime.json().runtime.status).toBe("unavailable");
      await first.close();
      first = undefined;

      second = await createDaemonApp(config, { codexProbe: availableCodexProbe });
      provider = await second.inject({ method: "GET", url: "/providers/provider_openai" });
      runtime = await second.inject({ method: "GET", url: "/runtimes/runtime_codex" });
      expect(provider.json().provider.status).toBe("available");
      expect(runtime.json().runtime.status).toBe("available");
    } finally {
      if (first) {
        try {
          await first.close();
        } catch {
          // Ensure cleanup remains best-effort.
        }
      }
      if (second) {
        try {
          await second.close();
        } catch {
          // Ensure cleanup remains best-effort.
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Do not fail cleanup on best-effort temp cleanup.
      }
    }
  });

  it("marks persisted running runs failed on daemon restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-daemon-reconcile-"));
    const config: DaemonConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      sqlitePath: join(dir, "switchyard.sqlite"),
      artifactDir: join(dir, "artifacts")
    };

    let app: FastifyInstance | undefined;
    try {
      app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      await app.close();
      app = undefined;

      const storage = openSqliteStorage(config.sqlitePath);
      storage.sqlite.prepare(
        `INSERT INTO runs (
          id, runtime, provider, model, adapter_type, cwd, task, status, placement,
          approval_policy, timeout_seconds, metadata_json, created_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "run_interrupted",
        "codex",
        "openai",
        "gpt-5.5",
        "process",
        "/repo",
        "stale task",
        "running",
        "local",
        "default",
        600,
        "{}",
        "2026-05-14T00:00:00.000Z",
        "2026-05-14T00:00:01.000Z"
      );
      storage.sqlite.prepare(
        `INSERT INTO runtime_sessions (
          id, run_id, runtime, provider, model, protocol, status, process_id, state_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "session_interrupted",
        "run_interrupted",
        "codex",
        "openai",
        "gpt-5.5",
        "process",
        "active",
        1234,
        "{}",
        "2026-05-14T00:00:01.000Z"
      );
      storage.sqlite.close();

      app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      const response = await app.inject({ method: "GET", url: "/runs/run_interrupted" });
      const events = await app.inject({ method: "GET", url: "/runs/run_interrupted/events" });

      expect(response.statusCode).toBe(200);
      expect(response.json().run.status).toBe("failed");
      expect(events.body).toContain("event: run.failed");
      expect(events.body).toContain("daemon_restarted");
    } finally {
      if (app) {
        try {
          await app.close();
        } catch {
          // Keep cleanup resilient for repeated-run assertions.
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Do not fail cleanup on best-effort temp cleanup.
      }
    }
  });
});
