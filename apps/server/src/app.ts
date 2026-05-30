import Fastify from "fastify";
import {
  ArtifactSyncService,
  EventBus,
  EventSyncService,
  HostedRunService,
  NodeCoordinatorService,
  PlacementService,
  RegistryService,
  RunService,
  RuntimeCapabilityService,
  RuntimeRunnerService,
  type ArtifactContentStore,
  type ArtifactStore,
  type EventStore,
  type NodeAssignmentStore,
  type NodeStore,
  type PlacementStore,
  type RegistryStore,
  type RunQueuePort,
  type RunStore,
  type SessionStore,
  type RuntimeAdapter
} from "@switchyard/core";
import {
  registerArtifactRoutes,
  registerErrorEnvelope,
  registerRegistryRoutes,
  registerRunRoutes
} from "@switchyard/protocol-rest";
import { registerNodeRoutes } from "@switchyard/protocol-node";
import { BullMqRunQueue, MemoryRunQueue } from "@switchyard/queue";
import {
  ensurePostgresSchema,
  LocalObjectArtifactContentStore,
  MemoryArtifactContentStore,
  PostgresAssignmentStore,
  PostgresArtifactStore,
  PostgresEventStore,
  PostgresNodeStore,
  PostgresPlacementStore,
  PostgresRegistryStore,
  PostgresRunStore,
  PostgresSessionStore,
  openPostgresDatabase
} from "@switchyard/storage";
import { FakeRuntimeAdapter } from "@switchyard/testkit";
import type { ServerConfig } from "./config.js";

export async function createServerApp(config: ServerConfig) {
  const app = Fastify({ logger: false });
  registerErrorEnvelope(app);

  const postgres = config.postgresUrl ? openPostgresDatabase(config.postgresUrl) : undefined;
  if (postgres) {
    await ensurePostgresSchema(postgres);
    app.addHook("onClose", async () => {
      await postgres.close();
    });
  }

  const queue: RunQueuePort & { close?: () => Promise<void> } = config.redisUrl
    ? new BullMqRunQueue({ redisUrl: config.redisUrl, queueName: config.queueName ?? "switchyard-hosted-runs" })
    : new MemoryRunQueue();
  app.addHook("onClose", async () => {
    await queue.close?.();
  });

  const runs: RunStore = new PostgresRunStore(postgres);
  const events: EventStore = new PostgresEventStore(postgres);
  const sessions: SessionStore = new PostgresSessionStore(postgres);
  const artifacts: ArtifactStore = new PostgresArtifactStore(postgres);
  const registry: RegistryStore = new PostgresRegistryStore(postgres);
  const eventBus = new EventBus();
  const placements: PlacementStore = new PostgresPlacementStore(postgres);
  const nodes: NodeStore = new PostgresNodeStore(postgres);
  const assignments: NodeAssignmentStore = new PostgresAssignmentStore(postgres);
  const artifactContent: ArtifactContentStore = config.objectStoreDir
    ? new LocalObjectArtifactContentStore(config.objectStoreDir)
    : new MemoryArtifactContentStore();

  const fakeAdapter = new FakeRuntimeAdapter();
  const adapters = new Map<string, RuntimeAdapter>([["fake", fakeAdapter]]);

  const runner = new RuntimeRunnerService({
    runs,
    events,
    sessions,
    adapters,
    artifacts,
    eventBus,
    artifactContent: {
      writeText: async (path, content) => {
        const stored = await artifactContent.writeText(path, content, { contentType: "application/x-ndjson" });
        return stored.path;
      }
    }
  });

  const runService = new RunService({ runs, events, runner });
  const registryService = new RegistryService({ registry });
  const capabilityService = new RuntimeCapabilityService({ registry });
  await seedFakeRegistry(registry);
  await capabilityService.seedManifests([fakeAdapter.manifest], {
    "fake.deterministic": {
      state: "available",
      canRun: true,
      installed: true,
      auth: "not_required",
      version: null,
      checkedAt: new Date().toISOString(),
      reasonCode: null,
      message: null
    }
  });

  const placementService = new PlacementService();
  const hostedRuns = new HostedRunService({
    runService,
    runs,
    events,
    placements,
    queue,
    assignments,
    placementService,
    hostedRuntimeAllowlist: config.hostedRuntimeAllowlist,
    listOnlineNodes: async () => nodes.list({ status: "online" }),
    waitForRun: async (runId) => {
      const claimed = await queue.claim();
      if (claimed && claimed.payload.runId === runId) {
        await runService.startRun(runId);
        await queue.ack(claimed.id);
      }
      const run = await runs.get(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      return run;
    }
  });

  const coordinator = new NodeCoordinatorService({
    nodes,
    assignments,
    runs
  });

  const eventSync = new EventSyncService({
    assignments,
    events,
    eventBus
  });

  const artifactSync = new ArtifactSyncService({
    assignments,
    artifacts,
    content: artifactContent
  });

  app.get("/health", async () => ({ ok: true }));

  registerRunRoutes(app, {
    runService,
    hostedRuns,
    runs,
    events,
    artifacts,
    eventBus,
    registry,
    registryService
  });

  registerArtifactRoutes(app, {
    artifacts,
    artifactContent
  });

  registerRegistryRoutes(app, {
    registry,
    doctor: {
      checkRuntimeMode: async (idOrSlug) => {
        const mode = await registry.getRuntimeMode(idOrSlug);
        if (!mode) {
          throw new Error(`Runtime mode not found: ${idOrSlug}`);
        }
        return {
          runtimeModeId: mode.id,
          runtimeMode: mode.slug,
          providerId: mode.providerId,
          runtimeId: mode.runtimeId,
          state: mode.availability.state,
          canRun: mode.availability.canRun,
          installed: mode.availability.installed,
          auth: mode.availability.auth,
          version: mode.availability.version,
          checkedAt: mode.availability.checkedAt,
          reasonCode: mode.availability.reasonCode,
          message: mode.availability.message,
          capabilities: mode.capabilities,
          limitations: mode.limitations,
          diagnostics: []
        };
      },
      summarize: async () => ({
        runtimeModes: (await registry.listRuntimeModes({ limit: 100 })).runtimeModes.map((mode) => ({
          runtimeModeId: mode.id,
          runtimeMode: mode.slug,
          state: mode.availability.state,
          canRun: mode.availability.canRun,
          checkedAt: mode.availability.checkedAt
        })),
        summary: {
          available: 1,
          installed: 0,
          partial: 0,
          unavailable: 0,
          unsupported: 0,
          unknown: 0
        }
      })
    },
    registryService
  });

  const nodeRouteDeps = {
    coordinator,
    eventSync,
    artifactSync
  } as const;
  registerNodeRoutes(app, config.nodeSharedToken
    ? { ...nodeRouteDeps, sharedToken: config.nodeSharedToken }
    : nodeRouteDeps);

  return app;
}

async function seedFakeRegistry(registry: RegistryStore): Promise<void> {
  if (!(await registry.getProvider("provider_test"))) {
    await registry.createProvider({ id: "provider_test", name: "Test Provider", authMode: "none", status: "available" });
  }
  if (!(await registry.getRuntime("runtime_fake"))) {
    await registry.createRuntime({ id: "runtime_fake", name: "Fake Runtime", adapterType: "process", status: "available" });
  }
  if (!(await registry.getModel("model_test"))) {
    await registry.createModel({
      id: "model_test",
      providerId: "provider_test",
      modelName: "test-model",
      supportsTools: false,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    });
  }
}
