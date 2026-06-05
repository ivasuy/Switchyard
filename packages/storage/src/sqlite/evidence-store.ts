import type { EvidenceItem } from "@switchyard/contracts";
import type { EvidenceStore, ListEvidenceFilter, ListEvidenceResult } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { evidenceItems } from "./schema.js";
import { and, desc, eq, like, lt, or, sql } from "drizzle-orm";

type EvidenceRow = typeof evidenceItems.$inferSelect;
type EvidenceInsertRow = Omit<typeof evidenceItems.$inferInsert, "debateId" | "url" | "snippet" | "fetchedContentPath"> & {
  debateId: string | null;
  url: string | null;
  snippet: string | null;
  fetchedContentPath: string | null;
};

type EvidenceUpdateRow = Omit<EvidenceInsertRow, "id">;

function toInsertRow(item: EvidenceItem): EvidenceInsertRow {
  return {
    id: item.id,
    debateId: item.debateId ?? null,
    sourceType: item.sourceType,
    url: item.url ?? null,
    title: item.title,
    snippet: item.snippet ?? null,
    fetchedContentPath: item.fetchedContentPath ?? null,
    reliability: item.reliability,
    createdAt: item.createdAt
  };
}

function toUpdateRow(item: EvidenceItem): EvidenceUpdateRow {
  return {
    debateId: item.debateId ?? null,
    sourceType: item.sourceType,
    url: item.url ?? null,
    title: item.title,
    snippet: item.snippet ?? null,
    fetchedContentPath: item.fetchedContentPath ?? null,
    reliability: item.reliability,
    createdAt: item.createdAt
  };
}

function fromRow(row: EvidenceRow): EvidenceItem {
  const item: EvidenceItem = {
    id: row.id,
    sourceType: row.sourceType as EvidenceItem["sourceType"],
    title: row.title,
    reliability: row.reliability as EvidenceItem["reliability"],
    createdAt: row.createdAt
  };
  if (row.debateId !== null) item.debateId = row.debateId;
  if (row.url !== null) item.url = row.url;
  if (row.snippet !== null) item.snippet = row.snippet;
  if (row.fetchedContentPath !== null) item.fetchedContentPath = row.fetchedContentPath;
  return item;
}

export class SqliteEvidenceStore implements EvidenceStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(value: EvidenceItem): Promise<EvidenceItem> {
    await this.db.insert(evidenceItems).values(toInsertRow(value));
    return value;
  }

  async get(id: string): Promise<EvidenceItem | undefined> {
    const rows = await this.db.select().from(evidenceItems).where(eq(evidenceItems.id, id)).limit(1);
    const row = rows[0];
    return row ? fromRow(row) : undefined;
  }

  async update(value: EvidenceItem): Promise<EvidenceItem> {
    await this.db.update(evidenceItems).set(toUpdateRow(value)).where(eq(evidenceItems.id, value.id));
    return value;
  }

  async list(filter: ListEvidenceFilter): Promise<ListEvidenceResult> {
    const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof like> | ReturnType<typeof or>> = [];
    if (filter.debateId) conditions.push(eq(evidenceItems.debateId, filter.debateId));
    if (filter.sourceType) conditions.push(eq(evidenceItems.sourceType, filter.sourceType));
    if (filter.reliability) conditions.push(eq(evidenceItems.reliability, filter.reliability));
    if (filter.q) {
      const q = `%${filter.q.toLowerCase()}%`;
      const textMatch = or(
        like(sql`LOWER(${evidenceItems.title})`, q),
        like(sql`LOWER(COALESCE(${evidenceItems.snippet}, ''))`, q)
      );
      if (textMatch) conditions.push(textMatch);
    }
    if (filter.before) {
      const cursor = or(
        lt(evidenceItems.createdAt, filter.before.createdAt),
        and(eq(evidenceItems.createdAt, filter.before.createdAt), lt(evidenceItems.id, filter.before.id))
      );
      if (cursor) conditions.push(cursor);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const overFetch = filter.limit + 1;
    const baseQuery = this.db
      .select()
      .from(evidenceItems)
      .orderBy(desc(evidenceItems.createdAt), desc(sql`${evidenceItems.id}`))
      .limit(overFetch);
    const query = whereClause ? baseQuery.where(whereClause) : baseQuery;
    const rows = await query;
    const page = rows.slice(0, filter.limit).map(fromRow);
    const hasMore = rows.length > filter.limit;
    const last = page.at(-1);
    return {
      evidence: page,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
    };
  }
}
