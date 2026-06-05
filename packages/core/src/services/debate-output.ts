import type { Debate, SwitchyardEvent } from "@switchyard/contracts";
import type { DebateChildRunKey } from "../ports/run-store.js";
import { DEBATE_CHILD_RUN_KEY_METADATA_FIELD } from "../ports/run-store.js";

export type DebateOutputKind = "participant" | "judge";
export type DebateOutputErrorCode =
  | "debate_participant_output_missing"
  | "debate_participant_output_empty"
  | "debate_participant_output_too_large"
  | "debate_participant_output_unowned"
  | "debate_judge_output_missing"
  | "debate_judge_output_empty"
  | "debate_judge_output_too_large"
  | "debate_judge_output_invalid";

export interface ExtractDebateRuntimeOutputExpected {
  debateId: string;
  childRunKey: DebateChildRunKey;
  maxBytes: number;
  runId?: string;
  outputKind?: DebateOutputKind;
}

export interface ExtractedDebateOutput {
  ok: true;
  text: string;
  outputBytes: number;
  eventId: string;
  runId?: string;
  sequence: number;
}

export interface DebateOutputError {
  ok: false;
  code: DebateOutputErrorCode;
  message: string;
  outputBytes?: number;
  eventId?: string;
  runId?: string;
}

export type ExtractDebateRuntimeOutputResult = ExtractedDebateOutput | DebateOutputError;

export interface DebateRuntimeOutputTiming {
  classification: "current" | "late";
  canRouteMessage: boolean;
  recommendedAction: "route" | "ignore_or_record_late";
}

export function extractDebateRuntimeOutput(
  events: readonly SwitchyardEvent[],
  expected: ExtractDebateRuntimeOutputExpected
): ExtractDebateRuntimeOutputResult {
  const kind = expected.outputKind ?? "participant";
  if (!Number.isInteger(expected.maxBytes) || expected.maxBytes < 1) {
    return outputError(kind, "too_large", `maxBytes must be a positive integer`, { outputBytes: 0 });
  }

  const outputEvents = events
    .filter((event) => event.type === "runtime.output")
    .filter((event) => expected.runId === undefined || event.runId === expected.runId)
    .sort((left, right) => left.sequence - right.sequence);

  if (outputEvents.length === 0) {
    return outputError(kind, "missing", "No persisted runtime.output event was found");
  }

  if (expected.runId !== undefined) {
    for (const event of outputEvents) {
      if (!eventMatchesDebateOutput(event, expected)) {
        return outputError(kind, "unowned", "runtime.output metadata does not match the expected debate child run", {
          eventId: event.id,
          ...optionalRunId(event.runId)
        });
      }
    }
  }

  const matchingOutputEvents = outputEvents.filter((event) => eventMatchesDebateOutput(event, expected));
  if (matchingOutputEvents.length === 0) {
    return outputError(kind, "missing", "No matching persisted runtime.output event was found");
  }

  const event = matchingOutputEvents[matchingOutputEvents.length - 1];
  if (!event) {
    return outputError(kind, "missing", "No matching persisted runtime.output event was found");
  }
  const rawText = event.payload["text"];
  if (typeof rawText !== "string") {
    return outputError(kind, "missing", "runtime.output text is missing", { eventId: event.id, ...optionalRunId(event.runId) });
  }

  const outputBytes = Buffer.byteLength(rawText, "utf8");
  if (outputBytes > expected.maxBytes) {
    return outputError(kind, "too_large", `runtime.output exceeds ${expected.maxBytes} bytes`, {
      outputBytes,
      eventId: event.id,
      ...optionalRunId(event.runId)
    });
  }

  const text = rawText.trim();
  if (text.length === 0) {
    return outputError(kind, "empty", "runtime.output text is empty", {
      outputBytes,
      eventId: event.id,
      ...optionalRunId(event.runId)
    });
  }

  const extracted: ExtractedDebateOutput = {
    ok: true,
    text,
    outputBytes,
    eventId: event.id,
    sequence: event.sequence
  };
  if (event.runId !== undefined) {
    extracted.runId = event.runId;
  }
  return extracted;
}

export function classifyDebateRuntimeOutputTiming(input: {
  debateStatus: Debate["status"];
}): DebateRuntimeOutputTiming {
  if (isTerminalDebateStatus(input.debateStatus)) {
    return {
      classification: "late",
      canRouteMessage: false,
      recommendedAction: "ignore_or_record_late"
    };
  }
  return {
    classification: "current",
    canRouteMessage: true,
    recommendedAction: "route"
  };
}

export function isTerminalDebateStatus(status: Debate["status"]): boolean {
  return status === "consensus_found"
    || status === "no_consensus"
    || status === "stopped_by_user"
    || status === "completed"
    || status === "failed";
}

function eventMatchesDebateOutput(event: SwitchyardEvent, expected: ExtractDebateRuntimeOutputExpected): boolean {
  const eventDebateId = event.debateId ?? stringField(event.payload, "debateId") ?? stringField(recordField(event.payload, "metadata"), "debateId");
  const eventChildRunKey =
    stringField(event.payload, DEBATE_CHILD_RUN_KEY_METADATA_FIELD)
    ?? stringField(recordField(event.payload, "metadata"), DEBATE_CHILD_RUN_KEY_METADATA_FIELD);
  return eventDebateId === expected.debateId && eventChildRunKey === expected.childRunKey;
}

function outputError(
  kind: DebateOutputKind,
  reason: "missing" | "empty" | "too_large" | "unowned" | "invalid",
  message: string,
  details: Omit<DebateOutputError, "ok" | "code" | "message"> = {}
): DebateOutputError {
  const code = kind === "judge" ? judgeCode(reason) : participantCode(reason);
  return {
    ok: false,
    code,
    message,
    ...details
  };
}

function participantCode(reason: "missing" | "empty" | "too_large" | "unowned" | "invalid"): DebateOutputErrorCode {
  switch (reason) {
    case "missing":
      return "debate_participant_output_missing";
    case "empty":
      return "debate_participant_output_empty";
    case "too_large":
      return "debate_participant_output_too_large";
    case "unowned":
    case "invalid":
      return "debate_participant_output_unowned";
  }
}

function judgeCode(reason: "missing" | "empty" | "too_large" | "unowned" | "invalid"): DebateOutputErrorCode {
  switch (reason) {
    case "missing":
    case "unowned":
      return "debate_judge_output_missing";
    case "empty":
      return "debate_judge_output_empty";
    case "too_large":
      return "debate_judge_output_too_large";
    case "invalid":
      return "debate_judge_output_invalid";
  }
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    return undefined;
  }
  return field as Record<string, unknown>;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function optionalRunId(runId: string | undefined): { runId: string } | Record<string, never> {
  return runId === undefined ? {} : { runId };
}
