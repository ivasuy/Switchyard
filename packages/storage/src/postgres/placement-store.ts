import type { PlacementDecisionRecord, PlacementStore } from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

export class PostgresPlacementStore implements PlacementStore {
  private readonly items = new Map<string, PlacementDecisionRecord>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> {
    if (!record.runId) throw new Error("placement records require a runId");
    if (this.handle) {
      await this.upsert(record);
      return record;
    }
    this.items.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<PlacementDecisionRecord | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM placement_decisions WHERE id = $1", [id]);
      return result.rows[0] ? rowToPlacement(result.rows[0]) : undefined;
    }
    return this.items.get(id);
  }

  async update(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> {
    if (!record.runId) throw new Error("placement records require a runId");
    if (this.handle) {
      await this.upsert(record);
      return record;
    }
    this.items.set(record.id, record);
    return record;
  }

  async listByRun(runId: string): Promise<PlacementDecisionRecord[]> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM placement_decisions WHERE run_id = $1 ORDER BY created_at ASC", [runId]);
      return result.rows.map(rowToPlacement);
    }
    return [...this.items.values()].filter((record) => record.runId === runId);
  }

  private async upsert(record: PlacementDecisionRecord): Promise<void> {
    await this.handle?.pool.query(
      `INSERT INTO placement_decisions (
        id, run_id, decision, reason, mode, target_node, required_capabilities,
        denied_capabilities, approval_required, policy_trace, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        decision = EXCLUDED.decision,
        reason = EXCLUDED.reason,
        mode = EXCLUDED.mode,
        target_node = EXCLUDED.target_node,
        required_capabilities = EXCLUDED.required_capabilities,
        denied_capabilities = EXCLUDED.denied_capabilities,
        approval_required = EXCLUDED.approval_required,
        policy_trace = EXCLUDED.policy_trace,
        created_at = EXCLUDED.created_at`,
      [
        record.id,
        record.runId,
        record.decision,
        record.reason,
        record.mode,
        record.targetNode ?? null,
        record.requiredCapabilities,
        record.deniedCapabilities,
        record.approvalRequired,
        record.policyTrace,
        record.createdAt
      ]
    );
  }
}

function rowToPlacement(row: Record<string, unknown>): PlacementDecisionRecord {
  const record: PlacementDecisionRecord = {
    id: row["id"] as string,
    runId: row["run_id"] as string,
    decision: row["decision"] as PlacementDecisionRecord["decision"],
    reason: row["reason"] as string,
    mode: row["mode"] as PlacementDecisionRecord["mode"],
    requiredCapabilities: row["required_capabilities"] as string[],
    deniedCapabilities: row["denied_capabilities"] as string[],
    approvalRequired: row["approval_required"] as boolean,
    policyTrace: row["policy_trace"] as string[],
    createdAt: row["created_at"] as string
  };
  if (row["target_node"]) record.targetNode = row["target_node"] as string;
  return record;
}
