import type { RoutedMessage } from "@switchyard/contracts";
import type { GenericStore, ListCursor } from "./generic-stores.js";

export interface ListMessagesFilter {
  runId?: string | undefined;
  channel?: string | undefined;
  deliveryStatus?: RoutedMessage["deliveryStatus"] | undefined;
  limit: number;
  before?: ListCursor | undefined;
}

export interface ListMessagesResult {
  messages: RoutedMessage[];
  nextCursor: ListCursor | null;
}

export interface MessageStore extends GenericStore<RoutedMessage> {
  list(filter: ListMessagesFilter): Promise<ListMessagesResult>;
}
