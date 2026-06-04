import { AsyncLocalStorage } from "node:async_hooks";
import Fastify from "fastify";
import {
  ArtifactSyncService,
  ContextBuilder,
  ControlPlaneError,
  ControlPlaneService,
  DEBATE_CHILD_RUN_KEY_METADATA_FIELD,
  DebateService,
  EventBus,
  EventSyncService,
  HOSTED_RUNTIME_CATALOG,
  HostedToolService,
  HostedRuntimeBridgeService,
  HostedRunService,
  HostedSandboxService,
  LocalPolicyGate,
  MessageRouter,
  createDisabledRealToolPolicyConfig,
  NodeCoordinatorService,
  PlacementService,
  RegistryService,
  RunService,
  RuntimeCapabilityService,
  RuntimeRunnerService,
  type ArtifactStore,
  type DebateExecutionStore,
  type DebateStore,
  type EventStore,
  type EvidenceStore,
  type MemoryStore,
  type MessageStore,
  type NodeAssignmentStore,
  type NodeStore,
  type PlacementStore,
  type RegistryStore,
  type RunQueuePort,
  type RunStore,
  type SessionStore,
  type RuntimeAdapter,
  type ToolQueuePort
} from "@switchyard/core";
import {
  registerArtifactRoutes,
  registerDebateRoutes,
  registerEnterpriseRoutes,
  registerErrorEnvelope,
  registerHostedAuthHooks,
  registerHostedToolRoutes,
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
  PostgresDebateExecutionStore,
  PostgresDebateStore,
  PostgresEvidenceStore,
  PostgresEventStore,
  PostgresMessageStore,
  PostgresNodeStore,
  PostgresPlacementStore,
  PostgresToolDispatchOutboxStore,
  PostgresHostedRuntimeBridgeCommandStore,
  PostgresHostedRuntimeBridgePayloadStore,
  PostgresToolInvocationStore,
  PostgresApprovalStore,
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

type Artifact = Parameters<ArtifactStore["create"]>[0];
type AuthContext = Awaited<ReturnType<ControlPlaneService["authenticateRequest"]>>;
type MemoryItem = Parameters<MemoryStore["create"]>[0];
type QuotaReservation = Awaited<ReturnType<PostgresControlPlaneStore["reserveQuota"]>>;
type Run = NonNullable<Awaited<ReturnType<RunStore["get"]>>>;
type SwitchyardEvent = Parameters<EventStore["append"]>[0];

export async function createServerApp(config: ServerConfig) {
  const serverAuthMode = config.serverAuthMode ?? "disabled";
  const controlPlaneStore = config.controlPlaneStore ?? "memory";
  const publicMetrics = typeof config.publicMetrics === "boolean"
    ? config.publicMetrics
    : (config.deploymentMode === "local" || config.deploymentMode === "test");
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const tools = config.tools ?? {
    hostedRealTools: "disabled" as const,
    connectedNodeRealTools: "disabled" as const,
    policySourceKind: "none" as const,
    policy: createDisabledRealToolPolicyConfig()
  };
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
  let controlPlaneRaw: ControlPlaneService | undefined;
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

    controlPlaneRaw = new ControlPlaneService({
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
  const controlPlane = controlPlaneRaw
    ? instrumentControlPlane(controlPlaneRaw, metrics)
    : undefined;

  const debateAuthScope = new AsyncLocalStorage<HostedDebateAuthScope>();
  const baseRuns = new PostgresRunStore(postgres);
  const baseEvents = new PostgresEventStore(postgres);
  const baseArtifacts = new PostgresArtifactStore(postgres);
  const runs: RunStore = wrapRunStoreForHostedDebateOwnership(baseRuns, {
    authScope: debateAuthScope,
    controlPlane: controlPlaneStoreInstance,
    logger: app.log
  });
  const events: EventStore = wrapEventStoreForHostedDebateOwnership(baseEvents, runs, {
    authScope: debateAuthScope,
    controlPlane: controlPlaneStoreInstance,
    logger: app.log
  });
  const sessions: SessionStore = new PostgresSessionStore(postgres);
  const artifacts: ArtifactStore = wrapArtifactStoreForHostedDebateOwnership(baseArtifacts, {
    authScope: debateAuthScope,
    controlPlane: controlPlaneStoreInstance,
    logger: app.log
  });
  const debates: DebateStore = wrapDebateStoreForHostedOwnership(new PostgresDebateStore(postgres), {
    authScope: debateAuthScope,
    controlPlane: controlPlaneStoreInstance,
    logger: app.log
  });
  const messages: MessageStore = new PostgresMessageStore(postgres);
  const evidence: EvidenceStore = new PostgresEvidenceStore(postgres);
  const debateJobs: DebateExecutionStore = wrapDebateExecutionStoreForHostedOwnership(
    new PostgresDebateExecutionStore(postgres) as DebateExecutionStore,
    {
      authScope: debateAuthScope,
      controlPlane,
      logger: app.log
    }
  );
  const memory: MemoryStore = createEmptyMemoryStore();
  const invocations = new PostgresToolInvocationStore(postgres);
  const approvals = new PostgresApprovalStore(postgres);
  const dispatchOutbox = new PostgresToolDispatchOutboxStore(postgres);
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

  const hostedRuntimeBridgeCommands = new PostgresHostedRuntimeBridgeCommandStore(postgres);
  const bridgeCommandPayloads = postgres
    ? new PostgresHostedRuntimeBridgePayloadStore(postgres)
    : createUnavailableBridgeCommandPayloadStore();
  const bridgeReservationScope = new Map<string, { accountId: string; tenantId: string; projectId: string }>();
  const hostedRuntimeBridge = new HostedRuntimeBridgeService({
    runs,
    sessions,
    approvals,
    commands: hostedRuntimeBridgeCommands,
    runtimeRunner: runner,
    commandPayloads: bridgeCommandPayloads,
    logger: {
      info: (event, details) => app.log.info({ event, ...details }),
      warn: (event, details) => app.log.warn({ event, ...details }),
      error: (event, details) => app.log.error({ event, ...details })
    },
    preflight: {
      authorizeRun: async ({ runId, auth }) => {
        if (!controlPlane) {
          throw new ControlPlaneError("auth_required", "auth_required");
        }
        const owned = await controlPlane.authorizeResource({
          auth,
          resourceType: "run",
          resourceId: runId,
          notFoundCode: "run_not_found"
        });
        if (!owned.ok) {
          throw new ControlPlaneError(owned.code, owned.reasonCode);
        }
      },
      authorizeApproval: async ({ approvalId, auth }) => {
        if (!controlPlane) {
          throw new ControlPlaneError("auth_required", "auth_required");
        }
        const owned = await controlPlane.authorizeResource({
          auth,
          resourceType: "approval",
          resourceId: approvalId,
          notFoundCode: "approval_not_found"
        });
        if (!owned.ok) {
          throw new ControlPlaneError(owned.code, owned.reasonCode);
        }
      },
      reserveBridgeQuota: async ({ auth }) => {
        if (!controlPlaneStoreInstance || !auth) {
          return {};
        }
        const quotas = resolveRuntimeBridgeQuota(auth.entitlement as Record<string, unknown>);
        const now = new Date().toISOString();
        const reservations: { hourlyReservationId?: string; activeReservationId?: string } = {};

        if (quotas.maxRuntimeBridgeCommandsPerHour > 0) {
          const reservation = await controlPlaneStoreInstance.reserveQuota({
            accountId: auth.account.id,
            tenantId: auth.tenant.id,
            projectId: auth.project.id,
            userId: auth.user.id,
            apiKeyId: auth.apiKey.id,
            quotaKind: "runtime_bridge_commands_per_hour",
            amount: 1,
            maxAllowed: quotas.maxRuntimeBridgeCommandsPerHour,
            windowMs: 60 * 60 * 1000,
            reservationTtlMs: 5 * 60 * 1000,
            reasonCode: "runtime_bridge_command",
            now
          });
          reservations.hourlyReservationId = reservation.id;
          bridgeReservationScope.set(reservation.id, {
            accountId: reservation.accountId,
            tenantId: reservation.tenantId,
            projectId: reservation.projectId
          });
        }
        if (quotas.maxActiveRuntimeBridgeCommands > 0) {
          const reservation = await controlPlaneStoreInstance.reserveQuota({
            accountId: auth.account.id,
            tenantId: auth.tenant.id,
            projectId: auth.project.id,
            userId: auth.user.id,
            apiKeyId: auth.apiKey.id,
            quotaKind: "active_runtime_bridge_commands",
            amount: 1,
            maxAllowed: quotas.maxActiveRuntimeBridgeCommands,
            windowMs: 24 * 60 * 60 * 1000,
            reservationTtlMs: 5 * 60 * 1000,
            reasonCode: "runtime_bridge_command",
            now
          });
          reservations.activeReservationId = reservation.id;
          bridgeReservationScope.set(reservation.id, {
            accountId: reservation.accountId,
            tenantId: reservation.tenantId,
            projectId: reservation.projectId
          });
        }
        return reservations;
      },
      finalizeBridgeQuota: async ({ reservationId, outcome, reasonCode }) => {
        if (!controlPlaneStoreInstance) {
          return;
        }
        const scope = bridgeReservationScope.get(reservationId);
        if (!scope) {
          return;
        }
        await controlPlaneStoreInstance.transitionQuotaReservation({
          reservationId,
          accountId: scope.accountId,
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          nextState: outcome,
          ...(reasonCode ? { reasonCode } : {}),
          now: new Date().toISOString()
        });
      },
      attachOwnership: async ({ resourceType, resourceId, runId, auth }) => {
        if (!controlPlane) {
          return;
        }
        const owned = await controlPlane.ensureOwnedOrAttachFromRun({
          auth,
          resourceType,
          resourceId,
          runId
        });
        if (!owned.ok) {
          throw new Error(owned.reasonCode);
        }
      },
      attachOwnershipFromRun: async ({ resourceType, resourceId, runId }) => {
        if (!controlPlaneStoreInstance) {
          return;
        }
        const runOwnership = await controlPlaneStoreInstance.getOwnership({
          resourceType: "run",
          resourceId: runId
        });
        if (!runOwnership) {
          throw new Error("approval_ownership_attach_failed");
        }
        await controlPlaneStoreInstance.attachOwnership({
          resourceType,
          resourceId,
          accountId: runOwnership.accountId,
          tenantId: runOwnership.tenantId,
          projectId: runOwnership.projectId,
          userId: runOwnership.userId,
          apiKeyId: runOwnership.apiKeyId,
          createdAt: new Date().toISOString()
        });
      },
      recordAudit: async (input) => {
        if (!controlPlane) {
          return;
        }
        const resourceId = input.commandId ?? input.approvalId ?? input.runId;
        await controlPlane.recordAudit({
          ...(input.auth ? { auth: input.auth } : {}),
          eventType: input.eventType,
          decision: input.decision,
          reasonCode: input.reasonCode,
          resourceType: input.commandId ? "runtime_bridge_command" : input.approvalId ? "approval" : "run",
          ...(resourceId ? { resourceId } : {}),
          ...(input.requestId ? { requestId: input.requestId } : {}),
          payload: input.payload ?? {}
        });
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
    providerRuntimeActivation: config.providerRuntimeActivation,
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
  const hostedDebateRunService: Pick<RunService, "createRun" | "startRun"> = {
    createRun: async (input) => {
      const placementFacts = input.runtimeMode
        ? (await registry.getRuntimeMode(input.runtimeMode))?.placement
        : undefined;
      if (placementFacts) {
        const result = await hostedRuns.createRun({
          ...input,
          placementFacts
        });
        return result.run;
      }
      return runService.createRun(input);
    },
    startRun: (runId) => runService.startRun(runId)
  };
  const contextBuilder = new ContextBuilder({
    memory,
    evidence,
    messages
  });
  const messageRouter = new MessageRouter({
    runs,
    messages,
    events,
    eventBus,
    logger: {
      info: (event, details) => app.log.info({ event, ...details }),
      warn: (event, details) => app.log.warn({ event, ...details }),
      error: (event, details) => app.log.error({ event, ...details })
    }
  });
  const debateServiceCore = new DebateService({
    debates,
    runs,
    runService: hostedDebateRunService,
    contextBuilder,
    messageRouter,
    evidence,
    events,
    artifacts,
    debateExecution: debateJobs,
    eventBus,
    artifactContent: {
      writeText: async (path, content) => {
        const result = await artifactContent.writeText(path, content, { contentType: "text/markdown; charset=utf-8" });
        return result.path;
      }
    },
    hosted: {
      authorizeEvidence: async ({ evidenceId, auth }) => {
        const item = await evidence.get(evidenceId);
        if (!item) {
          return { ok: false };
        }
        if (!item.debateId) {
          return { ok: true };
        }
        if (!controlPlane) {
          throw new ControlPlaneError("auth_required", "auth_required");
        }
        const owned = await controlPlane.authorizeResource({
          auth,
          resourceType: "debate",
          resourceId: item.debateId,
          notFoundCode: "debate_evidence_not_found_or_denied"
        });
        return { ok: owned.ok };
      }
    },
    logger: {
      info: (event, details) => app.log.info({ event, ...details }),
      warn: (event, details) => app.log.warn({ event, ...details }),
      error: (event, details) => app.log.error({ event, ...details })
    },
    defaultCwd: process.cwd()
  });
  const debateService = wrapDebateServiceForHostedAdmission(debateServiceCore, {
    authScope: debateAuthScope,
    controlPlane,
    controlPlaneStore: controlPlaneStoreInstance,
    logger: app.log
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

  const hostedToolsDeps: ConstructorParameters<typeof HostedToolService>[0] = {
    runs,
    events,
    approvals,
    invocations,
    policy: new LocalPolicyGate(tools.policy),
    dispatchOutbox,
    dispatch: async (input) => {
      if (input.target.placement === "hosted") {
        if (!hasToolQueueSupport(queue as RunQueuePort & Partial<ToolQueuePort>)) {
          throw new Error("tool_dispatch_unavailable");
        }
        const job = await (queue as RunQueuePort & ToolQueuePort).enqueueTool({
          approvalId: input.approvalId,
          toolInvocationId: input.invocation.id,
          runId: input.invocation.runId ?? "",
          placement: "hosted",
          toolType: input.invocation.type,
          executionPlanHash: input.executionPlanHash,
          idempotencyKey: input.idempotencyKey
        });
        return { dispatchId: job.jobId, target: "hosted" as const };
      }

      const assignment = await coordinator.createToolAssignment({
        runId: input.invocation.runId ?? "",
        toolInvocationId: input.invocation.id,
        requiredCapability: `tool.${input.invocation.type}`,
        idempotencyKey: input.idempotencyKey,
        ...(input.target.nodeId ? { nodeId: input.target.nodeId } : {})
      });
      return { dispatchId: assignment.id, target: "connected_local_node" as const };
    },
    ...(controlPlaneStoreInstance
      ? {
          preflight: {
            attachOwnership: async (input: { resourceType: "tool_invocation" | "approval"; resourceId: string; runId: string }) => {
              const runOwnership = await controlPlaneStoreInstance.getOwnership({
                resourceType: "run",
                resourceId: input.runId
              });
              if (!runOwnership) {
                throw new Error("tool_store_unavailable");
              }
              await controlPlaneStoreInstance.attachOwnership({
                resourceType: input.resourceType,
                resourceId: input.resourceId,
                accountId: runOwnership.accountId,
                tenantId: runOwnership.tenantId,
                projectId: runOwnership.projectId,
                userId: runOwnership.userId,
                apiKeyId: runOwnership.apiKeyId,
                createdAt: new Date().toISOString()
              });
            },
            recordAudit: async (input: {
              runId: string;
              toolInvocationId?: string;
              approvalId?: string;
              eventType: string;
              reasonCode: string;
              decision: "allow" | "deny" | "error";
              payload: Record<string, unknown>;
            }) => {
              const runOwnership = await controlPlaneStoreInstance.getOwnership({
                resourceType: "run",
                resourceId: input.runId
              });
              if (!runOwnership) {
                return;
              }
              await controlPlaneStoreInstance.appendAuditEvent({
                accountId: runOwnership.accountId,
                tenantId: runOwnership.tenantId,
                projectId: runOwnership.projectId,
                actorType: "system",
                eventType: input.eventType,
                decision: input.decision,
                reasonCode: input.reasonCode,
                resourceType: input.toolInvocationId ? "tool_invocation" : input.approvalId ? "approval" : "run",
                resourceId: input.toolInvocationId ?? input.approvalId ?? input.runId,
                payload: input.payload,
                createdAt: new Date().toISOString()
              });
            }
          }
        }
      : {})
  };
  const hostedTools = new HostedToolService(hostedToolsDeps);

  app.addHook("onRequest", async (request, reply) => {
    if (serverAuthMode !== "api_key" || !isHostedDebateRoute(request.method, request.url)) {
      return;
    }
    if (hasAuthorizationHeader(request.headers)) {
      return;
    }
    metrics.inc("auth.required");
    return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
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
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        return sendHttpError(reply, error.code, error.reasonCode, [{ path: "reasonCode", issue: error.reasonCode }]);
      }
      throw error;
    }
  });

  const runtimeBridgeEnabled = config.hostedRuntimeAllowlist.includes("claude_code.sdk")
    || config.hostedRuntimeAllowlist.includes("opencode.acp");

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
      controlPlane: readinessControlPlane,
      runtimeBridge: {
        enabled: runtimeBridgeEnabled,
        commandStore: hostedRuntimeBridgeCommands,
        commandOutbox: hostedRuntimeBridgeCommands,
        approvalOwnership: controlPlaneStoreInstance,
        quota: controlPlaneStoreInstance,
        audit: controlPlaneStoreInstance,
        routeAuth: controlPlane,
        workerReadiness: {
          claim: false,
          adapterCapability: false,
          sessionReconciliation: false,
          approvalSender: false
        }
      }
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
    ...(controlPlane ? { controlPlane } : {}),
    hostedRuntimeBridge: {
      createInputCommand: hostedRuntimeBridge.createInputCommand.bind(hostedRuntimeBridge)
    }
  });

  registerDebateRoutes(app, {
    debateService,
    debates,
    events,
    eventBus,
    debateJobs,
    ...(controlPlane ? { controlPlane } : {}),
    requireHostedAuth: serverAuthMode === "api_key",
    routeMode: "hosted",
    authorizeDebateRead: async ({ debateId, auth }) => {
      if (!controlPlane) {
        throw new ControlPlaneError("auth_required", "auth_required");
      }
      const owned = await controlPlane.authorizeResource({
        auth,
        resourceType: "debate",
        resourceId: debateId,
        notFoundCode: "debate_not_found"
      });
      return { ok: owned.ok };
    },
    enqueueDebateJob: async ({ debateId, auth, requestId }) => {
      if (!controlPlane) {
        throw new ControlPlaneError("auth_required", "auth_required");
      }
      const owned = await controlPlane.authorizeResource({
        auth,
        resourceType: "debate",
        resourceId: debateId,
        notFoundCode: "hosted_debate_ownership_attach_failed"
      });
      if (!owned.ok) {
        throw new ControlPlaneError("hosted_debate_ownership_attach_failed", "debate_job_ownership_attach_failed");
      }
      await recordHostedDebateAudit(controlPlane, {
        auth,
        eventType: "hosted.debate.job.enqueued",
        decision: "allow",
        reasonCode: "debate_job_enqueued",
        resourceType: "debate",
        resourceId: debateId,
        requestId,
        payload: { route: "POST /debates" }
      });
    }
  });

  if (controlPlane && controlPlaneStoreInstance) {
    registerHostedToolRoutes(app, {
      hostedTools,
      runs,
      invocations,
      approvals,
      controlPlane,
      controlPlaneStore: controlPlaneStoreInstance,
      hostedRuntimeBridge: {
        resolveRuntimeApproval: hostedRuntimeBridge.resolveRuntimeApproval.bind(hostedRuntimeBridge)
      }
    });
  }

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

interface HostedDebateAuthScope {
  auth: AuthContext;
  requestId?: string | undefined;
}

interface HostedDebateOwnershipDeps {
  authScope: AsyncLocalStorage<HostedDebateAuthScope>;
  controlPlane: PostgresControlPlaneStore | undefined;
  logger: {
    warn(input: Record<string, unknown>): void;
  };
}

type OwnedResourceType = Parameters<PostgresControlPlaneStore["attachOwnership"]>[0]["resourceType"];

function wrapDebateStoreForHostedOwnership(store: DebateStore, deps: HostedDebateOwnershipDeps): DebateStore {
  return {
    async create(debate) {
      await attachHostedDebateOwnership(deps, "debate", debate.id);
      return store.create(debate);
    },
    get: (id) => store.get(id),
    update: (debate) => store.update(debate)
  };
}

function wrapRunStoreForHostedDebateOwnership(store: RunStore, deps: HostedDebateOwnershipDeps): RunStore {
  return {
    async create(run) {
      if (isDebateChildRun(run)) {
        await attachHostedDebateOwnership(deps, "run", run.id);
      }
      return store.create(run);
    },
    get: (id) => store.get(id),
    async update(run) {
      return store.update(run);
    },
    list: (filter) => store.list(filter),
    ...(store.findByDebateChildRunKey
      ? { findByDebateChildRunKey: (key: string) => store.findByDebateChildRunKey!(key) }
      : {}),
    ...(store.updatePreparedMetadataIfMatch
      ? { updatePreparedMetadataIfMatch: (input: Parameters<NonNullable<RunStore["updatePreparedMetadataIfMatch"]>>[0]) => store.updatePreparedMetadataIfMatch!(input) }
      : {})
  };
}

function wrapEventStoreForHostedDebateOwnership(
  store: EventStore,
  runs: RunStore,
  deps: HostedDebateOwnershipDeps
): EventStore {
  return {
    async append(event) {
      if (event.debateId || await isDebateChildRunEvent(event, runs)) {
        await attachHostedDebateOwnership(deps, "run_event", event.id);
      }
      return store.append(event);
    },
    listByRun: (runId) => store.listByRun(runId),
    listByDebate: (debateId) => store.listByDebate(debateId)
  };
}

function wrapArtifactStoreForHostedDebateOwnership(store: ArtifactStore, deps: HostedDebateOwnershipDeps): ArtifactStore {
  return {
    async create(artifact) {
      if (artifact.debateId) {
        await attachHostedDebateOwnership(deps, "artifact", artifact.id);
      }
      return store.create(artifact);
    },
    get: (id) => store.get(id),
    update: (artifact) => store.update(artifact),
    listByRun: (runId) => store.listByRun(runId),
    listByDebate: (debateId) => store.listByDebate(debateId)
  };
}

function wrapDebateExecutionStoreForHostedOwnership(
  store: DebateExecutionStore,
  deps: {
    authScope: AsyncLocalStorage<HostedDebateAuthScope>;
    controlPlane: ControlPlaneService | undefined;
    logger: { warn(input: Record<string, unknown>): void };
  }
): DebateExecutionStore {
  return {
    async enqueue(input) {
      const scope = deps.authScope.getStore();
      const auth = scope?.auth;
      if (auth && deps.controlPlane) {
        const owned = await deps.controlPlane.authorizeResource({
          auth,
          resourceType: "debate",
          resourceId: input.debateId,
          notFoundCode: "hosted_debate_ownership_attach_failed"
        });
        if (!owned.ok) {
          deps.logger.warn({
            event: "hosted.debate.ownership.attach_failed",
            resourceType: "debate_job",
            reasonCode: "debate_job_parent_not_owned"
          });
          throw new ControlPlaneError("hosted_debate_ownership_attach_failed", "debate_job_ownership_attach_failed");
        }
        return store.enqueue({
          ...input,
          accountId: input.accountId ?? auth.account.id,
          tenantId: input.tenantId ?? auth.tenant.id,
          projectId: input.projectId ?? auth.project.id,
          userId: input.userId ?? auth.user.id,
          apiKeyId: input.apiKeyId ?? auth.apiKey.id
        });
      }
      return store.enqueue(input);
    },
    claim: (options) => store.claim(options),
    release: (jobId, update) => store.release(jobId, update),
    complete: (jobId, now) => store.complete(jobId, now),
    fail: (jobId, failure) => store.fail(jobId, failure),
    recoverStaleClaims: (options) => store.recoverStaleClaims(options),
    get: (id) => store.get(id),
    stats: () => store.stats(),
    linkPendingRun: (jobId, key, runId, expectedStage) => store.linkPendingRun(jobId, key, runId, expectedStage),
    findPendingRunByKey: (key) => store.findPendingRunByKey(key)
  };
}

function wrapDebateServiceForHostedAdmission(
  service: DebateService,
  deps: {
    authScope: AsyncLocalStorage<HostedDebateAuthScope>;
    controlPlane: ControlPlaneService | undefined;
    controlPlaneStore: PostgresControlPlaneStore | undefined;
    logger: { warn(input: Record<string, unknown>): void; info(input: Record<string, unknown>): void };
  }
): DebateService {
  return {
    create: async (input: unknown, options: Parameters<DebateService["create"]>[1] = {}) => {
      const auth = options.auth;
      if (!auth) {
        return service.create(input, options);
      }
      const reservations = await reserveHostedDebateQuota(deps.controlPlaneStore, auth);
      return deps.authScope.run({ auth, requestId: options.requestId }, async () => {
        try {
          const result = await service.create(input, options);
          await finalizeHostedDebateAdmissionQuota(deps.controlPlaneStore, auth, reservations, options.wait ? "wait_terminal" : "accepted_async");
          await recordHostedDebateAudit(deps.controlPlane, {
            auth,
            eventType: "hosted.debate.admission.allowed",
            decision: "allow",
            reasonCode: "debate_admitted",
            resourceType: "debate",
            resourceId: result.debate.id,
            requestId: options.requestId,
            payload: {
              wait: options.wait === true,
              runtimeModes: result.debate.participants.map((participant) => {
                const runtimeMode = (participant as { runtimeMode?: unknown }).runtimeMode;
                return typeof runtimeMode === "string" ? runtimeMode : "unknown";
              })
            }
          });
          return result;
        } catch (error) {
          await failHostedDebateAdmissionQuota(deps.controlPlaneStore, auth, reservations);
          await recordHostedDebateAudit(deps.controlPlane, {
            auth,
            eventType: "hosted.debate.admission.denied",
            decision: "deny",
            reasonCode: error instanceof ControlPlaneError ? error.reasonCode : errorCodeOf(error),
            requestId: options.requestId,
            payload: { code: errorCodeOf(error) }
          });
          throw error;
        }
      });
    },
    execute: (debateId, options) => service.execute(debateId, options),
    inspect: (debateId) => service.inspect(debateId),
    listEvents: (debateId) => service.listEvents(debateId),
    processExecutionJob: (job) => service.processExecutionJob(job)
  } as DebateService;
}

async function attachHostedDebateOwnership(
  deps: HostedDebateOwnershipDeps,
  resourceType: OwnedResourceType,
  resourceId: string
): Promise<void> {
  const scope = deps.authScope.getStore();
  const auth = scope?.auth;
  if (!auth || !deps.controlPlane) {
    return;
  }
  try {
    await deps.controlPlane.attachOwnership({
      resourceType,
      resourceId,
      accountId: auth.account.id,
      tenantId: auth.tenant.id,
      projectId: auth.project.id,
      userId: auth.user.id,
      apiKeyId: auth.apiKey.id,
      createdAt: new Date().toISOString()
    });
  } catch {
    deps.logger.warn({
      event: "hosted.debate.ownership.attach_failed",
      resourceType,
      reasonCode: "ownership_attach_failed"
    });
    throw new ControlPlaneError("hosted_debate_ownership_attach_failed", "ownership_attach_failed");
  }
}

function isDebateChildRun(run: Run): boolean {
  if (typeof run.metadata?.[DEBATE_CHILD_RUN_KEY_METADATA_FIELD] === "string") {
    return true;
  }
  return typeof run.metadata?.["debateId"] === "string" && typeof run.metadata?.["debateRunKind"] === "string";
}

async function isDebateChildRunEvent(event: SwitchyardEvent, runs: RunStore): Promise<boolean> {
  if (!event.runId) {
    return false;
  }
  const run = await runs.get(event.runId);
  return run ? isDebateChildRun(run) : false;
}

interface HostedDebateQuotaReservations {
  hourly?: QuotaReservation;
  active?: QuotaReservation;
}

async function reserveHostedDebateQuota(
  controlPlaneStore: PostgresControlPlaneStore | undefined,
  auth: AuthContext
): Promise<HostedDebateQuotaReservations> {
  if (!controlPlaneStore) {
    return {};
  }
  const quotas = resolveDebateQuota(auth.entitlement as Record<string, unknown>);
  if (quotas.maxDebatesPerHour <= 0 && quotas.maxActiveDebates <= 0) {
    return {};
  }
  const now = new Date().toISOString();
  const out: HostedDebateQuotaReservations = {};
  if (quotas.maxDebatesPerHour > 0) {
    out.hourly = await controlPlaneStore.reserveQuota({
      accountId: auth.account.id,
      tenantId: auth.tenant.id,
      projectId: auth.project.id,
      userId: auth.user.id,
      apiKeyId: auth.apiKey.id,
      quotaKind: "debates_per_hour",
      amount: 1,
      maxAllowed: quotas.maxDebatesPerHour,
      windowMs: 60 * 60 * 1000,
      reservationTtlMs: 5 * 60 * 1000,
      reasonCode: "debate_create",
      now
    });
  }
  if (quotas.maxActiveDebates > 0) {
    out.active = await controlPlaneStore.reserveQuota({
      accountId: auth.account.id,
      tenantId: auth.tenant.id,
      projectId: auth.project.id,
      userId: auth.user.id,
      apiKeyId: auth.apiKey.id,
      quotaKind: "active_debates",
      amount: 1,
      maxAllowed: quotas.maxActiveDebates,
      windowMs: 24 * 60 * 60 * 1000,
      reservationTtlMs: 5 * 60 * 1000,
      reasonCode: "debate_active",
      now
    });
  }
  return out;
}

async function finalizeHostedDebateAdmissionQuota(
  controlPlaneStore: PostgresControlPlaneStore | undefined,
  auth: AuthContext,
  reservations: HostedDebateQuotaReservations,
  outcome: "accepted_async" | "wait_terminal"
): Promise<void> {
  if (!controlPlaneStore) {
    return;
  }
  const now = new Date().toISOString();
  if (reservations.hourly) {
    await controlPlaneStore.transitionQuotaReservation({
      reservationId: reservations.hourly.id,
      accountId: auth.account.id,
      tenantId: auth.tenant.id,
      projectId: auth.project.id,
      nextState: "consumed",
      reasonCode: outcome,
      now
    });
  }
  if (reservations.active && outcome === "wait_terminal") {
    await controlPlaneStore.transitionQuotaReservation({
      reservationId: reservations.active.id,
      accountId: auth.account.id,
      tenantId: auth.tenant.id,
      projectId: auth.project.id,
      nextState: "released",
      reasonCode: "debate_terminal_wait",
      now
    });
  }
}

async function failHostedDebateAdmissionQuota(
  controlPlaneStore: PostgresControlPlaneStore | undefined,
  auth: AuthContext,
  reservations: HostedDebateQuotaReservations
): Promise<void> {
  if (!controlPlaneStore) {
    return;
  }
  const now = new Date().toISOString();
  for (const reservation of [reservations.hourly, reservations.active]) {
    if (!reservation) {
      continue;
    }
    await controlPlaneStore.transitionQuotaReservation({
      reservationId: reservation.id,
      accountId: auth.account.id,
      tenantId: auth.tenant.id,
      projectId: auth.project.id,
      nextState: "failed",
      reasonCode: "debate_admission_failed",
      now
    }).catch(() => undefined);
  }
}

function resolveDebateQuota(entitlement: Record<string, unknown>): {
  maxDebatesPerHour: number;
  maxActiveDebates: number;
} {
  const snapshot = asRecord(entitlement["quotas"]) ?? entitlement;
  return {
    maxDebatesPerHour: toPositiveNumber(snapshot["maxDebatesPerHour"]),
    maxActiveDebates: toPositiveNumber(snapshot["maxActiveDebates"])
  };
}

async function recordHostedDebateAudit(
  controlPlane: ControlPlaneService | undefined,
  input: {
    auth: AuthContext;
    eventType: string;
    decision: "allow" | "deny" | "error";
    reasonCode?: string | undefined;
    resourceType?: string | undefined;
    resourceId?: string | undefined;
    requestId?: string | undefined;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  if (!controlPlane) {
    return;
  }
  await controlPlane.recordAudit({
    auth: input.auth,
    eventType: input.eventType,
    decision: input.decision,
    payload: input.payload,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    ...(input.resourceType ? { resourceType: input.resourceType } : {}),
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {})
  });
}

function errorCodeOf(error: unknown): string {
  if (error instanceof ControlPlaneError) {
    return error.code;
  }
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "internal_error";
}

function createEmptyMemoryStore(): MemoryStore {
  const items = new Map<string, MemoryItem>();
  return {
    async create(item) {
      items.set(item.id, item);
      return item;
    },
    async get(id) {
      return items.get(id);
    },
    async update(item) {
      items.set(item.id, item);
      return item;
    },
    async list() {
      return { memory: [], nextCursor: null };
    },
    async search() {
      return { memory: [], nextCursor: null };
    }
  };
}

function instrumentQueue(
  queue: RunQueuePort & Partial<ToolQueuePort> & { close?: () => Promise<void> },
  metrics: HostedMetrics
): RunQueuePort & Partial<ToolQueuePort> & { close?: () => Promise<void> } {
  const enqueue = queue.enqueue.bind(queue);
  const claim = queue.claim.bind(queue);
  const ack = queue.ack.bind(queue);
  const fail = queue.fail.bind(queue);
  const retry = queue.retry.bind(queue);
  const discard = queue.discard.bind(queue);
  const getJob = queue.getJob.bind(queue);
  const recoverStaleClaims = queue.recoverStaleClaims.bind(queue);
  const stats = queue.stats.bind(queue);

  queue.enqueue = async (payload, options) => {
    const out = await enqueue(payload, options);
    metrics.inc("queue.enqueue");
    return out;
  };
  queue.claim = async (options) => {
    const out = await claim(options);
    if (out) {
      metrics.inc("queue.claim");
    }
    return out;
  };
  queue.ack = async (jobId) => {
    metrics.inc("queue.ack");
    return ack(jobId);
  };
  queue.fail = async (jobId, error) => {
    metrics.inc("queue.failed");
    if (error.reasonCode === "worker_retry_exhausted") {
      metrics.inc("queue.exhausted");
    }
    return fail(jobId, error);
  };
  queue.retry = async (jobId) => {
    metrics.inc("queue.retry");
    return retry(jobId);
  };
  queue.discard = (jobId) => discard(jobId);
  queue.getJob = (jobId) => getJob(jobId);
  queue.recoverStaleClaims = (options) => recoverStaleClaims(options);
  queue.stats = () => stats();

  if (hasToolQueueSupport(queue)) {
    const enqueueTool = queue.enqueueTool.bind(queue);
    const claimTool = queue.claimTool.bind(queue);
    const ackTool = queue.ackTool.bind(queue);
    const failTool = queue.failTool.bind(queue);
    const recoverStaleToolClaims = queue.recoverStaleToolClaims.bind(queue);

    queue.enqueueTool = async (payload, options) => {
      const out = await enqueueTool(payload, options);
      metrics.inc("queue.enqueue");
      return out;
    };
    queue.claimTool = async (options) => {
      const out = await claimTool(options);
      if (out) {
        metrics.inc("queue.claim");
      }
      return out;
    };
    queue.ackTool = async (jobId) => {
      metrics.inc("queue.ack");
      return ackTool(jobId);
    };
    queue.failTool = async (jobId, error) => {
      metrics.inc("queue.failed");
      if (error.reasonCode === "worker_retry_exhausted") {
        metrics.inc("queue.exhausted");
      }
      return failTool(jobId, error);
    };
    queue.recoverStaleToolClaims = (options) => recoverStaleToolClaims(options);
  }

  return queue;
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

function isHostedDebateRoute(method: string, url: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod !== "POST" && normalizedMethod !== "GET") {
    return false;
  }
  const [path] = url.split("?", 1);
  const normalized = path && path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  if (normalizedMethod === "POST") {
    return normalized === "/debates";
  }
  if (!normalized) {
    return false;
  }
  return /^\/debates\/[^/]+(?:\/events)?$/.test(normalized);
}

function hasAuthorizationHeader(headers: Record<string, string | string[] | undefined>): boolean {
  const value = headers["authorization"];
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return Array.isArray(value) && value.some((entry) => entry.trim().length > 0);
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

function hasToolQueueSupport(queue: RunQueuePort & Partial<ToolQueuePort>): queue is RunQueuePort & ToolQueuePort {
  return typeof queue.enqueueTool === "function"
    && typeof queue.claimTool === "function"
    && typeof queue.ackTool === "function"
    && typeof queue.failTool === "function"
    && typeof queue.recoverStaleToolClaims === "function";
}

function instrumentControlPlane(controlPlane: ControlPlaneService, metrics: HostedMetrics): ControlPlaneService {
  const proxy = new Proxy(controlPlane, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const methodName = String(property);
        try {
          const result = value.apply(target, args);
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<unknown>)
              .then((resolved) => {
                captureControlPlaneSuccessMetric(methodName, resolved, metrics);
                return resolved;
              })
              .catch((error) => {
                if (error instanceof ControlPlaneError) {
                  captureControlPlaneCodeMetric(error.code, metrics);
                  if (methodName === "recordAudit") {
                    metrics.inc("audit.failed");
                  }
                }
                throw error;
              });
          }
          captureControlPlaneSuccessMetric(methodName, result, metrics);
          return result;
        } catch (error) {
          if (error instanceof ControlPlaneError) {
            captureControlPlaneCodeMetric(error.code, metrics);
            if (methodName === "recordAudit") {
              metrics.inc("audit.failed");
            }
          }
          throw error;
        }
      };
    }
  });
  return proxy as unknown as ControlPlaneService;
}

function captureControlPlaneSuccessMetric(methodName: string, result: unknown, metrics: HostedMetrics): void {
  if (methodName === "authenticateRequest") {
    metrics.inc("auth.succeeded");
  }
  if (
    methodName === "preflightRunCreate" ||
    methodName === "preflightArtifactContentRead" ||
    methodName === "preflightNodeRegister"
  ) {
    metrics.inc("quota.reserved");
  }
  if (methodName === "releaseQuotaReservation") {
    metrics.inc("quota.released");
  }
  if (methodName === "recordAudit" && isRecordAuditResult(result)) {
    metrics.inc(result.ok ? "audit.appended" : "audit.failed");
  }
  if (methodName === "authorizeResource" && isAuthorizeResourceResult(result) && !result.ok) {
    captureControlPlaneCodeMetric(result.code, metrics);
  }
}

function captureControlPlaneCodeMetric(code: ControlPlaneError["code"], metrics: HostedMetrics): void {
  if (code === "auth_required") {
    metrics.inc("auth.required");
    return;
  }
  if (code === "auth_failed" || code === "auth_store_unavailable") {
    metrics.inc("auth.failed");
    return;
  }
  if (code === "auth_conflict") {
    metrics.inc("auth.conflict");
    return;
  }
  if (code === "tenant_access_denied" || code === "project_access_denied") {
    metrics.inc("tenant.denied");
    return;
  }
  if (code === "entitlement_denied") {
    metrics.inc("entitlement.denied");
    return;
  }
  if (code === "quota_exceeded") {
    metrics.inc("quota.denied");
    return;
  }
  if (code === "audit_log_unavailable") {
    metrics.inc("audit.failed");
  }
}

function isRecordAuditResult(value: unknown): value is { ok: boolean } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { ok?: unknown };
  return typeof candidate.ok === "boolean";
}

function isAuthorizeResourceResult(value: unknown): value is { ok: boolean; code: ControlPlaneError["code"] } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { ok?: unknown; code?: unknown };
  return typeof candidate.ok === "boolean" && typeof candidate.code === "string";
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
        allowHostedTools: Boolean(entitlements["allowHostedTools"]),
        allowConnectedNodeTools: Boolean(entitlements["allowConnectedNodeTools"]),
        allowedToolTypes: arrayStrings(entitlements["allowedToolTypes"]) as NodeAuthContext["entitlement"]["entitlements"]["allowedToolTypes"],
        allowToolArtifactContentRead: Boolean(entitlements["allowToolArtifactContentRead"]),
        allowArtifactContentRead: Boolean(entitlements["allowArtifactContentRead"]),
        allowMetricsRead: Boolean(entitlements["allowMetricsRead"]),
        allowAuditRead: Boolean(entitlements["allowAuditRead"])
      },
      quotas: {
        maxRunsPerHour: toNumber(quotas["maxRunsPerHour"]),
        maxActiveRuns: toNumber(quotas["maxActiveRuns"]),
        maxRunTimeoutSeconds: toNumber(quotas["maxRunTimeoutSeconds"]),
        maxConnectedNodes: toNumber(quotas["maxConnectedNodes"]),
        maxArtifactContentReadBytesPerHour: toNumber(quotas["maxArtifactContentReadBytesPerHour"]),
        maxToolInvocationsPerHour: toNumber(quotas["maxToolInvocationsPerHour"]),
        maxActiveToolInvocations: toNumber(quotas["maxActiveToolInvocations"]),
        maxToolArtifactBytesPerHour: toNumber(quotas["maxToolArtifactBytesPerHour"]),
        maxRuntimeBridgeCommandsPerHour: toNumber(quotas["maxRuntimeBridgeCommandsPerHour"]),
        maxActiveRuntimeBridgeCommands: toNumber(quotas["maxActiveRuntimeBridgeCommands"])
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

function createUnavailableBridgeCommandPayloadStore(): {
  put(input: { commandId: string; payload: Record<string, unknown> }): Promise<void>;
  get(commandId: string): Promise<Record<string, unknown> | undefined>;
  delete(commandId: string): Promise<void>;
} {
  return {
    async put() {
      throw new Error("hosted_runtime_bridge_store_unavailable");
    },
    async get() {
      return undefined;
    },
    async delete() {
      return;
    }
  };
}

function resolveRuntimeBridgeQuota(entitlement: Record<string, unknown>): {
  maxRuntimeBridgeCommandsPerHour: number;
  maxActiveRuntimeBridgeCommands: number;
} {
  const snapshot = asRecord(entitlement["quotas"]) ?? entitlement;
  return {
    maxRuntimeBridgeCommandsPerHour: toPositiveNumber(snapshot["maxRuntimeBridgeCommandsPerHour"]),
    maxActiveRuntimeBridgeCommands: toPositiveNumber(snapshot["maxActiveRuntimeBridgeCommands"])
  };
}

function toPositiveNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}
