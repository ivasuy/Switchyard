import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import {
  AdapterProtocolError,
  redactSecrets,
  type RuntimeAdapter,
  type RuntimeAdapterCheck,
  type RuntimeAdapterManifest,
  type RuntimeLogger,
  type RuntimeStartResult
} from "@switchyard/core";
import { codexEventToSwitchyardEvent } from "./codex-jsonl-parser.js";
import {
  CODEX_INTERACTIVE_RUNTIME_MODE_SLUG,
  type CodexInteractiveSessionFactory,
  type CodexInteractiveProviderEvent,
  type CodexInteractiveTurn
} from "./codex-interactive-session-factory.js";
import { finalizeTranscript, serializeNormalizedRecord } from "../claude-code/transcript-bounds.js";

const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

interface StoredInteractiveSession {
  sessionId: string;
  runId: string;
  runtimeMode: string;
  cwd: string;
  startedAt: string;
  threadId?: string;
  queue: AsyncEventQueue;
  state: "active" | "waiting_for_input" | "waiting_for_approval" | "terminal";
  terminalSeen: boolean;
  inFlightResume: boolean;
  approvalTokens: Set<string>;
  rawRecords: string[];
  normalizedRecords: Record<string, unknown>[];
}

export interface CodexInteractiveAdapterOptions {
  sessionFactory: CodexInteractiveSessionFactory;
  command?: string;
  approvalBridgeSupported?: boolean;
  logger?: RuntimeLogger;
}

export class CodexInteractiveAdapter implements RuntimeAdapter {
  readonly id = "codex";
  readonly manifest: RuntimeAdapterManifest;

  private readonly sessions = new Map<string, StoredInteractiveSession>();
  private readonly command: string;
  private readonly approvalBridgeSupported: boolean;

  constructor(private readonly options: CodexInteractiveAdapterOptions) {
    this.command = options.command ?? "codex";
    this.approvalBridgeSupported = options.approvalBridgeSupported ?? false;
    this.manifest = {
      adapterId: "codex",
      providerId: "provider_openai",
      runtimeId: "runtime_codex",
      runtimeModeId: "runtime_mode_codex_interactive",
      runtimeModeSlug: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG,
      name: "Codex interactive",
      adapterType: "process",
      kind: "interactive_process",
      capabilities: [
        "run.start",
        "run.input",
        "run.cancel",
        "run.timeout",
        "session.state",
        "session.resume",
        ...(this.approvalBridgeSupported ? (["approval.bridge"] as const) : []),
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "artifact.raw_transcript",
        "auth.local",
        "sandbox.read_only",
        "sandbox.workspace_write",
        "sandbox.danger_full_access"
      ],
      limitations: [
        { code: "local_only", message: "codex.interactive is local-only in R16." },
        ...(this.approvalBridgeSupported ? [] : [{ code: "codex_approval_bridge_unsupported", message: "Approval bridge is unsupported by this Codex driver." }])
      ],
      placement: {
        local: { support: "conditional", reason: "Requires local Codex command-shape support." },
        hosted: { support: "unsupported", reason: "codex.interactive is local-only in R16" },
        connectedLocalNode: { support: "future", reason: "Connected-node interactive Codex is not shipped in R16." }
      },
      docsPath: "docs/development/adapters/CODEX.md",
      check: {
        strategy: "custom",
        required: ["binary_version", "resume_command_shape"],
        optional: ["approval_bridge"]
      }
    };
  }

  async check(config?: Record<string, unknown>): Promise<RuntimeAdapterCheck> {
    const timeoutMs = typeof config?.["timeoutMs"] === "number" ? config["timeoutMs"] : undefined;
    const maxDiagnosticBytes = typeof config?.["maxDiagnosticBytes"] === "number" ? config["maxDiagnosticBytes"] : undefined;
    const checkInput: { command: string; timeoutMs?: number; maxDiagnosticBytes?: number; runtimeMode?: string } = {
      command: this.command,
      runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG
    };
    if (timeoutMs !== undefined) checkInput.timeoutMs = timeoutMs;
    if (maxDiagnosticBytes !== undefined) checkInput.maxDiagnosticBytes = maxDiagnosticBytes;
    const result = await this.options.sessionFactory.check(checkInput);
    const check: RuntimeAdapterCheck = {
      ok: result.ok,
      details: {
        availability: result.availability,
        diagnostics: result.diagnostics,
        resumeCommandShapeAvailable: result.capabilities?.resumeCommandShapeAvailable ?? false,
        liveResumeVerified: result.capabilities?.liveResumeVerified ?? false,
        approvalBridge: this.approvalBridgeSupported
      }
    };
    if (result.availability.message !== null) {
      check.message = result.availability.message;
    }
    return check;
  }

  async start(request: Record<string, unknown>): Promise<RuntimeStartResult> {
    const runtimeMode = typeof request["runtimeMode"] === "string" ? request["runtimeMode"] : undefined;
    if (runtimeMode !== CODEX_INTERACTIVE_RUNTIME_MODE_SLUG) {
      throw new AdapterProtocolError("Unsupported Codex runtime mode", {
        reasonCode: "codex_runtime_mode_unsupported"
      });
    }

    const runId = requiredString(request["runId"], "runId", "codex_run_id_required");
    const cwd = requiredString(request["cwd"], "cwd", "codex_cwd_required");
    const task = requiredString(request["task"], "task", "codex_task_required");
    if (task.trim().length === 0) {
      throw new AdapterProtocolError("Codex interactive requires a non-empty task", {
        reasonCode: "codex_task_required"
      });
    }

    const startedAt = new Date().toISOString();
    const sessionId = `session_${crypto.randomUUID()}`;
    const stored: StoredInteractiveSession = {
      sessionId,
      runId,
      runtimeMode,
      cwd,
      startedAt,
      queue: new AsyncEventQueue(),
      state: "active",
      terminalSeen: false,
      inFlightResume: false,
      approvalTokens: new Set<string>(),
      rawRecords: [],
      normalizedRecords: []
    };
    this.sessions.set(sessionId, stored);

    const turn = await this.options.sessionFactory.startTurn({
      runId,
      cwd,
      task,
      metadata: asRecord(request["metadata"]) ?? {}
    });

    void this.processTurn(stored, turn, "start");
    return { sessionId };
  }

  async send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void> {
    const stored = this.requireSession(session);
    if (stored.terminalSeen) {
      throw new AdapterProtocolError("Runtime session is not active", {
        reasonCode: "runtime_input_not_active"
      });
    }

    if (input["type"] === "approval_resolution") {
      if (!this.approvalBridgeSupported) {
        throw new AdapterProtocolError("Codex approval bridge is unsupported", {
          reasonCode: "codex_approval_bridge_unsupported"
        });
      }
      const runtimeApprovalToken = requiredString(input["runtimeApprovalToken"], "runtimeApprovalToken", "runtime_approval_token_missing");
      if (!stored.approvalTokens.has(runtimeApprovalToken)) {
        throw new AdapterProtocolError("Runtime approval pause is not active.", {
          reasonCode: "runtime_approval_pause_not_active"
        });
      }
      const decision = input["decision"] === "rejected" ? "rejected" : "approved";
      const message = typeof input["message"] === "string" && input["message"].trim().length > 0
        ? input["message"].trim()
        : `${decision} by local-user`;
      await this.options.sessionFactory.resolveApproval({
        runId: stored.runId,
        runtimeApprovalToken,
        decision,
        message,
        ...(stored.threadId ? { codexThreadId: stored.threadId } : {})
      });
      stored.approvalTokens.delete(runtimeApprovalToken);
      stored.state = "active";
      this.options.logger?.info("codex.interactive.approval_resolved", {
        runId: stored.runId,
        decision
      });
      return;
    }

    const text = requiredString(input["text"], "text", "runtime_input_empty");
    if (text.trim().length === 0) {
      throw new AdapterProtocolError("Runtime input text must be non-empty.", {
        reasonCode: "runtime_input_empty"
      });
    }
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      throw new AdapterProtocolError("Runtime input text exceeds 64 KiB.", {
        reasonCode: "runtime_input_too_large"
      });
    }
    if (!stored.threadId) {
      throw new AdapterProtocolError("Codex resume token is missing.", {
        reasonCode: "codex_resume_token_missing"
      });
    }
    if (stored.inFlightResume) {
      throw new AdapterProtocolError("Runtime input is already in flight for this session.", {
        reasonCode: "runtime_input_in_flight"
      });
    }

    stored.inFlightResume = true;
    try {
      const turn = await this.options.sessionFactory.resumeTurn({
        runId: stored.runId,
        cwd: stored.cwd,
        codexThreadId: stored.threadId,
        text,
        metadata: {}
      });
      await this.processTurn(stored, turn, "resume");
    } finally {
      stored.inFlightResume = false;
    }
  }

  async cancel(session: Record<string, unknown>): Promise<void> {
    const stored = this.requireSession(session);
    if (stored.terminalSeen) {
      return;
    }
    await this.options.sessionFactory.cancel({
      runId: stored.runId,
      ...(stored.threadId ? { codexThreadId: stored.threadId } : {})
    });
    stored.state = "terminal";
    stored.terminalSeen = true;
    stored.approvalTokens.clear();
    stored.queue.close();
    this.options.logger?.info("codex.interactive.cancelled", { runId: stored.runId });
  }

  async *events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    const stored = this.requireSession(session);
    for await (const event of stored.queue.iterate()) {
      yield event;
    }
  }

  async tools(): Promise<string[]> {
    return [];
  }

  async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    const stored = this.requireSession(session);

    const rawLines = stored.rawRecords.map((line) => `${line}\n`);
    const normalizedLines = stored.normalizedRecords.map((record) => `${serializeNormalizedRecord(record)}\n`);

    const rawContent = finalizeTranscript(rawLines, MAX_TRANSCRIPT_BYTES);
    const normalizedContent = finalizeTranscript(normalizedLines, MAX_TRANSCRIPT_BYTES);

    const rawBytes = Buffer.byteLength(rawContent, "utf8");
    const normalizedBytes = Buffer.byteLength(normalizedContent, "utf8");

    return [
      {
        id: `artifact_${crypto.randomUUID()}`,
        runId: stored.runId,
        type: "transcript",
        path: `runs/${stored.runId}/codex-interactive-raw-transcript.jsonl`,
        metadata: {
          content: rawContent,
          runtime: "codex",
          mode: "interactive",
          runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG,
          bytes: rawBytes,
          truncated: rawContent.includes("transcript.truncated"),
          redacted: true
        },
        createdAt: stored.startedAt
      },
      {
        id: `artifact_${crypto.randomUUID()}`,
        runId: stored.runId,
        type: "transcript",
        path: `runs/${stored.runId}/codex-interactive-normalized-transcript.jsonl`,
        metadata: {
          content: normalizedContent,
          runtime: "codex",
          mode: "interactive",
          runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG,
          bytes: normalizedBytes,
          truncated: normalizedContent.includes("transcript.truncated"),
          redacted: true
        },
        createdAt: stored.startedAt
      }
    ];
  }

  private requireSession(session: Record<string, unknown>): StoredInteractiveSession {
    const sessionId = requiredString(session["sessionId"], "sessionId", "runtime_session_missing");
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      throw new AdapterProtocolError("Runtime session is missing for this run.", {
        reasonCode: "runtime_session_missing"
      });
    }
    return stored;
  }

  private async processTurn(stored: StoredInteractiveSession, turn: CodexInteractiveTurn, phase: "start" | "resume"): Promise<void> {
    this.options.logger?.info(`codex.interactive.${phase}`, {
      runId: stored.runId
    });

    let sequence = stored.normalizedRecords.length;
    let discoveredThreadId = turn.threadId;

    try {
      for await (const providerEvent of turn.events()) {
        const redactedRecord = redactSecrets(redactSensitiveStrings(providerEvent));
        stored.rawRecords.push(JSON.stringify(redactedRecord));

        const mapped = this.mapProviderEvent(providerEvent, stored.runId, sequence);
        if (!mapped) {
          throw new AdapterProtocolError("Malformed Codex interactive stream", {
            reasonCode: "codex_stream_malformed"
          });
        }

        sequence += 1;
        stored.normalizedRecords.push(redactSecrets(redactSensitiveStrings(mapped)));

        if (mapped.type === "approval.requested") {
          const token = mapped.payload["runtimeApprovalToken"];
          if (typeof token !== "string" || token.trim().length === 0) {
            throw new AdapterProtocolError("Runtime approval token missing", {
              reasonCode: "runtime_approval_token_missing"
            });
          }
          stored.approvalTokens.add(token);
          stored.state = "waiting_for_approval";
          this.options.logger?.info("codex.interactive.approval_requested", {
            runId: stored.runId
          });
        }

        if (mapped.type === "runtime.status") {
          const patch = mapped.payload["sessionStatePatch"];
          if (patch && typeof patch === "object" && !Array.isArray(patch)) {
            const codexThreadId = (patch as Record<string, unknown>)["codexThreadId"];
            if (typeof codexThreadId === "string" && codexThreadId.trim().length > 0) {
              discoveredThreadId = codexThreadId.trim();
            }
          }
        }

        if (mapped.type === "run.completed" || mapped.type === "run.failed" || mapped.type === "run.cancelled") {
          stored.terminalSeen = true;
          stored.state = "terminal";
          await stored.queue.push(mapped);
          stored.queue.close();
          return;
        }

        await stored.queue.push(mapped);
      }

      if (turn.terminalStatus === "completed") {
        const terminal = this.makeEvent(stored.runId, sequence++, "run.completed", { status: "completed" });
        stored.normalizedRecords.push(redactSecrets(terminal));
        await stored.queue.push(terminal);
        stored.terminalSeen = true;
        stored.state = "terminal";
        stored.queue.close();
        return;
      }

      if (turn.terminalStatus === "failed") {
        const terminal = this.makeEvent(stored.runId, sequence++, "run.failed", {
          status: "failed",
          reasonCode: turn.terminalReasonCode ?? "codex_stream_malformed"
        });
        stored.normalizedRecords.push(redactSecrets(terminal));
        await stored.queue.push(terminal);
        stored.terminalSeen = true;
        stored.state = "terminal";
        stored.queue.close();
        return;
      }

      if (discoveredThreadId) {
        stored.threadId = discoveredThreadId;
        const patchEvent = this.makeEvent(stored.runId, sequence++, "runtime.status", {
          status: "running",
          sessionStatePatch: {
            codexThreadId: discoveredThreadId,
            codexResumeMode: "exec_resume_json"
          }
        });
        stored.normalizedRecords.push(redactSecrets(redactSensitiveStrings(patchEvent)));
        await stored.queue.push(patchEvent);
      }

      if (turn.waitingForApproval) {
        stored.state = "waiting_for_approval";
        const waitEvent = this.makeEvent(stored.runId, sequence++, "runtime.status", {
          status: "waiting_for_approval"
        });
        stored.normalizedRecords.push(redactSecrets(redactSensitiveStrings(waitEvent)));
        await stored.queue.push(waitEvent);
        return;
      }

      if (turn.waitForInput) {
        if (!stored.threadId) {
          throw new AdapterProtocolError("Codex resume token is missing.", {
            reasonCode: "codex_resume_token_missing"
          });
        }
        stored.state = "waiting_for_input";
        const waitEvent = this.makeEvent(stored.runId, sequence++, "runtime.status", {
          status: "waiting_for_input"
        });
        stored.normalizedRecords.push(redactSecrets(waitEvent));
        await stored.queue.push(waitEvent);
        this.options.logger?.info("codex.interactive.waiting_for_input", { runId: stored.runId });
      }
    } catch (error) {
      const protocolError = error instanceof AdapterProtocolError
        ? error
        : new AdapterProtocolError(error instanceof Error ? error.message : String(error), {
          reasonCode: "codex_stream_malformed"
        });
      const failed = this.makeEvent(stored.runId, sequence++, "run.failed", {
        status: "failed",
        reasonCode: protocolError.reasonCode ?? "codex_stream_malformed",
        error: protocolError.message
      });
      stored.normalizedRecords.push(redactSecrets(redactSensitiveStrings(failed)));
      await stored.queue.push(failed);
      stored.terminalSeen = true;
      stored.state = "terminal";
      stored.queue.close();
      this.options.logger?.warn("codex.interactive.stream_malformed", {
        runId: stored.runId,
        reasonCode: protocolError.reasonCode
      });
    }
  }

  private mapProviderEvent(
    providerEvent: CodexInteractiveProviderEvent,
    runId: string,
    sequence: number
  ): SwitchyardEvent | undefined {
    if (!providerEvent || typeof providerEvent !== "object" || Array.isArray(providerEvent)) {
      return undefined;
    }
    const type = providerEvent["type"];
    if (type === "approval.requested") {
      const token = providerEvent["runtimeApprovalToken"];
      if (typeof token !== "string" || token.trim().length === 0) {
        return this.makeEvent(runId, sequence, "run.failed", {
          status: "failed",
          reasonCode: "runtime_approval_token_missing"
        });
      }
      return this.makeEvent(runId, sequence, "approval.requested", {
        runtimeApprovalToken: token,
        approvalType: typeof providerEvent["approvalType"] === "string" ? providerEvent["approvalType"] : "before_external_message",
        runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG,
        bridge: "codex",
        summary: typeof providerEvent["summary"] === "string" ? providerEvent["summary"].slice(0, 512) : "",
        toolName: typeof providerEvent["toolName"] === "string" ? providerEvent["toolName"] : undefined,
        toolInput: redactSecrets(asRecord(providerEvent["toolInput"]) ?? {}),
        expiresAt: typeof providerEvent["expiresAt"] === "string" ? providerEvent["expiresAt"] : undefined
      });
    }

    if (typeof type !== "string") {
      return undefined;
    }
    if (!isSupportedCodexType(type)) {
      return undefined;
    }

    const createdAt = new Date().toISOString();
    return codexEventToSwitchyardEvent(providerEvent, {
      runId,
      sequence,
      createdAt
    });
  }

  private makeEvent(runId: string, sequence: number, type: SwitchyardEvent["type"], payload: Record<string, unknown>): SwitchyardEvent {
    return {
      id: `event_${crypto.randomUUID()}`,
      type,
      runId,
      sequence,
      payload,
      createdAt: new Date().toISOString()
    };
  }
}

function isSupportedCodexType(type: string): boolean {
  return type === "thread.started" || type === "turn.started" || type === "turn.completed" || type === "turn.failed" || type === "error" || type.startsWith("item.");
}

function requiredString(value: unknown, field: string, reasonCode: string): string {
  if (typeof value !== "string") {
    throw new AdapterProtocolError(`${field} is required`, { reasonCode });
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

const SECRET_TEXT_PATTERN = /(sk-[A-Za-z0-9_-]+|authorization\\s*:\\s*bearer\\s+\\S+|apikey\\s*=\\s*\\S+|token\\s*=\\s*\\S+|password\\s*=\\s*\\S+|AKIA[0-9A-Z]{16})/i;

function redactSensitiveStrings<T>(value: T): T {
  if (typeof value === "string") {
    return (SECRET_TEXT_PATTERN.test(value) ? "[REDACTED]" : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveStrings(entry)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSensitiveStrings(entry);
    }
    return out as T;
  }
  return value;
}

class AsyncEventQueue {
  private readonly items: SwitchyardEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<SwitchyardEvent>) => void> = [];
  private closed = false;

  async push(event: SwitchyardEvent): Promise<void> {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    this.items.push(event);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ done: true, value: undefined });
    }
  }

  iterate(): AsyncIterable<SwitchyardEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<SwitchyardEvent>> => {
          if (this.items.length > 0) {
            const value = this.items.shift()!;
            return { done: false, value };
          }
          if (this.closed) {
            return { done: true, value: undefined };
          }
          return await new Promise((resolve) => {
            this.waiters.push(resolve);
          });
        }
      })
    };
  }
}
