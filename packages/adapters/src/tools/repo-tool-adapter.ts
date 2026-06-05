import {
  AdapterProtocolError,
  type RepoToolExecutionPlan,
  type ToolAdapter
} from "@switchyard/core";
import { redactSecrets } from "@switchyard/core";
import type { LocalProcessToolExecutor } from "./local-process-tool-executor.js";

export interface RepoToolAdapterOptions {
  processExecutor: LocalProcessToolExecutor;
}

const FORBIDDEN_ARGV_TOKENS = [
  "fetch",
  "pull",
  "push",
  "checkout",
  "reset",
  "clean",
  "apply",
  "submodule"
];

export class RepoToolAdapter implements ToolAdapter {
  readonly id = "repo";

  constructor(private readonly options: RepoToolAdapterOptions) {}

  async check(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }

  async invoke(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const plan = readPlan(input);
    if (plan.argv.some((arg) => FORBIDDEN_ARGV_TOKENS.includes(arg.toLowerCase()))) {
      throw new AdapterProtocolError("Repo operation denied", { reasonCode: "repo_operation_denied" });
    }

    const output = await this.options.processExecutor.run({
      executablePath: plan.gitBinary,
      argv: plan.argv,
      cwd: plan.cwd,
      env: {},
      timeoutMs: plan.timeoutMs,
      maxOutputBytes: plan.maxOutputBytes
    });

    const stdoutRedacted = redactSecrets(output.stdout);
    const stderrRedacted = redactSecrets(output.stderr);
    const combined = [stdoutRedacted, stderrRedacted].filter((value) => value.length > 0).join("\n");

    return {
      summary: {
        operation: plan.operation,
        cwdPolicySummary: plan.cwdPolicySummary,
        exitCode: output.exitCode,
        durationMs: output.durationMs,
        stdoutBytes: Buffer.byteLength(stdoutRedacted, "utf8"),
        stderrBytes: Buffer.byteLength(stderrRedacted, "utf8")
      },
      inlineOutput: {
        stdout: stdoutRedacted.slice(0, plan.maxInlineOutputBytes),
        stderr: stderrRedacted.slice(0, plan.maxInlineOutputBytes)
      },
      artifactCandidates: combined.length > 0
        ? [{
          logicalPath: `repo-${plan.operation}.log`,
          type: "raw_log",
          content: combined.slice(0, plan.maxArtifactBytes),
          contentType: "text/plain",
          metadata: {
            truncated: Buffer.byteLength(combined, "utf8") > plan.maxArtifactBytes
          }
        }]
        : [],
      truncated: output.truncated
    };
  }

  async cancel(): Promise<void> {
    return;
  }

  async artifacts(): Promise<[]> {
    return [];
  }
}

function readPlan(input: Record<string, unknown>): RepoToolExecutionPlan {
  const plan = input["executionPlan"];
  if (!plan || typeof plan !== "object") {
    throw new AdapterProtocolError("Missing execution plan", { reasonCode: "tool_policy_failed" });
  }
  const candidate = plan as RepoToolExecutionPlan;
  if (candidate.type !== "repo") {
    throw new AdapterProtocolError("Execution plan type mismatch", { reasonCode: "tool_policy_failed" });
  }
  return candidate;
}
