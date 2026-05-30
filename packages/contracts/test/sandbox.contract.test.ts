import { describe, expect, it } from "vitest";
import {
  SANDBOX_FAKE_COMMAND_IDS,
  SANDBOX_MAX_RESOURCE_LIMITS,
  SANDBOX_DEFAULT_RESOURCE_LIMITS,
  sandboxAdapterTypeSchema,
  sandboxFakeCommandIdSchema,
  sandboxJobRequestSchema,
  sandboxJobResultSchema,
  sandboxNamedErrorSchema,
  sandboxPolicyDecisionSchema,
  sandboxResourceLimitsSchema,
  sandboxTerminalStateSchema
} from "../src/index.js";

const baseRequest = {
  jobId: "sandbox_job_echo_1",
  runId: "run_sandbox_smoke",
  runtimeMode: "fake.deterministic",
  adapterType: "process",
  commandId: "switchyard.fake.echo",
  argv: ["hello"],
  cwd: "/repo",
  env: { SAFE_ENV: "visible", API_TOKEN: "secret-value" },
  stdin: "input secret=abc",
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
  artifactPolicy: { captureTranscript: true, captureDeniedDecision: false },
  createdAt: "2026-05-30T00:00:00.000Z"
} as const;

describe("sandbox contracts", () => {
  it("exports expected fake command ids", () => {
    expect(SANDBOX_FAKE_COMMAND_IDS).toEqual([
      "switchyard.fake.echo",
      "switchyard.fake.stderr",
      "switchyard.fake.exit",
      "switchyard.fake.sleep",
      "switchyard.fake.artifact",
      "switchyard.fake.output_flood",
      "switchyard.fake.pty_echo"
    ]);
  });

  it("parses complete process request", () => {
    const parsed = sandboxJobRequestSchema.parse(baseRequest);
    expect(parsed.adapterType).toBe("process");
    expect(parsed.commandId).toBe("switchyard.fake.echo");
  });

  it("parses complete pty request", () => {
    const parsed = sandboxJobRequestSchema.parse({
      ...baseRequest,
      adapterType: "pty",
      commandId: "switchyard.fake.pty_echo",
      pty: {
        cols: 80,
        rows: 24,
        inputFrames: [{ type: "input", data: "echo hello" }, { type: "resize", cols: 100, rows: 40 }]
      }
    });
    expect(parsed.pty?.cols).toBe(80);
    expect(parsed.pty?.rows).toBe(24);
  });

  it("rejects invalid adapter and pty combinations", () => {
    expect(() => sandboxJobRequestSchema.parse({ ...baseRequest, adapterType: "process", pty: { cols: 80, rows: 24 } })).toThrow();
    expect(() => sandboxJobRequestSchema.parse({ ...baseRequest, adapterType: "pty", pty: undefined })).toThrow();
    expect(() => sandboxJobRequestSchema.parse({ ...baseRequest, adapterType: "process", commandId: "switchyard.fake.pty_echo" })).toThrow();
  });

  it("rejects invalid cwd", () => {
    expect(() => sandboxJobRequestSchema.parse({ ...baseRequest, cwd: "repo" })).toThrow();
    expect(() => sandboxJobRequestSchema.parse({ ...baseRequest, cwd: "/repo/../tmp" })).toThrow();
  });

  it("rejects malformed env and argv", () => {
    expect(() => sandboxJobRequestSchema.parse({ ...baseRequest, env: "oops" as unknown as Record<string, string> })).toThrow();
    expect(() => sandboxJobRequestSchema.parse({ ...baseRequest, argv: ["ok", 1] as unknown as string[] })).toThrow();
  });

  it("parses policy decisions and named errors", () => {
    const allow = sandboxPolicyDecisionSchema.parse({ decision: "allow", policyTrace: [] });
    const deny = sandboxPolicyDecisionSchema.parse({ decision: "deny", reasonCode: "sandbox_command_denied", policyTrace: [{ rule: "fake_only" }] });
    expect(allow.decision).toBe("allow");
    expect(deny.reasonCode).toBe("sandbox_command_denied");
    expect(() => sandboxNamedErrorSchema.parse("unknown_error")).toThrow();
  });

  it("parses terminal result shape", () => {
    const result = sandboxJobResultSchema.parse({
      jobId: "sandbox_job_echo_1",
      runId: "run_sandbox_smoke",
      adapterType: "process",
      commandId: "switchyard.fake.echo",
      status: "completed",
      endedAt: "2026-05-30T00:00:01.000Z",
      durationMs: 1_000,
      stdoutBytes: 12,
      stderrBytes: 0,
      combinedOutputBytes: 12,
      stdoutTruncated: false,
      stderrTruncated: false,
      outputLimitExceeded: false,
      artifacts: [],
      lifecycle: [],
      metadata: {}
    });
    expect(result.status).toBe("completed");
  });

  it("exports resource limit contracts", () => {
    const parsed = sandboxResourceLimitsSchema.parse(SANDBOX_DEFAULT_RESOURCE_LIMITS);
    expect(parsed.wallTimeMs).toBe(30_000);
    expect(SANDBOX_MAX_RESOURCE_LIMITS.artifactBytes).toBe(1_048_576);
  });

  it("exports adapter/status/command schemas", () => {
    expect(sandboxAdapterTypeSchema.parse("process")).toBe("process");
    expect(sandboxTerminalStateSchema.parse("timeout")).toBe("timeout");
    expect(sandboxFakeCommandIdSchema.parse("switchyard.fake.output_flood")).toBe("switchyard.fake.output_flood");
    expect(() => sandboxFakeCommandIdSchema.parse("bash")).toThrow();
  });
});
