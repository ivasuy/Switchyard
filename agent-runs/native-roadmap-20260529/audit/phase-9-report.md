# Phase 9 Audit Report

Date: 2026-05-30
Phase: 9 / R10 Hosted And Hybrid Execution
Iteration: 2
Verdict: NEEDS_REVISION
Revision audited: `f3f97df77e5c9fa53960f4bc1063f9f3a9010805`

## Summary

Pass 2 closes two of the three prior blockers:

1. Hosted enqueue failure now correctly terminalizes the durable run with `run.failed` / `queue_enqueue_failed`.
2. Event sync now rejects `pending` / terminal assignments and wrong-owner or stale-cursor attempts.

The remaining blocker is narrowed to product truth in `ARCHITECTURE.md`: older hosted-storage sections still describe shipped R10 as `S3/R2`-backed, while the implementation and updated shipped-slice docs now correctly scope R10 to filesystem-backed object-compatible storage with S3/R2 network wiring explicitly not shipped.

## Checks

- `git status --short` -> clean
- `git diff --check` -> clean
- `pnpm --filter @switchyard/core test` -> passed
- `pnpm --filter @switchyard/queue test` -> passed
- `pnpm --filter @switchyard/storage test` -> passed
- `pnpm --filter @switchyard/server test` -> passed
- `pnpm --filter @switchyard/worker test` -> passed
- `pnpm test` -> passed
- Direct repro: hosted enqueue failure -> passed
- Direct repro: event sync on pending assignment -> passed

## Remaining Blocking Finding

### 3. `ARCHITECTURE.md` still overclaims shipped hosted storage as `S3/R2`

- Resolved portions:
  - real opt-in env parsing and wiring now exist in `apps/server` and `apps/worker`
  - BullMQ/Redis queue path is no longer a memory-only shim
  - Postgres stores use real `pg` handles when configured
  - product/dev/changelog sections inspected for R10 shipped truth are aligned with filesystem-backed object-compatible storage
- Remaining conflicting refs:
  - `ARCHITECTURE.md:130-153`
  - `ARCHITECTURE.md:691-709`
  - `ARCHITECTURE.md:788-812`
  - `ARCHITECTURE.md:878-880`
- Correct shipped-slice ref already present:
  - `ARCHITECTURE.md:948-964`

## Per-Task Log

- `agent-runs/native-roadmap-20260529/audit/P9-T1-hosted-hybrid-execution.md`
