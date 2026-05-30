import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryRunQueue } from "@switchyard/queue";
import { InMemoryEventStore, InMemoryRunStore } from "@switchyard/testkit";
import { createHostedWorker } from "../src/worker.js";

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

    const worker = createHostedWorker({ hostedRuntimeAllowlist: ["fake.deterministic"] }, { queue, runs, events });
    const worked = await worker.tick();

    expect(worked).toBe(true);
    expect((await runs.get("run_worker_1"))?.status).toBe("completed");
  });

  it("does not import forbidden adapters", () => {
    const source = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
    expect(source).not.toContain("CodexExecJsonAdapter");
    expect(source).not.toContain("ClaudeCodeAdapter");
    expect(source).not.toContain("OpenCodeAcpAdapter");
    expect(source).not.toContain("GenericHttpAsyncRestAdapter");
    expect(source).not.toContain("AgentFieldAsyncRestAdapter");
  });
});
