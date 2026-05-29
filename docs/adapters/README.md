# Adapter Research

This directory records runtime adapter facts before implementation and tracks implementation status as slices ship.

## Adapter Status

| Adapter | Preferred path | Status | Notes |
| --- | --- | --- | --- |
| OpenCode | ACP/acpx | Verified candidate | `opencode acp` initialized successfully locally. |
| Claude Code | SDK or stream-json CLI | Needs approved live probe | CLI is installed; model-running probe was deferred to avoid spend. |
| Codex | `codex exec --json` | Implemented local slice | Non-interactive process adapter is implemented and has a local debugging guide in `docs/development/adapters/CODEX.md`. |
| Cursor Agent | stream-json CLI | Deferred | CLI is installed, but local status check hit credential/keychain failure. |
| AgentField | async REST / CLI | Verified candidate | CLI and async REST docs were checked; good early wrapper adapter target. |
| Generic HTTP | HTTP async REST | Implemented local slice | Runtime mode `generic_http.async_rest` is implemented with local development guide in `docs/development/adapters/GENERIC_HTTP.md`. |
| OpenClaw | HTTP/acpx wrapper | Deferred | API boundary should be verified before implementation. |
| Paperclip | HTTP wrapper | Deferred | API/source boundary should be verified before implementation. |

## Implementation Rule

Each adapter must ship with:

- A runtime-mode manifest (provider/runtime/runtime-mode/model distinctions must be explicit).
- Doctor check.
- Adapter contract test.
- Raw transcript capture.
- Event normalization map.
- Cancellation behavior.
- Artifact extraction behavior.
- Placement-policy facts for local, hosted, and hybrid execution.

Current shipped runtime modes are:

- `fake.deterministic`
- `codex.exec_json`
- `generic_http.async_rest`
