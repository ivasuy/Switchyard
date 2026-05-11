import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemArtifactContentStore } from "../src/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }

  dirs.length = 0;
});

describe("FilesystemArtifactContentStore", () => {
  it("writes content under the artifact root and rejects path traversal", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchyard-artifact-content-store-"));
    dirs.push(root);

    const store = new FilesystemArtifactContentStore(root);
    const logicalPath = "runs/run_1/transcript.jsonl";
    const content = "{\"ok\":true}\n";

    const path = await store.writeText(logicalPath, content);

    expect(path).toBe(logicalPath);
    expect(readFileSync(join(root, path), "utf8")).toBe(content);
    await expect(store.writeText("../escape.txt", "bad")).rejects.toThrow("Artifact path escapes root");
  });

  it("accepts safe dotted filenames", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchyard-artifact-content-store-"));
    dirs.push(root);

    const store = new FilesystemArtifactContentStore(root);
    const logicalPath = "runs/a..b.txt";
    const content = "dotdots\n";

    const path = await store.writeText(logicalPath, content);

    expect(path).toBe(logicalPath);
    expect(readFileSync(join(root, path), "utf8")).toBe(content);
  });

  it("rejects parent traversal paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchyard-artifact-content-store-"));
    dirs.push(root);

    const store = new FilesystemArtifactContentStore(root);

    await expect(store.writeText("../escape.txt", "bad")).rejects.toThrow("Artifact path escapes root");
    await expect(store.writeText("runs/../../escape.txt", "bad")).rejects.toThrow("Artifact path escapes root");
  });

  it("rejects absolute paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchyard-artifact-content-store-"));
    dirs.push(root);

    const store = new FilesystemArtifactContentStore(root);

    await expect(store.writeText("/tmp/escape.txt", "bad")).rejects.toThrow("Artifact path escapes root");
  });

  it("returns the exact written path", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchyard-artifact-content-store-"));
    dirs.push(root);

    const store = new FilesystemArtifactContentStore(root);
    const logicalPath = "runs/run_1/transcript.jsonl";
    const content = "{\"exact\":true}\n";

    const path = await store.writeText(logicalPath, content);

    expect(readFileSync(join(root, path), "utf8")).toBe(content);
    expect(path).toBe("runs/run_1/transcript.jsonl");
  });
});
