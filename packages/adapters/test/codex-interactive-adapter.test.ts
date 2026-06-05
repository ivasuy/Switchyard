import { describe, expect, it } from "vitest";
import { AdapterProtocolError, type RuntimeAdapter } from "@switchyard/core";
import {
  CODEX_INTERACTIVE_RUNTIME_MODE_SLUG,
  CodexAdapterRouter,
  CodexExecJsonAdapter,
  CodexInteractiveAdapter,
  type CodexInteractiveSessionFactory
} from "../src/index.js";
import { createFakeCodexInteractiveSessionFactory } from "@switchyard/testkit";

const FAKE_REQUEST = {
  runId: "run_1",
  runtime: "codex",
  runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG,
  provider: "openai",
  model: "gpt-5",
  cwd: "/repo",
  task: "do work",
  metadata: {}
};

async function take(iter: AsyncIterable<unknown>, count: number): Promise<unknown[]> {
  const out: unknown[] = [];
  const iterator = iter[Symbol.asyncIterator]();
  for (let index = 0; index < count; index += 1) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000))
    ]);
    if (next.done) {
      break;
    }
    out.push(next.value);
  }
  return out;
}

describe("codex interactive adapter", () => {
  it("exports a local explicit interactive manifest", async () => {
    const fake = createFakeCodexInteractiveSessionFactory();
    const adapter = new CodexInteractiveAdapter({ sessionFactory: fake.factory, approvalBridgeSupported: false });

    expect(adapter.manifest.runtimeModeSlug).toBe(CODEX_INTERACTIVE_RUNTIME_MODE_SLUG);
    expect(adapter.manifest.kind).toBe("interactive_process");
    expect(adapter.manifest.placement.hosted.support).toBe("unsupported");
    expect(adapter.manifest.capabilities).toContain("run.input");
    expect(adapter.manifest.capabilities).not.toContain("approval.bridge");

    const check = await adapter.check({ runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG });
    expect(check.ok).toBe(true);
  });

  it("start emits waiting_for_input with thread patch and resume works", async () => {
    const fake = createFakeCodexInteractiveSessionFactory({ kind: "default" });
    const adapter = new CodexInteractiveAdapter({ sessionFactory: fake.factory, approvalBridgeSupported: true });

    const session = await adapter.start(FAKE_REQUEST);
    const events = await take(adapter.events({ ...session, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }), 4);
    expect(events.map((event) => (event as { type: string }).type)).toEqual(
      expect.arrayContaining(["runtime.status", "runtime.output"])
    );

    await adapter.send({ ...session, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }, { text: "continue" });
    expect(fake.state.resumes[0]?.codexThreadId).toBe("thread_1");
  });

  it("terminal completion blocks further input", async () => {
    const fake = createFakeCodexInteractiveSessionFactory({ kind: "terminal_completion" });
    const adapter = new CodexInteractiveAdapter({ sessionFactory: fake.factory, approvalBridgeSupported: true });

    const session = await adapter.start(FAKE_REQUEST);
    await take(adapter.events({ ...session, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }), 3);

    await expect(adapter.send({ ...session, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }, { text: "late" })).rejects.toMatchObject({
      reasonCode: "runtime_input_not_active"
    } satisfies Partial<AdapterProtocolError>);
  });

  it("missing resume token and malformed streams fail with named reasons", async () => {
    const missing = createFakeCodexInteractiveSessionFactory({ kind: "missing_token" });
    const missingAdapter = new CodexInteractiveAdapter({ sessionFactory: missing.factory, approvalBridgeSupported: true });
    const missingSession = await missingAdapter.start(FAKE_REQUEST);
    const missingEvents = await take(missingAdapter.events({ ...missingSession, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }), 4);
    const missingFailed = missingEvents.find((event) => (event as { type: string }).type === "run.failed") as { payload: Record<string, unknown> } | undefined;
    expect(missingFailed?.payload["reasonCode"]).toBe("codex_resume_token_missing");

    const malformed = createFakeCodexInteractiveSessionFactory({ kind: "malformed_stream" });
    const malformedAdapter = new CodexInteractiveAdapter({ sessionFactory: malformed.factory, approvalBridgeSupported: true });
    const malformedSession = await malformedAdapter.start(FAKE_REQUEST);
    const malformedEvents = await take(malformedAdapter.events({ ...malformedSession, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }), 4);
    const malformedFailed = malformedEvents.find((event) => (event as { type: string }).type === "run.failed") as { payload: Record<string, unknown> } | undefined;
    expect(malformedFailed?.payload["reasonCode"]).toBe("codex_stream_malformed");
  });

  it("approval bridge unsupported and stale token are named", async () => {
    const unsupported = createFakeCodexInteractiveSessionFactory({ kind: "unsupported_approval_bridge" });
    const unsupportedAdapter = new CodexInteractiveAdapter({ sessionFactory: unsupported.factory, approvalBridgeSupported: false });
    const session = await unsupportedAdapter.start(FAKE_REQUEST);
    await expect(unsupportedAdapter.send({ ...session, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }, {
      type: "approval_resolution",
      runtimeApprovalToken: "pause-1",
      decision: "approved",
      message: "ok"
    })).rejects.toMatchObject({ reasonCode: "codex_approval_bridge_unsupported" });

    const approval = createFakeCodexInteractiveSessionFactory({ kind: "approval_requested" });
    const approvalAdapter = new CodexInteractiveAdapter({ sessionFactory: approval.factory, approvalBridgeSupported: true });
    const approvalSession = await approvalAdapter.start(FAKE_REQUEST);
    await take(approvalAdapter.events({ ...approvalSession, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }), 3);
    await expect(approvalAdapter.send({ ...approvalSession, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }, {
      type: "approval_resolution",
      runtimeApprovalToken: "unknown-token",
      decision: "approved",
      message: "ok"
    })).rejects.toMatchObject({ reasonCode: "runtime_approval_pause_not_active" });
  });

  it("double resume rejects with runtime_input_in_flight", async () => {
    const fake = createFakeCodexInteractiveSessionFactory({ kind: "double_resume" });
    const adapter = new CodexInteractiveAdapter({ sessionFactory: fake.factory, approvalBridgeSupported: true });
    const session = await adapter.start(FAKE_REQUEST);
    await take(adapter.events({ ...session, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }), 3);

    const first = adapter.send({ ...session, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }, { text: "one" });
    await Promise.resolve();
    await expect(adapter.send({ ...session, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }, { text: "two" })).rejects.toMatchObject({
      reasonCode: "runtime_input_in_flight"
    } satisfies Partial<AdapterProtocolError>);
    fake.state.releaseHeldResume();
    await first;
  });

  it("artifacts are bounded and redacted", async () => {
    const long = createFakeCodexInteractiveSessionFactory({ kind: "transcript_truncation" });
    const adapter = new CodexInteractiveAdapter({ sessionFactory: long.factory, approvalBridgeSupported: true });
    const session = await adapter.start(FAKE_REQUEST);
    await take(adapter.events({ ...session, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }), 4);
    const artifacts = await adapter.artifacts({ ...session, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG });
    expect(artifacts[0]?.path).toContain("codex-interactive-raw-transcript");
    expect(artifacts[1]?.path).toContain("codex-interactive-normalized-transcript");
    expect(artifacts[0]?.metadata["truncated"]).toBe(true);

    const secret = createFakeCodexInteractiveSessionFactory({ kind: "secret_redaction" });
    const secretAdapter = new CodexInteractiveAdapter({ sessionFactory: secret.factory, approvalBridgeSupported: true });
    const secretSession = await secretAdapter.start(FAKE_REQUEST);
    await take(secretAdapter.events({ ...secretSession, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG }), 3);
    const secretArtifacts = await secretAdapter.artifacts({ ...secretSession, runId: "run_1", runtimeMode: CODEX_INTERACTIVE_RUNTIME_MODE_SLUG });
    const serialized = JSON.stringify(secretArtifacts);
    expect(serialized).not.toContain("Bearer fake");
    expect(serialized).not.toContain("apiKey=abc");
  });

  it("router preserves exec_json default semantics and dispatches interactive explicitly", async () => {
    const fake = createFakeCodexInteractiveSessionFactory();
    const interactive = new CodexInteractiveAdapter({ sessionFactory: fake.factory, approvalBridgeSupported: true });
    const exec = new CodexExecJsonAdapter();
    const router = new CodexAdapterRouter({ execAdapter: exec as RuntimeAdapter, interactiveAdapter: interactive as RuntimeAdapter });

    await expect(router.start({
      runId: "run_1",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      cwd: "/repo",
      task: "work"
    })).resolves.toMatchObject({ sessionId: expect.any(String) });

    const interactiveSession = await router.start({ ...FAKE_REQUEST });
    expect(interactiveSession.sessionId).toMatch(/^session_/);

    await expect(router.start({ ...FAKE_REQUEST, runtimeMode: "codex.pty" })).rejects.toMatchObject({
      reasonCode: "codex_runtime_mode_unsupported"
    } satisfies Partial<AdapterProtocolError>);
  });

  it("fake factory is structurally compatible with CodexInteractiveSessionFactory", () => {
    const { factory } = createFakeCodexInteractiveSessionFactory();
    const _contract: CodexInteractiveSessionFactory = factory;
    expect(_contract).toBeDefined();
  });
});
