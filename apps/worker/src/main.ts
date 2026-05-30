import { createHostedWorker } from "./worker.js";
import { loadWorkerConfig } from "./config.js";

const config = loadWorkerConfig();
const worker = createHostedWorker(config);
const signal = new AbortController();

process.on("SIGINT", () => signal.abort());
process.on("SIGTERM", () => signal.abort());

try {
  while (!signal.signal.aborted) {
    const worked = await worker.tick();
    if (!worked) {
      await new Promise((resolve) => setTimeout(resolve, config.idleIntervalMs));
    }
  }
} finally {
  await worker.stop();
}
