import type { SwitchyardEvent } from "@switchyard/contracts";

export function parseCodexJsonLine(line: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("line is not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Codex JSONL line: ${message}`);
  }
}

export function codexEventToSwitchyardEvent(
  event: Record<string, unknown>,
  context: { runId: string; sequence: number; createdAt: string }
): SwitchyardEvent {
  const codexType = typeof event.type === "string" ? event.type : "unknown";
  const baseEvent = {
    id: `event_${crypto.randomUUID()}`,
    runId: context.runId,
    sequence: context.sequence,
    createdAt: context.createdAt
  };

  if (codexType === "turn.completed") {
    return {
      ...baseEvent,
      type: "run.completed",
      payload: { status: "completed", codexType, usage: event.usage }
    };
  }

  if (codexType === "turn.failed" || codexType === "error") {
    return {
      ...baseEvent,
      type: "run.failed",
      payload: {
        status: "failed",
        codexType,
        error: event.error ?? event.message ?? event
      }
    };
  }

  const text = codexType.startsWith("item.") ? extractText(event) : undefined;
  if (text) {
    return {
      ...baseEvent,
      type: "runtime.output",
      payload: { text, codexType }
    };
  }

  return {
    ...baseEvent,
    type: "runtime.status",
    payload: {
      status: statusForCodexType(codexType),
      codexType,
      threadId: readThreadId(event)
    }
  };
}

function statusForCodexType(type: string): string {
  if (type === "thread.started") {
    return "thread_started";
  }
  if (type === "turn.started") {
    return "turn_started";
  }
  return "event";
}

function extractText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const key of ["text", "message", "delta"]) {
    if (typeof record[key] === "string" && record[key].length > 0) {
      return record[key];
    }
  }

  if (record.item) {
    const fromItem = extractText(record.item);
    if (fromItem) {
      return fromItem;
    }
  }

  if (Array.isArray(record.content)) {
    const textParts = record.content
      .map((part) => extractText(part))
      .filter((part): part is string => typeof part === "string" && part.length > 0);
    if (textParts.length > 0) {
      return textParts.join("");
    }
  }

  return undefined;
}

function readThreadId(value: Record<string, unknown>): string | undefined {
  if (typeof value.thread_id === "string") {
    return value.thread_id;
  }
  if (value.item && typeof value.item === "object" && value.item !== null) {
    const item = value.item as Record<string, unknown>;
    return typeof item.thread_id === "string" ? item.thread_id : undefined;
  }
  return undefined;
}
