import Fastify from "fastify";
import { RunService, RuntimeRunnerService } from "@switchyard/core";
import { registerRunRoutes } from "@switchyard/protocol-rest";
import { FakeRuntimeAdapter, InMemoryEventStore, InMemoryRunStore, InMemorySessionStore } from "@switchyard/testkit";

export function createDaemonApp() {
  const app = Fastify({ logger: false });
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const sessions = new InMemorySessionStore();
  const adapters = new Map([["fake", new FakeRuntimeAdapter()]]);
  const runner = new RuntimeRunnerService({
    runs,
    events,
    sessions,
    adapters
  });
  const runService = new RunService({
    runs,
    events,
    runner
  });

  app.get("/health", async () => ({ ok: true }));
  registerRunRoutes(app, { runs, events, runService });

  return app;
}
