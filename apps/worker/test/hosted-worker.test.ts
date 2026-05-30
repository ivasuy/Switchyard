import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryRunQueue } from "@switchyard/queue";
import { InMemoryEventStore, InMemoryRunStore } from "@switchyard/testkit";
import { createHostedWorker } from "../src/worker.js";
import { loadWorkerConfig } from "../src/config.js";

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

    const worker = createHostedWorker({ deploymentMode: "test", hostedRuntimeAllowlist: ["fake.deterministic"], idleIntervalMs: 1, redactedSummary: {} }, { queue, runs, events });
    const worked = await worker.tick();

    expect(worked).toBe(true);
    expect((await runs.get("run_worker_1"))?.status).toBe("completed");
    expect((await worker.ready()).ok).toBe(true);
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

  it("parses opt-in hosted infrastructure config", () => {
    const config = loadWorkerConfig({
      SWITCHYARD_POSTGRES_URL: "postgres://user:pass@localhost:5432/switchyard",
      SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
      SWITCHYARD_QUEUE_NAME: "switchyard-worker",
      SWITCHYARD_OBJECT_STORE_DIR: "/tmp/switchyard-worker-objects",
      SWITCHYARD_DEPLOYMENT_MODE: "staging"
    });

    expect(config.postgresUrl).toContain("postgres://");
    expect(config.redisUrl).toBe("redis://localhost:6379/0");
    expect(config.queueName).toBe("switchyard-worker");
    expect(config.objectStoreDir).toBe("/tmp/switchyard-worker-objects");
    expect(config.deploymentMode).toBe("staging");
  });

  it("fails closed in staging when redis is missing", () => {
    expect(() =>
      loadWorkerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_POSTGRES_URL: "postgres://localhost/db",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/store",
        SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic"
      })
    ).toThrow("config_required:SWITCHYARD_REDIS_URL");
  });
});
