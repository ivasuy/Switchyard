import { createHash } from "node:crypto";
import type { Artifact } from "@switchyard/contracts";
import type { ArtifactContentStore, StoredArtifactContent } from "@switchyard/core";
import { normalizeLogicalPath } from "./memory-artifact-content-store.js";

export interface ObjectArtifactContentStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  keyPrefix?: string;
}

interface ObjectClient {
  putObject(input: { bucket: string; key: string; body: Buffer; contentType: string }): Promise<void>;
  getObject(input: { bucket: string; key: string }): Promise<{ body: Buffer; contentType?: string }>;
}

export class ObjectArtifactContentStore implements ArtifactContentStore {
  constructor(
    private readonly config: ObjectArtifactContentStoreConfig,
    private readonly client: ObjectClient
  ) {}

  async writeText(path: string, text: string, options?: { contentType?: string }): Promise<StoredArtifactContent> {
    const bytes = Buffer.from(text, "utf8");
    return this.writeBytes(path, bytes, { contentType: options?.contentType ?? "text/plain; charset=utf-8" });
  }

  async writeBytes(path: string, bytes: Buffer, options?: { contentType?: string }): Promise<StoredArtifactContent> {
    const safePath = normalizeLogicalPath(path);
    const contentType = options?.contentType ?? "application/octet-stream";
    const objectKey = this.objectKeyFor(safePath);
    await this.client.putObject({
      bucket: this.config.bucket,
      key: objectKey,
      body: bytes,
      contentType
    });
    return {
      path: safePath,
      storageBackend: "object",
      objectKey,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentType
    };
  }

  async read(artifact: Artifact): Promise<{ body: Buffer; contentType: string }> {
    const safePath = normalizeLogicalPath(artifact.path);
    const objectKey = this.objectKeyFor(safePath);
    const out = await this.client.getObject({ bucket: this.config.bucket, key: objectKey });
    return {
      body: out.body,
      contentType: out.contentType ?? "application/octet-stream"
    };
  }

  private objectKeyFor(path: string): string {
    const prefix = this.config.keyPrefix ? `${this.config.keyPrefix.replace(/\/+$/g, "")}/` : "";
    return `${prefix}${path}`;
  }
}
