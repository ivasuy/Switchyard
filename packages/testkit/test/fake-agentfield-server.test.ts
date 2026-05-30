import { describe, expect, it } from "vitest";
import { startFakeAgentFieldServer } from "../src/index.js";

describe("fake agentfield server", () => {
  it("serves health, discovery, async execute, and status polling flows", async () => {
    const server = await startFakeAgentFieldServer({ scenario: "happy" });
    try {
      const health = await fetch(server.url("/api/v1/health"));
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok" });

      const discovery = await fetch(server.url("/api/v1/discovery/capabilities?format=compact"));
      expect(discovery.status).toBe(200);
      const discoveryBody = await discovery.json() as { targets: string[] };
      expect(discoveryBody.targets).toContain("research-agent.deep_analysis");

      const started = await fetch(server.url("/api/v1/execute/async/research-agent.deep_analysis"), {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            prompt: "hello"
          }
        })
      });
      expect(started.status).toBe(202);
      const startedBody = await started.json() as { execution_id: string };
      expect(startedBody.execution_id).toMatch(/^exec_/);

      const first = await fetch(server.url(`/api/v1/executions/${startedBody.execution_id}`));
      expect(first.status).toBe(200);
      const firstBody = await first.json() as { status: string };
      expect(firstBody.status).toBe("running");

      const second = await fetch(server.url(`/api/v1/executions/${startedBody.execution_id}`));
      expect(second.status).toBe(200);
      const secondBody = await second.json() as { status: string; result?: unknown };
      expect(secondBody.status).toBe("succeeded");
      expect(secondBody.result).toBeDefined();

      expect(server.stats.executeAsyncCalls).toBe(1);
      expect(server.stats.pollCalls).toBeGreaterThanOrEqual(2);
      expect(server.stats.healthCalls).toBe(1);
      expect(server.stats.discoveryCalls).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("enforces bearer auth when expected token is configured", async () => {
    const server = await startFakeAgentFieldServer({
      scenario: "happy",
      expectedApiKey: "af-key-1"
    });
    try {
      const unauthenticated = await fetch(server.url("/api/v1/health"));
      expect(unauthenticated.status).toBe(401);

      const authenticated = await fetch(server.url("/api/v1/health"), {
        headers: {
          authorization: "Bearer af-key-1"
        }
      });
      expect(authenticated.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
