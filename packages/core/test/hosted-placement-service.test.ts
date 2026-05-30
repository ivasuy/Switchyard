import { describe, expect, it } from "vitest";
import { PlacementService } from "../src/services/placement-service.js";

const facts = {
  local: { support: "supported", reason: "ok" },
  hosted: { support: "supported", reason: "ok" },
  connectedLocalNode: { support: "supported", reason: "ok" }
} as const;

describe("PlacementService", () => {
  it("defaults to hosted when allowlisted", () => {
    const svc = new PlacementService();
    const decision = svc.decide({
      runtimeMode: "fake.deterministic",
      placementFacts: facts,
      hostedRuntimeAllowlist: ["fake.deterministic"],
      onlineNodes: [],
      now: "2026-05-30T00:00:00.000Z"
    });
    expect(decision.decision).toBe("hosted");
  });

  it("picks lexicographically first connected node", () => {
    const svc = new PlacementService();
    const decision = svc.decide({
      requestedPlacement: "connected_local_node",
      runtimeMode: "fake.deterministic",
      placementFacts: facts,
      hostedRuntimeAllowlist: [],
      onlineNodes: [
        {
          id: "node_b",
          mode: "hybrid",
          status: "online",
          capabilities: ["runtime.fake.deterministic"],
          createdAt: "2026-05-30T00:00:00.000Z"
        },
        {
          id: "node_a",
          mode: "hybrid",
          status: "online",
          capabilities: ["runtime.fake.deterministic"],
          createdAt: "2026-05-30T00:00:00.000Z"
        }
      ],
      now: "2026-05-30T00:00:00.000Z"
    });
    expect(decision.decision).toBe("connected_local_node");
    expect(decision.targetNode).toBe("node_a");
  });

  it("rejects explicit hosted for non-allowlisted mode", () => {
    const svc = new PlacementService();
    const decision = svc.decide({
      requestedPlacement: "hosted",
      runtimeMode: "codex.exec_json",
      placementFacts: facts,
      hostedRuntimeAllowlist: ["fake.deterministic"],
      onlineNodes: [],
      now: "2026-05-30T00:00:00.000Z"
    });
    expect(decision.decision).toBe("reject");
    expect(decision.reason).toBe("hosted_runtime_not_allowed");
  });
});
