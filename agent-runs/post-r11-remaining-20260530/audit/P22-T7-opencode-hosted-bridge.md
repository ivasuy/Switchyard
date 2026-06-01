# Audit log: P22-T7-opencode-hosted-bridge

## 2026-06-02T00:58:00+05:30 — Pass 1 (per-worktree)

**Verdict:** GREEN

**Findings:**
- None.

**Notes:**
- Verified hosted OpenCode bridge uses structured ACP JSON-RPC only for follow-up prompt input and permission approval lifecycle in [packages/adapters/src/opencode/opencode-acp-adapter.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-22-r23-hosted-runtime-bridges/packages/adapters/src/opencode/opencode-acp-adapter.ts:1).
- No PTY, terminal proxy, keyboard driving, or screen scraping path was introduced.

