import type { EvidenceItem } from "@switchyard/contracts";
import type { EvidenceStore, ListEvidenceFilter, ListEvidenceResult } from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

type EvidenceRow = {
  id: string;
  debate_id: string | null;
  source_type: EvidenceItem["sourceType"];
  url: string | null;
  title: string;
  snippet: string | null;
  fetched_content_path: string | null;
  reliability: EvidenceItem["reliability"];
  created_at: string;
};

function toRow(item: EvidenceItem): unknown[] {
  return [
    item.id,
    item.debateId ?? null,
    item.sourceType,
    item.url ?? null,
    item.title,
    item.snippet ?? null,
    item.fetchedContentPath ?? null,
    item.reliability,
    item.createdAt
  ];
}

function fromRow(row: EvidenceRow): EvidenceItem {
  const item: EvidenceItem = {
    id: row.id,
    sourceType: row.source_type,
    title: row.title,
    reliability: row.reliability,
    createdAt: row.created_at
  };
  if (row.debate_id !== null) {
    item.debateId = row.debate_id;
  }
  if (row.url !== null) {
    item.url = row.url;
  }
  if (row.snippet !== null) {
    item.snippet = row.snippet;
  }
  if (row.fetched_content_path !== null) {
    item.fetchedContentPath = row.fetched_content_path;
  }
  return item;
}

function matchesFilter(item: EvidenceItem, filter: ListEvidenceFilter): boolean {
  if (filter.debateId && item.debateId !== filter.debateId) {
    return false;
  }
  if (filter.sourceType && item.sourceType !== filter.sourceType) {
    return false;
  }
  if (filter.reliability && item.reliability !== filter.reliability) {
    return false;
  }
  if (filter.q) {
    const needle = filter.q.toLowerCase();
    const title = item.title.toLowerCase();
    const snippet = item.snippet?.toLowerCase() ?? "";
    if (!title.includes(needle) && !snippet.includes(needle)) {
      return false;
    }
  }
  if (filter.before) {
    if (item.createdAt > filter.before.createdAt) {
      return false;
    }
    if (item.createdAt === filter.before.createdAt && item.id >= filter.before.id) {
      return false;
    }
  }
  return true;
}

function sortEvidence(items: EvidenceItem[]): EvidenceItem[] {
  return items.sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return right.id.localeCompare(left.id);
    }
    return left.createdAt > right.createdAt ? -1 : 1;
  });
}

function pageEvidence(items: EvidenceItem[], filter: ListEvidenceFilter): ListEvidenceResult {
  const filtered = sortEvidence(items).filter((item) => matchesFilter(item, filter));
  const page = filtered.slice(0, filter.limit);
  const hasMore = filtered.length > filter.limit;
  const last = page.at(-1);
  return {
    evidence: page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
  };
}

export class PostgresEvidenceStore implements EvidenceStore {
  private readonly items = new Map<string, EvidenceItem>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(value: EvidenceItem): Promise<EvidenceItem> {
    if (this.handle) {
      await this.upsert(value);
      return value;
    }
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<EvidenceItem | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM evidence_items WHERE id = $1 LIMIT 1", [id]);
      const row = result.rows[0] as EvidenceRow | undefined;
      return row ? fromRow(row) : undefined;
    }
    return this.items.get(id);
  }

  async update(value: EvidenceItem): Promise<EvidenceItem> {
    if (this.handle) {
      await this.upsert(value);
      return value;
    }
    this.items.set(value.id, value);
    return value;
  }

  async list(filter: ListEvidenceFilter): Promise<ListEvidenceResult> {
    if (this.handle) {
      const values: unknown[] = [];
      const where: string[] = [];

      if (filter.debateId) {
        values.push(filter.debateId);
        where.push(`debate_id = $${values.length}`);
      }
      if (filter.sourceType) {
        values.push(filter.sourceType);
        where.push(`source_type = $${values.length}`);
      }
      if (filter.reliability) {
        values.push(filter.reliability);
        where.push(`reliability = $${values.length}`);
      }
      if (filter.q) {
        values.push(`%${filter.q.toLowerCase()}%`);
        where.push(`(LOWER(title) LIKE $${values.length} OR LOWER(COALESCE(snippet, '')) LIKE $${values.length})`);
      }
      if (filter.before) {
        values.push(filter.before.createdAt, filter.before.createdAt, filter.before.id);
        const idx = values.length;
        where.push(`(created_at < $${idx - 2} OR (created_at = $${idx - 1} AND id < $${idx}))`);
      }

      values.push(filter.limit + 1);
      const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const limitIdx = values.length;

      const result = await this.handle.pool.query(
        `SELECT * FROM evidence_items
         ${whereClause}
         ORDER BY created_at DESC, id DESC
         LIMIT $${limitIdx}`,
        values
      );
      const rows = result.rows as EvidenceRow[];
      const page = rows.slice(0, filter.limit).map(fromRow);
      const hasMore = rows.length > filter.limit;
      const last = page.at(-1);
      return {
        evidence: page,
        nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
      };
    }

    return pageEvidence([...this.items.values()], filter);
  }

  private async upsert(value: EvidenceItem): Promise<void> {
    await this.handle?.pool.query(
      `INSERT INTO evidence_items (
        id, debate_id, source_type, url, title, snippet, fetched_content_path, reliability, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        debate_id = EXCLUDED.debate_id,
        source_type = EXCLUDED.source_type,
        url = EXCLUDED.url,
        title = EXCLUDED.title,
        snippet = EXCLUDED.snippet,
        fetched_content_path = EXCLUDED.fetched_content_path,
        reliability = EXCLUDED.reliability,
        created_at = EXCLUDED.created_at`,
      toRow(value)
    );
  }
}
