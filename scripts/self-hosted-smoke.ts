import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const SERVER_URL = "http://127.0.0.1:4646";
const COMPOSE_FILE = "deploy/self-hosted/docker-compose.yml";
const KEEP_STACK = process.env["SWITCHYARD_KEEP_SMOKE_STACK"] === "1";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunSummary {
  runId: string;
  artifactId: string;
  artifactBytes: Buffer;
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "switchyard-self-hosted-smoke-"));
  const projectName = `switchyard-smoke-${Date.now().toString(36)}`;
  const composeCommand = await detectComposeCommand();
  let started = false;

  try {
    await runCompose(composeCommand, projectName, ["up", "-d"], tempRoot);
    started = true;

    await waitForReady(180_000);

    const hosted = await runHostedFakeFlow();

    await runCompose(composeCommand, projectName, ["restart", "server", "worker"], tempRoot);
    await waitForReady(120_000);
    await verifyPersistedRun(hosted, "hosted_restart");

    await waitForNodeOnline(120_000);
    const connected = await runConnectedNodeFlow();
    await verifyPersistedRun(connected, "connected_node");

    process.stdout.write("self-hosted:smoke OK\n");
  } catch (error) {
    await collectDiagnostics(composeCommand, projectName, tempRoot, error);
    throw error;
  } finally {
    if (started && !KEEP_STACK) {
      await runCompose(composeCommand, projectName, ["down", "-v"], tempRoot, true);
    }
    if (started && KEEP_STACK) {
      process.stdout.write(`self-hosted:smoke keeping stack project=${projectName}\n`);
    }
    if (!KEEP_STACK) {
      if (started) {
        // Keep tempRoot on failure for diagnostics; remove only when success reached here.
        // If a failure happened, collectDiagnostics has already printed the path.
        // We infer success by absence of an uncaught error.
      }
    }
  }

  if (!KEEP_STACK) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runHostedFakeFlow(): Promise<RunSummary> {
  const created = await requestJson("POST", `${SERVER_URL}/runs?wait=1`, {
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "compose hosted fake smoke",
    placement: "hosted"
  });
  if (created.status !== 201 || created.body?.run?.status !== "completed") {
    throw new Error(`self_hosted_smoke_hosted_failed:${created.status}`);
  }
  return verifyRunArtifacts(created.body.run.id as string, "hosted_fake");
}

async function runConnectedNodeFlow(): Promise<RunSummary> {
  const created = await requestJson("POST", `${SERVER_URL}/runs`, {
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "compose connected node smoke",
    placement: "connected_local_node"
  });
  if (created.status !== 202) {
    throw new Error(`self_hosted_smoke_connected_create_failed:${created.status}`);
  }

  const runId = created.body?.run?.id as string | undefined;
  if (!runId) {
    throw new Error("self_hosted_smoke_connected_missing_run_id");
  }

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const detail = await requestJson("GET", `${SERVER_URL}/runs/${runId}`);
    const status = detail.body?.run?.status;
    if (detail.status === 200 && status === "completed") {
      return verifyRunArtifacts(runId, "connected_node");
    }
    if (detail.status === 200 && (status === "failed" || status === "cancelled" || status === "timeout")) {
      throw new Error(`self_hosted_smoke_connected_terminal_${status}`);
    }
    await sleep(1_000);
  }

  throw new Error("self_hosted_smoke_connected_timeout");
}

async function verifyPersistedRun(summary: RunSummary, label: string): Promise<void> {
  const persisted = await verifyRunArtifacts(summary.runId, label);
  if (!persisted.artifactBytes.equals(summary.artifactBytes)) {
    throw new Error(`self_hosted_smoke_persistence_mismatch:${label}`);
  }
}

async function verifyRunArtifacts(runId: string, label: string): Promise<RunSummary> {
  const detail = await requestJson("GET", `${SERVER_URL}/runs/${runId}`);
  if (detail.status !== 200 || detail.body?.run?.id !== runId) {
    throw new Error(`self_hosted_smoke_run_detail_failed:${label}:${detail.status}`);
  }
  const events = Array.isArray(detail.body?.events) ? detail.body.events : [];
  if (events.length === 0) {
    throw new Error(`self_hosted_smoke_events_missing:${label}`);
  }

  const artifacts = await requestJson("GET", `${SERVER_URL}/runs/${runId}/artifacts`);
  if (artifacts.status !== 200 || !Array.isArray(artifacts.body?.artifacts) || artifacts.body.artifacts.length === 0) {
    throw new Error(`self_hosted_smoke_artifacts_missing:${label}`);
  }

  const artifactId = artifacts.body.artifacts[0]?.id as string | undefined;
  if (!artifactId) {
    throw new Error(`self_hosted_smoke_artifact_id_missing:${label}`);
  }

  const content = await requestRaw("GET", `${SERVER_URL}/artifacts/${artifactId}/content`);
  if (content.status !== 200 || content.body.byteLength === 0) {
    throw new Error(`self_hosted_smoke_artifact_content_failed:${label}:${content.status}`);
  }

  return {
    runId,
    artifactId,
    artifactBytes: content.body
  };
}

async function waitForReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await requestJson("GET", `${SERVER_URL}/ready`);
      if (ready.status === 200 && ready.body?.ok === true) {
        return;
      }
    } catch {
      // keep polling
    }
    await sleep(1_000);
  }
  throw new Error("self_hosted_smoke_ready_timeout");
}

async function waitForNodeOnline(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await requestJson("GET", `${SERVER_URL}/nodes`, undefined, {
      "x-switchyard-node-token": "switchyard-node-token"
    });
    const nodes = Array.isArray(response.body?.nodes) ? response.body.nodes : [];
    const online = nodes.some((node: any) => node.id === "node_smoke" && node.status === "online");
    if (response.status === 200 && online) {
      return;
    }
    await sleep(1_000);
  }
  throw new Error("self_hosted_smoke_node_online_timeout");
}

async function detectComposeCommand(): Promise<string[]> {
  const dockerCompose = await runCommand("docker", ["compose", "version"], process.cwd(), true);
  if (dockerCompose.code === 0) {
    return ["docker", "compose"];
  }
  const legacy = await runCommand("docker-compose", ["version"], process.cwd(), true);
  if (legacy.code === 0) {
    return ["docker-compose"];
  }
  throw new Error("self_hosted_smoke_compose_unavailable");
}

async function runCompose(
  composeCommand: string[],
  projectName: string,
  args: string[],
  cwd: string,
  ignoreFailure = false
): Promise<void> {
  const [cmd, ...base] = composeCommand;
  const composeArgs = [...base, "-f", COMPOSE_FILE, "-p", projectName, ...args];
  const result = await runCommand(cmd, composeArgs, process.cwd(), ignoreFailure);
  if (!ignoreFailure && result.code !== 0) {
    const outputPath = join(cwd, "compose-command-failure.log");
    await writeFile(outputPath, `${cmd} ${composeArgs.join(" ")}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}\n`);
    throw new Error(`self_hosted_smoke_compose_failed:${args.join("_")}`);
  }
}

async function collectDiagnostics(
  composeCommand: string[],
  projectName: string,
  tempRoot: string,
  error: unknown
): Promise<void> {
  const logsPath = join(tempRoot, "compose-logs.txt");
  const psPath = join(tempRoot, "compose-ps.txt");
  const volumesPath = join(tempRoot, "volumes.txt");

  const [cmd, ...base] = composeCommand;
  const ps = await runCommand(cmd, [...base, "-f", COMPOSE_FILE, "-p", projectName, "ps"], process.cwd(), true);
  const logs = await runCommand(cmd, [...base, "-f", COMPOSE_FILE, "-p", projectName, "logs", "--no-color"], process.cwd(), true);

  const pgVolume = `${projectName}_pgdata`;
  const objectVolume = `${projectName}_objectdata`;
  const pgInspect = await runCommand("docker", ["volume", "inspect", pgVolume, "--format", "{{.Name}} {{.Mountpoint}}"], process.cwd(), true);
  const objectInspect = await runCommand("docker", ["volume", "inspect", objectVolume, "--format", "{{.Name}} {{.Mountpoint}}"], process.cwd(), true);

  await writeFile(psPath, `${ps.stdout}\n${ps.stderr}`);
  await writeFile(logsPath, `${logs.stdout}\n${logs.stderr}`);
  await writeFile(volumesPath, `${pgInspect.stdout}${pgInspect.stderr}\n${objectInspect.stdout}${objectInspect.stderr}\n`);

  process.stderr.write(`self-hosted:smoke FAILED ${(error instanceof Error ? error.message : String(error))}\n`);
  process.stderr.write(`self-hosted:smoke diagnostics: ${tempRoot}\n`);
  process.stderr.write(`self-hosted:smoke volume-inspect: ${volumesPath}\n`);
}

async function requestJson(
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; body: any }> {
  const response = await fetchWithTimeout(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(headers ?? {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

async function requestRaw(method: string, url: string): Promise<{ status: number; body: Buffer }> {
  const response = await fetchWithTimeout(url, { method });
  const arrayBuffer = await response.arrayBuffer();
  return { status: response.status, body: Buffer.from(arrayBuffer) };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function runCommand(cmd: string, args: string[], cwd: string, ignoreFailure = false): Promise<CommandResult> {
  const child = spawn(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", (error) => reject(error));
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  });

  if (!ignoreFailure && code !== 0) {
    const combined = `${stdout}\n${stderr}`;
    if (combined.includes("Cannot connect to the Docker daemon")) {
      throw new Error("self_hosted_smoke_docker_unavailable");
    }
    throw new Error(`command_failed:${cmd} ${args.join(" ")}\n${stderr || stdout}`);
  }

  return { code, stdout, stderr };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
