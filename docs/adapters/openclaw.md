# OpenClaw Adapter

## Target

OpenClaw is a wrapper runtime target. Switchyard should treat it as one runtime endpoint even if OpenClaw internally routes to multiple agents.

## Preferred Protocol

- HTTP, WebSocket, or ACP/acpx depending on the stable API boundary.

## Implementation Notes

- Do not couple Switchyard internals to OpenClaw internals.
- Normalize OpenClaw sessions into Switchyard runs.
- Preserve wrapper transcript and downstream artifacts.

## Status

Deferred until the API boundary is verified.
