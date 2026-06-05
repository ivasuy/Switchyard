# Phase 24 / R25: Hosted Wrapper Runtime Bridges

**Date:** 2026-06-04
**Run:** `post-r11-remaining-20260530`
**Branch:** `agent/phase-24-r25-hosted-wrapper-bridges`
**Base commit:** `6b8bc00` (`phase-23: close hosted real debate`)
**Spec target:** `docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md`

## Overview

R25 extends the hosted runtime bridge model from R23 to the two already-shipped async REST wrapper runtimes: `agentfield.async_rest` and `generic_http.async_rest`. The public product surface stays unchanged: hosted input still uses `POST /runs/:id/input`, runtime approvals still use the existing `/approvals` list/get/approve/reject endpoints, and debate use still flows only through `POST /debates`, `GET /debates/:id`, and `GET /debates/:id/events`.

This is not a new public execution product. The worker may call configured upstream wrapper endpoints and poll or consume wrapper events, but users may not provide arbitrary base URLs, commands, executables, PTY settings, browser tasks, repo execution, or a new model-judge route. R25 is a narrow bridge/capability release for known HTTP wrapper runtime modes with fail-closed readiness, ownership, quota, audit, and spend gates.

## Why Now

R23 shipped durable hosted bridge commands and payloads for worker-owned `claude_code.sdk` and structured `opencode.acp`. R24 then made hosted debate server-safe, but kept AgentField and Generic HTTP outside hosted debate because their hosted input/approval bridge contracts were still unshipped.

The next highest-priority non-dashboard/TUI release gap is to close those wrapper bridge gaps while reusing the R23/R24 architecture. Doing this before browser automation, hosted repo execution, generic process/PTY adapters, public arbitrary execution APIs, managed SaaS, or hosted `codex.interactive` keeps the release path provider-facing without opening the dangerous surfaces that are explicitly not ready for public release.

## Goals

- Add hosted runtime input bridge support for `agentfield.async_rest` and `generic_http.async_rest` through the existing `POST /runs/:id/input` endpoint.
- Add hosted runtime approval request and approval-resolution bridge support for `agentfield.async_rest` and `generic_http.async_rest` through the existing approval list/get/approve/reject endpoints.
- Extend the hosted runtime catalog, provider/spend activation gates, worker adapter construction, readiness, preflight, canary, and product truth so `agentfield.async_rest` and `generic_http.async_rest` are known conditional hosted wrapper modes.
- Allow `agentfield.async_rest` and `generic_http.async_rest` as opt-in hosted debate participants only when their hosted runtime mode, wrapper config, provider spend gates, bridge readiness, queue, object store, ownership, quota, audit, and worker readiness requirements pass.
- Preserve existing R23 bridge command/payload stores and semantics: durable admission, idempotency keys, payload hashing, redacted command metadata, worker claim/apply, quota finalization, and fail-closed stale-claim recovery.
- Account for async wrapper semantics: AgentField is poll/status driven, Generic HTTP is event-plus-status driven, and both must expose explicit bridge capability before Switchyard advertises or admits bridge operations.
- Keep all required tests, default smoke, default preflight, and default canary no-spend and fake/deterministic by default.
- Require explicit operator configuration and explicit live spend confirmation for any live AgentField or Generic HTTP provider canary.

## Non-Goals

- No dashboard.
- No TUI.
- No hosted `codex.interactive`.
- No hosted Codex approval/input bridge beyond existing `codex.exec_json` one-shot unsupported behavior.
- No public arbitrary `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` route.
- No public top-level `/input`, `/approval`, `/runtime-bridge`, `/session`, `/browser`, `/repo`, `/fetch`, `/github`, `/search`, `/judge`, `/model-judge`, or `/judging` route.
- No browser automation.
- No hosted repo execution.
- No generic process runtime adapter.
- No generic PTY runtime adapter.
- No terminal bridge, PTY automation, keyboard driving, alternate-screen scraping, or TUI automation.
- No per-run HTTP base URL, auth token, API key, target, path, header, command, cwd, argv, executable, env, process factory, PTY config, browser config, or sandbox config override.
- No public model judge routes. R24's internal bounded debate judge remains internal.
- No Cursor, OpenClaw, or Paperclip adapter.
- No managed SaaS, public signup, payment provider integration, billing UI, invoices, checkout, webhooks, OAuth/OIDC/SAML/SSO/SCIM, browser login, session-cookie auth, or tenant self-service UI.
- No live provider spend in required tests, default smoke, default preflight, or default canary.
- No claim that arbitrary Generic HTTP endpoints are safe. R25 supports only operator-configured wrapper endpoints behind deployment config and spend/activation policy.

## Current-State Anchors

`PRODUCT.md` records the exact current truth R25 must update only after implementation:

```md
R23 hosted runtime bridge support is shipped only for `claude_code.sdk` and `opencode.acp`.
...
AgentField and Generic HTTP hosted bridges remain unshipped pending durable callback contracts.
...
AgentField and Generic HTTP hosted debate bridges are not shipped.
```

`packages/contracts/src/hosted-runtime-bridge.ts` currently closes bridge support to Claude and OpenCode. R25 must widen this set deliberately, not by using a catch-all runtime slug:

```ts
export const hostedRuntimeBridgeOperationSchema = z.enum(["input", "approval_resolution"]);
export const hostedRuntimeBridgeSupportedModeSchema = z.enum(["claude_code.sdk", "opencode.acp"]);
...
export function isHostedRuntimeBridgeSupportedMode(
  runtimeMode: string,
  operation?: z.infer<typeof hostedRuntimeBridgeOperationSchema>
): boolean {
  if (!HOSTED_RUNTIME_BRIDGE_ALLOWED_MODES.has(runtimeMode)) {
    return false;
  }
  if (operation === "approval_resolution") {
    return runtimeMode === "claude_code.sdk" || runtimeMode === "opencode.acp";
  }
  return true;
}
```

`packages/adapters/src/generic-http/generic-http-adapter.ts` currently rejects post-start input and maps only output/status/terminal wrapper events:

```ts
async send(_session: Record<string, unknown>, _input: Record<string, unknown>): Promise<void> {
  throw new AdapterProtocolError("Generic HTTP async REST does not support input after start", {
    reasonCode: "generic_http_input_unsupported"
  });
}
```

```ts
if (type === "runtime.output") {
  payload["text"] = typeof wrapperEvent["text"] === "string" ? wrapperEvent["text"] : "";
} else if (type === "runtime.status") {
  payload["status"] = typeof wrapperEvent["status"] === "string" ? wrapperEvent["status"] : "running";
} else if (type === "run.failed") {
```

`packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts` currently starts and polls AgentField but rejects post-start input:

```ts
const body: Record<string, unknown> = {
  input: {
    prompt: task,
    ...inputPayload
  },
  metadata: {
    runId,
    runtime,
    runtimeMode,
    provider,
    model,
    cwd
  }
};
```

```ts
async send(_session: Record<string, unknown>, _input: Record<string, unknown>): Promise<void> {
  throw new AdapterProtocolError("agentfield.async_rest does not support POST /runs/:id/input in R6.", {
    reasonCode: "agentfield_input_unsupported"
  });
}
```

R23 already created the durable bridge storage R25 should reuse. `packages/storage/src/postgres/database.ts` includes:

```sql
CREATE TABLE IF NOT EXISTS hosted_runtime_bridge_commands (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  approval_id text,
  runtime_session_id text,
  runtime_mode text NOT NULL,
  operation text NOT NULL,
  status text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  payload_bytes integer NOT NULL,
  redacted_payload jsonb NOT NULL,
  account_id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  user_id text NOT NULL,
  api_key_id text NOT NULL,
```

The hosted runtime catalog is currently closed to fake plus three known provider modes. `packages/core/src/services/hosted-runtime-catalog.ts` says:

```ts
export type HostedRuntimeModeSlug = "fake.deterministic" | "codex.exec_json" | "claude_code.sdk" | "opencode.acp";
```

`packages/core/src/services/debate-runtime-matrix.ts` currently blocks AgentField and Generic HTTP debate participants:

```ts
const ALLOWED_DEBATE_RUNTIME_MODES = new Set<HostedRuntimeModeSlug>([
  "fake.deterministic",
  "codex.exec_json",
  "claude_code.sdk",
  "opencode.acp"
]);
```

```ts
if (haystack.includes("agentfield")) {
  return "agentfield_bridge_unshipped";
}
if (haystack.includes("generic_http") || haystack.includes("generic-http")) {
  return "generic_http_bridge_unshipped";
}
```

The public hosted route inventory already contains the only R25 public routes that may be used:

```ts
"POST /runs/:id/input",
"GET /approvals",
"GET /approvals/:id",
"POST /approvals/:id/approve",
"POST /approvals/:id/reject",
"POST /debates",
"GET /debates/:id",
"GET /debates/:id/events"
```

## Product/API Boundary

R25 preserves public route surfaces.

Public Switchyard routes used by this phase:

- `POST /runs` for hosted wrapper run creation when `placement: "hosted"` and the runtime mode is allowlisted and ready.
- `POST /runs/:id/input` for post-start hosted wrapper input.
- `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, and `POST /approvals/:id/reject` for runtime approval inspection and resolution.
- `POST /debates`, `GET /debates/:id`, and `GET /debates/:id/events` for hosted debate participants.
- `GET /runtime-modes`, `GET /runtime-modes/:id`, `POST /runtime-modes/:id/check`, `GET /doctor`, `GET /ready`, and `GET /metrics` for existing registry and operator diagnostics.

R25 must not add public Switchyard routes. New AgentField/Generic HTTP bridge endpoints, if implemented, are outbound worker-to-wrapper calls to operator-configured upstream services. They are not Switchyard API routes and must not appear in `HOSTED_SERVER_ROUTE_INVENTORY` or OpenAPI as public endpoints.

Expected public response compatibility:

- `POST /runs/:id/input` remains `202` with `{ "accepted": true }` for local/non-bridge paths and `202` with `{ "accepted": true, "bridgeCommandId": "..." }` for hosted bridge admission.
- Runtime approval `approve`/`reject` responses remain `{ "approval": ..., "bridgeCommandId": "..." }` when the approval is runtime-bridge scoped.
- Unsupported hosted wrapper bridge operations return named errors in the unified `{ error: { code, message, details?, requestId? } }` envelope.

`POST /runs?wait=1` remains denied for hosted real wrapper runs before provider dispatch. Hosted wrapper bridge operations are asynchronous: the server records an admitted command, the worker applies it, and clients observe resulting events/run state through existing run and event APIs.

## Runtime Matrix

| Runtime mode | Hosted execution after R25 | Hosted input bridge | Hosted approval bridge | Hosted debate participant | Spend default | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `fake.deterministic` | Supported | Not needed | Not needed | Default supported | No-spend | Required tests/default canary stay fake. |
| `codex.exec_json` | Existing conditional known provider | Unsupported | Unsupported | Existing opt-in, one child run per turn | Spend-gated | Remains one-shot. No R25 change. |
| `codex.interactive` | Unshipped | Unshipped | Unshipped | Unshipped | No hosted path | Explicit local-only mode remains local-only. |
| `claude_code.sdk` | Existing conditional known provider | Existing R23 support | Existing R23 support | Existing R24 opt-in support | Spend-gated | No R25 regression. |
| `opencode.acp` | Existing conditional known provider | Existing R23 support | Existing R23 support | Existing R24 opt-in support | Spend-gated | No terminal/PTY bridge. |
| `agentfield.async_rest` | New conditional hosted wrapper mode | New R25 support if wrapper capabilities pass | New R25 support if wrapper approval contract passes | New R25 opt-in support if all gates pass | Disabled/no-spend by default; live explicitly spend-gated | Operator-configured AgentField base URL/API key/target only. No per-run overrides. |
| `generic_http.async_rest` | New conditional hosted wrapper mode | New R25 support if wrapper capabilities pass | New R25 support if wrapper approval contract passes | New R25 opt-in support if all gates pass | Disabled/no-spend by default; live explicitly spend-gated | Operator-configured Generic HTTP base URL/token only. No per-run overrides. |
| Browser/repo/generic process/generic PTY/Cursor/OpenClaw/Paperclip | Unshipped | Unshipped | Unshipped | Unshipped | No path | Must remain denied and absent from public route inventory. |

Catalog changes required:

- Extend `HostedRuntimeModeSlug` to include `agentfield.async_rest` and `generic_http.async_rest`.
- Add hosted catalog entries for both wrapper modes with `adapterType: "http"`, `kind: "async_rest"`, `hostedSupport: "conditional"`, `requiresRealRuntimeGate: true`, `productionAllowed: false`, `capabilities` including `run.start`, `run.input`, `run.timeout`, `event.normalized`, `event.streaming`, `approval.bridge`, `artifact.transcript`, and `auth.api_key`.
- Generic HTTP may keep `run.cancel` in the adapter manifest, but R25 must not ship a public hosted active-cancel bridge. `POST /runs/:id/cancel` for active hosted real wrapper runs still returns `hosted_cancel_unsupported`; queued hosted runs may still cancel before worker claim.
- AgentField active cancel remains unsupported unless a later phase verifies an upstream cancel endpoint.

## Contracts

### Shared Hosted Bridge Contract

R25 reuses the R23 bridge command model.

Supported operations remain exactly:

- `input`
- `approval_resolution`

No new operation type is added.

Bridge-supported runtime modes after R25:

```ts
["claude_code.sdk", "opencode.acp", "agentfield.async_rest", "generic_http.async_rest"]
```

`isHostedRuntimeBridgeSupportedMode(runtimeMode, operation)` must return:

- `true` for `agentfield.async_rest` input only when the hosted catalog/config says the adapter is bridge-capable.
- `true` for `agentfield.async_rest` approval resolution only when AgentField discovery/status contract says runtime approval request and resolution are supported.
- `true` for `generic_http.async_rest` input only when `/health` capability discovery says input is supported.
- `true` for `generic_http.async_rest` approval resolution only when `/health` capability discovery says approval request and resolution are supported.
- `false` for `codex.exec_json`, `codex.interactive`, browser, repo, process, PTY, shell, Cursor, OpenClaw, Paperclip, and unknown slugs.

Implementation may keep the static schema as a closed enum and enforce dynamic capability in readiness/admission. It must not implement `return true` for arbitrary dot-separated slugs.

Input command body:

```json
{
  "text": "continue with the next argument"
}
```

Input validation:

- Missing body or non-object body: `400 invalid_input`.
- Missing `text`: `400 invalid_input` with `details.path = "body.text"` and `issue = "required for hosted wrapper input"`.
- Empty or whitespace-only `text`: `409 adapter_protocol_failed` with `reasonCode: runtime_input_empty`.
- Text over 64 KiB UTF-8: `409 adapter_protocol_failed` with `reasonCode: runtime_input_too_large`.
- Request with an idempotency key and different payload hash than an existing command: `409 adapter_protocol_failed` with `reasonCode: hosted_runtime_bridge_payload_mismatch`.

Approval resolution body remains compatible with R23:

```json
{
  "message": "approved by operator",
  "answers": {
    "selectedOption": "allow"
  }
}
```

Approval resolution validation:

- Approval must be owned by the caller.
- Approval must include a non-empty `runtimeApprovalToken`.
- Approval must be pending at admission time.
- The associated run must be active, hosted, bridge-supported, and session-owned by the worker.
- Expired approval returns `409 adapter_protocol_failed` with the existing `acp_permission_request_expired` code or a wrapper-specific expiry code mapped to the same HTTP behavior.

### Generic HTTP Wrapper Bridge Contract

Existing Generic HTTP wrapper endpoints remain:

- `GET /health`
- `POST /v1/runs`
- `GET /v1/runs/:externalRunId`
- `GET /v1/runs/:externalRunId/events?cursor=...`
- `POST /v1/runs/:externalRunId/cancel`
- `GET /v1/runs/:externalRunId/artifacts`

R25 adds optional wrapper bridge endpoints that the worker calls only when `/health` advertises support:

- `POST /v1/runs/:externalRunId/input`
- `POST /v1/runs/:externalRunId/approvals/:runtimeApprovalToken/resolve`

Minimum bridge-ready `GET /health` response:

```json
{
  "ok": true,
  "capabilities": [
    "start",
    "status",
    "events",
    "artifacts",
    "input",
    "approval_request",
    "approval_resolution"
  ]
}
```

If `input` is missing, hosted input admission must fail with `generic_http_bridge_capability_missing`.
If `approval_request` or `approval_resolution` is missing, hosted runtime approvals for Generic HTTP must remain hidden/unsupported and resolution must fail with `generic_http_bridge_capability_missing`.

Generic HTTP input apply request from worker to wrapper:

```json
{
  "switchyardRunId": "run_123",
  "bridgeCommandId": "hosted_runtime_bridge_command_123",
  "idempotencyKey": "bridge_abc123",
  "type": "input",
  "text": "continue"
}
```

Generic HTTP input apply success response:

```json
{
  "accepted": true,
  "externalInputId": "input_123"
}
```

Generic HTTP approval request event from `/events`:

```json
{
  "id": "evt_approval_1",
  "type": "approval.requested",
  "runtimeApprovalToken": "approval_token_1",
  "approvalType": "before_external_message",
  "message": "Wrapper requests permission to send an external message.",
  "expiresAt": "2026-06-04T20:00:00.000Z"
}
```

The adapter maps this to a Switchyard `approval.requested` event with a redacted payload. The runtime runner then creates an approval record and moves the run/session to `waiting_for_approval`.

Generic HTTP approval resolution request from worker to wrapper:

```json
{
  "switchyardRunId": "run_123",
  "bridgeCommandId": "hosted_runtime_bridge_command_456",
  "idempotencyKey": "bridge_def456",
  "decision": "approved",
  "message": "approved by hosted-api",
  "answers": {
    "selectedOption": "allow"
  }
}
```

Generic HTTP approval resolution success response:

```json
{
  "accepted": true,
  "externalResolutionId": "resolution_123"
}
```

Generic HTTP polling/status semantics:

- `runtime.status` with `status: "waiting_for_input"` moves the run/session to `waiting_for_input`.
- `runtime.status` with `status: "running"` or `status: "resumed"` moves a waiting run/session back to `running`.
- A wrapper may emit `approval.requested` through `/events`. The status endpoint may also return a waiting state, but it must not be the only source of approval details unless it includes the same `runtimeApprovalToken`, `approvalType`, `message`, and `expiresAt` fields.
- Unknown wrapper event types remain normalized to `runtime.status` with `status: "unknown_event"` unless they match the explicit bridge event contract.

### AgentField Wrapper Bridge Contract

Existing AgentField endpoints remain:

- `GET /api/v1/health`
- `GET /api/v1/discovery/capabilities?format=compact`
- `POST /api/v1/execute/async/{target}`
- `GET /api/v1/executions/{executionId}`

R25 adds optional worker-to-AgentField bridge endpoint support:

- `POST /api/v1/executions/{executionId}/input`
- `POST /api/v1/executions/{executionId}/approvals/{runtimeApprovalToken}/resolve`

Minimum bridge-ready discovery response:

```json
{
  "targets": ["research-agent.deep_analysis"],
  "supports_async_execution": true,
  "switchyard_bridge": {
    "input": true,
    "approval_request": true,
    "approval_resolution": true
  }
}
```

If discovery is unavailable, AgentField may still remain runnable for ordinary async execution, matching existing R6 behavior, but hosted input/approval bridge readiness must fail closed with `agentfield_bridge_capability_missing`. R25 must not infer bridge readiness from ordinary health alone.

AgentField input apply request:

```json
{
  "switchyardRunId": "run_123",
  "bridgeCommandId": "hosted_runtime_bridge_command_123",
  "idempotencyKey": "bridge_abc123",
  "type": "input",
  "input": {
    "text": "continue"
  }
}
```

AgentField input apply success response:

```json
{
  "accepted": true,
  "input_id": "input_123"
}
```

AgentField polled approval request response:

```json
{
  "execution_id": "exec_123",
  "status": "waiting_for_approval",
  "approval": {
    "token": "af_approval_1",
    "approval_type": "before_external_message",
    "message": "AgentField requests permission to continue.",
    "expires_at": "2026-06-04T20:00:00.000Z"
  }
}
```

The adapter maps this to a Switchyard `approval.requested` event:

```json
{
  "runtimeApprovalToken": "af_approval_1",
  "approvalType": "before_external_message",
  "message": "AgentField requests permission to continue.",
  "expiresAt": "2026-06-04T20:00:00.000Z"
}
```

AgentField approval resolution request:

```json
{
  "switchyardRunId": "run_123",
  "bridgeCommandId": "hosted_runtime_bridge_command_456",
  "idempotencyKey": "bridge_def456",
  "decision": "rejected",
  "message": "rejected by hosted-api",
  "answers": {}
}
```

AgentField polling semantics:

- `queued`, `pending`, and `running` continue to emit bounded `runtime.status`.
- `waiting_for_input` emits `runtime.status` with `status: "waiting_for_input"`.
- `waiting_for_approval` with a valid `approval` object emits `approval.requested`.
- `waiting_for_approval` without a valid token/type/expiry payload fails the run with `agentfield_approval_request_invalid`.
- `succeeded` and `completed` remain terminal success.
- `failed`, `cancelled`, `timeout`, unknown status, malformed JSON, oversized response, and request errors keep existing named failure mapping plus the new bridge-specific names where applicable.

### Hosted Debate Contract

R25 extends the debate runtime matrix only for the two wrapper modes:

```json
{
  "role": "affirmative",
  "runtimeMode": "agentfield.async_rest",
  "runtime": "agentfield",
  "provider": "agentfield",
  "model": "agentfield-default",
  "adapterType": "http",
  "placement": "hosted",
  "realRuntimeOptIn": true
}
```

```json
{
  "role": "skeptic",
  "runtimeMode": "generic_http.async_rest",
  "runtime": "generic_http",
  "provider": "generic_http",
  "model": "generic-http-default",
  "adapterType": "http",
  "placement": "hosted",
  "realRuntimeOptIn": true
}
```

Admission requirements:

- `realRuntimeOptIn: true` is required.
- `placement: "hosted"` is required.
- Runtime/provider/adapterType must match the hosted runtime catalog entry.
- The caller must be authenticated and authorized for hosted debate creation.
- Entitlements must allow hosted real runtime execution and the wrapper runtime mode.
- Provider/wrapper activation and spend controls must pass.
- Hosted bridge readiness must pass for wrapper modes because R25 treats them as debate-capable only when post-start input and approval semantics can be represented through Switchyard.
- `POST /debates?wait=1` remains fake-only/no-spend and rejects wrapper participants before child-run creation.

## Data And Durability

R25 should not add a second bridge command table. Reuse `hosted_runtime_bridge_commands` and `hosted_runtime_bridge_payloads`.

Durability requirements:

- Every admitted input or approval-resolution command is durably stored before the worker attempts an upstream wrapper call.
- `runtime_mode` stores `agentfield.async_rest` or `generic_http.async_rest` for wrapper commands.
- `operation` remains `input` or `approval_resolution`.
- `payload_hash`, `payload_bytes`, and `idempotency_key` are computed over the raw worker dispatch payload.
- `redacted_payload` never stores raw prompts, raw text beyond the existing redaction policy, tokens, API keys, Authorization headers, wrapper URLs with credentials, env values, command strings, argv, cwd overrides, or provider response bodies.
- The payload store holds the bounded worker dispatch body; missing payload store fails readiness and admission with `hosted_runtime_bridge_store_unavailable`.
- Stale claimed commands after worker crash are not blindly retried. The existing recovery behavior must keep failing stale non-idempotent provider input with `hosted_runtime_bridge_non_idempotent_retry_blocked`.
- Command completion deletes worker payloads after successful apply.
- Failed command application records a named `reasonCode`, finalizes quota, deletes payload, and terminalizes the run when the bridge failure means the worker session can no longer be trusted.
- Approval records created from wrapper events are durable, tenant-owned, and resolvable by existing approval routes.
- Runtime session state must include enough redacted worker ownership and external session identity to validate bridge apply: `hostedWorkerId`, `hostedRuntimeSessionId` when available, `hostedBridgeCapable`, `runtimeMode`, and `externalSessionKey`.

No new durable public resource type is required. Existing ownership type `runtime_bridge_command` remains the ownership/audit resource for bridge command records.

## Orchestration

### Hosted Wrapper Run Creation

1. Caller creates a run through `POST /runs` with `placement: "hosted"` and runtime mode `agentfield.async_rest` or `generic_http.async_rest`.
2. Server validates auth, ownership, entitlement, quota, hosted placement, allowlist, and hosted runtime catalog fields before durable side effects.
3. Server rejects `wait=1` before any provider dispatch.
4. Hosted run is queued through existing hosted run/queue path.
5. Worker claims the run, revalidates runtime mode/allowlist/provider activation, constructs only the configured wrapper adapter, and starts the wrapper execution.
6. Adapter records an external session key (`executionId` or `externalRunId`) and emits existing normalized runtime events.
7. When the wrapper indicates waiting for input or approval, adapter emits existing `runtime.status` or `approval.requested` event shapes so the runner can update durable run/session state.

### Hosted Input Bridge

1. Caller sends `POST /runs/:id/input`.
2. Server authorizes the run and validates the hosted runtime bridge mode/capability.
3. Server creates a durable bridge command and payload, attaches ownership, reserves bridge quota, writes audit, and returns `202`.
4. Worker bridge loop claims the command.
5. Worker validates session ownership and runtime mode match.
6. Worker loads payload, recomputes hash, and calls adapter `send(session, payload)`.
7. Adapter calls the configured upstream wrapper input endpoint with bounded timeout and response size.
8. On success, command is completed, quota is finalized, payload deleted, and logs/metrics are emitted.
9. On failure, command fails with a named reason code; the run is terminalized only when the session cannot safely continue.

### Hosted Approval Bridge

1. Wrapper polling/events expose a valid approval request.
2. Adapter emits `approval.requested` with `runtimeApprovalToken`, `approvalType`, optional `message`, optional `answers`, and `expiresAt`.
3. Runtime runner creates a durable approval record through the hosted runtime bridge approval sender and moves run/session to `waiting_for_approval`.
4. Caller lists or fetches the approval through existing `/approvals` routes.
5. Caller approves or rejects through existing `POST /approvals/:id/approve` or `/reject`.
6. Server authorizes approval ownership and creates a durable `approval_resolution` bridge command.
7. Worker applies the approval resolution to the wrapper endpoint.
8. Wrapper resumes, emits `runtime.status: running` or `runtime.output`, and the runner moves the run/session back to `running`.

### Hosted Debate Participants

1. `POST /debates` validates participants before debate side effects.
2. Wrapper participants require `realRuntimeOptIn: true` and `placement: "hosted"`.
3. The debate service creates normal child runs with debate metadata and the wrapper runtime mode.
4. The worker executes each child run through the hosted wrapper path.
5. Debate output extraction continues to use persisted `runtime.output` events tied to the debate child-run key.
6. Missing/empty/overlarge/unowned wrapper output keeps the existing debate participant output failure codes.

## Shadow-Path Requirements

Every R25 implementation task must cover happy, nil, empty, and upstream-error paths for these data flows.

| Data flow | Happy path | Nil path | Empty path | Error path |
| --- | --- | --- | --- | --- |
| Hosted wrapper run create | Valid hosted run with allowlisted wrapper mode queues and worker starts configured wrapper. | Missing `runtimeMode` may infer wrapper from `runtime`/`adapterType`; missing `placement` defaults local and does not invoke hosted path. | Empty task/model/runtime/provider is rejected by existing run validation before queue side effects. | Missing allowlist, policy, credentials, queue, Postgres, object store, or worker readiness fails before provider dispatch with named code. |
| Wrapper input bridge | Active hosted wrapper run accepts non-empty text, stores command/payload, worker applies upstream input, and command completes. | Missing body or missing `text` returns `invalid_input`; no command is created. | Whitespace-only text returns `runtime_input_empty`; no command is created. | Upstream timeout/5xx/malformed/oversized response fails command with wrapper-specific reason and emits audit/metrics. |
| Wrapper approval request | Wrapper emits valid approval request, Switchyard creates owned approval, caller resolves it, worker applies resolution. | Missing approval object/token/type returns wrapper approval invalid code and fails or rejects the request visibly. | Empty token/message/options returns wrapper approval invalid code; no unresolvable approval is created. | Expired approval, upstream resolution failure, session lost, or payload mismatch fails command with named code and does not silently leave approval pending. |
| Hosted debate wrapper participant | Opt-in hosted wrapper participant produces bounded `runtime.output` and debate records message/final artifact. | Missing participants or missing role follows existing debate invalid input; no child runs are created. | Empty participant output returns existing `debate_participant_output_empty`. | Wrapper run failure, bridge readiness failure, provider spend denial, or child-run link failure stops/fails debate with named reason and durable events. |

## Auth, Ownership, Quota, And Audit

R25 hosted wrapper bridge admission requires the existing hosted API key auth path in staging/production.

Authorization requirements:

- Run input bridge requires caller ownership of the run.
- Approval list/get/approve/reject requires caller ownership of the approval.
- Debate creation requires hosted debate auth/ownership and evidence preauthorization where evidence ids are supplied.
- Bridge commands attach ownership as `runtime_bridge_command`.
- Runtime approval records attach ownership from the owning run.

Quota requirements:

- Existing `runtime_bridge_commands_per_hour` and `active_runtime_bridge_commands` quotas apply to wrapper input and approval resolution commands.
- Existing run quotas apply to hosted wrapper run creation and debate child runs.
- Provider/wrapper spend controls apply before hosted wrapper run admission and optional live canary provider dispatch.
- Quota reservations are released, consumed, expired, or failed with explicit reason codes on every command terminal state.

Audit requirements:

- Record `hosted.runtime_bridge.admission` for input commands.
- Record `hosted.runtime_bridge.approval_resolved` for approval resolution commands.
- Record deny decisions for ownership, entitlement, quota, policy, readiness, and spend failures.
- Record hosted debate child-run creation and failure through existing hosted debate audit path.
- Audit payloads are redacted and contain ids/reason codes, not raw text, secrets, provider responses, Authorization headers, base URLs with credentials, or wrapper payload bodies.

## Readiness, Preflight, And Canary

### Readiness

Server and worker readiness must fail closed when wrapper bridge support is requested but dependencies are missing.

Required readiness checks:

- `command_store`: existing hosted runtime bridge command store.
- `command_outbox` or payload store: existing bridge payload store.
- `approval_ownership`: ownership attach support for runtime approvals.
- `quota`: bridge quota store.
- `audit`: audit store.
- `route_auth`: hosted route auth.
- `worker_claim`: worker bridge claim loop.
- `adapter_capability`: per-mode wrapper bridge capability from adapter checks.
- `session_reconciliation`: worker stale-session/claim reconciliation.
- `approval_sender`: runtime approval creation path in the worker runner.
- `wrapper_config`: wrapper base URL/auth/target configuration is present and valid for allowlisted wrapper modes.
- `wrapper_bridge_capability`: AgentField discovery or Generic HTTP health advertises bridge capability.

R25 may add wrapper-specific readiness detail nested under the existing hosted runtime bridge diagnostics, but must not add dashboard/TUI readiness surfaces.

### Preflight

`pnpm production:preflight` must remain no-spend by default.

If `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` contains `agentfield.async_rest` or `generic_http.async_rest`, preflight must:

- Validate hosted real runtime execution is explicitly enabled.
- Validate production/staging auth, Postgres, Redis, object store, quota, audit, queue, and worker readiness as before.
- Validate wrapper runtime policy/spend controls.
- Validate required wrapper env values without printing secrets.
- Validate bridge command/payload stores.
- Validate wrapper health/discovery capability without creating provider executions unless an explicit live probe flag is supplied.
- Fail closed with a named code when bridge capability is absent.

### Canary

`pnpm production:canary` remains fake hosted debate/no-spend by default and reports wrapper bridge probes as skipped by default.

Optional live wrapper bridge canary must require both an explicit mode flag and spend confirmation:

```bash
SWITCHYARD_CONFIRM_LIVE_PROVIDER_BRIDGE_CANARY=1 \
pnpm production:canary -- \
  --base-url https://replace-with-public-server-url \
  --api-key replace-with-operator-api-key \
  --live-provider-bridges \
  --confirm-live-provider-spend
```

Supplying `--live-provider-bridges` without `--confirm-live-provider-spend` must fail before network/provider dispatch with a named canary code. The existing `provider_bridge_live_canary_config_missing` code may remain if no runtime is configured; R25 should add `provider_bridge_live_canary_spend_unconfirmed` if needed so missing config and missing spend confirmation are distinguishable.

Optional no-spend wrapper canary may use fake AgentField/Generic HTTP wrapper servers from `@switchyard/testkit`, but it must be explicitly marked no-spend/fake and must not become the production default.

## Observability

Logs:

- `hosted.runtime_bridge.admission`
- `hosted.runtime_bridge.claimed`
- `hosted.runtime_bridge.completed`
- `hosted.runtime_bridge.failed`
- `hosted.runtime_bridge.reconciled`
- `generic_http.bridge.input`
- `generic_http.bridge.approval.requested`
- `generic_http.bridge.approval.resolved`
- `agentfield.bridge.input`
- `agentfield.bridge.approval.requested`
- `agentfield.bridge.approval.resolved`
- `debate.participant.wrapper.admitted`
- `debate.participant.wrapper.denied`

Metrics:

- Bridge commands admitted/completed/failed by `runtimeMode`, `operation`, and low-cardinality reason code.
- Wrapper input apply latency buckets by runtime mode.
- Wrapper approval request count and resolution count by runtime mode.
- Bridge readiness failures by check name and reason code.
- Provider/wrapper spend gate denials by runtime mode and reason code.
- Debate wrapper participant child-run success/failure count by runtime mode.

Events/artifacts:

- Existing run events remain source of truth for user-visible state.
- Wrapper input command admission does not itself create a public run event unless implementation already emits bridge audit/internal events. The effect becomes visible through subsequent runtime events.
- Wrapper approval requests create durable approval records and are visible through existing approval routes.
- Transcript artifacts must include bounded/redacted bridge HTTP request metadata, not raw text or secrets.

No dashboard or TUI is required or allowed in R25.

## Failure Codes

R25 must keep existing R23 codes and add wrapper-specific codes where current generic unsupported codes become too vague.

| Code | HTTP | Trigger | User sees |
| --- | --- | --- | --- |
| `hosted_runtime_bridge_store_unavailable` | 503 | Command or payload store unavailable. | Bridge not ready; retry after operator fixes storage. |
| `hosted_runtime_bridge_queue_unavailable` | 503 | Bridge outbox/claim path unavailable. | Bridge not ready; retry after operator fixes worker queue. |
| `hosted_runtime_bridge_worker_unavailable` | 503 | No bridge-capable worker is ready. | Bridge not ready; retry when worker is healthy. |
| `hosted_runtime_bridge_operation_unsupported` | 409 | Runtime/operation is not supported. | Operation not available for this run. |
| `hosted_runtime_bridge_session_missing` | 409 | No active runtime session exists. | Run cannot accept bridge input. |
| `hosted_runtime_bridge_session_not_owned` | 409 | Claimed worker does not own session. | Session ownership changed; run fails closed if needed. |
| `hosted_runtime_session_lost` | 409 | Worker session was lost during reconciliation. | Run cannot continue. |
| `hosted_runtime_session_state_incomplete` | 409 | Stored session and command do not match. | Run cannot continue safely. |
| `hosted_runtime_bridge_payload_mismatch` | 409 | Idempotency key or payload hash mismatch. | Conflicting duplicate request rejected. |
| `hosted_runtime_bridge_command_expired` | 409 | Command exceeded TTL before apply. | Command expired; user may retry with fresh intent if run remains active. |
| `hosted_runtime_bridge_non_idempotent_retry_blocked` | 409 | Stale claimed command recovered after crash. | Provider input is not blindly retried. |
| `hosted_runtime_bridge_quota_exceeded` | 429 | Bridge quotas exceeded. | Quota exceeded. |
| `runtime_input_empty` | 409 | Empty input text. | Input must be non-empty. |
| `runtime_input_too_large` | 409 | Input text over 64 KiB. | Input too large. |
| `agentfield_bridge_capability_missing` | 409/503 | AgentField discovery does not advertise bridge support. | AgentField bridge not ready. |
| `agentfield_bridge_config_missing` | 503 | AgentField hosted wrapper env/policy is missing. | AgentField hosted wrapper not configured. |
| `agentfield_input_failed` | 503 | AgentField input endpoint returns non-2xx or request fails. | AgentField input failed. |
| `agentfield_invalid_input_response` | 502 | AgentField input response is malformed. | AgentField input response invalid. |
| `agentfield_input_response_too_large` | 502 | AgentField input response exceeds bound. | AgentField input response too large. |
| `agentfield_approval_request_invalid` | 409 | AgentField waiting approval response lacks valid token/type/expiry. | AgentField approval request invalid. |
| `agentfield_approval_resolution_failed` | 503 | AgentField approval resolution endpoint fails. | AgentField approval resolution failed. |
| `agentfield_invalid_approval_response` | 502 | AgentField approval resolution response malformed. | AgentField approval response invalid. |
| `agentfield_approval_response_too_large` | 502 | AgentField approval response exceeds bound. | AgentField approval response too large. |
| `generic_http_bridge_capability_missing` | 409/503 | Generic HTTP health does not advertise bridge support. | Generic HTTP bridge not ready. |
| `generic_http_bridge_config_missing` | 503 | Generic HTTP hosted wrapper env/policy is missing. | Generic HTTP hosted wrapper not configured. |
| `generic_http_input_failed` | 503 | Generic HTTP input endpoint returns non-2xx or request fails. | Generic HTTP input failed. |
| `generic_http_invalid_input_response` | 502 | Generic HTTP input response malformed. | Generic HTTP input response invalid. |
| `generic_http_input_response_too_large` | 502 | Generic HTTP input response exceeds bound. | Generic HTTP input response too large. |
| `generic_http_approval_request_invalid` | 409 | Wrapper approval event lacks token/type/expiry. | Generic HTTP approval request invalid. |
| `generic_http_approval_resolution_failed` | 503 | Wrapper approval resolution endpoint fails. | Generic HTTP approval resolution failed. |
| `generic_http_invalid_approval_response` | 502 | Wrapper approval resolution response malformed. | Generic HTTP approval response invalid. |
| `generic_http_approval_response_too_large` | 502 | Wrapper approval response exceeds bound. | Generic HTTP approval response too large. |
| `provider_bridge_live_canary_spend_unconfirmed` | 400 | Live wrapper/provider canary requested without spend confirmation. | Canary refused before spend. |

Existing `agentfield_bridge_unshipped` and `generic_http_bridge_unshipped` should remain only for stale/unavailable builds or paths outside R25's admitted hosted wrapper matrix. After R25, they must not be returned for properly configured, bridge-capable `agentfield.async_rest` or `generic_http.async_rest` hosted runs.

## Test Strategy

Required checks stay no-spend unless explicitly marked live.

Contract and schema tests:

- Update `hostedRuntimeBridgeSupportedModeSchema` tests so AgentField and Generic HTTP are supported only for R25 bridge operations.
- Update `HostedRuntimeModeSlug`, hosted runtime catalog, OpenAPI, HTTP error schema, endpoint inventory, and provider/wrapper policy tests.
- Add route drift assertions that no public `/runtime-bridge`, `/input`, `/approval`, `/session`, `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, `/sandbox`, `/browser`, `/repo`, `/judge`, `/model-judge`, `/judging`, dashboard, or TUI route appears.
- Add hosted OpenAPI tests that approval routes are reused and no `POST /approvals` route appears.

Adapter tests:

- Generic HTTP no-spend fake server supports health capability discovery, input apply, approval request event, approval resolution apply, malformed approval request, missing capability, upstream 5xx, timeout, oversized response, invalid JSON, duplicate event ids, and redaction.
- AgentField no-spend fake server supports discovery capability, polled waiting_for_input, polled waiting_for_approval, input apply, approval resolution apply, missing discovery capability, malformed approval payload, upstream 5xx, timeout, oversized response, invalid JSON, and redaction.
- Both adapters keep per-run base URL/auth/target overrides rejected.
- Both adapters reject empty input and overlarge input before upstream dispatch.

Core bridge tests:

- Existing hosted runtime bridge service tests pass unchanged for Claude/OpenCode.
- Add AgentField and Generic HTTP admission/apply tests for input and approval resolution.
- Add stale claimed wrapper command recovery test preserving `hosted_runtime_bridge_non_idempotent_retry_blocked`.
- Add idempotency payload mismatch tests for wrapper commands.
- Add quota reservation/finalization tests for wrapper commands.

Worker tests:

- Hosted worker constructs AgentField and Generic HTTP adapters only when allowlisted and wrapper policy/config gates pass.
- Worker readiness reports per-mode adapter capability failure when wrapper health/discovery lacks input or approval support.
- Worker bridge loop applies input/resolution only for the worker-owned session.
- Worker logs redact text, tokens, API keys, wrapper Authorization headers, and configured base URLs with credentials.

Server/REST tests:

- `POST /runs/:id/input` admits hosted AgentField/Generic HTTP bridge input and returns `bridgeCommandId`.
- Missing bridge store returns `hosted_runtime_bridge_store_unavailable`.
- Unsupported Codex, Codex interactive, browser, repo, process, PTY, and unknown runtime modes remain denied.
- `/approvals` list/get/approve/reject includes runtime approvals for wrapper modes only when bridge support is available.
- Ownership and auth denial occur before existence/probing leaks.

Debate tests:

- Update `debate-real-runtime` helper tests so `agentfield.async_rest` and `generic_http.async_rest` are admitted with `realRuntimeOptIn: true`, `placement: "hosted"`, and matching catalog fields.
- Keep `codex.interactive`, browser, repo, process, PTY, shell, sandbox, Cursor, OpenClaw, and Paperclip denied.
- Hosted debate wrapper participants create child runs with wrapper runtime mode and existing debate metadata.
- `POST /debates?wait=1` rejects wrapper participants before child-run creation.
- Missing/empty/overlarge/unowned wrapper output uses existing debate output failure codes.

Readiness/preflight/canary tests:

- Default production preflight and canary remain fake/no-spend.
- Preflight fails closed for wrapper allowlist without wrapper config/policy/capability.
- Preflight passes with no-spend fake wrapper dependencies.
- Live provider bridge canary is skipped by default.
- Live provider bridge canary fails before fetch/provider dispatch when spend confirmation is absent.
- Live provider bridge canary requires explicit confirmation and configured runtime mode.

Product truth tests:

- `PRODUCT.md`, `CHANGELOG.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, `docs/development/adapters/AGENTFIELD.md`, `docs/development/adapters/GENERIC_HTTP.md`, `docs/adapters/agentfield.md`, `docs/adapters/generic-http.md`, and production docs must be updated after implementation.
- Product/docs tests must state R25 shipped AgentField/Generic HTTP hosted wrapper bridges and debate participation, while all non-goals remain unshipped.

Minimum verification command set:

```bash
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/server test
pnpm --filter @switchyard/worker test
pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

## Release Checklist

- Hosted runtime catalog includes `agentfield.async_rest` and `generic_http.async_rest` as conditional hosted wrapper modes.
- Provider/wrapper activation and spend-control policy supports the two wrapper modes without request-supplied commands or per-run endpoint overrides.
- Worker config loads wrapper env values, validates them, redacts them, and fails closed in staging/production.
- Worker adapter factory constructs AgentField/Generic HTTP only when allowlisted and gated.
- AgentField and Generic HTTP adapters implement `send()` for bridge input and approval resolution.
- AgentField and Generic HTTP adapters emit `approval.requested` and `waiting_for_input`/`running` status events from wrapper polling/events.
- Existing hosted bridge command/payload stores are reused.
- Existing input and approval routes are reused.
- Existing debate routes are reused.
- No forbidden public routes are added.
- Default tests/preflight/canary remain no-spend.
- Optional live provider bridge canary requires `--confirm-live-provider-spend`.
- Product/docs truth is updated and explicitly lists remaining unshipped gaps.

## Required Product Truth After R25

After implementation and audit, `PRODUCT.md` and public development docs must say:

- R25 ships hosted runtime input and approval bridges for `agentfield.async_rest` and `generic_http.async_rest` when their wrapper bridge contracts, shared bridge stores, worker ownership, readiness, auth, quota, audit, and spend gates are satisfied.
- `agentfield.async_rest` and `generic_http.async_rest` are conditional hosted wrapper runtime modes, disabled/no-spend by default and available only through operator configuration and allowlists.
- AgentField and Generic HTTP can be used as opt-in hosted debate participants only through existing `/debates` routes, with `realRuntimeOptIn: true`, `placement: "hosted"`, matching hosted catalog fields, and all wrapper readiness/spend gates passing.
- Required tests, default smoke, default preflight, and default canary remain fake/no-spend.
- Existing public route surfaces are preserved; no new public arbitrary execution or bridge route is shipped.
- Still unshipped after R25: dashboard/TUI, hosted `codex.interactive`, Codex hosted input/approval bridge, browser automation, hosted repo execution, generic process/PTY product adapters, public arbitrary `/exec`/`/shell`/`/process`/`/command`/`/pty`/`/terminal`/`/sandbox` routes, Cursor/OpenClaw/Paperclip adapters, managed SaaS/public signup/billing/OAuth/OIDC/SAML/SSO/SCIM, and public model judge routes.

## Implementation Phase

### Phase 24 / R25: Hosted Wrapper Runtime Bridges

**Goal:** Ship conditional hosted input/approval bridges and hosted debate eligibility for `agentfield.async_rest` and `generic_http.async_rest` while preserving the public API boundary and no-spend defaults.

**Acceptance:**

- `agentfield.async_rest` and `generic_http.async_rest` are known conditional hosted runtime modes with explicit hosted catalog entries and no per-run endpoint overrides.
- Hosted input for active AgentField/Generic HTTP runs is admitted through `POST /runs/:id/input`, persisted through the existing hosted bridge stores, applied by the owning worker, and observable through existing run/events APIs.
- Hosted runtime approvals for AgentField/Generic HTTP are created from wrapper polling/events, owned by the caller's tenant/project, resolvable through existing approval endpoints, and applied by the owning worker through wrapper resolution endpoints.
- Hosted debate accepts AgentField/Generic HTTP participants only with explicit real-runtime opt-in, hosted placement, matching catalog fields, and all wrapper/readiness/spend gates passing.
- Fake/no-spend remains the default for required tests, smoke, preflight, and canary.
- Live wrapper/provider canary requires explicit spend confirmation and fails before provider dispatch without it.
- Endpoint inventory and OpenAPI prove no new public execution, bridge, browser, repo, PTY, terminal, dashboard/TUI, or public judge routes were added.
- Product truth is updated to list what R25 shipped and what remains unshipped.

**Non-goals (this phase):** All non-goals listed above remain out of scope and must be explicitly preserved in docs/tests.

**Complexity:** L
