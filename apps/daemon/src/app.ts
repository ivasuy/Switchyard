import Fastify from "fastify";
import { mkdirSync } from "node:fs";
import {
  AgentFieldAsyncRestAdapter,
  ClaudeCodeAdapter,
  createClaudeCodeCliClient,
  type ClaudeCodeCliProcessFactory,
  CodexAdapterRouter,
  CodexInteractiveAdapter,
  type CodexInteractiveSessionFactory,
  CODEX_INTERACTIVE_RUNTIME_MODE_SLUG,
  CodexExecResumeJsonSessionFactory,
  CodexExecJsonAdapter,
  GenericHttpAsyncRestAdapter,
  OpenCodeAcpAdapter,
  probeCodexCatalog
} from "@switchyard/adapters";
import {
  type ArtifactStore,
  AdapterProtocolError,
  EventBus,
  RegistryService,
  RuntimeCapabilityService,
  LocalPolicyGate,
  MessageRouter,
  MemoryService,
  EvidenceService,
  DebateService,
  ContextBuilder,
  ApprovalService,
  ToolRouter,
  type RuntimeAdapter,
  RuntimeDoctorService,
  type RuntimeLogger,
  RunLauncherService,
  RunService,
  RuntimeRunnerService,
  type DebateStore,
  type EventStore,
  type MessageStore,
  type MemoryStore,
  type EvidenceStore,
  type ApprovalStore,
  type ToolInvocationStore,
  type RunStore,
  type RegistryStore,
  type SessionStore
} from "@switchyard/core";
import {
  contentTypeForArtifact,
  registerArtifactRoutes,
  registerDebateRoutes,
  registerErrorEnvelope,
  registerMiddlewareRoutes,
  registerRegistryRoutes,
  registerRunRoutes,
  type ArtifactContentReader
} from "@switchyard/protocol-rest";
import type { RunStatus } from "@switchyard/contracts";
import {
  FakeRuntimeAdapter,
  FakeEchoToolAdapter,
  InMemoryApprovalStore,
  InMemoryEvidenceStore,
  InMemoryArtifactStore,
  InMemoryDebateStore,
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryMessageStore,
  InMemoryRegistryStore,
  InMemoryRunStore,
  InMemorySessionStore,
  InMemoryToolInvocationStore
} from "@switchyard/testkit";
import {
  openSqliteStorage,
  SqliteApprovalStore,
  SqliteArtifactStore,
  SqliteDebateStore,
  SqliteEvidenceStore,
  SqliteEventStore,
  SqliteMemoryStore,
  SqliteMessageStore,
  SqliteRegistryStore,
  SqliteRunStore,
  SqliteSessionStore,
  SqliteToolInvocationStore,
  FilesystemArtifactContentStore
} from "@switchyard/storage";
import { type DaemonConfig } from "./config.js";

interface DaemonStores {
  runs: RunStore;
  debates: DebateStore;
  events: EventStore;
  sessions: SessionStore;
  artifacts: ArtifactStore;
  registry: RegistryStore;
  messages: MessageStore;
  memory: MemoryStore;
  evidence: EvidenceStore;
  approvals: ApprovalStore;
  toolInvocations: ToolInvocationStore;
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
  claudeClient?: ConstructorParameters<typeof ClaudeCodeAdapter>[0]["client"];
  claudeProcessFactory?: ClaudeCodeCliProcessFactory;
  claudeVersionProbe?: NonNullable<ConstructorParameters<typeof ClaudeCodeAdapter>[0]["doctor"]>["probeVersion"];
  claudeAuthProbe?: NonNullable<ConstructorParameters<typeof ClaudeCodeAdapter>[0]["doctor"]>["probeAuth"];
  claudeLiveProbe?: NonNullable<ConstructorParameters<typeof ClaudeCodeAdapter>[0]["doctor"]>["runLiveProbe"];
  codexInteractiveSessionFactory?: CodexInteractiveSessionFactory;
  codexInteractiveApprovalBridge?: boolean;
}

interface StartupRecoveryStats {
  recoveredRuns: number;
  failedSessions: number;
  alreadyTerminal: number;
  duplicateStarts: number;
}

interface StartupRecoveryResult {
  stats: StartupRecoveryStats;
  reconciledRunIds: string[];
}

interface DaemonMetricsState {
  requestsTotal: number;
  errorsTotal: number;
  runStatusCounts: Record<RunStatus, number>;
  startupRecovery: StartupRecoveryStats;
}

const RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
  "timeout"
];

export async function createDaemonApp(config?: DaemonConfig, options: CreateDaemonAppOptions = {}) {
  const app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: (request) => resolveRequestId(request.headers["x-request-id"])
  });
  const stores: DaemonStoreResult = config ? createStorageStores(config) : createInMemoryStores();
  const checkTimeoutMs = options.checkTimeoutMs ?? 5000;
  const maxDiagnosticBytes = options.maxDiagnosticBytes ?? 4096;
  const genericHttpConfig = config?.genericHttp ?? {
    requestTimeoutMs: 5000,
    pollIntervalMs: 100,
    maxResponseBytes: 1024 * 1024
  };
  const agentfieldConfig = config?.agentfield ?? {
    requestTimeoutMs: 5000,
    pollIntervalMs: 1000,
    maxResponseBytes: 1024 * 1024
  };
  const opencodeConfig = config?.opencode ?? {
    command: "opencode"
  };
  const claudeCodeConfig = config?.claudeCode ?? {
    command: "claude",
    liveProbe: false,
    maxBudgetUsd: 0.05,
    requestTimeoutMs: 5000
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
  const agentfieldAvailability = initialAgentFieldAvailability(agentfieldConfig, now);
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
  const claudeAvailability: DaemonRuntimeAvailability = {
    state: "unknown",
    canRun: false,
    installed: false,
    auth: "unknown",
    version: null,
    checkedAt: now,
    reasonCode: "live_probe_disabled",
    message: "Live probe is disabled by default."
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
  const metrics = createDaemonMetricsState();
  const startupRecovery = reconcileInterruptedRuns(stores, options.logger);
  metrics.startupRecovery = startupRecovery.stats;
  const codexOptions: ConstructorParameters<typeof CodexExecJsonAdapter>[0] = {
    modelCatalog: codexProbe.models
  };
  if (options.probeCodexCatalog) {
    codexOptions.probeCatalog = options.probeCodexCatalog;
  }
  if (options.logger) {
    codexOptions.logger = options.logger;
  }
  const codexExecAdapter = new CodexExecJsonAdapter(codexOptions);
  const codexInteractiveFactory = options.codexInteractiveSessionFactory ?? new CodexExecResumeJsonSessionFactory({
    command: "codex",
    approvalBridgeSupported: options.codexInteractiveApprovalBridge ?? false
  });
  const codexInteractiveAdapter = new CodexInteractiveAdapter({
    sessionFactory: codexInteractiveFactory,
    command: "codex",
    approvalBridgeSupported: options.codexInteractiveApprovalBridge ?? false,
    ...(options.logger ? { logger: options.logger } : {})
  });
  const codexRouter = new CodexAdapterRouter({
    execAdapter: codexExecAdapter,
    interactiveAdapter: codexInteractiveAdapter
  });
  const codexInteractiveCheck = await codexInteractiveAdapter.check({
    runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG,
    timeoutMs: checkTimeoutMs,
    maxDiagnosticBytes
  });
  const codexInteractiveAvailability = availabilityFromInteractiveCheck(codexInteractiveCheck, now);
  const genericHttpAdapterOptions: ConstructorParameters<typeof GenericHttpAsyncRestAdapter>[0] = {
    ...(genericHttpConfig.baseUrl ? { baseUrl: genericHttpConfig.baseUrl } : {}),
    ...(genericHttpConfig.authToken ? { authToken: genericHttpConfig.authToken } : {}),
    requestTimeoutMs: genericHttpConfig.requestTimeoutMs,
    pollIntervalMs: genericHttpConfig.pollIntervalMs,
    maxResponseBytes: genericHttpConfig.maxResponseBytes,
    ...(options.logger ? { logger: options.logger } : {})
  };
  const genericHttpAdapter = new GenericHttpAsyncRestAdapter(genericHttpAdapterOptions);
  const agentfieldAdapter = new AgentFieldAsyncRestAdapter({
    ...(agentfieldConfig.baseUrl ? { baseUrl: agentfieldConfig.baseUrl } : {}),
    ...(agentfieldConfig.apiKey ? { apiKey: agentfieldConfig.apiKey } : {}),
    ...(agentfieldConfig.target ? { target: agentfieldConfig.target } : {}),
    requestTimeoutMs: agentfieldConfig.requestTimeoutMs,
    pollIntervalMs: agentfieldConfig.pollIntervalMs,
    maxResponseBytes: agentfieldConfig.maxResponseBytes,
    ...(options.logger ? { logger: options.logger } : {})
  });
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
  const claudeAdapter = new ClaudeCodeAdapter({
    client: options.claudeClient ?? createClaudeCodeCliClient({
      command: claudeCodeConfig.command,
      permissionMode: "read_only",
      disabledTools: ["Bash", "WebFetch", "WebSearch"],
      ...(options.claudeProcessFactory ? { processFactory: options.claudeProcessFactory } : {})
    }),
    command: claudeCodeConfig.command,
    liveProbe: claudeCodeConfig.liveProbe,
    maxBudgetUsd: claudeCodeConfig.maxBudgetUsd,
    requestTimeoutMs: claudeCodeConfig.requestTimeoutMs,
    permissionMode: "read_only",
    disabledTools: ["Bash", "WebFetch", "WebSearch"],
    ...(options.logger ? { logger: options.logger } : {}),
    doctor: {
      ...(options.claudeVersionProbe ? { probeVersion: options.claudeVersionProbe } : {}),
      ...(options.claudeAuthProbe ? { probeAuth: options.claudeAuthProbe } : {}),
      ...(options.claudeLiveProbe ? { runLiveProbe: options.claudeLiveProbe } : {})
    }
  });
  const adapters = new Map<string, RuntimeAdapter>([
    ["fake", new FakeRuntimeAdapter()],
    ["claude_code", claudeAdapter],
    ["codex", codexRouter],
    ["agentfield", agentfieldAdapter],
    ["generic_http", genericHttpAdapter],
    ["opencode", opencodeAdapter]
  ]);
  const eventBus = new EventBus();
  let approvalServiceRef: ApprovalService | undefined;
  const runnerOptions: ConstructorParameters<typeof RuntimeRunnerService>[0] = {
    adapters,
    eventBus,
    runtimeApprovals: {
      create: async (input) => {
        if (!approvalServiceRef) {
          throw new AdapterProtocolError("Runtime approval bridge is not configured.", {
            reasonCode: "runtime_approval_bridge_unconfigured"
          });
        }
        await approvalServiceRef.create({
          runId: input.runId,
          approvalType: input.approvalType,
          payload: input.payload
        });
      },
      terminalizePendingForRun: async (runId, input) => {
        if (!approvalServiceRef) {
          throw new AdapterProtocolError("Runtime approval bridge is not configured.", {
            reasonCode: "runtime_approval_bridge_unconfigured"
          });
        }
        return await approvalServiceRef.terminalizePendingRuntimeApprovalsForRun(runId, input);
      }
    },
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
    await seedClaudeRegistry(stores, claudeAvailability);
    await seedCodexRegistry(stores, codexProbe, codexAvailability);
    await seedAgentFieldRegistry(stores, agentfieldAvailability);
    await seedGenericHttpRegistry(stores, genericHttpAvailability);
    await seedOpenCodeRegistry(stores, opencodeAvailability);
    await capabilityService.seedManifests(
      [
        adapters.get("fake")!.manifest,
        adapters.get("claude_code")!.manifest,
        codexExecAdapter.manifest,
        codexInteractiveAdapter.manifest,
        adapters.get("agentfield")!.manifest,
        adapters.get("generic_http")!.manifest,
        adapters.get("opencode")!.manifest
      ],
      {
        "fake.deterministic": fakeAvailability,
        "claude_code.sdk": claudeAvailability,
        "codex.exec_json": codexAvailability,
        [CODEX_INTERACTIVE_RUNTIME_MODE_SLUG]: codexInteractiveAvailability,
        "agentfield.async_rest": agentfieldAvailability,
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
      runtimeMode: "claude_code.sdk",
      adapterId: "claude_code",
      state: claudeAvailability.state
    });
    options.logger?.info("runtime_mode.seeded", {
      runtimeMode: "codex.exec_json",
      adapterId: "codex",
      state: codexAvailability.state
    });
    options.logger?.info("runtime_mode.seeded", {
      runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG,
      adapterId: "codex",
      state: codexInteractiveAvailability.state
    });
    options.logger?.info("runtime_mode.seeded", {
      runtimeMode: "agentfield.async_rest",
      adapterId: "agentfield",
      state: agentfieldAvailability.state
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

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onResponse", async (_request, reply) => {
    metrics.requestsTotal += 1;
    if (reply.statusCode >= 400) {
      metrics.errorsTotal += 1;
    }
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/metrics", async () => {
    metrics.runStatusCounts = await collectRunStatusCounts(stores);
    return {
      requestsTotal: metrics.requestsTotal,
      errorsTotal: metrics.errorsTotal,
      runStatusCounts: metrics.runStatusCounts,
      startupRecovery: metrics.startupRecovery
    };
  });
  const contextBuilder = new ContextBuilder({
    memory: stores.memory,
    evidence: stores.evidence,
    messages: stores.messages
  });
  const messageRouter = new MessageRouter({
    runs: stores.runs,
    messages: stores.messages,
    events: stores.events,
    eventBus
  });
  const debateServiceOptions: ConstructorParameters<typeof DebateService>[0] = {
    debates: stores.debates,
    runs: stores.runs,
    runService,
    contextBuilder,
    messageRouter,
    evidence: stores.evidence,
    events: stores.events,
    artifacts: stores.artifacts,
    eventBus,
    defaultCwd: process.cwd()
  };
  if (stores.artifactContent) {
    debateServiceOptions.artifactContent = stores.artifactContent;
  }
  if (options.logger) {
    debateServiceOptions.logger = options.logger;
  }
  const debateService = new DebateService(debateServiceOptions);
  registerRunRoutes(app, {
    ...stores,
    eventBus,
    launcher,
    runService,
    contextBuilder,
    registry: stores.registry,
    registryService
  });
  const middlewareEventBus = eventBus;
  const policy = new LocalPolicyGate();
  const toolRouter = new ToolRouter({
    runs: stores.runs,
    events: stores.events,
    approvals: stores.approvals,
    invocations: stores.toolInvocations,
    eventBus: middlewareEventBus,
    adapters: new Map([["fake_echo", new FakeEchoToolAdapter()]]),
    policy
  });
  const approvalService = new ApprovalService({
    approvals: stores.approvals,
    runs: stores.runs,
    events: stores.events,
    eventBus: middlewareEventBus,
    toolRouter,
    runtimeResolutionSender: async (input) => {
      await runService.sendInput(input.runId, input);
    }
  });
  approvalServiceRef = approvalService;
  await approvalService.expirePendingRuntimeApprovals();
  for (const runId of startupRecovery.reconciledRunIds) {
    await approvalService.terminalizePendingRuntimeApprovalsForRun(runId, {
      terminalEvent: "daemon_restarted",
      approvalStatus: "rejected",
      message: "daemon restarted"
    });
  }
  registerMiddlewareRoutes(app, {
    messageRouter,
    memoryService: new MemoryService({ memory: stores.memory }),
    evidenceService: new EvidenceService({ evidence: stores.evidence }),
    contextBuilder,
    approvalService,
    toolRouter
  });
  registerRegistryRoutes(app, {
    registry: stores.registry,
    doctor: doctorService,
    registryService
  });
  registerDebateRoutes(app, {
    debateService,
    debates: stores.debates,
    events: stores.events,
    eventBus
  });
  const reader = buildArtifactContentReader(stores.artifactContent);
  registerArtifactRoutes(app, {
    artifacts: stores.artifacts,
    artifactContent: reader ?? unavailableContentReader
  });

  return app;
}

const unavailableContentReader: ArtifactContentReader = {
  async read(artifact) {
    const metadata = artifact.metadata as Record<string, unknown> | undefined;
    const inlineContent = metadata?.["content"];
    if (typeof inlineContent === "string") {
      return {
        body: Buffer.from(inlineContent, "utf8"),
        contentType: contentTypeForArtifact(artifact.type)
      };
    }
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
    debates: new InMemoryDebateStore(),
    events: new InMemoryEventStore(),
    sessions: new InMemorySessionStore(),
    artifacts: new InMemoryArtifactStore(),
    registry: new InMemoryRegistryStore(),
    messages: new InMemoryMessageStore(),
    memory: new InMemoryMemoryStore(),
    evidence: new InMemoryEvidenceStore(),
    approvals: new InMemoryApprovalStore(),
    toolInvocations: new InMemoryToolInvocationStore()
  };
}

function createStorageStores(config: DaemonConfig): DaemonStoreResult {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.artifactDir, { recursive: true });

  const storage = openSqliteStorage(config.sqlitePath);
  const artifactContent = new FilesystemArtifactContentStore(config.artifactDir);

  return {
    runs: new SqliteRunStore(storage.db),
    debates: new SqliteDebateStore(storage.db),
    events: new SqliteEventStore(storage.db),
    sessions: new SqliteSessionStore(storage.db),
    artifacts: new SqliteArtifactStore(storage.db),
    registry: new SqliteRegistryStore(storage.db),
    messages: new SqliteMessageStore(storage.db),
    memory: new SqliteMemoryStore(storage.db),
    evidence: new SqliteEvidenceStore(storage.db),
    approvals: new SqliteApprovalStore(storage.db),
    toolInvocations: new SqliteToolInvocationStore(storage.db),
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

async function seedClaudeRegistry(
  stores: DaemonStoreResult,
  availability: DaemonRuntimeAvailability
): Promise<void> {
  const registry = stores.registry;
  const status = statusFromAvailability(availability);

  const existingProvider = await registry.getProvider("provider_anthropic");
  if (!existingProvider) {
    await registry.createProvider({
      id: "provider_anthropic",
      name: "Anthropic",
      authMode: "local",
      status
    });
  } else {
    await updateProviderRecord(stores, {
      id: "provider_anthropic",
      name: "Anthropic",
      authMode: "local",
      status
    });
  }

  const existingRuntime = await registry.getRuntime("runtime_claude_code");
  if (!existingRuntime) {
    await registry.createRuntime({
      id: "runtime_claude_code",
      name: "Claude Code",
      adapterType: "native",
      status,
      providerId: "provider_anthropic"
    });
  } else {
    await updateRuntimeRecord(stores, {
      id: "runtime_claude_code",
      name: "Claude Code",
      adapterType: "native",
      status,
      providerId: "provider_anthropic"
    });
  }

  if (!(await registry.getModel("model_claude_code_default"))) {
    await registry.createModel({
      id: "model_claude_code_default",
      providerId: "provider_anthropic",
      modelName: "claude-code-default",
      supportsTools: true,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    });
  }
}

function reconcileInterruptedRuns(
  stores: DaemonStoreResult,
  logger?: RuntimeLogger
): StartupRecoveryResult {
  const stats: StartupRecoveryStats = {
    recoveredRuns: 0,
    failedSessions: 0,
    alreadyTerminal: 0,
    duplicateStarts: 0
  };
  const reconciledRunIds: string[] = [];
  if (!stores.sqlite) {
    return { stats, reconciledRunIds };
  }

  const staleRuns = stores.sqlite
    .prepare(
      "SELECT id, status FROM runs WHERE status IN ('starting', 'running', 'waiting_for_input', 'waiting_for_approval')"
    )
    .all();

  for (const staleRun of staleRuns) {
    const runId = typeof staleRun["id"] === "string" ? staleRun["id"] : undefined;
    if (!runId) {
      logger?.error("daemon.startup.recovery.invalid_run_id", { row: staleRun });
      continue;
    }

    try {
      const endedAt = new Date().toISOString();
      const sequenceRow = stores.sqlite
        .prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM run_events WHERE run_id = ?")
        .get(runId);
      const sequence = typeof sequenceRow?.["sequence"] === "number" ? sequenceRow["sequence"] : 0;

      const runUpdate = stores.sqlite
        .prepare(
          "UPDATE runs SET status = 'failed', ended_at = ? WHERE id = ? AND status IN ('starting', 'running', 'waiting_for_input', 'waiting_for_approval')"
        )
        .run(endedAt, runId) as { changes: number };
      if (runUpdate.changes === 0) {
        stats.duplicateStarts += 1;
        continue;
      }

      stats.recoveredRuns += 1;
      reconciledRunIds.push(runId);
      const sessionUpdate = stores.sqlite
        .prepare("UPDATE runtime_sessions SET status = 'failed', updated_at = ? WHERE run_id = ? AND status = 'active'")
        .run(endedAt, runId) as { changes: number };
      stats.failedSessions += sessionUpdate.changes;
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
    } catch (error) {
      logger?.error("daemon.startup.recovery_failed", {
        runId,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
  logger?.info("daemon.startup.recovered_runs", {
    count: stats.recoveredRuns,
    failedSessions: stats.failedSessions,
    duplicateStarts: stats.duplicateStarts
  });
  return { stats, reconciledRunIds };
}

function createDaemonMetricsState(): DaemonMetricsState {
  return {
    requestsTotal: 0,
    errorsTotal: 0,
    runStatusCounts: createEmptyRunStatusCounts(),
    startupRecovery: {
      recoveredRuns: 0,
      failedSessions: 0,
      alreadyTerminal: 0,
      duplicateStarts: 0
    }
  };
}

const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function resolveRequestId(value: unknown): string {
  const candidate = firstHeaderValue(value)?.trim();
  if (candidate && candidate.length <= MAX_REQUEST_ID_LENGTH && REQUEST_ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return `req_${crypto.randomUUID()}`;
}

function firstHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string");
  }
  return undefined;
}

async function collectRunStatusCounts(stores: DaemonStoreResult): Promise<Record<RunStatus, number>> {
  const counts = createEmptyRunStatusCounts();
  if (stores.sqlite) {
    const rows = stores.sqlite
      .prepare("SELECT status, COUNT(*) AS count FROM runs GROUP BY status")
      .all();
    for (const row of rows) {
      const status = row["status"];
      const count = row["count"];
      if (typeof status !== "string") {
        continue;
      }
      if (RUN_STATUSES.includes(status as RunStatus) && typeof count === "number") {
        counts[status as RunStatus] = count;
      }
    }
    return counts;
  }

  let cursor: { createdAt: string; id: string } | undefined;
  do {
    const page = await stores.runs.list({ limit: 200, ...(cursor ? { before: cursor } : {}) });
    for (const run of page.runs) {
      const status = run.status as RunStatus;
      if (RUN_STATUSES.includes(status)) {
        counts[status] += 1;
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return counts;
}

function createEmptyRunStatusCounts(): Record<RunStatus, number> {
  return {
    queued: 0,
    starting: 0,
    running: 0,
    waiting_for_input: 0,
    waiting_for_approval: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timeout: 0
  };
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

async function seedAgentFieldRegistry(
  stores: DaemonStoreResult,
  availability: DaemonRuntimeAvailability
): Promise<void> {
  const registry = stores.registry;
  const status = statusFromAvailability(availability);

  const existingProvider = await registry.getProvider("provider_agentfield");
  if (!existingProvider) {
    await registry.createProvider({
      id: "provider_agentfield",
      name: "AgentField",
      authMode: "api_key",
      status
    });
  } else {
    await updateProviderRecord(stores, {
      id: "provider_agentfield",
      name: "AgentField",
      authMode: "api_key",
      status
    });
  }

  const existingRuntime = await registry.getRuntime("runtime_agentfield");
  if (!existingRuntime) {
    await registry.createRuntime({
      id: "runtime_agentfield",
      name: "AgentField",
      adapterType: "http",
      status,
      providerId: "provider_agentfield"
    });
  } else {
    await updateRuntimeRecord(stores, {
      id: "runtime_agentfield",
      name: "AgentField",
      adapterType: "http",
      status,
      providerId: "provider_agentfield"
    });
  }

  if (!(await registry.getModel("model_agentfield_default"))) {
    await registry.createModel({
      id: "model_agentfield_default",
      providerId: "provider_agentfield",
      modelName: "agentfield-default",
      supportsTools: false,
      supportsStreaming: false,
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

function availabilityFromInteractiveCheck(
  check: Awaited<ReturnType<CodexInteractiveAdapter["check"]>>,
  checkedAt: string
): DaemonRuntimeAvailability {
  const raw = check.details?.["availability"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      state: "unknown",
      canRun: false,
      installed: false,
      auth: "unknown",
      version: null,
      checkedAt,
      reasonCode: "codex_interactive_driver_unsupported",
      message: check.message ?? "codex interactive check did not return availability details"
    };
  }
  const record = raw as Record<string, unknown>;
  return {
    state: asAvailabilityState(record["state"]),
    canRun: record["canRun"] === true,
    installed: record["installed"] === true,
    auth: asAvailabilityAuth(record["auth"]),
    version: typeof record["version"] === "string" ? record["version"] : null,
    checkedAt: typeof record["checkedAt"] === "string" ? record["checkedAt"] : checkedAt,
    reasonCode: typeof record["reasonCode"] === "string" ? record["reasonCode"] : null,
    message: typeof record["message"] === "string" ? record["message"] : null
  };
}

function asAvailabilityState(value: unknown): DaemonRuntimeAvailability["state"] {
  if (value === "available" || value === "partial" || value === "unavailable" || value === "installed" || value === "unsupported" || value === "unknown") {
    return value;
  }
  return "unknown";
}

function asAvailabilityAuth(value: unknown): DaemonRuntimeAvailability["auth"] {
  if (value === "configured" || value === "missing" || value === "not_required" || value === "unknown") {
    return value;
  }
  return "unknown";
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

function initialAgentFieldAvailability(
  config: {
    baseUrl?: string;
    apiKey?: string;
    target?: string;
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
      reasonCode: "agentfield_config_missing",
      message: "SWITCHYARD_AGENTFIELD_BASE_URL is not configured."
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
      reasonCode: "agentfield_config_invalid",
      message: "SWITCHYARD_AGENTFIELD_BASE_URL must use http or https."
    };
  }
  if (!config.apiKey) {
    return {
      state: "unavailable",
      canRun: false,
      installed: false,
      auth: "missing",
      version: null,
      checkedAt,
      reasonCode: "agentfield_auth_missing",
      message: "SWITCHYARD_AGENTFIELD_API_KEY is not configured."
    };
  }
  if (!config.target) {
    return {
      state: "unavailable",
      canRun: false,
      installed: false,
      auth: "configured",
      version: null,
      checkedAt,
      reasonCode: "agentfield_target_missing",
      message: "SWITCHYARD_AGENTFIELD_TARGET is not configured."
    };
  }
  return {
    state: "unknown",
    canRun: false,
    installed: true,
    auth: "configured",
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
