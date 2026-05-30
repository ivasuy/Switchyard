import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerErrorEnvelope } from "@switchyard/protocol-rest";
import {
  NodeClient,
  NodeClientDecodeError,
  NodeClientHttpError,
  NodeClientNetworkError,
  registerNodeRoutes
} from "../src/index.js";

describe("node routes", () => {
  it("registers node and enforces token auth", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);
    registerNodeRoutes(app, {
      sharedToken: "token",
      requireAuth: true,
      jsonBodyLimitBytes: 64,
      artifactBodyLimitBytes: 8,
      coordinator: {
        register: async () => ({ id: "node_1", mode: "hybrid", status: "online", capabilities: [], createdAt: "2026-05-30T00:00:00.000Z" }),
        heartbeat: async () => ({ id: "node_1", mode: "hybrid", status: "online", capabilities: [], createdAt: "2026-05-30T00:00:00.000Z" }),
        list: async () => [],
        get: async () => undefined,
        claim: async () => null,
        reject: async () => ({ id: "assignment_1", runId: "run_1", nodeId: "node_1", status: "failed", retryCount: 0, lastEventSequence: 0, createdAt: "2026-05-30T00:00:00.000Z" }),
        complete: async () => ({ id: "assignment_1", runId: "run_1", nodeId: "node_1", status: "completed", retryCount: 0, lastEventSequence: 0, createdAt: "2026-05-30T00:00:00.000Z" }),
        expireStale: async () => {}
      } as any,
      eventSync: {
        appendBatch: async () => ({ accepted: true, appended: 0, nextCursor: 0 })
      } as any,
      artifactSync: {
        acceptManifest: async () => ({ accepted: true, artifacts: [] }),
        acceptContent: async () => ({ accepted: true, artifactId: "artifact_1" })
      } as any
    });

    const denied = await app.inject({
      method: "POST",
      url: "/nodes/register",
      payload: { capabilities: [] }
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe("node_auth_failed");

    const accepted = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { "x-switchyard-node-token": "token" },
      payload: { capabilities: [] }
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().node.id).toBe("node_1");

    const tooLargeJson = await app.inject({
      method: "POST",
      url: "/nodes/register",
      headers: { "x-switchyard-node-token": "token" },
      payload: { capabilities: ["x".repeat(200)] }
    });
    expect(tooLargeJson.statusCode).toBe(413);
    expect(tooLargeJson.json().error.code).toBe("payload_too_large");

  });
});

describe("node client errors", () => {
  it("throws typed http errors", async () => {
    const client = new NodeClient({
      baseUrl: "http://example.test",
      fetchImpl: async () => new Response(JSON.stringify({
        error: { code: "node_auth_failed", message: "bad token", requestId: "req_1" }
      }), { status: 401 })
    });
    await expect(client.register({ capabilities: [] })).rejects.toBeInstanceOf(NodeClientHttpError);
  });

  it("throws decode errors for malformed JSON", async () => {
    const client = new NodeClient({
      baseUrl: "http://example.test",
      fetchImpl: async () => new Response("not-json", { status: 200 })
    });
    await expect(client.register({ capabilities: [] })).rejects.toBeInstanceOf(NodeClientDecodeError);
  });

  it("throws network errors", async () => {
    const client = new NodeClient({
      baseUrl: "http://example.test",
      fetchImpl: async () => {
        throw new Error("dial failure");
      }
    });
    await expect(client.register({ capabilities: [] })).rejects.toBeInstanceOf(NodeClientNetworkError);
  });
});
