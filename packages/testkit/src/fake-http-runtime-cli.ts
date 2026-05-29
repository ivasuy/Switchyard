import { startFakeHttpRuntimeServer, type FakeHttpRuntimeScenario } from "./fake-http-runtime-server.js";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const host = readArg("--host") ?? "127.0.0.1";
  const portRaw = readArg("--port");
  const port = portRaw ? Number(portRaw) : 0;
  const scenario = (readArg("--scenario") ?? "happy") as FakeHttpRuntimeScenario;
  const expectedAuthToken = readArg("--token");

  const server = await startFakeHttpRuntimeServer({
    host,
    port,
    scenario,
    ...(expectedAuthToken ? { expectedAuthToken } : {})
  });

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  console.log(`fake-http-runtime listening on ${server.baseUrl} scenario=${scenario}`);
}

void main();
