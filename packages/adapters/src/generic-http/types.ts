import type { RuntimeLogger } from "@switchyard/core";

export interface GenericHttpAsyncRestAdapterOptions {
  baseUrl?: string;
  authToken?: string;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  maxResponseBytes?: number;
  logger?: RuntimeLogger | undefined;
  fetch?: typeof fetch;
}

export interface GenericHttpSessionState {
  sessionId: string;
  runId: string;
  externalRunId: string;
  terminalStatus?: "completed" | "failed" | "cancelled" | "timeout";
  cursor?: string;
  seenEventIds: Set<string>;
  seenEventKeys: Set<string>;
}

export interface GenericHttpRequestResult {
  status: number;
  ok: boolean;
  body: unknown;
  bytes: number;
  durationMs: number;
}
