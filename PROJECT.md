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

## Phase 11: R12 Production Hosting Foundation
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-30-phase-11-r12-production-hosting-foundation.md
**Plan:** docs/superpowers/plans/2026-05-30-phase-11-r12-production-hosting-foundation.md
**Audit:** agent-runs/post-r11-remaining-20260530/audit/phase-11-report.md
**Branch:** agent/phase-11-r12-production-hosting-foundation (audit GREEN; branch retained locally)
**PR:** not created - native TUI workflow requested; branch retained locally

### What changed
R12 is now shipped on the phase branch. Switchyard has a self-hosted staging foundation for the fake-only hosted worker and connected-node slice: Docker Compose artifacts for server, worker, node, Postgres, Redis, and a shared local object volume; fail-closed staging/production config validation; `/ready` dependency checks; JSON metrics dependency reporting; queue stale-claim and retry-exhaustion recovery; local object-volume artifact error mapping and digest checks; connected-node auth/body/client hardening; and a compose-backed self-hosted smoke command. The smoke command could not start Docker in this audit environment, but it emitted the required named `self_hosted_smoke_docker_unavailable` prerequisite failure with diagnostics preserved.

The shipped boundary remains explicit: R12 does not ship managed hosted deployment, hosted Codex/Claude/OpenCode execution, arbitrary hosted subprocess/PTY execution, S3/R2 network object-store clients, enterprise auth/billing/tenant controls, broad adapters/tools, hosted real-runtime debate/model judging, dashboard, or TUI.

### Deferred Concerns
- None.

## Phase 12: R13 S3/R2 Network Object Store Client Wiring
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-30-phase-12-r13-s3-r2-object-store-client.md
**Plan:** docs/superpowers/plans/2026-05-30-phase-12-r13-s3-r2-object-store-client.md
**Audit:** agent-runs/post-r11-remaining-20260530/audit/phase-12-report.md
**Branch:** agent/phase-12-r13-s3-r2-object-store-client (audit GREEN; branch retained locally)
**PR:** not created - native TUI workflow requested; branch retained locally

### What changed
R13 is now shipped on the phase branch. Switchyard can use an explicitly configured S3-compatible artifact content backend for the fake-only hosted server/worker slice, including AWS S3 and Cloudflare R2-style endpoint configuration. The release adds a storage-scoped AWS SDK v3 S3 client wrapper, shared object-store config resolver/factory, fail-closed staging/production backend rules, redacted config summaries, bounded S3 put/get/delete/probe operations, S3 body conversion and timeout handling, artifact metadata preservation, safe REST object-store error mapping, server/worker readiness probing, and low-cardinality object-store metrics. Normal CI remains no-spend and uses deterministic fake clients; local object-volume and memory behavior remain available where allowed.

The shipped boundary remains explicit: R13 does not ship managed hosted deployment, hosted Codex/Claude/OpenCode execution, arbitrary hosted subprocess/PTY execution, enterprise auth/billing/tenant controls, broad adapters/tools, runtime-specific approval bridges, hosted real-runtime debate/model judging, dashboard, or TUI.

### Deferred Concerns
- None.

## Phase 13: R14 Hosted Sandbox Substrate For Process/PTY
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-30-phase-13-r14-hosted-sandbox-substrate.md
**Plan:** docs/superpowers/plans/2026-05-30-phase-13-r14-hosted-sandbox-substrate.md
**Audit:** agent-runs/post-r11-remaining-20260530/audit/phase-13-report.md
**Branch:** agent/phase-13-r14-hosted-sandbox-substrate (audit GREEN; branch retained locally)
**PR:** not created - native TUI workflow requested; branch retained locally

### What changed
R14 is now shipped on the phase branch. Switchyard adds an internal fake/no-spend hosted sandbox substrate for future process-like and PTY-like work: typed sandbox contracts, deny-by-default fake-command policy, deterministic fake executor coverage, resource-limit validation, redacted transcripts/artifact metadata, readiness and metrics wiring, hosted worker construction, and a no-spend sandbox smoke command. The OpenAPI contract remains free of public `/sandbox`, `/exec`, `/pty`, or `/terminal` execution routes, and hosted runtime execution still registers only `FakeRuntimeAdapter`.

The shipped boundary remains explicit: R14 does not ship managed hosted deployment, production arbitrary subprocess/PTY execution, hosted Codex/Claude/OpenCode execution, Cursor/OpenClaw/Paperclip/browser/search/fetch/GitHub/repo/generic process/generic PTY adapters, real shell/browser/search/GitHub/fetch/repo tool execution, interactive Codex runtime/session-resume/approval bridges, enterprise auth/billing/tenant controls, hosted debate with real participant runtimes or model judging, dashboard, or TUI.

### Deferred Concerns
- None.

## Phase 14: R15 Hosted Real Runtime Execution
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-30-phase-14-r15-hosted-real-runtime-execution.md
**Plan:** docs/superpowers/plans/2026-05-30-phase-14-r15-hosted-real-runtime-execution.md
**Audit:** agent-runs/post-r11-remaining-20260530/audit/phase-14-report.md
**Branch:** agent/phase-14-r15-hosted-real-runtime-execution (audit GREEN; branch retained locally)
**PR:** not created - native TUI workflow requested; branch retained locally

### What changed
R15 is now shipped on the phase branch. Switchyard adds operator opt-in self-hosted/staging hosted worker execution for the existing known real runtime modes `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`, while keeping `fake.deterministic` as the default safe hosted path. The release adds a closed hosted runtime catalog, real-runtime gate validation, explicit hosted placement requirements, production fail-closed behavior, server-side `?wait=1` denial before durable or queue side effects, worker claim revalidation, guarded prepared-metadata compare-and-update before adapter start, hosted-safe adapter logging, provider adapter construction limited to allowlisted known modes, no-spend hosted real-runtime smoke coverage, and product/development docs for rollback and operational boundaries.

The shipped boundary remains explicit: R15 does not ship managed production hosted platform deployment, production arbitrary subprocess/PTY sandboxing, arbitrary hosted subprocess execution, generic process/PTY adapters, public `/sandbox`, `/exec`, `/pty`, or `/terminal` APIs, hosted Generic HTTP/AgentField/Cursor/OpenClaw/Paperclip/browser/search/fetch/GitHub/repo/shell execution, real shell/browser/search/GitHub/fetch/repo tools, interactive Codex sessions, Codex session resume or approval bridge, hosted post-start input bridge, enterprise auth/billing/tenant controls, hosted debate with real participants/model judging, dashboard, or TUI.

### Deferred Concerns
- None.

## Phase 15: R16 Interactive Codex And Approval Bridges
**Date:** 2026-05-30
**Spec:** docs/superpowers/specs/2026-05-30-phase-15-r16-interactive-codex-and-approval-bridges.md
**Plan:** docs/superpowers/plans/2026-05-30-phase-15-r16-interactive-codex-and-approval-bridges.md
**Audit:** agent-runs/post-r11-remaining-20260530/audit/phase-15-report.md
**Branch:** agent/phase-15-r16-interactive-codex-and-approval-bridges (audit GREEN; branch retained locally)
**PR:** not created - native TUI workflow requested; branch retained locally

### What changed
R16 is now shipped on the phase branch. Switchyard adds an explicit local-only `codex.interactive` runtime mode while preserving `codex.exec_json` as the inferred one-shot default. The release adds fake/no-spend Codex interactive session coverage, bounded post-start input, session-state/resume metadata handling, runtime approval terminalization and startup reconciliation, approval expiry without lock re-entry, adapter-emitted terminal failure cleanup, runtime-output log redaction, double-input conflict handling, daemon registry/doctor wiring that avoids live-resume overclaiming, REST/OpenAPI boundary guards, and product/development docs for the shipped local Codex interactive path.

The shipped boundary remains explicit: R16 does not ship hosted post-start input or approval bridges, public PTY/TUI/terminal/exec/sandbox routes, arbitrary shell/tool execution, generic process/PTY adapters, real shell/browser/search/GitHub/fetch/repo tools, live Codex resume success guarantees, hosted debate with real participant runtimes/model judging, managed production hosted platform deployment, enterprise auth/billing/tenant controls, dashboard, or TUI.

### Deferred Concerns
- None.
