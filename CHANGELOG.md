# Changelog

All notable changes to Switchyard will be documented in this file.

## Unreleased

### Added

- Added `@switchyard/sdk` package with `SwitchyardClient` methods for health/doctor, run lifecycle, replay/live run events, artifact metadata/content, and registry/runtime-mode discovery/checks.
- Added SDK typed errors: `SwitchyardHttpError`, `SwitchyardNetworkError`, `SwitchyardDecodeError`, `SwitchyardTimeoutError`, `SwitchyardValidationError`, and `SwitchyardStreamError`.
- Added `@switchyard/cli` package with `switchyard` commands: `doctor`, `daemon start`, `run fake`, `runtime test`, `debug run`, and `contract export`.
- Added deterministic local daemon route inventory and OpenAPI generation/check in `@switchyard/contracts` (`openapi:generate`, `openapi:check`).
- Added `/metrics` endpoint with request/error counters, run-status counts, and startup-recovery counters.
- Added SQLite schema metadata version recording plus additive-migration policy helpers and zero-byte/corrupt-file guards.
- Added adapter compatibility matrix generation in no-spend mode through `generateCompatibilityMatrix`.
- Added shipped runtime-mode endpoints: `GET /runtime-modes`, `GET /runtime-modes/:id`, and `POST /runtime-modes/:id/check`.
- Added shipped runtime doctor summary endpoint: `GET /doctor`.
- Added runtime-mode capability and availability contracts for shipped R3 runtime modes `fake.deterministic` and `codex.exec_json`.
- Added persisted runtime-mode records and run/session `runtimeMode` compatibility fields for local SQLite storage.
- Added R14 hosted sandbox substrate contracts (`sandbox.ts`), core hosted sandbox service/policy/config/readiness helpers, deterministic fake hosted sandbox executor, and no-spend smoke command (`pnpm sandbox:smoke`).
- Added hosted app readiness/metrics sandbox diagnostics (`checks.sandbox` and low-cardinality `sandbox` counters) while keeping fake-only hosted runtime execution boundaries.
- Added R15 hosted real-runtime execution catalog and policy gates for `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` with explicit operator opt-in (`SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`) and production fail-closed posture.
- Added worker hosted adapter construction for allowlisted `CodexExecJsonAdapter`, `ClaudeCodeAdapter`, and `OpenCodeAcpAdapter` with no-spend fake-factory seams and hosted-safe logger redaction.
- Added no-spend hosted real-runtime smoke command (`pnpm hosted-real-runtime:smoke`) and OpenAPI guard assertions that keep `/sandbox`, `/exec`, `/pty`, and `/terminal` absent from the public contract.
- Added explicit local-only `codex.interactive` runtime mode behind the existing runtime adapter contract, including bounded post-start text input, session-state patch persistence (`codexThreadId`), session resume flow, and capped/redacted raw+normalized transcript artifacts.
- Added `CodexAdapterRouter` so omitted Codex mode still dispatches to `codex.exec_json` while explicit `runtimeMode: "codex.interactive"` dispatches to interactive behavior.
- Added deterministic no-spend fake Codex interactive session factory coverage, daemon smoke for interactive input/approval paths, and compatibility matrix coverage for `codex.interactive`.
- Added runtime approval expiration/startup reconciliation and terminalization hooks (`timeout`, `cancel`, `run.failed`, `daemon_restarted`) so runtime approvals cannot remain pending after terminal outcomes.

### Changed

- Updated HTTP error envelope contracts to include optional `requestId` and expanded error-code parity with protocol-rest middleware/tool/approval routes.
- Updated protocol-rest error responses to emit `x-request-id` and include `error.requestId` in structured envelopes.
- Updated daemon startup reconciliation to cover `starting`, `running`, `waiting_for_input`, and `waiting_for_approval` states with idempotent recovery counters.
- Updated daemon main entrypoint to export reusable `startDaemon()` helper used by CLI command flows.
- Updated Codex active runtime checks to forward optional-check probe diagnostics so required-pass plus optional-fail checks surface as `partial` with warning diagnostics.
- Updated daemon active doctor check behavior and smoke coverage to assert partial-state propagation through `POST /runtime-modes/:id/check`, runtime-mode availability snapshots, and `GET /doctor`.
- Updated product and API docs to reflect shipped-tense R3 runtime capability infrastructure and concrete runtime-mode/doctor payload examples.
- Updated hosted server/worker config parsing to include `SWITCHYARD_SANDBOX_*` contract validation and redacted summaries.
- Updated hosted worker readiness shape to preserve `ok` compatibility while exposing optional `checks.sandbox` diagnostics.
- Updated hosted run placement and worker claim revalidation to require closed runtime catalog matches, explicit hosted placement for real modes, hosted wait denial (`hosted_wait_unsupported`), durable-row revalidation, and Codex read-only sandbox metadata enforcement.
- Updated hosted server/worker config parsing with closed allowlist validation and `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION` gate validation including production-forbidden error codes.
- Updated run input/cancel route guards for hosted real runs so unsupported bridges fail visibly (`hosted_input_unsupported`, `hosted_cancel_unsupported`) without silently dropping interaction requests.
- Updated `RuntimeRunnerService` to preserve adapter `reasonCode` on `run.failed`, pass `runtimeMode` into adapter sessions for send/cancel/events/artifacts dispatch, reject same-session concurrent input with `runtime_input_in_flight`, and omit raw `runtime.output` text from logs.
- Updated run create route boundaries for interactive Codex: `POST /runs?wait=1` + `runtimeMode: "codex.interactive"` now fails fast with `interactive_wait_unsupported`, and hosted placement for local-only interactive modes fails with `hosted_runtime_not_allowed`.
- Updated OpenAPI contract guard tests to reject additional arbitrary-execution tokens (`/shell`, `/process`, `/command`) while keeping shipped middleware tool routes intact.

## 2026-05-31 - Roadmap Release Train R20 Production Subprocess/PTY Sandbox Foundation

### Added

- Added root no-spend production sandbox smoke command: `pnpm production:sandbox-smoke`.
- Added deterministic `scripts/production-sandbox-smoke.test.ts` coverage for process, PTY, denial, timeout, cancel, output-limit, artifact capture, transcript redaction, readiness gates, and both local/hosted OpenAPI no-route boundaries.
- Added hosted sandbox smoke report/assertion coverage for disabled-by-default real execution posture plus fail-closed `sandbox_policy_missing` behavior when real execution is enabled without policy.

### Changed

- Updated product truth/docs for R20 to mark production subprocess/PTY sandbox as an internal hosted-worker substrate with policy-first handoff and fail-closed PTY driver boundaries.
- Updated API/development/production operator docs with `production:sandbox-smoke`, explicit preflight references, and safe default environment posture for real execution.

### Safety Boundaries

- R20 does not ship public arbitrary execution routes (`/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, `/sandbox`).
- R20 does not ship production hosted Codex/Claude/OpenCode execution, hosted real tools, browser automation, Cursor/OpenClaw/Paperclip adapters, dashboard/TUI, or hosted debate participant runtime execution.

## 2026-05-30 - Roadmap Release Train R13 S3/R2 Object-Store Client Wiring

### Added

- Added real S3-compatible object client wiring in `@switchyard/storage` using official AWS SDK v3 S3 primitives with explicit static Switchyard credentials.
- Added shared server/worker object-store resolver and factory with `SWITCHYARD_OBJECT_STORE_BACKEND=memory|local|s3-compatible`, endpoint/prefix/timeout/probe validation, and redacted summaries.
- Added object-store probe support (`write_read_delete`) for local and S3-compatible backends and readiness integration.
- Added deterministic storage tests for S3 client command mapping, body-shape conversion, timeout/auth/bucket/read failure mapping, and config parsing behavior.

### Changed

- Updated runtime artifact persistence to preserve `contentStored`, `storageBackend`, `objectKey`, `sizeBytes`, `sha256`, and `contentType` metadata for runtime-produced artifacts.
- Updated hosted server and worker wiring to consume shared object-store config/factory while preserving fake-only hosted runtime boundaries.
- Updated artifact content route error mapping to return safe public 503 object-store errors and 409 integrity errors without secret-bearing diagnostics.
- Updated hosted metrics to include low-cardinality object-store counters (`reads`, `writes`, `failures`, `probeFailures`, `authFailures`, `unavailable`, `digestMismatches`).
- Updated product/development docs and self-hosted `.env.example` with explicit S3/R2-compatible configuration guidance.

### Safety Boundaries

- Hosted worker execution remains fake-only (`fake.deterministic`); non-fake hosted runtime/mode requests are denied and do not execute work.
- Required checks remain no-spend; no required test contacts AWS, Cloudflare R2, MinIO, Docker, or external paid networks.

## 2026-05-30 - Roadmap Release Train R9 Debate V1

### Added

- Added local fake deterministic debate workflow routes: `POST /debates`, `POST /debates?wait=1`, `GET /debates/:id`, and `GET /debates/:id/events`.
- Added debate persistence (`debates` table + indexes) with additive SQLite migration and `SqliteDebateStore`.
- Added `DebateService` orchestration for bounded two-participant fake debates using existing run/message/evidence/event/artifact primitives.
- Added debate-aware message routing metadata (`debateId`, `participantId`) and `MessageRouter.createWithEvent`.
- Added debate-scoped event/artifact listing APIs in storage and ports (`EventStore.listByDebate`, `ArtifactStore.listByDebate`).
- Added deterministic judge output and final markdown report artifact generation (`summary` type) at `debates/<debateId>/final-report.md`.
- Added debate SSE filtering support through generic entity event streaming helpers.

### Changed

- Updated HTTP error contracts/mapping to include `debate_not_found` while preserving `evidence_not_found`.
- Updated daemon wiring to include shared debate service dependencies and debate routes in both in-memory and configured storage modes.
- Updated product and development docs to mark R9 as shipped fake-only debate and document no-spend smoke + negative checks.

## 2026-05-30 - Roadmap Release Train R8 Interactive Coding Runtimes

### Added

- Added `claude_code.sdk` runtime mode (`native`, `sdk`) with local conditional placement, post-start input support, session-state patch support, approval bridge capability, normalized tool-call/tool-result capability, and user-question capability.
- Added Claude Code adapter implementation (`packages/adapters/src/claude-code/*`) with deterministic event mapping, bounded unknown-event suppression, raw and normalized transcript artifacts, and approval-resolution input support.
- Added Claude Code fake testkit fixtures (`fake-claude-code-client`, `fake-claude-code-cli`) and contract/runtime tests for no-spend-first interactive behavior.
- Added daemon Claude wiring/config (`SWITCHYARD_CLAUDE_CODE_COMMAND`, `SWITCHYARD_CLAUDE_CODE_LIVE_PROBE`, `SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD`, `SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS`) plus runtime-mode registry seeding.
- Added runtime capability literals for interactive behavior: `run.input`, `session.state`, `session.resume`, `approval.bridge`, `tool.call.normalized`, `tool.result.normalized`, and `user.question`.

### Changed

- Updated `RuntimeRunnerService` to persist waiting states (`waiting_for_input`, `waiting_for_approval`), merge bounded `sessionStatePatch` updates, and bridge runtime approval pauses to the existing approval store.
- Updated core and REST input behavior with explicit bounded failure reasons (`runtime_input_not_active`, `runtime_session_missing`, `runtime_input_empty`, `runtime_input_too_large`) and public 64 KiB request-body validation for `POST /runs/:id/input`.
- Updated `ApprovalService` to optionally send runtime `approval_resolution` callbacks for runtime-linked approvals while preserving one-shot approval semantics.
- Updated middleware approval routes to accept optional `answers` payloads and map runtime callback protocol failures to `409 adapter_protocol_failed`.
- Updated daemon default Claude runtime client wiring to a structured local stream-json CLI path instead of an always-unconfigured placeholder client.
- Updated `claude_code.sdk` runtime claims to remove `session.resume`; session resume remains deferred.
- Updated Codex docs/limitations wording for R8 while preserving `codex.exec_json` one-shot behavior and explicitly deferring interactive runtime promotion.
- Updated product/development/API adapter docs to reflect shipped R8 boundaries, no-spend doctor defaults, and optional bounded live-probe behavior.

## 2026-05-30 - Roadmap Release Train R7 Middleware Foundation

### Added

- Added durable local middleware APIs: `messages`, `memory`, `evidence`, `context`, `approvals`, and `tools/invocations`.
- Added SQLite middleware tables/indexes and stores for `memory_items`, `evidence_items`, and `tool_invocations`; extended message/approval stores with list filters and cursor pagination.
- Added in-memory middleware stores in `@switchyard/testkit` and deterministic `FakeEchoToolAdapter`.
- Added core middleware services: `MessageRouter`, `MemoryService`, `EvidenceService`, `ContextBuilder`, `ApprovalService`, `ToolRouter`, and `LocalPolicyGate`.
- Added optional `POST /runs` context path that stores rendered task plus `metadata.originalTask` and `metadata.contextPacket`.

### Changed

- Updated tool contracts to include `fake_echo`, invocation `approvalId`, and invocation `error` payloads.
- Updated event contracts with approval lifecycle events (`approval.approved`, `approval.rejected`, `approval.expired`).
- Updated HTTP error surface for middleware not-found/conflict/policy-denied outcomes.
- Updated approval/tool flow to one-shot transitions so duplicate approve/reject does not duplicate terminal tool events.
- Updated docs/product truth to mark R7 as shipped and document boundaries: substring-only memory search, no remote evidence fetch, fake_echo-only execution, real-tool policy denial before adapter dispatch, and context packet persistence limits.

## 2026-05-30 - Roadmap Release Train R6 Wrapper Runtime Integration

### Added

- Added `agentfield.async_rest` runtime adapter/mode with daemon-level AgentField configuration, async execute/status polling, normalized event mapping, and runtime-mode doctor availability checks.
- Added AgentField daemon env config support: `SWITCHYARD_AGENTFIELD_BASE_URL`, `SWITCHYARD_AGENTFIELD_API_KEY`, `SWITCHYARD_AGENTFIELD_TARGET`, `SWITCHYARD_AGENTFIELD_REQUEST_TIMEOUT_MS`, `SWITCHYARD_AGENTFIELD_POLL_INTERVAL_MS`, and `SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES`.
- Added deterministic fake AgentField control-plane server + CLI in `@switchyard/testkit` and local script `pnpm --filter @switchyard/testkit fake-agentfield`.
- Added AgentField transcript and result artifacts for completed/failed/timeout flows, including upstream execution id metadata.
- Added AgentField local adapter guide at `docs/development/adapters/AGENTFIELD.md`.

### Changed

- Updated runtime-mode inference and validation to map `runtime: "agentfield"` + `adapterType: "http"` to `agentfield.async_rest` and reject internal runtime-mode ids in public payloads.
- Updated daemon registry/runtime-mode seeding to include `provider_agentfield`, `runtime_agentfield`, and `model_agentfield_default`.
- Updated public protocol behavior so active AgentField cancel returns `409 adapter_protocol_failed` with `reasonCode: agentfield_cancel_unsupported`, and post-start input returns `agentfield_input_unsupported`.
- Updated failure mapping and security handling so network/fetch failures emit `agentfield_request_failed`, upstream failed terminal status emits `agentfield_status_failed`, and API keys are redacted from checks, events, logs, transcripts, and artifacts.

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

## 2026-05-30 - Roadmap Release Train R10 Hosted And Hybrid Execution

### Added

- Added hosted-like `@switchyard/server`, hosted `@switchyard/worker`, and connected local `@switchyard/node` apps.
- Added node protocol package (`@switchyard/protocol-node`) with register/heartbeat/claim/reject/event-sync/artifact-sync/complete endpoints and client helper.
- Added queue package (`@switchyard/queue`) with deterministic `MemoryRunQueue` and opt-in Redis/BullMQ-backed `BullMqRunQueue`.
- Added Postgres-backed storage classes for runs/events/sessions/artifacts/registry/placement/nodes/assignments, plus memory and filesystem-backed object-compatible artifact content stores.
- Added core hosted/hybrid services: placement, hosted run orchestration, hosted worker safety checks, node coordination, local node policy gating, event sync, and artifact sync.

### Changed

- Preserved the public run/artifact contract across local daemon and hosted-like execution paths.
- Expanded HTTP error code mapping for placement/node/sync failures.
- Updated fake runtime placement facts to support hosted-safe and connected-node fake execution in R10 smoke paths.

### Safety Boundaries

- Hosted worker execution is fake-only (`fake.deterministic`) and re-validates durable run state at claim time.
- Local-only runtime modes remain denied for hosted placement.
- Hosted arbitrary subprocess/PTY/tooling/debate-model-judging execution is not shipped.
- S3/R2 network object-store wiring is not shipped; `SWITCHYARD_OBJECT_STORE_DIR` provides the opt-in durable object-compatible store for R10.
