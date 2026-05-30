import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { createDaemonApp } from "../src/app.js";
import type { DaemonConfig } from "../src/config.js";

type CodexProbe = NonNullable<Parameters<typeof createDaemonApp>[1]>["codexProbe"];

const unavailableCodexProbe: CodexProbe = {
  ok: false,
  models: [],
  message: "codex not installed"
};

function tempConfig(prefix: string): DaemonConfig {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    sqlitePath: join(dir, "switchyard.sqlite"),
    artifactDir: join(dir, "artifacts"),
    opencode: {
      command: "opencode"
    },
    acp: {
      requestTimeoutMs: 250,
      cancelTimeoutMs: 250,
      maxMessageBytes: 1024 * 1024
    },
    genericHttp: {
      requestTimeoutMs: 5000,
      pollIntervalMs: 25,
      maxResponseBytes: 1024 * 1024
    }
  };
}

function countOpenFds(): number {
  if (process.platform !== "linux" && process.platform !== "darwin") return -1;
  try {
    // macOS exposes /dev/fd, linux exposes /proc/self/fd. Both list current FDs.
    const path = process.platform === "linux" ? `/proc/${process.pid}/fd` : "/dev/fd";
    return readdirSync(path).length;
  } catch {
    return -1;
  }
}

describe("SSE connection cleanup", { timeout: 60_000 }, () => {
  it("releases subscribers and file descriptors after repeated connect/disconnect", async () => {
    const config = tempConfig("switchyard-daemon-sse-leak-");
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "sse-leak-run"
        }
      });
      expect(created.statusCode).toBe(201);
      const runId = created.json().run.id as string;

      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const url = new URL(`${address}/runs/${runId}/events?live=1`);

      const baselineFds = countOpenFds();

      for (let i = 0; i < 50; i += 1) {
        await openAndAbort(url);
      }

      // Yield so the server-side close handlers run.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // We can't introspect Fastify's internal event bus directly, but we can
      // observe FD growth and confirm the server still responds.
      const fdsAfter = countOpenFds();
      if (baselineFds >= 0 && fdsAfter >= 0) {
        expect(fdsAfter).toBeLessThanOrEqual(baselineFds + 10);
      }

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
    } finally {
      try {
        await app.close();
      } catch {
        // best-effort cleanup
      }
      try {
        rmSync(config.dataDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });
});

function openAndAbort(url: URL): Promise<void> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        method: "GET",
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: { Accept: "text/event-stream" }
      },
      (res) => {
        // Wait for first chunk to ensure the server side has subscribed.
        res.once("data", () => {
          req.destroy();
          resolve();
        });
        res.once("end", () => resolve());
        res.once("error", () => resolve());
      }
    );
    req.on("error", () => resolve());
    req.setTimeout(1_000, () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
}
