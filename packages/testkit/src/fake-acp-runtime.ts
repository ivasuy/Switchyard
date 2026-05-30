import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  parseJsonRpcLine,
  type AcpClientProcess,
  type AcpProcessFactory,
  type JsonRpcMessage,
  type JsonRpcRequestMessage
} from "@switchyard/protocol-acpx";

export type FakeAcpRuntimeScenario =
  | "happy"
  | "empty_output"
  | "prompt_failed"
  | "cancelled"
  | "cancel_unverified"
  | "invalid_json"
  | "invalid_initialize"
  | "invalid_session_new"
  | "permission_request"
  | "stderr_warning"
  | "oversized_message";

export interface FakeAcpRuntimeStats {
  prompts: number;
  cancels: number;
  permissionResponses: number;
}

export interface FakeAcpRuntimeOptions {
  scenario?: FakeAcpRuntimeScenario;
  maxMessageBytes?: number;
  stats?: FakeAcpRuntimeStats;
}

export interface AcpTestProcessHandle {
  process: AcpClientProcess;
  close(): void;
  stats: FakeAcpRuntimeStats;
}

export function startFakeAcpRuntimeProcess(options: FakeAcpRuntimeOptions = {}): AcpTestProcessHandle {
  const stats = options.stats ?? {
    prompts: 0,
    cancels: 0,
    permissionResponses: 0
  };
  const process = new FakeAcpProcess({
    scenario: options.scenario ?? "happy",
    maxMessageBytes: options.maxMessageBytes ?? 1024 * 1024,
    stats
  });
  return {
    process,
    close: () => process.kill("SIGTERM"),
    stats
  };
}

export function createFakeAcpProcessFactory(options: FakeAcpRuntimeOptions = {}): AcpProcessFactory {
  return () => startFakeAcpRuntimeProcess(options).process;
}

interface FakeAcpProcessOptions {
  scenario: FakeAcpRuntimeScenario;
  maxMessageBytes: number;
  stats: FakeAcpRuntimeStats;
}

class FakeAcpProcess extends EventEmitter implements AcpClientProcess {
  pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  private readonly scenario: FakeAcpRuntimeScenario;
  private readonly maxMessageBytes: number;
  private readonly stats: FakeAcpRuntimeStats;
  private buffer = "";
  private readonly sessionId = "ses_fake_acp_1";
  private activePromptId: string | number | undefined;
  private cancelRequested = false;
  private permissionRequestSent = false;
  private killed = false;

  constructor(options: FakeAcpProcessOptions) {
    super();
    this.scenario = options.scenario;
    this.maxMessageBytes = options.maxMessageBytes;
    this.stats = options.stats;

    this.stdin.on("data", (chunk) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (this.buffer.includes("\n")) {
        const idx = this.buffer.indexOf("\n");
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) {
          continue;
        }
        this.onClientLine(line);
      }
    });
  }

  kill(_signal?: NodeJS.Signals): boolean {
    if (this.killed) {
      return true;
    }
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0);
    return true;
  }

  private onClientLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcLine(line, { maxBytes: this.maxMessageBytes });
    } catch {
      return;
    }

    if (!("method" in message)) {
      if (message.id === "perm_1") {
        this.stats.permissionResponses += 1;
      }
      return;
    }

    if (message.method === "initialize" && isRequestWithId(message)) {
      this.handleInitialize(message);
      return;
    }
    if (message.method === "session/new" && isRequestWithId(message)) {
      this.handleSessionNew(message);
      return;
    }
    if (message.method === "session/prompt" && isRequestWithId(message)) {
      this.handlePrompt(message);
      return;
    }
    if (message.method === "session/cancel") {
      this.handleCancel();
      return;
    }
  }

  private handleInitialize(message: JsonRpcRequestMessage): void {
    if (this.scenario === "invalid_json") {
      this.writeRawStdout("{bad-json\n");
      return;
    }
    if (this.scenario === "invalid_initialize") {
      this.writeStdout({
        jsonrpc: "2.0",
        id: message.id,
        result: { agentInfo: { name: "OpenCode" } }
      });
      return;
    }

    this.writeStdout({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: true }
        },
        agentInfo: {
          name: "OpenCode",
          version: "1.3.15"
        }
      }
    });
  }

  private handleSessionNew(message: JsonRpcRequestMessage): void {
    if (this.scenario === "invalid_session_new") {
      this.writeStdout({
        jsonrpc: "2.0",
        id: message.id,
        result: { models: {} }
      });
      return;
    }
    this.writeStdout({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: this.sessionId,
        models: {
          currentModelId: "opencode/default"
        },
        modes: {
          currentModeId: "build"
        }
      }
    });
    if (this.scenario === "stderr_warning") {
      this.stderr.write("notify hook missing\n");
    }
  }

  private handlePrompt(message: JsonRpcRequestMessage): void {
    this.stats.prompts += 1;
    this.activePromptId = message.id;

    if (this.scenario === "oversized_message") {
      this.writeRawStdout(`${"x".repeat(this.maxMessageBytes + 64)}\n`);
      return;
    }

    if (this.scenario === "prompt_failed") {
      this.writeStdout({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: "prompt failed"
        }
      });
      return;
    }

    if (this.scenario === "permission_request") {
      this.permissionRequestSent = true;
      this.writeStdout({
        jsonrpc: "2.0",
        id: "perm_1",
        method: "session/request_permission",
        params: {
          sessionId: this.sessionId,
          reason: "Need edit permissions"
        }
      });
      setTimeout(() => {
        if (this.activePromptId !== undefined) {
          this.writePromptResponse(this.activePromptId, "refusal");
        }
      }, 20);
      return;
    }

    if (this.scenario === "cancelled") {
      if (this.cancelRequested) {
        this.writePromptResponse(message.id, "cancelled");
      }
      return;
    }

    if (this.scenario === "cancel_unverified") {
      this.writeSessionUpdate("agent_message_chunk", { text: "waiting for cancel" });
      return;
    }

    if (this.scenario !== "empty_output") {
      this.writeSessionUpdate("agent_message_chunk", { text: "fake acp output" });
    }
    this.writePromptResponse(message.id, "end_turn");
  }

  private handleCancel(): void {
    this.stats.cancels += 1;
    this.cancelRequested = true;
    if (this.scenario === "cancelled" && this.activePromptId !== undefined) {
      this.writePromptResponse(this.activePromptId, "cancelled");
    }
  }

  private writePromptResponse(id: string | number, stopReason: string): void {
    this.writeStdout({
      jsonrpc: "2.0",
      id,
      result: {
        stopReason
      }
    });
    this.activePromptId = undefined;
  }

  private writeSessionUpdate(updateType: string, extra: Record<string, unknown> = {}): void {
    this.writeStdout({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: this.sessionId,
        update: {
          sessionUpdate: updateType,
          ...extra
        }
      }
    });
  }

  private writeStdout(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private writeRawStdout(raw: string): void {
    this.stdout.write(raw);
  }
}

function isRequestWithId(message: JsonRpcMessage): message is JsonRpcRequestMessage {
  return "id" in message && (typeof message.id === "string" || typeof message.id === "number");
}
