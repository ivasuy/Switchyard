import { describe, expect, it } from "vitest";
import { runtimeModeSchema, type ProviderResolvedCommand } from "@switchyard/contracts";
import { AdapterProtocolError } from "@switchyard/core";
import {
  OPENCODE_ACP_RUNTIME_MODE_SLUG,
  OpenCodeAcpAdapter
} from "../src/index.js";
import { createFakeAcpProcessFactory, startFakeAcpRuntimeProcess, type FakeAcpRuntimeStats } from "@switchyard/testkit";

describe("OpenCodeAcpAdapter", () => {
  it("exposes manifest compatible with opencode.acp runtime mode", () => {
    const adapter = new OpenCodeAcpAdapter();
    expect(adapter.manifest.runtimeModeSlug).toBe(OPENCODE_ACP_RUNTIME_MODE_SLUG);
    expect(adapter.manifest.adapterType).toBe("acpx");
    expect(adapter.manifest.kind).toBe("acp");
    expect(adapter.manifest.capabilities).toContain("artifact.raw_transcript");
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
        checkedAt: "2026-05-30T00:00:00.000Z",
        reasonCode: "opencode_binary_unavailable",
        message: "missing"
      },
      docsPath: adapter.manifest.docsPath,
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z"
    });
    expect(mode.slug).toBe("opencode.acp");
  });

  it("check() performs initialize/session-new only and maps doctor states", async () => {
    const stats: FakeAcpRuntimeStats = { prompts: 0, cancels: 0, permissionResponses: 0 };
    const adapter = new OpenCodeAcpAdapter({
      processFactory: createFakeAcpProcessFactory({ scenario: "happy", stats }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" }),
      checkCwd: "/repo"
    });
    const available = await adapter.check();
    expect((available.details?.["availability"] as Record<string, unknown>)["state"]).toBe("available");
    expect(stats.prompts).toBe(0);

    const invalidInitialize = new OpenCodeAcpAdapter({
      processFactory: createFakeAcpProcessFactory({ scenario: "invalid_initialize" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" }),
      checkCwd: "/repo"
    });
    const unavailable = await invalidInitialize.check();
    expect((unavailable.details?.["availability"] as Record<string, unknown>)["reasonCode"]).toBe("opencode_acp_initialize_failed");

    const invalidSessionNew = new OpenCodeAcpAdapter({
      processFactory: createFakeAcpProcessFactory({ scenario: "invalid_session_new" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" }),
      checkCwd: "/repo"
    });
    const sessionUnavailable = await invalidSessionNew.check();
    expect((sessionUnavailable.details?.["availability"] as Record<string, unknown>)["reasonCode"]).toBe("opencode_acp_session_new_failed");

    const stderrWarning = new OpenCodeAcpAdapter({
      processFactory: createFakeAcpProcessFactory({ scenario: "stderr_warning" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" }),
      checkCwd: "/repo"
    });
    const partial = await stderrWarning.check();
    expect((partial.details?.["availability"] as Record<string, unknown>)["state"]).toBe("partial");
    expect((partial.details?.["availability"] as Record<string, unknown>)["reasonCode"]).toBe("opencode_stderr_warning");
  });

  it("runs happy and empty-output prompts and maps events/terminals", async () => {
    const happy = new OpenCodeAcpAdapter({
      processFactory: createFakeAcpProcessFactory({ scenario: "happy" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    const happySession = await happy.start({
      runId: "run_happy",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "say hello",
      metadata: {}
    });
    const happyEvents = [];
    for await (const event of happy.events({ ...happySession, runId: "run_happy" })) {
      happyEvents.push(event);
    }
    expect(happyEvents.some((event) => event.type === "runtime.output")).toBe(true);
    expect(happyEvents.at(-1)?.type).toBe("run.completed");

    const empty = new OpenCodeAcpAdapter({
      processFactory: createFakeAcpProcessFactory({ scenario: "empty_output" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    const emptySession = await empty.start({
      runId: "run_empty",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "empty",
      metadata: {}
    });
    const emptyEvents = [];
    for await (const event of empty.events({ ...emptySession, runId: "run_empty" })) {
      emptyEvents.push(event);
    }
    expect(emptyEvents.some((event) => event.type === "runtime.output")).toBe(false);
    expect(emptyEvents.at(-1)?.type).toBe("run.completed");
  });

  it("handles permission request failures and verified/unverified cancel", async () => {
    const permission = new OpenCodeAcpAdapter({
      processFactory: createFakeAcpProcessFactory({ scenario: "permission_request" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    const permissionSession = await permission.start({
      runId: "run_perm",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "permission path",
      metadata: {}
    });
    const permissionEvents = [];
    for await (const event of permission.events({ ...permissionSession, runId: "run_perm" })) {
      permissionEvents.push(event);
    }
    expect(permissionEvents.at(-1)?.type).toBe("run.failed");
    expect(permissionEvents.at(-1)?.payload.error).toBe("acp_permission_request_unsupported");

    const cancelAdapter = new OpenCodeAcpAdapter({
      processFactory: createFakeAcpProcessFactory({ scenario: "cancelled" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    const cancelSession = await cancelAdapter.start({
      runId: "run_cancel",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "cancel path",
      metadata: {}
    });
    const runEventsPromise = (async () => {
      const events = [];
      for await (const event of cancelAdapter.events({ ...cancelSession, runId: "run_cancel" })) {
        events.push(event);
      }
      return events;
    })();
    await cancelAdapter.cancel({ ...cancelSession, runId: "run_cancel" });
    const cancelledEvents = await runEventsPromise;
    expect(cancelledEvents.at(-1)?.type).toBe("run.cancelled");

    const cancelUnverified = new OpenCodeAcpAdapter({
      processFactory: createFakeAcpProcessFactory({ scenario: "cancel_unverified" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" }),
      cancelTimeoutMs: 20
    });
    const unverifiedSession = await cancelUnverified.start({
      runId: "run_cancel_unverified",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "cancel fail",
      metadata: {}
    });
    const unverifiedIterator = cancelUnverified
      .events({ ...unverifiedSession, runId: "run_cancel_unverified" })
      [Symbol.asyncIterator]();
    void unverifiedIterator.next();
    await expect(
      cancelUnverified.cancel({ ...unverifiedSession, runId: "run_cancel_unverified" })
    ).rejects.toMatchObject({
      code: "adapter_protocol_failed",
      reasonCode: "acp_cancel_unverified"
    } satisfies Partial<AdapterProtocolError>);
  });

  it("rejects unsupported input and relative cwd, and returns transcript artifacts", async () => {
    const adapter = new OpenCodeAcpAdapter({
      processFactory: createFakeAcpProcessFactory({ scenario: "happy" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });

    await expect(
      adapter.start({
        runId: "run_bad_cwd",
        runtime: "opencode",
        runtimeMode: "opencode.acp",
        provider: "opencode",
        model: "opencode-default",
        cwd: "relative/path",
        task: "bad",
        metadata: {}
      })
    ).rejects.toMatchObject({
      code: "adapter_protocol_failed",
      reasonCode: "opencode_cwd_not_absolute"
    } satisfies Partial<AdapterProtocolError>);

    const session = await adapter.start({
      runId: "run_artifacts",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "artifact",
      metadata: {}
    });
    const artifactIterator = adapter.events({ ...session, runId: "run_artifacts" })[Symbol.asyncIterator]();
    void artifactIterator.next();
    await expect(
      adapter.send({ ...session, runId: "run_artifacts" }, { text: "continue" })
    ).rejects.toMatchObject({
      code: "adapter_protocol_failed",
      reasonCode: "opencode_input_unsupported"
    } satisfies Partial<AdapterProtocolError>);

    const artifacts = await adapter.artifacts({ ...session, runId: "run_artifacts" });
    expect(artifacts[0]?.path).toBe("runs/run_artifacts/opencode-acp-transcript.jsonl");
    expect(String(artifacts[0]?.metadata.content)).toContain("\"method\":\"initialize\"");
  });

  it("passes filtered env in hosted mode and keeps one prompt per run", async () => {
    const captured: { env?: NodeJS.ProcessEnv; prompts: number } = { prompts: 0 };
    const hostedProviderCommand: ProviderResolvedCommand = {
      runtimeMode: "opencode.acp",
      executablePath: "/opt/provider/bin/opencode",
      argv: ["acp"],
      cwd: "/repo",
      env: {
        OPENCODE_TOKEN: "token-secret"
      },
      envKeys: ["OPENCODE_TOKEN"],
      allowUserArgs: false,
      redactedSummary: {}
    };
    const adapter = new OpenCodeAcpAdapter({
      hostedProviderCommand,
      processFactory: (_args, options) => {
        captured.env = options.env;
        const handle = startFakeAcpRuntimeProcess({ scenario: "happy" });
        const originalWrite = handle.process.stdin.write.bind(handle.process.stdin);
        handle.process.stdin.write = ((data: string) => {
          if (data.includes("\"method\":\"session/prompt\"")) {
            captured.prompts += 1;
          }
          return originalWrite(data);
        }) as typeof handle.process.stdin.write;
        return handle.process;
      }
    });

    const session = await adapter.start({
      runId: "run_env",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "env check",
      metadata: {}
    });
    const events = [];
    for await (const event of adapter.events({ ...session, runId: "run_env" })) {
      events.push(event);
    }

    expect(captured.env).toEqual({ OPENCODE_TOKEN: "token-secret" });
    expect(captured.prompts).toBe(1);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("maps hosted permission and input bridge failures to hosted reason codes", async () => {
    const hostedProviderCommand: ProviderResolvedCommand = {
      runtimeMode: "opencode.acp",
      executablePath: "/opt/provider/bin/opencode",
      argv: ["acp"],
      cwd: "/repo",
      env: {},
      envKeys: [],
      allowUserArgs: false,
      redactedSummary: {}
    };
    const permission = new OpenCodeAcpAdapter({
      hostedProviderCommand,
      processFactory: createFakeAcpProcessFactory({ scenario: "permission_request" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    const permissionSession = await permission.start({
      runId: "run_perm_hosted",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "permission path",
      metadata: {}
    });
    const permissionEvents = [];
    for await (const event of permission.events({ ...permissionSession, runId: "run_perm_hosted" })) {
      permissionEvents.push(event);
    }
    expect(permissionEvents.at(-1)?.payload.reasonCode ?? permissionEvents.at(-1)?.payload.error).toBe(
      "hosted_approval_bridge_unsupported"
    );

    await expect(
      permission.send({ ...permissionSession, runId: "run_perm_hosted" }, { text: "continue" })
    ).rejects.toMatchObject({
      reasonCode: "hosted_input_bridge_unsupported"
    } satisfies Partial<AdapterProtocolError>);
  });

  it("creates approval.requested for hosted permission flow when bridge is enabled", async () => {
    const stats: FakeAcpRuntimeStats = { prompts: 0, cancels: 0, permissionResponses: 0 };
    const hostedProviderCommand: ProviderResolvedCommand = {
      runtimeMode: "opencode.acp",
      executablePath: "/opt/provider/bin/opencode",
      argv: ["acp"],
      cwd: "/repo",
      env: {},
      envKeys: [],
      allowUserArgs: false,
      redactedSummary: {}
    };
    const adapter = new OpenCodeAcpAdapter({
      hostedProviderCommand,
      hostedBridgeEnabled: true,
      processFactory: createFakeAcpProcessFactory({ scenario: "permission_request", stats }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    const session = await adapter.start({
      runId: "run_perm_bridge_enabled",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "permission path",
      metadata: {}
    });

    const iterator = adapter.events({ ...session, runId: "run_perm_bridge_enabled" })[Symbol.asyncIterator]();
    let approvalEvent: { payload: Record<string, unknown> } | undefined;
    for (let i = 0; i < 6; i += 1) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      if (next.value.type === "approval.requested") {
        approvalEvent = { payload: next.value.payload };
        break;
      }
    }

    expect(approvalEvent).toBeDefined();
    expect(approvalEvent?.payload["runtimeApprovalToken"]).toBe("perm_1");
    expect(typeof approvalEvent?.payload["expiresAt"]).toBe("string");

    await expect(adapter.send({ ...session, runId: "run_perm_bridge_enabled" }, {
      type: "approval_resolution",
      runtimeApprovalToken: "perm_1",
      decision: "approved"
    })).resolves.toBeUndefined();

    await expect(adapter.send({ ...session, runId: "run_perm_bridge_enabled" }, {
      type: "approval_resolution",
      runtimeApprovalToken: "perm_1",
      decision: "approved"
    })).rejects.toMatchObject({ reasonCode: "runtime_approval_pause_not_active" });

    expect(stats.permissionResponses).toBe(1);
  });

  it("redacts hosted permission action summaries before approval events", async () => {
    const rawReason = "Need token=secret-token-value at /Users/example/secret-key/project.txt";
    const hostedProviderCommand: ProviderResolvedCommand = {
      runtimeMode: "opencode.acp",
      executablePath: "/opt/provider/bin/opencode",
      argv: ["acp"],
      cwd: "/repo",
      env: {},
      envKeys: [],
      allowUserArgs: false,
      redactedSummary: {}
    };
    const adapter = new OpenCodeAcpAdapter({
      hostedProviderCommand,
      hostedBridgeEnabled: true,
      processFactory: () => {
        const handle = startFakeAcpRuntimeProcess({ scenario: "permission_request" });
        const originalWrite = handle.process.stdout.write.bind(handle.process.stdout);
        handle.process.stdout.write = ((data: string | Uint8Array) => {
          const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
          if (text.includes("\"method\":\"session/request_permission\"")) {
            const message = JSON.parse(text) as { params?: Record<string, unknown> };
            message.params = { ...(message.params ?? {}), reason: rawReason };
            return originalWrite(`${JSON.stringify(message)}\n`);
          }
          return originalWrite(data as string);
        }) as typeof handle.process.stdout.write;
        return handle.process;
      },
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    const session = await adapter.start({
      runId: "run_perm_redacted",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "permission path",
      metadata: {}
    });

    const iterator = adapter.events({ ...session, runId: "run_perm_redacted" })[Symbol.asyncIterator]();
    let approvalAction = "";
    for (let i = 0; i < 6; i += 1) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      if (next.value.type === "approval.requested") {
        approvalAction = String(next.value.payload["action"] ?? "");
        break;
      }
    }

    expect(approvalAction).toContain("[REDACTED");
    expect(approvalAction).not.toContain("secret-token-value");
    expect(approvalAction).not.toContain("/Users/example");
    expect(approvalAction).not.toContain("/Users/example/secret-key/project.txt");
  });

  it("rejects concurrent hosted prompt input while prompt is in flight", async () => {
    const hostedProviderCommand: ProviderResolvedCommand = {
      runtimeMode: "opencode.acp",
      executablePath: "/opt/provider/bin/opencode",
      argv: ["acp"],
      cwd: "/repo",
      env: {},
      envKeys: [],
      allowUserArgs: false,
      redactedSummary: {}
    };
    const adapter = new OpenCodeAcpAdapter({
      hostedProviderCommand,
      hostedBridgeEnabled: true,
      processFactory: createFakeAcpProcessFactory({ scenario: "permission_request" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    const session = await adapter.start({
      runId: "run_perm_conflict",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "permission path",
      metadata: {}
    });

    const iterator = adapter.events({ ...session, runId: "run_perm_conflict" })[Symbol.asyncIterator]();
    for (let i = 0; i < 6; i += 1) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      if (next.value.type === "approval.requested") {
        break;
      }
    }

    await expect(
      adapter.send({ ...session, runId: "run_perm_conflict" }, { text: "continue" })
    ).rejects.toMatchObject({ reasonCode: "acp_prompt_in_flight" } satisfies Partial<AdapterProtocolError>);

    await expect(adapter.send({ ...session, runId: "run_perm_conflict" }, {
      type: "approval_resolution",
      runtimeApprovalToken: "perm_1",
      decision: "approved"
    })).resolves.toBeUndefined();
  });

  it("maps pending permission loss to named ACP bridge error", async () => {
    let processHandle: ReturnType<typeof startFakeAcpRuntimeProcess> | undefined;
    const hostedProviderCommand: ProviderResolvedCommand = {
      runtimeMode: "opencode.acp",
      executablePath: "/opt/provider/bin/opencode",
      argv: ["acp"],
      cwd: "/repo",
      env: {},
      envKeys: [],
      allowUserArgs: false,
      redactedSummary: {}
    };
    const adapter = new OpenCodeAcpAdapter({
      hostedProviderCommand,
      hostedBridgeEnabled: true,
      processFactory: () => {
        processHandle = startFakeAcpRuntimeProcess({ scenario: "permission_request" });
        return processHandle.process;
      },
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    const session = await adapter.start({
      runId: "run_perm_lost",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "permission path",
      metadata: {}
    });

    const iterator = adapter.events({ ...session, runId: "run_perm_lost" })[Symbol.asyncIterator]();
    for (let i = 0; i < 6; i += 1) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      if (next.value.type === "approval.requested") {
        break;
      }
    }
    processHandle?.close();

    await expect(adapter.send({ ...session, runId: "run_perm_lost" }, {
      type: "approval_resolution",
      runtimeApprovalToken: "perm_1",
      decision: "approved"
    })).rejects.toMatchObject({
      reasonCode: "acp_permission_response_failed"
    } satisfies Partial<AdapterProtocolError>);
  });

  it("sends hosted follow-up prompt input only after session is ready", async () => {
    const captured = { prompts: 0 };
    const hostedProviderCommand: ProviderResolvedCommand = {
      runtimeMode: "opencode.acp",
      executablePath: "/opt/provider/bin/opencode",
      argv: ["acp"],
      cwd: "/repo",
      env: {},
      envKeys: [],
      allowUserArgs: false,
      redactedSummary: {}
    };
    const adapter = new OpenCodeAcpAdapter({
      hostedProviderCommand,
      hostedBridgeEnabled: true,
      processFactory: (_args, options) => {
        const handle = startFakeAcpRuntimeProcess({ scenario: "happy" });
        const originalWrite = handle.process.stdin.write.bind(handle.process.stdin);
        handle.process.stdin.write = ((data: string) => {
          if (data.includes("\"method\":\"session/prompt\"")) {
            captured.prompts += 1;
          }
          return originalWrite(data);
        }) as typeof handle.process.stdin.write;
        return handle.process;
      },
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    const session = await adapter.start({
      runId: "run_follow_up_ready",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/repo",
      task: "initial prompt",
      metadata: {}
    });

    await expect(adapter.send({ ...session, runId: "run_follow_up_ready" }, { text: "too early" })).rejects.toMatchObject({
      reasonCode: "acp_session_not_ready_for_input"
    } satisfies Partial<AdapterProtocolError>);

    const events = [];
    for await (const event of adapter.events({ ...session, runId: "run_follow_up_ready" })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: "runtime.status", payload: { status: "waiting_for_input" } });

    await expect(adapter.send({ ...session, runId: "run_follow_up_ready" }, { text: "follow-up" })).resolves.toBeUndefined();
    expect(captured.prompts).toBe(2);
  });

  it("redacts hosted transcript artifacts while retaining hosted-safe diagnostics", async () => {
    const hostedProviderCommand: ProviderResolvedCommand = {
      runtimeMode: "opencode.acp",
      executablePath: "/Users/example/bin/opencode",
      argv: ["acp"],
      cwd: "/Users/example/workspace/project",
      env: {
        OPENCODE_TOKEN: "token-secret-value",
        HOME: "/Users/example"
      },
      envKeys: ["OPENCODE_TOKEN", "HOME"],
      allowUserArgs: false,
      redactedSummary: {}
    };
    const adapter = new OpenCodeAcpAdapter({
      hostedProviderCommand,
      processFactory: createFakeAcpProcessFactory({ scenario: "happy" }),
      probeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });

    const session = await adapter.start({
      runId: "run_hosted_transcript",
      runtime: "opencode",
      runtimeMode: "opencode.acp",
      provider: "opencode",
      model: "opencode-default",
      cwd: "/Users/example/workspace/project",
      task: "Prompt secret token-secret-value from /Users/example/workspace/project",
      metadata: {}
    });
    for await (const _event of adapter.events({ ...session, runId: "run_hosted_transcript" })) {
      // drain
    }

    const artifacts = await adapter.artifacts({ ...session, runId: "run_hosted_transcript" });
    const content = String(artifacts[0]?.metadata.content);
    expect(content).toContain("\"method\":\"initialize\"");
    expect(content).toContain("\"method\":\"session/prompt\"");
    expect(content).toContain("[REDACTED_HOSTED]");
    expect(content).not.toContain("Prompt secret token-secret-value");
    expect(content).not.toContain("token-secret-value");
    expect(content).not.toContain("/Users/example/workspace/project");
    expect(content).not.toContain("/Users/example/bin/opencode");
    expect(content).not.toContain("\"raw\":\"{");
    expect(content).not.toContain("\"prompt\"");
    expect(content).not.toContain("\"cwd\"");
  });
});
