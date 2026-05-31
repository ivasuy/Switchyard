import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ProviderResolvedCommand } from "@switchyard/contracts";
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

  it("uses hosted command handoff with filtered env and fixed read-only tool posture", async () => {
    const fake = createFakeClaudeCodeCliProcessFactory({ waitForInputText: true });
    const hostedProviderCommand: ProviderResolvedCommand = {
      runtimeMode: "claude_code.sdk",
      executablePath: "/opt/provider/bin/claude",
      argv: [],
      cwd: "/repo",
      env: {
        ANTHROPIC_API_KEY: "api-secret",
        PATH: "/usr/bin"
      },
      envKeys: ["ANTHROPIC_API_KEY", "PATH"],
      allowUserArgs: false,
      redactedSummary: { runtimeMode: "claude_code.sdk" }
    };

    const client = createClaudeCodeCliClient({
      command: "claude-local",
      processFactory: fake.processFactory,
      hostedProviderCommand
    });

    const session = await client.start({
      runId: "run_hosted_cli",
      cwd: "/repo",
      task: "Inspect code",
      metadata: {
        permissionMode: "dangerous",
        disabledTools: ["GitHub"]
      }
    });

    const drain = (async () => {
      for await (const _event of session.events()) {
        // drain
      }
    })();
    await session.sendUserMessage("continue");
    await drain;

    expect(fake.state.command).toBe("/opt/provider/bin/claude");
    expect(fake.state.cwd).toBe("/repo");
    expect(fake.state.args).toEqual(expect.arrayContaining([
      "--permission-mode",
      "plan",
      "--disallowedTools",
      "Bash,WebFetch,WebSearch"
    ]));
    expect(fake.state.args).not.toContain("GitHub");
  });

  it("rejects missing or invalid hosted command handoff before spawn", async () => {
    const fake = createFakeClaudeCodeCliProcessFactory();
    const clientMissing = createClaudeCodeCliClient({
      processFactory: fake.processFactory,
      hostedProviderCommand: {
        runtimeMode: "claude_code.sdk",
        executablePath: "/opt/provider/bin/claude",
        argv: [],
        cwd: "/repo",
        env: {},
        envKeys: [],
        allowUserArgs: false,
        redactedSummary: {}
      }
    });

    await expect(clientMissing.start({
      runId: "run_cli_invalid",
      cwd: "/repo",
      task: "Inspect code",
      metadata: {
        provider: {
          terminal: true
        }
      }
    })).rejects.toMatchObject({
      reasonCode: "provider_command_denied"
    });
  });

  it("maps hosted spawn unavailable and provider stderr with redaction", async () => {
    const hostedProviderCommand: ProviderResolvedCommand = {
      runtimeMode: "claude_code.sdk",
      executablePath: "/Users/example/bin/claude",
      argv: [],
      cwd: "/repo",
      env: {
        ANTHROPIC_API_KEY: "api-secret"
      },
      envKeys: ["ANTHROPIC_API_KEY"],
      allowUserArgs: false,
      redactedSummary: {}
    };
    const client = createClaudeCodeCliClient({
      hostedProviderCommand,
      processFactory: () => {
        throw new Error("ENOENT /Users/example/bin/claude api-secret");
      }
    });

    await expect(client.start({
      runId: "run_cli_spawn_fail",
      cwd: "/repo",
      task: "Inspect code",
      metadata: {}
    })).rejects.toMatchObject({
      reasonCode: "provider_binary_unavailable"
    });
  });

  it("does not leak unrelated process.env values in hosted mode", async () => {
    const captured: { env?: NodeJS.ProcessEnv } = {};
    const hostedProviderCommand: ProviderResolvedCommand = {
      runtimeMode: "claude_code.sdk",
      executablePath: "/opt/provider/bin/claude",
      argv: [],
      cwd: "/repo",
      env: {
        ANTHROPIC_API_KEY: "api-secret"
      },
      envKeys: ["ANTHROPIC_API_KEY"],
      allowUserArgs: false,
      redactedSummary: {}
    };
    const client = createClaudeCodeCliClient({
      processFactory: (_command, _args, options) => {
        captured.env = options.env;
        const process = new MinimalCliProcess();
        queueMicrotask(() => {
          process.stdout.write(`${JSON.stringify({ type: "completed" })}\n`);
          process.stdout.end();
          process.stderr.end();
          process.emit("exit", 0, null);
        });
        return process;
      },
      hostedProviderCommand
    });

    const session = await client.start({
      runId: "run_cli_env",
      cwd: "/repo",
      task: "Inspect code",
      metadata: {}
    });
    const drain = (async () => {
      for await (const _event of session.events()) {
        // drain
      }
    })();
    await drain;

    expect(captured.env).toEqual({
      ANTHROPIC_API_KEY: "api-secret"
    });
    expect(captured.env?.["HOME"]).toBeUndefined();
    expect(captured.env?.["PATH"]).toBeUndefined();
  });
});

class MinimalCliProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(_signal: NodeJS.Signals): boolean {
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0, null);
    return true;
  }
}
