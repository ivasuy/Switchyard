import type { SwitchyardEvent } from "@switchyard/contracts";

export function mapAcpSessionUpdateToSwitchyardEvent(input: {
  runId: string;
  acpSessionId?: string;
  update: unknown;
  sequence: number;
}): SwitchyardEvent {
  const updateRecord = readRecord(input.update);
  const updateType = typeof updateRecord?.["sessionUpdate"] === "string" ? updateRecord["sessionUpdate"] : "unknown";

  if (updateType === "agent_message_chunk") {
    const text = typeof updateRecord?.["text"] === "string"
      ? updateRecord["text"]
      : typeof updateRecord?.["content"] === "string"
        ? updateRecord["content"]
        : undefined;
    if (text && text.length > 0) {
      return event(input.runId, input.sequence, "runtime.output", {
        text,
        acpSessionId: input.acpSessionId,
        acpUpdateType: updateType
      });
    }
  }

  if (updateType === "plan") {
    const entries = Array.isArray(updateRecord?.["entries"]) ? updateRecord["entries"] : [];
    return event(input.runId, input.sequence, "runtime.status", {
      status: "acp_plan",
      entries
    });
  }

  if (updateType === "tool_call") {
    return event(input.runId, input.sequence, "runtime.status", {
      status: "acp_tool_call",
      toolCallId: updateRecord?.["toolCallId"],
      title: updateRecord?.["title"],
      kind: updateRecord?.["kind"],
      toolStatus: updateRecord?.["toolStatus"]
    });
  }

  if (updateType === "tool_call_update") {
    return event(input.runId, input.sequence, "runtime.status", {
      status: "acp_tool_call_update",
      toolCallId: updateRecord?.["toolCallId"],
      toolStatus: updateRecord?.["toolStatus"]
    });
  }

  if (updateType === "session_info_update") {
    return event(input.runId, input.sequence, "runtime.status", {
      status: "acp_session_info_update",
      title: updateRecord?.["title"],
      message: updateRecord?.["message"]
    });
  }

  if (updateType === "current_mode_update") {
    return event(input.runId, input.sequence, "runtime.status", {
      status: "acp_mode_update",
      modeId: updateRecord?.["modeId"],
      modeName: updateRecord?.["modeName"]
    });
  }

  if (updateType === "available_commands_update") {
    const commands = Array.isArray(updateRecord?.["commands"])
      ? updateRecord["commands"].flatMap((entry) => (typeof entry === "string" ? [entry] : []))
      : [];
    return event(input.runId, input.sequence, "runtime.status", {
      status: "acp_available_commands_update",
      commandCount: commands.length,
      commands
    });
  }

  return event(input.runId, input.sequence, "runtime.status", {
    status: "acp_update",
    acpUpdateType: updateType
  });
}

function event(
  runId: string,
  sequence: number,
  type: SwitchyardEvent["type"],
  payload: Record<string, unknown>
): SwitchyardEvent {
  return {
    id: `event_${crypto.randomUUID()}`,
    type,
    runId,
    sequence,
    payload,
    createdAt: new Date().toISOString()
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
