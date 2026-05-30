import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ArtifactStore, StoredArtifactContent } from "../src/index.js";
import {
  HostedSandboxPolicy,
  HostedSandboxService,
  checkHostedSandboxReadiness,
  resolveHostedSandboxConfig,
  redactSandboxValue,
  type HostedSandboxExecutorPort
} from "../src/index.js";

class MemoryArtifactContent {
  writes: Array<{ path: string; text: string; contentType?: string }> = [];

  async writeText(path: string, text: string, options?: { contentType?: string }): Promise<StoredArtifactContent> {
    this.writes.push({ path, text, contentType: options?.contentType });
    return {
      path,
      storageBackend: "memory",
      sizeBytes: Buffer.byteLength(text, "utf8"),
      sha256: "fake_sha",
      contentType: options?.contentType ?? "text/plain"
    };
  }

  async writeBytes(): Promise<StoredArtifactContent> {
    throw new Error("not_implemented");
  }

  async read(): Promise<{ body: Buffer; contentType: string }> {
    throw new Error("not_implemented");
  }
}

class MemoryArtifactStore implements ArtifactStore {
  items: any[] = [];

  async create(item: any): Promise<any> {
    this.items.push(item);
    return item;
  }

  async get(id: string): Promise<any> {
    return this.items.find((item) => item.id === id);
  }

  async update(item: any): Promise<any> {
    const idx = this.items.findIndex((entry) => entry.id === item.id);
    if (idx >= 0) {
      this.items[idx] = item;
    }
    return item;
  }

  async delete(id: string): Promise<void> {
    this.items = this.items.filter((item) => item.id !== id);
  }

  async list(): Promise<{ artifacts: any[]; nextCursor: string | null }> {
    return { artifacts: [...this.items], nextCursor: null };
  }

  async listByRun(runId: string): Promise<any[]> {
    return this.items.filter((item) => item.runId === runId);
  }

  async listByDebate(): Promise<any[]> {
    return [];
  }
}

class TestExecutor implements HostedSandboxExecutorPort {
  calls = 0;
  async execute(request: any, options?: { signal?: AbortSignal }): Promise<any> {
    this.calls += 1;
    if (request.commandId === "switchyard.fake.sleep") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 100);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        }, { once: true });
      });
    }

    if (request.commandId === "switchyard.fake.exit") {
      return {
        status: "failed",
        exitCode: 7,
        stdout: "",
        stderr: "nonzero",
        artifacts: []
      };
    }

    if (request.commandId === "switchyard.fake.output_flood") {
      return {
        status: "completed",
        stdout: "x".repeat(2000),
        stderr: "y".repeat(2000),
        artifacts: []
      };
    }

    if (request.commandId === "switchyard.fake.artifact") {
      return {
        status: "completed",
        stdout: "artifact ready",
        stderr: "",
        artifacts: [
          {
            path: `sandbox/${request.jobId}/result.txt`,
            contentType: "text/plain",
            content: "artifact-content"
          }
        ]
      };
    }

    return {
      status: "completed",
      stdout: `echo:${request.argv.join(" ")}`,
      stderr: "",
      artifacts: []
    };
  }
}

describe("HostedSandboxPolicy", () => {
  it("allows fake command ids and denies real command ids", () => {
    const policy = new HostedSandboxPolicy({ allowlist: ["switchyard.fake.echo", "switchyard.fake.stderr"] });
    expect(policy.decide({ commandId: "switchyard.fake.echo" }).decision).toBe("allow");
    const denied = policy.decide({ commandId: "bash" });
    expect(denied.decision).toBe("deny");
    expect(denied.reasonCode).toBe("sandbox_command_denied");
  });
});

describe("HostedSandboxService", () => {
  it("fails missing request before executor", async () => {
    const service = new HostedSandboxService({
      config: resolveHostedSandboxConfig({ deploymentMode: "test", env: {} }),
      executor: new TestExecutor()
    });

    const result = await service.execute(undefined);
    expect(result.reasonCode).toBe("sandbox_request_missing");
  });

  it("denies unknown command before executor call", async () => {
    const executor = new TestExecutor();
    const service = new HostedSandboxService({
      config: resolveHostedSandboxConfig({ deploymentMode: "test", env: {} }),
      executor
    });

    const result = await service.execute(baseRequest({ commandId: "bash" }));
    expect(result.reasonCode).toBe("sandbox_command_denied");
    expect(executor.calls).toBe(0);
  });

  it("enforces argv/env/stdin limits", async () => {
    const service = new HostedSandboxService({
      config: resolveHostedSandboxConfig({ deploymentMode: "test", env: {} }),
      executor: new TestExecutor()
    });

    const argvTooLarge = await service.execute(baseRequest({ argv: new Array(33).fill("x") }));
    expect(argvTooLarge.reasonCode).toBe("sandbox_argv_too_large");

    const envTooLarge = await service.execute(baseRequest({ env: Object.fromEntries(new Array(33).fill(0).map((_, idx) => [`K${idx}`, "v"])) }));
    expect(envTooLarge.reasonCode).toBe("sandbox_env_too_large");

    const stdinTooLarge = await service.execute(baseRequest({ stdin: "a".repeat(70_000) }));
    expect(stdinTooLarge.reasonCode).toBe("sandbox_stdin_too_large");
  });

  it("times out long-running jobs and supports idempotent cancel", async () => {
    const executor = new TestExecutor();
    const service = new HostedSandboxService({
      config: resolveHostedSandboxConfig({
        deploymentMode: "test",
        env: {
          SWITCHYARD_SANDBOX_WALL_TIME_MS: "20"
        }
      }),
      executor
    });

    const timeout = await service.execute(baseRequest({
      commandId: "switchyard.fake.sleep",
      resourceLimits: {
        wallTimeMs: 20,
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
      }
    }));
    expect(timeout.status).toBe("timeout");
    expect(timeout.reasonCode).toBe("sandbox_timeout");

    const unknownCancel = await service.cancel("unknown_job");
    expect(unknownCancel.reasonCode).toBe("sandbox_job_not_found");
  });

  it("captures transcript artifacts with redaction", async () => {
    const artifactContent = new MemoryArtifactContent();
    const artifacts = new MemoryArtifactStore();
    const service = new HostedSandboxService({
      config: resolveHostedSandboxConfig({ deploymentMode: "test", env: {} }),
      executor: new TestExecutor(),
      artifactContent,
      artifacts
    });

    const result = await service.execute(baseRequest({
      env: { API_TOKEN: "secret-token" },
      stdin: "Bearer abc123",
      artifactPolicy: { captureTranscript: true, captureDeniedDecision: false }
    }));

    expect(result.status).toBe("completed");
    expect(result.transcriptArtifact?.contentStored).toBe(true);
    expect(artifactContent.writes.length).toBe(1);
    expect(artifactContent.writes[0]?.text).not.toContain("secret-token");
    expect(artifacts.items.length).toBe(1);
  });

  it("returns contentStored=false when artifact content store is absent", async () => {
    const service = new HostedSandboxService({
      config: resolveHostedSandboxConfig({ deploymentMode: "test", env: {} }),
      executor: new TestExecutor()
    });

    const result = await service.execute(baseRequest({
      artifactPolicy: { captureTranscript: true, captureDeniedDecision: false }
    }));

    expect(result.status).toBe("completed");
    expect(result.transcriptArtifact?.contentStored).toBe(false);
  });

  it("enforces output and artifact limits", async () => {
    const service = new HostedSandboxService({
      config: resolveHostedSandboxConfig({
        deploymentMode: "test",
        env: {
          SWITCHYARD_SANDBOX_STDOUT_BYTES: "100",
          SWITCHYARD_SANDBOX_STDERR_BYTES: "100",
          SWITCHYARD_SANDBOX_COMBINED_OUTPUT_BYTES: "150",
          SWITCHYARD_SANDBOX_ARTIFACT_BYTES: "10"
        }
      }),
      executor: new TestExecutor()
    });

    const output = await service.execute(baseRequest({
      commandId: "switchyard.fake.output_flood",
      resourceLimits: {
        wallTimeMs: 30_000,
        stdoutBytes: 100,
        stderrBytes: 100,
        combinedOutputBytes: 150,
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
      }
    }));
    expect(output.reasonCode).toBe("sandbox_output_limit_exceeded");

    const artifact = await service.execute(baseRequest({
      commandId: "switchyard.fake.artifact",
      resourceLimits: {
        wallTimeMs: 30_000,
        stdoutBytes: 65_536,
        stderrBytes: 65_536,
        combinedOutputBytes: 131_072,
        artifactBytes: 10,
        stdinBytes: 65_536,
        argvCount: 32,
        argvEntryBytes: 256,
        envKeys: 32,
        envValueBytes: 4_096,
        ptyCols: 80,
        ptyRows: 24,
        cpuMs: 1_000,
        memoryMiB: 256
      }
    }));
    expect(artifact.reasonCode).toBe("sandbox_artifact_too_large");
  });
});

describe("sandbox readiness and redaction", () => {
  it("reports disabled and invalid policy states", () => {
    const disabled = resolveHostedSandboxConfig({
      deploymentMode: "test",
      env: { SWITCHYARD_SANDBOX_ENABLED: "false" }
    });
    expect(checkHostedSandboxReadiness(disabled)).toMatchObject({ ok: false, code: "sandbox_disabled" });

    const invalid = resolveHostedSandboxConfig({
      deploymentMode: "test",
      env: { SWITCHYARD_SANDBOX_FAKE_COMMAND_ALLOWLIST: "bash" }
    });
    expect(checkHostedSandboxReadiness(invalid)).toMatchObject({ ok: false, code: "sandbox_policy_invalid" });
  });

  it("redacts sensitive surfaces", () => {
    const redacted = redactSandboxValue({
      token: "abc",
      auth: "Bearer abc",
      url: "https://user:pass@example.com/path?signature=123&ok=yes"
    });
    expect(JSON.stringify(redacted)).not.toContain("abc");
    expect(JSON.stringify(redacted)).toContain("REDACTED");
  });

  it("extends shared local policy redaction keys", () => {
    const source = readFileSync(new URL("../src/services/local-policy-gate.ts", import.meta.url), "utf8");
    expect(source).toContain("credential");
    expect(source).toContain("cookie");
    expect(source).toContain("privatekey");
    expect(source).toContain("refreshtoken");
    expect(source).toContain("idtoken");
  });

  it("hosted sandbox source avoids forbidden real-exec imports", () => {
    const source = readFileSync(new URL("../src/services/hosted-sandbox-service.ts", import.meta.url), "utf8");
    expect(source).not.toContain("child_process");
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("node-pty");
    expect(source).not.toContain("@switchyard/adapters");
  });
});

function baseRequest(overrides: Record<string, unknown>) {
  return {
    jobId: "sandbox_job_echo_1",
    runId: "run_sandbox_smoke",
    runtimeMode: "fake.deterministic",
    adapterType: "process",
    commandId: "switchyard.fake.echo",
    argv: ["hello"],
    cwd: "/repo",
    env: { SAFE_ENV: "visible" },
    stdin: "input",
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
      captureTranscript: false,
      captureDeniedDecision: false
    },
    createdAt: "2026-05-30T00:00:00.000Z",
    ...overrides
  };
}
