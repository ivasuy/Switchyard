# Cursor Agent Adapter

## Target

Cursor Agent support is planned if its headless interface is stable enough for normalized event streaming.

## Preferred Protocol

- Primary: `cursor-agent -p --output-format stream-json` if available and stable.
- Fallback: process or PTY only after explicit verification.

## Verified Local Facts

- Binary: `/Users/vasuyadav/.local/bin/cursor-agent`
- Version: `2026.05.07-42ddaca`
- `cursor-agent status` failed locally with `SecItemCopyMatching failed -50`.

## Implementation Notes

- Auth/keychain behavior must be understood before implementation.
- Parser fixtures are required before enabling a real adapter.

## Status

Deferred until auth and stream shape are verified.
