import Fastify from "fastify";
import { mkdirSync } from "node:fs";
import {
  type ArtifactStore,
  EventBus,
  RunLauncherService,
  RunService,
  RuntimeRunnerService,
  type EventStore,
  type RunStore,
  type RegistryStore,
  type SessionStore
} from "@switchyard/core";
import { registerRegistryRoutes, registerRunRoutes } from "@switchyard/protocol-rest";
import { FakeRuntimeAdapter, InMemoryEventStore, InMemoryRunStore, InMemorySessionStore } from "@switchyard/testkit";
import {
  openSqliteStorage,
  SqliteArtifactStore,
  SqliteEventStore,
  SqliteRegistryStore,
  SqliteRunStore,
  SqliteSessionStore
} from "@switchyard/storage";
import { type DaemonConfig } from "./config.js";

interface DaemonStores {
  runs: RunStore;
  events: EventStore;
  sessions: SessionStore;
  artifacts: ArtifactStore;
  registry: RegistryStore;
}

type DaemonStoreResult = DaemonStores & { close?: () => void };

export async function createDaemonApp(config?: DaemonConfig) {
  const app = Fastify({ logger: false });
  const stores: DaemonStoreResult = config ? createStorageStores(config) : createInMemoryStores();
  const adapters = new Map([["fake", new FakeRuntimeAdapter()]]);
  const eventBus = new EventBus();
  const runner = new RuntimeRunnerService({
    adapters,
    eventBus,
    ...stores
  });
  const runService = new RunService({
    runs: stores.runs,
    events: stores.events,
    runner
  });
  const launcher = new RunLauncherService(runService);

  if (stores.close) {
    app.addHook("onClose", async () => {
      stores.close?.();
    });
  }

  await seedFakeRegistry(stores.registry);

  app.get("/health", async () => ({ ok: true }));
  registerRunRoutes(app, {
    ...stores,
    eventBus,
    launcher,
    runService
  });
  registerRegistryRoutes(app, { registry: stores.registry });

  return app;
}

function createInMemoryStores(): DaemonStores {
  return {
    runs: new InMemoryRunStore(),
    events: new InMemoryEventStore(),
    sessions: new InMemorySessionStore(),
    artifacts: new InMemoryArtifactStore(),
    registry: new InMemoryRegistryStore()
  };
}

function createStorageStores(config: DaemonConfig): DaemonStoreResult {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.artifactDir, { recursive: true });

  const storage = openSqliteStorage(config.sqlitePath);

  return {
    runs: new SqliteRunStore(storage.db),
    events: new SqliteEventStore(storage.db),
    sessions: new SqliteSessionStore(storage.db),
    artifacts: new SqliteArtifactStore(storage.db),
    registry: new SqliteRegistryStore(storage.db),
    close: () => {
      storage.sqlite.close();
    }
  };
}

async function seedFakeRegistry(registry: RegistryStore): Promise<void> {
  if (!(await registry.getProvider("provider_test"))) {
    await registry.createProvider({
      id: "provider_test",
      name: "Test Provider",
      authMode: "none",
      status: "available"
    });
  }
  if (!(await registry.getRuntime("runtime_fake"))) {
    await registry.createRuntime({
      id: "runtime_fake",
      name: "Fake Runtime",
      adapterType: "process",
      status: "available"
    });
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

class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts: Parameters<ArtifactStore["create"]>[0][] = [];

  async create(artifact: Parameters<ArtifactStore["create"]>[0]): Promise<Parameters<ArtifactStore["create"]>[0]> {
    this.artifacts.push(artifact);
    return artifact;
  }

  async get(id: string): Promise<Parameters<ArtifactStore["create"]>[0] | undefined> {
    return this.artifacts.find((artifact) => artifact.id === id);
  }

  async update(artifact: Parameters<ArtifactStore["create"]>[0]): Promise<Parameters<ArtifactStore["create"]>[0]> {
    const index = this.artifacts.findIndex((entry) => entry.id === artifact.id);
    if (index === -1) {
      this.artifacts.push(artifact);
    } else {
      this.artifacts[index] = artifact;
    }
    return artifact;
  }

  async listByRun(runId: string): Promise<Parameters<ArtifactStore["create"]>[0][]> {
    return this.artifacts.filter((artifact) => artifact.runId === runId);
  }
}

class InMemoryRegistryStore implements RegistryStore {
  private readonly providers = new Map<string, Parameters<RegistryStore["createProvider"]>[0]>();
  private readonly runtimes = new Map<string, Parameters<RegistryStore["createRuntime"]>[0]>();
  private readonly models = new Map<string, Parameters<RegistryStore["createModel"]>[0]>();

  async createProvider(
    provider: Parameters<RegistryStore["createProvider"]>[0]
  ): Promise<Parameters<RegistryStore["createProvider"]>[0]> {
    this.providers.set(provider.id, provider);
    return provider;
  }

  async createRuntime(
    runtime: Parameters<RegistryStore["createRuntime"]>[0]
  ): Promise<Parameters<RegistryStore["createRuntime"]>[0]> {
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }

  async createModel(
    model: Parameters<RegistryStore["createModel"]>[0]
  ): Promise<Parameters<RegistryStore["createModel"]>[0]> {
    this.models.set(model.id, model);
    return model;
  }

  async getProvider(id: string): Promise<Parameters<RegistryStore["createProvider"]>[0] | undefined> {
    return this.providers.get(id);
  }

  async getRuntime(id: string): Promise<Parameters<RegistryStore["createRuntime"]>[0] | undefined> {
    return this.runtimes.get(id);
  }

  async getModel(id: string): Promise<Parameters<RegistryStore["createModel"]>[0] | undefined> {
    return this.models.get(id);
  }
}
