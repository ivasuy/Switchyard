import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNodeApp } from "../src/app.js";
import { loadNodeConfig } from "../src/config.js";

const nodeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function createFakeClient() {
  const calls: string[] = [];
  let claimed = false;
  const syncedEvents: any[] = [];
  const syncedManifests: any[] = [];
  const syncedContents: any[] = [];
  const completedPayloads: any[] = [];
  let claimPayload: any = {
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
  return {
    calls,
    syncedEvents,
    syncedManifests,
    syncedContents,
    completedPayloads,
    setClaimPayload(next: any) {
      claimPayload = next;
    },
    client: {
      register: async () => { calls.push("register"); return { node: { id: "node_1" } }; },
      heartbeat: async () => { calls.push("heartbeat"); return { node: { id: "node_1" } }; },
      claim: async () => {
        calls.push("claim");
        if (claimed) return { assignment: null };
        claimed = true;
        return claimPayload;
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
      complete: async (_nodeId: string, _assignmentId: string, payload: any) => {
        calls.push("complete");
        completedPayloads.push(payload);
        return {};
      }
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
      tools: {
        githubToken: undefined,
        gitBinary: "git",
        shellCatalog: {}
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
    expect(JSON.stringify(fake.syncedEvents[0])).toContain("[node-exec] completed");
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
      tools: {
        githubToken: undefined,
        gitBinary: "git",
        shellCatalog: {}
      },
      idleIntervalMs: 1,
      redactedSummary: {}
    }, { client: fake.client as any });

    await app.start();
    await app.tick();

    expect(fake.calls).toContain("reject");
  });

  it("executes claimed tool assignment and completes with tool invocation patch", async () => {
    const fake = createFakeClient();
    fake.setClaimPayload({
      assignment: {
        id: "assignment_tool_1",
        runId: "run_1",
        nodeId: "node_1",
        kind: "tool",
        toolInvocationId: "tool_1",
        lastEventSequence: 3
      },
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
      },
      toolInvocation: {
        id: "tool_1",
        runId: "run_1",
        type: "fake_echo",
        status: "queued",
        input: {
          request: { text: "hello-node" }
        },
        createdAt: "2026-05-30T00:00:00.000Z"
      }
    });
    const app = createNodeApp({
      deploymentMode: "test",
      serverUrl: "http://localhost:4646",
      capabilities: ["runtime.fake.deterministic", "tools.real", "tool.fake_echo"],
      policy: {
        allowRuntimeModes: ["fake.deterministic"],
        denyAdapterTypes: [],
        allowCwdPrefixes: ["/repo"],
        allowEventTypes: [],
        artifactSync: "full",
        allowToolTypes: ["fake_echo"],
        allowToolCwdPrefixes: ["/repo"],
        toolArtifactSync: "full",
        toolApprovalRequired: true
      },
      tools: {
        githubToken: undefined,
        gitBinary: "git",
        shellCatalog: {}
      },
      idleIntervalMs: 1,
      redactedSummary: {}
    }, { client: fake.client as any });

    await app.start();
    await app.tick();

    expect(fake.calls).toContain("syncEvents");
    expect(fake.calls).toContain("complete");
    expect(fake.completedPayloads[0]?.toolInvocation?.id).toBe("tool_1");
    expect(fake.completedPayloads[0]?.toolInvocation?.status).toBe("completed");
    const eventTypes = (fake.syncedEvents[0]?.events ?? []).map((event: { type: string }) => event.type);
    expect(eventTypes).toEqual(["tool.call", "tool.result"]);
  });

  it("fails browser tool assignment with browser_tool_unshipped", async () => {
    const fake = createFakeClient();
    fake.setClaimPayload({
      assignment: {
        id: "assignment_tool_browser_1",
        runId: "run_1",
        nodeId: "node_1",
        kind: "tool",
        toolInvocationId: "tool_browser_1",
        lastEventSequence: 0
      },
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
      },
      toolInvocation: {
        id: "tool_browser_1",
        runId: "run_1",
        type: "browser",
        status: "queued",
        input: { request: { action: "open", url: "https://example.com" } },
        createdAt: "2026-05-30T00:00:00.000Z"
      }
    });
    const app = createNodeApp({
      deploymentMode: "test",
      serverUrl: "http://localhost:4646",
      capabilities: ["runtime.fake.deterministic", "tools.real"],
      policy: {
        allowRuntimeModes: ["fake.deterministic"],
        denyAdapterTypes: [],
        allowCwdPrefixes: ["/repo"],
        allowEventTypes: [],
        artifactSync: "full",
        allowToolTypes: ["browser"],
        allowToolCwdPrefixes: ["/repo"],
        toolArtifactSync: "full",
        toolApprovalRequired: true
      },
      tools: {
        githubToken: undefined,
        gitBinary: "git",
        shellCatalog: {}
      },
      idleIntervalMs: 1,
      redactedSummary: {}
    }, { client: fake.client as any });

    await app.start();
    await app.tick();

    expect(fake.completedPayloads[0]?.status).toBe("failed");
    expect(fake.completedPayloads[0]?.toolInvocation?.error?.code).toBe("browser_tool_unshipped");
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

  it("fails closed in staging mode without node capabilities env", () => {
    expect(() =>
      loadNodeConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_SERVER_URL: "http://localhost:4646",
        SWITCHYARD_NODE_SHARED_TOKEN: "token",
        SWITCHYARD_NODE_ALLOW_RUNTIME_MODES: "fake.deterministic",
        SWITCHYARD_NODE_ALLOW_CWD_PREFIXES: "/repo"
      })
    ).toThrow("config_required:SWITCHYARD_NODE_CAPABILITIES");
  });

  it("fails closed in staging mode without runtime mode allowlist env", () => {
    expect(() =>
      loadNodeConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_SERVER_URL: "http://localhost:4646",
        SWITCHYARD_NODE_SHARED_TOKEN: "token",
        SWITCHYARD_NODE_CAPABILITIES: "runtime.fake.deterministic",
        SWITCHYARD_NODE_ALLOW_CWD_PREFIXES: "/repo"
      })
    ).toThrow("config_required:SWITCHYARD_NODE_ALLOW_RUNTIME_MODES");
  });

  it("fails closed in staging mode without cwd prefix allowlist env", () => {
    expect(() =>
      loadNodeConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_SERVER_URL: "http://localhost:4646",
        SWITCHYARD_NODE_SHARED_TOKEN: "token",
        SWITCHYARD_NODE_CAPABILITIES: "runtime.fake.deterministic",
        SWITCHYARD_NODE_ALLOW_RUNTIME_MODES: "fake.deterministic"
      })
    ).toThrow("config_required:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES");
  });

  it("keeps local defaults for node allowlists when env is absent", () => {
    const config = loadNodeConfig({
      SWITCHYARD_DEPLOYMENT_MODE: "local"
    });
    expect(config.capabilities).toEqual(["runtime.fake.deterministic"]);
    expect(config.capabilities).not.toContain("tools.real");
    expect(config.capabilities).not.toContain("tool.fetch");
    expect(config.capabilities).not.toContain("tool.web_search");
    expect(config.capabilities).not.toContain("tool.github");
    expect(config.capabilities).not.toContain("tool.repo");
    expect(config.capabilities).not.toContain("tool.shell");
    expect(config.capabilities).not.toContain("tool.browser");
    expect(config.policy.allowRuntimeModes).toEqual(["fake.deterministic"]);
    expect(config.policy.allowCwdPrefixes).toEqual(["/repo"]);
  });

  it("redacts credentialed server URLs from node.start_failed logs", async () => {
    const result = await runNodeMain({
      SWITCHYARD_DEPLOYMENT_MODE: "production",
      SWITCHYARD_SERVER_URL: "https://operator:node-credential-value@127.0.0.1:1",
      SWITCHYARD_NODE_SHARED_TOKEN: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      SWITCHYARD_NODE_CAPABILITIES: "runtime.fake.deterministic",
      SWITCHYARD_NODE_ALLOW_RUNTIME_MODES: "fake.deterministic",
      SWITCHYARD_NODE_ALLOW_CWD_PREFIXES: "/repo"
    });

    const combined = `${result.stdout}\n${result.stderr}`;
    expect(result.code).not.toBe(0);
    expect(combined).toContain("node.start_failed");
    expect(combined).not.toContain("operator:node-credential-value");
    expect(combined).not.toContain("https://operator:node-credential-value@");
    expect(combined).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

function runNodeMain(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", "src/main.ts"], {
      cwd: nodeRoot,
      env: {
        ...process.env,
        ...env,
        FORCE_COLOR: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("node_main_timeout"));
    }, 7_500);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ code, stdout, stderr });
    });
  });
}
