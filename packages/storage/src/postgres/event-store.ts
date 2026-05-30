import type { SwitchyardEvent } from "@switchyard/contracts";
import type { EventStore } from "@switchyard/core";

export class PostgresEventStore implements EventStore {
  private readonly items: SwitchyardEvent[] = [];

  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> {
    this.items.push(event);
    return event;
  }

  async listByRun(runId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((event) => event.runId === runId).sort((a, b) => a.sequence - b.sequence);
  }

  async listByDebate(debateId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((event) => event.debateId === debateId).sort((a, b) => a.sequence - b.sequence);
  }
}
