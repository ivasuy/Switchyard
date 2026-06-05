import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AcpProtocolError,
  AcpStdioClient,
  parseJsonRpcLine,
  type JsonRpcMessage,
  type JsonRpcRequestMessage
} from "../src/index.js";

describe("AcpStdioClient", () => {
  it("fails fast when command is missing for built-in spawn path", () => {
    expect(() => new AcpStdioClient({
      cwd: "/repo"
    })).toThrowError(/command/i);
  });

  it("resolves requests and records transcript entries", async () => {
    const harness = createHarness((message, process) => {
      if (isRequest(message) && message.method === "initialize") {
        process.writeStdout({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: 1 }
        });
      }
    });
    await harness.client.start();
    const result = await harness.client.request("initialize", { protocolVersion: 1 });
    expect(result).toEqual({ protocolVersion: 1 });
    expect(harness.client.transcript().content()).toContain("\"method\":\"initialize\"");
  });

  it("correlates out-of-order responses with interleaved notifications and permission requests", async () => {
    const events: string[] = [];
    const harness = createHarness((message, process) => {
      if (!isRequest(message) || message.method === "session/request_permission") {
        return;
      }
      if (message.id === 1) {
        process.writeStdout({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            update: { sessionUpdate: "agent_message_chunk", text: "hello" }
          }
        });
        process.writeStdout({
          jsonrpc: "2.0",
          id: "req-1",
          method: "session/request_permission",
          params: { action: "edit" }
        });
        process.writeStdout({
          jsonrpc: "2.0",
          id: 1,
          result: { ok: "two" }
        });
        process.writeStdout({
          jsonrpc: "2.0",
          id: 0,
          result: { ok: "one" }
        });
      }
    });
    await harness.client.start();
    const observed = harness.client.notifications()[Symbol.asyncIterator]();
    const first = harness.client.request("method-1", undefined, { id: 0 });
    const second = harness.client.request("method-2", undefined, { id: 1 });
    await expect(second).resolves.toEqual({ ok: "two" });
    await expect(first).resolves.toEqual({ ok: "one" });

    while (true) {
      const event = await observed.next();
      if (event.done) {
        break;
      }
      events.push(event.value.type);
      if (events.length >= 2) {
        break;
      }
    }
    expect(events).toContain("notification");
    expect(events).toContain("permission_request");

    const outbound = harness.process.writes
      .map((line) => parseJsonRpcLine(line))
      .filter((message) => "error" in message) as Array<{ id: string | number; error: { code: number } }>;
    expect(outbound.some((entry) => entry.id === "req-1" && entry.error.code === -32601)).toBe(false);
  });

  it("holds permission requests until explicit response while unsupported requests still get method-not-found", async () => {
    const harness = createHarness((message, process) => {
      if (isRequest(message) && message.method === "initialize") {
        process.writeStdout({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
        process.writeStdout({
          jsonrpc: "2.0",
          id: "perm_1",
          method: "session/request_permission",
          params: { sessionId: "ses_1" }
        });
        process.writeStdout({
          jsonrpc: "2.0",
          id: "req_unsupported",
          method: "workspace/exec",
          params: { cmd: "ls" }
        });
      }
    });

    await harness.client.start();
    await harness.client.request("initialize");
    const events = harness.client.notifications()[Symbol.asyncIterator]();
    const first = await events.next();
    const second = await events.next();

    expect(first.value?.type).toBe("permission_request");
    expect(second.value?.type).toBe("unsupported_request");

    const outbound = harness.process.writes
      .map((line) => parseJsonRpcLine(line))
      .filter((message) => "error" in message) as Array<{ id: string | number; error: { code: number } }>;
    expect(outbound.some((entry) => entry.id === "perm_1" && entry.error.code === -32601)).toBe(false);
    expect(outbound.some((entry) => entry.id === "req_unsupported" && entry.error.code === -32601)).toBe(true);
  });

  it("responds to held permission requests exactly once", async () => {
    const harness = createHarness((message, process) => {
      if (isRequest(message) && message.method === "initialize") {
        process.writeStdout({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
        process.writeStdout({
          jsonrpc: "2.0",
          id: "perm_once",
          method: "session/request_permission",
          params: { sessionId: "ses_1" }
        });
      }
    });
    await harness.client.start();
    await harness.client.request("initialize");
    const events = harness.client.notifications()[Symbol.asyncIterator]();
    const event = await events.next();
    expect(event.value?.type).toBe("permission_request");

    await harness.client.respondToRequest("perm_once", { decision: "approved" });
    await expect(harness.client.respondToRequest("perm_once", { decision: "approved" })).rejects.toMatchObject({
      reasonCode: "acp_permission_response_failed"
    } satisfies Partial<AcpProtocolError>);

    const outbound = harness.process.writes
      .map((line) => parseJsonRpcLine(line))
      .filter((message) => "id" in message && message.id === "perm_once");
    expect(outbound).toHaveLength(1);
    expect("result" in outbound[0]).toBe(true);
  });

  it("supports rejecting held permission requests", async () => {
    const harness = createHarness((message, process) => {
      if (isRequest(message) && message.method === "initialize") {
        process.writeStdout({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
        process.writeStdout({
          jsonrpc: "2.0",
          id: "perm_reject",
          method: "session/request_permission",
          params: { sessionId: "ses_1" }
        });
      }
    });
    await harness.client.start();
    await harness.client.request("initialize");
    const events = harness.client.notifications()[Symbol.asyncIterator]();
    await events.next();

    await harness.client.rejectRequest("perm_reject", {
      code: -32010,
      message: "denied",
      data: { reason: "policy" }
    });

    const outbound = harness.process.writes
      .map((line) => parseJsonRpcLine(line))
      .filter((message) => "id" in message && message.id === "perm_reject");
    expect(outbound).toHaveLength(1);
    expect("error" in outbound[0]).toBe(true);
  });

  it("treats numeric and string held permission ids as distinct keys", async () => {
    const harness = createHarness((message, process) => {
      if (isRequest(message) && message.method === "initialize") {
        process.writeStdout({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
        process.writeStdout({
          jsonrpc: "2.0",
          id: 1,
          method: "session/request_permission",
          params: { sessionId: "ses_1" }
        });
        process.writeStdout({
          jsonrpc: "2.0",
          id: "1",
          method: "session/request_permission",
          params: { sessionId: "ses_1" }
        });
      }
    });
    await harness.client.start();
    await harness.client.request("initialize");
    const events = harness.client.notifications()[Symbol.asyncIterator]();
    await events.next();
    await events.next();

    await harness.client.respondToRequest(1, { value: "numeric" });
    await harness.client.respondToRequest("1", { value: "string" });

    const outbound = harness.process.writes
      .map((line) => parseJsonRpcLine(line))
      .filter((message) => "id" in message && (message.id === 1 || message.id === "1"));
    expect(outbound).toHaveLength(2);
    expect(outbound.some((message) => message.id === 1 && "result" in message)).toBe(true);
    expect(outbound.some((message) => message.id === "1" && "result" in message)).toBe(true);
  });

  it("fails permission responses for missing, empty, and expired ids", async () => {
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    const harness = createHarness((message, process) => {
      if (isRequest(message) && message.method === "initialize") {
        process.writeStdout({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
        process.writeStdout({
          jsonrpc: "2.0",
          id: "perm_expired",
          method: "session/request_permission",
          params: { sessionId: "ses_1", expiresAt: expiredAt }
        });
      }
    });
    await harness.client.start();
    await harness.client.request("initialize");
    const events = harness.client.notifications()[Symbol.asyncIterator]();
    await events.next();

    await expect(harness.client.respondToRequest("missing", { decision: "approved" })).rejects.toMatchObject({
      reasonCode: "acp_permission_response_failed"
    } satisfies Partial<AcpProtocolError>);
    await expect(harness.client.respondToRequest("", { decision: "approved" })).rejects.toMatchObject({
      reasonCode: "acp_permission_response_failed"
    } satisfies Partial<AcpProtocolError>);
    await expect(harness.client.respondToRequest("perm_expired", { decision: "approved" })).rejects.toMatchObject({
      reasonCode: "acp_permission_request_expired"
    } satisfies Partial<AcpProtocolError>);

    const outbound = harness.process.writes
      .map((line) => parseJsonRpcLine(line))
      .filter((message) => "id" in message && message.id === "perm_expired");
    expect(outbound).toHaveLength(0);
  });

  it("fails held permission responses after transport close", async () => {
    const harness = createHarness((message, process) => {
      if (isRequest(message) && message.method === "initialize") {
        process.writeStdout({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
        process.writeStdout({
          jsonrpc: "2.0",
          id: "perm_close",
          method: "session/request_permission",
          params: { sessionId: "ses_1" }
        });
      }
    });
    await harness.client.start();
    await harness.client.request("initialize");
    const events = harness.client.notifications()[Symbol.asyncIterator]();
    await events.next();
    harness.process.emitExit(0);

    await expect(harness.client.respondToRequest("perm_close", { decision: "approved" })).rejects.toMatchObject({
      reasonCode: "acp_transport_closed"
    } satisfies Partial<AcpProtocolError>);
  });

  it("treats numeric and string ids as distinct correlation keys", async () => {
    const harness = createHarness((message, process) => {
      if (!isRequest(message) || typeof message.id === "undefined") {
        return;
      }
      if (message.id === "1") {
        process.writeStdout({ jsonrpc: "2.0", id: "1", result: { value: "string" } });
      }
      if (message.id === 1) {
        process.writeStdout({ jsonrpc: "2.0", id: 1, result: { value: "number" } });
      }
    });
    await harness.client.start();
    const numeric = harness.client.request("id-number", undefined, { id: 1 });
    const stringy = harness.client.request("id-string", undefined, { id: "1" });

    await expect(numeric).resolves.toEqual({ value: "number" });
    await expect(stringy).resolves.toEqual({ value: "string" });
  });

  it("writes notifications without registering pending responses", async () => {
    const harness = createHarness();
    await harness.client.start();
    await harness.client.notify("session/cancel", { sessionId: "ses_1" });

    const written = parseJsonRpcLine(harness.process.writes[0] ?? "");
    expect("method" in written && written.method).toBe("session/cancel");
    expect("id" in written).toBe(false);
  });

  it("ignores blank stdout lines", async () => {
    const harness = createHarness((message, process) => {
      if (isRequest(message)) {
        process.writeRawStdout("\n");
        process.writeStdout({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
      }
    });
    await harness.client.start();
    await expect(harness.client.request("initialize")).resolves.toEqual({ ok: true });
    expect(harness.client.transcript().content()).not.toContain("\"raw\":\"\"");
  });

  it("fails pending requests on timeout, close, unknown ids, duplicate ids, and oversized stderr", async () => {
    const timeoutHarness = createHarness();
    await timeoutHarness.client.start();
    await expect(timeoutHarness.client.request("never", undefined, { timeoutMs: 10 })).rejects.toMatchObject({
      reasonCode: "acp_request_timeout"
    } satisfies Partial<AcpProtocolError>);

    const closeHarness = createHarness();
    await closeHarness.client.start();
    const closing = closeHarness.client.request("wait", undefined, { timeoutMs: 1000 });
    closeHarness.process.emitExit(0);
    await expect(closing).rejects.toMatchObject({
      reasonCode: "acp_transport_closed"
    } satisfies Partial<AcpProtocolError>);

    const unknownHarness = createHarness((message, process) => {
      if (isRequest(message)) {
        process.writeStdout({ jsonrpc: "2.0", id: 99, result: { nope: true } });
      }
    });
    await unknownHarness.client.start();
    await expect(unknownHarness.client.request("unknown", undefined, { timeoutMs: 1000 })).rejects.toMatchObject({
      reasonCode: "acp_unknown_response_id"
    } satisfies Partial<AcpProtocolError>);

    const dupHarness = createHarness((message, process) => {
      if (isRequest(message)) {
        setTimeout(() => {
          process.writeStdout({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
        }, 15);
      }
    });
    await dupHarness.client.start();
    const first = dupHarness.client.request("dup", undefined, { id: 7, timeoutMs: 200 });
    await expect(dupHarness.client.request("dup", undefined, { id: 7, timeoutMs: 200 })).rejects.toMatchObject({
      reasonCode: "acp_duplicate_request_id"
    } satisfies Partial<AcpProtocolError>);
    await expect(first).resolves.toEqual({ ok: true });

    const oversizedHarness = createHarness((message, process) => {
      if (isRequest(message)) {
        process.writeStderr("x".repeat(128));
      }
    }, { maxMessageBytes: 16 });
    await oversizedHarness.client.start();
    await expect(oversizedHarness.client.request("oversized", undefined, { timeoutMs: 1000 })).rejects.toMatchObject({
      reasonCode: "acp_message_too_large"
    } satisfies Partial<AcpProtocolError>);
  });

  it("captures non-fatal stderr warnings as events and transcript lines", async () => {
    const harness = createHarness((message, process) => {
      if (isRequest(message)) {
        process.writeStderr("warning: notify script missing");
        process.writeStdout({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
      }
    });
    await harness.client.start();
    const events = harness.client.notifications()[Symbol.asyncIterator]();
    const request = harness.client.request("initialize");
    const firstEvent = await events.next();
    await expect(request).resolves.toEqual({ ok: true });

    expect(firstEvent.value?.type).toBe("stderr");
    expect(harness.client.transcript().content()).toContain("\"type\":\"acp.stderr\"");
  });
});

interface HarnessOptions {
  maxMessageBytes?: number;
}

function createHarness(
  onWrite?: (message: JsonRpcMessage, process: FakeAcpProcess) => void,
  options: HarnessOptions = {}
): { client: AcpStdioClient; process: FakeAcpProcess } {
  const process = new FakeAcpProcess(onWrite);
  const client = new AcpStdioClient({
    cwd: "/repo",
    requestTimeoutMs: 100,
    maxMessageBytes: options.maxMessageBytes ?? 1024 * 1024,
    processFactory: () => process
  });
  return { client, process };
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequestMessage {
  return "method" in message && "id" in message;
}

class FakeAcpProcess extends EventEmitter {
  pid = 999;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly writes: string[] = [];
  private stdinBuffer = "";
  private readonly onWrite: ((message: JsonRpcMessage, process: FakeAcpProcess) => void) | undefined;

  constructor(onWrite?: (message: JsonRpcMessage, process: FakeAcpProcess) => void) {
    super();
    this.onWrite = onWrite;
    this.stdin.on("data", (chunk) => {
      this.stdinBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (this.stdinBuffer.includes("\n")) {
        const idx = this.stdinBuffer.indexOf("\n");
        const line = this.stdinBuffer.slice(0, idx);
        this.stdinBuffer = this.stdinBuffer.slice(idx + 1);
        if (line.length === 0) {
          continue;
        }
        this.writes.push(line);
        const parsed = parseJsonRpcLine(line);
        this.onWrite?.(parsed, this);
      }
    });
  }

  emitExit(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code);
  }

  writeStdout(message: JsonRpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  writeRawStdout(raw: string): void {
    this.stdout.write(raw);
  }

  writeStderr(text: string): void {
    this.stderr.write(text);
  }

  kill(): boolean {
    this.emitExit(0);
    return true;
  }
}
