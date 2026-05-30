import { describe, expect, it } from "vitest";
import { EventSyncService } from "../src/services/event-sync-service.js";
import { ArtifactSyncService } from "../src/services/artifact-sync-service.js";

class InMemoryEventStore {
  items: any[] = [];
  async append(event: any) { this.items.push(event); return event; }
  async listByRun(runId: string) { return this.items.filter((event) => event.runId === runId); }
  async listByDebate() { return []; }
}

class InMemoryArtifactStore {
  items = new Map<string, any>();
  async create(artifact: any) { this.items.set(artifact.id, artifact); return artifact; }
  async get(id: string) { return this.items.get(id); }
  async update(artifact: any) { this.items.set(artifact.id, artifact); return artifact; }
  async listByRun(runId: string) { return [...this.items.values()].filter((artifact) => artifact.runId === runId); }
  async listByDebate(debateId: string) { return [...this.items.values()].filter((artifact) => artifact.debateId === debateId); }
}

class MemoryAssignments {
  items = new Map<string, any>();
  async create(record: any) { this.items.set(record.id, record); return record; }
  async get(id: string) { return this.items.get(id); }
  async update(record: any) { this.items.set(record.id, record); return record; }
  async listClaimable() { return []; }
  async claim() { return undefined; }
  async complete() { return undefined; }
  async fail(id: string, _now: string, error: string) { const row = this.items.get(id); if (!row) return undefined; const next = { ...row, status: "failed", error }; this.items.set(id, next); return next; }
  async cancel() { return undefined; }
  async expireStale() { return []; }
}

class MemoryContent {
  store = new Map<string, Buffer>();
  async writeText(path: string, text: string) {
    const bytes = Buffer.from(text, "utf8");
    this.store.set(path, bytes);
    return { path, storageBackend: "memory" as const, sizeBytes: bytes.byteLength, sha256: "", contentType: "text/plain" };
  }
  async writeBytes(path: string, bytes: Buffer, options?: { contentType?: string }) {
    this.store.set(path, bytes);
    const hash = await import("node:crypto").then((m) => m.createHash("sha256").update(bytes).digest("hex"));
    return { path, storageBackend: "memory" as const, sizeBytes: bytes.byteLength, sha256: hash, contentType: options?.contentType ?? "application/octet-stream" };
  }
  async read() { return { body: Buffer.alloc(0), contentType: "application/octet-stream" }; }
}

describe("sync services", () => {
  it("appends monotonic event batches", async () => {
    const assignments = new MemoryAssignments();
    await assignments.create({ id: "assignment_1", runId: "run_1", nodeId: "node_1", status: "claimed", retryCount: 0, lastEventSequence: 0, createdAt: "2026-05-30T00:00:00.000Z" });
    const events = new InMemoryEventStore();
    const svc = new EventSyncService({ assignments: assignments as any, events });

    const result = await svc.appendBatch("node_1", "assignment_1", {
      events: [
        {
          id: "event_1",
          type: "runtime.output",
          runId: "run_1",
          sequence: 1,
          payload: { text: "hello" },
          createdAt: "2026-05-30T00:00:00.000Z"
        }
      ],
      cursor: 0
    });

    expect(result.appended).toBe(1);
    expect(result.nextCursor).toBe(1);
  });

  it("rejects event batch with mismatched runId", async () => {
    const assignments = new MemoryAssignments();
    await assignments.create({ id: "assignment_3", runId: "run_3", nodeId: "node_1", status: "claimed", retryCount: 0, lastEventSequence: 0, createdAt: "2026-05-30T00:00:00.000Z" });
    const svc = new EventSyncService({
      assignments: assignments as any,
      events: new InMemoryEventStore()
    });

    await expect(svc.appendBatch("node_1", "assignment_3", {
      cursor: 0,
      events: [
        {
          id: "event_wrong_run",
          type: "runtime.output",
          runId: "run_other",
          sequence: 1,
          payload: { text: "bad" },
          createdAt: "2026-05-30T00:00:00.000Z"
        }
      ]
    })).rejects.toMatchObject({ code: "event_sync_conflict" });
  });

  it("rejects stale cursor retries", async () => {
    const assignments = new MemoryAssignments();
    await assignments.create({ id: "assignment_4", runId: "run_4", nodeId: "node_1", status: "running", retryCount: 0, lastEventSequence: 2, createdAt: "2026-05-30T00:00:00.000Z" });
    const events = new InMemoryEventStore();
    await events.append({
      id: "event_seed_1",
      type: "runtime.output",
      runId: "run_4",
      sequence: 1,
      payload: { text: "a" },
      createdAt: "2026-05-30T00:00:00.000Z"
    });
    await events.append({
      id: "event_seed_2",
      type: "runtime.output",
      runId: "run_4",
      sequence: 2,
      payload: { text: "b" },
      createdAt: "2026-05-30T00:00:00.000Z"
    });

    const svc = new EventSyncService({ assignments: assignments as any, events });
    await expect(svc.appendBatch("node_1", "assignment_4", {
      cursor: 1,
      events: []
    })).rejects.toMatchObject({ code: "event_sync_conflict" });
  });

  it("accepts artifact manifest and content", async () => {
    const assignments = new MemoryAssignments();
    await assignments.create({ id: "assignment_2", runId: "run_2", nodeId: "node_1", status: "claimed", retryCount: 0, lastEventSequence: 0, createdAt: "2026-05-30T00:00:00.000Z" });
    const content = Buffer.from("{}");
    const sha = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");

    const svc = new ArtifactSyncService({
      assignments: assignments as any,
      artifacts: new InMemoryArtifactStore(),
      content: new MemoryContent() as any
    });

    await svc.acceptManifest("node_1", "assignment_2", {
      artifacts: [
        {
          id: "artifact_1",
          type: "transcript",
          path: "runs/run_2/transcript.jsonl",
          contentType: "application/x-ndjson",
          sizeBytes: content.byteLength,
          sha256: sha,
          syncContent: true
        }
      ]
    });

    const result = await svc.acceptContent("node_1", "assignment_2", "artifact_1", content);
    expect(result.accepted).toBe(true);
  });
});
