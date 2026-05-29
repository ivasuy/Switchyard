# Phase 2 Audit Report

**Spec:** `docs/superpowers/specs/2026-05-29-phase-2-r3-runtime-capability-infrastructure.md`
**Plan:** `docs/superpowers/plans/phase-2-r3-runtime-capability-infrastructure.md`
**Phase branch:** `agent/phase-2-r3-runtime-capability-infrastructure`
**Phase head:** `e3be7d5e2539d45ec04bb97050a5561e8dd53f28`
**Audit pass:** 1
**Date:** 2026-05-29T19:10:35Z

## Summary

Phase 2 is not mergeable yet. The branch is clean and all required verification commands pass, but two acceptance-level issues remain:

1. Active Codex doctor checks cannot surface `partial` availability even though startup seeding can.
2. The product/API/changelog closeout is incomplete and still contains stale pre-R3 wording.

## Worktree State

- `git status --short --branch` reported a clean phase branch before audit artifact creation.
- `HEAD` is exactly `e3be7d5e2539d45ec04bb97050a5561e8dd53f28`.
- `e3be7d5e2539d45ec04bb97050a5561e8dd53f28` is an ancestor of `HEAD`.

## Checks

- `git diff --check` ✅
- `pnpm --filter @switchyard/contracts test` ✅
- `pnpm --filter @switchyard/core test` ✅
- `pnpm --filter @switchyard/testkit test` ✅
- `pnpm --filter @switchyard/adapters test` ✅
- `pnpm --filter @switchyard/storage test` ✅
- `pnpm --filter @switchyard/protocol-rest test` ✅
- `pnpm --filter @switchyard/daemon test` ✅
- `pnpm typecheck` ✅
- `pnpm test` ✅
- `pnpm build` ✅
- `pnpm lint` ✅
- Manual active-check reproduction with an injected optional Codex warning ❌

## Per-Task Verdicts

### P2-T1-contracts-runtime-mode-schemas
- Final verdict: GREEN
- Notes: Runtime mode, availability, doctor, and compatibility schemas match the R3 contract.

### P2-T2-core-capability-doctor-services
- Final verdict: GREEN
- Notes: Runtime modes are first-class in core; slug-only runtime-mode validation and doctor summary state accounting are implemented.

### P2-T3-adapter-manifests-and-codex-checks
- Final verdict: NEEDS_REVISION
- Notes: `CodexExecJsonAdapter.check()` does not forward `optionalChecks`, so active doctor checks cannot emit `partial`.

### P2-T4-storage-runtime-mode-migration
- Final verdict: GREEN
- Notes: Migration is additive and pre-R3 compatibility coverage exists.

### P2-T5-rest-runtime-mode-and-run-compat-api
- Final verdict: GREEN
- Notes: The runtime-mode REST surface and slug-only run creation validation are wired correctly.

### P2-T6-daemon-startup-capability-wiring
- Final verdict: NEEDS_REVISION
- Notes: Startup partial seeding works, but active check partial behavior is missing in the shipped path and in smoke coverage.

### P2-T7-product-api-docs-closeout
- Final verdict: NEEDS_REVISION
- Notes: `CHANGELOG.md`, `PRODUCT.md`, and `docs/development/API.md` still contain stale or incomplete R3 closeout content.

## Semantic Audit

- Runtime modes are first-class and the shipped vocabulary includes `fake.deterministic` and `codex.exec_json`. ✅
- Doctor/check surfaces model `available`, `installed`, `unavailable`, `unsupported`, `partial`, and `unknown` in contracts/core summaries. ✅
- `partial` is intended as an optional-check warning, but active Codex checks currently over-collapse that case to `available`. ❌
- Codex remains exec-json only; no interactive/PTY/hosted/generic HTTP/ACP implementation claims were found in the shipped runtime-mode manifests or adapters. ✅
- Run creation remains backward compatible and explicit `runtimeMode` is slug-only. ✅
- Storage migration is additive and pre-R3 compatibility tests exist. ✅
- Product/API/dev docs do not yet fully match shipped R3 behavior. ❌

## Redflags

1. `packages/adapters/src/codex/codex-exec-json-adapter.ts:156`
   Active Codex checks drop optional probe results. A check probe with required success plus an optional warning produces `state:"available"` instead of `state:"partial"`.

2. `apps/daemon/test/smoke.test.ts:249`
   Daemon smoke coverage does not exercise the required active partial-check path, so the shipped regression is not guarded.

3. `CHANGELOG.md:5`, `PRODUCT.md:101`, `PRODUCT.md:120`, `docs/development/API.md:294`
   Documentation closeout is incomplete and still contains stale pre-R3 wording and missing runtime-mode response examples.

## Deferred Concerns

- None.

## Non-Blocking Observations

- The branch diff against `main` includes prior release-train docs and supplemental files outside the Phase 2 task graph, but I did not find additional blockers in those committed changes.

## Merge Outcome

Not merged. Audit result is `NEEDS_REVISION`.
