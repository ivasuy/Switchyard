import type { RuntimeLogger } from "@switchyard/core";

export interface DeferredHttpWrapperAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  logger?: RuntimeLogger | undefined;
}

export interface DeferredHttpWrapperAdapterDefinition {
  adapterId: string;
  providerId: string;
  runtimeId: string;
  runtimeModeId: string;
  runtimeModeSlug: string;
  name: string;
  docsPath: string;
  configPrefix: string;
  unavailableReasonCode: string;
  invalidConfigReasonCode: string;
  healthUnavailableReasonCode: string;
  healthInvalidReasonCode: string;
  healthTooLargeReasonCode: string;
  bridgeUnverifiedReasonCode: string;
  startBlockedReasonCode: string;
}
