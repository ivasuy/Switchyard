import type { EvidenceItem } from "@switchyard/contracts";
import type { GenericStore, ListCursor } from "./generic-stores.js";

export interface ListEvidenceFilter {
  debateId?: string | undefined;
  sourceType?: EvidenceItem["sourceType"] | undefined;
  reliability?: EvidenceItem["reliability"] | undefined;
  q?: string | undefined;
  limit: number;
  before?: ListCursor | undefined;
}

export interface ListEvidenceResult {
  evidence: EvidenceItem[];
  nextCursor: ListCursor | null;
}

export interface EvidenceStore extends GenericStore<EvidenceItem> {
  list(filter: ListEvidenceFilter): Promise<ListEvidenceResult>;
}
