import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import type { RuntimeAdapter, RuntimeAdapterCheck, RuntimeStartResult } from "@switchyard/core";

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly id = "fake";

  async check(): Promise<RuntimeAdapterCheck> {
    return { ok: true };
  }

  async start(): Promise<RuntimeStartResult> {
    return { sessionId: `session_${crypto.randomUUID()}` };
  }

  async send(): Promise<void> {
    return undefined;
  }

  async cancel(): Promise<void> {
    return undefined;
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
        metadata: {
          content: "{\"type\":\"runtime.output\",\"text\":\"fake runtime output\"}\n"
        },
        createdAt: "2026-05-11T00:00:00.000Z"
      }
    ];
  }
}
