import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { generateOpenApiDocument, renderOpenApiJson, type OpenApiSurface } from "./openapi.js";

const USAGE = "usage: openapi-cli <generate|check> [--surface <local_daemon|hosted_server>] [outputPath]";

const DEFAULT_ARTIFACT_BY_SURFACE: Record<OpenApiSurface, string> = {
  local_daemon: "openapi.local-daemon.json",
  hosted_server: "openapi.hosted-server.json"
};

const GENERATE_SCRIPT_BY_SURFACE: Record<OpenApiSurface, string> = {
  local_daemon: "openapi:generate",
  hosted_server: "openapi:generate:hosted"
};

export interface OpenApiCliIO {
  cwd: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
}

interface ParsedCliArgs {
  command: "generate" | "check";
  surface: OpenApiSurface;
  outputPath: string;
}

const DEFAULT_IO: OpenApiCliIO = {
  cwd: () => process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, contents) => writeFileSync(path, contents, "utf8")
};

export async function runOpenApiCli(argv: readonly string[], io: OpenApiCliIO = DEFAULT_IO): Promise<number> {
  try {
    const parsed = parseArgs(argv, io.cwd());
    const rendered = renderOpenApiJson(generateOpenApiDocument({ surface: parsed.surface }));

    if (parsed.command === "generate") {
      io.writeFile(parsed.outputPath, rendered);
      io.stdout(`${parsed.outputPath}\n`);
      return 0;
    }

    const current = io.readFile(parsed.outputPath);
    if (current !== rendered) {
      const artifact = basename(parsed.outputPath);
      const script = GENERATE_SCRIPT_BY_SURFACE[parsed.surface];
      throw new Error(`OpenAPI artifact drift for ${artifact}; run ${script} to regenerate.`);
    }

    io.stdout("openapi:check OK\n");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${message}\n`);
    return 1;
  }
}

function parseArgs(argv: readonly string[], cwd: string): ParsedCliArgs {
  const [rawCommand, ...rest] = argv;
  if (rawCommand !== "generate" && rawCommand !== "check") {
    throw new Error(USAGE);
  }

  let surface: OpenApiSurface = "local_daemon";
  let outputPathArg: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) {
      continue;
    }

    if (token === "--surface") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error(USAGE);
      }
      surface = parseSurface(value);
      index += 1;
      continue;
    }

    if (token.startsWith("--surface=")) {
      surface = parseSurface(token.slice("--surface=".length));
      continue;
    }

    if (token.startsWith("-")) {
      throw new Error(USAGE);
    }

    if (outputPathArg) {
      throw new Error(USAGE);
    }
    outputPathArg = token;
  }

  const outputPath = outputPathArg
    ? resolve(cwd, outputPathArg)
    : resolve(cwd, DEFAULT_ARTIFACT_BY_SURFACE[surface]);

  return {
    command: rawCommand,
    surface,
    outputPath
  };
}

function parseSurface(surface: string): OpenApiSurface {
  if (surface === "local_daemon" || surface === "hosted_server") {
    return surface;
  }
  throw new Error(`Unknown OpenAPI surface "${surface}". Expected one of: local_daemon, hosted_server.`);
}

const isMain = import.meta.url === new URL(process.argv[1] ?? "", "file://").href;
if (isMain) {
  runOpenApiCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
