import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import type { RuntimeAdapter, RuntimeAdapterCheck, RuntimeStartResult } from "@switchyard/core";
import { codexEventToSwitchyardEvent, parseCodexJsonLine } from "./codex-jsonl-parser.js";
import { probeCodexCatalog, validateCodexRunOptions } from "./codex-model-catalog.js";
import type {
  CodexModelCatalogEntry,
  CodexProcessFactory,
  CodexReasoningEffort,
  CodexReasoningSummary,
  CodexRunOptions,
  CodexSandbox,
  CodexVerbosity
} from "./types.js";

interface CodexAdapterSession {
  readonly process: ReturnType<CodexProcessFactory>;
  readonly startedAt: string;
  readonly rawLines: string[];
  readonly stderrLines: string[];
  readonly exitPromise: Promise<number | null>;
  drainPromise: Promise<void>;
  readonly stdoutQueue: AsyncLineQueue;
  terminalSeen: boolean;
  exitCode?: number | null;
}

class AsyncLineQueue {
  private readonly items: string[] = [];
  private readonly waiters: Array<(value: IteratorResult<string>) => void> = [];
  private closed = false;

  push(line: string): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: line, done: false });
      return;
    }
    this.items.push(line);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<string>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

interface CodexExecJsonAdapterOptions {
  command?: string;
  processFactory?: CodexProcessFactory;
  modelCatalog?: CodexModelCatalogEntry[];
}

export class CodexInputUnsupportedError extends Error {
  constructor() {
    super("Codex exec-json does not support input after start");
    this.name = "CodexInputUnsupportedError";
  }
}

export class CodexExecJsonAdapter implements RuntimeAdapter {
  readonly id = "codex";
  private readonly command: string;
  private readonly processFactory: CodexProcessFactory;
  private readonly modelCatalog: CodexModelCatalogEntry[];
  private readonly sessions = new Map<string, CodexAdapterSession>();

  constructor(options: CodexExecJsonAdapterOptions = {}) {
    this.command = options.command ?? "codex";
    this.processFactory =
      options.processFactory ??
      ((args, processOptions) => spawn(this.command, args, { ...processOptions, shell: false }));
    this.modelCatalog = options.modelCatalog ?? [];
  }

  async check(): Promise<RuntimeAdapterCheck> {
    const probe = await probeCodexCatalog(this.command);
    const response: RuntimeAdapterCheck = {
      ok: probe.ok,
      details: {
        version: probe.version,
        models: probe.models
      }
    };
    if (probe.message) {
      response.message = probe.message;
    }
    return response;
  }

  async start(request: Record<string, unknown>): Promise<RuntimeStartResult> {
    const cwd = requireString(request["cwd"], "cwd");
    const model = requireString(request["model"], "model");
    const task = requireString(request["task"], "task");
    const metadata = readMetadata(request["metadata"]);
    const options = validateCodexRunOptions({
      model,
      options: toCodexRunOptions(metadata),
      models: this.modelCatalog
    });
    const args = buildCodexExecArgs({ model, cwd, task, options });
    const child = this.processFactory(args, { cwd, env: process.env });
    const startedAt = new Date().toISOString();

    let resolveExit: ((code: number | null) => void) | undefined;
    const exitPromise = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });

    const stdoutQueue = new AsyncLineQueue();
    const session: CodexAdapterSession = {
      process: child,
      startedAt,
      rawLines: [],
      stderrLines: [],
      terminalSeen: false,
      exitPromise,
      drainPromise: Promise.resolve(),
      stdoutQueue
    };

    let resolveStderrEnd: (() => void) | undefined;
    const stderrEndPromise = new Promise<void>((resolve) => {
      resolveStderrEnd = resolve;
    });

    child.stderr.on("data", (chunk: string | Buffer) => {
      session.stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stderr.once("end", () => {
      resolveStderrEnd?.();
    });
    child.once("exit", (code) => {
      session.exitCode = code;
      resolveStderrEnd?.();
      resolveExit?.(code);
    });
    child.once("error", (error) => {
      session.stderrLines.push(error instanceof Error ? error.message : String(error));
      if (session.exitCode === undefined) {
        session.exitCode = 1;
      }
      resolveStderrEnd?.();
      resolveExit?.(session.exitCode);
    });

    const stdoutCapturePromise = this.captureStdoutLines(child, session);
    session.drainPromise = Promise.all([stdoutCapturePromise, stderrEndPromise, exitPromise]).then(() => undefined);

    const sessionId = `session_${crypto.randomUUID()}`;
    this.sessions.set(sessionId, session);

    const result: RuntimeStartResult = { sessionId };
    if (typeof child.pid === "number") {
      result.processId = child.pid;
    }
    return result;
  }

  async send(_session: Record<string, unknown>, _input: Record<string, unknown>): Promise<void> {
    throw new CodexInputUnsupportedError();
  }

  async cancel(session: Record<string, unknown>): Promise<void> {
    const active = this.requireSession(session);
    active.process.kill("SIGTERM");
  }

  async *events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    const active = this.requireSession(session);
    const runId = requireString(session["runId"], "runId");
    let sequence = 0;
    while (true) {
      const next = await active.stdoutQueue.next();
      if (next.done) {
        break;
      }
      const line = next.value;

      try {
        const parsed = parseCodexJsonLine(line);
        const event = codexEventToSwitchyardEvent(parsed, {
          runId,
          sequence,
          createdAt: new Date().toISOString()
        });
        sequence += 1;

        if (event.type === "run.completed" || event.type === "run.failed") {
          active.terminalSeen = true;
          yield event;
          return;
        }
        yield event;
      } catch (error) {
        active.terminalSeen = true;
        yield {
          id: `event_${crypto.randomUUID()}`,
          type: "run.failed",
          runId,
          sequence,
          payload: {
            status: "failed",
            error: error instanceof Error ? error.message : String(error)
          },
          createdAt: new Date().toISOString()
        };
        return;
      }
    }

    const exitCode = await active.exitPromise;
    if (!active.terminalSeen && exitCode !== null && exitCode !== 0) {
      yield {
        id: `event_${crypto.randomUUID()}`,
        type: "run.failed",
        runId,
        sequence,
        payload: {
          status: "failed",
          exitCode,
          stderr: active.stderrLines.join("")
        },
        createdAt: new Date().toISOString()
      };
    }
  }

  async tools(): Promise<string[]> {
    return [];
  }

  async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    const active = this.requireSession(session);
    const runId = requireString(session["runId"], "runId");
    await active.drainPromise;
    const content = buildTranscriptContent(active.rawLines, active.stderrLines);

    return [
      {
        id: "artifact_codex_transcript",
        type: "transcript",
        path: `runs/${runId}/codex-transcript.jsonl`,
        metadata: {
          content,
          runtime: "codex",
          mode: "exec-json"
        },
        createdAt: active.startedAt
      }
    ];
  }

  private requireSession(session: Record<string, unknown>): CodexAdapterSession {
    const sessionId = requireString(session["sessionId"], "sessionId");
    const active = this.sessions.get(sessionId);
    if (!active) {
      throw new Error(`Codex session not found: ${sessionId}`);
    }
    return active;
  }

  private async captureStdoutLines(
    process: ReturnType<CodexProcessFactory>,
    session: Pick<CodexAdapterSession, "rawLines" | "stdoutQueue">
  ): Promise<void> {
    const lines = createInterface({
      input: process.stdout,
      crlfDelay: Infinity
    });

    try {
      for await (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        session.rawLines.push(line);
        session.stdoutQueue.push(line);
      }
    } finally {
      session.stdoutQueue.close();
    }
  }
}

export function buildCodexExecArgs(input: { model: string; cwd: string; task: string; options: CodexRunOptions }): string[] {
  const args = ["exec", "--json", "--model", input.model];

  if (input.options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${input.options.reasoningEffort}"`);
  }
  if (input.options.reasoningSummary) {
    args.push("-c", `model_reasoning_summary="${input.options.reasoningSummary}"`);
  }
  if (input.options.verbosity) {
    args.push("-c", `model_verbosity="${input.options.verbosity}"`);
  }

  args.push("--cd", input.cwd);
  args.push("--sandbox", input.options.sandbox ?? "workspace-write");

  if (input.options.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (input.options.ephemeral) {
    args.push("--ephemeral");
  }

  args.push(input.task);
  return args;
}

function buildTranscriptContent(rawLines: string[], stderrLines: string[]): string {
  const lines = rawLines.map((line) => `${line}\n`);
  if (stderrLines.length > 0) {
    lines.push(`${JSON.stringify({ type: "stderr", text: stderrLines.join("") })}\n`);
  }
  return lines.join("");
}

function toCodexRunOptions(metadata: Record<string, unknown>): CodexRunOptions {
  const options: CodexRunOptions = {
    skipGitRepoCheck: metadata["skipGitRepoCheck"] === true,
    ephemeral: metadata["ephemeral"] === true
  };

  const reasoningEffort = readEnum<CodexReasoningEffort>(metadata["reasoningEffort"], ["minimal", "low", "medium", "high", "xhigh"]);
  const reasoningSummary = readEnum<CodexReasoningSummary>(metadata["reasoningSummary"], ["auto", "concise", "detailed", "none"]);
  const verbosity = readEnum<CodexVerbosity>(metadata["verbosity"], ["low", "medium", "high"]);
  const sandbox = readEnum<CodexSandbox>(metadata["sandbox"], ["read-only", "workspace-write", "danger-full-access"]);

  if (reasoningEffort) options.reasoningEffort = reasoningEffort;
  if (reasoningSummary) options.reasoningSummary = reasoningSummary;
  if (verbosity) options.verbosity = verbosity;
  if (sandbox) options.sandbox = sandbox;

  return options;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Unsupported Codex option value: ${String(value)}`);
  }
  return value as T;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
