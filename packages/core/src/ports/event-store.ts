import type { SwitchyardEvent } from "@switchyard/contracts";

export interface EventStore {
  append(event: SwitchyardEvent): Promise<SwitchyardEvent>;
  listByRun(runId: string): Promise<SwitchyardEvent[]>;
}
