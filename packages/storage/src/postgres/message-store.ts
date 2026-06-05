import type { RoutedMessage } from "@switchyard/contracts";
import type { ListMessagesFilter, ListMessagesResult, MessageStore } from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

type MessageRow = {
  id: string;
  from_run_id: string | null;
  to_run_id: string | null;
  channel: string | null;
  content: string;
  attachments_json: unknown;
  delivery_status: RoutedMessage["deliveryStatus"];
  created_at: string;
  delivered_at: string | null;
};

type SortableMessage = RoutedMessage & {
  __debateId?: string;
};

function deriveDebateId(channel: string | undefined): string | undefined {
  if (!channel) {
    return undefined;
  }
  if (!channel.startsWith("debate:")) {
    return undefined;
  }
  const value = channel.slice("debate:".length).trim();
  return value.length > 0 ? value : undefined;
}

function toRow(message: RoutedMessage): unknown[] {
  return [
    message.id,
    message.fromRunId ?? null,
    message.toRunId ?? null,
    message.channel ?? null,
    deriveDebateId(message.channel) ?? null,
    message.content,
    message.attachments,
    message.deliveryStatus,
    message.createdAt,
    message.deliveredAt ?? null
  ];
}

function fromRow(row: MessageRow): RoutedMessage {
  const value: RoutedMessage = {
    id: row.id,
    content: row.content,
    attachments: row.attachments_json as RoutedMessage["attachments"],
    deliveryStatus: row.delivery_status,
    createdAt: row.created_at
  };
  if (row.from_run_id !== null) {
    value.fromRunId = row.from_run_id;
  }
  if (row.to_run_id !== null) {
    value.toRunId = row.to_run_id;
  }
  if (row.channel !== null) {
    value.channel = row.channel;
  }
  if (row.delivered_at !== null) {
    value.deliveredAt = row.delivered_at;
  }
  return value;
}

function sortMessages(messages: SortableMessage[]): SortableMessage[] {
  return messages.sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return right.id.localeCompare(left.id);
    }
    return left.createdAt > right.createdAt ? -1 : 1;
  });
}

function matchesFilter(message: SortableMessage, filter: ListMessagesFilter): boolean {
  if (filter.runId) {
    const matchesRun = message.fromRunId === filter.runId || message.toRunId === filter.runId;
    if (!matchesRun) {
      return false;
    }
  }
  if (filter.channel && message.channel !== filter.channel) {
    return false;
  }
  if (filter.deliveryStatus && message.deliveryStatus !== filter.deliveryStatus) {
    return false;
  }
  if (filter.before) {
    if (message.createdAt > filter.before.createdAt) {
      return false;
    }
    if (message.createdAt === filter.before.createdAt && message.id >= filter.before.id) {
      return false;
    }
  }
  return true;
}

function pageMessages(messages: SortableMessage[], filter: ListMessagesFilter): ListMessagesResult {
  const filtered = sortMessages(messages).filter((message) => matchesFilter(message, filter));
  const page = filtered.slice(0, filter.limit).map(({ __debateId: _debateId, ...value }) => value);
  const hasMore = filtered.length > filter.limit;
  const last = page.at(-1);
  return {
    messages: page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
  };
}

function withDebateMarker(message: RoutedMessage): SortableMessage {
  const debateId = deriveDebateId(message.channel);
  if (debateId === undefined) {
    return { ...message };
  }
  return { ...message, __debateId: debateId };
}

export class PostgresMessageStore implements MessageStore {
  private readonly items = new Map<string, SortableMessage>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(message: RoutedMessage): Promise<RoutedMessage> {
    if (this.handle) {
      await this.upsert(message);
      return message;
    }
    this.items.set(message.id, withDebateMarker(message));
    return message;
  }

  async get(id: string): Promise<RoutedMessage | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM messages WHERE id = $1 LIMIT 1", [id]);
      const row = result.rows[0] as MessageRow | undefined;
      return row ? fromRow(row) : undefined;
    }
    const found = this.items.get(id);
    if (!found) {
      return undefined;
    }
    const { __debateId: _debateId, ...value } = found;
    return value;
  }

  async update(message: RoutedMessage): Promise<RoutedMessage> {
    if (this.handle) {
      await this.upsert(message);
      return message;
    }
    this.items.set(message.id, withDebateMarker(message));
    return message;
  }

  async list(filter: ListMessagesFilter): Promise<ListMessagesResult> {
    if (this.handle) {
      const values: unknown[] = [];
      const where: string[] = [];

      if (filter.runId) {
        values.push(filter.runId, filter.runId);
        const idx = values.length;
        where.push(`(from_run_id = $${idx - 1} OR to_run_id = $${idx})`);
      }
      if (filter.channel) {
        values.push(filter.channel);
        where.push(`channel = $${values.length}`);
      }
      if (filter.deliveryStatus) {
        values.push(filter.deliveryStatus);
        where.push(`delivery_status = $${values.length}`);
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
        `SELECT * FROM messages
         ${whereClause}
         ORDER BY created_at DESC, id DESC
         LIMIT $${limitIdx}`,
        values
      );
      const rows = result.rows as MessageRow[];
      const page = rows.slice(0, filter.limit).map(fromRow);
      const hasMore = rows.length > filter.limit;
      const last = page.at(-1);
      return {
        messages: page,
        nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
      };
    }

    return pageMessages([...this.items.values()], filter);
  }

  private async upsert(message: RoutedMessage): Promise<void> {
    await this.handle?.pool.query(
      `INSERT INTO messages (
        id, from_run_id, to_run_id, channel, debate_id, content, attachments_json,
        delivery_status, created_at, delivered_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO UPDATE SET
        from_run_id = EXCLUDED.from_run_id,
        to_run_id = EXCLUDED.to_run_id,
        channel = EXCLUDED.channel,
        debate_id = EXCLUDED.debate_id,
        content = EXCLUDED.content,
        attachments_json = EXCLUDED.attachments_json,
        delivery_status = EXCLUDED.delivery_status,
        created_at = EXCLUDED.created_at,
        delivered_at = EXCLUDED.delivered_at`,
      toRow(message)
    );
  }
}
