import type { Debate } from "@switchyard/contracts";
import type { DebateStore } from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

type DebateRow = {
  id: string;
  topic: string;
  mode: string;
  status: string;
  participants_json: unknown;
  limits_json: unknown;
  evidence_ids_json: unknown;
  message_ids_json: unknown;
  event_ids_json: unknown;
  budget_json: unknown;
  judge_json: unknown;
  final_report_artifact_id: string | null;
  final_report_path: string | null;
  stop_reason: string | null;
  error_json: unknown;
  created_at: string;
  updated_at: string | null;
  completed_at: string | null;
};

function toRow(value: Debate): unknown[] {
  return [
    value.id,
    value.topic,
    value.mode,
    value.status,
    value.participants,
    value.limits,
    value.evidenceIds,
    value.messageIds,
    value.eventIds,
    value.budget,
    value.judge ?? null,
    value.finalReportArtifactId ?? null,
    value.finalReportPath ?? null,
    value.stopReason ?? null,
    value.error ?? null,
    value.createdAt,
    value.updatedAt ?? null,
    value.completedAt ?? null
  ];
}

function fromRow(row: DebateRow): Debate {
  const debate: Debate = {
    id: row.id,
    topic: row.topic,
    mode: row.mode as Debate["mode"],
    status: row.status as Debate["status"],
    participants: row.participants_json as Debate["participants"],
    limits: row.limits_json as Debate["limits"],
    evidenceIds: row.evidence_ids_json as Debate["evidenceIds"],
    messageIds: row.message_ids_json as Debate["messageIds"],
    eventIds: row.event_ids_json as Debate["eventIds"],
    budget: row.budget_json as Debate["budget"],
    createdAt: row.created_at
  };

  if (row.judge_json !== null) {
    debate.judge = row.judge_json as Debate["judge"];
  }
  if (row.final_report_artifact_id !== null) {
    debate.finalReportArtifactId = row.final_report_artifact_id;
  }
  if (row.final_report_path !== null) {
    debate.finalReportPath = row.final_report_path;
  }
  if (row.stop_reason !== null) {
    debate.stopReason = row.stop_reason as Debate["stopReason"];
  }
  if (row.error_json !== null) {
    debate.error = row.error_json as Debate["error"];
  }
  if (row.updated_at !== null) {
    debate.updatedAt = row.updated_at;
  }
  if (row.completed_at !== null) {
    debate.completedAt = row.completed_at;
  }

  return debate;
}

export class PostgresDebateStore implements DebateStore {
  private readonly items = new Map<string, Debate>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(value: Debate): Promise<Debate> {
    if (this.handle) {
      await this.upsert(value);
      return value;
    }
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<Debate | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM debates WHERE id = $1 LIMIT 1", [id]);
      const row = result.rows[0] as DebateRow | undefined;
      return row ? fromRow(row) : undefined;
    }
    return this.items.get(id);
  }

  async update(value: Debate): Promise<Debate> {
    if (this.handle) {
      await this.upsert(value);
      return value;
    }
    this.items.set(value.id, value);
    return value;
  }

  private async upsert(value: Debate): Promise<void> {
    await this.handle?.pool.query(
      `INSERT INTO debates (
        id, topic, mode, status, participants_json, limits_json, evidence_ids_json, message_ids_json,
        event_ids_json, budget_json, judge_json, final_report_artifact_id, final_report_path,
        stop_reason, error_json, created_at, updated_at, completed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (id) DO UPDATE SET
        topic = EXCLUDED.topic,
        mode = EXCLUDED.mode,
        status = EXCLUDED.status,
        participants_json = EXCLUDED.participants_json,
        limits_json = EXCLUDED.limits_json,
        evidence_ids_json = EXCLUDED.evidence_ids_json,
        message_ids_json = EXCLUDED.message_ids_json,
        event_ids_json = EXCLUDED.event_ids_json,
        budget_json = EXCLUDED.budget_json,
        judge_json = EXCLUDED.judge_json,
        final_report_artifact_id = EXCLUDED.final_report_artifact_id,
        final_report_path = EXCLUDED.final_report_path,
        stop_reason = EXCLUDED.stop_reason,
        error_json = EXCLUDED.error_json,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        completed_at = EXCLUDED.completed_at`,
      toRow(value)
    );
  }
}
