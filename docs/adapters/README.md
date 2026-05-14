# Adapter Research

This directory records runtime adapter facts before implementation. Switchyard should not build real adapters from memory because runtime surfaces change quickly.

## Adapter Status

| Adapter | Preferred path | Status | Notes |
| --- | --- | --- | --- |
| OpenCode | ACP/acpx | Verified candidate | `opencode acp` initialized successfully locally. |
| Claude Code | SDK or stream-json CLI | Needs approved live probe | CLI is installed; model-running probe was deferred to avoid spend. |
| Codex | `codex exec --json` | Implemented local slice | Non-interactive process adapter is implemented and has a local debugging guide in `docs/development/adapters/CODEX.md`. |
| Cursor Agent | stream-json CLI | Deferred | CLI is installed, but local status check hit credential/keychain failure. |
| AgentField | async REST / CLI | Verified candidate | CLI and async REST docs were checked; good early wrapper adapter target. |
| Generic HTTP | HTTP | Ready for contract design | Useful for custom agents and wrapper runtimes. |
| OpenClaw | HTTP/acpx wrapper | Deferred | API boundary should be verified before implementation. |
| Paperclip | HTTP wrapper | Deferred | API/source boundary should be verified before implementation. |

## Implementation Rule

Each adapter must ship with:

- Doctor check.
- Adapter contract test.
- Raw transcript capture.
- Event normalization map.
- Cancellation behavior.
- Artifact extraction behavior.
- Placement-policy facts for local, hosted, and hybrid execution.
