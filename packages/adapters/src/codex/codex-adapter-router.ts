import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import {
  AdapterProtocolError,
  type RuntimeAdapter,
  type RuntimeAdapterCheck,
  type RuntimeAdapterManifest,
  type RuntimeStartResult
} from "@switchyard/core";
import { CODEX_INTERACTIVE_RUNTIME_MODE_SLUG } from "./codex-interactive-session-factory.js";

const CODEX_EXEC_JSON_RUNTIME_MODE_SLUG = "codex.exec_json";

export interface CodexAdapterRouterOptions {
  execAdapter: RuntimeAdapter;
  interactiveAdapter: RuntimeAdapter;
}

export class CodexAdapterRouter implements RuntimeAdapter {
  readonly id = "codex";
  readonly manifest: RuntimeAdapterManifest;

  private readonly sessionModeById = new Map<string, string>();

  constructor(private readonly options: CodexAdapterRouterOptions) {
    this.manifest = options.execAdapter.manifest;
  }

  async check(config?: Record<string, unknown>): Promise<RuntimeAdapterCheck> {
    const mode = typeof config?.["runtimeMode"] === "string" ? config["runtimeMode"] : CODEX_EXEC_JSON_RUNTIME_MODE_SLUG;
    return await this.adapterForMode(mode).check(config);
  }

  async start(request: Record<string, unknown>): Promise<RuntimeStartResult> {
    const mode = typeof request["runtimeMode"] === "string" ? request["runtimeMode"] : CODEX_EXEC_JSON_RUNTIME_MODE_SLUG;
    const adapter = this.adapterForMode(mode);
    const result = await adapter.start(request);
    this.sessionModeById.set(result.sessionId, mode);
    return result;
  }

  async send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void> {
    const adapter = this.adapterForSession(session);
    await adapter.send(session, input);
  }

  async cancel(session: Record<string, unknown>): Promise<void> {
    const adapter = this.adapterForSession(session);
    await adapter.cancel(session);
  }

  async *events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    const adapter = this.adapterForSession(session);
    yield* adapter.events(session);
  }

  async tools(session: Record<string, unknown>): Promise<string[]> {
    const adapter = this.adapterForSession(session);
    return await adapter.tools(session);
  }

  async artifacts(session: Record<string, unknown>): Promise<Artifact[]> {
    const adapter = this.adapterForSession(session);
    return await adapter.artifacts(session);
  }

  private adapterForSession(session: Record<string, unknown>): RuntimeAdapter {
    const mode = this.resolveSessionMode(session);
    return this.adapterForMode(mode);
  }

  private resolveSessionMode(session: Record<string, unknown>): string {
    const runtimeMode = typeof session["runtimeMode"] === "string" ? session["runtimeMode"] : undefined;
    if (runtimeMode) {
      return runtimeMode;
    }
    const sessionId = typeof session["sessionId"] === "string" ? session["sessionId"] : undefined;
    if (sessionId) {
      const known = this.sessionModeById.get(sessionId);
      if (known) {
        return known;
      }
    }
    throw new AdapterProtocolError("Unsupported Codex runtime mode", {
      reasonCode: "codex_runtime_mode_unsupported"
    });
  }

  private adapterForMode(mode: string): RuntimeAdapter {
    if (mode === CODEX_EXEC_JSON_RUNTIME_MODE_SLUG) {
      return this.options.execAdapter;
    }
    if (mode === CODEX_INTERACTIVE_RUNTIME_MODE_SLUG) {
      return this.options.interactiveAdapter;
    }
    throw new AdapterProtocolError("Unsupported Codex runtime mode", {
      reasonCode: "codex_runtime_mode_unsupported"
    });
  }
}
