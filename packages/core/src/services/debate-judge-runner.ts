import type { Debate, RoutedMessage } from "@switchyard/contracts";

export type DebateJudge = NonNullable<Debate["judge"]>;

export type DebateJudgeRunnerErrorCode =
  | "debate_judge_live_spend_unconfirmed"
  | "debate_judge_output_missing"
  | "debate_judge_output_empty"
  | "debate_judge_output_too_large"
  | "debate_judge_output_invalid";

export class DebateJudgeRunnerError extends Error {
  readonly code: DebateJudgeRunnerErrorCode;
  readonly outputBytes?: number;

  constructor(code: DebateJudgeRunnerErrorCode, message: string, details: { outputBytes?: number } = {}) {
    super(message);
    this.name = "DebateJudgeRunnerError";
    this.code = code;
    if (details.outputBytes !== undefined) {
      this.outputBytes = details.outputBytes;
    }
  }
}

export interface DebateJudgeRunnerConfig {
  mode?: "deterministic" | "model";
  confirmLiveProviderSpend?: boolean;
}

export class DebateJudgeRunner {
  runDeterministic(input: { debate: Debate; messages: RoutedMessage[] }): DebateJudge {
    const consensus = hasConsensus(input.debate) ? "consensus_found" : "no_consensus";
    const summary = input.messages.length === 0
      ? "The participants did not produce debate messages before termination."
      : "The participants completed bounded debate turns and retained disagreement.";
    const disagreementSummary = input.debate.limits.requireDisagreementSummary
      ? "affirmative favors proving the debate workflow first; skeptic asks for visible runtime evidence before promotion."
      : "disagreement summary disabled";

    return {
      consensus,
      summary,
      disagreementSummary,
      winner: "none",
      evidenceIds: [...input.debate.evidenceIds],
      messageIds: [...input.debate.messageIds]
    };
  }

  assertModelJudgeSpendConfirmed(config: DebateJudgeRunnerConfig | undefined): void {
    if (config?.mode === "model" && config.confirmLiveProviderSpend !== true) {
      throw new DebateJudgeRunnerError(
        "debate_judge_live_spend_unconfirmed",
        "Model judge requires confirmLiveProviderSpend: true"
      );
    }
  }

  parseModelJudgeOutput(text: unknown, limits: { maxBytes: number; debate: Debate }): DebateJudge {
    if (typeof text !== "string") {
      throw new DebateJudgeRunnerError("debate_judge_output_missing", "Judge runtime.output text is missing");
    }
    const outputBytes = Buffer.byteLength(text, "utf8");
    if (outputBytes > limits.maxBytes) {
      throw new DebateJudgeRunnerError(
        "debate_judge_output_too_large",
        `Judge runtime.output exceeds ${limits.maxBytes} bytes`,
        { outputBytes }
      );
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new DebateJudgeRunnerError("debate_judge_output_empty", "Judge runtime.output text is empty", { outputBytes });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new DebateJudgeRunnerError("debate_judge_output_invalid", "Judge runtime.output is not valid JSON", { outputBytes });
    }

    if (!isRecord(parsed)) {
      throw new DebateJudgeRunnerError("debate_judge_output_invalid", "Judge output must be a JSON object", { outputBytes });
    }
    const summary = stringField(parsed, "summary");
    const disagreementSummary = stringField(parsed, "disagreementSummary");
    const consensus = parsed["consensus"] === "consensus_found" ? "consensus_found" : "no_consensus";
    if (!summary || !disagreementSummary) {
      throw new DebateJudgeRunnerError(
        "debate_judge_output_invalid",
        "Judge output must include summary and disagreementSummary",
        { outputBytes }
      );
    }

    return {
      consensus,
      summary,
      disagreementSummary,
      winner: "none",
      evidenceIds: [...limits.debate.evidenceIds],
      messageIds: [...limits.debate.messageIds]
    };
  }
}

function hasConsensus(debate: Debate): boolean {
  const roles = debate.participants.map((participant) => participant.role.toLowerCase());
  return roles.length === 2 && roles[0] === roles[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}
