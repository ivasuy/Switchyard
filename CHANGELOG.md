# Changelog

All notable changes to Switchyard will be documented in this file.

## Unreleased

### Added

- Added shipped runtime-mode endpoints: `GET /runtime-modes`, `GET /runtime-modes/:id`, and `POST /runtime-modes/:id/check`.
- Added shipped runtime doctor summary endpoint: `GET /doctor`.
- Added runtime-mode capability and availability contracts for shipped R3 runtime modes `fake.deterministic` and `codex.exec_json`.
- Added persisted runtime-mode records and run/session `runtimeMode` compatibility fields for local SQLite storage.

### Changed

- Updated Codex active runtime checks to forward optional-check probe diagnostics so required-pass plus optional-fail checks surface as `partial` with warning diagnostics.
- Updated daemon active doctor check behavior and smoke coverage to assert partial-state propagation through `POST /runtime-modes/:id/check`, runtime-mode availability snapshots, and `GET /doctor`.
- Updated product and API docs to reflect shipped-tense R3 runtime capability infrastructure and concrete runtime-mode/doctor payload examples.

## 2026-05-30 - Roadmap Release Train R5 ACP Foundation And OpenCode

### Added

- Added private workspace package `@switchyard/protocol-acpx` with ACP JSON-RPC framing, schema helpers, outbound stdio client correlation, named protocol errors, and redacted raw transcript recording.
- Added deterministic fake ACP runtime harness in `@switchyard/testkit` for `happy`, `empty_output`, `prompt_failed`, `cancelled`, `cancel_unverified`, `invalid_json`, `invalid_initialize`, `invalid_session_new`, `permission_request`, `stderr_warning`, and `oversized_message` scenarios.
- Added OpenCode ACP adapter/runtime mode `opencode.acp` with bounded doctor checks (`opencode --version`, ACP initialize/session-new), normalized event mapping, verified cancellation semantics, and transcript artifact capture.
- Added daemon OpenCode ACP config/wiring (`SWITCHYARD_OPENCODE_COMMAND`, `SWITCHYARD_ACP_REQUEST_TIMEOUT_MS`, `SWITCHYARD_ACP_CANCEL_TIMEOUT_MS`, `SWITCHYARD_ACP_MAX_MESSAGE_BYTES`) plus runtime-mode seeding for `provider_opencode`/`runtime_opencode`/`model_opencode_default`.
- Added OpenCode local adapter guide at `docs/development/adapters/OPENCODE.md`.

### Changed

- Updated runtime-mode inference to map `runtime: "opencode"` + `adapterType: "acpx"` -> `runtimeMode: "opencode.acp"` with strict mismatch/internal-id validation.
- Updated runtime doctor custom-availability mapping and sanitization for ACP/OpenCode checks, including partial `opencode_stderr_warning` handling.
- Updated public cancel behavior to persist transcript artifacts after verified cancellation and keep protocol-failure cancellation honest (`409 adapter_protocol_failed` with `reasonCode` details).
- Updated daemon smoke coverage to include OpenCode runtime-mode discovery/check, no-prompt doctor assertions, run/input/cancel protocol behavior, and artifact retrieval for completed/cancelled/failed/timeout paths.

## 2026-05-30 - Roadmap Release Train R4 Shared Runtime Substrates And Generic HTTP

### Added

- Added shared runtime substrates in `@switchyard/adapters` for process execution, JSONL event parsing, transcript recording, and timeout helpers reused by Codex and Generic HTTP adapters.
- Added `@switchyard/testkit` fake Generic HTTP runtime server plus a reusable runtime adapter contract harness.
- Added `generic_http.async_rest` runtime mode and adapter implementation with bounded health/start/status/events/cancel/artifacts handling, transcript artifact capture, and daemon configuration/env wiring.
- Added Generic HTTP development guide (`docs/development/adapters/GENERIC_HTTP.md`) and local smoke coverage for Generic HTTP runtime-mode and run lifecycle paths.

### Changed

- Updated runtime-mode contracts and registry inference to support `runtime: generic_http` + `adapterType: http` -> `runtimeMode: generic_http.async_rest`, with strict mismatch validation.
- Updated core runtime doctor checks to support adapter-provided `http_health` availability mapping (including sanitized diagnostics) without requiring Codex-style version/model fields.
- Updated run cancellation semantics to be verified-terminal for Generic HTTP and idempotent for already terminal runs, and to preserve run state when adapters return protocol failures.
- Updated REST run routes to map generic adapter protocol failures (`AdapterProtocolError`) to `409 adapter_protocol_failed` for input/cancel protocol constraints.

## 2026-05-29 - Roadmap Release Train R0-R2 Reconciliation

### Added

- Added `GET /runs` list endpoint with `status`, `runtime`, `provider`, `model`, `placement`, `adapterType`, `since`, `until`, `limit`, and opaque `before` cursor filters. Newest-first, cursor-paginated.
- Added registry list endpoints `GET /providers`, `GET /runtimes`, and `GET /models` with cursor pagination plus provider/adapter filters.
- Added global artifact lookup endpoints `GET /artifacts/:id` (metadata) and `GET /artifacts/:id/content` (raw bytes; `transcript` artifacts are served as `application/x-ndjson`).
- Added open-ended local SSE streaming on `GET /runs/:id/events?live=1`: 15-second heartbeat, 5-minute idle close with a `stream.idle` marker, and `Last-Event-ID` resumption across replay-only, bounded, and live modes. The bounded `live=1&stopAfter=N` mode is preserved for deterministic tests.
- Added an SSE connection-cleanup leak test in `apps/daemon` to verify per-connection unsubscribe and FD release.
- Added local Codex `exec --json` run support with model/reasoning metadata mapping, model catalog validation, JSONL event normalization, transcript artifacts, and CI-safe adapter coverage.
- Added daemon runtime logs for run start/completion, Codex child process PID, stderr snippets, first stdout detection, runtime output, timeout, and startup reconciliation.
- Added `response.text` and `response.outputs` to `POST /runs?wait=1` responses so curl callers see the final model answer without a second request.
- Added development documentation under `docs/development/`, including generic local startup/debugging commands and Codex-specific curls, PID checks, SQLite inspection, and stuck-run diagnosis.
- Added runtime capability infrastructure: runtime-mode contracts/records, runtime manifests, bounded runtime doctor checks, and local runtime capability inspection APIs (`GET /runtime-modes`, `GET /runtime-modes/:id`, `POST /runtime-modes/:id/check`, `GET /doctor`).
- Added persisted runtime-mode storage (`runtime_modes` table) plus nullable `runtime_mode` compatibility columns on runs and runtime sessions.

### Changed

- **BREAKING:** Standardized the daemon error contract. Every 4xx and 5xx response now uses the envelope `{ error: { code, message, details? } }` with a closed code set (`run_not_found`, `artifact_not_found`, `missing_artifact_content`, `provider_not_found`, `runtime_not_found`, `runtime_mode_not_found`, `model_not_found`, `invalid_input`, `invalid_query`, `adapter_protocol_failed`, `internal_error`). Callers that relied on the previous default Fastify `{message, error, statusCode}` shape on any 4xx/5xx response must be updated.
- Refocused the README as a product-facing overview and moved detailed local development commands into dedicated development docs.
- Centralized local developer docs around an official API contract, a local operations guide, and a Codex-only debugging appendix.
- Updated architecture and adapter docs to describe the implemented Codex non-interactive local adapter path.
- Ignored local Switchyard data directories and local agent runtime state.

### Fixed

- Closed Codex child stdin immediately after spawning so `codex exec --json` does not wait indefinitely after printing `Reading additional input from stdin...`.
- Terminalized timed-out and interrupted runs so daemon restarts do not leave persisted runs stuck in `running`.

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
- Added `@switchyard/daemon` local gateway app wired to Fastify, SQLite-backed stores, filesystem artifact content storage, the core run service, and the fake runtime adapter.
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
- Added `@switchyard/adapters` with a Codex `exec --json` runtime adapter, local model catalog discovery, JSONL event normalization, transcript artifact capture, and daemon registry wiring.

### Changed

- Expanded `.gitignore` to keep generated artifacts, dependencies, caches, environment files, logs, editor files, `docs/decisions`, and `docs/superpowers` out of the repository.
- Updated the daemon dev script to suppress Node 26's upstream `tsx` `DEP0205` warning while keeping other process warnings visible.
