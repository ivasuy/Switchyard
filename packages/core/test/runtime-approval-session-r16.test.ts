import { describe, expect, it, vi } from "vitest";
import type { Approval, Run, RuntimeSession, SwitchyardEvent } from "@switchyard/contracts";
import {
  AdapterProtocolError,
  ApprovalService,
  RuntimeRunnerService,
  type ApprovalStore,
  type EventStore,
  type RunStore,
  type RuntimeAdapter,
  type RuntimeAdapterCheck,
  type RuntimeAdapterManifest,
  type RuntimeStartResult,
  type RuntimeLogger,
  type SessionStore
} from "../src/index.js";

type Cursor = { createdAt: string; id: string };

class MemoryRunStore implements RunStore {
  readonly items = new Map<string, Run>();

  async create(run: Run): Promise<Run> {
    this.items.set(run.id, run);
    return run;
  }

  async get(id: string): Promise<Run | undefined> {
    return this.items.get(id);
  }

  async update(run: Run): Promise<Run> {
    this.items.set(run.id, run);
    return run;
  }

  async list(filter: {
    status?: readonly string[];
    runtime?: readonly string[];
    provider?: readonly string[];
    model?: readonly string[];
    placement?: readonly string[];
    adapterType?: readonly string[];
    since?: string;
    until?: string;
    limit: number;
    before?: Cursor;
  }) {
    let rows = [...this.items.values()].sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));
    if (filter.status) rows = rows.filter((row) => filter.status?.includes(row.status));
    if (filter.before) {
      rows = rows.filter((row) => row.createdAt < filter.before!.createdAt || (row.createdAt === filter.before!.createdAt && row.id < filter.before!.id));
    }
    const page = rows.slice(0, filter.limit);
    const next = rows.length > filter.limit ? page.at(-1) : undefined;
    return {
      runs: page,
      nextCursor: next ? { createdAt: next.createdAt, id: next.id } : null
    };
  }
}

class MemoryEventStore implements EventStore {
  readonly items: SwitchyardEvent[] = [];

  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> {
    this.items.push(event);
    return event;
  }

  async listByRun(runId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((entry) => entry.runId === runId).sort((a, b) => a.sequence - b.sequence);
  }

  async listByDebate(debateId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((entry) => entry.debateId === debateId).sort((a, b) => a.sequence - b.sequence);
  }
}

class MemorySessionStore implements SessionStore {
  readonly items = new Map<string, RuntimeSession>();

  async create(session: RuntimeSession): Promise<RuntimeSession> {
    this.items.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<RuntimeSession | undefined> {
    return this.items.get(id);
  }

  async update(session: RuntimeSession): Promise<RuntimeSession> {
    this.items.set(session.id, session);
    return session;
  }

  async getByRunId(runId: string): Promise<RuntimeSession | undefined> {
    return [...this.items.values()].find((entry) => entry.runId === runId);
  }
}

class MemoryApprovalStore implements ApprovalStore {
  readonly items = new Map<string, Approval>();

  async create(value: Approval): Promise<Approval> {
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<Approval | undefined> {
    return this.items.get(id);
  }

  async update(value: Approval): Promise<Approval> {
    this.items.set(value.id, value);
    return value;
  }

  async updateIfStatus(id: string, expectedStatus: Approval["status"], value: Approval): Promise<Approval | null> {
    const existing = this.items.get(id);
    if (!existing || existing.status !== expectedStatus) {
      return null;
    }
    this.items.set(id, value);
    return value;
  }

  async list(filter: {
    runId?: string;
    status?: Approval["status"];
    approvalType?: Approval["approvalType"];
    limit: number;
    before?: Cursor;
  }) {
    let approvals = [...this.items.values()].sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));
    if (filter.runId) approvals = approvals.filter((entry) => entry.runId === filter.runId);
    if (filter.status) approvals = approvals.filter((entry) => entry.status === filter.status);
    if (filter.approvalType) approvals = approvals.filter((entry) => entry.approvalType === filter.approvalType);
    if (filter.before) {
      approvals = approvals.filter((entry) => entry.createdAt < filter.before!.createdAt || (entry.createdAt === filter.before!.createdAt && entry.id < filter.before!.id));
    }
    const page = approvals.slice(0, filter.limit);
    const next = approvals.length > filter.limit ? page.at(-1) : undefined;
    return {
      approvals: page,
      nextCursor: next ? { createdAt: next.createdAt, id: next.id } : null
    };
  }
}

class CapturingLogger implements RuntimeLogger {
  readonly calls: Array<{ level: "info" | "warn" | "error"; event: string; payload?: Record<string, unknown> }> = [];

  info(event: string, payload?: Record<string, unknown>): void {
    this.calls.push({ level: "info", event, payload });
  }

  warn(event: string, payload?: Record<string, unknown>): void {
    this.calls.push({ level: "warn", event, payload });
  }

  error(event: string, payload?: Record<string, unknown>): void {
    this.calls.push({ level: "error", event, payload });
  }
}

class PlannedAdapter implements RuntimeAdapter {
  readonly id = "fake";
  readonly manifest: RuntimeAdapterManifest = {
    adapterId: "fake",
    providerId: "provider_test",
    runtimeId: "runtime_fake",
    runtimeModeId: "runtime_mode_fake_deterministic",
    runtimeModeSlug: "fake.deterministic",
    name: "Fake runtime",
    adapterType: "process",
    kind: "deterministic_fake",
    capabilities: ["run.start", "run.input", "run.cancel", "event.normalized", "event.streaming", "artifact.transcript", "auth.none"],
    limitations: [],
    placement: {
      local: { support: "supported", reason: "local" },
      hosted: { support: "unsupported", reason: "hosted" },
      connectedLocalNode: { support: "future", reason: "future" }
    },
    check: { strategy: "none", required: [], optional: [] }
  };

  startError?: Error;
  startedRequests: Array<Record<string, unknown>> = [];
  sentSessions: Array<Record<string, unknown>> = [];
  sentInputs: Array<Record<string, unknown>> = [];
  cancelCalls = 0;
  sendGate?: { promise: Promise<void>; resolve: () => void };

  constructor(private readonly plannedEvents: SwitchyardEvent[] = []) {}

  async check(): Promise<RuntimeAdapterCheck> {
    return { ok: true };
  }

  async start(request: Record<string, unknown>): Promise<RuntimeStartResult> {
    this.startedRequests.push(request);
    if (this.startError) {
      throw this.startError;
    }
    return { sessionId: "session_1" };
  }

  async send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void> {
    this.sentSessions.push({ ...session });
    this.sentInputs.push({ ...input });
    if (this.sendGate) {
      await this.sendGate.promise;
    }
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }

  async *events(_session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    for (const event of this.plannedEvents) {
      yield event;
    }
  }

  async tools(): Promise<string[]> {
    return [];
  }

  async artifacts(): Promise<never[]> {
    return [];
  }
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? "run_1",
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "task",
    status: "queued",
    placement: "local",
    approvalPolicy: "default",
    timeoutSeconds: 1,
    metadata: {},
    runtimeMode: "codex.interactive",
    createdAt: "2026-05-30T00:00:00.000Z",
    ...overrides
  };
}

function runtimeEvent(type: SwitchyardEvent["type"], sequence: number, payload: Record<string, unknown>): SwitchyardEvent {
  return {
    id: `event_${sequence}`,
    type,
    runId: "run_1",
    sequence,
    payload,
    createdAt: "2026-05-30T00:00:00.000Z"
  };
}

describe("runtime approval + session R16", () => {
  it("persists AdapterProtocolError reasonCode on startup failure", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const adapter = new PlannedAdapter();
    adapter.startError = new AdapterProtocolError("unsupported", {
      reasonCode: "codex_interactive_driver_unsupported"
    });
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", adapter]])
    });
    const run = makeRun();
    await runs.create(run);
    await events.append(runtimeEvent("run.queued", 0, {}));

    const result = await runner.start(run);

    expect(result.status).toBe("failed");
    expect(events.items.at(-1)).toMatchObject({
      type: "run.failed",
      payload: {
        error: "unsupported",
        reasonCode: "codex_interactive_driver_unsupported"
      }
    });
  });

  it("includes runtimeMode in adapter send session", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const adapter = new PlannedAdapter();
    const run = makeRun({ status: "running" });
    await runs.create(run);
    await sessions.create({
      id: "session_1",
      runId: run.id,
      runtime: run.runtime,
      provider: run.provider,
      model: run.model,
      protocol: run.adapterType,
      status: "active",
      state: {},
      runtimeMode: "codex.interactive",
      createdAt: "2026-05-30T00:00:00.000Z"
    } as RuntimeSession);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", adapter]])
    });

    await runner.sendInput(run.id, { text: "continue" });

    expect(adapter.sentSessions[0]?.["runtimeMode"]).toBe("codex.interactive");
  });

  it("sets codexThreadId externalSessionKey once and ignores nil/empty patches", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const adapter = new PlannedAdapter([
      runtimeEvent("runtime.status", 1, { status: "running", sessionStatePatch: null }),
      runtimeEvent("runtime.status", 2, { status: "running", sessionStatePatch: {} }),
      runtimeEvent("runtime.status", 3, { status: "running", sessionStatePatch: { codexThreadId: "thread_1" } }),
      runtimeEvent("runtime.status", 4, { status: "running", sessionStatePatch: { codexThreadId: "thread_2", nested: { ok: true } } }),
      runtimeEvent("run.completed", 5, { status: "completed" })
    ]);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", adapter]])
    });
    const run = makeRun();
    await runs.create(run);
    await events.append(runtimeEvent("run.queued", 0, {}));

    await runner.start(run);

    const stored = await sessions.getByRunId(run.id);
    expect(stored?.state["codexThreadId"]).toBe("thread_2");
    expect(stored?.externalSessionKey).toBe("thread_1");
  });

  it("rejects invalid approval expiresAt and creates runtime approval payload enrichment", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const approvals: Array<{ runId: string; approvalType: string; payload: Record<string, unknown> }> = [];
    const badAdapter = new PlannedAdapter([
      runtimeEvent("approval.requested", 1, {
        runtimeApprovalToken: "pause-1",
        approvalType: "before_external_message",
        expiresAt: "not-a-date"
      })
    ]);
    const goodAdapter = new PlannedAdapter([
      runtimeEvent("approval.requested", 1, {
        runtimeApprovalToken: "pause-1",
        approvalType: "before_external_message",
        expiresAt: "2026-05-31T00:00:00.000Z"
      }),
      runtimeEvent("run.completed", 2, { status: "completed" })
    ]);

    const badRunner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", badAdapter]]),
      runtimeApprovals: {
        create: async (input) => {
          approvals.push(input);
        }
      }
    });
    const run = makeRun();
    await runs.create(run);
    await events.append(runtimeEvent("run.queued", 0, {}));

    const bad = await badRunner.start(run);
    expect(bad.status).toBe("failed");
    expect(events.items.at(-1)).toMatchObject({ payload: { reasonCode: "runtime_approval_expires_at_invalid" } });
    expect(approvals).toHaveLength(0);

    const run2 = makeRun({ id: "run_2" });
    await runs.create(run2);
    await events.append({ ...runtimeEvent("run.queued", 0, {}), runId: run2.id });
    const goodRunner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", goodAdapter]]),
      runtimeApprovals: {
        create: async (input) => {
          approvals.push(input);
        }
      }
    });
    await goodRunner.start(run2);

    expect(approvals.at(-1)?.payload).toMatchObject({
      runtimeApprovalToken: "pause-1",
      runtimeMode: "codex.interactive",
      runtimeSessionId: "session_1",
      expiresAt: "2026-05-31T00:00:00.000Z"
    });
  });

  it("rejects concurrent input while send is in flight", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    let resolveGate = () => {};
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const adapter = new PlannedAdapter();
    adapter.sendGate = { promise: gate, resolve: resolveGate };
    const run = makeRun({ status: "running" });
    await runs.create(run);
    await sessions.create({
      id: "session_1",
      runId: run.id,
      runtime: run.runtime,
      provider: run.provider,
      model: run.model,
      protocol: run.adapterType,
      status: "active",
      state: {},
      runtimeMode: "codex.interactive",
      createdAt: "2026-05-30T00:00:00.000Z"
    } as RuntimeSession);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", adapter]])
    });

    const first = runner.sendInput(run.id, { text: "first" });
    await Promise.resolve();
    await expect(runner.sendInput(run.id, { text: "second" })).rejects.toMatchObject({
      reasonCode: "runtime_input_in_flight"
    });
    resolveGate();
    await first;
    expect(adapter.sentInputs).toHaveLength(1);
  });

  it("omits runtime.output raw text from logger payload", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const sessions = new MemorySessionStore();
    const logger = new CapturingLogger();
    const secretText = "sk-test-secret authorization: Bearer fake apiKey=abc token=123 password=456 AKIA1111111111111111";
    const adapter = new PlannedAdapter([
      runtimeEvent("runtime.output", 1, { text: secretText }),
      runtimeEvent("run.completed", 2, { status: "completed" })
    ]);
    const runner = new RuntimeRunnerService({
      runs,
      events,
      sessions,
      adapters: new Map([["fake", adapter]]),
      logger
    });
    const run = makeRun();
    await runs.create(run);
    await events.append(runtimeEvent("run.queued", 0, {}));

    await runner.start(run);

    const outputLog = logger.calls.find((entry) => entry.event === "runtime.output");
    expect(outputLog?.payload?.["text"]).toBeUndefined();
    expect(outputLog?.payload?.["redacted"]).toBe(true);
    const serialized = JSON.stringify(outputLog?.payload ?? {});
    expect(serialized).not.toContain("sk-test-secret");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("password");
  });

  it("expires runtime approvals with injected scheduler and startup reconciliation", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const approvals = new MemoryApprovalStore();
    const sent: Array<Record<string, unknown>> = [];
    const now = new Date("2026-05-31T00:00:00.000Z");
    const handles = new Set<ReturnType<typeof setTimeout>>();
    const scheduler = {
      setTimeout: (fn: () => void, ms: number) => {
        const handle = setTimeout(() => {
          handles.delete(handle);
          fn();
        }, ms);
        handles.add(handle);
        return handle;
      },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
        handles.delete(handle);
        clearTimeout(handle);
      }
    };
    const service = new ApprovalService({
      approvals,
      runs,
      events,
      runtimeResolutionSender: async (input) => {
        sent.push(input as unknown as Record<string, unknown>);
      },
      clock: () => new Date(now.getTime()),
      scheduler
    });
    const run = makeRun();
    await runs.create(run);

    const created = await service.create({
      runId: run.id,
      approvalType: "before_external_message",
      payload: {
        runtimeApprovalToken: "pause-1",
        expiresAt: "2026-05-30T23:59:59.000Z"
      }
    });
    const afterImmediate = await approvals.get(created.id);
    expect(afterImmediate?.status).toBe("expired");

    const pending = await service.create({
      runId: run.id,
      approvalType: "before_external_message",
      payload: {
        runtimeApprovalToken: "pause-2",
        expiresAt: "2026-05-31T00:00:10.000Z"
      }
    });
    now.setTime(Date.parse("2026-05-31T00:00:11.000Z"));
    const reconciled = await service.expirePendingRuntimeApprovals();
    expect(reconciled.expired).toBeGreaterThanOrEqual(1);
    expect((await approvals.get(pending.id))?.status).toBe("expired");
    expect(sent.some((entry) => entry["decision"] === "rejected")).toBe(true);
    expect(handles.size).toBe(0);
  });

  it("terminalizes pending runtime approvals for timeout/cancel/failure and stale sender keeps terminal status", async () => {
    const runs = new MemoryRunStore();
    const events = new MemoryEventStore();
    const approvals = new MemoryApprovalStore();
    const run = makeRun();
    await runs.create(run);
    const service = new ApprovalService({
      approvals,
      runs,
      events,
      runtimeResolutionSender: async () => {
        throw new AdapterProtocolError("pause closed", {
          reasonCode: "runtime_approval_pause_not_active"
        });
      }
    });

    const first = await service.create({
      runId: run.id,
      approvalType: "before_external_message",
      payload: { runtimeApprovalToken: "pause-1" }
    });
    const timedOut = await service.terminalizePendingRuntimeApprovalsForRun(run.id, {
      terminalEvent: "run.timeout",
      approvalStatus: "expired",
      message: "expired by Switchyard"
    });
    expect(timedOut.expired).toBeGreaterThanOrEqual(1);
    expect((await approvals.get(first.id))?.status).toBe("expired");

    const second = await service.create({
      runId: run.id,
      approvalType: "before_external_message",
      payload: { runtimeApprovalToken: "pause-2" }
    });
    const rejected = await service.terminalizePendingRuntimeApprovalsForRun(run.id, {
      terminalEvent: "run.failed",
      approvalStatus: "rejected",
      message: "run failed"
    });
    expect(rejected.rejected).toBeGreaterThanOrEqual(1);
    expect((await approvals.get(second.id))?.status).toBe("rejected");

    await expect(service.approve(second.id, { actor: "user" })).rejects.toMatchObject({
      code: "approval_not_pending"
    });
  });
});
