import { runtimeModeSchema, type Model, type Provider, type RuntimeAvailability, type RuntimeMode, type RuntimeTarget } from "@switchyard/contracts";
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
import type { SwitchyardSqliteDatabase } from "./database.js";
import { models, providers, runtimeModes, runtimes } from "./schema.js";
import { and, asc, eq, gt, inArray } from "drizzle-orm";

type ProviderRow = typeof providers.$inferSelect;
type ProviderInsertRow = typeof providers.$inferInsert;
type RuntimeRow = typeof runtimes.$inferSelect;
type RuntimeInsertRow = Omit<typeof runtimes.$inferInsert, "providerId"> & { providerId?: string };
type ModelRow = typeof models.$inferSelect;
type ModelInsertRow = Omit<typeof models.$inferInsert, "supportsTools" | "supportsStreaming" | "supportsBrowser"> & {
  supportsTools: number;
  supportsStreaming: number;
  supportsBrowser: number;
};
type RuntimeModeRow = typeof runtimeModes.$inferSelect;
type RuntimeModeInsertRow = Omit<
  typeof runtimeModes.$inferInsert,
  "docsPath"
> & { docsPath?: string | null };

function toProviderRow(provider: Provider): ProviderInsertRow {
  return { id: provider.id, name: provider.name, authMode: provider.authMode, status: provider.status };
}

function fromProviderRow(row: ProviderRow): Provider {
  return { id: row.id, name: row.name, authMode: row.authMode as Provider["authMode"], status: row.status as Provider["status"] };
}

function toRuntimeRow(runtime: RuntimeTarget): RuntimeInsertRow {
  const row: RuntimeInsertRow = {
    id: runtime.id,
    name: runtime.name,
    adapterType: runtime.adapterType,
    status: runtime.status
  };
  if (runtime.providerId !== undefined) {
    row.providerId = runtime.providerId;
  }
  return row;
}

function fromRuntimeRow(row: RuntimeRow): RuntimeTarget {
  const runtime: RuntimeTarget = {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType as RuntimeTarget["adapterType"],
    status: row.status as RuntimeTarget["status"]
  };
  if (row.providerId !== null && row.providerId !== undefined) runtime.providerId = row.providerId;
  return runtime;
}

function toModelRow(model: Model): ModelInsertRow {
  return {
    id: model.id,
    providerId: model.providerId,
    modelName: model.modelName,
    supportsTools: model.supportsTools ? 1 : 0,
    supportsStreaming: model.supportsStreaming ? 1 : 0,
    supportsBrowser: model.supportsBrowser ? 1 : 0,
    status: model.status
  };
}

function fromModelRow(row: ModelRow): Model {
  return {
    id: row.id,
    providerId: row.providerId,
    modelName: row.modelName,
    supportsTools: row.supportsTools === 1,
    supportsStreaming: row.supportsStreaming === 1,
    supportsBrowser: row.supportsBrowser === 1,
    status: row.status as Model["status"]
  };
}

function toRuntimeModeRow(mode: RuntimeMode): RuntimeModeInsertRow {
  return {
    id: mode.id,
    slug: mode.slug,
    name: mode.name,
    providerId: mode.providerId,
    runtimeId: mode.runtimeId,
    adapterId: mode.adapterId,
    adapterType: mode.adapterType,
    kind: mode.kind,
    status: mode.status,
    capabilitiesJson: JSON.stringify(mode.capabilities),
    limitationsJson: JSON.stringify(mode.limitations),
    placementJson: JSON.stringify(mode.placement),
    availabilityJson: JSON.stringify(mode.availability),
    docsPath: mode.docsPath ?? null,
    createdAt: mode.createdAt,
    updatedAt: mode.updatedAt
  };
}

function fromRuntimeModeRow(row: RuntimeModeRow): RuntimeMode {
  const parsed = runtimeModeSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    providerId: row.providerId,
    runtimeId: row.runtimeId,
    adapterId: row.adapterId,
    adapterType: row.adapterType,
    kind: row.kind,
    status: row.status,
    capabilities: JSON.parse(row.capabilitiesJson),
    limitations: JSON.parse(row.limitationsJson),
    placement: JSON.parse(row.placementJson),
    availability: JSON.parse(row.availabilityJson),
    docsPath: row.docsPath ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
  return parsed;
}

function matchesRuntimeModeFilter(mode: RuntimeMode, filter: ListRuntimeModesFilter): boolean {
  if (filter.providerIds && filter.providerIds.length > 0 && !filter.providerIds.includes(mode.providerId)) {
    return false;
  }
  if (filter.runtimeIds && filter.runtimeIds.length > 0 && !filter.runtimeIds.includes(mode.runtimeId)) {
    return false;
  }
  if (filter.adapterType && filter.adapterType.length > 0 && !filter.adapterType.includes(mode.adapterType)) {
    return false;
  }
  if (filter.kind && filter.kind.length > 0 && !filter.kind.includes(mode.kind)) {
    return false;
  }
  if (filter.availability && filter.availability.length > 0 && !filter.availability.includes(mode.availability.state)) {
    return false;
  }
  if (filter.placement && filter.placement.length > 0) {
    const matchesPlacement = filter.placement.some((placement) => {
      if (placement === "local") {
        return mode.placement.local.support === "supported" || mode.placement.local.support === "conditional";
      }
      if (placement === "hosted") {
        return mode.placement.hosted.support === "supported" || mode.placement.hosted.support === "conditional";
      }
      if (placement === "connected_local_node") {
        return (
          mode.placement.connectedLocalNode.support === "supported" ||
          mode.placement.connectedLocalNode.support === "conditional"
        );
      }
      return false;
    });
    if (!matchesPlacement) {
      return false;
    }
  }
  if (filter.capability && filter.capability.length > 0) {
    const set = new Set<string>(mode.capabilities);
    if (!filter.capability.every((entry) => set.has(entry))) {
      return false;
    }
  }
  return true;
}

export class SqliteRegistryStore implements RegistryStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async createProvider(provider: Provider): Promise<Provider> {
    await this.db.insert(providers).values(toProviderRow(provider));
    return provider;
  }

  async createRuntime(runtime: RuntimeTarget): Promise<RuntimeTarget> {
    await this.db.insert(runtimes).values(toRuntimeRow(runtime));
    return runtime;
  }

  async createModel(model: Model): Promise<Model> {
    await this.db.insert(models).values(toModelRow(model));
    return model;
  }

  async getProvider(id: string): Promise<Provider | undefined> {
    const rows = await this.db.select().from(providers).where(eq(providers.id, id)).limit(1);
    return rows[0] ? fromProviderRow(rows[0]) : undefined;
  }

  async getRuntime(id: string): Promise<RuntimeTarget | undefined> {
    const rows = await this.db.select().from(runtimes).where(eq(runtimes.id, id)).limit(1);
    return rows[0] ? fromRuntimeRow(rows[0]) : undefined;
  }

  async getModel(id: string): Promise<Model | undefined> {
    const rows = await this.db.select().from(models).where(eq(models.id, id)).limit(1);
    return rows[0] ? fromModelRow(rows[0]) : undefined;
  }

  async listProviders(filter: ListProvidersFilter): Promise<ListProvidersResult> {
    const overFetch = filter.limit + 1;
    const conditions = filter.before ? [gt(providers.id, filter.before.id)] : [];
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const baseQuery = this.db.select().from(providers).orderBy(asc(providers.id)).limit(overFetch);
    const rows = await (whereClause ? baseQuery.where(whereClause) : baseQuery);
    const page = rows.slice(0, filter.limit).map(fromProviderRow);
    const last = page.at(-1);
    return { providers: page, nextCursor: rows.length > filter.limit && last ? { id: last.id } : null };
  }

  async listRuntimes(filter: ListRuntimesFilter): Promise<ListRuntimesResult> {
    const overFetch = filter.limit + 1;
    const conditions: ReturnType<typeof eq>[] = [];
    if (filter.providerIds && filter.providerIds.length > 0) conditions.push(inArray(runtimes.providerId, [...filter.providerIds]));
    if (filter.adapterType && filter.adapterType.length > 0) conditions.push(inArray(runtimes.adapterType, [...filter.adapterType]));
    if (filter.before) conditions.push(gt(runtimes.id, filter.before.id));
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const baseQuery = this.db.select().from(runtimes).orderBy(asc(runtimes.id)).limit(overFetch);
    const rows = await (whereClause ? baseQuery.where(whereClause) : baseQuery);
    const page = rows.slice(0, filter.limit).map(fromRuntimeRow);
    const last = page.at(-1);
    return { runtimes: page, nextCursor: rows.length > filter.limit && last ? { id: last.id } : null };
  }

  async listModels(filter: ListModelsFilter): Promise<ListModelsResult> {
    const overFetch = filter.limit + 1;
    const conditions: ReturnType<typeof eq>[] = [];
    if (filter.providerIds && filter.providerIds.length > 0) conditions.push(inArray(models.providerId, [...filter.providerIds]));
    if (filter.before) conditions.push(gt(models.id, filter.before.id));
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const baseQuery = this.db.select().from(models).orderBy(asc(models.id)).limit(overFetch);
    const rows = await (whereClause ? baseQuery.where(whereClause) : baseQuery);
    const page = rows.slice(0, filter.limit).map(fromModelRow);
    const last = page.at(-1);
    return { models: page, nextCursor: rows.length > filter.limit && last ? { id: last.id } : null };
  }

  async upsertRuntimeMode(mode: RuntimeMode): Promise<RuntimeMode> {
    await this.db
      .insert(runtimeModes)
      .values(toRuntimeModeRow(mode))
      .onConflictDoUpdate({
        target: runtimeModes.id,
        set: {
          slug: mode.slug,
          name: mode.name,
          providerId: mode.providerId,
          runtimeId: mode.runtimeId,
          adapterId: mode.adapterId,
          adapterType: mode.adapterType,
          kind: mode.kind,
          status: mode.status,
          capabilitiesJson: JSON.stringify(mode.capabilities),
          limitationsJson: JSON.stringify(mode.limitations),
          placementJson: JSON.stringify(mode.placement),
          availabilityJson: JSON.stringify(mode.availability),
          docsPath: mode.docsPath ?? null,
          createdAt: mode.createdAt,
          updatedAt: mode.updatedAt
        }
      });
    return mode;
  }

  async getRuntimeMode(idOrSlug: string): Promise<RuntimeMode | undefined> {
    let rows: RuntimeModeRow[];
    if (idOrSlug.startsWith("runtime_mode_")) {
      rows = await this.db.select().from(runtimeModes).where(eq(runtimeModes.id, idOrSlug)).limit(1);
    } else {
      rows = await this.db.select().from(runtimeModes).where(eq(runtimeModes.slug, idOrSlug)).limit(1);
    }
    const row = rows[0];
    return row ? fromRuntimeModeRow(row) : undefined;
  }

  async listRuntimeModes(filter: ListRuntimeModesFilter): Promise<ListRuntimeModesResult> {
    const overFetch = filter.limit + 1;
    const conditions: ReturnType<typeof eq>[] = [];
    if (filter.before) conditions.push(gt(runtimeModes.id, filter.before.id));
    if (filter.providerIds && filter.providerIds.length > 0) conditions.push(inArray(runtimeModes.providerId, [...filter.providerIds]));
    if (filter.runtimeIds && filter.runtimeIds.length > 0) conditions.push(inArray(runtimeModes.runtimeId, [...filter.runtimeIds]));
    if (filter.adapterType && filter.adapterType.length > 0) conditions.push(inArray(runtimeModes.adapterType, [...filter.adapterType]));
    if (filter.kind && filter.kind.length > 0) conditions.push(inArray(runtimeModes.kind, [...filter.kind]));
    if (filter.availability && filter.availability.length > 0) conditions.push(inArray(runtimeModes.status, [...filter.availability]));
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const baseQuery = this.db.select().from(runtimeModes).orderBy(asc(runtimeModes.id)).limit(Math.max(overFetch, filter.limit * 4));
    const rows = await (whereClause ? baseQuery.where(whereClause) : baseQuery);
    const filtered = rows.map(fromRuntimeModeRow).filter((mode) => matchesRuntimeModeFilter(mode, filter));
    const page = filtered.slice(0, filter.limit);
    const last = page.at(-1);
    return {
      runtimeModes: page,
      nextCursor: filtered.length > filter.limit && last ? { id: last.id } : null
    };
  }

  async updateRuntimeModeAvailability(idOrSlug: string, availability: RuntimeAvailability): Promise<RuntimeMode | undefined> {
    const mode = await this.getRuntimeMode(idOrSlug);
    if (!mode) return undefined;
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
