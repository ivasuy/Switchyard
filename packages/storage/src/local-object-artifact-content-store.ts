import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Artifact } from "@switchyard/contracts";
import type { ArtifactContentStore, StoredArtifactContent } from "@switchyard/core";
import { normalizeLogicalPath } from "./memory-artifact-content-store.js";

export class LocalObjectArtifactContentStore implements ArtifactContentStore {
  private readonly root: string;

  constructor(root: string, private readonly keyPrefix = "artifacts") {
    this.root = resolve(root);
  }

  async writeText(path: string, text: string, options?: { contentType?: string }): Promise<StoredArtifactContent> {
    return this.writeBytes(path, Buffer.from(text, "utf8"), {
      contentType: options?.contentType ?? "text/plain; charset=utf-8"
    });
  }

  async writeBytes(path: string, bytes: Buffer, options?: { contentType?: string }): Promise<StoredArtifactContent> {
    const safePath = normalizeLogicalPath(path);
    const objectKey = this.objectKeyFor(safePath);
    const target = join(this.root, objectKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return {
      path: safePath,
      storageBackend: "object",
      objectKey,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentType: options?.contentType ?? "application/octet-stream"
    };
  }

  async read(artifact: Artifact): Promise<{ body: Buffer; contentType: string }> {
    const safePath = normalizeLogicalPath(artifact.path);
    const objectKey = typeof artifact.metadata["objectKey"] === "string"
      ? artifact.metadata["objectKey"]
      : this.objectKeyFor(safePath);
    return {
      body: await readFile(join(this.root, objectKey)),
      contentType: typeof artifact.metadata["contentType"] === "string"
        ? artifact.metadata["contentType"]
        : "application/octet-stream"
    };
  }

  private objectKeyFor(path: string): string {
    return `${this.keyPrefix.replace(/\/+$/g, "")}/${path}`;
  }
}
