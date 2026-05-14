import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexCatalogProbe, CodexModelCatalogEntry, CodexRunOptions } from "./types.js";

const execFileAsync = promisify(execFile);

type RawModelEntry = {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
  supports_reasoning_summaries?: unknown;
  support_verbosity?: unknown;
  default_verbosity?: unknown;
};

export function parseCodexModelCatalog(raw: string): CodexModelCatalogEntry[] {
  const parsed = JSON.parse(raw) as { models?: unknown };
  if (!Array.isArray(parsed.models)) {
    return [];
  }

  return parsed.models
    .filter((entry): entry is RawModelEntry => !!entry && typeof entry === "object")
    .map((entry) => {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const mapped: CodexModelCatalogEntry = {
        slug,
        supportedReasoningLevels: parseSupportedReasoningLevels(entry.supported_reasoning_levels)
      };
      if (typeof entry.display_name === "string") mapped.displayName = entry.display_name;
      if (typeof entry.description === "string") mapped.description = entry.description;
      if (typeof entry.default_reasoning_level === "string") mapped.defaultReasoningLevel = entry.default_reasoning_level;
      if (typeof entry.supports_reasoning_summaries === "boolean") {
        mapped.supportsReasoningSummaries = entry.supports_reasoning_summaries;
      }
      if (typeof entry.support_verbosity === "boolean") mapped.supportsVerbosity = entry.support_verbosity;
      if (typeof entry.default_verbosity === "string") mapped.defaultVerbosity = entry.default_verbosity;
      return mapped;
    })
    .filter((entry) => entry.slug.length > 0);
}

function parseSupportedReasoningLevels(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (!entry || typeof entry !== "object") {
        return undefined;
      }
      const effort = (entry as { effort?: unknown }).effort;
      return typeof effort === "string" ? effort : undefined;
    })
    .filter((entry): entry is string => typeof entry === "string");
}

export function validateCodexRunOptions(input: {
  model: string;
  options: CodexRunOptions;
  models: CodexModelCatalogEntry[];
}): CodexRunOptions {
  const selectedModel = input.models.find((entry) => entry.slug === input.model);
  const requestedEffort = input.options.reasoningEffort;
  if (!selectedModel || !requestedEffort) {
    return input.options;
  }

  if (!selectedModel.supportedReasoningLevels.includes(requestedEffort)) {
    throw new Error(`Reasoning effort ${requestedEffort} is not supported by Codex model ${input.model}`);
  }

  return input.options;
}

export async function probeCodexCatalog(command = "codex"): Promise<CodexCatalogProbe> {
  let version: string;
  try {
    const versionResult = await execFileAsync(command, ["--version"], { encoding: "utf8" });
    version = readStdout(versionResult).trim();
  } catch (error) {
    return {
      ok: false,
      models: [],
      message: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    const modelResult = await execFileAsync(command, ["debug", "models"], { encoding: "utf8" });
    return {
      ok: true,
      version,
      models: parseCodexModelCatalog(readStdout(modelResult))
    };
  } catch (error) {
    return {
      ok: true,
      version,
      models: [],
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function readStdout(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (result && typeof result === "object" && "stdout" in result) {
    const stdout = (result as { stdout?: unknown }).stdout;
    if (typeof stdout === "string") {
      return stdout;
    }
  }
  return "";
}
