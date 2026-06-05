import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  approvalStatusSchema,
  approvalTypeSchema,
  createToolInvocationRequestSchema,
  decodeCursor,
  isHostedRuntimeBridgeSupportedMode,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  toolInvocationStatusSchema,
  toolTypeSchema,
  type Approval,
  type ToolInvocation
} from "@switchyard/contracts";
import type {
  ApprovalStore,
  ControlPlaneService,
  ControlPlaneStore,
  HostedRuntimeBridgeService,
  HostedToolService,
  RunStore,
  ToolInvocationStore
} from "@switchyard/core";
import { ControlPlaneError, HostedRuntimeBridgeServiceError } from "@switchyard/core";
import { getHostedAuthContext } from "./hosted-auth.js";
import { sendHttpError } from "./http-errors.js";

type ListCursor = { createdAt: string; id: string };

export interface HostedToolRouteDependencies {
  hostedTools: Pick<HostedToolService, "invoke" | "resolveApproval">;
  runs: Pick<RunStore, "get">;
  invocations: Pick<ToolInvocationStore, "get" | "list">;
  approvals: Pick<ApprovalStore, "get" | "list">;
  controlPlane?: ControlPlaneService;
  controlPlaneStore?: ControlPlaneStore;
  hostedRuntimeBridge?: Pick<HostedRuntimeBridgeService, "resolveRuntimeApproval">;
}

const STATUS_BY_TOOL_CODE: Record<string, number> = {
  tool_run_required: 400,
  tool_target_invalid: 400,
  tool_target_mismatch: 409,
  tool_hosted_auth_required: 401,
  tool_store_unavailable: 503,
  tool_dispatch_unavailable: 503,
  tool_dispatch_failed: 503,
  tool_dispatch_retry_exhausted: 503,
  tool_policy_denied: 403,
  tool_policy_config_invalid: 403,
  tool_policy_failed: 409,
  tool_real_tools_disabled: 403,
  tool_hosted_tools_disabled: 403,
  tool_connected_node_tools_disabled: 403,
  tool_approval_required: 409,
  tool_approval_rejected: 409,
  tool_approval_expired: 409,
  tool_adapter_unavailable: 500,
  tool_invocation_not_found: 404,
  tool_input_limit_exceeded: 400,
  tool_concurrency_limit_exceeded: 409,
  tool_output_limit_exceeded: 409,
  tool_artifact_write_failed: 500,
  tool_redaction_failed: 500,
  tool_worker_restarted: 503,
  tool_node_unavailable: 409,
  tool_node_execution_failed: 500,
  tool_assignment_expired: 409,
  tool_assignment_mismatch: 409,
  hosted_runtime_approval_bridge_unshipped: 409,
  hosted_runtime_bridge_non_idempotent_retry_blocked: 409,
  approval_scope_denied: 403,
  repo_hosted_unshipped: 409,
  browser_tool_unshipped: 409,
  adapter_protocol_failed: 409,
  invalid_input: 400,
  invalid_query: 400,
  run_not_found: 404,
  approval_not_found: 404,
  approval_not_pending: 409,
  entitlement_denied: 403,
  quota_exceeded: 429,
  internal_error: 500
};

export function registerHostedToolRoutes(app: FastifyInstance, deps: HostedToolRouteDependencies): void {
  app.post("/tools/invocations", async (request, reply) => {
    const controlPlane = deps.controlPlane;
    const auth = getHostedAuthContext(request);
    if (controlPlane && !auth) {
      return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
    }

    const body = ensureRecord(request.body);
    let parsed: ReturnType<typeof createToolInvocationRequestSchema.parse>;
    try {
      parsed = createToolInvocationRequestSchema.parse(body);
    } catch {
      return sendToolHttpError(reply, "invalid_input", "tool invocation input is invalid", [{ path: "input", issue: "invalid tool input" }]);
    }

    if (!parsed.runId) {
      return sendToolHttpError(reply, "tool_run_required", "Hosted tool invocation requires runId", [{ path: "runId", issue: "required" }]);
    }

    if (!controlPlane || !auth) {
      return sendToolHttpError(reply, "tool_hosted_auth_required", "Hosted tools require API key auth");
    }

    try {
      const runOwned = await controlPlane.authorizeResource({
        auth,
        resourceType: "run",
        resourceId: parsed.runId,
        notFoundCode: "run_not_found"
      });
      if (!runOwned.ok) {
        return sendHttpError(reply, runOwned.code, runOwned.reasonCode, [{ path: "reasonCode", issue: runOwned.reasonCode }]);
      }

      const run = await deps.runs.get(parsed.runId);
      if (!run) {
        return sendToolHttpError(reply, "run_not_found", `Run not found: ${parsed.runId}`);
      }

      const targetPlacement = parsed.target?.placement ?? (run.placement === "connected_local_node" ? "connected_local_node" : "hosted");
      if (targetPlacement !== "hosted" && targetPlacement !== "connected_local_node") {
        return sendToolHttpError(reply, "tool_target_invalid", "Hosted tool target placement is invalid");
      }

      const entitlementCheck = checkToolEntitlements(auth.entitlement as Record<string, unknown>, targetPlacement, parsed.type);
      if (!entitlementCheck.ok) {
        return sendToolHttpError(reply, "entitlement_denied", entitlementCheck.reasonCode, [{ path: "reasonCode", issue: entitlementCheck.reasonCode }]);
      }

      const quotaCheck = await checkToolQuotaAvailability({
        ...(deps.controlPlaneStore ? { controlPlaneStore: deps.controlPlaneStore } : {}),
        invocations: deps.invocations,
        auth,
        nowIso: new Date().toISOString()
      });
      if (!quotaCheck.ok) {
        return sendToolHttpError(reply, quotaCheck.code, quotaCheck.reasonCode, [{ path: "reasonCode", issue: quotaCheck.reasonCode }]);
      }

      const target = targetPlacement === "connected_local_node"
        ? {
            placement: "connected_local_node" as const,
            ...(parsed.target && "nodeId" in parsed.target && parsed.target.nodeId ? { nodeId: parsed.target.nodeId } : {})
          }
        : { placement: "hosted" as const };

      const invokeInput: Parameters<HostedToolService["invoke"]>[0] = {
        runId: parsed.runId,
        type: parsed.type,
        input: parsed.input,
        target
      };
      if (parsed.approvalPolicy) {
        invokeInput.approvalPolicy = parsed.approvalPolicy;
      }

      const result = await deps.hostedTools.invoke(invokeInput);
      return reply.code(202).send({ invocation: result.invocation, ...(result.approval ? { approval: result.approval } : {}) });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/tools/invocations", async (request, reply) => {
    const controlPlane = deps.controlPlane;
    const auth = getHostedAuthContext(request);
    if (controlPlane && !auth) {
      return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
    }
    if (!controlPlane || !auth) {
      return sendToolHttpError(reply, "tool_hosted_auth_required", "Hosted tools require API key auth");
    }

    try {
      const query = ensureRecord(request.query);
      const limit = parseLimit(query["limit"]);
      const before = parseCursor(query["before"]);
      const type = parseOptionalEnum(query["type"], toolTypeSchema, "type");
      const status = parseOptionalEnum(query["status"], toolInvocationStatusSchema, "status");
      const runId = optionalString(query, "runId");
      const approvalId = optionalString(query, "approvalId");

      const owned = await listOwnedToolInvocations({
        deps,
        auth,
        limit,
        ...(runId ? { runId } : {}),
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(approvalId ? { approvalId } : {}),
        ...(before ? { before } : {})
      });

      return reply.send({
        invocations: owned.invocations,
        nextCursor: owned.nextCursor ? encodeCursor(owned.nextCursor) : null
      });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/tools/invocations/:id", async (request, reply) => {
    const controlPlane = deps.controlPlane;
    const auth = getHostedAuthContext(request);
    if (controlPlane && !auth) {
      return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
    }
    if (!controlPlane || !auth) {
      return sendToolHttpError(reply, "tool_hosted_auth_required", "Hosted tools require API key auth");
    }

    const id = (request.params as { id: string }).id;
    try {
      const owned = await controlPlane.authorizeResource({
        auth,
        resourceType: "tool_invocation",
        resourceId: id,
        notFoundCode: "tool_invocation_not_found"
      });
      if (!owned.ok) {
        return sendHttpError(reply, owned.code, owned.reasonCode, [{ path: "reasonCode", issue: owned.reasonCode }]);
      }
      const invocation = await deps.invocations.get(id);
      if (!invocation) {
        return sendToolHttpError(reply, "tool_invocation_not_found", `Tool invocation not found: ${id}`);
      }
      return reply.send({ invocation });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/approvals", async (request, reply) => {
    const controlPlane = deps.controlPlane;
    const auth = getHostedAuthContext(request);
    if (controlPlane && !auth) {
      return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
    }
    if (!controlPlane || !auth) {
      return sendToolHttpError(reply, "tool_hosted_auth_required", "Hosted tools require API key auth");
    }

    try {
      const query = ensureRecord(request.query);
      const limit = parseLimit(query["limit"]);
      const before = parseCursor(query["before"]);
      const status = parseOptionalEnum(query["status"], approvalStatusSchema, "status");
      const approvalType = parseOptionalEnum(query["approvalType"], approvalTypeSchema, "approvalType");
      const runId = optionalString(query, "runId");

      const result = await listOwnedApprovals({
        deps,
        auth,
        limit,
        ...(runId ? { runId } : {}),
        ...(status ? { status } : {}),
        ...(approvalType ? { approvalType } : {}),
        ...(before ? { before } : {})
      });

      return reply.send({
        approvals: result.approvals,
        nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null
      });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.get("/approvals/:id", async (request, reply) => {
    const controlPlane = deps.controlPlane;
    const auth = getHostedAuthContext(request);
    if (controlPlane && !auth) {
      return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
    }
    if (!controlPlane || !auth) {
      return sendToolHttpError(reply, "tool_hosted_auth_required", "Hosted tools require API key auth");
    }

    const id = (request.params as { id: string }).id;
    try {
      const owned = await controlPlane.authorizeResource({
        auth,
        resourceType: "approval",
        resourceId: id,
        notFoundCode: "approval_not_found"
      });
      if (!owned.ok) {
        return sendHttpError(reply, owned.code, owned.reasonCode, [{ path: "reasonCode", issue: owned.reasonCode }]);
      }

      const approval = await deps.approvals.get(id);
      if (!approval) {
        return sendToolHttpError(reply, "approval_not_found", `Approval not found: ${id}`);
      }

      const scope = classifyApprovalScope(approval);
      if (scope === "runtime") {
        if (!(await isSupportedRuntimeApproval(deps, approval))) {
          return sendToolHttpError(reply, "hosted_runtime_approval_bridge_unshipped", "Runtime approval bridge is not available for this runtime");
        }
        return reply.send({ approval });
      }
      if (scope !== "tool") {
        return sendToolHttpError(reply, "approval_scope_denied", "Hosted tool approval route only resolves tool-scoped approvals");
      }

      return reply.send({ approval });
    } catch (error) {
      return handleRouteError(reply, error);
    }
  });

  app.post("/approvals/:id/approve", async (request, reply) => {
    await handleResolveApproval(request.params as { id: string }, "approved", reply, deps);
  });

  app.post("/approvals/:id/reject", async (request, reply) => {
    await handleResolveApproval(request.params as { id: string }, "rejected", reply, deps);
  });
}

async function handleResolveApproval(
  params: { id: string },
  decision: "approved" | "rejected",
  reply: FastifyReply,
  deps: HostedToolRouteDependencies
): Promise<FastifyReply | void> {
  const controlPlane = deps.controlPlane;
  const auth = getHostedAuthContext(reply.request);
  if (controlPlane && !auth) {
    return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
  }
  if (!controlPlane || !auth) {
    return sendToolHttpError(reply, "tool_hosted_auth_required", "Hosted tools require API key auth");
  }

  try {
    const owned = await controlPlane.authorizeResource({
      auth,
      resourceType: "approval",
      resourceId: params.id,
      notFoundCode: "approval_not_found"
    });
    if (!owned.ok) {
      return sendHttpError(reply, owned.code, owned.reasonCode, [{ path: "reasonCode", issue: owned.reasonCode }]);
    }

    const approval = await deps.approvals.get(params.id);
    if (!approval) {
      return sendToolHttpError(reply, "approval_not_found", `Approval not found: ${params.id}`);
    }

    const scope = classifyApprovalScope(approval);
    if (scope === "runtime") {
      if (!deps.hostedRuntimeBridge) {
        return sendToolHttpError(reply, "hosted_runtime_approval_bridge_unshipped", "Runtime approvals are not resolved through hosted bridge routes");
      }
      const body = resolveApprovalBody(reply.request.body);
      const idempotencyKey = readIdempotencyKey(reply.request);
      const resolved = await deps.hostedRuntimeBridge.resolveRuntimeApproval({
        approvalId: params.id,
        decision,
        ...(body ? { body } : {}),
        ...(auth ? { auth } : {}),
        requestId: reply.request.id,
        ...(idempotencyKey ? { idempotencyKey } : {})
      });
      return reply.send({ approval: resolved.approval, bridgeCommandId: resolved.commandId });
    }
    if (scope !== "tool") {
      return sendToolHttpError(reply, "approval_scope_denied", "Hosted tool approval route only resolves tool-scoped approvals");
    }

    const resolved = await deps.hostedTools.resolveApproval(params.id, decision);
    return reply.send({ approval: resolved.approval, invocation: resolved.invocation });
  } catch (error) {
    return handleRouteError(reply, error);
  }
}

async function listOwnedToolInvocations(input: {
  deps: HostedToolRouteDependencies;
  auth: { account: { id: string }; tenant: { id: string }; project: { id: string } };
  runId?: string;
  type?: ToolInvocation["type"];
  status?: ToolInvocation["status"];
  approvalId?: string;
  limit: number;
  before?: ListCursor;
}): Promise<{ invocations: ToolInvocation[]; nextCursor: ListCursor | null }> {
  const store = input.deps.controlPlaneStore;
  if (!store) {
    throw toolRouteError("tool_store_unavailable", "control plane store unavailable");
  }

  const ids = await store.listOwnedResourceIds({
    resourceType: "tool_invocation",
    accountId: input.auth.account.id,
    tenantId: input.auth.tenant.id,
    projectId: input.auth.project.id
  });

  const records = await Promise.all(ids.map((id) => input.deps.invocations.get(id)));
  const pageRows = records
    .filter((entry): entry is ToolInvocation => Boolean(entry))
    .filter((entry) => {
      if (input.runId && entry.runId !== input.runId) {
        return false;
      }
      if (input.type && entry.type !== input.type) {
        return false;
      }
      if (input.status && entry.status !== input.status) {
        return false;
      }
      if (input.approvalId && entry.approvalId !== input.approvalId) {
        return false;
      }
      if (!input.before) {
        return true;
      }
      if (entry.createdAt < input.before.createdAt) {
        return true;
      }
      if (entry.createdAt > input.before.createdAt) {
        return false;
      }
      return entry.id < input.before.id;
    })
    .sort((left, right) => (left.createdAt === right.createdAt ? right.id.localeCompare(left.id) : left.createdAt > right.createdAt ? -1 : 1));

  const page = pageRows.slice(0, input.limit);
  const hasMore = pageRows.length > input.limit;
  const last = page.at(-1);
  return {
    invocations: page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
  };
}

async function listOwnedApprovals(input: {
  deps: HostedToolRouteDependencies;
  auth: { account: { id: string }; tenant: { id: string }; project: { id: string } };
  runId?: string;
  status?: Approval["status"];
  approvalType?: Approval["approvalType"];
  limit: number;
  before?: ListCursor;
}): Promise<{ approvals: Approval[]; nextCursor: ListCursor | null }> {
  const store = input.deps.controlPlaneStore;
  if (!store) {
    throw toolRouteError("tool_store_unavailable", "control plane store unavailable");
  }

  const ids = await store.listOwnedResourceIds({
    resourceType: "approval",
    accountId: input.auth.account.id,
    tenantId: input.auth.tenant.id,
    projectId: input.auth.project.id
  });

  const records = await Promise.all(ids.map((id) => input.deps.approvals.get(id)));
  const filtered: Approval[] = [];
  for (const entry of records) {
    if (!entry) {
      continue;
    }
    const scope = classifyApprovalScope(entry);
    const allowed = scope === "tool" || (scope === "runtime" && await isSupportedRuntimeApproval(input.deps, entry));
    if (!allowed) {
      continue;
    }
    if (input.runId && entry.runId !== input.runId) {
      continue;
    }
    if (input.status && entry.status !== input.status) {
      continue;
    }
    if (input.approvalType && entry.approvalType !== input.approvalType) {
      continue;
    }
    if (input.before) {
      if (entry.createdAt > input.before.createdAt) {
        continue;
      }
      if (entry.createdAt === input.before.createdAt && entry.id >= input.before.id) {
        continue;
      }
    }
    filtered.push(entry);
  }
  const pageRows = filtered
    .sort((left, right) => (left.createdAt === right.createdAt ? right.id.localeCompare(left.id) : left.createdAt > right.createdAt ? -1 : 1));

  const page = pageRows.slice(0, input.limit);
  const hasMore = pageRows.length > input.limit;
  const last = page.at(-1);
  return {
    approvals: page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
  };
}

async function isSupportedRuntimeApproval(
  deps: HostedToolRouteDependencies,
  approval: Approval
): Promise<boolean> {
  const runtimeApprovalToken = approval.payload["runtimeApprovalToken"];
  if (typeof runtimeApprovalToken !== "string" || runtimeApprovalToken.length === 0) {
    return false;
  }

  const payloadRuntimeMode = approval.payload["runtimeMode"];
  if (typeof payloadRuntimeMode === "string" && payloadRuntimeMode.length > 0) {
    return isHostedRuntimeBridgeSupportedMode(payloadRuntimeMode, "approval_resolution");
  }

  if (!approval.runId) {
    return false;
  }
  const run = await deps.runs.get(approval.runId);
  if (!run) {
    return false;
  }
  return isHostedRuntimeBridgeSupportedMode(run.runtimeMode ?? run.runtime, "approval_resolution");
}

function classifyApprovalScope(approval: Approval): "tool" | "runtime" | "other" {
  if (typeof approval.payload["toolInvocationId"] === "string") {
    return "tool";
  }
  if (typeof approval.payload["runtimeApprovalToken"] === "string") {
    return "runtime";
  }
  return "other";
}

async function checkToolQuotaAvailability(input: {
  controlPlaneStore?: ControlPlaneStore;
  invocations: Pick<ToolInvocationStore, "get">;
  auth: { account: { id: string }; tenant: { id: string }; project: { id: string }; entitlement: Record<string, unknown> };
  nowIso: string;
}): Promise<{ ok: true } | { ok: false; code: "quota_exceeded" | "tool_store_unavailable"; reasonCode: string }> {
  if (!input.controlPlaneStore) {
    return { ok: false, code: "tool_store_unavailable", reasonCode: "quota_store_unavailable" };
  }

  const quotas = resolveQuotaSnapshot(input.auth.entitlement);
  const maxActive = asOptionalNonNegativeNumber(quotas["maxActiveToolInvocations"]);
  const maxHourly = asOptionalNonNegativeNumber(quotas["maxToolInvocationsPerHour"]);

  const ownedIds = await input.controlPlaneStore.listOwnedResourceIds({
    resourceType: "tool_invocation",
    accountId: input.auth.account.id,
    tenantId: input.auth.tenant.id,
    projectId: input.auth.project.id
  });

  const invocations = await Promise.all(ownedIds.map((id) => input.invocations.get(id)));
  const activeCount = invocations.filter((entry) => entry && (entry.status === "queued" || entry.status === "running")).length;
  if (maxActive !== undefined && activeCount >= maxActive) {
    return { ok: false, code: "quota_exceeded", reasonCode: "active_tool_invocations_exceeded" };
  }

  const windowStart = Date.parse(input.nowIso) - 60 * 60 * 1000;
  const hourlyCount = invocations.filter((entry) => entry && Date.parse(entry.createdAt) >= windowStart).length;
  if (maxHourly !== undefined && hourlyCount >= maxHourly) {
    return { ok: false, code: "quota_exceeded", reasonCode: "tool_invocations_per_hour_exceeded" };
  }

  return { ok: true };
}

function checkToolEntitlements(
  entitlement: Record<string, unknown>,
  placement: "hosted" | "connected_local_node",
  toolType: ToolInvocation["type"]
): { ok: true } | { ok: false; reasonCode: string } {
  const details = resolveEntitlementDetails(entitlement);
  const allowedPlacements = asStringArray(details["allowedPlacements"]);
  const allowHostedTools = details["allowHostedTools"] === true
    || (details["allowHostedTools"] === undefined && allowedPlacements.includes("hosted"));
  const allowConnectedNodes = details["allowConnectedNodes"] === true
    || (details["allowConnectedNodes"] === undefined && allowedPlacements.includes("connected_local_node"));
  const allowConnectedNodeTools = details["allowConnectedNodeTools"] === true
    || (details["allowConnectedNodeTools"] === undefined && allowConnectedNodes);
  const allowedToolTypes = asStringArray(details["allowedToolTypes"]);
  const effectiveAllowedTypes = allowedToolTypes.length > 0
    ? allowedToolTypes
    : ["web_search", "fetch", "browser", "repo", "shell", "github", "fake_echo"];

  if (placement === "hosted" && !allowHostedTools) {
    return { ok: false, reasonCode: "hosted_tools_disabled" };
  }
  if (placement === "connected_local_node" && (!allowConnectedNodes || !allowConnectedNodeTools)) {
    return { ok: false, reasonCode: "connected_node_tools_disabled" };
  }
  if (!effectiveAllowedTypes.includes(toolType)) {
    return { ok: false, reasonCode: "tool_type_not_entitled" };
  }
  return { ok: true };
}

function asOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveEntitlementDetails(entitlement: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(entitlement["entitlements"]);
  if (Object.keys(nested).length > 0) {
    return nested;
  }
  return entitlement;
}

function resolveQuotaSnapshot(entitlement: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(entitlement["quotas"]);
  if (Object.keys(nested).length > 0) {
    return nested;
  }
  return entitlement;
}

function parseOptionalEnum<T>(value: unknown, schema: { parse: (value: unknown) => T }, path: string): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return schema.parse(value);
  } catch {
    throw toolRouteError("invalid_query", `${path} is invalid`, [{ path, issue: "invalid value" }]);
  }
}

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return LIST_LIMIT_DEFAULT;
  }
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0 || parsed > LIST_LIMIT_MAX) {
    throw toolRouteError("invalid_query", "limit must be between 1 and 200", [{ path: "limit", issue: "must be an integer between 1 and 200" }]);
  }
  return parsed;
}

function parseCursor(value: unknown): ListCursor | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw toolRouteError("invalid_query", "Malformed cursor", [{ path: "before", issue: "must be an opaque cursor from a previous response" }]);
  }
  try {
    return decodeCursor(value, ["createdAt", "id"] as const);
  } catch {
    throw toolRouteError("invalid_query", "Malformed cursor", [{ path: "before", issue: "must be an opaque cursor from a previous response" }]);
  }
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw toolRouteError("invalid_input", "Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw toolRouteError("invalid_query", `${key} must be a string`, [{ path: key, issue: "must be a string" }]);
  }
  return value;
}

function handleRouteError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ControlPlaneError) {
    return sendHttpError(reply, error.code, error.reasonCode, [{ path: "reasonCode", issue: error.reasonCode }]);
  }
  if (error instanceof HostedRuntimeBridgeServiceError) {
    if (error.code === "invalid_input") {
      return sendHttpError(reply, "invalid_input", error.message, bridgeDetails(error));
    }
    if (error.code === "adapter_protocol_failed") {
      return sendHttpError(reply, "adapter_protocol_failed", error.message, bridgeDetails(error));
    }
    if (error.code === "approval_not_pending") {
      return sendHttpError(reply, "approval_not_pending", error.message, bridgeDetails(error));
    }
    if (error.code === "approval_not_found") {
      return sendHttpError(reply, "approval_not_found", error.message, bridgeDetails(error));
    }
    if (error.code === "run_not_found") {
      return sendHttpError(reply, "run_not_found", error.message, bridgeDetails(error));
    }
    if (error.code === "quota_exceeded") {
      return sendHttpError(reply, "quota_exceeded", error.message, bridgeDetails(error));
    }
    return sendHttpError(reply, "internal_error", error.message, bridgeDetails(error));
  }

  if (!error || typeof error !== "object") {
    throw error;
  }

  const serviceError = error as { code?: unknown; message?: unknown; details?: Array<{ path: string; issue: string }> };
  if (typeof serviceError.code === "string" && typeof serviceError.message === "string") {
    return sendToolHttpError(reply, serviceError.code, serviceError.message, serviceError.details);
  }

  throw error;
}

function sendToolHttpError(
  reply: FastifyReply,
  code: string,
  message: string,
  details?: Array<{ path: string; issue: string }>
): FastifyReply {
  const status = STATUS_BY_TOOL_CODE[code] ?? 500;
  const requestId = reply.request.id;
  if (requestId) {
    reply.header("x-request-id", requestId);
  }
  const payload: {
    error: {
      code: string;
      message: string;
      details?: Array<{ path: string; issue: string }>;
      requestId?: string;
    };
  } = {
    error: { code, message }
  };
  if (details && details.length > 0) {
    payload.error.details = details;
  }
  if (requestId) {
    payload.error.requestId = requestId;
  }
  return reply.code(status).send(payload);
}

function bridgeDetails(error: HostedRuntimeBridgeServiceError): Array<{ path: string; issue: string }> | undefined {
  if (error.details && error.details.length > 0) {
    return error.details;
  }
  if (error.reasonCode) {
    return [{ path: "reasonCode", issue: error.reasonCode }];
  }
  return undefined;
}

function resolveApprovalBody(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  if (typeof header === "string" && header.trim().length > 0) {
    return header.trim();
  }
  if (Array.isArray(header) && typeof header[0] === "string" && header[0].trim().length > 0) {
    return header[0].trim();
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function toolRouteError(
  code: string,
  message: string,
  details?: Array<{ path: string; issue: string }>
): Error & { code: string; details?: Array<{ path: string; issue: string }> } {
  const error = new Error(message) as Error & { code: string; details?: Array<{ path: string; issue: string }> };
  error.code = code;
  if (details) {
    error.details = details;
  }
  return error;
}
