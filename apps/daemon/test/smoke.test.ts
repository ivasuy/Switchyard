import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type FastifyInstance } from "fastify";
import type { CodexCatalogProbe } from "@switchyard/adapters";
import {
  createFakeClaudeCodeClient,
  createFakeClaudeCodeCliProcessFactory,
  createFakeClaudeLiveProbe,
  createFakeCodexInteractiveSessionFactory,
  createFakeAcpProcessFactory,
  type FakeAcpRuntimeStats,
  startFakeAgentFieldServer,
  startFakeHttpRuntimeServer
} from "@switchyard/testkit";
import { createDaemonApp } from "../src/app.js";
import { loadDaemonConfig, type DaemonConfig } from "../src/config.js";
import { openSqliteStorage } from "@switchyard/storage";

function tempDaemonConfig(prefix: string): DaemonConfig {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: dir,
    sqlitePath: join(dir, "switchyard.sqlite"),
    artifactDir: join(dir, "artifacts"),
    opencode: {
      command: "opencode"
    },
    claudeCode: {
      command: "claude",
      liveProbe: false,
      maxBudgetUsd: 0.05,
      requestTimeoutMs: 5000
    },
    acp: {
      requestTimeoutMs: 250,
      cancelTimeoutMs: 250,
      maxMessageBytes: 1024 * 1024
    },
    genericHttp: {
      requestTimeoutMs: 5000,
      pollIntervalMs: 25,
      maxResponseBytes: 1024 * 1024
    },
    agentfield: {
      requestTimeoutMs: 5000,
      pollIntervalMs: 25,
      maxResponseBytes: 1024 * 1024
    }
  };
}

type CodexProbe = CodexCatalogProbe;

const unavailableCodexProbe = {
  ok: false,
  models: [],
  message: "codex not installed"
} satisfies CodexProbe;

const availableCodexProbe = {
  ok: true,
  version: "codex 0.0.0-test",
  models: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high"] }]
} satisfies CodexProbe;

const partialCodexProbe = {
  ok: true,
  version: "codex 0.0.0-test",
  models: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high"] }],
  optionalChecks: {
    sandbox_policy_probe: {
      ok: false,
      message: "optional sandbox probe failed"
    }
  }
} satisfies CodexProbe;

describe("daemon app", () => {
  it("loads opencode/acp config defaults and trims command", () => {
    const defaults = loadDaemonConfig({});
    expect(defaults.opencode.command).toBe("opencode");
    expect(defaults.acp.requestTimeoutMs).toBe(5000);
    expect(defaults.acp.cancelTimeoutMs).toBe(5000);
    expect(defaults.acp.maxMessageBytes).toBe(1024 * 1024);
    expect(defaults.claudeCode.command).toBe("claude");
    expect(defaults.claudeCode.liveProbe).toBe(false);
    expect(defaults.claudeCode.maxBudgetUsd).toBe(0.05);
    expect(defaults.claudeCode.requestTimeoutMs).toBe(5000);
    expect(defaults.agentfield?.requestTimeoutMs).toBe(5000);
    expect(defaults.agentfield?.pollIntervalMs).toBe(1000);
    expect(defaults.agentfield?.maxResponseBytes).toBe(1024 * 1024);

    const custom = loadDaemonConfig({
      SWITCHYARD_OPENCODE_COMMAND: "  /usr/local/bin/opencode  ",
      SWITCHYARD_ACP_REQUEST_TIMEOUT_MS: "1234",
      SWITCHYARD_ACP_CANCEL_TIMEOUT_MS: "5678",
      SWITCHYARD_ACP_MAX_MESSAGE_BYTES: "4096",
      SWITCHYARD_CLAUDE_CODE_COMMAND: "  /usr/local/bin/claude  ",
      SWITCHYARD_CLAUDE_CODE_LIVE_PROBE: "1",
      SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD: "0.2",
      SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS: "4321",
      SWITCHYARD_AGENTFIELD_BASE_URL: "  http://127.0.0.1:6060/prefix  ",
      SWITCHYARD_AGENTFIELD_API_KEY: "  af-key  ",
      SWITCHYARD_AGENTFIELD_TARGET: "  research-agent.deep_analysis  ",
      SWITCHYARD_AGENTFIELD_REQUEST_TIMEOUT_MS: "2222",
      SWITCHYARD_AGENTFIELD_POLL_INTERVAL_MS: "3333",
      SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES: "4444"
    });
    expect(custom.opencode.command).toBe("/usr/local/bin/opencode");
    expect(custom.acp.requestTimeoutMs).toBe(1234);
    expect(custom.acp.cancelTimeoutMs).toBe(5678);
    expect(custom.acp.maxMessageBytes).toBe(4096);
    expect(custom.claudeCode).toEqual({
      command: "/usr/local/bin/claude",
      liveProbe: true,
      maxBudgetUsd: 0.2,
      requestTimeoutMs: 4321
    });
    expect(custom.agentfield).toEqual({
      baseUrl: "http://127.0.0.1:6060/prefix",
      apiKey: "af-key",
      target: "research-agent.deep_analysis",
      requestTimeoutMs: 2222,
      pollIntervalMs: 3333,
      maxResponseBytes: 4444
    });
  });

  it("rejects shell catalog commands with relative executable paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-shell-catalog-relative-"));
    const catalogPath = join(dir, "shell-catalog.json");
    writeFileSync(catalogPath, JSON.stringify({
      commands: [
        {
          commandId: "local.relative",
          executablePath: "bin/date",
          argv: ["-u"],
          allowedCwdPrefixes: ["/repo"],
          env: {},
          maxArgs: 2
        }
      ]
    }));

    expect(() => loadDaemonConfig({
      SWITCHYARD_SHELL_COMMAND_CATALOG_PATH: catalogPath
    })).toThrow("config_invalid:SWITCHYARD_SHELL_COMMAND_CATALOG_PATH");

    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a fake run through the local REST API", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: unavailableCodexProbe });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "Smoke test run"
        }
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().run.status).toBe("completed");
    } finally {
      try {
        await app.close();
      } catch {
        // Ensure test cleanup continues if close fails.
      }
    }
  });

  it("uses the default Claude CLI client path when no claudeClient override is provided", async () => {
    const fake = createFakeClaudeCodeCliProcessFactory();
    const app = await createDaemonApp(undefined, {
      codexProbe: unavailableCodexProbe,
      claudeProcessFactory: fake.processFactory
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "claude_code",
          provider: "anthropic",
          model: "claude-code-default",
          adapterType: "native",
          cwd: "/repo",
          task: "Return one short sentence."
        }
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().run.status).toBe("completed");
      expect(fake.state.command).toBe("claude");
      expect(fake.state.args).toEqual(expect.arrayContaining([
        "-p",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json"
      ]));
    } finally {
      await app.close();
    }
  });

  it("runs the R7 middleware smoke path with context, approvals, fake_echo, and real-tool denial", async () => {
    const config = tempDaemonConfig("switchyard-daemon-r7-middleware-");
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const memory = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          scope: "project",
          content: "R7 uses fake_echo only"
        }
      });
      expect(memory.statusCode).toBe(201);

      const evidence = await app.inject({
        method: "POST",
        url: "/evidence",
        payload: {
          sourceType: "manual",
          title: "local evidence",
          reliability: "primary"
        }
      });
      expect(evidence.statusCode).toBe(201);

      const message = await app.inject({
        method: "POST",
        url: "/messages",
        payload: {
          channel: "r7-smoke",
          content: "message context"
        }
      });
      expect(message.statusCode).toBe(201);

      const run = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "Use middleware context",
          context: {
            memoryIds: [memory.json().memory.id],
            evidenceIds: [evidence.json().evidence.id],
            messageIds: [message.json().message.id]
          }
        }
      });
      expect(run.statusCode).toBe(201);
      expect(run.json().run.metadata.originalTask).toBe("Use middleware context");
      expect(run.json().run.metadata.contextPacket).toBeTruthy();

      const safeTool = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: {
          runId: run.json().run.id,
          type: "fake_echo",
          input: { text: "hello" }
        }
      });
      expect(safeTool.statusCode).toBe(201);
      expect(safeTool.json().invocation.output.echo).toBe("hello");

      const approvalTool = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: {
          runId: run.json().run.id,
          type: "fake_echo",
          input: { text: "approve me", requiresApproval: true }
        }
      });
      expect(approvalTool.statusCode).toBe(202);
      const approvalId = approvalTool.json().approval.id as string;

      const approved = await app.inject({
        method: "POST",
        url: `/approvals/${approvalId}/approve`,
        payload: { actor: "local-user", reason: "ok" }
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().invocation.status).toBe("completed");

      const rejectedTool = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: {
          runId: run.json().run.id,
          type: "fake_echo",
          input: { text: "reject me", requiresApproval: true }
        }
      });
      expect(rejectedTool.statusCode).toBe(202);
      const rejectedApprovalId = rejectedTool.json().approval.id as string;
      const rejected = await app.inject({
        method: "POST",
        url: `/approvals/${rejectedApprovalId}/reject`,
        payload: { actor: "local-user", reason: "no" }
      });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json().invocation.status).toBe("denied");

      const deniedTool = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: {
          runId: run.json().run.id,
          type: "shell",
          input: { commandId: "local.date.utc", cwd: "/repo" }
        }
      });
      expect(deniedTool.statusCode).toBe(403);
      expect(deniedTool.json().error.code).toBe("tool_policy_denied");

      await app.close();
      const reopened = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      try {
        const memoryList = await reopened.inject({ method: "GET", url: "/memory" });
        const evidenceList = await reopened.inject({ method: "GET", url: "/evidence" });
        const messageList = await reopened.inject({ method: "GET", url: "/messages" });
        expect(memoryList.statusCode).toBe(200);
        expect(evidenceList.statusCode).toBe(200);
        expect(messageList.statusCode).toBe(200);
        expect(memoryList.json().memory.length).toBeGreaterThan(0);
        expect(evidenceList.json().evidence.length).toBeGreaterThan(0);
        expect(messageList.json().messages.length).toBeGreaterThan(0);
      } finally {
        await reopened.close();
      }
    } finally {
      try {
        await app.close();
      } catch {
        // best effort
      }
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("runs R9 debate smoke in in-memory mode with metadata-only report content", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: unavailableCodexProbe });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/debates?wait=1",
        payload: {
          topic: "Should fake debate ship first?",
          participants: [{ role: "affirmative" }, { role: "skeptic" }]
        }
      });
      expect(created.statusCode).toBe(201);
      const body = created.json();
      expect(body.debate.status).toBe("no_consensus");
      expect(body.debate.participants).toHaveLength(2);
      expect(body.debate.messageIds.length).toBeGreaterThan(0);
      expect(body.finalReportArtifact).toBeTruthy();

      const inspect = await app.inject({
        method: "GET",
        url: `/debates/${body.debate.id}`
      });
      expect(inspect.statusCode).toBe(200);
      expect(inspect.json().artifacts.length).toBeGreaterThan(0);
      const artifactId = inspect.json().artifacts[0].id as string;

      const missingContent = await app.inject({
        method: "GET",
        url: `/artifacts/${artifactId}/content`
      });
      expect(missingContent.statusCode).toBe(404);
      expect(missingContent.json().error.code).toBe("missing_artifact_content");
    } finally {
      await app.close();
    }
  });

  it("runs R9 debate smoke in configured storage mode and persists report content across reopen", async () => {
    const config = tempDaemonConfig("switchyard-daemon-r9-debate-");
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const evidence = await app.inject({
        method: "POST",
        url: "/evidence",
        payload: {
          sourceType: "manual",
          title: "Debate evidence",
          snippet: "bounded fake debate",
          reliability: "primary"
        }
      });
      expect(evidence.statusCode).toBe(201);
      const evidenceId = evidence.json().evidence.id as string;

      const created = await app.inject({
        method: "POST",
        url: "/debates?wait=1",
        payload: {
          topic: "Should fake debate ship first?",
          participants: [{ role: "affirmative" }, { role: "skeptic" }],
          evidenceIds: [evidenceId]
        }
      });
      expect(created.statusCode).toBe(201);
      const createdBody = created.json();
      const debateId = createdBody.debate.id as string;
      const artifactId = createdBody.finalReportArtifact.id as string;

      const content = await app.inject({
        method: "GET",
        url: `/artifacts/${artifactId}/content`
      });
      expect(content.statusCode).toBe(200);
      expect(content.body).toContain("# Debate Report:");
      expect(content.body).toContain("## Judge Summary");

      await app.close();
      const reopened = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      try {
        const inspect = await reopened.inject({
          method: "GET",
          url: `/debates/${debateId}`
        });
        expect(inspect.statusCode).toBe(200);
        expect(inspect.json().debate.finalReportArtifactId).toBe(artifactId);
      } finally {
        await reopened.close();
      }
    } finally {
      try {
        await app.close();
      } catch {
        // best effort
      }
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("persists fake run events and artifacts when configured with local storage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-daemon-"));
    const config: DaemonConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      sqlitePath: join(dir, "switchyard.sqlite"),
      artifactDir: join(dir, "artifacts"),
      opencode: {
        command: "opencode"
      },
      claudeCode: {
        command: "claude",
        liveProbe: false,
        maxBudgetUsd: 0.05,
        requestTimeoutMs: 5000
      },
      acp: {
        requestTimeoutMs: 250,
        cancelTimeoutMs: 250,
        maxMessageBytes: 1024 * 1024
      },
      genericHttp: {
        requestTimeoutMs: 5000,
        pollIntervalMs: 25,
        maxResponseBytes: 1024 * 1024
      }
    };

    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    let reopened: FastifyInstance | undefined;
    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "Persistent smoke test"
        }
      });
      expect(response.statusCode).toBe(201);
      const run = response.json().run;
      expect(run).toMatchObject({ id: expect.any(String) });
      const runId = run.id;

      await app.close();
      reopened = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      const getRun = await reopened.inject({ method: "GET", url: `/runs/${runId}` });
      const artifacts = await reopened.inject({ method: "GET", url: `/runs/${runId}/artifacts` });
      const events = await reopened.inject({ method: "GET", url: `/runs/${runId}/events` });
      const provider = await reopened.inject({ method: "GET", url: "/providers/provider_test" });
      const runtime = await reopened.inject({ method: "GET", url: "/runtimes/runtime_fake" });
      const model = await reopened.inject({ method: "GET", url: "/models/model_test" });

      expect(events.statusCode).toBe(200);
      expect(provider.statusCode).toBe(200);
      expect(runtime.statusCode).toBe(200);
      expect(model.statusCode).toBe(200);
      expect(artifacts.statusCode).toBe(200);
      expect(artifacts.json().artifacts).toHaveLength(1);
      expect(getRun.statusCode).toBe(200);
      expect(getRun.json().run.status).toBe("completed");
      expect(events.body).toContain("event: run.queued");
      expect(events.body).toContain("event: run.completed");
      const artifact = artifacts.json().artifacts[0];
      expect(artifact).toMatchObject({ runId, type: "transcript" });
      expect(readFileSync(join(config.artifactDir, artifact.path), "utf8")).toContain("fake runtime output");
      expect(provider.json().provider.name).toBe("Test Provider");
      expect(runtime.json().runtime.name).toBe("Fake Runtime");
      expect(model.json().model.modelName).toBe("test-model");
    } finally {
      try {
        await app.close();
      } catch {
        // Ensure temp data cleanup runs even if app close fails.
      }

      if (reopened) {
        try {
          await reopened.close();
        } catch {
          // Keep cleanup resilient for repeated-run assertions.
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Do not fail cleanup on best-effort temp cleanup.
      }
    }
  });

  it("marks codex provider/runtime unavailable and does not seed codex models when probe is unavailable", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: unavailableCodexProbe });
    try {
      const provider = await app.inject({ method: "GET", url: "/providers/provider_openai" });
      const runtime = await app.inject({ method: "GET", url: "/runtimes/runtime_codex" });
      const model = await app.inject({ method: "GET", url: "/models/model_gpt_5_5" });

      expect(provider.statusCode).toBe(200);
      expect(runtime.statusCode).toBe(200);
      expect(provider.json().provider).toMatchObject({
        id: "provider_openai",
        name: "OpenAI",
        authMode: "local"
      });
      expect(runtime.json().runtime).toMatchObject({
        id: "runtime_codex",
        name: "Codex",
        adapterType: "process"
      });
      expect(provider.json().provider.status).toBe("unavailable");
      expect(runtime.json().runtime.status).toBe("unavailable");
      expect(model.statusCode).toBe(404);
    } finally {
      try {
        await app.close();
      } catch {
        // Keep test cleanup resilient if close throws.
      }
    }
  });

  it("marks codex provider/runtime available and seeds codex model records when probe is available", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: availableCodexProbe });
    try {
      const provider = await app.inject({ method: "GET", url: "/providers/provider_openai" });
      const runtime = await app.inject({ method: "GET", url: "/runtimes/runtime_codex" });
      const model = await app.inject({ method: "GET", url: "/models/model_gpt_5_5" });

      expect(provider.statusCode).toBe(200);
      expect(runtime.statusCode).toBe(200);
      expect(model.statusCode).toBe(200);
      expect(provider.json().provider.status).toBe("available");
      expect(runtime.json().runtime.status).toBe("available");
      expect(model.json().model).toMatchObject({
        id: "model_gpt_5_5",
        providerId: "provider_openai",
        modelName: "gpt-5.5",
        supportsTools: true,
        supportsStreaming: true,
        supportsBrowser: false,
        status: "available"
      });
    } finally {
      try {
        await app.close();
      } catch {
        // Keep test cleanup resilient if close throws.
      }
    }
  });

  it("exposes runtime mode and doctor routes with seeded runtime mode availability", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: availableCodexProbe });
    try {
      const list = await app.inject({ method: "GET", url: "/runtime-modes" });
      const codex = await app.inject({ method: "GET", url: "/runtime-modes/codex.exec_json" });
      const doctor = await app.inject({ method: "GET", url: "/doctor" });
      expect(list.statusCode).toBe(200);
      expect(list.json().runtimeModes.map((mode: { slug: string }) => mode.slug).sort()).toEqual([
        "agentfield.async_rest",
        "claude_code.sdk",
        "codex.exec_json",
        "codex.interactive",
        "fake.deterministic",
        "generic_http.async_rest",
        "opencode.acp"
      ]);
      expect(codex.statusCode).toBe(200);
      expect(codex.json().runtimeMode.availability.state).toBe("available");
      const claude = await app.inject({ method: "GET", url: "/runtime-modes/claude_code.sdk" });
      expect(claude.statusCode).toBe(200);
      expect(claude.json().runtimeMode.availability.reasonCode).toBe("live_probe_disabled");
      expect(doctor.statusCode).toBe(200);
      expect(doctor.json().summary.available).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("supports no-spend codex interactive create/input/check paths with fake session factory", async () => {
    const fake = createFakeCodexInteractiveSessionFactory({ kind: "default" });
    const app = await createDaemonApp(undefined, {
      codexProbe: availableCodexProbe,
      codexInteractiveSessionFactory: fake.factory
    });
    try {
      const modes = await app.inject({ method: "GET", url: "/runtime-modes" });
      expect(modes.statusCode).toBe(200);
      expect(modes.json().runtimeModes.some((mode: { slug: string }) => mode.slug === "codex.interactive")).toBe(true);

      const check = await app.inject({ method: "POST", url: "/runtime-modes/codex.interactive/check" });
      expect(check.statusCode).toBe(200);
      expect(check.json().check.runtimeMode).toBe("codex.interactive");
      expect(fake.state.checkCalls.length).toBeGreaterThanOrEqual(2);

      const inferred = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "codex",
          provider: "openai",
          model: "gpt-5.5",
          adapterType: "process",
          cwd: "/repo",
          task: "infer codex mode"
        }
      });
      expect(inferred.statusCode).toBe(202);
      expect(inferred.json().run.runtimeMode).toBe("codex.exec_json");

      const created = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "codex",
          provider: "openai",
          model: "gpt-5.5",
          adapterType: "process",
          runtimeMode: "codex.interactive",
          cwd: "/repo",
          task: "wait for input"
        }
      });
      expect(created.statusCode).toBe(202);
      const runId = created.json().run.id as string;

      await new Promise((resolve) => setTimeout(resolve, 20));
      const runAfterStart = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(runAfterStart.statusCode).toBe(200);
      expect(runAfterStart.json().run.status).toBe("waiting_for_input");

      const input = await app.inject({
        method: "POST",
        url: `/runs/${runId}/input`,
        payload: { text: "continue" }
      });
      expect(input.statusCode).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const runAfterInput = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(runAfterInput.statusCode).toBe(200);
      expect(["waiting_for_input", "completed"]).toContain(runAfterInput.json().run.status);
      expect(fake.state.resumes.length).toBeGreaterThanOrEqual(1);
      expect(fake.state.liveProviderCalls.length).toBe(0);
      expect(fake.state.commands.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("seeds generic http mode as unavailable when base URL is missing", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: unavailableCodexProbe });
    try {
      const mode = await app.inject({ method: "GET", url: "/runtime-modes/generic_http.async_rest" });
      expect(mode.statusCode).toBe(200);
      expect(mode.json().runtimeMode.availability.reasonCode).toBe("generic_http_config_missing");
      expect(mode.json().runtimeMode.availability.state).toBe("unavailable");
    } finally {
      await app.close();
    }
  });

  it("supports fake claude runtime input and live probe safety flags without real model calls", async () => {
    const config = tempDaemonConfig("switchyard-daemon-r8-claude-");
    config.claudeCode.liveProbe = true;
    const fake = createFakeClaudeCodeClient({
      initialEvents: [{ type: "session", sessionId: "claude-session-1" }],
      waitForInputText: true
    });
    const app = await createDaemonApp(config, {
      codexProbe: unavailableCodexProbe,
      claudeClient: fake.client,
      claudeVersionProbe: async () => ({ ok: true, version: "2.1.156" }),
      claudeAuthProbe: async () => ({ ok: true }),
      claudeLiveProbe: createFakeClaudeLiveProbe(fake.state)
    });
    try {
      const check = await app.inject({
        method: "POST",
        url: "/runtime-modes/claude_code.sdk/check"
      });
      expect(check.statusCode).toBe(200);
      expect(fake.state.liveProbeCalls).toHaveLength(1);
      expect(fake.state.liveProbeCalls[0]).toMatchObject({
        maxBudgetUsd: 0.05,
        permissionMode: "read_only"
      });

      const created = await app.inject({
        method: "POST",
        url: "/runs?wait=0",
        payload: {
          runtime: "claude_code",
          provider: "anthropic",
          model: "claude-code-default",
          adapterType: "native",
          cwd: "/repo",
          task: "Wait for input"
        }
      });
      expect(created.statusCode).toBe(202);
      const runId = created.json().run.id as string;

      await new Promise((resolve) => setTimeout(resolve, 10));
      const input = await app.inject({
        method: "POST",
        url: `/runs/${runId}/input`,
        payload: { text: "continue" }
      });
      expect(input.statusCode).toBe(202);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const run = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(run.statusCode).toBe(200);
      expect(run.json().run.status).toBe("completed");
    } finally {
      await app.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("seeds agentfield mode as unavailable when required config is missing", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: unavailableCodexProbe });
    try {
      const mode = await app.inject({ method: "GET", url: "/runtime-modes/agentfield.async_rest" });
      expect(mode.statusCode).toBe(200);
      expect(mode.json().runtimeMode.availability.reasonCode).toBe("agentfield_config_missing");
      expect(mode.json().runtimeMode.availability.state).toBe("unavailable");
    } finally {
      await app.close();
    }
  });

  it("runs generic http checks and wait=1 lifecycle against fake wrapper", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "happy" });
    const config = tempDaemonConfig("switchyard-daemon-generic-http-");
    config.genericHttp.baseUrl = server.baseUrl;
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const check = await app.inject({ method: "POST", url: "/runtime-modes/generic_http.async_rest/check" });
      expect(check.statusCode).toBe(200);
      expect(check.json().check.state).toBe("available");

      const run = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "generic_http",
          provider: "generic_http",
          model: "generic-http-default",
          adapterType: "http",
          cwd: "/repo",
          task: "generic http smoke"
        }
      });
      expect(run.statusCode).toBe(201);
      expect(run.json().run.runtimeMode).toBe("generic_http.async_rest");
      expect(run.json().run.status).toBe("completed");
      expect(run.json().response.text).toBe("generic-http output");

      const runId = run.json().run.id;
      const artifacts = await app.inject({ method: "GET", url: `/runs/${runId}/artifacts` });
      expect(artifacts.statusCode).toBe(200);
      expect(artifacts.json().artifacts.some((artifact: { path: string }) => artifact.path.includes("generic-http-transcript"))).toBe(true);
      const input = await app.inject({
        method: "POST",
        url: `/runs/${runId}/input`,
        payload: { text: "continue" }
      });
      expect(input.statusCode).toBe(409);
      expect(input.json().error.code).toBe("adapter_protocol_failed");
    } finally {
      await app.close();
      await server.close();
    }
  });

  it("maps generic http cancel protocol failures to 409 without silent cancellation", async () => {
    const server = await startFakeHttpRuntimeServer({ scenario: "cancel_accepted_but_status_running" });
    const config = tempDaemonConfig("switchyard-daemon-generic-cancel-");
    config.genericHttp.baseUrl = server.baseUrl;
    config.genericHttp.pollIntervalMs = 10;
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "generic_http",
          provider: "generic_http",
          model: "generic-http-default",
          adapterType: "http",
          cwd: "/repo",
          task: "cancel protocol failure"
        }
      });
      expect(created.statusCode).toBe(202);
      const runId = created.json().run.id;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const read = await app.inject({ method: "GET", url: `/runs/${runId}` });
        if (read.statusCode === 200 && read.json().run.status === "running") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cancel = await app.inject({ method: "POST", url: `/runs/${runId}/cancel` });
      expect(cancel.statusCode).toBe(409);
      expect(cancel.json().error.code).toBe("adapter_protocol_failed");
      const read = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(read.statusCode).toBe(200);
      expect(read.json().run.status).not.toBe("cancelled");
    } finally {
      await app.close();
      await server.close();
    }
  });

  it("runs agentfield checks and wait=1 lifecycle against fake server without leaking API key", async () => {
    const server = await startFakeAgentFieldServer({ scenario: "happy", expectedApiKey: "af-secret-key" });
    const config = tempDaemonConfig("switchyard-daemon-agentfield-");
    config.agentfield = {
      baseUrl: server.baseUrl,
      apiKey: "af-secret-key",
      target: "research-agent.deep_analysis",
      requestTimeoutMs: 5000,
      pollIntervalMs: 10,
      maxResponseBytes: 1024 * 1024
    };
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const check = await app.inject({ method: "POST", url: "/runtime-modes/agentfield.async_rest/check" });
      expect(check.statusCode).toBe(200);
      expect(check.json().check.state).toBe("available");
      expect(JSON.stringify(check.json())).not.toContain("af-secret-key");
      expect(server.stats.executeAsyncCalls).toBe(0);

      const run = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "agentfield",
          provider: "agentfield",
          model: "agentfield-default",
          adapterType: "http",
          cwd: "/repo",
          task: "agentfield smoke",
          timeoutSeconds: 30
        }
      });
      expect(run.statusCode).toBe(201);
      expect(run.json().run.runtimeMode).toBe("agentfield.async_rest");
      expect(run.json().run.status).toBe("completed");
      expect(run.json().response.text).toBe("agentfield output");

      const runId = run.json().run.id as string;
      const artifacts = await app.inject({ method: "GET", url: `/runs/${runId}/artifacts` });
      expect(artifacts.statusCode).toBe(200);
      const transcript = artifacts.json().artifacts.find((artifact: { path: string }) =>
        artifact.path === `runs/${runId}/agentfield-transcript.jsonl`
      );
      const result = artifacts.json().artifacts.find((artifact: { path: string }) =>
        artifact.path === `runs/${runId}/agentfield-result.json`
      );
      expect(transcript).toBeDefined();
      expect(result).toBeDefined();

      const transcriptContent = await app.inject({ method: "GET", url: `/artifacts/${String(transcript.id)}/content` });
      const resultContent = await app.inject({ method: "GET", url: `/artifacts/${String(result.id)}/content` });
      expect(transcriptContent.statusCode).toBe(200);
      expect(resultContent.statusCode).toBe(200);
      expect(transcriptContent.body).not.toContain("af-secret-key");
      expect(resultContent.body).not.toContain("af-secret-key");

      const input = await app.inject({
        method: "POST",
        url: `/runs/${runId}/input`,
        payload: { text: "continue" }
      });
      expect(input.statusCode).toBe(409);
      const reasonCode = input.json().error.details?.find((detail: { path: string }) => detail.path === "reasonCode")?.issue;
      expect(["agentfield_input_unsupported", "runtime_input_not_active"]).toContain(reasonCode);
    } finally {
      await app.close();
      await server.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("maps active agentfield cancel to 409 adapter_protocol_failed and keeps run non-cancelled", async () => {
    const server = await startFakeAgentFieldServer({ scenario: "pending_forever", expectedApiKey: "af-key" });
    const config = tempDaemonConfig("switchyard-daemon-agentfield-cancel-");
    config.agentfield = {
      baseUrl: server.baseUrl,
      apiKey: "af-key",
      target: "research-agent.deep_analysis",
      requestTimeoutMs: 5000,
      pollIntervalMs: 10,
      maxResponseBytes: 1024 * 1024
    };
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "agentfield",
          provider: "agentfield",
          model: "agentfield-default",
          adapterType: "http",
          cwd: "/repo",
          task: "cancel unsupported"
        }
      });
      expect(created.statusCode).toBe(202);
      const runId = created.json().run.id as string;
      await waitForRunStatus(app, runId, "running");
      await new Promise((resolve) => setTimeout(resolve, 50));

      const cancel = await app.inject({ method: "POST", url: `/runs/${runId}/cancel` });
      expect(cancel.statusCode).toBe(409);
      expect(cancel.json().error.code).toBe("adapter_protocol_failed");
      expect(cancel.json().error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "reasonCode", issue: "agentfield_cancel_unsupported" })])
      );

      const read = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(read.statusCode).toBe(200);
      expect(read.json().run.status).not.toBe("cancelled");
    } finally {
      await app.close();
      await server.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("persists Switchyard timeout for agentfield when upstream cancel is unsupported", async () => {
    const server = await startFakeAgentFieldServer({ scenario: "pending_forever", expectedApiKey: "af-key" });
    const config = tempDaemonConfig("switchyard-daemon-agentfield-timeout-");
    config.agentfield = {
      baseUrl: server.baseUrl,
      apiKey: "af-key",
      target: "research-agent.deep_analysis",
      requestTimeoutMs: 5000,
      pollIntervalMs: 10,
      maxResponseBytes: 1024 * 1024
    };
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const timedOut = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "agentfield",
          provider: "agentfield",
          model: "agentfield-default",
          adapterType: "http",
          cwd: "/repo",
          task: "timeout run",
          timeoutSeconds: 1
        }
      });
      expect(timedOut.statusCode).toBe(201);
      expect(timedOut.json().run.status).toBe("timeout");

      const runId = timedOut.json().run.id as string;
      const events = await app.inject({ method: "GET", url: `/runs/${runId}/events` });
      expect(events.statusCode).toBe(200);
      expect((events.body.match(/event: run\.failed/g) ?? []).length).toBe(1);
    } finally {
      await app.close();
      await server.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("keeps timed-out agentfield run terminal when upstream later succeeds", async () => {
    const server = await startFakeAgentFieldServer({
      scenario: "late_success",
      expectedApiKey: "af-key",
      lateSuccessPollCount: 20
    });
    const config = tempDaemonConfig("switchyard-daemon-agentfield-race-");
    config.agentfield = {
      baseUrl: server.baseUrl,
      apiKey: "af-key",
      target: "research-agent.deep_analysis",
      requestTimeoutMs: 5000,
      pollIntervalMs: 100,
      maxResponseBytes: 1024 * 1024
    };
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const timedOut = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "agentfield",
          provider: "agentfield",
          model: "agentfield-default",
          adapterType: "http",
          cwd: "/repo",
          task: "late success race",
          timeoutSeconds: 1
        }
      });
      expect(timedOut.statusCode).toBe(201);
      expect(timedOut.json().run.status).toBe("timeout");
      const runId = timedOut.json().run.id as string;

      await new Promise((resolve) => setTimeout(resolve, 1400));
      const read = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(read.statusCode).toBe(200);
      expect(read.json().run.status).toBe("timeout");
    } finally {
      await app.close();
      await server.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("seeds opencode.acp runtime mode and runs bounded doctor checks without prompts", async () => {
    const stats: FakeAcpRuntimeStats = { prompts: 0, cancels: 0, permissionResponses: 0 };
    const app = await createDaemonApp(undefined, {
      codexProbe: unavailableCodexProbe,
      opencodeProcessFactory: createFakeAcpProcessFactory({ scenario: "stderr_warning", stats }),
      opencodeProbeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    try {
      const modes = await app.inject({ method: "GET", url: "/runtime-modes" });
      expect(modes.statusCode).toBe(200);
      expect(modes.json().runtimeModes.some((mode: { slug: string }) => mode.slug === "opencode.acp")).toBe(true);

      const seeded = await app.inject({ method: "GET", url: "/runtime-modes/opencode.acp" });
      expect(seeded.statusCode).toBe(200);
      expect(seeded.json().runtimeMode.availability.reasonCode).toBe("not_checked");

      const checked = await app.inject({ method: "POST", url: "/runtime-modes/opencode.acp/check" });
      expect(checked.statusCode).toBe(200);
      expect(checked.json().check.state).toBe("partial");
      expect(checked.json().check.reasonCode).toBe("opencode_stderr_warning");
      expect(stats.prompts).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("runs opencode.acp with runtime-mode inference, supports artifact retrieval, and rejects unsupported input/internal ids", async () => {
    const config = tempDaemonConfig("switchyard-daemon-opencode-run-");
    const app = await createDaemonApp(config, {
      codexProbe: unavailableCodexProbe,
      opencodeProcessFactory: createFakeAcpProcessFactory({ scenario: "happy" }),
      opencodeProbeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    try {
      const run = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "opencode",
          provider: "opencode",
          model: "opencode-default",
          adapterType: "acpx",
          cwd: "/repo",
          task: "opencode smoke"
        }
      });
      expect(run.statusCode).toBe(201);
      expect(run.json().run.runtimeMode).toBe("opencode.acp");
      expect(run.json().run.status).toBe("completed");

      const runId = run.json().run.id as string;
      const artifacts = await app.inject({ method: "GET", url: `/runs/${runId}/artifacts` });
      expect(artifacts.statusCode).toBe(200);
      const transcript = artifacts.json().artifacts.find((artifact: { path: string }) =>
        artifact.path === `runs/${runId}/opencode-acp-transcript.jsonl`
      );
      expect(transcript).toBeDefined();

      const artifactId = String(transcript.id);
      const artifact = await app.inject({ method: "GET", url: `/artifacts/${artifactId}` });
      expect(artifact.statusCode).toBe(200);
      expect(artifact.json().artifact.path).toBe(`runs/${runId}/opencode-acp-transcript.jsonl`);

      const content = await app.inject({ method: "GET", url: `/artifacts/${artifactId}/content` });
      expect(content.statusCode).toBe(200);
      expect(content.body).toContain("\"method\":\"session/prompt\"");

      const input = await app.inject({
        method: "POST",
        url: `/runs/${runId}/input`,
        payload: { text: "continue" }
      });
      expect(input.statusCode).toBe(409);
      expect(input.json().error.code).toBe("adapter_protocol_failed");
      const reasonCode = input.json().error.details?.find((detail: { path: string }) => detail.path === "reasonCode")?.issue;
      expect(["opencode_input_unsupported", "runtime_input_not_active"]).toContain(reasonCode);

      const internalId = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "opencode",
          provider: "opencode",
          model: "opencode-default",
          adapterType: "acpx",
          runtimeMode: "runtime_mode_opencode_acp",
          cwd: "/repo",
          task: "bad id"
        }
      });
      expect(internalId.statusCode).toBe(400);
      expect(internalId.json().error.code).toBe("invalid_input");
    } finally {
      await app.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("persists exactly one opencode transcript artifact after verified cancel", async () => {
    const config = tempDaemonConfig("switchyard-daemon-opencode-cancel-");
    const app = await createDaemonApp(config, {
      codexProbe: unavailableCodexProbe,
      opencodeProcessFactory: createFakeAcpProcessFactory({ scenario: "cancelled" }),
      opencodeProbeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "opencode",
          provider: "opencode",
          model: "opencode-default",
          adapterType: "acpx",
          cwd: "/repo",
          task: "cancel me"
        }
      });
      expect(created.statusCode).toBe(202);
      const runId = created.json().run.id as string;
      await waitForRunStatus(app, runId, "running");

      const cancel = await app.inject({ method: "POST", url: `/runs/${runId}/cancel` });
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json().run.status).toBe("cancelled");

      const artifacts = await app.inject({ method: "GET", url: `/runs/${runId}/artifacts` });
      expect(artifacts.statusCode).toBe(200);
      const transcripts = artifacts
        .json()
        .artifacts.filter((artifact: { path: string }) => artifact.path.endsWith("/opencode-acp-transcript.jsonl"));
      expect(transcripts).toHaveLength(1);

      const artifactId = String(transcripts[0].id);
      const artifact = await app.inject({ method: "GET", url: `/artifacts/${artifactId}` });
      const content = await app.inject({ method: "GET", url: `/artifacts/${artifactId}/content` });
      expect(artifact.statusCode).toBe(200);
      expect(content.statusCode).toBe(200);
      expect(content.body).toContain("\"method\":\"session/cancel\"");
    } finally {
      await app.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("persists opencode transcript artifacts on failed-after-start and timeout-after-start runs", async () => {
    const config = tempDaemonConfig("switchyard-daemon-opencode-fail-timeout-");
    const app = await createDaemonApp(config, {
      codexProbe: unavailableCodexProbe,
      opencodeProcessFactory: createFakeAcpProcessFactory({ scenario: "prompt_failed" }),
      opencodeProbeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    try {
      const failed = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "opencode",
          provider: "opencode",
          model: "opencode-default",
          adapterType: "acpx",
          cwd: "/repo",
          task: "fail me"
        }
      });
      expect(failed.statusCode).toBe(201);
      expect(failed.json().run.status).toBe("failed");
      const failedRunId = failed.json().run.id as string;
      await expectTranscriptArtifactRetrievable(app, failedRunId);
    } finally {
      await app.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }

    const timeoutConfig = tempDaemonConfig("switchyard-daemon-opencode-timeout-");
    timeoutConfig.acp.requestTimeoutMs = 5000;
    const timeoutApp = await createDaemonApp(timeoutConfig, {
      codexProbe: unavailableCodexProbe,
      opencodeProcessFactory: createFakeAcpProcessFactory({ scenario: "cancel_unverified" }),
      opencodeProbeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    try {
      const timedOut = await timeoutApp.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "opencode",
          provider: "opencode",
          model: "opencode-default",
          adapterType: "acpx",
          timeoutSeconds: 1,
          cwd: "/repo",
          task: "timeout me"
        }
      });
      expect(timedOut.statusCode).toBe(201);
      expect(timedOut.json().run.status).toBe("timeout");
      const timeoutRunId = timedOut.json().run.id as string;
      await expectTranscriptArtifactRetrievable(timeoutApp, timeoutRunId);
    } finally {
      await timeoutApp.close();
      rmSync(timeoutConfig.dataDir, { recursive: true, force: true });
    }
  });

  it("maps opencode unverified public cancel to 409 and keeps run non-cancelled", async () => {
    const config = tempDaemonConfig("switchyard-daemon-opencode-cancel-unverified-");
    config.acp.cancelTimeoutMs = 30;
    const app = await createDaemonApp(config, {
      codexProbe: unavailableCodexProbe,
      opencodeProcessFactory: createFakeAcpProcessFactory({ scenario: "cancel_unverified" }),
      opencodeProbeVersion: async () => ({ status: "ok", version: "1.3.15" })
    });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "opencode",
          provider: "opencode",
          model: "opencode-default",
          adapterType: "acpx",
          cwd: "/repo",
          task: "cancel verify fail"
        }
      });
      expect(created.statusCode).toBe(202);
      const runId = created.json().run.id as string;
      await waitForRunStatus(app, runId, "running");

      const cancel = await app.inject({ method: "POST", url: `/runs/${runId}/cancel` });
      expect(cancel.statusCode).toBe(409);
      expect(cancel.json().error.code).toBe("adapter_protocol_failed");
      expect(cancel.json().error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "reasonCode", issue: "acp_cancel_unverified" })])
      );

      const read = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(read.statusCode).toBe(200);
      expect(read.json().run.status).not.toBe("cancelled");
    } finally {
      await app.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("records partial codex availability during startup and in /doctor summary", async () => {
    const app = await createDaemonApp(undefined, { codexProbe: partialCodexProbe });
    try {
      const codex = await app.inject({ method: "GET", url: "/runtime-modes/codex.exec_json" });
      const doctor = await app.inject({ method: "GET", url: "/doctor" });
      expect(codex.statusCode).toBe(200);
      expect(codex.json().runtimeMode.availability.state).toBe("partial");
      expect(codex.json().runtimeMode.availability.reasonCode).toBe("optional_check_failed");
      expect(doctor.statusCode).toBe(200);
      expect(doctor.json().summary.partial).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  it("runs bounded active checks and updates stored codex availability", async () => {
    const checkProbe = async () => ({
      ok: true,
      version: "codex 0.0.0-test",
      models: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high"] }]
    });
    const app = await createDaemonApp(undefined, {
      codexProbe: unavailableCodexProbe,
      probeCodexCatalog: checkProbe,
      checkTimeoutMs: 50,
      maxDiagnosticBytes: 128
    });
    try {
      const check = await app.inject({ method: "POST", url: "/runtime-modes/codex.exec_json/check" });
      const doctor = await app.inject({ method: "GET", url: "/doctor" });
      expect(check.statusCode).toBe(200);
      expect(check.json().check.state).toBe("available");
      expect(doctor.statusCode).toBe(200);
      expect(doctor.json().summary.available).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("maps required-pass plus optional-fail active checks to partial and updates /doctor", async () => {
    const partialCheckProbe = async () => ({
      ok: true,
      version: "codex 0.0.0-test",
      models: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high"] }],
      optionalChecks: {
        sandbox_policy_probe: {
          ok: false,
          message: "optional sandbox probe failed"
        }
      }
    });
    const app = await createDaemonApp(undefined, {
      codexProbe: unavailableCodexProbe,
      probeCodexCatalog: partialCheckProbe,
      checkTimeoutMs: 50,
      maxDiagnosticBytes: 128
    });
    try {
      const check = await app.inject({ method: "POST", url: "/runtime-modes/codex.exec_json/check" });
      const doctor = await app.inject({ method: "GET", url: "/doctor" });
      const mode = await app.inject({ method: "GET", url: "/runtime-modes/codex.exec_json" });
      expect(check.statusCode).toBe(200);
      expect(check.json().check.state).toBe("partial");
      expect(check.json().check.reasonCode).toBe("optional_check_failed");
      expect(check.json().check.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "sandbox_policy_probe",
            severity: "warning"
          })
        ])
      );
      expect(mode.statusCode).toBe(200);
      expect(mode.json().runtimeMode.availability.state).toBe("partial");
      expect(mode.json().runtimeMode.availability.reasonCode).toBe("optional_check_failed");
      expect(doctor.statusCode).toBe(200);
      expect(doctor.json().summary.partial).toBe(1);
      expect(doctor.json().summary.available).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("bounds hung active checks and returns sanitized timeout state", async () => {
    const hungProbe = (): Promise<CodexProbe> => new Promise<CodexProbe>(() => {});
    const app = await createDaemonApp(undefined, {
      codexProbe: unavailableCodexProbe,
      probeCodexCatalog: hungProbe,
      checkTimeoutMs: 25,
      maxDiagnosticBytes: 128
    });
    try {
      const check = await app.inject({ method: "POST", url: "/runtime-modes/codex.exec_json/check" });
      expect(check.statusCode).toBe(200);
      expect(["unknown", "unavailable"]).toContain(check.json().check.state);
      expect(check.json().check.reasonCode).toBe("check_timeout");
    } finally {
      await app.close();
    }
  });

  it("refreshes codex provider/runtime status on startup when persistent storage is reused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-daemon-codex-status-"));
    const config: DaemonConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      sqlitePath: join(dir, "switchyard.sqlite"),
      artifactDir: join(dir, "artifacts"),
      opencode: {
        command: "opencode"
      },
      claudeCode: {
        command: "claude",
        liveProbe: false,
        maxBudgetUsd: 0.05,
        requestTimeoutMs: 5000
      },
      acp: {
        requestTimeoutMs: 250,
        cancelTimeoutMs: 250,
        maxMessageBytes: 1024 * 1024
      },
      genericHttp: {
        requestTimeoutMs: 5000,
        pollIntervalMs: 25,
        maxResponseBytes: 1024 * 1024
      }
    };

    let first: FastifyInstance | undefined;
    let second: FastifyInstance | undefined;
    try {
      first = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      let provider = await first.inject({ method: "GET", url: "/providers/provider_openai" });
      let runtime = await first.inject({ method: "GET", url: "/runtimes/runtime_codex" });
      expect(provider.json().provider.status).toBe("unavailable");
      expect(runtime.json().runtime.status).toBe("unavailable");
      await first.close();
      first = undefined;

      second = await createDaemonApp(config, { codexProbe: availableCodexProbe });
      provider = await second.inject({ method: "GET", url: "/providers/provider_openai" });
      runtime = await second.inject({ method: "GET", url: "/runtimes/runtime_codex" });
      expect(provider.json().provider.status).toBe("available");
      expect(runtime.json().runtime.status).toBe("available");
    } finally {
      if (first) {
        try {
          await first.close();
        } catch {
          // Ensure cleanup remains best-effort.
        }
      }
      if (second) {
        try {
          await second.close();
        } catch {
          // Ensure cleanup remains best-effort.
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Do not fail cleanup on best-effort temp cleanup.
      }
    }
  });

  it("local gateway smoke: list, artifact lookup, error envelope", async () => {
    const config = tempDaemonConfig("switchyard-daemon-smoke-");
    const app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
    try {
      const beforeRuns = await app.inject({ method: "GET", url: "/runs?limit=200" });
      expect(beforeRuns.statusCode).toBe(200);
      const startCount = (beforeRuns.json().runs as unknown[]).length;

      const created = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "smoke-list-run"
        }
      });
      expect(created.statusCode).toBe(201);
      const runId = created.json().run.id as string;

      const afterRuns = await app.inject({ method: "GET", url: "/runs?limit=200" });
      expect(afterRuns.statusCode).toBe(200);
      const endCount = (afterRuns.json().runs as unknown[]).length;
      expect(endCount).toBe(startCount + 1);

      const providers = await app.inject({ method: "GET", url: "/providers" });
      const runtimes = await app.inject({ method: "GET", url: "/runtimes" });
      const models = await app.inject({ method: "GET", url: "/models" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.length).toBeGreaterThan(0);
      expect(runtimes.json().runtimes.length).toBeGreaterThan(0);
      expect(models.json().models.length).toBeGreaterThan(0);

      const narrowedModels = await app.inject({ method: "GET", url: "/models?provider=test" });
      expect(narrowedModels.statusCode).toBe(200);
      expect(narrowedModels.json().models.length).toBeGreaterThan(0);

      const artifacts = await app.inject({ method: "GET", url: `/runs/${runId}/artifacts` });
      expect(artifacts.statusCode).toBe(200);
      const artifactId = artifacts.json().artifacts[0].id as string;

      const artifact = await app.inject({ method: "GET", url: `/artifacts/${artifactId}` });
      expect(artifact.statusCode).toBe(200);
      expect(artifact.json().artifact.id).toBe(artifactId);

      const content = await app.inject({ method: "GET", url: `/artifacts/${artifactId}/content` });
      expect(content.statusCode).toBe(200);
      expect(content.headers["content-type"]).toContain("application/x-ndjson");
      expect(content.body).toContain("fake runtime output");

      const missingRun = await app.inject({ method: "GET", url: "/runs/run_missing_id" });
      expect(missingRun.statusCode).toBe(404);
      expect(missingRun.json().error.code).toBe("run_not_found");

      const bananaStatus = await app.inject({ method: "GET", url: "/runs?status=banana" });
      expect(bananaStatus.statusCode).toBe(400);
      const bananaBody = bananaStatus.json();
      expect(bananaBody.error.code).toBe("invalid_query");
      expect(bananaBody.error.details?.[0]?.path).toBe("status");

      const missingArtifact = await app.inject({ method: "GET", url: "/artifacts/artifact_missing" });
      expect(missingArtifact.statusCode).toBe(404);
      expect(missingArtifact.json().error.code).toBe("artifact_not_found");

      const missingContent = await app.inject({ method: "GET", url: "/artifacts/artifact_missing/content" });
      expect(missingContent.statusCode).toBe(404);
      expect(missingContent.json().error.code).toBe("artifact_not_found");
    } finally {
      try {
        await app.close();
      } catch {
        // best-effort cleanup
      }
      try {
        rmSync(config.dataDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("marks persisted running runs failed on daemon restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-daemon-reconcile-"));
    const config: DaemonConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      sqlitePath: join(dir, "switchyard.sqlite"),
      artifactDir: join(dir, "artifacts"),
      opencode: {
        command: "opencode"
      },
      claudeCode: {
        command: "claude",
        liveProbe: false,
        maxBudgetUsd: 0.05,
        requestTimeoutMs: 5000
      },
      acp: {
        requestTimeoutMs: 250,
        cancelTimeoutMs: 250,
        maxMessageBytes: 1024 * 1024
      },
      genericHttp: {
        requestTimeoutMs: 5000,
        pollIntervalMs: 25,
        maxResponseBytes: 1024 * 1024
      }
    };

    let app: FastifyInstance | undefined;
    try {
      app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      await app.close();
      app = undefined;

      const storage = openSqliteStorage(config.sqlitePath);
      storage.sqlite.prepare(
        `INSERT INTO runs (
          id, runtime, provider, model, adapter_type, cwd, task, status, placement,
          approval_policy, timeout_seconds, metadata_json, created_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "run_interrupted",
        "codex",
        "openai",
        "gpt-5.5",
        "process",
        "/repo",
        "stale task",
        "running",
        "local",
        "default",
        600,
        "{}",
        "2026-05-14T00:00:00.000Z",
        "2026-05-14T00:00:01.000Z"
      );
      storage.sqlite.prepare(
        `INSERT INTO runtime_sessions (
          id, run_id, runtime, provider, model, protocol, status, process_id, state_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "session_interrupted",
        "run_interrupted",
        "codex",
        "openai",
        "gpt-5.5",
        "process",
        "active",
        1234,
        "{}",
        "2026-05-14T00:00:01.000Z"
      );
      storage.sqlite.prepare(
        `INSERT INTO approvals (
          id, run_id, approval_type, status, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        "approval_runtime_pending",
        "run_interrupted",
        "before_external_message",
        "pending",
        JSON.stringify({
          runtimeApprovalToken: "pause-1",
          expiresAt: "2026-06-14T00:00:00.000Z"
        }),
        "2026-05-14T00:00:01.000Z"
      );
      storage.sqlite.close();

      app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      const response = await app.inject({ method: "GET", url: "/runs/run_interrupted" });
      const events = await app.inject({ method: "GET", url: "/runs/run_interrupted/events" });
      const approval = await app.inject({ method: "GET", url: "/approvals/approval_runtime_pending" });

      expect(response.statusCode).toBe(200);
      expect(response.json().run.status).toBe("failed");
      expect(events.body).toContain("event: run.failed");
      expect(events.body).toContain("daemon_restarted");
      expect(events.body).toContain("event: approval.rejected");
      expect(approval.statusCode).toBe(200);
      expect(approval.json().approval.status).toBe("rejected");
    } finally {
      if (app) {
        try {
          await app.close();
        } catch {
          // Keep cleanup resilient for repeated-run assertions.
        }
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Do not fail cleanup on best-effort temp cleanup.
      }
    }
  });

  it("expires pending runtime approvals at startup when expiresAt is already past", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchyard-daemon-approval-expire-"));
    const config: DaemonConfig = {
      host: "127.0.0.1",
      port: 0,
      dataDir: dir,
      sqlitePath: join(dir, "switchyard.sqlite"),
      artifactDir: join(dir, "artifacts")
    };

    let app: FastifyInstance | undefined;
    try {
      app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      await app.close();
      app = undefined;

      const storage = openSqliteStorage(config.sqlitePath);
      storage.sqlite.prepare(
        `INSERT INTO runs (
          id, runtime, provider, model, adapter_type, cwd, task, status, placement,
          approval_policy, timeout_seconds, metadata_json, created_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "run_expire_pending",
        "codex",
        "openai",
        "gpt-5.5",
        "process",
        "/repo",
        "expire task",
        "waiting_for_approval",
        "local",
        "default",
        600,
        "{}",
        "2026-05-14T00:00:00.000Z",
        "2026-05-14T00:00:01.000Z"
      );
      storage.sqlite.prepare(
        `INSERT INTO approvals (
          id, run_id, approval_type, status, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        "approval_runtime_expired",
        "run_expire_pending",
        "before_external_message",
        "pending",
        JSON.stringify({
          runtimeApprovalToken: "pause-expire",
          expiresAt: "2020-01-01T00:00:00.000Z"
        }),
        "2026-05-14T00:00:01.000Z"
      );
      storage.sqlite.close();

      app = await createDaemonApp(config, { codexProbe: unavailableCodexProbe });
      const approval = await app.inject({ method: "GET", url: "/approvals/approval_runtime_expired" });
      const runEvents = await app.inject({ method: "GET", url: "/runs/run_expire_pending/events" });

      expect(approval.statusCode).toBe(200);
      expect(approval.json().approval.status).toBe("expired");
      expect(runEvents.statusCode).toBe(200);
      expect(runEvents.body).toContain("event: approval.expired");
    } finally {
      if (app) {
        try {
          await app.close();
        } catch {
          // keep cleanup resilient
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function waitForRunStatus(
  app: FastifyInstance,
  runId: string,
  status: string
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const read = await app.inject({ method: "GET", url: `/runs/${runId}` });
    if (read.statusCode === 200 && read.json().run.status === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${runId} did not reach status ${status}`);
}

async function expectTranscriptArtifactRetrievable(
  app: FastifyInstance,
  runId: string
): Promise<void> {
  const artifacts = await app.inject({ method: "GET", url: `/runs/${runId}/artifacts` });
  expect(artifacts.statusCode).toBe(200);
  const transcript = artifacts
    .json()
    .artifacts.find((artifact: { path: string }) => artifact.path.endsWith("/opencode-acp-transcript.jsonl"));
  expect(transcript).toBeDefined();
  const artifactId = String(transcript.id);
  const artifact = await app.inject({ method: "GET", url: `/artifacts/${artifactId}` });
  const content = await app.inject({ method: "GET", url: `/artifacts/${artifactId}/content` });
  expect(artifact.statusCode).toBe(200);
  expect(content.statusCode).toBe(200);
}
