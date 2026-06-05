import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeActivationResult } from "../src/services/provider-runtime-policy.js";
import { HostedRunService } from "../src/services/hosted-run-service.js";
import { PlacementService } from "../src/services/placement-service.js";

const facts = {
  local: { support: "supported", reason: "ok" },
  hosted: { support: "supported", reason: "ok" },
  connectedLocalNode: { support: "future", reason: "unused" }
} as const;

describe("HostedRunService provider admission preflight", () => {
  it("denies implicit hosted real placement before durable side effects", async () => {
    const harness = createHarness();

    await expect(harness.service.createRun(createInput({
      placement: "local",
      runtime: "codex",
      provider: "openai",
      runtimeMode: "codex.exec_json"
    }))).rejects.toMatchObject({ code: "placement_denied", message: "hosted_explicit_placement_required" });

    expect(harness.runCreate).not.toHaveBeenCalled();
    expect(harness.queueEnqueue).not.toHaveBeenCalled();
    expect(harness.placementCreate).not.toHaveBeenCalled();
    expect(harness.recordHostedAdmission).toHaveBeenCalledWith({
      runtimeMode: "codex.exec_json",
      reason: "hosted_explicit_placement_required",
      outcome: "denied"
    });
  });

  it("denies wait=1 for hosted real modes before durable side effects", async () => {
    const harness = createHarness();

    await expect(harness.service.createRun(createInput({
      placement: "hosted",
      runtime: "codex",
      provider: "openai",
      runtimeMode: "codex.exec_json"
    }), { wait: true })).rejects.toMatchObject({ code: "placement_denied", message: "hosted_wait_unsupported" });

    expect(harness.runCreate).not.toHaveBeenCalled();
    expect(harness.queueEnqueue).not.toHaveBeenCalled();
    expect(harness.placementCreate).not.toHaveBeenCalled();
    expect(harness.recordHostedAdmission).toHaveBeenCalledWith({
      runtimeMode: "codex.exec_json",
      reason: "hosted_wait_unsupported",
      outcome: "denied"
    });
  });

  it("denies production hosted real runs when provider activation is invalid", async () => {
    const harness = createHarness({
      deploymentMode: "production",
      providerRuntimeActivation: {
        valid: false,
        enabledRealModes: [],
        reasons: [{ code: "provider_runtime_policy_missing", runtimeMode: "codex.exec_json" }],
        redactedSummary: {
          deploymentMode: "production",
          hostedRealRuntimeExecution: "enabled",
          realModeCount: 1,
          enabledRealModeCount: 0,
          source: { kind: "none" },
          modeStatuses: [{ runtimeMode: "codex.exec_json", ready: false, reasons: ["provider_runtime_policy_missing"] }],
          reasonCodes: ["provider_runtime_policy_missing"]
        }
      }
    });

    await expect(harness.service.createRun(createInput({
      placement: "hosted",
      runtime: "codex",
      provider: "openai",
      runtimeMode: "codex.exec_json"
    }))).rejects.toMatchObject({ code: "placement_denied", message: "provider_runtime_policy_missing" });

    expect(harness.runCreate).not.toHaveBeenCalled();
    expect(harness.queueEnqueue).not.toHaveBeenCalled();
    expect(harness.recordHostedAdmission).toHaveBeenCalledWith({
      runtimeMode: "codex.exec_json",
      reason: "provider_runtime_policy_missing",
      outcome: "denied"
    });
  });

  it("denies provider_prompt_too_large before durable side effects", async () => {
    const harness = createHarness({
      providerRuntimeActivation: activationWithSpend({ maxPromptBytes: 8, maxActiveRuns: 10, maxRunsPerHour: 10, maxRunTimeoutSeconds: 600 })
    });

    await expect(harness.service.createRun(createInput({
      placement: "hosted",
      runtime: "codex",
      provider: "openai",
      runtimeMode: "codex.exec_json",
      task: "this prompt is too large"
    }))).rejects.toMatchObject({ code: "placement_denied", message: "provider_prompt_too_large" });

    expect(harness.runCreate).not.toHaveBeenCalled();
    expect(harness.queueEnqueue).not.toHaveBeenCalled();
    expect(harness.recordHostedAdmission).toHaveBeenCalledWith({
      runtimeMode: "codex.exec_json",
      reason: "provider_prompt_too_large",
      outcome: "spend_control_denied"
    });
  });

  it("denies provider spend active/hourly/timeout limits before durable side effects", async () => {
    const sharedActivation = activationWithSpend({ maxPromptBytes: 1000, maxActiveRuns: 2, maxRunsPerHour: 4, maxRunTimeoutSeconds: 120 });
    const cases = [
      {
        name: "active",
        overrides: {
          countActiveRunsByRuntimeMode: async () => 2,
          countRunsInPastHourByRuntimeMode: async () => 0
        },
        input: createInput({ placement: "hosted", runtime: "codex", provider: "openai", runtimeMode: "codex.exec_json" })
      },
      {
        name: "hourly",
        overrides: {
          countActiveRunsByRuntimeMode: async () => 0,
          countRunsInPastHourByRuntimeMode: async () => 4
        },
        input: createInput({ placement: "hosted", runtime: "codex", provider: "openai", runtimeMode: "codex.exec_json" })
      },
      {
        name: "timeout",
        overrides: {
          countActiveRunsByRuntimeMode: async () => 0,
          countRunsInPastHourByRuntimeMode: async () => 0
        },
        input: createInput({ placement: "hosted", runtime: "codex", provider: "openai", runtimeMode: "codex.exec_json", timeoutSeconds: 121 })
      }
    ] as const;

    for (const testCase of cases) {
      const harness = createHarness({
        providerRuntimeActivation: sharedActivation,
        ...testCase.overrides
      });

      await expect(harness.service.createRun(testCase.input)).rejects.toMatchObject({
        code: "placement_denied",
        message: "provider_spend_limit_exceeded"
      });

      expect(harness.runCreate, testCase.name).not.toHaveBeenCalled();
      expect(harness.queueEnqueue, testCase.name).not.toHaveBeenCalled();
      expect(harness.placementCreate, testCase.name).not.toHaveBeenCalled();
      expect(harness.recordHostedAdmission, testCase.name).toHaveBeenCalledWith({
        runtimeMode: "codex.exec_json",
        reason: "provider_spend_limit_exceeded",
        outcome: "spend_control_denied"
      });
    }
  });

  it("allows hosted real provider runs when policy and spend controls pass", async () => {
    const harness = createHarness({
      providerRuntimeActivation: activationWithSpend({ maxPromptBytes: 1000, maxActiveRuns: 2, maxRunsPerHour: 4, maxRunTimeoutSeconds: 120 }),
      countActiveRunsByRuntimeMode: async () => 0,
      countRunsInPastHourByRuntimeMode: async () => 0
    });

    const created = await harness.service.createRun(createInput({
      placement: "hosted",
      runtime: "codex",
      provider: "openai",
      runtimeMode: "codex.exec_json",
      task: "tiny prompt"
    }));

    expect(created.run.id).toBe("run_created");
    expect(harness.runCreate).toHaveBeenCalledTimes(1);
    expect(harness.placementCreate).toHaveBeenCalledTimes(1);
    expect(harness.queueEnqueue).toHaveBeenCalledTimes(1);
    expect(harness.recordHostedAdmission).toHaveBeenCalledWith({
      runtimeMode: "codex.exec_json",
      reason: "admitted",
      outcome: "accepted"
    });
  });
});

function createInput(overrides: Partial<Parameters<HostedRunService["createRun"]>[0]>): Parameters<HostedRunService["createRun"]>[0] {
  return {
    runtime: "fake",
    provider: "test",
    model: "model",
    adapterType: "process",
    cwd: "/repo",
    task: "task",
    placement: "hosted",
    approvalPolicy: "default",
    timeoutSeconds: 60,
    metadata: {},
    runtimeMode: "fake.deterministic",
    placementFacts: facts,
    ...overrides
  };
}

function createHarness(overrides?: Partial<{
  deploymentMode: "local" | "test" | "staging" | "production";
  hostedRealRuntimeExecution: "enabled" | "disabled";
  providerRuntimeActivation: ProviderRuntimeActivationResult;
  countActiveRunsByRuntimeMode: (runtimeMode: string) => Promise<number>;
  countRunsInPastHourByRuntimeMode: (runtimeMode: string) => Promise<number>;
}>) {
  const runCreate = vi.fn(async (input: Record<string, unknown>) => ({
    id: "run_created",
    runtime: input.runtime,
    provider: input.provider,
    model: input.model,
    adapterType: input.adapterType,
    cwd: input.cwd,
    task: input.task,
    status: "queued",
    placement: input.placement,
    approvalPolicy: input.approvalPolicy,
    timeoutSeconds: input.timeoutSeconds,
    metadata: input.metadata,
    runtimeMode: input.runtimeMode,
    createdAt: "2026-05-31T00:00:00.000Z"
  }));
  const placementCreate = vi.fn(async (record: Record<string, unknown>) => record);
  const queueEnqueue = vi.fn(async () => ({ runId: "run_created", placement: "hosted", jobId: "job_1", createdAt: "2026-05-31T00:00:01.000Z" }));
  const recordHostedAdmission = vi.fn();

  const service = new HostedRunService({
    runService: {
      createRun: runCreate
    } as never,
    runs: {
      create: async (run: any) => run,
      get: async () => undefined,
      update: async (run: any) => run,
      list: async () => ({ runs: [], nextCursor: null })
    },
    events: {
      append: async (event: any) => event,
      listByRun: async () => [],
      listByDebate: async () => []
    },
    placements: {
      create: placementCreate,
      get: async () => undefined,
      update: async (record: any) => record,
      listByRun: async () => []
    },
    queue: {
      enqueue: queueEnqueue,
      claim: async () => undefined,
      ack: async () => {},
      fail: async () => {},
      retry: async () => {},
      discard: async () => {},
      getJob: async () => undefined,
      recoverStaleClaims: async () => ({ recovered: 0, exhausted: 0, invalid: 0, exhaustedClaims: [] }),
      stats: async () => ({ queued: 0, claimed: 0, failed: 0, exhausted: 0 })
    },
    assignments: {
      create: async (record: any) => record,
      get: async () => undefined,
      update: async (record: any) => record,
      listClaimable: async () => [],
      claim: async () => undefined,
      complete: async () => undefined,
      fail: async () => undefined,
      cancel: async () => undefined,
      expireStale: async () => []
    },
    placementService: new PlacementService(),
    hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
    deploymentMode: overrides?.deploymentMode ?? "production",
    hostedRealRuntimeExecution: overrides?.hostedRealRuntimeExecution ?? "enabled",
    providerRuntimeActivation: overrides?.providerRuntimeActivation
      ?? activationWithSpend({ maxPromptBytes: 1000, maxActiveRuns: 10, maxRunsPerHour: 10, maxRunTimeoutSeconds: 600 }),
    countActiveRunsByRuntimeMode: overrides?.countActiveRunsByRuntimeMode,
    countRunsInPastHourByRuntimeMode: overrides?.countRunsInPastHourByRuntimeMode,
    metrics: {
      inc: () => {},
      recordHostedAdmission
    },
    listOnlineNodes: async () => []
  });

  return { service, runCreate, placementCreate, queueEnqueue, recordHostedAdmission };
}

function activationWithSpend(spendControls: {
  maxActiveRuns: number;
  maxRunsPerHour: number;
  maxRunTimeoutSeconds: number;
  maxPromptBytes: number;
}): ProviderRuntimeActivationResult {
  return {
    valid: true,
    enabledRealModes: ["codex.exec_json"],
    reasons: [],
    redactedSummary: {
      deploymentMode: "production",
      hostedRealRuntimeExecution: "enabled",
      realModeCount: 1,
      enabledRealModeCount: 1,
      source: { kind: "json" },
      modeStatuses: [{ runtimeMode: "codex.exec_json", ready: true, reasons: [] }],
      reasonCodes: [],
      policyVersion: 1
    },
    policy: {
      version: 1,
      modes: {
        "codex.exec_json": {
          enabled: true,
          executablePath: "/usr/local/bin/codex",
          cwdPrefixes: ["/repo"],
          envAllowlist: ["OPENAI_API_KEY"],
          requiredEnv: [],
          allowUserArgs: false,
          fixedArgs: ["exec", "--json"],
          sandbox: "read_only",
          spendControls
        }
      }
    }
  };
}
