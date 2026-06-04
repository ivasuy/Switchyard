import { createHash } from "node:crypto";
import type { Approval, ApprovalType, AuthContext, HostedRuntimeBridgeCommand, Run, RuntimeSession } from "@switchyard/contracts";
import { isHostedRuntimeBridgeSupportedMode } from "@switchyard/contracts";
import type { ApprovalStore } from "../ports/approval-store.js";
import type {
  CreateHostedRuntimeBridgeCommandInput,
  HostedRuntimeBridgeCommandStore
} from "../ports/hosted-runtime-bridge-command-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";
import type { SessionStore } from "../ports/session-store.js";

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>(["running", "waiting_for_input", "waiting_for_approval", "starting"]);
const TERMINAL_RUN_STATUSES = new Set<Run["status"]>(["completed", "failed", "cancelled", "timeout"]);
const DEFAULT_COMMAND_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 30_000;

type QuotaOutcome = "consumed" | "released" | "failed" | "expired";

class HostedRuntimeBridgeAdmissionLock {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

export class HostedRuntimeBridgeServiceError extends Error {
  readonly code: string;
  readonly reasonCode?: string;
  readonly details?: Array<{ path: string; issue: string }>;

  constructor(
    code: string,
    message: string,
    options: {
      reasonCode?: string;
      details?: Array<{ path: string; issue: string }>;
    } = {}
  ) {
    super(message);
    this.code = code;
    if (options.reasonCode !== undefined) {
      this.reasonCode = options.reasonCode;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export interface HostedRuntimeBridgeServiceDependencies {
  runs: RunStore;
  sessions: SessionStore;
  approvals: ApprovalStore;
  commands: HostedRuntimeBridgeCommandStore;
  runtimeRunner: Pick<{ sendInput(runId: string, input: Record<string, unknown>): Promise<void> }, "sendInput">;
  now?: () => string;
  defaultCommandTtlMs?: number;
  maxAttempts?: number;
  logger?: RuntimeLogger;
  preflight?: {
    authorizeRun?: (input: { runId: string; auth: AuthContext }) => Promise<void>;
    authorizeApproval?: (input: { approvalId: string; auth: AuthContext }) => Promise<void>;
    reserveBridgeQuota?: (input: {
      runId: string;
      operation: "input" | "approval_resolution";
      idempotencyKey: string;
      auth?: AuthContext;
    }) => Promise<{ hourlyReservationId?: string; activeReservationId?: string }>;
    finalizeBridgeQuota?: (input: {
      reservationId: string;
      outcome: QuotaOutcome;
      reasonCode?: string;
    }) => Promise<void>;
    reconcileBridgeQuotaFromPersistedCommands?: (input: {
      now: string;
      reasonCode: string;
    }) => Promise<void>;
    attachOwnership?: (input: {
      resourceType: "runtime_bridge_command" | "approval";
      resourceId: string;
      runId: string;
      auth: AuthContext;
    }) => Promise<void>;
    attachOwnershipFromRun?: (input: {
      resourceType: "approval";
      resourceId: string;
      runId: string;
    }) => Promise<void>;
    recordAudit?: (input: {
      eventType: string;
      decision: "allow" | "deny" | "error";
      reasonCode: string;
      runId?: string;
      approvalId?: string;
      commandId?: string;
      requestId?: string;
      payload?: Record<string, unknown>;
      auth?: AuthContext;
    }) => Promise<void>;
  };
  commandPayloads?: {
    put(input: { commandId: string; payload: Record<string, unknown> }): Promise<void>;
    get(commandId: string): Promise<Record<string, unknown> | undefined>;
    delete(commandId: string): Promise<void>;
  };
}

export class HostedRuntimeBridgeService {
  private readonly now: () => string;
  private readonly defaultCommandTtlMs: number;
  private readonly maxAttempts: number;
  private readonly locks = new HostedRuntimeBridgeAdmissionLock();

  constructor(private readonly deps: HostedRuntimeBridgeServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.defaultCommandTtlMs = deps.defaultCommandTtlMs ?? DEFAULT_COMMAND_TTL_MS;
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  async createInputCommand(input: {
    runId: string;
    body: unknown;
    auth?: AuthContext;
    requestId?: string;
    idempotencyKey?: string;
  }): Promise<{ accepted: true; commandId: string; duplicate: boolean }> {
    if (!isRecord(input.body)) {
      throw this.invalidInput("body.text", "required for hosted wrapper input");
    }

    const text = input.body["text"];
    if (typeof text !== "string") {
      throw this.invalidInput("body.text", "required for hosted wrapper input");
    }
    if (text.trim().length === 0) {
      throw this.protocolError("runtime_input_empty", "Runtime input text must be non-empty");
    }
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      throw this.protocolError("runtime_input_too_large", "Runtime input text exceeds the 64 KiB limit");
    }

    if (input.auth && this.deps.preflight?.authorizeRun) {
      await this.deps.preflight.authorizeRun({ runId: input.runId, auth: input.auth });
    }

    const run = await this.deps.runs.get(input.runId);
    if (!run) {
      await this.recordAudit({
        eventType: "hosted.runtime_bridge.admission",
        decision: "deny",
        reasonCode: "run_not_found",
        runId: input.runId,
        payload: { operation: "input" },
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.auth ? { auth: input.auth } : {})
      });
      throw new HostedRuntimeBridgeServiceError("run_not_found", `Run not found: ${input.runId}`);
    }

    this.requireBridgeAdmissionRunState(run, "input");
    const runtimeMode = readRuntimeMode(run);
    this.assertSupportedMode(runtimeMode, "input");

    const session = await this.deps.sessions.getByRunId(run.id);
    if (!session) {
      throw this.protocolError("hosted_runtime_bridge_session_missing", "Hosted runtime session is missing");
    }
    this.assertSessionActiveForInput(session);
    this.assertWrapperBridgeCapability(runtimeMode, session);

    const operation: HostedRuntimeBridgeCommand["operation"] = "input";
    const idempotencyKey =
      normalizeNonEmpty(input.idempotencyKey) ??
      deterministicIdempotencyKey(run.id, operation, {
        switchyardRunId: run.id,
        type: "input",
        text
      });

    const rawPayload = {
      switchyardRunId: run.id,
      idempotencyKey,
      type: "input",
      text
    };

    const payloadHash = payloadHashFor(rawPayload);
    const payloadBytes = payloadBytesFor(rawPayload);
    const redactedPayload = redactForStorage(operation, rawPayload, payloadBytes);

    const existing = await this.deps.commands.getByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw this.protocolError("hosted_runtime_bridge_payload_mismatch", "Runtime bridge payload mismatch for idempotency key");
      }
      return {
        accepted: true,
        commandId: existing.id,
        duplicate: true
      };
    }

    const reservations = await this.deps.preflight?.reserveBridgeQuota?.({
      runId: run.id,
      operation,
      idempotencyKey,
      ...(input.auth ? { auth: input.auth } : {})
    });

    try {
      const created = await this.deps.commands.create(this.createCommandInput({
        run,
        session,
        operation,
        idempotencyKey,
        payloadHash,
        payloadBytes,
        redactedPayload: withQuotaMetadata(redactedPayload, reservations),
        ...(input.auth ? { auth: input.auth } : {})
      }));

      if (created.duplicate) {
        await this.releaseReservations(reservations, "released", "hosted_runtime_bridge_duplicate");
        return {
          accepted: true,
          commandId: created.command.id,
          duplicate: true
        };
      }

      await this.persistWorkerPayloadOrFail(created.command, withCommandDispatchMetadata(created.command, rawPayload), reservations);
      await this.recordAudit({
        eventType: "hosted.runtime_bridge.admission",
        decision: "allow",
        reasonCode: "hosted_runtime_bridge_admitted",
        runId: run.id,
        commandId: created.command.id,
        payload: { operation, runtimeMode, redacted: true },
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.auth ? { auth: input.auth } : {})
      });

      return {
        accepted: true,
        commandId: created.command.id,
        duplicate: false
      };
    } catch (error) {
      await this.releaseReservations(reservations, "failed", "hosted_runtime_bridge_admission_failed");
      if (isPayloadMismatchError(error)) {
        throw this.protocolError("hosted_runtime_bridge_payload_mismatch", "Runtime bridge payload mismatch for idempotency key");
      }
      throw error;
    }
  }

  async resolveRuntimeApproval(input: {
    approvalId: string;
    decision: "approved" | "rejected";
    body?: Record<string, unknown>;
    auth?: AuthContext;
    requestId?: string;
    idempotencyKey?: string;
  }): Promise<{ approval: Approval; commandId: string; duplicate: boolean }> {
    if (input.auth && this.deps.preflight?.authorizeApproval) {
      await this.deps.preflight.authorizeApproval({ approvalId: input.approvalId, auth: input.auth });
    }

    return this.locks.withLock(`approval:${input.approvalId}`, async () => {
      const approval = await this.deps.approvals.get(input.approvalId);
      if (!approval) {
        throw new HostedRuntimeBridgeServiceError("approval_not_found", `Approval not found: ${input.approvalId}`);
      }

      const runtimeApprovalToken = typeof approval.payload["runtimeApprovalToken"] === "string"
        ? approval.payload["runtimeApprovalToken"]
        : undefined;
      if (!runtimeApprovalToken) {
        throw this.protocolError("hosted_runtime_bridge_operation_unsupported", "Approval is not runtime-bridge resolvable");
      }
      const runId = approval.runId;
      if (!runId) {
        throw this.protocolError("hosted_runtime_bridge_session_missing", "Runtime approval run is missing");
      }

      const run = await this.deps.runs.get(runId);
      if (!run) {
        throw new HostedRuntimeBridgeServiceError("run_not_found", `Run not found: ${runId}`);
      }
      this.requireBridgeAdmissionRunState(run, "approval_resolution");
      const runtimeMode = readRuntimeMode(run);
      this.assertSupportedMode(runtimeMode, "approval_resolution");

      const session = await this.deps.sessions.getByRunId(run.id);
      if (!session) {
        throw this.protocolError("hosted_runtime_bridge_session_missing", "Hosted runtime session is missing");
      }
      this.assertWrapperBridgeCapability(runtimeMode, session);

      const deadline = resolveDeadlineFromApproval(approval, this.defaultCommandTtlMs, this.now());
      if (Date.parse(deadline) <= Date.parse(this.now())) {
        await this.transitionApprovalIfPending(approval, "expired", "expired by Switchyard");
        throw this.protocolError("acp_permission_request_expired", "Runtime permission request expired");
      }

      const rawBody = isRecord(input.body) ? input.body : {};
      const answers = isRecord(rawBody["answers"]) ? rawBody["answers"] : undefined;
      const message = typeof rawBody["message"] === "string" && rawBody["message"].trim().length > 0
        ? rawBody["message"].trim()
        : `${input.decision} by hosted-api`;
      const rawPayload = {
        switchyardRunId: run.id,
        idempotencyKey:
          normalizeNonEmpty(input.idempotencyKey) ??
          deterministicIdempotencyKey(approval.id, "approval_resolution", {
            approvalId: approval.id,
            runtimeApprovalToken,
            decision: input.decision,
            message,
            ...(answers ? { answers } : {})
          }),
        type: "approval_resolution",
        approvalId: approval.id,
        runtimeApprovalToken,
        decision: input.decision,
        message,
        ...(answers ? { answers } : {})
      };

      const operation: HostedRuntimeBridgeCommand["operation"] = "approval_resolution";
      const idempotencyKey = String(rawPayload.idempotencyKey);
      const payloadHash = payloadHashFor(rawPayload);
      const payloadBytes = payloadBytesFor(rawPayload);
      const redactedPayload = redactForStorage(operation, rawPayload, payloadBytes);

      if (approval.status !== "pending") {
        const existing = await this.deps.commands.getByIdempotencyKey(idempotencyKey);
        if (existing && existing.approvalId === approval.id && existing.payloadHash === payloadHash) {
          return { approval, commandId: existing.id, duplicate: true };
        }
        throw new HostedRuntimeBridgeServiceError("approval_not_pending", `Approval is not pending: ${approval.id}`);
      }

      const existing = await this.deps.commands.getByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw this.protocolError("hosted_runtime_bridge_payload_mismatch", "Runtime bridge payload mismatch for idempotency key");
        }
        const transitioned = await this.transitionApprovalIfPending(approval, input.decision, message);
        if (!transitioned) {
          throw new HostedRuntimeBridgeServiceError("approval_not_pending", `Approval is not pending: ${approval.id}`);
        }
        return { approval: transitioned, commandId: existing.id, duplicate: true };
      }

      const reservations = await this.deps.preflight?.reserveBridgeQuota?.({
        runId: run.id,
        operation,
        idempotencyKey,
        ...(input.auth ? { auth: input.auth } : {})
      });

      try {
        const created = await this.deps.commands.create(this.createCommandInput({
          run,
          session,
          approvalId: approval.id,
          operation,
          idempotencyKey,
          payloadHash,
          payloadBytes,
          redactedPayload: withQuotaMetadata(redactedPayload, reservations),
          expiresAt: deadline,
          ...(input.auth ? { auth: input.auth } : {})
        }));

        if (created.duplicate) {
          await this.releaseReservations(reservations, "released", "hosted_runtime_bridge_duplicate");
          if (created.command.payloadHash !== payloadHash) {
            throw this.protocolError("hosted_runtime_bridge_payload_mismatch", "Runtime bridge payload mismatch for idempotency key");
          }
          const transitioned = await this.transitionApprovalIfPending(approval, input.decision, message);
          if (!transitioned) {
            throw new HostedRuntimeBridgeServiceError("approval_not_pending", `Approval is not pending: ${approval.id}`);
          }
          return { approval: transitioned, commandId: created.command.id, duplicate: true };
        }

        const transitioned = await this.transitionApprovalIfPending(approval, input.decision, message);
        if (!transitioned) {
          await this.deps.commands.fail({
            commandId: created.command.id,
            reasonCode: "approval_not_pending",
            retryable: false,
            now: this.now()
          });
          await this.releaseReservations(reservations, "released", "approval_not_pending");
          throw new HostedRuntimeBridgeServiceError("approval_not_pending", `Approval is not pending: ${approval.id}`);
        }

        await this.persistWorkerPayloadOrFail(created.command, withCommandDispatchMetadata(created.command, rawPayload), reservations);
        await this.recordAudit({
          eventType: "hosted.runtime_bridge.approval_resolved",
          decision: "allow",
          reasonCode: "hosted_runtime_bridge_admitted",
          runId: run.id,
          approvalId: approval.id,
          commandId: created.command.id,
          payload: { operation, decision: input.decision, runtimeMode, redacted: true },
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.auth ? { auth: input.auth } : {})
        });

        return {
          approval: transitioned,
          commandId: created.command.id,
          duplicate: false
        };
      } catch (error) {
        await this.releaseReservations(reservations, "failed", "hosted_runtime_bridge_admission_failed");
        if (isPayloadMismatchError(error)) {
          throw this.protocolError("hosted_runtime_bridge_payload_mismatch", "Runtime bridge payload mismatch for idempotency key");
        }
        throw error;
      }
    });
  }

  async createWorkerRuntimeApproval(input: {
    runId: string;
    approvalType: ApprovalType;
    payload: Record<string, unknown>;
    workerId: string;
    deadline: string;
  }): Promise<Approval> {
    const run = await this.deps.runs.get(input.runId);
    if (!run) {
      throw new HostedRuntimeBridgeServiceError("run_not_found", `Run not found: ${input.runId}`);
    }
    const createdAt = this.now();
    const approval: Approval = {
      id: `approval_${crypto.randomUUID()}`,
      runId: input.runId,
      approvalType: input.approvalType,
      status: "pending",
      payload: sanitizeApprovalPayload({
        ...input.payload,
        runtimeWorkerId: input.workerId,
        expiresAt: input.deadline
      }),
      createdAt
    };
    await this.deps.approvals.create(approval);
    if (this.deps.preflight?.attachOwnershipFromRun) {
      try {
        await this.deps.preflight.attachOwnershipFromRun({
          resourceType: "approval",
          resourceId: approval.id,
          runId: input.runId
        });
      } catch {
        const failed: Approval = {
          ...approval,
          status: "rejected",
          resolvedAt: this.now(),
          payload: sanitizeApprovalPayload({
            ...approval.payload,
            resolution: {
              decision: "rejected",
              message: "approval ownership attach failed"
            },
            reasonCode: "approval_ownership_attach_failed"
          })
        };
        await this.deps.approvals.update(failed);
        throw this.protocolError("approval_ownership_attach_failed", "Runtime approval ownership attach failed");
      }
    }
    return approval;
  }

  async claimAndApplyNext(input: { workerId: string; leaseMs?: number }): Promise<boolean> {
    const now = this.now();
    await this.deps.commands.expireStale({ now });
    await this.deps.preflight?.reconcileBridgeQuotaFromPersistedCommands?.({
      now,
      reasonCode: "hosted_runtime_bridge_command_expired"
    });
    const command = await this.deps.commands.claimNext({
      workerId: input.workerId,
      leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      now
    });
    if (!command) {
      return false;
    }
    this.log("info", "hosted.runtime_bridge.claimed", {
      commandId: command.id,
      runId: command.runId,
      runtimeMode: command.runtimeMode,
      operation: command.operation
    });

    if (Date.parse(command.expiresAt) <= Date.parse(now)) {
      await this.failClaimedCommand(command, input.workerId, "hosted_runtime_bridge_command_expired");
      return true;
    }

    const run = await this.deps.runs.get(command.runId);
    if (!run) {
      await this.failClaimedCommand(command, input.workerId, "hosted_runtime_session_missing");
      return true;
    }

    const session = await this.deps.sessions.getByRunId(run.id);
    if (!session) {
      await this.failClaimedCommand(command, input.workerId, "hosted_runtime_bridge_session_missing");
      await this.terminalizeRunForBridgeFailure(run, "hosted_runtime_session_missing");
      return true;
    }

    const owner = readSessionWorkerId(session);
    if (!owner || owner !== input.workerId) {
      await this.failClaimedCommand(command, input.workerId, "hosted_runtime_bridge_session_not_owned");
      await this.terminalizeRunForBridgeFailure(run, "hosted_runtime_session_lost");
      return true;
    }

    if (command.runtimeSessionId && command.runtimeSessionId !== session.id) {
      await this.failClaimedCommand(command, input.workerId, "hosted_runtime_bridge_payload_mismatch");
      await this.terminalizeRunForBridgeFailure(run, "hosted_runtime_session_state_incomplete");
      return true;
    }

    if (readRuntimeMode(run) !== command.runtimeMode || (session.runtimeMode ?? readRuntimeMode(run)) !== command.runtimeMode) {
      await this.failClaimedCommand(command, input.workerId, "hosted_runtime_bridge_payload_mismatch");
      await this.terminalizeRunForBridgeFailure(run, "hosted_runtime_session_state_incomplete");
      return true;
    }

    if (!this.isSessionRuntimeIdConsistent(session)) {
      await this.failClaimedCommand(command, input.workerId, "hosted_runtime_bridge_payload_mismatch");
      await this.terminalizeRunForBridgeFailure(run, "hosted_runtime_session_state_incomplete");
      return true;
    }

    try {
      this.assertWrapperBridgeCapability(command.runtimeMode, session);
    } catch (error) {
      const reasonCode = reasonCodeFromError(error) ?? "hosted_runtime_bridge_payload_mismatch";
      await this.failClaimedCommand(command, input.workerId, reasonCode);
      await this.terminalizeRunForBridgeFailure(run, "hosted_runtime_session_state_incomplete");
      return true;
    }

    if (command.operation === "approval_resolution") {
      const approvalReason = await this.validateApprovalResolutionCommand(command, run.id, now);
      if (approvalReason) {
        await this.failClaimedCommand(command, input.workerId, approvalReason);
        return true;
      }
    }

    const dispatchPayload = await this.loadWorkerDispatchPayload(command);
    if (!dispatchPayload) {
      await this.failClaimedCommand(command, input.workerId, "hosted_runtime_bridge_store_unavailable");
      return true;
    }
    const payloadReason = validateDispatchPayloadForCommand(command, dispatchPayload);
    if (payloadReason) {
      await this.failClaimedCommand(command, input.workerId, payloadReason);
      return true;
    }
    const recomputedHash = payloadHashFor(hashPayloadForCommand(command, dispatchPayload));
    if (recomputedHash !== command.payloadHash) {
      await this.failClaimedCommand(command, input.workerId, "hosted_runtime_bridge_payload_mismatch");
      return true;
    }

    try {
      await this.deps.runtimeRunner.sendInput(run.id, dispatchPayload);
      const completed = await this.deps.commands.complete({
        commandId: command.id,
        workerId: input.workerId,
        now: this.now()
      });
      if (!completed) {
        throw new HostedRuntimeBridgeServiceError(
          "adapter_protocol_failed",
          "Bridge completion compare-and-update failed",
          { reasonCode: "hosted_runtime_bridge_store_unavailable" }
        );
      }
      await this.finalizeCommandQuotaFromState(command, "consumed", "hosted_runtime_bridge_completed");
      await this.deps.commandPayloads?.delete(command.id);
      this.log("info", "hosted.runtime_bridge.completed", {
        commandId: command.id,
        runId: run.id,
        runtimeMode: command.runtimeMode,
        operation: command.operation
      });
      return true;
    } catch (error) {
      const reasonCode = reasonCodeFromError(error) ?? "hosted_runtime_bridge_worker_unavailable";
      await this.failClaimedCommand(command, input.workerId, reasonCode);
      await this.terminalizeRunForBridgeFailure(run, reasonCode);
      return true;
    }
  }

  async reconcileHostedRuntimeSessions(input: {
    workerId: string;
    now?: string;
  }): Promise<{ reconciled: number; failed: number }> {
    const now = input.now ?? this.now();
    const recovered = await this.deps.commands.recoverStaleClaims({
      now,
      nonIdempotentPolicy: "fail"
    });
    await this.deps.preflight?.reconcileBridgeQuotaFromPersistedCommands?.({
      now,
      reasonCode: "hosted_runtime_bridge_non_idempotent_retry_blocked"
    });

    let reconciled = recovered.recovered;
    let failed = recovered.failed;

    const active = await this.deps.runs.list({
      status: ["running", "waiting_for_input", "waiting_for_approval"],
      placement: ["hosted"],
      limit: 10_000
    });
    for (const run of active.runs) {
      const session = await this.deps.sessions.getByRunId(run.id);
      if (!session) {
        await this.terminalizeRunForBridgeFailure(run, "hosted_runtime_session_missing");
        failed += 1;
        continue;
      }
      const owner = readSessionWorkerId(session);
      if (!owner) {
        await this.terminalizeRunForBridgeFailure(run, "hosted_runtime_session_lost");
        failed += 1;
        continue;
      }
      if (owner !== input.workerId) {
        continue;
      }
      if (run.status === "waiting_for_approval") {
        await this.terminalizeRunForBridgeFailure(run, "hosted_runtime_session_lost");
        reconciled += 1;
      }
    }

    return { reconciled, failed };
  }

  async terminalizePendingRuntimeApprovalsForRun(input: {
    runId: string;
    reasonCode: string;
    terminalEvent: "run.cancelled" | "run.failed" | "run.timeout" | "daemon_restarted";
  }): Promise<{ expired: number; rejected: number }> {
    const listed = await this.deps.approvals.list({ runId: input.runId, status: "pending", limit: 1000 });
    let expired = 0;
    let rejected = 0;
    for (const approval of listed.approvals) {
      const runtimeApprovalToken = approval.payload["runtimeApprovalToken"];
      if (typeof runtimeApprovalToken !== "string") {
        continue;
      }
      const status: Approval["status"] = input.terminalEvent === "run.timeout" ? "expired" : "rejected";
      const transitioned = await this.transitionApprovalIfPending(approval, status, input.reasonCode);
      if (!transitioned) {
        continue;
      }
      if (status === "expired") {
        expired += 1;
      } else {
        rejected += 1;
      }
    }
    return { expired, rejected };
  }

  private createCommandInput(input: {
    run: Run;
    session: RuntimeSession;
    operation: HostedRuntimeBridgeCommand["operation"];
    idempotencyKey: string;
    payloadHash: string;
    payloadBytes: number;
    redactedPayload: HostedRuntimeBridgeCommand["redactedPayload"];
    approvalId?: string;
    expiresAt?: string;
    auth?: AuthContext;
  }): CreateHostedRuntimeBridgeCommandInput {
    const owner = ownershipFromAuth(input.auth);
    const created: CreateHostedRuntimeBridgeCommandInput = {
      runId: input.run.id,
      runtimeSessionId: input.session.id,
      runtimeMode: readRuntimeMode(input.run),
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.payloadHash,
      payloadBytes: input.payloadBytes,
      redactedPayload: input.redactedPayload,
      accountId: owner.accountId,
      tenantId: owner.tenantId,
      projectId: owner.projectId,
      userId: owner.userId,
      apiKeyId: owner.apiKeyId,
      maxAttempts: this.maxAttempts,
      expiresAt: input.expiresAt ?? new Date(Date.parse(this.now()) + this.defaultCommandTtlMs).toISOString(),
      now: this.now()
    };
    if (input.approvalId) {
      created.approvalId = input.approvalId;
    }
    return created;
  }

  private async transitionApprovalIfPending(
    approval: Approval,
    status: Approval["status"],
    message: string
  ): Promise<Approval | null> {
    if (approval.status !== "pending") {
      return null;
    }
    const next: Approval = {
      ...approval,
      status,
      resolvedAt: this.now(),
      payload: sanitizeApprovalPayload({
        ...approval.payload,
        resolution: { decision: status, message }
      })
    };
    return this.deps.approvals.updateIfStatus(approval.id, "pending", next);
  }

  private async validateApprovalResolutionCommand(
    command: HostedRuntimeBridgeCommand,
    runId: string,
    now: string
  ): Promise<string | undefined> {
    if (!command.approvalId) {
      return "approval_not_pending";
    }
    const approval = await this.deps.approvals.get(command.approvalId);
    if (!approval) {
      return "approval_not_pending";
    }
    if (approval.runId !== runId) {
      return "approval_not_pending";
    }
    if (approval.status === "pending") {
      return "approval_not_pending";
    }
    const runtimeApprovalToken = typeof approval.payload["runtimeApprovalToken"] === "string"
      ? approval.payload["runtimeApprovalToken"]
      : undefined;
    const commandToken = typeof command.redactedPayload["runtimeApprovalToken"] === "string"
      ? command.redactedPayload["runtimeApprovalToken"]
      : undefined;
    const commandTokenHash = typeof command.redactedPayload["runtimeApprovalTokenHash"] === "string"
      ? command.redactedPayload["runtimeApprovalTokenHash"]
      : undefined;
    if (
      !runtimeApprovalToken ||
      (
        commandToken
          ? runtimeApprovalToken !== commandToken
          : commandTokenHash !== secretHash(runtimeApprovalToken)
      )
    ) {
      return "approval_not_pending";
    }
    const expiresAt = approval.payload["expiresAt"];
    if (typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= Date.parse(now)) {
      return "acp_permission_request_expired";
    }
    return undefined;
  }

  private async failClaimedCommand(
    command: HostedRuntimeBridgeCommand,
    workerId: string,
    reasonCode: string
  ): Promise<void> {
    await this.deps.commands.fail({
      commandId: command.id,
      workerId,
      reasonCode,
      retryable: false,
      now: this.now()
    });
    await this.finalizeCommandQuotaFromState(command, "released", reasonCode);
    await this.deps.commandPayloads?.delete(command.id);
    this.log("warn", "hosted.runtime_bridge.failed", {
      commandId: command.id,
      runId: command.runId,
      runtimeMode: command.runtimeMode,
      operation: command.operation,
      reasonCode
    });
  }

  private async terminalizeRunForBridgeFailure(run: Run, reasonCode: string): Promise<void> {
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return;
    }
    const failed: Run = {
      ...run,
      status: "failed",
      endedAt: this.now(),
      metadata: {
        ...(isRecord(run.metadata) ? run.metadata : {}),
        reasonCode
      }
    };
    await this.deps.runs.update(failed);
    await this.terminalizePendingRuntimeApprovalsForRun({
      runId: run.id,
      reasonCode,
      terminalEvent: "daemon_restarted"
    });
    this.log("warn", "hosted.runtime_bridge.reconciled", {
      runId: run.id,
      runtimeMode: run.runtimeMode,
      reasonCode
    });
  }

  private async releaseReservations(
    reservations: { hourlyReservationId?: string; activeReservationId?: string } | undefined,
    outcome: QuotaOutcome,
    reasonCode: string
  ): Promise<void> {
    if (!reservations?.hourlyReservationId && !reservations?.activeReservationId) {
      return;
    }
    if (reservations.activeReservationId) {
      await this.deps.preflight?.finalizeBridgeQuota?.({
        reservationId: reservations.activeReservationId,
        outcome: outcome === "consumed" ? "released" : outcome,
        reasonCode
      });
    }
    if (reservations.hourlyReservationId) {
      await this.deps.preflight?.finalizeBridgeQuota?.({
        reservationId: reservations.hourlyReservationId,
        outcome: outcome === "released" ? "consumed" : outcome,
        reasonCode
      });
    }
  }

  private async finalizeCommandQuotaFromState(
    command: HostedRuntimeBridgeCommand,
    outcome: QuotaOutcome,
    reasonCode: string
  ): Promise<void> {
    await this.releaseReservations(reservationMetadataFromCommand(command), outcome, reasonCode);
  }

  private async persistWorkerPayloadOrFail(
    command: HostedRuntimeBridgeCommand,
    payload: Record<string, unknown>,
    reservations: { hourlyReservationId?: string; activeReservationId?: string } | undefined
  ): Promise<void> {
    if (!this.deps.commandPayloads) {
      return;
    }
    try {
      await this.deps.commandPayloads.put({ commandId: command.id, payload });
    } catch {
      await this.deps.commands.fail({
        commandId: command.id,
        reasonCode: "hosted_runtime_bridge_store_unavailable",
        retryable: false,
        now: this.now()
      });
      await this.releaseReservations(reservations, "failed", "hosted_runtime_bridge_store_unavailable");
      throw this.protocolError("hosted_runtime_bridge_store_unavailable", "Hosted runtime bridge payload store unavailable");
    }
  }

  private async loadWorkerDispatchPayload(
    command: HostedRuntimeBridgeCommand
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.deps.commandPayloads) {
      return undefined;
    }
    const payload = await this.deps.commandPayloads.get(command.id);
    if (!payload) {
      return undefined;
    }
    return withCommandDispatchMetadata(command, payload);
  }

  private assertWrapperBridgeCapability(runtimeMode: string, session: RuntimeSession): void {
    if (!isWrapperRuntimeMode(runtimeMode)) {
      return;
    }
    if (!isRecord(session.state) || session.state["hostedBridgeCapable"] !== true) {
      throw this.protocolError(wrapperCapabilityReasonCode(runtimeMode), "Hosted wrapper bridge capability is missing");
    }
  }

  private isSessionRuntimeIdConsistent(session: RuntimeSession): boolean {
    if (!isRecord(session.state)) {
      return true;
    }
    const hostedRuntimeSessionId = session.state["hostedRuntimeSessionId"];
    return (
      typeof hostedRuntimeSessionId !== "string" ||
      hostedRuntimeSessionId.trim().length === 0 ||
      hostedRuntimeSessionId.trim() === session.id
    );
  }

  private assertSupportedMode(runtimeMode: string, operation: HostedRuntimeBridgeCommand["operation"]): void {
    if (isHostedRuntimeBridgeSupportedMode(runtimeMode, operation)) {
      return;
    }
    throw this.protocolError(reasonForUnsupportedMode(runtimeMode, operation), "Hosted runtime bridge operation is unsupported");
  }

  private requireBridgeAdmissionRunState(run: Run, operation: HostedRuntimeBridgeCommand["operation"]): void {
    if (run.placement !== "hosted") {
      throw this.protocolError("hosted_runtime_bridge_operation_unsupported", "Runtime bridge is only available for hosted runs");
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw this.protocolError("runtime_input_not_active", "Run is not active");
    }
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      throw this.protocolError(operation === "input" ? "runtime_input_not_active" : "approval_not_pending", "Run is not active");
    }
  }

  private assertSessionActiveForInput(session: RuntimeSession): void {
    if (session.status === "completed" || session.status === "failed" || session.status === "cancelled") {
      throw this.protocolError("runtime_input_not_active", "Runtime session is not active");
    }
  }

  private protocolError(reasonCode: string, message: string): HostedRuntimeBridgeServiceError {
    return new HostedRuntimeBridgeServiceError("adapter_protocol_failed", message, { reasonCode });
  }

  private invalidInput(path: string, issue: string): HostedRuntimeBridgeServiceError {
    return new HostedRuntimeBridgeServiceError("invalid_input", "Invalid hosted runtime bridge input", {
      details: [{ path, issue }]
    });
  }

  private log(level: keyof RuntimeLogger, event: string, details?: Record<string, unknown>): void {
    this.deps.logger?.[level](event, details);
  }

  private async recordAudit(input: {
    eventType: string;
    decision: "allow" | "deny" | "error";
    reasonCode: string;
    runId?: string;
    approvalId?: string;
    commandId?: string;
    requestId?: string;
    payload?: Record<string, unknown>;
    auth?: AuthContext;
  }): Promise<void> {
    await this.deps.preflight?.recordAudit?.(input);
  }
}

function reasonForUnsupportedMode(runtimeMode: string, operation: HostedRuntimeBridgeCommand["operation"]): string {
  if (runtimeMode === "codex.exec_json") {
    return operation === "input" ? "codex_exec_json_input_unsupported" : "codex_exec_json_approval_bridge_unsupported";
  }
  if (runtimeMode === "codex.interactive") {
    return "hosted_codex_interactive_unshipped";
  }
  if (runtimeMode === "agentfield.async_rest") {
    return "agentfield_bridge_unshipped";
  }
  if (runtimeMode === "generic_http.async_rest") {
    return "generic_http_bridge_unshipped";
  }
  return "hosted_runtime_bridge_operation_unsupported";
}

function isWrapperRuntimeMode(runtimeMode: string): runtimeMode is "agentfield.async_rest" | "generic_http.async_rest" {
  return runtimeMode === "agentfield.async_rest" || runtimeMode === "generic_http.async_rest";
}

function wrapperCapabilityReasonCode(runtimeMode: string): string {
  return runtimeMode === "agentfield.async_rest"
    ? "agentfield_bridge_capability_missing"
    : "generic_http_bridge_capability_missing";
}

function readRuntimeMode(run: Run): string {
  return typeof run.runtimeMode === "string" && run.runtimeMode.length > 0 ? run.runtimeMode : run.runtime;
}

function deterministicIdempotencyKey(scopeId: string, operation: HostedRuntimeBridgeCommand["operation"], payload: Record<string, unknown>): string {
  const digest = createHash("sha256")
    .update(`${scopeId}:${operation}:${canonicalJson(payload)}`)
    .digest("hex")
    .slice(0, 40);
  return `bridge_${digest}`;
}

function payloadHashFor(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function payloadBytesFor(payload: Record<string, unknown>): number {
  return Buffer.byteLength(canonicalJson(payload), "utf8");
}

function withCommandDispatchMetadata(
  command: HostedRuntimeBridgeCommand,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    switchyardRunId: command.runId,
    bridgeCommandId: command.id,
    idempotencyKey: command.idempotencyKey,
    ...payload
  };
}

function hashPayloadForCommand(
  _command: HostedRuntimeBridgeCommand,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const { bridgeCommandId: _bridgeCommandId, ...hashPayload } = payload;
  return hashPayload;
}

function validateDispatchPayloadForCommand(
  command: HostedRuntimeBridgeCommand,
  payload: Record<string, unknown>
): string | undefined {
  if (payload["switchyardRunId"] !== command.runId) {
    return "hosted_runtime_bridge_payload_mismatch";
  }
  if (payload["bridgeCommandId"] !== command.id) {
    return "hosted_runtime_bridge_payload_mismatch";
  }
  if (payload["idempotencyKey"] !== command.idempotencyKey) {
    return "hosted_runtime_bridge_payload_mismatch";
  }
  if (payload["type"] !== command.operation) {
    return "hosted_runtime_bridge_payload_mismatch";
  }
  if (command.operation === "input" && typeof payload["text"] !== "string") {
    return "hosted_runtime_bridge_payload_mismatch";
  }
  if (command.operation === "approval_resolution") {
    if (payload["approvalId"] !== command.approvalId) {
      return "hosted_runtime_bridge_payload_mismatch";
    }
    if (typeof payload["runtimeApprovalToken"] !== "string" || payload["runtimeApprovalToken"].trim().length === 0) {
      return "hosted_runtime_bridge_payload_mismatch";
    }
  }
  return undefined;
}

function redactForStorage(
  operation: HostedRuntimeBridgeCommand["operation"],
  payload: Record<string, unknown>,
  payloadBytes: number
): HostedRuntimeBridgeCommand["redactedPayload"] {
  if (operation === "input") {
    const text = typeof payload["text"] === "string" ? payload["text"] : "";
    return {
      kind: "input",
      textBytes: Buffer.byteLength(text, "utf8"),
      payloadBytes,
      redacted: true
    };
  }

  return sanitizeApprovalPayload({
    kind: "approval_resolution",
    runtimeApprovalTokenHash: typeof payload["runtimeApprovalToken"] === "string"
      ? secretHash(payload["runtimeApprovalToken"])
      : undefined,
    decision: payload["decision"] === "rejected" ? "rejected" : "approved",
    message: redactSecretLikeValue(typeof payload["message"] === "string" ? payload["message"] : ""),
    payloadBytes,
    redacted: true,
    ...(isRecord(payload["answers"]) ? { answers: sanitizeApprovalPayload(payload["answers"]) } : {})
  });
}

function withQuotaMetadata(
  payload: HostedRuntimeBridgeCommand["redactedPayload"],
  reservations: { hourlyReservationId?: string; activeReservationId?: string } | undefined
): HostedRuntimeBridgeCommand["redactedPayload"] {
  if (!reservations?.hourlyReservationId && !reservations?.activeReservationId) {
    return payload;
  }
  const next: HostedRuntimeBridgeCommand["redactedPayload"] = { ...payload };
  next["quota"] = {
    ...(reservations.hourlyReservationId ? { hourlyReservationId: reservations.hourlyReservationId } : {}),
    ...(reservations.activeReservationId ? { activeReservationId: reservations.activeReservationId } : {})
  };
  return next;
}

function reservationMetadataFromCommand(
  command: HostedRuntimeBridgeCommand
): { hourlyReservationId?: string; activeReservationId?: string } | undefined {
  const quota = command.redactedPayload["quota"];
  if (!isRecord(quota)) {
    return undefined;
  }
  const hourlyReservationId = typeof quota["hourlyReservationId"] === "string" ? quota["hourlyReservationId"] : undefined;
  const activeReservationId = typeof quota["activeReservationId"] === "string" ? quota["activeReservationId"] : undefined;
  if (!hourlyReservationId && !activeReservationId) {
    return undefined;
  }
  const reservations: { hourlyReservationId?: string; activeReservationId?: string } = {};
  if (hourlyReservationId) {
    reservations.hourlyReservationId = hourlyReservationId;
  }
  if (activeReservationId) {
    reservations.activeReservationId = activeReservationId;
  }
  return reservations;
}

function isPayloadMismatchError(error: unknown): error is { code: "hosted_runtime_bridge_payload_mismatch" } {
  return !!error && typeof error === "object" && (error as { code?: string }).code === "hosted_runtime_bridge_payload_mismatch";
}

function reasonCodeFromError(error: unknown): string | undefined {
  if (error instanceof HostedRuntimeBridgeServiceError && error.reasonCode) {
    return error.reasonCode;
  }
  if (error && typeof error === "object") {
    const reasonCode = (error as { reasonCode?: unknown }).reasonCode;
    if (typeof reasonCode === "string" && reasonCode.length > 0) {
      return reasonCode;
    }
  }
  return undefined;
}

function readSessionWorkerId(session: RuntimeSession): string | undefined {
  if (!isRecord(session.state)) {
    return undefined;
  }
  const fromHosted = session.state["hostedWorkerId"];
  if (typeof fromHosted === "string" && fromHosted.trim().length > 0) {
    return fromHosted.trim();
  }
  const generic = session.state["workerId"];
  if (typeof generic === "string" && generic.trim().length > 0) {
    return generic.trim();
  }
  return undefined;
}

function resolveDeadlineFromApproval(approval: Approval, fallbackTtlMs: number, now: string): string {
  const expiresAt = approval.payload["expiresAt"];
  if (typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt))) {
    return expiresAt;
  }
  return new Date(Date.parse(now) + fallbackTtlMs).toISOString();
}

function ownershipFromAuth(auth: AuthContext | undefined): {
  accountId: string;
  tenantId: string;
  projectId: string;
  userId: string;
  apiKeyId: string;
} {
  if (!auth) {
    return {
      accountId: "system_account",
      tenantId: "system_tenant",
      projectId: "system_project",
      userId: "system_user",
      apiKeyId: "system_api_key"
    };
  }
  return {
    accountId: auth.account.id,
    tenantId: auth.tenant.id,
    projectId: auth.project.id,
    userId: auth.user.id,
    apiKeyId: auth.apiKey.id
  };
}

function sanitizeApprovalPayload(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    if (typeof entry === "string") {
      out[key] = redactSecretLikeValue(entry);
      continue;
    }
    if (Array.isArray(entry)) {
      out[key] = entry.map((element) => (typeof element === "string" ? redactSecretLikeValue(element) : element));
      continue;
    }
    if (isRecord(entry)) {
      out[key] = sanitizeApprovalPayload(entry);
      continue;
    }
    out[key] = entry;
  }
  return out;
}

function secretHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactSecretLikeValue(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const masked = trimmed
    .replace(/bearer\s+[a-z0-9_\-.]+/gi, "Bearer [redacted]")
    .replace(/sk-[a-z0-9_-]+/gi, "sk-[redacted]")
    .replace(/api[_-]?key\s*[:=]\s*[^\s,]+/gi, "apiKey=[redacted]")
    .replace(/token\s*[:=]\s*[^\s,]+/gi, "token=[redacted]")
    .replace(/password\s*[:=]\s*[^\s,]+/gi, "password=[redacted]");
  if (masked !== trimmed) {
    return "[redacted]";
  }
  return trimmed;
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
