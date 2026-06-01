import type { PostgresDatabaseHandle } from "./database.js";

export interface HostedRuntimeBridgePayloadStore {
  put(input: { commandId: string; payload: Record<string, unknown> }): Promise<void>;
  get(commandId: string): Promise<Record<string, unknown> | undefined>;
  delete(commandId: string): Promise<void>;
}

export class PostgresHostedRuntimeBridgePayloadStore implements HostedRuntimeBridgePayloadStore {
  private readonly items = new Map<string, Record<string, unknown>>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async put(input: { commandId: string; payload: Record<string, unknown> }): Promise<void> {
    const now = new Date().toISOString();
    if (this.handle) {
      await this.handle.pool.query(
        `INSERT INTO hosted_runtime_bridge_payloads (command_id, payload, created_at, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (command_id) DO UPDATE SET
           payload = EXCLUDED.payload,
           updated_at = EXCLUDED.updated_at`,
        [input.commandId, input.payload, now, now]
      );
      return;
    }
    this.items.set(input.commandId, input.payload);
  }

  async get(commandId: string): Promise<Record<string, unknown> | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT payload
         FROM hosted_runtime_bridge_payloads
         WHERE command_id = $1
         LIMIT 1`,
        [commandId]
      );
      const payload = result.rows[0]?.["payload"];
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return undefined;
      }
      return payload as Record<string, unknown>;
    }
    return this.items.get(commandId);
  }

  async delete(commandId: string): Promise<void> {
    if (this.handle) {
      await this.handle.pool.query(
        `DELETE FROM hosted_runtime_bridge_payloads
         WHERE command_id = $1`,
        [commandId]
      );
      return;
    }
    this.items.delete(commandId);
  }
}
