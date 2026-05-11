import type { RuntimeSession } from "@switchyard/contracts";
import type { GenericStore } from "./generic-stores.js";

export interface SessionStore extends GenericStore<RuntimeSession> {
  getByRunId(runId: string): Promise<RuntimeSession | undefined>;
}
