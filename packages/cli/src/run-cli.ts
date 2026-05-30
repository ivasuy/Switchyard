import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateCompatibilityMatrix } from "@switchyard/adapters";
import { generateOpenApiDocument, renderOpenApiJson } from "@switchyard/contracts";
import { startDaemon } from "@switchyard/daemon";
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
  createRun(payload: Record<string, unknown>, options?: { wait?: boolean }): Promise<{ run: { id: string; status: string } }>;
  getRun(runId: string): Promise<{ run: unknown; events: unknown[] }>;
  listRunArtifacts(runId: string): Promise<{ artifacts: unknown[] }>;
}

export interface CliDependencies extends CliIO {
  createClient: (baseUrl: string) => SwitchyardClientLike;
  generateMatrix: () => Promise<unknown>;
  renderOpenApi: () => string;
  startDaemon: () => Promise<RuntimeApp>;
  waitForStop: () => Promise<void>;
}

export async function runCli(argv: string[], deps: CliDependencies = defaultDeps()): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
    deps.stdout(`${usage()}\n`);
    return 0;
  }

  const baseUrl = readOption(argv, "--base-url") ?? process.env["SWITCHYARD_BASE_URL"] ?? "http://127.0.0.1:4545";
  const [group, action, third] = argv;

  try {
    if (group === "doctor") {
      const doctor = await deps.createClient(baseUrl).doctor();
      if (argv.includes("--human")) {
        const summary = (doctor as { summary?: Record<string, number> }).summary ?? {};
        deps.stdout(`doctor: available=${summary["available"] ?? 0} partial=${summary["partial"] ?? 0} unavailable=${summary["unavailable"] ?? 0}\n`);
      } else {
        deps.stdout(`${JSON.stringify(doctor, null, 2)}\n`);
      }
      return 0;
    }

    if (group === "daemon" && action === "start") {
      const app = await deps.startDaemon();
      await deps.waitForStop();
      await app.close();
      return 0;
    }

    if (group === "run" && action === "fake") {
      const wait = argv.includes("--wait");
      const created = await deps.createClient(baseUrl).createRun(
        {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: process.cwd(),
          task: "CLI fake run"
        },
        { wait }
      );
      deps.stdout(`${JSON.stringify({ runId: created.run.id, status: created.run.status }, null, 2)}\n`);
      return 0;
    }

    if (group === "runtime" && action === "test") {
      const matrix = await deps.generateMatrix();
      deps.stdout(`${JSON.stringify(matrix, null, 2)}\n`);
      return 0;
    }

    if (group === "debug" && action === "run") {
      if (!third) {
        deps.stderr("debug run requires <run-id>\n");
        return 2;
      }
      const client = deps.createClient(baseUrl);
      const run = await client.getRun(third);
      const artifacts = await client.listRunArtifacts(third);
      deps.stdout(`${JSON.stringify({ run: run.run, events: run.events, artifacts: artifacts.artifacts }, null, 2)}\n`);
      return 0;
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
    emitCommandError(error, deps);
    return 1;
  }
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
  deps.stderr(JSON.stringify({ errorClass: "Error", message }, null, 2) + "\n");
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
    "  doctor [--base-url <url>] [--human]",
    "  daemon start",
    "  run fake [--base-url <url>] [--wait]",
    "  runtime test",
    "  debug run <run-id> [--base-url <url>]",
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
    startDaemon,
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
