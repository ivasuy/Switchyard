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
});
