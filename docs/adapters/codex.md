# Codex Adapter

## Target

Codex should support coding/repo tasks through a structured headless path before any PTY fallback.

## Preferred Protocol

- Primary: `codex exec --json` or ACP if available.
- Fallback: subprocess adapter with explicit parser contract.
- Last resort: PTY, local-only by policy.

## Verified Local Facts

- Binary: `/opt/homebrew/bin/codex`
- Version: `0.130.0`
- Live `codex exec --json` probe was deferred to avoid spend and unintended workspace changes.

## Implementation Notes

- Capture JSONL event shape before implementation.
- Contract-test parser behavior with fixture logs.
- Normalize output, tool calls, approval requests, file changes, completion, and failure.

## Status

Planned. Do not implement until JSONL/parser contract is captured.
