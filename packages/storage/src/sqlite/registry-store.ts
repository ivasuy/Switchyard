import type { Model, Provider, RuntimeTarget } from "@switchyard/contracts";
import type {
  ListModelsFilter,
  ListModelsResult,
  ListProvidersFilter,
  ListProvidersResult,
  ListRuntimesFilter,
  ListRuntimesResult,
  RegistryStore
} from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { models, providers, runtimes } from "./schema.js";
import { and, asc, eq, gt, inArray } from "drizzle-orm";

type ProviderRow = typeof providers.$inferSelect;
type ProviderInsertRow = typeof providers.$inferInsert;

type RuntimeRow = typeof runtimes.$inferSelect;
type RuntimeInsertRow = Omit<typeof runtimes.$inferInsert, "providerId"> & {
  providerId?: string;
};

type ModelRow = typeof models.$inferSelect;
type ModelInsertRow = Omit<typeof models.$inferInsert, "supportsTools" | "supportsStreaming" | "supportsBrowser"> & {
  supportsTools: number;
  supportsStreaming: number;
  supportsBrowser: number;
};

function toProviderRow(provider: Provider): ProviderInsertRow {
  return {
    id: provider.id,
    name: provider.name,
    authMode: provider.authMode,
    status: provider.status
  };
}

function fromProviderRow(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    authMode: row.authMode as Provider["authMode"],
    status: row.status as Provider["status"]
  };
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
  if (row.providerId !== null && row.providerId !== undefined) {
    runtime.providerId = row.providerId;
  }
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
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return fromProviderRow(row);
  }

  async getRuntime(id: string): Promise<RuntimeTarget | undefined> {
    const rows = await this.db.select().from(runtimes).where(eq(runtimes.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return fromRuntimeRow(row);
  }

  async getModel(id: string): Promise<Model | undefined> {
    const rows = await this.db.select().from(models).where(eq(models.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return fromModelRow(row);
  }

  async listProviders(filter: ListProvidersFilter): Promise<ListProvidersResult> {
    const overFetch = filter.limit + 1;
    const conditions = filter.before ? [gt(providers.id, filter.before.id)] : [];
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const baseQuery = this.db.select().from(providers).orderBy(asc(providers.id)).limit(overFetch);
    const query = whereClause ? baseQuery.where(whereClause) : baseQuery;
    const rows = await query;
    const records = rows.slice(0, filter.limit).map(fromProviderRow);
    const hasMore = rows.length > filter.limit;
    const last = records.at(-1);
    return { providers: records, nextCursor: hasMore && last ? { id: last.id } : null };
  }

  async listRuntimes(filter: ListRuntimesFilter): Promise<ListRuntimesResult> {
    const overFetch = filter.limit + 1;
    const conditions: ReturnType<typeof eq>[] = [];
    if (filter.providerIds && filter.providerIds.length > 0) {
      conditions.push(inArray(runtimes.providerId, [...filter.providerIds]));
    }
    if (filter.adapterType && filter.adapterType.length > 0) {
      conditions.push(inArray(runtimes.adapterType, [...filter.adapterType]));
    }
    if (filter.before) {
      conditions.push(gt(runtimes.id, filter.before.id));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const baseQuery = this.db.select().from(runtimes).orderBy(asc(runtimes.id)).limit(overFetch);
    const query = whereClause ? baseQuery.where(whereClause) : baseQuery;
    const rows = await query;
    const records = rows.slice(0, filter.limit).map(fromRuntimeRow);
    const hasMore = rows.length > filter.limit;
    const last = records.at(-1);
    return { runtimes: records, nextCursor: hasMore && last ? { id: last.id } : null };
  }

  async listModels(filter: ListModelsFilter): Promise<ListModelsResult> {
    const overFetch = filter.limit + 1;
    const conditions: ReturnType<typeof eq>[] = [];
    if (filter.providerIds && filter.providerIds.length > 0) {
      conditions.push(inArray(models.providerId, [...filter.providerIds]));
    }
    if (filter.before) {
      conditions.push(gt(models.id, filter.before.id));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const baseQuery = this.db.select().from(models).orderBy(asc(models.id)).limit(overFetch);
    const query = whereClause ? baseQuery.where(whereClause) : baseQuery;
    const rows = await query;
    const records = rows.slice(0, filter.limit).map(fromModelRow);
    const hasMore = rows.length > filter.limit;
    const last = records.at(-1);
    return { models: records, nextCursor: hasMore && last ? { id: last.id } : null };
  }
}
