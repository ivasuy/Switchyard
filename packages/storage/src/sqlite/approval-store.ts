import type { Approval } from "@switchyard/contracts";
import type { ApprovalStore } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { approvals } from "./schema.js";
import { eq } from "drizzle-orm";

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
}
