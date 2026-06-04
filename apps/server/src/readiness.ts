import { access, constants } from "node:fs/promises";
import {
  checkHostedSandboxReadiness,
  createDisabledRealToolPolicyConfig,
  isKnownHostedRuntimeMode,
  redactSecrets,
  validateHostedRuntimeAllowlist,
  type RunQueuePort,
  type ProviderRuntimeActivationResult
} from "@switchyard/core";
import type { ProbeableArtifactContentStore } from "@switchyard/storage";
import {
  checkPostgresSchemaCompatibility,
  POSTGRES_SCHEMA_VERSION,
  probePostgresDatabase,
  type PostgresDatabaseHandle,
  type PostgresSchemaCompatibility
} from "@switchyard/storage";
import type { ServerConfig } from "./config.js";

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, { ok: boolean; code?: string; diagnostics?: Record<string, unknown> }>;
}

interface UnownedResourceCounts {
  runs: number;
  runEvents: number;
  artifacts: number;
  toolInvocations: number;
  approvals: number;
  placements: number;
  nodes: number;
  assignments: number;
  auditEvents: number;
  quotaReservations: number;
  debates: number;
  debateExecutionJobs: number;
  messages: number;
  evidence: number;
  childRuns: number;
  debateArtifacts: number;
  debateEvents: number;
}

interface ControlPlaneReadinessInput {
  mode: "disabled" | "missing" | "enabled";
  hasApiKeyPepper: boolean;
  hasBootstrap: boolean;
  bootstrapActiveCounts: {
    accounts: number;
    tenants: number;
    projects: number;
    users: number;
    apiKeys: number;
    billingPlans: number;
  } | undefined;
  storeReady: boolean;
  hasQuotaStore: boolean;
  hasAuditStore: boolean;
  nodeTokenBound: boolean;
  unownedResources: UnownedResourceCounts | undefined;
}

interface RuntimeBridgeReadinessInput {
  enabled: boolean;
  commandStore?: unknown;
  commandOutbox?: unknown;
  approvalOwnership?: unknown;
  quota?: unknown;
  audit?: unknown;
  routeAuth?: unknown;
  workerReadiness?: unknown;
  wrapperConfig?: unknown;
  wrapperBridgeCapability?: unknown;
}

interface HostedDebateReadinessInput {
  enabled?: boolean;
  debateStore?: unknown;
  messageStore?: unknown;
  evidenceStore?: unknown;
  eventStore?: unknown;
  artifactMetadataStore?: unknown;
  artifactContentStore?: unknown;
  debateExecutionOutbox?: unknown;
  runQueue?: unknown;
  ownership?: unknown;
  quota?: unknown;
  audit?: unknown;
  routeAuth?: unknown;
}

type HostedRuntimeBridgeReadinessCheckName =
  | "command_store"
  | "command_outbox"
  | "approval_ownership"
  | "quota"
  | "audit"
  | "route_auth"
  | "worker_claim"
  | "adapter_capability"
  | "session_reconciliation"
  | "approval_sender"
  | "wrapper_config"
  | "wrapper_bridge_capability";

interface HostedRuntimeBridgeReadinessReport {
  status: "ready" | "not_ready";
  checks: Array<{ name: HostedRuntimeBridgeReadinessCheckName; ok: boolean; reasonCode?: string }>;
}

export async function probeServerReadiness(input: {
  config: ServerConfig;
  postgres: PostgresDatabaseHandle | undefined;
  queue: RunQueuePort;
  artifactContent: ProbeableArtifactContentStore;
  controlPlane?: ControlPlaneReadinessInput;
  runtimeBridge?: RuntimeBridgeReadinessInput;
  hostedDebate?: HostedDebateReadinessInput;
  checkSchemaCompatibility?: (handle: PostgresDatabaseHandle) => Promise<PostgresSchemaCompatibility>;
}): Promise<ReadinessReport> {
  const checks: ReadinessReport["checks"] = {};
  const providerRuntimeActivation = normalizeProviderRuntimeActivation(input.config);

  if (input.postgres) {
    try {
      await probePostgresDatabase(input.postgres);
      checks.postgres = { ok: true };
      if (input.config.deploymentMode === "staging" || input.config.deploymentMode === "production") {
        const schemaCheck = await (input.checkSchemaCompatibility ?? checkPostgresSchemaCompatibility)(input.postgres);
        if (schemaCheck.ok) {
          checks.schema = {
            ok: true,
            code: schemaCheck.code,
            diagnostics: {
              version: schemaCheck.version,
              expectedVersion: POSTGRES_SCHEMA_VERSION
            }
          };
        } else {
          checks.schema = {
            ok: false,
            code: schemaCheck.code,
            diagnostics: redactSecrets({
              expectedVersion: POSTGRES_SCHEMA_VERSION,
              ...(typeof schemaCheck.version === "number" ? { version: schemaCheck.version } : {}),
              ...(schemaCheck.diagnostics ? schemaCheck.diagnostics : {})
            })
          };
        }
      }
    } catch {
      checks.postgres = { ok: false, code: "postgres_unavailable" };
      if (input.config.deploymentMode === "staging" || input.config.deploymentMode === "production") {
        checks.schema = {
          ok: false,
          code: "postgres_unavailable",
          diagnostics: { expectedVersion: POSTGRES_SCHEMA_VERSION }
        };
      }
    }
  } else {
    checks.postgres = { ok: input.config.deploymentMode === "local" || input.config.deploymentMode === "test", code: "postgres_not_configured" };
    if (input.config.deploymentMode === "staging" || input.config.deploymentMode === "production") {
      checks.schema = {
        ok: false,
        code: "postgres_unavailable",
        diagnostics: { expectedVersion: POSTGRES_SCHEMA_VERSION }
      };
    }
  }

  try {
    await input.queue.stats();
    checks.queue = { ok: true };
  } catch {
    checks.queue = { ok: false, code: "queue_unavailable" };
  }

  if (input.config.objectStore.backend === "local") {
    try {
      await access(input.config.objectStore.directory, constants.R_OK | constants.W_OK);
      if (input.config.objectStore.probe !== "disabled") {
        await input.artifactContent.probe();
      }
      checks.objectStore = { ok: true };
    } catch (error) {
      const code = error instanceof Error ? error.message : "object_store_unavailable";
      checks.objectStore = {
        ok: false,
        code: code.startsWith("object_store_") || code.startsWith("artifact_")
          ? code
          : "object_store_unavailable",
        diagnostics: redactSecrets({
          backend: input.config.objectStore.backend,
          summary: input.config.objectStore.redactedSummary
        })
      };
    }
  } else if (input.config.objectStore.backend === "s3-compatible") {
    try {
      if (input.config.objectStore.probe !== "disabled") {
        await input.artifactContent.probe();
      }
      checks.objectStore = { ok: true };
    } catch (error) {
      const code = error instanceof Error ? error.message : "object_store_unavailable";
      checks.objectStore = {
        ok: false,
        code: code.startsWith("object_store_") || code.startsWith("artifact_")
          ? code
          : "object_store_unavailable",
        diagnostics: redactSecrets({
          backend: input.config.objectStore.backend,
          summary: input.config.objectStore.redactedSummary
        })
      };
    }
  } else {
    checks.objectStore = { ok: true };
  }

  if (input.config.deploymentMode === "staging" || input.config.deploymentMode === "production") {
    if (input.config.nodeSharedToken) {
      checks.nodeToken = { ok: true };
    } else {
      checks.nodeToken = { ok: false, code: "node_auth_required" };
    }
  } else {
    checks.nodeToken = { ok: true };
  }

  const allowlist = input.config.hostedRuntimeAllowlist;
  if (allowlist.length === 0 || allowlist.some((mode) => !isKnownHostedRuntimeMode(mode))) {
    checks.hostedAllowlist = { ok: false, code: "hosted_runtime_not_allowed" };
  } else {
    checks.hostedAllowlist = { ok: true };
  }
  const gateValidation = validateHostedRuntimeAllowlist({
    allowlist,
    deploymentMode: input.config.deploymentMode,
    realRuntimeExecution: input.config.hostedRealRuntimeExecution,
    providerActivation: providerRuntimeActivation
  });
  if (gateValidation.ok) {
    checks.hostedRuntimeGate = { ok: true };
  } else {
    checks.hostedRuntimeGate = { ok: false, code: gateValidation.code };
  }

  const hasRealAllowlist = allowlist.some((mode) => mode !== "fake.deterministic");
  if (!hasRealAllowlist) {
    checks.providerRuntimeActivation = {
      ok: true,
      diagnostics: {
        source: providerRuntimeActivation.redactedSummary.source.kind,
        enabledRealModeCount: providerRuntimeActivation.redactedSummary.enabledRealModeCount,
        policyVersion: providerRuntimeActivation.redactedSummary.policyVersion
      }
    };
  } else if (input.config.hostedRealRuntimeExecution !== "enabled") {
    checks.providerRuntimeActivation = { ok: false, code: "hosted_real_runtime_disabled" };
  } else if (input.config.deploymentMode === "production" && !providerRuntimeActivation.valid) {
    checks.providerRuntimeActivation = {
      ok: false,
      code: providerRuntimeActivation.reasons[0]?.code ?? "provider_runtime_policy_missing",
      diagnostics: redactSecrets({
        source: providerRuntimeActivation.redactedSummary.source.kind,
        reasonCodes: providerRuntimeActivation.redactedSummary.reasonCodes,
        modeStatuses: providerRuntimeActivation.redactedSummary.modeStatuses,
        policyVersion: providerRuntimeActivation.redactedSummary.policyVersion
      })
    };
  } else {
    checks.providerRuntimeActivation = {
      ok: true,
      diagnostics: redactSecrets({
        source: providerRuntimeActivation.redactedSummary.source.kind,
        reasonCodes: providerRuntimeActivation.redactedSummary.reasonCodes,
        modeStatuses: providerRuntimeActivation.redactedSummary.modeStatuses,
        enabledRealModeCount: providerRuntimeActivation.redactedSummary.enabledRealModeCount,
        policyVersion: providerRuntimeActivation.redactedSummary.policyVersion
      })
    };
  }

  const sandbox = checkHostedSandboxReadiness(input.config.sandbox);
  const sandboxDiagnostics = buildSandboxDiagnostics(input.config);
  if (sandbox.ok) {
    checks.sandbox = {
      ok: true,
      diagnostics: sandboxDiagnostics
    };
  } else {
    const code = sandbox.code ?? "sandbox_config_invalid";
    checks.sandbox = {
      ok: false,
      code,
      diagnostics: redactSecrets(sandboxDiagnostics)
    };
  }

  const strictControlPlane =
    input.config.serverAuthMode === "api_key" ||
    input.config.deploymentMode === "staging" ||
    input.config.deploymentMode === "production";
  const controlPlane = input.controlPlane ?? {
    mode: strictControlPlane ? "missing" as const : "disabled" as const,
    hasApiKeyPepper: Boolean(input.config.apiKeyPepper),
    hasBootstrap: Boolean(input.config.controlPlaneBootstrap),
    bootstrapActiveCounts: input.config.controlPlaneBootstrap?.active,
    storeReady: false,
    hasQuotaStore: false,
    hasAuditStore: false,
    nodeTokenBound: !input.config.nodeSharedToken,
    unownedResources: undefined
  };

  checks.apiKeyAuth = strictControlPlane
    ? readinessCheck(controlPlane.mode === "enabled", "api_key_auth_disabled")
    : readinessCheck(true);

  checks.apiKeyPepper = strictControlPlane
    ? readinessCheck(controlPlane.hasApiKeyPepper, "api_key_pepper_missing")
    : readinessCheck(true);

  checks.bootstrap = strictControlPlane
    ? readinessCheck(controlPlane.hasBootstrap, "control_plane_bootstrap_missing")
    : readinessCheck(true);

  checks.controlPlaneStore = strictControlPlane
    ? readinessCheck(controlPlane.storeReady, "control_plane_store_unavailable")
    : readinessCheck(true);

  checks.billingPlan = strictControlPlane
    ? readinessCheck((controlPlane.bootstrapActiveCounts?.billingPlans ?? 0) > 0, "control_plane_bootstrap_zero_active")
    : readinessCheck(true);

  checks.quotaStore = strictControlPlane
    ? readinessCheck(controlPlane.hasQuotaStore, "quota_store_unavailable")
    : readinessCheck(true);

  checks.auditStore = strictControlPlane
    ? readinessCheck(controlPlane.hasAuditStore, "audit_store_unavailable")
    : readinessCheck(true);

  if (strictControlPlane && input.config.nodeSharedToken && !controlPlane.nodeTokenBound) {
    checks.nodeToken = { ok: false, code: "node_token_unbound" };
  }

  const unowned = controlPlane.unownedResources;
  const unownedVisibleTotal = countUnownedResources(unowned);
  checks.unownedResources = strictControlPlane
    ? readinessCheck(
        unownedVisibleTotal === 0,
        "unowned_resources_present",
        unownedVisibleTotal === 0
          ? undefined
          : buildUnownedResourceDiagnostics(unowned)
      )
    : readinessCheck(true);

  const toolsConfig = input.config.tools ?? {
    hostedRealTools: "disabled" as const,
    connectedNodeRealTools: "disabled" as const,
    policySourceKind: "none" as const,
    policy: createDisabledRealToolPolicyConfig()
  };
  const enabledToolTypes = [
    ...(toolsConfig.policy.fetch.enabled ? ["fetch"] : []),
    ...(toolsConfig.policy.webSearch.enabled ? ["web_search"] : []),
    ...(toolsConfig.policy.github.enabled ? ["github"] : []),
    ...(toolsConfig.policy.repo.enabled ? ["repo"] : []),
    ...(toolsConfig.policy.shell.enabled ? ["shell"] : [])
  ];
  const toolDiagnostics = {
    hostedRealTools: toolsConfig.hostedRealTools,
    connectedNodeRealTools: toolsConfig.connectedNodeRealTools,
    policySourceKind: toolsConfig.policySourceKind,
    allowedPlacements: [...toolsConfig.policy.global.allowedPlacements],
    enabledToolTypes,
    storeAvailable: Boolean(input.postgres) || input.config.deploymentMode === "local" || input.config.deploymentMode === "test",
    queueAvailable: hasToolQueueSupport(input.queue as RunQueuePort & Partial<Record<string, unknown>>),
    ownershipAvailable: controlPlane.storeReady,
    quotaAvailable: controlPlane.hasQuotaStore,
    auditAvailable: controlPlane.hasAuditStore,
    routeAuthAvailable: controlPlane.mode === "enabled"
  };

  const toolsEnabled = toolsConfig.hostedRealTools === "enabled" || toolsConfig.connectedNodeRealTools === "enabled";
  if (!toolsEnabled) {
    checks.tools = readinessCheck(true, undefined, toolDiagnostics);
  } else if (toolsConfig.policySourceKind === "none") {
    checks.tools = readinessCheck(false, "tool_policy_config_invalid", toolDiagnostics);
  } else if (!toolDiagnostics.routeAuthAvailable) {
    checks.tools = readinessCheck(false, "tool_hosted_auth_required", toolDiagnostics);
  } else if (!toolDiagnostics.storeAvailable || !toolDiagnostics.ownershipAvailable) {
    checks.tools = readinessCheck(false, "tool_store_unavailable", toolDiagnostics);
  } else if (!toolDiagnostics.queueAvailable) {
    checks.tools = readinessCheck(false, "tool_dispatch_unavailable", toolDiagnostics);
  } else if (!toolDiagnostics.quotaAvailable) {
    checks.tools = readinessCheck(false, "quota_store_unavailable", toolDiagnostics);
  } else if (!toolDiagnostics.auditAvailable) {
    checks.tools = readinessCheck(false, "audit_store_unavailable", toolDiagnostics);
  } else if (enabledToolTypes.length === 0) {
    checks.tools = readinessCheck(false, "tool_policy_config_invalid", toolDiagnostics);
  } else {
    checks.tools = readinessCheck(true, undefined, toolDiagnostics);
  }

  let bridgeReadiness: HostedRuntimeBridgeReadinessReport | undefined;
  if (input.runtimeBridge?.enabled) {
    bridgeReadiness = getServerRuntimeBridgeReadiness({
      commandStore: input.runtimeBridge.commandStore,
      commandOutbox: input.runtimeBridge.commandOutbox,
      approvalOwnership: input.runtimeBridge.approvalOwnership,
      quota: input.runtimeBridge.quota,
      audit: input.runtimeBridge.audit,
      routeAuth: input.runtimeBridge.routeAuth,
      workerReadiness: input.runtimeBridge.workerReadiness,
      wrapperRequired: hasWrapperRuntimeAllowlist(input.config.hostedRuntimeAllowlist),
      wrapperConfig: input.runtimeBridge.wrapperConfig,
      wrapperBridgeCapability: input.runtimeBridge.wrapperBridgeCapability
    });
    const firstFailure = bridgeReadiness.checks.find((check: { ok: boolean; reasonCode?: string }) => !check.ok)?.reasonCode ?? "hosted_runtime_bridge_worker_unavailable";
    checks.hostedRuntimeBridge = readinessCheck(
      bridgeReadiness.status === "ready",
      bridgeReadiness.status === "ready" ? undefined : firstFailure,
      { status: bridgeReadiness.status, checks: bridgeReadiness.checks }
    );
  }

  if (shouldCheckHostedDebateReadiness(input.config, input.hostedDebate)) {
    checks.hostedDebate = buildHostedDebateReadiness({
      config: input.config,
      postgres: input.postgres,
      queueReady: checks.queue.ok,
      objectStoreCheck: checks.objectStore,
      hostedAllowlistCheck: checks.hostedAllowlist,
      hostedRuntimeGateCheck: checks.hostedRuntimeGate,
      providerRuntimeActivationCheck: checks.providerRuntimeActivation,
      providerRuntimeActivation,
      controlPlane,
      unownedResources: unowned,
      bridgeReadiness: bridgeReadiness ?? (
        requiresRuntimeBridge(input.config.hostedRuntimeAllowlist) && input.runtimeBridge
          ? getServerRuntimeBridgeReadiness({
              commandStore: input.runtimeBridge.commandStore,
              commandOutbox: input.runtimeBridge.commandOutbox,
              approvalOwnership: input.runtimeBridge.approvalOwnership,
              quota: input.runtimeBridge.quota,
              audit: input.runtimeBridge.audit,
              routeAuth: input.runtimeBridge.routeAuth,
              workerReadiness: input.runtimeBridge.workerReadiness,
              wrapperRequired: hasWrapperRuntimeAllowlist(input.config.hostedRuntimeAllowlist),
              wrapperConfig: input.runtimeBridge.wrapperConfig,
              wrapperBridgeCapability: input.runtimeBridge.wrapperBridgeCapability
            })
          : undefined
      ),
      hostedDebate: input.hostedDebate,
      artifactContent: input.artifactContent
    });
  }

  const ok = Object.values(checks).every((check) => check.ok);
  return { ok, checks };
}

export function getServerRuntimeBridgeReadiness(deps: {
  commandStore?: unknown;
  commandOutbox?: unknown;
  approvalOwnership?: unknown;
  quota?: unknown;
  audit?: unknown;
  routeAuth?: unknown;
  workerReadiness?: unknown;
  wrapperRequired?: boolean;
  wrapperConfig?: unknown;
  wrapperBridgeCapability?: unknown;
}): HostedRuntimeBridgeReadinessReport {
  const worker = asRecord(deps.workerReadiness);
  const check = (name: HostedRuntimeBridgeReadinessCheckName, ok: boolean, reasonCode: string) =>
    ok ? { name, ok: true as const } : { name, ok: false as const, reasonCode };
  const wrapperConfigReason = wrapperReasonCode(deps.wrapperConfig, "config");
  const wrapperCapabilityReason = wrapperReasonCode(deps.wrapperBridgeCapability, "capability");

  const checks: HostedRuntimeBridgeReadinessReport["checks"] = [
    check("command_store", isPresent(deps.commandStore), "hosted_runtime_bridge_store_unavailable"),
    check("command_outbox", isPresent(deps.commandOutbox), "hosted_runtime_bridge_queue_unavailable"),
    check("approval_ownership", isPresent(deps.approvalOwnership), "approval_ownership_attach_failed"),
    check("quota", isPresent(deps.quota), "quota_store_unavailable"),
    check("audit", isPresent(deps.audit), "audit_log_unavailable"),
    check("route_auth", isPresent(deps.routeAuth), "auth_required"),
    check("worker_claim", workerFlag(worker, "claim"), "hosted_runtime_bridge_worker_unavailable"),
    check("adapter_capability", workerFlag(worker, "adapterCapability"), "hosted_runtime_bridge_operation_unsupported"),
    check("session_reconciliation", workerFlag(worker, "sessionReconciliation"), "hosted_runtime_bridge_worker_unavailable"),
    check("approval_sender", workerFlag(worker, "approvalSender"), "hosted_runtime_bridge_worker_unavailable")
  ];
  if (deps.wrapperRequired) {
    checks.push(
      check("wrapper_config", wrapperConfigReason === undefined, wrapperConfigReason ?? "agentfield_bridge_config_missing"),
      check(
        "wrapper_bridge_capability",
        wrapperCapabilityReason === undefined,
        wrapperCapabilityReason ?? "agentfield_bridge_capability_missing"
      )
    );
  }

  return {
    status: checks.every((entry: { ok: boolean }) => entry.ok) ? "ready" : "not_ready",
    checks
  };
}

function readinessCheck(ok: boolean, code?: string, diagnostics?: Record<string, unknown>): {
  ok: boolean;
  code?: string;
  diagnostics?: Record<string, unknown>;
} {
  const out: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> } = { ok };
  if (!ok && code) {
    out.code = code;
  }
  if (diagnostics) {
    out.diagnostics = diagnostics;
  }
  return out;
}

function shouldCheckHostedDebateReadiness(config: ServerConfig, input: HostedDebateReadinessInput | undefined): boolean {
  if (typeof input?.enabled === "boolean") {
    return input.enabled;
  }
  return config.deploymentMode === "staging" || config.deploymentMode === "production";
}

function buildHostedDebateReadiness(input: {
  config: ServerConfig;
  postgres: PostgresDatabaseHandle | undefined;
  queueReady: boolean;
  objectStoreCheck: ReadinessReport["checks"][string];
  hostedAllowlistCheck: ReadinessReport["checks"][string];
  hostedRuntimeGateCheck: ReadinessReport["checks"][string];
  providerRuntimeActivationCheck: ReadinessReport["checks"][string];
  providerRuntimeActivation: ProviderRuntimeActivationResult;
  controlPlane: ControlPlaneReadinessInput;
  unownedResources: UnownedResourceCounts | undefined;
  bridgeReadiness: HostedRuntimeBridgeReadinessReport | undefined;
  hostedDebate: HostedDebateReadinessInput | undefined;
  artifactContent: ProbeableArtifactContentStore;
}): { ok: boolean; code?: string; diagnostics?: Record<string, unknown> } {
  const hostedDebate = input.hostedDebate;
  const providerActivationFailureCode = hostedDebateProviderActivationFailureCode(
    input.config,
    input.providerRuntimeActivation,
    input.providerRuntimeActivationCheck
  );
  const dependencyStatus = {
    debateStore: dependencyAvailable(hostedDebate, "debateStore", Boolean(input.postgres)),
    messageStore: dependencyAvailable(hostedDebate, "messageStore", Boolean(input.postgres)),
    evidenceStore: dependencyAvailable(hostedDebate, "evidenceStore", Boolean(input.postgres)),
    eventStore: dependencyAvailable(hostedDebate, "eventStore", Boolean(input.postgres)),
    artifactMetadataStore: dependencyAvailable(hostedDebate, "artifactMetadataStore", Boolean(input.postgres)),
    artifactContentStore: dependencyAvailable(hostedDebate, "artifactContentStore", isPresent(input.artifactContent)),
    debateExecutionOutbox: dependencyAvailable(hostedDebate, "debateExecutionOutbox", Boolean(input.postgres)),
    runQueue: dependencyAvailable(hostedDebate, "runQueue", input.queueReady),
    objectStore: input.objectStoreCheck.ok,
    ownership: dependencyAvailable(hostedDebate, "ownership", input.controlPlane.storeReady),
    quota: dependencyAvailable(hostedDebate, "quota", input.controlPlane.hasQuotaStore),
    audit: dependencyAvailable(hostedDebate, "audit", input.controlPlane.hasAuditStore),
    routeAuth: dependencyAvailable(hostedDebate, "routeAuth", input.controlPlane.mode === "enabled"),
    hostedRuntimeAllowlist: input.hostedAllowlistCheck.ok,
    hostedRuntimeGate: input.hostedRuntimeGateCheck.ok,
    providerRuntimeActivation: providerActivationFailureCode === undefined
  };
  const bridgeRequired = requiresRuntimeBridge(input.config.hostedRuntimeAllowlist);
  const bridgeReady = !bridgeRequired || input.bridgeReadiness?.status === "ready";
  const unownedTotal = countUnownedResources(input.unownedResources);
  const diagnostics = {
    enabled: true,
    dependencyStatus,
    runtime: {
      allowlistCount: input.config.hostedRuntimeAllowlist.length,
      bridgeRequired,
      bridgeReady
    },
    unownedResources: buildUnownedResourceDiagnostics(input.unownedResources),
    bridge: bridgeRequired && input.bridgeReadiness
      ? {
          status: input.bridgeReadiness.status,
          checks: input.bridgeReadiness.checks
        }
      : undefined
  };

  const storesReady = dependencyStatus.debateStore
    && dependencyStatus.messageStore
    && dependencyStatus.evidenceStore
    && dependencyStatus.eventStore
    && dependencyStatus.artifactMetadataStore;
  if (!storesReady) {
    return readinessCheck(false, "hosted_debate_store_unavailable", diagnostics);
  }
  if (!dependencyStatus.debateExecutionOutbox || !dependencyStatus.runQueue) {
    return readinessCheck(false, "hosted_debate_queue_unavailable", diagnostics);
  }
  if (!dependencyStatus.routeAuth) {
    return readinessCheck(false, "auth_required", diagnostics);
  }
  if (!dependencyStatus.ownership) {
    return readinessCheck(false, "hosted_debate_ownership_attach_failed", diagnostics);
  }
  if (!dependencyStatus.quota) {
    return readinessCheck(false, "quota_store_unavailable", diagnostics);
  }
  if (!dependencyStatus.audit) {
    return readinessCheck(false, "hosted_debate_audit_unavailable", diagnostics);
  }
  if (!dependencyStatus.artifactContentStore || !dependencyStatus.objectStore) {
    return readinessCheck(false, input.objectStoreCheck.code ?? "object_store_unavailable", diagnostics);
  }
  if (!dependencyStatus.hostedRuntimeAllowlist) {
    return readinessCheck(false, input.hostedAllowlistCheck.code ?? "hosted_runtime_not_allowed", diagnostics);
  }
  if (!dependencyStatus.providerRuntimeActivation) {
    return readinessCheck(false, providerActivationFailureCode ?? "provider_runtime_policy_missing", diagnostics);
  }
  if (!dependencyStatus.hostedRuntimeGate) {
    return readinessCheck(false, input.hostedRuntimeGateCheck.code ?? "hosted_runtime_not_allowed", diagnostics);
  }
  if (unownedTotal > 0) {
    return readinessCheck(false, "unowned_resources_present", diagnostics);
  }
  if (!bridgeReady) {
    const code = input.bridgeReadiness?.checks.find((check) => !check.ok)?.reasonCode
      ?? "hosted_runtime_bridge_store_unavailable";
    return readinessCheck(false, code, diagnostics);
  }

  return readinessCheck(true, undefined, diagnostics);
}

function dependencyAvailable(
  input: HostedDebateReadinessInput | undefined,
  key: keyof HostedDebateReadinessInput,
  inferred: boolean
): boolean {
  if (!input || !Object.prototype.hasOwnProperty.call(input, key)) {
    return inferred;
  }
  return isPresent(input[key]);
}

function requiresRuntimeBridge(allowlist: readonly string[]): boolean {
  return allowlist.includes("claude_code.sdk")
    || allowlist.includes("opencode.acp")
    || hasWrapperRuntimeAllowlist(allowlist);
}

function hasWrapperRuntimeAllowlist(allowlist: readonly string[]): boolean {
  return allowlist.includes("agentfield.async_rest") || allowlist.includes("generic_http.async_rest");
}

function wrapperReasonCode(value: unknown, kind: "config" | "capability"): string | undefined {
  if (!isPresent(value)) {
    return kind === "config" ? "agentfield_bridge_config_missing" : "agentfield_bridge_capability_missing";
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? undefined : kind === "config" ? "agentfield_bridge_config_missing" : "agentfield_bridge_capability_missing";
  }

  const record = asRecord(value);
  if (record["ok"] === false && typeof record["reasonCode"] === "string") {
    return record["reasonCode"];
  }
  if (record["ready"] === false && typeof record["reasonCode"] === "string") {
    return record["reasonCode"];
  }
  return undefined;
}

function hostedDebateProviderActivationFailureCode(
  config: ServerConfig,
  providerRuntimeActivation: ProviderRuntimeActivationResult,
  providerRuntimeActivationCheck: ReadinessReport["checks"][string]
): string | undefined {
  if (!hasRealHostedRuntimeAllowlist(config.hostedRuntimeAllowlist)) {
    return undefined;
  }
  if (!providerRuntimeActivationCheck.ok) {
    return providerRuntimeActivationCheck.code ?? "provider_runtime_policy_missing";
  }
  if (
    (config.deploymentMode === "staging" || config.deploymentMode === "production") &&
    !providerRuntimeActivation.valid
  ) {
    return providerRuntimeActivation.reasons[0]?.code ?? "provider_runtime_policy_missing";
  }
  return undefined;
}

function hasRealHostedRuntimeAllowlist(allowlist: readonly string[]): boolean {
  return allowlist.some((mode) => mode !== "fake.deterministic");
}

function countUnownedResources(unowned: UnownedResourceCounts | undefined): number {
  if (!unowned) {
    return 0;
  }
  return unowned.runs
    + unowned.runEvents
    + unowned.artifacts
    + unowned.toolInvocations
    + unowned.approvals
    + unowned.placements
    + unowned.nodes
    + unowned.assignments
    + unowned.auditEvents
    + unowned.quotaReservations
    + unowned.debates
    + unowned.debateExecutionJobs
    + unowned.messages
    + unowned.evidence
    + unowned.childRuns
    + unowned.debateArtifacts
    + unowned.debateEvents;
}

function buildUnownedResourceDiagnostics(unowned: UnownedResourceCounts | undefined): Record<string, unknown> {
  return {
    runs: unowned?.runs ?? 0,
    runEvents: unowned?.runEvents ?? 0,
    artifacts: unowned?.artifacts ?? 0,
    toolInvocations: unowned?.toolInvocations ?? 0,
    approvals: unowned?.approvals ?? 0,
    placements: unowned?.placements ?? 0,
    nodes: unowned?.nodes ?? 0,
    assignments: unowned?.assignments ?? 0,
    auditEvents: unowned?.auditEvents ?? 0,
    quotaReservations: unowned?.quotaReservations ?? 0,
    debates: unowned?.debates ?? 0,
    debateExecutionJobs: unowned?.debateExecutionJobs ?? 0,
    messages: unowned?.messages ?? 0,
    evidence: unowned?.evidence ?? 0,
    childRuns: unowned?.childRuns ?? 0,
    debateArtifacts: unowned?.debateArtifacts ?? 0,
    debateEvents: unowned?.debateEvents ?? 0
  };
}

function buildSandboxDiagnostics(config: ServerConfig): Record<string, unknown> {
  return {
    enabled: config.sandbox.enabled,
    valid: config.sandbox.valid,
    mode: config.sandbox.realExecution.mode,
    policyCount: config.sandbox.realExecution.commandPolicy.length,
    ptyDriverConfigured: config.sandbox.realExecution.ptyDriverConfigured,
    errors: [...config.sandbox.errors]
  };
}

function normalizeProviderRuntimeActivation(config: ServerConfig): ProviderRuntimeActivationResult {
  if (config.providerRuntimeActivation) {
    return config.providerRuntimeActivation;
  }

  return {
    valid: true,
    enabledRealModes: [],
    reasons: [],
    redactedSummary: {
      deploymentMode: config.deploymentMode,
      hostedRealRuntimeExecution: config.hostedRealRuntimeExecution,
      realModeCount: 0,
      enabledRealModeCount: 0,
      source: { kind: "none" },
      modeStatuses: [],
      reasonCodes: []
    }
  };
}

function hasToolQueueSupport(queue: RunQueuePort & Partial<Record<string, unknown>>): boolean {
  return typeof (queue as { enqueueTool?: unknown }).enqueueTool === "function"
    && typeof (queue as { claimTool?: unknown }).claimTool === "function"
    && typeof (queue as { ackTool?: unknown }).ackTool === "function"
    && typeof (queue as { failTool?: unknown }).failTool === "function"
    && typeof (queue as { recoverStaleToolClaims?: unknown }).recoverStaleToolClaims === "function";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function workerFlag(worker: Record<string, unknown>, key: "claim" | "adapterCapability" | "sessionReconciliation" | "approvalSender"): boolean {
  return worker[key] === true;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}
