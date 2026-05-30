import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "vitest";
import { AgentFieldAsyncRestAdapter, ClaudeCodeAdapter, CodexExecJsonAdapter, GenericHttpAsyncRestAdapter, OpenCodeAcpAdapter } from "../src/index.js";
import {
  FakeRuntimeAdapter,
  createFakeClaudeCodeClient,
  createFakeAcpProcessFactory,
  runRuntimeAdapterContract,
  startFakeAgentFieldServer,
  startFakeHttpRuntimeServer
} from "@switchyard/testkit";

describe("runtime adapter contract suite", () => {
  it("passes for fake runtime adapter", async () => {
    await runRuntimeAdapterContract({
      adapter: new FakeRuntimeAdapter(),
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process"
    });
  });

  it("passes for codex adapter with fake process", async () => {
    const adapter = new CodexExecJsonAdapter({
      processFactory: () => {
        const fake = new FakeCodexProcess();
        queueMicrotask(() => {
          fake.stdout.write("{\"type\":\"thread.started\",\"thread_id\":\"thread_1\"}\n");
          fake.stdout.write("{\"type\":\"turn.completed\"}\n");
          fake.stdout.end();
          fake.stderr.end();
          fake.emit("exit", 0, null);
        });
        return fake as never;
      }
    });

    await runRuntimeAdapterContract({
      adapter,
      runtime: "codex",
      provider: "openai",
      model: "gpt-5.5",
      adapterType: "process"
    });
  });

  it("passes for generic http adapter with fake wrapper server", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "happy" });
    try {
      await runRuntimeAdapterContract({
        adapter: new GenericHttpAsyncRestAdapter({ baseUrl: server.baseUrl }),
        runtime: "generic_http",
        provider: "generic_http",
        model: "generic-http-default",
        adapterType: "http"
      });
    } finally {
      await server.close();
    }
  });

  it("passes for agentfield adapter with fake agentfield server", async () => {
    const server = await startFakeAgentFieldServer({ scenario: "happy" });
    try {
      await runRuntimeAdapterContract({
        adapter: new AgentFieldAsyncRestAdapter({
          baseUrl: server.baseUrl,
          apiKey: "af-key",
          target: "research-agent.deep_analysis",
          pollIntervalMs: 5
        }),
        runtime: "agentfield",
        provider: "agentfield",
        model: "agentfield-default",
        adapterType: "http"
      });
    } finally {
      await server.close();
    }
  });

  it("passes for opencode acp adapter with fake acp process", async () => {
    await runRuntimeAdapterContract({
      adapter: new OpenCodeAcpAdapter({
        processFactory: createFakeAcpProcessFactory({ scenario: "happy" }),
        probeVersion: async () => ({ status: "ok", version: "1.3.15" })
      }),
      runtime: "opencode",
      provider: "opencode",
      model: "opencode-default",
      adapterType: "acpx"
    });
  });

  it("passes for claude code adapter with fake client", async () => {
    const fake = createFakeClaudeCodeClient({
      initialEvents: [{ type: "assistant_text_delta", text: "hello" }]
    });
    await runRuntimeAdapterContract({
      adapter: new ClaudeCodeAdapter({ client: fake.client }),
      runtime: "claude_code",
      provider: "anthropic",
      model: "claude-code-default",
      adapterType: "native",
      cwd: "/repo",
      task: "contract test run"
    });
  });
});

class FakeCodexProcess extends EventEmitter {
  pid = 9999;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();

  kill(): boolean {
    return true;
  }
}
