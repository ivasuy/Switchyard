import { createServerApp } from "./app.js";
import { loadServerConfig } from "./config.js";

const config = loadServerConfig();
const app = await createServerApp(config);

await app.listen({ host: config.host, port: config.port });
console.info("server.listening", { host: config.host, port: config.port });
