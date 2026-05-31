import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { redactSecrets } from "../packages/core/src/index.js";

type CanaryCode =
  | "canary_ok"
  | "auth_required"
  | "auth_invalid"
  | "invalid_base_url"
  | "provider_canary_config_missing"
  | "provider_canary_runtime_empty"
  | "provider_canary_create_denied"
  | "provider_canary_timeout"
  | "provider_canary_run_failed"
  | "provider_canary_artifact_missing"
  | "provider_canary_metrics_failed"
  | "provider_canary_audit_failed"
  | "ready_denied"
  | "run_create_denied"
  | "worker_timeout"
  | "artifact_missing"
  | "artifact_content_empty"
  | "artifact_digest_mismatch"
  | "metrics_auth_failed"
  | "audit_lookup_failed"
  | "unexpected_terminal_status"
  | "malformed_response"
  | "malformed_sse";

interface CanaryStep {
  name: string;
  status: "pass" | "fail" | "info";
  code: string;
  elapsedMs: number;
  httpStatus?: number;
  details?: Record<string, unknown>;
}

interface CanarySummary {
  baseUrl: string;
  checkedAt: string;
  elapsedMs: number;
  runId?: string;
  artifactId?: string;
  terminalStatus?: string;
  metricsAuthorized: boolean;
  auditEvidence: boolean;
  delayedAuditEvidence: boolean;
}

export interface ProductionCanaryResult {
  ok: boolean;
  code: CanaryCode;
  steps: CanaryStep[];
  summary: CanarySummary;
}

export interface ProductionCanaryOptions {
  baseUrl: string;
  apiKey?: string;
  runtimeMode?: string;
  confirmProviderSpend?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface ParsedCanaryArgs {
  baseUrl?: string;
  apiKey?: string;
  runtimeMode?: string;
  confirmProviderSpend: boolean;
  timeoutMs?: number;
  json: boolean;
}

interface ParsedSse {
  ok: true;
  events: unknown[];
}

interface FetchState {
  apiKey: string;
  fetchImpl: typeof fetch;
  baseUrl: string;
}

interface ProviderCanaryMode {
  kind: "fake" | "provider";
  runtimeMode?: "codex.exec_json" | "claude_code.sdk" | "opencode.acp";
}

const TERMINAL_FAILURE_STATUSES = new Set(["failed", "cancelled", "timed_out", "timeout"]);
const RUNNING_STATUSES = new Set(["queued", "starting", "running", "waiting_for_input", "waiting_for_approval"]);
const ALLOWED_CANARY_PATHS = new Set([
  "/ready",
  "/runs",
  "/metrics",
  "/auth/whoami",
  "/entitlements",
  "/audit/events"
]);

function isAllowedRunPath(pathname: string): boolean {
  if (ALLOWED_CANARY_PATHS.has(pathname)) {
    return true;
  }
  if (/^\/runs\/[^/]+$/.test(pathname)) {
    return true;
  }
  if (/^\/runs\/[^/]+\/events$/.test(pathname)) {
    return true;
  }
  if (/^\/runs\/[^/]+\/artifacts$/.test(pathname)) {
    return true;
  }
  if (/^\/artifacts\/[^/]+\/content$/.test(pathname)) {
    return true;
  }
  return false;
}

export async function runProductionCanary(options: ProductionCanaryOptions): Promise<ProductionCanaryResult> {
  const now = options.now ?? (() => Date.now());
  const startedAtMs = now();
  const steps: CanaryStep[] = [];
  const apiKey = options.apiKey ?? process.env["SWITCHYARD_CANARY_API_KEY"];
  const canaryMode = resolveCanaryMode(options.runtimeMode);
  const parsedBase = parseBaseUrl(options.baseUrl);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);

  const summary: CanarySummary = {
    baseUrl: parsedBase.ok ? parsedBase.value : "invalid",
    checkedAt: new Date(startedAtMs).toISOString(),
    elapsedMs: 0,
    metricsAuthorized: false,
    auditEvidence: false,
    delayedAuditEvidence: false
  };

  if (!canaryMode.ok) {
    addStep(steps, now, startedAtMs, "input.runtime", "fail", canaryMode.code);
    return finalize(false, canaryMode.code, steps, summary, now, startedAtMs);
  }

  if (canaryMode.mode.kind === "provider" && !options.confirmProviderSpend) {
    addStep(steps, now, startedAtMs, "input.confirmation", "fail", "provider_canary_config_missing");
    return finalize(false, "provider_canary_config_missing", steps, summary, now, startedAtMs);
  }

  if (!apiKey || apiKey.trim().length === 0) {
    if (canaryMode.mode.kind === "provider") {
      addStep(steps, now, startedAtMs, "input.auth", "fail", "provider_canary_config_missing");
      return finalize(false, "provider_canary_config_missing", steps, summary, now, startedAtMs);
    }
    addStep(steps, now, startedAtMs, "input.auth", "fail", "auth_required");
    return finalize(false, "auth_required", steps, summary, now, startedAtMs);
  }

  if (!parsedBase.ok) {
    if (canaryMode.mode.kind === "provider") {
      addStep(steps, now, startedAtMs, "input.baseUrl", "fail", "provider_canary_config_missing");
      return finalize(false, "provider_canary_config_missing", steps, summary, now, startedAtMs);
    }
    addStep(steps, now, startedAtMs, "input.baseUrl", "fail", "invalid_base_url");
    return finalize(false, "invalid_base_url", steps, summary, now, startedAtMs);
  }

    const state: FetchState = {
      apiKey: apiKey.trim(),
      fetchImpl: options.fetchImpl ?? fetch,
      baseUrl: parsedBase.value
  };

  try {
    const whoami = await fetchJson(state, "GET", "/auth/whoami");
    if (!whoami.ok) {
      return failFromHttp("whoami", whoami.status, steps, summary, now, startedAtMs);
    }
    addStep(steps, now, startedAtMs, "whoami", "pass", "auth_validated", { httpStatus: whoami.status });

    const entitlements = await fetchJson(state, "GET", "/entitlements");
    if (!entitlements.ok) {
      return failFromHttp("entitlements", entitlements.status, steps, summary, now, startedAtMs);
    }
    addStep(steps, now, startedAtMs, "entitlements", "pass", "entitlements_loaded", { httpStatus: entitlements.status });

    const ready = await fetchJson(state, "GET", "/ready");
    if (!ready.ok) {
      if (ready.status === 503) {
        addStep(steps, now, startedAtMs, "ready", "fail", "ready_denied", {
          httpStatus: ready.status,
          details: ready.json ? extractReadyCodes(ready.json) : undefined
        });
        return finalize(false, "ready_denied", steps, summary, now, startedAtMs);
      }
      return failFromHttp("ready", ready.status, steps, summary, now, startedAtMs);
    }
    if (!isReadyOk(ready.json)) {
      addStep(steps, now, startedAtMs, "ready", "fail", "ready_denied", {
        httpStatus: ready.status,
        details: extractReadyCodes(ready.json)
      });
      return finalize(false, "ready_denied", steps, summary, now, startedAtMs);
    }
    addStep(steps, now, startedAtMs, "ready", "pass", "ready_ok", { httpStatus: ready.status });

    const canaryId = `${canaryMode.mode.kind === "provider" ? "r21-provider" : "r19"}-${randomUUID()}`;
    const startedAtIso = new Date(startedAtMs).toISOString();
    const createPayload = {
      ...buildRunShape(canaryMode.mode),
      placement: "hosted",
      cwd: "/repo",
      task: canaryMode.mode.kind === "provider" ? `r21 provider canary ${canaryMode.mode.runtimeMode}` : "r19 production canary",
      metadata: {
        switchyardCanary: canaryMode.mode.kind === "provider" ? "r21-provider-production" : "r19-production",
        canaryId,
        startedAt: startedAtIso,
        ...(canaryMode.mode.kind === "provider" ? { runtimeMode: canaryMode.mode.runtimeMode } : {})
      }
    };

    const created = await fetchJson(state, "POST", "/runs", createPayload);
    if (!created.ok) {
      if (canaryMode.mode.kind === "provider") {
        addStep(steps, now, startedAtMs, "run.create", "fail", "provider_canary_create_denied", { httpStatus: created.status });
        return finalize(false, "provider_canary_create_denied", steps, summary, now, startedAtMs);
      }
      if (created.status === 403) {
        addStep(steps, now, startedAtMs, "run.create", "fail", "run_create_denied", { httpStatus: created.status });
        return finalize(false, "run_create_denied", steps, summary, now, startedAtMs);
      }
      return failFromHttp("run.create", created.status, steps, summary, now, startedAtMs, "run_create_denied");
    }

    const runId = readRunId(created.json);
    if (!runId) {
      addStep(steps, now, startedAtMs, "run.create", "fail", "malformed_response", { httpStatus: created.status });
      return finalize(false, "malformed_response", steps, summary, now, startedAtMs);
    }
    summary.runId = runId;
    addStep(steps, now, startedAtMs, "run.create", "pass", "run_created", { httpStatus: created.status, details: { runId } });

    const runDeadline = startedAtMs + timeoutMs;
    let terminalStatus: string | undefined;
    while (now() <= runDeadline) {
      const detail = await fetchJson(state, "GET", `/runs/${encodeURIComponent(runId)}`);
      if (!detail.ok) {
        return failFromHttp("run.poll", detail.status, steps, summary, now, startedAtMs);
      }
      const status = readRunStatus(detail.json);
      if (!status) {
        addStep(steps, now, startedAtMs, "run.poll", "fail", "malformed_response", { httpStatus: detail.status });
        return finalize(false, "malformed_response", steps, summary, now, startedAtMs);
      }
      terminalStatus = status;
      if (status === "completed") {
        summary.terminalStatus = status;
        addStep(steps, now, startedAtMs, "run.poll", "pass", "run_completed", {
          httpStatus: detail.status,
          details: { runId }
        });
        break;
      }
      if (TERMINAL_FAILURE_STATUSES.has(status)) {
        summary.terminalStatus = status;
        addStep(steps, now, startedAtMs, "run.poll", "fail", canaryMode.mode.kind === "provider" ? "provider_canary_run_failed" : "unexpected_terminal_status", {
          httpStatus: detail.status,
          details: { runId, terminalStatus: status }
        });
        return finalize(false, canaryMode.mode.kind === "provider" ? "provider_canary_run_failed" : "unexpected_terminal_status", steps, summary, now, startedAtMs);
      }
      if (!RUNNING_STATUSES.has(status)) {
        summary.terminalStatus = status;
        addStep(steps, now, startedAtMs, "run.poll", "fail", canaryMode.mode.kind === "provider" ? "provider_canary_run_failed" : "unexpected_terminal_status", {
          httpStatus: detail.status,
          details: { runId, terminalStatus: status }
        });
        return finalize(false, canaryMode.mode.kind === "provider" ? "provider_canary_run_failed" : "unexpected_terminal_status", steps, summary, now, startedAtMs);
      }
    }

    if (summary.terminalStatus !== "completed") {
      summary.terminalStatus = terminalStatus;
      addStep(steps, now, startedAtMs, "run.poll", "fail", canaryMode.mode.kind === "provider" ? "provider_canary_timeout" : "worker_timeout", {
        details: { runId }
      });
      return finalize(false, canaryMode.mode.kind === "provider" ? "provider_canary_timeout" : "worker_timeout", steps, summary, now, startedAtMs);
    }

    const sseReplay = await fetchText(state, "GET", `/runs/${encodeURIComponent(runId)}/events`);
    if (!sseReplay.ok) {
      return failFromHttp("run.events", sseReplay.status, steps, summary, now, startedAtMs);
    }

    const parsedSse = parseSseReplay(sseReplay.text);
    if (!parsedSse.ok || parsedSse.events.length === 0) {
      addStep(steps, now, startedAtMs, "run.events", "fail", "malformed_sse", { httpStatus: sseReplay.status, details: { runId } });
      return finalize(false, "malformed_sse", steps, summary, now, startedAtMs);
    }
    addStep(steps, now, startedAtMs, "run.events", "pass", "sse_replay_ok", {
      httpStatus: sseReplay.status,
      details: { runId, eventCount: parsedSse.events.length }
    });

    const artifacts = await fetchJson(state, "GET", `/runs/${encodeURIComponent(runId)}/artifacts`);
    if (!artifacts.ok) {
      if (artifacts.status === 404) {
        const code = canaryMode.mode.kind === "provider" ? "provider_canary_artifact_missing" : "artifact_missing";
        addStep(steps, now, startedAtMs, "artifact.list", "fail", code, { httpStatus: artifacts.status, details: { runId } });
        return finalize(false, code, steps, summary, now, startedAtMs);
      }
      return failFromHttp("artifact.list", artifacts.status, steps, summary, now, startedAtMs);
    }

    const artifact = readFirstArtifact(artifacts.json);
    if (!artifact) {
      const code = canaryMode.mode.kind === "provider" ? "provider_canary_artifact_missing" : "artifact_missing";
      addStep(steps, now, startedAtMs, "artifact.list", "fail", code, { httpStatus: artifacts.status, details: { runId } });
      return finalize(false, code, steps, summary, now, startedAtMs);
    }

    summary.artifactId = artifact.id;
    addStep(steps, now, startedAtMs, "artifact.list", "pass", "artifact_found", {
      httpStatus: artifacts.status,
      details: { runId, artifactId: artifact.id }
    });

    const content = await fetchBytes(state, "GET", `/artifacts/${encodeURIComponent(artifact.id)}/content`);
    if (!content.ok) {
      if (content.status === 404) {
        const code = canaryMode.mode.kind === "provider" ? "provider_canary_artifact_missing" : "artifact_missing";
        addStep(steps, now, startedAtMs, "artifact.content", "fail", code, {
          httpStatus: content.status,
          details: { artifactId: artifact.id }
        });
        return finalize(false, code, steps, summary, now, startedAtMs);
      }
      return failFromHttp("artifact.content", content.status, steps, summary, now, startedAtMs);
    }

    if (content.bytes.byteLength === 0) {
      const code = canaryMode.mode.kind === "provider" ? "provider_canary_artifact_missing" : "artifact_content_empty";
      addStep(steps, now, startedAtMs, "artifact.content", "fail", code, {
        httpStatus: content.status,
        details: { artifactId: artifact.id }
      });
      return finalize(false, code, steps, summary, now, startedAtMs);
    }

    if (!artifactDigestAndSizeMatch(artifact, content.bytes)) {
      const code = canaryMode.mode.kind === "provider" ? "provider_canary_artifact_missing" : "artifact_digest_mismatch";
      addStep(steps, now, startedAtMs, "artifact.content", "fail", code, {
        httpStatus: content.status,
        details: { artifactId: artifact.id }
      });
      return finalize(false, code, steps, summary, now, startedAtMs);
    }

    addStep(steps, now, startedAtMs, "artifact.content", "pass", "artifact_content_verified", {
      httpStatus: content.status,
      details: { artifactId: artifact.id, bytes: content.bytes.byteLength }
    });

    const metrics = await fetchJson(state, "GET", "/metrics");
    if (!metrics.ok) {
      if (canaryMode.mode.kind === "provider") {
        addStep(steps, now, startedAtMs, "metrics", "fail", "provider_canary_metrics_failed", { httpStatus: metrics.status });
        return finalize(false, "provider_canary_metrics_failed", steps, summary, now, startedAtMs);
      }
      if (metrics.status === 401 || metrics.status === 403) {
        addStep(steps, now, startedAtMs, "metrics", "fail", "metrics_auth_failed", { httpStatus: metrics.status });
        return finalize(false, "metrics_auth_failed", steps, summary, now, startedAtMs);
      }
      return failFromHttp("metrics", metrics.status, steps, summary, now, startedAtMs);
    }
    if (canaryMode.mode.kind === "provider" && !hasProviderMetricsEvidence(metrics.json, canaryMode.mode.runtimeMode)) {
      addStep(steps, now, startedAtMs, "metrics", "fail", "provider_canary_metrics_failed", { httpStatus: metrics.status });
      return finalize(false, "provider_canary_metrics_failed", steps, summary, now, startedAtMs);
    }
    summary.metricsAuthorized = true;
    addStep(steps, now, startedAtMs, "metrics", "pass", "metrics_ok", { httpStatus: metrics.status });

    const auditWindowMs = Math.max(250, Math.min(Math.floor(timeoutMs / 3), 2_000));
    const auditDeadline = Math.min(runDeadline, now() + auditWindowMs);
    let auditAttempts = 0;
    while (now() <= auditDeadline) {
      const audit = await fetchJson(state, "GET", "/audit/events?limit=50");
      if (!audit.ok) {
        if (canaryMode.mode.kind === "provider") {
          addStep(steps, now, startedAtMs, "audit", "fail", "provider_canary_audit_failed", { httpStatus: audit.status });
          return finalize(false, "provider_canary_audit_failed", steps, summary, now, startedAtMs);
        }
        return failFromHttp("audit", audit.status, steps, summary, now, startedAtMs);
      }
      const matched = hasAuditEvidence(audit.json, runId, canaryId, canaryMode.mode.kind === "provider");
      if (matched) {
        summary.auditEvidence = true;
        if (auditAttempts > 0) {
          summary.delayedAuditEvidence = true;
          addStep(steps, now, startedAtMs, "audit", "info", "delayed_audit_evidence", {
            httpStatus: audit.status,
            details: { runId, attempts: auditAttempts + 1 }
          });
        }
        addStep(steps, now, startedAtMs, "audit", "pass", "audit_evidence_found", {
          httpStatus: audit.status,
          details: { runId }
        });
        return finalize(true, "canary_ok", steps, summary, now, startedAtMs);
      }
      auditAttempts += 1;
    }

    addStep(steps, now, startedAtMs, "audit", "fail", "audit_lookup_failed", {
      details: { runId }
    });
    if (canaryMode.mode.kind === "provider") {
      return finalize(false, "provider_canary_audit_failed", steps, summary, now, startedAtMs);
    }
    return finalize(false, "audit_lookup_failed", steps, summary, now, startedAtMs);
  } catch {
    addStep(steps, now, startedAtMs, "canary", "fail", "malformed_response");
    return finalize(false, "malformed_response", steps, summary, now, startedAtMs);
  }
}

function parseCliArgs(argv: string[]): ParsedCanaryArgs {
  const parsed: ParsedCanaryArgs = { json: false, confirmProviderSpend: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token === "--base-url") {
      parsed.baseUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--api-key") {
      parsed.apiKey = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--timeout-ms") {
      const raw = argv[index + 1];
      index += 1;
      if (raw !== undefined) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric)) {
          parsed.timeoutMs = Math.floor(numeric);
        }
      }
      continue;
    }
    if (token === "--runtime-mode") {
      parsed.runtimeMode = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--confirm-provider-spend") {
      parsed.confirmProviderSpend = true;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
  }
  return parsed;
}

function normalizeTimeoutMs(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input) || input <= 0) {
    return 30_000;
  }
  return Math.floor(input);
}

function resolveCanaryMode(
  runtimeMode: string | undefined
): { ok: true; mode: ProviderCanaryMode } | { ok: false; code: "provider_canary_runtime_empty" } {
  if (runtimeMode === undefined) {
    return { ok: true, mode: { kind: "fake" } };
  }
  const normalized = runtimeMode.trim();
  if (normalized.length === 0) {
    return { ok: false, code: "provider_canary_runtime_empty" };
  }
  if (normalized === "codex.exec_json" || normalized === "claude_code.sdk" || normalized === "opencode.acp") {
    return {
      ok: true,
      mode: {
        kind: "provider",
        runtimeMode: normalized
      }
    };
  }
  return { ok: false, code: "provider_canary_runtime_empty" };
}

function parseBaseUrl(input: string): { ok: true; value: string } | { ok: false } {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false };
    }
    if (parsed.username || parsed.password) {
      return { ok: false };
    }
    if (!parsed.hostname || parsed.hostname.trim().length === 0) {
      return { ok: false };
    }

    const normalizedPath = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : "";
    return { ok: true, value: `${parsed.origin}${normalizedPath}` };
  } catch {
    return { ok: false };
  }
}

function addStep(
  steps: CanaryStep[],
  now: () => number,
  startedAtMs: number,
  name: string,
  status: "pass" | "fail" | "info",
  code: string,
  extra: { httpStatus?: number; details?: Record<string, unknown> } = {}
): void {
  steps.push({
    name,
    status,
    code,
    elapsedMs: Math.max(0, now() - startedAtMs),
    ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    ...(extra.details ? { details: sanitizeForOutput(extra.details) } : {})
  });
}

function finalize(
  ok: boolean,
  code: CanaryCode,
  steps: CanaryStep[],
  summary: CanarySummary,
  now: () => number,
  startedAtMs: number
): ProductionCanaryResult {
  return {
    ok,
    code,
    steps,
    summary: {
      ...summary,
      elapsedMs: Math.max(0, now() - startedAtMs)
    }
  };
}

function sanitizeForOutput(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSecrets(value) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(redacted)) {
    if (key === "task" || key === "cwd" || key === "path" || key === "content" || key === "payload" || key === "raw" || key === "bytes") {
      continue;
    }
    out[key] = entry;
  }
  return out;
}

function buildRunShape(
  mode: ProviderCanaryMode
): {
  runtime: string;
  provider: string;
  model: string;
  adapterType: "process" | "native" | "acpx";
  runtimeMode: string;
} {
  if (mode.kind !== "provider") {
    return {
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      runtimeMode: "fake.deterministic"
    };
  }
  if (mode.runtimeMode === "codex.exec_json") {
    return {
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      runtimeMode: "codex.exec_json"
    };
  }
  if (mode.runtimeMode === "claude_code.sdk") {
    return {
      runtime: "claude_code",
      provider: "anthropic",
      model: "claude-code",
      adapterType: "native",
      runtimeMode: "claude_code.sdk"
    };
  }
  return {
    runtime: "opencode",
    provider: "opencode",
    model: "opencode-default",
    adapterType: "acpx",
    runtimeMode: "opencode.acp"
  };
}

function authHeaders(apiKey: string): HeadersInit {
  return {
    authorization: `Bearer ${apiKey}`,
    "x-switchyard-api-key": apiKey,
    "content-type": "application/json"
  };
}

async function fetchJson(
  state: FetchState,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<{ ok: true; status: number; json: unknown } | { ok: false; status: number; json?: unknown }> {
  const response = await fetchRoute(state, method, path, body);
  if (response.status === 401) {
    return { ok: false, status: 401 };
  }
  if (response.status === 403 && path === "/metrics") {
    return { ok: false, status: 403 };
  }
  if (!response.ok) {
    if (response.status === 403 && path === "/runs") {
      return { ok: false, status: 403 };
    }
    return { ok: false, status: response.status };
  }

  const text = await response.text();
  if (text.trim().length === 0) {
    return { ok: false, status: response.status };
  }

  try {
    const parsed = JSON.parse(text);
    return { ok: true, status: response.status, json: parsed };
  } catch {
    return { ok: false, status: response.status };
  }
}

async function fetchText(
  state: FetchState,
  method: "GET",
  path: string
): Promise<{ ok: true; status: number; text: string } | { ok: false; status: number }> {
  const response = await fetchRoute(state, method, path);
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  return {
    ok: true,
    status: response.status,
    text: await response.text()
  };
}

async function fetchBytes(
  state: FetchState,
  method: "GET",
  path: string
): Promise<{ ok: true; status: number; bytes: Uint8Array } | { ok: false; status: number }> {
  const response = await fetchRoute(state, method, path);
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  const buffer = await response.arrayBuffer();
  return {
    ok: true,
    status: response.status,
    bytes: new Uint8Array(buffer)
  };
}

async function fetchRoute(state: FetchState, method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  const url = new URL(path, `${state.baseUrl}/`);
  if (!isAllowedRunPath(url.pathname)) {
    throw new Error(`route_forbidden:${url.pathname}`);
  }
  const init: RequestInit = {
    method,
    headers: authHeaders(state.apiKey)
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return state.fetchImpl(url.toString(), init);
}

function failFromHttp(
  step: string,
  status: number,
  steps: CanaryStep[],
  summary: CanarySummary,
  now: () => number,
  startedAtMs: number,
  defaultFailureCode: CanaryCode = "malformed_response"
): ProductionCanaryResult {
  if (status === 401 || status === 403) {
    if (step === "metrics") {
      addStep(steps, now, startedAtMs, step, "fail", "metrics_auth_failed", { httpStatus: status });
      return finalize(false, "metrics_auth_failed", steps, summary, now, startedAtMs);
    }
    if (step === "run.create" && status === 403) {
      addStep(steps, now, startedAtMs, step, "fail", "run_create_denied", { httpStatus: status });
      return finalize(false, "run_create_denied", steps, summary, now, startedAtMs);
    }
    addStep(steps, now, startedAtMs, step, "fail", "auth_invalid", { httpStatus: status });
    return finalize(false, "auth_invalid", steps, summary, now, startedAtMs);
  }

  if (step === "ready" && status === 503) {
    addStep(steps, now, startedAtMs, step, "fail", "ready_denied", { httpStatus: status });
    return finalize(false, "ready_denied", steps, summary, now, startedAtMs);
  }

  if ((step === "artifact.list" || step === "artifact.content") && status === 404) {
    addStep(steps, now, startedAtMs, step, "fail", "artifact_missing", { httpStatus: status });
    return finalize(false, "artifact_missing", steps, summary, now, startedAtMs);
  }

  addStep(steps, now, startedAtMs, step, "fail", defaultFailureCode, { httpStatus: status });
  return finalize(false, defaultFailureCode, steps, summary, now, startedAtMs);
}

function readRunId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const run = (value as Record<string, unknown>)["run"];
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    return null;
  }
  const id = (run as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

function readRunStatus(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const run = (value as Record<string, unknown>)["run"];
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    return null;
  }
  const status = (run as Record<string, unknown>)["status"];
  return typeof status === "string" && status.length > 0 ? status : null;
}

function parseSseReplay(body: string): ParsedSse | { ok: false } {
  if (body.trim().length === 0) {
    return { ok: false };
  }

  const events: unknown[] = [];
  let dataLines: string[] = [];

  const flush = (): boolean => {
    if (dataLines.length === 0) {
      return true;
    }
    const raw = dataLines.join("\n");
    dataLines = [];
    try {
      events.push(JSON.parse(raw));
      return true;
    } catch {
      return false;
    }
  };

  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
    if (line.trim().length === 0) {
      if (!flush()) {
        return { ok: false };
      }
    }
  }

  if (!flush()) {
    return { ok: false };
  }

  if (events.length === 0) {
    return { ok: false };
  }

  return { ok: true, events };
}

function readFirstArtifact(value: unknown): { id: string; metadata?: Record<string, unknown> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const artifacts = (value as Record<string, unknown>)["artifacts"];
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return null;
  }
  const first = artifacts[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return null;
  }
  const id = (first as Record<string, unknown>)["id"];
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  const rawMetadata = (first as Record<string, unknown>)["metadata"];
  const metadata = rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
    ? rawMetadata as Record<string, unknown>
    : undefined;
  return { id, metadata };
}

function artifactDigestAndSizeMatch(
  artifact: { metadata?: Record<string, unknown> },
  bytes: Uint8Array
): boolean {
  const metadata = artifact.metadata;
  if (!metadata) {
    return true;
  }

  const expectedSize = asNumber(metadata["size"]) ?? asNumber(metadata["bytes"]) ?? asNumber(metadata["contentLength"]);
  if (expectedSize !== undefined && expectedSize !== bytes.byteLength) {
    return false;
  }

  const digestCandidate = asString(metadata["digest"]) ?? asString(metadata["sha256"]) ?? asString(metadata["contentDigest"]);
  if (!digestCandidate) {
    return true;
  }

  const normalizedExpected = normalizeDigest(digestCandidate);
  if (!normalizedExpected) {
    return false;
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  return actual === normalizedExpected;
}

function normalizeDigest(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const prefixed = trimmed.startsWith("sha256:") ? trimmed.slice("sha256:".length) : trimmed;
  if (!/^[a-f0-9]{64}$/.test(prefixed)) {
    return null;
  }
  return prefixed;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function hasAuditEvidence(value: unknown, runId: string, canaryId: string, requireCanaryTag = false): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const events = (value as Record<string, unknown>)["events"];
  if (!Array.isArray(events)) {
    return false;
  }
  return events.some((event) => eventMatches(event, runId, canaryId, requireCanaryTag));
}

function eventMatches(value: unknown, runId: string, canaryId: string, requireCanaryTag: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  if (!requireCanaryTag && (event["resourceId"] === runId || event["runId"] === runId)) {
    return true;
  }
  if (!requireCanaryTag && event["resourceId"] === canaryId) {
    return true;
  }
  const payload = event["payload"];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (requireCanaryTag) {
      return containsAnyString(payload as Record<string, unknown>, [runId, canaryId]) &&
        containsAnyString(payload as Record<string, unknown>, ["r21-provider-production"]);
    }
    return containsAnyString(payload as Record<string, unknown>, [runId, canaryId]);
  }
  return false;
}

function containsAnyString(value: Record<string, unknown>, needles: string[]): boolean {
  for (const entry of Object.values(value)) {
    if (typeof entry === "string" && needles.some((needle) => entry.includes(needle))) {
      return true;
    }
    if (Array.isArray(entry)) {
      if (entry.some((item) => typeof item === "string" && needles.some((needle) => item.includes(needle)))) {
        return true;
      }
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      if (containsAnyString(entry as Record<string, unknown>, needles)) {
        return true;
      }
    }
  }
  return false;
}

function isReadyOk(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (value as Record<string, unknown>)["ok"] === true;
}

function extractReadyCodes(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const checks = (value as Record<string, unknown>)["checks"];
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(checks as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const code = (entry as Record<string, unknown>)["code"];
    const ok = (entry as Record<string, unknown>)["ok"];
    out[name] = {
      ok: ok === true,
      ...(typeof code === "string" ? { code } : {})
    };
  }
  return sanitizeForOutput(out);
}

function hasProviderMetricsEvidence(value: unknown, runtimeMode: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return containsAnyString(value as Record<string, unknown>, [runtimeMode, "hostedRuntime", "lifecycle", "accepted"]);
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await runProductionCanary({
    baseUrl: args.baseUrl ?? "",
    apiKey: args.apiKey,
    runtimeMode: args.runtimeMode,
    confirmProviderSpend: args.confirmProviderSpend,
    timeoutMs: args.timeoutMs
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
