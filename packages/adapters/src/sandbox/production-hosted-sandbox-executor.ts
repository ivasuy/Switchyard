import { spawn } from "node:child_process";
import type { SandboxJobRequest, SandboxNamedError, SandboxResourceLimits, SandboxResolvedCommand } from "@switchyard/contracts";
import type { HostedSandboxExecutorOutput, HostedSandboxExecutorPort, RuntimeLogger } from "@switchyard/core";

export interface SandboxWritableLike {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end(): void;
  once?(event: "error", listener: (error: Error) => void): unknown;
  off?(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: "error", listener: (error: Error) => void): unknown;
}

export interface SandboxReadableLike {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface SandboxSpawnedProcess {
  stdout: SandboxReadableLike;
  stderr: SandboxReadableLike;
  stdin: SandboxWritableLike;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SandboxProcessFactory {
  spawn(
    executablePath: string,
    argv: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      shell: false;
      stdio: ["pipe", "pipe", "pipe"];
    }
  ): SandboxSpawnedProcess;
}

export interface SandboxPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "data", listener: (data: string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: number | null) => void): unknown;
}

export interface SandboxPtyFactory {
  spawn(
    executablePath: string,
    argv: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
    }
  ): SandboxPty;
}

export interface ProductionHostedSandboxExecutorOptions {
  processFactory?: SandboxProcessFactory;
  ptyFactory?: SandboxPtyFactory;
  logger?: RuntimeLogger;
}

type ExecuteRequest = SandboxJobRequest & { resourceLimits: SandboxResourceLimits };
type DriverCompletion = { type: "close"; code: number | null } | { type: "error" };
type AbortCompletion = { type: "aborted" } | { type: "abort_cleanup_failed" };

const SANDBOX_ABORT_CLEANUP_GRACE_MS = 25;

const defaultProcessFactory: SandboxProcessFactory = {
  spawn(executablePath, argv, options) {
    return spawn(executablePath, argv, options);
  }
};

export class ProductionHostedSandboxExecutor implements HostedSandboxExecutorPort {
  private readonly processFactory: SandboxProcessFactory;
  private readonly ptyFactory: SandboxPtyFactory | undefined;

  constructor(private readonly options: ProductionHostedSandboxExecutorOptions = {}) {
    this.processFactory = options.processFactory ?? defaultProcessFactory;
    this.ptyFactory = options.ptyFactory;
  }

  async execute(
    request: ExecuteRequest,
    options?: { signal?: AbortSignal; resolvedCommand?: SandboxResolvedCommand }
  ): Promise<HostedSandboxExecutorOutput> {
    const resolvedCommand = options?.resolvedCommand;
    if (!resolvedCommand) {
      return failed("sandbox_policy_missing");
    }

    if (resolvedCommand.adapterType !== request.adapterType) {
      return failed("sandbox_policy_failed");
    }

    if (resolvedCommand.adapterType === "pty") {
      return this.executePty(request, resolvedCommand, options?.signal);
    }
    return this.executeProcess(request, resolvedCommand, options?.signal);
  }

  private async executeProcess(
    request: ExecuteRequest,
    resolvedCommand: SandboxResolvedCommand,
    signal?: AbortSignal
  ): Promise<HostedSandboxExecutorOutput> {
    let child: SandboxSpawnedProcess;
    try {
      child = this.processFactory.spawn(
        resolvedCommand.executablePath,
        [...resolvedCommand.argv],
        {
          cwd: resolvedCommand.cwd,
          env: { ...resolvedCommand.env },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
    } catch (error) {
      this.options.logger?.warn("sandbox.process.spawn_failed", { error: sanitizeError(error) });
      return failed("sandbox_spawn_failed");
    }

    const output = createOutputCollector(request.resourceLimits);
    child.stdout.on("data", (chunk) => output.appendStdout(chunkToString(chunk)));
    child.stderr.on("data", (chunk) => output.appendStderr(chunkToString(chunk)));

    let streamFailure = false;
    child.stdout.on("error", () => {
      streamFailure = true;
      safeKillChild(child);
    });
    child.stderr.on("error", () => {
      streamFailure = true;
      safeKillChild(child);
    });

    const completion = new Promise<DriverCompletion>((resolve) => {
      let settled = false;
      const settle = (value: DriverCompletion) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      child.once("error", () => settle({ type: "error" }));
      child.once("close", (code) => settle({ type: "close", code }));
    });

    const abortCompletion = createAbortCompletion(signal, () => safeKillChild(child));

    if (request.stdin && request.stdin.length > 0) {
      if (!resolvedCommand.allowStdin) {
        safeKillChild(child);
        abortCompletion.cleanup();
        return failed("sandbox_command_denied", { stdout: output.stdout(), stderr: output.stderr() });
      }

      try {
        await writeToChildStdin(child, request.stdin);
      } catch {
        safeKillChild(child);
        abortCompletion.cleanup();
        return failed("sandbox_process_failed", { stdout: output.stdout(), stderr: output.stderr() });
      }
    }

    child.stdin.end();

    const terminal = await Promise.race([completion, abortCompletion.promise]);
    abortCompletion.cleanup();

    if (terminal.type === "abort_cleanup_failed") {
      return failed("sandbox_cancel_failed", { stdout: output.stdout(), stderr: output.stderr() });
    }

    if (terminal.type === "aborted" || signal?.aborted) {
      return {
        status: "cancelled",
        reasonCode: "sandbox_cancelled",
        stdout: output.stdout(),
        stderr: output.stderr()
      };
    }

    if (streamFailure) {
      return failed("sandbox_process_failed", { stdout: output.stdout(), stderr: output.stderr() });
    }

    if (terminal.type === "error") {
      return failed("sandbox_spawn_failed", { stdout: output.stdout(), stderr: output.stderr() });
    }

    if (terminal.code !== 0) {
      if (typeof terminal.code === "number") {
        return failed("sandbox_process_failed", {
          exitCode: terminal.code,
          stdout: output.stdout(),
          stderr: output.stderr()
        });
      }
      return failed("sandbox_process_failed", {
        stdout: output.stdout(),
        stderr: output.stderr()
      });
    }

    return {
      status: "completed",
      stdout: output.stdout(),
      stderr: output.stderr()
    };
  }

  private async executePty(
    request: ExecuteRequest,
    resolvedCommand: SandboxResolvedCommand,
    signal?: AbortSignal
  ): Promise<HostedSandboxExecutorOutput> {
    if (!request.pty) {
      return failed("sandbox_pty_invalid");
    }

    if (!this.ptyFactory) {
      return failed("sandbox_pty_unavailable");
    }

    let pty: SandboxPty;
    try {
      pty = this.ptyFactory.spawn(
        resolvedCommand.executablePath,
        [...resolvedCommand.argv],
        {
          cwd: resolvedCommand.cwd,
          env: { ...resolvedCommand.env },
          cols: request.pty.cols,
          rows: request.pty.rows
        }
      );
    } catch (error) {
      this.options.logger?.warn("sandbox.pty.spawn_failed", { error: sanitizeError(error) });
      return failed("sandbox_spawn_failed");
    }

    const output = createOutputCollector(request.resourceLimits);
    const completion = new Promise<DriverCompletion>((resolve) => {
      let settled = false;
      const settle = (value: DriverCompletion) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };

      pty.on("data", (data) => {
        output.appendStdout(data);
      });
      pty.on("error", () => settle({ type: "error" }));
      pty.on("close", (code) => settle({ type: "close", code }));
    });

    const abortCompletion = createAbortCompletion(signal, () => safeKillPty(pty));

    for (const frame of request.pty.inputFrames) {
      if (frame.type === "input") {
        if (frame.data.length > 0 && !resolvedCommand.allowPtyInput) {
          safeKillPty(pty);
          abortCompletion.cleanup();
          return failed("sandbox_command_denied", { stdout: output.stdout() });
        }
        try {
          pty.write(frame.data);
        } catch {
          safeKillPty(pty);
          abortCompletion.cleanup();
          return failed("sandbox_process_failed", { stdout: output.stdout() });
        }
      } else {
        try {
          pty.resize(frame.cols, frame.rows);
        } catch {
          safeKillPty(pty);
          abortCompletion.cleanup();
          return failed("sandbox_process_failed", { stdout: output.stdout() });
        }
      }
    }

    const terminal = await Promise.race([completion, abortCompletion.promise]);
    abortCompletion.cleanup();

    if (terminal.type === "abort_cleanup_failed") {
      return failed("sandbox_cancel_failed", { stdout: output.stdout() });
    }

    if (terminal.type === "aborted" || signal?.aborted) {
      return {
        status: "cancelled",
        reasonCode: "sandbox_cancelled",
        stdout: output.stdout(),
        stderr: ""
      };
    }

    if (terminal.type === "error") {
      return failed("sandbox_process_failed", { stdout: output.stdout() });
    }

    if (terminal.code !== 0) {
      if (typeof terminal.code === "number") {
        return failed("sandbox_process_failed", {
          exitCode: terminal.code,
          stdout: output.stdout()
        });
      }
      return failed("sandbox_process_failed", {
        stdout: output.stdout()
      });
    }

    return {
      status: "completed",
      stdout: output.stdout(),
      stderr: ""
    };
  }
}

function createOutputCollector(limits: SandboxResourceLimits): {
  appendStdout: (value: string) => void;
  appendStderr: (value: string) => void;
  stdout: () => string;
  stderr: () => string;
} {
  let stdout = "";
  let stderr = "";

  const append = (current: string, nextChunk: string, streamLimit: number): string => {
    const availableStream = streamLimit - Buffer.byteLength(current, "utf8");
    if (availableStream <= 0) {
      return current;
    }

    const combinedBytes = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
    const availableCombined = limits.combinedOutputBytes - combinedBytes;
    if (availableCombined <= 0) {
      return current;
    }

    const allowed = Math.min(availableStream, availableCombined);
    if (allowed <= 0) {
      return current;
    }

    const clipped = truncateUtf8(nextChunk, allowed);
    return current + clipped;
  };

  return {
    appendStdout(value) {
      stdout = append(stdout, value, limits.stdoutBytes);
    },
    appendStderr(value) {
      stderr = append(stderr, value, limits.stderrBytes);
    },
    stdout() {
      return stdout;
    },
    stderr() {
      return stderr;
    }
  };
}

async function writeToChildStdin(child: SandboxSpawnedProcess, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const onError = (error: Error) => settle(() => reject(error));
    child.stdin.once?.("error", onError);

    try {
      child.stdin.write(text, (error) => {
        if (error) {
          settle(() => reject(error));
          return;
        }
        settle(() => resolve());
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      settle(() => reject(failure));
    }
  });
}

function createAbortCompletion(
  signal: AbortSignal | undefined,
  kill: () => boolean
): { promise: Promise<AbortCompletion>; cleanup: () => void } {
  if (!signal) {
    return {
      promise: new Promise<AbortCompletion>(() => undefined),
      cleanup: () => undefined
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: (() => void) | undefined;
  let resolveAbort: ((value: AbortCompletion) => void) | undefined;
  let settled = false;

  const promise = new Promise<AbortCompletion>((resolve) => {
    resolveAbort = resolve;
  });

  const settle = (value: AbortCompletion) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    resolveAbort?.(value);
  };

  const onAbort = () => {
    if (!kill()) {
      settle({ type: "abort_cleanup_failed" });
      return;
    }
    timer = setTimeout(() => settle({ type: "aborted" }), SANDBOX_ABORT_CLEANUP_GRACE_MS);
  };

  if (signal.aborted) {
    onAbort();
  } else {
    listener = onAbort;
    signal.addEventListener("abort", listener, { once: true });
  }

  return {
    promise,
    cleanup() {
      if (listener) {
        signal.removeEventListener("abort", listener);
      }
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
  };
}

function safeKillChild(child: SandboxSpawnedProcess): boolean {
  try {
    return child.kill("SIGTERM");
  } catch {
    return false;
  }
}

function safeKillPty(pty: SandboxPty): boolean {
  try {
    return pty.kill("SIGTERM");
  } catch {
    return false;
  }
}

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.name : "unknown_error";
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
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  const codePoints: string[] = [];
  let usedBytes = 0;
  for (const codePoint of value) {
    const pointBytes = Buffer.byteLength(codePoint, "utf8");
    if (usedBytes + pointBytes > maxBytes) {
      break;
    }
    usedBytes += pointBytes;
    codePoints.push(codePoint);
  }
  return codePoints.join("");
}

function failed(
  reasonCode: SandboxNamedError,
  extras?: Omit<HostedSandboxExecutorOutput, "status" | "reasonCode">
): HostedSandboxExecutorOutput {
  return {
    status: "failed",
    reasonCode,
    ...extras
  };
}
