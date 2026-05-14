import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCodexModelCatalog, probeCodexCatalog, validateCodexRunOptions } from "../src/index.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock
}));

describe("codex model catalog", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("parses local Codex model catalog JSON", () => {
    const parsed = parseCodexModelCatalog(
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            description: "Frontier model",
            default_reasoning_level: "medium",
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "medium" },
              "high",
              { effort: "xhigh" }
            ],
            supports_reasoning_summaries: true,
            support_verbosity: true,
            default_verbosity: "low"
          }
        ]
      })
    );

    expect(parsed).toEqual([
      {
        slug: "gpt-5.5",
        displayName: "GPT-5.5",
        description: "Frontier model",
        defaultReasoningLevel: "medium",
        supportedReasoningLevels: ["low", "medium", "high", "xhigh"],
        supportsReasoningSummaries: true,
        supportsVerbosity: true,
        defaultVerbosity: "low"
      }
    ]);
  });

  it("ignores non-array model payloads", () => {
    expect(parseCodexModelCatalog(JSON.stringify({ models: {} }))).toEqual([]);
  });

  it("rejects unsupported reasoning effort when catalog has the selected model", () => {
    expect(() =>
      validateCodexRunOptions({
        model: "gpt-5.5",
        options: { reasoningEffort: "minimal" },
        models: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high", "xhigh"] }]
      })
    ).toThrow("Reasoning effort minimal is not supported by Codex model gpt-5.5");
  });

  it("allows validation when catalog is unavailable", () => {
    expect(
      validateCodexRunOptions({
        model: "gpt-5.5",
        options: { reasoningEffort: "high" },
        models: []
      })
    ).toEqual({ reasoningEffort: "high" });
  });

  it("returns not ok when codex version probe fails", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Function) =>
      cb(new Error("spawn ENOENT"), "", "")
    );

    await expect(probeCodexCatalog("codex")).resolves.toEqual({
      ok: false,
      models: [],
      message: "spawn ENOENT"
    });
  });

  it("returns ok with empty models when debug models fails", async () => {
    execFileMock.mockImplementation((file: string, args: string[], _opts: unknown, cb: Function) => {
      if (file === "codex" && args[0] === "--version") {
        cb(null, "codex 1.2.3\n", "");
        return;
      }
      cb(new Error("debug failed"), "", "");
    });

    await expect(probeCodexCatalog("codex")).resolves.toEqual({
      ok: true,
      version: "codex 1.2.3",
      models: [],
      message: "debug failed"
    });
  });

  it("returns parsed models when both probes succeed", async () => {
    execFileMock.mockImplementation((file: string, args: string[], _opts: unknown, cb: Function) => {
      if (file === "codex" && args[0] === "--version") {
        cb(null, "codex 2.0.0\n", "");
        return;
      }
      cb(
        null,
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.4",
              supported_reasoning_levels: [{ effort: "low" }, "medium"]
            }
          ]
        }),
        ""
      );
    });

    await expect(probeCodexCatalog("codex")).resolves.toEqual({
      ok: true,
      version: "codex 2.0.0",
      models: [
        {
          slug: "gpt-5.4",
          supportedReasoningLevels: ["low", "medium"]
        }
      ]
    });
  });
});
