import type { RoutedMessage, SwitchyardEvent } from "@switchyard/contracts";
import type { EventStore } from "../ports/event-store.js";
import type { MessageStore, ListMessagesFilter, ListMessagesResult } from "../ports/message-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { EventBus } from "./event-bus.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";

class ServiceError extends Error {
  readonly code: string;
  readonly details?: Array<{ path: string; issue: string }>;

  constructor(code: string, message: string, details?: Array<{ path: string; issue: string }>) {
    super(message);
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface CreateMessageInput {
  fromRunId?: string | undefined;
  toRunId?: string | undefined;
  channel?: string | undefined;
  debateId?: string | undefined;
  participantId?: string | undefined;
  content: string;
  attachments?: Array<Record<string, unknown>> | undefined;
}

export interface MessageRouterDependencies {
  runs: RunStore;
  messages: MessageStore;
  events: EventStore;
  eventBus?: EventBus;
  logger?: RuntimeLogger;
}

export class MessageRouter {
  constructor(private readonly deps: MessageRouterDependencies) {}

  async create(input: CreateMessageInput): Promise<RoutedMessage> {
    const created = await this.createWithEvent(input);
    return created.message;
  }

  async createWithEvent(input: CreateMessageInput): Promise<{ message: RoutedMessage; event: SwitchyardEvent }> {
    const trimmedContent = input.content.trim();
    if (trimmedContent.length === 0) {
      throw new ServiceError("invalid_input", "content is required", [{ path: "content", issue: "must be a non-empty string" }]);
    }
    if (!input.toRunId && !input.channel) {
      throw new ServiceError("invalid_input", "toRunId or channel is required", [
        { path: "toRunId", issue: "required when channel is missing" }
      ]);
    }
    if (input.fromRunId) {
      const from = await this.deps.runs.get(input.fromRunId);
      if (!from) {
        throw new ServiceError("run_not_found", `Run not found: ${input.fromRunId}`);
      }
    }
    if (input.toRunId) {
      const to = await this.deps.runs.get(input.toRunId);
      if (!to) {
        throw new ServiceError("run_not_found", `Run not found: ${input.toRunId}`);
      }
    }

    const now = new Date().toISOString();
    const message: RoutedMessage = {
      id: `message_${crypto.randomUUID()}`,
      content: trimmedContent,
      attachments: input.attachments ?? [],
      deliveryStatus: "delivered",
      createdAt: now,
      deliveredAt: now
    };
    if (input.fromRunId) message.fromRunId = input.fromRunId;
    if (input.toRunId) message.toRunId = input.toRunId;
    if (input.channel) message.channel = input.channel;

    await this.deps.messages.create(message);

    const eventRunId = input.toRunId ?? input.fromRunId;
    const event = await this.createMessageEvent(eventRunId, message, input.debateId, input.participantId);
    await this.deps.events.append(event);
    if (this.deps.eventBus) {
      try {
        await this.deps.eventBus.publish(event);
      } catch (error) {
        this.deps.logger?.warn("message.route_failed", {
          messageId: message.id,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return { message, event };
  }

  async list(filter: ListMessagesFilter): Promise<ListMessagesResult> {
    return this.deps.messages.list(filter);
  }

  async get(id: string): Promise<RoutedMessage | undefined> {
    return this.deps.messages.get(id);
  }

  private async createMessageEvent(
    runId: string | undefined,
    message: RoutedMessage,
    debateId: string | undefined,
    participantId: string | undefined
  ): Promise<SwitchyardEvent> {
    const runSequence = runId ? this.nextSequence(await this.deps.events.listByRun(runId)) : 0;
    const debateSequence = debateId ? this.nextSequence(await this.deps.events.listByDebate(debateId)) : 0;
    const sequence = debateId ? Math.max(runSequence, debateSequence) : runSequence;
    const event: SwitchyardEvent = {
      id: `event_${crypto.randomUUID()}`,
      type: "message.sent",
      sequence,
      payload: {
        messageId: message.id,
        channel: message.channel,
        deliveryStatus: message.deliveryStatus,
        debateId,
        participantId
      },
      createdAt: new Date().toISOString()
    };
    if (runId) {
      event.runId = runId;
    }
    if (debateId) {
      event.debateId = debateId;
    }
    if (participantId) {
      event.participantId = participantId;
    }
    return event;
  }

  private nextSequence(events: SwitchyardEvent[]): number {
    if (events.length === 0) {
      return 0;
    }
    const max = events.reduce((acc, event) => (event.sequence > acc ? event.sequence : acc), -1);
    return max + 1;
  }
}

export { ServiceError as MessageRouterError };
