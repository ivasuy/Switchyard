import type { Run } from "@switchyard/contracts";
import type {
  GuardedPreparedMetadataUpdateInput,
  GuardedPreparedMetadataUpdateResult,
  ListRunsFilter,
  ListRunsResult,
  RunStore
} from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

export class PostgresRunStore implements RunStore {
  private readonly items = new Map<string, Run>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(run: Run): Promise<Run> {
    if (this.handle) {
      await this.upsert(run);
      return run;
    }
    this.items.set(run.id, run);
    return run;
  }

  async get(id: string): Promise<Run | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM runs WHERE id = $1", [id]);
      return result.rows[0] ? rowToRun(result.rows[0]) : undefined;
    }
    return this.items.get(id);
  }

  async update(run: Run): Promise<Run> {
    if (this.handle) {
      await this.upsert(run);
      return run;
    }
    this.items.set(run.id, run);
    return run;
  }

  async updatePreparedMetadataIfMatch(
    input: GuardedPreparedMetadataUpdateInput
  ): Promise<GuardedPreparedMetadataUpdateResult> {
    if (this.handle) {
      const metadata = input.metadata ?? {};
      const values: unknown[] = [
        metadata,
        input.expected.id,
        input.expected.status,
        input.expected.placement,
        input.expected.runtime,
        input.expected.provider,
        input.expected.adapterType
      ];
      const runtimeModeClause =
        input.expected.runtimeMode === undefined
          ? "runtime_mode IS NULL"
          : `(runtime_mode = $8)`;
      if (input.expected.runtimeMode !== undefined) {
        values.push(input.expected.runtimeMode);
      }

      const result = await this.handle.pool.query(
        `UPDATE runs
         SET metadata = $1
         WHERE id = $2
           AND status = $3
           AND placement = $4
           AND runtime = $5
           AND provider = $6
           AND adapter_type = $7
           AND ${runtimeModeClause}
         RETURNING *`,
        values
      );
      if (result.rows[0]) {
        return { ok: true, run: rowToRun(result.rows[0]) };
      }
      const current = await this.get(input.expected.id);
      return current ? { ok: false, reason: "identity_mismatch" } : { ok: false, reason: "not_found" };
    }

    const current = this.items.get(input.expected.id);
    if (!current) {
      return { ok: false, reason: "not_found" };
    }
    const sameIdentity =
      current.status === input.expected.status &&
      current.placement === input.expected.placement &&
      current.runtime === input.expected.runtime &&
      current.runtimeMode === input.expected.runtimeMode &&
      current.provider === input.expected.provider &&
      current.adapterType === input.expected.adapterType;
    if (!sameIdentity) {
      return { ok: false, reason: "identity_mismatch" };
    }

    const next: Run = {
      ...current,
      metadata: input.metadata ?? {}
    };
    this.items.set(next.id, next);
    return { ok: true, run: next };
  }

  async list(filter: ListRunsFilter): Promise<ListRunsResult> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM runs ORDER BY created_at DESC, id DESC");
      return paginateRuns(result.rows.map(rowToRun), filter);
    }
    return paginateRuns([...this.items.values()], filter);
  }

  private async upsert(run: Run): Promise<void> {
    await this.handle?.pool.query(
      `INSERT INTO runs (
        id, runtime, provider, model, adapter_type, cwd, task, status, placement,
        approval_policy, timeout_seconds, metadata, runtime_mode, created_at, started_at, ended_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (id) DO UPDATE SET
        runtime = EXCLUDED.runtime,
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        adapter_type = EXCLUDED.adapter_type,
        cwd = EXCLUDED.cwd,
        task = EXCLUDED.task,
        status = EXCLUDED.status,
        placement = EXCLUDED.placement,
        approval_policy = EXCLUDED.approval_policy,
        timeout_seconds = EXCLUDED.timeout_seconds,
        metadata = EXCLUDED.metadata,
        runtime_mode = EXCLUDED.runtime_mode,
        created_at = EXCLUDED.created_at,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at`,
      [
        run.id,
        run.runtime,
        run.provider,
        run.model,
        run.adapterType,
        run.cwd,
        run.task,
        run.status,
        run.placement,
        run.approvalPolicy,
        run.timeoutSeconds,
        run.metadata,
        run.runtimeMode ?? null,
        run.createdAt,
        run.startedAt ?? null,
        run.endedAt ?? null
      ]
    );
  }
}

function paginateRuns(runs: Run[], filter: ListRunsFilter): ListRunsResult {
    const matchesCsv = (allowed: readonly string[] | undefined, value: string): boolean => !allowed || allowed.length === 0 || allowed.includes(value);
    const sorted = runs.sort((left, right) => (left.createdAt === right.createdAt ? right.id.localeCompare(left.id) : left.createdAt > right.createdAt ? -1 : 1));
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

function rowToRun(row: Record<string, unknown>): Run {
  const run: Run = {
    id: row["id"] as string,
    runtime: row["runtime"] as string,
    provider: row["provider"] as string,
    model: row["model"] as string,
    adapterType: row["adapter_type"] as Run["adapterType"],
    cwd: row["cwd"] as string,
    task: row["task"] as string,
    status: row["status"] as Run["status"],
    placement: row["placement"] as Run["placement"],
    approvalPolicy: row["approval_policy"] as string,
    timeoutSeconds: row["timeout_seconds"] as number,
    metadata: row["metadata"] as Record<string, unknown>,
    createdAt: row["created_at"] as string
  };
  if (row["runtime_mode"]) run.runtimeMode = row["runtime_mode"] as string;
  if (row["started_at"]) run.startedAt = row["started_at"] as string;
  if (row["ended_at"]) run.endedAt = row["ended_at"] as string;
  return run;
}
