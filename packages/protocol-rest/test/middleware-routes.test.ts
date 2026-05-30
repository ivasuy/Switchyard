import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  AdapterProtocolError,
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
  approvalService: ApprovalService;
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

  return { app, fakeEcho, approvalService };
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

  it("returns explicit 404 middleware codes for unknown route resources and context references", async () => {
    const { app } = createHarness();
    try {
      const missingMessage = await app.inject({ method: "GET", url: "/messages/message_missing" });
      expect(missingMessage.statusCode).toBe(404);
      expect(missingMessage.json().error.code).toBe("message_not_found");

      const missingEvidence = await app.inject({ method: "GET", url: "/evidence/evidence_missing" });
      expect(missingEvidence.statusCode).toBe(404);
      expect(missingEvidence.json().error.code).toBe("evidence_not_found");

      const missingApproval = await app.inject({ method: "GET", url: "/approvals/approval_missing" });
      expect(missingApproval.statusCode).toBe(404);
      expect(missingApproval.json().error.code).toBe("approval_not_found");

      const missingInvocation = await app.inject({ method: "GET", url: "/tools/invocations/tool_missing" });
      expect(missingInvocation.statusCode).toBe(404);
      expect(missingInvocation.json().error.code).toBe("tool_invocation_not_found");

      const missingEvidenceContext = await app.inject({
        method: "POST",
        url: "/context",
        payload: {
          target: "run",
          evidenceIds: ["evidence_missing"]
        }
      });
      expect(missingEvidenceContext.statusCode).toBe(404);
      expect(missingEvidenceContext.json().error.code).toBe("evidence_not_found");

      const missingMessageContext = await app.inject({
        method: "POST",
        url: "/context",
        payload: {
          target: "run",
          messageIds: ["message_missing"]
        }
      });
      expect(missingMessageContext.statusCode).toBe(404);
      expect(missingMessageContext.json().error.code).toBe("message_not_found");
    } finally {
      await app.close();
    }
  });

  it("returns invalid_query for malformed middleware list filters", async () => {
    const { app } = createHarness();
    try {
      const malformedCursor = await app.inject({ method: "GET", url: "/messages?before=not-a-cursor" });
      expect(malformedCursor.statusCode).toBe(400);
      expect(malformedCursor.json().error.code).toBe("invalid_query");
      expect(malformedCursor.json().error.details?.[0]?.path).toBe("before");

      const invalidLimit = await app.inject({ method: "GET", url: "/memory?limit=0" });
      expect(invalidLimit.statusCode).toBe(400);
      expect(invalidLimit.json().error.code).toBe("invalid_query");
      expect(invalidLimit.json().error.details?.[0]?.path).toBe("limit");

      const tooLargeLimit = await app.inject({ method: "GET", url: "/memory?limit=201" });
      expect(tooLargeLimit.statusCode).toBe(400);
      expect(tooLargeLimit.json().error.code).toBe("invalid_query");
      expect(tooLargeLimit.json().error.details?.[0]?.path).toBe("limit");

      const invalidEnum = await app.inject({ method: "GET", url: "/tools/invocations?status=banana" });
      expect(invalidEnum.statusCode).toBe(400);
      expect(invalidEnum.json().error.code).toBe("invalid_query");
      expect(invalidEnum.json().error.details?.[0]?.path).toBe("status");
    } finally {
      await app.close();
    }
  });

  it("rejects unsafe evidence fetchedContentPath values", async () => {
    const { app } = createHarness();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/evidence",
        payload: {
          sourceType: "manual",
          title: "unsafe path",
          reliability: "primary",
          fetchedContentPath: "../outside.txt"
        }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_input");
      expect(response.json().error.details?.[0]?.path).toBe("fetchedContentPath");
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

  it("maps runtime sender adapter protocol failures on approve/reject to 409 adapter_protocol_failed", async () => {
    const { app, approvalService } = createHarness();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/approvals",
        payload: {
          runId: "run_1",
          approvalType: "before_external_message",
          payload: { runtimeApprovalToken: "pause-1" }
        }
      });
      expect(created.statusCode).toBe(201);
      const approvalId = created.json().approval.id as string;

      const protocolError = new AdapterProtocolError("pause closed", {
        reasonCode: "runtime_approval_pause_not_active"
      });
      const approveSpy = vi.spyOn(approvalService, "approve").mockRejectedValueOnce(protocolError);
      const rejectSpy = vi.spyOn(approvalService, "reject").mockRejectedValueOnce(protocolError);

      const approve = await app.inject({
        method: "POST",
        url: `/approvals/${approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      const reject = await app.inject({
        method: "POST",
        url: `/approvals/${approvalId}/reject`,
        payload: { actor: "local-user" }
      });

      expect(approveSpy).toHaveBeenCalledTimes(1);
      expect(rejectSpy).toHaveBeenCalledTimes(1);
      expect(approve.statusCode).toBe(409);
      expect(approve.json().error).toMatchObject({
        code: "adapter_protocol_failed",
        details: [{ path: "reasonCode", issue: "runtime_approval_pause_not_active" }]
      });
      expect(reject.statusCode).toBe(409);
      expect(reject.json().error).toMatchObject({
        code: "adapter_protocol_failed",
        details: [{ path: "reasonCode", issue: "runtime_approval_pause_not_active" }]
      });
    } finally {
      await app.close();
    }
  });
});
