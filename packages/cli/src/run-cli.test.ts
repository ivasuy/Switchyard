import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SwitchyardHttpError } from "@switchyard/sdk";
import { generateOpenApiDocument, renderOpenApiJson } from "@switchyard/contracts";
import { runCli, type CliDependencies } from "./run-cli.js";

function createDeps(overrides: Partial<CliDependencies> = {}): { deps: CliDependencies; output: { stdout: string; stderr: string } } {
  const output = { stdout: "", stderr: "" };
  const deps: CliDependencies = {
    stdout: (text) => {
      output.stdout += text;
    },
    stderr: (text) => {
      output.stderr += text;
    },
    createClient: () => ({
      doctor: async () => ({ summary: { available: 1, partial: 0, unavailable: 0 } }),
      checkRuntimeMode: async (runtimeModeId) => ({ runtimeMode: runtimeModeId, canRun: true, state: "available" }),
      createRun: async () => ({ run: { id: "run_1", status: "completed" } }),
      getRun: async () => ({ run: { id: "run_1" }, events: [{ id: "event_1" }] }),
      listRunEvents: async () => [{ id: "event_1", type: "run.completed" }],
      listRunArtifacts: async () => ({ artifacts: [{ id: "artifact_1" }] }),
      getArtifactContent: async () => ({
        contentType: "text/plain; charset=utf-8",
        text: () => "artifact body"
      })
    }),
    generateMatrix: async () => ({ summary: { pass: 1, skip: 1, fail: 0 }, rows: [] }),
    renderOpenApi: () => "{\n  \"openapi\": \"3.1.0\"\n}\n",
    startDaemon: async () => ({ close: async () => {} }),
    waitForDaemonReady: async () => {},
    waitForStop: async () => {},
    ...overrides
  };
  return { deps, output };
}

describe("runCli", () => {
  it("prints doctor JSON and executes active fake check", async () => {
    const checkRuntimeMode = vi.fn(async () => ({ runtimeMode: "fake.deterministic", canRun: true, state: "available" }));
    const { deps, output } = createDeps({
      createClient: () => ({
        doctor: async () => ({ summary: { available: 1, partial: 0, unavailable: 0 } }),
        checkRuntimeMode,
        createRun: async () => ({ run: { id: "run_1", status: "completed" } }),
        getRun: async () => ({ run: { id: "run_1" }, events: [] }),
        listRunEvents: async () => [],
        listRunArtifacts: async () => ({ artifacts: [] }),
        getArtifactContent: async () => ({ contentType: "text/plain", text: () => "" })
      })
    });

    const code = await runCli(["doctor", "--json", "--active-fake-check"], deps);
    expect(code).toBe(0);
    expect(output.stdout).toContain("\"summary\"");
    expect(output.stdout).toContain("\"activeFakeCheck\"");
    expect(checkRuntimeMode).toHaveBeenCalledWith("fake.deterministic");
  });

  it("prints human doctor output", async () => {
    const { deps, output } = createDeps();
    const code = await runCli(["doctor", "--human"], deps);
    expect(code).toBe(0);
    expect(output.stdout).toContain("Doctor summary");
    expect(output.stdout).toContain("available=1");
  });

  it("runs fake command with cwd/task/timeout and wait", async () => {
    let payload: Record<string, unknown> | undefined;
    let seenWait = false;
    const { deps, output } = createDeps({
      createClient: () => ({
        doctor: async () => ({}),
        checkRuntimeMode: async () => ({ runtimeMode: "fake.deterministic", canRun: true, state: "available" }),
        createRun: async (input, options) => {
          payload = input;
          seenWait = options?.wait === true;
          return { run: { id: "run_wait", status: "completed" } };
        },
        getRun: async () => ({ run: {}, events: [] }),
        listRunEvents: async () => [],
        listRunArtifacts: async () => ({ artifacts: [] }),
        getArtifactContent: async () => ({ contentType: "text/plain", text: () => "" })
      })
    });

    const code = await runCli([
      "run",
      "fake",
      "--cwd",
      "/tmp/repo",
      "--task",
      "fake-task",
      "--timeout-seconds",
      "33",
      "--wait"
    ], deps);

    expect(code).toBe(0);
    expect(seenWait).toBe(true);
    expect(payload).toMatchObject({
      cwd: "/tmp/repo",
      task: "fake-task",
      timeoutSeconds: 33
    });
    expect(output.stdout).toContain("run_wait");
  });

  it("runs local fake command without auth env vars and without daemon/process side effects", async () => {
    const createRun = vi.fn(async () => ({ run: { id: "run_local_no_auth", status: "completed" } }));
    const createClient = vi.fn(() => ({
      doctor: async () => ({}),
      checkRuntimeMode: async () => ({ runtimeMode: "fake.deterministic", canRun: true, state: "available" }),
      createRun,
      getRun: async () => ({ run: {}, events: [] }),
      listRunEvents: async () => [],
      listRunArtifacts: async () => ({ artifacts: [] }),
      getArtifactContent: async () => ({ contentType: "text/plain", text: () => "" })
    }));
    const startDaemon = vi.fn(async () => ({ close: async () => {} }));
    const waitForDaemonReady = vi.fn(async () => {});
    const waitForStop = vi.fn(async () => {});
    const { deps, output } = createDeps({
      createClient,
      startDaemon,
      waitForDaemonReady,
      waitForStop
    });

    const originalApiKey = process.env["SWITCHYARD_API_KEY"];
    const originalAuthMode = process.env["SWITCHYARD_SERVER_AUTH_MODE"];
    delete process.env["SWITCHYARD_API_KEY"];
    delete process.env["SWITCHYARD_SERVER_AUTH_MODE"];

    try {
      const code = await runCli(["run", "fake", "--base-url", "http://127.0.0.1:4545", "--wait"], deps);
      expect(code).toBe(0);
      expect(createClient).toHaveBeenCalledWith("http://127.0.0.1:4545");
      expect(createRun).toHaveBeenCalledTimes(1);
      expect(startDaemon).not.toHaveBeenCalled();
      expect(waitForDaemonReady).not.toHaveBeenCalled();
      expect(waitForStop).not.toHaveBeenCalled();
      expect(output.stdout).toContain("run_local_no_auth");
    } finally {
      if (originalApiKey === undefined) {
        delete process.env["SWITCHYARD_API_KEY"];
      } else {
        process.env["SWITCHYARD_API_KEY"] = originalApiKey;
      }
      if (originalAuthMode === undefined) {
        delete process.env["SWITCHYARD_SERVER_AUTH_MODE"];
      } else {
        process.env["SWITCHYARD_SERVER_AUTH_MODE"] = originalAuthMode;
      }
    }
  });

  it("returns usage exit for invalid run fake timeout", async () => {
    const { deps, output } = createDeps();
    const code = await runCli(["run", "fake", "--timeout-seconds", "0"], deps);
    expect(code).toBe(2);
    expect(output.stderr).toContain("timeout-seconds");
  });

  it("prints runtime test matrix for runtime and runtimes groups", async () => {
    const { deps, output } = createDeps();
    expect(await runCli(["runtime", "test"], deps)).toBe(0);
    expect(await runCli(["runtimes", "test"], deps)).toBe(0);
    expect(output.stdout).toContain("\"pass\"");
  });

  it("returns usage exit for missing debug run id", async () => {
    const { deps, output } = createDeps();
    const code = await runCli(["debug", "run"], deps);
    expect(code).toBe(2);
    expect(output.stderr).toContain("requires <run-id>");
  });

  it("prints debug run with live events and artifact content", async () => {
    const listRunEvents = vi.fn(async () => [{ id: "event_1", type: "run.completed", payload: {}, sequence: 1 }]);
    const { deps, output } = createDeps({
      createClient: () => ({
        doctor: async () => ({}),
        checkRuntimeMode: async () => ({ runtimeMode: "fake.deterministic", canRun: true, state: "available" }),
        createRun: async () => ({ run: { id: "x", status: "completed" } }),
        getRun: async () => ({ run: { id: "run_x", status: "completed" }, events: [] }),
        listRunEvents,
        listRunArtifacts: async () => ({ artifacts: [{ id: "artifact_1" }] }),
        getArtifactContent: async () => ({
          contentType: "text/plain",
          text: () => "hello artifact"
        })
      })
    });

    const code = await runCli([
      "debug",
      "run",
      "run_x",
      "--live",
      "--include-artifact-content"
    ], deps);

    expect(code).toBe(0);
    expect(listRunEvents).toHaveBeenCalledWith("run_x", { live: true, stopAfter: 1 });
    expect(output.stdout).toContain("hello artifact");
    expect(output.stdout).toContain("run_x");
  });

  it("prints typed HTTP error for debug run failures", async () => {
    const { deps, output } = createDeps({
      createClient: () => ({
        doctor: async () => ({}),
        checkRuntimeMode: async () => ({ runtimeMode: "fake.deterministic", canRun: true, state: "available" }),
        createRun: async () => ({ run: { id: "x", status: "completed" } }),
        getRun: async () => {
          throw new SwitchyardHttpError({
            status: 404,
            code: "run_not_found",
            message: "Run missing",
            requestId: "req_404"
          });
        },
        listRunEvents: async () => [],
        listRunArtifacts: async () => ({ artifacts: [] }),
        getArtifactContent: async () => ({ contentType: "text/plain", text: () => "" })
      })
    });

    const code = await runCli(["debug", "run", "run_missing"], deps);
    expect(code).toBe(1);
    expect(output.stderr).toContain("run_not_found");
    expect(output.stderr).toContain("req_404");
  });

  it("handles daemon start port failures", async () => {
    const { deps, output } = createDeps({
      startDaemon: async () => {
        const error = new Error("listen EADDRINUSE");
        (error as Error & { code?: string }).code = "EADDRINUSE";
        throw error;
      }
    });
    const code = await runCli(["daemon", "start", "--port", "4545", "--foreground"], deps);
    expect(code).toBe(1);
    expect(output.stderr).toContain("EADDRINUSE");
  });

  it("handles daemon readiness failures and closes app", async () => {
    const close = vi.fn(async () => {});
    const { deps, output } = createDeps({
      startDaemon: async () => ({ close }),
      waitForDaemonReady: async () => {
        throw new Error("readiness timeout");
      }
    });

    const code = await runCli(["daemon", "start", "--ready-timeout-ms", "1"], deps);
    expect(code).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(output.stderr).toContain("readiness timeout");
  });

  it("writes contract export output to path", async () => {
    const { deps, output } = createDeps();
    const dir = mkdtempSync(join(tmpdir(), "switchyard-cli-contract-"));
    const outPath = join(dir, "openapi.json");
    try {
      const code = await runCli(["contract", "export", "--output", outPath], deps);
      expect(code).toBe(0);
      expect(output.stdout).toContain(outPath);
      const written = readFileSync(outPath, "utf8");
      expect(written).toContain("openapi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports local daemon OpenAPI by default without hosted API key scheme", async () => {
    const startDaemon = vi.fn(async () => ({ close: async () => {} }));
    const waitForDaemonReady = vi.fn(async () => {});
    const waitForStop = vi.fn(async () => {});
    const { deps, output } = createDeps({
      renderOpenApi: () => renderOpenApiJson(generateOpenApiDocument()),
      startDaemon,
      waitForDaemonReady,
      waitForStop
    });
    const dir = mkdtempSync(join(tmpdir(), "switchyard-cli-contract-local-default-"));
    const outPath = join(dir, "openapi-local-default.json");

    try {
      const code = await runCli(["contract", "export", "--output", outPath], deps);
      expect(code).toBe(0);
      expect(output.stdout).toContain(outPath);
      expect(startDaemon).not.toHaveBeenCalled();
      expect(waitForDaemonReady).not.toHaveBeenCalled();
      expect(waitForStop).not.toHaveBeenCalled();

      const written = JSON.parse(readFileSync(outPath, "utf8")) as {
        info: { title: string };
        components?: { securitySchemes?: Record<string, unknown> };
      };
      expect(written.info.title).toBe("Switchyard Local Daemon API");
      expect(written.components?.securitySchemes?.["SwitchyardApiKey"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
