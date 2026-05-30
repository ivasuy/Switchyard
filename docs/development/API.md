# Official API Contract

This is the current local daemon API contract. It documents what an app can call today.

Base URL:

```text
http://127.0.0.1:4545
```

Current implementation status:

- Implemented: health, runs (create/get/list), run events (replay-only, bounded live, open-ended live), run artifacts (per-run listing, global metadata, content), run input, run cancellation, registry lookups (single-record and listing).
- Implemented runtimes: fake test runtime (`fake.deterministic`), local Codex (`codex.exec_json`), Generic HTTP async REST wrapper (`generic_http.async_rest`), and local OpenCode ACP (`opencode.acp`).
- Not implemented yet: trace endpoint, OpenAPI generation, debates, approvals expansion, memory, tools expansion, hosted workers, hosted/hybrid placement, dashboards, TUI, authentication, rate limiting, PTY, interactive Codex sessions, webhooks, per-run HTTP base URL overrides, and remote artifact URL fetching.

## Error Contract

Every 4xx and 5xx response uses one envelope:

```json
{
  "error": {
    "code": "snake_case_machine_code",
    "message": "human-readable explanation",
    "details": [
      { "path": "limit", "issue": "must be <= 200" }
    ]
  }
}
```

`details` is optional and is only present on validation failures.

Closed code set:

| Code | HTTP | Used for |
| --- | --- | --- |
| `run_not_found` | 404 | Unknown run id. |
| `artifact_not_found` | 404 | Unknown artifact id. |
| `missing_artifact_content` | 404 | Artifact exists, content unavailable. |
| `provider_not_found` | 404 | Unknown provider id or slug. |
| `runtime_not_found` | 404 | Unknown runtime id or slug. |
| `runtime_mode_not_found` | 404 | Unknown runtime mode id or slug. |
| `model_not_found` | 404 | Unknown model id or slug. |
| `invalid_input` | 400 | Malformed body. |
| `invalid_query` | 400 | Malformed or out-of-range query parameter. |
| `adapter_protocol_failed` | 409 | Adapter cannot perform the requested action. |
| `internal_error` | 500 | Unexpected server failure. |

All success bodies (`{run, events}`, `{accepted: true}`, etc.) are unchanged.

## Status Codes

| Status | Meaning |
| --- | --- |
| `200` | Query succeeded. |
| `201` | Run created and completed synchronously through `wait=1`. |
| `202` | Run accepted and launched asynchronously, or input accepted. |
| `400` | Validation failure on the body or query string. |
| `404` | Requested run/artifact/provider/runtime/model is not found. |
| `409` | Request is valid, but the selected adapter cannot perform it. |
| `500` | Unexpected server failure. |

## Run Object

```json
{
  "id": "run_...",
  "runtime": "codex",
  "provider": "openai",
  "model": "gpt-5.5",
  "adapterType": "process",
  "runtimeMode": "codex.exec_json",
  "cwd": "/Users/example/project",
  "task": "Return one sentence describing this repository.",
  "status": "completed",
  "placement": "local",
  "approvalPolicy": "default",
  "timeoutSeconds": 120,
  "metadata": {},
  "createdAt": "2026-05-14T15:53:28.542Z",
  "startedAt": "2026-05-14T15:53:28.543Z",
  "endedAt": "2026-05-14T15:53:49.249Z"
}
```

Run statuses:

```text
queued
starting
running
waiting_for_input
waiting_for_approval
completed
failed
cancelled
timeout
```

Adapter types:

```text
native
acpx
http
webhook
process
pty
browser
```

## Health

```bash
curl -s http://127.0.0.1:4545/health
```

## Create Run

Async:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs" \
  -H 'content-type: application/json' \
  -d '{
    "runtime": "codex",
    "provider": "openai",
    "model": "gpt-5.5",
    "adapterType": "process",
    "runtimeMode": "codex.exec_json",
    "cwd": "/Users/vasuyadav/Downloads/Projects/switchyard",
    "task": "Return one sentence describing this repository. Do not edit files.",
    "timeoutSeconds": 120
  }'
```

Synchronous wait-for-completion:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{ "runtime": "fake", "provider": "test", "model": "test-model", "adapterType": "process", "cwd": "/repo", "task": "Smoke" }'
```

`POST /runs?wait=1` returns `{run, response}` where `response.text` is the last normalized `runtime.output`. Async create returns `{run}` and the daemon launches the run in the background.

`runtimeMode` is optional. If omitted, the daemon infers shipped runtime modes:

- `runtime: "fake"` -> `runtimeMode: "fake.deterministic"`
- `runtime: "codex"` and `adapterType: "process"` -> `runtimeMode: "codex.exec_json"`
- `runtime: "generic_http"` and `adapterType: "http"` -> `runtimeMode: "generic_http.async_rest"`
- `runtime: "opencode"` and `adapterType: "acpx"` -> `runtimeMode: "opencode.acp"`

When provided, `runtimeMode` must be a runtime-mode slug (for example `codex.exec_json`), not an internal id like `runtime_mode_codex_exec_json`.
For OpenCode specifically, `runtime_mode_opencode_acp` is rejected with `400 invalid_input`; use slug `opencode.acp` or omit `runtimeMode` and let inference apply.

Generic HTTP create payload example:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{
    "runtime": "generic_http",
    "provider": "generic_http",
    "model": "generic-http-default",
    "adapterType": "http",
    "cwd": "/repo",
    "task": "generic http smoke",
    "timeoutSeconds": 30
  }'
```

OpenCode ACP create payload example:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{
    "runtime": "opencode",
    "provider": "opencode",
    "model": "opencode-default",
    "adapterType": "acpx",
    "cwd": "/repo",
    "task": "Return one short sentence.",
    "timeoutSeconds": 30
  }'
```

`opencode-default` means OpenCode's current configured model; R5 does not select OpenCode models per run.

## Get Run

```bash
RUN_ID=run_replace_me
curl -s "http://127.0.0.1:4545/runs/$RUN_ID"
```

Returns `{run, events}` with every persisted event.

## List Runs

```bash
curl -s "http://127.0.0.1:4545/runs?limit=50"
```

Response:

```json
{
  "runs": [ /* Run objects, newest first */ ],
  "nextCursor": "base64-opaque-or-null"
}
```

Sort order is `createdAt DESC, id DESC`. `nextCursor` is opaque; pass it back as `?before=...` to page.

Query parameters:

| Name | Type | Notes |
| --- | --- | --- |
| `status` | CSV of run status enum | Unknown values → `400 invalid_query`. |
| `runtime` | CSV of runtime slugs | E.g. `codex,fake`. |
| `provider` | CSV of provider slugs | E.g. `openai`. |
| `model` | CSV of model slugs | E.g. `gpt-5.5`. |
| `placement` | CSV of placement values | Currently always `local`. |
| `adapterType` | CSV of adapter types | `native,acpx,http,webhook,process,pty,browser`. |
| `since` | ISO-8601 timestamp | Inclusive lower bound on `createdAt`. |
| `until` | ISO-8601 timestamp | Exclusive upper bound on `createdAt`. |
| `limit` | integer | Default `50`, max `200`. |
| `before` | opaque cursor | From a previous response's `nextCursor`. |

Well-formed-but-unknown slug filter values match zero rows (200 with empty array). Empty result still returns `nextCursor: null`.

## Get Run Events

Three modes on the same endpoint:

| Query | Behavior |
| --- | --- |
| _(none)_ | Replay-only. SSE response of every persisted event, then connection closes. |
| `?live=1` | Replay-then-live. Replays persisted events, then keeps the connection open and streams new events as they reach the event bus. |
| `?live=1&stopAfter=N` | Bounded replay-then-live. Closes after `N` total events. |

```bash
RUN_ID=run_replace_me
curl -N "http://127.0.0.1:4545/runs/$RUN_ID/events?live=1"
```

Open-ended SSE contract:

- Response `Content-Type` is `text/event-stream; charset=utf-8`.
- Server emits an SSE comment heartbeat (`:\n\n`) every 15 seconds on otherwise-idle connections.
- Server closes the connection after 5 minutes with no events (idle timeout) with a clean `event: stream.idle` marker followed by EOF.
- On client disconnect, the server unsubscribes from the event bus and releases resources within 1 second.

Resumption: clients reconnect with the standard SSE `Last-Event-ID` header to receive only events with id greater than the supplied id. Resumption applies to all three modes.

## Get Run Artifacts

```bash
RUN_ID=run_replace_me
curl -s "http://127.0.0.1:4545/runs/$RUN_ID/artifacts"
```

Returns `{ artifacts: [ ... ] }`.

## Get Artifact

```bash
ARTIFACT_ID=artifact_replace_me
curl -s "http://127.0.0.1:4545/artifacts/$ARTIFACT_ID"
```

Returns:

```json
{
  "artifact": {
    "id": "artifact_...",
    "runId": "run_...",
    "type": "transcript",
    "path": "runs/run_.../transcript.jsonl",
    "metadata": { "contentStored": true },
    "createdAt": "..."
  }
}
```

Errors: `404 artifact_not_found`.

## Get Artifact Content

```bash
ARTIFACT_ID=artifact_replace_me
curl -s "http://127.0.0.1:4545/artifacts/$ARTIFACT_ID/content"
```

- Response `Content-Type` is chosen per artifact type:
  - `transcript` → `application/x-ndjson`
- Body is the raw stored content; no JSON wrapping.
- `HEAD` and `Range` requests are **not** supported.

Errors: `404 artifact_not_found`; if the record exists but `metadata.contentStored=false` or the backing file is missing, `404 missing_artifact_content`.

## List Providers / Runtimes / Models

```bash
curl -s "http://127.0.0.1:4545/providers?limit=50"
curl -s "http://127.0.0.1:4545/runtimes?provider=openai"
curl -s "http://127.0.0.1:4545/models?provider=openai"
```

Filter rules:

| Endpoint | Filters |
| --- | --- |
| `GET /providers` | `limit`, `before` |
| `GET /runtimes` | `provider` (CSV slug), `adapterType` (CSV), `limit`, `before` |
| `GET /models` | `provider` (CSV slug), `limit`, `before` — when `provider` is omitted, orphan models are included |

Responses:

```json
{ "providers": [ /* records */ ], "nextCursor": "...|null" }
{ "runtimes":  [ /* records */ ], "nextCursor": "...|null" }
{ "models":    [ /* records */ ], "nextCursor": "...|null" }
```

Registry list endpoints are shipped and return records as stored. Runtime capability and health reporting are also shipped through runtime-mode and doctor endpoints.

## Runtime Mode APIs

```bash
curl -s "http://127.0.0.1:4545/runtime-modes?provider=openai&availability=available"
curl -s "http://127.0.0.1:4545/runtime-modes/runtime_mode_codex_exec_json"
curl -s "http://127.0.0.1:4545/runtime-modes/codex.exec_json"
curl -s -X POST "http://127.0.0.1:4545/runtime-modes/codex.exec_json/check"
curl -s "http://127.0.0.1:4545/runtime-modes/opencode.acp"
curl -s -X POST "http://127.0.0.1:4545/runtime-modes/opencode.acp/check"
curl -s "http://127.0.0.1:4545/doctor"
```

Runtime mode list filters:

| Endpoint | Filters |
| --- | --- |
| `GET /runtime-modes` | `provider`, `runtime`, `adapterType`, `kind`, `availability`, `placement`, `capability`, `limit`, `before` |

`GET /doctor` is read-only and returns the latest stored snapshots. `POST /runtime-modes/:id/check` runs a fresh bounded check and updates stored availability.

OpenCode check behavior:

- runs `opencode --version`, ACP `initialize`, and ACP `session/new`.
- does not send ACP `session/prompt` (no model-budget spend during doctor checks).

Example `GET /runtime-modes?provider=openai` response:

```json
{
  "runtimeModes": [
    {
      "id": "runtime_mode_codex_exec_json",
      "slug": "codex.exec_json",
      "name": "Codex exec JSON",
      "providerId": "provider_openai",
      "runtimeId": "runtime_codex",
      "adapterId": "codex",
      "adapterType": "process",
      "kind": "one_shot_process",
      "status": "partial",
      "capabilities": [
        "run.start",
        "run.cancel",
        "run.timeout",
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "artifact.raw_transcript",
        "model.catalog",
        "auth.local",
        "sandbox.read_only",
        "sandbox.workspace_write",
        "sandbox.danger_full_access"
      ],
      "limitations": [
        { "code": "one_shot_no_input", "message": "No post-start interactive input support in R3." }
      ],
      "placement": {
        "local": { "support": "supported", "reason": "Requires a PATH-reachable local codex binary and local workspace." },
        "hosted": { "support": "unsupported", "reason": "Hosted subprocess execution is not shipped in R3." },
        "connectedLocalNode": { "support": "future", "reason": "Hybrid node execution is planned for R10." }
      },
      "availability": {
        "state": "partial",
        "canRun": true,
        "installed": true,
        "auth": "configured",
        "version": "codex 0.0.0-test",
        "checkedAt": "2026-05-30T00:00:00.000Z",
        "reasonCode": "optional_check_failed",
        "message": "Optional runtime checks failed."
      },
      "docsPath": "docs/development/adapters/CODEX.md",
      "createdAt": "2026-05-30T00:00:00.000Z",
      "updatedAt": "2026-05-30T00:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Example `GET /runtime-modes/codex.exec_json` response:

```json
{
  "runtimeMode": {
    "id": "runtime_mode_codex_exec_json",
    "slug": "codex.exec_json",
    "name": "Codex exec JSON",
    "providerId": "provider_openai",
    "runtimeId": "runtime_codex",
    "adapterId": "codex",
    "adapterType": "process",
    "kind": "one_shot_process",
    "status": "partial",
    "capabilities": [
      "run.start",
      "run.cancel",
      "run.timeout",
      "event.normalized",
      "event.streaming",
      "artifact.transcript",
      "artifact.raw_transcript",
      "model.catalog",
      "auth.local",
      "sandbox.read_only",
      "sandbox.workspace_write",
      "sandbox.danger_full_access"
    ],
    "limitations": [
      { "code": "one_shot_no_input", "message": "No post-start interactive input support in R3." }
    ],
    "placement": {
      "local": { "support": "supported", "reason": "Requires a PATH-reachable local codex binary and local workspace." },
      "hosted": { "support": "unsupported", "reason": "Hosted subprocess execution is not shipped in R3." },
      "connectedLocalNode": { "support": "future", "reason": "Hybrid node execution is planned for R10." }
    },
    "availability": {
      "state": "partial",
      "canRun": true,
      "installed": true,
      "auth": "configured",
      "version": "codex 0.0.0-test",
      "checkedAt": "2026-05-30T00:00:00.000Z",
      "reasonCode": "optional_check_failed",
      "message": "Optional runtime checks failed."
    },
    "docsPath": "docs/development/adapters/CODEX.md",
    "createdAt": "2026-05-30T00:00:00.000Z",
    "updatedAt": "2026-05-30T00:00:00.000Z"
  }
}
```

Example `POST /runtime-modes/codex.exec_json/check` response:

```json
{
  "check": {
    "runtimeModeId": "runtime_mode_codex_exec_json",
    "runtimeMode": "codex.exec_json",
    "providerId": "provider_openai",
    "runtimeId": "runtime_codex",
    "state": "partial",
    "canRun": true,
    "installed": true,
    "auth": "configured",
    "version": "codex 0.0.0-test",
    "checkedAt": "2026-05-30T00:00:00.000Z",
    "reasonCode": "optional_check_failed",
    "message": "Optional runtime checks failed.",
    "capabilities": ["run.start", "run.cancel", "run.timeout", "event.normalized", "model.catalog", "auth.local"],
    "limitations": [{ "code": "one_shot_no_input", "message": "No post-start interactive input support in R3." }],
    "diagnostics": [
      {
        "code": "sandbox_policy_probe",
        "severity": "warning",
        "message": "optional sandbox probe failed"
      }
    ]
  }
}
```

Example `GET /doctor` response:

```json
{
  "runtimeModes": [
    {
      "runtimeModeId": "runtime_mode_fake_deterministic",
      "runtimeMode": "fake.deterministic",
      "state": "available",
      "canRun": true,
      "checkedAt": "2026-05-30T00:00:00.000Z"
    },
    {
      "runtimeModeId": "runtime_mode_codex_exec_json",
      "runtimeMode": "codex.exec_json",
      "state": "partial",
      "canRun": true,
      "checkedAt": "2026-05-30T00:00:00.000Z"
    }
  ],
  "summary": {
    "available": 1,
    "installed": 0,
    "partial": 1,
    "unavailable": 0,
    "unsupported": 0,
    "unknown": 0
  }
}
```

Availability states:

```text
available
installed
partial
unavailable
unsupported
unknown
```

`partial` means required checks passed and at least one optional check failed. Timeout/oversized-output failures are bounded and return sanitized `unknown` or `unavailable` responses instead of hanging.

## Single-Record Registry Lookups

```bash
curl -s http://127.0.0.1:4545/providers/provider_openai
curl -s http://127.0.0.1:4545/runtimes/runtime_codex
curl -s http://127.0.0.1:4545/models/model_gpt_5_5
```

Slug shortcuts are accepted as well (e.g. `openai`, `codex`, `gpt_5_5`).

## Send Input

```bash
RUN_ID=run_replace_me
curl -s -X POST "http://127.0.0.1:4545/runs/$RUN_ID/input" \
  -H 'content-type: application/json' \
  -d '{"text":"continue"}'
```

Success returns `{"accepted":true}`. `codex.exec_json`, `generic_http.async_rest`, and `opencode.acp` return `409 adapter_protocol_failed` for post-start input.

For OpenCode input failures, response details include `reasonCode: opencode_input_unsupported`.

## Cancel Run

```bash
RUN_ID=run_replace_me
curl -s -X POST "http://127.0.0.1:4545/runs/$RUN_ID/cancel"
```

Cancellation semantics:

- Cancel is idempotent for terminal runs.
- For `generic_http.async_rest`, an upstream 2xx cancel acknowledgement alone is not terminal.
- For `opencode.acp`, cancellation is only accepted after ACP verifies `stopReason:"cancelled"`.
- Switchyard reports `cancelled` only after the adapter verifies terminal `cancelled` state.
- Unverified or failed cancellation returns `409 adapter_protocol_failed` and keeps the previous run state.
- OpenCode unverified cancel uses `reasonCode: acp_cancel_unverified`.

Generic HTTP and OpenCode transcripts are exposed through the existing artifact APIs:

- `GET /runs/:id/artifacts`
- `GET /artifacts/:id`
- `GET /artifacts/:id/content`

## Codex Metadata

| Key | Example | Notes |
| --- | --- | --- |
| `reasoningEffort` | `"low"` | Validated against the local model catalog when available. |
| `reasoningSummary` | `"auto"` | Passed through to Codex config overrides. |
| `verbosity` | `"low"` | Passed through to Codex config overrides. |
| `sandbox` | `"read-only"` | Passed to `codex exec --sandbox`. |
| `ignoreUserConfig` | `true` | Defaults to `true` for daemon-launched Codex runs. |
| `ignoreRules` | `false` | Defaults to `false`. |

See [Codex Adapter Local Development](adapters/CODEX.md) for Codex-specific logs, PID checks, and stuck-run diagnosis.
