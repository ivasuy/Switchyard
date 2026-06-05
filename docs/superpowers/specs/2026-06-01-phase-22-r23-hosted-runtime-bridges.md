# Phase 22 / R23: Hosted Runtime Input And Approval Bridges

**Date:** 2026-06-01
**Run:** `post-r11-remaining-20260530`
**Branch:** `agent/phase-22-r23-hosted-runtime-bridges`
**Base commit:** `02ed4124abccd6a2e4d603a0c5f1633a4887ac2f` (`project: close phase 21`)
**Spec target:** `docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md`

## Problem

R21 activated production hosted provider execution for the known runtime modes `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`. R22 then shipped hosted and connected-node real tools. The remaining practical runtime gap is that hosted provider runs are still mostly start-to-terminal jobs: post-start input, runtime approval resolution, and worker-owned session reconciliation are either blocked at the server route or fail inside hosted adapters.

R23 closes the hosted runtime bridge gap only where the current codebase has a structured non-PTY path. The release must let hosted Claude Code and hosted OpenCode ACP sessions accept supported post-start input and approval resolutions through existing run input and approval endpoints, while preserving worker ownership, tenant/project scoping, auditability, quota enforcement, restart reconciliation, no-spend tests, and the public route boundary.

## Goals

- Reuse the existing public run input endpoint, `POST /runs/:id/input`, for hosted runtime input. Do not add a second input route.
- Reuse the existing approval list/get/approve/reject endpoints for hosted runtime approvals. Do not add hosted `POST /approvals`.
- Add durable hosted runtime bridge command/service plumbing so the hosted server records authorized input or approval-resolution intent, and the worker that owns the active runtime session applies it.
- Ship hosted `claude_code.sdk` post-start text input, session-state persistence, runtime approval creation, and approval resolution when the run is worker-owned and the underlying Claude adapter session supports it.
- Ship hosted `opencode.acp` prompt/input/permission approval lifecycle only through structured ACP JSON-RPC. No PTY, terminal, keyboard driving, alternate-screen scraping, or terminal bridge.
- Keep hosted `codex.exec_json` one-shot with explicit unsupported input/approval semantics.
- Keep hosted `codex.interactive` unshipped in R23. The current hosted runtime catalog and worker adapter factory do not register a bounded hosted `codex.interactive` path, and R23 must not invent PTY/TUI automation to close that gap.
- Keep hosted AgentField and Generic HTTP approval/input bridges unshipped unless a later release adds durable runtime callback contracts to those adapters. R23 records explicit fail-closed behavior and tests for the current unsupported state.
- Make hosted runtime sessions worker-owned, tenant/project scoped, auditable, quota-scoped, idempotent, restart-reconciled, and fail-closed for unsupported bridge operations.
- Update readiness, preflight, canary/smoke, OpenAPI, SDK docs, development docs, and product truth so they state exactly which hosted runtime bridges shipped.
- Preserve default fake/no-spend CI, smoke, preflight, and canary behavior.

## Non-Goals

- No dashboard.
- No TUI.
- No public `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` routes.
- No public top-level `/input`, `/approval`, `/runtime-bridge`, `/session`, or `/terminal` routes.
- No hosted terminal bridge.
- No PTY automation, TUI automation, keyboard driving, screen scraping, alternate-screen capture, terminal replay, or interactive terminal proxy.
- No arbitrary process or generic PTY runtime adapter.
- No request-owned executable, cwd, env, argv, binary path, shell string, process factory, PTY config, terminal config, or sandbox config.
- No hosted `codex.interactive` runtime mode in R23.
- No hosted live Codex resume guarantee.
- No hosted Codex approval bridge beyond explicit fail-closed reporting for `codex.exec_json` and unshipped reporting for `codex.interactive`.
- No hosted AgentField or Generic HTTP runtime approval bridge in R23.
- No hosted AgentField or Generic HTTP post-start input bridge in R23.
- No Cursor adapter.
- No OpenClaw adapter.
- No Paperclip adapter.
- No browser automation.
- No hosted `repo` runtime or hosted browser/search/GitHub/fetch/shell route expansion beyond the R22 tool surface.
- No hosted debate with real participant runtimes.
- No hosted model judging.
- No managed SaaS/public signup, payment provider integration, OAuth/OIDC/SAML/SSO/SCIM, session-cookie auth, browser login flow, tenant self-service UI, or billing UI.
- No live provider prompt spend in required tests, default smoke, default preflight, or default canary.

## Product Decision

R23 is a bridge release, not a new runtime-adapter expansion release.

The product ships hosted runtime bridges for:

| Runtime mode | R23 hosted bridge decision | Reason |
| --- | --- | --- |
| `claude_code.sdk` | Ship hosted post-start input, session-state, runtime approval request, approval resolution, and restart reconciliation. | The existing local Claude adapter already exposes structured `sendUserMessage` and `resolveApproval`, and current hosted code only blocks them because hosted sessions are worker-owned. |
| `opencode.acp` | Ship structured ACP prompt/input/session/permission approval lifecycle where the protocol client can hold and answer JSON-RPC permission requests. | ACP is structured JSON-RPC over stdio. R23 may extend the ACP client and adapter; it must not use PTY. |
| `codex.exec_json` | Keep one-shot. Explicitly fail hosted input/approval with named unsupported codes. | It remains one-shot by product design and has no post-start session to bridge. |
| `codex.interactive` | Keep hosted mode unshipped. Add readiness/catalog/product truth that says the hosted bridge is not available. | Current hosted catalog is closed to `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`; worker factory does not construct `codex.interactive`. Shipping it would require a separate safe hosted driver decision. |
| `agentfield.async_rest` | Keep hosted input/approval bridge unshipped. | The adapter has no durable callback or permission-resolution contract. |
| `generic_http.async_rest` | Keep hosted input/approval bridge unshipped. | The adapter has no durable callback or permission-resolution contract. |

## Existing Context

`PRODUCT.md` records the R22 boundary and the exact remaining gap:

```md
R22 still does not ship generic process/PTY runtime adapters, Cursor/OpenClaw/Paperclip adapters, hosted browser automation, hosted `repo` execution, hosted approval bridge/input bridge/terminal bridge, hosted debate real participants, or hosted model judging.
```

`PRODUCT.md` also records the current local runtime capabilities that R23 must not overclaim as hosted:

```md
- `claude_code.sdk`: local bounded interactive Claude Code runtime mode with post-start input, session-state patches, runtime approval bridging, normalized tool events, and dual transcript artifacts (daemon default path uses structured `claude -p` stream-json IO).
- `codex.exec_json`: local non-interactive Codex CLI execution through `codex exec --json`.
- `codex.interactive`: local explicit-only Codex interactive mode with bounded post-start input, `waiting_for_input`/`waiting_for_approval` states, session-state patching (`codexThreadId`), and transcript artifacts capped/redacted under the existing runtime adapter contract.
```

The current hosted input route blocks hosted real-runtime input before it can reach a worker-owned session. R23 must replace this denial only for supported hosted bridge operations:

```ts
if (isHostedRealRun(run)) {
  if (isTerminalStatus(run.status)) {
    return sendHttpError(reply, "adapter_protocol_failed", "Run is not active", [
      { path: "reasonCode", issue: "runtime_input_not_active" }
    ]);
  }
  return sendHttpError(reply, "adapter_protocol_failed", "Hosted input bridge is not supported", [
    { path: "reasonCode", issue: "hosted_input_bridge_unsupported" }
  ]);
}
```

The core runner already has the local input and waiting-state rules R23 should preserve for hosted sessions:

```ts
async sendInput(runId: string, input: Record<string, unknown>): Promise<void> {
  const run = await this.requireRun(runId);
  if (this.isTerminal(run.status)) {
    throw new AdapterProtocolError("Runtime input is only supported for active runs.", {
      reasonCode: "runtime_input_not_active"
    });
  }
```

```ts
if (status === "waiting_for_input" || status === "waiting_for_approval") {
  const updated = await this.updateRunAndSessionStatus(runId, status, session);
  this.log("info", "runtime.status.waiting", { runId, status });
  return updated;
}
```

The local runner already knows how to convert adapter approval events into approval records, but the hosted worker currently does not provide this dependency:

```ts
if (!this.deps.runtimeApprovals) {
  return { reasonCode: "runtime_approval_bridge_unconfigured" };
}
```

`apps/worker/src/worker.ts` constructs a worker-owned `RuntimeRunnerService` without `runtimeApprovals`, so hosted approval requests currently fail closed rather than becoming resolvable hosted approvals:

```ts
const runner = new RuntimeRunnerService({
  runs,
  events,
  sessions,
  adapters,
  artifacts,
  artifactContent: {
    writeText: async (path, content) => {
      return artifactContent.writeText(path, content, { contentType: "application/x-ndjson" });
    }
  }
});
```

The hosted server currently constructs only the fake adapter. It must not become the owner of real provider sessions in R23:

```ts
const fakeAdapter = new FakeRuntimeAdapter();
const adapters = new Map<string, RuntimeAdapter>([["fake", fakeAdapter]]);
```

`apps/worker/src/hosted-runtime-adapters.ts` shows the closed hosted runtime adapter set. There is no hosted `codex.interactive` construction path today:

```ts
if (shouldEnableRealMode(config, "codex.exec_json")) {
  const hostedProviderCommand = config.deploymentMode === "production"
    ? resolveHostedProviderCommand(config, "codex.exec_json", { sandbox: "read-only" })
    : undefined;
```

```ts
if (shouldEnableRealMode(config, "claude_code.sdk")) {
  const hostedProviderCommand = config.deploymentMode === "production"
    ? resolveHostedProviderCommand(config, "claude_code.sdk")
    : undefined;
```

```ts
if (shouldEnableRealMode(config, "opencode.acp")) {
  const hostedProviderCommand = config.deploymentMode === "production"
    ? resolveHostedProviderCommand(config, "opencode.acp")
    : undefined;
```

The hosted runtime catalog is also closed to fake plus three known provider modes:

```ts
export type HostedRuntimeModeSlug = "fake.deterministic" | "codex.exec_json" | "claude_code.sdk" | "opencode.acp";
```

`claude_code.sdk` already has local structured input and approval resolution, but explicitly rejects hosted input today:

```ts
if (stored.hostedProviderMode) {
  throw new AdapterProtocolError("Hosted Claude input bridge is unsupported.", {
    reasonCode: "hosted_input_bridge_unsupported"
  });
}
```

```ts
if (input["type"] === "approval_resolution") {
  const runtimeApprovalToken = input["runtimeApprovalToken"];
  if (typeof runtimeApprovalToken !== "string" || !stored.pendingRuntimeApprovalTokens.has(runtimeApprovalToken)) {
    throw new AdapterProtocolError("Runtime approval pause is not active.", {
      reasonCode: "runtime_approval_pause_not_active"
    });
  }
```

`opencode.acp` is structured ACP, but permission requests currently fail visibly instead of creating approval records:

```ts
if (event.type === "permission_request") {
  const terminal = eventForFailure(
    runId,
    sequence++,
    this.hostedProviderCommand ? "hosted_approval_bridge_unsupported" : "acp_permission_request_unsupported"
  );
```

The ACP client currently auto-replies method-not-found before surfacing permission requests. R23 must change that behavior only for supported permission methods so approvals can be resolved through JSON-RPC response, not PTY:

```ts
if (isRequestMessage(message)) {
  const method = message.method;
  const eventType = method === "session/request_permission" ? "permission_request" : "unsupported_request";
  await this.replyMethodNotFound(message.id);
  this.eventQueue.push({
    type: eventType,
    message
  });
  return;
}
```

Generic HTTP and AgentField currently reject post-start input and have no approval callback contract:

```ts
async send(_session: Record<string, unknown>, _input: Record<string, unknown>): Promise<void> {
  throw new AdapterProtocolError("Generic HTTP async REST does not support input after start", {
    reasonCode: "generic_http_input_unsupported"
  });
}
```

```ts
async send(_session: Record<string, unknown>, _input: Record<string, unknown>): Promise<void> {
  throw new AdapterProtocolError("agentfield.async_rest does not support POST /runs/:id/input in R6.", {
    reasonCode: "agentfield_input_unsupported"
  });
}
```

Hosted approval routes currently deny runtime-scoped approvals because R22 was tool-scoped:

```ts
function classifyApprovalScope(approval: Approval): "tool" | "runtime" | "other" {
  if (typeof approval.payload["toolInvocationId"] === "string") {
    return "tool";
  }
  if (typeof approval.payload["runtimeApprovalToken"] === "string") {
    return "runtime";
  }
  return "other";
}
```

```ts
if (scope === "runtime") {
  return sendToolHttpError(reply, "hosted_runtime_approval_bridge_unshipped", "Runtime approvals are not resolved through hosted tool approval routes");
}
```

The public contract already includes runtime capability names and the hosted server route inventory already reuses `POST /runs/:id/input`, `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, and `POST /approvals/:id/reject`:

```ts
export const runtimeCapabilitySchema = z.enum([
  "run.start",
  "run.input",
  "run.cancel",
  "run.timeout",
  "session.state",
  "session.resume",
  "approval.bridge",
```

```ts
const HOSTED_SERVER_LOCAL_ROUTE_KEYS = new Set<string>([
  "POST /runs",
  "GET /runs",
  "GET /runs/:id",
  "GET /runs/:id/events",
  "GET /runs/:id/artifacts",
  "POST /runs/:id/input",
  "POST /runs/:id/cancel",
```

## Architecture

R23 adds a durable hosted runtime bridge layer between the hosted server and hosted worker. The server remains an admission, authorization, quota, audit, and command-recording surface. The worker remains the only process that owns real provider adapter instances and live runtime sessions. Runtime input and approval resolution therefore become durable commands claimed by the worker, not direct server-to-adapter calls.

The server flow is:

```text
POST /runs/:id/input or POST /approvals/:id/(approve|reject)
  -> hosted auth + existing route scope checks
  -> tenant/project ownership check for run and approval
  -> bridge capability check for run.runtimeMode + requested operation
  -> quota/idempotency/audit preflight
  -> persist hosted runtime bridge command
  -> enqueue or expose command to the worker-owned bridge queue
  -> return existing accepted/approval response without executing provider code in the server
```

The worker flow is:

```text
worker tick / bridge poll
  -> claim bridge command with idempotency key
  -> verify run/session still active and worker-owned
  -> verify session runtimeMode and command payload hash match persisted state
  -> call RuntimeRunnerService.sendInput or ApprovalService runtime resolution sender
  -> adapter sends structured input/approval resolution
  -> append visible events and audit records
  -> mark bridge command completed, failed, expired, or cancelled
```

The bridge service should use a durable logical command record with these fields, regardless of the exact storage table name CTO chooses:

```json
{
  "id": "runtime_bridge_command_abc",
  "runId": "run_abc",
  "runtimeSessionId": "session_abc",
  "runtimeMode": "claude_code.sdk",
  "operation": "input",
  "status": "queued",
  "idempotencyKey": "input_run_abc_hash",
  "payloadHash": "sha256:...",
  "payload": { "text": "[redacted-or-bounded]" },
  "attempts": 0,
  "lastReasonCode": null,
  "createdAt": "2026-06-01T00:00:00.000Z",
  "updatedAt": "2026-06-01T00:00:00.000Z"
}
```

The public `POST /runs/:id/input` response may remain `{ "accepted": true }`. If implementation adds an optional bridge command identifier, it must be additive and SDK-compatible; clients that only parse `accepted` must keep working.

Runtime approvals created by hosted workers must be normal approval records with `payload.runtimeApprovalToken`, `payload.runtimeSessionId`, `payload.runtimeMode`, and safe provider details. Ownership must be attached before the approval is visible through hosted approval list/get routes. Approval resolution must reuse the existing approve/reject routes and route to the worker-owned session through a bridge command.

Hosted runtime sessions need ownership/lease metadata sufficient to enforce worker ownership and restart reconciliation. The exact representation is CTO-owned, but the product contract is:

- A hosted session has one active worker owner or no active owner.
- A worker may apply input or approval only to sessions it owns or has just reclaimed through a verified restart-reconciliation path.
- If the session cannot be reclaimed safely, the run must terminalize visibly with `hosted_runtime_session_lost`.
- A stale bridge command must never execute against a newly started unrelated session.
- A replayed bridge command with the same idempotency key and same payload returns/settles consistently.
- A replayed bridge command with the same idempotency key and different payload fails with `hosted_runtime_bridge_payload_mismatch`.

## Runtime Matrix

### `claude_code.sdk`

R23 ships hosted bridge support for `claude_code.sdk` when all normal R21 provider activation gates pass and the run is active on a worker-owned session.

Required behavior:

- Hosted run input accepts non-empty `text` up to the existing 64 KiB public limit.
- Input is queued durably by the server and applied by the worker through the existing Claude `sendUserMessage` path.
- Claude runtime approval events create hosted-owned approval records.
- Hosted approval approve/reject routes resolve Claude approvals through the existing `resolveApproval` path.
- Session-state patches, including `claudeSessionId`, persist through the existing bounded `session.state` path.
- The runtime mode catalog/doctor/readiness may advertise hosted `run.input`, `session.state`, and `approval.bridge` only when the bridge service, worker queue, approval ownership, and worker readiness checks are available.
- Session resume is still not guaranteed. Worker restart or session loss must terminalize active waiting/running hosted Claude runs with `hosted_runtime_session_lost` unless implementation proves a durable resume path through deterministic tests.
- Hosted Claude remains read-only permission mode with `Bash`, `WebFetch`, and `WebSearch` disabled unless a later phase changes provider policy.

### `opencode.acp`

R23 ships hosted bridge support for `opencode.acp` only through structured ACP JSON-RPC.

Required behavior:

- The ACP client must be able to hold a `session/request_permission` request open, surface a Switchyard approval record, and answer the original JSON-RPC request after approval resolution.
- Unsupported ACP agent requests must still receive method-not-found and must not become generic callback execution.
- Follow-up input may be sent only as structured `session/prompt` on the same `acpSessionId`, only when the adapter marks the session as able to accept another prompt.
- Concurrent prompt/input attempts fail with `runtime_input_in_flight` or `acp_prompt_in_flight`.
- ACP session state must persist `acpSessionId`, prompt-active state, and pending permission request ids without raw prompt text or secrets in logs.
- If the ACP process exits, times out, or loses the pending JSON-RPC permission request before approval resolution, the approval is terminalized and the run fails visibly with a named ACP bridge reason.
- No PTY, terminal, or OpenCode TUI bridge is allowed.

### `codex.exec_json`

R23 keeps `codex.exec_json` as one-shot.

Required behavior:

- Hosted post-start input returns a `409`/adapter-protocol error with `hosted_input_bridge_unsupported` or `codex_exec_json_input_unsupported`.
- Hosted runtime approval resolution returns `hosted_runtime_approval_bridge_unshipped` or `codex_exec_json_approval_bridge_unsupported`.
- No hosted input command is queued for `codex.exec_json`.
- No hosted runtime capability or doctor output may imply `run.input`, `session.resume`, or hosted `approval.bridge` for `codex.exec_json`.

### `codex.interactive`

R23 keeps hosted `codex.interactive` unshipped.

Required behavior:

- Hosted run creation for `runtimeMode: "codex.interactive"` is rejected before queue side effects with `hosted_codex_interactive_unshipped` or an equivalent existing closed-catalog denial that clearly names the unsupported hosted mode.
- Registry/readiness/product truth must continue to say `codex.interactive` is explicit local-only.
- CTO must not add a hosted `codex.interactive` adapter, PTY/TUI bridge, terminal proxy, or app-server automation in R23.

### `agentfield.async_rest` and `generic_http.async_rest`

R23 keeps hosted runtime bridges unshipped for these modes.

Required behavior:

- Hosted run creation for these modes remains outside the R21 closed hosted runtime allowlist.
- Post-start input and runtime approval bridge attempts fail closed with mode-specific unsupported reason codes if such runs appear in local or test fixtures.
- Product truth must state that durable callback contracts are required before these modes can ship runtime-specific approval bridges.

## User-Visible Behavior

- A hosted `claude_code.sdk` run that enters `waiting_for_input` can receive `POST /runs/:id/input` with `{ "text": "continue with option A" }`. The API returns accepted, the run resumes on the worker, and run events show the status returning to `running` followed by output or terminal status.
- A hosted `claude_code.sdk` run that requests approval creates an owned hosted approval. The caller can list/get it through existing approval endpoints and approve/reject it through the same hosted approval routes used for tools. The worker applies the decision exactly once.
- A hosted `opencode.acp` run that emits `session/request_permission` creates an owned hosted approval. Approving or rejecting answers the original ACP JSON-RPC request; the run continues or fails according to the structured ACP response.
- A hosted `opencode.acp` session may accept follow-up input only through structured ACP `session/prompt` when the adapter says the session is waiting/ready. If the prompt is already active, the user receives a named conflict instead of a hidden duplicate prompt.
- A hosted `codex.exec_json` run still rejects post-start input because it is one-shot.
- A hosted `codex.interactive` request is rejected as unshipped. The user sees a named reason instead of a partial hosted session.
- If a worker restarts while a hosted runtime session is waiting and no verified resume path exists, the run fails visibly with `hosted_runtime_session_lost`, pending runtime approvals are expired/rejected, and the audit trail records the reconciliation.

## Data Flow Shadow Paths

### Flow 1: Hosted Post-Start Runtime Input

- Happy path: Active hosted `claude_code.sdk` or ready hosted `opencode.acp` session receives a non-empty text input. Server authorizes and records a bridge command, worker owns the session, adapter accepts input, and the run emits visible resumed/output events.
- Nil path: Request body is missing or not an object. Server returns `invalid_input`; no bridge command is created.
- Empty path: `text` is present but blank after trimming. Server returns `adapter_protocol_failed` with `runtime_input_empty` or a validation-equivalent named error; no bridge command is executed.
- Error path: Worker/session is missing, stale, no longer owned, unsupported, or already processing input. The bridge command fails with `hosted_runtime_session_lost`, `hosted_runtime_bridge_session_not_owned`, `hosted_input_bridge_unsupported`, or `runtime_input_in_flight`; the run receives a visible event when the failure affects runtime progress.

### Flow 2: Hosted Runtime Approval Request

- Happy path: Worker receives a structured Claude or ACP runtime approval request, creates an owned approval, emits `approval.requested`, marks run/session `waiting_for_approval`, and exposes the approval through hosted approval list/get.
- Nil path: Adapter approval event has no token/request id. Runtime fails with `runtime_approval_token_missing` or `acp_permission_request_invalid`; no pending approval survives.
- Empty path: Approval payload has an empty token, empty ACP request id, or empty permission action. Runtime fails with the same named invalid-request family; no hidden wait.
- Error path: Approval store, ownership attach, quota/audit write, or bridge service is unavailable. The run fails visibly with `runtime_approval_bridge_unconfigured`, `approval_ownership_attach_failed`, or `hosted_runtime_bridge_store_unavailable`; approval payloads are redacted.

### Flow 3: Hosted Runtime Approval Resolution

- Happy path: User approves/rejects an owned runtime approval through existing hosted approval routes. Server records a bridge command; worker applies the decision to the live Claude/ACP session; approval and run state advance exactly once.
- Nil path: Approval id does not exist or is not owned by the caller. Hosted route returns `approval_not_found` or tenant access denial without leaking cross-tenant existence.
- Empty path: Resolution body is empty. The system uses default actor/reason text already supported by `ApprovalService`; no provider secret or raw user body is invented.
- Error path: Approval is stale, not pending, expired, token no longer active, worker unavailable, or provider resolution fails. The route/command returns `approval_not_pending`, `runtime_approval_pause_not_active`, `hosted_runtime_bridge_worker_unavailable`, or a provider-specific named failure, with no duplicate dispatch.

### Flow 4: Worker Restart Reconciliation

- Happy path: Worker starts, reconciles bridge commands and hosted sessions, and either resumes only sessions with a verified durable provider resume path or continues processing queued bridge commands for currently owned sessions.
- Nil path: No session record exists for an active hosted real run. Reconciliation terminalizes the run with `hosted_runtime_session_missing`.
- Empty path: Session state exists but lacks required external key, worker owner, runtime mode, or bridge metadata. Reconciliation terminalizes with `hosted_runtime_session_state_incomplete`.
- Error path: Store, queue, object store, or approval terminalization fails during reconciliation. Readiness fails closed with named diagnostics and worker does not claim new hosted real-runtime bridge commands until reconciliation is safe.

## API And Contract Requirements

- Existing route names stay unchanged:
  - `POST /runs/:id/input`
  - `GET /approvals`
  - `GET /approvals/:id`
  - `POST /approvals/:id/approve`
  - `POST /approvals/:id/reject`
- Hosted server must not expose `POST /approvals`.
- Hosted server must not expose any public route containing `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox`.
- Hosted approval list/get must include tool approvals and supported runtime approvals owned by the authenticated tenant/project. If a query option is added to filter approval scope, it must be additive.
- Runtime approval payloads must include enough bounded metadata for the user to understand the decision: runtime mode, run id, approval type, provider action summary, expiration if present, and redacted provider details. They must not include raw prompts beyond existing bounds, credentials, env, command args, object keys, or provider secret material.
- The existing `AcceptedResponse` may stay `{ accepted: true }`. Optional fields must be backward compatible with SDK clients that only consume `accepted`.
- Hosted OpenAPI must include the existing input and approval routes, and must not add new arbitrary execution routes.
- Local daemon input/approval behavior must remain backward compatible.

## State, Ownership, Quotas, And Idempotency

- Every hosted runtime bridge command must be attached to the same account, tenant, project, user, and API key ownership as the run before it is visible or executable.
- Approval records created by a hosted worker must attach ownership before list/get can return them.
- Runtime input bridge commands count against a bounded runtime bridge quota or an existing run/action quota. The quota must prevent unbounded pending input/approval commands per run and per tenant.
- Runtime approval records count against existing approval quotas if available; otherwise R23 must add bounded per-run/per-tenant pending approval limits.
- Every bridge command must have an idempotency key derived from operation, run id, approval id if present, payload hash, and caller-supplied key if the existing route provides one.
- Duplicate commands with the same idempotency key and same payload are safe no-ops or return the existing command result.
- Duplicate commands with the same idempotency key and different payload fail with `hosted_runtime_bridge_payload_mismatch`.
- Commands must expire after a bounded TTL. Expired input commands must not be applied later to a resumed or replacement session.
- Worker claim and completion must be compare-and-update guarded so two workers cannot apply the same bridge command.

## Error Codes

R23 may reuse existing codes where exact. Expected new or normalized named failures include:

- `hosted_runtime_bridge_store_unavailable`
- `hosted_runtime_bridge_queue_unavailable`
- `hosted_runtime_bridge_worker_unavailable`
- `hosted_runtime_bridge_operation_unsupported`
- `hosted_runtime_bridge_session_missing`
- `hosted_runtime_bridge_session_not_owned`
- `hosted_runtime_session_missing`
- `hosted_runtime_session_lost`
- `hosted_runtime_session_state_incomplete`
- `hosted_runtime_bridge_payload_mismatch`
- `hosted_runtime_bridge_command_expired`
- `hosted_runtime_bridge_quota_exceeded`
- `hosted_codex_interactive_unshipped`
- `codex_exec_json_input_unsupported`
- `codex_exec_json_approval_bridge_unsupported`
- `acp_permission_request_invalid`
- `acp_permission_response_failed`
- `acp_permission_request_expired`
- `acp_prompt_in_flight`
- `acp_session_not_ready_for_input`
- `agentfield_bridge_unshipped`
- `generic_http_bridge_unshipped`

Existing codes that must remain visible and not be collapsed:

- `hosted_input_bridge_unsupported`
- `hosted_runtime_approval_bridge_unshipped`
- `hosted_approval_bridge_unsupported`
- `runtime_input_not_active`
- `runtime_input_empty`
- `runtime_input_too_large`
- `runtime_input_in_flight`
- `runtime_approval_token_missing`
- `runtime_approval_bridge_unconfigured`
- `runtime_approval_pause_not_active`
- `approval_not_found`
- `approval_not_pending`
- `approval_scope_denied`
- `adapter_protocol_failed`
- `hosted_runtime_not_allowed`
- `hosted_real_runtime_disabled`
- `provider_runtime_policy_missing`
- `provider_command_denied`

No expected operator, user, provider, store, quota, ownership, or runtime bridge failure may surface only as generic `internal_error`.

## Observability And Operations

- Hosted server logs must include bridge admission decisions by run id, runtime mode, operation, decision, reason code, request id, and redaction marker. They must not include raw input text, provider output, credentials, command args, env, object keys, or approval secrets.
- Hosted worker logs must include bridge claim/completion/failure by command id, run id, runtime mode, operation, and reason code.
- Metrics must stay low-cardinality: counters by runtime mode, operation, decision, and reason code are allowed; raw prompt text, approval payloads, object keys, cwd, env, provider outputs, and tokens are not.
- Server `/ready` must report hosted runtime bridge dependencies: command store, command queue/outbox, approval ownership support, quota support, audit support, and route auth support.
- Worker `ready({ mode: "claim" })` must report bridge dependencies: command claim support, session ownership/reconciliation state, adapter bridge capability, approval resolution sender, and bridge queue/outbox availability.
- Production preflight must fail closed when runtime bridge support is enabled without API-key auth, Postgres/control-plane ownership, Redis or durable command queue/outbox, audit store, quota store, worker readiness, or provider activation gates.
- Default canary/smoke must use fake Claude and fake ACP clients/processes. Live provider bridge canaries, if added, must require explicit spend confirmation and must not run by default.
- Worker startup must reconcile stale running/waiting hosted runtime sessions and pending bridge commands before claiming new real-runtime bridge work.

## Security Constraints

- The hosted server must never call provider adapters or hold provider sessions.
- The hosted worker must never trust request-owned executable/cwd/env/argv/process/PTY/terminal/sandbox values while applying bridge commands.
- Bridge commands must store bounded and redacted payloads.
- Approval answers and ACP permission data must be redacted before storage, logs, events, and transcript artifacts.
- Runtime output logs must continue to report byte counts and event types rather than raw text.
- Approval list/get must enforce tenant/project ownership before approval scope classification leaks existence.
- A caller with access to one run must not resolve approvals for another run or tenant.
- Unsupported bridge operations must fail before worker adapter dispatch.

## Acceptance Criteria

- [ ] Hosted server reuses `POST /runs/:id/input` for supported hosted runtime input and does not add any new public input route.
- [ ] Hosted server reuses existing approval list/get/approve/reject routes for supported hosted runtime approvals and does not expose hosted `POST /approvals`.
- [ ] Hosted server no longer blanket-rejects every hosted real-runtime input; it admits only supported active hosted runtime bridge operations after auth, ownership, quota, capability, and state checks.
- [ ] Hosted `claude_code.sdk` supports post-start text input through worker-owned sessions using existing body limits and visible waiting/running state transitions.
- [ ] Hosted `claude_code.sdk` creates owned runtime approval records and resolves approve/reject exactly once through worker-owned sessions.
- [ ] Hosted `claude_code.sdk` session-state patches persist with existing bounds/redaction, while hosted session resume remains unclaimed unless proven by deterministic tests.
- [ ] Hosted `opencode.acp` supports structured ACP permission approval by holding and answering `session/request_permission` JSON-RPC requests without PTY.
- [ ] Hosted `opencode.acp` supports structured follow-up input only when the ACP session is ready for another `session/prompt`.
- [ ] Hosted `opencode.acp` rejects concurrent prompts/input with named conflict errors.
- [ ] Hosted `codex.exec_json` remains one-shot and rejects input/approval bridge attempts with named unsupported errors.
- [ ] Hosted `codex.interactive` remains unshipped and rejected before queue side effects with a named unshipped/unsupported reason.
- [ ] AgentField and Generic HTTP hosted runtime bridges remain unshipped with explicit fail-closed behavior and product truth.
- [ ] Runtime bridge commands are durable, tenant/project owned, quota-scoped, idempotent, compare-and-update guarded, and bounded by TTL.
- [ ] Worker restart reconciliation terminalizes or safely resumes active hosted sessions; no active hosted run remains silently stuck in `waiting_for_input` or `waiting_for_approval`.
- [ ] Pending hosted runtime approvals are expired/rejected on timeout, cancellation, run failure, or unrecoverable worker restart.
- [ ] Local daemon runtime input/approval behavior remains backward compatible.
- [ ] Hosted tool approvals from R22 continue to work unchanged.
- [ ] Hosted approval routes can safely distinguish tool approvals, supported runtime approvals, and other approvals without cross-tenant existence leaks.
- [ ] Readiness, preflight, smoke/canary, metrics, audit, logs, OpenAPI, SDK behavior, development docs, and `PRODUCT.md` match the shipped bridge boundary.
- [ ] Default tests, smoke, preflight, and canary are deterministic and no-spend.
- [ ] OpenAPI and route tests prove no public arbitrary execution routes were added.

## Required Tests

All required tests must be deterministic and no-spend.

- Contract tests:
  - hosted approval routes allow supported runtime approvals and still protect tool approvals;
  - `AcceptedResponse` remains backward compatible;
  - hosted runtime bridge error codes are in the closed HTTP error set;
  - runtime capability/limitation output truthfully represents hosted Claude/OpenCode bridges and hosted Codex deferrals;
  - hosted OpenAPI route absence checks for `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, `/sandbox`, and any top-level bridge route.
- Storage/queue tests:
  - durable bridge command create/claim/complete/fail/expire;
  - idempotent duplicate same-payload command;
  - duplicate idempotency key with different payload;
  - stale command TTL;
  - ownership attach and tenant-scoped list/get behavior;
  - additive migration from pre-R23 schema.
- Core runtime tests:
  - hosted input happy/nil/empty/error paths;
  - hosted runtime approval request happy/nil/empty/error paths;
  - hosted approval resolution happy/nil/empty/error paths;
  - worker restart reconciliation happy/nil/empty/error paths;
  - pending approval terminalization on timeout/cancel/failure/restart.
- Hosted server route tests:
  - auth required;
  - missing scope;
  - tenant mismatch without existence leak;
  - run not found;
  - terminal run;
  - unsupported runtime mode;
  - `codex.exec_json` unsupported input;
  - `codex.interactive` hosted unshipped;
  - bridge quota exceeded;
  - command store unavailable;
  - accepted hosted Claude input;
  - accepted hosted OpenCode input when ready;
  - runtime approval approve/reject dispatches once.
- Hosted worker tests:
  - fake Claude hosted input accepted;
  - fake Claude approval request and resolution;
  - fake Claude worker restart with no resume terminalizes visibly;
  - fake ACP permission request held and answered;
  - fake ACP method-not-found remains for unsupported requests;
  - fake ACP follow-up prompt accepted only when ready;
  - fake ACP prompt conflict;
  - worker ownership mismatch fails closed;
  - stale command does not apply to replacement session.
- Adapter tests:
  - Claude hosted mode no longer rejects supported bridge input when worker bridge capability is enabled;
  - Claude still rejects unsupported payload shapes;
  - ACP client can defer and later answer `session/request_permission`;
  - ACP client still rejects unsupported agent methods;
  - OpenCode ACP artifacts and transcripts remain bounded/redacted;
  - Generic HTTP and AgentField continue to reject post-start input and have no approval bridge.
- Ops tests:
  - server `/ready` with bridge disabled;
  - server `/ready` bridge enabled missing store/queue/auth/quota/audit;
  - worker claim readiness bridge enabled missing approval sender/session reconciliation;
  - production preflight fail-closed cases;
  - deterministic no-spend hosted runtime bridge smoke;
  - product truth and development docs contain shipped/unshipped boundary wording.
- Security/redaction tests:
  - secret-like fields in input, approval payload, ACP params, provider output, env, command metadata, logs, events, audit payloads, and artifact metadata are redacted;
  - cross-tenant approval resolution is denied before approval scope leaks;
  - stale/replayed bridge command cannot target a different session.

Suggested verification command set for CTO to refine:

```bash
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/core test -- runtime
pnpm --filter @switchyard/protocol-rest test -- run-routes
pnpm --filter @switchyard/protocol-rest test -- hosted-tool-routes
pnpm --filter @switchyard/protocol-acpx test
pnpm --filter @switchyard/adapters test -- claude-code
pnpm --filter @switchyard/adapters test -- opencode-acp
pnpm --filter @switchyard/server test
pnpm --filter @switchyard/worker test
pnpm exec vitest run scripts/production-preflight.test.ts
pnpm --filter @switchyard/contracts openapi:check
pnpm --filter @switchyard/contracts openapi:check:hosted
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

## Task Themes

1. **Contracts, Storage, And Bridge Command Model**
   - Add durable hosted runtime bridge command contracts/storage/queue or outbox support; add error codes; update OpenAPI and hosted route contract tests without adding new public routes.
   - Complexity: M.

2. **Hosted Server Runtime Bridge Admission**
   - Replace blanket hosted input denial with supported-runtime admission; extend hosted approval routes to runtime-scoped approvals; enforce auth, ownership, quota, idempotency, audit, and unsupported-mode fail-closed behavior.
   - Complexity: L.

3. **Worker-Owned Session Bridge And Reconciliation**
   - Add worker bridge command claiming, session ownership/lease checks, runtime approval creation, approval resolution sender, input dispatch, command terminalization, metrics/logs, and restart reconciliation before new claims.
   - Complexity: L.

4. **Claude Hosted Bridge**
   - Enable hosted Claude input and approval resolution only through worker bridge plumbing; preserve read-only provider policy, local behavior, redaction, session-state bounds, and no session-resume overclaiming.
   - Complexity: M.

5. **OpenCode ACP Structured Bridge**
   - Extend ACP client and OpenCode adapter for held permission requests, structured approval responses, bounded follow-up `session/prompt`, prompt conflict handling, and no-PTY regression tests.
   - Complexity: L.

6. **Unsupported Runtime Boundaries, Ops, And Product Truth**
   - Add fail-closed tests/docs/readiness for Codex one-shot, hosted Codex interactive unshipped, AgentField/Generic HTTP deferred bridges, production preflight, no-spend smoke/canary, and product truth updates.
   - Complexity: M.

## Phase

### Phase 22: R23 Hosted Runtime Input And Approval Bridges

**Goal:** Ship worker-owned hosted runtime input and approval bridge plumbing for `claude_code.sdk` and structured `opencode.acp`, while keeping hosted Codex interactive, AgentField/Generic HTTP bridges, PTY/TUI/terminal automation, arbitrary execution routes, dashboard, and TUI out of scope.

**Acceptance:**

- Hosted Claude Code can accept supported post-start input and runtime approval resolution through the existing run input and approval endpoints.
- Hosted OpenCode ACP can bridge structured prompt/input/session/permission approval lifecycle through ACP JSON-RPC only.
- Hosted bridge commands are durable, owned, audited, quota-scoped, idempotent, worker-claimed, and restart-reconciled.
- Unsupported bridge operations for `codex.exec_json`, `codex.interactive`, AgentField, Generic HTTP, terminal, PTY, and TUI fail closed with named reason codes.
- Existing local daemon and R22 hosted tool behavior remain backward compatible.
- Readiness, preflight, smoke/canary, OpenAPI, tests, docs, and product truth match the shipped and unshipped boundary.

**Non-goals (this phase):** Dashboard; TUI; public arbitrary execution routes; public terminal/PTY/sandbox/process routes; hosted terminal bridge; PTY/TUI automation; hosted `codex.interactive`; live Codex resume guarantee; AgentField/Generic HTTP hosted bridges; Cursor/OpenClaw/Paperclip; browser automation; hosted debate real participants; hosted model judging; managed SaaS/payments/OAuth/SSO.

**Complexity:** L

## Required Product Truth After R23

After audit GREEN, product truth must say:

- R23 ships hosted runtime input and approval bridge plumbing for `claude_code.sdk`.
- R23 ships structured hosted OpenCode ACP prompt/input/permission approval bridging only through ACP JSON-RPC.
- Hosted runtime sessions are worker-owned, tenant/project scoped, audited, quota-scoped, idempotent, restart-reconciled, and fail closed when unsupported.
- `codex.exec_json` remains one-shot and does not support hosted input or approval bridging.
- `codex.interactive` remains explicit local-only and hosted-unshipped.
- AgentField and Generic HTTP hosted runtime approval/input bridges remain unshipped pending durable callback contracts.
- Hosted terminal bridge, PTY/TUI automation, arbitrary execution routes, dashboard, TUI, generic process/PTY adapters, browser automation, hosted debate real participants, and model judging remain unshipped.

## Auditor Focus

Auditor must explicitly verify:

- No public `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, `/sandbox`, or top-level runtime bridge route was added.
- Hosted server does not instantiate or call real provider adapters.
- Hosted runtime input and approval resolution are durable commands applied only by the worker that owns the live session.
- Approval ownership is attached before hosted list/get can return runtime approvals.
- Cross-tenant approval and input attempts do not leak resource existence.
- Worker restart reconciliation prevents stuck hosted runs and stale approvals.
- Hosted `codex.interactive` was not added to the hosted runtime catalog or worker factory.
- OpenCode ACP approval resolution uses JSON-RPC responses, not PTY/TUI automation.
- Generic HTTP and AgentField bridge behavior remains explicitly unsupported.
- Default tests, smoke, preflight, and canary remain no-spend.
- Product docs do not overclaim hosted Codex, terminal bridge, session-resume guarantees, dashboard/TUI, arbitrary execution, generic adapters, browser automation, hosted debate real participants, or model judging.
