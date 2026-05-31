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

function buildHappyPlan(contentBytes: Uint8Array, auditResponder?: PlannedResponse["responder"]): PlannedResponse[] {
  const digest = `sha256:${sha256Hex(contentBytes)}`;
  return [
    {
      method: "GET",
      path: "/auth/whoami",
      responder: () => jsonResponse(200, { auth: { account: { id: "account_1" } } })
    },
    {
      method: "GET",
      path: "/entitlements",
      responder: () => jsonResponse(200, { entitlement: { entitlements: { allowMetricsRead: true } } })
    },
    {
      method: "GET",
      path: "/ready",
      responder: () => jsonResponse(200, { ok: true, checks: { schema: { ok: true, code: "postgres_schema_ready" } } })
    },
    {
      method: "POST",
      path: "/runs",
      responder: ({ init }) => {
        const body = JSON.parse(String(init.body ?? "{}"));
        expect(body.runtime).toBe("fake");
        expect(body.provider).toBe("test");
        expect(body.model).toBe("test-model");
        expect(body.adapterType).toBe("process");
        expect(body.runtimeMode).toBe("fake.deterministic");
        expect(body.placement).toBe("hosted");
        expect(body.cwd).toBe("/repo");
        expect(body.task).toBe("r19 production canary");
        expect(body.metadata.switchyardCanary).toBe("r19-production");
        expect(typeof body.metadata.canaryId).toBe("string");
        expect(typeof body.metadata.startedAt).toBe("string");
        return jsonResponse(202, {
          run: {
            id: "run_1",
            status: "queued"
          }
        });
      }
    },
    {
      method: "GET",
      path: "/runs/run_1",
      responder: () => jsonResponse(200, {
        run: {
          id: "run_1",
          status: "completed",
          task: "secret-task",
          cwd: "/secret/cwd"
        },
        events: []
      })
    },
    {
      method: "GET",
      path: "/runs/run_1/events",
      responder: () => textResponse(200, sseEvent({ event: "ok" }), "text/event-stream")
    },
    {
      method: "GET",
      path: "/runs/run_1/artifacts",
      responder: () => jsonResponse(200, {
        artifacts: [
          {
            id: "artifact_1",
            path: "object/private/key",
            metadata: {
              digest,
              size: contentBytes.byteLength,
              signedUrl: "https://example.com/object?X-Amz-Signature=topsecret"
            }
          }
        ]
      })
    },
    {
      method: "GET",
      path: "/artifacts/artifact_1/content",
      responder: () => bytesResponse(200, contentBytes)
    },
    {
      method: "GET",
      path: "/metrics",
      responder: () => jsonResponse(200, { requests: { total: 1 }, auth: { succeeded: 1 } })
    },
    {
      method: "GET",
      path: "/audit/events",
      responder: auditResponder ?? (() => jsonResponse(200, {
        events: [
          {
            id: "audit_1",
            resourceType: "run",
            resourceId: "run_1",
            payload: { switchyardCanary: "r19-production", apiKey: "secret-key", nodeToken: "node-secret" }
          }
        ]
      }))
    }
  ];
}

function buildProviderHappyPlan(contentBytes: Uint8Array, runtimeMode: "codex.exec_json" | "claude_code.sdk" | "opencode.acp"): PlannedResponse[] {
  const digest = `sha256:${sha256Hex(contentBytes)}`;
  return [
    {
      method: "GET",
      path: "/auth/whoami",
      responder: () => jsonResponse(200, { auth: { account: { id: "account_1" } } })
    },
    {
      method: "GET",
      path: "/entitlements",
      responder: () => jsonResponse(200, { entitlement: { entitlements: { allowMetricsRead: true } } })
    },
    {
      method: "GET",
      path: "/ready",
      responder: () => jsonResponse(200, { ok: true, checks: {} })
    },
    {
      method: "POST",
      path: "/runs",
      responder: ({ init }) => {
        const body = JSON.parse(String(init.body ?? "{}"));
        expect(body.placement).toBe("hosted");
        expect(body.runtimeMode).toBe(runtimeMode);
        expect(body.metadata.switchyardCanary).toBe("r21-provider-production");
        return jsonResponse(202, { run: { id: "run_provider_1", status: "queued" } });
      }
    },
    {
      method: "GET",
      path: "/runs/run_provider_1",
      responder: () => jsonResponse(200, {
        run: {
          id: "run_provider_1",
          status: "completed"
        },
        events: []
      })
    },
    {
      method: "GET",
      path: "/runs/run_provider_1/events",
      responder: () => textResponse(200, sseEvent({ event: "ok" }), "text/event-stream")
    },
    {
      method: "GET",
      path: "/runs/run_provider_1/artifacts",
      responder: () => jsonResponse(200, {
        artifacts: [
          {
            id: "artifact_provider_1",
            metadata: {
              digest,
              size: contentBytes.byteLength
            }
          }
        ]
      })
    },
    {
      method: "GET",
      path: "/artifacts/artifact_provider_1/content",
      responder: () => bytesResponse(200, contentBytes)
    },
    {
      method: "GET",
      path: "/metrics",
      responder: () => jsonResponse(200, {
        hostedRuntime: {
          lifecycle: {
            runtime_mode: runtimeMode,
            outcome: "accepted"
          }
        }
      })
    },
    {
      method: "GET",
      path: "/audit/events",
      responder: () => jsonResponse(200, {
        events: [
          {
            id: "audit_provider_1",
            resourceType: "run",
            resourceId: "run_provider_1",
            payload: { switchyardCanary: "r21-provider-production" }
          }
        ]
      })
    }
  ];
}

describe("runProductionCanary", () => {
  test("happy path verifies ready/run/events/artifact/content/metrics/audit", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("canary artifact output");
    const { fetchImpl } = createPlannedFetch(baseUrl, buildHappyPlan(bytes));

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "live-key-123",
      fetchImpl,
      timeoutMs: 5_000,
      now: makeNow([0, 50, 100, 150, 200, 250, 300, 350, 400])
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe("canary_ok");
    expect(result.summary.runId).toBe("run_1");
    expect(result.summary.artifactId).toBe("artifact_1");
    expect(result.summary.metricsAuthorized).toBe(true);
    expect(result.summary.auditEvidence).toBe(true);
    expect(result.summary.delayedAuditEvidence).toBe(false);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("live-key-123");
    expect(serialized).not.toContain("secret-key");
    expect(serialized).not.toContain("node-secret");
    expect(serialized).not.toContain("secret-task");
    expect(serialized).not.toContain("/secret/cwd");
    expect(serialized).not.toContain("object/private/key");
    expect(serialized).not.toContain("X-Amz-Signature=topsecret");
    expect(serialized).not.toContain("canary artifact output");
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

  test("returns auth_invalid when whoami denies auth", async () => {
    const baseUrl = "https://switchyard.example";
    const { fetchImpl } = createPlannedFetch(baseUrl, [
      { method: "GET", path: "/auth/whoami", responder: () => jsonResponse(403, { error: "denied" }) }
    ]);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "auth_invalid");
  });

  test("returns ready_denied when /ready is 503", async () => {
    const baseUrl = "https://switchyard.example";
    const { fetchImpl } = createPlannedFetch(baseUrl, [
      { method: "GET", path: "/auth/whoami", responder: () => jsonResponse(200, { auth: {} }) },
      { method: "GET", path: "/entitlements", responder: () => jsonResponse(200, { entitlement: {} }) },
      { method: "GET", path: "/ready", responder: () => jsonResponse(503, { ok: false, checks: { schema: { ok: false, code: "postgres_unavailable" } } }) }
    ]);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "ready_denied");
  });

  test("returns run_create_denied when run creation is denied", async () => {
    const baseUrl = "https://switchyard.example";
    const { fetchImpl } = createPlannedFetch(baseUrl, [
      { method: "GET", path: "/auth/whoami", responder: () => jsonResponse(200, { auth: {} }) },
      { method: "GET", path: "/entitlements", responder: () => jsonResponse(200, { entitlement: {} }) },
      { method: "GET", path: "/ready", responder: () => jsonResponse(200, { ok: true, checks: {} }) },
      { method: "POST", path: "/runs", responder: () => jsonResponse(403, { code: "entitlement_denied" }) }
    ]);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "run_create_denied");
  });

  test("returns worker_timeout when run never reaches terminal success", async () => {
    const baseUrl = "https://switchyard.example";
    const { fetchImpl } = createPlannedFetch(baseUrl, [
      { method: "GET", path: "/auth/whoami", responder: () => jsonResponse(200, { auth: {} }) },
      { method: "GET", path: "/entitlements", responder: () => jsonResponse(200, { entitlement: {} }) },
      { method: "GET", path: "/ready", responder: () => jsonResponse(200, { ok: true, checks: {} }) },
      { method: "POST", path: "/runs", responder: () => jsonResponse(202, { run: { id: "run_1", status: "queued" } }) },
      { method: "GET", path: "/runs/run_1", responder: () => jsonResponse(200, { run: { id: "run_1", status: "queued" }, events: [] }) },
      { method: "GET", path: "/runs/run_1", responder: () => jsonResponse(200, { run: { id: "run_1", status: "running" }, events: [] }) }
    ]);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 200,
      now: makeNow([0, 50, 100, 150, 201, 250, 300])
    });

    expectFailure(result, "worker_timeout");
    expect(result.summary.runId).toBe("run_1");
  });

  test("returns unexpected_terminal_status when run fails", async () => {
    const baseUrl = "https://switchyard.example";
    const { fetchImpl } = createPlannedFetch(baseUrl, [
      { method: "GET", path: "/auth/whoami", responder: () => jsonResponse(200, { auth: {} }) },
      { method: "GET", path: "/entitlements", responder: () => jsonResponse(200, { entitlement: {} }) },
      { method: "GET", path: "/ready", responder: () => jsonResponse(200, { ok: true, checks: {} }) },
      { method: "POST", path: "/runs", responder: () => jsonResponse(202, { run: { id: "run_1", status: "queued" } }) },
      { method: "GET", path: "/runs/run_1", responder: () => jsonResponse(200, { run: { id: "run_1", status: "failed" }, events: [] }) }
    ]);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "unexpected_terminal_status");
    expect(result.summary.terminalStatus).toBe("failed");
  });

  test("returns malformed_response for malformed JSON responses", async () => {
    const baseUrl = "https://switchyard.example";
    const { fetchImpl } = createPlannedFetch(baseUrl, [
      { method: "GET", path: "/auth/whoami", responder: () => textResponse(200, "{", "application/json") }
    ]);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "malformed_response");
  });

  test("returns malformed_sse for malformed run events replay", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("ok");
    const plan = buildHappyPlan(bytes);
    plan[5] = {
      method: "GET",
      path: "/runs/run_1/events",
      responder: () => textResponse(200, "data: {not-json}\n\n", "text/event-stream")
    };
    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "malformed_sse");
  });

  test("returns artifact_missing when artifact list is empty", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("ok");
    const plan = buildHappyPlan(bytes);
    plan[6] = {
      method: "GET",
      path: "/runs/run_1/artifacts",
      responder: () => jsonResponse(200, { artifacts: [] })
    };
    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "artifact_missing");
  });

  test("returns artifact_missing when artifact content fetch is 404", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("ok");
    const plan = buildHappyPlan(bytes);
    plan[7] = {
      method: "GET",
      path: "/artifacts/artifact_1/content",
      responder: () => jsonResponse(404, { code: "artifact_not_found" })
    };
    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "artifact_missing");
  });

  test("returns artifact_content_empty when artifact content is empty", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new Uint8Array(0);
    const plan = buildHappyPlan(bytes);
    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "artifact_content_empty");
  });

  test("returns artifact_digest_mismatch when digest metadata does not match content", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("artifact payload");
    const plan = buildHappyPlan(bytes);
    plan[6] = {
      method: "GET",
      path: "/runs/run_1/artifacts",
      responder: () => jsonResponse(200, {
        artifacts: [
          {
            id: "artifact_1",
            metadata: {
              digest: "sha256:deadbeef",
              size: bytes.byteLength
            }
          }
        ]
      })
    };
    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "artifact_digest_mismatch");
  });

  test("returns metrics_auth_failed when /metrics is denied", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("ok");
    const plan = buildHappyPlan(bytes);
    plan[8] = {
      method: "GET",
      path: "/metrics",
      responder: () => jsonResponse(403, { code: "forbidden" })
    };
    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "metrics_auth_failed");
  });

  test("reports delayed_audit_evidence and succeeds when evidence appears after retry", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("ok");
    let auditCount = 0;
    const plan = buildHappyPlan(bytes, () => {
      auditCount += 1;
      if (auditCount === 1) {
        return jsonResponse(200, { events: [] });
      }
      return jsonResponse(200, {
        events: [
          {
            id: "audit_2",
            resourceType: "run",
            resourceId: "run_1",
            payload: { switchyardCanary: "r19-production" }
          }
        ]
      });
    });
    plan.splice(10, 0, {
      method: "GET",
      path: "/audit/events",
      responder: plan[9]!.responder
    });

    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 5_000,
      now: makeNow([0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200])
    });

    expect(result.ok).toBe(true);
    expect(result.summary.delayedAuditEvidence).toBe(true);
    expect(result.steps.some((step) => step.code === "delayed_audit_evidence")).toBe(true);
  });

  test("ignores older audit evidence that only has the static canary label", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("ok");
    let auditCount = 0;
    const plan = buildHappyPlan(bytes, () => {
      auditCount += 1;
      if (auditCount === 1) {
        return jsonResponse(200, {
          events: [
            {
              id: "audit_old",
              resourceType: "run",
              resourceId: "run_old",
              payload: { switchyardCanary: "r19-production" }
            }
          ]
        });
      }
      return jsonResponse(200, {
        events: [
          {
            id: "audit_current",
            resourceType: "run",
            resourceId: "run_1",
            payload: { switchyardCanary: "r19-production" }
          }
        ]
      });
    });
    plan.splice(10, 0, {
      method: "GET",
      path: "/audit/events",
      responder: plan[9]!.responder
    });

    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 5_000,
      now: makeNow([0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200])
    });

    expect(result.ok).toBe(true);
    expect(result.summary.delayedAuditEvidence).toBe(true);
    expect(result.steps.some((step) => step.code === "delayed_audit_evidence")).toBe(true);
  });

  test("returns audit_lookup_failed when audit evidence does not appear", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("ok");
    const plan = buildHappyPlan(bytes, () => jsonResponse(200, { events: [] }));
    plan.splice(10, 0, {
      method: "GET",
      path: "/audit/events",
      responder: () => jsonResponse(200, { events: [] })
    });
    plan.splice(11, 0, {
      method: "GET",
      path: "/audit/events",
      responder: () => jsonResponse(200, { events: [] })
    });

    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      fetchImpl,
      timeoutMs: 700,
      now: makeNow([0, 50, 100, 150, 200, 250, 300, 350, 500, 700, 900])
    });

    expectFailure(result, "audit_lookup_failed");
  });

  test("prefers auth_invalid when /ready denies with 401", async () => {
    const baseUrl = "https://switchyard.example";
    const { fetchImpl } = createPlannedFetch(baseUrl, [
      { method: "GET", path: "/auth/whoami", responder: () => jsonResponse(200, { auth: {} }) },
      { method: "GET", path: "/entitlements", responder: () => jsonResponse(200, { entitlement: {} }) },
      { method: "GET", path: "/ready", responder: () => jsonResponse(401, { code: "auth_required" }) }
    ]);

    const result = await runProductionCanary({ baseUrl, apiKey: "test-key", fetchImpl });
    expectFailure(result, "auth_invalid");
  });

  test("provider mode requires explicit spend confirmation", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await runProductionCanary({
      baseUrl: "https://switchyard.example",
      apiKey: "test-key",
      runtimeMode: "codex.exec_json",
      fetchImpl
    });
    expectFailure(result, "provider_canary_config_missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("provider mode rejects blank runtime mode", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await runProductionCanary({
      baseUrl: "https://switchyard.example",
      apiKey: "test-key",
      runtimeMode: "   ",
      confirmProviderSpend: true,
      fetchImpl
    });
    expectFailure(result, "provider_canary_runtime_empty");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("provider mode returns provider_canary_create_denied", async () => {
    const baseUrl = "https://switchyard.example";
    const { fetchImpl } = createPlannedFetch(baseUrl, [
      { method: "GET", path: "/auth/whoami", responder: () => jsonResponse(200, { auth: {} }) },
      { method: "GET", path: "/entitlements", responder: () => jsonResponse(200, { entitlement: {} }) },
      { method: "GET", path: "/ready", responder: () => jsonResponse(200, { ok: true, checks: {} }) },
      { method: "POST", path: "/runs", responder: () => jsonResponse(409, { code: "hosted_runtime_not_allowed" }) }
    ]);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      runtimeMode: "codex.exec_json",
      confirmProviderSpend: true,
      fetchImpl
    });
    expectFailure(result, "provider_canary_create_denied");
  });

  test("provider mode returns provider_canary_timeout", async () => {
    const baseUrl = "https://switchyard.example";
    const { fetchImpl } = createPlannedFetch(baseUrl, [
      { method: "GET", path: "/auth/whoami", responder: () => jsonResponse(200, { auth: {} }) },
      { method: "GET", path: "/entitlements", responder: () => jsonResponse(200, { entitlement: {} }) },
      { method: "GET", path: "/ready", responder: () => jsonResponse(200, { ok: true, checks: {} }) },
      { method: "POST", path: "/runs", responder: () => jsonResponse(202, { run: { id: "run_provider_1", status: "queued" } }) },
      { method: "GET", path: "/runs/run_provider_1", responder: () => jsonResponse(200, { run: { id: "run_provider_1", status: "queued" } }) },
      { method: "GET", path: "/runs/run_provider_1", responder: () => jsonResponse(200, { run: { id: "run_provider_1", status: "running" } }) }
    ]);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      runtimeMode: "codex.exec_json",
      confirmProviderSpend: true,
      fetchImpl,
      timeoutMs: 150,
      now: makeNow([0, 50, 100, 151, 200, 250, 300])
    });
    expectFailure(result, "provider_canary_timeout");
  });

  test("provider mode returns provider_canary_run_failed for failed terminal status", async () => {
    const baseUrl = "https://switchyard.example";
    const { fetchImpl } = createPlannedFetch(baseUrl, [
      { method: "GET", path: "/auth/whoami", responder: () => jsonResponse(200, { auth: {} }) },
      { method: "GET", path: "/entitlements", responder: () => jsonResponse(200, { entitlement: {} }) },
      { method: "GET", path: "/ready", responder: () => jsonResponse(200, { ok: true, checks: {} }) },
      { method: "POST", path: "/runs", responder: () => jsonResponse(202, { run: { id: "run_provider_1", status: "queued" } }) },
      { method: "GET", path: "/runs/run_provider_1", responder: () => jsonResponse(200, { run: { id: "run_provider_1", status: "failed" } }) }
    ]);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      runtimeMode: "codex.exec_json",
      confirmProviderSpend: true,
      fetchImpl
    });
    expectFailure(result, "provider_canary_run_failed");
  });

  test("provider mode returns provider_canary_artifact_missing", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("provider output");
    const plan = buildProviderHappyPlan(bytes, "codex.exec_json");
    plan[6] = {
      method: "GET",
      path: "/runs/run_provider_1/artifacts",
      responder: () => jsonResponse(200, { artifacts: [] })
    };
    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      runtimeMode: "codex.exec_json",
      confirmProviderSpend: true,
      fetchImpl
    });
    expectFailure(result, "provider_canary_artifact_missing");
  });

  test("provider mode returns provider_canary_metrics_failed", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("provider output");
    const plan = buildProviderHappyPlan(bytes, "codex.exec_json");
    plan[8] = {
      method: "GET",
      path: "/metrics",
      responder: () => jsonResponse(403, { code: "forbidden" })
    };
    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      runtimeMode: "codex.exec_json",
      confirmProviderSpend: true,
      fetchImpl
    });
    expectFailure(result, "provider_canary_metrics_failed");
  });

  test("provider mode returns provider_canary_audit_failed", async () => {
    const baseUrl = "https://switchyard.example";
    const bytes = new TextEncoder().encode("provider output");
    const plan = buildProviderHappyPlan(bytes, "codex.exec_json");
    plan[9] = {
      method: "GET",
      path: "/audit/events",
      responder: () => jsonResponse(200, { events: [] })
    };
    plan.splice(10, 0, {
      method: "GET",
      path: "/audit/events",
      responder: () => jsonResponse(200, { events: [] })
    });
    const { fetchImpl } = createPlannedFetch(baseUrl, plan);

    const result = await runProductionCanary({
      baseUrl,
      apiKey: "test-key",
      runtimeMode: "codex.exec_json",
      confirmProviderSpend: true,
      fetchImpl,
      timeoutMs: 700,
      now: makeNow([0, 50, 100, 150, 200, 250, 300, 350, 500, 700, 900])
    });
    expectFailure(result, "provider_canary_audit_failed");
  });
});
