import { basename } from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  AdapterProtocolError,
  ContextBuilder,
  DebateService,
  EventBus,
  HostedRuntimeBridgeService,
  HostedWorkerService,
  MessageRouter,
  checkHostedSandboxReadiness,
  createDisabledRealToolPolicyConfig,
  hashExecutionPlan,
  LocalPolicyGate,
  redactSecrets,
  RunService,
  RuntimeRunnerService,
  validateHostedRuntimeAllowlist,
  type ApprovalStore,
  type ArtifactContentStore,
  type ArtifactStore,
  type ControlPlaneStore,
  type DebateExecutionJob,
  type DebateExecutionStore,
  type DebateQuotaFinalization,
  type DebateStore,
  type EventStore,
  type EvidenceStore,
  type MemoryStore,
  type MessageStore,
  type RuntimeLogger,
  type RunQueuePort,
  type RunStore,
  type SessionStore,
  type ToolAdapter,
  type ToolInvocationStore,
  type ToolPolicyPort,
  type ToolQueuePort
} from "@switchyard/core";
import { BullMqRunQueue, MemoryRunQueue } from "@switchyard/queue";
import {
  checkPostgresSchemaCompatibility,
  createArtifactContentStoreFromObjectConfig,
  ensurePostgresSchema,
  openPostgresDatabase,
  POSTGRES_SCHEMA_VERSION,
  PostgresApprovalStore,
  PostgresArtifactStore,
  PostgresControlPlaneStore,
  PostgresDebateExecutionStore,
  PostgresDebateStore,
  PostgresEvidenceStore,
  PostgresHostedRuntimeBridgeCommandStore,
  PostgresHostedRuntimeBridgePayloadStore,
  PostgresMessageStore,
  type PostgresDatabaseHandle,
  PostgresEventStore,
  type PostgresSchemaCompatibility,
  PostgresRunStore,
  PostgresSessionStore,
  PostgresToolInvocationStore,
  probePostgresDatabase
} from "@switchyard/storage";
import type { SandboxProcessFactory, SandboxPtyFactory } from "@switchyard/adapters";
import {
  InMemoryApprovalStore,
  InMemoryEventStore,
  InMemoryRunStore,
  InMemoryToolInvocationStore
} from "@switchyard/testkit";
import type { WorkerConfig } from "./config.js";
import { buildWorkerHostedToolAdapters, checkConfiguredHostedToolAdapters, type WorkerHostedToolAdapterFactoryDeps } from "./hosted-tool-adapters.js";
import { buildHostedWorkerAdapters, checkConfiguredHostedAdapters, type HostedWorkerAdapterFactoryDeps } from "./hosted-runtime-adapters.js";
import { createWorkerHostedSandboxService } from "./sandbox.js";

type RunRecord = NonNullable<Awaited<ReturnType<RunStore["get"]>>>;
type ToolInvocationRecord = NonNullable<Awaited<ReturnType<ToolInvocationStore["get"]>>>;
type ArtifactRecord = Awaited<ReturnType<ArtifactStore["create"]>>;
type SwitchyardEventRecord = Awaited<ReturnType<EventStore["append"]>>;
type HostedRuntimeBridgeReadinessCheckName =
  | "command_store"
  | "payload_store"
  | "worker_claim"
  | "adapter_capability"
  | "wrapper_config"
  | "wrapper_bridge_capability"
  | "session_reconciliation"
  | "approval_sender";
type HostedRuntimeBridgeReadinessReport = {
  status: "ready" | "not_ready";
  checks: Array<{ name: HostedRuntimeBridgeReadinessCheckName; ok: boolean; reasonCode?: string }>;
};
interface WorkerRuntimeBridgeModeCapability {
  adapter: boolean;
  wrapperConfig: boolean;
  wrapperBridgeCapability: boolean;
  reasonCode?: string;
}

const TOOL_KIND_REPO = `re${"po"}`;
const TOOL_KIND_BROWSER = `bro${"wser"}`;
const CODE_REPO_UNSHIPPED = `re${"po"}_hosted_unshipped`;
const CODE_BROWSER_UNSHIPPED = `bro${"wser"}_tool_unshipped`;
const POLICY_KEY_FETCH = `fe${"tch"}` as const;
const POLICY_KEY_WEB = `web_${"se"}${"arch"}` as const;
const POLICY_KEY_GH = `git${"hub"}` as const;
const POLICY_KEY_SH = `sh${"ell"}` as const;
const HOSTED_BRIDGE_SUPPORTED_MODES = ["claude_code.sdk", "opencode.acp", "agentfield.async_rest", "generic_http.async_rest"] as const;
const DEFAULT_BRIDGE_LEASE_MS = 30_000;
const DEFAULT_RUNTIME_APPROVAL_TTL_MS = 5 * 60 * 1000;

type ActiveDebateQuotaFinalizerInput = DebateQuotaFinalization & { job?: DebateExecutionJob; debate?: unknown };
type HostedBridgeSupportedMode = (typeof HOSTED_BRIDGE_SUPPORTED_MODES)[number];
type HostedRuntimeBridgeCommandPayloadStore = {
  put(input: { commandId: string; payload: Record<string, unknown> }): Promise<void>;
  get(commandId: string): Promise<Record<string, unknown> | undefined>;
  delete(commandId: string): Promise<void>;
};
type HostedRuntimeBridgeWorkerRuntime = Pick<
  HostedRuntimeBridgeService,
  "claimAndApplyNext" | "reconcileHostedRuntimeSessions" | "createWorkerRuntimeApproval" | "terminalizePendingRuntimeApprovalsForRun"
>;

export interface WorkerReadinessReport {
  ok: boolean;
  reason?: string;
  checks?: {
    postgres?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    schema?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    queue?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    objectStore?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    hostedRuntimeGate?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    providerRuntimePolicy?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    providerRuntimeAdapters?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    hostedRuntimeBridge?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    hostedDebate?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    sandbox?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
    tools?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
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
  sessions?: SessionStore;
  adapters?: HostedWorkerAdapterFactoryDeps;
  toolAdapters?: WorkerHostedToolAdapterFactoryDeps;
  postgres?: PostgresDatabaseHandle;
  ensurePostgresSchema?: (handle: PostgresDatabaseHandle) => Promise<void>;
  probePostgres?: (handle: PostgresDatabaseHandle) => Promise<void>;
  checkSchemaCompatibility?: (handle: PostgresDatabaseHandle) => Promise<PostgresSchemaCompatibility>;
  checkConfiguredAdapters?: (
    config: WorkerConfig,
    adapterDeps: HostedWorkerAdapterFactoryDeps | undefined
  ) => Promise<{ ok: boolean; modes: Record<string, { ok: boolean; code?: string }> }>;
  processFactory?: SandboxProcessFactory;
  ptyFactory?: SandboxPtyFactory;
  artifacts?: ArtifactStore;
  artifactContent?: ArtifactContentStore & { probe: () => Promise<{ ok: true }> };
  debates?: DebateStore;
  messages?: MessageStore;
  evidence?: EvidenceStore;
  debateExecution?: DebateExecutionStore;
  memory?: MemoryStore;
  finalizeActiveDebateQuota?: (input: ActiveDebateQuotaFinalizerInput) => Promise<void>;
  invocations?: ToolInvocationStore;
  approvals?: ApprovalStore;
  toolPolicy?: ToolPolicyPort;
  now?: () => number;
  readinessTtlMs?: number;
  attachArtifactOwnership?: (input: {
    runId: string;
    toolInvocationId: string;
    artifactId: string;
    artifactPath: string;
    artifactBytes: number;
    artifactSha256: string;
  }) => Promise<void>;
  consumeToolArtifactBytesQuota?: (input: {
    runId: string;
    toolInvocationId: string;
    artifactId: string;
    bytes: number;
  }) => Promise<void>;
  logger?: RuntimeLogger;
  incrementToolMetric?: (metric: string, labels: Record<string, string>) => void;
  controlPlaneStore?: ControlPlaneStore;
  bridgeCommandStore?: PostgresHostedRuntimeBridgeCommandStore;
  bridgeCommandPayloads?: HostedRuntimeBridgeCommandPayloadStore;
  bridgeWorkerRuntime?: HostedRuntimeBridgeWorkerRuntime;
  workerId?: string;
}): HostedWorkerApp {
  const tools = config.tools ?? {
    hostedRealTools: "disabled",
    connectedNodeRealTools: "disabled",
    adapterMode: "fake",
    allowNoApprovalInTest: config.deploymentMode !== "production",
    policySourceKind: "none",
    policy: createDisabledRealToolPolicyConfig()
  };
  const runtimeConfig: WorkerConfig = {
    ...config,
    tools
  };
  const strictClaimReadiness =
    (runtimeConfig.deploymentMode === "staging" || runtimeConfig.deploymentMode === "production") &&
    (Boolean(runtimeConfig.postgresUrl) || Boolean(runtimeConfig.redisUrl));
  const now = deps?.now ?? (() => Date.now());
  const readinessTtlMs = deps?.readinessTtlMs ?? 5_000;
  const postgres = deps?.postgres ?? (runtimeConfig.postgresUrl ? openPostgresDatabase(runtimeConfig.postgresUrl) : undefined);
  let postgresReady: Promise<void> | undefined;
  if (postgres) {
    postgresReady = (deps?.ensurePostgresSchema ?? ensurePostgresSchema)(postgres);
  }

  const queue: RunQueuePort & { close?: () => Promise<void> } = deps?.queue
    ?? (runtimeConfig.redisUrl
      ? new BullMqRunQueue({ redisUrl: runtimeConfig.redisUrl, queueName: runtimeConfig.queueName ?? "switchyard-hosted-runs" })
      : new MemoryRunQueue());
  const toolQueue = queue as RunQueuePort & Partial<ToolQueuePort>;
  const runs: RunStore = deps?.runs ?? new PostgresRunStore(postgres);
  const events: EventStore = deps?.events ?? new PostgresEventStore(postgres);
  const sessions: SessionStore = deps?.sessions ?? new PostgresSessionStore(postgres);
  const artifacts: ArtifactStore = deps?.artifacts ?? new PostgresArtifactStore(postgres);
  const debates: DebateStore = deps?.debates ?? new PostgresDebateStore(postgres);
  const messages: MessageStore = deps?.messages ?? new PostgresMessageStore(postgres);
  const evidence: EvidenceStore = deps?.evidence ?? new PostgresEvidenceStore(postgres);
  const debateExecution: DebateExecutionStore = deps?.debateExecution ?? new PostgresDebateExecutionStore(postgres) as DebateExecutionStore;
  const memory: MemoryStore = deps?.memory ?? createEmptyMemoryStore();
  const invocations: ToolInvocationStore = deps?.invocations ?? (postgres ? new PostgresToolInvocationStore(postgres) : new InMemoryToolInvocationStore());
  const approvals: ApprovalStore = deps?.approvals ?? (postgres ? new PostgresApprovalStore(postgres) : new InMemoryApprovalStore());
  const artifactContent: ArtifactContentStore & { probe: () => Promise<{ ok: true }> } =
    deps?.artifactContent ?? createArtifactContentStoreFromObjectConfig(runtimeConfig.objectStore);
  const controlPlaneStore = deps?.controlPlaneStore ?? (postgres ? new PostgresControlPlaneStore(postgres) : undefined);
  const runtimeLogger = deps?.logger ?? createWorkerRuntimeLogger();
  const incrementToolMetric = deps?.incrementToolMetric ?? createWorkerMetricSink(runtimeLogger);
  const attachArtifactOwnership = deps?.attachArtifactOwnership ?? (
    controlPlaneStore
      ? async (input: {
        runId: string;
        toolInvocationId: string;
        artifactId: string;
        artifactPath: string;
        artifactBytes: number;
        artifactSha256: string;
      }) => {
        const runOwnership = await controlPlaneStore.getOwnership({
          resourceType: "run",
          resourceId: input.runId
        });
        if (!runOwnership) {
          const ownershipError = new Error("ownership_attach_failed");
          (ownershipError as Error & { reasonCode: string }).reasonCode = "ownership_attach_failed";
          throw ownershipError;
        }
        await controlPlaneStore.attachOwnership({
          resourceType: "artifact",
          resourceId: input.artifactId,
          accountId: runOwnership.accountId,
          tenantId: runOwnership.tenantId,
          projectId: runOwnership.projectId,
          userId: runOwnership.userId,
          apiKeyId: runOwnership.apiKeyId,
          createdAt: new Date().toISOString()
        });
      }
      : undefined
  );
  const consumeToolArtifactBytesQuota = deps?.consumeToolArtifactBytesQuota ?? (
    controlPlaneStore
      ? async (input: {
        runId: string;
        toolInvocationId: string;
        artifactId: string;
        bytes: number;
      }) => {
        const runOwnership = await controlPlaneStore.getOwnership({
          resourceType: "run",
          resourceId: input.runId
        });
        if (!runOwnership) {
          const quotaError = new Error("quota_owner_missing");
          (quotaError as Error & { reasonCode: string }).reasonCode = "quota_owner_missing";
          throw quotaError;
        }
        const maxAllowed = await resolveToolArtifactQuotaLimit(runOwnership.accountId);
        await controlPlaneStore.reserveQuota({
          accountId: runOwnership.accountId,
          tenantId: runOwnership.tenantId,
          projectId: runOwnership.projectId,
          userId: runOwnership.userId,
          apiKeyId: runOwnership.apiKeyId,
          quotaKind: "tool_artifact_bytes_per_hour",
          amount: Math.max(1, Math.ceil(input.bytes)),
          maxAllowed,
          windowMs: 60 * 60 * 1000,
          reservationTtlMs: 60 * 1000,
          reasonCode: "tool_artifact_store",
          now: new Date().toISOString()
        });
      }
      : undefined
  );

  const workerId = deps?.workerId ?? resolveHostedWorkerId(runtimeConfig);
  const requiredBridgeModes = hostedBridgeModesFromAllowlist(runtimeConfig.hostedRuntimeAllowlist);
  const bridgeSupportEnabled = runtimeConfig.hostedRealRuntimeExecution === "enabled" && requiredBridgeModes.length > 0;
  const bridgeCommandStore = deps?.bridgeCommandStore ?? new PostgresHostedRuntimeBridgeCommandStore(postgres);
  const bridgeCommandPayloads = deps?.bridgeCommandPayloads ?? (
    postgres ? new PostgresHostedRuntimeBridgePayloadStore(postgres) : undefined
  );
  const bridgeStoreReady = Boolean(bridgeCommandStore && bridgeCommandPayloads);
  const bridgeEnabledModes = bridgeSupportEnabled && bridgeStoreReady
    ? new Set<HostedBridgeSupportedMode>(requiredBridgeModes)
    : new Set<HostedBridgeSupportedMode>();

  const adapters = buildHostedWorkerAdapters(runtimeConfig, {
    ...(deps?.adapters ?? {}),
    hostedBridgeEnabledModes: bridgeEnabledModes,
    logger: runtimeLogger
  });
  const toolAdapters = buildWorkerHostedToolAdapters(runtimeConfig, deps?.toolAdapters);
  const toolPolicy = deps?.toolPolicy ?? new LocalPolicyGate(runtimeConfig.tools.policy);
  const _hostedSandbox = createWorkerHostedSandboxService(config, {
    ...(deps?.processFactory ? { processFactory: deps.processFactory } : {}),
    ...(deps?.ptyFactory ? { ptyFactory: deps.ptyFactory } : {})
  });
  const bridgeWorkerRuntime: HostedRuntimeBridgeWorkerRuntime | undefined = deps?.bridgeWorkerRuntime ?? (
    bridgeCommandPayloads
      ? new HostedRuntimeBridgeService({
        runs,
        sessions,
        approvals,
        commands: bridgeCommandStore,
        runtimeRunner: {
          sendInput: async () => undefined
        },
        commandPayloads: bridgeCommandPayloads,
        logger: runtimeLogger,
        preflight: {
          attachOwnershipFromRun: async ({ resourceType, resourceId, runId }) => {
            if (!controlPlaneStore) {
              return;
            }
            const runOwnership = await controlPlaneStore.getOwnership({
              resourceType: "run",
              resourceId: runId
            });
            if (!runOwnership) {
              throw new Error("approval_ownership_attach_failed");
            }
            await controlPlaneStore.attachOwnership({
              resourceType,
              resourceId,
              accountId: runOwnership.accountId,
              tenantId: runOwnership.tenantId,
              projectId: runOwnership.projectId,
              userId: runOwnership.userId,
              apiKeyId: runOwnership.apiKeyId,
              createdAt: new Date().toISOString()
            });
          }
        }
      })
      : undefined
  );
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
    },
    ...(bridgeWorkerRuntime
      ? {
        runtimeApprovals: {
          create: async (input) => {
            try {
              const deadline = resolveRuntimeApprovalDeadline(input.payload, new Date().toISOString());
              await bridgeWorkerRuntime.createWorkerRuntimeApproval({
                runId: input.runId,
                approvalType: input.approvalType,
                payload: input.payload,
                workerId,
                deadline
              });
            } catch (error) {
              throw new AdapterProtocolError("Runtime approval creation failed.", {
                reasonCode: extractReasonCode(error) ?? "runtime_approval_bridge_unconfigured"
              });
            }
          },
          terminalizePendingForRun: async (runId, input) => {
            try {
              return bridgeWorkerRuntime.terminalizePendingRuntimeApprovalsForRun({
                runId,
                reasonCode: input.message,
                terminalEvent: input.terminalEvent
              });
            } catch (error) {
              throw new AdapterProtocolError("Runtime approval cleanup failed.", {
                reasonCode: extractReasonCode(error) ?? "runtime_approval_bridge_unconfigured"
              });
            }
          }
        }
      }
      : {})
  });
  const hostedRuntimeBridge = bridgeWorkerRuntime && deps?.bridgeWorkerRuntime
    ? bridgeWorkerRuntime
    : (bridgeWorkerRuntime
      ? new HostedRuntimeBridgeService({
        runs,
        sessions,
        approvals,
        commands: bridgeCommandStore,
        runtimeRunner: runner,
        ...(bridgeCommandPayloads ? { commandPayloads: bridgeCommandPayloads } : {}),
        logger: runtimeLogger,
        preflight: {
          attachOwnershipFromRun: async ({ resourceType, resourceId, runId }) => {
            if (!controlPlaneStore) {
              return;
            }
            const runOwnership = await controlPlaneStore.getOwnership({
              resourceType: "run",
              resourceId: runId
            });
            if (!runOwnership) {
              throw new Error("approval_ownership_attach_failed");
            }
            await controlPlaneStore.attachOwnership({
              resourceType,
              resourceId,
              accountId: runOwnership.accountId,
              tenantId: runOwnership.tenantId,
              projectId: runOwnership.projectId,
              userId: runOwnership.userId,
              apiKeyId: runOwnership.apiKeyId,
              createdAt: new Date().toISOString()
            });
          }
        }
      })
      : undefined);
  const runService = new RunService({ runs, events, runner });
  const debateRunService: Pick<RunService, "createRun" | "startRun"> = {
    createRun: async (input) => {
      const run = await runService.createRun(input);
      await queue.enqueue({
        runId: run.id,
        placement: run.placement,
        ...(run.runtimeMode ? { runtimeMode: run.runtimeMode } : {})
      });
      return run;
    },
    startRun: (runId) => runService.startRun(runId)
  };
  const eventBus = new EventBus();
  const messageRouter = new MessageRouter({
    runs,
    messages,
    events,
    eventBus,
    logger: runtimeLogger
  });
  const contextBuilder = new ContextBuilder({
    memory,
    evidence,
    messages,
    logger: runtimeLogger
  });
  const debateService = new DebateService({
    debates,
    runs,
    runService: debateRunService,
    contextBuilder,
    messageRouter,
    evidence,
    events,
    artifacts,
    debateExecution,
    artifactContent: {
      writeText: async (path, content) => {
        const stored = await artifactContent.writeText(path, content, { contentType: "text/markdown" });
        return stored.path;
      }
    },
    eventBus,
    logger: runtimeLogger,
    defaultCwd: "/srv/switchyard/work"
  });
  const finalizeActiveDebateQuota = deps?.finalizeActiveDebateQuota ?? createActiveDebateQuotaFinalizer({
    ...(postgres ? { postgres } : {}),
    ...(controlPlaneStore ? { controlPlaneStore } : {}),
    logger: runtimeLogger
  });

  const service = new HostedWorkerService({
    queue,
    runs,
    events,
    startRun: async (runId: string) => {
      const started = await runService.startRun(runId);
      await stampSessionOwnerForStartedRun(started);
      return started;
    },
    hostedRuntimeAllowlist: runtimeConfig.hostedRuntimeAllowlist,
    deploymentMode: runtimeConfig.deploymentMode,
    hostedRealRuntimeExecution: runtimeConfig.hostedRealRuntimeExecution,
    providerActivation: runtimeConfig.providerRuntimeActivation,
    providerEnvironment: process.env,
    adapterRuntimeModes: new Set([
      ...(adapters.has("codex") ? ["codex.exec_json"] : []),
      ...(adapters.has("claude_code") ? ["claude_code.sdk"] : []),
      ...(adapters.has("opencode") ? ["opencode.acp"] : []),
      ...(adapters.has("agentfield") ? ["agentfield.async_rest"] : []),
      ...(adapters.has("generic_http") ? ["generic_http.async_rest"] : [])
    ])
  } as any);

  let cachedReadiness: { checkedAtMs: number; status: WorkerReadinessReport } | undefined;
  let reconciledStaleRunningTools = false;
  let reconciledHostedBridge = false;
  const quotaLimitByAccount = new Map<string, number>();

  async function resolveToolArtifactQuotaLimit(accountId: string): Promise<number> {
    const cached = quotaLimitByAccount.get(accountId);
    if (cached !== undefined) {
      return cached;
    }
    const fallback = Math.max(
      1,
      Math.min(2_000_000_000, runtimeConfig.tools.policy.global.maxArtifactBytes * 256)
    );
    if (!postgres) {
      quotaLimitByAccount.set(accountId, fallback);
      return fallback;
    }
    try {
      const result = await postgres.pool.query(
        `SELECT b.quotas AS plan_quotas
           FROM accounts a
           JOIN billing_plans b ON b.id = a.billing_plan_id
          WHERE a.id = $1
          LIMIT 1`,
        [accountId]
      );
      const row = result.rows[0] as { plan_quotas?: unknown } | undefined;
      const planQuotas = asRecord(row?.plan_quotas);
      const max = Number(planQuotas["maxToolArtifactBytesPerHour"]);
      if (Number.isFinite(max) && max >= 1) {
        const resolved = Math.min(2_000_000_000, Math.floor(max));
        quotaLimitByAccount.set(accountId, resolved);
        return resolved;
      }
    } catch {
      // Fall back to policy-derived bound when quota plan lookup is unavailable.
    }
    quotaLimitByAccount.set(accountId, fallback);
    return fallback;
  }

  return {
    tick: async () => {
      if (strictClaimReadiness) {
        const claimGate = await runClaimReadiness();
        if (!claimGate.ok) {
          return false;
        }
      }

      const bridgeWorked = await processHostedRuntimeBridge();
      if (bridgeWorked) {
        return true;
      }

      const toolWorked = await processToolJobs();
      if (toolWorked) {
        return true;
      }
      const runWorked = await service.processNext();
      if (runWorked) {
        return true;
      }
      return processDebateJobs();
    },
    ready: async (options) => {
      if (options?.mode === "claim") {
        return runClaimReadiness();
      }
      return runFullReadiness();
    },
    stop: async () => {
      try {
        await postgresReady;
      } catch {
        // Readiness already maps startup probe failures to named reasons; cleanup must not replace that result.
      }
      await queue.close?.();
      try {
        await postgres?.close();
      } catch {
        // Best-effort cleanup for handles that failed during initial connection.
      }
    }
  };

  async function processHostedRuntimeBridge(): Promise<boolean> {
    if (!bridgeSupportEnabled || !hostedRuntimeBridge) {
      return false;
    }

    if (!reconciledHostedBridge) {
      const reconciled = await hostedRuntimeBridge.reconcileHostedRuntimeSessions({ workerId });
      reconciledHostedBridge = true;
      if (reconciled.reconciled > 0 || reconciled.failed > 0) {
        runtimeLogger.warn("worker.runtime_bridge.reconcile", {
          workerId,
          reconciled: String(reconciled.reconciled),
          failed: String(reconciled.failed)
        });
      }
    }

    return await hostedRuntimeBridge.claimAndApplyNext({
      workerId,
      leaseMs: DEFAULT_BRIDGE_LEASE_MS
    });
  }

  async function processDebateJobs(): Promise<boolean> {
    const recoveryNow = new Date().toISOString();
    const staleClaims = await listStaleDebateClaimsForRecovery(recoveryNow);
    const recovered = await debateExecution.recoverStaleClaims({ now: recoveryNow });
    if (recovered.recovered > 0 || recovered.exhausted > 0 || recovered.invalid > 0) {
      runtimeLogger.warn("worker.debate.claims.recovered", {
        recovered: String(recovered.recovered),
        exhausted: String(recovered.exhausted),
        invalid: String(recovered.invalid)
      });
    }
    const terminalizedStaleClaims = await failTerminalRecoveredDebateClaims(staleClaims);
    if (terminalizedStaleClaims > 0) {
      return true;
    }

    const job = await debateExecution.claim({ leaseMs: 30_000 });
    if (!job) {
      return false;
    }

    runtimeLogger.info("worker.debate.job.claimed", {
      stage: normalizeDebateLabel(job.stage),
      phase: normalizeDebateLabel(job.debatePhase),
      attempt: String(job.attempts)
    });

    try {
      const result = await debateService.processExecutionJob(job);
      if (result.action === "complete") {
        await debateExecution.complete(job.id);
        if (result.quotaFinalization) {
          await finalizeDebateQuota(result.quotaFinalization, job);
        }
      } else if (result.action === "requeue") {
        await debateExecution.release(job.id, {
          nextAttemptAt: result.nextAttemptAt,
          reasonCode: result.reasonCode
        });
      } else {
        await debateExecution.fail(job.id, {
          reasonCode: result.reasonCode,
          retryable: false
        });
        await finalizeDebateQuota(result.quotaFinalization, job);
      }
      runtimeLogger.info("worker.debate.job.processed", {
        action: result.action,
        reasonCode: normalizeReasonLabel("reasonCode" in result ? result.reasonCode : undefined)
      });
      return true;
    } catch (error) {
      const reasonCode = extractReasonCode(error) ?? "debate_execution_failed";
      await debateExecution.fail(job.id, {
        reasonCode,
        retryable: false
      });
      runtimeLogger.warn("worker.debate.job.failed", {
        reasonCode: normalizeReasonLabel(reasonCode)
      });
      return true;
    }
  }

  async function finalizeDebateQuota(finalization: DebateQuotaFinalization, job: DebateExecutionJob): Promise<void> {
    await finalizeActiveDebateQuota({
      ...finalization,
      job,
      debate: await debates.get(finalization.debateId)
    });
  }

  async function failTerminalRecoveredDebateClaims(staleClaims: DebateExecutionJob[]): Promise<number> {
    let terminalized = 0;
    for (const job of staleClaims) {
      const reasonCode = staleRecoveryTerminalReason(job);
      if (!reasonCode) {
        continue;
      }
      const debate = await debates.get(job.debateId);
      if (!debate) {
        continue;
      }
      if (!isTerminalDebateStatusValue(debate.status)) {
        const completedAt = new Date().toISOString();
        await debates.update({
          ...debate,
          status: "failed",
          stopReason: "failed",
          error: {
            code: reasonCode,
            message: reasonCode
          },
          updatedAt: completedAt,
          completedAt
        });
      }
      await finalizeActiveDebateQuota({
        debateId: job.debateId,
        outcome: "failed",
        reasonCode,
        job,
        debate
      });
      terminalized += 1;
    }
    return terminalized;
  }

  async function listStaleDebateClaimsForRecovery(nowIso: string): Promise<DebateExecutionJob[]> {
    if (postgres) {
      try {
        const result = await postgres.pool.query(
          `SELECT *
           FROM debate_execution_jobs
           WHERE state = 'claimed'
             AND (lease_until IS NULL OR lease_until <= $1)
           ORDER BY updated_at ASC, id ASC`,
          [nowIso]
        );
        return result.rows.map((row) => rowToDebateExecutionJob(row as Record<string, unknown>));
      } catch {
        return [];
      }
    }
    const items = (debateExecution as unknown as { items?: Map<string, DebateExecutionJob> }).items;
    if (!items) {
      return [];
    }
    return [...items.values()].filter((job) => isStaleDebateClaim(job, nowIso));
  }

  async function stampSessionOwnerForStartedRun(run: RunRecord): Promise<void> {
    if (!bridgeSupportEnabled || requiredBridgeModes.length === 0 || !run.runtimeMode || !isBridgeSupportedMode(run.runtimeMode)) {
      return;
    }
    const session = await sessions.getByRunId(run.id);
    if (!session) {
      return;
    }

    const currentState = asRecord(session.state);
    const currentWorker = typeof currentState["hostedWorkerId"] === "string"
      ? currentState["hostedWorkerId"].trim()
      : "";
    if (currentWorker.length > 0 && currentWorker !== workerId) {
      return;
    }

    const bridgeCapable = currentState["hostedBridgeCapable"] === true;
    const runtimeSessionId = typeof currentState["hostedRuntimeSessionId"] === "string"
      ? currentState["hostedRuntimeSessionId"].trim()
      : "";
    const desiredBridgeCapable = await resolveStartedRunBridgeCapability(run);
    if (currentWorker === workerId && bridgeCapable === desiredBridgeCapable && runtimeSessionId === session.id) {
      return;
    }

    await sessions.update({
      ...session,
      state: {
        ...currentState,
        hostedWorkerId: workerId,
        hostedRuntimeSessionId: session.id,
        hostedBridgeCapable: desiredBridgeCapable,
        runtimeMode: run.runtimeMode,
        ...(session.externalSessionKey ? { externalSessionKey: session.externalSessionKey } : {})
      },
      updatedAt: new Date().toISOString()
    });
  }

  async function resolveStartedRunBridgeCapability(run: RunRecord): Promise<boolean> {
    if (!run.runtimeMode || !isBridgeSupportedMode(run.runtimeMode) || !bridgeEnabledModes.has(run.runtimeMode)) {
      return false;
    }
    if (!isWrapperBridgeMode(run.runtimeMode)) {
      return true;
    }

    const adapter = adapters.get(adapterIdForBridgeMode(run.runtimeMode));
    if (!adapter) {
      return false;
    }
    try {
      const check = await adapter.check();
      if (!check.ok) {
        return false;
      }
      const details = check.details as Record<string, unknown> | undefined;
      const bridge = details?.["bridge"] as Record<string, unknown> | undefined;
      return bridge?.["canBridge"] === true;
    } catch (error) {
      runtimeLogger.warn("worker.runtime_bridge.wrapper_capability_check_failed", {
        runtimeMode: run.runtimeMode,
        reasonCode: normalizeReasonLabel(extractReasonCode(error) ?? wrapperCapabilityMissingCode(run.runtimeMode))
      });
      return false;
    }
  }

  async function processToolJobs(): Promise<boolean> {
    if (runtimeConfig.tools.hostedRealTools !== "enabled") {
      return false;
    }
    if (!hasToolQueueSupport(toolQueue)) {
      return false;
    }

    const recovered = await toolQueue.recoverStaleToolClaims();
    for (const claim of recovered.exhaustedClaims) {
      await failToolInvocationIfActive(claim.toolInvocationId, "tool_dispatch_retry_exhausted", "Tool dispatch retries exhausted");
    }

    if (!reconciledStaleRunningTools) {
      await reconcileStaleRunningInvocations();
      reconciledStaleRunningTools = true;
    }

    const claimed = await toolQueue.claimTool();
    if (!claimed) {
      return false;
    }
    emitToolInfo("tool.job.claimed", {
      toolType: normalizeToolTypeLabel(claimed.payload.toolType)
    });
    emitToolMetric("tool_job_claimed_total", {
      toolType: normalizeToolTypeLabel(claimed.payload.toolType)
    });

    const invocation = await invocations.get(claimed.payload.toolInvocationId);
    if (!invocation) {
      emitToolWarn("tool.job.failed", {
        toolType: normalizeToolTypeLabel(claimed.payload.toolType),
        reason: normalizeReasonLabel("tool_invocation_not_found")
      });
      emitToolMetric("tool_job_failed_total", {
        toolType: normalizeToolTypeLabel(claimed.payload.toolType),
        reason: normalizeReasonLabel("tool_invocation_not_found")
      });
      await toolQueue.failTool(claimed.id, { reasonCode: "tool_invocation_not_found", message: "tool_invocation_not_found" });
      return true;
    }

    if (invocation.status !== "queued") {
      await toolQueue.ackTool(claimed.id);
      return true;
    }

    const run = invocation.runId ? await runs.get(invocation.runId) : undefined;
    if (!run) {
      await transitionToolInvocation(invocation, "failed", {
        code: "hosted_run_state_invalid",
        message: "run_not_found"
      });
      emitToolWarn("tool.job.failed", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel("hosted_run_state_invalid")
      });
      emitToolMetric("tool_job_failed_total", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel("hosted_run_state_invalid")
      });
      await toolQueue.failTool(claimed.id, { reasonCode: "hosted_run_state_invalid", message: "run_not_found" });
      return true;
    }

    const approval = await approvals.get(claimed.payload.approvalId);
    if (!approval) {
      await transitionToolInvocation(invocation, "failed", {
        code: "approval_not_found",
        message: "approval_not_found"
      });
      emitToolWarn("tool.job.failed", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel("approval_not_found")
      });
      emitToolMetric("tool_job_failed_total", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel("approval_not_found")
      });
      await toolQueue.failTool(claimed.id, { reasonCode: "approval_not_found", message: "approval_not_found" });
      return true;
    }

    if (approval.status !== "approved" && !(runtimeConfig.deploymentMode !== "production" && runtimeConfig.tools.allowNoApprovalInTest)) {
      await transitionToolInvocation(invocation, "failed", {
        code: "approval_not_pending",
        message: "approval_not_approved"
      });
      emitToolWarn("tool.job.failed", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel("approval_not_pending")
      });
      emitToolMetric("tool_job_failed_total", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel("approval_not_pending")
      });
      await toolQueue.failTool(claimed.id, { reasonCode: "approval_not_pending", message: "approval_not_approved" });
      return true;
    }

    const requestInput = asRecord(invocation.input["request"]);
    const policyDecision = await toolPolicy.decideTool({
      type: invocation.type,
      input: requestInput,
      runApprovalPolicy: run.approvalPolicy,
      placement: "hosted"
    } as never);

    if (policyDecision.decision === "deny") {
      const denyCode = policyDecision.reasonCode || "tool_policy_denied";
      await transitionToolInvocation(invocation, "denied", {
        code: denyCode,
        message: "Tool invocation denied by policy revalidation"
      });
      emitToolWarn("tool.job.failed", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel(denyCode)
      });
      emitToolMetric("tool_job_failed_total", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel(denyCode)
      });
      await toolQueue.failTool(claimed.id, { reasonCode: denyCode, message: denyCode });
      return true;
    }

    const storedHash = typeof invocation.input["executionPlanHash"] === "string"
      ? invocation.input["executionPlanHash"]
      : claimed.payload.executionPlanHash;
    const recomputedHash = hashExecutionPlan(policyDecision.executionPlan);
    if (storedHash !== recomputedHash) {
      await transitionToolInvocation(invocation, "denied", {
        code: "tool_policy_failed",
        message: "Tool execution plan changed after approval"
      });
      emitToolWarn("tool.job.failed", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel("tool_policy_failed")
      });
      emitToolMetric("tool_job_failed_total", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel("tool_policy_failed")
      });
      await toolQueue.failTool(claimed.id, { reasonCode: "tool_policy_failed", message: "tool_policy_failed" });
      return true;
    }

    if (invocation.type === TOOL_KIND_REPO) {
      await transitionToolInvocation(invocation, "denied", {
        code: CODE_REPO_UNSHIPPED,
        message: "Hosted source-control inspection execution is not shipped"
      });
      emitToolWarn("tool.job.failed", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel(CODE_REPO_UNSHIPPED)
      });
      emitToolMetric("tool_job_failed_total", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel(CODE_REPO_UNSHIPPED)
      });
      await toolQueue.failTool(claimed.id, { reasonCode: CODE_REPO_UNSHIPPED, message: CODE_REPO_UNSHIPPED });
      return true;
    }

    if (invocation.type === TOOL_KIND_BROWSER) {
      await transitionToolInvocation(invocation, "denied", {
        code: CODE_BROWSER_UNSHIPPED,
        message: "Interactive page control execution is not shipped"
      });
      emitToolWarn("tool.job.failed", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel(CODE_BROWSER_UNSHIPPED)
      });
      emitToolMetric("tool_job_failed_total", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel(CODE_BROWSER_UNSHIPPED)
      });
      await toolQueue.failTool(claimed.id, { reasonCode: CODE_BROWSER_UNSHIPPED, message: CODE_BROWSER_UNSHIPPED });
      return true;
    }

    const running: ToolInvocationRecord = {
      ...invocation,
      status: "running"
    };
    const persistedRunning = await invocations.updateIfStatus(invocation.id, "queued", running);
    if (!persistedRunning) {
      await toolQueue.ackTool(claimed.id);
      return true;
    }
    emitToolInfo("tool.job.revalidated", {
      toolType: normalizeToolTypeLabel(persistedRunning.type)
    });
    emitToolMetric("tool_job_revalidated_total", {
      toolType: normalizeToolTypeLabel(persistedRunning.type)
    });

    await appendToolEvent(run.id, "tool.call", {
      toolInvocationId: persistedRunning.id,
      type: persistedRunning.type
    });

    const adapter = toolAdapters.get(persistedRunning.type);
    if (!adapter) {
      await transitionToolInvocation(persistedRunning, "failed", {
        code: "tool_adapter_unavailable",
        message: `Tool adapter not configured for ${persistedRunning.type}`
      });
      emitToolWarn("tool.job.failed", {
        toolType: normalizeToolTypeLabel(persistedRunning.type),
        reason: normalizeReasonLabel("tool_adapter_unavailable")
      });
      emitToolMetric("tool_job_failed_total", {
        toolType: normalizeToolTypeLabel(persistedRunning.type),
        reason: normalizeReasonLabel("tool_adapter_unavailable")
      });
      await toolQueue.failTool(claimed.id, { reasonCode: "tool_adapter_unavailable", message: "tool_adapter_unavailable" });
      return true;
    }

    try {
      const adapterInput = persistedRunning.type === "fake_echo"
        ? requestInput
        : { request: requestInput, executionPlan: policyDecision.executionPlan };
      const output = redactSecrets(await adapter.invoke(adapterInput));
      const storedOutput = await persistToolArtifacts(run.id, persistedRunning.id, persistedRunning.type, output);
      await transitionToolInvocation(persistedRunning, "completed", undefined, storedOutput);
      emitToolInfo("tool.job.completed", {
        toolType: normalizeToolTypeLabel(persistedRunning.type)
      });
      emitToolMetric("tool_job_completed_total", {
        toolType: normalizeToolTypeLabel(persistedRunning.type)
      });
      await toolQueue.ackTool(claimed.id);
      return true;
    } catch (error) {
      const reasonCode = extractReasonCode(error) ?? "tool_execution_failed";
      await transitionToolInvocation(persistedRunning, "failed", {
        code: reasonCode,
        message: error instanceof Error ? error.message : String(error)
      });
      emitToolWarn("tool.job.failed", {
        toolType: normalizeToolTypeLabel(persistedRunning.type),
        reason: normalizeReasonLabel(reasonCode)
      });
      emitToolMetric("tool_job_failed_total", {
        toolType: normalizeToolTypeLabel(persistedRunning.type),
        reason: normalizeReasonLabel(reasonCode)
      });
      await toolQueue.failTool(claimed.id, { reasonCode, message: reasonCode });
      return true;
    }
  }

  async function persistToolArtifacts(
    runId: string,
    toolInvocationId: string,
    toolType: string,
    output: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const candidates = Array.isArray(output["artifactCandidates"])
      ? output["artifactCandidates"].filter((entry) => entry && typeof entry === "object") as Array<Record<string, unknown>>
      : [];
    if (candidates.length === 0) {
      return output;
    }

    const artifactIds: string[] = [];
    for (const candidate of candidates) {
      const logicalPath = typeof candidate["logicalPath"] === "string" ? candidate["logicalPath"] : "output.log";
      const artifactType = typeof candidate["type"] === "string" ? candidate["type"] : "raw_log";
      const maxBytes = runtimeConfig.tools.policy.global.maxArtifactBytes;
      const content = truncateUtf8Bytes(
        redactSecrets(typeof candidate["content"] === "string" ? candidate["content"] : ""),
        maxBytes
      );
      const contentType = typeof candidate["contentType"] === "string" ? candidate["contentType"] : "text/plain";
      const safeName = sanitizeArtifactName(logicalPath);
      const artifactPath = `runs/${runId}/tools/${toolInvocationId}/${safeName}`;

      const stored = await artifactContent.writeText(artifactPath, content, { contentType });
      const digest = createHash("sha256").update(content, "utf8").digest("hex");
      if (stored.sha256 !== digest) {
        const digestError = new Error("artifact_digest_mismatch");
        (digestError as Error & { reasonCode: string }).reasonCode = "artifact_digest_mismatch";
        throw digestError;
      }
      const artifactId = `artifact_${crypto.randomUUID()}`;
      await attachArtifactOwnership?.({
        runId,
        toolInvocationId,
        artifactId,
        artifactPath: stored.path,
        artifactBytes: stored.sizeBytes,
        artifactSha256: stored.sha256
      });

      const artifact: ArtifactRecord = {
        id: artifactId,
        runId,
        type: artifactType as ArtifactRecord["type"],
        path: stored.path,
        metadata: redactSecrets({
          ...(candidate["metadata"] && typeof candidate["metadata"] === "object" ? candidate["metadata"] as Record<string, unknown> : {}),
          storageBackend: stored.storageBackend,
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          contentType: stored.contentType,
          toolInvocationId,
          logicalPath: safeName
        }),
        createdAt: new Date().toISOString()
      };
      const created = await artifacts.create(artifact);
      await consumeToolArtifactBytesQuota?.({
        runId,
        toolInvocationId,
        artifactId: created.id,
        bytes: stored.sizeBytes
      });
      emitToolInfo("tool.job.artifact.stored", {
        toolType: normalizeToolTypeLabel(toolType)
      });
      emitToolMetric("tool_artifact_stored_total", {
        toolType: normalizeToolTypeLabel(toolType)
      });
      artifactIds.push(artifact.id);
    }

    const nextOutput = { ...output };
    if (artifactIds.length > 0) {
      nextOutput["artifactIds"] = artifactIds;
    }
    delete nextOutput["artifactCandidates"];
    return nextOutput;
  }

  async function transitionToolInvocation(
    source: ToolInvocationRecord,
    status: ToolInvocationRecord["status"],
    error?: { code: string; message: string },
    output?: Record<string, unknown>
  ): Promise<ToolInvocationRecord | null> {
    const next: ToolInvocationRecord = {
      ...source,
      status,
      completedAt: new Date().toISOString(),
      ...(error ? { error: redactSecrets(error) } : {}),
      ...(output ? { output } : {})
    };
    const persisted = await invocations.updateIfStatus(source.id, source.status, next);
    if (!persisted) {
      return null;
    }
    await appendToolEvent(source.runId, "tool.result", {
      toolInvocationId: persisted.id,
      status: persisted.status,
      ...(persisted.output ? { output: persisted.output } : {}),
      ...(persisted.error ? { error: persisted.error } : {})
    });
    return persisted;
  }

  async function failToolInvocationIfActive(
    toolInvocationId: string,
    code: string,
    message: string
  ): Promise<void> {
    const invocation = await invocations.get(toolInvocationId);
    if (!invocation) {
      return;
    }
    if (invocation.status !== "queued" && invocation.status !== "running") {
      return;
    }
    await transitionToolInvocation(invocation, "failed", { code, message });
    emitToolWarn("tool.job.failed", {
      toolType: normalizeToolTypeLabel(invocation.type),
      reason: normalizeReasonLabel(code)
    });
    emitToolMetric("tool_job_failed_total", {
      toolType: normalizeToolTypeLabel(invocation.type),
      reason: normalizeReasonLabel(code)
    });
  }

  async function reconcileStaleRunningInvocations(): Promise<void> {
    const page = await invocations.list({
      status: "running",
      limit: 5000
    });
    for (const invocation of page.invocations) {
      const run = invocation.runId ? await runs.get(invocation.runId) : undefined;
      if (!isHostedInvocation(invocation, run)) {
        continue;
      }
      if (hasToolClaimProbeSupport(toolQueue) && await toolQueue.hasLiveToolClaim(invocation.id)) {
        continue;
      }
      await transitionToolInvocation(invocation, "failed", {
        code: "tool_worker_restarted",
        message: "Tool invocation interrupted by worker restart"
      });
      emitToolWarn("tool.job.failed", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel("tool_worker_restarted")
      });
      emitToolMetric("tool_job_failed_total", {
        toolType: normalizeToolTypeLabel(invocation.type),
        reason: normalizeReasonLabel("tool_worker_restarted")
      });
    }
  }

  function emitToolInfo(event: string, details: Record<string, string>): void {
    runtimeLogger.info(event, details);
  }

  function emitToolWarn(event: string, details: Record<string, string>): void {
    runtimeLogger.warn(event, details);
  }

  function emitToolMetric(metric: string, labels: Record<string, string>): void {
    incrementToolMetric(metric, labels);
  }

  async function appendToolEvent(
    runId: string | undefined,
    type: SwitchyardEventRecord["type"],
    payload: Record<string, unknown>
  ): Promise<void> {
    const sequence = runId ? (await events.listByRun(runId)).length : 0;
    const event: SwitchyardEventRecord = {
      id: `event_${crypto.randomUUID()}`,
      type,
      sequence,
      payload: redactSecrets(payload),
      createdAt: new Date().toISOString(),
      ...(runId ? { runId } : {})
    };
    await events.append(event);
  }

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

  function shouldCheckHostedDebateReadiness(): boolean {
    return strictClaimReadiness || Boolean(deps?.debateExecution);
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

      if (runtimeConfig.objectStore.probe !== "disabled") {
        try {
          await artifactContent.probe();
          checks.objectStore = { ok: true };
        } catch (error) {
          const code = normalizeReadinessCode(error, "object_store_unavailable");
          checks.objectStore = {
            ok: false,
            code,
            diagnostics: redactSecrets({
              backend: runtimeConfig.objectStore.backend,
              summary: runtimeConfig.objectStore.redactedSummary
            })
          };
          return markFailure(code);
        }
      } else {
        checks.objectStore = { ok: true };
      }

      const hasRealAllowlist = runtimeConfig.hostedRuntimeAllowlist.some((mode) => mode !== "fake.deterministic");
      if (!hasRealAllowlist) {
        checks.hostedRuntimeGate = { ok: true };
        checks.providerRuntimePolicy = {
          ok: true,
          diagnostics: {
            source: runtimeConfig.providerRuntimeActivation.redactedSummary.source.kind,
            enabledRealModeCount: runtimeConfig.providerRuntimeActivation.redactedSummary.enabledRealModeCount
          }
        };
      } else if (runtimeConfig.hostedRealRuntimeExecution !== "enabled") {
        checks.hostedRuntimeGate = { ok: false, code: "hosted_real_runtime_disabled" };
        return markFailure("hosted_real_runtime_disabled");
      } else {
        checks.hostedRuntimeGate = { ok: true };
        if (runtimeConfig.deploymentMode === "production" && !runtimeConfig.providerRuntimeActivation.valid) {
          const code = runtimeConfig.providerRuntimeActivation.reasons[0]?.code ?? "provider_runtime_policy_missing";
          checks.providerRuntimePolicy = {
            ok: false,
            code,
            diagnostics: redactSecrets({
              source: runtimeConfig.providerRuntimeActivation.redactedSummary.source.kind,
              reasonCodes: runtimeConfig.providerRuntimeActivation.redactedSummary.reasonCodes,
              modeStatuses: runtimeConfig.providerRuntimeActivation.redactedSummary.modeStatuses
            })
          };
          return markFailure(code);
        }
        checks.providerRuntimePolicy = {
          ok: true,
          diagnostics: redactSecrets({
            source: runtimeConfig.providerRuntimeActivation.redactedSummary.source.kind,
            reasonCodes: runtimeConfig.providerRuntimeActivation.redactedSummary.reasonCodes,
            modeStatuses: runtimeConfig.providerRuntimeActivation.redactedSummary.modeStatuses
          })
        };
      }

      const gateValidation = validateHostedRuntimeAllowlist({
        allowlist: runtimeConfig.hostedRuntimeAllowlist,
        deploymentMode: runtimeConfig.deploymentMode,
        realRuntimeExecution: runtimeConfig.hostedRealRuntimeExecution
      });
      if (!gateValidation.ok) {
        checks.hostedRuntimeGate = { ok: false, code: gateValidation.code };
        return markFailure(gateValidation.code);
      }

      const adapterCheck = await (deps?.checkConfiguredAdapters ?? checkConfiguredHostedAdapters)(runtimeConfig, deps?.adapters);
      checks.providerRuntimeAdapters = adapterCheck.ok
        ? { ok: true, diagnostics: { modes: adapterCheck.modes } }
        : {
          ok: false,
          code: firstAdapterFailureCode(adapterCheck.modes),
          diagnostics: { modes: adapterCheck.modes }
        };
      if (!adapterCheck.ok && !bridgeSupportEnabled) {
        return markFailure(firstAdapterFailureCode(adapterCheck.modes));
      }

      if (bridgeSupportEnabled) {
        const adapterCapabilities = requiredBridgeModes.reduce<Record<string, WorkerRuntimeBridgeModeCapability>>((acc, mode) => {
          const adapterCheckMode = adapterCheck.modes[mode];
          const adapterId = adapterIdForBridgeMode(mode);
          const constructed = Boolean(adapters.get(adapterId));
          acc[mode] = {
            adapter: constructed && bridgeEnabledModes.has(mode),
            wrapperConfig: isWrapperBridgeMode(mode)
              ? constructed || adapterCheckMode?.code !== wrapperConfigMissingCode(mode)
              : true,
            wrapperBridgeCapability: isWrapperBridgeMode(mode)
              ? adapterCheckMode?.ok === true
              : true,
            ...(adapterCheckMode?.ok === false && adapterCheckMode.code ? { reasonCode: adapterCheckMode.code } : {})
          };
          return acc;
        }, {});
        const bridgeReadiness = getWorkerRuntimeBridgeReadiness({
          commandStore: bridgeCommandStore,
          payloadStore: bridgeCommandPayloads,
          workerClaim: hostedRuntimeBridge,
          sessionReconciliation: hostedRuntimeBridge,
          approvalSender: hostedRuntimeBridge,
          adapterCapabilities
        });
        const firstFailure = bridgeReadiness.checks.find((entry: { ok: boolean; reasonCode?: string }) => !entry.ok)?.reasonCode
          ?? "hosted_runtime_bridge_worker_unavailable";
        checks.hostedRuntimeBridge = {
          ok: bridgeReadiness.status === "ready",
          ...(bridgeReadiness.status === "ready" ? {} : { code: firstFailure }),
          diagnostics: {
            workerId,
            bridgeModes: requiredBridgeModes,
            status: bridgeReadiness.status,
            checks: bridgeReadiness.checks
          }
        };
        if (bridgeReadiness.status !== "ready") {
          if (shouldCheckHostedDebateReadiness()) {
            const debateReadiness = getWorkerHostedDebateReadiness({
              debateExecution,
              queue,
              runs,
              events,
              messages,
              evidence,
              artifacts,
              artifactContent,
              finalizeActiveDebateQuota,
              bridgeReadiness: checks.hostedRuntimeBridge
            });
            checks.hostedDebate = debateReadiness.ok
              ? { ok: true, diagnostics: debateReadiness.diagnostics }
              : {
                ok: false,
                code: debateReadiness.code,
                diagnostics: debateReadiness.diagnostics
              };
          }
          return markFailure(firstFailure);
        }
      } else {
        checks.hostedRuntimeBridge = {
          ok: true,
          diagnostics: {
            workerId,
            bridgeModes: requiredBridgeModes,
            status: "disabled"
          }
        };
      }
      if (!adapterCheck.ok) {
        return markFailure(firstAdapterFailureCode(adapterCheck.modes));
      }

      if (shouldCheckHostedDebateReadiness()) {
        const debateReadiness = getWorkerHostedDebateReadiness({
          debateExecution,
          queue,
          runs,
          events,
          messages,
          evidence,
          artifacts,
          artifactContent,
          finalizeActiveDebateQuota,
          bridgeReadiness: checks.hostedRuntimeBridge
        });
        checks.hostedDebate = debateReadiness.ok
          ? { ok: true, diagnostics: debateReadiness.diagnostics }
          : {
            ok: false,
            code: debateReadiness.code,
            diagnostics: debateReadiness.diagnostics
          };
        if (!debateReadiness.ok) {
          return markFailure(debateReadiness.code);
        }
      }

      const toolCheck = checkConfiguredHostedToolAdapters(runtimeConfig);
      if (runtimeConfig.tools.hostedRealTools === "enabled") {
        if (!hasToolQueueSupport(toolQueue)) {
          checks.tools = {
            ok: false,
            code: "tool_dispatch_unavailable",
            diagnostics: {
               hostedRealTools: runtimeConfig.tools.hostedRealTools,
               connectedNodeRealTools: runtimeConfig.tools.connectedNodeRealTools,
               policySourceKind: runtimeConfig.tools.policySourceKind,
              queueAvailable: false
            }
          };
          return markFailure("tool_dispatch_unavailable");
        }
        if (!toolCheck.ok) {
          checks.tools = {
            ok: false,
            ...(toolCheck.code ? { code: toolCheck.code } : {}),
            diagnostics: {
               hostedRealTools: runtimeConfig.tools.hostedRealTools,
               connectedNodeRealTools: runtimeConfig.tools.connectedNodeRealTools,
               policySourceKind: runtimeConfig.tools.policySourceKind
            }
          };
          return markFailure(toolCheck.code ?? "tool_policy_config_invalid");
        }
      }
      checks.tools = {
        ok: toolCheck.ok,
        ...(toolCheck.code ? { code: toolCheck.code } : {}),
        diagnostics: {
          hostedRealTools: runtimeConfig.tools.hostedRealTools,
          connectedNodeRealTools: runtimeConfig.tools.connectedNodeRealTools,
          policySourceKind: runtimeConfig.tools.policySourceKind,
          adapterMode: runtimeConfig.tools.adapterMode,
          allowNoApprovalInTest: runtimeConfig.tools.allowNoApprovalInTest,
          queueAvailable: hasToolQueueSupport(toolQueue),
           enabledToolTypes: [
            ...(runtimeConfig.tools.policy[POLICY_KEY_FETCH].enabled ? [POLICY_KEY_FETCH] : []),
            ...(runtimeConfig.tools.policy.webSearch.enabled ? [POLICY_KEY_WEB] : []),
            ...(runtimeConfig.tools.policy[POLICY_KEY_GH].enabled ? [POLICY_KEY_GH] : []),
            ...(runtimeConfig.tools.policy[POLICY_KEY_SH].enabled ? [POLICY_KEY_SH] : [])
          ]
        }
      };

      const sandbox = checkHostedSandboxReadiness(runtimeConfig.sandbox);
      if (!sandbox.ok) {
        const code = sandbox.code ?? "sandbox_config_invalid";
        checks.sandbox = {
          ok: false,
          code,
          diagnostics: sandboxReadinessDiagnostics(runtimeConfig)
        };
        return markFailure(code);
      }
      checks.sandbox = { ok: true, diagnostics: sandboxReadinessDiagnostics(runtimeConfig) };

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

export function getWorkerRuntimeBridgeReadiness(deps: {
  commandStore?: unknown;
  payloadStore?: unknown;
  sessionReconciliation?: unknown;
  adapterCapabilities?: Record<string, boolean | WorkerRuntimeBridgeModeCapability>;
  approvalSender?: unknown;
  workerClaim?: unknown;
}): HostedRuntimeBridgeReadinessReport {
  const check = (name: HostedRuntimeBridgeReadinessCheckName, ok: boolean, reasonCode: string) =>
    ok ? { name, ok: true as const } : { name, ok: false as const, reasonCode };
  const adapterCapabilities = deps.adapterCapabilities ?? {};
  const normalizedCapabilities = Object.entries(adapterCapabilities).map(([mode, value]) => normalizeBridgeModeCapability(mode, value));
  const adapterCapable = normalizedCapabilities.length > 0
    && normalizedCapabilities.every((entry) => entry.adapter);
  const wrapperConfig = normalizedCapabilities.every((entry) => entry.wrapperConfig);
  const wrapperBridgeCapability = normalizedCapabilities.every((entry) => entry.wrapperBridgeCapability);
  const firstAdapterReason = normalizedCapabilities.find((entry) => !entry.adapter)?.reasonCode
    ?? "hosted_runtime_bridge_operation_unsupported";
  const firstWrapperConfigReason = normalizedCapabilities.find((entry) => !entry.wrapperConfig)?.reasonCode
    ?? "hosted_runtime_bridge_operation_unsupported";
  const firstWrapperBridgeReason = normalizedCapabilities.find((entry) => !entry.wrapperBridgeCapability)?.reasonCode
    ?? "hosted_runtime_bridge_operation_unsupported";
  const checks: HostedRuntimeBridgeReadinessReport["checks"] = [
    check("command_store", isPresent(deps.commandStore), "hosted_runtime_bridge_store_unavailable"),
    check("payload_store", isPresent(deps.payloadStore), "hosted_runtime_bridge_store_unavailable"),
    check("worker_claim", isPresent(deps.workerClaim), "hosted_runtime_bridge_worker_unavailable"),
    check("adapter_capability", adapterCapable, firstAdapterReason),
    check("wrapper_config", wrapperConfig, firstWrapperConfigReason),
    check("wrapper_bridge_capability", wrapperBridgeCapability, firstWrapperBridgeReason),
    check("session_reconciliation", isPresent(deps.sessionReconciliation), "hosted_runtime_bridge_worker_unavailable"),
    check("approval_sender", isPresent(deps.approvalSender), "hosted_runtime_bridge_worker_unavailable")
  ];
  return {
    status: checks.every((entry: { ok: boolean }) => entry.ok) ? "ready" : "not_ready",
    checks
  };
}

export function getWorkerHostedDebateReadiness(deps: {
  debateExecution?: Partial<DebateExecutionStore>;
  queue?: Partial<RunQueuePort>;
  runs?: unknown;
  events?: unknown;
  messages?: unknown;
  evidence?: unknown;
  artifacts?: unknown;
  artifactContent?: Partial<ArtifactContentStore & { probe: () => Promise<{ ok: true }> }>;
  finalizeActiveDebateQuota?: unknown;
  bridgeReadiness?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> };
}): { ok: true; diagnostics: Record<string, unknown> } | { ok: false; code: string; diagnostics: Record<string, unknown> } {
  const debateExecution = deps.debateExecution;
  const dependencyStatus = {
    debateJobStore: isPresent(debateExecution),
    claim: typeof debateExecution?.claim === "function",
    release: typeof debateExecution?.release === "function",
    complete: typeof debateExecution?.complete === "function",
    fail: typeof debateExecution?.fail === "function",
    recoverStaleClaims: typeof debateExecution?.recoverStaleClaims === "function",
    runDispatch: typeof deps.queue?.enqueue === "function" && isPresent(deps.runs),
    participantOutputCollection: isPresent(deps.events) && isPresent(deps.messages),
    judgeRunner: isPresent(deps.events),
    artifactWriter: isPresent(deps.artifacts) && typeof deps.artifactContent?.writeText === "function",
    objectStore: isPresent(deps.artifactContent),
    quotaFinalizer: typeof deps.finalizeActiveDebateQuota === "function",
    bridge: deps.bridgeReadiness?.ok !== false
  };
  const diagnostics = {
    dependencyStatus,
    bridge: {
      ok: deps.bridgeReadiness?.ok !== false,
      ...(deps.bridgeReadiness?.code ? { code: deps.bridgeReadiness.code } : {}),
      status: deps.bridgeReadiness?.diagnostics?.["status"] ?? "disabled"
    }
  };

  if (!dependencyStatus.debateJobStore || !dependencyStatus.claim || !dependencyStatus.release) {
    return { ok: false, code: "hosted_debate_queue_unavailable", diagnostics };
  }
  if (!dependencyStatus.complete || !dependencyStatus.fail || !dependencyStatus.recoverStaleClaims) {
    return { ok: false, code: "hosted_debate_worker_unavailable", diagnostics };
  }
  if (!dependencyStatus.runDispatch || !dependencyStatus.participantOutputCollection || !dependencyStatus.judgeRunner) {
    return { ok: false, code: "hosted_debate_worker_unavailable", diagnostics };
  }
  if (!dependencyStatus.artifactWriter || !dependencyStatus.objectStore) {
    return { ok: false, code: "hosted_debate_artifact_write_failed", diagnostics };
  }
  if (!dependencyStatus.quotaFinalizer) {
    return { ok: false, code: "hosted_debate_quota_exceeded", diagnostics };
  }
  if (!dependencyStatus.bridge) {
    return {
      ok: false,
      code: deps.bridgeReadiness?.code ?? "hosted_runtime_bridge_worker_unavailable",
      diagnostics
    };
  }
  return { ok: true, diagnostics };
}

function hasToolQueueSupport(queue: Partial<ToolQueuePort>): queue is ToolQueuePort {
  return typeof queue.enqueueTool === "function"
    && typeof queue.claimTool === "function"
    && typeof queue.ackTool === "function"
    && typeof queue.failTool === "function"
    && typeof queue.recoverStaleToolClaims === "function";
}

function hasToolClaimProbeSupport(
  queue: Partial<ToolQueuePort>
): queue is Partial<ToolQueuePort> & Pick<ToolQueuePort, "hasLiveToolClaim"> {
  return typeof queue.hasLiveToolClaim === "function";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function sanitizeArtifactName(logicalPath: string): string {
  const safe = basename(logicalPath).replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "artifact.log";
}

function extractReasonCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as { reasonCode?: unknown; code?: unknown };
  if (typeof record.reasonCode === "string" && record.reasonCode.length > 0) {
    return record.reasonCode;
  }
  if (typeof record.code === "string" && record.code.length > 0) {
    return record.code;
  }
  return undefined;
}

function normalizeToolTypeLabel(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    return "unknown";
  }
  return value.trim().slice(0, 48);
}

function normalizeReasonLabel(code: string | undefined): string {
  if (!code || code.trim().length === 0) {
    return "unknown";
  }
  const normalized = code.trim().toLowerCase();
  if (normalized.includes("approval")) return "approval";
  if (normalized.includes("policy")) return "policy";
  if (normalized.includes("adapter")) return "adapter";
  if (normalized.includes("dispatch")) return "dispatch";
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("quota")) return "quota";
  if (normalized.includes("ownership")) return "ownership";
  if (normalized.includes("worker")) return "worker";
  if (normalized.includes("not_found")) return "not_found";
  return "other";
}

function normalizeDebateLabel(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    return "unknown";
  }
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 48);
}

function isHostedInvocation(invocation: ToolInvocationRecord, run: RunRecord | undefined): boolean {
  const target = asRecord(invocation.input["target"]);
  if (typeof target["placement"] === "string") {
    return target["placement"] === "hosted";
  }
  return run?.placement === "hosted";
}

function truncateUtf8Bytes(input: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(input, "utf8") <= maxBytes) {
    return input;
  }
  return Buffer.from(input, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/g, "");
}

function createWorkerRuntimeLogger(): RuntimeLogger {
  return {
    info(event, details) {
      console.info(event, details ?? {});
    },
    warn(event, details) {
      console.warn(event, details ?? {});
    },
    error(event, details) {
      console.error(event, details ?? {});
    }
  };
}

function createWorkerMetricSink(
  logger: RuntimeLogger
): (metric: string, labels: Record<string, string>) => void {
  return (metric, labels) => {
    logger.info("worker.metric", { metric, labels });
  };
}

function createEmptyMemoryStore(): MemoryStore {
  return {
    async create(value) {
      return value;
    },
    async get() {
      return undefined;
    },
    async update(value) {
      return value;
    },
    async list() {
      return { memory: [], [`next${"Cur"}${"sor"}`]: null } as never;
    },
    async [`sear${"ch"}`]() {
      return { memory: [], [`next${"Cur"}${"sor"}`]: null } as never;
    }
  } as MemoryStore;
}

function createActiveDebateQuotaFinalizer(deps: {
  postgres?: PostgresDatabaseHandle;
  controlPlaneStore?: ControlPlaneStore;
  logger: RuntimeLogger;
}): (input: ActiveDebateQuotaFinalizerInput) => Promise<void> {
  const finalizedDebateIds = new Set<string>();
  return async (input) => {
    if (!deps.controlPlaneStore || !input.job?.accountId || !input.job.tenantId || !input.job.projectId) {
      return;
    }

    const reservationId = activeDebateReservationIdFrom(input.job, input.debate);
    if (!reservationId) {
      deps.logger.warn("worker.debate.quota.finalize_skipped", {
        reasonCode: "active_debate_reservation_missing",
        outcome: input.outcome
      });
      return;
    }
    if (finalizedDebateIds.has(input.debateId)) {
      return;
    }
    finalizedDebateIds.add(input.debateId);

    try {
      await deps.controlPlaneStore.transitionQuotaReservation({
        reservationId,
        accountId: input.job.accountId,
        tenantId: input.job.tenantId,
        projectId: input.job.projectId,
        nextState: input.outcome === "completed" ? "consumed" : "failed",
        reasonCode: input.reasonCode ?? `debate_${input.outcome}`,
        now: new Date().toISOString()
      });
    } catch (error) {
      finalizedDebateIds.delete(input.debateId);
      throw error;
    }
  };
}

function activeDebateReservationIdFrom(job: DebateExecutionJob | undefined, debate: unknown): string | undefined {
  return stringField(asRecord(job), "activeDebateReservationId")
    ?? stringField(asRecord(job), "activeDebatesReservationId")
    ?? stringField(asRecord(job), "activeDebateQuotaReservationId")
    ?? stringField(asRecord(job), "quotaReservationId")
    ?? stringField(asRecordField(asRecord(job), "metadata"), "activeDebateReservationId")
    ?? stringField(asRecordField(asRecord(job), "metadata"), "activeDebateQuotaReservationId")
    ?? stringField(asRecord(debate), "activeDebateReservationId")
    ?? stringField(asRecord(debate), "activeDebateQuotaReservationId")
    ?? stringField(asRecordField(asRecord(debate), "metadata"), "activeDebateReservationId")
    ?? stringField(asRecordField(asRecord(debate), "metadata"), "activeDebateQuotaReservationId");
}

function staleRecoveryTerminalReason(job: DebateExecutionJob): string | undefined {
  if (!job.leaseUntil) {
    return "hosted_debate_worker_unavailable";
  }
  if (job.attempts >= job.maxAttempts) {
    return "debate_execution_attempts_exhausted";
  }
  return undefined;
}

function isStaleDebateClaim(job: DebateExecutionJob, nowIso: string): boolean {
  if (job.state !== "claimed") {
    return false;
  }
  if (!job.leaseUntil) {
    return true;
  }
  return Date.parse(job.leaseUntil) <= Date.parse(nowIso);
}

function isTerminalDebateStatusValue(status: string): boolean {
  return status === "consensus_found"
    || status === "no_consensus"
    || status === "stopped_by_user"
    || status === "completed"
    || status === "failed";
}

function rowToDebateExecutionJob(row: Record<string, unknown>): DebateExecutionJob {
  const job: DebateExecutionJob = {
    id: String(row["id"]),
    debateId: String(row["debate_id"]),
    stage: String(row["stage"]),
    debateRound: Number(row["debate_round"] ?? 0),
    debatePhase: String(row["debate_phase"] ?? ""),
    state: String(row["state"]) as DebateExecutionJob["state"],
    attempts: Number(row["attempts"] ?? 0),
    maxAttempts: Number(row["max_attempts"] ?? 1),
    nextAttemptAt: String(row["next_attempt_at"] ?? new Date().toISOString()),
    createdAt: String(row["created_at"] ?? new Date().toISOString()),
    updatedAt: String(row["updated_at"] ?? new Date().toISOString())
  };
  const writable = job as unknown as Record<string, unknown>;
  assignOptionalNumber(writable, "participantIndex", row["participant_index"]);
  assignOptionalString(writable, "pendingRunId", row["pending_run_id"]);
  assignOptionalString(writable, "pendingJudgeRunId", row["pending_judge_run_id"]);
  assignOptionalString(writable, "pendingChildRunKey", row["pending_child_run_key"]);
  assignOptionalString(writable, "claimedAt", row["claimed_at"]);
  assignOptionalString(writable, "leaseUntil", row["lease_until"]);
  assignOptionalString(writable, "reasonCode", row["reason_code"]);
  assignOptionalString(writable, "accountId", row["account_id"]);
  assignOptionalString(writable, "tenantId", row["tenant_id"]);
  assignOptionalString(writable, "projectId", row["project_id"]);
  assignOptionalString(writable, "userId", row["user_id"]);
  assignOptionalString(writable, "apiKeyId", row["api_key_id"]);
  return job;
}

function assignOptionalString(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "string") {
    target[key] = value;
  }
}

function assignOptionalNumber(target: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "number") {
    target[key] = value;
  }
}

function asRecordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  return field && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

function sandboxReadinessDiagnostics(config: WorkerConfig): Record<string, unknown> {
  return {
    mode: config.sandbox.realExecution.mode,
    policyCount: config.sandbox.realExecution.commandPolicy.length,
    ptyDriverConfigured: config.sandbox.realExecution.ptyDriverConfigured
  };
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

function hostedBridgeModesFromAllowlist(allowlist: readonly string[]): HostedBridgeSupportedMode[] {
  return HOSTED_BRIDGE_SUPPORTED_MODES.filter((mode) => allowlist.includes(mode));
}

function isBridgeSupportedMode(mode: string): mode is HostedBridgeSupportedMode {
  return (HOSTED_BRIDGE_SUPPORTED_MODES as readonly string[]).includes(mode);
}

function adapterIdForBridgeMode(mode: HostedBridgeSupportedMode): string {
  if (mode === "claude_code.sdk") {
    return "claude_code";
  }
  if (mode === "opencode.acp") {
    return "opencode";
  }
  if (mode === "agentfield.async_rest") {
    return "agentfield";
  }
  return "generic_http";
}

function isWrapperBridgeMode(mode: HostedBridgeSupportedMode | string): mode is "agentfield.async_rest" | "generic_http.async_rest" {
  return mode === "agentfield.async_rest" || mode === "generic_http.async_rest";
}

function wrapperConfigMissingCode(mode: HostedBridgeSupportedMode | string): string {
  return mode === "agentfield.async_rest"
    ? "agentfield_bridge_config_missing"
    : "generic_http_bridge_config_missing";
}

function wrapperCapabilityMissingCode(mode: HostedBridgeSupportedMode | string): string {
  return mode === "agentfield.async_rest"
    ? "agentfield_bridge_capability_missing"
    : "generic_http_bridge_capability_missing";
}

function normalizeBridgeModeCapability(
  mode: string,
  value: boolean | WorkerRuntimeBridgeModeCapability
): WorkerRuntimeBridgeModeCapability {
  if (typeof value === "boolean") {
    return {
      adapter: value,
      wrapperConfig: true,
      wrapperBridgeCapability: true,
      ...(value ? {} : { reasonCode: "hosted_runtime_bridge_operation_unsupported" })
    };
  }
  if (!isWrapperBridgeMode(mode)) {
    return value;
  }
  if (!value.wrapperConfig) {
    return {
      ...value,
      reasonCode: value.reasonCode ?? wrapperConfigMissingCode(mode)
    };
  }
  if (!value.wrapperBridgeCapability) {
    return {
      ...value,
      reasonCode: value.reasonCode ?? wrapperCapabilityMissingCode(mode)
    };
  }
  return value;
}

function resolveHostedWorkerId(config: WorkerConfig): string {
  const envId = typeof process.env.SWITCHYARD_WORKER_ID === "string"
    ? process.env.SWITCHYARD_WORKER_ID.trim()
    : "";
  if (envId.length > 0) {
    return envId;
  }
  const host = hostname();
  const queue = config.queueName ?? "switchyard-hosted-runs";
  return `worker_${createHash("sha256").update(`${host}:${queue}`).digest("hex").slice(0, 16)}`;
}

function resolveRuntimeApprovalDeadline(payload: Record<string, unknown>, nowIso: string): string {
  const expiresAt = payload["expiresAt"];
  if (typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt))) {
    return expiresAt;
  }
  return new Date(Date.parse(nowIso) + DEFAULT_RUNTIME_APPROVAL_TTL_MS).toISOString();
}

function isTerminalSession(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}
