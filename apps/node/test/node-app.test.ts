import { describe, expect, it } from "vitest";
import { createNodeApp } from "../src/app.js";

function createFakeClient() {
  const calls: string[] = [];
  let claimed = false;
  return {
    calls,
    client: {
      register: async () => { calls.push("register"); return { node: { id: "node_1" } }; },
      heartbeat: async () => { calls.push("heartbeat"); return { node: { id: "node_1" } }; },
      claim: async () => {
        calls.push("claim");
        if (claimed) return { assignment: null };
        claimed = true;
        return { assignment: { id: "assignment_1", runId: "run_1", nodeId: "node_1" } };
      },
      reject: async () => { calls.push("reject"); return {}; },
      syncEvents: async () => { calls.push("syncEvents"); return {}; },
      syncArtifactManifest: async () => { calls.push("syncArtifactManifest"); return {}; },
      complete: async () => { calls.push("complete"); return {}; }
    }
  };
}

describe("node app", () => {
  it("registers, heartbeats, claims and completes fake assignment", async () => {
    const fake = createFakeClient();
    const app = createNodeApp({
      serverUrl: "http://localhost:4646",
      capabilities: ["runtime.fake.deterministic"],
      policy: {
        allowRuntimeModes: ["fake.deterministic"],
        denyAdapterTypes: [],
        allowCwdPrefixes: ["/repo"],
        allowEventTypes: [],
        artifactSync: "full"
      }
    }, { client: fake.client as any });

    await app.start();
    const first = await app.tick();
    const second = await app.tick();

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(fake.calls).toContain("complete");
  });

  it("rejects assignment when local policy denies", async () => {
    const fake = createFakeClient();
    const app = createNodeApp({
      serverUrl: "http://localhost:4646",
      capabilities: ["runtime.fake.deterministic"],
      policy: {
        allowRuntimeModes: [],
        denyAdapterTypes: [],
        allowCwdPrefixes: ["/repo"],
        allowEventTypes: [],
        artifactSync: "full"
      }
    }, { client: fake.client as any });

    await app.start();
    await app.tick();

    expect(fake.calls).toContain("reject");
  });
});
