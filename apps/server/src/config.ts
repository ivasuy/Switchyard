export interface ServerConfig {
  host: string;
  port: number;
  nodeSharedToken?: string;
  hostedRuntimeAllowlist: string[];
  postgresUrl?: string;
  redisUrl?: string;
  queueName?: string;
  objectStoreDir?: string;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const allowlist = (env["SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"] ?? "fake.deterministic")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const config: ServerConfig = {
    host: env["SWITCHYARD_HOST"] ?? "127.0.0.1",
    port: Number(env["SWITCHYARD_PORT"] ?? 4646),
    hostedRuntimeAllowlist: allowlist,
    queueName: env["SWITCHYARD_QUEUE_NAME"]?.trim() || "switchyard-hosted-runs"
  };
  const nodeSharedToken = env["SWITCHYARD_NODE_SHARED_TOKEN"]?.trim();
  const postgresUrl = env["SWITCHYARD_POSTGRES_URL"]?.trim();
  const redisUrl = env["SWITCHYARD_REDIS_URL"]?.trim();
  const objectStoreDir = env["SWITCHYARD_OBJECT_STORE_DIR"]?.trim();
  if (nodeSharedToken) {
    config.nodeSharedToken = nodeSharedToken;
  }
  if (postgresUrl) config.postgresUrl = postgresUrl;
  if (redisUrl) config.redisUrl = redisUrl;
  if (objectStoreDir) config.objectStoreDir = objectStoreDir;
  return config;
}
