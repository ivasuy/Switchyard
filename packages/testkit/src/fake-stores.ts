import type { Artifact, Model, Provider, Run, RuntimeSession, RuntimeTarget, SwitchyardEvent } from "@switchyard/contracts";
import type {
  ArtifactStore,
  EventStore,
  ListModelsFilter,
  ListModelsResult,
  ListProvidersFilter,
  ListProvidersResult,
  ListRunsFilter,
  ListRunsResult,
  ListRuntimesFilter,
  ListRuntimesResult,
  PlacementDecisionRecord,
  PlacementStore,
  RegistryStore,
  RunStore,
  SessionStore
} from "@switchyard/core";

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

  async list(filter: ListRunsFilter): Promise<ListRunsResult> {
    const matchesCsv = (allowed: readonly string[] | undefined, value: string): boolean =>
      !allowed || allowed.length === 0 || allowed.includes(value);

    const sorted = [...this.items.values()].sort((left, right) => {
      if (left.createdAt === right.createdAt) {
        return right.id.localeCompare(left.id);
      }
      return left.createdAt > right.createdAt ? -1 : 1;
    });

    const filtered = sorted.filter((run) => {
      if (!matchesCsv(filter.status, run.status)) {
        return false;
      }
      if (!matchesCsv(filter.runtime, run.runtime)) {
        return false;
      }
      if (!matchesCsv(filter.provider, run.provider)) {
        return false;
      }
      if (!matchesCsv(filter.model, run.model)) {
        return false;
      }
      if (!matchesCsv(filter.placement, run.placement)) {
        return false;
      }
      if (!matchesCsv(filter.adapterType, run.adapterType)) {
        return false;
      }
      if (filter.since !== undefined && run.createdAt < filter.since) {
        return false;
      }
      if (filter.until !== undefined && run.createdAt >= filter.until) {
        return false;
      }
      if (filter.before) {
        if (run.createdAt > filter.before.createdAt) {
          return false;
        }
        if (run.createdAt === filter.before.createdAt && run.id >= filter.before.id) {
          return false;
        }
      }
      return true;
    });

    const page = filtered.slice(0, filter.limit);
    const hasMore = filtered.length > filter.limit;
    const last = page.at(-1);
    return {
      runs: page,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
    };
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
    if (!record.runId) {
      throw new Error("placement records require a runId");
    }
    this.items.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<PlacementDecisionRecord | undefined> {
    return this.items.get(id);
  }

  async update(record: PlacementDecisionRecord): Promise<PlacementDecisionRecord> {
    if (!record.runId) {
      throw new Error("placement records require a runId");
    }
    this.items.set(record.id, record);
    return record;
  }

  async listByRun(runId: string): Promise<PlacementDecisionRecord[]> {
    return [...this.items.values()].filter((record) => record.runId === runId);
  }
}

export class InMemoryRegistryStore implements RegistryStore {
  readonly providers = new Map<string, Provider>();
  readonly runtimes = new Map<string, RuntimeTarget>();
  readonly models = new Map<string, Model>();

  async createProvider(provider: Provider): Promise<Provider> {
    this.providers.set(provider.id, provider);
    return provider;
  }

  async createRuntime(runtime: RuntimeTarget): Promise<RuntimeTarget> {
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }

  async createModel(model: Model): Promise<Model> {
    this.models.set(model.id, model);
    return model;
  }

  async getProvider(id: string): Promise<Provider | undefined> {
    return this.providers.get(id);
  }

  async getRuntime(id: string): Promise<RuntimeTarget | undefined> {
    return this.runtimes.get(id);
  }

  async getModel(id: string): Promise<Model | undefined> {
    return this.models.get(id);
  }

  async listProviders(filter: ListProvidersFilter): Promise<ListProvidersResult> {
    const sorted = [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id));
    const filtered = filter.before ? sorted.filter((row) => row.id > filter.before!.id) : sorted;
    const page = filtered.slice(0, filter.limit);
    const hasMore = filtered.length > filter.limit;
    const last = page.at(-1);
    return { providers: page, nextCursor: hasMore && last ? { id: last.id } : null };
  }

  async listRuntimes(filter: ListRuntimesFilter): Promise<ListRuntimesResult> {
    const sorted = [...this.runtimes.values()].sort((left, right) => left.id.localeCompare(right.id));
    const filtered = sorted.filter((runtime) => {
      if (filter.providerIds && filter.providerIds.length > 0) {
        if (!runtime.providerId || !filter.providerIds.includes(runtime.providerId)) {
          return false;
        }
      }
      if (filter.adapterType && filter.adapterType.length > 0) {
        if (!filter.adapterType.includes(runtime.adapterType)) {
          return false;
        }
      }
      if (filter.before && runtime.id <= filter.before.id) {
        return false;
      }
      return true;
    });
    const page = filtered.slice(0, filter.limit);
    const hasMore = filtered.length > filter.limit;
    const last = page.at(-1);
    return { runtimes: page, nextCursor: hasMore && last ? { id: last.id } : null };
  }

  async listModels(filter: ListModelsFilter): Promise<ListModelsResult> {
    const sorted = [...this.models.values()].sort((left, right) => left.id.localeCompare(right.id));
    const filtered = sorted.filter((model) => {
      if (filter.providerIds && filter.providerIds.length > 0) {
        if (!filter.providerIds.includes(model.providerId)) {
          return false;
        }
      }
      if (filter.before && model.id <= filter.before.id) {
        return false;
      }
      return true;
    });
    const page = filtered.slice(0, filter.limit);
    const hasMore = filtered.length > filter.limit;
    const last = page.at(-1);
    return { models: page, nextCursor: hasMore && last ? { id: last.id } : null };
  }
}
