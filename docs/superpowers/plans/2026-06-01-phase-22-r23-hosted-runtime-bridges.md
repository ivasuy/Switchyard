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
3. Complexity smell is real: the phase must touch more than eight files because contracts, storage, core services, REST routes, server wiring, worker wiring, two adapters, protocol ACP, ops scripts, and product truth must agree. The plan controls blast radius with eight disjoint task ownership slices and narrow exported contracts between slices.
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
- `packages/core/src/ports/hosted-runtime-bridge-command-store.ts`, `services/hosted-runtime-bridge-service.ts`, `runtime-runner-service.ts`, and core tests - command creation, ownership/quota/audit/idempotency, session ownership metadata, worker claim/apply, approval terminalization, and restart reconciliation.
- `packages/storage/src/postgres/hosted-runtime-bridge-command-store.ts`, Postgres schema/database files, storage exports, and storage tests - durable command table/outbox with in-memory fallback, additive migration, TTL, compare-and-update claim, complete, fail, expire, and payload mismatch coverage.
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
  "instructions": "Add `hosted-runtime-bridge.ts` with strict Zod schemas for bridge operation (`input`, `approval_resolution`), command status (`queued`, `claimed`, `completed`, `failed`, `expired`, `cancelled`), bridge-supported runtime modes (`claude_code.sdk`, `opencode.acp`), unsupported mode reason mapping, redacted command payload shape, accepted response extension with optional `bridgeCommandId`, and worker readiness diagnostics shape. Export the new schemas and types from `index.ts`. Add the R23 error codes from the spec to `http-error.ts` and the contract tests. Extend `enterprise.ts` with resource ownership type `runtime_bridge_command` and quota kinds `runtime_bridge_commands_per_hour` and `active_runtime_bridge_commands`; add billing quota fields with zero defaults so existing bootstrap fixtures remain valid but production can fail closed when bridge support is enabled without explicit quota. Keep `approval` ownership intact. Update hosted OpenAPI generation so existing `POST /runs/:id/input`, `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, and `POST /approvals/:id/reject` describe supported runtime approval behavior without adding `POST /approvals` or any bridge-specific route. Add route inventory assertions that hosted OpenAPI still has no public route containing `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, `/sandbox`, top-level `/input`, top-level `/approval`, `/runtime-bridge`, `/session`, dashboard, or TUI.",
  "acceptance": [
    "Hosted runtime bridge command schemas parse valid input and approval-resolution command fixtures and reject missing run id, missing operation, unknown operation, unknown status, unbounded payloads, and non-redacted secret-like fields.",
    "HTTP error contract includes every R23 hosted runtime bridge error code listed in the spec and keeps existing codes visible.",
    "Enterprise resource ownership type includes runtime_bridge_command and approval remains valid.",
    "Quota schemas include runtime_bridge_commands_per_hour and active_runtime_bridge_commands with backward-compatible defaults.",
    "Hosted OpenAPI documents existing run input and approval list/get/approve/reject routes for runtime bridge usage.",
    "Hosted OpenAPI does not include hosted POST /approvals or any public arbitrary execution, terminal, PTY, sandbox, bridge, dashboard, or TUI route.",
    "AcceptedResponse remains backward compatible for clients that only parse accepted."
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
    {
      "codepath": "hostedRuntimeBridgeCommandSchema.parse",
      "failure": "Malformed operation, status, runtime mode, payload, TTL, owner ids, or payload hash",
      "exception": "ZodError",
      "rescue": "Reject before persistence or queue side effects.",
      "user_sees": "400 invalid_input or 409 adapter_protocol_failed with a named reason code; no command is queued."
    },
    {
      "codepath": "httpErrorCodeSchema.parse",
      "failure": "Route or service emits an unregistered R23 reason as an HTTP code",
      "exception": "ZodError in contract tests",
      "rescue": "Add the named code to the closed schema and explicit status mapping before route work proceeds.",
      "user_sees": "Named bridge errors instead of generic internal_error."
    },
    {
      "codepath": "hosted endpoint inventory",
      "failure": "OpenAPI generation accidentally exposes POST /approvals or forbidden execution/terminal/bridge routes",
      "exception": "Vitest assertion failure",
      "rescue": "Remove the route from the hosted surface and keep only existing input and approval routes.",
      "user_sees": "Hosted API remains limited to existing run input and approval endpoints."
    }
  ],
  "observability": {
    "logs": [
      "Contract task adds no runtime logs.",
      "OpenAPI contract tests print failing route keys when route inventory drifts."
    ],
    "success_metric": "Hosted OpenAPI contains the existing bridge-capable routes and zero forbidden route keys.",
    "failure_metric": "Any unknown HTTP code or forbidden route key fails contract tests."
  },
  "test_cases": [
    {
      "name": "parses valid bridge input command",
      "lens": "happy",
      "given": "hostedRuntimeBridgeCommandSchema.parse({ operation:'input', runtimeMode:'claude_code.sdk', payload:{ textBytes:12, redacted:true }, ...required ids and timestamps })",
      "expect": "Parsed command has operation input and no raw prompt text field."
    },
    {
      "name": "rejects missing bridge command payload",
      "lens": "happy_shadow_nil",
      "given": "hostedRuntimeBridgeCommandSchema.parse({ operation:'input', payload: undefined })",
      "expect": "ZodError before persistence."
    },
    {
      "name": "rejects empty bridge command idempotency key",
      "lens": "happy_shadow_empty",
      "given": "hostedRuntimeBridgeCommandSchema.parse({ idempotencyKey:'' })",
      "expect": "ZodError with path idempotencyKey."
    },
    {
      "name": "rejects secret-like payload fields",
      "lens": "error_path",
      "given": "Payload contains token, authorization, env, argv, command, objectKey, or providerOutput",
      "expect": "Schema or contract helper rejects or redacts before storage."
    },
    {
      "name": "keeps accepted response backward compatible",
      "lens": "integration",
      "given": "acceptedResponseSchema.parse({ accepted:true }) and parse({ accepted:true, bridgeCommandId:'bridge_1' })",
      "expect": "Both parse successfully."
    },
    {
      "name": "hosted openapi excludes forbidden routes",
      "lens": "error_path",
      "given": "Generated hosted OpenAPI route keys",
      "expect": "No key includes /exec, /shell, /process, /command, /pty, /terminal, /sandbox, /runtime-bridge, dashboard, or tui."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "hostedRuntimeBridgeCommandSchema",
        "kind": "constant",
        "signature": "Zod schema for durable hosted runtime bridge command records"
      },
      {
        "name": "HostedRuntimeBridgeCommand",
        "kind": "type",
        "signature": "{ id:string; runId:string; runtimeSessionId?:string; runtimeMode:string; operation:'input'|'approval_resolution'; status:'queued'|'claimed'|'completed'|'failed'|'expired'|'cancelled'; idempotencyKey:string; payloadHash:string; payload:Record<string, unknown>; expiresAt:string; createdAt:string; updatedAt:string; }"
      },
      {
        "name": "isHostedRuntimeBridgeSupportedMode",
        "kind": "function",
        "signature": "(runtimeMode: string, operation?: 'input' | 'approval_resolution') => boolean"
      },
      {
        "name": "R23 bridge reason codes",
        "kind": "constant",
        "signature": "Closed HTTP/provider reason code additions including hosted_runtime_bridge_store_unavailable, hosted_runtime_bridge_queue_unavailable, hosted_runtime_bridge_worker_unavailable, hosted_runtime_bridge_operation_unsupported, hosted_runtime_bridge_session_missing, hosted_runtime_bridge_session_not_owned, hosted_runtime_session_missing, hosted_runtime_session_lost, hosted_runtime_session_state_incomplete, hosted_runtime_bridge_payload_mismatch, hosted_runtime_bridge_command_expired, hosted_runtime_bridge_quota_exceeded, hosted_codex_interactive_unshipped, codex_exec_json_input_unsupported, codex_exec_json_approval_bridge_unsupported, agentfield_bridge_unshipped, and generic_http_bridge_unshipped"
      },
      {
        "name": "R23 ACP reason codes",
        "kind": "constant",
        "signature": "Closed ACP bridge reason code additions including acp_permission_request_invalid, acp_permission_response_failed, acp_permission_request_expired, acp_prompt_in_flight, and acp_session_not_ready_for_input"
      }
    ],
    "imports_from_other_tasks": [],
    "file_paths_consumed_by_other_tasks": [
      "packages/contracts/src/hosted-runtime-bridge.ts",
      "packages/contracts/src/http-error.ts",
      "packages/contracts/src/enterprise.ts",
      "packages/contracts/openapi.hosted-server.json"
    ]
  }
}
```

### Task P22-T2-storage-core-bridge

```json
{
  "id": "P22-T2-storage-core-bridge",
  "title": "Add durable bridge command store and core orchestration",
  "files": [
    "packages/core/src/ports/hosted-runtime-bridge-command-store.ts",
    "packages/core/src/services/hosted-runtime-bridge-service.ts",
    "packages/core/src/services/runtime-runner-service.ts",
    "packages/core/src/index.ts",
    "packages/core/test/hosted-runtime-bridge-service.test.ts",
    "packages/storage/src/postgres/hosted-runtime-bridge-command-store.ts",
    "packages/storage/src/postgres/schema.ts",
    "packages/storage/src/postgres/database.ts",
    "packages/storage/src/index.ts",
    "packages/storage/test/postgres-runtime-bridge-store.test.ts",
    "packages/storage/test/postgres-schema-compat.test.ts",
    "packages/storage/test/storage-package.test.ts"
  ],
  "dependencies": [
    "P22-T1-contracts-openapi"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md",
    "packages/core/src/services/runtime-runner-service.ts",
    "packages/core/src/services/approval-service.ts",
    "packages/core/src/services/control-plane-service.ts",
    "packages/core/src/ports/run-store.ts",
    "packages/core/src/ports/session-store.ts",
    "packages/storage/src/postgres/tool-dispatch-outbox-store.ts",
    "packages/storage/src/postgres/database.ts"
  ],
  "instructions": "Create a `HostedRuntimeBridgeCommandStore` port and a Postgres-backed outbox store with in-memory fallback following the `PostgresToolDispatchOutboxStore` pattern. The store must support create-or-return-idempotent, get, claim-next with lease, complete-if-claimed, fail-if-claimed, expire-stale, recover-stale-claims, and list-by-run for tests. Persist only bounded redacted payloads, payload hashes, owner ids, runtime mode, operation, approval id, runtime session id, attempts, TTL, lease owner, and reason code. Add additive Postgres schema/table/indexes and schema compatibility coverage. Add `HostedRuntimeBridgeService` to perform supported-mode checks, payload validation and hashing, command idempotency, run/session state checks, ownership attach, quota reserve/release/consume, audit allow/deny/error writes, worker command claim/apply, runtime approval creation from worker events, runtime approval resolution command creation, pending approval terminalization, and restart reconciliation. Update `RuntimeRunnerService` with optional hosted session owner metadata so new hosted sessions record worker id and bridge ownership state in bounded `RuntimeSession.state` without breaking local daemon sessions. The service must never call provider adapters in the server admission methods; only worker apply methods may call `RuntimeRunnerService.sendInput`.",
  "acceptance": [
    "Bridge command store creates, fetches, claims, completes, fails, expires, and recovers commands with compare-and-update guards.",
    "Duplicate idempotency key with same payload returns the existing command result without creating a second command.",
    "Duplicate idempotency key with different payload fails with hosted_runtime_bridge_payload_mismatch.",
    "Commands expire after TTL and expired commands cannot be claimed or applied.",
    "Command ownership is attached as runtime_bridge_command before a worker can claim it.",
    "Input command admission rejects terminal runs, missing sessions, unsupported runtime modes, unsupported operations, quota exhaustion, store unavailable, and ownership mismatch with named reason codes.",
    "Runtime approval creation attaches approval ownership before hosted routes can list or get the approval.",
    "Approval resolution command creation is exactly-once and preserves approval_not_found, approval_not_pending, and runtime_approval_pause_not_active semantics.",
    "Worker apply verifies the claimed command, run id, runtime mode, runtime session id, payload hash, owner worker id, and active run state before calling RuntimeRunnerService.sendInput.",
    "Worker restart reconciliation terminalizes unrecoverable active hosted real-runtime sessions with hosted_runtime_session_lost or hosted_runtime_session_state_incomplete and terminalizes pending runtime approvals.",
    "Local daemon RuntimeRunnerService behavior remains backward compatible when hosted bridge dependencies are absent."
  ],
  "checks": [
    "pnpm --filter @switchyard/core test -- hosted-runtime-bridge-service.test.ts runtime-approval-session-r16.test.ts core.test.ts",
    "pnpm --filter @switchyard/storage test -- postgres-runtime-bridge-store.test.ts postgres-schema-compat.test.ts storage-package.test.ts",
    "pnpm --filter @switchyard/core typecheck",
    "pnpm --filter @switchyard/storage typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "HostedRuntimeBridgeService.createInputCommand",
      "failure": "Run missing, terminal, not hosted, unsupported runtime mode, unsupported operation, missing session, stale session, or inactive status",
      "exception": "ServiceError with code adapter_protocol_failed, run_not_found, tenant_access_denied, quota_exceeded, or hosted_runtime_bridge_store_unavailable",
      "rescue": "Do not create a command; record deny/error audit when auth is present; return named reason details.",
      "user_sees": "404, 409, 429, or 503 with reasonCode such as run_not_found, runtime_input_not_active, hosted_input_bridge_unsupported, hosted_runtime_bridge_session_missing, or hosted_runtime_bridge_quota_exceeded."
    },
    {
      "codepath": "HostedRuntimeBridgeCommandStore.create",
      "failure": "Same idempotency key exists with a different payload hash",
      "exception": "BridgeStoreError reasonCode hosted_runtime_bridge_payload_mismatch",
      "rescue": "Return conflict without mutating existing command.",
      "user_sees": "409 adapter_protocol_failed with hosted_runtime_bridge_payload_mismatch."
    },
    {
      "codepath": "HostedRuntimeBridgeService.applyClaimedCommand",
      "failure": "Command expired, run/session missing, worker owner mismatch, runtime mode mismatch, approval stale, or payload hash mismatch",
      "exception": "AdapterProtocolError or ServiceError with named reason",
      "rescue": "Fail or expire the command, append visible runtime failure event only when runtime progress is affected, and never call adapter.send.",
      "user_sees": "Run event or approval result contains hosted_runtime_bridge_command_expired, hosted_runtime_bridge_session_not_owned, hosted_runtime_session_missing, approval_not_pending, or hosted_runtime_bridge_payload_mismatch."
    },
    {
      "codepath": "HostedRuntimeBridgeService.createWorkerRuntimeApproval",
      "failure": "Approval store write, ownership attach, quota reservation, or audit append fails",
      "exception": "ServiceError or store exception mapped to approval_ownership_attach_failed, hosted_runtime_bridge_store_unavailable, quota_exceeded, or audit_log_unavailable",
      "rescue": "Terminalize run visibly with runtime_approval_bridge_unconfigured or approval_ownership_attach_failed and do not leave a hidden pending approval.",
      "user_sees": "Run fails with a named runtime approval bridge reason."
    },
    {
      "codepath": "HostedRuntimeBridgeService.reconcileHostedRuntimeSessions",
      "failure": "Active hosted session has no owner, incomplete external key/state, no live claim, or no verified resume path",
      "exception": "No thrown error for expected stale state; store errors map to readiness failure",
      "rescue": "Terminalize run with hosted_runtime_session_lost, hosted_runtime_session_missing, or hosted_runtime_session_state_incomplete and reject/expire pending runtime approvals.",
      "user_sees": "Run no longer remains silently stuck in waiting_for_input or waiting_for_approval."
    }
  ],
  "observability": {
    "logs": [
      "info hosted.runtime_bridge.admitted { runId, runtimeMode, operation, decision, reasonCode, requestId, redacted:true }",
      "info hosted.runtime_bridge.claimed { commandId, runId, runtimeMode, operation }",
      "info hosted.runtime_bridge.completed { commandId, runId, runtimeMode, operation }",
      "warn hosted.runtime_bridge.failed { commandId, runId, runtimeMode, operation, reasonCode }",
      "warn hosted.runtime_bridge.reconciled { runId, runtimeMode, reasonCode }"
    ],
    "success_metric": "Counters by runtimeMode, operation, decision, and reasonCode for admitted, claimed, completed, failed, expired, and reconciled bridge commands.",
    "failure_metric": "Any store/queue/audit/quota unavailable path increments a reason-coded bridge failure counter without raw input text."
  },
  "test_cases": [
    {
      "name": "creates and completes bridge command",
      "lens": "happy",
      "given": "Active hosted claude_code.sdk run with owned active session and text input",
      "expect": "Command is queued, claimed by worker, applied through sendInput, marked completed, and metrics/logs omit raw text."
    },
    {
      "name": "rejects nil input body",
      "lens": "happy_shadow_nil",
      "given": "createInputCommand with undefined or non-object body",
      "expect": "invalid_input; no command row."
    },
    {
      "name": "rejects empty text",
      "lens": "happy_shadow_empty",
      "given": "createInputCommand with text containing only whitespace",
      "expect": "adapter_protocol_failed with runtime_input_empty; no adapter dispatch."
    },
    {
      "name": "deduplicates same payload",
      "lens": "edge_idempotency",
      "given": "Two create calls with same idempotency key and same payload hash",
      "expect": "Both return the same command id and only one command can be claimed."
    },
    {
      "name": "rejects duplicate key different payload",
      "lens": "error_path",
      "given": "Second create call reuses idempotency key with different text hash",
      "expect": "hosted_runtime_bridge_payload_mismatch and original command is unchanged."
    },
    {
      "name": "expires stale command",
      "lens": "error_path",
      "given": "Queued command with expiresAt before now",
      "expect": "expireStale marks expired and claimNext skips it."
    },
    {
      "name": "worker ownership mismatch fails closed",
      "lens": "error_path",
      "given": "Claimed command targets session owned by different worker id",
      "expect": "Command fails with hosted_runtime_bridge_session_not_owned and adapter.send is not called."
    },
    {
      "name": "runtime approval creation attaches ownership",
      "lens": "integration",
      "given": "Worker receives approval.requested for owned hosted run",
      "expect": "Approval row is pending, resource ownership exists, audit allow is written, and hosted list/get can return it."
    },
    {
      "name": "restart reconciliation terminalizes lost session",
      "lens": "error_path",
      "given": "Hosted claude_code.sdk run remains waiting_for_approval with stale worker owner and no verified resume path",
      "expect": "Run fails with hosted_runtime_session_lost and pending runtime approvals are rejected or expired."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "HostedRuntimeBridgeCommandStore",
        "kind": "interface",
        "signature": "create(input) => Promise<{ command: HostedRuntimeBridgeCommand; duplicate: boolean }>; claimNext(input) => Promise<HostedRuntimeBridgeCommand | undefined>; complete(input) => Promise<HostedRuntimeBridgeCommand | null>; fail(input) => Promise<HostedRuntimeBridgeCommand | null>; expireStale(input) => Promise<{ expired: number }>"
      },
      {
        "name": "HostedRuntimeBridgeService",
        "kind": "class",
        "signature": "createInputCommand(input) => Promise<{ accepted: true; commandId: string; duplicate: boolean }>; resolveRuntimeApproval(input) => Promise<{ approval: Approval; commandId: string; duplicate: boolean }>; createWorkerRuntimeApproval(input) => Promise<Approval>; claimAndApplyNext(input) => Promise<boolean>; reconcileHostedRuntimeSessions(input) => Promise<{ reconciled: number; failed: number }>"
      },
      {
        "name": "PostgresHostedRuntimeBridgeCommandStore",
        "kind": "class",
        "signature": "constructor(handle?: PostgresDatabaseHandle) implements HostedRuntimeBridgeCommandStore"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P22-T1-contracts-openapi",
        "name": "HostedRuntimeBridgeCommand",
        "signature": "Durable command record type"
      },
      {
        "from_task": "P22-T1-contracts-openapi",
        "name": "isHostedRuntimeBridgeSupportedMode",
        "signature": "(runtimeMode: string, operation?: 'input' | 'approval_resolution') => boolean"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/services/hosted-runtime-bridge-service.ts",
      "packages/core/src/ports/hosted-runtime-bridge-command-store.ts",
      "packages/storage/src/postgres/hosted-runtime-bridge-command-store.ts"
    ]
  }
}
```

### Task P22-T3-rest-server-admission

```json
{
  "id": "P22-T3-rest-server-admission",
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
  "dependencies": [
    "P22-T1-contracts-openapi",
    "P22-T2-storage-core-bridge"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md",
    "packages/protocol-rest/src/run-routes.ts",
    "packages/protocol-rest/src/hosted-tool-routes.ts",
    "packages/protocol-rest/src/hosted-auth.ts",
    "apps/server/src/app.ts",
    "apps/server/src/readiness.ts",
    "packages/protocol-rest/test/run-routes.test.ts"
  ],
  "instructions": "Replace the blanket hosted real-runtime input denial in `POST /runs/:id/input` with a call to `HostedRuntimeBridgeService.createInputCommand` only after existing hosted auth and run ownership checks pass. Preserve local daemon behavior by keeping `runService.sendInput` for non-hosted-real runs. Extend hosted approval list/get/approve/reject route behavior so runtime approvals are authorized by approval ownership before scope classification, listed alongside tool approvals when owned, and resolved through `HostedRuntimeBridgeService.resolveRuntimeApproval` when scope is runtime. Tool approvals must continue to route through `HostedToolService.resolveApproval` unchanged. Do not add `POST /approvals` or any new bridge route. Update REST error status mappings for R23 codes. In `apps/server/src/app.ts`, construct the Postgres bridge command store and core bridge service with control-plane, approval, run, session, audit, quota, and metrics hooks; the server must not add real provider adapters to its adapter map. Extend `/ready` diagnostics with bridge command store, command outbox, approval ownership, quota, audit, route auth, and worker readiness prerequisites. Add route and server tests for auth required, missing scope, tenant mismatch without existence leak, run not found, terminal run, unsupported modes, codex.exec_json input unsupported, codex.interactive hosted unshipped, command store unavailable, quota exceeded, accepted Claude/OpenCode command admission, and runtime approval approve/reject command creation exactly once.",
  "acceptance": [
    "Hosted server reuses POST /runs/:id/input and no longer blanket-rejects every active hosted real-runtime input.",
    "Hosted input route admits only supported active claude_code.sdk and ready opencode.acp operations after auth, ownership, quota, capability, idempotency, and state checks.",
    "Hosted codex.exec_json input returns a named unsupported error and no command is queued.",
    "Hosted codex.interactive request is rejected before queue side effects with hosted_codex_interactive_unshipped or closed-catalog equivalent.",
    "Hosted approval list/get includes owned tool approvals and supported runtime approvals without leaking cross-tenant existence.",
    "Hosted approval approve/reject routes dispatch tool approvals through existing tool service and runtime approvals through bridge command service.",
    "Runtime approval resolution creates at most one command for concurrent duplicate approve/reject attempts.",
    "Hosted server app still constructs only FakeRuntimeAdapter for server-local execution.",
    "Server readiness fails closed when bridge support is enabled without auth, command store/outbox, quota, audit, approval ownership, or worker readiness support.",
    "No new public input, approval, bridge, exec, shell, process, command, PTY, terminal, sandbox, dashboard, or TUI route is registered."
  ],
  "checks": [
    "pnpm --filter @switchyard/protocol-rest test -- run-routes.test.ts hosted-tool-routes.test.ts http-errors.request-id.test.ts",
    "pnpm --filter @switchyard/server test -- hosted-server.test.ts hosted-tools.test.ts production-readiness.test.ts",
    "pnpm --filter @switchyard/protocol-rest typecheck",
    "pnpm --filter @switchyard/server typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "POST /runs/:id/input hosted admission",
      "failure": "Unauthenticated request, missing scope, tenant mismatch, run missing, terminal run, unsupported runtime, bridge quota exceeded, or store unavailable",
      "exception": "ControlPlaneError, ServiceError, AdapterProtocolError, or store error mapped by route",
      "rescue": "Return named HTTP error and record audit denial/error when auth context is known; do not call runService.sendInput for hosted real runs.",
      "user_sees": "401, 403, 404, 409, 429, or 503 with reasonCode and no provider side effect."
    },
    {
      "codepath": "GET /approvals/:id and list approvals",
      "failure": "Approval is unowned or owned by a different tenant/project",
      "exception": "ControlPlaneError authorization denial",
      "rescue": "Authorize ownership before scope classification and return approval_not_found or tenant_access_denied without revealing runtime/tool scope.",
      "user_sees": "404 approval_not_found or 403 tenant_mismatch."
    },
    {
      "codepath": "POST /approvals/:id/approve|reject",
      "failure": "Approval not pending, unsupported scope, duplicate resolution, bridge command creation failure, or tool service failure",
      "exception": "ServiceError, ControlPlaneError, or hosted tool error",
      "rescue": "Route tool scope to existing hosted tool service, route runtime scope to bridge service, and preserve approval_not_pending on races.",
      "user_sees": "409 approval_not_pending, hosted_runtime_approval_bridge_unshipped for unsupported runtime scope, or named bridge failure."
    },
    {
      "codepath": "server /ready bridge checks",
      "failure": "Bridge enabled without API key auth, command store, outbox, quota, audit, approval ownership, or worker readiness",
      "exception": "Readiness probe returns failed check",
      "rescue": "Return 503 with low-cardinality diagnostics and no secret values.",
      "user_sees": "Ready endpoint reports named failing dependency."
    }
  ],
  "observability": {
    "logs": [
      "info hosted.runtime_bridge.route.admit { runId, runtimeMode, operation, decision, reasonCode, requestId, redacted:true }",
      "warn hosted.runtime_bridge.route.denied { runtimeMode, operation, reasonCode, requestId }",
      "info hosted.runtime_approval.route.resolve { approvalId, runId, runtimeMode, decision, commandId }"
    ],
    "success_metric": "Server metrics count bridge admission allow/deny/error by runtimeMode, operation, decision, and reasonCode.",
    "failure_metric": "Readiness dependency failures count by named bridge dependency and route denials count by reasonCode."
  },
  "test_cases": [
    {
      "name": "admits hosted Claude input",
      "lens": "happy",
      "given": "Owned active hosted claude_code.sdk run with body { text:'continue' }",
      "expect": "202 { accepted:true } and bridge service createInputCommand called once."
    },
    {
      "name": "rejects nil input body",
      "lens": "happy_shadow_nil",
      "given": "POST /runs/:id/input with missing or array body",
      "expect": "400 invalid_input and no bridge command."
    },
    {
      "name": "rejects empty input text",
      "lens": "happy_shadow_empty",
      "given": "POST /runs/:id/input with { text:'   ' }",
      "expect": "409 adapter_protocol_failed with runtime_input_empty and no command."
    },
    {
      "name": "rejects terminal hosted run",
      "lens": "error_path",
      "given": "Completed hosted claude_code.sdk run",
      "expect": "409 adapter_protocol_failed with runtime_input_not_active."
    },
    {
      "name": "codex exec json remains unsupported",
      "lens": "error_path",
      "given": "Active hosted codex.exec_json fixture receives input",
      "expect": "409 with codex_exec_json_input_unsupported or hosted_input_bridge_unsupported and no command."
    },
    {
      "name": "approval ownership before classification",
      "lens": "integration",
      "given": "Cross-tenant runtime approval id",
      "expect": "Route denies before revealing runtime approval scope."
    },
    {
      "name": "runtime approval approve creates bridge command once",
      "lens": "integration",
      "given": "Two concurrent approve requests for the same owned pending runtime approval",
      "expect": "One approval transition, one command, second returns approval_not_pending or existing idempotent result."
    },
    {
      "name": "server has no real provider adapters",
      "lens": "error_path",
      "given": "Source/test inspection of createServerApp adapter map",
      "expect": "Only FakeRuntimeAdapter is constructed in server app."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "RunRouteDependencies.hostedRuntimeBridge",
        "kind": "interface",
        "signature": "Pick<HostedRuntimeBridgeService, 'createInputCommand'>"
      },
      {
        "name": "HostedToolRouteDependencies.hostedRuntimeBridge",
        "kind": "interface",
        "signature": "Pick<HostedRuntimeBridgeService, 'resolveRuntimeApproval'>"
      },
      {
        "name": "Server bridge readiness diagnostics",
        "kind": "constant",
        "signature": "Ready checks for command store/outbox, approval ownership, quota, audit, route auth, and worker readiness"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P22-T2-storage-core-bridge",
        "name": "HostedRuntimeBridgeService",
        "signature": "createInputCommand(input) and resolveRuntimeApproval(input)"
      },
      {
        "from_task": "P22-T1-contracts-openapi",
        "name": "HostedRuntimeBridgeCommand",
        "signature": "Durable command record type and accepted response extension"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/protocol-rest/src/run-routes.ts",
      "packages/protocol-rest/src/hosted-tool-routes.ts",
      "apps/server/src/app.ts",
      "apps/server/src/readiness.ts"
    ]
  }
}
```

### Task P22-T4-worker-bridge-orchestration

```json
{
  "id": "P22-T4-worker-bridge-orchestration",
  "title": "Wire worker bridge claiming, approvals, and reconciliation",
  "files": [
    "apps/worker/src/worker.ts",
    "apps/worker/src/hosted-runtime-adapters.ts",
    "apps/worker/src/ready.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts"
  ],
  "dependencies": [
    "P22-T2-storage-core-bridge",
    "P22-T5-claude-hosted-bridge",
    "P22-T7-opencode-hosted-bridge"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md",
    "apps/worker/src/worker.ts",
    "apps/worker/src/hosted-runtime-adapters.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "packages/core/src/services/hosted-worker-service.ts",
    "packages/core/src/services/runtime-runner-service.ts",
    "packages/core/src/services/approval-service.ts"
  ],
  "instructions": "Construct `PostgresHostedRuntimeBridgeCommandStore` and `HostedRuntimeBridgeService` in `createHostedWorker`, with dependency injection for tests. Pass a stable worker id into `RuntimeRunnerService` hosted session owner metadata. Add `runtimeApprovals` to the worker-owned runner so Claude and OpenCode approval events create approval records through the bridge service with ownership and audit before visibility. Add an approval resolution sender that applies worker-claimed bridge commands through `runner.sendInput`. Update `buildHostedWorkerAdapters` to pass `hostedBridgeEnabled: true` only for allowlisted hosted `claude_code.sdk` and `opencode.acp` adapters when bridge dependencies are available; do not add `codex.interactive`. In `tick`, run bridge reconciliation before new bridge claims, process bridge commands before normal run queue jobs or after tool jobs with deterministic ordering documented in tests, then process existing tool and run jobs. Claim readiness must fail closed when bridge support is enabled but command store, session reconciliation, approval sender, or adapter bridge capability is unavailable. Logs and metrics must use low-cardinality runtime mode, operation, decision, and reason labels only.",
  "acceptance": [
    "Worker constructs hosted bridge store/service and injects runtime approval create/terminalize dependencies into RuntimeRunnerService.",
    "Worker adapter factory enables hosted bridge capability only for claude_code.sdk and opencode.acp, never for codex.exec_json, codex.interactive, Generic HTTP, or AgentField.",
    "Worker claim loop can apply queued input and approval-resolution bridge commands to owned live sessions.",
    "Worker rejects commands for sessions it does not own or cannot safely reclaim.",
    "Worker startup reconciliation runs before new real-runtime bridge command claims.",
    "Fake Claude hosted input, approval request, approval approve, approval reject, and no-resume restart loss are covered.",
    "Fake ACP permission request hold/answer and follow-up prompt bridge are covered through worker tests.",
    "Hosted tool worker behavior from R22 continues to pass unchanged.",
    "Worker readiness reports bridge dependencies in full and claim modes.",
    "No worker construction path registers hosted codex.interactive."
  ],
  "checks": [
    "pnpm --filter @switchyard/worker test -- hosted-worker.test.ts production-worker-readiness.test.ts",
    "pnpm --filter @switchyard/worker typecheck",
    "pnpm --filter @switchyard/core test -- hosted-worker-service.test.ts hosted-runtime-bridge-service.test.ts",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "createHostedWorker bridge dependency construction",
      "failure": "Postgres, command store, control-plane store, approvals, or bridge service cannot be constructed",
      "exception": "ConfigError or store constructor error",
      "rescue": "Worker readiness reports hosted_runtime_bridge_store_unavailable or hosted_runtime_bridge_queue_unavailable and tick does not claim bridge commands.",
      "user_sees": "Worker ready endpoint returns not ready with named bridge dependency."
    },
    {
      "codepath": "worker tick bridge processing",
      "failure": "Claimed bridge command apply fails due to stale session, ownership mismatch, adapter rejection, or expired command",
      "exception": "AdapterProtocolError or ServiceError with reasonCode",
      "rescue": "Fail or expire command, append visible runtime event when needed, and continue processing later ticks.",
      "user_sees": "Run/approval shows named failure without duplicate provider input."
    },
    {
      "codepath": "runtimeApprovals.create in worker runner",
      "failure": "Runtime approval event lacks token or ownership attach fails",
      "exception": "AdapterProtocolError or ServiceError",
      "rescue": "Return failure to RuntimeRunnerService so run fails visibly rather than waiting forever.",
      "user_sees": "Run failed event with runtime_approval_token_missing, approval_ownership_attach_failed, or runtime_approval_bridge_unconfigured."
    },
    {
      "codepath": "worker restart reconciliation",
      "failure": "Waiting hosted session cannot be safely resumed",
      "exception": "Expected stale state detected without throw",
      "rescue": "Fail run with hosted_runtime_session_lost and terminalize approvals before claiming new bridge work.",
      "user_sees": "Run reaches failed status instead of remaining stuck."
    }
  ],
  "observability": {
    "logs": [
      "info worker.runtime_bridge.claim { commandId, runId, runtimeMode, operation }",
      "info worker.runtime_bridge.apply { commandId, runId, runtimeMode, operation, decision }",
      "warn worker.runtime_bridge.fail { commandId, runId, runtimeMode, operation, reasonCode }",
      "warn worker.runtime_bridge.reconcile { runId, runtimeMode, reasonCode }"
    ],
    "success_metric": "Worker bridge claimed/completed counters by runtimeMode and operation.",
    "failure_metric": "Worker bridge failed/expired/reconciled counters by reasonCode."
  },
  "test_cases": [
    {
      "name": "worker applies hosted Claude input",
      "lens": "happy",
      "given": "Queued bridge input command for active owned fake Claude hosted session",
      "expect": "Fake Claude state.sentUserMessages contains input, command completed, run resumes."
    },
    {
      "name": "worker handles no bridge command",
      "lens": "happy_shadow_empty",
      "given": "tick with no bridge commands, no tool jobs, and no run jobs",
      "expect": "tick returns false or proceeds to existing queue behavior without errors."
    },
    {
      "name": "worker rejects missing session command",
      "lens": "happy_shadow_nil",
      "given": "Bridge command references run with no session row",
      "expect": "Command fails with hosted_runtime_bridge_session_missing and adapter is not called."
    },
    {
      "name": "worker resolves hosted Claude approval",
      "lens": "integration",
      "given": "Fake Claude emits approval request, hosted approve route has queued resolution command",
      "expect": "Fake Claude state.resolvedApprovals records decision exactly once."
    },
    {
      "name": "worker answers ACP permission request",
      "lens": "integration",
      "given": "Fake ACP permission request and approved runtime approval resolution command",
      "expect": "Fake ACP stats.permissionResponses increments once and run continues according to fake response."
    },
    {
      "name": "worker ownership mismatch",
      "lens": "error_path",
      "given": "Bridge command claimed by worker B targets session state owned by worker A",
      "expect": "Command fails with hosted_runtime_bridge_session_not_owned and no adapter input."
    },
    {
      "name": "worker readiness missing approval sender",
      "lens": "error_path",
      "given": "Bridge enabled test config with approval sender omitted",
      "expect": "ready({mode:'claim'}) fails with hosted_runtime_bridge_queue_unavailable or runtime_approval_bridge_unconfigured diagnostic."
    },
    {
      "name": "hosted codex interactive not registered",
      "lens": "error_path",
      "given": "Source/test inspection of buildHostedWorkerAdapters",
      "expect": "No CodexInteractiveAdapter import or codex.interactive runtime mode registration."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "createHostedWorker bridge behavior",
        "kind": "function",
        "signature": "createHostedWorker(config, deps?) => { tick(): Promise<boolean>; ready(options?): Promise<WorkerReadinessReport>; stop(): Promise<void> } with bridge command processing before hosted run queue claims"
      },
      {
        "name": "Worker bridge readiness diagnostics",
        "kind": "constant",
        "signature": "Ready checks for command claim support, session reconciliation, adapter bridge capability, approval sender, and bridge queue/outbox availability"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P22-T2-storage-core-bridge",
        "name": "HostedRuntimeBridgeService",
        "signature": "claimAndApplyNext(input) and reconcileHostedRuntimeSessions(input)"
      },
      {
        "from_task": "P22-T5-claude-hosted-bridge",
        "name": "ClaudeCodeAdapterOptions.hostedBridgeEnabled",
        "signature": "boolean option allowing hosted input/approval only through worker bridge"
      },
      {
        "from_task": "P22-T7-opencode-hosted-bridge",
        "name": "OpenCodeAcpAdapterOptions.hostedBridgeEnabled",
        "signature": "boolean option allowing hosted ACP input/permission bridge only through worker bridge"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "apps/worker/src/worker.ts",
      "apps/worker/src/hosted-runtime-adapters.ts"
    ]
  }
}
```

### Task P22-T5-claude-hosted-bridge

```json
{
  "id": "P22-T5-claude-hosted-bridge",
  "title": "Enable hosted Claude input and approval bridge under worker control",
  "files": [
    "packages/adapters/src/claude-code/claude-code-adapter.ts",
    "packages/adapters/src/claude-code/types.ts",
    "packages/testkit/src/fake-claude-code-client.ts",
    "packages/adapters/test/claude-code-adapter.test.ts"
  ],
  "dependencies": [
    "P22-T1-contracts-openapi"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md",
    "packages/adapters/src/claude-code/claude-code-adapter.ts",
    "packages/adapters/src/claude-code/types.ts",
    "packages/adapters/src/claude-code/claude-code-event-mapper.ts",
    "packages/testkit/src/fake-claude-code-client.ts",
    "packages/adapters/test/claude-code-adapter.test.ts",
    "docs/development/adapters/CLAUDE_CODE.md"
  ],
  "instructions": "Add a `hostedBridgeEnabled?: boolean` option to Claude adapter/client options. In `send`, keep rejecting hosted provider sessions unless both `hostedProviderCommand` and `hostedBridgeEnabled` are present. When enabled, reuse the existing text input and `approval_resolution` paths; do not add a second hosted-specific payload shape. In `events`, stop converting hosted approval requests into immediate `run.failed` when bridge is enabled; instead track pending runtime approval tokens and yield the existing `approval.requested` event. Preserve hosted read-only permission mode and disabled tools policy from provider command configuration. Keep local Claude behavior unchanged. Extend fake Claude client scenarios to hold waiting input/approval deterministically and expose state for sent user messages and resolved approvals. Add tests that hosted bridge disabled still rejects, hosted bridge enabled accepts input, hosted approval request creates event instead of failure, approval resolution succeeds once, unknown token fails with runtime_approval_pause_not_active, terminal sessions reject input, and transcripts remain bounded/redacted.",
  "acceptance": [
    "Hosted Claude input remains unsupported unless hostedBridgeEnabled is true.",
    "Hosted Claude text input uses existing sendUserMessage path and records redacted input metadata only.",
    "Hosted Claude approval requests yield approval.requested instead of hosted_approval_bridge_unsupported when bridge is enabled.",
    "Hosted Claude approval approve and reject use existing resolveApproval path and delete pending tokens exactly once.",
    "Unknown or stale runtimeApprovalToken returns runtime_approval_pause_not_active.",
    "Unsupported payload shapes still return claude_input_unsupported.",
    "Local Claude adapter tests continue to pass unchanged.",
    "Hosted transcripts contain byte/redaction metadata and do not include raw secret-like input fields."
  ],
  "checks": [
    "pnpm --filter @switchyard/adapters test -- claude-code-adapter.test.ts claude-code-cli-client.test.ts claude-code-transcript-bounds.test.ts",
    "pnpm --filter @switchyard/testkit test -- fake-claude-code-client",
    "pnpm --filter @switchyard/adapters typecheck",
    "pnpm --filter @switchyard/testkit typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "ClaudeCodeAdapter.send",
      "failure": "Hosted session sends input without hostedBridgeEnabled",
      "exception": "AdapterProtocolError reasonCode hosted_input_bridge_unsupported",
      "rescue": "Reject before clientSession.sendUserMessage or resolveApproval.",
      "user_sees": "409 adapter_protocol_failed with hosted_input_bridge_unsupported."
    },
    {
      "codepath": "ClaudeCodeAdapter.send text",
      "failure": "Text is empty, session terminal, or client send fails",
      "exception": "AdapterProtocolError runtime_input_empty/runtime_input_not_active or client Error",
      "rescue": "Propagate named adapter error through bridge command failure; do not mark command completed.",
      "user_sees": "Named runtime input failure and no duplicate input."
    },
    {
      "codepath": "ClaudeCodeAdapter.send approval_resolution",
      "failure": "Missing, unknown, stale, or duplicate runtimeApprovalToken",
      "exception": "AdapterProtocolError reasonCode runtime_approval_pause_not_active",
      "rescue": "Reject resolution and keep command failed without calling provider resolveApproval.",
      "user_sees": "Approval resolution fails with runtime_approval_pause_not_active."
    },
    {
      "codepath": "ClaudeCodeAdapter.events approval.requested",
      "failure": "Provider approval event lacks token",
      "exception": "No throw from mapper; RuntimeRunnerService maps to runtime_approval_token_missing",
      "rescue": "Runner fails visibly; adapter does not invent a token.",
      "user_sees": "Run fails with runtime_approval_token_missing."
    }
  ],
  "observability": {
    "logs": [
      "info claude_code.input.accepted { runId }",
      "info claude_code.approval.resolved { runId, decision }",
      "warn claude_code.input.rejected { runId, reasonCode }"
    ],
    "success_metric": "Adapter emits existing logs without raw text and fake client state proves exactly-once sends/resolutions.",
    "failure_metric": "Hosted bridge disabled, stale token, and terminal input tests fail with named reason codes."
  },
  "test_cases": [
    {
      "name": "hosted bridge disabled rejects input",
      "lens": "error_path",
      "given": "ClaudeCodeAdapter with hostedProviderCommand and no hostedBridgeEnabled sends { text:'continue' }",
      "expect": "AdapterProtocolError hosted_input_bridge_unsupported and fake state.sentUserMessages is empty."
    },
    {
      "name": "hosted bridge enabled accepts input",
      "lens": "happy",
      "given": "ClaudeCodeAdapter with hostedProviderCommand and hostedBridgeEnabled sends { text:'continue' }",
      "expect": "fake state.sentUserMessages equals ['continue']."
    },
    {
      "name": "rejects empty text",
      "lens": "happy_shadow_empty",
      "given": "send({ text:'   ' })",
      "expect": "runtime_input_empty."
    },
    {
      "name": "approval request yields event",
      "lens": "integration",
      "given": "Fake Claude scenario with approvalToken and hostedBridgeEnabled true",
      "expect": "Events include approval.requested and do not include hosted_approval_bridge_unsupported."
    },
    {
      "name": "approval resolution succeeds once",
      "lens": "happy",
      "given": "send({ type:'approval_resolution', runtimeApprovalToken:'pause-1', decision:'approved' }) twice",
      "expect": "First resolves; second returns runtime_approval_pause_not_active."
    },
    {
      "name": "nil approval token rejected",
      "lens": "happy_shadow_nil",
      "given": "send({ type:'approval_resolution', decision:'approved' })",
      "expect": "runtime_approval_pause_not_active."
    },
    {
      "name": "unsupported payload rejected",
      "lens": "error_path",
      "given": "send({ foo:'bar' })",
      "expect": "claude_input_unsupported."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "ClaudeCodeAdapterOptions.hostedBridgeEnabled",
        "kind": "type",
        "signature": "hostedBridgeEnabled?: boolean"
      },
      {
        "name": "ClaudeCodeAdapter.send",
        "kind": "function",
        "signature": "send(session, { text: string } | { type:'approval_resolution'; runtimeApprovalToken:string; decision:'approved'|'rejected'; message?:string; answers?:Record<string, unknown> }) => Promise<void>"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P22-T1-contracts-openapi",
        "name": "R23 bridge reason codes",
        "signature": "hosted_input_bridge_unsupported, runtime_approval_pause_not_active, runtime_input_empty"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/adapters/src/claude-code/types.ts",
      "packages/adapters/src/claude-code/claude-code-adapter.ts"
    ]
  }
}
```

### Task P22-T6-acp-permission-protocol

```json
{
  "id": "P22-T6-acp-permission-protocol",
  "title": "Add ACP held permission request response support",
  "files": [
    "packages/protocol-acpx/src/acp-stdio-client.ts",
    "packages/protocol-acpx/src/acp-schemas.ts",
    "packages/protocol-acpx/test/acp-stdio-client.test.ts",
    "packages/protocol-acpx/test/protocol-framing.test.ts",
    "packages/testkit/src/fake-acp-runtime.ts",
    "packages/testkit/test/fake-acp-runtime.test.ts"
  ],
  "dependencies": [
    "P22-T1-contracts-openapi"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md",
    "packages/protocol-acpx/src/acp-stdio-client.ts",
    "packages/protocol-acpx/src/acp-schemas.ts",
    "packages/protocol-acpx/src/json-rpc.ts",
    "packages/protocol-acpx/test/acp-stdio-client.test.ts",
    "packages/testkit/src/fake-acp-runtime.ts",
    "packages/testkit/test/fake-acp-runtime.test.ts"
  ],
  "instructions": "Change `AcpStdioClient` so `session/request_permission` requests are surfaced as held permission events without automatically replying method-not-found. Unsupported request methods must still receive method-not-found immediately and emit `unsupported_request`. Add a bounded response API such as `respondToRequest(id, result)` and `rejectRequest(id, error)` or one equivalent method that writes exactly one JSON-RPC response to the original id, rejects duplicate/missing ids, and fails with named ACP protocol errors when the transport closed or the request expired. Add permission request schema helpers that validate non-empty id, method, session id when present, and bounded params. Extend fake ACP runtime so permission scenarios wait for a response and then complete/refuse according to the response, instead of always timing out/refusing. Keep request correlation for numeric and string ids distinct. Preserve transcript recording with redacted/bounded request and response entries.",
  "acceptance": [
    "session/request_permission is emitted as permission_request and no method-not-found response is written automatically.",
    "Unsupported ACP requests still receive method-not-found immediately.",
    "Held permission requests can be answered exactly once with a JSON-RPC result or error.",
    "Duplicate answer attempts fail with acp_permission_response_failed or an exact ACP protocol reason.",
    "Answering a missing or expired request fails with acp_permission_request_expired or acp_permission_response_failed.",
    "Transport close rejects all pending held permission requests.",
    "Fake ACP runtime records permissionResponses and can complete after approval.",
    "Transcript entries remain bounded and do not include raw secret-like payloads beyond existing transcript policy."
  ],
  "checks": [
    "pnpm --filter @switchyard/protocol-acpx test -- acp-stdio-client.test.ts protocol-framing.test.ts",
    "pnpm --filter @switchyard/testkit test -- fake-acp-runtime.test.ts",
    "pnpm --filter @switchyard/protocol-acpx typecheck",
    "pnpm --filter @switchyard/testkit typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "AcpStdioClient.handleMessage",
      "failure": "Unsupported JSON-RPC request method arrives",
      "exception": "No throw for expected unsupported request",
      "rescue": "Reply method-not-found immediately and emit unsupported_request.",
      "user_sees": "OpenCode continues with acp_client_method_unsupported status for unsupported agent callbacks."
    },
    {
      "codepath": "AcpStdioClient.respondToRequest",
      "failure": "Permission request id is missing, already answered, expired, or transport closed",
      "exception": "AcpProtocolError reasonCode acp_permission_response_failed or acp_permission_request_expired",
      "rescue": "Do not write a duplicate response; adapter maps the error to a named bridge failure.",
      "user_sees": "Run fails with acp_permission_response_failed or acp_permission_request_expired."
    },
    {
      "codepath": "AcpStdioClient permission hold map",
      "failure": "Held request exceeds TTL or process exits",
      "exception": "AcpProtocolError acp_transport_closed or acp_permission_request_expired",
      "rescue": "Reject pending waiter and remove hold from map.",
      "user_sees": "Approval is expired/rejected and run fails visibly."
    },
    {
      "codepath": "fake ACP runtime permission scenario",
      "failure": "Test runtime receives malformed permission response",
      "exception": "Parse failure in fake runtime",
      "rescue": "Record no permission response and produce deterministic refusal/error response for tests.",
      "user_sees": "No-spend test fails with named ACP reason."
    }
  ],
  "observability": {
    "logs": [
      "Protocol client itself keeps transcript records; adapter emits runtime logs.",
      "Tests assert transcript records contain message direction, byte length, and redaction metadata."
    ],
    "success_metric": "Fake ACP stats.permissionResponses increments once per approved/rejected held request.",
    "failure_metric": "Duplicate, missing, expired, and closed-transport response attempts reject with named ACP reasons."
  },
  "test_cases": [
    {
      "name": "holds permission request",
      "lens": "happy",
      "given": "ACP process sends session/request_permission id perm_1 during an in-flight prompt",
      "expect": "Client emits permission_request and outbound writes do not include method-not-found for perm_1."
    },
    {
      "name": "unsupported request still method-not-found",
      "lens": "error_path",
      "given": "ACP process sends unsupported method workspace/exec",
      "expect": "Outbound writes include JSON-RPC error -32601 and event unsupported_request."
    },
    {
      "name": "answers permission request once",
      "lens": "happy",
      "given": "respondToRequest('perm_1', { outcome:'approved' })",
      "expect": "One JSON-RPC response is written and fake stats.permissionResponses is 1."
    },
    {
      "name": "rejects duplicate response",
      "lens": "error_path",
      "given": "respondToRequest('perm_1', result) twice",
      "expect": "Second call rejects with acp_permission_response_failed."
    },
    {
      "name": "rejects nil request id response",
      "lens": "happy_shadow_nil",
      "given": "respondToRequest(undefined, result)",
      "expect": "AcpProtocolError acp_permission_response_failed."
    },
    {
      "name": "rejects empty request id response",
      "lens": "happy_shadow_empty",
      "given": "respondToRequest('', result)",
      "expect": "AcpProtocolError acp_permission_response_failed."
    },
    {
      "name": "transport close rejects held request",
      "lens": "error_path",
      "given": "Process exits before respondToRequest",
      "expect": "Held request removed and response attempt fails with acp_transport_closed or acp_permission_request_expired."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "AcpStdioClient.respondToRequest",
        "kind": "function",
        "signature": "(id: JsonRpcId, result: unknown) => Promise<void>"
      },
      {
        "name": "AcpStdioClient.rejectRequest",
        "kind": "function",
        "signature": "(id: JsonRpcId, error: { code: number; message: string; data?: unknown }) => Promise<void>"
      },
      {
        "name": "AcpClientEvent.permission_request",
        "kind": "type",
        "signature": "{ type:'permission_request'; message: JsonRpcRequestMessage } emitted without automatic method-not-found response"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P22-T1-contracts-openapi",
        "name": "R23 ACP reason codes",
        "signature": "acp_permission_request_invalid, acp_permission_response_failed, acp_permission_request_expired"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/protocol-acpx/src/acp-stdio-client.ts",
      "packages/protocol-acpx/src/acp-schemas.ts",
      "packages/testkit/src/fake-acp-runtime.ts"
    ]
  }
}
```

### Task P22-T7-opencode-hosted-bridge

```json
{
  "id": "P22-T7-opencode-hosted-bridge",
  "title": "Enable structured hosted OpenCode ACP bridge",
  "files": [
    "packages/adapters/src/opencode/opencode-acp-adapter.ts",
    "packages/adapters/src/opencode/types.ts",
    "packages/adapters/test/opencode-acp-adapter.test.ts"
  ],
  "dependencies": [
    "P22-T1-contracts-openapi",
    "P22-T6-acp-permission-protocol"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md",
    "packages/adapters/src/opencode/opencode-acp-adapter.ts",
    "packages/adapters/src/opencode/types.ts",
    "packages/adapters/src/opencode/opencode-event-mapper.ts",
    "packages/adapters/test/opencode-acp-adapter.test.ts",
    "packages/testkit/src/fake-acp-runtime.ts",
    "docs/development/adapters/OPENCODE.md"
  ],
  "instructions": "Add `hostedBridgeEnabled?: boolean` to `OpenCodeAcpAdapterOptions`. Keep local `opencode.acp` one-prompt-per-run behavior unchanged when the option is false. When hosted provider command and hosted bridge are enabled, maintain session state for `acpSessionId`, prompt active/ready state, and pending permission request id. In `events`, on `session/request_permission`, validate the request, store the pending id, yield `approval.requested` with `runtimeApprovalToken` set to the ACP request id and bounded provider action summary, mark the run/session waiting for approval, and keep the original JSON-RPC request open. Do not use PTY, terminal, keyboard, or alternate-screen behavior. In `send`, accept `{ text }` only when the session is ready for another structured `session/prompt`; reject concurrent input with `acp_prompt_in_flight` or `runtime_input_in_flight`; send follow-up as ACP `session/prompt` with prompt text blocks; update prompt active state through sessionStatePatch events. Accept `approval_resolution` only for the pending permission request id and answer the original JSON-RPC request through the protocol-acpx response API. On process exit, permission response failure, timeout, or lost request, fail visibly and allow core to terminalize pending approval. Keep hosted transcripts bounded/redacted and add explicit no-PTY source tests.",
  "acceptance": [
    "Hosted OpenCode permission request creates approval.requested instead of hosted_approval_bridge_unsupported when bridge is enabled.",
    "ACP permission approval answers the original JSON-RPC request exactly once.",
    "ACP permission rejection answers the original JSON-RPC request exactly once and run fails or continues according to fake response.",
    "Unsupported ACP requests still receive method-not-found and do not become approvals.",
    "Hosted OpenCode follow-up input sends structured session/prompt only when the session is ready.",
    "Concurrent prompt/input attempts fail with acp_prompt_in_flight or runtime_input_in_flight.",
    "Input with blank text returns runtime_input_empty or acp_session_not_ready_for_input before sending ACP.",
    "Pending permission loss maps to acp_permission_request_expired or acp_permission_response_failed.",
    "Local OpenCode behavior remains backward compatible when hostedBridgeEnabled is absent.",
    "Adapter source and tests contain no PTY, terminal proxy, keyboard driving, or screen scraping path."
  ],
  "checks": [
    "pnpm --filter @switchyard/adapters test -- opencode-acp-adapter.test.ts runtime-adapter-contracts.test.ts",
    "pnpm --filter @switchyard/adapters typecheck",
    "pnpm --filter @switchyard/protocol-acpx test",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "OpenCodeAcpAdapter.events permission_request",
      "failure": "Permission request id, method, params, session id, or action summary is missing or invalid",
      "exception": "AdapterProtocolError reasonCode acp_permission_request_invalid",
      "rescue": "Fail run visibly and cancel ACP session best-effort; do not create hidden approval.",
      "user_sees": "Run failed with acp_permission_request_invalid."
    },
    {
      "codepath": "OpenCodeAcpAdapter.send text",
      "failure": "Session terminal, prompt already active, session not ready, blank text, hosted bridge disabled, or ACP prompt request fails",
      "exception": "AdapterProtocolError acp_prompt_in_flight, acp_session_not_ready_for_input, runtime_input_empty, hosted_input_bridge_unsupported, or AcpProtocolError",
      "rescue": "Reject before writing duplicate prompt or fail command with named ACP reason.",
      "user_sees": "409 adapter_protocol_failed with named prompt/input reason."
    },
    {
      "codepath": "OpenCodeAcpAdapter.send approval_resolution",
      "failure": "Runtime approval token does not match pending ACP request, pending request expired, or response write fails",
      "exception": "AdapterProtocolError runtime_approval_pause_not_active or AcpProtocolError acp_permission_response_failed",
      "rescue": "Fail bridge command; do not write duplicate JSON-RPC response.",
      "user_sees": "Approval resolution fails with runtime_approval_pause_not_active or acp_permission_response_failed."
    },
    {
      "codepath": "OpenCodeAcpAdapter artifacts",
      "failure": "Transcript contains raw hosted provider command, env, prompt, object key, or secret-like ACP params",
      "exception": "Test assertion failure or redaction helper rejection",
      "rescue": "Use hosted-safe transcript summarization with direction, byte length, redacted marker, runtime mode, and ACP session id only.",
      "user_sees": "Artifacts are available without secret material."
    }
  ],
  "observability": {
    "logs": [
      "info opencode.acp.permission.requested { runId, acpSessionId, requestId }",
      "info opencode.acp.permission.resolved { runId, requestId, decision }",
      "info opencode.acp.prompt.accepted { runId, acpSessionId }",
      "warn opencode.acp.bridge.failed { runId, reasonCode }"
    ],
    "success_metric": "Adapter tests prove exactly-one ACP response and prompt counters for fake hosted scenarios.",
    "failure_metric": "Prompt conflict, stale permission request, malformed permission request, and unsupported request tests fail with named reason codes."
  },
  "test_cases": [
    {
      "name": "hosted permission request creates approval event",
      "lens": "happy",
      "given": "Fake ACP permission_request with hostedProviderCommand and hostedBridgeEnabled true",
      "expect": "Events include approval.requested with runtimeApprovalToken 'perm_1' and no hosted_approval_bridge_unsupported failure."
    },
    {
      "name": "approval resolution answers ACP request",
      "lens": "integration",
      "given": "send({ type:'approval_resolution', runtimeApprovalToken:'perm_1', decision:'approved' })",
      "expect": "Fake ACP stats.permissionResponses is 1 and command completes."
    },
    {
      "name": "rejects nil permission token",
      "lens": "happy_shadow_nil",
      "given": "send({ type:'approval_resolution', decision:'approved' })",
      "expect": "runtime_approval_pause_not_active."
    },
    {
      "name": "rejects blank prompt input",
      "lens": "happy_shadow_empty",
      "given": "send({ text:'   ' })",
      "expect": "runtime_input_empty and no ACP session/prompt write."
    },
    {
      "name": "follow-up prompt accepted only when ready",
      "lens": "happy",
      "given": "Completed initial prompt leaves session ready, then send({ text:'next' })",
      "expect": "Fake ACP stats.prompts increments for follow-up and events show running/output/terminal transition."
    },
    {
      "name": "concurrent prompt conflict",
      "lens": "error_path",
      "given": "send text while promptActive is true",
      "expect": "acp_prompt_in_flight or runtime_input_in_flight and no duplicate prompt."
    },
    {
      "name": "unsupported ACP request remains unsupported",
      "lens": "error_path",
      "given": "ACP process sends unsupported request method",
      "expect": "Method-not-found response and no approval.requested event."
    },
    {
      "name": "local opencode input remains unsupported",
      "lens": "error_path",
      "given": "OpenCodeAcpAdapter without hostedBridgeEnabled sends { text:'next' }",
      "expect": "opencode_input_unsupported or hosted_input_bridge_unsupported according to hostedProviderCommand."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "OpenCodeAcpAdapterOptions.hostedBridgeEnabled",
        "kind": "type",
        "signature": "hostedBridgeEnabled?: boolean"
      },
      {
        "name": "OpenCodeAcpAdapter.send",
        "kind": "function",
        "signature": "send(session, { text: string } | { type:'approval_resolution'; runtimeApprovalToken:string; decision:'approved'|'rejected'; message?:string; answers?:Record<string, unknown> }) => Promise<void>"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P22-T6-acp-permission-protocol",
        "name": "AcpStdioClient.respondToRequest",
        "signature": "(id: JsonRpcId, result: unknown) => Promise<void>"
      },
      {
        "from_task": "P22-T6-acp-permission-protocol",
        "name": "AcpStdioClient.rejectRequest",
        "signature": "(id: JsonRpcId, error: { code:number; message:string; data?:unknown }) => Promise<void>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/adapters/src/opencode/types.ts",
      "packages/adapters/src/opencode/opencode-acp-adapter.ts"
    ]
  }
}
```

### Task P22-T8-ops-docs-product-truth

```json
{
  "id": "P22-T8-ops-docs-product-truth",
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
  "dependencies": [
    "P22-T1-contracts-openapi",
    "P22-T3-rest-server-admission",
    "P22-T4-worker-bridge-orchestration",
    "P22-T5-claude-hosted-bridge",
    "P22-T7-opencode-hosted-bridge"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md",
    "PRODUCT.md",
    "docs/development/DEVELOPMENT.md",
    "scripts/production-preflight.ts",
    "scripts/production-canary.ts",
    "scripts/hosted-real-runtime-smoke.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts"
  ],
  "instructions": "Update hosted runtime catalog/capability truth so hosted `claude_code.sdk` advertises `run.input`, `session.state`, and `approval.bridge` only with bridge readiness diagnostics, hosted `opencode.acp` advertises structured ACP prompt/input/permission approval bridging only when bridge dependencies are present, `codex.exec_json` remains one-shot without input or approval bridge capabilities, and `codex.interactive` remains explicit local-only and absent from the hosted catalog. Add adapter boundary tests for codex.exec_json unsupported hosted input/approval, AgentField bridge unshipped, and Generic HTTP bridge unshipped. Extend production preflight, production canary, production manifest, and hosted real-runtime smoke with deterministic no-spend bridge checks using fake Claude and fake ACP only by default. Live provider bridge canaries must require explicit spend confirmation and must not run by default. Update product/development docs with exact shipped and unshipped R23 truth, including no terminal/PTY/TUI automation, no hosted Codex interactive, no AgentField/Generic HTTP bridges, no public arbitrary execution routes, no dashboard, no TUI, no hosted live resume guarantee, and no raw prompt/secret logging.",
  "acceptance": [
    "Hosted runtime catalog keeps hosted runtime slug union limited to fake.deterministic, codex.exec_json, claude_code.sdk, and opencode.acp.",
    "Hosted catalog and registry output do not include codex.interactive as a hosted mode.",
    "Hosted Claude and OpenCode capability/limitation text matches R23 bridge support and readiness dependencies.",
    "Hosted codex.exec_json capability/limitation text states one-shot input/approval unsupported.",
    "AgentField and Generic HTTP tests and docs state hosted runtime bridges remain unshipped pending durable callback contracts.",
    "Production preflight fails closed when bridge support is enabled without API-key auth, Postgres/control-plane ownership, durable command store/outbox, quota store, audit store, worker readiness, or provider activation gates.",
    "Default hosted bridge smoke/canary uses fake Claude and fake ACP with no live provider spend.",
    "Live provider bridge canary requires explicit spend confirmation and is skipped by default.",
    "PRODUCT.md and development docs state exactly what R23 shipped and what remains unshipped.",
    "Docs do not overclaim hosted Codex interactive, terminal bridge, session resume guarantees, dashboard/TUI, arbitrary execution, Generic HTTP/AgentField bridge support, browser automation, hosted debate real participants, or model judging."
  ],
  "checks": [
    "pnpm --filter @switchyard/core test -- hosted-runtime-catalog.test.ts registry-service.test.ts",
    "pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter.test.ts agentfield-async-rest-adapter.test.ts generic-http-adapter.test.ts",
    "pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts deploy/production/production-manifest.test.ts",
    "pnpm --filter @switchyard/contracts openapi:check:hosted",
    "pnpm typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "production preflight bridge checks",
      "failure": "Bridge support enabled without auth, control-plane ownership, command store, outbox, quota, audit, worker readiness, or provider gates",
      "exception": "Preflight returns failing check with named code",
      "rescue": "Fail closed before production traffic can route to bridge commands.",
      "user_sees": "Preflight output names missing bridge dependency."
    },
    {
      "codepath": "production canary bridge checks",
      "failure": "Live provider bridge canary requested without explicit spend confirmation",
      "exception": "Canary prerequisite failure",
      "rescue": "Skip live provider path and run only fake/no-spend bridge canary.",
      "user_sees": "Canary output states live bridge canary skipped unless explicitly confirmed."
    },
    {
      "codepath": "hosted runtime catalog",
      "failure": "Catalog accidentally includes codex.interactive or hosted capabilities for codex.exec_json, AgentField, or Generic HTTP",
      "exception": "Vitest assertion failure",
      "rescue": "Remove unsupported hosted catalog entry/capability and keep explicit limitation wording.",
      "user_sees": "Registry truth does not imply unsupported bridge support."
    },
    {
      "codepath": "product/development docs",
      "failure": "Docs overclaim terminal bridge, PTY/TUI automation, hosted Codex interactive, Generic HTTP/AgentField bridge support, or live resume",
      "exception": "Doc truth test or grep assertion failure",
      "rescue": "Replace with exact shipped/unshipped R23 wording.",
      "user_sees": "Product truth matches audited implementation boundary."
    }
  ],
  "observability": {
    "logs": [
      "preflight prints bridge dependency check names and redacted diagnostics",
      "canary prints fake bridge scenario names and live-provider skip reason",
      "smoke prints fake Claude/OpenCode bridge success/failure codes without raw prompts"
    ],
    "success_metric": "Default preflight/canary/smoke complete without live provider spend and report R23 bridge checks.",
    "failure_metric": "Missing dependency or live-spend misconfiguration fails with named prerequisite code."
  },
  "test_cases": [
    {
      "name": "catalog excludes hosted codex interactive",
      "lens": "error_path",
      "given": "Object.keys(HOSTED_RUNTIME_CATALOG)",
      "expect": "Does not contain codex.interactive."
    },
    {
      "name": "codex exec json one-shot truth",
      "lens": "happy",
      "given": "Hosted codex.exec_json catalog entry",
      "expect": "No run.input, session.resume, or approval.bridge capability and limitation states one-shot unsupported bridge."
    },
    {
      "name": "AgentField bridge unshipped",
      "lens": "error_path",
      "given": "AgentField adapter send or hosted bridge fixture",
      "expect": "agentfield_input_unsupported or agentfield_bridge_unshipped with no approval callback contract."
    },
    {
      "name": "Generic HTTP bridge unshipped",
      "lens": "error_path",
      "given": "Generic HTTP adapter send or hosted bridge fixture",
      "expect": "generic_http_input_unsupported or generic_http_bridge_unshipped with no approval callback contract."
    },
    {
      "name": "preflight missing bridge store fails",
      "lens": "error_path",
      "given": "Production env enables runtime bridge without Postgres/command store",
      "expect": "production-preflight reports hosted_runtime_bridge_store_unavailable."
    },
    {
      "name": "default canary no-spend",
      "lens": "happy",
      "given": "production canary without live provider confirmation",
      "expect": "Fake bridge checks run and live provider bridge checks are skipped."
    },
    {
      "name": "docs product truth",
      "lens": "integration",
      "given": "PRODUCT.md and development docs after R23",
      "expect": "Docs contain shipped Claude/OpenCode bridge wording and unshipped Codex interactive, AgentField, Generic HTTP, terminal/PTX/TUI, dashboard, and arbitrary route wording."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "R23 product truth",
        "kind": "constant",
        "signature": "Docs/catalog/scripts describe hosted Claude and structured OpenCode bridge support plus explicit unsupported runtime boundaries."
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P22-T1-contracts-openapi",
        "name": "R23 bridge reason codes",
        "signature": "Closed HTTP reason code set"
      },
      {
        "from_task": "P22-T3-rest-server-admission",
        "name": "Server bridge readiness diagnostics",
        "signature": "Ready checks for command store/outbox, approval ownership, quota, audit, route auth, worker readiness"
      },
      {
        "from_task": "P22-T4-worker-bridge-orchestration",
        "name": "Worker bridge readiness diagnostics",
        "signature": "Ready checks for command claim support, session reconciliation, adapter bridge capability, approval sender"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "PRODUCT.md",
      "docs/development/DEVELOPMENT.md",
      "scripts/production-preflight.ts",
      "scripts/production-canary.ts",
      "scripts/hosted-real-runtime-smoke.ts"
    ]
  }
}
```

## Risks

- The phase is inherently large because the bridge spans public routes, durable state, worker-owned sessions, two adapter protocols, and ops truth. The plan avoids a public route expansion and keeps implementation work split by package ownership.
- Restart reconciliation for real provider sessions must remain conservative. If a deterministic resume path is not proven, workers must terminalize with `hosted_runtime_session_lost` instead of claiming resume support.
- Approval list/get must authorize ownership before classifying approval scope. This is a security-sensitive requirement and should be part of auditor focus.
- OpenCode ACP permission handling must answer JSON-RPC only; PTY/TUI/terminal code paths are out of scope and should be source-checked.

## Integration Points

- T1 provides the shared schema/error vocabulary consumed by every downstream task.
- T2 provides the durable command store and `HostedRuntimeBridgeService` consumed by T3 server routes and T4 worker orchestration.
- T3 wires the existing hosted input and approval routes to T2 without adding routes or server-owned providers.
- T4 wires worker command claim/apply to T2 and enables only the T5/T7 adapter bridge flags.
- T5 and T7 preserve local behavior unless T4 passes explicit hosted bridge enablement.
- T6 provides the held ACP permission response primitive consumed by T7.
- T8 validates and documents the final product/ops truth after T1-T7 behavior exists.

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

## Self-Review

- Spec coverage: every acceptance criterion maps to at least one task, with cross-cutting route absence and no-spend coverage in T1, T3, and T8.
- Placeholder scan: no deferred implementation placeholder is used in task instructions; unsupported runtime work is explicit fail-closed scope.
- Type consistency: T2 exports `HostedRuntimeBridgeService`; T3 and T4 import the same service signatures; T5/T7 expose matching `hostedBridgeEnabled` adapter options for T4.
- Ownership disjoint: no file appears in more than one task `files` list.
- Context files real: every task context file is an existing worktree path.
- Acceptance testable: each task has objective checks and test cases for happy, nil/empty, error, and integration paths.
- Dependency order sane: contracts first, core/storage second, routes/adapters/protocol in parallel where possible, worker after core/adapters, ops/product truth last.
- Checks runnable: commands use existing package scripts and Vitest file filters already used by prior phases.
- Error/rescue map present: every runtime task has named failures, rescue actions, and user-visible behavior.
- Observability present: runtime tasks define logs and low-cardinality metrics; pure contract task defines contract-test observability.
- Test cases enumerate acceptance and shadow paths.
- Integration contracts walk: every `imports_from_other_tasks` resolves to an export in a dependency task.
- Contract types match: service and adapter signatures align across T2, T3, T4, T5, T6, and T7.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error_rescue_map entry has a matching error or shadow test case.
- [x] Every integration_contracts import resolves to a real export elsewhere in the task graph.
- [x] Every context_files path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is present.
- [x] Complexity is L and was challenged; it is kept as one phase because the bridge must be coherent across existing endpoint, durable store, worker, adapter, and ops truth boundaries without introducing public surface area.
