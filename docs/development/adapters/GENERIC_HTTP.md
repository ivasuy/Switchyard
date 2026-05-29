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

Not shipped:

- Per-run base URL overrides.
- Post-start input.
- Webhook callbacks.
- Remote artifact URL fetching.
- ACP, PTY, hosted execution, interactive Codex, debate, memory, tool expansion.

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

The daemon does not support metadata-based endpoint overrides. Base URL comes only from daemon env.

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
