export interface ClaudeCodeProviderEvent {
  type: string;
  [key: string]: unknown;
}

export interface ClaudeCodeClientSession {
  readonly sessionId?: string;
  readonly processId?: number;
  events(): AsyncIterable<ClaudeCodeProviderEvent>;
  sendUserMessage(text: string): Promise<void>;
  resolveApproval(input: {
    runtimeApprovalToken: string;
    decision: "approved" | "rejected";
    message: string;
    answers?: Record<string, unknown>;
  }): Promise<void>;
  cancel(): Promise<void>;
}

export interface ClaudeCodeClient {
  start(input: {
    runId: string;
    cwd: string;
    task: string;
    metadata: Record<string, unknown>;
  }): Promise<ClaudeCodeClientSession>;
}

export interface FakeClaudeCodeScenario {
  initialEvents?: ClaudeCodeProviderEvent[];
  waitForInputText?: boolean;
  approvalToken?: string;
  terminalState?: "completed" | "failed";
  sendUserMessageError?: string;
  resolveApprovalError?: string;
  resolveApprovalDelayMs?: number;
  malformedStream?: boolean;
  includeUnknownEvents?: number;
}

export interface FakeClaudeCodeClientState {
  sentUserMessages: string[];
  resolvedApprovals: Array<{
    runtimeApprovalToken: string;
    decision: "approved" | "rejected";
    message: string;
    answers?: Record<string, unknown>;
  }>;
  cancelled: boolean;
  terminalState: "active" | "completed" | "failed" | "cancelled";
  sendUserMessageFailures: string[];
  resolveApprovalFailures: string[];
  resolveApprovalCalls: number;
  liveProbeCalls: Array<{ maxBudgetUsd: number; permissionMode: string; disabledTools: string[] }>;
}

export function createFakeClaudeCodeClient(scenario: FakeClaudeCodeScenario = {}): {
  client: ClaudeCodeClient;
  state: FakeClaudeCodeClientState;
} {
  const state: FakeClaudeCodeClientState = {
    sentUserMessages: [],
    resolvedApprovals: [],
    cancelled: false,
    terminalState: "active",
    sendUserMessageFailures: [],
    resolveApprovalFailures: [],
    resolveApprovalCalls: 0,
    liveProbeCalls: []
  };

  const client: ClaudeCodeClient = {
    async start(): Promise<ClaudeCodeClientSession> {
      const queue = createQueue();
      let terminal = false;
      const approvalToken = scenario.approvalToken;

      queueMicrotask(() => {
        for (const event of scenario.initialEvents ?? []) {
          queue.push(event);
          if (event.type === "completed") {
            terminal = true;
            state.terminalState = "completed";
          }
          if (event.type === "failed") {
            terminal = true;
            state.terminalState = "failed";
          }
          if (event.type === "cancelled") {
            terminal = true;
            state.terminalState = "cancelled";
          }
        }
        const unknownCount = scenario.includeUnknownEvents ?? 0;
        for (let index = 0; index < unknownCount; index += 1) {
          queue.push({ type: `unknown_${index}` });
        }

        if (scenario.terminalState === "completed" && !terminal) {
          queue.push({ type: "completed", usage: { inputTokens: 1, outputTokens: 1 } });
          queue.close();
          terminal = true;
          state.terminalState = "completed";
          return;
        }
        if (scenario.terminalState === "failed" && !terminal) {
          queue.push({ type: "failed", reasonCode: "claude_fake_terminal_failed" });
          queue.close();
          terminal = true;
          state.terminalState = "failed";
          return;
        }

        if (!scenario.waitForInputText && !approvalToken) {
          queue.push({ type: "completed", usage: { inputTokens: 1, outputTokens: 2 } });
          queue.close();
          terminal = true;
          state.terminalState = "completed";
          return;
        }

        if (approvalToken) {
          queue.push({
            type: "approval_required",
            token: approvalToken,
            approvalType: "before_destructive_command",
            toolName: "Bash",
            toolInput: { command: "rm tmp.txt" }
          });
        }
      });

      return {
        sessionId: `session_${crypto.randomUUID()}`,
        processId: 9999,
        events: () => queue.iterate(),
        async sendUserMessage(text: string) {
          if (scenario.sendUserMessageError) {
            state.sendUserMessageFailures.push(scenario.sendUserMessageError);
            throw new Error(scenario.sendUserMessageError);
          }
          state.sentUserMessages.push(text);
          if (!terminal && scenario.waitForInputText) {
            queue.push({ type: "assistant_text_delta", text: `echo:${text}` });
            queue.push({ type: "completed", usage: { inputTokens: 1, outputTokens: 2 } });
            queue.close();
            terminal = true;
            state.terminalState = "completed";
          }
        },
        async resolveApproval(input) {
          state.resolveApprovalCalls += 1;
          if (typeof scenario.resolveApprovalDelayMs === "number" && scenario.resolveApprovalDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, scenario.resolveApprovalDelayMs));
          }
          if (scenario.resolveApprovalError) {
            state.resolveApprovalFailures.push(scenario.resolveApprovalError);
            throw new Error(scenario.resolveApprovalError);
          }
          state.resolvedApprovals.push(input);
          if (!terminal) {
            if (input.decision === "rejected") {
              queue.push({ type: "failed", reasonCode: "provider_denied" });
              state.terminalState = "failed";
            } else {
              queue.push({ type: "completed", usage: { inputTokens: 1, outputTokens: 2 } });
              state.terminalState = "completed";
            }
            queue.close();
            terminal = true;
          }
        },
        async cancel() {
          state.cancelled = true;
          if (!terminal) {
            queue.push({ type: "cancelled" });
            queue.close();
            terminal = true;
            state.terminalState = "cancelled";
          }
        }
      };
    }
  };

  return { client, state };
}

export function createFakeClaudeLiveProbe(state: FakeClaudeCodeClientState) {
  return async (input: { maxBudgetUsd: number; permissionMode: string; disabledTools: string[] }) => {
    state.liveProbeCalls.push(input);
    return { ok: true };
  };
}

function createQueue() {
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
      if (done) return;
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
