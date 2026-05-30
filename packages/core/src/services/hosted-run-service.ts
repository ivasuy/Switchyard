import type { PlacementDecisionRecord, PlacementStore } from "../ports/placement-store.js";
import type { RunQueuePort } from "../ports/queue.js";
import type { RunStore } from "../ports/run-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { RuntimePlacementFacts, Run } from "@switchyard/contracts";
import type { RunService } from "./run-service.js";
import type { NodeAssignmentStore } from "../ports/node-assignment-store.js";
import type { ConnectedNode } from "@switchyard/contracts";
import { PlacementService } from "./placement-service.js";

export class HostedRunServiceError extends Error {
  readonly code:
    | "placement_denied"
    | "queue_unavailable"
    | "hosted_runtime_not_allowed";

  constructor(code: HostedRunServiceError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface HostedRunServiceDependencies {
  runService: RunService;
  runs: RunStore;
  events: EventStore;
  placements: PlacementStore;
  queue: RunQueuePort;
  assignments: NodeAssignmentStore;
  placementService: PlacementService;
  hostedRuntimeAllowlist: string[];
  listOnlineNodes: () => Promise<ConnectedNode[]>;
  now?: () => string;
  waitForRun?: (runId: string) => Promise<Run>;
}

export type CreateHostedRunInput = Parameters<RunService["createRun"]>[0] & {
  placementFacts: RuntimePlacementFacts;
};

export class HostedRunService {
  private readonly now: () => string;

  constructor(private readonly deps: HostedRunServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async createRun(input: CreateHostedRunInput, options?: { wait?: boolean }): Promise<{ run: Run; response?: { text: string | null; outputs: Array<{ sequence: number; text: string }> } }> {
    const decision = this.deps.placementService.decide({
      requestedPlacement: input.placement,
      runtimeMode: input.runtimeMode ?? "",
      placementFacts: input.placementFacts,
      hostedRuntimeAllowlist: this.deps.hostedRuntimeAllowlist,
      onlineNodes: await this.deps.listOnlineNodes(),
      now: this.now()
    });

    if (decision.decision === "reject") {
      throw new HostedRunServiceError(
        decision.reason === "hosted_runtime_not_allowed" ? "hosted_runtime_not_allowed" : "placement_denied",
        decision.reason
      );
    }

    const runPlacement: Run["placement"] =
      decision.decision === "connected_local_node"
        ? "connected_local_node"
        : decision.decision === "hosted"
          ? "hosted"
          : "local";
    const run = await this.deps.runService.createRun({
      ...input,
      placement: runPlacement
    });

    await this.deps.placements.create(toPlacementRecord(run.id, decision, this.now()));

    if (decision.decision === "hosted") {
      try {
        const payload: Parameters<RunQueuePort["enqueue"]>[0] = {
          runId: run.id,
          placement: "hosted"
        };
        if (run.runtimeMode !== undefined) {
          payload.runtimeMode = run.runtimeMode;
        }
        await this.deps.queue.enqueue(payload);
      } catch (error) {
        throw new HostedRunServiceError("queue_unavailable", (error as Error).message);
      }

      if (options?.wait && this.deps.waitForRun) {
        const completed = await this.deps.waitForRun(run.id);
        const events = await this.deps.events.listByRun(run.id);
        return { run: completed, response: collectRunResponse(events) };
      }
    }

    if (decision.decision === "connected_local_node") {
      await this.deps.assignments.create({
        id: `assignment_${crypto.randomUUID()}`,
        runId: run.id,
        nodeId: decision.targetNode ?? "node_missing",
        status: "pending",
        retryCount: 0,
        lastEventSequence: 0,
        createdAt: this.now()
      });
    }

    return { run };
  }
}

function toPlacementRecord(runId: string, decision: ReturnType<PlacementService["decide"]>, createdAt: string): PlacementDecisionRecord {
  const record: PlacementDecisionRecord = {
    id: `placement_${crypto.randomUUID()}`,
    runId,
    decision: decision.decision,
    reason: decision.reason,
    mode: decision.mode,
    requiredCapabilities: decision.requiredCapabilities,
    deniedCapabilities: decision.deniedCapabilities,
    approvalRequired: decision.approvalRequired,
    policyTrace: decision.policyTrace,
    createdAt
  };
  if (decision.targetNode) {
    record.targetNode = decision.targetNode;
  }
  return record;
}

function collectRunResponse(events: Array<{ type: string; sequence: number; payload: Record<string, unknown> }>): { text: string | null; outputs: Array<{ sequence: number; text: string }> } {
  const outputs = events.flatMap((event) => {
    if (event.type !== "runtime.output") {
      return [] as Array<{ sequence: number; text: string }>;
    }
    const text = event.payload["text"];
    return typeof text === "string" ? [{ sequence: event.sequence, text }] : [];
  });
  return {
    text: outputs.at(-1)?.text ?? null,
    outputs
  };
}
