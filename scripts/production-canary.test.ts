import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { runProductionCanary, type ProductionCanaryResult } from "./production-canary.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface PlannedResponse {
  method: string;
  path: string;
  responder: (input: { url: URL; init: RequestInit; callIndex: number }) => Response | Promise<Response>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function textResponse(status: number, body: string, contentType = "text/plain"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType }
  });
}

function bytesResponse(status: number, bytes: Uint8Array): Response {
  return new Response(bytes, {
    status,
    headers: { "content-type": "application/octet-stream" }
  });
}

function sseEvent(data: unknown): string {
  return `id: evt_1\nevent: runtime.output\ndata: ${JSON.stringify(data)}\n\n`;
}

function debateInspectBody(contentBytes: Uint8Array): unknown {
  const digest = `sha256:${sha256Hex(contentBytes)}`;
  return {
    debate: {
      id: "debate_1",
      topic: "Switchyard production hosted debate canary r24-debate-test",
      status: "no_consensus",
      participants: [
        {
          id: "participant_1",
          role: "affirmative",
          runtime: "fake",
          provider: "test",
          model: "test-model",
          status: "completed",
          turnsUsed: 1,
          runId: "run_participant_1",
          runIds: ["run_participant_1"]
        },
        {
          id: "participant_2",
          role: "skeptic",
          runtime: "fake",
          provider: "test",
          model: "test-model",
          status: "completed",
          turnsUsed: 1,
          runId: "run_participant_2",
          runIds: ["run_participant_2"]
        }
      ],
      messageIds: ["message_1", "message_2"],
      eventIds: ["event_1", "event_2"],
      stopReason: "completed",
      finalReportArtifactId: "artifact_1",
      judge: {
        consensus: "no_consensus",
        summary: "No consensus.",
        disagreementSummary: "The participants disagree.",
        winner: "none",
        evidenceIds: [],
        messageIds: ["message_1", "message_2"]
      },
      budget: {
        status: "within_budget",
        maxCostUsd: 0,
        spentCostUsd: 0
      },
      createdAt: "2026-06-04T00:00:00.000Z",
      completedAt: "2026-06-04T00:00:01.000Z"
    },
    messages: [
      { id: "message_1", debateId: "debate_1", channel: "debate:debate_1", content: "affirmative" },
      { id: "message_2", debateId: "debate_1", channel: "debate:debate_1", content: "skeptic" }
    ],
    events: [
      { id: "event_1", debateId: "debate_1", type: "debate.round.started", sequence: 1, payload: { debateId: "debate_1" } },
      { id: "event_2", debateId: "debate_1", type: "debate.judge.summary", sequence: 2, payload: { debateId: "debate_1" } }
    ],
    evidence: [],
    artifacts: [
      {
        id: "artifact_1",
        debateId: "debate_1",
        type: "summary",
        path: "debates/debate_1/final-report.md",
        metadata: {
          debateId: "debate_1",
          participantIds: ["participant_1", "participant_2"],
          messageIds: ["message_1", "message_2"],
          judgeSummary: "No consensus.",
          digest,
          size: contentBytes.byteLength
        }
      }
    ]
  };
}

function createPlannedFetch(baseUrl: string, plan: PlannedResponse[]): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let index = 0;

  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const normalizedInit: RequestInit = init ?? {};
    calls.push({ url: url.href, init: normalizedInit });

    if (index >= plan.length) {
      throw new Error(`unexpected_fetch_call:${url.pathname}`);
    }

    const next = plan[index];
    index += 1;
    const method = (normalizedInit.method ?? "GET").toUpperCase();
    if (method !== next.method || url.pathname !== next.path) {
      throw new Error(`unexpected_fetch_order:${method}:${url.pathname}:expected:${next.method}:${next.path}`);
    }

    if (!url.href.startsWith(baseUrl)) {
      throw new Error(`unexpected_base_url:${url.href}`);
    }

    return next.responder({ url, init: normalizedInit, callIndex: index - 1 });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function makeNow(sequence: number[]): () => number {
  let index = 0;
  return () => {
    const value = sequence[Math.min(index, sequence.length - 1)] ?? 0;
    index += 1;
    return value;
  };
}

function sha256Hex(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function expectFailure(result: ProductionCanaryResult, code: string): void {
  expect(result.ok).toBe(false);
  expect(result.code).toBe(code);
}

function buildR22HappyPlan(contentBytes: Uint8Array): PlannedResponse[] {
  return [
    ...buildNoToolHappyPlan(contentBytes, { includeMetricsAndAudit: false }),
    {
      method: "POST",
      path: "/runs",
      responder: ({ init }) => {
        const body = JSON.parse(String(init.body ?? "{}"));
        expect(body.runtimeMode).toBe("fake.deterministic");
        expect(body.metadata.switchyardCanary).toBe("r22-tools-production");
        return jsonResponse(202, { run: { id: "run_1", status: "queued" } });
      }
    },
    {
      method: "POST",
      path: "/tools/invocations",
      responder: ({ init }) => {
        const body = JSON.parse(String(init.body ?? "{}"));
        expect(body.type).toBe("fetch");
        return jsonResponse(202, {
          invocation: { id: "inv_fetch_1", status: "queued" },
          approval: { id: "appr_fetch_1", status: "pending" }
        });
      }
    },
    {
      method: "POST",
      path: "/tools/invocations",
      responder: () => jsonResponse(409, { error: { code: "tool_policy_denied" } })
    },
    {
      method: "POST",
      path: "/tools/invocations",
      responder: () => jsonResponse(403, { error: { code: "shell_command_denied" } })
    },
    {
      method: "POST",
      path: "/tools/invocations",
      responder: () => jsonResponse(202, {
        invocation: { id: "inv_shell_1", status: "queued" },
        approval: { id: "appr_shell_1", status: "pending" }
      })
    },
    {
      method: "POST",
      path: "/tools/invocations",
      responder: () => jsonResponse(409, { error: { code: "tool_node_unavailable" } })
    },
    {
      method: "POST",
      path: "/tools/invocations",
      responder: () => jsonResponse(409, { error: { code: "tool_node_unavailable" } })
    },
    {
      method: "POST",
      path: "/approvals/appr_fetch_1/reject",
      responder: () => jsonResponse(200, { approval: { id: "appr_fetch_1", status: "rejected" } })
    },
    {
      method: "GET",
      path: "/tools/invocations/inv_fetch_1",
      responder: () => jsonResponse(200, {
        invocation: {
          id: "inv_fetch_1",
          status: "denied",
          error: { code: "tool_approval_rejected" }
        }
      })
    },
    {
      method: "GET",
      path: "/approvals",
      responder: () => jsonResponse(200, { approvals: [] })
    },
    {
      method: "GET",
      path: "/metrics",
      responder: () => jsonResponse(200, { requests: { total: 1 }, auth: { succeeded: 1 } })
    },
    {
      method: "GET",
      path: "/audit/events",
      responder: () => jsonResponse(200, {
        events: [
          {
            id: "audit_1",
            resourceType: "debate",
            resourceId: "debate_1",
            debateId: "debate_1",
            payload: { switchyardCanary: "r24-hosted-debate-production" }
          }
        ]
      })
    }
  ];
}

function buildNoToolHappyPlan(
  contentBytes: Uint8Array,
  options: { includeMetricsAndAudit?: boolean; streamDebateEvents?: boolean } = {}
): PlannedResponse[] {
  const includeMetricsAndAudit = options.includeMetricsAndAudit ?? true;
  const plan: PlannedResponse[] = [
    {
      method: "GET",
      path: "/auth/whoami",
      responder: () => jsonResponse(200, { auth: { account: { id: "account_1" } } })
    },
    {
      method: "GET",
      path: "/entitlements",
      responder: () => jsonResponse(200, { entitlement: { entitlements: { allowHostedTools: true } } })
    },
    {
      method: "GET",
      path: "/ready",
      responder: () => jsonResponse(200, { ok: true, checks: { schema: { ok: true, code: "postgres_schema_ready" } } })
    },
    {
      method: "POST",
      path: "/debates",
      responder: ({ init }) => {
        const body = JSON.parse(String(init.body ?? "{}"));
        expect(body.participants.every((participant: Record<string, unknown>) => participant.runtimeMode === "fake.deterministic")).toBe(true);
        expect(body.participants.every((participant: Record<string, unknown>) => participant.realRuntimeOptIn === false)).toBe(true);
        expect(body.judgeConfig.mode).toBe("deterministic");
        expect(body.metadata.switchyardCanary).toBe("r24-hosted-debate-production");
        return jsonResponse(202, { debate: { id: "debate_1", status: "created" } });
      }
    },
    {
      method: "GET",
      path: "/debates/debate_1",
      responder: () => jsonResponse(200, debateInspectBody(contentBytes))
    },
    {
      method: "GET",
      path: "/debates/debate_1/events",
      responder: () => textResponse(200, [
        sseEvent({ id: "event_1", debateId: "debate_1", type: "debate.round.started", payload: { debateId: "debate_1" } }),
        sseEvent({ id: "event_2", debateId: "debate_1", type: "debate.judge.summary", payload: { debateId: "debate_1" } })
      ].join(""), "text/event-stream")
    }
  ];
  if (options.streamDebateEvents) {
    plan.push({
      method: "GET",
      path: "/debates/debate_1/events",
      responder: ({ url }) => {
        expect(url.searchParams.get("live")).toBe("1");
        expect(url.searchParams.get("stopAfter")).toBe("5");
        return textResponse(200, sseEvent({
          id: "event_1",
          debateId: "debate_1",
          type: "debate.round.started",
          payload: { debateId: "debate_1" }
        }), "text/event-stream");
      }
    });
  }
  plan.push({
    method: "GET",
    path: "/artifacts/artifact_1/content",
    responder: () => bytesResponse(200, contentBytes)
  });
  if (includeMetricsAndAudit) {
    plan.push(
      {
        method: "GET",
        path: "/metrics",
        responder: () => jsonResponse(200, { requests: { total: 1 }, auth: { succeeded: 1 } })
      },
      {
        method: "GET",
        path: "/audit/events",
        responder: () => jsonResponse(200, {
          events: [
            {
              id: "audit_1",
              resourceType: "debate",
              resourceId: "debate_1",
              debateId: "debate_1",
              payload: { switchyardCanary: "r24-hosted-debate-production" }
            }
          ]
        })
      }
    );
  }
  return plan;
}

describe("runProductionCanary", () => {
  test("default canary skips live-capable tool probes unless explicitly enabled", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("canary artifact output");
    const { fetchImpl, calls } = createPlannedFetch(baseUrl, buildNoToolHappyPlan(bytes));

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 5_000,
      now: makeNow(Array.from({ length: 40 }, (_, index) => index * 50))
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("canary_ok");
    expect(calls.some((call) => new URL(call.url).pathname === "/tools/invocations")).toBe(false);
    expect(calls.some((call) => new URL(call.url).pathname === "/runs")).toBe(false);
    expect(calls.some((call) => new URL(call.url).pathname === "/debates")).toBe(true);
    expect(result.summary.debateId).toBe("debate_1");
    expect(result.steps.some((step) => step.name === "tools" && step.code === "tool_probes_skipped_default")).toBe(true);
    expect(result.steps.some((step) => step.name === "debate.liveParticipants" && step.code === "debate_live_participants_skipped_default")).toBe(true);
    expect(result.steps.some((step) => step.name === "debate.liveJudge" && step.code === "debate_live_judge_skipped_default")).toBe(true);
  });

  test("happy path validates tool probes plus artifact and audit evidence", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("canary artifact output");
    const { fetchImpl } = createPlannedFetch(baseUrl, buildR22HappyPlan(bytes));

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "live-key-123",
      fetchImpl,
      timeoutMs: 5_000,
      now: makeNow(Array.from({ length: 40 }, (_, index) => index * 50)),
      liveExternalTools: true,
      confirmLiveToolSpend: true
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("canary_ok");
    expect(result.summary.debateId).toBe("debate_1");
    expect(result.summary.runId).toBe("run_1");
    expect(result.summary.artifactId).toBe("artifact_1");
    expect(result.steps.some((step) => step.name === "debate.trace" && step.code === "debate_trace_verified")).toBe(true);
    expect(result.steps.some((step) => step.name === "tools.hosted.fetch" && step.status === "pass")).toBe(true);
    expect(result.steps.some((step) => step.name === "tools.hosted.shell_denied" && step.code === "shell_command_denied")).toBe(true);
    expect(result.steps.some((step) => step.name === "tools.connected.unavailable" && step.code === "tool_node_unavailable")).toBe(true);
    expect(result.steps.some((step) => step.name === "tools.approval.reject" && step.code === "tool_approval_rejected")).toBe(true);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("live-key-123");
    expect(serialized).not.toContain("canary artifact output");
  });

  test("fails fast when live external tool mode is requested without explicit confirmation", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await runProductionCanary({
      baseUrl: "https://switchyard.example",
      apiKey: "test-key",
      liveExternalTools: true,
      fetchImpl
    });
    expectFailure(result, "tool_live_canary_config_missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("fails fast when live provider bridge mode is requested without explicit spend confirmation", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await runProductionCanary({
      baseUrl: "https://switchyard.example",
      apiKey: "test-key",
      liveProviderBridges: true,
      fetchImpl
    });
    expectFailure(result, "provider_bridge_live_canary_spend_unconfirmed");
    expect(result.steps).toContainEqual(expect.objectContaining({
      name: "input.liveProviderBridges",
      status: "fail",
      code: "provider_bridge_live_canary_spend_unconfirmed"
    }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("fails fast with missing live provider bridge config after explicit spend confirmation", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await runProductionCanary({
      baseUrl: "https://switchyard.example",
      apiKey: "test-key",
      liveProviderBridges: true,
      confirmLiveProviderSpend: true,
      fetchImpl
    });
    expectFailure(result, "provider_bridge_live_canary_config_missing");
    expect(result.steps).toContainEqual(expect.objectContaining({
      name: "input.liveProviderBridges",
      status: "fail",
      code: "provider_bridge_live_canary_config_missing"
    }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("test-key");
  });

  test("fails fast before fetch when live debate spend is not explicitly confirmed", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await runProductionCanary({
      baseUrl: "https://switchyard.example",
      apiKey: "test-key",
      liveDebateRuntimes: true,
      fetchImpl
    });
    expectFailure(result, "debate_live_canary_spend_unconfirmed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("returns auth_required and never calls fetch when api key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await runProductionCanary({ baseUrl: "https://switchyard.example", fetchImpl });
    expectFailure(result, "auth_required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("returns invalid_base_url for invalid or credentialed URLs and never calls fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const invalid = await runProductionCanary({ baseUrl: "not-a-url", apiKey: "test-key", fetchImpl });
    expectFailure(invalid, "invalid_base_url");

    const credentialed = await runProductionCanary({ baseUrl: "https://user:pass@switchyard.example", apiKey: "test-key", fetchImpl });
    expectFailure(credentialed, "invalid_base_url");

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("fails with tool_canary_denied when hosted fetch probe returns unexpected denial", async () => {
    const baseUrl = "https://switchyard.example";
    const plan = buildR22HappyPlan(new TextEncoder().encode("ok"));
    const fetchProbeIndex = plan.findIndex((entry) => entry.method === "POST" && entry.path === "/tools/invocations");
    expect(fetchProbeIndex).toBeGreaterThanOrEqual(0);
    plan[fetchProbeIndex] = {
      method: "POST",
      path: "/tools/invocations",
      responder: () => jsonResponse(500, { error: { code: "internal_error" } })
    };
    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 5000,
      now: makeNow(Array.from({ length: 40 }, (_, index) => index * 50)),
      liveExternalTools: true,
      confirmLiveToolSpend: true
    });

    expectFailure(result, "tool_canary_denied");
  });

  test("default canary reports live provider bridge probes as skipped", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("canary artifact output");
    const { fetchImpl } = createPlannedFetch(baseUrl, buildNoToolHappyPlan(bytes));

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 5_000,
      now: makeNow(Array.from({ length: 40 }, (_, index) => index * 50))
    });

    expect(result.ok).toBe(true);
    expect(result.steps.some((step) => step.name === "providerBridges" && step.code === "provider_bridge_skipped_default")).toBe(true);
  });

  test("fails with approval_canary_failed when reject flow cannot be validated", async () => {
    const baseUrl = "https://switchyard.example";
    const plan = buildR22HappyPlan(new TextEncoder().encode("ok"));
    const invocationLookupIndex = plan.findIndex((entry) => entry.method === "GET" && entry.path === "/tools/invocations/inv_fetch_1");
    expect(invocationLookupIndex).toBeGreaterThanOrEqual(0);
    plan[invocationLookupIndex] = {
      method: "GET",
      path: "/tools/invocations/inv_fetch_1",
      responder: () => jsonResponse(200, {
        invocation: {
          id: "inv_fetch_1",
          status: "denied",
          error: { code: "tool_policy_denied" }
        }
      })
    };
    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 5000,
      now: makeNow(Array.from({ length: 40 }, (_, index) => index * 50)),
      liveExternalTools: true,
      confirmLiveToolSpend: true
    });

    expectFailure(result, "approval_canary_failed");
  });

  test("streaming debate canary verifies debate id filtering when enabled", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("canary artifact output");
    const { fetchImpl } = createPlannedFetch(baseUrl, buildNoToolHappyPlan(bytes, { streamDebateEvents: true }));

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 5_000,
      now: makeNow(Array.from({ length: 40 }, (_, index) => index * 50)),
      streamDebateEvents: true
    });

    expect(result.ok).toBe(true);
    expect(result.steps.some((step) => step.name === "debate.events.live" && step.code === "debate_sse_filter_ok")).toBe(true);
  });
});
