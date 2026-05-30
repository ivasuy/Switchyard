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
  type SessionStore
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
import { FakeHostedSandboxExecutor, InMemoryEventStore, InMemoryRunStore } from "@switchyard/testkit";
import type { WorkerConfig } from "./config.js";
import { buildHostedWorkerAdapters, checkConfiguredHostedAdapters, type HostedWorkerAdapterFactoryDeps } from "./hosted-runtime-adapters.js";

export interface HostedWorkerApp {
  tick: () => Promise<boolean>;
  ready: () => Promise<{
    ok: boolean;
    reason?: string;
    checks?: {
      hostedRuntimeGate?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
      hostedRuntimeAdapters?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
      sandbox?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    };
  }>;
  stop: () => Promise<void>;
}

export function createHostedWorker(config: WorkerConfig, deps?: {
  queue?: MemoryRunQueue;
  runs?: InMemoryRunStore;
  events?: InMemoryEventStore;
  adapters?: HostedWorkerAdapterFactoryDeps;
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

  const adapters = buildHostedWorkerAdapters(config, deps?.adapters);
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
    hostedRuntimeAllowlist: config.hostedRuntimeAllowlist,
    deploymentMode: config.deploymentMode,
    hostedRealRuntimeExecution: config.hostedRealRuntimeExecution
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

        const checks: NonNullable<Awaited<ReturnType<HostedWorkerApp["ready"]>>["checks"]> = {};

        const hasRealAllowlist = config.hostedRuntimeAllowlist.some((mode) => mode !== "fake.deterministic");
        if (!hasRealAllowlist) {
          checks.hostedRuntimeGate = { ok: true };
        } else if (config.hostedRealRuntimeExecution !== "enabled") {
          checks.hostedRuntimeGate = { ok: false, code: "hosted_real_runtime_disabled" };
        } else if (config.deploymentMode === "production") {
          checks.hostedRuntimeGate = { ok: false, code: "hosted_real_runtime_production_forbidden" };
        } else {
          checks.hostedRuntimeGate = { ok: true };
        }

        const adapterCheck = await checkConfiguredHostedAdapters(config, deps?.adapters);
        checks.hostedRuntimeAdapters = adapterCheck.ok
          ? { ok: true, diagnostics: { modes: adapterCheck.modes } }
          : {
            ok: false,
            code: firstAdapterFailureCode(adapterCheck.modes),
            diagnostics: { modes: adapterCheck.modes }
          };

        const sandbox = checkHostedSandboxReadiness(config.sandbox);
        if (!sandbox.ok) {
          const code = sandbox.code ?? "sandbox_config_invalid";
          checks.sandbox = {
            ok: false,
            code,
            diagnostics: {
              summary: config.sandbox.redactedSummary
            }
          };
          return {
            ok: false,
            reason: code,
            checks
          };
        }
        checks.sandbox = { ok: true };

        const ok = Object.values(checks).every((check) => check.ok);
        return { ok, checks };
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

function firstAdapterFailureCode(modes: Record<string, { ok: boolean; code?: string }>): string {
  for (const entry of Object.values(modes)) {
    if (!entry.ok) {
      return entry.code ?? "adapter_check_failed";
    }
  }
  return "adapter_check_failed";
}
