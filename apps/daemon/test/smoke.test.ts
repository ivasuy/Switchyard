import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemonApp } from "../src/app.js";
import type { DaemonConfig } from "../src/config.js";

describe("daemon app", () => {
  it("creates a fake run through the local REST API", async () => {
    const app = createDaemonApp();

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

    const app = createDaemonApp(config);
    let reopened: ReturnType<typeof createDaemonApp> | undefined;
    let closed = false;
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
      closed = true;
      reopened = createDaemonApp(config);
      const getRun = await reopened.inject({ method: "GET", url: `/runs/${runId}` });
      const artifacts = await reopened.inject({ method: "GET", url: `/runs/${runId}/artifacts` });

      expect(getRun.json().run.status).toBe("completed");
      const events = await reopened.inject({ method: "GET", url: `/runs/${runId}/events` });
      expect(events.body).toContain("event: run.queued");
      expect(events.body).toContain("event: run.completed");
      expect(artifacts.json().artifacts[0]).toMatchObject({ runId, type: "transcript" });
    } finally {
      if (!closed) {
        await app.close();
      }
      if (reopened) {
        await reopened.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
