import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AcpTranscriptRecorder } from "./acp-transcript.js";
import {
  AcpProtocolError,
  AcpResponseError,
  type JsonRpcErrorResponseMessage,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotificationMessage,
  type JsonRpcRequestMessage,
  type JsonRpcResponseMessage,
  parseJsonRpcLine,
  serializeJsonRpcMessage
} from "./json-rpc.js";

export type AcpProcessFactory = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => AcpClientProcess;

export interface AcpClientProcess {
  pid?: number | undefined;
  stdin: { write(data: string): unknown; end(): void };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream & {
    on(event: "data", listener: (chunk: string | Buffer) => unknown): unknown;
  };
  once(event: "exit", listener: (code: number | null) => unknown): unknown;
  once(event: "error", listener: (error: unknown) => unknown): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type AcpClientEvent =
  | { type: "notification"; message: JsonRpcNotificationMessage }
  | { type: "permission_request"; message: JsonRpcRequestMessage }
  | { type: "unsupported_request"; message: JsonRpcRequestMessage }
  | { type: "stderr"; text: string }
  | { type: "close"; code: number | null }
  | { type: "error"; error: AcpProtocolError };

export interface AcpStdioClientOptions {
  command?: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxMessageBytes?: number;
  processFactory?: AcpProcessFactory;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
}

export class AcpStdioClient {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly requestTimeoutMs: number;
  private readonly maxMessageBytes: number;
  private readonly processFactory: AcpProcessFactory;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly transcriptRecorder = new AcpTranscriptRecorder();
  private readonly eventQueue = new AsyncEventQueue<AcpClientEvent>();

  private process: AcpClientProcess | undefined;
  private started = false;
  private closed = false;
  private nextId = 0;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(options: AcpStdioClientOptions) {
    this.command = options.command ?? "opencode";
    this.args = options.args ?? ["acp"];
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
    this.processFactory = options.processFactory ?? ((args, spawnOptions) =>
      spawn(this.command, args, { ...spawnOptions, shell: false }) as unknown as AcpClientProcess);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  async request(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; id?: JsonRpcId } = {}
  ): Promise<unknown> {
    await this.start();
    const id = options.id ?? this.nextId++;
    const key = idKey(id);
    if (this.pending.has(key)) {
      throw new AcpProtocolError("acp_duplicate_request_id", "Attempted to send duplicate in-flight JSON-RPC id.", {
        id
      });
    }

    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(key);
        reject(new AcpProtocolError("acp_request_timeout", "ACP request timed out waiting for a response.", {
          method,
          id,
          timeoutMs
        }));
      }, timeoutMs);

      this.pending.set(key, { resolve, reject, timeout });
    });

    try {
      await this.writeMessage({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {})
      });
      return await response;
    } catch (error) {
      const pending = this.pending.get(key);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(key);
      }
      throw error;
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.start();
    await this.writeMessage({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {})
    });
  }

  notifications(): AsyncIterable<AcpClientEvent> {
    return this.eventQueue;
  }

  transcript(): AcpTranscriptRecorder {
    return this.transcriptRecorder;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  kill(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.process?.kill("SIGTERM");
    this.rejectPending(
      new AcpProtocolError("acp_transport_closed", "ACP transport was closed before a response was received.")
    );
  }

  private async startInternal(): Promise<void> {
    const process = this.processFactory(this.args, { cwd: this.cwd, env: this.env });
    this.process = process;

    void this.consumeStdout(process);
    process.stderr.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const byteLength = Buffer.byteLength(text, "utf8");
      if (byteLength > this.maxMessageBytes) {
        this.transcriptRecorder.appendOversized("in", byteLength);
        const error = new AcpProtocolError(
          "acp_message_too_large",
          "ACP stderr diagnostic exceeded configured byte limit.",
          { byteLength, maxBytes: this.maxMessageBytes }
        );
        this.failClient(error);
        return;
      }
      this.transcriptRecorder.appendStderr(text);
      this.eventQueue.push({ type: "stderr", text });
    });

    process.once("exit", (code) => {
      this.closed = true;
      this.rejectPending(
        new AcpProtocolError("acp_transport_closed", "ACP transport exited before all in-flight responses arrived.", {
          code
        })
      );
      this.eventQueue.push({ type: "close", code });
      this.eventQueue.close();
    });

    process.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.failClient(new AcpProtocolError("acp_transport_closed", message));
    });

    this.started = true;
  }

  private async consumeStdout(process: AcpClientProcess): Promise<void> {
    const lines = createInterface({
      input: process.stdout,
      crlfDelay: Infinity
    });
    try {
      for await (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        try {
          const message = parseJsonRpcLine(line, { maxBytes: this.maxMessageBytes });
          this.transcriptRecorder.appendMessage("in", line, message);
          await this.handleMessage(message);
        } catch (error) {
          if (error instanceof AcpProtocolError && error.reasonCode === "acp_message_too_large") {
            this.transcriptRecorder.appendOversized("in", Buffer.byteLength(line, "utf8"));
          }
          this.failClient(error instanceof AcpProtocolError
            ? error
            : new AcpProtocolError("acp_invalid_message", error instanceof Error ? error.message : String(error)));
          return;
        }
      }
    } finally {
      lines.close();
    }
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (isResponseMessage(message)) {
      const key = idKey(message.id);
      const pending = this.pending.get(key);
      if (!pending) {
        throw new AcpProtocolError("acp_unknown_response_id", "Received JSON-RPC response with unknown id.", {
          id: message.id
        });
      }
      clearTimeout(pending.timeout);
      this.pending.delete(key);
      if ("error" in message) {
        pending.reject(new AcpResponseError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (isRequestMessage(message)) {
      const method = message.method;
      const eventType = method === "session/request_permission" ? "permission_request" : "unsupported_request";
      await this.replyMethodNotFound(message.id);
      this.eventQueue.push({
        type: eventType,
        message
      });
      return;
    }

    this.eventQueue.push({
      type: "notification",
      message
    });
  }

  private async replyMethodNotFound(id: JsonRpcId): Promise<void> {
    await this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: "Method not found"
      }
    });
  }

  private async writeMessage(message: JsonRpcMessage): Promise<void> {
    if (!this.process || this.closed) {
      throw new AcpProtocolError("acp_transport_closed", "ACP transport is closed.");
    }
    const raw = serializeJsonRpcMessage(message, { maxBytes: this.maxMessageBytes });
    this.transcriptRecorder.appendMessage("out", raw, message);
    this.process.stdin.write(`${raw}\n`);
  }

  private async closeInternal(): Promise<void> {
    if (!this.process || this.closed) {
      this.closed = true;
      this.eventQueue.close();
      return;
    }
    this.closed = true;
    this.process.stdin.end();
    this.rejectPending(new AcpProtocolError("acp_transport_closed", "ACP transport was closed."));
  }

  private failClient(error: AcpProtocolError): void {
    this.closed = true;
    this.rejectPending(error);
    this.eventQueue.push({ type: "error", error });
    this.eventQueue.close();
    this.process?.kill("SIGTERM");
  }

  private rejectPending(error: AcpProtocolError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createAcpStdioClient(options: AcpStdioClientOptions): AcpStdioClient {
  return new AcpStdioClient(options);
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isRequestMessage(message: JsonRpcMessage): message is JsonRpcRequestMessage {
  return "method" in message && "id" in message;
}

function isResponseMessage(message: JsonRpcMessage): message is JsonRpcResponseMessage {
  return "id" in message && ("result" in message || "error" in message);
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  private async next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return { value: item, done: false };
    }
    if (this.closed) {
      return { value: undefined, done: true };
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next()
    };
  }
}
