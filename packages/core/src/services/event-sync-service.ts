import type { EventStore } from "../ports/event-store.js";
import type { NodeAssignmentStore } from "../ports/node-assignment-store.js";
import type { EventBus } from "./event-bus.js";
import type { SwitchyardEvent } from "@switchyard/contracts";

export class EventSyncError extends Error {
  readonly code: "assignment_not_found" | "event_sync_gap" | "event_sync_conflict";

  constructor(code: EventSyncError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface EventSyncServiceDependencies {
  assignments: NodeAssignmentStore;
  events: EventStore;
  eventBus?: EventBus;
}

export class EventSyncService {
  constructor(private readonly deps: EventSyncServiceDependencies) {}

  async appendBatch(nodeId: string, assignmentId: string, input: { cursor?: number; events: SwitchyardEvent[] }): Promise<{ accepted: true; appended: number; nextCursor: number }> {
    const assignment = await this.deps.assignments.get(assignmentId);
    if (!assignment || assignment.nodeId !== nodeId) {
      throw new EventSyncError("assignment_not_found", `Assignment not found: ${assignmentId}`);
    }
    if (assignment.status !== "claimed" && assignment.status !== "running") {
      throw new EventSyncError("assignment_not_found", `Assignment is not accepting event sync: ${assignmentId}`);
    }
    if (input.cursor !== undefined && input.cursor !== assignment.lastEventSequence) {
      throw new EventSyncError(
        "event_sync_conflict",
        `Cursor ${input.cursor} does not match assignment cursor ${assignment.lastEventSequence}`
      );
    }

    if (input.events.length === 0) {
      return { accepted: true, appended: 0, nextCursor: assignment.lastEventSequence };
    }

    let expected = assignment.lastEventSequence + 1;
    let appended = 0;
    const existingEvents = await this.deps.events.listByRun(assignment.runId);

    for (const event of input.events) {
      if (!event.runId || event.runId !== assignment.runId) {
        throw new EventSyncError(
          "event_sync_conflict",
          `Event runId must equal assignment runId: ${assignment.runId}`
        );
      }
      if (event.sequence > expected) {
        throw new EventSyncError("event_sync_gap", `Expected sequence ${expected} but got ${event.sequence}`);
      }

      if (event.sequence < expected) {
        const existing = existingEvents.find((item) => item.sequence === event.sequence);
        if (!existing || JSON.stringify(existing.payload) !== JSON.stringify(event.payload) || existing.type !== event.type) {
          throw new EventSyncError("event_sync_conflict", `Conflicting event for sequence ${event.sequence}`);
        }
        continue;
      }

      await this.deps.events.append(event);
      await this.deps.eventBus?.publish(event);
      appended += 1;
      expected += 1;
    }

    const updated = {
      ...assignment,
      status: assignment.status === "claimed" ? "running" : assignment.status,
      lastEventSequence: expected - 1
    };
    await this.deps.assignments.update(updated);

    return {
      accepted: true,
      appended,
      nextCursor: updated.lastEventSequence
    };
  }
}
