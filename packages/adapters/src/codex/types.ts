import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProviderResolvedCommand } from "@switchyard/contracts";
import type { RuntimeLogger } from "@switchyard/core";
import type { probeCodexCatalog } from "./codex-model-catalog.js";

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none";
export type CodexVerbosity = "low" | "medium" | "high";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexRunOptions {
  reasoningEffort?: CodexReasoningEffort;
  reasoningSummary?: CodexReasoningSummary;
  verbosity?: CodexVerbosity;
  sandbox?: CodexSandbox;
  skipGitRepoCheck?: boolean;
  ephemeral?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

export interface CodexModelCatalogEntry {
  slug: string;
  displayName?: string;
  description?: string;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: string[];
  supportsReasoningSummaries?: boolean;
  supportsVerbosity?: boolean;
  defaultVerbosity?: string;
}

export interface CodexCatalogProbe {
  ok: boolean;
  version?: string;
  models: CodexModelCatalogEntry[];
  message?: string;
  reasonCode?: "binary_unavailable" | "model_catalog_unavailable" | "check_timeout" | "check_output_too_large";
  outputBytes?: number;
  optionalChecks?: Record<string, { ok: boolean; message?: string }>;
}

export type CodexProcessFactory =
  | ((args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams)
  | ((command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams);

export interface CodexExecJsonAdapterOptions {
  command?: string;
  processFactory?: CodexProcessFactory;
  modelCatalog?: CodexModelCatalogEntry[];
  probeCatalog?: typeof probeCodexCatalog;
  logger?: RuntimeLogger | undefined;
  hostedProviderCommand?: ProviderResolvedCommand;
}

export interface CodexInteractiveRuntimeMetadata {
  codexThreadId?: string;
  codexResumeMode?: "exec_resume_json";
}
