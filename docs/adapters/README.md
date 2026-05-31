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

## R17 Tool Adapter Slice

R17 ships local-daemon tool adapters behind `POST /tools/invocations` only.

| Tool adapter | Status | Boundary |
| --- | --- | --- |
| `fake_echo` | Shipped | deterministic/no-spend baseline tool |
| `fetch` | Shipped (local daemon) | allowlisted hosts, GET/HEAD only, bounded redirects/bytes/content types, private-network denied |
| `web_search` | Shipped (local daemon) | provider/base URL configured explicitly, bounded results/bytes, no hosted/node execution |
| `github` | Shipped (local daemon) | read-only allowlisted repos; no mutation operations |
| `repo` | Shipped (local daemon) | read-only git inspection via bounded local process executor |
| `shell` | Shipped (local daemon) | command-catalog only (`commandId`), no raw shell strings/interpolation |
| `browser` | Unshipped in R17 | policy-denied (`browser_tool_unshipped`) |

Unshipped for R17: hosted real tools, connected-node real tools, generic process/PTY execution adapters, Cursor/OpenClaw/Paperclip tool adapters, and public `/exec`/`/terminal`/`/pty`/`/sandbox`/`/tools/search` execution surfaces.

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
