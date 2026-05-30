export type RouteMethod = "get" | "post";

export type ResponseContentKind = "json" | "sse" | "binary" | "text";

export interface RouteInventorySuccess {
  status: number;
  contentKind: ResponseContentKind;
  schemaRef?: string;
}

export interface RouteInventoryEntry {
  method: RouteMethod;
  path: string;
  summary: string;
  tags: string[];
  success: RouteInventorySuccess;
}

export const LOCAL_DAEMON_ROUTE_INVENTORY: readonly RouteInventoryEntry[] = [
  { method: "get", path: "/health", summary: "Daemon health", tags: ["system"], success: { status: 200, contentKind: "json", schemaRef: "HealthResponse" } },
  { method: "get", path: "/metrics", summary: "Daemon metrics", tags: ["system"], success: { status: 200, contentKind: "json", schemaRef: "MetricsResponse" } },

  { method: "post", path: "/runs", summary: "Create run", tags: ["runs"], success: { status: 202, contentKind: "json", schemaRef: "CreateRunResponse" } },
  { method: "get", path: "/runs", summary: "List runs", tags: ["runs"], success: { status: 200, contentKind: "json", schemaRef: "ListRunsResponse" } },
  { method: "get", path: "/runs/:id", summary: "Get run", tags: ["runs"], success: { status: 200, contentKind: "json", schemaRef: "GetRunResponse" } },
  { method: "get", path: "/runs/:id/events", summary: "Replay or stream run events", tags: ["runs"], success: { status: 200, contentKind: "sse", schemaRef: "SseEventStream" } },
  { method: "get", path: "/runs/:id/artifacts", summary: "List run artifacts", tags: ["runs"], success: { status: 200, contentKind: "json", schemaRef: "ListRunArtifactsResponse" } },
  { method: "post", path: "/runs/:id/input", summary: "Send run input", tags: ["runs"], success: { status: 202, contentKind: "json", schemaRef: "AcceptedResponse" } },
  { method: "post", path: "/runs/:id/cancel", summary: "Cancel run", tags: ["runs"], success: { status: 200, contentKind: "json", schemaRef: "CancelRunResponse" } },

  { method: "get", path: "/providers", summary: "List providers", tags: ["registry"], success: { status: 200, contentKind: "json", schemaRef: "ListProvidersResponse" } },
  { method: "get", path: "/providers/:id", summary: "Get provider", tags: ["registry"], success: { status: 200, contentKind: "json", schemaRef: "ProviderResponse" } },
  { method: "get", path: "/runtimes", summary: "List runtimes", tags: ["registry"], success: { status: 200, contentKind: "json", schemaRef: "ListRuntimesResponse" } },
  { method: "get", path: "/runtimes/:id", summary: "Get runtime", tags: ["registry"], success: { status: 200, contentKind: "json", schemaRef: "RuntimeResponse" } },
  { method: "get", path: "/models", summary: "List models", tags: ["registry"], success: { status: 200, contentKind: "json", schemaRef: "ListModelsResponse" } },
  { method: "get", path: "/models/:id", summary: "Get model", tags: ["registry"], success: { status: 200, contentKind: "json", schemaRef: "ModelResponse" } },
  { method: "get", path: "/runtime-modes", summary: "List runtime modes", tags: ["registry"], success: { status: 200, contentKind: "json", schemaRef: "ListRuntimeModesResponse" } },
  { method: "get", path: "/runtime-modes/:id", summary: "Get runtime mode", tags: ["registry"], success: { status: 200, contentKind: "json", schemaRef: "RuntimeModeResponse" } },
  { method: "post", path: "/runtime-modes/:id/check", summary: "Check runtime mode", tags: ["registry"], success: { status: 200, contentKind: "json", schemaRef: "RuntimeModeCheckResponse" } },
  { method: "get", path: "/doctor", summary: "Doctor summary", tags: ["registry"], success: { status: 200, contentKind: "json", schemaRef: "DoctorSummaryResponse" } },

  { method: "get", path: "/artifacts/:id", summary: "Get artifact metadata", tags: ["artifacts"], success: { status: 200, contentKind: "json", schemaRef: "ArtifactResponse" } },
  { method: "get", path: "/artifacts/:id/content", summary: "Get artifact raw content", tags: ["artifacts"], success: { status: 200, contentKind: "binary" } },

  { method: "post", path: "/messages", summary: "Create message", tags: ["middleware"], success: { status: 201, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/messages", summary: "List messages", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/messages/:id", summary: "Get message", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },

  { method: "post", path: "/memory", summary: "Create memory", tags: ["middleware"], success: { status: 201, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/memory", summary: "List memory", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/memory/search", summary: "Search memory", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/memory/:id", summary: "Get memory", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },

  { method: "post", path: "/evidence", summary: "Create evidence", tags: ["middleware"], success: { status: 201, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/evidence", summary: "List evidence", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/evidence/:id", summary: "Get evidence", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },

  { method: "post", path: "/context", summary: "Build context packet", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },

  { method: "post", path: "/approvals", summary: "Create approval", tags: ["middleware"], success: { status: 201, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/approvals", summary: "List approvals", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/approvals/:id", summary: "Get approval", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "post", path: "/approvals/:id/approve", summary: "Approve", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "post", path: "/approvals/:id/reject", summary: "Reject", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },

  { method: "post", path: "/tools/invocations", summary: "Invoke tool", tags: ["middleware"], success: { status: 201, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/tools/invocations", summary: "List tool invocations", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/tools/invocations/:id", summary: "Get tool invocation", tags: ["middleware"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },

  { method: "post", path: "/debates", summary: "Create debate", tags: ["debate"], success: { status: 202, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/debates/:id", summary: "Get debate", tags: ["debate"], success: { status: 200, contentKind: "json", schemaRef: "ObjectResponse" } },
  { method: "get", path: "/debates/:id/events", summary: "Replay or stream debate events", tags: ["debate"], success: { status: 200, contentKind: "sse", schemaRef: "SseEventStream" } }
];
