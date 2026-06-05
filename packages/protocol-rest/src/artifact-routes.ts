import type { FastifyInstance } from "fastify";
import type { ArtifactStore } from "@switchyard/core";
import type { Artifact } from "@switchyard/contracts";
import { sendHttpError } from "./http-errors.js";

export type ContentType = "transcript" | string;

export interface ArtifactContentReader {
  read(artifact: Artifact): Promise<{ body: Buffer | string; contentType: string }>;
}

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
      const code = (error as { code?: string }).code;
      if (code === "ENOENT" || (error as Error).message?.includes("not found")) {
        return sendHttpError(reply, "missing_artifact_content", `Artifact has no stored content: ${id}`);
      }
      throw error;
    }

    const contentType = payload.contentType || contentTypeForArtifact(artifact.type);
    return reply.header("content-type", contentType).send(payload.body);
  });
}
