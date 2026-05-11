import type { Run } from "@switchyard/contracts";

export function createFixtureRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_fixture",
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "Fixture task",
    status: "queued",
    placement: "local",
    approvalPolicy: "default",
    timeoutSeconds: 60,
    metadata: {},
    createdAt: "2026-05-11T00:00:00.000Z",
    ...overrides
  };
}
