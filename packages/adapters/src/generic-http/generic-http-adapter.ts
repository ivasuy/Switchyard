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
  GenericHttpInvalidJsonError,
  GenericHttpRequestError,
  GenericHttpResponseTooLargeError,
  requestJson
} from "./http-client.js";
import type {
  GenericHttpAsyncRestAdapterOptions,
  GenericHttpRequestResult,
  GenericHttpSessionState
} from "./types.js";

export const GENERIC_HTTP_RUNTIME_MODE_SLUG = "generic_http.async_rest";

interface StoredSession {
  state: GenericHttpSessionState;
  transcript: TranscriptRecorder;
}

type GenericHttpRuntimeStatus = "running" | "waiting_for_input" | "resumed" | "completed" | "failed" | "cancelled";
type BridgeSendKind = "input" | "approval_resolution";

const MAX_RUNTIME_INPUT_BYTES = 64 * 1024;
const BRIDGE_CAPABILITIES = ["input", "approval_request", "approval_resolution"] as const;

export class GenericHttpAsyncRestAdapter implements RuntimeAdapter {
  readonly id = "generic_http";
  readonly manifest: RuntimeAdapterManifest = {
    adapterId: "generic_http",
    providerId: "provider_generic_http",
    runtimeId: "runtime_generic_http",
    runtimeModeId: "runtime_mode_generic_http_async_rest",
    runtimeModeSlug: GENERIC_HTTP_RUNTIME_MODE_SLUG,
    name: "Generic HTTP async REST",
    adapterType: "http",
    kind: "async_rest",
    capabilities: [
      "run.start",
      "run.input",
      "run.timeout",
      "approval.bridge",
      "event.normalized",
      "event.streaming",
      "artifact.transcript",
      "auth.api_key"
    ],
    limitations: [
      { code: "configured_wrapper_only", message: "Generic HTTP wrapper endpoints are operator configured and cannot be overridden per run." },
      { code: "hosted_bridge_readiness_required", message: "Hosted Generic HTTP bridge paths require wrapper_config and wrapper_bridge_capability readiness checks." },
      { code: "no_hosted_cancel_bridge", message: "Hosted active cancellation bridge is not shipped." },
      { code: "production_forbidden", message: "Hosted generic_http.async_rest production execution is forbidden unless explicitly activated by provider policy." }
    ],
    placement: {
      local: { support: "conditional", reason: "Requires SWITCHYARD_GENERIC_HTTP_BASE_URL to point at a reachable HTTP wrapper." },
      hosted: { support: "conditional", reason: "Worker execution requires explicit operator opt-in and provider activation." },
      connectedLocalNode: { support: "future", reason: "Connected node support remains future scope." }
    },
    docsPath: "docs/development/adapters/GENERIC_HTTP.md",
    check: {
      strategy: "http_health",
      required: ["wrapper_config", "wrapper_bridge_capability"],
      optional: ["auth_token_present"]
    }
  };

  private readonly baseUrlRef: URL | undefined;
  private readonly baseUrlState: "missing" | "invalid" | "configured";
  private readonly authToken: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxResponseBytes: number;
  private readonly logger: RuntimeLogger | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly sessions = new Map<string, StoredSession>();

  constructor(options: GenericHttpAsyncRestAdapterOptions = {}) {
    const parsed = parseBaseUrl(options.baseUrl);
    this.baseUrlRef = parsed.url;
    this.baseUrlState = parsed.state;
    this.authToken = options.authToken;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.logger = options.logger;
    this.fetchImpl = options.fetch;
  }

  async check(): Promise<RuntimeAdapterCheck> {
    if (!this.baseUrlRef) {
      return {
        ok: false,
        details: {
          availability: {
            state: "unavailable",
            canRun: false,
            installed: false,
            auth: "unknown",
            reasonCode: this.baseUrlState === "invalid" ? "generic_http_config_invalid" : "generic_http_config_missing",
            message: this.baseUrlState === "invalid"
              ? "SWITCHYARD_GENERIC_HTTP_BASE_URL must use http or https."
              : "SWITCHYARD_GENERIC_HTTP_BASE_URL is not configured."
          }
        }
      };
    }

    try {
      const response = await this.request("/health", {
        method: "GET",
        tooLargeReasonCode: "check_output_too_large",
        invalidJsonReasonCode: "generic_http_health_invalid"
      });
      if (!response.ok) {
        return {
          ok: false,
          details: {
            availability: {
              state: "unavailable",
              canRun: false,
              installed: true,
              auth: this.authToken ? "configured" : "unknown",
              reasonCode: "generic_http_health_unavailable",
              message: `health endpoint returned ${response.status}`
            }
          }
        };
      }
      const capabilities = readCapabilities(response.body);
      const bridgeReady = hasBridgeCapabilities(capabilities);
      return {
        ok: true,
        details: {
          availability: {
            state: "available",
            canRun: true,
            installed: true,
            auth: this.authToken ? "configured" : "not_required",
            reasonCode: null,
            message: null
          },
          bridge: {
            state: bridgeReady ? "ready" : "unavailable",
            canBridge: bridgeReady,
            reasonCode: bridgeReady ? null : "generic_http_bridge_capability_missing",
            message: bridgeReady ? null : "Generic HTTP health does not advertise input, approval_request, and approval_resolution.",
            capabilities
          }
        }
      };
    } catch (error) {
      if (error instanceof GenericHttpResponseTooLargeError) {
        return {
          ok: false,
          details: {
            availability: {
              state: "unknown",
              canRun: false,
              installed: true,
              auth: this.authToken ? "configured" : "unknown",
              reasonCode: "check_output_too_large",
              message: "Health response exceeded configured bounds."
            }
          }
        };
      }
      if (error instanceof GenericHttpInvalidJsonError) {
        return {
          ok: false,
          details: {
            availability: {
              state: "unknown",
              canRun: false,
              installed: true,
              auth: this.authToken ? "configured" : "unknown",
              reasonCode: "generic_http_health_invalid",
              message: "Health response was invalid JSON."
            }
          }
        };
      }
      return {
        ok: false,
        details: {
          availability: {
            state: "unknown",
            canRun: false,
            installed: true,
            auth: this.authToken ? "configured" : "unknown",
            reasonCode: isAbortOrTimeout(error) ? "check_timeout" : "generic_http_health_unavailable",
            message: sanitize(this.authToken, error instanceof Error ? error.message : String(error))
          }
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

    if (!this.baseUrlRef) {
      throw new Error("generic_http_config_missing");
    }

    const response = await this.request("/v1/runs", {
      method: "POST",
      body: {
        runId,
        runtime,
        runtimeMode,
        provider,
        model,
        cwd,
        task,
        metadata
      },
      tooLargeReasonCode: "generic_http_start_response_too_large",
      invalidJsonReasonCode: "generic_http_invalid_start_response"
    });
    if (!response.ok) {
      throw new Error("generic_http_start_failed");
    }
    if (!isRecord(response.body) || typeof response.body["externalRunId"] !== "string" || response.body["externalRunId"].length === 0) {
      throw new Error("generic_http_invalid_start_response");
    }

    const sessionId = `session_${crypto.randomUUID()}`;
    const externalRunId = response.body["externalRunId"];
    const transcript = new TranscriptRecorder();
    this.sessions.set(sessionId, {
      state: {
        sessionId,
        runId,
        externalRunId,
        seenEventIds: new Set<string>(),
        seenEventKeys: new Set<string>()
      },
      transcript
    });
    this.log("info", "generic_http.start", {
      runId,
      externalRunId,
      status: response.status
    });
    return {
      sessionId,
      externalSessionKey: externalRunId
    };
  }

  async send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void> {
    const stored = this.requireSession(session);
    const type = input["type"] === "approval_resolution" ? "approval_resolution" : "input";

    if (type === "approval_resolution") {
      await this.sendApprovalResolution(stored, input);
      return;
    }

    await this.sendInput(stored, input);
  }

  async cancel(session: Record<string, unknown>): Promise<void> {
    const stored = this.requireSession(session);
    if (stored.state.terminalStatus) {
      return;
    }

    let response: GenericHttpRequestResult;
    try {
      response = await this.request(`/v1/runs/${stored.state.externalRunId}/cancel`, {
        method: "POST",
        tooLargeReasonCode: "generic_http_cancel_response_too_large",
        invalidJsonReasonCode: "generic_http_cancel_failed"
      }, stored.transcript);
    } catch (error) {
      throw toCancelProtocolError(this.authToken, error);
    }

    if (!response.ok) {
      if (response.status !== 404) {
        throw new AdapterProtocolError("generic_http_cancel_failed", { reasonCode: "generic_http_cancel_failed" });
      }
    } else if (isRecord(response.body) && response.body["cancelled"] === false) {
      throw new AdapterProtocolError("generic_http_cancel_failed", { reasonCode: "generic_http_cancel_failed" });
    }

    const status = await this.fetchStatus(stored);
    if (status !== "cancelled") {
      throw new AdapterProtocolError("generic_http_cancel_failed", { reasonCode: "generic_http_cancel_failed" });
    }
    stored.state.terminalStatus = "cancelled";
  }

  async *events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    const stored = this.requireSession(session);
    const runId = requiredString(session["runId"], "runId");
    let sequence = 0;
    let terminalEmitted = false;

    while (!terminalEmitted) {
      let response: GenericHttpRequestResult;
      try {
        const path = stored.state.cursor
          ? `/v1/runs/${stored.state.externalRunId}/events?cursor=${encodeURIComponent(stored.state.cursor)}`
          : `/v1/runs/${stored.state.externalRunId}/events`;
        response = await this.request(path, {
          method: "GET",
          tooLargeReasonCode: "generic_http_events_response_too_large",
          invalidJsonReasonCode: "generic_http_invalid_events_response"
        }, stored.transcript);
      } catch (error) {
        yield failureEvent(runId, sequence++, eventErrorReason(error), this.authToken);
        return;
      }

      if (!response.ok || !isRecord(response.body) || !Array.isArray(response.body["events"])) {
        yield failureEvent(runId, sequence++, "generic_http_invalid_events_response", this.authToken);
        return;
      }

      const wrapperEvents = response.body["events"] as Array<Record<string, unknown>>;
      let terminalInBatch = false;
      let lastSeenId: string | undefined;
      for (const wrapperEvent of wrapperEvents) {
        const sourceId = typeof wrapperEvent["id"] === "string" ? wrapperEvent["id"] : undefined;
        const dedupeKey = sourceId ?? eventDedupeKey(wrapperEvent);
        if (sourceId) {
          if (stored.state.seenEventIds.has(sourceId)) {
            continue;
          }
          stored.state.seenEventIds.add(sourceId);
          lastSeenId = sourceId;
        } else if (stored.state.seenEventKeys.has(dedupeKey)) {
          continue;
        } else {
          stored.state.seenEventKeys.add(dedupeKey);
        }

        const mapped = mapWrapperEvent(runId, sequence++, wrapperEvent, sourceId);
        if (mapped.type === "approval.requested") {
          this.log("info", "generic_http.bridge.approval.requested", {
            runId,
            sourceEventId: sourceId,
            approvalType: mapped.payload["approvalType"]
          });
        }
        yield mapped;
        if (mapped.type === "run.completed" || mapped.type === "run.failed" || mapped.type === "run.cancelled") {
          terminalEmitted = true;
          terminalInBatch = true;
          stored.state.terminalStatus = mapped.type === "run.completed"
            ? "completed"
            : mapped.type === "run.cancelled"
              ? "cancelled"
              : "failed";
          break;
        }
      }

      const nextCursor = typeof response.body["nextCursor"] === "string" ? response.body["nextCursor"] : undefined;
      if (nextCursor) {
        stored.state.cursor = nextCursor;
      } else if (lastSeenId) {
        stored.state.cursor = lastSeenId;
      }

      if (terminalEmitted) {
        return;
      }

      if (wrapperEvents.length === 0 || (response.body["terminal"] === true && !terminalInBatch)) {
        let status: GenericHttpRuntimeStatus;
        try {
          status = await this.fetchStatus(stored);
        } catch (error) {
          yield failureEvent(runId, sequence++, eventErrorReason(error), this.authToken);
          return;
        }

        if (status === "completed" || status === "failed" || status === "cancelled") {
          const eventType = status === "completed" ? "run.completed" : status === "cancelled" ? "run.cancelled" : "run.failed";
          yield {
            id: `event_${crypto.randomUUID()}`,
            type: eventType,
            runId,
            sequence: sequence++,
            payload: { status },
            createdAt: new Date().toISOString()
          };
          terminalEmitted = true;
          stored.state.terminalStatus = status;
          return;
        }
        if (status === "waiting_for_input" || status === "resumed") {
          yield {
            id: `event_${crypto.randomUUID()}`,
            type: "runtime.status",
            runId,
            sequence: sequence++,
            payload: { status },
            createdAt: new Date().toISOString()
          };
        }
        if (response.body["terminal"] === true) {
          yield failureEvent(runId, sequence++, "generic_http_invalid_events_response", this.authToken);
          return;
        }
      }

      await sleep(this.pollIntervalMs);
    }
  }

  async tools(): Promise<string[]> {
    return [];
  }

  async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    const stored = this.requireSession(session);
    const runId = requiredString(session["runId"], "runId");

    const response = await this.request(`/v1/runs/${stored.state.externalRunId}/artifacts`, {
      method: "GET",
      tooLargeReasonCode: "generic_http_artifacts_response_too_large",
      invalidJsonReasonCode: "generic_http_invalid_artifacts_response"
    }, stored.transcript);
    if (!response.ok) {
      throw new Error("generic_http_invalid_artifacts_response");
    }
    if (!isRecord(response.body) || !Array.isArray(response.body["artifacts"])) {
      throw new Error("generic_http_invalid_artifacts_response");
    }

    const artifacts: Artifact[] = [];
    for (const entry of response.body["artifacts"] as Array<Record<string, unknown>>) {
      const id = typeof entry["id"] === "string" ? entry["id"] : `artifact_${crypto.randomUUID()}`;
      const rawName = typeof entry["name"] === "string" ? entry["name"] : `${id}.log`;
      const safeName = sanitizeFileName(rawName);
      const type = artifactTypeFromValue(entry["type"]);
      const content = typeof entry["content"] === "string" ? sanitize(this.authToken, entry["content"]) : undefined;
      artifacts.push({
        id,
        type,
        path: `runs/${runId}/generic-http/${safeName}`,
        metadata: {
          originalName: rawName,
          ...(content ? { content } : {})
        },
        createdAt: new Date().toISOString()
      });
    }

    artifacts.push({
      id: `artifact_generic_http_transcript_${runId}`,
      type: "transcript",
      path: `runs/${runId}/generic-http-transcript.jsonl`,
      metadata: {
        content: stored.transcript.content(),
        ...stored.transcript.metadata({
          runtime: "generic_http",
          mode: "async-rest",
          runtimeMode: GENERIC_HTTP_RUNTIME_MODE_SLUG
        })
      },
      createdAt: new Date().toISOString()
    });
    return artifacts;
  }

  private requireSession(session: Record<string, unknown>): StoredSession {
    const sessionId = requiredString(session["sessionId"], "sessionId");
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      throw new Error(`Generic HTTP session not found: ${sessionId}`);
    }
    return stored;
  }

  private async sendInput(stored: StoredSession, input: Record<string, unknown>): Promise<void> {
    const text = validateInputText(input["text"]);
    const switchyardRunId = requiredString(input["switchyardRunId"] ?? stored.state.runId, "switchyardRunId");
    const bridgeCommandId = typeof input["bridgeCommandId"] === "string" && input["bridgeCommandId"].length > 0
      ? input["bridgeCommandId"]
      : `generic_http_local_input_${crypto.randomUUID()}`;
    const idempotencyKey = typeof input["idempotencyKey"] === "string" && input["idempotencyKey"].length > 0
      ? input["idempotencyKey"]
      : `generic_http_local_idempotency_${crypto.randomUUID()}`;

    let response: GenericHttpRequestResult;
    try {
      response = await this.request(`/v1/runs/${stored.state.externalRunId}/input`, {
        method: "POST",
        body: {
          switchyardRunId,
          bridgeCommandId,
          idempotencyKey,
          type: "input",
          text
        },
        tooLargeReasonCode: "generic_http_input_response_too_large",
        invalidJsonReasonCode: "generic_http_invalid_input_response"
      }, stored.transcript);
    } catch (error) {
      throw toBridgeProtocolError("input", this.authToken, error);
    }

    if (!response.ok) {
      throw new AdapterProtocolError("Generic HTTP input endpoint failed.", {
        reasonCode: "generic_http_input_failed"
      });
    }
    if (!isRecord(response.body) || response.body["accepted"] !== true) {
      throw new AdapterProtocolError("Generic HTTP input response was invalid.", {
        reasonCode: "generic_http_invalid_input_response"
      });
    }
    this.log("info", "generic_http.bridge.input", {
      runId: stored.state.runId,
      externalRunId: stored.state.externalRunId,
      bridgeCommandId,
      status: response.status
    });
  }

  private async sendApprovalResolution(stored: StoredSession, input: Record<string, unknown>): Promise<void> {
    const switchyardRunId = requiredString(input["switchyardRunId"] ?? stored.state.runId, "switchyardRunId");
    const bridgeCommandId = requiredString(input["bridgeCommandId"], "bridgeCommandId");
    const idempotencyKey = requiredString(input["idempotencyKey"], "idempotencyKey");
    const runtimeApprovalToken = validateApprovalToken(input["runtimeApprovalToken"]);
    const decision = validateApprovalDecision(input["decision"]);
    const message = typeof input["message"] === "string" && input["message"].trim().length > 0
      ? input["message"].trim()
      : `${decision} by switchyard`;
    const answers = validateAnswers(input["answers"]);

    let response: GenericHttpRequestResult;
    try {
      response = await this.request(
        `/v1/runs/${stored.state.externalRunId}/approvals/${encodeURIComponent(runtimeApprovalToken)}/resolve`,
        {
          method: "POST",
          body: {
            switchyardRunId,
            bridgeCommandId,
            idempotencyKey,
            decision,
            message,
            answers
          },
          tooLargeReasonCode: "generic_http_approval_response_too_large",
          invalidJsonReasonCode: "generic_http_invalid_approval_response",
          recordPath: `/v1/runs/${stored.state.externalRunId}/approvals/:runtimeApprovalToken/resolve`
        },
        stored.transcript
      );
    } catch (error) {
      throw toBridgeProtocolError("approval_resolution", this.authToken, error);
    }

    if (!response.ok) {
      throw new AdapterProtocolError("Generic HTTP approval resolution endpoint failed.", {
        reasonCode: "generic_http_approval_resolution_failed"
      });
    }
    if (!isRecord(response.body) || response.body["accepted"] !== true) {
      throw new AdapterProtocolError("Generic HTTP approval response was invalid.", {
        reasonCode: "generic_http_invalid_approval_response"
      });
    }
    this.log("info", "generic_http.bridge.approval.resolved", {
      runId: stored.state.runId,
      externalRunId: stored.state.externalRunId,
      bridgeCommandId,
      decision,
      status: response.status
    });
  }

  private async fetchStatus(stored: StoredSession): Promise<GenericHttpRuntimeStatus> {
    const response = await this.request(`/v1/runs/${stored.state.externalRunId}`, {
      method: "GET",
      tooLargeReasonCode: "generic_http_status_response_too_large",
      invalidJsonReasonCode: "generic_http_invalid_status_response"
    }, stored.transcript);
    if (!response.ok || !isRecord(response.body) || typeof response.body["status"] !== "string") {
      throw new Error("generic_http_invalid_status_response");
    }
    const status = response.body["status"];
    if (isGenericHttpRuntimeStatus(status)) {
      return status;
    }
    throw new Error("generic_http_invalid_status_response");
  }

  private async request(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      tooLargeReasonCode: string;
      invalidJsonReasonCode: string;
      recordPath?: string;
    },
    transcript?: TranscriptRecorder
  ): Promise<GenericHttpRequestResult> {
    if (!this.baseUrlRef) {
      throw new GenericHttpRequestError("generic_http_config_missing", "base url missing");
    }
    const url = new URL(path, this.baseUrlRef).toString();
    const headers: Record<string, string> = {
      accept: "application/json"
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.authToken) {
      headers.authorization = `Bearer ${this.authToken}`;
    }
    const recordPath = options.recordPath ?? path;

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
        fetchImpl: this.fetchImpl
      });
      transcript?.appendHttpRequest({
        method: options.method,
        path: recordPath,
        status: response.status,
        durationMs: response.durationMs,
        bytes: response.bytes,
        maxBytes: this.maxResponseBytes
      });
      this.log("info", "generic_http.request", { method: options.method, path: recordPath, status: response.status, durationMs: response.durationMs });
      return response;
    } catch (error) {
      const reasonCode = eventErrorReason(error);
      transcript?.appendHttpRequest({
        method: options.method,
        path: recordPath,
        reasonCode,
        maxBytes: this.maxResponseBytes,
        message: sanitize(this.authToken, error instanceof Error ? error.message : String(error))
      });
      this.log("warn", "generic_http.request", { method: options.method, path: recordPath, reasonCode });
      throw error;
    }
  }

  private log(level: keyof RuntimeLogger, event: string, details?: Record<string, unknown>): void {
    this.logger?.[level](event, details);
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function bridgeProtocolError(message: string, reasonCode: string): AdapterProtocolError {
  return new AdapterProtocolError(message, { reasonCode });
}

function requiredProtocolString(value: unknown, name: string, reasonCode: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw bridgeProtocolError(`${name} is required`, reasonCode);
  }
  return value;
}

function validateInputText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw bridgeProtocolError("Runtime input text must be non-empty.", "runtime_input_empty");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_RUNTIME_INPUT_BYTES) {
    throw bridgeProtocolError("Runtime input text is too large.", "runtime_input_too_large");
  }
  return value;
}

function validateApprovalToken(value: unknown): string {
  return requiredProtocolString(value, "runtimeApprovalToken", "generic_http_invalid_approval_response");
}

function validateApprovalDecision(value: unknown): "approved" | "rejected" {
  if (value !== "approved" && value !== "rejected") {
    throw bridgeProtocolError("Generic HTTP approval decision is invalid.", "generic_http_invalid_approval_response");
  }
  return value;
}

function validateAnswers(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw bridgeProtocolError("Generic HTTP approval answers must be an object.", "generic_http_invalid_approval_response");
  }
  return value;
}

function readCapabilities(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body["capabilities"])) {
    return [];
  }
  return body["capabilities"].filter((capability): capability is string => typeof capability === "string");
}

function hasBridgeCapabilities(capabilities: string[]): boolean {
  return BRIDGE_CAPABILITIES.every((capability) => capabilities.includes(capability));
}

function isGenericHttpRuntimeStatus(value: unknown): value is GenericHttpRuntimeStatus {
  return value === "running"
    || value === "waiting_for_input"
    || value === "resumed"
    || value === "completed"
    || value === "failed"
    || value === "cancelled";
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
    return { state: "configured", url: parsed };
  } catch {
    return { state: "invalid" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mapWrapperEvent(
  runId: string,
  sequence: number,
  wrapperEvent: Record<string, unknown>,
  sourceEventId: string | undefined
): SwitchyardEvent {
  let type = typeof wrapperEvent["type"] === "string" ? wrapperEvent["type"] : "runtime.status";
  const payload: Record<string, unknown> = {};
  if (type === "runtime.output") {
    payload["text"] = typeof wrapperEvent["text"] === "string" ? wrapperEvent["text"] : "";
  } else if (type === "runtime.status") {
    payload["status"] = typeof wrapperEvent["status"] === "string" ? wrapperEvent["status"] : "running";
  } else if (type === "approval.requested") {
    const runtimeApprovalToken = typeof wrapperEvent["runtimeApprovalToken"] === "string" && wrapperEvent["runtimeApprovalToken"].length > 0
      ? wrapperEvent["runtimeApprovalToken"]
      : undefined;
    const approvalType = typeof wrapperEvent["approvalType"] === "string" && wrapperEvent["approvalType"].length > 0
      ? wrapperEvent["approvalType"]
      : undefined;
    const expiresAt = typeof wrapperEvent["expiresAt"] === "string" && wrapperEvent["expiresAt"].length > 0
      ? wrapperEvent["expiresAt"]
      : undefined;
    const answers = wrapperEvent["answers"];
    if (!runtimeApprovalToken || !approvalType || !expiresAt || (answers !== undefined && !isRecord(answers))) {
      type = "run.failed";
      payload["status"] = "failed";
      payload["error"] = "generic_http_approval_request_invalid";
    } else {
      payload["runtimeApprovalToken"] = runtimeApprovalToken;
      payload["approvalType"] = approvalType;
      payload["message"] = typeof wrapperEvent["message"] === "string" ? wrapperEvent["message"] : "";
      payload["expiresAt"] = expiresAt;
      if (isRecord(answers)) {
        payload["answers"] = answers;
      }
    }
  } else if (type === "run.failed") {
    payload["status"] = "failed";
    if (typeof wrapperEvent["error"] === "string") {
      payload["error"] = wrapperEvent["error"];
    }
  } else if (type === "run.completed") {
    payload["status"] = "completed";
  } else if (type === "run.cancelled") {
    payload["status"] = "cancelled";
  } else {
    payload["status"] = "unknown_event";
    payload["eventType"] = type;
    type = "runtime.status";
  }
  if (sourceEventId) {
    payload["sourceEventId"] = sourceEventId;
  }
  return {
    id: `event_${crypto.randomUUID()}`,
    type: type as SwitchyardEvent["type"],
    runId,
    sequence,
    payload,
    createdAt: new Date().toISOString()
  };
}

function failureEvent(runId: string, sequence: number, reasonCode: string, token?: string): SwitchyardEvent {
  return {
    id: `event_${crypto.randomUUID()}`,
    type: "run.failed",
    runId,
    sequence,
    payload: {
      status: "failed",
      error: sanitize(token, reasonCode)
    },
    createdAt: new Date().toISOString()
  };
}

function sanitizeFileName(value: string): string {
  const basename = value.split(/[\\/]/).pop() ?? "artifact.log";
  return basename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function artifactTypeFromValue(value: unknown): "transcript" | "raw_log" | "screenshot" {
  if (value === "transcript" || value === "raw_log" || value === "screenshot") {
    return value;
  }
  return "raw_log";
}

function eventDedupeKey(event: Record<string, unknown>): string {
  return JSON.stringify({
    type: event["type"],
    status: event["status"],
    text: event["text"],
    error: event["error"],
    runtimeApprovalToken: event["runtimeApprovalToken"],
    approvalType: event["approvalType"],
    expiresAt: event["expiresAt"]
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventErrorReason(error: unknown): string {
  if (error instanceof GenericHttpResponseTooLargeError) {
    return error.reasonCode;
  }
  if (error instanceof GenericHttpInvalidJsonError) {
    return error.reasonCode;
  }
  if (error instanceof GenericHttpRequestError) {
    return isAbortOrTimeout(error) ? "check_timeout" : error.reasonCode;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "generic_http_request_failed";
}

function toCancelProtocolError(token: string | undefined, error: unknown): AdapterProtocolError {
  if (error instanceof GenericHttpResponseTooLargeError) {
    return new AdapterProtocolError("cancel response too large", {
      reasonCode: "generic_http_cancel_response_too_large"
    });
  }
  return new AdapterProtocolError(sanitize(token, error instanceof Error ? error.message : String(error)), {
    reasonCode: "generic_http_cancel_failed"
  });
}

function toBridgeProtocolError(kind: BridgeSendKind, token: string | undefined, error: unknown): AdapterProtocolError {
  if (error instanceof AdapterProtocolError) {
    return error;
  }
  if (error instanceof GenericHttpResponseTooLargeError) {
    return new AdapterProtocolError("Generic HTTP bridge response was too large.", {
      reasonCode: kind === "input" ? "generic_http_input_response_too_large" : "generic_http_approval_response_too_large"
    });
  }
  if (error instanceof GenericHttpInvalidJsonError) {
    return new AdapterProtocolError("Generic HTTP bridge response was invalid.", {
      reasonCode: kind === "input" ? "generic_http_invalid_input_response" : "generic_http_invalid_approval_response"
    });
  }
  return new AdapterProtocolError(sanitize(token, error instanceof Error ? error.message : String(error)), {
    reasonCode: kind === "input" ? "generic_http_input_failed" : "generic_http_approval_resolution_failed"
  });
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
    .replace(/([A-Za-z0-9_-]*token[A-Za-z0-9_-]*\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
  if (token && token.length > 0) {
    output = output.replaceAll(token, "[REDACTED]");
  }
  return output;
}
