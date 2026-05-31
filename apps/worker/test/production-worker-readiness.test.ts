import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveHostedSandboxConfig } from "@switchyard/core";
import { resolveObjectStoreConfig } from "@switchyard/storage";
import { InMemoryEventStore, InMemoryRunStore } from "@switchyard/testkit";
import { MemoryRunQueue } from "@switchyard/queue";
import { createHostedWorker } from "../src/worker.js";
import { runWorkerReadinessCommand } from "../src/ready.js";
import type { WorkerConfig } from "../src/config.js";
import type { PostgresDatabaseHandle } from "@switchyard/storage";

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

  it("includes redacted sandbox diagnostics in successful readiness", async () => {
    const worker = createHostedWorker(baseConfig(), {
      queue: new MemoryRunQueue(),
      runs: new InMemoryRunStore(),
      events: new InMemoryEventStore(),
      postgres: fakePostgresHandle(),
      ensurePostgresSchema: async () => {},
      probePostgres: async () => {},
      checkSchemaCompatibility: async () => ({ ok: true, code: "postgres_schema_ready", version: 19 })
    });

    try {
      const readiness = await worker.ready();
      expect(readiness.ok).toBe(true);
      expect(readiness.checks?.sandbox).toMatchObject({
        ok: true,
        diagnostics: {
          mode: "disabled",
          policyCount: 0,
          ptyDriverConfigured: false
        }
      });
    } finally {
      await worker.stop();
    }
  });

  it("does not claim jobs when sandbox readiness fails with missing policy", async () => {
    const queue = new MemoryRunQueue();
    let claimCalls = 0;
    const originalClaim = queue.claim.bind(queue);
    queue.claim = async (options) => {
      claimCalls += 1;
      return originalClaim(options);
    };

    const worker = createHostedWorker({
      ...baseConfig(),
      sandbox: resolveHostedSandboxConfig({
        deploymentMode: "test",
        env: {
          SWITCHYARD_SANDBOX_REAL_EXECUTION: "enabled"
        }
      })
    }, {
      queue,
      runs: new InMemoryRunStore(),
      events: new InMemoryEventStore(),
      postgres: fakePostgresHandle(),
      ensurePostgresSchema: async () => {},
      probePostgres: async () => {},
      checkSchemaCompatibility: async () => ({ ok: true, code: "postgres_schema_ready", version: 19 })
    });

    try {
      const claimReadiness = await worker.ready({ mode: "claim" });
      expect(claimReadiness).toMatchObject({
        ok: false,
        reason: "sandbox_policy_missing",
        checks: {
          sandbox: {
            ok: false,
            code: "sandbox_policy_missing"
          }
        }
      });

      const worked = await worker.tick();
      expect(worked).toBe(false);
      expect(claimCalls).toBe(0);
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

  it("readiness CLI keeps structured JSON when Postgres is unreachable", async () => {
    const result = await runWorkerReadyCli({
      SWITCHYARD_DEPLOYMENT_MODE: "production",
      SWITCHYARD_POSTGRES_URL: "postgres://worker:worker-strong-credential@127.0.0.1:1/switchyard",
      SWITCHYARD_REDIS_URL: "redis://default:worker-strong-credential@127.0.0.1:1/0",
      SWITCHYARD_OBJECT_STORE_BACKEND: "local",
      SWITCHYARD_OBJECT_STORE_DIR: "/tmp/switchyard-worker-ready",
      SWITCHYARD_OBJECT_STORE_PROBE: "write_read_delete",
      SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
      SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "disabled"
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain("ECONNREFUSED");
    expect(result.stderr).not.toContain("Error:");

    const payload = JSON.parse(result.stdout.trim()) as { ok: boolean; reason?: string };
    expect(payload).toMatchObject({ ok: false, reason: "postgres_unavailable" });
  });
});

function runWorkerReadyCli(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", "src/ready.ts"], {
      cwd: workerRoot,
      env: {
        ...process.env,
        ...env,
        FORCE_COLOR: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker_ready_cli_timeout"));
    }, 7_500);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ code, stdout, stderr });
    });
  });
}
