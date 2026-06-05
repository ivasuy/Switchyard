import type { MemoryItem } from "@switchyard/contracts";
import type { GenericStore, ListCursor } from "./generic-stores.js";

export interface ListMemoryFilter {
  scope?: MemoryItem["scope"] | undefined;
  projectId?: string | undefined;
  runId?: string | undefined;
  debateId?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  limit: number;
  before?: ListCursor | undefined;
}

export interface SearchMemoryFilter extends ListMemoryFilter {
  q: string;
}

export interface ListMemoryResult {
  memory: MemoryItem[];
  nextCursor: ListCursor | null;
}

export interface MemoryStore extends GenericStore<MemoryItem> {
  list(filter: ListMemoryFilter): Promise<ListMemoryResult>;
  search(filter: SearchMemoryFilter): Promise<ListMemoryResult>;
}
