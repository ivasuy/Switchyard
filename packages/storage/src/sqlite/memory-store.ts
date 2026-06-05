import type { MemoryItem } from "@switchyard/contracts";
import type { ListMemoryFilter, ListMemoryResult, MemoryStore, SearchMemoryFilter } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { memoryItems } from "./schema.js";
import { and, desc, eq, like, lt, or, sql } from "drizzle-orm";

type MemoryRow = typeof memoryItems.$inferSelect;
type MemoryInsertRow = Omit<
  typeof memoryItems.$inferInsert,
  "projectId" | "runId" | "debateId" | "provider" | "model" | "embeddingJson"
> & {
  projectId: string | null;
  runId: string | null;
  debateId: string | null;
  provider: string | null;
  model: string | null;
  embeddingJson: string | null;
};

type MemoryUpdateRow = Omit<MemoryInsertRow, "id">;

function toInsertRow(item: MemoryItem): MemoryInsertRow {
  return {
    id: item.id,
    scope: item.scope,
    projectId: item.projectId ?? null,
    runId: item.runId ?? null,
    debateId: item.debateId ?? null,
    provider: item.provider ?? null,
    model: item.model ?? null,
    content: item.content,
    metadataJson: JSON.stringify(item.metadata),
    embeddingJson: item.embedding ? JSON.stringify(item.embedding) : null,
    createdAt: item.createdAt
  };
}

function toUpdateRow(item: MemoryItem): MemoryUpdateRow {
  return {
    scope: item.scope,
    projectId: item.projectId ?? null,
    runId: item.runId ?? null,
    debateId: item.debateId ?? null,
    provider: item.provider ?? null,
    model: item.model ?? null,
    content: item.content,
    metadataJson: JSON.stringify(item.metadata),
    embeddingJson: item.embedding ? JSON.stringify(item.embedding) : null,
    createdAt: item.createdAt
  };
}

function fromRow(row: MemoryRow): MemoryItem {
  const item: MemoryItem = {
    id: row.id,
    scope: row.scope as MemoryItem["scope"],
    content: row.content,
    metadata: JSON.parse(row.metadataJson),
    createdAt: row.createdAt
  };
  if (row.projectId !== null) item.projectId = row.projectId;
  if (row.runId !== null) item.runId = row.runId;
  if (row.debateId !== null) item.debateId = row.debateId;
  if (row.provider !== null) item.provider = row.provider;
  if (row.model !== null) item.model = row.model;
  if (row.embeddingJson !== null) item.embedding = JSON.parse(row.embeddingJson);
  return item;
}

function buildFilterConditions(filter: ListMemoryFilter) {
  const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof or>> = [];
  if (filter.scope) conditions.push(eq(memoryItems.scope, filter.scope));
  if (filter.projectId) conditions.push(eq(memoryItems.projectId, filter.projectId));
  if (filter.runId) conditions.push(eq(memoryItems.runId, filter.runId));
  if (filter.debateId) conditions.push(eq(memoryItems.debateId, filter.debateId));
  if (filter.provider) conditions.push(eq(memoryItems.provider, filter.provider));
  if (filter.model) conditions.push(eq(memoryItems.model, filter.model));
  if (filter.before) {
    const cursor = or(
      lt(memoryItems.createdAt, filter.before.createdAt),
      and(eq(memoryItems.createdAt, filter.before.createdAt), lt(memoryItems.id, filter.before.id))
    );
    if (cursor) conditions.push(cursor);
  }
  return conditions;
}

async function listWithConditions(
  db: SwitchyardSqliteDatabase,
  filter: ListMemoryFilter,
  extraConditions: Array<ReturnType<typeof eq> | ReturnType<typeof like> | ReturnType<typeof or>> = []
): Promise<ListMemoryResult> {
  const conditions = [...buildFilterConditions(filter), ...extraConditions];
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const overFetch = filter.limit + 1;
  const baseQuery = db
    .select()
    .from(memoryItems)
    .orderBy(desc(memoryItems.createdAt), desc(sql`${memoryItems.id}`))
    .limit(overFetch);
  const query = whereClause ? baseQuery.where(whereClause) : baseQuery;
  const rows = await query;
  const page = rows.slice(0, filter.limit).map(fromRow);
  const hasMore = rows.length > filter.limit;
  const last = page.at(-1);
  return {
    memory: page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
  };
}

export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(value: MemoryItem): Promise<MemoryItem> {
    await this.db.insert(memoryItems).values(toInsertRow(value));
    return value;
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    const rows = await this.db.select().from(memoryItems).where(eq(memoryItems.id, id)).limit(1);
    const row = rows[0];
    return row ? fromRow(row) : undefined;
  }

  async update(value: MemoryItem): Promise<MemoryItem> {
    await this.db.update(memoryItems).set(toUpdateRow(value)).where(eq(memoryItems.id, value.id));
    return value;
  }

  async list(filter: ListMemoryFilter): Promise<ListMemoryResult> {
    return listWithConditions(this.db, filter);
  }

  async search(filter: SearchMemoryFilter): Promise<ListMemoryResult> {
    return listWithConditions(this.db, filter, [like(sql`LOWER(${memoryItems.content})`, `%${filter.q.toLowerCase()}%`)]);
  }
}
