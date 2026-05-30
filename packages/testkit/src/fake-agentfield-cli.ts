import {
  startFakeAgentFieldServer,
  type FakeAgentFieldScenario
} from "./fake-agentfield-server.js";

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
  const scenario = (readArg("--scenario") ?? "happy") as FakeAgentFieldScenario;
  const expectedApiKey = readArg("--api-key");
  const target = readArg("--target");

  const server = await startFakeAgentFieldServer({
    host,
    port,
    scenario,
    ...(expectedApiKey ? { expectedApiKey } : {}),
    ...(target ? { target } : {})
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

  console.log(`fake-agentfield listening on ${server.baseUrl} scenario=${scenario}`);
}

void main();
