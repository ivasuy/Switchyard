import { describe, expect, it } from "vitest";
import { HostedRunService } from "../src/services/hosted-run-service.js";
import { PlacementService } from "../src/services/placement-service.js";

const facts = {
  local: { support: "supported", reason: "ok" },
  hosted: { support: "supported", reason: "ok" },
  connectedLocalNode: { support: "supported", reason: "ok" }
} as const;

describe("PlacementService", () => {
  it("defaults to hosted when allowlisted", () => {
    const svc = new PlacementService();
    const decision = svc.decide({
      runtimeMode: "fake.deterministic",
      placementFacts: facts,
      hostedRuntimeAllowlist: ["fake.deterministic"],
      onlineNodes: [],
      now: "2026-05-30T00:00:00.000Z"
    });
    expect(decision.decision).toBe("hosted");
  });

  it("rejects implicit hosted placement for real runtime modes", () => {
    const svc = new PlacementService();
    const decision = svc.decide({
      runtimeMode: "codex.exec_json",
      placementFacts: facts,
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      onlineNodes: [],
      now: "2026-05-30T00:00:00.000Z"
    });
    expect(decision.decision).toBe("reject");
    expect(decision.reason).toBe("hosted_explicit_placement_required");
  });

  it("picks lexicographically first connected node", () => {
    const svc = new PlacementService();
    const decision = svc.decide({
      requestedPlacement: "connected_local_node",
      runtimeMode: "fake.deterministic",
      placementFacts: facts,
      hostedRuntimeAllowlist: [],
      onlineNodes: [
        {
          id: "node_b",
          mode: "hybrid",
          status: "online",
          capabilities: ["runtime.fake.deterministic"],
          createdAt: "2026-05-30T00:00:00.000Z"
        },
        {
          id: "node_a",
          mode: "hybrid",
          status: "online",
          capabilities: ["runtime.fake.deterministic"],
          createdAt: "2026-05-30T00:00:00.000Z"
        }
      ],
      now: "2026-05-30T00:00:00.000Z"
    });
    expect(decision.decision).toBe("connected_local_node");
    expect(decision.targetNode).toBe("node_a");
  });

  it("rejects explicit hosted for non-allowlisted mode", () => {
    const svc = new PlacementService();
    const decision = svc.decide({
      requestedPlacement: "hosted",
      runtimeMode: "codex.exec_json",
      placementFacts: facts,
      hostedRuntimeAllowlist: ["fake.deterministic"],
      onlineNodes: [],
      now: "2026-05-30T00:00:00.000Z"
    });
    expect(decision.decision).toBe("reject");
    expect(decision.reason).toBe("hosted_runtime_not_allowed");
  });

  it("marks hosted run failed when enqueue fails after durable creation", async () => {
    const runs = new Map<string, any>();
    const events: any[] = [];
    const placements: any[] = [];
    const runService = {
      createRun: async (input: any) => {
        const run = {
          id: "run_enqueue_fail",
          ...input,
          status: "queued",
          createdAt: "2026-05-30T00:00:00.000Z"
        };
        runs.set(run.id, run);
        events.push({
          id: "event_queued",
          type: "run.queued",
          runId: run.id,
          sequence: 0,
          payload: {},
          createdAt: run.createdAt
        });
        return run;
      }
    };

    const svc = new HostedRunService({
      runService: runService as any,
      runs: {
        create: async (run: any) => { runs.set(run.id, run); return run; },
        get: async (id: string) => runs.get(id),
        update: async (run: any) => { runs.set(run.id, run); return run; },
        list: async () => ({ runs: [...runs.values()], nextCursor: null })
      },
      events: {
        append: async (event: any) => { events.push(event); return event; },
        listByRun: async (runId: string) => events.filter((event) => event.runId === runId),
        listByDebate: async () => []
      },
      placements: {
        create: async (record: any) => { placements.push(record); return record; },
        get: async () => undefined,
        update: async (record: any) => record,
        listByRun: async (runId: string) => placements.filter((record) => record.runId === runId)
      },
      queue: {
        enqueue: async () => { throw new Error("redis down"); },
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
      hostedRuntimeAllowlist: ["fake.deterministic"],
      deploymentMode: "test",
      hostedRealRuntimeExecution: "disabled",
      listOnlineNodes: async () => [],
      now: () => "2026-05-30T00:00:01.000Z"
    });

    await expect(svc.createRun({
      runtime: "fake",
      provider: "test",
      model: "test-model",
      adapterType: "process",
      cwd: "/repo",
      task: "fail enqueue",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "fake.deterministic",
      placementFacts: facts
    })).rejects.toMatchObject({ code: "queue_unavailable" });

    expect(runs.get("run_enqueue_fail")?.status).toBe("failed");
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      runId: "run_enqueue_fail",
      payload: { reasonCode: "queue_enqueue_failed" }
    });
  });

  it("rejects hosted real wait before durable run creation", async () => {
    const svc = new HostedRunService({
      runService: {
        createRun: async () => {
          throw new Error("must_not_create");
        }
      } as any,
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
        create: async (record: any) => record,
        get: async () => undefined,
        update: async (record: any) => record,
        listByRun: async () => []
      },
      queue: {
        enqueue: async () => ({ runId: "nope", placement: "hosted", jobId: "job_1", createdAt: "2026-05-30T00:00:00.000Z" }),
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
      deploymentMode: "staging",
      hostedRealRuntimeExecution: "enabled",
      listOnlineNodes: async () => [],
      now: () => "2026-05-30T00:00:01.000Z"
    });

    await expect(svc.createRun({
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      adapterType: "process",
      cwd: "/repo",
      task: "hosted wait",
      placement: "hosted",
      approvalPolicy: "default",
      timeoutSeconds: 60,
      metadata: {},
      runtimeMode: "codex.exec_json",
      placementFacts: facts
    }, { wait: true })).rejects.toMatchObject({ code: "placement_denied", message: "hosted_wait_unsupported" });
  });
});
