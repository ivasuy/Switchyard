import type { RuntimeLogger } from "@switchyard/core";

export interface AgentFieldAsyncRestAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  target?: string;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  maxResponseBytes?: number;
  logger?: RuntimeLogger | undefined;
  fetch?: typeof fetch;
}

export interface AgentFieldRequestResult {
  status: number;
  ok: boolean;
  body: unknown;
  bytes: number;
  durationMs: number;
}

export interface AgentFieldSessionState {
  sessionId: string;
  runId: string;
  executionId: string;
  target: string;
  seenApprovalTokens: Set<string>;
  terminalStatus?: "completed" | "failed";
  lastStatus?: string;
  terminalPayload?: Record<string, unknown>;
}
