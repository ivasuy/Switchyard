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

export interface PreparedRunIdentityGuard {
  id: string;
  status: Run["status"];
  placement: Run["placement"];
  runtime: Run["runtime"];
  runtimeMode: Run["runtimeMode"];
  provider: Run["provider"];
  adapterType: Run["adapterType"];
}

export interface GuardedPreparedMetadataUpdateInput {
  expected: PreparedRunIdentityGuard;
  metadata: Run["metadata"];
}

export type GuardedPreparedMetadataUpdateResult =
  | { ok: true; run: Run }
  | { ok: false; reason: "not_found" | "identity_mismatch" };

export interface RunStore {
  create(run: Run): Promise<Run>;
  get(id: string): Promise<Run | undefined>;
  update(run: Run): Promise<Run>;
  updatePreparedMetadataIfMatch?(input: GuardedPreparedMetadataUpdateInput): Promise<GuardedPreparedMetadataUpdateResult>;
  list(filter: ListRunsFilter): Promise<ListRunsResult>;
}
