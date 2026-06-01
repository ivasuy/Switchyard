import { createHash } from "node:crypto";
import type { ConnectedNode, Assignment, NodePolicy, Run } from "@switchyard/contracts";
import type { NodeStore } from "../ports/node-store.js";
import type { NodeAssignmentStore } from "../ports/node-assignment-store.js";
import type { RunStore } from "../ports/run-store.js";

export class NodeCoordinatorError extends Error {
  readonly code:
    | "node_not_found"
    | "assignment_not_found"
    | "assignment_claim_conflict"
    | "tool_node_unavailable"
    | "node_policy_denied"
    | "tool_dispatch_unavailable";

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
      kind: "run",
      status: "pending",
      retryCount: 0,
      lastEventSequence: 0,
      createdAt: this.now()
    };
    return this.deps.assignments.create(assignment);
  }

  async createToolAssignment(input: {
    runId: string;
    toolInvocationId: string;
    nodeId?: string;
    requiredCapability: string;
    idempotencyKey: string;
  }): Promise<Assignment> {
    const assignmentId = deterministicToolAssignmentId(input.toolInvocationId, input.idempotencyKey);
    const existing = await this.deps.assignments.get(assignmentId);
    if (existing) {
      return existing;
    }

    const run = await this.deps.runs.get(input.runId);
    if (!run) {
      throw new NodeCoordinatorError("assignment_not_found", `Run not found: ${input.runId}`);
    }
    if (!this.isToolAssignmentPlacementEligible(run)) {
      throw new NodeCoordinatorError("node_policy_denied", "Run is not eligible for connected-node tool assignment");
    }

    const selected = input.nodeId
      ? await this.resolveNodeById(input.nodeId, input.requiredCapability, input.toolInvocationId)
      : await this.selectEligibleNode(input.requiredCapability, input.toolInvocationId);
    if (!selected) {
      throw new NodeCoordinatorError("tool_node_unavailable", "No eligible node is available for tool assignment");
    }

    const assignment: Assignment = {
      id: assignmentId,
      runId: run.id,
      nodeId: selected.id,
      kind: "tool",
      toolInvocationId: input.toolInvocationId,
      status: "pending",
      retryCount: 0,
      lastEventSequence: 0,
      createdAt: this.now()
    };

    try {
      return await this.deps.assignments.create(assignment);
    } catch (error) {
      const raced = await this.deps.assignments.get(assignmentId);
      if (raced) {
        return raced;
      }
      throw new NodeCoordinatorError(
        "tool_dispatch_unavailable",
        error instanceof Error ? error.message : "Failed to create tool assignment"
      );
    }
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

  private async resolveNodeById(nodeId: string, requiredCapability: string, toolInvocationId: string): Promise<ConnectedNode | null> {
    const node = await this.deps.nodes.get(nodeId);
    if (!node || node.status !== "online") {
      return null;
    }
    this.assertToolCapabilityAllowed(node, requiredCapability, toolInvocationId);
    return node;
  }

  private async selectEligibleNode(requiredCapability: string, toolInvocationId: string): Promise<ConnectedNode | null> {
    const nodes = await this.deps.nodes.list({ status: "online" });
    for (const node of nodes) {
      try {
        this.assertToolCapabilityAllowed(node, requiredCapability, toolInvocationId);
        return node;
      } catch {
        continue;
      }
    }
    return null;
  }

  private assertToolCapabilityAllowed(node: ConnectedNode, requiredCapability: string, toolInvocationId: string): void {
    if (!node.capabilities.includes(requiredCapability)) {
      throw new NodeCoordinatorError(
        "node_policy_denied",
        `Node ${node.id} is missing required capability ${requiredCapability}`
      );
    }
    const toolType = requiredCapability.startsWith("tool.")
      ? requiredCapability.slice("tool.".length)
      : requiredCapability;
    if (node.policy && node.policy.allowToolTypes.length > 0 && !node.policy.allowToolTypes.includes(toolType as never)) {
      throw new NodeCoordinatorError(
        "node_policy_denied",
        `Node ${node.id} policy denied ${toolType} for invocation ${toolInvocationId}`
      );
    }
  }

  private isToolAssignmentPlacementEligible(run: Run): boolean {
    if (run.placement === "connected_local_node") {
      return true;
    }
    if (run.placement !== "hosted") {
      return false;
    }
    const metadata = run.metadata ?? {};
    if (metadata["allowToolPlacementOffload"] === true) {
      return true;
    }
    const placements = metadata["toolOffloadPlacements"];
    return Array.isArray(placements) && placements.includes("connected_local_node");
  }
}

function deterministicToolAssignmentId(toolInvocationId: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`tool:${toolInvocationId}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 40);
  return `assignment_${digest}`;
}
