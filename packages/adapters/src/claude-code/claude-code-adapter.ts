import { isAbsolute } from "node:path";
import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import {
  AdapterProtocolError,
  redactSecrets,
  type RuntimeAdapter,
  type RuntimeAdapterCheck,
  type RuntimeAdapterManifest,
  type RuntimeLogger,
  type RuntimeStartResult
} from "@switchyard/core";
import {
  CLAUDE_CODE_RUNTIME_MODE_SLUG,
  type ClaudeCodeAdapterOptions,
  type ClaudeCodeClient,
  type ClaudeCodeClientSession,
  type ClaudePermissionMode
} from "./types.js";
import { mapClaudeCodeEventToSwitchyardEvent } from "./claude-code-event-mapper.js";
import { checkClaudeCodeAvailability } from "./claude-code-doctor.js";
import { finalizeTranscript, serializeNormalizedRecord } from "./transcript-bounds.js";

const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

interface StoredClaudeSession {
  startedAt: string;
  runId: string;
  clientSession: ClaudeCodeClientSession;
  rawRecords: string[];
  normalizedRecords: Record<string, unknown>[];
  terminalSeen: boolean;
  unknownEventCount: number;
  unknownSuppressed: boolean;
  pendingRuntimeApprovalTokens: Set<string>;
  hostedProviderMode: boolean;
}

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = "claude_code";
  readonly manifest: RuntimeAdapterManifest = {
    adapterId: "claude_code",
    providerId: "provider_anthropic",
    runtimeId: "runtime_claude_code",
    runtimeModeId: "runtime_mode_claude_code_sdk",
    runtimeModeSlug: CLAUDE_CODE_RUNTIME_MODE_SLUG,
    name: "Claude Code SDK",
    adapterType: "native",
    kind: "sdk",
    capabilities: [
      "run.start",
      "run.input",
      "run.cancel",
      "run.timeout",
      "session.state",
      "approval.bridge",
      "event.normalized",
      "event.streaming",
      "artifact.transcript",
      "artifact.raw_transcript",
      "tool.call.normalized",
      "tool.result.normalized",
      "user.question",
      "auth.local"
    ],
    limitations: [
      { code: "local_only", message: "claude_code.sdk is local-only in R8." },
      { code: "no_session_resume", message: "Session resume is not shipped for claude_code.sdk in R8." },
      { code: "user_question_text_response_only", message: "AskUserQuestion answers default to text-only reason payloads when structured answers are absent." }
    ],
    placement: {
      local: { support: "conditional", reason: "Requires local Claude Code tooling and auth." },
      hosted: { support: "unsupported", reason: "Hosted execution is not shipped in R8." },
      connectedLocalNode: { support: "future", reason: "Hybrid local node execution is planned for a future release." }
    },
    docsPath: "docs/development/adapters/CLAUDE_CODE.md",
    check: {
      strategy: "custom",
      required: ["binary_version"],
      optional: ["auth", "live_probe"]
    }
  };

  private readonly sessions = new Map<string, StoredClaudeSession>();
  private readonly logger: RuntimeLogger | undefined;
  private readonly command: string;
  private readonly liveProbe: boolean;
  private readonly maxBudgetUsd: number;
  private readonly requestTimeoutMs: number;
  private readonly permissionMode: ClaudePermissionMode;
  private readonly disabledTools: string[];
  private readonly hostedBridgeEnabled: boolean;

  constructor(private readonly options: ClaudeCodeAdapterOptions) {
    this.logger = options.logger;
    this.command = options.command ?? "claude";
    this.liveProbe = options.liveProbe ?? false;
    this.maxBudgetUsd = options.maxBudgetUsd ?? 0.05;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.permissionMode = options.permissionMode ?? "read_only";
    this.disabledTools = options.disabledTools ?? ["Bash", "WebFetch", "WebSearch"];
    this.hostedBridgeEnabled = options.hostedBridgeEnabled ?? false;
  }

  async check(): Promise<RuntimeAdapterCheck> {
    const doctorOverrides = this.options.doctor ?? {};
    return await checkClaudeCodeAvailability({
      command: this.command,
      liveProbe: this.liveProbe,
      maxBudgetUsd: this.maxBudgetUsd,
      requestTimeoutMs: this.requestTimeoutMs,
      permissionMode: this.permissionMode,
      disabledTools: this.disabledTools,
      ...(doctorOverrides.probeVersion ? { probeVersion: doctorOverrides.probeVersion } : {}),
      ...(doctorOverrides.probeAuth ? { probeAuth: doctorOverrides.probeAuth } : {}),
      ...(doctorOverrides.runLiveProbe ? { runLiveProbe: doctorOverrides.runLiveProbe } : {})
    });
  }

  async start(request: Record<string, unknown>): Promise<RuntimeStartResult> {
    const runId = requiredString(request["runId"], "runId", "claude_run_id_required");
    const cwd = requiredString(request["cwd"], "cwd", "claude_cwd_required");
    const task = requiredString(request["task"], "task", "claude_task_required");
    const metadata = isRecord(request["metadata"]) ? request["metadata"] : {};

    if (!isAbsolute(cwd)) {
      throw new AdapterProtocolError("Claude Code requires an absolute cwd.", {
        reasonCode: "claude_cwd_not_absolute"
      });
    }
    if (task.trim().length === 0) {
      throw new AdapterProtocolError("Claude Code requires a non-empty task.", {
        reasonCode: "claude_task_required"
      });
    }
    if (hasDangerousBypass(metadata)) {
      throw new AdapterProtocolError("Dangerous permission bypass flags are not allowed.", {
        reasonCode: "claude_permission_bypass_denied"
      });
    }

    const startedAt = new Date().toISOString();
    const clientSession = await this.options.client.start({
      runId,
      cwd,
      task,
      metadata
    });
    const sessionId = clientSession.sessionId ?? `session_${crypto.randomUUID()}`;

    this.sessions.set(sessionId, {
      startedAt,
      runId,
      clientSession,
      rawRecords: [],
      normalizedRecords: [],
      terminalSeen: false,
      unknownEventCount: 0,
      unknownSuppressed: false,
      pendingRuntimeApprovalTokens: new Set<string>(),
      hostedProviderMode: Boolean(this.options.hostedProviderCommand)
    });

    return {
      sessionId,
      ...(clientSession.processId ? { processId: clientSession.processId } : {})
    };
  }

  async send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void> {
    const stored = this.requireSession(session);
    if (stored.hostedProviderMode && !this.hostedBridgeEnabled) {
      throw new AdapterProtocolError("Hosted Claude input bridge is unsupported.", {
        reasonCode: "hosted_input_bridge_unsupported"
      });
    }

    const text = input["text"];
    if (typeof text === "string") {
      if (stored.terminalSeen) {
        throw new AdapterProtocolError("Claude session is not active.", {
          reasonCode: "runtime_input_not_active"
        });
      }
      if (text.trim().length === 0) {
        throw new AdapterProtocolError("Claude input text must be non-empty.", {
          reasonCode: "runtime_input_empty"
        });
      }
      try {
        await stored.clientSession.sendUserMessage(text);
      } catch (error) {
        throw new AdapterProtocolError("Claude input send failed.", {
          reasonCode: "claude_input_send_failed",
          details: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
      stored.normalizedRecords.push(redactSecrets({
        type: "input.accepted",
        text,
        redacted: true
      }));
      this.logger?.info("claude_code.input.accepted", {
        runId: stored.runId
      });
      return;
    }

    if (input["type"] === "approval_resolution") {
      const runtimeApprovalToken = input["runtimeApprovalToken"];
      if (typeof runtimeApprovalToken !== "string" || !stored.pendingRuntimeApprovalTokens.has(runtimeApprovalToken)) {
        throw new AdapterProtocolError("Runtime approval pause is not active.", {
          reasonCode: "runtime_approval_pause_not_active"
        });
      }
      if (stored.terminalSeen) {
        throw new AdapterProtocolError("Runtime approval pause is not active.", {
          reasonCode: "runtime_approval_pause_not_active"
        });
      }
      const decision = input["decision"] === "rejected" ? "rejected" : "approved";
      const message = typeof input["message"] === "string" && input["message"].trim().length > 0
        ? input["message"].trim()
        : `${decision} by local-user`;
      const answers = isRecord(input["answers"]) ? input["answers"] : undefined;
      try {
        await stored.clientSession.resolveApproval({
          runtimeApprovalToken,
          decision,
          message,
          ...(answers ? { answers } : {})
        });
      } catch (error) {
        throw new AdapterProtocolError("Claude approval resolution failed.", {
          reasonCode: "claude_approval_resolution_failed",
          details: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
      stored.pendingRuntimeApprovalTokens.delete(runtimeApprovalToken);
      stored.normalizedRecords.push(redactSecrets({
        type: "approval.resolution",
        runtimeApprovalToken,
        decision,
        message,
        ...(answers ? { answers } : {})
      }));
      this.logger?.info("claude_code.approval.resolved", {
        runId: stored.runId,
        decision
      });
      return;
    }

    throw new AdapterProtocolError("Unsupported Claude input payload.", {
      reasonCode: "claude_input_unsupported"
    });
  }

  async cancel(session: Record<string, unknown>): Promise<void> {
    const stored = this.requireSession(session);
    if (stored.terminalSeen) {
      return;
    }
    await stored.clientSession.cancel();
    this.logger?.info("claude_code.cancel", { runId: stored.runId });
  }

  async *events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    const stored = this.requireSession(session);
    const runId = requiredString(session["runId"], "runId", "claude_run_id_required");
    let sequence = 0;

    for await (const providerEvent of stored.clientSession.events()) {
      stored.rawRecords.push(JSON.stringify(redactSecrets(providerEvent)));
      const createdAt = new Date().toISOString();
      const mapped = mapClaudeCodeEventToSwitchyardEvent(providerEvent, {
        runId,
        sequence,
        createdAt,
        unknownEventCount: stored.unknownEventCount,
        unknownSuppressed: stored.unknownSuppressed
      });
      stored.unknownEventCount = mapped.unknownEventCount;
      stored.unknownSuppressed = mapped.unknownSuppressed;

      for (const event of mapped.events) {
        sequence += 1;
        if (stored.hostedProviderMode && !this.hostedBridgeEnabled && event.type === "approval.requested") {
          stored.terminalSeen = true;
          yield {
            id: `event_${crypto.randomUUID()}`,
            type: "run.failed",
            runId,
            sequence: event.sequence,
            payload: {
              status: "failed",
              reasonCode: "hosted_approval_bridge_unsupported",
              error: "Hosted approval bridge is unsupported."
            },
            createdAt
          };
          return;
        }
        if (event.type === "approval.requested") {
          const token = event.payload["runtimeApprovalToken"];
          if (typeof token === "string" && token.length > 0) {
            stored.pendingRuntimeApprovalTokens.add(token);
          }
        }
        stored.normalizedRecords.push(redactSecrets(event));
        if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
          stored.terminalSeen = true;
        }
        yield event;
      }
    }
  }

  async tools(): Promise<string[]> {
    return [];
  }

  async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    const stored = this.requireSession(session);
    const runId = requiredString(session["runId"], "runId", "claude_run_id_required");

    const rawContent = finalizeTranscript(
      stored.rawRecords.map((line) => `${line}\n`),
      MAX_TRANSCRIPT_BYTES
    );
    const normalizedContent = finalizeTranscript(
      stored.normalizedRecords.map((record) => `${serializeNormalizedRecord(record)}\n`),
      MAX_TRANSCRIPT_BYTES
    );

    return [
      {
        id: `artifact_claude_raw_${runId}`,
        type: "transcript",
        path: `runs/${runId}/claude-code-raw-transcript.jsonl`,
        metadata: {
          content: rawContent,
          runtime: "claude_code",
          mode: "sdk",
          runtimeMode: CLAUDE_CODE_RUNTIME_MODE_SLUG,
          transcriptVersion: "r8.v1",
          redacted: true
        },
        createdAt: stored.startedAt
      },
      {
        id: `artifact_claude_normalized_${runId}`,
        type: "transcript",
        path: `runs/${runId}/claude-code-normalized-transcript.jsonl`,
        metadata: {
          content: normalizedContent,
          runtime: "claude_code",
          mode: "sdk",
          runtimeMode: CLAUDE_CODE_RUNTIME_MODE_SLUG,
          transcriptVersion: "r8.v1",
          redacted: true
        },
        createdAt: stored.startedAt
      }
    ];
  }

  private requireSession(session: Record<string, unknown>): StoredClaudeSession {
    const sessionId = requiredString(session["sessionId"], "sessionId", "claude_session_missing");
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      throw new AdapterProtocolError("Claude session is missing.", {
        reasonCode: "claude_session_missing"
      });
    }
    return stored;
  }
}

function requiredString(value: unknown, field: string, reasonCode: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdapterProtocolError(`${field} is required.`, { reasonCode });
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasDangerousBypass(metadata: Record<string, unknown>): boolean {
  const keys = ["dangerously-skip-permissions", "dangerouslySkipPermissions"];
  return keys.some((key) => metadata[key] === true);
}
