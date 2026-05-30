import { describe, expect, it } from "vitest";
import {
  AcpProtocolError,
  AcpResponseError,
  AcpStdioClient,
  acpInitializeResultSchema,
  acpSessionNewResultSchema
} from "@switchyard/protocol-acpx";
import { createFakeAcpProcessFactory, type FakeAcpRuntimeScenario } from "../src/fake-acp-runtime.js";

describe("fake ACP runtime", () => {
  it("supports happy and empty_output scenarios", async () => {
    const happy = await runPromptScenario("happy");
    expect(acpInitializeResultSchema.parse(happy.initialize).protocolVersion).toBe(1);
    expect(acpSessionNewResultSchema.parse(happy.sessionNew).sessionId).toBe("ses_fake_acp_1");
    expect(happy.promptResult).toEqual({ stopReason: "end_turn" });
    expect(happy.notifications.some((event) => event.type === "notification")).toBe(true);

    const empty = await runPromptScenario("empty_output");
    expect(empty.promptResult).toEqual({ stopReason: "end_turn" });
    expect(empty.notifications.some((event) => event.type === "notification")).toBe(false);
  });

  it("supports cancelled and cancel_unverified scenarios", async () => {
    const cancelledClient = createClient("cancelled");
    await cancelledClient.start();
    await cancelledClient.request("initialize", { protocolVersion: 1 });
    await cancelledClient.request("session/new", { cwd: "/repo", mcpServers: [] });
    const promptPromise = cancelledClient.request("session/prompt", {
      sessionId: "ses_fake_acp_1",
      prompt: [{ type: "text", text: "hi" }]
    }, { timeoutMs: 1000 });
    await cancelledClient.notify("session/cancel", { sessionId: "ses_fake_acp_1" });
    await expect(promptPromise).resolves.toEqual({ stopReason: "cancelled" });

    const unverifiedClient = createClient("cancel_unverified");
    await unverifiedClient.start();
    await unverifiedClient.request("initialize", { protocolVersion: 1 });
    await unverifiedClient.request("session/new", { cwd: "/repo", mcpServers: [] });
    const unverifiedPrompt = unverifiedClient.request("session/prompt", {
      sessionId: "ses_fake_acp_1",
      prompt: [{ type: "text", text: "hi" }]
    }, { timeoutMs: 30 });
    await unverifiedClient.notify("session/cancel", { sessionId: "ses_fake_acp_1" });
    await expect(unverifiedPrompt).rejects.toMatchObject({
      reasonCode: "acp_request_timeout"
    } satisfies Partial<AcpProtocolError>);
  });

  it("supports failure and invalid protocol scenarios", async () => {
    const failed = createClient("prompt_failed");
    await failed.start();
    await failed.request("initialize", { protocolVersion: 1 });
    await failed.request("session/new", { cwd: "/repo", mcpServers: [] });
    await expect(failed.request("session/prompt", {
      sessionId: "ses_fake_acp_1",
      prompt: [{ type: "text", text: "boom" }]
    })).rejects.toBeInstanceOf(AcpResponseError);

    const invalidJson = createClient("invalid_json");
    await invalidJson.start();
    await expect(invalidJson.request("initialize", { protocolVersion: 1 }, { timeoutMs: 1000 })).rejects.toMatchObject({
      reasonCode: "acp_invalid_json"
    } satisfies Partial<AcpProtocolError>);

    const invalidInit = createClient("invalid_initialize");
    await invalidInit.start();
    const initResult = await invalidInit.request("initialize", { protocolVersion: 1 });
    expect(() => acpInitializeResultSchema.parse(initResult)).toThrow();

    const invalidSession = createClient("invalid_session_new");
    await invalidSession.start();
    await invalidSession.request("initialize", { protocolVersion: 1 });
    const sessionResult = await invalidSession.request("session/new", { cwd: "/repo", mcpServers: [] });
    expect(() => acpSessionNewResultSchema.parse(sessionResult)).toThrow();
  });

  it("supports permission_request, stderr_warning, and oversized_message scenarios", async () => {
    const permissionClient = createClient("permission_request");
    await permissionClient.start();
    await permissionClient.request("initialize", { protocolVersion: 1 });
    await permissionClient.request("session/new", { cwd: "/repo", mcpServers: [] });
    const events = permissionClient.notifications()[Symbol.asyncIterator]();
    const prompt = permissionClient.request("session/prompt", {
      sessionId: "ses_fake_acp_1",
      prompt: [{ type: "text", text: "perm" }]
    }, { timeoutMs: 200 });
    const first = await events.next();
    expect(first.value?.type).toBe("permission_request");
    await expect(prompt).resolves.toEqual({ stopReason: "refusal" });

    const stderrClient = createClient("stderr_warning");
    await stderrClient.start();
    await stderrClient.request("initialize", { protocolVersion: 1 });
    await stderrClient.request("session/new", { cwd: "/repo", mcpServers: [] });
    const stderrEvents = stderrClient.notifications()[Symbol.asyncIterator]();
    const stderrPrompt = stderrClient.request("session/prompt", {
      sessionId: "ses_fake_acp_1",
      prompt: [{ type: "text", text: "warn" }]
    });
    const stderrEvent = await stderrEvents.next();
    expect(stderrEvent.value?.type).toBe("stderr");
    await expect(stderrPrompt).resolves.toEqual({ stopReason: "end_turn" });

    const oversizedClient = createClient("oversized_message", 256);
    await oversizedClient.start();
    await oversizedClient.request("initialize", { protocolVersion: 1 });
    await oversizedClient.request("session/new", { cwd: "/repo", mcpServers: [] });
    await expect(oversizedClient.request("session/prompt", {
      sessionId: "ses_fake_acp_1",
      prompt: [{ type: "text", text: "too-big" }]
    })).rejects.toMatchObject({
      reasonCode: "acp_message_too_large"
    } satisfies Partial<AcpProtocolError>);
  });
});

async function runPromptScenario(scenario: FakeAcpRuntimeScenario): Promise<{
  initialize: unknown;
  sessionNew: unknown;
  promptResult: unknown;
  notifications: Array<{ type: string }>;
}> {
  const client = createClient(scenario);
  await client.start();
  const notifications: Array<{ type: string }> = [];
  const iterator = client.notifications()[Symbol.asyncIterator]();
  const initialize = await client.request("initialize", { protocolVersion: 1 });
  const sessionNew = await client.request("session/new", { cwd: "/repo", mcpServers: [] });
  const promptResult = await client.request("session/prompt", {
    sessionId: "ses_fake_acp_1",
    prompt: [{ type: "text", text: "hello" }]
  });
  while (true) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<{ type: string }>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 15))
    ]);
    if (next.done) {
      break;
    }
    notifications.push({ type: next.value.type });
  }
  return { initialize, sessionNew, promptResult, notifications };
}

function createClient(scenario: FakeAcpRuntimeScenario, maxMessageBytes?: number): AcpStdioClient {
  return new AcpStdioClient({
    cwd: "/repo",
    requestTimeoutMs: 200,
    ...(maxMessageBytes ? { maxMessageBytes } : {}),
    processFactory: createFakeAcpProcessFactory({
      scenario,
      ...(maxMessageBytes ? { maxMessageBytes } : {})
    })
  });
}
