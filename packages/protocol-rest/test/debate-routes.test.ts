import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Artifact, Debate, RoutedMessage, SwitchyardEvent } from "@switchyard/contracts";
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
});
