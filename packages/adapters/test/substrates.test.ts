import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AsyncLineQueue } from "../src/substrates/async-line-queue.js";
import { parseJsonlEvents } from "../src/substrates/jsonl-event-parser.js";
import { ProcessRunner } from "../src/substrates/process-runner.js";
import { TranscriptRecorder } from "../src/substrates/transcript-recorder.js";
import { withAdapterTimeout } from "../src/substrates/timeout.js";

describe("runtime substrates", () => {
  it("async line queue supports push/next/close", async () => {
    const queue = new AsyncLineQueue();
    queue.push("line1");
    expect(await queue.next()).toEqual({ value: "line1", done: false });
    queue.close();
    expect(await queue.next()).toEqual({ value: undefined, done: true });
  });

  it("process runner captures stdout/stderr, supports missing pid, and cancel is idempotent", async () => {
    const runner = new ProcessRunner<FakeProcess>();
    const fake = new FakeProcess();
    fake.pid = undefined;

    const session = runner.start({
      processFactory: () => fake,
      args: ["exec"],
      cwd: "/repo",
      env: process.env,
      stdin: "close"
    });

    fake.stdout.write("first\n");
    fake.stdout.write("\n");
    fake.stderr.write("warn\n");
    fake.stdout.end();
    fake.stderr.end();
    fake.emit("exit", 1, null);

    session.cancel();
    session.cancel();
    await session.drainPromise;

    expect(fake.stdin.writableEnded).toBe(true);
    expect(session.processId).toBeUndefined();
    expect(session.rawLines).toEqual(["first"]);
    expect(session.stderrLines.join("")).toContain("warn");
    expect(fake.killCount).toBe(1);
  });

  it("jsonl parser emits one run.failed for parse errors and stops after terminal", async () => {
    const parseErrorEvents = [];
    for await (const event of parseJsonlEvents(
      (async function* () {
        yield "not-json";
        yield "{\"type\":\"turn.completed\"}";
      })(),
      (record, context) => ({
        id: `event_${context.sequence}`,
        type: "runtime.status",
        runId: context.runId,
        sequence: context.sequence,
        payload: record as Record<string, unknown>,
        createdAt: context.createdAt
      }),
      {
        runId: "run_parse",
        sanitizeError: (message) => `bad line: ${message}`
      }
    )) {
      parseErrorEvents.push(event);
    }
    expect(parseErrorEvents).toHaveLength(1);
    expect(parseErrorEvents[0]?.type).toBe("run.failed");

    const terminalEvents = [];
    for await (const event of parseJsonlEvents(
      (async function* () {
        yield "{\"type\":\"running\"}";
        yield "{\"type\":\"done\"}";
        yield "{\"type\":\"late\"}";
      })(),
      (record, context) => ({
        id: `event_${context.sequence}`,
        type: (record as { type: string }).type === "done" ? "run.completed" : "runtime.status",
        runId: context.runId,
        sequence: context.sequence,
        payload: record as Record<string, unknown>,
        createdAt: context.createdAt
      }),
      {
        runId: "run_terminal"
      }
    )) {
      terminalEvents.push(event);
    }
    expect(terminalEvents.map((event) => event.type)).toEqual(["runtime.status", "run.completed"]);
  });

  it("jsonl parser emits one run.failed for mapper errors", async () => {
    const events = [];
    for await (const event of parseJsonlEvents(
      (async function* () {
        yield "{\"type\":\"running\"}";
      })(),
      () => {
        throw new Error("mapper boom");
      },
      { runId: "run_mapper" }
    )) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.failed");
    expect(String(events[0]?.payload.error)).toContain("mapper boom");
  });

  it("transcript recorder supports process and http entries", () => {
    const recorder = new TranscriptRecorder();
    recorder.appendProcessStdout("{\"type\":\"turn.completed\"}");
    recorder.appendProcessStderr("stderr line");
    recorder.appendHttpRequest({ method: "GET", path: "/health", status: 200, durationMs: 1 });
    recorder.appendHttpEvent({ type: "runtime.status", status: "running" });
    const content = recorder.content();

    expect(content).toContain("\"turn.completed\"");
    expect(content).toContain("\"type\":\"stderr\"");
    expect(content).toContain("\"type\":\"http.request\"");
    expect(recorder.metadata({ runtime: "codex", mode: "exec-json" })).toMatchObject({
      runtime: "codex",
      mode: "exec-json",
      transcriptVersion: "r4.v1"
    });
  });

  it("adapter timeout wrapper resolves and times out", async () => {
    await expect(withAdapterTimeout(Promise.resolve("ok"), 50, "test")).resolves.toBe("ok");
    await expect(withAdapterTimeout(new Promise(() => undefined), 5, "test")).rejects.toBeInstanceOf(Error);
  });
});

class FakeProcess extends EventEmitter {
  pid: number | undefined = 1234;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killCount = 0;

  kill(): boolean {
    this.killCount += 1;
    return true;
  }
}
