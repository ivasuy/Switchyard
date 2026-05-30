import type { Artifact, Run, RuntimeSession, RunStatus, SwitchyardEvent } from "@switchyard/contracts";
import { AdapterProtocolError } from "../errors.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { StoredArtifactContent } from "../ports/artifact-content-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { RuntimeAdapter } from "../ports/runtime-adapter.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";
import type { SessionStore } from "../ports/session-store.js";
import type { EventBus } from "./event-bus.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { approvalTypeSchema, type ApprovalType } from "@switchyard/contracts";
import { redactSecrets } from "./local-policy-gate.js";

const MAX_RUNTIME_INPUT_BYTES = 64 * 1024;
const MAX_SESSION_STATE_PATCH_BYTES = 16 * 1024;
const SESSION_STATE_SECRET_KEY_PATTERN = /(token|apiKey|authorization|password|secret)/i;

interface RuntimeApprovalBridge {
  create(input: { runId: string; approvalType: ApprovalType; payload: Record<string, unknown> }): Promise<void>;
}

export interface RuntimeRunnerDependencies {
  runs: RunStore;
  events: EventStore;
  sessions: SessionStore;
  adapters: Map<string, RuntimeAdapter>;
  artifacts?: ArtifactStore;
  eventBus?: EventBus;
  logger?: RuntimeLogger | undefined;
  artifactContent?: {
    writeText(path: string, content: string): Promise<string | StoredArtifactContent>;
  };
  runtimeApprovals?: RuntimeApprovalBridge;
}

export class RuntimeRunnerService {
  private readonly persistedArtifactKeys = new Set<string>();

  constructor(private readonly deps: RuntimeRunnerDependencies) {}

  async start(run: Run): Promise<Run> {
    const adapter = this.deps.adapters.get(run.runtime);
    if (!adapter) {
      throw new Error(`Runtime adapter not found: ${run.runtime}`);
    }

    let sequence = (await this.deps.events.listByRun(run.id)).length;
    const started: Run = {
      ...run,
      status: "running",
      startedAt: new Date().toISOString()
    };
    await this.deps.runs.update(started);
    await this.appendAndPublish(this.eventForRun(started, "run.started", sequence++, {}));
    this.log("info", "run.started", {
      runId: started.id,
      runtime: started.runtime,
      provider: started.provider,
      model: started.model,
      timeoutSeconds: started.timeoutSeconds
    });

    let latest = started;
    let session: RuntimeSession | undefined;
    let terminalized = false;
    const deadlineMs = Date.now() + started.timeoutSeconds * 1000;

    try {
      const startResult = await adapter.start({
        runId: started.id,
        runtime: started.runtime,
        runtimeMode: started.runtimeMode,
        provider: started.provider,
        model: started.model,
        cwd: started.cwd,
        task: started.task,
        metadata: started.metadata
      });

      const createdAt = new Date().toISOString();
      session = {
        id: startResult.sessionId,
        runId: started.id,
        runtime: started.runtime,
        provider: started.provider,
        model: started.model,
        runtimeMode: started.runtimeMode,
        protocol: started.adapterType,
        status: "active",
        state: {},
        createdAt
      };
      if (startResult.externalSessionKey) {
        session = { ...session, externalSessionKey: startResult.externalSessionKey };
      }
      if (startResult.processId) {
        session = { ...session, processId: startResult.processId };
      }
      await this.deps.sessions.create(session);
      this.log("info", "runtime.session.started", {
        runId: started.id,
        sessionId: session.id,
        runtime: started.runtime,
        processId: session.processId
      });

      const adapterSession = { ...startResult, runId: started.id };
      const iterator = adapter.events(adapterSession)[Symbol.asyncIterator]();
      while (true) {
        const next = await this.nextAdapterEvent(iterator.next(), deadlineMs);
        if (next === "timeout") {
          void iterator.return?.();
          latest = await this.timeoutRun(started, sequence++, session, adapter);
          terminalized = true;
          if (this.deps.artifacts && session) {
            const artifactSequence = { value: sequence };
            try {
              await this.persistArtifacts(adapter, session, started, latest, artifactSequence);
            } finally {
              sequence = artifactSequence.value;
            }
          }
          break;
        }
        if (next.done) {
          break;
        }
        const event = next.value;
        if (await this.isCancelled(started.id)) {
          break;
        }

        const normalized = this.normalizeEvent(event, started.id, sequence++);
        this.logEvent(normalized);

        if (!session) {
          throw new AdapterProtocolError("Runtime session is missing for this run.", {
            reasonCode: "runtime_session_missing"
          });
        }

        let effectiveEvent = normalized;
        if (effectiveEvent.type === "runtime.status") {
          const patchResult = await this.applySessionStatePatchIfPresent(started.id, session, effectiveEvent);
          session = patchResult.session;
          if (patchResult.reasonCode) {
            effectiveEvent = this.runtimeFailedEvent(started.id, effectiveEvent.sequence, patchResult.reasonCode);
          }
        }

        if (effectiveEvent.type !== "run.completed" && effectiveEvent.type !== "run.failed" && effectiveEvent.type !== "run.cancelled") {
          const statusResult = await this.applyWaitingStatusTransition(started.id, session, effectiveEvent);
          latest = statusResult.run ?? latest;
          session = statusResult.session;
        }

        if (effectiveEvent.type === "approval.requested") {
          const approvalResult = await this.handleRuntimeApproval(started.id, session, effectiveEvent);
          if (approvalResult.reasonCode) {
            effectiveEvent = this.runtimeFailedEvent(started.id, effectiveEvent.sequence, approvalResult.reasonCode);
          } else {
            latest = approvalResult.run ?? latest;
            session = approvalResult.session ?? session;
            continue;
          }
        }

        if (
          effectiveEvent.type === "run.completed" ||
          effectiveEvent.type === "run.failed" ||
          effectiveEvent.type === "run.cancelled"
        ) {
          const terminalSequence = sequence - 1;
          const terminal = await this.terminalizeRunFromAdapterEvent(started, effectiveEvent, terminalSequence, session);
          if (!terminal) {
            break;
          }
          latest = terminal;
          terminalized = true;
          const sessionStatus: RuntimeSession["status"] =
            effectiveEvent.type === "run.completed"
              ? "completed"
              : effectiveEvent.type === "run.cancelled"
                ? "cancelled"
                : "failed";
          session = {
            ...session,
            status: sessionStatus,
            updatedAt: terminal.endedAt
          };

          if (this.deps.artifacts && session) {
            const artifactSequence = { value: sequence };
            try {
              await this.persistArtifacts(
                this.deps.adapters.get(started.runtime),
                session,
                started,
                latest,
                artifactSequence,
                effectiveEvent.type === "run.cancelled"
              );
              sequence = artifactSequence.value;
            } catch (error) {
              sequence = artifactSequence.value;
              throw error;
            }
          }
          break;
        } else {
          await this.appendAndPublish(effectiveEvent);
        }
      }

      if (await this.isCancelled(started.id)) {
        const finalRun = await this.deps.runs.get(started.id);
        return finalRun ?? latest;
      }

      if (!terminalized && this.deps.artifacts && session) {
        const artifactSequence = { value: sequence };
        try {
          await this.persistArtifacts(
            this.deps.adapters.get(started.runtime),
            session,
            started,
            latest,
            artifactSequence
          );
        } finally {
          sequence = artifactSequence.value;
        }
      }

      return latest;
    } catch (error) {
      return this.failRun(started, error, sequence, session);
    }
  }

  async sendInput(runId: string, input: Record<string, unknown>): Promise<void> {
    const run = await this.requireRun(runId);
    if (this.isTerminal(run.status)) {
      throw new AdapterProtocolError("Runtime input is only supported for active runs.", {
        reasonCode: "runtime_input_not_active"
      });
    }
    const adapter = this.requireAdapter(run.runtime);
    const session = await this.deps.sessions.getByRunId(runId);
    if (!session) {
      throw new AdapterProtocolError("Runtime session is missing for this run.", {
        reasonCode: "runtime_session_missing"
      });
    }

    const text = input["text"];
    if (typeof text === "string") {
      if (text.trim().length === 0) {
        throw new AdapterProtocolError("Runtime input text must be non-empty.", {
          reasonCode: "runtime_input_empty"
        });
      }
      if (Buffer.byteLength(text, "utf8") > MAX_RUNTIME_INPUT_BYTES) {
        throw new AdapterProtocolError("Runtime input text exceeds the 64 KiB limit.", {
          reasonCode: "runtime_input_too_large"
        });
      }
    }

    await adapter.send(this.adapterSession(session), input);
  }

  async cancel(runId: string): Promise<Run> {
    const run = await this.requireRun(runId);
    if (this.isTerminal(run.status)) {
      return run;
    }
    const adapter = this.requireAdapter(run.runtime);
    const session = await this.requireSession(runId);

    await adapter.cancel(this.adapterSession(session));

    const currentRun = await this.requireRun(runId);
    if (this.isTerminal(currentRun.status)) {
      return currentRun;
    }

    const cancelledAt = new Date().toISOString();
    const cancelledRun: Run = {
      ...currentRun,
      status: "cancelled",
      endedAt: cancelledAt
    };
    const cancelledSession: RuntimeSession = {
      ...session,
      status: "cancelled",
      updatedAt: cancelledAt
    };
    await this.deps.runs.update(cancelledRun);
    await this.deps.sessions.update(cancelledSession);
    let sequence = (await this.deps.events.listByRun(runId)).length;
    await this.appendAndPublish(this.eventForRun(
      cancelledRun,
      "run.cancelled",
      sequence++,
      { status: "cancelled" }
    ));

    if (this.deps.artifacts) {
      const artifactSequence = { value: sequence };
      try {
        await this.persistArtifacts(
          adapter,
          cancelledSession,
          cancelledRun,
          cancelledRun,
          artifactSequence,
          true
        );
      } catch (error) {
        this.log("warn", "cancel.artifact_persistence_failed", {
          runId,
          error: this.errorPayload(error)
        });
      }
    }

    return cancelledRun;
  }

  private async failRun(
    templateRun: Run,
    error: unknown,
    sequence: number,
    session?: RuntimeSession
  ): Promise<Run> {
    const currentRun = await this.deps.runs.get(templateRun.id);
    if (!currentRun || currentRun.status === "cancelled") {
      return currentRun ?? templateRun;
    }
    if (this.isTerminal(currentRun.status)) {
      return currentRun;
    }

    const failed: Run = {
      ...templateRun,
      status: "failed",
      endedAt: new Date().toISOString()
    };
    await this.deps.runs.update(failed);
    if (session) {
      await this.deps.sessions.update({
        ...session,
        status: "failed",
        updatedAt: new Date().toISOString()
      });
    }

    await this.appendAndPublish(this.eventForRun(
      failed,
      "run.failed",
      sequence,
      {
        status: "failed",
        error: this.errorPayload(error)
      }
    ));
    this.log("error", "run.failed", {
      runId: failed.id,
      error: this.errorPayload(error)
    });

    return failed;
  }

  private async timeoutRun(
    templateRun: Run,
    sequence: number,
    session: RuntimeSession,
    adapter: RuntimeAdapter
  ): Promise<Run> {
    const currentRun = await this.deps.runs.get(templateRun.id);
    if (!currentRun || this.isTerminal(currentRun.status)) {
      return currentRun ?? templateRun;
    }

    try {
      await adapter.cancel(this.adapterSession(session));
    } catch (error) {
      this.log("warn", "runtime.cancel_after_timeout_failed", {
        runId: templateRun.id,
        error: this.errorPayload(error)
      });
    }

    const timedOutAt = new Date().toISOString();
    const timedOut: Run = {
      ...templateRun,
      status: "timeout",
      endedAt: timedOutAt
    };
    const timedOutSession: RuntimeSession = {
      ...session,
      status: "failed",
      updatedAt: timedOutAt
    };

    await this.deps.runs.update(timedOut);
    await this.deps.sessions.update(timedOutSession);
    await this.appendAndPublish(this.eventForRun(
      timedOut,
      "run.failed",
      sequence,
      {
        status: "timeout",
        error: "runtime_timeout",
        timeoutSeconds: templateRun.timeoutSeconds
      }
    ));
    this.log("warn", "run.timeout", {
      runId: timedOut.id,
      runtime: timedOut.runtime,
      timeoutSeconds: timedOut.timeoutSeconds
    });

    return timedOut;
  }

  private async persistArtifacts(
    adapter: RuntimeAdapter | undefined,
    session: RuntimeSession,
    templateRun: Run,
    baseRun: Run,
    sequence: { value: number },
    allowCancelledRun = false
  ): Promise<void> {
    if (!this.deps.artifacts || !adapter) {
      return;
    }

    const adapterArtifacts = await adapter.artifacts(this.adapterSession(session));
    const preparedArtifacts: Array<Artifact> = [];

    for (const artifact of adapterArtifacts) {
      if (!allowCancelledRun && await this.isCancelled(baseRun.id)) {
        return;
      }

      const safePath = this.normalizeArtifactPath(artifact.path);
      const content = typeof artifact.metadata["content"] === "string" ? artifact.metadata["content"] : undefined;
      const hasContent = content !== undefined;
      const metadata = { ...artifact.metadata };
      delete metadata.content;

      let storedPath = safePath;
      let contentStored = false;
      if (hasContent && this.deps.artifactContent) {
        const stored = await this.deps.artifactContent.writeText(safePath, content);
        if (typeof stored === "string") {
          storedPath = stored;
        } else {
          storedPath = stored.path;
          metadata.storageBackend = stored.storageBackend;
          if (stored.objectKey) metadata.objectKey = stored.objectKey;
          metadata.sizeBytes = stored.sizeBytes;
          metadata.sha256 = stored.sha256;
          metadata.contentType = stored.contentType;
        }
        contentStored = true;
      }
      if (hasContent) {
        metadata.contentStored = contentStored;
      }

      preparedArtifacts.push({
        ...artifact,
        path: storedPath,
        id: this.uniqueArtifactId(artifact.id),
        runId: baseRun.id,
        provider: artifact.provider ?? templateRun.provider,
        model: artifact.model ?? templateRun.model,
        metadata,
        createdAt: artifact.createdAt ?? new Date().toISOString()
      });
    }

    for (const prepared of preparedArtifacts) {
      if (!allowCancelledRun && await this.isCancelled(baseRun.id)) {
        return;
      }

      const artifactKey = `${baseRun.id}:${prepared.type}:${prepared.path}`;
      if (this.persistedArtifactKeys.has(artifactKey)) {
        continue;
      }
      const existing = await this.deps.artifacts.listByRun(baseRun.id);
      if (existing.some((artifact) => `${baseRun.id}:${artifact.type}:${artifact.path}` === artifactKey)) {
        this.persistedArtifactKeys.add(artifactKey);
        continue;
      }

      this.persistedArtifactKeys.add(artifactKey);
      let storedArtifact: Artifact;
      try {
        storedArtifact = await this.deps.artifacts.create(prepared);
      } catch (error) {
        this.persistedArtifactKeys.delete(artifactKey);
        throw error;
      }
      const artifactEvent = this.eventForRun(
        templateRun,
        "artifact.created",
        sequence.value,
        {
          artifactId: storedArtifact.id,
          path: storedArtifact.path,
          type: storedArtifact.type
        }
      );
      sequence.value += 1;
      await this.appendAndPublish(artifactEvent);
    }
  }

  private async terminalizeRunFromAdapterEvent(
    templateRun: Run,
    event: SwitchyardEvent,
    sequence: number,
    session: RuntimeSession
  ): Promise<Run | undefined> {
    const currentRun = await this.deps.runs.get(templateRun.id);
    if (!currentRun || this.isTerminal(currentRun.status)) {
      return undefined;
    }

    const terminalStatus: RunStatus =
      event.type === "run.completed"
        ? "completed"
        : event.type === "run.cancelled"
          ? "cancelled"
          : "failed";
    const terminal: Run = {
      ...templateRun,
      status: terminalStatus,
      endedAt: new Date().toISOString()
    };

    const terminalSession: RuntimeSession = {
      ...session,
      status: terminalStatus,
      updatedAt: terminal.endedAt
    };

    await this.deps.runs.update(terminal);
    await this.deps.sessions.update(terminalSession);
    await this.appendAndPublish(this.eventForRun(
      terminal,
      event.type,
      sequence,
      event.payload
    ));

    return terminal;
  }

  private async isCancelled(runId: string): Promise<boolean> {
    const run = await this.deps.runs.get(runId);
    return run?.status === "cancelled";
  }

  private isTerminal(status: RunStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled" || status === "timeout";
  }

  private uniqueArtifactId(id: string): string {
    if (id.startsWith("artifact_")) {
      return `${id}_${crypto.randomUUID()}`;
    }
    return `artifact_${crypto.randomUUID()}`;
  }

  private errorPayload(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private async nextAdapterEvent(
    nextPromise: Promise<IteratorResult<SwitchyardEvent>>,
    deadlineMs: number
  ): Promise<IteratorResult<SwitchyardEvent> | "timeout"> {
    const remainingMs = Math.max(0, deadlineMs - Date.now());
    if (remainingMs === 0) {
      return "timeout";
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), remainingMs);
    });

    try {
      return await Promise.race([nextPromise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private runtimeFailedEvent(runId: string, sequence: number, reasonCode: string): SwitchyardEvent {
    return {
      id: `event_${crypto.randomUUID()}`,
      type: "run.failed",
      runId,
      sequence,
      payload: {
        status: "failed",
        reasonCode
      },
      createdAt: new Date().toISOString()
    };
  }

  private async applyWaitingStatusTransition(
    runId: string,
    session: RuntimeSession,
    event: SwitchyardEvent
  ): Promise<{ run?: Run; session: RuntimeSession }> {
    if (event.type === "runtime.status") {
      const status = typeof event.payload["status"] === "string" ? event.payload["status"] : undefined;
      if (status === "waiting_for_input" || status === "waiting_for_approval") {
        const updated = await this.updateRunAndSessionStatus(runId, status, session);
        this.log("info", "runtime.status.waiting", { runId, status });
        return updated;
      }
      if (status === "running" || status === "resumed") {
        const updated = await this.resumeWaitingRunIfNeeded(runId, session);
        return updated;
      }
      return { session };
    }

    if (event.type === "runtime.output") {
      return await this.resumeWaitingRunIfNeeded(runId, session);
    }

    return { session };
  }

  private async resumeWaitingRunIfNeeded(
    runId: string,
    session: RuntimeSession
  ): Promise<{ run?: Run; session: RuntimeSession }> {
    const currentRun = await this.deps.runs.get(runId);
    if (!currentRun || this.isTerminal(currentRun.status)) {
      return { session };
    }
    if (currentRun.status !== "waiting_for_input" && currentRun.status !== "waiting_for_approval") {
      return { session };
    }
    return await this.updateRunAndSessionStatus(runId, "running", session);
  }

  private async updateRunAndSessionStatus(
    runId: string,
    status: "running" | "waiting_for_input" | "waiting_for_approval",
    session: RuntimeSession
  ): Promise<{ run?: Run; session: RuntimeSession }> {
    const currentRun = await this.deps.runs.get(runId);
    if (!currentRun || this.isTerminal(currentRun.status) || currentRun.status === status) {
      return { session };
    }
    const updatedRun: Run = { ...currentRun, status };
    const updatedSession: RuntimeSession = {
      ...session,
      status: status === "running" ? "active" : status,
      updatedAt: new Date().toISOString()
    };
    await this.deps.runs.update(updatedRun);
    await this.deps.sessions.update(updatedSession);
    return { run: updatedRun, session: updatedSession };
  }

  private async applySessionStatePatchIfPresent(
    runId: string,
    session: RuntimeSession,
    event: SwitchyardEvent
  ): Promise<{ session: RuntimeSession; reasonCode?: string }> {
    const rawPatch = event.payload["sessionStatePatch"];
    if (rawPatch === undefined || rawPatch === null) {
      return { session };
    }
    if (!isPlainObject(rawPatch)) {
      this.log("warn", "runtime.session_state_rejected", { runId, reasonCode: "session_state_patch_rejected" });
      return { session, reasonCode: "session_state_patch_rejected" };
    }
    if (Object.keys(rawPatch).length === 0) {
      return { session };
    }
    if (!isStatePatchValueSafe(rawPatch) || hasDisallowedSecretKey(rawPatch)) {
      this.log("warn", "runtime.session_state_rejected", { runId, reasonCode: "session_state_patch_rejected" });
      return { session, reasonCode: "session_state_patch_rejected" };
    }
    const serialized = JSON.stringify(rawPatch);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_STATE_PATCH_BYTES) {
      this.log("warn", "runtime.session_state_rejected", { runId, reasonCode: "session_state_patch_too_large" });
      return { session, reasonCode: "session_state_patch_too_large" };
    }

    const redactedPatch = redactSecrets(rawPatch);
    const nextState = {
      ...session.state,
      ...redactedPatch
    };
    const updated: RuntimeSession = {
      ...session,
      state: nextState,
      updatedAt: new Date().toISOString()
    };

    if (!session.externalSessionKey) {
      const discoveredKey = this.selectExternalSessionKey(redactedPatch);
      if (discoveredKey) {
        updated.externalSessionKey = discoveredKey;
      }
    }

    await this.deps.sessions.update(updated);
    this.log("info", "runtime.session_state.updated", { runId, sessionId: session.id });
    return { session: updated };
  }

  private selectExternalSessionKey(patch: Record<string, unknown>): string | undefined {
    const claude = patch["claudeSessionId"];
    if (typeof claude === "string" && claude.trim().length > 0) {
      return claude.trim();
    }
    const codex = patch["codexThreadId"];
    if (typeof codex === "string" && codex.trim().length > 0) {
      return codex.trim();
    }
    return undefined;
  }

  private async handleRuntimeApproval(
    runId: string,
    session: RuntimeSession,
    event: SwitchyardEvent
  ): Promise<{ run?: Run; session?: RuntimeSession; reasonCode?: string }> {
    const token = event.payload["runtimeApprovalToken"];
    if (typeof token !== "string" || token.trim().length === 0) {
      return { reasonCode: "runtime_approval_token_missing" };
    }
    if (!this.deps.runtimeApprovals) {
      return { reasonCode: "runtime_approval_bridge_unconfigured" };
    }
    const rawApprovalType = event.payload["approvalType"];
    let approvalType: ApprovalType = "before_external_message";
    if (typeof rawApprovalType === "string") {
      try {
        approvalType = approvalTypeSchema.parse(rawApprovalType);
      } catch {
        return { reasonCode: "runtime_approval_type_invalid" };
      }
    }

    await this.deps.runtimeApprovals.create({
      runId,
      approvalType,
      payload: redactSecrets({
        ...event.payload
      })
    });
    this.log("info", "runtime.approval.requested", { runId, approvalType });
    return await this.updateRunAndSessionStatus(runId, "waiting_for_approval", session);
  }

  private logEvent(event: SwitchyardEvent): void {
    if (event.type === "runtime.output") {
      const text = typeof event.payload["text"] === "string" ? event.payload["text"] : undefined;
      this.log("info", "runtime.output", {
        runId: event.runId,
        sequence: event.sequence,
        text: text ? this.truncate(text, 120) : undefined
      });
      return;
    }
    this.log("info", event.type, {
      runId: event.runId,
      sequence: event.sequence,
      status: event.payload["status"],
      error: event.payload["error"]
    });
  }

  private log(level: keyof RuntimeLogger, event: string, details?: Record<string, unknown>): void {
    this.deps.logger?.[level](event, details);
  }

  private truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
  }

  private eventForRun(run: Run, type: SwitchyardEvent["type"], sequence: number, payload: Record<string, unknown>): SwitchyardEvent {
    return {
      id: `event_${crypto.randomUUID()}`,
      type,
      runId: run.id,
      sequence,
      payload,
      createdAt: new Date().toISOString()
    };
  }

  private async appendAndPublish(event: SwitchyardEvent): Promise<void> {
    await this.deps.events.append(event);
    try {
      await this.deps.eventBus?.publish(event);
    } catch {
      // Event bus should not prevent runtime execution flow; launchers may have best-effort listeners.
    }
  }

  private normalizeEvent(event: SwitchyardEvent, runId: string, sequence: number): SwitchyardEvent {
    return {
      ...event,
      id: `event_${crypto.randomUUID()}`,
      runId,
      sequence
    };
  }

  private requireAdapter(runtime: string): RuntimeAdapter {
    const adapter = this.deps.adapters.get(runtime);
    if (!adapter) {
      throw new Error(`Runtime adapter not found: ${runtime}`);
    }
    return adapter;
  }

  private async requireRun(runId: string): Promise<Run> {
    const run = await this.deps.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  private async requireSession(runId: string): Promise<RuntimeSession> {
    const session = await this.deps.sessions.getByRunId(runId);
    if (!session) {
      throw new Error(`Runtime session not found for run: ${runId}`);
    }
    return session;
  }

  private normalizeArtifactPath(path: string): string {
    if (
      /^[A-Za-z]:/.test(path) ||
      path.startsWith("//") ||
      path.startsWith("\\\\") ||
      isAbsolute(path) ||
      path.includes("\\")
    ) {
      throw new Error("Artifact path escapes root");
    }

    const target = resolve(path);
    const rel = relative(process.cwd(), target);
    const segments = rel.split(sep);

    if (rel === "" || rel === "." || segments.includes("..")) {
      throw new Error("Artifact path escapes root");
    }

    return rel.replaceAll("\\", "/");
  }

  private adapterSession(session: RuntimeSession): Record<string, unknown> {
    return {
      sessionId: session.id,
      runId: session.runId,
      runtime: session.runtime,
      provider: session.provider,
      model: session.model,
      protocol: session.protocol,
      externalSessionKey: session.externalSessionKey,
      processId: session.processId,
      state: session.state
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStatePatchValueSafe(value: unknown): boolean {
  if (typeof value === "function" || typeof value === "symbol") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isStatePatchValueSafe(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every((entry) => isStatePatchValueSafe(entry));
  }
  return true;
}

function hasDisallowedSecretKey(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasDisallowedSecretKey(entry));
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SESSION_STATE_SECRET_KEY_PATTERN.test(key)) {
      return true;
    }
    if (hasDisallowedSecretKey(entry)) {
      return true;
    }
  }
  return false;
}
