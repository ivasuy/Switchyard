export type DeploymentMode = "local" | "test" | "staging" | "production";

export class ConfigError extends Error {
  constructor(readonly code: string, readonly variable: string, readonly redactedConfig: Record<string, unknown>) {
    super(code);
  }
}

export interface WorkerConfig {
  deploymentMode: DeploymentMode;
  hostedRuntimeAllowlist: string[];
  postgresUrl?: string;
  redisUrl?: string;
  queueName?: string;
  objectStoreDir?: string;
  idleIntervalMs: number;
  redactedSummary: Record<string, unknown>;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const deploymentMode = parseDeploymentMode(env["SWITCHYARD_DEPLOYMENT_MODE"]);
  const config: WorkerConfig = {
    deploymentMode,
    hostedRuntimeAllowlist: parseCsv(env["SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"], "fake.deterministic"),
    queueName: optional(env["SWITCHYARD_QUEUE_NAME"]) ?? "switchyard-hosted-runs",
    idleIntervalMs: Number(optional(env["SWITCHYARD_WORKER_IDLE_MS"]) ?? "200"),
    redactedSummary: {}
  };
  const postgresUrl = optional(env["SWITCHYARD_POSTGRES_URL"]);
  const redisUrl = optional(env["SWITCHYARD_REDIS_URL"]);
  const objectStoreDir = optional(env["SWITCHYARD_OBJECT_STORE_DIR"]);
  if (postgresUrl) config.postgresUrl = postgresUrl;
  if (redisUrl) config.redisUrl = redisUrl;
  if (objectStoreDir) config.objectStoreDir = objectStoreDir;

  if (!Number.isFinite(config.idleIntervalMs) || config.idleIntervalMs < 1) {
    throw new ConfigError("config_invalid:SWITCHYARD_WORKER_IDLE_MS", "SWITCHYARD_WORKER_IDLE_MS", buildSummary(config));
  }

  if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
    requireVar(config.postgresUrl, "SWITCHYARD_POSTGRES_URL", config);
    requireVar(config.redisUrl, "SWITCHYARD_REDIS_URL", config);
    requireVar(config.objectStoreDir, "SWITCHYARD_OBJECT_STORE_DIR", config);
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
    hasPostgresUrl: Boolean(config.postgresUrl),
    hasRedisUrl: Boolean(config.redisUrl),
    objectStoreDir: config.objectStoreDir ? "[set]" : "[unset]",
    idleIntervalMs: config.idleIntervalMs
  };
}
