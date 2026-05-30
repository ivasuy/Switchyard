import Fastify from "fastify";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import {
  EventBus,
  HostedRunService,
  HostedWorkerService,
  HOSTED_RUNTIME_CATALOG,
  PlacementService,
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

async function main(): Promise<void> {
  const enabled = await createHarness({ gate: "enabled" });
  const disabled = await createHarness({ gate: "disabled" });

  try {
    await runHappyRuntime(enabled, {
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      runtimeMode: "codex.exec_json"
    });

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
    await verifyUnsupportedInteractionFails(enabled);
    await verifyArtifactContent(enabled);

    process.stdout.write("hosted-real-runtime:smoke OK\n");
  } finally {
    await enabled.app.close();
    await disabled.app.close();
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
      cwd: "/repo",
      task: `smoke-${input.runtimeMode}`,
      placement: "hosted"
    }
  });
  assert(response.statusCode === 202, `hosted_real_runtime_smoke_${input.runtimeMode}_create_failed:${response.statusCode}`);

  const runId = response.json().run.id as string;
  const processed = await harness.worker.processNext();
  assert(processed === true, `hosted_real_runtime_smoke_${input.runtimeMode}_worker_idle`);

  const runAfter = await harness.runs.get(runId);
  assert(runAfter?.status === "completed", `hosted_real_runtime_smoke_${input.runtimeMode}_not_completed`);
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
      cwd: "/repo",
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

async function verifyUnsupportedInteractionFails(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  const response = await harness.app.inject({
    method: "POST",
    url: "/runs",
    payload: {
      runtime: "opencode",
      provider: "opencode",
      model: "opencode-default",
      adapterType: "acpx",
      runtimeMode: "opencode.acp",
      cwd: "/repo",
      task: "permission-request",
      placement: "hosted"
    }
  });
  assert(response.statusCode === 202, `hosted_real_runtime_smoke_unsupported_create_failed:${response.statusCode}`);

  const runId = response.json().run.id as string;
  await harness.permissionWorker.processNext();

  const run = await harness.runs.get(runId);
  if (!run || run.status === "waiting_for_input" || run.status === "waiting_for_approval") {
    throw new Error("hosted_real_runtime_smoke_waiting_state_leak");
  }
  assert(run.status === "failed", `hosted_real_runtime_smoke_unsupported_not_failed:${run.status}`);
}

async function verifyArtifactContent(harness: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  const runsResponse = await harness.app.inject({ method: "GET", url: "/runs?runtime=codex&placement=hosted" });
  const codexRun = runsResponse.json().runs[0];
  assert(Boolean(codexRun?.id), "hosted_real_runtime_smoke_artifact_failed:codex.exec_json");

  const artifactsResponse = await harness.app.inject({ method: "GET", url: `/runs/${codexRun.id}/artifacts` });
  const artifacts = artifactsResponse.json().artifacts as Array<{ id: string }>;
  assert(artifacts.length > 0, "hosted_real_runtime_smoke_artifact_failed:codex.exec_json");

  const content = await harness.app.inject({ method: "GET", url: `/artifacts/${artifacts[0]?.id}/content` });
  const body = content.body;
  if (content.statusCode !== 200 || !body || body.length === 0) {
    throw new Error("hosted_real_runtime_smoke_artifact_failed:codex.exec_json");
  }
}

async function createHarness(input: { gate: "enabled" | "disabled" }) {
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
    hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json", "claude_code.sdk", "opencode.acp"],
    deploymentMode: "staging",
    hostedRealRuntimeExecution: input.gate,
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
    deploymentMode: "staging",
    hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json", "claude_code.sdk", "opencode.acp"],
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
    deploymentMode: "staging",
    hostedRealRuntimeExecution: input.gate
  });

  const permissionAdapters = buildHostedWorkerAdapters({
    deploymentMode: "staging",
    hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json", "claude_code.sdk", "opencode.acp"],
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
    hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json", "claude_code.sdk", "opencode.acp"],
    deploymentMode: "staging",
    hostedRealRuntimeExecution: input.gate
  });

  return {
    app,
    runs,
    queue,
    worker,
    permissionWorker
  };
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
