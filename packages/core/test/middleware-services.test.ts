import { describe, expect, it } from "vitest";
import type { Approval, EvidenceItem, MemoryItem, RoutedMessage, Run, SwitchyardEvent, ToolInvocation } from "@switchyard/contracts";
import type {
  ApprovalStore,
  EvidenceStore,
  ListApprovalsFilter,
  ListApprovalsResult,
  ListEvidenceFilter,
  ListEvidenceResult,
  ListMemoryFilter,
  ListMemoryResult,
  ListMessagesFilter,
  ListMessagesResult,
  ListToolInvocationsFilter,
  ListToolInvocationsResult,
  MemoryStore,
  MessageStore,
  RunStore,
  ToolInvocationStore
} from "../src/index.js";
import { EventBus } from "../src/services/event-bus.js";
import { ApprovalService } from "../src/services/approval-service.js";
import { ContextBuilder } from "../src/services/context-builder.js";
import { EvidenceService } from "../src/services/evidence-service.js";
import { LocalPolicyGate } from "../src/services/local-policy-gate.js";
import { MemoryService } from "../src/services/memory-service.js";
import { MessageRouter } from "../src/services/message-router.js";
import { ToolRouter } from "../src/services/tool-router.js";
import type { EventStore } from "../src/ports/event-store.js";
import type { ToolAdapter } from "../src/ports/tool-adapter.js";
import { AdapterProtocolError } from "../src/errors.js";

function makeRun(id: string, approvalPolicy = "default"): Run {
  return {
    id,
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "task",
    status: "queued",
    placement: "local",
    approvalPolicy,
    timeoutSeconds: 60,
    metadata: {},
    createdAt: "2026-05-30T00:00:00.000Z"
  };
}

class InMemoryRunStore implements RunStore {
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
  async list(): Promise<never> {
    throw new Error("unused");
  }
}

class InMemoryEventStore implements EventStore {
  readonly items: SwitchyardEvent[] = [];
  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> {
    this.items.push(event);
    return event;
  }
  async listByRun(runId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((event) => event.runId === runId);
  }
}

class InMemoryMessageStore implements MessageStore {
  readonly items = new Map<string, RoutedMessage>();
  async create(value: RoutedMessage): Promise<RoutedMessage> {
    this.items.set(value.id, value);
    return value;
  }
  async get(id: string): Promise<RoutedMessage | undefined> {
    return this.items.get(id);
  }
  async update(value: RoutedMessage): Promise<RoutedMessage> {
    this.items.set(value.id, value);
    return value;
  }
  async list(filter: ListMessagesFilter): Promise<ListMessagesResult> {
    const messages = [...this.items.values()].filter((item) => {
      if (filter.runId && item.fromRunId !== filter.runId && item.toRunId !== filter.runId) return false;
      if (filter.channel && item.channel !== filter.channel) return false;
      if (filter.deliveryStatus && item.deliveryStatus !== filter.deliveryStatus) return false;
      return true;
    });
    return { messages, nextCursor: null };
  }
}

class InMemoryMemoryStore implements MemoryStore {
  readonly items = new Map<string, MemoryItem>();
  async create(value: MemoryItem): Promise<MemoryItem> {
    this.items.set(value.id, value);
    return value;
  }
  async get(id: string): Promise<MemoryItem | undefined> {
    return this.items.get(id);
  }
  async update(value: MemoryItem): Promise<MemoryItem> {
    this.items.set(value.id, value);
    return value;
  }
  async list(filter: ListMemoryFilter): Promise<ListMemoryResult> {
    const memory = [...this.items.values()].filter((item) => {
      if (filter.scope && item.scope !== filter.scope) return false;
      return true;
    });
    return { memory, nextCursor: null };
  }
  async search(filter: ListMemoryFilter & { q: string }): Promise<ListMemoryResult> {
    const q = filter.q.toLowerCase();
    const memory = [...this.items.values()].filter((item) => item.content.toLowerCase().includes(q));
    return { memory, nextCursor: null };
  }
}

class InMemoryEvidenceStore implements EvidenceStore {
  readonly items = new Map<string, EvidenceItem>();
  async create(value: EvidenceItem): Promise<EvidenceItem> {
    this.items.set(value.id, value);
    return value;
  }
  async get(id: string): Promise<EvidenceItem | undefined> {
    return this.items.get(id);
  }
  async update(value: EvidenceItem): Promise<EvidenceItem> {
    this.items.set(value.id, value);
    return value;
  }
  async list(_filter: ListEvidenceFilter): Promise<ListEvidenceResult> {
    return { evidence: [...this.items.values()], nextCursor: null };
  }
}

class InMemoryApprovalStore implements ApprovalStore {
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
  async list(_filter: ListApprovalsFilter): Promise<ListApprovalsResult> {
    return { approvals: [...this.items.values()], nextCursor: null };
  }
}

class InMemoryToolInvocationStore implements ToolInvocationStore {
  readonly items = new Map<string, ToolInvocation>();
  async create(value: ToolInvocation): Promise<ToolInvocation> {
    this.items.set(value.id, value);
    return value;
  }
  async get(id: string): Promise<ToolInvocation | undefined> {
    return this.items.get(id);
  }
  async update(value: ToolInvocation): Promise<ToolInvocation> {
    this.items.set(value.id, value);
    return value;
  }
  async updateIfStatus(
    id: string,
    expectedStatus: ToolInvocation["status"],
    value: ToolInvocation
  ): Promise<ToolInvocation | null> {
    const existing = this.items.get(id);
    if (!existing || existing.status !== expectedStatus) {
      return null;
    }
    this.items.set(id, value);
    return value;
  }
  async list(_filter: ListToolInvocationsFilter): Promise<ListToolInvocationsResult> {
    return { invocations: [...this.items.values()], nextCursor: null };
  }
  async listByApproval(approvalId: string): Promise<ToolInvocation[]> {
    return [...this.items.values()].filter((item) => item.approvalId === approvalId);
  }
}

class SnapshotApprovalStore extends InMemoryApprovalStore {
  async get(id: string): Promise<Approval | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }
}

class SnapshotToolInvocationStore extends InMemoryToolInvocationStore {
  async get(id: string): Promise<ToolInvocation | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async update(value: ToolInvocation): Promise<ToolInvocation> {
    // Yield once to amplify concurrent queued->running transitions.
    await Promise.resolve();
    this.items.set(value.id, structuredClone(value));
    return value;
  }

  async listByApproval(approvalId: string): Promise<ToolInvocation[]> {
    return [...this.items.values()]
      .filter((item) => item.approvalId === approvalId)
      .map((item) => structuredClone(item));
  }
}

class FakeEchoToolAdapter implements ToolAdapter {
  readonly id = "fake_echo";
  invocationCount = 0;
  async check() {
    return { ok: true };
  }
  async invoke(input: Record<string, unknown>) {
    this.invocationCount += 1;
    if (typeof input["text"] !== "string") {
      throw new Error("missing text");
    }
    return { echo: input["text"] as string };
  }
  async cancel(): Promise<void> {}
  async artifacts() {
    return [];
  }
}

class DelayedFakeEchoToolAdapter extends FakeEchoToolAdapter {
  async invoke(input: Record<string, unknown>) {
    await Promise.resolve();
    return super.invoke(input);
  }
}

describe("middleware services", () => {
  it("routes messages, validates destination runs, and emits message.sent", async () => {
    const runs = new InMemoryRunStore();
    await runs.create(makeRun("run_from"));
    await runs.create(makeRun("run_to"));
    const messages = new InMemoryMessageStore();
    const events = new InMemoryEventStore();
    const eventBus = new EventBus();
    const seen: string[] = [];
    eventBus.subscribe(async (event) => {
      seen.push(event.type);
    });

    const router = new MessageRouter({ runs, messages, events, eventBus });
    const created = await router.create({
      fromRunId: "run_from",
      toRunId: "run_to",
      content: "hello",
      attachments: []
    });

    expect(created.deliveryStatus).toBe("delivered");
    expect(created.deliveredAt).toBeDefined();
    expect((await router.list({ limit: 50 })).messages).toHaveLength(1);
    expect(seen).toContain("message.sent");
  });

  it("supports substring-only memory search", async () => {
    const memory = new InMemoryMemoryStore();
    const service = new MemoryService({ memory });
    await service.create({ scope: "project", content: "Switchyard Middleware Foundation", metadata: {} });
    await service.create({ scope: "project", content: "Other", metadata: {} });

    const result = await service.search({ q: "middleWARE", limit: 50 });
    expect(result.memory).toHaveLength(1);
    expect(result.memory[0]?.content).toContain("Middleware");
  });

  it("builds deterministic context sections in explicit/memory/evidence/messages order", async () => {
    const memory = new InMemoryMemoryStore();
    const evidence = new InMemoryEvidenceStore();
    const messages = new InMemoryMessageStore();

    const memoryRecord = await memory.create({
      id: "memory_123",
      scope: "project",
      content: "memory one",
      metadata: {},
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    const evidenceRecord = await evidence.create({
      id: "evidence_123",
      sourceType: "manual",
      title: "evidence one",
      snippet: "snippet",
      reliability: "primary",
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    const messageRecord = await messages.create({
      id: "message_123",
      content: "message one",
      deliveryStatus: "delivered",
      attachments: [],
      createdAt: "2026-05-30T00:00:00.000Z",
      deliveredAt: "2026-05-30T00:00:00.000Z"
    });

    const builder = new ContextBuilder({ memory, evidence, messages });
    const built = await builder.build({
      target: "run",
      sections: [{ name: "operator", content: "explicit section" }],
      memoryIds: [memoryRecord.id],
      evidenceIds: [evidenceRecord.id],
      messageIds: [messageRecord.id]
    });

    expect(built.context.sections.map((section) => section.name)).toEqual(["operator", "memory", "evidence", "messages"]);
    expect(built.rendered.length).toBeGreaterThan(0);
  });

  it("denies real tools before adapter dispatch", async () => {
    const runs = new InMemoryRunStore();
    const run = makeRun("run_real_tool");
    await runs.create(run);
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const fakeEcho = new FakeEchoToolAdapter();
    const policy = new LocalPolicyGate();

    const router = new ToolRouter({
      runs,
      events,
      approvals,
      invocations,
      adapters: new Map([["fake_echo", fakeEcho]]),
      policy
    });

    await expect(
      router.invoke({
        runId: run.id,
        type: "shell",
        input: { text: "rm -rf" }
      })
    ).rejects.toMatchObject({ code: "tool_policy_denied" });

    expect(fakeEcho.invocationCount).toBe(0);
  });

  it("resolves approval-gated fake tool exactly once", async () => {
    const runs = new InMemoryRunStore();
    const run = makeRun("run_approval");
    await runs.create(run);
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const invocations = new InMemoryToolInvocationStore();
    const fakeEcho = new FakeEchoToolAdapter();
    const policy = new LocalPolicyGate();
    const toolRouter = new ToolRouter({
      runs,
      events,
      approvals,
      invocations,
      adapters: new Map([["fake_echo", fakeEcho]]),
      policy
    });
    const approvalService = new ApprovalService({ approvals, runs, events, toolRouter });

    const queued = await toolRouter.invoke({
      runId: run.id,
      type: "fake_echo",
      input: {
        text: "secret",
        requiresApproval: true,
        token: "abc"
      }
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.approval?.status).toBe("pending");
    expect(queued.invocation.status).toBe("queued");

    const firstApprovalId = queued.approval?.id;
    if (!firstApprovalId) {
      throw new Error("approval id missing");
    }

    const approved = await approvalService.approve(firstApprovalId, {
      actor: "local-user",
      reason: "ok"
    });
    expect(approved.invocation?.status).toBe("completed");

    await expect(approvalService.approve(firstApprovalId, { actor: "local-user" })).rejects.toMatchObject({
      code: "approval_not_pending"
    });

    const runEvents = await events.listByRun(run.id);
    const toolResultEvents = runEvents.filter((event) => event.type === "tool.result");
    expect(toolResultEvents).toHaveLength(1);
    expect(JSON.stringify(queued.invocation.input)).not.toContain("abc");
    expect(JSON.stringify(queued.invocation.input)).toContain("[REDACTED]");
  });

  it("allows only one concurrent approval resolution and persists one terminal tool.result", async () => {
    const runs = new InMemoryRunStore();
    const run = makeRun("run_concurrent_approval");
    await runs.create(run);
    const events = new InMemoryEventStore();
    const approvals = new SnapshotApprovalStore();
    const invocations = new SnapshotToolInvocationStore();
    const fakeEcho = new DelayedFakeEchoToolAdapter();
    const policy = new LocalPolicyGate();
    const toolRouter = new ToolRouter({
      runs,
      events,
      approvals,
      invocations,
      adapters: new Map([["fake_echo", fakeEcho]]),
      policy
    });
    const approvalService = new ApprovalService({ approvals, runs, events, toolRouter });

    const queued = await toolRouter.invoke({
      runId: run.id,
      type: "fake_echo",
      input: {
        text: "one-shot",
        requiresApproval: true
      }
    });
    expect(queued.statusCode).toBe(202);

    const approvalId = queued.approval?.id;
    if (!approvalId) {
      throw new Error("approval id missing");
    }

    const [first, second] = await Promise.allSettled([
      approvalService.approve(approvalId, { actor: "actor-1" }),
      approvalService.approve(approvalId, { actor: "actor-2" })
    ]);

    const successes = [first, second].filter((result) => result.status === "fulfilled");
    const failures = [first, second].filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    if (failures[0]?.status === "rejected") {
      expect(failures[0].reason).toMatchObject({ code: "approval_not_pending" });
    }

    const terminal = await invocations.list({ runId: run.id, status: "completed", limit: 10 });
    expect(terminal.invocations).toHaveLength(1);
    expect(fakeEcho.invocationCount).toBe(1);

    const runEvents = await events.listByRun(run.id);
    const toolResults = runEvents.filter((event) => event.type === "tool.result");
    expect(toolResults).toHaveLength(1);
  });

  it("sends runtime approval_resolution payloads through optional runtime sender", async () => {
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const run = makeRun("run_runtime_approval");
    await runs.create(run);
    const sent: Array<Record<string, unknown>> = [];
    const service = new ApprovalService({
      approvals,
      runs,
      events,
      runtimeResolutionSender: async (input) => {
        sent.push(input);
      }
    });

    const created = await service.create({
      runId: run.id,
      approvalType: "before_external_message",
      payload: {
        runtimeApprovalToken: "pause-1",
        responseFormat: "ask_user_question"
      }
    });

    const resolved = await service.approve(created.id, {
      actor: "local-user",
      reason: "Option A",
      answers: { option: "A" }
    });

    expect(resolved.approval.status).toBe("approved");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "approval_resolution",
      approvalId: created.id,
      runId: run.id,
      runtimeApprovalToken: "pause-1",
      decision: "approved",
      message: "Option A",
      answers: { option: "A" }
    });
  });

  it("keeps runtime approvals resolved even when runtime resolution sender fails", async () => {
    const runs = new InMemoryRunStore();
    const events = new InMemoryEventStore();
    const approvals = new InMemoryApprovalStore();
    const run = makeRun("run_runtime_approval_failed_sender");
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

    const created = await service.create({
      runId: run.id,
      approvalType: "before_external_message",
      payload: { runtimeApprovalToken: "pause-1" }
    });

    await expect(service.reject(created.id, { actor: "local-user" })).rejects.toMatchObject({
      code: "adapter_protocol_failed",
      reasonCode: "runtime_approval_pause_not_active"
    });
    await expect(service.reject(created.id, { actor: "local-user" })).rejects.toMatchObject({
      code: "approval_not_pending"
    });
  });
});
