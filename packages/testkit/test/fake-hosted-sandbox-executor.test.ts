import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeHostedSandboxExecutor } from "../src/index.js";

function baseRequest(commandId: string) {
  return {
    jobId: "sandbox_job_1",
    runId: "run_1",
    runtimeMode: "fake.deterministic",
    adapterType: commandId === "switchyard.fake.pty_echo" ? "pty" : "process",
    commandId,
    argv: ["hello"],
    cwd: "/repo",
    env: {},
    stdin: "input",
    pty: commandId === "switchyard.fake.pty_echo" ? { cols: 80, rows: 24, inputFrames: [{ type: "input", data: "abc" }] } : undefined,
    resourceLimits: {
      wallTimeMs: 30_000,
      stdoutBytes: 65_536,
      stderrBytes: 65_536,
      combinedOutputBytes: 131_072,
      artifactBytes: 1_048_576,
      stdinBytes: 65_536,
      argvCount: 32,
      argvEntryBytes: 256,
      envKeys: 32,
      envValueBytes: 4_096,
      ptyCols: 80,
      ptyRows: 24,
      cpuMs: 1_000,
      memoryMiB: 256
    },
    artifactPolicy: {
      captureTranscript: true,
      captureDeniedDecision: false
    },
    createdAt: "2026-05-30T00:00:00.000Z"
  };
}

describe("FakeHostedSandboxExecutor", () => {
  it("returns deterministic stdout/stderr outputs", async () => {
    const executor = new FakeHostedSandboxExecutor();
    const echo = await executor.execute(baseRequest("switchyard.fake.echo"));
    const stderr = await executor.execute(baseRequest("switchyard.fake.stderr"));
    expect(echo.status).toBe("completed");
    expect(echo.stdout).toContain("hello");
    expect(stderr.status).toBe("completed");
    expect(stderr.stderr).toContain("fake stderr");
  });

  it("returns nonzero exit failure for fake exit", async () => {
    const executor = new FakeHostedSandboxExecutor();
    const exit = await executor.execute({
      ...baseRequest("switchyard.fake.exit"),
      argv: ["7"]
    });
    expect(exit.status).toBe("failed");
    expect(exit.exitCode).toBe(7);
  });

  it("produces deterministic output flood and artifact payloads", async () => {
    const executor = new FakeHostedSandboxExecutor();
    const flood = await executor.execute(baseRequest("switchyard.fake.output_flood"));
    const artifact = await executor.execute(baseRequest("switchyard.fake.artifact"));
    expect(flood.status).toBe("completed");
    expect((flood.stdout ?? "").length).toBeGreaterThan(1000);
    expect(artifact.artifacts?.length).toBe(1);
    expect(artifact.artifacts?.[0]?.content).toContain("sandbox-artifact");
  });

  it("supports cancellation for fake sleep", async () => {
    const executor = new FakeHostedSandboxExecutor();
    const controller = new AbortController();
    const running = executor.execute(baseRequest("switchyard.fake.sleep"), { signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toThrow("aborted");
  });

  it("supports deterministic pty echo", async () => {
    const executor = new FakeHostedSandboxExecutor();
    const pty = await executor.execute(baseRequest("switchyard.fake.pty_echo"));
    expect(pty.status).toBe("completed");
    expect(pty.stdout).toContain("pty:abc");
  });

  it("avoids forbidden real execution imports", () => {
    const source = readFileSync(new URL("../src/fake-hosted-sandbox-executor.ts", import.meta.url), "utf8");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("node-pty");
    expect(source).not.toContain("@switchyard/adapters");
    expect(source).not.toContain("playwright");
    expect(source).not.toContain("octokit");
  });
});
