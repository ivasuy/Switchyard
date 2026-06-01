import { createHash } from "node:crypto";
import type { Approval, ToolInvocation } from "@switchyard/contracts";
import type { ApprovalStore } from "../ports/approval-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { ToolPolicyPort } from "../ports/policy.js";
import type { RunStore } from "../ports/run-store.js";
import type { ToolInvocationStore } from "../ports/tool-invocation-store.js";
import type { ToolDispatchOutboxStore, ToolDispatchTargetPlacement } from "../ports/tool-dispatch-outbox-store.js";
import { hashExecutionPlan } from "./tool-router.js";
import { redactSecrets } from "./local-policy-gate.js";

class ServiceError extends Error {
  readonly code: string;
  readonly details?: Array<{ path: string; issue: string }>;

  constructor(code: string, message: string, details?: Array<{ path: string; issue: string }>) {
    super(message);
    this.code = code;
    if (details) {
      this.details = details;
    }
  }
}

export interface HostedToolDispatchInput {
  invocation: ToolInvocation;
  approvalId: string;
  target: { placement: ToolDispatchTargetPlacement; nodeId?: string };
  executionPlanHash: string;
  idempotencyKey: string;
}

export interface HostedToolServiceDependencies {
  runs: RunStore;
  events: EventStore;
  approvals: ApprovalStore;
  invocations: ToolInvocationStore;
  policy: ToolPolicyPort;
  dispatchOutbox: ToolDispatchOutboxStore;
  dispatch: (input: HostedToolDispatchInput) => Promise<{ dispatchId: string; target: ToolDispatchTargetPlacement }>;
  preflight?: {
    checkEntitlementAndQuotaAvailability?: (input: {
      runId: string;
      placement: ToolDispatchTargetPlacement;
      type: ToolInvocation["type"];
    }) => Promise<void>;
    reservePostPolicyQuota?: (input: {
      runId: string;
      placement: ToolDispatchTargetPlacement;
      type: ToolInvocation["type"];
      invocationId: string;
      approvalId: string;
    }) => Promise<{ hourlyReservationId?: string; activeReservationId?: string }>;
    releaseQuotaReservation?: (reservationId: string, reasonCode: string) => Promise<void>;
    releaseActiveQuotaReservation?: (reservationId: string, reasonCode: string) => Promise<void>;
    attachOwnership?: (input: {
      resourceType: "tool_invocation" | "approval";
      resourceId: string;
      runId: string;
    }) => Promise<void>;
    recordAudit?: (input: {
      runId: string;
      toolInvocationId?: string;
      approvalId?: string;
      eventType: string;
      reasonCode: string;
      decision: "allow" | "deny" | "error";
      payload: Record<string, unknown>;
    }) => Promise<void>;
  };
  now?: () => Date;
}

export interface HostedInvokeInput {
  runId?: string;
  type: ToolInvocation["type"];
  input: Record<string, unknown>;
  target?: { placement: "hosted" | "connected_local_node"; nodeId?: string };
  approvalPolicy?: string;
}

export interface HostedInvokeResult {
  statusCode: 202;
  invocation: ToolInvocation;
  approval?: Approval;
}

export interface HostedResolveApprovalResult {
  approval: Approval;
  invocation: ToolInvocation | null;
}

export class HostedToolService {
  private readonly resolveTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: HostedToolServiceDependencies) {}

  async invoke(input: HostedInvokeInput): Promise<HostedInvokeResult> {
    if (!input.runId) {
      throw new ServiceError("tool_run_required", "Hosted tool invocation requires runId");
    }
    const run = await this.deps.runs.get(input.runId);
    if (!run) {
      throw new ServiceError("run_not_found", `Run not found: ${input.runId}`);
    }

    const targetPlacement = input.target?.placement ?? (run.placement === "connected_local_node" ? "connected_local_node" : "hosted");
    if (targetPlacement !== "hosted" && targetPlacement !== "connected_local_node") {
      throw new ServiceError("tool_target_invalid", "Hosted tool target placement is invalid");
    }
    if (!this.isTargetMatchAllowed(run, targetPlacement)) {
      throw new ServiceError("tool_target_mismatch", "Tool target placement does not match run placement");
    }

    await this.deps.preflight?.checkEntitlementAndQuotaAvailability?.({
      runId: run.id,
      placement: targetPlacement,
      type: input.type
    });

    const nowIso = this.nowIso();
    const redactedInput = redactSecrets(boundRecord(input.input));
    const decision = await this.deps.policy.decideTool({
      type: input.type,
      input: redactedInput,
      runApprovalPolicy: input.approvalPolicy ?? run.approvalPolicy,
      placement: targetPlacement
    } as never);

    if (decision.decision === "deny") {
      const denied = await this.persistDeniedInvocation({
        runId: run.id,
        type: input.type,
        requestInput: redactedInput,
        targetPlacement,
        policyTrace: decision.policyTrace,
        reasonCode: decision.reasonCode,
        createdAt: nowIso
      });
      await this.deps.preflight?.recordAudit?.({
        runId: run.id,
        toolInvocationId: denied.id,
        eventType: "tool.invoke_denied",
        reasonCode: decision.reasonCode,
        decision: "deny",
        payload: boundRecord({ targetPlacement, policyTrace: decision.policyTrace })
      });
      throw new ServiceError("tool_policy_denied", "Tool invocation denied by policy", [{ path: "toolInvocationId", issue: denied.id }]);
    }

    const invocationId = `tool_${crypto.randomUUID()}`;
    const executionPlanHash = hashExecutionPlan(decision.executionPlan);
    const approvalId = decision.decision === "approval_required" ? `approval_${crypto.randomUUID()}` : undefined;

    const quota = await this.deps.preflight?.reservePostPolicyQuota?.({
      runId: run.id,
      placement: targetPlacement,
      type: input.type,
      invocationId,
      approvalId: approvalId ?? ""
    });

    try {
      const invocation: ToolInvocation = {
        id: invocationId,
        runId: run.id,
        type: input.type,
        status: "queued",
        ...(approvalId ? { approvalId } : {}),
        input: redactSecrets(boundRecord({
          request: redactedInput,
          reasonCode: decision.reasonCode,
          policyTrace: decision.policyTrace,
          executionPlan: decision.executionPlan,
          executionPlanHash,
          target: { placement: targetPlacement, ...(input.target?.nodeId ? { nodeId: input.target.nodeId } : {}) }
        })),
        createdAt: nowIso
      };

      await this.deps.invocations.create(invocation);
      await this.deps.preflight?.attachOwnership?.({ resourceType: "tool_invocation", resourceId: invocation.id, runId: run.id });

      let approval: Approval | undefined;
      if (decision.decision === "approval_required") {
        approval = {
          id: approvalId!,
          runId: run.id,
          status: "pending",
          approvalType: decision.approvalType,
          payload: redactSecrets(boundRecord({
            toolInvocationId: invocation.id,
            toolType: input.type,
            reasonCode: decision.reasonCode,
            actionSummary: `${input.type} request requires approval`,
            policyTrace: decision.policyTrace,
            executionPlan: decision.executionPlan,
            executionPlanHash,
            expiresAt: decision.expiresAt,
            target: { placement: targetPlacement, ...(input.target?.nodeId ? { nodeId: input.target.nodeId } : {}) },
            quota
          })),
          createdAt: nowIso
        };
        await this.deps.approvals.create(approval);
        await this.deps.preflight?.attachOwnership?.({ resourceType: "approval", resourceId: approval.id, runId: run.id });
      }

      const allowAuditPayload: {
        runId: string;
        toolInvocationId?: string;
        approvalId?: string;
        eventType: string;
        reasonCode: string;
        decision: "allow" | "deny" | "error";
        payload: Record<string, unknown>;
      } = {
        runId: run.id,
        toolInvocationId: invocation.id,
        eventType: "tool.invoke_allowed",
        reasonCode: decision.reasonCode,
        decision: "allow",
        payload: boundRecord({
          toolType: input.type,
          decision: decision.decision,
          placement: targetPlacement
        })
      };
      if (approval?.id) {
        allowAuditPayload.approvalId = approval.id;
      }
      await this.deps.preflight?.recordAudit?.(allowAuditPayload);

      return {
        statusCode: 202,
        invocation,
        ...(approval ? { approval } : {})
      };
    } catch (error) {
      await this.rollbackAdmissionQuotaReservations(quota, "tool_admission_failed");
      throw error;
    }
  }

  async resolveApproval(
    approvalId: string,
    decision: "approved" | "rejected" | "expired"
  ): Promise<HostedResolveApprovalResult> {
    return this.withApprovalLock(approvalId, async () => {
      const approval = await this.deps.approvals.get(approvalId);
      if (!approval) {
        throw new ServiceError("approval_not_found", `Approval not found: ${approvalId}`);
      }

      const runtimeApprovalToken = typeof approval.payload["runtimeApprovalToken"] === "string"
        ? approval.payload["runtimeApprovalToken"]
        : undefined;
      if (runtimeApprovalToken && typeof approval.payload["toolInvocationId"] !== "string") {
        throw new ServiceError("hosted_runtime_approval_bridge_unshipped", "Runtime approvals are not resolved through hosted tool approval routes");
      }

      const toolInvocationId = typeof approval.payload["toolInvocationId"] === "string"
        ? approval.payload["toolInvocationId"]
        : undefined;
      if (!toolInvocationId) {
        throw new ServiceError("approval_scope_denied", "Hosted tool approval route only resolves tool-scoped approvals");
      }

      const invocation = await this.deps.invocations.get(toolInvocationId);
      if (!invocation) {
        throw new ServiceError("tool_invocation_not_found", `Tool invocation not found: ${toolInvocationId}`);
      }

      if (approval.status !== "pending") {
        if (approval.status === "approved" && decision === "approved") {
          const recovered = await this.tryRecoverApprovedDispatch(approval, invocation);
          if (recovered) {
            return { approval: recovered.approval, invocation: recovered.invocation };
          }
        }
        throw new ServiceError("approval_not_pending", `Approval is not pending: ${approvalId}`);
      }

      const nextApproval: Approval = {
        ...approval,
        status: decision,
        resolvedAt: this.nowIso(),
        payload: redactSecrets(boundRecord({
          ...approval.payload,
          resolution: {
            actor: "hosted-api",
            decision
          }
        }))
      };
      const persisted = await this.deps.approvals.updateIfStatus(approval.id, "pending", nextApproval);
      if (!persisted) {
        throw new ServiceError("approval_not_pending", `Approval is not pending: ${approvalId}`);
      }

      if (decision === "rejected" || decision === "expired") {
        const reasonCode = decision === "expired" ? "tool_approval_expired" : "tool_approval_rejected";
        const denied = await this.transitionInvocationIfQueued(invocation, {
          status: "denied",
          error: {
            code: reasonCode,
            message: decision === "expired"
              ? "Tool invocation denied because approval expired"
              : "Tool invocation denied because approval was rejected"
          },
          completedAt: this.nowIso()
        });
        await this.releaseActiveQuotaReservation(persisted, reasonCode);
        await this.deps.preflight?.recordAudit?.({
          runId: invocation.runId ?? "",
          toolInvocationId: invocation.id,
          approvalId: persisted.id,
          eventType: "tool.approval_resolved",
          reasonCode,
          decision: "deny",
          payload: boundRecord({ status: decision })
        });
        return { approval: persisted, invocation: denied ?? invocation };
      }

      const request = asRecord(invocation.input["request"]);
      const policyDecision = await this.deps.policy.decideTool({
        type: invocation.type,
        input: request,
        runApprovalPolicy: undefined,
        placement: this.extractPlacement(invocation)
      } as never);

      if (policyDecision.decision === "deny") {
        const denied = await this.transitionInvocationIfQueued(invocation, {
          status: "denied",
          error: {
            code: "tool_policy_failed",
            message: "Tool invocation denied by policy revalidation"
          },
          completedAt: this.nowIso()
        });
        await this.releaseActiveQuotaReservation(persisted, "tool_policy_failed");
        return { approval: persisted, invocation: denied ?? invocation };
      }

      const storedHash = typeof invocation.input["executionPlanHash"] === "string"
        ? invocation.input["executionPlanHash"]
        : (typeof persisted.payload["executionPlanHash"] === "string" ? persisted.payload["executionPlanHash"] : undefined);
      const recomputedHash = hashExecutionPlan(policyDecision.executionPlan);
      if (storedHash && storedHash !== recomputedHash) {
        const denied = await this.transitionInvocationIfQueued(invocation, {
          status: "denied",
          error: {
            code: "tool_policy_failed",
            message: "Tool execution plan changed after approval"
          },
          completedAt: this.nowIso()
        });
        await this.releaseActiveQuotaReservation(persisted, "tool_policy_failed");
        return { approval: persisted, invocation: denied ?? invocation };
      }

      await this.dispatchApprovedInvocation({
        approval: persisted,
        invocation,
        executionPlanHash: recomputedHash
      });

      await this.deps.preflight?.recordAudit?.({
        runId: invocation.runId ?? "",
        toolInvocationId: invocation.id,
        approvalId: persisted.id,
        eventType: "tool.approval_resolved",
        reasonCode: "tool_approval_approved",
        decision: "allow",
        payload: boundRecord({ status: "approved" })
      });

      return { approval: persisted, invocation };
    });
  }

  private async tryRecoverApprovedDispatch(
    approval: Approval,
    invocation: ToolInvocation
  ): Promise<HostedResolveApprovalResult | null> {
    const record = await this.deps.dispatchOutbox.getByApprovalAndInvocation(approval.id, invocation.id);
    if (!record || record.dispatchStatus === "dispatched") {
      return null;
    }
    const executionPlanHash = typeof approval.payload["executionPlanHash"] === "string"
      ? approval.payload["executionPlanHash"]
      : (typeof invocation.input["executionPlanHash"] === "string" ? invocation.input["executionPlanHash"] : "");
    await this.dispatchApprovedInvocation({ approval, invocation, executionPlanHash });
    return { approval, invocation };
  }

  private async dispatchApprovedInvocation(input: {
    approval: Approval;
    invocation: ToolInvocation;
    executionPlanHash: string;
  }): Promise<void> {
    const placement = this.extractPlacement(input.invocation);
    const outbox = await this.deps.dispatchOutbox.upsertByApprovalAndInvocation({
      approvalId: input.approval.id,
      toolInvocationId: input.invocation.id,
      runId: input.invocation.runId ?? "",
      targetPlacement: placement,
      executionPlanHash: input.executionPlanHash,
      now: this.nowIso()
    });

    if (outbox.dispatchStatus === "dispatched") {
      return;
    }

    await this.deps.dispatchOutbox.markDispatching(outbox.id, this.nowIso());
    try {
      const dispatchTarget: { placement: ToolDispatchTargetPlacement; nodeId?: string } = {
        placement
      };
      const nodeId = this.extractNodeId(input.invocation);
      if (nodeId) {
        dispatchTarget.nodeId = nodeId;
      }
      const dispatched = await this.deps.dispatch({
        invocation: input.invocation,
        approvalId: input.approval.id,
        target: dispatchTarget,
        executionPlanHash: input.executionPlanHash,
        idempotencyKey: outbox.id
      });
      await this.deps.dispatchOutbox.markDispatched(outbox.id, dispatched.dispatchId, this.nowIso());
    } catch (error) {
      await this.deps.dispatchOutbox.markFailedRetryable(outbox.id, "tool_dispatch_failed", this.nowIso());
      throw new ServiceError("tool_dispatch_failed", error instanceof Error ? error.message : String(error));
    }
  }

  private async persistDeniedInvocation(input: {
    runId: string;
    type: ToolInvocation["type"];
    requestInput: Record<string, unknown>;
    targetPlacement: ToolDispatchTargetPlacement;
    policyTrace: Array<Record<string, unknown>>;
    reasonCode: string;
    createdAt: string;
  }): Promise<ToolInvocation> {
    const denied: ToolInvocation = {
      id: `tool_${crypto.randomUUID()}`,
      runId: input.runId,
      type: input.type,
      status: "denied",
      input: redactSecrets(boundRecord({
        request: input.requestInput,
        target: { placement: input.targetPlacement },
        policyTrace: input.policyTrace,
        reasonCode: input.reasonCode
      })),
      error: {
        code: input.reasonCode,
        message: "Tool invocation denied by policy"
      },
      createdAt: input.createdAt,
      completedAt: input.createdAt
    };
    await this.deps.invocations.create(denied);
    await this.deps.preflight?.attachOwnership?.({ resourceType: "tool_invocation", resourceId: denied.id, runId: input.runId });
    return denied;
  }

  private async transitionInvocationIfQueued(
    invocation: ToolInvocation,
    patch: Pick<ToolInvocation, "status" | "completedAt" | "error">
  ): Promise<ToolInvocation | null> {
    const next: ToolInvocation = { ...invocation, ...patch };
    return this.deps.invocations.updateIfStatus(invocation.id, "queued", next);
  }

  private async releaseActiveQuotaReservation(approval: Approval, reasonCode: string): Promise<void> {
    const quota = asRecord(approval.payload["quota"]);
    const activeReservationId = typeof quota.activeReservationId === "string" ? quota.activeReservationId : undefined;
    if (!activeReservationId) {
      return;
    }
    await this.deps.preflight?.releaseActiveQuotaReservation?.(activeReservationId, reasonCode);
  }

  private async rollbackAdmissionQuotaReservations(
    quota: { hourlyReservationId?: string; activeReservationId?: string } | undefined,
    reasonCode: string
  ): Promise<void> {
    if (!quota) {
      return;
    }
    const releaser = this.deps.preflight?.releaseQuotaReservation;
    if (!releaser) {
      return;
    }
    if (quota.activeReservationId) {
      await releaser(quota.activeReservationId, reasonCode);
    }
    if (quota.hourlyReservationId) {
      await releaser(quota.hourlyReservationId, reasonCode);
    }
  }

  private isTargetMatchAllowed(run: { placement: string; metadata?: Record<string, unknown> }, targetPlacement: ToolDispatchTargetPlacement): boolean {
    if (run.placement === targetPlacement) {
      return true;
    }
    const metadata = asRecord(run.metadata);
    const explicit = metadata.toolOffloadPlacements;
    if (Array.isArray(explicit)) {
      return explicit.includes(targetPlacement);
    }
    const allowOffload = metadata.allowToolPlacementOffload;
    return allowOffload === true;
  }

  private extractPlacement(invocation: ToolInvocation): ToolDispatchTargetPlacement {
    const target = asRecord(invocation.input["target"]);
    return target.placement === "connected_local_node" ? "connected_local_node" : "hosted";
  }

  private extractNodeId(invocation: ToolInvocation): string | undefined {
    const target = asRecord(invocation.input["target"]);
    return typeof target.nodeId === "string" ? target.nodeId : undefined;
  }

  private nowDate(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private nowIso(): string {
    return this.nowDate().toISOString();
  }

  private async withApprovalLock<T>(approvalId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.resolveTails.get(approvalId) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.resolveTails.set(approvalId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.resolveTails.get(approvalId) === tail) {
        this.resolveTails.delete(approvalId);
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function boundRecord(input: Record<string, unknown>, maxBytes = 16_384): Record<string, unknown> {
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) {
    return input;
  }
  const hash = createHash("sha256").update(json).digest("hex");
  return {
    truncated: true,
    hash,
    maxBytes
  };
}

export { ServiceError as HostedToolServiceError };
