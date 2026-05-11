export interface DaemonConfig {
  host: string;
  port: number;
}

export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  return {
    host: env["SWITCHYARD_HOST"] ?? "127.0.0.1",
    port: Number(env["SWITCHYARD_PORT"] ?? 4545)
  };
}
