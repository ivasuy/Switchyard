import { describe, expect, it } from "vitest";
import { PostgresMessageStore } from "../src/index.js";

describe("postgres message store", () => {
  it("creates, updates, gets, and lists with run/channel/delivery filters", async () => {
    const store = new PostgresMessageStore();

    await store.create({
      id: "message_1",
      fromRunId: "run_1",
      toRunId: "run_2",
      channel: "debate:debate_1",
      content: "first",
      attachments: [],
      deliveryStatus: "delivered",
      createdAt: "2026-06-02T00:00:00.000Z",
      deliveredAt: "2026-06-02T00:00:00.000Z"
    });

    await store.create({
      id: "message_2",
      fromRunId: "run_2",
      toRunId: "run_1",
      channel: "debate:debate_1",
      content: "second",
      attachments: [{ type: "note" }],
      deliveryStatus: "queued",
      createdAt: "2026-06-02T00:01:00.000Z"
    });

    const current = await store.get("message_2");
    expect(current?.deliveryStatus).toBe("queued");

    await store.update({
      ...(current as NonNullable<typeof current>),
      deliveryStatus: "failed"
    });

    const byRun = await store.list({ runId: "run_1", limit: 10 });
    expect(byRun.messages.map((message) => message.id)).toEqual(["message_2", "message_1"]);

    const byChannel = await store.list({ channel: "debate:debate_1", limit: 10 });
    expect(byChannel.messages).toHaveLength(2);

    const failedOnly = await store.list({ deliveryStatus: "failed", limit: 10 });
    expect(failedOnly.messages.map((message) => message.id)).toEqual(["message_2"]);

    const firstPage = await store.list({ limit: 1 });
    expect(firstPage.messages).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await store.list({ limit: 1, before: firstPage.nextCursor ?? undefined });
    expect(secondPage.messages).toHaveLength(1);
    expect(secondPage.messages[0]?.id).toBe("message_1");
  });
});
