import { describe, expect, it } from "vitest";
import { runtimeModeSchema } from "@switchyard/contracts";
import { AdapterProtocolError } from "@switchyard/core";
import {
  OPENCODE_ACP_RUNTIME_MODE_SLUG,
  OpenCodeAcpAdapter
} from "../src/index.js";
import { createFakeAcpProcessFactory, type FakeAcpRuntimeStats } from "@switchyard/testkit";

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
});
