import { describe, expect, it } from "vitest";
import { resolveHostedSandboxConfig } from "@switchyard/core";
import { resolveObjectStoreConfig } from "@switchyard/storage";
import { InMemoryEventStore, InMemoryRunStore } from "@switchyard/testkit";
import { MemoryRunQueue } from "@switchyard/queue";
import { createHostedWorker } from "../src/worker.js";
import { runWorkerReadinessCommand } from "../src/ready.js";
import type { WorkerConfig } from "../src/config.js";
import type { PostgresDatabaseHandle } from "@switchyard/storage";

function baseConfig(): WorkerConfig {
  return {
    deploymentMode: "production",
    hostedRuntimeAllowlist: ["fake.deterministic"],
    hostedRealRuntimeExecution: "disabled",
    postgresUrl: "postgres://user:pass@localhost:5432/switchyard",
    redisUrl: "redis://localhost:6379/0",
    queueName: "switchyard-hosted-runs",
    idleIntervalMs: 1,
    objectStore: resolveObjectStoreConfig({
      deploymentMode: "test",
      env: {
        SWITCHYARD_OBJECT_STORE_BACKEND: "memory"
      }
    }),
    sandbox: resolveHostedSandboxConfig({ deploymentMode: "test", env: {} }),
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
      maxMessageBytes: 1024 * 1024
    },
    redactedSummary: {
      deploymentMode: "production"
    }
  };
}

function fakePostgresHandle(): PostgresDatabaseHandle {
  return {
    pool: { query: async () => ({ rows: [] }) } as never,
    db: {} as never,
    real: true,
    close: async () => {}
  };
}

describe("production worker readiness", () => {
  it("does not claim jobs when schema readiness fails", async () => {
    const queue = new MemoryRunQueue();
    let claimCalls = 0;
    const originalClaim = queue.claim.bind(queue);
    queue.claim = async (options) => {
      claimCalls += 1;
      return originalClaim(options);
    };

    const worker = createHostedWorker(baseConfig(), {
      queue,
      runs: new InMemoryRunStore(),
      events: new InMemoryEventStore(),
      postgres: fakePostgresHandle(),
      ensurePostgresSchema: async () => {},
      probePostgres: async () => {},
      checkSchemaCompatibility: async () => ({ ok: false, code: "postgres_schema_migration_required" })
    });

    try {
      const worked = await worker.tick();
      expect(worked).toBe(false);
      expect(claimCalls).toBe(0);
    } finally {
      await worker.stop();
    }
  });

  it("caches successful full readiness within TTL while still calling claim", async () => {
    const queue = new MemoryRunQueue();
    let claimCalls = 0;
    let statsCalls = 0;
    const originalClaim = queue.claim.bind(queue);
    const originalStats = queue.stats.bind(queue);

    queue.claim = async (options) => {
      claimCalls += 1;
      return originalClaim(options);
    };
    queue.stats = async () => {
      statsCalls += 1;
      return originalStats();
    };

    let nowMs = 1000;
    const worker = createHostedWorker(baseConfig(), {
      queue,
      runs: new InMemoryRunStore(),
      events: new InMemoryEventStore(),
      postgres: fakePostgresHandle(),
      ensurePostgresSchema: async () => {},
      probePostgres: async () => {},
      checkSchemaCompatibility: async () => ({ ok: true, code: "postgres_schema_ready", version: 19 }),
      now: () => nowMs,
      readinessTtlMs: 5000
    });

    try {
      for (let i = 0; i < 5; i += 1) {
        const worked = await worker.tick();
        expect(worked).toBe(false);
        nowMs += 100;
      }

      expect(claimCalls).toBe(5);
      expect(statsCalls).toBe(1);
    } finally {
      await worker.stop();
    }
  });

  it("refreshes full readiness once cache TTL expires", async () => {
    const queue = new MemoryRunQueue();
    let statsCalls = 0;
    const originalStats = queue.stats.bind(queue);
    queue.stats = async () => {
      statsCalls += 1;
      return originalStats();
    };

    let nowMs = 10_000;
    const worker = createHostedWorker(baseConfig(), {
      queue,
      runs: new InMemoryRunStore(),
      events: new InMemoryEventStore(),
      postgres: fakePostgresHandle(),
      ensurePostgresSchema: async () => {},
      probePostgres: async () => {},
      checkSchemaCompatibility: async () => ({ ok: true, code: "postgres_schema_ready", version: 19 }),
      now: () => nowMs,
      readinessTtlMs: 5000
    });

    try {
      await worker.tick();
      nowMs += 5100;
      await worker.tick();
      expect(statsCalls).toBe(2);
    } finally {
      await worker.stop();
    }
  });

  it("returns structured failure from worker readiness command", async () => {
    const result = await runWorkerReadinessCommand({
      SWITCHYARD_DEPLOYMENT_MODE: "production"
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});
