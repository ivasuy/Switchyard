import {
  PROVIDER_RUNTIME_MODES,
  providerRuntimeModeSchema,
  providerRuntimePolicySchema,
  type ProviderResolvedCommand,
  type ProviderRuntimeFailureCode,
  type ProviderRuntimeMode,
  type ProviderRuntimeModePolicy,
  type ProviderRuntimePolicy,
  type ProviderRuntimeSpendControls
} from "@switchyard/contracts";

export type ProviderRuntimePolicySourceState =
  | "ok"
  | "unreadable"
  | "empty"
  | "too_large"
  | "invalid_utf8"
  | "invalid_json";

export interface ProviderRuntimePolicyPathPayload {
  state: ProviderRuntimePolicySourceState;
  contents?: string | undefined;
}

export interface ProviderRuntimePolicyResolutionInput {
  deploymentMode: "local" | "test" | "staging" | "production";
  hostedRealRuntimeExecution: "enabled" | "disabled";
  hostedRuntimeAllowlist: readonly string[];
  policyJson?: string | undefined;
  policyPathContents?: string | ProviderRuntimePolicyPathPayload | undefined;
  env: Readonly<Record<string, string | undefined>>;
  binaryProbe?: ((input: { runtimeMode: ProviderRuntimeMode; executablePath: string }) => boolean) | undefined;
}

export type ProviderRuntimeActivationCode =
  | ProviderRuntimeFailureCode
  | "hosted_real_runtime_disabled"
  | "hosted_real_runtime_production_forbidden";

export interface ProviderRuntimeActivationReason {
  code: ProviderRuntimeActivationCode;
  runtimeMode?: ProviderRuntimeMode | undefined;
  detail?: "source_conflict" | "source_missing" | "policy_not_json_object" | "entry_missing" | "env_missing" | "binary_probe_failed" | "spend_controls_invalid" | "command_policy_invalid" | "mode_not_enabled" | undefined;
}

export interface ProviderRuntimeActivationResult {
  valid: boolean;
  enabledRealModes: ProviderRuntimeMode[];
  reasons: ProviderRuntimeActivationReason[];
  redactedSummary: {
    deploymentMode: ProviderRuntimePolicyResolutionInput["deploymentMode"];
    hostedRealRuntimeExecution: ProviderRuntimePolicyResolutionInput["hostedRealRuntimeExecution"];
    realModeCount: number;
    enabledRealModeCount: number;
    source: { kind: "none" | "json" | "path" };
    policyVersion?: number | undefined;
    modeStatuses: Array<{ runtimeMode: ProviderRuntimeMode; ready: boolean; reasons: ProviderRuntimeActivationCode[] }>;
    reasonCodes: ProviderRuntimeActivationCode[];
  };
  policy?: ProviderRuntimePolicy | undefined;
}

export interface ProviderRuntimePolicyResolutionResult {
  activation: ProviderRuntimeActivationResult;
  policy?: ProviderRuntimePolicy | undefined;
}

export interface ProviderRuntimeActivationInput {
  deploymentMode: ProviderRuntimePolicyResolutionInput["deploymentMode"];
  hostedRealRuntimeExecution: ProviderRuntimePolicyResolutionInput["hostedRealRuntimeExecution"];
  hostedRuntimeAllowlist: readonly string[];
  policy?: ProviderRuntimePolicy | undefined;
  env: Readonly<Record<string, string | undefined>>;
  binaryProbe?: ((input: { runtimeMode: ProviderRuntimeMode; executablePath: string }) => boolean) | undefined;
  sourceSummary?: ProviderRuntimeActivationResult["redactedSummary"]["source"] | undefined;
  policyVersion?: number | undefined;
}

export interface ProviderRuntimePolicyDenied {
  ok: false;
  code: ProviderRuntimeActivationCode;
  redactedSummary: Record<string, unknown>;
}

export interface ProviderRuntimePolicyAllowed {
  ok: true;
  command: ProviderResolvedCommand;
}

export interface BuildProviderResolvedCommandInput {
  activation: ProviderRuntimeActivationResult;
  runtimeMode: ProviderRuntimeMode;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  argv?: readonly string[] | undefined;
  metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface ProviderSpendControlsRunInput {
  activation: ProviderRuntimeActivationResult;
  runtimeMode: ProviderRuntimeMode;
  promptBytes: number;
  activeRuns: number;
  runsInPastHour: number;
  timeoutSeconds: number;
}

export type ProviderSpendControlsDecision =
  | { ok: true; redactedSummary: { runtimeMode: ProviderRuntimeMode; checks: string[] } }
  | { ok: false; code: "provider_prompt_too_large" | "provider_spend_limit_exceeded" | "provider_spend_controls_invalid"; redactedSummary: { runtimeMode: ProviderRuntimeMode; limit: string } };

type NormalizedPolicySource =
  | { kind: "none"; state: "none" }
  | { kind: "json"; state: Exclude<ProviderRuntimePolicySourceState, "unreadable">; contents?: string | undefined }
  | { kind: "path"; state: ProviderRuntimePolicySourceState; contents?: string | undefined };

const PROVIDER_REAL_MODE_SET = new Set<ProviderRuntimeMode>(PROVIDER_RUNTIME_MODES);
const WRAPPER_RUNTIME_MODE_SET = new Set<ProviderRuntimeMode>([
  "agentfield.async_rest",
  "generic_http.async_rest"
]);
const POLICY_MAX_BYTES = 65_536;
const METADATA_DENIED_KEYS = new Set([
  "command",
  "binary",
  "processfactory",
  "pty",
  "ptyconfig",
  "terminal",
  "tty",
  "argv",
  "args",
  "env",
  "cwd",
  "shell"
]);

export function resolveProviderRuntimePolicy(input: ProviderRuntimePolicyResolutionInput): ProviderRuntimePolicyResolutionResult {
  const source = normalizePolicySource(input.policyJson, input.policyPathContents);
  const unknownModes = getUnknownHostedRuntimeAllowlistModes(input.hostedRuntimeAllowlist);
  const realModes = getAllowlistedRealModes(input.hostedRuntimeAllowlist);
  const sourceSummary = summarizeSource(source);

  if (unknownModes.length > 0) {
    return {
      activation: buildFailureResult(input, realModes, sourceSummary, [{ code: "provider_runtime_policy_unknown_mode" }])
    };
  }

  if (input.hostedRealRuntimeExecution !== "enabled" && realModes.length > 0) {
    return {
      activation: buildFailureResult(input, realModes, sourceSummary, [{ code: "hosted_real_runtime_disabled" }])
    };
  }

  if (source.kind === "json" && input.policyPathContents !== undefined) {
    return {
      activation: buildFailureResult(input, realModes, sourceSummary, [
        { code: "provider_runtime_policy_malformed", detail: "source_conflict" }
      ])
    };
  }

  if (source.kind === "path" && source.state !== "ok") {
    const code = mapPathStateToFailureCode(source.state);
    if (requiresPolicy(input, realModes) || input.deploymentMode === "production") {
      return {
        activation: buildFailureResult(input, realModes, sourceSummary, [{ code }])
      };
    }
  }

  if (source.kind === "none") {
    if (requiresPolicy(input, realModes)) {
      return {
        activation: buildFailureResult(input, realModes, sourceSummary, [
          { code: "provider_runtime_policy_missing", detail: "source_missing" }
        ])
      };
    }

    return {
      activation: buildSuccessResult(input, [], sourceSummary, undefined)
    };
  }

  const payload = source.contents ?? "";
  const policyBytes = Buffer.byteLength(payload, "utf8");

  if (policyBytes > POLICY_MAX_BYTES) {
    return {
      activation: buildFailureResult(input, realModes, sourceSummary, [{ code: "provider_runtime_policy_malformed" }])
    };
  }

  const normalizedPayload = payload.trim();
  if (!normalizedPayload) {
    return {
      activation: buildFailureResult(input, realModes, sourceSummary, [{ code: "provider_runtime_policy_empty" }])
    };
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(normalizedPayload);
  } catch {
    return {
      activation: buildFailureResult(input, realModes, sourceSummary, [{ code: "provider_runtime_policy_malformed" }])
    };
  }

  if (!parsedRaw || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) {
    return {
      activation: buildFailureResult(input, realModes, sourceSummary, [
        { code: "provider_runtime_policy_malformed", detail: "policy_not_json_object" }
      ])
    };
  }

  const parsedPolicy = providerRuntimePolicySchema.safeParse(parsedRaw);
  if (!parsedPolicy.success) {
    const code = classifyPolicyParseFailure(parsedPolicy.error.issues);
    return {
      activation: buildFailureResult(input, realModes, sourceSummary, [{ code }])
    };
  }

  const activation = validateProviderRuntimeActivation({
    deploymentMode: input.deploymentMode,
    hostedRealRuntimeExecution: input.hostedRealRuntimeExecution,
    hostedRuntimeAllowlist: input.hostedRuntimeAllowlist,
    policy: parsedPolicy.data,
    env: input.env,
    binaryProbe: input.binaryProbe,
    sourceSummary,
    policyVersion: parsedPolicy.data.version
  });

  return {
    activation,
    policy: parsedPolicy.data
  };
}

export function validateProviderRuntimeActivation(input: ProviderRuntimeActivationInput): ProviderRuntimeActivationResult {
  const realModes = getAllowlistedRealModes(input.hostedRuntimeAllowlist);
  const source = input.sourceSummary ?? { kind: "none" };
  const unknownModes = getUnknownHostedRuntimeAllowlistModes(input.hostedRuntimeAllowlist);

  if (unknownModes.length > 0) {
    return buildFailureResult(input, realModes, source, [{ code: "provider_runtime_policy_unknown_mode" }], input.policyVersion);
  }

  if (input.hostedRealRuntimeExecution !== "enabled" && realModes.length > 0) {
    return buildFailureResult(input, realModes, source, [{ code: "hosted_real_runtime_disabled" }], input.policyVersion);
  }

  if (realModes.length === 0) {
    return buildSuccessResult(input, [], source, input.policy, input.policyVersion);
  }

  if (!input.policy) {
    return buildFailureResult(input, realModes, source, [{ code: "provider_runtime_policy_missing", detail: "source_missing" }], input.policyVersion);
  }

  const reasons: ProviderRuntimeActivationReason[] = [];
  const enabledModes: ProviderRuntimeMode[] = [];
  const modeStatuses = new Map<ProviderRuntimeMode, ProviderRuntimeActivationCode[]>();

  for (const runtimeMode of realModes) {
    const modeReasons: ProviderRuntimeActivationCode[] = [];
    const policyEntry = input.policy.modes[runtimeMode];

    if (!policyEntry) {
      modeReasons.push("provider_runtime_policy_missing");
      reasons.push({ code: "provider_runtime_policy_missing", runtimeMode, detail: "entry_missing" });
      modeStatuses.set(runtimeMode, modeReasons);
      continue;
    }

    if (!policyEntry.enabled) {
      modeReasons.push("provider_runtime_policy_disabled");
      reasons.push({ code: "provider_runtime_policy_disabled", runtimeMode, detail: "mode_not_enabled" });
      modeStatuses.set(runtimeMode, modeReasons);
      continue;
    }

    if (!isActivationPolicyValid(runtimeMode, policyEntry)) {
      modeReasons.push("provider_command_policy_invalid");
      reasons.push({ code: "provider_command_policy_invalid", runtimeMode, detail: "command_policy_invalid" });
    }

    if (!hasValidSpendControls(policyEntry.spendControls)) {
      modeReasons.push("provider_spend_controls_invalid");
      reasons.push({ code: "provider_spend_controls_invalid", runtimeMode, detail: "spend_controls_invalid" });
    }

    const requiredEnvKeys = getPolicyRequiredEnvKeys(runtimeMode, policyEntry);
    for (const requiredKey of requiredEnvKeys) {
      if (!isPresent(input.env[requiredKey])) {
        modeReasons.push("provider_credentials_missing");
        reasons.push({ code: "provider_credentials_missing", runtimeMode, detail: "env_missing" });
        break;
      }
    }

    if (isWrapperRuntimeMode(runtimeMode) && !isWrapperEndpointValid(input.env[getWrapperBaseUrlEnv(policyEntry)])) {
      modeReasons.push("provider_credentials_invalid");
      reasons.push({ code: "provider_credentials_invalid", runtimeMode, detail: "env_missing" });
    }

    if (
      input.binaryProbe &&
      isCommandRuntimeMode(runtimeMode, policyEntry) &&
      !input.binaryProbe({ runtimeMode, executablePath: policyEntry.executablePath })
    ) {
      modeReasons.push("provider_binary_unavailable");
      reasons.push({ code: "provider_binary_unavailable", runtimeMode, detail: "binary_probe_failed" });
    }

    modeStatuses.set(runtimeMode, modeReasons);

    if (modeReasons.length === 0) {
      enabledModes.push(runtimeMode);
    }
  }

  if (reasons.length > 0) {
    return {
      valid: false,
      enabledRealModes: [],
      reasons,
      redactedSummary: {
        deploymentMode: input.deploymentMode,
        hostedRealRuntimeExecution: input.hostedRealRuntimeExecution,
        realModeCount: realModes.length,
        enabledRealModeCount: 0,
        source,
        policyVersion: input.policyVersion,
        modeStatuses: realModes.map((runtimeMode) => ({
          runtimeMode,
          ready: (modeStatuses.get(runtimeMode)?.length ?? 0) === 0,
          reasons: modeStatuses.get(runtimeMode) ?? []
        })),
        reasonCodes: dedupeReasonCodes(reasons)
      },
      policy: input.policy
    };
  }

  return buildSuccessResult(input, enabledModes, source, input.policy, input.policyVersion);
}

export function buildProviderResolvedCommand(
  input: BuildProviderResolvedCommandInput
): ProviderRuntimePolicyAllowed | ProviderRuntimePolicyDenied {
  if (!input.activation.valid || !input.activation.policy) {
    return {
      ok: false,
      code: input.activation.reasons[0]?.code ?? "provider_runtime_policy_missing",
      redactedSummary: {
        runtimeMode: input.runtimeMode,
        reasonCode: input.activation.reasons[0]?.code ?? "provider_runtime_policy_missing"
      }
    };
  }

  const runtimeMode = input.runtimeMode;
  if (!input.activation.enabledRealModes.includes(runtimeMode)) {
    return {
      ok: false,
      code: "provider_command_denied",
      redactedSummary: {
        runtimeMode,
        reasonCode: "mode_not_enabled"
      }
    };
  }

  const policyEntry = input.activation.policy.modes[runtimeMode];
  if (!policyEntry || !policyEntry.enabled || !isCommandRuntimeMode(runtimeMode, policyEntry) || !isCommandPolicyValid(runtimeMode, policyEntry)) {
    return {
      ok: false,
      code: "provider_command_policy_invalid",
      redactedSummary: {
        runtimeMode,
        reasonCode: "policy_invalid"
      }
    };
  }

  if (!isCwdAllowedByPrefixes(input.cwd, policyEntry.cwdPrefixes)) {
    return {
      ok: false,
      code: "provider_command_denied",
      redactedSummary: {
        runtimeMode,
        reasonCode: "cwd_denied"
      }
    };
  }

  if (input.argv && input.argv.length > 0) {
    return {
      ok: false,
      code: "provider_command_denied",
      redactedSummary: {
        runtimeMode,
        reasonCode: "argv_denied"
      }
    };
  }

  if (hasDeniedMetadataKey(input.metadata)) {
    return {
      ok: false,
      code: "provider_command_denied",
      redactedSummary: {
        runtimeMode,
        reasonCode: "metadata_denied"
      }
    };
  }

  const filteredEnv: Record<string, string> = {};
  for (const envKey of policyEntry.envAllowlist) {
    const value = input.env[envKey];
    if (isPresent(value)) {
      filteredEnv[envKey] = value ? value.trim() : "";
    }
  }

  for (const requiredKey of policyEntry.requiredEnv) {
    if (!isPresent(filteredEnv[requiredKey])) {
      return {
        ok: false,
        code: "provider_credentials_missing",
        redactedSummary: {
          runtimeMode,
          reasonCode: "env_missing"
        }
      };
    }
  }

  const command: ProviderResolvedCommand = {
    runtimeMode,
    executablePath: policyEntry.executablePath,
    argv: fixedArgsForMode(runtimeMode, policyEntry),
    cwd: input.cwd,
    env: filteredEnv,
    envKeys: Object.keys(filteredEnv),
    allowUserArgs: false,
    redactedSummary: {
      runtimeMode,
      envKeys: Object.keys(filteredEnv),
      argvLength: fixedArgsForMode(runtimeMode, policyEntry).length,
      cwdAllowed: true
    }
  };

  return {
    ok: true,
    command
  };
}

export function checkProviderSpendControlsForRun(input: ProviderSpendControlsRunInput): ProviderSpendControlsDecision {
  if (!input.activation.valid || !input.activation.policy) {
    return {
      ok: false,
      code: "provider_spend_controls_invalid",
      redactedSummary: {
        runtimeMode: input.runtimeMode,
        limit: "activation_invalid"
      }
    };
  }

  const policyEntry = input.activation.policy.modes[input.runtimeMode];
  if (!policyEntry || !hasValidSpendControls(policyEntry.spendControls)) {
    return {
      ok: false,
      code: "provider_spend_controls_invalid",
      redactedSummary: {
        runtimeMode: input.runtimeMode,
        limit: "spend_controls_invalid"
      }
    };
  }

  if (input.promptBytes > policyEntry.spendControls.maxPromptBytes) {
    return {
      ok: false,
      code: "provider_prompt_too_large",
      redactedSummary: {
        runtimeMode: input.runtimeMode,
        limit: "maxPromptBytes"
      }
    };
  }

  if (input.activeRuns >= policyEntry.spendControls.maxActiveRuns) {
    return {
      ok: false,
      code: "provider_spend_limit_exceeded",
      redactedSummary: {
        runtimeMode: input.runtimeMode,
        limit: "maxActiveRuns"
      }
    };
  }

  if (input.runsInPastHour >= policyEntry.spendControls.maxRunsPerHour) {
    return {
      ok: false,
      code: "provider_spend_limit_exceeded",
      redactedSummary: {
        runtimeMode: input.runtimeMode,
        limit: "maxRunsPerHour"
      }
    };
  }

  if (input.timeoutSeconds > policyEntry.spendControls.maxRunTimeoutSeconds) {
    return {
      ok: false,
      code: "provider_spend_limit_exceeded",
      redactedSummary: {
        runtimeMode: input.runtimeMode,
        limit: "maxRunTimeoutSeconds"
      }
    };
  }

  return {
    ok: true,
    redactedSummary: {
      runtimeMode: input.runtimeMode,
      checks: ["maxPromptBytes", "maxActiveRuns", "maxRunsPerHour", "maxRunTimeoutSeconds"]
    }
  };
}

function normalizePolicySource(
  policyJson: string | undefined,
  policyPathContents: string | ProviderRuntimePolicyPathPayload | undefined
): NormalizedPolicySource {
  const normalizedJson = policyJson?.trim();

  if (normalizedJson !== undefined && policyPathContents !== undefined) {
    return {
      kind: "json",
      state: "invalid_json"
    };
  }

  if (normalizedJson !== undefined) {
    return {
      kind: "json",
      state: normalizedJson.length > 0 ? "ok" : "empty",
      contents: normalizedJson
    };
  }

  if (policyPathContents === undefined) {
    return {
      kind: "none",
      state: "none"
    };
  }

  if (typeof policyPathContents === "string") {
    const trimmed = policyPathContents.trim();
    return {
      kind: "path",
      state: trimmed.length > 0 ? "ok" : "empty",
      contents: trimmed
    };
  }

  if (policyPathContents.state !== "ok") {
    return {
      kind: "path",
      state: policyPathContents.state
    };
  }

  const contents = policyPathContents.contents?.trim() ?? "";
  return {
    kind: "path",
    state: contents.length > 0 ? "ok" : "empty",
    contents
  };
}

function mapPathStateToFailureCode(state: ProviderRuntimePolicySourceState): ProviderRuntimeFailureCode {
  if (state === "empty") {
    return "provider_runtime_policy_empty";
  }
  if (state === "unreadable") {
    return "provider_runtime_policy_missing";
  }
  return "provider_runtime_policy_malformed";
}

function summarizeSource(source: NormalizedPolicySource): ProviderRuntimeActivationResult["redactedSummary"]["source"] {
  return {
    kind: source.kind
  };
}

function classifyPolicyParseFailure(issues: Array<{ message: string; path: PropertyKey[] }>): ProviderRuntimeFailureCode {
  for (const issue of issues) {
    if (issue.message.startsWith("provider_runtime_policy_unknown_mode")) {
      return "provider_runtime_policy_unknown_mode";
    }
    if (issue.message.includes("provider_runtime_policy_empty")) {
      return "provider_runtime_policy_empty";
    }
    if (issue.message.includes("provider_command_policy_invalid")) {
      return "provider_command_policy_invalid";
    }

    if (
      issue.message.includes("Unrecognized key") &&
      issue.path.some((part) => part === "agentfield.async_rest" || part === "generic_http.async_rest")
    ) {
      return "provider_command_policy_invalid";
    }

    if (issue.path.includes("spendControls") || issue.path.includes("maxPromptBytes") || issue.path.includes("maxRunsPerHour") || issue.path.includes("maxActiveRuns") || issue.path.includes("maxRunTimeoutSeconds")) {
      return "provider_spend_controls_invalid";
    }
  }

  return "provider_runtime_policy_malformed";
}

function buildFailureResult(
  input: Pick<ProviderRuntimePolicyResolutionInput, "deploymentMode" | "hostedRealRuntimeExecution">,
  realModes: ProviderRuntimeMode[],
  source: ProviderRuntimeActivationResult["redactedSummary"]["source"],
  reasons: ProviderRuntimeActivationReason[],
  policyVersion?: number
): ProviderRuntimeActivationResult {
  const reasonCodes = dedupeReasonCodes(reasons);
  return {
    valid: false,
    enabledRealModes: [],
    reasons,
    redactedSummary: {
      deploymentMode: input.deploymentMode,
      hostedRealRuntimeExecution: input.hostedRealRuntimeExecution,
      realModeCount: realModes.length,
      enabledRealModeCount: 0,
      source,
      policyVersion,
      modeStatuses: realModes.map((runtimeMode) => ({ runtimeMode, ready: false, reasons: reasonCodes })),
      reasonCodes
    }
  };
}

function buildSuccessResult(
  input: Pick<ProviderRuntimePolicyResolutionInput, "deploymentMode" | "hostedRealRuntimeExecution">,
  enabledRealModes: ProviderRuntimeMode[],
  source: ProviderRuntimeActivationResult["redactedSummary"]["source"],
  policy: ProviderRuntimePolicy | undefined,
  policyVersion?: number
): ProviderRuntimeActivationResult {
  return {
    valid: true,
    enabledRealModes,
    reasons: [],
    redactedSummary: {
      deploymentMode: input.deploymentMode,
      hostedRealRuntimeExecution: input.hostedRealRuntimeExecution,
      realModeCount: enabledRealModes.length,
      enabledRealModeCount: enabledRealModes.length,
      source,
      policyVersion,
      modeStatuses: enabledRealModes.map((runtimeMode) => ({ runtimeMode, ready: true, reasons: [] })),
      reasonCodes: []
    },
    policy
  };
}

function dedupeReasonCodes(reasons: ProviderRuntimeActivationReason[]): ProviderRuntimeActivationCode[] {
  return [...new Set(reasons.map((reason) => reason.code))];
}

function getAllowlistedRealModes(allowlist: readonly string[]): ProviderRuntimeMode[] {
  const realModes: ProviderRuntimeMode[] = [];
  const seen = new Set<ProviderRuntimeMode>();

  for (const rawMode of allowlist) {
    const parsedMode = providerRuntimeModeSchema.safeParse(rawMode);
    if (!parsedMode.success) {
      continue;
    }

    if (!seen.has(parsedMode.data)) {
      seen.add(parsedMode.data);
      realModes.push(parsedMode.data);
    }
  }

  return realModes;
}

function getUnknownHostedRuntimeAllowlistModes(allowlist: readonly string[]): string[] {
  const unknownModes: string[] = [];
  for (const rawMode of allowlist) {
    if (rawMode === "fake.deterministic") {
      continue;
    }
    if (!providerRuntimeModeSchema.safeParse(rawMode).success) {
      unknownModes.push(rawMode);
    }
  }
  return unknownModes;
}

function requiresPolicy(
  input: Pick<ProviderRuntimePolicyResolutionInput, "deploymentMode" | "hostedRealRuntimeExecution">,
  realModes: readonly ProviderRuntimeMode[]
): boolean {
  return input.deploymentMode === "production" && input.hostedRealRuntimeExecution === "enabled" && realModes.length > 0;
}

function isActivationPolicyValid(runtimeMode: ProviderRuntimeMode, entry: ProviderRuntimeModePolicy): boolean {
  if (isWrapperRuntimeMode(runtimeMode)) {
    return isWrapperPolicyValid(runtimeMode, entry);
  }
  return isCommandPolicyValid(runtimeMode, entry);
}

function isCommandPolicyValid(runtimeMode: ProviderRuntimeMode, entry: ProviderRuntimeModePolicy): boolean {
  if (!isCommandRuntimeMode(runtimeMode, entry)) {
    return false;
  }
  if (!entry.enabled || entry.allowUserArgs) {
    return false;
  }
  if (!entry.executablePath.startsWith("/")) {
    return false;
  }
  if (entry.cwdPrefixes.length === 0 || entry.cwdPrefixes.some((prefix) => !prefix.startsWith("/"))) {
    return false;
  }

  if (runtimeMode === "codex.exec_json") {
    return (
      "fixedArgs" in entry &&
      entry.fixedArgs[0] === "exec" &&
      entry.fixedArgs[1] === "--json" &&
      "sandbox" in entry &&
      entry.sandbox === "read_only"
    );
  }

  if (runtimeMode === "claude_code.sdk") {
    if (!(("permissionMode" in entry) && entry.permissionMode === "read_only" && ("disabledTools" in entry))) {
      return false;
    }
    const disabled = new Set(entry.disabledTools);
    return disabled.has("Bash") && disabled.has("WebFetch") && disabled.has("WebSearch");
  }

  if (runtimeMode === "opencode.acp") {
    return (
      "fixedArgs" in entry &&
      entry.fixedArgs[0] === "acp" &&
      "onePromptPerRun" in entry &&
      entry.onePromptPerRun === true
    );
  }

  return PROVIDER_REAL_MODE_SET.has(runtimeMode);
}

function isWrapperPolicyValid(runtimeMode: ProviderRuntimeMode, entry: ProviderRuntimeModePolicy): boolean {
  if (!("baseUrlEnv" in entry) || !("auth" in entry)) {
    return false;
  }
  if (!entry.enabled || entry.auth.type !== "api_key") {
    return false;
  }
  if (runtimeMode === "agentfield.async_rest") {
    return "targetEnv" in entry;
  }
  if (runtimeMode === "generic_http.async_rest") {
    return !("targetEnv" in entry);
  }
  return false;
}

function isWrapperRuntimeMode(runtimeMode: ProviderRuntimeMode): boolean {
  return WRAPPER_RUNTIME_MODE_SET.has(runtimeMode);
}

function isCommandRuntimeMode(
  runtimeMode: ProviderRuntimeMode,
  entry: ProviderRuntimeModePolicy
): entry is Extract<ProviderRuntimeModePolicy, { executablePath: string }> {
  return !isWrapperRuntimeMode(runtimeMode) && "executablePath" in entry;
}

function getPolicyRequiredEnvKeys(runtimeMode: ProviderRuntimeMode, entry: ProviderRuntimeModePolicy): string[] {
  if (!isWrapperRuntimeMode(runtimeMode)) {
    return "requiredEnv" in entry ? [...entry.requiredEnv] : [];
  }

  if (!("baseUrlEnv" in entry) || !("auth" in entry)) {
    return [];
  }

  const keys = [entry.baseUrlEnv, entry.auth.env];
  if (runtimeMode === "agentfield.async_rest" && "targetEnv" in entry) {
    keys.push(entry.targetEnv);
  }
  return [...new Set(keys)];
}

function getWrapperBaseUrlEnv(entry: ProviderRuntimeModePolicy): string {
  return "baseUrlEnv" in entry ? entry.baseUrlEnv : "";
}

function isWrapperEndpointValid(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return false;
  }
  try {
    const parsed = new URL(normalized);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname) &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function hasValidSpendControls(controls: ProviderRuntimeSpendControls): boolean {
  return (
    Number.isInteger(controls.maxActiveRuns) && controls.maxActiveRuns > 0 &&
    Number.isInteger(controls.maxRunsPerHour) && controls.maxRunsPerHour > 0 &&
    Number.isInteger(controls.maxRunTimeoutSeconds) && controls.maxRunTimeoutSeconds > 0 &&
    Number.isInteger(controls.maxPromptBytes) && controls.maxPromptBytes > 0
  );
}

function fixedArgsForMode(runtimeMode: ProviderRuntimeMode, policy: ProviderRuntimeModePolicy): string[] {
  if (runtimeMode === "claude_code.sdk") {
    return [];
  }
  return "fixedArgs" in policy ? [...policy.fixedArgs] : [];
}

function isCwdAllowedByPrefixes(cwd: string, prefixes: readonly string[]): boolean {
  const normalizedCwd = normalizeAbsolutePath(cwd);
  if (!normalizedCwd) {
    return false;
  }

  for (const prefix of prefixes) {
    const normalizedPrefix = normalizeAbsolutePath(prefix);
    if (!normalizedPrefix) {
      continue;
    }
    if (normalizedCwd === normalizedPrefix || normalizedCwd.startsWith(`${normalizedPrefix}/`)) {
      return true;
    }
  }

  return false;
}

function normalizeAbsolutePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "") || "/";
}

function hasDeniedMetadataKey(metadata: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!metadata) {
    return false;
  }

  for (const key of Object.keys(metadata)) {
    const normalized = key.toLowerCase();
    if (METADATA_DENIED_KEYS.has(normalized) || normalized.includes("pty") || normalized.includes("terminal")) {
      return true;
    }
  }

  return false;
}

function isPresent(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}
