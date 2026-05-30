import { describe, expect, it } from "vitest";
import type { SwitchyardEvent } from "@switchyard/contracts";
import { ClaudeCodeAdapter } from "../src/claude-code/claude-code-adapter.js";
import { createFakeClaudeCodeClient, createFakeClaudeLiveProbe } from "@switchyard/testkit";

function makeStartRequest(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run_claude",
    runtime: "claude_code",
    provider: "anthropic",
    model: "claude-code-default",
    cwd: "/repo",
    task: "Inspect code",
    metadata: {},
    ...overrides
  };
}

describe("ClaudeCodeAdapter", () => {
  it("exposes claude_code.sdk manifest with interactive capabilities", () => {
    const { client } = createFakeClaudeCodeClient();
    const adapter = new ClaudeCodeAdapter({ client });

    expect(adapter.manifest.runtimeModeSlug).toBe("claude_code.sdk");
    expect(adapter.manifest.kind).toBe("sdk");
    expect(adapter.manifest.capabilities).toEqual(expect.arrayContaining([
      "run.input",
      "session.state",
      "approval.bridge",
      "tool.call.normalized",
      "tool.result.normalized",
      "user.question"
    ]));
    expect(adapter.manifest.capabilities).not.toContain("session.resume");
    expect(adapter.manifest.placement.hosted.support).toBe("unsupported");
  });

  it("returns live_probe_disabled when check runs without live probe", async () => {
    const { client } = createFakeClaudeCodeClient();
    const adapter = new ClaudeCodeAdapter({
      client,
      doctor: {
        probeVersion: async () => ({ ok: true, version: "2.1.156" }),
        probeAuth: async () => ({ ok: true })
      },
      liveProbe: false
    });

    const check = await adapter.check();
    expect(check.details?.["availability"]).toMatchObject({
      state: "installed",
      reasonCode: "live_probe_disabled"
    });
  });

  it("passes safe budget and flags to enabled live probe", async () => {
    const { client, state } = createFakeClaudeCodeClient();
    const adapter = new ClaudeCodeAdapter({
      client,
      liveProbe: true,
      maxBudgetUsd: 0.05,
      permissionMode: "read_only",
      disabledTools: ["Bash"],
      doctor: {
        probeVersion: async () => ({ ok: true, version: "2.1.156" }),
        probeAuth: async () => ({ ok: true }),
        runLiveProbe: createFakeClaudeLiveProbe(state)
      }
    });

    await adapter.check();

    expect(state.liveProbeCalls).toEqual([{ maxBudgetUsd: 0.05, permissionMode: "read_only", disabledTools: ["Bash"] }]);
  });

  it("streams output events and supports post-start text input", async () => {
    const fake = createFakeClaudeCodeClient({
      initialEvents: [{ type: "session", sessionId: "claude-session-1" }],
      waitForInputText: true
    });
    const adapter = new ClaudeCodeAdapter({ client: fake.client });
    const session = await adapter.start(makeStartRequest());

    const iterator = adapter.events({ ...session, runId: "run_claude" })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.type).toBe("runtime.status");

    await adapter.send({ ...session, runId: "run_claude" }, { text: "continue" });

    const events = [];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
      events.push(event);
    }
    expect(fake.state.sentUserMessages).toEqual(["continue"]);
    expect(events.some((event) => event.type === "runtime.output")).toBe(true);
    expect(events.some((event) => event.type === "run.completed")).toBe(true);

    const artifacts = await adapter.artifacts({ ...session, runId: "run_claude" });
    expect(artifacts.map((artifact) => artifact.path).sort()).toEqual([
      "runs/run_claude/claude-code-normalized-transcript.jsonl",
      "runs/run_claude/claude-code-raw-transcript.jsonl"
    ]);
  });

  it("maps approval pauses and resolves approval callbacks", async () => {
    const fake = createFakeClaudeCodeClient({ approvalToken: "pause-1" });
    const adapter = new ClaudeCodeAdapter({ client: fake.client });
    const session = await adapter.start(makeStartRequest());

    const seen: SwitchyardEvent[] = [];
    const drainPromise = (async () => {
      for await (const event of adapter.events({ ...session, runId: "run_claude" })) {
        seen.push(event);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen[0]).toMatchObject({ type: "approval.requested" });

    await adapter.send({ ...session, runId: "run_claude" }, {
      type: "approval_resolution",
      runtimeApprovalToken: "pause-1",
      decision: "approved",
      message: "approved by local-user"
    });
    await drainPromise;

    expect(fake.state.resolvedApprovals).toHaveLength(1);
    expect(fake.state.resolvedApprovals[0]?.runtimeApprovalToken).toBe("pause-1");
    expect(seen.some((event) => event.type === "run.completed")).toBe(true);
  });

  it("fails stale approval resolutions with runtime_approval_pause_not_active", async () => {
    const fake = createFakeClaudeCodeClient();
    const adapter = new ClaudeCodeAdapter({ client: fake.client });
    const session = await adapter.start(makeStartRequest());

    await expect(adapter.send({ ...session, runId: "run_claude" }, {
      type: "approval_resolution",
      runtimeApprovalToken: "missing",
      decision: "approved",
      message: "approved"
    })).rejects.toMatchObject({ reasonCode: "runtime_approval_pause_not_active" });
  });

  it("enforces unknown-event flood suppression after 100 events", async () => {
    const fake = createFakeClaudeCodeClient({ includeUnknownEvents: 150 });
    const adapter = new ClaudeCodeAdapter({ client: fake.client });
    const session = await adapter.start(makeStartRequest());

    const events = [];
    for await (const event of adapter.events({ ...session, runId: "run_claude" })) {
      events.push(event);
    }

    const unknown = events.filter((event) => event.type === "runtime.status" && event.payload["status"] === "provider_event_unknown");
    const suppressed = events.filter((event) => event.type === "runtime.status" && event.payload["status"] === "provider_event_unknown_suppressed");
    expect(unknown).toHaveLength(100);
    expect(suppressed).toHaveLength(1);
  });

  it("rejects dangerous bypass metadata and relative cwd", async () => {
    const fake = createFakeClaudeCodeClient();
    const adapter = new ClaudeCodeAdapter({ client: fake.client });

    await expect(adapter.start(makeStartRequest({ cwd: "repo" }))).rejects.toMatchObject({ reasonCode: "claude_cwd_not_absolute" });
    await expect(adapter.start(makeStartRequest({ metadata: { "dangerously-skip-permissions": true } }))).rejects.toMatchObject({
      reasonCode: "claude_permission_bypass_denied"
    });
  });
});
