import { describe, expect, it } from "vitest";
import { AdapterProtocolError } from "@switchyard/core";
import { runtimeModeSchema } from "@switchyard/contracts";
import { GenericHttpAsyncRestAdapter } from "../src/index.js";
import { startFakeHttpRuntimeServer } from "@switchyard/testkit";

describe("GenericHttpAsyncRestAdapter", () => {
  it("exposes manifest that matches generic_http.async_rest runtime mode", () => {
    const adapter = new GenericHttpAsyncRestAdapter();
    expect(adapter.manifest.runtimeModeSlug).toBe("generic_http.async_rest");
    expect(adapter.manifest.adapterType).toBe("http");
    expect(adapter.manifest.kind).toBe("async_rest");
    expect(adapter.manifest.capabilities).toContain("auth.api_key");
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
        state: "unknown",
        canRun: false,
        installed: false,
        auth: "unknown",
        version: null,
        checkedAt: "2026-05-29T00:00:00.000Z",
        reasonCode: "generic_http_config_missing",
        message: "missing"
      },
      docsPath: adapter.manifest.docsPath,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z"
    });
    expect(mode.slug).toBe("generic_http.async_rest");
  });

  it("maps missing and invalid base URLs in check()", async () => {
    const missing = new GenericHttpAsyncRestAdapter();
    const missingCheck = await missing.check();
    expect(missingCheck.ok).toBe(false);
    expect((missingCheck.details?.["availability"] as Record<string, unknown>)["reasonCode"]).toBe("generic_http_config_missing");

    const invalid = new GenericHttpAsyncRestAdapter({ baseUrl: "ftp://example.test" });
    const invalidCheck = await invalid.check();
    expect(invalidCheck.ok).toBe(false);
    expect((invalidCheck.details?.["availability"] as Record<string, unknown>)["reasonCode"]).toBe("generic_http_config_invalid");
  });

  it("maps health success and failures", async () => {
    const happyServer = await startFakeHttpRuntimeServer({ scenario: "happy" });
    const badServer = await startFakeHttpRuntimeServer({ scenario: "health_http_500" });
    const invalidServer = await startFakeHttpRuntimeServer({ scenario: "invalid_health_json" });
    const oversizedServer = await startFakeHttpRuntimeServer({ scenario: "oversized_health_response" });
    try {
      const ok = await new GenericHttpAsyncRestAdapter({ baseUrl: happyServer.baseUrl }).check();
      expect(ok.ok).toBe(true);
      expect((ok.details?.["availability"] as Record<string, unknown>)["state"]).toBe("available");

      const unavailable = await new GenericHttpAsyncRestAdapter({ baseUrl: badServer.baseUrl }).check();
      expect(unavailable.ok).toBe(false);
      expect((unavailable.details?.["availability"] as Record<string, unknown>)["reasonCode"]).toBe("generic_http_health_unavailable");

      const invalid = await new GenericHttpAsyncRestAdapter({ baseUrl: invalidServer.baseUrl }).check();
      expect(invalid.ok).toBe(false);
      expect((invalid.details?.["availability"] as Record<string, unknown>)["reasonCode"]).toBe("generic_http_health_invalid");

      const oversized = await new GenericHttpAsyncRestAdapter({
        baseUrl: oversizedServer.baseUrl,
        maxResponseBytes: 32
      }).check();
      expect(oversized.ok).toBe(false);
      expect((oversized.details?.["availability"] as Record<string, unknown>)["reasonCode"]).toBe("check_output_too_large");
    } finally {
      await happyServer.close();
      await badServer.close();
      await invalidServer.close();
      await oversizedServer.close();
    }
  });

  it("streams happy events and returns transcript artifacts", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "happy" });
    try {
      const adapter = new GenericHttpAsyncRestAdapter({ baseUrl: server.baseUrl });
      const start = await adapter.start({
        runId: "run_happy",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "happy",
        metadata: {}
      });
      const events = [];
      for await (const event of adapter.events({ ...start, runId: "run_happy" })) {
        events.push(event);
      }
      const artifacts = await adapter.artifacts({ ...start, runId: "run_happy" });

      expect(events.map((event) => event.type)).toEqual(["runtime.status", "runtime.output", "run.completed"]);
      expect(start.externalSessionKey).toMatch(/^ext_run_/);
      expect(artifacts.some((artifact) => artifact.path === "runs/run_happy/generic-http-transcript.jsonl")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("handles terminal=true without terminal events and fails non-terminal fallback status", async () => {
    const completedServer = await startFakeHttpRuntimeServer({
      scenario: "terminal_flag_without_terminal_event",
      terminalStatus: "completed"
    });
    const runningServer = await startFakeHttpRuntimeServer({
      scenario: "terminal_flag_without_terminal_event",
      terminalStatus: "running"
    });
    try {
      const completedAdapter = new GenericHttpAsyncRestAdapter({ baseUrl: completedServer.baseUrl });
      const completedSession = await completedAdapter.start({
        runId: "run_term_ok",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "terminal",
        metadata: {}
      });
      const completedEvents = [];
      for await (const event of completedAdapter.events({ ...completedSession, runId: "run_term_ok" })) {
        completedEvents.push(event);
      }
      expect(completedEvents.at(-1)?.type).toBe("run.completed");

      const failingAdapter = new GenericHttpAsyncRestAdapter({ baseUrl: runningServer.baseUrl });
      const failingSession = await failingAdapter.start({
        runId: "run_term_bad",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "terminal",
        metadata: {}
      });
      const failingEvents = [];
      for await (const event of failingAdapter.events({ ...failingSession, runId: "run_term_bad" })) {
        failingEvents.push(event);
      }
      expect(failingEvents.at(-1)?.type).toBe("run.failed");
      expect(String(failingEvents.at(-1)?.payload.error)).toContain("generic_http_invalid_events_response");
    } finally {
      await completedServer.close();
      await runningServer.close();
    }
  });

  it("supports absent event ids with local dedupe fallback", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "events_without_ids" });
    try {
      const adapter = new GenericHttpAsyncRestAdapter({ baseUrl: server.baseUrl });
      const session = await adapter.start({
        runId: "run_no_ids",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "no ids",
        metadata: {}
      });
      const events = [];
      for await (const event of adapter.events({ ...session, runId: "run_no_ids" })) {
        events.push(event);
      }
      expect(events.filter((event) => event.type === "runtime.output")).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
      expect(events[0]?.payload["sourceEventId"]).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("verifies cancel terminal status and rejects unverified cancel responses", async () => {
    const okServer = await startFakeHttpRuntimeServer({ scenario: "cancellation" });
    const runningAckServer = await startFakeHttpRuntimeServer({ scenario: "cancel_accepted_but_status_running" });
    const falseServer = await startFakeHttpRuntimeServer({ scenario: "cancel_false" });
    const missingServer = await startFakeHttpRuntimeServer({ scenario: "cancel_404_nonterminal" });
    const oversizedServer = await startFakeHttpRuntimeServer({ scenario: "oversized_cancel_response" });
    try {
      const okAdapter = new GenericHttpAsyncRestAdapter({ baseUrl: okServer.baseUrl });
      const okSession = await okAdapter.start({
        runId: "run_cancel_ok",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "cancel",
        metadata: {}
      });
      await expect(okAdapter.cancel({ ...okSession, runId: "run_cancel_ok" })).resolves.toBeUndefined();

      for (const scenario of [
        { server: runningAckServer, id: "run_cancel_running" },
        { server: falseServer, id: "run_cancel_false" },
        { server: missingServer, id: "run_cancel_404" }
      ]) {
        const adapter = new GenericHttpAsyncRestAdapter({ baseUrl: scenario.server.baseUrl });
        const session = await adapter.start({
          runId: scenario.id,
          runtime: "generic_http",
          runtimeMode: "generic_http.async_rest",
          provider: "generic_http",
          model: "generic-http-default",
          cwd: "/repo",
          task: "cancel",
          metadata: {}
        });
        await expect(adapter.cancel({ ...session, runId: scenario.id })).rejects.toMatchObject({
          code: "adapter_protocol_failed",
          reasonCode: "generic_http_cancel_failed"
        } satisfies Partial<AdapterProtocolError>);
      }

      const oversizedAdapter = new GenericHttpAsyncRestAdapter({
        baseUrl: oversizedServer.baseUrl,
        maxResponseBytes: 512
      });
      const oversizedSession = await oversizedAdapter.start({
        runId: "run_cancel_oversized",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "cancel",
        metadata: {}
      });
      await expect(oversizedAdapter.cancel({ ...oversizedSession, runId: "run_cancel_oversized" })).rejects.toMatchObject({
        code: "adapter_protocol_failed",
        reasonCode: "generic_http_cancel_response_too_large"
      } satisfies Partial<AdapterProtocolError>);
    } finally {
      await okServer.close();
      await runningAckServer.close();
      await falseServer.close();
      await missingServer.close();
      await oversizedServer.close();
    }
  });

  it("rejects input and sanitizes unsafe artifact names", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "unsafe_artifact_name" });
    try {
      const adapter = new GenericHttpAsyncRestAdapter({ baseUrl: server.baseUrl });
      const session = await adapter.start({
        runId: "run_artifact",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "artifact",
        metadata: {}
      });
      await expect(adapter.send({ ...session, runId: "run_artifact" }, { text: "continue" })).rejects.toMatchObject({
        code: "adapter_protocol_failed",
        reasonCode: "generic_http_input_unsupported"
      } satisfies Partial<AdapterProtocolError>);

      const artifacts = await adapter.artifacts({ ...session, runId: "run_artifact" });
      const unsafe = artifacts.find((artifact) => artifact.path.includes("generic-http/"))!;
      expect(unsafe.path).not.toContain("..");
      expect(unsafe.metadata["originalName"]).toBe("../../escape.log");
    } finally {
      await server.close();
    }
  });

  it("never leaks auth tokens in check details, errors, or transcript artifacts", async () => {
    const token = "secret-r4-token";
    const server = await startFakeHttpRuntimeServer({
      scenario: "health_http_500",
      expectedAuthToken: token
    });
    try {
      const adapter = new GenericHttpAsyncRestAdapter({
        baseUrl: server.baseUrl,
        authToken: token
      });
      const check = await adapter.check();
      expect(JSON.stringify(check)).not.toContain(token);

      const started = await adapter.start({
        runId: "run_token",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "token",
        metadata: {}
      });
      const artifacts = await adapter.artifacts({ ...started, runId: "run_token" });
      expect(JSON.stringify(artifacts)).not.toContain(token);
    } finally {
      await server.close();
    }
  });
});
