export interface WorkerConfig {
  hostedRuntimeAllowlist: string[];
  postgresUrl?: string;
  redisUrl?: string;
  queueName?: string;
  objectStoreDir?: string;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const allowlist = (env["SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"] ?? "fake.deterministic")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const config: WorkerConfig = {
    hostedRuntimeAllowlist: allowlist,
    queueName: env["SWITCHYARD_QUEUE_NAME"]?.trim() || "switchyard-hosted-runs"
  };
  const postgresUrl = env["SWITCHYARD_POSTGRES_URL"]?.trim();
  const redisUrl = env["SWITCHYARD_REDIS_URL"]?.trim();
  const objectStoreDir = env["SWITCHYARD_OBJECT_STORE_DIR"]?.trim();
  if (postgresUrl) config.postgresUrl = postgresUrl;
  if (redisUrl) config.redisUrl = redisUrl;
  if (objectStoreDir) config.objectStoreDir = objectStoreDir;
  return config;
}
