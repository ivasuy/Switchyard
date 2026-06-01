import { accessSync, constants, readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import {
  createDisabledRealToolPolicyConfig,
  redactSecrets,
  resolveRealToolPolicyConfig,
  resolveHostedSandboxConfig,
  validateProductionSecret,
  validateProductionUrlCredential,
  validateHostedRuntimeAllowlist,
  type HostedRealRuntimeExecution,
  type ResolvedHostedSandboxConfig,
  type ResolvedRealToolPolicyConfig
} from "@switchyard/core";
import {
  ObjectStoreConfigError,
  resolveObjectStoreConfig,
  type ResolvedObjectStoreConfig
} from "@switchyard/storage";
import {
  resolveProviderRuntimePolicy,
  type ProviderRuntimePolicyPathPayload,
  type ProviderRuntimeActivationResult
} from "../../../packages/core/dist/services/provider-runtime-policy.js";

export type DeploymentMode = "local" | "test" | "staging" | "production";
const PROVIDER_POLICY_MAX_BYTES = 65_536;
const REAL_TOOL_POLICY_MAX_BYTES = 65_536;

export type HostedRealToolsMode = "disabled" | "enabled";
export type ToolAdapterMode = "fake" | "real";

export interface WorkerToolConfig {
  hostedRealTools: HostedRealToolsMode;
  connectedNodeRealTools: HostedRealToolsMode;
  adapterMode: ToolAdapterMode;
  allowNoApprovalInTest: boolean;
  policySourceKind: "none" | "json" | "path";
  policy: ResolvedRealToolPolicyConfig;
}

export class ConfigError extends Error {
  constructor(readonly code: string, readonly variable: string, readonly redactedConfig: Record<string, unknown>) {
    super(code);
  }
}

export interface WorkerConfig {
  deploymentMode: DeploymentMode;
  hostedRuntimeAllowlist: string[];
  hostedRealRuntimeExecution: HostedRealRuntimeExecution;
  postgresUrl?: string;
  redisUrl?: string;
  queueName?: string;
  objectStore: ResolvedObjectStoreConfig;
  sandbox: ResolvedHostedSandboxConfig;
  idleIntervalMs: number;
  claudeCode: {
    command: string;
    requestTimeoutMs: number;
    liveProbe: boolean;
    maxBudgetUsd: number;
  };
  opencode: {
    command: string;
  };
  acp: {
    requestTimeoutMs: number;
    cancelTimeoutMs: number;
    maxMessageBytes: number;
  };
  providerRuntimeActivation: ProviderRuntimeActivationResult;
  tools: WorkerToolConfig;
  redactedSummary: Record<string, unknown>;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const deploymentMode = parseDeploymentMode(env["SWITCHYARD_DEPLOYMENT_MODE"]);
  const hostedRuntimeAllowlistEnv = optional(env["SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"]);
  const hostedRealRuntimeExecution = parseHostedRealRuntimeExecution(env["SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"]);
  const providerPolicyJson = optional(env["SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON"]);
  const providerPolicyPath = optional(env["SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH"]);
  const hostedRealTools = parseToolsMode(optional(env["SWITCHYARD_HOSTED_REAL_TOOLS"]));
  const connectedNodeRealTools = parseToolsMode(optional(env["SWITCHYARD_CONNECTED_NODE_REAL_TOOLS"]));
  const toolAdapterMode = parseToolAdapterMode(optional(env["SWITCHYARD_TOOL_ADAPTER_MODE"]));
  const toolPolicyJson = optional(env["SWITCHYARD_REAL_TOOL_POLICY_JSON"]);
  const toolPolicyPath = optional(env["SWITCHYARD_REAL_TOOL_POLICY_PATH"]);
  const config: WorkerConfig = {
    deploymentMode,
    hostedRuntimeAllowlist: parseCsv(hostedRuntimeAllowlistEnv, "fake.deterministic"),
    hostedRealRuntimeExecution,
    queueName: optional(env["SWITCHYARD_QUEUE_NAME"]) ?? "switchyard-hosted-runs",
    idleIntervalMs: Number(optional(env["SWITCHYARD_WORKER_IDLE_MS"]) ?? "200"),
    objectStore: {} as ResolvedObjectStoreConfig,
    sandbox: resolveHostedSandboxConfig({ env, deploymentMode }),
    claudeCode: {
      command: optional(env["SWITCHYARD_CLAUDE_CODE_COMMAND"]) ?? "claude",
      requestTimeoutMs: parsePositiveInteger(optional(env["SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS"]) ?? "5000", "SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS"),
      liveProbe: parseBoolean(optional(env["SWITCHYARD_CLAUDE_CODE_LIVE_PROBE"])) ?? false,
      maxBudgetUsd: parsePositiveNumber(optional(env["SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD"]) ?? "0.05", "SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD")
    },
    opencode: {
      command: optional(env["SWITCHYARD_OPENCODE_COMMAND"]) ?? "opencode"
    },
    acp: {
      requestTimeoutMs: parsePositiveInteger(optional(env["SWITCHYARD_ACP_REQUEST_TIMEOUT_MS"]) ?? "5000", "SWITCHYARD_ACP_REQUEST_TIMEOUT_MS"),
      cancelTimeoutMs: parsePositiveInteger(optional(env["SWITCHYARD_ACP_CANCEL_TIMEOUT_MS"]) ?? "5000", "SWITCHYARD_ACP_CANCEL_TIMEOUT_MS"),
      maxMessageBytes: parsePositiveInteger(optional(env["SWITCHYARD_ACP_MAX_MESSAGE_BYTES"]) ?? "1048576", "SWITCHYARD_ACP_MAX_MESSAGE_BYTES")
    },
    providerRuntimeActivation: {
      valid: true,
      enabledRealModes: [],
      reasons: [],
      redactedSummary: {
        deploymentMode,
        hostedRealRuntimeExecution,
        realModeCount: 0,
        enabledRealModeCount: 0,
        source: { kind: "none" },
        modeStatuses: [],
        reasonCodes: []
      }
    },
    tools: {
      hostedRealTools,
      connectedNodeRealTools,
      adapterMode: toolAdapterMode,
      allowNoApprovalInTest: parseBoolean(optional(env["SWITCHYARD_TOOL_ALLOW_WITHOUT_APPROVAL"])) ?? (deploymentMode !== "production"),
      policySourceKind: "none",
      policy: createDisabledRealToolPolicyConfig()
    },
    redactedSummary: {}
  };
  const postgresUrl = optional(env["SWITCHYARD_POSTGRES_URL"]);
  const redisUrl = optional(env["SWITCHYARD_REDIS_URL"]);
  if (postgresUrl) config.postgresUrl = postgresUrl;
  if (redisUrl) config.redisUrl = redisUrl;
  try {
    config.objectStore = resolveObjectStoreConfig({ env, deploymentMode: config.deploymentMode });
  } catch (error) {
    if (error instanceof ObjectStoreConfigError) {
      throw new ConfigError(error.code, error.variable, {
        ...buildSummary(config),
        objectStore: error.redactedConfig["objectStore"] ?? {}
      });
    }
    throw error;
  }

  if (!Number.isFinite(config.idleIntervalMs) || config.idleIntervalMs < 1) {
    throw new ConfigError("config_invalid:SWITCHYARD_WORKER_IDLE_MS", "SWITCHYARD_WORKER_IDLE_MS", buildSummary(config));
  }

  if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
    requireVar(config.postgresUrl, "SWITCHYARD_POSTGRES_URL", config);
    requireVar(config.redisUrl, "SWITCHYARD_REDIS_URL", config);
    requireVar(hostedRuntimeAllowlistEnv, "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST", config);
  }

  if (config.deploymentMode === "production") {
    enforceProductionValidation(validateProductionUrlCredential({
      variable: "SWITCHYARD_POSTGRES_URL",
      value: config.postgresUrl,
      credential: "password"
    }), config);
    enforceProductionValidation(validateProductionUrlCredential({
      variable: "SWITCHYARD_REDIS_URL",
      value: config.redisUrl,
      credential: "password"
    }), config);

    if (config.objectStore.backend === "s3-compatible") {
      enforceProductionValidation(validateProductionSecret({
        variable: "SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID",
        value: optional(env["SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID"])
      }), config);
      enforceProductionValidation(validateProductionSecret({
        variable: "SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY",
        value: optional(env["SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY"])
      }), config);
    }
  }

  const toolPolicyPathPayload = loadRealToolPolicyPathPayload(toolPolicyPath);
  if (toolPolicyJson && toolPolicyPath) {
    throw new ConfigError(
      "config_conflict:SWITCHYARD_REAL_TOOL_POLICY_JSON",
      "SWITCHYARD_REAL_TOOL_POLICY_JSON",
      buildSummary(config)
    );
  }
  if (toolPolicyJson) {
    try {
      config.tools.policy = resolveRealToolPolicyConfig({ source: toolPolicyJson });
      config.tools.policySourceKind = "json";
    } catch {
      throw new ConfigError(
        "tool_policy_config_invalid",
        "SWITCHYARD_REAL_TOOL_POLICY_JSON",
        buildSummary(config)
      );
    }
  } else if (toolPolicyPathPayload?.state === "ok") {
    try {
      config.tools.policy = resolveRealToolPolicyConfig({ source: toolPolicyPathPayload.contents });
      config.tools.policySourceKind = "path";
    } catch {
      throw new ConfigError(
        "tool_policy_config_invalid",
        "SWITCHYARD_REAL_TOOL_POLICY_PATH",
        buildSummary(config)
      );
    }
  } else if (toolPolicyPathPayload) {
    throw new ConfigError(
      "tool_policy_config_invalid",
      "SWITCHYARD_REAL_TOOL_POLICY_PATH",
      buildSummary(config)
    );
  }

  if (config.tools.hostedRealTools === "enabled" || config.tools.connectedNodeRealTools === "enabled") {
    if (config.tools.policySourceKind === "none") {
      throw new ConfigError(
        "config_required:SWITCHYARD_REAL_TOOL_POLICY_JSON",
        "SWITCHYARD_REAL_TOOL_POLICY_JSON",
        buildSummary(config)
      );
    }
    if (config.tools.policy.shell.enabled && Object.keys(config.tools.policy.shell.catalog).length === 0) {
      throw new ConfigError(
        "config_required:SWITCHYARD_SHELL_COMMAND_CATALOG_PATH",
        "SWITCHYARD_SHELL_COMMAND_CATALOG_PATH",
        buildSummary(config)
      );
    }
  }

  const providerPathPayload = loadProviderRuntimePolicyPathPayload(providerPolicyPath);
  const providerPolicy = resolveProviderRuntimePolicy({
    deploymentMode: config.deploymentMode,
    hostedRealRuntimeExecution: config.hostedRealRuntimeExecution,
    hostedRuntimeAllowlist: config.hostedRuntimeAllowlist,
    ...(providerPolicyJson ? { policyJson: providerPolicyJson } : {}),
    ...(providerPathPayload !== undefined ? { policyPathContents: providerPathPayload } : {}),
    env,
    binaryProbe: ({ executablePath }) => isExecutablePathAvailable(executablePath)
  });
  config.providerRuntimeActivation = providerPolicy.activation;

  if (config.deploymentMode === "production" && !providerPolicy.activation.valid) {
    throw new ConfigError(
      providerPolicy.activation.reasons[0]?.code ?? "provider_runtime_policy_missing",
      providerPolicyVariable(providerPolicyJson, providerPolicyPath, providerPolicy.activation.redactedSummary.source.kind),
      buildSummary(config)
    );
  }

  const allowlistValidation = validateHostedRuntimeAllowlist({
    allowlist: config.hostedRuntimeAllowlist,
    deploymentMode: config.deploymentMode,
    realRuntimeExecution: config.hostedRealRuntimeExecution,
    providerActivation: config.providerRuntimeActivation
  });
  if (!allowlistValidation.ok) {
    const variable = allowlistValidation.code.includes("REAL_RUNTIME_EXECUTION")
      ? "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"
      : "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST";
    throw new ConfigError(allowlistValidation.code, variable, buildSummary(config));
  }

  if (!config.sandbox.valid) {
    throw new ConfigError(firstSandboxConfigError(config.sandbox.errors), "SWITCHYARD_SANDBOX_*", buildSummary(config));
  }
  config.redactedSummary = buildSummary(config);
  return config;
}

function parseDeploymentMode(value: string | undefined): DeploymentMode {
  const normalized = optional(value) ?? "local";
  if (normalized === "local" || normalized === "test" || normalized === "staging" || normalized === "production") {
    return normalized;
  }
  throw new ConfigError("config_invalid:SWITCHYARD_DEPLOYMENT_MODE", "SWITCHYARD_DEPLOYMENT_MODE", { deploymentMode: normalized });
}

function parseHostedRealRuntimeExecution(value: string | undefined): HostedRealRuntimeExecution {
  const normalized = optional(value);
  if (!normalized || normalized === "disabled") {
    return "disabled";
  }
  if (normalized === "enabled") {
    return "enabled";
  }
  throw new ConfigError(
    "config_invalid:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
    "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
    { hostedRealRuntimeExecution: normalized }
  );
}

function parseToolsMode(value: string | undefined): HostedRealToolsMode {
  if (!value || value === "disabled") {
    return "disabled";
  }
  if (value === "enabled") {
    return "enabled";
  }
  throw new ConfigError(
    "config_invalid:SWITCHYARD_HOSTED_REAL_TOOLS",
    "SWITCHYARD_HOSTED_REAL_TOOLS",
    { hostedRealTools: value }
  );
}

function parseToolAdapterMode(value: string | undefined): ToolAdapterMode {
  if (!value || value === "fake") {
    return "fake";
  }
  if (value === "real") {
    return "real";
  }
  throw new ConfigError(
    "config_invalid:SWITCHYARD_TOOL_ADAPTER_MODE",
    "SWITCHYARD_TOOL_ADAPTER_MODE",
    { toolAdapterMode: value }
  );
}

function parseCsv(value: string | undefined, fallback: string): string[] {
  const source = optional(value) ?? fallback;
  return source.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  throw new ConfigError("config_invalid:SWITCHYARD_CLAUDE_CODE_LIVE_PROBE", "SWITCHYARD_CLAUDE_CODE_LIVE_PROBE", {
    claudeCodeLiveProbe: value
  });
}

function parsePositiveInteger(value: string, variable: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`config_invalid:${variable}`, variable, { [variable]: value });
  }
  return parsed;
}

function parsePositiveNumber(value: string, variable: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`config_invalid:${variable}`, variable, { [variable]: value });
  }
  return parsed;
}

function loadProviderRuntimePolicyPathPayload(pathValue: string | undefined): string | ProviderRuntimePolicyPathPayload | undefined {
  if (!pathValue) {
    return undefined;
  }
  let raw: Buffer;
  try {
    raw = readFileSync(pathValue);
  } catch {
    return { state: "unreadable" };
  }
  if (raw.length === 0) {
    return { state: "empty" };
  }
  if (raw.length > PROVIDER_POLICY_MAX_BYTES) {
    return { state: "too_large" };
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { state: "invalid_utf8" };
  }
  if (!decoded.trim()) {
    return { state: "empty" };
  }
  try {
    JSON.parse(decoded);
  } catch {
    return { state: "invalid_json" };
  }
  return { state: "ok", contents: decoded };
}

function loadRealToolPolicyPathPayload(pathValue: string | undefined): { state: "ok"; contents: string } | { state: "unreadable" | "empty" | "too_large" | "invalid_utf8" | "invalid_json" } | undefined {
  if (!pathValue) {
    return undefined;
  }
  let raw: Buffer;
  try {
    raw = readFileSync(pathValue);
  } catch {
    return { state: "unreadable" };
  }
  if (raw.length === 0) {
    return { state: "empty" };
  }
  if (raw.length > REAL_TOOL_POLICY_MAX_BYTES) {
    return { state: "too_large" };
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { state: "invalid_utf8" };
  }
  if (!decoded.trim()) {
    return { state: "empty" };
  }
  try {
    JSON.parse(decoded);
  } catch {
    return { state: "invalid_json" };
  }
  return { state: "ok", contents: decoded };
}

function isExecutablePathAvailable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function providerPolicyVariable(
  policyJson: string | undefined,
  policyPath: string | undefined,
  sourceKind: "none" | "json" | "path"
): string {
  if (policyJson && policyPath) {
    return "SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON";
  }
  if (sourceKind === "json") {
    return "SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON";
  }
  if (sourceKind === "path") {
    return "SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH";
  }
  return "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST";
}

function enforceProductionValidation(
  validation: { ok: true } | { ok: false; code: string; variable: string },
  config: WorkerConfig
): void {
  if (validation.ok) {
    return;
  }
  throw new ConfigError(validation.code, validation.variable, buildSummary(config));
}

function requireVar(value: string | undefined, variable: string, config: WorkerConfig): void {
  if (!value) {
    throw new ConfigError(`config_required:${variable}`, variable, buildSummary(config));
  }
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function firstSandboxConfigError(errors: string[]): string {
  for (const code of errors) {
    if (code.startsWith("sandbox_")) {
      return code;
    }
  }
  return "sandbox_config_invalid";
}

function buildSummary(config: WorkerConfig): Record<string, unknown> {
  return redactSecrets({
    deploymentMode: config.deploymentMode,
    queueName: config.queueName,
    hostedRuntimeAllowlist: config.hostedRuntimeAllowlist,
    hostedRealRuntimeExecution: config.hostedRealRuntimeExecution,
    hasPostgresUrl: Boolean(config.postgresUrl),
    hasRedisUrl: Boolean(config.redisUrl),
    objectStore: config.objectStore?.redactedSummary ?? {},
    sandbox: config.sandbox?.redactedSummary ?? {},
    idleIntervalMs: config.idleIntervalMs,
    claudeCode: {
      command: config.claudeCode.command,
      requestTimeoutMs: config.claudeCode.requestTimeoutMs,
      liveProbe: config.claudeCode.liveProbe,
      maxBudgetUsd: config.claudeCode.maxBudgetUsd
    },
    opencode: {
      command: config.opencode.command
    },
    acp: {
      requestTimeoutMs: config.acp.requestTimeoutMs,
      cancelTimeoutMs: config.acp.cancelTimeoutMs,
      maxMessageBytes: config.acp.maxMessageBytes
    },
    providerRuntimePolicy: {
      valid: config.providerRuntimeActivation.valid,
      source: config.providerRuntimeActivation.redactedSummary.source.kind,
      enabledRealModeCount: config.providerRuntimeActivation.redactedSummary.enabledRealModeCount,
      reasonCodes: config.providerRuntimeActivation.redactedSummary.reasonCodes
    },
    tools: {
      hostedRealTools: config.tools.hostedRealTools,
      connectedNodeRealTools: config.tools.connectedNodeRealTools,
      adapterMode: config.tools.adapterMode,
      allowNoApprovalInTest: config.tools.allowNoApprovalInTest,
      policySourceKind: config.tools.policySourceKind,
      policy: {
        globalEnabled: config.tools.policy.global.enabled,
        allowedPlacements: config.tools.policy.global.allowedPlacements,
        hostedEnabled: config.tools.policy.hosted.enabled,
        connectedLocalNodeEnabled: config.tools.policy.connectedLocalNode.enabled,
        enabledToolTypes: [
          ...(config.tools.policy.fetch.enabled ? ["fetch"] : []),
          ...(config.tools.policy.webSearch.enabled ? ["web_search"] : []),
          ...(config.tools.policy.github.enabled ? ["github"] : []),
          ...(config.tools.policy.repo.enabled ? ["repo"] : []),
          ...(config.tools.policy.shell.enabled ? ["shell"] : [])
        ]
      }
    }
  });
}
