import type { RuntimeLogger } from "@switchyard/core";

type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

export function createConsoleLogger(level = process.env["SWITCHYARD_LOG_LEVEL"] ?? "info"): RuntimeLogger {
  const configuredLevel = toLogLevel(level);

  return {
    info: (event, details) => write(configuredLevel, "info", event, details),
    warn: (event, details) => write(configuredLevel, "warn", event, details),
    error: (event, details) => write(configuredLevel, "error", event, details)
  };
}

function write(configuredLevel: LogLevel, level: Exclude<LogLevel, "debug" | "silent">, event: string, details?: Record<string, unknown>): void {
  if (levelRank[level] < levelRank[configuredLevel]) {
    return;
  }

  const suffix = details ? ` ${formatDetails(details)}` : "";
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${event}${suffix}`;
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

function formatDetails(details: Record<string, unknown>): string {
  return Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return JSON.stringify(normalized.length > 160 ? `${normalized.slice(0, 159)}...` : normalized);
  }
  return JSON.stringify(value);
}

function toLogLevel(value: string): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error" || value === "silent") {
    return value;
  }
  return "info";
}
