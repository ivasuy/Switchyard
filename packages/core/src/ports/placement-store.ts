import type { PlacementDecision } from "@switchyard/contracts";
import type { GenericStore } from "./generic-stores.js";

export interface PlacementDecisionRecord extends PlacementDecision {
  id: string;
  runId?: string;
  createdAt: string;
}

export interface PlacementStore extends GenericStore<PlacementDecisionRecord> {
  listByRun(runId: string): Promise<PlacementDecisionRecord[]>;
}
