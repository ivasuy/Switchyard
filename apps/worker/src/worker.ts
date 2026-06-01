import { basename } from "node:path";
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
  type EventStore,
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
  artifactContent?: ArtifactContentStore & { probe: () => Promise<{ ok: true }> };
  invocations?: ToolInvocationStore;
  approvals?: ApprovalStore;
  toolPolicy?: ToolPolicyPort;
  now?: () => number;
  readinessTtlMs?: number;
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
  const artifacts: ArtifactStore = new PostgresArtifactStore(postgres);
  const invocations: ToolInvocationStore = deps?.invocations ?? (postgres ? new PostgresToolInvocationStore(postgres) : new InMemoryToolInvocationStore());
  const approvals: ApprovalStore = deps?.approvals ?? (postgres ? new PostgresApprovalStore(postgres) : new InMemoryApprovalStore());
  const artifactContent: ArtifactContentStore & { probe: () => Promise<{ ok: true }> } =
    deps?.artifactContent ?? createArtifactContentStoreFromObjectConfig(runtimeConfig.objectStore);

  const adapters = buildHostedWorkerAdapters(runtimeConfig, deps?.adapters);
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

    const invocation = await invocations.get(claimed.payload.toolInvocationId);
    if (!invocation) {
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
      await toolQueue.failTool(claimed.id, { reasonCode: "hosted_run_state_invalid", message: "run_not_found" });
      return true;
    }

    const approval = await approvals.get(claimed.payload.approvalId);
    if (!approval) {
      await transitionToolInvocation(invocation, "failed", {
        code: "approval_not_found",
        message: "approval_not_found"
      });
      await toolQueue.failTool(claimed.id, { reasonCode: "approval_not_found", message: "approval_not_found" });
      return true;
    }

    if (approval.status !== "approved" && !(runtimeConfig.deploymentMode !== "production" && runtimeConfig.tools.allowNoApprovalInTest)) {
      await transitionToolInvocation(invocation, "failed", {
        code: "approval_not_pending",
        message: "approval_not_approved"
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
      await toolQueue.failTool(claimed.id, { reasonCode: "tool_policy_failed", message: "tool_policy_failed" });
      return true;
    }

    if (invocation.type === TOOL_KIND_REPO) {
      await transitionToolInvocation(invocation, "denied", {
        code: CODE_REPO_UNSHIPPED,
        message: "Hosted source-control inspection execution is not shipped"
      });
      await toolQueue.failTool(claimed.id, { reasonCode: CODE_REPO_UNSHIPPED, message: CODE_REPO_UNSHIPPED });
      return true;
    }

    if (invocation.type === TOOL_KIND_BROWSER) {
      await transitionToolInvocation(invocation, "denied", {
        code: CODE_BROWSER_UNSHIPPED,
        message: "Interactive page control execution is not shipped"
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
      await toolQueue.failTool(claimed.id, { reasonCode: "tool_adapter_unavailable", message: "tool_adapter_unavailable" });
      return true;
    }

    try {
      const adapterInput = persistedRunning.type === "fake_echo"
        ? requestInput
        : { request: requestInput, executionPlan: policyDecision.executionPlan };
      const output = redactSecrets(await adapter.invoke(adapterInput));
      const storedOutput = await persistToolArtifacts(run.id, persistedRunning.id, output);
      await transitionToolInvocation(persistedRunning, "completed", undefined, storedOutput);
      await toolQueue.ackTool(claimed.id);
      return true;
    } catch (error) {
      const reasonCode = extractReasonCode(error) ?? "tool_execution_failed";
      await transitionToolInvocation(persistedRunning, "failed", {
        code: reasonCode,
        message: error instanceof Error ? error.message : String(error)
      });
      await toolQueue.failTool(claimed.id, { reasonCode, message: reasonCode });
      return true;
    }
  }

  async function persistToolArtifacts(
    runId: string,
    toolInvocationId: string,
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
      const content = redactSecrets(typeof candidate["content"] === "string" ? candidate["content"] : "");
      const contentType = typeof candidate["contentType"] === "string" ? candidate["contentType"] : "text/plain";
      const safeName = sanitizeArtifactName(logicalPath);
      const artifactPath = `runs/${runId}/tools/${toolInvocationId}/${safeName}`;

      const stored = await artifactContent.writeText(artifactPath, content, { contentType });
      const artifact: ArtifactRecord = {
        id: `artifact_${crypto.randomUUID()}`,
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
      await artifacts.create(artifact);
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
  }

  async function reconcileStaleRunningInvocations(): Promise<void> {
    const page = await invocations.list({
      status: "running",
      limit: 5000
    });
    for (const invocation of page.invocations) {
      await transitionToolInvocation(invocation, "failed", {
        code: "tool_worker_restarted",
        message: "Tool invocation interrupted by worker restart"
      });
    }
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
