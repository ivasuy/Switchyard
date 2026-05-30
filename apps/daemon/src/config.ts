import { join } from "node:path";

export interface DaemonConfig {
  host: string;
  port: number;
  dataDir: string;
  sqlitePath: string;
  artifactDir: string;
  opencode: {
    command: string;
  };
  acp: {
    requestTimeoutMs: number;
    cancelTimeoutMs: number;
    maxMessageBytes: number;
  };
  genericHttp: {
    baseUrl?: string;
    authToken?: string;
    requestTimeoutMs: number;
    pollIntervalMs: number;
    maxResponseBytes: number;
  };
  agentfield?: {
    baseUrl?: string;
    apiKey?: string;
    target?: string;
    requestTimeoutMs: number;
    pollIntervalMs: number;
    maxResponseBytes: number;
  };
}

export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const dataDir = env["SWITCHYARD_DATA_DIR"] ?? join(process.cwd(), ".switchyard");
  const baseUrl = env["SWITCHYARD_GENERIC_HTTP_BASE_URL"]?.trim();
  const authToken = env["SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN"]?.trim();
  const agentfieldBaseUrl = env["SWITCHYARD_AGENTFIELD_BASE_URL"]?.trim();
  const agentfieldApiKey = env["SWITCHYARD_AGENTFIELD_API_KEY"]?.trim();
  const agentfieldTarget = env["SWITCHYARD_AGENTFIELD_TARGET"]?.trim();
  const opencodeCommand = env["SWITCHYARD_OPENCODE_COMMAND"]?.trim();

  return {
    host: env["SWITCHYARD_HOST"] ?? "127.0.0.1",
    port: Number(env["SWITCHYARD_PORT"] ?? 4545),
    dataDir,
    sqlitePath: env["SWITCHYARD_SQLITE_PATH"] ?? join(dataDir, "switchyard.sqlite"),
    artifactDir: env["SWITCHYARD_ARTIFACT_DIR"] ?? join(dataDir, "artifacts"),
    opencode: {
      command: opencodeCommand && opencodeCommand.length > 0 ? opencodeCommand : "opencode"
    },
    acp: {
      requestTimeoutMs: Number(env["SWITCHYARD_ACP_REQUEST_TIMEOUT_MS"] ?? 5000),
      cancelTimeoutMs: Number(env["SWITCHYARD_ACP_CANCEL_TIMEOUT_MS"] ?? 5000),
      maxMessageBytes: Number(env["SWITCHYARD_ACP_MAX_MESSAGE_BYTES"] ?? 1024 * 1024)
    },
    genericHttp: {
      ...(baseUrl && baseUrl.length > 0 ? { baseUrl } : {}),
      ...(authToken && authToken.length > 0 ? { authToken } : {}),
      requestTimeoutMs: Number(env["SWITCHYARD_GENERIC_HTTP_REQUEST_TIMEOUT_MS"] ?? 5000),
      pollIntervalMs: Number(env["SWITCHYARD_GENERIC_HTTP_POLL_INTERVAL_MS"] ?? 100),
      maxResponseBytes: Number(env["SWITCHYARD_GENERIC_HTTP_MAX_RESPONSE_BYTES"] ?? 1024 * 1024)
    },
    agentfield: {
      ...(agentfieldBaseUrl && agentfieldBaseUrl.length > 0 ? { baseUrl: agentfieldBaseUrl } : {}),
      ...(agentfieldApiKey && agentfieldApiKey.length > 0 ? { apiKey: agentfieldApiKey } : {}),
      ...(agentfieldTarget && agentfieldTarget.length > 0 ? { target: agentfieldTarget } : {}),
      requestTimeoutMs: Number(env["SWITCHYARD_AGENTFIELD_REQUEST_TIMEOUT_MS"] ?? 5000),
      pollIntervalMs: Number(env["SWITCHYARD_AGENTFIELD_POLL_INTERVAL_MS"] ?? 1000),
      maxResponseBytes: Number(env["SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES"] ?? 1024 * 1024)
    }
  };
}
