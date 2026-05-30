import type { Approval, SwitchyardEvent, ToolInvocation } from "@switchyard/contracts";
import type { ApprovalStore, ListApprovalsFilter, ListApprovalsResult } from "../ports/approval-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { EventBus } from "./event-bus.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";
import type { ToolRouter } from "./tool-router.js";
import { redactSecrets } from "./local-policy-gate.js";

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
}

export class ApprovalService {
  private readonly resolutionTails = new Map<string, Promise<void>>();

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
      createdAt: new Date().toISOString()
    };
    if (input.runId) {
      approval.runId = input.runId;
    }

    await this.deps.approvals.create(approval);
    await this.appendAndPublish(await this.eventForRun(approval.runId, "approval.requested", {
      approvalId: approval.id,
      approvalType: approval.approvalType
    }));

    return approval;
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

      const now = new Date().toISOString();
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
      createdAt: new Date().toISOString()
    };
    if (runId) {
      event.runId = runId;
    }
    return event;
  }
}

export { ServiceError as ApprovalServiceError };
