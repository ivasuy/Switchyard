import type { Approval, EvidenceItem, MemoryItem, RoutedMessage, ToolInvocation } from "@switchyard/contracts";
import type {
  ApprovalStore,
  EvidenceStore,
  ListApprovalsFilter,
  ListApprovalsResult,
  ListEvidenceFilter,
  ListEvidenceResult,
  ListMemoryFilter,
  ListMemoryResult,
  ListMessagesFilter,
  ListMessagesResult,
  ListToolInvocationsFilter,
  ListToolInvocationsResult,
  MemoryStore,
  MessageStore,
  ToolInvocationStore
} from "@switchyard/core";

function sortNewest<T extends { createdAt: string; id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return right.id.localeCompare(left.id);
    }
    return left.createdAt > right.createdAt ? -1 : 1;
  });
}

function afterCursor<T extends { createdAt: string; id: string }>(items: T[], before?: { createdAt: string; id: string }): T[] {
  if (!before) {
    return items;
  }
  return items.filter((item) => item.createdAt < before.createdAt || (item.createdAt === before.createdAt && item.id < before.id));
}

function paginate<T extends { createdAt: string; id: string }>(items: T[], limit: number): { page: T[]; nextCursor: { createdAt: string; id: string } | null } {
  const overFetch = items.slice(0, limit + 1);
  const page = overFetch.slice(0, limit);
  const hasMore = overFetch.length > limit;
  const last = page.at(-1);
  return {
    page,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null
  };
}

export class InMemoryMessageStore implements MessageStore {
  readonly items = new Map<string, RoutedMessage>();

  async create(value: RoutedMessage): Promise<RoutedMessage> {
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<RoutedMessage | undefined> {
    return this.items.get(id);
  }

  async update(value: RoutedMessage): Promise<RoutedMessage> {
    this.items.set(value.id, value);
    return value;
  }

  async list(filter: ListMessagesFilter): Promise<ListMessagesResult> {
    let items = sortNewest([...this.items.values()]);
    items = items.filter((item) => {
      if (filter.runId && item.fromRunId !== filter.runId && item.toRunId !== filter.runId) return false;
      if (filter.channel && item.channel !== filter.channel) return false;
      if (filter.deliveryStatus && item.deliveryStatus !== filter.deliveryStatus) return false;
      return true;
    });
    items = afterCursor(items, filter.before);
    const { page, nextCursor } = paginate(items, filter.limit);
    return { messages: page, nextCursor };
  }
}

export class InMemoryMemoryStore implements MemoryStore {
  readonly items = new Map<string, MemoryItem>();

  async create(value: MemoryItem): Promise<MemoryItem> {
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    return this.items.get(id);
  }

  async update(value: MemoryItem): Promise<MemoryItem> {
    this.items.set(value.id, value);
    return value;
  }

  async list(filter: ListMemoryFilter): Promise<ListMemoryResult> {
    let items = sortNewest([...this.items.values()]);
    items = items.filter((item) => {
      if (filter.scope && item.scope !== filter.scope) return false;
      if (filter.projectId && item.projectId !== filter.projectId) return false;
      if (filter.runId && item.runId !== filter.runId) return false;
      if (filter.debateId && item.debateId !== filter.debateId) return false;
      if (filter.provider && item.provider !== filter.provider) return false;
      if (filter.model && item.model !== filter.model) return false;
      return true;
    });
    items = afterCursor(items, filter.before);
    const { page, nextCursor } = paginate(items, filter.limit);
    return { memory: page, nextCursor };
  }

  async search(filter: ListMemoryFilter & { q: string }): Promise<ListMemoryResult> {
    const q = filter.q.toLowerCase();
    const listed = await this.list(filter);
    return {
      memory: listed.memory.filter((item) => item.content.toLowerCase().includes(q)),
      nextCursor: listed.nextCursor
    };
  }
}

export class InMemoryEvidenceStore implements EvidenceStore {
  readonly items = new Map<string, EvidenceItem>();

  async create(value: EvidenceItem): Promise<EvidenceItem> {
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<EvidenceItem | undefined> {
    return this.items.get(id);
  }

  async update(value: EvidenceItem): Promise<EvidenceItem> {
    this.items.set(value.id, value);
    return value;
  }

  async list(filter: ListEvidenceFilter): Promise<ListEvidenceResult> {
    const q = filter.q?.toLowerCase();
    let items = sortNewest([...this.items.values()]);
    items = items.filter((item) => {
      if (filter.debateId && item.debateId !== filter.debateId) return false;
      if (filter.sourceType && item.sourceType !== filter.sourceType) return false;
      if (filter.reliability && item.reliability !== filter.reliability) return false;
      if (q) {
        const snippet = item.snippet?.toLowerCase() ?? "";
        const title = item.title.toLowerCase();
        if (!title.includes(q) && !snippet.includes(q)) return false;
      }
      return true;
    });
    items = afterCursor(items, filter.before);
    const { page, nextCursor } = paginate(items, filter.limit);
    return { evidence: page, nextCursor };
  }
}

export class InMemoryApprovalStore implements ApprovalStore {
  readonly items = new Map<string, Approval>();

  async create(value: Approval): Promise<Approval> {
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<Approval | undefined> {
    return this.items.get(id);
  }

  async update(value: Approval): Promise<Approval> {
    this.items.set(value.id, value);
    return value;
  }

  async list(filter: ListApprovalsFilter): Promise<ListApprovalsResult> {
    let items = sortNewest([...this.items.values()]);
    items = items.filter((item) => {
      if (filter.runId && item.runId !== filter.runId) return false;
      if (filter.status && item.status !== filter.status) return false;
      if (filter.approvalType && item.approvalType !== filter.approvalType) return false;
      return true;
    });
    items = afterCursor(items, filter.before);
    const { page, nextCursor } = paginate(items, filter.limit);
    return { approvals: page, nextCursor };
  }
}

export class InMemoryToolInvocationStore implements ToolInvocationStore {
  readonly items = new Map<string, ToolInvocation>();

  async create(value: ToolInvocation): Promise<ToolInvocation> {
    this.items.set(value.id, value);
    return value;
  }

  async get(id: string): Promise<ToolInvocation | undefined> {
    return this.items.get(id);
  }

  async update(value: ToolInvocation): Promise<ToolInvocation> {
    this.items.set(value.id, value);
    return value;
  }

  async list(filter: ListToolInvocationsFilter): Promise<ListToolInvocationsResult> {
    let items = sortNewest([...this.items.values()]);
    items = items.filter((item) => {
      if (filter.runId && item.runId !== filter.runId) return false;
      if (filter.type && item.type !== filter.type) return false;
      if (filter.status && item.status !== filter.status) return false;
      if (filter.approvalId && item.approvalId !== filter.approvalId) return false;
      return true;
    });
    items = afterCursor(items, filter.before);
    const { page, nextCursor } = paginate(items, filter.limit);
    return { invocations: page, nextCursor };
  }

  async listByApproval(approvalId: string): Promise<ToolInvocation[]> {
    return sortNewest([...this.items.values()].filter((item) => item.approvalId === approvalId));
  }
}
