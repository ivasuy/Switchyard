import type { Artifact } from "@switchyard/contracts";
import type { ArtifactStore } from "@switchyard/core";
import type { SwitchyardSqliteDatabase } from "./database.js";
import { artifacts } from "./schema.js";
import { asc, eq } from "drizzle-orm";

type ArtifactRow = typeof artifacts.$inferSelect;
type ArtifactInsertRow = Omit<
  typeof artifacts.$inferInsert,
  "runId" | "debateId" | "provider" | "model"
> & {
  runId?: string;
  debateId?: string;
  provider?: string;
  model?: string;
};
type ArtifactUpdateRow = Omit<typeof artifacts.$inferInsert, "runId" | "debateId" | "provider" | "model"> & {
  runId: string | null;
  debateId: string | null;
  provider: string | null;
  model: string | null;
};

function toRow(artifact: Artifact): ArtifactInsertRow {
  const row: ArtifactInsertRow = {
    id: artifact.id,
    type: artifact.type,
    path: artifact.path,
    metadataJson: JSON.stringify(artifact.metadata),
    createdAt: artifact.createdAt
  };
  if (artifact.runId !== undefined) {
    row.runId = artifact.runId;
  }
  if (artifact.debateId !== undefined) {
    row.debateId = artifact.debateId;
  }
  if (artifact.provider !== undefined) {
    row.provider = artifact.provider;
  }
  if (artifact.model !== undefined) {
    row.model = artifact.model;
  }
  return row;
}

function toUpdateRow(artifact: Artifact): ArtifactUpdateRow {
  return {
    id: artifact.id,
    type: artifact.type,
    path: artifact.path,
    metadataJson: JSON.stringify(artifact.metadata),
    createdAt: artifact.createdAt,
    runId: artifact.runId ?? null,
    debateId: artifact.debateId ?? null,
    provider: artifact.provider ?? null,
    model: artifact.model ?? null
  };
}

function fromRow(row: ArtifactRow): Artifact {
  const artifact: Artifact = {
    id: row.id,
    type: row.type as Artifact["type"],
    path: row.path,
    metadata: JSON.parse(row.metadataJson),
    createdAt: row.createdAt
  };
  if (row.runId !== null) {
    artifact.runId = row.runId;
  }
  if (row.debateId !== null) {
    artifact.debateId = row.debateId;
  }
  if (row.provider !== null) {
    artifact.provider = row.provider;
  }
  if (row.model !== null) {
    artifact.model = row.model;
  }
  return artifact;
}

export class SqliteArtifactStore implements ArtifactStore {
  constructor(private readonly db: SwitchyardSqliteDatabase) {}

  async create(artifact: Artifact): Promise<Artifact> {
    await this.db.insert(artifacts).values(toRow(artifact));
    return artifact;
  }

  async get(id: string): Promise<Artifact | undefined> {
    const rows = await this.db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return fromRow(row);
  }

  async update(artifact: Artifact): Promise<Artifact> {
    await this.db.update(artifacts).set(toUpdateRow(artifact)).where(eq(artifacts.id, artifact.id));
    return artifact;
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    const rows = await this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .orderBy(asc(artifacts.createdAt));
    return rows.map(fromRow);
  }
}
