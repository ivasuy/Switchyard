import type { ConnectedNode } from "@switchyard/contracts";
import type { NodeStore } from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

export class PostgresNodeStore implements NodeStore {
  private readonly items = new Map<string, ConnectedNode>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async upsert(node: ConnectedNode): Promise<ConnectedNode> {
    if (this.handle) {
      await this.handle.pool.query(
        `INSERT INTO nodes (
          id, mode, status, capabilities, policy, version, created_at, last_seen_at, heartbeat_expires_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO UPDATE SET
          mode = EXCLUDED.mode,
          status = EXCLUDED.status,
          capabilities = EXCLUDED.capabilities,
          policy = EXCLUDED.policy,
          version = EXCLUDED.version,
          created_at = EXCLUDED.created_at,
          last_seen_at = EXCLUDED.last_seen_at,
          heartbeat_expires_at = EXCLUDED.heartbeat_expires_at,
          updated_at = EXCLUDED.updated_at`,
        [
          node.id,
          node.mode,
          node.status,
          node.capabilities,
          node.policy ?? null,
          node.version ?? null,
          node.createdAt,
          node.lastSeenAt ?? null,
          node.heartbeatExpiresAt ?? null,
          node.updatedAt ?? null
        ]
      );
      return node;
    }
    this.items.set(node.id, node);
    return node;
  }

  async get(id: string): Promise<ConnectedNode | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM nodes WHERE id = $1", [id]);
      return result.rows[0] ? rowToNode(result.rows[0]) : undefined;
    }
    return this.items.get(id);
  }

  async list(filter?: { status?: ConnectedNode["status"]; mode?: ConnectedNode["mode"] }): Promise<ConnectedNode[]> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM nodes ORDER BY id ASC");
      return result.rows.map(rowToNode).filter((node) => {
        if (filter?.status && node.status !== filter.status) return false;
        if (filter?.mode && node.mode !== filter.mode) return false;
        return true;
      });
    }
    return [...this.items.values()].filter((node) => {
      if (filter?.status && node.status !== filter.status) return false;
      if (filter?.mode && node.mode !== filter.mode) return false;
      return true;
    });
  }

  async markOffline(id: string, at: string): Promise<ConnectedNode | undefined> {
    if (this.handle) {
      const node = await this.get(id);
      if (!node) return undefined;
      const updated: ConnectedNode = { ...node, status: "offline", updatedAt: at };
      await this.upsert(updated);
      return updated;
    }
    const node = this.items.get(id);
    if (!node) return undefined;
    const updated: ConnectedNode = { ...node, status: "offline", updatedAt: at };
    this.items.set(id, updated);
    return updated;
  }

  async listEligible(input: { runtimeMode: string; now: string; requiredCapabilities?: string[] }): Promise<ConnectedNode[]> {
    const required = input.requiredCapabilities ?? [`runtime.${input.runtimeMode}`];
    const nodes = this.handle ? await this.list({ status: "online" }) : [...this.items.values()];
    return nodes.filter((node) => {
      if (node.status !== "online") return false;
      if (node.heartbeatExpiresAt && node.heartbeatExpiresAt < input.now) return false;
      return required.every((capability) => node.capabilities.includes(capability) || node.capabilities.includes(input.runtimeMode));
    });
  }
}

function rowToNode(row: Record<string, unknown>): ConnectedNode {
  const node: ConnectedNode = {
    id: row["id"] as string,
    mode: row["mode"] as ConnectedNode["mode"],
    status: row["status"] as ConnectedNode["status"],
    capabilities: row["capabilities"] as string[],
    createdAt: row["created_at"] as string
  };
  if (row["policy"]) node.policy = row["policy"] as ConnectedNode["policy"];
  if (row["version"]) node.version = row["version"] as string;
  if (row["last_seen_at"]) node.lastSeenAt = row["last_seen_at"] as string;
  if (row["heartbeat_expires_at"]) node.heartbeatExpiresAt = row["heartbeat_expires_at"] as string;
  if (row["updated_at"]) node.updatedAt = row["updated_at"] as string;
  return node;
}
