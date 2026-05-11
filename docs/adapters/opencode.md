# OpenCode Adapter

## Target

OpenCode should be the first real structured runtime adapter because it exposes an ACP server path.

## Preferred Protocol

- Primary: ACP/acpx through `opencode acp`.
- Fallback: CLI/process only if ACP is unavailable.

## Verified Local Facts

- Binary: `/opt/homebrew/bin/opencode`
- Version: `1.3.15`
- ACP initialize succeeded locally.
- `session/new` succeeded and returned a session id and current model.
- `session/prompt` was not run because it could spend model budget.

## Implementation Notes

- Build on `packages/protocol-acpx` outbound client.
- Preserve raw JSON-RPC messages as transcript artifacts.
- Map ACP session updates to normalized Switchyard events.
- Implement cancellation through ACP session cancel.

## Status

Implementation-ready after the ACP client base and fake ACP contract tests exist.
