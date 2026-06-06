# Adapter Local Development

Each adapter gets one focused local development guide with runtime settings, process checks, and debugging notes. Endpoint curls and response shapes live in the centralized [Official API Contract](../API.md).

| Adapter | Guide | Status |
| --- | --- | --- |
| Claude Code | [CLAUDE_CODE.md](CLAUDE_CODE.md) | Implemented for local bounded interactive SDK-mode runs (`claude_code.sdk`) plus the R23 hosted bridge boundary. |
| Codex | [CODEX.md](CODEX.md) | Implemented for local one-shot `codex.exec_json` and explicit local-only `codex.interactive`; hosted Codex input/approval remains unsupported. |
| AgentField | [AGENTFIELD.md](AGENTFIELD.md) | Implemented for local configured async REST wrapper runs (`agentfield.async_rest`) plus conditional R25 hosted wrapper bridges. |
| Generic HTTP | [GENERIC_HTTP.md](GENERIC_HTTP.md) | Implemented for local configured async REST wrapper runs (`generic_http.async_rest`) plus conditional R25 hosted wrapper bridges. |
| OpenCode ACP | [OPENCODE.md](OPENCODE.md) | Implemented for local ACP subprocess runs (`opencode.acp`) plus the R23 hosted bridge boundary. |
| Cursor Agent | [CURSOR.md](CURSOR.md) | Scaffolded as `cursor.agent_stream_json` with manifest/check coverage; execution is blocked pending auth and stream fixtures. |
| OpenClaw | [OPENCLAW.md](OPENCLAW.md) | Scaffolded as `openclaw.async_rest` with manifest/check coverage; execution is blocked pending API fixtures. |
| Paperclip | [PAPERCLIP.md](PAPERCLIP.md) | Scaffolded as `paperclip.async_rest` with manifest/check coverage; execution is blocked pending API/source fixtures. |
