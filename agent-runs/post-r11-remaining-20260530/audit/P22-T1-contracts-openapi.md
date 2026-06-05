# Audit log: P22-T1-contracts-openapi

## 2026-06-02T00:58:00+05:30 — Pass 1 (per-worktree)

**Verdict:** GREEN

**Findings:**
- None.

**Notes:**
- Verified hosted runtime bridge contract surface is limited to `claude_code.sdk` and `opencode.acp` in [packages/contracts/src/hosted-runtime-bridge.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-22-r23-hosted-runtime-bridges/packages/contracts/src/hosted-runtime-bridge.ts:1).
- Verified hosted OpenAPI/route inventory guards keep the existing `POST /runs/:id/input` and approval routes only, with no public `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, `/sandbox`, top-level `/input`, top-level `/approval`, `/runtime-bridge`, `/session`, dashboard, or TUI route expansion in [packages/contracts/src/openapi.contract.test.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-22-r23-hosted-runtime-bridges/packages/contracts/src/openapi.contract.test.ts:1) and [packages/contracts/src/endpoint-inventory.drift.test.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-22-r23-hosted-runtime-bridges/packages/contracts/src/endpoint-inventory.drift.test.ts:1).
