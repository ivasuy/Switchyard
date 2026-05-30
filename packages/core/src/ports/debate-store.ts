import type { Debate } from "@switchyard/contracts";
import type { GenericStore, ListCursor } from "./generic-stores.js";

export interface DebateStore extends GenericStore<Debate> {
  list?(filter: {
    limit: number;
    before?: ListCursor | undefined;
  }): Promise<{ debates: Debate[]; nextCursor: ListCursor | null }>;
}
