import {
  startFakeAcpRuntimeProcess,
  type FakeAcpRuntimeScenario
} from "./fake-acp-runtime.js";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const scenario = (readArg("--scenario") ?? "happy") as FakeAcpRuntimeScenario;
  const handle = startFakeAcpRuntimeProcess({ scenario });
  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(`fake-acp-runtime scenario=${scenario} pid=${handle.process.pid ?? "n/a"}`);
}

void main();
