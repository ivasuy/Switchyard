import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerErrorEnvelope } from "@switchyard/protocol-rest";
import { registerNodeRoutes } from "../src/index.js";

describe("node routes", () => {
  it("registers node and enforces token auth", async () => {
    const app = Fastify();
    registerErrorEnvelope(app);
    registerNodeRoutes(app, {
      sharedToken: "token",
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
  });
});
