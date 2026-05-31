import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveHostedSandboxConfig } from "@switchyard/core";
import { resolveObjectStoreConfig } from "@switchyard/storage";
import { createServerApp } from "../src/app.js";
import { loadServerConfig } from "../src/config.js";

const defaultSandbox = () => resolveHostedSandboxConfig({ deploymentMode: "test", env: {} });

describe("hosted server", () => {
  it("does not expose middleware tool invocation routes on hosted server", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/invocations",
        payload: {
          type: "fetch",
          input: { url: "https://example.com", method: "GET" }
        }
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("completes hosted fake run with wait", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
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
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
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

  it("reports hosted real runtime gate readiness failure when disabled", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic", "codex.exec_json"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.hostedRuntimeGate.code).toBe("hosted_real_runtime_disabled");
    } finally {
      await app.close();
    }
  });

  it("parses opt-in hosted infrastructure config", () => {
    const config = loadServerConfig({
      SWITCHYARD_POSTGRES_URL: "postgres://user:pass@localhost:5432/switchyard",
      SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
      SWITCHYARD_QUEUE_NAME: "switchyard-hosted",
      SWITCHYARD_OBJECT_STORE_BACKEND: "local",
      SWITCHYARD_OBJECT_STORE_DIR: "/tmp/switchyard-objects",
      SWITCHYARD_NODE_SHARED_TOKEN: "token",
      SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic",
      SWITCHYARD_DEPLOYMENT_MODE: "staging"
    });

    expect(config.postgresUrl).toContain("postgres://");
    expect(config.redisUrl).toBe("redis://localhost:6379/0");
    expect(config.queueName).toBe("switchyard-hosted");
    expect(config.objectStore.backend).toBe("local");
    expect(config.deploymentMode).toBe("staging");
    expect(config.hostedRealRuntimeExecution).toBe("disabled");
  });

  it("rejects invalid hosted real runtime gate value", () => {
    expect(() =>
      loadServerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "local",
        SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "yes"
      })
    ).toThrow("config_invalid:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION");
  });

  it("rejects production hosted real-runtime gate", () => {
    expect(() =>
      loadServerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "production",
        SWITCHYARD_POSTGRES_URL: "postgres://localhost/db",
        SWITCHYARD_REDIS_URL: "redis://localhost:6379/0",
        SWITCHYARD_OBJECT_STORE_BACKEND: "local",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/store",
        SWITCHYARD_NODE_SHARED_TOKEN: "token",
        SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: "fake.deterministic,codex.exec_json",
        SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION: "enabled"
      })
    ).toThrow(/config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION|hosted_real_runtime_production_forbidden/);
  });

  it("exposes readiness and hosted metrics", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().ok).toBe(true);
      expect(ready.json().checks.objectStore.ok).toBe(true);

      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.json().queue).toBeDefined();
      expect(metrics.json().dependencies).toBeDefined();
      expect(metrics.json().hostedRuntime).toMatchObject({
        accepted: 0,
        denied: 0,
        started: 0,
        completed: 0,
        failed: 0,
        timeout: 0,
        unsupportedInteraction: 0,
        artifactPersisted: 0
      });
      expect(metrics.json().objectStore).toMatchObject({
        reads: 0,
        writes: 0,
        failures: 0,
        probeFailures: 0,
        authFailures: 0,
        unavailable: 0,
        digestMismatches: 0
      });
    } finally {
      await app.close();
    }
  });

  it("skips local object-store probe when probe mode is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchyard-server-probe-disabled-local-"));
    const fileRoot = join(dir, "object-root-file");
    await writeFile(fileRoot, "x");
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({
        deploymentMode: "test",
        env: {
          SWITCHYARD_OBJECT_STORE_BACKEND: "local",
          SWITCHYARD_OBJECT_STORE_DIR: fileRoot,
          SWITCHYARD_OBJECT_STORE_PROBE: "disabled"
        }
      }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.objectStore.ok).toBe(true);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips s3-compatible object-store probe when probe mode is disabled", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({
        deploymentMode: "test",
        env: {
          SWITCHYARD_OBJECT_STORE_BACKEND: "s3-compatible",
          SWITCHYARD_OBJECT_STORE_ENDPOINT: "http://127.0.0.1:1",
          SWITCHYARD_OBJECT_STORE_REGION: "us-east-1",
          SWITCHYARD_OBJECT_STORE_BUCKET: "switchyard-artifacts",
          SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID: "key",
          SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY: "secret",
          SWITCHYARD_OBJECT_STORE_PROBE: "disabled"
        }
      }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().checks.objectStore.ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("fails closed in staging for missing dependencies", () => {
    expect(() =>
      loadServerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "staging",
        SWITCHYARD_POSTGRES_URL: "postgres://localhost/db",
        SWITCHYARD_OBJECT_STORE_BACKEND: "local",
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
        SWITCHYARD_OBJECT_STORE_BACKEND: "local",
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
    expect(config.objectStore.backend).toBe("memory");
  });

  it("exposes sandbox readiness states", async () => {
    const disabledApp = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: resolveHostedSandboxConfig({
        deploymentMode: "test",
        env: { SWITCHYARD_SANDBOX_ENABLED: "false" }
      }),
      redactedSummary: {}
    });

    try {
      const ready = await disabledApp.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.sandbox.code).toBe("sandbox_disabled");
    } finally {
      await disabledApp.close();
    }

    const invalidPolicyApp = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: resolveHostedSandboxConfig({
        deploymentMode: "test",
        env: { SWITCHYARD_SANDBOX_FAKE_COMMAND_ALLOWLIST: "bash" }
      }),
      redactedSummary: {}
    });

    try {
      const ready = await invalidPolicyApp.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks.sandbox.code).toBe("sandbox_policy_invalid");
    } finally {
      await invalidPolicyApp.close();
    }
  });

  it("includes sandbox metrics and has no public sandbox routes", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const metrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.json().sandbox).toMatchObject({
        jobs: 0,
        allowed: 0,
        denied: 0,
        completed: 0,
        failed: 0,
        timeout: 0,
        cancelled: 0,
        outputTruncated: 0,
        artifactTruncated: 0,
        redactions: 0
      });

      for (const route of ["/sandbox", "/exec", "/pty", "/terminal"]) {
        const res = await app.inject({ method: "POST", url: route, payload: {} });
        expect(res.statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects hosted real-runtime style requests before queue side effects", async () => {
    const app = await createServerApp({
      host: "127.0.0.1",
      port: 0,
      deploymentMode: "test",
      hostedRuntimeAllowlist: ["fake.deterministic"],
      hostedRealRuntimeExecution: "disabled",
      objectStore: resolveObjectStoreConfig({ deploymentMode: "test", env: {} }),
      sandbox: defaultSandbox(),
      redactedSummary: {}
    });
    try {
      const beforeRuns = await app.inject({ method: "GET", url: "/runs" });
      expect(beforeRuns.statusCode).toBe(200);
      expect(beforeRuns.json().runs).toHaveLength(0);

      const beforeMetrics = await app.inject({ method: "GET", url: "/metrics" });
      const beforeEnqueue = beforeMetrics.json().queue.enqueue;

      const cases = [
        { runtime: "codex", provider: "openai", model: "gpt-5", adapterType: "process", runtimeMode: "codex.exec_json" },
        { runtime: "claude_code", provider: "anthropic", model: "claude", adapterType: "native", runtimeMode: "claude_code.sdk" },
        { runtime: "opencode", provider: "opencode", model: "opencode", adapterType: "acpx", runtimeMode: "opencode.acp" },
        { runtime: "generic_http", provider: "test", model: "test", adapterType: "http", runtimeMode: "generic_http.async_rest" },
        { runtime: "agentfield", provider: "test", model: "test", adapterType: "http", runtimeMode: "agentfield.async_rest" },
        { runtime: "fake", provider: "test", model: "test-model", adapterType: "pty", runtimeMode: "fake.deterministic" },
        { runtime: "fake", provider: "test", model: "test-model", adapterType: "browser", runtimeMode: "fake.deterministic" }
      ] as const;

      for (const item of cases) {
        const response = await app.inject({
          method: "POST",
          url: "/runs",
          payload: {
            ...item,
            cwd: "/repo",
            task: "must reject",
            placement: "hosted"
          }
        });
        expect([400, 409]).toContain(response.statusCode);
        expect(response.json().error.code).toMatch(/invalid_input|placement_denied/);
      }

      const afterRuns = await app.inject({ method: "GET", url: "/runs" });
      expect(afterRuns.statusCode).toBe(200);
      expect(afterRuns.json().runs).toHaveLength(0);

      const afterMetrics = await app.inject({ method: "GET", url: "/metrics" });
      expect(afterMetrics.json().queue.enqueue).toBe(beforeEnqueue);
    } finally {
      await app.close();
    }
  });

  it("fails closed for invalid sandbox config values", () => {
    expect(() =>
      loadServerConfig({
        SWITCHYARD_DEPLOYMENT_MODE: "local",
        SWITCHYARD_SANDBOX_WALL_TIME_MS: "0"
      })
    ).toThrow("sandbox_config_invalid");
  });
});
