import { describe, expect, it } from "vitest";
import { AdapterProtocolError } from "@switchyard/core";
import { runtimeModeSchema } from "@switchyard/contracts";
import { AgentFieldAsyncRestAdapter } from "../src/index.js";
import { startFakeAgentFieldServer } from "@switchyard/testkit";

describe("AgentFieldAsyncRestAdapter", () => {
  it("exposes manifest that matches agentfield.async_rest runtime mode", () => {
    const adapter = new AgentFieldAsyncRestAdapter();
    expect(adapter.manifest.runtimeModeSlug).toBe("agentfield.async_rest");
    expect(adapter.manifest.capabilities).toContain("auth.api_key");
    expect(adapter.manifest.capabilities).not.toContain("run.cancel");
    expect(adapter.manifest.capabilities).not.toContain("run.input");

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
      scenario: "happy",
      expectedApiKey: "af-secret-key"
    });
    try {
      const checked = await new AgentFieldAsyncRestAdapter({
        baseUrl: server.baseUrl,
        apiKey: "af-secret-key",
        target: "research-agent.deep_analysis"
      }).check();

      expect(checked.ok).toBe(true);
      const detailsText = JSON.stringify(checked.details ?? {});
      expect(detailsText).not.toContain("af-secret-key");
      expect(server.stats.executeAsyncCalls).toBe(0);
      expect(server.stats.healthCalls).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("starts, polls, emits normalized output/completion, and returns transcript/result artifacts", async () => {
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
      expect(artifacts.some((artifact) => artifact.path.endsWith("/agentfield-result.json"))).toBe(true);
      expect(artifacts.some((artifact) => artifact.metadata["agentfieldExecutionId"] === start.externalSessionKey)).toBe(true);
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

  it("reports unsupported input and unsupported active cancel", async () => {
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

      await expect(adapter.send({ ...start, runId: "run_pending" }, { text: "continue" })).rejects.toMatchObject({
        code: "adapter_protocol_failed",
        reasonCode: "agentfield_input_unsupported"
      } satisfies Partial<AdapterProtocolError>);

      await expect(adapter.cancel({ ...start, runId: "run_pending" })).rejects.toMatchObject({
        code: "adapter_protocol_failed",
        reasonCode: "agentfield_cancel_unsupported"
      } satisfies Partial<AdapterProtocolError>);
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
      expect(artifactText).toContain("[REDACTED]");
    } finally {
      await server.close();
    }
  });
});
