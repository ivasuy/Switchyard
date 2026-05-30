import { createHostedWorker } from "./worker.js";
import { loadWorkerConfig } from "./config.js";

const worker = createHostedWorker(loadWorkerConfig());

while (true) {
  const worked = await worker.tick();
  if (!worked) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
