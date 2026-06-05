import {
  AdapterProtocolError,
  type ShellToolExecutionPlan,
  type ToolAdapter
} from "@switchyard/core";
import { redactSecrets } from "@switchyard/core";
import type { LocalProcessToolExecutor } from "./local-process-tool-executor.js";

export interface ShellCatalogToolAdapterOptions {
  processExecutor: LocalProcessToolExecutor;
}

export class ShellCatalogToolAdapter implements ToolAdapter {
  readonly id = "shell";

  constructor(private readonly options: ShellCatalogToolAdapterOptions) {}

  async check(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }

  async invoke(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const plan = readPlan(input);
    if (!plan.commandId || plan.commandId.trim().length === 0) {
      throw new AdapterProtocolError("Shell command is not configured", {
        reasonCode: "shell_command_not_configured"
      });
    }

    const output = await this.options.processExecutor.run({
      executablePath: plan.executablePath,
      argv: plan.argv,
      cwd: plan.cwd,
      env: plan.env,
      timeoutMs: plan.timeoutMs,
      maxOutputBytes: plan.maxOutputBytes
    });

    const stdoutRedacted = redactSecrets(output.stdout);
    const stderrRedacted = redactSecrets(output.stderr);
    const combined = [stdoutRedacted, stderrRedacted].filter((value) => value.length > 0).join("\n");

    return {
      summary: {
        commandId: plan.commandId,
        cwdPolicySummary: plan.cwdPolicySummary,
        exitCode: output.exitCode,
        durationMs: output.durationMs
      },
      inlineOutput: {
        stdout: stdoutRedacted.slice(0, plan.maxInlineOutputBytes),
        stderr: stderrRedacted.slice(0, plan.maxInlineOutputBytes)
      },
      artifactCandidates: combined.length > 0
        ? [{
          logicalPath: `${plan.commandId}.log`,
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

function readPlan(input: Record<string, unknown>): ShellToolExecutionPlan {
  const plan = input["executionPlan"];
  if (!plan || typeof plan !== "object") {
    throw new AdapterProtocolError("Missing execution plan", { reasonCode: "tool_policy_failed" });
  }
  const candidate = plan as ShellToolExecutionPlan;
  if (candidate.type !== "shell") {
    throw new AdapterProtocolError("Execution plan type mismatch", { reasonCode: "tool_policy_failed" });
  }
  return candidate;
}
