import { AdapterProtocolError } from "@switchyard/core";

export type FakeCodexInteractiveScenarioKind =
  | "default"
  | "terminal_completion"
  | "missing_token"
  | "stale_token"
  | "approval_requested"
  | "approval_denied"
  | "approval_expired"
  | "unsupported_approval_bridge"
  | "malformed_stream"
  | "active_timeout"
  | "cancel_while_streaming"
  | "cancel_while_waiting_for_input"
  | "cancel_while_waiting_for_approval"
  | "double_resume"
  | "transcript_truncation"
  | "secret_redaction";

export interface FakeCodexInteractiveScenario {
  kind?: FakeCodexInteractiveScenarioKind;
  approvalToken?: string;
  threadId?: string;
}

export interface CodexInteractiveDriverCheckLike {
  ok: boolean;
  availability: {
    state: "available" | "partial" | "unavailable" | "installed";
    canRun: boolean;
    installed: boolean;
    auth: "configured" | "missing" | "not_required" | "unknown";
    version: string | null;
    checkedAt: string;
    reasonCode: string | null;
    message: string | null;
  };
  diagnostics?: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
}

export type CodexInteractiveProviderEventLike = Record<string, unknown>;

export interface CodexInteractiveTurnLike {
  readonly startedAt: string;
  threadId?: string;
  waitForInput?: boolean;
  waitingForApproval?: boolean;
  terminalStatus?: "completed" | "failed";
  terminalReasonCode?: string;
  events(): AsyncIterable<CodexInteractiveProviderEventLike>;
}

export interface CodexInteractiveSessionFactoryLike {
  check(input: { command: string; timeoutMs?: number; maxDiagnosticBytes?: number; runtimeMode?: string }): Promise<CodexInteractiveDriverCheckLike>;
  startTurn(input: { runId: string; cwd: string; task: string; metadata?: Record<string, unknown> }): Promise<CodexInteractiveTurnLike>;
  resumeTurn(input: { runId: string; cwd: string; codexThreadId?: string; text: string; metadata?: Record<string, unknown> }): Promise<CodexInteractiveTurnLike>;
  resolveApproval(input: { runId: string; codexThreadId?: string; runtimeApprovalToken: string; decision: "approved" | "rejected"; message: string }): Promise<void>;
  cancel(input: { runId: string; codexThreadId?: string }): Promise<void>;
}

export interface FakeCodexInteractiveState {
  starts: Array<{ runId: string; cwd: string; taskBytes: number }>;
  resumes: Array<{ runId: string; codexThreadId?: string; textBytes: number }>;
  resolvedApprovals: Array<{ runtimeApprovalToken: string; decision: "approved" | "rejected"; messageBytes: number }>;
  cancelled: Array<{ runId: string; codexThreadId?: string }>;
  prompts: Array<{ kind: "start" | "resume"; textBytes: number; redacted: true }>;
  commands: string[];
  rawInputs: Array<{ kind: "text" | "approval"; bytes: number; redacted: true }>;
  checkCalls: Array<{ command: string; runtimeMode?: string }>;
  liveProviderCalls: Array<{ kind: string }>;
  inFlightResume: boolean;
  releasedResumes: number;
  releaseHeldResume: () => void;
}

export function createFakeCodexInteractiveSessionFactory(
  scenario: FakeCodexInteractiveScenario = {}
): {
  factory: CodexInteractiveSessionFactoryLike;
  state: FakeCodexInteractiveState;
} {
  const kind = scenario.kind ?? "default";
  const threadId = scenario.threadId ?? "thread_1";
  const approvalToken = scenario.approvalToken ?? "pause-1";

  let releaseHeldResume = () => {};
  let heldResumePromise: Promise<void> | undefined;
  let heldResumeActive = false;
  let cancelled = false;
  let pendingApprovalToken: string | undefined;

  const state: FakeCodexInteractiveState = {
    starts: [],
    resumes: [],
    resolvedApprovals: [],
    cancelled: [],
    prompts: [],
    commands: [],
    rawInputs: [],
    checkCalls: [],
    liveProviderCalls: [],
    inFlightResume: false,
    releasedResumes: 0,
    releaseHeldResume: () => releaseHeldResume()
  };

  const factory: CodexInteractiveSessionFactoryLike = {
    async check(input) {
      state.checkCalls.push({
        command: input.command,
        ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {})
      });
      if (kind === "unsupported_approval_bridge") {
        return {
          ok: true,
          availability: {
            state: "partial",
            canRun: true,
            installed: true,
            auth: "configured",
            version: "fake-codex-1.0.0",
            checkedAt: "2026-05-30T00:00:00.000Z",
            reasonCode: "codex_approval_bridge_unsupported",
            message: "approval bridge unsupported"
          }
        };
      }
      return {
        ok: true,
        availability: {
          state: "available",
          canRun: true,
          installed: true,
          auth: "configured",
          version: "fake-codex-1.0.0",
          checkedAt: "2026-05-30T00:00:00.000Z",
          reasonCode: null,
          message: null
        },
        diagnostics: [{ code: "fake_no_spend", severity: "info", message: "no provider calls" }]
      };
    },

    async startTurn(input) {
      state.starts.push({ runId: input.runId, cwd: input.cwd, taskBytes: Buffer.byteLength(input.task, "utf8") });
      state.prompts.push({ kind: "start", textBytes: Buffer.byteLength(input.task, "utf8"), redacted: true });
      state.rawInputs.push({ kind: "text", bytes: Buffer.byteLength(input.task, "utf8"), redacted: true });
      cancelled = false;

      if (kind === "approval_requested" || kind === "approval_denied" || kind === "approval_expired" || kind === "cancel_while_waiting_for_approval") {
        pendingApprovalToken = approvalToken;
        return turnFromRecords([
          { type: "thread.started", thread_id: threadId },
          { type: "approval.requested", runtimeApprovalToken: approvalToken, approvalType: "before_external_message", summary: "needs approval" }
        ], {
          startedAt: "2026-05-30T00:00:00.000Z",
          threadId,
          waitingForApproval: true
        });
      }

      if (kind === "malformed_stream") {
        return turnFromRecords([
          { type: "thread.started", thread_id: threadId },
          { type: 123 as unknown as string }
        ], {
          startedAt: "2026-05-30T00:00:00.000Z",
          threadId
        });
      }

      if (kind === "active_timeout" || kind === "cancel_while_streaming") {
        return {
          startedAt: "2026-05-30T00:00:00.000Z",
          threadId,
          waitForInput: false,
          async *events() {
            yield { type: "thread.started", thread_id: threadId };
            yield { type: "item.completed", item: { type: "agent_message", text: "streaming" } };
            await new Promise<void>((resolve) => {
              heldResumePromise = Promise.resolve();
              releaseHeldResume = () => {
                state.releasedResumes += 1;
                resolve();
              };
            });
            if (!cancelled) {
              yield { type: "turn.completed" };
            }
          }
        };
      }

      if (kind === "terminal_completion") {
        return turnFromRecords([
          { type: "thread.started", thread_id: threadId },
          { type: "item.completed", item: { type: "agent_message", text: "done" } },
          { type: "turn.completed" }
        ], {
          startedAt: "2026-05-30T00:00:00.000Z",
          threadId,
          terminalStatus: "completed"
        });
      }

      if (kind === "transcript_truncation") {
        const long = "L".repeat(1024 * 1024 + 2048);
        return turnFromRecords([
          { type: "thread.started", thread_id: threadId },
          { type: "item.completed", item: { type: "agent_message", text: long } }
        ], {
          startedAt: "2026-05-30T00:00:00.000Z",
          threadId,
          waitForInput: true
        });
      }

      if (kind === "secret_redaction") {
        return turnFromRecords([
          { type: "thread.started", thread_id: threadId },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "apiKey=abc authorization: Bearer fake token=123 password=456 AKIA1111111111111111"
            }
          }
        ], {
          startedAt: "2026-05-30T00:00:00.000Z",
          threadId,
          waitForInput: true
        });
      }

      const startThread = kind === "missing_token"
        ? { type: "thread.started" }
        : { type: "thread.started", thread_id: threadId };
      return turnFromRecords([
        startThread,
        { type: "item.completed", item: { type: "agent_message", text: "hello" } }
      ], {
        startedAt: "2026-05-30T00:00:00.000Z",
        ...(kind === "missing_token" ? {} : { threadId }),
        waitForInput: true
      });
    },

    async resumeTurn(input) {
      state.resumes.push({
        runId: input.runId,
        ...(input.codexThreadId ? { codexThreadId: input.codexThreadId } : {}),
        textBytes: Buffer.byteLength(input.text, "utf8")
      });
      state.prompts.push({ kind: "resume", textBytes: Buffer.byteLength(input.text, "utf8"), redacted: true });
      state.rawInputs.push({ kind: "text", bytes: Buffer.byteLength(input.text, "utf8"), redacted: true });

      if (!input.codexThreadId || input.codexThreadId.trim().length === 0) {
        throw new AdapterProtocolError("Missing codex thread id", { reasonCode: "codex_resume_token_missing" });
      }
      if (kind === "stale_token") {
        throw new AdapterProtocolError("Stale codex thread id", { reasonCode: "codex_resume_session_stale" });
      }
      if (kind === "double_resume") {
        if (heldResumeActive) {
          throw new AdapterProtocolError("Resume in flight", { reasonCode: "runtime_input_in_flight" });
        }
        heldResumeActive = true;
        await new Promise<void>((resolve) => {
          releaseHeldResume = () => {
            heldResumeActive = false;
            state.releasedResumes += 1;
            resolve();
          };
        });
      }

      if (cancelled) {
        throw new AdapterProtocolError("Runtime cancelled", { reasonCode: "runtime_input_not_active" });
      }

      return turnFromRecords([
        { type: "thread.started", thread_id: input.codexThreadId },
        { type: "item.completed", item: { type: "agent_message", text: "[REDACTED_RESUME_OUTPUT]" } }
      ], {
        startedAt: "2026-05-30T00:00:01.000Z",
        threadId: input.codexThreadId,
        waitForInput: true
      });
    },

    async resolveApproval(input) {
      state.resolvedApprovals.push({
        runtimeApprovalToken: input.runtimeApprovalToken,
        decision: input.decision,
        messageBytes: Buffer.byteLength(input.message, "utf8")
      });
      state.rawInputs.push({ kind: "approval", bytes: Buffer.byteLength(input.message, "utf8"), redacted: true });

      if (kind === "unsupported_approval_bridge") {
        throw new AdapterProtocolError("approval bridge unsupported", { reasonCode: "codex_approval_bridge_unsupported" });
      }
      if (!pendingApprovalToken || pendingApprovalToken !== input.runtimeApprovalToken) {
        throw new AdapterProtocolError("Runtime approval pause is not active", { reasonCode: "runtime_approval_pause_not_active" });
      }
      pendingApprovalToken = undefined;
      if (kind === "approval_denied" || (kind === "approval_requested" && input.decision === "rejected")) {
        throw new AdapterProtocolError("provider denied", { reasonCode: "provider_denied" });
      }
      if (kind === "cancel_while_waiting_for_approval" && cancelled) {
        throw new AdapterProtocolError("Runtime approval pause is not active", { reasonCode: "runtime_approval_pause_not_active" });
      }
    },

    async cancel(input) {
      state.cancelled.push({
        runId: input.runId,
        ...(input.codexThreadId ? { codexThreadId: input.codexThreadId } : {})
      });
      cancelled = true;
      pendingApprovalToken = undefined;
      if (kind === "double_resume" && heldResumeActive) {
        releaseHeldResume();
      }
      if (kind === "active_timeout" && heldResumePromise) {
        releaseHeldResume();
      }
    }
  };

  return { factory, state };
}

function turnFromRecords(
  records: Array<Record<string, unknown>>,
  input: {
    startedAt: string;
    threadId?: string;
    waitForInput?: boolean;
    waitingForApproval?: boolean;
    terminalStatus?: "completed" | "failed";
    terminalReasonCode?: string;
  }
): CodexInteractiveTurnLike {
  const turn: CodexInteractiveTurnLike = {
    startedAt: input.startedAt,
    async *events() {
      for (const record of records) {
        yield record;
      }
    }
  };
  if (input.threadId !== undefined) turn.threadId = input.threadId;
  if (input.waitForInput !== undefined) turn.waitForInput = input.waitForInput;
  if (input.waitingForApproval !== undefined) turn.waitingForApproval = input.waitingForApproval;
  if (input.terminalStatus !== undefined) turn.terminalStatus = input.terminalStatus;
  if (input.terminalReasonCode !== undefined) turn.terminalReasonCode = input.terminalReasonCode;
  return turn;
}
