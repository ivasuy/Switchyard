import type { Approval, SwitchyardEvent, ToolInvocation } from "@switchyard/contracts";
import type { ApprovalStore } from "../ports/approval-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { ToolAdapter } from "../ports/tool-adapter.js";
import type { ToolInvocationStore, ListToolInvocationsFilter, ListToolInvocationsResult } from "../ports/tool-invocation-store.js";
import type { ToolPolicyPort } from "../ports/policy.js";
import type { EventBus } from "./event-bus.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";
import { redactSecrets } from "./local-policy-gate.js";

const REAL_TOOL_TYPES = new Set(["web_search", "fetch", "browser", "repo", "shell", "github"]);
const KNOWN_TOOL_TYPES = new Set([...REAL_TOOL_TYPES, "fake_echo"]);

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

export interface InvokeToolInput {
  runId?: string | undefined;
  type: string;
  input: Record<string, unknown>;
  approvalPolicy?: string | undefined;
}

export interface InvokeToolResult {
  statusCode: 201 | 202;
  invocation: ToolInvocation;
  approval?: Approval;
}

export interface ToolRouterDependencies {
  runs: RunStore;
  events: EventStore;
  approvals: ApprovalStore;
  invocations: ToolInvocationStore;
  adapters: Map<string, ToolAdapter>;
  policy: ToolPolicyPort;
  eventBus?: EventBus;
  logger?: RuntimeLogger;
}

export class ToolRouter {
  constructor(private readonly deps: ToolRouterDependencies) {}

  async invoke(input: InvokeToolInput): Promise<InvokeToolResult> {
    if (!KNOWN_TOOL_TYPES.has(input.type)) {
      throw new ServiceError("invalid_input", `Unknown tool type: ${input.type}`, [{ path: "type", issue: "unknown tool type" }]);
    }
    const normalizedInput = redactSecrets(input.input ?? {});
    const run = input.runId ? await this.requireRun(input.runId) : undefined;
    const approvalPolicy = input.approvalPolicy ?? run?.approvalPolicy;

    const decision = await this.deps.policy.decideTool({
      runApprovalPolicy: approvalPolicy,
      type: input.type as ToolInvocation["type"],
      input: normalizedInput
    });

    if (REAL_TOOL_TYPES.has(input.type)) {
      const denied = await this.persistDeniedInvocation(input.runId, input.type as ToolInvocation["type"], normalizedInput, decision.policyTrace, "real tool execution is not available in R7");
      throw new ServiceError("tool_policy_denied", "Real tool execution is not shipped in R7", [
        { path: "toolInvocationId", issue: denied.id }
      ]);
    }

    if (decision.decision === "deny") {
      const denied = await this.persistDeniedInvocation(input.runId, "fake_echo", normalizedInput, decision.policyTrace, decision.reasonCode);
      throw new ServiceError("tool_policy_denied", "Tool invocation denied by policy", [
        { path: "toolInvocationId", issue: denied.id }
      ]);
    }

    if (decision.decision === "approval_required") {
      const now = new Date().toISOString();
      const approval: Approval = {
        id: `approval_${crypto.randomUUID()}`,
        status: "pending",
        approvalType: "before_external_web_action",
        payload: redactSecrets({
          reasonCode: decision.reasonCode,
          policyTrace: decision.policyTrace,
          toolType: input.type,
          toolInput: normalizedInput
        }),
        createdAt: now
      };
      if (input.runId) {
        approval.runId = input.runId;
      }
      await this.deps.approvals.create(approval);

      const invocation: ToolInvocation = {
        id: `tool_${crypto.randomUUID()}`,
        runId: input.runId,
        type: "fake_echo",
        status: "queued",
        approvalId: approval.id,
        input: redactSecrets({ ...normalizedInput, policyTrace: decision.policyTrace }),
        createdAt: now
      };
      if (!invocation.runId) {
        delete invocation.runId;
      }
      await this.deps.invocations.create(invocation);

      await this.appendAndPublish(await this.eventForRun(input.runId, "approval.requested", {
        approvalId: approval.id,
        toolInvocationId: invocation.id
      }));

      return {
        statusCode: 202,
        invocation,
        approval
      };
    }

    const startedAt = new Date().toISOString();
    const invocation: ToolInvocation = {
      id: `tool_${crypto.randomUUID()}`,
      runId: input.runId,
      type: "fake_echo",
      status: "running",
      input: redactSecrets({ ...normalizedInput, policyTrace: decision.policyTrace }),
      createdAt: startedAt
    };
    if (!invocation.runId) {
      delete invocation.runId;
    }
    await this.deps.invocations.create(invocation);
    await this.appendAndPublish(await this.eventForRun(input.runId, "tool.call", {
      toolInvocationId: invocation.id,
      type: invocation.type
    }));

    const adapter = this.deps.adapters.get("fake_echo");
    if (!adapter) {
      throw new ServiceError("internal_error", "fake_echo adapter is not configured");
    }

    try {
      const output = redactSecrets(await adapter.invoke(normalizedInput));
      invocation.status = "completed";
      invocation.output = output;
      invocation.completedAt = new Date().toISOString();
      await this.deps.invocations.update(invocation);
      await this.appendAndPublish(await this.eventForRun(input.runId, "tool.result", {
        toolInvocationId: invocation.id,
        status: invocation.status,
        output
      }));
      return { statusCode: 201, invocation };
    } catch (error) {
      invocation.status = "failed";
      invocation.error = redactSecrets({
        code: "tool_execution_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      invocation.completedAt = new Date().toISOString();
      await this.deps.invocations.update(invocation);
      await this.appendAndPublish(await this.eventForRun(input.runId, "tool.result", {
        toolInvocationId: invocation.id,
        status: invocation.status,
        error: invocation.error
      }));
      this.deps.logger?.warn("tool.invoke_failed", {
        toolInvocationId: invocation.id,
        reason: invocation.error.message
      });
      return { statusCode: 201, invocation };
    }
  }

  async list(filter: ListToolInvocationsFilter): Promise<ListToolInvocationsResult> {
    return this.deps.invocations.list(filter);
  }

  async get(id: string): Promise<ToolInvocation | undefined> {
    return this.deps.invocations.get(id);
  }

  async resolveQueuedByApproval(approval: Approval): Promise<ToolInvocation | null> {
    const linked = await this.deps.invocations.listByApproval(approval.id);
    const queued = linked.find((item) => item.status === "queued");
    if (!queued) {
      return null;
    }

    if (approval.status === "approved") {
      queued.status = "running";
      await this.deps.invocations.update(queued);
      await this.appendAndPublish(await this.eventForRun(queued.runId, "tool.call", {
        toolInvocationId: queued.id,
        type: queued.type,
        resumedByApprovalId: approval.id
      }));

      const adapter = this.deps.adapters.get("fake_echo");
      if (!adapter) {
        throw new ServiceError("internal_error", "fake_echo adapter is not configured");
      }
      try {
        const output = redactSecrets(await adapter.invoke(queued.input));
        queued.status = "completed";
        queued.output = output;
        queued.completedAt = new Date().toISOString();
      } catch (error) {
        queued.status = "failed";
        queued.error = redactSecrets({
          code: "tool_execution_failed",
          message: error instanceof Error ? error.message : String(error)
        });
        queued.completedAt = new Date().toISOString();
      }

      await this.deps.invocations.update(queued);
      await this.appendAndPublish(await this.eventForRun(queued.runId, "tool.result", {
        toolInvocationId: queued.id,
        status: queued.status,
        output: queued.output,
        error: queued.error
      }));
      return queued;
    }

    if (approval.status === "rejected") {
      queued.status = "denied";
      queued.error = {
        code: "approval_rejected",
        message: "Tool invocation denied because approval was rejected"
      };
      queued.completedAt = new Date().toISOString();
      await this.deps.invocations.update(queued);
      await this.appendAndPublish(await this.eventForRun(queued.runId, "tool.result", {
        toolInvocationId: queued.id,
        status: "denied",
        reason: "approval_rejected"
      }));
      return queued;
    }

    return null;
  }

  private async requireRun(id: string) {
    const run = await this.deps.runs.get(id);
    if (!run) {
      throw new ServiceError("run_not_found", `Run not found: ${id}`);
    }
    return run;
  }

  private async persistDeniedInvocation(
    runId: string | undefined,
    type: ToolInvocation["type"],
    normalizedInput: Record<string, unknown>,
    policyTrace: Array<Record<string, unknown>>,
    reason: string
  ): Promise<ToolInvocation> {
    const now = new Date().toISOString();
    const invocation: ToolInvocation = {
      id: `tool_${crypto.randomUUID()}`,
      type,
      status: "denied",
      input: redactSecrets({ ...normalizedInput, policyTrace }),
      error: { code: "tool_policy_denied", message: reason },
      createdAt: now,
      completedAt: now
    };
    if (runId) {
      invocation.runId = runId;
    }
    await this.deps.invocations.create(invocation);
    return invocation;
  }

  private async appendAndPublish(event: SwitchyardEvent): Promise<void> {
    await this.deps.events.append(event);
    if (!this.deps.eventBus) {
      return;
    }
    try {
      await this.deps.eventBus.publish(event);
    } catch (error) {
      this.deps.logger?.warn("tool.invoke_failed", {
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

export { ServiceError as ToolRouterError };
