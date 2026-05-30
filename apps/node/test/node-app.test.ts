import { describe, expect, it } from "vitest";
import { createNodeApp } from "../src/app.js";
import { loadNodeConfig } from "../src/config.js";

function createFakeClient() {
  const calls: string[] = [];
  let claimed = false;
  const syncedEvents: any[] = [];
  const syncedManifests: any[] = [];
  const syncedContents: any[] = [];
  return {
    calls,
    syncedEvents,
    syncedManifests,
    syncedContents,
    client: {
      register: async () => { calls.push("register"); return { node: { id: "node_1" } }; },
      heartbeat: async () => { calls.push("heartbeat"); return { node: { id: "node_1" } }; },
      claim: async () => {
        calls.push("claim");
        if (claimed) return { assignment: null };
        claimed = true;
        return {
          assignment: { id: "assignment_1", runId: "run_1", nodeId: "node_1", lastEventSequence: 0 },
          run: {
            id: "run_1",
            runtime: "fake",
            provider: "test",
            model: "test-model",
            adapterType: "process",
            cwd: "/repo",
            task: "node assignment",
            status: "running",
            placement: "connected_local_node",
            approvalPolicy: "default",
            timeoutSeconds: 60,
            metadata: {},
            runtimeMode: "fake.deterministic",
            createdAt: "2026-05-30T00:00:00.000Z"
          }
        };
      },
      reject: async () => { calls.push("reject"); return {}; },
      syncEvents: async (_nodeId: string, _assignmentId: string, payload: any) => {
        calls.push("syncEvents");
        syncedEvents.push(payload);
        return {};
      },
      syncArtifactManifest: async (_nodeId: string, _assignmentId: string, payload: any) => {
        calls.push("syncArtifactManifest");
        syncedManifests.push(payload);
        return {};
      },
      syncArtifactContent: async (_nodeId: string, _assignmentId: string, artifactId: string, body: Buffer) => {
        calls.push("syncArtifactContent");
        syncedContents.push({ artifactId, body });
        return {};
      },
      complete: async () => { calls.push("complete"); return {}; }
    }
  };
}

describe("node app", () => {
  it("registers, heartbeats, claims and completes fake assignment", async () => {
    const fake = createFakeClient();
    const app = createNodeApp({
      deploymentMode: "test",
      serverUrl: "http://localhost:4646",
      capabilities: ["runtime.fake.deterministic"],
      policy: {
        allowRuntimeModes: ["fake.deterministic"],
        denyAdapterTypes: [],
        allowCwdPrefixes: ["/repo"],
        allowEventTypes: [],
        artifactSync: "full"
      },
      idleIntervalMs: 1,
      redactedSummary: {}
    }, { client: fake.client as any });

    await app.start();
    const first = await app.tick();
    const second = await app.tick();

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(fake.calls).toContain("complete");
    expect(fake.syncedEvents[0]?.events?.length).toBeGreaterThan(0);
    expect(fake.syncedManifests[0]?.artifacts?.length).toBeGreaterThan(0);
    expect(fake.syncedContents.length).toBe(1);
  });

  it("rejects assignment when local policy denies", async () => {
    const fake = createFakeClient();
    const app = createNodeApp({
      deploymentMode: "test",
      serverUrl: "http://localhost:4646",
      capabilities: ["runtime.fake.deterministic"],
      policy: {
        allowRuntimeModes: [],
        denyAdapterTypes: [],
        allowCwdPrefixes: ["/repo"],
        allowEventTypes: [],
        artifactSync: "full"
      },
      idleIntervalMs: 1,
      redactedSummary: {}
    }, { client: fake.client as any });

    await app.start();
    await app.tick();

    expect(fake.calls).toContain("reject");
  });

  it("fails closed in staging mode without shared token", () => {
    expect(() =>
      loadNodeConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_SERVER_URL: "http://localhost:4646",
        SWITCHYARD_NODE_CAPABILITIES: "runtime.fake.deterministic",
        SWITCHYARD_NODE_ALLOW_RUNTIME_MODES: "fake.deterministic",
        SWITCHYARD_NODE_ALLOW_CWD_PREFIXES: "/repo"
      })
    ).toThrow("config_required:SWITCHYARD_NODE_SHARED_TOKEN");
  });
});
