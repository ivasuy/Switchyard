# Phase 8 Spec: R9 Debate V1

Date: 2026-05-30

Roadmap release: R9: Debate V1

Branch: `agent/phase-8-r9-debate-v1`

Previous phase head: `da97c38793312e0b83669f92d907d6497cd707ca`

Spec target: `docs/superpowers/specs/2026-05-30-phase-8-r9-debate-v1.md`

## Summary

R9 ships the first bounded debate product workflow in Switchyard. The release proves that a debate can be created, executed, inspected, event-streamed, and summarized through the existing run, message, evidence, event, and artifact primitives.

The product decision is deliberately narrow: V1 is fake-first and deterministic. It must complete a two-participant local fake debate before Switchyard spends model budget, introduces real research tools, or coordinates stateful real runtimes.

## Scope Gate

In scope:

- Debate create, inspect, and event routes.
- Durable local debate state storage.
- Exactly two fake participants per debate.
- Participant run creation through the existing run service and fake deterministic runtime.
- A bounded round executor with explicit hard limits.
- Message router integration for participant-to-participant debate turns.
- Evidence id references from existing evidence records.
- Stop conditions and budget limits that are stored on every debate.
- A deterministic judge/synthesizer with inspectable output.
- A final markdown report artifact for every completed fake debate.
- Local API and development smoke docs for creating, replaying, streaming, inspecting, and fetching the report from a fake debate.

Out of scope:

- Hosted or hybrid debate execution.
- SDK, CLI, TUI, dashboard, or packaging work.
- Real web search, browser, GitHub, repo, shell, fetch, or research-tool execution.
- Unbounded autonomous swarms, dynamic participant spawning, background agent teams, or recursive delegation.
- Complex research tools, citation fetching, evidence scraping, source ranking, or model-based judging.
- Running real Claude, Codex, OpenCode, AgentField, Generic HTTP, or other non-fake participants inside debate orchestration.
- A second runtime system, prompt-glue orchestration outside Switchyard stores, or debate state hidden only in logs.

## Existing Context

This spec is grounded in the Phase 8 worktree and the Phase 7 closeout state. R9 extends existing local daemon primitives; it does not replace them.

`PRODUCT.md` defines the R9 product boundary:

```md
### R9: Debate V1

Status: planned.

Goal: build bounded multi-agent debate on top of runs, messages, context, evidence, and artifacts.
```

`PRODUCT.md` also names the exact release surface:

```md
- debate create/inspect/events routes.
- debate state storage.
- fake participant debate.
- participant run creation.
- bounded round executor.
- message router integration.
- evidence references.
- stop conditions and budget limits.
- judge/synthesizer placeholder or minimal deterministic fake judge for v1.
- final report artifact.
- local debate smoke docs.
```

The current debate contract exists but is only a data shape. It has no shipped service or storage yet:

```ts
export const debateStatusSchema = z.enum(["created", "context_building", "researching", "arguing", "rebuttal", "judging", "consensus_found", "no_consensus", "stopped_by_user", "completed", "failed"]);

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

`packages/core/src/services/debate-service.ts` is still a shell:

```ts
export class DebateService {
  protected notImplemented(method: string): never {
    throw createNotImplementedError("debate-service", method);
  }
}
```

The event contract already has debate-level event fields and debate event names:

```ts
export const eventTypeSchema = z.enum([
  "message.sent",
  "artifact.created",
  "debate.round.started",
  "debate.agent.argument",
  "debate.agent.rebuttal",
  "debate.evidence.added",
  "debate.judge.summary",
  "debate.consensus",
  "approval.requested",
  "run.completed",
  "run.cancelled",
  "run.failed"
]);

export const eventSchema = z.object({
  id: eventIdSchema,
  type: eventTypeSchema,
  runId: runIdSchema.optional(),
  debateId: debateIdSchema.optional(),
  participantId: participantIdSchema.optional(),
  provider: providerIdSchema.or(z.string()).optional(),
  model: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateSchema
});
```

Messages are already durable and routable between runs or channels:

```ts
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

The message router already validates run ids, stores the message, and emits `message.sent`:

```ts
const message: RoutedMessage = {
  id: `message_${crypto.randomUUID()}`,
  content: trimmedContent,
  attachments: input.attachments ?? [],
  deliveryStatus: "delivered",
  createdAt: now,
  deliveredAt: now
};

await this.deps.messages.create(message);

const eventRunId = input.toRunId ?? input.fromRunId;
const event = await this.createMessageEvent(eventRunId, message);
await this.deps.events.append(event);
```

Evidence records already support debate ids and safe local metadata only:

```ts
export const evidenceItemSchema = z.object({
  id: evidenceIdSchema,
  debateId: debateIdSchema.optional(),
  sourceType: evidenceSourceTypeSchema,
  url: z.string().url().optional(),
  title: z.string().min(1),
  snippet: z.string().optional(),
  fetchedContentPath: z.string().optional(),
  reliability: evidenceReliabilitySchema,
  createdAt: isoDateSchema
});
```

Artifacts already support debate ids and a final report-friendly `summary` type:

```ts
export const artifactTypeSchema = z.enum(["transcript", "debate_transcript", "model_transcript", "raw_log", "event_log", "evidence_pack", "diff", "screenshot", "test_log", "proof", "summary"]);

export const artifactSchema = z.object({
  id: artifactIdSchema,
  runId: runIdSchema.optional(),
  debateId: debateIdSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  type: artifactTypeSchema,
  path: z.string().min(1),
  metadata: metadataSchema.default({}),
  createdAt: isoDateSchema
});
```

SQLite already has debate-aware event, artifact, memory, and evidence columns, but it does not have a `debates` table:

```ts
export const runEvents = sqliteTable("run_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  runId: text("run_id"),
  debateId: text("debate_id"),
  participantId: text("participant_id"),
  provider: text("provider"),
  model: text("model"),
  sequence: integer("sequence").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull()
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  debateId: text("debate_id"),
  provider: text("provider"),
  model: text("model"),
  type: text("type").notNull(),
  path: text("path").notNull(),
  metadataJson: text("metadata_json").notNull(),
  createdAt: text("created_at").notNull()
});
```

Run routes already establish the daemon route style, wait semantics, SSE event replay/live behavior, and unified error envelope. R9 debate routes must follow this style:

```ts
app.post("/runs", async (request, reply) => {
  const wait = shouldWaitForCompletion(request.query);
  const body = parseCreateRunBody(request.body);
  const run = await deps.runService.createRun(createInput);
  if (wait) {
    const completed = await deps.runService.startRun(run.id);
    const events = await deps.events.listByRun(run.id);
    return reply.code(201).send({ run: completed, response: collectRunResponse(events) });
  }
  return reply.code(202).send({ run });
});
```

R7 middleware routes already expose the exact evidence and message primitives R9 must reuse:

```ts
app.post("/evidence", async (request, reply) => {
  const body = ensureRecord(request.body, "Request body must be an object");
  const evidence = await deps.evidenceService.create({
    debateId: optionalString(body, "debateId"),
    sourceType: parseRequiredEnum(body["sourceType"], evidenceSourceTypeSchema, "sourceType"),
    title: requiredString(body, "title"),
    reliability: parseRequiredEnum(body["reliability"], evidenceReliabilitySchema, "reliability")
  });
  return reply.code(201).send({ evidence });
});
```

The fake deterministic runtime is the only participant runtime allowed in R9:

```ts
readonly manifest: RuntimeAdapterManifest = {
  adapterId: "fake",
  providerId: "provider_test",
  runtimeId: "runtime_fake",
  runtimeModeId: "runtime_mode_fake_deterministic",
  runtimeModeSlug: "fake.deterministic",
  name: "Fake deterministic runtime",
  adapterType: "process",
  kind: "deterministic_fake",
  capabilities: ["run.start", "run.cancel", "event.normalized", "event.streaming", "artifact.transcript", "tool.fake_echo", "auth.none"]
};
```

## Product Definitions

Debate:

- A persisted product workflow record with a topic, exactly two participants, evidence references, hard limits, progress state, stop reason, deterministic judge output, and optional final report artifact id.
- It is not a runtime adapter and does not execute provider protocols directly.

Participant run:

- A normal Switchyard run created through `RunService.createRun` and completed through `RunService.startRun`.
- R9 creates one participant seed run per participant before the round executor starts.
- Participant seed runs must use `runtime: "fake"`, `provider: "test"`, `model: "test-model"`, `adapterType: "process"`, `runtimeMode: "fake.deterministic"`, and `placement: "local"`.
- The run metadata must include `debateId`, `participantId`, `participantRole`, `debateTopic`, and `debateRunKind: "participant_seed"`.

Debate turn:

- One participant message in a debate round.
- The message is persisted by `MessageRouter.create`.
- The message channel is `debate:<debateId>`.
- The message attachments include debate metadata and evidence references.
- A debate event with `debateId` and `participantId` is appended for the same turn.

Final report artifact:

- A markdown `summary` artifact with `debateId`.
- Path: `debates/<debateId>/final-report.md`.
- Content is deterministic and includes topic, final status, stop reason, limits, participant run ids, message ids, evidence ids, judge summary, and disagreement summary.
- When the artifact content store is configured, content must be written through the same filesystem artifact content store used by run transcripts and `metadata.contentStored` must be `true`.
- When the artifact content store is absent, the artifact record is still stored with `metadata.contentStored: false`; content retrieval then uses the existing `404 missing_artifact_content` behavior.

## R9 Hard Limits

Every debate has applied limits stored in the debate record. Missing `limits` uses the defaults below. Supplied limits are clamped only when explicitly stated; otherwise invalid values fail fast with `400 invalid_input`.

R9 defaults:

```json
{
  "maxRounds": 2,
  "maxTurnsPerAgent": 2,
  "maxSearchesPerAgent": 0,
  "maxTotalMessages": 4,
  "maxDurationSeconds": 30,
  "maxCostUsd": 0,
  "requireCitations": false,
  "requireDisagreementSummary": true,
  "stopOnConsensus": false,
  "stopOnLowNewInformation": false,
  "humanStopAllowed": false
}
```

R9 hard caps:

- `topic` must be a non-empty string after trimming and must be <= 2048 UTF-8 bytes.
- `participants` must contain exactly two entries.
- Participant `role` must be non-empty after trimming and must be <= 64 UTF-8 bytes.
- `evidenceIds` defaults to `[]` and must contain <= 10 ids.
- `maxRounds` must be an integer from 1 to 3.
- `maxTurnsPerAgent` must be an integer from 1 to 3.
- `maxTotalMessages` must be an integer from 1 to 12.
- `maxDurationSeconds` must be an integer from 1 to 60.
- `maxCostUsd` must be exactly `0` in R9.
- `maxSearchesPerAgent` must be exactly `0` in R9.
- `humanStopAllowed` must be `false` in R9 because no manual debate stop route ships in this phase.
- `requireCitations`, `requireDisagreementSummary`, `stopOnConsensus`, and `stopOnLowNewInformation` are accepted booleans, but R9's fake judge must record that citation validation and low-new-information scoring are deterministic local checks only.

If any hard cap is hit during execution, the debate must stop before creating another message, persist a terminal state, append a judge summary event, and attempt to write a final report artifact.

## Contract Changes

### Debate Contract

Extend the debate contract without removing existing fields.

Required additions:

- `evidenceIds: string[]` default `[]`.
- `messageIds: string[]` default `[]`.
- `eventIds: string[]` default `[]`.
- `finalReportArtifactId?: string`.
- `stopReason?: "max_rounds" | "max_total_messages" | "max_turns_per_agent" | "max_duration_seconds" | "max_cost_usd" | "consensus" | "completed" | "failed"`.
- `judge?: { consensus: "consensus_found" | "no_consensus"; summary: string; disagreementSummary: string; winner: "none"; evidenceIds: string[]; messageIds: string[] }`.
- `budget: { status: "within_budget" | "near_limit" | "exceeded" | "unknown"; maxCostUsd: number; spentCostUsd: number }`.
- `updatedAt?: string`.
- `error?: { code: string; message: string }`.

Participant additions:

- `runIds: string[]` default `[]`.
- Existing `runId` remains as the participant's primary seed run id for backward compatibility.

The contract may also add an internal `DebateTurn` type, but persisted public inspect can use `messageIds`, participant `turnsUsed`, and event payloads instead of exposing a separate top-level turn list.

### Store Ports

Add a real debate store:

```ts
export interface DebateStore extends GenericStore<Debate> {
  list?(filter: { limit: number; before?: ListCursor }): Promise<{ debates: Debate[]; nextCursor: ListCursor | null }>;
}
```

`list` is optional for R9 because no `GET /debates` list route is in scope. It can be omitted by implementation if no caller needs it.

Extend event storage:

```ts
export interface EventStore {
  append(event: SwitchyardEvent): Promise<SwitchyardEvent>;
  listByRun(runId: string): Promise<SwitchyardEvent[]>;
  listByDebate(debateId: string): Promise<SwitchyardEvent[]>;
}
```

Extend artifact storage:

```ts
export interface ArtifactStore extends GenericStore<Artifact> {
  listByRun(runId: string): Promise<Artifact[]>;
  listByDebate(debateId: string): Promise<Artifact[]>;
}
```

Extend message routing input only; the persisted `RoutedMessage` shape does not need a new top-level `debateId` field in R9:

```ts
export interface CreateMessageInput {
  fromRunId?: string;
  toRunId?: string;
  channel?: string;
  debateId?: string;
  participantId?: string;
  content: string;
  attachments?: Array<Record<string, unknown>>;
}
```

When `debateId` is supplied, the router must include it on the emitted `message.sent` event. When `participantId` is supplied, the router must include it on that event. The message record remains discoverable by channel and by event payload.

The implementation must make the emitted `message.sent` event id available to `DebateService`, either by returning an internal `{ message, event }` result from router calls or by reading the new event through `EventStore.listByDebate(debateId)` before updating debate state. Public `POST /messages` response shape remains `{ "message": RoutedMessage }`.

### SQLite Storage

Add table `debates`:

```sql
CREATE TABLE IF NOT EXISTS debates (
  id TEXT PRIMARY KEY NOT NULL,
  topic TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  participants_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  message_ids_json TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  judge_json TEXT,
  final_report_artifact_id TEXT,
  final_report_path TEXT,
  stop_reason TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  completed_at TEXT
);
```

Add indexes:

- `debates_created_at_idx` on `(created_at DESC, id DESC)`.
- `debates_status_idx` on `(status)`.
- `run_events_debate_sequence_idx` on `(debate_id, sequence)`.
- `artifacts_debate_id_idx` on `(debate_id)`.

Fresh databases must create the new table and indexes. Existing databases must be upgraded additively without dropping or rewriting existing run, message, evidence, artifact, approval, registry, or session data.

## Debate REST API

### Create Debate

Endpoint:

```text
POST /debates
POST /debates?wait=1
```

Async create (`POST /debates`) returns `202 { "debate": Debate }` after the debate record is created and the executor is scheduled on a microtask.

Synchronous create (`POST /debates?wait=1`) executes the bounded fake debate before responding and returns `201 { "debate": Debate, "events": SwitchyardEvent[], "finalReportArtifact": Artifact | null }`.

Request body:

```json
{
  "topic": "Should Switchyard prove fake debate before real runtimes?",
  "participants": [
    {
      "role": "affirmative",
      "runtime": "fake",
      "provider": "test",
      "model": "test-model",
      "adapterType": "process",
      "runtimeMode": "fake.deterministic"
    },
    {
      "role": "skeptic",
      "runtime": "fake",
      "provider": "test",
      "model": "test-model",
      "adapterType": "process",
      "runtimeMode": "fake.deterministic"
    }
  ],
  "evidenceIds": ["evidence_123"],
  "limits": {
    "maxRounds": 2,
    "maxTurnsPerAgent": 2,
    "maxTotalMessages": 4,
    "maxDurationSeconds": 30
  }
}
```

Validation rules:

- Body must be an object.
- `topic` is required.
- `participants` is required and must contain exactly two entries.
- Participant runtime fields are optional only when they are omitted to use the R9 fake defaults. If present, they must match the fake defaults exactly.
- Any participant runtime other than `fake.deterministic` fails with `400 invalid_input`.
- `evidenceIds` may be omitted or empty. Supplied ids must exist.
- If an evidence record has `debateId` set to a different debate id, create fails with `400 invalid_input`.
- `limits` may be omitted. Supplied fields override defaults only within R9 hard caps.
- The create route must reject reserved internal fields such as `id`, `status`, `messageIds`, `eventIds`, `judge`, `budget`, `finalReportArtifactId`, `createdAt`, `updatedAt`, and `completedAt`.

Error codes:

- `400 invalid_input` for malformed body, unsupported participant runtime, invalid limits, missing topic, wrong participant count, too-large topic, or reserved fields.
- `404 evidence_not_found` for unknown evidence ids.
- `500 internal_error` for unexpected store, event, run, message, or artifact failures. The debate must be marked `failed` if the debate record was created before the failure.

### Inspect Debate

Endpoint:

```text
GET /debates/:id
```

Response:

```json
{
  "debate": {
    "id": "debate_...",
    "topic": "Should Switchyard prove fake debate before real runtimes?",
    "mode": "same_provider_model_debate",
    "status": "no_consensus",
    "participants": [
      {
        "id": "participant_...",
        "runId": "run_...",
        "runIds": ["run_..."],
        "runtime": "fake",
        "provider": "test",
        "model": "test-model",
        "role": "affirmative",
        "status": "completed",
        "turnsUsed": 2
      }
    ],
    "limits": {
      "maxRounds": 2,
      "maxTurnsPerAgent": 2,
      "maxSearchesPerAgent": 0,
      "maxTotalMessages": 4,
      "maxDurationSeconds": 30,
      "maxCostUsd": 0,
      "requireCitations": false,
      "requireDisagreementSummary": true,
      "stopOnConsensus": false,
      "stopOnLowNewInformation": false,
      "humanStopAllowed": false
    },
    "evidenceIds": ["evidence_123"],
    "messageIds": ["message_..."],
    "eventIds": ["event_..."],
    "budget": { "status": "within_budget", "maxCostUsd": 0, "spentCostUsd": 0 },
    "stopReason": "max_rounds",
    "judge": {
      "consensus": "no_consensus",
      "summary": "The fake participants completed two bounded rounds and retained disagreement.",
      "disagreementSummary": "affirmative favors proving fake debate first; skeptic asks for more runtime proof before promotion.",
      "winner": "none",
      "evidenceIds": ["evidence_123"],
      "messageIds": ["message_..."]
    },
    "finalReportArtifactId": "artifact_...",
    "finalReportPath": "debates/debate_.../final-report.md",
    "createdAt": "2026-05-30T00:00:00.000Z",
    "updatedAt": "2026-05-30T00:00:01.000Z",
    "completedAt": "2026-05-30T00:00:01.000Z"
  },
  "events": [],
  "messages": [],
  "evidence": [],
  "artifacts": []
}
```

Inspect response requirements:

- `debate` is always present on success.
- `events` are all persisted events with `debateId`, ordered by `sequence ASC`.
- `messages` are all `messageIds` referenced by the debate, ordered by creation order from the debate state.
- `evidence` are all referenced evidence records, ordered as supplied in `evidenceIds`.
- `artifacts` include artifacts with `debateId`, including the final report when present.
- Unknown id returns `404 debate_not_found`.

### Debate Events

Endpoint:

```text
GET /debates/:id/events
GET /debates/:id/events?live=1
GET /debates/:id/events?live=1&stopAfter=N
```

Behavior mirrors `GET /runs/:id/events`:

- Replay-only mode emits all persisted debate events as SSE and closes.
- `live=1` replays persisted events, then streams new debate events from the event bus.
- `live=1&stopAfter=N` closes after `N` total events and is required for deterministic tests.
- `Last-Event-ID` header and `lastEventId` query parameter skip replay up to and including that id.
- Response `Content-Type` is `text/event-stream; charset=utf-8`.
- Heartbeat and idle-close semantics match run events.

The SSE filter must use `event.debateId === debateId`. It must not accidentally stream all run events from participant runs unless those events explicitly carry the debate id.

Unknown id returns `404 debate_not_found` using the unified error envelope before any SSE body is written.

## Executor Behavior

### Create Phase

1. Validate request and apply R9 default limits.
2. Generate the `debate_` id and participant ids in memory.
3. Validate all `evidenceIds` before any debate, run, message, event, or artifact record is persisted.
4. Create a `Debate` record with:
   - `mode: "same_provider_model_debate"`.
   - `status: "created"`.
   - generated `participant_` ids.
   - normalized fake participant runtime fields.
   - empty `runIds`, `messageIds`, and `eventIds`.
   - `budget.spentCostUsd: 0`.
5. Append `debate.evidence.added` for each evidence reference.
6. Persist the updated debate state after each event id is recorded.

### Participant Run Phase

For each participant:

1. Build a `target: "participant"` context packet with:
   - section `debate` containing the topic and role.
   - referenced evidence ids.
2. Create a normal run through `RunService.createRun`.
3. Start and complete the run through `RunService.startRun`.
4. Store the completed run id on `participant.runId` and append it to `participant.runIds`.
5. Set participant status to `completed`.
6. If the run fails, times out, or is cancelled, set participant status accordingly, mark debate `failed`, append a `debate.judge.summary` failure event, and attempt a failure report artifact.

Participant run task template:

```text
Debate participant seed run.

Topic: <topic>
Role: <role>
Participant: <participantId>

Use the fake deterministic runtime output as the auditable seed for this debate participant.
```

This task is intentionally deterministic and uses the existing fake runtime. It must not call real tools or real provider models.

### Round Phase

The round executor runs sequentially and never recursively spawns work.

For each round from `1` through `limits.maxRounds`:

1. If a stop condition is already met, stop before appending a round event.
2. Set debate status to `arguing` for round 1 and `rebuttal` for rounds after 1.
3. Append `debate.round.started` with `{ round, phase, limitsSnapshot }`.
4. For each participant in request order:
   - Stop before turn creation if `maxTotalMessages`, `maxTurnsPerAgent`, `maxDurationSeconds`, or `maxCostUsd` would be exceeded.
   - Generate deterministic fake turn content.
   - Route a message through `MessageRouter.create`.
   - Append `debate.agent.argument` for round 1, or `debate.agent.rebuttal` for later rounds.
   - Increment `participant.turnsUsed`.
   - Add the new message id and event ids to the debate state.
   - Persist debate state before the next turn.

Deterministic fake content:

```text
[round <round> <phase>] <role>: <stance sentence> Topic="<topic>". Evidence=<evidence ids or "none">.
```

Stance sentence:

- Participant 1: `Fake affirmative position: prove the bounded workflow first.`
- Participant 2: `Fake skeptical position: require visible limits, runs, messages, evidence, and artifacts before promotion.`
- Rebuttal rounds prepend `Rebuttal:` and reference the previous participant message id.

Message routing call requirements:

```ts
await messageRouter.create({
  debateId,
  participantId,
  fromRunId: currentParticipant.runId,
  toRunId: otherParticipant.runId,
  channel: `debate:${debateId}`,
  content,
  attachments: [
    {
      type: "debate_turn",
      debateId,
      participantId,
      round,
      phase,
      evidenceIds
    }
  ]
});
```

The debate must not insert message rows directly. If message routing fails, the failure is visible as a failed debate state.

### Stop Conditions

Stop checks run before every round and before every participant turn.

Stop reason selection order:

1. `max_duration_seconds`.
2. `max_cost_usd`.
3. `max_total_messages`.
4. `max_turns_per_agent`.
5. `consensus`.
6. `max_rounds`.

R9 fake debates always spend `0` dollars. `max_cost_usd` is still stored and checked because the budget contract must exist before real runtimes can use it.

When a stop condition fires:

- No additional participant message is created after the condition is known.
- Debate state records `stopReason`.
- Debate status transitions to `judging`.
- The deterministic judge runs.

### Deterministic Judge/Synthesizer

The judge is a local pure function. It must not call an adapter, model, search service, browser, shell, or network.

Inputs:

- Debate topic.
- Participants and roles.
- Routed debate message contents.
- Evidence ids and titles.
- Applied limits.
- Stop reason.

Outputs:

- `consensus`: `"consensus_found"` only if both participants' final normalized stance sentence is identical. Default fake roles intentionally produce `"no_consensus"`.
- `winner`: always `"none"` in R9.
- `summary`: one deterministic paragraph.
- `disagreementSummary`: required when `requireDisagreementSummary` is true.
- `evidenceIds` and `messageIds` copied from debate state.

Terminal status:

- `consensus_found` if judge found consensus and `stopOnConsensus` is true.
- `no_consensus` for normal fake completion without consensus.
- `failed` for validation, participant run, message routing, event persistence, or artifact persistence failures that prevent an inspectable completed debate.

Append exactly one `debate.judge.summary` event per execution attempt. If the judge finds consensus, append `debate.consensus` after the judge event.

### Final Report Artifact

After judging, write a final report artifact.

Content format:

```md
# Debate Report: <debateId>

Topic: <topic>
Status: <status>
Stop reason: <stopReason>
Budget: spent 0 of 0 USD

## Participants
- <participantId> (<role>) run=<runId> turns=<turnsUsed>

## Evidence
- <evidenceId> - <title> (<reliability>)

## Messages
- <messageId> round=<round> participant=<participantId>

## Judge Summary
<summary>

## Disagreement Summary
<disagreementSummary>
```

Artifact record:

```json
{
  "id": "artifact_...",
  "debateId": "debate_...",
  "type": "summary",
  "path": "debates/debate_.../final-report.md",
  "metadata": {
    "contentStored": true,
    "kind": "debate_final_report",
    "stopReason": "max_rounds",
    "messageCount": 4,
    "participantRunIds": ["run_...", "run_..."],
    "evidenceIds": ["evidence_123"]
  },
  "createdAt": "2026-05-30T00:00:01.000Z"
}
```

After storing the artifact, append `artifact.created` with `debateId` and payload `{ artifactId, path, type: "summary" }`. Update debate `finalReportArtifactId` and `finalReportPath`.

## User-Visible Behavior

Scenario: create a bounded fake debate and inspect the final state.

1. User creates optional evidence with `POST /evidence`.
2. User calls `POST /debates?wait=1` with a topic, exactly two fake participants, optional evidence ids, and bounded limits.
3. Switchyard creates two normal fake runs, executes bounded rounds, routes messages, judges deterministically, and writes a final report artifact.
4. Response contains terminal debate state, events, and final report artifact metadata.
5. User calls `GET /debates/:id` and sees participant run ids, message ids, evidence ids, stop reason, budget, judge output, and artifact id.
6. User calls `GET /debates/:id/events` or `?live=1&stopAfter=N` and sees the persisted debate event stream.
7. User calls `GET /artifacts/:id/content` and receives the markdown final report when local artifact content storage is configured.

Scenario: unsupported real participant is requested.

1. User calls `POST /debates` with `runtime: "codex"` or `runtime: "claude_code"` for a participant.
2. Switchyard returns `400 invalid_input`.
3. No participant runs, messages, debate events, or artifacts are created.

Scenario: evidence reference is missing.

1. User calls `POST /debates` with `evidenceIds: ["evidence_missing"]`.
2. Switchyard returns `404 evidence_not_found`.
3. No participant runs or messages are created.
4. If the debate record was already created, it is marked `failed` with `error.code: "evidence_not_found"`; the preferred implementation validates evidence before creating the debate record.

Scenario: a low message limit stops early.

1. User calls `POST /debates?wait=1` with `maxTotalMessages: 1`.
2. Switchyard creates participant runs, emits the first participant message, stops before the second message, judges the partial debate, and stores `stopReason: "max_total_messages"`.
3. Inspect shows exactly one message id and a final report artifact.

## Data Flow Shadow Paths

| Flow | Happy path | Nil path | Empty path | Error path |
| --- | --- | --- | --- | --- |
| Debate create request | Object body with valid topic, two fake participants, optional evidence, and limits creates or executes a debate. | Missing body returns `400 invalid_input` with path `body`; no debate state is created. | Empty object returns `400 invalid_input` for `topic` and `participants`; whitespace topic returns `400 invalid_input` for `topic`. | Unsupported runtime, bad limit, too-large topic, reserved fields, or malformed participant returns `400 invalid_input`; unexpected store failure returns `500 internal_error` and logs `debate.create_failed`. |
| Participant validation | Exactly two participants normalize to fake deterministic runtime fields. | Missing `participants` returns `400 invalid_input`. | Empty array or one participant returns `400 invalid_input` with issue "must contain exactly two participants". | Any non-fake runtime/provider/model/adapter/runtimeMode returns `400 invalid_input`; no run is created. |
| Evidence reference loading | Existing evidence ids are loaded, included in context/report, and produce `debate.evidence.added` events. | Omitted `evidenceIds` behaves as `[]` and debate proceeds with "Evidence=none". | Empty `evidenceIds: []` is valid and produces no evidence events. | Unknown evidence id returns `404 evidence_not_found`; evidence bound to a different debate returns `400 invalid_input`; storage read failure returns `500 internal_error`. |
| Debate state storage | Debate is created, updated after each step, and survives SQLite reopen. | Debate store dependency missing in daemon wiring causes startup/test failure, not silent route success. | Debate with zero messages is valid only if participant run phase fails before rounds; it must be terminal `failed` with error details. | Update failure marks the route `500 internal_error`; if a prior record exists, best-effort update records `failed`. |
| Participant run creation | Each participant gets one normal fake run with debate metadata and completed status. | Missing `RunService` dependency is an internal wiring error and returns `500 internal_error` in tests. | Empty participant task cannot happen after validation; generated seed task is always non-empty. | Run failure, timeout, cancellation, or adapter error marks participant and debate failed, appends failure judge summary, and attempts failure report artifact. |
| Context build for participant runs | Context builder renders topic, role, and evidence into participant run task metadata. | Missing context builder is `500 internal_error`; no hidden prompt-only fallback. | No evidence yields only the explicit debate section. | Unknown evidence during context build returns `404 evidence_not_found`; context build failure logs `context.build_failed`. |
| Round executor | Rounds append events, route messages, increment turns, and stop at limits. | Missing participant run id marks debate `failed` before first round. | Limit allowing only one message produces a partial but terminal debate with final report. | Message router failure, event append failure, or time cap breach stops execution and persists visible terminal state. |
| Message router integration | Every debate turn is persisted through `MessageRouter.create`, emits `message.sent`, and is referenced by debate state. | Missing `fromRunId` or `toRunId` cannot happen after participant run validation; if it does, debate fails visibly. | Empty generated content cannot happen; if router receives whitespace it returns `400 invalid_input` and debate fails. | Unknown participant run id returns `404 run_not_found`; store failure returns `500 internal_error`. |
| Debate event replay/live | `GET /debates/:id/events` replays SSE; `live=1` streams debate events filtered by debate id. | Missing debate id in route path is Fastify not-found with existing error envelope. | Debate with no events returns an empty SSE body and closes in replay mode. | Unknown debate returns `404 debate_not_found`; malformed `stopAfter` is ignored the same way run events normalize it; disconnect unsubscribes within the existing SSE cleanup bounds. |
| Stop and budget enforcement | Limits are checked before every round and turn; stop reason is persisted. | Missing `limits` applies R9 defaults. | Partial limits object fills missing fields from defaults. | `maxCostUsd > 0`, `maxSearchesPerAgent > 0`, `humanStopAllowed: true`, negative, zero, or over-cap values return `400 invalid_input`. |
| Judge/synthesizer | Deterministic judge writes summary and disagreement output from stored messages. | No messages due to earlier participant failure writes failure summary only. | No evidence writes "No evidence supplied" in report. | Judge exception marks debate `failed`, appends failed summary event if possible, and returns `500 internal_error`. |
| Final report artifact | Completed fake debate stores `summary` artifact and content, then exposes it through existing artifact routes. | Artifact content store absent stores metadata with `contentStored: false`; inspect remains usable. | No evidence or one-message debates still produce a complete report with empty sections called out. | Content write failure marks debate `failed` if report cannot be stored; artifact lookup/content errors use existing `artifact_not_found` or `missing_artifact_content`. |
| Inspect debate | `GET /debates/:id` returns debate, events, messages, evidence, and artifacts. | Missing id route is not found through existing Fastify handling. | Debate with empty evidence/messages returns empty arrays for those fields. | Unknown id returns `404 debate_not_found`; missing referenced message/evidence/artifact is surfaced in response `debate.error` and server log, not silently skipped. |

## Observability

Logs:

- `debate.create_requested` with topic byte length, participant count, evidence count, and limit summary.
- `debate.created` with debate id.
- `debate.participant_run.created` with debate id, participant id, and run id.
- `debate.round.started` with debate id and round.
- `debate.message.routed` with debate id, participant id, message id, and round.
- `debate.stopped` with debate id and stop reason.
- `debate.final_report.created` with debate id and artifact id.
- `debate.failed` with debate id and named reason code.

Logs must not include full topic text when it exceeds 256 bytes, full message bodies above 512 bytes, raw artifact content, or any secret-bearing metadata. R9 fake defaults do not use secrets, but log redaction should follow existing runtime redaction conventions.

Metrics can remain test-level counters in R9; no dashboard is in scope. The testable success metric is: a local `POST /debates?wait=1` fake debate produces terminal debate state, two participant runs, at least one routed message, debate SSE replay, and a final report artifact.

## Security And Policy

- Debate orchestration is local-only.
- Participants must be fake deterministic runtime only.
- Real tool types remain denied by the existing R7 policy gate and are not invoked by debate service.
- Evidence ids reference already-stored metadata only; R9 does not fetch URLs, read files, scrape browsers, search the web, call GitHub, or run shell commands.
- Artifact paths must be normalized relative paths under `debates/<debateId>/`.
- Request bodies must reject reserved internal fields to prevent clients from forging final states, event ids, artifact ids, budgets, or participant run ids.
- The final report must include ids and summaries, not raw hidden prompts, environment data, or secrets.

## Implementation Requirements

Core:

- Implement `DebateService` with create, execute, inspect, and event helper methods.
- `DebateService` depends on `DebateStore`, `RunService`, `ContextBuilder`, `MessageRouter`, `EvidenceStore` or `EvidenceService`, `EventStore`, `EventBus`, `ArtifactStore`, optional artifact content writer, and logger.
- Keep executor sequential and deterministic. Do not introduce queues, worker pools, swarms, or scheduler abstractions.
- Persist debate state after every externally inspectable step.

Contracts:

- Extend `debateSchema` with the R9 fields above.
- Keep existing enum values compatible.
- Add `debate_not_found` to REST error code types and API docs.
- Do not add real participant modes to accepted create validation.

Storage:

- Add `SqliteDebateStore`.
- Add in-memory debate store in testkit.
- Extend `SqliteEventStore` with `listByDebate`.
- Extend `SqliteArtifactStore` with `listByDebate`.
- Add fresh schema and additive migration coverage for the `debates` table and new indexes.

Protocol REST:

- Add `packages/protocol-rest/src/debate-routes.ts`.
- Export debate routes from `packages/protocol-rest/src/index.ts`.
- Reuse the existing error envelope helpers.
- Share or generalize SSE helper behavior rather than forking incompatible stream semantics.
- `POST /debates?wait=1` must be deterministic for tests.

Daemon:

- Wire `DebateService`, `SqliteDebateStore`, in-memory debate store, route registration, event bus, and artifact content writer in `apps/daemon/src/app.ts`.
- In-memory daemon mode can store artifact metadata without content; configured storage mode must write content.
- Do not alter existing run, registry, middleware, approval, runtime-mode, or artifact routes except for shared helper extraction if required.

Docs:

- Update `docs/development/API.md` with debate route contracts, error code, request/response examples, and non-goals.
- Update `docs/development/DEVELOPMENT.md` with copy-paste local smoke commands.
- Update product/release docs during implementation closeout to state R9 shipped fake debate only; do not claim real debate runtimes.

## Local Smoke Documentation Requirements

The docs must include a no-spend smoke sequence equivalent to:

```bash
BASE=http://127.0.0.1:4545

EVIDENCE_ID=$(curl -s -X POST "$BASE/evidence" \
  -H 'content-type: application/json' \
  -d '{"sourceType":"manual","title":"Local debate smoke evidence","snippet":"fake debate must stay bounded","reliability":"primary"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["evidence"]["id"])')

DEBATE_JSON=$(curl -s -X POST "$BASE/debates?wait=1" \
  -H 'content-type: application/json' \
  -d "{\"topic\":\"Should Switchyard prove fake debate before real runtimes?\",\"participants\":[{\"role\":\"affirmative\",\"runtime\":\"fake\",\"provider\":\"test\",\"model\":\"test-model\",\"adapterType\":\"process\",\"runtimeMode\":\"fake.deterministic\"},{\"role\":\"skeptic\",\"runtime\":\"fake\",\"provider\":\"test\",\"model\":\"test-model\",\"adapterType\":\"process\",\"runtimeMode\":\"fake.deterministic\"}],\"evidenceIds\":[\"$EVIDENCE_ID\"],\"limits\":{\"maxRounds\":2,\"maxTurnsPerAgent\":2,\"maxTotalMessages\":4,\"maxDurationSeconds\":30}}")

DEBATE_ID=$(printf '%s' "$DEBATE_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["debate"]["id"])')
ARTIFACT_ID=$(printf '%s' "$DEBATE_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["debate"]["finalReportArtifactId"])')

curl -s "$BASE/debates/$DEBATE_ID" | python3 -m json.tool
curl -N "$BASE/debates/$DEBATE_ID/events?live=1&stopAfter=20"
curl -s "$BASE/artifacts/$ARTIFACT_ID"
curl -s "$BASE/artifacts/$ARTIFACT_ID/content"
```

Docs must also include negative smoke commands:

- Unsupported participant runtime returns `400 invalid_input`.
- Unknown evidence id returns `404 evidence_not_found`.
- `maxTotalMessages: 1` returns terminal debate state with one routed message and `stopReason: "max_total_messages"`.

## Test Requirements

Core service tests:

- `happy_fake_two_participant_debate`: creates two participant seed runs, executes two rounds, routes four messages, stores judge output, and records final report artifact metadata.
- `happy_shadow_nil_evidence`: omitted `evidenceIds` proceeds with no evidence events and report says no evidence supplied.
- `happy_shadow_empty_evidence`: empty `evidenceIds: []` proceeds identically to omitted evidence.
- `happy_shadow_empty_limit_partial`: `maxTotalMessages: 1` stops after one message and persists final state.
- `error_unsupported_participant_runtime`: non-fake runtime rejects before run creation.
- `error_participant_run_failure`: fake adapter failure fixture marks debate failed and produces inspectable error state.
- `error_message_router_failure`: router failure marks debate failed and does not continue rounds.
- `error_final_report_write_failure`: content write failure is visible and does not report a successful completed debate.

Storage tests:

- Fresh SQLite database contains `debates` table and new indexes.
- Reopening SQLite preserves debate state, participant run ids, message ids, judge output, final report artifact id, and terminal status.
- `listByDebate` on events and artifacts returns only records for that debate id in deterministic order.
- Existing pre-R9 SQLite database migrates without losing runs, run events, messages, evidence, artifacts, approvals, runtime sessions, registry records, or placement decisions.

REST tests:

- `POST /debates?wait=1` returns `201` terminal fake debate.
- `POST /debates` returns `202` and eventually `GET /debates/:id` reaches a terminal state in fake tests.
- `GET /debates/:id` returns debate, events, messages, evidence, and artifacts.
- `GET /debates/:id/events` replay contains `debate.round.started`, `message.sent`, `debate.agent.argument`, `debate.agent.rebuttal`, `debate.judge.summary`, and `artifact.created` where applicable.
- `GET /debates/:id/events?live=1&stopAfter=N` terminates deterministically.
- Unknown debate id returns `404 debate_not_found`.
- Malformed create bodies return `400 invalid_input` with useful `details.path`.

Daemon smoke tests:

- Configured storage daemon can create evidence, create a fake debate, inspect it, replay events, list final artifact metadata, fetch final artifact content, close, reopen, and inspect the same debate again.
- In-memory daemon can create a fake debate and inspect metadata without artifact content storage.
- Existing R7/R8 smoke tests for runs, middleware, runtime modes, input, approvals, and artifacts remain green.

## Acceptance Criteria

- [ ] `POST /debates` and `POST /debates?wait=1` exist and accept only bounded two-participant fake debates.
- [ ] `GET /debates/:id` returns inspectable final state including participants, participant run ids, limits, budget, evidence ids, message ids, event ids, stop reason, judge output, and final report artifact id.
- [ ] `GET /debates/:id/events` supports replay-only, `live=1`, `live=1&stopAfter=N`, and `Last-Event-ID` semantics filtered by `debateId`.
- [ ] Debate state persists durably in SQLite and survives daemon restart.
- [ ] Every participant is backed by a normal fake deterministic run created through existing run services.
- [ ] Every debate turn is routed through `MessageRouter`; debate code does not insert message rows directly.
- [ ] Existing evidence records can be referenced by id and appear in context, events, inspect output, and final report.
- [ ] Hard limits are applied to every debate and invalid R9 limit values fail with `400 invalid_input`.
- [ ] The bounded executor stops before creating messages that would exceed limits and records `stopReason`.
- [ ] The deterministic judge/synthesizer produces stable `no_consensus` output for default fake participants and never calls a model or external tool.
- [ ] Completed fake debates create a markdown `summary` final report artifact with `debateId`.
- [ ] Local storage smoke can fetch final report artifact content through existing artifact content route.
- [ ] Unsupported real runtimes and real tools remain out of scope and are rejected or never invoked.
- [ ] Local API/development docs include copy-paste no-spend fake debate smoke and negative smoke commands.
- [ ] Existing run, middleware, registry, runtime-mode, approval, input, event, and artifact behavior remains backward compatible.

## Phase

### Phase 8: R9 Debate V1

Goal: Ship a local deterministic two-participant fake debate workflow on top of Switchyard's existing run, message, evidence, event, and artifact primitives.

Acceptance:

- Debate create, inspect, and events routes are shipped with unified error envelopes.
- Durable debate state storage is shipped for SQLite and test/in-memory stores.
- Fake participant runs are created through existing run services and are traceable from inspect output.
- Bounded round execution routes participant messages through the message router and records debate events.
- Evidence references are validated and included in events, context, inspect output, and the final report.
- Stop limits and budget fields are mandatory, visible, and enforced.
- Deterministic judge output and final report artifact are produced for completed fake debates.
- Local docs and smoke tests prove the no-spend fake debate path and key failure paths.

Non-goals:

- Hosted or hybrid execution.
- SDK, CLI, TUI, or dashboard packaging.
- Real participant runtimes inside debate orchestration.
- Real web/search/browser/GitHub/repo/shell/fetch tools.
- Complex research tools, source fetching, vector retrieval, or model-based judging.
- Unbounded autonomous swarms or recursive delegation.

Complexity: L

## Deferred Concerns

- Real-runtime debates are deferred until fake debate state, limits, eventing, report artifacts, and inspection prove reliable.
- Hosted/hybrid debate execution is deferred until hosted/hybrid execution itself ships.
- Manual stop route, debate listing, and reusable first-class context packet ids are not required for R9 and should be specified separately if product demand appears.
- Search/citation tooling remains unavailable in R9; evidence references use existing local metadata only.
