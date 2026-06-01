import { describe, expect, it } from "vitest";
import type { Debate } from "@switchyard/contracts";
import { PostgresDebateStore } from "../src/index.js";

function makeDebate(): Debate {
  return {
    id: "debate_pg_1",
    topic: "Should we ship hosted debate?",
    mode: "same_provider_model_debate",
    status: "completed",
    participants: [
      {
        id: "participant_1",
        runId: "run_1",
        runIds: ["run_1", "run_3"],
        runtime: "fake",
        provider: "test",
        model: "test-model",
        role: "affirmative",
        status: "completed",
        turnsUsed: 2
      },
      {
        id: "participant_2",
        runId: "run_2",
        runIds: ["run_2", "run_4"],
        runtime: "fake",
        provider: "test",
        model: "test-model",
        role: "skeptic",
        status: "completed",
        turnsUsed: 2
      }
    ],
    limits: {
      maxRounds: 3,
      maxTurnsPerAgent: 3,
      maxSearchesPerAgent: 1,
      maxTotalMessages: 6,
      maxDurationSeconds: 60,
      maxCostUsd: 0,
      requireCitations: false,
      requireDisagreementSummary: true,
      stopOnConsensus: false,
      stopOnLowNewInformation: false,
      humanStopAllowed: false
    },
    evidenceIds: ["evidence_1"],
    messageIds: ["message_1", "message_2"],
    eventIds: ["event_1", "event_2"],
    judge: {
      consensus: "no_consensus",
      summary: "No consensus",
      disagreementSummary: "Major disagreements remain",
      winner: "none",
      evidenceIds: ["evidence_1"],
      messageIds: ["message_1", "message_2"]
    },
    finalReportArtifactId: "artifact_1",
    finalReportPath: "debates/debate_pg_1/report.md",
    stopReason: "completed",
    budget: {
      status: "within_budget",
      maxCostUsd: 0,
      spentCostUsd: 0
    },
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:05:00.000Z",
    completedAt: "2026-06-02T00:06:00.000Z",
    error: {
      code: "none",
      message: "n/a"
    }
  };
}

describe("postgres debate store", () => {
  it("round-trips full debate payload with update", async () => {
    const store = new PostgresDebateStore();
    const created = makeDebate();
    await store.create(created);

    const loaded = await store.get(created.id);
    expect(loaded).toEqual(created);

    const updated: Debate = {
      ...created,
      status: "failed",
      stopReason: "failed",
      error: {
        code: "debate_execution_failed",
        message: "worker timeout"
      },
      updatedAt: "2026-06-02T00:08:00.000Z"
    };
    await store.update(updated);

    await expect(store.get(created.id)).resolves.toEqual(updated);
  });

  it("preserves sqlite-style undefined parity for optional fields", async () => {
    const store = new PostgresDebateStore();
    const debate: Debate = {
      ...makeDebate(),
      id: "debate_pg_2",
      status: "created",
      messageIds: [],
      eventIds: [],
      evidenceIds: [],
      participants: makeDebate().participants.map((entry) => ({
        ...entry,
        runId: undefined,
        runIds: []
      })),
      judge: undefined,
      finalReportArtifactId: undefined,
      finalReportPath: undefined,
      stopReason: undefined,
      updatedAt: undefined,
      completedAt: undefined,
      error: undefined
    };

    await store.create(debate);
    const loaded = await store.get(debate.id);
    expect(loaded).toEqual(debate);
    expect(loaded).not.toBeUndefined();
    expect(loaded?.judge).toBeUndefined();
    expect(loaded?.finalReportArtifactId).toBeUndefined();
    expect(loaded?.finalReportPath).toBeUndefined();
    expect(loaded?.updatedAt).toBeUndefined();
    expect(loaded?.completedAt).toBeUndefined();
    expect(loaded?.error).toBeUndefined();
  });
});
