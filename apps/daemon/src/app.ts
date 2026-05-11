import Fastify from "fastify";
import { RunService } from "@switchyard/core";
import { registerRunRoutes } from "@switchyard/protocol-rest";
import { FakeRuntimeAdapter, InMemoryEventStore, InMemoryRunStore } from "@switchyard/testkit";

export function createDaemonApp() {
  const app = Fastify({ logger: false });
  const runs = new InMemoryRunStore();
  const events = new InMemoryEventStore();
  const runService = new RunService({
    runs,
    events,
    adapters: new Map([["fake", new FakeRuntimeAdapter()]])
  });

  app.get("/health", async () => ({ ok: true }));
  registerRunRoutes(app, { runs, events, runService });

  return app;
}
