import type { RoutedMessage } from "@switchyard/contracts";
import type { ListMessagesFilter, ListMessagesResult, MessageStore } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { messages } from "./schema.js";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";

type MessageRow = typeof messages.$inferSelect;
type MessageInsertRow = Omit<typeof messages.$inferInsert, "fromRunId" | "toRunId" | "channel" | "deliveredAt"> & {
  fromRunId: string | null;
  toRunId: string | null;
  channel: string | null;
  deliveredAt: string | null;
};
type MessageUpdateRow = Omit<
  typeof messages.$inferInsert,
  "fromRunId" | "toRunId" | "channel" | "deliveredAt"
> & {
  fromRunId: string | null;
  toRunId: string | null;
  channel: string | null;
  deliveredAt: string | null;
};

function toRow(message: RoutedMessage): MessageInsertRow {
  return {
    id: message.id,
    fromRunId: message.fromRunId ?? null,
    toRunId: message.toRunId ?? null,
    channel: message.channel ?? null,
    content: message.content,
    attachmentsJson: JSON.stringify(message.attachments),
    deliveryStatus: message.deliveryStatus,
    createdAt: message.createdAt,
    deliveredAt: message.deliveredAt ?? null
  };
}

function toUpdateRow(message: RoutedMessage): MessageUpdateRow {
  return {
    id: message.id,
    fromRunId: message.fromRunId ?? null,
    toRunId: message.toRunId ?? null,
    channel: message.channel ?? null,
    content: message.content,
    attachmentsJson: JSON.stringify(message.attachments),
    deliveryStatus: message.deliveryStatus,
    createdAt: message.createdAt,
    deliveredAt: message.deliveredAt ?? null
  };
}

function fromRow(row: MessageRow): RoutedMessage {
  const message: RoutedMessage = {
    id: row.id,
    content: row.content,
    attachments: JSON.parse(row.attachmentsJson),
    deliveryStatus: row.deliveryStatus as RoutedMessage["deliveryStatus"],
    createdAt: row.createdAt
  };

  if (row.fromRunId !== null) {
    message.fromRunId = row.fromRunId;
  }
  if (row.toRunId !== null) {
    message.toRunId = row.toRunId;
  }
  if (row.channel !== null) {
    message.channel = row.channel;
  }
  if (row.deliveredAt !== null) {
    message.deliveredAt = row.deliveredAt;
  }

  return message;
}

export class SqliteMessageStore implements MessageStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(message: RoutedMessage): Promise<RoutedMessage> {
    await this.db.insert(messages).values(toRow(message));
    return message;
  }

  async get(id: string): Promise<RoutedMessage | undefined> {
    const rows = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return fromRow(row);
  }

  async update(message: RoutedMessage): Promise<RoutedMessage> {
    await this.db.update(messages).set(toUpdateRow(message)).where(eq(messages.id, message.id));
    return message;
  }

  async list(filter: ListMessagesFilter): Promise<ListMessagesResult> {
    const conditions: Array<ReturnType<typeof eq> | ReturnType<typeof or>> = [];
    if (filter.runId) {
      const runCondition = or(eq(messages.fromRunId, filter.runId), eq(messages.toRunId, filter.runId));
      if (runCondition) conditions.push(runCondition);
    }
    if (filter.channel) {
      conditions.push(eq(messages.channel, filter.channel));
    }
    if (filter.deliveryStatus) {
      conditions.push(eq(messages.deliveryStatus, filter.deliveryStatus));
    }
    if (filter.before) {
      const cursorCondition = or(
        lt(messages.createdAt, filter.before.createdAt),
        and(eq(messages.createdAt, filter.before.createdAt), lt(messages.id, filter.before.id))
      );
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const overFetch = filter.limit + 1;
    const baseQuery = this.db
      .select()
      .from(messages)
      .orderBy(desc(messages.createdAt), desc(sql`${messages.id}`))
      .limit(overFetch);
    const query = whereClause ? baseQuery.where(whereClause) : baseQuery;
    const rows = await query;
    const page = rows.slice(0, filter.limit).map(fromRow);
    const hasMore = rows.length > filter.limit;
    const last = page.at(-1);
    return {
      messages: page,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
    };
  }
}
