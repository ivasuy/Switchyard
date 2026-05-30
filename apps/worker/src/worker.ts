import {
  HostedWorkerService,
  HostedSandboxService,
  checkHostedSandboxReadiness,
  RunService,
  RuntimeRunnerService,
  type ArtifactContentStore,
  type ArtifactStore,
  type EventStore,
  type RunQueuePort,
  type RunStore,
  type SessionStore,
  type RuntimeAdapter
} from "@switchyard/core";
import { BullMqRunQueue, MemoryRunQueue } from "@switchyard/queue";
import {
  createArtifactContentStoreFromObjectConfig,
  ensurePostgresSchema,
  PostgresArtifactStore,
  PostgresEventStore,
  PostgresRunStore,
  PostgresSessionStore,
  probePostgresDatabase,
  openPostgresDatabase
} from "@switchyard/storage";
import { FakeHostedSandboxExecutor, FakeRuntimeAdapter, InMemoryEventStore, InMemoryRunStore } from "@switchyard/testkit";
import type { WorkerConfig } from "./config.js";

export interface HostedWorkerApp {
  tick: () => Promise<boolean>;
  ready: () => Promise<{
    ok: boolean;
    reason?: string;
    checks?: {
      sandbox?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    };
  }>;
  stop: () => Promise<void>;
}

export function createHostedWorker(config: WorkerConfig, deps?: {
  queue?: MemoryRunQueue;
  runs?: InMemoryRunStore;
  events?: InMemoryEventStore;
}): HostedWorkerApp {
  const postgres = config.postgresUrl ? openPostgresDatabase(config.postgresUrl) : undefined;
  let postgresReady: Promise<void> | undefined;
  if (postgres) {
    postgresReady = ensurePostgresSchema(postgres);
  }

  const queue: RunQueuePort & { close?: () => Promise<void> } = deps?.queue
    ?? (config.redisUrl
      ? new BullMqRunQueue({ redisUrl: config.redisUrl, queueName: config.queueName ?? "switchyard-hosted-runs" })
      : new MemoryRunQueue());
  const runs: RunStore = deps?.runs ?? new PostgresRunStore(postgres);
  const events: EventStore = deps?.events ?? new PostgresEventStore(postgres);
  const sessions: SessionStore = new PostgresSessionStore(postgres);
  const artifacts: ArtifactStore = new PostgresArtifactStore(postgres);
  const artifactContent: ArtifactContentStore & { probe: () => Promise<{ ok: true }> } =
    createArtifactContentStoreFromObjectConfig(config.objectStore);

  const adapters = new Map<string, RuntimeAdapter>([["fake", new FakeRuntimeAdapter()]]);
  const _hostedSandbox = new HostedSandboxService({
    config: config.sandbox,
    executor: new FakeHostedSandboxExecutor()
  });
  const runner = new RuntimeRunnerService({
    runs,
    events,
    sessions,
    adapters,
    artifacts,
    artifactContent: {
      writeText: async (path, content) => {
        return artifactContent.writeText(path, content, { contentType: "application/x-ndjson" });
      }
    }
  });
  const runService = new RunService({ runs, events, runner });

  const service = new HostedWorkerService({
    queue,
    runs,
    events,
    startRun: async (runId) => runService.startRun(runId),
    hostedRuntimeAllowlist: config.hostedRuntimeAllowlist
  });

  return {
    tick: async () => {
      await postgresReady;
      return service.processNext();
    },
    ready: async () => {
      try {
        await postgresReady;
        if (postgres) {
          await probePostgresDatabase(postgres);
        }
        await queue.stats();
        if (config.objectStore.probe !== "disabled") {
          await artifactContent.probe();
        }

        const sandbox = checkHostedSandboxReadiness(config.sandbox);
        if (!sandbox.ok) {
          const code = sandbox.code ?? "sandbox_config_invalid";
          return {
            ok: false,
            reason: code,
            checks: {
              sandbox: {
                ok: false,
                code,
                diagnostics: {
                  summary: config.sandbox.redactedSummary
                }
              }
            }
          };
        }

        return { ok: true, checks: { sandbox: { ok: true } } };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    stop: async () => {
      await postgresReady;
      await queue.close?.();
      await postgres?.close();
    }
  };
}
