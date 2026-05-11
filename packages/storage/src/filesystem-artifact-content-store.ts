import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class FilesystemArtifactContentStore {
  private readonly normalizedRoot: string;

  constructor(root: string) {
    this.normalizedRoot = resolve(root);
  }

  async writeText(logicalPath: string, content: string): Promise<string> {
    const safePath = this.safePath(logicalPath);

    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, "utf8");

    return relative(this.normalizedRoot, safePath).replaceAll("\\", "/");
  }

  private safePath(logicalPath: string): string {
    if (isAbsolute(logicalPath) || logicalPath.includes("\\")) {
      throw new Error("Artifact path escapes root");
    }

    const target = resolve(this.normalizedRoot, logicalPath);
    const rel = relative(this.normalizedRoot, target);
    const segments = rel.split(sep);

    if (rel === "" || rel === "." || segments.includes("..")) {
      throw new Error("Artifact path escapes root");
    }

    return target;
  }
}
