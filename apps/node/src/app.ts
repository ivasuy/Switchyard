import type { Run } from "@switchyard/contracts";
import { LocalNodePolicyService } from "@switchyard/core";
import { NodeClient } from "@switchyard/protocol-node";
import type { NodeAppConfig } from "./config.js";

export interface NodeApp {
  start: () => Promise<void>;
  tick: () => Promise<boolean>;
  stop: () => Promise<void>;
}

export function createNodeApp(config: NodeAppConfig, deps?: {
  client?: NodeClient;
  executeAssignment?: (assignment: { id: string; run: Run }) => Promise<void>;
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
      if (!assignment) {
        return false;
      }

      const run: Run = {
        id: assignment.runId,
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        cwd: "/repo",
        task: "node assignment",
        status: "running",
        placement: "connected_local_node",
        approvalPolicy: "default",
        timeoutSeconds: 60,
        metadata: {},
        runtimeMode: "fake.deterministic",
        createdAt: new Date().toISOString()
      };

      const decision = policy.decide(run, config.policy);
      if (decision.decision === "deny") {
        await client.reject(nodeId, assignment.id, { reason: "node_policy_denied" });
        return true;
      }

      if (deps?.executeAssignment) {
        await deps.executeAssignment({ id: assignment.id, run });
      }

      await client.syncEvents(nodeId, assignment.id, { events: [] });
      await client.syncArtifactManifest(nodeId, assignment.id, { artifacts: [] });
      await client.complete(nodeId, assignment.id, { status: "completed" });
      return true;
    },
    stop: async () => {}
  };
}
