import { describe, expect, it } from "vitest";
import {
  createArtifactContentStoreFromObjectConfig,
  resolveObjectStoreConfig,
  type DeploymentMode
} from "../src/object-store-config.js";

describe("object store config", () => {
  it("infers memory in local/test when backend and dir are missing", () => {
    const config = resolveObjectStoreConfig({ deploymentMode: "test", env: {} });
    expect(config.backend).toBe("memory");
  });

  it("infers local when backend is missing and dir is set", () => {
    const config = resolveObjectStoreConfig({
      deploymentMode: "local",
      env: { SWITCHYARD_OBJECT_STORE_DIR: "/tmp/objects" }
    });
    expect(config.backend).toBe("local");
    if (config.backend === "local") {
      expect(config.directory).toBe("/tmp/objects");
    }
  });

  it("requires explicit non-memory backend in staging/production", () => {
    expect(() => resolveObjectStoreConfig({ deploymentMode: "staging", env: {} }))
      .toThrow("config_required:SWITCHYARD_OBJECT_STORE_BACKEND");

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "production",
      env: { SWITCHYARD_OBJECT_STORE_BACKEND: "memory" }
    })).toThrow("config_invalid:SWITCHYARD_OBJECT_STORE_BACKEND");
  });

  it("validates required s3-compatible fields", () => {
    const env = {
      SWITCHYARD_OBJECT_STORE_BACKEND: "s3-compatible",
      SWITCHYARD_OBJECT_STORE_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
      SWITCHYARD_OBJECT_STORE_REGION: "us-east-1",
      SWITCHYARD_OBJECT_STORE_BUCKET: "switchyard-artifacts"
    } satisfies NodeJS.ProcessEnv;

    expect(() => resolveObjectStoreConfig({ deploymentMode: "staging", env }))
      .toThrow("config_required:SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID");
  });

  it("parses and redacts s3-compatible configuration", () => {
    const config = resolveObjectStoreConfig({
      deploymentMode: "staging",
      env: {
        SWITCHYARD_OBJECT_STORE_BACKEND: "s3-compatible",
        SWITCHYARD_OBJECT_STORE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
        SWITCHYARD_OBJECT_STORE_REGION: "auto",
        SWITCHYARD_OBJECT_STORE_BUCKET: "switchyard-artifacts",
        SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID: "ACCESS_123",
        SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY: "SECRET_456",
        SWITCHYARD_OBJECT_STORE_FORCE_PATH_STYLE: "true",
        SWITCHYARD_OBJECT_STORE_KEY_PREFIX: "artifacts",
        SWITCHYARD_OBJECT_STORE_REQUEST_TIMEOUT_MS: "7777",
        SWITCHYARD_OBJECT_STORE_PROBE: "write_read_delete"
      }
    });

    expect(config.backend).toBe("s3-compatible");
    if (config.backend === "s3-compatible") {
      expect(config.endpoint).toBe("https://account.r2.cloudflarestorage.com");
      expect(config.forcePathStyle).toBe(true);
      expect(config.requestTimeoutMs).toBe(7777);
      expect(config.redactedSummary).toMatchObject({
        endpointScheme: "https",
        endpointHost: "account.r2.cloudflarestorage.com",
        hasAccessKeyId: true,
        hasSecretAccessKey: true
      });
      expect(JSON.stringify(config.redactedSummary)).not.toContain("ACCESS_123");
      expect(JSON.stringify(config.redactedSummary)).not.toContain("SECRET_456");
    }
  });

  it("rejects invalid endpoints, key prefixes, booleans, and probe modes", () => {
    const base = {
      SWITCHYARD_OBJECT_STORE_BACKEND: "s3-compatible",
      SWITCHYARD_OBJECT_STORE_REGION: "us-east-1",
      SWITCHYARD_OBJECT_STORE_BUCKET: "switchyard-artifacts",
      SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID: "key",
      SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY: "secret"
    } satisfies NodeJS.ProcessEnv;

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "staging",
      env: { ...base, SWITCHYARD_OBJECT_STORE_ENDPOINT: "http://s3.us-east-1.amazonaws.com" }
    })).toThrow("config_invalid:SWITCHYARD_OBJECT_STORE_ENDPOINT");

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "test",
      env: { ...base, SWITCHYARD_OBJECT_STORE_ENDPOINT: "https://user:pass@example.com" }
    })).toThrow("config_invalid:SWITCHYARD_OBJECT_STORE_ENDPOINT");

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "test",
      env: { ...base, SWITCHYARD_OBJECT_STORE_ENDPOINT: "http://evil.example.com" }
    })).toThrow("config_invalid:SWITCHYARD_OBJECT_STORE_ENDPOINT");

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "test",
      env: { ...base, SWITCHYARD_OBJECT_STORE_ENDPOINT: "http://minio:9000" }
    })).toThrow("config_invalid:SWITCHYARD_OBJECT_STORE_ENDPOINT");

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "test",
      env: {
        ...base,
        SWITCHYARD_OBJECT_STORE_ENDPOINT: "https://s3.us-east-1.amazonaws.com?x=1"
      }
    })).toThrow("config_invalid:SWITCHYARD_OBJECT_STORE_ENDPOINT");

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "test",
      env: {
        ...base,
        SWITCHYARD_OBJECT_STORE_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
        SWITCHYARD_OBJECT_STORE_KEY_PREFIX: "../bad"
      }
    })).toThrow("config_invalid:SWITCHYARD_OBJECT_STORE_KEY_PREFIX");

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "test",
      env: {
        ...base,
        SWITCHYARD_OBJECT_STORE_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
        SWITCHYARD_OBJECT_STORE_FORCE_PATH_STYLE: "maybe"
      }
    })).toThrow("config_invalid:SWITCHYARD_OBJECT_STORE_FORCE_PATH_STYLE");

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "production",
      env: {
        ...base,
        SWITCHYARD_OBJECT_STORE_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
        SWITCHYARD_OBJECT_STORE_PROBE: "disabled"
      }
    })).toThrow("config_invalid:SWITCHYARD_OBJECT_STORE_PROBE");
  });

  it("allows loopback http endpoints in local/test only", () => {
    const base = {
      SWITCHYARD_OBJECT_STORE_BACKEND: "s3-compatible",
      SWITCHYARD_OBJECT_STORE_REGION: "us-east-1",
      SWITCHYARD_OBJECT_STORE_BUCKET: "switchyard-artifacts",
      SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID: "key",
      SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY: "secret"
    } satisfies NodeJS.ProcessEnv;

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "test",
      env: { ...base, SWITCHYARD_OBJECT_STORE_ENDPOINT: "http://localhost:9000" }
    })).not.toThrow();

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "local",
      env: { ...base, SWITCHYARD_OBJECT_STORE_ENDPOINT: "http://127.0.0.1:9000" }
    })).not.toThrow();

    expect(() => resolveObjectStoreConfig({
      deploymentMode: "test",
      env: { ...base, SWITCHYARD_OBJECT_STORE_ENDPOINT: "http://[::1]:9000" }
    })).not.toThrow();
  });

  it("returns warning when local directory is ignored for s3 backend", () => {
    const config = resolveObjectStoreConfig({
      deploymentMode: "test",
      env: {
        SWITCHYARD_OBJECT_STORE_BACKEND: "s3-compatible",
        SWITCHYARD_OBJECT_STORE_ENDPOINT: "http://localhost:9000",
        SWITCHYARD_OBJECT_STORE_REGION: "us-east-1",
        SWITCHYARD_OBJECT_STORE_BUCKET: "switchyard-artifacts",
        SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID: "key",
        SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY: "secret",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/ignored"
      }
    });

    if (config.backend === "s3-compatible") {
      expect(config.redactedSummary.warningCodes).toContain("object_store_dir_ignored");
    }
  });

  it("creates probeable memory, local, and s3-compatible stores", async () => {
    const memory = resolveObjectStoreConfig({ deploymentMode: "test", env: {} });
    const memoryStore = createArtifactContentStoreFromObjectConfig(memory);
    await expect(memoryStore.probe()).resolves.toEqual({ ok: true });

    const local = resolveObjectStoreConfig({
      deploymentMode: "test",
      env: {
        SWITCHYARD_OBJECT_STORE_BACKEND: "local",
        SWITCHYARD_OBJECT_STORE_DIR: "/tmp/switchyard-test-store"
      }
    });
    const localStore = createArtifactContentStoreFromObjectConfig(local);
    expect(typeof localStore.writeText).toBe("function");

    const s3 = resolveObjectStoreConfig({
      deploymentMode: "test",
      env: {
        SWITCHYARD_OBJECT_STORE_BACKEND: "s3-compatible",
        SWITCHYARD_OBJECT_STORE_ENDPOINT: "http://localhost:9000",
        SWITCHYARD_OBJECT_STORE_REGION: "us-east-1",
        SWITCHYARD_OBJECT_STORE_BUCKET: "switchyard-artifacts",
        SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID: "key",
        SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY: "secret"
      }
    });

    let wrote = false;
    const s3Store = createArtifactContentStoreFromObjectConfig(s3, {
      s3Client: {
        async putObject() {
          wrote = true;
        },
        async getObject() {
          return { body: Buffer.from("x"), contentType: "text/plain" };
        },
        async deleteObject() {
          return undefined;
        }
      }
    });
    await s3Store.writeText("runs/run_1/probe.txt", "x");
    expect(wrote).toBe(true);
  });

  it("supports explicit deployment mode type usage", () => {
    const mode: DeploymentMode = "local";
    expect(mode).toBe("local");
  });
});
