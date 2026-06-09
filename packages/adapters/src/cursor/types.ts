import type { RuntimeLogger } from "@switchyard/core";

export interface CursorAgentAdapterOptions {
  command?: string;
  probeVersion?: (command: string, options: { timeoutMs: number; maxDiagnosticBytes: number }) => Promise<CursorAgentProbeResult>;
  logger?: RuntimeLogger | undefined;
}

export interface CursorAgentProbeResult {
  ok: boolean;
  version: string | null;
  reasonCode: string | null;
  message: string | null;
}
