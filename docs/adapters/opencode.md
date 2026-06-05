# OpenCode Adapter Research Notes

R5 shipped the OpenCode ACP path. The active local development and smoke guide is:

- `docs/development/adapters/OPENCODE.md`

Historical planning notes in this file are retained only as background context.

## Hosted Debate Boundary

- R24 allows `opencode.acp` as an opt-in local/hosted debate participant runtime.
- Hosted debate use depends on the R23 hosted runtime bridge command and payload stores shared by server and worker.
- Missing bridge stores fail closed with `hosted_runtime_bridge_store_unavailable`.
- Hosted debate still uses normal run/runtime contracts and preserves child run, message, event, evidence, and artifact traceability.
- Generic process adapters, PTY/TUI automation, hosted terminal bridges, and public arbitrary execution routes remain unshipped.
