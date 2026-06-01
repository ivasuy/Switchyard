# Audit log: P22-T3-core-bridge-orchestration

## 2026-06-02T00:58:00+05:30 — Pass 1 (per-worktree)

**Verdict:** GREEN

**Findings:**
- None.

**Notes:**
- Verified hosted bridge admission/claim/apply/reconciliation logic, payload hashing before redaction, approval decision idempotency, and fail-closed stale-claim recovery in [packages/core/src/services/hosted-runtime-bridge-service.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-22-r23-hosted-runtime-bridges/packages/core/src/services/hosted-runtime-bridge-service.ts:1).
- Verified unsupported hosted runtime bridge modes map to explicit named reasons for `codex.exec_json`, `codex.interactive`, `agentfield.async_rest`, and `generic_http.async_rest`.

