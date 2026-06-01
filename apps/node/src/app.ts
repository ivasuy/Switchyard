import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  Artifact,
  Assignment,
  AssignmentArtifactManifestRequest,
  NodePolicy,
  Run,
  SwitchyardEvent,
  ToolInvocation
} from "@switchyard/contracts";
import {
  fetchToolInputSchema,
  githubToolInputSchema,
  repoToolInputSchema,
  shellToolInputSchema,
  webSearchToolInputSchema
} from "@switchyard/contracts";
import { AdapterProtocolError, LocalNodePolicyService, type ToolAdapter } from "@switchyard/core";
import { NodeClient, NodeClientError } from "@switchyard/protocol-node";
import {
  buildNodeToolAdapters,
  type NodeToolAdapterConfig,
  type NodeToolAdapterDeps
} from "../../../packages/adapters/dist/index.js";
import type { NodeAppConfig } from "./config.js";

export interface NodeApp {
  start: () => Promise<void>;
  tick: () => Promise<boolean>;
  stop: () => Promise<void>;
}

export interface NodeExecutionArtifact {
  id: string;
  type: Artifact["type"];
  path: string;
  contentType: string;
  syncContent: boolean;
  bytes?: Buffer;
}

export interface NodeExecutionResult {
  events: SwitchyardEvent[];
  artifacts: NodeExecutionArtifact[];
  toolInvocation?: {
    output?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

export function createNodeApp(config: NodeAppConfig, deps?: {
  client?: NodeClient;
  executeAssignment?: (assignment: { id: string; run: Run }) => Promise<NodeExecutionResult>;
  executeToolAssignment?: (input: { assignment: Assignment; run: Run; toolInvocation: ToolInvocation }) => Promise<NodeExecutionResult>;
  toolAdapterDeps?: NodeToolAdapterDeps;
}): NodeApp {
  const clientOptions: ConstructorParameters<typeof NodeClient>[0] = {
    baseUrl: config.serverUrl
  };
  if (config.sharedToken !== undefined) {
    clientOptions.sharedToken = config.sharedToken;
  }
  const client = deps?.client ?? new NodeClient(clientOptions);
  const policy = new LocalNodePolicyService();
  const toolAdapters = buildNodeToolAdapters(buildNodeToolAdapterConfig(config), deps?.toolAdapterDeps);
  let nodeId = config.nodeId;
  let stopped = false;

  return {
    start: async () => {
      if (stopped) return;
      const registered = await client.register({
        id: nodeId,
        mode: "hybrid",
        capabilities: config.capabilities,
        policy: config.policy
      });
      nodeId = registered.node.id;
    },
    tick: async () => {
      if (stopped) return false;
      if (!nodeId) {
        await client.register({ id: config.nodeId, mode: "hybrid", capabilities: config.capabilities, policy: config.policy });
        return true;
      }

      await client.heartbeat(nodeId, { capabilities: config.capabilities, policy: config.policy });
      const claimed = await client.claim(nodeId);
      const assignment = claimed.assignment;
      const run = claimed.run;
      if (!assignment) {
        return false;
      }
      if (!run) {
        await client.reject(nodeId, assignment.id, { reason: "assignment_missing_run" });
        return true;
      }

      if (assignment.kind === "tool") {
        const toolInvocation = claimed.toolInvocation;
        if (!toolInvocation) {
          await client.reject(nodeId, assignment.id, { reason: "assignment_missing_tool_invocation" });
          return true;
        }
        const toolDecision = decideToolWithLocalPolicy(run, toolInvocation, config.policy);
        if (toolDecision.decision === "deny") {
          await client.complete(nodeId, assignment.id, {
            status: "failed",
            error: toolDecision.reasonCode,
            toolInvocation: {
              id: toolInvocation.id,
              status: "failed",
              error: {
                code: toolDecision.reasonCode,
                message: toolDecision.reasonCode
              },
              completedAt: new Date().toISOString()
            }
          });
          return true;
        }

        try {
          const execution = deps?.executeToolAssignment
            ? await deps.executeToolAssignment({ assignment, run, toolInvocation })
            : await executeToolAssignment({ assignment, run, toolInvocation }, {
              toolAdapters,
              nodePolicy: config.policy,
              nodeTools: config.tools
            });
          await syncExecutionArtifacts({
            client,
            nodeId,
            assignment,
            run,
            toolInvocation,
            execution,
            nodePolicy: config.policy
          });
          await client.complete(nodeId, assignment.id, {
            status: "completed",
            toolInvocation: {
              id: toolInvocation.id,
              status: "completed",
              ...(execution.toolInvocation?.output ? { output: execution.toolInvocation.output } : {}),
              completedAt: new Date().toISOString()
            }
          });
        } catch (error) {
          const reasonCode = extractReasonCode(error) ?? "tool_execution_failed";
          await client.complete(nodeId, assignment.id, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            toolInvocation: {
              id: toolInvocation.id,
              status: "failed",
              error: {
                code: reasonCode,
                message: error instanceof Error ? error.message : String(error)
              },
              completedAt: new Date().toISOString()
            }
          });
          if (error instanceof NodeClientError) {
            // Keep polling loop alive for transient transport failures.
          }
        }
        return true;
      }

      const decision = policy.decide(run, config.policy);
      if (decision.decision === "deny") {
        await client.reject(nodeId, assignment.id, { reason: "node_policy_denied" });
        return true;
      }

      try {
        const execution = deps?.executeAssignment
          ? await deps.executeAssignment({ id: assignment.id, run })
          : createDefaultExecution(run, assignment.lastEventSequence);

        await client.syncEvents(nodeId, assignment.id, {
          cursor: assignment.lastEventSequence,
          events: execution.events
        });
        await client.syncArtifactManifest(nodeId, assignment.id, {
          artifacts: toManifest(execution.artifacts)
        });
        for (const artifact of execution.artifacts) {
          if (!artifact.syncContent || !artifact.bytes) continue;
          await client.syncArtifactContent(nodeId, assignment.id, artifact.id, artifact.bytes);
        }
        await client.complete(nodeId, assignment.id, { status: "completed" });
      } catch (error) {
        await client.complete(nodeId, assignment.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
        if (error instanceof NodeClientError) {
          // Node client errors are explicit transport/protocol failures; keep the loop alive for retry.
        }
      }
      return true;
    },
    stop: async () => {
      stopped = true;
    }
  };
}

export async function executeToolAssignment(
  input: { assignment: Assignment; run: Run; toolInvocation: ToolInvocation },
  deps: {
    toolAdapters: Map<string, ToolAdapter>;
    nodePolicy: NodePolicy;
    nodeTools: NodeAppConfig["tools"];
  }
): Promise<NodeExecutionResult> {
  if (input.toolInvocation.type === "browser") {
    throw new AdapterProtocolError("Browser tool is not shipped on connected nodes", { reasonCode: "browser_tool_unshipped" });
  }
  const adapter = deps.toolAdapters.get(input.toolInvocation.type);
  if (!adapter) {
    throw new AdapterProtocolError(`Tool adapter unavailable for ${input.toolInvocation.type}`, { reasonCode: "tool_adapter_unavailable" });
  }
  const invokeInput = buildNodeOwnedInvokeInput(input.toolInvocation, deps.nodePolicy, deps.nodeTools);

  const callEvent: SwitchyardEvent = {
    id: `event_${randomUUID()}`,
    type: "tool.call",
    runId: input.run.id,
    sequence: input.assignment.lastEventSequence + 1,
    payload: {
      assignmentId: input.assignment.id,
      toolInvocationId: input.toolInvocation.id,
      toolType: input.toolInvocation.type
    },
    createdAt: new Date().toISOString()
  };

  const output = await adapter.invoke(invokeInput);
  const resultEvent: SwitchyardEvent = {
    id: `event_${randomUUID()}`,
    type: "tool.result",
    runId: input.run.id,
    sequence: input.assignment.lastEventSequence + 2,
    payload: {
      assignmentId: input.assignment.id,
      toolInvocationId: input.toolInvocation.id,
      toolType: input.toolInvocation.type,
      status: "completed",
      output
    },
    createdAt: new Date().toISOString()
  };
  return {
    events: [callEvent, resultEvent],
    artifacts: artifactCandidatesToExecutionArtifacts(input.run.id, input.toolInvocation.id, output),
    toolInvocation: {
      output
    }
  };
}

function createDefaultExecution(run: Run, baseSequence: number): NodeExecutionResult {
  const outputText = `[node-exec] completed ${run.runtimeMode ?? run.runtime}`;
  const outputEvent: SwitchyardEvent = {
    id: `event_${randomUUID()}`,
    type: "runtime.output",
    runId: run.id,
    sequence: baseSequence + 1,
    payload: { text: outputText },
    createdAt: new Date().toISOString()
  };
  const bytes = Buffer.from(JSON.stringify(outputEvent) + "\n", "utf8");
  const artifact: NodeExecutionArtifact = {
    id: `artifact_${randomUUID()}`,
    type: "transcript",
    path: `runs/${run.id}/node-transcript.jsonl`,
    contentType: "application/x-ndjson",
    syncContent: true,
    bytes
  };
  return {
    events: [outputEvent],
    artifacts: [artifact]
  };
}

function toManifest(artifacts: NodeExecutionArtifact[]): AssignmentArtifactManifestRequest["artifacts"] {
  return artifacts.map((artifact) => {
    const bytes = artifact.bytes ?? Buffer.alloc(0);
    return {
      id: artifact.id,
      type: artifact.type,
      path: artifact.path,
      contentType: artifact.contentType,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      syncContent: artifact.syncContent
    };
  });
}

function buildNodeToolAdapterConfig(config: NodeAppConfig): NodeToolAdapterConfig {
  return {
    placement: "connected_local_node",
    fetch: {},
    webSearch: {},
    github: {
      ...(config.tools.githubToken ? { token: config.tools.githubToken } : {})
    },
    repo: {
      gitBinary: config.tools.gitBinary
    },
    shell: {
      catalog: config.tools.shellCatalog
    }
  };
}

const NODE_TOOL_LIMITS = {
  timeoutMs: 30_000,
  maxInlineOutputBytes: 32_768,
  maxArtifactBytes: 1_048_576,
  fetchMaxResponseBytes: 128_000,
  webSearchMaxResults: 8,
  webSearchMaxResponseBytes: 64_000,
  githubMaxResponseBytes: 128_000,
  repoMaxOutputBytes: 262_144
} as const;

function buildNodeOwnedInvokeInput(
  toolInvocation: ToolInvocation,
  nodePolicy: NodePolicy,
  nodeTools: NodeAppConfig["tools"]
): Record<string, unknown> {
  const request = asRecord(toolInvocation.input["request"]) ?? {};
  if (toolInvocation.type === "fake_echo") {
    return request;
  }

  switch (toolInvocation.type) {
    case "fetch":
      return { request, executionPlan: deriveFetchExecutionPlan(request) };
    case "web_search":
      return { request, executionPlan: deriveWebSearchExecutionPlan(request) };
    case "github":
      return { request, executionPlan: deriveGithubExecutionPlan(request) };
    case "repo":
      return { request, executionPlan: deriveRepoExecutionPlan(request, nodePolicy, nodeTools) };
    case "shell":
      return { request, executionPlan: deriveShellExecutionPlan(request, nodePolicy, nodeTools) };
    default:
      throw new AdapterProtocolError("Tool type is not supported on connected node", { reasonCode: "tool_adapter_unavailable" });
  }
}

function deriveFetchExecutionPlan(request: Record<string, unknown>): Record<string, unknown> {
  const parsed = fetchToolInputSchema.safeParse(request);
  if (!parsed.success) {
    throw new AdapterProtocolError("Fetch input is invalid", { reasonCode: "fetch_input_invalid" });
  }
  const url = new URL(parsed.data.url);
  return {
    type: "fetch",
    method: parsed.data.method,
    url: url.toString(),
    allowedHosts: [url.hostname.toLowerCase()],
    allowedHeaders: [],
    maxRedirects: 3,
    allowedContentTypes: ["text/plain", "application/json", "text/html"],
    captureContent: parsed.data.captureContent ?? false,
    timeoutMs: NODE_TOOL_LIMITS.timeoutMs,
    maxResponseBytes: NODE_TOOL_LIMITS.fetchMaxResponseBytes,
    maxInlineOutputBytes: NODE_TOOL_LIMITS.maxInlineOutputBytes,
    maxArtifactBytes: NODE_TOOL_LIMITS.maxArtifactBytes
  };
}

function deriveWebSearchExecutionPlan(request: Record<string, unknown>): Record<string, unknown> {
  const parsed = webSearchToolInputSchema.safeParse(request);
  if (!parsed.success) {
    throw new AdapterProtocolError("Search query is invalid", { reasonCode: "web_search_query_invalid" });
  }
  return {
    type: "web_search",
    providerId: "node_owned_provider",
    baseUrl: "https://node-owned.invalid/search",
    query: parsed.data.query,
    maxResults: Math.min(parsed.data.maxResults ?? NODE_TOOL_LIMITS.webSearchMaxResults, NODE_TOOL_LIMITS.webSearchMaxResults),
    timeoutMs: NODE_TOOL_LIMITS.timeoutMs,
    maxResponseBytes: NODE_TOOL_LIMITS.webSearchMaxResponseBytes,
    maxInlineOutputBytes: NODE_TOOL_LIMITS.maxInlineOutputBytes,
    maxArtifactBytes: NODE_TOOL_LIMITS.maxArtifactBytes
  };
}

function deriveGithubExecutionPlan(request: Record<string, unknown>): Record<string, unknown> {
  const parsed = githubToolInputSchema.safeParse(request);
  if (!parsed.success) {
    throw new AdapterProtocolError("GitHub operation is denied", { reasonCode: "github_operation_denied" });
  }
  return {
    type: "github",
    operation: parsed.data.operation,
    owner: parsed.data.owner,
    repo: parsed.data.repo,
    ...(parsed.data.number !== undefined ? { number: parsed.data.number } : {}),
    ...(parsed.data.ref !== undefined ? { ref: parsed.data.ref } : {}),
    ...(parsed.data.base !== undefined ? { base: parsed.data.base } : {}),
    ...(parsed.data.head !== undefined ? { head: parsed.data.head } : {}),
    ...(parsed.data.path !== undefined ? { path: parsed.data.path } : {}),
    timeoutMs: NODE_TOOL_LIMITS.timeoutMs,
    maxResponseBytes: NODE_TOOL_LIMITS.githubMaxResponseBytes,
    maxInlineOutputBytes: NODE_TOOL_LIMITS.maxInlineOutputBytes,
    maxArtifactBytes: NODE_TOOL_LIMITS.maxArtifactBytes
  };
}

function deriveRepoExecutionPlan(
  request: Record<string, unknown>,
  nodePolicy: NodePolicy,
  nodeTools: NodeAppConfig["tools"]
): Record<string, unknown> {
  const parsed = repoToolInputSchema.safeParse(request);
  if (!parsed.success) {
    throw new AdapterProtocolError("Repo operation is denied", { reasonCode: "repo_operation_denied" });
  }
  const cwd = resolve(parsed.data.cwd);
  const allowedPrefixes = nodePolicy.allowToolCwdPrefixes.length > 0
    ? nodePolicy.allowToolCwdPrefixes
    : nodePolicy.allowCwdPrefixes;
  if (!isPathWithinPrefixes(cwd, allowedPrefixes)) {
    throw new AdapterProtocolError("Repo cwd denied by node policy", { reasonCode: "repo_cwd_denied" });
  }
  const pathspec = parsed.data.pathspec ?? [];
  return {
    type: "repo",
    operation: parsed.data.operation,
    cwd,
    cwdPolicySummary: summarizePrefix(cwd, allowedPrefixes),
    gitBinary: nodeTools.gitBinary,
    argv: buildRepoArgv(parsed.data.operation, pathspec),
    pathspec,
    timeoutMs: NODE_TOOL_LIMITS.timeoutMs,
    maxOutputBytes: NODE_TOOL_LIMITS.repoMaxOutputBytes,
    maxInlineOutputBytes: NODE_TOOL_LIMITS.maxInlineOutputBytes,
    maxArtifactBytes: NODE_TOOL_LIMITS.maxArtifactBytes
  };
}

function deriveShellExecutionPlan(
  request: Record<string, unknown>,
  nodePolicy: NodePolicy,
  nodeTools: NodeAppConfig["tools"]
): Record<string, unknown> {
  for (const forbidden of ["command", "shell", "executablePath", "env", "pty", "terminal", "process"]) {
    if (forbidden in request) {
      throw new AdapterProtocolError("Shell command denied", { reasonCode: "shell_command_denied" });
    }
  }
  const parsed = shellToolInputSchema.safeParse(request);
  if (!parsed.success) {
    throw new AdapterProtocolError("Shell command is not configured", { reasonCode: "shell_command_not_configured" });
  }
  const command = nodeTools.shellCatalog[parsed.data.commandId];
  if (!command) {
    throw new AdapterProtocolError("Shell command is not configured", { reasonCode: "shell_command_not_configured" });
  }
  const cwd = resolve(parsed.data.cwd);
  const allowedPrefixes = nodePolicy.allowToolCwdPrefixes.length > 0
    ? nodePolicy.allowToolCwdPrefixes
    : nodePolicy.allowCwdPrefixes;
  if (!isPathWithinPrefixes(cwd, allowedPrefixes)) {
    throw new AdapterProtocolError("Repo cwd denied by node policy", { reasonCode: "repo_cwd_denied" });
  }
  return {
    type: "shell",
    commandId: parsed.data.commandId,
    executablePath: command.executablePath,
    argv: [...command.fixedArgs, ...(parsed.data.args ?? [])],
    cwd,
    cwdPolicySummary: summarizePrefix(cwd, allowedPrefixes),
    env: { ...command.env },
    timeoutMs: Math.min(command.timeoutMs, NODE_TOOL_LIMITS.timeoutMs),
    maxOutputBytes: command.maxOutputBytes,
    maxInlineOutputBytes: NODE_TOOL_LIMITS.maxInlineOutputBytes,
    maxArtifactBytes: NODE_TOOL_LIMITS.maxArtifactBytes
  };
}

async function syncExecutionArtifacts(input: {
  client: NodeClient;
  nodeId: string;
  assignment: Assignment;
  run: Run;
  toolInvocation: ToolInvocation;
  execution: NodeExecutionResult;
  nodePolicy: NodePolicy;
}): Promise<void> {
  const { client, nodeId, assignment, execution, toolInvocation, run, nodePolicy } = input;
  await client.syncEvents(nodeId, assignment.id, {
    cursor: assignment.lastEventSequence,
    events: execution.events
  });

  for (const artifact of execution.artifacts) {
    const syncIntent: { syncContent?: boolean; artifactBytes?: number } = {
      syncContent: artifact.syncContent
    };
    if (artifact.bytes) {
      syncIntent.artifactBytes = artifact.bytes.byteLength;
    }
    const decision = decideToolWithLocalPolicy(run, toolInvocation, nodePolicy, syncIntent);
    if (decision.decision === "deny") {
      throw new AdapterProtocolError("Node tool artifact policy denied", { reasonCode: decision.reasonCode });
    }
  }

  await client.syncArtifactManifest(nodeId, assignment.id, {
    artifacts: toManifest(execution.artifacts)
  });
  for (const artifact of execution.artifacts) {
    if (!artifact.syncContent || !artifact.bytes) continue;
    await client.syncArtifactContent(nodeId, assignment.id, artifact.id, artifact.bytes);
  }
}

function artifactCandidatesToExecutionArtifacts(
  runId: string,
  invocationId: string,
  output: Record<string, unknown>
): NodeExecutionArtifact[] {
  const candidates = Array.isArray(output["artifactCandidates"])
    ? output["artifactCandidates"].filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    : [];
  return candidates.map((candidate) => {
    const logicalPath = typeof candidate["logicalPath"] === "string" ? candidate["logicalPath"] : "output.log";
    const content = typeof candidate["content"] === "string" ? candidate["content"] : "";
    const contentType = typeof candidate["contentType"] === "string" ? candidate["contentType"] : "text/plain";
    return {
      id: `artifact_${randomUUID()}`,
      type: "raw_log",
      path: `runs/${runId}/tools/${invocationId}/${sanitizeArtifactName(logicalPath)}`,
      contentType,
      syncContent: true,
      bytes: Buffer.from(content, "utf8")
    };
  });
}

function sanitizeArtifactName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._/-]+/g, "_").replace(/^\/+/, "");
  if (normalized.length === 0) {
    return "artifact.log";
  }
  return normalized.slice(0, 128);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractReasonCode(error: unknown): string | undefined {
  const candidate = error as { reasonCode?: unknown; details?: unknown };
  if (typeof candidate.reasonCode === "string" && candidate.reasonCode.length > 0) {
    return candidate.reasonCode;
  }
  const details = asRecord(candidate.details);
  if (details && typeof details["reasonCode"] === "string") {
    return details["reasonCode"];
  }
  const nested = asRecord((error as { cause?: unknown })?.cause);
  if (nested && typeof nested["reasonCode"] === "string") {
    return nested["reasonCode"];
  }
  return undefined;
}

function decideToolWithLocalPolicy(
  run: Run,
  toolInvocation: ToolInvocation,
  policy: NodePolicy,
  syncIntent?: { syncContent?: boolean; artifactBytes?: number }
): { decision: "allow" | "deny"; reasonCode: string } {
  if (!run.runtimeMode || !policy.allowRuntimeModes.includes(run.runtimeMode)) {
    return { decision: "deny", reasonCode: "node_policy_denied" };
  }
  if (toolInvocation.type === "browser") {
    return { decision: "deny", reasonCode: "browser_tool_unshipped" };
  }
  if (policy.allowToolTypes.length > 0 && !policy.allowToolTypes.includes(toolInvocation.type)) {
    return { decision: "deny", reasonCode: "node_policy_denied" };
  }
  const request = asRecord(toolInvocation.input["request"]);
  const cwd = typeof request?.["cwd"] === "string" ? request["cwd"] : undefined;
  if (toolInvocation.type === "repo" || toolInvocation.type === "shell") {
    const allowToolCwdPrefixes = policy.allowToolCwdPrefixes.length > 0
      ? policy.allowToolCwdPrefixes
      : policy.allowCwdPrefixes;
    if (!cwd || allowToolCwdPrefixes.length === 0 || !allowToolCwdPrefixes.some((prefix) => cwd.startsWith(prefix))) {
      return { decision: "deny", reasonCode: "node_policy_denied" };
    }
  }
  if (toolInvocation.type === "shell" && request) {
    for (const forbidden of ["command", "shell", "executablePath", "env", "pty", "terminal", "process"]) {
      if (forbidden in request) {
        return { decision: "deny", reasonCode: "shell_command_denied" };
      }
    }
  }
  if (policy.toolArtifactSync === "metadata_only" && syncIntent?.syncContent) {
    return { decision: "deny", reasonCode: "node_policy_denied" };
  }
  if (policy.toolArtifactSync === "none" && (syncIntent?.syncContent || syncIntent?.artifactBytes !== undefined)) {
    return { decision: "deny", reasonCode: "node_policy_denied" };
  }
  if (
    policy.maxToolArtifactBytes !== undefined &&
    syncIntent?.artifactBytes !== undefined &&
    syncIntent.artifactBytes > policy.maxToolArtifactBytes
  ) {
    return { decision: "deny", reasonCode: "node_policy_denied" };
  }
  return { decision: "allow", reasonCode: "allow" };
}

function isPathWithinPrefixes(path: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) {
    return false;
  }
  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizePrefix(prefix);
    return `${path}/`.startsWith(normalizedPrefix);
  });
}

function normalizePrefix(prefix: string): string {
  const normalized = resolve(prefix);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function summarizePrefix(path: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    if (isPathWithinPrefixes(path, [prefix])) {
      return prefix;
    }
  }
  return "[none]";
}

function buildRepoArgv(operation: "status" | "diff" | "show" | "ls_files" | "grep", pathspec: string[]): string[] {
  switch (operation) {
    case "status":
      return ["status", "--short", "--branch"];
    case "diff":
      return pathspec.length > 0 ? ["diff", "--", ...pathspec] : ["diff"];
    case "show":
      return pathspec.length > 0 ? ["show", "--", ...pathspec] : ["show", "--stat", "--no-patch"];
    case "ls_files":
      return pathspec.length > 0 ? ["ls-files", "--", ...pathspec] : ["ls-files"];
    case "grep":
      return pathspec.length > 0 ? ["grep", "-n", "--", ...pathspec] : ["grep", "-n", "."];
    default:
      return ["status"];
  }
}
