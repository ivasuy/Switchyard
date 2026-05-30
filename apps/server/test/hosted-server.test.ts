import { describe, expect, it } from "vitest";
import { createServerApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";

describe("hosted server", () => {
  it("completes hosted fake run with wait", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      redactedSummary: {}
    });
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
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: [],
      redactedSummary: {}
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.hostedAllowlist.code).toBe("hosted_runtime_not_allowed");

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
      SWITCHYARD_OBJECT_STORE_DIR: "/tmp/switchyard-objects",
      SWITCHYARD_NODE_SHARED_TOKEN: "token",
      SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
      SWITCHYARD_DEPLOYMENT_MODE: "staging"
    });

    expect(config.postgresUrl).toContain("postgres://");
    expect(config.redisUrl).toBe("redis://localhost:6379/0");
    expect(config.queueName).toBe("switchyard-hosted");
    expect(config.objectStoreDir).toBe("/tmp/switchyard-objects");
    expect(config.deploymentMode).toBe("staging");
  });

  it("exposes readiness and hosted metrics", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      redactedSummary: {}
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().ok).toBe(true);

      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.json().queue).toBeDefined();
      expect(metrics.json().dependencies).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("fails closed in staging for missing dependencies", () => {
    expect(() =>
      loadServerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_POSTGRES_URL: "postgres://localhost/db",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/store",
        SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
        SWITCHYARD_NODE_SHARED_TOKEN: "token"
      })
    ).toThrow("config_required:SWITCHYARD_REDIS_URL");
  });

  it("fails closed in staging when hosted allowlist is missing", () => {
    expect(() =>
      loadServerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_POSTGRES_URL: "postgres://localhost/db",
        SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/store",
        SWITCHYARD_NODE_SHARED_TOKEN: "token"
      })
    ).toThrow("config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST");
  });

  it("keeps local default hosted allowlist when env is absent", () => {
    const config = loadServerConfig({
      SWITCHYARD_DEPLOYMENT_MODE: "local"
    });
    expect(config.hostedRuntimeAllowlist).toEqual(["fake.deterministic"]);
  });
});
