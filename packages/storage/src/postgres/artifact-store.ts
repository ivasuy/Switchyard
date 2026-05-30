import type { Artifact } from "@switchyard/contracts";
import type { ArtifactStore } from "@switchyard/core";
import type { PostgresDatabaseHandle } from "./database.js";

export class PostgresArtifactStore implements ArtifactStore {
  private readonly items = new Map<string, Artifact>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(artifact: Artifact): Promise<Artifact> {
    if (this.handle) {
      await this.upsert(artifact);
      return artifact;
    }
    this.items.set(artifact.id, artifact);
    return artifact;
  }

  async get(id: string): Promise<Artifact | undefined> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM artifacts WHERE id = $1", [id]);
      return result.rows[0] ? rowToArtifact(result.rows[0]) : undefined;
    }
    return this.items.get(id);
  }

  async update(artifact: Artifact): Promise<Artifact> {
    if (this.handle) {
      await this.upsert(artifact);
      return artifact;
    }
    this.items.set(artifact.id, artifact);
    return artifact;
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM artifacts WHERE run_id = $1 ORDER BY created_at ASC, id ASC", [runId]);
      return result.rows.map(rowToArtifact);
    }
    return [...this.items.values()].filter((artifact) => artifact.runId === runId);
  }

  async listByDebate(debateId: string): Promise<Artifact[]> {
    if (this.handle) {
      const result = await this.handle.pool.query("SELECT * FROM artifacts WHERE debate_id = $1 ORDER BY created_at ASC, id ASC", [debateId]);
      return result.rows.map(rowToArtifact);
    }
    return [...this.items.values()].filter((artifact) => artifact.debateId === debateId);
  }

  private async upsert(artifact: Artifact): Promise<void> {
    await this.handle?.pool.query(
      `INSERT INTO artifacts (
        id, run_id, debate_id, provider, model, type, path, metadata, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        debate_id = EXCLUDED.debate_id,
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        type = EXCLUDED.type,
        path = EXCLUDED.path,
        metadata = EXCLUDED.metadata,
        created_at = EXCLUDED.created_at`,
      [
        artifact.id,
        artifact.runId ?? null,
        artifact.debateId ?? null,
        artifact.provider ?? null,
        artifact.model ?? null,
        artifact.type,
        artifact.path,
        artifact.metadata,
        artifact.createdAt
      ]
    );
  }
}

function rowToArtifact(row: Record<string, unknown>): Artifact {
  const artifact: Artifact = {
    id: row["id"] as string,
    type: row["type"] as Artifact["type"],
    path: row["path"] as string,
    metadata: row["metadata"] as Record<string, unknown>,
    createdAt: row["created_at"] as string
  };
  if (row["run_id"]) artifact.runId = row["run_id"] as string;
  if (row["debate_id"]) artifact.debateId = row["debate_id"] as string;
  if (row["provider"]) artifact.provider = row["provider"] as string;
  if (row["model"]) artifact.model = row["model"] as string;
  return artifact;
}
