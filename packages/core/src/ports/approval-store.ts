import type { Approval } from "@switchyard/contracts";
import type { GenericStore, ListCursor } from "./generic-stores.js";

export interface ListApprovalsFilter {
  runId?: string | undefined;
  status?: Approval["status"] | undefined;
  approvalType?: Approval["approvalType"] | undefined;
  toolInvocationId?: string | undefined;
  limit: number;
  before?: ListCursor | undefined;
}

export interface ListApprovalsResult {
  approvals: Approval[];
  nextCursor: ListCursor | null;
}

export interface ApprovalStore extends GenericStore<Approval> {
  list(filter: ListApprovalsFilter): Promise<ListApprovalsResult>;
  updateIfStatus(id: string, expectedStatus: Approval["status"], value: Approval): Promise<Approval | null>;
}
