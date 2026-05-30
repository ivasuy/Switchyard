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
import type { PostgresDatabaseHandle } from "./database.js";

export class PostgresRegistryStore implements RegistryStore {
  private readonly providers = new Map<string, Provider>();
  private readonly runtimes = new Map<string, RuntimeTarget>();
  private readonly models = new Map<string, Model>();
  private readonly runtimeModes = new Map<string, RuntimeMode>();
  private readonly runtimeModesBySlug = new Map<string, string>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async createProvider(provider: Provider): Promise<Provider> {
    if (this.handle) {
      await this.handle.pool.query(
        `INSERT INTO providers (id, name, auth_mode, status) VALUES ($1,$2,$3,$4)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, auth_mode = EXCLUDED.auth_mode, status = EXCLUDED.status`,
        [provider.id, provider.name, provider.authMode, provider.status]
      );
      return provider;
    }
    this.providers.set(provider.id, provider);
    return provider;
  }

  async createRuntime(runtime: RuntimeTarget): Promise<RuntimeTarget> {
    if (this.handle) {
      await this.handle.pool.query(
        `INSERT INTO runtimes (id, name, adapter_type, status, provider_id) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, adapter_type = EXCLUDED.adapter_type, status = EXCLUDED.status, provider_id = EXCLUDED.provider_id`,
        [runtime.id, runtime.name, runtime.adapterType, runtime.status, runtime.providerId ?? null]
      );
      return runtime;
    }
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }

  async createModel(model: Model): Promise<Model> {
    if (this.handle) {
      await this.handle.pool.query(
        `INSERT INTO models (id, provider_id, model_name, supports_tools, supports_streaming, supports_browser, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET
          provider_id = EXCLUDED.provider_id,
          model_name = EXCLUDED.model_name,
          supports_tools = EXCLUDED.supports_tools,
          supports_streaming = EXCLUDED.supports_streaming,
          supports_browser = EXCLUDED.supports_browser,
          status = EXCLUDED.status`,
        [model.id, model.providerId, model.modelName, model.supportsTools, model.supportsStreaming, model.supportsBrowser, model.status]
      );
      return model;
    }
    this.models.set(model.id, model);
    return model;
  }

  async getProvider(id: string): Promise<Provider | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM providers WHERE id = $1", [id]);
      return result.rows[0] ? rowToProvider(result.rows[0]) : undefined;
    }
    return this.providers.get(id);
  }

  async getRuntime(id: string): Promise<RuntimeTarget | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM runtimes WHERE id = $1", [id]);
      return result.rows[0] ? rowToRuntime(result.rows[0]) : undefined;
    }
    return this.runtimes.get(id);
  }

  async getModel(id: string): Promise<Model | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM models WHERE id = $1", [id]);
      return result.rows[0] ? rowToModel(result.rows[0]) : undefined;
    }
    return this.models.get(id);
  }

  async listProviders(filter: ListProvidersFilter): Promise<ListProvidersResult> {
    const rows = this.handle
      ? (await this.handle.pool.query("SELECT * FROM providers ORDER BY id ASC")).rows.map(rowToProvider)
      : [...this.providers.values()];
    const sorted = rows.sort((a, b) => a.id.localeCompare(b.id));
    const before = filter.before;
    const filtered = before ? sorted.filter((row) => row.id > before.id) : sorted;
    const page = filtered.slice(0, filter.limit);
    const last = page.at(-1);
    return { providers: page, nextCursor: filtered.length > filter.limit && last ? { id: last.id } : null };
  }

  async listRuntimes(filter: ListRuntimesFilter): Promise<ListRuntimesResult> {
    const rows = this.handle
      ? (await this.handle.pool.query("SELECT * FROM runtimes ORDER BY id ASC")).rows.map(rowToRuntime)
      : [...this.runtimes.values()];
    const sorted = rows.sort((a, b) => a.id.localeCompare(b.id));
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
    const rows = this.handle
      ? (await this.handle.pool.query("SELECT * FROM models ORDER BY id ASC")).rows.map(rowToModel)
      : [...this.models.values()];
    const sorted = rows.sort((a, b) => a.id.localeCompare(b.id));
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
    if (this.handle) {
      await this.handle.pool.query(
        `INSERT INTO runtime_modes (
          id, slug, name, provider_id, runtime_id, adapter_id, adapter_type, kind, status,
          capabilities, limitations, placement, availability, docs_path, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (id) DO UPDATE SET
          slug = EXCLUDED.slug,
          name = EXCLUDED.name,
          provider_id = EXCLUDED.provider_id,
          runtime_id = EXCLUDED.runtime_id,
          adapter_id = EXCLUDED.adapter_id,
          adapter_type = EXCLUDED.adapter_type,
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          capabilities = EXCLUDED.capabilities,
          limitations = EXCLUDED.limitations,
          placement = EXCLUDED.placement,
          availability = EXCLUDED.availability,
          docs_path = EXCLUDED.docs_path,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at`,
        [
          mode.id,
          mode.slug,
          mode.name,
          mode.providerId,
          mode.runtimeId,
          mode.adapterId,
          mode.adapterType,
          mode.kind,
          mode.status,
          mode.capabilities,
          mode.limitations,
          mode.placement,
          mode.availability,
          mode.docsPath ?? null,
          mode.createdAt,
          mode.updatedAt
        ]
      );
      return mode;
    }
    this.runtimeModes.set(mode.id, mode);
    this.runtimeModesBySlug.set(mode.slug, mode.id);
    return mode;
  }

  async getRuntimeMode(idOrSlug: string): Promise<RuntimeMode | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        "SELECT * FROM runtime_modes WHERE id = $1 OR slug = $1 LIMIT 1",
        [idOrSlug]
      );
      return result.rows[0] ? rowToRuntimeMode(result.rows[0]) : undefined;
    }
    if (idOrSlug.startsWith("runtime_mode_")) return this.runtimeModes.get(idOrSlug);
    const id = this.runtimeModesBySlug.get(idOrSlug);
    return id ? this.runtimeModes.get(id) : undefined;
  }

  async listRuntimeModes(filter: ListRuntimeModesFilter): Promise<ListRuntimeModesResult> {
    const rows = this.handle
      ? (await this.handle.pool.query("SELECT * FROM runtime_modes ORDER BY id ASC")).rows.map(rowToRuntimeMode)
      : [...this.runtimeModes.values()];
    const sorted = rows.sort((a, b) => a.id.localeCompare(b.id));
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

function rowToProvider(row: Record<string, unknown>): Provider {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    authMode: row["auth_mode"] as Provider["authMode"],
    status: row["status"] as Provider["status"]
  };
}

function rowToRuntime(row: Record<string, unknown>): RuntimeTarget {
  const runtime: RuntimeTarget = {
    id: row["id"] as string,
    name: row["name"] as string,
    adapterType: row["adapter_type"] as RuntimeTarget["adapterType"],
    status: row["status"] as RuntimeTarget["status"]
  };
  if (row["provider_id"]) runtime.providerId = row["provider_id"] as string;
  return runtime;
}

function rowToModel(row: Record<string, unknown>): Model {
  return {
    id: row["id"] as string,
    providerId: row["provider_id"] as string,
    modelName: row["model_name"] as string,
    supportsTools: row["supports_tools"] as boolean,
    supportsStreaming: row["supports_streaming"] as boolean,
    supportsBrowser: row["supports_browser"] as boolean,
    status: row["status"] as Model["status"]
  };
}

function rowToRuntimeMode(row: Record<string, unknown>): RuntimeMode {
  const mode: RuntimeMode = {
    id: row["id"] as string,
    slug: row["slug"] as RuntimeMode["slug"],
    name: row["name"] as string,
    providerId: row["provider_id"] as string,
    runtimeId: row["runtime_id"] as string,
    adapterId: row["adapter_id"] as string,
    adapterType: row["adapter_type"] as RuntimeMode["adapterType"],
    kind: row["kind"] as RuntimeMode["kind"],
    status: row["status"] as RuntimeMode["status"],
    capabilities: row["capabilities"] as RuntimeMode["capabilities"],
    limitations: row["limitations"] as RuntimeMode["limitations"],
    placement: row["placement"] as RuntimeMode["placement"],
    availability: row["availability"] as RuntimeMode["availability"],
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string
  };
  if (row["docs_path"]) mode.docsPath = row["docs_path"] as string;
  return mode;
}
