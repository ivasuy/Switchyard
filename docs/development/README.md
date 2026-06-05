# Development Documentation

This directory is the local developer center for Switchyard. Start here when you need to know what the app can do today.

## Read In This Order

1. [Product Truth](../../PRODUCT.md): current shipped surface, release roadmap, and owner-facing release checklist.
2. [Official API Contract](API.md): implemented HTTP endpoints, request bodies, response shapes, event semantics, and current limitations.
3. [Local Development](DEVELOPMENT.md): install, start the daemon, health checks, local storage, process checks, and verification commands.
4. [Codex Adapter Local Development](adapters/CODEX.md): Codex-specific metadata, healthy log shape, PID checks, and stuck-run diagnosis.
5. [Architecture](../../ARCHITECTURE.md): system boundaries, package responsibilities, implemented local MVP, and planned layers.

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

- `PRODUCT.md` is the owner-facing product truth and release roadmap.
- `README.md` is product-facing.
- `ARCHITECTURE.md` is the centralized system and target architecture.
- `docs/development/API.md` is the centralized app-facing API contract.
- `docs/development/DEVELOPMENT.md` is the centralized local operations guide.
- `docs/development/adapters/` contains runtime-specific debugging notes only.
