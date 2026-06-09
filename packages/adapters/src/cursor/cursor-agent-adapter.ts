import { spawn } from "node:child_process";
import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import {
  AdapterProtocolError,
  type RuntimeAdapter,
  type RuntimeAdapterCheck,
  type RuntimeAdapterManifest,
  type RuntimeLogger,
  type RuntimeStartResult
} from "@switchyard/core";
import type { CursorAgentAdapterOptions, CursorAgentProbeResult } from "./types.js";

export const CURSOR_AGENT_RUNTIME_MODE_SLUG = "cursor.agent_stream_json";

export class CursorAgentAdapter implements RuntimeAdapter {
  readonly id = "cursor";
  readonly manifest: RuntimeAdapterManifest = {
    adapterId: "cursor",
    providerId: "provider_cursor",
    runtimeId: "runtime_cursor_agent",
    runtimeModeId: "runtime_mode_cursor_agent_stream_json",
    runtimeModeSlug: CURSOR_AGENT_RUNTIME_MODE_SLUG,
    name: "Cursor Agent stream JSON",
    adapterType: "process",
    kind: "one_shot_process",
    capabilities: [
      "run.start",
      "run.timeout",
      "event.normalized",
      "event.streaming",
      "artifact.transcript",
      "artifact.raw_transcript",
      "auth.local"
    ],
    limitations: [
      {
        code: "auth_keychain_unverified",
        message: "Local Cursor Agent auth/keychain behavior is not verified for Switchyard execution."
      },
      {
        code: "stream_shape_unverified",
        message: "Cursor Agent stream-json output shape needs fixtures before run execution is admitted."
      },
      {
        code: "start_disabled_until_verified",
        message: "This adapter slice exposes manifest/check only; start is blocked until auth and stream fixtures are verified."
      }
    ],
    placement: {
      local: { support: "conditional", reason: "Requires a PATH-reachable cursor-agent binary and verified local auth." },
      hosted: { support: "unsupported", reason: "Hosted Cursor Agent execution is not shipped." },
      connectedLocalNode: { support: "future", reason: "Connected-node Cursor execution is deferred until local execution is verified." }
    },
    docsPath: "docs/development/adapters/CURSOR.md",
    check: {
      strategy: "binary_version",
      required: ["binary_version", "auth_status"],
      optional: ["stream_json_probe"]
    }
  };

  private readonly command: string;
  private readonly probeVersion: NonNullable<CursorAgentAdapterOptions["probeVersion"]>;
  private readonly logger: RuntimeLogger | undefined;

  constructor(options: CursorAgentAdapterOptions = {}) {
    this.command = options.command ?? "cursor-agent";
    this.probeVersion = options.probeVersion ?? probeCursorAgentVersion;
    this.logger = options.logger;
  }

  async check(config?: Record<string, unknown>): Promise<RuntimeAdapterCheck> {
    const timeoutMs = typeof config?.["timeoutMs"] === "number" ? config["timeoutMs"] : 2000;
    const maxDiagnosticBytes = typeof config?.["maxDiagnosticBytes"] === "number" ? config["maxDiagnosticBytes"] : 4096;
    const probe = await this.probeVersion(this.command, { timeoutMs, maxDiagnosticBytes });
    return {
      ok: probe.ok,
      ...(probe.message ? { message: probe.message } : {}),
      details: {
        availability: {
          state: probe.ok ? "partial" : "unavailable",
          canRun: false,
          installed: probe.version !== null,
          auth: "unknown",
          version: probe.version,
          reasonCode: probe.ok ? "cursor_stream_shape_unverified" : probe.reasonCode,
          message: probe.ok
            ? "Cursor Agent binary is present, but Switchyard execution is blocked until auth and stream-json fixtures are verified."
            : probe.message
        }
      }
    };
  }

  async start(): Promise<RuntimeStartResult> {
    this.log("warn", "cursor.start.denied", { reasonCode: "cursor_adapter_unverified" });
    throw new AdapterProtocolError("Cursor Agent execution is not admitted until auth and stream fixtures are verified.", {
      reasonCode: "cursor_adapter_unverified"
    });
  }

  async send(): Promise<void> {
    throw new AdapterProtocolError("Cursor Agent input bridge is not shipped.", {
      reasonCode: "cursor_input_unsupported"
    });
  }

  async cancel(): Promise<void> {
    throw new AdapterProtocolError("Cursor Agent cancellation is not available before execution is admitted.", {
      reasonCode: "cursor_cancel_unsupported"
    });
  }

  async *events(): AsyncIterable<SwitchyardEvent> {
    return;
  }

  async tools(): Promise<string[]> {
    return [];
  }

  async artifacts(): Promise<Artifact[]> {
    return [];
  }

  private log(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>): void {
    this.logger?.[level]?.(event, details);
  }
}

export async function probeCursorAgentVersion(
  command: string,
  options: { timeoutMs: number; maxDiagnosticBytes: number }
): Promise<CursorAgentProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { shell: false });
    let output = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        ok: false,
        version: null,
        reasonCode: "cursor_check_timeout",
        message: "cursor-agent --version timed out."
      });
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: string | Buffer) => {
      output = truncate(output + chunk.toString("utf8"), options.maxDiagnosticBytes);
    });
    child.stderr.on("data", (chunk: string | Buffer) => {
      stderr = truncate(stderr + chunk.toString("utf8"), options.maxDiagnosticBytes);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        version: null,
        reasonCode: "cursor_binary_missing",
        message: error instanceof Error ? error.message : String(error)
      });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const version = output.trim() || null;
      if (code === 0 && version) {
        resolve({ ok: true, version, reasonCode: null, message: null });
        return;
      }
      resolve({
        ok: false,
        version,
        reasonCode: "cursor_version_failed",
        message: truncate(stderr || output || `cursor-agent --version exited ${code}`, options.maxDiagnosticBytes)
      });
    });
  });
}

function truncate(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  return buffer.subarray(0, maxBytes).toString("utf8");
}
