import { createDaemonApp } from "./app.js";
import { loadDaemonConfig } from "./config.js";

const config = loadDaemonConfig();
const app = createDaemonApp(config);

await app.listen({ host: config.host, port: config.port });
console.log(`Switchyard daemon listening on http://${config.host}:${config.port}`);
