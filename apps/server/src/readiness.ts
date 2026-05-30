import { access, constants } from "node:fs/promises";
import type { RunQueuePort } from "@switchyard/core";
import { probePostgresDatabase, type PostgresDatabaseHandle } from "@switchyard/storage";
import type { ServerConfig } from "./config.js";

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, { ok: boolean; code?: string }>;
}

export async function probeServerReadiness(input: {
  config: ServerConfig;
  postgres: PostgresDatabaseHandle | undefined;
  queue: RunQueuePort;
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

  if (input.config.objectStoreDir) {
    try {
      await access(input.config.objectStoreDir, constants.R_OK | constants.W_OK);
      checks.objectStore = { ok: true };
    } catch {
      checks.objectStore = { ok: false, code: "object_store_unavailable" };
    }
  } else {
    checks.objectStore = { ok: input.config.deploymentMode === "local" || input.config.deploymentMode === "test", code: "object_store_not_configured" };
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
