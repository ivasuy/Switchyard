# Phase 23: R24 Hosted Real Debate - Implementation Plan

**Spec:** docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md
**Branch:** agent/phase-23-r24-hosted-real-debate
**Base/spec commit:** 53473b38016136452bf6755f6dde2f875621c1a9
**Architect review:** pass 1 revisions incorporated
**Complexity:** L

## Goal

Ship hosted/server-safe debate execution through the existing /debates route family, with deterministic no-spend defaults, explicit real-runtime and live-judge opt-ins, durable hosted state, tenant-safe ownership, idempotent child-run creation, evidence no-leak authorization, and no new public participant, judge, model-judge, terminal, PTY, shell, process, sandbox, dashboard, or TUI routes.

## Scope Challenge

1. Existing code already provides DebateService, registerDebateRoutes, SqliteDebateStore, MessageRouter, ContextBuilder, RunService, HostedRunService, HostedRuntimeCatalog, R23 bridge readiness helpers, ControlPlaneService, Postgres event/artifact/run stores, production preflight, production canary, and OpenAPI route-boundary tests. Extend those seams only.
2. Minimum shippable change is additive debate create contract validation, Postgres debate/message/evidence/job persistence, child-run idempotency, hosted evidence ownership preauthorization, staged debate orchestration, internal bounded judging, hosted route auth/ownership/quota/audit wiring, worker claim/readiness integration, ops canary/preflight coverage, and product truth updates.
3. Complexity is split across ten disjoint ownership slices. The former combined core task is split into runtime/output helpers and service/judge/report orchestration. The former server task is split into app wiring and readiness diagnostics. Storage remains one task because schema, stores, idempotency keys, and unowned-resource counts must land together to preserve migration coherence.
4. Built-in and existing primitives are sufficient: Zod schemas, existing HTTP error envelope, Fastify hooks, control-plane ownership/quota/audit APIs, HostedRunService gates, R23 bridge readiness helpers, runtime.output events, MessageRouter, object-store artifact writer, additive Postgres migration guard, and production preflight/canary script structure.
5. Distribution impact stays inside existing packages and operator commands. No new package, binary, public route family, dashboard, TUI, managed SaaS surface, or public arbitrary execution adapter ships.

## Architecture

R24 keeps the public API shape boring: local and hosted clients use only POST /debates, GET /debates/:id, and GET /debates/:id/events. Omitted participant runtime fields still mean fake.deterministic. A non-fake participant requires realRuntimeOptIn true and placement hosted. judgeConfig defaults to deterministic; model judge requires both realRuntimeOptIn true and confirmLiveProviderSpend true. The reserved output field judge remains rejected on create.

Hosted create has an ownership-first order. Auth and scope checks run first. Ownership override fields are rejected next. In hosted mode, every evidence id is authorized against the caller before evidence store lookup or content loading. Unknown and unowned evidence ids use the same no-leak outcome and create no debate, run, job, quota, message, event, artifact, or provider side effect. Only after these checks can the service reserve quota, persist a debate, attach ownership, enqueue a debate job, and disclose the debate id.

Hosted async execution uses a durable debate execution job store with lease, retry, and next-attempt fields. The job state machine advances one small step per claim: create or relink a child participant run, wait for that child run to become terminal, route bounded output into a message only while the debate is still nonterminal, advance round/participant state, create or relink a judge run when explicitly requested, parse bounded judge output, write the final report artifact, finalize active_debates quota, and mark the debate terminal. This avoids a single-worker deadlock where one worker blocks waiting for child runs it must later claim.

Child participant and judge runs are idempotent. Each child run carries a DebateChildRunKey derived from debateId, participantId or judge, debateRound, debatePhase, and debateRunKind. Before createRun, core checks the job pending run id, the debate execution link table, and the run store by key. After createRun, core links the run to the job. If createRun succeeds and job update fails, stale-claim retry finds the existing run by key and links it instead of creating duplicate provider work.

GET /debates/:id/events authorizes once at stream start and filters every emitted event by the authorized debateId. Provider output that arrives after debate terminalization is ignored or recorded as late without reopening the debate. Worker terminal success and terminal failure both finalize active_debates quota exactly once. Judge JSON output is byte-limited before JSON.parse.

```
POST /debates
  -> hosted auth scope for runs:write
  -> reject ownership override fields
  -> authorize each evidence id before evidence lookup/content access
  -> normalize runtime matrix and spend gates
  -> reserve debate quota and attach debate ownership
  -> fake wait=1 executes no-spend path
  -> async path enqueues owned durable debate job

worker tick
  -> recover stale debate claims
  -> claim one due debate job
  -> create or relink child run by DebateChildRunKey
  -> release while child run is nonterminal
  -> route terminal output only if debate is still nonterminal
  -> judge/report/finalize quota/complete
```

## File Structure

- Contracts and OpenAPI stay under packages/contracts and the protocol REST error map.
- Durable debate stores and idempotency live under packages/storage/src/postgres and packages/core/src/ports.
- Runtime normalization/output helpers are separate from DebateService.
- DebateService owns orchestration, evidence authorization, child-run relinking, judge parsing, and report behavior.
- Protocol REST owns the existing route family, auth rules, route dependency contract, SSE start authorization, and strict debateId filtering.
- Server app wiring owns hosted dependency composition, quota, audit, and resource ownership attachment.
- Server readiness owns hostedDebate diagnostics only.
- Worker owns claim/release processing and terminal quota finalization.
- Ops scripts own no-spend preflight/canary and explicit live-spend gates.
- Docs own product, operator, and adapter truth.

## Architect Pass 1 Reconciliation

- A1 accepted: T4 requires hosted evidence authorization before evidence lookup/content loading, and T5 adds route-level no-side-effect tests.
- A2 accepted: T2 adds DebateChildRunKey storage/index contracts, T4 and T8 add stale-claim crash tests proving no duplicate child run.
- A3 accepted: T6 adds direct ownership attach failure tests for child run, message, event, artifact, and debate job before disclosure.
- A4 accepted: T3 and T5 add placement-required behavior and tests before queue/provider side effects.
- A5 accepted: T10 context_files now include every adapter doc it edits: docs/adapters/README.md, codex.md, claude-code.md, opencode.md, agentfield.md, and generic-http.md.
- A6 accepted: T5 replaces the route dependency placeholder with exact dependency contract fields and route responsibilities.
- A7 accepted: the plan splits core work into T3/T4 and server work into T6/T7; T2 remains unified with explicit justification in the scope challenge because migration/storage/idempotency must stay coherent.
- E1 accepted: T3/T4/T8 handle provider output after terminalization by ignoring or recording late output without reopening debate.
- E2 accepted: T5 requires SSE authorization at stream start and strict debateId filtering.
- E3 accepted: T6 and T8 require active_debates quota finalization on terminal success and terminal failure.
- E4 accepted: T4 requires judge byte-limit rejection before JSON.parse and adds a focused test.

## Task Graph

### Task P23-T1-contracts-openapi-boundary

```json
{
  "id": "P23-T1-contracts-openapi-boundary",
  "title": "Define debate contracts, errors, and route boundary",
  "files": [
    "packages/contracts/src/debate.ts",
    "packages/contracts/src/http-error.ts",
    "packages/protocol-rest/src/http-errors.ts",
    "packages/contracts/src/enterprise.ts",
    "packages/contracts/src/endpoint-inventory.ts",
    "packages/contracts/src/openapi.ts",
    "packages/contracts/src/openapi.contract.test.ts",
    "packages/contracts/src/http-error.contract.test.ts",
    "packages/contracts/test/contracts.test.ts",
    "packages/contracts/openapi.local-daemon.json",
    "packages/contracts/openapi.hosted-server.json"
  ],
  "dependencies": [],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "packages/contracts/src/debate.ts",
    "packages/contracts/src/http-error.ts",
    "packages/contracts/src/enterprise.ts",
    "packages/contracts/src/endpoint-inventory.ts",
    "packages/contracts/src/openapi.ts",
    "packages/contracts/src/openapi.contract.test.ts"
  ],
  "instructions": "Add R24 debate request contracts without changing existing debate response compatibility. Extend create input parsing for participant placement, realRuntimeOptIn, judgeConfig, confirmLiveProviderSpend, evidence ids, and reserved judge input rejection. Add named error codes for evidence no-leak denial, participant placement requirement, real participant opt-in, wait restrictions, runtime unsupported, idempotent child run collision, child run link failure, participant output errors, judge output errors, live spend denial, hosted debate queue/store/audit/quota/ownership/artifact failures, and live canary spend denial. Use 400 for invalid input and opt-in failures, 403 or no-leak 404 for ownership denials, 409 for unsupported runtime or wait states, 429 for quota/spend exhaustion, and 503 for dependency failures. Extend enterprise schemas with debate ownership resource type and debates_per_hour plus active_debates quota kinds. Add hosted /debates, /debates/:id, and /debates/:id/events to hosted OpenAPI by reusing the existing debate route family only. Keep forbidden-route tests strict for participant, judge, model-judge, arbitrary execution, dashboard, and TUI routes.",
  "acceptance": [
    "CreateDebateRequest accepts fake defaults, explicit hosted real participant fields, deterministic judgeConfig, and model judgeConfig only with spend confirmation.",
    "CreateDebateRequest rejects judge as input while debateSchema continues to allow judge as output.",
    "httpErrorCodeSchema and protocol REST status mapping cover every R24 code including debate_evidence_not_found_or_denied, debate_participant_placement_required, debate_child_run_link_failed, hosted_debate_ownership_attach_failed, and debate_live_canary_spend_unconfirmed.",
    "Enterprise schemas accept debate resource ownership and additive debate quota kinds without requiring them in existing bootstrap fixtures.",
    "Hosted OpenAPI includes only POST /debates, GET /debates/{id}, and GET /debates/{id}/events for debate behavior.",
    "Hosted and local OpenAPI tests prove no public participant, judge, model-judge, arbitrary execution, dashboard, terminal, process, shell, sandbox, PTY, or TUI route exists."
  ],
  "checks": [
    "pnpm --filter @switchyard/contracts test",
    "pnpm --filter @switchyard/contracts openapi:check",
    "pnpm --filter @switchyard/contracts openapi:check:hosted",
    "pnpm --filter @switchyard/protocol-rest typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "CreateDebateRequest schema",
      "failure": "request includes reserved output field judge",
      "exception": "ZodError or DebateServiceError invalid_input",
      "rescue": "Reject before evidence authorization, debate persistence, quota, queue, run creation, or provider side effects.",
      "user_sees": "400 invalid_input with path judge and issue field is reserved."
    },
    {
      "codepath": "HTTP error contract",
      "failure": "new service code is missing from contracts or REST status map",
      "exception": "contract test failure",
      "rescue": "Add the exact code to httpErrorCodeSchema and STATUS_BY_CODE with the status category required by the spec.",
      "user_sees": "Named HTTP error instead of internal_error."
    },
    {
      "codepath": "Hosted OpenAPI inventory",
      "failure": "a forbidden route is added or hosted /debates is omitted",
      "exception": "OpenAPI contract assertion failure",
      "rescue": "Remove forbidden inventory entries and add only the three existing debate routes.",
      "user_sees": "Hosted OpenAPI exposes the stable /debates family only."
    }
  ],
  "observability": {
    "logs": [
      "contract tests report exact missing R24 error code when schema coverage drifts",
      "OpenAPI check reports the offending forbidden path or operation id"
    ],
    "success_metric": "contracts tests and hosted OpenAPI checks pass with exactly three hosted debate routes",
    "failure_metric": "any R24 service code falls back to internal_error or any forbidden route appears in generated OpenAPI"
  },
  "test_cases": [
    {
      "name": "parses fake default create request",
      "lens": "happy",
      "given": "CreateDebateRequest with topic and two role-only participants",
      "expect": "schema accepts and defaults remain compatible with existing fake deterministic debate"
    },
    {
      "name": "parses opt-in hosted real participants",
      "lens": "happy",
      "given": "CreateDebateRequest with claude_code.sdk and opencode.acp participants, placement hosted, realRuntimeOptIn true",
      "expect": "schema accepts without adding public participant routes"
    },
    {
      "name": "rejects reserved judge input",
      "lens": "error_path",
      "given": "CreateDebateRequest with top-level judge object",
      "expect": "invalid_input with path judge before side effects"
    },
    {
      "name": "all R24 debate codes are known",
      "lens": "integration",
      "given": "the named failure code list from the spec and this plan",
      "expect": "httpErrorCodeSchema parses each code and protocol REST maps expected codes to non-500 status except true unexpected exceptions"
    },
    {
      "name": "hosted OpenAPI route boundary",
      "lens": "integration",
      "given": "generateOpenApiDocument({ surface: hosted_server })",
      "expect": "contains /debates, /debates/{id}, /debates/{id}/events and excludes all forbidden route families"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "debate create contract additions",
        "kind": "constant",
        "signature": "CreateDebateRequest accepts participant placement/realRuntimeOptIn/evidenceIds and judgeConfig; debateSchema remains output-compatible"
      },
      {
        "name": "R24 debate HTTP error codes",
        "kind": "constant",
        "signature": "httpErrorCodeSchema includes debate_* and hosted_debate_* codes from the spec and architect pass 1 findings"
      },
      {
        "name": "debate ownership/quota vocabulary",
        "kind": "constant",
        "signature": "resourceOwnershipTypeSchema includes debate and quotaKindSchema includes debates_per_hour|active_debates"
      }
    ],
    "imports_from_other_tasks": [],
    "file_paths_consumed_by_other_tasks": [
      "packages/contracts/src/debate.ts",
      "packages/contracts/src/http-error.ts",
      "packages/contracts/src/enterprise.ts",
      "packages/protocol-rest/src/http-errors.ts"
    ]
  }
}
```

### Task P23-T2-postgres-debate-durability-idempotency

```json
{
  "id": "P23-T2-postgres-debate-durability-idempotency",
  "title": "Add durable Postgres debate stores and child-run idempotency",
  "files": [
    "packages/core/src/ports/debate-execution-store.ts",
    "packages/core/src/ports/run-store.ts",
    "packages/core/src/ports/control-plane-store.ts",
    "packages/core/src/index.ts",
    "packages/storage/src/postgres/debate-store.ts",
    "packages/storage/src/postgres/message-store.ts",
    "packages/storage/src/postgres/evidence-store.ts",
    "packages/storage/src/postgres/debate-execution-store.ts",
    "packages/storage/src/postgres/run-store.ts",
    "packages/storage/src/postgres/database.ts",
    "packages/storage/src/postgres/schema.ts",
    "packages/storage/src/postgres/control-plane-store.ts",
    "packages/storage/src/index.ts",
    "packages/storage/test/postgres-debate-store.test.ts",
    "packages/storage/test/postgres-run-store.test.ts",
    "packages/storage/test/postgres-schema-compat.test.ts",
    "packages/storage/test/storage-package.test.ts"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "packages/core/src/ports/debate-store.ts",
    "packages/core/src/ports/run-store.ts",
    "packages/storage/src/sqlite/debate-store.ts",
    "packages/storage/src/sqlite/message-store.ts",
    "packages/storage/src/sqlite/evidence-store.ts",
    "packages/storage/src/postgres/database.ts",
    "packages/storage/src/postgres/run-store.ts",
    "packages/storage/src/postgres/control-plane-store.ts",
    "packages/storage/test/postgres-storage.test.ts"
  ],
  "instructions": "Add Postgres durability equivalent to the current SQLite debate path before hosted routes are exposed. Implement Postgres debate, message, evidence, and debate execution stores. The debate execution job record must include job id, debate id, stage, round, phase, participant index, pending run id, pending judge run id, state, attempts, maxAttempts, claimedAt, leaseUntil, nextAttemptAt, failure reasonCode, owner ids when available, and timestamps. Add a stable DebateChildRunKey made from debateId, participantId or judge, debateRound, debatePhase, and debateRunKind. Extend RunStore and PostgresRunStore with findByDebateChildRunKey(key). Persist the key in run metadata under debateChildRunKey and add an additive unique Postgres index for that key so retries cannot create duplicate child runs. Extend DebateExecutionStore with linkPendingRun(jobId, key, runId, expectedStage) and findPendingRunByKey(key) so core can link an existing run after a stale claim. Update additive Postgres schema SQL and Drizzle schema, bump POSTGRES_SCHEMA_VERSION, keep assertPostgresMigrationSqlAdditive passing, and extend control-plane unowned-resource counts to include debates, debate jobs, messages, evidence rows, and debate-derived artifacts/events that are visible hosted resources.",
  "acceptance": [
    "PostgresDebateStore round-trips all Debate fields currently handled by SqliteDebateStore plus additive R24 fields.",
    "PostgresMessageStore supports create/get/update/list filters needed by MessageRouter and debate inspect.",
    "PostgresEvidenceStore supports create/get/update/list filters needed by evidence validation and ContextBuilder.",
    "DebateExecutionStore claims only due queued jobs, leases claims, requeues recoverable stale claims, exhausts max-attempt stale claims, records named reason codes, and supports atomic pending-run linkage.",
    "RunStore can find a child participant or judge run by the deterministic DebateChildRunKey, and Postgres prevents two runs with the same key.",
    "Postgres schema migration is additive, versioned, and includes indexes for debate id, job state/lease/nextAttemptAt, messages channel, evidence debate id, run debateChildRunKey, and ownership scans.",
    "Control-plane unowned-resource readiness can count debate, debate job, message, evidence, event, child run, and artifact ownership gaps.",
    "Storage package exports new Postgres stores and new core ports without breaking SQLite tests."
  ],
  "checks": [
    "pnpm --filter @switchyard/storage test -- postgres-debate",
    "pnpm --filter @switchyard/storage test -- postgres-run-store",
    "pnpm --filter @switchyard/storage test -- postgres-schema-compat",
    "pnpm --filter @switchyard/storage test -- storage-package",
    "pnpm --filter @switchyard/storage typecheck",
    "pnpm --filter @switchyard/core typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "ensurePostgresSchema",
      "failure": "migration includes destructive SQL",
      "exception": "destructive_migration_blocked",
      "rescue": "Replace with CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, or ADD COLUMN IF NOT EXISTS only.",
      "user_sees": "production:migrate/preflight fails before destructive schema mutation."
    },
    {
      "codepath": "PostgresRunStore.create with debateChildRunKey",
      "failure": "duplicate child run key is inserted by a retry",
      "exception": "unique constraint violation",
      "rescue": "Read the existing run through findByDebateChildRunKey and let core link it to the pending debate job.",
      "user_sees": "No duplicate participant or judge run appears on debate inspect."
    },
    {
      "codepath": "DebateExecutionStore.linkPendingRun",
      "failure": "job stage changed or pending run already linked",
      "exception": "link_conflict",
      "rescue": "Return conflict with current job snapshot so core re-reads and avoids duplicate run creation.",
      "user_sees": "Debate stays pending or fails with debate_child_run_link_failed, not duplicate provider work."
    },
    {
      "codepath": "control-plane unowned counts",
      "failure": "new debate-derived rows lack ownership",
      "exception": "readiness count > 0",
      "rescue": "Expose unowned_resources_present diagnostics without leaking raw row contents.",
      "user_sees": "GET /ready 503 with low-cardinality unowned resource counts."
    }
  ],
  "observability": {
    "logs": [
      "storage diagnostics include debate job state, childRunKey, and reasonCode on claim/link failures",
      "readiness diagnostics include counts for unowned debates, jobs, child runs, messages, events, evidence, and artifacts"
    ],
    "success_metric": "Postgres debate/job/message/evidence stores and run child-key lookup pass parity, stale-claim, and idempotency tests",
    "failure_metric": "hosted_debate_store_unavailable, hosted_debate_queue_unavailable, debate_child_run_link_failed, or unowned_resources_present appears in readiness/preflight"
  },
  "test_cases": [
    {
      "name": "debate store parity",
      "lens": "happy",
      "given": "create/update/get a Debate with participants, runIds, judge, error, final artifact, messageIds, eventIds",
      "expect": "retrieved Debate deeply equals the updated public shape"
    },
    {
      "name": "message and evidence durable lookup",
      "lens": "integration",
      "given": "MessageRouter creates a debate message and evidence store contains debate evidence",
      "expect": "get/list return ordered records by id, run/channel, and debate id"
    },
    {
      "name": "empty optional fields stay absent",
      "lens": "happy_shadow_empty",
      "given": "Debate without judge, finalReportArtifactId, finalReportPath, updatedAt, completedAt, or error",
      "expect": "round trip returns those fields undefined rather than null in the public object"
    },
    {
      "name": "child run key lookup and uniqueness",
      "lens": "integration",
      "given": "two create attempts with the same debateChildRunKey",
      "expect": "the first run is readable by key and the second attempt is rejected or returns the existing run path without a duplicate"
    },
    {
      "name": "stale job requeues then exhausts",
      "lens": "error_path",
      "given": "claimed debate job with expired lease and attempts below max, then expired again at max",
      "expect": "first recovery returns queued state; second recovery returns exhausted with named reason code"
    },
    {
      "name": "migration remains additive",
      "lens": "integration",
      "given": "R24 migration SQL",
      "expect": "assertPostgresMigrationSqlAdditive passes and schema compatibility expects the bumped version"
    },
    {
      "name": "unowned resource counts include debate resources",
      "lens": "integration",
      "given": "Postgres debate, job, child run, message, event, evidence, and artifact rows without resource_ownership rows",
      "expect": "countUnownedResources increments the new low-cardinality counters"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "DebateExecutionStore",
        "kind": "class",
        "signature": "interface DebateExecutionStore { enqueue(input) => Promise<DebateExecutionJob>; claim(options?) => Promise<ClaimedDebateExecutionJob | undefined>; linkPendingRun(jobId, key, runId, expectedStage) => Promise<LinkPendingRunResult>; findPendingRunByKey(key) => Promise<PendingRunLink | undefined>; release(jobId, update) => Promise<void>; complete(jobId) => Promise<void>; fail(jobId, failure) => Promise<void>; recoverStaleClaims(options?) => Promise<{ recovered:number; exhausted:number; invalid:number }>; stats() => Promise<{ queued:number; claimed:number; failed:number; exhausted:number }> }"
      },
      {
        "name": "RunStore debate child lookup",
        "kind": "function",
        "signature": "findByDebateChildRunKey?(key: DebateChildRunKey) => Promise<Run | undefined>"
      },
      {
        "name": "PostgresDebateStore",
        "kind": "class",
        "signature": "new PostgresDebateStore(handle?: PostgresDatabaseHandle) implements DebateStore"
      },
      {
        "name": "PostgresMessageStore",
        "kind": "class",
        "signature": "new PostgresMessageStore(handle?: PostgresDatabaseHandle) implements MessageStore"
      },
      {
        "name": "PostgresEvidenceStore",
        "kind": "class",
        "signature": "new PostgresEvidenceStore(handle?: PostgresDatabaseHandle) implements EvidenceStore"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P23-T1-contracts-openapi-boundary",
        "name": "debate ownership/quota vocabulary",
        "signature": "resourceOwnershipTypeSchema includes debate and quotaKindSchema includes debates_per_hour|active_debates"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/ports/debate-execution-store.ts",
      "packages/core/src/ports/run-store.ts",
      "packages/storage/src/postgres/debate-store.ts",
      "packages/storage/src/postgres/debate-execution-store.ts",
      "packages/storage/src/postgres/message-store.ts",
      "packages/storage/src/postgres/evidence-store.ts",
      "packages/storage/src/postgres/run-store.ts"
    ]
  }
}
```

### Task P23-T3-core-debate-runtime-output

```json
{
  "id": "P23-T3-core-debate-runtime-output",
  "title": "Normalize debate runtimes and extract bounded output",
  "files": [
    "packages/core/src/services/debate-runtime-matrix.ts",
    "packages/core/src/services/debate-output.ts",
    "packages/core/test/debate-real-runtime.test.ts"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary",
    "P23-T2-postgres-debate-durability-idempotency"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "packages/core/src/services/debate-service.ts",
    "packages/core/src/services/hosted-run-service.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts",
    "packages/contracts/src/hosted-runtime-bridge.ts",
    "packages/core/test/debate-service.test.ts",
    "packages/testkit/src/fake-runtime-adapter.ts"
  ],
  "instructions": "Create helper modules for the closed R24 debate runtime matrix and participant output extraction. Preserve fake.deterministic defaults. Admit only fake.deterministic, codex.exec_json, claude_code.sdk, and opencode.acp. Reject codex.interactive, AgentField, Generic HTTP, browser, repo, generic process, terminal, shell, sandbox, and PTY debate execution. A non-fake participant must include realRuntimeOptIn true and placement hosted; omitted placement, local placement, or any non-hosted placement must fail with debate_participant_placement_required before queue, quota, run, provider, or evidence content side effects. Build deterministic DebateChildRunKey values for participant and judge runs. Expose output helpers that read only persisted runtime.output events, enforce byte caps before returning text, reject nil/blank/overlarge output with named codes, require matching debateId and childRunKey metadata, and expose a late-output classification for runs whose debate is already terminal.",
  "acceptance": [
    "Runtime normalization preserves fake defaults and exact backward-compatible fake wait behavior for the service that imports it.",
    "Non-fake participants without realRuntimeOptIn true fail with debate_real_participant_opt_in_required before side effects.",
    "Non-fake participants with realRuntimeOptIn true but omitted, local, or non-hosted placement fail with debate_participant_placement_required before side effects.",
    "Unsupported runtime modes fail closed with named unsupported or bridge-unshipped codes and cannot enqueue child runs.",
    "Participant prompt metadata includes debateId, participantId, participantRole, debateRunKind, debateRound, debatePhase, and debateChildRunKey.",
    "Output extraction reads persisted runtime.output events only, rejects missing, empty, overlarge, or metadata-mismatched output, and never synthesizes successful messages.",
    "Late output from a run whose debate is terminal is classified for ignore or late recording and cannot reopen the debate."
  ],
  "checks": [
    "pnpm --filter @switchyard/core test -- debate-real-runtime",
    "pnpm --filter @switchyard/core typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "normalizeDebateRuntime",
      "failure": "non-fake runtime without realRuntimeOptIn",
      "exception": "DebateServiceError debate_real_participant_opt_in_required",
      "rescue": "Reject before evidence content loading, debate persistence, quota, queue, run creation, or provider dispatch.",
      "user_sees": "400 debate_real_participant_opt_in_required."
    },
    {
      "codepath": "normalizeDebateRuntime",
      "failure": "non-fake runtime with missing or non-hosted placement",
      "exception": "DebateServiceError debate_participant_placement_required",
      "rescue": "Reject before evidence content loading, debate persistence, quota, queue, run creation, or provider dispatch.",
      "user_sees": "400 debate_participant_placement_required."
    },
    {
      "codepath": "extractParticipantOutput",
      "failure": "runtime.output is missing, blank after trim, over byte cap, or metadata does not match expected debate id and child key",
      "exception": "DebateServiceError debate_participant_output_missing|debate_participant_output_empty|debate_participant_output_too_large|debate_participant_output_unowned",
      "rescue": "Return named failure to DebateService; do not create a message.",
      "user_sees": "No fabricated participant message; inspect shows named output error."
    }
  ],
  "observability": {
    "logs": [
      "warn debate.runtime.denied reasonCode runtime placement hasOptIn",
      "warn debate.participant.output.rejected debateId runId reasonCode outputBytes"
    ],
    "success_metric": "runtime matrix and output helper tests cover every allowed and forbidden runtime path",
    "failure_metric": "any unsupported runtime reaches run creation, or any malformed runtime.output becomes a message"
  },
  "test_cases": [
    {
      "name": "missing participant opt-in has no side effects",
      "lens": "error_path",
      "given": "codex.exec_json participant without realRuntimeOptIn",
      "expect": "debate_real_participant_opt_in_required and zero debates/runs/messages/events/artifacts/jobs"
    },
    {
      "name": "placement required for real participant",
      "lens": "error_path",
      "given": "opencode.acp participant with realRuntimeOptIn true and omitted, local, or worker placement cases",
      "expect": "debate_participant_placement_required before queue/provider side effects"
    },
    {
      "name": "unsupported runtime matrix fails closed",
      "lens": "edge_unsupported_runtime",
      "given": "codex.interactive, agentfield.async_rest, generic_http.async_rest, cursor, browser, repo, process, shell, terminal, sandbox, or pty runtimeMode",
      "expect": "debate_runtime_unsupported or specific bridge-unshipped code before queue/provider side effects"
    },
    {
      "name": "participant output errors",
      "lens": "error_path",
      "given": "terminal child run with no runtime.output, blank text, overlarge text, wrong debateId, and wrong childRunKey in separate cases",
      "expect": "named participant output errors and no routed message"
    },
    {
      "name": "late output classification",
      "lens": "edge_late_output",
      "given": "runtime.output arrives after debate status is already terminal",
      "expect": "helper returns late classification and does not authorize reopen"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "normalizeDebateRuntime",
        "kind": "function",
        "signature": "normalizeDebateRuntime(participant, index, options) => DebateParticipantRuntimeConfig"
      },
      {
        "name": "buildDebateChildRunKey",
        "kind": "function",
        "signature": "buildDebateChildRunKey({ debateId, participantId?, debateRound, debatePhase, debateRunKind }) => string"
      },
      {
        "name": "extractDebateRuntimeOutput",
        "kind": "function",
        "signature": "extractDebateRuntimeOutput(events, expected: { debateId:string; childRunKey:string; maxBytes:number }) => ExtractedDebateOutput | DebateOutputError"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P23-T1-contracts-openapi-boundary",
        "name": "debate create contract additions",
        "signature": "CreateDebateRequest accepts placement/realRuntimeOptIn and R24 error codes"
      },
      {
        "from_task": "P23-T2-postgres-debate-durability-idempotency",
        "name": "RunStore debate child lookup",
        "signature": "findByDebateChildRunKey?(key: DebateChildRunKey) => Promise<Run | undefined>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/services/debate-runtime-matrix.ts",
      "packages/core/src/services/debate-output.ts"
    ]
  }
}
```

### Task P23-T4-core-debate-orchestration-judge

```json
{
  "id": "P23-T4-core-debate-orchestration-judge",
  "title": "Orchestrate debate jobs, judging, evidence authorization, and reports",
  "files": [
    "packages/core/src/services/debate-service.ts",
    "packages/core/src/services/debate-judge-runner.ts",
    "packages/core/test/debate-service.test.ts",
    "packages/core/test/debate-judge-runner.test.ts"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary",
    "P23-T2-postgres-debate-durability-idempotency",
    "P23-T3-core-debate-runtime-output"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "packages/core/src/services/debate-service.ts",
    "packages/core/src/services/run-service.ts",
    "packages/core/src/services/context-builder.ts",
    "packages/core/src/services/message-router.ts",
    "packages/core/src/services/hosted-run-service.ts",
    "packages/core/src/ports/debate-store.ts",
    "packages/core/src/ports/evidence-store.ts",
    "packages/core/test/debate-service.test.ts",
    "packages/testkit/src/fake-stores.ts"
  ],
  "instructions": "Extend DebateService with hosted-safe create and staged processExecutionJob behavior while importing runtime/output helpers from T3. In hosted mode, authorize every requested evidence id against the caller through the control-plane ownership hook before evidence store lookup, before ContextBuilder content loading, and before quota, debate, job, run, event, message, artifact, or provider side effects. Unknown and unowned evidence ids must use the same no-leak outcome, debate_evidence_not_found_or_denied or tenant_access_denied per existing hosted auth convention, and must not reveal which case occurred. Preserve fake deterministic wait=1 behavior. For async jobs, create participant and judge child runs idempotently: compute DebateChildRunKey, check the job pending run id, check DebateExecutionStore.findPendingRunByKey, check RunStore.findByDebateChildRunKey, create a run only when all are absent, then link the pending run through DebateExecutionStore.linkPendingRun. If createRun succeeds and job update fails, a stale-claim retry must find the existing run by key and link it rather than creating another run. Before routing terminal child output, re-read debate status and verify the expected debateId/childRunKey; if the debate is terminal, ignore or record a low-cardinality late-output event and do not reopen debate state. Deterministic judge remains default and no-spend. Model judge requires request opt-in and confirmLiveProviderSpend, creates a normal run with debateRunKind judge, and parses a bounded JSON object. Reject judge output over the byte cap before JSON.parse. Final report metadata must include debate id, stop reason, participant ids, participant run ids per turn, judge run id when present, evidence ids, message ids, and judge summary.",
  "acceptance": [
    "Existing fake deterministic debate tests still pass and POST /debates?wait=1 semantics are preserved for no-spend fake debates.",
    "Hosted evidence authorization runs before evidence lookup or content loading and before all debate/run/job/quota/provider side effects.",
    "Unknown and unowned evidence ids have identical no-leak behavior in hosted create tests.",
    "Real participant or live judge requests with wait=1 fail with debate_wait_real_runtime_unsupported before provider or queue side effects.",
    "Each participant turn creates one normal run with debateChildRunKey metadata and no duplicate run is created after stale claim recovery.",
    "Participant output is read from persisted runtime.output events, bounded, routed through MessageRouter, and linked to debate events only while the debate is nonterminal.",
    "Late provider completion after debate terminalization is ignored or recorded as late without reopening the debate.",
    "Deterministic judge remains default and requires no provider calls.",
    "Live model judge requires opt-in and spend confirmation, parses bounded JSON only after size check, and maps invalid output to named judge errors.",
    "Final success and failure paths return enough information for server/worker hooks to finalize active_debates quota."
  ],
  "checks": [
    "pnpm --filter @switchyard/core test -- debate-service",
    "pnpm --filter @switchyard/core test -- debate-judge-runner",
    "pnpm --filter @switchyard/core typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "hosted evidence preauthorization",
      "failure": "evidence id is unknown or owned by another tenant",
      "exception": "ControlPlane denial or no ownership row",
      "rescue": "Return no-leak denial before evidence store lookup, ContextBuilder content load, debate persistence, quota reservation, job enqueue, run creation, or provider dispatch.",
      "user_sees": "400/403/404 named no-leak evidence denial with no debate id."
    },
    {
      "codepath": "create child run for participant or judge",
      "failure": "createRun succeeds but DebateExecutionStore.linkPendingRun fails or worker crashes before link",
      "exception": "link_conflict|hosted_debate_queue_unavailable|stale claim",
      "rescue": "On retry, read existing run by debateChildRunKey and link it; if conflicting metadata is found, fail with debate_child_run_link_failed.",
      "user_sees": "No duplicate participant or judge provider run."
    },
    {
      "codepath": "participant run terminal observation",
      "failure": "run missing, failed, timeout, cancelled, still waiting past debate deadline, or wrong debate ownership metadata",
      "exception": "DebateServiceError debate_participant_run_missing|debate_participant_run_failed|debate_participant_run_timeout|debate_runtime_approval_expired|debate_participant_output_unowned",
      "rescue": "Mark debate failed, append failure judge summary where possible, write failure report, and stop further turns.",
      "user_sees": "Inspect shows failed debate with named error code and final report when artifact write succeeds."
    },
    {
      "codepath": "late participant output",
      "failure": "provider run completes after debate already terminalized",
      "exception": "terminal debate status check",
      "rescue": "Do not route a message or reopen debate; optionally append redacted late-output audit/event with no prompt or provider body.",
      "user_sees": "Debate remains terminal with original stop reason."
    },
    {
      "codepath": "model judge parser",
      "failure": "live judge output is missing, empty, overlarge, invalid JSON, or lacks required summary/disagreement fields",
      "exception": "DebateServiceError debate_judge_output_missing|debate_judge_output_empty|debate_judge_output_too_large|debate_judge_output_invalid",
      "rescue": "Check byte length before JSON.parse, fail judging without storing a misleading successful judge result, and write failure report where possible.",
      "user_sees": "Named judge error and failure summary instead of no_consensus success."
    }
  ],
  "observability": {
    "logs": [
      "info debate.create.accepted debateId placementSummary realParticipantCount judgeMode",
      "warn debate.create.denied reasonCode hasRealParticipant hasLiveJudge",
      "info debate.participant.run.linked debateId participantId runId childRunKey reused",
      "warn debate.participant.output.late debateId runId status",
      "info debate.judge.run.created debateId runId judgeMode runtimeMode promptBytes",
      "warn debate.judge.output.rejected debateId runId reasonCode outputBytes",
      "info debate.report.written debateId artifactId contentStored"
    ],
    "success_metric": "debate reaches no_consensus/completed/consensus_found with participantRunIds, eventIds, messageIds, judge summary, and finalReportArtifactId",
    "failure_metric": "debate.error.code is one of the named R24 participant/judge/store/queue codes and no provider output is persisted in logs"
  },
  "test_cases": [
    {
      "name": "fake deterministic wait remains backward compatible",
      "lens": "happy",
      "given": "create role-only two participant debate with wait true",
      "expect": "status no_consensus, fake run ids, message ids, debate.judge.summary, and final report artifact"
    },
    {
      "name": "hosted evidence denied before lookup",
      "lens": "error_path",
      "given": "hosted create with evidence id unknown and evidence id owned by another tenant in separate cases",
      "expect": "same no-leak denial and zero evidence store lookups, content loads, debates, runs, messages, events, artifacts, jobs, quota reservations, and provider calls"
    },
    {
      "name": "real wait fails before provider dispatch",
      "lens": "error_path",
      "given": "claude_code.sdk participant with realRuntimeOptIn true and wait true",
      "expect": "debate_wait_real_runtime_unsupported and no child runs"
    },
    {
      "name": "stale claim after run create reuses child run",
      "lens": "error_path",
      "given": "participant createRun succeeds, pending job update fails, and the worker later recovers the stale claim",
      "expect": "retry finds existing run by debateChildRunKey, links it, and total child run count remains one"
    },
    {
      "name": "one normal run per participant turn",
      "lens": "integration",
      "given": "async debate job advanced through one round",
      "expect": "each participant turn has a unique run id and metadata debateRunKind participant_turn with round, phase, participantId, and debateChildRunKey"
    },
    {
      "name": "late provider output does not reopen terminal debate",
      "lens": "edge_late_output",
      "given": "debate already failed or completed before child run terminal runtime.output appears",
      "expect": "no routed message, no status reopen, and optional late-output event/audit only"
    },
    {
      "name": "deterministic judge default",
      "lens": "happy_shadow_nil",
      "given": "judgeConfig omitted",
      "expect": "deterministic no-spend judge result with no judge run id"
    },
    {
      "name": "live judge spend confirmation required",
      "lens": "error_path",
      "given": "judgeConfig mode model with realRuntimeOptIn true but confirmLiveProviderSpend false",
      "expect": "debate_judge_live_spend_unconfirmed before judge run creation"
    },
    {
      "name": "judge parser rejects overlarge before parse",
      "lens": "error_path",
      "given": "judge run runtime.output larger than cap and not valid JSON",
      "expect": "debate_judge_output_too_large without invoking JSON.parse"
    },
    {
      "name": "invalid judge output fails visibly",
      "lens": "error_path",
      "given": "judge run runtime.output is blank, invalid JSON, or missing summary in separate cases",
      "expect": "named judge output errors without successful judge result"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "DebateService.create",
        "kind": "function",
        "signature": "create(input: unknown, options?: { wait?: boolean; auth?: AuthContext; requestId?: string }) => Promise<{ debate: Debate; events?: SwitchyardEvent[]; finalReportArtifact?: Artifact | null }>"
      },
      {
        "name": "DebateService.processExecutionJob",
        "kind": "function",
        "signature": "processExecutionJob(job: DebateExecutionJob) => Promise<{ action: complete|requeue|fail; reasonCode?: string; nextAttemptAt?: string; quotaFinalization?: DebateQuotaFinalization }>"
      },
      {
        "name": "DebateJudgeRunner",
        "kind": "class",
        "signature": "runDeterministic(input) => DebateJudge; parseModelJudgeOutput(text, limits) => DebateJudge | DebateJudgeOutputError"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P23-T1-contracts-openapi-boundary",
        "name": "debate create contract additions",
        "signature": "CreateDebateRequest accepts participant placement/realRuntimeOptIn/evidenceIds and judgeConfig"
      },
      {
        "from_task": "P23-T2-postgres-debate-durability-idempotency",
        "name": "DebateExecutionStore and RunStore child lookup",
        "signature": "linkPendingRun/findPendingRunByKey/findByDebateChildRunKey support idempotent child run creation"
      },
      {
        "from_task": "P23-T3-core-debate-runtime-output",
        "name": "runtime matrix and output helpers",
        "signature": "normalizeDebateRuntime/buildDebateChildRunKey/extractDebateRuntimeOutput"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/services/debate-service.ts",
      "packages/core/src/services/debate-judge-runner.ts"
    ]
  }
}
```

### Task P23-T5-rest-debate-hosted-boundary

```json
{
  "id": "P23-T5-rest-debate-hosted-boundary",
  "title": "Secure existing debate REST routes for hosted mode",
  "files": [
    "packages/protocol-rest/src/debate-routes.ts",
    "packages/protocol-rest/src/hosted-auth.ts",
    "packages/protocol-rest/test/debate-routes.test.ts",
    "packages/protocol-rest/test/hosted-auth.test.ts"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary",
    "P23-T2-postgres-debate-durability-idempotency",
    "P23-T4-core-debate-orchestration-judge"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "packages/protocol-rest/src/debate-routes.ts",
    "packages/protocol-rest/src/hosted-auth.ts",
    "packages/protocol-rest/src/run-routes.ts",
    "packages/protocol-rest/test/debate-routes.test.ts",
    "packages/protocol-rest/test/hosted-tool-routes.test.ts",
    "packages/core/src/services/control-plane-service.ts"
  ],
  "instructions": "Keep the exact public debate route family and add hosted semantics around it. Add hosted auth hook rules for POST /debates requiring runs:write, and GET /debates/:id plus GET /debates/:id/events requiring runs:read. Extend DebateRouteDependencies with exact fields: service: DebateService; controlPlane?: ControlPlaneService; debateJobs?: DebateExecutionStore; requireHostedAuth?: boolean; routeMode?: local|hosted; getAuthContext(request): AuthContext|undefined; authorizeDebateRead(auth, debateId, requestId): Promise<AuthDecision>; enqueueDebateJob(debateId, auth, requestId): Promise<DebateExecutionJob>; mapServiceError(error): HttpErrorResponse. The route owns request parsing, auth scope checks, ownership override rejection, wait-mode validation at the HTTP boundary, no-leak read authorization before store-backed service reads, durable enqueue delegation, SSE stream authorization, strict SSE debateId filtering, and standard error envelope mapping. For create, reject ownership override fields such as accountId, tenantId, projectId, userId, and apiKeyId at top level or inside participant metadata before service side effects. Pass auth/requestId into DebateService.create. Hosted create must rely on DebateService evidence preauthorization and must not perform evidence store or content reads in the route. Async hosted create must enqueue through the durable debate job store; local no-job-store behavior may retain the existing microtask behavior only outside hosted mode.",
  "acceptance": [
    "No public route path is added beyond the existing three debate routes.",
    "Hosted auth requires runs:write for create and runs:read for inspect/events.",
    "Inspect and events perform ownership authorization before service/store reads and return no-leak denial for tenant mismatch.",
    "SSE authorizes once at stream start and filters emitted events strictly by debateId so run or other debate events cannot leak.",
    "Hosted create passes auth to DebateService so evidence ids are authorized before evidence lookup/content loading.",
    "Hosted async create uses durable debate job enqueue and never local microtask execution.",
    "Fake wait=1 remains supported and returns 201 with debate, events, and finalReportArtifact.",
    "Real participant or live judge wait=1 returns debate_wait_real_runtime_unsupported before enqueue/provider side effects.",
    "R24 service errors map to named REST errors, not internal_error, except truly unexpected exceptions."
  ],
  "checks": [
    "pnpm --filter @switchyard/protocol-rest test -- debate-routes",
    "pnpm --filter @switchyard/protocol-rest test -- hosted-auth",
    "pnpm --filter @switchyard/protocol-rest typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "POST /debates hosted auth",
      "failure": "missing or insufficient API key",
      "exception": "ControlPlaneError auth_required|entitlement_denied",
      "rescue": "Return auth error before reading evidence, reserving quota, creating debate, enqueueing job, or dispatching provider work.",
      "user_sees": "401 auth_required or 403 entitlement_denied."
    },
    {
      "codepath": "GET /debates/:id hosted authorization",
      "failure": "debate belongs to another tenant or does not exist",
      "exception": "ControlPlane authorizeResource returns denied/not_found",
      "rescue": "Return tenant_access_denied or debate_not_found without fetching messages/events/artifacts.",
      "user_sees": "No cross-tenant existence leak."
    },
    {
      "codepath": "GET /debates/:id/events SSE",
      "failure": "event bus emits run events or a different debate id after stream authorization",
      "exception": "event filter mismatch",
      "rescue": "Drop the event and log low-cardinality sse_filtered counter.",
      "user_sees": "Only events for the authorized debate id appear on the stream."
    },
    {
      "codepath": "async create enqueue",
      "failure": "durable debate job store unavailable",
      "exception": "DebateExecutionStoreError hosted_debate_queue_unavailable",
      "rescue": "Fail create before provider dispatch and release quota via service admission hooks.",
      "user_sees": "503 hosted_debate_queue_unavailable."
    }
  ],
  "observability": {
    "logs": [
      "info debate.route.create.accepted routeId debates.create wait hostedAuth present",
      "warn debate.route.denied routeId reasonCode requestId",
      "warn debate.route.tenant_denied routeId debateId reasonCode",
      "warn debate.route.sse_filtered debateId eventId eventDebateId",
      "error debate.route.enqueue_failed debateId reasonCode"
    ],
    "success_metric": "hosted create returns 202 with debate id and one durable debate job, while fake wait returns 201",
    "failure_metric": "auth_required, tenant_access_denied, hosted_debate_queue_unavailable, or debate_wait_real_runtime_unsupported returned before provider side effects"
  },
  "test_cases": [
    {
      "name": "hosted auth create scope",
      "lens": "integration",
      "given": "POST /debates with no API key, read-only key, and runs:write key",
      "expect": "401, 403, and accepted/create path respectively"
    },
    {
      "name": "hosted auth inspect events scope",
      "lens": "integration",
      "given": "GET /debates/:id and /events with no API key, write-only key, and runs:read key",
      "expect": "401, 403, and authorized response respectively"
    },
    {
      "name": "tenant mismatch no leak",
      "lens": "error_path",
      "given": "authorized tenant A requests debate id owned by tenant B",
      "expect": "tenant_access_denied or no-leak not-found before debate/messages/events/artifacts are fetched"
    },
    {
      "name": "hosted create evidence no-leak no side effects",
      "lens": "error_path",
      "given": "POST /debates in hosted mode with unknown evidence id and unowned evidence id cases",
      "expect": "same no-leak denial, DebateService evidence guard invoked, and zero debate/run/job/quota/provider side effects"
    },
    {
      "name": "placement required routed response",
      "lens": "error_path",
      "given": "POST /debates with opencode.acp participant, realRuntimeOptIn true, and omitted or local placement",
      "expect": "debate_participant_placement_required and no durable job"
    },
    {
      "name": "durable enqueue instead of microtask",
      "lens": "integration",
      "given": "hosted async fake debate create with job store spy",
      "expect": "one job enqueued and local queueMicrotask execution is not called"
    },
    {
      "name": "SSE start auth and strict filtering",
      "lens": "integration",
      "given": "authorized stream for debate A while event bus emits debate A, debate B, and run-only events",
      "expect": "only debate A events are sent"
    },
    {
      "name": "no forbidden debate routes",
      "lens": "integration",
      "given": "Fastify app with debate routes registered",
      "expect": "/debates/participants/real, /debates/judge, /model-judge, /judging return not found"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "registerDebateRoutes",
        "kind": "function",
        "signature": "registerDebateRoutes(app, deps: { service: DebateService; controlPlane?: ControlPlaneService; debateJobs?: DebateExecutionStore; requireHostedAuth?: boolean; routeMode?: local|hosted; getAuthContext(request): AuthContext|undefined; authorizeDebateRead(auth, debateId, requestId): Promise<AuthDecision>; enqueueDebateJob(debateId, auth, requestId): Promise<DebateExecutionJob>; mapServiceError(error): HttpErrorResponse }) => void"
      },
      {
        "name": "hosted debate auth rules",
        "kind": "constant",
        "signature": "POST /debates -> runs:write; GET /debates/:id and /debates/:id/events -> runs:read"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P23-T1-contracts-openapi-boundary",
        "name": "R24 debate HTTP error codes",
        "signature": "httpErrorCodeSchema includes debate_* and hosted_debate_* codes from the spec"
      },
      {
        "from_task": "P23-T2-postgres-debate-durability-idempotency",
        "name": "DebateExecutionStore",
        "signature": "durable enqueue, claim, linkPendingRun, and stale recovery contract"
      },
      {
        "from_task": "P23-T4-core-debate-orchestration-judge",
        "name": "DebateService.create",
        "signature": "create(input, { wait, auth, requestId }) performs evidence authorization and admission before side effects"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/protocol-rest/src/debate-routes.ts",
      "packages/protocol-rest/src/hosted-auth.ts"
    ]
  }
}
```

### Task P23-T6-hosted-server-debate-wiring

```json
{
  "id": "P23-T6-hosted-server-debate-wiring",
  "title": "Wire hosted server debate routes, stores, ownership, quota, and audit",
  "files": [
    "apps/server/src/app.ts",
    "apps/server/test/hosted-server.test.ts"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary",
    "P23-T2-postgres-debate-durability-idempotency",
    "P23-T4-core-debate-orchestration-judge",
    "P23-T5-rest-debate-hosted-boundary"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "apps/server/src/app.ts",
    "apps/server/test/hosted-server.test.ts",
    "packages/core/src/services/hosted-run-service.ts",
    "packages/core/src/services/control-plane-service.ts",
    "packages/protocol-rest/src/debate-routes.ts",
    "packages/storage/src/postgres/control-plane-store.ts"
  ],
  "instructions": "Register existing debate routes in hosted server mode using stores and services from prior tasks. Instantiate PostgresDebateStore, PostgresMessageStore, PostgresEvidenceStore, PostgresDebateExecutionStore, MessageRouter, ContextBuilder, and DebateService using the existing runs/events/artifacts/eventBus/registry/hostedRuns/controlPlane dependencies in app.ts. Do not instantiate real provider adapters in the server; keep the server adapter map fake-only. Implement debate admission hooks in app.ts that reserve debates_per_hour and active_debates quotas when configured, attach ownership for the debate row before returning the id, attach ownership for the debate job before enqueue success is disclosed, attach ownership for child runs before their ids are surfaced in debate inspect, attach ownership for routed messages/events before they are visible, attach ownership for final report artifacts before artifact id/path disclosure, record redacted audit events for admission denial, admission allow, participant dispatch, judge dispatch, terminal success/failure, ownership attach failure, and denied live spend, and finalize active_debates quota by outcome. Ownership attach failure on debate, child run, message, event, artifact, or debate job must fail closed with hosted_debate_ownership_attach_failed or a no-leak denial before the derived resource id becomes visible. Register registerDebateRoutes after hosted auth hooks so request.hostedAuth is available.",
  "acceptance": [
    "Hosted server registers POST /debates, GET /debates/:id, and GET /debates/:id/events only.",
    "Hosted fake debate create with API key auth persists debate state and enqueues an owned durable debate job.",
    "Hosted fake wait=1 remains no-spend and returns completed debate, events, and finalReportArtifact in test mode only when it can execute without provider calls.",
    "Server app never imports or constructs real provider adapters for debate participant or judge execution.",
    "Debate route auth, evidence auth delegation, ownership, quota, audit, and resource attachment are wired through the existing control plane.",
    "Ownership attach failures for child run, message, event, artifact, and debate job are directly tested before disclosure.",
    "Tenant mismatch on inspect/events does not leak debate existence through hosted server tests."
  ],
  "checks": [
    "pnpm --filter @switchyard/server test -- hosted-server",
    "pnpm --filter @switchyard/server typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "createServerApp debate store construction",
      "failure": "hosted debate enabled without Postgres debate store in staging/production",
      "exception": "missing postgres handle or store construction failure",
      "rescue": "Fail route admission before create and leave readiness to T7.",
      "user_sees": "POST /debates 503 hosted_debate_store_unavailable before provider work."
    },
    {
      "codepath": "debate quota reserve",
      "failure": "debates_per_hour or active_debates exceeded",
      "exception": "ControlPlaneStoreError quota_exceeded",
      "rescue": "Release any partial reservation, record redacted denial audit, and throw hosted_debate_quota_exceeded or quota_exceeded with reason details.",
      "user_sees": "429 hosted_debate_quota_exceeded or quota_exceeded."
    },
    {
      "codepath": "derived debate ownership attachment",
      "failure": "child run, event, message, artifact, or job ownership cannot be attached",
      "exception": "ownership attach returns not ok or throws",
      "rescue": "Do not disclose the derived id; fail admission or terminalize debate with hosted_debate_ownership_attach_failed and record error audit.",
      "user_sees": "Named ownership error with no cross-tenant data disclosure."
    },
    {
      "codepath": "terminal quota finalization",
      "failure": "finalize active_debates quota fails after terminal outcome",
      "exception": "ControlPlane quota finalize error",
      "rescue": "Record redacted audit and expose named server/worker metric while preserving terminal debate state.",
      "user_sees": "Debate terminal result remains stable; readiness/canary can report quota finalization issue."
    }
  ],
  "observability": {
    "logs": [
      "info hosted.debate.admission.allowed debateId runtimeModes judgeMode",
      "warn hosted.debate.admission.denied reasonCode runtimeModes judgeMode",
      "info hosted.debate.job.enqueued debateId jobId",
      "warn hosted.debate.ownership.attach_failed resourceType resourceId reasonCode",
      "info hosted.debate.quota.finalized debateId outcome"
    ],
    "success_metric": "hosted fake debate produces owned debate row, job row, child resources, audit entries, and quota finalization",
    "failure_metric": "hosted_debate_ownership_attach_failed, hosted_debate_quota_exceeded, hosted_debate_audit_unavailable, or quota finalization failure appears before cross-tenant disclosure"
  },
  "test_cases": [
    {
      "name": "hosted server exposes only debate family",
      "lens": "integration",
      "given": "createServerApp test mode",
      "expect": "POST /debates exists, GET /debates/:id exists, GET /debates/:id/events exists, forbidden debate and execution routes return not found"
    },
    {
      "name": "auth required for hosted debate create",
      "lens": "error_path",
      "given": "api_key mode hosted server and POST /debates without key",
      "expect": "401 auth_required and no debate row"
    },
    {
      "name": "hosted fake async persists and enqueues",
      "lens": "happy",
      "given": "POST /debates with fake participants and runs:write key",
      "expect": "202, durable debate row, owned debate resource, durable owned debate job"
    },
    {
      "name": "quota denial is audited",
      "lens": "error_path",
      "given": "billing plan with active_debates limit reached",
      "expect": "429 hosted_debate_quota_exceeded and redacted denial audit payload"
    },
    {
      "name": "derived ownership attach failures do not disclose ids",
      "lens": "error_path",
      "given": "control plane attach fails separately for child run, message, event, artifact, and debate job",
      "expect": "hosted_debate_ownership_attach_failed or no-leak denial before that resource id appears in response, event stream, inspect, or artifact output"
    },
    {
      "name": "server source does not import provider adapters for debate",
      "lens": "integration",
      "given": "apps/server/src/app.ts source",
      "expect": "no imports from @switchyard/adapters and only FakeRuntimeAdapter is constructed"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "hosted debate app wiring",
        "kind": "function",
        "signature": "createServerApp(config) registers debate routes with DebateService, Postgres stores, controlPlane, hostedRuns, registry, eventBus, and debateJobs"
      },
      {
        "name": "hosted debate ownership hooks",
        "kind": "function",
        "signature": "attachDebateOwnership(resourceType: debate|debate_job|run|message|event|artifact, resourceId, auth) => Promise<void> throws hosted_debate_ownership_attach_failed before disclosure"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P23-T2-postgres-debate-durability-idempotency",
        "name": "Postgres debate stores and DebateExecutionStore",
        "signature": "durable stores and job outbox constructors"
      },
      {
        "from_task": "P23-T4-core-debate-orchestration-judge",
        "name": "DebateService.create/processExecutionJob",
        "signature": "service exposes admission and quota finalization outputs"
      },
      {
        "from_task": "P23-T5-rest-debate-hosted-boundary",
        "name": "registerDebateRoutes",
        "signature": "route dependency contract with auth, enqueue, and error mapping fields"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "apps/server/src/app.ts"
    ]
  }
}
```

### Task P23-T7-hosted-debate-readiness

```json
{
  "id": "P23-T7-hosted-debate-readiness",
  "title": "Add hosted debate readiness diagnostics",
  "files": [
    "apps/server/src/readiness.ts",
    "apps/server/test/production-readiness.test.ts"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary",
    "P23-T2-postgres-debate-durability-idempotency",
    "P23-T6-hosted-server-debate-wiring"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "apps/server/src/readiness.ts",
    "apps/server/test/production-readiness.test.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts",
    "packages/storage/src/postgres/control-plane-store.ts",
    "packages/protocol-rest/src/hosted-auth.ts"
  ],
  "instructions": "Extend /ready and probeServerReadiness with hostedDebate diagnostics independent from route wiring. Check debate store, message store, evidence store, event store, artifact metadata store, artifact content store, debate execution outbox, run queue, control-plane ownership, quota, audit, route auth configuration, hosted runtime allowlist, provider activation gates, unowned debate-derived resource counts, and R23 bridge readiness when the allowlist includes Claude or OpenCode. Fail closed with named hosted_debate_* or existing hosted_runtime_bridge_* codes when any enabled dependency is missing. Diagnostics must be low-cardinality and must not include prompts, provider output, evidence content, API keys, tenant ids, or raw resource ids.",
  "acceptance": [
    "Readiness reports hostedDebate dependency checks when hosted debate is enabled.",
    "Readiness fails closed when store, queue, auth, quota, audit, object-store, runtime policy, unowned resources, or bridge readiness is unavailable.",
    "Readiness success does not require live provider spend.",
    "Diagnostics are low-cardinality and redacted.",
    "This task owns readiness only; server route/store/control-plane wiring remains in T6."
  ],
  "checks": [
    "pnpm --filter @switchyard/server test -- production-readiness",
    "pnpm --filter @switchyard/server typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "readiness hostedDebate store checks",
      "failure": "debate store or debate outbox unavailable",
      "exception": "probe failure",
      "rescue": "Return hosted_debate_store_unavailable or hosted_debate_queue_unavailable and skip provider probes.",
      "user_sees": "GET /ready 503 with hostedDebate named code."
    },
    {
      "codepath": "readiness ownership checks",
      "failure": "unowned debate-derived resources exist",
      "exception": "unowned resource count > 0",
      "rescue": "Return unowned_resources_present with resource-type counts only.",
      "user_sees": "GET /ready 503 with low-cardinality ownership diagnostics."
    },
    {
      "codepath": "readiness bridge dependency",
      "failure": "allowlist includes claude_code.sdk or opencode.acp and bridge store/worker is missing",
      "exception": "bridge readiness false",
      "rescue": "Surface hosted_runtime_bridge_store_unavailable or hosted_runtime_bridge_worker_unavailable in hostedDebate diagnostics.",
      "user_sees": "GET /ready 503 with hostedDebate and bridge named codes."
    }
  ],
  "observability": {
    "logs": [
      "info readiness.hosted_debate status code",
      "warn readiness.hosted_debate.unowned resourceType count",
      "warn readiness.hosted_debate.bridge_unavailable code"
    ],
    "success_metric": "hostedDebate readiness check ok with fake/no-spend posture and all dependencies present",
    "failure_metric": "hostedDebate readiness check fails with named dependency code and redacted diagnostics"
  },
  "test_cases": [
    {
      "name": "readiness all debate dependencies ready",
      "lens": "happy",
      "given": "staging/production readiness with all debate dependencies, no unowned rows, fake default allowlist",
      "expect": "hostedDebate ok true and no live provider calls"
    },
    {
      "name": "readiness missing debate store",
      "lens": "error_path",
      "given": "staging/production readiness without Postgres debate store dependency",
      "expect": "hostedDebate check fails hosted_debate_store_unavailable"
    },
    {
      "name": "readiness unowned derived resource",
      "lens": "error_path",
      "given": "unowned child run, message, event, artifact, or debate job count is nonzero",
      "expect": "hostedDebate check fails unowned_resources_present with type counts only"
    },
    {
      "name": "readiness bridge dependency",
      "lens": "edge_bridge_dependency",
      "given": "allowlist includes claude_code.sdk or opencode.acp and bridge worker readiness false",
      "expect": "hostedDebate or hostedRuntimeBridge check fails with hosted_runtime_bridge_worker_unavailable"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "hostedDebate readiness check",
        "kind": "constant",
        "signature": "probeServerReadiness returns checks.hostedDebate with low-cardinality diagnostics and named codes"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P23-T2-postgres-debate-durability-idempotency",
        "name": "control-plane unowned resource counts",
        "signature": "counts include debate, job, child run, message, event, evidence, and artifact resources"
      },
      {
        "from_task": "P23-T6-hosted-server-debate-wiring",
        "name": "hosted debate app wiring",
        "signature": "route/store/control-plane dependencies exist for readiness probing"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "apps/server/src/readiness.ts"
    ]
  }
}
```

### Task P23-T8-worker-debate-job-execution

```json
{
  "id": "P23-T8-worker-debate-job-execution",
  "title": "Teach hosted worker to advance debate jobs",
  "files": [
    "apps/worker/src/worker.ts",
    "apps/worker/src/ready.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts"
  ],
  "dependencies": [
    "P23-T2-postgres-debate-durability-idempotency",
    "P23-T4-core-debate-orchestration-judge",
    "P23-T6-hosted-server-debate-wiring",
    "P23-T7-hosted-debate-readiness"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "apps/worker/src/worker.ts",
    "apps/worker/src/ready.ts",
    "apps/worker/src/hosted-runtime-adapters.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts",
    "packages/core/src/services/debate-service.ts",
    "packages/core/src/services/hosted-runtime-bridge-service.ts"
  ],
  "instructions": "Add debate job processing to the hosted worker without changing provider adapter ownership. Instantiate PostgresDebateStore, PostgresMessageStore, PostgresEvidenceStore, PostgresDebateExecutionStore, MessageRouter, ContextBuilder, and DebateService in worker mode with the worker-owned RuntimeRunnerService and existing run/event/session/artifact stores. Process at most one debate job per tick in an ordering proven by tests to avoid child-run starvation. On each claim, call DebateService.processExecutionJob, then complete, fail, or release/requeue with nextAttemptAt. Recover stale debate claims. If stale recovery finds an existing participant or judge run by DebateChildRunKey, relink it and do not create a duplicate. If a provider run completes after the debate terminalized, do not route output or reopen status. On any terminal success or terminal failure, invoke quota finalization for active_debates exactly once. Worker readiness must include debate execution capability when hosted debate is expected: debate job store, claim/release functions, run dispatch, participant output collection, judge runner, artifact writer, object store, quota finalizer, and R23 bridge readiness for Claude/OpenCode allowlist modes.",
  "acceptance": [
    "Worker tick can claim and advance a hosted fake debate job without live provider calls.",
    "Worker does not block indefinitely waiting for child hosted run completion; pending child runs are observed in later job advances.",
    "Stale debate job claims are recovered or exhausted with named reason codes.",
    "Stale retry after createRun succeeded but pending-run link failed reuses the existing run and creates no duplicate child run.",
    "Late provider completion after debate terminalization is ignored or recorded as late without reopening debate state.",
    "Worker terminal success and terminal failure both finalize active_debates quota exactly once.",
    "Worker readiness reports debate capability and fails closed when debate job store, object store, run dispatch, artifact writer, quota finalizer, or bridge readiness is missing.",
    "Real provider adapters remain worker-owned through existing hosted runtime adapter construction only.",
    "Default worker tests remain fake/no-spend unless a test injects fake provider adapters."
  ],
  "checks": [
    "pnpm --filter @switchyard/worker test -- hosted-worker",
    "pnpm --filter @switchyard/worker test -- production-worker-readiness",
    "pnpm --filter @switchyard/worker typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "worker.tick debate claim",
      "failure": "debate job store unavailable",
      "exception": "DebateExecutionStoreError hosted_debate_queue_unavailable",
      "rescue": "Return false from tick, expose readiness failure, and do not process provider runs.",
      "user_sees": "worker readiness fails hosted_debate_queue_unavailable."
    },
    {
      "codepath": "processExecutionJob child run pending",
      "failure": "participant or judge child run is still queued/running/waiting",
      "exception": "nonterminal run status",
      "rescue": "Release debate job with bounded nextAttemptAt and no busy loop.",
      "user_sees": "debate inspect remains nonterminal with persisted run id; no duplicate child run is created."
    },
    {
      "codepath": "stale debate claim recovery",
      "failure": "worker crashes after createRun succeeded and before pending-run link persisted",
      "exception": "expired lease",
      "rescue": "Recover to queued, find existing run by DebateChildRunKey, link it, and continue.",
      "user_sees": "debate eventually retries without duplicate provider work."
    },
    {
      "codepath": "worker terminal failure",
      "failure": "debate fails after active_debates quota was reserved",
      "exception": "terminal failure action",
      "rescue": "Finalize active_debates quota exactly once and record redacted audit.",
      "user_sees": "Quota is not leaked by failed debate."
    },
    {
      "codepath": "artifact writer during worker finalization",
      "failure": "object store write fails",
      "exception": "object_store_unavailable|object_store_timeout",
      "rescue": "Fail job and debate with hosted_debate_artifact_write_failed and finalize quota.",
      "user_sees": "failed debate with named artifact code."
    }
  ],
  "observability": {
    "logs": [
      "info worker.debate_job.claimed workerId jobId debateId stage",
      "info worker.debate_job.released workerId jobId debateId nextAttemptAt reasonCode",
      "info worker.debate_job.completed workerId jobId debateId",
      "warn worker.debate_job.failed workerId jobId debateId reasonCode",
      "warn worker.debate_job.recovered recovered exhausted invalid",
      "info worker.debate.quota.finalized debateId outcome"
    ],
    "success_metric": "worker advances fake hosted debate jobs to terminal debate state with final report and no live provider calls",
    "failure_metric": "readiness or job failure uses hosted_debate_queue_unavailable, hosted_debate_worker_unavailable, hosted_debate_artifact_write_failed, or bridge readiness codes"
  },
  "test_cases": [
    {
      "name": "worker advances fake debate job",
      "lens": "happy",
      "given": "durable fake debate job in memory/Postgres test store",
      "expect": "worker tick returns true and debate progresses without provider adapter calls"
    },
    {
      "name": "pending child run requeues debate job",
      "lens": "happy_shadow_empty",
      "given": "debate job references child run status running",
      "expect": "job released with nextAttemptAt, no duplicate run id, debate remains nonterminal"
    },
    {
      "name": "stale claim after createRun reuses existing run",
      "lens": "error_path",
      "given": "createRun succeeded, pending link failed, claim expired, and retry runs",
      "expect": "findByDebateChildRunKey returns existing run and total child run count remains one"
    },
    {
      "name": "late child run output ignored",
      "lens": "edge_late_output",
      "given": "debate is terminal before pending participant run completes with runtime.output",
      "expect": "no message routed, no status reopen, optional late-output diagnostic only"
    },
    {
      "name": "worker terminal failure finalizes quota",
      "lens": "error_path",
      "given": "debate job fails due to artifact write or output error after active_debates reserve",
      "expect": "quota finalizer called once and debate remains terminal failed"
    },
    {
      "name": "stale debate claim exhausted",
      "lens": "error_path",
      "given": "claimed debate job with expired lease at max attempts",
      "expect": "job exhausted, debate failed with hosted_debate_worker_unavailable, and active_debates finalized"
    },
    {
      "name": "bridge readiness required for debate allowlist",
      "lens": "edge_bridge_dependency",
      "given": "allowlist includes opencode.acp and bridge payload store missing",
      "expect": "worker readiness not ok with hosted_runtime_bridge_store_unavailable"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "worker debate job processing",
        "kind": "function",
        "signature": "createHostedWorker(config).tick() processes at most one DebateExecutionStore job per tick and returns boolean"
      },
      {
        "name": "worker debate readiness",
        "kind": "constant",
        "signature": "WorkerReadinessReport.checks.hostedDebate?: { ok:boolean; code?: string; diagnostics?: Record<string, unknown> }"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P23-T2-postgres-debate-durability-idempotency",
        "name": "DebateExecutionStore and RunStore child lookup",
        "signature": "durable job claim/link and findByDebateChildRunKey"
      },
      {
        "from_task": "P23-T4-core-debate-orchestration-judge",
        "name": "DebateService.processExecutionJob",
        "signature": "processExecutionJob(job) returns action and quotaFinalization metadata"
      },
      {
        "from_task": "P23-T7-hosted-debate-readiness",
        "name": "hostedDebate readiness check",
        "signature": "readiness dependency vocabulary and named codes"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "apps/worker/src/worker.ts",
      "apps/worker/src/ready.ts"
    ]
  }
}
```

### Task P23-T9-preflight-canary-no-spend

```json
{
  "id": "P23-T9-preflight-canary-no-spend",
  "title": "Add no-spend debate preflight and canary gates",
  "files": [
    "scripts/production-preflight.ts",
    "scripts/production-preflight.test.ts",
    "scripts/production-canary.ts",
    "scripts/production-canary.test.ts",
    "deploy/production/manifest.json",
    "deploy/production/production-manifest.test.ts"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary",
    "P23-T5-rest-debate-hosted-boundary",
    "P23-T6-hosted-server-debate-wiring",
    "P23-T7-hosted-debate-readiness",
    "P23-T8-worker-debate-job-execution"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "scripts/production-preflight.ts",
    "scripts/production-preflight.test.ts",
    "scripts/production-canary.ts",
    "scripts/production-canary.test.ts",
    "deploy/production/manifest.json",
    "apps/server/src/readiness.ts"
  ],
  "instructions": "Extend production preflight and canary without adding live spend to defaults. Preflight must include hosted debate dependency checks for auth, Postgres schema, debate store, message/evidence stores, event store, artifact store/content, debate execution outbox, run queue, object store, ownership, quota, audit, worker readiness, provider activation gates, and R23 bridge readiness when Claude/OpenCode are allowlisted. Default canary must create a fake hosted debate through /debates, poll inspect/events until terminal or timeout, verify participant run ids, event ids, message ids, judge, stop reason, final report artifact metadata, metrics, audit evidence, SSE debateId filtering if streaming canary mode is enabled, and no live provider calls. Add allowed canary paths for /debates, /debates/:id, and /debates/:id/events. Add optional live participant and live judge flags such as --live-debate-runtimes, --live-debate-judge, and --confirm-live-provider-spend. If a live debate flag is supplied without spend confirmation, fail fast with debate_live_canary_spend_unconfirmed before any network request that can create provider work.",
  "acceptance": [
    "Production preflight passes the fake/no-spend hosted debate posture when all dependencies are ready.",
    "Production preflight fails closed with named hosted_debate_* or existing dependency codes when debate store, queue, auth, quota, audit, object store, worker readiness, provider activation, or bridge readiness is missing.",
    "Default production canary runs fake hosted debate only and records live participant/live judge checks as skipped.",
    "Default canary verifies debate inspect/events/artifact/audit traceability and makes no live provider calls.",
    "Live participant canary requires an explicit live flag and spend confirmation.",
    "Live judge canary requires an explicit live flag and spend confirmation.",
    "Supplying a live debate flag without spend confirmation fails with debate_live_canary_spend_unconfirmed before provider dispatch."
  ],
  "checks": [
    "pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts deploy/production/production-manifest.test.ts",
    "pnpm typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "runProductionPreflight hostedDebate",
      "failure": "hosted debate dependency is missing or unhealthy",
      "exception": "dependency check false",
      "rescue": "Add fail check with exact named code and redacted diagnostics; skip downstream live probes.",
      "user_sees": "preflight fails with hosted_debate_store_unavailable, hosted_debate_queue_unavailable, auth_required, quota_store_unavailable, audit_log_unavailable, object_store_unavailable, provider_runtime_policy_missing, or hosted_runtime_bridge_store_unavailable."
    },
    {
      "codepath": "runProductionCanary live debate input",
      "failure": "live participant or live judge flag supplied without confirmLiveProviderSpend",
      "exception": "input guard",
      "rescue": "Finalize canary with debate_live_canary_spend_unconfirmed before POST /debates.",
      "user_sees": "canary fail step input.liveDebate with debate_live_canary_spend_unconfirmed."
    },
    {
      "codepath": "default fake debate canary",
      "failure": "debate stays nonterminal past timeout",
      "exception": "poll timeout",
      "rescue": "Fail canary with debate_fake_canary_failed and include last status only.",
      "user_sees": "canary failure without raw prompt or provider output."
    },
    {
      "codepath": "debate artifact verification",
      "failure": "final report artifact missing or content digest invalid when content is readable",
      "exception": "artifact assertion failure",
      "rescue": "Fail canary with artifact_missing or artifact_digest_mismatch using existing canary envelope.",
      "user_sees": "canary names artifact traceability failure."
    }
  ],
  "observability": {
    "logs": [
      "canary step debate.create pass|fail code",
      "canary step debate.inspect pass|fail status stopReason",
      "canary step debate.events pass|fail eventCount",
      "canary step debate.artifact pass|fail artifactId",
      "canary step debate.liveParticipants info debate_live_canary_skipped_default",
      "canary step debate.liveJudge info debate_live_canary_skipped_default"
    ],
    "success_metric": "default canary ends canary_ok after fake debate terminal state with audit evidence",
    "failure_metric": "debate_fake_canary_failed or debate_live_canary_spend_unconfirmed appears with no provider dispatch"
  },
  "test_cases": [
    {
      "name": "preflight fake debate dependencies pass",
      "lens": "happy",
      "given": "mock server/worker config with all debate dependencies ready",
      "expect": "hostedDebate preflight check pass"
    },
    {
      "name": "preflight missing debate queue fails",
      "lens": "error_path",
      "given": "dependency check reports no debate outbox",
      "expect": "hosted_debate_queue_unavailable fail and downstream live checks skipped"
    },
    {
      "name": "default canary fake debate",
      "lens": "happy",
      "given": "mock HTTP server returns ready, accepts fake /debates, terminal inspect, debate events, artifact metadata, metrics, audit",
      "expect": "canary_ok and steps include live debate skipped defaults"
    },
    {
      "name": "live participant flag without spend confirmation",
      "lens": "error_path",
      "given": "runProductionCanary({ liveDebateRuntimes: true, confirmLiveProviderSpend: false })",
      "expect": "debate_live_canary_spend_unconfirmed before any POST /debates"
    },
    {
      "name": "live judge flag without spend confirmation",
      "lens": "error_path",
      "given": "runProductionCanary({ liveDebateJudge: true, confirmLiveProviderSpend: false })",
      "expect": "debate_live_canary_spend_unconfirmed before any POST /debates"
    },
    {
      "name": "canary allowed paths include debates only",
      "lens": "integration",
      "given": "canary request path guard",
      "expect": "/debates, /debates/:id, /debates/:id/events allowed; /model-judge and /debates/judge denied by tests"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "runProductionPreflight",
        "kind": "function",
        "signature": "runProductionPreflight(options) => Promise<ProductionPreflightResult> with hostedDebate checks"
      },
      {
        "name": "runProductionCanary",
        "kind": "function",
        "signature": "runProductionCanary(options: ProductionCanaryOptions & { liveDebateRuntimes?: boolean; liveDebateJudge?: boolean; confirmLiveProviderSpend?: boolean }) => Promise<ProductionCanaryResult>"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P23-T1-contracts-openapi-boundary",
        "name": "R24 debate HTTP error codes",
        "signature": "httpErrorCodeSchema includes debate_* and hosted_debate_* codes from the spec"
      },
      {
        "from_task": "P23-T5-rest-debate-hosted-boundary",
        "name": "hosted debate auth rules",
        "signature": "POST /debates -> runs:write; GET /debates/:id and /debates/:id/events -> runs:read"
      },
      {
        "from_task": "P23-T7-hosted-debate-readiness",
        "name": "hostedDebate readiness check",
        "signature": "probeServerReadiness returns checks.hostedDebate with low-cardinality diagnostics and named codes"
      },
      {
        "from_task": "P23-T8-worker-debate-job-execution",
        "name": "worker debate readiness",
        "signature": "WorkerReadinessReport.checks.hostedDebate?: { ok:boolean; code?: string; diagnostics?: Record<string, unknown> }"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "scripts/production-preflight.ts",
      "scripts/production-canary.ts"
    ]
  }
}
```

### Task P23-T10-product-docs-truth

```json
{
  "id": "P23-T10-product-docs-truth",
  "title": "Update product, operator, and adapter truth",
  "files": [
    "PRODUCT.md",
    "README.md",
    "docs/development/API.md",
    "docs/development/DEVELOPMENT.md",
    "docs/adapters/README.md",
    "docs/adapters/codex.md",
    "docs/adapters/claude-code.md",
    "docs/adapters/opencode.md",
    "docs/adapters/agentfield.md",
    "docs/adapters/generic-http.md",
    "deploy/production/README.md"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary",
    "P23-T2-postgres-debate-durability-idempotency",
    "P23-T3-core-debate-runtime-output",
    "P23-T4-core-debate-orchestration-judge",
    "P23-T5-rest-debate-hosted-boundary",
    "P23-T6-hosted-server-debate-wiring",
    "P23-T7-hosted-debate-readiness",
    "P23-T8-worker-debate-job-execution",
    "P23-T9-preflight-canary-no-spend"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "PRODUCT.md",
    "PROJECT.md",
    "README.md",
    "docs/development/API.md",
    "docs/development/DEVELOPMENT.md",
    "docs/adapters/README.md",
    "docs/adapters/codex.md",
    "docs/adapters/claude-code.md",
    "docs/adapters/opencode.md",
    "docs/adapters/agentfield.md",
    "docs/adapters/generic-http.md",
    "deploy/production/README.md"
  ],
  "instructions": "Update product truth after implementation without overclaiming. State that R24 ships hosted/server-safe debate through the existing /debates route family, fake deterministic hosted debate as the default no-spend path, opt-in hosted debate participant runs for fake.deterministic, codex.exec_json, claude_code.sdk, and opencode.acp, and an internal bounded judge runner with deterministic default and live model judge only behind request opt-in and spend confirmation. State that debate participant and judge execution use existing run/runtime contracts and preserve run/message/event/artifact traceability. State hosted debate requires durable Postgres debate/message/evidence/job state, child-run idempotency, evidence ownership preauthorization, ownership, quota, audit, queue/outbox, object store, worker readiness, provider activation, and R23 bridge readiness where applicable. Explicitly say codex.exec_json remains one-shot, hosted codex.interactive remains unshipped, AgentField/Generic HTTP hosted debate bridges remain unshipped, public model judge routes remain unshipped, browser automation remains unshipped, hosted repo remains unshipped, generic process and PTY adapters remain unshipped, dashboard/TUI remain unshipped, and managed SaaS/billing/OAuth remain unshipped. Document production preflight and canary commands, no-spend default, and live debate spend confirmation gates.",
  "acceptance": [
    "PRODUCT.md current snapshot reflects R24 shipped and unshipped boundary.",
    "README and development API docs list only existing debate routes and no public model judge route.",
    "Development docs describe fake default, real participant opt-in, placement hosted requirement, live judge opt-in, wait=1 fake-only support, and named failure codes.",
    "Production docs document hosted debate readiness/preflight/canary dependencies and live spend confirmation flags.",
    "Adapter docs state codex.exec_json one-shot, Claude/OpenCode R23 bridge dependency, and AgentField/Generic HTTP bridge unshipped status.",
    "Docs do not claim dashboard, TUI, public arbitrary execution routes, PTY/terminal automation, browser automation, hosted repo, generic process/PTY adapters, public model judging, managed SaaS, billing, OAuth, SSO, SCIM, or hosted Codex interactive."
  ],
  "checks": [
    "rg -n \"model-judge|/debates/judge|/judging|hosted Codex interactive|dashboard|TUI|generic process|PTY|managed SaaS\" PRODUCT.md README.md docs/development/API.md docs/development/DEVELOPMENT.md docs/adapters deploy/production/README.md",
    "pnpm --filter @switchyard/contracts openapi:check:hosted",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "docs shipped/unshipped boundary",
      "failure": "docs imply public model judging, hosted codex.interactive, AgentField/Generic HTTP hosted bridge, dashboard, TUI, PTY, process, browser, repo, managed SaaS, billing, or OAuth shipped",
      "exception": "grep or review failure",
      "rescue": "Rewrite as explicitly unshipped and keep the route list limited to existing /debates routes.",
      "user_sees": "Accurate product truth without overclaiming."
    }
  ],
  "observability": {
    "logs": [
      "documentation-only task; verification is rg/openapi/git diff checks"
    ],
    "success_metric": "docs state R24 boundary and forbidden-route OpenAPI check passes",
    "failure_metric": "docs contain overclaiming text or outdated R23 hosted debate unshipped wording"
  },
  "test_cases": [
    {
      "name": "product truth updated",
      "lens": "happy",
      "given": "PRODUCT.md current snapshot",
      "expect": "R24 hosted real debate shipped boundary appears and R23 unshipped hosted debate wording is replaced"
    },
    {
      "name": "API docs route boundary",
      "lens": "integration",
      "given": "docs/development/API.md",
      "expect": "only POST /debates, GET /debates/:id, GET /debates/:id/events are documented for debate"
    },
    {
      "name": "live spend gate documented",
      "lens": "happy",
      "given": "deploy/production/README.md",
      "expect": "default fake debate canary and explicit live debate spend confirmation flags are documented"
    },
    {
      "name": "adapter boundary truth",
      "lens": "edge_docs_boundary",
      "given": "codex, claude-code, opencode, agentfield, and generic-http adapter docs",
      "expect": "Codex exec JSON one-shot, Claude/OpenCode bridge dependency, and AgentField/Generic HTTP bridge unshipped statements are present"
    },
    {
      "name": "no overclaiming",
      "lens": "error_path",
      "given": "docs grep for forbidden shipped claims",
      "expect": "no text claims public model judge routes, dashboard/TUI, PTY/terminal automation, browser automation, hosted repo, generic process/PTY adapters, managed SaaS, billing, OAuth, SSO, SCIM, or hosted codex.interactive shipped"
    }
  ],
  "integration_contracts": {
    "exports": [],
    "imports_from_other_tasks": [
      {
        "from_task": "P23-T9-preflight-canary-no-spend",
        "name": "runProductionCanary",
        "signature": "runProductionCanary(options: ProductionCanaryOptions & { liveDebateRuntimes?: boolean; liveDebateJudge?: boolean; confirmLiveProviderSpend?: boolean }) => Promise<ProductionCanaryResult>"
      }
    ],
    "file_paths_consumed_by_other_tasks": []
  }
}
```

## Integration Points

The contract task lands shared request, error, ownership, quota, and OpenAPI vocabulary first. Storage then provides durable Postgres debate state, job claims, child-run idempotency, and unowned-resource counts. Runtime helper work normalizes allowed participant modes and extracts bounded output. DebateService imports those helpers and owns evidence authorization, staged orchestration, judge parsing, report writing, terminal status checks, and quota finalization metadata. REST routes use DebateService and durable enqueue while enforcing hosted auth, no-leak reads, and SSE filtering. Hosted server wiring composes stores, service, control-plane hooks, ownership attachment, quota, and audit. Readiness probes those dependencies. Hosted worker processes durable jobs. Ops scripts call hosted /debates and readiness outputs. Docs land last.

Cross-task contract walk:

- T2 imports T1 debate ownership/quota vocabulary.
- T3 imports T1 request/error vocabulary and T2 child-run lookup contracts.
- T4 imports T1 contracts, T2 stores/idempotency, and T3 runtime/output helpers.
- T5 imports T1 errors, T2 DebateExecutionStore, and T4 DebateService.
- T6 imports T2 Postgres stores, T4 DebateService, and T5 route contract.
- T7 imports T2 unowned-resource counts and T6 wiring.
- T8 imports T2 DebateExecutionStore/RunStore, T4 processExecutionJob, and T7 readiness vocabulary.
- T9 imports T5 route behavior, T7 readiness, and T8 worker readiness.
- T10 imports T9 operator behavior for documentation.

No two tasks own the same file.

## Architect Review Focus

1. Verify evidence authorization happens before evidence store lookup and content loading in hosted create.
2. Verify child participant and judge run creation is idempotent across createRun success plus pending-link crash.
3. Verify ownership attach failures for child run, message, event, artifact, and debate job cannot disclose ids or cross-tenant state.
4. Verify placement hosted is mandatory for every non-fake participant with realRuntimeOptIn true.
5. Verify SSE stream start authorization and strict debateId event filtering.
6. Verify worker terminal failure finalizes active_debates quota.
7. Verify judge parser checks size before JSON.parse.
8. Verify docs and OpenAPI keep the public route boundary limited to the existing /debates family.

## Known High-Risk Seams

- Evidence authorization order: any evidence store/content access before hosted ownership authorization leaks existence or content.
- Child run idempotency: createRun and job pending-run persistence cross service boundaries and must survive stale claim retry.
- Derived ownership attachment: child run, message, event, artifact, and job ids must not be disclosed before ownership is attached.
- SSE filtering: event bus traffic may include run events or other debate events, so stream filtering must be exact.
- Late provider output: terminal debates must not reopen when child runs finish late.
- Quota accounting: active_debates must finalize on success, failure, cancellation, exhausted retry, and artifact failure.
- Judge parsing: live model output must be capped before parse to avoid memory or CPU abuse.
- Server/provider boundary: server must remain fake-only for adapters; worker owns real provider dispatch.
- No-spend defaults: tests, preflight, and canary must not make live provider calls unless explicit live flags and spend confirmation are present.

## Phase-Level Acceptance Criteria

- Hosted /debates route family exists with auth, ownership, quota, audit, durable state, no-spend default, and no forbidden public routes.
- Hosted create preauthorizes evidence ids before lookup/content access and has no side effects on unknown/unowned evidence.
- Non-fake participants require realRuntimeOptIn true and placement hosted.
- Participant and judge child runs are idempotent across stale claims.
- Derived resource ownership attach failures fail closed before disclosure.
- SSE events are authorized and filtered by debate id.
- Worker handles stale claims, late outputs, terminal failures, quota finalization, and bridge readiness.
- Deterministic fake judge is default; live model judge is explicit and spend-gated.
- Production preflight/canary default to fake/no-spend and live-spend canary fails before provider dispatch without confirmation.
- PRODUCT, README, development, production, and adapter docs reflect shipped and unshipped truth.

## Verification Strategy

- pnpm --filter @switchyard/contracts test
- pnpm --filter @switchyard/contracts openapi:check
- pnpm --filter @switchyard/contracts openapi:check:hosted
- pnpm --filter @switchyard/storage test -- postgres-debate
- pnpm --filter @switchyard/storage test -- postgres-run-store
- pnpm --filter @switchyard/storage test -- postgres-schema-compat
- pnpm --filter @switchyard/core test -- debate-real-runtime
- pnpm --filter @switchyard/core test -- debate-service
- pnpm --filter @switchyard/core test -- debate-judge-runner
- pnpm --filter @switchyard/protocol-rest test -- debate-routes
- pnpm --filter @switchyard/protocol-rest test -- hosted-auth
- pnpm --filter @switchyard/server test -- hosted-server
- pnpm --filter @switchyard/server test -- production-readiness
- pnpm --filter @switchyard/worker test -- hosted-worker
- pnpm --filter @switchyard/worker test -- production-worker-readiness
- pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts deploy/production/production-manifest.test.ts
- pnpm typecheck
- pnpm build
- pnpm lint
- git diff --check
- local placeholder-language scan over the plan artifact
- rg -n "(/debates/participants/real|/debates/judge|/model-judge|/judging|/exec|/shell|/process|/command|/pty|/terminal|/sandbox)" packages/contracts/openapi.hosted-server.json packages/contracts/openapi.local-daemon.json

## Self-Review

1. Existing code challenged: yes; plan extends current debate, hosted auth, stores, worker, readiness, preflight, canary, and OpenAPI seams.
2. Minimal changes challenged: yes; no dashboard, TUI, new route family, generic adapter, or SaaS surface.
3. Complexity challenged: yes; ten tasks split core and server seams, with T2 kept unified for migration coherence.
4. Built-in check passed: yes; existing schemas, stores, control plane, run service, event bus, bridge readiness, and ops scripts are reused.
5. Distribution check passed: yes; no new package or binary.
6. File ownership is disjoint across all tasks.
7. Every task has non-empty context_files grounded in existing repo files.
8. Every task has instructions, acceptance, checks, error rescue, observability, test cases, and integration contracts.
9. No task depends on a new public participant, judge, model-judge, terminal, PTY, shell, process, sandbox, dashboard, or TUI route.
10. No-spend defaults are explicit in contracts, service, worker, preflight, canary, and docs.
11. Hosted tenant ownership, quota, audit, and no-leak behavior are covered before disclosure.
12. Architect pass 1 findings A1-A7 and edge cases E1-E4 are mapped to tasks and tests.
13. Verification commands cover contracts, storage, core, protocol REST, server, worker, scripts, docs, typecheck, build, lint, and diff hygiene.

## Plan Completeness Self-Test

1. Required task fields present: yes.
2. Context files non-empty: yes.
3. Context files exist in this worktree: validated after authoring.
4. File ownership disjoint: validated after authoring.
5. Dependencies form an acyclic graph: yes.
6. Acceptance criteria include happy, shadow, error, edge, and integration lenses: yes.
7. Error rescue maps include user-visible outcomes: yes.
8. Observability includes logs, success metric, and failure metric: yes.
9. Integration contracts identify exports, imports, and consumed file paths: yes.
