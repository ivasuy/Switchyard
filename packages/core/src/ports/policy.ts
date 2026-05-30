import type { PlacementDecision, ToolInvocation } from "@switchyard/contracts";

export interface ToolPolicyDecision {
  decision: "allow" | "approval_required" | "deny";
  reasonCode: string;
  policyTrace: Array<Record<string, unknown>>;
}

export interface ToolPolicyInput {
  runApprovalPolicy?: string | undefined;
  type: ToolInvocation["type"];
  input: Record<string, unknown>;
}

export interface ToolPolicyPort {
  decideTool(input: ToolPolicyInput): Promise<ToolPolicyDecision>;
}

export interface PolicyPort {
  decidePlacement(input: Record<string, unknown>): Promise<PlacementDecision>;
  requireApproval(input: Record<string, unknown>): Promise<boolean>;
}
