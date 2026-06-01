import { pathToFileURL } from "node:url";
import {
  createDisabledRealToolPolicyConfig,
  checkHostedSandboxReadiness,
  redactSecrets,
  validateHostedRuntimeAllowlist
} from "../packages/core/src/index.js";
import { BullMqRunQueue } from "../packages/queue/src/index.js";
import {
  checkPostgresSchemaCompatibility,
  createArtifactContentStoreFromObjectConfig,
  openPostgresDatabase,
  PostgresControlPlaneStore,
  type PostgresDatabaseHandle,
  type PostgresSchemaCompatibility,
  type ResolvedObjectStoreConfig
} from "../packages/storage/src/index.js";
import { loadServerConfig } from "../apps/server/src/config.js";
import { loadWorkerConfig } from "../apps/worker/src/config.js";
import { loadNodeConfig } from "../apps/node/src/config.js";
import { parseProductionEnvFile, type ProductionEnvParseErrorCode } from "./production-env.js";
import { validateProductionManifest, type ProductionManifestErrorCode, type ProductionManifestValidationResult } from "./production-manifest.js";

export interface ProductionPreflightCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  code: string;
  diagnostics?: Record<string, unknown>;
}

export interface ProductionPreflightResult {
  ok: boolean;
  checks: ProductionPreflightCheck[];
  summary: {
    deploymentMode: "production";
    manifest: string;
    checkedAt: string;
  };
}

interface ControlPlaneCheckResult {
  checks: Array<{ name: string; ok: boolean; code: string; diagnostics?: Record<string, unknown> }>;
}

export interface PreflightDeps {
  parseEnvFile?: typeof parseProductionEnvFile;
  validateManifest?: typeof validateProductionManifest;
  loadServerConfig?: typeof loadServerConfig;
  loadWorkerConfig?: typeof loadWorkerConfig;
  loadNodeConfig?: typeof loadNodeConfig;
  openPostgresDatabase?: typeof openPostgresDatabase;
  checkPostgresSchemaCompatibility?: (
    handle: PostgresDatabaseHandle
  ) => Promise<PostgresSchemaCompatibility>;
  queueStats?: (input: { redisUrl?: string; queueName?: string }) => Promise<void>;
  probeObjectStore?: (input: { objectStore: ResolvedObjectStoreConfig }) => Promise<void>;
  checkControlPlane?: (input: {
    serverConfig: ReturnType<typeof loadServerConfig>;
    postgres?: PostgresDatabaseHandle;
  }) => Promise<ControlPlaneCheckResult>;
  checkHostedRuntimeGate?: (input: {
    deploymentMode: string;
    allowlist: string[];
    hostedRealRuntimeExecution: string;
  }) => Promise<{ ok: true } | { ok: false; code: string; diagnostics?: Record<string, unknown> }>;
  checkProviderAdapters?: (input: {
    workerConfig: ReturnType<typeof loadWorkerConfig>;
  }) => Promise<{
    ok: boolean;
    modes: Record<string, { ok: boolean; code?: string }>;
  }>;
  now?: () => Date;
  timeoutMs?: number;
}

export async function runProductionPreflight(options: {
  envFile?: string;
  manifestPath?: string;
  includeNode?: boolean;
  deps?: PreflightDeps;
} = {}): Promise<ProductionPreflightResult> {
  const deps = options.deps ?? {};
  const now = deps.now ?? (() => new Date());
  const manifestPath = options.manifestPath ?? "deploy/production/manifest.json";
  const includeNode = Boolean(options.includeNode);
  const timeoutMs = deps.timeoutMs ?? 5_000;

  const checks: ProductionPreflightCheck[] = [];

  const envResult = options.envFile
    ? await (deps.parseEnvFile ?? parseProductionEnvFile)(options.envFile)
    : ({ ok: true, values: {} } as const);
  const manifestResult = await (deps.validateManifest ?? validateProductionManifest)(manifestPath);

  const hasInputBlocker = appendInputChecks(checks, envResult, manifestResult);
  if (hasInputBlocker) {
    appendConfigSkipChecks(checks, includeNode, "skipped_input_invalid");
    appendDependencySkipChecks(checks, "skipped_input_invalid");
    return buildResult(checks, manifestPath, now);
  }

  const mergedEnv = {
    ...process.env,
    ...(envResult.ok ? envResult.values : {})
  };

  let serverConfig: ReturnType<typeof loadServerConfig> | undefined;
  let workerConfig: ReturnType<typeof loadWorkerConfig> | undefined;
  let nodeConfig: ReturnType<typeof loadNodeConfig> | undefined;

  serverConfig = runConfigCheck("serverConfig", checks, () => (deps.loadServerConfig ?? loadServerConfig)(mergedEnv));
  workerConfig = runConfigCheck("workerConfig", checks, () => (deps.loadWorkerConfig ?? loadWorkerConfig)(mergedEnv));

  if (includeNode) {
    nodeConfig = runConfigCheck("nodeConfig", checks, () => (deps.loadNodeConfig ?? loadNodeConfig)(mergedEnv));
    void nodeConfig;
  }

  if (!manifestResult.ok) {
    for (const error of manifestResult.errors) {
      checks.push({
        name: error.service ? `manifest.${error.service}` : "manifest",
        status: "fail",
        code: error.code
      });
    }
  } else {
    checks.push({ name: "manifest", status: "pass", code: "manifest_valid" });
  }

  const hasConfigOrManifestFailure = checks.some((check) => check.status === "fail");
  if (hasConfigOrManifestFailure) {
    const sandboxConfigFailure = checks.find(
      (check) => check.status === "fail" && check.code.startsWith("sandbox_")
    );
    if (sandboxConfigFailure && !checks.some((check) => check.name === "sandboxGate")) {
      checks.push({
        name: "sandboxGate",
        status: "fail",
        code: sandboxConfigFailure.code,
        ...(sandboxConfigFailure.diagnostics ? { diagnostics: sandboxConfigFailure.diagnostics } : {})
      });
    }
    appendDependencySkipChecks(checks, sandboxConfigFailure ? "skipped_sandbox_gate_failed" : "skipped_config_invalid");
    return buildResult(checks, manifestPath, now);
  }

  if (!serverConfig || !workerConfig) {
    appendDependencySkipChecks(checks, "skipped_config_invalid");
    return buildResult(checks, manifestPath, now);
  }

  const sandboxGate = evaluateSandboxGate(workerConfig.sandbox);
  if (sandboxGate.ok) {
    checks.push({
      name: "sandboxGate",
      status: "pass",
      code: sandboxGate.code,
      ...(sandboxGate.diagnostics ? { diagnostics: redactDiagnostics(sandboxGate.diagnostics) } : {})
    });
  } else {
    checks.push({
      name: "sandboxGate",
      status: "fail",
      code: sandboxGate.code,
      ...(sandboxGate.diagnostics ? { diagnostics: redactDiagnostics(sandboxGate.diagnostics) } : {})
    });
    appendDependencySkipChecks(checks, "skipped_sandbox_gate_failed");
    return buildResult(checks, manifestPath, now);
  }

  await appendProviderActivationChecks(checks, {
    serverConfig,
    workerConfig,
    checkProviderAdapters: deps.checkProviderAdapters
  });

  let postgres: PostgresDatabaseHandle | undefined;
  if (serverConfig.postgresUrl) {
    try {
      postgres = (deps.openPostgresDatabase ?? openPostgresDatabase)(serverConfig.postgresUrl);
    } catch {
      checks.push({ name: "schema", status: "fail", code: "postgres_unavailable" });
    }
  }

  if (postgres) {
    const schemaCheck = await resolveWithTimeout(
      async () => (deps.checkPostgresSchemaCompatibility ?? checkPostgresSchemaCompatibility)(postgres),
      timeoutMs
    ).catch(() => ({ ok: false, code: "postgres_unavailable" } as const));

    if (schemaCheck.ok) {
      checks.push({ name: "schema", status: "pass", code: schemaCheck.code });
    } else {
      checks.push({
        name: "schema",
        status: "fail",
        code: schemaCheck.code,
        diagnostics: redactDiagnostics(schemaCheck.diagnostics)
      });
    }
  }

  const queueResult = await resolveWithTimeout(
    async () => {
      await (deps.queueStats ?? defaultQueueStats)({
        redisUrl: workerConfig.redisUrl,
        queueName: workerConfig.queueName
      });
      return { ok: true } as const;
    },
    timeoutMs
  ).catch(() => ({ ok: false, code: "queue_unavailable" } as const));

  if (queueResult.ok) {
    checks.push({ name: "queue", status: "pass", code: "queue_ready" });
  } else {
    checks.push({ name: "queue", status: "fail", code: "queue_unavailable" });
  }

  const objectStoreResult = await resolveWithTimeout(
    async () => {
      await (deps.probeObjectStore ?? defaultObjectStoreProbe)({ objectStore: workerConfig.objectStore });
      return { ok: true } as const;
    },
    timeoutMs
  ).catch((error) => {
    const message = error instanceof Error ? error.message : "object_store_unavailable";
    return {
      ok: false,
      code: message.startsWith("object_store_") || message.startsWith("artifact_") ? message : "object_store_unavailable"
    } as const;
  });

  if (objectStoreResult.ok) {
    checks.push({ name: "objectStore", status: "pass", code: "object_store_ready" });
  } else {
    checks.push({ name: "objectStore", status: "fail", code: objectStoreResult.code });
  }

  const controlPlaneResult = await resolveWithTimeout(
    async () => (deps.checkControlPlane ?? defaultControlPlaneCheck)({ serverConfig, postgres }),
    timeoutMs
  ).catch(() => ({
    checks: [
      { name: "quotaStore", ok: false, code: "quota_store_unavailable" },
      { name: "auditStore", ok: false, code: "audit_store_unavailable" }
    ]
  }));

  for (const check of controlPlaneResult.checks) {
    checks.push({
      name: check.name,
      status: check.ok ? "pass" : "fail",
      code: check.code,
      ...(check.diagnostics ? { diagnostics: redactDiagnostics(check.diagnostics) } : {})
    });
  }

  appendToolsCheck(checks, {
    serverConfig,
    workerConfig,
    includeNode,
    nodeConfig
  });

  const hostedRuntimeGate = await resolveWithTimeout(
    async () => {
      return (deps.checkHostedRuntimeGate ?? defaultHostedRuntimeGateCheck)({
        deploymentMode: serverConfig.deploymentMode,
        allowlist: serverConfig.hostedRuntimeAllowlist,
        hostedRealRuntimeExecution: serverConfig.hostedRealRuntimeExecution
      });
    },
    timeoutMs
  ).catch(() => ({ ok: false, code: "hosted_runtime_gate_failed" } as const));

  if (hostedRuntimeGate.ok) {
    checks.push({ name: "hostedRuntimeGate", status: "pass", code: "hosted_runtime_gate_ready" });
  } else {
    checks.push({
      name: "hostedRuntimeGate",
      status: "fail",
      code: hostedRuntimeGate.code,
      ...(hostedRuntimeGate.diagnostics ? { diagnostics: redactDiagnostics(hostedRuntimeGate.diagnostics) } : {})
    });
  }

  if (postgres) {
    await postgres.close().catch(() => undefined);
  }

  return buildResult(checks, manifestPath, now);
}

const SENSITIVE_VALUE_PATTERN = /(replace-with|password|secret|token|apikey|postgres:\/\/|redis:\/\/)/i;

function appendInputChecks(
  checks: ProductionPreflightCheck[],
  envResult: Awaited<ReturnType<typeof parseProductionEnvFile>> | { ok: true; values: Record<string, string> },
  manifestResult: ProductionManifestValidationResult
): boolean {
  let hasInputBlocker = false;

  if (!envResult.ok) {
    for (const error of envResult.errors) {
      checks.push({
        name: "envFile",
        status: "fail",
        code: error.code,
        ...(error.line ? { diagnostics: { line: error.line, ...(error.key ? { key: error.key } : {}) } } : {})
      });
      if (isEnvInputBlocker(error.code)) {
        hasInputBlocker = true;
      }
    }
  } else {
    checks.push({ name: "envFile", status: "pass", code: "env_file_valid" });
  }

  if (!manifestResult.ok) {
    for (const error of manifestResult.errors) {
      checks.push({
        name: error.service ? `manifest.${error.service}` : "manifest",
        status: "fail",
        code: error.code
      });
      if (isManifestInputBlocker(error.code)) {
        hasInputBlocker = true;
      }
    }
  }

  return hasInputBlocker;
}

function appendConfigSkipChecks(checks: ProductionPreflightCheck[], includeNode: boolean, code: string): void {
  checks.push({ name: "serverConfig", status: "skip", code });
  checks.push({ name: "workerConfig", status: "skip", code });
  if (includeNode) {
    checks.push({ name: "nodeConfig", status: "skip", code });
  }
}

function appendDependencySkipChecks(checks: ProductionPreflightCheck[], code: string): void {
  checks.push({ name: "schema", status: "skip", code });
  checks.push({ name: "queue", status: "skip", code });
  checks.push({ name: "objectStore", status: "skip", code });
  checks.push({ name: "bootstrap", status: "skip", code });
  checks.push({ name: "quotaStore", status: "skip", code });
  checks.push({ name: "auditStore", status: "skip", code });
  checks.push({ name: "unownedResources", status: "skip", code });
  checks.push({ name: "hostedRuntimeGate", status: "skip", code });
}

async function appendProviderActivationChecks(
  checks: ProductionPreflightCheck[],
  input: {
    serverConfig: ReturnType<typeof loadServerConfig>;
    workerConfig: ReturnType<typeof loadWorkerConfig>;
    checkProviderAdapters?: PreflightDeps["checkProviderAdapters"];
  }
): Promise<void> {
  const realModes = input.serverConfig.hostedRuntimeAllowlist.filter((mode) => mode !== "fake.deterministic");
  if (realModes.length === 0) {
    checks.push({
      name: "providerRuntimePolicy",
      status: "pass",
      code: "provider_runtime_policy_inactive",
      diagnostics: {
        source: "none",
        enabledRealModeCount: 0
      }
    });
    checks.push({ name: "providerCredentials", status: "skip", code: "skipped_provider_runtime_inactive" });
    checks.push({ name: "providerSpendControls", status: "skip", code: "skipped_provider_runtime_inactive" });
    checks.push({ name: "providerCommandResolution", status: "skip", code: "skipped_provider_runtime_inactive" });
    checks.push({ name: "providerAdapterChecks", status: "skip", code: "skipped_provider_runtime_inactive" });
    return;
  }

  const activation = input.serverConfig.providerRuntimeActivation ?? input.workerConfig.providerRuntimeActivation;
  if (!activation?.valid) {
    const code = activation?.reasons[0]?.code ?? "provider_runtime_policy_missing";
    checks.push({
      name: "providerRuntimePolicy",
      status: "fail",
      code,
      diagnostics: redactDiagnostics({
        source: activation?.redactedSummary.source.kind ?? "none",
        reasonCodes: activation?.redactedSummary.reasonCodes ?? [code],
        modeStatuses: activation?.redactedSummary.modeStatuses ?? []
      })
    });
    checks.push({ name: "providerCredentials", status: "skip", code: "skipped_provider_policy_invalid" });
    checks.push({ name: "providerSpendControls", status: "skip", code: "skipped_provider_policy_invalid" });
    checks.push({ name: "providerCommandResolution", status: "skip", code: "skipped_provider_policy_invalid" });
    checks.push({ name: "providerAdapterChecks", status: "skip", code: "skipped_provider_policy_invalid" });
    return;
  }

  checks.push({
    name: "providerRuntimePolicy",
    status: "pass",
    code: "provider_runtime_policy_ready",
    diagnostics: redactDiagnostics({
      source: activation.redactedSummary.source.kind,
      enabledRealModeCount: activation.redactedSummary.enabledRealModeCount,
      modeStatuses: activation.redactedSummary.modeStatuses
    })
  });

  const missingCredentials = findProviderReasonCode(activation.reasons, "provider_credentials_");
  if (missingCredentials) {
    checks.push({ name: "providerCredentials", status: "fail", code: missingCredentials });
  } else {
    checks.push({ name: "providerCredentials", status: "pass", code: "provider_credentials_ready" });
  }

  const spendFailure = findProviderReasonCode(activation.reasons, "provider_spend_");
  if (spendFailure) {
    checks.push({ name: "providerSpendControls", status: "fail", code: spendFailure });
  } else {
    checks.push({ name: "providerSpendControls", status: "pass", code: "provider_spend_controls_ready" });
  }

  const commandFailure = findProviderReasonCode(activation.reasons, "provider_command_");
  if (commandFailure) {
    checks.push({ name: "providerCommandResolution", status: "fail", code: commandFailure });
  } else {
    checks.push({ name: "providerCommandResolution", status: "pass", code: "provider_command_resolution_ready" });
  }

  const adapterCheck = input.checkProviderAdapters
    ? await input.checkProviderAdapters({ workerConfig: input.workerConfig })
    : defaultProviderAdapterCheck(input.serverConfig.hostedRuntimeAllowlist);
  if (adapterCheck.ok) {
    checks.push({
      name: "providerAdapterChecks",
      status: "pass",
      code: "provider_adapter_checks_ready",
      diagnostics: redactDiagnostics({ modes: adapterCheck.modes })
    });
  } else {
    checks.push({
      name: "providerAdapterChecks",
      status: "fail",
      code: firstProviderAdapterFailure(adapterCheck.modes),
      diagnostics: redactDiagnostics({ modes: adapterCheck.modes })
    });
  }
}

function findProviderReasonCode(
  reasons: Array<{ code: string }> | undefined,
  prefix: string
): string | undefined {
  if (!reasons) {
    return undefined;
  }
  for (const reason of reasons) {
    if (reason.code.startsWith(prefix)) {
      return reason.code;
    }
  }
  return undefined;
}

function defaultProviderAdapterCheck(allowlist: string[]): {
  ok: boolean;
  modes: Record<string, { ok: boolean; code?: string }>;
} {
  const modes: Record<string, { ok: boolean; code?: string }> = {};
  for (const mode of ["codex.exec_json", "claude_code.sdk", "opencode.acp"]) {
    if (allowlist.includes(mode)) {
      modes[mode] = { ok: true };
    }
  }
  return { ok: true, modes };
}

function firstProviderAdapterFailure(modes: Record<string, { ok: boolean; code?: string }>): string {
  for (const entry of Object.values(modes)) {
    if (!entry.ok) {
      return entry.code ?? "adapter_check_failed";
    }
  }
  return "adapter_check_failed";
}

function evaluateSandboxGate(sandbox: ReturnType<typeof loadWorkerConfig>["sandbox"]): {
  ok: boolean;
  code: string;
  diagnostics?: Record<string, unknown>;
} {
  const readiness = checkHostedSandboxReadiness(sandbox);
  const diagnostics = {
    enabled: sandbox.enabled,
    mode: sandbox.realExecution.mode,
    policyCount: sandbox.realExecution.commandPolicy.length,
    ptyDriverConfigured: sandbox.realExecution.ptyDriverConfigured,
    summary: sandbox.redactedSummary
  };
  if (!readiness.ok) {
    return {
      ok: false,
      code: readiness.code ?? "sandbox_config_invalid",
      diagnostics
    };
  }

  if (sandbox.realExecution.mode === "enabled") {
    const networkPolicyDisabled = sandbox.realExecution.commandPolicy.every((entry) => entry.networkPolicy === "disabled");
    if (!networkPolicyDisabled) {
      return {
        ok: false,
        code: "sandbox_policy_invalid",
        diagnostics
      };
    }
    return {
      ok: true,
      code: "sandbox_gate_enabled",
      diagnostics
    };
  }

  return {
    ok: true,
    code: "sandbox_gate_disabled",
    diagnostics
  };
}

function runConfigCheck<T>(
  name: string,
  checks: ProductionPreflightCheck[],
  loader: () => T
): T | undefined {
  try {
    const config = loader();
    checks.push({ name, status: "pass", code: "config_valid" });
    return config;
  } catch (error) {
    const code = readErrorCode(error, "config_invalid");
    checks.push({
      name,
      status: "fail",
      code,
      ...(readRedactedDiagnostics(error) ? { diagnostics: readRedactedDiagnostics(error) } : {})
    });
    return undefined;
  }
}

function readErrorCode(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function readRedactedDiagnostics(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  if (!("redactedConfig" in error)) {
    return undefined;
  }
  const diagnostics = (error as { redactedConfig?: unknown }).redactedConfig;
  if (!isRecord(diagnostics)) {
    return undefined;
  }
  return redactDiagnostics(diagnostics);
}

function isEnvInputBlocker(code: ProductionEnvParseErrorCode): boolean {
  return code === "env_file_missing" || code === "env_file_empty" || code === "env_file_invalid_line" || code === "env_duplicate_key";
}

function isManifestInputBlocker(code: ProductionManifestErrorCode): boolean {
  return code === "manifest_missing" || code === "manifest_invalid";
}

function buildResult(checks: ProductionPreflightCheck[], manifestPath: string, now: () => Date): ProductionPreflightResult {
  const ok = checks.every((check) => check.status !== "fail");
  return {
    ok,
    checks,
    summary: {
      deploymentMode: "production",
      manifest: manifestPath,
      checkedAt: now().toISOString()
    }
  };
}

function appendToolsCheck(
  checks: ProductionPreflightCheck[],
  input: {
    serverConfig: ReturnType<typeof loadServerConfig>;
    workerConfig: ReturnType<typeof loadWorkerConfig>;
    includeNode: boolean;
    nodeConfig?: ReturnType<typeof loadNodeConfig>;
  }
): void {
  const serverTools = input.serverConfig.tools ?? {
    hostedRealTools: "disabled" as const,
    connectedNodeRealTools: "disabled" as const,
    policySourceKind: "none" as const,
    policy: createDisabledRealToolPolicyConfig()
  };
  const workerTools = input.workerConfig.tools ?? {
    hostedRealTools: "disabled" as const,
    connectedNodeRealTools: "disabled" as const,
    adapterMode: "fake" as const,
    policySourceKind: "none" as const,
    policy: createDisabledRealToolPolicyConfig()
  };
  const policy = serverTools.policy;
  const enabledToolTypes = [
    ...(policy.fetch.enabled ? ["fetch"] : []),
    ...(policy.webSearch.enabled ? ["web_search"] : []),
    ...(policy.github.enabled ? ["github"] : []),
    ...(policy.repo.enabled ? ["repo"] : []),
    ...(policy.shell.enabled ? ["shell"] : [])
  ];

  const diagnostics = redactDiagnostics({
    hostedRealTools: serverTools.hostedRealTools,
    connectedNodeRealTools: serverTools.connectedNodeRealTools,
    policySourceKind: serverTools.policySourceKind,
    workerPolicySourceKind: workerTools.policySourceKind,
    adapterMode: workerTools.adapterMode,
    allowedPlacements: policy.global.allowedPlacements,
    hostedAllowedToolTypes: policy.hosted.allowedToolTypes,
    connectedAllowedToolTypes: policy.connectedLocalNode.allowedToolTypes,
    enabledToolTypes,
    includeNode: input.includeNode,
    nodeConfigLoaded: Boolean(input.nodeConfig)
  });

  const toolsEnabled = serverTools.hostedRealTools === "enabled" || serverTools.connectedNodeRealTools === "enabled";
  if (!toolsEnabled) {
    checks.push({
      name: "tools",
      status: "pass",
      code: "tool_checks_disabled",
      ...(diagnostics ? { diagnostics } : {})
    });
    return;
  }

  const failedDependency = (name: string): boolean => checks.some((check) => check.name === name && check.status === "fail");
  const fail = (code: string): void => {
    checks.push({
      name: "tools",
      status: "fail",
      code,
      ...(diagnostics ? { diagnostics } : {})
    });
  };

  if (serverTools.policySourceKind === "none" || workerTools.policySourceKind === "none") {
    fail("tool_policy_config_invalid");
    return;
  }
  if (workerTools.adapterMode !== "fake") {
    fail("tool_policy_config_invalid");
    return;
  }
  if (input.serverConfig.serverAuthMode !== "api_key") {
    fail("tool_hosted_auth_required");
    return;
  }
  if (failedDependency("schema") || failedDependency("objectStore") || failedDependency("bootstrap")) {
    fail("tool_store_unavailable");
    return;
  }
  if (failedDependency("queue")) {
    fail("tool_dispatch_unavailable");
    return;
  }
  if (failedDependency("quotaStore")) {
    fail("quota_store_unavailable");
    return;
  }
  if (failedDependency("auditStore")) {
    fail("audit_store_unavailable");
    return;
  }
  if (!policy.global.enabled || policy.global.allowedPlacements.length === 0) {
    fail("tool_policy_config_invalid");
    return;
  }
  if (!hasValidBounds(policy)) {
    fail("tool_policy_config_invalid");
    return;
  }
  if (!areKnownPlacements(policy.global.allowedPlacements)) {
    fail("tool_policy_config_invalid");
    return;
  }

  const hostedAllowed = policy.hosted.allowedToolTypes;
  const connectedAllowed = policy.connectedLocalNode.allowedToolTypes;
  if (serverTools.hostedRealTools === "enabled" && hostedAllowed.length === 0) {
    fail("tool_policy_config_invalid");
    return;
  }
  if (serverTools.connectedNodeRealTools === "enabled" && connectedAllowed.length === 0) {
    fail("tool_policy_config_invalid");
    return;
  }
  if (!areKnownToolTypes(hostedAllowed) || !areKnownToolTypes(connectedAllowed)) {
    fail("tool_policy_config_invalid");
    return;
  }
  if (hostedAllowed.includes("repo")) {
    fail("repo_hosted_unshipped");
    return;
  }
  if (hostedAllowed.includes("browser") || connectedAllowed.includes("browser")) {
    fail("browser_tool_unshipped");
    return;
  }
  if (!isSafeShellCatalog(policy.shell.catalog)) {
    fail("shell_command_denied");
    return;
  }
  if (serverTools.connectedNodeRealTools === "enabled" && (!input.includeNode || !input.nodeConfig)) {
    fail("tool_node_unavailable");
    return;
  }

  checks.push({
    name: "tools",
    status: "pass",
    code: "tool_checks_ready",
    ...(diagnostics ? { diagnostics } : {})
  });
}

function hasValidBounds(policy: ReturnType<typeof createDisabledRealToolPolicyConfig>): boolean {
  const bounds = [
    policy.global.approvalExpiresMs,
    policy.global.maxConcurrentRealTools,
    policy.global.maxInputBytes,
    policy.global.maxInlineOutputBytes,
    policy.global.maxArtifactBytes,
    policy.global.defaultTimeoutMs,
    policy.fetch.timeoutMs,
    policy.fetch.maxResponseBytes,
    policy.webSearch.timeoutMs,
    policy.webSearch.maxResponseBytes,
    policy.github.timeoutMs,
    policy.github.maxResponseBytes,
    policy.repo.timeoutMs,
    policy.repo.maxOutputBytes,
    policy.shell.timeoutMs,
    policy.shell.maxOutputBytes
  ];
  return bounds.every((value) => Number.isFinite(value) && value > 0);
}

function areKnownPlacements(values: string[]): boolean {
  const known = new Set(["local", "hosted", "connected_local_node"]);
  return values.every((value) => known.has(value));
}

function areKnownToolTypes(values: string[]): boolean {
  const known = new Set(["web_search", "fetch", "browser", "repo", "shell", "github", "fake_echo"]);
  return values.every((value) => known.has(value));
}

function isSafeShellCatalog(catalog: Record<string, unknown>): boolean {
  const absolutePathPattern = /^([A-Za-z]:[\\/]|\/)/;
  for (const value of Object.values(catalog)) {
    if (!isRecord(value)) {
      return false;
    }
    const executablePath = value["executablePath"];
    if (typeof executablePath !== "string" || !absolutePathPattern.test(executablePath)) {
      return false;
    }
    if ("shell" in value || "command" in value || "pty" in value) {
      return false;
    }
    const env = value["env"];
    if (env !== undefined) {
      if (!isRecord(env)) {
        return false;
      }
      for (const [key, entry] of Object.entries(env)) {
        if (/(token|apikey|secret|password|authorization|cookie|credential)/i.test(key)) {
          return false;
        }
        if (typeof entry !== "string") {
          return false;
        }
      }
    }
  }
  return true;
}

async function defaultQueueStats(input: { redisUrl?: string; queueName?: string }): Promise<void> {
  if (!input.redisUrl) {
    throw new Error("queue_unavailable");
  }
  const queue = new BullMqRunQueue({
    redisUrl: input.redisUrl,
    queueName: input.queueName
  });
  try {
    await queue.stats();
  } finally {
    await queue.close();
  }
}

async function defaultObjectStoreProbe(input: { objectStore: ResolvedObjectStoreConfig }): Promise<void> {
  const store = createArtifactContentStoreFromObjectConfig(input.objectStore);
  await store.probe();
}

async function defaultControlPlaneCheck(input: {
  serverConfig: ReturnType<typeof loadServerConfig>;
  postgres?: PostgresDatabaseHandle;
}): Promise<ControlPlaneCheckResult> {
  const checks: ControlPlaneCheckResult["checks"] = [];

  const bootstrap = input.serverConfig.controlPlaneBootstrap;
  if (!bootstrap) {
    checks.push({ name: "bootstrap", ok: false, code: "control_plane_bootstrap_missing" });
  } else {
    checks.push({ name: "bootstrap", ok: true, code: "control_plane_bootstrap_ready" });

    if (bootstrap.active.accounts < 1) checks.push({ name: "bootstrapAccount", ok: false, code: "control_plane_bootstrap_account_missing" });
    if (bootstrap.active.tenants < 1) checks.push({ name: "bootstrapTenant", ok: false, code: "control_plane_bootstrap_tenant_missing" });
    if (bootstrap.active.projects < 1) checks.push({ name: "bootstrapProject", ok: false, code: "control_plane_bootstrap_project_missing" });
    if (bootstrap.active.users < 1) checks.push({ name: "bootstrapUser", ok: false, code: "control_plane_bootstrap_user_missing" });
    if (bootstrap.active.apiKeys < 1) checks.push({ name: "bootstrapApiKey", ok: false, code: "control_plane_bootstrap_api_key_missing" });
    if (bootstrap.active.billingPlans < 1) checks.push({ name: "bootstrapBillingPlan", ok: false, code: "control_plane_bootstrap_billing_plan_missing" });

    if (input.serverConfig.nodeSharedToken) {
      const tokenBound = bootstrap.nodeTokenBindings.some((entry) => entry.token === input.serverConfig.nodeSharedToken);
      if (!tokenBound) {
        checks.push({ name: "nodeTokenBinding", ok: false, code: "control_plane_node_token_unbound" });
      }
    }
  }

  if (!input.postgres) {
    checks.push({ name: "quotaStore", ok: false, code: "quota_store_unavailable" });
    checks.push({ name: "auditStore", ok: false, code: "audit_store_unavailable" });
    return { checks };
  }

  const controlPlaneStore = new PostgresControlPlaneStore(input.postgres);
  try {
    const unowned = await controlPlaneStore.countUnownedResources();
    checks.push({ name: "quotaStore", ok: true, code: "quota_store_ready" });
    checks.push({ name: "auditStore", ok: true, code: "audit_store_ready" });

    const total = unowned.runs + unowned.runEvents + unowned.artifacts + unowned.placements + unowned.nodes + unowned.assignments + unowned.auditEvents + unowned.quotaReservations;
    if (total > 0) {
      checks.push({
        name: "unownedResources",
        ok: false,
        code: "unowned_resources_present",
        diagnostics: {
          runs: unowned.runs,
          runEvents: unowned.runEvents,
          artifacts: unowned.artifacts,
          placements: unowned.placements,
          nodes: unowned.nodes,
          assignments: unowned.assignments,
          auditEvents: unowned.auditEvents,
          quotaReservations: unowned.quotaReservations
        }
      });
    } else {
      checks.push({ name: "unownedResources", ok: true, code: "unowned_resources_absent" });
    }
  } catch {
    checks.push({ name: "quotaStore", ok: false, code: "quota_store_unavailable" });
    checks.push({ name: "auditStore", ok: false, code: "audit_store_unavailable" });
  }

  return { checks };
}

async function defaultHostedRuntimeGateCheck(input: {
  deploymentMode: string;
  allowlist: string[];
  hostedRealRuntimeExecution: string;
}): Promise<{ ok: true } | { ok: false; code: string; diagnostics?: Record<string, unknown> }> {
  const validation = validateHostedRuntimeAllowlist({
    allowlist: input.allowlist,
    deploymentMode: input.deploymentMode as "local" | "test" | "staging" | "production",
    realRuntimeExecution: input.hostedRealRuntimeExecution as "enabled" | "disabled"
  });

  if (validation.ok) {
    return { ok: true };
  }

  return {
    ok: false,
    code: "hosted_runtime_gate_failed",
    diagnostics: {
      sourceCode: validation.code
    }
  };
}

function redactDiagnostics(diagnostics: unknown): Record<string, unknown> | undefined {
  if (!isRecord(diagnostics)) {
    return undefined;
  }
  const redacted = redactSecrets(diagnostics);
  return scrubSensitiveStrings(redacted) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function scrubSensitiveStrings(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => scrubSensitiveStrings(entry));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubSensitiveStrings(entry);
    }
    return out;
  }
  if (typeof value === "string") {
    if (SENSITIVE_VALUE_PATTERN.test(value)) {
      return "[REDACTED]";
    }
  }
  return value;
}

async function resolveWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("preflight_timeout")), timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

interface ParsedPreflightCliArgs {
  envFile?: string;
  manifestPath?: string;
  includeNode: boolean;
  json: boolean;
}

function parseCliArgs(argv: string[]): ParsedPreflightCliArgs {
  const parsed: ParsedPreflightCliArgs = {
    includeNode: false,
    json: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    if (token === "--env-file") {
      parsed.envFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--manifest") {
      parsed.manifestPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--include-node") {
      parsed.includeNode = true;
      continue;
    }

    if (token === "--json") {
      parsed.json = true;
      continue;
    }
  }

  return parsed;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await runProductionPreflight({
    envFile: args.envFile,
    manifestPath: args.manifestPath,
    includeNode: args.includeNode
  });

  if (args.json) {
    console.info(JSON.stringify(result));
  } else {
    console.info(JSON.stringify(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
