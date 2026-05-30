import { describe, expect, it } from "vitest";
import { createServerApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";

describe("hosted server", () => {
  it("completes hosted fake run with wait", async () => {
    const app = await createServerApp({ host: "127.0.0.1", port: 0, hostedRuntimeAllowlist: ["fake.deterministic"] });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs?wait=1",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "hosted test",
          placement: "hosted"
        }
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().run.status).toBe("completed");
    } finally {
      await app.close();
    }
  });

  it("rejects hosted unsafe runtime", async () => {
    const app = await createServerApp({ host: "127.0.0.1", port: 0, hostedRuntimeAllowlist: [] });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs",
        payload: {
          runtime: "fake",
          provider: "test",
          model: "test-model",
          adapterType: "process",
          cwd: "/repo",
          task: "bad mode",
          runtimeMode: "fake.deterministic",
          placement: "hosted"
        }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("placement_denied");
    } finally {
      await app.close();
    }
  });

  it("parses opt-in hosted infrastructure config", () => {
    const config = loadServerConfig({
      SWITCHYARD_POSTGRES_URL: "postgres://user:pass@localhost:5432/switchyard",
      SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
      SWITCHYARD_QUEUE_NAME: "switchyard-hosted",
      SWITCHYARD_OBJECT_STORE_DIR: "/tmp/switchyard-objects"
    });

    expect(config.postgresUrl).toContain("postgres://");
    expect(config.redisUrl).toBe("redis://localhost:6379/0");
    expect(config.queueName).toBe("switchyard-hosted");
    expect(config.objectStoreDir).toBe("/tmp/switchyard-objects");
  });
});
