import {
  ClaudeCodeAdapter,
  CodexExecJsonAdapter,
  OpenCodeAcpAdapter,
  createClaudeCodeCliClient,
  type ClaudeCodeAdapterOptions,
  type ClaudeCodeCliClientOptions,
  type ClaudeCodeClient,
  type ClaudeCodeCliProcessFactory,
  type CodexExecJsonAdapterOptions,
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
import {
  buildProviderResolvedCommand,
  type BuildProviderResolvedCommandInput
} from "../../../packages/core/dist/services/provider-runtime-policy.js";

export interface HostedWorkerAdapterFactoryDeps {
  codexProcessFactory?: CodexProcessFactory;
  claudeClient?: ClaudeCodeClient;
  claudeProcessFactory?: ClaudeCodeCliProcessFactory;
  opencodeProcessFactory?: OpenCodeAcpAdapterOptions["processFactory"];
  hostedBridgeEnabledModes?: ReadonlySet<HostedRuntimeModeSlug>;
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
    const hostedProviderCommand = config.deploymentMode === "production"
      ? resolveHostedProviderCommand(config, "codex.exec_json", { sandbox: "read-only" })
      : undefined;
    if (config.deploymentMode !== "production" || hostedProviderCommand) {
      const options: CodexExecJsonAdapterOptions = {
        ...(deps.codexProcessFactory ? { processFactory: deps.codexProcessFactory } : {}),
        logger: safeLogger,
        ...(hostedProviderCommand ? { hostedProviderCommand } : {})
      };
      adapters.set("codex", new CodexExecJsonAdapter(options));
    }
  }

  if (shouldEnableRealMode(config, "claude_code.sdk")) {
    const hostedProviderCommand = config.deploymentMode === "production"
      ? resolveHostedProviderCommand(config, "claude_code.sdk")
      : undefined;
    if (config.deploymentMode !== "production" || hostedProviderCommand) {
      const clientOptions: ClaudeCodeCliClientOptions = {
        command: config.claudeCode.command,
        ...(deps.claudeProcessFactory ? { processFactory: deps.claudeProcessFactory } : {}),
        permissionMode: "read_only",
        disabledTools: ["Bash", "WebFetch", "WebSearch"],
        ...(hostedProviderCommand ? { hostedProviderCommand } : {})
      };
      const client = deps.claudeClient ?? createClaudeCodeCliClient(clientOptions);
      const adapterOptions: ClaudeCodeAdapterOptions = {
        client,
        command: config.claudeCode.command,
        requestTimeoutMs: config.claudeCode.requestTimeoutMs,
        liveProbe: config.claudeCode.liveProbe,
        maxBudgetUsd: config.claudeCode.maxBudgetUsd,
        permissionMode: "read_only",
        disabledTools: ["Bash", "WebFetch", "WebSearch"],
        hostedBridgeEnabled: deps.hostedBridgeEnabledModes?.has("claude_code.sdk") ?? false,
        ...(hostedProviderCommand ? { hostedProviderCommand } : {}),
        ...(safeLogger ? { logger: safeLogger } : {})
      };
      adapters.set("claude_code", new ClaudeCodeAdapter(adapterOptions));
    }
  }

  if (shouldEnableRealMode(config, "opencode.acp")) {
    const hostedProviderCommand = config.deploymentMode === "production"
      ? resolveHostedProviderCommand(config, "opencode.acp")
      : undefined;
    if (config.deploymentMode !== "production" || hostedProviderCommand) {
      const options: OpenCodeAcpAdapterOptions = {
        command: config.opencode.command,
        requestTimeoutMs: config.acp.requestTimeoutMs,
        cancelTimeoutMs: config.acp.cancelTimeoutMs,
        maxMessageBytes: config.acp.maxMessageBytes,
        hostedBridgeEnabled: deps.hostedBridgeEnabledModes?.has("opencode.acp") ?? false,
        ...(deps.opencodeProcessFactory ? { processFactory: deps.opencodeProcessFactory } : {}),
        logger: safeLogger,
        ...(hostedProviderCommand ? { hostedProviderCommand } : {})
      };
      adapters.set("opencode", new OpenCodeAcpAdapter(options));
    }
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
    return config.providerRuntimeActivation.valid
      && config.providerRuntimeActivation.enabledRealModes.includes(mode as "codex.exec_json" | "claude_code.sdk" | "opencode.acp");
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
  if (config.deploymentMode === "production" && !config.providerRuntimeActivation.valid) {
    return {
      ok: false,
      code: config.providerRuntimeActivation.reasons[0]?.code ?? "provider_runtime_policy_missing"
    };
  }
  if (config.deploymentMode === "production" && !config.providerRuntimeActivation.enabledRealModes.includes(mode as "codex.exec_json" | "claude_code.sdk" | "opencode.acp")) {
    return { ok: false, code: "provider_runtime_policy_disabled" };
  }
  if (config.hostedRealRuntimeExecution !== "enabled") {
    return { ok: false, code: "hosted_real_runtime_disabled" };
  }
  return isConstructed ? { ok: true } : { ok: false, code: "adapter_not_constructed" };
}

function resolveHostedProviderCommand(
  config: WorkerConfig,
  runtimeMode: Extract<HostedRuntimeModeSlug, "codex.exec_json" | "claude_code.sdk" | "opencode.acp">,
  metadata: Record<string, unknown> = {}
) {
  const activation = config.providerRuntimeActivation;
  if (!activation.valid || !activation.policy) {
    return undefined;
  }
  const policyEntry = activation.policy.modes[runtimeMode as "codex.exec_json" | "claude_code.sdk" | "opencode.acp"];
  if (!policyEntry || policyEntry.cwdPrefixes.length === 0) {
    return undefined;
  }
  const commandInput: BuildProviderResolvedCommandInput = {
    activation,
    runtimeMode,
    cwd: policyEntry.cwdPrefixes[0]!,
    env: process.env,
    metadata
  };
  const resolved = buildProviderResolvedCommand(commandInput);
  if (!resolved.ok) {
    return undefined;
  }
  return resolved.command;
}

export function hostedRuntimeModesFromAllowlist(allowlist: string[]): HostedRuntimeModeSlug[] {
  return allowlist.filter((mode): mode is HostedRuntimeModeSlug => isKnownHostedRuntimeMode(mode));
}

export function hostedRuntimeCatalog(): typeof HOSTED_RUNTIME_CATALOG {
  return HOSTED_RUNTIME_CATALOG;
}
