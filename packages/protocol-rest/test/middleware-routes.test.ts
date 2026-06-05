import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createDisabledRealToolPolicyConfig,
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

type ScenarioToolAdapter = {
  id: string;
  invocationCount: number;
  check: () => Promise<{ ok: boolean; message?: string }>;
  invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  cancel: () => Promise<void>;
  artifacts: () => Promise<[]>;
};

type RealToolHarness = Harness & {
  fetchAdapter: ScenarioToolAdapter;
  webSearchAdapter: ScenarioToolAdapter;
  githubAdapter: ScenarioToolAdapter;
  repoAdapter: ScenarioToolAdapter;
  shellAdapter: ScenarioToolAdapter;
  approvals: InMemoryApprovalStore;
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

function createScenarioAdapter(
  id: string,
  resolver: (input: Record<string, unknown>) => Record<string, unknown>
): ScenarioToolAdapter {
  return {
    id,
    invocationCount: 0,
    async check() {
      return { ok: true };
    },
    async invoke(input) {
      this.invocationCount += 1;
      return resolver(input);
    },
    async cancel() {
      return;
    },
    async artifacts() {
      return [];
    }
  };
}

function createRealToolHarness(): RealToolHarness {
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

  const fetchAdapter = createScenarioAdapter("fetch", (input) => {
    const plan = ((input["executionPlan"] ?? {}) as Record<string, unknown>);
    const url = String(plan["url"] ?? "");
    if (url.includes("timeout")) {
      throw new AdapterProtocolError("fetch timeout", { reasonCode: "tool_upstream_timeout" });
    }
    if (url.includes("oversize")) {
      throw new AdapterProtocolError("fetch too large", { reasonCode: "tool_output_limit_exceeded" });
    }
    if (url.includes("failure")) {
      throw new AdapterProtocolError("upstream 500", { reasonCode: "tool_upstream_unavailable" });
    }
    return {
      summary: {
        status: 200,
        authToken: "secret-fetch-token"
      },
      inlineOutput: {
        authorization: "Bearer topsecret",
        url: "https://example.com/path?token=topsecret"
      }
    };
  });

  const webSearchAdapter = createScenarioAdapter("web_search", (input) => {
    const plan = ((input["executionPlan"] ?? {}) as Record<string, unknown>);
    const query = String(plan["query"] ?? "");
    if (query.includes("timeout")) {
      throw new AdapterProtocolError("search timeout", { reasonCode: "tool_upstream_timeout" });
    }
    if (query.includes("oversize")) {
      throw new AdapterProtocolError("search too large", { reasonCode: "tool_output_limit_exceeded" });
    }
    return {
      summary: {
        provider: "fake-search",
        apiKey: "search-secret"
      },
      inlineOutput: {
        token: "web-secret",
        results: [
          {
            title: "Result",
            url: "https://example.com/doc?token=web-secret",
            snippet: "safe"
          }
        ]
      }
    };
  });

  const githubAdapter = createScenarioAdapter("github", (input) => {
    const plan = ((input["executionPlan"] ?? {}) as Record<string, unknown>);
    const number = Number(plan["number"] ?? 0);
    if (number === 403) {
      throw new AdapterProtocolError("github 403", { reasonCode: "tool_upstream_unavailable" });
    }
    if (number === 408) {
      throw new AdapterProtocolError("github timeout", { reasonCode: "tool_upstream_timeout" });
    }
    if (number === 999) {
      throw new AdapterProtocolError("github payload too large", { reasonCode: "tool_output_limit_exceeded" });
    }
    return {
      summary: {
        operation: "get_issue",
        token: "ghp_secret"
      },
      inlineOutput: {
        authorization: "ghp_secret",
        requestUrl: "https://api.github.com/repos/openai/codex/issues/1?token=ghp_secret"
      }
    };
  });

  const repoAdapter = createScenarioAdapter("repo", (input) => {
    const plan = ((input["executionPlan"] ?? {}) as Record<string, unknown>);
    const pathspec = Array.isArray(plan["pathspec"]) ? (plan["pathspec"] as string[]) : [];
    if (pathspec.includes("timeout.txt")) {
      throw new AdapterProtocolError("process timeout", { reasonCode: "tool_process_timeout" });
    }
    if (pathspec.includes("oversize.txt")) {
      throw new AdapterProtocolError("output too large", { reasonCode: "tool_output_limit_exceeded" });
    }
    return {
      summary: {
        operation: "diff",
        cwdPolicySummary: "/repo"
      },
      inlineOutput: {
        accessKey: "repo-secret",
        reportUrl: "https://example.com/repo?token=repo-secret"
      }
    };
  });

  const shellAdapter = createScenarioAdapter("shell", (input) => {
    const plan = ((input["executionPlan"] ?? {}) as Record<string, unknown>);
    const argv = Array.isArray(plan["argv"]) ? (plan["argv"] as string[]) : [];
    if (argv.includes("timeout")) {
      throw new AdapterProtocolError("process timeout", { reasonCode: "tool_process_timeout" });
    }
    if (argv.includes("oversize")) {
      throw new AdapterProtocolError("output too large", { reasonCode: "tool_output_limit_exceeded" });
    }
    return {
      summary: {
        commandId: "local.date.utc"
      },
      inlineOutput: {
        authorization: "super-secret",
        reportUrl: "https://example.com/shell?token=shell-secret"
      }
    };
  });

  const config = createDisabledRealToolPolicyConfig();
  config.global.enabled = true;
  config.global.approvalDefault = "required";
  config.fetch.enabled = true;
  config.fetch.allowedHosts = ["example.com"];
  config.fetch.allowedContentTypes = ["text/plain"];
  config.webSearch.enabled = true;
  config.webSearch.providerId = "fake-search";
  config.webSearch.baseUrl = "https://search.example/api";
  config.webSearch.maxResults = 5;
  config.github.enabled = true;
  config.github.token = "ghp_local_test_token";
  config.github.allowedRepos = ["openai/codex"];
  config.repo.enabled = true;
  config.repo.allowedCwdPrefixes = ["/repo"];
  config.shell.enabled = true;
  config.shell.allowedCwdPrefixes = ["/repo"];
  config.shell.catalog = {
    "local.date.utc": {
      commandId: "local.date.utc",
      executablePath: "/bin/date",
      argv: ["-u"],
      allowedCwdPrefixes: ["/repo"],
      env: { AUTHORIZATION: "secret" },
      maxArgs: 4
    }
  };

  const policy = new LocalPolicyGate(config);
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
    adapters: new Map([
      ["fake_echo", fakeEcho],
      ["fetch", fetchAdapter],
      ["web_search", webSearchAdapter],
      ["github", githubAdapter],
      ["repo", repoAdapter],
      ["shell", shellAdapter]
    ]),
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

  return {
    app,
    fakeEcho,
    approvalService,
    approvals,
    fetchAdapter,
    webSearchAdapter,
    githubAdapter,
    repoAdapter,
    shellAdapter
  };
}

async function queueInvocation(app: FastifyInstance, payload: Record<string, unknown>): Promise<{ approvalId: string; invocationId: string }> {
  const queued = await app.inject({
    method: "POST",
    url: "/tools/invocations",
    payload
  });
  expect(queued.statusCode).toBe(202);
  return {
    approvalId: queued.json().approval.id as string,
    invocationId: queued.json().invocation.id as string
  };
}

async function expireApproval(
  harness: RealToolHarness,
  approvalId: string,
  nowIso = "2026-05-31T00:10:00.000Z"
): Promise<void> {
  const pending = await harness.approvals.get(approvalId);
  if (!pending) {
    throw new Error(`approval missing: ${approvalId}`);
  }
  await harness.approvals.updateIfStatus(approvalId, "pending", {
    ...pending,
    payload: {
      ...pending.payload,
      expiresAt: "2020-01-01T00:00:00.000Z"
    }
  });
  await harness.approvalService.expirePendingRuntimeApprovals(new Date(nowIso));
}

async function assertInvocationRedacted(
  app: FastifyInstance,
  invocationId: string,
  denyList: string[]
): Promise<void> {
  const get = await app.inject({ method: "GET", url: `/tools/invocations/${invocationId}` });
  expect(get.statusCode).toBe(200);
  const listed = await app.inject({ method: "GET", url: "/tools/invocations?limit=100" });
  expect(listed.statusCode).toBe(200);
  const jsonText = `${get.body}\n${listed.body}`;
  const leaked = denyList.filter((token) => jsonText.includes(token));
  expect(leaked).toEqual([]);
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
          input: { commandId: "local.date.utc", cwd: "/repo" }
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

  it("covers fetch/web_search/github/repo/shell REST approval matrix with fake adapters", async () => {
    const harness = createRealToolHarness();
    const {
      app,
      approvalService,
      fetchAdapter,
      webSearchAdapter,
      githubAdapter,
      repoAdapter,
      shellAdapter
    } = harness;
    try {
      const fetchHappy = await queueInvocation(app, {
        runId: "run_1",
        type: "fetch",
        input: { url: "https://example.com/data?token=fetch-token", method: "GET", captureContent: true }
      });
      const fetchApproved = await app.inject({
        method: "POST",
        url: `/approvals/${fetchHappy.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(fetchApproved.statusCode).toBe(200);
      expect(fetchApproved.json().invocation.status).toBe("completed");

      const fetchMissing = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "fetch", input: {} }
      });
      expect(fetchMissing.statusCode).toBe(400);
      const fetchEmpty = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "fetch", input: { url: "", method: "GET" } }
      });
      expect(fetchEmpty.statusCode).toBe(400);
      const fetchDenied = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "fetch", input: { url: "https://evil.example", method: "GET" } }
      });
      expect(fetchDenied.statusCode).toBe(403);
      const fetchBeforeReject = fetchAdapter.invocationCount;
      const fetchReject = await queueInvocation(app, {
        runId: "run_1",
        type: "fetch",
        input: { url: "https://example.com/reject", method: "GET" }
      });
      const fetchRejected = await app.inject({
        method: "POST",
        url: `/approvals/${fetchReject.approvalId}/reject`,
        payload: { actor: "local-user" }
      });
      expect(fetchRejected.statusCode).toBe(200);
      expect(fetchRejected.json().invocation.status).toBe("denied");
      expect(fetchAdapter.invocationCount).toBe(fetchBeforeReject);

      const fetchBeforeExpire = fetchAdapter.invocationCount;
      const fetchExpire = await queueInvocation(app, {
        runId: "run_1",
        type: "fetch",
        input: { url: "https://example.com/expire", method: "GET" }
      });
      await expireApproval(harness, fetchExpire.approvalId);
      const fetchExpired = await app.inject({ method: "GET", url: `/tools/invocations/${fetchExpire.invocationId}` });
      expect(fetchExpired.statusCode).toBe(200);
      expect(fetchExpired.json().invocation.status).toBe("denied");
      expect(fetchExpired.json().invocation.error.code).toBe("tool_approval_expired");
      expect(fetchAdapter.invocationCount).toBe(fetchBeforeExpire);

      const fetchTimeout = await queueInvocation(app, {
        runId: "run_1",
        type: "fetch",
        input: { url: "https://example.com/timeout", method: "GET" }
      });
      const fetchTimeoutResolved = await app.inject({
        method: "POST",
        url: `/approvals/${fetchTimeout.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(fetchTimeoutResolved.statusCode).toBe(200);
      expect(fetchTimeoutResolved.json().invocation.status).toBe("failed");
      expect(fetchTimeoutResolved.json().invocation.error.code).toBe("tool_upstream_timeout");
      const fetchOversize = await queueInvocation(app, {
        runId: "run_1",
        type: "fetch",
        input: { url: "https://example.com/oversize", method: "GET" }
      });
      const fetchOversizeResolved = await app.inject({
        method: "POST",
        url: `/approvals/${fetchOversize.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(fetchOversizeResolved.statusCode).toBe(200);
      expect(fetchOversizeResolved.json().invocation.status).toBe("failed");
      expect(fetchOversizeResolved.json().invocation.error.code).toBe("tool_output_limit_exceeded");
      await assertInvocationRedacted(app, fetchHappy.invocationId, [
        "fetch-token",
        "secret-fetch-token",
        "topsecret",
        "session_secret",
        "do-not-leak"
      ]);

      const webHappy = await queueInvocation(app, {
        runId: "run_1",
        type: "web_search",
        input: { query: "switchyard adapters", maxResults: 2 }
      });
      const webApproved = await app.inject({
        method: "POST",
        url: `/approvals/${webHappy.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(webApproved.statusCode).toBe(200);
      expect(webApproved.json().invocation.status).toBe("completed");
      const webMissing = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "web_search", input: {} }
      });
      expect(webMissing.statusCode).toBe(400);
      const webEmpty = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "web_search", input: { query: "   " } }
      });
      expect(webEmpty.statusCode).toBe(400);
      const webDenied = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "web_search", input: { query: "too many", maxResults: 6 } }
      });
      expect(webDenied.statusCode).toBe(403);
      const webBeforeReject = webSearchAdapter.invocationCount;
      const webReject = await queueInvocation(app, {
        runId: "run_1",
        type: "web_search",
        input: { query: "reject me", maxResults: 1 }
      });
      const webRejected = await app.inject({
        method: "POST",
        url: `/approvals/${webReject.approvalId}/reject`,
        payload: { actor: "local-user" }
      });
      expect(webRejected.statusCode).toBe(200);
      expect(webRejected.json().invocation.status).toBe("denied");
      expect(webSearchAdapter.invocationCount).toBe(webBeforeReject);
      const webBeforeExpire = webSearchAdapter.invocationCount;
      const webExpire = await queueInvocation(app, {
        runId: "run_1",
        type: "web_search",
        input: { query: "expire me", maxResults: 1 }
      });
      await expireApproval(harness, webExpire.approvalId);
      const webExpired = await app.inject({ method: "GET", url: `/tools/invocations/${webExpire.invocationId}` });
      expect(webExpired.statusCode).toBe(200);
      expect(webExpired.json().invocation.error.code).toBe("tool_approval_expired");
      expect(webSearchAdapter.invocationCount).toBe(webBeforeExpire);
      const webTimeout = await queueInvocation(app, {
        runId: "run_1",
        type: "web_search",
        input: { query: "timeout request", maxResults: 1 }
      });
      const webTimeoutResolved = await app.inject({
        method: "POST",
        url: `/approvals/${webTimeout.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(webTimeoutResolved.statusCode).toBe(200);
      expect(webTimeoutResolved.json().invocation.error.code).toBe("tool_upstream_timeout");
      const webOversize = await queueInvocation(app, {
        runId: "run_1",
        type: "web_search",
        input: { query: "oversize request", maxResults: 1 }
      });
      const webOversizeResolved = await app.inject({
        method: "POST",
        url: `/approvals/${webOversize.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(webOversizeResolved.statusCode).toBe(200);
      expect(webOversizeResolved.json().invocation.error.code).toBe("tool_output_limit_exceeded");
      await assertInvocationRedacted(app, webHappy.invocationId, [
        "search-secret",
        "web-secret"
      ]);

      const githubHappy = await queueInvocation(app, {
        runId: "run_1",
        type: "github",
        input: { operation: "get_issue", owner: "openai", repo: "codex", number: 1 }
      });
      const githubApproved = await app.inject({
        method: "POST",
        url: `/approvals/${githubHappy.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(githubApproved.statusCode).toBe(200);
      expect(githubApproved.json().invocation.status).toBe("completed");
      const githubMissing = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "github", input: {} }
      });
      expect(githubMissing.statusCode).toBe(400);
      const githubEmpty = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: {
          runId: "run_1",
          type: "github",
          input: { operation: "get_issue", owner: "", repo: "", number: 1 }
        }
      });
      expect(githubEmpty.statusCode).toBe(400);
      const githubDenied = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: {
          runId: "run_1",
          type: "github",
          input: { operation: "get_issue", owner: "other", repo: "repo", number: 1 }
        }
      });
      expect(githubDenied.statusCode).toBe(403);
      const githubBeforeReject = githubAdapter.invocationCount;
      const githubReject = await queueInvocation(app, {
        runId: "run_1",
        type: "github",
        input: { operation: "get_issue", owner: "openai", repo: "codex", number: 2 }
      });
      const githubRejected = await app.inject({
        method: "POST",
        url: `/approvals/${githubReject.approvalId}/reject`,
        payload: { actor: "local-user" }
      });
      expect(githubRejected.statusCode).toBe(200);
      expect(githubRejected.json().invocation.status).toBe("denied");
      expect(githubAdapter.invocationCount).toBe(githubBeforeReject);
      const githubBeforeExpire = githubAdapter.invocationCount;
      const githubExpire = await queueInvocation(app, {
        runId: "run_1",
        type: "github",
        input: { operation: "get_issue", owner: "openai", repo: "codex", number: 3 }
      });
      await expireApproval(harness, githubExpire.approvalId);
      const githubExpired = await app.inject({ method: "GET", url: `/tools/invocations/${githubExpire.invocationId}` });
      expect(githubExpired.statusCode).toBe(200);
      expect(githubExpired.json().invocation.error.code).toBe("tool_approval_expired");
      expect(githubAdapter.invocationCount).toBe(githubBeforeExpire);
      const githubFailure = await queueInvocation(app, {
        runId: "run_1",
        type: "github",
        input: { operation: "get_issue", owner: "openai", repo: "codex", number: 403 }
      });
      const githubFailureResolved = await app.inject({
        method: "POST",
        url: `/approvals/${githubFailure.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(githubFailureResolved.statusCode).toBe(200);
      expect(githubFailureResolved.json().invocation.error.code).toBe("tool_upstream_unavailable");
      const githubOversize = await queueInvocation(app, {
        runId: "run_1",
        type: "github",
        input: { operation: "get_issue", owner: "openai", repo: "codex", number: 999 }
      });
      const githubOversizeResolved = await app.inject({
        method: "POST",
        url: `/approvals/${githubOversize.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(githubOversizeResolved.statusCode).toBe(200);
      expect(githubOversizeResolved.json().invocation.error.code).toBe("tool_output_limit_exceeded");
      await assertInvocationRedacted(app, githubHappy.invocationId, ["ghp_secret"]);

      const repoHappy = await queueInvocation(app, {
        runId: "run_1",
        type: "repo",
        input: { operation: "diff", cwd: "/repo", pathspec: ["README.md"] }
      });
      const repoApproved = await app.inject({
        method: "POST",
        url: `/approvals/${repoHappy.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(repoApproved.statusCode).toBe(200);
      expect(repoApproved.json().invocation.status).toBe("completed");
      const repoMissing = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "repo", input: {} }
      });
      expect(repoMissing.statusCode).toBe(400);
      const repoEmpty = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "repo", input: { operation: "diff", cwd: "" } }
      });
      expect(repoEmpty.statusCode).toBe(400);
      const repoDenied = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "repo", input: { operation: "diff", cwd: "/outside" } }
      });
      expect(repoDenied.statusCode).toBe(403);
      const repoBeforeReject = repoAdapter.invocationCount;
      const repoReject = await queueInvocation(app, {
        runId: "run_1",
        type: "repo",
        input: { operation: "status", cwd: "/repo" }
      });
      const repoRejected = await app.inject({
        method: "POST",
        url: `/approvals/${repoReject.approvalId}/reject`,
        payload: { actor: "local-user" }
      });
      expect(repoRejected.statusCode).toBe(200);
      expect(repoRejected.json().invocation.status).toBe("denied");
      expect(repoAdapter.invocationCount).toBe(repoBeforeReject);
      const repoBeforeExpire = repoAdapter.invocationCount;
      const repoExpire = await queueInvocation(app, {
        runId: "run_1",
        type: "repo",
        input: { operation: "status", cwd: "/repo" }
      });
      await expireApproval(harness, repoExpire.approvalId);
      const repoExpired = await app.inject({ method: "GET", url: `/tools/invocations/${repoExpire.invocationId}` });
      expect(repoExpired.statusCode).toBe(200);
      expect(repoExpired.json().invocation.error.code).toBe("tool_approval_expired");
      expect(repoAdapter.invocationCount).toBe(repoBeforeExpire);
      const repoTimeout = await queueInvocation(app, {
        runId: "run_1",
        type: "repo",
        input: { operation: "diff", cwd: "/repo", pathspec: ["timeout.txt"] }
      });
      const repoTimeoutResolved = await app.inject({
        method: "POST",
        url: `/approvals/${repoTimeout.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(repoTimeoutResolved.statusCode).toBe(200);
      expect(repoTimeoutResolved.json().invocation.error.code).toBe("tool_process_timeout");
      const repoOversize = await queueInvocation(app, {
        runId: "run_1",
        type: "repo",
        input: { operation: "diff", cwd: "/repo", pathspec: ["oversize.txt"] }
      });
      const repoOversizeResolved = await app.inject({
        method: "POST",
        url: `/approvals/${repoOversize.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(repoOversizeResolved.statusCode).toBe(200);
      expect(repoOversizeResolved.json().invocation.error.code).toBe("tool_output_limit_exceeded");
      await assertInvocationRedacted(app, repoHappy.invocationId, ["repo-secret"]);

      const shellHappy = await queueInvocation(app, {
        runId: "run_1",
        type: "shell",
        input: { commandId: "local.date.utc", cwd: "/repo", args: ["+%Y"] }
      });
      const shellApproved = await app.inject({
        method: "POST",
        url: `/approvals/${shellHappy.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(shellApproved.statusCode).toBe(200);
      expect(shellApproved.json().invocation.status).toBe("completed");
      const shellMissing = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "shell", input: {} }
      });
      expect(shellMissing.statusCode).toBe(400);
      const shellEmpty = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "shell", input: { commandId: "", cwd: "/repo" } }
      });
      expect(shellEmpty.statusCode).toBe(400);
      const shellDenied = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: { runId: "run_1", type: "shell", input: { commandId: "local.unknown", cwd: "/repo" } }
      });
      expect(shellDenied.statusCode).toBe(403);
      const shellBeforeReject = shellAdapter.invocationCount;
      const shellReject = await queueInvocation(app, {
        runId: "run_1",
        type: "shell",
        input: { commandId: "local.date.utc", cwd: "/repo", args: ["reject"] }
      });
      const shellRejected = await app.inject({
        method: "POST",
        url: `/approvals/${shellReject.approvalId}/reject`,
        payload: { actor: "local-user" }
      });
      expect(shellRejected.statusCode).toBe(200);
      expect(shellRejected.json().invocation.status).toBe("denied");
      expect(shellAdapter.invocationCount).toBe(shellBeforeReject);
      const shellBeforeExpire = shellAdapter.invocationCount;
      const shellExpire = await queueInvocation(app, {
        runId: "run_1",
        type: "shell",
        input: { commandId: "local.date.utc", cwd: "/repo" }
      });
      await expireApproval(harness, shellExpire.approvalId);
      const shellExpired = await app.inject({ method: "GET", url: `/tools/invocations/${shellExpire.invocationId}` });
      expect(shellExpired.statusCode).toBe(200);
      expect(shellExpired.json().invocation.error.code).toBe("tool_approval_expired");
      expect(shellAdapter.invocationCount).toBe(shellBeforeExpire);
      const shellTimeout = await queueInvocation(app, {
        runId: "run_1",
        type: "shell",
        input: { commandId: "local.date.utc", cwd: "/repo", args: ["timeout"] }
      });
      const shellTimeoutResolved = await app.inject({
        method: "POST",
        url: `/approvals/${shellTimeout.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(shellTimeoutResolved.statusCode).toBe(200);
      expect(shellTimeoutResolved.json().invocation.error.code).toBe("tool_process_timeout");
      const shellOversize = await queueInvocation(app, {
        runId: "run_1",
        type: "shell",
        input: { commandId: "local.date.utc", cwd: "/repo", args: ["oversize"] }
      });
      const shellOversizeResolved = await app.inject({
        method: "POST",
        url: `/approvals/${shellOversize.approvalId}/approve`,
        payload: { actor: "local-user" }
      });
      expect(shellOversizeResolved.statusCode).toBe(200);
      expect(shellOversizeResolved.json().invocation.error.code).toBe("tool_output_limit_exceeded");
      await assertInvocationRedacted(app, shellHappy.invocationId, ["shell-secret", "super-secret"]);
      const lifecycle = await approvalService.expirePendingRuntimeApprovals();
      expect(lifecycle.expired).toBeGreaterThanOrEqual(0);
    } finally {
      await app.close();
    }
  });
});
