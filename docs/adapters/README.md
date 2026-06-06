# Adapter Research

This directory records runtime adapter facts before implementation and tracks implementation status as slices ship.

## Adapter Status

| Adapter | Preferred path | Status | Notes |
| --- | --- | --- | --- |
| OpenCode | ACP/acpx | Verified candidate | `opencode acp` initialized successfully locally. |
| Claude Code | SDK or stream-json CLI | Shipped local + hosted bridge slice | Hosted debate use depends on the R23 hosted runtime bridge command/payload stores. |
| Codex | `codex exec --json` | Shipped one-shot slice | `codex.exec_json` remains one-shot; hosted `codex.interactive` and hosted Codex live-resume remain unshipped. |
| Cursor Agent | stream-json CLI | Scaffolded, execution blocked | `cursor.agent_stream_json` manifest/check exists; local status check previously hit credential/keychain failure, and stream fixtures are still required before execution. |
| AgentField | async REST / CLI | Shipped local + conditional hosted wrapper bridge slice | Hosted input/approval and debate participant bridges require hosted placement, provider activation, wrapper config/capability, bridge stores, queue, object store, ownership, quota, audit, and worker readiness. |
| Generic HTTP | HTTP async REST | Shipped local + conditional hosted wrapper bridge slice | Runtime mode `generic_http.async_rest` is implemented locally; hosted input/approval and debate participant bridges use the same conditional wrapper gate set. |
| OpenClaw | HTTP/acpx wrapper | Scaffolded, execution blocked | `openclaw.async_rest` manifest/check exists; API boundary fixtures are required before execution. |
| Paperclip | HTTP wrapper | Scaffolded, execution blocked | `paperclip.async_rest` manifest/check exists; API/source fixtures are required before execution. |

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

Current unshipped adapter/tool surfaces: generic process/PTY execution adapters, executable Cursor/OpenClaw/Paperclip runtime integration beyond manifest/check scaffolds, browser automation, hosted `repo` execution, hosted Codex interactive, dashboard/TUI surfaces, managed SaaS/billing/OAuth/SSO/SCIM, public model judge routes, and public `/exec`/`/terminal`/`/pty`/`/sandbox`/`/tools/search` execution surfaces.

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
- `codex.interactive` (local-only; hosted unshipped)
- `claude_code.sdk`
- `generic_http.async_rest`
- `agentfield.async_rest`
- `opencode.acp`

Current scaffolded adapter runtime modes are:

- `cursor.agent_stream_json` (manifest/check only; execution blocked pending auth and stream fixtures)
- `openclaw.async_rest` (manifest/check only; execution blocked pending API fixtures)
- `paperclip.async_rest` (manifest/check only; execution blocked pending API/source fixtures)

R25 hosted debate participant runtime modes are limited to:

- `fake.deterministic`
- `codex.exec_json` (one-shot)
- `claude_code.sdk` (R23 hosted bridge store required)
- `opencode.acp` (R23 hosted bridge store required)
- `agentfield.async_rest` (R25 wrapper bridge gates required)
- `generic_http.async_rest` (R25 wrapper bridge gates required)

Wrapper-hosted AgentField and Generic HTTP participants are not arbitrary endpoint execution. They require hosted placement, `realRuntimeOptIn`, provider activation/spend gates, daemon/operator wrapper config, advertised input/approval bridge capabilities, durable command/payload stores, queue/outbox, object store, ownership, quota, audit, and worker readiness.
