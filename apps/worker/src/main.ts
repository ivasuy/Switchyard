import { createHostedWorker } from "./worker.js";
import { loadWorkerConfig } from "./config.js";

let worker: ReturnType<typeof createHostedWorker> | undefined;
let config: ReturnType<typeof loadWorkerConfig> | undefined;
const signal = new AbortController();
process.on("SIGINT", () => signal.abort());
process.on("SIGTERM", () => signal.abort());

try {
  const loadedConfig = loadWorkerConfig();
  config = loadedConfig;
  worker = createHostedWorker(loadedConfig);
  const readiness = await worker.ready({ mode: "full" });
  if (!readiness.ok) {
    console.error("worker.start_failed", {
      code: readiness.reason ?? "worker_readiness_failed",
      config: loadedConfig.redactedSummary,
      checks: readiness.checks ?? {}
    });
    process.exitCode = 1;
  } else {
    console.info("worker.started", { config: loadedConfig.redactedSummary });
    while (!signal.signal.aborted) {
      const worked = await worker.tick();
      if (!worked) {
        await new Promise((resolve) => setTimeout(resolve, loadedConfig.idleIntervalMs));
      }
    }
  }
} catch (error) {
  console.error("worker.start_failed", {
    code: error instanceof Error ? error.message : String(error),
    config: (error as { redactedConfig?: unknown })?.redactedConfig ?? config?.redactedSummary ?? {}
  });
  process.exitCode = 1;
} finally {
  await worker?.stop();
}
