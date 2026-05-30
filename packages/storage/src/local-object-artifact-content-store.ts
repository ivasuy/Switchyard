import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    const target = this.absoluteObjectPath(objectKey);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    } catch (error) {
      throw mapWriteError(error);
    }
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
      ? normalizeLogicalPath(artifact.metadata["objectKey"])
      : this.objectKeyFor(safePath);
    let body: Buffer;
    try {
      body = await readFile(this.absoluteObjectPath(objectKey));
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        throw new Error("artifact_content_not_found");
      }
      throw mapReadError(error);
    }
    if (typeof artifact.metadata["sizeBytes"] === "number" && body.byteLength !== artifact.metadata["sizeBytes"]) {
      throw new Error(body.byteLength === 0 ? "artifact_content_empty" : "object_store_unavailable");
    }
    if (typeof artifact.metadata["sha256"] === "string") {
      const digest = createHash("sha256").update(body).digest("hex");
      if (artifact.metadata["sha256"] !== digest) {
        throw new Error("artifact_digest_mismatch");
      }
    }
    return {
      body,
      contentType: typeof artifact.metadata["contentType"] === "string"
        ? artifact.metadata["contentType"]
        : "application/octet-stream"
    };
  }

  async probe(): Promise<{ ok: true }> {
    const key = this.objectKeyFor(`probe/${randomUUID()}`);
    const target = this.absoluteObjectPath(key);
    try {
      await mkdir(dirname(target), { recursive: true });
      const body = Buffer.from("probe");
      await writeFile(target, body);
      const read = await readFile(target);
      if (createHash("sha256").update(read).digest("hex") !== createHash("sha256").update(body).digest("hex")) {
        throw new Error("artifact_digest_mismatch");
      }
      await rm(target, { force: true });
    } catch (error) {
      if (error instanceof Error && error.message === "artifact_digest_mismatch") {
        throw error;
      }
      throw new Error("object_store_unavailable");
    }
    return { ok: true };
  }

  private objectKeyFor(path: string): string {
    return `${this.keyPrefix.replace(/\/+$/g, "")}/${path}`;
  }

  private absoluteObjectPath(objectKey: string): string {
    const safeKey = normalizeLogicalPath(objectKey);
    const absolute = join(this.root, safeKey);
    const resolved = resolve(absolute);
    if (!resolved.startsWith(this.root)) {
      throw new Error("invalid_input");
    }
    return resolved;
  }
}

function mapWriteError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM" || code === "ENOENT" || code === "ENOTDIR") {
    return new Error("object_store_write_failed");
  }
  return new Error("object_store_write_failed");
}

function mapReadError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM" || code === "ENOTDIR") {
    return new Error("object_store_unavailable");
  }
  return new Error("object_store_unavailable");
}
