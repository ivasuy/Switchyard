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

## Phase 3: R4 Shared Runtime Substrates And Generic HTTP
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-29-phase-3-r4-shared-runtime-substrates-and-generic-http.md
**Plan:** docs/superpowers/plans/phase-3-r4-shared-runtime-substrates-and-generic-http.md
**Audit:** agent-runs/native-roadmap-20260529/audit/phase-3-report.md
**Branch:** agent/phase-3-r4-shared-runtime-substrates-and-generic-http (audit GREEN; merge pending native runtime)
**PR:** not created - native audit workflow requested; branch retained locally

### What changed
R4 is now shipped on the phase branch. Switchyard extracts shared runtime substrates from the proven Codex `exec --json` path, adds the `generic_http.async_rest` runtime mode plus deterministic fake HTTP wrapper coverage, wires Generic HTTP through daemon/runtime-mode/doctor/REST surfaces, and preserves transcript artifacts and verified-terminal cancellation semantics across both process-backed and HTTP-wrapper-backed adapters.

### Deferred Concerns
- None.

## Phase 4: R5 ACP Foundation And OpenCode
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md
**Plan:** docs/superpowers/plans/phase-4-r5-acp-foundation-and-opencode.md
**Audit:** agent-runs/native-roadmap-20260529/audit/phase-4-report.md
**Branch:** agent/phase-4-r5-acp-foundation-and-opencode (audit GREEN; merge pending native runtime)
**PR:** not created - native audit workflow requested; branch retained locally

### What changed
R5 is now shipped on the phase branch. Switchyard adds the reusable `@switchyard/protocol-acpx` package for ACP framing, schemas, stdio correlation, and redacted raw transcripts; a deterministic fake ACP runtime harness; and the local `opencode.acp` runtime mode over that shared foundation. The daemon now seeds and checks OpenCode ACP without sending `session/prompt`, runs can infer `opencode.acp` through the existing API, verified cancellation persists transcript artifacts for cancelled and failed/timeout-after-start sessions, and the development/product docs now describe the shipped local OpenCode ACP boundary without overclaiming hosted, approval, tool, memory, PTY, or interactive runtime support.

### Deferred Concerns
- None.

## Phase 5: R6 Wrapper Runtime Integration
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-29-phase-5-r6-wrapper-runtime-integration.md
**Plan:** docs/superpowers/plans/phase-5-r6-wrapper-runtime-integration.md
**Audit:** agent-runs/native-roadmap-20260529/audit/phase-5-report.md
**Branch:** agent/phase-5-r6-wrapper-runtime-integration (audit GREEN; merge pending native runtime)
**PR:** not created - native audit workflow requested; branch retained locally

### What changed
R6 is now shipped on the phase branch. Switchyard adds the configured `agentfield.async_rest` wrapper runtime mode, deterministic fake AgentField server and CLI verification path, AgentField daemon config and doctor reporting, runtime-mode inference, async create/poll/result mapping, sanitized transcript and result artifacts, and REST/daemon coverage for artifact retrieval, unsupported input, unsupported active cancel, timeout persistence, and secret redaction. The shipped boundary remains narrow: AgentField is a wrapper runtime behind Switchyard's existing control plane, and R6 does not claim OpenClaw, Paperclip, hosted workers, debate orchestration, SDK/CLI/TUI/dashboard work, or verified upstream cancellation.

### Deferred Concerns
- None.
