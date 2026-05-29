import type { Artifact, SwitchyardEvent } from "@switchyard/contracts";
import { AdapterProtocolError, type RuntimeAdapter, type RuntimeAdapterCheck, type RuntimeAdapterManifest, type RuntimeStartResult } from "@switchyard/core";

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly id = "fake";
  readonly manifest: RuntimeAdapterManifest = {
    adapterId: "fake",
    providerId: "provider_test",
    runtimeId: "runtime_fake",
    runtimeModeId: "runtime_mode_fake_deterministic",
    runtimeModeSlug: "fake.deterministic",
    name: "Fake deterministic runtime",
    adapterType: "process",
    kind: "deterministic_fake",
    capabilities: ["run.start", "run.cancel", "event.normalized", "event.streaming", "artifact.transcript", "tool.fake_echo", "auth.none"],
    limitations: [
      {
        code: "deterministic_only",
        message: "Outputs are fixed for local smoke and contract tests."
      }
    ],
    placement: {
      local: { support: "supported", reason: "In-process deterministic test adapter." },
      hosted: { support: "unsupported", reason: "Hosted worker execution is not shipped in R3." },
      connectedLocalNode: { support: "future", reason: "Hybrid node execution is planned for R10." }
    },
    docsPath: "docs/development/API.md",
    check: {
      strategy: "none",
      required: [],
      optional: []
    }
  };

  async check(): Promise<RuntimeAdapterCheck> {
    return { ok: true };
  }

  async start(): Promise<RuntimeStartResult> {
    return { sessionId: `session_${crypto.randomUUID()}` };
  }

  async send(): Promise<void> {
    throw new AdapterProtocolError("Fake runtime does not support input after start", {
      reasonCode: "fake_input_unsupported"
    });
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
