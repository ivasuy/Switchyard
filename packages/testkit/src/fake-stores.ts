import type {
  Artifact,
  Debate,
  Model,
  Provider,
  Run,
  RuntimeAvailability,
  RuntimeMode,
  RuntimeSession,
  RuntimeTarget,
  SwitchyardEvent
} from "@switchyard/contracts";
import type {
  ArtifactStore,
  DebateStore,
  EventStore,
  ListModelsFilter,
  ListModelsResult,
  ListProvidersFilter,
  ListProvidersResult,
  ListRuntimeModesFilter,
  ListRuntimeModesResult,
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

  async listByDebate(debateId: string): Promise<SwitchyardEvent[]> {
    return this.items.filter((event) => event.debateId === debateId);
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

  async listByDebate(debateId: string): Promise<Artifact[]> {
    return [...this.items.values()].filter((artifact) => artifact.debateId === debateId);
  }
}

export class InMemoryDebateStore implements DebateStore {
  readonly items = new Map<string, Debate>();

  async create(value: Debate): Promise<Debate> {
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<Debate | undefined> {
    return this.items.get(id);
  }

  async update(value: Debate): Promise<Debate> {
    this.items.set(value.id, value);
    return value;
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
  readonly runtimeModes = new Map<string, RuntimeMode>();
  readonly runtimeModesBySlug = new Map<string, string>();

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

  async upsertRuntimeMode(mode: RuntimeMode): Promise<RuntimeMode> {
    this.runtimeModes.set(mode.id, mode);
    this.runtimeModesBySlug.set(mode.slug, mode.id);
    return mode;
  }

  async getRuntimeMode(idOrSlug: string): Promise<RuntimeMode | undefined> {
    if (idOrSlug.startsWith("runtime_mode_")) {
      return this.runtimeModes.get(idOrSlug);
    }
    const id = this.runtimeModesBySlug.get(idOrSlug);
    return id ? this.runtimeModes.get(id) : undefined;
  }

  async listRuntimeModes(filter: ListRuntimeModesFilter): Promise<ListRuntimeModesResult> {
    const sorted = [...this.runtimeModes.values()].sort((left, right) => left.id.localeCompare(right.id));
    const filtered = sorted.filter((mode) => {
      if (filter.providerIds && filter.providerIds.length > 0 && !filter.providerIds.includes(mode.providerId)) {
        return false;
      }
      if (filter.runtimeIds && filter.runtimeIds.length > 0 && !filter.runtimeIds.includes(mode.runtimeId)) {
        return false;
      }
      if (filter.adapterType && filter.adapterType.length > 0 && !filter.adapterType.includes(mode.adapterType)) {
        return false;
      }
      if (filter.kind && filter.kind.length > 0 && !filter.kind.includes(mode.kind)) {
        return false;
      }
      if (filter.availability && filter.availability.length > 0 && !filter.availability.includes(mode.availability.state)) {
        return false;
      }
      if (filter.placement && filter.placement.length > 0) {
        const matchesPlacement = filter.placement.some((placement) => {
          if (placement === "local") {
            return mode.placement.local.support === "supported" || mode.placement.local.support === "conditional";
          }
          if (placement === "hosted") {
            return mode.placement.hosted.support === "supported" || mode.placement.hosted.support === "conditional";
          }
          if (placement === "connected_local_node") {
            return (
              mode.placement.connectedLocalNode.support === "supported" ||
              mode.placement.connectedLocalNode.support === "conditional"
            );
          }
          return false;
        });
        if (!matchesPlacement) {
          return false;
        }
      }
      if (filter.capability && filter.capability.length > 0) {
        const set = new Set<string>(mode.capabilities);
        if (!filter.capability.every((capability) => set.has(capability))) {
          return false;
        }
      }
      if (filter.before && mode.id <= filter.before.id) {
        return false;
      }
      return true;
    });
    const page = filtered.slice(0, filter.limit);
    const hasMore = filtered.length > filter.limit;
    const last = page.at(-1);
    return { runtimeModes: page, nextCursor: hasMore && last ? { id: last.id } : null };
  }

  async updateRuntimeModeAvailability(idOrSlug: string, availability: RuntimeAvailability): Promise<RuntimeMode | undefined> {
    const mode = await this.getRuntimeMode(idOrSlug);
    if (!mode) {
      return undefined;
    }
    const updated: RuntimeMode = {
      ...mode,
      availability,
      status: availability.state,
      updatedAt: availability.checkedAt
    };
    await this.upsertRuntimeMode(updated);
    return updated;
  }
}
