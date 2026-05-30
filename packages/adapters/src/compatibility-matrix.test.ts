import { describe, expect, it } from "vitest";
import { generateCompatibilityMatrix } from "./compatibility-matrix.js";

describe("adapter compatibility matrix", () => {
  it("produces deterministic no-spend rows for shipped runtime modes", async () => {
    const matrix = await generateCompatibilityMatrix();
    const byMode = new Map(matrix.rows.map((row) => [row.runtimeMode, row]));

    expect(byMode.get("fake.deterministic")?.status).toBe("pass");
    expect(byMode.get("codex.exec_json")?.status).toBe("skip");
    expect(byMode.get("claude_code.sdk")?.status).toBe("skip");
    expect(byMode.get("generic_http.async_rest")?.status).toBe("skip");
    expect(byMode.get("agentfield.async_rest")?.status).toBe("skip");
    expect(byMode.get("opencode.acp")?.status).toBe("skip");

    expect(matrix.summary.pass).toBe(1);
    expect(matrix.summary.fail).toBe(0);
    expect(matrix.summary.skip).toBe(5);
    expect(matrix.generatedAt).toBe("1970-01-01T00:00:00.000Z");
  });
});
