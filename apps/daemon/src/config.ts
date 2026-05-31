import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createDisabledRealToolPolicyConfig,
  type ResolvedRealToolPolicyConfig,
  type ShellCatalogEntry
} from "@switchyard/core";

export interface DaemonConfig {
  host: string;
  port: number;
  dataDir: string;
  sqlitePath: string;
  artifactDir: string;
  deploymentMode?: "local" | "test" | "staging" | "production";
  opencode: {
    command: string;
  };
  claudeCode: {
    command: string;
    liveProbe: boolean;
    maxBudgetUsd: number;
    requestTimeoutMs: number;
  };
  acp: {
    requestTimeoutMs: number;
    cancelTimeoutMs: number;
    maxMessageBytes: number;
  };
  genericHttp: {
    baseUrl?: string;
    authToken?: string;
    requestTimeoutMs: number;
    pollIntervalMs: number;
    maxResponseBytes: number;
  };
  agentfield?: {
    baseUrl?: string;
    apiKey?: string;
    target?: string;
    requestTimeoutMs: number;
    pollIntervalMs: number;
    maxResponseBytes: number;
  };
  realTools: ResolvedRealToolPolicyConfig;
}

export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const dataDir = env["SWITCHYARD_DATA_DIR"] ?? join(process.cwd(), ".switchyard");
  const baseUrl = env["SWITCHYARD_GENERIC_HTTP_BASE_URL"]?.trim();
  const authToken = env["SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN"]?.trim();
  const agentfieldBaseUrl = env["SWITCHYARD_AGENTFIELD_BASE_URL"]?.trim();
  const agentfieldApiKey = env["SWITCHYARD_AGENTFIELD_API_KEY"]?.trim();
  const agentfieldTarget = env["SWITCHYARD_AGENTFIELD_TARGET"]?.trim();
  const opencodeCommand = env["SWITCHYARD_OPENCODE_COMMAND"]?.trim();
  const claudeCommand = env["SWITCHYARD_CLAUDE_CODE_COMMAND"]?.trim();
  const claudeLiveProbe = env["SWITCHYARD_CLAUDE_CODE_LIVE_PROBE"]?.trim() === "1";
  const claudeMaxBudgetUsd = Number(env["SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD"] ?? 0.05);
  const claudeRequestTimeoutMs = Number(env["SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS"] ?? 5000);
  const deploymentMode = parseDeploymentMode(env["SWITCHYARD_DEPLOYMENT_MODE"]);

  const realTools = loadRealToolsConfig(env);
  validateRealToolConfig(realTools, deploymentMode);

  return {
    host: env["SWITCHYARD_HOST"] ?? "127.0.0.1",
    port: Number(env["SWITCHYARD_PORT"] ?? 4545),
    dataDir,
    sqlitePath: env["SWITCHYARD_SQLITE_PATH"] ?? join(dataDir, "switchyard.sqlite"),
    artifactDir: env["SWITCHYARD_ARTIFACT_DIR"] ?? join(dataDir, "artifacts"),
    deploymentMode,
    opencode: {
      command: opencodeCommand && opencodeCommand.length > 0 ? opencodeCommand : "opencode"
    },
    claudeCode: {
      command: claudeCommand && claudeCommand.length > 0 ? claudeCommand : "claude",
      liveProbe: claudeLiveProbe,
      maxBudgetUsd: claudeMaxBudgetUsd,
      requestTimeoutMs: claudeRequestTimeoutMs
    },
    acp: {
      requestTimeoutMs: Number(env["SWITCHYARD_ACP_REQUEST_TIMEOUT_MS"] ?? 5000),
      cancelTimeoutMs: Number(env["SWITCHYARD_ACP_CANCEL_TIMEOUT_MS"] ?? 5000),
      maxMessageBytes: Number(env["SWITCHYARD_ACP_MAX_MESSAGE_BYTES"] ?? 1024 * 1024)
    },
    genericHttp: {
      ...(baseUrl && baseUrl.length > 0 ? { baseUrl } : {}),
      ...(authToken && authToken.length > 0 ? { authToken } : {}),
      requestTimeoutMs: Number(env["SWITCHYARD_GENERIC_HTTP_REQUEST_TIMEOUT_MS"] ?? 5000),
      pollIntervalMs: Number(env["SWITCHYARD_GENERIC_HTTP_POLL_INTERVAL_MS"] ?? 100),
      maxResponseBytes: Number(env["SWITCHYARD_GENERIC_HTTP_MAX_RESPONSE_BYTES"] ?? 1024 * 1024)
    },
    agentfield: {
      ...(agentfieldBaseUrl && agentfieldBaseUrl.length > 0 ? { baseUrl: agentfieldBaseUrl } : {}),
      ...(agentfieldApiKey && agentfieldApiKey.length > 0 ? { apiKey: agentfieldApiKey } : {}),
      ...(agentfieldTarget && agentfieldTarget.length > 0 ? { target: agentfieldTarget } : {}),
      requestTimeoutMs: Number(env["SWITCHYARD_AGENTFIELD_REQUEST_TIMEOUT_MS"] ?? 5000),
      pollIntervalMs: Number(env["SWITCHYARD_AGENTFIELD_POLL_INTERVAL_MS"] ?? 1000),
      maxResponseBytes: Number(env["SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES"] ?? 1024 * 1024)
    },
    realTools
  };
}

function parseDeploymentMode(value: string | undefined): "local" | "test" | "staging" | "production" {
  const normalized = value?.trim() ?? "local";
  if (normalized === "local" || normalized === "test" || normalized === "staging" || normalized === "production") {
    return normalized;
  }
  return "local";
}

function loadRealToolsConfig(env: NodeJS.ProcessEnv): ResolvedRealToolPolicyConfig {
  const config = createDisabledRealToolPolicyConfig();
  const enabled = env["SWITCHYARD_REAL_TOOLS_ENABLED"] === "1";

  const shellCatalog = loadShellCatalog(env["SWITCHYARD_SHELL_COMMAND_CATALOG_PATH"]);

  return {
    ...config,
    global: {
      ...config.global,
      enabled,
      allowedPlacements: parseCsv(env["SWITCHYARD_REAL_TOOLS_ALLOWED_PLACEMENTS"]).includes("local") ? ["local"] : ["local"],
      approvalDefault: env["SWITCHYARD_REAL_TOOLS_APPROVAL_DEFAULT"] === "allow" ? "allow" : "required",
      approvalExpiresMs: parseNumber(env["SWITCHYARD_REAL_TOOLS_APPROVAL_EXPIRES_MS"], config.global.approvalExpiresMs),
      maxConcurrentRealTools: parseNumber(env["SWITCHYARD_REAL_TOOLS_MAX_CONCURRENT"], config.global.maxConcurrentRealTools),
      maxInputBytes: parseNumber(env["SWITCHYARD_REAL_TOOLS_MAX_INPUT_BYTES"], config.global.maxInputBytes),
      maxInlineOutputBytes: parseNumber(env["SWITCHYARD_REAL_TOOLS_MAX_INLINE_OUTPUT_BYTES"], config.global.maxInlineOutputBytes),
      maxArtifactBytes: parseNumber(env["SWITCHYARD_REAL_TOOLS_MAX_ARTIFACT_BYTES"], config.global.maxArtifactBytes),
      defaultTimeoutMs: parseNumber(env["SWITCHYARD_REAL_TOOLS_DEFAULT_TIMEOUT_MS"], config.global.defaultTimeoutMs)
    },
    fetch: {
      ...config.fetch,
      enabled: env["SWITCHYARD_FETCH_TOOL_ENABLED"] === "1",
      allowedHosts: parseCsv(env["SWITCHYARD_FETCH_ALLOW_HOSTS"]),
      allowedMethods: parseCsv(env["SWITCHYARD_FETCH_ALLOW_METHODS"]).filter((value): value is "GET" | "HEAD" => value === "GET" || value === "HEAD"),
      allowedContentTypes: parseCsv(env["SWITCHYARD_FETCH_ALLOW_CONTENT_TYPES"]),
      allowedHeaders: parseCsv(env["SWITCHYARD_FETCH_ALLOW_HEADERS"]),
      maxRedirects: parseNumber(env["SWITCHYARD_FETCH_MAX_REDIRECTS"], config.fetch.maxRedirects),
      timeoutMs: parseNumber(env["SWITCHYARD_FETCH_TIMEOUT_MS"], config.fetch.timeoutMs),
      maxResponseBytes: parseNumber(env["SWITCHYARD_FETCH_MAX_RESPONSE_BYTES"], config.fetch.maxResponseBytes)
    },
    webSearch: {
      ...config.webSearch,
      enabled: env["SWITCHYARD_WEB_SEARCH_TOOL_ENABLED"] === "1",
      ...(env["SWITCHYARD_WEB_SEARCH_PROVIDER"]?.trim() ? { providerId: env["SWITCHYARD_WEB_SEARCH_PROVIDER"]?.trim() } : {}),
      ...(env["SWITCHYARD_WEB_SEARCH_BASE_URL"]?.trim() ? { baseUrl: env["SWITCHYARD_WEB_SEARCH_BASE_URL"]?.trim() } : {}),
      maxResults: parseNumber(env["SWITCHYARD_WEB_SEARCH_MAX_RESULTS"], config.webSearch.maxResults),
      timeoutMs: parseNumber(env["SWITCHYARD_WEB_SEARCH_TIMEOUT_MS"], config.webSearch.timeoutMs),
      maxResponseBytes: parseNumber(env["SWITCHYARD_WEB_SEARCH_MAX_RESPONSE_BYTES"], config.webSearch.maxResponseBytes)
    },
    github: {
      ...config.github,
      enabled: env["SWITCHYARD_GITHUB_TOOL_ENABLED"] === "1",
      ...(env["SWITCHYARD_GITHUB_TOKEN"]?.trim() ? { token: env["SWITCHYARD_GITHUB_TOKEN"]?.trim() } : {}),
      allowedRepos: parseCsv(env["SWITCHYARD_GITHUB_ALLOW_REPOS"]),
      timeoutMs: parseNumber(env["SWITCHYARD_GITHUB_TIMEOUT_MS"], config.github.timeoutMs),
      maxResponseBytes: parseNumber(env["SWITCHYARD_GITHUB_MAX_RESPONSE_BYTES"], config.github.maxResponseBytes)
    },
    repo: {
      ...config.repo,
      enabled: env["SWITCHYARD_REPO_TOOL_ENABLED"] === "1",
      gitBinary: env["SWITCHYARD_REPO_GIT_BINARY"]?.trim() || config.repo.gitBinary,
      allowedCwdPrefixes: parseCsv(env["SWITCHYARD_REPO_ALLOW_CWD_PREFIXES"]),
      maxPaths: parseNumber(env["SWITCHYARD_REPO_MAX_PATHS"], config.repo.maxPaths),
      timeoutMs: parseNumber(env["SWITCHYARD_REPO_TIMEOUT_MS"], config.repo.timeoutMs),
      maxOutputBytes: parseNumber(env["SWITCHYARD_REPO_MAX_OUTPUT_BYTES"], config.repo.maxOutputBytes)
    },
    shell: {
      ...config.shell,
      enabled: env["SWITCHYARD_SHELL_TOOL_ENABLED"] === "1",
      allowedCwdPrefixes: parseCsv(env["SWITCHYARD_SHELL_ALLOW_CWD_PREFIXES"]),
      timeoutMs: parseNumber(env["SWITCHYARD_SHELL_TIMEOUT_MS"], config.shell.timeoutMs),
      maxOutputBytes: parseNumber(env["SWITCHYARD_SHELL_MAX_OUTPUT_BYTES"], config.shell.maxOutputBytes),
      catalog: shellCatalog
    }
  };
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function loadShellCatalog(path: string | undefined): Record<string, ShellCatalogEntry> {
  if (!path || path.trim().length === 0) {
    return {};
  }
  const resolvedPath = resolve(path);
  const text = readFileSync(resolvedPath, "utf8");
  const parsed = JSON.parse(text) as { commands?: Array<Record<string, unknown>> };
  const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
  const out: Record<string, ShellCatalogEntry> = {};
  for (const command of commands) {
    const commandId = String(command["commandId"] ?? "").trim();
    if (commandId.length === 0) {
      continue;
    }
    const executablePath = String(command["executablePath"] ?? "").trim();
    if (executablePath.length === 0) {
      continue;
    }
    out[commandId] = {
      commandId,
      executablePath,
      argv: Array.isArray(command["argv"]) ? command["argv"].map((value) => String(value)) : [],
      allowedCwdPrefixes: Array.isArray(command["allowedCwdPrefixes"])
        ? command["allowedCwdPrefixes"].map((value) => String(value))
        : [],
      env: command["env"] && typeof command["env"] === "object"
        ? Object.fromEntries(Object.entries(command["env"] as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
        : {},
      maxArgs: Number(command["maxArgs"] ?? 8),
      allowWithoutApproval: command["allowWithoutApproval"] === true
    };
  }
  return out;
}

function validateRealToolConfig(config: ResolvedRealToolPolicyConfig, deploymentMode: "local" | "test" | "staging" | "production"): void {
  if (!config.global.enabled) {
    return;
  }

  if (config.global.defaultTimeoutMs > 120000) {
    throw new Error("config_invalid:SWITCHYARD_REAL_TOOLS_DEFAULT_TIMEOUT_MS");
  }

  if (deploymentMode === "staging" || deploymentMode === "production") {
    if (config.global.approvalDefault !== "required") {
      throw new Error("config_required:SWITCHYARD_REAL_TOOLS_APPROVAL_DEFAULT");
    }
    if (config.fetch.enabled && config.fetch.allowedHosts.length === 0) {
      throw new Error("config_required:SWITCHYARD_FETCH_ALLOW_HOSTS");
    }
    if (config.webSearch.enabled && (!config.webSearch.providerId || !config.webSearch.baseUrl)) {
      throw new Error("config_required:SWITCHYARD_WEB_SEARCH_PROVIDER");
    }
    if (config.github.enabled && (!config.github.token || config.github.allowedRepos.length === 0)) {
      throw new Error("config_required:SWITCHYARD_GITHUB_TOKEN");
    }
    if (config.repo.enabled && (!config.repo.gitBinary || config.repo.allowedCwdPrefixes.length === 0)) {
      throw new Error("config_required:SWITCHYARD_REPO_ALLOW_CWD_PREFIXES");
    }
    if (config.shell.enabled && (Object.keys(config.shell.catalog).length === 0 || config.shell.allowedCwdPrefixes.length === 0)) {
      throw new Error("config_required:SWITCHYARD_SHELL_COMMAND_CATALOG_PATH");
    }
  }
}
