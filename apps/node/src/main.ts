import { createNodeApp } from "./app.js";
import { loadNodeConfig } from "./config.js";

const config = loadNodeConfig();
const app = createNodeApp(config);
await app.start();
const signal = new AbortController();
process.on("SIGINT", () => signal.abort());
process.on("SIGTERM", () => signal.abort());

try {
  while (!signal.signal.aborted) {
    const worked = await app.tick();
    if (!worked) {
      await new Promise((resolve) => setTimeout(resolve, config.idleIntervalMs));
    }
  }
} finally {
  await app.stop();
}
