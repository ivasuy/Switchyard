import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface ServiceManifest {
  deploymentMode: string;
  command: string[];
  requiredEnv: string[];
  healthChecks?: string[];
}

interface ProductionManifest {
  services: {
    server: ServiceManifest;
    worker: ServiceManifest;
    node?: ServiceManifest;
  };
  requiredEnv: string[];
  forbiddenSurfaces: string[];
}

function deployPath(file: string): string {
  return resolve(import.meta.dirname, file);
}

function parseManifestJson(text: string): ProductionManifest {
  return JSON.parse(text) as ProductionManifest;
}

describe("production manifest pack", () => {
  it("parses committed manifest json", () => {
    const manifestText = readFileSync(deployPath("manifest.json"), "utf8");
    const manifest = parseManifestJson(manifestText);
    expect(manifest).toBeTypeOf("object");
    expect(manifest.services.server.deploymentMode).toBe("production");
    expect(manifest.services.worker.deploymentMode).toBe("production");
  });

  it("surfaces SyntaxError for malformed manifest json helper", () => {
    expect(() => parseManifestJson("{"))
      .toThrowError(SyntaxError);
  });

  it("declares server and worker with fake-only runtime posture", () => {
    const manifestText = readFileSync(deployPath("manifest.json"), "utf8");
    const manifest = parseManifestJson(manifestText);

    expect(manifest.services.server).toBeDefined();
    expect(manifest.services.worker).toBeDefined();

    const serverEnv = new Set(manifest.services.server.requiredEnv);
    expect(serverEnv.has("SWITCHYARD_DEPLOYMENT_MODE")).toBe(true);
    expect(serverEnv.has("SWITCHYARD_SERVER_AUTH_MODE")).toBe(true);
    expect(serverEnv.has("SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST")).toBe(true);
    expect(serverEnv.has("SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION")).toBe(true);

    if (manifest.services.node) {
      expect(manifest.services.node.deploymentMode).toBe("production");
      expect(manifest.services.node.requiredEnv).toContain("SWITCHYARD_NODE_ALLOW_RUNTIME_MODES");
    }

    expect(manifest.requiredEnv).toContain("SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST");
    expect(manifest.forbiddenSurfaces.length).toBeGreaterThan(0);
  });

  it("uses built production commands only", () => {
    const compose = readFileSync(deployPath("docker-compose.yml"), "utf8");

    expect(compose).not.toMatch(/pnpm\s+install/i);
    expect(compose).not.toMatch(/\bdev\b/i);
    expect(compose).not.toContain("../..:/workspace");
    expect(compose).toMatch(/command:\s*\["node",\s*"apps\/server\/dist\/main\.js"\]/);
    expect(compose).toMatch(/node apps\/worker\/dist\/ready\.js/);
    expect(compose).toMatch(/node apps\/worker\/dist\/main\.js/);
  });

  it("contains health and readiness checks", () => {
    const compose = readFileSync(deployPath("docker-compose.yml"), "utf8");

    expect(compose).toContain("/health");
    expect(compose).toContain("/ready");
    expect(compose).toContain("node apps/worker/dist/ready.js");
  });

  it("uses invalid placeholders and required production defaults", () => {
    const envExample = readFileSync(deployPath(".env.example"), "utf8");
    const envLines = envExample
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    const envMap = new Map(
      envLines.map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
    );

    expect(envExample).toContain("SWITCHYARD_DEPLOYMENT_MODE=production");
    expect(envExample).toContain("SWITCHYARD_SERVER_AUTH_MODE=api_key");
    expect(envExample).toContain("SWITCHYARD_CONTROL_PLANE_STORE=postgres");
    expect(envExample).toContain("SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic");
    expect(envExample).toContain("SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled");
    expect(envExample).toContain("SWITCHYARD_OBJECT_STORE_PROBE=write_read_delete");
    expect(envExample).toContain("SWITCHYARD_PUBLIC_METRICS=0");

    const placeholderKeys = [
      "SWITCHYARD_API_KEY_PEPPER",
      "SWITCHYARD_NODE_SHARED_TOKEN",
      "SWITCHYARD_POSTGRES_PASSWORD",
      "SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID",
      "SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY"
    ];
    for (const key of placeholderKeys) {
      const value = envMap.get(key);
      expect(value).toBeDefined();
      expect(value).toMatch(/^replace-with-/);
      expect(value).not.toMatch(/^(switchyard|password|secret|test|example)$/i);
    }
  });

  it("excludes forbidden production surfaces", () => {
    const compose = readFileSync(deployPath("docker-compose.yml"), "utf8").toLowerCase();
    const manifest = parseManifestJson(readFileSync(deployPath("manifest.json"), "utf8"));

    const forbiddenTokens = [
      "dashboard",
      "tui",
      "payment",
      "stripe",
      "oauth",
      "oidc",
      "saml",
      "browser",
      "exec",
      "sandbox",
      "pty",
      "terminal",
      "codex.exec_json",
      "claude_code.sdk",
      "opencode.acp"
    ];

    for (const token of forbiddenTokens) {
      expect(compose.includes(token)).toBe(false);
    }

    const services = Object.keys(manifest.services).join(" ").toLowerCase();
    for (const token of ["dashboard", "tui", "payment", "oauth", "browser", "exec", "sandbox", "pty", "terminal"]) {
      expect(services.includes(token)).toBe(false);
    }
  });
});
