import { access, constants } from "node:fs/promises";
import {
  checkHostedSandboxReadiness,
  isKnownHostedRuntimeMode,
  redactSecrets,
  validateHostedRuntimeAllowlist,
  type RunQueuePort
} from "@switchyard/core";
import type { ProbeableArtifactContentStore } from "@switchyard/storage";
import { probePostgresDatabase, type PostgresDatabaseHandle } from "@switchyard/storage";
import type { ServerConfig } from "./config.js";

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, { ok: boolean; code?: string; diagnostics?: Record<string, unknown> }>;
}

interface UnownedResourceCounts {
  runs: number;
  runEvents: number;
  artifacts: number;
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
}): Promise<ReadinessReport> {
  const checks: ReadinessReport["checks"] = {};

  if (input.postgres) {
    try {
      await probePostgresDatabase(input.postgres);
      checks.postgres = { ok: true };
    } catch {
      checks.postgres = { ok: false, code: "postgres_unavailable" };
    }
  } else {
    checks.postgres = { ok: input.config.deploymentMode === "local" || input.config.deploymentMode === "test", code: "postgres_not_configured" };
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
    realRuntimeExecution: input.config.hostedRealRuntimeExecution
  });
  if (gateValidation.ok) {
    checks.hostedRuntimeGate = { ok: true };
  } else {
    checks.hostedRuntimeGate = { ok: false, code: gateValidation.code };
  }

  const sandbox = checkHostedSandboxReadiness(input.config.sandbox);
  if (sandbox.ok) {
    checks.sandbox = { ok: true };
  } else {
    const code = sandbox.code ?? "sandbox_config_invalid";
    checks.sandbox = {
      ok: false,
      code,
      diagnostics: redactSecrets({
        summary: input.config.sandbox.redactedSummary
      })
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
              placements: unowned?.placements ?? 0,
              nodes: unowned?.nodes ?? 0,
              assignments: unowned?.assignments ?? 0,
              auditEvents: unowned?.auditEvents ?? 0,
              quotaReservations: unowned?.quotaReservations ?? 0
            })
      )
    : readinessCheck(true);

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
