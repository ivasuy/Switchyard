import type { ApprovalType, PlacementDecision, ToolInvocation } from "@switchyard/contracts";

export type ToolExecutionPlan =
  | FetchToolExecutionPlan
  | WebSearchToolExecutionPlan
  | GithubToolExecutionPlan
  | RepoToolExecutionPlan
  | ShellToolExecutionPlan;

export interface FetchToolExecutionPlan {
  type: "fetch";
  method: "GET" | "HEAD";
  url: string;
  allowedHosts: string[];
  allowedHeaders: string[];
  maxRedirects: number;
  allowedContentTypes: string[];
  captureContent: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  maxInlineOutputBytes: number;
  maxArtifactBytes: number;
}

export interface WebSearchToolExecutionPlan {
  type: "web_search";
  providerId: string;
  baseUrl: string;
  query: string;
  maxResults: number;
  timeoutMs: number;
  maxResponseBytes: number;
  maxInlineOutputBytes: number;
  maxArtifactBytes: number;
}

export interface GithubToolExecutionPlan {
  type: "github";
  operation: "get_issue" | "get_pull" | "list_pull_files" | "get_file" | "compare_refs";
  owner: string;
  repo: string;
  number?: number;
  ref?: string;
  base?: string;
  head?: string;
  path?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxInlineOutputBytes: number;
  maxArtifactBytes: number;
}

export interface RepoToolExecutionPlan {
  type: "repo";
  operation: "status" | "diff" | "show" | "ls_files" | "grep";
  cwd: string;
  cwdPolicySummary: string;
  gitBinary: string;
  argv: string[];
  pathspec: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  maxInlineOutputBytes: number;
  maxArtifactBytes: number;
}

export interface ShellToolExecutionPlan {
  type: "shell";
  commandId: string;
  executablePath: string;
  argv: string[];
  cwd: string;
  cwdPolicySummary: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  maxInlineOutputBytes: number;
  maxArtifactBytes: number;
}

export type ToolPolicyDecision =
  | {
    decision: "deny";
    reasonCode: string;
    policyTrace: Array<Record<string, unknown>>;
  }
  | {
    decision: "approval_required";
    reasonCode: string;
    approvalType: ApprovalType;
    expiresAt: string;
    policyTrace: Array<Record<string, unknown>>;
    executionPlan: ToolExecutionPlan;
  }
  | {
    decision: "allow";
    reasonCode: string;
    policyTrace: Array<Record<string, unknown>>;
    executionPlan: ToolExecutionPlan;
  };

export interface ToolPolicyInput {
  runApprovalPolicy?: string | undefined;
  type: ToolInvocation["type"];
  input: Record<string, unknown>;
}

export interface ToolPolicyPort {
  decideTool(input: ToolPolicyInput): Promise<ToolPolicyDecision>;
  getRealToolLimits?(): { maxConcurrentRealTools: number; maxInputBytes: number };
}

export interface PolicyPort {
  decidePlacement(input: Record<string, unknown>): Promise<PlacementDecision>;
  requireApproval(input: Record<string, unknown>): Promise<boolean>;
}
