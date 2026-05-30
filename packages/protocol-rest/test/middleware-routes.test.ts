import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import {
  ApprovalService,
  ContextBuilder,
  EventBus,
  EvidenceService,
  LocalPolicyGate,
  MemoryService,
  MessageRouter,
  ToolRouter
} from "@switchyard/core";
import {
  FakeEchoToolAdapter,
  InMemoryApprovalStore,
  InMemoryEvidenceStore,
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryMessageStore,
  InMemoryRunStore,
  InMemoryToolInvocationStore
} from "@switchyard/testkit";
import { registerErrorEnvelope, registerMiddlewareRoutes } from "../src/index.js";

function makeRun(id: string, approvalPolicy = "default") {
  return {
    id,
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process" as const,
    cwd: "/repo",
    task: "task",
    status: "queued" as const,
    placement: "local" as const,
    approvalPolicy,
    timeoutSeconds: 60,
    metadata: {},
    createdAt: "2026-05-30T00:00:00.000Z"
  };
}

type Harness = {
  app: FastifyInstance;
  fakeEcho: FakeEchoToolAdapter;
};

function createHarness(): Harness {
  const app = Fastify();
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const messages = new InMemoryMessageStore();
  const memory = new InMemoryMemoryStore();
  const evidence = new InMemoryEvidenceStore();
  const approvals = new InMemoryApprovalStore();
  const invocations = new InMemoryToolInvocationStore();
  const eventBus = new EventBus();
  const fakeEcho = new FakeEchoToolAdapter();
  const policy = new LocalPolicyGate();

  void runs.create(makeRun("run_1"));

  const messageRouter = new MessageRouter({ runs, messages, events, eventBus });
  const memoryService = new MemoryService({ memory });
  const evidenceService = new EvidenceService({ evidence });
  const contextBuilder = new ContextBuilder({ memory, evidence, messages });
  const toolRouter = new ToolRouter({
    runs,
    events,
    approvals,
    invocations,
    eventBus,
    adapters: new Map([["fake_echo", fakeEcho]]),
    policy
  });
  const approvalService = new ApprovalService({ approvals, runs, events, eventBus, toolRouter });

  registerErrorEnvelope(app);
  registerMiddlewareRoutes(app, {
    messageRouter,
    memoryService,
    evidenceService,
    contextBuilder,
    approvalService,
    toolRouter
  });

  return { app, fakeEcho };
}

describe("middleware routes", () => {
  it("creates and lists messages", async () => {
    const { app } = createHarness();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/messages",
        payload: {
          fromRunId: "run_1",
          channel: "chan",
          content: "hello"
        }
      });
      expect(created.statusCode).toBe(201);

      const list = await app.inject({ method: "GET", url: "/messages?channel=chan" });
      expect(list.statusCode).toBe(200);
      expect(list.json().messages).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("rejects embeddings in POST /memory and resolves /memory/search without route shadowing", async () => {
    const { app } = createHarness();
    try {
      const rejected = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          scope: "project",
          content: "one",
          embedding: [0.1, 0.2]
        }
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe("invalid_input");

      await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          scope: "project",
          content: "Case Sensitive"
        }
      });
      const search = await app.inject({ method: "GET", url: "/memory/search?q=sensitive" });
      expect(search.statusCode).toBe(200);
      expect(search.json().memory).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("returns memory_not_found from context build on missing references", async () => {
    const { app } = createHarness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/context",
        payload: {
          target: "run",
          memoryIds: ["memory_missing"]
        }
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("memory_not_found");
    } finally {
      await app.close();
    }
  });

  it("returns 403 tool_policy_denied for real tools and never invokes fake adapter", async () => {
    const { app, fakeEcho } = createHarness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: {
          runId: "run_1",
          type: "shell",
          input: { text: "rm -rf /" }
        }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("tool_policy_denied");
      expect(fakeEcho.invocationCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("supports approval-required fake_echo and one-shot approve transitions", async () => {
    const { app } = createHarness();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: {
          runId: "run_1",
          type: "fake_echo",
          input: {
            text: "hello",
            requiresApproval: true
          }
        }
      });
      expect(created.statusCode).toBe(202);

      const approvalId = created.json().approval.id as string;
      const first = await app.inject({
        method: "POST",
        url: `/approvals/${approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().invocation.status).toBe("completed");

      const second = await app.inject({
        method: "POST",
        url: `/approvals/${approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe("approval_not_pending");
    } finally {
      await app.close();
    }
  });
});
