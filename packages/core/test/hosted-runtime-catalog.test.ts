import { describe, expect, it } from "vitest";
import {
  HOSTED_RUNTIME_CATALOG,
  getHostedRuntimeCatalogEntry,
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
  it("contains only the four closed hosted runtime modes", () => {
    const keys = Object.keys(HOSTED_RUNTIME_CATALOG).sort();
    expect(keys).toEqual([
      "claude_code.sdk",
      "codex.exec_json",
      "fake.deterministic",
      "opencode.acp"
    ]);

    const typed: HostedRuntimeModeSlug[] = keys as HostedRuntimeModeSlug[];
    expect(typed).toHaveLength(4);
  });

  it("validates known runtime mode predicates", () => {
    expect(isKnownHostedRuntimeMode("fake.deterministic")).toBe(true);
    expect(isKnownHostedRuntimeMode("codex.exec_json")).toBe(true);
    expect(isKnownHostedRuntimeMode("claude_code.sdk")).toBe(true);
    expect(isKnownHostedRuntimeMode("opencode.acp")).toBe(true);
    expect(isKnownHostedRuntimeMode("generic_http.async_rest")).toBe(false);

    expect(isRealHostedRuntimeMode("codex.exec_json")).toBe(true);
    expect(isRealHostedRuntimeMode("claude_code.sdk")).toBe(true);
    expect(isRealHostedRuntimeMode("opencode.acp")).toBe(true);
    expect(isRealHostedRuntimeMode("fake.deterministic")).toBe(false);
    expect(isRealHostedRuntimeMode(undefined)).toBe(false);

    expect(getHostedRuntimeCatalogEntry("codex.exec_json")?.adapterId).toBe("codex");
    expect(getHostedRuntimeCatalogEntry("missing.mode")).toBeUndefined();
  });

  it("rejects unknown allowlist mode", () => {
    const result = validateHostedRuntimeAllowlist({
      allowlist: ["fake.deterministic", "generic_http.async_rest"],
      deploymentMode: "staging",
      realRuntimeExecution: "disabled"
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST");
  });

  it("rejects staging real mode when gate is disabled", () => {
    const result = validateHostedRuntimeAllowlist({
      allowlist: ["fake.deterministic", "codex.exec_json"],
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
    expect(result.code).toBe("hosted_real_runtime_production_forbidden");
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
});
