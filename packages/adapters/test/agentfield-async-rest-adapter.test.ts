import { describe, expect, it } from "vitest";
import { AdapterProtocolError } from "@switchyard/core";
import { runtimeModeSchema, type SwitchyardEvent } from "@switchyard/contracts";
import { AgentFieldAsyncRestAdapter } from "../src/index.js";
import { startFakeAgentFieldServer } from "@switchyard/testkit";

describe("AgentFieldAsyncRestAdapter", () => {
  it("exposes manifest that matches agentfield.async_rest runtime mode", () => {
    const adapter = new AgentFieldAsyncRestAdapter();
    expect(adapter.manifest.runtimeModeSlug).toBe("agentfield.async_rest");
    expect(adapter.manifest.capabilities).toContain("auth.api_key");
    expect(adapter.manifest.capabilities).toContain("run.input");
    expect(adapter.manifest.capabilities).toContain("approval.bridge");
    expect(adapter.manifest.capabilities).not.toContain("run.cancel");
    expect(adapter.manifest.placement.hosted).toMatchObject({
      support: "conditional",
      reason: expect.stringContaining("operator opt-in")
    });
    expect(adapter.manifest.limitations.map((limitation) => limitation.code)).toEqual([
      "configured_wrapper_only",
      "hosted_bridge_readiness_required",
      "no_hosted_cancel_bridge",
      "production_forbidden"
    ]);

    const mode = runtimeModeSchema.parse({
      id: adapter.manifest.runtimeModeId,
      slug: adapter.manifest.runtimeModeSlug,
      name: adapter.manifest.name,
      providerId: adapter.manifest.providerId,
      runtimeId: adapter.manifest.runtimeId,
      adapterId: adapter.manifest.adapterId,
      adapterType: adapter.manifest.adapterType,
      kind: adapter.manifest.kind,
      status: "unknown",
      capabilities: adapter.manifest.capabilities,
      limitations: adapter.manifest.limitations,
      placement: adapter.manifest.placement,
      availability: {
        state: "unavailable",
        canRun: false,
        installed: false,
        auth: "missing",
        version: null,
        checkedAt: "2026-05-30T00:00:00.000Z",
        reasonCode: "agentfield_config_missing",
        message: "missing config"
      },
      docsPath: adapter.manifest.docsPath,
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z"
    });
    expect(mode.slug).toBe("agentfield.async_rest");
  });

  it("reports missing and invalid config in check()", async () => {
    const missing = new AgentFieldAsyncRestAdapter();
    const missingCheck = await missing.check();
    expect(missingCheck.ok).toBe(false);
    expect((missingCheck.details?.["availability"] as Record<string, unknown>)["reasonCode"]).toBe("agentfield_config_missing");

    const invalid = new AgentFieldAsyncRestAdapter({
      baseUrl: "ftp://agentfield.example.test",
      apiKey: "af-key",
      target: "research-agent.deep_analysis"
    });
    const invalidCheck = await invalid.check();
    expect(invalidCheck.ok).toBe(false);
    expect((invalidCheck.details?.["availability"] as Record<string, unknown>)["reasonCode"]).toBe("agentfield_config_invalid");
  });

  it("checks health and discovery without leaking api key", async () => {
    const server = await startFakeAgentFieldServer({
      scenario: "bridge_happy",
      expectedApiKey: "af-secret-key"
    });
    try {
      const checked = await new AgentFieldAsyncRestAdapter({
        baseUrl: server.baseUrl,
        apiKey: "af-secret-key",
        target: "research-agent.deep_analysis"
      }).check();

      expect(checked.ok).toBe(true);
      expect((checked.details?.["bridge"] as Record<string, unknown>)["bridgeCapable"]).toBe(true);
      const detailsText = JSON.stringify(checked.details ?? {});
      expect(detailsText).not.toContain("af-secret-key");
      expect(server.stats.executeAsyncCalls).toBe(0);
      expect(server.stats.healthCalls).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("fails bridge readiness closed when discovery does not advertise bridge capabilities", async () => {
    const server = await startFakeAgentFieldServer({ scenario: "bridge_capability_missing" });
    const unavailable = await startFakeAgentFieldServer({ scenario: "discovery_unavailable" });
    try {
      for (const handle of [server, unavailable]) {
        const checked = await new AgentFieldAsyncRestAdapter({
          baseUrl: handle.baseUrl,
          apiKey: "key-1",
          target: "research-agent.deep_analysis"
        }).check();
        expect(checked.ok).toBe(true);
        expect((checked.details?.["availability"] as Record<string, unknown>)["canRun"]).toBe(true);
        expect(checked.details?.["bridge"]).toMatchObject({
          bridgeCapable: false,
          reasonCode: "agentfield_bridge_capability_missing"
        });
      }
    } finally {
      await server.close();
      await unavailable.close();
    }
  });

  it("starts, polls, emits normalized output/completion, and returns transcript/summary artifacts", async () => {
    const server = await startFakeAgentFieldServer({ scenario: "happy" });
    try {
      const adapter = new AgentFieldAsyncRestAdapter({
        baseUrl: server.baseUrl,
        apiKey: "key-1",
        target: "research-agent.deep_analysis",
        pollIntervalMs: 5
      });

      const start = await adapter.start({
        runId: "run_happy",
        runtime: "agentfield",
        runtimeMode: "agentfield.async_rest",
        provider: "agentfield",
        model: "agentfield-default",
        cwd: "/repo",
        task: "happy",
        metadata: {}
      });
      expect(start.externalSessionKey).toMatch(/^exec_/);

      const events = [];
      for await (const event of adapter.events({ ...start, runId: "run_happy" })) {
        events.push(event);
      }
      expect(events.map((event) => event.type)).toContain("runtime.output");
      expect(events.at(-1)?.type).toBe("run.completed");

      const artifacts = await adapter.artifacts({ ...start, runId: "run_happy" });
      expect(artifacts.some((artifact) => artifact.path.endsWith("/agentfield-transcript.jsonl"))).toBe(true);
      expect(artifacts.some((artifact) => artifact.path.endsWith("/agentfield-summary.json"))).toBe(true);
      expect(artifacts.some((artifact) => artifact.metadata["agentfieldExecutionId"] === start.externalSessionKey)).toBe(true);
      expect(JSON.stringify(artifacts)).not.toContain("agentfield output");
    } finally {
      await server.close();
    }
  });

  it("maps upstream terminal status failures with named reason codes", async () => {
    const failedServer = await startFakeAgentFieldServer({ scenario: "upstream_failed" });
    const cancelledServer = await startFakeAgentFieldServer({ scenario: "upstream_cancelled" });
    const timeoutServer = await startFakeAgentFieldServer({ scenario: "upstream_timeout" });
    try {
      for (const scenario of [
        { server: failedServer, reason: "agentfield_status_failed", runId: "run_failed" },
        { server: cancelledServer, reason: "agentfield_upstream_cancelled", runId: "run_cancelled" },
        { server: timeoutServer, reason: "agentfield_upstream_timeout", runId: "run_timeout" }
      ]) {
        const adapter = new AgentFieldAsyncRestAdapter({
          baseUrl: scenario.server.baseUrl,
          apiKey: "key-1",
          target: "research-agent.deep_analysis",
          pollIntervalMs: 5
        });
        const start = await adapter.start({
          runId: scenario.runId,
          runtime: "agentfield",
          runtimeMode: "agentfield.async_rest",
          provider: "agentfield",
          model: "agentfield-default",
          cwd: "/repo",
          task: "status failure",
          metadata: {}
        });
        const events = [];
        for await (const event of adapter.events({ ...start, runId: scenario.runId })) {
          events.push(event);
        }
        expect(events.at(-1)).toMatchObject({
          type: "run.failed",
          payload: {
            error: scenario.reason
          }
        });
      }
    } finally {
      await failedServer.close();
      await cancelledServer.close();
      await timeoutServer.close();
    }
  });

  it("sends bridge input and approval resolution to configured execution endpoints", async () => {
    const server = await startFakeAgentFieldServer({ scenario: "bridge_happy" });
    try {
      const adapter = new AgentFieldAsyncRestAdapter({
        baseUrl: server.baseUrl,
        apiKey: "key-1",
        target: "research-agent.deep_analysis",
        pollIntervalMs: 5
      });
      const start = await adapter.start({
        runId: "run_bridge_send",
        runtime: "agentfield",
        runtimeMode: "agentfield.async_rest",
        provider: "agentfield",
        model: "agentfield-default",
        cwd: "/repo",
        task: "pending",
        metadata: {}
      });

      await adapter.send({ ...start, runId: "run_bridge_send" }, {
        type: "input",
        text: "continue",
        switchyardRunId: "run_bridge_send",
        bridgeCommandId: "cmd_input_1",
        idempotencyKey: "idem_input_1"
      });
      expect(server.stats.inputCalls).toBe(1);
      expect(server.stats.lastInput).toMatchObject({
        switchyardRunId: "run_bridge_send",
        bridgeCommandId: "cmd_input_1",
        idempotencyKey: "idem_input_1",
        type: "input",
        input: {
          text: "continue"
        }
      });

      await adapter.send({ ...start, runId: "run_bridge_send" }, {
        type: "approval_resolution",
        switchyardRunId: "run_bridge_send",
        bridgeCommandId: "cmd_approval_1",
        idempotencyKey: "idem_approval_1",
        runtimeApprovalToken: "af_approval_1",
        decision: "rejected",
        message: "rejected by hosted-api",
        answers: { confirmed: false }
      });
      expect(server.stats.approvalResolutionCalls).toBe(1);
      expect(server.stats.lastApprovalToken).toBe("af_approval_1");
      expect(server.stats.lastApprovalResolution).toMatchObject({
        switchyardRunId: "run_bridge_send",
        bridgeCommandId: "cmd_approval_1",
        idempotencyKey: "idem_approval_1",
        decision: "rejected",
        message: "rejected by hosted-api",
        answers: { confirmed: false }
      });
    } finally {
      await server.close();
    }
  });

  it("rejects invalid bridge input and approval resolution payloads before upstream dispatch", async () => {
    const server = await startFakeAgentFieldServer({ scenario: "pending_forever" });
    try {
      const adapter = new AgentFieldAsyncRestAdapter({
        baseUrl: server.baseUrl,
        apiKey: "key-1",
        target: "research-agent.deep_analysis",
        pollIntervalMs: 5
      });
      const start = await adapter.start({
        runId: "run_pending",
        runtime: "agentfield",
        runtimeMode: "agentfield.async_rest",
        provider: "agentfield",
        model: "agentfield-default",
        cwd: "/repo",
        task: "pending",
        metadata: {}
      });

      await expect(adapter.send({ ...start, runId: "run_pending" }, { type: "input", text: " " })).rejects.toMatchObject({
        code: "adapter_protocol_failed",
        reasonCode: "runtime_input_empty"
      } satisfies Partial<AdapterProtocolError>);
      await expect(adapter.send({ ...start, runId: "run_pending" }, {
        type: "input",
        text: "x".repeat(64 * 1024 + 1)
      })).rejects.toMatchObject({
        code: "adapter_protocol_failed",
        reasonCode: "runtime_input_too_large"
      } satisfies Partial<AdapterProtocolError>);
      await expect(adapter.send({ ...start, runId: "run_pending" }, {
        type: "input",
        text: "continue",
        switchyardRunId: "run_pending",
        idempotencyKey: "idem_missing_command"
      })).rejects.toMatchObject({
        code: "adapter_protocol_failed",
        reasonCode: "agentfield_input_failed"
      } satisfies Partial<AdapterProtocolError>);
      for (const payload of [
        { type: "approval_resolution", decision: "approved", answers: {} },
        { type: "approval_resolution", runtimeApprovalToken: "af_approval_1", answers: {} },
        { type: "approval_resolution", runtimeApprovalToken: "af_approval_1", decision: "maybe", answers: {} },
        { type: "approval_resolution", runtimeApprovalToken: "af_approval_1", decision: "approved", answers: "yes" },
        {
          type: "approval_resolution",
          runtimeApprovalToken: "af_approval_1",
          decision: "approved",
          switchyardRunId: "run_pending",
          bridgeCommandId: "cmd_missing_idem",
          answers: {}
        }
      ]) {
        await expect(adapter.send({ ...start, runId: "run_pending" }, payload)).rejects.toMatchObject({
          code: "adapter_protocol_failed",
          reasonCode: "agentfield_approval_request_invalid"
        } satisfies Partial<AdapterProtocolError>);
      }
      expect(server.stats.inputCalls).toBe(0);
      expect(server.stats.approvalResolutionCalls).toBe(0);

      await expect(adapter.cancel({ ...start, runId: "run_pending" })).rejects.toMatchObject({
        code: "adapter_protocol_failed",
        reasonCode: "agentfield_cancel_unsupported"
      } satisfies Partial<AdapterProtocolError>);
    } finally {
      await server.close();
    }
  });

  it("maps waiting_for_input and waiting_for_approval polling states", async () => {
    const inputServer = await startFakeAgentFieldServer({ scenario: "waiting_for_input" });
    const approvalServer = await startFakeAgentFieldServer({ scenario: "waiting_for_approval_duplicate" });
    const malformedServer = await startFakeAgentFieldServer({ scenario: "waiting_for_approval_malformed" });
    try {
      const inputAdapter = adapterFor(inputServer.baseUrl);
      const inputStart = await startRun(inputAdapter, "run_waiting_input", "waiting input");
      const inputEvents = await collectAgentFieldEvents(inputAdapter, { ...inputStart, runId: "run_waiting_input" }, (event) =>
        event.type === "runtime.status" && event.payload["status"] === "waiting_for_input"
      );
      expect(inputEvents.at(-1)).toMatchObject({
        type: "runtime.status",
        payload: {
          status: "waiting_for_input"
        }
      });

      const approvalAdapter = adapterFor(approvalServer.baseUrl);
      const approvalStart = await startRun(approvalAdapter, "run_waiting_approval", "waiting approval");
      const approvalEvents = await collectAgentFieldEvents(approvalAdapter, { ...approvalStart, runId: "run_waiting_approval" }, (event) =>
        event.type === "approval.requested"
      );
      expect(approvalEvents.filter((event) => event.type === "approval.requested")).toHaveLength(1);
      expect(approvalEvents.at(-1)).toMatchObject({
        type: "approval.requested",
        payload: {
          runtimeApprovalToken: "af_approval_1",
          approvalType: "before_external_message",
          expiresAt: "2026-06-04T20:00:00.000Z"
        }
      });

      const malformedAdapter = adapterFor(malformedServer.baseUrl);
      const malformedStart = await startRun(malformedAdapter, "run_malformed_approval", "malformed approval");
      const malformedEvents = await collectAgentFieldEvents(malformedAdapter, { ...malformedStart, runId: "run_malformed_approval" }, (event) =>
        event.type === "run.failed"
      );
      expect(malformedEvents.at(-1)).toMatchObject({
        type: "run.failed",
        payload: {
          error: "agentfield_approval_request_invalid"
        }
      });
    } finally {
      await inputServer.close();
      await approvalServer.close();
      await malformedServer.close();
    }
  });

  it("maps bridge upstream failures and malformed responses to R25 reason codes", async () => {
    const inputPayload = { type: "input", text: "continue", switchyardRunId: "run_bridge", bridgeCommandId: "cmd_bridge", idempotencyKey: "idem_bridge" };
    const approvalPayload = {
      type: "approval_resolution",
      runtimeApprovalToken: "af_approval_1",
      decision: "approved",
      switchyardRunId: "run_bridge",
      bridgeCommandId: "cmd_bridge",
      idempotencyKey: "idem_bridge",
      answers: {}
    };
    for (const scenario of [
      { scenario: "bridge_input_http_500" as const, payload: inputPayload, reasonCode: "agentfield_input_failed" },
      { scenario: "bridge_input_invalid_json" as const, payload: inputPayload, reasonCode: "agentfield_invalid_input_response" },
      { scenario: "bridge_input_malformed_response" as const, payload: inputPayload, reasonCode: "agentfield_invalid_input_response" },
      { scenario: "bridge_input_oversized_response" as const, payload: inputPayload, reasonCode: "agentfield_input_response_too_large", maxResponseBytes: 64 },
      {
        scenario: "bridge_approval_http_500" as const,
        payload: approvalPayload,
        reasonCode: "agentfield_approval_resolution_failed"
      },
      {
        scenario: "bridge_approval_invalid_json" as const,
        payload: approvalPayload,
        reasonCode: "agentfield_invalid_approval_response"
      },
      {
        scenario: "bridge_approval_malformed_response" as const,
        payload: approvalPayload,
        reasonCode: "agentfield_invalid_approval_response"
      },
      {
        scenario: "bridge_approval_oversized_response" as const,
        payload: approvalPayload,
        reasonCode: "agentfield_approval_response_too_large",
        maxResponseBytes: 64
      }
    ]) {
      const server = await startFakeAgentFieldServer({ scenario: scenario.scenario });
      try {
        const adapter = adapterFor(server.baseUrl, scenario.maxResponseBytes);
        const start = await startRun(adapter, `run_${scenario.scenario}`, scenario.scenario);
        await expect(adapter.send({ ...start, runId: `run_${scenario.scenario}` }, scenario.payload)).rejects.toMatchObject({
          code: "adapter_protocol_failed",
          reasonCode: scenario.reasonCode
        } satisfies Partial<AdapterProtocolError>);
      } finally {
        await server.close();
      }
    }
  });

  it("scrubs runtime approval tokens from logs and transcript artifacts", async () => {
    const runtimeApprovalToken = "af_secret_runtime_approval_token";
    const logs: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const server = await startFakeAgentFieldServer({ scenario: "bridge_happy" });
    try {
      const adapter = new AgentFieldAsyncRestAdapter({
        baseUrl: server.baseUrl,
        apiKey: "key-1",
        target: "research-agent.deep_analysis",
        pollIntervalMs: 5,
        logger: {
          info: (event, details) => logs.push({ event, details }),
          warn: (event, details) => logs.push({ event, details }),
          error: (event, details) => logs.push({ event, details })
        }
      });
      const start = await startRun(adapter, "run_scrub_approval_token", "scrub token");
      await adapter.send({ ...start, runId: "run_scrub_approval_token" }, {
        type: "approval_resolution",
        switchyardRunId: "run_scrub_approval_token",
        bridgeCommandId: "cmd_scrub",
        idempotencyKey: "idem_scrub",
        runtimeApprovalToken,
        decision: "approved",
        answers: {}
      });

      expect(JSON.stringify(logs)).not.toContain(runtimeApprovalToken);
      expect(JSON.stringify(logs)).toContain(":runtimeApprovalToken");
      const artifacts = await adapter.artifacts({ ...start, runId: "run_scrub_approval_token" });
      const artifactText = JSON.stringify(artifacts);
      expect(artifactText).not.toContain(runtimeApprovalToken);
      expect(artifactText).toContain(":runtimeApprovalToken");
    } finally {
      await server.close();
    }
  });

  it("maps network and malformed responses with agentfield-specific reason codes", async () => {
    const unknownStatusServer = await startFakeAgentFieldServer({ scenario: "unknown_status" });
    const malformedStatusServer = await startFakeAgentFieldServer({ scenario: "invalid_status_json" });
    try {
      const unknownAdapter = new AgentFieldAsyncRestAdapter({
        baseUrl: unknownStatusServer.baseUrl,
        apiKey: "key-1",
        target: "research-agent.deep_analysis",
        pollIntervalMs: 5
      });
      const unknownStart = await unknownAdapter.start({
        runId: "run_unknown_status",
        runtime: "agentfield",
        runtimeMode: "agentfield.async_rest",
        provider: "agentfield",
        model: "agentfield-default",
        cwd: "/repo",
        task: "unknown status",
        metadata: {}
      });
      const unknownEvents = [];
      for await (const event of unknownAdapter.events({ ...unknownStart, runId: "run_unknown_status" })) {
        unknownEvents.push(event);
      }
      expect(unknownEvents.at(-1)).toMatchObject({
        type: "run.failed",
        payload: {
          error: "agentfield_unknown_status"
        }
      });

      const malformedAdapter = new AgentFieldAsyncRestAdapter({
        baseUrl: malformedStatusServer.baseUrl,
        apiKey: "key-1",
        target: "research-agent.deep_analysis",
        pollIntervalMs: 5
      });
      const malformedStart = await malformedAdapter.start({
        runId: "run_invalid_status",
        runtime: "agentfield",
        runtimeMode: "agentfield.async_rest",
        provider: "agentfield",
        model: "agentfield-default",
        cwd: "/repo",
        task: "malformed status",
        metadata: {}
      });
      const malformedEvents = [];
      for await (const event of malformedAdapter.events({ ...malformedStart, runId: "run_invalid_status" })) {
        malformedEvents.push(event);
      }
      expect(malformedEvents.at(-1)).toMatchObject({
        type: "run.failed",
        payload: {
          error: "agentfield_invalid_status_response"
        }
      });

      const brokenFetchAdapter = new AgentFieldAsyncRestAdapter({
        baseUrl: "http://127.0.0.1:9",
        apiKey: "key-1",
        target: "research-agent.deep_analysis",
        requestTimeoutMs: 10
      });
      await expect(
        brokenFetchAdapter.start({
          runId: "run_network_error",
          runtime: "agentfield",
          runtimeMode: "agentfield.async_rest",
          provider: "agentfield",
          model: "agentfield-default",
          cwd: "/repo",
          task: "network error",
          metadata: {}
        })
      ).rejects.toThrow("agentfield_request_failed");
    } finally {
      await unknownStatusServer.close();
      await malformedStatusServer.close();
    }
  });

  it("redacts api key from events and transcript artifacts", async () => {
    const apiKey = "af-redact-me";
    const server = await startFakeAgentFieldServer({
      scenario: "error_echo_secret",
      expectedApiKey: apiKey
    });
    try {
      const adapter = new AgentFieldAsyncRestAdapter({
        baseUrl: server.baseUrl,
        apiKey,
        target: "research-agent.deep_analysis",
        pollIntervalMs: 5
      });
      const start = await adapter.start({
        runId: "run_redact",
        runtime: "agentfield",
        runtimeMode: "agentfield.async_rest",
        provider: "agentfield",
        model: "agentfield-default",
        cwd: "/repo",
        task: "redact",
        metadata: {}
      });

      const events = [];
      for await (const event of adapter.events({ ...start, runId: "run_redact" })) {
        events.push(event);
      }
      const eventText = JSON.stringify(events);
      expect(eventText).not.toContain(apiKey);

      const artifacts = await adapter.artifacts({ ...start, runId: "run_redact" });
      const artifactText = JSON.stringify(artifacts);
      expect(artifactText).not.toContain(apiKey);
      expect(artifactText).not.toContain("Authorization: Bearer");
      expect(artifactText).not.toContain("secret-token");
    } finally {
      await server.close();
    }
  });
});

function adapterFor(baseUrl: string, maxResponseBytes?: number): AgentFieldAsyncRestAdapter {
  return new AgentFieldAsyncRestAdapter({
    baseUrl,
    apiKey: "key-1",
    target: "research-agent.deep_analysis",
    pollIntervalMs: 5,
    ...(maxResponseBytes ? { maxResponseBytes } : {})
  });
}

async function startRun(adapter: AgentFieldAsyncRestAdapter, runId: string, task: string) {
  return adapter.start({
    runId,
    runtime: "agentfield",
    runtimeMode: "agentfield.async_rest",
    provider: "agentfield",
    model: "agentfield-default",
    cwd: "/repo",
    task,
    metadata: {}
  });
}

async function collectAgentFieldEvents(
  adapter: AgentFieldAsyncRestAdapter,
  session: Record<string, unknown>,
  stop: (event: SwitchyardEvent) => boolean
): Promise<SwitchyardEvent[]> {
  const events: SwitchyardEvent[] = [];
  for await (const event of adapter.events(session)) {
    events.push(event);
    if (stop(event)) {
      break;
    }
  }
  return events;
}
