import { createHash } from "node:crypto";
import type { Artifact, AssignmentArtifactManifestRequest, Run, SwitchyardEvent } from "@switchyard/contracts";
import { LocalNodePolicyService } from "@switchyard/core";
import { NodeClient } from "@switchyard/protocol-node";
import type { NodeAppConfig } from "./config.js";

export interface NodeApp {
  start: () => Promise<void>;
  tick: () => Promise<boolean>;
  stop: () => Promise<void>;
}

export interface NodeExecutionArtifact {
  id: string;
  type: Artifact["type"];
  path: string;
  contentType: string;
  syncContent: boolean;
  bytes?: Buffer;
}

export interface NodeExecutionResult {
  events: SwitchyardEvent[];
  artifacts: NodeExecutionArtifact[];
}

export function createNodeApp(config: NodeAppConfig, deps?: {
  client?: NodeClient;
  executeAssignment?: (assignment: { id: string; run: Run }) => Promise<NodeExecutionResult>;
}): NodeApp {
  const clientOptions: ConstructorParameters<typeof NodeClient>[0] = {
    baseUrl: config.serverUrl
  };
  if (config.sharedToken !== undefined) {
    clientOptions.sharedToken = config.sharedToken;
  }
  const client = deps?.client ?? new NodeClient(clientOptions);
  const policy = new LocalNodePolicyService();
  let nodeId = config.nodeId;

  return {
    start: async () => {
      const registered = await client.register({
        id: nodeId,
        mode: "hybrid",
        capabilities: config.capabilities,
        policy: config.policy
      });
      nodeId = registered.node.id;
    },
    tick: async () => {
      if (!nodeId) {
        await client.register({ id: config.nodeId, mode: "hybrid", capabilities: config.capabilities, policy: config.policy });
        return true;
      }

      await client.heartbeat(nodeId, { capabilities: config.capabilities, policy: config.policy });
      const claimed = await client.claim(nodeId);
      const assignment = claimed.assignment;
      const run = claimed.run;
      if (!assignment) {
        return false;
      }
      if (!run) {
        await client.reject(nodeId, assignment.id, { reason: "assignment_missing_run" });
        return true;
      }

      const decision = policy.decide(run, config.policy);
      if (decision.decision === "deny") {
        await client.reject(nodeId, assignment.id, { reason: "node_policy_denied" });
        return true;
      }

      try {
        const execution = deps?.executeAssignment
          ? await deps.executeAssignment({ id: assignment.id, run })
          : createDefaultExecution(run, assignment.lastEventSequence);

        await client.syncEvents(nodeId, assignment.id, {
          cursor: assignment.lastEventSequence,
          events: execution.events
        });
        await client.syncArtifactManifest(nodeId, assignment.id, {
          artifacts: toManifest(execution.artifacts)
        });
        for (const artifact of execution.artifacts) {
          if (!artifact.syncContent || !artifact.bytes) continue;
          await client.syncArtifactContent(nodeId, assignment.id, artifact.id, artifact.bytes);
        }
        await client.complete(nodeId, assignment.id, { status: "completed" });
      } catch (error) {
        await client.complete(nodeId, assignment.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return true;
    },
    stop: async () => {}
  };
}

function createDefaultExecution(run: Run, baseSequence: number): NodeExecutionResult {
  const outputText = `[node-exec] completed ${run.runtimeMode ?? run.runtime}`;
  const outputEvent: SwitchyardEvent = {
    id: `event_${crypto.randomUUID()}`,
    type: "runtime.output",
    runId: run.id,
    sequence: baseSequence + 1,
    payload: { text: outputText },
    createdAt: new Date().toISOString()
  };
  const bytes = Buffer.from(JSON.stringify(outputEvent) + "\n", "utf8");
  const artifact: NodeExecutionArtifact = {
    id: `artifact_${crypto.randomUUID()}`,
    type: "transcript",
    path: `runs/${run.id}/node-transcript.jsonl`,
    contentType: "application/x-ndjson",
    syncContent: true,
    bytes
  };
  return {
    events: [outputEvent],
    artifacts: [artifact]
  };
}

function toManifest(artifacts: NodeExecutionArtifact[]): AssignmentArtifactManifestRequest["artifacts"] {
  return artifacts.map((artifact) => {
    const bytes = artifact.bytes ?? Buffer.alloc(0);
    return {
      id: artifact.id,
      type: artifact.type,
      path: artifact.path,
      contentType: artifact.contentType,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      syncContent: artifact.syncContent
    };
  });
}
