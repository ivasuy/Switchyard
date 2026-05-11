import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  approvalSchema,
  artifactSchema,
  budgetSchema,
  contextPacketSchema,
  debateSchema,
  errorSchema,
  eventSchema,
  evidenceItemSchema,
  memoryItemSchema,
  messageSchema,
  nodeSchema,
  placementDecisionSchema,
  providerSchema,
  runSchema,
  runtimeSchema,
  runtimeSessionSchema,
  toolInvocationSchema,
  userSchema
} from "../src/index.js";

function expectRequiredFields(schema: z.ZodType, valid: Record<string, unknown>, requiredKeys: string[]): void {
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
          turnsUsed: 0
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
      createdAt: "2026-05-11T00:00:00.000Z"
    });

    expect(debate.participants[0]?.role).toBe("architect");
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
        type: "web_search",
        status: "queued",
        input: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      }).type
    ).toBe("web_search");

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
        createdAt: "2026-05-11T00:00:00.000Z"
      },
      ["id", "topic", "mode", "status", "participants", "limits", "createdAt"]
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
      errorSchema,
      {
        code: "validation_failed",
        message: "bad"
      },
      ["code", "message"]
    );
  });
});
