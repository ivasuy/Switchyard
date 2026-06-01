import type {
  AdapterType,
  Run,
  RuntimeCapability,
  RuntimeLimitation,
  RuntimeModeKind,
  RuntimePlacementFacts
} from "@switchyard/contracts";
import { providerRuntimeModeSchema, type ProviderRuntimeMode } from "@switchyard/contracts";
import type { RuntimeAdapterManifest } from "../ports/runtime-adapter.js";
import type { ProviderRuntimeActivationResult } from "./provider-runtime-policy.js";

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
    message: "Hosted execution is worker-owned and does not run provider sessions in the server process."
  },
  {
    code: "no_public_exec_routes",
    message: "No public /sandbox, /exec, /pty, or /terminal execution route is shipped."
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
        message: "codex.exec_json hosted execution is operator opt-in only."
      },
      {
        code: "codex_read_only_sandbox_required",
        message: "Hosted Codex runs require read-only sandbox metadata."
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
          message: "Hosted codex.exec_json is worker-owned and not available for server-local execution."
        },
        {
          code: "no_input_bridge",
          message: "Hosted codex.exec_json is one-shot and does not support post-start input."
        },
        {
          code: "no_approval_bridge",
          message: "Hosted codex.exec_json does not support runtime approval resolution."
        },
        {
          code: "production_forbidden",
          message: "Hosted codex.exec_json production execution is forbidden unless explicitly activated by provider policy."
        }
      ],
      placement: {
        local: { support: "supported", reason: "Local Codex CLI execution is supported." },
        hosted: { support: "conditional", reason: "Worker execution requires explicit operator opt-in and provider activation." },
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
        message: "claude_code.sdk hosted execution is operator opt-in only."
      },
      {
        code: "hosted_bridge_readiness_required",
        message: "Hosted Claude bridge support requires command store/outbox, ownership, quota/audit, worker readiness, session reconciliation, approval sender, and adapter capability readiness checks."
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
        "run.input",
        "run.cancel",
        "run.timeout",
        "session.state",
        "event.normalized",
        "event.streaming",
        "approval.bridge",
        "artifact.transcript",
        "artifact.raw_transcript",
        "auth.local"
      ],
      limitations: [
        {
          code: "hosted_bridge_readiness_required",
          message: "Hosted Claude bridge paths require bridge dependency readiness before admission."
        },
        {
          code: "hosted_worker_only",
          message: "Hosted claude_code.sdk is worker-owned and not available for server-local execution."
        },
        {
          code: "no_hosted_cancel_bridge",
          message: "Hosted active cancellation bridge is not shipped."
        },
        {
          code: "no_hosted_live_resume_guarantee",
          message: "Hosted Claude does not guarantee live resume continuity after worker or provider session loss."
        },
        {
          code: "production_forbidden",
          message: "Hosted claude_code.sdk production execution is forbidden unless explicitly activated by provider policy."
        }
      ],
      placement: {
        local: { support: "conditional", reason: "Requires local Claude Code tooling and auth." },
        hosted: { support: "conditional", reason: "Worker execution requires explicit operator opt-in and provider activation." },
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
        message: "opencode.acp hosted execution is operator opt-in only."
      },
      {
        code: "hosted_bridge_readiness_required",
        message: "Hosted OpenCode bridge support requires command store/outbox, ownership, quota/audit, worker readiness, session reconciliation, approval sender, and adapter capability readiness checks."
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
        "run.input",
        "run.cancel",
        "run.timeout",
        "session.state",
        "event.normalized",
        "event.streaming",
        "approval.bridge",
        "artifact.transcript",
        "artifact.raw_transcript",
        "auth.local"
      ],
      limitations: [
        {
          code: "hosted_bridge_readiness_required",
          message: "Hosted OpenCode bridge paths require bridge dependency readiness before admission."
        },
        {
          code: "hosted_worker_only",
          message: "Hosted opencode.acp is worker-owned and not available for server-local execution."
        },
        {
          code: "no_terminal_bridge",
          message: "Hosted terminal, PTY, and interactive screen-driving bridges are not shipped."
        },
        {
          code: "production_forbidden",
          message: "Hosted opencode.acp production execution is forbidden unless explicitly activated by provider policy."
        }
      ],
      placement: {
        local: { support: "conditional", reason: "Requires local OpenCode tooling and auth." },
        hosted: { support: "conditional", reason: "Worker execution requires explicit operator opt-in and provider activation." },
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
  providerActivation?: ProviderRuntimeActivationResult | undefined;
}

type HostedRuntimeConfigFailureCode =
  | "config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"
  | "config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"
  | "hosted_real_runtime_disabled"
  | "hosted_real_runtime_production_forbidden"
  | "provider_runtime_policy_missing"
  | "provider_runtime_policy_empty"
  | "provider_runtime_policy_malformed"
  | "provider_runtime_policy_unknown_mode"
  | "provider_runtime_policy_disabled"
  | "provider_command_policy_invalid"
  | "provider_binary_unavailable"
  | "provider_credentials_missing"
  | "provider_spend_controls_invalid";

export type HostedRuntimeConfigValidation =
  | {
    ok: true;
    allowlist: HostedRuntimeModeSlug[];
    deploymentMode: HostedDeploymentMode;
    realRuntimeExecution: HostedRealRuntimeExecution;
  }
  | {
    ok: false;
    code: HostedRuntimeConfigFailureCode;
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
  providerActivation?: ProviderRuntimeActivationResult | undefined;
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
  if (hasRealMode && input.realRuntimeExecution !== "enabled") {
    return { ok: false, code: "hosted_real_runtime_disabled" };
  }
  if (input.deploymentMode === "production" && hasRealMode) {
    if (!input.providerActivation || !input.providerActivation.valid) {
      return {
        ok: false,
        code: toHostedRuntimeValidationCode(input.providerActivation?.reasons[0]?.code)
      };
    }

    for (const runtimeMode of allowlist) {
      if (!isRealHostedRuntimeMode(runtimeMode)) {
        continue;
      }
      if (!isProviderRuntimeMode(runtimeMode)) {
        return { ok: false, code: "provider_runtime_policy_unknown_mode" };
      }
      if (!input.providerActivation.enabledRealModes.includes(runtimeMode)) {
        return { ok: false, code: "provider_runtime_policy_missing" };
      }
    }
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
    if (input.deploymentMode === "production" && !isHostedRuntimeProductionAllowed(runtimeMode, input.providerActivation)) {
      return { ok: false, reasonCode: input.providerActivation?.reasons[0]?.code ?? "provider_runtime_policy_missing" };
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

export function isHostedRuntimeProductionAllowed(
  slug: HostedRuntimeModeSlug,
  activation?: ProviderRuntimeActivationResult
): boolean {
  if (!HOSTED_RUNTIME_CATALOG[slug].requiresRealRuntimeGate) {
    return HOSTED_RUNTIME_CATALOG[slug].productionAllowed;
  }
  if (!isProviderRuntimeMode(slug)) {
    return false;
  }
  return Boolean(activation?.valid && activation.enabledRealModes.includes(slug));
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toHostedRuntimeValidationCode(
  code: ProviderRuntimeActivationResult["reasons"][number]["code"] | undefined
): HostedRuntimeConfigFailureCode {
  if (!code) {
    return "provider_runtime_policy_missing";
  }
  switch (code) {
    case "provider_runtime_policy_missing":
    case "provider_runtime_policy_empty":
    case "provider_runtime_policy_malformed":
    case "provider_runtime_policy_unknown_mode":
    case "provider_runtime_policy_disabled":
    case "provider_command_policy_invalid":
    case "provider_binary_unavailable":
    case "provider_credentials_missing":
    case "provider_spend_controls_invalid":
    case "hosted_real_runtime_disabled":
    case "hosted_real_runtime_production_forbidden":
      return code;
    default:
      return "provider_runtime_policy_missing";
  }
}

function isProviderRuntimeMode(value: string): value is ProviderRuntimeMode {
  return providerRuntimeModeSchema.safeParse(value).success;
}
