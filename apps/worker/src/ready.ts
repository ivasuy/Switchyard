import { pathToFileURL } from "node:url";
import { createHostedWorker, type WorkerReadinessReport } from "./worker.js";
import { loadWorkerConfig } from "./config.js";

export async function runWorkerReadinessCommand(env: NodeJS.ProcessEnv = process.env): Promise<WorkerReadinessReport> {
  let worker: ReturnType<typeof createHostedWorker> | undefined;
  try {
    const config = loadWorkerConfig(env);
    worker = createHostedWorker(config);
    const report = await worker.ready({ mode: "full" });
    return report;
  } catch (error) {
    const diagnostics = (error as { redactedConfig?: unknown })?.redactedConfig as Record<string, unknown> | undefined;
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      checks: {
        hostedRuntimeGate: {
          ok: false,
          code: error instanceof Error ? error.message : "worker_readiness_failed",
          ...(diagnostics ? { diagnostics } : {})
        }
      }
    };
  } finally {
    if (worker) {
      await worker.stop();
    }
  }
}

async function main(): Promise<void> {
  const report = await runWorkerReadinessCommand();
  console.info(JSON.stringify(report));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
