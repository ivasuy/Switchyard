# Generic HTTP Adapter Local Development

This guide is for the shipped `generic_http.async_rest` runtime mode in R4.

Use [Official API Contract](../API.md) for endpoint payloads and [Local Development](../DEVELOPMENT.md) for daemon startup basics.

## Shipped Scope

Implemented:

- Runtime mode slug `generic_http.async_rest`.
- Daemon-configured async REST wrapper integration (start, status, events, cancel, artifacts).
- Runtime mode check strategy `http_health`.
- Transcript artifact capture at `runs/<runId>/generic-http-transcript.jsonl`.
- Verified-terminal cancellation semantics.
- Conditional R25 hosted input/approval bridge support through existing hosted runtime bridge command/payload stores when wrapper config and advertised bridge capabilities are ready.

Not shipped:

- Per-run base URL overrides.
- Per-run auth token overrides.
- Arbitrary wrapper endpoint execution.
- Hosted active cancel bridge.
- Webhook callbacks.
- Remote artifact URL fetching.
- ACP, PTY, interactive Codex, memory, tool expansion, TUI, and dashboard.

## Environment Variables

All Generic HTTP settings are daemon-level:

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `SWITCHYARD_GENERIC_HTTP_BASE_URL` | _(unset)_ | Conditional | Must be `http://` or `https://`. Missing value reports `generic_http_config_missing`. |
| `SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN` | _(unset)_ | No | Sent as `Authorization: Bearer <token>` when provided. |
| `SWITCHYARD_GENERIC_HTTP_REQUEST_TIMEOUT_MS` | `5000` | No | Per-request timeout for health/start/status/events/cancel/artifacts. |
| `SWITCHYARD_GENERIC_HTTP_POLL_INTERVAL_MS` | `100` | No | Poll interval for async events/status loops. |
| `SWITCHYARD_GENERIC_HTTP_MAX_RESPONSE_BYTES` | `1048576` | No | Hard response-size limit for every wrapper endpoint. |

Security rule: tokens are never persisted in transcript content, doctor output, diagnostics, or structured logs.

## Wrapper API Contract

Expected wrapper endpoints:

- `GET /health`
- `POST /v1/runs`
- `GET /v1/runs/:externalRunId`
- `GET /v1/runs/:externalRunId/events?cursor=...`
- `POST /v1/runs/:externalRunId/cancel`
- `GET /v1/runs/:externalRunId/artifacts`
- `POST /v1/runs/:externalRunId/input` (required for R25 input bridge readiness)
- `POST /v1/runs/:externalRunId/approvals/:runtimeApprovalToken/resolve` (required for R25 approval bridge readiness)

The daemon does not support metadata-based endpoint overrides. Base URL comes only from daemon env.

Wrapper health/capability discovery must advertise `input`, `approval_request`, and `approval_resolution` before hosted wrapper bridges are admitted. Ordinary run start can remain available when these bridge capabilities are absent, but hosted input/approval bridge readiness fails closed.

## Input And Approval Bridge Semantics

- `POST /runs/:id/input` is accepted only for active sessions whose configured Generic HTTP wrapper advertises bridge input capability. Hosted calls are admitted through the hosted runtime bridge and return a bridge command id.
- Runtime approval resolution reuses `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, and `POST /approvals/:id/reject`; hosted `POST /approvals` is not exposed.
- Per-run URL, endpoint, and auth overrides are never accepted for input or approval bridge calls.
- Hosted active cancel remains unsupported with `hosted_cancel_unsupported`.

## Verified Cancel Semantics

- A 2xx cancel acknowledgement is not terminal by itself.
- `adapter.cancel()` returns only after terminal `cancelled` is verified via status/session state.
- `{ cancelled: false }`, timeout/network failure, non-terminal status after cancel, non-terminal 404 fallback, or oversized cancel response return `409 adapter_protocol_failed`.

## Bounded Response Rules

All Generic HTTP endpoints enforce `SWITCHYARD_GENERIC_HTTP_MAX_RESPONSE_BYTES`.

Reason codes:

- Health: `check_output_too_large`
- Start: `generic_http_start_response_too_large`
- Status: `generic_http_status_response_too_large`
- Events: `generic_http_events_response_too_large`
- Cancel: `generic_http_cancel_response_too_large`
- Artifacts: `generic_http_artifacts_response_too_large`
- Bridge: `generic_http_bridge_config_missing`, `generic_http_bridge_capability_missing`, `runtime_input_empty`, `runtime_input_too_large`, `generic_http_input_failed`, `generic_http_invalid_input_response`, `generic_http_input_response_too_large`, `generic_http_approval_request_invalid`, `generic_http_approval_resolution_failed`, `generic_http_invalid_approval_response`, `generic_http_approval_response_too_large`

Logs/transcripts record method/path/status/byte-count/reason only, never full oversized bodies.

## Local Smoke

Terminal 1:

```bash
pnpm --filter @switchyard/testkit fake-http-runtime -- --host 127.0.0.1 --port 5055
```

Terminal 2:

```bash
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-r4-generic-http \
SWITCHYARD_GENERIC_HTTP_BASE_URL=http://127.0.0.1:5055 \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

API smoke:

```bash
BASE=http://127.0.0.1:4546
curl -s "$BASE/runtime-modes/generic_http.async_rest" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/generic_http.async_rest/check" | python3 -m json.tool
RUN_ID=$(curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"generic_http","provider":"generic_http","model":"generic-http-default","adapterType":"http","cwd":"/repo","task":"generic smoke","timeoutSeconds":30}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["run"]["id"])')
curl -s "$BASE/runs/$RUN_ID/artifacts" | python3 -m json.tool
```

## Focused Verification

```bash
pnpm --filter @switchyard/adapters test -- generic-http-adapter
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```
