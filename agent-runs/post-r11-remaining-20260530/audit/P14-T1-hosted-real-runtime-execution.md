# Phase 14 / R15 Audit Log

**Date:** 2026-05-31
**Phase:** 14
**Task:** `P14-T1-hosted-real-runtime-execution`
**Branch:** `agent/phase-14-r15-hosted-real-runtime-execution`
**Latest Verdict:** `GREEN`

## Pass 1 Summary

- Audit pass: `1`
- Verdict: `NEEDS_REVISION`
- Blocking redflag: prepared hosted-run metadata persistence was not actually conditional, so a concurrent durable-row mutation could still be overwritten before `startRun()`.

Required fix from pass 1:

1. add a real compare-and-update path in the run stores used by hosted worker execution;
2. make `HostedWorkerService.persistPreparedRun()` use that guarded result directly; and
3. add regression coverage proving stale concurrent mutation fails with `hosted_run_state_invalid` and no adapter start.

## Pass 2 Re-Audit

- Audit pass: `2`
- Verdict: `GREEN`
- Re-audit scope: verify the single pass-1 redflag only
- Commits verified since pass 1:
  - `9698b52 fix(hosted): guard prepared hosted run updates`

### Redflag Closure

- `packages/core/src/services/hosted-worker-service.ts` now routes prepared metadata persistence through `runs.updatePreparedMetadataIfMatch(...)` and aborts with `hosted_run_state_invalid` when the guarded write misses. `startRun()` is reached only after the guarded update succeeds.
- `packages/storage/src/postgres/run-store.ts` now performs the prepared metadata write with a single `UPDATE ... WHERE ... RETURNING *` statement keyed on the required execution identity fields (`id`, `status`, `placement`, `runtime`, `runtimeMode`, `provider`, `adapterType`).
- `packages/storage/src/sqlite/run-store.ts` now performs the same guarded metadata update with identity predicates in the `WHERE` clause and returns `identity_mismatch` when the durable row changed.
- `packages/core/test/hosted-worker-service.test.ts` now covers the exact concurrent-mutation regression: mutating the durable row to `cancelled` immediately before the guarded metadata update leaves `startRun()` at `0`, marks the run failed, and emits `hosted_run_state_invalid`.
- `packages/storage/test/postgres-storage.test.ts` and `packages/storage/test/sqlite-storage.test.ts` both exercise the guarded metadata update helper and verify that mismatched execution identity leaves the previously persisted metadata unchanged.

The prior blocker is closed.

### Checks Run

- `git diff --check`
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/server test`
- `pnpm --filter @switchyard/worker test`
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm hosted-real-runtime:smoke`
- `pnpm typecheck`

All required checks passed on pass 2.

### Probe Summary

- Guarded metadata update now fails closed on concurrent mutation before adapter start.
- Closed hosted catalog remains exactly `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
- Production real hosted runtime enablement is still rejected by config validation and worker readiness/policy checks.
- Server execution remains fake-only for direct provider execution, and hosted real `?wait=1` is rejected before run creation/queue side effects.
- Worker adapter construction remains limited to fake plus allowlisted Codex/Claude/OpenCode adapters; disallowed generic/browser/search/fetch/GitHub/repo/shell/process/PTY execution surfaces were not added.
- Route/OpenAPI guards still leave `/sandbox`, `/exec`, `/pty`, and `/terminal` absent.
- Hosted-safe logging still redacts provider output plus signed URL/object key variants.
- Product and API docs still state the self-hosted/staging-only, no-public-execution-API boundary explicitly.

## Deferred Concerns

- None.
