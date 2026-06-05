import { spawn } from "node:child_process";
import type { Artifact, ProviderResolvedCommand, SwitchyardEvent } from "@switchyard/contracts";
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
  CodexExecJsonAdapterOptions,
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
      { code: "local_only", message: "This mode runs a local Codex CLI process and is not hosted-safe in R8." },
      { code: "no_approval_bridge", message: "Approval bridge integration is not shipped for codex.exec_json in R8." },
      { code: "no_session_resume", message: "Session resume remains deferred for codex.exec_json in R8." }
    ],
    placement: {
      local: { support: "supported", reason: "Requires a PATH-reachable local codex binary and local workspace." },
      hosted: { support: "unsupported", reason: "Hosted subprocess execution is not shipped in R8." },
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
  private readonly hostedProviderCommand: ProviderResolvedCommand | undefined;

  constructor(options: CodexExecJsonAdapterOptions = {}) {
    this.command = options.command ?? "codex";
    this.processFactory =
      options.processFactory ??
      ((command, args, processOptions) => spawn(command, args, { ...processOptions, shell: false }));
    this.modelCatalog = options.modelCatalog ?? [];
    this.probeCatalog = options.probeCatalog ?? probeCodexCatalog;
    this.logger = options.logger;
    this.hostedProviderCommand = options.hostedProviderCommand;
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
    const hosted = this.hostedProviderCommand;
    if (hosted && !isValidHostedCommand(hosted, cwd, metadata)) {
      throw new AdapterProtocolError("Hosted codex command handoff denied.", {
        reasonCode: "provider_command_denied"
      });
    }
    const options = validateCodexRunOptions({
      model,
      options: toCodexRunOptions(metadata, hosted),
      models: this.modelCatalog
    });
    const args = buildCodexExecArgs({ model, cwd, task, options });
    const command = hosted?.executablePath ?? this.command;
    const env = hosted ? filterHostedEnv(hosted) : process.env;
    const transcript = new TranscriptRecorder();
    let processPid: number | undefined;
    let processSession: ProcessRunnerSession<ReturnType<CodexProcessFactory>>;
    try {
      processSession = this.processRunner.start({
        processFactory: (spawnArgs, processOptions) =>
          invokeCodexProcessFactory(this.processFactory, command, spawnArgs, processOptions),
        args,
        cwd,
        env,
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
            text: hosted ? "[REDACTED]" : truncate(text, 400)
          });
        },
        onExit: (code) => {
          this.log("info", "codex.exit", {
            runId,
            pid: processPid,
            code
          });
        },
        onError: (_message) => {
          this.log("error", "codex.process_error", {
            runId,
            pid: processPid,
            error: hosted ? "[REDACTED]" : "process_error"
          });
        }
      });
    } catch {
      if (hosted) {
        throw new AdapterProtocolError("Hosted codex binary is unavailable.", {
          reasonCode: "provider_binary_unavailable"
        });
      }
      throw new Error("Failed to start codex process");
    }
    processPid = typeof processSession.process.pid === "number" ? processSession.process.pid : undefined;
    for (const line of processSession.rawLines) {
      transcript.appendProcessStdout(line);
    }
    const startedAt = processSession.startedAt;
    this.log("info", "codex.spawned", {
      runId,
      pid: processSession.process.pid,
      model,
      ...(hosted ? {} : { cwd }),
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
    const hosted = Boolean(this.hostedProviderCommand);
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
          ? (hosted ? "Invalid Codex JSONL line: [REDACTED]" : message)
          : hosted
            ? "Invalid Codex JSONL line: [REDACTED]"
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
          ...(hosted
            ? { reasonCode: "provider_binary_unavailable", error: "[REDACTED]" }
            : { exitCode, stderr: active.processSession.stderrLines.join("") })
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

function toCodexRunOptions(
  metadata: Record<string, unknown>,
  hostedProviderCommand?: ProviderResolvedCommand
): CodexRunOptions {
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
  if (hostedProviderCommand) {
    options.sandbox = "read-only";
    options.ignoreUserConfig = true;
    options.ignoreRules = false;
    options.skipGitRepoCheck = false;
    options.ephemeral = false;
  }

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

function isValidHostedCommand(
  hostedProviderCommand: ProviderResolvedCommand,
  cwd: string,
  metadata: Record<string, unknown>
): boolean {
  if (hostedProviderCommand.runtimeMode !== "codex.exec_json") {
    return false;
  }
  if (hostedProviderCommand.cwd !== cwd) {
    return false;
  }
  if (hostedProviderCommand.argv.length !== 2 || hostedProviderCommand.argv[0] !== "exec" || hostedProviderCommand.argv[1] !== "--json") {
    return false;
  }
  if (hostedProviderCommand.allowUserArgs) {
    return false;
  }
  const sandbox = metadata["sandbox"];
  if (typeof sandbox === "string" && sandbox !== "read-only") {
    return false;
  }
  return !hasDeniedMetadataKey(metadata);
}

function filterHostedEnv(hostedProviderCommand: ProviderResolvedCommand): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of hostedProviderCommand.envKeys) {
    const value = hostedProviderCommand.env[key];
    if (typeof value === "string") {
      output[key] = value;
    }
  }
  return output;
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
      normalized === "pty" ||
      normalized.includes("pty") ||
      normalized === "terminal" ||
      normalized.includes("terminal") ||
      normalized === "cwd" ||
      normalized === "argv" ||
      normalized === "args" ||
      normalized === "env" ||
      normalized === "shell" ||
      normalized === "sandbox"
    ) {
      return true;
    }
    if (hasDeniedMetadataKey(entry)) {
      return true;
    }
  }
  return false;
}

function invokeCodexProcessFactory(
  factory: CodexProcessFactory,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): ReturnType<CodexProcessFactory> {
  if (factory.length >= 3) {
    return (factory as (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ReturnType<CodexProcessFactory>)(
      command,
      args,
      options
    );
  }
  return (factory as (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ReturnType<CodexProcessFactory>)(
    args,
    options
  );
}
