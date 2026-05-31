import { createNodeApp } from "./app.js";
import { loadNodeConfig } from "./config.js";

let app: ReturnType<typeof createNodeApp> | undefined;
let config: ReturnType<typeof loadNodeConfig> | undefined;
const signal = new AbortController();
process.on("SIGINT", () => signal.abort());
process.on("SIGTERM", () => signal.abort());

try {
  const loadedConfig = loadNodeConfig();
  config = loadedConfig;
  app = createNodeApp(loadedConfig);
  await app.start();
  console.info("node.started", { config: loadedConfig.redactedSummary });
  while (!signal.signal.aborted) {
    const worked = await app.tick();
    if (!worked) {
      await new Promise((resolve) => setTimeout(resolve, loadedConfig.idleIntervalMs));
    }
  }
} catch (error) {
  console.error("node.start_failed", {
    code: error instanceof Error ? error.message : String(error),
    config: (error as { redactedConfig?: unknown })?.redactedConfig ?? config?.redactedSummary ?? {}
  });
  process.exitCode = 1;
} finally {
  await app?.stop();
}
