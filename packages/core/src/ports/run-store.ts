import type { Run } from "@switchyard/contracts";

export interface RunStore {
  create(run: Run): Promise<Run>;
  get(id: string): Promise<Run | undefined>;
  update(run: Run): Promise<Run>;
}
