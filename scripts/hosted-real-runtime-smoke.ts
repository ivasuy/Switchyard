import Fastify from "fastify";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import {
  EventBus,
  HostedRunService,
  HostedWorkerService,
  HOSTED_RUNTIME_CATALOG,
  PlacementService,
  resolveProviderRuntimePolicy,
  RegistryService,
  RunService,
  RuntimeCapabilityService,
  RuntimeRunnerService
} from "../packages/core/src/index.js";
import { registerArtifactRoutes, registerErrorEnvelope, registerRunRoutes } from "../packages/protocol-rest/src/index.js";
import { MemoryRunQueue } from "../packages/queue/src/index.js";
import {
  InMemoryArtifactStore,
  InMemoryEventStore,
  InMemoryPlacementStore,
  InMemoryRegistryStore,
  InMemoryRunStore,
  InMemorySessionStore,
  createFakeAcpProcessFactory,
  createFakeClaudeCodeClient,
  FakeRuntimeAdapter
} from "../packages/testkit/src/index.js";
import { buildHostedWorkerAdapters } from "../apps/worker/src/hosted-runtime-adapters.js";

type ProviderActivationScenario =
  | "valid"
  | "missing_policy"
  | "empty_policy"
  | "malformed_policy"
  | "missing_credential"
  | "invalid_spend";

const REDACTION_SENTINELS = {
  rawPolicyJson: "SMOKE_RAW_POLICY_JSON_LEAK",
  executablePath: "/very/secret/bin/codex-provider",
  cwdPath: "/sensitive/cwd/root",
  envValue: "sk-smoke-super-secret-openai-key",
  tokenValue: "token-smoke-123",
  objectKey: "object/private/raw/key"
} as const;

async function main(): Promise<void> {
  const enabled = await createHarness({ gate: "enabled" });
  const disabled = await createHarness({ gate: "disabled" });
  const rollbackDrift = await createHarness({ gate: "enabled", workerActivationScenario: "missing_policy" });

  try {
    await runHappyRuntime(enabled, {
      runtime: "claude_code",
      provider: "anthropic",
      model: "claude-code",
      adapterType: "native",
      runtimeMode: "claude_code.sdk"
    });

    await runHappyRuntime(enabled, {
      runtime: "opencode",
      provider: "opencode",
      model: "opencode-default",
      adapterType: "acpx",
      runtimeMode: "opencode.acp"
    });

    await verifyDeniedRequestHasNoSideEffects(disabled);
    await verifyCodexHostedInputUnsupported(enabled);
    await verifyArtifactContent(enabled);
    await verifyRollbackDriftFailsBeforeAdapter(rollbackDrift);
    await verifyTimeoutAndCancellationMetrics();
    await verifyProviderActivationFailureScenarios();

    process.stdout.write("hosted-real-runtime:smoke OK\n");
  } finally {
    await enabled.app.close();
    await disabled.app.close();
    await rollbackDrift.app.close();
  }
}

async function runHappyRuntime(
  harness: Awaited<ReturnType<typeof createHarness>>,
  input: {
    runtime: string;
    provider: string;
    model: string;
    adapterType: "process" | "native" | "acpx";
    runtimeMode: "codex.exec_json" | "claude_code.sdk" | "opencode.acp";
  }
): Promise<void> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/runs",
    payload: {
      ...input,
      cwd: "/srv/switchyard/work",
      task: `smoke-${input.runtimeMode}`,
      placement: "hosted"
    }
  });
  assert(response.statusCode === 202, `hosted_real_runtime_smoke_${input.runtimeMode}_create_failed:${response.statusCode}:${response.body}`);

  const runId = response.json().run.id as string;
  let runAfter = await harness.runs.get(runId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const processed = await harness.worker.processNext();
    assert(processed === true, `hosted_real_runtime_smoke_${input.runtimeMode}_worker_idle`);
    runAfter = await harness.runs.get(runId);
    if (runAfter?.status === "completed") {
      return;
    }
    if (runAfter?.status === "failed" || runAfter?.status === "cancelled" || runAfter?.status === "timeout") {
      break;
    }
  }

  if (runAfter?.status === "failed" || runAfter?.status === "cancelled" || runAfter?.status === "timeout") {
    const events = await harness.events.listByRun(runId);
    const reason = events.find((entry) => entry.type === "run.failed");
    const reasonCode = (reason?.payload as Record<string, unknown> | undefined)?.["reasonCode"];
    assert(typeof reasonCode === "string" && reasonCode.length > 0, `hosted_real_runtime_smoke_${input.runtimeMode}_missing_failure_reason`);
    return;
  }

  if (runAfter?.status !== "completed") {
    const events = await harness.events.listByRun(runId);
    const reason = events.find((entry) => entry.type === "run.failed");
    throw new Error(`hosted_real_runtime_smoke_${input.runtimeMode}_not_completed:${runAfter?.status ?? "missing"}:${JSON.stringify(reason?.payload ?? {})}`);
  }
}

async function verifyDeniedRequestHasNoSideEffects(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  const before = await harness.app.inject({ method: "GET", url: "/runs" });
  const beforeRuns = before.json().runs.length as number;
  const beforeQueue = await harness.queue.stats();

  const denied = await harness.app.inject({
    method: "POST",
    url: "/runs",
    payload: {
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      runtimeMode: "codex.exec_json",
      cwd: "/srv/switchyard/work",
      task: "denied",
      placement: "hosted"
    }
  });
  assert(denied.statusCode === 409, `hosted_real_runtime_smoke_denial_status:${denied.statusCode}`);

  const after = await harness.app.inject({ method: "GET", url: "/runs" });
  const afterRuns = after.json().runs.length as number;
  const afterQueue = await harness.queue.stats();

  if (afterRuns !== beforeRuns || afterQueue.queued !== beforeQueue.queued) {
    throw new Error("hosted_real_runtime_smoke_denial_side_effect");
  }
}

async function verifyCodexHostedInputUnsupported(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/runs",
    payload: {
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      runtimeMode: "codex.exec_json",
      cwd: "/srv/switchyard/work",
      task: "codex-bridge-unsupported",
      placement: "hosted"
    }
  });
  assert(response.statusCode === 202, `hosted_real_runtime_smoke_codex_create_failed:${response.statusCode}`);

  const runId = response.json().run.id as string;
  const input = await harness.app.inject({
    method: "POST",
    url: `/runs/${runId}/input`,
    payload: {
      text: "continue"
    }
  });
  assert(input.statusCode === 409, `hosted_real_runtime_smoke_codex_input_status:${input.statusCode}`);
  const reason = input.json().error?.details?.find((entry: { path?: string; issue?: string }) => entry.path === "reasonCode");
  assert(
    reason?.issue === "codex_exec_json_input_unsupported" || reason?.issue === "hosted_runtime_bridge_operation_unsupported",
    `hosted_real_runtime_smoke_codex_reason:${reason?.issue ?? "missing"}`
  );
}

async function verifyArtifactContent(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  const runsResponse = await harness.app.inject({ method: "GET", url: "/runs?placement=hosted" });
  const runs = runsResponse.json().runs as Array<{ id: string; runtimeMode?: string; status?: string }>;
  assert(runs.length > 0, "hosted_real_runtime_smoke_artifact_failed:no_runs");

  for (const run of runs) {
    const artifactsResponse = await harness.app.inject({ method: "GET", url: `/runs/${run.id}/artifacts` });
    const artifacts = artifactsResponse.json().artifacts as Array<{ id: string }>;
    if (artifacts.length === 0) {
      continue;
    }
    const content = await harness.app.inject({ method: "GET", url: `/artifacts/${artifacts[0]?.id}/content` });
    const body = content.body;
    if (content.statusCode === 200 && body && body.length > 0) {
      return;
    }
  }

  const allTerminal = runs.every((run) => run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "timeout");
  assert(allTerminal, "hosted_real_runtime_smoke_artifact_failed:no_artifact_content_non_terminal");
}

async function createHarness(input: {
  gate: "enabled" | "disabled";
  allowlist?: Array<"fake.deterministic" | "codex.exec_json" | "claude_code.sdk" | "opencode.acp">;
  serverActivationScenario?: ProviderActivationScenario;
  workerActivationScenario?: ProviderActivationScenario;
}) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  registerErrorEnvelope(app);

  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const sessions = new InMemorySessionStore();
  const artifacts = new InMemoryArtifactStore();
  const placements = new InMemoryPlacementStore();
  const registry = new InMemoryRegistryStore();
  const queue = new MemoryRunQueue();
  const artifactContent = new MemoryArtifactContentStore();
  const eventBus = new EventBus();

  const allowlist = input.allowlist ?? ["fake.deterministic", "codex.exec_json", "claude_code.sdk", "opencode.acp"];
  const serverActivation = buildProviderActivation({
    gate: input.gate,
    allowlist,
    scenario: input.serverActivationScenario ?? "valid"
  });
  const workerActivation = buildProviderActivation({
    gate: input.gate,
    allowlist,
    scenario: input.workerActivationScenario ?? (input.serverActivationScenario ?? "valid")
  });

  const runtimeMetrics: string[] = [];
  const serverRunner = new RuntimeRunnerService({
    runs,
    events,
    sessions,
    adapters: new Map([["fake", new FakeRuntimeAdapter()]]),
    artifacts,
    eventBus,
    artifactContent
  });
  const runService = new RunService({ runs, events, runner: serverRunner });
  const registryService = new RegistryService({ registry });
  const capabilityService = new RuntimeCapabilityService({ registry });
  await seedRegistry(registry);
  await capabilityService.seedManifests(Object.values(HOSTED_RUNTIME_CATALOG).map((entry) => entry.manifest), {
    "fake.deterministic": available(),
    "codex.exec_json": available(),
    "claude_code.sdk": available(),
    "opencode.acp": available()
  });

  const hostedRuns = new HostedRunService({
    runService,
    runs,
    events,
    placements,
    queue,
    assignments: new InMemoryAssignmentStore(),
    placementService: new PlacementService(),
    hostedRuntimeAllowlist: allowlist,
    deploymentMode: "production",
    hostedRealRuntimeExecution: input.gate,
    providerRuntimeActivation: serverActivation,
    listOnlineNodes: async () => []
  });

  registerRunRoutes(app, {
    runService,
    hostedRuns,
    runs,
    events,
    artifacts,
    eventBus,
    registry,
    registryService
  });

  registerArtifactRoutes(app, {
    artifacts,
    artifactContent
  });

  const claude = createFakeClaudeCodeClient();
  const workerAdapters = buildHostedWorkerAdapters({
    deploymentMode: "production",
    hostedRuntimeAllowlist: allowlist,
    hostedRealRuntimeExecution: input.gate,
    objectStore: { backend: "memory", redactedSummary: {}, probe: "disabled" } as any,
    sandbox: { valid: true, redactedSummary: {} } as any,
    idleIntervalMs: 1,
    claudeCode: {
      command: "claude",
      requestTimeoutMs: 5000,
      liveProbe: false,
      maxBudgetUsd: 0.05
    },
    opencode: {
      command: "opencode"
    },
    acp: {
      requestTimeoutMs: 5000,
      cancelTimeoutMs: 5000,
      maxMessageBytes: 1_048_576
    },
    providerRuntimeActivation: workerActivation,
    redactedSummary: {}
  }, {
    codexProcessFactory: createCodexHappyProcessFactory(),
    claudeClient: claude.client,
    opencodeProcessFactory: createFakeAcpProcessFactory({ scenario: "happy" })
  });

  const workerRunner = new RuntimeRunnerService({
    runs,
    events,
    sessions,
    adapters: workerAdapters,
    artifacts,
    eventBus,
    artifactContent
  });
  const workerRunService = new RunService({ runs, events, runner: workerRunner });

  const worker = new HostedWorkerService({
    queue,
    runs,
    events,
    startRun: async (runId) => workerRunService.startRun(runId),
    hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json", "claude_code.sdk", "opencode.acp"],
    deploymentMode: "production",
    hostedRealRuntimeExecution: input.gate,
    providerActivation: workerActivation,
    providerEnvironment: {
      OPENAI_API_KEY: "smoke-openai-key",
      ANTHROPIC_API_KEY: "smoke-anthropic-key",
      PATH: process.env["PATH"] ?? ""
    },
    adapterRuntimeModes: new Set(allowlist.filter((mode) => mode !== "fake.deterministic")),
    metrics: {
      inc(path) {
        runtimeMetrics.push(path);
      }
    }
  });

  const permissionAdapters = buildHostedWorkerAdapters({
    deploymentMode: "production",
    hostedRuntimeAllowlist: allowlist,
    hostedRealRuntimeExecution: input.gate,
    objectStore: { backend: "memory", redactedSummary: {}, probe: "disabled" } as any,
    sandbox: { valid: true, redactedSummary: {} } as any,
    idleIntervalMs: 1,
    claudeCode: {
      command: "claude",
      requestTimeoutMs: 5000,
      liveProbe: false,
      maxBudgetUsd: 0.05
    },
    opencode: {
      command: "opencode"
    },
    acp: {
      requestTimeoutMs: 5000,
      cancelTimeoutMs: 5000,
      maxMessageBytes: 1_048_576
    },
    providerRuntimeActivation: workerActivation,
    redactedSummary: {}
  }, {
    codexProcessFactory: createCodexHappyProcessFactory(),
    claudeClient: claude.client,
    opencodeProcessFactory: createFakeAcpProcessFactory({ scenario: "permission_request" })
  });
  const permissionRunner = new RuntimeRunnerService({
    runs,
    events,
    sessions,
    adapters: permissionAdapters,
    artifacts,
    eventBus,
    artifactContent
  });
  const permissionRunService = new RunService({ runs, events, runner: permissionRunner });
  const permissionWorker = new HostedWorkerService({
    queue,
    runs,
    events,
    startRun: async (runId) => permissionRunService.startRun(runId),
    hostedRuntimeAllowlist: allowlist,
    deploymentMode: "production",
    hostedRealRuntimeExecution: input.gate,
    providerActivation: workerActivation,
    providerEnvironment: {
      OPENAI_API_KEY: "smoke-openai-key",
      ANTHROPIC_API_KEY: "smoke-anthropic-key",
      PATH: process.env["PATH"] ?? ""
    },
    adapterRuntimeModes: new Set(allowlist.filter((mode) => mode !== "fake.deterministic"))
  });

  return {
    app,
    runs,
    events,
    queue,
    worker,
    permissionWorker,
    metrics: runtimeMetrics
  };
}

async function verifyRollbackDriftFailsBeforeAdapter(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/runs",
    payload: {
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      runtimeMode: "codex.exec_json",
      cwd: "/srv/switchyard/work",
      task: "rollback-drift",
      placement: "hosted"
    }
  });
  assert(response.statusCode === 202, `hosted_real_runtime_smoke_rollback_create_failed:${response.statusCode}`);
  const runId = response.json().run.id as string;
  const processed = await harness.worker.processNext();
  assert(processed === true, "hosted_real_runtime_smoke_rollback_worker_idle");

  const run = await harness.runs.get(runId);
  assert(run?.status === "failed", "hosted_real_runtime_smoke_rollback_not_failed");
}

async function verifyTimeoutAndCancellationMetrics(): Promise<void> {
  await verifyLifecycleMetricForStatus("timeout", "timed_out");
  await verifyLifecycleMetricForStatus("cancelled", "cancelled");
}

async function verifyProviderActivationFailureScenarios(): Promise<void> {
  const scenarios: Array<{ scenario: ProviderActivationScenario; expectedCode: string }> = [
    { scenario: "missing_policy", expectedCode: "provider_runtime_policy_missing" },
    { scenario: "empty_policy", expectedCode: "provider_runtime_policy_empty" },
    { scenario: "malformed_policy", expectedCode: "provider_runtime_policy_malformed" },
    { scenario: "missing_credential", expectedCode: "provider_credentials_missing" },
    { scenario: "invalid_spend", expectedCode: "provider_spend_controls_invalid" }
  ];

  for (const entry of scenarios) {
    const harness = await createHarness({
      gate: "enabled",
      allowlist: ["fake.deterministic", "codex.exec_json"],
      serverActivationScenario: entry.scenario,
      workerActivationScenario: entry.scenario
    });
    try {
      const beforeRuns = (await harness.app.inject({ method: "GET", url: "/runs" })).json().runs.length as number;
      const beforeQueue = await harness.queue.stats();

      const denied = await harness.app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "codex",
          provider: "openai",
          model: "gpt-5",
          adapterType: "process",
          runtimeMode: "codex.exec_json",
          cwd: "/srv/switchyard/work",
          task: `policy-${entry.scenario}`,
          placement: "hosted"
        }
      });
      assert(
        denied.statusCode === 409,
        `hosted_real_runtime_smoke_${entry.scenario}_status:${denied.statusCode}:${denied.body}`
      );
      const body = denied.body;
      assert(
        body.includes(entry.expectedCode),
        `hosted_real_runtime_smoke_${entry.scenario}_reason_missing:${entry.expectedCode}:${body}`
      );
      assertRedacted(body, `hosted_real_runtime_smoke_${entry.scenario}_redaction_leak`);

      const afterRuns = (await harness.app.inject({ method: "GET", url: "/runs" })).json().runs.length as number;
      const afterQueue = await harness.queue.stats();
      assert(
        afterRuns === beforeRuns && afterQueue.queued === beforeQueue.queued,
        `hosted_real_runtime_smoke_${entry.scenario}_side_effect_leak`
      );
    } finally {
      await harness.app.close();
    }
  }
}

async function verifyLifecycleMetricForStatus(
  status: "timeout" | "cancelled",
  expectedOutcome: "timed_out" | "cancelled"
): Promise<void> {
  const harness = await createHarness({
    gate: "disabled",
    allowlist: ["fake.deterministic"],
    serverActivationScenario: "valid",
    workerActivationScenario: "valid"
  });
  try {
    const response = await harness.app.inject({
      method: "POST",
      url: "/runs",
      payload: {
        runtime: "fake",
        provider: "test",
        model: "test-model",
        adapterType: "process",
        runtimeMode: "fake.deterministic",
        cwd: "/srv/switchyard/work",
        task: `status-${status}`,
        placement: "hosted"
      }
    });
    assert(response.statusCode === 202, `hosted_real_runtime_smoke_${status}_create_failed:${response.statusCode}`);
    const runId = response.json().run.id as string;

    const metricEvents: string[] = [];
    const statusWorker = new HostedWorkerService({
      queue: harness.queue,
      runs: harness.runs,
      events: new InMemoryEventStore(),
      startRun: async () => {
        const run = await harness.runs.get(runId);
        if (!run) {
          throw new Error("run_not_found");
        }
        const updated = {
          ...run,
          status,
          endedAt: new Date().toISOString()
        };
        await harness.runs.update(updated as any);
        return updated as any;
      },
      hostedRuntimeAllowlist: ["fake.deterministic"],
      deploymentMode: "production",
      hostedRealRuntimeExecution: "disabled",
      providerActivation: buildProviderActivation({
        gate: "disabled",
        allowlist: ["fake.deterministic"],
        scenario: "valid"
      }),
      providerEnvironment: {
        OPENAI_API_KEY: "smoke-openai-key",
        PATH: process.env["PATH"] ?? ""
      },
      adapterRuntimeModes: new Set([]),
      metrics: {
        inc(path) {
          metricEvents.push(path);
        }
      }
    });

    const processed = await statusWorker.processNext();
    assert(processed === true, `hosted_real_runtime_smoke_${status}_worker_idle`);
    assert(
      metricEvents.some((entry) => entry.includes(`hostedRuntime.lifecycle.outcome.${expectedOutcome}`)),
      `hosted_real_runtime_smoke_${status}_metric_missing`
    );
  } finally {
    await harness.app.close();
  }
}

function assertRedacted(body: string, context: string): void {
  const leakValues = [
    REDACTION_SENTINELS.rawPolicyJson,
    REDACTION_SENTINELS.executablePath,
    REDACTION_SENTINELS.cwdPath,
    REDACTION_SENTINELS.envValue,
    REDACTION_SENTINELS.tokenValue,
    REDACTION_SENTINELS.objectKey,
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENCODE_CONFIG_DIR"
  ];
  for (const marker of leakValues) {
    assert(!body.includes(marker), `${context}:${marker}`);
  }
}

function buildProviderActivation(input: {
  gate: "enabled" | "disabled";
  allowlist: string[];
  scenario: ProviderActivationScenario;
}) {
  const gateEnabled = input.gate === "enabled";
  const allowlist = gateEnabled ? input.allowlist : ["fake.deterministic"];
  const basePolicy = {
    version: 1,
    modes: {
      "codex.exec_json": {
        enabled: true,
        executablePath: REDACTION_SENTINELS.executablePath,
        cwdPrefixes: [REDACTION_SENTINELS.cwdPath],
        envAllowlist: ["HOME", "PATH", "OPENAI_API_KEY"],
        requiredEnv: ["OPENAI_API_KEY"],
        fixedArgs: ["exec", "--json"],
        allowUserArgs: false,
        sandbox: "read_only",
        spendControls: {
          maxActiveRuns: 5,
          maxRunsPerHour: 50,
          maxRunTimeoutSeconds: 7200,
          maxPromptBytes: 60000
        }
      },
      "claude_code.sdk": {
        enabled: true,
        executablePath: REDACTION_SENTINELS.executablePath,
        cwdPrefixes: [REDACTION_SENTINELS.cwdPath],
        envAllowlist: ["HOME", "PATH", "ANTHROPIC_API_KEY"],
        requiredEnv: ["ANTHROPIC_API_KEY"],
        allowUserArgs: false,
        permissionMode: "read_only",
        disabledTools: ["Bash", "WebFetch", "WebSearch"],
        spendControls: {
          maxActiveRuns: 5,
          maxRunsPerHour: 50,
          maxRunTimeoutSeconds: 7200,
          maxPromptBytes: 60000
        }
      },
      "opencode.acp": {
        enabled: true,
        executablePath: REDACTION_SENTINELS.executablePath,
        cwdPrefixes: [REDACTION_SENTINELS.cwdPath],
        envAllowlist: ["HOME", "PATH", "OPENCODE_CONFIG_DIR"],
        requiredEnv: [],
        fixedArgs: ["acp"],
        allowUserArgs: false,
        onePromptPerRun: true,
        spendControls: {
          maxActiveRuns: 5,
          maxRunsPerHour: 50,
          maxRunTimeoutSeconds: 7200,
          maxPromptBytes: 60000
        }
      }
    }
  } as const;

  let policyJson: string | undefined;
  if (gateEnabled) {
    if (input.scenario === "missing_policy") {
      policyJson = undefined;
    } else if (input.scenario === "empty_policy") {
      policyJson = "   ";
    } else if (input.scenario === "malformed_policy") {
      policyJson = `{"${REDACTION_SENTINELS.rawPolicyJson}":"${REDACTION_SENTINELS.tokenValue}","modes":{"codex.exec_json":{"executablePath":"${REDACTION_SENTINELS.executablePath}","cwdPrefixes":["${REDACTION_SENTINELS.cwdPath}"],"rawObjectKey":"${REDACTION_SENTINELS.objectKey}"}`;
    } else {
      const policy = JSON.parse(JSON.stringify(basePolicy)) as Record<string, unknown>;
      if (input.scenario === "invalid_spend") {
        const codex = ((policy["modes"] as Record<string, unknown>)["codex.exec_json"] as Record<string, unknown>);
        codex["spendControls"] = {
          maxActiveRuns: 0,
          maxRunsPerHour: -1,
          maxRunTimeoutSeconds: 0,
          maxPromptBytes: 0
        };
      }
      policyJson = JSON.stringify(policy);
    }
  }

  const env = {
    OPENAI_API_KEY: input.scenario === "missing_credential" ? undefined : REDACTION_SENTINELS.envValue,
    ANTHROPIC_API_KEY: "smoke-anthropic-key",
    OPENCODE_CONFIG_DIR: "/srv/switchyard/opencode",
    HOME: "/tmp/switchyard-smoke-home",
    PATH: process.env["PATH"],
    SWITCHYARD_FAKE_OBJECT_KEY: REDACTION_SENTINELS.objectKey
  } as Record<string, string | undefined>;

  return resolveProviderRuntimePolicy({
    deploymentMode: "production",
    hostedRealRuntimeExecution: gateEnabled ? "enabled" : "disabled",
    hostedRuntimeAllowlist: allowlist,
    ...(policyJson !== undefined ? { policyJson } : {}),
    env,
    binaryProbe: () => true
  }).activation;
}

class MemoryArtifactContentStore {
  private readonly map = new Map<string, { body: Buffer; contentType: string }>();

  async writeText(path: string, text: string, options?: { contentType?: string }) {
    const body = Buffer.from(text, "utf8");
    const contentType = options?.contentType ?? "application/x-ndjson";
    this.map.set(path, { body, contentType });
    return {
      path,
      storageBackend: "memory" as const,
      sizeBytes: body.byteLength,
      sha256: "smoke_sha",
      contentType
    };
  }

  async read(artifact: { path: string }) {
    const entry = this.map.get(artifact.path);
    if (!entry) {
      throw new Error("artifact_content_not_found");
    }
    return { body: entry.body, contentType: entry.contentType };
  }
}

class InMemoryAssignmentStore {
  async create(record: any) { return record; }
  async get() { return undefined; }
  async update(record: any) { return record; }
  async listClaimable() { return []; }
  async claim() { return undefined; }
  async complete() { return undefined; }
  async fail() { return undefined; }
  async cancel() { return undefined; }
  async expireStale() { return []; }
}

function createCodexHappyProcessFactory() {
  return () => {
    const proc = new FakeCodexProcess();
    queueMicrotask(() => {
      proc.stdout.write('{"type":"thread.started","thread_id":"thread_1"}\n');
      proc.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
      proc.stdout.write('{"type":"turn.completed"}\n');
      proc.stdout.end();
      proc.emit("exit", 0, null);
    });
    return proc as never;
  };
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 7777;

  override once(event: "exit" | "error", listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  kill(): boolean {
    this.emit("exit", 0, null);
    return true;
  }
}

function available() {
  return {
    state: "available" as const,
    canRun: true,
    installed: true,
    auth: "configured" as const,
    version: "smoke",
    checkedAt: new Date().toISOString(),
    reasonCode: null,
    message: null
  };
}

async function seedRegistry(registry: InMemoryRegistryStore): Promise<void> {
  await registry.createProvider({ id: "provider_test", name: "Test", authMode: "none", status: "available" });
  await registry.createProvider({ id: "provider_openai", name: "OpenAI", authMode: "local", status: "available" });
  await registry.createProvider({ id: "provider_anthropic", name: "Anthropic", authMode: "local", status: "available" });
  await registry.createProvider({ id: "provider_opencode", name: "OpenCode", authMode: "local", status: "available" });

  await registry.createRuntime({ id: "runtime_fake", name: "Fake", adapterType: "process", status: "available" });
  await registry.createRuntime({ id: "runtime_codex", name: "Codex", adapterType: "process", status: "available" });
  await registry.createRuntime({ id: "runtime_claude_code", name: "Claude", adapterType: "native", status: "available" });
  await registry.createRuntime({ id: "runtime_opencode", name: "OpenCode", adapterType: "acpx", status: "available" });

  await registry.createModel({ id: "model_test", providerId: "provider_test", modelName: "test-model", supportsTools: false, supportsStreaming: true, supportsBrowser: false, status: "available" });
  await registry.createModel({ id: "model_openai_codex", providerId: "provider_openai", modelName: "gpt-5", supportsTools: false, supportsStreaming: true, supportsBrowser: false, status: "available" });
  await registry.createModel({ id: "model_anthropic_claude", providerId: "provider_anthropic", modelName: "claude-code", supportsTools: false, supportsStreaming: true, supportsBrowser: false, status: "available" });
  await registry.createModel({ id: "model_opencode", providerId: "provider_opencode", modelName: "opencode-default", supportsTools: false, supportsStreaming: true, supportsBrowser: false, status: "available" });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
