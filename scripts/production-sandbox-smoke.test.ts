import { describe, expect, test } from "vitest";
import { runHostedSandboxSmoke } from "./hosted-sandbox-smoke.js";

describe("production sandbox smoke", () => {
  test("covers no-spend production sandbox foundation boundaries", async () => {
    const report = await runHostedSandboxSmoke();

    expect(report.readiness.default.ok).toBe(true);
    expect(report.readiness.default.realExecutionMode).toBe("disabled");
    expect(report.readiness.enabledWithoutPolicy.ok).toBe(false);
    expect(report.readiness.enabledWithoutPolicy.code).toBe("sandbox_policy_missing");

    expect(report.process.status).toBe("completed");
    expect(report.pty.status).toBe("completed");
    expect(report.pty.transcriptContainsEcho).toBe(true);
    expect(report.deniedDisabled.reasonCode).toBe("sandbox_real_execution_disabled");

    expect(report.timeout.status).toBe("timeout");
    expect(report.timeout.reasonCode).toBe("sandbox_timeout");
    expect(report.cancel.initialStatus).toBe("cancelled");
    expect(report.cancel.idempotentStatus).toBe("cancelled");
    expect(report.cancel.pendingStatus).toBe("cancelled");

    expect(report.outputLimit.reasonCode).toBe("sandbox_output_limit_exceeded");
    expect(report.artifact.status).toBe("completed");
    expect(report.artifact.artifactCount).toBeGreaterThan(0);

    expect(report.redaction.transcriptContainsSecret).toBe(false);
    expect(report.redaction.transcriptContainsBearer).toBe(false);
    expect(report.redaction.transcriptContainsRedactionMarker).toBe(true);

    expect(report.boundaries.localForbiddenPathPresent).toBe(false);
    expect(report.boundaries.hostedForbiddenPathPresent).toBe(false);
  });
});
