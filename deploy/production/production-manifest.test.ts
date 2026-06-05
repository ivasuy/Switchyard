import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface ServiceManifest {
  deploymentMode: string;
  command: string[];
  requiredEnv: string[];
  healthChecks?: string[];
  readinessChecks?: string[];
  policy?: {
    hostedRealRuntimeExecution?: string;
  };
}

interface ProductionManifest {
  tools: {
    hostedRealTools: "disabled" | "enabled";
    connectedNodeRealTools: "disabled" | "enabled";
    policy: "required_when_enabled";
    approvalDefault: "required";
    adapterMode: "fake_for_smoke" | "real_explicit";
  };
  canary?: {
    defaultMode: string;
    allowedPaths: string[];
    liveProviderSpend: string;
  };
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

function serviceBlock(composeText: string, serviceName: string): string {
  const match = composeText.match(new RegExp(`\\n  ${serviceName}:\\n([\\s\\S]*?)(?=\\n  \\S|\\nvolumes:|$)`));
  if (!match) {
    throw new Error(`missing compose service: ${serviceName}`);
  }
  return match[1];
}

function expectCurrentBuiltEntrypoint(command: string[]): void {
  expect(command[0]).toBe("node");
  const distEntrypoint = command[1];
  expect(distEntrypoint).toMatch(/^apps\/[^/]+\/dist\/main\.js$/);
  const sourceEntrypoint = distEntrypoint.replace("/dist/main.js", "/src/main.ts");
  expect(existsSync(resolve(import.meta.dirname, "../..", sourceEntrypoint))).toBe(true);
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
    expect(manifest.tools).toEqual({
      hostedRealTools: "disabled",
      connectedNodeRealTools: "disabled",
      policy: "required_when_enabled",
      approvalDefault: "required",
      adapterMode: "fake_for_smoke"
    });
    expect(manifest.forbiddenSurfaces).toEqual(expect.arrayContaining([
      "/browser",
      "/search",
      "/github",
      "/fetch",
      "/repo",
      "/runtime-bridge",
      "/session",
      "/input",
      "/approval",
      "/dashboard",
      "/tui"
    ]));
  });

  it("declares hosted debate no-spend canary routes only through public debate APIs", () => {
    const manifest = parseManifestJson(readFileSync(deployPath("manifest.json"), "utf8"));

    expect(manifest.canary).toMatchObject({
      defaultMode: "hosted_debate_fake_no_spend",
      liveProviderSpend: "requires --confirm-live-provider-spend"
    });
    expect(manifest.canary?.allowedPaths).toEqual(expect.arrayContaining([
      "POST /debates",
      "GET /debates/:id",
      "GET /debates/:id/events"
    ]));
    expect(manifest.canary?.allowedPaths.join("\n")).not.toMatch(/\/runs|\/debates\/participants\/real|\/debates\/judge|\/model-judge/);
  });

  it("uses built production commands only", () => {
    const compose = readFileSync(deployPath("docker-compose.yml"), "utf8");
    const manifest = parseManifestJson(readFileSync(deployPath("manifest.json"), "utf8"));

    expect(compose).not.toMatch(/pnpm\s+install/i);
    expect(compose).not.toMatch(/\bdev\b/i);
    expect(compose).not.toContain("../..:/workspace");
    expect(compose).toMatch(/command:\s*\["node",\s*"apps\/server\/dist\/main\.js"\]/);
    expect(compose).toMatch(/command:\s*\["node",\s*"apps\/worker\/dist\/main\.js"\]/);
    expect(compose).not.toMatch(/apps\/worker\/dist\/ready\.js/);
    expectCurrentBuiltEntrypoint(manifest.services.server.command);
    expectCurrentBuiltEntrypoint(manifest.services.worker.command);
    if (manifest.services.node) {
      expectCurrentBuiltEntrypoint(manifest.services.node.command);
    }
  });

  it("contains server service health and readiness checks", () => {
    const compose = readFileSync(deployPath("docker-compose.yml"), "utf8");
    const serverService = serviceBlock(compose, "server");

    expect(serverService).toContain("healthcheck:");
    expect(serverService).toContain("/health");
    expect(serverService).toContain("/ready");
    expect(serverService).toContain("health.ok&&ready.ok");
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
      "/browser",
      "/search",
      "/github",
      "/fetch",
      "/repo",
      "exec",
      "sandbox",
      "pty",
      "terminal",
      "runtime-bridge",
      "session",
      "input",
      "approval",
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

  it("accepts explicit provider activation example as opt-in while default stays fake-only", () => {
    const providerOptIn = {
      version: "r21-provider-opt-in-example-v1",
      services: {
        server: {
          deploymentMode: "production",
          command: ["node", "apps/server/dist/main.js"],
          requiredEnv: [
            "SWITCHYARD_DEPLOYMENT_MODE",
            "SWITCHYARD_SERVER_AUTH_MODE",
            "SWITCHYARD_CONTROL_PLANE_STORE",
            "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
            "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
            "SWITCHYARD_SANDBOX_REAL_EXECUTION",
            "SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH",
            "OPENAI_API_KEY"
          ],
          healthChecks: ["GET /health", "GET /ready"],
          policy: {
            runtimeAllowlist: ["fake.deterministic", "codex.exec_json"],
            hostedRealRuntimeExecution: "enabled",
            objectStoreProbe: "write_read_delete",
            sandboxExecution: {
              realExecution: "disabled",
              commandPolicy: "required_when_enabled",
              networkPolicy: "disabled"
            }
          }
        },
        worker: {
          deploymentMode: "production",
          command: ["node", "apps/worker/dist/main.js"],
          requiredEnv: [
            "SWITCHYARD_DEPLOYMENT_MODE",
            "SWITCHYARD_OBJECT_STORE_PROBE",
            "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
            "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
            "SWITCHYARD_SANDBOX_REAL_EXECUTION",
            "SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH",
            "OPENAI_API_KEY"
          ],
          readinessGate: {
            command: ["node", "apps/worker/dist/ready.js"]
          },
          policy: {
            runtimeAllowlist: ["fake.deterministic", "codex.exec_json"],
            hostedRealRuntimeExecution: "enabled",
            objectStoreProbe: "write_read_delete",
            sandboxExecution: {
              realExecution: "disabled",
              commandPolicy: "required_when_enabled",
              networkPolicy: "disabled"
            }
          }
        }
      },
      requiredEnv: [
        "SWITCHYARD_DEPLOYMENT_MODE",
        "SWITCHYARD_SERVER_AUTH_MODE",
        "SWITCHYARD_CONTROL_PLANE_STORE",
        "SWITCHYARD_POSTGRES_URL",
        "SWITCHYARD_REDIS_URL",
        "SWITCHYARD_OBJECT_STORE_BACKEND",
        "SWITCHYARD_OBJECT_STORE_PROBE",
        "SWITCHYARD_NODE_SHARED_TOKEN",
        "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
        "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
        "SWITCHYARD_SANDBOX_REAL_EXECUTION"
      ],
      forbiddenSurfaces: [
        "dashboard",
        "tui",
        "payment",
        "oauth",
        "browser",
        "/sandbox",
        "/exec",
        "/shell",
        "/process",
        "/command",
        "/pty",
        "/terminal",
        "/browser",
        "/search",
        "/github",
        "/fetch",
        "/repo",
        "/dashboard",
        "/tui"
      ]
    };

    expect(providerOptIn.services.server.policy.hostedRealRuntimeExecution).toBe("enabled");
    expect(providerOptIn.services.worker.policy.hostedRealRuntimeExecution).toBe("enabled");

    const committedManifest = parseManifestJson(readFileSync(deployPath("manifest.json"), "utf8"));
    expect(committedManifest.services.server.policy?.hostedRealRuntimeExecution).toBe("disabled");
    expect(committedManifest.services.worker.policy?.hostedRealRuntimeExecution).toBe("disabled");
  });

  it("fails local manifest validation when tool posture is not fail-closed by default", async () => {
    const { validateProductionManifest } = await import("../../scripts/production-manifest.js");
    const result = await validateProductionManifest(deployPath("manifest.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const broken = structuredClone(result.manifest);
    broken.tools = {
      hostedRealTools: "enabled",
      connectedNodeRealTools: "enabled",
      policy: "required_when_enabled",
      approvalDefault: "required",
      adapterMode: "real_explicit"
    };

    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "switchyard-manifest-tools-"));
    const path = join(dir, "manifest.json");
    try {
      await writeFile(path, JSON.stringify(broken), "utf8");
      const invalid = await validateProductionManifest(path);
      expect(invalid.ok).toBe(false);
      if (invalid.ok) {
        return;
      }
      expect(invalid.errors).toEqual(expect.arrayContaining([
        { code: "manifest_forbidden_surface", service: "tools.hostedRealTools" },
        { code: "manifest_forbidden_surface", service: "tools.connectedNodeRealTools" },
        { code: "manifest_forbidden_surface", service: "tools.adapterMode" }
      ]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
