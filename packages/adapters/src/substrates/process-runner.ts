import { createInterface } from "node:readline";
import { AsyncLineQueue } from "./async-line-queue.js";

export interface ProcessRunnerOptions<TProcess> {
  processFactory: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => TProcess;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: "close" | "inherit";
  onStdoutFirstLine?: () => void;
  onStderr?: (text: string) => void;
  onExit?: (code: number | null) => void;
  onError?: (message: string) => void;
}

export interface ProcessRunnerSession<TProcess> {
  process: TProcess;
  startedAt: string;
  processId: number | undefined;
  stdoutQueue: AsyncLineQueue;
  rawLines: string[];
  stderrLines: string[];
  exitCode?: number | null;
  exitPromise: Promise<number | null>;
  drainPromise: Promise<void>;
  cancel: () => void;
}

type ProcessShape = {
  pid?: number | undefined;
  stdin: { end: () => void };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream & {
    on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
    once(event: "end", listener: () => void): unknown;
  };
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  kill(signal: NodeJS.Signals): void;
};

export class ProcessRunner<TProcess extends ProcessShape> {
  start(input: ProcessRunnerOptions<TProcess>): ProcessRunnerSession<TProcess> {
    const process = input.processFactory(input.args, { cwd: input.cwd, env: input.env });
    if (input.stdin === "close") {
      process.stdin.end();
    }

    const startedAt = new Date().toISOString();
    const rawLines: string[] = [];
    const stderrLines: string[] = [];
    const stdoutQueue = new AsyncLineQueue();

    let resolveExit: ((code: number | null) => void) | undefined;
    const exitPromise = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });

    let stderrEnded = false;
    let resolveStderrEnd: (() => void) | undefined;
    const stderrEndPromise = new Promise<void>((resolve) => {
      resolveStderrEnd = resolve;
    });
    const endStderr = () => {
      if (!stderrEnded) {
        stderrEnded = true;
        resolveStderrEnd?.();
      }
    };

    let exitSettled = false;
    const settleExit = (code: number | null) => {
      if (!exitSettled) {
        exitSettled = true;
        resolveExit?.(code);
      }
    };

    let firstStdoutSeen = false;
    const stdoutCapturePromise = (async () => {
      const lines = createInterface({
        input: process.stdout,
        crlfDelay: Infinity
      });
      try {
        for await (const line of lines) {
          if (line.length === 0) {
            continue;
          }
          if (!firstStdoutSeen) {
            firstStdoutSeen = true;
            input.onStdoutFirstLine?.();
          }
          rawLines.push(line);
          stdoutQueue.push(line);
        }
      } finally {
        stdoutQueue.close();
      }
    })();

    process.stderr.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderrLines.push(text);
      input.onStderr?.(text);
    });

    process.stderr.once("end", () => {
      endStderr();
    });

    process.once("exit", (code) => {
      input.onExit?.(code);
      endStderr();
      settleExit(code);
    });

    process.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      stderrLines.push(message);
      input.onError?.(message);
      endStderr();
      settleExit(1);
    });

    let cancelled = false;
    const cancel = () => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      process.kill("SIGTERM");
    };

    const session: ProcessRunnerSession<TProcess> = {
      process,
      startedAt,
      processId: typeof process.pid === "number" ? process.pid : undefined,
      stdoutQueue,
      rawLines,
      stderrLines,
      exitPromise,
      drainPromise: Promise.resolve(),
      cancel
    };
    session.drainPromise = Promise.all([stdoutCapturePromise, stderrEndPromise, exitPromise]).then(([, , code]) => {
      session.exitCode = code;
    });
    return session;
  }
}
