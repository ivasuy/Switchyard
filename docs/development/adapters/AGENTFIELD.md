# AgentField Adapter Local Development

This guide is for the shipped `agentfield.async_rest` runtime mode in R6.

Use [Official API Contract](../API.md) for endpoint payloads and [Local Development](../DEVELOPMENT.md) for daemon startup basics.

## Shipped Scope

Implemented:

- Runtime mode slug `agentfield.async_rest`.
- Daemon-configured AgentField async REST integration (`POST /api/v1/execute/async/{target}` + `GET /api/v1/executions/{executionId}` polling).
- Runtime mode check strategy `custom` with bounded health/discovery probes.
- Transcript artifact capture at `runs/<runId>/agentfield-transcript.jsonl`.
- Terminal result payload artifact capture at `runs/<runId>/agentfield-result.json`.
- Named failure mapping for upstream failed/cancelled/timeout statuses and malformed responses.
- Conditional R25 hosted input/approval bridge support through existing hosted runtime bridge command/payload stores when wrapper config and advertised bridge capabilities are ready.

Not shipped:

- Per-run base URL/API key/target overrides.
- Arbitrary AgentField endpoint execution.
- Hosted active cancel bridge.
- Verified upstream cancellation endpoint support.
- Webhook callbacks.
- AgentField memory/admin/node lifecycle/permissions/Agentic APIs via Switchyard.
- OpenClaw, Paperclip, AgentField memory/admin/tool expansion, TUI, and dashboard.

## Environment Variables

All AgentField settings are daemon-level:

| Variable | Default | Required | Notes |
| --- | --- | --- | --- |
| `SWITCHYARD_AGENTFIELD_BASE_URL` | _(unset)_ | Yes | Must be `http://` or `https://`. Missing value reports `agentfield_config_missing`. |
| `SWITCHYARD_AGENTFIELD_API_KEY` | _(unset)_ | Yes | Sent as `Authorization: Bearer <key>`. Missing value reports `agentfield_auth_missing`. |
| `SWITCHYARD_AGENTFIELD_TARGET` | _(unset)_ | Yes | Async execution target used in `POST /api/v1/execute/async/{target}`. Missing value reports `agentfield_target_missing`. |
| `SWITCHYARD_AGENTFIELD_REQUEST_TIMEOUT_MS` | `5000` | No | Per-request timeout for health/discovery/start/status polling. |
| `SWITCHYARD_AGENTFIELD_POLL_INTERVAL_MS` | `1000` | No | Poll delay for execution status checks. |
| `SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES` | `1048576` | No | Hard response-size limit for every AgentField endpoint call. |

Security rule: API keys are never persisted in doctor output, diagnostics, transcripts, events, or structured logs.

## Upstream Endpoint Contract

Expected AgentField endpoints:

- `GET /api/v1/health`
- `GET /api/v1/discovery/capabilities?format=compact` (diagnostic plus R25 bridge capability discovery)
- `POST /api/v1/execute/async/{target}`
- `GET /api/v1/executions/{executionId}`
- `POST /api/v1/executions/{executionId}/input` (required for R25 input bridge readiness)
- `POST /api/v1/executions/{executionId}/approvals/{runtimeApprovalToken}/resolve` (required for R25 approval bridge readiness)

Runtime checks only call health/discovery. Checks do not execute prompts and do not create executions. Hosted bridge readiness requires discovery to advertise `switchyard_bridge.input`, `switchyard_bridge.approval_request`, and `switchyard_bridge.approval_resolution`.

## Cancel And Input Semantics

- `POST /runs/:id/input` is accepted only for active sessions whose configured AgentField wrapper advertises bridge input capability. Hosted calls are admitted through the hosted runtime bridge and return a bridge command id.
- AgentField runtime approval resolution reuses `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, and `POST /approvals/:id/reject`; hosted `POST /approvals` is not exposed.
- Active `POST /runs/:id/cancel` returns `409 adapter_protocol_failed` with `reasonCode: agentfield_cancel_unsupported`.
- Terminal runs still accept idempotent cancel (run state unchanged).
- Switchyard timeout still marks runs `timeout` even when AgentField cancel is unsupported.
- Hosted active cancel remains unsupported with `hosted_cancel_unsupported`.
- Per-run URL, target, endpoint, and auth overrides are never accepted for input or approval bridge calls.

## Bounded Response And Failure Mapping

AgentField calls are bounded by `SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES`.

Common reason codes:

- Config and doctor: `agentfield_config_missing`, `agentfield_config_invalid`, `agentfield_auth_missing`, `agentfield_target_missing`, `agentfield_health_unavailable`, `agentfield_health_degraded`, `agentfield_discovery_unavailable`, `agentfield_target_not_found`, `check_timeout`, `check_output_too_large`.
- Start and polling: `agentfield_start_failed`, `agentfield_invalid_start_response`, `agentfield_start_response_too_large`, `agentfield_status_failed`, `agentfield_upstream_cancelled`, `agentfield_upstream_timeout`, `agentfield_unknown_status`, `agentfield_invalid_status_response`, `agentfield_status_response_too_large`, `agentfield_request_failed`.
- Bridge: `agentfield_bridge_config_missing`, `agentfield_bridge_capability_missing`, `runtime_input_empty`, `runtime_input_too_large`, `agentfield_input_failed`, `agentfield_invalid_input_response`, `agentfield_input_response_too_large`, `agentfield_approval_request_invalid`, `agentfield_approval_resolution_failed`, `agentfield_invalid_approval_response`, `agentfield_approval_response_too_large`.

## Local Fake Smoke

Terminal 1 (fake AgentField server):

```bash
pnpm --filter @switchyard/testkit fake-agentfield -- --host 127.0.0.1 --port 5057 --api-key af-local-key
```

Terminal 2 (daemon):

```bash
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-r6-agentfield \
SWITCHYARD_AGENTFIELD_BASE_URL=http://127.0.0.1:5057 \
SWITCHYARD_AGENTFIELD_API_KEY=af-local-key \
SWITCHYARD_AGENTFIELD_TARGET=research-agent.deep_analysis \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

Smoke calls:

```bash
BASE=http://127.0.0.1:4546
curl -s "$BASE/runtime-modes/agentfield.async_rest" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/agentfield.async_rest/check" | python3 -m json.tool
curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"agentfield","provider":"agentfield","model":"agentfield-default","adapterType":"http","cwd":"/repo","task":"r6 agentfield smoke","timeoutSeconds":30}' \
  | python3 -m json.tool
```

## Optional Real AgentField Smoke

Real AgentField smoke can spend model budget.

- Use explicit throwaway credentials.
- Run doctor first (`POST /runtime-modes/agentfield.async_rest/check`) to validate connectivity without execution spend.
- Run one bounded `wait=1` call with a short task and short timeout.
