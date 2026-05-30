import type { FastifyInstance } from "fastify";
import type { ArtifactContentStore, ArtifactStore } from "@switchyard/core";
import type { Artifact } from "@switchyard/contracts";
import { sendHttpError } from "./http-errors.js";

export type ContentType = "transcript" | string;

export type ArtifactContentReader = Pick<ArtifactContentStore, "read"> | {
  read(artifact: Artifact): Promise<{ body: Buffer | string; contentType: string }>;
};

export interface ArtifactRouteDependencies {
  artifacts: ArtifactStore;
  artifactContent: ArtifactContentReader;
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
    const artifact = await deps.artifacts.get(id);
    if (!artifact) {
      return sendHttpError(reply, "artifact_not_found", `Artifact not found: ${id}`);
    }
    return { artifact };
  });

  app.get("/artifacts/:id/content", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const artifact = await deps.artifacts.get(id);
    if (!artifact) {
      return sendHttpError(reply, "artifact_not_found", `Artifact not found: ${id}`);
    }

    const storedFlag = (artifact.metadata as Record<string, unknown> | undefined)?.["contentStored"];
    if (storedFlag === false) {
      return sendHttpError(reply, "missing_artifact_content", `Artifact has no stored content: ${id}`);
    }

    let payload: { body: Buffer | string; contentType: string };
    try {
      payload = await deps.artifactContent.read(artifact);
    } catch (error) {
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
