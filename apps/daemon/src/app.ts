import Fastify from "fastify";
import { mkdirSync } from "node:fs";
import {
  CodexExecJsonAdapter,
  GenericHttpAsyncRestAdapter,
  OpenCodeAcpAdapter,
  probeCodexCatalog
} from "@switchyard/adapters";
import {
  type ArtifactStore,
  EventBus,
  RegistryService,
  RuntimeCapabilityService,
  type RuntimeAdapter,
  RuntimeDoctorService,
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
type DaemonRuntimeAvailability = {
  state: "available" | "partial" | "unavailable" | "unknown" | "unsupported" | "installed";
  canRun: boolean;
  installed: boolean;
  auth: "configured" | "missing" | "not_required" | "unknown";
  version: string | null;
  checkedAt: string;
  reasonCode: string | null;
  message: string | null;
};

interface CreateDaemonAppOptions {
  codexProbe?: CodexCatalogProbe;
  probeCodexCatalog?: () => Promise<CodexCatalogProbe>;
  opencodeProcessFactory?: NonNullable<ConstructorParameters<typeof OpenCodeAcpAdapter>[0]>["processFactory"];
  opencodeProbeVersion?: NonNullable<ConstructorParameters<typeof OpenCodeAcpAdapter>[0]>["probeVersion"];
  logger?: RuntimeLogger | undefined;
  checkTimeoutMs?: number;
  maxDiagnosticBytes?: number;
}

export async function createDaemonApp(config?: DaemonConfig, options: CreateDaemonAppOptions = {}) {
  const app = Fastify({ logger: false });
  const stores: DaemonStoreResult = config ? createStorageStores(config) : createInMemoryStores();
  const checkTimeoutMs = options.checkTimeoutMs ?? 5000;
  const maxDiagnosticBytes = options.maxDiagnosticBytes ?? 4096;
  const genericHttpConfig = config?.genericHttp ?? {
    requestTimeoutMs: 5000,
    pollIntervalMs: 100,
    maxResponseBytes: 1024 * 1024
  };
  const opencodeConfig = config?.opencode ?? {
    command: "opencode"
  };
  const acpConfig = config?.acp ?? {
    requestTimeoutMs: 5000,
    cancelTimeoutMs: 5000,
    maxMessageBytes: 1024 * 1024
  };
  const codexProbe = await loadCodexProbe(options, checkTimeoutMs, maxDiagnosticBytes);
  const now = new Date().toISOString();
  const codexAvailability = availabilityFromProbe(codexProbe, now, maxDiagnosticBytes);
  const genericHttpAvailability = initialGenericHttpAvailability(genericHttpConfig, now);
  const opencodeAvailability: DaemonRuntimeAvailability = {
    state: "unknown",
    canRun: false,
    installed: false,
    auth: "unknown",
    version: null,
    checkedAt: now,
    reasonCode: "not_checked",
    message: "Run POST /runtime-modes/opencode.acp/check to verify local OpenCode ACP availability."
  };
  const fakeAvailability: DaemonRuntimeAvailability = {
    state: "available",
    canRun: true,
    installed: true,
    auth: "not_required",
    version: null,
    checkedAt: now,
    reasonCode: null,
    message: null
  };
  reconcileInterruptedRuns(stores, options.logger);
  const codexOptions: ConstructorParameters<typeof CodexExecJsonAdapter>[0] = {
    modelCatalog: codexProbe.models
  };
  if (options.probeCodexCatalog) {
    codexOptions.probeCatalog = options.probeCodexCatalog;
  }
  if (options.logger) {
    codexOptions.logger = options.logger;
  }
  const genericHttpAdapterOptions: ConstructorParameters<typeof GenericHttpAsyncRestAdapter>[0] = {
    ...(genericHttpConfig.baseUrl ? { baseUrl: genericHttpConfig.baseUrl } : {}),
    ...(genericHttpConfig.authToken ? { authToken: genericHttpConfig.authToken } : {}),
    requestTimeoutMs: genericHttpConfig.requestTimeoutMs,
    pollIntervalMs: genericHttpConfig.pollIntervalMs,
    maxResponseBytes: genericHttpConfig.maxResponseBytes,
    ...(options.logger ? { logger: options.logger } : {})
  };
  const genericHttpAdapter = new GenericHttpAsyncRestAdapter(genericHttpAdapterOptions);
  const opencodeAdapterOptions: ConstructorParameters<typeof OpenCodeAcpAdapter>[0] = {
    command: opencodeConfig.command,
    requestTimeoutMs: acpConfig.requestTimeoutMs,
    cancelTimeoutMs: acpConfig.cancelTimeoutMs,
    maxMessageBytes: acpConfig.maxMessageBytes
  };
  if (options.logger) {
    opencodeAdapterOptions.logger = options.logger;
  }
  if (options.opencodeProcessFactory) {
    opencodeAdapterOptions.processFactory = options.opencodeProcessFactory;
  }
  if (options.opencodeProbeVersion) {
    opencodeAdapterOptions.probeVersion = options.opencodeProbeVersion;
  }
  const opencodeAdapter = new OpenCodeAcpAdapter(opencodeAdapterOptions);
  const adapters = new Map<string, RuntimeAdapter>([
    ["fake", new FakeRuntimeAdapter()],
    ["codex", new CodexExecJsonAdapter(codexOptions)],
    ["generic_http", genericHttpAdapter],
    ["opencode", opencodeAdapter]
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
  const registryService = new RegistryService({ registry: stores.registry });
  const capabilityService = new RuntimeCapabilityService({
    registry: stores.registry
  });
  const doctorService = new RuntimeDoctorService({
    registry: stores.registry,
    adapters,
    logger: options.logger,
    checkTimeoutMs,
    maxDiagnosticBytes
  });

  try {
    await seedFakeRegistry(stores.registry);
    await seedCodexRegistry(stores, codexProbe, codexAvailability);
    await seedGenericHttpRegistry(stores, genericHttpAvailability);
    await seedOpenCodeRegistry(stores, opencodeAvailability);
    await capabilityService.seedManifests(
      [
        adapters.get("fake")!.manifest,
        adapters.get("codex")!.manifest,
        adapters.get("generic_http")!.manifest,
        adapters.get("opencode")!.manifest
      ],
      {
        "fake.deterministic": fakeAvailability,
        "codex.exec_json": codexAvailability,
        "generic_http.async_rest": genericHttpAvailability,
        "opencode.acp": opencodeAvailability
      }
    );
    options.logger?.info("runtime_mode.seeded", {
      runtimeMode: "fake.deterministic",
      adapterId: "fake",
      state: fakeAvailability.state
    });
    options.logger?.info("runtime_mode.seeded", {
      runtimeMode: "codex.exec_json",
      adapterId: "codex",
      state: codexAvailability.state
    });
    options.logger?.info("runtime_mode.seeded", {
      runtimeMode: "generic_http.async_rest",
      adapterId: "generic_http",
      state: genericHttpAvailability.state
    });
    options.logger?.info("runtime_mode.seeded", {
      runtimeMode: "opencode.acp",
      adapterId: "opencode",
      state: opencodeAvailability.state
    });
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
    runService,
    registry: stores.registry,
    registryService
  });
  registerRegistryRoutes(app, {
    registry: stores.registry,
    doctor: doctorService,
    registryService
  });
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
  codexProbe: CodexCatalogProbe,
  codexAvailability: DaemonRuntimeAvailability
): Promise<void> {
  const registry = stores.registry;
  const status = codexAvailability.state === "unknown"
    ? "unknown"
    : codexAvailability.canRun
      ? "available"
      : "unavailable";

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

async function seedGenericHttpRegistry(
  stores: DaemonStoreResult,
  availability: DaemonRuntimeAvailability
): Promise<void> {
  const registry = stores.registry;
  const status = statusFromAvailability(availability);

  const existingProvider = await registry.getProvider("provider_generic_http");
  if (!existingProvider) {
    await registry.createProvider({
      id: "provider_generic_http",
      name: "Generic HTTP",
      authMode: "custom",
      status
    });
  } else {
    await updateProviderRecord(stores, {
      id: "provider_generic_http",
      name: "Generic HTTP",
      authMode: "custom",
      status
    });
  }

  const existingRuntime = await registry.getRuntime("runtime_generic_http");
  if (!existingRuntime) {
    await registry.createRuntime({
      id: "runtime_generic_http",
      name: "Generic HTTP",
      adapterType: "http",
      status,
      providerId: "provider_generic_http"
    });
  } else {
    await updateRuntimeRecord(stores, {
      id: "runtime_generic_http",
      name: "Generic HTTP",
      adapterType: "http",
      status,
      providerId: "provider_generic_http"
    });
  }

  if (!(await registry.getModel("model_generic_http_default"))) {
    await registry.createModel({
      id: "model_generic_http_default",
      providerId: "provider_generic_http",
      modelName: "generic-http-default",
      supportsTools: false,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    });
  }
}

async function seedOpenCodeRegistry(
  stores: DaemonStoreResult,
  availability: DaemonRuntimeAvailability
): Promise<void> {
  const registry = stores.registry;
  const status = statusFromAvailability(availability);

  const existingProvider = await registry.getProvider("provider_opencode");
  if (!existingProvider) {
    await registry.createProvider({
      id: "provider_opencode",
      name: "OpenCode",
      authMode: "local",
      status
    });
  } else {
    await updateProviderRecord(stores, {
      id: "provider_opencode",
      name: "OpenCode",
      authMode: "local",
      status
    });
  }

  const existingRuntime = await registry.getRuntime("runtime_opencode");
  if (!existingRuntime) {
    await registry.createRuntime({
      id: "runtime_opencode",
      name: "OpenCode",
      adapterType: "acpx",
      status,
      providerId: "provider_opencode"
    });
  } else {
    await updateRuntimeRecord(stores, {
      id: "runtime_opencode",
      name: "OpenCode",
      adapterType: "acpx",
      status,
      providerId: "provider_opencode"
    });
  }

  if (!(await registry.getModel("model_opencode_default"))) {
    await registry.createModel({
      id: "model_opencode_default",
      providerId: "provider_opencode",
      modelName: "opencode-default",
      supportsTools: true,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    });
  }
}

async function loadCodexProbe(
  options: CreateDaemonAppOptions,
  timeoutMs: number,
  maxDiagnosticBytes: number
): Promise<CodexCatalogProbe> {
  if (options.codexProbe) {
    return options.codexProbe;
  }
  const probe = options.probeCodexCatalog ?? (() => probeCodexCatalog("codex", { timeoutMs, maxBufferBytes: maxDiagnosticBytes }));
  try {
    return await runWithTimeout(probe(), timeoutMs);
  } catch (error) {
    const reasonCode = error instanceof ProbeTimeoutError ? "check_timeout" : "binary_unavailable";
    return {
      ok: false,
      models: [],
      reasonCode,
      message: sanitizeMessage(error instanceof Error ? error.message : String(error), maxDiagnosticBytes)
    };
  }
}

function availabilityFromProbe(
  probe: CodexCatalogProbe,
  checkedAt: string,
  maxDiagnosticBytes: number
): DaemonRuntimeAvailability {
  if (!probe.ok) {
    const reasonCode = probe.reasonCode === "check_timeout" || probe.reasonCode === "check_output_too_large"
      ? probe.reasonCode
      : "binary_unavailable";
    return {
      state: reasonCode === "check_timeout" || reasonCode === "check_output_too_large" ? "unknown" : "unavailable",
      canRun: false,
      installed: false,
      auth: "unknown",
      version: probe.version ?? null,
      checkedAt,
      reasonCode,
      message: probe.message ? sanitizeMessage(probe.message, maxDiagnosticBytes) : null
    };
  }

  const version = probe.version ?? null;
  if (probe.models.length === 0) {
    return {
      state: "unavailable",
      canRun: false,
      installed: true,
      auth: "configured",
      version,
      checkedAt,
      reasonCode: "model_catalog_unavailable",
      message: probe.message ? sanitizeMessage(probe.message, maxDiagnosticBytes) : "No model catalog entries were returned."
    };
  }

  const optionalFailure = Object.values(probe.optionalChecks ?? {}).find((check) => check.ok === false);
  if (optionalFailure) {
    return {
      state: "partial",
      canRun: true,
      installed: true,
      auth: "configured",
      version,
      checkedAt,
      reasonCode: "optional_check_failed",
      message: optionalFailure.message
        ? sanitizeMessage(optionalFailure.message, maxDiagnosticBytes)
        : "Optional runtime checks failed."
    };
  }

  return {
    state: "available",
    canRun: true,
    installed: true,
    auth: "configured",
    version,
    checkedAt,
    reasonCode: null,
    message: null
  };
}

class ProbeTimeoutError extends Error {}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProbeTimeoutError("codex probe timed out"));
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function sanitizeMessage(message: string, maxBytes: number): string {
  if (Buffer.byteLength(message, "utf8") <= maxBytes) {
    return message;
  }
  return `${message.slice(0, Math.max(1, maxBytes - 3))}...`;
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
      .prepare("UPDATE runtimes SET name = ?, adapter_type = ?, provider_id = ?, status = ? WHERE id = ?")
      .run(runtime.name, runtime.adapterType, runtime.providerId ?? null, runtime.status, runtime.id);
    return;
  }
  await stores.registry.createRuntime(runtime);
}

function initialGenericHttpAvailability(
  config: {
    baseUrl?: string;
    authToken?: string;
  },
  checkedAt: string
): DaemonRuntimeAvailability {
  if (!config.baseUrl) {
    return {
      state: "unavailable",
      canRun: false,
      installed: false,
      auth: "unknown",
      version: null,
      checkedAt,
      reasonCode: "generic_http_config_missing",
      message: "SWITCHYARD_GENERIC_HTTP_BASE_URL is not configured."
    };
  }
  if (!isValidHttpUrl(config.baseUrl)) {
    return {
      state: "unavailable",
      canRun: false,
      installed: false,
      auth: "unknown",
      version: null,
      checkedAt,
      reasonCode: "generic_http_config_invalid",
      message: "SWITCHYARD_GENERIC_HTTP_BASE_URL must use http or https."
    };
  }
  return {
    state: "unknown",
    canRun: false,
    installed: true,
    auth: config.authToken ? "configured" : "not_required",
    version: null,
    checkedAt,
    reasonCode: null,
    message: null
  };
}

function statusFromAvailability(
  availability: DaemonRuntimeAvailability
): "available" | "unavailable" | "unknown" {
  if (availability.state === "available" || availability.state === "partial") {
    return "available";
  }
  if (availability.state === "unknown") {
    return "unknown";
  }
  return "unavailable";
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
