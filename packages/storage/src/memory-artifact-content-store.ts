import { createHash } from "node:crypto";
import type { Artifact } from "@switchyard/contracts";
import type { ArtifactContentStore, StoredArtifactContent } from "@switchyard/core";

interface StoredItem {
  bytes: Buffer;
  contentType: string;
}

export class MemoryArtifactContentStore implements ArtifactContentStore {
  private readonly content = new Map<string, StoredItem>();

  async writeText(path: string, text: string, options?: { contentType?: string }): Promise<StoredArtifactContent> {
    const bytes = Buffer.from(text, "utf8");
    return this.writeBytes(path, bytes, { contentType: options?.contentType ?? "text/plain; charset=utf-8" });
  }

  async writeBytes(path: string, bytes: Buffer, options?: { contentType?: string }): Promise<StoredArtifactContent> {
    const safePath = normalizeLogicalPath(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const contentType = options?.contentType ?? "application/octet-stream";
    this.content.set(safePath, { bytes, contentType });
    return {
      path: safePath,
      storageBackend: "memory",
      sizeBytes: bytes.byteLength,
      sha256,
      contentType
    };
  }

  async read(artifact: Artifact): Promise<{ body: Buffer; contentType: string }> {
    const safePath = normalizeLogicalPath(artifact.path);
    const item = this.content.get(safePath);
    if (!item) {
      const error = new Error(`Artifact content not found for ${safePath}`);
      (error as Error & { code?: string }).code = "ENOENT";
      throw error;
    }
    return { body: item.bytes, contentType: item.contentType };
  }
}

export function normalizeLogicalPath(path: string): string {
  if (!path || path.trim().length === 0) {
    throw new Error("Artifact path is required");
  }
  if (path.startsWith("/") || path.includes("..") || path.includes("\\") || /^[A-Za-z]:/.test(path)) {
    throw new Error("Artifact path escapes root");
  }
  return path;
}
