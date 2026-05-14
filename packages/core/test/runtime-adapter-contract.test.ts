import { describe, expect, it } from "vitest";
import type { Artifact, RuntimeAdapter, RuntimeAdapterCheck, RuntimeStartResult } from "../src/index.js";
import type { SwitchyardEvent } from "@switchyard/contracts";

class ContractAdapter implements RuntimeAdapter {
  readonly id = "fake";

  async check(): Promise<RuntimeAdapterCheck> {
    return { ok: true };
  }

  async start(): Promise<RuntimeStartResult> {
    return { sessionId: `session_${crypto.randomUUID()}` };
  }

  async send(): Promise<void> {
    return;
  }

  async cancel(): Promise<void> {
    return;
  }

  async *events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent> {
    const runId = typeof session["runId"] === "string" ? session["runId"] : "run_fake";
    const createdAt = "2026-05-11T00:00:00.000Z";

    yield {
      id: "event_fake_status",
      type: "runtime.status",
      runId,
      sequence: 1,
      payload: { status: "running" },
      createdAt
    };
    yield {
      id: "event_fake_output",
      type: "runtime.output",
      runId,
      sequence: 2,
      payload: { text: "fake runtime output" },
      createdAt
    };
    yield {
      id: "event_fake_completed",
      type: "run.completed",
      runId,
      sequence: 3,
      payload: { status: "completed" },
      createdAt
    };
  }

  async tools(): Promise<string[]> {
    return ["fake.echo"];
  }

  async artifacts(): Promise<Artifact[]> {
    return [
      {
        id: "artifact_fake_transcript",
        type: "transcript",
        path: "runs/run_fake/transcript.jsonl",
        metadata: {},
        createdAt: "2026-05-11T00:00:00.000Z"
      }
    ];
  }
}

describe("runtime adapter contract", () => {
  it("supports check, start, events, send, cancel, tools, and artifacts", async () => {
    const adapter = new ContractAdapter();
    const check = await adapter.check({});
    const session = await adapter.start({
      runId: "run_contract",
      runtime: "fake",
      provider: "test",
      model: "test-model",
      cwd: "/repo",
      task: "contract test",
      metadata: {}
    });
    const events = [];

    for await (const event of adapter.events({ ...session, runId: "run_contract" })) {
      events.push(event);
    }

    await adapter.send({ ...session, runId: "run_contract" }, { text: "continue" });
    await adapter.cancel({ ...session, runId: "run_contract" });
    const tools = await adapter.tools({ ...session, runId: "run_contract" });
    const artifacts = await adapter.artifacts({ ...session, runId: "run_contract" });

    expect(check.ok).toBe(true);
    expect(session.sessionId).toMatch(/^session_/);
    expect(events.map((event) => event.type)).toEqual(["runtime.status", "runtime.output", "run.completed"]);
    expect(tools).toEqual(["fake.echo"]);
    expect(artifacts[0]).toMatchObject({ type: "transcript" });
  });
});
