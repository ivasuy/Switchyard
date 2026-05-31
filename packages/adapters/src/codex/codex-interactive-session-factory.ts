import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { AdapterProtocolError } from "@switchyard/core";

export const CODEX_INTERACTIVE_RUNTIME_MODE_SLUG = "codex.interactive";

export interface CodexInteractiveDriverCheck {
  ok: boolean;
  availability: {
    state: "available" | "partial" | "unavailable" | "installed";
    canRun: boolean;
    installed: boolean;
    auth: "configured" | "missing" | "not_required" | "unknown";
    version: string | null;
    checkedAt: string;
    reasonCode: string | null;
    message: string | null;
  };
  diagnostics?: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
  capabilities?: {
    approvalBridge: boolean;
    resumeCommandShapeAvailable: boolean;
    liveResumeVerified: boolean;
  };
}

export type CodexInteractiveProviderEvent = Record<string, unknown>;

export interface CodexInteractiveTurnInput {
  runId: string;
  cwd: string;
  task: string;
  metadata?: Record<string, unknown>;
}

export interface CodexInteractiveResumeInput {
  runId: string;
  cwd: string;
  codexThreadId?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface CodexInteractiveApprovalResolution {
  runId: string;
  codexThreadId?: string;
  runtimeApprovalToken: string;
  decision: "approved" | "rejected";
  message: string;
}

export interface CodexInteractiveCancelInput {
  runId: string;
  codexThreadId?: string;
}

export interface CodexInteractiveTurn {
  readonly startedAt: string;
  readonly threadId?: string;
  readonly waitForInput?: boolean;
  readonly waitingForApproval?: boolean;
  readonly terminalStatus?: "completed" | "failed";
  readonly terminalReasonCode?: string;
  events(): AsyncIterable<CodexInteractiveProviderEvent>;
}

export interface CodexInteractiveSessionFactory {
  check(input: { command: string; timeoutMs?: number; maxDiagnosticBytes?: number; runtimeMode?: string }): Promise<CodexInteractiveDriverCheck>;
  startTurn(input: CodexInteractiveTurnInput): Promise<CodexInteractiveTurn>;
  resumeTurn(input: CodexInteractiveResumeInput): Promise<CodexInteractiveTurn>;
  resolveApproval(input: CodexInteractiveApprovalResolution): Promise<void>;
  cancel(input: CodexInteractiveCancelInput): Promise<void>;
}

export interface CodexExecResumeJsonSessionFactoryOptions {
  command?: string;
  approvalBridgeSupported?: boolean;
}

export class CodexExecResumeJsonSessionFactory implements CodexInteractiveSessionFactory {
  private readonly command: string;
  private readonly approvalBridgeSupported: boolean;

  constructor(options: CodexExecResumeJsonSessionFactoryOptions = {}) {
    this.command = options.command ?? "codex";
    this.approvalBridgeSupported = options.approvalBridgeSupported ?? false;
  }

  async check(input: { command: string; timeoutMs?: number; maxDiagnosticBytes?: number; runtimeMode?: string }): Promise<CodexInteractiveDriverCheck> {
    const checkedAt = new Date().toISOString();
    const command = input.command || this.command;
    const timeoutMs = input.timeoutMs ?? 5000;
    const maxBytes = input.maxDiagnosticBytes ?? 4096;

    const versionResult = await runCommand(command, ["--version"], timeoutMs, maxBytes);
    if (!versionResult.ok) {
      return {
        ok: false,
        availability: {
          state: "unavailable",
          canRun: false,
          installed: false,
          auth: "missing",
          version: null,
          checkedAt,
          reasonCode: "codex_interactive_driver_unsupported",
          message: versionResult.message ?? null
        }
      };
    }

    const execHelp = await runCommand(command, ["exec", "--help"], timeoutMs, maxBytes);
    const resumeHelp = await runCommand(command, ["exec", "resume", "--help"], timeoutMs, maxBytes);
    const resumeCommandShapeAvailable = execHelp.ok && execHelp.output.includes("--json") && resumeHelp.ok && resumeHelp.output.includes("--json");

    if (!resumeCommandShapeAvailable) {
      return {
        ok: false,
        availability: {
          state: "unavailable",
          canRun: false,
          installed: true,
          auth: "configured",
          version: versionResult.output.trim() || null,
          checkedAt,
          reasonCode: "codex_resume_unsupported",
          message: "codex exec resume --json command shape is unavailable"
        },
        capabilities: {
          approvalBridge: false,
          resumeCommandShapeAvailable: false,
          liveResumeVerified: false
        }
      };
    }

    const partial = !this.approvalBridgeSupported;
    return {
      ok: true,
      availability: {
        state: partial ? "partial" : "available",
        canRun: true,
        installed: true,
        auth: "configured",
        version: versionResult.output.trim() || null,
        checkedAt,
        reasonCode: partial ? "codex_approval_bridge_unsupported" : null,
        message: partial ? "Approval bridge unsupported by active driver" : null
      },
      capabilities: {
        approvalBridge: this.approvalBridgeSupported,
        resumeCommandShapeAvailable: true,
        liveResumeVerified: false
      },
      diagnostics: [
        {
          code: "resume_command_shape_available",
          severity: "info",
          message: "resume command shape detected; live resume not verified by default no-spend checks"
        }
      ]
    };
  }

  async startTurn(_input: CodexInteractiveTurnInput): Promise<CodexInteractiveTurn> {
    throw new AdapterProtocolError("codex interactive driver is unavailable in no-spend mode", {
      reasonCode: "codex_interactive_driver_unsupported"
    });
  }

  async resumeTurn(_input: CodexInteractiveResumeInput): Promise<CodexInteractiveTurn> {
    throw new AdapterProtocolError("codex interactive driver is unavailable in no-spend mode", {
      reasonCode: "codex_interactive_driver_unsupported"
    });
  }

  async resolveApproval(_input: CodexInteractiveApprovalResolution): Promise<void> {
    if (!this.approvalBridgeSupported) {
      throw new AdapterProtocolError("codex approval bridge is unsupported", {
        reasonCode: "codex_approval_bridge_unsupported"
      });
    }
  }

  async cancel(_input: CodexInteractiveCancelInput): Promise<void> {
    return;
  }
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  maxBytes: number
): Promise<{ ok: boolean; output: string; message?: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const outputLines: string[] = [];
    let bytes = 0;
    const finish = (ok: boolean, message?: string) => {
      resolve({ ok, output: outputLines.join("\n"), ...(message ? { message } : {}) });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false, "check_timeout");
    }, timeoutMs);

    const capture = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes <= maxBytes) {
        outputLines.push(text.trim());
      }
    };

    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => capture(line));
    child.stderr.on("data", (chunk) => capture(chunk));

    child.once("error", () => {
      clearTimeout(timer);
      finish(false, "binary_unavailable");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0, code === 0 ? undefined : `command_failed_${code ?? "signal"}`);
    });
  });
}
