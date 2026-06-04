import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import {
  AdapterProtocolError,
  type RuntimeAdapter,
  type RuntimeAdapterCheck,
  type RuntimeAdapterManifest,
  type RuntimeLogger,
  type RuntimeStartResult
} from "@switchyard/core";
import { TranscriptRecorder } from "../substrates/transcript-recorder.js";
import {
  AgentFieldInvalidJsonError,
  AgentFieldRequestError,
  AgentFieldResponseTooLargeError,
  requestJson
} from "./http-client.js";
import type {
  AgentFieldAsyncRestAdapterOptions,
  AgentFieldRequestResult,
  AgentFieldSessionState
} from "./types.js";

export const AGENTFIELD_RUNTIME_MODE_SLUG = "agentfield.async_rest";
const MAX_RUNTIME_INPUT_BYTES = 64 * 1024;
const BRIDGE_OVERRIDE_KEYS = new Set(["baseUrl", "base_url", "apiKey", "api_key", "target"]);

interface StoredSession {
  state: AgentFieldSessionState;
  transcript: TranscriptRecorder;
}

interface AgentFieldApprovalRequest {
  runtimeApprovalToken: string;
  approvalType: string;
  expiresAt: string;
  message?: string;
  answers?: Record<string, unknown>;
}

export class AgentFieldAsyncRestAdapter implements RuntimeAdapter {
  readonly id = "agentfield";
  readonly manifest: RuntimeAdapterManifest = {
    adapterId: "agentfield",
    providerId: "provider_agentfield",
    runtimeId: "runtime_agentfield",
    runtimeModeId: "runtime_mode_agentfield_async_rest",
    runtimeModeSlug: AGENTFIELD_RUNTIME_MODE_SLUG,
    name: "AgentField async REST",
    adapterType: "http",
    kind: "async_rest",
    capabilities: [
      "run.start",
      "run.input",
      "run.timeout",
      "event.normalized",
      "event.streaming",
      "approval.bridge",
      "artifact.transcript",
      "auth.api_key"
    ],
    limitations: [
      {
        code: "configured_target_only",
        message: "agentfield.async_rest uses the daemon-level AgentField target configured by SWITCHYARD_AGENTFIELD_TARGET."
      },
      {
        code: "configured_wrapper_only",
        message: "AgentField wrapper endpoints are operator configured and cannot be overridden per run."
      },
      {
        code: "hosted_bridge_readiness_required",
        message: "Hosted AgentField bridge paths require wrapper_config and wrapper_bridge_capability readiness checks."
      },
      {
        code: "cancel_unsupported",
        message: "AgentField upstream cancellation is not claimed because no cancel endpoint is verified by this spec."
      },
      { code: "polling_only", message: "AgentField polls execution status and does not accept webhooks." },
      {
        code: "no_agentfield_control_plane_proxy",
        message: "AgentField memory, admin, node lifecycle, permissions, and Agentic APIs are not exposed through Switchyard."
      }
    ],
    placement: {
      local: {
        support: "conditional",
        reason: "Requires SWITCHYARD_AGENTFIELD_BASE_URL, SWITCHYARD_AGENTFIELD_API_KEY, and SWITCHYARD_AGENTFIELD_TARGET."
      },
      hosted: { support: "conditional", reason: "Worker execution requires explicit operator opt-in and provider activation." },
      connectedLocalNode: { support: "future", reason: "Connected node support remains future scope." }
    },
    docsPath: "docs/development/adapters/AGENTFIELD.md",
    check: {
      strategy: "custom",
      required: ["wrapper_config", "wrapper_bridge_capability"],
      optional: ["target_discovery"]
    }
  };

  private readonly baseUrlRef: URL | undefined;
  private readonly baseUrlState: "missing" | "invalid" | "configured";
  private readonly apiKey: string | undefined;
  private readonly target: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxResponseBytes: number;
  private readonly logger: RuntimeLogger | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly sessions = new Map<string, StoredSession>();

  constructor(options: AgentFieldAsyncRestAdapterOptions = {}) {
    const parsed = parseBaseUrl(options.baseUrl);
    this.baseUrlRef = parsed.url;
    this.baseUrlState = parsed.state;
    this.apiKey = options.apiKey;
    this.target = options.target;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.logger = options.logger;
    this.fetchImpl = options.fetch;
  }

  async check(): Promise<RuntimeAdapterCheck> {
    const configFailure = this.configFailure();
    if (configFailure) {
      return { ok: false, details: { availability: configFailure } };
    }

    let healthResponse: AgentFieldRequestResult;
    try {
      healthResponse = await this.request("api/v1/health", {
        method: "GET",
        tooLargeReasonCode: "check_output_too_large",
        invalidJsonReasonCode: "agentfield_health_invalid"
      });
    } catch (error) {
      return { ok: false, details: { availability: this.unavailableHealth(error) } };
    }

    if (!healthResponse.ok) {
      return {
        ok: false,
        details: {
          availability: {
            state: "unavailable",
            canRun: false,
            installed: true,
            auth: "configured",
            reasonCode: "agentfield_health_unavailable",
            message: `health endpoint returned ${healthResponse.status}`
          }
        }
      };
    }

    const healthBody = isRecord(healthResponse.body) ? healthResponse.body : undefined;
    if (!healthBody || typeof healthBody["status"] !== "string") {
      return {
        ok: false,
        details: {
          availability: {
            state: "unknown",
            canRun: false,
            installed: true,
            auth: "configured",
            reasonCode: "agentfield_health_invalid",
            message: "Health response was invalid JSON."
          }
        }
      };
    }

    const healthStatus = String(healthBody["status"]).toLowerCase();
    const availability = healthStatus === "degraded"
      ? {
          state: "partial",
          canRun: true,
          installed: true,
          auth: "configured",
          reasonCode: "agentfield_health_degraded",
          message: "AgentField health returned degraded."
        }
      : {
          state: "available",
          canRun: true,
          installed: true,
          auth: "configured",
          reasonCode: null,
          message: null
        };

    try {
      const discovery = await this.request("api/v1/discovery/capabilities?format=compact", {
        method: "GET",
        tooLargeReasonCode: "check_output_too_large",
        invalidJsonReasonCode: "agentfield_discovery_invalid"
      });
      if (!discovery.ok) {
        return {
          ok: true,
          details: {
            availability: availability.reasonCode
              ? availability
              : {
              state: "partial",
              canRun: true,
              installed: true,
              auth: "configured",
              reasonCode: "agentfield_discovery_unavailable",
              message: `discovery endpoint returned ${discovery.status}`
            },
            bridge: bridgeReadiness(undefined)
          }
        };
      }

      const discoveryBody = isRecord(discovery.body) ? discovery.body : undefined;
      const targets = Array.isArray(discoveryBody?.["targets"]) ? discoveryBody?.["targets"] : undefined;
      if (targets && this.target && !targets.includes(this.target)) {
        return {
          ok: false,
          details: {
            availability: {
              state: "unavailable",
              canRun: false,
              installed: true,
              auth: "configured",
              reasonCode: "agentfield_target_not_found",
              message: "Configured SWITCHYARD_AGENTFIELD_TARGET was not found in discovery."
            }
          }
        };
      }
      const bridge = bridgeReadiness(discoveryBody);
      return {
        ok: true,
        details: {
          availability,
          bridge
        }
      };
    } catch {
      return {
        ok: true,
        details: {
          availability: availability.reasonCode
            ? availability
            : {
            state: "partial",
            canRun: true,
            installed: true,
            auth: "configured",
            reasonCode: "agentfield_discovery_unavailable",
            message: "Target discovery unavailable; runtime remains runnable."
          },
          bridge: bridgeReadiness(undefined)
        }
      };
    }
  }

  async start(request: Record<string, unknown>): Promise<RuntimeStartResult> {
    const runId = requiredString(request["runId"], "runId");
    const task = requiredString(request["task"], "task");
    const runtime = requiredString(request["runtime"], "runtime");
    const runtimeMode = requiredString(request["runtimeMode"], "runtimeMode");
    const provider = requiredString(request["provider"], "provider");
    const model = requiredString(request["model"], "model");
    const cwd = requiredString(request["cwd"], "cwd");
    const metadata = isRecord(request["metadata"]) ? request["metadata"] : {};
    const agentfieldMetadata = isRecord(metadata["agentfield"]) ? metadata["agentfield"] : {};
    rejectConfiguredOverrideKeys(agentfieldMetadata, "agentfield bridge configuration is operator controlled");
    const inputPayload = this.parseCustomInput(agentfieldMetadata);
    const headerMetadata = this.parseHeaderMetadata(agentfieldMetadata);

    const configFailure = this.configFailure();
    if (configFailure) {
      throw new Error(String(configFailure.reasonCode));
    }

    const body: Record<string, unknown> = {
      input: {
        prompt: task,
        ...inputPayload
      },
      metadata: {
        runId,
        runtime,
        runtimeMode,
        provider,
        model,
        cwd
      }
    };

    const headers: Record<string, string> = {};
    if (headerMetadata.workflow) {
      headers["x-switchyard-workflow"] = headerMetadata.workflow;
    }
    if (headerMetadata.session) {
      headers["x-switchyard-session"] = headerMetadata.session;
    }
    if (headerMetadata.actor) {
      headers["x-switchyard-actor"] = headerMetadata.actor;
    }

    let response: AgentFieldRequestResult;
    try {
      response = await this.request(`api/v1/execute/async/${encodeURIComponent(this.target!)}`, {
        method: "POST",
        body,
        extraHeaders: headers,
        tooLargeReasonCode: "agentfield_start_response_too_large",
        invalidJsonReasonCode: "agentfield_invalid_start_response"
      });
    } catch (error) {
      throw new Error(eventErrorReason(error));
    }
    if (!response.ok) {
      throw new Error("agentfield_start_failed");
    }
    const executionId = readExecutionId(response.body);
    if (!executionId) {
      throw new Error("agentfield_invalid_start_response");
    }

    const sessionId = `session_${crypto.randomUUID()}`;
    const transcript = new TranscriptRecorder();
    const stored: StoredSession = {
      state: {
        sessionId,
        runId,
        executionId,
        target: this.target!,
        seenApprovalTokens: new Set<string>()
      },
      transcript
    };
    transcript.appendHttpEvent({
      type: "agentfield.start",
      status: "accepted",
      message: `executionId=${executionId}`
    });
    this.sessions.set(sessionId, stored);
    this.log("info", "agentfield.start", {
      runId,
      executionId,
      target: this.target
    });
    return {
      sessionId,
      externalSessionKey: executionId
    };
  }

  async send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void> {
    rejectConfiguredOverrideKeys(input, "agentfield bridge configuration is operator controlled");
    const type = input["type"] === undefined && input["text"] !== undefined
      ? "input"
      : requiredString(input["type"], "type");
    if (type === "input") {
      await this.sendRuntimeInput(session, input);
      return;
    }
    if (type === "approval_resolution") {
      await this.sendApprovalResolution(session, input);
      return;
    }
    throw new AdapterProtocolError("Unsupported AgentField bridge payload type.", {
      reasonCode: "agentfield_input_failed"
    });
  }

  async cancel(session: Record<string, unknown>): Promise<void> {
    const stored = this.requireSession(session);
    if (stored.state.terminalStatus) {
      return;
    }
    throw new AdapterProtocolError("AgentField upstream cancellation is not supported in R6.", {
      reasonCode: "agentfield_cancel_unsupported"
    });
  }

  async *events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    const stored = this.requireSession(session);
    const runId = requiredString(session["runId"], "runId");
    let sequence = 0;
    while (!stored.state.terminalStatus) {
      let statusResponse: AgentFieldRequestResult;
      try {
        statusResponse = await this.request(`api/v1/executions/${encodeURIComponent(stored.state.executionId)}`, {
          method: "GET",
          tooLargeReasonCode: "agentfield_status_response_too_large",
          invalidJsonReasonCode: "agentfield_invalid_status_response"
        }, stored.transcript);
      } catch (error) {
        yield this.failureEvent(runId, sequence++, eventErrorReason(error), stored);
        return;
      }

      if (!statusResponse.ok) {
        yield this.failureEvent(runId, sequence++, "agentfield_status_failed", stored);
        return;
      }

      const body = isRecord(statusResponse.body) ? statusResponse.body : undefined;
      if (!body || typeof body["status"] !== "string") {
        yield this.failureEvent(runId, sequence++, "agentfield_invalid_status_response", stored);
        return;
      }
      const status = body["status"];

      const normalized = status.toLowerCase();
      const statusPayload = {
        status: normalized,
        agentfieldExecutionId: stored.state.executionId,
        target: stored.state.target,
        upstreamStatus: normalized
      };
      if (
        normalized === "queued" ||
        normalized === "pending" ||
        normalized === "running" ||
        normalized === "waiting_for_input"
      ) {
        if (stored.state.lastStatus !== normalized) {
          yield event(runId, sequence++, "runtime.status", statusPayload);
          stored.state.lastStatus = normalized;
        }
        await sleep(this.pollIntervalMs);
        continue;
      }

      if (normalized === "waiting_for_approval") {
        const approval = parseApprovalRequest(body);
        if (!approval) {
          yield this.failureEvent(runId, sequence++, "agentfield_approval_request_invalid", stored);
          return;
        }
        if (!stored.state.seenApprovalTokens.has(approval.runtimeApprovalToken)) {
          stored.state.seenApprovalTokens.add(approval.runtimeApprovalToken);
          this.log("info", "agentfield.bridge.approval.requested", {
            runId,
            executionId: stored.state.executionId,
            approvalType: approval.approvalType
          });
          yield event(runId, sequence++, "approval.requested", {
            ...approval,
            agentfieldExecutionId: stored.state.executionId,
            target: stored.state.target
          });
        }
        stored.state.lastStatus = normalized;
        await sleep(this.pollIntervalMs);
        continue;
      }

      stored.state.terminalPayload = sanitizeRecord(this.apiKey, body);
      if (normalized === "succeeded" || normalized === "completed") {
        const output = readOutputText(body);
        if (output) {
          yield event(runId, sequence++, "runtime.output", {
            text: output,
            agentfieldExecutionId: stored.state.executionId,
            target: stored.state.target,
            upstreamStatus: normalized
          });
        }
        yield event(runId, sequence++, "run.completed", {
          status: "completed",
          agentfieldExecutionId: stored.state.executionId,
          target: stored.state.target,
          upstreamStatus: normalized
        });
        stored.state.terminalStatus = "completed";
        return;
      }
      if (normalized === "failed") {
        yield this.failureEvent(runId, sequence++, "agentfield_status_failed", stored);
        return;
      }
      if (normalized === "cancelled") {
        yield this.failureEvent(runId, sequence++, "agentfield_upstream_cancelled", stored);
        return;
      }
      if (normalized === "timeout") {
        yield this.failureEvent(runId, sequence++, "agentfield_upstream_timeout", stored);
        return;
      }

      yield this.failureEvent(runId, sequence++, "agentfield_unknown_status", stored);
      return;
    }
  }

  async tools(): Promise<string[]> {
    return [];
  }

  async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    const stored = this.requireSession(session);
    const runId = requiredString(session["runId"], "runId");
    const artifacts: Artifact[] = [{
      id: "agentfield_transcript",
      type: "transcript",
      path: `runs/${runId}/agentfield-transcript.jsonl`,
      metadata: {
        content: stored.transcript.content(),
        agentfieldExecutionId: stored.state.executionId,
        target: stored.state.target,
        ...stored.transcript.metadata({
          runtime: "agentfield",
          mode: "async-rest",
          runtimeMode: AGENTFIELD_RUNTIME_MODE_SLUG
        })
      },
      createdAt: new Date().toISOString()
    }];

    if (stored.state.terminalPayload) {
      artifacts.push({
        id: "agentfield_result",
        type: "raw_log",
        path: `runs/${runId}/agentfield-result.json`,
        metadata: {
          content: JSON.stringify(stored.state.terminalPayload),
          agentfieldExecutionId: stored.state.executionId,
          target: stored.state.target
        },
        createdAt: new Date().toISOString()
      });
    }

    return artifacts;
  }

  private configFailure():
    | { state: "unavailable"; canRun: false; installed: false; auth: "unknown" | "missing" | "configured"; reasonCode: string; message: string }
    | undefined {
    if (!this.baseUrlRef) {
      return {
        state: "unavailable",
        canRun: false,
        installed: false,
        auth: "unknown",
        reasonCode: this.baseUrlState === "invalid" ? "agentfield_config_invalid" : "agentfield_config_missing",
        message: this.baseUrlState === "invalid"
          ? "SWITCHYARD_AGENTFIELD_BASE_URL must use http or https."
          : "SWITCHYARD_AGENTFIELD_BASE_URL is not configured."
      };
    }
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      return {
        state: "unavailable",
        canRun: false,
        installed: false,
        auth: "missing",
        reasonCode: "agentfield_auth_missing",
        message: "SWITCHYARD_AGENTFIELD_API_KEY is not configured."
      };
    }
    if (!this.target || this.target.trim().length === 0) {
      return {
        state: "unavailable",
        canRun: false,
        installed: false,
        auth: "configured",
        reasonCode: "agentfield_target_missing",
        message: "SWITCHYARD_AGENTFIELD_TARGET is not configured."
      };
    }
    return undefined;
  }

  private unavailableHealth(error: unknown): {
    state: "unknown";
    canRun: false;
    installed: true;
    auth: "configured";
    reasonCode: string;
    message: string;
  } {
    if (error instanceof AgentFieldResponseTooLargeError) {
      return {
        state: "unknown",
        canRun: false,
        installed: true,
        auth: "configured",
        reasonCode: "check_output_too_large",
        message: "Health response exceeded configured bounds."
      };
    }
    if (error instanceof AgentFieldInvalidJsonError) {
      return {
        state: "unknown",
        canRun: false,
        installed: true,
        auth: "configured",
        reasonCode: "agentfield_health_invalid",
        message: "Health response was invalid JSON."
      };
    }
    return {
      state: "unknown",
      canRun: false,
      installed: true,
      auth: "configured",
      reasonCode: isAbortOrTimeout(error) ? "check_timeout" : "agentfield_health_unavailable",
      message: sanitize(this.apiKey, error instanceof Error ? error.message : String(error))
    };
  }

  private parseCustomInput(metadata: Record<string, unknown>): Record<string, unknown> {
    if (metadata["input"] === undefined) {
      return {};
    }
    if (!isRecord(metadata["input"])) {
      throw new Error("agentfield_input_invalid");
    }
    rejectConfiguredOverrideKeys(metadata["input"], "agentfield input cannot override adapter configuration");
    return metadata["input"];
  }

  private async sendRuntimeInput(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void> {
    const text = runtimeInputText(input["text"]);
    const stored = this.requireSession(session);
    if (stored.state.terminalStatus) {
      throw new AdapterProtocolError("Runtime input is only supported for active AgentField executions.", {
        reasonCode: "runtime_input_not_active"
      });
    }
    const runId = readOptionalString(input["switchyardRunId"]) ?? requiredString(session["runId"], "runId");
    const bridgeCommandId = readOptionalString(input["bridgeCommandId"]);
    const idempotencyKey = readOptionalString(input["idempotencyKey"]);
    const body = {
      switchyardRunId: runId,
      ...(bridgeCommandId ? { bridgeCommandId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      type: "input",
      input: {
        text
      }
    };

    let response: AgentFieldRequestResult;
    try {
      response = await this.request(`api/v1/executions/${encodeURIComponent(stored.state.executionId)}/input`, {
        method: "POST",
        body,
        tooLargeReasonCode: "agentfield_input_response_too_large",
        invalidJsonReasonCode: "agentfield_invalid_input_response",
        requestFailedReasonCode: "agentfield_input_failed"
      }, stored.transcript);
    } catch (error) {
      throw bridgeProtocolError(error, {
        failedReasonCode: "agentfield_input_failed",
        invalidReasonCode: "agentfield_invalid_input_response",
        tooLargeReasonCode: "agentfield_input_response_too_large"
      });
    }

    if (!response.ok) {
      throw new AdapterProtocolError("AgentField input endpoint failed.", {
        reasonCode: "agentfield_input_failed"
      });
    }
    if (!isAcceptedResponse(response.body)) {
      throw new AdapterProtocolError("AgentField input response was malformed.", {
        reasonCode: "agentfield_invalid_input_response"
      });
    }
    this.log("info", "agentfield.bridge.input", {
      runId,
      executionId: stored.state.executionId,
      bridgeCommandId,
      status: response.status,
      durationMs: response.durationMs
    });
  }

  private async sendApprovalResolution(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void> {
    const runtimeApprovalToken = readOptionalString(input["runtimeApprovalToken"]);
    const decision = readApprovalDecision(input["decision"]);
    const answers = input["answers"];
    if (!runtimeApprovalToken || !decision || (answers !== undefined && !isRecord(answers))) {
      throw new AdapterProtocolError("Malformed AgentField approval resolution payload.", {
        reasonCode: "agentfield_approval_request_invalid"
      });
    }

    const stored = this.requireSession(session);
    if (stored.state.terminalStatus) {
      throw new AdapterProtocolError("Runtime approval resolution is only supported for active AgentField executions.", {
        reasonCode: "runtime_input_not_active"
      });
    }
    const runId = readOptionalString(input["switchyardRunId"]) ?? requiredString(session["runId"], "runId");
    const bridgeCommandId = readOptionalString(input["bridgeCommandId"]);
    const idempotencyKey = readOptionalString(input["idempotencyKey"]);
    const message = readOptionalString(input["message"]);
    const body = {
      switchyardRunId: runId,
      ...(bridgeCommandId ? { bridgeCommandId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      decision,
      ...(message ? { message } : {}),
      answers: answers ?? {}
    };

    let response: AgentFieldRequestResult;
    try {
      response = await this.request(
        `api/v1/executions/${encodeURIComponent(stored.state.executionId)}/approvals/${encodeURIComponent(runtimeApprovalToken)}/resolve`,
        {
          method: "POST",
          body,
          tooLargeReasonCode: "agentfield_approval_response_too_large",
          invalidJsonReasonCode: "agentfield_invalid_approval_response",
          requestFailedReasonCode: "agentfield_approval_resolution_failed"
        },
        stored.transcript
      );
    } catch (error) {
      throw bridgeProtocolError(error, {
        failedReasonCode: "agentfield_approval_resolution_failed",
        invalidReasonCode: "agentfield_invalid_approval_response",
        tooLargeReasonCode: "agentfield_approval_response_too_large"
      });
    }

    if (!response.ok) {
      throw new AdapterProtocolError("AgentField approval resolution endpoint failed.", {
        reasonCode: "agentfield_approval_resolution_failed"
      });
    }
    if (!isAcceptedResponse(response.body)) {
      throw new AdapterProtocolError("AgentField approval resolution response was malformed.", {
        reasonCode: "agentfield_invalid_approval_response"
      });
    }
    this.log("info", "agentfield.bridge.approval.resolved", {
      runId,
      executionId: stored.state.executionId,
      bridgeCommandId,
      decision,
      status: response.status
    });
  }

  private parseHeaderMetadata(metadata: Record<string, unknown>): {
    workflow?: string;
    session?: string;
    actor?: string;
  } {
    const result: { workflow?: string; session?: string; actor?: string } = {};
    for (const [source, target] of [
      ["workflow", "workflow"],
      ["session", "session"],
      ["actor", "actor"]
    ] as const) {
      const value = metadata[source];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("agentfield_header_metadata_invalid");
      }
      result[target] = value;
    }
    return result;
  }

  private requireSession(session: Record<string, unknown>): StoredSession {
    const sessionId = requiredString(session["sessionId"], "sessionId");
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      throw new Error(`AgentField session not found: ${sessionId}`);
    }
    return stored;
  }

  private async request(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      extraHeaders?: Record<string, string>;
      tooLargeReasonCode: string;
      invalidJsonReasonCode: string;
      requestFailedReasonCode?: string;
    },
    transcript?: TranscriptRecorder
  ): Promise<AgentFieldRequestResult> {
    const configFailure = this.configFailure();
    if (configFailure || !this.baseUrlRef || !this.apiKey) {
      throw new AgentFieldRequestError(
        String(configFailure?.reasonCode ?? "agentfield_config_missing"),
        String(configFailure?.message ?? "agentfield config missing")
      );
    }

    const url = new URL(path, this.baseUrlRef).toString();
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.apiKey}`,
      ...options.extraHeaders
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    try {
      const response = await requestJson({
        url,
        method: options.method,
        headers,
        body: options.body,
        timeoutMs: this.requestTimeoutMs,
        maxBytes: this.maxResponseBytes,
        tooLargeReasonCode: options.tooLargeReasonCode,
        invalidJsonReasonCode: options.invalidJsonReasonCode,
        requestFailedReasonCode: options.requestFailedReasonCode ?? "agentfield_request_failed",
        fetchImpl: this.fetchImpl
      });
      transcript?.appendHttpRequest({
        method: options.method,
        path: `/${path}`,
        status: response.status,
        durationMs: response.durationMs,
        bytes: response.bytes,
        maxBytes: this.maxResponseBytes
      });
      this.log("info", "agentfield.request", {
        method: options.method,
        path: `/${path}`,
        status: response.status,
        durationMs: response.durationMs
      });
      return response;
    } catch (error) {
      const reasonCode = eventErrorReason(error);
      const message = sanitize(this.apiKey, error instanceof Error ? error.message : String(error));
      transcript?.appendHttpRequest({
        method: options.method,
        path: `/${path}`,
        reasonCode,
        maxBytes: this.maxResponseBytes,
        message
      });
      this.log("warn", "agentfield.request", {
        method: options.method,
        path: `/${path}`,
        reasonCode
      });
      throw error;
    }
  }

  private failureEvent(runId: string, sequence: number, reasonCode: string, stored: StoredSession): SwitchyardEvent {
    stored.state.terminalStatus = "failed";
    return event(runId, sequence, "run.failed", {
      status: "failed",
      error: reasonCode,
      agentfieldExecutionId: stored.state.executionId,
      target: stored.state.target
    });
  }

  private log(level: keyof RuntimeLogger, eventName: string, details?: Record<string, unknown>): void {
    this.logger?.[level](eventName, details);
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function runtimeInputText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdapterProtocolError("Runtime input text must be non-empty.", {
      reasonCode: "runtime_input_empty"
    });
  }
  if (Buffer.byteLength(value, "utf8") > MAX_RUNTIME_INPUT_BYTES) {
    throw new AdapterProtocolError("Runtime input text exceeds 64 KiB.", {
      reasonCode: "runtime_input_too_large"
    });
  }
  return value;
}

function readApprovalDecision(value: unknown): "approved" | "rejected" | undefined {
  return value === "approved" || value === "rejected" ? value : undefined;
}

function rejectConfiguredOverrideKeys(input: Record<string, unknown>, message: string): void {
  for (const key of BRIDGE_OVERRIDE_KEYS) {
    if (input[key] !== undefined) {
      throw new AdapterProtocolError(message, {
        reasonCode: "agentfield_bridge_config_missing"
      });
    }
  }
}

function isAcceptedResponse(body: unknown): boolean {
  return isRecord(body) && body["accepted"] === true;
}

function bridgeReadiness(discoveryBody: Record<string, unknown> | undefined): Record<string, unknown> {
  const switchyardBridge = isRecord(discoveryBody?.["switchyard_bridge"])
    ? discoveryBody["switchyard_bridge"]
    : undefined;
  const input = switchyardBridge?.["input"] === true;
  const approvalRequest = switchyardBridge?.["approval_request"] === true;
  const approvalResolution = switchyardBridge?.["approval_resolution"] === true;
  const bridgeCapable = input && approvalRequest && approvalResolution;
  return {
    bridgeCapable,
    canBridge: bridgeCapable,
    reasonCode: bridgeCapable ? null : "agentfield_bridge_capability_missing",
    capabilities: {
      input,
      approvalRequest,
      approvalResolution
    }
  };
}

function parseApprovalRequest(body: Record<string, unknown>): AgentFieldApprovalRequest | undefined {
  const approval = isRecord(body["approval"]) ? body["approval"] : undefined;
  const runtimeApprovalToken = readOptionalString(approval?.["token"]);
  const approvalType = readOptionalString(approval?.["approval_type"]);
  const expiresAt = readOptionalString(approval?.["expires_at"]);
  if (!runtimeApprovalToken || !approvalType || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
    return undefined;
  }
  const payload: AgentFieldApprovalRequest = {
    runtimeApprovalToken,
    approvalType,
    expiresAt
  };
  const message = readOptionalString(approval?.["message"]);
  if (message) {
    payload["message"] = message;
  }
  if (isRecord(approval?.["answers"])) {
    payload["answers"] = approval["answers"];
  }
  return payload;
}

function bridgeProtocolError(
  error: unknown,
  reasonCodes: { failedReasonCode: string; invalidReasonCode: string; tooLargeReasonCode: string }
): AdapterProtocolError {
  if (error instanceof AdapterProtocolError) {
    return error;
  }
  if (error instanceof AgentFieldResponseTooLargeError) {
    return new AdapterProtocolError("AgentField bridge response exceeded configured bounds.", {
      reasonCode: reasonCodes.tooLargeReasonCode
    });
  }
  if (error instanceof AgentFieldInvalidJsonError) {
    return new AdapterProtocolError("AgentField bridge response was invalid JSON.", {
      reasonCode: reasonCodes.invalidReasonCode
    });
  }
  if (error instanceof AgentFieldRequestError) {
    return new AdapterProtocolError(sanitize(undefined, error.message), {
      reasonCode: reasonCodes.failedReasonCode
    });
  }
  return new AdapterProtocolError(error instanceof Error ? error.message : String(error), {
    reasonCode: reasonCodes.failedReasonCode
  });
}

function parseBaseUrl(value: string | undefined): { url?: URL; state: "missing" | "invalid" | "configured" } {
  if (!value || value.trim().length === 0) {
    return { state: "missing" };
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { state: "invalid" };
    }
    if (!parsed.pathname.endsWith("/")) {
      parsed.pathname = `${parsed.pathname}/`;
    }
    return { state: "configured", url: parsed };
  } catch {
    return { state: "invalid" };
  }
}

function readExecutionId(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const id = body["execution_id"] ?? body["executionId"] ?? body["id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function readOutputText(body: Record<string, unknown>): string | undefined {
  const result = body["result"];
  if (typeof result === "string") {
    return result;
  }
  if (isRecord(result)) {
    if (typeof result["output_text"] === "string" && result["output_text"].length > 0) {
      return result["output_text"];
    }
    if (typeof result["text"] === "string" && result["text"].length > 0) {
      return result["text"];
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeRecord(token: string | undefined, value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(sanitize(token, JSON.stringify(value))) as Record<string, unknown>;
}

function event(
  runId: string,
  sequence: number,
  type: SwitchyardEvent["type"],
  payload: Record<string, unknown>
): SwitchyardEvent {
  return {
    id: `event_${crypto.randomUUID()}`,
    type,
    runId,
    sequence,
    payload,
    createdAt: new Date().toISOString()
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventErrorReason(error: unknown): string {
  if (error instanceof AgentFieldResponseTooLargeError) {
    return error.reasonCode;
  }
  if (error instanceof AgentFieldInvalidJsonError) {
    return error.reasonCode;
  }
  if (error instanceof AgentFieldRequestError) {
    return isAbortOrTimeout(error) ? "check_timeout" : error.reasonCode;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "agentfield_request_failed";
}

function isAbortOrTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || /timeout/i.test(error.message);
}

function sanitize(token: string | undefined, value: string): string {
  let output = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/([A-Za-z0-9_-]*token[A-Za-z0-9_-]*\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/([A-Za-z0-9_-]*(?:_key|_secret)[A-Za-z0-9_-]*\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
  if (token && token.length > 0) {
    output = output.replaceAll(token, "[REDACTED]");
  }
  return output;
}
