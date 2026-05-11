# Phase -1 Adapter Verification Summary

Phase -1 exists to prevent stale adapter assumptions.

## Verified Locally

- OpenCode `1.3.15`: ACP initialize and session creation succeeded.
- Claude Code `2.1.138`: CLI exists; live run deferred.
- Codex `0.130.0`: CLI exists; live JSON probe deferred.
- Cursor Agent `2026.05.07-42ddaca`: CLI exists; status failed with keychain error.
- AgentField `0.1.77`: CLI exists; async REST flow is a good wrapper target.

## Deferred Probes

Live prompt probes for Claude, Codex, and Cursor were intentionally deferred because they may spend model budget or mutate local state.

## Adapter Order

Recommended order:

1. Fake adapter and adapter contract tests.
2. ACP/acpx protocol foundation.
3. OpenCode ACP adapter.
4. Generic HTTP adapter.
5. AgentField adapter.
6. Claude Code headless adapter.
7. Codex parser-backed adapter.
8. Cursor adapter.
9. OpenClaw and Paperclip after API verification.
