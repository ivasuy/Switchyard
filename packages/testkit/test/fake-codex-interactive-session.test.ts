import { describe, expect, it } from "vitest";
import { AdapterProtocolError } from "@switchyard/core";
import { createFakeCodexInteractiveSessionFactory } from "../src/index.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
  }
  return out;
}

describe("fake codex interactive session factory", () => {
  it("default check is no spend", async () => {
    const { factory, state } = createFakeCodexInteractiveSessionFactory();

    const check = await factory.check({ command: "codex", runtimeMode: "codex.interactive" });

    expect(check.ok).toBe(true);
    expect(state.checkCalls).toHaveLength(1);
    expect(state.liveProviderCalls.length).toBe(0);
    expect(state.commands.length).toBe(0);
  });

  it("start emits thread id and output", async () => {
    const { factory } = createFakeCodexInteractiveSessionFactory();

    const turn = await factory.startTurn({ runId: "run_1", cwd: "/repo", task: "hello" });
    const events = await collect(turn.events());

    expect(turn.threadId).toBe("thread_1");
    expect(turn.waitForInput).toBe(true);
    expect(events.some((event) => event.type === "thread.started")).toBe(true);
  });

  it("resume records resume token and redacted prompt accounting", async () => {
    const { factory, state } = createFakeCodexInteractiveSessionFactory();

    await factory.resumeTurn({ runId: "run_1", cwd: "/repo", codexThreadId: "thread_1", text: "continue" });

    expect(state.resumes[0]?.codexThreadId).toBe("thread_1");
    expect(state.prompts[0]?.redacted).toBe(true);
  });

  it("missing token and stale token scenarios produce named failures", async () => {
    const missing = createFakeCodexInteractiveSessionFactory({ kind: "missing_token" });
    const missingTurn = await missing.factory.startTurn({ runId: "run_1", cwd: "/repo", task: "hello" });
    expect(missingTurn.threadId).toBeUndefined();

    const stale = createFakeCodexInteractiveSessionFactory({ kind: "stale_token" });
    await expect(stale.factory.resumeTurn({ runId: "run_1", cwd: "/repo", codexThreadId: "thread_1", text: "resume" })).rejects.toMatchObject({
      reasonCode: "codex_resume_session_stale"
    } satisfies Partial<AdapterProtocolError>);
  });

  it("approval scenarios are deterministic", async () => {
    const approved = createFakeCodexInteractiveSessionFactory({ kind: "approval_requested" });
    await approved.factory.startTurn({ runId: "run_1", cwd: "/repo", task: "hello" });
    await approved.factory.resolveApproval({
      runId: "run_1",
      codexThreadId: "thread_1",
      runtimeApprovalToken: "pause-1",
      decision: "approved",
      message: "ok"
    });
    expect(approved.state.resolvedApprovals[0]?.decision).toBe("approved");

    const denied = createFakeCodexInteractiveSessionFactory({ kind: "approval_denied" });
    await denied.factory.startTurn({ runId: "run_1", cwd: "/repo", task: "hello" });
    await expect(denied.factory.resolveApproval({
      runId: "run_1",
      codexThreadId: "thread_1",
      runtimeApprovalToken: "pause-1",
      decision: "rejected",
      message: "deny"
    })).rejects.toMatchObject({ reasonCode: "provider_denied" });

    const unsupported = createFakeCodexInteractiveSessionFactory({ kind: "unsupported_approval_bridge" });
    await expect(unsupported.factory.resolveApproval({
      runId: "run_1",
      codexThreadId: "thread_1",
      runtimeApprovalToken: "pause-1",
      decision: "approved",
      message: "ok"
    })).rejects.toMatchObject({ reasonCode: "codex_approval_bridge_unsupported" });
  });

  it("malformed stream, timeout, cancel and double resume are deterministic", async () => {
    const malformed = createFakeCodexInteractiveSessionFactory({ kind: "malformed_stream" });
    const malformedTurn = await malformed.factory.startTurn({ runId: "run_1", cwd: "/repo", task: "hello" });
    const malformedEvents = await collect(malformedTurn.events());
    expect(malformedEvents.some((event) => typeof event.type !== "string")).toBe(true);

    const timeout = createFakeCodexInteractiveSessionFactory({ kind: "active_timeout" });
    const timeoutTurn = await timeout.factory.startTurn({ runId: "run_1", cwd: "/repo", task: "hello" });
    const iter = timeoutTurn.events()[Symbol.asyncIterator]();
    await iter.next();
    await timeout.factory.cancel({ runId: "run_1", codexThreadId: "thread_1" });
    timeout.state.releaseHeldResume();

    const doubleResume = createFakeCodexInteractiveSessionFactory({ kind: "double_resume" });
    const first = doubleResume.factory.resumeTurn({ runId: "run_1", cwd: "/repo", codexThreadId: "thread_1", text: "a" });
    await Promise.resolve();
    await expect(doubleResume.factory.resumeTurn({ runId: "run_1", cwd: "/repo", codexThreadId: "thread_1", text: "b" })).rejects.toMatchObject({
      reasonCode: "runtime_input_in_flight"
    });
    doubleResume.state.releaseHeldResume();
    await first;
  });

  it("transcript truncation and secret fixtures are deterministic", async () => {
    const long = createFakeCodexInteractiveSessionFactory({ kind: "transcript_truncation" });
    const longTurn = await long.factory.startTurn({ runId: "run_1", cwd: "/repo", task: "hello" });
    const longEvents = await collect(longTurn.events());
    const content = JSON.stringify(longEvents);
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(1024 * 1024);

    const secret = createFakeCodexInteractiveSessionFactory({ kind: "secret_redaction" });
    const secretTurn = await secret.factory.startTurn({ runId: "run_1", cwd: "/repo", task: "hello" });
    const secretEvents = await collect(secretTurn.events());
    const serialized = JSON.stringify(secretEvents);
    expect(serialized).toContain("apiKey");
    expect(serialized).toContain("authorization");
    expect(serialized).toContain("token");
    expect(serialized).toContain("password");
  });
});
