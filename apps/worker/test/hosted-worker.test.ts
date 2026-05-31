import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveHostedSandboxConfig } from "@switchyard/core";
import { MemoryRunQueue } from "@switchyard/queue";
import { resolveObjectStoreConfig } from "@switchyard/storage";
import { createFakeAcpProcessFactory, createFakeClaudeCodeClient, InMemoryEventStore, InMemoryRunStore } from "@switchyard/testkit";
import { loadWorkerConfig } from "../src/config.js";
import { buildHostedWorkerAdapters, createHostedSafeLogger } from "../src/hosted-runtime-adapters.js";
import { createHostedWorker } from "../src/worker.js";

const defaultSandbox = () => resolveHostedSandboxConfig({ deploymentMode: "test", env: {} });

class GuardedInMemoryRunStore extends InMemoryRunStore {
  async updatePreparedMetadataIfMatch(input: any) {
    const current = await this.get(input.expected.id);
    if (!current) {
      return { ok: false, reason: "not_found" };
    }

    const sameIdentity =
      current.status === input.expected.status &&
      current.placement === input.expected.placement &&
      current.runtime === input.expected.runtime &&
      current.runtimeMode === input.expected.runtimeMode &&
      current.provider === input.expected.provider &&
      current.adapterType === input.expected.adapterType;
    if (!sameIdentity) {
      return { ok: false, reason: "identity_mismatch" };
    }

    const next = { ...current, metadata: input.metadata ?? {} };
    await this.update(next);
    return { ok: true, run: next };
  }
}

describe("hosted worker app", () => {
  it("processes queued hosted fake job", async () => {
    const queue = new MemoryRunQueue();
    const runs = new GuardedInMemoryRunStore();
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

    const worker = createHostedWorker(baseConfig(), { queue, runs, events });
    const worked = await worker.tick();

    expect(worked).toBe(true);
    expect((await runs.get("run_worker_1"))?.status).toBe("completed");
    await worker.stop();
  });

  it("builds allowlisted real adapters when gate is enabled", () => {
    const config = {
      ...baseConfig(),
      deploymentMode: "staging" as const,
      hostedRealRuntimeExecution: "enabled" as const,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json", "claude_code.sdk", "opencode.acp"]
    };
    const claude = createFakeClaudeCodeClient();
    const adapters = buildHostedWorkerAdapters(config, {
      claudeClient: claude.client,
      opencodeProcessFactory: createFakeAcpProcessFactory({ scenario: "happy" }),
      codexProcessFactory: createCodexHappyProcessFactory()
    });

    expect(adapters.has("fake")).toBe(true);
    expect(adapters.has("codex")).toBe(true);
    expect(adapters.has("claude_code")).toBe(true);
    expect(adapters.has("opencode")).toBe(true);
    expect(adapters.has("fetch")).toBe(false);
    expect(adapters.has("web_search")).toBe(false);
    expect(adapters.has("github")).toBe(false);
    expect(adapters.has("repo")).toBe(false);
    expect(adapters.has("shell")).toBe(false);
  });

  it("reports hosted runtime gate disabled in readiness", async () => {
    const worker = createHostedWorker({
      ...baseConfig(),
      deploymentMode: "staging",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      hostedRealRuntimeExecution: "disabled"
    });

    const ready = await worker.ready();
    expect(ready.ok).toBe(false);
    expect(ready.checks?.hostedRuntimeGate).toMatchObject({ ok: false, code: "hosted_real_runtime_disabled" });
    await worker.stop();
  });

  it("completes hosted codex run using fake process factory", async () => {
    const queue = new MemoryRunQueue();
    const runs = new GuardedInMemoryRunStore();
    const events = new InMemoryEventStore();
    await runs.create({
      id: "run_worker_codex",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "codex.exec_json",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await queue.enqueue({ runId: "run_worker_codex", placement: "hosted", runtimeMode: "codex.exec_json" });

    const worker = createHostedWorker({
      ...baseConfig(),
      deploymentMode: "staging",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      hostedRealRuntimeExecution: "enabled"
    }, {
      queue,
      runs,
      events,
      adapters: {
        codexProcessFactory: createCodexHappyProcessFactory()
      }
    });

    const worked = await worker.tick();
    expect(worked).toBe(true);

    const run = await runs.get("run_worker_codex");
    expect(run?.status).toBe("completed");
    expect(run?.metadata).toMatchObject({ sandbox: "read-only" });
    expect(events.items.some((event) => event.type === "run.completed")).toBe(true);
    await worker.stop();
  });

  it("fails hosted opencode permission request visibly", async () => {
    const queue = new MemoryRunQueue();
    const runs = new GuardedInMemoryRunStore();
    const events = new InMemoryEventStore();
    await runs.create({
      id: "run_worker_opencode_perm",
      runtime: "opencode",
      provider: "opencode",
      model: "opencode-default",
      adapterType: "acpx",
      cwd: "/repo",
      task: "do",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "opencode.acp",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await queue.enqueue({ runId: "run_worker_opencode_perm", placement: "hosted", runtimeMode: "opencode.acp" });

    const worker = createHostedWorker({
      ...baseConfig(),
      deploymentMode: "staging",
      hostedRuntimeAllowlist: ["fake.deterministic", "opencode.acp"],
      hostedRealRuntimeExecution: "enabled"
    }, {
      queue,
      runs,
      events,
      adapters: {
        opencodeProcessFactory: createFakeAcpProcessFactory({ scenario: "permission_request" })
      }
    });

    await worker.tick();
    expect((await runs.get("run_worker_opencode_perm"))?.status).toBe("failed");
    expect(events.items.some((event) => event.type === "run.failed")).toBe(true);
    await worker.stop();
  });

  it("redacts unsafe logger fields", () => {
    const seen: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const logger = createHostedSafeLogger({
      info: (event, details) => seen.push({ event, details }),
      warn: (event, details) => seen.push({ event, details }),
      error: (event, details) => seen.push({ event, details })
    });
    logger?.info("adapter.log", {
      runId: "run_1",
      stdout: "secret",
      stderr: "secret",
      task: "top secret",
      cwd: "/home/user",
      command: "danger",
      token: "abc",
      providerOutput: "raw",
      reasonCode: "ok"
    });

    expect(seen[0]?.details).toEqual({
      runId: "run_1",
      reasonCode: "ok",
      stdout: "[redacted]",
      stderr: "[redacted]",
      task: "[redacted]",
      cwd: "[redacted]",
      command: "[redacted]",
      token: "[redacted]",
      providerOutput: "[redacted]"
    });
    expect(JSON.stringify(seen[0]?.details)).not.toContain("secret");
    expect(JSON.stringify(seen[0]?.details)).not.toContain("top secret");
    expect(JSON.stringify(seen[0]?.details)).not.toContain("/home/user");
    expect(JSON.stringify(seen[0]?.details)).not.toContain("danger");
    expect(JSON.stringify(seen[0]?.details)).not.toContain("abc");
    expect(JSON.stringify(seen[0]?.details)).not.toContain("raw");
  });

  it("redacts short provider output and signed URL/object key variants", () => {
    const seen: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const logger = createHostedSafeLogger({
      info: (event, details) => seen.push({ event, details }),
      warn: (event, details) => seen.push({ event, details }),
      error: (event, details) => seen.push({ event, details })
    });

    logger?.warn("adapter.log", {
      runId: "run_short_1",
      reasonCode: "warn",
      text: "short stderr chunk",
      output: "provider output",
      signed_url: "https://bucket.example.com/path?sig=abc",
      object_key: "runs/run_short_1/transcript.ndjson",
      provider_output: {
        stderr: "tiny",
        stdout: "tiny2"
      }
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.details).toEqual({
      runId: "run_short_1",
      reasonCode: "warn",
      text: "[redacted]",
      output: "[redacted]",
      signed_url: "[redacted]",
      object_key: "[redacted]",
      provider_output: "[redacted]"
    });
    expect(JSON.stringify(seen[0]?.details)).not.toContain("short stderr chunk");
    expect(JSON.stringify(seen[0]?.details)).not.toContain("provider output");
    expect(JSON.stringify(seen[0]?.details)).not.toContain("bucket.example.com");
    expect(JSON.stringify(seen[0]?.details)).not.toContain("runs/run_short_1");
    expect(JSON.stringify(seen[0]?.details)).not.toContain("tiny");
    expect(JSON.stringify(seen[0]?.details)).not.toContain("tiny2");
  });

  it("keeps forbidden imports blocked while allowing approved hosted adapters", () => {
    const workerSource = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    const adapterSource = readFileSync(new URL("../src/hosted-runtime-adapters.ts", import.meta.url), "utf8");

    expect(adapterSource).toContain("CodexExecJsonAdapter");
    expect(adapterSource).toContain("ClaudeCodeAdapter");
    expect(adapterSource).toContain("OpenCodeAcpAdapter");
    expect(adapterSource).toContain("createClaudeCodeCliClient");

    expect(workerSource).not.toContain("GenericHttpAsyncRestAdapter");
    expect(workerSource).not.toContain("AgentFieldAsyncRestAdapter");
    expect(workerSource).not.toContain("node-pty");
    expect(workerSource).not.toContain("Cursor");
    expect(workerSource).not.toContain("OpenClaw");
    expect(workerSource).not.toContain("Paperclip");
    expect(workerSource).not.toContain("browser");
    expect(workerSource).not.toContain("search");
    expect(workerSource).not.toContain("fetch");
    expect(workerSource).not.toContain("github");
    expect(workerSource).not.toContain("repo");
    expect(workerSource).not.toContain("shell");
  });

  it("parses real-runtime worker config and rejects production real allowlist", () => {
    const parsed = loadWorkerConfig({
      SWITCHYARD_POSTGRES_URL: "postgres://user:pass@localhost:5432/switchyard",
      SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
      SWITCHYARD_QUEUE_NAME: "switchyard-worker",
      SWITCHYARD_OBJECT_STORE_BACKEND: "local",
      SWITCHYARD_OBJECT_STORE_DIR: "/tmp/switchyard-worker-objects",
      SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
      SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
      SWITCHYARD_DEPLOYMENT_MODE: "staging"
    });

    expect(parsed.hostedRealRuntimeExecution).toBe("enabled");
    expect(parsed.claudeCode.command).toBe("claude");
    expect(parsed.opencode.command).toBe("opencode");

    expect(() =>
      loadWorkerConfig({
        SWITCHYARD_POSTGRES_URL: "postgres://localhost/db",
        SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
        SWITCHYARD_OBJECT_STORE_BACKEND: "local",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/store",
        SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "claude_code.sdk",
        SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
        SWITCHYARD_DEPLOYMENT_MODE: "production"
      })
    ).toThrow(/config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION|hosted_real_runtime_production_forbidden/);
  });

  it("rejects invalid numeric worker config", () => {
    expect(() =>
      loadWorkerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "local",
        SWITCHYARD_ACP_REQUEST_TIMEOUT_MS: "0"
      })
    ).toThrow("config_invalid:SWITCHYARD_ACP_REQUEST_TIMEOUT_MS");
  });

  it("skips local object-store probe when probe mode is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchyard-worker-probe-disabled-local-"));
    const fileRoot = join(dir, "object-root-file");
    await writeFile(fileRoot, "x");
    const worker = createHostedWorker({
      ...baseConfig(),
      objectStore: resolveObjectStoreConfig({
        deploymentMode: "test",
        env: {
          SWITCHYARD_OBJECT_STORE_BACKEND: "local",
          SWITCHYARD_OBJECT_STORE_DIR: fileRoot,
          SWITCHYARD_OBJECT_STORE_PROBE: "disabled"
        }
      })
    });

    try {
      await expect(worker.ready()).resolves.toMatchObject({ ok: true });
    } finally {
      await worker.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function baseConfig() {
  return {
    deploymentMode: "test" as const,
    hostedRuntimeAllowlist: ["fake.deterministic"],
    hostedRealRuntimeExecution: "disabled" as const,
    objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
    sandbox: defaultSandbox(),
    idleIntervalMs: 1,
    claudeCode: {
      command: "claude",
      requestTimeoutMs: 5000,
      liveProbe: false,
      maxBudgetUsd: 0.05
    },
    opencode: {
      command: "opencode"
    },
    acp: {
      requestTimeoutMs: 5000,
      cancelTimeoutMs: 5000,
      maxMessageBytes: 1_048_576
    },
    redactedSummary: {}
  };
}

function createCodexHappyProcessFactory() {
  return () => {
    const proc = new FakeCodexProcess();
    queueMicrotask(() => {
      proc.stdout.write('{"type":"thread.started","thread_id":"thread_1"}\n');
      proc.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
      proc.stdout.write('{"type":"turn.completed"}\n');
      proc.stdout.end();
      proc.emit("exit", 0, null);
    });
    return proc as never;
  };
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;

  override once(event: "exit" | "error", listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  kill(_signal?: NodeJS.Signals): boolean {
    this.emit("exit", 0, null);
    return true;
  }
}
