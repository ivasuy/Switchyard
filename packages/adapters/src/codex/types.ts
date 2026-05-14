import type { ChildProcessWithoutNullStreams } from "node:child_process";

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
}

export type CodexProcessFactory = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcessWithoutNullStreams;
