import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ArtifactSyncService,
  ControlPlaneService,
  EventSyncService,
  NodeCoordinatorService
} from "@switchyard/core";
import { ControlPlaneError, redactSecrets } from "@switchyard/core";
import type { AuthContext, ToolInvocation } from "@switchyard/contracts";
import {
  assignmentArtifactManifestRequestSchema,
  assignmentClaimRequestSchema,
  assignmentCompleteRequestSchema,
  assignmentEventSyncRequestSchema,
  assignmentRejectRequestSchema,
  nodeHeartbeatRequestSchema,
  nodeRegisterRequestSchema
} from "@switchyard/contracts";
import { sendHttpError, type HttpErrorCode, type HttpErrorDetail } from "@switchyard/protocol-rest";

const FORBIDDEN_QUERY_CREDENTIAL_KEYS = new Set(["api_key", "token", "authorization"]);
const SYSTEM_AUDIT_ACCOUNT_ID = "account_system";
const SYSTEM_AUDIT_TENANT_ID = "tenant_system";
const SYSTEM_AUDIT_PROJECT_ID = "project_system";

type NodeDeploymentMode = "local" | "test" | "staging" | "production";

type NodeActorType = "api_key" | "node_token";

export interface NodeTokenBinding {
  token: string;
  auth: AuthContext;
}

interface NodeRouteAuthState {
  auth: AuthContext;
  actorType: NodeActorType;
}

export interface NodeRouteDependencies {
  coordinator: NodeCoordinatorService;
  eventSync: EventSyncService;
  artifactSync: ArtifactSyncService;
  resolveToolInvocation?: (input: {
    nodeId: string;
    assignmentId: string;
    runId: string;
    toolInvocationId: string;
  }) => Promise<ToolInvocation | null>;
  completeToolAssignment?: (input: {
    nodeId: string;
    assignmentId: string;
    status: "completed" | "failed" | "cancelled";
    error?: string;
    toolInvocation: {
      id: string;
      status: "completed" | "failed" | "cancelled";
      output?: Record<string, unknown>;
      error?: { code: string; message: string };
      completedAt?: string;
    };
  }) => Promise<void>;
  sharedToken?: string;
  requireAuth?: boolean;
  jsonBodyLimitBytes?: number;
  artifactBodyLimitBytes?: number;
  controlPlane?: ControlPlaneService;
  deploymentMode?: NodeDeploymentMode;
  nodeTokenBindings?: readonly NodeTokenBinding[];
}

export function registerNodeRoutes(app: FastifyInstance, deps: NodeRouteDependencies): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!isNodeRoute(request)) return;

    if (!isHostedControlPlaneMode(deps)) {
      return handleLegacyNodeAuth(request, reply, deps);
    }

    try {
      request.nodeRouteAuth = await authenticateHostedNodeRequest(request, deps);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        await auditNodeAuthFailure(request, deps, error);
        return sendHttpError(reply, error.code, error.reasonCode, controlPlaneDetails(error));
      }
      throw error;
    }
  });

  app.addHook("preValidation", async (request, reply) => {
    if (!isNodeRoute(request)) return;
    if (request.method !== "PUT") {
      const limit = deps.jsonBodyLimitBytes ?? 512 * 1024;
      const size = Buffer.byteLength(JSON.stringify(request.body ?? {}), "utf8");
      if (size > limit) {
        return sendHttpError(reply, "payload_too_large", "Node JSON payload exceeds limit");
      }
      return;
    }
    const limit = deps.artifactBodyLimitBytes ?? 2 * 1024 * 1024;
    const contentLengthHeader = request.headers["content-length"];
    const contentLength = typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : Number.NaN;
    if (Number.isFinite(contentLength) && contentLength > limit) {
      return sendHttpError(reply, "payload_too_large", "Node artifact payload exceeds limit");
    }
  });

  app.post("/nodes/register", async (request, reply) => {
    const hosted = isHostedControlPlaneMode(deps);
    const auth = hosted ? getHostedNodeAuth(request) : undefined;
    const controlPlane = deps.controlPlane;

    const body = nodeRegisterRequestSchema.parse(request.body ?? {});
    const policyCheck = validateNodePolicyForSecrets(body.policy);
    if (!policyCheck.ok) {
      return sendHttpError(reply, "invalid_input", "Node policy contains secret-like fields", [policyCheck.detail]);
    }
    const registerId = body.id ?? `node_${randomUUID()}`;
    const input: Parameters<NodeCoordinatorService["register"]>[0] = {
      id: registerId,
      mode: body.mode,
      capabilities: body.capabilities
    };
    if (body.policy !== undefined) input.policy = redactSecrets(body.policy);
    if (body.version !== undefined) input.version = body.version;

    let reservationId: string | undefined;
    try {
      if (hosted && controlPlane && auth) {
        const reservation = await controlPlane.preflightNodeRegister({
          auth,
          nodeId: registerId
        });
        reservationId = reservation.id;
      }

      const node = await deps.coordinator.register(input);

      if (hosted && controlPlane && auth) {
        const ownership = await controlPlane.ensureOwnedOrAttachFromRun({
          auth,
          resourceType: "node",
          resourceId: node.id,
          runId: node.id
        });
        if (!ownership.ok) {
          await failReservation(controlPlane, auth, reservationId, "ownership_attach_failed");
          reservationId = undefined;
          await bestEffortMarkNodeOffline(deps.coordinator, node.id);
          await auditNodeDecision(controlPlane, {
            auth,
            eventType: "node.register_denied",
            decision: "deny",
            reasonCode: "ownership_attach_failed",
            resourceType: "node",
            resourceId: node.id,
            requestId: request.id,
            payload: { routeId: "nodes.register" }
          });
          return sendHttpError(reply, "internal_error", "ownership_attach_failed", [{ path: "reasonCode", issue: "ownership_attach_failed" }]);
        }

        await consumeReservation(controlPlane, auth, reservationId, "node_register_allowed");
        reservationId = undefined;
        await auditNodeDecision(controlPlane, {
          auth,
          eventType: "node.register_allowed",
          decision: "allow",
          reasonCode: "node_register_allowed",
          resourceType: "node",
          resourceId: node.id,
          requestId: request.id,
          payload: { routeId: "nodes.register" }
        });
      }

      return reply.code(201).send({ node });
    } catch (error) {
      if (hosted && controlPlane && auth && error instanceof ControlPlaneError) {
        await failReservation(controlPlane, auth, reservationId, error.reasonCode);
        await auditNodeDecision(controlPlane, {
          auth,
          eventType: error.code === "tenant_access_denied" ? "tenant.access_denied" : "node.register_denied",
          decision: "deny",
          reasonCode: error.reasonCode,
          resourceType: "node",
          resourceId: registerId,
          requestId: request.id,
          payload: { routeId: "nodes.register" }
        });
        return sendHttpError(reply, error.code, error.reasonCode, controlPlaneDetails(error));
      }
      if (hosted && controlPlane && auth) {
        await failReservation(controlPlane, auth, reservationId, "node_register_failed");
      }
      throw error;
    }
  });

  app.post("/nodes/:id/heartbeat", async (request, reply) => {
    const nodeId = (request.params as { id: string }).id;
    const hosted = isHostedControlPlaneMode(deps);
    const auth = hosted ? getHostedNodeAuth(request) : undefined;
    const controlPlane = deps.controlPlane;

    try {
      if (hosted && controlPlane && auth) {
        const owned = await controlPlane.authorizeResource({
          auth,
          resourceType: "node",
          resourceId: nodeId,
          notFoundCode: "node_not_found"
        });
        if (!owned.ok) {
          await auditNodeDecision(controlPlane, {
            auth,
            eventType: "tenant.access_denied",
            decision: "deny",
            reasonCode: owned.reasonCode,
            resourceType: "node",
            resourceId: nodeId,
            requestId: request.id,
            payload: { routeId: "nodes.heartbeat" }
          });
          return sendHttpError(reply, owned.code, owned.reasonCode, [{ path: "reasonCode", issue: owned.reasonCode }]);
        }
      }

      const body = nodeHeartbeatRequestSchema.parse(request.body ?? {});
      const policyCheck = validateNodePolicyForSecrets(body.policy);
      if (!policyCheck.ok) {
        return sendHttpError(reply, "invalid_input", "Node policy contains secret-like fields", [policyCheck.detail]);
      }
      const input: Parameters<NodeCoordinatorService["heartbeat"]>[1] = {};
      if (body.capabilities !== undefined) input.capabilities = body.capabilities;
      if (body.policy !== undefined) input.policy = redactSecrets(body.policy);
      const node = await deps.coordinator.heartbeat(nodeId, input);

      if (hosted && controlPlane && auth) {
        const ownership = await controlPlane.ensureOwnedOrAttachFromRun({
          auth,
          resourceType: "node",
          resourceId: node.id,
          runId: node.id
        });
        if (!ownership.ok) {
          await auditNodeDecision(controlPlane, {
            auth,
            eventType: "node.register_denied",
            decision: "error",
            reasonCode: "ownership_attach_failed",
            resourceType: "node",
            resourceId: node.id,
            requestId: request.id,
            payload: { routeId: "nodes.heartbeat" }
          });
          return sendHttpError(reply, "internal_error", "ownership_attach_failed", [{ path: "reasonCode", issue: "ownership_attach_failed" }]);
        }
        await auditNodeDecision(controlPlane, {
          auth,
          eventType: "node.register_allowed",
          decision: "allow",
          reasonCode: "node_heartbeat_allowed",
          resourceType: "node",
          resourceId: node.id,
          requestId: request.id,
          payload: { routeId: "nodes.heartbeat" }
        });
      }

      return reply.send({ node });
    } catch (error) {
      if ((error as { code?: string }).code === "node_not_found") {
        return sendHttpError(reply, "node_not_found", `Node not found: ${nodeId}`);
      }
      throw error;
    }
  });

  app.get("/nodes", async (request) => {
    const nodes = await deps.coordinator.list();
    const hosted = isHostedControlPlaneMode(deps);
    const auth = hosted ? getHostedNodeAuth(request) : undefined;
    const controlPlane = deps.controlPlane;

    if (!hosted || !controlPlane || !auth) {
      return { nodes };
    }

    const scoped = [];
    for (const node of nodes) {
      const owned = await controlPlane.authorizeResource({
        auth,
        resourceType: "node",
        resourceId: node.id,
        notFoundCode: "node_not_found"
      });
      if (owned.ok) {
        scoped.push(node);
      }
    }
    return { nodes: scoped };
  });

  app.get("/nodes/:id", async (request, reply) => {
    const nodeId = (request.params as { id: string }).id;
    const hosted = isHostedControlPlaneMode(deps);
    const auth = hosted ? getHostedNodeAuth(request) : undefined;
    const controlPlane = deps.controlPlane;

    if (hosted && controlPlane && auth) {
      const owned = await controlPlane.authorizeResource({
        auth,
        resourceType: "node",
        resourceId: nodeId,
        notFoundCode: "node_not_found"
      });
      if (!owned.ok) {
        await auditNodeDecision(controlPlane, {
          auth,
          eventType: "tenant.access_denied",
          decision: "deny",
          reasonCode: owned.reasonCode,
          resourceType: "node",
          resourceId: nodeId,
          requestId: request.id,
          payload: { routeId: "nodes.get" }
        });
        return sendHttpError(reply, owned.code, owned.reasonCode, [{ path: "reasonCode", issue: owned.reasonCode }]);
      }
    }

    const node = await deps.coordinator.get(nodeId);
    if (!node) {
      return sendHttpError(reply, "node_not_found", `Node not found: ${nodeId}`);
    }
    return { node };
  });

  app.post("/nodes/:id/assignments/claim", async (request, reply) => {
    const nodeId = (request.params as { id: string }).id;
    const hosted = isHostedControlPlaneMode(deps);
    const auth = hosted ? getHostedNodeAuth(request) : undefined;
    const controlPlane = deps.controlPlane;
    const body = assignmentClaimRequestSchema.parse(request.body ?? {});

    if (hosted && controlPlane && auth) {
      const authorizeInput: Parameters<typeof authorizeNodeAndAssignment>[0] = {
        controlPlane,
        auth,
        nodeId,
        requestId: request.id,
        routeId: "nodes.claim"
      };
      if (body.assignmentId !== undefined) {
        authorizeInput.assignmentId = body.assignmentId;
      }
      const denied = await authorizeNodeAndAssignment(authorizeInput);
      if (denied) {
        return sendHttpError(reply, denied.code, denied.reasonCode, [{ path: "reasonCode", issue: denied.reasonCode }]);
      }
    }

    try {
      const claimed = await deps.coordinator.claim(nodeId, body.assignmentId);
      const toolClaim = await resolveToolClaimPayload(deps, claimed, nodeId);
      if (hosted && controlPlane && auth && claimed?.assignment) {
        const assignmentScope = await controlPlane.authorizeResource({
          auth,
          resourceType: "assignment",
          resourceId: claimed.assignment.id,
          notFoundCode: "assignment_not_found"
        });
        if (!assignmentScope.ok) {
          await rollbackClaimAssignment(deps.coordinator, nodeId, claimed.assignment.id);
          await auditNodeDecision(controlPlane, {
            auth,
            eventType: "tenant.access_denied",
            decision: "deny",
            reasonCode: assignmentScope.reasonCode,
            resourceType: "assignment",
            resourceId: claimed.assignment.id,
            requestId: request.id,
            payload: { routeId: "nodes.claim" }
          });
          return sendHttpError(reply, assignmentScope.code, assignmentScope.reasonCode, [{ path: "reasonCode", issue: assignmentScope.reasonCode }]);
        }
      }
      if (hosted && controlPlane && auth && claimed?.run) {
        const runScope = await controlPlane.authorizeResource({
          auth,
          resourceType: "run",
          resourceId: claimed.run.id,
          notFoundCode: "run_not_found"
        });
        if (!runScope.ok) {
          if (claimed.assignment) {
            await rollbackClaimAssignment(deps.coordinator, nodeId, claimed.assignment.id);
          }
          await auditNodeDecision(controlPlane, {
            auth,
            eventType: "tenant.access_denied",
            decision: "deny",
            reasonCode: runScope.reasonCode,
            resourceType: "run",
            resourceId: claimed.run.id,
            requestId: request.id,
            payload: { routeId: "nodes.claim" }
          });
          return sendHttpError(reply, runScope.code, runScope.reasonCode, [{ path: "reasonCode", issue: runScope.reasonCode }]);
        }
      }
      if (hosted && controlPlane && auth && toolClaim) {
        const invocationScope = await controlPlane.authorizeResource({
          auth,
          resourceType: "tool_invocation",
          resourceId: toolClaim.id,
          notFoundCode: "tool_invocation_not_found"
        });
        if (!invocationScope.ok) {
          if (claimed?.assignment) {
            await rollbackClaimAssignment(deps.coordinator, nodeId, claimed.assignment.id);
          }
          await auditNodeDecision(controlPlane, {
            auth,
            eventType: "tenant.access_denied",
            decision: "deny",
            reasonCode: invocationScope.reasonCode,
            resourceType: "tool_invocation",
            resourceId: toolClaim.id,
            requestId: request.id,
            payload: { routeId: "nodes.claim" }
          });
          return sendHttpError(reply, invocationScope.code, invocationScope.reasonCode, [{ path: "reasonCode", issue: invocationScope.reasonCode }]);
        }
      }
      if (hosted && controlPlane && auth) {
        await auditNodeDecision(controlPlane, {
          auth,
          eventType: "node.register_allowed",
          decision: "allow",
          reasonCode: "assignment_claim_allowed",
          resourceType: "assignment",
          resourceId: body.assignmentId ?? "auto",
          requestId: request.id,
          payload: { routeId: "nodes.claim" }
        });
      }
      return reply.send({
        assignment: claimed?.assignment ?? null,
        run: claimed?.run ?? null,
        toolInvocation: toolClaim ? redactAssignmentToolInvocation(toolClaim) : null
      });
    } catch (error) {
      if ((error as { code?: string }).code === "assignment_not_found") {
        return sendHttpError(reply, "assignment_not_found", "Assignment run not found");
      }
      if ((error as { code?: string }).code === "assignment_claim_conflict") {
        return sendHttpError(reply, "assignment_claim_conflict", "Assignment is already claimed");
      }
      if ((error as { code?: string }).code === "tool_invocation_not_found") {
        return sendHttpError(reply, "tool_invocation_not_found", "Tool invocation not found");
      }
      throw error;
    }
  });

  app.post("/nodes/:id/assignments/:assignmentId/reject", async (request, reply) => {
    const params = request.params as { id: string; assignmentId: string };
    const hosted = isHostedControlPlaneMode(deps);
    const auth = hosted ? getHostedNodeAuth(request) : undefined;
    const controlPlane = deps.controlPlane;

    if (hosted && controlPlane && auth) {
      const denied = await authorizeNodeAndAssignment({
        controlPlane,
        auth,
        nodeId: params.id,
        assignmentId: params.assignmentId,
        requestId: request.id,
        routeId: "nodes.reject"
      });
      if (denied) {
        return sendHttpError(reply, denied.code, denied.reasonCode, [{ path: "reasonCode", issue: denied.reasonCode }]);
      }
    }

    const body = assignmentRejectRequestSchema.parse(request.body ?? {});
    try {
      const assignment = await deps.coordinator.reject(params.id, params.assignmentId, body.reason);
      if (hosted && controlPlane && auth) {
        await auditNodeDecision(controlPlane, {
          auth,
          eventType: "node.register_allowed",
          decision: "allow",
          reasonCode: "assignment_reject_allowed",
          resourceType: "assignment",
          resourceId: params.assignmentId,
          requestId: request.id,
          payload: { routeId: "nodes.reject" }
        });
      }
      return reply.send({ assignment });
    } catch (error) {
      if ((error as { code?: string }).code === "assignment_not_found") {
        return sendHttpError(reply, "assignment_not_found", `Assignment not found: ${params.assignmentId}`);
      }
      throw error;
    }
  });

  app.post("/nodes/:id/assignments/:assignmentId/events", async (request, reply) => {
    const params = request.params as { id: string; assignmentId: string };
    const hosted = isHostedControlPlaneMode(deps);
    const auth = hosted ? getHostedNodeAuth(request) : undefined;
    const controlPlane = deps.controlPlane;

    if (hosted && controlPlane && auth) {
      const denied = await authorizeNodeAndAssignment({
        controlPlane,
        auth,
        nodeId: params.id,
        assignmentId: params.assignmentId,
        requestId: request.id,
        routeId: "nodes.sync.events"
      });
      if (denied) {
        return sendHttpError(reply, denied.code, denied.reasonCode, [{ path: "reasonCode", issue: denied.reasonCode }]);
      }
    }

    try {
      const body = assignmentEventSyncRequestSchema.parse(request.body ?? {});
      const input: Parameters<EventSyncService["appendBatch"]>[2] = {
        events: body.events
      };
      if (body.cursor !== undefined) input.cursor = body.cursor;
      const result = await deps.eventSync.appendBatch(params.id, params.assignmentId, input);

      if (hosted && controlPlane && auth) {
        for (const event of body.events) {
          const ownership = await controlPlane.ensureOwnedOrAttachFromRun({
            auth,
            resourceType: "run_event",
            resourceId: event.id,
            runId: event.runId ?? params.assignmentId
          });
          if (!ownership.ok) {
            await auditNodeDecision(controlPlane, {
              auth,
              eventType: "node.register_denied",
              decision: "error",
              reasonCode: "ownership_attach_failed",
              resourceType: "assignment",
              resourceId: params.assignmentId,
              requestId: request.id,
              payload: { routeId: "nodes.sync.events" }
            });
            return sendHttpError(reply, "internal_error", "ownership_attach_failed", [{ path: "reasonCode", issue: "ownership_attach_failed" }]);
          }
        }

        await auditNodeDecision(controlPlane, {
          auth,
          eventType: "node.register_allowed",
          decision: "allow",
          reasonCode: "assignment_event_sync_allowed",
          resourceType: "assignment",
          resourceId: params.assignmentId,
          requestId: request.id,
          payload: { routeId: "nodes.sync.events" }
        });
      }

      return reply.send(result);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "assignment_not_found") return sendHttpError(reply, "assignment_not_found", "Assignment not found");
      if (code === "event_sync_gap") return sendHttpError(reply, "event_sync_gap", "Event sequence gap detected");
      if (code === "event_sync_conflict") return sendHttpError(reply, "event_sync_conflict", "Event sequence conflict detected");
      throw error;
    }
  });

  app.post("/nodes/:id/assignments/:assignmentId/artifacts/manifest", async (request, reply) => {
    const params = request.params as { id: string; assignmentId: string };
    const hosted = isHostedControlPlaneMode(deps);
    const auth = hosted ? getHostedNodeAuth(request) : undefined;
    const controlPlane = deps.controlPlane;

    if (hosted && controlPlane && auth) {
      const denied = await authorizeNodeAndAssignment({
        controlPlane,
        auth,
        nodeId: params.id,
        assignmentId: params.assignmentId,
        requestId: request.id,
        routeId: "nodes.sync.artifacts.manifest"
      });
      if (denied) {
        return sendHttpError(reply, denied.code, denied.reasonCode, [{ path: "reasonCode", issue: denied.reasonCode }]);
      }
    }

    try {
      const body = assignmentArtifactManifestRequestSchema.parse(request.body ?? {});
      const result = await deps.artifactSync.acceptManifest(params.id, params.assignmentId, body);

      if (hosted && controlPlane && auth) {
        for (const artifact of body.artifacts) {
          const ownership = await controlPlane.ensureOwnedOrAttachFromRun({
            auth,
            resourceType: "artifact",
            resourceId: artifact.id,
            runId: params.assignmentId
          });
          if (!ownership.ok) {
            await auditNodeDecision(controlPlane, {
              auth,
              eventType: "node.register_denied",
              decision: "error",
              reasonCode: "ownership_attach_failed",
              resourceType: "assignment",
              resourceId: params.assignmentId,
              requestId: request.id,
              payload: { routeId: "nodes.sync.artifacts.manifest" }
            });
            return sendHttpError(reply, "internal_error", "ownership_attach_failed", [{ path: "reasonCode", issue: "ownership_attach_failed" }]);
          }
        }

        await auditNodeDecision(controlPlane, {
          auth,
          eventType: "node.register_allowed",
          decision: "allow",
          reasonCode: "assignment_artifact_manifest_allowed",
          resourceType: "assignment",
          resourceId: params.assignmentId,
          requestId: request.id,
          payload: { routeId: "nodes.sync.artifacts.manifest" }
        });
      }

      return reply.send(result);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "assignment_not_found") return sendHttpError(reply, "assignment_not_found", "Assignment not found");
      if (code === "invalid_input") return sendHttpError(reply, "invalid_input", (error as Error).message);
      throw error;
    }
  });

  app.put("/nodes/:id/assignments/:assignmentId/artifacts/:artifactId/content", async (request, reply) => {
    const params = request.params as { id: string; assignmentId: string; artifactId: string };
    const hosted = isHostedControlPlaneMode(deps);
    const auth = hosted ? getHostedNodeAuth(request) : undefined;
    const controlPlane = deps.controlPlane;

    if (hosted && controlPlane && auth) {
      const denied = await authorizeNodeAndAssignment({
        controlPlane,
        auth,
        nodeId: params.id,
        assignmentId: params.assignmentId,
        requestId: request.id,
        routeId: "nodes.sync.artifacts.content"
      });
      if (denied) {
        return sendHttpError(reply, denied.code, denied.reasonCode, [{ path: "reasonCode", issue: denied.reasonCode }]);
      }
    }

    const body = asBuffer(request);
    try {
      const result = await deps.artifactSync.acceptContent(params.id, params.assignmentId, params.artifactId, body);

      if (hosted && controlPlane && auth) {
        const ownership = await controlPlane.ensureOwnedOrAttachFromRun({
          auth,
          resourceType: "artifact",
          resourceId: params.artifactId,
          runId: params.assignmentId
        });
        if (!ownership.ok) {
          await auditNodeDecision(controlPlane, {
            auth,
            eventType: "node.register_denied",
            decision: "error",
            reasonCode: "ownership_attach_failed",
            resourceType: "assignment",
            resourceId: params.assignmentId,
            requestId: request.id,
            payload: { routeId: "nodes.sync.artifacts.content" }
          });
          return sendHttpError(reply, "internal_error", "ownership_attach_failed", [{ path: "reasonCode", issue: "ownership_attach_failed" }]);
        }

        await auditNodeDecision(controlPlane, {
          auth,
          eventType: "node.register_allowed",
          decision: "allow",
          reasonCode: "assignment_artifact_content_allowed",
          resourceType: "assignment",
          resourceId: params.assignmentId,
          requestId: request.id,
          payload: { routeId: "nodes.sync.artifacts.content" }
        });
      }

      return reply.send(result);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "assignment_not_found") return sendHttpError(reply, "assignment_not_found", "Assignment not found");
      if (code === "artifact_digest_mismatch") return sendHttpError(reply, "artifact_digest_mismatch", "Artifact digest mismatch");
      if (code === "artifact_sync_failed") return sendHttpError(reply, "artifact_sync_failed", "Artifact sync failed");
      if (code === "invalid_input") return sendHttpError(reply, "invalid_input", (error as Error).message);
      throw error;
    }
  });

  app.post("/nodes/:id/assignments/:assignmentId/complete", async (request, reply) => {
    const params = request.params as { id: string; assignmentId: string };
    const hosted = isHostedControlPlaneMode(deps);
    const auth = hosted ? getHostedNodeAuth(request) : undefined;
    const controlPlane = deps.controlPlane;

    if (hosted && controlPlane && auth) {
      const denied = await authorizeNodeAndAssignment({
        controlPlane,
        auth,
        nodeId: params.id,
        assignmentId: params.assignmentId,
        requestId: request.id,
        routeId: "nodes.complete"
      });
      if (denied) {
        return sendHttpError(reply, denied.code, denied.reasonCode, [{ path: "reasonCode", issue: denied.reasonCode }]);
      }
    }

    const body = assignmentCompleteRequestSchema.parse(request.body ?? {});
    try {
      if (body.toolInvocation && deps.completeToolAssignment) {
        const toolInvocationPayload: Parameters<NonNullable<NodeRouteDependencies["completeToolAssignment"]>>[0]["toolInvocation"] = {
          id: body.toolInvocation.id,
          status: body.toolInvocation.status,
          ...(body.toolInvocation.output ? { output: body.toolInvocation.output } : {}),
          ...(body.toolInvocation.error ? { error: body.toolInvocation.error } : {}),
          ...(body.toolInvocation.completedAt ? { completedAt: body.toolInvocation.completedAt } : {})
        };
        await deps.completeToolAssignment({
          nodeId: params.id,
          assignmentId: params.assignmentId,
          status: body.status,
          ...(body.error ? { error: body.error } : {}),
          toolInvocation: toolInvocationPayload
        });
      }
      const assignment = await deps.coordinator.complete(params.id, params.assignmentId, body.status, body.error);
      if (hosted && controlPlane && auth) {
        await auditNodeDecision(controlPlane, {
          auth,
          eventType: "node.register_allowed",
          decision: "allow",
          reasonCode: "assignment_complete_allowed",
          resourceType: "assignment",
          resourceId: params.assignmentId,
          requestId: request.id,
          payload: { routeId: "nodes.complete" }
        });
      }
      return reply.send({ assignment });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "tool_assignment_mismatch") {
        return sendHttpError(reply, "tool_assignment_mismatch", "Tool assignment completion payload mismatch");
      }
      if (code === "tool_invocation_not_found") {
        return sendHttpError(reply, "tool_invocation_not_found", "Tool invocation not found");
      }
      if ((error as { code?: string }).code === "assignment_not_found") {
        return sendHttpError(reply, "assignment_not_found", "Assignment not found");
      }
      throw error;
    }
  });
}

async function resolveToolClaimPayload(
  deps: NodeRouteDependencies,
  claimed: Awaited<ReturnType<NodeCoordinatorService["claim"]>>,
  nodeId: string
): Promise<ToolInvocation | null> {
  if (!claimed?.assignment || claimed.assignment.kind !== "tool") {
    return null;
  }
  const fromCoordinator = (claimed as unknown as { toolInvocation?: ToolInvocation | null }).toolInvocation;
  if (fromCoordinator) {
    return fromCoordinator;
  }
  if (!deps.resolveToolInvocation || !claimed.assignment.toolInvocationId) {
    throw { code: "tool_invocation_not_found" };
  }
  const invocation = await deps.resolveToolInvocation({
    nodeId,
    assignmentId: claimed.assignment.id,
    runId: claimed.run.id,
    toolInvocationId: claimed.assignment.toolInvocationId
  });
  if (!invocation) {
    throw { code: "tool_invocation_not_found" };
  }
  return invocation;
}

function redactAssignmentToolInvocation(invocation: ToolInvocation): ToolInvocation {
  const redactedInput = redactSecrets(invocation.input ?? {});
  return {
    ...invocation,
    input: stripSensitivePlanFields(redactedInput)
  };
}

function stripSensitivePlanFields(input: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input };
  if ("executionPlan" in next) {
    delete next["executionPlan"];
  }
  return next;
}

function asBuffer(request: FastifyRequest): Buffer {
  const raw = request.body;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  if (raw && typeof raw === "object") return Buffer.from(JSON.stringify(raw));
  return Buffer.alloc(0);
}

function tokenMatches(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

function isNodeRoute(request: FastifyRequest): boolean {
  return routePathname(request).startsWith("/nodes");
}

function routePathname(request: FastifyRequest): string {
  const [raw] = (request.raw.url ?? request.url ?? "/").split("?", 1);
  if (!raw || raw.length === 0) {
    return "/";
  }
  if (raw === "/") {
    return raw;
  }
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function isHostedControlPlaneMode(deps: NodeRouteDependencies): boolean {
  if (!deps.controlPlane) {
    return false;
  }
  return deps.deploymentMode !== "local" && deps.deploymentMode !== "test";
}

function handleLegacyNodeAuth(request: FastifyRequest, reply: { request: FastifyRequest }, deps: NodeRouteDependencies): void | ReturnType<typeof sendHttpError> {
  const token = request.headers["x-switchyard-node-token"];
  if (deps.requireAuth && !deps.sharedToken) {
    return sendHttpError(reply as never, "node_auth_required", "Node token is required");
  }
  if (!deps.sharedToken) return;
  if (typeof token !== "string" || !tokenMatches(token, deps.sharedToken)) {
    return sendHttpError(reply as never, "node_auth_failed", "Node token is invalid");
  }
}

async function authenticateHostedNodeRequest(request: FastifyRequest, deps: NodeRouteDependencies): Promise<NodeRouteAuthState> {
  const controlPlane = deps.controlPlane;
  if (!controlPlane) {
    throw new ControlPlaneError("auth_required", "auth_required");
  }

  const headers = request.headers as Record<string, string | string[] | undefined>;
  const query = asRecord(request.query);
  if (containsForbiddenQueryCredentials(query)) {
    throw new ControlPlaneError("auth_failed", "query_credentials_not_allowed");
  }

  if (hasApiCredentialHeader(headers)) {
    const authInput: Parameters<ControlPlaneService["authenticateRequest"]>[0] = { headers };
    if (query) {
      authInput.query = query;
    }
    const auth = await controlPlane.authenticateRequest(authInput);
    controlPlane.requireScope(auth, "nodes:write");
    return { auth, actorType: "api_key" };
  }

  const nodeToken = readHeader(headers, "x-switchyard-node-token");
  if (nodeToken !== undefined) {
    const trimmed = nodeToken.trim();
    if (trimmed.length === 0) {
      throw new ControlPlaneError("node_auth_failed", "blank_node_token");
    }

    const binding = findNodeTokenBinding(trimmed, deps.nodeTokenBindings);
    if (!binding) {
      throw new ControlPlaneError("node_auth_failed", "node_token_unbound");
    }

    validateBoundNodeAuth(binding.auth);
    controlPlane.requireScope(binding.auth, "nodes:write");
    return { auth: binding.auth, actorType: "node_token" };
  }

  throw new ControlPlaneError("auth_required", "auth_required");
}

function validateBoundNodeAuth(auth: AuthContext): void {
  const nowMs = Date.now();
  if (auth.apiKey.status !== "active") {
    throw new ControlPlaneError("auth_failed", auth.apiKey.status === "revoked" ? "api_key_revoked" : "api_key_inactive");
  }
  if (auth.apiKey.expiresAt && Date.parse(auth.apiKey.expiresAt) <= nowMs) {
    throw new ControlPlaneError("auth_failed", "api_key_expired");
  }
  if (auth.account.status !== "active") {
    throw new ControlPlaneError("auth_failed", "account_inactive");
  }
  if (auth.tenant.status !== "active") {
    throw new ControlPlaneError("auth_failed", "tenant_inactive");
  }
  if (auth.project.status !== "active") {
    throw new ControlPlaneError("auth_failed", "project_inactive");
  }
  if ((auth.user.status ?? "active") !== "active") {
    throw new ControlPlaneError("auth_failed", "user_inactive");
  }
}

function containsForbiddenQueryCredentials(query: Record<string, unknown> | undefined): boolean {
  if (!query) {
    return false;
  }
  for (const key of Object.keys(query)) {
    if (FORBIDDEN_QUERY_CREDENTIAL_KEYS.has(key.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function hasApiCredentialHeader(headers: Record<string, string | string[] | undefined>): boolean {
  return readHeader(headers, "authorization") !== undefined || readHeader(headers, "x-switchyard-api-key") !== undefined;
}

function readHeader(headers: Record<string, string | string[] | undefined>, headerName: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== headerName.toLowerCase()) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return "";
      const first = value[0];
      return typeof first === "string" ? first : "";
    }
    return undefined;
  }
  return undefined;
}

function findNodeTokenBinding(token: string, bindings: readonly NodeTokenBinding[] | undefined): NodeTokenBinding | null {
  if (!bindings || bindings.length === 0) {
    return null;
  }
  for (const binding of bindings) {
    if (tokenMatches(token, binding.token)) {
      return binding;
    }
  }
  return null;
}

function getHostedNodeAuth(request: FastifyRequest): AuthContext | undefined {
  return request.nodeRouteAuth?.auth;
}

async function authorizeNodeAndAssignment(input: {
  controlPlane: ControlPlaneService;
  auth: AuthContext;
  nodeId: string;
  assignmentId?: string;
  requestId?: string;
  routeId: string;
}): Promise<{ code: HttpErrorCode; reasonCode: string } | null> {
  const nodeOwned = await input.controlPlane.authorizeResource({
    auth: input.auth,
    resourceType: "node",
    resourceId: input.nodeId,
    notFoundCode: "node_not_found"
  });
  if (!nodeOwned.ok) {
    const auditInput: Omit<Parameters<ControlPlaneService["recordAudit"]>[0], "requestId"> & { requestId?: string } = {
      auth: input.auth,
      eventType: "tenant.access_denied",
      decision: "deny",
      reasonCode: nodeOwned.reasonCode,
      resourceType: "node",
      resourceId: input.nodeId,
      payload: { routeId: input.routeId }
    };
    if (input.requestId) {
      auditInput.requestId = input.requestId;
    }
    await auditNodeDecision(input.controlPlane, auditInput);
    return { code: nodeOwned.code, reasonCode: nodeOwned.reasonCode };
  }

  if (!input.assignmentId) {
    return null;
  }

  const assignmentOwned = await input.controlPlane.authorizeResource({
    auth: input.auth,
    resourceType: "assignment",
    resourceId: input.assignmentId,
    notFoundCode: "assignment_not_found"
  });
  if (!assignmentOwned.ok) {
    const auditInput: Omit<Parameters<ControlPlaneService["recordAudit"]>[0], "requestId"> & { requestId?: string } = {
      auth: input.auth,
      eventType: "tenant.access_denied",
      decision: "deny",
      reasonCode: assignmentOwned.reasonCode,
      resourceType: "assignment",
      resourceId: input.assignmentId,
      payload: { routeId: input.routeId }
    };
    if (input.requestId) {
      auditInput.requestId = input.requestId;
    }
    await auditNodeDecision(input.controlPlane, auditInput);
    return { code: assignmentOwned.code, reasonCode: assignmentOwned.reasonCode };
  }

  return null;
}

async function consumeReservation(
  controlPlane: ControlPlaneService,
  auth: AuthContext,
  reservationId: string | undefined,
  reasonCode: string
): Promise<void> {
  if (!reservationId) {
    return;
  }
  try {
    await controlPlane.releaseQuotaReservation({
      auth,
      reservationId,
      outcome: "consumed",
      reasonCode
    });
  } catch {
    // Best-effort release; route outcome remains authoritative.
  }
}

async function failReservation(
  controlPlane: ControlPlaneService,
  auth: AuthContext,
  reservationId: string | undefined,
  reasonCode: string
): Promise<void> {
  if (!reservationId) {
    return;
  }
  try {
    await controlPlane.releaseQuotaReservation({
      auth,
      reservationId,
      outcome: "failed",
      reasonCode
    });
  } catch {
    // Best-effort release; route outcome remains authoritative.
  }
}

async function bestEffortMarkNodeOffline(coordinator: NodeCoordinatorService, nodeId: string): Promise<void> {
  const candidate = coordinator as unknown as { markOffline?: (id: string) => Promise<unknown> };
  if (typeof candidate.markOffline !== "function") {
    return;
  }
  try {
    await candidate.markOffline(nodeId);
  } catch {
    // Best effort only.
  }
}

async function rollbackClaimAssignment(coordinator: NodeCoordinatorService, nodeId: string, assignmentId: string): Promise<void> {
  try {
    await coordinator.reject(nodeId, assignmentId, "tenant_access_denied");
  } catch {
    // Best effort only.
  }
}

async function auditNodeAuthFailure(
  request: FastifyRequest,
  deps: NodeRouteDependencies,
  error: ControlPlaneError
): Promise<void> {
  const controlPlane = deps.controlPlane;
  if (!controlPlane) {
    return;
  }

  const fallback = resolveFallbackAuditAuth(request, deps);
  const eventType = error.code === "tenant_access_denied" ? "tenant.access_denied" : "node.auth_failed";
  const payload = {
    routeId: "nodes.auth",
    method: request.method,
    pathname: routePathname(request)
  };

  if (fallback) {
    await auditNodeDecision(controlPlane, {
      auth: fallback,
      eventType,
      decision: "deny",
      reasonCode: error.reasonCode,
      resourceType: "auth",
      resourceId: "nodes.route",
      requestId: request.id,
      payload
    });
    return;
  }

  try {
    await controlPlane.recordAudit({
      accountId: SYSTEM_AUDIT_ACCOUNT_ID,
      tenantId: SYSTEM_AUDIT_TENANT_ID,
      projectId: SYSTEM_AUDIT_PROJECT_ID,
      actorType: "system",
      eventType,
      decision: "deny",
      reasonCode: error.reasonCode,
      resourceType: "auth",
      resourceId: "nodes.route",
      requestId: request.id,
      payload
    });
  } catch {
    // Best effort only.
  }
}

function resolveFallbackAuditAuth(request: FastifyRequest, deps: NodeRouteDependencies): AuthContext | undefined {
  const headers = request.headers as Record<string, string | string[] | undefined>;
  const token = readHeader(headers, "x-switchyard-node-token");
  if (!token) {
    return undefined;
  }
  const binding = findNodeTokenBinding(token.trim(), deps.nodeTokenBindings);
  return binding?.auth;
}

async function auditNodeDecision(
  controlPlane: ControlPlaneService,
  input: Omit<Parameters<ControlPlaneService["recordAudit"]>[0], "requestId"> & { requestId?: string }
): Promise<void> {
  const payload: Parameters<ControlPlaneService["recordAudit"]>[0] = { ...input };
  if (!input.requestId) {
    const mutable = payload as unknown as { requestId?: string };
    delete mutable.requestId;
  }
  try {
    await controlPlane.recordAudit(payload);
  } catch {
    // Best-effort only.
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function controlPlaneDetails(error: ControlPlaneError): HttpErrorDetail[] | undefined {
  const details: HttpErrorDetail[] = [{ path: "reasonCode", issue: error.reasonCode }];
  if (error.safeDetails) {
    for (const [key, value] of Object.entries(error.safeDetails)) {
      details.push({ path: key, issue: String(value) });
    }
  }
  return details;
}

const SECRET_LIKE_PATTERN = /(token|secret|password|authorization|apikey|cookie|privatekey|accesskey|credential|bearer|ghp_)/i;

function validateNodePolicyForSecrets(policy: unknown): { ok: true } | { ok: false; detail: HttpErrorDetail } {
  if (!policy || typeof policy !== "object") {
    return { ok: true };
  }
  return walkForSecrets(policy, "policy");
}

function walkForSecrets(
  value: unknown,
  path: string
): { ok: true } | { ok: false; detail: HttpErrorDetail } {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = walkForSecrets(value[index], `${path}.${index}`);
      if (!nested.ok) {
        return nested;
      }
    }
    return { ok: true };
  }
  if (typeof value === "string") {
    if (SECRET_LIKE_PATTERN.test(value) || /(?:^|[?&])(token|secret|password|apikey|authorization)=/i.test(value)) {
      return { ok: false, detail: { path, issue: "secret_like_value_forbidden" } };
    }
    return { ok: true };
  }
  if (!value || typeof value !== "object") {
    return { ok: true };
  }
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_LIKE_PATTERN.test(key)) {
      return { ok: false, detail: { path: `${path}.${key}`, issue: "secret_like_key_forbidden" } };
    }
    const nested = walkForSecrets(nestedValue, `${path}.${key}`);
    if (!nested.ok) {
      return nested;
    }
  }
  return { ok: true };
}

declare module "fastify" {
  interface FastifyRequest {
    nodeRouteAuth?: NodeRouteAuthState;
  }
}
