import { z } from "zod";
import {
  listModelsQuerySchema,
  listModelsResponseSchema,
  listProvidersQuerySchema,
  listProvidersResponseSchema,
  listRuntimeModesQuerySchema,
  listRuntimeModesResponseSchema,
  listRuntimesQuerySchema,
  listRuntimesResponseSchema,
  listRunsQuerySchema,
  listRunsResponseSchema,
  doctorSummaryResponseSchema
} from "./list-queries.js";
import { runSchema } from "./run.js";
import { eventSchema } from "./event.js";
import { artifactSchema } from "./artifact.js";
import { providerSchema, runtimeSchema, modelSchema, runtimeModeSchema, runtimeDoctorCheckSchema } from "./registry.js";
import { messageSchema } from "./message.js";
import { memoryItemSchema } from "./memory.js";
import { evidenceItemSchema } from "./evidence.js";
import { contextPacketSchema } from "./context.js";
import { approvalSchema } from "./approval.js";
import { createToolInvocationRequestSchema, toolInvocationSchema } from "./tool.js";
import { debateSchema } from "./debate.js";
import { httpErrorEnvelopeSchema } from "./http-error.js";
import { nodeSchema } from "./node.js";
import {
  whoamiResponseSchema,
  entitlementsResponseSchema,
  auditEventsResponseSchema
} from "./enterprise.js";
import {
  assignmentSchema,
  assignmentClaimRequestSchema,
  assignmentClaimResponseSchema,
  assignmentRejectRequestSchema,
  assignmentEventSyncRequestSchema,
  assignmentEventSyncResponseSchema,
  assignmentArtifactManifestRequestSchema,
  assignmentArtifactManifestResponseSchema,
  assignmentCompleteRequestSchema,
  nodeHeartbeatRequestSchema,
  nodeRegisterRequestSchema
} from "./assignment.js";
import {
  LOCAL_DAEMON_ROUTE_INVENTORY,
  HOSTED_SERVER_ROUTE_INVENTORY,
  type ResponseContentKind,
  type RouteInventoryEntry
} from "./endpoint-inventory.js";

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
    securitySchemes?: Record<string, SchemaObject>;
  };
}

export type OpenApiSurface = "local_daemon" | "hosted_server";

const SUPPORTED_CONTENT_KINDS = new Set<ResponseContentKind>(["json", "sse", "binary", "text"]);

const SCHEMA_BY_REF: Record<string, z.ZodTypeAny> = {
  HealthResponse: z.object({ ok: z.boolean() }),
  ReadyResponse: z.object({
    ok: z.boolean(),
    checks: z.record(
      z.string(),
      z.object({
        ok: z.boolean(),
        code: z.string().optional(),
        diagnostics: z.record(z.string(), z.unknown()).optional()
      })
    )
  }),
  MetricsResponse: z.object({
    requestsTotal: z.number().int().nonnegative(),
    errorsTotal: z.number().int().nonnegative(),
    runStatusCounts: z.record(z.string(), z.number().int().nonnegative()),
    startupRecovery: z.object({
      recoveredRuns: z.number().int().nonnegative(),
      failedSessions: z.number().int().nonnegative(),
      alreadyTerminal: z.number().int().nonnegative(),
      duplicateStarts: z.number().int().nonnegative()
    })
  }),
  HostedMetricsResponse: z.object({
    requests: z.record(z.string(), z.number().or(z.boolean())),
    errors: z.record(z.string(), z.number().or(z.boolean())),
    placement: z.record(z.string(), z.number().or(z.boolean())),
    hostedRuntime: z.record(z.string(), z.number().or(z.boolean())),
    queue: z.record(z.string(), z.number().or(z.boolean())),
    worker: z.record(z.string(), z.number().or(z.boolean())),
    objectStore: z.record(z.string(), z.number().or(z.boolean())),
    sandbox: z.record(z.string(), z.number().or(z.boolean())),
    node: z.record(z.string(), z.number().or(z.boolean())),
    auth: z.record(z.string(), z.number().or(z.boolean())),
    tenant: z.record(z.string(), z.number().or(z.boolean())),
    entitlement: z.record(z.string(), z.number().or(z.boolean())),
    quota: z.record(z.string(), z.number().or(z.boolean())),
    audit: z.record(z.string(), z.number().or(z.boolean())),
    controlPlane: z.record(z.string(), z.number().or(z.boolean())),
    dependencies: z.record(z.string(), z.number().or(z.boolean())),
    config: z.record(z.string(), z.number().or(z.boolean()))
  }),
  CreateRunQuery: z.object({ wait: z.enum(["1"]).optional() }),
  CreateRunRequest: z.object({
    runtime: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    adapterType: z.string().min(1),
    cwd: z.string().min(1),
    task: z.string().min(1),
    placement: z.enum(["local", "hosted", "connected_local_node"]).optional(),
    approvalPolicy: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    context: z.unknown().optional()
  }),
  CreateRunResponse: z.object({
    run: runSchema,
    response: z.unknown().optional()
  }),
  GetRunResponse: z.object({
    run: runSchema,
    events: z.array(eventSchema)
  }),
  ListRunsQuery: listRunsQuerySchema,
  ListRunsResponse: listRunsResponseSchema,
  EntityEventsQuery: z.object({
    live: z.enum(["1"]).optional(),
    stopAfter: z.coerce.number().int().positive().optional(),
    lastEventId: z.string().min(1).optional()
  }),
  ListRunArtifactsResponse: z.object({
    artifacts: z.array(artifactSchema)
  }),
  SendRunInputRequest: z.object({
    text: z.string().min(1),
    approvalId: z.string().min(1).optional(),
    approvalDecision: z.enum(["approved", "rejected"]).optional(),
    reason: z.string().min(1).optional(),
    answers: z.array(z.record(z.string(), z.unknown())).optional()
  }),
  AcceptedResponse: z.object({ accepted: z.boolean() }),
  CancelRunResponse: z.object({ run: runSchema }),

  ListProvidersQuery: listProvidersQuerySchema,
  ListProvidersResponse: listProvidersResponseSchema,
  ProviderResponse: z.object({ provider: providerSchema }),
  ListRuntimesQuery: listRuntimesQuerySchema,
  ListRuntimesResponse: listRuntimesResponseSchema,
  RuntimeResponse: z.object({ runtime: runtimeSchema }),
  ListModelsQuery: listModelsQuerySchema,
  ListModelsResponse: listModelsResponseSchema,
  ModelResponse: z.object({ model: modelSchema }),
  ListRuntimeModesQuery: listRuntimeModesQuerySchema,
  ListRuntimeModesResponse: listRuntimeModesResponseSchema,
  RuntimeModeResponse: z.object({ runtimeMode: runtimeModeSchema }),
  RuntimeModeCheckResponse: z.object({ check: runtimeDoctorCheckSchema }),
  DoctorSummaryResponse: doctorSummaryResponseSchema,

  ArtifactResponse: z.object({ artifact: artifactSchema }),
  RawArtifactContent: z.string(),

  CreateMessageRequest: z.object({
    fromRunId: z.string().min(1).optional(),
    toRunId: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    content: z.string().min(1),
    attachments: z.array(z.record(z.string(), z.unknown())).optional()
  }),
  MessageResponse: z.object({ message: messageSchema }),
  ListMessagesQuery: z.object({
    runId: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    deliveryStatus: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().optional(),
    before: z.string().min(1).optional()
  }),
  ListMessagesResponse: z.object({
    messages: z.array(messageSchema),
    nextCursor: z.string().nullable()
  }),

  CreateMemoryRequest: z.object({
    scope: z.string().min(1),
    projectId: z.string().optional(),
    runId: z.string().optional(),
    debateId: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    content: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional()
  }),
  MemoryResponse: z.object({ memory: memoryItemSchema }),
  ListMemoryQuery: z.object({
    scope: z.string().min(1).optional(),
    projectId: z.string().optional(),
    runId: z.string().optional(),
    debateId: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    limit: z.coerce.number().int().positive().optional(),
    before: z.string().min(1).optional()
  }),
  SearchMemoryQuery: z.object({
    q: z.string().min(1),
    scope: z.string().min(1).optional(),
    projectId: z.string().optional(),
    runId: z.string().optional(),
    debateId: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    limit: z.coerce.number().int().positive().optional(),
    before: z.string().min(1).optional()
  }),
  ListMemoryResponse: z.object({
    memory: z.array(memoryItemSchema),
    nextCursor: z.string().nullable()
  }),

  CreateEvidenceRequest: z.object({
    debateId: z.string().optional(),
    sourceType: z.string().min(1),
    url: z.string().optional(),
    title: z.string().min(1),
    snippet: z.string().optional(),
    fetchedContentPath: z.string().optional(),
    reliability: z.string().min(1)
  }),
  EvidenceResponse: z.object({ evidence: evidenceItemSchema }),
  ListEvidenceQuery: z.object({
    debateId: z.string().optional(),
    sourceType: z.string().optional(),
    reliability: z.string().optional(),
    q: z.string().optional(),
    limit: z.coerce.number().int().positive().optional(),
    before: z.string().optional()
  }),
  ListEvidenceResponse: z.object({
    evidence: z.array(evidenceItemSchema),
    nextCursor: z.string().nullable()
  }),

  BuildContextRequest: z.object({
    target: z.enum(["run", "debate", "participant", "tool"]),
    sections: z.array(z.record(z.string(), z.unknown())).optional(),
    memoryIds: z.array(z.string().min(1)).optional(),
    evidenceIds: z.array(z.string().min(1)).optional(),
    messageIds: z.array(z.string().min(1)).optional()
  }),
  ContextResponse: z.object({
    context: contextPacketSchema
  }).or(z.object({ rendered: z.string().min(1), context: contextPacketSchema })),

  CreateApprovalRequest: z.object({
    runId: z.string().optional(),
    approvalType: z.string().min(1),
    payload: z.record(z.string(), z.unknown()).optional()
  }),
  ApprovalResponse: z.object({ approval: approvalSchema }),
  ListApprovalsQuery: z.object({
    runId: z.string().optional(),
    status: z.string().optional(),
    approvalType: z.string().optional(),
    limit: z.coerce.number().int().positive().optional(),
    before: z.string().optional()
  }),
  ListApprovalsResponse: z.object({
    approvals: z.array(approvalSchema),
    nextCursor: z.string().nullable()
  }),
  ResolveApprovalRequest: z.object({
    actor: z.string().optional(),
    reason: z.string().optional(),
    answers: z.array(z.record(z.string(), z.unknown())).optional()
  }),
  ApprovalResolutionResponse: z.object({
    approval: approvalSchema,
    event: eventSchema.optional()
  }).passthrough(),

  CreateToolInvocationRequest: createToolInvocationRequestSchema,
  ToolInvocationResponse: z.object({
    invocation: toolInvocationSchema,
    approval: approvalSchema.optional()
  }).passthrough(),
  ListToolInvocationsQuery: z.object({
    runId: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    limit: z.coerce.number().int().positive().optional(),
    before: z.string().optional()
  }),
  ListToolInvocationsResponse: z.object({
    invocations: z.array(toolInvocationSchema),
    nextCursor: z.string().nullable()
  }),

  CreateDebateQuery: z.object({ wait: z.enum(["1"]).optional() }),
  CreateDebateRequest: z.object({
    topic: z.string().min(1)
  }).passthrough(),
  CreateDebateResponse: z.object({ debate: debateSchema }).passthrough(),
  GetDebateResponse: z.object({ debate: debateSchema }).passthrough(),

  NodeRegisterRequest: nodeRegisterRequestSchema,
  NodeRegisterResponse: z.object({ node: nodeSchema }),
  NodeHeartbeatRequest: nodeHeartbeatRequestSchema,
  NodeHeartbeatResponse: z.object({ node: nodeSchema }),
  AssignmentClaimRequest: assignmentClaimRequestSchema,
  AssignmentClaimResponse: assignmentClaimResponseSchema,
  AssignmentRejectRequest: assignmentRejectRequestSchema,
  AssignmentEventSyncRequest: assignmentEventSyncRequestSchema,
  AssignmentEventSyncResponse: assignmentEventSyncResponseSchema,
  AssignmentArtifactManifestRequest: assignmentArtifactManifestRequestSchema,
  AssignmentArtifactManifestResponse: assignmentArtifactManifestResponseSchema,
  AssignmentArtifactContentResponse: z.object({ accepted: z.boolean(), artifactId: z.string().min(1) }),
  AssignmentCompleteRequest: assignmentCompleteRequestSchema,
  AssignmentResponse: z.object({ assignment: assignmentSchema }),
  ListNodesQuery: z.object({}),
  ListNodesResponse: z.object({ nodes: z.array(nodeSchema) }),
  NodeResponse: z.object({ node: nodeSchema }),
  WhoamiResponse: whoamiResponseSchema,
  EntitlementsResponse: entitlementsResponseSchema,
  AuditEventsQuery: z.object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    cursor: z.string().min(1).optional()
  }),
  AuditEventsResponse: auditEventsResponseSchema,

  SseEventStream: z.string(),
  HttpErrorEnvelope: httpErrorEnvelopeSchema
};

const SURFACE_SPECS: Record<OpenApiSurface, {
  readonly title: string;
  readonly serverUrl: string;
  readonly inventory: readonly RouteInventoryEntry[];
}> = {
  local_daemon: {
    title: "Switchyard Local Daemon API",
    serverUrl: "http://127.0.0.1:4545",
    inventory: LOCAL_DAEMON_ROUTE_INVENTORY
  },
  hosted_server: {
    title: "Switchyard Hosted Server API",
    serverUrl: "https://api.switchyard.local",
    inventory: HOSTED_SERVER_ROUTE_INVENTORY
  }
};

interface GenerateOpenApiDocumentOptions {
  surface?: OpenApiSurface;
  inventory?: readonly RouteInventoryEntry[];
}

export function generateOpenApiDocument(options: GenerateOpenApiDocumentOptions = {}): OpenApiDocument {
  const surface = parseSurface(options.surface);
  const surfaceSpec = SURFACE_SPECS[surface];
  const inventory = options.inventory ?? surfaceSpec.inventory;
  if (inventory.length === 0) {
    throw new Error(`OpenAPI route inventory is empty for surface "${surface}".`);
  }

  const schemaRefs = collectSchemaRefs(inventory);
  const components: Record<string, SchemaObject> = {};
  for (const schemaRef of schemaRefs) {
    const schema = SCHEMA_BY_REF[schemaRef];
    if (!schema) {
      throw new Error(`Unknown schema reference: ${schemaRef}`);
    }
    components[schemaRef] = toJsonSchemaOrThrow(schemaRef, schema);
  }
  if (surface === "hosted_server") {
    applyHostedReadyResponseDocs(components.ReadyResponse);
  }

  const paths: OpenApiDocument["paths"] = {};

  for (const entry of [...inventory].sort(sortInventory)) {
    if (!SUPPORTED_CONTENT_KINDS.has(entry.success.contentKind)) {
      throw new Error(`Unsupported content kind for ${entry.method.toUpperCase()} ${entry.path}: ${entry.success.contentKind}`);
    }

    const openApiPath = toOpenApiPath(entry.path);
    const responses: Record<string, SchemaObject> = {
      [String(entry.success.status)]: buildSuccessResponse(entry),
      "400": jsonResponse("Invalid request", "HttpErrorEnvelope"),
      "404": jsonResponse("Not found", "HttpErrorEnvelope"),
      "409": jsonResponse("Conflict", "HttpErrorEnvelope"),
      "500": jsonResponse("Internal error", "HttpErrorEnvelope")
    };

    const operation: SchemaObject = {
      operationId: entry.operationId,
      tags: [...entry.tags, `surface:${entry.surface}`],
      summary: entry.summary,
      responses,
      "x-switchyard-error-envelope": entry.errorEnvelopeOwner,
      ...(entry.noRequestBody ? { "x-switchyard-no-body": true } : {})
    };

    if (entry.querySchemaRef) {
      operation["parameters"] = queryParametersForSchemaRef(entry.querySchemaRef, components[entry.querySchemaRef]);
    }

    if (entry.requestBody) {
      operation["requestBody"] = {
        required: entry.requestBody.required,
        content: {
          [entry.requestBody.contentType ?? "application/json"]: {
            schema: { $ref: `#/components/schemas/${entry.requestBody.schemaRef}` }
          }
        }
      };
    }

    if (entry.success.contentKind === "sse") {
      operation["x-switchyard-stream"] = { kind: "sse" };
    }
    if (entry.path === "/artifacts/:id/content") {
      operation["x-switchyard-content"] = {
        mode: "raw",
        supportsBinary: true
      };
    }
    if (surface === "hosted_server" && isHostedProtectedOperation(entry)) {
      operation["security"] = [{ SwitchyardApiKey: [] }];
    }
    if (surface === "hosted_server" && isHostedMetricsOperation(entry)) {
      operation["x-switchyard-required-scopes"] = ["metrics:read", "admin:read"];
    }

    if (!paths[openApiPath]) {
      paths[openApiPath] = {};
    }
    paths[openApiPath][entry.method] = operation;
  }

  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: surfaceSpec.title,
      version: "0.0.0"
    },
    servers: [{ url: surfaceSpec.serverUrl }],
    paths,
    components: {
      schemas: components,
      ...(surface === "hosted_server"
        ? {
            securitySchemes: {
              SwitchyardApiKey: {
                type: "http",
                scheme: "bearer",
                bearerFormat: "Switchyard API key",
                description: "Use Authorization: Bearer <switchyard_api_key> or x-switchyard-api-key."
              }
            }
          }
        : {})
    }
  };

  return stableObject(document) as OpenApiDocument;
}

export function renderOpenApiJson(document: OpenApiDocument): string {
  return `${JSON.stringify(stableObject(document), null, 2)}\n`;
}

function parseSurface(surface: OpenApiSurface | undefined): OpenApiSurface {
  if (surface === undefined) {
    return "local_daemon";
  }
  if (surface === "local_daemon" || surface === "hosted_server") {
    return surface;
  }
  throw new Error(`Unknown OpenAPI surface "${surface}". Expected one of: local_daemon, hosted_server.`);
}

function applyHostedReadyResponseDocs(schema: SchemaObject | undefined): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }

  schema["description"] =
    "Readiness checks keyed by subsystem name. Includes checks.schema with named Postgres schema compatibility codes.";
  schema["examples"] = [
    {
      ok: false,
      checks: {
        schema: {
          ok: false,
          code: "postgres_schema_migration_required",
          diagnostics: {
            currentVersion: 3,
            requiredVersion: 4,
            compatible: false
          }
        }
      }
    }
  ];
}

function isHostedProtectedOperation(entry: RouteInventoryEntry): boolean {
  if (entry.method === "get" && (entry.path === "/health" || entry.path === "/ready")) {
    return false;
  }
  return true;
}

function isHostedMetricsOperation(entry: RouteInventoryEntry): boolean {
  return entry.method === "get" && entry.path === "/metrics";
}

function collectSchemaRefs(inventory: readonly RouteInventoryEntry[]): Set<string> {
  const refs = new Set<string>(["HttpErrorEnvelope"]);
  for (const entry of inventory) {
    if (entry.success.schemaRef) refs.add(entry.success.schemaRef);
    if (entry.querySchemaRef) refs.add(entry.querySchemaRef);
    if (entry.requestBody?.schemaRef) refs.add(entry.requestBody.schemaRef);
  }
  return refs;
}

function queryParametersForSchemaRef(schemaRef: string, schemaObject: SchemaObject | undefined): SchemaObject[] {
  const schema = schemaObject;
  if (!schema) {
    throw new Error(`Missing schema object for query reference: ${schemaRef}`);
  }
  const type = schema["type"];
  const properties = schema["properties"];
  if (type !== "object" || !properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error(`Query schema ${schemaRef} must convert to an object with properties.`);
  }

  const requiredRaw = schema["required"];
  const requiredSet = new Set(Array.isArray(requiredRaw) ? requiredRaw.filter((entry): entry is string => typeof entry === "string") : []);

  return Object.entries(properties as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({
      name,
      in: "query",
      required: requiredSet.has(name),
      schema: stableObject(value)
    }));
}

function buildSuccessResponse(entry: RouteInventoryEntry): SchemaObject {
  if (entry.success.contentKind === "json") {
    return jsonResponse(entry.success.description, entry.success.schemaRef ?? "HealthResponse");
  }
  if (entry.success.contentKind === "sse") {
    return {
      description: entry.success.description,
      content: {
        "text/event-stream": {
          schema: { $ref: "#/components/schemas/SseEventStream" }
        }
      }
    };
  }
  if (entry.success.contentKind === "text") {
    return {
      description: entry.success.description,
      content: {
        [entry.success.contentType ?? "text/plain"]: {
          schema: { type: "string" }
        }
      }
    };
  }
  return {
    description: entry.success.description,
    content: {
      [entry.success.contentType ?? "application/octet-stream"]: {
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

function sortInventory(left: RouteInventoryEntry, right: RouteInventoryEntry): number {
  if (left.path === right.path) {
    return left.method.localeCompare(right.method);
  }
  return left.path.localeCompare(right.path);
}

function toJsonSchemaOrThrow(schemaRef: string, schema: z.ZodTypeAny): SchemaObject {
  try {
    return stableObject(z.toJSONSchema(schema)) as SchemaObject;
  } catch (error) {
    throw new Error(`Failed to convert schema ${schemaRef} to OpenAPI-compatible JSON schema: ${String(error)}`);
  }
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

export { LOCAL_DAEMON_ROUTE_INVENTORY, HOSTED_SERVER_ROUTE_INVENTORY, type RouteInventoryEntry };
