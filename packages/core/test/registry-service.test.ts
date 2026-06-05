import { describe, expect, it } from "vitest";
import { RegistryService, RuntimeModeValidationError } from "../src/index.js";
import type {
  ListModelsFilter,
  ListModelsResult,
  ListProvidersFilter,
  ListProvidersResult,
  ListRuntimesFilter,
  ListRuntimesResult,
  ListRuntimeModesFilter,
  ListRuntimeModesResult,
  Model,
  Provider,
  RuntimeAvailability,
  RuntimeMode,
  RuntimeTarget
} from "@switchyard/contracts";
import type { RegistryStore } from "../src/index.js";

describe("RegistryService runtime mode inference and validation", () => {
  it("infers fake, codex, generic_http, agentfield, claude_code, and opencode runtime modes when omitted", async () => {
    const service = new RegistryService({ registry: new InMemoryRegistryStore() });

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "fake",
        provider: "test",
        adapterType: "process"
      })
    ).resolves.toBe("fake.deterministic");

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "codex",
        provider: "openai",
        adapterType: "process"
      })
    ).resolves.toBe("codex.exec_json");

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "generic_http",
        provider: "generic_http",
        adapterType: "http"
      })
    ).resolves.toBe("generic_http.async_rest");

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "agentfield",
        provider: "agentfield",
        adapterType: "http"
      })
    ).resolves.toBe("agentfield.async_rest");

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "claude_code",
        provider: "anthropic",
        adapterType: "native"
      })
    ).resolves.toBe("claude_code.sdk");

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "opencode",
        provider: "opencode",
        adapterType: "acpx"
      })
    ).resolves.toBe("opencode.acp");
  });

  it("rejects internal runtime mode ids in public payloads", async () => {
    const service = new RegistryService({ registry: new InMemoryRegistryStore() });

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "generic_http",
        provider: "generic_http",
        adapterType: "http",
        runtimeMode: "runtime_mode_generic_http_async_rest"
      })
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: [{ path: "runtimeMode", issue: expect.stringContaining("slug") }]
    } satisfies Partial<RuntimeModeValidationError>);
  });

  it("accepts explicit generic_http runtime mode when runtime/provider/adapterType match", async () => {
    const registry = new InMemoryRegistryStore();
    await registry.upsertRuntimeMode(genericHttpModeFixture());
    const service = new RegistryService({ registry });

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "generic_http",
        provider: "generic_http",
        adapterType: "http",
        runtimeMode: "generic_http.async_rest"
      })
    ).resolves.toBe("generic_http.async_rest");
  });

  it("rejects explicit generic_http runtime mode when runtime/provider/adapterType mismatch", async () => {
    const registry = new InMemoryRegistryStore();
    await registry.upsertRuntimeMode(genericHttpModeFixture());
    const service = new RegistryService({ registry });

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "codex",
        provider: "openai",
        adapterType: "process",
        runtimeMode: "generic_http.async_rest"
      })
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: [{ path: "runtimeMode", issue: expect.stringContaining("match runtime, provider, and adapterType") }]
    } satisfies Partial<RuntimeModeValidationError>);
  });

  it("accepts explicit opencode runtime mode when runtime/provider/adapterType match", async () => {
    const registry = new InMemoryRegistryStore();
    await registry.upsertRuntimeMode(opencodeModeFixture());
    const service = new RegistryService({ registry });

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "opencode",
        provider: "opencode",
        adapterType: "acpx",
        runtimeMode: "opencode.acp"
      })
    ).resolves.toBe("opencode.acp");
  });

  it("accepts explicit agentfield runtime mode and rejects internal ids/mismatches", async () => {
    const registry = new InMemoryRegistryStore();
    await registry.upsertRuntimeMode(agentfieldModeFixture());
    const service = new RegistryService({ registry });

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "agentfield",
        provider: "agentfield",
        adapterType: "http",
        runtimeMode: "agentfield.async_rest"
      })
    ).resolves.toBe("agentfield.async_rest");

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "agentfield",
        provider: "agentfield",
        adapterType: "http",
        runtimeMode: "runtime_mode_agentfield_async_rest"
      })
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: [{ path: "runtimeMode", issue: expect.stringContaining("slug") }]
    } satisfies Partial<RuntimeModeValidationError>);

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "fake",
        provider: "test",
        adapterType: "process",
        runtimeMode: "agentfield.async_rest"
      })
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: [{ path: "runtimeMode", issue: expect.stringContaining("match runtime, provider, and adapterType") }]
    } satisfies Partial<RuntimeModeValidationError>);
  });

  it("rejects internal opencode runtime mode ids and mismatched explicit opencode mode", async () => {
    const registry = new InMemoryRegistryStore();
    await registry.upsertRuntimeMode(opencodeModeFixture());
    const service = new RegistryService({ registry });

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "opencode",
        provider: "opencode",
        adapterType: "acpx",
        runtimeMode: "runtime_mode_opencode_acp"
      })
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: [{ path: "runtimeMode", issue: expect.stringContaining("slug") }]
    } satisfies Partial<RuntimeModeValidationError>);

    await expect(
      service.inferAndValidateRuntimeMode({
        runtime: "codex",
        provider: "openai",
        adapterType: "process",
        runtimeMode: "opencode.acp"
      })
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: [{ path: "runtimeMode", issue: expect.stringContaining("match runtime, provider, and adapterType") }]
    } satisfies Partial<RuntimeModeValidationError>);
  });
});

function genericHttpModeFixture() {
  return {
    id: "runtime_mode_generic_http_async_rest",
    slug: "generic_http.async_rest",
    name: "Generic HTTP async REST",
    providerId: "provider_generic_http",
    runtimeId: "runtime_generic_http",
    adapterId: "generic_http",
    adapterType: "http" as const,
    kind: "async_rest" as const,
    status: "unknown" as const,
    capabilities: [
      "run.start",
      "run.cancel",
      "run.timeout",
      "event.normalized",
      "event.streaming",
      "artifact.transcript",
      "auth.none"
    ],
    limitations: [],
    placement: {
      local: { support: "conditional" as const, reason: "Configured URL required." },
      hosted: { support: "future" as const, reason: "Not shipped in R4." },
      connectedLocalNode: { support: "future" as const, reason: "Not shipped in R4." }
    },
    availability: {
      state: "unknown" as const,
      canRun: false,
      installed: false,
      auth: "unknown" as const,
      version: null,
      checkedAt: "2026-05-29T00:00:00.000Z",
      reasonCode: "generic_http_config_missing",
      message: "Generic HTTP base URL is not configured."
    },
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z"
  };
}

function opencodeModeFixture() {
  return {
    id: "runtime_mode_opencode_acp",
    slug: "opencode.acp",
    name: "OpenCode ACP",
    providerId: "provider_opencode",
    runtimeId: "runtime_opencode",
    adapterId: "opencode",
    adapterType: "acpx" as const,
    kind: "acp" as const,
    status: "unknown" as const,
    capabilities: [
      "run.start",
      "run.cancel",
      "run.timeout",
      "event.normalized",
      "event.streaming",
      "artifact.transcript",
      "artifact.raw_transcript",
      "auth.local"
    ],
    limitations: [{ code: "no_post_start_input", message: "opencode.acp does not support POST /runs/:id/input in R5." }],
    placement: {
      local: { support: "conditional" as const, reason: "Local opencode binary required." },
      hosted: { support: "future" as const, reason: "Hosted execution is not shipped in R5." },
      connectedLocalNode: { support: "future" as const, reason: "Hybrid node execution is not shipped in R5." }
    },
    availability: {
      state: "unknown" as const,
      canRun: false,
      installed: false,
      auth: "unknown" as const,
      version: null,
      checkedAt: "2026-05-30T00:00:00.000Z",
      reasonCode: "opencode_binary_unavailable",
      message: "OpenCode binary unavailable."
    },
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z"
  };
}

function agentfieldModeFixture() {
  return {
    id: "runtime_mode_agentfield_async_rest",
    slug: "agentfield.async_rest",
    name: "AgentField async REST",
    providerId: "provider_agentfield",
    runtimeId: "runtime_agentfield",
    adapterId: "agentfield",
    adapterType: "http" as const,
    kind: "async_rest" as const,
    status: "unknown" as const,
    capabilities: [
      "run.start",
      "run.timeout",
      "event.normalized",
      "event.streaming",
      "artifact.transcript",
      "auth.api_key"
    ],
    limitations: [{ code: "cancel_unsupported", message: "AgentField upstream cancel is not shipped in R6." }],
    placement: {
      local: { support: "conditional" as const, reason: "Configured AgentField endpoint required." },
      hosted: { support: "future" as const, reason: "Not shipped in R6." },
      connectedLocalNode: { support: "future" as const, reason: "Not shipped in R6." }
    },
    availability: {
      state: "unavailable" as const,
      canRun: false,
      installed: false,
      auth: "missing" as const,
      version: null,
      checkedAt: "2026-05-30T00:00:00.000Z",
      reasonCode: "agentfield_config_missing",
      message: "SWITCHYARD_AGENTFIELD_BASE_URL is not configured."
    },
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z"
  };
}

class InMemoryRegistryStore implements RegistryStore {
  private readonly runtimeModes = new Map<string, RuntimeMode>();
  private readonly runtimeModesBySlug = new Map<string, string>();

  async createProvider(_provider: Provider): Promise<Provider> {
    throw new Error("not implemented");
  }

  async createRuntime(_runtime: RuntimeTarget): Promise<RuntimeTarget> {
    throw new Error("not implemented");
  }

  async createModel(_model: Model): Promise<Model> {
    throw new Error("not implemented");
  }

  async getProvider(_id: string): Promise<Provider | undefined> {
    throw new Error("not implemented");
  }

  async getRuntime(_id: string): Promise<RuntimeTarget | undefined> {
    throw new Error("not implemented");
  }

  async getModel(_id: string): Promise<Model | undefined> {
    throw new Error("not implemented");
  }

  async listProviders(_filter: ListProvidersFilter): Promise<ListProvidersResult> {
    throw new Error("not implemented");
  }

  async listRuntimes(_filter: ListRuntimesFilter): Promise<ListRuntimesResult> {
    throw new Error("not implemented");
  }

  async listModels(_filter: ListModelsFilter): Promise<ListModelsResult> {
    throw new Error("not implemented");
  }

  async upsertRuntimeMode(mode: RuntimeMode): Promise<RuntimeMode> {
    this.runtimeModes.set(mode.id, mode);
    this.runtimeModesBySlug.set(mode.slug, mode.id);
    return mode;
  }

  async getRuntimeMode(idOrSlug: string): Promise<RuntimeMode | undefined> {
    if (idOrSlug.startsWith("runtime_mode_")) {
      return this.runtimeModes.get(idOrSlug);
    }
    const id = this.runtimeModesBySlug.get(idOrSlug);
    return id ? this.runtimeModes.get(id) : undefined;
  }

  async listRuntimeModes(_filter: ListRuntimeModesFilter): Promise<ListRuntimeModesResult> {
    throw new Error("not implemented");
  }

  async updateRuntimeModeAvailability(idOrSlug: string, availability: RuntimeAvailability): Promise<RuntimeMode | undefined> {
    const mode = await this.getRuntimeMode(idOrSlug);
    if (!mode) {
      return undefined;
    }
    const updated: RuntimeMode = {
      ...mode,
      availability,
      status: availability.state,
      updatedAt: availability.checkedAt
    };
    await this.upsertRuntimeMode(updated);
    return updated;
  }
}
