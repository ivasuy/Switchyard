import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";

export class FilesystemArtifactContentStore {
  constructor(private readonly root: string) {}

  async writeText(logicalPath: string, content: string): Promise<string> {
    const safePath = this.safePath(logicalPath);

    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, "utf8");

    return normalize(logicalPath).replaceAll("\\", "/");
  }

  private safePath(logicalPath: string): string {
    const target = join(this.root, logicalPath);
    const rel = relative(this.root, target);

    if (rel === "" || rel.startsWith("..") || rel.includes("..")) {
      throw new Error("Artifact path escapes root");
    }

    return target;
  }
}
