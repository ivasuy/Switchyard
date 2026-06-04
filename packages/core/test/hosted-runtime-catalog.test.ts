import { describe, expect, it } from "vitest";
import {
  HOSTED_RUNTIME_CATALOG,
  getHostedRuntimeCatalogEntry,
  isHostedRuntimeProductionAllowed,
  isKnownHostedRuntimeMode,
  isRealHostedRuntimeMode,
  prepareHostedRunForExecution,
  validateHostedRuntimeAllowlist,
  type HostedRuntimeModeSlug
} from "../src/services/hosted-runtime-catalog.js";

const now = "2026-05-30T00:00:00.000Z";

function baseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "task",
    status: "queued",
    placement: "hosted",
    approvalPolicy: "default",
    timeoutSeconds: 60,
    metadata: {},
    runtimeMode: "fake.deterministic",
    createdAt: now,
    ...overrides
  };
}

describe("hosted runtime catalog", () => {
  it("contains only the six closed hosted runtime modes", () => {
    const keys = Object.keys(HOSTED_RUNTIME_CATALOG).sort();
    expect(keys).toEqual([
      "agentfield.async_rest",
      "claude_code.sdk",
      "codex.exec_json",
      "fake.deterministic",
      "generic_http.async_rest",
      "opencode.acp"
    ]);

    const typed: HostedRuntimeModeSlug[] = keys as HostedRuntimeModeSlug[];
    expect(typed).toHaveLength(6);
  });

  it("validates known runtime mode predicates", () => {
    expect(isKnownHostedRuntimeMode("fake.deterministic")).toBe(true);
    expect(isKnownHostedRuntimeMode("codex.exec_json")).toBe(true);
    expect(isKnownHostedRuntimeMode("claude_code.sdk")).toBe(true);
    expect(isKnownHostedRuntimeMode("opencode.acp")).toBe(true);
    expect(isKnownHostedRuntimeMode("agentfield.async_rest")).toBe(true);
    expect(isKnownHostedRuntimeMode("generic_http.async_rest")).toBe(true);

    expect(isRealHostedRuntimeMode("codex.exec_json")).toBe(true);
    expect(isRealHostedRuntimeMode("claude_code.sdk")).toBe(true);
    expect(isRealHostedRuntimeMode("opencode.acp")).toBe(true);
    expect(isRealHostedRuntimeMode("agentfield.async_rest")).toBe(true);
    expect(isRealHostedRuntimeMode("generic_http.async_rest")).toBe(true);
    expect(isRealHostedRuntimeMode("fake.deterministic")).toBe(false);
    expect(isRealHostedRuntimeMode(undefined)).toBe(false);

    expect(getHostedRuntimeCatalogEntry("codex.exec_json")?.adapterId).toBe("codex");
    expect(getHostedRuntimeCatalogEntry("missing.mode")).toBeUndefined();
  });

  it("rejects unknown allowlist mode", () => {
    const result = validateHostedRuntimeAllowlist({
      allowlist: ["fake.deterministic", "cursor.sdk"],
      deploymentMode: "staging",
      realRuntimeExecution: "disabled"
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST");
  });

  it("rejects staging real mode when gate is disabled", () => {
    const result = validateHostedRuntimeAllowlist({
      allowlist: ["fake.deterministic", "agentfield.async_rest"],
      deploymentMode: "staging",
      realRuntimeExecution: "disabled"
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("hosted_real_runtime_disabled");
  });

  it("rejects production real mode", () => {
    const result = validateHostedRuntimeAllowlist({
      allowlist: ["codex.exec_json"],
      deploymentMode: "production",
      realRuntimeExecution: "disabled"
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("hosted_real_runtime_disabled");
  });

  it("requires activation result for production real mode", () => {
    const denied = validateHostedRuntimeAllowlist({
      allowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      realRuntimeExecution: "enabled"
    });
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("provider_runtime_policy_missing");

    const allowed = validateHostedRuntimeAllowlist({
      allowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      realRuntimeExecution: "enabled",
      providerActivation: {
        valid: true,
        enabledRealModes: ["codex.exec_json"],
        reasons: [],
        redactedSummary: {}
      }
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) {
      return;
    }
    expect(allowed.allowlist).toEqual(["fake.deterministic", "codex.exec_json"]);
  });

  it("keeps local fake defaults", () => {
    const result = validateHostedRuntimeAllowlist({
      allowlist: ["fake.deterministic"],
      deploymentMode: "local",
      realRuntimeExecution: "disabled"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allowlist).toEqual(["fake.deterministic"]);
    expect(result.realRuntimeExecution).toBe("disabled");
  });

  it("defaults codex sandbox metadata to read-only", () => {
    const prepared = prepareHostedRunForExecution({
      run: baseRun({
        runtime: "codex",
        provider: "openai",
        model: "gpt-5",
        runtimeMode: "codex.exec_json"
      }),
      queuePayload: { runId: "run_1", placement: "hosted", runtimeMode: "codex.exec_json" },
      allowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "staging",
      realRuntimeExecution: "enabled"
    });

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect((prepared.run.metadata as Record<string, unknown>).sandbox).toBe("read-only");
  });

  it("keeps production real execution closed without activation during run preparation", () => {
    const denied = prepareHostedRunForExecution({
      run: baseRun({
        runtime: "codex",
        provider: "openai",
        model: "gpt-5",
        runtimeMode: "codex.exec_json"
      }),
      queuePayload: { runId: "run_1", placement: "hosted", runtimeMode: "codex.exec_json" },
      allowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      realRuntimeExecution: "enabled"
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.reasonCode).toBe("provider_runtime_policy_missing");
  });

  it("allows production real execution only with explicit activation", () => {
    const allowed = prepareHostedRunForExecution({
      run: baseRun({
        runtime: "codex",
        provider: "openai",
        model: "gpt-5",
        runtimeMode: "codex.exec_json"
      }),
      queuePayload: { runId: "run_1", placement: "hosted", runtimeMode: "codex.exec_json" },
      allowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "production",
      realRuntimeExecution: "enabled",
      providerActivation: {
        valid: true,
        enabledRealModes: ["codex.exec_json"],
        reasons: [],
        redactedSummary: {}
      }
    });
    expect(allowed.ok).toBe(true);
  });

  it("allows production wrapper execution only with explicit activation", () => {
    const denied = validateHostedRuntimeAllowlist({
      allowlist: ["fake.deterministic", "generic_http.async_rest"],
      deploymentMode: "production",
      realRuntimeExecution: "enabled"
    });
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe("provider_runtime_policy_missing");

    const allowed = validateHostedRuntimeAllowlist({
      allowlist: ["fake.deterministic", "generic_http.async_rest"],
      deploymentMode: "production",
      realRuntimeExecution: "enabled",
      providerActivation: {
        valid: true,
        enabledRealModes: ["generic_http.async_rest"],
        reasons: [],
        redactedSummary: {}
      }
    });
    expect(allowed.ok).toBe(true);

    const prepared = prepareHostedRunForExecution({
      run: baseRun({
        runtime: "generic_http",
        provider: "generic_http",
        adapterType: "http",
        model: "generic-http-default",
        runtimeMode: "generic_http.async_rest"
      }),
      queuePayload: { runId: "run_1", placement: "hosted", runtimeMode: "generic_http.async_rest" },
      allowlist: ["fake.deterministic", "generic_http.async_rest"],
      deploymentMode: "production",
      realRuntimeExecution: "enabled",
      providerActivation: {
        valid: true,
        enabledRealModes: ["generic_http.async_rest"],
        reasons: [],
        redactedSummary: {}
      }
    });
    expect(prepared.ok).toBe(true);
  });

  it("rejects unsafe codex sandbox metadata", () => {
    const denied = prepareHostedRunForExecution({
      run: baseRun({
        runtime: "codex",
        provider: "openai",
        model: "gpt-5",
        runtimeMode: "codex.exec_json",
        metadata: { sandbox: "danger-full-access" }
      }),
      queuePayload: { runId: "run_1", placement: "hosted", runtimeMode: "codex.exec_json" },
      allowlist: ["fake.deterministic", "codex.exec_json"],
      deploymentMode: "staging",
      realRuntimeExecution: "enabled"
    });

    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.reasonCode).toBe("hosted_codex_sandbox_denied");
  });

  it("evaluates production support from activation instead of static catalog flags", () => {
    expect(HOSTED_RUNTIME_CATALOG["codex.exec_json"].productionAllowed).toBe(false);
    expect(isHostedRuntimeProductionAllowed("codex.exec_json")).toBe(false);
    expect(
      isHostedRuntimeProductionAllowed("codex.exec_json", {
        valid: true,
        enabledRealModes: ["codex.exec_json"],
        reasons: [],
        redactedSummary: {}
      })
    ).toBe(true);
  });

  it("keeps codex one-shot while advertising hosted bridge capabilities for claude and opencode", () => {
    const codex = HOSTED_RUNTIME_CATALOG["codex.exec_json"].manifest;
    const claude = HOSTED_RUNTIME_CATALOG["claude_code.sdk"].manifest;
    const opencode = HOSTED_RUNTIME_CATALOG["opencode.acp"].manifest;

    expect(codex.capabilities).not.toEqual(
      expect.arrayContaining(["run.input", "session.state", "approval.bridge"])
    );
    expect(codex.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "no_input_bridge" }),
        expect.objectContaining({ code: "no_approval_bridge" })
      ])
    );

    expect(claude.capabilities).toEqual(
      expect.arrayContaining(["run.input", "session.state", "approval.bridge"])
    );
    expect(claude.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "hosted_bridge_readiness_required" }),
        expect.objectContaining({ code: "no_hosted_live_resume_guarantee" })
      ])
    );

    expect(opencode.capabilities).toEqual(
      expect.arrayContaining(["run.input", "session.state", "approval.bridge"])
    );
    expect(opencode.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "hosted_bridge_readiness_required" }),
        expect.objectContaining({ code: "no_terminal_bridge" })
      ])
    );
  });

  it("advertises wrapper bridge capabilities without forbidden hosted surfaces", () => {
    const expectedCapabilities = [
      "auth.api_key",
      "event.streaming",
      "event.normalized",
      "run.start",
      "run.input",
      "run.timeout",
      "approval.bridge",
      "artifact.transcript"
    ];
    const forbiddenCapabilities = [
      "run.cancel",
      "session.state",
      "session.resume",
      "artifact.raw_transcript",
      "model.catalog",
      "tool.call.normalized",
      "tool.result.normalized",
      "sandbox.read_only",
      "sandbox.workspace_write",
      "sandbox.danger_full_access"
    ];

    for (const mode of ["agentfield.async_rest", "generic_http.async_rest"] as const) {
      const entry = HOSTED_RUNTIME_CATALOG[mode];
      expect(entry).toMatchObject({
        runtimeModeSlug: mode,
        adapterType: "http",
        kind: "async_rest",
        hostedSupport: "conditional",
        requiresRealRuntimeGate: true,
        productionAllowed: false
      });
      expect(entry.manifest.capabilities).toEqual(expectedCapabilities);
      expect(entry.manifest.capabilities).not.toEqual(expect.arrayContaining(forbiddenCapabilities));
      expect(entry.manifest.limitations).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "no_hosted_cancel_bridge" })])
      );
    }
  });
});
