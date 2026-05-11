import type { RoutedMessage } from "@switchyard/contracts";
import type { MessageStore } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { messages } from "./schema.js";
import { eq } from "drizzle-orm";

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
}
