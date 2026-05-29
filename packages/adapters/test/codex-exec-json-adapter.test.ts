import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexExecJsonAdapter, CodexInputUnsupportedError } from "../src/index.js";

describe("CodexExecJsonAdapter", () => {
  it("exposes a local one-shot runtime manifest", () => {
    const adapter = new CodexExecJsonAdapter();
    expect(adapter.manifest).toMatchObject({
      runtimeModeId: "runtime_mode_codex_exec_json",
      runtimeModeSlug: "codex.exec_json",
      kind: "one_shot_process",
      adapterType: "process"
    });
    expect(adapter.manifest.capabilities).toEqual(
      expect.arrayContaining([
        "run.start",
        "run.cancel",
        "run.timeout",
        "event.normalized",
        "artifact.transcript",
        "artifact.raw_transcript",
        "model.catalog",
        "auth.local"
      ])
    );
    expect(adapter.manifest.capabilities).not.toEqual(expect.arrayContaining(["run.input", "session.resume", "interactive"]));
    expect(adapter.manifest.placement.hosted.support).toBe("unsupported");
    expect(adapter.manifest.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "one_shot_no_input" }),
        expect.objectContaining({ code: "local_only" }),
        expect.objectContaining({ code: "no_approval_bridge" }),
        expect.objectContaining({ code: "no_session_resume" })
      ])
    );
  });

  it("forwards optional check diagnostics from probe results", async () => {
    const adapter = new CodexExecJsonAdapter({
      probeCatalog: async () => ({
        ok: true,
        version: "codex 0.0.0-test",
        models: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high"] }],
        optionalChecks: {
          sandbox_policy_probe: {
            ok: false,
            message: "optional sandbox probe failed"
          }
        }
      })
    });

    const check = await adapter.check();
    expect(check.ok).toBe(true);
    expect(check.details).toMatchObject({
      version: "codex 0.0.0-test",
      optionalChecks: {
        sandbox_policy_probe: {
          ok: false,
          message: "optional sandbox probe failed"
        }
      }
    });
  });

  it("builds args, streams events, and returns transcript artifacts", async () => {
    const fake = new FakeCodexProcess();
    const adapter = new CodexExecJsonAdapter({
      command: "codex",
      processFactory: (args, options) => {
        fake.args = args;
        fake.cwd = options.cwd;

        queueMicrotask(() => {
          fake.stdout.write("{\"type\":\"thread.started\",\"thread_id\":\"thread_1\"}\n");
          fake.stdout.write("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}\n");
          fake.stdout.write("{\"type\":\"turn.completed\"}\n");
          fake.stderr.write("note on stderr\n");
          fake.stdout.end();
          fake.emit("exit", 0, null);
        });

        return fake as never;
      },
      modelCatalog: [{ slug: "gpt-5.5", supportedReasoningLevels: ["low", "medium", "high", "xhigh"] }]
    });

    const session = await adapter.start({
      runId: "run_codex",
      model: "gpt-5.5",
      cwd: "/repo",
      task: "do work",
      metadata: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        verbosity: "low",
        sandbox: "read-only",
        skipGitRepoCheck: true,
        ephemeral: true
      }
    });

    const events = [];
    for await (const event of adapter.events({ ...session, runId: "run_codex" })) {
      events.push(event);
    }

    const artifacts = await adapter.artifacts({ ...session, runId: "run_codex" });

    expect(fake.cwd).toBe("/repo");
    expect(fake.stdin.writableEnded).toBe(true);
    expect(fake.args).toEqual([
      "exec",
      "--json",
      "--model",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=\"high\"",
      "-c",
      "model_reasoning_summary=\"auto\"",
      "-c",
      "model_verbosity=\"low\"",
      "--cd",
      "/repo",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "do work"
    ]);
    expect(events.map((event) => event.type)).toEqual(["runtime.status", "runtime.output", "run.completed"]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe("runs/run_codex/codex-transcript.jsonl");
    expect(artifacts[0]?.metadata).toMatchObject({ runtime: "codex", mode: "exec-json" });
    expect(String(artifacts[0]?.metadata.content)).toContain("\"turn.completed\"");
    expect(String(artifacts[0]?.metadata.content)).toContain("\"type\":\"stderr\"");
  });

  it("emits run.failed for non-zero process exit without terminal event", async () => {
    const fake = new FakeCodexProcess();
    const adapter = new CodexExecJsonAdapter({
      processFactory: () => {
        queueMicrotask(() => {
          fake.stderr.write("auth failed\n");
          fake.stdout.end();
          fake.emit("exit", 1, null);
        });
        return fake as never;
      }
    });

    const session = await adapter.start({
      runId: "run_codex",
      model: "gpt-5.5",
      cwd: "/repo",
      task: "fail",
      metadata: {}
    });

    const events = [];
    for await (const event of adapter.events({ ...session, runId: "run_codex" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "run.failed",
      payload: { status: "failed", exitCode: 1, stderr: "auth failed\n" }
    });
  });

  it("emits run.failed and stops when stdout contains invalid json", async () => {
    const fake = new FakeCodexProcess();
    const adapter = new CodexExecJsonAdapter({
      processFactory: () => {
        queueMicrotask(() => {
          fake.stdout.write("not-json\n");
          fake.stdout.write("{\"type\":\"turn.completed\"}\n");
          fake.stdout.end();
          fake.emit("exit", 0, null);
        });
        return fake as never;
      }
    });

    const session = await adapter.start({
      runId: "run_codex",
      model: "gpt-5.5",
      cwd: "/repo",
      task: "parse failure",
      metadata: {}
    });

    const events = [];
    for await (const event of adapter.events({ ...session, runId: "run_codex" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.failed");
    expect(events[0]?.payload.error).toContain("Invalid Codex JSONL line");
  });

  it("cancels an active process with SIGTERM", async () => {
    const fake = new FakeCodexProcess();
    const adapter = new CodexExecJsonAdapter({
      processFactory: () => fake as never
    });

    const session = await adapter.start({
      runId: "run_codex",
      model: "gpt-5.5",
      cwd: "/repo",
      task: "cancel me",
      metadata: {}
    });

    await adapter.cancel({ ...session });

    expect(fake.killed).toBe(true);
    expect(fake.lastSignal).toBe("SIGTERM");
  });

  it("allows user config loading when explicitly requested", async () => {
    const fake = new FakeCodexProcess();
    const adapter = new CodexExecJsonAdapter({
      processFactory: (args) => {
        fake.args = args;
        queueMicrotask(() => {
          fake.stdout.write("{\"type\":\"turn.completed\"}\n");
          fake.stdout.end();
          fake.stderr.end();
          fake.emit("exit", 0, null);
        });
        return fake as never;
      }
    });

    const session = await adapter.start({
      runId: "run_codex",
      model: "gpt-5.5",
      cwd: "/repo",
      task: "use config",
      metadata: {
        ignoreUserConfig: false,
        ignoreRules: true
      }
    });

    for await (const _event of adapter.events({ ...session, runId: "run_codex" })) {
      // Drain events to let the fake process close.
    }

    expect(fake.args).not.toContain("--ignore-user-config");
    expect(fake.args).toContain("--ignore-rules");
  });

  it("rejects send because exec-json is not interactive", async () => {
    const adapter = new CodexExecJsonAdapter();
    await expect(adapter.send({ sessionId: "session_codex" }, { text: "continue" })).rejects.toBeInstanceOf(
      CodexInputUnsupportedError
    );
  });

  it("captures trailing bytes after turn.completed even when event consumption stops", async () => {
    const fake = new FakeCodexProcess();
    const adapter = new CodexExecJsonAdapter({
      processFactory: () => {
        queueMicrotask(() => {
          fake.stdout.write("{\"type\":\"turn.completed\"}\n");
          setTimeout(() => {
            fake.stdout.write("{\"type\":\"item.completed\",\"item\":{\"text\":\"late output\"}}\n");
            fake.stderr.write("late stderr\n");
            fake.stdout.end();
            fake.stderr.end();
            fake.emit("exit", 0, null);
          }, 5);
        });
        return fake as never;
      }
    });

    const session = await adapter.start({
      runId: "run_codex",
      model: "gpt-5.5",
      cwd: "/repo",
      task: "terminal then late bytes",
      metadata: {}
    });

    const iterator = adapter.events({ ...session, runId: "run_codex" })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.type).toBe("run.completed");
    await iterator.return?.();

    const artifacts = await adapter.artifacts({ ...session, runId: "run_codex" });
    const transcript = String(artifacts[0]?.metadata.content);
    expect(transcript).toContain("\"turn.completed\"");
    expect(transcript).toContain("\"late output\"");
    expect(transcript).toContain("late stderr");
  });

  it("captures trailing bytes after parser failure", async () => {
    const fake = new FakeCodexProcess();
    const adapter = new CodexExecJsonAdapter({
      processFactory: () => {
        queueMicrotask(() => {
          fake.stdout.write("not-json\n");
          fake.stdout.write("{\"type\":\"item.completed\",\"item\":{\"text\":\"after parse failure\"}}\n");
          fake.stderr.write("stderr after parse failure\n");
          fake.stdout.end();
          fake.stderr.end();
          fake.emit("exit", 0, null);
        });
        return fake as never;
      }
    });

    const session = await adapter.start({
      runId: "run_codex",
      model: "gpt-5.5",
      cwd: "/repo",
      task: "parse failure then late bytes",
      metadata: {}
    });

    const events = [];
    for await (const event of adapter.events({ ...session, runId: "run_codex" })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.failed");

    const artifacts = await adapter.artifacts({ ...session, runId: "run_codex" });
    const transcript = String(artifacts[0]?.metadata.content);
    expect(transcript).toContain("not-json");
    expect(transcript).toContain("after parse failure");
    expect(transcript).toContain("stderr after parse failure");
  });

  it("does not yield events after run.completed even when more stdout arrives", async () => {
    const fake = new FakeCodexProcess();
    const adapter = new CodexExecJsonAdapter({
      processFactory: () => {
        queueMicrotask(() => {
          fake.stdout.write("{\"type\":\"turn.completed\"}\n");
          fake.stdout.write("{\"type\":\"item.completed\",\"item\":{\"text\":\"should not emit\"}}\n");
          fake.stdout.end();
          fake.stderr.end();
          fake.emit("exit", 0, null);
        });
        return fake as never;
      }
    });

    const session = await adapter.start({
      runId: "run_codex",
      model: "gpt-5.5",
      cwd: "/repo",
      task: "stop after terminal",
      metadata: {}
    });

    const events = [];
    for await (const event of adapter.events({ ...session, runId: "run_codex" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.completed");
  });

  it("captures trailing bytes that arrive well after terminal event before natural close", async () => {
    const fake = new FakeCodexProcess();
    const adapter = new CodexExecJsonAdapter({
      processFactory: () => {
        queueMicrotask(() => {
          fake.stdout.write("{\"type\":\"turn.completed\"}\n");
          fake.stderr.write("stderr before linger\n");
          setTimeout(() => {
            fake.stdout.write("{\"type\":\"item.completed\",\"item\":{\"text\":\"late after old grace\"}}\n");
            fake.stderr.write("late stderr after old grace\n");
            fake.stdout.end();
            fake.stderr.end();
            fake.emit("exit", 0, null);
          }, 300);
        });
        return fake as never;
      }
    });

    const session = await adapter.start({
      runId: "run_codex",
      model: "gpt-5.5",
      cwd: "/repo",
      task: "linger",
      metadata: {}
    });

    const iterator = adapter.events({ ...session, runId: "run_codex" })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.type).toBe("run.completed");
    await iterator.return?.();

    const artifacts = await adapter.artifacts({ ...session, runId: "run_codex" });
    expect(String(artifacts[0]?.metadata.content)).toContain("\"turn.completed\"");
    expect(String(artifacts[0]?.metadata.content)).toContain("stderr before linger");
    expect(String(artifacts[0]?.metadata.content)).toContain("late after old grace");
    expect(String(artifacts[0]?.metadata.content)).toContain("late stderr after old grace");
  });
});

class FakeCodexProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 1234;
  killed = false;
  lastSignal: NodeJS.Signals | undefined;
  args: string[] = [];
  cwd = "";

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.lastSignal = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }
}
