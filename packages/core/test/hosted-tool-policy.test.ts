import { describe, expect, it } from "vitest";
import type { Approval, Run, SwitchyardEvent, ToolInvocation } from "@switchyard/contracts";
import { LocalPolicyGate, createDisabledRealToolPolicyConfig } from "../src/services/local-policy-gate.js";
import { HostedToolService } from "../src/services/hosted-tool-service.js";
import type { ApprovalStore } from "../src/ports/approval-store.js";
import type { EventStore } from "../src/ports/event-store.js";
import type { RunStore } from "../src/ports/run-store.js";
import type { ToolInvocationStore } from "../src/ports/tool-invocation-store.js";
import type { ToolDispatchOutboxStore } from "../src/ports/tool-dispatch-outbox-store.js";

class MemoryRunStore implements RunStore {
  readonly items = new Map<string, Run>();
  async create(value: Run): Promise<Run> { this.items.set(value.id, value); return value; }
  async get(id: string): Promise<Run | undefined> { return this.items.get(id); }
  async update(value: Run): Promise<Run> { this.items.set(value.id, value); return value; }
  async list() { return { runs: [...this.items.values()], nextCursor: null }; }
}

class MemoryApprovalStore implements ApprovalStore {
  readonly items = new Map<string, Approval>();
  async create(value: Approval): Promise<Approval> { this.items.set(value.id, value); return value; }
  async get(id: string): Promise<Approval | undefined> { return this.items.get(id); }
  async update(value: Approval): Promise<Approval> { this.items.set(value.id, value); return value; }
  async list() { return { approvals: [...this.items.values()], nextCursor: null }; }
  async updateIfStatus(id: string, expected: Approval["status"], value: Approval): Promise<Approval | null> {
    const current = this.items.get(id);
    if (!current || current.status !== expected) return null;
    this.items.set(id, value);
    return value;
  }
}

class MemoryInvocationStore implements ToolInvocationStore {
  readonly items = new Map<string, ToolInvocation>();
  async create(value: ToolInvocation): Promise<ToolInvocation> { this.items.set(value.id, value); return value; }
  async get(id: string): Promise<ToolInvocation | undefined> { return this.items.get(id); }
  async update(value: ToolInvocation): Promise<ToolInvocation> { this.items.set(value.id, value); return value; }
  async list() { return { invocations: [...this.items.values()], nextCursor: null }; }
  async listByApproval(approvalId: string): Promise<ToolInvocation[]> {
    return [...this.items.values()].filter((entry) => entry.approvalId === approvalId);
  }
  async updateIfStatus(id: string, expected: ToolInvocation["status"], value: ToolInvocation): Promise<ToolInvocation | null> {
    const current = this.items.get(id);
    if (!current || current.status !== expected) return null;
    this.items.set(id, value);
    return value;
  }
}

class MemoryEventStore implements EventStore {
  readonly items: SwitchyardEvent[] = [];
  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> { this.items.push(event); return event; }
  async listByRun(runId: string): Promise<SwitchyardEvent[]> { return this.items.filter((event) => event.runId === runId); }
  async listByDebate(): Promise<SwitchyardEvent[]> { return []; }
}

class MemoryOutboxStore implements ToolDispatchOutboxStore {
  async upsertByApprovalAndInvocation() { throw new Error("not used"); }
  async getByApprovalAndInvocation() { return undefined; }
  async markDispatching() { return undefined; }
  async markDispatched() { return undefined; }
  async markFailedRetryable() { return undefined; }
  async listRetryable() { return []; }
}

function makeRun(id: string, placement: Run["placement"]): Run {
  return {
    id,
    runtime: "fake",
    provider: "test",
    model: "test",
    adapterType: "process",
    cwd: "/repo",
    task: "task",
    status: "queued",
    placement,
    approvalPolicy: "default",
    timeoutSeconds: 60,
    metadata: {},
    createdAt: "2026-06-01T00:00:00.000Z"
  };
}

describe("hosted tool policy", () => {
  it("requires runId before any side effects", async () => {
    const service = new HostedToolService({
      runs: new MemoryRunStore(),
      approvals: new MemoryApprovalStore(),
      invocations: new MemoryInvocationStore(),
      events: new MemoryEventStore(),
      policy: new LocalPolicyGate(createDisabledRealToolPolicyConfig()),
      dispatchOutbox: new MemoryOutboxStore(),
      dispatch: async () => ({ dispatchId: "d_1", target: "hosted" })
    });

    await expect(service.invoke({
      type: "fetch",
      input: { url: "https://example.com", method: "GET" },
      target: { placement: "hosted" }
    })).rejects.toMatchObject({ code: "tool_run_required" });

    expect((service as any).deps.invocations.items.size).toBe(0);
    expect((service as any).deps.approvals.items.size).toBe(0);
  });

  it("returns mismatch when target placement differs from run placement", async () => {
    const runs = new MemoryRunStore();
    await runs.create(makeRun("run_1", "hosted"));
    const service = new HostedToolService({
      runs,
      approvals: new MemoryApprovalStore(),
      invocations: new MemoryInvocationStore(),
      events: new MemoryEventStore(),
      policy: new LocalPolicyGate(createDisabledRealToolPolicyConfig()),
      dispatchOutbox: new MemoryOutboxStore(),
      dispatch: async () => ({ dispatchId: "d_1", target: "hosted" })
    });

    await expect(service.invoke({
      runId: "run_1",
      type: "fetch",
      input: { url: "https://example.com", method: "GET" },
      target: { placement: "connected_local_node" }
    })).rejects.toMatchObject({ code: "tool_target_mismatch" });
  });

  it("denies browser and hosted repo before approval creation", async () => {
    const config = createDisabledRealToolPolicyConfig();
    const gate = new LocalPolicyGate({
      ...config,
      global: { ...config.global, enabled: true },
      hosted: { enabled: true, allowedToolTypes: ["fetch", "web_search", "github", "shell", "fake_echo"] },
      connectedLocalNode: { enabled: true, allowedToolTypes: ["fetch", "web_search", "github", "repo", "shell", "fake_echo"] }
    });

    const browser = await gate.decideTool({
      type: "browser",
      input: { action: "open", url: "https://example.com" },
      placement: "hosted"
    } as any);
    const repo = await gate.decideTool({
      type: "repo",
      input: { operation: "status", cwd: "/repo" },
      placement: "hosted"
    } as any);

    expect(browser.reasonCode).toBe("browser_tool_unshipped");
    expect(repo.reasonCode).toBe("repo_hosted_unshipped");
  });

  it("denies connected-node tools by default and shell raw fields", async () => {
    const gate = new LocalPolicyGate(createDisabledRealToolPolicyConfig());
    const shellBase = createDisabledRealToolPolicyConfig();
    const shellGate = new LocalPolicyGate({
      ...shellBase,
      global: {
        ...shellBase.global,
        enabled: true
      },
      hosted: { enabled: true, allowedToolTypes: ["shell"] },
      shell: {
        ...shellBase.shell,
        enabled: true
      }
    });
    const connected = await gate.decideTool({
      type: "fetch",
      input: { url: "https://example.com", method: "GET" },
      placement: "connected_local_node"
    } as any);
    const shell = await shellGate.decideTool({
      type: "shell",
      input: { commandId: "safe.cmd", cwd: "/repo", shell: "rm -rf /" },
      placement: "hosted"
    } as any);

    expect(connected.reasonCode).toBe("tool_connected_node_tools_disabled");
    expect(shell.reasonCode).toBe("shell_command_denied");
  });

  it("releases reserved quotas when post-policy admission persistence fails", async () => {
    class FailingInvocationStore extends MemoryInvocationStore {
      async create(): Promise<ToolInvocation> {
        throw new Error("invocation_persist_failed");
      }
    }

    const runs = new MemoryRunStore();
    await runs.create(makeRun("run_quota_rollback", "hosted"));
    const config = createDisabledRealToolPolicyConfig();
    const gate = new LocalPolicyGate({
      ...config,
      global: { ...config.global, enabled: true },
      hosted: { enabled: true, allowedToolTypes: ["fetch"] },
      fetch: { ...config.fetch, enabled: true, allowedHosts: ["example.com"] }
    });

    const released: Array<{ id: string; reasonCode: string }> = [];
    const service = new HostedToolService({
      runs,
      approvals: new MemoryApprovalStore(),
      invocations: new FailingInvocationStore(),
      events: new MemoryEventStore(),
      policy: gate,
      dispatchOutbox: new MemoryOutboxStore(),
      dispatch: async () => ({ dispatchId: "d_rollback", target: "hosted" }),
      preflight: {
        reservePostPolicyQuota: async () => ({
          hourlyReservationId: "quota_hourly_1",
          activeReservationId: "quota_active_1"
        }),
        releaseQuotaReservation: async (reservationId: string, reasonCode: string) => {
          released.push({ id: reservationId, reasonCode });
        }
      }
    });

    await expect(service.invoke({
      runId: "run_quota_rollback",
      type: "fetch",
      input: { url: "https://example.com/rollback", method: "GET" },
      target: { placement: "hosted" }
    })).rejects.toThrow("invocation_persist_failed");

    expect(released).toEqual([
      { id: "quota_active_1", reasonCode: "tool_admission_failed" },
      { id: "quota_hourly_1", reasonCode: "tool_admission_failed" }
    ]);
  });
});
