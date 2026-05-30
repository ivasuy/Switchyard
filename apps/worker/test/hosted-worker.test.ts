import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveHostedSandboxConfig } from "@switchyard/core";
import { MemoryRunQueue } from "@switchyard/queue";
import { resolveObjectStoreConfig } from "@switchyard/storage";
import { InMemoryEventStore, InMemoryRunStore } from "@switchyard/testkit";
import { createHostedWorker } from "../src/worker.js";
import { loadWorkerConfig } from "../src/config.js";

const defaultSandbox = () => resolveHostedSandboxConfig({ deploymentMode: "test", env: {} });

describe("hosted worker app", () => {
  it("processes queued hosted fake job", async () => {
    const queue = new MemoryRunQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    await runs.create({
      id: "run_worker_1",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await queue.enqueue({ runId: "run_worker_1", placement: "hosted", runtimeMode: "fake.deterministic" });

    const worker = createHostedWorker({
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      idleIntervalMs: 1,
      redactedSummary: {}
    }, { queue, runs, events });
    const worked = await worker.tick();

    expect(worked).toBe(true);
    expect((await runs.get("run_worker_1"))?.status).toBe("completed");
    const ready = await worker.ready();
    expect(ready.ok).toBe(true);
    expect(ready.checks?.sandbox?.ok).toBe(true);
  });

  it("does not import forbidden adapters", () => {
    const source = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(source).not.toContain("CodexExecJsonAdapter");
    expect(source).not.toContain("ClaudeCodeAdapter");
    expect(source).not.toContain("OpenCodeAcpAdapter");
    expect(source).not.toContain("GenericHttpAsyncRestAdapter");
    expect(source).not.toContain("AgentFieldAsyncRestAdapter");
    expect(source).not.toContain("@switchyard/adapters");
    expect(source).not.toContain("pty");
    expect(source).not.toContain("browser");
    expect(source).not.toContain("shell");
    expect(source).not.toContain("github");
    expect(source).not.toContain("fetch");
    expect(source).not.toContain("repo");
  });

  it("denies non-fake hosted runtime before execution and marks run failed", async () => {
    const queue = new MemoryRunQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    await runs.create({
      id: "run_worker_denied",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/repo",
      task: "blocked",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await queue.enqueue({ runId: "run_worker_denied", placement: "hosted", runtimeMode: "codex.exec_json" });

    const worker = createHostedWorker({
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      idleIntervalMs: 1,
      redactedSummary: {}
    }, { queue, runs, events });

    const worked = await worker.tick();
    expect(worked).toBe(true);
    expect((await runs.get("run_worker_denied"))?.status).toBe("failed");
    expect(events.items.some((event) => event.type === "run.started")).toBe(false);
    expect(events.items.at(-1)?.payload).toMatchObject({ reasonCode: "hosted_runtime_not_allowed" });
  });

  it("parses opt-in hosted infrastructure config", () => {
    const config = loadWorkerConfig({
      SWITCHYARD_POSTGRES_URL: "postgres://user:pass@localhost:5432/switchyard",
      SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
      SWITCHYARD_QUEUE_NAME: "switchyard-worker",
      SWITCHYARD_OBJECT_STORE_BACKEND: "local",
      SWITCHYARD_OBJECT_STORE_DIR: "/tmp/switchyard-worker-objects",
      SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
      SWITCHYARD_DEPLOYMENT_MODE: "staging"
    });

    expect(config.postgresUrl).toContain("postgres://");
    expect(config.redisUrl).toBe("redis://localhost:6379/0");
    expect(config.queueName).toBe("switchyard-worker");
    expect(config.objectStore.backend).toBe("local");
    expect(config.deploymentMode).toBe("staging");
  });

  it("fails closed in staging when redis is missing", () => {
    expect(() =>
      loadWorkerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_POSTGRES_URL: "postgres://localhost/db",
        SWITCHYARD_OBJECT_STORE_BACKEND: "local",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/store",
        SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic"
      })
    ).toThrow("config_required:SWITCHYARD_REDIS_URL");
  });

  it("fails closed in staging when hosted allowlist is missing", () => {
    expect(() =>
      loadWorkerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_POSTGRES_URL: "postgres://localhost/db",
        SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
        SWITCHYARD_OBJECT_STORE_BACKEND: "local",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/store"
      })
    ).toThrow("config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST");
  });

  it("keeps local default hosted allowlist when env is absent", () => {
    const config = loadWorkerConfig({
      SWITCHYARD_DEPLOYMENT_MODE: "local"
    });
    expect(config.hostedRuntimeAllowlist).toEqual(["fake.deterministic"]);
    expect(config.objectStore.backend).toBe("memory");
  });

  it("reports sandbox readiness failure states", async () => {
    const disabled = createHostedWorker({
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: resolveHostedSandboxConfig({ deploymentMode: "test", env: { SWITCHYARD_SANDBOX_ENABLED: "false" } }),
      idleIntervalMs: 1,
      redactedSummary: {}
    });
    await expect(disabled.ready()).resolves.toMatchObject({
      ok: false,
      reason: "sandbox_disabled",
      checks: { sandbox: { ok: false, code: "sandbox_disabled" } }
    });
    await disabled.stop();

    const invalidPolicy = createHostedWorker({
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: resolveHostedSandboxConfig({ deploymentMode: "test", env: { SWITCHYARD_SANDBOX_FAKE_COMMAND_ALLOWLIST: "bash" } }),
      idleIntervalMs: 1,
      redactedSummary: {}
    });
    await expect(invalidPolicy.ready()).resolves.toMatchObject({
      ok: false,
      reason: "sandbox_policy_invalid",
      checks: { sandbox: { ok: false, code: "sandbox_policy_invalid" } }
    });
    await invalidPolicy.stop();
  });

  it("denies hosted non-fake durable rows across runtime and adapter shapes", async () => {
    const queue = new MemoryRunQueue();
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();

    const deniedRows = [
      { id: "run_denied_codex", runtime: "codex", provider: "openai", model: "gpt-5", adapterType: "process", runtimeMode: "codex.exec_json" },
      { id: "run_denied_claude", runtime: "claude_code", provider: "anthropic", model: "claude", adapterType: "native", runtimeMode: "claude_code.sdk" },
      { id: "run_denied_opencode", runtime: "opencode", provider: "opencode", model: "opencode", adapterType: "acpx", runtimeMode: "opencode.acp" },
      { id: "run_denied_generic_http", runtime: "generic_http", provider: "test", model: "test", adapterType: "http", runtimeMode: "generic_http.async_rest" },
      { id: "run_denied_agentfield", runtime: "agentfield", provider: "test", model: "test", adapterType: "http", runtimeMode: "agentfield.async_rest" },
      { id: "run_denied_fake_mode", runtime: "fake", provider: "test", model: "test-model", adapterType: "process", runtimeMode: "fake.live" },
      { id: "run_denied_pty", runtime: "fake", provider: "test", model: "test-model", adapterType: "pty", runtimeMode: "fake.deterministic" },
      { id: "run_denied_browser", runtime: "fake", provider: "test", model: "test-model", adapterType: "browser", runtimeMode: "fake.deterministic" }
    ] as const;

    for (const row of deniedRows) {
      await runs.create({
        id: row.id,
        runtime: row.runtime,
        provider: row.provider,
        model: row.model,
        adapterType: row.adapterType,
        cwd: "/repo",
        task: "deny",
        status: "queued",
        placement: "hosted",
        approvalPolicy: "default",
        timeoutSeconds: 60,
        metadata: {},
        runtimeMode: row.runtimeMode,
        createdAt: "2026-05-30T00:00:00.000Z"
      });
      await queue.enqueue({ runId: row.id, placement: "hosted", runtimeMode: row.runtimeMode });
    }

    const worker = createHostedWorker({
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      idleIntervalMs: 1,
      redactedSummary: {}
    }, { queue, runs, events });

    for (let idx = 0; idx < deniedRows.length; idx += 1) {
      await expect(worker.tick()).resolves.toBe(true);
    }

    for (const row of deniedRows) {
      expect((await runs.get(row.id))?.status).toBe("failed");
    }
    expect(events.items.some((event) => event.type === "run.started")).toBe(false);
    await worker.stop();
  });

  it("fails closed for invalid sandbox config values", () => {
    expect(() =>
      loadWorkerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "local",
        SWITCHYARD_SANDBOX_COMBINED_OUTPUT_BYTES: "0"
      })
    ).toThrow("sandbox_config_invalid");
  });

  it("skips local object-store probe when probe mode is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchyard-worker-probe-disabled-local-"));
    const fileRoot = join(dir, "object-root-file");
    await writeFile(fileRoot, "x");
    const worker = createHostedWorker({
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      objectStore: resolveObjectStoreConfig({
        deploymentMode: "test",
        env: {
          SWITCHYARD_OBJECT_STORE_BACKEND: "local",
          SWITCHYARD_OBJECT_STORE_DIR: fileRoot,
          SWITCHYARD_OBJECT_STORE_PROBE: "disabled"
        }
      }),
      sandbox: defaultSandbox(),
      idleIntervalMs: 1,
      redactedSummary: {}
    });

    try {
      await expect(worker.ready()).resolves.toMatchObject({ ok: true });
    } finally {
      await worker.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips s3-compatible object-store probe when probe mode is disabled", async () => {
    const worker = createHostedWorker({
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      objectStore: resolveObjectStoreConfig({
        deploymentMode: "test",
        env: {
          SWITCHYARD_OBJECT_STORE_BACKEND: "s3-compatible",
          SWITCHYARD_OBJECT_STORE_ENDPOINT: "http://127.0.0.1:1",
          SWITCHYARD_OBJECT_STORE_REGION: "us-east-1",
          SWITCHYARD_OBJECT_STORE_BUCKET: "switchyard-artifacts",
          SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID: "key",
          SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY: "secret",
          SWITCHYARD_OBJECT_STORE_PROBE: "disabled"
        }
      }),
      sandbox: defaultSandbox(),
      idleIntervalMs: 1,
      redactedSummary: {}
    });

    try {
      await expect(worker.ready()).resolves.toMatchObject({ ok: true });
    } finally {
      await worker.stop();
    }
  });
});
