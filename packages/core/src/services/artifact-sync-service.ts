import { createHash } from "node:crypto";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { ArtifactContentStore } from "../ports/artifact-content-store.js";
import type { NodeAssignmentStore } from "../ports/node-assignment-store.js";
import type { Artifact } from "@switchyard/contracts";
import type { LocalNodePolicyService } from "./local-node-policy-service.js";
import type { AssignmentArtifactManifestRequest } from "@switchyard/contracts";

export class ArtifactSyncError extends Error {
  readonly code: "assignment_not_found" | "invalid_input" | "artifact_digest_mismatch" | "artifact_sync_failed";

  constructor(code: ArtifactSyncError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

interface PendingArtifactManifest {
  artifact: Artifact;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  syncContent: boolean;
}

export interface ArtifactSyncServiceDependencies {
  assignments: NodeAssignmentStore;
  artifacts: ArtifactStore;
  content: ArtifactContentStore;
  policy?: LocalNodePolicyService;
}

export class ArtifactSyncService {
  private readonly manifests = new Map<string, PendingArtifactManifest>();

  constructor(private readonly deps: ArtifactSyncServiceDependencies) {}

  async acceptManifest(nodeId: string, assignmentId: string, input: AssignmentArtifactManifestRequest): Promise<{ accepted: true; artifacts: Array<{ id: string; accepted: true; contentStored: boolean }> }> {
    const assignment = await this.deps.assignments.get(assignmentId);
    if (!assignment || assignment.nodeId !== nodeId) {
      throw new ArtifactSyncError("assignment_not_found", `Assignment not found: ${assignmentId}`);
    }

    const accepted: Array<{ id: string; accepted: true; contentStored: boolean }> = [];

    for (const entry of input.artifacts) {
      assertSafePath(entry.path);
      const artifact: Artifact = {
        id: entry.id,
        runId: assignment.runId,
        type: entry.type,
        path: entry.path,
        metadata: {
          contentStored: false,
          contentType: entry.contentType,
          sizeBytes: entry.sizeBytes,
          sha256: entry.sha256
        },
        createdAt: new Date().toISOString()
      };
      await this.deps.artifacts.create(artifact);
      this.manifests.set(key(assignmentId, entry.id), {
        artifact,
        contentType: entry.contentType,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        syncContent: entry.syncContent
      });
      accepted.push({ id: entry.id, accepted: true, contentStored: false });
    }

    return { accepted: true, artifacts: accepted };
  }

  async acceptContent(nodeId: string, assignmentId: string, artifactId: string, bytes: Buffer): Promise<{ accepted: true; artifactId: string }> {
    const assignment = await this.deps.assignments.get(assignmentId);
    if (!assignment || assignment.nodeId !== nodeId) {
      throw new ArtifactSyncError("assignment_not_found", `Assignment not found: ${assignmentId}`);
    }

    const manifest = this.manifests.get(key(assignmentId, artifactId));
    if (!manifest) {
      throw new ArtifactSyncError("invalid_input", `Manifest not found for artifact: ${artifactId}`);
    }

    if (!manifest.syncContent) {
      throw new ArtifactSyncError("invalid_input", `Artifact does not allow content sync: ${artifactId}`);
    }

    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== manifest.sha256 || bytes.byteLength !== manifest.sizeBytes) {
      await this.deps.assignments.fail(assignmentId, new Date().toISOString(), "artifact_digest_mismatch");
      throw new ArtifactSyncError("artifact_digest_mismatch", `Digest mismatch for artifact: ${artifactId}`);
    }

    try {
      const stored = await this.deps.content.writeBytes(manifest.artifact.path, bytes, {
        contentType: manifest.contentType
      });
      await this.deps.artifacts.update({
        ...manifest.artifact,
        metadata: {
          ...manifest.artifact.metadata,
          contentStored: true,
          storageBackend: stored.storageBackend,
          objectKey: stored.objectKey,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          contentType: stored.contentType
        }
      });
      return { accepted: true, artifactId };
    } catch (error) {
      await this.deps.assignments.fail(assignmentId, new Date().toISOString(), "artifact_sync_failed");
      throw new ArtifactSyncError("artifact_sync_failed", (error as Error).message);
    }
  }
}

function key(assignmentId: string, artifactId: string): string {
  return `${assignmentId}:${artifactId}`;
}

function assertSafePath(path: string): void {
  if (!path || path.includes("..") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new ArtifactSyncError("invalid_input", "Artifact path escapes root");
  }
}
