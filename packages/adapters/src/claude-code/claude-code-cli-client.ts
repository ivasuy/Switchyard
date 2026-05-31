import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AdapterProtocolError } from "@switchyard/core";
import type { ProviderResolvedCommand } from "@switchyard/contracts";
import type {
  ClaudeCodeCliClientOptions,
  ClaudeCodeClient,
  ClaudeCodeClientSession,
  ClaudeCodeProviderEvent,
  ClaudePermissionMode
} from "./types.js";

export interface ClaudeCodeCliProcess {
  readonly pid?: number | undefined;
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

export function createClaudeCodeCliClient(options: ClaudeCodeCliClientOptions = {}): ClaudeCodeClient {
  const command = options.command ?? "claude";
  const permissionMode = options.hostedProviderCommand ? "read_only" : options.permissionMode ?? "read_only";
  const disabledTools = options.hostedProviderCommand
    ? ["Bash", "WebFetch", "WebSearch"]
    : options.disabledTools ?? ["Bash", "WebFetch", "WebSearch"];
  const processFactory = options.processFactory ??
    ((cliCommand, args, processOptions) => spawn(cliCommand, args, { ...processOptions, shell: false }));
  const hostedProviderCommand = options.hostedProviderCommand;

  return {
    async start(input): Promise<ClaudeCodeClientSession> {
      if (hostedProviderCommand && !isValidHostedCommand(hostedProviderCommand, input.cwd, input.metadata)) {
        throw new AdapterProtocolError("Hosted Claude command handoff denied.", {
          reasonCode: "provider_command_denied"
        });
      }
      const args = buildClaudeCliArgs({
        task: input.task,
        permissionMode,
        disabledTools
      });
      const spawnCommand = hostedProviderCommand?.executablePath ?? command;
      const env = hostedProviderCommand ? filterHostedEnv(hostedProviderCommand) : process.env;
      let child: ClaudeCodeCliProcess;
      try {
        child = processFactory(spawnCommand, args, { cwd: input.cwd, env });
      } catch {
        if (hostedProviderCommand) {
          throw new AdapterProtocolError("Hosted Claude binary is unavailable.", {
            reasonCode: "provider_binary_unavailable"
          });
        }
        throw new Error("Claude CLI process spawn failed");
      }
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
              stderr: stderrBuffer.trim().length > 0
                ? hostedProviderCommand ? "[REDACTED]" : stderrBuffer
                : undefined
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
            reasonCode: hostedProviderCommand ? "provider_binary_unavailable" : "claude_process_spawn_failed",
            error: { message: hostedProviderCommand ? "[REDACTED]" : error instanceof Error ? error.message : String(error) }
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

function isValidHostedCommand(
  command: ProviderResolvedCommand,
  cwd: string,
  metadata: Record<string, unknown>
): boolean {
  if (command.runtimeMode !== "claude_code.sdk") {
    return false;
  }
  if (command.cwd !== cwd) {
    return false;
  }
  if (command.allowUserArgs || command.argv.length !== 0) {
    return false;
  }
  return !hasDeniedMetadataKey(metadata);
}

function filterHostedEnv(command: ProviderResolvedCommand): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of command.envKeys) {
    const value = command.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

function hasDeniedMetadataKey(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasDeniedMetadataKey(entry));
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "command" ||
      normalized === "binary" ||
      normalized === "processfactory" ||
      normalized.includes("pty") ||
      normalized.includes("terminal") ||
      normalized === "cwd" ||
      normalized === "argv" ||
      normalized === "args" ||
      normalized === "env" ||
      normalized === "shell" ||
      normalized === "approval" ||
      normalized === "input"
    ) {
      return true;
    }
    if (hasDeniedMetadataKey(entry)) {
      return true;
    }
  }
  return false;
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
