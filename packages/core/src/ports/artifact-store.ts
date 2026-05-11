import type { Artifact } from "@switchyard/contracts";
import type { GenericStore } from "./generic-stores.js";

export interface ArtifactStore extends GenericStore<Artifact> {
  listByRun(runId: string): Promise<Artifact[]>;
}
