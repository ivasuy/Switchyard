# Phase 8: R9 Debate V1 - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-8-r9-debate-v1.md`
**Spec commit:** `6ace970`
**Branch:** `agent/phase-8-r9-debate-v1`
**Worktree:** `/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/native-roadmap-20260529/phase-8-r9-debate-v1`
**Plan target:** `docs/superpowers/plans/2026-05-30-phase-8-r9-debate-v1.md`
**Complexity:** L

## Goal

Ship one local, deterministic, two-participant fake debate workflow that creates normal fake participant runs, routes bounded debate turns through the existing message router, persists inspectable debate state, streams debate-filtered events, judges deterministically, and writes a final markdown report artifact.

## Scope Challenge

1. Existing code already partially solves R9 through `RunService`, `RuntimeRunnerService`, `MessageRouter`, `ContextBuilder`, evidence/message stores, event bus, artifact metadata/content stores, run SSE behavior, and daemon store wiring. R9 must extend these seams and must not add a second runtime loop, queue, worker, scheduler, participant adapter layer, or prompt-only debate log.
2. The minimum viable R9 is contracts plus a real debate store, debate-aware event/artifact listing, message-router debate event metadata, one sequential `DebateService`, REST create/inspect/events routes, daemon wiring, deterministic tests, and local smoke docs. Debate listing, manual stop, SDK/CLI/TUI/dashboard, hosted/hybrid execution, vector retrieval, model judging, and real tools are deferred.
3. The phase necessarily touches more than eight files because the release crosses contracts, core, storage, REST, SSE, daemon wiring, docs, and tests. This is a complexity smell. It is kept as one implementer task because the user requested one implementer/reviewer for this phase and the change is tightly coupled around one workflow; splitting would force cross-worktree edits to shared contracts and route dependencies.
4. Built-in and established project pieces to use: Zod for schema expansion, `GenericStore` for `DebateStore`, Fastify route style plus `HttpProblem`/`sendHttpError`, existing `ContextBuilder`, existing `MessageRouter`, existing `EventBus`, existing `@switchyard/protocol-sse` formatting/heartbeat behavior, Drizzle SQLite table mapping, and the existing filesystem artifact content store.
5. Distribution check: R9 adds no package, binary, hosted worker, CLI, SDK, or deployment artifact. The only user-facing distribution is the local daemon API and docs; smoke commands must use no-spend fake runtime calls.

## Architecture

R9 treats a debate as a product workflow record, not a runtime adapter. The debate service validates a local-only fake debate request, creates a durable debate record, validates evidence metadata, creates two normal fake deterministic runs through `RunService`, runs a sequential bounded round loop, routes every turn through `MessageRouter`, appends debate-scoped events, judges with a pure deterministic function, and writes a summary artifact through the existing artifact metadata and optional content stores.

```text
POST /debates?wait=1
  -> debate-routes validation and error envelope
  -> DebateService.createAndMaybeExecute
       -> DebateStore.create
       -> EvidenceStore.get for supplied evidence ids
       -> ContextBuilder.build(target="participant")
       -> RunService.createRun + RunService.startRun for each fake participant
       -> MessageRouter.createWithEvent for each debate turn
       -> EventStore.append + EventBus.publish for debate events
       -> deterministic judge
       -> ArtifactStore.create + optional artifactContent.writeText
  -> { debate, events, finalReportArtifact }
```

The executor is deliberately sequential and non-recursive. Stop checks run before every round and before every participant turn. If a hard cap would be exceeded, the executor stops before creating another message, persists `stopReason`, runs the judge, appends exactly one `debate.judge.summary` event for that execution attempt, and attempts to create the final report artifact.

```text
debates table
  topic, status, participants_json, limits_json, evidence_ids_json,
  message_ids_json, event_ids_json, budget_json, judge_json,
  final_report_artifact_id, final_report_path, stop_reason, error_json
        |
        v
GET /debates/:id -> debate + listByDebate events/artifacts + message/evidence lookups
GET /debates/:id/events -> replay/live SSE filtered by event.debateId
```

The existing message router remains the only writer of message rows. R9 extends the router input with optional `debateId` and `participantId`, adds a backwards-compatible `createWithEvent` helper for internal callers, and keeps public `POST /messages` returning `{ message }`.

## File Structure

- `packages/contracts/src/debate.ts` - expands the public `Debate` and participant schemas with R9 state, budget, judge, ids, and stop reason fields.
- `packages/contracts/src/http-error.ts` - adds `debate_not_found` to the closed REST error-code schema.
- `packages/contracts/test/contracts.test.ts` - proves R9 debate defaults/fields and error-code schema parse without breaking existing contracts.
- `packages/core/src/ports/debate-store.ts` - defines the real `DebateStore` port on top of `GenericStore<Debate>` with optional list support.
- `packages/core/src/ports/event-store.ts` - adds `listByDebate(debateId)`.
- `packages/core/src/ports/artifact-store.ts` - adds `listByDebate(debateId)`.
- `packages/core/src/services/message-router.ts` - accepts `debateId` and `participantId`, includes both on emitted `message.sent` events, and exposes `createWithEvent`.
- `packages/core/src/services/debate-service.ts` - implements validation, durable state transitions, participant seed runs, bounded rounds, deterministic judge, inspect aggregation, and final report artifact creation.
- `packages/core/test/debate-service.test.ts` - core service tests for happy path, limit stops, nil/empty evidence, unsupported runtime, run/message/report failures, and final state.
- `packages/core/test/middleware-services.test.ts` - regression coverage that normal messages still work and debate metadata appears only when provided.
- `packages/storage/src/sqlite/schema.ts` - adds the Drizzle `debates` table mapping.
- `packages/storage/src/sqlite/database.ts` - adds fresh schema SQL, additive R9 table/index migration, and debate indexes.
- `packages/storage/src/sqlite/debate-store.ts` - SQLite mapping for create/get/update and optional list.
- `packages/storage/src/sqlite/event-store.ts` - implements debate-scoped event listing ordered by sequence.
- `packages/storage/src/sqlite/artifact-store.ts` - implements debate-scoped artifact listing.
- `packages/storage/src/index.ts` - exports `SqliteDebateStore`.
- `packages/storage/test/sqlite-storage.test.ts` - covers debates table/indexes, persistence, `listByDebate`, and additive migration.
- `packages/storage/test/storage-package.test.ts` - covers package-level debate store export and reopen behavior.
- `packages/testkit/src/fake-stores.ts` - adds in-memory debate store and debate-scoped event/artifact listing.
- `packages/testkit/src/index.ts` - exports the in-memory debate store.
- `packages/protocol-sse/src/sse-stream.ts` - generalizes replay/live filtering so debate streams reuse run stream heartbeat, idle close, and `Last-Event-ID` semantics.
- `packages/protocol-sse/test/sse-stream.test.ts` - proves the generic stream still filters run events and now filters debate events.
- `packages/protocol-sse/test/open-ended-stream.test.ts` - regression coverage for open-ended cleanup after generic stream extraction.
- `packages/protocol-rest/src/debate-routes.ts` - new Fastify debate create, inspect, and SSE routes.
- `packages/protocol-rest/src/http-errors.ts` - adds `debate_not_found` to runtime error mapping.
- `packages/protocol-rest/src/index.ts` - exports debate routes.
- `packages/protocol-rest/test/debate-routes.test.ts` - REST create/inspect/events/negative tests.
- `apps/daemon/src/app.ts` - wires `DebateService`, `SqliteDebateStore`, in-memory debate store, shared `MessageRouter`, `ContextBuilder`, event bus, artifact writer, and debate routes.
- `apps/daemon/test/smoke.test.ts` - no-spend daemon smoke tests for configured storage and in-memory metadata behavior.
- `docs/development/API.md` - documents the shipped debate API, examples, error code, and R9 non-goals.
- `docs/development/DEVELOPMENT.md` - adds copy-paste no-spend R9 debate smoke and negative smoke commands.
- `PRODUCT.md` - updates current truth from planned R9 to shipped fake-only debate.
- `CHANGELOG.md` - adds the R9 fake debate release entry.

## Existing Context

`packages/contracts/src/debate.ts` currently has only the base shape. Implementers must extend it, not replace it:

```ts
export const debateParticipantSchema = z.object({
  id: participantIdSchema,
  runId: runIdSchema.optional(),
  runtime: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  role: z.string().min(1),
  status: participantStatusSchema,
  turnsUsed: z.number().int().nonnegative()
});
```

`packages/core/src/services/debate-service.ts` is still a shell. R9 owns this implementation:

```ts
export class DebateService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("debate-service", method);
  }
}
```

`packages/core/src/services/message-router.ts` already validates runs, stores messages, and emits `message.sent`. R9 must extend this path rather than inserting message rows directly:

```ts
await this.deps.messages.create(message);
const eventRunId = input.toRunId ?? input.fromRunId;
const event = await this.createMessageEvent(eventRunId, message);
await this.deps.events.append(event);
```

`packages/protocol-rest/src/run-routes.ts` establishes `wait=1`, async microtask launch, replay/live SSE, `Last-Event-ID`, and unified error-envelope style for R9 routes.

`packages/storage/src/sqlite/database.ts` already uses `CREATE TABLE IF NOT EXISTS` plus additive migrations. Add the `debates` table and R9 indexes without dropping or rewriting existing data.

`packages/storage/src/filesystem-artifact-content-store.ts` already validates relative artifact paths and writes content under the configured artifact root. The final report path must be `debates/<debateId>/final-report.md`.

`apps/daemon/src/app.ts` already wires shared stores, `EventBus`, `RunService`, `MessageRouter`, `ContextBuilder`, artifact content reader, and route groups. R9 must add debate wiring inside this existing app factory.

## Task Graph

### Task P8-T1-r9-debate-v1

`id`: `P8-T1-r9-debate-v1`
`title`: Ship deterministic fake debate workflow`

`files`:
- Modify: `packages/contracts/src/debate.ts`
- Modify: `packages/contracts/src/http-error.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/core/src/ports/debate-store.ts`
- Modify: `packages/core/src/ports/event-store.ts`
- Modify: `packages/core/src/ports/artifact-store.ts`
- Modify: `packages/core/src/services/message-router.ts`
- Modify: `packages/core/src/services/debate-service.ts`
- Create: `packages/core/test/debate-service.test.ts`
- Modify: `packages/core/test/middleware-services.test.ts`
- Modify: `packages/storage/src/sqlite/schema.ts`
- Modify: `packages/storage/src/sqlite/database.ts`
- Create: `packages/storage/src/sqlite/debate-store.ts`
- Modify: `packages/storage/src/sqlite/event-store.ts`
- Modify: `packages/storage/src/sqlite/artifact-store.ts`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/test/sqlite-storage.test.ts`
- Modify: `packages/storage/test/storage-package.test.ts`
- Modify: `packages/testkit/src/fake-stores.ts`
- Modify: `packages/testkit/src/index.ts`
- Modify: `packages/protocol-sse/src/sse-stream.ts`
- Modify: `packages/protocol-sse/test/sse-stream.test.ts`
- Modify: `packages/protocol-sse/test/open-ended-stream.test.ts`
- Create: `packages/protocol-rest/src/debate-routes.ts`
- Modify: `packages/protocol-rest/src/http-errors.ts`
- Modify: `packages/protocol-rest/src/index.ts`
- Create: `packages/protocol-rest/test/debate-routes.test.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`
- Modify: `docs/development/API.md`
- Modify: `docs/development/DEVELOPMENT.md`
- Modify: `PRODUCT.md`
- Modify: `CHANGELOG.md`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-30-phase-8-r9-debate-v1.md` - source of R9 scope, hard limits, routes, executor behavior, shadow paths, and acceptance.
- `PRODUCT.md` - current truth and R9 release boundary; update only the R9/current-state sections after implementation.
- `packages/contracts/src/debate.ts` - current debate schema to extend without removing existing fields.
- `packages/core/src/services/message-router.ts` - the only allowed path for writing debate turn messages and `message.sent` events.
- `packages/protocol-rest/src/run-routes.ts` - route, wait, async launch, SSE, `Last-Event-ID`, and error-envelope pattern to mirror.
- `packages/storage/src/sqlite/database.ts` - current migration style for additive SQLite schema changes.
- `apps/daemon/src/app.ts` - existing daemon dependency graph and route registration surface to extend.

`instructions`: Implement R9 in small test-first steps:

1. Extend contracts first. In `debate.ts`, add `runIds` to participants and add `evidenceIds`, `messageIds`, `eventIds`, `finalReportArtifactId`, `finalReportPath`, `stopReason`, `judge`, `budget`, `updatedAt`, `completedAt`, and `error` to `debateSchema`. Keep existing enum values and existing `runId` compatibility. Add R9-specific stop reason and judge schemas. In `http-error.ts`, add `debate_not_found`.
2. Extend ports and stores. `DebateStore` remains `GenericStore<Debate>` plus optional `list`. Add `listByDebate` to event and artifact stores. Add the SQLite `debates` table with the exact columns from the spec, indexes `debates_created_at_idx`, `debates_status_idx`, `run_events_debate_sequence_idx`, and `artifacts_debate_id_idx`, plus `SqliteDebateStore` JSON mapping. Add in-memory testkit implementations. Reopen tests must prove state survives SQLite close/reopen.
3. Extend `MessageRouter` without breaking public callers. Add optional `debateId` and `participantId` to `CreateMessageInput`. Add `createWithEvent(input): Promise<{ message: RoutedMessage; event: SwitchyardEvent }>` and make `create(input)` call it and return only `message`. When `debateId` is present, include `debateId`, `participantId`, and debate metadata in the emitted event, and compute event `sequence` from `events.listByDebate(debateId).length`; otherwise preserve the existing run-scoped sequence behavior. Publish the event through the existing event bus path.
4. Implement `DebateService` as the only orchestrator. Its dependencies are `debates`, `runs`, `runService`, `contextBuilder`, `messageRouter`, `evidence`, `events`, `messages` or `messageRouter.get`, `artifacts`, optional `artifactContent`, optional `eventBus`, optional `logger`, and `defaultCwd`. It exposes `create(input, { wait })`, `execute(debateId)`, `inspect(debateId)`, and `listEvents(debateId)` methods. Service errors must expose `{ code, message, details? }` for REST mapping.
5. Validate create input before persisting debate state. Body must be an object; topic must trim non-empty and be at most 2048 UTF-8 bytes; participants must contain exactly two entries; participant roles must trim non-empty and be at most 64 UTF-8 bytes; any supplied runtime fields must match `runtime:"fake"`, `provider:"test"`, `model:"test-model"`, `adapterType:"process"`, `runtimeMode:"fake.deterministic"`; omitted runtime fields use those defaults. Reject reserved internal fields: `id`, `status`, `messageIds`, `eventIds`, `judge`, `budget`, `finalReportArtifactId`, `finalReportPath`, `createdAt`, `updatedAt`, and `completedAt`.
6. Validate evidence before creating the debate record. `evidenceIds` defaults to `[]`, must have at most 10 string ids, every id must exist, and an evidence record with a different `debateId` fails with `invalid_input`. Unknown ids fail with `evidence_not_found` and no debate, run, message, event, or artifact record should be created.
7. Apply R9 limit defaults and hard caps. Defaults are `maxRounds:2`, `maxTurnsPerAgent:2`, `maxSearchesPerAgent:0`, `maxTotalMessages:4`, `maxDurationSeconds:30`, `maxCostUsd:0`, `requireCitations:false`, `requireDisagreementSummary:true`, `stopOnConsensus:false`, `stopOnLowNewInformation:false`, and `humanStopAllowed:false`. Enforce the exact ranges in the spec; `maxCostUsd`, `maxSearchesPerAgent`, and `humanStopAllowed` must remain `0`, `0`, and `false`.
8. Create the initial debate with generated `debate_` and two `participant_` ids, `mode:"same_provider_model_debate"`, `status:"created"`, empty run/message/event ids, `budget:{ status:"within_budget", maxCostUsd:0, spentCostUsd:0 }`, and normalized fake participants. Append `debate.evidence.added` events for supplied evidence ids and persist debate state after each event id is recorded.
9. For each participant, build a `target:"participant"` context packet with a `debate` section containing topic and role plus `evidenceIds`. Create a normal run through `RunService.createRun`, then complete it with `RunService.startRun`. Use `runtime:"fake"`, `provider:"test"`, `model:"test-model"`, `adapterType:"process"`, `runtimeMode:"fake.deterministic"`, `placement:"local"`, `approvalPolicy:"default"`, `timeoutSeconds` no greater than the debate `maxDurationSeconds`, `cwd` from `defaultCwd`, and the participant seed task template from the spec. Run metadata must include `debateId`, `participantId`, `participantRole`, `debateTopic`, `debateRunKind:"participant_seed"`, `originalTask`, and `contextPacket`.
10. Execute rounds sequentially. Before each round and before each turn, check stop reasons in the specified order: `max_duration_seconds`, `max_cost_usd`, `max_total_messages`, `max_turns_per_agent`, `consensus`, `max_rounds`. Set status to `arguing` for round 1 and `rebuttal` for later rounds, append `debate.round.started`, and persist. For each participant in request order, generate the exact deterministic fake content shape from the spec, route it through `MessageRouter.createWithEvent`, append `debate.agent.argument` or `debate.agent.rebuttal`, increment `turnsUsed`, record message and event ids, and persist before the next turn. Debate code must never call `messages.create` directly.
11. Implement the judge as a pure local function. It accepts topic, participants, message contents, evidence ids/titles, limits, and stop reason. It returns `consensus:"consensus_found"` only when both final normalized stance sentences match, otherwise `no_consensus`; `winner:"none"` always; deterministic `summary`; deterministic `disagreementSummary`; and copied evidence/message ids. It must never call adapters, models, search, browser, shell, network, or real tools.
12. Finalize state and artifact. Normal fake completion stores terminal `status:"no_consensus"` unless `stopOnConsensus` and consensus are both true, in which case use `consensus_found`. `stopReason` should be `max_rounds` for default completion. Write the markdown report at `debates/<debateId>/final-report.md`. If `artifactContent` exists, call `writeText` and store `metadata.contentStored:true`; if absent, still create the artifact record with `metadata.contentStored:false`. After artifact metadata is stored, append `artifact.created` with `debateId`, update `finalReportArtifactId` and `finalReportPath`, and persist.
13. Failure handling must keep inspectable state. Participant run failure, timeout, cancellation, message router failure, event append failure, judge failure, or report write failure marks the debate `failed` with `error.code` and `error.message`, appends a failure `debate.judge.summary` if no judge summary was appended for the execution attempt, attempts a failure report artifact when possible, logs `debate.failed`, and returns an error through REST for synchronous create when the service cannot honestly return a completed debate.
14. Add REST routes. `POST /debates` returns `202 { debate }` after record creation and schedules `execute` on a microtask. `POST /debates?wait=1` executes before responding and returns `201 { debate, events, finalReportArtifact }`. `GET /debates/:id` returns `{ debate, events, messages, evidence, artifacts }` ordered by debate state ids and `sequence ASC` for events. `GET /debates/:id/events` supports replay-only, `live=1`, `live=1&stopAfter=N`, `Last-Event-ID`, and `lastEventId`, filtering only events with `event.debateId === debateId`. Unknown debates return `404 debate_not_found` before any SSE body is written.
15. Reuse SSE behavior by generalizing `@switchyard/protocol-sse` around an event predicate or entity key while preserving `streamRunEvents` as a wrapper for existing callers. Debate streaming must keep `text/event-stream; charset=utf-8`, heartbeat, idle close, bounded `stopAfter`, and cleanup behavior.
16. Wire daemon dependencies. Add `debates` to `DaemonStores`, instantiate `SqliteDebateStore` and `InMemoryDebateStore`, share one `MessageRouter` between middleware and debate routes, pass `eventBus`, pass `ContextBuilder`, pass `artifactContent`, and register debate routes before the artifact routes. In-memory daemon mode may create artifact metadata with `contentStored:false`; configured storage mode must fetch the report through existing `/artifacts/:id/content`.
17. Update docs and release truth. `docs/development/API.md` must list debate routes, schemas, examples, `debate_not_found`, fake-only constraints, and non-goals. `docs/development/DEVELOPMENT.md` must include the no-spend smoke sequence from the spec plus negative commands for unsupported runtime, unknown evidence id, and `maxTotalMessages:1`. `PRODUCT.md` and `CHANGELOG.md` must state R9 shipped fake-only deterministic debate and must not claim hosted/hybrid execution, real runtimes, real tools, SDK/CLI/TUI/dashboard, vector retrieval, or model judging.

`acceptance`:
- `POST /debates` and `POST /debates?wait=1` exist and accept only bounded two-participant fake debates.
- `GET /debates/:id` returns final state with participants, run ids, limits, budget, evidence ids, message ids, event ids, stop reason, judge output, final report path, and final report artifact id.
- `GET /debates/:id/events` supports replay-only, `live=1`, bounded `live=1&stopAfter=N`, `Last-Event-ID`, and `lastEventId`, filtered by `debateId`.
- Debate state persists in SQLite and survives daemon restart.
- Each participant has one normal fake deterministic seed run created through `RunService`.
- Each debate turn is routed through `MessageRouter.createWithEvent`; debate code never inserts messages directly.
- Existing evidence ids are validated and appear in context, evidence events, inspect output, and the final report.
- Every debate stores applied limits and budget; invalid R9 limit values fail with `400 invalid_input`.
- The executor stops before creating messages that would exceed hard limits and records the correct `stopReason`.
- The deterministic judge returns stable `no_consensus` for default fake participants and never calls a model, adapter, network, shell, browser, search, GitHub, repo, fetch, or real tool.
- Completed fake debates create a markdown `summary` artifact with `debateId`.
- Configured local storage can fetch final report markdown through `GET /artifacts/:id/content`; in-memory mode returns artifact metadata with missing-content semantics.
- Unsupported real participant runtimes fail before debate side effects.
- API and development docs include no-spend fake debate smoke and negative smoke commands.
- Existing run, middleware, registry, runtime-mode, approval, input, event, SSE, and artifact tests remain green.

`checks`:
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/core test -- debate-service`
- `pnpm --filter @switchyard/core test -- middleware-services`
- `pnpm --filter @switchyard/storage test -- sqlite-storage`
- `pnpm --filter @switchyard/storage test -- storage-package`
- `pnpm --filter @switchyard/protocol-sse test`
- `pnpm --filter @switchyard/protocol-rest test -- debate-routes`
- `pnpm --filter @switchyard/daemon test -- smoke`
- `pnpm typecheck`

`error_rescue_map`:
- `{ codepath: "debate-routes.parseCreateDebateBody", failure: "body is nil, non-object, empty object, missing topic, missing participants, whitespace topic, too-large topic, wrong participant count, too-long role, reserved internal field, or unsupported runtime field", exception: "HttpProblem invalid_input", rescue: "return 400 with details.path before service side effects", user_sees: "unified error envelope with invalid_input and a concrete field path" }`
- `{ codepath: "DebateService.validateEvidenceReferences", failure: "evidenceIds omitted, empty, unknown, too many, non-string, or bound to another debate id", exception: "DebateServiceError evidence_not_found or invalid_input", rescue: "treat omitted/empty as []; reject unknown or conflicting ids before debate creation", user_sees: "404 evidence_not_found or 400 invalid_input with no participant runs or messages created" }`
- `{ codepath: "DebateService.applyLimits", failure: "limits omitted, partial, zero, negative, over R9 cap, maxCostUsd above 0, maxSearchesPerAgent above 0, or humanStopAllowed true", exception: "DebateServiceError invalid_input", rescue: "apply defaults for omitted fields; reject invalid supplied fields before creating debate", user_sees: "400 invalid_input naming the bad limit" }`
- `{ codepath: "SqliteDebateStore.create/update/get", failure: "database insert/update/read fails or JSON column is malformed", exception: "better-sqlite3 or JSON SyntaxError", rescue: "surface internal_error through route; best-effort mark existing debate failed when record exists", user_sees: "500 internal_error for create or inspectable failed debate after partial execution" }`
- `{ codepath: "DebateService.createParticipantRuns", failure: "ContextBuilder missing, evidence missing during context build, RunService.createRun fails, RunService.startRun returns failed, timeout, or cancelled", exception: "ContextBuilderError, Error, or terminal Run status", rescue: "mark participant and debate failed, append failure judge summary if possible, attempt failure report", user_sees: "terminal failed debate with error code and any created run ids" }`
- `{ codepath: "MessageRouter.createWithEvent", failure: "fromRunId/toRunId missing, unknown run id, empty generated content, message store failure, event store failure, or event bus publish failure", exception: "MessageRouterError run_not_found or invalid_input; store Error", rescue: "validate run ids before routing; event bus publish is logged best-effort; store failures fail the debate visibly", user_sees: "failed debate with message-routing error instead of a hidden missing turn" }`
- `{ codepath: "DebateService.executeRounds", failure: "maxDurationSeconds, maxCostUsd, maxTotalMessages, maxTurnsPerAgent, consensus, or maxRounds reached", exception: "no throw for normal stops", rescue: "stop before next message, persist stopReason, transition to judging, run deterministic judge", user_sees: "terminal debate with stopReason and no over-limit message" }`
- `{ codepath: "DebateService.judge", failure: "no messages, one message, no evidence, mismatched participant state, or unexpected judge exception", exception: "DebateServiceError judge_failed for unexpected exception", rescue: "return deterministic no_consensus or failure summary for valid partial state; mark failed on exception", user_sees: "judge summary or failed debate with explicit error" }`
- `{ codepath: "DebateService.writeFinalReport", failure: "artifact content writer absent, artifact path escape, content write failure, artifact metadata insert failure, or artifact.created event append failure", exception: "Error or store Error", rescue: "with absent writer store metadata contentStored false; on write/metadata/event failure mark debate failed and record error", user_sees: "artifact metadata with missing content semantics or failed debate with report error" }`
- `{ codepath: "registerDebateRoutes.handleEvents", failure: "unknown debate id, malformed stopAfter, no event bus, Last-Event-ID not found, client disconnect", exception: "HttpProblem debate_not_found or no throw", rescue: "return 404 before hijack; normalize bad stopAfter as run route does; degrade to replay without bus; cleanup on close", user_sees: "SSE replay/live stream filtered to the debate or clear 404 envelope" }`
- `{ codepath: "daemon debate wiring", failure: "debate store, message router, context builder, artifact writer, or event bus not passed", exception: "startup/test failure or internal_error", rescue: "wire shared dependencies in createDaemonApp and cover in smoke tests", user_sees: "daemon starts with debate routes or tests fail before release" }`

`observability`:
- `logs`: `debate.create_requested` with topic byte length and counts; `debate.created`; `debate.evidence.added`; `debate.participant_run.created`; `debate.round.started`; `debate.message.routed`; `debate.stopped`; `debate.judge.summary`; `debate.final_report.created`; `debate.failed`. Logs must include ids, round, counts, and reason codes, and must truncate topic over 256 bytes and message bodies over 512 bytes.
- `success_metric`: a local `POST /debates?wait=1` with two fake participants produces terminal debate state, two completed participant runs, at least one routed message, replayable debate SSE, and a final report artifact.
- `failure_metric`: validation failures produce 400/404 without side effects; runtime/store/message/artifact failures produce terminal failed debate state when a debate record exists.

`test_cases`:
- `{ name: "happy_fake_two_participant_debate", lens: "happy", given: "POST /debates?wait=1 with default fake participants and maxRounds 2", expect: "201, terminal no_consensus, two completed participant runs, four message ids, judge output, final report artifact" }`
- `{ name: "happy_shadow_nil_evidence", lens: "happy_shadow_nil", given: "create debate without evidenceIds", expect: "debate proceeds with evidenceIds [], no evidence events, report says no evidence supplied" }`
- `{ name: "happy_shadow_empty_evidence", lens: "happy_shadow_empty", given: "create debate with evidenceIds []", expect: "same behavior as omitted evidenceIds" }`
- `{ name: "happy_shadow_empty_limit_partial", lens: "happy_shadow_empty", given: "limits.maxTotalMessages = 1", expect: "exactly one message id, stopReason max_total_messages, final report artifact present" }`
- `{ name: "error_nil_body", lens: "happy_shadow_nil", given: "POST /debates with null or missing body", expect: "400 invalid_input path body and no debate created" }`
- `{ name: "error_empty_body", lens: "happy_shadow_empty", given: "POST /debates with {}", expect: "400 invalid_input naming topic and participants" }`
- `{ name: "error_reserved_fields", lens: "error_path", given: "create body includes status, eventIds, judge, or finalReportArtifactId", expect: "400 invalid_input before side effects" }`
- `{ name: "error_unsupported_participant_runtime", lens: "error_path", given: "participant runtime codex or claude_code", expect: "400 invalid_input and no run/message/event/artifact side effects" }`
- `{ name: "error_bad_participant_count", lens: "error_path", given: "zero, one, or three participants", expect: "400 invalid_input with participant count detail" }`
- `{ name: "error_unknown_evidence", lens: "error_path", given: "evidenceIds contains evidence_missing", expect: "404 evidence_not_found and no participant runs" }`
- `{ name: "error_evidence_other_debate", lens: "error_path", given: "evidence record has another debateId", expect: "400 invalid_input and no participant runs" }`
- `{ name: "error_invalid_limits", lens: "error_path", given: "maxRounds 0 or 4, maxCostUsd 1, maxSearchesPerAgent 1, humanStopAllowed true", expect: "400 invalid_input with limit path" }`
- `{ name: "participant_runs_are_normal_runs", lens: "integration", given: "successful debate", expect: "participants have runId/runIds and GET /runs/:id shows fake.deterministic metadata with debate ids" }`
- `{ name: "message_router_debate_event", lens: "integration", given: "routed debate turn", expect: "message.sent event has debateId, participantId, channel debate:<id>, and message id payload" }`
- `{ name: "round_events_ordered_by_debate_sequence", lens: "integration", given: "successful debate", expect: "listByDebate returns evidence, round, message, agent, judge, artifact events in deterministic sequence order" }`
- `{ name: "executor_stop_before_over_limit_message", lens: "edge_limit", given: "maxTotalMessages 1", expect: "second participant message is never created" }`
- `{ name: "judge_no_consensus_default", lens: "happy", given: "default affirmative and skeptic fake stances", expect: "judge.consensus no_consensus and winner none" }`
- `{ name: "judge_no_external_calls", lens: "integration", given: "instrumented adapters/tools/search are unavailable", expect: "judge completes without invoking any adapter or tool" }`
- `{ name: "final_report_content_stored", lens: "integration", given: "configured artifact content store", expect: "GET /artifacts/:id/content returns markdown report with topic, participants, evidence, messages, judge, disagreement" }`
- `{ name: "final_report_no_content_store", lens: "happy_shadow_nil", given: "in-memory daemon without artifact content writer", expect: "artifact metadata contentStored false and content route returns missing_artifact_content" }`
- `{ name: "error_participant_run_failure", lens: "error_path", given: "fake run service fixture returns failed participant run", expect: "debate failed, participant failed, failure judge event attempted, inspectable error state" }`
- `{ name: "error_message_router_failure", lens: "error_path", given: "message router fixture throws during first turn", expect: "debate failed, no later turns, error code visible" }`
- `{ name: "error_final_report_write_failure", lens: "error_path", given: "artifact content writer throws", expect: "debate marked failed and does not claim completed final report content" }`
- `{ name: "sqlite_reopen_preserves_debate", lens: "integration", given: "create debate in file SQLite then close/reopen", expect: "debate state, participant run ids, message ids, judge, artifact id, and terminal status persist" }`
- `{ name: "sqlite_pre_r9_migrates", lens: "integration", given: "database with pre-R9 tables and sample run/message/evidence/artifact rows", expect: "openSqliteStorage adds debates table/indexes without losing existing rows" }`
- `{ name: "debate_events_replay", lens: "integration", given: "GET /debates/:id/events", expect: "SSE contains debate.round.started, message.sent, debate.agent.argument, debate.agent.rebuttal, debate.judge.summary, artifact.created" }`
- `{ name: "debate_events_live_bounded", lens: "integration", given: "GET /debates/:id/events?live=1&stopAfter=N", expect: "stream closes after N debate events and excludes run-only events without debateId" }`
- `{ name: "debate_events_last_event_id", lens: "integration", given: "GET /debates/:id/events with Last-Event-ID of first event", expect: "replay skips through that event" }`
- `{ name: "unknown_debate_inspect", lens: "error_path", given: "GET /debates/debate_missing", expect: "404 debate_not_found" }`
- `{ name: "unknown_debate_events", lens: "error_path", given: "GET /debates/debate_missing/events", expect: "404 debate_not_found before SSE body" }`
- `{ name: "daemon_configured_storage_smoke", lens: "integration", given: "configured daemon creates evidence and debate then reopens", expect: "inspect, replay events, artifact metadata, and artifact content all succeed after reopen" }`
- `{ name: "daemon_in_memory_smoke", lens: "integration", given: "in-memory daemon creates fake debate", expect: "inspect shows metadata and final artifact with contentStored false" }`
- `{ name: "existing_route_regression", lens: "integration", given: "existing run, middleware, approval, registry, runtime-mode, artifact tests", expect: "all remain green" }`

`integration_contracts`:
- `exports`:
  - `{ name: "debateSchema", kind: "constant", signature: "Zod schema for Debate with R9 evidenceIds, messageIds, eventIds, budget, judge, stopReason, finalReportArtifactId, finalReportPath, updatedAt, completedAt, error" }`
  - `{ name: "DebateStore", kind: "interface", signature: "GenericStore<Debate> & { list?(filter: { limit: number; before?: ListCursor }): Promise<{ debates: Debate[]; nextCursor: ListCursor | null }> }" }`
  - `{ name: "EventStore.listByDebate", kind: "function", signature: "listByDebate(debateId: string) => Promise<SwitchyardEvent[]>" }`
  - `{ name: "ArtifactStore.listByDebate", kind: "function", signature: "listByDebate(debateId: string) => Promise<Artifact[]>" }`
  - `{ name: "MessageRouter.createWithEvent", kind: "function", signature: "createWithEvent(input: CreateMessageInput & { debateId?: string; participantId?: string }) => Promise<{ message: RoutedMessage; event: SwitchyardEvent }>" }`
  - `{ name: "DebateService", kind: "class", signature: "create(input: CreateDebateInput, options?: { wait?: boolean }) => Promise<{ debate: Debate; events?: SwitchyardEvent[]; finalReportArtifact?: Artifact | null }>; execute(debateId: string) => Promise<Debate>; inspect(debateId: string) => Promise<{ debate: Debate; events: SwitchyardEvent[]; messages: RoutedMessage[]; evidence: EvidenceItem[]; artifacts: Artifact[] }>; listEvents(debateId: string) => Promise<SwitchyardEvent[]>" }`
  - `{ name: "registerDebateRoutes", kind: "function", signature: "registerDebateRoutes(app: FastifyInstance, deps: { debateService: DebateService; debates: DebateStore; events: EventStore; eventBus?: EventBus }) => void" }`
  - `{ name: "streamEntityEvents", kind: "function", signature: "streamEntityEvents(input: { replay: SwitchyardEvent[]; destination: SseWritable; live: boolean; eventBus?: EventBus; matches: (event: SwitchyardEvent) => boolean; stopAfter?: number; lastEventId?: string }) => StreamRunEventsHandle" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/core/src/services/debate-service.ts`
  - `packages/protocol-rest/src/debate-routes.ts`
  - `packages/storage/src/sqlite/debate-store.ts`
  - `apps/daemon/src/app.ts`
  - `docs/development/API.md`
  - `docs/development/DEVELOPMENT.md`

## Risks

- Single task owns a large cross-package slice by request. Reviewer should focus on backward compatibility and hidden side effects in run/message/event/artifact paths.
- Debate event sequence is debate-scoped when `debateId` is present. Existing run event callers must tolerate participant run message events whose sequence is meaningful for debate replay, not participant runtime replay.
- Final report artifact persistence has two valid modes: configured content storage writes markdown; in-memory mode stores metadata with `contentStored:false`. Tests must cover both so absence of content storage is not mistaken for a failed debate.

## Integration Points

- `DebateService` calls `RunService.createRun/startRun`; it never invokes adapters directly.
- `DebateService` calls `ContextBuilder.build` for participant context; it does not create a second context packet store.
- `DebateService` calls `MessageRouter.createWithEvent`; it never writes to `MessageStore` directly.
- `registerDebateRoutes` maps `DebateServiceError` codes to `HttpProblem` and `sendHttpError`.
- Debate SSE reuses `@switchyard/protocol-sse` so run streaming behavior remains the baseline.
- Daemon creates one shared `MessageRouter` instance for middleware and debate routes so event bus behavior is consistent.

## Phase Acceptance Criteria

- [ ] Debate create, inspect, and events routes are shipped with unified error envelopes.
- [ ] Durable debate state storage is shipped for SQLite and test/in-memory stores.
- [ ] Fake participant runs are created through existing run services and are traceable from inspect output.
- [ ] Bounded round execution routes participant messages through the message router and records debate events.
- [ ] Evidence references are validated and included in events, context, inspect output, and the final report.
- [ ] Stop limits and budget fields are mandatory, visible, and enforced.
- [ ] Deterministic judge output and final report artifact are produced for completed fake debates.
- [ ] Local docs and smoke tests prove the no-spend fake debate path and key failure paths.
- [ ] Existing run, middleware, registry, runtime-mode, approval, input, event, and artifact behavior remains backward compatible.

## Self-Review

1. Spec coverage: every spec acceptance criterion maps to `P8-T1-r9-debate-v1` acceptance and test cases.
2. Placeholder scan: all task details are concrete; no deferred-marker language, vague edge-case wording, or copy-by-reference phrasing remains.
3. Type consistency: task exports and instructions use the same `DebateService`, `createWithEvent`, `listByDebate`, and `streamEntityEvents` signatures.
4. Ownership disjoint: there is one task, so all owned files are disjoint by construction.
5. Context files real: all seven `context_files` paths exist in this worktree.
6. Acceptance testable: every acceptance item is objectively testable through listed checks or route responses.
7. Dependency order sane: one task has no dependencies.
8. Checks runnable: all listed commands target existing pnpm package scripts.
9. Error/rescue map present: runtime, REST, storage, event, message, judge, artifact, SSE, and daemon failure paths are enumerated.
10. Observability present: required logs and success/failure metrics are defined.
11. Test cases enumerate acceptance and shadow paths: happy, nil, empty, error, edge-limit, and integration lenses are present.
12. Integration contracts walk: there are no cross-task imports; all exports are produced by this task.
13. Contract types match: exported signatures match the service, port, router, route, and SSE instructions.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error_rescue_map entry has a matching `error_path`, `happy_shadow_nil`, `happy_shadow_empty`, `edge_limit`, or `integration` test case.
- [x] Every `integration_contracts.imports_from_other_tasks` resolves to a real export elsewhere; this plan has no cross-task imports.
- [x] Every `context_files` path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is present.
- [x] Complexity is L; a split was considered, but the user requested one implementer/reviewer and the scope is a single tightly coupled workflow.
