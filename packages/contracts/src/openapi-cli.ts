import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateOpenApiDocument, renderOpenApiJson } from "./openapi.js";

const DEFAULT_OUTPUT_PATH = resolve(process.cwd(), "openapi.local-daemon.json");

function main(argv: string[]): number {
  const [command, maybePath] = argv;
  const outputPath = maybePath ? resolve(process.cwd(), maybePath) : DEFAULT_OUTPUT_PATH;

  const rendered = renderOpenApiJson(generateOpenApiDocument());

  if (command === "generate") {
    writeFileSync(outputPath, rendered, "utf8");
    process.stdout.write(`${outputPath}\n`);
    return 0;
  }

  if (command === "check") {
    const current = readFileSync(outputPath, "utf8");
    if (current !== rendered) {
      throw new Error(`OpenAPI output drift detected at ${outputPath}. Run openapi:generate.`);
    }
    process.stdout.write("openapi:check OK\n");
    return 0;
  }

  throw new Error("usage: openapi-cli <generate|check> [outputPath]");
}

const exitCode = main(process.argv.slice(2));
process.exitCode = exitCode;
