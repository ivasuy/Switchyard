# Phase 23: R24 Hosted Real Debate - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md`  
**Branch:** `agent/phase-23-r24-hosted-real-debate`  
**Base/spec commit:** `53473b38016136452bf6755f6dde2f875621c1a9`  
**Complexity:** L

## Goal

Ship hosted/server-safe debate execution through the existing `/debates` route family, with deterministic no-spend defaults, explicit real-runtime and live-judge opt-ins, durable hosted state, tenant-safe ownership, and no new public participant, judge, model-judge, terminal, PTY, shell, process, sandbox, dashboard, or TUI routes.

## Scope Challenge

1. Existing code already partially solves R24 through `DebateService`, `registerDebateRoutes`, `SqliteDebateStore`, `MessageRouter`, `ContextBuilder`, `RunService`, `HostedRunService`, `HostedRuntimeCatalog`, R23 bridge readiness helpers, `ControlPlaneService`, Postgres event/artifact stores, production preflight, production canary, and OpenAPI route-boundary tests. Extend these seams; do not create a second public debate API or a server-owned provider adapter path.
2. The minimum shippable change is additive debate create contract validation, Postgres debate/message/evidence persistence, a durable debate execution job store, a staged debate orchestrator that creates normal run records per turn, an internal judge runner, hosted route auth/ownership/quota/audit wiring, worker claim/readiness integration, ops canary/preflight coverage, and product truth updates. Dashboard, TUI, public model judging, AgentField/Generic HTTP bridges, hosted Codex interactive, browser automation, hosted repo, generic process, and PTY stay out of scope.
3. Complexity smell is real because the phase must touch contracts, storage, core orchestration, REST routing, hosted server wiring, worker readiness, ops scripts, OpenAPI, and docs. The plan controls blast radius with eight ownership slices and a staged durable debate-job state machine rather than a long blocking provider wait loop.
4. Built-in and existing primitives are sufficient: Zod schemas, existing HTTP error envelope, existing Fastify hooks, existing control-plane ownership/quota/audit APIs, existing HostedRunService provider gates, existing R23 bridge readiness helpers, existing `runtime.output` events, existing MessageRouter, existing object-store artifact writer, existing Postgres additive migration guard, and existing production preflight/canary script structure. No new runtime dependency is planned.
5. Distribution impact stays inside existing packages and existing operator commands. No new package, binary, public route family, dashboard, TUI, managed SaaS surface, or public arbitrary execution adapter ships.

## Architecture

R24 keeps the public API shape boring: local and hosted clients use only `POST /debates`, `GET /debates/:id`, and `GET /debates/:id/events`. Request parsing remains inside the debate service and route family, but the admitted runtime matrix becomes explicit: omitted participant runtime fields still mean `fake.deterministic`; non-fake participants require `realRuntimeOptIn: true`; hosted real participants require `placement: "hosted"`; `judgeConfig` defaults to deterministic; model judge requires both `realRuntimeOptIn: true` and `confirmLiveProviderSpend: true`. The reserved output field `judge` remains rejected on create.

Hosted async execution uses a durable debate execution job store with lease, retry, and next-attempt fields. The job state machine advances one small step per claim: create a participant turn run, wait for that child run to become terminal, route bounded output into a message, advance round/participant state, create a judge run when explicitly requested, parse bounded judge output, write the final report artifact, and mark the debate terminal. This avoids a worker deadlock where one worker blocks waiting for a child run that the same worker must later claim.

```
POST /debates
  -> hosted auth hook for runs:write when control plane is enabled
  -> parse body, reject reserved judge input, validate evidence before side effects
  -> reject real runtime or live judge wait=1 before provider/queue/quota side effects
  -> reserve debate quota, persist debate, attach ownership, audit admission
  -> fake wait=1 executes local no-spend path
  -> async hosted/local path enqueues durable debate job

worker tick
  -> bridge jobs
  -> tool jobs
  -> debate job due claim
  -> run jobs
```

Participant and judge execution never constructs real provider adapters in the hosted server. The debate orchestrator creates normal run records and, for hosted real runtime modes, uses `HostedRunService` admission plus the existing run queue. The hosted worker remains the owner of provider sessions and the R23 bridge. `codex.exec_json` stays one-shot with no input or approval bridge claim; `claude_code.sdk` and `opencode.acp` preserve R23 input/approval bridge readiness and terminalize visibly when approval/input waits outlive the debate deadline.

The deterministic judge is still the default and remains the path for required unit tests, smoke, preflight, and default canary. The internal model judge is not a public route: it is a bounded run created by debate orchestration with `debateRunKind: "judge"`, closed runtime-mode validation, explicit spend confirmation, prompt/output byte limits, and strict parser errors for missing, empty, invalid, or overlarge output.

Hosted persistence becomes first-class before hosted `/debates` is exposed. Postgres stores must cover debate state, routed messages, evidence lookups, debate events, artifacts, and a debate execution outbox. Control-plane ownership must include debate resources and derived run/event/message/artifact resources before inspect/events/artifact reads can disclose existence. Readiness, preflight, and canary fail closed when the enabled hosted debate path lacks auth, ownership, quota, audit, queue/outbox, object-store, worker readiness, provider gates, or R23 bridge dependencies.

## File Structure

- `packages/contracts/src/debate.ts` - additive create-contract and judge-config schemas, participant placement/opt-in fields, runtime-matrix helpers, and reserved input validation.
- `packages/contracts/src/http-error.ts`, `packages/protocol-rest/src/http-errors.ts`, `packages/contracts/src/enterprise.ts`, `packages/contracts/src/endpoint-inventory.ts`, `packages/contracts/src/openapi.ts`, generated OpenAPI JSON, and contract tests - R24 named error codes, quota and ownership vocabulary, hosted `/debates` route inventory, and forbidden route assertions.
- `packages/core/src/ports/debate-execution-store.ts`, `packages/storage/src/postgres/debate-store.ts`, `message-store.ts`, `evidence-store.ts`, `debate-execution-store.ts`, Postgres schema/database files, storage exports, and storage tests - durable hosted debate state, durable routed messages/evidence for inspect/report, and lease-based debate job claims.
- `packages/core/src/services/debate-service.ts` plus focused debate helper files and core tests - closed runtime matrix, staged participant turn execution, runtime output extraction, deterministic and model judge runners, final report metadata, and no-spend default behavior.
- `packages/protocol-rest/src/debate-routes.ts`, `packages/protocol-rest/src/hosted-auth.ts`, and protocol REST tests - existing debate routes gain hosted auth context, ownership-first inspect/events checks, durable job enqueue support, and broader named-error mapping without new routes.
- `apps/server/src/app.ts`, `apps/server/src/readiness.ts`, and server tests - hosted server wires Postgres debate/message/evidence/job stores, DebateService, MessageRouter, ContextBuilder, debate readiness, and route registration.
- `apps/worker/src/worker.ts`, `apps/worker/src/ready.ts`, and worker tests - hosted worker claims and advances debate execution jobs, exposes debate execution readiness, and keeps bridge/tool/run processing order safe.
- `scripts/production-preflight.ts`, `scripts/production-canary.ts`, related tests, and production manifest - no-spend fake hosted debate preflight/canary plus explicit live participant/live judge gates.
- Product, API, development, production, and adapter docs - exact R24 shipped and unshipped boundary.

## Existing Context

`docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md` defines the R24 API contract, runtime matrix, named failure codes, no-spend verification, hosted security posture, and auditor focus.

`PROJECT.md` Phase 22 says R23 shipped hosted input/approval bridges only for worker-owned `claude_code.sdk` and structured `opencode.acp`, and that hosted debate real participants/model judging were still unshipped.

`PRODUCT.md` current snapshot says fake-only remains default, production live probes are opt-in only, `codex.exec_json` is one-shot, `codex.interactive` remains local-only, and hosted debate real participants/model judging are not yet shipped.

`packages/protocol-rest/src/debate-routes.ts` already registers only `POST /debates`, `GET /debates/:id`, and `GET /debates/:id/events`. R24 must keep this route family and extend its dependencies.

`packages/core/src/services/debate-service.ts` currently rejects all non-fake participants in `parseParticipant` and executes a local deterministic fake debate by creating normal fake runs, routing messages, appending debate events, running deterministic judging, and writing a final report.

`packages/core/src/services/hosted-run-service.ts` already enforces hosted explicit placement, real-runtime allowlist, provider activation, wait restrictions for real hosted runs, prompt size, timeout, active-run, runs-per-hour, and spend controls.

`packages/contracts/src/hosted-runtime-bridge.ts`, `apps/server/src/readiness.ts`, and `apps/worker/src/worker.ts` already model R23 bridge readiness for `claude_code.sdk` and `opencode.acp`; R24 must depend on these checks rather than adding new bridge support.

`packages/storage/src/postgres/database.ts` already has `run_events.debate_id` and `artifacts.debate_id`, but no Postgres debate table, routed message table, evidence table, or debate execution outbox.

`packages/contracts/src/openapi.contract.test.ts` already proves hosted OpenAPI does not contain forbidden hosted provider expansion or public judging routes. R24 must keep those assertions while adding hosted `/debates` to the existing route inventory.

## Task Graph

### Task P23-T1-contracts-openapi-boundary

```json
{
  "id": "P23-T1-contracts-openapi-boundary",
  "title": "Define debate contracts and route boundary",
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
  "instructions": "Add R24 debate request contracts without changing existing debate response compatibility. Extend debate create input parsing schemas or helpers to cover participant placement, realRuntimeOptIn, judgeConfig, confirmLiveProviderSpend, and reserved judge input rejection. Add the exact R24 named failure codes to the contracts HTTP schema and protocol REST status map. Use 400 for invalid create bodies and explicit opt-in failures, 409 for unsupported runtime/wait/approval-expiry states, 429 for quota/spend exhaustion, and 503 for store/queue/audit/object-store/worker dependency failures. Extend enterprise schemas with debate resource ownership and debates_per_hour plus active_debates quota kinds, keeping omitted or zero quotas backward compatible. Add hosted `/debates`, `/debates/:id`, and `/debates/:id/events` to hosted OpenAPI by reusing the existing local debate route inventory entries. Keep forbidden-route tests strict for `/debates/participants/real`, `/debates/judge`, `/model-judge`, `/judging`, `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, `/sandbox`, dashboard, and TUI.",
  "acceptance": [
    "CreateDebateRequest accepts fake defaults, opt-in real participant fields, deterministic judgeConfig, and model judgeConfig with explicit spend confirmation.",
    "CreateDebateRequest rejects `judge` as input while debateSchema continues to allow `judge` as output.",
    "All R24 named debate errors parse through httpErrorCodeSchema and have protocol REST status mappings.",
    "Enterprise schemas accept debate resource ownership and additive debate quota kinds without requiring them in existing bootstrap fixtures.",
    "Hosted OpenAPI includes only `POST /debates`, `GET /debates/{id}`, and `GET /debates/{id}/events` for debate behavior.",
    "Hosted and local OpenAPI tests prove no forbidden participant, judge, model-judge, arbitrary execution, dashboard, or TUI route exists."
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
      "failure": "request includes reserved output field `judge`",
      "exception": "ZodError or DebateServiceError invalid_input",
      "rescue": "Reject before debate persistence, quota, queue, run creation, or provider side effects.",
      "user_sees": "400 invalid_input with path `judge` and issue `field is reserved`."
    },
    {
      "codepath": "HTTP error contract",
      "failure": "new service code is missing from contracts or REST status map",
      "exception": "contract test failure",
      "rescue": "Add the exact code to `httpErrorCodeSchema` and `STATUS_BY_CODE` with the status category required by the spec.",
      "user_sees": "Named HTTP error instead of `internal_error`."
    },
    {
      "codepath": "Hosted OpenAPI inventory",
      "failure": "a forbidden route is added or hosted `/debates` is omitted",
      "exception": "OpenAPI contract assertion failure",
      "rescue": "Remove forbidden inventory entries and add only the three existing debate routes.",
      "user_sees": "Hosted OpenAPI exposes the stable `/debates` family only."
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
      "given": "the named failure code list from the spec",
      "expect": "httpErrorCodeSchema parses each code and protocol REST maps each to non-500 status except true internal ownership attach errors"
    },
    {
      "name": "hosted OpenAPI route boundary",
      "lens": "integration",
      "given": "generateOpenApiDocument({ surface: 'hosted_server' })",
      "expect": "contains /debates, /debates/{id}, /debates/{id}/events and excludes all forbidden route families"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "debate create contract additions",
        "kind": "constant",
        "signature": "CreateDebateRequest accepts participant placement/realRuntimeOptIn and judgeConfig; debateSchema remains output-compatible"
      },
      {
        "name": "R24 debate HTTP error codes",
        "kind": "constant",
        "signature": "httpErrorCodeSchema includes debate_* and hosted_debate_* codes from the spec"
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

### Task P23-T2-postgres-debate-durability

```json
{
  "id": "P23-T2-postgres-debate-durability",
  "title": "Add durable Postgres debate stores and job outbox",
  "files": [
    "packages/core/src/ports/debate-execution-store.ts",
    "packages/core/src/ports/control-plane-store.ts",
    "packages/core/src/index.ts",
    "packages/storage/src/postgres/debate-store.ts",
    "packages/storage/src/postgres/message-store.ts",
    "packages/storage/src/postgres/evidence-store.ts",
    "packages/storage/src/postgres/debate-execution-store.ts",
    "packages/storage/src/postgres/database.ts",
    "packages/storage/src/postgres/schema.ts",
    "packages/storage/src/postgres/control-plane-store.ts",
    "packages/storage/src/index.ts",
    "packages/storage/test/postgres-debate-store.test.ts",
    "packages/storage/test/postgres-schema-compat.test.ts",
    "packages/storage/test/storage-package.test.ts"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "packages/core/src/ports/debate-store.ts",
    "packages/storage/src/sqlite/debate-store.ts",
    "packages/storage/src/sqlite/message-store.ts",
    "packages/storage/src/sqlite/evidence-store.ts",
    "packages/storage/src/postgres/database.ts",
    "packages/storage/src/postgres/control-plane-store.ts"
  ],
  "instructions": "Add Postgres durability equivalent to the current SQLite debate path before hosted routes are exposed. Create `PostgresDebateStore` matching `DebateStore` create/get/update/list behavior and preserving optional judge/final report/stop/error fields. Add Postgres routed message and evidence stores sufficient for DebateService inspect, MessageRouter create/get/list, ContextBuilder evidence loading, and final report traceability. Add a `DebateExecutionStore` core port and Postgres implementation with enqueue, claim, release/requeue, complete, fail, recoverStaleClaims, get, and stats operations. The job record must include job id, debate id, stage, round, participant index, pending run id, pending judge run id, state, attempts, maxAttempts, claimedAt, leaseUntil, nextAttemptAt, failure reasonCode, owner ids when available, and timestamps. Update additive Postgres schema SQL and Drizzle schema. Bump `POSTGRES_SCHEMA_VERSION` and keep `assertPostgresMigrationSqlAdditive` passing. Extend control-plane unowned-resource counts to include debates, debate execution jobs, messages, and evidence rows that are visible hosted resources. Export the new stores and port from package indexes.",
  "acceptance": [
    "PostgresDebateStore round-trips all Debate fields currently handled by SqliteDebateStore plus additive R24 fields.",
    "PostgresMessageStore supports create/get/update/list filters needed by MessageRouter and debate inspect.",
    "PostgresEvidenceStore supports create/get/update/list filters needed by evidence validation and ContextBuilder.",
    "DebateExecutionStore claims only due queued jobs, leases claims, requeues recoverable stale claims, exhausts max-attempt stale claims, and records named reason codes.",
    "Postgres schema migration is additive, versioned, and includes indexes for debate id, job state/lease/nextAttemptAt, messages channel, evidence debate id, and ownership scans.",
    "Control-plane unowned-resource readiness can count debate, debate job, message, and evidence ownership gaps.",
    "Storage package exports new Postgres stores and new core port without breaking SQLite tests."
  ],
  "checks": [
    "pnpm --filter @switchyard/storage test -- postgres-debate",
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
      "codepath": "PostgresDebateStore.fromRow",
      "failure": "stored JSON field is malformed",
      "exception": "SyntaxError",
      "rescue": "Throw a store error with reasonCode hosted_debate_store_unavailable and leave row unchanged.",
      "user_sees": "503 hosted_debate_store_unavailable instead of corrupted debate state."
    },
    {
      "codepath": "DebateExecutionStore.claim",
      "failure": "claimed job lease expires before completion",
      "exception": "lease timeout detected by recoverStaleClaims",
      "rescue": "Requeue if attempts remain, otherwise mark exhausted with hosted_debate_worker_unavailable or worker_retry_exhausted reason.",
      "user_sees": "readiness/canary reports hosted_debate_worker_unavailable or debate terminal failure after max attempts."
    },
    {
      "codepath": "control-plane unowned counts",
      "failure": "new debate rows lack ownership",
      "exception": "readiness count > 0",
      "rescue": "Expose unowned_resources_present diagnostics without leaking raw row contents.",
      "user_sees": "GET /ready 503 with low-cardinality unowned resource counts."
    }
  ],
  "observability": {
    "logs": [
      "storage test diagnostics include debate job state and reasonCode on claim failures",
      "readiness diagnostics include counts for unowned debates, debateJobs, messages, and evidence"
    ],
    "success_metric": "Postgres debate/job/message/evidence stores pass parity and stale-claim tests",
    "failure_metric": "hosted_debate_store_unavailable, hosted_debate_queue_unavailable, or unowned_resources_present appears in readiness/preflight"
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
      "given": "Postgres debate, debate job, message, and evidence rows without resource_ownership rows",
      "expect": "countUnownedResources increments the new low-cardinality counters"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "DebateExecutionStore",
        "kind": "class",
        "signature": "interface DebateExecutionStore { enqueue(input) => Promise<DebateExecutionJob>; claim(options?) => Promise<ClaimedDebateExecutionJob | undefined>; release(jobId, update) => Promise<void>; complete(jobId) => Promise<void>; fail(jobId, failure) => Promise<void>; recoverStaleClaims(options?) => Promise<{ recovered:number; exhausted:number; invalid:number }>; stats() => Promise<{ queued:number; claimed:number; failed:number; exhausted:number }> }"
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
      "packages/storage/src/postgres/debate-store.ts",
      "packages/storage/src/postgres/debate-execution-store.ts",
      "packages/storage/src/postgres/message-store.ts",
      "packages/storage/src/postgres/evidence-store.ts"
    ]
  }
}
```

### Task P23-T3-core-debate-runtime-judge

```json
{
  "id": "P23-T3-core-debate-runtime-judge",
  "title": "Extend core debate orchestration and judging",
  "files": [
    "packages/core/src/services/debate-service.ts",
    "packages/core/src/services/debate-runtime-matrix.ts",
    "packages/core/src/services/debate-output.ts",
    "packages/core/src/services/debate-judge-runner.ts",
    "packages/core/test/debate-service.test.ts",
    "packages/core/test/debate-real-runtime.test.ts",
    "packages/core/test/debate-judge-runner.test.ts"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary",
    "P23-T2-postgres-debate-durability"
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
  "instructions": "Replace the fake-only guard with a closed R24 runtime matrix. Preserve existing fake deterministic `wait=1` behavior and final response shape. Add participant normalization for runtime/provider/model/adapterType/runtimeMode/placement/realRuntimeOptIn with fake defaults and exact rejection codes. Add judgeConfig parsing with deterministic default and model judge opt-in plus spend confirmation. Add prompt builders with byte limits for participant turns and judge runs. Add a staged execution API for durable jobs, for example `processExecutionJob(job)`, that advances one step without blocking on child hosted runs. One step may create a participant run, observe a terminal child run, route output, start judging, create a judge run, parse judge output, write report, or complete the debate. Extract participant and judge text only from persisted `runtime.output` events, enforce output byte caps, reject nil/empty/overlarge output with named codes, and never synthesize successful messages. Keep `codex.exec_json` one-shot and reject any debate codepath that assumes post-start input or approval for it. For `claude_code.sdk` and `opencode.acp`, rely on normal run statuses `waiting_for_input` and `waiting_for_approval`; if the debate deadline expires while waiting, terminalize with `debate_runtime_approval_expired`. The deterministic judge remains no-spend and default. The model judge creates a normal run with metadata `debateRunKind: 'judge'`, parses a bounded JSON response into the existing judge object, and rejects invalid/empty/overlarge output with named judge codes. Final report metadata must include debate id, stop reason, participant ids, participant run ids per turn, judge run id when present, evidence ids, message ids, and judge summary.",
  "acceptance": [
    "Existing fake deterministic debate tests still pass and `POST /debates?wait=1` semantics are preserved for no-spend fake debates.",
    "Non-fake participants without `realRuntimeOptIn: true` fail with `debate_real_participant_opt_in_required` before debate, run, message, event, artifact, quota, queue, or provider side effects.",
    "Real participant or live judge requests with `wait=1` fail with `debate_wait_real_runtime_unsupported` before provider side effects.",
    "Allowed local and hosted runtime modes are exactly fake.deterministic, codex.exec_json, claude_code.sdk, and opencode.acp.",
    "Unsupported debate runtime modes fail closed with named unsupported codes and do not enqueue child runs.",
    "Each participant turn creates one normal run with debateId, participantId, participantRole, debateRunKind, debateRound, debatePhase, and bounded prompt metadata.",
    "Participant output is read from persisted runtime.output events, bounded, routed through MessageRouter, and linked to debate events.",
    "Missing, empty, failed, timed-out, waiting-expired, overlarge, or unowned participant output fails visibly with named participant errors and a failure report where possible.",
    "Deterministic judge remains default and requires no provider calls.",
    "Live model judge requires opt-in and spend confirmation, creates a normal run only through the closed matrix, and maps invalid output to named judge errors.",
    "Final report artifact content and metadata include participant run ids and judge run id when present."
  ],
  "checks": [
    "pnpm --filter @switchyard/core test -- debate",
    "pnpm --filter @switchyard/core typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "parseParticipant",
      "failure": "non-fake runtime without realRuntimeOptIn",
      "exception": "DebateServiceError debate_real_participant_opt_in_required",
      "rescue": "Reject before evidence side effects, debate persistence, quota, queue, run creation, or provider dispatch.",
      "user_sees": "400 debate_real_participant_opt_in_required."
    },
    {
      "codepath": "create wait validation",
      "failure": "wait=1 with real participant or model judge",
      "exception": "DebateServiceError debate_wait_real_runtime_unsupported",
      "rescue": "Reject before provider or queue side effects.",
      "user_sees": "409 debate_wait_real_runtime_unsupported."
    },
    {
      "codepath": "participant run terminal observation",
      "failure": "run missing, failed, timeout, cancelled, still waiting past debate deadline, or wrong debate ownership metadata",
      "exception": "DebateServiceError debate_participant_run_missing|debate_participant_run_failed|debate_participant_run_timeout|debate_runtime_approval_expired",
      "rescue": "Mark debate failed, append failure judge summary where possible, write failure report, and stop further turns.",
      "user_sees": "Inspect shows failed debate with named error code and final report when artifact write succeeds."
    },
    {
      "codepath": "extractParticipantOutput",
      "failure": "runtime.output is missing, blank after trim, or exceeds byte cap",
      "exception": "DebateServiceError debate_participant_output_missing|debate_participant_output_empty|debate_participant_output_too_large",
      "rescue": "Do not create a message; fail the debate visibly and write a failure report where possible.",
      "user_sees": "No fabricated participant message; inspect shows named output error."
    },
    {
      "codepath": "model judge parser",
      "failure": "live judge output is missing, empty, invalid JSON, lacks required summary/disagreement fields, or exceeds byte cap",
      "exception": "DebateServiceError debate_judge_output_missing|debate_judge_output_empty|debate_judge_output_invalid|debate_judge_output_too_large",
      "rescue": "Fail judging without storing a misleading successful judge result; write failure report where possible.",
      "user_sees": "Named judge error and failure summary instead of no_consensus success."
    },
    {
      "codepath": "writeFinalReport",
      "failure": "artifact content write fails",
      "exception": "Error from artifactContent.writeText",
      "rescue": "For successful debates fail with hosted_debate_artifact_write_failed; for already failing debates preserve metadata-only failure report if configured.",
      "user_sees": "500/503 named artifact error or failed debate with contentStored false."
    }
  ],
  "observability": {
    "logs": [
      "info debate.create.accepted debateId placementSummary realParticipantCount judgeMode",
      "warn debate.create.denied reasonCode hasRealParticipant hasLiveJudge",
      "info debate.participant.run.created debateId participantId runId runtimeMode placement round phase promptBytes",
      "warn debate.participant.output.rejected debateId runId reasonCode outputBytes",
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
      "name": "missing participant opt-in has no side effects",
      "lens": "error_path",
      "given": "codex.exec_json participant without realRuntimeOptIn",
      "expect": "debate_real_participant_opt_in_required and zero debates/runs/messages/events/artifacts/jobs"
    },
    {
      "name": "real wait fails before provider dispatch",
      "lens": "error_path",
      "given": "claude_code.sdk participant with realRuntimeOptIn true and wait true",
      "expect": "debate_wait_real_runtime_unsupported and no child runs"
    },
    {
      "name": "unsupported runtime matrix fails closed",
      "lens": "edge_unsupported_runtime",
      "given": "codex.interactive, agentfield.async_rest, generic_http.async_rest, cursor, browser, repo, process, or pty runtimeMode",
      "expect": "debate_runtime_unsupported or specific bridge-unshipped code before queue/provider side effects"
    },
    {
      "name": "one normal run per participant turn",
      "lens": "integration",
      "given": "async debate job advanced through one round",
      "expect": "each participant turn has a unique run id and metadata debateRunKind participant_turn with round and phase"
    },
    {
      "name": "participant output errors",
      "lens": "error_path",
      "given": "terminal child run with no runtime.output, blank text, and overlarge text in separate cases",
      "expect": "debate_participant_output_missing, debate_participant_output_empty, and debate_participant_output_too_large respectively"
    },
    {
      "name": "approval wait expires by debate deadline",
      "lens": "error_path",
      "given": "hosted Claude/OpenCode child run remains waiting_for_approval past maxDurationSeconds",
      "expect": "debate_runtime_approval_expired and no additional participant turns"
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
      "name": "live judge fake-provider success",
      "lens": "happy",
      "given": "model judge test double returns bounded JSON with summary, disagreementSummary, consensus, winner none",
      "expect": "judge object parsed, debate.judge.summary appended, final report metadata includes judgeRunId"
    },
    {
      "name": "invalid judge output fails visibly",
      "lens": "error_path",
      "given": "judge run runtime.output is blank, invalid JSON, missing summary, and overlarge in separate cases",
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
        "signature": "processExecutionJob(job: DebateExecutionJob) => Promise<{ action: 'complete' | 'requeue' | 'fail'; reasonCode?: string; nextAttemptAt?: string }>"
      },
      {
        "name": "normalizeDebateRuntime",
        "kind": "function",
        "signature": "normalizeDebateRuntime(participant, index, options) => DebateParticipantRuntimeConfig"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P23-T1-contracts-openapi-boundary",
        "name": "debate create contract additions",
        "signature": "CreateDebateRequest accepts participant placement/realRuntimeOptIn and judgeConfig; debateSchema remains output-compatible"
      },
      {
        "from_task": "P23-T2-postgres-debate-durability",
        "name": "DebateExecutionStore",
        "signature": "interface DebateExecutionStore { enqueue(input) => Promise<DebateExecutionJob>; claim(options?) => Promise<ClaimedDebateExecutionJob | undefined>; release(jobId, update) => Promise<void>; complete(jobId) => Promise<void>; fail(jobId, failure) => Promise<void>; recoverStaleClaims(options?) => Promise<{ recovered:number; exhausted:number; invalid:number }>; stats() => Promise<{ queued:number; claimed:number; failed:number; exhausted:number }> }"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/services/debate-service.ts",
      "packages/core/src/services/debate-runtime-matrix.ts",
      "packages/core/src/services/debate-judge-runner.ts"
    ]
  }
}
```

### Task P23-T4-rest-debate-hosted-boundary

```json
{
  "id": "P23-T4-rest-debate-hosted-boundary",
  "title": "Secure existing debate REST routes for hosted mode",
  "files": [
    "packages/protocol-rest/src/debate-routes.ts",
    "packages/protocol-rest/src/hosted-auth.ts",
    "packages/protocol-rest/test/debate-routes.test.ts",
    "packages/protocol-rest/test/hosted-auth.test.ts"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary",
    "P23-T2-postgres-debate-durability",
    "P23-T3-core-debate-runtime-judge"
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
  "instructions": "Keep the exact public debate route family and add hosted semantics around it. Add hosted auth hook rules for `POST /debates` requiring `runs:write`, and `GET /debates/:id` plus `GET /debates/:id/events` requiring `runs:read`. Extend DebateRouteDependencies with optional controlPlane and debate execution store/enqueue support as needed by Task T3. When controlPlane is present, require hosted auth context before create/inspect/events. For inspect and events, authorize `resourceType: 'debate'` before checking the debate store so tenant mismatch cannot reveal existence. For create, reject ownership override fields such as accountId, tenantId, projectId, userId, apiKeyId at top level or inside participant metadata before service side effects. Pass auth/requestId into DebateService.create. Async hosted create must enqueue through the durable debate job store, not `queueMicrotask`; local/no-job-store behavior may retain existing microtask behavior. Expand sendFromServiceError to map R24 named debate codes to HTTP responses through Task T1 mapping, without falling back to generic internal_error for expected store, queue, participant, judge, quota, auth, and spend states.",
  "acceptance": [
    "No public route path is added beyond the existing three debate routes.",
    "Hosted auth requires runs:write for create and runs:read for inspect/events.",
    "Inspect/events perform ownership authorization before store lookup and return no-leak denial for tenant mismatch.",
    "Hosted async create uses durable debate job enqueue and never local microtask execution.",
    "Fake `wait=1` remains supported and returns 201 with `{ debate, events, finalReportArtifact }`.",
    "Real participant or live judge `wait=1` returns `debate_wait_real_runtime_unsupported` before enqueue/provider side effects.",
    "R24 service errors map to named REST errors, not `internal_error`, except truly unexpected exceptions."
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
      "codepath": "async create enqueue",
      "failure": "durable debate job store unavailable",
      "exception": "DebateExecutionStoreError hosted_debate_queue_unavailable",
      "rescue": "Fail create before provider dispatch and release quota via service admission hooks.",
      "user_sees": "503 hosted_debate_queue_unavailable."
    },
    {
      "codepath": "sendFromServiceError",
      "failure": "expected R24 DebateServiceError not whitelisted",
      "exception": "unhandled service error",
      "rescue": "Map through sendHttpError using Task T1 status map and preserve details.",
      "user_sees": "Named R24 code in standard error envelope."
    }
  ],
  "observability": {
    "logs": [
      "info debate.route.create.accepted routeId debates.create wait hostedAuth present",
      "warn debate.route.denied routeId reasonCode requestId",
      "warn debate.route.tenant_denied routeId debateId reasonCode",
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
      "name": "durable enqueue instead of microtask",
      "lens": "integration",
      "given": "hosted async fake debate create with job store spy",
      "expect": "one job enqueued and DebateService.execute is not called by queueMicrotask"
    },
    {
      "name": "fake wait remains synchronous",
      "lens": "happy",
      "given": "POST /debates?wait=1 fake default participants",
      "expect": "201 response includes debate, events, and finalReportArtifact"
    },
    {
      "name": "real wait rejected in route response",
      "lens": "error_path",
      "given": "POST /debates?wait=1 with opt-in opencode.acp participant",
      "expect": "debate_wait_real_runtime_unsupported and no durable job"
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
        "signature": "registerDebateRoutes(app, deps: DebateRouteDependencies & { controlPlane?: ControlPlaneService; debateJobs?: DebateExecutionStore }) => void"
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
        "from_task": "P23-T2-postgres-debate-durability",
        "name": "DebateExecutionStore",
        "signature": "interface DebateExecutionStore { enqueue(input) => Promise<DebateExecutionJob>; claim(options?) => Promise<ClaimedDebateExecutionJob | undefined>; release(jobId, update) => Promise<void>; complete(jobId) => Promise<void>; fail(jobId, failure) => Promise<void>; recoverStaleClaims(options?) => Promise<{ recovered:number; exhausted:number; invalid:number }>; stats() => Promise<{ queued:number; claimed:number; failed:number; exhausted:number }> }"
      },
      {
        "from_task": "P23-T3-core-debate-runtime-judge",
        "name": "DebateService.create",
        "signature": "create(input: unknown, options?: { wait?: boolean; auth?: AuthContext; requestId?: string }) => Promise<{ debate: Debate; events?: SwitchyardEvent[]; finalReportArtifact?: Artifact | null }>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/protocol-rest/src/debate-routes.ts",
      "packages/protocol-rest/src/hosted-auth.ts"
    ]
  }
}
```

### Task P23-T5-hosted-server-debate-wiring

```json
{
  "id": "P23-T5-hosted-server-debate-wiring",
  "title": "Wire hosted server debate dependencies and readiness",
  "files": [
    "apps/server/src/app.ts",
    "apps/server/src/readiness.ts",
    "apps/server/test/hosted-server.test.ts",
    "apps/server/test/production-readiness.test.ts"
  ],
  "dependencies": [
    "P23-T1-contracts-openapi-boundary",
    "P23-T2-postgres-debate-durability",
    "P23-T3-core-debate-runtime-judge",
    "P23-T4-rest-debate-hosted-boundary"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "apps/server/src/app.ts",
    "apps/server/src/readiness.ts",
    "apps/server/test/hosted-server.test.ts",
    "apps/server/test/production-readiness.test.ts",
    "packages/core/src/services/hosted-run-service.ts",
    "packages/protocol-rest/src/debate-routes.ts"
  ],
  "instructions": "Register existing debate routes in hosted server mode using the stores and services from prior tasks. Instantiate PostgresDebateStore, PostgresMessageStore, PostgresEvidenceStore, PostgresDebateExecutionStore, MessageRouter, ContextBuilder, and DebateService using the same runs/events/artifacts/eventBus/registry/hostedRuns/controlPlane dependencies already present in app.ts. Do not instantiate real provider adapters in the server; keep the server adapter map fake-only. Implement debate admission hooks in app.ts that reserve debates_per_hour and active_debates quotas when configured, attach ownership for debate rows and derived events/messages/artifacts/runs where available, record redacted audit events for admission denial, admission allow, participant dispatch, judge dispatch, terminal success/failure, and denied live spend, and release/finalize debate quota by outcome. Register `registerDebateRoutes` after hosted auth hooks so `request.hostedAuth` is available. Extend `/ready` and `probeServerReadiness` with `hostedDebate` diagnostics for debate store, message store, evidence store, event store, artifact store/content, debate execution outbox, run queue, control-plane ownership, quota, audit, route auth, hosted runtime gate, and R23 bridge readiness when the allowlist includes Claude/OpenCode. Readiness must fail closed with named hosted_debate_* codes when any enabled dependency is missing.",
  "acceptance": [
    "Hosted server registers `POST /debates`, `GET /debates/:id`, and `GET /debates/:id/events` only.",
    "Hosted fake debate create with API key auth persists debate state and enqueues a durable debate job.",
    "Hosted fake `wait=1` remains no-spend and returns completed debate, events, and finalReportArtifact in test mode only when it can execute without provider calls.",
    "Server app never imports or constructs real provider adapters for debate participant or judge execution.",
    "Debate route auth, ownership, quota, audit, and resource attachment are wired through the existing control plane.",
    "Readiness reports hosted debate dependency checks and fails closed when store, queue, auth, quota, audit, object-store, hosted runtime gate, or bridge readiness is unavailable.",
    "Tenant mismatch on inspect/events does not leak debate existence through hosted server tests."
  ],
  "checks": [
    "pnpm --filter @switchyard/server test -- hosted-server",
    "pnpm --filter @switchyard/server test -- production-readiness",
    "pnpm --filter @switchyard/server typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "createServerApp debate store construction",
      "failure": "hosted debate enabled without Postgres debate store in staging/production",
      "exception": "missing postgres handle or store construction failure",
      "rescue": "Expose hosted_debate_store_unavailable in readiness and fail route admission before create.",
      "user_sees": "GET /ready 503 hosted_debate_store_unavailable; POST /debates 503 before provider work."
    },
    {
      "codepath": "debate quota reserve",
      "failure": "debates_per_hour or active_debates exceeded",
      "exception": "ControlPlaneStoreError quota_exceeded",
      "rescue": "Release any partial reservation, record redacted denial audit, and throw hosted_debate_quota_exceeded or quota_exceeded with reason details.",
      "user_sees": "429 hosted_debate_quota_exceeded or quota_exceeded."
    },
    {
      "codepath": "debate ownership attachment",
      "failure": "debate, child run, event, message, artifact, or job ownership cannot be attached",
      "exception": "ownership attach returns not ok or throws",
      "rescue": "Fail admission or terminalize debate with hosted_debate_ownership_attach_failed and record error audit.",
      "user_sees": "Named ownership error with no cross-tenant data disclosure."
    },
    {
      "codepath": "readiness hostedDebate check",
      "failure": "R23 bridge dependencies missing while allowlist includes claude_code.sdk or opencode.acp",
      "exception": "bridge readiness first failure",
      "rescue": "Surface hosted_runtime_bridge_store_unavailable or worker unavailable code in hostedDebate diagnostics.",
      "user_sees": "GET /ready 503 with hostedDebate and hostedRuntimeBridge named codes."
    }
  ],
  "observability": {
    "logs": [
      "info hosted.debate.admission.allowed debateId runtimeModes judgeMode",
      "warn hosted.debate.admission.denied reasonCode runtimeModes judgeMode",
      "info hosted.debate.job.enqueued debateId jobId",
      "warn hosted.debate.ownership.attach_failed resourceType resourceId reasonCode",
      "info readiness.hosted_debate status code"
    ],
    "success_metric": "hostedDebate readiness check ok and hosted fake debate produces durable debate row plus job row",
    "failure_metric": "hostedDebate readiness check fails with hosted_debate_store_unavailable, hosted_debate_queue_unavailable, hosted_debate_audit_unavailable, auth_required, quota_store_unavailable, object_store_unavailable, or hosted_runtime_bridge_store_unavailable"
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
      "expect": "202, durable debate row, owned debate resource, durable debate job"
    },
    {
      "name": "quota denial is audited",
      "lens": "error_path",
      "given": "billing plan with active_debates limit reached",
      "expect": "429 hosted_debate_quota_exceeded and redacted denial audit payload"
    },
    {
      "name": "server source does not import provider adapters for debate",
      "lens": "integration",
      "given": "apps/server/src/app.ts source",
      "expect": "no imports from @switchyard/adapters and only FakeRuntimeAdapter is constructed"
    },
    {
      "name": "readiness missing debate store",
      "lens": "error_path",
      "given": "staging/production readiness without Postgres debate store dependency",
      "expect": "hostedDebate check fails hosted_debate_store_unavailable"
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
        "name": "hosted debate app wiring",
        "kind": "function",
        "signature": "createServerApp(config) registers debate routes with DebateService, Postgres stores, controlPlane, hostedRuns, registry, eventBus, and debateJobs"
      },
      {
        "name": "hostedDebate readiness check",
        "kind": "constant",
        "signature": "probeServerReadiness returns checks.hostedDebate with low-cardinality diagnostics and named codes"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P23-T2-postgres-debate-durability",
        "name": "PostgresDebateStore",
        "signature": "new PostgresDebateStore(handle?: PostgresDatabaseHandle) implements DebateStore"
      },
      {
        "from_task": "P23-T2-postgres-debate-durability",
        "name": "PostgresMessageStore",
        "signature": "new PostgresMessageStore(handle?: PostgresDatabaseHandle) implements MessageStore"
      },
      {
        "from_task": "P23-T2-postgres-debate-durability",
        "name": "PostgresEvidenceStore",
        "signature": "new PostgresEvidenceStore(handle?: PostgresDatabaseHandle) implements EvidenceStore"
      },
      {
        "from_task": "P23-T3-core-debate-runtime-judge",
        "name": "DebateService.create",
        "signature": "create(input: unknown, options?: { wait?: boolean; auth?: AuthContext; requestId?: string }) => Promise<{ debate: Debate; events?: SwitchyardEvent[]; finalReportArtifact?: Artifact | null }>"
      },
      {
        "from_task": "P23-T4-rest-debate-hosted-boundary",
        "name": "registerDebateRoutes",
        "signature": "registerDebateRoutes(app, deps: DebateRouteDependencies & { controlPlane?: ControlPlaneService; debateJobs?: DebateExecutionStore }) => void"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "apps/server/src/app.ts",
      "apps/server/src/readiness.ts"
    ]
  }
}
```

### Task P23-T6-worker-debate-job-execution

```json
{
  "id": "P23-T6-worker-debate-job-execution",
  "title": "Teach hosted worker to advance debate jobs",
  "files": [
    "apps/worker/src/worker.ts",
    "apps/worker/src/ready.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts"
  ],
  "dependencies": [
    "P23-T2-postgres-debate-durability",
    "P23-T3-core-debate-runtime-judge",
    "P23-T5-hosted-server-debate-wiring"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "apps/worker/src/worker.ts",
    "apps/worker/src/ready.ts",
    "apps/worker/src/hosted-runtime-adapters.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts",
    "packages/core/src/services/debate-service.ts"
  ],
  "instructions": "Add debate job processing to the hosted worker without changing provider adapter ownership. Instantiate PostgresDebateStore, PostgresMessageStore, PostgresEvidenceStore, PostgresDebateExecutionStore, MessageRouter, ContextBuilder, and DebateService in worker mode with the worker-owned RuntimeRunnerService and existing run/event/session/artifact stores. Process at most one debate job per tick after hosted runtime bridge and tool jobs, and before ordinary run jobs or after ordinary run jobs only if tests prove no child-run starvation. The selected ordering must prevent a claimed debate job from blocking the same worker from processing child run jobs. On each claim, call DebateService.processExecutionJob, then complete, fail, or release/requeue the job with nextAttemptAt based on the returned action. Recover stale debate claims during claim readiness and mark exhausted claims as terminal debate failures with named hosted_debate_worker_unavailable or worker retry reason. Worker readiness must include debate execution capability when hosted debate is expected: debate job store, claim/release functions, run dispatch, participant output collection, judge runner, artifact writer, object store, and R23 bridge readiness for Claude/OpenCode allowlist modes.",
  "acceptance": [
    "Worker tick can claim and advance a hosted fake debate job without live provider calls.",
    "Worker does not block indefinitely waiting for child hosted run completion; pending child runs are observed in later job advances.",
    "Stale debate job claims are recovered or exhausted with named reason codes.",
    "Worker readiness reports debate capability and fails closed when debate job store, object store, run dispatch, artifact writer, or bridge readiness is missing.",
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
      "failure": "worker crashes after claiming debate job",
      "exception": "expired lease",
      "rescue": "Recover to queued if attempts remain; exhaust and fail debate when attempts are exhausted.",
      "user_sees": "debate eventually retries or terminalizes with hosted_debate_worker_unavailable."
    },
    {
      "codepath": "artifact writer during worker finalization",
      "failure": "object store write fails",
      "exception": "object_store_unavailable|object_store_timeout",
      "rescue": "Fail job and debate with hosted_debate_artifact_write_failed and redacted diagnostics.",
      "user_sees": "failed debate with named artifact code."
    }
  ],
  "observability": {
    "logs": [
      "info worker.debate_job.claimed workerId jobId debateId stage",
      "info worker.debate_job.released workerId jobId debateId nextAttemptAt reasonCode",
      "info worker.debate_job.completed workerId jobId debateId",
      "warn worker.debate_job.failed workerId jobId debateId reasonCode",
      "warn worker.debate_job.recovered recovered exhausted invalid"
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
      "name": "child run terminal output routes message",
      "lens": "integration",
      "given": "pending participant run completed with runtime.output text",
      "expect": "worker advance creates routed message, appends debate.agent.argument or debate.agent.rebuttal, and moves job stage forward"
    },
    {
      "name": "stale debate claim recovered",
      "lens": "error_path",
      "given": "claimed debate job with expired lease and attempts remaining",
      "expect": "claim readiness recovery requeues it"
    },
    {
      "name": "stale debate claim exhausted",
      "lens": "error_path",
      "given": "claimed debate job with expired lease at max attempts",
      "expect": "job exhausted and debate failed with hosted_debate_worker_unavailable"
    },
    {
      "name": "worker readiness debate store missing",
      "lens": "error_path",
      "given": "hosted debate expected but debate execution store dependency absent",
      "expect": "readiness not ok with hosted_debate_queue_unavailable"
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
        "from_task": "P23-T2-postgres-debate-durability",
        "name": "DebateExecutionStore",
        "signature": "interface DebateExecutionStore { enqueue(input) => Promise<DebateExecutionJob>; claim(options?) => Promise<ClaimedDebateExecutionJob | undefined>; release(jobId, update) => Promise<void>; complete(jobId) => Promise<void>; fail(jobId, failure) => Promise<void>; recoverStaleClaims(options?) => Promise<{ recovered:number; exhausted:number; invalid:number }>; stats() => Promise<{ queued:number; claimed:number; failed:number; exhausted:number }> }"
      },
      {
        "from_task": "P23-T3-core-debate-runtime-judge",
        "name": "DebateService.processExecutionJob",
        "signature": "processExecutionJob(job: DebateExecutionJob) => Promise<{ action: 'complete' | 'requeue' | 'fail'; reasonCode?: string; nextAttemptAt?: string }>"
      },
      {
        "from_task": "P23-T5-hosted-server-debate-wiring",
        "name": "hostedDebate readiness check",
        "signature": "probeServerReadiness returns checks.hostedDebate with low-cardinality diagnostics and named codes"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "apps/worker/src/worker.ts",
      "apps/worker/src/ready.ts"
    ]
  }
}
```

### Task P23-T7-preflight-canary-no-spend

```json
{
  "id": "P23-T7-preflight-canary-no-spend",
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
    "P23-T4-rest-debate-hosted-boundary",
    "P23-T5-hosted-server-debate-wiring",
    "P23-T6-worker-debate-job-execution"
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
  "instructions": "Extend production preflight and canary without adding live spend to defaults. Preflight must include hosted debate dependency checks for auth, Postgres schema, debate store, message/evidence stores, event store, artifact store/content, debate execution outbox, run queue, object store, ownership, quota, audit, worker readiness, provider activation gates, and R23 bridge readiness when Claude/OpenCode are allowlisted. Default canary must create a fake hosted debate through `/debates`, poll inspect/events until terminal or timeout, verify participant run ids, event ids, message ids, judge, stop reason, final report artifact metadata, metrics, and audit evidence, and make no provider calls. Add allowed canary paths for `/debates`, `/debates/:id`, and `/debates/:id/events`. Add optional live participant and live judge flags such as `--live-debate-runtimes`, `--live-debate-judge`, and `--confirm-live-provider-spend`. If a live debate flag is supplied without spend confirmation, fail fast with `debate_live_canary_spend_unconfirmed` before any network request that can create provider work. Keep existing live external tool and provider bridge flags intact.",
  "acceptance": [
    "Production preflight passes the fake/no-spend hosted debate posture when all dependencies are ready.",
    "Production preflight fails closed with named hosted_debate_* or existing dependency codes when debate store, queue, auth, quota, audit, object store, worker readiness, provider activation, or bridge readiness is missing.",
    "Default production canary runs fake hosted debate only and records live participant/live judge checks as skipped.",
    "Default canary verifies debate inspect/events/artifact/audit traceability and makes no live provider calls.",
    "Live participant canary requires an explicit live flag and spend confirmation.",
    "Live judge canary requires an explicit live flag and spend confirmation.",
    "Supplying a live debate flag without spend confirmation fails with `debate_live_canary_spend_unconfirmed` before provider dispatch."
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
        "from_task": "P23-T4-rest-debate-hosted-boundary",
        "name": "hosted debate auth rules",
        "signature": "POST /debates -> runs:write; GET /debates/:id and /debates/:id/events -> runs:read"
      },
      {
        "from_task": "P23-T5-hosted-server-debate-wiring",
        "name": "hostedDebate readiness check",
        "signature": "probeServerReadiness returns checks.hostedDebate with low-cardinality diagnostics and named codes"
      },
      {
        "from_task": "P23-T6-worker-debate-job-execution",
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

### Task P23-T8-product-docs-truth

```json
{
  "id": "P23-T8-product-docs-truth",
  "title": "Update product and operator truth",
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
    "P23-T2-postgres-debate-durability",
    "P23-T3-core-debate-runtime-judge",
    "P23-T4-rest-debate-hosted-boundary",
    "P23-T5-hosted-server-debate-wiring",
    "P23-T6-worker-debate-job-execution",
    "P23-T7-preflight-canary-no-spend"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md",
    "PRODUCT.md",
    "PROJECT.md",
    "README.md",
    "docs/development/API.md",
    "docs/development/DEVELOPMENT.md",
    "deploy/production/README.md"
  ],
  "instructions": "Update product truth after implementation without overclaiming. State that R24 ships hosted/server-safe debate through the existing `/debates` route family, fake deterministic hosted debate as the default no-spend path, opt-in local/hosted debate participant runs for fake.deterministic, codex.exec_json, claude_code.sdk, and opencode.acp, and an internal bounded judge runner with deterministic default and live model judge only behind request opt-in and spend confirmation. State that debate participant and judge execution use existing run/runtime contracts and preserve run/message/event/artifact traceability. State hosted debate requires durable Postgres debate/message/evidence/job state, ownership, quota, audit, queue/outbox, object store, worker readiness, provider activation, and R23 bridge readiness where applicable. Explicitly say codex.exec_json remains one-shot, hosted codex.interactive remains unshipped, AgentField/Generic HTTP hosted debate bridges remain unshipped, public model judge routes remain unshipped, browser automation remains unshipped, hosted repo remains unshipped, generic process/PTy adapters remain unshipped, dashboard/TUI remain unshipped, and managed SaaS/billing/OAuth remain unshipped. Document production preflight and canary commands, no-spend default, and live debate spend confirmation gates.",
  "acceptance": [
    "PRODUCT.md current snapshot reflects R24 shipped and unshipped boundary.",
    "README and development API docs list only existing debate routes and no public model judge route.",
    "Development docs describe fake default, real participant opt-in, live judge opt-in, wait=1 fake-only support, and named failure codes.",
    "Production docs document hosted debate readiness/preflight/canary dependencies and live spend confirmation flags.",
    "Adapter docs state codex.exec_json one-shot, Claude/OpenCode R23 bridge dependency, and AgentField/Generic HTTP hosted debate bridge unshipped status.",
    "Docs do not claim dashboard, TUI, public arbitrary execution routes, PTY/terminal automation, browser automation, hosted repo, generic process/PTY adapters, public model judging, managed SaaS, billing, OAuth, SSO, SCIM, or hosted Codex interactive."
  ],
  "checks": [
    "rg -n \"model-judge|/debates/judge|/judging|hosted Codex interactive|dashboard|TUI|generic process|PTY|managed SaaS\" PRODUCT.md README.md docs/development/API.md docs/development/DEVELOPMENT.md docs/adapters deploy/production/README.md",
    "pnpm --filter @switchyard/contracts openapi:check:hosted",
    "git diff --check"
  ],
  "error_rescue_map": [],
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
        "from_task": "P23-T7-preflight-canary-no-spend",
        "name": "runProductionCanary",
        "signature": "runProductionCanary(options: ProductionCanaryOptions & { liveDebateRuntimes?: boolean; liveDebateJudge?: boolean; confirmLiveProviderSpend?: boolean }) => Promise<ProductionCanaryResult>"
      }
    ],
    "file_paths_consumed_by_other_tasks": []
  }
}
```

## Integration Points

The contract task lands the shared request, error, ownership, quota, and OpenAPI vocabulary first. The storage task then provides durable Postgres debate state and job claims. Core debate orchestration imports those contracts and job records to normalize inputs and advance debate jobs. REST routes use the updated DebateService and durable job store while enforcing hosted auth and ownership. Hosted server wiring composes stores, service, control plane hooks, and readiness. Hosted worker wiring processes the same durable jobs. Ops scripts call the hosted `/debates` routes and readiness outputs. Docs land last so product truth describes the implemented shape.

Cross-task contract walk:

- T3 imports T1 debate request and error vocabulary, and T2 DebateExecutionStore.
- T4 imports T1 REST error mapping, T2 DebateExecutionStore, and T3 DebateService.
- T5 imports T2 Postgres stores, T3 DebateService, and T4 registerDebateRoutes/auth rules.
- T6 imports T2 DebateExecutionStore and T3 DebateService.processExecutionJob.
- T7 imports the route/readiness behavior from T4/T5/T6 through HTTP and readiness contracts.
- T8 imports T7 operator command behavior for documentation.

No two tasks own the same file.

## Architect Review Focus

1. Staged async debate job state machine: verify the plan cannot deadlock a single worker by claiming a debate job and then blocking on a child run that needs the same worker.
2. Hosted tenant boundary: verify inspect/events authorize `resourceType: "debate"` before debate store lookup and derived message/event/artifact/run ownership is attached before disclosure.
3. Provider-spend boundary: verify missing participant opt-in, live judge spend confirmation, provider activation, quota, and bridge readiness all fail before provider dispatch.
4. Route surface boundary: verify hosted OpenAPI gains only the existing `/debates` family and no judging, participant, model, terminal, PTY, sandbox, shell, process, dashboard, or TUI route.
5. Durable state boundary: verify hosted debate does not rely on server-local memory, SQLite-only stores, or microtasks.
6. R23 bridge interaction: verify Claude/OpenCode debate runs rely on existing bridge readiness and do not create new public bridge behavior.
7. No-spend default: verify required tests, smoke, preflight, and default canary cannot accidentally execute live provider paths.

## Known High-Risk Seams

- The existing debate service is synchronous fake-only; converting it to staged async execution must preserve fake `wait=1` behavior while avoiding long hosted waits.
- Postgres currently has debate-aware events/artifacts but no durable debate/message/evidence/job stores. Store parity and schema migrations are high blast-radius.
- Hosted run creation can enqueue child run jobs. Debate job processing must requeue and observe child run terminal state rather than blocking.
- Ownership must be attached for resources created outside normal run routes, especially debate rows, debate jobs, routed messages, run events, artifacts, and judge runs.
- Model judge parsing can easily overclaim success. Empty, invalid, missing, and overlarge judge output must be terminal named failures.
- OpenAPI and docs may overstate the hosted bridge and model judging surface. Forbidden route/source tests and documentation grep are required.

## Phase-Level Acceptance Criteria

- [ ] Hosted/server exposes debate create/inspect/events only through the existing `/debates` route family; no new participant, judge, model-judge, terminal, PTY, sandbox, process, shell, dashboard, or TUI route is added.
- [ ] Hosted/server registers existing debate routes with API-key auth, ownership-first access checks, quota, audit, durable Postgres debate state, and no cross-tenant resource leakage.
- [ ] `POST /debates?wait=1` remains supported for fake deterministic no-spend debates and rejects real participant or live judge requests with `debate_wait_real_runtime_unsupported` before provider side effects.
- [ ] Fake deterministic participants and deterministic judge remain the default and power all required tests, smoke, preflight, and default canary.
- [ ] Real participant runtimes require explicit request opt-in and pass the exact shipped runtime matrix; omitted opt-in fails with `debate_real_participant_opt_in_required`.
- [ ] Local and hosted participant turns for `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` use normal run lifecycle records with debate/participant metadata and bounded prompts.
- [ ] Hosted real participant turns use existing `HostedRunService`, provider activation, provider spend controls, run queue, worker execution, and R23 bridge readiness. The server never constructs provider adapters.
- [ ] `codex.exec_json` participant turns remain one-shot and never claim post-start input, approval bridge, or session resume.
- [ ] `claude_code.sdk` and `opencode.acp` participant turns preserve existing hosted input/approval bridge behavior and terminalize visibly if approval/input waits exceed debate limits.
- [ ] `codex.interactive`, AgentField, Generic HTTP, Cursor, OpenClaw, Paperclip, browser, repo, generic process, and PTY debate runtime paths fail closed with named unsupported codes.
- [ ] Participant runtime output is read from persisted run events, bounded, redacted where needed, converted to durable messages through `MessageRouter`, and linked to debate events.
- [ ] Nil, empty, failed, timed-out, waiting-expired, overlarge, or unowned participant run output fails visibly with named participant errors and a failure report where possible.
- [ ] Internal judge runner supports deterministic fake default and opt-in live model judging through existing run/runtime contracts only.
- [ ] Live judge requires request-level opt-in, spend confirmation, provider activation, run quota, timeout, output bounds, and canary opt-in. Missing confirmation fails with `debate_judge_live_spend_unconfirmed`.
- [ ] Judge output is parsed into the existing `judge` object, with invalid/empty/overlarge output mapped to named judge errors.
- [ ] Final report artifacts include debate id, stop reason, participant ids, participant run ids, judge run id when present, evidence ids, message ids, and judge summary.
- [ ] Debate event replay/live streaming remains debate-scoped and ordered by persisted event sequence, including participant turn, judge summary, consensus, and artifact-created events.
- [ ] Hosted debate readiness, preflight, canary, metrics, logs, audit, docs, OpenAPI, and product truth match the exact shipped/unshipped boundary.
- [ ] Default test/smoke/preflight/canary paths perform no live provider calls and have assertions proving live paths are skipped unless explicitly confirmed.

## Verification Strategy

Task-level checks are mandatory before GREEN for each implementer. Phase audit should run this command set from the phase branch after task merges:

```bash
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/contracts openapi:check
pnpm --filter @switchyard/contracts openapi:check:hosted
pnpm --filter @switchyard/storage test -- postgres-debate
pnpm --filter @switchyard/storage test -- postgres-schema-compat
pnpm --filter @switchyard/core test -- debate
pnpm --filter @switchyard/protocol-rest test -- debate-routes
pnpm --filter @switchyard/server test -- hosted-server
pnpm --filter @switchyard/server test -- production-readiness
pnpm --filter @switchyard/worker test -- hosted-worker
pnpm --filter @switchyard/worker test -- production-worker-readiness
pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts deploy/production/production-manifest.test.ts
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

Auditor should also run source/route greps:

```bash
rg -n "/debates/participants/real|/debates/judge|/model-judge|/judging|/exec|/shell|/process|/command|/pty|/terminal|/sandbox" packages apps scripts docs PRODUCT.md README.md
rg -n "@switchyard/adapters|ClaudeCode|OpenCode|CodexExec|provider adapter" apps/server/src packages/protocol-rest/src
rg -n "confirmLiveProviderSpend|debate_live_canary_spend_unconfirmed|debate_live_canary_skipped_default" scripts apps packages
```

## Self-Review

1. Spec coverage: all Phase 23 acceptance criteria map to T1 through T8 and the phase-level acceptance checklist.
2. Placeholder scan: no placeholder markers are intentionally present in this plan.
3. Type consistency: cross-task imports reference exported contracts with matching signatures.
4. Ownership disjoint: each listed file is owned by exactly one task.
5. Context files real: every context file listed is an existing path in this worktree.
6. Acceptance testable: every acceptance item is phrased as observable behavior or an exact command result.
7. Dependency order sane: contracts precede storage/core; storage/core precede REST/server/worker; ops/docs come last.
8. Checks runnable: commands use existing package scripts and vitest invocation style from the repo.
9. Error/rescue maps present: all runtime tasks have named error/rescue rows; the docs-only task has an empty map by design.
10. Observability present: every runtime task has low-cardinality log and metric expectations.
11. Test cases enumerate acceptance and shadow paths: nil, empty, unsupported, denied, stale, timeout, missing, overlarge, invalid, and integration paths are explicit.
12. Integration contracts walk: every import from another task resolves to an export in an upstream task.
13. Contract types match: DebateService, DebateExecutionStore, registerDebateRoutes, readiness, preflight, and canary signatures are consistent across tasks.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error_rescue_map entry has a matching error_path, happy_shadow, edge, or integration test case.
- [x] Every integration_contracts.imports_from_other_tasks resolves to a real export elsewhere in this plan.
- [x] Every context_files path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is intentionally present.
- [x] Complexity is L; the phase is not split because the product outcome needs one integrated hosted debate vertical, and the task graph isolates ownership across eight slices.
