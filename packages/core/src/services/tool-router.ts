import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Approval, Artifact, SwitchyardEvent, ToolInvocation } from "@switchyard/contracts";
import type { ApprovalStore } from "../ports/approval-store.js";
import type { ArtifactContentStore } from "../ports/artifact-content-store.js";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { EventStore } from "../ports/event-store.js";
import type { RunStore } from "../ports/run-store.js";
import type { ToolAdapter } from "../ports/tool-adapter.js";
import type { ListToolInvocationsFilter, ListToolInvocationsResult, ToolInvocationStore } from "../ports/tool-invocation-store.js";
import type { ToolExecutionPlan, ToolPolicyPort } from "../ports/policy.js";
import type { EventBus } from "./event-bus.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";
import { redactSecrets } from "./local-policy-gate.js";

const KNOWN_TOOL_TYPES = new Set(["web_search", "fetch", "browser", "repo", "shell", "github", "fake_echo"]);

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
  artifacts?: ArtifactStore;
  artifactContent?: ArtifactContentStore;
  metrics?: {
    inc(path: string, labels?: Record<string, string>): void;
  };
  eventBus?: EventBus;
  logger?: RuntimeLogger;
  clock?: () => Date;
}

export class ToolRouter {
  private readonly approvalResolutionTails = new Map<string, Promise<void>>();

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

    if (decision.decision === "deny") {
      const denied = await this.persistDeniedInvocation(
        input.runId,
        input.type as ToolInvocation["type"],
        normalizedInput,
        decision.policyTrace,
        decision.reasonCode
      );
      this.deps.metrics?.inc("tool.policy.denied", {
        toolType: input.type,
        reason: decision.reasonCode
      });
      throw new ServiceError("tool_policy_denied", "Tool invocation denied by policy", [
        { path: "toolInvocationId", issue: denied.id }
      ]);
    }

    if (decision.decision === "approval_required") {
      const now = this.nowIso();
      const invocationId = `tool_${crypto.randomUUID()}`;
      const approvalId = `approval_${crypto.randomUUID()}`;
      const executionPlanHash = hashExecutionPlan(decision.executionPlan);
      const invocation: ToolInvocation = {
        id: invocationId,
        runId: input.runId,
        type: input.type as ToolInvocation["type"],
        status: "queued",
        approvalId,
        input: redactSecrets({
          request: normalizedInput,
          reasonCode: decision.reasonCode,
          policyTrace: decision.policyTrace,
          executionPlan: decision.executionPlan,
          executionPlanHash
        }),
        createdAt: now
      };
      if (!invocation.runId) {
        delete invocation.runId;
      }
      await this.deps.invocations.create(invocation);

      const approval: Approval = {
        id: approvalId,
        runId: input.runId,
        status: "pending",
        approvalType: decision.approvalType,
        payload: redactSecrets({
          toolInvocationId: invocation.id,
          toolType: invocation.type,
          reasonCode: decision.reasonCode,
          policyTrace: decision.policyTrace,
          actionSummary: `${invocation.type} request requires approval`,
          executionPlanHash,
          executionPlan: decision.executionPlan,
          request: normalizedInput,
          expiresAt: decision.expiresAt
        }),
        createdAt: now
      };
      if (!approval.runId) {
        delete approval.runId;
      }
      await this.deps.approvals.create(approval);

      await this.appendAndPublish(await this.eventForRun(input.runId, "approval.requested", {
        approvalId: approval.id,
        toolInvocationId: invocation.id,
        toolType: invocation.type
      }));
      this.deps.metrics?.inc("tool.approval.queued", { toolType: invocation.type });

      return {
        statusCode: 202,
        invocation,
        approval
      };
    }

    const executionPlan = decision.executionPlan;
    const startedAt = this.nowIso();
    const invocation: ToolInvocation = {
      id: `tool_${crypto.randomUUID()}`,
      runId: input.runId,
      type: input.type as ToolInvocation["type"],
      status: "running",
      input: redactSecrets({
        request: normalizedInput,
        reasonCode: decision.reasonCode,
        policyTrace: decision.policyTrace,
        executionPlan,
        executionPlanHash: hashExecutionPlan(executionPlan)
      }),
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

    const terminal = await this.executeInvocation(invocation, normalizedInput, executionPlan);
    this.deps.metrics?.inc("tool.invocation", {
      toolType: invocation.type,
      status: terminal.status,
      reason: terminal.error?.code ?? "none"
    });
    return { statusCode: 201, invocation: terminal };
  }

  async list(filter: ListToolInvocationsFilter): Promise<ListToolInvocationsResult> {
    return this.deps.invocations.list(filter);
  }

  async get(id: string): Promise<ToolInvocation | undefined> {
    return this.deps.invocations.get(id);
  }

  async resolveQueuedByApproval(approval: Approval): Promise<ToolInvocation | null> {
    return this.withApprovalResolutionLock(approval.id, async () => {
      const linked = await this.deps.invocations.listByApproval(approval.id);
      const queued = linked.find((item) => item.status === "queued");
      if (!queued) {
        return null;
      }

      if (approval.status === "approved") {
        const runningAttempt: ToolInvocation = { ...queued, status: "running" };
        const running = await this.deps.invocations.updateIfStatus(queued.id, "queued", runningAttempt);
        if (!running) {
          return null;
        }

        const request = extractRequest(running.input);
        const policyDecision = await this.deps.policy.decideTool({
          runApprovalPolicy: await this.resolveRunApprovalPolicy(running.runId),
          type: running.type,
          input: request
        });
        if (policyDecision.decision === "deny") {
          return this.transitionInvocation(running, {
            status: "denied",
            error: {
              code: "tool_policy_denied",
              message: "Tool invocation denied by policy revalidation"
            }
          });
        }

        const storedHash = typeof running.input["executionPlanHash"] === "string"
          ? running.input["executionPlanHash"]
          : undefined;
        const recomputedHash = hashExecutionPlan(policyDecision.executionPlan);
        if (storedHash && storedHash !== recomputedHash) {
          return this.transitionInvocation(running, {
            status: "denied",
            error: {
              code: "tool_policy_failed",
              message: "Tool execution plan changed after approval"
            }
          });
        }

        await this.appendAndPublish(await this.eventForRun(running.runId, "tool.call", {
          toolInvocationId: running.id,
          type: running.type,
          resumedByApprovalId: approval.id
        }));

        const terminal = await this.executeInvocation(running, request, policyDecision.executionPlan);
        this.deps.metrics?.inc("tool.invocation", {
          toolType: running.type,
          status: terminal.status,
          reason: terminal.error?.code ?? "none"
        });
        return terminal;
      }

      if (approval.status === "rejected" || approval.status === "expired") {
        const reasonCode = approval.status === "expired" ? "tool_approval_expired" : "tool_approval_rejected";
        const message = approval.status === "expired"
          ? "Tool invocation denied because approval expired"
          : "Tool invocation denied because approval was rejected";
        const denied = await this.transitionInvocation(queued, {
          status: "denied",
          error: { code: reasonCode, message }
        });
        this.deps.metrics?.inc("tool.approval.expired", {
          toolType: denied.type,
          status: approval.status
        });
        return denied;
      }

      return null;
    });
  }

  async reconcileInterruptedInvocations(): Promise<{ failed: number }> {
    let before: { createdAt: string; id: string } | undefined;
    let failed = 0;

    while (true) {
      const page = await this.deps.invocations.list({ limit: 200, status: "running", ...(before ? { before } : {}) });
      if (page.invocations.length === 0) {
        break;
      }
      for (const invocation of page.invocations) {
        if (invocation.type === "fake_echo") {
          continue;
        }
        const terminal = await this.transitionInvocation(invocation, {
          status: "failed",
          error: {
            code: "daemon_restarted",
            message: "Tool invocation interrupted by daemon restart"
          }
        });
        if (terminal.status === "failed") {
          failed += 1;
        }
      }
      if (!page.nextCursor) {
        break;
      }
      before = page.nextCursor;
    }

    return { failed };
  }

  private async executeInvocation(
    invocation: ToolInvocation,
    request: Record<string, unknown>,
    executionPlan: ToolExecutionPlan
  ): Promise<ToolInvocation> {
    const adapter = this.deps.adapters.get(invocation.type);
    if (!adapter) {
      return this.transitionInvocation(invocation, {
        status: "failed",
        error: {
          code: "tool_adapter_unavailable",
          message: `Tool adapter not configured for ${invocation.type}`
        }
      });
    }

    const adapterInput = invocation.type === "fake_echo"
      ? request
      : { request, executionPlan };

    try {
      const output = redactSecrets(await adapter.invoke(adapterInput));
      const storedOutput = await this.persistArtifactsIfAny(invocation, output);
      return this.transitionInvocation(invocation, {
        status: "completed",
        output: storedOutput
      });
    } catch (error) {
      const reasonCode = extractReasonCode(error) ?? "tool_execution_failed";
      const message = error instanceof Error ? error.message : String(error);
      return this.transitionInvocation(invocation, {
        status: "failed",
        error: redactSecrets({
          code: reasonCode,
          message
        })
      });
    }
  }

  private async persistArtifactsIfAny(
    invocation: ToolInvocation,
    output: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const candidates = Array.isArray(output["artifactCandidates"])
      ? output["artifactCandidates"].filter((entry) => entry && typeof entry === "object") as Array<Record<string, unknown>>
      : [];
    if (candidates.length === 0) {
      return output;
    }
    if (!this.deps.artifacts || !this.deps.artifactContent) {
      throw new ServiceError("tool_artifact_write_failed", "Tool artifact stores are not configured");
    }

    const artifactIds: string[] = [];
    for (const candidate of candidates) {
      const logicalPath = typeof candidate["logicalPath"] === "string" ? candidate["logicalPath"] : "output.log";
      const artifactType = typeof candidate["type"] === "string" ? candidate["type"] : "raw_log";
      if (artifactType !== "raw_log" && artifactType !== "diff" && artifactType !== "summary") {
        continue;
      }
      const content = typeof candidate["content"] === "string" ? candidate["content"] : "";
      const contentType = typeof candidate["contentType"] === "string" ? candidate["contentType"] : "text/plain";
      const safeName = sanitizeArtifactName(logicalPath);
      const artifactPath = invocation.runId
        ? `runs/${invocation.runId}/tools/${invocation.id}/${safeName}`
        : `tools/${invocation.id}/${safeName}`;

      const stored = await this.deps.artifactContent.writeText(artifactPath, content, { contentType });
      const artifact: Artifact = {
        id: `artifact_${crypto.randomUUID()}`,
        runId: invocation.runId,
        type: artifactType,
        path: stored.path,
        metadata: redactSecrets({
          ...(candidate["metadata"] && typeof candidate["metadata"] === "object" ? candidate["metadata"] as Record<string, unknown> : {}),
          storageBackend: stored.storageBackend,
          sha256: stored.sha256,
          sizeBytes: stored.sizeBytes,
          contentType: stored.contentType,
          toolInvocationId: invocation.id,
          logicalPath: safeName
        }),
        createdAt: this.nowIso()
      };
      if (!artifact.runId) {
        delete artifact.runId;
      }
      await this.deps.artifacts.create(artifact);
      artifactIds.push(artifact.id);
    }

    const nextOutput = { ...output };
    if (artifactIds.length > 0) {
      nextOutput["artifactIds"] = artifactIds;
    }
    delete nextOutput["artifactCandidates"];
    return nextOutput;
  }

  private async transitionInvocation(
    invocation: ToolInvocation,
    input: {
      status: ToolInvocation["status"];
      output?: Record<string, unknown>;
      error?: { code: string; message: string };
    }
  ): Promise<ToolInvocation> {
    const next: ToolInvocation = {
      ...invocation,
      status: input.status,
      completedAt: this.nowIso(),
      ...(input.output ? { output: input.output } : {}),
      ...(input.error ? { error: input.error } : {})
    };
    const updated = invocation.status === "queued" || invocation.status === "running"
      ? await this.deps.invocations.updateIfStatus(invocation.id, invocation.status, next)
      : await this.deps.invocations.update(invocation).then(() => next);
    const terminal = updated ?? next;
    await this.appendAndPublish(await this.eventForRun(terminal.runId, "tool.result", {
      toolInvocationId: terminal.id,
      status: terminal.status,
      output: terminal.output,
      error: terminal.error
    }));
    return terminal;
  }

  private async withApprovalResolutionLock<T>(approvalId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.approvalResolutionTails.get(approvalId) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.approvalResolutionTails.set(approvalId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.approvalResolutionTails.get(approvalId) === tail) {
        this.approvalResolutionTails.delete(approvalId);
      }
    }
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
    reasonCode: string
  ): Promise<ToolInvocation> {
    const now = this.nowIso();
    const invocation: ToolInvocation = {
      id: `tool_${crypto.randomUUID()}`,
      type,
      status: "denied",
      input: redactSecrets({ request: normalizedInput, policyTrace }),
      error: { code: reasonCode, message: "Tool invocation denied by policy" },
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
      createdAt: this.nowIso()
    };
    if (runId) {
      event.runId = runId;
    }
    return event;
  }

  private nowIso(): string {
    return (this.deps.clock ? this.deps.clock() : new Date()).toISOString();
  }

  private async resolveRunApprovalPolicy(runId?: string): Promise<string | undefined> {
    if (!runId) {
      return undefined;
    }
    const run = await this.deps.runs.get(runId);
    return run?.approvalPolicy;
  }
}

function extractRequest(input: Record<string, unknown>): Record<string, unknown> {
  const request = input["request"];
  if (request && typeof request === "object" && !Array.isArray(request)) {
    return request as Record<string, unknown>;
  }
  return input;
}

function sanitizeArtifactName(logicalPath: string): string {
  const safe = basename(logicalPath).replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "artifact.log";
}

function extractReasonCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as { reasonCode?: unknown; code?: unknown };
  if (typeof record.reasonCode === "string" && record.reasonCode.length > 0) {
    return record.reasonCode;
  }
  if (typeof record.code === "string" && record.code.length > 0) {
    return record.code;
  }
  return undefined;
}

export function hashExecutionPlan(plan: ToolExecutionPlan): string {
  return createHash("sha256").update(canonicalJson(plan)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export { ServiceError as ToolRouterError };
