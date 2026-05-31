import type { FastifyInstance } from "fastify";
import { ControlPlaneError, type ArtifactContentStore, type ArtifactStore, type ControlPlaneService } from "@switchyard/core";
import type { Artifact } from "@switchyard/contracts";
import { getHostedAuthContext } from "./hosted-auth.js";
import { sendHttpError } from "./http-errors.js";

export type ContentType = "transcript" | string;

export type ArtifactContentReader = Pick<ArtifactContentStore, "read"> | {
  read(artifact: Artifact): Promise<{ body: Buffer | string; contentType: string }>;
};

export interface ArtifactRouteDependencies {
  artifacts: ArtifactStore;
  artifactContent: ArtifactContentReader;
  controlPlane?: ControlPlaneService;
}

const CONTENT_TYPE_BY_ARTIFACT: Record<string, string> = {
  transcript: "application/x-ndjson",
  debate_transcript: "application/x-ndjson",
  raw_log: "text/plain; charset=utf-8",
  event_log: "application/x-ndjson",
  diff: "text/plain; charset=utf-8",
  test_log: "text/plain; charset=utf-8",
  summary: "text/markdown; charset=utf-8",
  screenshot: "application/octet-stream",
  proof: "application/octet-stream",
  evidence_pack: "application/octet-stream",
  model_transcript: "application/x-ndjson"
};

export function contentTypeForArtifact(type: string): string {
  return CONTENT_TYPE_BY_ARTIFACT[type] ?? "application/octet-stream";
}

export function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRouteDependencies): void {
  app.get("/artifacts/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const auth = getHostedAuthContext(request);
    if (deps.controlPlane && !auth) {
      return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
    }
    if (deps.controlPlane && auth) {
      const allowed = await deps.controlPlane.authorizeResource({
        auth,
        resourceType: "artifact",
        resourceId: id,
        notFoundCode: "artifact_not_found"
      });
      if (!allowed.ok) {
        await deps.controlPlane.recordAudit({
          auth,
          eventType: "artifact.read_denied",
          decision: "deny",
          reasonCode: allowed.reasonCode,
          resourceType: "artifact",
          resourceId: id,
          requestId: request.id,
          payload: { routeId: "artifacts.get", reasonCode: allowed.reasonCode }
        });
        return sendHttpError(reply, allowed.code, allowed.reasonCode, [{ path: "reasonCode", issue: allowed.reasonCode }]);
      }
    }

    const artifact = await deps.artifacts.get(id);
    if (!artifact) {
      return sendHttpError(reply, "artifact_not_found", `Artifact not found: ${id}`);
    }
    return { artifact };
  });

  app.get("/artifacts/:id/content", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const auth = getHostedAuthContext(request);
    if (deps.controlPlane && !auth) {
      return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
    }
    if (deps.controlPlane && auth) {
      const allowed = await deps.controlPlane.authorizeResource({
        auth,
        resourceType: "artifact",
        resourceId: id,
        notFoundCode: "artifact_not_found"
      });
      if (!allowed.ok) {
        await deps.controlPlane.recordAudit({
          auth,
          eventType: "artifact.read_denied",
          decision: "deny",
          reasonCode: allowed.reasonCode,
          resourceType: "artifact",
          resourceId: id,
          requestId: request.id,
          payload: { routeId: "artifacts.content", reasonCode: allowed.reasonCode }
        });
        return sendHttpError(reply, allowed.code, allowed.reasonCode, [{ path: "reasonCode", issue: allowed.reasonCode }]);
      }
    }

    const artifact = await deps.artifacts.get(id);
    if (!artifact) {
      return sendHttpError(reply, "artifact_not_found", `Artifact not found: ${id}`);
    }

    const storedFlag = (artifact.metadata as Record<string, unknown> | undefined)?.["contentStored"];
    if (storedFlag === false) {
      return sendHttpError(reply, "missing_artifact_content", `Artifact has no stored content: ${id}`);
    }

    let reservationId: string | undefined;
    if (deps.controlPlane && auth) {
      try {
        const reservation = await deps.controlPlane.preflightArtifactContentRead({
          auth,
          artifactId: id,
          expectedBytes: expectedArtifactBytes(artifact)
        });
        reservationId = reservation.id;
      } catch (error) {
        if (error instanceof ControlPlaneError) {
          await deps.controlPlane.recordAudit({
            auth,
            eventType: error.code === "quota_exceeded" ? "quota.denied" : "artifact.read_denied",
            decision: "deny",
            reasonCode: error.reasonCode,
            resourceType: "artifact",
            resourceId: id,
            requestId: request.id,
            payload: { routeId: "artifacts.content", reasonCode: error.reasonCode }
          });
          return sendHttpError(reply, error.code, error.reasonCode, [{ path: "reasonCode", issue: error.reasonCode }]);
        }
        throw error;
      }
    }

    let payload: { body: Buffer | string; contentType: string };
    try {
      payload = await deps.artifactContent.read(artifact);
      if (deps.controlPlane && auth && reservationId) {
        await deps.controlPlane.releaseQuotaReservation({
          auth,
          reservationId,
          outcome: "consumed",
          reasonCode: "artifact_read_allowed"
        });
      }
      if (deps.controlPlane && auth) {
        await deps.controlPlane.recordAudit({
          auth,
          eventType: "artifact.read_allowed",
          decision: "allow",
          reasonCode: "artifact_read_allowed",
          resourceType: "artifact",
          resourceId: id,
          requestId: request.id,
          payload: { routeId: "artifacts.content" }
        });
      }
    } catch (error) {
      if (deps.controlPlane && auth && reservationId) {
        await deps.controlPlane.releaseQuotaReservation({
          auth,
          reservationId,
          outcome: "failed",
          reasonCode: "artifact_content_read_failed"
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string }).code;
      if (
        code === "ENOENT" ||
        message.includes("not found") ||
        message === "artifact_content_not_found"
      ) {
        return sendHttpError(reply, "missing_artifact_content", `Artifact has no stored content: ${id}`);
      }
      if (message === "artifact_digest_mismatch") {
        return sendHttpError(reply, "artifact_digest_mismatch", `Artifact digest mismatch: ${id}`);
      }
      if (message === "artifact_content_empty") {
        return sendHttpError(reply, "artifact_content_empty", `Artifact content integrity mismatch: ${id}`);
      }
      if (
        message === "object_store_unavailable" ||
        message === "object_store_timeout" ||
        message === "object_store_auth_failed" ||
        message === "object_store_bucket_not_found" ||
        message === "object_store_read_failed"
      ) {
        return sendHttpError(reply, message, `Artifact content store unavailable: ${id}`);
      }
      throw error;
    }

    const contentType = payload.contentType || contentTypeForArtifact(artifact.type);
    return reply.header("content-type", contentType).send(payload.body);
  });
}

function expectedArtifactBytes(artifact: Artifact): number {
  const size = artifact.metadata?.["sizeBytes"];
  if (typeof size === "number" && Number.isFinite(size) && size > 0) {
    return Math.ceil(size);
  }
  return 1;
}
