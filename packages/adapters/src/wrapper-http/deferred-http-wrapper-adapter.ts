import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import {
  AdapterProtocolError,
  type RuntimeAdapter,
  type RuntimeAdapterCheck,
  type RuntimeAdapterManifest,
  type RuntimeLogger,
  type RuntimeStartResult
} from "@switchyard/core";
import {
  GenericHttpInvalidJsonError,
  GenericHttpRequestError,
  GenericHttpResponseTooLargeError,
  requestJson
} from "../generic-http/http-client.js";
import type {
  DeferredHttpWrapperAdapterDefinition,
  DeferredHttpWrapperAdapterOptions
} from "./types.js";

export class DeferredHttpWrapperAdapter implements RuntimeAdapter {
  readonly id: string;
  readonly manifest: RuntimeAdapterManifest;

  private readonly definition: DeferredHttpWrapperAdapterDefinition;
  private readonly baseUrlRef: URL | undefined;
  private readonly baseUrlState: "missing" | "invalid" | "configured";
  private readonly apiKey: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly logger: RuntimeLogger | undefined;

  constructor(definition: DeferredHttpWrapperAdapterDefinition, options: DeferredHttpWrapperAdapterOptions = {}) {
    this.definition = definition;
    this.id = definition.adapterId;
    this.manifest = {
      adapterId: definition.adapterId,
      providerId: definition.providerId,
      runtimeId: definition.runtimeId,
      runtimeModeId: definition.runtimeModeId,
      runtimeModeSlug: definition.runtimeModeSlug,
      name: definition.name,
      adapterType: "http",
      kind: "async_rest",
      capabilities: [
        "run.start",
        "run.timeout",
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "auth.api_key"
      ],
      limitations: [
        {
          code: "api_boundary_unverified",
          message: `${definition.name} upstream run/status/event contract is not verified.`
        },
        {
          code: "configured_wrapper_only",
          message: `${definition.name} base URL and API key are operator configured and cannot be overridden per run.`
        },
        {
          code: "start_disabled_until_verified",
          message: `${definition.name} start is blocked until source/API fixtures verify the wrapper contract.`
        }
      ],
      placement: {
        local: { support: "conditional", reason: `Requires ${definition.configPrefix}_BASE_URL and verified upstream API shape.` },
        hosted: { support: "unsupported", reason: `${definition.name} hosted execution is not shipped.` },
        connectedLocalNode: { support: "future", reason: `${definition.name} connected-node execution is deferred until local wrapper execution is verified.` }
      },
      docsPath: definition.docsPath,
      check: {
        strategy: "http_health",
        required: ["wrapper_config", "api_boundary_verification"],
        optional: ["auth_token_present"]
      }
    };

    const parsed = parseBaseUrl(options.baseUrl);
    this.baseUrlRef = parsed.url;
    this.baseUrlState = parsed.state;
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.fetchImpl = options.fetch;
    this.logger = options.logger;
  }

  async check(): Promise<RuntimeAdapterCheck> {
    if (!this.baseUrlRef) {
      return {
        ok: false,
        details: {
          availability: this.availability({
            state: "unavailable",
            canRun: false,
            installed: false,
            auth: this.apiKey ? "configured" : "unknown",
            reasonCode: this.baseUrlState === "invalid"
              ? this.definition.invalidConfigReasonCode
              : this.definition.unavailableReasonCode,
            message: this.baseUrlState === "invalid"
              ? `${this.definition.configPrefix}_BASE_URL must use http or https.`
              : `${this.definition.configPrefix}_BASE_URL is not configured.`
          })
        }
      };
    }

    try {
      const response = await requestJson({
        url: new URL("/health", this.baseUrlRef).toString(),
        method: "GET",
        headers: this.headers(),
        timeoutMs: this.requestTimeoutMs,
        maxBytes: this.maxResponseBytes,
        tooLargeReasonCode: this.definition.healthTooLargeReasonCode,
        invalidJsonReasonCode: this.definition.healthInvalidReasonCode,
        fetchImpl: this.fetchImpl
      });
      if (!response.ok) {
        return {
          ok: false,
          details: {
            availability: this.availability({
              state: "unavailable",
              canRun: false,
              installed: true,
              auth: this.apiKey ? "configured" : "unknown",
              reasonCode: this.definition.healthUnavailableReasonCode,
              message: `health endpoint returned ${response.status}`
            })
          }
        };
      }
      return {
        ok: true,
        details: {
          availability: this.availability({
            state: "partial",
            canRun: false,
            installed: true,
            auth: this.apiKey ? "configured" : "not_required",
            reasonCode: this.definition.bridgeUnverifiedReasonCode,
            message: `${this.definition.name} health is reachable; run/status/event API fixtures are still required before execution is admitted.`
          })
        }
      };
    } catch (error) {
      return {
        ok: false,
        details: {
          availability: this.availability({
            state: "unknown",
            canRun: false,
            installed: true,
            auth: this.apiKey ? "configured" : "unknown",
            reasonCode: reasonCodeForError(error, this.definition),
            message: error instanceof Error ? error.message : String(error)
          })
        }
      };
    }
  }

  async start(): Promise<RuntimeStartResult> {
    this.log("warn", `${this.id}.start.denied`, { reasonCode: this.definition.startBlockedReasonCode });
    throw new AdapterProtocolError(`${this.definition.name} execution is not admitted until source/API fixtures are verified.`, {
      reasonCode: this.definition.startBlockedReasonCode
    });
  }

  async send(): Promise<void> {
    throw new AdapterProtocolError(`${this.definition.name} input bridge is not shipped.`, {
      reasonCode: `${this.id}_input_unsupported`
    });
  }

  async cancel(): Promise<void> {
    throw new AdapterProtocolError(`${this.definition.name} cancellation is not shipped.`, {
      reasonCode: `${this.id}_cancel_unsupported`
    });
  }

  async *events(): AsyncIterable<SwitchyardEvent> {
    return;
  }

  async tools(): Promise<string[]> {
    return [];
  }

  async artifacts(): Promise<Artifact[]> {
    return [];
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private availability(input: {
    state: "available" | "installed" | "unavailable" | "unsupported" | "partial" | "unknown";
    canRun: boolean;
    installed: boolean;
    auth: "not_required" | "configured" | "missing" | "unknown";
    reasonCode: string | null;
    message: string | null;
  }): Record<string, unknown> {
    return {
      ...input,
      version: null
    };
  }

  private log(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>): void {
    this.logger?.[level]?.(event, details);
  }
}

function parseBaseUrl(value: string | undefined): { state: "missing" | "invalid" | "configured"; url?: URL } {
  if (!value) {
    return { state: "missing" };
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { state: "invalid" };
    }
    return { state: "configured", url };
  } catch {
    return { state: "invalid" };
  }
}

function reasonCodeForError(error: unknown, definition: DeferredHttpWrapperAdapterDefinition): string {
  if (error instanceof GenericHttpResponseTooLargeError) {
    return definition.healthTooLargeReasonCode;
  }
  if (error instanceof GenericHttpInvalidJsonError) {
    return definition.healthInvalidReasonCode;
  }
  if (error instanceof GenericHttpRequestError) {
    return definition.healthUnavailableReasonCode;
  }
  return definition.healthUnavailableReasonCode;
}
