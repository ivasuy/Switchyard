import type { Run } from "@switchyard/contracts";
import type { ListRunsFilter, ListRunsResult, RunStore } from "@switchyard/core";

export class PostgresRunStore implements RunStore {
  private readonly items = new Map<string, Run>();

  async create(run: Run): Promise<Run> {
    this.items.set(run.id, run);
    return run;
  }

  async get(id: string): Promise<Run | undefined> {
    return this.items.get(id);
  }

  async update(run: Run): Promise<Run> {
    this.items.set(run.id, run);
    return run;
  }

  async list(filter: ListRunsFilter): Promise<ListRunsResult> {
    const matchesCsv = (allowed: readonly string[] | undefined, value: string): boolean => !allowed || allowed.length === 0 || allowed.includes(value);
    const sorted = [...this.items.values()].sort((left, right) => (left.createdAt === right.createdAt ? right.id.localeCompare(left.id) : left.createdAt > right.createdAt ? -1 : 1));
    const filtered = sorted.filter((run) => {
      if (!matchesCsv(filter.status, run.status)) return false;
      if (!matchesCsv(filter.runtime, run.runtime)) return false;
      if (!matchesCsv(filter.provider, run.provider)) return false;
      if (!matchesCsv(filter.model, run.model)) return false;
      if (!matchesCsv(filter.placement, run.placement)) return false;
      if (!matchesCsv(filter.adapterType, run.adapterType)) return false;
      if (filter.since !== undefined && run.createdAt < filter.since) return false;
      if (filter.until !== undefined && run.createdAt >= filter.until) return false;
      if (filter.before) {
        if (run.createdAt > filter.before.createdAt) return false;
        if (run.createdAt === filter.before.createdAt && run.id >= filter.before.id) return false;
      }
      return true;
    });

    const page = filtered.slice(0, filter.limit);
    const hasMore = filtered.length > filter.limit;
    const last = page.at(-1);
    return { runs: page, nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null };
  }
}
