import type {
  AdapterType,
  Run,
  RuntimeCapability,
  RuntimeLimitation,
  RuntimeModeKind,
  RuntimePlacementFacts
} from "@switchyard/contracts";
import type { RuntimeAdapterManifest } from "../ports/runtime-adapter.js";

export type HostedRuntimeModeSlug = "fake.deterministic" | "codex.exec_json" | "claude_code.sdk" | "opencode.acp";
export type HostedDeploymentMode = "local" | "test" | "staging" | "production";
export type HostedRealRuntimeExecution = "enabled" | "disabled";

export interface HostedRuntimeCatalogEntry {
  runtimeModeSlug: HostedRuntimeModeSlug;
  runtime: string;
  provider: string;
  providerId: string;
  runtimeId: string;
  adapterId: string;
  adapterType: AdapterType;
  kind: RuntimeModeKind;
  hostedSupport: "supported" | "conditional";
  requiresRealRuntimeGate: boolean;
  productionAllowed: boolean;
  safeLimitations: RuntimeLimitation[];
  manifest: RuntimeAdapterManifest;
}

const SHARED_LIMITATIONS: RuntimeLimitation[] = [
  {
    code: "hosted_worker_owned",
    message: "Self-hosted/staging hosted execution is worker-owned in R15 and does not run in the server process."
  },
  {
    code: "no_public_exec_routes",
    message: "No public /sandbox, /exec, /pty, or /terminal execution route is available in R15."
  }
];

export const HOSTED_RUNTIME_CATALOG: Record<HostedRuntimeModeSlug, HostedRuntimeCatalogEntry> = {
  "fake.deterministic": {
    runtimeModeSlug: "fake.deterministic",
    runtime: "fake",
    provider: "test",
    providerId: "provider_test",
    runtimeId: "runtime_fake",
    adapterId: "fake",
    adapterType: "process",
    kind: "deterministic_fake",
    hostedSupport: "supported",
    requiresRealRuntimeGate: false,
    productionAllowed: true,
    safeLimitations: [
      ...SHARED_LIMITATIONS,
      {
        code: "fake_runtime_only",
        message: "Deterministic fake runtime intended for no-spend hosted tests and smoke checks."
      }
    ],
    manifest: {
      adapterId: "fake",
      providerId: "provider_test",
      runtimeId: "runtime_fake",
      runtimeModeId: "runtime_mode_fake_deterministic",
      runtimeModeSlug: "fake.deterministic",
      name: "Fake deterministic",
      adapterType: "process",
      kind: "deterministic_fake",
      capabilities: [
        "run.start",
        "run.cancel",
        "run.timeout",
        "event.normalized",
        "artifact.transcript",
        "auth.none"
      ],
      limitations: [
        {
          code: "deterministic_fake_only",
          message: "Fake deterministic runtime is for deterministic testing and smoke only."
        }
      ],
      placement: {
        local: { support: "supported", reason: "Fake deterministic runtime is local-safe." },
        hosted: { support: "supported", reason: "Hosted fake deterministic mode is supported." },
        connectedLocalNode: { support: "supported", reason: "Connected node supports fake deterministic mode." }
      },
      check: {
        strategy: "none",
        required: [],
        optional: []
      }
    }
  },
  "codex.exec_json": {
    runtimeModeSlug: "codex.exec_json",
    runtime: "codex",
    provider: "openai",
    providerId: "provider_openai",
    runtimeId: "runtime_codex",
    adapterId: "codex",
    adapterType: "process",
    kind: "one_shot_process",
    hostedSupport: "conditional",
    requiresRealRuntimeGate: true,
    productionAllowed: false,
    safeLimitations: [
      ...SHARED_LIMITATIONS,
      {
        code: "hosted_real_opt_in",
        message: "codex.exec_json hosted execution is opt-in for self-hosted/staging operators only."
      },
      {
        code: "codex_read_only_sandbox_required",
        message: "Hosted Codex runs require read-only sandbox metadata in R15."
      }
    ],
    manifest: {
      adapterId: "codex",
      providerId: "provider_openai",
      runtimeId: "runtime_codex",
      runtimeModeId: "runtime_mode_codex_exec_json",
      runtimeModeSlug: "codex.exec_json",
      name: "Codex exec JSON",
      adapterType: "process",
      kind: "one_shot_process",
      capabilities: [
        "run.start",
        "run.cancel",
        "run.timeout",
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "artifact.raw_transcript",
        "model.catalog",
        "auth.local",
        "sandbox.read_only"
      ],
      limitations: [
        {
          code: "hosted_worker_only",
          message: "Hosted codex.exec_json is worker-owned and not available for server-local execution in R15."
        },
        {
          code: "no_input_bridge",
          message: "Hosted codex.exec_json does not support post-start input in R15."
        },
        {
          code: "production_forbidden",
          message: "Hosted codex.exec_json production execution is forbidden in R15."
        }
      ],
      placement: {
        local: { support: "supported", reason: "Local Codex CLI execution is supported." },
        hosted: { support: "conditional", reason: "Self-hosted/staging worker execution requires explicit operator opt-in in R15." },
        connectedLocalNode: { support: "future", reason: "Connected node support remains future scope." }
      },
      check: {
        strategy: "binary_version_and_model_catalog",
        required: ["binary_version", "model_catalog"],
        optional: ["sandbox_policy_probe"]
      }
    }
  },
  "claude_code.sdk": {
    runtimeModeSlug: "claude_code.sdk",
    runtime: "claude_code",
    provider: "anthropic",
    providerId: "provider_anthropic",
    runtimeId: "runtime_claude_code",
    adapterId: "claude_code",
    adapterType: "native",
    kind: "sdk",
    hostedSupport: "conditional",
    requiresRealRuntimeGate: true,
    productionAllowed: false,
    safeLimitations: [
      ...SHARED_LIMITATIONS,
      {
        code: "hosted_real_opt_in",
        message: "claude_code.sdk hosted execution is opt-in for self-hosted/staging operators only."
      },
      {
        code: "no_hosted_input_bridge",
        message: "Hosted post-start input and approval bridging are not supported in R15."
      }
    ],
    manifest: {
      adapterId: "claude_code",
      providerId: "provider_anthropic",
      runtimeId: "runtime_claude_code",
      runtimeModeId: "runtime_mode_claude_code_sdk",
      runtimeModeSlug: "claude_code.sdk",
      name: "Claude Code SDK",
      adapterType: "native",
      kind: "sdk",
      capabilities: [
        "run.start",
        "run.cancel",
        "run.timeout",
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "artifact.raw_transcript",
        "auth.local"
      ],
      limitations: [
        {
          code: "hosted_worker_only",
          message: "Hosted claude_code.sdk is worker-owned and not available for server-local execution in R15."
        },
        {
          code: "no_hosted_cancel_bridge",
          message: "Hosted active cancellation bridge is not shipped in R15."
        },
        {
          code: "production_forbidden",
          message: "Hosted claude_code.sdk production execution is forbidden in R15."
        }
      ],
      placement: {
        local: { support: "conditional", reason: "Requires local Claude Code tooling and auth." },
        hosted: { support: "conditional", reason: "Self-hosted/staging worker execution requires explicit operator opt-in in R15." },
        connectedLocalNode: { support: "future", reason: "Connected node support remains future scope." }
      },
      check: {
        strategy: "custom",
        required: ["binary_version"],
        optional: ["auth", "live_probe"]
      }
    }
  },
  "opencode.acp": {
    runtimeModeSlug: "opencode.acp",
    runtime: "opencode",
    provider: "opencode",
    providerId: "provider_opencode",
    runtimeId: "runtime_opencode",
    adapterId: "opencode",
    adapterType: "acpx",
    kind: "acp",
    hostedSupport: "conditional",
    requiresRealRuntimeGate: true,
    productionAllowed: false,
    safeLimitations: [
      ...SHARED_LIMITATIONS,
      {
        code: "hosted_real_opt_in",
        message: "opencode.acp hosted execution is opt-in for self-hosted/staging operators only."
      },
      {
        code: "acp_permission_unsupported",
        message: "ACP permission requests fail visibly because hosted approval bridge is not shipped in R15."
      }
    ],
    manifest: {
      adapterId: "opencode",
      providerId: "provider_opencode",
      runtimeId: "runtime_opencode",
      runtimeModeId: "runtime_mode_opencode_acp",
      runtimeModeSlug: "opencode.acp",
      name: "OpenCode ACP",
      adapterType: "acpx",
      kind: "acp",
      capabilities: [
        "run.start",
        "run.cancel",
        "run.timeout",
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "artifact.raw_transcript",
        "auth.local"
      ],
      limitations: [
        {
          code: "hosted_worker_only",
          message: "Hosted opencode.acp is worker-owned and not available for server-local execution in R15."
        },
        {
          code: "no_terminal_bridge",
          message: "Hosted terminal and interactive bridges are not shipped in R15."
        },
        {
          code: "production_forbidden",
          message: "Hosted opencode.acp production execution is forbidden in R15."
        }
      ],
      placement: {
        local: { support: "conditional", reason: "Requires local OpenCode tooling and auth." },
        hosted: { support: "conditional", reason: "Self-hosted/staging worker execution requires explicit operator opt-in in R15." },
        connectedLocalNode: { support: "future", reason: "Connected node support remains future scope." }
      },
      check: {
        strategy: "custom",
        required: ["binary_version", "acp_initialize", "acp_session_new"],
        optional: ["stderr_warning"]
      }
    }
  }
};

export interface HostedRuntimeConfigInput {
  allowlist: string[];
  deploymentMode: HostedDeploymentMode;
  realRuntimeExecution: HostedRealRuntimeExecution;
}

export type HostedRuntimeConfigValidation =
  | {
    ok: true;
    allowlist: HostedRuntimeModeSlug[];
    deploymentMode: HostedDeploymentMode;
    realRuntimeExecution: HostedRealRuntimeExecution;
  }
  | {
    ok: false;
    code:
      | "config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"
      | "config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"
      | "config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION"
      | "hosted_real_runtime_disabled"
      | "hosted_real_runtime_production_forbidden";
  };

export interface HostedRunPreparationInput {
  run: Run;
  queuePayload: {
    runId: string;
    placement?: string;
    runtimeMode?: string;
  };
  allowlist: string[];
  deploymentMode: string;
  realRuntimeExecution: HostedRealRuntimeExecution;
}

export type HostedRunPreparationResult =
  | { ok: true; run: Run; reasonCode?: undefined }
  | { ok: false; reasonCode: string };

const HOSTED_RUNTIME_SLUGS = new Set<HostedRuntimeModeSlug>(Object.keys(HOSTED_RUNTIME_CATALOG) as HostedRuntimeModeSlug[]);
const CODEx_DENIED_SANDBOX_VALUES = new Set(["workspace-write", "danger-full-access"]);
const CODEx_DENIED_METADATA_KEYS = new Set(["command", "binary", "processFactory", "pty", "ptyConfig", "terminal", "tty"]);

export function isKnownHostedRuntimeMode(slug: string): slug is HostedRuntimeModeSlug {
  return HOSTED_RUNTIME_SLUGS.has(slug as HostedRuntimeModeSlug);
}

export function isRealHostedRuntimeMode(slug: string | undefined): boolean {
  return Boolean(slug && isKnownHostedRuntimeMode(slug) && HOSTED_RUNTIME_CATALOG[slug].requiresRealRuntimeGate);
}

export function getHostedRuntimeCatalogEntry(slug: string | undefined): HostedRuntimeCatalogEntry | undefined {
  if (!slug || !isKnownHostedRuntimeMode(slug)) {
    return undefined;
  }
  return HOSTED_RUNTIME_CATALOG[slug];
}

export function validateHostedRuntimeAllowlist(input: HostedRuntimeConfigInput): HostedRuntimeConfigValidation {
  const allowlist: HostedRuntimeModeSlug[] = [];
  for (const entry of input.allowlist) {
    if (!isKnownHostedRuntimeMode(entry)) {
      return { ok: false, code: "config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST" };
    }
    allowlist.push(entry);
  }

  if ((input.deploymentMode === "staging" || input.deploymentMode === "production") && allowlist.length === 0) {
    return { ok: false, code: "config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST" };
  }

  const hasRealMode = allowlist.some((mode) => isRealHostedRuntimeMode(mode));
  if (input.deploymentMode === "production" && input.realRuntimeExecution === "enabled") {
    return { ok: false, code: "config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION" };
  }
  if (input.deploymentMode === "production" && hasRealMode) {
    return { ok: false, code: "hosted_real_runtime_production_forbidden" };
  }
  if (hasRealMode && input.realRuntimeExecution !== "enabled") {
    return { ok: false, code: "hosted_real_runtime_disabled" };
  }

  return {
    ok: true,
    allowlist,
    deploymentMode: input.deploymentMode,
    realRuntimeExecution: input.realRuntimeExecution
  };
}

export function prepareHostedRunForExecution(input: HostedRunPreparationInput): HostedRunPreparationResult {
  const run = input.run;
  if (run.id !== input.queuePayload.runId) {
    return { ok: false, reasonCode: "hosted_run_state_invalid" };
  }
  if (input.queuePayload.placement && input.queuePayload.placement !== "hosted") {
    return { ok: false, reasonCode: "hosted_run_state_invalid" };
  }
  if (run.placement !== "hosted") {
    return { ok: false, reasonCode: "hosted_run_state_invalid" };
  }
  if (run.status !== "queued") {
    return { ok: false, reasonCode: "hosted_run_state_invalid" };
  }

  const runtimeMode = run.runtimeMode;
  if (!runtimeMode || !isKnownHostedRuntimeMode(runtimeMode)) {
    return { ok: false, reasonCode: "hosted_runtime_not_allowed" };
  }
  if (input.queuePayload.runtimeMode && input.queuePayload.runtimeMode !== runtimeMode) {
    return { ok: false, reasonCode: "hosted_run_state_invalid" };
  }
  if (!input.allowlist.includes(runtimeMode)) {
    return { ok: false, reasonCode: "hosted_runtime_not_allowed" };
  }

  const catalog = HOSTED_RUNTIME_CATALOG[runtimeMode];
  if (
    run.runtime !== catalog.runtime ||
    run.provider !== catalog.provider ||
    run.adapterType !== catalog.adapterType
  ) {
    return { ok: false, reasonCode: "hosted_run_state_invalid" };
  }

  if (catalog.requiresRealRuntimeGate) {
    if (input.realRuntimeExecution !== "enabled") {
      return { ok: false, reasonCode: "hosted_real_runtime_disabled" };
    }
    if (input.deploymentMode === "production") {
      return { ok: false, reasonCode: "hosted_real_runtime_production_forbidden" };
    }
  }

  if (runtimeMode !== "codex.exec_json") {
    return { ok: true, run };
  }

  const metadata = toRecord(run.metadata);
  const sandbox = metadata["sandbox"];
  if (typeof sandbox === "string" && CODEx_DENIED_SANDBOX_VALUES.has(sandbox)) {
    return { ok: false, reasonCode: "hosted_codex_sandbox_denied" };
  }

  for (const key of CODEx_DENIED_METADATA_KEYS) {
    if (key in metadata) {
      return { ok: false, reasonCode: "hosted_codex_sandbox_denied" };
    }
  }
  for (const key of Object.keys(metadata)) {
    if (key.toLowerCase().includes("pty") || key.toLowerCase().includes("terminal")) {
      return { ok: false, reasonCode: "hosted_codex_sandbox_denied" };
    }
  }

  const prepared: Run = {
    ...run,
    metadata: {
      ...metadata,
      sandbox: "read-only"
    }
  };

  return { ok: true, run: prepared };
}

export function hostedManifestForCatalog(entry: HostedRuntimeCatalogEntry): RuntimeAdapterManifest {
  return entry.manifest;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
