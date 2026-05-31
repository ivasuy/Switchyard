import Fastify from "fastify";
import {
  ArtifactSyncService,
  ControlPlaneError,
  ControlPlaneService,
  EventBus,
  EventSyncService,
  HOSTED_RUNTIME_CATALOG,
  HostedRunService,
  HostedSandboxService,
  NodeCoordinatorService,
  PlacementService,
  RegistryService,
  RunService,
  RuntimeCapabilityService,
  RuntimeRunnerService,
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
  registerEnterpriseRoutes,
  registerErrorEnvelope,
  registerHostedAuthHooks,
  registerRegistryRoutes,
  registerRunRoutes,
  sendHttpError
} from "@switchyard/protocol-rest";
import { registerNodeRoutes, type NodeTokenBinding } from "@switchyard/protocol-node";
import { BullMqRunQueue, MemoryRunQueue } from "@switchyard/queue";
import {
  createArtifactContentStoreFromObjectConfig,
  type ProbeableArtifactContentStore,
  ensurePostgresSchema,
  PostgresAssignmentStore,
  PostgresArtifactStore,
  PostgresEventStore,
  PostgresNodeStore,
  PostgresPlacementStore,
  PostgresRegistryStore,
  PostgresRunStore,
  PostgresSessionStore,
  PostgresControlPlaneStore,
  openPostgresDatabase
} from "@switchyard/storage";
import { FakeHostedSandboxExecutor, FakeRuntimeAdapter } from "@switchyard/testkit";
import { ConfigError, type ControlPlaneBootstrapConfig, type ServerConfig } from "./config.js";
import { HostedMetrics } from "./metrics.js";
import { probeServerReadiness } from "./readiness.js";

export async function createServerApp(config: ServerConfig) {
  const serverAuthMode = config.serverAuthMode ?? "disabled";
  const controlPlaneStore = config.controlPlaneStore ?? "memory";
  const publicMetrics = typeof config.publicMetrics === "boolean"
    ? config.publicMetrics
    : (config.deploymentMode === "local" || config.deploymentMode === "test");
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  registerErrorEnvelope(app);
  const metrics = new HostedMetrics();

  app.addHook("onRequest", async () => {
    metrics.inc("requests.total");
  });

  const postgres = config.postgresUrl ? openPostgresDatabase(config.postgresUrl) : undefined;
  if (postgres) {
    await ensurePostgresSchema(postgres);
    app.addHook("onClose", async () => {
      await postgres.close();
    });
  }

  const forcePersistent = config.deploymentMode === "staging" || config.deploymentMode === "production";
  const rawQueue: RunQueuePort & { close?: () => Promise<void> } = config.redisUrl
    ? new BullMqRunQueue({ redisUrl: config.redisUrl, queueName: config.queueName ?? "switchyard-hosted-runs" })
    : forcePersistent
      ? (() => {
        throw new Error("config_required:SWITCHYARD_REDIS_URL");
      })()
      : new MemoryRunQueue();
  const queue = instrumentQueue(rawQueue, metrics);
  app.addHook("onClose", async () => {
    await queue.close?.();
  });

  let controlPlaneStoreInstance: PostgresControlPlaneStore | undefined;
  let controlPlane: ControlPlaneService | undefined;
  let bootstrapActiveCounts: ControlPlaneBootstrapConfig["active"] | undefined;
  let nodeTokenBindings: readonly NodeTokenBinding[] = [];
  if (serverAuthMode === "api_key") {
    if (!config.apiKeyPepper) {
      throw new ConfigError("config_required:SWITCHYARD_API_KEY_PEPPER", "SWITCHYARD_API_KEY_PEPPER", config.redactedSummary);
    }
    if (!config.controlPlaneBootstrap) {
      throw new ConfigError(
        "control_plane_bootstrap_missing",
        "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH",
        config.redactedSummary
      );
    }
    if (controlPlaneStore === "postgres" && !postgres) {
      throw new ConfigError("config_required:SWITCHYARD_POSTGRES_URL", "SWITCHYARD_POSTGRES_URL", config.redactedSummary);
    }
    controlPlaneStoreInstance = new PostgresControlPlaneStore(controlPlaneStore === "postgres" ? postgres : undefined);
    try {
      const summary = await controlPlaneStoreInstance.bootstrap(config.controlPlaneBootstrap.records);
      bootstrapActiveCounts = summary.active;
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : "control_plane_bootstrap_malformed";
      throw new ConfigError(code, "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", config.redactedSummary);
    }

    controlPlane = new ControlPlaneService({
      store: controlPlaneStoreInstance,
      apiKeyPepper: config.apiKeyPepper
    });
    nodeTokenBindings = buildNodeTokenBindings(config.controlPlaneBootstrap);

    if (
      (config.deploymentMode === "staging" || config.deploymentMode === "production") &&
      config.nodeSharedToken &&
      !nodeTokenBindings.some((entry) => tokenMatches(entry.token, config.nodeSharedToken!))
    ) {
      throw new ConfigError("control_plane_bootstrap_node_token_unbound", "SWITCHYARD_NODE_SHARED_TOKEN", config.redactedSummary);
    }
  }

  const runs: RunStore = new PostgresRunStore(postgres);
  const events: EventStore = new PostgresEventStore(postgres);
  const sessions: SessionStore = new PostgresSessionStore(postgres);
  const artifacts: ArtifactStore = new PostgresArtifactStore(postgres);
  const registry: RegistryStore = new PostgresRegistryStore(postgres);
  const eventBus = new EventBus();
  const placements: PlacementStore = new PostgresPlacementStore(postgres);
  const nodes: NodeStore = new PostgresNodeStore(postgres);
  const assignments: NodeAssignmentStore = new PostgresAssignmentStore(postgres);
  const artifactContent = instrumentArtifactContent(
    createArtifactContentStoreFromObjectConfig(config.objectStore),
    metrics
  );

  const fakeAdapter = new FakeRuntimeAdapter();
  const _hostedSandbox = new HostedSandboxService({
    config: config.sandbox,
    executor: new FakeHostedSandboxExecutor(),
    metrics,
    logger: {
      info: (_event, _details) => {},
      warn: (_event, _details) => {},
      error: (_event, _details) => {}
    }
  });
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
        return artifactContent.writeText(path, content, { contentType: "application/x-ndjson" });
      }
    }
  });

  const runService = new RunService({ runs, events, runner });
  const registryService = new RegistryService({ registry });
  const capabilityService = new RuntimeCapabilityService({ registry });
  await seedHostedRegistryRecords(registry);
  const catalogManifests = Object.values(HOSTED_RUNTIME_CATALOG).map((entry) => entry.manifest);
  await capabilityService.seedManifests(catalogManifests, {
    "fake.deterministic": {
      state: "available",
      canRun: true,
      installed: true,
      auth: "not_required",
      version: null,
      checkedAt: new Date().toISOString(),
      reasonCode: null,
      message: null
    },
    "codex.exec_json": {
      state: "installed",
      canRun: false,
      installed: true,
      auth: "missing",
      version: null,
      checkedAt: new Date().toISOString(),
      reasonCode: "hosted_worker_owned",
      message: "Discoverable for worker-owned self-hosted/staging execution only."
    },
    "claude_code.sdk": {
      state: "installed",
      canRun: false,
      installed: true,
      auth: "missing",
      version: null,
      checkedAt: new Date().toISOString(),
      reasonCode: "hosted_worker_owned",
      message: "Discoverable for worker-owned self-hosted/staging execution only."
    },
    "opencode.acp": {
      state: "installed",
      canRun: false,
      installed: true,
      auth: "missing",
      version: null,
      checkedAt: new Date().toISOString(),
      reasonCode: "hosted_worker_owned",
      message: "Discoverable for worker-owned self-hosted/staging execution only."
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
    deploymentMode: config.deploymentMode,
    hostedRealRuntimeExecution: config.hostedRealRuntimeExecution,
    listOnlineNodes: async () => nodes.list({ status: "online" }),
    metrics,
    logger: {
      info: (event, details) => app.log.info({ event, ...details }),
      warn: (event, details) => app.log.warn({ event, ...details })
    },
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

  registerHostedAuthHooks(app, {
    ...(controlPlane ? { controlPlane } : {}),
    authRequired: serverAuthMode === "api_key",
    auditRouteDecisions: true
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!isMetricsRoute(request.method, request.url)) {
      return;
    }
    if (!shouldProtectMetrics(config, serverAuthMode, publicMetrics)) {
      return;
    }
    if (!controlPlane) {
      metrics.inc("auth.required");
      return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
    }

    try {
      const authInput: Parameters<ControlPlaneService["authenticateRequest"]>[0] = {
        headers: request.headers as Record<string, string | string[] | undefined>
      };
      const query = asRecord(request.query);
      if (query) {
        authInput.query = query;
      }
      const auth = await controlPlane.authenticateRequest(authInput);
      controlPlane.requireScope(auth, "metrics:read");
      controlPlane.requireScope(auth, "admin:read");
      metrics.inc("auth.succeeded");
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        recordControlPlaneErrorMetric(error, metrics);
        return sendHttpError(reply, error.code, error.reasonCode, [{ path: "reasonCode", issue: error.reasonCode }]);
      }
      throw error;
    }
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async (_request, reply) => {
    const readinessControlPlane = controlPlaneStoreInstance
      ? {
          mode: "enabled" as const,
          hasApiKeyPepper: Boolean(config.apiKeyPepper),
          hasBootstrap: Boolean(config.controlPlaneBootstrap),
          bootstrapActiveCounts,
          storeReady: true,
          hasQuotaStore: true,
          hasAuditStore: true,
          nodeTokenBound: config.nodeSharedToken
            ? nodeTokenBindings.some((entry) => tokenMatches(entry.token, config.nodeSharedToken!))
            : true,
          unownedResources: await controlPlaneStoreInstance.countUnownedResources()
        }
      : {
          mode: serverAuthMode === "api_key" ? "missing" as const : "disabled" as const,
          hasApiKeyPepper: Boolean(config.apiKeyPepper),
          hasBootstrap: Boolean(config.controlPlaneBootstrap),
          bootstrapActiveCounts,
          storeReady: false,
          hasQuotaStore: false,
          hasAuditStore: false,
          nodeTokenBound: config.nodeSharedToken ? false : true,
          unownedResources: undefined
        };
    const ready = await probeServerReadiness({
      config,
      postgres,
      queue,
      artifactContent,
      controlPlane: readinessControlPlane
    });
    if (!ready.ok) {
      metrics.inc("dependencies.notReady");
      metrics.inc("controlPlane.notReady");
      return reply.code(503).send(ready);
    }
    metrics.inc("dependencies.ready");
    metrics.inc("controlPlane.ready");
    return ready;
  });
  app.get("/metrics", async () => {
    try {
      await metrics.captureQueue(queue);
      return metrics.toJSON();
    } catch {
      metrics.inc("errors.metricsCollection");
      metrics.markComponentUnavailable("queue");
      return metrics.toJSON();
    }
  });

  if (controlPlane) {
    registerEnterpriseRoutes(app, { controlPlane });
  }

  registerRunRoutes(app, {
    runService,
    hostedRuns,
    runs,
    events,
    artifacts,
    eventBus,
    registry,
    registryService,
    ...(controlPlane ? { controlPlane } : {})
  });

  registerArtifactRoutes(app, {
    artifacts,
    artifactContent,
    ...(controlPlane ? { controlPlane } : {})
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
      summarize: async () => {
        const listed = await registry.listRuntimeModes({ limit: 100 });
        return {
          runtimeModes: listed.runtimeModes.map((mode) => ({
            runtimeModeId: mode.id,
            runtimeMode: mode.slug,
            state: mode.availability.state,
            canRun: mode.availability.canRun,
            checkedAt: mode.availability.checkedAt
          })),
          summary: summarizeRuntimeStates(listed.runtimeModes.map((mode) => mode.availability.state))
        };
      }
    },
    registryService
  });

  const nodeRouteDeps = {
    coordinator,
    eventSync,
    artifactSync,
    requireAuth: config.deploymentMode === "staging" || config.deploymentMode === "production",
    deploymentMode: config.deploymentMode,
    nodeTokenBindings,
    jsonBodyLimitBytes: 512 * 1024,
    artifactBodyLimitBytes: 2 * 1024 * 1024
  } as const;
  const nodeRouteDepsWithControl = controlPlane
    ? { ...nodeRouteDeps, controlPlane }
    : nodeRouteDeps;
  registerNodeRoutes(app, config.nodeSharedToken
    ? { ...nodeRouteDepsWithControl, sharedToken: config.nodeSharedToken }
    : nodeRouteDepsWithControl);

  return app;
}

function instrumentQueue(
  queue: RunQueuePort & { close?: () => Promise<void> },
  metrics: HostedMetrics
): RunQueuePort & { close?: () => Promise<void> } {
  const wrapped: RunQueuePort & { close?: () => Promise<void> } = {
    ...queue,
    async enqueue(payload, options) {
      const out = await queue.enqueue(payload, options);
      metrics.inc("queue.enqueue");
      return out;
    },
    async claim(options) {
      const out = await queue.claim(options);
      if (out) {
        metrics.inc("queue.claim");
      }
      return out;
    },
    async ack(jobId) {
      metrics.inc("queue.ack");
      return queue.ack(jobId);
    },
    async fail(jobId, error) {
      metrics.inc("queue.failed");
      if (error.reasonCode === "worker_retry_exhausted") {
        metrics.inc("queue.exhausted");
      }
      return queue.fail(jobId, error);
    },
    async retry(jobId) {
      metrics.inc("queue.retry");
      return queue.retry(jobId);
    },
    discard(jobId) {
      return queue.discard(jobId);
    },
    getJob(jobId) {
      return queue.getJob(jobId);
    },
    recoverStaleClaims(options) {
      return queue.recoverStaleClaims(options);
    },
    stats() {
      return queue.stats();
    },
  };
  if (queue.close) {
    wrapped.close = queue.close.bind(queue);
  }
  return wrapped;
}

function instrumentArtifactContent(
  store: ProbeableArtifactContentStore,
  metrics: HostedMetrics
): ProbeableArtifactContentStore {
  return {
    ...store,
    async writeText(path, text, options) {
      try {
        const result = await store.writeText(path, text, options);
        metrics.inc("objectStore.writes");
        return result;
      } catch (error) {
        captureObjectStoreErrorMetrics(error, metrics);
        throw error;
      }
    },
    async writeBytes(path, bytes, options) {
      try {
        const result = await store.writeBytes(path, bytes, options);
        metrics.inc("objectStore.writes");
        return result;
      } catch (error) {
        captureObjectStoreErrorMetrics(error, metrics);
        throw error;
      }
    },
    async read(artifact) {
      try {
        const result = await store.read(artifact);
        metrics.inc("objectStore.reads");
        return result;
      } catch (error) {
        captureObjectStoreErrorMetrics(error, metrics);
        throw error;
      }
    },
    async probe() {
      try {
        return await store.probe();
      } catch (error) {
        metrics.inc("objectStore.probeFailures");
        captureObjectStoreErrorMetrics(error, metrics);
        throw error;
      }
    }
  };
}

function captureObjectStoreErrorMetrics(error: unknown, metrics: HostedMetrics): void {
  metrics.inc("objectStore.failures");
  const message = error instanceof Error ? error.message : String(error);
  if (message === "object_store_auth_failed") {
    metrics.inc("objectStore.authFailures");
  }
  if (message === "object_store_unavailable" || message === "object_store_bucket_not_found" || message === "object_store_timeout") {
    metrics.inc("objectStore.unavailable");
  }
  if (message === "artifact_digest_mismatch" || message === "artifact_content_empty") {
    metrics.inc("objectStore.digestMismatches");
  }
}

async function seedHostedRegistryRecords(registry: RegistryStore): Promise<void> {
  if (!(await registry.getProvider("provider_test"))) {
    await registry.createProvider({ id: "provider_test", name: "Test Provider", authMode: "none", status: "available" });
  }
  if (!(await registry.getProvider("provider_openai"))) {
    await registry.createProvider({ id: "provider_openai", name: "OpenAI", authMode: "local", status: "available" });
  }
  if (!(await registry.getProvider("provider_anthropic"))) {
    await registry.createProvider({ id: "provider_anthropic", name: "Anthropic", authMode: "local", status: "available" });
  }
  if (!(await registry.getProvider("provider_opencode"))) {
    await registry.createProvider({ id: "provider_opencode", name: "OpenCode", authMode: "local", status: "available" });
  }
  if (!(await registry.getRuntime("runtime_fake"))) {
    await registry.createRuntime({ id: "runtime_fake", name: "Fake Runtime", adapterType: "process", status: "available" });
  }
  if (!(await registry.getRuntime("runtime_codex"))) {
    await registry.createRuntime({ id: "runtime_codex", name: "Codex Runtime", adapterType: "process", status: "available" });
  }
  if (!(await registry.getRuntime("runtime_claude_code"))) {
    await registry.createRuntime({ id: "runtime_claude_code", name: "Claude Code Runtime", adapterType: "native", status: "available" });
  }
  if (!(await registry.getRuntime("runtime_opencode"))) {
    await registry.createRuntime({ id: "runtime_opencode", name: "OpenCode Runtime", adapterType: "acpx", status: "available" });
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
  if (!(await registry.getModel("model_openai_codex_default"))) {
    await registry.createModel({
      id: "model_openai_codex_default",
      providerId: "provider_openai",
      modelName: "gpt-5",
      supportsTools: false,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    });
  }
  if (!(await registry.getModel("model_anthropic_claude_code_default"))) {
    await registry.createModel({
      id: "model_anthropic_claude_code_default",
      providerId: "provider_anthropic",
      modelName: "claude-code",
      supportsTools: false,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    });
  }
  if (!(await registry.getModel("model_opencode_default"))) {
    await registry.createModel({
      id: "model_opencode_default",
      providerId: "provider_opencode",
      modelName: "opencode-default",
      supportsTools: false,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    });
  }
}

function summarizeRuntimeStates(states: string[]): {
  available: number;
  installed: number;
  partial: number;
  unavailable: number;
  unsupported: number;
  unknown: number;
} {
  const summary = {
    available: 0,
    installed: 0,
    partial: 0,
    unavailable: 0,
    unsupported: 0,
    unknown: 0
  };
  for (const state of states) {
    if (state === "available" || state === "installed" || state === "partial" || state === "unavailable" || state === "unsupported" || state === "unknown") {
      summary[state] += 1;
    }
  }
  return summary;
}

function isMetricsRoute(method: string, url: string): boolean {
  if (method.toUpperCase() !== "GET") {
    return false;
  }
  const [path] = url.split("?", 1);
  if (!path) {
    return false;
  }
  const normalized = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  return normalized === "/metrics";
}

function shouldProtectMetrics(config: ServerConfig, serverAuthMode: "disabled" | "api_key", publicMetrics: boolean): boolean {
  if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
    return true;
  }
  if (serverAuthMode === "api_key") {
    return true;
  }
  return !publicMetrics;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function recordControlPlaneErrorMetric(error: ControlPlaneError, metrics: HostedMetrics): void {
  if (error.code === "auth_required") {
    metrics.inc("auth.required");
    return;
  }
  if (error.code === "auth_failed") {
    metrics.inc("auth.failed");
    return;
  }
  if (error.code === "auth_conflict") {
    metrics.inc("auth.conflict");
    return;
  }
  if (error.code === "tenant_access_denied") {
    metrics.inc("tenant.denied");
    return;
  }
  if (error.code === "entitlement_denied") {
    metrics.inc("entitlement.denied");
    return;
  }
  if (error.code === "quota_exceeded") {
    metrics.inc("quota.denied");
    return;
  }
  metrics.inc("controlPlane.notReady");
}

function tokenMatches(got: string, expected: string): boolean {
  return got.length === expected.length && got === expected;
}

function buildNodeTokenBindings(bootstrap: ControlPlaneBootstrapConfig): readonly NodeTokenBinding[] {
  const records = bootstrap.records as Record<string, unknown>;
  const accounts = readRecordArray(records["accounts"]);
  const tenants = readRecordArray(records["tenants"]);
  const projects = readRecordArray(records["projects"]);
  const users = readRecordArray(records["users"]);
  const apiKeys = readRecordArray(records["apiKeys"]);
  const plans = readRecordArray(records["billingPlans"]);

  const accountById = toRecordMap(accounts);
  const tenantById = toRecordMap(tenants);
  const projectById = toRecordMap(projects);
  const userById = toRecordMap(users);
  const apiKeyById = toRecordMap(apiKeys);
  const planById = toRecordMap(plans);

  const bindings: NodeTokenBinding[] = [];
  for (const binding of bootstrap.nodeTokenBindings) {
    const key = apiKeyById.get(binding.apiKeyId);
    if (!key || String(key["status"] ?? "") !== "active") {
      continue;
    }
    const account = accountById.get(String(key["accountId"] ?? ""));
    const tenant = tenantById.get(String(key["tenantId"] ?? ""));
    const project = projectById.get(String(key["projectId"] ?? ""));
    const user = userById.get(String(key["userId"] ?? ""));
    if (!account || !tenant || !project || !user) {
      continue;
    }
    if (String(account["status"] ?? "") !== "active") {
      continue;
    }
    if (String(tenant["status"] ?? "") !== "active") {
      continue;
    }
    if (String(project["status"] ?? "") !== "active") {
      continue;
    }
    if (String(user["status"] ?? "active") !== "active") {
      continue;
    }

    const plan = planById.get(String(account["billingPlanId"] ?? ""));
    if (!plan || String(plan["status"] ?? "") !== "active") {
      continue;
    }

    const auth = toAuthContext(account, tenant, project, user, key, plan);
    bindings.push({ token: binding.token, auth });
  }

  return bindings;
}

type NodeAuthContext = NodeTokenBinding["auth"];

function toAuthContext(
  account: Record<string, unknown>,
  tenant: Record<string, unknown>,
  project: Record<string, unknown>,
  user: Record<string, unknown>,
  apiKey: Record<string, unknown>,
  plan: Record<string, unknown>
): NodeAuthContext {
  const now = new Date().toISOString();
  const entitlements = asRecord(plan["entitlements"]) ?? {};
  const quotas = asRecord(plan["quotas"]) ?? {};
  const scopes = Array.isArray(apiKey["scopes"]) ? apiKey["scopes"].filter((entry): entry is string => typeof entry === "string") : [];

  return {
    account: {
      id: String(account["id"]),
      name: String(account["name"]),
      status: String(account["status"]) as "active" | "suspended" | "deleted",
      billingPlanId: String(account["billingPlanId"]),
      createdAt: String(account["createdAt"]),
      updatedAt: typeof account["updatedAt"] === "string" ? String(account["updatedAt"]) : undefined
    },
    tenant: {
      id: String(tenant["id"]),
      accountId: String(tenant["accountId"]),
      slug: String(tenant["slug"]),
      displayName: String(tenant["displayName"]),
      status: String(tenant["status"]) as "active" | "suspended" | "deleted",
      createdAt: String(tenant["createdAt"]),
      updatedAt: typeof tenant["updatedAt"] === "string" ? String(tenant["updatedAt"]) : undefined
    },
    project: {
      id: String(project["id"]),
      accountId: String(project["accountId"]),
      tenantId: String(project["tenantId"]),
      slug: String(project["slug"]),
      displayName: String(project["displayName"]),
      status: String(project["status"]) as "active" | "archived" | "deleted",
      createdAt: String(project["createdAt"]),
      updatedAt: typeof project["updatedAt"] === "string" ? String(project["updatedAt"]) : undefined
    },
    user: {
      id: String(user["id"]),
      accountId: String(user["accountId"]),
      tenantId: String(user["tenantId"]),
      displayName: String(user["displayName"]),
      email: typeof user["email"] === "string" ? String(user["email"]) : undefined,
      status: typeof user["status"] === "string" ? String(user["status"]) as "active" | "suspended" | "deleted" : "active",
      createdAt: String(user["createdAt"]),
      updatedAt: typeof user["updatedAt"] === "string" ? String(user["updatedAt"]) : undefined
    },
    apiKey: {
      id: String(apiKey["id"]),
      accountId: String(apiKey["accountId"]),
      tenantId: String(apiKey["tenantId"]),
      projectId: String(apiKey["projectId"]),
      userId: String(apiKey["userId"]),
      name: String(apiKey["name"]),
      keyPrefix: String(apiKey["keyPrefix"]),
      scopes: scopes as NodeAuthContext["apiKey"]["scopes"],
      status: String(apiKey["status"]) as "active" | "revoked" | "expired",
      expiresAt: typeof apiKey["expiresAt"] === "string" ? String(apiKey["expiresAt"]) : undefined,
      lastUsedAt: typeof apiKey["lastUsedAt"] === "string" ? String(apiKey["lastUsedAt"]) : undefined,
      createdAt: String(apiKey["createdAt"]),
      revokedAt: typeof apiKey["revokedAt"] === "string" ? String(apiKey["revokedAt"]) : undefined
    },
    entitlement: {
      accountId: String(account["id"]),
      tenantId: String(tenant["id"]),
      projectId: String(project["id"]),
      planId: String(plan["id"]),
      planSlug: String(plan["slug"]),
      planDisplayName: String(plan["displayName"]),
      planStatus: String(plan["status"]) as "active" | "archived",
      entitlements: {
        allowedPlacements: arrayStrings(entitlements["allowedPlacements"]) as NodeAuthContext["entitlement"]["entitlements"]["allowedPlacements"],
        allowedRuntimeModes: arrayStrings(entitlements["allowedRuntimeModes"]),
        allowHostedRealRuntime: Boolean(entitlements["allowHostedRealRuntime"]),
        allowConnectedNodes: Boolean(entitlements["allowConnectedNodes"]),
        allowArtifactContentRead: Boolean(entitlements["allowArtifactContentRead"]),
        allowMetricsRead: Boolean(entitlements["allowMetricsRead"]),
        allowAuditRead: Boolean(entitlements["allowAuditRead"])
      },
      quotas: {
        maxRunsPerHour: toNumber(quotas["maxRunsPerHour"]),
        maxActiveRuns: toNumber(quotas["maxActiveRuns"]),
        maxRunTimeoutSeconds: toNumber(quotas["maxRunTimeoutSeconds"]),
        maxConnectedNodes: toNumber(quotas["maxConnectedNodes"]),
        maxArtifactContentReadBytesPerHour: toNumber(quotas["maxArtifactContentReadBytesPerHour"])
      },
      scopes: scopes as NodeAuthContext["entitlement"]["scopes"],
      capturedAt: now
    }
  };
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function toRecordMap(records: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const entry of records) {
    const id = typeof entry["id"] === "string" ? entry["id"] : "";
    if (id.length > 0) {
      map.set(id, entry);
    }
  }
  return map;
}

function arrayStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}
