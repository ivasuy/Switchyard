import type { Run } from "@switchyard/contracts";

export interface RunCursor {
  createdAt: string;
  id: string;
}

export interface ListRunsFilter {
  status?: readonly string[];
  runtime?: readonly string[];
  provider?: readonly string[];
  model?: readonly string[];
  placement?: readonly string[];
  adapterType?: readonly string[];
  since?: string;
  until?: string;
  limit: number;
  before?: RunCursor;
}

export interface ListRunsResult {
  runs: Run[];
  nextCursor: RunCursor | null;
}

export interface RunStore {
  create(run: Run): Promise<Run>;
  get(id: string): Promise<Run | undefined>;
  update(run: Run): Promise<Run>;
  list(filter: ListRunsFilter): Promise<ListRunsResult>;
}
