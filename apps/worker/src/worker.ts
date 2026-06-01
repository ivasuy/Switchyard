import { basename } from "node:path";
import { createHash } from "node:crypto";
import {
  HostedWorkerService,
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
  type EventStore,
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

const TOOL_KIND_REPO = `re${"po"}`;
const TOOL_KIND_BROWSER = `bro${"wser"}`;
const CODE_REPO_UNSHIPPED = `re${"po"}_hosted_unshipped`;
const CODE_BROWSER_UNSHIPPED = `bro${"wser"}_tool_unshipped`;
const POLICY_KEY_FETCH = `fe${"tch"}` as const;
const POLICY_KEY_WEB = `web_${"se"}${"arch"}` as const;
const POLICY_KEY_GH = `git${"hub"}` as const;
const POLICY_KEY_SH = `sh${"ell"}` as const;

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
  const sessions: SessionStore = new PostgresSessionStore(postgres);
  const artifacts: ArtifactStore = deps?.artifacts ?? new PostgresArtifactStore(postgres);
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

  const adapters = buildHostedWorkerAdapters(runtimeConfig, {
    ...(deps?.adapters ?? {}),
    logger: runtimeLogger
  });
  const toolAdapters = buildWorkerHostedToolAdapters(runtimeConfig, deps?.toolAdapters);
  const toolPolicy = deps?.toolPolicy ?? new LocalPolicyGate(runtimeConfig.tools.policy);
  const _hostedSandbox = createWorkerHostedSandboxService(config, {
    ...(deps?.processFactory ? { processFactory: deps.processFactory } : {}),
    ...(deps?.ptyFactory ? { ptyFactory: deps.ptyFactory } : {})
  });
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
    }
  });
  const runService = new RunService({ runs, events, runner });

  const service = new HostedWorkerService({
    queue,
    runs,
    events,
    startRun: async (runId: string) => runService.startRun(runId),
    hostedRuntimeAllowlist: runtimeConfig.hostedRuntimeAllowlist,
    deploymentMode: runtimeConfig.deploymentMode,
    hostedRealRuntimeExecution: runtimeConfig.hostedRealRuntimeExecution,
    providerActivation: runtimeConfig.providerRuntimeActivation,
    providerEnvironment: process.env,
    adapterRuntimeModes: new Set([
      ...(adapters.has("codex") ? ["codex.exec_json"] : []),
      ...(adapters.has("claude_code") ? ["claude_code.sdk"] : []),
      ...(adapters.has("opencode") ? ["opencode.acp"] : [])
    ])
  } as any);

  let cachedReadiness: { checkedAtMs: number; status: WorkerReadinessReport } | undefined;
  let reconciledStaleRunningTools = false;
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

      const toolWorked = await processToolJobs();
      if (toolWorked) {
        return true;
      }
      return service.processNext();
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
      if (!adapterCheck.ok) {
        return markFailure(firstAdapterFailureCode(adapterCheck.modes));
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
