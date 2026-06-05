import { createDisabledRealToolPolicyConfig, type ToolAdapter } from "@switchyard/core";
import {
  buildHostedToolAdapters,
  type HostedToolAdapterConfig,
  type HostedToolAdapterDeps,
  type ShellCatalogCommandConfig
} from "@switchyard/adapters";
import type { WorkerConfig } from "./config.js";

export interface WorkerHostedToolAdapterFactoryDeps extends HostedToolAdapterDeps {}

export function buildWorkerHostedToolAdapters(
  config: WorkerConfig,
  deps: WorkerHostedToolAdapterFactoryDeps = {}
): Map<string, ToolAdapter> {
  const tools = config.tools ?? {
    hostedRealTools: "disabled",
    connectedNodeRealTools: "disabled",
    adapterMode: "fake",
    allowNoApprovalInTest: config.deploymentMode !== "production",
    policySourceKind: "none",
    policy: createDisabledRealToolPolicyConfig()
  };
  const hostedConfig: HostedToolAdapterConfig = {
    placement: "hosted",
    mode: tools.adapterMode,
    fetch: {},
    webSearch: {},
    github: tools.policy.github.token ? { token: tools.policy.github.token } : {},
    shell: {
      catalog: toShellCatalog(tools.policy.shell.catalog)
    }
  };
  return buildHostedToolAdapters(hostedConfig, deps);
}

export function checkConfiguredHostedToolAdapters(config: WorkerConfig): { ok: boolean; code?: string } {
  const tools = config.tools ?? {
    hostedRealTools: "disabled",
    connectedNodeRealTools: "disabled",
    adapterMode: "fake",
    allowNoApprovalInTest: config.deploymentMode !== "production",
    policySourceKind: "none",
    policy: createDisabledRealToolPolicyConfig()
  };
  if (tools.hostedRealTools !== "enabled") {
    return { ok: true };
  }
  if (tools.policy.global.enabled !== true) {
    return { ok: false, code: "tool_policy_config_invalid" };
  }
  if (tools.policy.shell.enabled && Object.keys(tools.policy.shell.catalog).length === 0) {
    return { ok: false, code: "shell_command_not_configured" };
  }
  return { ok: true };
}

function toShellCatalog(
  input: Record<string, {
    commandId: string;
    executablePath: string;
    argv: string[];
    env: Record<string, string>;
    maxArgs: number;
  }>
): Record<string, ShellCatalogCommandConfig> {
  const out: Record<string, ShellCatalogCommandConfig> = {};
  for (const [commandId, entry] of Object.entries(input)) {
    out[commandId] = {
      executablePath: entry.executablePath,
      fixedArgs: [...entry.argv],
      env: { ...entry.env },
      timeoutMs: 30_000,
      maxOutputBytes: 262_144
    };
  }
  return out;
}
