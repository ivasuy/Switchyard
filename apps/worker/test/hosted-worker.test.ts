import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@switchyard/contracts";
import { HostedRuntimeBridgeService, resolveHostedSandboxConfig, type ControlPlaneStore, type DebateExecutionStore } from "@switchyard/core";
import { MemoryRunQueue } from "@switchyard/queue";
import {
  PostgresDebateExecutionStore,
  PostgresHostedRuntimeBridgeCommandStore,
  PostgresHostedRuntimeBridgePayloadStore,
  resolveObjectStoreConfig,
  type PostgresDatabaseHandle
} from "@switchyard/storage";
import {
  createFakeAcpProcessFactory,
  createFakeClaudeCodeClient,
  InMemoryApprovalStore,
  InMemoryArtifactStore,
  InMemoryDebateStore,
  InMemoryEventStore,
  InMemoryEvidenceStore,
  InMemoryMessageStore,
  InMemoryRunStore,
  startFakeAgentFieldServer,
  startFakeHttpRuntimeServer,
  InMemorySessionStore
} from "@switchyard/testkit";
import type { SandboxProcessFactory } from "@switchyard/adapters";
import { loadWorkerConfig } from "../src/config.js";
import { buildHostedWorkerAdapters, checkConfiguredHostedAdapters, createHostedSafeLogger } from "../src/hosted-runtime-adapters.js";
import { createWorkerHostedSandboxService } from "../src/sandbox.js";
import { createHostedWorker, getWorkerRuntimeBridgeReadiness } from "../src/worker.js";

const defaultSandbox = () => resolveHostedSandboxConfig({ deploymentMode: "test", env: {} });

class GuardedInMemoryRunStore extends InMemoryRunStore {
  async findByDebateChildRunKey(key: string) {
    return [...this.items.values()].find((run) => run.metadata?.["debateChildRunKey"] === key);
  }

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

  it("claims one debate job and enqueues a child run without blocking for completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    const queue = new MemoryRunQueue({ now: () => new Date().toISOString() });
    const runs = new GuardedInMemoryRunStore();
    const events = new InMemoryEventStore();
    const debates = new InMemoryDebateStore();
    const messages = new InMemoryMessageStore();
    const evidence = new InMemoryEvidenceStore();
    const artifacts = new InMemoryArtifactStore();
    const debateExecution: DebateExecutionStore = new PostgresDebateExecutionStore() as DebateExecutionStore;
    await debates.create(fakeDebate());
    const job = await debateExecution.enqueue({
      id: "debate_job_worker_1",
      debateId: "debate_worker_1",
      stage: "participant_turn",
      debateRound: 1,
      debatePhase: "arguing",
      participantIndex: 0,
      maxAttempts: 3,
      nextAttemptAt: "2026-06-02T00:00:00.000Z"
    });

    const worker = createHostedWorker(baseConfig(), {
      queue,
      runs,
      events,
      debates,
      messages,
      evidence,
      artifacts,
      debateExecution
    });

    try {
      await expect(worker.tick()).resolves.toBe(true);
      expect((await debateExecution.get(job.id))?.state).toBe("queued");
      expect((await debateExecution.get(job.id))?.reasonCode).toBe("debate_child_run_pending");
      expect((await queue.stats()).queued).toBe(1);
      const childRuns = [...runs.items.values()];
      expect(childRuns).toHaveLength(1);
      expect(childRuns[0]?.metadata).toMatchObject({
        debateId: "debate_worker_1",
        debateRunKind: "participant",
        debateChildRunKey: expect.any(String)
      });
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it("prioritizes pending child runs before due debate retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    const queue = new MemoryRunQueue({ now: () => new Date().toISOString() });
    const runs = new GuardedInMemoryRunStore();
    const events = new InMemoryEventStore();
    const debates = new InMemoryDebateStore();
    const debateExecution: DebateExecutionStore = new PostgresDebateExecutionStore() as DebateExecutionStore;
    await debates.create(fakeDebate());
    const job = await debateExecution.enqueue({
      id: "debate_job_starvation_1",
      debateId: "debate_worker_1",
      stage: "participant_turn",
      debateRound: 1,
      debatePhase: "arguing",
      participantIndex: 0,
      nextAttemptAt: "2026-06-02T00:00:00.000Z"
    });

    const worker = createHostedWorker(baseConfig(), {
      queue,
      runs,
      events,
      debates,
      messages: new InMemoryMessageStore(),
      evidence: new InMemoryEvidenceStore(),
      artifacts: new InMemoryArtifactStore(),
      debateExecution
    });

    try {
      await worker.tick();
      vi.setSystemTime(new Date("2026-06-02T00:00:02.000Z"));
      await worker.tick();
      expect([...runs.items.values()][0]?.status).toBe("completed");
      expect((await debateExecution.get(job.id))?.state).toBe("queued");
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it("advances a completed child run from persisted debate output without duplicate child runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    const queue = new MemoryRunQueue({ now: () => new Date().toISOString() });
    const runs = new GuardedInMemoryRunStore();
    const events = new InMemoryEventStore();
    const debateExecution: DebateExecutionStore = new PostgresDebateExecutionStore() as DebateExecutionStore;
    const debates = new InMemoryDebateStore();
    const messages = new InMemoryMessageStore();
    await debates.create(fakeDebate());
    const job = await debateExecution.enqueue({
      id: "debate_job_output_1",
      debateId: "debate_worker_1",
      stage: "participant_turn",
      debateRound: 1,
      debatePhase: "arguing",
      participantIndex: 0,
      nextAttemptAt: "2026-06-02T00:00:00.000Z"
    });
    const worker = createHostedWorker(baseConfig(), {
      queue,
      runs,
      events,
      debates,
      messages,
      evidence: new InMemoryEvidenceStore(),
      artifacts: new InMemoryArtifactStore(),
      debateExecution
    });

    try {
      await worker.tick();
      const childRun = [...runs.items.values()][0]!;
      const queuedChild = await queue.claim();
      if (queuedChild) {
        await queue.ack(queuedChild.id);
      }
      await runs.update({ ...childRun, status: "completed", endedAt: "2026-06-02T00:00:00.500Z" });
      await events.append({
        id: "event_debate_output_1",
        runId: childRun.id,
        debateId: "debate_worker_1",
        type: "runtime.output",
        sequence: 1,
        payload: {
          text: "participant output",
          debateId: "debate_worker_1",
          debateChildRunKey: childRun.metadata["debateChildRunKey"]
        },
        createdAt: "2026-06-02T00:00:00.500Z"
      });

      vi.setSystemTime(new Date("2026-06-02T00:00:02.000Z"));
      await worker.tick();
      expect((await debateExecution.get(job.id))?.state).toBe("completed");
      expect([...runs.items.values()]).toHaveLength(1);
      expect(messages.items.size).toBe(1);
      expect((await debateExecution.stats()).queued).toBe(1);
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it("terminalizes debates and finalizes quota for exhausted and invalid stale debate claims", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
    const debateExecution: DebateExecutionStore = new PostgresDebateExecutionStore() as DebateExecutionStore;
    const debates = new InMemoryDebateStore();
    await debates.create(fakeDebate("debate_stale_exhausted_1"));
    await debates.create(fakeDebate("debate_stale_invalid_1"));
    await debateExecution.enqueue({
      id: "debate_job_stale_1",
      debateId: "debate_stale_exhausted_1",
      stage: "participant_turn",
      maxAttempts: 1,
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      nextAttemptAt: "2026-06-02T00:00:00.000Z"
    });
    await debateExecution.enqueue({
      id: "debate_job_stale_invalid_1",
      debateId: "debate_stale_invalid_1",
      stage: "participant_turn",
      maxAttempts: 3,
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      nextAttemptAt: "2026-06-02T00:00:00.000Z"
    });
    await debateExecution.claim({ leaseMs: 10 });
    await debateExecution.claim({ leaseMs: 10 });
    setDebateJobField(debateExecution, "debate_job_stale_1", "activeDebateReservationId", "quota_reservation_stale_exhausted");
    setDebateJobField(debateExecution, "debate_job_stale_invalid_1", "activeDebateReservationId", "quota_reservation_stale_invalid");
    deleteDebateJobField(debateExecution, "debate_job_stale_invalid_1", "leaseUntil");
    vi.setSystemTime(new Date("2026-06-02T00:00:00.050Z"));
    const finalized: string[] = [];
    const worker = createHostedWorker(baseConfig(), {
      queue: new MemoryRunQueue({ now: () => new Date().toISOString() }),
      runs: new GuardedInMemoryRunStore(),
      events: new InMemoryEventStore(),
      debates,
      messages: new InMemoryMessageStore(),
      evidence: new InMemoryEvidenceStore(),
      artifacts: new InMemoryArtifactStore(),
      debateExecution,
      finalizeActiveDebateQuota: async (input) => {
        finalized.push(`${input.debateId}:${input.outcome}:${input.reasonCode ?? ""}:${(input.job as Record<string, unknown>)["activeDebateReservationId"] ?? ""}`);
      }
    });

    try {
      await worker.tick();
      expect((await debateExecution.get("debate_job_stale_1"))?.state).toBe("exhausted");
      expect((await debateExecution.get("debate_job_stale_1"))?.reasonCode).toBe("debate_execution_attempts_exhausted");
      expect((await debateExecution.get("debate_job_stale_invalid_1"))?.state).toBe("failed");
      expect((await debateExecution.get("debate_job_stale_invalid_1"))?.reasonCode).toBe("debate_execution_invalid_claim");
      expect(await debates.get("debate_stale_exhausted_1")).toMatchObject({
        status: "failed",
        stopReason: "failed",
        error: { code: "debate_execution_attempts_exhausted" }
      });
      expect(await debates.get("debate_stale_invalid_1")).toMatchObject({
        status: "failed",
        stopReason: "failed",
        error: { code: "hosted_debate_worker_unavailable" }
      });
      expect(finalized).toEqual([
        "debate_stale_exhausted_1:failed:debate_execution_attempts_exhausted:quota_reservation_stale_exhausted",
        "debate_stale_invalid_1:failed:hosted_debate_worker_unavailable:quota_reservation_stale_invalid"
      ]);
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it("uses the explicit active debate reservation id when finalizing worker quota", async () => {
    const debateExecution: DebateExecutionStore = new PostgresDebateExecutionStore() as DebateExecutionStore;
    const debates = new InMemoryDebateStore();
    await debates.create({
      ...fakeDebate("debate_quota_exact_1"),
      status: "completed",
      stopReason: "completed"
    });
    await debateExecution.enqueue({
      id: "debate_job_quota_exact_1",
      debateId: "debate_quota_exact_1",
      stage: "judging",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      nextAttemptAt: "2026-06-02T00:00:00.000Z"
    });
    setDebateJobField(debateExecution, "debate_job_quota_exact_1", "activeDebateReservationId", "quota_reservation_debate_b");
    const transitioned: Array<{ reservationId: string; nextState: string; reasonCode?: string }> = [];
    const controlPlaneStore = {
      transitionQuotaReservation: async (input: { reservationId: string; nextState: string; reasonCode?: string }) => {
        transitioned.push({
          reservationId: input.reservationId,
          nextState: input.nextState,
          reasonCode: input.reasonCode
        });
        return {} as never;
      }
    } as ControlPlaneStore;
    const worker = createHostedWorker(baseConfig(), {
      queue: new MemoryRunQueue(),
      runs: new GuardedInMemoryRunStore(),
      events: new InMemoryEventStore(),
      debates,
      messages: new InMemoryMessageStore(),
      evidence: new InMemoryEvidenceStore(),
      artifacts: new InMemoryArtifactStore(),
      debateExecution,
      controlPlaneStore
    });

    try {
      await worker.tick();
      expect(transitioned).toEqual([
        {
          reservationId: "quota_reservation_debate_b",
          nextState: "consumed",
          reasonCode: "completed"
        }
      ]);
    } finally {
      await worker.stop();
    }
  });

  it("finalizes active debate quota once for terminal success and failure", async () => {
    const runTerminalJob = async (status: "completed" | "failed") => {
      const debateExecution: DebateExecutionStore = new PostgresDebateExecutionStore() as DebateExecutionStore;
      const debates = new InMemoryDebateStore();
      await debates.create({
        ...fakeDebate(`debate_terminal_${status}`),
        status,
        stopReason: status === "completed" ? "completed" : "failed",
        ...(status === "failed" ? { error: { code: "debate_failed", message: "failed" } } : {})
      });
      await debateExecution.enqueue({
        id: `debate_job_terminal_${status}`,
        debateId: `debate_terminal_${status}`,
        stage: "judging",
        nextAttemptAt: "2026-06-02T00:00:00.000Z"
      });
      const finalized: string[] = [];
      const worker = createHostedWorker(baseConfig(), {
        queue: new MemoryRunQueue(),
        runs: new GuardedInMemoryRunStore(),
        events: new InMemoryEventStore(),
        debates,
        messages: new InMemoryMessageStore(),
        evidence: new InMemoryEvidenceStore(),
        artifacts: new InMemoryArtifactStore(),
        debateExecution,
        finalizeActiveDebateQuota: async (input) => {
          finalized.push(`${input.debateId}:${input.outcome}:${input.reasonCode ?? ""}`);
        }
      });
      try {
        await worker.tick();
        await worker.tick();
        return finalized;
      } finally {
        await worker.stop();
      }
    };

    expect(await runTerminalJob("completed")).toEqual(["debate_terminal_completed:completed:completed"]);
    expect(await runTerminalJob("failed")).toEqual(["debate_terminal_failed:failed:debate_failed"]);
  });

  it("does not reopen a terminal debate when late provider output arrives", async () => {
    const runs = new GuardedInMemoryRunStore();
    const events = new InMemoryEventStore();
    const debates = new InMemoryDebateStore();
    const debateExecution: DebateExecutionStore = new PostgresDebateExecutionStore() as DebateExecutionStore;
    const debate = fakeDebate("debate_late_1");
    await debates.create({
      ...debate,
      status: "completed",
      stopReason: "completed",
      participants: [{ ...debate.participants[0]!, runId: "run_late_1", runIds: ["run_late_1"] }, debate.participants[1]!]
    });
    await runs.create({
      id: "run_late_1",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "late",
      status: "completed",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: { debateId: "debate_late_1", debateChildRunKey: "late_key" },
      runtimeMode: "fake.deterministic",
      createdAt: "2026-06-02T00:00:00.000Z"
    });
    await events.append({
      id: "event_late_output_1",
      runId: "run_late_1",
      debateId: "debate_late_1",
      type: "runtime.output",
      sequence: 1,
      payload: { text: "too late", debateId: "debate_late_1", debateChildRunKey: "late_key" },
      createdAt: "2026-06-02T00:00:01.000Z"
    });
    await debateExecution.enqueue({
      id: "debate_job_late_1",
      debateId: "debate_late_1",
      stage: "participant_turn",
      debateRound: 1,
      debatePhase: "arguing",
      participantIndex: 0,
      pendingRunId: "run_late_1",
      pendingChildRunKey: "late_key",
      nextAttemptAt: "2026-06-02T00:00:00.000Z"
    });
    const worker = createHostedWorker(baseConfig(), {
      queue: new MemoryRunQueue(),
      runs,
      events,
      debates,
      messages: new InMemoryMessageStore(),
      evidence: new InMemoryEvidenceStore(),
      artifacts: new InMemoryArtifactStore(),
      debateExecution
    });

    try {
      await worker.tick();
      expect((await debates.get("debate_late_1"))?.status).toBe("completed");
      expect((await debateExecution.get("debate_job_late_1"))?.state).toBe("completed");
    } finally {
      await worker.stop();
    }
  });

  it("builds production sandbox service with injected process factory", async () => {
    let spawnCalls = 0;
    const processFactory: SandboxProcessFactory = {
      spawn: () => {
        spawnCalls += 1;
        return new FakeSandboxProcess("sandbox-from-production-factory") as never;
      }
    };
    const config = {
      ...baseConfig(),
      sandbox: resolveHostedSandboxConfig({
        deploymentMode: "test",
        env: {
          SWITCHYARD_SANDBOX_REAL_EXECUTION: "enabled",
          SWITCHYARD_SANDBOX_COMMAND_POLICY_JSON: JSON.stringify([
            {
              commandId: "deploy.safe.echo",
              adapterType: "process",
              executablePath: "/usr/bin/printf",
              fixedArgs: ["policy-arg"],
              allowUserArgs: true,
              cwdPrefixes: ["/repo"],
              envAllowlist: ["SAFE_ENV"],
              allowStdin: false,
              allowPtyInput: false,
              isolation: { driver: "none", required: false },
              networkPolicy: "disabled"
            }
          ])
        }
      })
    };

    const sandbox = createWorkerHostedSandboxService(config, { processFactory });
    const result = await sandbox.execute({
      jobId: "job_sandbox_prod_1",
      runId: "run_sandbox_prod_1",
      runtimeMode: "fake.deterministic",
      adapterType: "process",
      commandId: "deploy.safe.echo",
      argv: ["hello"],
      cwd: "/repo/workspace",
      env: { SAFE_ENV: "1" },
      stdin: "",
      resourceLimits: baseSandboxLimits(),
      artifactPolicy: {
        captureTranscript: false,
        captureDeniedDecision: false
      },
      createdAt: "2026-05-31T00:00:00.000Z"
    });

    expect(spawnCalls).toBe(1);
    expect(result.status).toBe("completed");
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

  it("builds production adapters only for provider-activated modes", () => {
    const config = {
      ...baseConfig(),
      deploymentMode: "production" as const,
      hostedRealRuntimeExecution: "enabled" as const,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json", "claude_code.sdk", "opencode.acp"],
      providerRuntimeActivation: validProductionActivation(["codex.exec_json", "opencode.acp"])
    };
    const adapters = buildHostedWorkerAdapters(config, {
      codexProcessFactory: createCodexHappyProcessFactory(),
      opencodeProcessFactory: createFakeAcpProcessFactory({ scenario: "happy" })
    });
    expect(adapters.has("fake")).toBe(true);
    expect(adapters.has("codex")).toBe(true);
    expect(adapters.has("opencode")).toBe(true);
    expect(adapters.has("claude_code")).toBe(false);
  });

  it("builds wrapper adapters only when real mode and wrapper config gates pass", () => {
    expect(buildHostedWorkerAdapters(baseConfig()).has("generic_http")).toBe(false);
    expect(buildHostedWorkerAdapters(baseConfig()).has("agentfield")).toBe(false);

    const disabledReal = buildHostedWorkerAdapters({
      ...baseConfig(),
      hostedRuntimeAllowlist: ["fake.deterministic", "generic_http.async_rest"],
      genericHttp: {
        ...baseConfig().genericHttp,
        baseUrl: "http://127.0.0.1:5055"
      }
    });
    expect(disabledReal.has("generic_http")).toBe(false);

    const gated = buildHostedWorkerAdapters({
      ...baseConfig(),
      hostedRuntimeAllowlist: ["fake.deterministic", "generic_http.async_rest", "agentfield.async_rest"],
      hostedRealRuntimeExecution: "enabled",
      genericHttp: {
        ...baseConfig().genericHttp,
        baseUrl: "http://127.0.0.1:5055",
        authToken: "generic-token"
      },
      agentfield: {
        ...baseConfig().agentfield,
        baseUrl: "http://127.0.0.1:5057",
        apiKey: "af-key",
        target: "research-agent.deep_analysis"
      }
    });
    expect(gated.has("generic_http")).toBe(true);
    expect(gated.has("agentfield")).toBe(true);

    const missingAgentFieldConfig = buildHostedWorkerAdapters({
      ...baseConfig(),
      hostedRuntimeAllowlist: ["fake.deterministic", "agentfield.async_rest"],
      hostedRealRuntimeExecution: "enabled",
      agentfield: {
        ...baseConfig().agentfield,
        baseUrl: "http://127.0.0.1:5057"
      }
    });
    expect(missingAgentFieldConfig.has("agentfield")).toBe(false);
  });

  it("checks wrapper adapter readiness without creating upstream executions", async () => {
    const generic = await startFakeHttpRuntimeServer({ scenario: "bridge_happy", expectedAuthToken: "generic-token" });
    const agentfield = await startFakeAgentFieldServer({ scenario: "bridge_happy", expectedApiKey: "af-key" });

    try {
      const result = await checkConfiguredHostedAdapters({
        ...baseConfig(),
        hostedRuntimeAllowlist: ["fake.deterministic", "generic_http.async_rest", "agentfield.async_rest"],
        hostedRealRuntimeExecution: "enabled",
        genericHttp: {
          ...baseConfig().genericHttp,
          baseUrl: generic.baseUrl,
          authToken: "generic-token"
        },
        agentfield: {
          ...baseConfig().agentfield,
          baseUrl: agentfield.baseUrl,
          apiKey: "af-key",
          target: "research-agent.deep_analysis"
        }
      });

      expect(result.modes["generic_http.async_rest"]).toEqual({ ok: true });
      expect(result.modes["agentfield.async_rest"]).toEqual({ ok: true });
      expect(generic.stats()).toMatchObject({ healthRequests: 1, startRequests: 0 });
      expect(agentfield.stats.healthCalls).toBe(1);
      expect(agentfield.stats.discoveryCalls).toBe(1);
      expect(agentfield.stats.executeAsyncCalls).toBe(0);
    } finally {
      await generic.close();
      await agentfield.close();
    }
  });

  it("does not stamp or admit wrapper bridge when wrapper capability is missing", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "bridge_capability_missing" });
    const queue = new MemoryRunQueue();
    const runs = new GuardedInMemoryRunStore();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    const approvals = new InMemoryApprovalStore();
    const commands = new PostgresHostedRuntimeBridgeCommandStore();
    const payloads = createMemoryBridgePayloadStore();

    await runs.create({
      id: "run_generic_bridge_capability_missing",
      runtime: "generic_http",
      provider: "generic_http",
      model: "generic-http-default",
      adapterType: "http",
      cwd: "/repo",
      task: "wrapper without bridge capability",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "generic_http.async_rest",
      createdAt: "2026-06-04T00:00:00.000Z"
    });
    await queue.enqueue({
      runId: "run_generic_bridge_capability_missing",
      placement: "hosted",
      runtimeMode: "generic_http.async_rest"
    });

    const worker = createHostedWorker({
      ...baseConfig(),
      hostedRuntimeAllowlist: ["fake.deterministic", "generic_http.async_rest"],
      hostedRealRuntimeExecution: "enabled",
      genericHttp: {
        ...baseConfig().genericHttp,
        baseUrl: server.baseUrl
      }
    }, {
      queue,
      runs,
      events,
      sessions,
      approvals,
      bridgeCommandStore: commands,
      bridgeCommandPayloads: payloads,
      workerId: "worker_generic_missing_bridge"
    });

    try {
      await expect(worker.tick()).resolves.toBe(true);
      const session = await sessions.getByRunId("run_generic_bridge_capability_missing");
      expect(session?.state).toMatchObject({
        hostedWorkerId: "worker_generic_missing_bridge",
        hostedRuntimeSessionId: session?.id,
        hostedBridgeCapable: false,
        runtimeMode: "generic_http.async_rest",
        externalSessionKey: expect.any(String)
      });
      expect(server.stats().healthRequests).toBeGreaterThanOrEqual(1);

      const completedRun = await runs.get("run_generic_bridge_capability_missing");
      await runs.update({
        ...completedRun!,
        status: "running",
        endedAt: undefined
      });
      await sessions.update({
        ...session!,
        status: "active",
        state: {
          ...session!.state,
          hostedBridgeCapable: false
        }
      });

      const serverBridge = new HostedRuntimeBridgeService({
        runs,
        sessions,
        approvals,
        commands,
        commandPayloads: payloads,
        runtimeRunner: { sendInput: async () => undefined }
      });
      await expect(serverBridge.createInputCommand({
        runId: "run_generic_bridge_capability_missing",
        body: { text: "should not admit" },
        idempotencyKey: "generic_missing_bridge_capability",
        auth: hostedAuth()
      })).rejects.toMatchObject({ reasonCode: "generic_http_bridge_capability_missing" });
    } finally {
      await worker.stop();
      await server.close();
    }
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
    expect(adapterSource).toContain("GenericHttpAsyncRestAdapter");
    expect(adapterSource).toContain("AgentFieldAsyncRestAdapter");

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
    expect(adapterSource).not.toContain("CodexInteractiveAdapter");
    expect(adapterSource).not.toContain("codex.interactive");
  });

  it("reports runtime bridge readiness dependencies with aggregate failures", () => {
    const notReady = getWorkerRuntimeBridgeReadiness({
      commandStore: undefined,
      workerClaim: undefined,
      sessionReconciliation: undefined,
      approvalSender: undefined,
      adapterCapabilities: {
        "claude_code.sdk": true,
        "opencode.acp": false
      }
    });

    expect(notReady.status).toBe("not_ready");
    expect(notReady.checks).toEqual([
      { name: "command_store", ok: false, reasonCode: "hosted_runtime_bridge_store_unavailable" },
      { name: "worker_claim", ok: false, reasonCode: "hosted_runtime_bridge_worker_unavailable" },
      { name: "adapter_capability", ok: false, reasonCode: "hosted_runtime_bridge_operation_unsupported" },
      { name: "wrapper_config", ok: true },
      { name: "wrapper_bridge_capability", ok: true },
      { name: "session_reconciliation", ok: false, reasonCode: "hosted_runtime_bridge_worker_unavailable" },
      { name: "approval_sender", ok: false, reasonCode: "hosted_runtime_bridge_worker_unavailable" }
    ]);

    const ready = getWorkerRuntimeBridgeReadiness({
      commandStore: { put: async () => undefined, get: async () => undefined, delete: async () => undefined },
      workerClaim: { claimAndApplyNext: async () => false },
      sessionReconciliation: { reconcileHostedRuntimeSessions: async () => ({ reconciled: 0, failed: 0 }) },
      approvalSender: { createWorkerRuntimeApproval: async () => ({ id: "approval_1" }) },
      adapterCapabilities: {
        "claude_code.sdk": true,
        "opencode.acp": true
      }
    });
    expect(ready.status).toBe("ready");
    expect(ready.checks.every((entry) => entry.ok)).toBe(true);
  });

  it("reports wrapper config and bridge capability readiness failures by mode", () => {
    const sharedDeps = {
      commandStore: { put: async () => undefined, get: async () => undefined, delete: async () => undefined },
      workerClaim: { claimAndApplyNext: async () => false },
      sessionReconciliation: { reconcileHostedRuntimeSessions: async () => ({ reconciled: 0, failed: 0 }) },
      approvalSender: { createWorkerRuntimeApproval: async () => ({ id: "approval_1" }) }
    };
    const missingConfig = getWorkerRuntimeBridgeReadiness({
      ...sharedDeps,
      adapterCapabilities: {
        "agentfield.async_rest": {
          adapter: false,
          wrapperConfig: false,
          wrapperBridgeCapability: false,
          reasonCode: "agentfield_bridge_config_missing"
        }
      }
    });
    expect(missingConfig.checks).toContainEqual({
      name: "wrapper_config",
      ok: false,
      reasonCode: "agentfield_bridge_config_missing"
    });

    const missingCapability = getWorkerRuntimeBridgeReadiness({
      ...sharedDeps,
      adapterCapabilities: {
        "generic_http.async_rest": {
          adapter: true,
          wrapperConfig: true,
          wrapperBridgeCapability: false,
          reasonCode: "generic_http_bridge_capability_missing"
        }
      }
    });
    expect(missingCapability.checks).toContainEqual({
      name: "wrapper_bridge_capability",
      ok: false,
      reasonCode: "generic_http_bridge_capability_missing"
    });
  });

  it("does not allow worker B to apply bridge input for worker A owned live session", async () => {
    const queue = new MemoryRunQueue();
    const runs = new GuardedInMemoryRunStore();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    const approvals = new InMemoryApprovalStore();
    const commands = new PostgresHostedRuntimeBridgeCommandStore();
    const payloads = createMemoryBridgePayloadStore();
    const sentByWorkerB: Array<Record<string, unknown>> = [];

    await runs.create({
      id: "run_worker_bridge_owner_guard",
      runtime: "claude_code",
      provider: "anthropic",
      model: "claude-code",
      adapterType: "native",
      cwd: "/repo",
      task: "active hosted claude",
      status: "running",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "claude_code.sdk",
      createdAt: "2026-06-02T00:00:00.000Z"
    });
    await sessions.create({
      id: "session_worker_bridge_owner_guard",
      runId: "run_worker_bridge_owner_guard",
      runtime: "claude_code",
      provider: "anthropic",
      model: "claude-code",
      protocol: "native",
      status: "active",
      runtimeMode: "claude_code.sdk",
      state: {
        hostedWorkerId: "worker_a",
        hostedBridgeCapable: true,
        hostedRuntimeSessionId: "session_worker_bridge_owner_guard"
      },
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z"
    });

    const serverBridge = new HostedRuntimeBridgeService({
      runs,
      sessions,
      approvals,
      commands,
      commandPayloads: payloads,
      runtimeRunner: { sendInput: async () => undefined }
    });
    await serverBridge.createInputCommand({
      runId: "run_worker_bridge_owner_guard",
      body: { text: "continue" },
      idempotencyKey: "owner_guard_idem_1",
      auth: hostedAuth()
    });

    const workerBBridge = new HostedRuntimeBridgeService({
      runs,
      sessions,
      approvals,
      commands,
      commandPayloads: payloads,
      runtimeRunner: {
        sendInput: async (_runId, payload) => {
          sentByWorkerB.push(payload);
        }
      }
    });
    const workerB = createHostedWorker({
      ...baseConfig(),
      hostedRuntimeAllowlist: ["fake.deterministic", "claude_code.sdk"],
      hostedRealRuntimeExecution: "enabled"
    }, {
      queue,
      runs,
      events,
      sessions,
      approvals,
      bridgeCommandStore: commands,
      bridgeCommandPayloads: payloads,
      bridgeWorkerRuntime: workerBBridge,
      workerId: "worker_b"
    });

    try {
      const worked = await workerB.tick();
      expect(worked).toBe(true);
      expect(sentByWorkerB).toHaveLength(0);
      const command = await commands.getByIdempotencyKey("owner_guard_idem_1");
      expect(command?.status).toBe("failed");
      expect(command?.reasonCode).toBe("hosted_runtime_bridge_session_not_owned");
    } finally {
      await workerB.stop();
    }
  });

  it("does not rewrite another worker's hosted session ownership when starting an unrelated run", async () => {
    const queue = new MemoryRunQueue();
    const runs = new GuardedInMemoryRunStore();
    const events = new InMemoryEventStore();
    const sessions = new InMemorySessionStore();
    const approvals = new InMemoryApprovalStore();
    const commands = new PostgresHostedRuntimeBridgeCommandStore();
    const payloads = createMemoryBridgePayloadStore();

    await runs.create({
      id: "run_worker_bridge_owner_preserve",
      runtime: "claude_code",
      provider: "anthropic",
      model: "claude-code",
      adapterType: "native",
      cwd: "/repo",
      task: "active hosted claude",
      status: "running",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "claude_code.sdk",
      createdAt: "2026-06-02T00:00:00.000Z"
    });
    await sessions.create({
      id: "session_worker_bridge_owner_preserve",
      runId: "run_worker_bridge_owner_preserve",
      runtime: "claude_code",
      provider: "anthropic",
      model: "claude-code",
      protocol: "native",
      status: "active",
      runtimeMode: "claude_code.sdk",
      state: {
        hostedWorkerId: "worker_a",
        hostedBridgeCapable: true,
        hostedRuntimeSessionId: "session_worker_bridge_owner_preserve"
      },
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z"
    });

    await runs.create({
      id: "run_worker_bridge_unrelated",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "unrelated queued run",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-06-02T00:00:00.000Z"
    });
    await queue.enqueue({
      runId: "run_worker_bridge_unrelated",
      placement: "hosted",
      runtimeMode: "fake.deterministic"
    });

    const workerB = createHostedWorker({
      ...baseConfig(),
      hostedRuntimeAllowlist: ["fake.deterministic", "claude_code.sdk"],
      hostedRealRuntimeExecution: "enabled"
    }, {
      queue,
      runs,
      events,
      sessions,
      approvals,
      bridgeCommandStore: commands,
      bridgeCommandPayloads: payloads,
      workerId: "worker_b"
    });

    try {
      const worked = await workerB.tick();
      expect(worked).toBe(true);
      const preserved = await sessions.getByRunId("run_worker_bridge_owner_preserve");
      expect(preserved?.state).toMatchObject({
        hostedWorkerId: "worker_a",
        hostedRuntimeSessionId: "session_worker_bridge_owner_preserve",
        hostedBridgeCapable: true
      });
    } finally {
      await workerB.stop();
    }
  });

  it("admits and applies hosted bridge input across separate server and worker payload-store instances", async () => {
    const runs = new GuardedInMemoryRunStore();
    const sessions = new InMemorySessionStore();
    const approvals = new InMemoryApprovalStore();
    const commands = new PostgresHostedRuntimeBridgeCommandStore();
    const payloadRows = new Map<string, { payload: Record<string, unknown> }>();
    const payloadHandle = createPayloadStoreHandle(payloadRows);
    const serverPayloads = new PostgresHostedRuntimeBridgePayloadStore(payloadHandle);
    const workerPayloads = new PostgresHostedRuntimeBridgePayloadStore(payloadHandle);
    const workerSent: Array<Record<string, unknown>> = [];

    await runs.create({
      id: "run_bridge_e2e_payload",
      runtime: "claude_code",
      provider: "anthropic",
      model: "claude-code",
      adapterType: "native",
      cwd: "/repo",
      task: "bridge payload handoff",
      status: "running",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "claude_code.sdk",
      createdAt: "2026-06-02T00:00:00.000Z"
    });
    await sessions.create({
      id: "session_bridge_e2e_payload",
      runId: "run_bridge_e2e_payload",
      runtime: "claude_code",
      provider: "anthropic",
      model: "claude-code",
      protocol: "native",
      status: "active",
      runtimeMode: "claude_code.sdk",
      state: {
        hostedWorkerId: "worker_a",
        hostedBridgeCapable: true,
        hostedRuntimeSessionId: "session_bridge_e2e_payload"
      },
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z"
    });

    const serverBridge = new HostedRuntimeBridgeService({
      runs,
      sessions,
      approvals,
      commands,
      commandPayloads: serverPayloads,
      runtimeRunner: { sendInput: async () => undefined }
    });
    const admitted = await serverBridge.createInputCommand({
      runId: "run_bridge_e2e_payload",
      body: { text: "continue" },
      idempotencyKey: "bridge_e2e_payload",
      auth: hostedAuth()
    });
    expect(admitted.accepted).toBe(true);

    const workerBridge = new HostedRuntimeBridgeService({
      runs,
      sessions,
      approvals,
      commands,
      commandPayloads: workerPayloads,
      runtimeRunner: {
        sendInput: async (_runId, payload) => {
          workerSent.push(payload);
        }
      }
    });
    const processed = await workerBridge.claimAndApplyNext({
      workerId: "worker_a",
      leaseMs: 10_000
    });
    expect(processed).toBe(true);
    expect(workerSent).toEqual([
      expect.objectContaining({
        text: "continue",
        type: "input",
        switchyardRunId: "run_bridge_e2e_payload",
        idempotencyKey: "bridge_e2e_payload",
        bridgeCommandId: admitted.commandId
      })
    ]);
    const persisted = await commands.get(admitted.commandId);
    expect(persisted?.status).toBe("completed");
  });

  it("parses real-runtime worker config and rejects production real allowlist without policy activation", () => {
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
        SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,claude_code.sdk",
        SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled",
        SWITCHYARD_DEPLOYMENT_MODE: "production"
      })
    ).toThrow(/provider_runtime_policy_missing|provider_runtime_policy_malformed/);
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

function setDebateJobField(store: DebateExecutionStore, jobId: string, key: string, value: unknown): void {
  const items = (store as unknown as { items?: Map<string, Record<string, unknown>> }).items;
  const job = items?.get(jobId);
  if (job) {
    job[key] = value;
  }
}

function deleteDebateJobField(store: DebateExecutionStore, jobId: string, key: string): void {
  const items = (store as unknown as { items?: Map<string, Record<string, unknown>> }).items;
  const job = items?.get(jobId);
  if (job) {
    delete job[key];
  }
}

function fakeDebate(id = "debate_worker_1") {
  return {
    id,
    topic: "Ship hosted debate worker execution",
    mode: "same_provider_model_debate" as const,
    status: "created" as const,
    participants: [
      {
        id: "participant_worker_a",
        runtime: "fake",
        provider: "test",
        model: "test-model",
        role: "affirmative",
        status: "created" as const,
        turnsUsed: 0,
        runIds: [],
        adapterType: "process",
        runtimeMode: "fake.deterministic",
        placement: "hosted"
      },
      {
        id: "participant_worker_b",
        runtime: "fake",
        provider: "test",
        model: "test-model",
        role: "negative",
        status: "created" as const,
        turnsUsed: 0,
        runIds: [],
        adapterType: "process",
        runtimeMode: "fake.deterministic",
        placement: "hosted"
      }
    ],
    limits: {
      maxRounds: 1,
      maxTurnsPerAgent: 1,
      maxSearchesPerAgent: 0,
      maxTotalMessages: 2,
      maxDurationSeconds: 30,
      maxCostUsd: 0,
      requireCitations: false,
      requireDisagreementSummary: true,
      stopOnConsensus: false,
      stopOnLowNewInformation: false,
      humanStopAllowed: false
    },
    evidenceIds: [],
    messageIds: [],
    eventIds: [],
    budget: {
      status: "within_budget" as const,
      maxCostUsd: 0,
      spentCostUsd: 0
    },
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z"
  };
}

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
    genericHttp: {
      requestTimeoutMs: 5000,
      pollIntervalMs: 100,
      maxResponseBytes: 1_048_576
    },
    agentfield: {
      requestTimeoutMs: 5000,
      pollIntervalMs: 1000,
      maxResponseBytes: 1_048_576
    },
    providerRuntimeActivation: {
      valid: true,
      enabledRealModes: [],
      reasons: [],
      redactedSummary: {
        deploymentMode: "test",
        hostedRealRuntimeExecution: "disabled",
        realModeCount: 0,
        enabledRealModeCount: 0,
        source: { kind: "none" },
        modeStatuses: [],
        reasonCodes: []
      }
    },
    redactedSummary: {}
  };
}

function validProductionActivation(enabledModes: Array<"codex.exec_json" | "claude_code.sdk" | "opencode.acp">) {
  return {
    valid: true as const,
    enabledRealModes: enabledModes,
    reasons: [],
    redactedSummary: {
      deploymentMode: "production" as const,
      hostedRealRuntimeExecution: "enabled" as const,
      realModeCount: enabledModes.length,
      enabledRealModeCount: enabledModes.length,
      source: { kind: "json" as const },
      modeStatuses: enabledModes.map((runtimeMode) => ({ runtimeMode, ready: true, reasons: [] as string[] })),
      reasonCodes: []
    },
    policy: {
      version: 1 as const,
      modes: {
        "codex.exec_json": {
          enabled: enabledModes.includes("codex.exec_json"),
          executablePath: "/bin/echo",
          cwdPrefixes: ["/srv/switchyard/work"],
          envAllowlist: ["PATH"],
          requiredEnv: ["PATH"],
          fixedArgs: ["exec", "--json"],
          allowUserArgs: false as const,
          sandbox: "read_only" as const,
          spendControls: {
            maxActiveRuns: 5,
            maxRunsPerHour: 20,
            maxRunTimeoutSeconds: 120,
            maxPromptBytes: 4096
          }
        },
        "claude_code.sdk": {
          enabled: enabledModes.includes("claude_code.sdk"),
          executablePath: "/bin/echo",
          cwdPrefixes: ["/srv/switchyard/work"],
          envAllowlist: ["PATH"],
          requiredEnv: ["PATH"],
          fixedArgs: [],
          allowUserArgs: false as const,
          permissionMode: "read_only" as const,
          disabledTools: ["Bash", "WebFetch", "WebSearch"],
          spendControls: {
            maxActiveRuns: 5,
            maxRunsPerHour: 20,
            maxRunTimeoutSeconds: 120,
            maxPromptBytes: 4096
          }
        },
        "opencode.acp": {
          enabled: enabledModes.includes("opencode.acp"),
          executablePath: "/bin/echo",
          cwdPrefixes: ["/srv/switchyard/work"],
          envAllowlist: ["PATH"],
          requiredEnv: ["PATH"],
          fixedArgs: ["acp"],
          allowUserArgs: false as const,
          onePromptPerRun: true as const,
          spendControls: {
            maxActiveRuns: 5,
            maxRunsPerHour: 20,
            maxRunTimeoutSeconds: 120,
            maxPromptBytes: 4096
          }
        }
      }
    }
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

function baseSandboxLimits() {
  return {
    wallTimeMs: 5_000,
    stdoutBytes: 8_192,
    stderrBytes: 8_192,
    combinedOutputBytes: 16_384,
    artifactBytes: 65_536,
    stdinBytes: 8_192,
    argvCount: 16,
    argvEntryBytes: 256,
    envKeys: 16,
    envValueBytes: 1_024,
    ptyCols: 120,
    ptyRows: 40,
    cpuMs: 1_000,
    memoryMiB: 256
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

class FakeSandboxProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 5678;

  constructor(output: string) {
    super();
    queueMicrotask(() => {
      this.stdout.write(output);
      this.stdout.end();
      this.stderr.end();
      this.emit("close", 0, null);
    });
  }

  kill(_signal?: NodeJS.Signals): boolean {
    this.emit("close", 0, null);
    return true;
  }
}

function createMemoryBridgePayloadStore(): {
  put(input: { commandId: string; payload: Record<string, unknown> }): Promise<void>;
  get(commandId: string): Promise<Record<string, unknown> | undefined>;
  delete(commandId: string): Promise<void>;
} {
  const map = new Map<string, Record<string, unknown>>();
  return {
    async put(input) {
      map.set(input.commandId, input.payload);
    },
    async get(commandId) {
      return map.get(commandId);
    },
    async delete(commandId) {
      map.delete(commandId);
    }
  };
}

function createPayloadStoreHandle(
  rows: Map<string, { payload: Record<string, unknown> }>
): PostgresDatabaseHandle {
  return {
    pool: {
      query: async (sql: string, params?: ReadonlyArray<unknown>) => {
        if (!params) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO hosted_runtime_bridge_payloads")) {
          const commandId = String(params[0]);
          const payload = params[1] as Record<string, unknown>;
          rows.set(commandId, { payload });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("DELETE FROM hosted_runtime_bridge_payloads")) {
          const commandId = String(params[0]);
          const existed = rows.delete(commandId);
          return { rows: [], rowCount: existed ? 1 : 0 };
        }
        if (sql.includes("FROM hosted_runtime_bridge_payloads")) {
          const commandId = String(params[0]);
          const row = rows.get(commandId);
          return { rows: row ? [{ payload: row.payload }] : [], rowCount: row ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    } as PostgresDatabaseHandle["pool"],
    db: {} as PostgresDatabaseHandle["db"],
    real: true,
    close: async () => {}
  };
}

function hostedAuth(): AuthContext {
  return {
    account: { id: "account_1", slug: "account", displayName: "Account", status: "active", createdAt: "2026-06-02T00:00:00.000Z" },
    tenant: { id: "tenant_1", accountId: "account_1", slug: "tenant", displayName: "Tenant", status: "active", createdAt: "2026-06-02T00:00:00.000Z" },
    project: { id: "project_1", tenantId: "tenant_1", slug: "project", displayName: "Project", status: "active", createdAt: "2026-06-02T00:00:00.000Z" },
    user: { id: "user_1", accountId: "account_1", email: "user@example.com", displayName: "User", status: "active", createdAt: "2026-06-02T00:00:00.000Z" },
    apiKey: { id: "api_key_1", keyPrefix: "sk_sw", scopes: ["runs:write"], status: "active", createdAt: "2026-06-02T00:00:00.000Z" },
    entitlement: {
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      planId: "plan_1",
      planSlug: "plan",
      planDisplayName: "Plan",
      planStatus: "active",
      entitlements: {
        allowedPlacements: ["local", "hosted", "connected_local_node"],
        allowedRuntimeModes: ["claude_code.sdk", "opencode.acp", "agentfield.async_rest", "generic_http.async_rest"],
        allowHostedRealRuntime: true,
        allowConnectedNodes: true,
        allowArtifactContentRead: true,
        allowAuditRead: true,
        allowMetricsRead: true,
        allowToolExecution: true
      },
      quotas: {
        maxRunsPerHour: 1000,
        maxActiveRuns: 1000,
        maxRunTimeoutSeconds: 3600,
        maxConnectedNodes: 100,
        maxArtifactContentReadBytesPerHour: 10_000_000,
        maxToolInvocationsPerHour: 1000,
        maxActiveToolInvocations: 1000,
        maxToolArtifactBytesPerHour: 10_000_000,
        maxRuntimeBridgeCommandsPerHour: 1000,
        maxActiveRuntimeBridgeCommands: 1000
      },
      scopes: ["runs:write"],
      capturedAt: "2026-06-02T00:00:00.000Z"
    },
    authenticatedAt: "2026-06-02T00:00:00.000Z"
  };
}
