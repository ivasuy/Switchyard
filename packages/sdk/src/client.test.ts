import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDaemonApp } from "../../../apps/daemon/src/app.js";
import type { CodexCatalogProbe } from "@switchyard/adapters";
import type { DaemonConfig } from "../../../apps/daemon/src/config.js";
import {
  SwitchyardClient,
  SwitchyardDecodeError,
  SwitchyardHttpError,
  SwitchyardNetworkError,
  SwitchyardStreamError,
  SwitchyardTimeoutError,
  SwitchyardValidationError
} from "./index.js";

const unavailableCodexProbe = {
  ok: false,
  models: [],
  message: "codex unavailable"
} satisfies CodexCatalogProbe;

const openApps: Array<{ close(): Promise<void> }> = [];
const tempDirs: string[] = [];

afterAll(async () => {
  while (openApps.length > 0) {
    const app = openApps.pop();
    if (app) {
      await app.close();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

async function startServer(): Promise<{ baseUrl: string }> {
  const config = createTempConfig();
  const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
  openApps.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function createTempConfig(): DaemonConfig {
  const dir = mkdtempSync(join(tmpdir(), "switchyard-sdk-test-"));
  tempDirs.push(dir);
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
      pollIntervalMs: 1000,
      maxResponseBytes: 1024 * 1024
    }
  };
}

describe("SwitchyardClient", () => {
  it("runs fake lifecycle and artifact metadata/content flows", async () => {
    const { baseUrl } = await startServer();
    const client = new SwitchyardClient({ baseUrl });

    const created = await client.createRun({
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "sdk lifecycle",
      timeoutSeconds: 10
    }, { wait: true });

    expect(created.run.status).toBe("completed");

    const fetched = await client.getRun(created.run.id);
    expect(fetched.run.id).toBe(created.run.id);
    expect(fetched.events.some((event) => event.type === "run.completed")).toBe(true);

    const replay = await client.replayRunEvents(created.run.id);
    expect(replay.some((event) => event.type === "runtime.output")).toBe(true);

    const runArtifacts = await client.listRunArtifacts(created.run.id);
    expect(runArtifacts.artifacts.length).toBeGreaterThan(0);

    const artifact = await client.getArtifact(runArtifacts.artifacts[0]!.id);
    const content = await client.getArtifactContent(artifact.id);
    expect(content.contentType.length).toBeGreaterThan(0);
    expect(content.body.length).toBeGreaterThan(0);
  });

  it("keeps local fake run/event/artifact/registry flows credential-free by default", async () => {
    const { baseUrl } = await startServer();
    const expectedOrigin = new URL(baseUrl).origin;
    let requestCount = 0;

    const client = new SwitchyardClient({
      baseUrl,
      fetch: async (input, init) => {
        const request = new Request(input as RequestInfo, init);
        const target = new URL(request.url);
        expect(target.origin).toBe(expectedOrigin);
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("x-switchyard-api-key")).toBeNull();
        requestCount += 1;
        return await fetch(request);
      }
    });

    const created = await client.createRun({
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "sdk no-key local flow",
      timeoutSeconds: 10
    }, { wait: true });
    expect(created.run.status).toBe("completed");

    const fetched = await client.getRun(created.run.id);
    expect(fetched.run.id).toBe(created.run.id);

    const events = await client.listRunEvents(created.run.id);
    expect(events.some((event) => event.type === "runtime.output")).toBe(true);

    const runArtifacts = await client.listRunArtifacts(created.run.id);
    expect(runArtifacts.artifacts.length).toBeGreaterThan(0);
    const artifact = await client.getArtifact(runArtifacts.artifacts[0]!.id);
    const content = await client.getArtifactContent(artifact.id);
    expect(content.body.length).toBeGreaterThan(0);

    const providers = await client.listProviders();
    const runtimes = await client.listRuntimes();
    const models = await client.listModels();
    expect(providers.providers.length).toBeGreaterThan(0);
    expect(runtimes.runtimes.length).toBeGreaterThan(0);
    expect(models.models.length).toBeGreaterThan(0);
    expect(requestCount).toBeGreaterThanOrEqual(8);
  });

  it("throws SwitchyardHttpError with status/code/requestId", async () => {
    const { baseUrl } = await startServer();
    const client = new SwitchyardClient({ baseUrl });

    await expect(client.getRun("run_missing")).rejects.toMatchObject({
      name: "SwitchyardHttpError",
      status: 404,
      code: "run_not_found"
    } satisfies Partial<SwitchyardHttpError>);
  });

  it("throws SwitchyardNetworkError for unreachable daemon", async () => {
    const client = new SwitchyardClient({ baseUrl: "http://127.0.0.1:9" });
    await expect(client.health()).rejects.toBeInstanceOf(SwitchyardNetworkError);
  });

  it("throws SwitchyardTimeoutError when request exceeds timeout", async () => {
    const client = new SwitchyardClient({
      baseUrl: "http://unused.test",
      timeoutMs: 10,
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })
    });
    await expect(client.health()).rejects.toBeInstanceOf(SwitchyardTimeoutError);
  });

  it("throws SwitchyardDecodeError for malformed JSON payloads", async () => {
    const client = new SwitchyardClient({
      baseUrl: "http://unused.test",
      fetch: async () => new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });
    await expect(client.health()).rejects.toBeInstanceOf(SwitchyardDecodeError);
  });

  it("throws SwitchyardValidationError for missing ids", async () => {
    const client = new SwitchyardClient({ baseUrl: "http://127.0.0.1:4545" });
    await expect(client.getRun("")).rejects.toBeInstanceOf(SwitchyardValidationError);
  });

  it("throws SwitchyardStreamError for malformed SSE frame", async () => {
    const client = new SwitchyardClient({
      baseUrl: "http://unused.test",
      fetch: async () => new Response("event: run.started\ndata: not-json\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    });

    await expect(client.replayRunEvents("run_x")).rejects.toBeInstanceOf(SwitchyardStreamError);
  });
});
