import {
  resolveHostedSandboxConfig,
  validateHostedRuntimeAllowlist,
  type HostedRealRuntimeExecution,
  type ResolvedHostedSandboxConfig
} from "@switchyard/core";
import {
  ObjectStoreConfigError,
  resolveObjectStoreConfig,
  type ResolvedObjectStoreConfig
} from "@switchyard/storage";

export type DeploymentMode = "local" | "test" | "staging" | "production";

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
  redactedSummary: Record<string, unknown>;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const deploymentMode = parseDeploymentMode(env["SWITCHYARD_DEPLOYMENT_MODE"]);
  const hostedRuntimeAllowlistEnv = optional(env["SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"]);
  const hostedRealRuntimeExecution = parseHostedRealRuntimeExecution(env["SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"]);
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

  const allowlistValidation = validateHostedRuntimeAllowlist({
    allowlist: config.hostedRuntimeAllowlist,
    deploymentMode: config.deploymentMode,
    realRuntimeExecution: config.hostedRealRuntimeExecution
  });
  if (!allowlistValidation.ok) {
    const variable = allowlistValidation.code.includes("REAL_RUNTIME_EXECUTION")
      ? "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"
      : "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST";
    throw new ConfigError(allowlistValidation.code, variable, buildSummary(config));
  }

  if (!config.sandbox.valid) {
    throw new ConfigError("sandbox_config_invalid", "SWITCHYARD_SANDBOX_*", buildSummary(config));
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

function requireVar(value: string | undefined, variable: string, config: WorkerConfig): void {
  if (!value) {
    throw new ConfigError(`config_required:${variable}`, variable, buildSummary(config));
  }
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildSummary(config: WorkerConfig): Record<string, unknown> {
  return {
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
    }
  };
}
