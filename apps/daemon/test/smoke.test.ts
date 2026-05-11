import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type FastifyInstance } from "fastify";
import { createDaemonApp } from "../src/app.js";
import type { DaemonConfig } from "../src/config.js";

describe("daemon app", () => {
  it("creates a fake run through the local REST API", async () => {
    const app = await createDaemonApp();
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

    const app = await createDaemonApp(config);
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
      const runId = response.json().run.id;

      await app.close();
      reopened = await createDaemonApp(config);
      const getRun = await reopened.inject({ method: "GET", url: `/runs/${runId}` });
      const artifacts = await reopened.inject({ method: "GET", url: `/runs/${runId}/artifacts` });

      expect(getRun.json().run.status).toBe("completed");
      const events = await reopened.inject({ method: "GET", url: `/runs/${runId}/events` });
      const provider = await reopened.inject({ method: "GET", url: "/providers/provider_test" });
      const runtime = await reopened.inject({ method: "GET", url: "/runtimes/runtime_fake" });
      const model = await reopened.inject({ method: "GET", url: "/models/model_test" });

      expect(events.body).toContain("event: run.queued");
      expect(events.body).toContain("event: run.completed");
      const artifact = artifacts.json().artifacts[0];
      expect(artifact).toMatchObject({ runId, type: "transcript" });
      expect(readFileSync(join(config.artifactDir, artifact.path), "utf8")).toContain("fake runtime output");
      expect(provider.statusCode).toBe(200);
      expect(provider.json().provider.name).toBe("Test Provider");
      expect(runtime.statusCode).toBe(200);
      expect(runtime.json().runtime.name).toBe("Fake Runtime");
      expect(model.statusCode).toBe(200);
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
});
