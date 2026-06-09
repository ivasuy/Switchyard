# Cursor Agent Adapter Local Development

This guide is for the initial `cursor.agent_stream_json` adapter scaffold.

## Current Boundary

Shipped in this slice:

- Runtime adapter manifest for `cursor.agent_stream_json`.
- Binary version doctor/check through `cursor-agent --version`.
- Compatibility-matrix coverage.
- Safe start denial until auth/keychain behavior and stream-json event fixtures are verified.

Not shipped in this slice:

- Real Cursor Agent run execution.
- Parser fixtures for Cursor stream-json output.
- Hosted Cursor execution.
- PTY/TUI fallback.
- Runtime input, approval bridge, or cancellation.

## Check

```bash
pnpm --filter @switchyard/adapters test -- deferred-adapters compatibility-matrix
```

The adapter can also be checked directly from code by constructing:

```ts
new CursorAgentAdapter().check()
```

Expected states:

- `cursor_binary_missing`: `cursor-agent` is not installed or not on `PATH`.
- `cursor_version_failed`: the binary exists but `cursor-agent --version` failed.
- `cursor_check_timeout`: the version probe exceeded the bounded timeout.
- `cursor_stream_shape_unverified`: binary exists, but Switchyard still blocks execution until auth and stream fixtures are verified.

## Verification Needed Before Execution

- Confirm local `cursor-agent` auth/keychain behavior without leaking credentials.
- Capture no-spend stream-json fixtures for success, failure, tool events, and malformed output.
- Add parser tests before allowing `start()`.
- Add daemon registry seeding only after the adapter can execute through fake/no-spend fixtures.
