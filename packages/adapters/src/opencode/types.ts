import type { RuntimeAdapterCheck, RuntimeLogger } from "@switchyard/core";
import type { AcpProcessFactory, AcpStdioClient } from "@switchyard/protocol-acpx";
import type { ProviderResolvedCommand, SwitchyardEvent } from "@switchyard/contracts";

export interface OpenCodeAcpAdapterOptions {
  command?: string;
  requestTimeoutMs?: number;
  cancelTimeoutMs?: number;
  maxMessageBytes?: number;
  processFactory?: AcpProcessFactory;
  logger?: RuntimeLogger | undefined;
  checkTimeoutMs?: number;
  checkCwd?: string;
  probeVersion?: (
    command: string,
    timeoutMs: number
  ) => Promise<{
    status: "ok" | "missing" | "timeout" | "error";
    version?: string;
    stderr?: string;
      message?: string;
  }>;
  hostedProviderCommand?: ProviderResolvedCommand;
  hostedBridgeEnabled?: boolean;
}

export interface OpenCodeAcpSessionState {
  runId: string;
  task: string;
  startedAt: string;
  client: AcpStdioClient;
  externalSessionKey?: string;
  initialEvents: SwitchyardEvent[];
  terminal?: SwitchyardEvent;
  promptActive: boolean;
  hostedBridgeEnabled: boolean;
  sessionReadyForPrompt: boolean;
  pendingPermissionRequestId: string | undefined;
  pendingPermissionExpiresAt: string | undefined;
  terminalWaiters: Array<(event: SwitchyardEvent | undefined) => void>;
}

export interface OpenCodeAcpCheckOptions {
  command: string;
  requestTimeoutMs: number;
  maxMessageBytes: number;
  checkTimeoutMs: number;
  cwd: string;
  processFactory?: AcpProcessFactory;
  probeVersion?: OpenCodeAcpAdapterOptions["probeVersion"];
  logger?: RuntimeLogger | undefined;
}

export type OpenCodeDoctorResult = RuntimeAdapterCheck;
