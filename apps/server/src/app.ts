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
  type RuntimeAdapter
} from "@switchyard/core";
import {
  registerArtifactRoutes,
  registerErrorEnvelope,
  registerRegistryRoutes,
  registerRunRoutes
} from "@switchyard/protocol-rest";
import { registerNodeRoutes } from "@switchyard/protocol-node";
import { MemoryRunQueue } from "@switchyard/queue";
import {
  MemoryArtifactContentStore,
  PostgresAssignmentStore,
  PostgresNodeStore
} from "@switchyard/storage";
import {
  FakeRuntimeAdapter,
  InMemoryArtifactStore,
  InMemoryEventStore,
  InMemoryRegistryStore,
  InMemoryRunStore,
  InMemorySessionStore
} from "@switchyard/testkit";
import type { ServerConfig } from "./config.js";

export async function createServerApp(config: ServerConfig) {
  const app = Fastify({ logger: false });
  registerErrorEnvelope(app);

  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const sessions = new InMemorySessionStore();
  const artifacts = new InMemoryArtifactStore();
  const registry = new InMemoryRegistryStore();
  const queue = new MemoryRunQueue();
  const eventBus = new EventBus();
  const nodes = new PostgresNodeStore();
  const assignments = new PostgresAssignmentStore();
  const artifactContent = new MemoryArtifactContentStore();

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
    placements: {
      async create(record) { return record; },
      async get() { return undefined; },
      async update(record) { return record; },
      async listByRun() { return []; }
    },
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

async function seedFakeRegistry(registry: InMemoryRegistryStore): Promise<void> {
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
