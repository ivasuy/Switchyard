# Phase 6: R7 Middleware Foundation - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-6-r7-middleware-foundation.md`
**Spec commit:** `b43a6d3`
**Branch:** `agent/phase-6-r7-middleware-foundation`
**Worktree:** `.worktrees/native-roadmap-20260529/phase-6-r7-middleware-foundation`
**Task branch:** `agent/phase-6-r7-middleware-foundation--task-P6-T1-middleware-foundation`
**Task worktree:** `.worktrees/native-roadmap-20260529/P6-T1-middleware-foundation`
**Complexity:** L

## Goal

Ship the local R7 middleware foundation: durable and inspectable messages, memory, evidence, approvals, tool invocations, deterministic context packets, optional run context rendering, a policy-gated `fake_echo` tool, REST endpoints, SQLite/in-memory persistence, daemon wiring, and local smoke docs.

## Scope Challenge

1. Existing code already provides the right seams: public Zod contracts, `encodeCursor`/`decodeCursor`, run/event stores, SQLite message and approval tables, service shells, Fastify route/error helpers, daemon store composition, and in-memory test stores. R7 must extend those seams instead of creating parallel schemas, a second event bus, a second run launcher, or a new policy package.
2. Minimum viable R7 is one vertical local slice. It needs contract enum additions, core services, store ports and implementations, REST routes, daemon composition, tests, and docs. It does not need vector memory, real tools, debate orchestration, hosted workers, SDK, CLI, TUI, dashboard, or runtime-specific approval bridges.
3. Complexity is above normal CTO granularity because this phase touches more than 8 files. The user explicitly requested one implementer/reviewer for the phase, so this plan keeps one task and uses internal implementation slices plus exact checks to control risk.
4. Built-ins and existing utilities to use: Zod for validation, Fastify route registration, the existing error envelope helpers, Drizzle/better-sqlite3 patterns, `crypto.randomUUID()`, Node `URL`, Node path parsing for evidence path checks, and the existing `EventStore`/`EventBus`.
5. Distribution check: no new package, binary, container, or publish path is introduced. Existing workspace package exports and package scripts cover the release.

## Architecture

R7 stays in existing package boundaries. `packages/contracts` owns schema vocabulary. `packages/core` owns protocol-neutral services, policy decisions, redaction, and fake echo execution. `packages/storage` owns SQLite schema, migrations, indexes, and durable stores. `packages/testkit` mirrors stores for deterministic tests. `packages/protocol-rest` owns route groups and error envelopes. `apps/daemon` composes stores, services, fake tool adapter, routes, and the existing run lifecycle.

```text
POST /memory   POST /evidence   POST /messages
      |              |               |
      v              v               v
  MemoryStore   EvidenceStore   MessageStore
      |              |               |
      +--------------+---------------+
                     |
                     v
              POST /context
                     |
                     v
       ContextPacket + rendered context text
                     |
                     v
          optional POST /runs.context
```

```text
POST /tools/invocations
  -> ToolRouter policy gate
     -> allow: fake_echo runs, invocation completed, tool.call/tool.result emitted
     -> approval_required: invocation queued, approval pending, approval.requested emitted
     -> deny: invocation denied when valid enough, tool_policy_denied returned

POST /approvals/:id/approve
  -> approval.approved emitted
  -> queued fake_echo resumes
  -> tool.call/tool.result emitted

POST /approvals/:id/reject
  -> approval.rejected emitted
  -> queued invocation denied
  -> denied tool.result emitted
```

Middleware events associated with a run must use the next persisted sequence for that run. Runless channel messages can persist sequence `0` because run event replay will not expose them through `GET /runs/:id/events`.

## File Structure

- `packages/contracts/src/tool.ts` - add `fake_echo`, `approvalId`, and structured invocation errors.
- `packages/contracts/src/event.ts` - add approval resolution event types.
- `packages/contracts/src/http-error.ts` - extend the closed error code set.
- `packages/contracts/src/list-queries.ts` - add list/search query and response schemas for middleware endpoints.
- `packages/contracts/test/contracts.test.ts` - cover new schemas, enum values, and required-field negatives.
- `packages/core/src/ports/message-store.ts` - add message listing.
- `packages/core/src/ports/memory-store.ts` - define memory create/get/update/list/search.
- `packages/core/src/ports/evidence-store.ts` - define evidence create/get/update/list.
- `packages/core/src/ports/approval-store.ts` - add approval listing.
- `packages/core/src/ports/tool-invocation-store.ts` - add tool invocation create/get/update/list.
- `packages/core/src/ports/tool-adapter.ts` - keep the generic adapter port usable by fake echo.
- `packages/core/src/services/message-router.ts` - route, persist, list, get, and emit `message.sent`.
- `packages/core/src/services/memory-service.ts` - create/list/get/search plain memory.
- `packages/core/src/services/evidence-service.ts` - create/list/get evidence metadata with URL and path validation.
- `packages/core/src/services/context-builder.ts` - build deterministic packets and rendered context text.
- `packages/core/src/services/approval-service.ts` - create/list/get/approve/reject approvals and emit lifecycle events.
- `packages/core/src/services/tool-router.ts` - policy gate, invocation persistence, approval resume/reject, and redaction.
- `packages/core/src/services/fake-echo-tool-adapter.ts` - deterministic local `{ echo: input.text }` adapter.
- `packages/core/src/index.ts` - export new ports and services.
- `packages/core/test/middleware-services.test.ts` - core service behavior and shadow-path coverage.
- `packages/storage/src/sqlite/schema.ts` - add R7 tables and indexes.
- `packages/storage/src/sqlite/database.ts` - add fresh schema SQL and additive pre-R7 migration behavior.
- `packages/storage/src/sqlite/message-store.ts` - add list filters and cursor pagination.
- `packages/storage/src/sqlite/approval-store.ts` - add list filters and cursor pagination.
- `packages/storage/src/sqlite/memory-store.ts` - new durable memory store with substring search.
- `packages/storage/src/sqlite/evidence-store.ts` - new durable evidence store.
- `packages/storage/src/sqlite/tool-invocation-store.ts` - new durable tool invocation store.
- `packages/storage/src/index.ts` - export new SQLite stores.
- `packages/storage/test/sqlite-storage.test.ts` - persistence, list/search, and pre-R7 migration tests.
- `packages/testkit/src/fake-stores.ts` - add in-memory middleware stores.
- `packages/testkit/src/index.ts` - export updated test stores.
- `packages/protocol-rest/src/middleware-routes.ts` - route group for messages, memory, evidence, context, approvals, and tools.
- `packages/protocol-rest/src/run-routes.ts` - optional `context` support for `POST /runs`.
- `packages/protocol-rest/src/http-errors.ts` - map new error codes to HTTP status codes.
- `packages/protocol-rest/src/index.ts` - export middleware routes.
- `packages/protocol-rest/test/middleware-routes.test.ts` - endpoint contract and error tests.
- `packages/protocol-rest/test/run-routes.test.ts` - run context and omitted-context regression tests.
- `apps/daemon/src/app.ts` - wire stores, services, fake echo adapter, routes, and run context builder.
- `apps/daemon/test/smoke.test.ts` - local smoke and restart-persistence coverage.
- `docs/development/API.md` - document the R7 local API.
- `docs/development/DEVELOPMENT.md` - add model-spend-free middleware smoke commands.
- `PRODUCT.md` - mark R7 shipped during implementation closeout.
- `CHANGELOG.md` - add the dated R7 release entry during implementation closeout.

## Existing Context

- `docs/superpowers/specs/2026-05-30-phase-6-r7-middleware-foundation.md` - source of truth for R7 scope, API, storage, checks, docs, and non-goals.
- `PRODUCT.md` - current product truth still lists R7 as planned.
- `PROJECT.md` - prior phase history and branch/audit conventions.
- `packages/contracts/src/message.ts`, `context.ts`, `memory.ts`, `evidence.ts`, `approval.ts`, `tool.ts`, `event.ts`, `http-error.ts`, `list-queries.ts`, `cursor.ts`, `run.ts` - public contract anchors and cursor helpers.
- `packages/core/src/ports/message-store.ts`, `memory-store.ts`, `evidence-store.ts`, `approval-store.ts`, `run-store.ts`, `event-store.ts`, `tool-adapter.ts`, `policy.ts` - current port boundaries.
- `packages/core/src/services/message-router.ts`, `context-builder.ts`, `memory-service.ts`, `evidence-service.ts`, `approval-service.ts`, `tool-router.ts`, `run-service.ts`, `event-bus.ts` - service shells and run/event patterns.
- `packages/storage/src/sqlite/schema.ts`, `database.ts`, `message-store.ts`, `approval-store.ts`, `run-store.ts`, `event-store.ts`, `index.ts` - SQLite style and existing persistence.
- `packages/testkit/src/fake-stores.ts` - in-memory store style used by route and daemon tests.
- `packages/protocol-rest/src/run-routes.ts`, `http-errors.ts`, `index.ts` - Fastify route and error envelope style.
- `apps/daemon/src/app.ts`, `apps/daemon/src/config.ts` - daemon composition and store creation.
- `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, `CHANGELOG.md` - docs surfaces to update after behavior ships.

## Task Graph

### Task P6-T1: Middleware Foundation

`id`: `P6-T1-middleware-foundation`
`title`: `Ship R7 middleware foundation end to end`
`branch`: `agent/phase-6-r7-middleware-foundation--task-P6-T1-middleware-foundation`
`worktree`: `.worktrees/native-roadmap-20260529/P6-T1-middleware-foundation`

`files`:
- Modify: `packages/contracts/src/tool.ts`
- Modify: `packages/contracts/src/event.ts`
- Modify: `packages/contracts/src/http-error.ts`
- Modify: `packages/contracts/src/list-queries.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/core/src/ports/message-store.ts`
- Modify: `packages/core/src/ports/memory-store.ts`
- Modify: `packages/core/src/ports/evidence-store.ts`
- Modify: `packages/core/src/ports/approval-store.ts`
- Create: `packages/core/src/ports/tool-invocation-store.ts`
- Modify: `packages/core/src/ports/tool-adapter.ts`
- Modify: `packages/core/src/services/message-router.ts`
- Modify: `packages/core/src/services/memory-service.ts`
- Modify: `packages/core/src/services/evidence-service.ts`
- Modify: `packages/core/src/services/context-builder.ts`
- Modify: `packages/core/src/services/approval-service.ts`
- Modify: `packages/core/src/services/tool-router.ts`
- Create: `packages/core/src/services/fake-echo-tool-adapter.ts`
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
- Modify: `packages/storage/test/sqlite-storage.test.ts`
- Modify: `packages/testkit/src/fake-stores.ts`
- Modify: `packages/testkit/src/index.ts`
- Create: `packages/protocol-rest/src/middleware-routes.ts`
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Modify: `packages/protocol-rest/src/http-errors.ts`
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
- `packages/contracts/src/tool.ts`
- `packages/contracts/src/event.ts`
- `packages/contracts/src/http-error.ts`
- `packages/contracts/src/list-queries.ts`
- `packages/contracts/src/cursor.ts`
- `packages/contracts/src/run.ts`
- `packages/core/src/ports/run-store.ts`
- `packages/core/src/ports/event-store.ts`
- `packages/core/src/ports/message-store.ts`
- `packages/core/src/ports/memory-store.ts`
- `packages/core/src/ports/evidence-store.ts`
- `packages/core/src/ports/approval-store.ts`
- `packages/core/src/ports/tool-adapter.ts`
- `packages/core/src/services/message-router.ts`
- `packages/core/src/services/context-builder.ts`
- `packages/core/src/services/approval-service.ts`
- `packages/core/src/services/tool-router.ts`
- `packages/core/src/services/run-service.ts`
- `packages/core/src/services/event-bus.ts`
- `packages/storage/src/sqlite/schema.ts`
- `packages/storage/src/sqlite/database.ts`
- `packages/storage/src/sqlite/message-store.ts`
- `packages/storage/src/sqlite/approval-store.ts`
- `packages/storage/src/sqlite/run-store.ts`
- `packages/storage/src/sqlite/event-store.ts`
- `packages/testkit/src/fake-stores.ts`
- `packages/protocol-rest/src/run-routes.ts`
- `packages/protocol-rest/src/http-errors.ts`
- `apps/daemon/src/app.ts`
- `docs/development/API.md`
- `docs/development/DEVELOPMENT.md`

`instructions`: Implement in the internal slices below. Commit only after all checks pass. Keep all behavior local and deterministic. Do not make network calls from middleware services or fake tools. Do not create `packages/policy`. Do not expose shell, browser, search, GitHub, fetch, repo, process, or PTY execution. Do not change existing run behavior when `context` is omitted.

Slice 1, contracts:
- Add `fake_echo` to `toolTypeSchema`.
- Add optional `approvalId` and optional `error: { code: string; message: string }` to `toolInvocationSchema`.
- Add `approval.approved`, `approval.rejected`, and `approval.expired` to `eventTypeSchema`.
- Add HTTP error codes `message_not_found`, `memory_not_found`, `evidence_not_found`, `approval_not_found`, `tool_invocation_not_found`, `approval_not_pending`, `approval_required`, `tool_policy_denied`, and `unsupported_tool`.
- Add list/search query and response schemas using `LIST_LIMIT_DEFAULT`, `LIST_LIMIT_MAX`, and opaque `before` cursors.
- Keep memory `embedding` optional in the lower-level contract, but route-level REST create must reject it.

Slice 2, core:
- Define store contracts for list/search with newest-first `{ createdAt, id }` cursors.
- Implement `MessageRouter.route/list/get`. Trim content, require `toRunId` or `channel`, default attachments to `[]`, validate supplied run ids, persist delivered messages with `deliveredAt`, and emit `message.sent`.
- Implement `MemoryService.create/list/get/search`. Search is case-insensitive substring only over `content`.
- Implement `EvidenceService.create/list/get`. Require URL for `url`, `search_result`, and `browser_capture`; validate URLs with `new URL`; reject absolute, Windows absolute, empty-segmented, and parent-traversing `fetchedContentPath`.
- Implement `ContextBuilder.build`. It does not persist packets. Section order is explicit sections, memory section, evidence section, messages section. Empty input yields `sections: []` and `rendered: ""`.
- Implement `ApprovalService.create/list/get/approve/reject`. Only `pending` approvals resolve; non-empty actor/reason merge into `payload.resolution`; lifecycle events are appended and published.
- Implement `ToolRouter.invoke/list/get/resumeApproved/rejectQueued`. Only `fake_echo` executes. Risky fake requests queue behind approvals. Known real tools are denied before execution. Unknown tool types are invalid input.
- Add a redaction helper for keys named `token`, `apiKey`, `authorization`, `password`, and `secret`; apply it before persistence, event emission, policy trace storage, and logging.

Slice 3, storage and testkit:
- Add `memory_items`, `evidence_items`, and `tool_invocations` tables and indexes exactly as the spec lists.
- Add indexes for existing `messages` and `approvals`.
- Extend `openSqliteStorage()` so fresh databases have all R7 tables and pre-R7/R6 databases migrate additively without losing existing run/session/runtime/artifact/registry/message/approval data.
- Implement SQLite stores using existing row mapping style. Optional null columns should return absent optional properties where existing message/approval stores do that.
- Extend in-memory stores with equivalent filters, cursor pagination, update behavior, and search behavior.

Slice 4, REST and run context:
- Add `registerMiddlewareRoutes(app, deps)` and export it.
- Add endpoints for messages, memory, evidence, context, approvals, and tool invocations as defined in the spec.
- Reuse `HttpProblem`, `sendHttpError`, and `zodIssuesToDetails`.
- Add status mappings for all new error codes.
- Preserve route specificity for `/tools/invocations` and `/tools/invocations/:id`.
- Extend `POST /runs` parsing with optional `context`. If absent, create input stays unchanged. If present, build run context, render it into the task, set `metadata.originalTask`, set `metadata.contextPacket`, and persist the rendered task as `run.task`. Context failures must prevent run creation.

Slice 5, daemon and docs:
- Wire SQLite and in-memory middleware stores in `createDaemonApp`.
- Construct services once, pass the daemon `EventBus`, register `FakeEchoToolAdapter`, register middleware routes, and pass context builder to run routes.
- Add daemon smoke tests for safe fake tool, approval-required fake tool, approved resume, rejected denial, context-on-run, real-tool denial, and restart persistence.
- Update `PRODUCT.md`, `CHANGELOG.md`, `docs/development/API.md`, and `docs/development/DEVELOPMENT.md` after behavior and checks pass.

`acceptance`:
- `POST /messages`, `GET /messages`, and `GET /messages/:id` work locally, persist delivered messages, support listing, and emit `message.sent`.
- `POST /memory`, `GET /memory`, `GET /memory/:id`, and `GET /memory/search?q=...` work with durable SQLite persistence, route-level embedding rejection, and no vector search behavior.
- `POST /evidence`, `GET /evidence`, and `GET /evidence/:id` work with durable SQLite persistence, URL requirements, title/snippet query, and safe relative path validation.
- `POST /context` builds deterministic non-persisted context packets from explicit sections plus memory/evidence/message ids.
- `POST /runs` accepts optional `context`, stores rendered task plus `metadata.originalTask` and `metadata.contextPacket`, and leaves omitted-context behavior unchanged.
- Approval create/list/get/approve/reject endpoints work and emit approval lifecycle events.
- Tool invocation create/list/get endpoints work for safe, approval-required, approved, rejected, and policy-denied fake tool paths.
- Real tool types `web_search`, `fetch`, `browser`, `repo`, `shell`, and `github` are denied before execution with `tool_policy_denied`.
- SQLite reopen tests prove message, memory, evidence, approval, and tool invocation persistence.
- Pre-R7 migration tests prove new tables/indexes are added without losing R6 data.
- REST tests cover validation failures and every named new not-found, conflict, policy-denied, approval-required, and unsupported-tool code path that the API exposes.
- Daemon smoke tests cover safe fake tool, approval-required fake tool, approved resume, rejected denial, context-on-run, real-tool denial, and local persistence.
- Product, changelog, API, and development docs describe the shipped R7 surface and local smoke commands.
- Existing fake/Codex/AgentField/Generic HTTP/OpenCode run behavior remains backward compatible.

`checks`:
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/core test -- middleware-services`
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/storage test -- sqlite-storage`
- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/protocol-rest test -- middleware-routes`
- `pnpm --filter @switchyard/protocol-rest test -- run-routes`
- `pnpm --filter @switchyard/protocol-rest test`
- `pnpm --filter @switchyard/daemon test -- smoke`
- `pnpm --filter @switchyard/daemon test`
- `pnpm typecheck`
- `git diff --check`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `POST /messages` | Missing body or non-object body | `HttpProblem invalid_input` | Reject before service call | `400 invalid_input` |
| `MessageRouter.route` | Empty content or no `toRunId`/`channel` | `HttpProblem invalid_input` | Reject before persistence | `400 invalid_input` |
| `MessageRouter.route` | Unknown supplied run id | not-found domain error | Do not create message or event | `404 run_not_found` |
| `MessageRouter.route` | Store or event append failure | SQLite/store error | Log `message.route_failed` | `500 internal_error` |
| `GET /messages` | Malformed cursor or limit over 200 | `HttpProblem invalid_query` | Reject before store call | `400 invalid_query` |
| `GET /messages/:id` | Unknown message id | not-found domain error | Return stable missing code | `404 message_not_found` |
| `POST /memory` | Missing body, empty content, invalid scope, or REST embedding | `HttpProblem invalid_input` | Reject before persistence | `400 invalid_input` |
| `MemoryService.search` | Missing or whitespace `q` | `HttpProblem invalid_query` | Reject before search | `400 invalid_query` |
| `MemoryStore.search` | No matches | none | Return empty page | `200` with empty array |
| `MemoryService` | Store failure | SQLite/store error | Log `memory.persistence_failed` | `500 internal_error` |
| `GET /memory/:id` | Unknown memory id | not-found domain error | Return stable missing code | `404 memory_not_found` |
| `POST /evidence` | Missing body, invalid enum, empty title | `HttpProblem invalid_input` | Reject before persistence | `400 invalid_input` |
| `EvidenceService.create` | URL source lacks valid URL | `HttpProblem invalid_input` | Validate with `new URL` | `400 invalid_input` |
| `EvidenceService.create` | Unsafe `fetchedContentPath` | `HttpProblem invalid_input` | Reject before persistence | `400 invalid_input` |
| `EvidenceService` | Store failure | SQLite/store error | Log `evidence.persistence_failed` | `500 internal_error` |
| `GET /evidence/:id` | Unknown evidence id | not-found domain error | Return stable missing code | `404 evidence_not_found` |
| `ContextBuilder.build` | Missing body or invalid target | `HttpProblem invalid_input` | Reject before reads | `400 invalid_input` |
| `ContextBuilder.build` | Empty arrays and no sections | none | Return empty packet and rendered empty string | `200` with empty context |
| `ContextBuilder.build` | Unknown memory/evidence/message id | typed not-found error | Stop build | matching `404 *_not_found` |
| `POST /runs` with context | Reference failure | typed not-found error | Return before `RunService.createRun` | `404` and no run record |
| `POST /runs` without context | Context absent | none | Use existing path unchanged | Existing run behavior |
| `ApprovalService.create` | Missing body, invalid type, missing payload, unknown run | `HttpProblem` or run not found | Reject before persistence | `400 invalid_input` or `404 run_not_found` |
| `ApprovalService.resolve` | Unknown approval | not-found domain error | Do not mutate | `404 approval_not_found` |
| `ApprovalService.resolve` | Approval not pending | `HttpProblem approval_not_pending` | Do not mutate | `409 approval_not_pending` |
| `ApprovalService.resolve` | Empty actor or reason | none | Ignore empty fields | `200` resolved approval |
| `ToolRouter.invoke` | Missing body or unknown tool type | `HttpProblem invalid_input` | Reject before adapter call | `400 invalid_input` |
| `ToolRouter.invoke fake_echo` | Missing `input.text` | `HttpProblem invalid_input` | Reject before execution | `400 invalid_input` |
| `ToolRouter.invoke fake_echo` | Empty string text | none | Echo empty string | `201` completed invocation |
| `ToolRouter.policy` | Known real tool requested | `HttpProblem tool_policy_denied` | Persist denied invocation when valid enough; never execute | `403 tool_policy_denied` |
| `ToolRouter.policy` | Approval policy denies risky fake request | `HttpProblem tool_policy_denied` | Persist denied invocation with trace | `403 tool_policy_denied` |
| `ToolRouter.policy` | Risky fake request needs approval | none | Queue invocation and create approval | `202` with approval |
| `ToolRouter.resumeApproved` | No queued invocation linked | none | Return `invocation: null` | `200` approval response |
| `ToolRouter.resumeApproved` | Fake adapter throws | adapter error | Mark invocation failed and emit failed result | `200` with failed invocation |
| `ToolRouter.rejectQueued` | Queued invocation linked to rejected approval | none | Mark denied and emit denied result | `200` with denied invocation |
| Redaction helper | Secret-bearing keys in nested payloads | none | Recursively redact before persistence/event/logging | Records contain `[REDACTED]` |
| SQLite migration | R6 database lacks R7 tables/indexes | SQLite missing object | Use `CREATE TABLE/INDEX IF NOT EXISTS` | Existing daemon starts |
| SQLite row decode | Stored JSON malformed | `SyntaxError` | Log record id and return envelope | `500 internal_error` |

`observability`:
- `logs`: `message.route_succeeded`, `message.route_failed`, `memory.created`, `memory.persistence_failed`, `evidence.created`, `evidence.persistence_failed`, `context.built`, `context.build_failed`, `approval.requested`, `approval.resolved`, `tool.policy_decided`, `tool.invocation_completed`, and `tool.policy_denied`. Logs must include ids and reason codes, never raw secrets.
- `success_metric`: Full daemon smoke creates memory, evidence, message, context, run-with-context, safe fake tool invocation, approval-required invocation, approved resume, rejected denial, real-tool denial, and restart persistence with all checks passing.
- `failure_metric`: Any validation or persistence failure returns the unified envelope with a named machine code; logs include a redacted reason code.

`test_cases`:
- `{ "name": "contracts expose R7 vocabulary", "lens": "happy", "given": "toolInvocationSchema/eventSchema/httpErrorCodeSchema", "expect": "fake_echo, approvalId, error, approval.approved, approval.rejected, and new error codes parse" }`
- `{ "name": "route delivered message", "lens": "happy", "given": "POST /messages with existing toRunId", "expect": "201 delivered message and message.sent event" }`
- `{ "name": "route channel message", "lens": "happy", "given": "POST /messages with channel only", "expect": "201 and list by channel returns it" }`
- `{ "name": "message nil body", "lens": "happy_shadow_nil", "given": "POST /messages without object body", "expect": "400 invalid_input" }`
- `{ "name": "message empty content", "lens": "happy_shadow_empty", "given": "whitespace content", "expect": "400 invalid_input and no message stored" }`
- `{ "name": "message unknown run", "lens": "error_path", "given": "missing toRunId", "expect": "404 run_not_found" }`
- `{ "name": "message pagination and missing lookup", "lens": "integration", "given": "three messages and missing id", "expect": "cursor pages and 404 message_not_found" }`
- `{ "name": "create memory", "lens": "happy", "given": "POST /memory scope project", "expect": "201 generated memory" }`
- `{ "name": "memory rejects embedding", "lens": "error_path", "given": "REST create includes embedding", "expect": "400 invalid_input path embedding" }`
- `{ "name": "memory empty content", "lens": "happy_shadow_empty", "given": "whitespace content", "expect": "400 invalid_input" }`
- `{ "name": "memory search substring", "lens": "happy", "given": "q=fake_echo", "expect": "case-insensitive content match" }`
- `{ "name": "memory search nil and empty result", "lens": "happy_shadow_nil", "given": "missing q and no-match q", "expect": "400 invalid_query, then 200 empty array" }`
- `{ "name": "memory missing lookup", "lens": "error_path", "given": "GET /memory/memory_missing", "expect": "404 memory_not_found" }`
- `{ "name": "create manual evidence", "lens": "happy", "given": "manual evidence payload", "expect": "201 and list by reliability finds it" }`
- `{ "name": "evidence URL rules", "lens": "error_path", "given": "url source without valid url", "expect": "400 invalid_input path url" }`
- `{ "name": "evidence path security", "lens": "edge_path_security", "given": "parent or absolute fetchedContentPath", "expect": "400 invalid_input" }`
- `{ "name": "evidence empty list and missing lookup", "lens": "happy_shadow_empty", "given": "q no match and missing id", "expect": "200 empty array and 404 evidence_not_found" }`
- `{ "name": "context deterministic packet", "lens": "happy", "given": "explicit section plus memory/evidence/message ids", "expect": "stable section order and rendered text" }`
- `{ "name": "context nil and empty", "lens": "happy_shadow_nil", "given": "missing body, then empty arrays", "expect": "400 invalid_input, then 200 empty rendered string" }`
- `{ "name": "context unknown reference", "lens": "error_path", "given": "missing memory id", "expect": "404 memory_not_found" }`
- `{ "name": "run create omitted context unchanged", "lens": "integration", "given": "current POST /runs body", "expect": "same task and metadata behavior" }`
- `{ "name": "run create with context", "lens": "integration", "given": "POST /runs with memoryIds/evidenceIds", "expect": "rendered task plus originalTask/contextPacket metadata" }`
- `{ "name": "run context failure", "lens": "error_path", "given": "missing reference", "expect": "404 and run count unchanged" }`
- `{ "name": "create approval", "lens": "happy", "given": "approvalType and payload", "expect": "201 pending and approval.requested event" }`
- `{ "name": "approval nil and empty payload", "lens": "happy_shadow_nil", "given": "missing body and payload {}", "expect": "400 invalid_input, then 201 pending" }`
- `{ "name": "approval approve/reject once", "lens": "happy", "given": "approve one, reject one", "expect": "resolvedAt set and lifecycle events emitted" }`
- `{ "name": "approval conflict and missing", "lens": "error_path", "given": "resolve twice and resolve missing", "expect": "409 approval_not_pending and 404 approval_not_found" }`
- `{ "name": "safe fake echo", "lens": "happy", "given": "fake_echo text hello", "expect": "201 completed with output.echo and tool.call/tool.result" }`
- `{ "name": "fake echo empty string", "lens": "happy_shadow_empty", "given": "text empty string", "expect": "201 completed with empty echo" }`
- `{ "name": "tool nil body and missing text", "lens": "happy_shadow_nil", "given": "missing body and missing input.text", "expect": "400 invalid_input" }`
- `{ "name": "fake echo requires approval", "lens": "happy", "given": "requiresApproval true", "expect": "202 queued invocation plus pending approval" }`
- `{ "name": "approve queued fake echo", "lens": "integration", "given": "approve linked approval", "expect": "invocation completed and tool events emitted" }`
- `{ "name": "reject queued fake echo", "lens": "integration", "given": "reject linked approval", "expect": "invocation denied with approval_rejected" }`
- `{ "name": "real tools denied", "lens": "error_path", "given": "shell/github/browser/fetch/web_search/repo", "expect": "403 tool_policy_denied and no execution" }`
- `{ "name": "unknown tool invalid", "lens": "error_path", "given": "unknown_tool", "expect": "400 invalid_input" }`
- `{ "name": "approval policy deny", "lens": "error_path", "given": "approvalPolicy deny and risky fake_echo", "expect": "403 tool_policy_denied with policyTrace" }`
- `{ "name": "tool missing lookup", "lens": "error_path", "given": "GET missing invocation", "expect": "404 tool_invocation_not_found" }`
- `{ "name": "secret redaction", "lens": "edge_security", "given": "payload keys token apiKey authorization password secret", "expect": "stored records/events/logs contain [REDACTED]" }`
- `{ "name": "SQLite reopen", "lens": "integration", "given": "records then reopen database", "expect": "message, memory, evidence, approval, and invocation persist" }`
- `{ "name": "pre-R7 migration", "lens": "integration", "given": "R6-shaped database", "expect": "R7 tables/indexes added and R6 data readable" }`
- `{ "name": "daemon middleware smoke", "lens": "integration", "given": "local storage daemon with unavailable Codex probe", "expect": "full no-spend flow and restart persistence" }`
- `{ "name": "docs shipped truth", "lens": "integration", "given": "R7 docs after implementation", "expect": "substring-only memory, no remote evidence fetch, fake_echo only, real tools denied, context persistence boundary documented" }`

`integration_contracts`:
- `exports`:
  - `{ "name": "MessageRouter", "kind": "class", "signature": "new MessageRouter({ messages, runs, events, eventBus?, logger? }).route(input) | list(filter) | get(id)" }`
  - `{ "name": "MemoryService", "kind": "class", "signature": "new MemoryService({ memory, logger? }).create(input) | list(filter) | search(filter) | get(id)" }`
  - `{ "name": "EvidenceService", "kind": "class", "signature": "new EvidenceService({ evidence, logger? }).create(input) | list(filter) | get(id)" }`
  - `{ "name": "ContextBuilder", "kind": "class", "signature": "new ContextBuilder({ memory, evidence, messages, logger? }).build(input) => Promise<{ context: ContextPacket; rendered: string }>" }`
  - `{ "name": "ApprovalService", "kind": "class", "signature": "new ApprovalService({ approvals, runs, events, eventBus?, logger? }).create(input) | list(filter) | get(id) | approve(id,input) | reject(id,input)" }`
  - `{ "name": "ToolRouter", "kind": "class", "signature": "new ToolRouter({ invocations, approvals, runs, events, eventBus?, adapters, logger? }).invoke(input) | list(filter) | get(id) | resumeApproved(approval) | rejectQueued(approval)" }`
  - `{ "name": "FakeEchoToolAdapter", "kind": "class", "signature": "new FakeEchoToolAdapter().invoke({ text: string }) => Promise<{ echo: string }>" }`
  - `{ "name": "registerMiddlewareRoutes", "kind": "function", "signature": "registerMiddlewareRoutes(app: FastifyInstance, deps: { messages: MessageRouter; memory: MemoryService; evidence: EvidenceService; context: ContextBuilder; approvals: ApprovalService; tools: ToolRouter }) => void" }`
  - `{ "name": "SqliteMemoryStore", "kind": "class", "signature": "new SqliteMemoryStore(db).create/get/update/list/search" }`
  - `{ "name": "SqliteEvidenceStore", "kind": "class", "signature": "new SqliteEvidenceStore(db).create/get/update/list" }`
  - `{ "name": "SqliteToolInvocationStore", "kind": "class", "signature": "new SqliteToolInvocationStore(db).create/get/update/list" }`
  - `{ "name": "InMemoryMemoryStore", "kind": "class", "signature": "new InMemoryMemoryStore().create/get/update/list/search" }`
  - `{ "name": "InMemoryEvidenceStore", "kind": "class", "signature": "new InMemoryEvidenceStore().create/get/update/list" }`
  - `{ "name": "InMemoryToolInvocationStore", "kind": "class", "signature": "new InMemoryToolInvocationStore().create/get/update/list" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/core/src/services/message-router.ts`
  - `packages/core/src/services/context-builder.ts`
  - `packages/core/src/services/approval-service.ts`
  - `packages/core/src/services/tool-router.ts`
  - `packages/protocol-rest/src/middleware-routes.ts`
  - `packages/protocol-rest/src/run-routes.ts`
  - `apps/daemon/src/app.ts`

## Integration Order

1. Contracts.
2. Core services and service tests.
3. SQLite and in-memory stores.
4. REST routes and optional run context.
5. Daemon wiring and daemon smoke.
6. Product/API/development docs.
7. Full package checks and `git diff --check`.

## Phase-Level Acceptance

- Contracts expose the R7 middleware records, event types, error codes, list responses, and query shapes without breaking current run, registry, artifact, SSE, or runtime-mode behavior.
- Core services implement happy, nil, empty, edge, and error behavior.
- SQLite and in-memory stores support create/get/update/list/search behavior where specified.
- REST routes expose messages, memory, evidence, context, approvals, and tools through unified error envelopes.
- Daemon wires all middleware stores/services/routes and the fake echo tool adapter.
- Local docs include copy-paste smoke commands for memory, evidence, messages, context, approvals, fake tools, real-tool denial, and restart persistence.

## Risks

- Single-task blast radius is high. Mitigation: internal slices and exact checks.
- Middleware event sequence allocation can collide with run events. Mitigation: compute next sequence from persisted run events when a run id exists.
- `POST /runs` context rendering touches a hot route. Mitigation: omitted-context regression tests.
- SQLite migrations must remain additive. Mitigation: explicit pre-R7 database fixture.
- Tool routing must not become real-tool execution. Mitigation: deny tests for every known real tool type.

## Non-Goals

- Vector memory, embeddings, vector indexes, semantic ranking, or vector similarity search.
- Debate rounds, participant orchestration, judge workflows, or consensus logic.
- Browser, web search, fetch, GitHub, repo mutation, shell, process, or PTY tool execution.
- Hosted workers, connected local nodes, Postgres, Redis, S3/R2, authentication, rate limiting, SDK, CLI, TUI, or dashboard surfaces.
- Runtime-specific approval bridges for Codex, OpenCode, AgentField, Generic HTTP, or future adapters.

## Self-Review Result

1. Spec coverage: PASS. Each spec acceptance criterion maps to `P6-T1-middleware-foundation`.
2. Placeholder scan: PASS. No placeholder language is intentionally present.
3. Type consistency: PASS. The single task owns all exports and imports.
4. Ownership disjoint: PASS. There is one task, so no ownership overlap.
5. Context files real: PASS. All listed paths were verified in this worktree.
6. Acceptance testable: PASS. Each acceptance item has endpoint, store, docs, or command evidence.
7. Dependency order sane: PASS. Single task has no cross-task dependencies; internal slice order is explicit.
8. Checks runnable: PASS. Commands use existing package scripts.
9. Error/rescue map present: PASS. Runtime and persistence codepaths have named rescue behavior.
10. Observability present: PASS. Logs, success metric, and failure metric are specified.
11. Test cases enumerate acceptance: PASS. Acceptance and shadow paths have corresponding test cases.
12. Integration contracts walk: PASS. There are no imports from other tasks; exports are defined in this task.
13. Contract types match: PASS. Signatures align with current package boundaries and R7 route needs.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error rescue map entry has a matching `error_path`, `happy_shadow_nil`, `happy_shadow_empty`, `edge_*`, or integration test case.
- [x] Every `integration_contracts.imports_from_other_tasks` resolves to a real export elsewhere; this task has no cross-task imports.
- [x] Every `context_files` path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is present.
- [x] Complexity is L and the single-task approach is retained only because the user explicitly requested one implementer/reviewer for this phase.
