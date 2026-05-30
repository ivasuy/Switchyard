import { describe, expect, it } from "vitest";
import { finalizeTranscript } from "../src/claude-code/transcript-bounds.js";

describe("Claude transcript bounds", () => {
  it("always ends with a complete transcript.truncated marker when overflow occurs", () => {
    const maxBytes = 128;
    const fullLine = `${"x".repeat(maxBytes - 1)}\n`;
    const overflowLine = "y\n";

    const output = finalizeTranscript([fullLine, overflowLine], maxBytes);
    const lines = output.trimEnd().split("\n");
    const marker = JSON.parse(lines[lines.length - 1] ?? "{}") as { type?: string };

    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(output.endsWith("\n")).toBe(true);
    expect(marker.type).toBe("transcript.truncated");
  });
});
