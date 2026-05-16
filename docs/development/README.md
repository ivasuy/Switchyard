# Development Documentation

This directory is the local developer center for Switchyard. Start here when you need to know what the app can do today.

## Read In This Order

1. [Official API Contract](API.md): implemented HTTP endpoints, request bodies, response shapes, event semantics, and current limitations.
2. [Local Development](DEVELOPMENT.md): install, start the daemon, health checks, local storage, process checks, and verification commands.
3. [Codex Adapter Local Development](adapters/CODEX.md): Codex-specific metadata, healthy log shape, PID checks, and stuck-run diagnosis.
4. [Architecture](../../ARCHITECTURE.md): system boundaries, package responsibilities, implemented local MVP, and planned layers.

## Current Local MVP

Today an app can:

- Start a local Codex run with `POST /runs`.
- Start and wait for a local Codex run with `POST /runs?wait=1`.
- Read the final answer from `response.text`.
- Inspect full run events with `GET /runs/:id`.
- Replay SSE-formatted events with `GET /runs/:id/events`.
- Fetch transcript artifacts with `GET /runs/:id/artifacts`.
- Cancel a run with `POST /runs/:id/cancel`.
- Check seeded provider, runtime, and model records by ID.

Today an app cannot yet:

- List runs.
- Fetch a single artifact by ID.
- Use a full trace endpoint.
- Use open-ended live SSE.
- Use interactive Codex input after start.
- Run debates, approvals, memory, tools, hosted workers, dashboard, or TUI.

## Document Ownership

- `README.md` is product-facing.
- `ARCHITECTURE.md` is the centralized system architecture.
- `docs/development/API.md` is the centralized app-facing API contract.
- `docs/development/DEVELOPMENT.md` is the centralized local operations guide.
- `docs/development/adapters/` contains runtime-specific debugging notes only.
