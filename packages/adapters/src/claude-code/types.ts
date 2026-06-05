import type { RuntimeAdapterCheck, RuntimeLogger } from "@switchyard/core";
import type { ProviderResolvedCommand } from "@switchyard/contracts";

export const CLAUDE_CODE_RUNTIME_MODE_SLUG = "claude_code.sdk";

export type ClaudePermissionMode = "read_only" | "plan";

export interface ClaudeCodeProviderEvent {
  type: string;
  [key: string]: unknown;
}

export interface ClaudeCodeClientSession {
  readonly sessionId?: string;
  readonly processId?: number;
  events(): AsyncIterable<ClaudeCodeProviderEvent>;
  sendUserMessage(text: string): Promise<void>;
  resolveApproval(input: {
    runtimeApprovalToken: string;
    decision: "approved" | "rejected";
    message: string;
    answers?: Record<string, unknown>;
  }): Promise<void>;
  cancel(): Promise<void>;
}

export interface ClaudeCodeClient {
  start(input: {
    runId: string;
    cwd: string;
    task: string;
    metadata: Record<string, unknown>;
  }): Promise<ClaudeCodeClientSession>;
}

export interface ClaudeCodeCliClientOptions {
  command?: string;
  processFactory?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ) => {
    readonly pid?: number | undefined;
    readonly stdin: NodeJS.WritableStream;
    readonly stdout: NodeJS.ReadableStream;
    readonly stderr: NodeJS.ReadableStream;
    once(event: "exit", listener: (code: number | null) => void): unknown;
    once(event: "error", listener: (error: unknown) => void): unknown;
    kill(signal: NodeJS.Signals): boolean;
  };
  permissionMode?: ClaudePermissionMode;
  disabledTools?: string[];
  hostedProviderCommand?: ProviderResolvedCommand;
  hostedBridgeEnabled?: boolean;
}

export interface ClaudeCodeAdapterOptions {
  client: ClaudeCodeClient;
  logger?: RuntimeLogger;
  command?: string;
  liveProbe?: boolean;
  maxBudgetUsd?: number;
  requestTimeoutMs?: number;
  permissionMode?: ClaudePermissionMode;
  disabledTools?: string[];
  hostedProviderCommand?: ProviderResolvedCommand;
  hostedBridgeEnabled?: boolean;
  doctor?: Omit<ClaudeCodeDoctorOptions, "command" | "liveProbe" | "maxBudgetUsd" | "requestTimeoutMs" | "permissionMode" | "disabledTools">;
}

export interface ClaudeCodeVersionProbeResult {
  ok: boolean;
  version?: string;
  message?: string;
}

export interface ClaudeCodeAuthProbeResult {
  ok: boolean;
  message?: string;
}

export interface ClaudeCodeLiveProbeResult {
  ok: boolean;
  message?: string;
}

export interface ClaudeCodeDoctorOptions {
  command: string;
  liveProbe: boolean;
  maxBudgetUsd: number;
  requestTimeoutMs: number;
  permissionMode: ClaudePermissionMode;
  disabledTools: string[];
  probeVersion?: () => Promise<ClaudeCodeVersionProbeResult>;
  probeAuth?: () => Promise<ClaudeCodeAuthProbeResult>;
  runLiveProbe?: (input: {
    maxBudgetUsd: number;
    permissionMode: ClaudePermissionMode;
    disabledTools: string[];
  }) => Promise<ClaudeCodeLiveProbeResult>;
}

export type ClaudeCodeDoctorCheck = RuntimeAdapterCheck;
