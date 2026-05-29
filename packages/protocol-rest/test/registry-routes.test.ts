import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Model as RegistryModel, Provider as RegistryProvider, RuntimeTarget as RegistryRuntime } from "@switchyard/contracts";
import { RegistryService } from "@switchyard/core";
import { InMemoryRegistryStore as MemoryRegistryStore } from "@switchyard/testkit";
import { registerErrorEnvelope, registerRegistryRoutes } from "../src/index.js";

function routeDeps(registry: MemoryRegistryStore) {
  return {
    registry,
    registryService: new RegistryService({ registry }),
    doctor: {
      checkRuntimeMode: async (_idOrSlug: string) => ({
        runtimeModeId: "runtime_mode_fake_deterministic",
        runtimeMode: "fake.deterministic",
        providerId: "provider_test",
        runtimeId: "runtime_fake",
        state: "available",
        canRun: true,
        installed: true,
        auth: "not_required",
        version: null,
        checkedAt: "2026-05-29T00:00:00.000Z",
        reasonCode: null,
        message: null,
        capabilities: ["run.start", "run.cancel", "event.normalized", "artifact.transcript", "tool.fake_echo", "auth.none"],
        limitations: [{ code: "deterministic_only", message: "Outputs are fixed for local smoke and contract tests." }],
        diagnostics: []
      }),
      summarize: async () => ({
        runtimeModes: [],
        summary: { available: 0, installed: 0, partial: 0, unavailable: 0, unsupported: 0, unknown: 0 }
      })
    }
  };
}

describe("registry routes", () => {
  it("returns provider/runtime/model records by id", async () => {
    const registry = new MemoryRegistryStore();
    const provider: RegistryProvider = {
      id: "provider_test",
      name: "Test Provider",
      authMode: "none",
      status: "available"
    };
    const runtime: RegistryRuntime = {
      id: "runtime_fake",
      name: "Fake Runtime",
      adapterType: "process",
      status: "available"
    };
    const model: RegistryModel = {
      id: "model_test",
      providerId: "provider_test",
      modelName: "test-model",
      supportsTools: false,
      supportsStreaming: true,
      supportsBrowser: false,
      status: "available"
    };
    await registry.createProvider(provider);
    await registry.createRuntime(runtime);
    await registry.createModel(model);

    const app = Fastify();
    registerRegistryRoutes(app, routeDeps(registry));

    expect((await app.inject({ method: "GET", url: "/providers/provider_test" })).json()).toEqual({ provider });
    expect((await app.inject({ method: "GET", url: "/runtimes/runtime_fake" })).json()).toEqual({ runtime });
    expect((await app.inject({ method: "GET", url: "/models/model_test" })).json()).toEqual({ model });
  });

  it("returns not found envelopes for provider/runtime/model misses", async () => {
    const registry = new MemoryRegistryStore();
    const app = Fastify();
    registerRegistryRoutes(app, routeDeps(registry));

    expect((await app.inject({ method: "GET", url: "/providers/provider_missing" })).json().error.code).toBe("provider_not_found");
    expect((await app.inject({ method: "GET", url: "/runtimes/runtime_missing" })).json().error.code).toBe("runtime_not_found");
    expect((await app.inject({ method: "GET", url: "/models/model_missing" })).json().error.code).toBe("model_not_found");
  });

  it("supports runtime mode list and lookup by id and slug", async () => {
    const registry = new MemoryRegistryStore();
    await registry.upsertRuntimeMode({
      id: "runtime_mode_codex_exec_json",
      slug: "codex.exec_json",
      name: "Codex exec JSON",
      providerId: "provider_openai",
      runtimeId: "runtime_codex",
      adapterId: "codex",
      adapterType: "process",
      kind: "one_shot_process",
      status: "available",
      capabilities: ["run.start", "run.cancel", "model.catalog", "auth.local"],
      limitations: [{ code: "one_shot_no_input", message: "codex.exec_json does not support post-start input." }],
      placement: {
        local: { support: "supported", reason: "Local only." },
        hosted: { support: "unsupported", reason: "Not hosted." },
        connectedLocalNode: { support: "future", reason: "Future." }
      },
      availability: {
        state: "available",
        canRun: true,
        installed: true,
        auth: "configured",
        version: "codex 0.130.0",
        checkedAt: "2026-05-29T00:00:00.000Z",
        reasonCode: null,
        message: null
      },
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z"
    });

    const app = Fastify();
    registerErrorEnvelope(app);
    registerRegistryRoutes(app, routeDeps(registry));

    const list = await app.inject({ method: "GET", url: "/runtime-modes?provider=openai&availability=available" });
    const byId = await app.inject({ method: "GET", url: "/runtime-modes/runtime_mode_codex_exec_json" });
    const bySlug = await app.inject({ method: "GET", url: "/runtime-modes/codex.exec_json" });
    expect(list.statusCode).toBe(200);
    expect(list.json().runtimeModes).toHaveLength(1);
    expect(byId.statusCode).toBe(200);
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.json().runtimeMode.id).toBe("runtime_mode_codex_exec_json");
  });

  it("returns runtime_mode_not_found for unknown runtime mode lookup/check", async () => {
    const registry = new MemoryRegistryStore();
    const app = Fastify();
    registerErrorEnvelope(app);
    registerRegistryRoutes(app, routeDeps(registry));

    const lookup = await app.inject({ method: "GET", url: "/runtime-modes/missing.mode" });
    const check = await app.inject({ method: "POST", url: "/runtime-modes/missing.mode/check" });
    expect(lookup.statusCode).toBe(404);
    expect(lookup.json().error.code).toBe("runtime_mode_not_found");
    expect(check.statusCode).toBe(404);
    expect(check.json().error.code).toBe("runtime_mode_not_found");
  });

  it("returns invalid_query for malformed runtime mode list filters and exposes doctor summary", async () => {
    const registry = new MemoryRegistryStore();
    const app = Fastify();
    registerErrorEnvelope(app);
    registerRegistryRoutes(app, routeDeps(registry));

    const invalid = await app.inject({ method: "GET", url: "/runtime-modes?availability=banana" });
    const doctor = await app.inject({ method: "GET", url: "/doctor" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_query");
    expect(doctor.statusCode).toBe(200);
    expect(doctor.json().summary).toMatchObject({
      available: 0,
      installed: 0,
      partial: 0,
      unavailable: 0,
      unsupported: 0,
      unknown: 0
    });
  });
});
