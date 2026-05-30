import type { SwitchyardEvent } from "@switchyard/contracts";
import { redactSecrets } from "@switchyard/core";
import type { ClaudeCodeProviderEvent } from "./types.js";

export interface ClaudeEventMapContext {
  runId: string;
  sequence: number;
  createdAt: string;
  unknownEventCount: number;
  unknownSuppressed: boolean;
}

export interface ClaudeEventMapResult {
  events: SwitchyardEvent[];
  unknownEventCount: number;
  unknownSuppressed: boolean;
}

export function mapClaudeCodeEventToSwitchyardEvent(
  providerEvent: ClaudeCodeProviderEvent,
  context: ClaudeEventMapContext
): ClaudeEventMapResult {
  const base = {
    id: "",
    runId: context.runId,
    sequence: context.sequence,
    createdAt: context.createdAt
  };

  const type = typeof providerEvent.type === "string" ? providerEvent.type : "unknown";
  if (type === "assistant_text_delta" && typeof providerEvent.text === "string") {
    return {
      events: [
        {
          ...base,
          id: `event_${crypto.randomUUID()}`,
          type: "runtime.output",
          payload: { text: providerEvent.text }
        }
      ],
      unknownEventCount: context.unknownEventCount,
      unknownSuppressed: context.unknownSuppressed
    };
  }

  if (type === "session" && typeof providerEvent.sessionId === "string") {
    return {
      events: [
        {
          ...base,
          id: `event_${crypto.randomUUID()}`,
          type: "runtime.status",
          payload: {
            status: "running",
            sessionStatePatch: { claudeSessionId: providerEvent.sessionId }
          }
        }
      ],
      unknownEventCount: context.unknownEventCount,
      unknownSuppressed: context.unknownSuppressed
    };
  }

  if (type === "tool_call") {
    return {
      events: [
        {
          ...base,
          id: `event_${crypto.randomUUID()}`,
          type: "tool.call",
          payload: {
            id: providerEvent.id,
            name: providerEvent.name,
            input: redactSecrets(providerEvent.input)
          }
        }
      ],
      unknownEventCount: context.unknownEventCount,
      unknownSuppressed: context.unknownSuppressed
    };
  }

  if (type === "tool_result") {
    return {
      events: [
        {
          ...base,
          id: `event_${crypto.randomUUID()}`,
          type: "tool.result",
          payload: {
            id: providerEvent.id,
            status: providerEvent.status,
            output: redactSecrets(providerEvent.output)
          }
        }
      ],
      unknownEventCount: context.unknownEventCount,
      unknownSuppressed: context.unknownSuppressed
    };
  }

  if (type === "approval_required") {
    const payload = redactSecrets({
      approvalType: providerEvent.approvalType,
      toolName: providerEvent.toolName,
      toolInput: providerEvent.toolInput
    });
    return {
      events: [
        {
          ...base,
          id: `event_${crypto.randomUUID()}`,
          type: "approval.requested",
          payload: {
            runtimeApprovalToken: providerEvent.token,
            ...payload
          }
        }
      ],
      unknownEventCount: context.unknownEventCount,
      unknownSuppressed: context.unknownSuppressed
    };
  }

  if (type === "ask_user_question") {
    const payload = redactSecrets({
      approvalType: "before_external_message",
      responseFormat: "ask_user_question",
      question: providerEvent.question,
      options: providerEvent.options
    });
    return {
      events: [
        {
          ...base,
          id: `event_${crypto.randomUUID()}`,
          type: "approval.requested",
          payload: {
            runtimeApprovalToken: providerEvent.token,
            ...payload
          }
        }
      ],
      unknownEventCount: context.unknownEventCount,
      unknownSuppressed: context.unknownSuppressed
    };
  }

  if (type === "completed") {
    return {
      events: [
        {
          ...base,
          id: `event_${crypto.randomUUID()}`,
          type: "run.completed",
          payload: { status: "completed", usage: providerEvent.usage }
        }
      ],
      unknownEventCount: context.unknownEventCount,
      unknownSuppressed: context.unknownSuppressed
    };
  }

  if (type === "failed") {
    return {
      events: [
        {
          ...base,
          id: `event_${crypto.randomUUID()}`,
          type: "run.failed",
          payload: {
            status: "failed",
            reasonCode: typeof providerEvent.reasonCode === "string" ? providerEvent.reasonCode : "claude_provider_failed",
            error: redactSecrets(providerEvent.error)
          }
        }
      ],
      unknownEventCount: context.unknownEventCount,
      unknownSuppressed: context.unknownSuppressed
    };
  }

  if (type === "cancelled") {
    return {
      events: [
        {
          ...base,
          id: `event_${crypto.randomUUID()}`,
          type: "run.cancelled",
          payload: { status: "cancelled" }
        }
      ],
      unknownEventCount: context.unknownEventCount,
      unknownSuppressed: context.unknownSuppressed
    };
  }

  if (context.unknownEventCount < 100) {
    return {
      events: [
        {
          ...base,
          id: `event_${crypto.randomUUID()}`,
          type: "runtime.status",
          payload: {
            status: "provider_event_unknown",
            providerType: type
          }
        }
      ],
      unknownEventCount: context.unknownEventCount + 1,
      unknownSuppressed: context.unknownSuppressed
    };
  }

  if (!context.unknownSuppressed) {
    return {
      events: [
        {
          ...base,
          id: `event_${crypto.randomUUID()}`,
          type: "runtime.status",
          payload: {
            status: "provider_event_unknown_suppressed",
            suppressedCount: context.unknownEventCount + 1
          }
        }
      ],
      unknownEventCount: context.unknownEventCount + 1,
      unknownSuppressed: true
    };
  }

  return {
    events: [],
    unknownEventCount: context.unknownEventCount + 1,
    unknownSuppressed: true
  };
}
