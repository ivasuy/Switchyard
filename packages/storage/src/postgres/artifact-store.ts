import type { Artifact } from "@switchyard/contracts";
import type { ArtifactStore } from "@switchyard/core";

export class PostgresArtifactStore implements ArtifactStore {
  private readonly items = new Map<string, Artifact>();

  async create(artifact: Artifact): Promise<Artifact> {
    this.items.set(artifact.id, artifact);
    return artifact;
  }

  async get(id: string): Promise<Artifact | undefined> {
    return this.items.get(id);
  }

  async update(artifact: Artifact): Promise<Artifact> {
    this.items.set(artifact.id, artifact);
    return artifact;
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    return [...this.items.values()].filter((artifact) => artifact.runId === runId);
  }

  async listByDebate(debateId: string): Promise<Artifact[]> {
    return [...this.items.values()].filter((artifact) => artifact.debateId === debateId);
  }
}
