import { InMemoryArtifactStore, InMemoryEventStore, InMemoryRegistryStore, InMemoryRunStore, InMemorySessionStore } from "./fake-stores.js";

class HarnessQueue {
  readonly jobs: Array<{ id: string; runId: string; placement: string; runtimeMode?: string }> = [];

  async enqueue(input: { runId: string; placement: string; runtimeMode?: string }): Promise<{ jobId: string; runId: string; placement: string; runtimeMode?: string; createdAt: string }> {
    const jobId = `job_${this.jobs.length + 1}`;
    const item: { id: string; runId: string; placement: string; runtimeMode?: string } = {
      id: jobId,
      runId: input.runId,
      placement: input.placement
    };
    const out: { jobId: string; runId: string; placement: string; runtimeMode?: string; createdAt: string } = {
      jobId,
      runId: input.runId,
      placement: input.placement,
      createdAt: new Date().toISOString()
    };
    if (input.runtimeMode !== undefined) {
      item.runtimeMode = input.runtimeMode;
      out.runtimeMode = input.runtimeMode;
    }
    this.jobs.push(item);
    return out;
  }
}

export function createHostedTestHarness() {
  return {
    runs: new InMemoryRunStore(),
    events: new InMemoryEventStore(),
    sessions: new InMemorySessionStore(),
    artifacts: new InMemoryArtifactStore(),
    registry: new InMemoryRegistryStore(),
    queue: new HarnessQueue()
  };
}
