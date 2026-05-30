export type RouteMethod = "get" | "post" | "put";

export type ResponseContentKind = "json" | "sse" | "binary" | "text";

export type EndpointSurface = "local_daemon" | "hosted_node";

export interface RouteInventorySuccess {
  status: number;
  contentKind: ResponseContentKind;
  contentType?: string;
  schemaRef?: string;
  description: string;
}

export interface RouteInventoryRequestBody {
  schemaRef: string;
  required: boolean;
  contentType?: string;
}

export interface RouteInventoryEntry {
  surface: EndpointSurface;
  method: RouteMethod;
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  querySchemaRef?: string;
  requestBody?: RouteInventoryRequestBody;
  noRequestBody: boolean;
  success: RouteInventorySuccess;
  errorEnvelopeOwner: "contracts";
}

const LOCAL_SURFACE: EndpointSurface = "local_daemon";
const HOSTED_NODE_SURFACE: EndpointSurface = "hosted_node";

function withDefaults(entry: Omit<RouteInventoryEntry, "surface" | "errorEnvelopeOwner">): RouteInventoryEntry {
  return {
    surface: LOCAL_SURFACE,
    errorEnvelopeOwner: "contracts",
    ...entry
  };
}

function withHostedNodeDefaults(entry: Omit<RouteInventoryEntry, "surface" | "errorEnvelopeOwner">): RouteInventoryEntry {
  return {
    surface: HOSTED_NODE_SURFACE,
    errorEnvelopeOwner: "contracts",
    ...entry
  };
}

export const LOCAL_DAEMON_ROUTE_INVENTORY: readonly RouteInventoryEntry[] = [
  withDefaults({
    method: "get",
    path: "/health",
    operationId: "getHealth",
    summary: "Daemon health",
    tags: ["system"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "HealthResponse", description: "Health status" }
  }),
  withDefaults({
    method: "get",
    path: "/metrics",
    operationId: "getMetrics",
    summary: "Daemon metrics",
    tags: ["system"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "MetricsResponse", description: "Metrics snapshot" }
  }),

  withDefaults({
    method: "post",
    path: "/runs",
    operationId: "createRun",
    summary: "Create run",
    tags: ["runs"],
    querySchemaRef: "CreateRunQuery",
    requestBody: { schemaRef: "CreateRunRequest", required: true },
    noRequestBody: false,
    success: { status: 202, contentKind: "json", schemaRef: "CreateRunResponse", description: "Accepted run" }
  }),
  withDefaults({
    method: "get",
    path: "/runs",
    operationId: "listRuns",
    summary: "List runs",
    tags: ["runs"],
    querySchemaRef: "ListRunsQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ListRunsResponse", description: "Run list" }
  }),
  withDefaults({
    method: "get",
    path: "/runs/:id",
    operationId: "getRun",
    summary: "Get run",
    tags: ["runs"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "GetRunResponse", description: "Run details" }
  }),
  withDefaults({
    method: "get",
    path: "/runs/:id/events",
    operationId: "streamRunEvents",
    summary: "Replay or stream run events",
    tags: ["runs"],
    querySchemaRef: "EntityEventsQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "sse", schemaRef: "SseEventStream", description: "SSE run events" }
  }),
  withDefaults({
    method: "get",
    path: "/runs/:id/artifacts",
    operationId: "listRunArtifacts",
    summary: "List run artifacts",
    tags: ["runs"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ListRunArtifactsResponse", description: "Run artifacts" }
  }),
  withDefaults({
    method: "post",
    path: "/runs/:id/input",
    operationId: "sendRunInput",
    summary: "Send run input",
    tags: ["runs"],
    requestBody: { schemaRef: "SendRunInputRequest", required: true },
    noRequestBody: false,
    success: { status: 202, contentKind: "json", schemaRef: "AcceptedResponse", description: "Input accepted" }
  }),
  withDefaults({
    method: "post",
    path: "/runs/:id/cancel",
    operationId: "cancelRun",
    summary: "Cancel run",
    tags: ["runs"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "CancelRunResponse", description: "Updated run" }
  }),

  withDefaults({
    method: "get",
    path: "/providers",
    operationId: "listProviders",
    summary: "List providers",
    tags: ["registry"],
    querySchemaRef: "ListProvidersQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ListProvidersResponse", description: "Provider list" }
  }),
  withDefaults({
    method: "get",
    path: "/providers/:id",
    operationId: "getProvider",
    summary: "Get provider",
    tags: ["registry"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ProviderResponse", description: "Provider" }
  }),
  withDefaults({
    method: "get",
    path: "/runtimes",
    operationId: "listRuntimes",
    summary: "List runtimes",
    tags: ["registry"],
    querySchemaRef: "ListRuntimesQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ListRuntimesResponse", description: "Runtime list" }
  }),
  withDefaults({
    method: "get",
    path: "/runtimes/:id",
    operationId: "getRuntime",
    summary: "Get runtime",
    tags: ["registry"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "RuntimeResponse", description: "Runtime" }
  }),
  withDefaults({
    method: "get",
    path: "/models",
    operationId: "listModels",
    summary: "List models",
    tags: ["registry"],
    querySchemaRef: "ListModelsQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ListModelsResponse", description: "Model list" }
  }),
  withDefaults({
    method: "get",
    path: "/models/:id",
    operationId: "getModel",
    summary: "Get model",
    tags: ["registry"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ModelResponse", description: "Model" }
  }),
  withDefaults({
    method: "get",
    path: "/runtime-modes",
    operationId: "listRuntimeModes",
    summary: "List runtime modes",
    tags: ["registry"],
    querySchemaRef: "ListRuntimeModesQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ListRuntimeModesResponse", description: "Runtime mode list" }
  }),
  withDefaults({
    method: "get",
    path: "/runtime-modes/:id",
    operationId: "getRuntimeMode",
    summary: "Get runtime mode",
    tags: ["registry"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "RuntimeModeResponse", description: "Runtime mode" }
  }),
  withDefaults({
    method: "post",
    path: "/runtime-modes/:id/check",
    operationId: "checkRuntimeMode",
    summary: "Check runtime mode",
    tags: ["registry"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "RuntimeModeCheckResponse", description: "Runtime mode check" }
  }),
  withDefaults({
    method: "get",
    path: "/doctor",
    operationId: "doctorSummary",
    summary: "Doctor summary",
    tags: ["registry"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "DoctorSummaryResponse", description: "Doctor summary" }
  }),

  withDefaults({
    method: "get",
    path: "/artifacts/:id",
    operationId: "getArtifact",
    summary: "Get artifact metadata",
    tags: ["artifacts"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ArtifactResponse", description: "Artifact metadata" }
  }),
  withDefaults({
    method: "get",
    path: "/artifacts/:id/content",
    operationId: "getArtifactContent",
    summary: "Get artifact raw content",
    tags: ["artifacts"],
    noRequestBody: true,
    success: {
      status: 200,
      contentKind: "binary",
      contentType: "application/octet-stream",
      schemaRef: "RawArtifactContent",
      description: "Raw artifact content"
    }
  }),

  withDefaults({
    method: "post",
    path: "/messages",
    operationId: "createMessage",
    summary: "Create message",
    tags: ["middleware"],
    requestBody: { schemaRef: "CreateMessageRequest", required: true },
    noRequestBody: false,
    success: { status: 201, contentKind: "json", schemaRef: "MessageResponse", description: "Message created" }
  }),
  withDefaults({
    method: "get",
    path: "/messages",
    operationId: "listMessages",
    summary: "List messages",
    tags: ["middleware"],
    querySchemaRef: "ListMessagesQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ListMessagesResponse", description: "Message list" }
  }),
  withDefaults({
    method: "get",
    path: "/messages/:id",
    operationId: "getMessage",
    summary: "Get message",
    tags: ["middleware"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "MessageResponse", description: "Message" }
  }),

  withDefaults({
    method: "post",
    path: "/memory",
    operationId: "createMemory",
    summary: "Create memory",
    tags: ["middleware"],
    requestBody: { schemaRef: "CreateMemoryRequest", required: true },
    noRequestBody: false,
    success: { status: 201, contentKind: "json", schemaRef: "MemoryResponse", description: "Memory created" }
  }),
  withDefaults({
    method: "get",
    path: "/memory",
    operationId: "listMemory",
    summary: "List memory",
    tags: ["middleware"],
    querySchemaRef: "ListMemoryQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ListMemoryResponse", description: "Memory list" }
  }),
  withDefaults({
    method: "get",
    path: "/memory/search",
    operationId: "searchMemory",
    summary: "Search memory",
    tags: ["middleware"],
    querySchemaRef: "SearchMemoryQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ListMemoryResponse", description: "Memory search results" }
  }),
  withDefaults({
    method: "get",
    path: "/memory/:id",
    operationId: "getMemory",
    summary: "Get memory",
    tags: ["middleware"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "MemoryResponse", description: "Memory" }
  }),

  withDefaults({
    method: "post",
    path: "/evidence",
    operationId: "createEvidence",
    summary: "Create evidence",
    tags: ["middleware"],
    requestBody: { schemaRef: "CreateEvidenceRequest", required: true },
    noRequestBody: false,
    success: { status: 201, contentKind: "json", schemaRef: "EvidenceResponse", description: "Evidence created" }
  }),
  withDefaults({
    method: "get",
    path: "/evidence",
    operationId: "listEvidence",
    summary: "List evidence",
    tags: ["middleware"],
    querySchemaRef: "ListEvidenceQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ListEvidenceResponse", description: "Evidence list" }
  }),
  withDefaults({
    method: "get",
    path: "/evidence/:id",
    operationId: "getEvidence",
    summary: "Get evidence",
    tags: ["middleware"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "EvidenceResponse", description: "Evidence" }
  }),

  withDefaults({
    method: "post",
    path: "/context",
    operationId: "buildContext",
    summary: "Build context packet",
    tags: ["middleware"],
    requestBody: { schemaRef: "BuildContextRequest", required: true },
    noRequestBody: false,
    success: { status: 200, contentKind: "json", schemaRef: "ContextResponse", description: "Context packet" }
  }),

  withDefaults({
    method: "post",
    path: "/approvals",
    operationId: "createApproval",
    summary: "Create approval",
    tags: ["middleware"],
    requestBody: { schemaRef: "CreateApprovalRequest", required: true },
    noRequestBody: false,
    success: { status: 201, contentKind: "json", schemaRef: "ApprovalResponse", description: "Approval created" }
  }),
  withDefaults({
    method: "get",
    path: "/approvals",
    operationId: "listApprovals",
    summary: "List approvals",
    tags: ["middleware"],
    querySchemaRef: "ListApprovalsQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ListApprovalsResponse", description: "Approval list" }
  }),
  withDefaults({
    method: "get",
    path: "/approvals/:id",
    operationId: "getApproval",
    summary: "Get approval",
    tags: ["middleware"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ApprovalResponse", description: "Approval" }
  }),
  withDefaults({
    method: "post",
    path: "/approvals/:id/approve",
    operationId: "approveApproval",
    summary: "Approve",
    tags: ["middleware"],
    requestBody: { schemaRef: "ResolveApprovalRequest", required: true },
    noRequestBody: false,
    success: { status: 200, contentKind: "json", schemaRef: "ApprovalResolutionResponse", description: "Approval resolution" }
  }),
  withDefaults({
    method: "post",
    path: "/approvals/:id/reject",
    operationId: "rejectApproval",
    summary: "Reject",
    tags: ["middleware"],
    requestBody: { schemaRef: "ResolveApprovalRequest", required: true },
    noRequestBody: false,
    success: { status: 200, contentKind: "json", schemaRef: "ApprovalResolutionResponse", description: "Approval resolution" }
  }),

  withDefaults({
    method: "post",
    path: "/tools/invocations",
    operationId: "invokeTool",
    summary: "Invoke tool",
    tags: ["middleware"],
    requestBody: { schemaRef: "CreateToolInvocationRequest", required: true },
    noRequestBody: false,
    success: { status: 201, contentKind: "json", schemaRef: "ToolInvocationResponse", description: "Tool invocation result" }
  }),
  withDefaults({
    method: "get",
    path: "/tools/invocations",
    operationId: "listToolInvocations",
    summary: "List tool invocations",
    tags: ["middleware"],
    querySchemaRef: "ListToolInvocationsQuery",
    noRequestBody: true,
    success: {
      status: 200,
      contentKind: "json",
      schemaRef: "ListToolInvocationsResponse",
      description: "Tool invocation list"
    }
  }),
  withDefaults({
    method: "get",
    path: "/tools/invocations/:id",
    operationId: "getToolInvocation",
    summary: "Get tool invocation",
    tags: ["middleware"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "ToolInvocationResponse", description: "Tool invocation" }
  }),

  withDefaults({
    method: "post",
    path: "/debates",
    operationId: "createDebate",
    summary: "Create debate",
    tags: ["debate"],
    requestBody: { schemaRef: "CreateDebateRequest", required: true },
    querySchemaRef: "CreateDebateQuery",
    noRequestBody: false,
    success: { status: 202, contentKind: "json", schemaRef: "CreateDebateResponse", description: "Accepted debate" }
  }),
  withDefaults({
    method: "get",
    path: "/debates/:id",
    operationId: "getDebate",
    summary: "Get debate",
    tags: ["debate"],
    noRequestBody: true,
    success: { status: 200, contentKind: "json", schemaRef: "GetDebateResponse", description: "Debate details" }
  }),
  withDefaults({
    method: "get",
    path: "/debates/:id/events",
    operationId: "streamDebateEvents",
    summary: "Replay or stream debate events",
    tags: ["debate"],
    querySchemaRef: "EntityEventsQuery",
    noRequestBody: true,
    success: { status: 200, contentKind: "sse", schemaRef: "SseEventStream", description: "SSE debate events" }
  })
];

export const HOSTED_NODE_ROUTE_INVENTORY: readonly RouteInventoryEntry[] = [
  withHostedNodeDefaults({
    method: "post",
    path: "/nodes/register",
    operationId: "registerNode",
    summary: "Register node",
    tags: ["node"],
    requestBody: { schemaRef: "NodeRegisterRequest", required: true },
    noRequestBody: false,
    success: { status: 201, contentKind: "json", schemaRef: "NodeRegisterResponse", description: "Node registration response" }
  }),
  withHostedNodeDefaults({
    method: "post",
    path: "/nodes/:id/heartbeat",
    operationId: "heartbeatNode",
    summary: "Node heartbeat",
    tags: ["node"],
    requestBody: { schemaRef: "NodeHeartbeatRequest", required: true },
    noRequestBody: false,
    success: { status: 200, contentKind: "json", schemaRef: "NodeHeartbeatResponse", description: "Node heartbeat response" }
  }),
  withHostedNodeDefaults({
    method: "post",
    path: "/nodes/:id/assignments/claim",
    operationId: "claimNodeAssignment",
    summary: "Claim assignment",
    tags: ["node"],
    requestBody: { schemaRef: "AssignmentClaimRequest", required: false },
    noRequestBody: false,
    success: { status: 200, contentKind: "json", schemaRef: "AssignmentClaimResponse", description: "Assignment claim response" }
  }),
  withHostedNodeDefaults({
    method: "post",
    path: "/nodes/:id/assignments/:assignmentId/reject",
    operationId: "rejectNodeAssignment",
    summary: "Reject assignment",
    tags: ["node"],
    requestBody: { schemaRef: "AssignmentRejectRequest", required: true },
    noRequestBody: false,
    success: { status: 200, contentKind: "json", schemaRef: "AssignmentResponse", description: "Assignment response" }
  }),
  withHostedNodeDefaults({
    method: "post",
    path: "/nodes/:id/assignments/:assignmentId/events",
    operationId: "syncNodeAssignmentEvents",
    summary: "Sync assignment events",
    tags: ["node"],
    requestBody: { schemaRef: "AssignmentEventSyncRequest", required: true },
    noRequestBody: false,
    success: { status: 200, contentKind: "json", schemaRef: "AssignmentEventSyncResponse", description: "Event sync response" }
  }),
  withHostedNodeDefaults({
    method: "post",
    path: "/nodes/:id/assignments/:assignmentId/artifacts/manifest",
    operationId: "syncNodeAssignmentArtifactsManifest",
    summary: "Sync artifact manifest",
    tags: ["node"],
    requestBody: { schemaRef: "AssignmentArtifactManifestRequest", required: true },
    noRequestBody: false,
    success: { status: 200, contentKind: "json", schemaRef: "AssignmentArtifactManifestResponse", description: "Manifest sync response" }
  }),
  withHostedNodeDefaults({
    method: "put",
    path: "/nodes/:id/assignments/:assignmentId/artifacts/:artifactId/content",
    operationId: "syncNodeAssignmentArtifactContent",
    summary: "Sync artifact content",
    tags: ["node"],
    requestBody: { schemaRef: "RawArtifactContent", required: true, contentType: "application/octet-stream" },
    noRequestBody: false,
    success: { status: 200, contentKind: "json", schemaRef: "AssignmentArtifactContentResponse", description: "Artifact content sync response" }
  }),
  withHostedNodeDefaults({
    method: "post",
    path: "/nodes/:id/assignments/:assignmentId/complete",
    operationId: "completeNodeAssignment",
    summary: "Complete assignment",
    tags: ["node"],
    requestBody: { schemaRef: "AssignmentCompleteRequest", required: true },
    noRequestBody: false,
    success: { status: 200, contentKind: "json", schemaRef: "AssignmentResponse", description: "Assignment completion response" }
  })
];
