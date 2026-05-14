import { createDaemonApp } from "./app.js";
import { loadDaemonConfig } from "./config.js";
import { createConsoleLogger } from "./logger.js";

const config = loadDaemonConfig();
const logger = createConsoleLogger();
const app = await createDaemonApp(config, { logger });

await app.listen({ host: config.host, port: config.port });
logger.info("daemon.listening", { url: `http://${config.host}:${config.port}` });
