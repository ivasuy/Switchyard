import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpenApiDocument } from "../packages/contracts/src/index.js";
import { HostedSandboxService, resolveHostedSandboxConfig, checkHostedSandboxReadiness } from "../packages/core/src/index.js";
import { FakeHostedSandboxExecutor } from "../packages/testkit/src/index.js";

const FORBIDDEN_EXECUTION_PATH_TOKENS = ["/exec", "/shell", "/process", "/command", "/pty", "/terminal", "/sandbox"];

export interface HostedSandboxSmokeReport {
  readiness: {
    default: { ok: boolean; realExecutionMode: string };
    enabledWithoutPolicy: { ok: boolean; code?: string };
  };
  process: { status: string };
  pty: { status: string; transcriptContainsEcho: boolean };
  deniedDisabled: { status: string; reasonCode?: string };
  timeout: { status: string; reasonCode?: string };
  cancel: { initialStatus: string; idempotentStatus: string; pendingStatus: string };
  outputLimit: { status: string; reasonCode?: string };
  artifact: { status: string; artifactCount: number };
  redaction: {
    transcriptContainsSecret: boolean;
    transcriptContainsBearer: boolean;
    transcriptContainsRedactionMarker: boolean;
  };
  boundaries: {
    localForbiddenPathPresent: boolean;
    hostedForbiddenPathPresent: boolean;
    localOffenders: string[];
    hostedOffenders: string[];
  };
}

class MemoryArtifactContent {
  writes: Array<{ path: string; text: string; contentType?: string }> = [];

  async writeText(pathValue: string, text: string, options?: { contentType?: string }) {
    this.writes.push({ path: pathValue, text, contentType: options?.contentType });
    return {
      path: pathValue,
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

  inc(counter: string): void {
    this.counters[counter] = (this.counters[counter] ?? 0) + 1;
  }
}

export async function runHostedSandboxSmoke(): Promise<HostedSandboxSmokeReport> {
  const config = resolveHostedSandboxConfig({ deploymentMode: "test", env: {} });
  const readiness = checkHostedSandboxReadiness(config);

  const enabledNoPolicyConfig = resolveHostedSandboxConfig({
    deploymentMode: "test",
    env: {
      SWITCHYARD_SANDBOX_REAL_EXECUTION: "enabled"
    }
  });
  const enabledNoPolicyReadiness = checkHostedSandboxReadiness(enabledNoPolicyConfig);

  const metrics = new CounterMetrics();
  const artifactContent = new MemoryArtifactContent();
  const service = new HostedSandboxService({
    config,
    executor: new FakeHostedSandboxExecutor(),
    artifactContent,
    metrics
  });

  const process = await service.execute(baseRequest({
    commandId: "switchyard.fake.echo",
    adapterType: "process",
    argv: ["token=abc"],
    artifactPolicy: { captureTranscript: true, captureDeniedDecision: false }
  }));

  const pty = await service.execute(baseRequest({
    adapterType: "pty",
    commandId: "switchyard.fake.pty_echo",
    argv: [],
    artifactPolicy: { captureTranscript: true, captureDeniedDecision: false },
    pty: {
      cols: 80,
      rows: 24,
      inputFrames: [
        { type: "input", data: "alpha" },
        { type: "input", data: "beta" }
      ]
    }
  }));

  const deniedDisabled = await service.execute(baseRequest({
    commandId: "deploy.safe.echo",
    adapterType: "process",
    argv: ["x"]
  }));

  const timeout = await service.execute(baseRequest({
    commandId: "switchyard.fake.sleep",
    argv: ["200"],
    resourceLimits: {
      ...baseLimits,
      wallTimeMs: 25
    }
  }));

  const pending = service.execute(baseRequest({
    jobId: "sandbox_job_cancel_1",
    commandId: "switchyard.fake.sleep",
    argv: ["200"]
  }));
  const cancelled = await service.cancel("sandbox_job_cancel_1");
  const cancelledAgain = await service.cancel("sandbox_job_cancel_1");
  const pendingResult = await pending;

  const outputLimit = await service.execute(baseRequest({
    commandId: "switchyard.fake.output_flood",
    resourceLimits: {
      ...baseLimits,
      stdoutBytes: 100,
      stderrBytes: 100,
      combinedOutputBytes: 150
    }
  }));

  const artifact = await service.execute(baseRequest({
    commandId: "switchyard.fake.artifact",
    resourceLimits: {
      ...baseLimits,
      artifactBytes: 1_048_576
    }
  }));

  const transcript = artifactContent.writes.map((item) => item.text).join("\n");
  const localPaths = Object.keys(generateOpenApiDocument({ surface: "local_daemon" }).paths ?? {});
  const hostedPaths = Object.keys(generateOpenApiDocument({ surface: "hosted_server" }).paths ?? {});
  const localOffenders = forbiddenPathMatches(localPaths);
  const hostedOffenders = forbiddenPathMatches(hostedPaths);

  return {
    readiness: {
      default: {
        ok: readiness.ok,
        realExecutionMode: config.realExecution.mode
      },
      enabledWithoutPolicy: {
        ok: enabledNoPolicyReadiness.ok,
        code: enabledNoPolicyReadiness.code
      }
    },
    process: {
      status: process.status
    },
    pty: {
      status: pty.status,
      transcriptContainsEcho: transcript.includes("pty:alpha|beta:80x24")
    },
    deniedDisabled: {
      status: deniedDisabled.status,
      reasonCode: deniedDisabled.reasonCode
    },
    timeout: {
      status: timeout.status,
      reasonCode: timeout.reasonCode
    },
    cancel: {
      initialStatus: cancelled.status,
      idempotentStatus: cancelledAgain.status,
      pendingStatus: pendingResult.status
    },
    outputLimit: {
      status: outputLimit.status,
      reasonCode: outputLimit.reasonCode
    },
    artifact: {
      status: artifact.status,
      artifactCount: artifact.artifacts.length
    },
    redaction: {
      transcriptContainsSecret: transcript.includes("secret-token"),
      transcriptContainsBearer: transcript.includes("Bearer abc123"),
      transcriptContainsRedactionMarker: transcript.includes("[REDACTED]")
    },
    boundaries: {
      localForbiddenPathPresent: localOffenders.length > 0,
      hostedForbiddenPathPresent: hostedOffenders.length > 0,
      localOffenders,
      hostedOffenders
    }
  };
}

function forbiddenPathMatches(paths: string[]): string[] {
  const matches = new Set<string>();
  for (const routePath of paths) {
    const lower = routePath.toLowerCase();
    for (const forbidden of FORBIDDEN_EXECUTION_PATH_TOKENS) {
      if (lower === forbidden || lower.startsWith(`${forbidden}/`) || lower.includes(`${forbidden}?`)) {
        matches.add(routePath);
      }
    }
  }
  return [...matches];
}

export function assertHostedSandboxSmoke(report: HostedSandboxSmokeReport): void {
  assert(report.readiness.default.ok, `sandbox readiness should be ok, got default readiness false`);
  assert(report.readiness.default.realExecutionMode === "disabled", `expected realExecution.mode=disabled, got ${report.readiness.default.realExecutionMode}`);
  assert(report.readiness.enabledWithoutPolicy.ok === false, "enabled-without-policy readiness should fail closed");
  assert(report.readiness.enabledWithoutPolicy.code === "sandbox_policy_missing", `expected sandbox_policy_missing, got ${report.readiness.enabledWithoutPolicy.code ?? "none"}`);

  assert(report.process.status === "completed", `expected completed process, got ${report.process.status}`);
  assert(report.pty.status === "completed", `expected completed pty, got ${report.pty.status}`);
  assert(report.pty.transcriptContainsEcho, "expected deterministic pty echo output in transcript");
  assert(report.deniedDisabled.reasonCode === "sandbox_real_execution_disabled", `expected sandbox_real_execution_disabled, got ${report.deniedDisabled.reasonCode ?? "none"}`);

  assert(report.timeout.status === "timeout", `expected timeout status, got ${report.timeout.status}`);
  assert(report.timeout.reasonCode === "sandbox_timeout", `expected sandbox_timeout reasonCode, got ${report.timeout.reasonCode ?? "none"}`);
  assert(report.cancel.initialStatus === "cancelled", `expected cancelled status, got ${report.cancel.initialStatus}`);
  assert(report.cancel.idempotentStatus === "cancelled", `expected idempotent cancelled status, got ${report.cancel.idempotentStatus}`);
  assert(report.cancel.pendingStatus === "cancelled", `expected pending execution to resolve cancelled, got ${report.cancel.pendingStatus}`);

  assert(report.outputLimit.reasonCode === "sandbox_output_limit_exceeded", `expected sandbox_output_limit_exceeded, got ${report.outputLimit.reasonCode ?? "none"}`);
  assert(report.artifact.status === "completed", `expected artifact status completed, got ${report.artifact.status}`);
  assert(report.artifact.artifactCount > 0, `expected artifact count > 0, got ${report.artifact.artifactCount}`);

  assert(report.redaction.transcriptContainsSecret === false, "transcript should redact secret token");
  assert(report.redaction.transcriptContainsBearer === false, "transcript should redact bearer token");
  assert(report.redaction.transcriptContainsRedactionMarker, "transcript should include redaction markers");

  assert(report.boundaries.localForbiddenPathPresent === false, `local OpenAPI exposes forbidden path: ${report.boundaries.localOffenders.join(",")}`);
  assert(report.boundaries.hostedForbiddenPathPresent === false, `hosted OpenAPI exposes forbidden path: ${report.boundaries.hostedOffenders.join(",")}`);
}

async function main(): Promise<void> {
  const report = await runHostedSandboxSmoke();
  assertHostedSandboxSmoke(report);
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

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath && invokedPath === modulePath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
