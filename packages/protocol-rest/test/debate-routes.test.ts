import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Artifact, AuthContext, Debate, RoutedMessage, SwitchyardEvent } from "@switchyard/contracts";
import type { DebateStore, EventStore } from "@switchyard/core";
import { EventBus } from "@switchyard/core";
import { registerDebateRoutes } from "../src/index.js";
import type { DebateRouteDependencies } from "../src/debate-routes.js";

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

function makeDebate(id: string): Debate {
  return {
    id,
    topic: "Topic",
    mode: "same_provider_model_debate",
    status: "created",
    participants: [
      {
        id: "participant_1",
        runtime: "fake",
        provider: "test",
        model: "test-model",
        role: "affirmative",
        status: "created",
        turnsUsed: 0,
        runIds: []
      },
      {
        id: "participant_2",
        runtime: "fake",
        provider: "test",
        model: "test-model",
        role: "skeptic",
        status: "created",
        turnsUsed: 0,
        runIds: []
      }
    ],
    limits: {
      maxRounds: 2,
      maxTurnsPerAgent: 2,
      maxSearchesPerAgent: 0,
      maxTotalMessages: 4,
      maxDurationSeconds: 30,
      maxCostUsd: 0,
      requireCitations: false,
      requireDisagreementSummary: true,
      stopOnConsensus: false,
      stopOnLowNewInformation: false,
      humanStopAllowed: false
    },
    evidenceIds: [],
    messageIds: [],
    eventIds: [],
    budget: {
      status: "within_budget",
      maxCostUsd: 0,
      spentCostUsd: 0
    },
    createdAt: "2026-05-30T00:00:00.000Z"
  };
}

describe("debate routes", () => {
  it("returns 404 debate_not_found for unknown debate inspect", async () => {
    const app = Fastify({ logger: false });
    const debates = new InMemoryDebateStore();
    const events = new InMemoryEventStore();
    registerDebateRoutes(app, {
      debateService: {
        create: async () => {
          throw new Error("unused");
        },
        execute: async () => {
          throw new Error("unused");
        },
        inspect: async () => {
          throw { code: "debate_not_found", message: "Debate not found: debate_missing" };
        },
        listEvents: async () => []
      } as unknown as DebateRouteDependencies["debateService"],
      debates,
      events
    });

    const response = await app.inject({ method: "GET", url: "/debates/debate_missing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("debate_not_found");
    const missingEventsResponse = await app.inject({ method: "GET", url: "/debates/debate_missing/events" });
    expect(missingEventsResponse.statusCode).toBe(404);
    expect(missingEventsResponse.json().error.code).toBe("debate_not_found");
    await app.close();
  });

  it("supports create wait=1 and debate-scoped event streams", async () => {
    const app = Fastify({ logger: false });
    const debates = new InMemoryDebateStore();
    const events = new InMemoryEventStore();
    const eventBus = new EventBus();

    const finalDebate = makeDebate("debate_1");
    finalDebate.status = "no_consensus";
    finalDebate.messageIds = ["message_1"];
    finalDebate.eventIds = ["event_1"];
    finalDebate.stopReason = "completed";

    registerDebateRoutes(app, {
      debateService: {
        async create(_input: unknown, options?: { wait?: boolean }) {
          if (options?.wait) {
            return {
              debate: finalDebate,
              events: [
                {
                  id: "event_1",
                  debateId: finalDebate.id,
                  type: "debate.round.started",
                  sequence: 0,
                  payload: { round: 1 },
                  createdAt: "2026-05-30T00:00:00.000Z"
                }
              ],
              finalReportArtifact: {
                id: "artifact_1",
                debateId: finalDebate.id,
                type: "summary",
                path: `debates/${finalDebate.id}/final-report.md`,
                metadata: { contentStored: false },
                createdAt: "2026-05-30T00:00:00.000Z"
              } satisfies Artifact
            };
          }
          debates.items.set(finalDebate.id, finalDebate);
          return { debate: finalDebate };
        },
        async execute() {
          return finalDebate;
        },
        async inspect() {
          return {
            debate: finalDebate,
            events: await events.listByDebate(finalDebate.id),
            messages: [] as RoutedMessage[],
            evidence: [],
            artifacts: []
          };
        },
        async listEvents() {
          return events.listByDebate(finalDebate.id);
        }
      } as unknown as DebateRouteDependencies["debateService"],
      debates,
      events,
      eventBus
    });

    debates.items.set(finalDebate.id, finalDebate);
    await events.append({
      id: "event_1",
      debateId: finalDebate.id,
      type: "debate.round.started",
      sequence: 0,
      payload: { round: 1 },
      createdAt: "2026-05-30T00:00:00.000Z"
    });

    const created = await app.inject({
      method: "POST",
      url: "/debates?wait=1",
      payload: {
        topic: "Topic",
        participants: [{ role: "affirmative" }, { role: "skeptic" }]
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().debate.status).toBe("no_consensus");

    const replay = await app.inject({
      method: "GET",
      url: `/debates/${finalDebate.id}/events`
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toContain("event: debate.round.started");
    await app.close();
  });

  it("rejects hosted ownership overrides before debate service or enqueue side effects", async () => {
    const app = Fastify({ logger: false });
    const debates = new InMemoryDebateStore();
    const events = new InMemoryEventStore();
    const create = vi.fn(async () => ({ debate: makeDebate("debate_1") }));
    const enqueueDebateJob = vi.fn();

    registerDebateRoutes(app, {
      routeMode: "hosted",
      debateService: {
        create,
        execute: vi.fn(),
        inspect: vi.fn(),
        listEvents: vi.fn()
      } as unknown as DebateRouteDependencies["debateService"],
      debates,
      events,
      getAuthContext: () => hostedAuthContext(),
      enqueueDebateJob
    });

    const topLevel = await app.inject({
      method: "POST",
      url: "/debates",
      payload: {
        topic: "Topic",
        accountId: "account_override",
        participants: [{ role: "affirmative" }, { role: "skeptic" }]
      }
    });
    const metadata = await app.inject({
      method: "POST",
      url: "/debates",
      payload: {
        topic: "Topic",
        participants: [
          { role: "affirmative", metadata: { tenantId: "tenant_override" } },
          { role: "skeptic" }
        ]
      }
    });

    expect(topLevel.statusCode).toBe(400);
    expect(topLevel.json().error.code).toBe("invalid_input");
    expect(metadata.statusCode).toBe(400);
    expect(metadata.json().error.details[0]).toMatchObject({ path: "participants.0.metadata.tenantId" });
    expect(create).not.toHaveBeenCalled();
    expect(enqueueDebateJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes hosted auth and request id into create and uses durable enqueue instead of local execute", async () => {
    const app = Fastify({ logger: false });
    const debates = new InMemoryDebateStore();
    const events = new InMemoryEventStore();
    const debate = makeDebate("debate_1");
    const auth = hostedAuthContext();
    const create = vi.fn(async () => ({ debate }));
    const execute = vi.fn();
    const enqueueDebateJob = vi.fn(async () => {});

    registerDebateRoutes(app, {
      routeMode: "hosted",
      debateService: {
        create,
        execute,
        inspect: vi.fn(),
        listEvents: vi.fn()
      } as unknown as DebateRouteDependencies["debateService"],
      debates,
      events,
      getAuthContext: () => auth,
      enqueueDebateJob
    });

    const response = await app.inject({
      method: "POST",
      url: "/debates",
      payload: {
        topic: "Topic",
        participants: [{ role: "affirmative" }, { role: "skeptic" }]
      }
    });

    expect(response.statusCode).toBe(202);
    expect(create).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ wait: false, auth }));
    expect(create.mock.calls[0]?.[1]?.requestId).toEqual(expect.any(String));
    expect(enqueueDebateJob).toHaveBeenCalledWith(expect.objectContaining({ debateId: debate.id, auth }));
    expect(execute).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails closed for hosted async create when durable enqueue is missing", async () => {
    const app = Fastify({ logger: false });
    const debates = new InMemoryDebateStore();
    const events = new InMemoryEventStore();
    const create = vi.fn(async () => ({ debate: makeDebate("debate_1") }));

    registerDebateRoutes(app, {
      routeMode: "hosted",
      debateService: {
        create,
        execute: vi.fn(),
        inspect: vi.fn(),
        listEvents: vi.fn()
      } as unknown as DebateRouteDependencies["debateService"],
      debates,
      events,
      getAuthContext: () => hostedAuthContext()
    });

    const response = await app.inject({
      method: "POST",
      url: "/debates",
      payload: {
        topic: "Topic",
        participants: [{ role: "affirmative" }, { role: "skeptic" }]
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("hosted_debate_queue_unavailable");
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it("denies hosted debate inspect and events before service or store reads", async () => {
    const app = Fastify({ logger: false });
    const debates = new InMemoryDebateStore();
    const events = new InMemoryEventStore();
    const inspect = vi.fn();
    const debateGet = vi.spyOn(debates, "get");
    const eventList = vi.spyOn(events, "listByDebate");

    registerDebateRoutes(app, {
      routeMode: "hosted",
      debateService: {
        create: vi.fn(),
        execute: vi.fn(),
        inspect,
        listEvents: vi.fn()
      } as unknown as DebateRouteDependencies["debateService"],
      debates,
      events,
      getAuthContext: () => hostedAuthContext(),
      authorizeDebateRead: vi.fn(async () => ({ ok: false }))
    });

    const inspectResponse = await app.inject({ method: "GET", url: "/debates/debate_private" });
    const eventsResponse = await app.inject({ method: "GET", url: "/debates/debate_private/events" });

    expect(inspectResponse.statusCode).toBe(404);
    expect(inspectResponse.json().error.code).toBe("debate_not_found");
    expect(eventsResponse.statusCode).toBe(404);
    expect(eventsResponse.json().error.code).toBe("debate_not_found");
    expect(inspect).not.toHaveBeenCalled();
    expect(debateGet).not.toHaveBeenCalled();
    expect(eventList).not.toHaveBeenCalled();
    await app.close();
  });

  it("filters live SSE events strictly by debate id", async () => {
    const app = Fastify({ logger: false });
    const debates = new InMemoryDebateStore();
    const events = new InMemoryEventStore();
    const eventBus = new EventBus();
    const debate = makeDebate("debate_1");
    debates.items.set(debate.id, debate);

    registerDebateRoutes(app, {
      debateService: {
        create: vi.fn(),
        execute: vi.fn(),
        inspect: vi.fn(),
        listEvents: vi.fn()
      } as unknown as DebateRouteDependencies["debateService"],
      debates,
      events,
      eventBus
    });

    const responsePromise = app.inject({ method: "GET", url: "/debates/debate_1/events?live=1&stopAfter=1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await eventBus.publish({
      id: "event_other",
      debateId: "debate_other",
      runId: "run_other",
      type: "debate.round.started",
      sequence: 0,
      payload: {},
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await eventBus.publish({
      id: "event_1",
      debateId: "debate_1",
      runId: "run_other_same_transport",
      type: "debate.round.started",
      sequence: 1,
      payload: {},
      createdAt: "2026-05-30T00:00:01.000Z"
    });

    const response = await responsePromise;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event_1");
    expect(response.body).not.toContain("event_other");
    await app.close();
  });

  it("filters replay SSE events strictly by debate id on every no-bus write path", async () => {
    const app = Fastify({ logger: false });
    const debates = new InMemoryDebateStore();
    const events = new InMemoryEventStore();
    const debate = makeDebate("debate_1");
    debates.items.set(debate.id, debate);
    vi.spyOn(events, "listByDebate").mockResolvedValue([
      {
        id: "event_target_1",
        debateId: "debate_1",
        type: "debate.round.started",
        sequence: 0,
        payload: {},
        createdAt: "2026-05-30T00:00:00.000Z"
      },
      {
        id: "event_other",
        debateId: "debate_other",
        runId: "run_other",
        type: "debate.round.started",
        sequence: 1,
        payload: {},
        createdAt: "2026-05-30T00:00:01.000Z"
      },
      {
        id: "event_target_2",
        debateId: "debate_1",
        runId: "run_unrelated",
        type: "debate.round.completed",
        sequence: 2,
        payload: {},
        createdAt: "2026-05-30T00:00:02.000Z"
      }
    ]);

    registerDebateRoutes(app, {
      debateService: {
        create: vi.fn(),
        execute: vi.fn(),
        inspect: vi.fn(),
        listEvents: vi.fn()
      } as unknown as DebateRouteDependencies["debateService"],
      debates,
      events
    });

    const replay = await app.inject({ method: "GET", url: "/debates/debate_1/events" });
    const liveWithStop = await app.inject({ method: "GET", url: "/debates/debate_1/events?live=1&stopAfter=5" });
    const liveNoBus = await app.inject({ method: "GET", url: "/debates/debate_1/events?live=1" });

    for (const response of [replay, liveWithStop, liveNoBus]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("event_target_1");
      expect(response.body).toContain("event_target_2");
      expect(response.body).not.toContain("event_other");
      expect(response.body).not.toContain("debate_other");
    }
    await app.close();
  });

  it("rejects wait=1 real participants before create or enqueue side effects", async () => {
    const app = Fastify({ logger: false });
    const debates = new InMemoryDebateStore();
    const events = new InMemoryEventStore();
    const create = vi.fn();
    const enqueueDebateJob = vi.fn();

    registerDebateRoutes(app, {
      routeMode: "hosted",
      debateService: {
        create,
        execute: vi.fn(),
        inspect: vi.fn(),
        listEvents: vi.fn()
      } as unknown as DebateRouteDependencies["debateService"],
      debates,
      events,
      getAuthContext: () => hostedAuthContext(),
      enqueueDebateJob
    });

    const response = await app.inject({
      method: "POST",
      url: "/debates?wait=1",
      payload: {
        topic: "Topic",
        participants: [
          {
            role: "affirmative",
            runtime: "claude_code",
            provider: "anthropic",
            model: "claude-sonnet",
            adapterType: "sdk",
            runtimeMode: "claude_code.sdk",
            placement: "hosted",
            realRuntimeOptIn: true
          },
          { role: "skeptic" }
        ]
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("debate_wait_real_runtime_unsupported");
    expect(create).not.toHaveBeenCalled();
    expect(enqueueDebateJob).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps R24 debate service errors to named REST errors", async () => {
    const app = Fastify({ logger: false });
    const debates = new InMemoryDebateStore();
    const events = new InMemoryEventStore();

    registerDebateRoutes(app, {
      debateService: {
        create: vi.fn(),
        execute: vi.fn(),
        inspect: async () => {
          throw { code: "hosted_debate_queue_unavailable", message: "debate queue unavailable" };
        },
        listEvents: vi.fn()
      } as unknown as DebateRouteDependencies["debateService"],
      debates,
      events
    });

    const response = await app.inject({ method: "GET", url: "/debates/debate_1" });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("hosted_debate_queue_unavailable");
    await app.close();
  });
});

function hostedAuthContext(): AuthContext {
  return {
    account: {
      id: "account_1",
      name: "Acme",
      status: "active",
      billingPlanId: "billing_plan_1",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    tenant: {
      id: "tenant_1",
      accountId: "account_1",
      slug: "acme",
      displayName: "Acme",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    project: {
      id: "project_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      slug: "prod",
      displayName: "Prod",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    user: {
      id: "user_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      displayName: "Tester",
      email: "t@example.com",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    apiKey: {
      id: "api_key_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      userId: "user_1",
      name: "test",
      keyPrefix: "sk_sw",
      scopes: ["runs:read", "runs:write"],
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    entitlement: {
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      planId: "billing_plan_1",
      planSlug: "enterprise",
      planDisplayName: "Enterprise",
      planStatus: "active",
      entitlements: {
        allowedPlacements: ["local", "hosted", "connected_local_node"],
        allowedRuntimeModes: ["fake.deterministic", "claude_code.sdk"],
        allowHostedRealRuntime: true,
        allowConnectedNodes: true,
        allowHostedTools: false,
        allowConnectedNodeTools: false,
        allowedToolTypes: [],
        allowArtifactContentRead: true,
        allowToolArtifactContentRead: false,
        allowMetricsRead: false,
        allowAuditRead: false
      },
      quotas: {
        maxRunsPerHour: 100,
        maxActiveRuns: 10,
        maxRunTimeoutSeconds: 600,
        maxConnectedNodes: 0,
        maxArtifactContentReadBytesPerHour: 1024,
        maxToolInvocationsPerHour: 0,
        maxActiveToolInvocations: 0,
        maxToolArtifactBytesPerHour: 0
      },
      scopes: ["runs:read", "runs:write"],
      capturedAt: "2026-05-31T00:00:00.000Z"
    }
  };
}
