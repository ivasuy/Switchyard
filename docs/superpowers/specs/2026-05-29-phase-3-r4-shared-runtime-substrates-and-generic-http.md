# Phase 3 Spec: R4 Shared Runtime Substrates And Generic HTTP

Date: 2026-05-29

Roadmap release: R4: Shared Runtime Substrates And Generic HTTP

Branch: `agent/phase-3-r4-shared-runtime-substrates-and-generic-http`

Previous phase head: `agent/phase-2-r3-runtime-capability-infrastructure` at `e0fc7ffdf0d5b1d06da2bd6fc07e474e30895aa8`

Spec target: `docs/superpowers/specs/2026-05-29-phase-3-r4-shared-runtime-substrates-and-generic-http.md`

## Summary

R4 extracts reusable runtime plumbing from the proven Codex exec-json adapter and adds a second real adapter shape: Generic HTTP. After this release, Switchyard must run one process-backed mode and one HTTP-wrapper-backed mode through the same public run lifecycle: create, inspect events, cancel, timeout, collect artifacts, inspect runtime capability, and store transcript artifacts.

The release is intentionally not an ACP, PTY, hosted, SDK, CLI, interactive Codex, approval, memory, tools, or debate release. The product value is a durable adapter substrate: future adapters should not copy Codex process code, and wrapper adapters should not invent their own lifecycle, transcript, timeout, cancellation, or contract-test behavior.

## Scope Gate

In scope:

- Shared process-runner substrate extracted from Codex without changing the public Codex `codex.exec_json` behavior.
- Shared transcript capture conventions for process-backed and HTTP-wrapper-backed adapters.
- stdout/stderr/event parser harness for JSONL-like process streams.
- Reusable cancellation and timeout helpers for adapter checks, process sessions, and HTTP wrapper calls.
- Stronger adapter contract tests that every adapter can run against.
- Generic HTTP adapter for a simple async REST wrapper runtime.
- Deterministic fake HTTP wrapper test server for CI.
- Runtime-mode manifest, doctor/check, registry seeding, and run-mode inference for `generic_http.async_rest`.
- Generic HTTP local development docs and adapter docs template updates during implementation closeout.

Out of scope:

- ACP/acpx implementation.
- PTY adapter or generic PTY substrate.
- Full Codex interactive mode.
- Hosted worker execution or hosted-safe subprocess execution.
- Dynamic per-run HTTP base URL selection.
- Webhook callbacks.
- SDK, CLI, OpenAPI generation, dashboard, or TUI product surfaces.
- Approval workflow, tool routing, memory APIs, debate engine, or policy expansion beyond existing contracts.
- New real third-party adapters such as OpenCode, Claude Code, Cursor, AgentField, OpenClaw, or Paperclip.

## Ground Truth From Current Code

This spec is based on the R3 code in this worktree after `e0fc7ff`, not on target architecture alone.

The adapter interface already has the lifecycle surface R4 must keep using in `packages/core/src/ports/runtime-adapter.ts`:

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

Runtime modes already have HTTP and async REST vocabulary in `packages/contracts/src/registry.ts`:

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
```

The current run creation route already infers R3 runtime modes in `packages/protocol-rest/src/run-routes.ts` through `RegistryService`:

```ts
const createInput: Parameters<RunService["createRun"]>[0] = {
  runtime: body.runtime,
  provider: body.provider,
  model: body.model,
  adapterType: body.adapterType,
  cwd: body.cwd,
  task: body.task,
  placement: body.placement ?? "local",
  approvalPolicy: body.approvalPolicy ?? "default",
  timeoutSeconds: body.timeoutSeconds ?? 600,
  metadata: body.metadata ?? {}
};
```

Codex currently owns process launch, stdout line queuing, stderr capture, cancellation, JSONL parsing, and transcript construction in `packages/adapters/src/codex/codex-exec-json-adapter.ts`:

```ts
const child = this.processFactory(args, { cwd, env: process.env });
child.stdin.end();
...
child.stderr.on("data", (chunk: string | Buffer) => {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  session.stderrLines.push(text);
  this.log("warn", "codex.stderr", {
    runId,
    pid: child.pid,
    text: truncate(text, 400)
  });
});
```

Current Codex transcript behavior is public enough to preserve. The artifact path and raw stdout/stderr content are built here:

```ts
return [
  {
    id: "artifact_codex_transcript",
    type: "transcript",
    path: `runs/${runId}/codex-transcript.jsonl`,
    metadata: {
      content,
      runtime: "codex",
      mode: "exec-json"
    },
    createdAt: active.startedAt
  }
];
```

The runner already persists adapter-provided transcript content into the artifact content store and removes inline `metadata.content` before storing the artifact record in `packages/core/src/services/runtime-runner-service.ts`:

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
if (hasContent) {
  metadata.contentStored = contentStored;
}
```

Generic HTTP currently exists only as research documentation in `docs/adapters/generic-http.md`:

```md
## Expected Contract

- Start remote execution.
- Poll or stream status.
- Send input if supported.
- Cancel execution if supported.
- Collect artifacts and transcript.
```

R4 must turn that research note into an implemented `generic_http.async_rest` runtime mode with deterministic tests.

## Product Terms

Process-backed adapter:

- An adapter that starts a local child process and reads stdout/stderr.
- R4 keeps `codex.exec_json` as the only shipped process-backed provider mode.
- R4 extracts reusable substrate code but does not ship a public `generic_process` runtime mode.

HTTP-wrapper-backed adapter:

- An adapter that calls a configured HTTP service which owns the actual execution.
- R4 ships one mode: `generic_http.async_rest`.
- The HTTP wrapper is not a Switchyard hosted worker, not a webhook target, and not ACP. It is a simple loopback or configured HTTP API with create/status/events/cancel/artifacts endpoints.

Transcript:

- The raw or near-raw runtime conversation record that lets an operator reconstruct what the adapter saw.
- Transcript artifacts must be stored through the existing artifact store/content store path for both Codex and Generic HTTP.
- Transcript content must never include secret headers, bearer tokens, full environment dumps, or auth config.

## Runtime Mode Contract

R4 adds one shipped runtime mode:

| Runtime mode slug | Runtime mode id | Provider | Runtime | Adapter id | Adapter type | Kind | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `generic_http.async_rest` | `runtime_mode_generic_http_async_rest` | `provider_generic_http` | `runtime_generic_http` | `generic_http` | `http` | `async_rest` | Configured HTTP wrapper with create/status/events/cancel/artifacts endpoints. |

Seeded registry records:

- Provider: `provider_generic_http`, name `Generic HTTP`, `authMode: "custom"`.
- Runtime: `runtime_generic_http`, name `Generic HTTP`, `adapterType: "http"`, `providerId: "provider_generic_http"`.
- Model: `model_generic_http_default`, provider `provider_generic_http`, modelName `generic-http-default`, `supportsTools: false`, `supportsStreaming: true`, `supportsBrowser: false`.

Run creation inference:

- `runtime: "generic_http"` plus `adapterType: "http"` infers `runtimeMode: "generic_http.async_rest"`.
- Explicit `runtimeMode: "generic_http.async_rest"` must match `runtime: "generic_http"`, `provider: "generic_http"`, and `adapterType: "http"`.
- Explicit internal ids such as `runtime_mode_generic_http_async_rest` remain invalid in public `POST /runs` bodies.

Generic HTTP manifest:

```json
{
  "adapterId": "generic_http",
  "providerId": "provider_generic_http",
  "runtimeId": "runtime_generic_http",
  "runtimeModeId": "runtime_mode_generic_http_async_rest",
  "runtimeModeSlug": "generic_http.async_rest",
  "name": "Generic HTTP async REST",
  "adapterType": "http",
  "kind": "async_rest",
  "capabilities": [
    "run.start",
    "run.cancel",
    "run.timeout",
    "event.normalized",
    "event.streaming",
    "artifact.transcript",
    "auth.none",
    "auth.api_key"
  ],
  "limitations": [
    { "code": "no_post_start_input", "message": "generic_http.async_rest does not support post-start input in R4." },
    { "code": "configured_endpoint_only", "message": "The HTTP wrapper base URL is configured by daemon environment, not per run." },
    { "code": "no_webhooks", "message": "Webhook callbacks are not shipped for Generic HTTP in R4." }
  ],
  "placement": {
    "local": { "support": "conditional", "reason": "Requires SWITCHYARD_GENERIC_HTTP_BASE_URL to point at a reachable HTTP wrapper." },
    "hosted": { "support": "future", "reason": "Hosted execution is not shipped in R4." },
    "connectedLocalNode": { "support": "future", "reason": "Hybrid node execution is not shipped in R4." }
  },
  "docsPath": "docs/development/adapters/GENERIC_HTTP.md",
  "check": {
    "strategy": "http_health",
    "required": ["base_url_configured", "http_health"],
    "optional": ["auth_token_present"]
  }
}
```

Contract update:

- Add `auth.api_key` to `runtimeCapabilitySchema`.
- Do not add `run.input`, `session.resume`, `webhook`, `hosted`, `tool.*`, or approval capabilities in R4.

Availability mapping for `generic_http.async_rest`:

| Condition | State | canRun | installed | auth | reasonCode |
| --- | --- | --- | --- | --- | --- |
| `SWITCHYARD_GENERIC_HTTP_BASE_URL` is absent | `unavailable` | false | false | `unknown` | `generic_http_config_missing` |
| Base URL is invalid or not http/https | `unavailable` | false | false | `unknown` | `generic_http_config_invalid` |
| Health request times out | `unknown` | false | true | `unknown` or `configured` | `check_timeout` |
| Health returns non-2xx | `unavailable` | false | true | `unknown` or `configured` | `generic_http_health_unavailable` |
| Health returns invalid JSON or oversized body | `unknown` | false | true | `unknown` or `configured` | `generic_http_health_invalid` or `check_output_too_large` |
| Health succeeds with no auth token configured | `available` | true | true | `not_required` | null |
| Health succeeds with auth token configured | `available` | true | true | `configured` | null |

The doctor check must never run a model task. It may only call the wrapper health endpoint.

## Generic HTTP Configuration

Daemon environment variables:

| Variable | Required | Default | Behavior |
| --- | --- | --- | --- |
| `SWITCHYARD_GENERIC_HTTP_BASE_URL` | Yes for availability | none | Base URL for the wrapper, for example `http://127.0.0.1:5055`. Missing means mode exists but is unavailable. |
| `SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN` | No | none | If present, sent as `Authorization: Bearer <token>`. It must never be logged, stored in transcripts, or returned by doctor. |
| `SWITCHYARD_GENERIC_HTTP_REQUEST_TIMEOUT_MS` | No | `5000` | Per HTTP request timeout for health, start, status, event polling, cancel, and artifacts. |
| `SWITCHYARD_GENERIC_HTTP_POLL_INTERVAL_MS` | No | `100` | Delay between event/status polls while the wrapper run is not terminal. |
| `SWITCHYARD_GENERIC_HTTP_MAX_RESPONSE_BYTES` | No | `1048576` | Maximum bytes read from any wrapper response before failing the request as oversized. |

Configuration rules:

- `BASE_URL` must use `http:` or `https:`.
- `BASE_URL` may include a path prefix. Endpoint paths are resolved relative to that prefix.
- Run metadata must not override base URL, auth token, request timeout, or max response bytes.
- The adapter must not forward arbitrary user metadata as HTTP headers.
- Logs may include method, URL pathname, status code, duration, run id, external run id, and reason code. Logs must not include auth tokens or full response bodies.
- Transcript entries may include method, URL pathname, status code, duration, wrapper event ids, and sanitized error summaries. Transcript entries must not include auth headers, tokens, local env values, or raw stack traces.

## Generic HTTP Wrapper API

The wrapper API is the contract between Switchyard's Generic HTTP adapter and a simple external runtime wrapper. R4 implements the client side and a fake test server. It does not expose these wrapper endpoints through Switchyard.

### `GET /health`

Request:

```http
GET /health
Authorization: Bearer <token>   # only when SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN is set
```

Success response:

```json
{
  "ok": true,
  "runtime": "fake-http-wrapper",
  "version": "0.1.0",
  "capabilities": ["run.start", "run.cancel", "event.normalized", "artifact.transcript"]
}
```

Rules:

- Non-2xx is `generic_http_health_unavailable`.
- Missing body, invalid JSON, or `ok !== true` is `generic_http_health_invalid`.
- Health response capabilities are diagnostic only in R4. The Switchyard runtime-mode manifest remains the source of truth.

### `POST /v1/runs`

Request body sent by Switchyard:

```json
{
  "switchyardRunId": "run_123",
  "runtimeMode": "generic_http.async_rest",
  "provider": "generic_http",
  "model": "generic-http-default",
  "cwd": "/repo",
  "task": "Summarize this repository.",
  "metadata": {
    "purpose": "local-smoke"
  },
  "timeoutSeconds": 30
}
```

Success response:

```json
{
  "externalRunId": "http_run_123",
  "status": "running",
  "message": "accepted"
}
```

Rules:

- `externalRunId` is required and must be a non-empty string.
- `status` is optional. If present, it must be one of `queued`, `running`, `completed`, `failed`, or `cancelled`.
- Empty `metadata` is sent as `{}`.
- Nil or empty `task` cannot reach the adapter through valid public `POST /runs` because current REST validation requires a non-empty task. Adapter unit tests must still cover missing `task` defensively and fail start with a named error.
- Start non-2xx maps to a failed Switchyard run with error `generic_http_start_failed`.
- Start invalid JSON or missing `externalRunId` maps to a failed Switchyard run with error `generic_http_invalid_start_response`.

### `GET /v1/runs/:externalRunId`

Status response:

```json
{
  "externalRunId": "http_run_123",
  "status": "running",
  "message": "running step 1"
}
```

Terminal failed response:

```json
{
  "externalRunId": "http_run_123",
  "status": "failed",
  "error": {
    "code": "wrapper_failed",
    "message": "The fake wrapper failed deterministically."
  }
}
```

Rules:

- The adapter uses status polling as a fallback when an events poll returns no new events.
- Invalid status JSON fails the Switchyard run with `generic_http_invalid_status_response`.
- A wrapper `failed` status must produce a normalized `run.failed` event if the event stream has not already produced one.
- A wrapper `cancelled` status must produce a normalized terminal `run.cancelled` event if the run was cancelled by Switchyard. If the wrapper is externally cancelled without a Switchyard cancel request, normalize it as `run.failed` with error `generic_http_upstream_cancelled` so the unexpected external state is visible.

### `GET /v1/runs/:externalRunId/events?cursor=<cursor>`

Event response:

```json
{
  "events": [
    {
      "id": "evt_1",
      "type": "status",
      "status": "running",
      "message": "started"
    },
    {
      "id": "evt_2",
      "type": "output",
      "text": "fake http output"
    },
    {
      "id": "evt_3",
      "type": "completed",
      "usage": { "outputTokens": 4 }
    }
  ],
  "nextCursor": "evt_3",
  "terminal": true
}
```

Supported wrapper event types:

| Wrapper event type | Required fields | Switchyard event |
| --- | --- | --- |
| `status` | `status` string | `runtime.status` with `payload.status`, `payload.message`, and `payload.sourceEventId` |
| `output` | `text` string | `runtime.output` with `payload.text` and `payload.sourceEventId` |
| `completed` | none | `run.completed` with `payload.status: "completed"` |
| `failed` | `error` string or object | `run.failed` with sanitized `payload.error` |
| `cancelled` | none | `run.cancelled` only for Switchyard-initiated cancellation; otherwise `run.failed` as above |

Rules:

- Unknown wrapper event types are not ignored. They become `runtime.status` with `payload.status: "unknown_event"` and `payload.sourceType`.
- Duplicate wrapper event ids in one run are ignored after the first occurrence and recorded in the transcript as duplicate input. They must not create duplicate Switchyard events.
- Empty `events: []` is allowed and causes the adapter to continue polling until terminal status or Switchyard timeout.
- Invalid JSON, non-array `events`, missing required event fields, or oversized responses fail the Switchyard run with `generic_http_invalid_events_response`.
- The adapter must yield at most one terminal Switchyard event for a run.

### `POST /v1/runs/:externalRunId/cancel`

Cancel request body:

```json
{
  "switchyardRunId": "run_123",
  "reason": "client_cancelled"
}
```

Success response:

```json
{
  "cancelled": true,
  "status": "cancelled"
}
```

Rules:

- `POST /runs/:id/cancel` in Switchyard calls this wrapper endpoint.
- A 2xx wrapper response is success even if the body is empty.
- Wrapper `404` is not automatically success. The adapter must call status once; if status is terminal, cancellation can finish, otherwise cancellation fails with `generic_http_cancel_failed`.
- Wrapper timeout, connection error, invalid cancel JSON, or non-terminal 4xx/5xx maps to `adapter_protocol_failed` on the public cancel endpoint and the run remains in its previous state.
- Cancel is idempotent after Switchyard has already marked the run terminal.

### `GET /v1/runs/:externalRunId/artifacts`

Artifact response:

```json
{
  "artifacts": [
    {
      "type": "transcript",
      "name": "wrapper-transcript.jsonl",
      "content": "{\"type\":\"runtime.output\",\"text\":\"fake http output\"}\n",
      "metadata": { "source": "wrapper" }
    }
  ]
}
```

Rules:

- R4 supports inline string `content` only. Relative remote download URLs and arbitrary `contentUrl` fetching are out of scope.
- `type` must be a supported Switchyard artifact type. Unknown types become `raw_log` with `metadata.originalType`.
- `name` must be a safe file name, not a path. Unsafe names are replaced with `artifact-<index>.jsonl` and the original name is stored as sanitized metadata.
- Adapter-returned artifact paths must be under `runs/<runId>/generic-http/`.
- The adapter must always provide its own transcript artifact at `runs/<runId>/generic-http-transcript.jsonl` even when the wrapper returns no artifacts.
- Artifact persistence failure after terminalization must not rewrite a completed run to failed; this preserves current runner behavior.

## Shared Runtime Substrates

R4 must extract reusable code from Codex into shared adapter substrate modules under `packages/adapters/src/substrates/`.

Required modules:

- `process-runner.ts`: child process lifecycle, shell-free spawn, stdin close policy, stdout line capture, stderr capture, exit/error resolution, PID exposure, SIGTERM cancellation, and drain.
- `async-line-queue.ts`: generic async queue for line/event streams.
- `jsonl-event-parser.ts`: parser harness that maps raw lines to normalized Switchyard events and fails visibly on invalid JSON or mapper errors.
- `transcript-recorder.ts`: newline-delimited transcript builder with helpers for process stdout/stderr and HTTP request/event records.
- `timeout.ts`: `withTimeout` and abort helpers shared by doctor checks and HTTP adapter calls.

Codex extraction rules:

- `CodexExecJsonAdapter` must continue to launch `codex exec --json` with `shell: false`.
- It must still close child stdin immediately.
- Its public manifest must remain `codex.exec_json`, `adapterType: "process"`, `kind: "one_shot_process"`.
- It must keep rejecting post-start input with the existing Codex unsupported-input behavior at the public REST layer.
- It must keep transcript artifact path `runs/<runId>/codex-transcript.jsonl`.
- It must keep raw stdout JSONL lines and stderr content in the transcript.
- It must keep logging `codex.spawned`, `codex.stderr`, `codex.stdout.first_line`, and `codex.exit` or compatible event names that current local debugging docs can still explain.
- It must keep existing Codex tests passing without calling the real Codex CLI.

Process parser harness rules:

- Empty stdout lines are skipped.
- A valid mapped terminal event stops event yielding for that run.
- Late stdout/stderr after terminal may still be captured in transcript during drain, matching current Codex behavior.
- Invalid JSONL yields exactly one `run.failed` event with a sanitized error and then stops yielding.
- Non-zero process exit without a terminal event yields `run.failed` with exit code and bounded stderr.
- Process cancellation sends SIGTERM once and is safe to call more than once.

No public `generic_process` adapter or mode is shipped in R4.

## Transcript Standard

All adapters must return at least one transcript artifact when a session reached adapter start.

Shared metadata keys:

```json
{
  "runtime": "generic_http",
  "runtimeMode": "generic_http.async_rest",
  "transcriptVersion": "r4.v1"
}
```

Rules:

- `metadata.content` is still the handoff field from adapter to `RuntimeRunnerService`; the runner removes it before storing the artifact record.
- `contentStored: true|false` remains owned by `RuntimeRunnerService`.
- Existing Codex metadata `{ "runtime": "codex", "mode": "exec-json" }` may gain `runtimeMode` and `transcriptVersion`, but must not lose existing keys.
- Transcript content is newline-delimited JSON or runtime-native JSONL where already established.
- Process transcripts can preserve runtime-native stdout lines. HTTP transcripts must use JSON objects with `source`, `type`, and `timestamp` fields.
- HTTP transcripts must record request method/path/status/duration and wrapper event summaries, not secrets or full auth headers.

Example Generic HTTP transcript content:

```jsonl
{"source":"http","type":"request","method":"POST","path":"/v1/runs","status":202,"durationMs":12}
{"source":"http","type":"event","eventType":"status","sourceEventId":"evt_1","status":"running"}
{"source":"http","type":"event","eventType":"output","sourceEventId":"evt_2","text":"fake http output"}
{"source":"http","type":"event","eventType":"completed","sourceEventId":"evt_3"}
```

## Core Lifecycle Expectations

`RuntimeRunnerService` already handles queued, started, terminal events, timeout, artifact persistence, event bus publication, and cancellation. R4 should extend shared behavior only where the new adapter shape requires it.

Required core changes:

- Treat adapter-emitted `run.cancelled` as a terminal event with run status `cancelled`.
- Keep current terminal handling for `run.completed` and `run.failed`.
- Preserve timeout behavior: run status `timeout`, session status `failed`, normalized `run.failed` event payload with `status: "timeout"` and `error: "runtime_timeout"`.
- Add or reuse shared timeout helper so doctor checks and HTTP requests are bounded consistently.
- Add a general adapter protocol error class or code path so unsupported input and failed adapter actions can map to `409 adapter_protocol_failed` without Codex-specific checks.

Public REST behavior:

- `POST /runs?wait=1` for Generic HTTP returns `{run, response}` the same way fake and Codex do.
- Async `POST /runs` returns `202 {run}` and launches in the background.
- `GET /runs/:id/events` streams the same normalized event types.
- `GET /runs/:id/artifacts`, `GET /artifacts/:id`, and `GET /artifacts/:id/content` work for Generic HTTP transcript artifacts.
- `POST /runs/:id/input` returns `409 adapter_protocol_failed` for Generic HTTP in R4.
- `POST /runs/:id/cancel` cancels Generic HTTP runs through the wrapper cancel endpoint and returns `{run}` only after Switchyard has persisted `cancelled`.

## Fake HTTP Wrapper Test Server

R4 must add a deterministic fake HTTP wrapper test server. It is a test utility, not a product daemon.

Boundaries:

- Target file: `packages/testkit/src/fake-http-runtime-server.ts`.
- Uses loopback on an ephemeral port.
- Does not call external network services.
- Does not require auth by default; can assert bearer auth when started with an expected token.
- Stores fake run state in memory only.
- Exposes exactly the wrapper API endpoints defined in this spec.
- Provides deterministic scenario controls through helper options, not through public Switchyard API expansion.
- Exposes a dev-only package script for manual smoke: `pnpm --filter @switchyard/testkit fake-http-runtime -- --host 127.0.0.1 --port 5055`.

Required fake scenarios:

| Scenario | Behavior |
| --- | --- |
| happy | Health succeeds, start returns external id, events yield status/output/completed, artifacts include inline transcript, Switchyard run completes. |
| empty_events | Events return empty arrays until status reports completed, Switchyard still completes. |
| upstream_failed | Events or status report failed, Switchyard emits `run.failed`. |
| start_http_500 | Start returns 500, Switchyard run fails with `generic_http_start_failed`. |
| invalid_start_json | Start returns malformed or missing `externalRunId`, Switchyard run fails with `generic_http_invalid_start_response`. |
| invalid_events_json | Events endpoint returns invalid shape, Switchyard run fails with `generic_http_invalid_events_response`. |
| cancellation | Cancel endpoint returns success, Switchyard persists `cancelled` and emits `run.cancelled`. |
| cancel_failure | Cancel endpoint fails, public cancel returns `409 adapter_protocol_failed` and run is not silently marked cancelled. |
| timeout_no_terminal | Wrapper never reaches terminal state, Switchyard timeout path cancels upstream and marks run `timeout`. |
| unsafe_artifact_name | Wrapper returns unsafe artifact name, adapter stores a safe path and records sanitized original name. |
| missing_base_url | No base URL config, runtime mode exists but doctor reports unavailable. |

## Stronger Adapter Contract Tests

The existing `packages/core/test/runtime-adapter-contract.test.ts` proves only the minimal interface. R4 must turn this into a reusable contract harness that fake, Codex, and Generic HTTP can satisfy without real external services.

Contract dimensions:

- Manifest exists and parses into a runtime mode record.
- Check returns a bounded result and does not execute model work.
- Start returns a session id and optional external session key/process id.
- Events yield normalized `SwitchyardEvent` objects with exactly one terminal event.
- Unsupported input fails with a named adapter protocol error when the manifest does not declare input support.
- Cancel is idempotent and either succeeds visibly or fails visibly.
- Artifacts include at least one transcript artifact after start.
- Artifact paths are safe relative paths.
- Transcript content is persisted through the runner when an artifact content store is configured.
- Nil, empty, and upstream-error paths are tested for each adapter shape.

Adapter-specific contract runs:

- Fake runtime uses in-memory deterministic behavior.
- Codex uses fake process factories and must not call real `codex`.
- Generic HTTP uses the fake HTTP wrapper server.

## Data Flow Shadow Paths

Every implementation task should cover these paths.

### Process stdout/stderr to normalized events

Happy:

- Codex fake process emits valid JSONL stdout with status, output, and terminal completion.
- Parser harness maps events to `runtime.status`, `runtime.output`, and `run.completed`.
- Transcript includes raw stdout and stderr.

Nil:

- Process factory returns a child without a numeric PID.
- Session still starts without `processId`, events still stream, transcript still stores.

Empty:

- stdout emits empty lines only before exit.
- Empty lines are skipped; non-zero exit without terminal yields `run.failed`, zero exit without terminal yields no false completion and the runner returns latest state according to existing behavior or timeout.

Error:

- stdout emits invalid JSONL.
- Adapter yields one `run.failed`, captures invalid line plus stderr in transcript, and stops yielding.

### Generic HTTP config to doctor check

Happy:

- `SWITCHYARD_GENERIC_HTTP_BASE_URL` points to fake server and health returns `{ "ok": true }`.
- Runtime mode reports `available`, `canRun: true`.

Nil:

- Base URL env is missing.
- Runtime mode is still seeded, but availability is `unavailable` with `generic_http_config_missing`.

Empty:

- Base URL env is an empty string.
- Treat as missing config, not as `http://`.

Error:

- Health times out, connection is refused, response is non-2xx, invalid JSON, or oversized.
- Doctor returns bounded sanitized `unknown` or `unavailable`, not a thrown 500 for expected wrapper unavailability.

### Switchyard run request to wrapper start

Happy:

- Public `POST /runs?wait=1` for `generic_http` creates a queued run, infers `generic_http.async_rest`, posts the wrapper start body, stores `externalSessionKey`, and completes.

Nil:

- Optional public `metadata` is absent.
- Wrapper receives `{}` and no undefined fields are required.

Empty:

- Public metadata is `{}` and wrapper start response has no optional message.
- Run still starts and events drive lifecycle.

Error:

- Wrapper start returns 500, invalid JSON, or no `externalRunId`.
- Switchyard run becomes failed with named error; no silent queued/running hang.

### Wrapper events and status to Switchyard events

Happy:

- Wrapper events return status, output, completed.
- Switchyard events are normalized, sequenced by runner, and stream through existing SSE.

Nil:

- Event ids are absent.
- Adapter derives stable per-run cursors from poll order and records `sourceEventId` only when present.

Empty:

- Events endpoint returns `events: []`.
- Adapter polls status and continues until terminal or timeout.

Error:

- Events response is malformed, oversized, duplicate terminal, or has invalid required fields.
- Adapter fails the run with a named error and records the response summary in transcript.

### Wrapper artifacts to Switchyard artifacts

Happy:

- Wrapper returns inline transcript artifact and adapter also returns Generic HTTP transcript.
- Runner stores content and emits `artifact.created`.

Nil:

- Wrapper artifact metadata is absent.
- Adapter uses `{}` and still returns safe artifact records.

Empty:

- Wrapper returns `artifacts: []`.
- Adapter still returns `generic-http-transcript.jsonl`.

Error:

- Wrapper artifact name is unsafe, type is unknown, or artifact response is malformed.
- Unsafe names are sanitized; unknown types become `raw_log`; malformed artifacts fail artifact collection without changing an already terminal run to failed.

### Cancellation and timeout

Happy:

- User calls `POST /runs/:id/cancel`, adapter posts wrapper cancel, runner marks run `cancelled`, session `cancelled`, and emits `run.cancelled`.

Nil:

- Cancel response body is absent on 2xx.
- Treat cancel as accepted and let runner persist cancellation.

Empty:

- Cancel response is `{}` on 2xx.
- Treat cancel as accepted.

Error:

- Cancel endpoint times out or returns non-terminal failure.
- Public endpoint returns `409 adapter_protocol_failed`; run is not silently marked cancelled.

## Test Requirements

Contracts:

- Add `auth.api_key` to runtime capability schema and negative tests for unsupported capability strings.
- Parse the full `generic_http.async_rest` runtime mode record.
- Extend run/runtime-mode inference tests for `generic_http` plus adapter type `http`.
- Reject explicit Generic HTTP runtime mode mismatches and internal ids.

Substrates:

- Process runner tests cover shell-free spawn options, stdin close, stdout line capture, stderr capture, process error, non-zero exit, cancellation, and drain.
- JSONL parser harness tests cover valid events, empty lines, parse error, mapper error, terminal stop, and late transcript capture.
- Timeout helper tests cover success, timeout, abort propagation, and cleanup.
- Transcript recorder tests cover process and HTTP entries and prove secrets are redacted or never accepted.

Codex regression:

- Existing Codex adapter tests continue to pass.
- Codex args, metadata validation, unsupported input, non-zero exit, invalid JSONL, timeout, late output capture, and transcript path are unchanged.
- No test calls real Codex.

Generic HTTP adapter:

- Manifest exposes `generic_http.async_rest` with HTTP adapter type and R4 limitations.
- Check covers missing config, invalid config, health success, health non-2xx, health timeout, invalid health JSON, oversized health response, and optional auth token.
- Start/events/artifacts/cancel use fake HTTP server.
- Happy path completes with normalized status/output/completed events and transcript artifact.
- Failure path emits `run.failed`.
- Cancellation path emits `run.cancelled`.
- Timeout path attempts upstream cancel and marks run `timeout`.
- Unsafe artifact names are sanitized.
- Unsupported input returns adapter protocol error.

Core:

- Runner terminalizes adapter-emitted `run.cancelled` without regressing completed/failed behavior.
- Adapter protocol errors map to `409 adapter_protocol_failed` for unsupported input and cancel failure.
- Artifact persistence still stores content out-of-line and does not leak `metadata.content`.
- Existing fake and Codex run lifecycle tests pass.

REST and daemon:

- Daemon seeds Generic HTTP provider/runtime/model/runtime-mode records.
- `GET /runtime-modes/generic_http.async_rest` works by slug.
- `POST /runtime-modes/generic_http.async_rest/check` reports missing config as unavailable and fake-server config as available.
- `GET /doctor` counts Generic HTTP availability.
- `POST /runs?wait=1` can run `generic_http` against fake server in tests.
- `GET /runs/:id/artifacts` and artifact content endpoints expose Generic HTTP transcript content.
- Existing fake and Codex daemon smoke tests keep passing.

Docs checked by release implementation:

- `PRODUCT.md`
- `CHANGELOG.md`
- `ARCHITECTURE.md`
- `docs/development/API.md`
- `docs/development/DEVELOPMENT.md`
- `docs/development/adapters/README.md`
- `docs/development/adapters/CODEX.md`
- `docs/development/adapters/GENERIC_HTTP.md`
- `docs/adapters/README.md`
- `docs/adapters/generic-http.md`

## Local Verification Commands

Focused checks:

```bash
git diff --check
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/testkit test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test
```

Full workspace checks before promotion:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

Generic HTTP manual smoke command that R4 must make valid:

```bash
# Terminal 1: start the dev-only fake wrapper. The implementation must add this testkit script.
pnpm --filter @switchyard/testkit fake-http-runtime -- --host 127.0.0.1 --port 5055

# Terminal 2: start Switchyard against that wrapper.

SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-r4-generic-http \
SWITCHYARD_GENERIC_HTTP_BASE_URL=http://127.0.0.1:5055 \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

In another shell:

```bash
BASE=http://127.0.0.1:4546

curl -s "$BASE/runtime-modes/generic_http.async_rest" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/generic_http.async_rest/check" | python3 -m json.tool

RUN_ID=$(curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"generic_http","provider":"generic_http","model":"generic-http-default","adapterType":"http","cwd":"/repo","task":"r4 http smoke","timeoutSeconds":30}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["run"]["id"])')

curl -s "$BASE/runs/$RUN_ID/events" | head -n 20
curl -s "$BASE/runs/$RUN_ID/artifacts" | python3 -m json.tool
```

Codex regression smoke:

```bash
pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter
pnpm --filter @switchyard/daemon test
```

## Promotion Criteria

R4 is done only when:

- `codex.exec_json` still passes existing tests and smoke checks after process substrate extraction.
- Process-backed adapter code no longer owns generic process queue, drain, transcript, timeout, and JSONL harness logic inline.
- Generic HTTP is registered as `generic_http.async_rest` and appears in runtime mode and doctor APIs.
- Generic HTTP can complete, fail, cancel, timeout, and produce output/artifacts against the fake HTTP wrapper server.
- Transcript artifacts are stored for both Codex and Generic HTTP runs.
- Adapter contract tests are reusable and run against process and HTTP adapter shapes.
- New adapter work has a documented substrate path instead of copying Codex-specific process code.
- Product/API/development docs are updated during implementation closeout to say Generic HTTP is shipped and ACP/PTY/interactive Codex remain unshipped.

## Implementation Slices For CTO Planning

### Slice 1: Shared Runtime Substrates And Contract Harness

Goal: Extract reusable process, parser, timeout, transcript, and adapter-contract utilities while keeping Codex behavior unchanged.

Acceptance:

- Codex adapter delegates generic process plumbing to substrate modules.
- Codex public behavior, transcript path, logging semantics, and tests remain compatible.
- Reusable adapter contract harness exists and covers fake plus Codex with fake process.
- Focused checks pass for `@switchyard/adapters`, `@switchyard/core`, and `@switchyard/testkit`.

Non-goals:

- No public generic process adapter.
- No Generic HTTP adapter yet in this slice unless CTO chooses to land substrate helpers in the same task graph dependency order.

Complexity: L

### Slice 2: Generic HTTP Adapter, Fake Server, And Runtime Mode

Goal: Add `generic_http.async_rest`, fake HTTP wrapper coverage, HTTP wrapper contract validation, and normalized lifecycle behavior.

Acceptance:

- Generic HTTP manifest, check, start, events, cancel, tools, and artifacts methods satisfy the adapter contract.
- Fake HTTP wrapper server covers happy, empty, failure, cancellation, timeout, invalid JSON, and artifact safety scenarios.
- Runtime-mode inference and registry/doctor seeding work for `generic_http.async_rest`.
- Generic HTTP transcript artifact is stored through the existing content store path.

Non-goals:

- No webhooks.
- No per-run endpoint override.
- No remote artifact URL fetching.
- No post-start input support.

Complexity: L

### Slice 3: Daemon, REST, Docs, And End-To-End Verification

Goal: Wire Generic HTTP into the daemon and update owner-facing/local-development docs so users can verify one process mode and one HTTP wrapper mode.

Acceptance:

- Daemon tests run Generic HTTP against fake wrapper config.
- Runtime mode, doctor, run lifecycle, cancellation, output, failure, timeout, and artifact REST paths are covered.
- Local development docs include copy-paste Generic HTTP smoke commands.
- `PRODUCT.md` and `CHANGELOG.md` are updated during implementation closeout.
- Full workspace checks pass before promotion.

Non-goals:

- No PR creation in native TUI workflow.
- No hosted deployment instructions.

Complexity: M

## Decisions And Risks

Decisions:

- R4 ships `generic_http.async_rest`, not `generic_http.sync`, because cancellation/status/failure normalization needs an external run id and polling lifecycle.
- Generic HTTP base URL is daemon configuration only. Per-run base URL overrides are excluded for security and reproducibility.
- R4 supports inline wrapper artifact content only. Fetching arbitrary remote artifact URLs is deferred to avoid SSRF and content-type ambiguity.
- `auth.api_key` is added as a capability string, but R4 only supports a single daemon-level bearer token, not per-user or per-run auth.
- Codex transcript path stays `runs/<runId>/codex-transcript.jsonl`.
- Adapter-emitted `run.cancelled` becomes a first-class terminal event in the runner.

Risks:

- Extracting Codex process code can regress subtle behavior such as stdin closure, late stderr capture, or invalid JSONL failure ordering. Keep Codex regression tests as the first gate.
- Generic HTTP can become too generic too quickly. R4 must keep one strict wrapper contract and avoid webhook, arbitrary endpoint maps, dynamic auth, or remote artifact fetching.
- Cancel failure semantics currently are less generalized than input errors. R4 needs a shared adapter protocol error path so cancel failures are visible without marking runs cancelled incorrectly.
- Runtime capability strings can sprawl. Add only `auth.api_key` in R4 and avoid transport-specific capability noise unless tests prove it is required.
- The fake HTTP server must not become a second daemon product. Keep it in testkit and docs as deterministic verification support.
