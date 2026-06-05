import type { Artifact } from "@switchyard/contracts";

export interface StoredArtifactContent {
  path: string;
  storageBackend: "filesystem" | "memory" | "object";
  objectKey?: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
}

export interface ArtifactContentStore {
  writeText(path: string, text: string, options?: { contentType?: string }): Promise<StoredArtifactContent>;
  writeBytes(path: string, bytes: Buffer, options?: { contentType?: string }): Promise<StoredArtifactContent>;
  read(artifact: Artifact): Promise<{ body: Buffer; contentType: string }>;
}
