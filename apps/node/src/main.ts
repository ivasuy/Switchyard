import { createNodeApp } from "./app.js";
import { loadNodeConfig } from "./config.js";

const app = createNodeApp(loadNodeConfig());
await app.start();

while (true) {
  const worked = await app.tick();
  if (!worked) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
