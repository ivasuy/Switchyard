# Phase 9 Audit Report

Date: 2026-05-30
Phase: 9 / R10 Hosted And Hybrid Execution
Iteration: 1
Verdict: NEEDS_REVISION

## Summary

The worktree is committed clean and the automated suite passes, but the shipped implementation does not meet the R10 acceptance boundary in three blocking areas:

1. Hosted enqueue failure leaves orphaned hosted runs after returning `queue_unavailable`.
2. Event sync accepts events for assignments that were never successfully claimed.
3. The hosted/server/worker/storage/queue stack is still fake-only in several places where the plan/spec require opt-in real Postgres/Redis/object-store wiring.

## Checks

- `git status --short` -> clean
- `git diff --check` -> clean
- `pnpm typecheck` -> passed
- `pnpm test` -> passed
- Root repo current branch check:
  - root branch: `codex/product-truth-cleanup`
  - root HEAD: `94b6f32788ec18d1e13a12723deeb6226df243c6`
  - no merge into the root/current branch was performed during this audit

## Blocking Findings

### 1. Hosted queue failure handling violates the run contract

- Ref: `packages/core/src/services/hosted-run-service.ts:71-90`
- The code creates a hosted run and placement record before enqueue, then throws `queue_unavailable` on enqueue failure without terminalizing the run.
- Direct repro showed a persisted hosted `queued` run plus placement record after the error.

### 2. Event sync bypasses durable claim-state validation

- Ref: `packages/core/src/services/event-sync-service.ts:24-79`
- The service accepts and appends events for `pending` assignments because it does not require `claimed` / `running` state before sync.
- Direct repro showed a `pending` assignment advancing its cursor and storing a `runtime.output` event.

### 3. Real opt-in hosted infra wiring is not implemented

- Refs:
  - `apps/server/src/config.ts:1-23`
  - `apps/server/src/app.ts:42-52`
  - `apps/server/src/app.ts:88-150`
  - `apps/worker/src/worker.ts:18-52`
  - `packages/queue/src/bullmq-run-queue.ts:9-45`
  - `packages/storage/src/postgres/node-store.ts:4-40`
  - `packages/storage/src/postgres/assignment-store.ts:4-70`
  - `packages/storage/test/postgres-storage.test.ts:14-24`
- The shipped "Postgres" stores and "BullMQ" queue are still in-memory shims, and the hosted app config does not consume Postgres/Redis/object-store env vars.
- This fails the task acceptance for real opt-in production-shaped integrations with deterministic substitutes.

## Per-Task Log

- `agent-runs/native-roadmap-20260529/audit/P9-T1-hosted-hybrid-execution.md`
