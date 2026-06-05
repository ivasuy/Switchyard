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
      message: "spawn ENOENT",
      reasonCode: "binary_unavailable"
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
      message: "debug failed",
      reasonCode: "model_catalog_unavailable"
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

  it("passes timeout and maxBuffer bounds to execFile probes", async () => {
    execFileMock.mockImplementation((file: string, args: string[], opts: Record<string, unknown>, cb: Function) => {
      if (args[0] === "--version") {
        expect(opts.timeout).toBe(1234);
        expect(opts.maxBuffer).toBe(5678);
        cb(null, "codex 2.0.0\n", "");
        return;
      }
      expect(opts.timeout).toBe(1234);
      expect(opts.maxBuffer).toBe(5678);
      cb(null, JSON.stringify({ models: [] }), "");
    });

    const probe = await probeCodexCatalog("codex", { timeoutMs: 1234, maxBufferBytes: 5678 });
    expect(probe.version).toBe("codex 2.0.0");
  });

  it("maps timeout failures to a sanitized reason code", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: Function) => {
      const timeoutError = Object.assign(new Error("command timed out"), { code: "ETIMEDOUT" });
      cb(timeoutError, "", "very long stderr ".repeat(100));
    });

    await expect(probeCodexCatalog("codex", { timeoutMs: 50, maxBufferBytes: 64 })).resolves.toMatchObject({
      ok: false,
      models: [],
      reasonCode: "check_timeout"
    });
  });

  it("maps max-buffer failures to a sanitized reason code", async () => {
    execFileMock.mockImplementation((file: string, args: string[], _opts: unknown, cb: Function) => {
      if (args[0] === "--version") {
        cb(null, "codex 2.0.0\n", "");
        return;
      }
      const bufferError = Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      });
      cb(bufferError, "", "huge output ".repeat(100));
    });

    await expect(probeCodexCatalog("codex", { timeoutMs: 50, maxBufferBytes: 64 })).resolves.toMatchObject({
      ok: true,
      version: "codex 2.0.0",
      models: [],
      reasonCode: "check_output_too_large"
    });
  });
});
