import { spawn } from "node:child_process";
import {
  AcpProtocolError,
  AcpStdioClient,
  acpInitializeResultSchema,
  acpSessionNewResultSchema
} from "@switchyard/protocol-acpx";
import type { RuntimeAdapterCheck } from "@switchyard/core";
import type { OpenCodeAcpCheckOptions } from "./types.js";

export async function checkOpenCodeAcpAvailability(
  options: OpenCodeAcpCheckOptions
): Promise<RuntimeAdapterCheck> {
  const checkedAt = new Date().toISOString();
  const versionProbe = options.probeVersion ?? defaultProbeVersion;
  const version = await versionProbe(options.command, options.checkTimeoutMs);
  if (version.status === "missing") {
    return customCheck({
      state: "unavailable",
      canRun: false,
      installed: false,
      auth: "unknown",
      version: null,
      checkedAt,
      reasonCode: "opencode_binary_unavailable",
      message: version.message ?? "OpenCode binary was not found."
    });
  }
  if (version.status === "timeout") {
    return customCheck({
      state: "unknown",
      canRun: false,
      installed: false,
      auth: "unknown",
      version: null,
      checkedAt,
      reasonCode: "check_timeout",
      message: version.message ?? "OpenCode version check timed out."
    });
  }
  if (version.status === "error") {
    return customCheck({
      state: "unavailable",
      canRun: false,
      installed: true,
      auth: "unknown",
      version: null,
      checkedAt,
      reasonCode: "opencode_version_unavailable",
      message: version.message ?? "Unable to determine OpenCode version."
    });
  }
  if (!version.version || version.version.trim().length === 0) {
    return customCheck({
      state: "unavailable",
      canRun: false,
      installed: true,
      auth: "unknown",
      version: null,
      checkedAt,
      reasonCode: "opencode_version_unavailable",
      message: "OpenCode version command returned no parseable version."
    });
  }

  const client = new AcpStdioClient({
    command: options.command,
    args: ["acp"],
    cwd: options.cwd,
    requestTimeoutMs: options.requestTimeoutMs,
    maxMessageBytes: options.maxMessageBytes,
    ...(options.processFactory ? { processFactory: options.processFactory } : {})
  });

  let stage: "initialize" | "session_new" = "initialize";
  try {
    await client.start();
    const initialize = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false
        },
        terminal: false
      },
      clientInfo: {
        name: "switchyard",
        title: "Switchyard",
        version: "0.0.0"
      }
    }, { timeoutMs: options.requestTimeoutMs });
    const initializeResult = acpInitializeResultSchema.parse(initialize);
    if (initializeResult.protocolVersion !== 1) {
      return customCheck({
        state: "unavailable",
        canRun: false,
        installed: true,
        auth: "unknown",
        version: version.version,
        checkedAt,
        reasonCode: "acp_protocol_version_unsupported",
        message: "OpenCode ACP protocolVersion is unsupported."
      });
    }

    stage = "session_new";
    const sessionNew = await client.request("session/new", {
      cwd: options.cwd,
      mcpServers: []
    }, { timeoutMs: options.requestTimeoutMs });
    const sessionResult = acpSessionNewResultSchema.parse(sessionNew);
    if (!sessionResult.sessionId) {
      return customCheck({
        state: "unavailable",
        canRun: false,
        installed: true,
        auth: "unknown",
        version: version.version,
        checkedAt,
        reasonCode: "opencode_acp_session_new_failed",
        message: "OpenCode ACP session/new result was invalid."
      });
    }

    const transcript = client.transcript().content();
    const hasStderrWarning = transcript.includes("\"type\":\"acp.stderr\"");
    if (hasStderrWarning) {
      return customCheck({
        state: "partial",
        canRun: true,
        installed: true,
        auth: "configured",
        version: version.version,
        checkedAt,
        reasonCode: "opencode_stderr_warning",
        message: "OpenCode ACP succeeded with non-fatal stderr diagnostics."
      }, [
        { code: "opencode_stderr_warning", severity: "warning", message: "OpenCode emitted non-fatal stderr diagnostics." }
      ]);
    }

    return customCheck({
      state: "available",
      canRun: true,
      installed: true,
      auth: "configured",
      version: version.version,
      checkedAt,
      reasonCode: null,
      message: null
    }, [
      { code: "binary_version_ok", severity: "info", message: "opencode --version succeeded." },
      { code: "acp_initialize_ok", severity: "info", message: "ACP initialize succeeded." },
      { code: "acp_session_new_ok", severity: "info", message: "ACP session/new succeeded." }
    ]);
  } catch (error) {
    if (error instanceof AcpProtocolError && error.reasonCode === "acp_protocol_version_unsupported") {
      return customCheck({
        state: "unavailable",
        canRun: false,
        installed: true,
        auth: "unknown",
        version: version.version,
        checkedAt,
        reasonCode: "acp_protocol_version_unsupported",
        message: error.message
      });
    }
    if (error instanceof AcpProtocolError && error.reasonCode === "acp_transport_closed") {
      return customCheck({
        state: "unavailable",
        canRun: false,
        installed: true,
        auth: "unknown",
        version: version.version,
        checkedAt,
        reasonCode: "opencode_acp_unavailable",
        message: error.message
      });
    }
    if (error instanceof AcpProtocolError && (error.reasonCode === "acp_invalid_json" || error.reasonCode === "acp_invalid_message")) {
      return stageFailureCheck(stage, version.version, checkedAt, error.message);
    }
    if (error instanceof Error && /session\/new|auth|required|permission/i.test(error.message)) {
      return customCheck({
        state: "unavailable",
        canRun: false,
        installed: true,
        auth: "missing",
        version: version.version,
        checkedAt,
        reasonCode: "opencode_auth_required",
        message: error.message
      });
    }
    return stageFailureCheck(stage, version.version, checkedAt, error instanceof Error ? error.message : String(error));
  } finally {
    await client.close();
    client.kill();
  }
}

function stageFailureCheck(
  stage: "initialize" | "session_new",
  version: string,
  checkedAt: string,
  message: string
): RuntimeAdapterCheck {
  return customCheck({
    state: "unavailable",
    canRun: false,
    installed: true,
    auth: "unknown",
    version,
    checkedAt,
    reasonCode: stage === "initialize" ? "opencode_acp_initialize_failed" : "opencode_acp_session_new_failed",
    message
  });
}

function customCheck(
  availability: {
    state: "available" | "partial" | "unavailable" | "unknown";
    canRun: boolean;
    installed: boolean;
    auth: "configured" | "missing" | "unknown";
    version: string | null;
    checkedAt: string;
    reasonCode: string | null;
    message: string | null;
  },
  diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }> = []
): RuntimeAdapterCheck {
  return {
    ok: availability.canRun,
    details: {
      availability,
      diagnostics
    }
  };
}

async function defaultProbeVersion(
  command: string,
  timeoutMs: number
): Promise<{
  status: "ok" | "missing" | "timeout" | "error";
  version?: string;
  stderr?: string;
  message?: string;
}> {
  return await new Promise((resolve) => {
    const child = spawn(command, ["--version"], { shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      resolve({ status: "timeout", message: "opencode --version timed out." });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        resolve({ status: "missing", message: "opencode command not found." });
        return;
      }
      resolve({
        status: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    });
    child.once("exit", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const parsedVersion = stdout.trim().split(/\s+/).at(-1) ?? stdout.trim();
      const trimmedStderr = stderr.trim();
      resolve({
        status: "ok",
        version: parsedVersion,
        ...(trimmedStderr.length > 0 ? { stderr: trimmedStderr } : {})
      });
    });
  });
}
