import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateCompatibilityMatrix } from "@switchyard/adapters";
import { generateOpenApiDocument, renderOpenApiJson } from "@switchyard/contracts";
import { startDaemon as startDaemonApp } from "@switchyard/daemon";
import {
  SwitchyardClient,
  SwitchyardDecodeError,
  SwitchyardHttpError,
  SwitchyardNetworkError,
  SwitchyardTimeoutError
} from "@switchyard/sdk";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface RuntimeApp {
  close(): Promise<void>;
}

interface SwitchyardClientLike {
  doctor(): Promise<unknown>;
  checkRuntimeMode(runtimeModeId: string): Promise<unknown>;
  createRun(payload: Record<string, unknown>, options?: { wait?: boolean }): Promise<{ run: { id: string; status: string } }>;
  getRun(runId: string): Promise<{ run: unknown; events: unknown[] }>;
  listRunEvents(runId: string, options?: { live?: boolean; stopAfter?: number }): Promise<unknown[]>;
  listRunArtifacts(runId: string): Promise<{ artifacts: Array<{ id: string } & Record<string, unknown>> }>;
  getArtifactContent(artifactId: string): Promise<{ contentType: string; text(): string }>;
}

export interface CliDependencies extends CliIO {
  createClient: (baseUrl: string) => SwitchyardClientLike;
  generateMatrix: () => Promise<unknown>;
  renderOpenApi: () => string;
  startDaemon: (options: DaemonStartOptions) => Promise<RuntimeApp>;
  waitForDaemonReady: (baseUrl: string, timeoutMs: number) => Promise<void>;
  waitForStop: () => Promise<void>;
}

interface DaemonStartOptions {
  host: string;
  port: number;
  dataDir?: string;
  artifactDir?: string;
}

class CliUsageError extends Error {}

export async function runCli(argv: string[], deps: CliDependencies = defaultDeps()): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
    deps.stdout(`${usage()}\n`);
    return 0;
  }

  const baseUrl = readOption(argv, "--base-url") ?? process.env["SWITCHYARD_BASE_URL"] ?? "http://127.0.0.1:4545";
  const [group, action, third] = argv;

  try {
    if (group === "doctor") {
      return await runDoctorCommand(argv, baseUrl, deps);
    }

    if (group === "daemon" && action === "start") {
      return await runDaemonStartCommand(argv, deps);
    }

    if (group === "run" && action === "fake") {
      return await runFakeCommand(argv, baseUrl, deps);
    }

    if ((group === "runtime" || group === "runtimes") && action === "test") {
      const matrix = await deps.generateMatrix();
      deps.stdout(`${JSON.stringify(matrix, null, 2)}\n`);
      return 0;
    }

    if (group === "debug" && action === "run") {
      if (!third) {
        throw new CliUsageError("debug run requires <run-id>");
      }
      return await runDebugCommand(third, argv, baseUrl, deps);
    }

    if (group === "contract" && action === "export") {
      const rendered = deps.renderOpenApi();
      const outputPath = readOption(argv, "--output");
      if (outputPath) {
        const absolute = resolve(process.cwd(), outputPath);
        writeFileSync(absolute, rendered, "utf8");
        deps.stdout(`${absolute}\n`);
      } else {
        deps.stdout(rendered);
      }
      return 0;
    }

    deps.stderr(`${usage()}\n`);
    return 2;
  } catch (error) {
    if (error instanceof CliUsageError) {
      deps.stderr(`${error.message}\n`);
      return 2;
    }
    emitCommandError(error, deps);
    return 1;
  }
}

async function runDoctorCommand(argv: string[], baseUrl: string, deps: CliDependencies): Promise<number> {
  const client = deps.createClient(baseUrl);
  const doctor = await client.doctor();
  const asHuman = argv.includes("--human");
  const activeFakeCheck = argv.includes("--active-fake-check")
    ? await client.checkRuntimeMode("fake.deterministic")
    : undefined;

  if (asHuman) {
    const summary = (doctor as { summary?: Record<string, number> }).summary ?? {};
    const lines = [
      "Doctor summary",
      `available=${summary["available"] ?? 0} partial=${summary["partial"] ?? 0} unavailable=${summary["unavailable"] ?? 0}`
    ];
    if (activeFakeCheck) {
      const check = activeFakeCheck as { canRun?: boolean; state?: string };
      lines.push(`fake.deterministic: canRun=${check.canRun === true ? "yes" : "no"} state=${check.state ?? "unknown"}`);
    }
    deps.stdout(`${lines.join("\n")}\n`);
    return 0;
  }

  deps.stdout(
    `${JSON.stringify({
      doctor,
      ...(activeFakeCheck ? { activeFakeCheck } : {})
    }, null, 2)}\n`
  );
  return 0;
}

async function runDaemonStartCommand(argv: string[], deps: CliDependencies): Promise<number> {
  const host = readOption(argv, "--host") ?? process.env["SWITCHYARD_HOST"] ?? "127.0.0.1";
  const port = parsePositiveInteger(readOption(argv, "--port") ?? process.env["SWITCHYARD_PORT"] ?? "4545", "port");
  const readyTimeoutMs = parsePositiveInteger(readOption(argv, "--ready-timeout-ms") ?? "5000", "ready-timeout-ms");
  const dataDir = readOption(argv, "--data-dir");
  const artifactDir = readOption(argv, "--artifact-dir");
  const foreground = argv.includes("--foreground");
  const baseUrl = `http://${host}:${port}`;

  const app = await deps.startDaemon({
    host,
    port,
    ...(dataDir ? { dataDir } : {}),
    ...(artifactDir ? { artifactDir } : {})
  });

  try {
    await deps.waitForDaemonReady(baseUrl, readyTimeoutMs);
    if (!foreground) {
      return 0;
    }
    await deps.waitForStop();
    await app.close();
    return 0;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

async function runFakeCommand(argv: string[], baseUrl: string, deps: CliDependencies): Promise<number> {
  const wait = argv.includes("--wait");
  const cwd = readOption(argv, "--cwd") ?? process.cwd();
  const task = readOption(argv, "--task") ?? "CLI fake run";
  const timeoutRaw = readOption(argv, "--timeout-seconds") ?? "600";
  const timeoutSeconds = parsePositiveInteger(timeoutRaw, "timeout-seconds");

  const created = await deps.createClient(baseUrl).createRun(
    {
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd,
      task,
      timeoutSeconds
    },
    { wait }
  );
  deps.stdout(`${JSON.stringify({ runId: created.run.id, status: created.run.status }, null, 2)}\n`);
  return 0;
}

async function runDebugCommand(runId: string, argv: string[], baseUrl: string, deps: CliDependencies): Promise<number> {
  const includeArtifactContent = argv.includes("--include-artifact-content");
  const live = argv.includes("--live");
  const client = deps.createClient(baseUrl);

  const runResponse = await client.getRun(runId);
  const events = live
    ? await client.listRunEvents(runId, { live: true, stopAfter: 1 })
    : runResponse.events;
  const artifacts = await client.listRunArtifacts(runId);

  const artifactContents = includeArtifactContent
    ? await Promise.all(
      artifacts.artifacts.map(async (artifact) => {
        const content = await client.getArtifactContent(artifact.id);
        return {
          artifactId: artifact.id,
          contentType: content.contentType,
          text: content.text()
        };
      })
    )
    : undefined;

  deps.stdout(
    `${JSON.stringify(
      {
        run: runResponse.run,
        events,
        artifacts: artifacts.artifacts,
        ...(artifactContents ? { artifactContents } : {})
      },
      null,
      2
    )}\n`
  );
  return 0;
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`--${field} must be a positive integer`);
  }
  return parsed;
}

function emitCommandError(error: unknown, deps: CliIO): void {
  if (error instanceof SwitchyardHttpError) {
    deps.stderr(
      JSON.stringify(
        {
          errorClass: error.name,
          status: error.status,
          code: error.code,
          message: error.message,
          requestId: error.requestId ?? null
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (error instanceof SwitchyardNetworkError || error instanceof SwitchyardTimeoutError || error instanceof SwitchyardDecodeError) {
    deps.stderr(
      JSON.stringify(
        {
          errorClass: error.name,
          message: error.message
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined;
  deps.stderr(JSON.stringify({ errorClass: "Error", message, ...(code ? { code } : {}) }, null, 2) + "\n");
}

function readOption(argv: string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function usage(): string {
  return [
    "Usage: switchyard <command>",
    "",
    "Commands:",
    "  doctor [--base-url <url>] [--json|--human] [--active-fake-check]",
    "  daemon start [--host <host>] [--port <port>] [--data-dir <path>] [--artifact-dir <path>] [--foreground] [--ready-timeout-ms <ms>]",
    "  run fake [--base-url <url>] [--cwd <path>] [--task <text>] [--timeout-seconds <n>] [--wait]",
    "  runtime test",
    "  runtimes test",
    "  debug run <run-id> [--base-url <url>] [--include-artifact-content] [--live]",
    "  contract export [--output <path>]"
  ].join("\n");
}

function defaultDeps(): CliDependencies {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    createClient: (baseUrl) => new SwitchyardClient({ baseUrl }),
    generateMatrix: async () => await generateCompatibilityMatrix(),
    renderOpenApi: () => renderOpenApiJson(generateOpenApiDocument()),
    startDaemon: async (options) => await startDaemonApp(options),
    waitForDaemonReady: async (baseUrl, timeoutMs) => {
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
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`daemon readiness timeout after ${timeoutMs}ms`);
    },
    waitForStop: async () => {
      await new Promise<void>((resolve) => {
        const onSigInt = () => {
          process.off("SIGTERM", onSigTerm);
          resolve();
        };
        const onSigTerm = () => {
          process.off("SIGINT", onSigInt);
          resolve();
        };
        process.once("SIGINT", onSigInt);
        process.once("SIGTERM", onSigTerm);
      });
    }
  };
}
