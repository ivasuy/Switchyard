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
    expect(adapter.manifest.capabilities).toEqual(
      expect.arrayContaining(["run.start", "run.input", "run.timeout", "approval.bridge", "event.normalized", "event.streaming", "artifact.transcript", "auth.api_key"])
    );
    expect(adapter.manifest.placement.hosted).toMatchObject({
      support: "conditional",
      reason: expect.stringContaining("operator opt-in")
    });
    expect(adapter.manifest.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "configured_wrapper_only" }),
        expect.objectContaining({ code: "hosted_bridge_readiness_required" }),
        expect.objectContaining({ code: "no_hosted_cancel_bridge" })
      ])
    );

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
      expect((ok.details?.["bridge"] as Record<string, unknown>)["reasonCode"]).toBe("generic_http_bridge_capability_missing");

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

  it("reports bridge-ready health only when required bridge capabilities are present", async () => {
    const readyServer = await startFakeHttpRuntimeServer({ scenario: "bridge_happy" });
    const missingServer = await startFakeHttpRuntimeServer({ scenario: "bridge_capability_missing" });
    try {
      const ready = await new GenericHttpAsyncRestAdapter({ baseUrl: readyServer.baseUrl }).check();
      expect(ready.ok).toBe(true);
      expect(ready.details?.["bridge"]).toMatchObject({
        state: "ready",
        canBridge: true,
        reasonCode: null,
        capabilities: expect.arrayContaining(["input", "approval_request", "approval_resolution"])
      });

      const missing = await new GenericHttpAsyncRestAdapter({ baseUrl: missingServer.baseUrl }).check();
      expect(missing.ok).toBe(true);
      expect(missing.details?.["bridge"]).toMatchObject({
        state: "unavailable",
        canBridge: false,
        reasonCode: "generic_http_bridge_capability_missing"
      });
      expect(missingServer.stats().startRequests).toBe(0);
    } finally {
      await readyServer.close();
      await missingServer.close();
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

  it("sends bridge input to the configured wrapper endpoint", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "bridge_happy" });
    try {
      const adapter = new GenericHttpAsyncRestAdapter({ baseUrl: server.baseUrl });
      const session = await adapter.start({
        runId: "run_input",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "input",
        metadata: {}
      });

      await adapter.send({ ...session, runId: "run_input" }, {
        type: "input",
        switchyardRunId: "run_input",
        bridgeCommandId: "cmd_input_1",
        idempotencyKey: "idem_input_1",
        text: "continue",
        baseUrl: "https://evil.example",
        authToken: "evil-token",
        target: "evil-target",
        path: "/evil",
        header: { authorization: "Bearer evil" },
        command: "rm -rf",
        cwd: "/tmp/evil",
        argv: ["evil"],
        executable: "evil",
        env: { EVIL: "1" },
        process: { factory: "evil" },
        pty: true,
        browser: { task: "evil" },
        repo: { url: "evil" },
        sandbox: "danger-full-access"
      });

      const stats = server.stats();
      expect(stats).toMatchObject({
        inputRequests: 1,
        lastInputBody: {
          switchyardRunId: "run_input",
          bridgeCommandId: "cmd_input_1",
          idempotencyKey: "idem_input_1",
          type: "input",
          text: "continue"
        }
      });
      for (const forbidden of ["baseUrl", "authToken", "target", "path", "header", "command", "cwd", "argv", "executable", "env", "process", "pty", "browser", "repo", "sandbox"]) {
        expect(stats.lastInputBody).not.toHaveProperty(forbidden);
      }
    } finally {
      await server.close();
    }
  });

  it("rejects missing empty and oversized input before upstream dispatch", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "bridge_happy" });
    try {
      const adapter = new GenericHttpAsyncRestAdapter({ baseUrl: server.baseUrl });
      const session = await adapter.start({
        runId: "run_bad_input",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "bad input",
        metadata: {}
      });

      for (const text of [undefined, "", "   "]) {
        await expect(adapter.send({ ...session, runId: "run_bad_input" }, {
          type: "input",
          switchyardRunId: "run_bad_input",
          bridgeCommandId: "cmd_empty",
          idempotencyKey: "idem_empty",
          text
        })).rejects.toMatchObject({
          code: "adapter_protocol_failed",
          reasonCode: "runtime_input_empty"
        } satisfies Partial<AdapterProtocolError>);
      }

      await expect(adapter.send({ ...session, runId: "run_bad_input" }, {
        type: "input",
        switchyardRunId: "run_bad_input",
        bridgeCommandId: "cmd_large",
        idempotencyKey: "idem_large",
        text: "x".repeat(64 * 1024 + 1)
      })).rejects.toMatchObject({
        code: "adapter_protocol_failed",
        reasonCode: "runtime_input_too_large"
      } satisfies Partial<AdapterProtocolError>);

      expect(server.stats().inputRequests).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("maps bridge input upstream failures to R25 reason codes", async () => {
    const scenarios = [
      { scenario: "bridge_input_http_500", reasonCode: "generic_http_input_failed" },
      { scenario: "bridge_input_malformed_response", reasonCode: "generic_http_invalid_input_response" },
      { scenario: "bridge_input_invalid_json", reasonCode: "generic_http_invalid_input_response" },
      { scenario: "bridge_input_oversized_response", reasonCode: "generic_http_input_response_too_large", maxResponseBytes: 128 },
      { scenario: "bridge_input_timeout", reasonCode: "generic_http_input_failed", requestTimeoutMs: 20 }
    ] as const;

    for (const entry of scenarios) {
      const server = await startFakeHttpRuntimeServer({ scenario: entry.scenario });
      try {
        const adapter = new GenericHttpAsyncRestAdapter({
          baseUrl: server.baseUrl,
          maxResponseBytes: entry.maxResponseBytes,
          requestTimeoutMs: entry.requestTimeoutMs
        });
        const session = await adapter.start({
          runId: `run_${entry.scenario}`,
          runtime: "generic_http",
          runtimeMode: "generic_http.async_rest",
          provider: "generic_http",
          model: "generic-http-default",
          cwd: "/repo",
          task: "input failure",
          metadata: {}
        });
        await expect(adapter.send({ ...session, runId: `run_${entry.scenario}` }, {
          type: "input",
          switchyardRunId: `run_${entry.scenario}`,
          bridgeCommandId: `cmd_${entry.scenario}`,
          idempotencyKey: `idem_${entry.scenario}`,
          text: "continue"
        })).rejects.toMatchObject({
          code: "adapter_protocol_failed",
          reasonCode: entry.reasonCode
        } satisfies Partial<AdapterProtocolError>);
        expect(server.stats().inputRequests).toBe(1);
      } finally {
        await server.close();
      }
    }
  });

  it("sends approval resolution and validates malformed local payloads before upstream dispatch", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "bridge_happy" });
    try {
      const adapter = new GenericHttpAsyncRestAdapter({ baseUrl: server.baseUrl });
      const session = await adapter.start({
        runId: "run_approval_resolution",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "approval resolution",
        metadata: {}
      });

      for (const badInput of [
        { type: "approval_resolution", bridgeCommandId: "cmd_bad", idempotencyKey: "idem_bad", decision: "approved", answers: {} },
        { type: "approval_resolution", bridgeCommandId: "cmd_bad", idempotencyKey: "idem_bad", runtimeApprovalToken: "approval_token_1", decision: "maybe", answers: {} },
        { type: "approval_resolution", bridgeCommandId: "cmd_bad", idempotencyKey: "idem_bad", runtimeApprovalToken: "approval_token_1", decision: "approved", answers: "bad" }
      ]) {
        await expect(adapter.send({ ...session, runId: "run_approval_resolution" }, badInput)).rejects.toMatchObject({
          code: "adapter_protocol_failed",
          reasonCode: "generic_http_invalid_approval_response"
        } satisfies Partial<AdapterProtocolError>);
      }
      expect(server.stats().approvalResolutionRequests).toBe(0);

      await adapter.send({ ...session, runId: "run_approval_resolution" }, {
        type: "approval_resolution",
        switchyardRunId: "run_approval_resolution",
        bridgeCommandId: "cmd_approval_1",
        idempotencyKey: "idem_approval_1",
        runtimeApprovalToken: "approval_token_1",
        decision: "approved",
        message: "approved by hosted-api",
        answers: { selectedOption: "allow" },
        baseUrl: "https://evil.example",
        authToken: "evil-token",
        target: "evil-target",
        path: "/evil",
        header: { authorization: "Bearer evil" },
        command: "rm -rf",
        cwd: "/tmp/evil",
        argv: ["evil"],
        executable: "evil",
        env: { EVIL: "1" },
        process: { factory: "evil" },
        pty: true,
        browser: { task: "evil" },
        repo: { url: "evil" },
        sandbox: "danger-full-access"
      });

      const stats = server.stats();
      expect(stats).toMatchObject({
        approvalResolutionRequests: 1,
        lastApprovalResolutionToken: "approval_token_1",
        lastApprovalResolutionBody: {
          switchyardRunId: "run_approval_resolution",
          bridgeCommandId: "cmd_approval_1",
          idempotencyKey: "idem_approval_1",
          decision: "approved",
          message: "approved by hosted-api",
          answers: { selectedOption: "allow" }
        }
      });
      for (const forbidden of ["baseUrl", "authToken", "target", "path", "header", "command", "cwd", "argv", "executable", "env", "process", "pty", "browser", "repo", "sandbox"]) {
        expect(stats.lastApprovalResolutionBody).not.toHaveProperty(forbidden);
      }
    } finally {
      await server.close();
    }
  });

  it("maps approval resolution upstream failures to R25 reason codes", async () => {
    const scenarios = [
      { scenario: "bridge_approval_http_500", reasonCode: "generic_http_approval_resolution_failed" },
      { scenario: "bridge_approval_malformed_response", reasonCode: "generic_http_invalid_approval_response" },
      { scenario: "bridge_approval_invalid_json", reasonCode: "generic_http_invalid_approval_response" },
      { scenario: "bridge_approval_oversized_response", reasonCode: "generic_http_approval_response_too_large", maxResponseBytes: 128 },
      { scenario: "bridge_approval_timeout", reasonCode: "generic_http_approval_resolution_failed", requestTimeoutMs: 20 }
    ] as const;

    for (const entry of scenarios) {
      const server = await startFakeHttpRuntimeServer({ scenario: entry.scenario });
      try {
        const adapter = new GenericHttpAsyncRestAdapter({
          baseUrl: server.baseUrl,
          maxResponseBytes: entry.maxResponseBytes,
          requestTimeoutMs: entry.requestTimeoutMs
        });
        const session = await adapter.start({
          runId: `run_${entry.scenario}`,
          runtime: "generic_http",
          runtimeMode: "generic_http.async_rest",
          provider: "generic_http",
          model: "generic-http-default",
          cwd: "/repo",
          task: "approval failure",
          metadata: {}
        });
        await expect(adapter.send({ ...session, runId: `run_${entry.scenario}` }, {
          type: "approval_resolution",
          switchyardRunId: `run_${entry.scenario}`,
          bridgeCommandId: `cmd_${entry.scenario}`,
          idempotencyKey: `idem_${entry.scenario}`,
          runtimeApprovalToken: "approval_token_1",
          decision: "rejected",
          message: "rejected by hosted-api",
          answers: {}
        })).rejects.toMatchObject({
          code: "adapter_protocol_failed",
          reasonCode: entry.reasonCode
        } satisfies Partial<AdapterProtocolError>);
        expect(server.stats().approvalResolutionRequests).toBe(1);
      } finally {
        await server.close();
      }
    }
  });

  it("maps approval requested waiting resumed and unknown wrapper events", async () => {
    const approvalServer = await startFakeHttpRuntimeServer({ scenario: "approval_request" });
    const duplicateServer = await startFakeHttpRuntimeServer({ scenario: "duplicate_approval_events" });
    const malformedServer = await startFakeHttpRuntimeServer({ scenario: "malformed_approval_request" });
    const waitingServer = await startFakeHttpRuntimeServer({ scenario: "waiting_for_input_event" });
    const resumedServer = await startFakeHttpRuntimeServer({ scenario: "resumed_event" });
    const unknownServer = await startFakeHttpRuntimeServer({ scenario: "unknown_wrapper_event" });
    try {
      const approvalEvents = await collectEvents(approvalServer, "run_approval_event");
      expect(approvalEvents[0]).toMatchObject({
        type: "approval.requested",
        payload: {
          runtimeApprovalToken: "approval_token_1",
          approvalType: "before_external_message",
          message: "Wrapper requests permission.",
          expiresAt: "2026-06-04T20:00:00.000Z",
          answers: { selectedOption: "allow" },
          sourceEventId: "evt_approval_1"
        }
      });

      const duplicateEvents = await collectEvents(duplicateServer, "run_duplicate_approval");
      expect(duplicateEvents.filter((event) => event.type === "approval.requested")).toHaveLength(1);

      const malformedEvents = await collectEvents(malformedServer, "run_bad_approval_event");
      expect(malformedEvents.at(-1)).toMatchObject({
        type: "run.failed",
        payload: { error: "generic_http_approval_request_invalid" }
      });

      const waitingEvents = await collectEvents(waitingServer, "run_waiting_input");
      expect(waitingEvents[0]).toMatchObject({ type: "runtime.status", payload: { status: "waiting_for_input" } });

      const resumedEvents = await collectEvents(resumedServer, "run_resumed");
      expect(resumedEvents[0]).toMatchObject({ type: "runtime.status", payload: { status: "resumed" } });

      const unknownEvents = await collectEvents(unknownServer, "run_unknown");
      expect(unknownEvents[0]).toMatchObject({
        type: "runtime.status",
        payload: { status: "unknown_event", eventType: "wrapper.custom" }
      });
    } finally {
      await approvalServer.close();
      await duplicateServer.close();
      await malformedServer.close();
      await waitingServer.close();
      await resumedServer.close();
      await unknownServer.close();
    }
  });

  it("sanitizes unsafe artifact names", async () => {
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

      const artifacts = await adapter.artifacts({ ...session, runId: "run_artifact" });
      const unsafe = artifacts.find((artifact) => artifact.path.includes("generic-http/"))!;
      expect(unsafe.path).not.toContain("..");
      expect(unsafe.metadata["originalName"]).toBe("../../escape.log");
    } finally {
      await server.close();
    }
  });

  it("fails fast when status fallback returns invalid JSON after empty events", async () => {
    const fetchCalls = {
      events: 0,
      status: 0
    };
    const fetchStub: typeof fetch = async (input, _init) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ externalRunId: "ext_invalid_status" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/v1/runs/ext_invalid_status/events")) {
        fetchCalls.events += 1;
        return new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/v1/runs/ext_invalid_status")) {
        fetchCalls.status += 1;
        return new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ artifacts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const adapter = new GenericHttpAsyncRestAdapter({
      baseUrl: "http://generic-http.example.test",
      fetch: fetchStub,
      pollIntervalMs: 5,
      requestTimeoutMs: 100
    });

    const session = await adapter.start({
      runId: "run_status_invalid",
      runtime: "generic_http",
      runtimeMode: "generic_http.async_rest",
      provider: "generic_http",
      model: "generic-http-default",
      cwd: "/repo",
      task: "status fallback invalid json",
      metadata: {}
    });

    const iterator = adapter.events({ ...session, runId: "run_status_invalid" })[Symbol.asyncIterator]();
    const first = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<unknown>>((_, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for terminal failure")), 250);
      })
    ]);

    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: "run.failed",
      payload: { error: "generic_http_invalid_status_response" }
    });
    expect(fetchCalls.events).toBe(1);
    expect(fetchCalls.status).toBe(1);
  });

  it("fails fast when status fallback response is oversized after empty events", async () => {
    const fetchCalls = {
      events: 0,
      status: 0
    };
    const fetchStub: typeof fetch = async (input, _init) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ externalRunId: "ext_oversized_status" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/v1/runs/ext_oversized_status/events")) {
        fetchCalls.events += 1;
        return new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/v1/runs/ext_oversized_status")) {
        fetchCalls.status += 1;
        return new Response(JSON.stringify({ status: "running", payload: "x".repeat(4096) }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ artifacts: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const adapter = new GenericHttpAsyncRestAdapter({
      baseUrl: "http://generic-http.example.test",
      fetch: fetchStub,
      pollIntervalMs: 5,
      requestTimeoutMs: 100,
      maxResponseBytes: 64
    });

    const session = await adapter.start({
      runId: "run_status_oversized",
      runtime: "generic_http",
      runtimeMode: "generic_http.async_rest",
      provider: "generic_http",
      model: "generic-http-default",
      cwd: "/repo",
      task: "status fallback oversized",
      metadata: {}
    });

    const iterator = adapter.events({ ...session, runId: "run_status_oversized" })[Symbol.asyncIterator]();
    const first = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<unknown>>((_, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for terminal failure")), 250);
      })
    ]);

    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({
      type: "run.failed",
      payload: { error: "generic_http_status_response_too_large" }
    });
    expect(fetchCalls.events).toBe(1);
    expect(fetchCalls.status).toBe(1);
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

  it("does not leak raw input text or authorization-like content in logs or transcript metadata", async () => {
    const logs: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const server = await startFakeHttpRuntimeServer({ scenario: "bridge_happy" });
    try {
      const adapter = new GenericHttpAsyncRestAdapter({
        baseUrl: server.baseUrl,
        authToken: "secret-bridge-token",
        logger: {
          debug: (event, details) => logs.push({ event, details }),
          info: (event, details) => logs.push({ event, details }),
          warn: (event, details) => logs.push({ event, details }),
          error: (event, details) => logs.push({ event, details })
        }
      });
      const session = await adapter.start({
        runId: "run_redaction",
        runtime: "generic_http",
        runtimeMode: "generic_http.async_rest",
        provider: "generic_http",
        model: "generic-http-default",
        cwd: "/repo",
        task: "redaction",
        metadata: {}
      });
      const rawText = "Authorization: Bearer secret-bridge-token should not appear";
      await adapter.send({ ...session, runId: "run_redaction" }, {
        type: "input",
        switchyardRunId: "run_redaction",
        bridgeCommandId: "cmd_redaction",
        idempotencyKey: "idem_redaction",
        text: rawText
      });
      const runtimeApprovalToken = "secret-runtime-approval-token";
      await adapter.send({ ...session, runId: "run_redaction" }, {
        type: "approval_resolution",
        switchyardRunId: "run_redaction",
        bridgeCommandId: "cmd_redaction_approval",
        idempotencyKey: "idem_redaction_approval",
        runtimeApprovalToken,
        decision: "approved",
        message: "approved by hosted-api",
        answers: {}
      });
      const artifacts = await adapter.artifacts({ ...session, runId: "run_redaction" });
      expect(JSON.stringify(logs)).not.toContain(rawText);
      expect(JSON.stringify(logs)).not.toContain("secret-bridge-token");
      expect(JSON.stringify(logs)).not.toContain(runtimeApprovalToken);
      expect(JSON.stringify(logs)).toContain(":runtimeApprovalToken");
      expect(JSON.stringify(artifacts)).not.toContain(rawText);
      expect(JSON.stringify(artifacts)).not.toContain("secret-bridge-token");
      expect(JSON.stringify(artifacts)).not.toContain(runtimeApprovalToken);
      expect(JSON.stringify(artifacts)).toContain(":runtimeApprovalToken");
    } finally {
      await server.close();
    }
  });
});

async function collectEvents(server: Awaited<ReturnType<typeof startFakeHttpRuntimeServer>>, runId: string) {
  const adapter = new GenericHttpAsyncRestAdapter({
    baseUrl: server.baseUrl,
    pollIntervalMs: 5,
    requestTimeoutMs: 100
  });
  const session = await adapter.start({
    runId,
    runtime: "generic_http",
    runtimeMode: "generic_http.async_rest",
    provider: "generic_http",
    model: "generic-http-default",
    cwd: "/repo",
    task: runId,
    metadata: {}
  });
  const events = [];
  for await (const event of adapter.events({ ...session, runId })) {
    events.push(event);
  }
  return events;
}
