# Changelog

All notable changes to Switchyard will be documented in this file.

## 0.1.0 - 2026-05-11

### Added

- Initialized the Switchyard TypeScript monorepo with pnpm workspaces and Turborepo.
- Added strict shared TypeScript, Vitest, and editor configuration.
- Added `@switchyard/contracts` with Zod schemas and inferred types for runs, sessions, debates, events, messages, artifacts, approvals, memory, evidence, tools, registry records, placement, nodes, users, budgets, context, and errors.
- Added `@switchyard/core` with protocol-neutral ports and initial service shells for runs, events, sessions, debates, messages, artifacts, approvals, memory, evidence, tools, registry, placement, and context building.
- Added `@switchyard/testkit` with deterministic fake runtime adapters, in-memory stores, and fixtures for contract-first development.
- Added root workspace scripts for build, test, typecheck, and lint.
- Added public architecture documentation with repository shape, deployment modes, protocol choices, remote-node control, and package responsibilities.
- Added adapter research and verification docs for OpenCode, Claude Code, Codex, Cursor Agent, AgentField, Generic HTTP, OpenClaw, and Paperclip.
- Added `@switchyard/protocol-rest` with initial run routes for `POST /runs`, `GET /runs/:id`, and `GET /runs/:id/events`.
- Added `@switchyard/daemon` local gateway app wired to Fastify, in-memory stores, the core run service, and the fake runtime adapter.
- Added core run start behavior that drives a runtime adapter, stores normalized events, and updates completed/failed run state.
- Added `RuntimeRunnerService` as the runtime-facing execution boundary for adapter start, input, cancellation, session records, and event normalization.
- Added runtime session lookup support and in-memory session store support for adapter lifecycle tests.
- Added REST lifecycle endpoints for `POST /runs/:id/input` and `POST /runs/:id/cancel`.
- Added local SQLite-backed run, event, session, and artifact stores.
- Added local SQLite-backed message, approval, registry, and placement-decision stores.
- Added filesystem artifact content storage for local daemon mode.
- Added `GET /runs/:id/artifacts`.
- Added registry lookup routes for providers, runtimes, and models.
- Added `@switchyard/protocol-sse` for replay and live run event streams.
- Added async run launch support for local daemon execution.
- Added required-field negative contract coverage for public schemas.

### Changed

- Expanded `.gitignore` to keep generated artifacts, dependencies, caches, environment files, logs, editor files, `docs/decisions`, and `docs/superpowers` out of the repository.
- Updated the daemon dev script to suppress Node 26's upstream `tsx` `DEP0205` warning while keeping other process warnings visible.
