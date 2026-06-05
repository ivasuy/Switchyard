import { dirname, normalize, resolve, sep } from "node:path";
import {
  fetchToolInputSchema,
  githubToolInputSchema,
  repoToolInputSchema,
  shellToolInputSchema,
  webSearchToolInputSchema,
  type ToolInvocation
} from "@switchyard/contracts";
import type {
  FetchToolExecutionPlan,
  GithubToolExecutionPlan,
  RepoToolExecutionPlan,
  ShellToolExecutionPlan,
  ToolPolicyDecision,
  ToolPolicyInput,
  ToolPolicyPort,
  WebSearchToolExecutionPlan
} from "../ports/policy.js";

const SECRET_KEY_PATTERN = /(token|apikey|authorization|password|secret|credential|cookie|privatekey|accesskey|refreshtoken|idtoken|signature|sig)/i;

function isSecretKey(key: string): boolean {
  if (SECRET_KEY_PATTERN.test(key)) {
    return true;
  }
  return /(^session$|(^|[_-])session([_-]|$))/i.test(key);
}

function redactSignedUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    for (const [key] of parsed.searchParams.entries()) {
      if (isSecretKey(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry)) as T;
  }
  if (typeof value === "string") {
    return redactSignedUrl(value) as T;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (key === "runtimeApprovalToken") {
        out[key] = entry;
        continue;
      }
      if (isSecretKey(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = redactSecrets(entry);
      }
    }
    return out as T;
  }
  return value;
}

export interface RealToolGlobalPolicyConfig {
  enabled: boolean;
  allowedPlacements: Array<ToolExecutionPlacement>;
  approvalDefault: "required" | "allow";
  approvalExpiresMs: number;
  maxConcurrentRealTools: number;
  maxInputBytes: number;
  maxInlineOutputBytes: number;
  maxArtifactBytes: number;
  defaultTimeoutMs: number;
}

export interface FetchToolPolicyConfig {
  enabled: boolean;
  allowedHosts: string[];
  allowedMethods: Array<"GET" | "HEAD">;
  allowedHeaders: string[];
  allowedContentTypes: string[];
  maxRedirects: number;
  timeoutMs: number;
  maxResponseBytes: number;
  allowWithoutApproval?: boolean;
}

export interface WebSearchToolPolicyConfig {
  enabled: boolean;
  providerId?: string;
  baseUrl?: string;
  maxResults: number;
  timeoutMs: number;
  maxResponseBytes: number;
  allowWithoutApproval?: boolean;
}

export interface GithubToolPolicyConfig {
  enabled: boolean;
  token?: string;
  allowedRepos: string[];
  timeoutMs: number;
  maxResponseBytes: number;
  allowWithoutApproval?: boolean;
}

export interface RepoToolPolicyConfig {
  enabled: boolean;
  gitBinary: string;
  allowedCwdPrefixes: string[];
  maxPaths: number;
  timeoutMs: number;
  maxOutputBytes: number;
  allowWithoutApproval?: boolean;
}

export interface ShellCatalogEntry {
  commandId: string;
  executablePath: string;
  argv: string[];
  allowedCwdPrefixes: string[];
  env: Record<string, string>;
  maxArgs: number;
  allowWithoutApproval?: boolean;
}

export interface ShellToolPolicyConfig {
  enabled: boolean;
  allowedCwdPrefixes: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  catalog: Record<string, ShellCatalogEntry>;
}

export type ToolExecutionPlacement = "local" | "hosted" | "connected_local_node";

export interface HostedToolPlacementPolicyConfig {
  enabled: boolean;
  allowedToolTypes: ToolInvocation["type"][];
}

export interface ConnectedLocalNodeToolPlacementPolicyConfig {
  enabled: boolean;
  allowedToolTypes: ToolInvocation["type"][];
}

export interface ResolvedRealToolPolicyConfig {
  global: RealToolGlobalPolicyConfig;
  hosted: HostedToolPlacementPolicyConfig;
  connectedLocalNode: ConnectedLocalNodeToolPlacementPolicyConfig;
  fetch: FetchToolPolicyConfig;
  webSearch: WebSearchToolPolicyConfig;
  github: GithubToolPolicyConfig;
  repo: RepoToolPolicyConfig;
  shell: ShellToolPolicyConfig;
}

export function createDisabledRealToolPolicyConfig(): ResolvedRealToolPolicyConfig {
  return {
    global: {
      enabled: false,
      allowedPlacements: ["local"],
      approvalDefault: "required",
      approvalExpiresMs: 300_000,
      maxConcurrentRealTools: 2,
      maxInputBytes: 65_536,
      maxInlineOutputBytes: 32_768,
      maxArtifactBytes: 1_048_576,
      defaultTimeoutMs: 30_000
    },
    hosted: {
      enabled: false,
      allowedToolTypes: []
    },
    connectedLocalNode: {
      enabled: false,
      allowedToolTypes: []
    },
    fetch: {
      enabled: false,
      allowedHosts: [],
      allowedMethods: ["GET", "HEAD"],
      allowedHeaders: [],
      allowedContentTypes: ["text/plain", "application/json", "text/html"],
      maxRedirects: 3,
      timeoutMs: 30_000,
      maxResponseBytes: 262_144
    },
    webSearch: {
      enabled: false,
      maxResults: 10,
      timeoutMs: 20_000,
      maxResponseBytes: 262_144
    },
    github: {
      enabled: false,
      allowedRepos: [],
      timeoutMs: 30_000,
      maxResponseBytes: 262_144
    },
    repo: {
      enabled: false,
      gitBinary: "git",
      allowedCwdPrefixes: [],
      maxPaths: 32,
      timeoutMs: 20_000,
      maxOutputBytes: 262_144
    },
    shell: {
      enabled: false,
      allowedCwdPrefixes: [],
      timeoutMs: 20_000,
      maxOutputBytes: 262_144,
      catalog: {}
    }
  };
}

function mergePolicyConfig(
  base: ResolvedRealToolPolicyConfig,
  override?: Partial<ResolvedRealToolPolicyConfig>
): ResolvedRealToolPolicyConfig {
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
    global: {
      ...base.global,
      ...(override.global ?? {})
    },
    hosted: {
      ...base.hosted,
      ...(override.hosted ?? {})
    },
    connectedLocalNode: {
      ...base.connectedLocalNode,
      ...(override.connectedLocalNode ?? {})
    },
    fetch: {
      ...base.fetch,
      ...(override.fetch ?? {})
    },
    webSearch: {
      ...base.webSearch,
      ...(override.webSearch ?? {})
    },
    github: {
      ...base.github,
      ...(override.github ?? {})
    },
    repo: {
      ...base.repo,
      ...(override.repo ?? {})
    },
    shell: {
      ...base.shell,
      ...(override.shell ?? {}),
      catalog: {
        ...base.shell.catalog,
        ...(override.shell?.catalog ?? {})
      }
    }
  };
}

export function resolveRealToolPolicyConfig(input?: {
  source?: string | Partial<ResolvedRealToolPolicyConfig>;
  placement?: ToolExecutionPlacement;
}): ResolvedRealToolPolicyConfig {
  const base = createDisabledRealToolPolicyConfig();
  if (!input?.source) {
    return base;
  }
  if (typeof input.source === "string") {
    try {
      const parsed = JSON.parse(input.source) as Partial<ResolvedRealToolPolicyConfig>;
      return mergePolicyConfig(base, parsed);
    } catch {
      throw new Error("tool_policy_config_invalid:json");
    }
  }
  return mergePolicyConfig(base, input.source);
}

function asRisk(input: Record<string, unknown>): string {
  const rawRisk = input["risk"];
  if (typeof rawRisk === "string") {
    return rawRisk;
  }
  const requiresApproval = input["requiresApproval"];
  if (requiresApproval === true) {
    return "risky";
  }
  return "safe";
}

function ensurePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`tool_policy_config_invalid:${name}`);
  }
}

function normalizePrefix(prefix: string): string {
  const resolved = resolve(prefix);
  return resolved.endsWith(sep) ? resolved : `${resolved}${sep}`;
}

function isPathWithinPrefixes(cwd: string, prefixes: string[]): boolean {
  const resolved = resolve(cwd);
  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizePrefix(prefix);
    return `${resolved}${sep}`.startsWith(normalizedPrefix) || resolved === dirname(normalizedPrefix.slice(0, -1));
  });
}

function isLikelyPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return true;
  }
  if (lower === "0.0.0.0") {
    return true;
  }
  if (/^127\./.test(lower)) {
    return true;
  }
  if (/^10\./.test(lower)) {
    return true;
  }
  if (/^192\.168\./.test(lower)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(lower)) {
    return true;
  }
  if (/^169\.254\./.test(lower)) {
    return true;
  }
  if (lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) {
    return true;
  }
  return false;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

function baseTrace(input: ToolPolicyInput): Record<string, unknown> {
  return {
    toolType: input.type,
    approvalDefault: input.runApprovalPolicy ?? "default"
  };
}

function deny(input: ToolPolicyInput, reasonCode: string, extra: Record<string, unknown> = {}): ToolPolicyDecision {
  return {
    decision: "deny",
    reasonCode,
    policyTrace: [redactSecrets({ rule: "deny", reasonCode, ...baseTrace(input), ...extra })]
  };
}

function makeApprovalDecision(
  input: ToolPolicyInput,
  reasonCode: string,
  plan: FetchToolExecutionPlan | WebSearchToolExecutionPlan | GithubToolExecutionPlan | RepoToolExecutionPlan | ShellToolExecutionPlan,
  approvalType: "before_external_web_action" | "before_local_process_execution",
  expiresAt: string
): ToolPolicyDecision {
  return {
    decision: "approval_required",
    reasonCode,
    approvalType,
    expiresAt,
    executionPlan: plan,
    policyTrace: [redactSecrets({
      rule: "approval_required",
      reasonCode,
      toolType: input.type,
      operation: (plan as { operation?: string }).operation,
      commandId: (plan as { commandId?: string }).commandId,
      approvalDefault: "required"
    })]
  };
}

function makeAllowDecision(
  input: ToolPolicyInput,
  reasonCode: string,
  plan: FetchToolExecutionPlan | WebSearchToolExecutionPlan | GithubToolExecutionPlan | RepoToolExecutionPlan | ShellToolExecutionPlan
): ToolPolicyDecision {
  return {
    decision: "allow",
    reasonCode,
    executionPlan: plan,
    policyTrace: [redactSecrets({
      rule: "allow",
      reasonCode,
      toolType: input.type,
      operation: (plan as { operation?: string }).operation,
      commandId: (plan as { commandId?: string }).commandId,
      approvalDefault: "allow"
    })]
  };
}

function validateConfig(config: ResolvedRealToolPolicyConfig): void {
  ensurePositive("global.approvalExpiresMs", config.global.approvalExpiresMs);
  ensurePositive("global.maxConcurrentRealTools", config.global.maxConcurrentRealTools);
  ensurePositive("global.maxInputBytes", config.global.maxInputBytes);
  ensurePositive("global.maxInlineOutputBytes", config.global.maxInlineOutputBytes);
  ensurePositive("global.maxArtifactBytes", config.global.maxArtifactBytes);
  ensurePositive("global.defaultTimeoutMs", config.global.defaultTimeoutMs);
  if (config.global.defaultTimeoutMs > 120_000) {
    throw new Error("tool_policy_config_invalid:global.defaultTimeoutMs");
  }
  if (config.global.allowedPlacements.length === 0) {
    throw new Error("tool_policy_config_invalid:global.allowedPlacements");
  }
  for (const placement of config.global.allowedPlacements) {
    if (placement !== "local" && placement !== "hosted" && placement !== "connected_local_node") {
      throw new Error("tool_policy_config_invalid:global.allowedPlacements");
    }
  }
  for (const entry of Object.values(config.shell.catalog)) {
    if (!/^([A-Za-z]:[\\/]|\/)/.test(entry.executablePath)) {
      throw new Error("tool_policy_config_invalid:shell.catalog.executablePath");
    }
  }
}

export class LocalPolicyGate implements ToolPolicyPort {
  private readonly config: ResolvedRealToolPolicyConfig;

  constructor(config: ResolvedRealToolPolicyConfig = createDisabledRealToolPolicyConfig()) {
    validateConfig(config);
    this.config = config;
  }

  getRealToolLimits(): { maxConcurrentRealTools: number; maxInputBytes: number } {
    return {
      maxConcurrentRealTools: this.config.global.maxConcurrentRealTools,
      maxInputBytes: this.config.global.maxInputBytes
    };
  }

  async decideTool(input: ToolPolicyInput): Promise<ToolPolicyDecision> {
    const placement = this.resolvePlacement(input);

    if (input.type === "browser") {
      return deny(input, "browser_tool_unshipped", { rule: "browser_tool_unshipped", placement });
    }

    if (input.type === "fake_echo") {
      return this.decideFakeEcho(input);
    }

    if (placement === "hosted" && !this.config.hosted.enabled) {
      return deny(input, "tool_hosted_tools_disabled", { rule: "placement_disabled", placement });
    }
    if (placement === "connected_local_node" && !this.config.connectedLocalNode.enabled) {
      return deny(input, "tool_connected_node_tools_disabled", { rule: "placement_disabled", placement });
    }
    if (placement === "hosted" && input.type === "repo") {
      return deny(input, "repo_hosted_unshipped", { rule: "repo_hosted_unshipped" });
    }
    if (!this.isPlacementToolAllowed(placement, input.type)) {
      return deny(input, "tool_policy_denied", { rule: "placement_tool_not_allowed", placement });
    }

    if (!this.config.global.enabled) {
      if (placement === "local") {
        return deny(input, "tool_real_tools_disabled", { rule: "real_tools_disabled", placement });
      }
      return deny(input, "tool_policy_denied", { rule: "real_tools_disabled", placement });
    }

    switch (input.type) {
      case "fetch":
        return this.decideFetch(input);
      case "web_search":
        return this.decideWebSearch(input);
      case "github":
        return this.decideGithub(input);
      case "repo":
        return this.decideRepo(input);
      case "shell":
        return this.decideShell(input);
      default:
        return deny(input, "tool_policy_denied");
    }
  }

  private decideFakeEcho(input: ToolPolicyInput): ToolPolicyDecision {
    const risk = asRisk(input.input);
    const trace = redactSecrets({ rule: "safe_fake_echo", ...baseTrace(input), risk });
    if (risk === "risky" || risk === "destructive") {
      if (input.runApprovalPolicy === "deny") {
        return {
          decision: "deny",
          reasonCode: "tool_policy_denied",
          policyTrace: [redactSecrets({ rule: "approval_policy_deny", ...baseTrace(input), risk })]
        };
      }
      return {
        decision: "approval_required",
        reasonCode: "approval_required",
        approvalType: "before_external_web_action",
        expiresAt: new Date(Date.now() + this.config.global.approvalExpiresMs).toISOString(),
        executionPlan: {
          type: "fetch",
          method: "GET",
          url: "https://example.invalid/fake_echo",
          allowedHosts: [],
          allowedHeaders: [],
          maxRedirects: 0,
          allowedContentTypes: [],
          captureContent: false,
          timeoutMs: 1,
          maxResponseBytes: 1,
          maxInlineOutputBytes: 1,
          maxArtifactBytes: 1
        },
        policyTrace: [redactSecrets({ rule: "requires_manual_approval", ...baseTrace(input), risk })]
      };
    }
    return {
      decision: "allow",
      reasonCode: "allow",
      executionPlan: {
        type: "fetch",
        method: "GET",
        url: "https://example.invalid/fake_echo",
        allowedHosts: [],
        allowedHeaders: [],
        maxRedirects: 0,
        allowedContentTypes: [],
        captureContent: false,
        timeoutMs: 1,
        maxResponseBytes: 1,
        maxInlineOutputBytes: 1,
        maxArtifactBytes: 1
      },
      policyTrace: [trace]
    };
  }

  private decideFetch(input: ToolPolicyInput): ToolPolicyDecision {
    if (!this.config.fetch.enabled) {
      return deny(input, "tool_policy_denied", { rule: "tool_disabled" });
    }
    const parsed = fetchToolInputSchema.safeParse(input.input);
    if (!parsed.success) {
      return deny(input, "fetch_input_invalid", { rule: "input_invalid" });
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(parsed.data.url);
    } catch {
      return deny(input, "fetch_url_invalid");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return deny(input, "fetch_url_invalid", { rule: "protocol_denied" });
    }
    const host = normalizeHost(parsedUrl.hostname);
    if (isLikelyPrivateHost(host)) {
      return deny(input, "fetch_private_network_denied", { rule: "private_host_denied" });
    }
    const hostAllowed = this.config.fetch.allowedHosts.map(normalizeHost).includes(host);
    if (!hostAllowed) {
      return deny(input, "fetch_host_not_allowlisted", { hostAllowed });
    }
    if (!this.config.fetch.allowedMethods.includes(parsed.data.method)) {
      return deny(input, "fetch_method_denied");
    }

    const plan: FetchToolExecutionPlan = {
      type: "fetch",
      method: parsed.data.method,
      url: parsedUrl.toString(),
      allowedHosts: [...this.config.fetch.allowedHosts],
      allowedHeaders: [...this.config.fetch.allowedHeaders],
      maxRedirects: this.config.fetch.maxRedirects,
      allowedContentTypes: [...this.config.fetch.allowedContentTypes],
      captureContent: parsed.data.captureContent ?? false,
      timeoutMs: Math.min(this.config.fetch.timeoutMs, 120_000),
      maxResponseBytes: this.config.fetch.maxResponseBytes,
      maxInlineOutputBytes: this.config.global.maxInlineOutputBytes,
      maxArtifactBytes: this.config.global.maxArtifactBytes
    };

    if (this.config.global.approvalDefault === "allow" && this.config.fetch.allowWithoutApproval) {
      return makeAllowDecision(input, "allow", plan);
    }
    return makeApprovalDecision(
      input,
      "tool_approval_required",
      plan,
      "before_external_web_action",
      new Date(Date.now() + this.config.global.approvalExpiresMs).toISOString()
    );
  }

  private decideWebSearch(input: ToolPolicyInput): ToolPolicyDecision {
    if (!this.config.webSearch.enabled) {
      return deny(input, "tool_policy_denied", { rule: "tool_disabled" });
    }
    const parsed = webSearchToolInputSchema.safeParse(input.input);
    if (!parsed.success) {
      return deny(input, "web_search_query_invalid");
    }
    if (!this.config.webSearch.providerId || !this.config.webSearch.baseUrl) {
      return deny(input, "web_search_provider_unconfigured");
    }
    if (parsed.data.maxResults && parsed.data.maxResults > this.config.webSearch.maxResults) {
      return deny(input, "web_search_query_invalid");
    }
    const plan: WebSearchToolExecutionPlan = {
      type: "web_search",
      providerId: this.config.webSearch.providerId,
      baseUrl: this.config.webSearch.baseUrl,
      query: parsed.data.query,
      maxResults: parsed.data.maxResults ?? this.config.webSearch.maxResults,
      timeoutMs: Math.min(this.config.webSearch.timeoutMs, 120_000),
      maxResponseBytes: this.config.webSearch.maxResponseBytes,
      maxInlineOutputBytes: this.config.global.maxInlineOutputBytes,
      maxArtifactBytes: this.config.global.maxArtifactBytes
    };
    if (this.config.global.approvalDefault === "allow" && this.config.webSearch.allowWithoutApproval) {
      return makeAllowDecision(input, "allow", plan);
    }
    return makeApprovalDecision(
      input,
      "tool_approval_required",
      plan,
      "before_external_web_action",
      new Date(Date.now() + this.config.global.approvalExpiresMs).toISOString()
    );
  }

  private decideGithub(input: ToolPolicyInput): ToolPolicyDecision {
    if (!this.config.github.enabled) {
      return deny(input, "tool_policy_denied", { rule: "tool_disabled" });
    }
    const parsed = githubToolInputSchema.safeParse(input.input);
    if (!parsed.success) {
      return deny(input, "github_operation_denied");
    }
    if (!this.config.github.token) {
      return deny(input, "github_token_missing");
    }
    const repoKey = `${parsed.data.owner}/${parsed.data.repo}`.toLowerCase();
    const repoAllowed = this.config.github.allowedRepos.map((repo) => repo.toLowerCase()).includes(repoKey);
    if (!repoAllowed) {
      return deny(input, "github_repo_not_allowlisted", { repoAllowed });
    }
    const plan: GithubToolExecutionPlan = {
      type: "github",
      operation: parsed.data.operation,
      owner: parsed.data.owner,
      repo: parsed.data.repo,
      ...(parsed.data.number !== undefined ? { number: parsed.data.number } : {}),
      ...(parsed.data.ref !== undefined ? { ref: parsed.data.ref } : {}),
      ...(parsed.data.base !== undefined ? { base: parsed.data.base } : {}),
      ...(parsed.data.head !== undefined ? { head: parsed.data.head } : {}),
      ...(parsed.data.path !== undefined ? { path: parsed.data.path } : {}),
      timeoutMs: Math.min(this.config.github.timeoutMs, 120_000),
      maxResponseBytes: this.config.github.maxResponseBytes,
      maxInlineOutputBytes: this.config.global.maxInlineOutputBytes,
      maxArtifactBytes: this.config.global.maxArtifactBytes
    };
    if (this.config.global.approvalDefault === "allow" && this.config.github.allowWithoutApproval) {
      return makeAllowDecision(input, "allow", plan);
    }
    return makeApprovalDecision(
      input,
      "tool_approval_required",
      plan,
      "before_external_web_action",
      new Date(Date.now() + this.config.global.approvalExpiresMs).toISOString()
    );
  }

  private decideRepo(input: ToolPolicyInput): ToolPolicyDecision {
    if (!this.config.repo.enabled) {
      return deny(input, "tool_policy_denied", { rule: "tool_disabled" });
    }
    const parsed = repoToolInputSchema.safeParse(input.input);
    if (!parsed.success) {
      return deny(input, "repo_operation_denied");
    }
    const cwdAllowed = isPathWithinPrefixes(parsed.data.cwd, this.config.repo.allowedCwdPrefixes);
    if (!cwdAllowed) {
      return deny(input, "repo_cwd_denied", { cwdAllowed });
    }
    const pathspec = (parsed.data.pathspec ?? []).map((entry) => normalize(entry));
    if (pathspec.length > this.config.repo.maxPaths || pathspec.some((entry) => entry.startsWith(".."))) {
      return deny(input, "repo_pathspec_invalid", { rule: "pathspec_denied" });
    }
    const argv = buildRepoArgv(parsed.data.operation, pathspec);
    const plan: RepoToolExecutionPlan = {
      type: "repo",
      operation: parsed.data.operation,
      cwd: resolve(parsed.data.cwd),
      cwdPolicySummary: summarizePrefix(parsed.data.cwd, this.config.repo.allowedCwdPrefixes),
      gitBinary: this.config.repo.gitBinary,
      argv,
      pathspec,
      timeoutMs: Math.min(this.config.repo.timeoutMs, 120_000),
      maxOutputBytes: this.config.repo.maxOutputBytes,
      maxInlineOutputBytes: this.config.global.maxInlineOutputBytes,
      maxArtifactBytes: this.config.global.maxArtifactBytes
    };
    if (this.config.global.approvalDefault === "allow" && this.config.repo.allowWithoutApproval) {
      return makeAllowDecision(input, "allow", plan);
    }
    return makeApprovalDecision(
      input,
      "tool_approval_required",
      plan,
      "before_local_process_execution",
      new Date(Date.now() + this.config.global.approvalExpiresMs).toISOString()
    );
  }

  private decideShell(input: ToolPolicyInput): ToolPolicyDecision {
    if (!this.config.shell.enabled) {
      return deny(input, "tool_policy_denied", { rule: "tool_disabled" });
    }
    if (
      "command" in input.input ||
      "executable" in input.input ||
      "executablePath" in input.input ||
      "shell" in input.input ||
      "pty" in input.input ||
      "terminal" in input.input ||
      "env" in input.input ||
      "process" in input.input
    ) {
      return deny(input, "shell_command_denied");
    }
    const parsed = shellToolInputSchema.safeParse(input.input);
    if (!parsed.success) {
      return deny(input, "shell_command_not_configured");
    }
    const entry = this.config.shell.catalog[parsed.data.commandId];
    if (!entry) {
      return deny(input, "shell_command_not_configured", { commandId: parsed.data.commandId });
    }
    const combinedPrefixes = [...new Set([...this.config.shell.allowedCwdPrefixes, ...entry.allowedCwdPrefixes])];
    const cwdAllowed = isPathWithinPrefixes(parsed.data.cwd, combinedPrefixes);
    if (!cwdAllowed) {
      return deny(input, "repo_cwd_denied", { cwdAllowed, commandId: parsed.data.commandId });
    }
    const userArgs = parsed.data.args ?? [];
    if (userArgs.length > entry.maxArgs) {
      return deny(input, "shell_command_denied", { commandId: parsed.data.commandId });
    }
    const argv = [...entry.argv, ...userArgs];
    const plan: ShellToolExecutionPlan = {
      type: "shell",
      commandId: entry.commandId,
      executablePath: entry.executablePath,
      argv,
      cwd: resolve(parsed.data.cwd),
      cwdPolicySummary: summarizePrefix(parsed.data.cwd, combinedPrefixes),
      env: redactSecrets(entry.env),
      timeoutMs: Math.min(this.config.shell.timeoutMs, 120_000),
      maxOutputBytes: this.config.shell.maxOutputBytes,
      maxInlineOutputBytes: this.config.global.maxInlineOutputBytes,
      maxArtifactBytes: this.config.global.maxArtifactBytes
    };
    const allowWithoutApproval = this.config.global.approvalDefault === "allow"
      && (entry.allowWithoutApproval ?? false);
    if (allowWithoutApproval) {
      return makeAllowDecision(input, "allow", plan);
    }
    return makeApprovalDecision(
      input,
      "tool_approval_required",
      plan,
      "before_local_process_execution",
      new Date(Date.now() + this.config.global.approvalExpiresMs).toISOString()
    );
  }

  private resolvePlacement(input: ToolPolicyInput): ToolExecutionPlacement {
    const raw = (input as ToolPolicyInput & { placement?: unknown }).placement;
    if (raw === "hosted" || raw === "connected_local_node" || raw === "local") {
      return raw;
    }
    return "local";
  }

  private isPlacementToolAllowed(placement: ToolExecutionPlacement, toolType: ToolInvocation["type"]): boolean {
    if (toolType === "fake_echo") {
      return true;
    }
    if (placement === "local") {
      return true;
    }
    const allowed = placement === "hosted"
      ? this.config.hosted.allowedToolTypes
      : this.config.connectedLocalNode.allowedToolTypes;
    return allowed.includes(toolType);
  }
}

function summarizePrefix(cwd: string, prefixes: string[]): string {
  const resolved = resolve(cwd);
  for (const prefix of prefixes) {
    const normalizedPrefix = normalizePrefix(prefix);
    if (`${resolved}${sep}`.startsWith(normalizedPrefix) || resolved === dirname(normalizedPrefix.slice(0, -1))) {
      return prefix;
    }
  }
  return "[none]";
}

function buildRepoArgv(operation: RepoToolExecutionPlan["operation"], pathspec: string[]): string[] {
  switch (operation) {
    case "status":
      return ["status", "--short", "--branch"];
    case "diff":
      return pathspec.length > 0 ? ["diff", "--", ...pathspec] : ["diff"];
    case "show":
      return pathspec.length > 0 ? ["show", "--", ...pathspec] : ["show", "--stat", "--no-patch"];
    case "ls_files":
      return pathspec.length > 0 ? ["ls-files", "--", ...pathspec] : ["ls-files"];
    case "grep":
      return pathspec.length > 0 ? ["grep", "-n", "--", ...pathspec] : ["grep", "-n", "."];
    default:
      return ["status"];
  }
}
