import type { PlacementDecision } from "@switchyard/contracts";

export interface PolicyPort {
  decidePlacement(input: Record<string, unknown>): Promise<PlacementDecision>;
  requireApproval(input: Record<string, unknown>): Promise<boolean>;
}
