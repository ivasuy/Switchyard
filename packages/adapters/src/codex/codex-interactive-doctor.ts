import type { RuntimeAdapterCheck } from "@switchyard/core";
import {
  CODEX_INTERACTIVE_RUNTIME_MODE_SLUG,
  type CodexInteractiveSessionFactory
} from "./codex-interactive-session-factory.js";

export async function checkCodexInteractiveAvailability(input: {
  factory: CodexInteractiveSessionFactory;
  command?: string;
  timeoutMs?: number;
  maxDiagnosticBytes?: number;
}): Promise<RuntimeAdapterCheck> {
  const checkInput: { command: string; timeoutMs?: number; maxDiagnosticBytes?: number; runtimeMode?: string } = {
    command: input.command ?? "codex",
    runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG
  };
  if (input.timeoutMs !== undefined) checkInput.timeoutMs = input.timeoutMs;
  if (input.maxDiagnosticBytes !== undefined) checkInput.maxDiagnosticBytes = input.maxDiagnosticBytes;
  const result = await input.factory.check(checkInput);

  const check: RuntimeAdapterCheck = {
    ok: result.ok,
    details: {
      availability: result.availability,
      diagnostics: result.diagnostics,
      resumeCommandShapeAvailable: result.capabilities?.resumeCommandShapeAvailable ?? false,
      liveResumeVerified: result.capabilities?.liveResumeVerified ?? false,
      approvalBridge: result.capabilities?.approvalBridge ?? false
    }
  };
  if (result.availability.message !== null) {
    check.message = result.availability.message;
  }
  return check;
}
