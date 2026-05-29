import { join } from "node:path";

export interface DaemonConfig {
  host: string;
  port: number;
  dataDir: string;
  sqlitePath: string;
  artifactDir: string;
  genericHttp: {
    baseUrl?: string;
    authToken?: string;
    requestTimeoutMs: number;
    pollIntervalMs: number;
    maxResponseBytes: number;
  };
}

export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const dataDir = env["SWITCHYARD_DATA_DIR"] ?? join(process.cwd(), ".switchyard");
  const baseUrl = env["SWITCHYARD_GENERIC_HTTP_BASE_URL"]?.trim();
  const authToken = env["SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN"]?.trim();

  return {
    host: env["SWITCHYARD_HOST"] ?? "127.0.0.1",
    port: Number(env["SWITCHYARD_PORT"] ?? 4545),
    dataDir,
    sqlitePath: env["SWITCHYARD_SQLITE_PATH"] ?? join(dataDir, "switchyard.sqlite"),
    artifactDir: env["SWITCHYARD_ARTIFACT_DIR"] ?? join(dataDir, "artifacts"),
    genericHttp: {
      ...(baseUrl && baseUrl.length > 0 ? { baseUrl } : {}),
      ...(authToken && authToken.length > 0 ? { authToken } : {}),
      requestTimeoutMs: Number(env["SWITCHYARD_GENERIC_HTTP_REQUEST_TIMEOUT_MS"] ?? 5000),
      pollIntervalMs: Number(env["SWITCHYARD_GENERIC_HTTP_POLL_INTERVAL_MS"] ?? 100),
      maxResponseBytes: Number(env["SWITCHYARD_GENERIC_HTTP_MAX_RESPONSE_BYTES"] ?? 1024 * 1024)
    }
  };
}
