import type { Assignment } from "@switchyard/contracts";

export interface AssignmentClaimInput {
  assignmentId: string;
  nodeId: string;
  now: string;
}

export interface NodeAssignmentStore {
  create(record: Assignment): Promise<Assignment>;
  get(id: string): Promise<Assignment | undefined>;
  update(record: Assignment): Promise<Assignment>;
  listClaimable(nodeId: string, now: string): Promise<Assignment[]>;
  claim(input: AssignmentClaimInput): Promise<Assignment | undefined>;
  complete(id: string, now: string): Promise<Assignment | undefined>;
  fail(id: string, now: string, error: string): Promise<Assignment | undefined>;
  cancel(id: string, now: string): Promise<Assignment | undefined>;
  expireStale(now: string): Promise<Assignment[]>;
}
