import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryArtifactContentStore, ObjectArtifactContentStore } from "../src/index.js";

describe("artifact content stores", () => {
  it("stores and reads bytes in memory with digest metadata", async () => {
    const store = new MemoryArtifactContentStore();
    const bytes = Buffer.from("hello");
    const stored = await store.writeBytes("runs/run_1/transcript.jsonl", bytes, {
      contentType: "application/x-ndjson"
    });

    expect(stored.sizeBytes).toBe(bytes.byteLength);
    expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    const read = await store.read({
      id: "artifact_1",
      runId: "run_1",
      type: "transcript",
      path: "runs/run_1/transcript.jsonl",
      metadata: {},
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    expect(read.body.toString("utf8")).toBe("hello");
  });

  it("rejects unsafe logical path", async () => {
    const store = new MemoryArtifactContentStore();
    await expect(store.writeText("../escape", "oops")).rejects.toThrow("escapes root");
  });

  it("supports object-store shaped adapter with injected client", async () => {
    const objects = new Map<string, { body: Buffer; contentType: string }>();
    const store = new ObjectArtifactContentStore(
      {
        endpoint: "https://example.test",
        region: "auto",
        bucket: "switchyard",
        accessKeyId: "key",
        secretAccessKey: "secret",
        forcePathStyle: true,
        keyPrefix: "artifacts"
      },
      {
        async putObject(input) {
          objects.set(`${input.bucket}/${input.key}`, { body: input.body, contentType: input.contentType });
        },
        async getObject(input) {
          const hit = objects.get(`${input.bucket}/${input.key}`);
          if (!hit) throw new Error("not found");
          return hit;
        }
      }
    );

    const saved = await store.writeText("runs/run_1/file.txt", "content", { contentType: "text/plain" });
    expect(saved.objectKey).toBe("artifacts/runs/run_1/file.txt");

    const read = await store.read({
      id: "artifact_2",
      runId: "run_1",
      type: "raw_log",
      path: "runs/run_1/file.txt",
      metadata: {},
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    expect(read.body.toString("utf8")).toBe("content");
  });
});
