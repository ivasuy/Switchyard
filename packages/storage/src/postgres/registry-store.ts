import type { Model, Provider, RuntimeAvailability, RuntimeMode, RuntimeTarget } from "@switchyard/contracts";
import type {
  ListModelsFilter,
  ListModelsResult,
  ListProvidersFilter,
  ListProvidersResult,
  ListRuntimeModesFilter,
  ListRuntimeModesResult,
  ListRuntimesFilter,
  ListRuntimesResult,
  RegistryStore
} from "@switchyard/core";

export class PostgresRegistryStore implements RegistryStore {
  private readonly providers = new Map<string, Provider>();
  private readonly runtimes = new Map<string, RuntimeTarget>();
  private readonly models = new Map<string, Model>();
  private readonly runtimeModes = new Map<string, RuntimeMode>();
  private readonly runtimeModesBySlug = new Map<string, string>();

  async createProvider(provider: Provider): Promise<Provider> { this.providers.set(provider.id, provider); return provider; }
  async createRuntime(runtime: RuntimeTarget): Promise<RuntimeTarget> { this.runtimes.set(runtime.id, runtime); return runtime; }
  async createModel(model: Model): Promise<Model> { this.models.set(model.id, model); return model; }
  async getProvider(id: string): Promise<Provider | undefined> { return this.providers.get(id); }
  async getRuntime(id: string): Promise<RuntimeTarget | undefined> { return this.runtimes.get(id); }
  async getModel(id: string): Promise<Model | undefined> { return this.models.get(id); }

  async listProviders(filter: ListProvidersFilter): Promise<ListProvidersResult> {
    const sorted = [...this.providers.values()].sort((a, b) => a.id.localeCompare(b.id));
    const before = filter.before;
    const filtered = before ? sorted.filter((row) => row.id > before.id) : sorted;
    const page = filtered.slice(0, filter.limit);
    const last = page.at(-1);
    return { providers: page, nextCursor: filtered.length > filter.limit && last ? { id: last.id } : null };
  }

  async listRuntimes(filter: ListRuntimesFilter): Promise<ListRuntimesResult> {
    const sorted = [...this.runtimes.values()].sort((a, b) => a.id.localeCompare(b.id));
    const filtered = sorted.filter((runtime) => {
      if (filter.providerIds?.length && (!runtime.providerId || !filter.providerIds.includes(runtime.providerId))) return false;
      if (filter.adapterType?.length && !filter.adapterType.includes(runtime.adapterType)) return false;
      if (filter.before && runtime.id <= filter.before.id) return false;
      return true;
    });
    const page = filtered.slice(0, filter.limit);
    const last = page.at(-1);
    return { runtimes: page, nextCursor: filtered.length > filter.limit && last ? { id: last.id } : null };
  }

  async listModels(filter: ListModelsFilter): Promise<ListModelsResult> {
    const sorted = [...this.models.values()].sort((a, b) => a.id.localeCompare(b.id));
    const filtered = sorted.filter((model) => {
      if (filter.providerIds?.length && !filter.providerIds.includes(model.providerId)) return false;
      if (filter.before && model.id <= filter.before.id) return false;
      return true;
    });
    const page = filtered.slice(0, filter.limit);
    const last = page.at(-1);
    return { models: page, nextCursor: filtered.length > filter.limit && last ? { id: last.id } : null };
  }

  async upsertRuntimeMode(mode: RuntimeMode): Promise<RuntimeMode> {
    this.runtimeModes.set(mode.id, mode);
    this.runtimeModesBySlug.set(mode.slug, mode.id);
    return mode;
  }

  async getRuntimeMode(idOrSlug: string): Promise<RuntimeMode | undefined> {
    if (idOrSlug.startsWith("runtime_mode_")) return this.runtimeModes.get(idOrSlug);
    const id = this.runtimeModesBySlug.get(idOrSlug);
    return id ? this.runtimeModes.get(id) : undefined;
  }

  async listRuntimeModes(filter: ListRuntimeModesFilter): Promise<ListRuntimeModesResult> {
    const sorted = [...this.runtimeModes.values()].sort((a, b) => a.id.localeCompare(b.id));
    const filtered = sorted.filter((mode) => {
      if (filter.providerIds?.length && !filter.providerIds.includes(mode.providerId)) return false;
      if (filter.runtimeIds?.length && !filter.runtimeIds.includes(mode.runtimeId)) return false;
      if (filter.adapterType?.length && !filter.adapterType.includes(mode.adapterType)) return false;
      if (filter.kind?.length && !filter.kind.includes(mode.kind)) return false;
      if (filter.availability?.length && !filter.availability.includes(mode.availability.state)) return false;
      if (filter.before && mode.id <= filter.before.id) return false;
      if (filter.capability?.length && !filter.capability.every((cap) => mode.capabilities.includes(cap as RuntimeMode["capabilities"][number]))) return false;
      if (filter.placement?.length) {
        const matches = filter.placement.some((placement) => {
          if (placement === "local") return mode.placement.local.support === "supported" || mode.placement.local.support === "conditional";
          if (placement === "hosted") return mode.placement.hosted.support === "supported" || mode.placement.hosted.support === "conditional";
          if (placement === "connected_local_node") return mode.placement.connectedLocalNode.support === "supported" || mode.placement.connectedLocalNode.support === "conditional";
          return false;
        });
        if (!matches) return false;
      }
      return true;
    });
    const page = filtered.slice(0, filter.limit);
    const last = page.at(-1);
    return { runtimeModes: page, nextCursor: filtered.length > filter.limit && last ? { id: last.id } : null };
  }

  async updateRuntimeModeAvailability(idOrSlug: string, availability: RuntimeAvailability): Promise<RuntimeMode | undefined> {
    const mode = await this.getRuntimeMode(idOrSlug);
    if (!mode) return undefined;
    const updated: RuntimeMode = { ...mode, availability, status: availability.state, updatedAt: availability.checkedAt };
    await this.upsertRuntimeMode(updated);
    return updated;
  }
}
