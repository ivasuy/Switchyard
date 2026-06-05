# Phase 22: R23 Hosted Runtime Input And Approval Bridges - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md`
**Branch:** `agent/phase-22-r23-hosted-runtime-bridges`
**Base/spec commit:** `f635bbf`
**Complexity:** L

## Goal

Ship worker-owned hosted runtime input and approval bridge plumbing for `claude_code.sdk` and structured `opencode.acp`, while preserving existing endpoints, no-spend defaults, tenant/project isolation, and explicit fail-closed behavior for Codex, AgentField, Generic HTTP, terminal, PTY, dashboard, and TUI scope.

## Scope Challenge

1. Existing code already solves local runtime input (`RuntimeRunnerService.sendInput`), local runtime approvals (`ApprovalService` plus `runtimeApprovals`), hosted auth/ownership/audit/quota primitives (`ControlPlaneService`), hosted run queueing (`HostedRunService`, `MemoryRunQueue`, `BullMqRunQueue`), hosted worker real-runtime adapter construction, session state patching, and hosted tool approval routes. R23 extends those paths instead of adding a new public bridge API or server-owned provider session.
2. The minimum shippable change is durable bridge command admission, worker claim/apply/reconciliation, hosted Claude bridge enablement, structured ACP permission/input support, route/readiness/preflight/canary truth, and unsupported-mode denial tests. Hosted `codex.interactive`, Generic HTTP callbacks, AgentField callbacks, terminal/PTY automation, dashboard, and TUI remain documentation plus fail-closed assertions only.
3. Complexity smell is real: the phase must touch more than eight files because contracts, storage, core services, REST routes, server wiring, worker wiring, two adapters, protocol ACP, ops scripts, and product truth must agree. The plan controls blast radius with nine disjoint task ownership slices and narrow exported contracts between slices.
4. Built-ins and existing dependencies are sufficient: Zod schemas, Fastify hooks, existing `ControlPlaneService`, existing approval and run stores, existing Postgres schema migration guard, existing redaction helper, existing runtime runner waiting-state logic, Node `crypto` hashing, existing ACP JSON-RPC parser/client, existing fake Claude and fake ACP testkit, and existing OpenAPI generation scripts. No new dependency is planned.
5. Distribution impact stays inside existing packages and existing ops commands. No new public package, public route family, dashboard, TUI, terminal bridge, process/PTY adapter, or managed hosted deployment artifact ships.

## Architecture

R23 adds a durable hosted runtime bridge command layer. The hosted server remains the admission surface: it authenticates API keys, checks scopes and run or approval ownership, validates runtime bridge capability, reserves bounded quota, writes audit, persists an idempotent bridge command, and returns the existing accepted/approval response. The server never constructs provider adapters and never talks to Claude, OpenCode, Codex, AgentField, Generic HTTP, shell, PTY, or terminal processes.

The worker remains the only owner of provider sessions. Worker startup reconciles active hosted real-runtime sessions and stale commands before claiming new bridge work. Bridge command application reloads durable run/session/approval state, verifies worker ownership and payload hash, then calls the existing `RuntimeRunnerService.sendInput` path with either text input or an `approval_resolution` payload. The runner and adapters keep the existing visible waiting/running transitions and transcript behavior.

```
POST /runs/:id/input
  -> hosted auth + runs:write
  -> run ownership before existence leaks
  -> active hosted runtime capability check
  -> quota + idempotency + audit
  -> durable bridge command
  -> worker claim/apply through RuntimeRunnerService.sendInput

POST /approvals/:id/approve|reject
  -> hosted auth + runs:write
  -> approval ownership before scope classification
  -> runtime approval CAS + command persist
  -> worker claim/apply approval_resolution exactly once
```

Durability is an outbox-style store, not a new public route. A command is keyed by operation, run id, optional approval id, runtime session id, runtime mode, idempotency key, payload hash, status, lease metadata, attempts, TTL, ownership ids, and redacted bounded payload. Duplicate same-key/same-payload commands return consistently; same-key/different-payload fails with `hosted_runtime_bridge_payload_mismatch`. Compare-and-update claim and completion guards prevent two workers from applying the same command.

Bridge lifecycle semantics are explicit:

- Quota reserve happens only for newly queued commands. Duplicate same-payload admissions reuse the existing command and do not reserve again. Duplicate different-payload admissions fail before quota mutation. Claimed commands keep their reservation. Completed, failed, expired, and cancelled commands release active-command quota and consume only the hourly admission unit already reserved. Worker crash after claim leaves the command leased until stale-claim reconciliation.
- Provider-side input is treated as non-idempotent. If a worker crashes after adapter send but before command completion, reconciliation must not blindly retry provider input or approval resolution. It marks the stale claim terminal/failed unless a future adapter exposes a durable provider ack that proves retry safety.
- Approval approve/reject is a compare-and-set race. Exactly one durable decision wins. Same idempotency key and same decision can return the existing result; a different decision or late loser returns `approval_not_pending`.
- ACP held request TTL, `approval.expiresAt`, and `command.expiresAt` share one explicit deadline value. Resolution after expiry returns `acp_permission_request_expired` and must not write a JSON-RPC response.
- Payload hash is computed from normalized raw payload bytes in memory before redaction. Storage persists only the hash, byte count, and redacted payload summary. Distinct secret-bearing inputs must still produce distinct payload hashes even if their redacted summaries are identical.
- Hosted approval list/get keeps pagination and filtering stable when tool approvals and runtime approvals are mixed; authorization runs before scope classification.
- Forbidden-route and source tests are first-class: hosted server must not expose bridge/execution/shell/PTY/terminal/sandbox routes and must not import or instantiate real provider adapters.

```
server admission              durable command store          worker-owned runtime
---------------              ---------------------          --------------------
auth/ownership/quota  ----->  queued command          -----> claim with lease
audit allow/deny             payload hash + TTL             verify run/session owner
202 {accepted:true}          owner ids + status             adapter.send(...)
approval response            no provider side effect         complete/fail/expire
```

## File Structure

- `packages/contracts/src/hosted-runtime-bridge.ts` - new strict bridge command schemas, command operation/status enums, capability matrix helpers, and response fragments consumed by core, storage, REST, OpenAPI, and tests.
- `packages/contracts/src/http-error.ts`, `enterprise.ts`, `endpoint-inventory.ts`, `openapi.ts`, generated OpenAPI JSON, and contract tests - R23 named errors, runtime bridge ownership/quota types, existing route inventory, and route absence assertions.
- `packages/storage/src/postgres/hosted-runtime-bridge-command-store.ts`, Postgres schema/database files, storage exports, and storage tests - durable command table/outbox, additive migration, TTL, compare-and-update claim, complete, fail, expire, stale-claim recovery, and payload mismatch coverage.
- `packages/core/src/ports/hosted-runtime-bridge-command-store.ts`, `services/hosted-runtime-bridge-service.ts`, `runtime-runner-service.ts`, and core tests - command creation, ownership/quota/audit/idempotency, session ownership metadata, worker claim/apply, approval terminalization, and restart reconciliation.
- `packages/protocol-rest/src/run-routes.ts`, `hosted-tool-routes.ts`, `http-errors.ts`, protocol REST tests, `apps/server/src/app.ts`, and server readiness tests - existing input and approval routes admit only supported bridge operations and report bridge dependencies.
- `apps/worker/src/worker.ts`, `hosted-runtime-adapters.ts`, `ready.ts`, and worker tests - worker service construction, bridge claim loop, runtime approval creation ownership, adapter bridge capability wiring, metrics/logs, and claim readiness.
- `packages/adapters/src/claude-code/*`, Claude adapter tests, and fake Claude testkit - hosted bridge enablement only when worker config opts in; local behavior and read-only policy stay intact.
- `packages/protocol-acpx/*`, ACP tests, and fake ACP testkit - held `session/request_permission` requests and later JSON-RPC response support while unsupported requests still receive method-not-found.
- `packages/adapters/src/opencode/*` and OpenCode adapter tests - structured hosted OpenCode follow-up prompts, permission approval lifecycle, prompt conflict handling, bounded/redacted transcripts, and no-PTY assertions.
- `scripts/*`, `deploy/production/*`, `PRODUCT.md`, `README.md`, and development docs - fail-closed preflight/readiness/canary/smoke behavior and product truth.

## Existing Context

`docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md` defines the exact shipped/unshipped runtime bridge matrix, named failure codes, no-spend tests, security constraints, and auditor focus.

`packages/protocol-rest/src/run-routes.ts` currently blocks all hosted real-runtime input:

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

`packages/core/src/services/runtime-runner-service.ts` already has the local input and waiting-state behavior R23 must reuse:

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

`apps/worker/src/worker.ts` constructs a worker-owned runner without hosted runtime approval dependencies today:

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

`packages/protocol-rest/src/hosted-tool-routes.ts` already classifies runtime approvals but rejects them:

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

`packages/adapters/src/claude-code/claude-code-adapter.ts` already knows how to send text and approval resolution locally, but rejects hosted mode before reaching that code:

```ts
if (stored.hostedProviderMode) {
  throw new AdapterProtocolError("Hosted Claude input bridge is unsupported.", {
    reasonCode: "hosted_input_bridge_unsupported"
  });
}
```

`packages/protocol-acpx/src/acp-stdio-client.ts` currently auto-replies method-not-found before the adapter can hold a permission request:

```ts
const eventType = method === "session/request_permission" ? "permission_request" : "unsupported_request";
await this.replyMethodNotFound(message.id);
this.eventQueue.push({
  type: eventType,
  message
});
```

`packages/adapters/src/opencode/opencode-acp-adapter.ts` currently fails hosted permission requests instead of creating runtime approvals:

```ts
if (event.type === "permission_request") {
  const terminal = eventForFailure(
    runId,
    sequence++,
    this.hostedProviderCommand ? "hosted_approval_bridge_unsupported" : "acp_permission_request_unsupported"
  );
```

## Task Graph

### Task P22-T1-contracts-openapi

```json
{
  "id": "P22-T1-contracts-openapi",
  "title": "Define hosted runtime bridge contracts and OpenAPI boundaries",
  "files": [
    "packages/contracts/src/hosted-runtime-bridge.ts",
    "packages/contracts/src/http-error.ts",
    "packages/contracts/src/enterprise.ts",
    "packages/contracts/src/index.ts",
    "packages/contracts/src/endpoint-inventory.ts",
    "packages/contracts/src/openapi.ts",
    "packages/contracts/src/openapi.contract.test.ts",
    "packages/contracts/src/endpoint-inventory.drift.test.ts",
    "packages/contracts/src/http-error.contract.test.ts",
    "packages/contracts/test/contracts.test.ts",
    "packages/contracts/openapi.local-daemon.json",
    "packages/contracts/openapi.hosted-server.json"
  ],
  "dependencies": [],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md",
    "packages/contracts/src/http-error.ts",
    "packages/contracts/src/enterprise.ts",
    "packages/contracts/src/approval.ts",
    "packages/contracts/src/session.ts",
    "packages/contracts/src/endpoint-inventory.ts",
    "packages/contracts/src/openapi.ts"
  ],
  "instructions": "Add hosted-runtime-bridge contracts with strict Zod schemas for command operation input or approval_resolution, command status queued/claimed/completed/failed/expired/cancelled, supported hosted bridge runtime modes claude_code.sdk and opencode.acp, unsupported mode reason mapping, redacted payload summary, normalized raw-payload hash metadata, one explicit expiresAt deadline, accepted response extension bridgeCommandId, and exact readiness report shapes including session_reconciliation and approval_sender check names. Add all R23 reason codes to http-error contracts, including hosted_runtime_bridge_non_idempotent_retry_blocked with a 409 conflict/adapter_protocol_failed REST status mapping. Extend enterprise ownership with runtime_bridge_command and quota kinds runtime_bridge_commands_per_hour and active_runtime_bridge_commands with backward-compatible zero defaults. Update hosted OpenAPI only for existing POST /runs/:id/input, GET /approvals, GET /approvals/:id, POST /approvals/:id/approve, and POST /approvals/:id/reject. Do not add POST /approvals or any public bridge/execution route. Add route inventory tests proving hosted OpenAPI has no route containing /exec, /shell, /process, /command, /pty, /terminal, /sandbox, top-level /input, top-level /approval, /runtime-bridge, /session, dashboard, or tui.",
  "acceptance": [
    "Hosted runtime bridge schemas parse valid input and approval_resolution command fixtures.",
    "Schemas reject missing run id, missing operation, unknown operation, unknown status, unbounded payloads, missing expiresAt, and secret-like raw payload fields in persisted payload summaries.",
    "HostedRuntimeBridgeCommand type includes owner ids, runtime session id, optional approval id, payloadHash, redactedPayload, payloadBytes, lease metadata, attempts, reasonCode, and timestamps.",
    "HTTP error contract includes every R23 hosted runtime bridge and ACP reason code listed in the spec plus hosted_runtime_bridge_non_idempotent_retry_blocked with a 409 conflict/adapter_protocol_failed mapping.",
    "Enterprise schemas include runtime_bridge_command ownership and runtime bridge quota kinds without breaking existing bootstrap fixtures.",
    "Hosted OpenAPI documents existing run input and approval routes for runtime bridge usage without adding new public route families.",
    "Route inventory tests fail if hosted OpenAPI exposes bridge, arbitrary execution, shell, PTY, terminal, sandbox, dashboard, or TUI routes."
  ],
  "checks": [
    "pnpm --filter @switchyard/contracts test -- openapi.contract.test.ts endpoint-inventory.drift.test.ts http-error.contract.test.ts",
    "pnpm --filter @switchyard/contracts test -- contracts.test.ts",
    "pnpm --filter @switchyard/contracts openapi:check",
    "pnpm --filter @switchyard/contracts openapi:check:hosted",
    "pnpm --filter @switchyard/contracts typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    { "codepath": "hostedRuntimeBridgeCommandSchema.parse", "failure": "Malformed operation, status, runtime mode, run id, TTL, owner ids, payload size, redacted payload, or payload hash", "exception": "ZodError", "rescue": "Reject before persistence, quota mutation, audit allow, or queue side effects.", "user_sees": "400 invalid_input or 409 adapter_protocol_failed with a named reason code; no command is queued." },
    { "codepath": "httpErrorCodeSchema.parse", "failure": "Route or service emits an unregistered R23 reason as an HTTP code", "exception": "ZodError in contract tests", "rescue": "Add the named code to the closed schema and status mapping before route work proceeds.", "user_sees": "Named bridge errors instead of generic internal_error." },
    { "codepath": "hosted endpoint inventory", "failure": "OpenAPI generation exposes POST /approvals or forbidden execution, terminal, PTY, sandbox, dashboard, TUI, or bridge routes", "exception": "Vitest assertion failure", "rescue": "Remove the route from the hosted surface and keep only existing input and approval endpoints.", "user_sees": "Hosted API remains limited to existing run input and approval endpoints." }
  ],
  "observability": {
    "logs": ["Contract task adds no runtime logs.", "OpenAPI contract tests print failing route keys when route inventory drifts."],
    "success_metric": "Hosted OpenAPI contains existing bridge-capable routes and zero forbidden route keys.",
    "failure_metric": "Any unknown HTTP code, schema gap, or forbidden route key fails contract tests."
  },
  "test_cases": [
    { "name": "parses valid bridge input command", "lens": "happy", "given": "Command fixture with runId, runtimeSessionId, operation input, status queued, expiresAt, payloadHash, redactedPayload, payloadBytes, and owner ids", "expect": "Parsed command has operation input and no raw prompt text field." },
    { "name": "rejects missing run id", "lens": "error_path", "given": "hostedRuntimeBridgeCommandSchema.parse fixture with runId omitted", "expect": "ZodError before persistence." },
    { "name": "rejects unknown operation and status", "lens": "error_path", "given": "Command fixture with operation shell or status retrying", "expect": "ZodError with paths operation or status." },
    { "name": "rejects unbounded payload", "lens": "error_path", "given": "Command fixture with redactedPayload or payloadBytes exceeding configured bounds", "expect": "ZodError and no command row can be produced by downstream tasks." },
    { "name": "rejects nil payload", "lens": "happy_shadow_nil", "given": "Command fixture with redactedPayload undefined", "expect": "ZodError with path redactedPayload." },
    { "name": "rejects empty idempotency key", "lens": "happy_shadow_empty", "given": "Command fixture with idempotencyKey empty string", "expect": "ZodError with path idempotencyKey." },
    { "name": "hosted openapi excludes forbidden routes", "lens": "error_path", "given": "Generated hosted OpenAPI route keys", "expect": "No key includes forbidden execution, bridge, terminal, PTY, sandbox, dashboard, or TUI route fragments." },
    { "name": "registers non-idempotent retry blocked reason", "lens": "error_path", "given": "httpErrorCodeSchema and REST status mapping for hosted_runtime_bridge_non_idempotent_retry_blocked", "expect": "Reason code parses and maps to 409 adapter_protocol_failed." },
    { "name": "accepted response remains backward compatible", "lens": "integration", "given": "acceptedResponseSchema parses accepted true with and without bridgeCommandId", "expect": "Both payloads parse successfully." }
  ],
  "integration_contracts": {
    "exports": [
      { "name": "hostedRuntimeBridgeCommandSchema", "kind": "constant", "signature": "ZodType<HostedRuntimeBridgeCommand>" },
      { "name": "HostedRuntimeBridgeCommand", "kind": "type", "signature": "{ id:string; runId:string; approvalId?:string; runtimeSessionId?:string; runtimeMode:'claude_code.sdk'|'opencode.acp'|'codex.exec_json'|string; operation:'input'|'approval_resolution'; status:'queued'|'claimed'|'completed'|'failed'|'expired'|'cancelled'; idempotencyKey:string; payloadHash:string; redactedPayload:Record<string, unknown>; payloadBytes:number; tenantId:string; projectId:string; accountId:string; userId:string; apiKeyId:string; workerId?:string; leaseUntil?:string; attempts:number; maxAttempts:number; reasonCode?:string; expiresAt:string; createdAt:string; updatedAt:string; }" },
      { "name": "HostedRuntimeBridgeReadinessReport", "kind": "type", "signature": "{ status:'ready'|'not_ready'; checks: Array<{ name:'command_store'|'command_outbox'|'approval_ownership'|'quota'|'audit'|'route_auth'|'worker_claim'|'adapter_capability'|'session_reconciliation'|'approval_sender'; ok:boolean; reasonCode?:string }> }" },
      { "name": "isHostedRuntimeBridgeSupportedMode", "kind": "function", "signature": "(runtimeMode: string, operation?: 'input' | 'approval_resolution') => boolean" },
      { "name": "HOSTED_RUNTIME_BRIDGE_REASON_CODES", "kind": "constant", "signature": "readonly string[] including hosted_runtime_bridge_store_unavailable, hosted_runtime_bridge_queue_unavailable, hosted_runtime_bridge_worker_unavailable, hosted_runtime_bridge_operation_unsupported, hosted_runtime_bridge_session_missing, hosted_runtime_bridge_session_not_owned, hosted_runtime_session_missing, hosted_runtime_session_lost, hosted_runtime_session_state_incomplete, hosted_runtime_bridge_payload_mismatch, hosted_runtime_bridge_command_expired, hosted_runtime_bridge_non_idempotent_retry_blocked, hosted_runtime_bridge_quota_exceeded, hosted_codex_interactive_unshipped, codex_exec_json_input_unsupported, codex_exec_json_approval_bridge_unsupported, agentfield_bridge_unshipped, generic_http_bridge_unshipped" },
      { "name": "ACP_RUNTIME_BRIDGE_REASON_CODES", "kind": "constant", "signature": "readonly string[] including acp_permission_request_invalid, acp_permission_response_failed, acp_permission_request_expired, acp_prompt_in_flight, acp_session_not_ready_for_input" }
    ],
    "imports_from_other_tasks": [],
    "file_paths_consumed_by_other_tasks": ["packages/contracts/src/hosted-runtime-bridge.ts", "packages/contracts/src/http-error.ts", "packages/contracts/src/enterprise.ts", "packages/contracts/openapi.hosted-server.json"]
  }
}
```

### Task P22-T2-storage-outbox

```json
{
  "id": "P22-T2-storage-outbox",
  "title": "Add durable hosted runtime bridge command outbox storage",
  "files": [
    "packages/storage/src/postgres/hosted-runtime-bridge-command-store.ts",
    "packages/storage/src/postgres/schema.ts",
    "packages/storage/src/postgres/database.ts",
    "packages/storage/src/index.ts",
    "packages/storage/test/postgres-runtime-bridge-store.test.ts",
    "packages/storage/test/postgres-schema-compat.test.ts",
    "packages/storage/test/storage-package.test.ts"
  ],
  "dependencies": ["P22-T1-contracts-openapi"],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md",
    "packages/storage/src/postgres/tool-dispatch-outbox-store.ts",
    "packages/storage/src/postgres/database.ts",
    "packages/storage/src/postgres/schema.ts",
    "packages/storage/src/postgres/control-plane-store.ts",
    "packages/storage/src/index.ts",
    "packages/contracts/src/http-error.ts"
  ],
  "instructions": "Create a Postgres hosted runtime bridge command outbox following the existing tool dispatch outbox style. Add additive schema, indexes, database construction, exports, and storage tests. Persist command id, operation, status, run id, approval id, runtime session id, runtime mode, idempotency key, payloadHash, payloadBytes, redactedPayload, owner ids, attempts, maxAttempts, workerId, leaseUntil, reasonCode, expiresAt, createdAt, and updatedAt. Do not persist raw input or raw approval payload. Provide create-or-return-idempotent, get, getByIdempotencyKey, claimNext, complete, fail, expireStale, recoverStaleClaims, and listByRun storage-test-only helper behavior. Compare-and-update must protect claim, complete, fail, and stale recovery. Stale recovery must implement the non-idempotent provider posture: claimed commands past lease are failed terminally with hosted_runtime_bridge_non_idempotent_retry_blocked by default unless the caller supplies retry_if_adapter_ack and a command has durable adapter ack metadata. Storage must preserve same-payload duplicate behavior and reject same-key different payload with hosted_runtime_bridge_payload_mismatch.",
  "acceptance": [
    "Postgres schema adds only additive hosted runtime bridge command table/index changes.",
    "Store persists only payload hash, payload byte count, and redacted payload summary, never raw text, provider command, env, object key, token, or provider output.",
    "Duplicate idempotency key with same payloadHash returns the existing command and duplicate true without a second row.",
    "Duplicate idempotency key with different payloadHash fails with hosted_runtime_bridge_payload_mismatch and leaves the original row unchanged.",
    "Queued commands can be claimed exactly once by lease and cannot be claimed after expiry.",
    "Completed, failed, expired, and cancelled commands cannot be completed again or claimed again.",
    "recoverStaleClaims defaults stale claimed commands to failed with hosted_runtime_bridge_non_idempotent_retry_blocked instead of retrying provider input.",
    "listByRun is a storage-test-only helper and is intentionally not part of the core HostedRuntimeBridgeCommandStore port.",
    "Schema compatibility and storage package exports remain backward compatible."
  ],
  "checks": ["pnpm --filter @switchyard/storage test -- postgres-runtime-bridge-store.test.ts postgres-schema-compat.test.ts storage-package.test.ts", "pnpm --filter @switchyard/storage typecheck", "git diff --check"],
  "error_rescue_map": [
    { "codepath": "PostgresHostedRuntimeBridgeCommandStore.create", "failure": "Same idempotency key exists with a different payload hash", "exception": "BridgeStoreError reasonCode hosted_runtime_bridge_payload_mismatch", "rescue": "Return conflict without mutating existing command or quota markers.", "user_sees": "409 adapter_protocol_failed with hosted_runtime_bridge_payload_mismatch." },
    { "codepath": "PostgresHostedRuntimeBridgeCommandStore.claimNext", "failure": "Command is expired, already claimed, terminal, or store transaction fails", "exception": "Store error or no row returned", "rescue": "Skip terminal/expired commands and surface store outage as hosted_runtime_bridge_store_unavailable to callers.", "user_sees": "Worker readiness or route admission fails closed instead of double-applying a command." },
    { "codepath": "PostgresHostedRuntimeBridgeCommandStore.recoverStaleClaims", "failure": "Worker crashed after claim and there is no durable adapter ack proving retry safety", "exception": "No thrown error for expected stale claim", "rescue": "Mark command failed with hosted_runtime_bridge_non_idempotent_retry_blocked and release active quota metadata.", "user_sees": "Run/approval receives a named terminal bridge failure instead of duplicate provider input." },
    { "codepath": "Postgres schema migration", "failure": "Existing database lacks bridge table or index after startup", "exception": "Schema compatibility test failure or database startup error", "rescue": "Fail readiness with hosted_runtime_bridge_store_unavailable until migration is applied.", "user_sees": "Readiness/preflight names the missing bridge store dependency." }
  ],
  "observability": {
    "logs": ["Storage task adds no direct runtime logs; service and worker tasks log lifecycle decisions.", "Storage tests print command id/status transitions on compare-and-update failures."],
    "success_metric": "Store tests prove queued, claimed, completed, failed, expired, duplicate, and stale-claim states transition deterministically.",
    "failure_metric": "Any raw payload persistence, duplicate mismatch mutation, or stale-claim retry default fails storage tests."
  },
  "test_cases": [
    { "name": "creates and claims queued command", "lens": "happy", "given": "create command with status queued and future expiresAt, then claimNext with worker id", "expect": "Command status becomes claimed, workerId and leaseUntil are set, and a second worker cannot claim it." },
    { "name": "deduplicates same payload", "lens": "edge_idempotency", "given": "Two create calls with same idempotency key and same payloadHash", "expect": "Both return the same command id, duplicate true on the second call, and one row exists." },
    { "name": "rejects duplicate key different payload", "lens": "error_path", "given": "Second create call reuses idempotency key with a different payloadHash", "expect": "hosted_runtime_bridge_payload_mismatch and original row remains queued or terminal unchanged." },
    { "name": "stores only redacted payload", "lens": "error_path", "given": "Command input contains token-like raw text before service redaction", "expect": "Persisted row has only payloadHash, payloadBytes, and redactedPayload summary." },
    { "name": "distinct secret inputs do not collide after redaction", "lens": "edge_hashing", "given": "Two raw payloads redact to the same summary but contain different secret values", "expect": "Stored payloadHash values differ because hash was computed from normalized raw payload before redaction." },
    { "name": "expires stale queued command", "lens": "error_path", "given": "Queued command with expiresAt before now", "expect": "expireStale marks expired and claimNext skips it." },
    { "name": "stale claimed command is not blindly retried", "lens": "error_path", "given": "Claimed command past lease with no adapterAck metadata", "expect": "recoverStaleClaims marks failed with hosted_runtime_bridge_non_idempotent_retry_blocked." },
    { "name": "nil row lookup is safe", "lens": "happy_shadow_nil", "given": "get unknown command id", "expect": "undefined without throw." },
    { "name": "empty list by run storage helper", "lens": "happy_shadow_empty", "given": "storage-test-only listByRun for run with no commands", "expect": "empty array and no core port dependency on listByRun." }
  ],
  "integration_contracts": {
    "exports": [
      { "name": "PostgresHostedRuntimeBridgeCommandStore", "kind": "class", "signature": "constructor(handle?: PostgresDatabaseHandle); create(input: CreateHostedRuntimeBridgeCommandInput) => Promise<{ command: HostedRuntimeBridgeCommand; duplicate: boolean }>; get(id: string) => Promise<HostedRuntimeBridgeCommand | undefined>; getByIdempotencyKey(key: string) => Promise<HostedRuntimeBridgeCommand | undefined>; claimNext(input: { workerId:string; leaseMs:number; now?:string }) => Promise<HostedRuntimeBridgeCommand | undefined>; complete(input: { commandId:string; workerId:string; result?:Record<string, unknown>; now?:string }) => Promise<HostedRuntimeBridgeCommand | null>; fail(input: { commandId:string; workerId?:string; reasonCode:string; retryable:boolean; now?:string }) => Promise<HostedRuntimeBridgeCommand | null>; expireStale(input: { now?:string }) => Promise<{ expired:number }>; recoverStaleClaims(input: { now?:string; nonIdempotentPolicy:'fail'|'retry_if_adapter_ack' }) => Promise<{ recovered:number; failed:number }>; listByRun(runId: string) => Promise<HostedRuntimeBridgeCommand[]>" }
    ],
    "imports_from_other_tasks": [
      { "from_task": "P22-T1-contracts-openapi", "name": "HostedRuntimeBridgeCommand", "signature": "{ id:string; runId:string; approvalId?:string; runtimeSessionId?:string; runtimeMode:'claude_code.sdk'|'opencode.acp'|'codex.exec_json'|string; operation:'input'|'approval_resolution'; status:'queued'|'claimed'|'completed'|'failed'|'expired'|'cancelled'; idempotencyKey:string; payloadHash:string; redactedPayload:Record<string, unknown>; payloadBytes:number; tenantId:string; projectId:string; accountId:string; userId:string; apiKeyId:string; workerId?:string; leaseUntil?:string; attempts:number; maxAttempts:number; reasonCode?:string; expiresAt:string; createdAt:string; updatedAt:string; }" }
    ],
    "file_paths_consumed_by_other_tasks": ["packages/storage/src/postgres/hosted-runtime-bridge-command-store.ts", "packages/storage/src/index.ts"]
  }
}
```

### Task P22-T3-core-bridge-orchestration

```json
{
  "id": "P22-T3-core-bridge-orchestration",
  "title": "Add core hosted runtime bridge orchestration and reconciliation",
  "files": [
    "packages/core/src/ports/hosted-runtime-bridge-command-store.ts",
    "packages/core/src/services/hosted-runtime-bridge-service.ts",
    "packages/core/src/services/runtime-runner-service.ts",
    "packages/core/src/index.ts",
    "packages/core/test/hosted-runtime-bridge-service.test.ts"
  ],
  "dependencies": ["P22-T1-contracts-openapi", "P22-T2-storage-outbox"],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md",
    "packages/core/src/services/runtime-runner-service.ts",
    "packages/core/src/services/approval-service.ts",
    "packages/core/src/services/control-plane-service.ts",
    "packages/core/src/ports/run-store.ts",
    "packages/core/src/ports/session-store.ts",
    "packages/core/src/ports/tool-dispatch-outbox-store.ts",
    "packages/core/src/index.ts"
  ],
  "instructions": "Define HostedRuntimeBridgeCommandStore port with exact methods matching the structural Postgres store except the storage-test-only listByRun helper, which is intentionally omitted from the core port. Add HostedRuntimeBridgeService with server admission methods for createInputCommand and resolveRuntimeApproval, worker methods for claimAndApplyNext, reconcileHostedRuntimeSessions, createWorkerRuntimeApproval, and terminalizePendingRuntimeApprovalsForRun. Admission must authenticate supplied context, authorize run or approval ownership before existence/scope leaks, validate supported runtime mode and active session, normalize raw payload, compute payloadHash in memory before redaction, reserve quota only for newly queued commands, write allow/deny/error audit, and never call provider adapters. Runtime approval resolve must be an exactly-once durable decision race: same idempotency key and same decision may return existing result, different decision or late loser returns approval_not_pending. Worker apply must reload command/run/session/approval, verify worker/session ownership and payload hash, call RuntimeRunnerService.sendInput only from worker path, and complete/fail/expire command with active quota release. Add pending runtime approval terminalization for run timeout, cancellation, run failure, and daemon or worker restart. Update RuntimeRunnerService hosted session state metadata with worker id, runtime session id, bridge capability, and bounded state patches while preserving local daemon behavior. T3 checkpoint guidance: implement and test the core port first, then admission/idempotency/quota, then worker claim/apply, then approval terminalization and restart reconciliation, with each checkpoint passing the focused core tests before expanding the next slice.",
  "acceptance": [
    "Server admission creates durable input commands only after auth, ownership, quota, capability, idempotency, payload hash, and active session checks pass.",
    "Server admission rejects missing run, terminal run, missing hosted session, unsupported mode, unsupported operation, quota exhaustion, store outage, and ownership mismatch with named reason codes.",
    "Quota lifecycle is explicit for queued, duplicate same-payload, duplicate different-payload, claimed, failed, expired, completed, and worker crash after claim.",
    "Core HostedRuntimeBridgeCommandStore intentionally omits listByRun; listByRun remains storage-test-only.",
    "Payload hash is computed from normalized raw payload before redaction and only hash plus redacted payload summary is passed to storage.",
    "Runtime approval creation attaches approval ownership before hosted routes can list or resolve it.",
    "Approve-vs-reject races produce exactly one durable decision; losers get approval_not_pending or same-idempotency same-decision result only.",
    "Pending runtime approvals are terminalized on timeout, cancellation, run failure, and restart reconciliation.",
    "Worker apply verifies command, run, session, approval, worker owner, runtime mode, payload hash, and expiry before adapter dispatch.",
    "Worker crash after adapter send without durable adapter ack marks stale claim failed with hosted_runtime_bridge_non_idempotent_retry_blocked instead of retrying non-idempotent provider input.",
    "Local daemon RuntimeRunnerService behavior remains backward compatible when hosted bridge dependencies are absent."
  ],
  "checks": ["pnpm --filter @switchyard/core test -- hosted-runtime-bridge-service.test.ts runtime-approval-session-r16.test.ts core.test.ts", "pnpm --filter @switchyard/core typecheck", "git diff --check"],
  "error_rescue_map": [
    { "codepath": "HostedRuntimeBridgeService.createInputCommand", "failure": "Run missing, terminal, not hosted, unsupported runtime mode, unsupported operation, missing session, stale session, inactive status, quota exceeded, or store unavailable", "exception": "ServiceError or AdapterProtocolError with named reason", "rescue": "Do not create a command; release any reserved quota on post-reserve failure; record deny/error audit when auth is present.", "user_sees": "404, 409, 429, or 503 with reasonCode such as run_not_found, runtime_input_not_active, hosted_input_bridge_unsupported, hosted_runtime_bridge_session_missing, or hosted_runtime_bridge_quota_exceeded." },
    { "codepath": "HostedRuntimeBridgeService.resolveRuntimeApproval", "failure": "Approval missing, unowned, expired, not pending, unsupported runtime scope, duplicate conflicting decision, or command create failure", "exception": "ServiceError or ControlPlaneError with named reason", "rescue": "Use compare-and-set; preserve one durable decision; never enqueue a second conflicting provider resolution.", "user_sees": "approval_not_found, approval_not_pending, acp_permission_request_expired, or named bridge failure." },
    { "codepath": "HostedRuntimeBridgeService.claimAndApplyNext", "failure": "Command expired, run/session missing, worker owner mismatch, runtime mode mismatch, approval stale, payload hash mismatch, adapter send failure, or non-idempotent stale claim", "exception": "AdapterProtocolError or ServiceError with named reason", "rescue": "Fail or expire command, release active quota, append visible runtime failure event when runtime progress is affected, and do not retry provider input unless durable adapter ack exists.", "user_sees": "Run event or approval result contains hosted_runtime_bridge_command_expired, hosted_runtime_bridge_non_idempotent_retry_blocked, hosted_runtime_bridge_session_not_owned, hosted_runtime_session_missing, approval_not_pending, or hosted_runtime_bridge_payload_mismatch." },
    { "codepath": "HostedRuntimeBridgeService.terminalizePendingRuntimeApprovalsForRun", "failure": "Run timeout, cancellation, run failure, or restart leaves pending runtime approvals", "exception": "No throw for expected terminalization; store errors surface as ServiceError", "rescue": "Expire or reject pending runtime approvals with reasonCode matching timeout, cancellation, run failure, or daemon_restarted before further bridge claims.", "user_sees": "Pending approvals stop appearing as actionable and late resolutions return approval_not_pending or acp_permission_request_expired." },
    { "codepath": "HostedRuntimeBridgeService.createWorkerRuntimeApproval", "failure": "Approval store write, ownership attach, quota reservation, or audit append fails", "exception": "ServiceError or store exception mapped to approval_ownership_attach_failed, hosted_runtime_bridge_store_unavailable, quota_exceeded, or audit_log_unavailable", "rescue": "Terminalize run visibly with runtime_approval_bridge_unconfigured or approval_ownership_attach_failed and do not leave a hidden pending approval.", "user_sees": "Run fails with a named runtime approval bridge reason." }
  ],
  "observability": {
    "logs": ["info hosted.runtime_bridge.admitted { runId, runtimeMode, operation, decision, reasonCode, requestId, redacted:true }", "info hosted.runtime_bridge.claimed { commandId, runId, runtimeMode, operation }", "info hosted.runtime_bridge.completed { commandId, runId, runtimeMode, operation }", "warn hosted.runtime_bridge.failed { commandId, runId, runtimeMode, operation, reasonCode }", "warn hosted.runtime_bridge.reconciled { runId, runtimeMode, reasonCode }"],
    "success_metric": "Counters by runtimeMode, operation, decision, and reasonCode for admitted, claimed, completed, failed, expired, terminalized, and reconciled bridge commands.",
    "failure_metric": "Any store, queue, audit, quota, approval race, expiry, or stale claim failure increments a reason-coded bridge failure counter without raw input text."
  },
  "test_cases": [
    { "name": "creates and completes bridge command", "lens": "happy", "given": "Active hosted claude_code.sdk run with owned active session and text input", "expect": "Command is queued, claimed by worker, applied through sendInput, marked completed, quota released, and logs omit raw text." },
    { "name": "rejects nil input body", "lens": "happy_shadow_nil", "given": "createInputCommand with undefined or non-object body", "expect": "invalid_input and no command row or quota mutation." },
    { "name": "rejects empty text", "lens": "happy_shadow_empty", "given": "createInputCommand with text containing only whitespace", "expect": "adapter_protocol_failed with runtime_input_empty and no adapter dispatch." },
    { "name": "quota lifecycle across command states", "lens": "integration", "given": "New queued command, same-payload duplicate, different-payload duplicate, claim, complete, fail, expire, and stale claim recovery fixtures", "expect": "Quota reserve/release/consume rules match the lifecycle semantics in this plan." },
    { "name": "payload hash uses raw normalized payload before redaction", "lens": "edge_hashing", "given": "Two secret-bearing inputs that redact to the same redactedPayload summary", "expect": "Service computes different payloadHash values and storage receives no raw secret text." },
    { "name": "approval approve reject race", "lens": "error_path", "given": "Concurrent approve and reject calls for the same pending runtime approval", "expect": "Exactly one decision persists and loser receives approval_not_pending unless it is same idempotency key and same decision." },
    { "name": "terminalizes pending approvals on timeout cancel and run failure", "lens": "error_path", "given": "Pending runtime approvals for runs that timeout, are cancelled, or fail", "expect": "terminalizePendingRuntimeApprovalsForRun marks approvals non-pending and late resolution returns approval_not_pending." },
    { "name": "restart reconciliation terminalizes pending approvals", "lens": "error_path", "given": "Hosted run remains waiting_for_approval after daemon restart with no verified resume path", "expect": "Run fails with hosted_runtime_session_lost and pending runtime approvals are expired or rejected." },
    { "name": "worker crash after claim does not retry provider input", "lens": "error_path", "given": "Claimed command past lease with no durable adapter ack", "expect": "reconcile marks command failed with hosted_runtime_bridge_non_idempotent_retry_blocked and sendInput is not called again." },
    { "name": "worker ownership mismatch fails closed", "lens": "error_path", "given": "Claimed command targets session owned by a different worker id", "expect": "Command fails with hosted_runtime_bridge_session_not_owned and adapter.send is not called." }
  ],
  "integration_contracts": {
    "exports": [
      { "name": "HostedRuntimeBridgeCommandStore", "kind": "interface", "signature": "create(input: CreateHostedRuntimeBridgeCommandInput) => Promise<{ command: HostedRuntimeBridgeCommand; duplicate: boolean }>; get(id: string) => Promise<HostedRuntimeBridgeCommand | undefined>; getByIdempotencyKey(key: string) => Promise<HostedRuntimeBridgeCommand | undefined>; claimNext(input: { workerId:string; leaseMs:number; now?:string }) => Promise<HostedRuntimeBridgeCommand | undefined>; complete(input: { commandId:string; workerId:string; result?:Record<string, unknown>; now?:string }) => Promise<HostedRuntimeBridgeCommand | null>; fail(input: { commandId:string; workerId?:string; reasonCode:string; retryable:boolean; now?:string }) => Promise<HostedRuntimeBridgeCommand | null>; expireStale(input: { now?:string }) => Promise<{ expired:number }>; recoverStaleClaims(input: { now?:string; nonIdempotentPolicy:'fail'|'retry_if_adapter_ack' }) => Promise<{ recovered:number; failed:number }>" },
      { "name": "HostedRuntimeBridgeService", "kind": "class", "signature": "createInputCommand(input: { runId:string; body:Record<string, unknown>; auth?:AuthContext; requestId?:string; idempotencyKey?:string }) => Promise<{ accepted:true; commandId:string; duplicate:boolean }>; resolveRuntimeApproval(input: { approvalId:string; decision:'approved'|'rejected'; body?:Record<string, unknown>; auth?:AuthContext; requestId?:string; idempotencyKey?:string }) => Promise<{ approval:Approval; commandId:string; duplicate:boolean }>; createWorkerRuntimeApproval(input: { runId:string; approvalType:ApprovalType; payload:Record<string, unknown>; workerId:string; deadline:string }) => Promise<Approval>; claimAndApplyNext(input: { workerId:string; leaseMs?:number }) => Promise<boolean>; reconcileHostedRuntimeSessions(input: { workerId:string; now?:string }) => Promise<{ reconciled:number; failed:number }>; terminalizePendingRuntimeApprovalsForRun(input: { runId:string; reasonCode:string; terminalEvent:'run.cancelled'|'run.failed'|'run.timeout'|'daemon_restarted' }) => Promise<{ expired:number; rejected:number }>" },
      { "name": "HostedRuntimeBridgeServerAdmission", "kind": "type", "signature": "Pick<HostedRuntimeBridgeService, 'createInputCommand' | 'resolveRuntimeApproval'>" },
      { "name": "HostedRuntimeBridgeWorkerRuntime", "kind": "type", "signature": "Pick<HostedRuntimeBridgeService, 'claimAndApplyNext' | 'reconcileHostedRuntimeSessions' | 'createWorkerRuntimeApproval' | 'terminalizePendingRuntimeApprovalsForRun'>" }
    ],
    "imports_from_other_tasks": [
      { "from_task": "P22-T1-contracts-openapi", "name": "HostedRuntimeBridgeCommand", "signature": "{ id:string; runId:string; approvalId?:string; runtimeSessionId?:string; runtimeMode:'claude_code.sdk'|'opencode.acp'|'codex.exec_json'|string; operation:'input'|'approval_resolution'; status:'queued'|'claimed'|'completed'|'failed'|'expired'|'cancelled'; idempotencyKey:string; payloadHash:string; redactedPayload:Record<string, unknown>; payloadBytes:number; tenantId:string; projectId:string; accountId:string; userId:string; apiKeyId:string; workerId?:string; leaseUntil?:string; attempts:number; maxAttempts:number; reasonCode?:string; expiresAt:string; createdAt:string; updatedAt:string; }" }
    ],
    "file_paths_consumed_by_other_tasks": ["packages/core/src/ports/hosted-runtime-bridge-command-store.ts", "packages/core/src/services/hosted-runtime-bridge-service.ts", "packages/core/src/services/runtime-runner-service.ts"]
  }
}
```

### Task P22-T4-rest-server-admission

```json
{
  "id": "P22-T4-rest-server-admission",
  "title": "Wire hosted REST and server admission through existing endpoints",
  "files": [
    "packages/protocol-rest/src/run-routes.ts",
    "packages/protocol-rest/src/hosted-tool-routes.ts",
    "packages/protocol-rest/src/http-errors.ts",
    "packages/protocol-rest/test/run-routes.test.ts",
    "packages/protocol-rest/test/hosted-tool-routes.test.ts",
    "apps/server/src/app.ts",
    "apps/server/src/readiness.ts",
    "apps/server/test/hosted-server.test.ts",
    "apps/server/test/hosted-tools.test.ts",
    "apps/server/test/production-readiness.test.ts"
  ],
  "dependencies": ["P22-T1-contracts-openapi", "P22-T2-storage-outbox", "P22-T3-core-bridge-orchestration"],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md",
    "packages/protocol-rest/src/run-routes.ts",
    "packages/protocol-rest/src/hosted-tool-routes.ts",
    "packages/protocol-rest/src/hosted-auth.ts",
    "apps/server/src/app.ts",
    "apps/server/src/readiness.ts",
    "packages/protocol-rest/test/run-routes.test.ts"
  ],
  "instructions": "Replace the blanket hosted real-runtime input denial in POST /runs/:id/input with HostedRuntimeBridgeServerAdmission.createInputCommand only after existing hosted auth and run ownership checks pass. Preserve local daemon behavior by keeping runService.sendInput for non-hosted-real runs. Extend hosted approval list/get/approve/reject routes so approval ownership authorization happens before tool/runtime scope classification. List and paginate owned tool approvals and supported runtime approvals together while preserving filters. Resolve tool approvals through existing HostedToolService and runtime approvals through HostedRuntimeBridgeServerAdmission.resolveRuntimeApproval. Construct PostgresHostedRuntimeBridgeCommandStore and HostedRuntimeBridgeService in apps/server with control-plane, approval, run, session, audit, quota, and metrics dependencies. The server must not import, instantiate, or register real provider adapters. Map hosted_runtime_bridge_non_idempotent_retry_blocked to 409 conflict/adapter_protocol_failed in protocol REST HTTP errors. Extend readiness with exact bridge diagnostics and fail closed when bridge support is enabled without auth, command store/outbox, quota, audit, approval ownership, or worker readiness support. Do not add POST /approvals or any new bridge, exec, shell, process, command, PTY, terminal, sandbox, dashboard, or TUI route.",
  "acceptance": [
    "Hosted server reuses existing POST /runs/:id/input and no longer blanket-rejects every active hosted real-runtime input.",
    "Hosted input route admits only supported active claude_code.sdk and ready opencode.acp operations after auth, ownership, quota, capability, idempotency, and state checks.",
    "Hosted codex.exec_json input and approval attempts return named unsupported errors and no command is queued.",
    "Hosted codex.interactive request is rejected before queue side effects with hosted_codex_interactive_unshipped or closed-catalog equivalent.",
    "Hosted approval list/get includes owned tool approvals and supported runtime approvals with stable pagination/filtering and no cross-tenant leaks.",
    "Runtime approval approve/reject creates exactly one durable bridge command for the winning decision.",
    "REST HTTP error mapping includes hosted_runtime_bridge_non_idempotent_retry_blocked as 409 conflict/adapter_protocol_failed.",
    "Server readiness fails closed when bridge dependencies are missing.",
    "Server app source/tests prove no real provider adapters are imported or instantiated.",
    "No new public bridge, arbitrary execution, shell, PTY, terminal, sandbox, dashboard, or TUI route is registered."
  ],
  "checks": ["pnpm --filter @switchyard/protocol-rest test -- run-routes.test.ts hosted-tool-routes.test.ts http-errors.request-id.test.ts", "pnpm --filter @switchyard/server test -- hosted-server.test.ts hosted-tools.test.ts production-readiness.test.ts", "pnpm --filter @switchyard/protocol-rest typecheck", "pnpm --filter @switchyard/server typecheck", "git diff --check"],
  "error_rescue_map": [
    { "codepath": "POST /runs/:id/input hosted admission", "failure": "Unauthenticated request, missing scope, tenant mismatch, run missing, terminal run, unsupported runtime, bridge quota exceeded, or store unavailable", "exception": "ControlPlaneError, ServiceError, AdapterProtocolError, or store error mapped by route", "rescue": "Return named HTTP error and record audit denial/error when auth context is known; do not call runService.sendInput for hosted real runs.", "user_sees": "401, 403, 404, 409, 429, or 503 with reasonCode and no provider side effect." },
    { "codepath": "GET /approvals and GET /approvals/:id", "failure": "Approval is unowned, owned by another tenant/project, or mixed pagination/filtering combines tool and runtime approvals incorrectly", "exception": "ControlPlaneError authorization denial or route assertion failure", "rescue": "Authorize ownership before scope classification; apply pagination after combining authorized tool/runtime approvals only.", "user_sees": "404 approval_not_found or 403 tenant_mismatch without revealing runtime/tool scope." },
    { "codepath": "POST /approvals/:id/approve|reject", "failure": "Approval not pending, unsupported scope, duplicate resolution, bridge command creation failure, or tool service failure", "exception": "ServiceError, ControlPlaneError, or hosted tool error", "rescue": "Route tool scope to existing hosted tool service, route runtime scope to bridge service, and preserve approval_not_pending on races.", "user_sees": "409 approval_not_pending, hosted_runtime_approval_bridge_unshipped for unsupported runtime scope, or named bridge failure." },
    { "codepath": "server /ready bridge checks", "failure": "Bridge enabled without API key auth, command store, outbox, quota, audit, approval ownership, worker readiness, or adapter capability diagnostics", "exception": "Readiness probe returns failed check", "rescue": "Return 503 with low-cardinality diagnostics and no secret values.", "user_sees": "Ready endpoint reports named failing dependency such as hosted_runtime_bridge_store_unavailable." }
  ],
  "observability": {
    "logs": ["info hosted.runtime_bridge.route.admit { runId, runtimeMode, operation, decision, reasonCode, requestId, redacted:true }", "warn hosted.runtime_bridge.route.denied { runtimeMode, operation, reasonCode, requestId }", "info hosted.runtime_approval.route.resolve { approvalId, runId, runtimeMode, decision, commandId }"],
    "success_metric": "Server metrics count bridge admission allow/deny/error by runtimeMode, operation, decision, and reasonCode.",
    "failure_metric": "Readiness dependency failures count by named bridge dependency and route denials count by reasonCode."
  },
  "test_cases": [
    { "name": "admits hosted Claude input", "lens": "happy", "given": "Owned active hosted claude_code.sdk run with body text continue", "expect": "202 accepted true and bridge service createInputCommand called once." },
    { "name": "rejects nil input body", "lens": "happy_shadow_nil", "given": "POST /runs/:id/input with missing or array body", "expect": "400 invalid_input and no bridge command." },
    { "name": "rejects empty input text", "lens": "happy_shadow_empty", "given": "POST /runs/:id/input with whitespace-only text", "expect": "409 adapter_protocol_failed with runtime_input_empty and no command." },
    { "name": "server readiness dependency failure", "lens": "error_path", "given": "Bridge enabled app omits command store, quota, audit, worker readiness, or approval ownership dependency", "expect": "Ready endpoint returns 503 with exact failed bridge readiness check and no command admission." },
    { "name": "hosted approval list mixes tool and runtime approvals", "lens": "integration", "given": "Owned pending tool approvals and runtime approvals with pagination and scope filters", "expect": "List returns only authorized approvals in stable order and filters do not leak cross-tenant scope." },
    { "name": "runtime approval approve creates bridge command once", "lens": "integration", "given": "Two concurrent approve requests for the same owned pending runtime approval", "expect": "One approval transition, one command, second returns approval_not_pending or existing idempotent result." },
    { "name": "maps non-idempotent retry blocked status", "lens": "error_path", "given": "protocol REST HTTP error mapper receives hosted_runtime_bridge_non_idempotent_retry_blocked", "expect": "409 adapter_protocol_failed response mapping." },
    { "name": "codex exec json remains unsupported", "lens": "error_path", "given": "Active hosted codex.exec_json fixture receives input or approval resolution", "expect": "409 with codex_exec_json_input_unsupported or codex_exec_json_approval_bridge_unsupported and no command." },
    { "name": "server has no real provider adapters", "lens": "error_path", "given": "Source/test inspection of createServerApp imports and adapter map", "expect": "No Claude, OpenCode, Codex real provider adapter import or instantiation in server app." },
    { "name": "forbidden public routes absent", "lens": "error_path", "given": "Registered hosted server route table", "expect": "No public bridge, exec, shell, process, command, PTY, terminal, sandbox, dashboard, or TUI route." }
  ],
  "integration_contracts": {
    "exports": [
      { "name": "RunRouteDependencies.hostedRuntimeBridge", "kind": "type", "signature": "hostedRuntimeBridge?: Pick<HostedRuntimeBridgeServerAdmission, 'createInputCommand'>" },
      { "name": "HostedToolRouteDependencies.hostedRuntimeBridge", "kind": "type", "signature": "hostedRuntimeBridge?: Pick<HostedRuntimeBridgeServerAdmission, 'resolveRuntimeApproval'>" },
      { "name": "getServerRuntimeBridgeReadiness", "kind": "function", "signature": "(deps: { commandStore?:unknown; commandOutbox?:unknown; approvalOwnership?:unknown; quota?:unknown; audit?:unknown; routeAuth?:unknown; workerReadiness?:unknown }) => HostedRuntimeBridgeReadinessReport" }
    ],
    "imports_from_other_tasks": [
      { "from_task": "P22-T2-storage-outbox", "name": "PostgresHostedRuntimeBridgeCommandStore", "signature": "constructor(handle?: PostgresDatabaseHandle); create(input: CreateHostedRuntimeBridgeCommandInput) => Promise<{ command: HostedRuntimeBridgeCommand; duplicate: boolean }>; get(id: string) => Promise<HostedRuntimeBridgeCommand | undefined>; getByIdempotencyKey(key: string) => Promise<HostedRuntimeBridgeCommand | undefined>; claimNext(input: { workerId:string; leaseMs:number; now?:string }) => Promise<HostedRuntimeBridgeCommand | undefined>; complete(input: { commandId:string; workerId:string; result?:Record<string, unknown>; now?:string }) => Promise<HostedRuntimeBridgeCommand | null>; fail(input: { commandId:string; workerId?:string; reasonCode:string; retryable:boolean; now?:string }) => Promise<HostedRuntimeBridgeCommand | null>; expireStale(input: { now?:string }) => Promise<{ expired:number }>; recoverStaleClaims(input: { now?:string; nonIdempotentPolicy:'fail'|'retry_if_adapter_ack' }) => Promise<{ recovered:number; failed:number }>; listByRun(runId: string) => Promise<HostedRuntimeBridgeCommand[]>" },
      { "from_task": "P22-T3-core-bridge-orchestration", "name": "HostedRuntimeBridgeServerAdmission", "signature": "Pick<HostedRuntimeBridgeService, 'createInputCommand' | 'resolveRuntimeApproval'>" },
      { "from_task": "P22-T1-contracts-openapi", "name": "HostedRuntimeBridgeReadinessReport", "signature": "{ status:'ready'|'not_ready'; checks: Array<{ name:'command_store'|'command_outbox'|'approval_ownership'|'quota'|'audit'|'route_auth'|'worker_claim'|'adapter_capability'|'session_reconciliation'|'approval_sender'; ok:boolean; reasonCode?:string }> }" }
    ],
    "file_paths_consumed_by_other_tasks": ["packages/protocol-rest/src/run-routes.ts", "packages/protocol-rest/src/hosted-tool-routes.ts", "apps/server/src/app.ts", "apps/server/src/readiness.ts"]
  }
}
```

### Task P22-T5-claude-hosted-bridge

```json
{
  "id": "P22-T5-claude-hosted-bridge",
  "title": "Enable hosted Claude input and approval bridge under worker control",
  "files": ["packages/adapters/src/claude-code/claude-code-adapter.ts", "packages/adapters/src/claude-code/types.ts", "packages/testkit/src/fake-claude-code-client.ts", "packages/adapters/test/claude-code-adapter.test.ts"],
  "dependencies": ["P22-T1-contracts-openapi"],
  "context_files": ["docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md", "packages/adapters/src/claude-code/claude-code-adapter.ts", "packages/adapters/src/claude-code/types.ts", "packages/adapters/src/claude-code/claude-code-event-mapper.ts", "packages/testkit/src/fake-claude-code-client.ts", "packages/adapters/test/claude-code-adapter.test.ts", "docs/development/adapters/CLAUDE_CODE.md"],
  "instructions": "Add hostedBridgeEnabled?: boolean to Claude adapter and client options. In send, keep rejecting hosted provider sessions unless both hostedProviderCommand and hostedBridgeEnabled are present. When enabled, reuse existing text input and approval_resolution paths; do not add a second hosted-only payload shape. In events, stop converting hosted approval requests into immediate run.failed when bridge is enabled; instead track pending runtime approval tokens and yield existing approval.requested events. Preserve hosted read-only permission mode and disabled tools policy. Reject terminal hosted sessions before client send. Extend fake Claude scenarios to hold waiting input/approval deterministically and expose sent user messages, resolved approvals, terminal state, and client send failure injection. Keep local Claude behavior unchanged and transcripts bounded/redacted.",
  "acceptance": ["Hosted Claude input remains unsupported unless hostedBridgeEnabled is true.", "Hosted Claude text input uses existing sendUserMessage path and records redacted input metadata only.", "Hosted Claude approval requests yield approval.requested instead of hosted_approval_bridge_unsupported when bridge is enabled.", "Hosted Claude approval approve and reject use existing resolveApproval path and delete pending tokens exactly once.", "Unknown, missing, stale, or duplicate runtimeApprovalToken returns runtime_approval_pause_not_active.", "Terminal hosted Claude sessions reject input with runtime_input_not_active before client send.", "Client send failure propagates as a named adapter failure so the bridge command is not marked completed.", "Unsupported payload shapes still return claude_input_unsupported.", "Local Claude adapter tests continue to pass unchanged."],
  "checks": ["pnpm --filter @switchyard/adapters test -- claude-code-adapter.test.ts claude-code-cli-client.test.ts claude-code-transcript-bounds.test.ts", "pnpm --filter @switchyard/testkit test -- fake-claude-code-client", "pnpm --filter @switchyard/adapters typecheck", "pnpm --filter @switchyard/testkit typecheck", "git diff --check"],
  "error_rescue_map": [
    { "codepath": "ClaudeCodeAdapter.send", "failure": "Hosted session sends input without hostedBridgeEnabled", "exception": "AdapterProtocolError reasonCode hosted_input_bridge_unsupported", "rescue": "Reject before clientSession.sendUserMessage or resolveApproval.", "user_sees": "409 adapter_protocol_failed with hosted_input_bridge_unsupported." },
    { "codepath": "ClaudeCodeAdapter.send text", "failure": "Text is empty, session is terminal, or client send fails", "exception": "AdapterProtocolError runtime_input_empty/runtime_input_not_active or client Error mapped to adapter_protocol_failed", "rescue": "Propagate named adapter error through bridge command failure; do not mark command completed or retry non-idempotently.", "user_sees": "Named runtime input failure and no duplicate input." },
    { "codepath": "ClaudeCodeAdapter.send approval_resolution", "failure": "Missing, unknown, stale, or duplicate runtimeApprovalToken", "exception": "AdapterProtocolError reasonCode runtime_approval_pause_not_active", "rescue": "Reject resolution and keep command failed without calling provider resolveApproval.", "user_sees": "Approval resolution fails with runtime_approval_pause_not_active." },
    { "codepath": "ClaudeCodeAdapter.events approval.requested", "failure": "Provider approval event lacks token", "exception": "No throw from mapper; RuntimeRunnerService maps to runtime_approval_token_missing", "rescue": "Runner fails visibly; adapter does not invent a token.", "user_sees": "Run fails with runtime_approval_token_missing." }
  ],
  "observability": { "logs": ["info claude_code.input.accepted { runId }", "info claude_code.approval.resolved { runId, decision }", "warn claude_code.input.rejected { runId, reasonCode }"], "success_metric": "Adapter emits existing logs without raw text and fake client state proves exactly-once sends/resolutions.", "failure_metric": "Hosted bridge disabled, stale token, terminal input, and client send failure tests fail with named reason codes." },
  "test_cases": [
    { "name": "hosted bridge disabled rejects input", "lens": "error_path", "given": "ClaudeCodeAdapter with hostedProviderCommand and no hostedBridgeEnabled sends text input", "expect": "AdapterProtocolError hosted_input_bridge_unsupported and fake sentUserMessages is empty." },
    { "name": "hosted bridge enabled accepts input", "lens": "happy", "given": "ClaudeCodeAdapter with hostedProviderCommand and hostedBridgeEnabled sends text continue", "expect": "Fake sentUserMessages equals continue." },
    { "name": "terminal hosted Claude session rejects input", "lens": "error_path", "given": "Hosted Claude session state is completed or failed before send text", "expect": "runtime_input_not_active and fake client send is not called." },
    { "name": "client send failure maps to command failure", "lens": "error_path", "given": "Fake Claude client sendUserMessage throws", "expect": "Adapter propagates named failure and fake command completion path is not invoked." },
    { "name": "rejects empty text", "lens": "happy_shadow_empty", "given": "send whitespace-only text", "expect": "runtime_input_empty." },
    { "name": "approval request yields event", "lens": "integration", "given": "Fake Claude scenario with approvalToken and hostedBridgeEnabled true", "expect": "Events include approval.requested and do not include hosted_approval_bridge_unsupported." },
    { "name": "approval resolution succeeds once", "lens": "happy", "given": "send approval_resolution for token pause-1 twice", "expect": "First resolves; second returns runtime_approval_pause_not_active." },
    { "name": "nil approval token rejected", "lens": "happy_shadow_nil", "given": "send approval_resolution without runtimeApprovalToken", "expect": "runtime_approval_pause_not_active." },
    { "name": "unsupported payload rejected", "lens": "error_path", "given": "send payload with unsupported shape", "expect": "claude_input_unsupported." }
  ],
  "integration_contracts": {
    "exports": [
      { "name": "ClaudeCodeAdapterOptions.hostedBridgeEnabled", "kind": "type", "signature": "hostedBridgeEnabled?: boolean" },
      { "name": "ClaudeCodeAdapter.send", "kind": "function", "signature": "send(session: RuntimeSession, input: { text:string } | { type:'approval_resolution'; runtimeApprovalToken:string; decision:'approved'|'rejected'; message?:string; answers?:Record<string, unknown> }) => Promise<void>" }
    ],
    "imports_from_other_tasks": [{ "from_task": "P22-T1-contracts-openapi", "name": "HOSTED_RUNTIME_BRIDGE_REASON_CODES", "signature": "readonly string[] including hosted_runtime_bridge_store_unavailable, hosted_runtime_bridge_queue_unavailable, hosted_runtime_bridge_worker_unavailable, hosted_runtime_bridge_operation_unsupported, hosted_runtime_bridge_session_missing, hosted_runtime_bridge_session_not_owned, hosted_runtime_session_missing, hosted_runtime_session_lost, hosted_runtime_session_state_incomplete, hosted_runtime_bridge_payload_mismatch, hosted_runtime_bridge_command_expired, hosted_runtime_bridge_non_idempotent_retry_blocked, hosted_runtime_bridge_quota_exceeded, hosted_codex_interactive_unshipped, codex_exec_json_input_unsupported, codex_exec_json_approval_bridge_unsupported, agentfield_bridge_unshipped, generic_http_bridge_unshipped" }],
    "file_paths_consumed_by_other_tasks": ["packages/adapters/src/claude-code/types.ts", "packages/adapters/src/claude-code/claude-code-adapter.ts", "packages/testkit/src/fake-claude-code-client.ts"]
  }
}
```

### Task P22-T6-acp-permission-protocol

```json
{
  "id": "P22-T6-acp-permission-protocol",
  "title": "Add ACP held permission request response support",
  "files": ["packages/protocol-acpx/src/acp-stdio-client.ts", "packages/protocol-acpx/src/acp-schemas.ts", "packages/protocol-acpx/test/acp-stdio-client.test.ts", "packages/protocol-acpx/test/protocol-framing.test.ts", "packages/testkit/src/fake-acp-runtime.ts", "packages/testkit/test/fake-acp-runtime.test.ts"],
  "dependencies": ["P22-T1-contracts-openapi"],
  "context_files": ["docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md", "packages/protocol-acpx/src/acp-stdio-client.ts", "packages/protocol-acpx/src/acp-schemas.ts", "packages/protocol-acpx/src/json-rpc.ts", "packages/protocol-acpx/test/acp-stdio-client.test.ts", "packages/testkit/src/fake-acp-runtime.ts", "packages/testkit/test/fake-acp-runtime.test.ts"],
  "instructions": "Change AcpStdioClient so session/request_permission requests are held and emitted as permission_request without automatically replying method-not-found. Unsupported methods must still receive method-not-found immediately. Add respondToRequest and rejectRequest APIs that write exactly one JSON-RPC response to the original id, reject duplicate/missing ids, track numeric and string ids distinctly, and fail with named ACP errors when the transport closed or the request expired. Held permission request TTL must be explicit and supplied by the adapter/core deadline so approval.expiresAt and command.expiresAt can share the same value. Extend schemas for non-empty id, method, optional session id, bounded params, and redacted transcript entries. Extend fake ACP runtime so permission scenarios wait for approval/rejection response and then continue/refuse deterministically.",
  "acceptance": ["session/request_permission is emitted as permission_request and no method-not-found response is written automatically.", "Unsupported ACP requests still receive method-not-found immediately.", "Held permission requests can be answered exactly once with a JSON-RPC result or error.", "Duplicate answer attempts fail with acp_permission_response_failed.", "Answering a missing or expired request fails with acp_permission_request_expired or acp_permission_response_failed.", "Transport close rejects all pending held permission requests.", "Held request TTL can be set from a caller-supplied deadline and expiry removes the pending request.", "Fake ACP runtime records permissionResponses and can complete after approval.", "Transcript entries remain bounded and redacted."],
  "checks": ["pnpm --filter @switchyard/protocol-acpx test -- acp-stdio-client.test.ts protocol-framing.test.ts", "pnpm --filter @switchyard/testkit test -- fake-acp-runtime.test.ts", "pnpm --filter @switchyard/protocol-acpx typecheck", "pnpm --filter @switchyard/testkit typecheck", "git diff --check"],
  "error_rescue_map": [
    { "codepath": "AcpStdioClient.handleMessage", "failure": "Unsupported JSON-RPC request method arrives", "exception": "No throw for expected unsupported request", "rescue": "Reply method-not-found immediately and emit unsupported_request.", "user_sees": "OpenCode continues with acp_client_method_unsupported status for unsupported callbacks." },
    { "codepath": "AcpStdioClient.respondToRequest", "failure": "Permission request id is missing, already answered, expired, or transport closed", "exception": "AcpProtocolError reasonCode acp_permission_response_failed or acp_permission_request_expired", "rescue": "Do not write a duplicate JSON-RPC response; remove expired request from hold map.", "user_sees": "Run fails with acp_permission_response_failed or acp_permission_request_expired." },
    { "codepath": "AcpStdioClient permission hold map", "failure": "Held request exceeds TTL or process exits", "exception": "AcpProtocolError acp_transport_closed or acp_permission_request_expired", "rescue": "Reject pending waiter and remove hold from map.", "user_sees": "Approval is expired/rejected and run fails visibly." },
    { "codepath": "fake ACP runtime permission scenario", "failure": "Test runtime receives malformed permission response", "exception": "Parse failure in fake runtime", "rescue": "Record no permission response and produce deterministic refusal/error response for tests.", "user_sees": "No-spend test fails with named ACP reason." }
  ],
  "observability": { "logs": ["Protocol client keeps transcript records; adapter emits runtime logs.", "Tests assert transcript records contain message direction, byte length, and redaction metadata."], "success_metric": "Fake ACP stats.permissionResponses increments once per approved or rejected held request.", "failure_metric": "Duplicate, missing, expired, and closed-transport response attempts reject with named ACP reasons." },
  "test_cases": [
    { "name": "holds permission request", "lens": "happy", "given": "ACP process sends session/request_permission id perm_1 during an in-flight prompt", "expect": "Client emits permission_request and outbound writes do not include method-not-found for perm_1." },
    { "name": "unsupported request still method-not-found", "lens": "error_path", "given": "ACP process sends unsupported method workspace/exec", "expect": "Outbound writes include JSON-RPC error -32601 and event unsupported_request." },
    { "name": "answers permission request once", "lens": "happy", "given": "respondToRequest for perm_1 with approved outcome", "expect": "One JSON-RPC response is written and fake stats.permissionResponses is 1." },
    { "name": "rejects duplicate response", "lens": "error_path", "given": "respondToRequest for perm_1 twice", "expect": "Second call rejects with acp_permission_response_failed and writes no JSON-RPC response." },
    { "name": "rejects nil request id response", "lens": "happy_shadow_nil", "given": "respondToRequest with undefined id", "expect": "AcpProtocolError acp_permission_response_failed." },
    { "name": "rejects empty request id response", "lens": "happy_shadow_empty", "given": "respondToRequest with empty id", "expect": "AcpProtocolError acp_permission_response_failed." },
    { "name": "expired request writes no response", "lens": "error_path", "given": "Held request deadline has passed before respondToRequest", "expect": "acp_permission_request_expired and outbound writes do not include a JSON-RPC response for the expired id." },
    { "name": "transport close rejects held request", "lens": "error_path", "given": "Process exits before respondToRequest", "expect": "Held request removed and response attempt fails with acp_transport_closed or acp_permission_request_expired." }
  ],
  "integration_contracts": {
    "exports": [
      { "name": "AcpStdioClient.respondToRequest", "kind": "function", "signature": "(id: JsonRpcId, result: unknown) => Promise<void>" },
      { "name": "AcpStdioClient.rejectRequest", "kind": "function", "signature": "(id: JsonRpcId, error: { code:number; message:string; data?:unknown }) => Promise<void>" },
      { "name": "AcpClientEvent.permission_request", "kind": "type", "signature": "{ type:'permission_request'; message: JsonRpcRequestMessage; expiresAt:string } emitted without automatic method-not-found response" }
    ],
    "imports_from_other_tasks": [{ "from_task": "P22-T1-contracts-openapi", "name": "ACP_RUNTIME_BRIDGE_REASON_CODES", "signature": "readonly string[] including acp_permission_request_invalid, acp_permission_response_failed, acp_permission_request_expired, acp_prompt_in_flight, acp_session_not_ready_for_input" }],
    "file_paths_consumed_by_other_tasks": ["packages/protocol-acpx/src/acp-stdio-client.ts", "packages/protocol-acpx/src/acp-schemas.ts", "packages/testkit/src/fake-acp-runtime.ts"]
  }
}
```

### Task P22-T7-opencode-hosted-bridge

```json
{
  "id": "P22-T7-opencode-hosted-bridge",
  "title": "Enable structured hosted OpenCode ACP bridge",
  "files": ["packages/adapters/src/opencode/opencode-acp-adapter.ts", "packages/adapters/src/opencode/types.ts", "packages/adapters/test/opencode-acp-adapter.test.ts"],
  "dependencies": ["P22-T1-contracts-openapi", "P22-T6-acp-permission-protocol"],
  "context_files": ["docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md", "packages/adapters/src/opencode/opencode-acp-adapter.ts", "packages/adapters/src/opencode/types.ts", "packages/adapters/src/opencode/opencode-event-mapper.ts", "packages/adapters/test/opencode-acp-adapter.test.ts", "packages/testkit/src/fake-acp-runtime.ts", "docs/development/adapters/OPENCODE.md"],
  "instructions": "Add hostedBridgeEnabled?: boolean to OpenCodeAcpAdapterOptions. Keep local opencode.acp one-prompt-per-run behavior unchanged when false. When hosted provider command and bridge are enabled, maintain session state for acpSessionId, prompt active/ready state, pending permission request id, and shared deadline. On session/request_permission, validate request, store pending id, yield approval.requested with runtimeApprovalToken equal to ACP request id, approval.expiresAt equal to the held request deadline, bounded provider action summary, and keep the original JSON-RPC request open. Do not use PTY, terminal, keyboard, alternate-screen, or screen scraping. In send, accept text only when session is ready for another structured session/prompt; reject concurrent input with acp_prompt_in_flight or runtime_input_in_flight. Accept approval_resolution only for the pending permission request id and answer the original JSON-RPC request through protocol-acpx. If the pending request is lost, expired, transport closes, or response write fails, map to acp_permission_request_expired or acp_permission_response_failed and do not write a late JSON-RPC response.",
  "acceptance": ["Hosted OpenCode permission request creates approval.requested instead of hosted_approval_bridge_unsupported when bridge is enabled.", "approval.expiresAt, command.expiresAt, and ACP held request TTL use the same deadline value or strict earlier command expiry.", "Resolution after expiry returns acp_permission_request_expired and does not write a JSON-RPC response.", "ACP permission approval answers the original JSON-RPC request exactly once.", "ACP permission rejection answers the original JSON-RPC request exactly once and run fails or continues according to fake response.", "Unsupported ACP requests still receive method-not-found and do not become approvals.", "Hosted OpenCode follow-up input sends structured session/prompt only when the session is ready.", "Concurrent prompt/input attempts fail with acp_prompt_in_flight or runtime_input_in_flight.", "Pending permission loss maps to acp_permission_request_expired or acp_permission_response_failed.", "Adapter source and tests contain no PTY, terminal proxy, keyboard driving, or screen scraping path."],
  "checks": ["pnpm --filter @switchyard/adapters test -- opencode-acp-adapter.test.ts runtime-adapter-contracts.test.ts", "pnpm --filter @switchyard/adapters typecheck", "pnpm --filter @switchyard/protocol-acpx test", "git diff --check"],
  "error_rescue_map": [
    { "codepath": "OpenCodeAcpAdapter.events permission_request", "failure": "Permission request id, method, params, session id, action summary, or deadline is missing or invalid", "exception": "AdapterProtocolError reasonCode acp_permission_request_invalid", "rescue": "Fail run visibly and cancel ACP session best-effort; do not create hidden approval.", "user_sees": "Run failed with acp_permission_request_invalid." },
    { "codepath": "OpenCodeAcpAdapter.send text", "failure": "Session terminal, prompt already active, session not ready, blank text, hosted bridge disabled, or ACP prompt request fails", "exception": "AdapterProtocolError acp_prompt_in_flight, acp_session_not_ready_for_input, runtime_input_empty, hosted_input_bridge_unsupported, or AcpProtocolError", "rescue": "Reject before writing duplicate prompt or fail command with named ACP reason.", "user_sees": "409 adapter_protocol_failed with named prompt/input reason." },
    { "codepath": "OpenCodeAcpAdapter.send approval_resolution", "failure": "Runtime approval token does not match pending ACP request, pending request expired, permission hold was lost, or response write fails", "exception": "AdapterProtocolError runtime_approval_pause_not_active or AcpProtocolError acp_permission_request_expired/acp_permission_response_failed", "rescue": "Fail bridge command; do not write duplicate or late JSON-RPC response.", "user_sees": "Approval resolution fails with runtime_approval_pause_not_active, acp_permission_request_expired, or acp_permission_response_failed." },
    { "codepath": "OpenCodeAcpAdapter artifacts", "failure": "Transcript contains raw hosted provider command, env, prompt, object key, or secret-like ACP params", "exception": "Test assertion failure or redaction helper rejection", "rescue": "Use hosted-safe transcript summarization with direction, byte length, redacted marker, runtime mode, and ACP session id only.", "user_sees": "Artifacts are available without secret material." }
  ],
  "observability": { "logs": ["info opencode.acp.permission.requested { runId, acpSessionId, requestId }", "info opencode.acp.permission.resolved { runId, requestId, decision }", "info opencode.acp.prompt.accepted { runId, acpSessionId }", "warn opencode.acp.bridge.failed { runId, reasonCode }"], "success_metric": "Adapter tests prove exactly-one ACP response and prompt counters for fake hosted scenarios.", "failure_metric": "Prompt conflict, stale permission request, malformed permission request, expired request, and unsupported request tests fail with named reason codes." },
  "test_cases": [
    { "name": "hosted permission request creates approval event", "lens": "happy", "given": "Fake ACP permission_request with hostedProviderCommand and hostedBridgeEnabled true", "expect": "Events include approval.requested with runtimeApprovalToken perm_1 and no hosted_approval_bridge_unsupported failure." },
    { "name": "shared expiry deadline", "lens": "integration", "given": "Permission request with adapter deadline D creates approval and later command", "expect": "Held ACP request expiresAt, approval.expiresAt, and command.expiresAt use D or command expiry is earlier than D." },
    { "name": "approval resolution answers ACP request", "lens": "integration", "given": "send approval_resolution for runtimeApprovalToken perm_1 with decision approved", "expect": "Fake ACP stats.permissionResponses is 1 and command completes." },
    { "name": "resolution after expiry writes no JSON-RPC response", "lens": "error_path", "given": "Pending permission request deadline has passed before approval resolution", "expect": "acp_permission_request_expired and fake ACP outbound responses do not include perm_1 response." },
    { "name": "pending permission loss maps to ACP bridge error", "lens": "error_path", "given": "Adapter session state references pending permission id but protocol client no longer holds it", "expect": "approval_resolution fails with acp_permission_request_expired or acp_permission_response_failed and no JSON-RPC write." },
    { "name": "rejects nil permission token", "lens": "happy_shadow_nil", "given": "send approval_resolution without runtimeApprovalToken", "expect": "runtime_approval_pause_not_active." },
    { "name": "rejects blank prompt input", "lens": "happy_shadow_empty", "given": "send whitespace-only text", "expect": "runtime_input_empty and no ACP session/prompt write." },
    { "name": "concurrent prompt conflict", "lens": "error_path", "given": "send text while promptActive is true", "expect": "acp_prompt_in_flight or runtime_input_in_flight and no duplicate prompt." },
    { "name": "unsupported ACP request remains unsupported", "lens": "error_path", "given": "ACP process sends unsupported request method", "expect": "Method-not-found response and no approval.requested event." },
    { "name": "no PTY or terminal source path", "lens": "error_path", "given": "Source inspection of OpenCode ACP adapter", "expect": "No PTY, terminal, keyboard, alternate screen, or screen scraping imports or code paths." }
  ],
  "integration_contracts": {
    "exports": [
      { "name": "OpenCodeAcpAdapterOptions.hostedBridgeEnabled", "kind": "type", "signature": "hostedBridgeEnabled?: boolean" },
      { "name": "OpenCodeAcpAdapter.send", "kind": "function", "signature": "send(session: RuntimeSession, input: { text:string } | { type:'approval_resolution'; runtimeApprovalToken:string; decision:'approved'|'rejected'; message?:string; answers?:Record<string, unknown> }) => Promise<void>" }
    ],
    "imports_from_other_tasks": [
      { "from_task": "P22-T6-acp-permission-protocol", "name": "AcpStdioClient.respondToRequest", "signature": "(id: JsonRpcId, result: unknown) => Promise<void>" },
      { "from_task": "P22-T6-acp-permission-protocol", "name": "AcpStdioClient.rejectRequest", "signature": "(id: JsonRpcId, error: { code:number; message:string; data?:unknown }) => Promise<void>" },
      { "from_task": "P22-T6-acp-permission-protocol", "name": "AcpClientEvent.permission_request", "signature": "{ type:'permission_request'; message: JsonRpcRequestMessage; expiresAt:string } emitted without automatic method-not-found response" }
    ],
    "file_paths_consumed_by_other_tasks": ["packages/adapters/src/opencode/types.ts", "packages/adapters/src/opencode/opencode-acp-adapter.ts"]
  }
}
```

### Task P22-T8-worker-bridge-orchestration

```json
{
  "id": "P22-T8-worker-bridge-orchestration",
  "title": "Wire worker bridge claiming, approvals, and reconciliation",
  "files": ["apps/worker/src/worker.ts", "apps/worker/src/hosted-runtime-adapters.ts", "apps/worker/src/ready.ts", "apps/worker/test/hosted-worker.test.ts", "apps/worker/test/production-worker-readiness.test.ts"],
  "dependencies": ["P22-T1-contracts-openapi", "P22-T2-storage-outbox", "P22-T3-core-bridge-orchestration", "P22-T5-claude-hosted-bridge", "P22-T7-opencode-hosted-bridge"],
  "context_files": ["docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md", "apps/worker/src/worker.ts", "apps/worker/src/hosted-runtime-adapters.ts", "apps/worker/src/ready.ts", "apps/worker/test/hosted-worker.test.ts", "packages/core/src/services/hosted-worker-service.ts", "packages/core/src/services/runtime-runner-service.ts"],
  "instructions": "Construct PostgresHostedRuntimeBridgeCommandStore and HostedRuntimeBridgeService in createHostedWorker with dependency injection for tests. Pass a stable worker id into RuntimeRunnerService hosted session owner metadata. Add runtimeApprovals hooks so Claude and OpenCode approval events create approval records through HostedRuntimeBridgeWorkerRuntime.createWorkerRuntimeApproval with ownership and audit before visibility. Add a bridge claim/apply loop that runs reconciliation before new claims and applies worker-claimed input and approval_resolution commands through runner.sendInput. Enable hostedBridgeEnabled only for allowlisted hosted claude_code.sdk and opencode.acp adapters when bridge dependencies are present. Never register codex.interactive, Generic HTTP, AgentField, PTY, terminal, or shell adapters as hosted bridge-capable. Claim readiness must fail closed when bridge support is enabled but command store, session reconciliation, approval sender, adapter bridge capability, or worker claim dependency is unavailable; diagnostics use the explicit command_store, session_reconciliation, approval_sender, adapter_capability, and worker_claim check names.",
  "acceptance": ["Worker constructs hosted bridge store/service and injects runtime approval dependencies into RuntimeRunnerService.", "Worker adapter factory enables hosted bridge capability only for claude_code.sdk and opencode.acp.", "Worker claim loop applies queued input and approval_resolution bridge commands to owned live sessions.", "Worker startup reconciliation runs before new real-runtime bridge command claims.", "Worker rejects commands for sessions it does not own or cannot safely reclaim.", "Worker readiness fails closed when dependencies are missing.", "Fake Claude hosted input, approval request, approval approve, approval reject, terminal session input rejection, and no-resume restart loss are covered.", "Fake ACP permission request hold/answer, pending permission loss, expiry, and follow-up prompt bridge are covered through worker tests.", "Hosted tool worker behavior from R22 continues to pass unchanged.", "No worker construction path registers hosted codex.interactive or terminal/PTX/TUI automation."],
  "checks": ["pnpm --filter @switchyard/worker test -- hosted-worker.test.ts production-worker-readiness.test.ts", "pnpm --filter @switchyard/worker typecheck", "pnpm --filter @switchyard/core test -- hosted-worker-service.test.ts hosted-runtime-bridge-service.test.ts", "git diff --check"],
  "error_rescue_map": [
    { "codepath": "createHostedWorker bridge dependency construction", "failure": "Postgres, command store, control-plane store, approvals, or bridge service cannot be constructed", "exception": "ConfigError or store constructor error", "rescue": "Worker readiness reports hosted_runtime_bridge_store_unavailable or hosted_runtime_bridge_queue_unavailable and tick does not claim bridge commands.", "user_sees": "Worker ready endpoint returns not ready with named bridge dependency." },
    { "codepath": "worker tick bridge processing", "failure": "Claimed bridge command apply fails due to stale session, ownership mismatch, adapter rejection, expired command, or non-idempotent stale claim", "exception": "AdapterProtocolError or ServiceError with reasonCode", "rescue": "Fail or expire command, append visible runtime event when needed, release active quota, and continue later ticks without duplicate provider input.", "user_sees": "Run/approval shows named failure without duplicate provider input." },
    { "codepath": "runtimeApprovals.create in worker runner", "failure": "Runtime approval event lacks token or ownership attach fails", "exception": "AdapterProtocolError or ServiceError", "rescue": "Return failure to RuntimeRunnerService so run fails visibly rather than waiting forever.", "user_sees": "Run failed event with runtime_approval_token_missing, approval_ownership_attach_failed, or runtime_approval_bridge_unconfigured." },
    { "codepath": "worker restart reconciliation", "failure": "Waiting hosted session cannot be safely resumed and pending approvals remain", "exception": "Expected stale state detected without throw", "rescue": "Fail run with hosted_runtime_session_lost and terminalize approvals before claiming new bridge work.", "user_sees": "Run reaches failed status and approvals are no longer pending instead of remaining stuck." },
    { "codepath": "worker readiness bridge checks", "failure": "Bridge enabled without command store, approval sender, session reconciliation, worker claim, or adapter bridge capability", "exception": "Readiness probe returns failed check", "rescue": "Return not ready and skip bridge claim loop.", "user_sees": "Worker readiness names missing bridge dependency." }
  ],
  "observability": { "logs": ["info worker.runtime_bridge.claim { commandId, runId, runtimeMode, operation }", "info worker.runtime_bridge.apply { commandId, runId, runtimeMode, operation, decision }", "warn worker.runtime_bridge.fail { commandId, runId, runtimeMode, operation, reasonCode }", "warn worker.runtime_bridge.reconcile { runId, runtimeMode, reasonCode }"], "success_metric": "Worker bridge claimed/completed counters by runtimeMode and operation.", "failure_metric": "Worker bridge failed/expired/reconciled/readiness counters by reasonCode." },
  "test_cases": [
    { "name": "worker applies hosted Claude input", "lens": "happy", "given": "Queued bridge input command for active owned fake Claude hosted session", "expect": "Fake Claude sentUserMessages contains input, command completed, and run resumes." },
    { "name": "worker handles no bridge command", "lens": "happy_shadow_empty", "given": "tick with no bridge commands, no tool jobs, and no run jobs", "expect": "tick returns false or proceeds to existing queue behavior without errors." },
    { "name": "worker rejects missing session command", "lens": "happy_shadow_nil", "given": "Bridge command references run with no session row", "expect": "Command fails with hosted_runtime_bridge_session_missing and adapter is not called." },
    { "name": "worker resolves hosted Claude approval", "lens": "integration", "given": "Fake Claude emits approval request and hosted approve route queued resolution command", "expect": "Fake Claude resolvedApprovals records decision exactly once." },
    { "name": "worker answers ACP permission request", "lens": "integration", "given": "Fake ACP permission request and approved runtime approval resolution command", "expect": "Fake ACP stats.permissionResponses increments once and run continues according to fake response." },
    { "name": "worker readiness missing dependency fails closed", "lens": "error_path", "given": "Bridge enabled test config with command store or approval sender omitted", "expect": "ready claim mode fails with exact bridge dependency diagnostic and tick does not claim." },
    { "name": "worker ownership mismatch", "lens": "error_path", "given": "Bridge command claimed by worker B targets session state owned by worker A", "expect": "Command fails with hosted_runtime_bridge_session_not_owned and no adapter input." },
    { "name": "worker restart terminalizes pending approval", "lens": "error_path", "given": "Hosted run waiting_for_approval after restart with no resume path", "expect": "Run fails with hosted_runtime_session_lost and pending approval is expired or rejected." },
    { "name": "hosted codex interactive not registered", "lens": "error_path", "given": "Source/test inspection of buildHostedWorkerAdapters", "expect": "No CodexInteractiveAdapter import or codex.interactive runtime mode registration." }
  ],
  "integration_contracts": {
    "exports": [
      { "name": "createHostedWorker bridge behavior", "kind": "function", "signature": "createHostedWorker(config: HostedWorkerConfig, deps?: HostedWorkerDeps) => { tick(): Promise<boolean>; ready(options?: { mode?:'full'|'claim' }): Promise<WorkerReadinessReport>; stop(): Promise<void> } with bridge reconciliation before bridge claims" },
      { "name": "getWorkerRuntimeBridgeReadiness", "kind": "function", "signature": "(deps: { commandStore?:unknown; sessionReconciliation?:unknown; adapterCapabilities?:Record<string, boolean>; approvalSender?:unknown; workerClaim?:unknown }) => HostedRuntimeBridgeReadinessReport" }
    ],
    "imports_from_other_tasks": [
      { "from_task": "P22-T2-storage-outbox", "name": "PostgresHostedRuntimeBridgeCommandStore", "signature": "constructor(handle?: PostgresDatabaseHandle); create(input: CreateHostedRuntimeBridgeCommandInput) => Promise<{ command: HostedRuntimeBridgeCommand; duplicate: boolean }>; get(id: string) => Promise<HostedRuntimeBridgeCommand | undefined>; getByIdempotencyKey(key: string) => Promise<HostedRuntimeBridgeCommand | undefined>; claimNext(input: { workerId:string; leaseMs:number; now?:string }) => Promise<HostedRuntimeBridgeCommand | undefined>; complete(input: { commandId:string; workerId:string; result?:Record<string, unknown>; now?:string }) => Promise<HostedRuntimeBridgeCommand | null>; fail(input: { commandId:string; workerId?:string; reasonCode:string; retryable:boolean; now?:string }) => Promise<HostedRuntimeBridgeCommand | null>; expireStale(input: { now?:string }) => Promise<{ expired:number }>; recoverStaleClaims(input: { now?:string; nonIdempotentPolicy:'fail'|'retry_if_adapter_ack' }) => Promise<{ recovered:number; failed:number }>; listByRun(runId: string) => Promise<HostedRuntimeBridgeCommand[]>" },
      { "from_task": "P22-T3-core-bridge-orchestration", "name": "HostedRuntimeBridgeWorkerRuntime", "signature": "Pick<HostedRuntimeBridgeService, 'claimAndApplyNext' | 'reconcileHostedRuntimeSessions' | 'createWorkerRuntimeApproval' | 'terminalizePendingRuntimeApprovalsForRun'>" },
      { "from_task": "P22-T5-claude-hosted-bridge", "name": "ClaudeCodeAdapterOptions.hostedBridgeEnabled", "signature": "hostedBridgeEnabled?: boolean" },
      { "from_task": "P22-T7-opencode-hosted-bridge", "name": "OpenCodeAcpAdapterOptions.hostedBridgeEnabled", "signature": "hostedBridgeEnabled?: boolean" },
      { "from_task": "P22-T1-contracts-openapi", "name": "HostedRuntimeBridgeReadinessReport", "signature": "{ status:'ready'|'not_ready'; checks: Array<{ name:'command_store'|'command_outbox'|'approval_ownership'|'quota'|'audit'|'route_auth'|'worker_claim'|'adapter_capability'|'session_reconciliation'|'approval_sender'; ok:boolean; reasonCode?:string }> }" }
    ],
    "file_paths_consumed_by_other_tasks": ["apps/worker/src/worker.ts", "apps/worker/src/hosted-runtime-adapters.ts", "apps/worker/src/ready.ts"]
  }
}
```

### Task P22-T9-ops-docs-product-truth

```json
{
  "id": "P22-T9-ops-docs-product-truth",
  "title": "Update unsupported boundaries, ops checks, smoke, and product truth",
  "files": [
    "packages/core/src/services/hosted-runtime-catalog.ts",
    "packages/core/test/hosted-runtime-catalog.test.ts",
    "packages/core/test/registry-service.test.ts",
    "packages/adapters/test/codex-exec-json-adapter.test.ts",
    "packages/adapters/test/agentfield-async-rest-adapter.test.ts",
    "packages/adapters/test/generic-http-adapter.test.ts",
    "scripts/production-preflight.ts",
    "scripts/production-preflight.test.ts",
    "scripts/production-canary.ts",
    "scripts/production-canary.test.ts",
    "scripts/hosted-real-runtime-smoke.ts",
    "deploy/production/manifest.json",
    "deploy/production/production-manifest.test.ts",
    "PRODUCT.md",
    "README.md",
    "docs/development/DEVELOPMENT.md",
    "docs/development/adapters/CLAUDE_CODE.md",
    "docs/development/adapters/OPENCODE.md",
    "docs/development/adapters/AGENTFIELD.md",
    "docs/development/adapters/GENERIC_HTTP.md"
  ],
  "dependencies": ["P22-T1-contracts-openapi", "P22-T4-rest-server-admission", "P22-T5-claude-hosted-bridge", "P22-T7-opencode-hosted-bridge", "P22-T8-worker-bridge-orchestration"],
  "context_files": ["docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md", "PRODUCT.md", "README.md", "docs/development/DEVELOPMENT.md", "scripts/production-preflight.ts", "scripts/production-canary.ts", "scripts/hosted-real-runtime-smoke.ts", "packages/core/src/services/hosted-runtime-catalog.ts"],
  "instructions": "Update hosted runtime catalog and capability truth so hosted claude_code.sdk advertises run.input, session.state, and approval.bridge only with bridge readiness diagnostics; hosted opencode.acp advertises structured ACP prompt/input/permission approval bridging only when bridge dependencies are present; codex.exec_json remains one-shot without input or approval bridge capabilities; codex.interactive remains local-only and absent from hosted catalog. Add boundary tests for codex.exec_json unsupported hosted input/approval, AgentField bridge unshipped, Generic HTTP bridge unshipped, forbidden public routes, and no server real provider adapter source. Extend production preflight, canary, manifest, and hosted real-runtime smoke with deterministic no-spend bridge checks using fake Claude and fake ACP by default. Live provider bridge canaries require explicit spend confirmation and are skipped by default. Update product and development docs with exact shipped/unshipped R23 truth, including no terminal/PTY/TUI automation, no hosted Codex interactive, no AgentField/Generic HTTP bridges, no public arbitrary execution routes, no dashboard, no TUI, no hosted live resume guarantee, no raw prompt/secret logging, and hosted_runtime_bridge_non_idempotent_retry_blocked as the visible stale-claim safety reason when provider retry would be unsafe.",
  "acceptance": ["Hosted runtime catalog keeps hosted runtime slug union limited to fake.deterministic, codex.exec_json, claude_code.sdk, and opencode.acp.", "Hosted catalog and registry output do not include codex.interactive as a hosted mode.", "Hosted Claude and OpenCode capability/limitation text matches R23 bridge support and readiness dependencies.", "Hosted codex.exec_json capability/limitation text states one-shot input and approval bridge unsupported.", "AgentField and Generic HTTP tests and docs state hosted runtime bridges remain unshipped pending durable callback contracts.", "Production preflight fails closed when bridge support is enabled without API-key auth, Postgres/control-plane ownership, durable command store/outbox, quota store, audit store, worker readiness, or provider activation gates.", "Default hosted bridge smoke/canary uses fake Claude and fake ACP with no live provider spend.", "Live provider bridge canary requires explicit spend confirmation and is skipped by default.", "PRODUCT.md and development docs state exactly what R23 shipped and what remains unshipped, including hosted_runtime_bridge_non_idempotent_retry_blocked stale-claim behavior.", "Docs and tests do not overclaim hosted Codex interactive, terminal bridge, session resume guarantees, dashboard/TUI, arbitrary execution, Generic HTTP/AgentField bridge support, browser automation, hosted debate real participants, or model judging."],
  "checks": ["pnpm --filter @switchyard/core test -- hosted-runtime-catalog.test.ts registry-service.test.ts", "pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter.test.ts agentfield-async-rest-adapter.test.ts generic-http-adapter.test.ts", "pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts deploy/production/production-manifest.test.ts", "pnpm --filter @switchyard/contracts openapi:check:hosted", "pnpm typecheck", "git diff --check"],
  "error_rescue_map": [
    { "codepath": "production preflight bridge checks", "failure": "Bridge support enabled without auth, control-plane ownership, command store, outbox, quota, audit, worker readiness, or provider gates", "exception": "Preflight returns failing check with named code", "rescue": "Fail closed before production traffic can route to bridge commands.", "user_sees": "Preflight output names missing bridge dependency." },
    { "codepath": "production canary bridge checks", "failure": "Live provider bridge canary requested without explicit spend confirmation", "exception": "Canary prerequisite failure", "rescue": "Skip live provider path and run only fake/no-spend bridge canary.", "user_sees": "Canary output states live bridge canary skipped unless explicitly confirmed." },
    { "codepath": "hosted runtime catalog", "failure": "Catalog accidentally includes codex.interactive or hosted capabilities for codex.exec_json, AgentField, or Generic HTTP", "exception": "Vitest assertion failure", "rescue": "Remove unsupported hosted catalog entry/capability and keep explicit limitation wording.", "user_sees": "Registry truth does not imply unsupported bridge support." },
    { "codepath": "product/development docs", "failure": "Docs overclaim terminal bridge, PTY/TUI automation, hosted Codex interactive, Generic HTTP/AgentField bridge support, live resume, dashboard, or arbitrary execution routes", "exception": "Doc truth test or grep assertion failure", "rescue": "Replace with exact shipped/unshipped R23 wording.", "user_sees": "Product truth matches audited implementation boundary." }
  ],
  "observability": { "logs": ["preflight prints bridge dependency check names and redacted diagnostics", "canary prints fake bridge scenario names and live-provider skip reason", "smoke prints fake Claude/OpenCode bridge success/failure codes without raw prompts"], "success_metric": "Default preflight/canary/smoke complete without live provider spend and report R23 bridge checks.", "failure_metric": "Missing dependency or live-spend misconfiguration fails with named prerequisite code." },
  "test_cases": [
    { "name": "catalog excludes hosted codex interactive", "lens": "error_path", "given": "Object.keys of hosted runtime catalog", "expect": "Does not contain codex.interactive." },
    { "name": "codex exec json one-shot truth", "lens": "happy", "given": "Hosted codex.exec_json catalog entry", "expect": "No run.input, session.resume, or approval.bridge capability and limitation states one-shot unsupported bridge." },
    { "name": "AgentField bridge unshipped", "lens": "error_path", "given": "AgentField adapter send or hosted bridge fixture", "expect": "agentfield_input_unsupported or agentfield_bridge_unshipped with no approval callback contract." },
    { "name": "Generic HTTP bridge unshipped", "lens": "error_path", "given": "Generic HTTP adapter send or hosted bridge fixture", "expect": "generic_http_input_unsupported or generic_http_bridge_unshipped with no approval callback contract." },
    { "name": "preflight missing bridge store fails", "lens": "error_path", "given": "Production env enables runtime bridge without Postgres/command store", "expect": "production-preflight reports hosted_runtime_bridge_store_unavailable." },
    { "name": "default canary no-spend", "lens": "happy", "given": "production canary without live provider confirmation", "expect": "Fake bridge checks run and live provider bridge checks are skipped." },
    { "name": "forbidden route and source tests", "lens": "error_path", "given": "Hosted route inventory and server source inspection", "expect": "No hosted public bridge/execution routes and server app does not import or instantiate real provider adapters." },
    { "name": "docs stale claim safety reason", "lens": "error_path", "given": "PRODUCT.md and development docs mention worker crash after provider send without durable adapter ack", "expect": "Docs name hosted_runtime_bridge_non_idempotent_retry_blocked and state the worker does not blindly retry provider input." },
    { "name": "docs product truth", "lens": "integration", "given": "PRODUCT.md and development docs after R23", "expect": "Docs contain shipped Claude/OpenCode bridge wording and unshipped Codex interactive, AgentField, Generic HTTP, terminal/PTX/TUI, dashboard, arbitrary route, and live resume wording." }
  ],
  "integration_contracts": {
    "exports": [{ "name": "R23 product truth", "kind": "constant", "signature": "Docs/catalog/scripts describe hosted Claude and structured OpenCode bridge support plus explicit unsupported runtime boundaries." }],
    "imports_from_other_tasks": [
      { "from_task": "P22-T1-contracts-openapi", "name": "HOSTED_RUNTIME_BRIDGE_REASON_CODES", "signature": "readonly string[] including hosted_runtime_bridge_store_unavailable, hosted_runtime_bridge_queue_unavailable, hosted_runtime_bridge_worker_unavailable, hosted_runtime_bridge_operation_unsupported, hosted_runtime_bridge_session_missing, hosted_runtime_bridge_session_not_owned, hosted_runtime_session_missing, hosted_runtime_session_lost, hosted_runtime_session_state_incomplete, hosted_runtime_bridge_payload_mismatch, hosted_runtime_bridge_command_expired, hosted_runtime_bridge_non_idempotent_retry_blocked, hosted_runtime_bridge_quota_exceeded, hosted_codex_interactive_unshipped, codex_exec_json_input_unsupported, codex_exec_json_approval_bridge_unsupported, agentfield_bridge_unshipped, generic_http_bridge_unshipped" },
      { "from_task": "P22-T4-rest-server-admission", "name": "getServerRuntimeBridgeReadiness", "signature": "(deps: { commandStore?:unknown; commandOutbox?:unknown; approvalOwnership?:unknown; quota?:unknown; audit?:unknown; routeAuth?:unknown; workerReadiness?:unknown }) => HostedRuntimeBridgeReadinessReport" },
      { "from_task": "P22-T8-worker-bridge-orchestration", "name": "getWorkerRuntimeBridgeReadiness", "signature": "(deps: { commandStore?:unknown; sessionReconciliation?:unknown; adapterCapabilities?:Record<string, boolean>; approvalSender?:unknown; workerClaim?:unknown }) => HostedRuntimeBridgeReadinessReport" }
    ],
    "file_paths_consumed_by_other_tasks": ["PRODUCT.md", "README.md", "docs/development/DEVELOPMENT.md", "scripts/production-preflight.ts", "scripts/production-canary.ts", "scripts/hosted-real-runtime-smoke.ts"]
  }
}
```

## Risks

- The phase remains large because the bridge spans existing public routes, durable state, worker-owned sessions, two adapter protocols, and ops truth. Splitting storage/outbox from core orchestration reduces revision risk while keeping the public surface unchanged.
- Restart reconciliation for real provider sessions is intentionally conservative. If a deterministic resume path is not proven, workers terminalize with `hosted_runtime_session_lost` or non-idempotent retry blocked instead of claiming resume support.
- Approval list/get must authorize ownership before classifying approval scope. This is security-sensitive and remains auditor focus.
- OpenCode ACP permission handling must answer JSON-RPC only through the held request API; PTY/TUI/terminal code paths are out of scope and source-tested.

## Integration Points

- T1 provides the shared schema/error/readiness vocabulary consumed by every downstream task.
- T2 provides the durable Postgres command outbox that structurally conforms to the T3 store port.
- T3 provides the core service, exact server-admission interface, exact worker-runtime interface, quota lifecycle, idempotency, hashing, approval terminalization, and reconciliation semantics.
- T4 wires existing hosted input and approval routes to T3/T2 without adding routes or server-owned provider adapters.
- T5 enables hosted Claude bridge behavior only behind the worker-owned hostedBridgeEnabled flag.
- T6 provides held ACP permission request/response primitives and deadline behavior.
- T7 enables structured hosted OpenCode ACP prompt and permission bridging using T6.
- T8 wires worker claim/apply/readiness to T2/T3 and enables only T5/T7 adapter bridge flags.
- T9 validates and documents final product/ops truth after T1-T8 behavior exists.

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
- [ ] Quota accounting is defined and tested for queued, duplicate same-payload, duplicate different-payload, claimed, failed, expired, completed, and worker crash after claim.
- [ ] Worker crash after adapter send without durable adapter ack does not blindly retry non-idempotent provider input.
- [ ] Payload hash is computed from normalized raw payload before redaction; storage persists only hash plus redacted payload summary.
- [ ] Approval approve/reject races result in exactly one durable decision.
- [ ] ACP held request TTL, approval expiry, and command expiry use one shared deadline or strict earlier command expiry; late resolution writes no JSON-RPC response.
- [ ] Worker restart reconciliation terminalizes or safely resumes active hosted sessions; no active hosted run remains silently stuck in `waiting_for_input` or `waiting_for_approval`.
- [ ] Pending hosted runtime approvals are expired/rejected on timeout, cancellation, run failure, or unrecoverable worker restart.
- [ ] Local daemon runtime input/approval behavior remains backward compatible.
- [ ] Hosted tool approvals from R22 continue to work unchanged.
- [ ] Hosted approval routes safely mix, filter, and paginate tool approvals and runtime approvals without cross-tenant existence leaks.
- [ ] Server readiness, worker readiness, preflight, smoke/canary, metrics, audit, logs, OpenAPI, SDK behavior, development docs, and `PRODUCT.md` match the shipped bridge boundary.
- [ ] Default tests, smoke, preflight, and canary are deterministic and no-spend.
- [ ] OpenAPI, route, and source tests prove no public arbitrary execution routes were added and the server app does not import or instantiate real provider adapters.

## Self-Review

- Spec coverage: every spec acceptance criterion and architect-required addition maps to at least one task, with route/source absence coverage in T1, T4, and T9.
- Placeholder scan: no deferred implementation placeholder is used; unsupported runtime work is explicit fail-closed scope.
- Type consistency: T1 exports concrete command/readiness shapes; T3 exports exact server and worker Pick interfaces; T4/T8 import those exact interfaces; T5/T7 expose matching hostedBridgeEnabled adapter options.
- Ownership disjoint: no file appears in more than one task `files` list after splitting storage/outbox from core orchestration.
- Context files real: every task context file is an existing worktree path.
- Acceptance testable: each task has objective checks and test cases for happy, nil/empty, error, and integration paths.
- Dependency order sane: contracts first, storage second, core third, server/adapters/protocol in parallel where possible, worker after core/adapters, ops/product truth last.
- Checks runnable: commands use existing package scripts and Vitest file filters already used by prior phases.
- Error/rescue map present: every runtime task has named failures, rescue actions, and user-visible behavior.
- Observability present: runtime tasks define logs and low-cardinality metrics; pure contract/storage tasks define contract-test and transition-test observability.
- Test cases enumerate acceptance, failure, shadow, lifecycle, and forbidden-source paths requested by architect.
- Integration contracts walk: every `imports_from_other_tasks` resolves to an export in a dependency task with exact signature or narrow Pick shape.
- Contract types match: service, store, readiness, and adapter signatures align across T1-T8.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error_rescue_map entry has a matching error or shadow test case.
- [x] Every integration_contracts import resolves to a real export elsewhere in the task graph.
- [x] Every context_files path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is present.
- [x] Complexity is L and was challenged; storage/outbox and core orchestration are split to reduce revision risk while keeping one coherent hosted runtime bridge phase.
