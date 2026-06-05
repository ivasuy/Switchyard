import type { SandboxJobRequest, SandboxResourceLimits } from "@switchyard/contracts";
import type { HostedSandboxExecutorOutput, HostedSandboxExecutorPort } from "@switchyard/core";

export class FakeHostedSandboxExecutor implements HostedSandboxExecutorPort {
  async execute(
    request: SandboxJobRequest & { resourceLimits: SandboxResourceLimits },
    options?: { signal?: AbortSignal }
  ): Promise<HostedSandboxExecutorOutput> {
    ensureNotAborted(options?.signal);

    if (request.commandId === "switchyard.fake.sleep") {
      const delayMs = readSleepMs(request.argv, 50);
      await waitFor(delayMs, options?.signal);
      return {
        status: "completed",
        stdout: `slept:${delayMs}`,
        stderr: "",
        artifacts: []
      };
    }

    if (request.commandId === "switchyard.fake.exit") {
      const exitCode = readExitCode(request.argv, 1);
      return {
        status: "failed",
        exitCode,
        stdout: "",
        stderr: `fake exit ${exitCode}`,
        artifacts: []
      };
    }

    if (request.commandId === "switchyard.fake.stderr") {
      return {
        status: "completed",
        stdout: "",
        stderr: "fake stderr output",
        artifacts: []
      };
    }

    if (request.commandId === "switchyard.fake.artifact") {
      const artifactText = [
        "sandbox-artifact",
        `job:${request.jobId}`,
        `run:${request.runId ?? "none"}`,
        `command:${request.commandId}`
      ].join("\n");
      return {
        status: "completed",
        stdout: "artifact generated",
        stderr: "",
        artifacts: [
          {
            path: `sandbox/${request.jobId}/artifact.txt`,
            contentType: "text/plain",
            content: artifactText,
            metadata: {
              deterministic: true,
              commandId: request.commandId
            }
          }
        ]
      };
    }

    if (request.commandId === "switchyard.fake.output_flood") {
      return {
        status: "completed",
        stdout: "stdout:" + "x".repeat(4_096),
        stderr: "stderr:" + "y".repeat(4_096),
        artifacts: []
      };
    }

    if (request.commandId === "switchyard.fake.pty_echo") {
      const input = request.pty?.inputFrames
        .filter((frame) => frame.type === "input")
        .map((frame) => frame.data)
        .join("|") ?? "";
      const dims = request.pty ? `${request.pty.cols}x${request.pty.rows}` : "unknown";
      return {
        status: "completed",
        stdout: `pty:${input}:${dims}`,
        stderr: "",
        artifacts: []
      };
    }

    const echoed = request.argv.join(" ");
    return {
      status: "completed",
      stdout: `echo:${echoed}`,
      stderr: "",
      artifacts: []
    };
  }
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("aborted"));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("aborted");
  }
}

function readSleepMs(argv: string[], fallback: number): number {
  const parsed = Number(argv[0]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), 200);
}

function readExitCode(argv: string[], fallback: number): number {
  const parsed = Number(argv[0]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}
