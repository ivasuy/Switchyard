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

export async function probeServerReadiness(input: {
  config: ServerConfig;
  postgres: PostgresDatabaseHandle | undefined;
  queue: RunQueuePort;
  artifactContent: ProbeableArtifactContentStore;
  controlPlane?: ControlPlaneReadinessInput;
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
  const unownedVisibleTotal = unowned
    ? unowned.runs +
      unowned.runEvents +
      unowned.artifacts +
      unowned.toolInvocations +
      unowned.approvals +
      unowned.placements +
      unowned.nodes +
      unowned.assignments +
      unowned.auditEvents +
      unowned.quotaReservations
    : 0;
  checks.unownedResources = strictControlPlane
    ? readinessCheck(
        unownedVisibleTotal === 0,
        "unowned_resources_present",
        unownedVisibleTotal === 0
          ? undefined
          : redactSecrets({
              runs: unowned?.runs ?? 0,
              runEvents: unowned?.runEvents ?? 0,
              artifacts: unowned?.artifacts ?? 0,
              toolInvocations: unowned?.toolInvocations ?? 0,
              approvals: unowned?.approvals ?? 0,
              placements: unowned?.placements ?? 0,
              nodes: unowned?.nodes ?? 0,
              assignments: unowned?.assignments ?? 0,
              auditEvents: unowned?.auditEvents ?? 0,
              quotaReservations: unowned?.quotaReservations ?? 0
            })
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

  const ok = Object.values(checks).every((check) => check.ok);
  return { ok, checks };
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
