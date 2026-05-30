import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  doctorSummaryResponseSchema,
  approvalSchema,
  artifactSchema,
  budgetSchema,
  contextPacketSchema,
  contextSectionSchema,
  debateSchema,
  errorSchema,
  eventSchema,
  evidenceItemSchema,
  modelSchema,
  memoryItemSchema,
  messageSchema,
  nodeSchema,
  placementDecisionSchema,
  providerSchema,
  runSchema,
  runtimeAvailabilitySchema,
  runtimeCapabilitySchema,
  runtimeDoctorCheckSchema,
  runtimeModeSchema,
  runtimeModeSlugSchema,
  runtimeSchema,
  runtimeSessionSchema,
  toolInvocationSchema,
  userSchema,
  httpErrorCodeSchema,
  httpErrorEnvelopeSchema,
  assignmentSchema,
  nodeRegisterRequestSchema,
  assignmentClaimResponseSchema,
  assignmentEventSyncRequestSchema,
  assignmentArtifactManifestRequestSchema
} from "../src/index.js";

function expectRequiredFields(schema: z.ZodType, valid: Record<string, unknown>, requiredKeys: string[]): void {
  expect(() => schema.parse(valid), "fixture should parse").not.toThrow();
  for (const key of requiredKeys) {
    const value = { ...valid };
    delete value[key];
    expect(() => schema.parse(value), `${key} should be required`).toThrow();
  }
}

describe("Switchyard contracts", () => {
  it("parses a runtime-backed run", () => {
    const run = runSchema.parse({
      id: "run_123",
      runtime: "opencode",
      provider: "opencode",
      model: "opencode/big-pickle",
      adapterType: "acpx",
      cwd: "/repo",
      task: "Inspect the repo",
      status: "queued",
      placement: "local",
      approvalPolicy: "default",
      timeoutSeconds: 600,
      metadata: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    });

    expect(run.status).toBe("queued");
    expect(run.adapterType).toBe("acpx");
  });

  it("requires run ids to use the expected prefix", () => {
    expect(() =>
      runSchema.parse({
        id: "bad_123",
        runtime: "opencode",
        provider: "opencode",
        model: "opencode/big-pickle",
        adapterType: "acpx",
        cwd: "/repo",
        task: "Inspect the repo",
        status: "queued",
        placement: "local",
        approvalPolicy: "default",
        timeoutSeconds: 600,
        metadata: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      })
    ).toThrow();
  });

  it("parses runtime session metadata", () => {
    const session = runtimeSessionSchema.parse({
      id: "session_123",
      runId: "run_123",
      runtime: "opencode",
      provider: "opencode",
      model: "opencode/big-pickle",
      protocol: "acpx",
      status: "active",
      externalSessionKey: "ses_abc",
      processId: 12345,
      state: {},
      createdAt: "2026-05-11T00:00:00.000Z"
    });

    expect(session.externalSessionKey).toBe("ses_abc");
  });

  it("parses runtime mode slug, record, doctor payloads, and doctor summary", () => {
    expect(runtimeModeSlugSchema.parse("fake.deterministic")).toBe("fake.deterministic");
    expect(runtimeModeSlugSchema.parse("codex.exec_json")).toBe("codex.exec_json");
    expect(() => runtimeModeSlugSchema.parse("codex")).toThrow();
    expect(() => runtimeModeSlugSchema.parse("Codex.exec_json")).toThrow();
    expect(() => runtimeModeSlugSchema.parse(".codex")).toThrow();
    expect(() => runtimeModeSlugSchema.parse("codex..exec_json")).toThrow();

    const fakeMode = runtimeModeSchema.parse({
      id: "runtime_mode_fake_deterministic",
      slug: "fake.deterministic",
      name: "Fake deterministic runtime",
      providerId: "provider_test",
      runtimeId: "runtime_fake",
      adapterId: "fake",
      adapterType: "process",
      kind: "deterministic_fake",
      status: "available",
      capabilities: ["run.start", "run.cancel", "event.normalized", "event.streaming", "artifact.transcript", "tool.fake_echo", "auth.none"],
      limitations: [{ code: "deterministic_only", message: "Outputs are fixed for local smoke and contract tests." }],
      placement: {
        local: { support: "supported", reason: "In-process deterministic test adapter." },
        hosted: { support: "supported", reason: "Hosted-safe deterministic fake worker mode for R10 smoke execution." },
        connectedLocalNode: { support: "supported", reason: "Connected local node fake execution for R10 hybrid smoke flows." }
      },
      availability: {
        state: "available",
        canRun: true,
        installed: true,
        auth: "not_required",
        version: null,
        checkedAt: "2026-05-29T00:00:00.000Z",
        reasonCode: null,
        message: null
      },
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z"
    });
    expect(fakeMode.slug).toBe("fake.deterministic");

    const codexMode = runtimeModeSchema.parse({
      id: "runtime_mode_codex_exec_json",
      slug: "codex.exec_json",
      name: "Codex exec JSON",
      providerId: "provider_openai",
      runtimeId: "runtime_codex",
      adapterId: "codex",
      adapterType: "process",
      kind: "one_shot_process",
      status: "available",
      capabilities: [
        "run.start",
        "run.cancel",
        "run.timeout",
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "artifact.raw_transcript",
        "model.catalog",
        "auth.local",
        "sandbox.read_only",
        "sandbox.workspace_write",
        "sandbox.danger_full_access"
      ],
      limitations: [
        { code: "one_shot_no_input", message: "codex.exec_json does not support post-start input." },
        { code: "local_only", message: "This mode runs a local Codex CLI process and is not hosted-safe in R3." }
      ],
      placement: {
        local: { support: "supported", reason: "Requires a PATH-reachable local codex binary and local workspace." },
        hosted: { support: "unsupported", reason: "Hosted subprocess execution is not shipped in R3." },
        connectedLocalNode: { support: "future", reason: "Hybrid node execution is planned for R10." }
      },
      availability: {
        state: "available",
        canRun: true,
        installed: true,
        auth: "configured",
        version: "codex-cli 0.130.0",
        checkedAt: "2026-05-29T00:00:00.000Z",
        reasonCode: null,
        message: null
      },
      docsPath: "docs/development/adapters/CODEX.md",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z"
    });
    expect(codexMode.id).toBe("runtime_mode_codex_exec_json");

    const availableCheck = runtimeDoctorCheckSchema.parse({
      runtimeModeId: "runtime_mode_codex_exec_json",
      runtimeMode: "codex.exec_json",
      providerId: "provider_openai",
      runtimeId: "runtime_codex",
      state: "available",
      canRun: true,
      installed: true,
      auth: "configured",
      version: "codex-cli 0.130.0",
      checkedAt: "2026-05-29T00:00:00.000Z",
      reasonCode: null,
      message: null,
      capabilities: ["run.start", "run.cancel", "model.catalog", "auth.local"],
      limitations: [{ code: "one_shot_no_input", message: "codex.exec_json does not support post-start input." }],
      diagnostics: [{ code: "binary_version_ok", severity: "info", message: "codex --version succeeded." }]
    });
    expect(availableCheck.state).toBe("available");

    const unavailableCheck = runtimeDoctorCheckSchema.parse({
      runtimeModeId: "runtime_mode_codex_exec_json",
      runtimeMode: "codex.exec_json",
      providerId: "provider_openai",
      runtimeId: "runtime_codex",
      state: "unavailable",
      canRun: false,
      installed: true,
      auth: "unknown",
      version: null,
      checkedAt: "2026-05-29T00:00:00.000Z",
      reasonCode: "model_catalog_unavailable",
      message: "No model catalog entries were returned.",
      capabilities: ["run.start", "run.cancel", "model.catalog", "auth.local"],
      limitations: [{ code: "one_shot_no_input", message: "codex.exec_json does not support post-start input." }],
      diagnostics: [{ code: "model_catalog_unavailable", severity: "error", message: "codex debug models returned no usable models." }]
    });
    expect(unavailableCheck.installed).toBe(true);

    expect(() =>
      runtimeAvailabilitySchema.parse({
        state: "degraded",
        canRun: false,
        installed: false,
        auth: "unknown",
        checkedAt: "2026-05-29T00:00:00.000Z",
        version: null,
        reasonCode: "bad_state",
        message: null
      })
    ).toThrow();

    const summary = doctorSummaryResponseSchema.parse({
      runtimeModes: [
        { runtimeModeId: "runtime_mode_fake_deterministic", runtimeMode: "fake.deterministic", state: "available", canRun: true, checkedAt: "2026-05-29T00:00:00.000Z" },
        { runtimeModeId: "runtime_mode_codex_exec_json", runtimeMode: "codex.exec_json", state: "partial", canRun: true, checkedAt: "2026-05-29T00:00:00.000Z" }
      ],
      summary: {
        available: 1,
        installed: 0,
        partial: 1,
        unavailable: 0,
        unsupported: 0,
        unknown: 0
      }
    });
    expect(summary.summary.partial).toBe(1);
  });

  it("accepts auth.api_key capability and rejects unsupported future capabilities", () => {
    expect(runtimeCapabilitySchema.parse("auth.api_key")).toBe("auth.api_key");
    expect(runtimeCapabilitySchema.parse("run.input")).toBe("run.input");
    expect(runtimeCapabilitySchema.parse("session.state")).toBe("session.state");
    expect(runtimeCapabilitySchema.parse("session.resume")).toBe("session.resume");
    expect(runtimeCapabilitySchema.parse("approval.bridge")).toBe("approval.bridge");
    expect(runtimeCapabilitySchema.parse("tool.call.normalized")).toBe("tool.call.normalized");
    expect(runtimeCapabilitySchema.parse("tool.result.normalized")).toBe("tool.result.normalized");
    expect(runtimeCapabilitySchema.parse("user.question")).toBe("user.question");

    expect(() => runtimeCapabilitySchema.parse("approval.request")).toThrow();
    expect(() => runtimeCapabilitySchema.parse("webhook.callback")).toThrow();
    expect(() => runtimeCapabilitySchema.parse("tool.invoke")).toThrow();
    expect(() => runtimeCapabilitySchema.parse("hosted.run")).toThrow();
    expect(() => runtimeCapabilitySchema.parse("mcp.server")).toThrow();
  });

  it("parses claude_code.sdk runtime mode record with interactive capabilities", () => {
    const mode = runtimeModeSchema.parse({
      id: "runtime_mode_claude_code_sdk",
      slug: "claude_code.sdk",
      name: "Claude Code SDK",
      providerId: "provider_anthropic",
      runtimeId: "runtime_claude_code",
      adapterId: "claude_code",
      adapterType: "native",
      kind: "sdk",
      status: "unknown",
      capabilities: [
        "run.start",
        "run.input",
        "run.cancel",
        "run.timeout",
        "session.state",
        "approval.bridge",
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "artifact.raw_transcript",
        "tool.call.normalized",
        "tool.result.normalized",
        "user.question",
        "auth.local"
      ],
      limitations: [
        { code: "no_hosted_support", message: "Hosted subprocess execution is not shipped in R8." }
      ],
      placement: {
        local: { support: "conditional", reason: "Requires local Claude Code tooling and auth." },
        hosted: { support: "unsupported", reason: "Hosted execution is not shipped in R8." },
        connectedLocalNode: { support: "future", reason: "Hybrid node execution is planned for a future release." }
      },
      availability: {
        state: "unknown",
        canRun: false,
        installed: false,
        auth: "unknown",
        version: null,
        checkedAt: "2026-05-30T00:00:00.000Z",
        reasonCode: "live_probe_disabled",
        message: "Live probe is disabled by default."
      },
      docsPath: "docs/development/adapters/CLAUDE_CODE.md",
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z"
    });

    expect(mode.slug).toBe("claude_code.sdk");
    expect(mode.kind).toBe("sdk");
    expect(mode.capabilities).toContain("run.input");
    expect(mode.capabilities).toContain("approval.bridge");
    expect(mode.capabilities).toContain("tool.call.normalized");
    expect(mode.capabilities).toContain("tool.result.normalized");
    expect(mode.capabilities).toContain("user.question");
    expect(mode.capabilities).not.toContain("session.resume");
  });

  it("parses generic_http.async_rest runtime mode record", () => {
    const mode = runtimeModeSchema.parse({
      id: "runtime_mode_generic_http_async_rest",
      slug: "generic_http.async_rest",
      name: "Generic HTTP async REST",
      providerId: "provider_generic_http",
      runtimeId: "runtime_generic_http",
      adapterId: "generic_http",
      adapterType: "http",
      kind: "async_rest",
      status: "unknown",
      capabilities: [
        "run.start",
        "run.cancel",
        "run.timeout",
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "auth.none",
        "auth.api_key"
      ],
      limitations: [
        { code: "no_post_start_input", message: "generic_http.async_rest does not support post-start input in R4." },
        {
          code: "configured_endpoint_only",
          message: "The HTTP wrapper base URL is configured by daemon environment, not per run."
        },
        { code: "no_webhooks", message: "Webhook callbacks are not shipped for Generic HTTP in R4." }
      ],
      placement: {
        local: {
          support: "conditional",
          reason: "Requires SWITCHYARD_GENERIC_HTTP_BASE_URL to point at a reachable HTTP wrapper."
        },
        hosted: { support: "future", reason: "Hosted execution is not shipped in R4." },
        connectedLocalNode: { support: "future", reason: "Hybrid node execution is not shipped in R4." }
      },
      availability: {
        state: "unknown",
        canRun: false,
        installed: false,
        auth: "unknown",
        version: null,
        checkedAt: "2026-05-29T00:00:00.000Z",
        reasonCode: "generic_http_config_missing",
        message: "SWITCHYARD_GENERIC_HTTP_BASE_URL is not configured."
      },
      docsPath: "docs/development/adapters/GENERIC_HTTP.md",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z"
    });

    expect(mode.slug).toBe("generic_http.async_rest");
    expect(mode.adapterType).toBe("http");
    expect(mode.kind).toBe("async_rest");
    expect(mode.capabilities).toContain("auth.api_key");
  });

  it("parses agentfield.async_rest runtime mode record", () => {
    const mode = runtimeModeSchema.parse({
      id: "runtime_mode_agentfield_async_rest",
      slug: "agentfield.async_rest",
      name: "AgentField async REST",
      providerId: "provider_agentfield",
      runtimeId: "runtime_agentfield",
      adapterId: "agentfield",
      adapterType: "http",
      kind: "async_rest",
      status: "unknown",
      capabilities: [
        "run.start",
        "run.timeout",
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "auth.api_key"
      ],
      limitations: [
        {
          code: "configured_target_only",
          message: "agentfield.async_rest uses the daemon-level AgentField target configured by SWITCHYARD_AGENTFIELD_TARGET."
        },
        {
          code: "cancel_unsupported",
          message: "AgentField upstream cancellation is not claimed in R6 because no cancel endpoint is verified by this spec."
        }
      ],
      placement: {
        local: {
          support: "conditional",
          reason: "Requires SWITCHYARD_AGENTFIELD_BASE_URL, SWITCHYARD_AGENTFIELD_API_KEY, and SWITCHYARD_AGENTFIELD_TARGET."
        },
        hosted: { support: "future", reason: "Hosted execution is not shipped in R6." },
        connectedLocalNode: { support: "future", reason: "Hybrid local-node execution is not shipped in R6." }
      },
      availability: {
        state: "unavailable",
        canRun: false,
        installed: false,
        auth: "missing",
        version: null,
        checkedAt: "2026-05-30T00:00:00.000Z",
        reasonCode: "agentfield_config_missing",
        message: "SWITCHYARD_AGENTFIELD_BASE_URL is not configured."
      },
      docsPath: "docs/development/adapters/AGENTFIELD.md",
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z"
    });

    expect(mode.slug).toBe("agentfield.async_rest");
    expect(mode.capabilities).not.toContain("run.cancel");
    expect(mode.capabilities).toContain("auth.api_key");
  });

  it("parses opencode.acp runtime mode record", () => {
    const mode = runtimeModeSchema.parse({
      id: "runtime_mode_opencode_acp",
      slug: "opencode.acp",
      name: "OpenCode ACP",
      providerId: "provider_opencode",
      runtimeId: "runtime_opencode",
      adapterId: "opencode",
      adapterType: "acpx",
      kind: "acp",
      status: "unknown",
      capabilities: [
        "run.start",
        "run.cancel",
        "run.timeout",
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "artifact.raw_transcript",
        "auth.local"
      ],
      limitations: [
        { code: "one_prompt_per_run", message: "opencode.acp sends one ACP prompt per Switchyard run in R5." },
        { code: "no_post_start_input", message: "opencode.acp does not support POST /runs/:id/input in R5." },
        { code: "no_switchyard_approval_bridge", message: "ACP permission requests are failed visibly because Switchyard approval workflow is not shipped in R5." },
        { code: "configured_local_binary_only", message: "OpenCode command is daemon-level local configuration, not per run." },
        { code: "no_session_resume", message: "OpenCode ACP session load/resume/fork/list are not exposed through Switchyard in R5." }
      ],
      placement: {
        local: { support: "conditional", reason: "Requires a PATH-reachable local opencode binary and local OpenCode authentication/configuration." },
        hosted: { support: "future", reason: "Hosted execution is not shipped in R5." },
        connectedLocalNode: { support: "future", reason: "Hybrid local-node execution is not shipped in R5." }
      },
      availability: {
        state: "unknown",
        canRun: false,
        installed: false,
        auth: "unknown",
        version: null,
        checkedAt: "2026-05-30T00:00:00.000Z",
        reasonCode: "opencode_binary_unavailable",
        message: "OpenCode command was not found."
      },
      docsPath: "docs/development/adapters/OPENCODE.md",
      createdAt: "2026-05-30T00:00:00.000Z",
      updatedAt: "2026-05-30T00:00:00.000Z"
    });
    expect(mode.adapterType).toBe("acpx");
    expect(mode.kind).toBe("acp");
    expect(mode.slug).toBe("opencode.acp");
  });

  it("supports run and session runtimeMode compatibility and rejects runtime mode ids", () => {
    const runWithMode = runSchema.parse({
      id: "run_runtime_mode_new",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "Inspect runtime mode support",
      status: "queued",
      placement: "local",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      createdAt: "2026-05-29T00:00:00.000Z"
    });
    expect(runWithMode.runtimeMode).toBe("fake.deterministic");

    const oldRun = runSchema.parse({
      id: "run_runtime_mode_old",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "Legacy run",
      status: "queued",
      placement: "local",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      createdAt: "2026-05-29T00:00:00.000Z"
    });
    expect(oldRun.runtimeMode).toBeUndefined();
    expect(() =>
      runSchema.parse({
        ...oldRun,
        runtimeMode: "runtime_mode_fake_deterministic"
      })
    ).toThrow();

    const sessionWithMode = runtimeSessionSchema.parse({
      id: "session_mode_new",
      runId: "run_runtime_mode_new",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5.5",
      protocol: "process",
      status: "active",
      runtimeMode: "codex.exec_json",
      state: {},
      createdAt: "2026-05-29T00:00:00.000Z"
    });
    expect(sessionWithMode.runtimeMode).toBe("codex.exec_json");

    const legacySession = runtimeSessionSchema.parse({
      id: "session_mode_legacy",
      runId: "run_runtime_mode_old",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      protocol: "process",
      status: "created",
      state: {},
      createdAt: "2026-05-29T00:00:00.000Z"
    });
    expect(legacySession.runtimeMode).toBeUndefined();

    const nullSession = runtimeSessionSchema.parse({
      id: "session_mode_null",
      runId: "run_runtime_mode_old",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      protocol: "process",
      status: "created",
      runtimeMode: null,
      state: {},
      createdAt: "2026-05-29T00:00:00.000Z"
    });
    expect(nullSession.runtimeMode).toBeNull();
  });

  it("includes runtime_mode_not_found in HTTP error schemas", () => {
    expect(httpErrorCodeSchema.parse("runtime_mode_not_found")).toBe("runtime_mode_not_found");
    expect(
      httpErrorEnvelopeSchema.parse({
        error: {
          code: "runtime_mode_not_found",
          message: "Runtime mode not found: codex.exec_json"
        }
      }).error.code
    ).toBe("runtime_mode_not_found");
  });

  it("includes debate_not_found and evidence_not_found in HTTP error schemas", () => {
    expect(httpErrorCodeSchema.parse("debate_not_found")).toBe("debate_not_found");
    expect(httpErrorCodeSchema.parse("evidence_not_found")).toBe("evidence_not_found");
    expect(httpErrorCodeSchema.parse("placement_denied")).toBe("placement_denied");
    expect(httpErrorCodeSchema.parse("node_auth_failed")).toBe("node_auth_failed");
    expect(httpErrorCodeSchema.parse("assignment_claim_conflict")).toBe("assignment_claim_conflict");
    expect(httpErrorCodeSchema.parse("hosted_runtime_not_allowed")).toBe("hosted_runtime_not_allowed");
  });

  it("parses R10 assignment and node sync request contracts", () => {
    expect(
      assignmentSchema.parse({
        id: "assignment_123",
        runId: "run_123",
        nodeId: "node_123",
        status: "pending",
        retryCount: 0,
        lastEventSequence: 0,
        createdAt: "2026-05-30T00:00:00.000Z"
      }).status
    ).toBe("pending");

    expect(
      nodeRegisterRequestSchema.parse({
        capabilities: ["runtime.fake.deterministic"],
        policy: {
          allowRuntimeModes: ["fake.deterministic"],
          denyAdapterTypes: [],
          allowCwdPrefixes: ["/repo"],
          allowEventTypes: ["runtime.output"],
          artifactSync: "full"
        }
      }).policy?.allowRuntimeModes[0]
    ).toBe("fake.deterministic");

    expect(assignmentEventSyncRequestSchema.parse({ cursor: 0, events: [] }).events).toEqual([]);
    expect(
      assignmentClaimResponseSchema.parse({
        assignment: {
          id: "assignment_123",
          runId: "run_123",
          nodeId: "node_123",
          status: "claimed",
          retryCount: 0,
          lastEventSequence: 0,
          createdAt: "2026-05-30T00:00:00.000Z"
        },
        run: {
          id: "run_123",
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "assignment task",
          status: "running",
          placement: "connected_local_node",
          approvalPolicy: "default",
          timeoutSeconds: 60,
          metadata: {},
          runtimeMode: "fake.deterministic",
          createdAt: "2026-05-30T00:00:00.000Z"
        }
      }).assignment?.id
    ).toBe("assignment_123");

    expect(
      assignmentArtifactManifestRequestSchema.parse({
        artifacts: [
          {
            id: "artifact_123",
            type: "transcript",
            path: "runs/run_123/transcript.jsonl",
            contentType: "application/x-ndjson",
            sizeBytes: 0,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            syncContent: true
          }
        ]
      }).artifacts[0]?.id
    ).toBe("artifact_123");
  });

  it("parses debate participant and limits", () => {
    const debate = debateSchema.parse({
      id: "debate_123",
      topic: "Should Switchyard use ACP first?",
      mode: "mixed_model_panel",
      status: "created",
      participants: [
        {
          id: "participant_1",
          runtime: "opencode",
          provider: "opencode",
          model: "opencode/big-pickle",
          role: "architect",
          status: "created",
          turnsUsed: 0,
          runIds: []
        }
      ],
      limits: {
        maxRounds: 2,
        maxTurnsPerAgent: 3,
        maxSearchesPerAgent: 2,
        maxTotalMessages: 20,
        maxDurationSeconds: 300,
        maxCostUsd: 3,
        requireCitations: true,
        requireDisagreementSummary: true,
        stopOnConsensus: false,
        stopOnLowNewInformation: true,
        humanStopAllowed: true
      },
      evidenceIds: [],
      messageIds: [],
      eventIds: [],
      budget: {
        status: "within_budget",
        maxCostUsd: 0,
        spentCostUsd: 0
      },
      createdAt: "2026-05-11T00:00:00.000Z"
    });

    expect(debate.participants[0]?.role).toBe("architect");
    expect(debate.evidenceIds).toEqual([]);
    expect(debate.messageIds).toEqual([]);
    expect(debate.eventIds).toEqual([]);
    expect(debate.budget.status).toBe("within_budget");
  });

  it("parses the normalized event envelope", () => {
    const event = eventSchema.parse({
      id: "event_123",
      type: "runtime.output",
      runId: "run_123",
      sequence: 1,
      payload: { text: "hello" },
      createdAt: "2026-05-11T00:00:00.000Z"
    });

    expect(event.sequence).toBe(1);
  });

  it("includes R7 approval lifecycle event types", () => {
    expect(
      eventSchema.parse({
        id: "event_approval_approved",
        type: "approval.approved",
        runId: "run_123",
        sequence: 2,
        payload: { approvalId: "approval_123" },
        createdAt: "2026-05-30T00:00:00.000Z"
      }).type
    ).toBe("approval.approved");
    expect(
      eventSchema.parse({
        id: "event_approval_rejected",
        type: "approval.rejected",
        runId: "run_123",
        sequence: 3,
        payload: { approvalId: "approval_124" },
        createdAt: "2026-05-30T00:00:00.000Z"
      }).type
    ).toBe("approval.rejected");
    expect(
      eventSchema.parse({
        id: "event_approval_expired",
        type: "approval.expired",
        runId: "run_123",
        sequence: 4,
        payload: { approvalId: "approval_125" },
        createdAt: "2026-05-30T00:00:00.000Z"
      }).type
    ).toBe("approval.expired");
  });

  it("parses message routing records", () => {
    const message = messageSchema.parse({
      id: "message_123",
      fromRunId: "run_1",
      toRunId: "run_2",
      channel: "debate-room-001",
      content: "Challenge this",
      attachments: [],
      deliveryStatus: "queued",
      createdAt: "2026-05-11T00:00:00.000Z"
    });

    expect(message.deliveryStatus).toBe("queued");
  });

  it("parses artifacts, approvals, memory, evidence, tools, registry, placement, nodes, users, budgets, context, and errors", () => {
    expect(
      artifactSchema.parse({
        id: "artifact_123",
        type: "transcript",
        path: "runs/run_123/transcript.jsonl",
        metadata: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      }).type
    ).toBe("transcript");

    expect(
      approvalSchema.parse({
        id: "approval_123",
        runId: "run_123",
        approvalType: "before_destructive_command",
        status: "pending",
        payload: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      }).status
    ).toBe("pending");

    expect(
      memoryItemSchema.parse({
        id: "memory_123",
        scope: "project",
        content: "Use strict TypeScript",
        metadata: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      }).scope
    ).toBe("project");

    expect(
      evidenceItemSchema.parse({
        id: "evidence_123",
        sourceType: "url",
        title: "ACP docs",
        reliability: "primary",
        createdAt: "2026-05-11T00:00:00.000Z"
      }).reliability
    ).toBe("primary");

    expect(
      toolInvocationSchema.parse({
        id: "tool_123",
        type: "fake_echo",
        status: "queued",
        input: {},
        approvalId: "approval_123",
        error: {
          code: "tool_policy_denied",
          message: "real tools are denied in R7"
        },
        createdAt: "2026-05-11T00:00:00.000Z"
      }).type
    ).toBe("fake_echo");

    expect(providerSchema.parse({ id: "provider_123", name: "OpenCode", authMode: "local", status: "available" }).status).toBe("available");
    expect(runtimeSchema.parse({ id: "runtime_123", name: "OpenCode", adapterType: "acpx", status: "available" }).adapterType).toBe("acpx");
    expect(placementDecisionSchema.parse({ decision: "local", reason: "local runtime", mode: "local", requiredCapabilities: [], deniedCapabilities: [], approvalRequired: false, policyTrace: [] }).decision).toBe("local");
    expect(nodeSchema.parse({ id: "node_123", mode: "local", status: "online", capabilities: [], createdAt: "2026-05-11T00:00:00.000Z" }).status).toBe("online");
    expect(userSchema.parse({ id: "user_123", displayName: "Vasu", createdAt: "2026-05-11T00:00:00.000Z" }).displayName).toBe("Vasu");
    expect(budgetSchema.parse({ status: "within_budget", maxCostUsd: 5, spentCostUsd: 0 }).status).toBe("within_budget");
    expect(contextPacketSchema.parse({ id: "context_123", target: "run", sections: [], createdAt: "2026-05-11T00:00:00.000Z" }).target).toBe("run");
    expect(errorSchema.parse({ code: "validation_failed", message: "Invalid request" }).code).toBe("validation_failed");
  });

  it("rejects missing required fields for every public contract schema", () => {
    expectRequiredFields(
      runSchema,
      {
        id: "run_123",
        runtime: "opencode",
        provider: "opencode",
        model: "opencode/big-pickle",
        adapterType: "acpx",
        cwd: "/repo",
        task: "Inspect the repo",
        status: "queued",
        placement: "local",
        approvalPolicy: "default",
        timeoutSeconds: 60,
        metadata: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      [
        "id",
        "runtime",
        "provider",
        "model",
        "adapterType",
        "cwd",
        "task",
        "status",
        "placement",
        "approvalPolicy",
        "timeoutSeconds",
        "createdAt"
      ]
    );

    expectRequiredFields(
      runtimeSessionSchema,
      {
        id: "session_123",
        runId: "run_123",
        runtime: "opencode",
        provider: "opencode",
        model: "opencode/big-pickle",
        protocol: "process",
        status: "active",
        state: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "runId", "runtime", "provider", "model", "protocol", "status", "createdAt"]
    );

    expectRequiredFields(
      debateSchema,
      {
        id: "debate_123",
        topic: "Should Switchyard use ACP first?",
        mode: "mixed_model_panel",
        status: "created",
        participants: [],
        limits: {
          maxRounds: 1,
          maxTurnsPerAgent: 1,
          maxSearchesPerAgent: 0,
          maxTotalMessages: 2,
          maxDurationSeconds: 60,
          maxCostUsd: 0,
          requireCitations: false,
          requireDisagreementSummary: true,
          stopOnConsensus: false,
          stopOnLowNewInformation: false,
          humanStopAllowed: true
        },
        evidenceIds: [],
        messageIds: [],
        eventIds: [],
        budget: {
          status: "within_budget",
          maxCostUsd: 0,
          spentCostUsd: 0
        },
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "topic", "mode", "status", "participants", "limits", "budget", "createdAt"]
    );

    expectRequiredFields(
      eventSchema,
      {
        id: "event_123",
        type: "run.queued",
        runId: "run_123",
        sequence: 0,
        payload: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "type", "sequence", "payload", "createdAt"]
    );

    expectRequiredFields(
      messageSchema,
      {
        id: "message_123",
        content: "Challenge this",
        deliveryStatus: "queued",
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "content", "deliveryStatus", "createdAt"]
    );

    expectRequiredFields(
      artifactSchema,
      {
        id: "artifact_123",
        type: "transcript",
        path: "runs/run_123/transcript.jsonl",
        metadata: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "type", "path", "createdAt"]
    );

    expectRequiredFields(
      approvalSchema,
      {
        id: "approval_123",
        approvalType: "before_commit",
        status: "pending",
        payload: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "approvalType", "status", "payload", "createdAt"]
    );

    expectRequiredFields(
      memoryItemSchema,
      {
        id: "memory_123",
        scope: "project",
        content: "Use strict TypeScript",
        metadata: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "scope", "content", "createdAt"]
    );

    expectRequiredFields(
      evidenceItemSchema,
      {
        id: "evidence_123",
        sourceType: "manual",
        title: "ACP docs",
        reliability: "primary",
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "sourceType", "title", "reliability", "createdAt"]
    );

    expectRequiredFields(
      toolInvocationSchema,
      {
        id: "tool_123",
        type: "repo",
        status: "queued",
        input: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "type", "status", "input", "createdAt"]
    );

    expectRequiredFields(
      providerSchema,
      {
        id: "provider_123",
        name: "OpenCode",
        authMode: "none",
        status: "available"
      },
      ["id", "name", "authMode", "status"]
    );

    expectRequiredFields(
      runtimeSchema,
      {
        id: "runtime_123",
        name: "OpenCode",
        adapterType: "process",
        status: "available"
      },
      ["id", "name", "adapterType", "status"]
    );

    expectRequiredFields(
      modelSchema,
      {
        id: "model_123",
        providerId: "provider_123",
        modelName: "opencode/big-pickle",
        status: "available"
      },
      ["id", "providerId", "modelName", "status"]
    );

    expectRequiredFields(
      placementDecisionSchema,
      {
        decision: "local",
        reason: "local runtime",
        mode: "local",
        requiredCapabilities: [],
        deniedCapabilities: [],
        approvalRequired: false,
        policyTrace: []
      },
      ["decision", "reason", "mode", "requiredCapabilities", "deniedCapabilities", "approvalRequired", "policyTrace"]
    );

    expectRequiredFields(
      nodeSchema,
      {
        id: "node_123",
        mode: "local",
        status: "online",
        capabilities: [],
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "mode", "status", "capabilities", "createdAt"]
    );

    expectRequiredFields(
      userSchema,
      {
        id: "user_123",
        displayName: "Vasu",
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "displayName", "createdAt"]
    );

    expectRequiredFields(
      budgetSchema,
      {
        status: "within_budget",
        maxCostUsd: 1,
        spentCostUsd: 0
      },
      ["status", "maxCostUsd", "spentCostUsd"]
    );

    expectRequiredFields(
      contextPacketSchema,
      {
        id: "context_123",
        target: "run",
        sections: [],
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "target", "sections", "createdAt"]
    );

    expectRequiredFields(
      contextSectionSchema,
      {
        name: "research-notes",
        content: "Context captured from repo walk."
      },
      ["name", "content"]
    );

    expectRequiredFields(
      errorSchema,
      {
        code: "validation_failed",
        message: "bad"
      },
      ["code", "message"]
    );
  });
});
