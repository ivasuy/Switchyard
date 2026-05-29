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

export async function probeCodexCatalog(
  command = "codex",
  options: { timeoutMs?: number; maxBufferBytes?: number } = {}
): Promise<CodexCatalogProbe> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBufferBytes = options.maxBufferBytes ?? 1024 * 1024;
  const execOptions = { encoding: "utf8" as const, timeout: timeoutMs, maxBuffer: maxBufferBytes };

  let version: string;
  try {
    const versionResult = await execFileAsync(command, ["--version"], execOptions);
    version = readStdout(versionResult).trim();
  } catch (error) {
    const classified = classifyProbeError(error, maxBufferBytes, "binary_unavailable");
    const result: CodexCatalogProbe = {
      ok: false,
      models: [],
      message: classified.message,
    };
    if (classified.reasonCode) result.reasonCode = classified.reasonCode;
    if (classified.outputBytes !== undefined) result.outputBytes = classified.outputBytes;
    return result;
  }

  try {
    const modelResult = await execFileAsync(command, ["debug", "models"], execOptions);
    return {
      ok: true,
      version,
      models: parseCodexModelCatalog(readStdout(modelResult))
    };
  } catch (error) {
    const classified = classifyProbeError(error, maxBufferBytes, "model_catalog_unavailable");
    const result: CodexCatalogProbe = {
      ok: true,
      version,
      models: [],
      message: classified.message,
    };
    if (classified.reasonCode) result.reasonCode = classified.reasonCode;
    if (classified.outputBytes !== undefined) result.outputBytes = classified.outputBytes;
    return result;
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

function classifyProbeError(
  error: unknown,
  maxBufferBytes: number,
  fallbackReasonCode: "binary_unavailable" | "model_catalog_unavailable"
): { reasonCode: "binary_unavailable" | "model_catalog_unavailable" | "check_timeout" | "check_output_too_large"; message: string; outputBytes?: number } {
  const message = error instanceof Error ? error.message : String(error);
  const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : "";
  const output = `${readMaybeText(error, "stdout")}${readMaybeText(error, "stderr")}`;
  const outputBytes = output.length > 0 ? Buffer.byteLength(output, "utf8") : undefined;
  const sanitizedMessage = sanitizeMessage(message, maxBufferBytes);

  if (code === "ETIMEDOUT" || message.toLowerCase().includes("timed out")) {
    return probeError("check_timeout", sanitizedMessage, outputBytes);
  }

  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || message.toLowerCase().includes("maxbuffer")) {
    return probeError("check_output_too_large", sanitizedMessage, outputBytes);
  }

  return probeError(fallbackReasonCode, sanitizedMessage, outputBytes);
}

function sanitizeMessage(message: string, maxBytes: number): string {
  const max = Math.max(32, maxBytes);
  if (Buffer.byteLength(message, "utf8") <= max) {
    return message;
  }
  return `${message.slice(0, Math.max(1, max - 3))}...`;
}

function readMaybeText(value: unknown, key: "stdout" | "stderr"): string {
  if (!isRecord(value)) {
    return "";
  }
  const raw = value[key];
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function probeError(
  reasonCode: "binary_unavailable" | "model_catalog_unavailable" | "check_timeout" | "check_output_too_large",
  message: string,
  outputBytes: number | undefined
): { reasonCode: "binary_unavailable" | "model_catalog_unavailable" | "check_timeout" | "check_output_too_large"; message: string; outputBytes?: number } {
  if (outputBytes === undefined) {
    return { reasonCode, message };
  }
  return { reasonCode, message, outputBytes };
}
