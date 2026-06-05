import type { SwitchyardEvent } from "@switchyard/contracts";
import type { EventStore } from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

export class PostgresEventStore implements EventStore {
  private readonly items: SwitchyardEvent[] = [];

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> {
    if (this.handle) {
      await this.handle.pool.query(
        `INSERT INTO run_events (
          id, type, run_id, debate_id, participant_id, provider, model, sequence, payload, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO UPDATE SET
          type = EXCLUDED.type,
          run_id = EXCLUDED.run_id,
          debate_id = EXCLUDED.debate_id,
          participant_id = EXCLUDED.participant_id,
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          sequence = EXCLUDED.sequence,
          payload = EXCLUDED.payload,
          created_at = EXCLUDED.created_at`,
        [
          event.id,
          event.type,
          event.runId ?? null,
          event.debateId ?? null,
          event.participantId ?? null,
          event.provider ?? null,
          event.model ?? null,
          event.sequence,
          event.payload,
          event.createdAt
        ]
      );
      return event;
    }
    this.items.push(event);
    return event;
  }

  async listByRun(runId: string): Promise<SwitchyardEvent[]> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM run_events WHERE run_id = $1 ORDER BY sequence ASC", [runId]);
      return result.rows.map(rowToEvent);
    }
    return this.items.filter((event) => event.runId === runId).sort((a, b) => a.sequence - b.sequence);
  }

  async listByDebate(debateId: string): Promise<SwitchyardEvent[]> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM run_events WHERE debate_id = $1 ORDER BY sequence ASC", [debateId]);
      return result.rows.map(rowToEvent);
    }
    return this.items.filter((event) => event.debateId === debateId).sort((a, b) => a.sequence - b.sequence);
  }
}

function rowToEvent(row: Record<string, unknown>): SwitchyardEvent {
  const event: SwitchyardEvent = {
    id: row["id"] as string,
    type: row["type"] as SwitchyardEvent["type"],
    sequence: row["sequence"] as number,
    payload: row["payload"] as Record<string, unknown>,
    createdAt: row["created_at"] as string
  };
  if (row["run_id"]) event.runId = row["run_id"] as string;
  if (row["debate_id"]) event.debateId = row["debate_id"] as string;
  if (row["participant_id"]) event.participantId = row["participant_id"] as string;
  if (row["provider"]) event.provider = row["provider"] as string;
  if (row["model"]) event.model = row["model"] as string;
  return event;
}
