import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type FastifyInstance } from "fastify";
import type { CodexCatalogProbe } from "@switchyard/adapters";
import { startFakeHttpRuntimeServer } from "@switchyard/testkit";
import { createDaemonApp } from "../src/app.js";
import type { DaemonConfig } from "../src/config.js";
import { openSqliteStorage } from "@switchyard/storage";

function tempDaemonConfig(prefix: string): DaemonConfig {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    sqlitePath: join(dir, "switchyard.sqlite"),
    artifactDir: join(dir, "artifacts"),
    genericHttp: {
      requestTimeoutMs: 5000,
      pollIntervalMs: 25,
      maxResponseBytes: 1024 * 1024
    }
  };
}

type CodexProbe = CodexCatalogProbe;

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

const partialCodexProbe = {
  ok: true,
  version: "codex 0.0.0-test",
  models: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high"] }],
  optionalChecks: {
    sandbox_policy_probe: {
      ok: false,
      message: "optional sandbox probe failed"
    }
  }
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
      artifactDir: join(dir, "artifacts"),
      genericHttp: {
        requestTimeoutMs: 5000,
        pollIntervalMs: 25,
        maxResponseBytes: 1024 * 1024
      }
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

  it("exposes runtime mode and doctor routes with seeded runtime mode availability", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: availableCodexProbe });
    try {
      const list = await app.inject({ method: "GET", url: "/runtime-modes" });
      const codex = await app.inject({ method: "GET", url: "/runtime-modes/codex.exec_json" });
      const doctor = await app.inject({ method: "GET", url: "/doctor" });
      expect(list.statusCode).toBe(200);
      expect(list.json().runtimeModes.map((mode: { slug: string }) => mode.slug).sort()).toEqual([
        "codex.exec_json",
        "fake.deterministic",
        "generic_http.async_rest"
      ]);
      expect(codex.statusCode).toBe(200);
      expect(codex.json().runtimeMode.availability.state).toBe("available");
      expect(doctor.statusCode).toBe(200);
      expect(doctor.json().summary.available).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("seeds generic http mode as unavailable when base URL is missing", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: unavailableCodexProbe });
    try {
      const mode = await app.inject({ method: "GET", url: "/runtime-modes/generic_http.async_rest" });
      expect(mode.statusCode).toBe(200);
      expect(mode.json().runtimeMode.availability.reasonCode).toBe("generic_http_config_missing");
      expect(mode.json().runtimeMode.availability.state).toBe("unavailable");
    } finally {
      await app.close();
    }
  });

  it("runs generic http checks and wait=1 lifecycle against fake wrapper", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "happy" });
    const config = tempDaemonConfig("switchyard-daemon-generic-http-");
    config.genericHttp.baseUrl = server.baseUrl;
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const check = await app.inject({ method: "POST", url: "/runtime-modes/generic_http.async_rest/check" });
      expect(check.statusCode).toBe(200);
      expect(check.json().check.state).toBe("available");

      const run = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "generic_http",
          provider: "generic_http",
          model: "generic-http-default",
          adapterType: "http",
          cwd: "/repo",
          task: "generic http smoke"
        }
      });
      expect(run.statusCode).toBe(201);
      expect(run.json().run.runtimeMode).toBe("generic_http.async_rest");
      expect(run.json().run.status).toBe("completed");
      expect(run.json().response.text).toBe("generic-http output");

      const runId = run.json().run.id;
      const artifacts = await app.inject({ method: "GET", url: `/runs/${runId}/artifacts` });
      expect(artifacts.statusCode).toBe(200);
      expect(artifacts.json().artifacts.some((artifact: { path: string }) => artifact.path.includes("generic-http-transcript"))).toBe(true);
      const input = await app.inject({
        method: "POST",
        url: `/runs/${runId}/input`,
        payload: { text: "continue" }
      });
      expect(input.statusCode).toBe(409);
      expect(input.json().error.code).toBe("adapter_protocol_failed");
    } finally {
      await app.close();
      await server.close();
    }
  });

  it("maps generic http cancel protocol failures to 409 without silent cancellation", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "cancel_accepted_but_status_running" });
    const config = tempDaemonConfig("switchyard-daemon-generic-cancel-");
    config.genericHttp.baseUrl = server.baseUrl;
    config.genericHttp.pollIntervalMs = 10;
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "generic_http",
          provider: "generic_http",
          model: "generic-http-default",
          adapterType: "http",
          cwd: "/repo",
          task: "cancel protocol failure"
        }
      });
      expect(created.statusCode).toBe(202);
      const runId = created.json().run.id;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const read = await app.inject({ method: "GET", url: `/runs/${runId}` });
        if (read.statusCode === 200 && read.json().run.status === "running") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cancel = await app.inject({ method: "POST", url: `/runs/${runId}/cancel` });
      expect(cancel.statusCode).toBe(409);
      expect(cancel.json().error.code).toBe("adapter_protocol_failed");
      const read = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(read.statusCode).toBe(200);
      expect(read.json().run.status).not.toBe("cancelled");
    } finally {
      await app.close();
      await server.close();
    }
  });

  it("records partial codex availability during startup and in /doctor summary", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: partialCodexProbe });
    try {
      const codex = await app.inject({ method: "GET", url: "/runtime-modes/codex.exec_json" });
      const doctor = await app.inject({ method: "GET", url: "/doctor" });
      expect(codex.statusCode).toBe(200);
      expect(codex.json().runtimeMode.availability.state).toBe("partial");
      expect(codex.json().runtimeMode.availability.reasonCode).toBe("optional_check_failed");
      expect(doctor.statusCode).toBe(200);
      expect(doctor.json().summary.partial).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("runs bounded active checks and updates stored codex availability", async () => {
    const checkProbe = async () => ({
      ok: true,
      version: "codex 0.0.0-test",
      models: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high"] }]
    });
    const app = await createDaemonApp(undefined, {
      codexProbe: unavailableCodexProbe,
      probeCodexCatalog: checkProbe,
      checkTimeoutMs: 50,
      maxDiagnosticBytes: 128
    });
    try {
      const check = await app.inject({ method: "POST", url: "/runtime-modes/codex.exec_json/check" });
      const doctor = await app.inject({ method: "GET", url: "/doctor" });
      expect(check.statusCode).toBe(200);
      expect(check.json().check.state).toBe("available");
      expect(doctor.statusCode).toBe(200);
      expect(doctor.json().summary.available).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("maps required-pass plus optional-fail active checks to partial and updates /doctor", async () => {
    const partialCheckProbe = async () => ({
      ok: true,
      version: "codex 0.0.0-test",
      models: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high"] }],
      optionalChecks: {
        sandbox_policy_probe: {
          ok: false,
          message: "optional sandbox probe failed"
        }
      }
    });
    const app = await createDaemonApp(undefined, {
      codexProbe: unavailableCodexProbe,
      probeCodexCatalog: partialCheckProbe,
      checkTimeoutMs: 50,
      maxDiagnosticBytes: 128
    });
    try {
      const check = await app.inject({ method: "POST", url: "/runtime-modes/codex.exec_json/check" });
      const doctor = await app.inject({ method: "GET", url: "/doctor" });
      const mode = await app.inject({ method: "GET", url: "/runtime-modes/codex.exec_json" });
      expect(check.statusCode).toBe(200);
      expect(check.json().check.state).toBe("partial");
      expect(check.json().check.reasonCode).toBe("optional_check_failed");
      expect(check.json().check.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "sandbox_policy_probe",
            severity: "warning"
          })
        ])
      );
      expect(mode.statusCode).toBe(200);
      expect(mode.json().runtimeMode.availability.state).toBe("partial");
      expect(mode.json().runtimeMode.availability.reasonCode).toBe("optional_check_failed");
      expect(doctor.statusCode).toBe(200);
      expect(doctor.json().summary.partial).toBe(1);
      expect(doctor.json().summary.available).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("bounds hung active checks and returns sanitized timeout state", async () => {
    const hungProbe = (): Promise<CodexProbe> => new Promise<CodexProbe>(() => {});
    const app = await createDaemonApp(undefined, {
      codexProbe: unavailableCodexProbe,
      probeCodexCatalog: hungProbe,
      checkTimeoutMs: 25,
      maxDiagnosticBytes: 128
    });
    try {
      const check = await app.inject({ method: "POST", url: "/runtime-modes/codex.exec_json/check" });
      expect(check.statusCode).toBe(200);
      expect(["unknown", "unavailable"]).toContain(check.json().check.state);
      expect(check.json().check.reasonCode).toBe("check_timeout");
    } finally {
      await app.close();
    }
  });

  it("refreshes codex provider/runtime status on startup when persistent storage is reused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-daemon-codex-status-"));
    const config: DaemonConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      sqlitePath: join(dir, "switchyard.sqlite"),
      artifactDir: join(dir, "artifacts"),
      genericHttp: {
        requestTimeoutMs: 5000,
        pollIntervalMs: 25,
        maxResponseBytes: 1024 * 1024
      }
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

  it("local gateway smoke: list, artifact lookup, error envelope", async () => {
    const config = tempDaemonConfig("switchyard-daemon-smoke-");
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const beforeRuns = await app.inject({ method: "GET", url: "/runs?limit=200" });
      expect(beforeRuns.statusCode).toBe(200);
      const startCount = (beforeRuns.json().runs as unknown[]).length;

      const created = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "smoke-list-run"
        }
      });
      expect(created.statusCode).toBe(201);
      const runId = created.json().run.id as string;

      const afterRuns = await app.inject({ method: "GET", url: "/runs?limit=200" });
      expect(afterRuns.statusCode).toBe(200);
      const endCount = (afterRuns.json().runs as unknown[]).length;
      expect(endCount).toBe(startCount + 1);

      const providers = await app.inject({ method: "GET", url: "/providers" });
      const runtimes = await app.inject({ method: "GET", url: "/runtimes" });
      const models = await app.inject({ method: "GET", url: "/models" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.length).toBeGreaterThan(0);
      expect(runtimes.json().runtimes.length).toBeGreaterThan(0);
      expect(models.json().models.length).toBeGreaterThan(0);

      const narrowedModels = await app.inject({ method: "GET", url: "/models?provider=test" });
      expect(narrowedModels.statusCode).toBe(200);
      expect(narrowedModels.json().models.length).toBeGreaterThan(0);

      const artifacts = await app.inject({ method: "GET", url: `/runs/${runId}/artifacts` });
      expect(artifacts.statusCode).toBe(200);
      const artifactId = artifacts.json().artifacts[0].id as string;

      const artifact = await app.inject({ method: "GET", url: `/artifacts/${artifactId}` });
      expect(artifact.statusCode).toBe(200);
      expect(artifact.json().artifact.id).toBe(artifactId);

      const content = await app.inject({ method: "GET", url: `/artifacts/${artifactId}/content` });
      expect(content.statusCode).toBe(200);
      expect(content.headers["content-type"]).toContain("application/x-ndjson");
      expect(content.body).toContain("fake runtime output");

      const missingRun = await app.inject({ method: "GET", url: "/runs/run_missing_id" });
      expect(missingRun.statusCode).toBe(404);
      expect(missingRun.json().error.code).toBe("run_not_found");

      const bananaStatus = await app.inject({ method: "GET", url: "/runs?status=banana" });
      expect(bananaStatus.statusCode).toBe(400);
      const bananaBody = bananaStatus.json();
      expect(bananaBody.error.code).toBe("invalid_query");
      expect(bananaBody.error.details?.[0]?.path).toBe("status");

      const missingArtifact = await app.inject({ method: "GET", url: "/artifacts/artifact_missing" });
      expect(missingArtifact.statusCode).toBe(404);
      expect(missingArtifact.json().error.code).toBe("artifact_not_found");

      const missingContent = await app.inject({ method: "GET", url: "/artifacts/artifact_missing/content" });
      expect(missingContent.statusCode).toBe(404);
      expect(missingContent.json().error.code).toBe("artifact_not_found");
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

  it("marks persisted running runs failed on daemon restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-daemon-reconcile-"));
    const config: DaemonConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      sqlitePath: join(dir, "switchyard.sqlite"),
      artifactDir: join(dir, "artifacts"),
      genericHttp: {
        requestTimeoutMs: 5000,
        pollIntervalMs: 25,
        maxResponseBytes: 1024 * 1024
      }
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
