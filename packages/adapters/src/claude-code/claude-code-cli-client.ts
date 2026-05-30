import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ClaudeCodeClient, ClaudeCodeClientSession, ClaudeCodeProviderEvent, ClaudePermissionMode } from "./types.js";

export interface ClaudeCodeCliProcess {
  readonly pid?: number;
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export type ClaudeCodeCliProcessFactory = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => ClaudeCodeCliProcess;

export interface ClaudeCodeCliClientOptions {
  command?: string;
  processFactory?: ClaudeCodeCliProcessFactory;
  permissionMode?: ClaudePermissionMode;
  disabledTools?: string[];
}

export function createClaudeCodeCliClient(options: ClaudeCodeCliClientOptions = {}): ClaudeCodeClient {
  const command = options.command ?? "claude";
  const permissionMode = options.permissionMode ?? "read_only";
  const disabledTools = options.disabledTools ?? ["Bash", "WebFetch", "WebSearch"];
  const processFactory = options.processFactory ??
    ((cliCommand, args, processOptions) => spawn(cliCommand, args, { ...processOptions, shell: false }));

  return {
    async start(input): Promise<ClaudeCodeClientSession> {
      const args = buildClaudeCliArgs({
        task: input.task,
        permissionMode,
        disabledTools
      });
      const child = processFactory(command, args, { cwd: input.cwd, env: process.env });
      const queue = createProviderQueue();
      let terminalSeen = false;
      let stderrBuffer = "";
      let stdoutEnded = false;
      let exitCode: number | null | undefined;

      const finalizeLifecycle = () => {
        if (!stdoutEnded || exitCode === undefined) {
          return;
        }
        if (!terminalSeen && exitCode !== 0) {
          queue.push({
            type: "failed",
            reasonCode: "claude_process_exit_nonzero",
            error: {
              exitCode,
              stderr: stderrBuffer.trim().length > 0 ? stderrBuffer : undefined
            }
          });
        }
        queue.close();
      };

      void (async () => {
        const lines = createInterface({
          input: child.stdout,
          crlfDelay: Infinity
        });

        try {
          for await (const line of lines) {
            if (line.length === 0) {
              continue;
            }
            try {
              const parsed = JSON.parse(line) as ClaudeCodeProviderEvent;
              if (parsed && typeof parsed.type === "string") {
                if (parsed.type === "completed" || parsed.type === "failed" || parsed.type === "cancelled") {
                  terminalSeen = true;
                }
                queue.push(parsed);
                continue;
              }
              queue.push({
                type: "failed",
                reasonCode: "claude_stream_parse_error",
                error: { message: "Claude stream record is not an object with a type field." }
              });
              terminalSeen = true;
            } catch (error) {
              queue.push({
                type: "failed",
                reasonCode: "claude_stream_parse_error",
                error: { message: error instanceof Error ? error.message : String(error) }
              });
              terminalSeen = true;
            }
          }
        } finally {
          stdoutEnded = true;
          finalizeLifecycle();
        }
      })();

      child.stderr.on("data", (chunk) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stderrBuffer += text;
        if (Buffer.byteLength(stderrBuffer, "utf8") > 16 * 1024) {
          stderrBuffer = stderrBuffer.slice(-8 * 1024);
        }
      });

      child.once("exit", (code) => {
        exitCode = code;
        finalizeLifecycle();
      });

      child.once("error", (error) => {
        if (!terminalSeen) {
          queue.push({
            type: "failed",
            reasonCode: "claude_process_spawn_failed",
            error: { message: error instanceof Error ? error.message : String(error) }
          });
        }
        queue.close();
      });

      const session: ClaudeCodeClientSession = {
        ...(typeof child.pid === "number" ? { processId: child.pid } : {}),
        events: () => queue.iterate(),
        async sendUserMessage(text: string) {
          writeJsonLine(child.stdin, {
            type: "user",
            message: text
          });
        },
        async resolveApproval(resolution) {
          writeJsonLine(child.stdin, {
            type: "approval_resolution",
            runtimeApprovalToken: resolution.runtimeApprovalToken,
            decision: resolution.decision,
            message: resolution.message,
            ...(resolution.answers ? { answers: resolution.answers } : {})
          });
        },
        async cancel() {
          child.kill("SIGTERM");
        }
      };
      return session;
    }
  };
}

function buildClaudeCliArgs(input: {
  task: string;
  permissionMode: ClaudePermissionMode;
  disabledTools: string[];
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--permission-mode",
    input.permissionMode === "read_only" ? "plan" : "plan"
  ];
  if (input.disabledTools.length > 0) {
    args.push("--disallowedTools", input.disabledTools.join(","));
  }
  args.push(input.task);
  return args;
}

function writeJsonLine(stream: NodeJS.WritableStream, payload: Record<string, unknown>): void {
  const writable = stream as NodeJS.WritableStream & { writableEnded?: boolean };
  if (writable.writableEnded) {
    return;
  }
  stream.write(`${JSON.stringify(payload)}\n`);
}

function createProviderQueue() {
  const items: ClaudeCodeProviderEvent[] = [];
  const waiters: Array<(value: IteratorResult<ClaudeCodeProviderEvent>) => void> = [];
  let done = false;

  return {
    push(event: ClaudeCodeProviderEvent) {
      if (done) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value: event });
        return;
      }
      items.push(event);
    },
    close() {
      if (done) {
        return;
      }
      done = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ done: true, value: undefined });
      }
    },
    iterate() {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next(): Promise<IteratorResult<ClaudeCodeProviderEvent>> {
          if (items.length > 0) {
            const value = items.shift();
            return Promise.resolve({ done: false, value: value! });
          }
          if (done) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        }
      };
    }
  };
}
