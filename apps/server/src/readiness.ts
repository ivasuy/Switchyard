import { access, constants } from "node:fs/promises";
import type { RunQueuePort } from "@switchyard/core";
import type { ProbeableArtifactContentStore } from "@switchyard/storage";
import { probePostgresDatabase, type PostgresDatabaseHandle } from "@switchyard/storage";
import type { ServerConfig } from "./config.js";

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, { ok: boolean; code?: string; diagnostics?: Record<string, unknown> }>;
}

export async function probeServerReadiness(input: {
  config: ServerConfig;
  postgres: PostgresDatabaseHandle | undefined;
  queue: RunQueuePort;
  artifactContent: ProbeableArtifactContentStore;
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
        diagnostics: {
          backend: input.config.objectStore.backend,
          summary: input.config.objectStore.redactedSummary
        }
      };
    }
  } else if (input.config.objectStore.backend === "s3-compatible") {
    try {
      await input.artifactContent.probe();
      checks.objectStore = { ok: true };
    } catch (error) {
      const code = error instanceof Error ? error.message : "object_store_unavailable";
      checks.objectStore = {
        ok: false,
        code: code.startsWith("object_store_") || code.startsWith("artifact_")
          ? code
          : "object_store_unavailable",
        diagnostics: {
          backend: input.config.objectStore.backend,
          summary: input.config.objectStore.redactedSummary
        }
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
  if (allowlist.length === 0) {
    checks.hostedAllowlist = { ok: false, code: "hosted_runtime_not_allowed" };
  } else if (!allowlist.includes("fake.deterministic")) {
    checks.hostedAllowlist = { ok: false, code: "hosted_runtime_not_allowed" };
  } else {
    checks.hostedAllowlist = { ok: true };
  }

  const ok = Object.values(checks).every((check) => check.ok);
  return { ok, checks };
}
