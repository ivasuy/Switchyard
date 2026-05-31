import { describe, expect, it } from "vitest";
import {
  LOCAL_DAEMON_ROUTE_INVENTORY,
  type RouteInventoryEntry,
  generateOpenApiDocument,
  renderOpenApiJson
} from "./openapi.js";
import { runOpenApiCli } from "./openapi-cli.js";

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
    const forbiddenTopLevelExecutionRoute = /^\/(sandbox|exec|pty|terminal|shell|process|command|browser|search)(\/|$)/;
    const forbiddenPaths = [
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
      "/sandbox"
    ];

    for (const document of [local, hosted]) {
      const paths = Object.keys(document.paths);
      for (const path of paths) {
        const lower = path.toLowerCase();
        expect(forbiddenTopLevelExecutionRoute.test(lower)).toBe(false);
        if (lower.startsWith("/tools/") && lower !== "/tools/invocations" && !lower.startsWith("/tools/invocations/")) {
          expect(lower).not.toMatch(/search|exec|shell|terminal|pty|process|browser|command/);
        }
      }
      for (const forbiddenPath of forbiddenPaths) {
        expect(paths.some((path) => path === forbiddenPath || path.startsWith(`${forbiddenPath}/`))).toBe(false);
      }
    }

    expect(local.paths["/memory/search"]?.get?.operationId).toBe("searchMemory");
  });

  it("keeps arbitrary execution operation ids out of OpenAPI", () => {
    const document = generateOpenApiDocument();
    const forbiddenOperationTokens = [
      "sandbox",
      "terminal",
      "exec",
      "pty",
      "shell",
      "process",
      "command",
      "genericProcess",
      "arbitraryProcess"
    ];
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
      const looksExecutionSurface = /tool|run|runtime|exec|shell|command|process|terminal|pty|browser/.test(
        `${path.toLowerCase()} ${summary} ${tags.join(" ")}`
      );
      if (!looksExecutionSurface) {
        continue;
      }
      expect(forbiddenOperationTokens.some((token) => lower.includes(token.toLowerCase()))).toBe(false);
    }
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
