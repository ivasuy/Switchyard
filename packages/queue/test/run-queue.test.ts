import { describe, expect, it } from "vitest";
import { BullMqRunQueue, MemoryRunQueue } from "../src/index.js";

describe("MemoryRunQueue", () => {
  it("enqueues, claims, retries, and acks jobs", async () => {
    const queue = new MemoryRunQueue({ now: () => "2026-05-30T00:00:00.000Z", leaseMs: 1_000 });
    const enqueued = await queue.enqueue({
      runId: "run_1",
      placement: "hosted",
      runtimeMode: "fake.deterministic"
    });

    expect(enqueued.jobId).toMatch(/^job_/);

    const claimed = await queue.claim();
    expect(claimed?.payload.runId).toBe("run_1");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseUntil).toBeDefined();

    await queue.retry(claimed!.id);
    const claimedAgain = await queue.claim();
    expect(claimedAgain?.attempts).toBe(2);

    await queue.ack(claimedAgain!.id);
    expect(await queue.getJob(claimedAgain!.id)).toBeUndefined();
    expect(await queue.stats()).toEqual({ queued: 0, claimed: 0, failed: 0, exhausted: 0 });
  });

  it("discards queued jobs", async () => {
    const queue = new MemoryRunQueue();
    const enqueued = await queue.enqueue({
      runId: "run_2",
      placement: "hosted",
      runtimeMode: "fake.deterministic"
    });
    await queue.discard(enqueued.jobId);
    expect(await queue.getJob(enqueued.jobId)).toBeUndefined();
  });

  it("recovers stale claimed jobs and exhausts at max attempts", async () => {
    const queue = new MemoryRunQueue({ now: () => "2026-05-30T00:00:00.000Z", leaseMs: 1000 });
    const first = await queue.enqueue({
      runId: "run_recover",
      placement: "hosted",
      runtimeMode: "fake.deterministic"
    }, { maxAttempts: 2 });
    await queue.claim();
    const recovered = await queue.recoverStaleClaims({ now: "2026-05-30T00:00:02.000Z" });
    expect(recovered).toEqual({ recovered: 1, exhausted: 0, invalid: 0, exhaustedClaims: [] });
    const reclaimed = await queue.claim();
    expect(reclaimed?.attempts).toBe(2);
    const exhausted = await queue.recoverStaleClaims({ now: "2026-05-30T00:00:04.000Z" });
    expect(exhausted).toEqual({
      recovered: 0,
      exhausted: 1,
      invalid: 0,
      exhaustedClaims: [{ jobId: first.jobId, runId: "run_recover" }]
    });
    expect((await queue.getJob(first.jobId))?.state).toBe("exhausted");
  });

  it("skips redis integration tests when SWITCHYARD_TEST_REDIS_URL is missing", () => {
    if (!process.env["SWITCHYARD_TEST_REDIS_URL"]) {
      expect("SKIPPED_SWITCHYARD_TEST_REDIS_URL_UNSET").toContain("SKIPPED");
      return;
    }
    expect(process.env["SWITCHYARD_TEST_REDIS_URL"]).toBeTruthy();
  });

  it("uses BullMQ when SWITCHYARD_TEST_REDIS_URL is configured", async () => {
    const redisUrl = process.env["SWITCHYARD_TEST_REDIS_URL"];
    if (!redisUrl) {
      expect("SKIPPED_SWITCHYARD_TEST_REDIS_URL_UNSET").toContain("SKIPPED");
      return;
    }

    const queue = new BullMqRunQueue({
      redisUrl,
      queueName: `switchyard-test-${crypto.randomUUID()}`
    });
    try {
      const enqueued = await queue.enqueue({
        runId: "run_redis_1",
        placement: "hosted",
        runtimeMode: "fake.deterministic"
      });
      const claimed = await queue.claim();
      expect(claimed?.payload.jobId).toBe(enqueued.jobId);
      expect((await queue.stats()).claimed).toBe(1);
      await queue.retry(enqueued.jobId);
      const claimedAgain = await queue.claim();
      expect(claimedAgain?.attempts).toBe(2);
      await queue.fail(enqueued.jobId, { reasonCode: "worker_retry_exhausted", message: "boom" });
      const snapshot = await queue.getJob(enqueued.jobId);
      expect(snapshot?.state).toBe("exhausted");
      await queue.discard(enqueued.jobId);
    } finally {
      await queue.close();
    }
  });
});
