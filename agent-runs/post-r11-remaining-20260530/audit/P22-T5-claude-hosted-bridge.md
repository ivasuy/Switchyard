# Audit log: P22-T5-claude-hosted-bridge

## 2026-06-02T00:58:00+05:30 — Pass 1 (per-worktree)

**Verdict:** GREEN

**Findings:**
- None.

**Notes:**
- Verified hosted Claude bridge is enabled only through worker-owned sessions with `hostedBridgeEnabled`, while local behavior remains unchanged in [packages/adapters/src/claude-code/claude-code-adapter.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-22-r23-hosted-runtime-bridges/packages/adapters/src/claude-code/claude-code-adapter.ts:1).
- Verified approval resolution and input errors stay redacted and bounded.

