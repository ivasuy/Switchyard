import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Artifact } from "@switchyard/contracts";
import { ControlPlaneError } from "@switchyard/core";
import type { ArtifactStore } from "@switchyard/core";
import { InMemoryArtifactStore } from "@switchyard/testkit";
import {
  contentTypeForArtifact,
  registerArtifactRoutes,
  registerErrorEnvelope,
  registerHostedAuthHooks,
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

  it("maps object store availability/auth/bucket/timeout/read failures to 503", async () => {
    const codes = [
      "object_store_unavailable",
      "object_store_timeout",
      "object_store_auth_failed",
      "object_store_bucket_not_found",
      "object_store_read_failed"
    ];
    for (const code of codes) {
      const artifacts = new InMemoryArtifactStore();
      await artifacts.create(baseArtifact);
      const app = buildApp(artifacts, {
        async read() {
          throw new Error(code);
        }
      });
      const response = await app.inject({ method: "GET", url: "/artifacts/artifact_test/content" });
      expect(response.statusCode, code).toBe(503);
      expect(response.json().error.code, code).toBe(code);
      expect(response.body, code).not.toContain("Authorization");
      expect(response.body, code).not.toContain("AKIA");
    }
  });

  it("maps integrity failures to 409", async () => {
    const artifacts = new InMemoryArtifactStore();
    await artifacts.create(baseArtifact);
    const app = buildApp(artifacts, {
      async read() {
        throw new Error("artifact_digest_mismatch");
      }
    });

    const digestResponse = await app.inject({ method: "GET", url: "/artifacts/artifact_test/content" });
    expect(digestResponse.statusCode).toBe(409);
    expect(digestResponse.json().error.code).toBe("artifact_digest_mismatch");

    const app2 = buildApp(artifacts, {
      async read() {
        throw new Error("artifact_content_empty");
      }
    });
    const emptyResponse = await app2.inject({ method: "GET", url: "/artifacts/artifact_test/content" });
    expect(emptyResponse.statusCode).toBe(409);
    expect(emptyResponse.json().error.code).toBe("artifact_content_empty");
  });

  it("picks the right content type for known artifact types", () => {
    expect(contentTypeForArtifact("transcript")).toBe("application/x-ndjson");
    expect(contentTypeForArtifact("raw_log")).toBe("text/plain; charset=utf-8");
    expect(contentTypeForArtifact("custom_unknown")).toBe("application/octet-stream");
  });

  it("denies artifact content quota before artifactContent.read", async () => {
    const artifacts = new InMemoryArtifactStore();
    await artifacts.create({ ...baseArtifact, metadata: { contentStored: true, sizeBytes: 2048 } });
    let readCalls = 0;
    const app = Fastify();
    registerErrorEnvelope(app);
    registerHostedAuthHooks(app, {
      controlPlane: {
        authenticateRequest: async () => testAuth(),
        requireScope: () => {},
        recordAudit: async () => ({ ok: true }),
        authorizeResource: async () => ({ ok: true }),
        preflightArtifactContentRead: async () => {
          throw new ControlPlaneError("quota_exceeded", "artifact_read_bytes_exceeded");
        }
      } as never
    });
    registerArtifactRoutes(app, {
      artifacts,
      controlPlane: {
        authorizeResource: async () => ({ ok: true }),
        preflightArtifactContentRead: async () => {
          throw new ControlPlaneError("quota_exceeded", "artifact_read_bytes_exceeded");
        },
        recordAudit: async () => ({ ok: true })
      } as never,
      artifactContent: {
        async read() {
          readCalls += 1;
          return { body: "nope", contentType: "text/plain" };
        }
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/artifacts/artifact_test/content",
      headers: { authorization: "Bearer sk_sw_test_1" }
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe("quota_exceeded");
    expect(readCalls).toBe(0);
  });
});

function testAuth() {
  return {
    account: {
      id: "account_1",
      name: "Acme",
      status: "active",
      billingPlanId: "billing_plan_1",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    tenant: {
      id: "tenant_1",
      accountId: "account_1",
      slug: "acme",
      displayName: "Acme",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    project: {
      id: "project_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      slug: "prod",
      displayName: "Prod",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    user: {
      id: "user_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      displayName: "Tester",
      email: "t@example.com",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    apiKey: {
      id: "api_key_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      userId: "user_1",
      name: "primary",
      keyPrefix: "sk_sw",
      scopes: ["artifacts:read"],
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    entitlement: {
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      planId: "billing_plan_1",
      planSlug: "enterprise",
      planDisplayName: "Enterprise",
      entitlements: {
        allowedPlacements: ["local", "hosted", "connected_local_node"],
        allowedRuntimeModes: ["fake.deterministic"],
        allowHostedRealRuntime: false,
        allowConnectedNodes: true,
        allowArtifactContentRead: true,
        allowMetricsRead: true,
        allowAuditRead: true
      },
      quotas: {
        maxRunsPerHour: 10,
        maxActiveRuns: 2,
        maxRunTimeoutSeconds: 600,
        maxConnectedNodes: 2,
        maxArtifactContentReadBytesPerHour: 1024
      },
      scopes: ["artifacts:read"],
      capturedAt: "2026-05-31T00:00:00.000Z"
    }
  };
}
