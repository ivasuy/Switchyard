# Audit Log: P9-T1-hosted-hybrid-execution

Date: 2026-05-30
Iteration: 1
Verdict: NEEDS_REVISION

## Scope

- Phase 9 / R10 Hosted And Hybrid Execution
- Worktree: `/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/native-roadmap-20260529/phase-9-r10-hosted-and-hybrid-execution`
- Head: `610a7032d8973b900f37ccf730e06a6b3c34c779`
- Spec: `docs/superpowers/specs/2026-05-30-phase-9-r10-hosted-and-hybrid-execution.md`
- Plan: `docs/superpowers/plans/2026-05-30-phase-9-r10-hosted-and-hybrid-execution.md`

## Checks Run

- `git status --short`
- `git diff --check`
- `pnpm typecheck`
- `pnpm test`
- Direct repro: hosted enqueue failure after run creation
- Direct repro: event sync against a `pending` assignment
- Direct repro: `loadServerConfig(...)` with Postgres/Redis/object-store env vars

## Findings

### 1. Hosted enqueue failure leaves a queued hosted run and placement record behind after returning `queue_unavailable`

- Severity: high
- Files:
  - `packages/core/src/services/hosted-run-service.ts`
- Evidence:
  - `HostedRunService.createRun()` creates the run and placement record before enqueue, then converts any enqueue error into `queue_unavailable` without terminalizing or rolling back the run/placement (`lines 71-90`).
  - Repro result:
    - error: `queue_unavailable enqueue_failed`
    - durable state afterward: one hosted `queued` run, one `run.queued` event, one placement record.
- Why this blocks:
  - The plan requires `queue unavailable before create -> 503 queue_unavailable and no run row` and `queue enqueue failure after create -> run.failed with queue_enqueue_failed and no orphan pending job`.
  - Current behavior returns a queue error while leaving an inspectable-but-nonterminal orphaned hosted run that will never execute.
- Required change:
  - Distinguish pre-create queue unavailability from post-create enqueue failure.
  - If failure happens after run creation, mark the run terminal with a named failure event/reason and leave durable state consistent with the public contract.

### 2. Event sync accepts and persists events for assignments that are still `pending`

- Severity: high
- Files:
  - `packages/core/src/services/event-sync-service.ts`
- Evidence:
  - `appendBatch()` validates only node ownership and cursor equality before appending events (`lines 24-79`).
  - There is no assignment-state guard for `claimed` / `running`.
  - Repro result:
    - a `pending` assignment accepted `runtime.output` event sequence `1`
    - event was appended
    - assignment cursor advanced to `1`
    - assignment status remained `pending`
- Why this blocks:
  - The spec/plan explicitly require assignment-state validation for sync and the connected-node authoritative run payload boundary.
  - Accepting events before a successful claim breaks durable claim semantics and allows a node to mutate hosted run history without ever owning the assignment.
- Required change:
  - Reject sync for assignments not in an allowed in-flight state.
  - Add regression coverage for `pending`, terminal, and wrong-owner sync attempts.

### 3. The shipped hosted/server/worker/storage/queue path does not implement the claimed opt-in Postgres, Redis/BullMQ, and object-store integrations

- Severity: high
- Files:
  - `apps/server/src/config.ts`
  - `apps/server/src/app.ts`
  - `apps/worker/src/worker.ts`
  - `packages/queue/src/bullmq-run-queue.ts`
  - `packages/storage/src/postgres/node-store.ts`
  - `packages/storage/src/postgres/assignment-store.ts`
  - `packages/storage/test/postgres-storage.test.ts`
- Evidence:
  - `loadServerConfig()` only reads host/port/node token/allowlist and ignores all Postgres, Redis, and object-store env vars (`apps/server/src/config.ts:1-23`).
  - `createServerApp()` hardcodes `InMemoryRunStore`, `InMemoryEventStore`, `InMemorySessionStore`, `InMemoryArtifactStore`, `InMemoryRegistryStore`, `MemoryRunQueue`, a stub placement store, and `MemoryArtifactContentStore` (`apps/server/src/app.ts:42-52`, `88-114`, `128-150`).
  - `createHostedWorker()` is typed around `MemoryRunQueue`, `InMemoryRunStore`, `InMemoryEventStore`, and `MemoryArtifactContentStore` only (`apps/worker/src/worker.ts:18-52`).
  - `BullMqRunQueue` ignores `redisUrl` and delegates every method to `MemoryRunQueue` (`packages/queue/src/bullmq-run-queue.ts:9-45`).
  - The `Postgres*Store` implementations shown are in-memory `Map` shims, not Postgres-backed persistence (`packages/storage/src/postgres/node-store.ts:4-40`, `packages/storage/src/postgres/assignment-store.ts:4-70`).
  - The Postgres test explicitly describes these as "Postgres-shaped stores through in-memory deterministic behavior" (`packages/storage/test/postgres-storage.test.ts:14-24`).
- Why this blocks:
  - The phase acceptance requires hosted server/worker, Postgres storage, Redis/BullMQ queue, and object artifact store to be implemented to the R10 boundary with deterministic substitutes for tests, not to replace the production-shaped implementations entirely.
  - The current product/docs truth says this is fake-first, but the task contract still requires real opt-in wiring to exist when configured.
- Required change:
  - Add real config parsing and dependency wiring for Postgres/Redis/object-store paths.
  - Keep the deterministic substitutes for default tests, but do not ship the production-shaped classes as memory-only stand-ins.

## Required Changes Summary

- Fix hosted enqueue failure semantics so no orphan queued hosted runs remain after a queue error.
- Enforce assignment-state validation in event sync before accepting any batch.
- Replace the current fake-only server/worker/storage/queue wiring with real opt-in Postgres/Redis/object-store implementations plus deterministic substitutes.
