import { spawn } from "node:child_process";
import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import {
  AdapterProtocolError,
  type RuntimeAdapter,
  type RuntimeAdapterCheck,
  type RuntimeAdapterManifest,
  type RuntimeLogger,
  type RuntimeStartResult
} from "@switchyard/core";
import { codexEventToSwitchyardEvent, parseCodexJsonLine } from "./codex-jsonl-parser.js";
import { probeCodexCatalog, validateCodexRunOptions } from "./codex-model-catalog.js";
import { parseJsonlEvents } from "../substrates/jsonl-event-parser.js";
import { ProcessRunner, type ProcessRunnerSession } from "../substrates/process-runner.js";
import { TranscriptRecorder } from "../substrates/transcript-recorder.js";
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
  readonly processSession: ProcessRunnerSession<ReturnType<CodexProcessFactory>>;
  readonly startedAt: string;
  readonly transcript: TranscriptRecorder;
  terminalSeen: boolean;
}

interface CodexExecJsonAdapterOptions {
  command?: string;
  processFactory?: CodexProcessFactory;
  modelCatalog?: CodexModelCatalogEntry[];
  probeCatalog?: typeof probeCodexCatalog;
  logger?: RuntimeLogger | undefined;
}

export class CodexInputUnsupportedError extends AdapterProtocolError {
  constructor() {
    super("Codex exec-json does not support input after start", {
      reasonCode: "codex_input_unsupported"
    });
    this.name = "CodexInputUnsupportedError";
  }
}

export class CodexExecJsonAdapter implements RuntimeAdapter {
  readonly id = "codex";
  readonly manifest: RuntimeAdapterManifest = {
    adapterId: "codex",
    providerId: "provider_openai",
    runtimeId: "runtime_codex",
    runtimeModeId: "runtime_mode_codex_exec_json",
    runtimeModeSlug: "codex.exec_json",
    name: "Codex exec JSON",
    adapterType: "process",
    kind: "one_shot_process",
    capabilities: [
      "run.start",
      "run.cancel",
      "run.timeout",
      "event.normalized",
      "event.streaming",
      "artifact.transcript",
      "artifact.raw_transcript",
      "model.catalog",
      "auth.local",
      "sandbox.read_only",
      "sandbox.workspace_write",
      "sandbox.danger_full_access"
    ],
    limitations: [
      { code: "one_shot_no_input", message: "codex.exec_json does not support post-start input." },
      { code: "local_only", message: "This mode runs a local Codex CLI process and is not hosted-safe in R3." },
      { code: "no_approval_bridge", message: "Approval bridge integration is not shipped for codex.exec_json in R3." },
      { code: "no_session_resume", message: "Session resume is not shipped for codex.exec_json in R3." }
    ],
    placement: {
      local: { support: "supported", reason: "Requires a PATH-reachable local codex binary and local workspace." },
      hosted: { support: "unsupported", reason: "Hosted subprocess execution is not shipped in R3." },
      connectedLocalNode: { support: "future", reason: "Hybrid node execution is planned for R10." }
    },
    docsPath: "docs/development/adapters/CODEX.md",
    check: {
      strategy: "binary_version_and_model_catalog",
      required: ["binary_version", "model_catalog"],
      optional: ["sandbox_policy_probe"]
    }
  };
  private readonly command: string;
  private readonly processFactory: CodexProcessFactory;
  private readonly modelCatalog: CodexModelCatalogEntry[];
  private readonly probeCatalog: typeof probeCodexCatalog;
  private readonly sessions = new Map<string, CodexAdapterSession>();
  private readonly logger: RuntimeLogger | undefined;
  private readonly processRunner = new ProcessRunner<ReturnType<CodexProcessFactory>>();

  constructor(options: CodexExecJsonAdapterOptions = {}) {
    this.command = options.command ?? "codex";
    this.processFactory =
      options.processFactory ??
      ((args, processOptions) => spawn(this.command, args, { ...processOptions, shell: false }));
    this.modelCatalog = options.modelCatalog ?? [];
    this.probeCatalog = options.probeCatalog ?? probeCodexCatalog;
    this.logger = options.logger;
  }

  async check(config?: Record<string, unknown>): Promise<RuntimeAdapterCheck> {
    const timeoutMs = typeof config?.["timeoutMs"] === "number" ? config["timeoutMs"] : undefined;
    const maxBufferBytes = typeof config?.["maxDiagnosticBytes"] === "number" ? config["maxDiagnosticBytes"] : undefined;
    const probeOptions: { timeoutMs?: number; maxBufferBytes?: number } = {};
    if (timeoutMs !== undefined) probeOptions.timeoutMs = timeoutMs;
    if (maxBufferBytes !== undefined) probeOptions.maxBufferBytes = maxBufferBytes;
    const probe = await this.probeCatalog(this.command, probeOptions);
    const response: RuntimeAdapterCheck = {
      ok: probe.ok,
      details: {
        version: probe.version,
        models: probe.models,
        reasonCode: probe.reasonCode,
        outputBytes: probe.outputBytes,
        optionalChecks: probe.optionalChecks
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
    const runId = typeof request["runId"] === "string" ? request["runId"] : undefined;
    const options = validateCodexRunOptions({
      model,
      options: toCodexRunOptions(metadata),
      models: this.modelCatalog
    });
    const args = buildCodexExecArgs({ model, cwd, task, options });
    const transcript = new TranscriptRecorder();
    let processPid: number | undefined;
    const processSession = this.processRunner.start({
      processFactory: this.processFactory,
      args,
      cwd,
      env: process.env,
      stdin: "close",
      onStdoutFirstLine: () => {
        this.log("info", "codex.stdout.first_line", {
          runId,
          pid: processPid
        });
      },
      onStderr: (text) => {
        transcript.appendProcessStderr(text);
        this.log("warn", "codex.stderr", {
          runId,
          pid: processPid,
          text: truncate(text, 400)
        });
      },
      onExit: (code) => {
        this.log("info", "codex.exit", {
          runId,
          pid: processPid,
          code
        });
      },
      onError: (message) => {
        this.log("error", "codex.process_error", {
          runId,
          pid: processPid,
          error: message
        });
      }
    });
    processPid = typeof processSession.process.pid === "number" ? processSession.process.pid : undefined;
    for (const line of processSession.rawLines) {
      transcript.appendProcessStdout(line);
    }
    const startedAt = processSession.startedAt;
    this.log("info", "codex.spawned", {
      runId,
      pid: processSession.process.pid,
      model,
      cwd,
      sandbox: options.sandbox ?? "workspace-write",
      ignoreUserConfig: options.ignoreUserConfig,
      ignoreRules: options.ignoreRules
    });
    const session: CodexAdapterSession = {
      processSession,
      startedAt,
      transcript,
      terminalSeen: false,
    };

    const sessionId = `session_${crypto.randomUUID()}`;
    this.sessions.set(sessionId, session);

    const result: RuntimeStartResult = { sessionId };
    if (processSession.processId !== undefined) {
      result.processId = processSession.processId;
    }
    return result;
  }

  async send(_session: Record<string, unknown>, _input: Record<string, unknown>): Promise<void> {
    throw new CodexInputUnsupportedError();
  }

  async cancel(session: Record<string, unknown>): Promise<void> {
    const active = this.requireSession(session);
    active.processSession.cancel();
  }

  async *events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    const active = this.requireSession(session);
    const runId = requireString(session["runId"], "runId");
    let lastSequence = 0;
    for await (const event of parseJsonlEvents(
      active.processSession.stdoutQueue,
      (record, context) => {
        const parsed = parseCodexJsonLine(JSON.stringify(record));
        const mapped = codexEventToSwitchyardEvent(parsed, context);
        lastSequence = mapped.sequence + 1;
        return mapped;
      },
      {
        runId,
        sanitizeError: (message) => message
          .startsWith("Invalid Codex JSONL line:")
          ? message
          : `Invalid Codex JSONL line: ${message}`
      }
    )) {
      if (event.type === "run.completed" || event.type === "run.failed") {
        active.terminalSeen = true;
      }
      yield event;
      if (event.type === "run.completed" || event.type === "run.failed") {
        return;
      }
    }

    const exitCode = await active.processSession.exitPromise;
    if (!active.terminalSeen && exitCode !== null && exitCode !== 0) {
      yield {
        id: `event_${crypto.randomUUID()}`,
        type: "run.failed",
        runId,
        sequence: lastSequence,
        payload: {
          status: "failed",
          exitCode,
          stderr: active.processSession.stderrLines.join("")
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
    await active.processSession.drainPromise;
    for (const line of active.processSession.rawLines) {
      active.transcript.appendProcessStdout(line);
    }
    const content = active.transcript.content();

    return [
      {
        id: "artifact_codex_transcript",
        type: "transcript",
        path: `runs/${runId}/codex-transcript.jsonl`,
        metadata: {
          content,
          ...active.transcript.metadata({
            runtime: "codex",
            mode: "exec-json",
            runtimeMode: "codex.exec_json"
          })
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

  private log(level: keyof RuntimeLogger, event: string, details?: Record<string, unknown>): void {
    this.logger?.[level](event, details);
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
  if (input.options.ignoreUserConfig) {
    args.push("--ignore-user-config");
  }
  if (input.options.ignoreRules) {
    args.push("--ignore-rules");
  }

  args.push(input.task);
  return args;
}

function toCodexRunOptions(metadata: Record<string, unknown>): CodexRunOptions {
  const options: CodexRunOptions = {
    skipGitRepoCheck: metadata["skipGitRepoCheck"] === true,
    ephemeral: metadata["ephemeral"] === true,
    ignoreUserConfig: metadata["ignoreUserConfig"] !== false,
    ignoreRules: metadata["ignoreRules"] === true
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

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
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
