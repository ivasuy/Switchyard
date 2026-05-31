import type { NodePolicy } from "@switchyard/contracts";
import {
  redactSecrets,
  validateProductionCwdPrefixes,
  validateProductionFakeOnlyAllowlist,
  validateProductionHttpsUrl,
  validateProductionSecret
} from "@switchyard/core";

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
  idleIntervalMs: number;
  redactedSummary: Record<string, unknown>;
}

export function loadNodeConfig(env: NodeJS.ProcessEnv = process.env): NodeAppConfig {
  const deploymentMode = parseDeploymentMode(env["SWITCHYARD_DEPLOYMENT_MODE"]);
  const capabilitiesEnv = optional(env["SWITCHYARD_NODE_CAPABILITIES"]);
  const allowRuntimeModesEnv = optional(env["SWITCHYARD_NODE_ALLOW_RUNTIME_MODES"]);
  const allowCwdPrefixesEnv = optional(env["SWITCHYARD_NODE_ALLOW_CWD_PREFIXES"]);
  const rawAllowCwdPrefixes = (allowCwdPrefixesEnv ?? "/repo").split(",").map((value) => value.trim());
  const config: NodeAppConfig = {
    deploymentMode,
    serverUrl: env["SWITCHYARD_SERVER_URL"] ?? "http://127.0.0.1:4646",
    capabilities: (capabilitiesEnv ?? "runtime.fake.deterministic").split(",").map((value) => value.trim()).filter(Boolean),
    policy: {
      allowRuntimeModes: (allowRuntimeModesEnv ?? "fake.deterministic").split(",").map((value) => value.trim()).filter(Boolean),
      denyAdapterTypes: [],
      allowCwdPrefixes: rawAllowCwdPrefixes.filter(Boolean),
      allowEventTypes: [],
      artifactSync: "full"
    },
    idleIntervalMs: Number(optional(env["SWITCHYARD_NODE_IDLE_MS"]) ?? "200"),
    redactedSummary: {}
  };
  const sharedToken = optional(env["SWITCHYARD_NODE_SHARED_TOKEN"]);
  const nodeId = optional(env["SWITCHYARD_NODE_ID"]);
  if (sharedToken) config.sharedToken = sharedToken;
  if (nodeId) config.nodeId = nodeId;

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
    idleIntervalMs: config.idleIntervalMs
  });
}
