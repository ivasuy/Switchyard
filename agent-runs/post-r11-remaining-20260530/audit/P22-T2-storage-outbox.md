# Audit log: P22-T2-storage-outbox

## 2026-06-02T00:58:00+05:30 — Pass 1 (per-worktree)

**Verdict:** GREEN

**Findings:**
- None.

**Notes:**
- Verified additive Postgres bridge command and payload tables plus CAS-style claim/complete/fail/recover behavior in [packages/storage/src/postgres/hosted-runtime-bridge-command-store.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-22-r23-hosted-runtime-bridges/packages/storage/src/postgres/hosted-runtime-bridge-command-store.ts:1), [packages/storage/src/postgres/hosted-runtime-bridge-payload-store.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-22-r23-hosted-runtime-bridges/packages/storage/src/postgres/hosted-runtime-bridge-payload-store.ts:1), and [packages/storage/src/postgres/schema.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-22-r23-hosted-runtime-bridges/packages/storage/src/postgres/schema.ts:1).
- Verified stale claimed commands fail closed with `hosted_runtime_bridge_non_idempotent_retry_blocked` instead of retrying provider input.
