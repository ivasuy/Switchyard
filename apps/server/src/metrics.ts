import type { RunQueuePort } from "@switchyard/core";

export interface HostedMetricsSnapshot {
  requests: { total: number };
  errors: { total: number; metricsCollection: number };
  placement: { accepted: number; denied: number };
  queue: {
    available: boolean;
    enqueue: number;
    claim: number;
    ack: number;
    retry: number;
    failed: number;
    exhausted: number;
    queued: number;
    claimed: number;
  };
  worker: { attempts: number; exhausted: number };
  objectStore: {
    reads: number;
    writes: number;
    failures: number;
    probeFailures: number;
    authFailures: number;
    unavailable: number;
    digestMismatches: number;
  };
  sandbox: {
    jobs: number;
    allowed: number;
    denied: number;
    completed: number;
    failed: number;
    timeout: number;
    cancelled: number;
    outputTruncated: number;
    artifactTruncated: number;
    redactions: number;
  };
  node: { register: number; heartbeat: number; claim: number; sync: number; complete: number; reject: number };
  dependencies: { ready: number; notReady: number };
  config: { failures: number };
}

export class HostedMetrics {
  private readonly snapshot: HostedMetricsSnapshot = {
    requests: { total: 0 },
    errors: { total: 0, metricsCollection: 0 },
    placement: { accepted: 0, denied: 0 },
    queue: { available: true, enqueue: 0, claim: 0, ack: 0, retry: 0, failed: 0, exhausted: 0, queued: 0, claimed: 0 },
    worker: { attempts: 0, exhausted: 0 },
    objectStore: { reads: 0, writes: 0, failures: 0, probeFailures: 0, authFailures: 0, unavailable: 0, digestMismatches: 0 },
    sandbox: {
      jobs: 0,
      allowed: 0,
      denied: 0,
      completed: 0,
      failed: 0,
      timeout: 0,
      cancelled: 0,
      outputTruncated: 0,
      artifactTruncated: 0,
      redactions: 0
    },
    node: { register: 0, heartbeat: 0, claim: 0, sync: 0, complete: 0, reject: 0 },
    dependencies: { ready: 0, notReady: 0 },
    config: { failures: 0 }
  };

  inc(path: string): void {
    const parts = path.split(".");
    if (parts.length === 0) return;
    let current: Record<string, unknown> = this.snapshot as unknown as Record<string, unknown>;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const segment = parts[index];
      if (!segment) return;
      current = current[segment] as Record<string, unknown>;
    }
    const key = parts[parts.length - 1];
    if (!key) return;
    const value = Number(current[key] ?? 0);
    current[key] = value + 1;
  }

  async captureQueue(queue: RunQueuePort): Promise<void> {
    const stats = await queue.stats();
    this.snapshot.queue.available = true;
    this.snapshot.queue.queued = stats.queued;
    this.snapshot.queue.claimed = stats.claimed;
  }

  markComponentUnavailable(component: "queue"): void {
    if (component === "queue") {
      this.snapshot.queue.available = false;
    }
  }

  toJSON(): HostedMetricsSnapshot {
    return structuredClone(this.snapshot);
  }
}
