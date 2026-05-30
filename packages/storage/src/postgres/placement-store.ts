import type { PlacementDecisionRecord, PlacementStore } from "@switchyard/core";

export class PostgresPlacementStore implements PlacementStore {
  private readonly items = new Map<string, PlacementDecisionRecord>();

  async create(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> {
    if (!record.runId) throw new Error("placement records require a runId");
    this.items.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<PlacementDecisionRecord | undefined> {
    return this.items.get(id);
  }

  async update(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> {
    if (!record.runId) throw new Error("placement records require a runId");
    this.items.set(record.id, record);
    return record;
  }

  async listByRun(runId: string): Promise<PlacementDecisionRecord[]> {
    return [...this.items.values()].filter((record) => record.runId === runId);
  }
}
