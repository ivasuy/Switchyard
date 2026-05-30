import type { Approval } from "@switchyard/contracts";
import type { ApprovalStore, ListApprovalsFilter, ListApprovalsResult } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { approvals } from "./schema.js";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";

type ApprovalRow = typeof approvals.$inferSelect;
type ApprovalInsertRow = Omit<typeof approvals.$inferInsert, "runId" | "resolvedAt"> & {
  runId: string | null;
  resolvedAt: string | null;
};
type ApprovalUpdateRow = Omit<typeof approvals.$inferInsert, "runId" | "resolvedAt"> & {
  runId: string | null;
  resolvedAt: string | null;
};

function toRow(approval: Approval): ApprovalInsertRow {
  return {
    id: approval.id,
    runId: approval.runId ?? null,
    approvalType: approval.approvalType,
    status: approval.status,
    payloadJson: JSON.stringify(approval.payload),
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt ?? null
  };
}

function toUpdateRow(approval: Approval): ApprovalUpdateRow {
  return {
    id: approval.id,
    runId: approval.runId ?? null,
    approvalType: approval.approvalType,
    status: approval.status,
    payloadJson: JSON.stringify(approval.payload),
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt ?? null
  };
}

function fromRow(row: ApprovalRow): Approval {
  const approval: Approval = {
    id: row.id,
    approvalType: row.approvalType as Approval["approvalType"],
    status: row.status as Approval["status"],
    payload: JSON.parse(row.payloadJson),
    createdAt: row.createdAt
  };

  if (row.runId !== null) {
    approval.runId = row.runId;
  }
  if (row.resolvedAt !== null) {
    approval.resolvedAt = row.resolvedAt;
  }

  return approval;
}

export class SqliteApprovalStore implements ApprovalStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(approval: Approval): Promise<Approval> {
    await this.db.insert(approvals).values(toRow(approval));
    return approval;
  }

  async get(id: string): Promise<Approval | undefined> {
    const rows = await this.db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return fromRow(row);
  }

  async update(approval: Approval): Promise<Approval> {
    await this.db.update(approvals).set(toUpdateRow(approval)).where(eq(approvals.id, approval.id));
    return approval;
  }

  async list(filter: ListApprovalsFilter): Promise<ListApprovalsResult> {
    const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof or>> = [];
    if (filter.runId) {
      conditions.push(eq(approvals.runId, filter.runId));
    }
    if (filter.status) {
      conditions.push(eq(approvals.status, filter.status));
    }
    if (filter.approvalType) {
      conditions.push(eq(approvals.approvalType, filter.approvalType));
    }
    if (filter.before) {
      const cursorCondition = or(
        lt(approvals.createdAt, filter.before.createdAt),
        and(eq(approvals.createdAt, filter.before.createdAt), lt(approvals.id, filter.before.id))
      );
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const overFetch = filter.limit + 1;
    const baseQuery = this.db
      .select()
      .from(approvals)
      .orderBy(desc(approvals.createdAt), desc(sql`${approvals.id}`))
      .limit(overFetch);
    const query = whereClause ? baseQuery.where(whereClause) : baseQuery;
    const rows = await query;
    const page = rows.slice(0, filter.limit).map(fromRow);
    const hasMore = rows.length > filter.limit;
    const last = page.at(-1);
    return {
      approvals: page,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
    };
  }
}
