import { LOCAL_DAEMON_ROUTE_INVENTORY, type ResponseContentKind, type RouteInventoryEntry } from "./endpoint-inventory.js";

interface SchemaObject {
  [key: string]: unknown;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
  };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, SchemaObject>>;
  components: {
    schemas: Record<string, SchemaObject>;
  };
}

const SCHEMA_BY_REF: Record<string, SchemaObject> = {
  ObjectResponse: { type: "object", additionalProperties: true },
  HealthResponse: {
    type: "object",
    required: ["ok"],
    properties: {
      ok: { type: "boolean" }
    },
    additionalProperties: true
  },
  MetricsResponse: {
    type: "object",
    required: ["requestsTotal", "errorsTotal", "runStatusCounts", "startupRecovery"],
    properties: {
      requestsTotal: { type: "integer", minimum: 0 },
      errorsTotal: { type: "integer", minimum: 0 },
      runStatusCounts: {
        type: "object",
        additionalProperties: { type: "integer", minimum: 0 }
      },
      startupRecovery: {
        type: "object",
        required: ["recoveredRuns", "failedSessions", "alreadyTerminal", "duplicateStarts"],
        properties: {
          recoveredRuns: { type: "integer", minimum: 0 },
          failedSessions: { type: "integer", minimum: 0 },
          alreadyTerminal: { type: "integer", minimum: 0 },
          duplicateStarts: { type: "integer", minimum: 0 }
        }
      }
    }
  },
  CreateRunResponse: { type: "object", additionalProperties: true },
  GetRunResponse: { type: "object", additionalProperties: true },
  ListRunsResponse: { type: "object", additionalProperties: true },
  ListRunArtifactsResponse: { type: "object", additionalProperties: true },
  AcceptedResponse: {
    type: "object",
    required: ["accepted"],
    properties: { accepted: { type: "boolean" } },
    additionalProperties: true
  },
  CancelRunResponse: { type: "object", additionalProperties: true },
  ListProvidersResponse: { type: "object", additionalProperties: true },
  ProviderResponse: { type: "object", additionalProperties: true },
  ListRuntimesResponse: { type: "object", additionalProperties: true },
  RuntimeResponse: { type: "object", additionalProperties: true },
  ListModelsResponse: { type: "object", additionalProperties: true },
  ModelResponse: { type: "object", additionalProperties: true },
  ListRuntimeModesResponse: { type: "object", additionalProperties: true },
  RuntimeModeResponse: { type: "object", additionalProperties: true },
  RuntimeModeCheckResponse: { type: "object", additionalProperties: true },
  DoctorSummaryResponse: { type: "object", additionalProperties: true },
  ArtifactResponse: { type: "object", additionalProperties: true },
  SseEventStream: {
    type: "string",
    description: "Server-sent events stream"
  },
  HttpErrorEnvelope: {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          requestId: { type: "string" },
          details: {
            type: "array",
            items: {
              type: "object",
              required: ["path", "issue"],
              properties: {
                path: { type: "string" },
                issue: { type: "string" }
              }
            }
          }
        }
      }
    }
  }
};

const SUPPORTED_CONTENT_KINDS = new Set<ResponseContentKind>(["json", "sse", "binary", "text"]);

export function generateOpenApiDocument(options: { inventory?: readonly RouteInventoryEntry[] } = {}): OpenApiDocument {
  const inventory = options.inventory ?? LOCAL_DAEMON_ROUTE_INVENTORY;
  if (inventory.length === 0) {
    throw new Error("Empty route inventory is not allowed.");
  }

  const paths: OpenApiDocument["paths"] = {};

  for (const entry of [...inventory].sort(sortInventory)) {
    if (!SUPPORTED_CONTENT_KINDS.has(entry.success.contentKind)) {
      throw new Error(`Unsupported content kind for ${entry.method.toUpperCase()} ${entry.path}: ${entry.success.contentKind}`);
    }

    if (entry.success.schemaRef && !(entry.success.schemaRef in SCHEMA_BY_REF)) {
      throw new Error(`Unknown schema reference: ${entry.success.schemaRef}`);
    }

    const openApiPath = toOpenApiPath(entry.path);
    const responses: Record<string, SchemaObject> = {
      [String(entry.success.status)]: buildSuccessResponse(entry),
      "400": jsonResponse("Invalid request", "HttpErrorEnvelope"),
      "404": jsonResponse("Not found", "HttpErrorEnvelope"),
      "409": jsonResponse("Conflict", "HttpErrorEnvelope"),
      "500": jsonResponse("Internal error", "HttpErrorEnvelope")
    };

    if (!paths[openApiPath]) {
      paths[openApiPath] = {};
    }
    paths[openApiPath][entry.method] = {
      operationId: operationIdFor(entry),
      tags: entry.tags,
      summary: entry.summary,
      responses,
      ...(entry.success.contentKind === "sse"
        ? {
          "x-switchyard-stream": {
            kind: "sse"
          }
        }
        : {}),
      ...(entry.path === "/artifacts/:id/content"
        ? {
          "x-switchyard-content": {
            mode: "raw",
            supportsBinary: true
          }
        }
        : {})
    };
  }

  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: "Switchyard Local Daemon API",
      version: "0.0.0"
    },
    servers: [{ url: "http://127.0.0.1:4545" }],
    paths,
    components: {
      schemas: SCHEMA_BY_REF
    }
  };

  return stableObject(document) as OpenApiDocument;
}

export function renderOpenApiJson(document: OpenApiDocument): string {
  return `${JSON.stringify(stableObject(document), null, 2)}\n`;
}

function buildSuccessResponse(entry: RouteInventoryEntry): SchemaObject {
  if (entry.success.contentKind === "json") {
    return jsonResponse("Success", entry.success.schemaRef ?? "ObjectResponse");
  }
  if (entry.success.contentKind === "sse") {
    return {
      description: "SSE stream",
      content: {
        "text/event-stream": {
          schema: { $ref: "#/components/schemas/SseEventStream" }
        }
      }
    };
  }
  if (entry.success.contentKind === "text") {
    return {
      description: "Plain text",
      content: {
        "text/plain": {
          schema: { type: "string" }
        }
      }
    };
  }
  return {
    description: "Raw binary content",
    content: {
      "application/octet-stream": {
        schema: {
          type: "string",
          format: "binary"
        }
      }
    }
  };
}

function jsonResponse(description: string, schemaRef: string): SchemaObject {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schemaRef}` }
      }
    }
  };
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function operationIdFor(entry: RouteInventoryEntry): string {
  const normalized = entry.path.replace(/^\//, "").replace(/\//g, "_").replace(/:/g, "");
  const method = entry.method.toLowerCase();
  return `${method}_${normalized || "root"}`;
}

function sortInventory(left: RouteInventoryEntry, right: RouteInventoryEntry): number {
  if (left.path === right.path) {
    return left.method.localeCompare(right.method);
  }
  return left.path.localeCompare(right.path);
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableObject(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, stableObject(entry)] as const);
  return Object.fromEntries(entries);
}

export { LOCAL_DAEMON_ROUTE_INVENTORY, type RouteInventoryEntry };
