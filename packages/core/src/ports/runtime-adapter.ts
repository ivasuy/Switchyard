import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";

export interface RuntimeAdapterCheck {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeStartResult {
  sessionId: string;
  externalSessionKey?: string;
  processId?: number;
}

export interface RuntimeAdapter {
  readonly id: string;
  check(config?: Record<string, unknown>): Promise<RuntimeAdapterCheck>;
  start(request: Record<string, unknown>): Promise<RuntimeStartResult>;
  send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void>;
  cancel(session: Record<string, unknown>): Promise<void>;
  events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent>;
  tools(session: Record<string, unknown>): Promise<string[]>;
  artifacts(session: Record<string, unknown>): Promise<Artifact[]>;
}
