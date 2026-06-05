import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Artifact } from "@switchyard/contracts";
import type { ArtifactStore } from "@switchyard/core";
import { InMemoryArtifactStore } from "@switchyard/testkit";
import {
  contentTypeForArtifact,
  registerArtifactRoutes,
  registerErrorEnvelope,
  type ArtifactContentReader
} from "../src/index.js";

function buildApp(artifacts: ArtifactStore, content: ArtifactContentReader) {
  const app = Fastify();
  registerErrorEnvelope(app);
  registerArtifactRoutes(app, { artifacts, artifactContent: content });
  return app;
}

const baseArtifact: Artifact = {
  id: "artifact_test",
  runId: "run_test",
  type: "transcript",
  path: "runs/run_test/transcript.jsonl",
  metadata: { contentStored: true },
  createdAt: "2026-05-01T00:00:00.000Z"
};

describe("artifact routes", () => {
  it("returns artifact metadata by id", async () => {
    const artifacts = new InMemoryArtifactStore();
    await artifacts.create(baseArtifact);
    const app = buildApp(artifacts, {
      async read() {
        return { body: "{}\n", contentType: "application/x-ndjson" };
      }
    });

    const response = await app.inject({ method: "GET", url: "/artifacts/artifact_test" });
    expect(response.statusCode).toBe(200);
    expect(response.json().artifact).toMatchObject({ id: "artifact_test", type: "transcript" });
  });

  it("returns 404 artifact_not_found for unknown id", async () => {
    const artifacts = new InMemoryArtifactStore();
    const app = buildApp(artifacts, {
      async read() {
        throw new Error("should not be called");
      }
    });

    const response = await app.inject({ method: "GET", url: "/artifacts/artifact_missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("artifact_not_found");
  });

  it("streams transcript content with application/x-ndjson", async () => {
    const artifacts = new InMemoryArtifactStore();
    await artifacts.create(baseArtifact);
    const app = buildApp(artifacts, {
      async read() {
        return { body: "{\"event\":\"hello\"}\n", contentType: "application/x-ndjson" };
      }
    });

    const response = await app.inject({ method: "GET", url: "/artifacts/artifact_test/content" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/x-ndjson");
    expect(response.body).toContain("hello");
  });

  it("returns 404 missing_artifact_content when metadata.contentStored is false", async () => {
    const artifacts = new InMemoryArtifactStore();
    await artifacts.create({ ...baseArtifact, metadata: { contentStored: false } });
    const app = buildApp(artifacts, {
      async read() {
        throw new Error("should not be called");
      }
    });

    const response = await app.inject({ method: "GET", url: "/artifacts/artifact_test/content" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("missing_artifact_content");
  });

  it("returns 404 missing_artifact_content when backing file is missing", async () => {
    const artifacts = new InMemoryArtifactStore();
    await artifacts.create(baseArtifact);
    const app = buildApp(artifacts, {
      async read() {
        const error: Error & { code?: string } = new Error("ENOENT: no such file");
        error.code = "ENOENT";
        throw error;
      }
    });

    const response = await app.inject({ method: "GET", url: "/artifacts/artifact_test/content" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("missing_artifact_content");
  });

  it("picks the right content type for known artifact types", () => {
    expect(contentTypeForArtifact("transcript")).toBe("application/x-ndjson");
    expect(contentTypeForArtifact("raw_log")).toBe("text/plain; charset=utf-8");
    expect(contentTypeForArtifact("custom_unknown")).toBe("application/octet-stream");
  });
});
