import Fastify from "fastify";
import { mkdirSync } from "node:fs";
import {
  EventBus,
  RunLauncherService,
  RunService,
  RuntimeRunnerService,
  type ArtifactStore,
  type EventStore,
  type RunStore,
  type SessionStore
} from "@switchyard/core";
import { registerRunRoutes } from "@switchyard/protocol-rest";
import { FakeRuntimeAdapter, InMemoryEventStore, InMemoryRunStore, InMemorySessionStore } from "@switchyard/testkit";
import {
  FilesystemArtifactContentStore,
  openSqliteStorage,
  SqliteArtifactStore,
  SqliteEventStore,
  SqliteRunStore,
  SqliteSessionStore
} from "@switchyard/storage";
import { type DaemonConfig } from "./config.js";

interface DaemonStores {
  runs: RunStore;
  events: EventStore;
  sessions: SessionStore;
  artifacts: ArtifactStore;
}

type DaemonStoreResult = DaemonStores & { close?: () => void };

export function createDaemonApp(config?: DaemonConfig) {
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

  app.get("/health", async () => ({ ok: true }));
  registerRunRoutes(app, {
    ...stores,
    eventBus,
    launcher,
    runService
  });

  return app;
}

function createInMemoryStores(): DaemonStores {
  return {
    runs: new InMemoryRunStore(),
    events: new InMemoryEventStore(),
    sessions: new InMemorySessionStore(),
    artifacts: new InMemoryArtifactStore()
  };
}

function createStorageStores(config: DaemonConfig): DaemonStoreResult {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.artifactDir, { recursive: true });

  const storage = openSqliteStorage(config.sqlitePath);
  // Initialize filesystem artifact content root to ensure directory exists before artifacts are persisted.
  new FilesystemArtifactContentStore(config.artifactDir);

  return {
    runs: new SqliteRunStore(storage.db),
    events: new SqliteEventStore(storage.db),
    sessions: new SqliteSessionStore(storage.db),
    artifacts: new SqliteArtifactStore(storage.db),
    close: () => {
      storage.sqlite.close();
    }
  };
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
