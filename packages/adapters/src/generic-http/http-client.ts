import type { GenericHttpRequestResult } from "./types.js";

export class GenericHttpResponseTooLargeError extends Error {
  readonly reasonCode: string;
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(reasonCode: string, bytes: number, maxBytes: number) {
    super(`${reasonCode}: response body exceeded ${maxBytes} bytes`);
    this.name = "GenericHttpResponseTooLargeError";
    this.reasonCode = reasonCode;
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export class GenericHttpInvalidJsonError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "GenericHttpInvalidJsonError";
    this.reasonCode = reasonCode;
  }
}

export class GenericHttpRequestError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = "GenericHttpRequestError";
    this.reasonCode = reasonCode;
  }
}

export interface HttpJsonRequestInput {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  maxBytes: number;
  tooLargeReasonCode: string;
  invalidJsonReasonCode: string;
  fetchImpl: typeof fetch | undefined;
}

export async function requestJson(input: HttpJsonRequestInput): Promise<GenericHttpRequestResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, input.timeoutMs);
  const started = Date.now();

  let response: Response;
  try {
    const init: RequestInit = {
      method: input.method,
      headers: input.headers,
      signal: controller.signal
    };
    if (input.body !== undefined) {
      init.body = JSON.stringify(input.body);
    }
    response = await fetchImpl(input.url, init);
  } catch (error) {
    clearTimeout(timer);
    const message = error instanceof Error ? error.message : String(error);
    throw new GenericHttpRequestError("generic_http_request_failed", message);
  }

  clearTimeout(timer);
  const bytesAndText = await readBody(response, input.maxBytes, input.tooLargeReasonCode);

  if (bytesAndText.text.length === 0) {
    return {
      status: response.status,
      ok: response.ok,
      body: {},
      bytes: bytesAndText.bytes,
      durationMs: Date.now() - started
    };
  }
  try {
    return {
      status: response.status,
      ok: response.ok,
      body: JSON.parse(bytesAndText.text) as unknown,
      bytes: bytesAndText.bytes,
      durationMs: Date.now() - started
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GenericHttpInvalidJsonError(
      input.invalidJsonReasonCode,
      `${input.invalidJsonReasonCode}: ${message}`
    );
  }
}

async function readBody(
  response: Response,
  maxBytes: number,
  tooLargeReasonCode: string
): Promise<{ text: string; bytes: number }> {
  if (!response.body) {
    return { text: "", bytes: 0 };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    const chunk = next.value;
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      throw new GenericHttpResponseTooLargeError(tooLargeReasonCode, bytes, maxBytes);
    }
    chunks.push(chunk);
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: Buffer.from(output).toString("utf8"), bytes };
}
