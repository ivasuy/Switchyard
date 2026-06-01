import { describe, expect, it } from "vitest";
import { PostgresEvidenceStore } from "../src/index.js";

describe("postgres evidence store", () => {
  it("creates, updates, gets, and lists with debate/source/reliability/text filters", async () => {
    const store = new PostgresEvidenceStore();

    await store.create({
      id: "evidence_1",
      debateId: "debate_1",
      sourceType: "manual",
      title: "Primary source",
      snippet: "A direct quote",
      reliability: "primary",
      createdAt: "2026-06-02T00:00:00.000Z"
    });
    await store.create({
      id: "evidence_2",
      debateId: "debate_2",
      sourceType: "web",
      url: "https://example.com",
      title: "Secondary source",
      snippet: "An outside summary",
      fetchedContentPath: "evidence/evidence_2.txt",
      reliability: "secondary",
      createdAt: "2026-06-02T00:01:00.000Z"
    });

    const second = await store.get("evidence_2");
    expect(second?.sourceType).toBe("web");

    await store.update({
      ...(second as NonNullable<typeof second>),
      reliability: "primary"
    });

    const byDebate = await store.list({ debateId: "debate_1", limit: 10 });
    expect(byDebate.evidence.map((item) => item.id)).toEqual(["evidence_1"]);

    const bySource = await store.list({ sourceType: "web", limit: 10 });
    expect(bySource.evidence.map((item) => item.id)).toEqual(["evidence_2"]);

    const byReliability = await store.list({ reliability: "primary", limit: 10 });
    expect(byReliability.evidence.map((item) => item.id)).toEqual(["evidence_2", "evidence_1"]);

    const byText = await store.list({ q: "outside", limit: 10 });
    expect(byText.evidence.map((item) => item.id)).toEqual(["evidence_2"]);

    const firstPage = await store.list({ limit: 1 });
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await store.list({ limit: 1, before: firstPage.nextCursor ?? undefined });
    expect(secondPage.evidence).toHaveLength(1);
  });
});
