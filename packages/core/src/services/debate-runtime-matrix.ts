import type { AdapterType, Run } from "@switchyard/contracts";
import type { DebateChildRunKey } from "../ports/run-store.js";
import { DEBATE_CHILD_RUN_KEY_METADATA_FIELD } from "../ports/run-store.js";
import {
  getHostedRuntimeCatalogEntry,
  isKnownHostedRuntimeMode,
  isRealHostedRuntimeMode,
  type HostedRuntimeModeSlug
} from "./hosted-runtime-catalog.js";

export const FAKE_DEBATE_RUNTIME_DEFAULTS = {
  runtime: "fake",
  provider: "test",
  model: "test-model",
  adapterType: "process",
  runtimeMode: "fake.deterministic",
  placement: "local",
  realRuntimeOptIn: false
} as const;

export type DebateRunKind = "participant" | "judge";
export type DebateRuntimeErrorCode =
  | "invalid_input"
  | "debate_real_participant_opt_in_required"
  | "debate_participant_placement_required"
  | "debate_runtime_unsupported"
  | "hosted_codex_interactive_unshipped"
  | "agentfield_bridge_unshipped"
  | "generic_http_bridge_unshipped"
  | "repo_hosted_unshipped"
  | "browser_tool_unshipped";

export interface DebateRuntimeErrorDetail {
  path: string;
  issue: string;
}

export class DebateRuntimeMatrixError extends Error {
  readonly code: DebateRuntimeErrorCode;
  readonly details: DebateRuntimeErrorDetail[];

  constructor(code: DebateRuntimeErrorCode, message: string, details: DebateRuntimeErrorDetail[] = []) {
    super(message);
    this.name = "DebateRuntimeMatrixError";
    this.code = code;
    this.details = details;
  }
}

export interface DebateParticipantRuntimeInput {
  role?: unknown;
  runtime?: unknown;
  provider?: unknown;
  model?: unknown;
  adapterType?: unknown;
  runtimeMode?: unknown;
  placement?: unknown;
  realRuntimeOptIn?: unknown;
}

export interface NormalizeDebateRuntimeOptions {
  participantPath?: string;
}

export interface DebateParticipantRuntimeConfig {
  runtime: string;
  provider: string;
  model: string;
  adapterType: AdapterType;
  runtimeMode: HostedRuntimeModeSlug;
  placement: Run["placement"];
  realRuntimeOptIn: boolean;
  isRealRuntime: boolean;
}

export interface BuildDebateChildRunKeyInput {
  debateId: string;
  participantId?: string;
  judgeId?: string;
  debateRound: number;
  debatePhase: string;
  debateRunKind: DebateRunKind;
}

export interface BuildDebateChildRunMetadataInput extends BuildDebateChildRunKeyInput {
  participantRole?: string;
}

export interface DebateChildRunMetadata {
  debateId: string;
  debateRound: number;
  debatePhase: string;
  debateRunKind: DebateRunKind;
  debateChildRunKey: DebateChildRunKey;
  participantId?: string;
  participantRole?: string;
  judgeId?: string;
}

const FAKE_RUNTIME_MODE = FAKE_DEBATE_RUNTIME_DEFAULTS.runtimeMode;
const ALLOWED_DEBATE_RUNTIME_MODES = new Set<HostedRuntimeModeSlug>([
  "fake.deterministic",
  "codex.exec_json",
  "claude_code.sdk",
  "opencode.acp",
  "agentfield.async_rest",
  "generic_http.async_rest"
]);
const WRAPPER_DEBATE_RUNTIME_MODES = new Set<HostedRuntimeModeSlug>([
  "agentfield.async_rest",
  "generic_http.async_rest"
]);

export function isAllowedDebateRuntimeMode(value: string | undefined): value is HostedRuntimeModeSlug {
  return Boolean(value && ALLOWED_DEBATE_RUNTIME_MODES.has(value as HostedRuntimeModeSlug));
}

export function normalizeDebateRuntime(
  participant: DebateParticipantRuntimeInput,
  index: number,
  options: NormalizeDebateRuntimeOptions = {}
): DebateParticipantRuntimeConfig {
  const participantPath = options.participantPath ?? `participants.${index}`;
  const runtimeMode = normalizeStringField(participant.runtimeMode, FAKE_RUNTIME_MODE, `${participantPath}.runtimeMode`);
  const unsupportedCode = classifyUnsupportedDebateRuntime(participant, runtimeMode);
  if (unsupportedCode) {
    throw new DebateRuntimeMatrixError(unsupportedCode, `Debate runtime is not supported: ${runtimeMode}`, [
      { path: `${participantPath}.runtimeMode`, issue: "runtime mode is not admitted for hosted real debate execution" }
    ]);
  }
  if (!isAllowedDebateRuntimeMode(runtimeMode) || !isKnownHostedRuntimeMode(runtimeMode)) {
    throw new DebateRuntimeMatrixError("debate_runtime_unsupported", `Debate runtime is not supported: ${runtimeMode}`, [
      {
        path: `${participantPath}.runtimeMode`,
        issue: "must be fake.deterministic, codex.exec_json, claude_code.sdk, opencode.acp, agentfield.async_rest, or generic_http.async_rest"
      }
    ]);
  }

  if (runtimeMode === FAKE_RUNTIME_MODE) {
    return normalizeFakeRuntime(participant, participantPath);
  }

  const hasOptIn = participant.realRuntimeOptIn === true;
  if (!hasOptIn) {
    throw new DebateRuntimeMatrixError(
      "debate_real_participant_opt_in_required",
      "Real debate participants require realRuntimeOptIn: true",
      [{ path: `${participantPath}.realRuntimeOptIn`, issue: "must be true for non-fake debate participants" }]
    );
  }

  const placement = normalizeOptionalStringField(participant.placement, `${participantPath}.placement`);
  if (placement !== "hosted") {
    throw new DebateRuntimeMatrixError(
      "debate_participant_placement_required",
      "Real debate participants require placement: hosted",
      [{ path: `${participantPath}.placement`, issue: "must be hosted for non-fake debate participants" }]
    );
  }

  const catalog = getHostedRuntimeCatalogEntry(runtimeMode);
  if (!catalog || !isRealHostedRuntimeMode(runtimeMode)) {
    throw new DebateRuntimeMatrixError("debate_runtime_unsupported", `Debate runtime is not supported: ${runtimeMode}`, [
      { path: `${participantPath}.runtimeMode`, issue: "runtime mode is not an admitted real hosted debate runtime" }
    ]);
  }

  const runtime = normalizeStringField(participant.runtime, catalog.runtime, `${participantPath}.runtime`);
  const provider = normalizeStringField(participant.provider, catalog.provider, `${participantPath}.provider`);
  const model = normalizeStringField(participant.model, "model", `${participantPath}.model`);
  const adapterType = normalizeAdapterTypeField(participant.adapterType, catalog.adapterType, `${participantPath}.adapterType`);

  if (runtime !== catalog.runtime || provider !== catalog.provider || adapterType !== catalog.adapterType) {
    throw new DebateRuntimeMatrixError("debate_runtime_unsupported", `Debate runtime fields do not match ${runtimeMode}`, [
      { path: participantPath, issue: "runtime/provider/adapterType must match the hosted runtime catalog entry" }
    ]);
  }

  return {
    runtime,
    provider,
    model,
    adapterType,
    runtimeMode,
    placement: "hosted",
    realRuntimeOptIn: true,
    isRealRuntime: true
  };
}

export function buildDebateChildRunKey(input: BuildDebateChildRunKeyInput): DebateChildRunKey {
  const subject = input.participantId ?? input.judgeId ?? (input.debateRunKind === "judge" ? "judge" : undefined);
  if (!subject) {
    throw new DebateRuntimeMatrixError("invalid_input", "Participant child run keys require participantId", [
      { path: "participantId", issue: "required when debateRunKind is participant" }
    ]);
  }
  if (!Number.isInteger(input.debateRound) || input.debateRound < 0) {
    throw new DebateRuntimeMatrixError("invalid_input", "debateRound must be a non-negative integer", [
      { path: "debateRound", issue: "must be a non-negative integer" }
    ]);
  }
  const phase = input.debatePhase.trim();
  if (phase.length === 0) {
    throw new DebateRuntimeMatrixError("invalid_input", "debatePhase is required", [
      { path: "debatePhase", issue: "must be a non-empty string" }
    ]);
  }

  return [
    "debate-child",
    encodeKeyPart(input.debateId),
    encodeKeyPart(subject),
    String(input.debateRound),
    encodeKeyPart(phase),
    encodeKeyPart(input.debateRunKind)
  ].join(":");
}

export function buildDebateChildRunMetadata(input: BuildDebateChildRunMetadataInput): DebateChildRunMetadata {
  const key = buildDebateChildRunKey(input);
  const metadata: DebateChildRunMetadata = {
    debateId: input.debateId,
    debateRound: input.debateRound,
    debatePhase: input.debatePhase,
    debateRunKind: input.debateRunKind,
    debateChildRunKey: key
  };
  if (input.participantId !== undefined) {
    metadata.participantId = input.participantId;
  }
  if (input.participantRole !== undefined) {
    metadata.participantRole = input.participantRole;
  }
  if (input.judgeId !== undefined) {
    metadata.judgeId = input.judgeId;
  }
  return metadata;
}

export function getDebateChildRunKeyFromMetadata(metadata: Record<string, unknown> | undefined): DebateChildRunKey | undefined {
  const raw = metadata?.[DEBATE_CHILD_RUN_KEY_METADATA_FIELD];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function normalizeFakeRuntime(participant: DebateParticipantRuntimeInput, participantPath: string): DebateParticipantRuntimeConfig {
  const runtime = normalizeStringField(participant.runtime, FAKE_DEBATE_RUNTIME_DEFAULTS.runtime, `${participantPath}.runtime`);
  const provider = normalizeStringField(participant.provider, FAKE_DEBATE_RUNTIME_DEFAULTS.provider, `${participantPath}.provider`);
  const model = normalizeStringField(participant.model, FAKE_DEBATE_RUNTIME_DEFAULTS.model, `${participantPath}.model`);
  const adapterType = normalizeAdapterTypeField(participant.adapterType, FAKE_DEBATE_RUNTIME_DEFAULTS.adapterType, `${participantPath}.adapterType`);
  const placement = normalizePlacementField(participant.placement, FAKE_DEBATE_RUNTIME_DEFAULTS.placement, `${participantPath}.placement`);
  const realRuntimeOptIn = normalizeBooleanField(
    participant.realRuntimeOptIn,
    FAKE_DEBATE_RUNTIME_DEFAULTS.realRuntimeOptIn,
    `${participantPath}.realRuntimeOptIn`
  );

  if (
    runtime !== FAKE_DEBATE_RUNTIME_DEFAULTS.runtime ||
    provider !== FAKE_DEBATE_RUNTIME_DEFAULTS.provider ||
    model !== FAKE_DEBATE_RUNTIME_DEFAULTS.model ||
    adapterType !== FAKE_DEBATE_RUNTIME_DEFAULTS.adapterType
  ) {
    throw new DebateRuntimeMatrixError("debate_runtime_unsupported", "Fake debate participants must use fake.deterministic defaults", [
      { path: participantPath, issue: "runtime/provider/model/adapterType must match fake.deterministic defaults" }
    ]);
  }

  return {
    runtime,
    provider,
    model,
    adapterType,
    runtimeMode: FAKE_RUNTIME_MODE,
    placement,
    realRuntimeOptIn,
    isRealRuntime: false
  };
}

function classifyUnsupportedDebateRuntime(input: DebateParticipantRuntimeInput, runtimeMode: string): DebateRuntimeErrorCode | undefined {
  const haystack = [
    runtimeMode,
    stringOrEmpty(input.runtime),
    stringOrEmpty(input.provider),
    stringOrEmpty(input.model),
    stringOrEmpty(input.adapterType)
  ].join(" ").toLowerCase();

  if (runtimeMode === "codex.interactive" || haystack.includes("codex.interactive")) {
    return "hosted_codex_interactive_unshipped";
  }
  if (WRAPPER_DEBATE_RUNTIME_MODES.has(runtimeMode as HostedRuntimeModeSlug)) {
    return undefined;
  }
  if (haystack.includes("agentfield")) {
    return "agentfield_bridge_unshipped";
  }
  if (haystack.includes("generic_http") || haystack.includes("generic-http")) {
    return "generic_http_bridge_unshipped";
  }
  if (wordishIncludes(haystack, "repo")) {
    return "repo_hosted_unshipped";
  }
  if (wordishIncludes(haystack, "browser")) {
    return "browser_tool_unshipped";
  }
  if (
    wordishIncludes(haystack, "terminal") ||
    wordishIncludes(haystack, "shell") ||
    wordishIncludes(haystack, "sandbox") ||
    wordishIncludes(haystack, "pty") ||
    runtimeMode === "process" ||
    runtimeMode === "process.exec" ||
    runtimeMode === "generic.process"
  ) {
    return "debate_runtime_unsupported";
  }
  return undefined;
}

function normalizeStringField(value: unknown, fallback: string, path: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new DebateRuntimeMatrixError("invalid_input", `${path} must be a string`, [{ path, issue: "must be a string" }]);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DebateRuntimeMatrixError("invalid_input", `${path} must be a non-empty string`, [{ path, issue: "must be a non-empty string" }]);
  }
  return normalized;
}

function normalizeOptionalStringField(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return normalizeStringField(value, "", path);
}

function normalizeAdapterTypeField(value: unknown, fallback: AdapterType, path: string): AdapterType {
  const normalized = normalizeStringField(value, fallback, path);
  if (!isAdapterType(normalized)) {
    throw new DebateRuntimeMatrixError("invalid_input", `${path} must be a known adapter type`, [{ path, issue: "must be a known adapter type" }]);
  }
  return normalized;
}

function normalizePlacementField(value: unknown, fallback: Run["placement"], path: string): Run["placement"] {
  const normalized = normalizeStringField(value, fallback, path);
  if (normalized !== "local" && normalized !== "hosted" && normalized !== "connected_local_node") {
    throw new DebateRuntimeMatrixError("invalid_input", `${path} must be a known placement`, [{ path, issue: "must be a known placement" }]);
  }
  return normalized;
}

function normalizeBooleanField(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new DebateRuntimeMatrixError("invalid_input", `${path} must be a boolean`, [{ path, issue: "must be a boolean" }]);
  }
  return value;
}

function isAdapterType(value: string): value is AdapterType {
  return value === "native" || value === "acpx" || value === "http" || value === "webhook" || value === "process" || value === "pty" || value === "browser";
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function wordishIncludes(haystack: string, needle: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${needle}(?:$|[^a-z0-9])`, "i").test(haystack);
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "~");
}
