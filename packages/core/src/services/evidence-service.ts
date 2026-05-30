import type { EvidenceItem } from "@switchyard/contracts";
import type { EvidenceStore, ListEvidenceFilter, ListEvidenceResult } from "../ports/evidence-store.js";
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

function hasWindowsPathPrefix(path: string): boolean {
  return /^[a-zA-Z]:\\/.test(path);
}

function isUnsafeRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\") || hasWindowsPathPrefix(path)) {
    return true;
  }
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return segments.includes("..");
}

export interface CreateEvidenceInput {
  debateId?: string | undefined;
  sourceType: EvidenceItem["sourceType"];
  url?: string | undefined;
  title: string;
  snippet?: string | undefined;
  fetchedContentPath?: string | undefined;
  reliability: EvidenceItem["reliability"];
}

export interface EvidenceServiceDependencies {
  evidence: EvidenceStore;
  logger?: RuntimeLogger;
}

export class EvidenceService {
  constructor(private readonly deps: EvidenceServiceDependencies) {}

  async create(input: CreateEvidenceInput): Promise<EvidenceItem> {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new ServiceError("invalid_input", "title is required", [{ path: "title", issue: "must be a non-empty string" }]);
    }

    if (input.url !== undefined) {
      try {
        // Validate URL shape only; R7 never fetches remote evidence content.
        new URL(input.url);
      } catch {
        throw new ServiceError("invalid_input", "url must be a valid URL", [{ path: "url", issue: "must be a valid URL" }]);
      }
    }

    if (["url", "search_result", "browser_capture"].includes(input.sourceType) && !input.url) {
      throw new ServiceError("invalid_input", "url is required for this sourceType", [{ path: "url", issue: "required for sourceType" }]);
    }

    if (input.fetchedContentPath && isUnsafeRelativePath(input.fetchedContentPath)) {
      throw new ServiceError("invalid_input", "fetchedContentPath must be a safe relative path", [
        { path: "fetchedContentPath", issue: "must be a safe relative path without parent traversal" }
      ]);
    }

    const evidence: EvidenceItem = {
      id: `evidence_${crypto.randomUUID()}`,
      sourceType: input.sourceType,
      title,
      reliability: input.reliability,
      createdAt: new Date().toISOString()
    };
    if (input.debateId) evidence.debateId = input.debateId;
    if (input.url) evidence.url = input.url;
    if (input.snippet !== undefined) evidence.snippet = input.snippet;
    if (input.fetchedContentPath) evidence.fetchedContentPath = input.fetchedContentPath;

    try {
      return await this.deps.evidence.create(evidence);
    } catch (error) {
      this.deps.logger?.error("evidence.persistence_failed", {
        evidenceId: evidence.id,
        reason: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async get(id: string): Promise<EvidenceItem | undefined> {
    return this.deps.evidence.get(id);
  }

  async list(filter: ListEvidenceFilter): Promise<ListEvidenceResult> {
    return this.deps.evidence.list(filter);
  }
}

export { ServiceError as EvidenceServiceError };
