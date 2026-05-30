import { describe, expect, it } from "vitest";
import { createClaudeCodeCliClient } from "../src/claude-code/claude-code-cli-client.js";
import type { ClaudeCodeProviderEvent } from "../src/claude-code/types.js";
import { createFakeClaudeCodeCliProcessFactory } from "@switchyard/testkit";

describe("ClaudeCodeCliClient", () => {
  it("constructs stream-json command args and sends structured user input", async () => {
    const fake = createFakeClaudeCodeCliProcessFactory({ waitForInputText: true });
    const client = createClaudeCodeCliClient({
      command: "claude-bin",
      processFactory: fake.processFactory,
      permissionMode: "read_only",
      disabledTools: ["Bash", "WebFetch"]
    });

    const session = await client.start({
      runId: "run_cli",
      cwd: "/repo",
      task: "Inspect code",
      metadata: {}
    });

    const events: ClaudeCodeProviderEvent[] = [];
    const drain = (async () => {
      for await (const event of session.events()) {
        events.push(event);
      }
    })();

    await session.sendUserMessage("continue");
    await drain;

    expect(fake.state.command).toBe("claude-bin");
    expect(fake.state.cwd).toBe("/repo");
    expect(fake.state.args).toEqual(expect.arrayContaining([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--permission-mode",
      "plan"
    ]));
    expect(fake.state.stdinMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "user", message: "continue" })
    ]));
    expect(events.some((event) => event.type === "assistant_text_delta")).toBe(true);
    expect(events.some((event) => event.type === "completed")).toBe(true);
  });

  it("sends structured approval resolution payloads", async () => {
    const fake = createFakeClaudeCodeCliProcessFactory({ approvalToken: "pause-1" });
    const client = createClaudeCodeCliClient({
      command: "claude",
      processFactory: fake.processFactory
    });

    const session = await client.start({
      runId: "run_approval",
      cwd: "/repo",
      task: "Need approval",
      metadata: {}
    });

    const events: ClaudeCodeProviderEvent[] = [];
    const drain = (async () => {
      for await (const event of session.events()) {
        events.push(event);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.resolveApproval({
      runtimeApprovalToken: "pause-1",
      decision: "approved",
      message: "approved by local-user",
      answers: { step: "continue" }
    });
    await drain;

    expect(fake.state.stdinMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "approval_resolution",
        runtimeApprovalToken: "pause-1",
        decision: "approved",
        message: "approved by local-user",
        answers: { step: "continue" }
      })
    ]));
    expect(events.some((event) => event.type === "completed")).toBe(true);
  });
});
