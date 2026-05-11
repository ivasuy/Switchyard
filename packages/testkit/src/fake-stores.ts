import type { Artifact, Run, RuntimeSession, SwitchyardEvent } from "@switchyard/contracts";
import type { ArtifactStore, EventStore, PlacementDecisionRecord, PlacementStore, RunStore, SessionStore } from "@switchyard/core";

export class InMemoryRunStore implements RunStore {
  readonly items = new Map<string, Run>();

  async create(run: Run): Promise<Run> {
    this.items.set(run.id, run);
    return run;
  }

  async get(id: string): Promise<Run | undefined> {
    return this.items.get(id);
  }

  async update(run: Run): Promise<Run> {
    this.items.set(run.id, run);
    return run;
  }
}

export class InMemoryEventStore implements EventStore {
  readonly items: SwitchyardEvent[] = [];

  async append(event: SwitchyardEvent): Promise<SwitchyardEvent> {
    this.items.push(event);
    return event;
  }

  async listByRun(runId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((event) => event.runId === runId);
  }
}

export class InMemorySessionStore implements SessionStore {
  readonly items = new Map<string, RuntimeSession>();

  async create(session: RuntimeSession): Promise<RuntimeSession> {
    this.items.set(session.id, session);
    return session;
  }

  async get(id: string): Promise<RuntimeSession | undefined> {
    return this.items.get(id);
  }

  async getByRunId(runId: string): Promise<RuntimeSession | undefined> {
    return [...this.items.values()].find((session) => session.runId === runId);
  }

  async update(session: RuntimeSession): Promise<RuntimeSession> {
    this.items.set(session.id, session);
    return session;
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  readonly items = new Map<string, Artifact>();

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
}

export class InMemoryPlacementStore implements PlacementStore {
  readonly items = new Map<string, PlacementDecisionRecord>();

  async create(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> {
    this.items.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<PlacementDecisionRecord | undefined> {
    return this.items.get(id);
  }

  async update(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> {
    this.items.set(record.id, record);
    return record;
  }

  async listByRun(runId: string): Promise<PlacementDecisionRecord[]> {
    return [...this.items.values()].filter((record) => record.runId === runId);
  }
}
