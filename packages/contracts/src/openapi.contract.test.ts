import { describe, expect, it } from "vitest";
import {
  LOCAL_DAEMON_ROUTE_INVENTORY,
  type RouteInventoryEntry,
  generateOpenApiDocument,
  renderOpenApiJson
} from "./openapi.js";

describe("openapi generation", () => {
  it("generates deterministic bytes", () => {
    const first = renderOpenApiJson(generateOpenApiDocument());
    const second = renderOpenApiJson(generateOpenApiDocument());
    expect(first).toBe(second);
  });

  it("rejects empty inventory", () => {
    expect(() => generateOpenApiDocument({ inventory: [] })).toThrow(/empty route inventory/i);
  });

  it("rejects unsupported content kinds", () => {
    const bad = [{ ...LOCAL_DAEMON_ROUTE_INVENTORY[0], success: { status: 200, contentKind: "yaml" as never } }];
    expect(() => generateOpenApiDocument({ inventory: bad })).toThrow(/unsupported content kind/i);
  });

  it("rejects unsupported schema references", () => {
    const bad: RouteInventoryEntry[] = [
      {
        method: "get",
        path: "/bad",
        summary: "Bad schema",
        tags: ["broken"],
        success: {
          status: 200,
          contentKind: "json",
          schemaRef: "UnknownSchema"
        }
      }
    ];
    expect(() => generateOpenApiDocument({ inventory: bad })).toThrow(/unknown schema reference/i);
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

  it("keeps public arbitrary execution routes out of OpenAPI", () => {
    const document = generateOpenApiDocument();
    const forbiddenTopLevelExecutionRoute = /^\/(sandbox|exec|pty|terminal|shell|process|command|browser|search)(\/|$)/;
    const paths = Object.keys(document.paths);
    for (const path of paths) {
      const lower = path.toLowerCase();
      expect(forbiddenTopLevelExecutionRoute.test(lower)).toBe(false);
      if (lower.startsWith("/tools/") && lower !== "/tools/invocations" && !lower.startsWith("/tools/invocations/")) {
        expect(lower).not.toMatch(/search|exec|shell|terminal|pty|process|browser|command/);
      }
    }
    expect(document.paths["/memory/search"]?.get?.operationId).toBe("searchMemory");
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
