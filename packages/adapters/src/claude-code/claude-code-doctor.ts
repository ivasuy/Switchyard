import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeAdapterCheck } from "@switchyard/core";
import type { ClaudeCodeDoctorOptions, ClaudeCodeVersionProbeResult } from "./types.js";

const execFileAsync = promisify(execFile);

export async function checkClaudeCodeAvailability(options: ClaudeCodeDoctorOptions): Promise<RuntimeAdapterCheck> {
  const probeVersion = options.probeVersion ?? (() => defaultVersionProbe(options.command, options.requestTimeoutMs));
  const probeAuth = options.probeAuth ?? (async () => ({ ok: true }));

  const version = await probeVersion();
  if (!version.ok) {
    return {
      ok: false,
      details: {
        availability: {
          state: "unavailable",
          canRun: false,
          installed: false,
          auth: "unknown",
          version: null,
          reasonCode: "binary_unavailable",
          message: version.message ?? "Claude Code binary is unavailable."
        }
      }
    };
  }

  const auth = await probeAuth();
  const authState = auth.ok ? "configured" : "missing";

  if (!options.liveProbe) {
    return {
      ok: auth.ok,
      details: {
        availability: {
          state: auth.ok ? "installed" : "partial",
          canRun: auth.ok,
          installed: true,
          auth: authState,
          version: version.version ?? null,
          reasonCode: "live_probe_disabled",
          message: "Live probe is disabled by default."
        }
      }
    };
  }

  const runLiveProbe = options.runLiveProbe ?? (async () => ({ ok: true }));
  const live = await runLiveProbe({
    maxBudgetUsd: options.maxBudgetUsd,
    permissionMode: options.permissionMode,
    disabledTools: options.disabledTools
  });

  return {
    ok: auth.ok && live.ok,
    details: {
      availability: {
        state: live.ok ? "available" : "partial",
        canRun: auth.ok && live.ok,
        installed: true,
        auth: authState,
        version: version.version ?? null,
        reasonCode: live.ok ? null : "live_probe_failed",
        message: live.ok ? null : (live.message ?? "Live probe failed.")
      },
      liveProbe: {
        maxBudgetUsd: options.maxBudgetUsd,
        permissionMode: options.permissionMode,
        disabledTools: options.disabledTools
      }
    }
  };
}

async function defaultVersionProbe(command: string, timeoutMs: number): Promise<ClaudeCodeVersionProbeResult> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024,
      windowsHide: true
    });
    const version = stdout.trim();
    if (!version) {
      return { ok: false, message: "Claude Code version output was empty." };
    }
    return { ok: true, version };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
