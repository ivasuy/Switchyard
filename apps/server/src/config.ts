export interface ServerConfig {
  host: string;
  port: number;
  nodeSharedToken?: string;
  hostedRuntimeAllowlist: string[];
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const allowlist = (env["SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"] ?? "fake.deterministic")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const config: ServerConfig = {
    host: env["SWITCHYARD_HOST"] ?? "127.0.0.1",
    port: Number(env["SWITCHYARD_PORT"] ?? 4646),
    hostedRuntimeAllowlist: allowlist
  };
  const nodeSharedToken = env["SWITCHYARD_NODE_SHARED_TOKEN"]?.trim();
  if (nodeSharedToken) {
    config.nodeSharedToken = nodeSharedToken;
  }
  return config;
}
