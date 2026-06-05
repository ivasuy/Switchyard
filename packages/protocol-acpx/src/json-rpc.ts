export type JsonRpcId = string | number;

export interface JsonRpcRequestMessage {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponseMessage {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorObject {
  code: number | string;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponseMessage {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponseMessage = JsonRpcSuccessResponseMessage | JsonRpcErrorResponseMessage;
export type JsonRpcMessage = JsonRpcRequestMessage | JsonRpcNotificationMessage | JsonRpcResponseMessage;

export class AcpProtocolError extends Error {
  readonly reasonCode: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(reasonCode: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AcpProtocolError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export class AcpResponseError extends Error {
  readonly code: number | string;
  readonly data: unknown;

  constructor(input: { code: number | string; message: string; data?: unknown }) {
    super(sanitizeText(input.message, 512));
    this.name = "AcpResponseError";
    this.code = input.code;
    this.data = sanitizeUnknown(input.data, 2048);
  }
}

export function parseJsonRpcLine(line: string, options: { maxBytes?: number } = {}): JsonRpcMessage {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const byteLength = Buffer.byteLength(line, "utf8");
  if (byteLength > maxBytes) {
    throw new AcpProtocolError("acp_message_too_large", "JSON-RPC line exceeded configured byte limit.", {
      byteLength,
      maxBytes
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new AcpProtocolError("acp_invalid_json", "Failed to parse JSON-RPC line.", {
      parseError: error instanceof Error ? error.message : String(error)
    });
  }

  return validateJsonRpcMessage(parsed);
}

export function serializeJsonRpcMessage(
  message: JsonRpcMessage,
  options: { maxBytes?: number } = {}
): string {
  if (containsEmbeddedNewline(message)) {
    throw new AcpProtocolError("acp_invalid_message", "Outbound JSON-RPC payload must not contain embedded newlines.");
  }
  const json = JSON.stringify(message);
  if (json.includes("\n") || json.includes("\r")) {
    throw new AcpProtocolError("acp_invalid_message", "Outbound JSON-RPC payload must not contain embedded newlines.");
  }
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > maxBytes) {
    throw new AcpProtocolError("acp_message_too_large", "Outbound JSON-RPC payload exceeded configured byte limit.", {
      byteLength,
      maxBytes
    });
  }
  return json;
}

function validateJsonRpcMessage(input: unknown): JsonRpcMessage {
  if (!isRecord(input) || input["jsonrpc"] !== "2.0") {
    throw new AcpProtocolError("acp_invalid_message", "Invalid JSON-RPC envelope.");
  }

  const hasMethod = typeof input["method"] === "string";
  const hasResult = Object.prototype.hasOwnProperty.call(input, "result");
  const hasError = Object.prototype.hasOwnProperty.call(input, "error");
  const hasId = Object.prototype.hasOwnProperty.call(input, "id");

  if (hasMethod) {
    const method = String(input["method"]);
    if (method.length === 0) {
      throw new AcpProtocolError("acp_invalid_message", "JSON-RPC request method must be a non-empty string.");
    }

    if (!hasId) {
      return {
        jsonrpc: "2.0",
        method,
        ...(Object.prototype.hasOwnProperty.call(input, "params") ? { params: input["params"] } : {})
      };
    }

    const id = parseId(input["id"]);
    return {
      jsonrpc: "2.0",
      id,
      method,
      ...(Object.prototype.hasOwnProperty.call(input, "params") ? { params: input["params"] } : {})
    };
  }

  if (!hasId) {
    throw new AcpProtocolError("acp_invalid_message", "JSON-RPC response must include id.");
  }

  if (hasResult === hasError) {
    throw new AcpProtocolError("acp_invalid_message", "JSON-RPC response must include exactly one of result or error.");
  }

  const id = parseId(input["id"]);
  if (hasResult) {
    return {
      jsonrpc: "2.0",
      id,
      result: input["result"]
    };
  }

  const rawError = input["error"];
  if (!isRecord(rawError)) {
    throw new AcpProtocolError("acp_invalid_message", "JSON-RPC error response must include an error object.");
  }
  const code = rawError["code"];
  const message = rawError["message"];
  if ((typeof code !== "number" && typeof code !== "string") || typeof message !== "string") {
    throw new AcpProtocolError("acp_invalid_message", "JSON-RPC error response has invalid error fields.");
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message: sanitizeText(message, 512),
      ...(Object.prototype.hasOwnProperty.call(rawError, "data")
        ? { data: sanitizeUnknown(rawError["data"], 2048) }
        : {})
    }
  };
}

function parseId(id: unknown): JsonRpcId {
  if (typeof id === "string" || typeof id === "number") {
    return id;
  }
  throw new AcpProtocolError("acp_invalid_message", "JSON-RPC id must be a string or number.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeText(value: string, maxBytes: number): string {
  const redacted = redactSecrets(value);
  return truncateUtf8(redacted, maxBytes);
}

function sanitizeUnknown(value: unknown, maxBytes: number): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return value;
  }
  const redacted = redactSecrets(serialized);
  const bounded = truncateUtf8(redacted, maxBytes);
  try {
    return JSON.parse(bounded);
  } catch {
    return bounded;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const suffix = "...";
  const budget = Math.max(1, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let output = "";
  for (const char of value) {
    if (Buffer.byteLength(output + char, "utf8") > budget) {
      break;
    }
    output += char;
  }
  return `${output}${suffix}`;
}

function redactSecrets(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/("Authorization"\s*:\s*")[^"]*"/gi, "$1[REDACTED]\"")
    .replace(/([A-Za-z0-9_]*(?:_TOKEN|_KEY|_SECRET)"\s*:\s*")[^"]*"/gi, "$1[REDACTED]\"");
}

function containsEmbeddedNewline(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("\n") || value.includes("\r");
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsEmbeddedNewline(entry));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((entry) => containsEmbeddedNewline(entry));
}
