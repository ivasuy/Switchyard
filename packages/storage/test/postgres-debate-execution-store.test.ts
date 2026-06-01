import { describe, expect, it } from "vitest";
import type { DebateExecutionStore, UnownedResourceCounts } from "@switchyard/core";
import { PostgresControlPlaneStore, PostgresDebateExecutionStore, PostgresRunStore } from "../src/index.js";

describe("postgres debate execution store", () => {
  it("enqueues, claims, links pending runs, releases, completes, and exposes stats", async () => {
    const store: DebateExecutionStore = new PostgresDebateExecutionStore();

    const queued = await store.enqueue({
      id: "debate_job_1",
      debateId: "debate_1",
      stage: "participant_turn",
      debateRound: 1,
      debatePhase: "arguing",
      participantIndex: 0,
      maxAttempts: 3,
      nextAttemptAt: "2026-06-02T00:00:00.000Z",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      userId: "user_1",
      apiKeyId: "api_key_1"
    });
    expect(queued.state).toBe("queued");

    const claimed = await store.claim({ now: "2026-06-02T00:00:01.000Z", leaseMs: 30_000 });
    expect(claimed?.id).toBe("debate_job_1");
    expect(claimed?.state).toBe("claimed");

    const link = await store.linkPendingRun("debate_job_1", "debate_1:p0:r1:arguing:participant", "run_1", "participant_turn");
    expect(link.ok).toBe(true);

    const pending = await store.findPendingRunByKey("debate_1:p0:r1:arguing:participant");
    expect(pending).toMatchObject({
      jobId: "debate_job_1",
      runId: "run_1"
    });

    await store.release("debate_job_1", {
      nextAttemptAt: "2026-06-02T00:00:05.000Z",
      reasonCode: "awaiting_child_run_terminal"
    });
    const reclaimed = await store.claim({ now: "2026-06-02T00:00:05.000Z", leaseMs: 30_000 });
    expect(reclaimed?.id).toBe("debate_job_1");

    await store.complete("debate_job_1");
    expect((await store.get("debate_job_1"))?.state).toBe("completed");

    const stats = await store.stats();
    expect(stats).toMatchObject({
      queued: 0,
      claimed: 0,
      failed: 0,
      exhausted: 0
    });
  });

  it("recovers stale claims and exhausts attempts at max", async () => {
    const store: DebateExecutionStore = new PostgresDebateExecutionStore();
    await store.enqueue({
      id: "debate_job_2",
      debateId: "debate_2",
      stage: "participant_turn",
      debateRound: 1,
      debatePhase: "arguing",
      participantIndex: 1,
      maxAttempts: 1,
      nextAttemptAt: "2026-06-02T00:00:00.000Z"
    });

    await store.claim({ now: "2026-06-02T00:00:00.000Z", leaseMs: 1 });
    const recovered = await store.recoverStaleClaims({ now: "2026-06-02T00:00:01.000Z" });
    expect(recovered).toEqual({ recovered: 0, exhausted: 1, invalid: 0 });
    expect((await store.get("debate_job_2"))?.state).toBe("exhausted");

    await store.enqueue({
      id: "debate_job_3",
      debateId: "debate_3",
      stage: "participant_turn",
      debateRound: 1,
      debatePhase: "arguing",
      participantIndex: 0,
      maxAttempts: 3,
      nextAttemptAt: "2026-06-02T00:00:00.000Z"
    });

    await store.claim({ now: "2026-06-02T00:00:00.000Z", leaseMs: 1 });
    const secondRecovery = await store.recoverStaleClaims({ now: "2026-06-02T00:00:01.000Z" });
    expect(secondRecovery).toEqual({ recovered: 1, exhausted: 0, invalid: 0 });
    expect((await store.get("debate_job_3"))?.state).toBe("queued");
  });

  it("supports run child-key lookup and exposes debate-related unowned counters", async () => {
    const runs = new PostgresRunStore();
    await runs.create({
      id: "run_debate_child_1",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "debate turn",
      status: "queued",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {
        debateChildRunKey: "debate_4:judge:r1:judging:judge"
      },
      createdAt: "2026-06-02T00:00:00.000Z"
    });

    const found = await runs.findByDebateChildRunKey?.("debate_4:judge:r1:judging:judge");
    expect(found?.id).toBe("run_debate_child_1");

    const controlPlane = new PostgresControlPlaneStore();
    const counts: UnownedResourceCounts = await controlPlane.countUnownedResources();
    const requiredKeys: Array<keyof UnownedResourceCounts> = [
      "runs",
      "runEvents",
      "artifacts",
      "toolInvocations",
      "approvals",
      "placements",
      "nodes",
      "assignments",
      "auditEvents",
      "quotaReservations",
      "debates",
      "debateExecutionJobs",
      "messages",
      "evidence",
      "childRuns",
      "debateArtifacts",
      "debateEvents"
    ];
    for (const key of requiredKeys) {
      expect(counts).toHaveProperty(key);
    }
  });
});
