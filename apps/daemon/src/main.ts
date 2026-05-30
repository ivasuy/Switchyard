import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createDaemonApp } from "./app.js";
import { loadDaemonConfig, type DaemonConfig } from "./config.js";
import { createConsoleLogger } from "./logger.js";

export interface DaemonStartOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  artifactDir?: string;
}

export async function startDaemon(options: DaemonStartOptions = {}) {
  const config = resolveConfigWithOverrides(options);
  const logger = createConsoleLogger();
  const app = await createDaemonApp(config, { logger });
  await app.listen({ host: config.host, port: config.port });
  logger.info("daemon.listening", { url: `http://${config.host}:${config.port}` });
  return app;
}

function resolveConfigWithOverrides(options: DaemonStartOptions): DaemonConfig {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.host ? { SWITCHYARD_HOST: options.host } : {}),
    ...(typeof options.port === "number" ? { SWITCHYARD_PORT: String(options.port) } : {}),
    ...(options.dataDir ? { SWITCHYARD_DATA_DIR: options.dataDir } : {}),
    ...(options.artifactDir ? { SWITCHYARD_ARTIFACT_DIR: options.artifactDir } : {})
  };

  if (options.dataDir && !env["SWITCHYARD_SQLITE_PATH"]) {
    env["SWITCHYARD_SQLITE_PATH"] = join(options.dataDir, "switchyard.sqlite");
  }

  return loadDaemonConfig(env);
}

async function runMain(): Promise<void> {
  const app = await startDaemon();
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runMain();
}
