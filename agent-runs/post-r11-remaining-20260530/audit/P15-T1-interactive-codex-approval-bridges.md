# Phase 15 Audit Log: P15-T1 Interactive Codex Approval Bridges

**Date:** 2026-05-31
**Iteration:** 1
**Branch:** `agent/phase-15-r16-interactive-codex-and-approval-bridges`
**Base commit:** `3d77409`
**Implementation commits:** `59492ae`, `2caf54e50b369cdef5af04f6da7d0b23f6ed8a2c`
**Verdict:** `GREEN`

## Scope Audited

- Committed Phase 15 diff from `3d77409..HEAD`
- Core runtime approval/session bridge hardening
- Explicit local-only `codex.interactive` routing and fake-backed coverage
- Daemon startup reconciliation and runtime-mode registry/doctor truth
- REST/OpenAPI boundary guards
- Product/development/docs truth for shipped and unshipped R16 behavior

## Diff Hygiene

- `git status --short`: clean before audit log write
- `git diff --check 3d77409..HEAD`: passed
- Phase diff contains 5 commits and 29 changed files

## Required Checks

- `pnpm --filter @switchyard/core test`: passed (`13` files, `124` tests)
- `pnpm --filter @switchyard/testkit test`: passed (`6` files, `26` tests)
- `pnpm --filter @switchyard/adapters test`: passed (`13` files, `87` tests)
- `pnpm --filter @switchyard/daemon test`: passed (`3` files, `37` tests)
- `pnpm --filter @switchyard/protocol-rest test`: passed (`7` files, `67` tests)
- `pnpm --filter @switchyard/contracts test`: passed (`5` files, `43` tests)
- `pnpm --filter @switchyard/contracts openapi:check`: passed
- `pnpm typecheck`: passed

## Acceptance Probes

- `codex.exec_json` remains inferred/default one-shot:
  - `RegistryService` still infers omitted Codex mode to `codex.exec_json`.
  - `CodexExecJsonAdapter` still uses `stdin: "close"` and retains `one_shot_no_input`, `no_approval_bridge`, and `no_session_resume` limitations.
  - Regression tests covering one-shot behavior passed.
- `codex.interactive` is explicit-only and local-only:
  - `CodexAdapterRouter` defaults omitted mode to `codex.exec_json`.
  - `CodexInteractiveAdapter.start()` rejects non-`codex.interactive` runtime modes.
  - Manifest/placement mark hosted as unsupported and live bridge capability as conditional.
  - Fake-backed no-spend session factory and daemon smoke coverage passed.
- Pending runtime approvals terminalize correctly:
  - `ApprovalService` implements expiration, terminalization, and startup reconciliation.
  - `RuntimeRunnerService` terminalizes linked pending approvals on timeout, cancel, and failure paths.
  - Daemon startup calls `expirePendingRuntimeApprovals()` and `terminalizePendingRuntimeApprovalsForRun(... daemon_restarted ...)`.
  - Core and daemon tests covering approve, reject, expired, timeout, cancel, malformed stream, run failed, and daemon restart passed.
- Late expired approve/reject does not hang:
  - `ApprovalService.resolve()` expires stale pending approvals under the same lock, emits one terminal event, sends one rejection resolution when possible, then returns `approval_not_pending`.
  - Middleware route tests and core expiration tests passed.
- Adapter-emitted `run.failed` terminalizes pending approvals:
  - `RuntimeRunnerService.terminalizeRunFromAdapterEvent()` explicitly rejects linked pending approvals on adapter `run.failed`.
  - Core tests cover this path and passed.
- Runtime output logs do not expose raw secret text:
  - `RuntimeRunnerService.logEvent()` omits raw `runtime.output.payload.text`.
  - Core tests verify representative fake secrets are absent from logs.
- Double input/resume conflict is stable:
  - `RuntimeRunnerService.sendInput()` guards same-session concurrent sends with `runtime_input_in_flight`.
  - REST tests verify `409 adapter_protocol_failed` mapping for the conflict.
- No public terminal/PTTY/sandbox execution routes were added:
  - `run-routes.ts` adds only `wait=1` and placement guards for `codex.interactive`.
  - OpenAPI contract tests forbid `/sandbox`, `/exec`, `/pty`, `/terminal`, `/shell`, `/process`, and `/command` path/operation exposure and passed.
- Docs/product truth stays within R16 boundaries:
  - Product and development docs state `codex.exec_json` remains the default one-shot mode.
  - `codex.interactive` is documented as explicit-only, local-only, fake-testable, and no-spend check based.
  - Docs distinguish `resumeCommandShapeAvailable` from `liveResumeVerified`.
  - Hosted interactive/input/approval bridges, PTY/TUI/public terminal surfaces, arbitrary shell/tool execution, dashboard/TUI, enterprise controls, and managed hosted platform remain explicitly unshipped.

## Findings

- None.

## Required Changes

- None.

