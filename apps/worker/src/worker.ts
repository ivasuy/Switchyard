import {
  HostedWorkerService,
  HostedSandboxService,
  checkHostedSandboxReadiness,
  redactSecrets,
  RunService,
  RuntimeRunnerService,
  validateHostedRuntimeAllowlist,
  type ArtifactContentStore,
  type ArtifactStore,
  type EventStore,
  type RunQueuePort,
  type RunStore,
  type SessionStore
} from "@switchyard/core";
import { BullMqRunQueue, MemoryRunQueue } from "@switchyard/queue";
import {
  checkPostgresSchemaCompatibility,
  createArtifactContentStoreFromObjectConfig,
  ensurePostgresSchema,
  openPostgresDatabase,
  POSTGRES_SCHEMA_VERSION,
  PostgresArtifactStore,
  type PostgresDatabaseHandle,
  PostgresEventStore,
  type PostgresSchemaCompatibility,
  PostgresRunStore,
  PostgresSessionStore,
  probePostgresDatabase
} from "@switchyard/storage";
import { FakeHostedSandboxExecutor, InMemoryEventStore, InMemoryRunStore } from "@switchyard/testkit";
import type { WorkerConfig } from "./config.js";
import { buildHostedWorkerAdapters, checkConfiguredHostedAdapters, type HostedWorkerAdapterFactoryDeps } from "./hosted-runtime-adapters.js";

export interface WorkerReadinessReport {
  ok: boolean;
  reason?: string;
  checks?: {
    postgres?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    schema?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    queue?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    objectStore?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    hostedRuntimeGate?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    hostedRuntimeAdapters?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    sandbox?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
  };
}

export interface HostedWorkerApp {
  tick: () => Promise<boolean>;
  ready: (options?: { mode?: "full" | "claim" }) => Promise<WorkerReadinessReport>;
  stop: () => Promise<void>;
}

export function createHostedWorker(config: WorkerConfig, deps?: {
  queue?: MemoryRunQueue;
  runs?: InMemoryRunStore;
  events?: InMemoryEventStore;
  adapters?: HostedWorkerAdapterFactoryDeps;
  postgres?: PostgresDatabaseHandle;
  ensurePostgresSchema?: (handle: PostgresDatabaseHandle) => Promise<void>;
  probePostgres?: (handle: PostgresDatabaseHandle) => Promise<void>;
  checkSchemaCompatibility?: (handle: PostgresDatabaseHandle) => Promise<PostgresSchemaCompatibility>;
  checkConfiguredAdapters?: (
    config: WorkerConfig,
    adapterDeps: HostedWorkerAdapterFactoryDeps | undefined
  ) => Promise<{ ok: boolean; modes: Record<string, { ok: boolean; code?: string }> }>;
  artifactContent?: ArtifactContentStore & { probe: () => Promise<{ ok: true }> };
  now?: () => number;
  readinessTtlMs?: number;
}): HostedWorkerApp {
  const strictClaimReadiness =
    (config.deploymentMode === "staging" || config.deploymentMode === "production") &&
    (Boolean(config.postgresUrl) || Boolean(config.redisUrl));
  const now = deps?.now ?? (() => Date.now());
  const readinessTtlMs = deps?.readinessTtlMs ?? 5_000;
  const postgres = deps?.postgres ?? (config.postgresUrl ? openPostgresDatabase(config.postgresUrl) : undefined);
  let postgresReady: Promise<void> | undefined;
  if (postgres) {
    postgresReady = (deps?.ensurePostgresSchema ?? ensurePostgresSchema)(postgres);
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
    deps?.artifactContent ?? createArtifactContentStoreFromObjectConfig(config.objectStore);

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

  let cachedReadiness: { checkedAtMs: number; status: WorkerReadinessReport } | undefined;

  return {
    tick: async () => {
      if (strictClaimReadiness) {
        const claimGate = await runClaimReadiness();
        if (!claimGate.ok) {
          return false;
        }
      }
      return service.processNext();
    },
    ready: async (options) => {
      if (options?.mode === "claim") {
        return runClaimReadiness();
      }
      return runFullReadiness();
    },
    stop: async () => {
      await postgresReady;
      await queue.close?.();
      await postgres?.close();
    }
  };

  async function runClaimReadiness(): Promise<WorkerReadinessReport> {
    if (!strictClaimReadiness) {
      return { ok: true };
    }
    const timestamp = now();
    if (cachedReadiness && (timestamp - cachedReadiness.checkedAtMs) < readinessTtlMs) {
      return cachedReadiness.status;
    }
    const status = await runFullReadiness();
    cachedReadiness = { checkedAtMs: timestamp, status };
    return status;
  }

  async function runFullReadiness(): Promise<WorkerReadinessReport> {
    const checks: NonNullable<WorkerReadinessReport["checks"]> = {};
    const markFailure = (code: string): WorkerReadinessReport => ({ ok: false, reason: code, checks });

    try {
      try {
        await postgresReady;
        if (postgres) {
          await (deps?.probePostgres ?? probePostgresDatabase)(postgres);
          checks.postgres = { ok: true };

          const schemaCompatibility = await (deps?.checkSchemaCompatibility ?? checkPostgresSchemaCompatibility)(postgres);
          if (schemaCompatibility.ok) {
            checks.schema = {
              ok: true,
              code: schemaCompatibility.code,
              diagnostics: {
                version: schemaCompatibility.version,
                expectedVersion: POSTGRES_SCHEMA_VERSION
              }
            };
          } else {
            checks.schema = {
              ok: false,
              code: schemaCompatibility.code,
              diagnostics: redactSecrets({
                expectedVersion: POSTGRES_SCHEMA_VERSION,
                ...(typeof schemaCompatibility.version === "number" ? { version: schemaCompatibility.version } : {}),
                ...(schemaCompatibility.diagnostics ? schemaCompatibility.diagnostics : {})
              })
            };
            return markFailure(schemaCompatibility.code);
          }
        } else if (strictClaimReadiness) {
          checks.postgres = { ok: false, code: "postgres_unavailable" };
          checks.schema = { ok: false, code: "postgres_unavailable", diagnostics: { expectedVersion: POSTGRES_SCHEMA_VERSION } };
          return markFailure("postgres_unavailable");
        } else {
          checks.postgres = { ok: true };
        }
      } catch (error) {
        const code = normalizeReadinessCode(error, "postgres_unavailable");
        checks.postgres = { ok: false, code };
        if (strictClaimReadiness) {
          checks.schema = { ok: false, code: "postgres_unavailable", diagnostics: { expectedVersion: POSTGRES_SCHEMA_VERSION } };
        }
        return markFailure(code);
      }

      try {
        await queue.stats();
        checks.queue = { ok: true };
      } catch {
        checks.queue = { ok: false, code: "queue_unavailable" };
        return markFailure("queue_unavailable");
      }

      if (config.objectStore.probe !== "disabled") {
        try {
          await artifactContent.probe();
          checks.objectStore = { ok: true };
        } catch (error) {
          const code = normalizeReadinessCode(error, "object_store_unavailable");
          checks.objectStore = {
            ok: false,
            code,
            diagnostics: redactSecrets({
              backend: config.objectStore.backend,
              summary: config.objectStore.redactedSummary
            })
          };
          return markFailure(code);
        }
      } else {
        checks.objectStore = { ok: true };
      }

      const hasRealAllowlist = config.hostedRuntimeAllowlist.some((mode) => mode !== "fake.deterministic");
      if (!hasRealAllowlist) {
        checks.hostedRuntimeGate = { ok: true };
      } else if (config.hostedRealRuntimeExecution !== "enabled") {
        checks.hostedRuntimeGate = { ok: false, code: "hosted_real_runtime_disabled" };
        return markFailure("hosted_real_runtime_disabled");
      } else if (config.deploymentMode === "production") {
        checks.hostedRuntimeGate = { ok: false, code: "hosted_real_runtime_production_forbidden" };
        return markFailure("hosted_real_runtime_production_forbidden");
      } else {
        checks.hostedRuntimeGate = { ok: true };
      }

      const gateValidation = validateHostedRuntimeAllowlist({
        allowlist: config.hostedRuntimeAllowlist,
        deploymentMode: config.deploymentMode,
        realRuntimeExecution: config.hostedRealRuntimeExecution
      });
      if (!gateValidation.ok) {
        checks.hostedRuntimeGate = { ok: false, code: gateValidation.code };
        return markFailure(gateValidation.code);
      }

      const adapterCheck = await (deps?.checkConfiguredAdapters ?? checkConfiguredHostedAdapters)(config, deps?.adapters);
      checks.hostedRuntimeAdapters = adapterCheck.ok
        ? { ok: true, diagnostics: { modes: adapterCheck.modes } }
        : {
          ok: false,
          code: firstAdapterFailureCode(adapterCheck.modes),
          diagnostics: { modes: adapterCheck.modes }
        };
      if (!adapterCheck.ok) {
        return markFailure(firstAdapterFailureCode(adapterCheck.modes));
      }

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
        return markFailure(code);
      }
      checks.sandbox = { ok: true };

      return { ok: true, checks };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        checks
      };
    }
  }
}

function firstAdapterFailureCode(modes: Record<string, { ok: boolean; code?: string }>): string {
  for (const entry of Object.values(modes)) {
    if (!entry.ok) {
      return entry.code ?? "adapter_check_failed";
    }
  }
  return "adapter_check_failed";
}

function normalizeReadinessCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.startsWith("postgres_") ||
    message.startsWith("queue_") ||
    message.startsWith("object_store_") ||
    message.startsWith("artifact_") ||
    message.startsWith("sandbox_")
  ) {
    return message;
  }
  return fallback;
}
