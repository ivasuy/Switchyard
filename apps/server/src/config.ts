import { readFileSync } from "node:fs";
import {
  hashApiKey,
  redactSecrets,
  resolveHostedSandboxConfig,
  validateHostedRuntimeAllowlist,
  type ControlPlaneBootstrapInput,
  type HostedRealRuntimeExecution,
  type ResolvedHostedSandboxConfig
} from "@switchyard/core";
import {
  ObjectStoreConfigError,
  resolveObjectStoreConfig,
  type ResolvedObjectStoreConfig
} from "@switchyard/storage";

export type DeploymentMode = "local" | "test" | "staging" | "production";
export type ServerAuthMode = "disabled" | "api_key";
export type ControlPlaneStoreMode = "memory" | "postgres";

export interface ControlPlaneNodeTokenBindingConfig {
  token: string;
  apiKeyId: string;
}

export interface ControlPlaneBootstrapConfig {
  records: ControlPlaneBootstrapInput;
  source: "env_json" | "path";
  active: {
    accounts: number;
    tenants: number;
    projects: number;
    users: number;
    apiKeys: number;
    billingPlans: number;
  };
  nodeTokenBindings: readonly ControlPlaneNodeTokenBindingConfig[];
}

export class ConfigError extends Error {
  constructor(
    readonly code: string,
    readonly variable: string,
    readonly redactedConfig: Record<string, unknown>
  ) {
    super(code);
  }
}

export interface ServerConfig {
  host: string;
  port: number;
  deploymentMode: DeploymentMode;
  serverAuthMode: ServerAuthMode;
  apiKeyPepper?: string;
  controlPlaneBootstrapPath?: string;
  controlPlaneBootstrapJson?: string;
  controlPlaneBootstrap?: ControlPlaneBootstrapConfig;
  controlPlaneStore: ControlPlaneStoreMode;
  auditIpHashPepper?: string;
  publicMetrics: boolean;
  nodeSharedToken?: string;
  hostedRuntimeAllowlist: string[];
  hostedRealRuntimeExecution: HostedRealRuntimeExecution;
  postgresUrl?: string;
  redisUrl?: string;
  queueName?: string;
  objectStore: ResolvedObjectStoreConfig;
  sandbox: ResolvedHostedSandboxConfig;
  redactedSummary: Record<string, unknown>;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const deploymentMode = parseDeploymentMode(env["SWITCHYARD_DEPLOYMENT_MODE"]);
  const hostedRuntimeAllowlistEnv = optional(env["SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"]);
  const hostedRealRuntimeExecution = parseHostedRealRuntimeExecution(env["SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"]);
  const allowlist = parseCsv(hostedRuntimeAllowlistEnv, "fake.deterministic");
  const serverAuthMode = parseServerAuthMode(env["SWITCHYARD_SERVER_AUTH_MODE"]);
  const controlPlaneStore = parseControlPlaneStoreMode(env["SWITCHYARD_CONTROL_PLANE_STORE"]);
  const publicMetrics = parseBooleanEnv(
    env["SWITCHYARD_PUBLIC_METRICS"],
    deploymentMode === "local" || deploymentMode === "test"
  );

  const config: ServerConfig = {
    host: requiredOrDefault(env["SWITCHYARD_HOST"], "127.0.0.1"),
    port: Number(requiredOrDefault(env["SWITCHYARD_PORT"], "4646")),
    deploymentMode,
    serverAuthMode,
    controlPlaneStore,
    publicMetrics,
    hostedRuntimeAllowlist: allowlist,
    hostedRealRuntimeExecution,
    queueName: requiredOrDefault(env["SWITCHYARD_QUEUE_NAME"], "switchyard-hosted-runs"),
    objectStore: {} as ResolvedObjectStoreConfig,
    sandbox: resolveHostedSandboxConfig({ env, deploymentMode }),
    redactedSummary: {}
  };

  const nodeSharedToken = optional(env["SWITCHYARD_NODE_SHARED_TOKEN"]);
  const postgresUrl = optional(env["SWITCHYARD_POSTGRES_URL"]);
  const redisUrl = optional(env["SWITCHYARD_REDIS_URL"]);
  const apiKeyPepper = optional(env["SWITCHYARD_API_KEY_PEPPER"]);
  const bootstrapPath = optional(env["SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH"]);
  const bootstrapJson = optional(env["SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON"]);
  const auditIpHashPepper = optional(env["SWITCHYARD_AUDIT_IP_HASH_PEPPER"]);

  if (nodeSharedToken) config.nodeSharedToken = nodeSharedToken;
  if (postgresUrl) config.postgresUrl = postgresUrl;
  if (redisUrl) config.redisUrl = redisUrl;
  if (apiKeyPepper) config.apiKeyPepper = apiKeyPepper;
  if (bootstrapPath) config.controlPlaneBootstrapPath = bootstrapPath;
  if (bootstrapJson) config.controlPlaneBootstrapJson = bootstrapJson;
  if (auditIpHashPepper) config.auditIpHashPepper = auditIpHashPepper;

  try {
    config.objectStore = resolveObjectStoreConfig({ env, deploymentMode: config.deploymentMode });
  } catch (error) {
    if (error instanceof ObjectStoreConfigError) {
      throw new ConfigError(error.code, error.variable, {
        ...buildSummary(config),
        objectStore: error.redactedConfig["objectStore"] ?? {}
      });
    }
    throw error;
  }

  const shouldLoadBootstrap =
    config.serverAuthMode === "api_key" ||
    Boolean(config.controlPlaneBootstrapPath) ||
    Boolean(config.controlPlaneBootstrapJson);
  if (shouldLoadBootstrap) {
    config.controlPlaneBootstrap = loadControlPlaneBootstrap(config);
  }

  if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
    requireVar(config.postgresUrl, "SWITCHYARD_POSTGRES_URL", config);
    requireVar(config.redisUrl, "SWITCHYARD_REDIS_URL", config);
    requireVar(config.nodeSharedToken, "SWITCHYARD_NODE_SHARED_TOKEN", config);
    requireVar(hostedRuntimeAllowlistEnv, "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST", config);
    if (config.serverAuthMode !== "api_key") {
      throw new ConfigError("config_forbidden:SWITCHYARD_SERVER_AUTH_MODE", "SWITCHYARD_SERVER_AUTH_MODE", buildSummary(config));
    }
    requireVar(config.apiKeyPepper, "SWITCHYARD_API_KEY_PEPPER", config);
    if (config.controlPlaneStore === "memory") {
      throw new ConfigError("config_forbidden:SWITCHYARD_CONTROL_PLANE_STORE", "SWITCHYARD_CONTROL_PLANE_STORE", buildSummary(config));
    }
    if (!config.controlPlaneBootstrap) {
      throw new ConfigError("control_plane_bootstrap_missing", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
    }
    if (config.deploymentMode === "production" && config.publicMetrics) {
      throw new ConfigError("config_forbidden:SWITCHYARD_PUBLIC_METRICS", "SWITCHYARD_PUBLIC_METRICS", buildSummary(config));
    }
  }

  if (config.serverAuthMode === "api_key") {
    requireVar(config.apiKeyPepper, "SWITCHYARD_API_KEY_PEPPER", config);
    if (!config.controlPlaneBootstrap) {
      throw new ConfigError("control_plane_bootstrap_missing", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
    }
  }

  const allowlistValidation = validateHostedRuntimeAllowlist({
    allowlist: config.hostedRuntimeAllowlist,
    deploymentMode: config.deploymentMode,
    realRuntimeExecution: config.hostedRealRuntimeExecution
  });
  if (!allowlistValidation.ok) {
    const variable = allowlistValidation.code.includes("REAL_RUNTIME_EXECUTION")
      ? "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"
      : "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST";
    throw new ConfigError(allowlistValidation.code, variable, buildSummary(config));
  }

  if (!config.sandbox.valid) {
    throw new ConfigError("sandbox_config_invalid", "SWITCHYARD_SANDBOX_*", buildSummary(config));
  }

  config.redactedSummary = buildSummary(config);
  return config;
}

function loadControlPlaneBootstrap(config: ServerConfig): ControlPlaneBootstrapConfig {
  const source = config.controlPlaneBootstrapJson
    ? { type: "env_json" as const, content: config.controlPlaneBootstrapJson }
    : config.controlPlaneBootstrapPath
      ? { type: "path" as const, content: safeReadFile(config.controlPlaneBootstrapPath, config) }
      : null;

  if (!source) {
    throw new ConfigError("control_plane_bootstrap_missing", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.content);
  } catch {
    throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
  }
  if (!isRecord(parsed)) {
    throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
  }

  const recordsContainer = isRecord(parsed["records"]) ? parsed["records"] : parsed;
  const accounts = readEntityArray(recordsContainer["accounts"], config);
  const tenants = readEntityArray(recordsContainer["tenants"], config);
  const projects = readEntityArray(recordsContainer["projects"], config);
  const users = readEntityArray(recordsContainer["users"], config);
  const billingPlans = readEntityArray(recordsContainer["billingPlans"], config);
  const apiKeys = normalizeApiKeys(readEntityArray(recordsContainer["apiKeys"], config), config);

  if (
    accounts.length === 0 &&
    tenants.length === 0 &&
    projects.length === 0 &&
    users.length === 0 &&
    apiKeys.length === 0 &&
    billingPlans.length === 0
  ) {
    throw new ConfigError("control_plane_bootstrap_empty", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
  }

  assertUniqueIds(accounts, config);
  assertUniqueIds(tenants, config);
  assertUniqueIds(projects, config);
  assertUniqueIds(users, config);
  assertUniqueIds(apiKeys, config);
  assertUniqueIds(billingPlans, config);

  const active = {
    accounts: countByStatus(accounts, "active", "status"),
    tenants: countByStatus(tenants, "active", "status"),
    projects: countByStatus(projects, "active", "status"),
    users: users.filter((entry) => (String(entry["status"] ?? "active") === "active")).length,
    apiKeys: countByStatus(apiKeys, "active", "status"),
    billingPlans: countByStatus(billingPlans, "active", "status")
  };

  if (
    config.deploymentMode === "staging" ||
    config.deploymentMode === "production"
  ) {
    if (
      active.accounts === 0 ||
      active.tenants === 0 ||
      active.projects === 0 ||
      active.users === 0 ||
      active.apiKeys === 0 ||
      active.billingPlans === 0
    ) {
      throw new ConfigError("control_plane_bootstrap_zero_active", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
    }
  }

  validateActivePlanBindings({ accounts, billingPlans, apiKeys }, config);

  const nodeTokenBindings = normalizeNodeTokenBindings(parsed, recordsContainer, config);

  return {
    records: {
      accounts,
      tenants,
      projects,
      users,
      apiKeys,
      billingPlans
    } as unknown as ControlPlaneBootstrapInput,
    source: source.type,
    active,
    nodeTokenBindings
  };
}

function safeReadFile(path: string, config: ServerConfig): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new ConfigError("control_plane_bootstrap_missing", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
  }
}

function readEntityArray(value: unknown, config: ServerConfig): Record<string, unknown>[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
    }
    return { ...entry };
  });
}

function normalizeApiKeys(rows: Record<string, unknown>[], config: ServerConfig): Record<string, unknown>[] {
  try {
    return rows.map((row) => {
      const next = { ...row };
      const rawKey = typeof next["rawKey"] === "string" ? next["rawKey"].trim() : "";
      if (rawKey.length > 0) {
        if (!config.apiKeyPepper) {
          throw new ConfigError("config_required:SWITCHYARD_API_KEY_PEPPER", "SWITCHYARD_API_KEY_PEPPER", buildSummary(config));
        }
        if (typeof next["keyPrefix"] !== "string" || next["keyPrefix"].trim().length === 0) {
          next["keyPrefix"] = deriveKeyPrefix(rawKey);
        }
        if (typeof next["secretHash"] !== "string" || next["secretHash"].trim().length === 0) {
          next["secretHash"] = hashApiKey(rawKey, config.apiKeyPepper);
        }
        delete next["rawKey"];
      }
      const secretHash = typeof next["secretHash"] === "string" ? next["secretHash"].trim() : "";
      if (secretHash.length === 0 || looksLikeRawKey(secretHash)) {
        throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
      }
      return next;
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
  }
}

function normalizeNodeTokenBindings(
  root: Record<string, unknown>,
  container: Record<string, unknown>,
  config: ServerConfig
): readonly ControlPlaneNodeTokenBindingConfig[] {
  const candidate = root["nodeTokenBindings"] ?? container["nodeTokenBindings"] ?? root["nodeTokens"] ?? container["nodeTokens"];
  if (candidate === undefined) {
    return [];
  }
  if (!Array.isArray(candidate)) {
    throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
  }
  const normalized: ControlPlaneNodeTokenBindingConfig[] = [];
  for (const entry of candidate) {
    if (!isRecord(entry)) {
      throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
    }
    const token = typeof entry["token"] === "string" ? entry["token"].trim() : "";
    const apiKeyId = typeof entry["apiKeyId"] === "string" ? entry["apiKeyId"].trim() : "";
    if (token.length === 0 || apiKeyId.length === 0) {
      throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
    }
    normalized.push({ token, apiKeyId });
  }
  return normalized;
}

function validateActivePlanBindings(input: {
  accounts: Record<string, unknown>[];
  billingPlans: Record<string, unknown>[];
  apiKeys: Record<string, unknown>[];
}, config: ServerConfig): void {
  const plansById = new Map<string, Record<string, unknown>>();
  for (const plan of input.billingPlans) {
    const id = typeof plan["id"] === "string" ? plan["id"] : "";
    if (id.length > 0) {
      plansById.set(id, plan);
    }
  }

  const accountsById = new Map<string, Record<string, unknown>>();
  for (const account of input.accounts) {
    const id = typeof account["id"] === "string" ? account["id"] : "";
    if (id.length > 0) {
      accountsById.set(id, account);
    }
  }

  for (const key of input.apiKeys) {
    if (String(key["status"] ?? "") !== "active") {
      continue;
    }
    const accountId = typeof key["accountId"] === "string" ? key["accountId"] : "";
    const account = accountsById.get(accountId);
    if (!account) {
      throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
    }
    const planId = typeof account["billingPlanId"] === "string" ? account["billingPlanId"] : "";
    const plan = plansById.get(planId);
    if (!plan) {
      throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
    }
    if (String(plan["status"] ?? "") !== "active") {
      throw new ConfigError("control_plane_bootstrap_inactive_plan", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
    }
  }
}

function assertUniqueIds(records: Record<string, unknown>[], config: ServerConfig): void {
  const seen = new Set<string>();
  for (const entry of records) {
    const id = typeof entry["id"] === "string" ? entry["id"] : "";
    if (id.length === 0) {
      throw new ConfigError("control_plane_bootstrap_malformed", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
    }
    if (seen.has(id)) {
      throw new ConfigError("control_plane_bootstrap_duplicate", "SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH", buildSummary(config));
    }
    seen.add(id);
  }
}

function countByStatus(records: Record<string, unknown>[], expected: string, key: string): number {
  return records.filter((entry) => String(entry[key] ?? "") === expected).length;
}

function parseDeploymentMode(value: string | undefined): DeploymentMode {
  const normalized = optional(value) ?? "local";
  if (normalized === "local" || normalized === "test" || normalized === "staging" || normalized === "production") {
    return normalized;
  }
  throw new ConfigError("config_invalid:SWITCHYARD_DEPLOYMENT_MODE", "SWITCHYARD_DEPLOYMENT_MODE", { deploymentMode: normalized });
}

function parseServerAuthMode(value: string | undefined): ServerAuthMode {
  const normalized = optional(value) ?? "disabled";
  if (normalized === "disabled" || normalized === "api_key") {
    return normalized;
  }
  throw new ConfigError("config_invalid:SWITCHYARD_SERVER_AUTH_MODE", "SWITCHYARD_SERVER_AUTH_MODE", { serverAuthMode: normalized });
}

function parseControlPlaneStoreMode(value: string | undefined): ControlPlaneStoreMode {
  const normalized = optional(value) ?? "memory";
  if (normalized === "memory" || normalized === "postgres") {
    return normalized;
  }
  throw new ConfigError("config_invalid:SWITCHYARD_CONTROL_PLANE_STORE", "SWITCHYARD_CONTROL_PLANE_STORE", { controlPlaneStore: normalized });
}

function parseHostedRealRuntimeExecution(value: string | undefined): HostedRealRuntimeExecution {
  const normalized = optional(value);
  if (!normalized || normalized === "disabled") {
    return "disabled";
  }
  if (normalized === "enabled") {
    return "enabled";
  }
  throw new ConfigError(
    "config_invalid:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
    "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
    { hostedRealRuntimeExecution: normalized }
  );
}

function parseCsv(value: string | undefined, fallback: string): string[] {
  const source = optional(value) ?? fallback;
  return source.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = optional(value);
  if (!normalized) {
    return fallback;
  }
  const lowered = normalized.toLowerCase();
  if (lowered === "1" || lowered === "true" || lowered === "yes" || lowered === "on") {
    return true;
  }
  if (lowered === "0" || lowered === "false" || lowered === "no" || lowered === "off") {
    return false;
  }
  throw new ConfigError("config_invalid:SWITCHYARD_PUBLIC_METRICS", "SWITCHYARD_PUBLIC_METRICS", { publicMetrics: normalized });
}

function requireVar(value: string | undefined, variable: string, config: ServerConfig): void {
  if (!value) {
    throw new ConfigError(`config_required:${variable}`, variable, buildSummary(config));
  }
}

function requiredOrDefault(value: string | undefined, fallback: string): string {
  return optional(value) ?? fallback;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function buildSummary(config: ServerConfig): Record<string, unknown> {
  return redactSecrets({
    deploymentMode: config.deploymentMode,
    host: config.host,
    port: config.port,
    queueName: config.queueName,
    serverAuthMode: config.serverAuthMode,
    controlPlaneStore: config.controlPlaneStore,
    publicMetrics: config.publicMetrics,
    hostedRuntimeAllowlist: config.hostedRuntimeAllowlist,
    hostedRealRuntimeExecution: config.hostedRealRuntimeExecution,
    hasNodeSharedToken: Boolean(config.nodeSharedToken),
    hasPostgresUrl: Boolean(config.postgresUrl),
    hasRedisUrl: Boolean(config.redisUrl),
    hasApiKeyPepper: Boolean(config.apiKeyPepper),
    hasAuditIpHashPepper: Boolean(config.auditIpHashPepper),
    controlPlaneBootstrap: config.controlPlaneBootstrap
      ? {
          source: config.controlPlaneBootstrap.source,
          active: config.controlPlaneBootstrap.active,
          hasNodeTokenBindings: config.controlPlaneBootstrap.nodeTokenBindings.length > 0
        }
      : {
          source: null,
          active: null,
          hasNodeTokenBindings: false
        },
    objectStore: config.objectStore?.redactedSummary ?? {},
    sandbox: config.sandbox?.redactedSummary ?? {}
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveKeyPrefix(rawKey: string): string {
  const trimmed = rawKey.trim();
  const parts = trimmed.split("_").filter((entry) => entry.length > 0);
  if (parts.length >= 2) {
    return `${parts[0]}_${parts[1]}`;
  }
  return trimmed.slice(0, Math.min(8, trimmed.length));
}

function looksLikeRawKey(value: string): boolean {
  return /^sk_[A-Za-z0-9_-]+$/.test(value.trim());
}
