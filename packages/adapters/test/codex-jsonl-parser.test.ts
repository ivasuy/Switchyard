import { describe, expect, it } from "vitest";
import { codexEventToSwitchyardEvent, parseCodexJsonLine } from "../src/index.js";

describe("codex jsonl parser", () => {
  it("maps lifecycle and message events", () => {
    const runId = "run_codex";
    const createdAt = "2026-05-14T00:00:00.000Z";
    const events = [
      { type: "thread.started", thread_id: "thread_123" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "hello from codex" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }
    ].map((event, sequence) => codexEventToSwitchyardEvent(event, { runId, sequence, createdAt }));

    expect(events.map((event) => event.type)).toEqual([
      "runtime.status",
      "runtime.status",
      "runtime.output",
      "run.completed"
    ]);
    expect(events[2]?.payload).toMatchObject({ text: "hello from codex", codexType: "item.completed" });
    expect(events[0]?.payload).toMatchObject({
      threadId: "thread_123",
      sessionStatePatch: { codexThreadId: "thread_123" }
    });
    expect(events[3]?.payload).toMatchObject({
      status: "completed",
      codexType: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 5 }
    });
  });

  it("maps turn failures and top-level errors to run.failed", () => {
    const failed = codexEventToSwitchyardEvent(
      { type: "turn.failed", error: { message: "model failed" } },
      { runId: "run_codex", sequence: 0, createdAt: "2026-05-14T00:00:00.000Z" }
    );
    const error = codexEventToSwitchyardEvent(
      { type: "error", message: "bad auth" },
      { runId: "run_codex", sequence: 1, createdAt: "2026-05-14T00:00:00.000Z" }
    );

    expect(failed.type).toBe("run.failed");
    expect(failed.payload).toMatchObject({
      status: "failed",
      codexType: "turn.failed",
      error: { message: "model failed" }
    });
    expect(error.type).toBe("run.failed");
    expect(error.payload).toMatchObject({
      status: "failed",
      codexType: "error",
      error: "bad auth"
    });
  });

  it("maps unknown non-text events to runtime.status with event status", () => {
    const mapped = codexEventToSwitchyardEvent(
      { type: "thread.updated", thread_id: "thread_abc" },
      { runId: "run_codex", sequence: 2, createdAt: "2026-05-14T00:00:00.000Z" }
    );

    expect(mapped.type).toBe("runtime.status");
    expect(mapped.payload).toMatchObject({
      status: "event",
      codexType: "thread.updated",
      threadId: "thread_abc",
      sessionStatePatch: { codexThreadId: "thread_abc" }
    });
  });

  it("extracts text from nested content arrays", () => {
    const mapped = codexEventToSwitchyardEvent(
      {
        type: "item.delta",
        item: {
          content: [
            { type: "output_text", text: "hello " },
            { type: "output_text", delta: "world" },
            { type: "output_text", message: "!" }
          ]
        }
      },
      { runId: "run_codex", sequence: 3, createdAt: "2026-05-14T00:00:00.000Z" }
    );

    expect(mapped.type).toBe("runtime.output");
    expect(mapped.payload).toMatchObject({
      codexType: "item.delta",
      text: "hello world!"
    });
  });

  it("maps top-level text/message/delta on item events to runtime.output", () => {
    const context = { runId: "run_codex", sequence: 4, createdAt: "2026-05-14T00:00:00.000Z" };
    const fromText = codexEventToSwitchyardEvent({ type: "item.completed", text: "plain text" }, context);
    const fromMessage = codexEventToSwitchyardEvent({ type: "item.delta", message: "plain message" }, context);
    const fromDelta = codexEventToSwitchyardEvent({ type: "item.delta", delta: "plain delta" }, context);

    expect(fromText.type).toBe("runtime.output");
    expect(fromText.payload).toMatchObject({ text: "plain text", codexType: "item.completed" });

    expect(fromMessage.type).toBe("runtime.output");
    expect(fromMessage.payload).toMatchObject({ text: "plain message", codexType: "item.delta" });

    expect(fromDelta.type).toBe("runtime.output");
    expect(fromDelta.payload).toMatchObject({ text: "plain delta", codexType: "item.delta" });
  });

  it("keeps unknown non-item textual events as runtime.status", () => {
    const mapped = codexEventToSwitchyardEvent(
      { type: "thread.updated", text: "should not become output", thread_id: "thread_keep_status" },
      { runId: "run_codex", sequence: 5, createdAt: "2026-05-14T00:00:00.000Z" }
    );

    expect(mapped.type).toBe("runtime.status");
    expect(mapped.payload).toMatchObject({
      status: "event",
      codexType: "thread.updated",
      threadId: "thread_keep_status"
    });
  });

  it("parses JSON lines and rejects invalid lines", () => {
    expect(parseCodexJsonLine("{\"type\":\"turn.started\"}")).toEqual({ type: "turn.started" });
    expect(() => parseCodexJsonLine("not-json")).toThrow("Invalid Codex JSONL line:");
    expect(() => parseCodexJsonLine("null")).toThrow("Invalid Codex JSONL line:");
    expect(() => parseCodexJsonLine("1")).toThrow("Invalid Codex JSONL line:");
    expect(() => parseCodexJsonLine("[1,2,3]")).toThrow("Invalid Codex JSONL line:");
    expect(() => parseCodexJsonLine("\"string\"")).toThrow("Invalid Codex JSONL line:");
  });
});
