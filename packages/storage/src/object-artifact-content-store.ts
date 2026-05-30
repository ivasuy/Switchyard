import { createHash, randomUUID } from "node:crypto";
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
  deleteObject?(input: { bucket: string; key: string }): Promise<void>;
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
    try {
      await this.client.putObject({
        bucket: this.config.bucket,
        key: objectKey,
        body: bytes,
        contentType
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("object_store_")) {
        throw error;
      }
      throw new Error("object_store_write_failed");
    }
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
    const metadata = artifact.metadata as Record<string, unknown>;
    const objectKey = typeof metadata["objectKey"] === "string"
      ? normalizeLogicalPath(metadata["objectKey"])
      : this.objectKeyFor(safePath);
    let out: { body: Buffer; contentType?: string };
    try {
      out = await this.client.getObject({ bucket: this.config.bucket, key: objectKey });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "ENOENT" || message.includes("not found") || message === "artifact_content_not_found") {
        throw new Error("artifact_content_not_found");
      }
      if (message.startsWith("object_store_")) {
        throw error;
      }
      throw new Error("object_store_read_failed");
    }

    if (typeof metadata["sizeBytes"] === "number" && out.body.byteLength !== metadata["sizeBytes"]) {
      if (metadata["sizeBytes"] > 0 && out.body.byteLength === 0) {
        throw new Error("artifact_content_empty");
      }
      throw new Error("object_store_read_failed");
    }
    if (typeof metadata["sha256"] === "string") {
      const digest = createHash("sha256").update(out.body).digest("hex");
      if (digest !== metadata["sha256"]) {
        throw new Error("artifact_digest_mismatch");
      }
    }

    return {
      body: out.body,
      contentType: typeof metadata["contentType"] === "string"
        ? metadata["contentType"]
        : out.contentType ?? "application/octet-stream"
    };
  }

  async probe(): Promise<{ ok: true }> {
    const key = this.objectKeyFor(`probes/${randomUUID()}`);
    const body = Buffer.from("probe");
    let readVerified = false;
    try {
      await this.client.putObject({
        bucket: this.config.bucket,
        key,
        body,
        contentType: "text/plain; charset=utf-8"
      });
      const read = await this.client.getObject({ bucket: this.config.bucket, key });
      const expected = createHash("sha256").update(body).digest("hex");
      const actual = createHash("sha256").update(read.body).digest("hex");
      if (actual !== expected) {
        throw new Error("artifact_digest_mismatch");
      }
      readVerified = true;
      await this.client.deleteObject?.({ bucket: this.config.bucket, key });
    } catch (error) {
      if (readVerified && this.isCleanupFailure(error)) {
        throw new Error("object_store_probe_cleanup_failed");
      }
      if (error instanceof Error && (
        error.message === "artifact_digest_mismatch" ||
        error.message.startsWith("object_store_") ||
        error.message === "artifact_content_not_found"
      )) {
        throw error;
      }
      throw new Error("object_store_unavailable");
    }
    return { ok: true };
  }

  private objectKeyFor(path: string): string {
    const normalizedPrefix = this.config.keyPrefix?.replace(/^\/+|\/+$/g, "") ?? "";
    const prefix = normalizedPrefix.length > 0 ? `${normalizedPrefix}/` : "";
    return `${prefix}${path}`;
  }

  private isCleanupFailure(error: unknown): boolean {
    if (!this.client.deleteObject) {
      return false;
    }
    return error instanceof Error && (
      error.message === "object_store_delete_failed" ||
      error.message === "object_store_timeout" ||
      error.message === "object_store_unavailable" ||
      error.message === "object_store_auth_failed" ||
      error.message === "object_store_bucket_not_found"
    );
  }
}
