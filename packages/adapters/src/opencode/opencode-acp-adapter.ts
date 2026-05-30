import { isAbsolute } from "node:path";
import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import {
  AdapterProtocolError,
  type RuntimeAdapter,
  type RuntimeAdapterCheck,
  type RuntimeAdapterManifest,
  type RuntimeLogger,
  type RuntimeStartResult
} from "@switchyard/core";
import {
  AcpProtocolError,
  AcpResponseError,
  AcpStdioClient,
  acpInitializeResultSchema,
  acpSessionNewResultSchema
} from "@switchyard/protocol-acpx";
import { mapAcpSessionUpdateToSwitchyardEvent } from "./opencode-event-mapper.js";
import { checkOpenCodeAcpAvailability } from "./opencode-doctor.js";
import type {
  OpenCodeAcpAdapterOptions,
  OpenCodeAcpSessionState
} from "./types.js";

export const OPENCODE_ACP_RUNTIME_MODE_SLUG = "opencode.acp";

export class OpenCodeAcpAdapter implements RuntimeAdapter {
  readonly id = "opencode";
  readonly manifest: RuntimeAdapterManifest = {
    adapterId: "opencode",
    providerId: "provider_opencode",
    runtimeId: "runtime_opencode",
    runtimeModeId: "runtime_mode_opencode_acp",
    runtimeModeSlug: OPENCODE_ACP_RUNTIME_MODE_SLUG,
    name: "OpenCode ACP",
    adapterType: "acpx",
    kind: "acp",
    capabilities: [
      "run.start",
      "run.cancel",
      "run.timeout",
      "event.normalized",
      "event.streaming",
      "artifact.transcript",
      "artifact.raw_transcript",
      "auth.local"
    ],
    limitations: [
      { code: "one_prompt_per_run", message: "opencode.acp sends one ACP prompt per Switchyard run in R5." },
      { code: "no_post_start_input", message: "opencode.acp does not support POST /runs/:id/input in R5." },
      { code: "no_switchyard_approval_bridge", message: "ACP permission requests are failed visibly because Switchyard approval workflow is not shipped in R5." },
      { code: "configured_local_binary_only", message: "OpenCode command is daemon-level local configuration, not per run." },
      { code: "no_session_resume", message: "OpenCode ACP session load/resume/fork/list are not exposed through Switchyard in R5." }
    ],
    placement: {
      local: {
        support: "conditional",
        reason: "Requires a PATH-reachable local opencode binary and local OpenCode authentication/configuration."
      },
      hosted: { support: "future", reason: "Hosted execution is not shipped in R5." },
      connectedLocalNode: { support: "future", reason: "Hybrid local-node execution is not shipped in R5." }
    },
    docsPath: "docs/development/adapters/OPENCODE.md",
    check: {
      strategy: "custom",
      required: ["binary_version", "acp_initialize", "acp_session_new"],
      optional: ["stderr_warning"]
    }
  };

  private readonly command: string;
  private readonly requestTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly maxMessageBytes: number;
  private readonly processFactory;
  private readonly logger: RuntimeLogger | undefined;
  private readonly checkTimeoutMs: number;
  private readonly checkCwd: string;
  private readonly probeVersion;
  private readonly sessions = new Map<string, OpenCodeAcpSessionState>();

  constructor(options: OpenCodeAcpAdapterOptions = {}) {
    this.command = options.command ?? "opencode";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? 5000;
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
    this.processFactory = options.processFactory;
    this.logger = options.logger;
    this.checkTimeoutMs = options.checkTimeoutMs ?? 5000;
    this.checkCwd = options.checkCwd ?? process.cwd();
    this.probeVersion = options.probeVersion;
  }

  async check(): Promise<RuntimeAdapterCheck> {
    return await checkOpenCodeAcpAvailability({
      command: this.command,
      requestTimeoutMs: this.requestTimeoutMs,
      maxMessageBytes: this.maxMessageBytes,
      checkTimeoutMs: this.checkTimeoutMs,
      cwd: this.checkCwd,
      ...(this.processFactory ? { processFactory: this.processFactory } : {}),
      ...(this.probeVersion ? { probeVersion: this.probeVersion } : {}),
      ...(this.logger ? { logger: this.logger } : {})
    });
  }

  async start(request: Record<string, unknown>): Promise<RuntimeStartResult> {
    const runId = requiredString(request["runId"], "runId");
    const cwd = requiredString(request["cwd"], "cwd");
    const task = requiredString(request["task"], "task");
    if (!isAbsolute(cwd)) {
      throw new AdapterProtocolError("OpenCode ACP requires an absolute cwd.", {
        reasonCode: "opencode_cwd_not_absolute"
      });
    }
    if (task.trim().length === 0) {
      throw new AdapterProtocolError("OpenCode ACP requires a non-empty task.", {
        reasonCode: "opencode_task_required"
      });
    }

    const client = new AcpStdioClient({
      command: this.command,
      args: ["acp"],
      cwd,
      requestTimeoutMs: this.requestTimeoutMs,
      maxMessageBytes: this.maxMessageBytes,
      ...(this.processFactory ? { processFactory: this.processFactory } : {})
    });
    await client.start();

    const initialize = acpInitializeResultSchema.parse(await client.request("initialize", {
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
    }, { timeoutMs: this.requestTimeoutMs }));
    if (initialize.protocolVersion !== 1) {
      throw new AdapterProtocolError("OpenCode ACP protocol version is unsupported.", {
        reasonCode: "acp_protocol_version_unsupported"
      });
    }

    const sessionNew = acpSessionNewResultSchema.parse(await client.request("session/new", {
      cwd,
      mcpServers: []
    }, { timeoutMs: this.requestTimeoutMs }));
    const acpSessionId = sessionNew.sessionId;
    const sessionId = `session_${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    const initialEvents: SwitchyardEvent[] = [
      event(runId, 0, "runtime.status", {
        status: "acp_initialized",
        protocolVersion: initialize.protocolVersion,
        agentName: initialize.agentInfo.name,
        agentVersion: initialize.agentInfo.version
      }),
      event(runId, 1, "runtime.status", {
        status: "acp_session_started",
        acpSessionId,
        currentModelId: sessionNew.models?.currentModelId,
        currentModeId: sessionNew.modes?.currentModeId
      })
    ];

    this.sessions.set(sessionId, {
      runId,
      task,
      startedAt,
      client,
      externalSessionKey: acpSessionId,
      initialEvents,
      promptActive: false,
      terminalWaiters: []
    });
    this.log("info", "opencode.acp.start", { runId, acpSessionId });

    return {
      sessionId,
      externalSessionKey: acpSessionId
    };
  }

  async send(_session: Record<string, unknown>, _input: Record<string, unknown>): Promise<void> {
    throw new AdapterProtocolError("OpenCode ACP does not support POST /runs/:id/input in R5.", {
      reasonCode: "opencode_input_unsupported"
    });
  }

  async cancel(session: Record<string, unknown>): Promise<void> {
    const stored = this.requireSession(session);
    if (stored.terminal?.type === "run.cancelled" || stored.terminal) {
      return;
    }

    await stored.client.notify("session/cancel", {
      sessionId: stored.externalSessionKey
    });

    const verified = await this.waitForTerminal(stored, this.cancelTimeoutMs);
    if (!verified || verified.type !== "run.cancelled") {
      throw new AdapterProtocolError("OpenCode ACP cancellation could not be verified.", {
        reasonCode: "acp_cancel_unverified"
      });
    }
  }

  async *events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    const stored = this.requireSession(session);
    const runId = requiredString(session["runId"], "runId");
    let sequence = 0;
    for (const initial of stored.initialEvents) {
      yield {
        ...initial,
        runId,
        sequence: sequence++
      };
    }

    stored.promptActive = true;
    const notifications = stored.client.notifications()[Symbol.asyncIterator]();
    const promptRequest = stored.client.request("session/prompt", {
      sessionId: stored.externalSessionKey,
      prompt: [{ type: "text", text: stored.task }]
    }, { timeoutMs: this.requestTimeoutMs });

    let promptSettled = false;
    let promptResult: unknown;
    let promptError: unknown;

    while (!promptSettled) {
      const raced = await Promise.race([
        promptRequest.then((value) => ({ type: "prompt_result" as const, value })).catch((error) => ({ type: "prompt_error" as const, error })),
        notifications.next().then((value) => ({ type: "notification" as const, value }))
      ]);

      if (raced.type === "prompt_result") {
        promptSettled = true;
        promptResult = raced.value;
        break;
      }
      if (raced.type === "prompt_error") {
        promptSettled = true;
        promptError = raced.error;
        break;
      }

      if (raced.value.done) {
        continue;
      }

      const event = raced.value.value;
      if (event.type === "notification" && event.message.method === "session/update") {
        const params = readRecord(event.message.params);
        const update = params ? params["update"] : undefined;
        const mapped = mapAcpSessionUpdateToSwitchyardEvent({
          runId,
          ...(stored.externalSessionKey ? { acpSessionId: stored.externalSessionKey } : {}),
          update,
          sequence
        });
        sequence += 1;
        yield mapped;
        continue;
      }

      if (event.type === "permission_request") {
        const terminal = eventForFailure(runId, sequence++, "acp_permission_request_unsupported");
        stored.terminal = terminal;
        stored.promptActive = false;
        this.resolveWaiters(stored, terminal);
        yield terminal;
        try {
          await stored.client.notify("session/cancel", { sessionId: stored.externalSessionKey });
        } catch {
          // Best-effort cleanup only.
        }
        return;
      }

      if (event.type === "unsupported_request") {
        yield eventForStatus(runId, sequence++, "acp_client_method_unsupported");
      }
    }

    stored.promptActive = false;
    if (stored.terminal) {
      return;
    }

    if (promptError) {
      const terminal = mapPromptError(runId, sequence++, promptError);
      stored.terminal = terminal;
      this.resolveWaiters(stored, terminal);
      yield terminal;
      return;
    }

    const stopReason = readStopReason(promptResult);
    const terminal = mapPromptStopReason(runId, sequence++, stopReason);
    stored.terminal = terminal;
    this.resolveWaiters(stored, terminal);
    yield terminal;
  }

  async tools(): Promise<string[]> {
    return [];
  }

  async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    const stored = this.requireSession(session);
    const runId = requiredString(session["runId"], "runId");
    return [{
      id: "artifact_opencode_acp_transcript",
      type: "transcript",
      path: `runs/${runId}/opencode-acp-transcript.jsonl`,
      metadata: {
        content: stored.client.transcript().content(),
        ...stored.client.transcript().metadata({
          runtime: "opencode",
          mode: "acp",
          runtimeMode: OPENCODE_ACP_RUNTIME_MODE_SLUG,
          ...(stored.externalSessionKey ? { acpSessionId: stored.externalSessionKey } : {})
        })
      },
      createdAt: stored.startedAt
    }];
  }

  private requireSession(session: Record<string, unknown>): OpenCodeAcpSessionState {
    const id = requiredString(session["sessionId"], "sessionId");
    const stored = this.sessions.get(id);
    if (!stored) {
      throw new Error(`OpenCode ACP session not found: ${id}`);
    }
    return stored;
  }

  private async waitForTerminal(
    session: OpenCodeAcpSessionState,
    timeoutMs: number
  ): Promise<SwitchyardEvent | undefined> {
    if (session.terminal) {
      return session.terminal;
    }
    return await new Promise<SwitchyardEvent | undefined>((resolve) => {
      const timer = setTimeout(() => {
        session.terminalWaiters = session.terminalWaiters.filter((waiter) => waiter !== onTerminal);
        resolve(undefined);
      }, timeoutMs);
      const onTerminal = (event: SwitchyardEvent | undefined) => {
        clearTimeout(timer);
        resolve(event);
      };
      session.terminalWaiters.push(onTerminal);
    });
  }

  private resolveWaiters(session: OpenCodeAcpSessionState, event: SwitchyardEvent): void {
    for (const waiter of session.terminalWaiters) {
      waiter(event);
    }
    session.terminalWaiters = [];
  }

  private log(level: keyof RuntimeLogger, eventName: string, payload: Record<string, unknown>): void {
    this.logger?.[level](eventName, payload);
  }
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readStopReason(result: unknown): string | undefined {
  const record = readRecord(result);
  return typeof record?.["stopReason"] === "string" ? record["stopReason"] : undefined;
}

function event(
  runId: string,
  sequence: number,
  type: SwitchyardEvent["type"],
  payload: Record<string, unknown>
): SwitchyardEvent {
  return {
    id: `event_${crypto.randomUUID()}`,
    type,
    runId,
    sequence,
    payload,
    createdAt: new Date().toISOString()
  };
}

function eventForFailure(runId: string, sequence: number, error: string): SwitchyardEvent {
  return event(runId, sequence, "run.failed", {
    status: "failed",
    error
  });
}

function eventForStatus(runId: string, sequence: number, status: string): SwitchyardEvent {
  return event(runId, sequence, "runtime.status", { status });
}

function mapPromptError(runId: string, sequence: number, error: unknown): SwitchyardEvent {
  if (error instanceof AcpResponseError) {
    return eventForFailure(runId, sequence, "acp_prompt_error");
  }
  if (error instanceof AcpProtocolError) {
    return eventForFailure(runId, sequence, error.reasonCode);
  }
  return eventForFailure(runId, sequence, "acp_prompt_error");
}

function mapPromptStopReason(runId: string, sequence: number, stopReason: string | undefined): SwitchyardEvent {
  if (stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "max_turn_requests") {
    return event(runId, sequence, "run.completed", {
      status: "completed",
      stopReason
    });
  }
  if (stopReason === "cancelled") {
    return event(runId, sequence, "run.cancelled", {
      status: "cancelled",
      stopReason
    });
  }
  if (stopReason === "refusal") {
    return eventForFailure(runId, sequence, "acp_refusal");
  }
  return eventForFailure(runId, sequence, "acp_unknown_stop_reason");
}
