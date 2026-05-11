# Claude Code Adapter

## Target

Claude Code should be integrated without PTY first. PTY remains fallback only for interactive workflows that cannot be represented through SDK or headless streaming.

## Preferred Protocol

- Primary: Claude Agent SDK if the SDK surface is stable.
- Fallback: `claude -p --output-format stream-json`.
- Last resort: PTY, local-only by policy.

## Verified Local Facts

- Binary: `/Users/vasuyadav/.local/bin/claude`
- Version: `2.1.138`
- Live prompt probe was deferred to avoid model spend.

## Implementation Notes

- Normalize text deltas, tool calls, tool results, approval pauses, completion, and failures.
- Preserve the raw SDK/stream-json transcript as an artifact.
- Doctor must report auth availability without printing secrets.

## Status

Planned. Requires an approved live probe before implementation.
