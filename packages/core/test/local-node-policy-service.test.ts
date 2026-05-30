import { describe, expect, it } from "vitest";
import { LocalNodePolicyService } from "../src/services/local-node-policy-service.js";

const baseRun = {
  id: "run_1",
  runtime: "fake",
  provider: "test",
  model: "test-model",
  adapterType: "process",
  cwd: "/repo/project",
  task: "do",
  status: "queued",
  placement: "connected_local_node",
  approvalPolicy: "default",
  timeoutSeconds: 60,
  metadata: {},
  runtimeMode: "fake.deterministic",
  createdAt: "2026-05-30T00:00:00.000Z"
} as const;

describe("LocalNodePolicyService", () => {
  it("allows valid runtime mode and cwd", () => {
    const svc = new LocalNodePolicyService();
    const decision = svc.decide(baseRun, {
      allowRuntimeModes: ["fake.deterministic"],
      denyAdapterTypes: [],
      allowCwdPrefixes: ["/repo"],
      allowEventTypes: ["runtime.output"],
      artifactSync: "full"
    });
    expect(decision.decision).toBe("allow");
  });

  it("denies empty allow list", () => {
    const svc = new LocalNodePolicyService();
    const decision = svc.decide(baseRun, {
      allowRuntimeModes: [],
      denyAdapterTypes: [],
      allowCwdPrefixes: ["/repo"],
      allowEventTypes: [],
      artifactSync: "full"
    });
    expect(decision.decision).toBe("deny");
  });

  it("redacts secrets in trace", () => {
    const svc = new LocalNodePolicyService();
    const decision = svc.decide(baseRun, {
      allowRuntimeModes: ["fake.deterministic"],
      denyAdapterTypes: ["process"],
      allowCwdPrefixes: ["/repo"],
      allowEventTypes: [],
      artifactSync: "full"
    });
    expect(JSON.stringify(decision.policyTrace)).not.toContain("token");
  });
});
