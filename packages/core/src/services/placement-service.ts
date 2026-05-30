import type { ConnectedNode, PlacementDecision, RuntimePlacementFacts } from "@switchyard/contracts";
import { isRealHostedRuntimeMode } from "./hosted-runtime-catalog.js";

export interface PlacementDecisionInput {
  requestedPlacement?: "local" | "hosted" | "connected_local_node";
  runtimeMode: string;
  placementFacts: RuntimePlacementFacts;
  hostedRuntimeAllowlist: string[];
  onlineNodes: ConnectedNode[];
  now: string;
}

export class PlacementService {
  decide(input: PlacementDecisionInput): PlacementDecision {
    const allowHosted =
      (input.placementFacts.hosted.support === "supported" || input.placementFacts.hosted.support === "conditional") &&
      input.hostedRuntimeAllowlist.includes(input.runtimeMode);
    const eligibleNodes = input.onlineNodes
      .filter((node) => node.status === "online")
      .filter((node) => node.capabilities.includes(`runtime.${input.runtimeMode}`) || node.capabilities.includes(input.runtimeMode))
      .sort((a, b) => a.id.localeCompare(b.id));

    if (input.requestedPlacement === "local") {
      return {
        decision: "local",
        reason: "explicit_local",
        mode: "local",
        requiredCapabilities: [],
        deniedCapabilities: [],
        approvalRequired: false,
        policyTrace: ["explicit_local"]
      };
    }

    if (input.requestedPlacement === "hosted") {
      if (!allowHosted) {
        return reject("hosted_runtime_not_allowed");
      }
      return {
        decision: "hosted",
        reason: "explicit_hosted",
        mode: "hosted",
        requiredCapabilities: [`runtime.${input.runtimeMode}`],
        deniedCapabilities: ["sandbox.workspace_write", "sandbox.danger_full_access", "auth.local"],
        approvalRequired: false,
        policyTrace: ["explicit_hosted", "hosted_allowlist_match"]
      };
    }

    if (input.requestedPlacement === "connected_local_node") {
      const node = eligibleNodes[0];
      if (!node) {
        return reject("no_eligible_node");
      }
      return {
        decision: "connected_local_node",
        reason: "explicit_connected_local_node",
        mode: "hybrid",
        targetNode: node.id,
        requiredCapabilities: [`runtime.${input.runtimeMode}`],
        deniedCapabilities: [],
        approvalRequired: false,
        policyTrace: ["explicit_connected_local_node", `selected_node:${node.id}`]
      };
    }

    if (allowHosted && isRealHostedRuntimeMode(input.runtimeMode)) {
      return reject("hosted_explicit_placement_required");
    }

    if (allowHosted) {
      return {
        decision: "hosted",
        reason: "default_hosted",
        mode: "hosted",
        requiredCapabilities: [`runtime.${input.runtimeMode}`],
        deniedCapabilities: ["sandbox.workspace_write", "sandbox.danger_full_access", "auth.local"],
        approvalRequired: false,
        policyTrace: ["default_hosted", "hosted_allowlist_match"]
      };
    }

    const node = eligibleNodes[0];
    if (node) {
      return {
        decision: "connected_local_node",
        reason: "default_connected_local_node",
        mode: "hybrid",
        targetNode: node.id,
        requiredCapabilities: [`runtime.${input.runtimeMode}`],
        deniedCapabilities: [],
        approvalRequired: false,
        policyTrace: ["default_connected_local_node", `selected_node:${node.id}`]
      };
    }

    return reject("hosted_runtime_not_allowed");
  }
}

function reject(reason: string): PlacementDecision {
  return {
    decision: "reject",
    reason,
    mode: "hosted",
    requiredCapabilities: [],
    deniedCapabilities: [],
    approvalRequired: false,
    policyTrace: [reason]
  };
}
