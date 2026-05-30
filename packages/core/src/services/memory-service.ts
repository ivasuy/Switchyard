import type { MemoryItem } from "@switchyard/contracts";
import type { ListMemoryFilter, ListMemoryResult, MemoryStore, SearchMemoryFilter } from "../ports/memory-store.js";
import type { RuntimeLogger } from "../ports/runtime-logger.js";

class ServiceError extends Error {
  readonly code: string;
  readonly details?: Array<{ path: string; issue: string }>;

  constructor(code: string, message: string, details?: Array<{ path: string; issue: string }>) {
    super(message);
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface CreateMemoryInput {
  scope: MemoryItem["scope"];
  projectId?: string | undefined;
  runId?: string | undefined;
  debateId?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  content: string;
  metadata?: Record<string, unknown> | undefined;
  embedding?: number[] | undefined;
}

export interface MemoryServiceDependencies {
  memory: MemoryStore;
  logger?: RuntimeLogger;
}

export class MemoryService {
  constructor(private readonly deps: MemoryServiceDependencies) {}

  async create(input: CreateMemoryInput): Promise<MemoryItem> {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new ServiceError("invalid_input", "content is required", [{ path: "content", issue: "must be a non-empty string" }]);
    }

    const memory: MemoryItem = {
      id: `memory_${crypto.randomUUID()}`,
      scope: input.scope,
      content,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString()
    };
    if (input.projectId) memory.projectId = input.projectId;
    if (input.runId) memory.runId = input.runId;
    if (input.debateId) memory.debateId = input.debateId;
    if (input.provider) memory.provider = input.provider;
    if (input.model) memory.model = input.model;
    if (input.embedding) memory.embedding = input.embedding;

    try {
      return await this.deps.memory.create(memory);
    } catch (error) {
      this.deps.logger?.error("memory.persistence_failed", {
        memoryId: memory.id,
        reason: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    return this.deps.memory.get(id);
  }

  async list(filter: ListMemoryFilter): Promise<ListMemoryResult> {
    return this.deps.memory.list(filter);
  }

  async search(filter: SearchMemoryFilter): Promise<ListMemoryResult> {
    const q = filter.q.trim();
    if (q.length === 0) {
      throw new ServiceError("invalid_query", "q is required", [{ path: "q", issue: "must be a non-empty string" }]);
    }
    return this.deps.memory.search({ ...filter, q });
  }
}

export { ServiceError as MemoryServiceError };
