# Claude Code Adapter

## Target

Claude Code ships in R8 as the first bounded interactive coding runtime through `claude_code.sdk`.

## Preferred Protocol

- Primary: structured client port behind `claude_code.sdk` (native adapter type). Current daemon default path is `claude -p` with `stream-json` input/output.
- Fallback: no PTY fallback is shipped in R8.
- Last resort: PTY remains unshipped for Claude Code.

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

## Hosted Debate Boundary

- R24 allows `claude_code.sdk` as an opt-in local/hosted debate participant runtime.
- Hosted debate use depends on the R23 hosted runtime bridge command and payload stores shared by server and worker.
- Missing bridge stores fail closed with `hosted_runtime_bridge_store_unavailable`.
- Hosted debate still uses normal run/runtime contracts and preserves child run, message, event, evidence, and artifact traceability.
- PTY/TUI automation and hosted terminal bridges remain unshipped.

## Status

Implemented for local bounded interactive sessions in R8 and for the R23 hosted bridge boundary. R24 hosted debate may use `claude_code.sdk` only when hosted provider activation and R23 bridge readiness pass. Generic PTY execution remains unshipped.
