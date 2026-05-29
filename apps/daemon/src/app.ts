import Fastify from "fastify";
import { mkdirSync } from "node:fs";
import { CodexExecJsonAdapter, probeCodexCatalog } from "@switchyard/adapters";
import {
  type ArtifactStore,
  EventBus,
  type RuntimeAdapter,
  type RuntimeLogger,
  RunLauncherService,
  RunService,
  RuntimeRunnerService,
  type EventStore,
  type RunStore,
  type RegistryStore,
  type SessionStore
} from "@switchyard/core";
import {
  contentTypeForArtifact,
  registerArtifactRoutes,
  registerErrorEnvelope,
  registerRegistryRoutes,
  registerRunRoutes,
  type ArtifactContentReader
} from "@switchyard/protocol-rest";
import {
  FakeRuntimeAdapter,
  InMemoryArtifactStore,
  InMemoryEventStore,
  InMemoryRegistryStore,
  InMemoryRunStore,
  InMemorySessionStore
} from "@switchyard/testkit";
import {
  openSqliteStorage,
  SqliteArtifactStore,
  SqliteEventStore,
  SqliteRegistryStore,
  SqliteRunStore,
  SqliteSessionStore,
  FilesystemArtifactContentStore
} from "@switchyard/storage";
import { type DaemonConfig } from "./config.js";

interface DaemonStores {
  runs: RunStore;
  events: EventStore;
  sessions: SessionStore;
  artifacts: ArtifactStore;
  registry: RegistryStore;
  artifactContent?: {
    writeText(path: string, content: string): Promise<string>;
    readBuffer?(path: string): Promise<Buffer>;
  };
}

type DaemonStoreResult = DaemonStores & {
  close?: () => void;
  sqlite?: {
    prepare(sql: string): {
      all(...params: unknown[]): Array<Record<string, unknown>>;
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): unknown;
    };
  };
};

type CodexCatalogProbe = Awaited<ReturnType<typeof probeCodexCatalog>>;

interface CreateDaemonAppOptions {
  codexProbe?: CodexCatalogProbe;
  probeCodexCatalog?: () => Promise<CodexCatalogProbe>;
  logger?: RuntimeLogger | undefined;
}

export async function createDaemonApp(config?: DaemonConfig, options: CreateDaemonAppOptions = {}) {
  const app = Fastify({ logger: false });
  const stores: DaemonStoreResult = config ? createStorageStores(config) : createInMemoryStores();
  const codexProbe = options.codexProbe ?? (await (options.probeCodexCatalog ?? probeCodexCatalog)());
  reconcileInterruptedRuns(stores, options.logger);
  const codexOptions: ConstructorParameters<typeof CodexExecJsonAdapter>[0] = {
    modelCatalog: codexProbe.models
  };
  if (options.logger) {
    codexOptions.logger = options.logger;
  }
  const adapters = new Map<string, RuntimeAdapter>([
    ["fake", new FakeRuntimeAdapter()],
    ["codex", new CodexExecJsonAdapter(codexOptions)]
  ]);
  const eventBus = new EventBus();
  const runnerOptions: ConstructorParameters<typeof RuntimeRunnerService>[0] = {
    adapters,
    eventBus,
    ...stores
  };
  if (options.logger) {
    runnerOptions.logger = options.logger;
  }
  const runner = new RuntimeRunnerService(runnerOptions);
  const runService = new RunService({
    runs: stores.runs,
    events: stores.events,
    runner
  });
  const launcher = new RunLauncherService(runService);

  try {
    await seedFakeRegistry(stores.registry);
    await seedCodexRegistry(stores, codexProbe);
  } catch (error) {
    stores.close?.();
    throw error;
  }

  if (stores.close) {
    app.addHook("onClose", async () => {
      stores.close?.();
    });
  }

  registerErrorEnvelope(app);

  app.get("/health", async () => ({ ok: true }));
  registerRunRoutes(app, {
    ...stores,
    eventBus,
    launcher,
    runService
  });
  registerRegistryRoutes(app, { registry: stores.registry });
  const reader = buildArtifactContentReader(stores.artifactContent);
  registerArtifactRoutes(app, {
    artifacts: stores.artifacts,
    artifactContent: reader ?? unavailableContentReader
  });

  return app;
}

const unavailableContentReader: ArtifactContentReader = {
  async read() {
    const error = new Error("Artifact content store not configured for this daemon instance");
    (error as Error & { code?: string }).code = "ENOENT";
    throw error;
  }
};

function buildArtifactContentReader(
  store: DaemonStores["artifactContent"]
): ArtifactContentReader | undefined {
  if (!store || typeof store.readBuffer !== "function") {
    return undefined;
  }
  const reader = store.readBuffer.bind(store);
  return {
    async read(artifact) {
      const body = await reader(artifact.path);
      return { body, contentType: contentTypeForArtifact(artifact.type) };
    }
  };
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
  const artifactContent = new FilesystemArtifactContentStore(config.artifactDir);

  return {
    runs: new SqliteRunStore(storage.db),
    events: new SqliteEventStore(storage.db),
    sessions: new SqliteSessionStore(storage.db),
    artifacts: new SqliteArtifactStore(storage.db),
    registry: new SqliteRegistryStore(storage.db),
    artifactContent,
    sqlite: storage.sqlite,
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

function reconcileInterruptedRuns(stores: DaemonStoreResult, logger?: RuntimeLogger): void {
  if (!stores.sqlite) {
    return;
  }

  const staleRuns = stores.sqlite
    .prepare("SELECT id FROM runs WHERE status = 'running'")
    .all();

  for (const staleRun of staleRuns) {
    const runId = typeof staleRun["id"] === "string" ? staleRun["id"] : undefined;
    if (!runId) {
      continue;
    }

    const endedAt = new Date().toISOString();
    const sequenceRow = stores.sqlite
      .prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM run_events WHERE run_id = ?")
      .get(runId);
    const sequence = typeof sequenceRow?.["sequence"] === "number" ? sequenceRow["sequence"] : 0;

    stores.sqlite
      .prepare("UPDATE runs SET status = 'failed', ended_at = ? WHERE id = ? AND status = 'running'")
      .run(endedAt, runId);
    stores.sqlite
      .prepare("UPDATE runtime_sessions SET status = 'failed', updated_at = ? WHERE run_id = ? AND status = 'active'")
      .run(endedAt, runId);
    stores.sqlite
      .prepare(
        "INSERT INTO run_events (id, type, run_id, sequence, payload_json, created_at) VALUES (?, 'run.failed', ?, ?, ?, ?)"
      )
      .run(
        `event_${crypto.randomUUID()}`,
        runId,
        sequence,
        JSON.stringify({ status: "failed", error: "daemon_restarted" }),
        endedAt
      );
    logger?.warn("run.reconciled_interrupted", { runId });
  }
}

async function seedCodexRegistry(
  stores: DaemonStoreResult,
  codexProbe: CodexCatalogProbe
): Promise<void> {
  const registry = stores.registry;
  const status = codexProbe.ok ? "available" : "unavailable";

  const existingProvider = await registry.getProvider("provider_openai");
  if (!existingProvider) {
    await registry.createProvider({
      id: "provider_openai",
      name: "OpenAI",
      authMode: "local",
      status
    });
  } else {
    await updateProviderRecord(stores, {
      id: "provider_openai",
      name: "OpenAI",
      authMode: "local",
      status
    });
  }

  const existingRuntime = await registry.getRuntime("runtime_codex");
  if (!existingRuntime) {
    await registry.createRuntime({
      id: "runtime_codex",
      name: "Codex",
      adapterType: "process",
      status
    });
  } else {
    await updateRuntimeRecord(stores, {
      id: "runtime_codex",
      name: "Codex",
      adapterType: "process",
      status
    });
  }

  for (const model of codexProbe.models) {
    const id = toCodexModelId(model.slug);
    if (await registry.getModel(id)) {
      continue;
    }
    await registry.createModel({
      id,
      providerId: "provider_openai",
      modelName: model.slug,
      supportsTools: true,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    });
  }
}

function toCodexModelId(slug: string): string {
  return `model_${slug.replace(/[.-]/g, "_")}`;
}

async function updateProviderRecord(
  stores: DaemonStoreResult,
  provider: Parameters<RegistryStore["createProvider"]>[0]
): Promise<void> {
  if (stores.sqlite) {
    stores.sqlite
      .prepare("UPDATE providers SET name = ?, auth_mode = ?, status = ? WHERE id = ?")
      .run(provider.name, provider.authMode, provider.status, provider.id);
    return;
  }
  await stores.registry.createProvider(provider);
}

async function updateRuntimeRecord(
  stores: DaemonStoreResult,
  runtime: Parameters<RegistryStore["createRuntime"]>[0]
): Promise<void> {
  if (stores.sqlite) {
    stores.sqlite
      .prepare("UPDATE runtimes SET name = ?, adapter_type = ?, status = ? WHERE id = ?")
      .run(runtime.name, runtime.adapterType, runtime.status, runtime.id);
    return;
  }
  await stores.registry.createRuntime(runtime);
}

