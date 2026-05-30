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
    const forbiddenPathTokens = ["/sandbox", "/exec", "/pty", "/terminal"];
    const paths = Object.keys(document.paths);
    for (const path of paths) {
      const lower = path.toLowerCase();
      expect(forbiddenPathTokens.some((token) => lower === token || lower.startsWith(`${token}/`))).toBe(false);
    }
  });

  it("keeps arbitrary execution operation ids out of OpenAPI", () => {
    const document = generateOpenApiDocument();
    const forbiddenOperationTokens = ["sandbox", "terminal", "exec", "pty", "genericProcess", "arbitrary"];
    const operationIds = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => String((operation as Record<string, unknown>)["operationId"] ?? ""))
    );
    for (const operationId of operationIds) {
      const lower = operationId.toLowerCase();
      expect(forbiddenOperationTokens.some((token) => lower.includes(token.toLowerCase()))).toBe(false);
    }
  });
});
