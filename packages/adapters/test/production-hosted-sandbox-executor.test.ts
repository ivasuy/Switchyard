import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SandboxJobRequest, SandboxResourceLimits, SandboxResolvedCommand } from "@switchyard/contracts";
import { describe, expect, it } from "vitest";
import {
  ProductionHostedSandboxExecutor,
  type SandboxProcessFactory,
  type SandboxPtyFactory
} from "../src/index.js";

const BASE_LIMITS: SandboxResourceLimits = {
  wallTimeMs: 30_000,
  stdoutBytes: 64,
  stderrBytes: 64,
  combinedOutputBytes: 64,
  artifactBytes: 1_048_576,
  stdinBytes: 65_536,
  argvCount: 32,
  argvEntryBytes: 256,
  envKeys: 32,
  envValueBytes: 4096,
  ptyCols: 80,
  ptyRows: 24,
  cpuMs: 1_000,
  memoryMiB: 256
};

describe("ProductionHostedSandboxExecutor", () => {
  it("fails before spawn when resolvedCommand is missing", async () => {
    const processFactory = new RecordingProcessFactory();
    const executor = new ProductionHostedSandboxExecutor({ processFactory });

    const result = await executor.execute(baseProcessRequest(), {});

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("sandbox_policy_missing");
    expect(processFactory.calls).toHaveLength(0);
  });

  it("spawns process with shell:false and exact resolved command values", async () => {
    const processFactory = new RecordingProcessFactory();
    const child = new FakeProcess();
    processFactory.nextChild = child;

    const executor = new ProductionHostedSandboxExecutor({ processFactory });
    const request = baseProcessRequest({
      argv: ["--ignored-from-request"],
      cwd: "/tmp/ignored",
      env: { IGNORED: "1" }
    });
    const resolvedCommand = baseProcessResolvedCommand({
      executablePath: "/usr/bin/printf",
      argv: ["literal;rm -rf /", "$(touch /tmp/pwned)"],
      cwd: "/srv/workspace",
      env: { SAFE: "yes" }
    });

    const pending = executor.execute(request, { resolvedCommand });
    await nextTick();
    child.stdout.write("ok-out");
    child.stderr.write("ok-err");
    child.emitClose(0);
    const result = await pending;

    expect(processFactory.calls).toHaveLength(1);
    expect(processFactory.calls[0]).toEqual({
      executablePath: "/usr/bin/printf",
      argv: ["literal;rm -rf /", "$(touch /tmp/pwned)"],
      options: {
        cwd: "/srv/workspace",
        env: { SAFE: "yes" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      }
    });
    expect(result.status).toBe("completed");
    expect(result.stdout).toBe("ok-out");
    expect(result.stderr).toBe("ok-err");
  });

  it("maps process spawn failures to sandbox_spawn_failed", async () => {
    const processFactory = new RecordingProcessFactory();
    processFactory.throwOnSpawn = new Error("spawn boom");
    const executor = new ProductionHostedSandboxExecutor({ processFactory });

    const result = await executor.execute(baseProcessRequest(), {
      resolvedCommand: baseProcessResolvedCommand()
    });

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("sandbox_spawn_failed");
  });

  it("maps non-zero process close to sandbox_process_failed with exitCode", async () => {
    const processFactory = new RecordingProcessFactory();
    const child = new FakeProcess();
    processFactory.nextChild = child;
    const executor = new ProductionHostedSandboxExecutor({ processFactory });

    const pending = executor.execute(baseProcessRequest(), {
      resolvedCommand: baseProcessResolvedCommand()
    });
    await nextTick();
    child.emitClose(7);
    const result = await pending;

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("sandbox_process_failed");
    expect(result.exitCode).toBe(7);
  });

  it("kills process on abort and settles as cancelled", async () => {
    const processFactory = new RecordingProcessFactory();
    const child = new FakeProcess({ closeOnKill: true });
    processFactory.nextChild = child;
    const executor = new ProductionHostedSandboxExecutor({ processFactory });
    const controller = new AbortController();

    const pending = executor.execute(baseProcessRequest(), {
      signal: controller.signal,
      resolvedCommand: baseProcessResolvedCommand()
    });
    await nextTick();
    controller.abort(new Error("stop"));
    const result = await pending;

    expect(child.killCalls).toBe(1);
    expect(result.status).toBe("cancelled");
    expect(result.reasonCode).toBe("sandbox_cancelled");
  });

  it("bounds process output collection", async () => {
    const processFactory = new RecordingProcessFactory();
    const child = new FakeProcess();
    processFactory.nextChild = child;
    const executor = new ProductionHostedSandboxExecutor({ processFactory });
    const request = baseProcessRequest({
      resourceLimits: {
        ...BASE_LIMITS,
        stdoutBytes: 8,
        stderrBytes: 8,
        combinedOutputBytes: 8
      }
    });

    const pending = executor.execute(request, {
      resolvedCommand: baseProcessResolvedCommand()
    });
    await nextTick();
    child.stdout.write("1234567890");
    child.stderr.write("abcdefghij");
    child.emitClose(0);
    const result = await pending;

    expect(Buffer.byteLength(result.stdout ?? "", "utf8")).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(result.stderr ?? "", "utf8")).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength((result.stdout ?? "") + (result.stderr ?? ""), "utf8")).toBeLessThanOrEqual(8);
  });

  it("bounds multibyte process output without breaking UTF-8 limits", async () => {
    const processFactory = new RecordingProcessFactory();
    const child = new FakeProcess();
    processFactory.nextChild = child;
    const executor = new ProductionHostedSandboxExecutor({ processFactory });
    const request = baseProcessRequest({
      resourceLimits: {
        ...BASE_LIMITS,
        stdoutBytes: 5,
        stderrBytes: 5,
        combinedOutputBytes: 9
      }
    });

    const pending = executor.execute(request, {
      resolvedCommand: baseProcessResolvedCommand()
    });
    await nextTick();
    child.stdout.write("🙂🙂");
    child.stderr.write("€€");
    child.emitClose(0);
    const result = await pending;

    expect(Buffer.byteLength(result.stdout ?? "", "utf8")).toBeLessThanOrEqual(5);
    expect(Buffer.byteLength(result.stderr ?? "", "utf8")).toBeLessThanOrEqual(5);
    expect(Buffer.byteLength((result.stdout ?? "") + (result.stderr ?? ""), "utf8")).toBeLessThanOrEqual(9);
  });

  it("kills process and returns named failure when stdin write fails", async () => {
    const processFactory = new RecordingProcessFactory();
    const child = new FakeProcess({ failStdinWrite: true });
    processFactory.nextChild = child;
    const executor = new ProductionHostedSandboxExecutor({ processFactory });

    const result = await executor.execute(baseProcessRequest({ stdin: "hello" }), {
      resolvedCommand: baseProcessResolvedCommand({ allowStdin: true })
    });

    expect(child.killCalls).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("sandbox_process_failed");
  });

  it("returns sandbox_pty_unavailable when ptyFactory is missing and never falls back", async () => {
    const processFactory = new RecordingProcessFactory();
    const executor = new ProductionHostedSandboxExecutor({ processFactory });

    const result = await executor.execute(basePtyRequest(), {
      resolvedCommand: basePtyResolvedCommand()
    });

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("sandbox_pty_unavailable");
    expect(processFactory.calls).toHaveLength(0);
  });

  it("handles PTY input and resize frames in order", async () => {
    const ptyFactory = new RecordingPtyFactory();
    const pty = new FakePty();
    ptyFactory.nextPty = pty;
    const executor = new ProductionHostedSandboxExecutor({ ptyFactory });
    const request = basePtyRequest({
      pty: {
        cols: 80,
        rows: 24,
        inputFrames: [
          { type: "input", data: "alpha" },
          { type: "resize", cols: 100, rows: 40 },
          { type: "input", data: "beta" }
        ]
      }
    });

    const pending = executor.execute(request, {
      resolvedCommand: basePtyResolvedCommand()
    });
    await nextTick();
    pty.emitData("pty-output");
    pty.emitClose(0);
    const result = await pending;

    expect(pty.actions).toEqual([
      "write:alpha",
      "resize:100x40",
      "write:beta"
    ]);
    expect(result.status).toBe("completed");
    expect(result.stdout).toBe("pty-output");
  });

  it("bounds multibyte PTY output without breaking UTF-8 limits", async () => {
    const ptyFactory = new RecordingPtyFactory();
    const pty = new FakePty();
    ptyFactory.nextPty = pty;
    const executor = new ProductionHostedSandboxExecutor({ ptyFactory });
    const request = basePtyRequest({
      resourceLimits: {
        ...BASE_LIMITS,
        stdoutBytes: 5,
        stderrBytes: 5,
        combinedOutputBytes: 5
      }
    });

    const pending = executor.execute(request, {
      resolvedCommand: basePtyResolvedCommand()
    });
    await nextTick();
    pty.emitData("🙂🙂");
    pty.emitClose(0);
    const result = await pending;

    expect(Buffer.byteLength(result.stdout ?? "", "utf8")).toBeLessThanOrEqual(5);
    expect(Buffer.byteLength(result.stderr ?? "", "utf8")).toBeLessThanOrEqual(5);
    expect(Buffer.byteLength((result.stdout ?? "") + (result.stderr ?? ""), "utf8")).toBeLessThanOrEqual(5);
  });

  it("maps PTY spawn failures and never falls back to process", async () => {
    const processFactory = new RecordingProcessFactory();
    const ptyFactory = new RecordingPtyFactory();
    ptyFactory.throwOnSpawn = new Error("pty spawn failed");
    const executor = new ProductionHostedSandboxExecutor({ processFactory, ptyFactory });

    const result = await executor.execute(basePtyRequest(), {
      resolvedCommand: basePtyResolvedCommand()
    });

    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("sandbox_spawn_failed");
    expect(processFactory.calls).toHaveLength(0);
  });

  it("maps PTY close, stream, write, resize, and abort cleanup failures to named codes", async () => {
    const ptyFactoryClose = new RecordingPtyFactory();
    const ptyClose = new FakePty();
    ptyFactoryClose.nextPty = ptyClose;
    const executorClose = new ProductionHostedSandboxExecutor({ ptyFactory: ptyFactoryClose });
    const pendingClose = executorClose.execute(basePtyRequest(), {
      resolvedCommand: basePtyResolvedCommand()
    });
    await nextTick();
    ptyClose.emitClose(9);
    const closeResult = await pendingClose;
    expect(closeResult.reasonCode).toBe("sandbox_process_failed");
    expect(closeResult.exitCode).toBe(9);

    const ptyFactoryStream = new RecordingPtyFactory();
    const ptyStream = new FakePty();
    ptyFactoryStream.nextPty = ptyStream;
    const executorStream = new ProductionHostedSandboxExecutor({ ptyFactory: ptyFactoryStream });
    const pendingStream = executorStream.execute(basePtyRequest(), {
      resolvedCommand: basePtyResolvedCommand()
    });
    await nextTick();
    ptyStream.emitError(new Error("pty stream bad"));
    const streamResult = await pendingStream;
    expect(streamResult.reasonCode).toBe("sandbox_process_failed");

    const ptyFactoryWrite = new RecordingPtyFactory();
    const ptyWrite = new FakePty({ failWrite: true });
    ptyFactoryWrite.nextPty = ptyWrite;
    const executorWrite = new ProductionHostedSandboxExecutor({ ptyFactory: ptyFactoryWrite });
    const writeResult = await executorWrite.execute(basePtyRequest({
      pty: {
        cols: 80,
        rows: 24,
        inputFrames: [{ type: "input", data: "boom" }]
      }
    }), {
      resolvedCommand: basePtyResolvedCommand()
    });
    expect(writeResult.reasonCode).toBe("sandbox_process_failed");

    const ptyFactoryResize = new RecordingPtyFactory();
    const ptyResize = new FakePty({ failResize: true });
    ptyFactoryResize.nextPty = ptyResize;
    const executorResize = new ProductionHostedSandboxExecutor({ ptyFactory: ptyFactoryResize });
    const resizeResult = await executorResize.execute(basePtyRequest({
      pty: {
        cols: 80,
        rows: 24,
        inputFrames: [{ type: "resize", cols: 120, rows: 60 }]
      }
    }), {
      resolvedCommand: basePtyResolvedCommand()
    });
    expect(resizeResult.reasonCode).toBe("sandbox_process_failed");

    const ptyFactoryAbort = new RecordingPtyFactory();
    const ptyAbort = new FakePty({ failKill: true });
    ptyFactoryAbort.nextPty = ptyAbort;
    const executorAbort = new ProductionHostedSandboxExecutor({ ptyFactory: ptyFactoryAbort });
    const controller = new AbortController();
    const pendingAbort = executorAbort.execute(basePtyRequest(), {
      signal: controller.signal,
      resolvedCommand: basePtyResolvedCommand()
    });
    await nextTick();
    controller.abort(new Error("cancel"));
    const abortResult = await pendingAbort;
    expect(abortResult.reasonCode).toBe("sandbox_cancel_failed");
  });
});

class RecordingProcessFactory implements SandboxProcessFactory {
  calls: Array<{
    executablePath: string;
    argv: string[];
    options: {
      cwd: string;
      env: Record<string, string>;
      shell: false;
      stdio: ["pipe", "pipe", "pipe"];
    };
  }> = [];
  nextChild: FakeProcess | undefined;
  throwOnSpawn: Error | undefined;

  spawn(
    executablePath: string,
    argv: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      shell: false;
      stdio: ["pipe", "pipe", "pipe"];
    }
  ): FakeProcess {
    if (this.throwOnSpawn) {
      throw this.throwOnSpawn;
    }
    const child = this.nextChild ?? new FakeProcess();
    this.nextChild = undefined;
    this.calls.push({ executablePath, argv: [...argv], options });
    return child;
  }
}

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: FakeStdin;
  killCalls = 0;

  constructor(options?: { failStdinWrite?: boolean; closeOnKill?: boolean }) {
    super();
    this.stdin = new FakeStdin({ failWrite: options?.failStdinWrite === true });
    if (options?.closeOnKill) {
      this.on("killed", () => {
        this.emitClose(null);
      });
    }
  }

  kill(): boolean {
    this.killCalls += 1;
    this.emit("killed");
    return true;
  }

  emitClose(code: number | null): void {
    this.emit("close", code, null);
  }
}

class FakeStdin extends EventEmitter {
  writableEnded = false;
  readonly failWrite: boolean;

  constructor(options?: { failWrite?: boolean }) {
    super();
    this.failWrite = options?.failWrite === true;
  }

  write(data: string, callback?: (error?: Error | null) => void): boolean {
    if (this.failWrite) {
      const error = new Error(`stdin write failed: ${data}`);
      callback?.(error);
      this.emit("error", error);
      return false;
    }
    callback?.(null);
    return true;
  }

  end(): void {
    this.writableEnded = true;
  }
}

class RecordingPtyFactory implements SandboxPtyFactory {
  nextPty: FakePty | undefined;
  throwOnSpawn: Error | undefined;

  spawn(): FakePty {
    if (this.throwOnSpawn) {
      throw this.throwOnSpawn;
    }
    const pty = this.nextPty ?? new FakePty();
    this.nextPty = undefined;
    return pty;
  }
}

class FakePty extends EventEmitter {
  actions: string[] = [];
  readonly failWrite: boolean;
  readonly failResize: boolean;
  readonly failKill: boolean;

  constructor(options?: { failWrite?: boolean; failResize?: boolean; failKill?: boolean }) {
    super();
    this.failWrite = options?.failWrite === true;
    this.failResize = options?.failResize === true;
    this.failKill = options?.failKill === true;
  }

  write(data: string): void {
    if (this.failWrite) {
      throw new Error(`write failed: ${data}`);
    }
    this.actions.push(`write:${data}`);
  }

  resize(cols: number, rows: number): void {
    if (this.failResize) {
      throw new Error(`resize failed: ${cols}x${rows}`);
    }
    this.actions.push(`resize:${cols}x${rows}`);
  }

  kill(): boolean {
    if (this.failKill) {
      throw new Error("kill failed");
    }
    this.emitClose(null);
    return true;
  }

  emitData(data: string): void {
    this.emit("data", data);
  }

  emitError(error: Error): void {
    this.emit("error", error);
  }

  emitClose(code: number | null): void {
    this.emit("close", code, null);
  }
}

function baseProcessRequest(overrides: Partial<SandboxJobRequest & { resourceLimits: SandboxResourceLimits }> = {}) {
  const request: SandboxJobRequest & { resourceLimits: SandboxResourceLimits } = {
    jobId: "job-process",
    runId: "run-process",
    runtimeMode: "fake.deterministic",
    adapterType: "process",
    commandId: "deploy.safe.echo",
    argv: [],
    cwd: "/srv/worker",
    env: {},
    stdin: undefined,
    resourceLimits: BASE_LIMITS,
    artifactPolicy: { captureTranscript: false, captureDeniedDecision: false },
    createdAt: "2026-05-31T00:00:00.000Z",
    ...overrides
  };
  return request;
}

function basePtyRequest(overrides: Partial<SandboxJobRequest & { resourceLimits: SandboxResourceLimits }> = {}) {
  const request: SandboxJobRequest & { resourceLimits: SandboxResourceLimits } = {
    jobId: "job-pty",
    runId: "run-pty",
    runtimeMode: "fake.deterministic",
    adapterType: "pty",
    commandId: "deploy.safe.pty",
    argv: [],
    cwd: "/srv/worker",
    env: {},
    pty: {
      cols: 80,
      rows: 24,
      inputFrames: []
    },
    stdin: undefined,
    resourceLimits: BASE_LIMITS,
    artifactPolicy: { captureTranscript: false, captureDeniedDecision: false },
    createdAt: "2026-05-31T00:00:00.000Z",
    ...overrides
  };
  return request;
}

function baseProcessResolvedCommand(overrides: Partial<SandboxResolvedCommand> = {}): SandboxResolvedCommand {
  return {
    commandId: "deploy.safe.echo",
    adapterType: "process",
    executablePath: "/usr/bin/printf",
    argv: ["ok"],
    cwd: "/srv/worker",
    env: {},
    allowStdin: false,
    allowPtyInput: false,
    isolation: { driver: "none", required: false },
    networkPolicy: "disabled",
    ...overrides
  };
}

function basePtyResolvedCommand(overrides: Partial<SandboxResolvedCommand> = {}): SandboxResolvedCommand {
  return {
    commandId: "deploy.safe.pty",
    adapterType: "pty",
    executablePath: "/usr/bin/printf",
    argv: ["ok"],
    cwd: "/srv/worker",
    env: {},
    allowStdin: false,
    allowPtyInput: true,
    isolation: { driver: "none", required: false },
    networkPolicy: "disabled",
    ...overrides
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
