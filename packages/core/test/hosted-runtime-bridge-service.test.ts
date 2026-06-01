import { describe, expect, it } from "vitest";
import type { Approval, AuthContext, HostedRuntimeBridgeCommand, Run, RuntimeSession } from "@switchyard/contracts";
import { HostedRuntimeBridgeService, HostedRuntimeBridgeServiceError } from "../src/services/hosted-runtime-bridge-service.js";
import type {
  CompleteHostedRuntimeBridgeCommandInput,
  CreateHostedRuntimeBridgeCommandInput,
  FailHostedRuntimeBridgeCommandInput,
  HostedRuntimeBridgeCommandStore
} from "../src/ports/hosted-runtime-bridge-command-store.js";
import type { ApprovalStore } from "../src/ports/approval-store.js";
import type { RunStore } from "../src/ports/run-store.js";
import type { SessionStore } from "../src/ports/session-store.js";

type HasListByRun = HostedRuntimeBridgeCommandStore extends { listByRun: (...args: never[]) => unknown } ? true : false;

class InMemoryHostedRuntimeBridgeCommandStore implements HostedRuntimeBridgeCommandStore {
  readonly items = new Map<string, HostedRuntimeBridgeCommand>();
  readonly byIdempotency = new Map<string, string>();

  async create(input: CreateHostedRuntimeBridgeCommandInput): Promise<{ command: HostedRuntimeBridgeCommand; duplicate: boolean }> {
    const existingId = this.byIdempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.items.get(existingId);
      if (!existing) {
        throw new Error("inconsistent_store");
      }
      if (existing.payloadHash !== input.payloadHash) {
        throw Object.assign(new Error("hosted_runtime_bridge_payload_mismatch"), {
          code: "hosted_runtime_bridge_payload_mismatch",
          commandId: existing.id
        });
      }
      return { command: existing, duplicate: true };
    }

    const now = input.now ?? "2026-06-01T00:00:00.000Z";
    const command: HostedRuntimeBridgeCommand = {
      id: `cmd_${this.items.size + 1}`,
      runId: input.runId,
      approvalId: input.approvalId,
      runtimeSessionId: input.runtimeSessionId,
      runtimeMode: input.runtimeMode,
      operation: input.operation,
      status: input.status ?? "queued",
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      redactedPayload: input.redactedPayload,
      payloadBytes: input.payloadBytes,
      accountId: input.accountId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      workerId: undefined,
      leaseUntil: undefined,
      attempts: input.attempts ?? 0,
      maxAttempts: input.maxAttempts,
      reasonCode: input.reasonCode,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now
    };
    this.items.set(command.id, command);
    this.byIdempotency.set(command.idempotencyKey, command.id);
    return { command, duplicate: false };
  }

  async get(id: string): Promise<HostedRuntimeBridgeCommand | undefined> {
    return this.items.get(id);
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<HostedRuntimeBridgeCommand | undefined> {
    const id = this.byIdempotency.get(idempotencyKey);
    return id ? this.items.get(id) : undefined;
  }

  async claimNext(input: { workerId: string; leaseMs: number; now?: string }): Promise<HostedRuntimeBridgeCommand | undefined> {
    const now = input.now ?? "2026-06-01T00:00:00.000Z";
    const candidate = [...this.items.values()]
      .filter((entry) => entry.status === "queued")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
    if (!candidate) {
      return undefined;
    }
    const leaseUntil = new Date(new Date(now).getTime() + input.leaseMs).toISOString();
    const claimed: HostedRuntimeBridgeCommand = {
      ...candidate,
      status: "claimed",
      workerId: input.workerId,
      leaseUntil,
      attempts: candidate.attempts + 1,
      updatedAt: now
    };
    this.items.set(claimed.id, claimed);
    return claimed;
  }

  async complete(input: CompleteHostedRuntimeBridgeCommandInput): Promise<HostedRuntimeBridgeCommand | null> {
    const current = this.items.get(input.commandId);
    if (!current || current.status !== "claimed" || current.workerId !== input.workerId) {
      return null;
    }
    const completed: HostedRuntimeBridgeCommand = {
      ...current,
      status: "completed",
      reasonCode: undefined,
      leaseUntil: undefined,
      updatedAt: input.now ?? "2026-06-01T00:00:00.000Z"
    };
    this.items.set(completed.id, completed);
    return completed;
  }

  async fail(input: FailHostedRuntimeBridgeCommandInput): Promise<HostedRuntimeBridgeCommand | null> {
    const current = this.items.get(input.commandId);
    if (!current || current.status !== "claimed") {
      return null;
    }
    if (input.workerId && current.workerId !== input.workerId) {
      return null;
    }
    const next: HostedRuntimeBridgeCommand = {
      ...current,
      status: input.retryable ? "queued" : "failed",
      reasonCode: input.reasonCode,
      workerId: input.retryable ? undefined : current.workerId,
      leaseUntil: undefined,
      updatedAt: input.now ?? "2026-06-01T00:00:00.000Z"
    };
    this.items.set(next.id, next);
    return next;
  }

  async expireStale(input: { now?: string } = {}): Promise<{ expired: number }> {
    const now = input.now ?? "2026-06-01T00:00:00.000Z";
    let expired = 0;
    for (const command of this.items.values()) {
      if (command.status === "queued" && command.expiresAt <= now) {
        this.items.set(command.id, {
          ...command,
          status: "expired",
          reasonCode: "hosted_runtime_bridge_command_expired",
          updatedAt: now
        });
        expired += 1;
      }
    }
    return { expired };
  }

  async recoverStaleClaims(input: { now?: string; nonIdempotentPolicy: "fail" | "retry_if_adapter_ack" }): Promise<{ recovered: number; failed: number }> {
    const now = input.now ?? "2026-06-01T00:00:00.000Z";
    let failed = 0;
    for (const command of this.items.values()) {
      if (command.status !== "claimed" || !command.leaseUntil || command.leaseUntil > now) {
        continue;
      }
      this.items.set(command.id, {
        ...command,
        status: "failed",
        reasonCode: "hosted_runtime_bridge_non_idempotent_retry_blocked",
        workerId: undefined,
        leaseUntil: undefined,
        updatedAt: now
      });
      failed += 1;
    }
    return { recovered: 0, failed };
  }
}

class MemoryRunStore implements RunStore {
  readonly items = new Map<string, Run>();
  async create(value: Run): Promise<Run> { this.items.set(value.id, value); return value; }
  async get(id: string): Promise<Run | undefined> { return this.items.get(id); }
  async update(value: Run): Promise<Run> { this.items.set(value.id, value); return value; }
  async list(): Promise<{ runs: Run[]; nextCursor: null }> { return { runs: [...this.items.values()], nextCursor: null }; }
}

class MemorySessionStore implements SessionStore {
  readonly items = new Map<string, RuntimeSession>();
  async create(value: RuntimeSession): Promise<RuntimeSession> { this.items.set(value.id, value); return value; }
  async get(id: string): Promise<RuntimeSession | undefined> { return this.items.get(id); }
  async update(value: RuntimeSession): Promise<RuntimeSession> { this.items.set(value.id, value); return value; }
  async list(): Promise<{ items: RuntimeSession[]; nextCursor: null }> { return { items: [...this.items.values()], nextCursor: null }; }
  async getByRunId(runId: string): Promise<RuntimeSession | undefined> {
    return [...this.items.values()].find((entry) => entry.runId === runId);
  }
}

class MemoryApprovalStore implements ApprovalStore {
  readonly items = new Map<string, Approval>();
  async create(value: Approval): Promise<Approval> { this.items.set(value.id, value); return value; }
  async get(id: string): Promise<Approval | undefined> { return this.items.get(id); }
  async update(value: Approval): Promise<Approval> { this.items.set(value.id, value); return value; }
  async list(filter: { runId?: string; status?: Approval["status"] } & Record<string, unknown>): Promise<{ approvals: Approval[]; nextCursor: null }> {
    const approvals = [...this.items.values()].filter((entry) => {
      if (filter.runId && entry.runId !== filter.runId) {
        return false;
      }
      if (filter.status && entry.status !== filter.status) {
        return false;
      }
      return true;
    });
    return { approvals, nextCursor: null };
  }
  async updateIfStatus(id: string, expectedStatus: Approval["status"], value: Approval): Promise<Approval | null> {
    const current = this.items.get(id);
    if (!current || current.status !== expectedStatus) {
      return null;
    }
    this.items.set(id, value);
    return value;
  }
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    runtime: "claude",
    provider: "anthropic",
    model: "sonnet",
    adapterType: "process",
    cwd: "/repo",
    task: "task",
    status: "running",
    placement: "hosted",
    approvalPolicy: "default",
    timeoutSeconds: 120,
    runtimeMode: "claude_code.sdk",
    metadata: {},
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

function makeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: "session_1",
    runId: "run_1",
    runtime: "claude",
    provider: "anthropic",
    model: "sonnet",
    protocol: "process",
    status: "active",
    runtimeMode: "claude_code.sdk",
    externalSessionKey: "external_1",
    state: {
      hostedWorkerId: "worker_a",
      hostedBridgeCapable: true,
      hostedRuntimeSessionId: "session_1"
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

function makeAuth(): AuthContext {
  return {
    account: { id: "account_1", slug: "account", displayName: "Account", status: "active", createdAt: "2026-06-01T00:00:00.000Z" },
    tenant: { id: "tenant_1", accountId: "account_1", slug: "tenant", displayName: "Tenant", status: "active", createdAt: "2026-06-01T00:00:00.000Z" },
    project: { id: "project_1", tenantId: "tenant_1", slug: "project", displayName: "Project", status: "active", createdAt: "2026-06-01T00:00:00.000Z" },
    user: { id: "user_1", accountId: "account_1", email: "user@example.com", displayName: "User", status: "active", createdAt: "2026-06-01T00:00:00.000Z" },
    apiKey: { id: "api_key_1", keyPrefix: "sk_sw", scopes: ["runs:write"], status: "active", createdAt: "2026-06-01T00:00:00.000Z" },
    entitlement: {
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      planId: "plan_1",
      planSlug: "plan",
      planDisplayName: "Plan",
      planStatus: "active",
      entitlements: {
        allowedPlacements: ["local", "hosted", "connected_local_node"],
        allowedRuntimeModes: ["claude_code.sdk", "opencode.acp"],
        allowHostedRealRuntime: true,
        allowConnectedNodes: true,
        allowArtifactContentRead: true,
        allowAuditRead: true,
        allowMetricsRead: true,
        allowToolExecution: true
      },
      quotas: {
        maxRunsPerHour: 1000,
        maxActiveRuns: 1000,
        maxRunTimeoutSeconds: 3600,
        maxConnectedNodes: 100,
        maxArtifactContentReadBytesPerHour: 10_000_000,
        maxToolInvocationsPerHour: 1000,
        maxActiveToolInvocations: 1000,
        maxToolArtifactBytesPerHour: 10_000_000,
        maxRuntimeBridgeCommandsPerHour: 1000,
        maxActiveRuntimeBridgeCommands: 1000
      },
      scopes: ["runs:write"],
      capturedAt: "2026-06-01T00:00:00.000Z"
    },
    authenticatedAt: "2026-06-01T00:00:00.000Z"
  };
}

describe("hosted runtime bridge service", () => {
  it("core port omits listByRun from the core interface", () => {
    const noListByRun: HasListByRun = false;
    expect(noListByRun).toBe(false);
  });

  it("rejects nil input body before quota or command writes", async () => {
    const runs = new MemoryRunStore();
    const sessions = new MemorySessionStore();
    const approvals = new MemoryApprovalStore();
    const commands = new InMemoryHostedRuntimeBridgeCommandStore();
    const quotaReserves: string[] = [];
    const runnerCalls: Array<Record<string, unknown>> = [];
    await runs.create(makeRun());
    await sessions.create(makeSession());

    const service = new HostedRuntimeBridgeService({
      runs,
      sessions,
      approvals,
      commands,
      runtimeRunner: {
        sendInput: async (runId: string, payload: Record<string, unknown>) => {
          runnerCalls.push({ runId, payload });
        }
      },
      preflight: {
        reserveBridgeQuota: async () => {
          quotaReserves.push("reserved");
          return { hourlyReservationId: "h_1", activeReservationId: "a_1" };
        }
      }
    });

    await expect(service.createInputCommand({
      runId: "run_1",
      body: undefined as unknown as Record<string, unknown>,
      auth: makeAuth()
    })).rejects.toMatchObject({ code: "invalid_input" } satisfies Partial<HostedRuntimeBridgeServiceError>);

    expect(commands.items.size).toBe(0);
    expect(quotaReserves).toHaveLength(0);
    expect(runnerCalls).toHaveLength(0);
  });

  it("handles idempotent duplicates and payload mismatch without double quota reserve", async () => {
    const runs = new MemoryRunStore();
    const sessions = new MemorySessionStore();
    const approvals = new MemoryApprovalStore();
    const commands = new InMemoryHostedRuntimeBridgeCommandStore();
    const runnerCalls: Array<Record<string, unknown>> = [];
    const quota = { reserved: 0 };
    await runs.create(makeRun());
    await sessions.create(makeSession());

    const service = new HostedRuntimeBridgeService({
      runs,
      sessions,
      approvals,
      commands,
      runtimeRunner: {
        sendInput: async (runId: string, payload: Record<string, unknown>) => {
          runnerCalls.push({ runId, payload });
        }
      },
      preflight: {
        reserveBridgeQuota: async () => {
          quota.reserved += 1;
          return { hourlyReservationId: `h_${quota.reserved}`, activeReservationId: `a_${quota.reserved}` };
        }
      }
    });

    const first = await service.createInputCommand({
      runId: "run_1",
      body: { text: "continue" },
      idempotencyKey: "idem_1",
      auth: makeAuth()
    });
    const second = await service.createInputCommand({
      runId: "run_1",
      body: { text: "continue" },
      idempotencyKey: "idem_1",
      auth: makeAuth()
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(first.commandId).toBe(second.commandId);
    expect(quota.reserved).toBe(1);
    expect(runnerCalls).toHaveLength(0);

    await expect(service.createInputCommand({
      runId: "run_1",
      body: { text: "different" },
      idempotencyKey: "idem_1",
      auth: makeAuth()
    })).rejects.toMatchObject({
      code: "adapter_protocol_failed",
      reasonCode: "hosted_runtime_bridge_payload_mismatch"
    } satisfies Partial<HostedRuntimeBridgeServiceError>);

    expect(quota.reserved).toBe(1);
  });

  it("hashes raw payload before redaction so secret-bearing inputs do not collide", async () => {
    const runs = new MemoryRunStore();
    const sessions = new MemorySessionStore();
    const approvals = new MemoryApprovalStore();
    const commands = new InMemoryHostedRuntimeBridgeCommandStore();
    await runs.create(makeRun());
    await sessions.create(makeSession());

    const service = new HostedRuntimeBridgeService({
      runs,
      sessions,
      approvals,
      commands,
      runtimeRunner: { sendInput: async () => undefined }
    });

    const one = await service.createInputCommand({
      runId: "run_1",
      body: { text: "Authorization: Bearer sk-secret-A" },
      idempotencyKey: "idem_secret_1",
      auth: makeAuth()
    });
    const two = await service.createInputCommand({
      runId: "run_1",
      body: { text: "Authorization: Bearer sk-secret-B" },
      idempotencyKey: "idem_secret_2",
      auth: makeAuth()
    });

    const first = await commands.get(one.commandId);
    const second = await commands.get(two.commandId);
    expect(first?.payloadHash).not.toBe(second?.payloadHash);
    expect(first?.redactedPayload).toEqual(second?.redactedPayload);
  });

  it("creates exactly one durable approval decision and supports same-key same-decision idempotency", async () => {
    const runs = new MemoryRunStore();
    const sessions = new MemorySessionStore();
    const approvals = new MemoryApprovalStore();
    const commands = new InMemoryHostedRuntimeBridgeCommandStore();
    await runs.create(makeRun({ runtimeMode: "opencode.acp" }));
    await sessions.create(makeSession({ runtimeMode: "opencode.acp" }));
    await approvals.create({
      id: "approval_1",
      runId: "run_1",
      approvalType: "before_external_message",
      status: "pending",
      payload: {
        runtimeApprovalToken: "request_1",
        runtimeSessionId: "session_1",
        runtimeMode: "opencode.acp",
        expiresAt: "2026-06-02T01:00:00.000Z"
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const service = new HostedRuntimeBridgeService({
      runs,
      sessions,
      approvals,
      commands,
      runtimeRunner: { sendInput: async () => undefined }
    });

    const [approve, reject] = await Promise.allSettled([
      service.resolveRuntimeApproval({
        approvalId: "approval_1",
        decision: "approved",
        idempotencyKey: "approval_idem",
        auth: makeAuth()
      }),
      service.resolveRuntimeApproval({
        approvalId: "approval_1",
        decision: "rejected",
        idempotencyKey: "approval_idem_other",
        auth: makeAuth()
      })
    ]);

    const fulfilled = [approve, reject].filter((entry): entry is PromiseFulfilledResult<{ commandId: string }> => entry.status === "fulfilled");
    const rejected = [approve, reject].filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "approval_not_pending" });

    const idempotentRetry = await service.resolveRuntimeApproval({
      approvalId: "approval_1",
      decision: "approved",
      idempotencyKey: "approval_idem",
      auth: makeAuth()
    });
    expect(idempotentRetry.duplicate).toBe(true);
    expect(idempotentRetry.commandId).toBe(fulfilled[0].value.commandId);
  });

  it("returns acp_permission_request_expired after expiry and does not queue resolution command", async () => {
    const runs = new MemoryRunStore();
    const sessions = new MemorySessionStore();
    const approvals = new MemoryApprovalStore();
    const commands = new InMemoryHostedRuntimeBridgeCommandStore();
    await runs.create(makeRun({ runtimeMode: "opencode.acp" }));
    await sessions.create(makeSession({ runtimeMode: "opencode.acp" }));
    await approvals.create({
      id: "approval_expired",
      runId: "run_1",
      approvalType: "before_external_message",
      status: "pending",
      payload: {
        runtimeApprovalToken: "request_expired",
        runtimeSessionId: "session_1",
        runtimeMode: "opencode.acp",
        expiresAt: "2026-05-31T23:59:59.000Z"
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const service = new HostedRuntimeBridgeService({
      runs,
      sessions,
      approvals,
      commands,
      runtimeRunner: { sendInput: async () => undefined },
      now: () => "2026-06-01T00:00:00.000Z"
    });

    await expect(service.resolveRuntimeApproval({
      approvalId: "approval_expired",
      decision: "approved",
      auth: makeAuth()
    })).rejects.toMatchObject({
      code: "adapter_protocol_failed",
      reasonCode: "acp_permission_request_expired"
    } satisfies Partial<HostedRuntimeBridgeServiceError>);

    expect(commands.items.size).toBe(0);
  });

  it("worker apply verifies ownership and only worker path calls sendInput", async () => {
    const runs = new MemoryRunStore();
    const sessions = new MemorySessionStore();
    const approvals = new MemoryApprovalStore();
    const commands = new InMemoryHostedRuntimeBridgeCommandStore();
    const runnerCalls: Array<Record<string, unknown>> = [];
    await runs.create(makeRun());
    await sessions.create(makeSession({ state: { hostedWorkerId: "worker_b", hostedBridgeCapable: true } }));

    const service = new HostedRuntimeBridgeService({
      runs,
      sessions,
      approvals,
      commands,
      runtimeRunner: {
        sendInput: async (runId: string, payload: Record<string, unknown>) => {
          runnerCalls.push({ runId, payload });
        }
      }
    });

    await service.createInputCommand({
      runId: "run_1",
      body: { text: "continue" },
      idempotencyKey: "idem_worker_mismatch",
      auth: makeAuth()
    });
    expect(runnerCalls).toHaveLength(0);

    const applied = await service.claimAndApplyNext({ workerId: "worker_a", leaseMs: 5_000 });
    expect(applied).toBe(true);
    expect(runnerCalls).toHaveLength(0);

    const command = await commands.getByIdempotencyKey("idem_worker_mismatch");
    expect(command?.status).toBe("failed");
    expect(command?.reasonCode).toBe("hosted_runtime_bridge_session_not_owned");
  });

  it("reconciliation blocks non-idempotent stale retries and terminalizes stuck waiting approvals", async () => {
    const runs = new MemoryRunStore();
    const sessions = new MemorySessionStore();
    const approvals = new MemoryApprovalStore();
    const commands = new InMemoryHostedRuntimeBridgeCommandStore();
    await runs.create(makeRun({ id: "run_waiting", status: "waiting_for_approval" }));
    await sessions.create(makeSession({
      runId: "run_waiting",
      state: {}
    }));
    await approvals.create({
      id: "approval_waiting",
      runId: "run_waiting",
      approvalType: "before_external_message",
      status: "pending",
      payload: {
        runtimeApprovalToken: "pause_1",
        runtimeSessionId: "session_1",
        runtimeMode: "claude_code.sdk"
      },
      createdAt: "2026-06-01T00:00:00.000Z"
    });

    const created = await commands.create({
      runId: "run_waiting",
      runtimeSessionId: "session_1",
      runtimeMode: "claude_code.sdk",
      operation: "input",
      idempotencyKey: "idem_stale",
      payloadHash: "hash_stale",
      payloadBytes: 42,
      redactedPayload: { kind: "input", content: "continue", redacted: true },
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      userId: "user_1",
      apiKeyId: "api_key_1",
      maxAttempts: 3,
      expiresAt: "2026-06-01T10:00:00.000Z"
    });
    await commands.claimNext({
      workerId: "worker_a",
      leaseMs: 1,
      now: "2026-06-01T00:00:00.000Z"
    });
    const claimed = await commands.get(created.command.id);
    commands.items.set(created.command.id, {
      ...claimed!,
      leaseUntil: "2026-05-31T23:59:59.000Z",
      status: "claimed",
      workerId: "worker_a"
    });

    const service = new HostedRuntimeBridgeService({
      runs,
      sessions,
      approvals,
      commands,
      runtimeRunner: { sendInput: async () => undefined },
      now: () => "2026-06-01T00:00:00.000Z"
    });

    const reconciled = await service.reconcileHostedRuntimeSessions({ workerId: "worker_a", now: "2026-06-01T00:00:00.000Z" });
    expect(reconciled.failed).toBeGreaterThanOrEqual(1);

    const stale = await commands.getByIdempotencyKey("idem_stale");
    expect(stale?.status).toBe("failed");
    expect(stale?.reasonCode).toBe("hosted_runtime_bridge_non_idempotent_retry_blocked");

    const run = await runs.get("run_waiting");
    expect(run?.status).toBe("failed");
    expect((run?.metadata as Record<string, unknown>)["reasonCode"]).toBe("hosted_runtime_session_lost");
    const approval = await approvals.get("approval_waiting");
    expect(approval?.status).toBe("rejected");
  });
});
