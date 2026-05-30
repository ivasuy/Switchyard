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

## Phase 6: R7 Middleware Foundation
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-30-phase-6-r7-middleware-foundation.md
**Plan:** docs/superpowers/plans/phase-6-r7-middleware-foundation.md
**Audit:** agent-runs/native-roadmap-20260529/audit/phase-6-report.md
**Branch:** agent/phase-6-r7-middleware-foundation (audit GREEN; merge pending native runtime)
**PR:** not created - native audit workflow requested; branch retained locally

### What changed
R7 is now shipped on the phase branch. Switchyard adds durable local middleware APIs for messages, substring-only memory, evidence metadata, deterministic context packets, approval lifecycle records/events, and the policy-gated `fake_echo` tool. SQLite migrations add the middleware tables and indexes while preserving pre-R7 data, the daemon wires middleware stores/services/routes, `POST /runs` can optionally render context into the task with original task/context metadata preserved, and real tool types remain policy-denied before adapter dispatch. The shipped surface remains local and deterministic: no vector search, no remote evidence fetching, no real shell/browser/search/GitHub/fetch/repo execution, no debate engine, and no runtime-specific approval bridge.

### Deferred Concerns
- None.

## Phase 7: R8 Interactive Coding Runtimes
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-30-phase-7-r8-interactive-coding-runtimes.md
**Plan:** docs/superpowers/plans/2026-05-30-phase-7-r8-interactive-coding-runtimes.md
**Audit:** agent-runs/native-roadmap-20260529/audit/phase-7-report.md
**Branch:** agent/phase-7-r8-interactive-coding-runtimes (audit GREEN; merge pending native runtime)
**PR:** not created - native audit workflow requested; branch retained locally

### What changed
R8 is now shipped on the phase branch. Switchyard adds the first bounded interactive coding runtime path through `claude_code.sdk`, backed by structured Claude stream-json CLI transport behind the Claude client port. The runtime spine now handles post-start text input, waiting-for-input and waiting-for-approval states, bounded session-state patches, runtime approval pauses through the existing approval store, approval-resolution error mapping, and transcript artifacts with hard size limits and truncation markers. The daemon seeds and checks Claude Code without live prompt spend by default, while fake/no-spend tests cover the opt-in live-probe path. Codex remains `codex.exec_json` one-shot with explicit unsupported post-start input; Codex interactive promotion, PTY/TUI automation, hosted execution, and Claude session resume remain deferred.

### Deferred Concerns
- None.

## Phase 8: R9 Debate V1
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-30-phase-8-r9-debate-v1.md
**Plan:** docs/superpowers/plans/2026-05-30-phase-8-r9-debate-v1.md
**Audit:** agent-runs/native-roadmap-20260529/audit/phase-8-report.md
**Branch:** agent/phase-8-r9-debate-v1 (audit GREEN; merge pending native runtime)
**PR:** not created - native audit workflow requested; branch retained locally

### What changed
R9 is now shipped on the phase branch. Switchyard adds a local, deterministic Debate V1 workflow on top of the existing run, message, evidence, event, and artifact primitives. The API now supports debate create, inspect, and debate-scoped event replay/live streams; the core service creates normal fake participant runs, routes every turn through `MessageRouter`, enforces hard round/message/cost/search/runtime limits, validates evidence before side effects, runs a deterministic no-model judge, and writes a final markdown report artifact. SQLite adds durable debate state and debate-scoped event/artifact lookup, while local smoke docs cover the no-spend fake debate path and negative cases. R9 remains fake-only: no hosted or hybrid execution, real participant runtimes, real tools, model judging, swarms, SDK/CLI/TUI/dashboard work, or external research automation shipped in this phase.

### Deferred Concerns
- None.

## Phase 9: R10 Hosted And Hybrid Execution
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-30-phase-9-r10-hosted-and-hybrid-execution.md
**Plan:** docs/superpowers/plans/2026-05-30-phase-9-r10-hosted-and-hybrid-execution.md
**Audit:** agent-runs/native-roadmap-20260529/audit/phase-9-report.md
**Branch:** agent/phase-9-r10-hosted-and-hybrid-execution (audit GREEN; merge pending native runtime)
**PR:** not created - native audit workflow requested; branch retained locally

### What changed
R10 is now shipped on the phase branch. Switchyard adds hosted-like and connected-node execution while preserving the existing public run contract. The release adds `apps/server`, `apps/worker`, and `apps/node`; hosted and node protocol surfaces; placement, node coordination, local policy, queue, event sync, and artifact sync services; Postgres metadata store adapters; Redis/BullMQ-backed queue wiring; and filesystem-backed object-compatible artifact content for the shipped hosted-like mode. Hosted worker execution is gated to `fake.deterministic` only and revalidates durable run state at claim time before execution. Connected nodes claim authoritative run payloads, enforce local policy, sync real events/artifacts, and reject invalid assignment states. The final audited truth is explicit: S3/R2 network object stores, hosted subprocess/PTY execution, hosted Codex/Claude/OpenCode, real tools, hosted debate, model judging, SDK/CLI/TUI/dashboard packaging, enterprise auth/billing, and production sandboxing remain unshipped.

### Deferred Concerns
- None.

## Phase 10: R11 SDK, CLI, And Hardening
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-30-phase-10-r11-sdk-cli-and-hardening.md
**Plan:** docs/superpowers/plans/2026-05-30-phase-10-r11-sdk-cli-and-hardening.md
**Audit:** agent-runs/native-roadmap-20260529/audit/phase-10-report.md
**Branch:** agent/phase-10-r11-sdk-cli-and-hardening (audit GREEN; branch retained locally)
**PR:** not created - native TUI workflow requested; branch retained locally

### What changed
R11 is now shipped on the phase branch. Switchyard adds the consumable local product surface on top of the audited daemon API: `@switchyard/sdk`, `@switchyard/cli`, contracts-owned OpenAPI 3.1 generation, no-spend adapter compatibility automation, local release packaging smoke, and operational hardening. The SDK can create fake local runs, inspect/replay events, fetch artifact metadata and raw content, query registry/runtime-mode surfaces, and report typed HTTP/network/decode/timeout/validation/stream errors with request ids. The CLI now supports doctor, daemon start, fake run, runtime/runtimes test, debug run, and contract export workflows without hand-written curl. SQLite has explicit schema metadata, additive migration policy checks, representative pre-R3/pre-R7/pre-R9/pre-R11 fixture preservation tests, and corrupt/zero-byte database rejection. The daemon now preserves bounded inbound request ids, emits local metrics, and has startup recovery/idempotency coverage. Clean temp packaging smoke packs and installs the local artifacts outside the monorepo and exercises SDK/CLI/daemon flows with no live external provider spend.

### Deferred Concerns
- None.
