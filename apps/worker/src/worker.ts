import { HostedWorkerService, RunService, RuntimeRunnerService, type RuntimeAdapter } from "@switchyard/core";
import { MemoryRunQueue } from "@switchyard/queue";
import { MemoryArtifactContentStore } from "@switchyard/storage";
import {
  FakeRuntimeAdapter,
  InMemoryArtifactStore,
  InMemoryEventStore,
  InMemoryRunStore,
  InMemorySessionStore
} from "@switchyard/testkit";
import type { WorkerConfig } from "./config.js";

export interface HostedWorkerApp {
  tick: () => Promise<boolean>;
  stop: () => Promise<void>;
}

export function createHostedWorker(config: WorkerConfig, deps?: {
  queue?: MemoryRunQueue;
  runs?: InMemoryRunStore;
  events?: InMemoryEventStore;
}): HostedWorkerApp {
  const queue = deps?.queue ?? new MemoryRunQueue();
  const runs = deps?.runs ?? new InMemoryRunStore();
  const events = deps?.events ?? new InMemoryEventStore();
  const sessions = new InMemorySessionStore();
  const artifacts = new InMemoryArtifactStore();
  const artifactContent = new MemoryArtifactContentStore();

  const adapters = new Map<string, RuntimeAdapter>([["fake", new FakeRuntimeAdapter()]]);
  const runner = new RuntimeRunnerService({
    runs,
    events,
    sessions,
    adapters,
    artifacts,
    artifactContent: {
      writeText: async (path, content) => {
        const stored = await artifactContent.writeText(path, content, { contentType: "application/x-ndjson" });
        return stored.path;
      }
    }
  });
  const runService = new RunService({ runs, events, runner });

  const service = new HostedWorkerService({
    queue,
    runs,
    events,
    startRun: async (runId) => runService.startRun(runId),
    hostedRuntimeAllowlist: config.hostedRuntimeAllowlist
  });

  return {
    tick: async () => service.processNext(),
    stop: async () => {}
  };
}
