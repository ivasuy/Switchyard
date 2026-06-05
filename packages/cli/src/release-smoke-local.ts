import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_ORDER = [
  "@switchyard/contracts",
  "@switchyard/core",
  "@switchyard/protocol-sse",
  "@switchyard/protocol-acpx",
  "@switchyard/protocol-rest",
  "@switchyard/storage",
  "@switchyard/testkit",
  "@switchyard/adapters",
  "@switchyard/daemon",
  "@switchyard/sdk",
  "@switchyard/cli"
] as const;

async function main(): Promise<void> {
  const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const tempRoot = mkdtempSync(join(tmpdir(), "switchyard-release-smoke-"));
  const packDir = join(tempRoot, "packs");
  const appDir = join(tempRoot, "app");
  const dataDir = join(tempRoot, "daemon-data");
  const artifactDir = join(dataDir, "artifacts");

  let daemon: ReturnType<typeof spawn> | undefined;
  try {
    runCommand("mkdir", ["-p", packDir, appDir, dataDir, artifactDir], { cwd: repoRoot });

    for (const pkg of PACKAGE_ORDER) {
      runCommand("pnpm", ["--filter", pkg, "build"], { cwd: repoRoot });
      runCommand("pnpm", ["--filter", pkg, "pack", "--pack-destination", packDir], { cwd: repoRoot });
    }

    const tarballs = readdirSync(packDir)
      .filter((name) => name.endsWith(".tgz"))
      .sort();

    const tarballByPackage = new Map<string, string>();
    for (const fileName of tarballs) {
      const packageName = packageNameFromTarball(fileName);
      tarballByPackage.set(packageName, join(packDir, fileName));
    }

    const dependencies: Record<string, string> = {};
    for (const pkg of PACKAGE_ORDER) {
      const tarballPath = tarballByPackage.get(pkg);
      if (!tarballPath) {
        throw new Error(`missing tarball for package ${pkg}`);
      }
      dependencies[pkg] = `file:${tarballPath}`;
    }

    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify(
        {
          name: "switchyard-release-smoke-app",
          private: true,
          type: "module",
          packageManager: "pnpm@10.33.4",
          dependencies,
          pnpm: {
            onlyBuiltDependencies: ["better-sqlite3"],
            overrides: dependencies
          }
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    runCommand("pnpm", ["install"], { cwd: appDir });
    runCommand("pnpm", ["rebuild", "better-sqlite3"], { cwd: appDir });

    runCommand("pnpm", ["exec", "switchyard", "--help"], { cwd: appDir });
    runCommand("pnpm", ["exec", "switchyard", "contract", "export", "--output", "./openapi.json"], { cwd: appDir });

    const openapi = readFileSync(join(appDir, "openapi.json"), "utf8");
    if (!openapi.includes('"openapi": "3.1.0"')) {
      throw new Error("contract export did not produce OpenAPI 3.1.0 JSON");
    }

    const port = await allocatePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    daemon = spawn(
      "pnpm",
      [
        "exec",
        "switchyard",
        "daemon",
        "start",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--data-dir",
        dataDir,
        "--artifact-dir",
        artifactDir,
        "--foreground",
        "--ready-timeout-ms",
        "5000"
      ],
      {
        cwd: appDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      }
    );

    let daemonStdout = "";
    let daemonStderr = "";
    daemon.stdout?.on("data", (chunk) => {
      daemonStdout += String(chunk);
    });
    daemon.stderr?.on("data", (chunk) => {
      daemonStderr += String(chunk);
    });

    await delay(2000);
    if (daemon.exitCode !== null) {
      throw new Error(`daemon exited early with code ${daemon.exitCode}\nstdout:\n${daemonStdout}\nstderr:\n${daemonStderr}`);
    }

    await waitForHealth(baseUrl, 20000);

    const doctorOutput = runCommand(
      "pnpm",
      ["exec", "switchyard", "doctor", "--json", "--active-fake-check", "--base-url", baseUrl],
      { cwd: appDir }
    );
    const doctorJson = JSON.parse(doctorOutput);
    if (!doctorJson.doctor || !doctorJson.activeFakeCheck) {
      throw new Error("doctor JSON output missing expected keys");
    }

    const fakeRunOutput = runCommand(
      "pnpm",
      [
        "exec",
        "switchyard",
        "run",
        "fake",
        "--base-url",
        baseUrl,
        "--cwd",
        appDir,
        "--task",
        "release smoke fake run",
        "--timeout-seconds",
        "30",
        "--wait"
      ],
      { cwd: appDir }
    );
    const fakeRun = JSON.parse(fakeRunOutput) as { runId?: string; status?: string };
    if (!fakeRun.runId || fakeRun.status !== "completed") {
      throw new Error(`fake run did not complete: ${fakeRunOutput}`);
    }

    const debugOutput = runCommand(
      "pnpm",
      [
        "exec",
        "switchyard",
        "debug",
        "run",
        fakeRun.runId,
        "--base-url",
        baseUrl,
        "--include-artifact-content",
        "--live"
      ],
      { cwd: appDir }
    );
    const debugJson = JSON.parse(debugOutput) as { artifacts?: unknown[]; artifactContents?: unknown[]; events?: unknown[] };
    if (!Array.isArray(debugJson.artifacts) || !Array.isArray(debugJson.events)) {
      throw new Error("debug run output missing artifacts/events arrays");
    }
    if (!Array.isArray(debugJson.artifactContents) || debugJson.artifactContents.length === 0) {
      throw new Error("debug run output missing artifact content");
    }

    const sdkSmokeScript = join(appDir, "sdk-smoke.mjs");
    writeFileSync(
      sdkSmokeScript,
      [
        "import { SwitchyardClient } from '@switchyard/sdk';",
        "const baseUrl = process.env.BASE_URL;",
        "const runId = process.env.RUN_ID;",
        "if (!baseUrl || !runId) throw new Error('BASE_URL and RUN_ID are required');",
        "const client = new SwitchyardClient({ baseUrl });",
        "const health = await client.health();",
        "if (!health.ok) throw new Error('health not ok');",
        "const run = await client.getRun(runId);",
        "if (!run.run || run.events.length === 0) throw new Error('run/events missing');",
        "const replay = await client.replayRunEvents(runId);",
        "if (replay.length === 0) throw new Error('event replay empty');",
        "const artifacts = await client.listRunArtifacts(runId);",
        "if (artifacts.artifacts.length === 0) throw new Error('artifacts empty');",
        "const artifact = await client.getArtifact(artifacts.artifacts[0].id);",
        "const content = await client.getArtifactContent(artifact.id);",
        "if (content.body.length === 0) throw new Error('artifact content empty');"
      ].join("\n"),
      "utf8"
    );

    runCommand("pnpm", ["exec", "node", sdkSmokeScript], {
      cwd: appDir,
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        RUN_ID: fakeRun.runId
      }
    });

    daemon.kill("SIGINT");
    await waitForExit(daemon, 5000);

    const daemonExitedCleanly = daemon.exitCode === 0 || daemon.signalCode === "SIGINT" || daemon.signalCode === "SIGTERM";
    if (!daemonExitedCleanly) {
      throw new Error(
        `daemon exited unexpectedly: code=${daemon.exitCode} signal=${daemon.signalCode}\nstdout:\n${daemonStdout}\nstderr:\n${daemonStderr}`
      );
    }

    process.stdout.write("release:smoke-local OK\n");
  } finally {
    if (daemon && daemon.exitCode === null && !daemon.killed) {
      daemon.kill("SIGTERM");
      await waitForExit(daemon, 2000).catch(() => {});
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }
    await delay(100);
  }
  throw new Error(`daemon did not become healthy within ${timeoutMs}ms`);
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate tcp port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function packageNameFromTarball(fileName: string): string {
  const withoutVersion = fileName.replace(/-\d+\.\d+\.\d+.*\.tgz$/, "");
  if (!withoutVersion.startsWith("switchyard-")) {
    throw new Error(`unexpected tarball name: ${fileName}`);
  }
  const scopedName = withoutVersion.slice("switchyard-".length);
  return `@switchyard/${scopedName}`;
}

await main();
