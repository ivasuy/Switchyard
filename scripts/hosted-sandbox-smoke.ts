import { HostedSandboxService, resolveHostedSandboxConfig, checkHostedSandboxReadiness } from "../packages/core/src/index.js";
import { FakeHostedSandboxExecutor } from "../packages/testkit/src/index.js";

class MemoryArtifactContent {
  writes: Array<{ path: string; text: string; contentType?: string }> = [];

  async writeText(path: string, text: string, options?: { contentType?: string }) {
    this.writes.push({ path, text, contentType: options?.contentType });
    return {
      path,
      storageBackend: "memory" as const,
      sizeBytes: Buffer.byteLength(text, "utf8"),
      sha256: "smoke_sha",
      contentType: options?.contentType ?? "text/plain"
    };
  }

  async writeBytes() {
    throw new Error("not_implemented");
  }

  async read() {
    throw new Error("not_implemented");
  }
}

class CounterMetrics {
  readonly counters: Record<string, number> = {};

  inc(path: string): void {
    this.counters[path] = (this.counters[path] ?? 0) + 1;
  }
}

async function main(): Promise<void> {
  const config = resolveHostedSandboxConfig({ deploymentMode: "test", env: {} });
  const readiness = checkHostedSandboxReadiness(config);
  assert(readiness.ok, `sandbox readiness should be ok, got: ${JSON.stringify(readiness)}`);

  const metrics = new CounterMetrics();
  const artifactContent = new MemoryArtifactContent();
  const service = new HostedSandboxService({
    config,
    executor: new FakeHostedSandboxExecutor(),
    artifactContent,
    metrics
  });

  const allowed = await service.execute(baseRequest({
    commandId: "switchyard.fake.echo",
    argv: ["token=abc"],
    artifactPolicy: { captureTranscript: true, captureDeniedDecision: false }
  }));
  assert(allowed.status === "completed", `expected completed allowed result, got ${allowed.status}`);
  assert(allowed.transcriptArtifact?.contentStored === true, "expected transcript artifact to be stored");

  const denied = await service.execute(baseRequest({ commandId: "bash" }));
  assert(denied.reasonCode === "sandbox_command_denied", `expected sandbox_command_denied, got ${denied.reasonCode}`);

  const timeout = await service.execute(baseRequest({
    commandId: "switchyard.fake.sleep",
    argv: ["200"],
    resourceLimits: {
      ...baseLimits,
      wallTimeMs: 25
    }
  }));
  assert(timeout.status === "timeout", `expected timeout status, got ${timeout.status}`);

  const pending = service.execute(baseRequest({
    jobId: "sandbox_job_cancel_1",
    commandId: "switchyard.fake.sleep",
    argv: ["200"]
  }));
  const cancelled = await service.cancel("sandbox_job_cancel_1");
  const afterTerminalCancel = await service.cancel("sandbox_job_cancel_1");
  const pendingResult = await pending;
  assert(cancelled.status === "cancelled", `expected cancelled status, got ${cancelled.status}`);
  assert(afterTerminalCancel.status === "cancelled", `expected idempotent cancelled status, got ${afterTerminalCancel.status}`);
  assert(pendingResult.status === "cancelled", `expected execution promise to resolve cancelled, got ${pendingResult.status}`);

  const transcript = artifactContent.writes.map((item) => item.text).join("\n");
  assert(!transcript.includes("Bearer abc123"), "transcript should redact bearer tokens");
  assert(transcript.includes("[REDACTED]"), "transcript should include redaction markers");

  assert((metrics.counters["sandbox.jobs"] ?? 0) >= 2, "expected sandbox.jobs counter to increase");
  assert((metrics.counters["sandbox.allowed"] ?? 0) >= 2, "expected sandbox.allowed counter to increase");

  process.stdout.write("sandbox:smoke OK\n");
}

const baseLimits = {
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
};

function baseRequest(overrides: Record<string, unknown>) {
  return {
    jobId: "sandbox_job_echo_1",
    runId: "run_sandbox_smoke",
    runtimeMode: "fake.deterministic",
    adapterType: "process",
    commandId: "switchyard.fake.echo",
    argv: ["hello"],
    cwd: "/repo",
    env: {
      SAFE_ENV: "visible",
      API_TOKEN: "secret-token"
    },
    stdin: "Bearer abc123",
    resourceLimits: baseLimits,
    artifactPolicy: {
      captureTranscript: false,
      captureDeniedDecision: false
    },
    createdAt: "2026-05-30T00:00:00.000Z",
    ...overrides
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`sandbox_smoke_failed:${message}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
