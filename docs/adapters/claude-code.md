# Claude Code Adapter

## Target

Claude Code ships in R8 as the first bounded interactive coding runtime through `claude_code.sdk`.

## Preferred Protocol

- Primary: structured client port behind `claude_code.sdk` (native adapter type). Current daemon default path is `claude -p` with `stream-json` input/output.
- Fallback: no PTY fallback is shipped in R8.
- Last resort: PTY remains out of scope for this release.

## Verified Local Facts

- Runtime mode: `claude_code.sdk`.
- Adapter id: `claude_code` (`native`, `sdk` kind).
- Default doctor path is no-spend and does not run a live prompt.
- Live probe is opt-in only (`SWITCHYARD_CLAUDE_CODE_LIVE_PROBE=1`) and bounded by budget/time safeguards.

## Implementation Notes

- Supports post-start text input for active sessions (`POST /runs/:id/input`).
- Session resume is not shipped for `claude_code.sdk` in R8.
- Persists session state patches (for example `claudeSessionId`) through the existing runtime session store.
- Bridges runtime approval pauses into existing approval records and resolves them back to the active runtime on approve/reject.
- Normalizes text deltas, tool calls, tool results, approval pauses, ask-user-question pauses, completion, failure, and cancellation.
- Stores both raw and normalized transcript artifacts with bounds:
  - raw transcript max: 1 MiB
  - normalized transcript max: 1 MiB
  - normalized record max: 64 KiB
- Unknown provider events are flood-bounded (suppression after the first 100 unknown events).
- PTY/TUI automation is not implemented.

## Status

Implemented for local bounded interactive sessions in R8. Hosted execution and PTY are not implemented.
