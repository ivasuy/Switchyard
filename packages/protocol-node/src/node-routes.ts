import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ArtifactSyncService,
  EventSyncService,
  NodeCoordinatorService
} from "@switchyard/core";
import {
  assignmentArtifactManifestRequestSchema,
  assignmentClaimRequestSchema,
  assignmentCompleteRequestSchema,
  assignmentEventSyncRequestSchema,
  assignmentRejectRequestSchema,
  nodeHeartbeatRequestSchema,
  nodeRegisterRequestSchema
} from "@switchyard/contracts";
import { sendHttpError } from "@switchyard/protocol-rest";

export interface NodeRouteDependencies {
  coordinator: NodeCoordinatorService;
  eventSync: EventSyncService;
  artifactSync: ArtifactSyncService;
  sharedToken?: string;
}

export function registerNodeRoutes(app: FastifyInstance, deps: NodeRouteDependencies): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/nodes")) return;
    if (!deps.sharedToken) return;
    const token = request.headers["x-switchyard-node-token"];
    if (token !== deps.sharedToken) {
      return sendHttpError(reply, "node_auth_failed", "Node token is invalid");
    }
  });

  app.post("/nodes/register", async (request, reply) => {
    const body = nodeRegisterRequestSchema.parse(request.body ?? {});
    const input: Parameters<NodeCoordinatorService["register"]>[0] = {
      mode: body.mode,
      capabilities: body.capabilities
    };
    if (body.id !== undefined) input.id = body.id;
    if (body.policy !== undefined) input.policy = body.policy;
    if (body.version !== undefined) input.version = body.version;
    const node = await deps.coordinator.register(input);
    return reply.code(201).send({ node });
  });

  app.post("/nodes/:id/heartbeat", async (request, reply) => {
    const nodeId = (request.params as { id: string }).id;
    try {
      const body = nodeHeartbeatRequestSchema.parse(request.body ?? {});
      const input: Parameters<NodeCoordinatorService["heartbeat"]>[1] = {};
      if (body.capabilities !== undefined) input.capabilities = body.capabilities;
      if (body.policy !== undefined) input.policy = body.policy;
      const node = await deps.coordinator.heartbeat(nodeId, input);
      return reply.send({ node });
    } catch (error) {
      if ((error as { code?: string }).code === "node_not_found") {
        return sendHttpError(reply, "node_not_found", `Node not found: ${nodeId}`);
      }
      throw error;
    }
  });

  app.get("/nodes", async () => {
    const nodes = await deps.coordinator.list();
    return { nodes };
  });

  app.get("/nodes/:id", async (request, reply) => {
    const nodeId = (request.params as { id: string }).id;
    const node = await deps.coordinator.get(nodeId);
    if (!node) {
      return sendHttpError(reply, "node_not_found", `Node not found: ${nodeId}`);
    }
    return { node };
  });

  app.post("/nodes/:id/assignments/claim", async (request, reply) => {
    const nodeId = (request.params as { id: string }).id;
    const body = assignmentClaimRequestSchema.parse(request.body ?? {});
    try {
      const claimed = await deps.coordinator.claim(nodeId, body.assignmentId);
      return reply.send({
        assignment: claimed?.assignment ?? null,
        run: claimed?.run ?? null
      });
    } catch (error) {
      if ((error as { code?: string }).code === "assignment_not_found") {
        return sendHttpError(reply, "assignment_not_found", "Assignment run not found");
      }
      if ((error as { code?: string }).code === "assignment_claim_conflict") {
        return sendHttpError(reply, "assignment_claim_conflict", "Assignment is already claimed");
      }
      throw error;
    }
  });

  app.post("/nodes/:id/assignments/:assignmentId/reject", async (request, reply) => {
    const params = request.params as { id: string; assignmentId: string };
    const body = assignmentRejectRequestSchema.parse(request.body ?? {});
    try {
      const assignment = await deps.coordinator.reject(params.id, params.assignmentId, body.reason);
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
    try {
      const body = assignmentEventSyncRequestSchema.parse(request.body ?? {});
      const input: Parameters<EventSyncService["appendBatch"]>[2] = {
        events: body.events
      };
      if (body.cursor !== undefined) input.cursor = body.cursor;
      const result = await deps.eventSync.appendBatch(params.id, params.assignmentId, input);
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
    try {
      const body = assignmentArtifactManifestRequestSchema.parse(request.body ?? {});
      const result = await deps.artifactSync.acceptManifest(params.id, params.assignmentId, body);
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
    const body = asBuffer(request);
    try {
      const result = await deps.artifactSync.acceptContent(params.id, params.assignmentId, params.artifactId, body);
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
    const body = assignmentCompleteRequestSchema.parse(request.body ?? {});
    try {
      const assignment = await deps.coordinator.complete(params.id, params.assignmentId, body.status, body.error);
      return reply.send({ assignment });
    } catch (error) {
      if ((error as { code?: string }).code === "assignment_not_found") {
        return sendHttpError(reply, "assignment_not_found", "Assignment not found");
      }
      throw error;
    }
  });
}

function asBuffer(request: FastifyRequest): Buffer {
  const raw = request.body;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  if (raw && typeof raw === "object") return Buffer.from(JSON.stringify(raw));
  return Buffer.alloc(0);
}
