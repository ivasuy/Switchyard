import type { ToolInvocation } from "@switchyard/contracts";
import type { GenericStore, ListCursor } from "./generic-stores.js";

export interface ListToolInvocationsFilter {
  runId?: string | undefined;
  type?: ToolInvocation["type"] | undefined;
  status?: ToolInvocation["status"] | undefined;
  approvalId?: string | undefined;
  limit: number;
  before?: ListCursor | undefined;
}

export interface ListToolInvocationsResult {
  invocations: ToolInvocation[];
  nextCursor: ListCursor | null;
}

export interface ToolInvocationStore extends GenericStore<ToolInvocation> {
  list(filter: ListToolInvocationsFilter): Promise<ListToolInvocationsResult>;
  listByApproval(approvalId: string): Promise<ToolInvocation[]>;
}
