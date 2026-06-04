import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { redactSecrets } from "../packages/core/src/index.js";

type CanaryCode =
  | "canary_ok"
  | "auth_required"
  | "auth_invalid"
  | "invalid_base_url"
  | "ready_denied"
  | "run_create_denied"
  | "worker_timeout"
  | "unexpected_terminal_status"
  | "artifact_missing"
  | "artifact_content_empty"
  | "artifact_digest_mismatch"
  | "metrics_auth_failed"
  | "audit_lookup_failed"
  | "malformed_response"
  | "malformed_sse"
  | "tool_canary_denied"
  | "approval_canary_failed"
  | "tool_live_canary_config_missing"
  | "provider_bridge_live_canary_config_missing"
  | "debate_live_canary_spend_unconfirmed"
  | "debate_create_denied"
  | "debate_timeout"
  | "debate_trace_missing"
  | "debate_artifact_missing";

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
  debateId?: string;
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
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  liveExternalTools?: boolean;
  confirmLiveToolSpend?: boolean;
  liveProviderBridges?: boolean;
  confirmLiveProviderSpend?: boolean;
  liveDebateRuntimes?: boolean;
  liveDebateJudge?: boolean;
  streamDebateEvents?: boolean;
}

interface ParsedCanaryArgs {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  json: boolean;
  liveExternalTools: boolean;
  confirmLiveToolSpend: boolean;
  liveProviderBridges: boolean;
  confirmLiveProviderSpend: boolean;
  liveDebateRuntimes: boolean;
  liveDebateJudge: boolean;
  streamDebateEvents: boolean;
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

const TERMINAL_FAILURE_STATUSES = new Set(["failed", "cancelled", "timed_out", "timeout"]);
const RUNNING_STATUSES = new Set(["queued", "starting", "running", "waiting_for_input", "waiting_for_approval"]);
const TERMINAL_DEBATE_STATUSES = new Set(["consensus_found", "no_consensus", "stopped_by_user", "completed", "failed"]);
const RUNNING_DEBATE_STATUSES = new Set(["created", "context_building", "researching", "arguing", "rebuttal", "judging"]);
const ALLOWED_CANARY_PATHS = new Set([
  "/ready",
  "/runs",
  "/debates",
  "/metrics",
  "/auth/whoami",
  "/entitlements",
  "/audit/events",
  "/tools/invocations",
  "/approvals"
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
  if (/^\/debates\/[^/]+$/.test(pathname)) {
    return true;
  }
  if (/^\/debates\/[^/]+\/events$/.test(pathname)) {
    return true;
  }
  if (/^\/artifacts\/[^/]+\/content$/.test(pathname)) {
    return true;
  }
  if (/^\/tools\/invocations\/[^/]+$/.test(pathname)) {
    return true;
  }
  if (/^\/approvals\/[^/]+\/(approve|reject)$/.test(pathname)) {
    return true;
  }
  if (/^\/approvals\/[^/]+$/.test(pathname)) {
    return true;
  }
  return false;
}

export async function runProductionCanary(options: ProductionCanaryOptions): Promise<ProductionCanaryResult> {
  const now = options.now ?? (() => Date.now());
  const startedAtMs = now();
  const steps: CanaryStep[] = [];
  const apiKey = options.apiKey ?? process.env["SWITCHYARD_CANARY_API_KEY"];
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

  if (!apiKey || apiKey.trim().length === 0) {
    addStep(steps, now, startedAtMs, "input.auth", "fail", "auth_required");
    return finalize(false, "auth_required", steps, summary, now, startedAtMs);
  }

  if (!parsedBase.ok) {
    addStep(steps, now, startedAtMs, "input.baseUrl", "fail", "invalid_base_url");
    return finalize(false, "invalid_base_url", steps, summary, now, startedAtMs);
  }

  const confirmLiveToolSpend = options.confirmLiveToolSpend
    || process.env["SWITCHYARD_CONFIRM_LIVE_TOOL_CANARY"] === "1";
  if (options.liveExternalTools && !confirmLiveToolSpend) {
    addStep(steps, now, startedAtMs, "input.liveTools", "fail", "tool_live_canary_config_missing");
    return finalize(false, "tool_live_canary_config_missing", steps, summary, now, startedAtMs);
  }
  const confirmLiveProviderSpend = options.confirmLiveProviderSpend
    || process.env["SWITCHYARD_CONFIRM_LIVE_PROVIDER_BRIDGE_CANARY"] === "1";
  if ((options.liveDebateRuntimes || options.liveDebateJudge) && !confirmLiveProviderSpend) {
    addStep(steps, now, startedAtMs, "input.liveDebate", "fail", "debate_live_canary_spend_unconfirmed");
    return finalize(false, "debate_live_canary_spend_unconfirmed", steps, summary, now, startedAtMs);
  }
  if (options.liveProviderBridges && !confirmLiveProviderSpend) {
    addStep(steps, now, startedAtMs, "input.liveProviderBridges", "fail", "provider_bridge_live_canary_config_missing");
    return finalize(false, "provider_bridge_live_canary_config_missing", steps, summary, now, startedAtMs);
  }

  const state: FetchState = {
    apiKey: apiKey.trim(),
    fetchImpl: options.fetchImpl ?? fetch,
    baseUrl: parsedBase.value
  };

  try {
    const whoami = await requestJson(state, "GET", "/auth/whoami");
    if (!whoami.ok) {
      return failFromHttp("whoami", whoami.status, steps, summary, now, startedAtMs);
    }
    addStep(steps, now, startedAtMs, "whoami", "pass", "auth_validated", { httpStatus: whoami.status });

    const entitlements = await requestJson(state, "GET", "/entitlements");
    if (!entitlements.ok) {
      return failFromHttp("entitlements", entitlements.status, steps, summary, now, startedAtMs);
    }
    addStep(steps, now, startedAtMs, "entitlements", "pass", "entitlements_loaded", { httpStatus: entitlements.status });

    const ready = await requestJson(state, "GET", "/ready");
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

    const debateCanaryId = `r24-debate-${randomUUID()}`;
    const debateProbe = await runHostedDebateProbe({
      state,
      steps,
      summary,
      now,
      startedAtMs,
      timeoutMs,
      canaryId: debateCanaryId,
      liveDebateRuntimes: Boolean(options.liveDebateRuntimes),
      liveDebateJudge: Boolean(options.liveDebateJudge),
      confirmLiveProviderSpend,
      streamDebateEvents: Boolean(options.streamDebateEvents)
    });
    if (!debateProbe.ok) {
      return finalize(false, debateProbe.code, steps, summary, now, startedAtMs);
    }

    if (options.liveExternalTools) {
      const runProbe = await createCanaryRun({ state, steps, summary, now, startedAtMs });
      if (!runProbe.ok) {
        return finalize(false, runProbe.code, steps, summary, now, startedAtMs);
      }
      const runId = runProbe.runId;
      const toolProbe = await runToolProbes({ state, runId, steps, now, startedAtMs });
      if (!toolProbe.ok) {
        return finalize(false, toolProbe.code, steps, summary, now, startedAtMs);
      }
    } else {
      addStep(steps, now, startedAtMs, "tools", "info", "tool_probes_skipped_default", {
        details: {
          reason: "live_external_tools_not_enabled",
          enableWith: "--live-external-tools --confirm-live-tool-spend"
        }
      });
    }
    if (!options.liveProviderBridges) {
      addStep(steps, now, startedAtMs, "providerBridges", "info", "provider_bridge_skipped_default", {
        details: {
          reason: "live_provider_bridges_not_enabled",
          enableWith: "--live-provider-bridges --confirm-live-provider-spend"
        }
      });
    } else {
      addStep(steps, now, startedAtMs, "providerBridges", "info", "provider_bridge_live_canary_enabled");
    }

    const metrics = await requestJson(state, "GET", "/metrics");
    if (!metrics.ok) {
      if (metrics.status === 401 || metrics.status === 403) {
        addStep(steps, now, startedAtMs, "metrics", "fail", "metrics_auth_failed", { httpStatus: metrics.status });
        return finalize(false, "metrics_auth_failed", steps, summary, now, startedAtMs);
      }
      return failFromHttp("metrics", metrics.status, steps, summary, now, startedAtMs);
    }

    summary.metricsAuthorized = true;
    addStep(steps, now, startedAtMs, "metrics", "pass", "metrics_ok", { httpStatus: metrics.status });

    const auditWindowMs = Math.max(250, Math.min(Math.floor(timeoutMs / 3), 2_000));
    const auditDeadline = Math.min(startedAtMs + timeoutMs, now() + auditWindowMs);
    let auditAttempts = 0;
    while (now() <= auditDeadline) {
      const audit = await requestJson(state, "GET", "/audit/events?limit=50");
      if (!audit.ok) {
        return failFromHttp("audit", audit.status, steps, summary, now, startedAtMs);
      }
      const matched = hasAuditEvidence(audit.json, debateProbe.debateId, debateCanaryId);
      if (matched) {
        summary.auditEvidence = true;
        if (auditAttempts > 0) {
          summary.delayedAuditEvidence = true;
          addStep(steps, now, startedAtMs, "audit", "info", "delayed_audit_evidence", {
            httpStatus: audit.status,
            details: { debateId: debateProbe.debateId, attempts: auditAttempts + 1 }
          });
        }
        addStep(steps, now, startedAtMs, "audit", "pass", "audit_evidence_found", {
          httpStatus: audit.status,
          details: { debateId: debateProbe.debateId }
        });
        return finalize(true, "canary_ok", steps, summary, now, startedAtMs);
      }
      auditAttempts += 1;
    }

    addStep(steps, now, startedAtMs, "audit", "fail", "audit_lookup_failed", {
      details: { debateId: debateProbe.debateId }
    });
    return finalize(false, "audit_lookup_failed", steps, summary, now, startedAtMs);
  } catch {
    addStep(steps, now, startedAtMs, "canary", "fail", "malformed_response");
    return finalize(false, "malformed_response", steps, summary, now, startedAtMs);
  }
}

async function runHostedDebateProbe(input: {
  state: FetchState;
  steps: CanaryStep[];
  summary: CanarySummary;
  now: () => number;
  startedAtMs: number;
  timeoutMs: number;
  canaryId: string;
  liveDebateRuntimes: boolean;
  liveDebateJudge: boolean;
  confirmLiveProviderSpend: boolean;
  streamDebateEvents: boolean;
}): Promise<{ ok: true; debateId: string } | { ok: false; code: CanaryCode }> {
  if (!input.liveDebateRuntimes) {
    addStep(input.steps, input.now, input.startedAtMs, "debate.liveParticipants", "info", "debate_live_participants_skipped_default", {
      details: {
        reason: "live_debate_runtimes_not_enabled",
        enableWith: "--live-debate-runtimes --confirm-live-provider-spend"
      }
    });
  }
  if (!input.liveDebateJudge) {
    addStep(input.steps, input.now, input.startedAtMs, "debate.liveJudge", "info", "debate_live_judge_skipped_default", {
      details: {
        reason: "live_debate_judge_not_enabled",
        enableWith: "--live-debate-judge --confirm-live-provider-spend"
      }
    });
  }

  const created = await requestJson(input.state, "POST", "/debates", buildDebateCanaryPayload({
    canaryId: input.canaryId,
    startedAtIso: new Date(input.startedAtMs).toISOString(),
    liveDebateRuntimes: input.liveDebateRuntimes,
    liveDebateJudge: input.liveDebateJudge,
    confirmLiveProviderSpend: input.confirmLiveProviderSpend
  }));
  if (!created.ok) {
    if (created.status === 403) {
      addStep(input.steps, input.now, input.startedAtMs, "debate.create", "fail", "debate_create_denied", { httpStatus: created.status });
      return { ok: false, code: "debate_create_denied" };
    }
    addStep(input.steps, input.now, input.startedAtMs, "debate.create", "fail", "debate_create_denied", { httpStatus: created.status });
    return { ok: false, code: "debate_create_denied" };
  }

  const debateId = readDebateId(created.json);
  if (!debateId) {
    addStep(input.steps, input.now, input.startedAtMs, "debate.create", "fail", "malformed_response", { httpStatus: created.status });
    return { ok: false, code: "malformed_response" };
  }
  input.summary.debateId = debateId;
  addStep(input.steps, input.now, input.startedAtMs, "debate.create", "pass", "debate_created", {
    httpStatus: created.status,
    details: { debateId }
  });

  const deadline = input.startedAtMs + input.timeoutMs;
  let inspect: unknown | undefined;
  let terminalStatus: string | undefined;
  while (input.now() <= deadline) {
    const detail = await requestJson(input.state, "GET", `/debates/${encodeURIComponent(debateId)}`);
    if (!detail.ok) {
      return { ok: false, code: failFromHttp("debate.inspect", detail.status, input.steps, input.summary, input.now, input.startedAtMs).code };
    }
    const status = readDebateStatus(detail.json);
    if (!status) {
      addStep(input.steps, input.now, input.startedAtMs, "debate.inspect", "fail", "malformed_response", { httpStatus: detail.status });
      return { ok: false, code: "malformed_response" };
    }
    terminalStatus = status;
    inspect = detail.json;
    if (TERMINAL_DEBATE_STATUSES.has(status)) {
      input.summary.terminalStatus = status;
      addStep(input.steps, input.now, input.startedAtMs, "debate.inspect", "pass", "debate_terminal", {
        httpStatus: detail.status,
        details: { debateId, terminalStatus: status }
      });
      break;
    }
    if (!RUNNING_DEBATE_STATUSES.has(status)) {
      input.summary.terminalStatus = status;
      addStep(input.steps, input.now, input.startedAtMs, "debate.inspect", "fail", "unexpected_terminal_status", {
        httpStatus: detail.status,
        details: { debateId, terminalStatus: status }
      });
      return { ok: false, code: "unexpected_terminal_status" };
    }
  }

  if (!inspect || !terminalStatus || !TERMINAL_DEBATE_STATUSES.has(terminalStatus)) {
    input.summary.terminalStatus = terminalStatus;
    addStep(input.steps, input.now, input.startedAtMs, "debate.inspect", "fail", "debate_timeout", {
      details: { debateId, terminalStatus }
    });
    return { ok: false, code: "debate_timeout" };
  }

  if (terminalStatus === "failed") {
    addStep(input.steps, input.now, input.startedAtMs, "debate.inspect", "fail", "unexpected_terminal_status", {
      details: { debateId, terminalStatus }
    });
    return { ok: false, code: "unexpected_terminal_status" };
  }

  const trace = readDebateTrace(inspect);
  if (!trace.ok) {
    addStep(input.steps, input.now, input.startedAtMs, "debate.trace", "fail", "debate_trace_missing", {
      details: { debateId, missing: trace.missing }
    });
    return { ok: false, code: "debate_trace_missing" };
  }
  addStep(input.steps, input.now, input.startedAtMs, "debate.trace", "pass", "debate_trace_verified", {
    details: {
      debateId,
      participantRunIds: trace.participantRunIds.length,
      eventIds: trace.eventIds.length,
      messageIds: trace.messageIds.length,
      stopReason: trace.stopReason,
      judgeConsensus: trace.judgeConsensus
    }
  });

  const sseReplay = await requestText(input.state, "GET", `/debates/${encodeURIComponent(debateId)}/events`);
  if (!sseReplay.ok) {
    return { ok: false, code: failFromHttp("debate.events", sseReplay.status, input.steps, input.summary, input.now, input.startedAtMs).code };
  }
  const parsedSse = parseSseReplay(sseReplay.text);
  if (!parsedSse.ok || parsedSse.events.length === 0 || !sseEventsMatchDebate(parsedSse.events, debateId)) {
    addStep(input.steps, input.now, input.startedAtMs, "debate.events", "fail", "malformed_sse", {
      httpStatus: sseReplay.status,
      details: { debateId }
    });
    return { ok: false, code: "malformed_sse" };
  }
  addStep(input.steps, input.now, input.startedAtMs, "debate.events", "pass", "debate_sse_replay_ok", {
    httpStatus: sseReplay.status,
    details: { debateId, eventCount: parsedSse.events.length }
  });

  if (input.streamDebateEvents) {
    const liveReplay = await requestText(input.state, "GET", `/debates/${encodeURIComponent(debateId)}/events?live=1&stopAfter=5`);
    if (!liveReplay.ok) {
      return { ok: false, code: failFromHttp("debate.events.live", liveReplay.status, input.steps, input.summary, input.now, input.startedAtMs).code };
    }
    const parsedLive = parseSseReplay(liveReplay.text);
    if (!parsedLive.ok || !sseEventsMatchDebate(parsedLive.events, debateId)) {
      addStep(input.steps, input.now, input.startedAtMs, "debate.events.live", "fail", "malformed_sse", {
        httpStatus: liveReplay.status,
        details: { debateId }
      });
      return { ok: false, code: "malformed_sse" };
    }
    addStep(input.steps, input.now, input.startedAtMs, "debate.events.live", "pass", "debate_sse_filter_ok", {
      httpStatus: liveReplay.status,
      details: { debateId, eventCount: parsedLive.events.length }
    });
  } else {
    addStep(input.steps, input.now, input.startedAtMs, "debate.events.live", "info", "debate_streaming_canary_skipped_default");
  }

  const artifact = trace.finalReportArtifact;
  input.summary.artifactId = artifact.id;
  const content = await requestBytes(input.state, "GET", `/artifacts/${encodeURIComponent(artifact.id)}/content`);
  if (!content.ok) {
    addStep(input.steps, input.now, input.startedAtMs, "debate.artifact.content", "fail", "debate_artifact_missing", {
      httpStatus: content.status,
      details: { debateId, artifactId: artifact.id }
    });
    return { ok: false, code: "debate_artifact_missing" };
  }
  if (content.bytes.byteLength === 0) {
    addStep(input.steps, input.now, input.startedAtMs, "debate.artifact.content", "fail", "artifact_content_empty", {
      httpStatus: content.status,
      details: { debateId, artifactId: artifact.id }
    });
    return { ok: false, code: "artifact_content_empty" };
  }
  if (!artifactDigestAndSizeMatch(artifact, content.bytes)) {
    addStep(input.steps, input.now, input.startedAtMs, "debate.artifact.content", "fail", "artifact_digest_mismatch", {
      httpStatus: content.status,
      details: { debateId, artifactId: artifact.id }
    });
    return { ok: false, code: "artifact_digest_mismatch" };
  }
  addStep(input.steps, input.now, input.startedAtMs, "debate.artifact.content", "pass", "debate_artifact_content_verified", {
    httpStatus: content.status,
    details: { debateId, artifactId: artifact.id, bytes: content.bytes.byteLength }
  });

  return { ok: true, debateId };
}

async function createCanaryRun(input: {
  state: FetchState;
  steps: CanaryStep[];
  summary: CanarySummary;
  now: () => number;
  startedAtMs: number;
}): Promise<{ ok: true; runId: string } | { ok: false; code: CanaryCode }> {
  const canaryId = `r22-tools-${randomUUID()}`;
  const createPayload = {
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    runtimeMode: "fake.deterministic",
    placement: "hosted",
    cwd: "/repo",
    task: "r22 production canary",
    metadata: {
      switchyardCanary: "r22-tools-production",
      canaryId,
      startedAt: new Date(input.startedAtMs).toISOString()
    }
  };

  const created = await requestJson(input.state, "POST", "/runs", createPayload);
  if (!created.ok) {
    if (created.status === 403) {
      addStep(input.steps, input.now, input.startedAtMs, "run.create", "fail", "run_create_denied", { httpStatus: created.status });
      return { ok: false, code: "run_create_denied" };
    }
    return { ok: false, code: failFromHttp("run.create", created.status, input.steps, input.summary, input.now, input.startedAtMs, "run_create_denied").code };
  }

  const runId = readRunId(created.json);
  if (!runId) {
    addStep(input.steps, input.now, input.startedAtMs, "run.create", "fail", "malformed_response", { httpStatus: created.status });
    return { ok: false, code: "malformed_response" };
  }
  input.summary.runId = runId;
  addStep(input.steps, input.now, input.startedAtMs, "run.create", "pass", "run_created", {
    httpStatus: created.status,
    details: { runId }
  });
  return { ok: true, runId };
}

async function runToolProbes(input: {
  state: FetchState;
  runId: string;
  steps: CanaryStep[];
  now: () => number;
  startedAtMs: number;
}): Promise<{ ok: true } | { ok: false; code: "tool_canary_denied" | "approval_canary_failed" }> {
  let rejectionCandidate: { approvalId: string; invocationId: string } | undefined;

  const fetchResult = await invokeTool(input.state, {
    runId: input.runId,
    type: "fetch",
    target: { placement: "hosted" },
    input: { url: "https://example.com/canary.txt", method: "GET", captureContent: true }
  });
  if (!fetchResult.ok) {
    addStep(input.steps, input.now, input.startedAtMs, "tools.hosted.fetch", "fail", "tool_canary_denied", {
      httpStatus: fetchResult.status,
      details: { reasonCode: fetchResult.code }
    });
    return { ok: false, code: "tool_canary_denied" };
  }
  rejectionCandidate = fetchResult.approvalId && fetchResult.invocationId
    ? { approvalId: fetchResult.approvalId, invocationId: fetchResult.invocationId }
    : rejectionCandidate;
  addStep(input.steps, input.now, input.startedAtMs, "tools.hosted.fetch", "pass", "tool_fetch_checked", {
    httpStatus: fetchResult.status,
    details: { mode: fetchResult.mode }
  });

  const githubResult = await invokeTool(input.state, {
    runId: input.runId,
    type: "github",
    target: { placement: "hosted" },
    input: { operation: "get_issue", owner: "switchyard", repo: "switchyard", number: 1 }
  });
  if (!githubResult.ok && ![
    "tool_policy_denied",
    "tool_hosted_tools_disabled",
    "tool_real_tools_disabled",
    "tool_policy_config_invalid"
  ].includes(githubResult.code ?? "")) {
    addStep(input.steps, input.now, input.startedAtMs, "tools.hosted.github", "fail", "tool_canary_denied", {
      httpStatus: githubResult.status,
      details: { reasonCode: githubResult.code }
    });
    return { ok: false, code: "tool_canary_denied" };
  }
  if (githubResult.approvalId && githubResult.invocationId && !rejectionCandidate) {
    rejectionCandidate = { approvalId: githubResult.approvalId, invocationId: githubResult.invocationId };
  }
  addStep(input.steps, input.now, input.startedAtMs, "tools.hosted.github", "pass", "tool_github_checked", {
    httpStatus: githubResult.status,
    details: { mode: githubResult.mode, reasonCode: githubResult.code }
  });

  const deniedShell = await invokeTool(input.state, {
    runId: input.runId,
    type: "shell",
    target: { placement: "hosted" },
    input: { commandId: "not.allowlisted", cwd: "/repo" }
  });
  if (deniedShell.ok || !["shell_command_denied", "tool_policy_denied", "tool_policy_config_invalid"].includes(deniedShell.code ?? "")) {
    addStep(input.steps, input.now, input.startedAtMs, "tools.hosted.shell_denied", "fail", "tool_canary_denied", {
      httpStatus: deniedShell.status,
      details: { reasonCode: deniedShell.code }
    });
    return { ok: false, code: "tool_canary_denied" };
  }
  addStep(input.steps, input.now, input.startedAtMs, "tools.hosted.shell_denied", "pass", "shell_command_denied", {
    httpStatus: deniedShell.status,
    details: { reasonCode: deniedShell.code }
  });

  const allowlistedShell = await invokeTool(input.state, {
    runId: input.runId,
    type: "shell",
    target: { placement: "hosted" },
    input: { commandId: "switchyard.fake.echo", args: ["canary"], cwd: "/repo" }
  });
  if (!allowlistedShell.ok && ![
    "tool_policy_denied",
    "tool_hosted_tools_disabled",
    "tool_real_tools_disabled",
    "tool_policy_config_invalid"
  ].includes(allowlistedShell.code ?? "")) {
    addStep(input.steps, input.now, input.startedAtMs, "tools.hosted.shell_allowlisted", "fail", "tool_canary_denied", {
      httpStatus: allowlistedShell.status,
      details: { reasonCode: allowlistedShell.code }
    });
    return { ok: false, code: "tool_canary_denied" };
  }
  if (allowlistedShell.approvalId && allowlistedShell.invocationId && !rejectionCandidate) {
    rejectionCandidate = { approvalId: allowlistedShell.approvalId, invocationId: allowlistedShell.invocationId };
  }
  addStep(input.steps, input.now, input.startedAtMs, "tools.hosted.shell_allowlisted", "pass", "tool_shell_allowlisted_checked", {
    httpStatus: allowlistedShell.status,
    details: { mode: allowlistedShell.mode, reasonCode: allowlistedShell.code }
  });

  const connectedRepo = await invokeTool(input.state, {
    runId: input.runId,
    type: "repo",
    target: { placement: "connected_local_node" },
    input: { operation: "status", cwd: "/repo" }
  });
  if (!connectedRepo.ok && ![
    "tool_node_unavailable",
    "tool_connected_node_tools_disabled",
    "tool_policy_denied",
    "tool_policy_config_invalid"
  ].includes(connectedRepo.code ?? "")) {
    addStep(input.steps, input.now, input.startedAtMs, "tools.connected.repo", "fail", "tool_canary_denied", {
      httpStatus: connectedRepo.status,
      details: { reasonCode: connectedRepo.code }
    });
    return { ok: false, code: "tool_canary_denied" };
  }
  addStep(input.steps, input.now, input.startedAtMs, "tools.connected.repo", "pass", "tool_repo_checked", {
    httpStatus: connectedRepo.status,
    details: { mode: connectedRepo.mode, reasonCode: connectedRepo.code }
  });

  const nodeUnavailable = await invokeTool(input.state, {
    runId: input.runId,
    type: "repo",
    target: { placement: "connected_local_node", nodeId: "node_missing" },
    input: { operation: "status", cwd: "/repo" }
  });
  if (nodeUnavailable.ok || !["tool_node_unavailable", "tool_policy_denied"].includes(nodeUnavailable.code ?? "")) {
    addStep(input.steps, input.now, input.startedAtMs, "tools.connected.unavailable", "fail", "tool_canary_denied", {
      httpStatus: nodeUnavailable.status,
      details: { reasonCode: nodeUnavailable.code }
    });
    return { ok: false, code: "tool_canary_denied" };
  }
  addStep(input.steps, input.now, input.startedAtMs, "tools.connected.unavailable", "pass", "tool_node_unavailable", {
    httpStatus: nodeUnavailable.status,
    details: { reasonCode: nodeUnavailable.code }
  });

  if (!rejectionCandidate) {
    addStep(input.steps, input.now, input.startedAtMs, "tools.approval.reject", "info", "approval_skipped_no_pending");
    addStep(input.steps, input.now, input.startedAtMs, "tools.approval.expire", "info", "approval_expire_not_observed");
    return { ok: true };
  }

  const reject = await requestJson(input.state, "POST", `/approvals/${encodeURIComponent(rejectionCandidate.approvalId)}/reject`, {});
  if (!reject.ok) {
    addStep(input.steps, input.now, input.startedAtMs, "tools.approval.reject", "fail", "approval_canary_failed", {
      httpStatus: reject.status
    });
    return { ok: false, code: "approval_canary_failed" };
  }

  const afterReject = await requestJson(input.state, "GET", `/tools/invocations/${encodeURIComponent(rejectionCandidate.invocationId)}`);
  const rejectCode = readInvocationErrorCode(afterReject.json);
  if (!afterReject.ok || rejectCode !== "tool_approval_rejected") {
    addStep(input.steps, input.now, input.startedAtMs, "tools.approval.reject", "fail", "approval_canary_failed", {
      httpStatus: afterReject.status,
      details: { reasonCode: rejectCode }
    });
    return { ok: false, code: "approval_canary_failed" };
  }
  addStep(input.steps, input.now, input.startedAtMs, "tools.approval.reject", "pass", "tool_approval_rejected", {
    httpStatus: afterReject.status
  });

  const expired = await requestJson(input.state, "GET", "/approvals?status=expired&limit=1");
  if (!expired.ok) {
    addStep(input.steps, input.now, input.startedAtMs, "tools.approval.expire", "fail", "approval_canary_failed", {
      httpStatus: expired.status
    });
    return { ok: false, code: "approval_canary_failed" };
  }
  const expiredApproval = readFirstApproval(expired.json);
  if (!expiredApproval?.toolInvocationId) {
    addStep(input.steps, input.now, input.startedAtMs, "tools.approval.expire", "info", "approval_expire_not_observed", {
      httpStatus: expired.status
    });
    return { ok: true };
  }

  const expiredInvocation = await requestJson(input.state, "GET", `/tools/invocations/${encodeURIComponent(expiredApproval.toolInvocationId)}`);
  const expiredCode = readInvocationErrorCode(expiredInvocation.json);
  if (!expiredInvocation.ok || expiredCode !== "tool_approval_expired") {
    addStep(input.steps, input.now, input.startedAtMs, "tools.approval.expire", "fail", "approval_canary_failed", {
      httpStatus: expiredInvocation.status,
      details: { reasonCode: expiredCode }
    });
    return { ok: false, code: "approval_canary_failed" };
  }

  addStep(input.steps, input.now, input.startedAtMs, "tools.approval.expire", "pass", "tool_approval_expired", {
    httpStatus: expiredInvocation.status
  });
  return { ok: true };
}

async function invokeTool(
  state: FetchState,
  payload: Record<string, unknown>
): Promise<{ ok: true; status: number; mode: "queued" | "immediate"; invocationId?: string; approvalId?: string } | { ok: false; status: number; code?: string; mode: "denied" }> {
  const response = await requestJson(state, "POST", "/tools/invocations", payload);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      mode: "denied",
      code: readErrorCode(response.json)
    };
  }
  const invocationId = readInvocationId(response.json);
  const approvalId = readApprovalId(response.json);
  return {
    ok: true,
    status: response.status,
    mode: approvalId ? "queued" : "immediate",
    invocationId,
    approvalId
  };
}

function parseCliArgs(argv: string[]): ParsedCanaryArgs {
  const parsed: ParsedCanaryArgs = {
    json: false,
    liveExternalTools: false,
    confirmLiveToolSpend: false,
    liveProviderBridges: false,
    confirmLiveProviderSpend: false,
    liveDebateRuntimes: false,
    liveDebateJudge: false,
    streamDebateEvents: false
  };
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
    if (token === "--live-external-tools") {
      parsed.liveExternalTools = true;
      continue;
    }
    if (token === "--confirm-live-tool-spend") {
      parsed.confirmLiveToolSpend = true;
      continue;
    }
    if (token === "--live-provider-bridges") {
      parsed.liveProviderBridges = true;
      continue;
    }
    if (token === "--confirm-live-provider-spend") {
      parsed.confirmLiveProviderSpend = true;
      continue;
    }
    if (token === "--live-debate-runtimes") {
      parsed.liveDebateRuntimes = true;
      continue;
    }
    if (token === "--live-debate-judge") {
      parsed.liveDebateJudge = true;
      continue;
    }
    if (token === "--stream-debate-events") {
      parsed.streamDebateEvents = true;
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

function authHeaders(apiKey: string): HeadersInit {
  return {
    authorization: `Bearer ${apiKey}`,
    "x-switchyard-api-key": apiKey,
    "content-type": "application/json"
  };
}

async function requestJson(
  state: FetchState,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<{ ok: true; status: number; json: unknown } | { ok: false; status: number; json?: unknown }> {
  const response = await fetchRoute(state, method, path, body);
  const text = await response.text();
  const parsed = text.trim().length > 0 ? tryParseJson(text) : undefined;
  if (!response.ok) {
    return { ok: false, status: response.status, ...(parsed !== undefined ? { json: parsed } : {}) };
  }
  if (parsed === undefined) {
    return { ok: false, status: response.status };
  }
  return { ok: true, status: response.status, json: parsed };
}

async function requestText(
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

async function requestBytes(
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

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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

function buildDebateCanaryPayload(input: {
  canaryId: string;
  startedAtIso: string;
  liveDebateRuntimes: boolean;
  liveDebateJudge: boolean;
  confirmLiveProviderSpend: boolean;
}): Record<string, unknown> {
  const fakeParticipant = (role: string): Record<string, unknown> => ({
    role,
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    runtimeMode: "fake.deterministic",
    placement: "hosted",
    realRuntimeOptIn: false,
    switchyardCanary: "r24-hosted-debate-production",
    canaryId: input.canaryId
  });
  const liveParticipant = (role: string): Record<string, unknown> => ({
    role,
    runtime: "codex",
    provider: "openai",
    model: "default",
    adapterType: "process",
    runtimeMode: "codex.exec_json",
    placement: "hosted",
    realRuntimeOptIn: true,
    confirmLiveProviderSpend: true,
    switchyardCanary: "r24-hosted-debate-production",
    canaryId: input.canaryId
  });

  return {
    topic: `Switchyard production hosted debate canary ${input.canaryId}`,
    participants: input.liveDebateRuntimes
      ? [liveParticipant("affirmative"), liveParticipant("skeptic")]
      : [fakeParticipant("affirmative"), fakeParticipant("skeptic")],
    judgeConfig: input.liveDebateJudge
      ? {
          mode: "model",
          runtime: "codex",
          provider: "openai",
          model: "default",
          adapterType: "process",
          runtimeMode: "codex.exec_json",
          placement: "hosted",
          realRuntimeOptIn: true,
          confirmLiveProviderSpend: input.confirmLiveProviderSpend,
          switchyardCanary: "r24-hosted-debate-production",
          canaryId: input.canaryId
        }
      : { mode: "deterministic" },
    limits: {
      maxRounds: 1,
      maxTurnsPerAgent: 1,
      maxTotalMessages: 4,
      maxDurationSeconds: 120,
      maxCostUsd: input.liveDebateRuntimes || input.liveDebateJudge ? 1 : 0,
      requireCitations: false,
      requireDisagreementSummary: true,
      stopOnConsensus: false,
      humanStopAllowed: false
    },
    metadata: {
      switchyardCanary: "r24-hosted-debate-production",
      canaryId: input.canaryId,
      startedAt: input.startedAtIso,
      liveDebateRuntimes: input.liveDebateRuntimes,
      liveDebateJudge: input.liveDebateJudge
    }
  };
}

function readDebateId(value: unknown): string | null {
  const debate = readDebateRecord(value);
  const id = debate?.["id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

function readDebateStatus(value: unknown): string | null {
  const debate = readDebateRecord(value);
  const status = debate?.["status"];
  return typeof status === "string" && status.length > 0 ? status : null;
}

function readDebateRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const debate = (value as Record<string, unknown>)["debate"];
  if (!debate || typeof debate !== "object" || Array.isArray(debate)) {
    return null;
  }
  return debate as Record<string, unknown>;
}

function readDebateTrace(value: unknown):
  | {
      ok: true;
      participantRunIds: string[];
      eventIds: string[];
      messageIds: string[];
      stopReason: string;
      judgeConsensus: string;
      finalReportArtifact: { id: string; metadata?: Record<string, unknown> };
    }
  | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const debate = readDebateRecord(value);
  if (!debate) {
    return { ok: false, missing: ["debate"] };
  }

  const debateId = asString(debate["id"]);
  const participants = Array.isArray(debate["participants"]) ? debate["participants"] : [];
  const participantRunIds = participants.flatMap((participant) => readParticipantRunIds(participant));
  if (participants.length !== 2 || participantRunIds.length < 2) {
    missing.push("participantRunIds");
  }

  const eventIds = readStringArray(debate["eventIds"]);
  const inspectEventIds = readObjectArrayIds((value as Record<string, unknown>)["events"]);
  if (eventIds.length === 0 || !eventIds.every((id) => inspectEventIds.includes(id))) {
    missing.push("eventIds");
  }

  const messageIds = readStringArray(debate["messageIds"]);
  const inspectMessageIds = readObjectArrayIds((value as Record<string, unknown>)["messages"]);
  if (messageIds.length === 0 || !messageIds.every((id) => inspectMessageIds.includes(id))) {
    missing.push("messageIds");
  }

  const judge = debate["judge"];
  const judgeRecord = judge && typeof judge === "object" && !Array.isArray(judge) ? judge as Record<string, unknown> : undefined;
  const judgeConsensus = asString(judgeRecord?.["consensus"]);
  if (!judgeRecord || !judgeConsensus || !asString(judgeRecord["summary"])) {
    missing.push("judge");
  }

  const stopReason = asString(debate["stopReason"]);
  if (!stopReason) {
    missing.push("stopReason");
  }

  const finalReportArtifactId = asString(debate["finalReportArtifactId"]);
  const artifacts = readArtifacts((value as Record<string, unknown>)["artifacts"]);
  const finalReportArtifact = artifacts.find((artifact) => artifact.id === finalReportArtifactId)
    ?? artifacts.find((artifact) => artifact.metadata?.["debateId"] === debateId || artifact.debateId === debateId);
  if (!finalReportArtifactId || !finalReportArtifact) {
    missing.push("finalReportArtifact");
  } else if (!hasFinalReportMetadata(finalReportArtifact, debateId, messageIds)) {
    missing.push("finalReportArtifactMetadata");
  }

  if (missing.length > 0 || !stopReason || !judgeConsensus || !finalReportArtifact) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    participantRunIds,
    eventIds,
    messageIds,
    stopReason,
    judgeConsensus,
    finalReportArtifact
  };
}

function readParticipantRunIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const participant = value as Record<string, unknown>;
  return [
    ...(asString(participant["runId"]) ? [asString(participant["runId"]) as string] : []),
    ...readStringArray(participant["runIds"])
  ];
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function readObjectArrayIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const id = (entry as Record<string, unknown>)["id"];
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
}

function readArtifacts(value: unknown): Array<{ id: string; debateId?: string; metadata?: Record<string, unknown> }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Array<{ id: string; debateId?: string; metadata?: Record<string, unknown> }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = asString(record["id"]);
    if (!id) {
      continue;
    }
    const metadata = record["metadata"] && typeof record["metadata"] === "object" && !Array.isArray(record["metadata"])
      ? record["metadata"] as Record<string, unknown>
      : undefined;
    const debateId = asString(record["debateId"]);
    out.push({
      id,
      ...(debateId ? { debateId } : {}),
      ...(metadata ? { metadata } : {})
    });
  }
  return out;
}

function hasFinalReportMetadata(
  artifact: { debateId?: string; metadata?: Record<string, unknown> },
  debateId: string | undefined,
  messageIds: string[]
): boolean {
  const metadata = artifact.metadata;
  if (!metadata || !debateId) {
    return false;
  }
  const metadataDebateId = asString(metadata["debateId"]) ?? artifact.debateId;
  if (metadataDebateId !== debateId) {
    return false;
  }
  const metadataMessageIds = readStringArray(metadata["messageIds"]);
  if (messageIds.length > 0 && !messageIds.every((id) => metadataMessageIds.includes(id))) {
    return false;
  }
  const participantIds = readStringArray(metadata["participantIds"]);
  return participantIds.length >= 2;
}

function sseEventsMatchDebate(events: unknown[], debateId: string): boolean {
  let sawDebateEvent = false;
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      continue;
    }
    const record = event as Record<string, unknown>;
    const directDebateId = asString(record["debateId"]);
    const payload = record["payload"];
    const payloadDebateId = payload && typeof payload === "object" && !Array.isArray(payload)
      ? asString((payload as Record<string, unknown>)["debateId"])
      : undefined;
    const candidate = directDebateId ?? payloadDebateId;
    if (!candidate) {
      continue;
    }
    if (candidate !== debateId) {
      return false;
    }
    sawDebateEvent = true;
  }
  return sawDebateEvent;
}

function readInvocationId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const invocation = (value as Record<string, unknown>)["invocation"];
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) {
    return undefined;
  }
  const id = (invocation as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function readApprovalId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const approval = (value as Record<string, unknown>)["approval"];
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    return undefined;
  }
  const id = (approval as Record<string, unknown>)["id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function readErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const error = (value as Record<string, unknown>)["error"];
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : undefined;
}

function readInvocationErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const invocation = (value as Record<string, unknown>)["invocation"];
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) {
    return undefined;
  }
  const error = (invocation as Record<string, unknown>)["error"];
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : undefined;
}

function readFirstApproval(value: unknown): { id: string; toolInvocationId?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const approvals = (value as Record<string, unknown>)["approvals"];
  if (!Array.isArray(approvals) || approvals.length === 0) {
    return null;
  }
  const first = approvals[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return null;
  }
  const id = (first as Record<string, unknown>)["id"];
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  const payload = (first as Record<string, unknown>)["payload"];
  const toolInvocationId = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (typeof (payload as Record<string, unknown>)["toolInvocationId"] === "string" ? (payload as Record<string, unknown>)["toolInvocationId"] as string : undefined)
    : undefined;
  return { id, toolInvocationId };
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

function hasAuditEvidence(value: unknown, runId: string, canaryId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const events = (value as Record<string, unknown>)["events"];
  if (!Array.isArray(events)) {
    return false;
  }
  return events.some((event) => eventMatches(event, runId, canaryId));
}

function eventMatches(value: unknown, runId: string, canaryId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  if (event["resourceId"] === runId || event["runId"] === runId || event["debateId"] === runId) {
    return true;
  }
  if (event["resourceId"] === canaryId) {
    return true;
  }
  const payload = event["payload"];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return containsAnyString(payload as Record<string, unknown>, [runId, canaryId, "r22-tools-production"]);
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

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await runProductionCanary({
    baseUrl: args.baseUrl ?? "",
    apiKey: args.apiKey,
    timeoutMs: args.timeoutMs,
    liveExternalTools: args.liveExternalTools,
    confirmLiveToolSpend: args.confirmLiveToolSpend,
    liveProviderBridges: args.liveProviderBridges,
    confirmLiveProviderSpend: args.confirmLiveProviderSpend,
    liveDebateRuntimes: args.liveDebateRuntimes,
    liveDebateJudge: args.liveDebateJudge,
    streamDebateEvents: args.streamDebateEvents
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
