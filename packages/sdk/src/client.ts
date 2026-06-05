import {
  artifactSchema,
  doctorSummaryResponseSchema,
  eventSchema,
  httpErrorEnvelopeSchema,
  listModelsResponseSchema,
  listProvidersResponseSchema,
  listRuntimeModesResponseSchema,
  listRuntimesResponseSchema,
  listRunsResponseSchema,
  runSchema,
  runtimeDoctorCheckSchema,
  runtimeModeSchema,
  modelSchema,
  providerSchema,
  runtimeSchema,
  type SwitchyardEvent
} from "@switchyard/contracts";
import { z } from "zod";
import {
  SwitchyardDecodeError,
  SwitchyardHttpError,
  SwitchyardNetworkError,
  SwitchyardStreamError,
  SwitchyardTimeoutError,
  SwitchyardValidationError
} from "./errors.js";

export interface SwitchyardClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface EventQueryOptions {
  live?: boolean;
  stopAfter?: number;
  lastEventId?: string;
}

export class SwitchyardClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: SwitchyardClientOptions) {
    if (!options.baseUrl || options.baseUrl.trim().length === 0) {
      throw new SwitchyardValidationError("baseUrl is required");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async health(): Promise<{ ok: boolean }> {
    return this.requestJson("GET", "/health", z.object({ ok: z.boolean() }));
  }

  async doctor(): Promise<z.infer<typeof doctorSummaryResponseSchema>> {
    return this.requestJson("GET", "/doctor", doctorSummaryResponseSchema);
  }

  async createRun(payload: Record<string, unknown>, options: { wait?: boolean } = {}): Promise<{ run: z.infer<typeof runSchema>; response?: unknown }> {
    return this.requestJson(
      "POST",
      "/runs",
      z.object({ run: runSchema, response: z.unknown().optional() }),
      options.wait
        ? { body: payload, query: { wait: "1" } }
        : { body: payload }
    );
  }

  async getRun(runId: string): Promise<{ run: z.infer<typeof runSchema>; events: SwitchyardEvent[] }> {
    this.assertNonEmpty("runId", runId);
    return this.requestJson(
      "GET",
      `/runs/${encodeURIComponent(runId)}`,
      z.object({ run: runSchema, events: z.array(eventSchema) })
    );
  }

  async listRuns(query?: Record<string, string | number | boolean | undefined>): Promise<z.infer<typeof listRunsResponseSchema>> {
    return this.requestJson(
      "GET",
      "/runs",
      listRunsResponseSchema,
      query ? { query } : {}
    );
  }

  async listRunArtifacts(runId: string): Promise<{ artifacts: Array<z.infer<typeof artifactSchema>> }> {
    this.assertNonEmpty("runId", runId);
    return this.requestJson(
      "GET",
      `/runs/${encodeURIComponent(runId)}/artifacts`,
      z.object({ artifacts: z.array(artifactSchema) })
    );
  }

  async replayRunEvents(runId: string, options: EventQueryOptions = {}): Promise<SwitchyardEvent[]> {
    this.assertNonEmpty("runId", runId);
    const query = this.eventQuery(options);
    const response = await this.requestRaw("GET", `/runs/${encodeURIComponent(runId)}/events`, { query });
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const body = await response.text();
    return this.parseSsePayload(body, requestId);
  }

  async listRunEvents(runId: string, options: EventQueryOptions = {}): Promise<SwitchyardEvent[]> {
    return this.replayRunEvents(runId, options);
  }

  async *streamRunEvents(runId: string, options: EventQueryOptions = {}): AsyncGenerator<SwitchyardEvent> {
    this.assertNonEmpty("runId", runId);
    const query = this.eventQuery({ ...options, live: true });
    const response = await this.requestRaw("GET", `/runs/${encodeURIComponent(runId)}/events`, { query });
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw new SwitchyardStreamError(`Expected text/event-stream, got ${contentType || "unknown"}`, { requestId });
    }
    const stream = response.body;
    if (!stream) {
      throw new SwitchyardStreamError("SSE response body is missing", { requestId });
    }
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = this.parseSseFrame(frame, requestId);
        if (event) {
          yield event;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    const tail = buffer.trim();
    if (tail.length > 0) {
      throw new SwitchyardStreamError("Malformed SSE stream: trailing frame without terminator", { requestId });
    }
  }

  async sendRunInput(runId: string, payload: Record<string, unknown>): Promise<{ accepted: boolean }> {
    this.assertNonEmpty("runId", runId);
    return this.requestJson(
      "POST",
      `/runs/${encodeURIComponent(runId)}/input`,
      z.object({ accepted: z.boolean() }),
      { body: payload }
    );
  }

  async cancelRun(runId: string): Promise<{ run: z.infer<typeof runSchema> }> {
    this.assertNonEmpty("runId", runId);
    return this.requestJson(
      "POST",
      `/runs/${encodeURIComponent(runId)}/cancel`,
      z.object({ run: runSchema })
    );
  }

  async getArtifact(artifactId: string): Promise<z.infer<typeof artifactSchema>> {
    this.assertNonEmpty("artifactId", artifactId);
    const payload = await this.requestJson(
      "GET",
      `/artifacts/${encodeURIComponent(artifactId)}`,
      z.object({ artifact: artifactSchema })
    );
    return payload.artifact;
  }

  async getArtifactContent(artifactId: string): Promise<{
    body: Uint8Array;
    contentType: string;
    text(): string;
  }> {
    this.assertNonEmpty("artifactId", artifactId);
    const response = await this.requestRaw("GET", `/artifacts/${encodeURIComponent(artifactId)}/content`);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      body,
      contentType,
      text() {
        return new TextDecoder().decode(body);
      }
    };
  }

  async listProviders(): Promise<z.infer<typeof listProvidersResponseSchema>> {
    return this.requestJson("GET", "/providers", listProvidersResponseSchema);
  }

  async getProvider(id: string): Promise<z.infer<typeof providerSchema>> {
    this.assertNonEmpty("providerId", id);
    return (await this.requestJson("GET", `/providers/${encodeURIComponent(id)}`, z.object({ provider: providerSchema }))).provider;
  }

  async listRuntimes(): Promise<z.infer<typeof listRuntimesResponseSchema>> {
    return this.requestJson("GET", "/runtimes", listRuntimesResponseSchema);
  }

  async getRuntime(id: string): Promise<z.infer<typeof runtimeSchema>> {
    this.assertNonEmpty("runtimeId", id);
    return (await this.requestJson("GET", `/runtimes/${encodeURIComponent(id)}`, z.object({ runtime: runtimeSchema }))).runtime;
  }

  async listModels(): Promise<z.infer<typeof listModelsResponseSchema>> {
    return this.requestJson("GET", "/models", listModelsResponseSchema);
  }

  async getModel(id: string): Promise<z.infer<typeof modelSchema>> {
    this.assertNonEmpty("modelId", id);
    return (await this.requestJson("GET", `/models/${encodeURIComponent(id)}`, z.object({ model: modelSchema }))).model;
  }

  async listRuntimeModes(): Promise<z.infer<typeof listRuntimeModesResponseSchema>> {
    return this.requestJson("GET", "/runtime-modes", listRuntimeModesResponseSchema);
  }

  async getRuntimeMode(id: string): Promise<z.infer<typeof runtimeModeSchema>> {
    this.assertNonEmpty("runtimeModeId", id);
    return (
      await this.requestJson("GET", `/runtime-modes/${encodeURIComponent(id)}`, z.object({ runtimeMode: runtimeModeSchema }))
    ).runtimeMode;
  }

  async checkRuntimeMode(id: string): Promise<z.infer<typeof runtimeDoctorCheckSchema>> {
    this.assertNonEmpty("runtimeModeId", id);
    return (
      await this.requestJson(
        "POST",
        `/runtime-modes/${encodeURIComponent(id)}/check`,
        z.object({ check: runtimeDoctorCheckSchema })
      )
    ).check;
  }

  private async requestJson<TSchema extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: TSchema,
    options: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    } = {}
  ): Promise<z.infer<TSchema>> {
    const response = await this.requestRaw(method, path, options);
    const requestId = response.headers.get("x-request-id") ?? undefined;
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new SwitchyardDecodeError(`Invalid JSON response for ${method} ${path}`, {
        status: response.status,
        requestId,
        cause: error
      });
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new SwitchyardDecodeError(`Unexpected response schema for ${method} ${path}`, {
        status: response.status,
        requestId,
        cause: parsed.error
      });
    }
    return parsed.data;
  }

  private async requestRaw(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
    } = {}
  ): Promise<Response> {
    const url = buildUrl(this.baseUrl, path, options.query);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          ...this.headers,
          ...(options.body !== undefined ? { "content-type": "application/json" } : {})
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal
      });
      if (!response.ok) {
        await this.throwHttpError(response, method, path);
      }
      return response;
    } catch (error) {
      if (error instanceof SwitchyardHttpError || error instanceof SwitchyardDecodeError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new SwitchyardTimeoutError(`Request timed out after ${this.timeoutMs}ms: ${method} ${url}`);
      }
      throw new SwitchyardNetworkError(`Network request failed: ${method} ${url}`, error);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async throwHttpError(response: Response, method: string, path: string): Promise<never> {
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) : {};
    } catch (error) {
      throw new SwitchyardDecodeError(`Invalid error JSON for ${method} ${path}`, {
        status: response.status,
        requestId,
        cause: error
      });
    }

    const parsed = httpErrorEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new SwitchyardDecodeError(`Unexpected error schema for ${method} ${path}`, {
        status: response.status,
        requestId,
        cause: parsed.error
      });
    }

    throw new SwitchyardHttpError({
      status: response.status,
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      details: parsed.data.error.details,
      requestId: parsed.data.error.requestId ?? requestId
    });
  }

  private parseSsePayload(raw: string, requestId?: string): SwitchyardEvent[] {
    const events: SwitchyardEvent[] = [];
    for (const frame of raw.split(/\n\n+/)) {
      const event = this.parseSseFrame(frame, requestId);
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  private parseSseFrame(frame: string, requestId?: string): SwitchyardEvent | undefined {
    const trimmed = frame.trim();
    if (trimmed.length === 0 || trimmed.startsWith(":")) {
      return undefined;
    }

    let dataLine: string | undefined;
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("data: ")) {
        dataLine = line.slice(6);
      }
    }

    if (!dataLine) {
      throw new SwitchyardStreamError("Malformed SSE frame: missing data line", { requestId });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(dataLine);
    } catch (error) {
      throw new SwitchyardStreamError("Malformed SSE frame: invalid JSON payload", {
        requestId,
        cause: error
      });
    }

    const parsedEvent = eventSchema.safeParse(parsedJson);
    if (!parsedEvent.success) {
      throw new SwitchyardStreamError("Malformed SSE frame: invalid event schema", {
        requestId,
        cause: parsedEvent.error
      });
    }
    return parsedEvent.data;
  }

  private eventQuery(options: EventQueryOptions): Record<string, string> {
    const query: Record<string, string> = {};
    if (options.live) {
      query.live = "1";
    }
    if (options.stopAfter !== undefined) {
      query.stopAfter = String(options.stopAfter);
    }
    if (options.lastEventId) {
      query.lastEventId = options.lastEventId;
    }
    return query;
  }

  private assertNonEmpty(name: string, value: string): void {
    if (!value || value.trim().length === 0) {
      throw new SwitchyardValidationError(`${name} is required`);
    }
  }
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(path, `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { name?: string }).name === "AbortError";
}
