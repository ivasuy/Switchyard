import { describe, expect, it, vi } from "vitest";
import type { Debate } from "@switchyard/contracts";
import { DebateJudgeRunner } from "../src/services/debate-judge-runner.js";

function makeDebate(overrides: Partial<Debate> = {}): Debate {
  return {
    id: "debate_1",
    topic: "Should R24 ship hosted debates?",
    mode: "same_provider_model_debate",
    status: "judging",
    participants: [
      {
        id: "participant_1",
        runtime: "fake",
        provider: "test",
        model: "test-model",
        role: "affirmative",
        status: "completed",
        turnsUsed: 1,
        runIds: ["run_1"],
        runId: "run_1"
      },
      {
        id: "participant_2",
        runtime: "fake",
        provider: "test",
        model: "test-model",
        role: "skeptic",
        status: "completed",
        turnsUsed: 1,
        runIds: ["run_2"],
        runId: "run_2"
      }
    ],
    limits: {
      maxRounds: 1,
      maxTurnsPerAgent: 1,
      maxSearchesPerAgent: 0,
      maxTotalMessages: 2,
      maxDurationSeconds: 30,
      maxCostUsd: 0,
      requireCitations: false,
      requireDisagreementSummary: true,
      stopOnConsensus: false,
      stopOnLowNewInformation: false,
      humanStopAllowed: false
    },
    evidenceIds: ["evidence_1"],
    messageIds: ["message_1"],
    eventIds: [],
    budget: {
      status: "within_budget",
      maxCostUsd: 0,
      spentCostUsd: 0
    },
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    ...overrides
  };
}

describe("DebateJudgeRunner", () => {
  it("runs the deterministic no-spend judge by default", () => {
    const runner = new DebateJudgeRunner();
    const judge = runner.runDeterministic({
      debate: makeDebate(),
      messages: [
        {
          id: "message_1",
          debateId: "debate_1",
          participantId: "participant_1",
          fromRunId: "run_1",
          toRunId: "run_2",
          channel: "debate:debate_1",
          content: "argument",
          attachments: [],
          deliveryStatus: "delivered",
          createdAt: "2026-05-30T00:00:00.000Z"
        }
      ]
    });

    expect(judge).toMatchObject({
      consensus: "no_consensus",
      winner: "none",
      evidenceIds: ["evidence_1"],
      messageIds: ["message_1"]
    });
  });

  it("requires spend confirmation for a model judge", () => {
    const runner = new DebateJudgeRunner();

    expect(() => runner.assertModelJudgeSpendConfirmed({ mode: "model" }))
      .toThrowError(expect.objectContaining({ code: "debate_judge_live_spend_unconfirmed" }));
  });

  it("rejects overlarge judge output before JSON.parse", () => {
    const runner = new DebateJudgeRunner();
    const parseSpy = vi.spyOn(JSON, "parse");

    expect(() => runner.parseModelJudgeOutput("{not-json-and-too-large", {
      maxBytes: 4,
      debate: makeDebate()
    })).toThrowError(expect.objectContaining({
      code: "debate_judge_output_too_large",
      outputBytes: 23
    }));
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it("maps blank, invalid, and incomplete judge output to named errors", () => {
    const runner = new DebateJudgeRunner();
    const debate = makeDebate();

    expect(() => runner.parseModelJudgeOutput("   ", { maxBytes: 100, debate }))
      .toThrowError(expect.objectContaining({ code: "debate_judge_output_empty" }));
    expect(() => runner.parseModelJudgeOutput("{", { maxBytes: 100, debate }))
      .toThrowError(expect.objectContaining({ code: "debate_judge_output_invalid" }));
    expect(() => runner.parseModelJudgeOutput("{\"summary\":\"ok\"}", { maxBytes: 100, debate }))
      .toThrowError(expect.objectContaining({ code: "debate_judge_output_invalid" }));
  });

  it("parses bounded model judge JSON into the debate judge shape", () => {
    const runner = new DebateJudgeRunner();
    const judge = runner.parseModelJudgeOutput(JSON.stringify({
      consensus: "consensus_found",
      summary: "The arguments converge.",
      disagreementSummary: "The remaining disagreement is operational."
    }), {
      maxBytes: 512,
      debate: makeDebate()
    });

    expect(judge).toEqual({
      consensus: "consensus_found",
      summary: "The arguments converge.",
      disagreementSummary: "The remaining disagreement is operational.",
      winner: "none",
      evidenceIds: ["evidence_1"],
      messageIds: ["message_1"]
    });
  });
});
