import type { ContextPacket, EvidenceItem, MemoryItem, RoutedMessage } from "@switchyard/contracts";
import type { EvidenceStore } from "../ports/evidence-store.js";
import type { MemoryStore } from "../ports/memory-store.js";
import type { MessageStore } from "../ports/message-store.js";
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

export interface BuildContextInput {
  target: "run" | "debate" | "participant" | "tool";
  sections?: Array<{ name: string; content: string }>;
  memoryIds?: string[];
  evidenceIds?: string[];
  messageIds?: string[];
}

export interface BuildContextResult {
  context: ContextPacket;
  rendered: string;
}

export interface ContextBuilderDependencies {
  memory: MemoryStore;
  evidence: EvidenceStore;
  messages: MessageStore;
  logger?: RuntimeLogger;
}

export class ContextBuilder {
  constructor(private readonly deps: ContextBuilderDependencies) {}

  async build(input: BuildContextInput): Promise<BuildContextResult> {
    type ContextSection = ContextPacket["sections"][number];
    const sections: ContextSection[] = [];
    const explicitSections = (input.sections ?? []).map((section) => ({
      name: section.name,
      content: section.content,
      memoryIds: [],
      evidenceIds: []
    }));

    const memoryIds = input.memoryIds ?? [];
    const evidenceIds = input.evidenceIds ?? [];
    const messageIds = input.messageIds ?? [];

    try {
      for (const section of explicitSections) {
        sections.push(section);
      }

      if (memoryIds.length > 0) {
        const memories = await this.loadMemory(memoryIds);
        sections.push({
          name: "memory",
          content: memories.map((memory) => memory.content).join("\n"),
          memoryIds,
          evidenceIds: []
        });
      }

      if (evidenceIds.length > 0) {
        const evidence = await this.loadEvidence(evidenceIds);
        sections.push({
          name: "evidence",
          content: evidence.map((item) => formatEvidence(item)).join("\n"),
          memoryIds: [],
          evidenceIds
        });
      }

      if (messageIds.length > 0) {
        const messages = await this.loadMessages(messageIds);
        sections.push({
          name: "messages",
          content: messages.map((message) => formatMessage(message)).join("\n"),
          memoryIds: [],
          evidenceIds: []
        });
      }
    } catch (error) {
      this.deps.logger?.warn("context.build_failed", {
        reason: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    const context: ContextPacket = {
      id: `context_${crypto.randomUUID()}`,
      target: input.target,
      sections,
      createdAt: new Date().toISOString()
    };

    return {
      context,
      rendered: renderSections(sections)
    };
  }

  private async loadMemory(ids: string[]): Promise<MemoryItem[]> {
    const out: MemoryItem[] = [];
    for (const id of ids) {
      const item = await this.deps.memory.get(id);
      if (!item) {
        throw new ServiceError("memory_not_found", `Memory not found: ${id}`);
      }
      out.push(item);
    }
    return out;
  }

  private async loadEvidence(ids: string[]): Promise<EvidenceItem[]> {
    const out: EvidenceItem[] = [];
    for (const id of ids) {
      const item = await this.deps.evidence.get(id);
      if (!item) {
        throw new ServiceError("evidence_not_found", `Evidence not found: ${id}`);
      }
      out.push(item);
    }
    return out;
  }

  private async loadMessages(ids: string[]): Promise<RoutedMessage[]> {
    const out: RoutedMessage[] = [];
    for (const id of ids) {
      const item = await this.deps.messages.get(id);
      if (!item) {
        throw new ServiceError("message_not_found", `Message not found: ${id}`);
      }
      out.push(item);
    }
    return out;
  }
}

function formatEvidence(item: EvidenceItem): string {
  return item.snippet ? `${item.title}: ${item.snippet}` : item.title;
}

function formatMessage(item: RoutedMessage): string {
  const from = item.fromRunId ?? "-";
  const to = item.toRunId ?? "-";
  const channel = item.channel ?? "-";
  return `[from=${from} to=${to} channel=${channel}] ${item.content}`;
}

function renderSections(sections: ContextPacket["sections"]): string {
  if (sections.length === 0) {
    return "";
  }
  return sections
    .map((section) => `## ${section.name}\n${section.content}`)
    .join("\n\n");
}

export { ServiceError as ContextBuilderError };
