import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SwitchyardHttpError } from "@switchyard/sdk";
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
      createRun: async () => ({ run: { id: "run_1", status: "completed" } }),
      getRun: async () => ({ run: { id: "run_1" }, events: [{ id: "event_1" }] }),
      listRunArtifacts: async () => ({ artifacts: [{ id: "artifact_1" }] })
    }),
    generateMatrix: async () => ({ summary: { pass: 1, skip: 1, fail: 0 }, rows: [] }),
    renderOpenApi: () => "{\n  \"openapi\": \"3.1.0\"\n}\n",
    startDaemon: async () => ({ close: async () => {} }),
    waitForStop: async () => {},
    ...overrides
  };
  return { deps, output };
}

describe("runCli", () => {
  it("prints doctor JSON", async () => {
    const { deps, output } = createDeps();
    const code = await runCli(["doctor"], deps);
    expect(code).toBe(0);
    expect(output.stdout).toContain("\"summary\"");
  });

  it("runs fake command with wait flag", async () => {
    let seenWait = false;
    const { deps, output } = createDeps({
      createClient: () => ({
        doctor: async () => ({}),
        createRun: async (_payload, options) => {
          seenWait = options?.wait === true;
          return { run: { id: "run_wait", status: "completed" } };
        },
        getRun: async () => ({ run: {}, events: [] }),
        listRunArtifacts: async () => ({ artifacts: [] })
      })
    });

    const code = await runCli(["run", "fake", "--wait"], deps);
    expect(code).toBe(0);
    expect(seenWait).toBe(true);
    expect(output.stdout).toContain("run_wait");
  });

  it("prints runtime test matrix", async () => {
    const { deps, output } = createDeps();
    const code = await runCli(["runtime", "test"], deps);
    expect(code).toBe(0);
    expect(output.stdout).toContain("\"pass\"");
  });

  it("returns usage exit for missing debug run id", async () => {
    const { deps, output } = createDeps();
    const code = await runCli(["debug", "run"], deps);
    expect(code).toBe(2);
    expect(output.stderr).toContain("requires <run-id>");
  });

  it("prints typed HTTP error for debug run failures", async () => {
    const { deps, output } = createDeps({
      createClient: () => ({
        doctor: async () => ({}),
        createRun: async () => ({ run: { id: "x", status: "completed" } }),
        getRun: async () => {
          throw new SwitchyardHttpError({
            status: 404,
            code: "run_not_found",
            message: "Run missing",
            requestId: "req_404"
          });
        },
        listRunArtifacts: async () => ({ artifacts: [] })
      })
    });

    const code = await runCli(["debug", "run", "run_missing"], deps);
    expect(code).toBe(1);
    expect(output.stderr).toContain("run_not_found");
    expect(output.stderr).toContain("req_404");
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
});
