import { describe, expect, it } from "vitest";
import {
  generateCompatibilityMatrix,
  validateCompatibilityRows,
  type AdapterCompatibilityRow
} from "./compatibility-matrix.js";

describe("adapter compatibility matrix", () => {
  it("produces manifest-driven deterministic no-spend rows for shipped runtime modes", async () => {
    const matrix = await generateCompatibilityMatrix();
    const bySlug = new Map(matrix.rows.map((row) => [row.runtimeModeSlug, row]));

    expect(bySlug.get("fake.deterministic")?.ciStatus).toBe("pass");
    expect(bySlug.get("codex.exec_json")?.ciStatus).toBe("skip");
    expect(bySlug.get("claude_code.sdk")?.ciStatus).toBe("skip");
    expect(bySlug.get("generic_http.async_rest")?.ciStatus).toBe("skip");
    expect(bySlug.get("agentfield.async_rest")?.ciStatus).toBe("skip");
    expect(bySlug.get("opencode.acp")?.ciStatus).toBe("skip");

    const fakeRow = bySlug.get("fake.deterministic");
    expect(fakeRow).toBeDefined();
    expect(fakeRow?.runtimeModeId).toBe("runtime_mode_fake_deterministic");
    expect(fakeRow?.adapterId).toBe("fake");
    expect(fakeRow?.providerId).toBe("provider_test");
    expect(fakeRow?.runtimeId).toBe("runtime_fake");
    expect(fakeRow?.adapterType).toBe("process");
    expect(fakeRow?.kind).toBe("deterministic_fake");
    expect(fakeRow?.capabilities.length).toBeGreaterThan(0);
    expect(fakeRow?.placementSupport.local).toBe("supported");
    expect(fakeRow?.doctorStrategy).toBe("none");
    expect(fakeRow?.noSpendHarness.type).toBe("runtime-adapter-contract-harness");
    expect(fakeRow?.coveredScenarios).toContain("event_streaming");

    expect(matrix.summary.pass).toBe(1);
    expect(matrix.summary.fail).toBe(0);
    expect(matrix.summary.skip).toBe(5);
    expect(matrix.generatedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("validates required harness and scenario coverage", () => {
    const badRows: AdapterCompatibilityRow[] = [
      {
        runtimeModeId: "runtime_mode_example",
        runtimeModeSlug: "example.runtime",
        adapterId: "example_adapter",
        providerId: "provider_example",
        runtimeId: "runtime_example",
        adapterType: "process",
        kind: "deterministic_fake",
        capabilities: ["run.start"],
        limitations: [],
        placementSupport: {
          local: "supported",
          hosted: "unsupported",
          connectedLocalNode: "unsupported"
        },
        doctorStrategy: "none",
        noSpendHarness: {
          type: "manual"
        },
        coveredScenarios: [],
        ciStatus: "skip",
        reason: "invalid fixture"
      }
    ];

    expect(() => validateCompatibilityRows(badRows)).toThrow(/coveredScenarios/);
  });
});
