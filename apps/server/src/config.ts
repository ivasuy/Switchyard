import {
  ObjectStoreConfigError,
  resolveObjectStoreConfig,
  type ResolvedObjectStoreConfig
} from "@switchyard/storage";

export type DeploymentMode = "local" | "test" | "staging" | "production";

export class ConfigError extends Error {
  constructor(
    readonly code: string,
    readonly variable: string,
    readonly redactedConfig: Record<string, unknown>
  ) {
    super(code);
  }
}

export interface ServerConfig {
  host: string;
  port: number;
  deploymentMode: DeploymentMode;
  nodeSharedToken?: string;
  hostedRuntimeAllowlist: string[];
  postgresUrl?: string;
  redisUrl?: string;
  queueName?: string;
  objectStore: ResolvedObjectStoreConfig;
  redactedSummary: Record<string, unknown>;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const deploymentMode = parseDeploymentMode(env["SWITCHYARD_DEPLOYMENT_MODE"]);
  const hostedRuntimeAllowlistEnv = optional(env["SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"]);
  const allowlist = parseCsv(hostedRuntimeAllowlistEnv, "fake.deterministic");
  const config: ServerConfig = {
    host: requiredOrDefault(env["SWITCHYARD_HOST"], "127.0.0.1"),
    port: Number(requiredOrDefault(env["SWITCHYARD_PORT"], "4646")),
    deploymentMode,
    hostedRuntimeAllowlist: allowlist,
    queueName: requiredOrDefault(env["SWITCHYARD_QUEUE_NAME"], "switchyard-hosted-runs"),
    objectStore: {} as ResolvedObjectStoreConfig,
    redactedSummary: {}
  };

  const nodeSharedToken = optional(env["SWITCHYARD_NODE_SHARED_TOKEN"]);
  const postgresUrl = optional(env["SWITCHYARD_POSTGRES_URL"]);
  const redisUrl = optional(env["SWITCHYARD_REDIS_URL"]);
  if (nodeSharedToken) config.nodeSharedToken = nodeSharedToken;
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

  if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
    requireVar(config.postgresUrl, "SWITCHYARD_POSTGRES_URL", config);
    requireVar(config.redisUrl, "SWITCHYARD_REDIS_URL", config);
    requireVar(config.nodeSharedToken, "SWITCHYARD_NODE_SHARED_TOKEN", config);
    requireVar(hostedRuntimeAllowlistEnv, "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST", config);
    if (config.hostedRuntimeAllowlist.length === 0) {
      throw new ConfigError(
        "config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
        "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
        buildSummary(config)
      );
    }
    if (!config.hostedRuntimeAllowlist.includes("fake.deterministic")) {
      throw new ConfigError(
        "config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
        "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
        buildSummary(config)
      );
    }
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

function parseCsv(value: string | undefined, fallback: string): string[] {
  const source = optional(value) ?? fallback;
  return source.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function requireVar(value: string | undefined, variable: string, config: ServerConfig): void {
  if (!value) {
    throw new ConfigError(`config_required:${variable}`, variable, buildSummary(config));
  }
}

function requiredOrDefault(value: string | undefined, fallback: string): string {
  return optional(value) ?? fallback;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildSummary(config: ServerConfig): Record<string, unknown> {
  return {
    deploymentMode: config.deploymentMode,
    host: config.host,
    port: config.port,
    queueName: config.queueName,
    hostedRuntimeAllowlist: config.hostedRuntimeAllowlist,
    hasNodeSharedToken: Boolean(config.nodeSharedToken),
    hasPostgresUrl: Boolean(config.postgresUrl),
    hasRedisUrl: Boolean(config.redisUrl),
    objectStore: config.objectStore?.redactedSummary ?? {}
  };
}
