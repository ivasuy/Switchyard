import { describe, expect, it } from "vitest";
import {
  AcpProtocolError,
  AcpResponseError,
  AcpTranscriptRecorder,
  acpInitializeResultSchema,
  acpPermissionRequestSchema,
  acpSessionCancelParamsSchema,
  acpSessionNewResultSchema,
  acpSessionPromptResultSchema,
  acpSessionUpdateNotificationSchema,
  parseJsonRpcLine,
  serializeJsonRpcMessage
} from "../src/index.js";

describe("protocol ACPX framing and transcript helpers", () => {
  it("parses valid request, notification, success response, and error response", () => {
    const request = parseJsonRpcLine(
      "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1}}"
    );
    const notification = parseJsonRpcLine(
      "{\"jsonrpc\":\"2.0\",\"method\":\"session/cancel\",\"params\":{\"sessionId\":\"ses_1\"}}"
    );
    const success = parseJsonRpcLine(
      "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}"
    );
    const failure = parseJsonRpcLine(
      "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32601,\"message\":\"method missing\"}}"
    );

    expect("method" in request && request.method).toBe("initialize");
    expect("method" in notification && notification.method).toBe("session/cancel");
    expect("result" in success).toBe(true);
    expect("error" in failure).toBe(true);
  });

  it("rejects malformed JSON and invalid envelopes", () => {
    expect(() => parseJsonRpcLine("{bad json")).toThrowError(AcpProtocolError);
    expect(() =>
      parseJsonRpcLine("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{},\"error\":{\"code\":1,\"message\":\"bad\"}}")
    ).toThrowError(AcpProtocolError);
    expect(() => parseJsonRpcLine("{\"jsonrpc\":\"2.0\",\"result\":{}}")).toThrowError(AcpProtocolError);
  });

  it("rejects oversize lines and embedded newline outbound payloads", () => {
    expect(() => parseJsonRpcLine("x".repeat(16), { maxBytes: 8 })).toThrowError(AcpProtocolError);
    expect(() =>
      serializeJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize\nbad"
      })
    ).toThrowError(AcpProtocolError);
  });

  it("supports ACP initialize/session/prompt/cancel/update/permission schemas", () => {
    const initialize = acpInitializeResultSchema.parse({
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true }
      },
      agentInfo: { name: "OpenCode", version: "1.3.15" },
      authMethods: [{ id: "opencode-login", name: "Login with opencode" }]
    });
    const sessionNew = acpSessionNewResultSchema.parse({
      sessionId: "ses_1",
      models: {
        currentModelId: "opencode/default"
      }
    });
    const prompt = acpSessionPromptResultSchema.parse({
      stopReason: "end_turn"
    });
    const cancel = acpSessionCancelParamsSchema.parse({
      sessionId: "ses_1"
    });
    const update = acpSessionUpdateNotificationSchema.parse({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses_1",
        update: {
          sessionUpdate: "agent_message_chunk",
          text: "hello"
        }
      }
    });
    const permission = acpPermissionRequestSchema.parse({
      jsonrpc: "2.0",
      id: "req_1",
      method: "session/request_permission",
      params: {
        sessionId: "ses_1",
        expiresAt: "2026-06-01T12:00:00.000Z",
        tool: "bash"
      }
    });

    expect(initialize.protocolVersion).toBe(1);
    expect(sessionNew.sessionId).toBe("ses_1");
    expect(prompt.stopReason).toBe("end_turn");
    expect(cancel.sessionId).toBe("ses_1");
    expect(update.params.update.sessionUpdate).toBe("agent_message_chunk");
    expect(permission.method).toBe("session/request_permission");
    expect(permission.params?.sessionId).toBe("ses_1");
  });

  it("rejects empty ids, empty session ids, and oversized permission params", () => {
    expect(() => acpPermissionRequestSchema.parse({
      jsonrpc: "2.0",
      id: "",
      method: "session/request_permission",
      params: { tool: "bash" }
    })).toThrowError();

    expect(() => acpPermissionRequestSchema.parse({
      jsonrpc: "2.0",
      id: "req_1",
      method: "session/request_permission",
      params: { sessionId: "", tool: "bash" }
    })).toThrowError();

    expect(() => acpPermissionRequestSchema.parse({
      jsonrpc: "2.0",
      id: "req_1",
      method: "session/request_permission",
      params: { payload: "x".repeat(70_000) }
    })).toThrowError();
  });

  it("redacts transcript content and never stores pre-redaction secrets", () => {
    const recorder = new AcpTranscriptRecorder();
    const rawLine =
      "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"Authorization\":\"Bearer abc123\",\"API_TOKEN\":\"token123\",\"safe\":\"ok\"}}";
    recorder.appendMessage("out", rawLine);
    recorder.appendStderr("authorization=foo Bearer xyz");
    recorder.appendMessage(
      "in",
      "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"command\":\"/usr/local/bin/opencode-key-segment/acp\"}}"
    );
    recorder.appendOversized("in", 2048);

    const content = recorder.content();
    expect(content).toContain("Bearer [REDACTED]");
    expect(content).toContain("API_TOKEN");
    expect(content).toContain("[REDACTED]");
    expect(content).toContain("[REDACTED_SEGMENT]");
    expect(content).toContain("\"reasonCode\":\"acp_message_too_large\"");
    expect(content).not.toContain("abc123");
    expect(content).not.toContain("token123");
    expect(content).not.toContain("authorization=foo");
    expect(content).not.toContain("Bearer xyz");
  });

  it("creates bounded/sanitized response errors", () => {
    const error = new AcpResponseError({
      code: -32601,
      message: "Authorization: Bearer secret",
      data: {
        API_TOKEN: "secret-value"
      }
    });
    expect(error.code).toBe(-32601);
    expect(error.message).toContain("[REDACTED]");
    expect(JSON.stringify(error.data)).not.toContain("secret-value");
  });
});
