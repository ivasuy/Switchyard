import type { RoutedMessage } from "@switchyard/contracts";
import type { GenericStore } from "./generic-stores.js";

export type MessageStore = GenericStore<RoutedMessage>;
