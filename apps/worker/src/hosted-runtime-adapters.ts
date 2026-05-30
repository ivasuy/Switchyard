import {
  ClaudeCodeAdapter,
  CodexExecJsonAdapter,
  OpenCodeAcpAdapter,
  createClaudeCodeCliClient,
  type ClaudeCodeClient,
  type ClaudeCodeCliProcessFactory,
  type CodexProcessFactory,
  type OpenCodeAcpAdapterOptions
} from "@switchyard/adapters";
import {
  HOSTED_RUNTIME_CATALOG,
  isKnownHostedRuntimeMode,
  isRealHostedRuntimeMode,
  type HostedRuntimeModeSlug,
  type RuntimeAdapter,
  type RuntimeLogger
} from "@switchyard/core";
import { FakeRuntimeAdapter } from "@switchyard/testkit";
import type { WorkerConfig } from "./config.js";

export interface HostedWorkerAdapterFactoryDeps {
  codexProcessFactory?: CodexProcessFactory;
  claudeClient?: ClaudeCodeClient;
  claudeProcessFactory?: ClaudeCodeCliProcessFactory;
  opencodeProcessFactory?: OpenCodeAcpAdapterOptions["processFactory"];
  logger?: RuntimeLogger;
}

export function buildHostedWorkerAdapters(
  config: WorkerConfig,
  deps: HostedWorkerAdapterFactoryDeps = {}
): Map<string, RuntimeAdapter> {
  const adapters = new Map<string, RuntimeAdapter>();
  adapters.set("fake", new FakeRuntimeAdapter());

  const safeLogger = createHostedSafeLogger(deps.logger);

  if (shouldEnableRealMode(config, "codex.exec_json")) {
    adapters.set("codex", new CodexExecJsonAdapter({
      ...(deps.codexProcessFactory ? { processFactory: deps.codexProcessFactory } : {}),
      logger: safeLogger
    }));
  }

  if (shouldEnableRealMode(config, "claude_code.sdk")) {
    const client = deps.claudeClient ?? createClaudeCodeCliClient({
      command: config.claudeCode.command,
      ...(deps.claudeProcessFactory ? { processFactory: deps.claudeProcessFactory } : {}),
      permissionMode: "read_only",
      disabledTools: ["Bash", "WebFetch", "WebSearch"]
    });
    adapters.set("claude_code", new ClaudeCodeAdapter({
      client,
      command: config.claudeCode.command,
      requestTimeoutMs: config.claudeCode.requestTimeoutMs,
      liveProbe: config.claudeCode.liveProbe,
      maxBudgetUsd: config.claudeCode.maxBudgetUsd,
      permissionMode: "read_only",
      disabledTools: ["Bash", "WebFetch", "WebSearch"],
      ...(safeLogger ? { logger: safeLogger } : {})
    }));
  }

  if (shouldEnableRealMode(config, "opencode.acp")) {
    adapters.set("opencode", new OpenCodeAcpAdapter({
      command: config.opencode.command,
      requestTimeoutMs: config.acp.requestTimeoutMs,
      cancelTimeoutMs: config.acp.cancelTimeoutMs,
      maxMessageBytes: config.acp.maxMessageBytes,
      ...(deps.opencodeProcessFactory ? { processFactory: deps.opencodeProcessFactory } : {}),
      logger: safeLogger
    }));
  }

  return adapters;
}

export async function checkConfiguredHostedAdapters(
  config: WorkerConfig,
  deps: HostedWorkerAdapterFactoryDeps = {}
): Promise<{ ok: boolean; modes: Record<HostedRuntimeModeSlug, { ok: boolean; code?: string }> }> {
  const adapters = buildHostedWorkerAdapters(config, deps);
  const modes: Record<HostedRuntimeModeSlug, { ok: boolean; code?: string }> = {
    "fake.deterministic": { ok: true },
    "codex.exec_json": statusForMode(config, "codex.exec_json", adapters.has("codex")),
    "claude_code.sdk": statusForMode(config, "claude_code.sdk", adapters.has("claude_code")),
    "opencode.acp": statusForMode(config, "opencode.acp", adapters.has("opencode"))
  };

  for (const [mode, adapterId] of [
    ["codex.exec_json", "codex"],
    ["claude_code.sdk", "claude_code"],
    ["opencode.acp", "opencode"]
  ] as const) {
    if (!modes[mode].ok || modes[mode].code === "not_allowlisted") {
      continue;
    }
    const adapter = adapters.get(adapterId);
    if (!adapter) {
      modes[mode] = { ok: false, code: "hosted_runtime_not_allowed" };
      continue;
    }
    const check = await adapter.check();
    if (!check.ok) {
      const details = check.details as Record<string, unknown> | undefined;
      const availability = details?.["availability"] as Record<string, unknown> | undefined;
      const reasonCode = typeof availability?.["reasonCode"] === "string"
        ? availability["reasonCode"]
        : "adapter_check_failed";
      modes[mode] = { ok: false, code: reasonCode };
    }
  }

  return {
    ok: Object.values(modes).every((entry) => entry.ok),
    modes
  };
}

export function createHostedSafeLogger(logger?: RuntimeLogger): RuntimeLogger | undefined {
  if (!logger) {
    return undefined;
  }

  const unsafeExactKeys = new Set([
    "stdout",
    "stderr",
    "text",
    "output",
    "provideroutput",
    "task",
    "cwd",
    "argv",
    "args",
    "command",
    "commandargs",
    "env",
    "token",
    "tokens",
    "apikey",
    "authorization",
    "password",
    "secret",
    "signedurl",
    "objectkey",
    "home",
    "path"
  ]);

  const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

  const isUnsafeDetailKey = (key: string): boolean => {
    const normalized = normalizeKey(key);
    if (unsafeExactKeys.has(normalized)) {
      return true;
    }
    if (normalized.includes("token")
      || normalized.includes("secret")
      || normalized.includes("password")
      || normalized.includes("apikey")
      || normalized.includes("authorization")) {
      return true;
    }
    if (normalized.includes("stdout")
      || normalized.includes("stderr")
      || normalized.includes("text")
      || normalized.includes("provideroutput")) {
      return true;
    }
    if (normalized.includes("signed") && normalized.includes("url")) {
      return true;
    }
    if (normalized.includes("object") && normalized.includes("key")) {
      return true;
    }
    if (normalized.includes("command")
      && (normalized.includes("arg") || normalized.includes("argv"))) {
      return true;
    }
    return false;
  };

  const sanitizeValue = (value: unknown, seen: WeakSet<object>): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => sanitizeValue(entry, seen));
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) {
        return "[redacted]";
      }
      seen.add(value);
      const nested: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (isUnsafeDetailKey(key)) {
          nested[key] = "[redacted]";
          continue;
        }
        nested[key] = sanitizeValue(nestedValue, seen);
      }
      return nested;
    }
    return value;
  };

  const sanitize = (details?: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (!details) {
      return undefined;
    }
    const safe: Record<string, unknown> = {};
    const seen = new WeakSet<object>();
    for (const [key, value] of Object.entries(details)) {
      if (isUnsafeDetailKey(key)) {
        safe[key] = "[redacted]";
        continue;
      }
      safe[key] = sanitizeValue(value, seen);
    }
    return safe;
  };

  return {
    info(event, details) {
      logger.info(event, sanitize(details));
    },
    warn(event, details) {
      logger.warn(event, sanitize(details));
    },
    error(event, details) {
      logger.error(event, sanitize(details));
    }
  };
}

function shouldEnableRealMode(config: WorkerConfig, mode: HostedRuntimeModeSlug): boolean {
  if (!isRealHostedRuntimeMode(mode)) {
    return true;
  }
  if (config.deploymentMode === "production") {
    return false;
  }
  if (config.hostedRealRuntimeExecution !== "enabled") {
    return false;
  }
  return config.hostedRuntimeAllowlist.includes(mode);
}

function statusForMode(
  config: WorkerConfig,
  mode: HostedRuntimeModeSlug,
  isConstructed: boolean
): { ok: boolean; code?: string } {
  if (!isRealHostedRuntimeMode(mode)) {
    return { ok: true };
  }
  const allowlisted = config.hostedRuntimeAllowlist.includes(mode);
  if (!allowlisted) {
    return { ok: true, code: "not_allowlisted" };
  }
  if (config.deploymentMode === "production") {
    return { ok: false, code: "hosted_real_runtime_production_forbidden" };
  }
  if (config.hostedRealRuntimeExecution !== "enabled") {
    return { ok: false, code: "hosted_real_runtime_disabled" };
  }
  return isConstructed ? { ok: true } : { ok: false, code: "adapter_not_constructed" };
}

export function hostedRuntimeModesFromAllowlist(allowlist: string[]): HostedRuntimeModeSlug[] {
  return allowlist.filter((mode): mode is HostedRuntimeModeSlug => isKnownHostedRuntimeMode(mode));
}

export function hostedRuntimeCatalog(): typeof HOSTED_RUNTIME_CATALOG {
  return HOSTED_RUNTIME_CATALOG;
}
