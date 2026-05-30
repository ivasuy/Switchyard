import { pathToFileURL } from "node:url";
import { createDaemonApp } from "./app.js";
import { loadDaemonConfig } from "./config.js";
import { createConsoleLogger } from "./logger.js";

export async function startDaemon() {
  const config = loadDaemonConfig();
  const logger = createConsoleLogger();
  const app = await createDaemonApp(config, { logger });
  await app.listen({ host: config.host, port: config.port });
  logger.info("daemon.listening", { url: `http://${config.host}:${config.port}` });
  return app;
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
