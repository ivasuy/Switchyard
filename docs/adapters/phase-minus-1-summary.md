# Phase -1 Adapter Verification Summary

Phase -1 exists to prevent stale adapter assumptions.

## Verified Locally

- OpenCode `1.3.15`: ACP initialize and session creation succeeded.
- Claude Code `2.1.138`: CLI exists; live run deferred.
- Codex `codex-cli 0.130.0`: CLI exists; `codex exec --json` surface and `codex debug models` catalog were inspected without running a live model task.
- Cursor Agent `2026.05.07-42ddaca`: CLI exists; status failed with keychain error.
- AgentField `0.1.77`: CLI exists; async REST flow is a good wrapper target.

## Deferred Probes

Live prompt probes for Claude, Codex, and Cursor were intentionally deferred because they may spend model budget or mutate local state. Codex implementation uses fake-process tests for CI safety; the optional live probe is documented in `docs/adapters/verification/codex-exec-json.md`.

## Adapter Order

Recommended order:

1. Fake adapter and adapter contract tests.
2. Codex exec-json local adapter.
3. ACP/acpx protocol foundation.
4. OpenCode ACP adapter.
5. Generic HTTP adapter.
6. AgentField adapter.
7. Claude Code headless adapter.
8. Cursor adapter.
9. OpenClaw and Paperclip after API verification.
