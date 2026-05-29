# PROJECT.md

## Phase 1: R0-R2 Verification And Release Truth Reconciliation
**Date:** 2026-05-29
**Spec:** docs/superpowers/specs/2026-05-29-roadmap-release-train.md
**Plan:** docs/superpowers/plans/phase-1-r0-r2-verification-and-release-truth-reconciliation.md
**Audit:** agent-runs/native-roadmap-20260529/audit/phase-1-report.md
**Branch:** agent/phase-1-r0-r2-verification-and-release-truth-reconciliation (merged)
**PR:** not created - native TUI workflow requested; branch retained locally

### What changed
R0, R1, and R2 are now reconciled as shipped local-gateway releases. `PRODUCT.md` marks the R0-R2 surface as shipped, corrects stale residual-risk language, and records the `agent/roadmap-base-20260529` snapshot used for verification. `CHANGELOG.md` now has a dated R0-R2 reconciliation release entry. The local development docs no longer point at stale anchors and now describe artifact content, registry listing, open-ended local SSE, bounded SSE, and Codex smoke behavior accurately.

### Deferred Concerns
- None.

## Phase 2: R3 Runtime Capability Infrastructure
**Date:** 2026-05-29
**Spec:** docs/superpowers/specs/2026-05-29-phase-2-r3-runtime-capability-infrastructure.md
**Plan:** docs/superpowers/plans/phase-2-r3-runtime-capability-infrastructure.md
**Audit:** agent-runs/native-roadmap-20260529/audit/phase-2-report.md
**Branch:** agent/phase-2-r3-runtime-capability-infrastructure (audit GREEN; merge pending native runtime)
**PR:** not created - native audit workflow requested; branch retained locally

### What changed
R3 runtime capability inspection is now shipped on the phase branch. Switchyard has first-class runtime-mode contracts and records for `fake.deterministic` and `codex.exec_json`, bounded runtime doctor checks, `GET /runtime-modes`, `GET /runtime-modes/:id`, `POST /runtime-modes/:id/check`, and `GET /doctor`. Run creation remains backward compatible while storing inferred runtime-mode slugs, Codex remains local one-shot `exec --json`, and storage migrations are additive for pre-R3 SQLite data.

### Deferred Concerns
- None.
