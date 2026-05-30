import { describe, expect, it } from "vitest";
import type {
  Artifact,
  Debate,
  EvidenceItem,
  RoutedMessage,
  Run,
  SwitchyardEvent
} from "@switchyard/contracts";
import { ContextBuilder } from "../src/services/context-builder.js";
import { DebateService } from "../src/services/debate-service.js";
import { EventBus } from "../src/services/event-bus.js";
import { MessageRouter } from "../src/services/message-router.js";
import type { ArtifactStore } from "../src/ports/artifact-store.js";
import type { DebateStore } from "../src/ports/debate-store.js";
import type { EventStore } from "../src/ports/event-store.js";
import type { EvidenceStore, ListEvidenceFilter, ListEvidenceResult } from "../src/ports/evidence-store.js";
import type { ListMessagesFilter, ListMessagesResult, MessageStore } from "../src/ports/message-store.js";
import type { RunStore } from "../src/ports/run-store.js";

function makeRun(id: string): Run {
  return {
    id,
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "task",
    status: "queued",
    placement: "local",
    approvalPolicy: "default",
    timeoutSeconds: 30,
    metadata: {},
    runtimeMode: "fake.deterministic",
    createdAt: "2026-05-30T00:00:00.000Z"
  };
}

class InMemoryDebateStore implements DebateStore {
  readonly items = new Map<string, Debate>();

  async create(value: Debate): Promise<Debate> {
    this.items.set(value.id, structuredClone(value));
    return value;
  }
  async get(id: string): Promise<Debate | undefined> {
    const value = this.items.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async update(value: Debate): Promise<Debate> {
    this.items.set(value.id, structuredClone(value));
    return value;
  }
}

class InMemoryRunStore implements RunStore {
  readonly items = new Map<string, Run>();

  async create(run: Run): Promise<Run> {
    this.items.set(run.id, structuredClone(run));
    return run;
  }
  async get(id: string): Promise<Run | undefined> {
    const value = this.items.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async update(run: Run): Promise<Run> {
    this.items.set(run.id, structuredClone(run));
    return run;
  }
  async list(): Promise<never> {
    throw new Error("unused");
  }
}

class InMemoryEventStore implements EventStore {
  readonly items: SwitchyardEvent[] = [];

  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> {
    this.items.push(structuredClone(event));
    return event;
  }
  async listByRun(runId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((event) => event.runId === runId).map((event) => structuredClone(event));
  }
  async listByDebate(debateId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((event) => event.debateId === debateId).map((event) => structuredClone(event));
  }
}

class InMemoryMessageStore implements MessageStore {
  readonly items = new Map<string, RoutedMessage>();

  async create(value: RoutedMessage): Promise<RoutedMessage> {
    this.items.set(value.id, structuredClone(value));
    return value;
  }
  async get(id: string): Promise<RoutedMessage | undefined> {
    const value = this.items.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async update(value: RoutedMessage): Promise<RoutedMessage> {
    this.items.set(value.id, structuredClone(value));
    return value;
  }
  async list(filter: ListMessagesFilter): Promise<ListMessagesResult> {
    const messages = [...this.items.values()].filter((item) => {
      if (filter.runId && item.fromRunId !== filter.runId && item.toRunId !== filter.runId) {
        return false;
      }
      if (filter.channel && item.channel !== filter.channel) {
        return false;
      }
      if (filter.deliveryStatus && item.deliveryStatus !== filter.deliveryStatus) {
        return false;
      }
      return true;
    });
    return { messages: messages.map((item) => structuredClone(item)), nextCursor: null };
  }
}

class InMemoryEvidenceStore implements EvidenceStore {
  readonly items = new Map<string, EvidenceItem>();

  async create(value: EvidenceItem): Promise<EvidenceItem> {
    this.items.set(value.id, structuredClone(value));
    return value;
  }
  async get(id: string): Promise<EvidenceItem | undefined> {
    const value = this.items.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async update(value: EvidenceItem): Promise<EvidenceItem> {
    this.items.set(value.id, structuredClone(value));
    return value;
  }
  async list(_filter: ListEvidenceFilter): Promise<ListEvidenceResult> {
    return { evidence: [...this.items.values()].map((item) => structuredClone(item)), nextCursor: null };
  }
}

class InMemoryArtifactStore implements ArtifactStore {
  readonly items = new Map<string, Artifact>();

  async create(value: Artifact): Promise<Artifact> {
    this.items.set(value.id, structuredClone(value));
    return value;
  }
  async get(id: string): Promise<Artifact | undefined> {
    const value = this.items.get(id);
    return value ? structuredClone(value) : undefined;
  }
  async update(value: Artifact): Promise<Artifact> {
    this.items.set(value.id, structuredClone(value));
    return value;
  }
  async listByRun(runId: string): Promise<Artifact[]> {
    return [...this.items.values()].filter((item) => item.runId === runId).map((item) => structuredClone(item));
  }
  async listByDebate(debateId: string): Promise<Artifact[]> {
    return [...this.items.values()].filter((item) => item.debateId === debateId).map((item) => structuredClone(item));
  }
}

class FakeRunService {
  constructor(
    protected readonly runs: InMemoryRunStore
  ) {}

  async createRun(input: {
    runtime: string;
    provider: string;
    model: string;
    adapterType: Run["adapterType"];
    cwd: string;
    task: string;
    placement: Run["placement"];
    approvalPolicy: string;
    timeoutSeconds: number;
    metadata: Record<string, unknown>;
    runtimeMode?: string;
  }): Promise<Run> {
    const run = makeRun(`run_${this.runs.items.size + 1}`);
    run.runtime = input.runtime;
    run.provider = input.provider;
    run.model = input.model;
    run.adapterType = input.adapterType;
    run.cwd = input.cwd;
    run.task = input.task;
    run.placement = input.placement;
    run.approvalPolicy = input.approvalPolicy;
    run.timeoutSeconds = input.timeoutSeconds;
    run.runtimeMode = input.runtimeMode;
    run.metadata = structuredClone(input.metadata);
    await this.runs.create(run);
    return run;
  }

  async startRun(runId: string): Promise<Run> {
    const run = await this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const completed: Run = {
      ...run,
      status: "completed",
      startedAt: "2026-05-30T00:00:01.000Z",
      endedAt: "2026-05-30T00:00:02.000Z"
    };
    await this.runs.update(completed);
    return completed;
  }
}

class FailingRunService extends FakeRunService {
  override async startRun(runId: string): Promise<Run> {
    const run = await this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const failed: Run = {
      ...run,
      status: "failed",
      startedAt: "2026-05-30T00:00:01.000Z",
      endedAt: "2026-05-30T00:00:02.000Z"
    };
    await this.runs.update(failed);
    return failed;
  }
}

class ThrowingMessageRouter {
  constructor(private readonly inner: MessageRouter) {}

  async createWithEvent(): Promise<never> {
    throw new Error("message router failure");
  }

  async get(id: string): Promise<RoutedMessage | undefined> {
    return this.inner.get(id);
  }
}

interface CreateHarnessOptions {
  runServiceFactory?: (runs: InMemoryRunStore) => Pick<ConstructorParameters<typeof DebateService>[0]["runService"], "createRun" | "startRun">;
  wrapMessageRouter?: (
    router: MessageRouter
  ) => Pick<ConstructorParameters<typeof DebateService>[0]["messageRouter"], "createWithEvent" | "get">;
  artifactContent?: { writeText(path: string, content: string): Promise<string> } | undefined;
}

function createHarness(options: CreateHarnessOptions = {}) {
  const debates = new InMemoryDebateStore();
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const messages = new InMemoryMessageStore();
  const evidence = new InMemoryEvidenceStore();
  const artifacts = new InMemoryArtifactStore();
  const eventBus = new EventBus();
  const baseMessageRouter = new MessageRouter({ runs, messages, events, eventBus });
  const messageRouter = options.wrapMessageRouter?.(baseMessageRouter) ?? baseMessageRouter;
  const contextBuilder = new ContextBuilder({ memory: { get: async () => undefined, create: async () => { throw new Error("unused"); }, update: async () => { throw new Error("unused"); }, list: async () => ({ memory: [], nextCursor: null }), search: async () => ({ memory: [], nextCursor: null }) }, evidence, messages });
  const runService = options.runServiceFactory?.(runs) ?? new FakeRunService(runs);
  const artifactWrites: Array<{ path: string; content: string }> = [];
  const defaultArtifactContent = {
    async writeText(path: string, content: string): Promise<string> {
      artifactWrites.push({ path, content });
      return path;
    }
  };
  const artifactContent = options.artifactContent ?? defaultArtifactContent;

  const serviceOptions: ConstructorParameters<typeof DebateService>[0] = {
    debates,
    runs,
    runService: runService as unknown as ConstructorParameters<typeof DebateService>[0]["runService"],
    contextBuilder,
    messageRouter: messageRouter as ConstructorParameters<typeof DebateService>[0]["messageRouter"],
    evidence,
    events,
    artifacts,
    eventBus,
    defaultCwd: "/repo"
  };
  if (artifactContent !== undefined) {
    serviceOptions.artifactContent = artifactContent;
  }
  const service = new DebateService(serviceOptions);

  return { service, debates, runs, events, messages, evidence, artifacts, artifactWrites, baseMessageRouter };
}

describe("debate service", () => {
  it("creates and executes a deterministic fake debate with wait mode", async () => {
    const harness = createHarness();
    const evidence = await harness.evidence.create({
      id: "evidence_1",
      sourceType: "manual",
      title: "Local evidence",
      reliability: "primary",
      createdAt: "2026-05-30T00:00:00.000Z"
    });

    const result = await harness.service.create({
      topic: "Should fake debate ship first?",
      participants: [
        { role: "affirmative", runtime: "fake", provider: "test", model: "test-model", adapterType: "process", runtimeMode: "fake.deterministic" },
        { role: "skeptic", runtime: "fake", provider: "test", model: "test-model", adapterType: "process", runtimeMode: "fake.deterministic" }
      ],
      evidenceIds: [evidence.id]
    }, { wait: true });

    expect(result.debate.status).toBe("no_consensus");
    expect(result.debate.participants).toHaveLength(2);
    expect(result.debate.participants.every((participant) => participant.runId?.startsWith("run_"))).toBe(true);
    expect(result.debate.messageIds.length).toBeGreaterThan(0);
    expect(result.debate.judge?.consensus).toBe("no_consensus");
    expect(result.finalReportArtifact?.type).toBe("summary");
    const replay = await harness.service.listEvents(result.debate.id);
    expect(new Set(result.debate.eventIds)).toEqual(new Set(replay.map((event) => event.id)));
    expect(replay.some((event) => event.type === "debate.round.started")).toBe(true);
  });

  it("stops before over-limit message creation and records max_total_messages", async () => {
    const harness = createHarness();
    const result = await harness.service.create({
      topic: "Limit test",
      participants: [
        { role: "affirmative" },
        { role: "skeptic" }
      ],
      limits: {
        maxTotalMessages: 1
      }
    }, { wait: true });

    expect(result.debate.stopReason).toBe("max_total_messages");
    expect(result.debate.messageIds).toHaveLength(1);
  });

  it("rejects unsupported runtimes before side effects", async () => {
    const harness = createHarness();
    await expect(
      harness.service.create({
        topic: "Runtime validation",
        participants: [
          { role: "affirmative", runtime: "codex" },
          { role: "skeptic" }
        ]
      }, { wait: true })
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(harness.debates.items.size).toBe(0);
    expect(harness.runs.items.size).toBe(0);
    expect(harness.messages.items.size).toBe(0);
    expect(harness.events.items.length).toBe(0);
    expect(harness.artifacts.items.size).toBe(0);
  });

  it("rejects unknown evidence with evidence_not_found and no side effects", async () => {
    const harness = createHarness();
    await expect(
      harness.service.create({
        topic: "Evidence validation",
        participants: [{ role: "affirmative" }, { role: "skeptic" }],
        evidenceIds: ["evidence_missing"]
      }, { wait: true })
    ).rejects.toMatchObject({ code: "evidence_not_found" });

    expect(harness.debates.items.size).toBe(0);
    expect(harness.runs.items.size).toBe(0);
    expect(harness.messages.items.size).toBe(0);
    expect(harness.events.items.length).toBe(0);
    expect(harness.artifacts.items.size).toBe(0);
  });

  it("inspects debate state with ordered references", async () => {
    const harness = createHarness();
    const created = await harness.service.create({
      topic: "Inspect state",
      participants: [{ role: "affirmative" }, { role: "skeptic" }]
    }, { wait: true });

    const inspected = await harness.service.inspect(created.debate.id);
    expect(inspected.debate.id).toBe(created.debate.id);
    expect(inspected.messages.map((message) => message.id)).toEqual(inspected.debate.messageIds);
    expect(inspected.events.every((event) => event.debateId === created.debate.id)).toBe(true);
    expect(inspected.artifacts.every((artifact) => artifact.debateId === created.debate.id)).toBe(true);
  });

  it("records failure judge event and failure report when participant run fails", async () => {
    const harness = createHarness({
      runServiceFactory: (runs) =>
        new FailingRunService(runs) as unknown as ConstructorParameters<typeof DebateService>[0]["runService"]
    });

    await expect(
      harness.service.create({
        topic: "Participant run failure",
        participants: [{ role: "affirmative" }, { role: "skeptic" }]
      }, { wait: true })
    ).rejects.toMatchObject({ code: "internal_error" });

    const debate = [...harness.debates.items.values()][0]!;
    const events = await harness.service.listEvents(debate.id);
    expect(debate.status).toBe("failed");
    expect(events.some((event) => event.type === "debate.judge.summary" && event.payload["status"] === "failed")).toBe(true);
    expect(debate.finalReportArtifactId).toBeDefined();
  });

  it("records failure judge event and failure report when message router fails", async () => {
    const failingHarness = createHarness({
      wrapMessageRouter: (router) =>
        new ThrowingMessageRouter(router) as unknown as ConstructorParameters<typeof DebateService>[0]["messageRouter"]
    });

    await expect(
      failingHarness.service.create({
        topic: "Message router failure",
        participants: [{ role: "affirmative" }, { role: "skeptic" }]
      }, { wait: true })
    ).rejects.toMatchObject({ code: "debate_execution_failed" });

    const debate = [...failingHarness.debates.items.values()][0]!;
    const events = await failingHarness.service.listEvents(debate.id);
    expect(debate.status).toBe("failed");
    expect(events.some((event) => event.type === "debate.judge.summary" && event.payload["status"] === "failed")).toBe(true);
    expect(debate.finalReportArtifactId).toBeDefined();
  });

  it("falls back to metadata-only failure report when final report write fails", async () => {
    const harness = createHarness({
      artifactContent: {
        async writeText(): Promise<string> {
          throw new Error("report write failed");
        }
      }
    });

    await expect(
      harness.service.create({
        topic: "Report write failure",
        participants: [{ role: "affirmative" }, { role: "skeptic" }]
      }, { wait: true })
    ).rejects.toMatchObject({ code: "debate_execution_failed" });

    const debate = [...harness.debates.items.values()][0]!;
    const events = await harness.service.listEvents(debate.id);
    const artifact = debate.finalReportArtifactId
      ? await harness.artifacts.get(debate.finalReportArtifactId)
      : undefined;
    expect(debate.status).toBe("failed");
    expect(events.some((event) => event.type === "debate.judge.summary" && event.payload["status"] === "failed")).toBe(true);
    expect(artifact).toBeDefined();
    expect(artifact?.metadata["contentStored"]).toBe(false);
  });
});
