# Phase 6 Spec: R7 Middleware Foundation

Date: 2026-05-30

Roadmap release: R7: Middleware Foundation

Branch: `agent/phase-6-r7-middleware-foundation`

Previous phase head: `agent/phase-5-r6-wrapper-runtime-integration`

Spec target: `docs/superpowers/specs/2026-05-30-phase-6-r7-middleware-foundation.md`

## Summary

R7 turns Switchyard's planned middleware nouns into local, durable, inspectable behavior. After this release, local clients can route messages, create/search basic memory, preserve evidence, build deterministic context packets, request and resolve approvals, and invoke a deterministic fake tool through policy and approval gates.

This release is intentionally a foundation release, not a debate or real-tool release. The goal is to give R8/R9 real services and stores to depend on, without adding browser/search/GitHub/shell execution, vector retrieval, hosted workers, or multi-agent debate orchestration.

## Scope Gate

In scope:

- Context builder service and optional run-create context rendering.
- Message router service plus local message inspection API.
- Memory v1 local SQLite store, in-memory test store, REST create/list/get/search API, and substring search.
- Evidence v1 local SQLite store, in-memory test store, REST create/list/get API, and context attachment support.
- Approval lifecycle service, local API, persisted approval records, and approval lifecycle events.
- Tool invocation service, persisted invocation records, deterministic fake echo tool adapter, and local inspection API.
- Policy gates for risky tool actions and unsupported real tools.
- Local persistence tests for message, memory, evidence, approval, and tool invocation stores.
- Daemon wiring and local development/API docs for middleware smoke behavior.

Out of scope:

- Vector memory, embedding generation, vector indexes, semantic ranking, or vector similarity search.
- Full debate engine, debate rounds, participant orchestration, judge workflows, or consensus logic.
- Real browser, web search, fetch, GitHub, repo mutation, shell, process, or PTY tool execution.
- Hosted workers, connected local nodes, Postgres, Redis, S3/R2, authentication, rate limiting, SDK, CLI, TUI, or dashboard work.
- Runtime-specific approval bridges for Codex, OpenCode, AgentField, Generic HTTP, or future adapters.
- External message delivery outside the local daemon.

## Existing Context

This spec is based on the code in this worktree on `agent/phase-6-r7-middleware-foundation`, not on target architecture diagrams alone.

`PRODUCT.md` defines R7 as the missing local middleware layer:

```md
### R7: Middleware Foundation

Status: planned.

Goal: build the missing internal layers that debate, research, tools, approvals, and memory need.
```

`PRODUCT.md` also pins the R7 release scope and non-goals:

```md
- context builder implementation.
- message router implementation.
- message API if needed for local inspection.
- memory v1 local store and API.
- evidence v1 local store and API.
- approval lifecycle API and events.
- tool invocation service and fake tool adapter.
- policy gates for risky actions.
```

`packages/contracts/src/message.ts` already defines the public routed message shape:

```ts
export const deliveryStatusSchema = z.enum(["queued", "delivered", "failed", "cancelled"]);

export const messageSchema = z.object({
  id: messageIdSchema,
  fromRunId: runIdSchema.optional(),
  toRunId: runIdSchema.optional(),
  channel: z.string().min(1).optional(),
  content: z.string().min(1),
  attachments: z.array(z.record(z.string(), z.unknown())).default([]),
  deliveryStatus: deliveryStatusSchema,
  createdAt: isoDateSchema,
  deliveredAt: isoDateSchema.optional()
});
```

`packages/contracts/src/context.ts` already defines context packets and sections:

```ts
export const contextSectionSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
  memoryIds: z.array(memoryIdSchema).default([]),
  evidenceIds: z.array(evidenceIdSchema).default([])
});

export const contextPacketSchema = z.object({
  id: contextPacketIdSchema,
  target: z.enum(["run", "debate", "participant", "tool"]),
  sections: z.array(contextSectionSchema),
  createdAt: isoDateSchema
});
```

`packages/contracts/src/memory.ts` has a memory object with an optional `embedding`; R7 must not turn that optional field into vector memory:

```ts
export const memoryScopeSchema = z.enum(["user", "project", "runtime", "provider_model", "debate", "participant", "swarm_channel"]);

export const memoryItemSchema = z.object({
  id: memoryIdSchema,
  scope: memoryScopeSchema,
  projectId: z.string().optional(),
  runId: runIdSchema.optional(),
  debateId: debateIdSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  content: z.string().min(1),
  metadata: metadataSchema.default({}),
  embedding: z.array(z.number()).optional(),
  createdAt: isoDateSchema
});
```

`packages/contracts/src/evidence.ts` already defines evidence source and reliability vocabulary:

```ts
export const evidenceSourceTypeSchema = z.enum(["url", "file", "search_result", "browser_capture", "repo", "artifact", "manual"]);
export const evidenceReliabilitySchema = z.enum(["primary", "secondary", "uncertain", "conflicting", "unknown"]);
```

`packages/contracts/src/approval.ts` already defines the approval lifecycle states and approval types:

```ts
export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export const approvalTypeSchema = z.enum(["before_commit", "before_push", "before_pr", "before_destructive_command", "before_external_web_action", "before_external_message", "before_spending_budget", "before_cross_runtime_delegation", "before_same_provider_model_delegation"]);
```

`packages/contracts/src/tool.ts` defines invocation state but does not yet include the fake tool type R7 needs for deterministic local smoke:

```ts
export const toolTypeSchema = z.enum(["web_search", "fetch", "browser", "repo", "shell", "github"]);
export const toolInvocationStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "denied"]);
```

`packages/contracts/src/event.ts` already has the event types R7 must use for messages, tools, and initial approval requests:

```ts
export const eventTypeSchema = z.enum([
  "tool.call",
  "tool.result",
  "message.sent",
  "approval.requested",
  "run.completed",
  "run.cancelled",
  "run.failed"
]);
```

`packages/core/src/services/message-router.ts`, `context-builder.ts`, `memory-service.ts`, `evidence-service.ts`, `approval-service.ts`, and `tool-router.ts` are currently service shells:

```ts
export class MessageRouter {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("message-router", method);
  }
}
```

`packages/core/src/ports/generic-stores.ts` is too narrow for R7 because middleware needs listing and search, not only create/get/update:

```ts
export interface GenericStore<T> {
  create(value: T): Promise<T>;
  get(id: string): Promise<T | undefined>;
  update(value: T): Promise<T>;
}
```

`packages/storage/src/sqlite/schema.ts` already has `messages` and `approvals`, but no memory, evidence, or tool invocation tables:

```ts
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  fromRunId: text("from_run_id"),
  toRunId: text("to_run_id"),
  channel: text("channel"),
  content: text("content").notNull(),
  attachmentsJson: text("attachments_json").notNull(),
  deliveryStatus: text("delivery_status").notNull(),
  createdAt: text("created_at").notNull(),
  deliveredAt: text("delivered_at")
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  approvalType: text("approval_type").notNull(),
  status: text("status").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at")
});
```

`docs/development/API.md` confirms middleware APIs are not implemented today and that every error response must use the same envelope:

```md
- Not implemented yet: trace endpoint, OpenAPI generation, debates, approvals expansion, memory, tools expansion, hosted workers, hosted/hybrid placement, dashboards, TUI, authentication, rate limiting, PTY, interactive Codex sessions, webhooks, per-run HTTP base URL overrides, and remote artifact URL fetching.
```

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

## Product Terms

Middleware record:

- A local, persisted object used by future debates/runtimes/tools: message, memory, evidence, approval, or tool invocation.
- Records are inspectable through REST and survive daemon restart when SQLite storage is configured.

Context packet:

- A deterministic, non-persisted packet assembled from explicit sections plus referenced memory, evidence, and messages.
- It is safe to embed in a run prompt or future debate prompt.

Memory v1:

- Plain local records with exact field persistence and case-insensitive substring search over `content`.
- The optional contract field `embedding` may be preserved by storage if supplied internally, but R7 does not generate embeddings, build vector indexes, or search by embedding.

Evidence v1:

- Local evidence metadata records. R7 does not fetch remote evidence content.
- `fetchedContentPath` is a pointer only; content retrieval remains artifact/content-store work.

Fake tool:

- A deterministic local tool named `fake_echo`.
- It echoes a string input and can be forced through policy/approval by request fields.
- It is the only tool that can execute in R7.

Policy gate:

- A local decision service that returns exactly one of `allow`, `approval_required`, or `deny`.
- It must produce a `policyTrace` array for every tool decision.

## Contract Changes

R7 must extend contracts only where the existing public schemas cannot express the local behavior.

Required contract additions:

- Add `fake_echo` to `toolTypeSchema`.
- Add optional `approvalId?: approvalIdSchema` to `toolInvocationSchema` so queued invocations can resume or deny after approval resolution.
- Add optional `error?: { code: string; message: string }` to `toolInvocationSchema` for denied/failed invocations.
- Add event types `approval.approved`, `approval.rejected`, and `approval.expired` to `eventTypeSchema`.
- Add HTTP error codes:
  - `message_not_found` -> 404.
  - `memory_not_found` -> 404.
  - `evidence_not_found` -> 404.
  - `approval_not_found` -> 404.
  - `tool_invocation_not_found` -> 404.
  - `approval_not_pending` -> 409.
  - `approval_required` -> 409.
  - `tool_policy_denied` -> 403.
  - `unsupported_tool` -> 409.

Contract constraints:

- Existing run, registry, artifact, SSE, and runtime-mode contracts must remain backward compatible.
- Existing endpoints must keep their current success bodies unless explicitly extended by this spec.
- Every new 4xx/5xx response must use the existing `{ error: { code, message, details? } }` envelope.

## Storage Contract

R7 storage must be durable in SQLite and mirrored by in-memory stores for tests.

Messages:

- Keep the existing `messages` table.
- Add indexes for `from_run_id`, `to_run_id`, `channel`, and `created_at DESC, id DESC`.
- Extend `MessageStore` with `list(filter)` supporting `runId`, `channel`, `deliveryStatus`, `limit`, and opaque cursor inputs.

Approvals:

- Keep the existing `approvals` table.
- Add indexes for `run_id`, `status`, `approval_type`, and `created_at DESC, id DESC`.
- Extend `ApprovalStore` with `list(filter)` supporting `runId`, `status`, `approvalType`, `limit`, and cursor inputs.

Memory:

- Add table `memory_items`:
  - `id TEXT PRIMARY KEY NOT NULL`
  - `scope TEXT NOT NULL`
  - `project_id TEXT`
  - `run_id TEXT`
  - `debate_id TEXT`
  - `provider TEXT`
  - `model TEXT`
  - `content TEXT NOT NULL`
  - `metadata_json TEXT NOT NULL`
  - `embedding_json TEXT`
  - `created_at TEXT NOT NULL`
- Add indexes for `scope`, `project_id`, `run_id`, `debate_id`, `provider`, `model`, and `created_at DESC, id DESC`.
- `search` is case-insensitive substring matching on `content` only, newest first.

Evidence:

- Add table `evidence_items`:
  - `id TEXT PRIMARY KEY NOT NULL`
  - `debate_id TEXT`
  - `source_type TEXT NOT NULL`
  - `url TEXT`
  - `title TEXT NOT NULL`
  - `snippet TEXT`
  - `fetched_content_path TEXT`
  - `reliability TEXT NOT NULL`
  - `created_at TEXT NOT NULL`
- Add indexes for `debate_id`, `source_type`, `reliability`, and `created_at DESC, id DESC`.

Tool invocations:

- Add table `tool_invocations`:
  - `id TEXT PRIMARY KEY NOT NULL`
  - `run_id TEXT`
  - `type TEXT NOT NULL`
  - `status TEXT NOT NULL`
  - `approval_id TEXT`
  - `input_json TEXT NOT NULL`
  - `output_json TEXT`
  - `error_json TEXT`
  - `created_at TEXT NOT NULL`
  - `completed_at TEXT`
- Add indexes for `run_id`, `type`, `status`, `approval_id`, and `created_at DESC, id DESC`.

Migration behavior:

- `openSqliteStorage()` must create the new tables and indexes on fresh databases.
- Existing R6 SQLite databases must open without manual migration.
- Additive migration tests must build a pre-R7 database and verify that R7 tables and indexes are created without losing R6 run/session/runtime data.

## REST API Contract

All list endpoints use `limit` with default `50`, maximum `200`, and `before` as an opaque cursor. Unknown filter values return `200` with an empty array unless the value is outside the enum for that field.

### Messages

`POST /messages`

Request:

```json
{
  "fromRunId": "run_source",
  "toRunId": "run_target",
  "channel": "r7-smoke",
  "content": "hello from source",
  "attachments": [{ "kind": "memory", "memoryId": "memory_example" }]
}
```

Rules:

- `content` is required after trimming.
- At least one of `toRunId` or `channel` is required.
- `attachments` defaults to `[]`.
- If `fromRunId` or `toRunId` is supplied, the run must exist.
- Successful local routing stores the message with `deliveryStatus: "delivered"` and `deliveredAt`.
- A `message.sent` event is persisted and published. If `toRunId` exists, event `runId` is `toRunId`; otherwise if `fromRunId` exists, event `runId` is `fromRunId`; channel-only messages have no `runId`.

Response: `201 { "message": RoutedMessage }`.

`GET /messages`

Filters:

- `runId` matches either `fromRunId` or `toRunId`.
- `channel`.
- `deliveryStatus`.
- `limit`.
- `before`.

Response: `200 { "messages": RoutedMessage[], "nextCursor": string | null }`.

`GET /messages/:id`

- Unknown id returns `404 message_not_found`.

### Memory

`POST /memory`

Request:

```json
{
  "scope": "project",
  "projectId": "switchyard-local",
  "content": "R7 fake_echo is the only executable tool.",
  "metadata": { "source": "r7-smoke" }
}
```

Rules:

- `scope` and non-empty trimmed `content` are required.
- `metadata` defaults to `{}`.
- `id` and `createdAt` are server-generated.
- REST callers may not provide `embedding`; if present, return `400 invalid_input` with `details.path: "embedding"` and an issue stating vector memory is not shipped in R7.
- Lower-level store tests may preserve `embedding_json` to keep contract parity, but API docs must not advertise vector behavior.

Response: `201 { "memory": MemoryItem }`.

`GET /memory`

Filters:

- `scope`.
- `projectId`.
- `runId`.
- `debateId`.
- `provider`.
- `model`.
- `limit`.
- `before`.

Response: `200 { "memory": MemoryItem[], "nextCursor": string | null }`.

`GET /memory/search`

Filters:

- `q` required, trimmed, non-empty.
- Optional same scope/project/run/debate/provider/model filters as `GET /memory`.
- `limit`.
- `before`.

Rules:

- Search is case-insensitive substring matching against `content`.
- Search never uses `embedding`.
- Empty result is `200 { "memory": [], "nextCursor": null }`.

`GET /memory/:id`

- Unknown id returns `404 memory_not_found`.

### Evidence

`POST /evidence`

Request:

```json
{
  "sourceType": "manual",
  "title": "Local R7 smoke evidence",
  "snippet": "The fake tool approval path was exercised locally.",
  "reliability": "primary"
}
```

Rules:

- `sourceType`, non-empty trimmed `title`, and `reliability` are required.
- `url` is required for `sourceType: "url"`, `"search_result"`, or `"browser_capture"`.
- `url`, when present, must parse as a URL.
- `fetchedContentPath`, when present, must be a relative path and must not contain `..` segments or Windows/absolute path forms.
- R7 does not fetch remote content and does not verify that `fetchedContentPath` exists.

Response: `201 { "evidence": EvidenceItem }`.

`GET /evidence`

Filters:

- `debateId`.
- `sourceType`.
- `reliability`.
- `q`, matching title or snippet case-insensitively.
- `limit`.
- `before`.

Response: `200 { "evidence": EvidenceItem[], "nextCursor": string | null }`.

`GET /evidence/:id`

- Unknown id returns `404 evidence_not_found`.

### Context

`POST /context`

Request:

```json
{
  "target": "run",
  "sections": [{ "name": "operator", "content": "Use local-only deterministic behavior." }],
  "memoryIds": ["memory_example"],
  "evidenceIds": ["evidence_example"],
  "messageIds": ["message_example"]
}
```

Rules:

- `target` is required and must be one of the existing context target enum values.
- `sections`, `memoryIds`, `evidenceIds`, and `messageIds` default to empty arrays.
- Referenced records must exist. Unknown referenced ids return the matching `*_not_found` code.
- Output section order is deterministic:
  1. explicit sections in request order.
  2. one `memory` section if memory ids are provided.
  3. one `evidence` section if evidence ids are provided.
  4. one `messages` section if message ids are provided.
- Memory section content uses memory content in request order.
- Evidence section content uses title plus snippet when present.
- Message section content uses `fromRunId`, `toRunId`, `channel`, and content.
- The context packet is not persisted in R7.

Response: `200 { "context": ContextPacket, "rendered": string }`.

`POST /runs` optional context extension:

```json
{
  "runtime": "fake",
  "provider": "test",
  "model": "test-model",
  "adapterType": "process",
  "cwd": "/repo",
  "task": "Use the supplied context.",
  "context": {
    "memoryIds": ["memory_example"],
    "evidenceIds": ["evidence_example"]
  }
}
```

Rules:

- If `context` is absent, current run behavior is unchanged.
- If `context` is present, the run route builds a `target: "run"` context packet and renders it into the task sent to the adapter.
- The persisted `run.task` is the rendered task so local inspection shows exactly what the runtime received.
- The original task is stored in `run.metadata.originalTask`.
- The context packet is stored in `run.metadata.contextPacket`.
- Context reference failures return the same errors as `POST /context` and the run is not created.

### Approvals

`POST /approvals`

Request:

```json
{
  "runId": "run_example",
  "approvalType": "before_destructive_command",
  "payload": { "reason": "fake risky tool smoke" }
}
```

Rules:

- `approvalType` and `payload` are required.
- `status`, `createdAt`, and `resolvedAt` are server-owned.
- If `runId` is supplied, the run must exist.
- Successful creation stores status `pending`.
- An `approval.requested` event is persisted and published. If `runId` exists, the event is associated with that run.

Response: `201 { "approval": Approval }`.

`GET /approvals`

Filters:

- `runId`.
- `status`.
- `approvalType`.
- `limit`.
- `before`.

Response: `200 { "approvals": Approval[], "nextCursor": string | null }`.

`GET /approvals/:id`

- Unknown id returns `404 approval_not_found`.

`POST /approvals/:id/approve`

Request:

```json
{ "actor": "local-user", "reason": "verified fake tool request" }
```

Rules:

- Only `pending` approvals may be approved.
- Approval is updated to `approved` with `resolvedAt`.
- The optional actor and reason are merged into `approval.payload.resolution`.
- An `approval.approved` event is persisted and published.
- If the approval owns a queued fake tool invocation, the invocation resumes and completes through `tool.call` and `tool.result` events.

Response: `200 { "approval": Approval, "invocation": ToolInvocation | null }`.

`POST /approvals/:id/reject`

Request:

```json
{ "actor": "local-user", "reason": "do not run this action" }
```

Rules:

- Only `pending` approvals may be rejected.
- Approval is updated to `rejected` with `resolvedAt`.
- The optional actor and reason are merged into `approval.payload.resolution`.
- An `approval.rejected` event is persisted and published.
- If the approval owns a queued tool invocation, the invocation becomes `denied` and a `tool.result` event is persisted with payload `{ "status": "denied", "reason": "approval_rejected" }`.

Response: `200 { "approval": Approval, "invocation": ToolInvocation | null }`.

Non-pending approval resolution returns `409 approval_not_pending`.

### Tools

`POST /tools/invocations`

Safe fake request:

```json
{
  "runId": "run_example",
  "type": "fake_echo",
  "input": { "text": "hello" }
}
```

Approval-gated fake request:

```json
{
  "runId": "run_example",
  "type": "fake_echo",
  "input": { "text": "needs approval", "requiresApproval": true }
}
```

Policy rules:

- `fake_echo` is the only executable R7 tool.
- Safe `fake_echo` requests complete synchronously with `status: "completed"` and `output.echo`.
- `fake_echo` requests with `input.requiresApproval === true` or `input.risk` equal to `"risky"` or `"destructive"` create a queued invocation and a pending approval.
- `approvalPolicy: "deny"` on the request or the associated run denies risky fake tool requests immediately.
- Any type other than `fake_echo` is denied or rejected before adapter execution:
  - Known real tool types (`web_search`, `fetch`, `browser`, `repo`, `shell`, `github`) return `403 tool_policy_denied` with reason that real tool execution is not shipped in R7.
  - Unknown tool types return `400 invalid_input`.
- Every policy decision stores or logs a `policyTrace`. For persisted invocations, store it under `input.policyTrace`.

Safe success response: `201 { "invocation": ToolInvocation }`.

Approval-required response: `202 { "invocation": ToolInvocation, "approval": Approval }`.

Denied response:

- Persist a `denied` invocation when the request validates enough to create an audit record.
- Return `403 tool_policy_denied` with `details` including `toolInvocationId` when an invocation was persisted.

Events:

- Safe execution emits `tool.call`, then `tool.result`.
- Approval-required creation emits `approval.requested`.
- Approval resume emits `approval.approved`, `tool.call`, then `tool.result`.
- Approval rejection emits `approval.rejected`, then `tool.result` with denied status.

`GET /tools/invocations`

Filters:

- `runId`.
- `type`.
- `status`.
- `approvalId`.
- `limit`.
- `before`.

Response: `200 { "invocations": ToolInvocation[], "nextCursor": string | null }`.

`GET /tools/invocations/:id`

- Unknown id returns `404 tool_invocation_not_found`.

## Data Flow Shadow Paths

Every R7 data flow must have explicit happy, nil, empty, and upstream-error behavior.

| Flow | Happy path | Nil path | Empty path | Upstream/error path |
| --- | --- | --- | --- | --- |
| Message route | Valid body with `content` and `toRunId` or `channel` stores delivered message and emits `message.sent`. | Missing body returns `400 invalid_input` with path `(root)`. | Empty/whitespace `content` or missing both destination fields returns `400 invalid_input`. Empty attachments means `[]`. | Unknown run id returns `404 run_not_found`; store failure returns `500 internal_error` and logs `message.route_failed`. |
| Memory create/list/search | Valid record stores memory; search finds case-insensitive content matches. | Missing create body returns `400 invalid_input`; missing search `q` returns `400 invalid_query`. | Empty/whitespace content returns `400 invalid_input`; empty search result returns `200` with empty array. | SQLite failure returns `500 internal_error` and logs `memory.persistence_failed`; embedding in REST create returns `400 invalid_input`. |
| Evidence create/list | Valid evidence stores metadata and can be listed by filters. | Missing body returns `400 invalid_input`. | Empty/whitespace title returns `400 invalid_input`; empty list returns `200` with empty array. | Invalid URL/path returns `400 invalid_input`; store failure returns `500 internal_error` and logs `evidence.persistence_failed`. |
| Context build | Valid ids produce deterministic context packet and rendered string. | Missing body returns `400 invalid_input`. | Valid target with no sections or ids returns a context packet with `sections: []` and `rendered: ""`. | Unknown memory/evidence/message id returns matching `404`; store read failure returns `500 internal_error` and logs `context.build_failed`. |
| Run create with context | Valid run body plus context stores rendered task and context packet metadata, then normal launch path proceeds. | Omitted `context` keeps existing run behavior exactly. | `context` with empty arrays renders no extra block and stores an empty packet only if `context` was explicitly supplied. | Context reference failure prevents run creation; runtime adapter failures keep existing run failure semantics. |
| Approval lifecycle | Create pending approval, approve/reject once, emit lifecycle events. | Missing body returns `400 invalid_input`. | Empty payload object is allowed; empty actor/reason fields are ignored. | Unknown approval returns `404 approval_not_found`; resolving non-pending returns `409 approval_not_pending`; store/event failure returns `500 internal_error`. |
| Tool invocation | Safe `fake_echo` completes; risky `fake_echo` requests approval and resumes/denies on approval resolution. | Missing body returns `400 invalid_input`. | `input.text: ""` is valid and echoes `""`; missing `input.text` returns `400 invalid_input`. Empty list returns `200` with empty array. | Real tools return `403 tool_policy_denied`; unknown run returns `404 run_not_found`; fake adapter failure marks invocation failed and emits `tool.result` with error. |

## Architecture

R7 should stay inside the existing package boundaries.

`packages/contracts` owns schema vocabulary:

- Extend tool, event, HTTP error, and list response/query schemas for middleware.
- Do not add debate workflow schemas in this release.

`packages/core` owns protocol-neutral middleware services:

- `MessageRouter` creates and lists routed messages, validates run references through `RunStore`, and emits `message.sent`.
- `MemoryService` creates/lists/searches memory records.
- `EvidenceService` creates/lists evidence records.
- `ContextBuilder` reads memory/evidence/message stores and returns deterministic packets plus rendered text.
- `ApprovalService` creates/resolves approvals and emits lifecycle events.
- `ToolRouter` evaluates policy, persists invocations, calls registered tool adapters, and resumes/denies queued invocations on approval resolution.
- Add a local policy gate implementation in core rather than creating `packages/policy` in R7.

`packages/storage` owns local persistence:

- Extend existing SQLite migrations.
- Add missing SQLite stores and export them from `packages/storage/src/index.ts`.
- Add in-memory stores in `packages/testkit` for all middleware stores so protocol-rest and core tests can run without SQLite.

`packages/protocol-rest` owns route groups:

- Add route modules for messages, memory, evidence, context, approvals, and tools.
- Reuse `registerErrorEnvelope`.
- Keep route dependencies explicit, as run/registry/artifact routes do today.

`apps/daemon` wires the local product:

- SQLite-backed daemon gets all middleware stores.
- In-memory daemon gets all in-memory middleware stores.
- A `FakeEchoToolAdapter` is registered for local execution.
- Route registration order must keep `/tools/invocations/:id` and `/tools/invocations` unambiguous.

## User-Visible Behavior

Local inspection flow:

1. User starts the daemon.
2. User creates a memory record through `POST /memory`.
3. User creates evidence through `POST /evidence`.
4. User creates a message through `POST /messages`.
5. User builds context through `POST /context` and sees a stable packet with memory/evidence/message sections.
6. User creates a fake run with `context` in `POST /runs`; inspecting the run shows the rendered task and `metadata.contextPacket`.

Approval and tool flow:

1. User invokes `fake_echo` with safe input.
2. Daemon records a completed invocation and emits `tool.call` and `tool.result`.
3. User invokes `fake_echo` with `requiresApproval: true`.
4. Daemon records a queued invocation, creates a pending approval, and emits `approval.requested`.
5. User approves the approval.
6. Daemon records `approval.approved`, resumes the invocation, emits `tool.call` and `tool.result`, and marks the invocation completed.
7. User repeats the request and rejects the approval.
8. Daemon records `approval.rejected`, marks the invocation denied, and emits a denied `tool.result`.

Policy denial flow:

1. User attempts to invoke `shell`, `github`, `browser`, `fetch`, `web_search`, or `repo`.
2. Daemon refuses with `403 tool_policy_denied`.
3. If the request validates enough to create an audit record, `GET /tools/invocations/:id` shows `status: "denied"` and the denial reason.

## Constraints

- Keep R7 local-first and deterministic. No network calls are made by middleware services or fake tools.
- Do not create a new `packages/policy` package in R7. Use core services and ports.
- Do not make the fake tool available as a real shell/search/browser substitute.
- Do not change existing runtime-mode inference or existing run behavior when `context` is absent.
- Do not break R6 SQLite databases.
- Do not store absolute or parent-traversing paths from evidence input.
- Do not expose secrets in policy traces, events, logs, invocation input/output, or approval payloads. Redact keys named `token`, `apiKey`, `authorization`, `password`, and `secret`.
- All new local smoke paths must run without model spend.

## Acceptance Criteria

- [ ] `POST /messages`, `GET /messages`, and `GET /messages/:id` work locally and emit `message.sent`.
- [ ] `POST /memory`, `GET /memory`, `GET /memory/:id`, and `GET /memory/search?q=...` work with durable SQLite persistence and no vector search behavior.
- [ ] `POST /evidence`, `GET /evidence`, and `GET /evidence/:id` work with durable SQLite persistence and safe path validation.
- [ ] `POST /context` builds deterministic context packets from explicit sections plus memory/evidence/message ids.
- [ ] `POST /runs` accepts optional `context` without changing behavior when `context` is omitted.
- [ ] `POST /approvals`, `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, and `POST /approvals/:id/reject` work and emit approval lifecycle events.
- [ ] `POST /tools/invocations`, `GET /tools/invocations`, and `GET /tools/invocations/:id` work for safe, approval-required, approved, rejected, and policy-denied fake tool paths.
- [ ] Real tool types are visibly denied before execution with `tool_policy_denied`; no real shell/browser/search/GitHub/fetch/repo execution is possible.
- [ ] SQLite reopen tests prove message, memory, evidence, approval, and tool invocation records persist across daemon restart.
- [ ] Pre-R7 SQLite migration tests prove new tables/indexes are added without losing R6 data.
- [ ] REST tests cover validation failures and every named new not-found/conflict/policy-denied error code.
- [ ] Daemon smoke tests cover safe fake tool, approval-required fake tool, approved resume, rejected denial, context-on-run, and local persistence.
- [ ] `PRODUCT.md`, `CHANGELOG.md`, `docs/development/API.md`, and `docs/development/DEVELOPMENT.md` are updated during implementation closeout to describe the shipped R7 surface and local smoke commands.

## Phase Plan

### Phase 1: R7 Middleware Foundation Vertical Slice

Goal: ship durable local middleware services, REST APIs, fake tool execution, approval lifecycle, context assembly, policy gates, and development docs as one bounded foundation release.

Acceptance:

- Contracts expose the exact middleware records, event types, and error codes needed by this spec.
- Core services are implemented behind explicit ports and are covered by happy, nil, empty, and error path tests.
- SQLite and in-memory stores support create/get/update/list/search behavior where specified.
- REST routes expose messages, memory, evidence, context, approvals, and tools with unified error envelopes.
- Daemon wires all middleware stores/services/routes and the fake echo tool adapter.
- Existing run/runtime/artifact/registry behavior remains backward compatible.
- Local docs include copy-paste smoke commands for memory, evidence, messages, context, approvals, and fake tools.

Non-goals for this phase:

- Vector memory.
- Full debate engine.
- Real tool execution.
- Runtime-specific approval bridging.
- Hosted/hybrid behavior.
- SDK/CLI/TUI/dashboard surfaces.

Complexity: L

Implementation note:

- Keep this as one release phase. The CTO may split it into internal tasks for contracts/storage, core services, REST/daemon wiring, and docs/smoke coverage, but there should not be a second product phase for R7 unless implementation discovers an actual blocker.

## Verification Commands

Required automated checks:

```bash
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/storage test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test
pnpm typecheck
```

Required local smoke outline:

```bash
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-r7-middleware \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

Then use `BASE=http://127.0.0.1:4546` to verify:

- Create memory.
- Search memory by substring.
- Create evidence.
- Create a message.
- Build context from all three.
- Create a fake run with context.
- Invoke safe `fake_echo`.
- Invoke approval-required `fake_echo`.
- Approve one pending approval and verify resumed completion.
- Reject one pending approval and verify denied completion.
- Attempt a real tool type and verify `tool_policy_denied`.
- Restart daemon with the same data dir and verify records remain inspectable.

## Documentation Requirements

Implementation closeout must update:

- `PRODUCT.md`: mark R7 shipped and list the actual usable middleware endpoints.
- `CHANGELOG.md`: add a dated R7 release entry.
- `docs/development/API.md`: add endpoint sections, request/response examples, error codes, and note vector/real-tool non-goals.
- `docs/development/DEVELOPMENT.md`: add local middleware smoke commands that do not spend model budget.

The docs must explicitly say:

- Memory search is substring-only.
- Evidence creation does not fetch remote content.
- `fake_echo` is the only executable tool.
- Real tool types are policy-denied in R7.
- Context packets are not persisted except when embedded into run metadata through `POST /runs`.

## Open Concerns

- R7 expands the closed HTTP error code set and event type enum; downstream tests that assert exact enum members must be updated in the same release.
- Context packets are intentionally not first-class persisted records. If R8/R9 needs reusable context ids, that should become a separate context-store release rather than being hidden in R7.
- REST memory create rejects embeddings, while lower-level storage may preserve the optional contract field for parity. This prevents users from mistaking R7 for vector memory while avoiding a breaking contract removal.
- Run context rendering stores the rendered prompt in `run.task` for transparency. Clients that need the original task must read `run.metadata.originalTask`.
