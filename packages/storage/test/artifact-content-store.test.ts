import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { LocalObjectArtifactContentStore, MemoryArtifactContentStore, ObjectArtifactContentStore } from "../src/index.js";

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

  it("supports opt-in local object-compatible persistence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchyard-objects-"));
    try {
      const store = new LocalObjectArtifactContentStore(dir);
      const saved = await store.writeText("runs/run_1/file.txt", "content", { contentType: "text/plain" });
      expect(saved.storageBackend).toBe("object");
      expect(saved.objectKey).toBe("artifacts/runs/run_1/file.txt");
      const read = await store.read({
        id: "artifact_3",
        runId: "run_1",
        type: "raw_log",
        path: "runs/run_1/file.txt",
        metadata: { objectKey: saved.objectKey, contentType: saved.contentType },
        createdAt: "2026-05-30T00:00:00.000Z"
      });
      expect(read.body.toString("utf8")).toBe("content");
      const digestMismatchArtifact = {
        id: "artifact_4",
        runId: "run_1",
        type: "raw_log" as const,
        path: "runs/run_1/file.txt",
        metadata: { objectKey: saved.objectKey, contentType: saved.contentType, sha256: "0".repeat(64), sizeBytes: 7 },
        createdAt: "2026-05-30T00:00:00.000Z"
      };
      await expect(store.read(digestMismatchArtifact as any)).rejects.toThrow("artifact_digest_mismatch");
      await expect(store.read({
        ...digestMismatchArtifact,
        metadata: { objectKey: saved.objectKey, contentType: saved.contentType, sha256: saved.sha256, sizeBytes: 1 }
      } as any)).rejects.toThrow("artifact_sync_failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
