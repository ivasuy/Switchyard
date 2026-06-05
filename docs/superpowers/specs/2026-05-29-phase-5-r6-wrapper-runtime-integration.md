# Phase 5 Spec: R6 Wrapper Runtime Integration

Date: 2026-05-29

Roadmap release: R6: Wrapper Runtime Integration

Branch: `agent/phase-5-r6-wrapper-runtime-integration`

Previous phase head: `agent/phase-4-r5-acp-foundation-and-opencode` at `a1dca08d66bb0222bacd7e790d6ea5ec705db45d`

Spec target: `docs/superpowers/specs/2026-05-29-phase-5-r6-wrapper-runtime-integration.md`

## Summary

R6 proves Switchyard can coordinate a real wrapper runtime through AgentField, not only local CLIs or a generic fake HTTP contract. After this release, a configured AgentField target can be launched as a normal Switchyard run, using async REST create and polling semantics, with normalized run events, visible failure mapping, wrapper execution metadata, doctor reporting, and retrievable wrapper result artifacts.

This release intentionally stays narrow. AgentField must plug into the existing runtime-mode, doctor, runner, event, and artifact paths. It must not become a second Switchyard control plane, and it must not broaden Switchyard into OpenClaw, Paperclip, hosted workers, debate orchestration, memory, approvals, tool routing, SDK, CLI, dashboard, or TUI product work.

## Scope Gate

In scope:

- AgentField adapter using async REST execution.
- Runtime mode `agentfield.async_rest` with manifest, registry seeding, runtime-mode inference, doctor/check, and daemon config.
- Async create-execution, poll/status, result normalization, and visible failure mapping.
- Wrapper execution metadata preserved in normalized events and artifacts.
- AgentField result payload artifact storage through the existing artifact content path.
- AgentField transcript artifact with sanitized HTTP request/status summaries.
- Public unsupported-input and unsupported-cancel behavior with named `409 adapter_protocol_failed` reason codes.
- Deterministic fake AgentField control-plane server for CI and local verification.
- Optional manual real AgentField smoke path that requires explicit local configuration and warns about possible model spend.
- Docs updates during implementation closeout for `PRODUCT.md`, `CHANGELOG.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, `docs/development/adapters/README.md`, and new `docs/development/adapters/AGENTFIELD.md`.

Out of scope:

- OpenClaw and Paperclip.
- Hosted worker execution, hosted-safe queueing, or connected local node behavior.
- Debate orchestration.
- Webhook callbacks from AgentField into Switchyard.
- AgentField memory, admin, node lifecycle, permissions, approval, DID, policy, or Agentic API orchestration as Switchyard product surfaces.
- Dynamic per-run AgentField base URL, target discovery as execution routing, arbitrary header forwarding, or arbitrary endpoint maps.
- Switchyard SDK/CLI/TUI/dashboard work.
- Broad tool, memory, approval, policy, browser, or search expansion.
- Treating AgentField as Switchyard's internal scheduler or source of truth for Switchyard runs.

## External Protocol References

This spec uses AgentField's public docs as protocol context and pins Switchyard behavior to the acceptance criteria here:

- AgentField REST API reference: `https://agentfield.ai/docs/reference/sdks/rest-api`
- AgentField REST overview: `https://agentfield.ai/api/rest-api/overview`
- AgentField async execution: `https://agentfield.ai/api/rest-api/async-execution`
- AgentField agent discovery: `https://agentfield.ai/api/rest-api/agent-discovery`
- AgentField health and metrics: `https://agentfield.ai/api/rest-api/health-monitoring`

Facts from those docs that matter for R6:

- Agent-facing endpoints live under `/api/v1`, and request/response bodies are JSON.
- Most control-plane endpoints use `Authorization: Bearer <api key>`.
- Async execution queues work through `POST /api/v1/execute/async/{target}` and returns an execution id.
- Polling status and results uses `GET /api/v1/executions/{execution_id}`.
- Status values include queued/pending/running and terminal succeeded/failed/cancelled/timeout.
- Health is available at `/api/v1/health`; metrics exist at `/metrics`, but Switchyard does not scrape metrics in R6.
- Discovery can expose invocation targets, but R6 uses discovery only as an optional doctor diagnostic, not as runtime routing.

No AgentField cancellation endpoint is treated as verified for R6. AgentField may expose lifecycle operations now or later, but this release must not claim verified upstream cancellation until an endpoint is explicitly implemented and tested in a later spec.

## Existing Context

This spec is based on the R5 code in this worktree after `a1dca08`, not on target architecture alone.

`docs/adapters/agentfield.md` records the local adapter research state R6 must convert into shipped product behavior:

```md
## Preferred Protocol

- Primary: async REST execution flow.
- Secondary: CLI-backed integration for local verification.

## Verified Local Facts

- CLI: `/Users/vasuyadav/.agentfield/bin/af`
- Version: `0.1.77`
- CLI help and async REST shape were checked.
```

`packages/core/src/ports/runtime-adapter.ts` is still the adapter lifecycle boundary. AgentField must implement this interface and must not add a provider-specific runner:

```ts
export interface RuntimeAdapter {
  readonly id: string;
  readonly manifest: RuntimeAdapterManifest;
  check(config?: Record<string, unknown>): Promise<RuntimeAdapterCheck>;
  start(request: Record<string, unknown>): Promise<RuntimeStartResult>;
  send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void>;
  cancel(session: Record<string, unknown>): Promise<void>;
  events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent>;
  tools(session: Record<string, unknown>): Promise<string[]>;
  artifacts(session: Record<string, unknown>): Promise<Artifact[]>;
}
```

`packages/contracts/src/registry.ts` already has the mode kind and auth capability AgentField needs:

```ts
export const runtimeModeKindSchema = z.enum([
  "deterministic_fake",
  "one_shot_process",
  "interactive_process",
  "pty",
  "acp",
  "sdk",
  "sync_http",
  "async_rest",
  "browser_backed"
]);

export const runtimeCapabilitySchema = z.enum([
  "run.start",
  "run.cancel",
  "run.timeout",
  "event.normalized",
  "event.streaming",
  "artifact.transcript",
  "artifact.raw_transcript",
  "model.catalog",
  "tool.fake_echo",
  "auth.none",
  "auth.local",
  "auth.api_key",
  "sandbox.read_only",
  "sandbox.workspace_write",
  "sandbox.danger_full_access"
]);
```

`packages/adapters/src/generic-http/generic-http-adapter.ts` is the nearest shipped wrapper adapter. AgentField should reuse the same conventions for manifest shape, bounded HTTP calls, sanitized transcripts, and adapter protocol errors:

```ts
readonly manifest: RuntimeAdapterManifest = {
  adapterId: "generic_http",
  providerId: "provider_generic_http",
  runtimeId: "runtime_generic_http",
  runtimeModeId: "runtime_mode_generic_http_async_rest",
  runtimeModeSlug: GENERIC_HTTP_RUNTIME_MODE_SLUG,
  name: "Generic HTTP async REST",
  adapterType: "http",
  kind: "async_rest",
  capabilities: [
    "run.start",
    "run.cancel",
    "run.timeout",
    "event.normalized",
    "event.streaming",
    "artifact.transcript",
    "auth.none",
    "auth.api_key"
  ],
```

`apps/daemon/src/config.ts` currently has daemon-level Generic HTTP and OpenCode config. R6 must add AgentField here, not to per-run metadata:

```ts
genericHttp: {
  ...(baseUrl && baseUrl.length > 0 ? { baseUrl } : {}),
  ...(authToken && authToken.length > 0 ? { authToken } : {}),
  requestTimeoutMs: Number(env["SWITCHYARD_GENERIC_HTTP_REQUEST_TIMEOUT_MS"] ?? 5000),
  pollIntervalMs: Number(env["SWITCHYARD_GENERIC_HTTP_POLL_INTERVAL_MS"] ?? 100),
  maxResponseBytes: Number(env["SWITCHYARD_GENERIC_HTTP_MAX_RESPONSE_BYTES"] ?? 1024 * 1024)
}
```

`packages/core/src/services/registry-service.ts` is the only current public runtime-mode inference point. R6 adds exactly one inference there:

```ts
if (input.runtime === "opencode" && input.adapterType === "acpx") {
  return "opencode.acp";
}
return undefined;
```

`packages/core/src/services/runtime-runner-service.ts` already owns terminalization and artifact content persistence. AgentField artifacts must use the same `metadata.content` handoff:

```ts
const content = typeof artifact.metadata["content"] === "string" ? artifact.metadata["content"] : undefined;
const hasContent = content !== undefined;
const metadata = { ...artifact.metadata };
delete metadata.content;

let storedPath = safePath;
let contentStored = false;
if (hasContent && this.deps.artifactContent) {
  storedPath = await this.deps.artifactContent.writeText(safePath, content);
  contentStored = true;
}
```

`packages/testkit/src/fake-http-runtime-server.ts` is the model for a deterministic fake wrapper server. R6 should add a separate fake AgentField server instead of overloading Generic HTTP:

```ts
app.post("/v1/runs", async (_request, reply) => {
  const externalRunId = `ext_run_${++idCounter}`;
  runs.set(externalRunId, {
    externalRunId,
    cancelCount: 0,
    cancelled: false
  });
  return reply.send({
    externalRunId,
    status: "running"
  });
});
```

## Product Terms

AgentField control plane:

- A configured external or local AgentField HTTP service.
- It is the upstream wrapper runtime for one configured target, not Switchyard's control plane.

AgentField target:

- A string such as `research-agent.deep_analysis` accepted by AgentField's async execution endpoint.
- R6 requires one daemon-level target through `SWITCHYARD_AGENTFIELD_TARGET`.
- Per-run target overrides are not shipped.

AgentField execution id:

- The id returned by AgentField after `POST /api/v1/execute/async/{target}`.
- Store it as `RuntimeStartResult.externalSessionKey` and include it in events/artifacts as `agentfieldExecutionId`.

Wrapper result payload:

- The terminal AgentField status response body, including `result` or `error` when present.
- Store it as an artifact so operators can inspect the exact upstream payload without relying on normalized `runtime.output` text alone.

AgentField transcript:

- A sanitized newline-delimited record of AgentField HTTP request/status activity.
- It is not a full HTTP dump. It records method, path, status, duration, byte counts, execution ids, target, upstream status transitions, and named failure reasons.
- It must not include bearer tokens, API keys, webhook secrets, full environment variables, or arbitrary headers.

## Runtime Mode Contract

R6 adds one shipped runtime mode:

| Runtime mode slug | Runtime mode id | Provider | Runtime | Adapter id | Adapter type | Kind | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `agentfield.async_rest` | `runtime_mode_agentfield_async_rest` | `provider_agentfield` | `runtime_agentfield` | `agentfield` | `http` | `async_rest` | Configured AgentField async execution target using create and poll/result over REST. |

Seeded registry records:

- Provider: `provider_agentfield`, name `AgentField`, `authMode: "api_key"`.
- Runtime: `runtime_agentfield`, name `AgentField`, `adapterType: "http"`, `providerId: "provider_agentfield"`.
- Model: `model_agentfield_default`, provider `provider_agentfield`, `modelName: "agentfield-default"`, `supportsTools: false`, `supportsStreaming: false`, `supportsBrowser: false`.

Run creation inference:

- `runtime: "agentfield"` plus `adapterType: "http"` infers `runtimeMode: "agentfield.async_rest"`.
- Explicit `runtimeMode: "agentfield.async_rest"` must match `runtime: "agentfield"`, `provider: "agentfield"`, and `adapterType: "http"`.
- Explicit internal id `runtime_mode_agentfield_async_rest` remains invalid in public `POST /runs` bodies.
- Existing fake, Codex, Generic HTTP, and OpenCode inference behavior must remain unchanged.

AgentField manifest:

```json
{
  "adapterId": "agentfield",
  "providerId": "provider_agentfield",
  "runtimeId": "runtime_agentfield",
  "runtimeModeId": "runtime_mode_agentfield_async_rest",
  "runtimeModeSlug": "agentfield.async_rest",
  "name": "AgentField async REST",
  "adapterType": "http",
  "kind": "async_rest",
  "capabilities": [
    "run.start",
    "run.timeout",
    "event.normalized",
    "event.streaming",
    "artifact.transcript",
    "auth.api_key"
  ],
  "limitations": [
    { "code": "configured_target_only", "message": "agentfield.async_rest uses the daemon-level AgentField target configured by SWITCHYARD_AGENTFIELD_TARGET." },
    { "code": "no_post_start_input", "message": "agentfield.async_rest does not support POST /runs/:id/input in R6." },
    { "code": "cancel_unsupported", "message": "AgentField upstream cancellation is not claimed in R6 because no cancel endpoint is verified by this spec." },
    { "code": "polling_only", "message": "R6 polls AgentField execution status and does not accept webhooks." },
    { "code": "no_agentfield_control_plane_proxy", "message": "AgentField memory, admin, node lifecycle, permissions, and Agentic APIs are not exposed through Switchyard in R6." }
  ],
  "placement": {
    "local": { "support": "conditional", "reason": "Requires SWITCHYARD_AGENTFIELD_BASE_URL, SWITCHYARD_AGENTFIELD_API_KEY, and SWITCHYARD_AGENTFIELD_TARGET." },
    "hosted": { "support": "future", "reason": "Hosted execution is not shipped in R6." },
    "connectedLocalNode": { "support": "future", "reason": "Hybrid local-node execution is not shipped in R6." }
  },
  "docsPath": "docs/development/adapters/AGENTFIELD.md",
  "check": {
    "strategy": "custom",
    "required": ["base_url_configured", "api_key_configured", "target_configured", "agentfield_health"],
    "optional": ["target_discovery"]
  }
}
```

Do not add new runtime capability enum values in R6 unless implementation proves one is strictly required. In particular, do not add `run.input`, `approval.*`, `tool.*`, `memory.*`, `webhook.*`, `hosted`, or `agentfield.*` capability strings.

## Daemon Configuration

AgentField settings are daemon-level only:

| Variable | Required | Default | Behavior |
| --- | --- | --- | --- |
| `SWITCHYARD_AGENTFIELD_BASE_URL` | Yes for availability | none | AgentField control-plane base URL, for example `http://127.0.0.1:8080`. Must be `http://` or `https://`. |
| `SWITCHYARD_AGENTFIELD_API_KEY` | Yes for real AgentField runs | none | Sent as `Authorization: Bearer <key>`. Must never be logged, stored, returned by doctor, or written to transcripts. |
| `SWITCHYARD_AGENTFIELD_TARGET` | Yes for runs | none | AgentField async target used in `POST /api/v1/execute/async/{target}`. |
| `SWITCHYARD_AGENTFIELD_REQUEST_TIMEOUT_MS` | No | `5000` | Per-request timeout for health, discovery, start, and status polling. |
| `SWITCHYARD_AGENTFIELD_POLL_INTERVAL_MS` | No | `1000` | Delay between execution status polls. |
| `SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES` | No | `1048576` | Maximum bytes read from any AgentField response before failing that request as oversized. |

Configuration rules:

- `BASE_URL` may include a path prefix. Endpoint paths are resolved relative to that prefix.
- `API_KEY` is daemon config only; run metadata must not override it.
- `TARGET` is daemon config only; run metadata must not override it.
- Run metadata must not override base URL, API key, request timeout, poll interval, max response bytes, health path, or status path.
- The adapter must not forward arbitrary run metadata as HTTP headers.
- The adapter may set only these AgentField workflow headers:
  - `X-Workflow-ID`: `metadata.agentfield.workflowId` when it is a non-empty string, otherwise `switchyard:<runId>`.
  - `X-Session-ID`: `metadata.agentfield.sessionId` when it is a non-empty string, otherwise `switchyard:<runId>`.
  - `X-Actor-ID`: `metadata.agentfield.actorId` when it is a non-empty string, otherwise `switchyard`.
- The adapter must reject non-string workflow/session/actor metadata with `agentfield_header_metadata_invalid`.
- Logs may include run id, AgentField execution id, AgentField run id, target, status, HTTP method, URL pathname, status code, duration, byte counts, and reason code.
- Logs and transcripts must not include bearer tokens, full request bodies when they might contain secrets, webhook secrets, raw environment values, or arbitrary headers.

## AgentField HTTP Contract

R6 implements the client side of the AgentField async REST flow and a deterministic fake server. It does not expose AgentField endpoints through Switchyard.

### `GET /api/v1/health`

Request:

```http
GET /api/v1/health
Authorization: Bearer <token>
```

Accepted healthy responses:

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "checks": {
    "storage": { "status": "healthy" }
  }
}
```

```json
{
  "ok": true,
  "version": "1.0.0"
}
```

Rules:

- Non-2xx maps to `agentfield_health_unavailable`.
- Invalid JSON, empty body, or no recognizable healthy/degraded signal maps to `agentfield_health_invalid`.
- `status: "healthy"` or `ok: true` is healthy.
- `status: "degraded"` is `partial`, `canRun: true`, reason `agentfield_health_degraded`.
- A response larger than `SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES` maps to `check_output_too_large`.
- Doctor/check must not create an AgentField execution.

### Optional Target Discovery

After health succeeds and a target is configured, doctor may call:

```http
GET /api/v1/discovery/capabilities?format=compact
Authorization: Bearer <token>
```

Rules:

- Discovery is optional and diagnostic only.
- If discovery returns 200 and the configured target appears in `invocation_target` or `target`, check remains available.
- If discovery returns 200 and the configured target is absent, check returns `unavailable`, `canRun: false`, reason `agentfield_target_not_found`.
- If discovery returns 404, non-2xx, invalid JSON, or times out after health succeeds, check returns `partial`, `canRun: true`, reason `agentfield_discovery_unavailable`, because execution may still succeed even when discovery is unavailable.
- The runtime must not use discovery to select targets automatically.

### `POST /api/v1/execute/async/{target}`

Public Switchyard create payload:

```json
{
  "runtime": "agentfield",
  "provider": "agentfield",
  "model": "agentfield-default",
  "adapterType": "http",
  "runtimeMode": "agentfield.async_rest",
  "cwd": "/repo",
  "task": "Analyze this repository and return a short JSON summary.",
  "timeoutSeconds": 120,
  "metadata": {
    "agentfield": {
      "workflowId": "wf_switchyard_smoke",
      "input": {
        "task": "Analyze this repository and return a short JSON summary.",
        "mode": "read_only"
      }
    }
  }
}
```

Request body sent to AgentField:

```json
{
  "input": {
    "task": "Analyze this repository and return a short JSON summary.",
    "mode": "read_only"
  }
}
```

Default input when `metadata.agentfield.input` is absent:

```json
{
  "input": {
    "task": "Analyze this repository and return a short JSON summary.",
    "cwd": "/repo",
    "switchyardRunId": "run_123"
  }
}
```

Success response:

```json
{
  "execution_id": "exec_abc123",
  "run_id": "run_def456",
  "status": "queued",
  "target": "research-agent.deep_analysis",
  "workflow_id": "wf_xyz789"
}
```

Rules:

- `execution_id` is required and must be a non-empty string.
- `run_id`, `workflow_id`, `target`, and `status` are optional execution metadata.
- Accepted initial statuses are `queued`, `pending`, `running`, `succeeded`, `failed`, `cancelled`, and `timeout`.
- A terminal start response is allowed and must be normalized without requiring a second poll.
- If `metadata.agentfield.input` is present, it must be a JSON object. Arrays, strings, null, or numbers are `agentfield_input_invalid`.
- If `metadata.agentfield.input` is an empty object, send `{ "input": {} }`; if AgentField rejects it, surface the upstream failure as `agentfield_start_failed` or `agentfield_status_failed`.
- Do not send `webhook` in R6.
- Do not forward arbitrary metadata as headers or request fields.
- Start non-2xx maps to failed run reason `agentfield_start_failed`.
- Start invalid JSON, empty body, or missing `execution_id` maps to failed run reason `agentfield_invalid_start_response`.
- Start response oversized maps to failed run reason `agentfield_start_response_too_large`.

### `GET /api/v1/executions/{execution_id}`

Status/running response:

```json
{
  "execution_id": "exec_abc123",
  "run_id": "run_def456",
  "status": "running",
  "target": "research-agent.deep_analysis",
  "started_at": "2026-05-30T10:30:45Z",
  "duration_ms": null
}
```

Success response:

```json
{
  "execution_id": "exec_abc123",
  "run_id": "run_def456",
  "status": "succeeded",
  "result": {
    "summary": "Repository analysis complete.",
    "confidence": 0.94
  },
  "completed_at": "2026-05-30T10:31:30Z",
  "duration_ms": 45000
}
```

Failed response:

```json
{
  "execution_id": "exec_abc123",
  "run_id": "run_def456",
  "status": "failed",
  "error": {
    "code": "agent_error",
    "message": "The configured target rejected the input."
  },
  "duration_ms": 1200
}
```

Status mapping:

| AgentField status | Switchyard event behavior |
| --- | --- |
| `queued` | `runtime.status` with `status: "agentfield_queued"` and execution metadata. |
| `pending` | `runtime.status` with `status: "agentfield_pending"` and execution metadata. |
| `running` | `runtime.status` with `status: "agentfield_running"` and execution metadata. |
| `succeeded` | Emit `runtime.output` with normalized text from `result`, then `run.completed`. |
| `failed` | Emit `run.failed` with `error: "agentfield_status_failed"` plus sanitized upstream error summary. |
| `cancelled` | Emit `run.failed` with `error: "agentfield_upstream_cancelled"` because R6 did not initiate verified upstream cancellation. |
| `timeout` | Emit `run.failed` with `error: "agentfield_upstream_timeout"` because the upstream timed out before Switchyard did. |
| unknown string | Emit `run.failed` with `error: "agentfield_unknown_status"`. |

Rules:

- Polling continues until one terminal status is observed or Switchyard `timeoutSeconds` fires.
- Repeated non-terminal statuses are deduped when status and progress metadata are unchanged.
- Status responses may include `progress`, `message`, `started_at`, `completed_at`, `duration_ms`, `workflow_id`, and `target`; include bounded versions in `runtime.status` payloads when present.
- Invalid JSON, missing `status`, or status response oversized maps to failed run reason `agentfield_invalid_status_response` or `agentfield_status_response_too_large`.
- A `succeeded` response with missing `result` is still completed. It emits no `runtime.output` and stores the terminal response artifact.
- A `succeeded` response with `result: null` is completed. It emits no `runtime.output` and stores the terminal response artifact.
- A `succeeded` response with string result emits that string as `runtime.output.text`.
- A `succeeded` response with object/array/number/boolean result emits stable compact JSON as `runtime.output.text`.
- Result text emitted as `runtime.output.text` must be bounded. If the result exceeds the configured max bytes, do not emit the full text; emit a `runtime.status` with `status: "agentfield_result_oversized"` and store no full result content. The run fails with `agentfield_result_too_large` unless the content is safely within `SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES`.
- The adapter must yield at most one terminal Switchyard event per run.

## Event Payload Contract

AgentField events must preserve wrapper metadata without leaking secrets.

`runtime.status` payload for queued/running/pending:

```json
{
  "status": "agentfield_running",
  "agentfieldExecutionId": "exec_abc123",
  "agentfieldRunId": "run_def456",
  "workflowId": "wf_xyz789",
  "target": "research-agent.deep_analysis",
  "sourceStatus": "running",
  "durationMs": 1200
}
```

`runtime.output` payload for terminal success:

```json
{
  "text": "{\"summary\":\"Repository analysis complete.\",\"confidence\":0.94}",
  "agentfieldExecutionId": "exec_abc123",
  "agentfieldRunId": "run_def456",
  "workflowId": "wf_xyz789",
  "target": "research-agent.deep_analysis",
  "resultFormat": "json"
}
```

`run.completed` payload:

```json
{
  "status": "completed",
  "agentfieldExecutionId": "exec_abc123",
  "agentfieldRunId": "run_def456",
  "workflowId": "wf_xyz789",
  "target": "research-agent.deep_analysis",
  "sourceStatus": "succeeded"
}
```

`run.failed` payload for upstream failure:

```json
{
  "status": "failed",
  "error": "agentfield_status_failed",
  "agentfieldExecutionId": "exec_abc123",
  "agentfieldRunId": "run_def456",
  "target": "research-agent.deep_analysis",
  "sourceStatus": "failed",
  "upstreamErrorCode": "agent_error",
  "upstreamErrorMessage": "The configured target rejected the input."
}
```

Rules:

- Event payloads must never include the AgentField API key.
- Event payload strings must be bounded by the same diagnostic truncation behavior used by doctor/check.
- If `workflow_id`, `run_id`, or `target` is absent upstream, omit that field; do not invent upstream ids except the configured `target`.
- Unknown fields from AgentField status responses are not copied wholesale into events. They remain available only in the raw result payload artifact when terminal and within size bounds.

## Artifacts

Every AgentField run that reaches adapter `start()` must return an AgentField transcript artifact:

- Type: `transcript`
- Path: `runs/<runId>/agentfield-transcript.jsonl`

Metadata:

```json
{
  "runtime": "agentfield",
  "mode": "async-rest",
  "runtimeMode": "agentfield.async_rest",
  "protocol": "http",
  "target": "research-agent.deep_analysis",
  "agentfieldExecutionId": "exec_abc123",
  "agentfieldRunId": "run_def456",
  "workflowId": "wf_xyz789",
  "transcriptVersion": "r6.agentfield.v1"
}
```

Transcript content example:

```jsonl
{"type":"agentfield.request","method":"POST","path":"/api/v1/execute/async/research-agent.deep_analysis","status":202,"durationMs":18,"bytes":112}
{"type":"agentfield.status","executionId":"exec_abc123","sourceStatus":"running","durationMs":1200}
{"type":"agentfield.status","executionId":"exec_abc123","sourceStatus":"succeeded","durationMs":45000}
{"type":"agentfield.result","executionId":"exec_abc123","status":"succeeded","resultBytes":64}
```

Every terminal AgentField response with a valid JSON body inside `SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES` must also return a wrapper result payload artifact:

- Type: `raw_log`
- Path: `runs/<runId>/agentfield-result.json`

Metadata:

```json
{
  "runtime": "agentfield",
  "runtimeMode": "agentfield.async_rest",
  "target": "research-agent.deep_analysis",
  "agentfieldExecutionId": "exec_abc123",
  "agentfieldRunId": "run_def456",
  "workflowId": "wf_xyz789",
  "sourceStatus": "succeeded",
  "payloadKind": "terminal_status_response"
}
```

Artifact rules:

- Use `metadata.content` as the adapter-to-runner handoff field. `RuntimeRunnerService` strips it and sets `contentStored`.
- Store JSON result payload content using stable pretty-printed JSON with two-space indentation.
- Do not store request headers or API keys.
- Do not store webhook secrets because R6 does not send webhooks.
- If the terminal response is malformed, store only the transcript and fail visibly with the named parser reason.
- If artifact content persistence fails after terminalization, existing runner behavior applies: the failure is visible, but the adapter must not hide it by omitting expected artifacts.
- Started failed, upstream-failed, upstream-timeout, and upstream-cancelled statuses should still produce transcript and terminal payload artifacts when a valid terminal response body exists.

## Failure And Cancel Behavior

Named reason codes:

| Reason code | Trigger | Public/user-visible behavior |
| --- | --- | --- |
| `agentfield_config_missing` | Base URL is missing. | Runtime mode exists but doctor reports unavailable; run fails if forced. |
| `agentfield_config_invalid` | Base URL is not valid `http` or `https`. | Runtime mode unavailable; no request attempted. |
| `agentfield_auth_missing` | API key is missing. | Runtime mode unavailable; real run cannot start. |
| `agentfield_target_missing` | Target is missing. | Runtime mode unavailable; run fails if forced. |
| `agentfield_health_unavailable` | Health returns non-2xx or unhealthy. | Doctor unavailable. |
| `agentfield_health_invalid` | Health body is invalid or unrecognized. | Doctor unknown/unavailable, bounded diagnostic. |
| `agentfield_health_degraded` | Health reports degraded. | Doctor partial, `canRun: true`. |
| `agentfield_discovery_unavailable` | Optional discovery fails after health succeeds. | Doctor partial, `canRun: true`. |
| `agentfield_target_not_found` | Discovery succeeds and target is absent. | Doctor unavailable, `canRun: false`. |
| `agentfield_start_failed` | Async create returns non-2xx. | Run fails; transcript records request summary. |
| `agentfield_invalid_start_response` | Create response lacks a usable execution id. | Run fails; no silent running state. |
| `agentfield_start_response_too_large` | Create response exceeds max bytes. | Run fails; no full body logged. |
| `agentfield_invalid_status_response` | Poll response is malformed. | Run fails with transcript summary. |
| `agentfield_status_response_too_large` | Poll response exceeds max bytes. | Run fails; no full body logged. |
| `agentfield_status_failed` | AgentField terminal status is `failed`. | Run fails and includes sanitized upstream error summary. |
| `agentfield_upstream_cancelled` | AgentField reports `cancelled`. | Run fails because R6 did not verify Switchyard-initiated upstream cancel. |
| `agentfield_upstream_timeout` | AgentField reports `timeout`. | Run fails with upstream timeout reason. |
| `agentfield_unknown_status` | AgentField reports an unknown status string. | Run fails visibly. |
| `agentfield_result_too_large` | Terminal result cannot be safely normalized/stored within byte bounds. | Run fails; transcript notes result size only. |
| `agentfield_input_invalid` | `metadata.agentfield.input` is present but not an object. | Public create with `wait=1` fails the run; adapter unit tests cover defensive start failure. |
| `agentfield_header_metadata_invalid` | workflow/session/actor metadata is not a string. | Run fails before upstream call. |
| `agentfield_input_unsupported` | Public `POST /runs/:id/input` is used. | REST returns `409 adapter_protocol_failed`. |
| `agentfield_cancel_unsupported` | Public cancel is used for active AgentField run. | REST returns `409 adapter_protocol_failed`; run state is not changed to cancelled. |
| `agentfield_request_failed` | Network, DNS, TLS, or fetch failure outside named response cases. | Run/check fails visibly with sanitized bounded message. |
| `check_timeout` | Doctor/check request timeout. | Doctor returns `unknown`, not 500. |
| `check_output_too_large` | Doctor response exceeds diagnostic limit. | Doctor returns `unknown`, not 500. |

Cancellation rules:

- R6 does not claim `run.cancel` capability for AgentField.
- `POST /runs/:id/cancel` for an active AgentField run must return `409 adapter_protocol_failed` with details reason `agentfield_cancel_unsupported`.
- The run must remain `queued`, `starting`, or `running` until it terminalizes normally or Switchyard timeout fires.
- If public cancel is called after the run is already terminal, existing idempotent terminal-run behavior returns the terminal run.
- When Switchyard timeout fires, `RuntimeRunnerService.timeoutRun()` will call adapter `cancel()` best-effort. The AgentField adapter may throw `agentfield_cancel_unsupported`; the runner already catches timeout cancel failures and must still mark the run `timeout`.
- Do not mark a run `cancelled` based on AgentField upstream `cancelled` status in R6, because Switchyard did not initiate a verified upstream cancel.

Unsupported input rules:

- `POST /runs/:id/input` for AgentField returns `409 adapter_protocol_failed` with details reason `agentfield_input_unsupported`.
- Do not add post-start input capability in R6.

## Doctor And Availability

Initial daemon seeding:

- If `SWITCHYARD_AGENTFIELD_BASE_URL` is absent, seed `agentfield.async_rest` as unavailable with `agentfield_config_missing`.
- If base URL is invalid, seed unavailable with `agentfield_config_invalid`.
- If API key is absent, seed unavailable with `agentfield_auth_missing`.
- If target is absent, seed unavailable with `agentfield_target_missing`.
- If all config is present, seed `unknown` with message "Run POST /runtime-modes/agentfield.async_rest/check to verify AgentField availability."

Active check sequence:

1. Validate base URL, API key, target, timeout, poll interval, and max response bytes.
2. `GET /api/v1/health` with bearer auth.
3. Optionally `GET /api/v1/discovery/capabilities?format=compact` to verify configured target.
4. Return adapter-provided custom availability through existing `RuntimeDoctorService`.
5. Do not call `POST /api/v1/execute/async/{target}` during doctor/check.

Availability mapping:

| Condition | State | canRun | installed | auth | reasonCode |
| --- | --- | --- | --- | --- | --- |
| Base URL missing | `unavailable` | false | false | `unknown` | `agentfield_config_missing` |
| Base URL invalid | `unavailable` | false | false | `unknown` | `agentfield_config_invalid` |
| API key missing | `unavailable` | false | true | `missing` | `agentfield_auth_missing` |
| Target missing | `unavailable` | false | true | `configured` | `agentfield_target_missing` |
| Health timeout | `unknown` | false | true | `configured` | `check_timeout` |
| Health oversized | `unknown` | false | true | `configured` | `check_output_too_large` |
| Health non-2xx or unhealthy | `unavailable` | false | true | `configured` | `agentfield_health_unavailable` |
| Health invalid JSON | `unknown` | false | true | `configured` | `agentfield_health_invalid` |
| Health degraded | `partial` | true | true | `configured` | `agentfield_health_degraded` |
| Health healthy, discovery unavailable | `partial` | true | true | `configured` | `agentfield_discovery_unavailable` |
| Health healthy, discovery says target missing | `unavailable` | false | true | `configured` | `agentfield_target_not_found` |
| Health healthy, target configured, discovery ok or skipped with no error | `available` | true | true | `configured` | null |

Doctor diagnostics:

- Include `agentfield_health_ok` info when health passes.
- Include `agentfield_target_discovery_ok` info when discovery verifies the target.
- Include `agentfield_discovery_unavailable` warning when discovery is not usable but health is good.
- Include only sanitized, bounded messages.
- Never include API key, auth header, full health body, or full discovery catalog in doctor output.

## Adapter Package Shape

Expected files:

- `packages/adapters/src/agentfield/index.ts`
- `packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts`
- `packages/adapters/src/agentfield/http-client.ts` or shared HTTP helper reuse if CTO chooses to extract from Generic HTTP.
- `packages/adapters/src/agentfield/types.ts`
- `packages/adapters/test/agentfield-async-rest-adapter.test.ts`
- `packages/testkit/src/fake-agentfield-server.ts`
- `packages/testkit/src/fake-agentfield-cli.ts`
- `packages/testkit/test/fake-agentfield-server.test.ts`
- daemon config and app wiring files under `apps/daemon/src/`
- daemon smoke tests under `apps/daemon/test/`

Adapter implementation constraints:

- Reuse existing `AdapterProtocolError` for unsupported input/cancel and adapter protocol failures surfaced through REST.
- Reuse or extract the R4 HTTP response size, timeout, and sanitization logic. Do not copy a divergent unbounded fetch implementation.
- Keep AgentField-specific status mapping in `packages/adapters/src/agentfield/`, not in core, REST, or daemon route code.
- Store active sessions in adapter-local state keyed by Switchyard session id, matching Generic HTTP and OpenCode.
- Session state must record `runId`, `agentfieldExecutionId`, `agentfieldRunId`, `workflowId`, `target`, last source status, terminal payload, transcript recorder, and dedupe state.
- `tools()` returns `[]` in R6.
- `send()` throws `AdapterProtocolError` reason `agentfield_input_unsupported`.
- `cancel()` no-ops after terminal state, otherwise throws `AdapterProtocolError` reason `agentfield_cancel_unsupported`.

## Fake AgentField Server

R6 must add a deterministic fake AgentField control-plane server in `@switchyard/testkit`. It is a test utility, not a product daemon.

Required endpoints:

- `GET /api/v1/health`
- `GET /api/v1/discovery/capabilities?format=compact`
- `POST /api/v1/execute/async/:target`
- `GET /api/v1/executions/:executionId`

Required package script:

```bash
pnpm --filter @switchyard/testkit fake-agentfield -- --host 127.0.0.1 --port 5065 --target switchyard.echo
```

Fake server rules:

- Uses loopback on an ephemeral or configured port.
- Does not call external network services.
- Does not run real AgentField, LLMs, model providers, webhooks, or subprocesses.
- Can require an expected bearer token for auth tests.
- Stores fake execution state in memory only.
- Implements exactly the R6 AgentField endpoint subset above.
- Scenario selection is through test helper options and CLI flags, not through public Switchyard API expansion.

Required fake scenarios:

| Scenario | Behavior |
| --- | --- |
| `happy` | Health succeeds, target discovery succeeds, async create returns execution id, status polls running then succeeded, result is object. |
| `empty_result` | Terminal succeeded response has `result: null`; run completes with `response.text: null`. |
| `string_result` | Terminal result is a string; run output text is that string. |
| `upstream_failed` | Status returns failed with error object; Switchyard emits `run.failed` with `agentfield_status_failed`. |
| `upstream_cancelled` | Status returns cancelled; Switchyard emits `run.failed` with `agentfield_upstream_cancelled`. |
| `upstream_timeout` | Status returns timeout; Switchyard emits `run.failed` with `agentfield_upstream_timeout`. |
| `pending_until_switchyard_timeout` | Polling never reaches terminal; Switchyard marks run `timeout`. |
| `start_http_500` | Create returns 500; run fails with `agentfield_start_failed`. |
| `invalid_start_json` | Create lacks execution id; run fails with `agentfield_invalid_start_response`. |
| `invalid_status_json` | Poll response malformed; run fails with `agentfield_invalid_status_response`. |
| `unknown_status` | Poll status unknown; run fails with `agentfield_unknown_status`. |
| `health_http_500` | Doctor unavailable with `agentfield_health_unavailable`. |
| `health_degraded` | Doctor partial with `agentfield_health_degraded`. |
| `invalid_health_json` | Doctor unknown/unavailable with `agentfield_health_invalid`. |
| `target_not_found` | Discovery 200 excludes target; doctor unavailable with `agentfield_target_not_found`. |
| `discovery_unavailable` | Health ok but discovery fails; doctor partial with `agentfield_discovery_unavailable`. |
| `oversized_health_response` | Doctor unknown with `check_output_too_large`. |
| `oversized_start_response` | Run fails with `agentfield_start_response_too_large`. |
| `oversized_status_response` | Run fails with `agentfield_status_response_too_large`. |
| `oversized_result` | Run fails with `agentfield_result_too_large`. |
| `auth_required` | Missing/wrong bearer token returns 401 and sanitized diagnostics. |

## Data Flow Shadow Paths

Every R6 implementation task should cover these paths.

### AgentField config to doctor check

Happy:

- Base URL, API key, and target are configured.
- Health returns healthy JSON and discovery verifies the target.
- Runtime mode reports `available`, `canRun: true`.

Nil:

- Base URL, API key, or target is absent.
- Runtime mode is still seeded but reports `unavailable` with `agentfield_config_missing`, `agentfield_auth_missing`, or `agentfield_target_missing`.

Empty:

- Env vars are present but trim to empty strings.
- Treat them as absent, not as configured values.

Error:

- Health times out, connection is refused, response is non-2xx, invalid JSON, degraded, or oversized.
- Doctor returns bounded sanitized `unknown`, `partial`, or `unavailable`; daemon startup and `/doctor` must not 500 for expected AgentField unavailability.

### Switchyard run request to AgentField async create

Happy:

- Public run payload has `runtime: "agentfield"`, `provider: "agentfield"`, `model: "agentfield-default"`, `adapterType: "http"`, non-empty `task`, and configured target.
- Runtime mode is inferred as `agentfield.async_rest`.
- Adapter posts to `/api/v1/execute/async/{target}`, stores execution id as `externalSessionKey`, and begins polling.

Nil:

- Public `runtimeMode` is absent.
- Registry inference supplies `agentfield.async_rest`.

Empty:

- Public `metadata` is absent or `{}`.
- Adapter sends default input `{ task, cwd, switchyardRunId }`.

Error:

- `metadata.agentfield.input` is not an object, create returns non-2xx, create returns invalid JSON, or create omits `execution_id`.
- Run becomes failed with a named reason; no queued/running hang.

### AgentField status poll to Switchyard events

Happy:

- AgentField returns running then succeeded with result.
- Switchyard emits bounded `runtime.status`, `runtime.output`, and `run.completed`.

Nil:

- Optional upstream metadata fields such as `run_id`, `workflow_id`, `target`, `duration_ms`, or `message` are absent.
- Events omit absent optional fields and still terminalize correctly.

Empty:

- Succeeded response has no result or `result: null`.
- Run completes; `POST /runs?wait=1` returns `response.text: null`; terminal payload artifact still stores the response.

Error:

- Poll response malformed, unknown status, failed/cancelled/timeout status, repeated non-terminal forever, or oversized response.
- Adapter emits one visible terminal failure or the runner marks Switchyard timeout.

### AgentField result to artifacts

Happy:

- Terminal response contains a result object within max bytes.
- Adapter returns transcript and `agentfield-result.json`; runner stores content and emits `artifact.created`.

Nil:

- No result field is present.
- Adapter still stores terminal response artifact if the response body is valid JSON.

Empty:

- Result is `{}` or `null`.
- Run completion behavior follows status; artifact still records exact terminal response.

Error:

- Result/status payload exceeds byte bounds or cannot be serialized.
- Run fails with `agentfield_result_too_large` or parser reason; transcript records size/reason only and secrets are not logged.

### Public input and cancel

Happy:

- Public input and active public cancel are not supported in R6.
- REST returns `409 adapter_protocol_failed` with named reason codes and does not mutate run state to a false terminal status.

Nil:

- Cancel is called after the run is already terminal.
- Existing terminal idempotency returns the current run without adapter cancellation.

Empty:

- Input body is `{}`.
- It still returns `409 adapter_protocol_failed` with `agentfield_input_unsupported`.

Error:

- Switchyard timeout calls adapter cancel best-effort and adapter cannot cancel upstream.
- Runner logs timeout cancel failure and still marks the run `timeout`; no false `cancelled` state is persisted.

## Acceptance Criteria

- [ ] `agentfield.async_rest` manifest parses through existing contracts with `adapterType: "http"` and `kind: "async_rest"`.
- [ ] AgentField provider/runtime/model/runtime-mode records are seeded on daemon startup.
- [ ] `RegistryService` infers `agentfield.async_rest` for omitted runtime mode and rejects internal id `runtime_mode_agentfield_async_rest` in public create bodies.
- [ ] Daemon config supports `SWITCHYARD_AGENTFIELD_BASE_URL`, `SWITCHYARD_AGENTFIELD_API_KEY`, `SWITCHYARD_AGENTFIELD_TARGET`, `SWITCHYARD_AGENTFIELD_REQUEST_TIMEOUT_MS`, `SWITCHYARD_AGENTFIELD_POLL_INTERVAL_MS`, and `SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES`.
- [ ] `POST /runtime-modes/agentfield.async_rest/check` reports missing/invalid config, missing auth, missing target, healthy, degraded, target-not-found, discovery-unavailable, timeout, and oversized states with named sanitized reason codes.
- [ ] Doctor/check never creates an AgentField execution and never spends model budget.
- [ ] AgentField adapter creates async executions with `POST /api/v1/execute/async/{target}` and polls `GET /api/v1/executions/{execution_id}`.
- [ ] AgentField adapter maps queued/pending/running status to `runtime.status`.
- [ ] AgentField adapter maps succeeded result to bounded `runtime.output` plus `run.completed`.
- [ ] AgentField adapter maps failed/cancelled/timeout/unknown upstream statuses to visible named `run.failed` events.
- [ ] AgentField adapter emits at most one terminal event per run.
- [ ] AgentField adapter returns `409 adapter_protocol_failed` for post-start input with reason `agentfield_input_unsupported`.
- [ ] AgentField adapter returns `409 adapter_protocol_failed` for active public cancel with reason `agentfield_cancel_unsupported`, and does not mark the run cancelled.
- [ ] Switchyard timeout still marks AgentField runs `timeout` even though upstream cancel is unsupported.
- [ ] AgentField transcript artifact is stored at `runs/<runId>/agentfield-transcript.jsonl` for completed, failed-after-start, upstream-timeout, upstream-cancelled, and Switchyard-timeout-after-start runs.
- [ ] AgentField terminal payload artifact is stored at `runs/<runId>/agentfield-result.json` whenever a terminal status response body is valid and within byte bounds.
- [ ] AgentField artifacts are retrievable through `GET /runs/:id/artifacts`, `GET /artifacts/:id`, and `GET /artifacts/:id/content`.
- [ ] AgentField API key is not present in check output, events, logs, transcript content, artifact metadata, or test snapshots.
- [ ] Fake AgentField server covers all required scenarios without external network calls or model spend.
- [ ] Runtime adapter contract harness runs against fake runtime, Codex fake process, Generic HTTP fake server, OpenCode fake ACP process, and AgentField fake server.
- [ ] Existing fake, Codex, Generic HTTP, OpenCode, REST, SSE, storage, and daemon tests continue to pass.
- [ ] Docs update product truth and local verification only after mocked/fake AgentField flow passes CI.

## Implementation Slices For CTO

### Slice 1: AgentField HTTP Client And Fake Server

Goal: Add bounded AgentField HTTP helpers and deterministic fake AgentField control-plane coverage.

Acceptance:

- Fake AgentField server implements R6 endpoint subset and required scenarios.
- HTTP helper enforces timeout, max bytes, JSON parsing, bearer token redaction, and sanitized request summaries.
- Unit tests cover happy, nil, empty, malformed, oversized, auth, and target-discovery cases without real AgentField.

Non-goals:

- No daemon runtime-mode wiring yet.
- No real AgentField smoke.

Complexity: M

### Slice 2: AgentField Adapter And Normalization

Goal: Implement `AgentFieldAsyncRestAdapter` over the existing runtime adapter interface.

Acceptance:

- Manifest matches `agentfield.async_rest`.
- Start creates async execution and stores execution id as `externalSessionKey`.
- Events poll status, dedupe repeated non-terminal statuses, normalize result/failure statuses, and yield exactly one terminal event.
- Input/cancel unsupported paths use `AdapterProtocolError`.
- Transcript and terminal payload artifacts follow the R6 artifact contract.

Non-goals:

- No webhooks.
- No upstream cancellation support.
- No dynamic target selection.

Complexity: L

### Slice 3: Registry, Doctor, Daemon Wiring

Goal: Make AgentField visible and checkable through existing runtime-mode and doctor APIs.

Acceptance:

- Daemon parses AgentField config.
- Daemon registers the adapter under runtime key `agentfield`.
- Provider/runtime/model/runtime-mode records are seeded.
- `GET /runtime-modes/agentfield.async_rest`, `POST /runtime-modes/agentfield.async_rest/check`, and `GET /doctor` behave as specified.
- Runtime-mode inference and mismatch validation are tested.

Non-goals:

- No new public endpoints.
- No AgentField control-plane proxy endpoints.

Complexity: M

### Slice 4: End-To-End REST, Artifact, Timeout, And Cancel Verification

Goal: Prove AgentField runs work through the public Switchyard API using the fake AgentField server.

Acceptance:

- `POST /runs?wait=1` against fake AgentField can complete and returns normalized response text.
- Async `POST /runs` plus `GET /runs/:id/events` works through the existing event store/SSE path.
- `GET /runs/:id/artifacts`, `GET /artifacts/:id`, and `GET /artifacts/:id/content` expose transcript and result payloads.
- Failed, upstream-cancelled, upstream-timeout, malformed status, oversized response, Switchyard timeout, unsupported input, and unsupported cancel paths are covered.
- Existing daemon smoke tests remain green.

Non-goals:

- No real AgentField execution in CI.
- No PR creation in native TUI workflow.

Complexity: M

### Slice 5: Product And Local Verification Docs

Goal: Update docs so a developer can verify R6 safely and understand what is not shipped.

Acceptance:

- `docs/development/adapters/AGENTFIELD.md` documents env vars, fake smoke, optional real smoke, status mapping, reason codes, transcript inspection, and common failures.
- `docs/development/API.md` includes `agentfield.async_rest` create/check/input/cancel/artifact behavior.
- `docs/development/DEVELOPMENT.md` includes mandatory fake verification and clearly marks real smoke as optional/manual.
- `PRODUCT.md` and `CHANGELOG.md` mark R6 shipped only after tests pass.
- Existing adapter docs list AgentField as implemented and leave OpenClaw/Paperclip deferred.

Non-goals:

- No marketing docs.
- No hosted deployment docs.

Complexity: S

## Local Verification

Mandatory focused checks:

```bash
git diff --check
pnpm --filter @switchyard/testkit test -- fake-agentfield
pnpm --filter @switchyard/adapters test -- agentfield
pnpm --filter @switchyard/adapters test -- runtime-adapter-contracts
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

Mandatory fake local smoke that R6 must make valid:

```bash
# Terminal 1: fake AgentField control plane.
pnpm --filter @switchyard/testkit fake-agentfield -- --host 127.0.0.1 --port 5065 --target switchyard.echo --token fake-agentfield-key

# Terminal 2: Switchyard daemon configured for fake AgentField.
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-r6-agentfield \
SWITCHYARD_AGENTFIELD_BASE_URL=http://127.0.0.1:5065 \
SWITCHYARD_AGENTFIELD_API_KEY=fake-agentfield-key \
SWITCHYARD_AGENTFIELD_TARGET=switchyard.echo \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

Smoke calls:

```bash
BASE=http://127.0.0.1:4546

curl -s "$BASE/runtime-modes/agentfield.async_rest" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/agentfield.async_rest/check" | python3 -m json.tool

RUN_ID=$(curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"agentfield","provider":"agentfield","model":"agentfield-default","adapterType":"http","cwd":"/repo","task":"r6 fake AgentField smoke","timeoutSeconds":30}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["run"]["id"])')

curl -s "$BASE/runs/$RUN_ID/events" | head -n 40
curl -s "$BASE/runs/$RUN_ID/artifacts" | python3 -m json.tool
```

Optional real AgentField smoke:

- Run only with explicit local approval because the configured AgentField target may spend model budget.
- Use a read-only, low-cost target that accepts either `metadata.agentfield.input` or the default `{ task, cwd, switchyardRunId }` shape.
- Do not run this smoke in CI.

```bash
export SWITCHYARD_AGENTFIELD_BASE_URL=http://127.0.0.1:8080
export SWITCHYARD_AGENTFIELD_API_KEY="$AGENTFIELD_API_KEY"
export SWITCHYARD_AGENTFIELD_TARGET="$AGENTFIELD_TARGET"
```

```bash
BASE=http://127.0.0.1:4546
curl -s -X POST "$BASE/runtime-modes/agentfield.async_rest/check" | python3 -m json.tool
curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"agentfield","provider":"agentfield","model":"agentfield-default","adapterType":"http","cwd":"/repo","task":"Return one short read-only summary. Do not modify external state.","timeoutSeconds":120}' \
  | python3 -m json.tool
```

## Promotion Criteria

R6 is done only when:

- AgentField is implemented as an adapter over the existing runtime/doctor/runner/artifact substrate, not as daemon-specific orchestration.
- `agentfield.async_rest` appears in runtime-mode APIs and doctor summaries with clear configured/unconfigured states.
- Mocked/fake AgentField flow passes CI and proves completion, failure, timeout, artifact, unsupported input, unsupported cancel, and secret-redaction paths.
- Real AgentField smoke is documented as optional/manual and cannot be required for CI or release promotion.
- AgentField result payloads and execution metadata are preserved in artifacts and bounded event payloads.
- AgentField API key and auth headers never appear in logs, doctor responses, events, or artifacts.
- OpenClaw, Paperclip, hosted workers, debate, AgentField memory/admin/permissions, webhooks, SDK, CLI, and TUI work remain out of scope.
- Product/API/development docs are updated during implementation closeout to mark exactly what became usable.

## Decisions And Risks

Decisions:

- R6 ships `agentfield.async_rest`, not generic AgentField sync execution, because long-running wrapper workflows need async create/poll behavior.
- The AgentField target is daemon-level config only. Per-run target overrides are excluded to keep AgentField from becoming an unbounded second control plane inside Switchyard.
- R6 uses polling only. Webhooks are deferred to avoid inbound signing, public callback routing, and hosted deployment concerns.
- R6 does not claim upstream cancellation. Public cancel returns a named `409` for active AgentField runs until a verified AgentField cancel endpoint is specified in a later release.
- AgentField discovery is a doctor diagnostic, not execution routing.
- Result payloads are stored as raw artifacts rather than copied wholesale into events.

Risks:

- AgentField docs and deployed versions may differ in exact status fields. The adapter must accept the documented core fields and fail visibly on unknown or malformed shapes.
- A configured AgentField target may require a custom input schema. R6 supports `metadata.agentfield.input` for that schema, but docs must make the default `{ task, cwd, switchyardRunId }` contract explicit for local smoke targets.
- Without upstream cancellation, long AgentField tasks may continue after a user tries to cancel in Switchyard. R6 avoids lying by returning `409` and relying on Switchyard timeout; a future release can add verified cancel if AgentField's lifecycle endpoint is pinned.
- HTTP helper duplication could drift from Generic HTTP. CTO should prefer extracting a shared bounded JSON request helper if it reduces duplication without broad refactor.
- Secret leakage risk is high because AgentField uses bearer auth. Tests must assert the API key is absent from logs/check payloads/transcripts/artifacts.
