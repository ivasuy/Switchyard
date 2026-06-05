import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Model as RegistryModel, Provider as RegistryProvider, RuntimeTarget as RegistryRuntime } from "@switchyard/contracts";
import { InMemoryRegistryStore as MemoryRegistryStore } from "@switchyard/testkit";
import { registerErrorEnvelope, registerRegistryRoutes } from "../src/index.js";

describe("registry routes", () => {
  it("returns a provider by id", async () => {
    const registry = new MemoryRegistryStore();
    const provider: RegistryProvider = {
      id: "provider_test",
      name: "Test Provider",
      authMode: "none",
      status: "available"
    };
    await registry.createProvider(provider);

    const app = Fastify();
    registerRegistryRoutes(app, { registry });

    const response = await app.inject({ method: "GET", url: "/providers/provider_test" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ provider });
  });

  it("returns 404 when provider is missing", async () => {
    const registry = new MemoryRegistryStore();
    const app = Fastify();
    registerRegistryRoutes(app, { registry });

    const response = await app.inject({ method: "GET", url: "/providers/provider_missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "provider_not_found",
        message: "Provider not found: provider_missing"
      }
    });
  });

  it("returns a runtime by id", async () => {
    const registry = new MemoryRegistryStore();
    const runtime: RegistryRuntime = {
      id: "runtime_fake",
      name: "Fake Runtime",
      adapterType: "process",
      status: "available"
    };
    await registry.createRuntime(runtime);

    const app = Fastify();
    registerRegistryRoutes(app, { registry });

    const response = await app.inject({ method: "GET", url: "/runtimes/runtime_fake" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runtime });
  });

  it("returns 404 when runtime is missing", async () => {
    const registry = new MemoryRegistryStore();
    const app = Fastify();
    registerRegistryRoutes(app, { registry });

    const response = await app.inject({ method: "GET", url: "/runtimes/runtime_missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "runtime_not_found",
        message: "Runtime not found: runtime_missing"
      }
    });
  });

  it("returns a model by id", async () => {
    const registry = new MemoryRegistryStore();
    const model: RegistryModel = {
      id: "model_test",
      providerId: "provider_test",
      modelName: "test-model",
      supportsTools: false,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    };
    await registry.createModel(model);

    const app = Fastify();
    registerRegistryRoutes(app, { registry });

    const response = await app.inject({ method: "GET", url: "/models/model_test" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ model });
  });

  it("returns 404 when model is missing", async () => {
    const registry = new MemoryRegistryStore();
    const app = Fastify();
    registerRegistryRoutes(app, { registry });

    const response = await app.inject({ method: "GET", url: "/models/model_missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: "model_not_found",
        message: "Model not found: model_missing"
      }
    });
  });
});
