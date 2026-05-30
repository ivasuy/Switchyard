import { createServerApp } from "./app.js";
import { loadServerConfig } from "./config.js";

let app;
try {
  const config = loadServerConfig();
  app = await createServerApp(config);
  await app.listen({ host: config.host, port: config.port });
  console.info("server.listening", { host: config.host, port: config.port, config: config.redactedSummary });
} catch (error) {
  console.error("server.startup_failed", {
    code: error instanceof Error ? error.message : String(error),
    config: (error as { redactedConfig?: unknown }).redactedConfig ?? {}
  });
  process.exitCode = 1;
}

if (app) {
  const stop = async () => {
    await app.close();
  };
  process.on("SIGINT", () => { void stop(); });
  process.on("SIGTERM", () => { void stop(); });
}
