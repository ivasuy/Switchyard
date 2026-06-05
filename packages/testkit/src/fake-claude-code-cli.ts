import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

type ClaudeCodeCliProcessFactory = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => {
  readonly pid?: number;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
};

export interface FakeClaudeCodeCliScenario {
  initialEvents?: Array<Record<string, unknown>>;
  waitForInputText?: boolean;
  approvalToken?: string;
}

export interface FakeClaudeCodeCliState {
  command: string;
  args: string[];
  cwd: string;
  stdinMessages: Array<Record<string, unknown>>;
}

export function createFakeClaudeCodeCliProcessFactory(
  scenario: FakeClaudeCodeCliScenario = {}
): {
  processFactory: ClaudeCodeCliProcessFactory;
  state: FakeClaudeCodeCliState;
} {
  const state: FakeClaudeCodeCliState = {
    command: "",
    args: [],
    cwd: "",
    stdinMessages: []
  };

  const processFactory: ClaudeCodeCliProcessFactory = (command, args, options) => {
    state.command = command;
    state.args = args;
    state.cwd = options.cwd;

    const process = new FakeClaudeCliProcess();
    let terminal = false;
    const approvalToken = scenario.approvalToken;

    const closeWithCompleted = () => {
      if (terminal) {
        return;
      }
      process.stdout.write(`${JSON.stringify({ type: "completed", usage: { inputTokens: 1, outputTokens: 2 } })}\n`);
      process.stdout.end();
      process.stderr.end();
      process.emit("exit", 0, null);
      terminal = true;
    };

    queueMicrotask(() => {
      process.stdout.write(`${JSON.stringify({ type: "session", sessionId: "claude-session-1" })}\n`);
      for (const event of scenario.initialEvents ?? []) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }

      if (approvalToken) {
        process.stdout.write(`${JSON.stringify({
          type: "approval_required",
          token: approvalToken,
          approvalType: "before_destructive_command",
          toolName: "Bash",
          toolInput: { command: "rm tmp.txt" }
        })}\n`);
        return;
      }

      if (scenario.waitForInputText) {
        return;
      }

      closeWithCompleted();
    });

    void (async () => {
      const lines = createInterface({
        input: process.stdin,
        crlfDelay: Infinity
      });
      for await (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          state.stdinMessages.push(parsed);
          if (parsed["type"] === "user" && typeof parsed["message"] === "string" && scenario.waitForInputText) {
            process.stdout.write(`${JSON.stringify({ type: "assistant_text_delta", text: `echo:${parsed["message"]}` })}\n`);
            closeWithCompleted();
            continue;
          }
          if (parsed["type"] === "approval_resolution" && parsed["runtimeApprovalToken"] === approvalToken) {
            if (parsed["decision"] === "rejected") {
              process.stdout.write(`${JSON.stringify({ type: "failed", reasonCode: "provider_denied" })}\n`);
              process.stdout.end();
              process.stderr.end();
              process.emit("exit", 1, null);
              terminal = true;
              continue;
            }
            closeWithCompleted();
          }
        } catch {
          process.stdout.write(`${JSON.stringify({ type: "failed", reasonCode: "fake_cli_parse_error" })}\n`);
          process.stdout.end();
          process.stderr.end();
          process.emit("exit", 1, null);
          terminal = true;
        }
      }
    })();

    return process;
  };

  return { processFactory, state };
}

class FakeClaudeCliProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 5678;

  kill(_signal: NodeJS.Signals): boolean {
    this.stdout.write(`${JSON.stringify({ type: "cancelled" })}\n`);
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", null);
    return true;
  }
}
