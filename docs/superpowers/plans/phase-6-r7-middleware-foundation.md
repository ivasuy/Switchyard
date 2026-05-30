# Phase 6: R7 Middleware Foundation - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-6-r7-middleware-foundation.md`
**Spec commit:** `b43a6d3bc2c3076a379e3f28ac475b87bea9be91`
**Branch:** `agent/phase-6-r7-middleware-foundation`
**Worktree:** `.worktrees/native-roadmap-20260529/phase-6-r7-middleware-foundation`
**Plan target:** `docs/superpowers/plans/phase-6-r7-middleware-foundation.md`
**Complexity:** L

## Goal

Ship R7 as one bounded middleware foundation release. After this phase, Switchyard has durable local services and REST APIs for messages, memory, evidence, context building, approvals, policy-gated fake tools, and local inspection. R7 stays deterministic and local-only: no vector memory, debate engine, real browser/search/GitHub/fetch/repo/shell tools, runtime approval bridges, hosted workers, SDK/CLI/TUI/dashboard, or external delivery.

## Architecture

```text
REST middleware routes
  -> protocol-rest route modules
  -> core services
       MessageRouter
       MemoryService
       EvidenceService
       ContextBuilder
       ApprovalService
       ToolRouter + FakeEchoToolAdapter + local policy gate
  -> stores
       in-memory testkit stores
       SQLite stores/tables/indexes
  -> EventStore + EventBus for message/tool/approval events
```

Run context extension:

```text
POST /runs with context
  -> validate referenced memory/evidence/message ids
  -> ContextBuilder returns packet + rendered text
  -> run.task becomes rendered task
  -> run.metadata.originalTask keeps caller task
  -> run.metadata.contextPacket stores packet
  -> existing RunService/RuntimeRunner path continues unchanged
```

Policy/tool flow:

```text
POST /tools/invocations fake_echo
  -> LocalPolicyGate allow | approval_required | deny
  -> ToolRouter persists invocation
  -> safe: tool.call -> FakeEchoToolAdapter -> tool.result
  -> risky: approval.requested, queued invocation
  -> approve: approval.approved -> tool.call -> tool.result
  -> reject: approval.rejected -> denied tool.result
```

## Task Graph

### Task P6-T1-middleware-foundation

`id`: `P6-T1-middleware-foundation`
`title`: Ship durable local middleware services, REST APIs, fake tools, policy gates, and docs`

`files`:
- Modify: `packages/contracts/src/tool.ts`
- Modify: `packages/contracts/src/event.ts`
- Modify: `packages/contracts/src/error.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/core/src/ports/generic-stores.ts`
- Modify: `packages/core/src/ports/message-store.ts`
- Modify: `packages/core/src/ports/memory-store.ts`
- Modify: `packages/core/src/ports/evidence-store.ts`
- Modify: `packages/core/src/ports/approval-store.ts`
- Create: `packages/core/src/ports/tool-invocation-store.ts`
- Modify: `packages/core/src/ports/policy.ts`
- Modify: `packages/core/src/services/message-router.ts`
- Modify: `packages/core/src/services/memory-service.ts`
- Modify: `packages/core/src/services/evidence-service.ts`
- Modify: `packages/core/src/services/context-builder.ts`
- Modify: `packages/core/src/services/approval-service.ts`
- Modify: `packages/core/src/services/tool-router.ts`
- Create: `packages/core/src/services/local-policy-gate.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/middleware-services.test.ts`
- Modify: `packages/storage/src/sqlite/schema.ts`
- Modify: `packages/storage/src/sqlite/database.ts`
- Modify: `packages/storage/src/sqlite/message-store.ts`
- Modify: `packages/storage/src/sqlite/approval-store.ts`
- Create: `packages/storage/src/sqlite/memory-store.ts`
- Create: `packages/storage/src/sqlite/evidence-store.ts`
- Create: `packages/storage/src/sqlite/tool-invocation-store.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/test/storage-package.test.ts`
- Create: `packages/testkit/src/middleware-stores.ts`
- Create: `packages/testkit/src/fake-echo-tool-adapter.ts`
- Modify: `packages/testkit/src/index.ts`
- Create: `packages/protocol-rest/src/middleware-routes.ts`
- Modify: `packages/protocol-rest/src/http-errors.ts`
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Modify: `packages/protocol-rest/src/index.ts`
- Create: `packages/protocol-rest/test/middleware-routes.test.ts`
- Modify: `packages/protocol-rest/test/run-routes.test.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`
- Modify: `docs/development/API.md`
- Modify: `docs/development/DEVELOPMENT.md`
- Modify: `PRODUCT.md`
- Modify: `CHANGELOG.md`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-30-phase-6-r7-middleware-foundation.md`
- `PRODUCT.md`
- `PROJECT.md`
- `packages/contracts/src/message.ts`
- `packages/contracts/src/memory.ts`
- `packages/contracts/src/evidence.ts`
- `packages/contracts/src/approval.ts`
- `packages/contracts/src/tool.ts`
- `packages/contracts/src/context.ts`
- `packages/contracts/src/event.ts`
- `packages/contracts/src/error.ts`
- `packages/core/src/ports/generic-stores.ts`
- `packages/core/src/ports/message-store.ts`
- `packages/core/src/ports/memory-store.ts`
- `packages/core/src/ports/evidence-store.ts`
- `packages/core/src/ports/approval-store.ts`
- `packages/core/src/ports/tool-adapter.ts`
- `packages/core/src/ports/policy.ts`
- `packages/core/src/services/message-router.ts`
- `packages/core/src/services/memory-service.ts`
- `packages/core/src/services/evidence-service.ts`
- `packages/core/src/services/context-builder.ts`
- `packages/core/src/services/approval-service.ts`
- `packages/core/src/services/tool-router.ts`
- `packages/core/src/services/event-bus.ts`
- `packages/storage/src/sqlite/schema.ts`
- `packages/storage/src/sqlite/database.ts`
- `packages/storage/src/sqlite/message-store.ts`
- `packages/storage/src/sqlite/approval-store.ts`
- `packages/protocol-rest/src/run-routes.ts`
- `packages/protocol-rest/src/http-errors.ts`
- `apps/daemon/src/app.ts`

`instructions`: Implement the R7 vertical slice exactly as a local middleware foundation. Extend contracts for `fake_echo`, tool approval/error fields, approval lifecycle event types, and new HTTP error codes while keeping existing run, registry, artifact, SSE, runtime-mode, and adapter behavior backward compatible. Extend store ports with list/search filters and cursor support only where the spec requires it. Add durable SQLite tables, indexes, additive migrations, and stores for memory, evidence, and tool invocations; extend existing message and approval stores with list filters. Add in-memory middleware stores and a deterministic `FakeEchoToolAdapter` in testkit.

Replace the six not-implemented service shells with real services: `MessageRouter`, `MemoryService`, `EvidenceService`, `ContextBuilder`, `ApprovalService`, and `ToolRouter`. Services must validate run references, use generated ids/timestamps, emit/publish events where specified, redact secrets in policy traces/events/invocation records/approval payloads, and return deterministic packets/rendered text. `ContextBuilder` must not persist context packets. `ToolRouter` must execute only `fake_echo`; real tool types are denied before adapter execution with `tool_policy_denied`. Approval-required fake tool requests create queued invocations and pending approvals, then resume or deny exactly once when approval resolves.

Add protocol-rest middleware routes for messages, memory, evidence, context, approvals, and tools. All new errors use the existing error envelope. `POST /runs` must accept optional `context`; when absent, existing run behavior is unchanged. When present, it builds/render context, stores `metadata.originalTask` and `metadata.contextPacket`, and persists the rendered task. Wire daemon in-memory and SQLite stores/services/routes plus the fake echo tool. Update docs/product/changelog only after tests pass.

`acceptance`:
- Messages can be created/listed/read locally, validate destinations, persist to SQLite, and emit `message.sent`.
- Memory can be created/listed/read/searched by case-insensitive substring with SQLite persistence; REST rejects embeddings and does not imply vector behavior.
- Evidence can be created/listed/read with URL and safe relative path validation; R7 does not fetch content.
- Context can be built from explicit sections plus memory/evidence/message ids in deterministic order and returns packet plus rendered text.
- `POST /runs` with no context is unchanged; `POST /runs` with context persists rendered task, `metadata.originalTask`, and `metadata.contextPacket`, and prevents run creation on reference failures.
- Approval create/list/read/approve/reject works, emits lifecycle events, rejects non-pending resolution, and resumes/denies queued fake tool invocations.
- Tool invocation create/list/read works for safe fake echo, approval-required fake echo, approved resume, rejected denial, run policy denial, and real-tool policy denial.
- No real browser/search/GitHub/fetch/repo/shell execution exists in R7.
- SQLite reopen and pre-R7 migration tests prove new tables/indexes are additive and records persist.
- REST tests cover validation failures and every new not-found/conflict/policy-denied error code.
- Daemon smoke covers memory/evidence/message/context, run-with-context, fake echo safe path, approval-required path, approved resume, rejected denial, policy denial, and persistence.
- `PRODUCT.md`, `CHANGELOG.md`, `docs/development/API.md`, and `docs/development/DEVELOPMENT.md` describe the shipped R7 surface and non-goals.

`checks`:
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/core test -- middleware-services`
- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/protocol-rest test -- middleware-routes`
- `pnpm --filter @switchyard/protocol-rest test -- run-routes`
- `pnpm --filter @switchyard/daemon test -- smoke`
- `pnpm --filter @switchyard/core typecheck`
- `pnpm --filter @switchyard/storage typecheck`
- `pnpm --filter @switchyard/protocol-rest typecheck`
- `pnpm --filter @switchyard/daemon typecheck`
- `pnpm typecheck`
- `git diff --check`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| contract enum expansion | Existing exact-enum tests fail or new events are rejected | `fake_echo`, approval lifecycle event, or new error code absent | Update contracts and tests in same slice | New middleware records/events parse; old contracts still pass |
| SQLite migration | R6 databases fail to open or lose existing data | new tables/indexes not additive | Add `CREATE TABLE IF NOT EXISTS`, index DDL, and pre-R7 migration test | Existing local data survives R7 startup |
| list pagination | Middleware list endpoints repeat or skip rows | cursor only uses timestamp | Use createdAt plus id cursor, newest first | Stable `nextCursor` behavior |
| message routing | Message emits event on wrong run or accepts no destination | only channel/from/to partial body | Require toRunId or channel; choose event run id per spec | `message.sent` is inspectable on correct stream |
| memory API | REST implies vector memory | embedding accepted or search uses embedding | Reject REST embedding, use substring-only search | User sees `400 invalid_input` for embeddings |
| evidence API | Unsafe local path is stored | absolute, parent traversal, or Windows path | Validate relative safe paths before create | `400 invalid_input` |
| context builder | Unknown references create partial packets | missing memory/evidence/message id | Read all referenced ids first and fail with matching `*_not_found` | No partial context or run is created |
| run create context | Existing run behavior changes when context is absent | route always mutates task/metadata | Branch only when `context` exists | R0-R6 run tests remain green |
| approval resolution | Approval can be approved/rejected twice | stale pending check | Require pending status and update atomically enough for local stores | `409 approval_not_pending` |
| tool policy | Real tools execute or adapter is called before denial | shell/browser/fetch/etc. accepted | Deny real tool types before adapter dispatch | `403 tool_policy_denied`, no side effects |
| tool approval resume | Queued invocation resumes multiple times or not at all | approval linkage missing | Store `approvalId`, lookup queued invocation, transition once | One `tool.result` terminal state |
| secret redaction | policy trace or payload stores tokens | input includes token/apiKey/authorization/password/secret | Redact recursively before persistence/events | No secret in events/invocations/approvals/logs |
| route registration | `/tools/invocations/:id` shadows collection route | Fastify order conflict | Register collection and item routes unambiguously | GET/POST route tests pass |

`observability`:
- `logs`: service-level warnings for `message.route_failed`, `memory.persistence_failed`, `evidence.persistence_failed`, `context.build_failed`, `approval.lifecycle_failed`, and `tool.invoke_failed`; logs must include ids/reason codes only and no secrets.
- `success_metric`: daemon smoke can create middleware records, build context, run fake echo safely, gate fake echo through approval, and inspect records after SQLite reopen.
- `failure_metric`: validation, not-found, conflict, policy-denied, unsupported real tool, and persistence shadow paths fail with named envelopes and tests.

`test_cases`:
- `{ name: "message local route", lens: "happy", given: "valid content and toRunId or channel", expect: "delivered message, deliveredAt, message.sent event" }`
- `{ name: "message destination required", lens: "error_path", given: "content without toRunId or channel", expect: "400 invalid_input" }`
- `{ name: "memory substring search", lens: "happy", given: "mixed-case content and q with different case", expect: "matching memory newest first" }`
- `{ name: "memory embedding rejected by REST", lens: "error_path", given: "POST /memory with embedding", expect: "400 invalid_input path embedding" }`
- `{ name: "evidence safe path validation", lens: "edge_security", given: "absolute, parent traversal, or Windows path", expect: "400 invalid_input" }`
- `{ name: "context deterministic render", lens: "integration", given: "explicit sections plus memory/evidence/message ids", expect: "sections ordered explicit, memory, evidence, messages and stable rendered string" }`
- `{ name: "context missing reference", lens: "error_path", given: "unknown memory/evidence/message id", expect: "matching *_not_found and no run created" }`
- `{ name: "run create without context unchanged", lens: "happy_shadow_nil", given: "existing fake run body", expect: "same run.task/metadata shape as R6" }`
- `{ name: "run create with context", lens: "integration", given: "fake run with memory/evidence context", expect: "rendered task, originalTask, contextPacket metadata, normal completion" }`
- `{ name: "approval lifecycle", lens: "happy", given: "pending approval", expect: "approve/reject updates status, resolvedAt, lifecycle event" }`
- `{ name: "approval not pending", lens: "error_path", given: "approve already approved approval", expect: "409 approval_not_pending" }`
- `{ name: "fake echo safe", lens: "happy", given: "fake_echo text hello", expect: "completed invocation with output.echo and tool.call/tool.result events" }`
- `{ name: "fake echo approval resume", lens: "integration", given: "requiresApproval true then approve", expect: "queued invocation, approval, resumed completed invocation" }`
- `{ name: "fake echo rejection denial", lens: "integration", given: "requiresApproval true then reject", expect: "invocation denied and denied tool.result" }`
- `{ name: "real tool denied", lens: "error_path", given: "type shell/github/browser/fetch/repo/web_search", expect: "403 tool_policy_denied and no adapter execution" }`
- `{ name: "secret redaction", lens: "edge_security", given: "token/apiKey/password/authorization in input/payload", expect: "stored events/invocation/approval/policy traces do not contain secret values" }`
- `{ name: "sqlite reopen persistence", lens: "integration", given: "records created then storage reopened", expect: "message/memory/evidence/approval/tool records remain inspectable" }`
- `{ name: "pre-r7 migration", lens: "integration", given: "R6 sqlite schema with run/session/runtime data", expect: "new tables/indexes created and old data preserved" }`

`integration_contracts`:
- `exports`:
  - `{ name: "MessageRouter", kind: "class", signature: "new MessageRouter({ messages, runs, events, eventBus?, logger? })" }`
  - `{ name: "MemoryService", kind: "class", signature: "new MemoryService({ memory, logger? })" }`
  - `{ name: "EvidenceService", kind: "class", signature: "new EvidenceService({ evidence, logger? })" }`
  - `{ name: "ContextBuilder", kind: "class", signature: "new ContextBuilder({ memory, evidence, messages, logger? })" }`
  - `{ name: "ApprovalService", kind: "class", signature: "new ApprovalService({ approvals, runs, events, eventBus?, toolRouter?, logger? })" }`
  - `{ name: "ToolRouter", kind: "class", signature: "new ToolRouter({ invocations, approvals, runs, events, eventBus?, adapters, policy, logger? })" }`
  - `{ name: "LocalPolicyGate", kind: "class", signature: "decideTool(input) => allow | approval_required | deny with policyTrace" }`
  - `{ name: "FakeEchoToolAdapter", kind: "class", signature: "invoke({ text }) => { echo: string }" }`
  - `{ name: "registerMiddlewareRoutes", kind: "function", signature: "(app, deps) => void" }`
  - `{ name: "SqliteMemoryStore", kind: "class", signature: "create/get/update/list/search" }`
  - `{ name: "SqliteEvidenceStore", kind: "class", signature: "create/get/update/list" }`
  - `{ name: "SqliteToolInvocationStore", kind: "class", signature: "create/get/update/list/listByApproval" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/core/src/services/context-builder.ts`
  - `packages/core/src/services/tool-router.ts`
  - `packages/protocol-rest/src/middleware-routes.ts`
  - `apps/daemon/src/app.ts`

## Internal Slice Order

1. Contracts and error/event enums.
2. Storage schema/migrations/stores plus in-memory testkit stores.
3. Core services and fake echo tool/policy gate.
4. REST middleware routes and run-context extension.
5. Daemon wiring and smoke tests.
6. Product/development docs and changelog after checks pass.

## Deferred Concerns

- First-class persisted context packets are deferred.
- Vector memory and embedding search are deferred.
- Real tool adapters and runtime-specific approval bridges are deferred.
- Debate orchestration is deferred to R9.
