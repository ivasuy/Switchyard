import { describe, expect, it } from "vitest";
import { FakeRuntimeAdapter } from "@switchyard/testkit";

describe("runtime adapter contract", () => {
  it("supports check, start, events, send, cancel, tools, and artifacts", async () => {
    const adapter = new FakeRuntimeAdapter();
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

    await adapter.send(session, { text: "continue" });
    await adapter.cancel(session);
    const tools = await adapter.tools(session);
    const artifacts = await adapter.artifacts(session);

    expect(check.ok).toBe(true);
    expect(session.sessionId).toMatch(/^session_/);
    expect(events.map((event) => event.type)).toEqual(["runtime.status", "runtime.output", "run.completed"]);
    expect(tools).toEqual(["fake.echo"]);
    expect(artifacts[0]).toMatchObject({ type: "transcript" });
  });
});
