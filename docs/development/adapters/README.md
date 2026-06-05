# Adapter Local Development

Each adapter gets one focused local development guide with runtime settings, process checks, and debugging notes. Endpoint curls and response shapes live in the centralized [Official API Contract](../API.md).

| Adapter | Guide | Status |
| --- | --- | --- |
| Claude Code | [CLAUDE_CODE.md](CLAUDE_CODE.md) | Implemented for local bounded interactive SDK-mode runs (`claude_code.sdk`). |
| Codex | [CODEX.md](CODEX.md) | Implemented for local non-interactive `codex exec --json` runs. |
| AgentField | [AGENTFIELD.md](AGENTFIELD.md) | Implemented for local configured async REST wrapper runs (`agentfield.async_rest`). |
| Generic HTTP | [GENERIC_HTTP.md](GENERIC_HTTP.md) | Implemented for local configured async REST wrapper runs (`generic_http.async_rest`). |
| OpenCode ACP | [OPENCODE.md](OPENCODE.md) | Implemented for local ACP subprocess runs (`opencode.acp`). |
