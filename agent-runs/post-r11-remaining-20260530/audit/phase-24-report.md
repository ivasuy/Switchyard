# Phase 24 Audit: R25 Hosted Wrapper Runtime Bridges

**Status:** GREEN
**Branch audited:** `agent/phase-24-r25-hosted-wrapper-bridges`
**Worktree audited:** `.worktrees/post-r11-remaining-20260530/phase-24-r25-hosted-wrapper-bridges`
**Spec:** `docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md`
**Plan:** `docs/superpowers/plans/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md`

## Summary

Phase 24 can close. The branch conditionally widens hosted runtime bridge support to `agentfield.async_rest` and `generic_http.async_rest` while preserving the public route boundary: hosted wrapper input uses `POST /runs/:id/input`, runtime approvals use approval list/get/approve/reject, and hosted debate remains under the existing `/debates` route family.

The audit found the expected closed contracts, wrapper provider policy/catalog gates, adapter capability discovery, approval request normalization, approval resolution dispatch, durable bridge command/payload semantics, server/worker readiness checks, hosted debate admission gates, no-spend production preflight/canary defaults, and current product/docs truth. Hosted OpenAPI proves `POST /approvals` is absent while the existing approval list/get/approve/reject routes remain present.

## Checks Run

- `pnpm --filter @switchyard/contracts test -- contracts openapi endpoint-inventory` -> 6 files, 112 tests passed.
- `pnpm --filter @switchyard/core test -- hosted-runtime-bridge-service debate-real-runtime debate-service runtime-approval-session-r16` -> 25 files, 278 tests passed.
- `pnpm --filter @switchyard/adapters test -- generic-http agentfield` -> 16 files, 164 tests passed.
- `pnpm --filter @switchyard/protocol-rest test -- input-route approval debate-routes hosted-tool-routes run-routes` -> 10 files, 109 tests passed.
- `pnpm --filter @switchyard/server test -- production-readiness hosted-server hosted-tools production-config` -> 4 files, 88 tests passed.
- `pnpm --filter @switchyard/worker test -- production-worker-readiness hosted-worker production-config` -> 4 files, 62 tests passed.
- `pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts` -> 2 files, 66 tests passed.
- `pnpm typecheck` -> 16/16 packages successful.
- `git diff --check` -> clean.
- Hosted OpenAPI focused route probe -> `POST /approvals` absent; `POST /runs/{id}/input`, `GET /approvals`, `GET /approvals/{id}`, `POST /approvals/{id}/approve`, and `POST /approvals/{id}/reject` present.

## Redflags

None.

## Deferred Concerns

None.

## Non-Blocking Observations

- The main repository worktree outside the audited phase worktree is dirty with unrelated pre-existing changes; the audited phase worktree itself was clean before the report write.
- `AGENTS.md` is not present inside the audited worktree, so this audit used the runtime instructions supplied in the prompt plus the spec and plan files in the worktree.
- Runtime approval tokens remain scoped to owned runtime approval records for resolution, while command metadata, audits, adapter logs, and transcripts avoid raw token/path leakage.
