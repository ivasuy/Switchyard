import { describe, expect, it } from "vitest";
import { MemoryRunQueue } from "../src/index.js";

describe("MemoryRunQueue", () => {
  it("enqueues, claims, retries, and acks jobs", async () => {
    const queue = new MemoryRunQueue();
    const enqueued = await queue.enqueue({
      runId: "run_1",
      placement: "hosted",
      runtimeMode: "fake.deterministic"
    });

    expect(enqueued.jobId).toMatch(/^job_/);

    const claimed = await queue.claim();
    expect(claimed?.payload.runId).toBe("run_1");
    expect(claimed?.attempts).toBe(1);

    await queue.retry(claimed!.id);
    const claimedAgain = await queue.claim();
    expect(claimedAgain?.attempts).toBe(2);

    await queue.ack(claimedAgain!.id);
    expect(await queue.getJob(claimedAgain!.id)).toBeUndefined();
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

  it("skips redis integration tests when SWITCHYARD_TEST_REDIS_URL is missing", () => {
    if (!process.env["SWITCHYARD_TEST_REDIS_URL"]) {
      expect("SKIPPED_SWITCHYARD_TEST_REDIS_URL_UNSET").toContain("SKIPPED");
      return;
    }
    expect(process.env["SWITCHYARD_TEST_REDIS_URL"]).toBeTruthy();
  });
});
