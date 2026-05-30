import type { ConnectedNode, Assignment, NodePolicy, Run } from "@switchyard/contracts";
import type { NodeStore } from "../ports/node-store.js";
import type { NodeAssignmentStore } from "../ports/node-assignment-store.js";
import type { RunStore } from "../ports/run-store.js";

export class NodeCoordinatorError extends Error {
  readonly code:
    | "node_not_found"
    | "assignment_not_found"
    | "assignment_claim_conflict";

  constructor(code: NodeCoordinatorError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ClaimedNodeAssignment {
  assignment: Assignment;
  run: Run;
}

export interface NodeCoordinatorDependencies {
  nodes: NodeStore;
  assignments: NodeAssignmentStore;
  runs: RunStore;
  now?: () => string;
}

export class NodeCoordinatorService {
  private readonly now: () => string;

  constructor(private readonly deps: NodeCoordinatorDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async register(input: {
    id?: string;
    mode: ConnectedNode["mode"];
    capabilities: string[];
    policy?: NodePolicy;
    version?: string;
  }): Promise<ConnectedNode> {
    const now = this.now();
    const id = input.id ?? `node_${crypto.randomUUID()}`;
    const existing = await this.deps.nodes.get(id);
    const node: ConnectedNode = {
      id,
      mode: input.mode,
      status: "online",
      capabilities: input.capabilities,
      policy: input.policy,
      version: input.version,
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
      heartbeatExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
      updatedAt: now
    };
    return this.deps.nodes.upsert(node);
  }

  async heartbeat(nodeId: string, input: { capabilities?: string[]; policy?: NodePolicy }): Promise<ConnectedNode> {
    const node = await this.deps.nodes.get(nodeId);
    if (!node) {
      throw new NodeCoordinatorError("node_not_found", `Node not found: ${nodeId}`);
    }
    const now = this.now();
    const updated: ConnectedNode = {
      ...node,
      status: "online",
      capabilities: input.capabilities ?? node.capabilities,
      policy: input.policy ?? node.policy,
      lastSeenAt: now,
      heartbeatExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
      updatedAt: now
    };
    return this.deps.nodes.upsert(updated);
  }

  async list(): Promise<ConnectedNode[]> {
    return this.deps.nodes.list();
  }

  async get(id: string): Promise<ConnectedNode | undefined> {
    return this.deps.nodes.get(id);
  }

  async createAssignment(run: Run, nodeId: string): Promise<Assignment> {
    const assignment: Assignment = {
      id: `assignment_${crypto.randomUUID()}`,
      runId: run.id,
      nodeId,
      status: "pending",
      retryCount: 0,
      lastEventSequence: 0,
      createdAt: this.now()
    };
    return this.deps.assignments.create(assignment);
  }

  async claim(nodeId: string, assignmentId?: string): Promise<ClaimedNodeAssignment | undefined> {
    const now = this.now();
    if (assignmentId) {
      const claimed = await this.deps.assignments.claim({ assignmentId, nodeId, now });
      if (!claimed) {
        throw new NodeCoordinatorError("assignment_claim_conflict", `Assignment already claimed: ${assignmentId}`);
      }
      return this.hydrateClaimed(claimed);
    }

    const claimable = await this.deps.assignments.listClaimable(nodeId, now);
    const first = claimable[0];
    if (!first) {
      return undefined;
    }
    const claimed = await this.deps.assignments.claim({ assignmentId: first.id, nodeId, now });
    if (!claimed) {
      throw new NodeCoordinatorError("assignment_claim_conflict", `Assignment already claimed: ${first.id}`);
    }
    return this.hydrateClaimed(claimed);
  }

  async reject(nodeId: string, assignmentId: string, reason: string): Promise<Assignment> {
    const assignment = await this.deps.assignments.get(assignmentId);
    if (!assignment || assignment.nodeId !== nodeId) {
      throw new NodeCoordinatorError("assignment_not_found", `Assignment not found: ${assignmentId}`);
    }
    const failed = await this.deps.assignments.fail(assignmentId, this.now(), reason);
    if (!failed) {
      throw new NodeCoordinatorError("assignment_not_found", `Assignment not found: ${assignmentId}`);
    }
    return failed;
  }

  async complete(nodeId: string, assignmentId: string, status: "completed" | "failed" | "cancelled", error?: string): Promise<Assignment> {
    const assignment = await this.deps.assignments.get(assignmentId);
    if (!assignment || assignment.nodeId !== nodeId) {
      throw new NodeCoordinatorError("assignment_not_found", `Assignment not found: ${assignmentId}`);
    }
    const now = this.now();
    if (status === "completed") {
      const completed = await this.deps.assignments.complete(assignmentId, now);
      if (!completed) {
        throw new NodeCoordinatorError("assignment_not_found", `Assignment not found: ${assignmentId}`);
      }
      return completed;
    }
    if (status === "cancelled") {
      const cancelled = await this.deps.assignments.cancel(assignmentId, now);
      if (!cancelled) {
        throw new NodeCoordinatorError("assignment_not_found", `Assignment not found: ${assignmentId}`);
      }
      return cancelled;
    }
    const failed = await this.deps.assignments.fail(assignmentId, now, error ?? "node_failed");
    if (!failed) {
      throw new NodeCoordinatorError("assignment_not_found", `Assignment not found: ${assignmentId}`);
    }
    return failed;
  }

  async expireStale(): Promise<void> {
    const now = this.now();
    const nodes = await this.deps.nodes.list({ status: "online" });
    for (const node of nodes) {
      if (node.heartbeatExpiresAt && node.heartbeatExpiresAt < now) {
        await this.deps.nodes.markOffline(node.id, now);
      }
    }
    await this.deps.assignments.expireStale(now);
  }

  private async hydrateClaimed(assignment: Assignment): Promise<ClaimedNodeAssignment> {
    const run = await this.deps.runs.get(assignment.runId);
    if (!run) {
      throw new NodeCoordinatorError("assignment_not_found", `Run not found for assignment: ${assignment.id}`);
    }
    return { assignment, run };
  }
}
