# Cursor Agent Adapter

## Target

Cursor Agent support is scaffolded behind `cursor.agent_stream_json`. Execution remains blocked until its headless interface is stable enough for normalized event streaming.

## Preferred Protocol

- Primary: `cursor-agent -p --output-format stream-json` if available and stable.
- Fallback: process or PTY only after explicit verification.

## Verified Local Facts

- Binary: `/Users/vasuyadav/.local/bin/cursor-agent`
- Version: `2026.05.07-42ddaca`
- `cursor-agent status` failed locally with `SecItemCopyMatching failed -50`.

## Implementation Notes

- Auth/keychain behavior must be understood before execution is admitted.
- Parser fixtures are required before enabling a real adapter.
- The current adapter exposes manifest/check coverage and returns safe start denial.

## Status

Scaffolded. Execution remains deferred until auth and stream shape are verified.
