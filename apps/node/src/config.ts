import type { NodePolicy } from "@switchyard/contracts";
import {
  redactSecrets,
  validateProductionCwdPrefixes,
  validateProductionFakeOnlyAllowlist,
  validateProductionHttpsUrl,
  validateProductionSecret
} from "@switchyard/core";
import type { ShellCatalogCommandConfig } from "../../../packages/adapters/dist/index.js";

export type DeploymentMode = "local" | "test" | "staging" | "production";

export class ConfigError extends Error {
  constructor(readonly code: string, readonly variable: string, readonly redactedConfig: Record<string, unknown>) {
    super(code);
  }
}

export interface NodeAppConfig {
  deploymentMode: DeploymentMode;
  serverUrl: string;
  sharedToken?: string;
  nodeId?: string;
  capabilities: string[];
  policy: NodePolicy;
  tools: {
    githubToken?: string;
    gitBinary: string;
    shellCatalog: Record<string, ShellCatalogCommandConfig>;
  };
  idleIntervalMs: number;
  redactedSummary: Record<string, unknown>;
}

export function loadNodeConfig(env: NodeJS.ProcessEnv = process.env): NodeAppConfig {
  rejectHostedWorkerOnlyEnv(env);
  const deploymentMode = parseDeploymentMode(env["SWITCHYARD_DEPLOYMENT_MODE"]);
  const capabilitiesEnv = optional(env["SWITCHYARD_NODE_CAPABILITIES"]);
  const allowRuntimeModesEnv = optional(env["SWITCHYARD_NODE_ALLOW_RUNTIME_MODES"]);
  const allowCwdPrefixesEnv = optional(env["SWITCHYARD_NODE_ALLOW_CWD_PREFIXES"]);
  const allowToolTypesEnv = optional(env["SWITCHYARD_NODE_ALLOW_TOOL_TYPES"]);
  const allowToolCwdPrefixesEnv = optional(env["SWITCHYARD_NODE_ALLOW_TOOL_CWD_PREFIXES"]);
  const toolArtifactSyncEnv = optional(env["SWITCHYARD_NODE_TOOL_ARTIFACT_SYNC"]);
  const maxToolArtifactBytesEnv = optional(env["SWITCHYARD_NODE_MAX_TOOL_ARTIFACT_BYTES"]);
  const toolApprovalRequiredEnv = optional(env["SWITCHYARD_NODE_TOOL_APPROVAL_REQUIRED"]);
  const shellCatalogJson = optional(env["SWITCHYARD_NODE_SHELL_CATALOG_JSON"]);
  const rawAllowCwdPrefixes = (allowCwdPrefixesEnv ?? "/repo").split(",").map((value) => value.trim());
  const nodeGithubToken = optional(env["SWITCHYARD_NODE_GITHUB_TOKEN"]);
  const config: NodeAppConfig = {
    deploymentMode,
    serverUrl: env["SWITCHYARD_SERVER_URL"] ?? "http://127.0.0.1:4646",
    capabilities: (capabilitiesEnv ?? "runtime.fake.deterministic").split(",").map((value) => value.trim()).filter(Boolean),
    policy: {
      allowRuntimeModes: (allowRuntimeModesEnv ?? "fake.deterministic").split(",").map((value) => value.trim()).filter(Boolean),
      denyAdapterTypes: [],
      allowCwdPrefixes: rawAllowCwdPrefixes.filter(Boolean),
      allowEventTypes: [],
      artifactSync: "full",
      allowToolTypes: parseToolTypes(allowToolTypesEnv),
      allowToolCwdPrefixes: parseCsv(allowToolCwdPrefixesEnv, rawAllowCwdPrefixes.join(",")),
      toolArtifactSync: parseToolArtifactSync(toolArtifactSyncEnv),
      maxToolArtifactBytes: parseOptionalPositiveInteger(maxToolArtifactBytesEnv, "SWITCHYARD_NODE_MAX_TOOL_ARTIFACT_BYTES"),
      toolApprovalRequired: parseBoolean(toolApprovalRequiredEnv) ?? true
    },
    tools: {
      gitBinary: optional(env["SWITCHYARD_NODE_GIT_BINARY"]) ?? "git",
      shellCatalog: parseShellCatalog(shellCatalogJson)
    },
    idleIntervalMs: Number(optional(env["SWITCHYARD_NODE_IDLE_MS"]) ?? "200"),
    redactedSummary: {}
  };
  const sharedToken = optional(env["SWITCHYARD_NODE_SHARED_TOKEN"]);
  const nodeId = optional(env["SWITCHYARD_NODE_ID"]);
  if (sharedToken) config.sharedToken = sharedToken;
  if (nodeId) config.nodeId = nodeId;
  if (nodeGithubToken) config.tools.githubToken = nodeGithubToken;

  if (!Number.isFinite(config.idleIntervalMs) || config.idleIntervalMs < 1) {
    throw new ConfigError("config_invalid:SWITCHYARD_NODE_IDLE_MS", "SWITCHYARD_NODE_IDLE_MS", buildSummary(config));
  }
  if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
    requireVar(optional(env["SWITCHYARD_SERVER_URL"]), "SWITCHYARD_SERVER_URL", config);
    requireVar(sharedToken, "SWITCHYARD_NODE_SHARED_TOKEN", config);
    requireVar(capabilitiesEnv, "SWITCHYARD_NODE_CAPABILITIES", config);
    requireVar(allowRuntimeModesEnv, "SWITCHYARD_NODE_ALLOW_RUNTIME_MODES", config);
    requireVar(allowCwdPrefixesEnv, "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES", config);
    if (config.capabilities.length === 0) {
      throw new ConfigError("config_required:SWITCHYARD_NODE_CAPABILITIES", "SWITCHYARD_NODE_CAPABILITIES", buildSummary(config));
    }
    if (config.policy.allowRuntimeModes.length === 0) {
      throw new ConfigError(
        "config_required:SWITCHYARD_NODE_ALLOW_RUNTIME_MODES",
        "SWITCHYARD_NODE_ALLOW_RUNTIME_MODES",
        buildSummary(config)
      );
    }
    if (config.policy.allowCwdPrefixes.length === 0) {
      throw new ConfigError(
        "config_required:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES",
        "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES",
        buildSummary(config)
      );
    }

    if (config.deploymentMode === "production") {
      enforceProductionValidation(validateProductionHttpsUrl({
        variable: "SWITCHYARD_SERVER_URL",
        value: config.serverUrl
      }), config);
      enforceProductionValidation(validateProductionSecret({
        variable: "SWITCHYARD_NODE_SHARED_TOKEN",
        value: config.sharedToken,
        minLength: 32
      }), config);
      enforceProductionValidation(
        validateProductionFakeOnlyAllowlist(config.policy.allowRuntimeModes, "SWITCHYARD_NODE_ALLOW_RUNTIME_MODES"),
        config
      );
      enforceProductionValidation(validateProductionCwdPrefixes(rawAllowCwdPrefixes), config);
    }
  }
  config.redactedSummary = buildSummary(config);
  return config;
}

function enforceProductionValidation(
  validation: { ok: true } | { ok: false; code: string; variable: string },
  config: NodeAppConfig
): void {
  if (validation.ok) {
    return;
  }
  if (validation.code === "hosted_real_runtime_disabled") {
    throw new ConfigError("hosted_real_runtime_production_forbidden", validation.variable, buildSummary(config));
  }
  throw new ConfigError(validation.code, validation.variable, buildSummary(config));
}

function parseDeploymentMode(value: string | undefined): DeploymentMode {
  const normalized = optional(value) ?? "local";
  if (normalized === "local" || normalized === "test" || normalized === "staging" || normalized === "production") {
    return normalized;
  }
  throw new ConfigError("config_invalid:SWITCHYARD_DEPLOYMENT_MODE", "SWITCHYARD_DEPLOYMENT_MODE", { deploymentMode: normalized });
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function requireVar(value: string | undefined, variable: string, config: NodeAppConfig): void {
  if (!value) {
    throw new ConfigError(`config_required:${variable}`, variable, buildSummary(config));
  }
}

function rejectHostedWorkerOnlyEnv(env: NodeJS.ProcessEnv): void {
  for (const variable of [
    "SWITCHYARD_TOOL_ADAPTER_MODE",
    "SWITCHYARD_HOSTED_REAL_TOOLS",
    "SWITCHYARD_CONNECTED_NODE_REAL_TOOLS",
    "SWITCHYARD_REAL_TOOL_POLICY_JSON",
    "SWITCHYARD_REAL_TOOL_POLICY_PATH",
    "SWITCHYARD_GITHUB_TOKEN"
  ]) {
    if (optional(env[variable])) {
      throw new ConfigError(`config_invalid:${variable}`, variable, { deploymentMode: optional(env["SWITCHYARD_DEPLOYMENT_MODE"]) ?? "local" });
    }
  }
}

function parseToolTypes(value: string | undefined): NodePolicy["allowToolTypes"] {
  const parsed = parseCsv(value, "");
  if (parsed.length === 0) {
    return [];
  }
  const allowed = new Set(["web_search", "fetch", "browser", "repo", "shell", "github", "fake_echo"]);
  for (const toolType of parsed) {
    if (!allowed.has(toolType)) {
      throw new ConfigError("config_invalid:SWITCHYARD_NODE_ALLOW_TOOL_TYPES", "SWITCHYARD_NODE_ALLOW_TOOL_TYPES", { toolType });
    }
  }
  return parsed as NodePolicy["allowToolTypes"];
}

function parseToolArtifactSync(value: string | undefined): NodePolicy["toolArtifactSync"] {
  const normalized = value ?? "full";
  if (normalized === "none" || normalized === "metadata_only" || normalized === "full") {
    return normalized;
  }
  throw new ConfigError("config_invalid:SWITCHYARD_NODE_TOOL_ARTIFACT_SYNC", "SWITCHYARD_NODE_TOOL_ARTIFACT_SYNC", { value: normalized });
}

function parseOptionalPositiveInteger(value: string | undefined, variable: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new ConfigError(`config_invalid:${variable}`, variable, { value });
  }
  return parsed;
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
  throw new ConfigError("config_invalid:SWITCHYARD_NODE_TOOL_APPROVAL_REQUIRED", "SWITCHYARD_NODE_TOOL_APPROVAL_REQUIRED", { value });
}

function parseCsv(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseShellCatalog(value: string | undefined): Record<string, ShellCatalogCommandConfig> {
  if (!value) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError("config_invalid:SWITCHYARD_NODE_SHELL_CATALOG_JSON", "SWITCHYARD_NODE_SHELL_CATALOG_JSON", {});
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("config_invalid:SWITCHYARD_NODE_SHELL_CATALOG_JSON", "SWITCHYARD_NODE_SHELL_CATALOG_JSON", {});
  }
  const out: Record<string, ShellCatalogCommandConfig> = {};
  for (const [commandId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ConfigError("config_invalid:SWITCHYARD_NODE_SHELL_CATALOG_JSON", "SWITCHYARD_NODE_SHELL_CATALOG_JSON", { commandId });
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record["executablePath"] !== "string" ||
      !Array.isArray(record["fixedArgs"]) ||
      typeof record["timeoutMs"] !== "number" ||
      typeof record["maxOutputBytes"] !== "number" ||
      !record["env"] ||
      typeof record["env"] !== "object" ||
      Array.isArray(record["env"])
    ) {
      throw new ConfigError("config_invalid:SWITCHYARD_NODE_SHELL_CATALOG_JSON", "SWITCHYARD_NODE_SHELL_CATALOG_JSON", { commandId });
    }
    const fixedArgs = record["fixedArgs"].every((entry) => typeof entry === "string");
    const envStrings = Object.values(record["env"] as Record<string, unknown>).every((entry) => typeof entry === "string");
    if (!fixedArgs || !envStrings) {
      throw new ConfigError("config_invalid:SWITCHYARD_NODE_SHELL_CATALOG_JSON", "SWITCHYARD_NODE_SHELL_CATALOG_JSON", { commandId });
    }
    out[commandId] = {
      executablePath: record["executablePath"],
      fixedArgs: record["fixedArgs"] as string[],
      env: record["env"] as Record<string, string>,
      timeoutMs: record["timeoutMs"],
      maxOutputBytes: record["maxOutputBytes"]
    };
  }
  return out;
}

function buildSummary(config: NodeAppConfig): Record<string, unknown> {
  let serverUrlScheme = "invalid";
  let serverUrlHost = "invalid";
  try {
    const parsed = new URL(config.serverUrl);
    serverUrlScheme = parsed.protocol.replace(/:$/, "");
    serverUrlHost = parsed.host;
  } catch {
    serverUrlScheme = "invalid";
    serverUrlHost = "invalid";
  }

  return redactSecrets({
    deploymentMode: config.deploymentMode,
    serverUrlScheme,
    serverUrlHost,
    hasSharedToken: Boolean(config.sharedToken),
    capabilities: config.capabilities,
    allowRuntimeModes: config.policy.allowRuntimeModes,
    allowCwdPrefixes: config.policy.allowCwdPrefixes,
    allowToolTypes: config.policy.allowToolTypes,
    allowToolCwdPrefixes: config.policy.allowToolCwdPrefixes,
    toolArtifactSync: config.policy.toolArtifactSync,
    toolApprovalRequired: config.policy.toolApprovalRequired,
    hasNodeGithubToken: Boolean(config.tools.githubToken),
    shellCatalogCommandIds: Object.keys(config.tools.shellCatalog),
    gitBinary: config.tools.gitBinary,
    idleIntervalMs: config.idleIntervalMs
  });
}
