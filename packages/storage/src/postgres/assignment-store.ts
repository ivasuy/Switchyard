import type { Assignment } from "@switchyard/contracts";
import type { NodeAssignmentStore } from "@switchyard/core";

export class PostgresAssignmentStore implements NodeAssignmentStore {
  private readonly items = new Map<string, Assignment>();

  async create(record: Assignment): Promise<Assignment> {
    this.items.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<Assignment | undefined> {
    return this.items.get(id);
  }

  async update(record: Assignment): Promise<Assignment> {
    this.items.set(record.id, record);
    return record;
  }

  async listClaimable(nodeId: string, _now: string): Promise<Assignment[]> {
    return [...this.items.values()].filter((assignment) => assignment.nodeId === nodeId && assignment.status === "pending");
  }

  async claim(input: { assignmentId: string; nodeId: string; now: string }): Promise<Assignment | undefined> {
    const assignment = this.items.get(input.assignmentId);
    if (!assignment || assignment.nodeId !== input.nodeId || assignment.status !== "pending") {
      return undefined;
    }
    const claimed: Assignment = { ...assignment, status: "claimed", claimedAt: input.now };
    this.items.set(claimed.id, claimed);
    return claimed;
  }

  async complete(id: string, now: string): Promise<Assignment | undefined> {
    const assignment = this.items.get(id);
    if (!assignment) return undefined;
    const completed: Assignment = { ...assignment, status: "completed", completedAt: now };
    this.items.set(id, completed);
    return completed;
  }

  async fail(id: string, now: string, error: string): Promise<Assignment | undefined> {
    const assignment = this.items.get(id);
    if (!assignment) return undefined;
    const failed: Assignment = { ...assignment, status: "failed", failedAt: now, error };
    this.items.set(id, failed);
    return failed;
  }

  async cancel(id: string, now: string): Promise<Assignment | undefined> {
    const assignment = this.items.get(id);
    if (!assignment) return undefined;
    const cancelled: Assignment = { ...assignment, status: "cancelled", completedAt: now };
    this.items.set(id, cancelled);
    return cancelled;
  }

  async expireStale(now: string): Promise<Assignment[]> {
    const expired: Assignment[] = [];
    for (const assignment of this.items.values()) {
      if (assignment.status === "pending") {
        const next: Assignment = { ...assignment, status: "expired", failedAt: now };
        this.items.set(next.id, next);
        expired.push(next);
      }
    }
    return expired;
  }
}
