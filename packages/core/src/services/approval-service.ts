import type { Approval, SwitchyardEvent, ToolInvocation } from "@switchyard/contracts";
import type { ApprovalStore, ListApprovalsFilter, ListApprovalsResult } from "../ports/approval-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { EventBus } from "./event-bus.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";
import type { ToolRouter } from "./tool-router.js";
import { AdapterProtocolError } from "../errors.js";
import { redactSecrets } from "./local-policy-gate.js";

type Cursor = { createdAt: string; id: string };

class ServiceError extends Error {
  readonly code: string;
  readonly details?: Array<{ path: string; issue: string }>;

  constructor(code: string, message: string, details?: Array<{ path: string; issue: string }>) {
    super(message);
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface CreateApprovalInput {
  runId?: string | undefined;
  approvalType: Approval["approvalType"];
  payload: Record<string, unknown>;
}

export interface ResolveApprovalInput {
  actor?: string | undefined;
  reason?: string | undefined;
  answers?: Record<string, unknown> | undefined;
}

export interface ResolveApprovalResult {
  approval: Approval;
  invocation: ToolInvocation | null;
}

export interface ApprovalServiceDependencies {
  approvals: ApprovalStore;
  runs: RunStore;
  events: EventStore;
  toolRouter?: ToolRouter;
  runtimeResolutionSender?: (input: {
    type: "approval_resolution";
    approvalId: string;
    runId: string;
    runtimeApprovalToken: string;
    decision: "approved" | "rejected";
    message: string;
    answers?: Record<string, unknown>;
  }) => Promise<void>;
  eventBus?: EventBus;
  logger?: RuntimeLogger;
  clock?: () => Date;
  scheduler?: {
    setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  };
}

export class ApprovalService {
  private readonly resolutionTails = new Map<string, Promise<void>>();
  private readonly expirationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: ApprovalServiceDependencies) {}

  async create(input: CreateApprovalInput): Promise<Approval> {
    if (input.runId) {
      const run = await this.deps.runs.get(input.runId);
      if (!run) {
        throw new ServiceError("run_not_found", `Run not found: ${input.runId}`);
      }
    }

    const approval: Approval = {
      id: `approval_${crypto.randomUUID()}`,
      approvalType: input.approvalType,
      status: "pending",
      payload: redactSecrets(input.payload ?? {}),
      createdAt: this.nowIso()
    };
    if (input.runId) {
      approval.runId = input.runId;
    }

    await this.deps.approvals.create(approval);
    await this.appendAndPublish(await this.eventForRun(approval.runId, "approval.requested", {
      approvalId: approval.id,
      approvalType: approval.approvalType
    }));

    await this.scheduleOrExpireApproval(approval);
    return (await this.deps.approvals.get(approval.id)) ?? approval;
  }

  async list(filter: ListApprovalsFilter): Promise<ListApprovalsResult> {
    return this.deps.approvals.list(filter);
  }

  async get(id: string): Promise<Approval | undefined> {
    return this.deps.approvals.get(id);
  }

  async approve(id: string, input: ResolveApprovalInput = {}): Promise<ResolveApprovalResult> {
    return this.resolve(id, "approved", "approval.approved", input);
  }

  async reject(id: string, input: ResolveApprovalInput = {}): Promise<ResolveApprovalResult> {
    return this.resolve(id, "rejected", "approval.rejected", input);
  }

  async expirePendingRuntimeApprovals(now = this.nowDate()): Promise<{ expired: number }> {
    const pending = await this.listPendingExpirableApprovals();
    let expired = 0;
    for (const approval of pending) {
      const expiresAt = parseExpiresAt(approval);
      if (!expiresAt || expiresAt > now) {
        continue;
      }
      const transitioned = await this.transitionPendingApproval(approval.id, {
        status: "expired",
        message: "expired by Switchyard",
        eventType: "approval.expired"
      });
      if (!transitioned) {
        continue;
      }
      expired += 1;
      if (isRuntimeApproval(transitioned)) {
        await this.sendRuntimeRejectionResolution(transitioned, "expired by Switchyard", "approval.expiration_resolution_failed");
      } else if (isToolApproval(transitioned) && this.deps.toolRouter) {
        await this.deps.toolRouter.resolveQueuedByApproval(transitioned);
      }
    }
    return { expired };
  }

  async terminalizePendingRuntimeApprovalsForRun(
    runId: string,
    input: {
      terminalEvent: "run.cancelled" | "run.failed" | "run.timeout" | "daemon_restarted";
      approvalStatus: "rejected" | "expired";
      message: string;
    }
  ): Promise<{ expired: number; rejected: number }> {
    const listed = await this.deps.approvals.list({ runId, status: "pending", limit: 1000 });
    let expired = 0;
    let rejected = 0;
    for (const approval of listed.approvals) {
      if (!isRuntimeApproval(approval)) {
        continue;
      }
      const transitioned = await this.transitionPendingApproval(approval.id, {
        status: input.approvalStatus,
        message: input.message,
        eventType: input.approvalStatus === "expired" ? "approval.expired" : "approval.rejected"
      });
      if (!transitioned) {
        continue;
      }
      if (input.approvalStatus === "expired") {
        expired += 1;
      } else {
        rejected += 1;
      }
      await this.sendRuntimeRejectionResolution(transitioned, input.message, "approval.terminalization_resolution_failed", input.terminalEvent);
    }
    return { expired, rejected };
  }

  private async resolve(
    id: string,
    status: "approved" | "rejected",
    eventType: "approval.approved" | "approval.rejected",
    input: ResolveApprovalInput
  ): Promise<ResolveApprovalResult> {
    return this.withResolutionLock(id, async () => {
      const approval = await this.deps.approvals.get(id);
      if (!approval) {
        throw new ServiceError("approval_not_found", `Approval not found: ${id}`);
      }
      if (approval.status !== "pending") {
        throw new ServiceError("approval_not_pending", `Approval is not pending: ${id}`);
      }

      const expiresAt = parseExpiresAt(approval);
      if (expiresAt && expiresAt <= this.nowDate()) {
        const expired = await this.transitionPendingApprovalWithinLock(id, {
          status: "expired",
          message: "expired by Switchyard",
          eventType: "approval.expired"
        });
        if (expired) {
          if (isRuntimeApproval(expired)) {
            await this.sendRuntimeRejectionResolution(expired, "expired by Switchyard", "approval.expiration_resolution_failed");
          } else if (isToolApproval(expired) && this.deps.toolRouter) {
            await this.deps.toolRouter.resolveQueuedByApproval(expired);
          }
        }
        throw new ServiceError("approval_not_pending", `Approval is not pending: ${id}`);
      }

      const resolution: Record<string, unknown> = {};
      if (input.actor && input.actor.trim().length > 0) {
        resolution.actor = input.actor.trim();
      }
      if (input.reason && input.reason.trim().length > 0) {
        resolution.reason = input.reason.trim();
      }
      if (input.answers && Object.keys(input.answers).length > 0) {
        resolution.answers = redactSecrets(input.answers);
      }

      const now = this.nowIso();
      const nextApproval: Approval = {
        ...approval,
        status,
        resolvedAt: now
      };
      if (Object.keys(resolution).length > 0) {
        nextApproval.payload = redactSecrets({
          ...approval.payload,
          resolution
        });
      }

      const persisted = await this.deps.approvals.updateIfStatus(id, "pending", nextApproval);
      if (!persisted) {
        throw new ServiceError("approval_not_pending", `Approval is not pending: ${id}`);
      }
      this.clearExpirationTimer(id);

      await this.appendAndPublish(await this.eventForRun(persisted.runId, eventType, {
        approvalId: persisted.id,
        status: persisted.status
      }));

      if (this.deps.runtimeResolutionSender) {
        const runtimeApprovalToken = typeof persisted.payload["runtimeApprovalToken"] === "string"
          ? persisted.payload["runtimeApprovalToken"]
          : undefined;
        const runId = typeof persisted.runId === "string" ? persisted.runId : undefined;
        if (runtimeApprovalToken && runId) {
          const resolutionPayload: {
            type: "approval_resolution";
            approvalId: string;
            runId: string;
            runtimeApprovalToken: string;
            decision: "approved" | "rejected";
            message: string;
            answers?: Record<string, unknown>;
          } = {
            type: "approval_resolution",
            approvalId: persisted.id,
            runId,
            runtimeApprovalToken,
            decision: status,
            message: input.reason?.trim().length
              ? input.reason.trim()
              : `${status} by ${input.actor?.trim() || "local-user"}`
          };
          const responseFormat = typeof persisted.payload["responseFormat"] === "string"
            ? persisted.payload["responseFormat"]
            : undefined;
          if (responseFormat === "ask_user_question" && input.answers && Object.keys(input.answers).length > 0) {
            resolutionPayload.answers = redactSecrets(input.answers);
          }
          await this.deps.runtimeResolutionSender(resolutionPayload);
          this.deps.logger?.info("runtime.approval_resolution.sent", {
            approvalId: persisted.id,
            runId,
            decision: status
          });
        }
      }

      let invocation: ToolInvocation | null = null;
      if (this.deps.toolRouter) {
        try {
          invocation = await this.deps.toolRouter.resolveQueuedByApproval(persisted);
        } catch (error) {
          this.deps.logger?.warn("approval.lifecycle_failed", {
            approvalId: persisted.id,
            reason: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      }

      return { approval: persisted, invocation };
    });
  }

  private async withResolutionLock<T>(approvalId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.resolutionTails.get(approvalId) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.resolutionTails.set(approvalId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.resolutionTails.get(approvalId) === tail) {
        this.resolutionTails.delete(approvalId);
      }
    }
  }

  private async appendAndPublish(event: SwitchyardEvent): Promise<void> {
    await this.deps.events.append(event);
    if (!this.deps.eventBus) {
      return;
    }
    try {
      await this.deps.eventBus.publish(event);
    } catch (error) {
      this.deps.logger?.warn("approval.lifecycle_failed", {
        eventType: event.type,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async eventForRun(
    runId: string | undefined,
    type: SwitchyardEvent["type"],
    payload: Record<string, unknown>
  ): Promise<SwitchyardEvent> {
    const sequence = runId ? (await this.deps.events.listByRun(runId)).length : 0;
    const event: SwitchyardEvent = {
      id: `event_${crypto.randomUUID()}`,
      type,
      sequence,
      payload: redactSecrets(payload),
      createdAt: this.nowIso()
    };
    if (runId) {
      event.runId = runId;
    }
    return event;
  }

  private nowDate(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private nowIso(): string {
    return this.nowDate().toISOString();
  }

  private getScheduler() {
    return this.deps.scheduler ?? {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle)
    };
  }

  private async scheduleOrExpireApproval(approval: Approval): Promise<void> {
    if (!isRuntimeApproval(approval) && !isToolApproval(approval)) {
      return;
    }
    const expiresAt = parseExpiresAt(approval);
    if (!expiresAt) {
      return;
    }
    const now = this.nowDate();
    if (expiresAt <= now) {
      const expired = await this.transitionPendingApproval(approval.id, {
        status: "expired",
        message: "expired by Switchyard",
        eventType: "approval.expired"
      });
      if (expired) {
        if (isRuntimeApproval(expired)) {
          await this.sendRuntimeRejectionResolution(expired, "expired by Switchyard", "approval.expiration_resolution_failed");
        } else if (isToolApproval(expired) && this.deps.toolRouter) {
          await this.deps.toolRouter.resolveQueuedByApproval(expired);
        }
      }
      return;
    }

    const scheduler = this.getScheduler();
    const delayMs = Math.max(0, expiresAt.getTime() - now.getTime());
    const handle = scheduler.setTimeout(() => {
      void this.withResolutionLock(approval.id, async () => {
        const expired = await this.transitionPendingApprovalWithinLock(approval.id, {
          status: "expired",
          message: "expired by Switchyard",
          eventType: "approval.expired"
        });
        if (expired) {
          if (isRuntimeApproval(expired)) {
            await this.sendRuntimeRejectionResolution(expired, "expired by Switchyard", "approval.expiration_resolution_failed");
          } else if (isToolApproval(expired) && this.deps.toolRouter) {
            await this.deps.toolRouter.resolveQueuedByApproval(expired);
          }
        }
      }).catch((error) => {
        this.deps.logger?.warn("approval.expiration_resolution_failed", {
          approvalId: approval.id,
          reasonCode: error instanceof AdapterProtocolError ? error.reasonCode : undefined,
          reason: error instanceof Error ? error.message : String(error)
        });
      }).finally(() => {
        this.clearExpirationTimer(approval.id);
      });
    }, delayMs);
    this.clearExpirationTimer(approval.id);
    this.expirationTimers.set(approval.id, handle);
  }

  private clearExpirationTimer(approvalId: string): void {
    const handle = this.expirationTimers.get(approvalId);
    if (!handle) {
      return;
    }
    this.getScheduler().clearTimeout(handle);
    this.expirationTimers.delete(approvalId);
  }

  private async listPendingExpirableApprovals(): Promise<Approval[]> {
    const collected: Approval[] = [];
    let before: Cursor | undefined;
    while (true) {
      const page = await this.deps.approvals.list({
        status: "pending",
        limit: 200,
        ...(before ? { before } : {})
      });
      collected.push(...page.approvals.filter((approval) => isRuntimeApproval(approval) || isToolApproval(approval)));
      if (!page.nextCursor) {
        break;
      }
      before = page.nextCursor;
    }
    return collected;
  }

  private async transitionPendingApproval(
    approvalId: string,
    input: {
      status: "expired" | "rejected";
      message: string;
      eventType: "approval.expired" | "approval.rejected";
    }
  ): Promise<Approval | null> {
    return this.withResolutionLock(approvalId, async () =>
      this.transitionPendingApprovalWithinLock(approvalId, input)
    );
  }

  private async transitionPendingApprovalWithinLock(
    approvalId: string,
    input: {
      status: "expired" | "rejected";
      message: string;
      eventType: "approval.expired" | "approval.rejected";
    }
  ): Promise<Approval | null> {
    const approval = await this.deps.approvals.get(approvalId);
    if (!approval || approval.status !== "pending") {
      return null;
    }
    const nextApproval: Approval = {
      ...approval,
      status: input.status,
      resolvedAt: this.nowIso(),
      payload: redactSecrets({
        ...approval.payload,
        resolution: {
          actor: "switchyard",
          reason: input.message
        }
      })
    };
    const persisted = await this.deps.approvals.updateIfStatus(approvalId, "pending", nextApproval);
    if (!persisted) {
      return null;
    }
    this.clearExpirationTimer(approvalId);
    await this.appendAndPublish(await this.eventForRun(persisted.runId, input.eventType, {
      approvalId: persisted.id,
      status: persisted.status
    }));
    this.deps.logger?.info(input.eventType, {
      approvalId: persisted.id,
      runId: persisted.runId,
      status: persisted.status
    });
    return persisted;
  }

  private async sendRuntimeRejectionResolution(
    approval: Approval,
    message: string,
    logEvent: "approval.expiration_resolution_failed" | "approval.terminalization_resolution_failed",
    terminalEvent?: "run.cancelled" | "run.failed" | "run.timeout" | "daemon_restarted"
  ): Promise<void> {
    const runtimeApprovalToken = typeof approval.payload["runtimeApprovalToken"] === "string"
      ? approval.payload["runtimeApprovalToken"]
      : undefined;
    const runId = typeof approval.runId === "string" ? approval.runId : undefined;
    if (!this.deps.runtimeResolutionSender || !runtimeApprovalToken || !runId) {
      return;
    }

    try {
      await this.deps.runtimeResolutionSender({
        type: "approval_resolution",
        approvalId: approval.id,
        runId,
        runtimeApprovalToken,
        decision: "rejected",
        message
      });
      this.deps.logger?.info("runtime.approval_resolution.sent", {
        approvalId: approval.id,
        runId,
        decision: "rejected"
      });
    } catch (error) {
      this.deps.logger?.warn(logEvent, {
        approvalId: approval.id,
        runId,
        status: approval.status,
        terminalEvent,
        reasonCode: error instanceof AdapterProtocolError ? error.reasonCode : undefined,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function isRuntimeApproval(approval: Approval): boolean {
  return typeof approval.payload["runtimeApprovalToken"] === "string";
}

function isToolApproval(approval: Approval): boolean {
  return typeof approval.payload["toolInvocationId"] === "string";
}

function parseExpiresAt(approval: Approval): Date | undefined {
  const raw = approval.payload["expiresAt"];
  if (typeof raw !== "string") {
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

export { ServiceError as ApprovalServiceError };
