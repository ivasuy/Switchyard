import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { AdapterProtocolError, type RuntimeLogger } from "@switchyard/core";

export interface LocalProcessFactory {
  spawn(
    executablePath: string,
    argv: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      shell: false;
      stdio: ["ignore", "pipe", "pipe"];
    }
  ): {
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    on(event: "error", listener: (error: Error) => void): unknown;
    on(event: "close", listener: (code: number | null) => void): unknown;
    kill(signal?: NodeJS.Signals): boolean;
  };
}

export interface LocalProcessToolExecutorOptions {
  processFactory?: LocalProcessFactory;
  logger?: RuntimeLogger;
  clock?: () => Date;
}

export interface LocalProcessExecutionInput {
  executablePath: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
}

export interface LocalProcessExecutionOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  durationMs: number;
}

const defaultFactory: LocalProcessFactory = {
  spawn(executablePath, argv, options) {
    return spawn(executablePath, argv, options);
  }
};

export class LocalProcessToolExecutor {
  private readonly processFactory: LocalProcessFactory;

  constructor(private readonly options: LocalProcessToolExecutorOptions = {}) {
    this.processFactory = options.processFactory ?? defaultFactory;
  }

  async run(input: LocalProcessExecutionInput): Promise<LocalProcessExecutionOutput> {
    if (!isAbsolute(input.cwd)) {
      throw new AdapterProtocolError("cwd must be absolute", { reasonCode: "tool_process_invalid_cwd" });
    }

    const startedAt = (this.options.clock ?? (() => new Date()))().getTime();
    const child = this.processFactory.spawn(input.executablePath, input.argv, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let completed = false;

    const append = (current: string, chunk: string): string => {
      const next = current + chunk;
      if (Buffer.byteLength(next, "utf8") <= input.maxOutputBytes) {
        return next;
      }
      truncated = true;
      return truncateUtf8(next, input.maxOutputBytes);
    };

    const timeout = setTimeout(() => {
      if (completed) {
        return;
      }
      child.kill("SIGTERM");
    }, input.timeoutMs);

    const abortHandler = () => {
      if (completed) {
        return;
      }
      child.kill("SIGTERM");
    };
    input.abortSignal?.addEventListener("abort", abortHandler, { once: true });

    try {
      const output = await new Promise<LocalProcessExecutionOutput>((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          stdout = append(stdout, chunkToString(chunk));
        });
        child.stderr.on("data", (chunk) => {
          stderr = append(stderr, chunkToString(chunk));
        });
        child.on("error", (error) => {
          completed = true;
          const reasonCode = input.abortSignal?.aborted ? "tool_process_cancelled" : "tool_process_spawn_failed";
          reject(new AdapterProtocolError(error.message, { reasonCode }));
        });
        child.on("close", (code) => {
          completed = true;
          const endedAt = (this.options.clock ?? (() => new Date()))().getTime();
          if (input.abortSignal?.aborted) {
            reject(new AdapterProtocolError("Process cancelled", { reasonCode: "tool_process_cancelled" }));
            return;
          }
          if (code === null) {
            reject(new AdapterProtocolError("Process timed out", { reasonCode: "tool_process_timeout" }));
            return;
          }
          if (code !== 0) {
            reject(new AdapterProtocolError(`Process exited with code ${code}`, {
              reasonCode: "tool_process_nonzero_exit",
              details: { exitCode: code }
            }));
            return;
          }
          if (truncated) {
            reject(new AdapterProtocolError("Process output exceeded configured limit", {
              reasonCode: "tool_output_limit_exceeded"
            }));
            return;
          }
          resolve({
            stdout,
            stderr,
            exitCode: code,
            truncated,
            durationMs: Math.max(0, endedAt - startedAt)
          });
        });
      });
      this.options.logger?.info("tool.process.completed", {
        durationMs: output.durationMs,
        outputBytes: Buffer.byteLength(output.stdout + output.stderr, "utf8")
      });
      return output;
    } finally {
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener("abort", abortHandler);
    }
  }
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString("utf8");
  }
  return String(chunk);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  return buffer.subarray(0, maxBytes).toString("utf8");
}
