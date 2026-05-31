import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LOCAL_DAEMON_ROUTE_INVENTORY,
  type RouteInventoryEntry,
  generateOpenApiDocument,
  renderOpenApiJson
} from "./openapi.js";
import { runOpenApiCli } from "./openapi-cli.js";

const FORBIDDEN_PUBLIC_ROUTE_PREFIX =
  /^\/(exec|shell|process|command|pty|terminal|sandbox|browser|search|github|fetch|repo|dashboard|tui)(\/|$)/;
const FORBIDDEN_OPERATION_TOKENS = [
  "sandbox",
  "terminal",
  "exec",
  "pty",
  "shell",
  "process",
  "command",
  "browser",
  "search",
  "github",
  "fetch",
  "repo",
  "dashboard",
  "tui",
  "genericProcess",
  "arbitraryProcess"
];
const FORBIDDEN_EXACT_PATHS = [
  "/tenant/signup",
  "/billing/checkout",
  "/billing/webhook",
  "/payments",
  "/dashboard",
  "/tui",
  "/exec",
  "/shell",
  "/process",
  "/command",
  "/pty",
  "/terminal",
  "/sandbox",
  "/browser",
  "/search",
  "/github",
  "/fetch",
  "/repo"
];
const FORBIDDEN_HOSTED_PROVIDER_EXPANSION_PATH_PREFIX =
  /^\/(cursor|openclaw|paperclip|debates\/participants\/real|debates\/judge|model-judge|judging)(\/|$)/;
const FORBIDDEN_HOSTED_PROVIDER_EXPANSION_OPERATION_TOKENS = [
  "cursor",
  "openclaw",
  "paperclip",
  "debateparticipantreal",
  "realdebateparticipant",
  "modeljudge",
  "debatejudge",
  "judging"
];

function readRootFile(relativePath: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "../../..", relativePath), "utf8");
}

describe("openapi generation", () => {
  it("generates deterministic bytes", () => {
    const first = renderOpenApiJson(generateOpenApiDocument());
    const second = renderOpenApiJson(generateOpenApiDocument());
    expect(first).toBe(second);
  });

  it("rejects empty inventory", () => {
    expect(() => generateOpenApiDocument({ inventory: [] })).toThrow(
      'OpenAPI route inventory is empty for surface "local_daemon".'
    );
  });

  it("rejects unsupported content kinds", () => {
    const bad = [{ ...LOCAL_DAEMON_ROUTE_INVENTORY[0], success: { status: 200, contentKind: "yaml" as never } }];
    expect(() => generateOpenApiDocument({ inventory: bad })).toThrow(/unsupported content kind/i);
  });

  it("rejects unsupported schema references", () => {
    const bad: RouteInventoryEntry[] = [
      {
        surface: "local_daemon",
        errorEnvelopeOwner: "contracts",
        method: "get",
        path: "/bad",
        operationId: "badSchema",
        summary: "Bad schema",
        tags: ["broken"],
        noRequestBody: true,
        success: {
          status: 200,
          contentKind: "json",
          schemaRef: "UnknownSchema",
          description: "Broken schema"
        }
      }
    ];
    expect(() => generateOpenApiDocument({ inventory: bad })).toThrow(/unknown schema reference/i);
  });

  it("rejects unknown surfaces with deterministic error message", () => {
    expect(() => generateOpenApiDocument({ surface: "unknown" as never })).toThrow(
      'Unknown OpenAPI surface "unknown". Expected one of: local_daemon, hosted_server.'
    );
  });

  it("cli reports deterministic unknown surface message", async () => {
    const stderr: string[] = [];
    const exitCode = await runOpenApiCli(["generate", "--surface", "unknown"], {
      cwd: () => "/tmp",
      stdout: () => {},
      stderr: (text) => stderr.push(text),
      readFile: () => "",
      writeFile: () => {}
    });
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain(
      'Unknown OpenAPI surface "unknown". Expected one of: local_daemon, hosted_server.'
    );
  });

  it("cli reports deterministic drift message with surface script", async () => {
    const stderr: string[] = [];
    const exitCode = await runOpenApiCli(["check", "--surface", "hosted_server"], {
      cwd: () => "/tmp",
      stdout: () => {},
      stderr: (text) => stderr.push(text),
      readFile: () => "stale",
      writeFile: () => {}
    });
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain(
      "OpenAPI artifact drift for openapi.hosted-server.json; run openapi:generate:hosted to regenerate."
    );
  });

  it("documents artifact content raw behavior with extension", () => {
    const document = generateOpenApiDocument();
    const operation = document.paths["/artifacts/{id}/content"]?.get;
    expect(operation).toBeDefined();
    expect(operation?.["x-switchyard-content"]).toEqual({
      mode: "raw",
      supportsBinary: true
    });
  });

  it("includes route descriptor operation id and request/query schemas", () => {
    const document = generateOpenApiDocument();

    const createRun = document.paths["/runs"]?.post;
    expect(createRun?.operationId).toBe("createRun");
    expect(createRun?.requestBody).toBeDefined();
    expect(Array.isArray(createRun?.parameters)).toBe(true);

    const listRuns = document.paths["/runs"]?.get;
    expect(listRuns?.operationId).toBe("listRuns");
    const queryParameters = listRuns?.parameters as Array<{ name: string }> | undefined;
    expect(queryParameters?.some((parameter) => parameter.name === "limit")).toBe(true);
  });

  it("marks no-body routes and error-envelope ownership", () => {
    const document = generateOpenApiDocument();
    const getRun = document.paths["/runs/{id}"]?.get;
    expect(getRun?.["x-switchyard-no-body"]).toBe(true);
    expect(getRun?.["x-switchyard-error-envelope"]).toBe("contracts");
  });

  it("keeps local daemon OpenAPI unauthenticated and hosted-only routes absent", () => {
    const document = generateOpenApiDocument();

    expect(document.info.title).toBe("Switchyard Local Daemon API");
    expect(document.servers).toEqual([{ url: "http://127.0.0.1:4545" }]);
    expect(document.components.securitySchemes).toBeUndefined();
    expect(document.paths["/auth/whoami"]).toBeUndefined();
    expect(document.paths["/entitlements"]).toBeUndefined();
    expect(document.paths["/audit/events"]).toBeUndefined();
  });

  it("adds hosted OpenAPI title, server, and security scheme", () => {
    const document = generateOpenApiDocument({ surface: "hosted_server" });
    expect(document.info.title).toBe("Switchyard Hosted Server API");
    expect(document.servers).toEqual([{ url: "https://api.switchyard.local" }]);
    expect(document.components.securitySchemes).toEqual({
      SwitchyardApiKey: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Switchyard API key",
        description: "Use Authorization: Bearer <switchyard_api_key> or x-switchyard-api-key."
      }
    });
  });

  it("includes hosted enterprise routes", () => {
    const document = generateOpenApiDocument({ surface: "hosted_server" });
    expect(document.paths["/auth/whoami"]?.get?.operationId).toBe("whoami");
    expect(document.paths["/entitlements"]?.get?.operationId).toBe("getEntitlements");
    expect(document.paths["/audit/events"]?.get?.operationId).toBe("listAuditEvents");
  });

  it("keeps hosted /health and /ready public", () => {
    const document = generateOpenApiDocument({ surface: "hosted_server" });
    expect(document.paths["/health"]?.get?.security).toBeUndefined();
    expect(document.paths["/ready"]?.get?.security).toBeUndefined();
  });

  it("documents hosted readiness schema checks with named codes and diagnostics", () => {
    const document = generateOpenApiDocument({ surface: "hosted_server" });
    const readySchema = document.components.schemas["ReadyResponse"] as Record<string, unknown> | undefined;
    const examples = readySchema?.examples as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(examples)).toBe(true);

    const first = (examples ?? [])[0];
    const checks = first?.checks as Record<string, unknown> | undefined;
    const schemaCheck = checks?.schema as Record<string, unknown> | undefined;
    expect(typeof schemaCheck?.ok).toBe("boolean");
    expect(String(schemaCheck?.code ?? "")).toBe("postgres_schema_migration_required");
    expect(schemaCheck?.diagnostics).toEqual(
      expect.objectContaining({
        expectedVersion: expect.any(Number),
        actualVersion: expect.any(Number)
      })
    );
    expect(schemaCheck?.diagnostics).not.toEqual(
      expect.objectContaining({
        currentVersion: expect.any(Number),
        requiredVersion: expect.any(Number),
        compatible: expect.any(Boolean)
      })
    );
  });

  it("protects hosted runs and node routes with SwitchyardApiKey", () => {
    const document = generateOpenApiDocument({ surface: "hosted_server" });
    const expectedSecurity = [{ SwitchyardApiKey: [] }];

    expect(document.paths["/runs"]?.post?.security).toEqual(expectedSecurity);
    expect(document.paths["/runs/{id}/events"]?.get?.security).toEqual(expectedSecurity);
    expect(document.paths["/nodes/register"]?.post?.security).toEqual(expectedSecurity);
    expect(document.paths["/nodes/{id}"]?.get?.security).toEqual(expectedSecurity);
  });

  it("documents hosted /metrics as protected operator-only global metrics", () => {
    const document = generateOpenApiDocument({ surface: "hosted_server" });
    const metricsGet = document.paths["/metrics"]?.get as Record<string, unknown> | undefined;
    expect(metricsGet?.security).toEqual([{ SwitchyardApiKey: [] }]);
    expect(String(metricsGet?.summary ?? "")).toMatch(/operator-only global metrics/i);
    const requiredScopes = metricsGet?.["x-switchyard-required-scopes"] as string[] | undefined;
    expect(requiredScopes).toEqual(["metrics:read", "admin:read"]);
    expect(document.paths["/metrics/tenant"]).toBeUndefined();
  });

  it("includes hosted audit query schema", () => {
    const document = generateOpenApiDocument({ surface: "hosted_server" });
    const listAudit = document.paths["/audit/events"]?.get as Record<string, unknown> | undefined;
    const parameters = listAudit?.parameters as Array<{ name: string }>;
    expect(parameters.map((parameter) => parameter.name)).toEqual(["cursor", "limit"]);
  });

  it("keeps public arbitrary execution routes out of OpenAPI", () => {
    const local = generateOpenApiDocument();
    const hosted = generateOpenApiDocument({ surface: "hosted_server" });

    for (const document of [local, hosted]) {
      const paths = Object.keys(document.paths);
      for (const path of paths) {
        const lower = path.toLowerCase();
        expect(FORBIDDEN_PUBLIC_ROUTE_PREFIX.test(lower)).toBe(false);
        if (lower.startsWith("/tools/") && lower !== "/tools/invocations" && !lower.startsWith("/tools/invocations/")) {
          expect(lower).not.toMatch(/search|exec|shell|terminal|pty|process|browser|command|github|fetch|repo/);
        }
      }
      for (const forbiddenPath of FORBIDDEN_EXACT_PATHS) {
        expect(paths.some((path) => path === forbiddenPath || path.startsWith(`${forbiddenPath}/`))).toBe(false);
      }
    }

    expect(local.paths["/memory/search"]?.get?.operationId).toBe("searchMemory");
    expect(hosted.paths["/tools/invocations"]).toBeUndefined();
  });

  it("keeps arbitrary execution operation ids out of OpenAPI", () => {
    for (const document of [generateOpenApiDocument(), generateOpenApiDocument({ surface: "hosted_server" })]) {
      const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
        Object.values(methods).map((operation) => ({ path, operation: operation as Record<string, unknown> }))
      );
      for (const { path, operation } of operations) {
        const operationId = String(operation["operationId"] ?? "");
        const lower = operationId.toLowerCase();
        if (operationId === "searchMemory" && path === "/memory/search") {
          continue;
        }
        const summary = String(operation["summary"] ?? "").toLowerCase();
        const tags = Array.isArray(operation["tags"]) ? operation["tags"].map((tag) => String(tag).toLowerCase()) : [];
        const looksExecutionSurface =
          /tool|run|runtime|exec|shell|command|process|terminal|pty|browser|search|github|fetch|repo/.test(
            `${path.toLowerCase()} ${summary} ${tags.join(" ")}`
          );
        if (!looksExecutionSurface) {
          continue;
        }
        expect(FORBIDDEN_OPERATION_TOKENS.some((token) => lower.includes(token.toLowerCase()))).toBe(false);
      }
    }
  });

  it("keeps hosted OpenAPI free of non-R21 provider routes and hosted debate judging surfaces", () => {
    const hosted = generateOpenApiDocument({ surface: "hosted_server" });
    const paths = Object.keys(hosted.paths);
    for (const path of paths) {
      const lower = path.toLowerCase();
      expect(FORBIDDEN_HOSTED_PROVIDER_EXPANSION_PATH_PREFIX.test(lower)).toBe(false);
      expect(lower).not.toContain("/cursor/");
      expect(lower).not.toContain("/openclaw/");
      expect(lower).not.toContain("/paperclip/");
      expect(lower).not.toContain("/debates/participants/real");
      expect(lower).not.toContain("/debates/judge");
      expect(lower).not.toContain("/model-judge");
      expect(lower).not.toContain("/judging");
    }

    const operations = Object.entries(hosted.paths).flatMap(([path, methods]) =>
      Object.values(methods).map((operation) => ({ path, operation: operation as Record<string, unknown> }))
    );
    for (const { path, operation } of operations) {
      const operationId = String(operation["operationId"] ?? "");
      const lowerId = operationId.toLowerCase();
      const summary = String(operation["summary"] ?? "").toLowerCase();
      const tags = Array.isArray(operation["tags"]) ? operation["tags"].map((tag) => String(tag).toLowerCase()) : [];
      const combined = `${path.toLowerCase()} ${lowerId} ${summary} ${tags.join(" ")}`;
      const looksLikeForbiddenExpansion =
        /cursor|openclaw|paperclip|debate|participant|judge|judging|model/.test(combined);
      if (!looksLikeForbiddenExpansion) {
        continue;
      }
      expect(
        FORBIDDEN_HOSTED_PROVIDER_EXPANSION_OPERATION_TOKENS.some((token) => lowerId.includes(token.toLowerCase()))
      ).toBe(false);
      expect(combined).not.toMatch(/debates\/participants\/real|model[ _-]?judge|debate[ _-]?judge|judging/);
    }
  });

  it("documents R21 hosted-provider boundary in product docs", () => {
    const product = readRootFile("PRODUCT.md");
    const readme = readRootFile("README.md");
    const api = readRootFile("docs/development/API.md");
    const development = readRootFile("docs/development/DEVELOPMENT.md");
    const codex = readRootFile("docs/development/adapters/CODEX.md");
    const claude = readRootFile("docs/development/adapters/CLAUDE_CODE.md");
    const opencode = readRootFile("docs/development/adapters/OPENCODE.md");
    const developerDocs = [readme, api, development, codex, claude, opencode].join("\n");

    expect(product).toContain("R21");
    expect(product).toMatch(/known provider/i);
    expect(product).toMatch(/fake-only remains default/i);
    expect(product).toMatch(/operator opt-in/i);
    expect(product).toMatch(/rollback/i);

    expect(developerDocs).toMatch(/known provider/i);
    expect(developerDocs).toMatch(/operator opt-in/i);
    expect(developerDocs).toMatch(/no-spend smoke/i);
    expect(developerDocs).toMatch(/spend-gated canary/i);
    expect(developerDocs).toMatch(/rollback/i);
    expect(developerDocs).toMatch(/does not ship generic process\/pty runtime adapters/i);
    expect(developerDocs).toMatch(/does not ship cursor\/openclaw\/paperclip/i);
    expect(developerDocs).toMatch(/does not ship hosted browser\/search\/github\/fetch\/repo tools/i);
    expect(developerDocs).toMatch(/does not ship hosted debate real participants or hosted model judging/i);
    expect(developerDocs).toMatch(/does not ship hosted approval bridge, hosted input bridge, or hosted terminal bridge/i);
  });

  it("documents tool invocation create/get/list envelopes with invocation field names", () => {
    const document = generateOpenApiDocument();
    const components = document.components.schemas;
    const toolInvocationResponse = components["ToolInvocationResponse"] as Record<string, unknown>;
    const listToolInvocationsResponse = components["ListToolInvocationsResponse"] as Record<string, unknown>;
    expect(toolInvocationResponse).toBeDefined();
    expect(listToolInvocationsResponse).toBeDefined();

    const toolInvocationProps = (toolInvocationResponse.properties ?? {}) as Record<string, unknown>;
    const listProps = (listToolInvocationsResponse.properties ?? {}) as Record<string, unknown>;
    expect(toolInvocationProps["invocation"]).toBeDefined();
    expect(toolInvocationProps["approval"]).toBeDefined();
    expect(toolInvocationProps["toolInvocation"]).toBeUndefined();
    expect(listProps["invocations"]).toBeDefined();
    expect(listProps["toolInvocations"]).toBeUndefined();
  });
});
