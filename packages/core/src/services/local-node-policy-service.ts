import type { NodePolicy, Run, ToolInvocation } from "@switchyard/contracts";
import { redactSecrets } from "./local-policy-gate.js";

export interface LocalNodePolicyDecision {
  decision: "allow" | "deny";
  reasonCode: string;
  policyTrace: Array<Record<string, unknown>>;
}

export interface LocalNodePolicySyncIntent {
  eventType?: string;
  syncContent?: boolean;
  artifactBytes?: number;
}

export interface LocalNodeToolPolicySyncIntent {
  syncContent?: boolean;
  artifactBytes?: number;
}

export class LocalNodePolicyService {
  decide(run: Run, policy: NodePolicy | undefined, syncIntent?: LocalNodePolicySyncIntent): LocalNodePolicyDecision {
    if (!policy || policy.allowRuntimeModes.length === 0) {
      return deny("node_policy_denied", [{ rule: "allow_runtime_modes_empty" }]);
    }

    if (!run.runtimeMode || !policy.allowRuntimeModes.includes(run.runtimeMode)) {
      return deny("node_policy_denied", [{ rule: "runtime_mode_denied", runtimeMode: run.runtimeMode ?? "unknown" }]);
    }

    if (policy.denyAdapterTypes.includes(run.adapterType)) {
      return deny("node_policy_denied", [{ rule: "adapter_type_denied", adapterType: run.adapterType }]);
    }

    if (policy.allowCwdPrefixes.length === 0 || !policy.allowCwdPrefixes.some((prefix) => run.cwd.startsWith(prefix))) {
      return deny("node_policy_denied", [{ rule: "cwd_denied", cwd: run.cwd }]);
    }

    if (syncIntent?.eventType && policy.allowEventTypes.length > 0 && !policy.allowEventTypes.includes(syncIntent.eventType)) {
      return deny("node_policy_denied", [{ rule: "event_type_denied", eventType: syncIntent.eventType }]);
    }

    if (policy.artifactSync === "metadata_only" && syncIntent?.syncContent) {
      return deny("node_policy_denied", [{ rule: "artifact_content_denied" }]);
    }

    if (policy.artifactSync === "none" && (syncIntent?.syncContent || syncIntent?.artifactBytes !== undefined)) {
      return deny("node_policy_denied", [{ rule: "artifact_sync_disabled" }]);
    }

    if (
      policy.maxArtifactBytes !== undefined &&
      syncIntent?.artifactBytes !== undefined &&
      syncIntent.artifactBytes > policy.maxArtifactBytes
    ) {
      return deny("node_policy_denied", [{ rule: "artifact_too_large", artifactBytes: syncIntent.artifactBytes }]);
    }

    return {
      decision: "allow",
      reasonCode: "allow",
      policyTrace: [redactSecrets({ rule: "allow", runtimeMode: run.runtimeMode, cwd: run.cwd })]
    };
  }

  decideTool(
    run: Run,
    toolInvocation: ToolInvocation,
    policy: NodePolicy | undefined,
    syncIntent?: LocalNodeToolPolicySyncIntent
  ): LocalNodePolicyDecision {
    if (!policy || policy.allowRuntimeModes.length === 0) {
      return deny("node_policy_denied", [{ rule: "allow_runtime_modes_empty" }]);
    }
    if (!run.runtimeMode || !policy.allowRuntimeModes.includes(run.runtimeMode)) {
      return deny("node_policy_denied", [{ rule: "runtime_mode_denied", runtimeMode: run.runtimeMode ?? "unknown" }]);
    }
    if (toolInvocation.type === "browser") {
      return deny("browser_tool_unshipped", [{ rule: "browser_tool_unshipped" }]);
    }
    if (policy.allowToolTypes.length > 0 && !policy.allowToolTypes.includes(toolInvocation.type)) {
      return deny("node_policy_denied", [{ rule: "tool_type_denied", toolType: toolInvocation.type }]);
    }

    const request = asRecord(toolInvocation.input?.["request"]);
    const cwd = typeof request?.["cwd"] === "string" ? request["cwd"] : undefined;
    if (toolInvocation.type === "repo" || toolInvocation.type === "shell") {
      const allowToolCwdPrefixes = policy.allowToolCwdPrefixes.length > 0
        ? policy.allowToolCwdPrefixes
        : policy.allowCwdPrefixes;
      if (!cwd || allowToolCwdPrefixes.length === 0 || !allowToolCwdPrefixes.some((prefix) => cwd.startsWith(prefix))) {
        return deny("node_policy_denied", [{ rule: "tool_cwd_denied", cwd: cwd ?? "missing", toolType: toolInvocation.type }]);
      }
    }

    if (toolInvocation.type === "shell" && request) {
      for (const forbidden of ["command", "shell", "executablePath", "env", "pty", "terminal", "process"]) {
        if (forbidden in request) {
          return deny("shell_command_denied", [{ rule: "shell_raw_field_denied", field: forbidden }]);
        }
      }
    }

    if (policy.toolArtifactSync === "metadata_only" && syncIntent?.syncContent) {
      return deny("node_policy_denied", [{ rule: "tool_artifact_content_denied" }]);
    }
    if (policy.toolArtifactSync === "none" && (syncIntent?.syncContent || syncIntent?.artifactBytes !== undefined)) {
      return deny("node_policy_denied", [{ rule: "tool_artifact_sync_disabled" }]);
    }
    if (
      policy.maxToolArtifactBytes !== undefined &&
      syncIntent?.artifactBytes !== undefined &&
      syncIntent.artifactBytes > policy.maxToolArtifactBytes
    ) {
      return deny("node_policy_denied", [{ rule: "tool_artifact_too_large", artifactBytes: syncIntent.artifactBytes }]);
    }

    return {
      decision: "allow",
      reasonCode: "allow",
      policyTrace: [redactSecrets({ rule: "tool_allow", toolType: toolInvocation.type, cwd: cwd ?? run.cwd })]
    };
  }
}

function deny(reasonCode: string, trace: Array<Record<string, unknown>>): LocalNodePolicyDecision {
  return {
    decision: "deny",
    reasonCode,
    policyTrace: trace.map((entry) => redactSecrets(entry))
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
