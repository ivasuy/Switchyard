# PRODUCT.md

Owner-facing product truth for Switchyard.

This document answers: what exists in the system right now, what can be used, what cannot be used yet, and what must be verified before a release. It is intentionally different from `CHANGELOG.md`.

## Document Roles

- `PRODUCT.md`: owner-facing current truth. Read this to know what Switchyard can do today.
- `CHANGELOG.md`: user-facing release history. Read this to know what changed between releases.
- `README.md`: public product overview and positioning.
- `ARCHITECTURE.md`: system reference and target architecture. It intentionally includes planned modules that are not shipped yet.
- `docs/development/API.md`: current local daemon HTTP contract.
- `docs/development/DEVELOPMENT.md`: local setup, smoke commands, inspection, and verification commands.
- `docs/development/adapters/`: runtime-specific local debugging notes.
- `docs/superpowers/specs/`: release specs. Only one future release spec should be active at a time.
- `docs/superpowers/plans/`: release implementation plans. Only one implementation plan should be active at a time.

Specs and implementation plans are not product truth by themselves. A capability is shipped only when this file and the API/development docs say it is usable and locally verifiable.

## Release Planning Rule

Each release should have exactly one active spec and one active implementation plan.

The active release spec should define:

- the user-visible capability being added.
- what becomes usable after the release.
- what is explicitly not included.
- the local verification required before release.
- which docs must be updated when the release ships.

The active implementation plan should define:

- the files and packages to touch.
- task order.
- tests and smoke checks.
- release promotion steps.

When a release ships:

- update `PRODUCT.md` with the new current truth.
- update `CHANGELOG.md` with what changed.
- update `docs/development/API.md` and `docs/development/DEVELOPMENT.md` if the local API or smoke commands changed.
- keep `ARCHITECTURE.md` current as the target-system reference when architecture boundaries change.
- mark or archive the release spec/plan so there is no second active truth.

## Current Snapshot

Snapshot source: `agent/phase-4-r5-acp-foundation-and-opencode`.

Current product state: local daemon MVP with shipped runtime modes `fake.deterministic`, `codex.exec_json`, `agentfield.async_rest`, `generic_http.async_rest`, and `opencode.acp`.

The product is usable locally for one-shot agent runs, event inspection, artifact listing, cancellation, and registry lookups. It is not yet a hosted gateway, debate system, approval system, SDK, dashboard, or multi-runtime production platform.

Important runtime wording: `codex.exec_json` exists as a one-shot non-interactive runtime mode. A full interactive Codex runtime is not shipped yet.

## What Exists Today

### Workspace

The repository is a TypeScript pnpm/Turborepo monorepo with these shipped packages:

- `apps/daemon`: local Fastify daemon.
- `packages/contracts`: Zod schemas and inferred TypeScript types.
- `packages/core`: protocol-neutral ports and runtime lifecycle services.
- `packages/testkit`: fake runtime adapter and in-memory test stores.
- `packages/storage`: SQLite stores and filesystem artifact content storage.
- `packages/protocol-rest`: local REST route groups.
- `packages/protocol-sse`: SSE event formatting and bounded replay/live collection helpers.
- `packages/adapters`: Codex, Generic HTTP, and OpenCode adapters.
- `packages/protocol-acpx`: outbound ACP/acpx protocol framing, schemas, stdio client, and transcript helpers.

### Local Daemon

The local daemon can:

- Start on `127.0.0.1:4545` by default.
- Store local state in SQLite.
- Store artifact content on the filesystem.
- Wire REST routes, event bus, storage, fake runtime, and Codex runtime together.
- Reconcile persisted `running` runs to `failed` on restart.
- Log run start/completion, Codex process PID, stderr snippets, first stdout detection, runtime output, timeout, and startup reconciliation.

### Runs

The run lifecycle supports:

- Creating queued runs.
- Starting runs synchronously with `POST /runs?wait=1`.
- Starting runs asynchronously with `POST /runs`.
- Inspecting a run and its persisted events.
- Sending input when the selected adapter supports it.
- Cancelling active runs.
- Marking timed-out runs terminal.
- Persisting runtime sessions.
- Collecting transcript artifacts after terminal events.
- Publishing normalized events through an in-process event bus.

### Runtimes

Shipped runtime modes:

- `fake.deterministic`: deterministic test runtime mode for local smoke tests and contract coverage.
- `codex.exec_json`: local non-interactive Codex CLI execution through `codex exec --json`.
- `agentfield.async_rest`: daemon-configured AgentField async REST wrapper runtime with bounded health/discovery checks, async execute/status polling, normalized events, transcript artifacts, and result payload artifacts.
- `generic_http.async_rest`: daemon-configured async REST wrapper runtime with bounded health/start/status/events/cancel/artifacts, verified-terminal cancellation, and transcript artifact capture.
- `opencode.acp`: local OpenCode ACP subprocess runtime with bounded doctor check, one-prompt-per-run behavior, verified cancellation, and raw ACP transcript artifacts.

Codex support includes:

- `codex exec --json` child process launch without shell interpolation.
- Closed stdin after spawn so Codex does not wait indefinitely for extra input.
- Local `codex --version` and `codex debug models` probing.
- Model catalog parsing.
- Reasoning effort validation when the local catalog is available.
- Metadata mapping for reasoning effort, reasoning summary, verbosity, sandbox, user config, and rules behavior.
- JSONL stdout parsing into normalized Switchyard events.
- Raw stdout/stderr transcript artifact capture.
- `409` response for post-start input because Codex `exec --json` is one-shot and non-interactive.

R4 shared substrate note:

- Codex and Generic HTTP adapters now share extracted runtime substrates for process/session streaming, JSONL parsing, timeout helpers, and transcript recording while preserving existing public Codex behavior.

### REST API

Implemented local endpoints:

- `GET /health`
- `POST /runs`
- `POST /runs?wait=1`
- `GET /runs`
- `GET /runs/:id`
- `GET /runs/:id/events` (replay-only, `?live=1` open-ended, `?live=1&stopAfter=N` bounded)
- `GET /runs/:id/artifacts`
- `POST /runs/:id/input`
- `POST /runs/:id/cancel`
- `GET /providers`, `GET /providers/:id`
- `GET /runtimes`, `GET /runtimes/:id`
- `GET /models`, `GET /models/:id`
- `GET /runtime-modes`, `GET /runtime-modes/:id`
- `POST /runtime-modes/:id/check`
- `GET /doctor`
- `GET /artifacts/:id`
- `GET /artifacts/:id/content`

Every 4xx and 5xx response uses the unified `{ error: { code, message, details? } }` envelope with a closed code set.

The full current endpoint contract lives in `docs/development/API.md`.

### Events And Artifacts

Current events include:

- `run.queued`
- `run.started`
- `runtime.status`
- `runtime.output`
- `artifact.created`
- `run.completed`
- `run.cancelled`
- `run.failed`

`GET /runs/:id/events` returns SSE-formatted replay. Open-ended local live streaming ships through `?live=1` with a 15-second heartbeat and 5-minute idle close; the bounded `live=1&stopAfter=N` mode is preserved for deterministic tests. Hosted production streaming is still planned (R10).

Completed, cancelled, failed-after-start, and timeout-after-start runs can expose transcript artifacts through `GET /runs/:id/artifacts`, `GET /artifacts/:id` for global metadata lookup, and `GET /artifacts/:id/content` for streaming the raw bytes (transcripts as `application/x-ndjson`).

### Registry

The daemon seeds local registry records for:

- test provider/runtime/model records for the fake runtime.
- OpenAI provider and Codex runtime records.
- AgentField provider/runtime/model records for `agentfield.async_rest`.
- OpenCode provider/runtime/model records for `opencode.acp`.
- Codex model records when `codex debug models` is available.

Both single-record registry lookups and registry list endpoints (`GET /providers`, `GET /runtimes`, `GET /models` with cursor pagination and provider/adapter filters) are shipped. Runtime capability endpoints (`GET /runtime-modes`, `GET /runtime-modes/:id`, `POST /runtime-modes/:id/check`) and runtime doctor summaries (`GET /doctor`) are also shipped.

### Tests And Verification

The current workspace has passing package coverage for:

- contract schema behavior and required-field negatives.
- core run lifecycle, artifact persistence, event sequencing, cancellation, timeout, and event bus behavior.
- fake runtime adapter contract behavior.
- SQLite and filesystem storage behavior.
- REST run and registry routes.
- SSE formatting and bounded replay/live collection.
- Codex catalog parsing, JSONL parsing, process adapter behavior, cancellation, transcript capture, and unsupported input.
- ACP framing/correlation/redaction behavior in `@switchyard/protocol-acpx`.
- OpenCode ACP adapter checks, event mapping, cancellation semantics, and transcript artifacts.
- daemon smoke behavior including runtime-mode checks, OpenCode ACP run/cancel/failure/timeout artifact retrieval, registry seeding, persistence, and restart reconciliation.

## What Does Not Exist Yet

These are planned or designed in docs, but not shipped product:

- Hosted server app.
- Hosted worker app.
- Hybrid local node app.
- Postgres storage.
- Redis/BullMQ queue.
- S3/R2 artifact storage.
- WebSocket protocol package.
- SDK package.
- CLI package.
- Policy package beyond current contracts/ports.
- Claude Code adapter.
- Cursor adapter.
- OpenClaw adapter.
- Paperclip adapter.
- Browser/search adapter.
- Generic process adapter.
- PTY adapter.
- Debate engine.
- Approval workflow beyond contracts/ports/storage.
- Memory APIs.
- Tool APIs.
- Trace endpoint.
- OpenAPI generation.
- Dashboard.
- TUI.
- Hosted (non-local) open-ended SSE streams.
- Interactive Codex sessions.
- Codex approval bridging.
- Hosted Codex execution.

## Release Roadmap

This roadmap is broad by design. Each release should produce a meaningful product capability, not a narrow internal fragment. A release should be large enough to change what Switchyard can do, but small enough that it has one clear verification story.

Every release below should eventually get one active spec and one active implementation plan. The roadmap explains direction and boundaries; the spec/plan pair explains exact execution.

### R0: Current Baseline

Status: shipped. Verified on 2026-05-29 (`codex-org-47c4739e`) against `agent/roadmap-base-20260529` commit `461dea5`.

Goal: freeze what exists today as the baseline for future releases.

Why this release exists:

The current code already has a useful local gateway slice, but the older specs and plans do not accurately communicate what shipped. This baseline names the product as it exists today so future work does not confuse implemented behavior with aspirational architecture.

Release scope:

- local daemon MVP.
- fake runtime mode.
- Codex `exec --json` one-shot runtime mode.
- REST run lifecycle endpoints.
- local SQLite/filesystem persistence.
- run event replay.
- artifact listing.
- provider/runtime/model single-record lookup.
- bounded SSE helper.
- local development and Codex debugging docs.

Usable after this release:

- A developer can start the local daemon, run a fake task, run a one-shot Codex task, inspect events, inspect artifacts, cancel runs, and confirm seeded registry records.
- A developer can verify the shipped surface using `docs/development/DEVELOPMENT.md` and `docs/development/API.md`.

Not included:

- full Codex interactive runtime.
- memory, tools, approval, debate, hosted, hybrid, SDK, or CLI product surfaces.

Local verification shipped:

- full workspace checks pass.
- fake runtime `POST /runs?wait=1` completes.
- Codex `POST /runs?wait=1` can complete with a read-only prompt when Codex is locally available.
- run events and transcript artifacts can be inspected.

Promotion criteria:

- `PRODUCT.md` accurately describes the baseline.
- `docs/development/API.md` documents the shipped local API.
- `docs/development/DEVELOPMENT.md` can be used to reproduce the local smoke path.

### R1: Product Truth And Release Discipline

Status: shipped. Verified on 2026-05-29 (`codex-org-47c4739e`) against `agent/roadmap-base-20260529` commit `461dea5`.

Goal: make release planning and product truth reliable before adding more features.

Why this release exists:

Switchyard now has too many planning artifacts and not enough single-source truth. Before adding more runtime providers or middleware, the repository needs a clean documentation contract: what exists, what is planned, where architecture lives, and how releases are verified.

Release scope:

- create `PRODUCT.md` as the owner-facing truth.
- keep `CHANGELOG.md` focused on user-facing release history.
- keep `ARCHITECTURE.md` as both current and target architecture reference.
- define one active release spec and one active implementation plan as the future rule.
- add a release roadmap broad enough to guide planning.
- add `docs/superpowers/README.md` to define how specs and plans should be used.
- cross-link README and development docs to the product truth.

Usable after this release:

- `PRODUCT.md` is the owner-facing source of truth.
- `CHANGELOG.md` remains user-facing change history.
- `ARCHITECTURE.md` remains the system and target-architecture reference.
- specs/plans are treated as active only for the current release, otherwise historical.
- every future release has clear local verification requirements.
- future planning can start from one file rather than reconciling stale plans manually.

Not included:

- product code changes.
- new runtime adapters.
- API expansion.

Local verification:

- markdown whitespace checks pass.
- `PRODUCT.md` agrees with `docs/development/API.md` on what is currently usable.
- `ARCHITECTURE.md` still describes the target system and no longer points at stale plans as active truth.

Promotion criteria:

- future work can start from `PRODUCT.md` without reconciling old specs and plans.
- `README.md`, `ARCHITECTURE.md`, and development docs all point readers to the correct source of truth.
- the next active release can be represented by one spec and one implementation plan.

### R2: Local Gateway Completeness

Status: shipped. Verified on 2026-05-29 (`codex-org-47c4739e`) against `agent/roadmap-base-20260529` commit `461dea5`.

Goal: make the current local daemon complete enough to inspect and verify without database spelunking or known seeded IDs.

Why this release exists:

The local daemon is the foundation for every future runtime and middleware release. Before adding more providers, the local gateway should be easy to inspect from HTTP, easy to verify from curl, and precise about what endpoints exist. This makes every later adapter easier to debug.

Release scope:

- run listing API with useful filters or a deliberately minimal first version.
- registry listing APIs for providers, runtimes, and models.
- artifact-by-id or artifact-content retrieval for locally stored artifacts.
- public error response contract with stable machine codes.
- endpoint-level smoke coverage for every shipped local endpoint.
- a product decision on SSE: either ship open-ended local SSE or explicitly keep bounded replay/live capture as the supported local behavior.
- development docs updated with complete local verification steps.

Usable after this release:

- run listing.
- registry listing.
- artifact-by-id or artifact content retrieval.
- clearer public error response contract.
- completed local smoke coverage for every shipped endpoint.
- either real open-ended local SSE or an explicit bounded-SSE-only product decision.
- local debugging can happen through the API first, with SQLite inspection reserved for deeper diagnosis.

Not included:

- new runtime providers.
- hosted execution.
- memory/tool/debate middleware.

Local verification:

- start daemon against a clean local data dir.
- create fake and Codex runs.
- list runs and find the created runs.
- list registry records without knowing seeded IDs.
- fetch an artifact record and content or documented local content pointer.
- verify error shapes for missing run, missing registry record, and unsupported input.
- verify event behavior according to the SSE decision.

Promotion criteria:

- `docs/development/API.md` contains every shipped local endpoint.
- `docs/development/DEVELOPMENT.md` has copy-paste smoke commands that cover the whole local gateway.
- `PRODUCT.md` no longer lists run listing, registry listing, or artifact-by-id/content retrieval as missing if they ship.

### R3: Runtime Capability Infrastructure

Status: shipped.

Goal: model runtimes, runtime modes, provider capabilities, and adapter health before adding more adapters.

Why this release exists:

Today Codex `exec --json` exists, but that is not the same as full Codex runtime support. Future providers will expose different modes: one-shot process, interactive process, PTY, ACP, SDK, HTTP wrapper, browser-backed, hosted-safe, and local-only. Switchyard needs a capability model before more adapters are connected.

Release scope:

- runtime mode vocabulary, for example `codex.exec_json`, future `codex.interactive`, `opencode.acp`, `agentfield.async_rest`.
- adapter manifest shape for capabilities and limitations.
- doctor/check service that reports version, availability, auth/config state, and partial support.
- registry schema/API updates for capabilities.
- placement facts for local, hosted, and future hybrid execution.
- clear distinction between provider, runtime, runtime mode, model, and adapter.
- update Codex exec-json registration to use the new vocabulary.

Shipped now:

- runtime mode vocabulary with shipped `fake.deterministic` and `codex.exec_json`, versus future `codex.interactive`.
- adapter manifest shape.
- doctor/check service.
- capability records in registry.
- placement facts for local, hosted, and future hybrid execution.
- runtime availability API that distinguishes `available`, `installed`, `partial`, `unavailable`, `unsupported`, and `unknown`.
- owners and clients can ask what this Switchyard instance can actually run.

Not included in R3:

- full interactive Codex runtime.
- broad adapter expansion.

Local verification shipped:

- `GET /runtime-modes`, `GET /runtime-modes/:id`, `POST /runtime-modes/:id/check`, and `GET /doctor` expose local runtime capability state.
- registry/doctor APIs show `codex.exec_json` as available when Codex is installed.
- the same API marks Codex unavailable without crashing when Codex is missing or model probing fails.
- fake runtime reports deterministic capabilities.
- existing run creation still works after registry/capability changes.

Promotion criteria:

- no runtime is described as broadly supported unless a specific runtime mode is actually implemented.
- every adapter added later must declare capabilities through this mechanism.

### R4: Shared Runtime Substrates And Generic HTTP

Status: shipped. Verified on 2026-05-30 in Phase 3 worktree branch `agent/phase-3-r4-shared-runtime-substrates-and-generic-http`.

Goal: extract reusable runtime infrastructure from the proven Codex slice and validate a second adapter shape through Generic HTTP.

Why this release exists:

Provider infrastructure will vary, but adapters still need common behavior: lifecycle, cancellation, timeout, event normalization, transcript capture, artifact persistence, health checks, and capability reporting. Codex proved a process-backed shape. Generic HTTP proves a wrapper-backed shape without forcing ACP complexity yet.

Release scope:

- shared process-runner substrate extracted from Codex without weakening Codex behavior.
- transcript capture standard across adapters.
- stdout/stderr/event parser harness.
- cancellation and timeout helpers.
- stronger adapter contract tests that every adapter must satisfy.
- Generic HTTP async REST adapter for daemon-configured wrapper runtimes (`generic_http.async_rest`).
- fake HTTP wrapper test server for deterministic CI coverage.
- adapter docs template updated to match the capability model.

Usable after this release:

- shared process-runner substrate for process-backed adapters.
- transcript capture standard.
- stdout/stderr/event parser harness.
- cancellation and timeout helpers.
- stronger adapter contract tests.
- Generic HTTP async REST adapter for daemon-configured wrapper runtimes (`generic_http.async_rest`).
- Switchyard can run one process-backed provider mode and one HTTP-wrapper-backed provider mode through the same public run lifecycle.

Not included:

- ACP/acpx.
- PTY.
- full Codex interactive mode.

Local verification:

- Codex exec-json behavior still passes all existing tests and smoke checks after substrate extraction.
- Generic HTTP adapter can run against a local fake HTTP runtime.
- Generic HTTP status, failure, cancellation, output, and artifact paths are normalized.
- transcript artifacts are stored for both process and HTTP adapter paths.

Promotion criteria met:

- new adapter work no longer copies Codex-specific process code.
- adapter contract tests are reusable by process and HTTP adapters.

### R5: ACP Foundation And OpenCode

Status: shipped. Verified on 2026-05-30 in phase branch `agent/phase-4-r5-acp-foundation-and-opencode`.

Goal: add the structured ACP/acpx path and validate it with OpenCode.

Why this release exists:

ACP is a core target protocol for structured coding runtimes. It deserves its own foundation before OpenCode is treated as "just another process." OpenCode is the first real ACP candidate because local verification already proved initialization and session creation.

Release scope:

- `packages/protocol-acpx`.
- JSON-RPC framing and error handling.
- raw protocol transcript artifact support.
- fake ACP runtime harness.
- outbound ACP client foundation.
- mapping ACP session updates to Switchyard events.
- OpenCode doctor.
- OpenCode ACP adapter.
- local OpenCode smoke docs.

Usable after this release:

- `packages/protocol-acpx`.
- JSON-RPC framing and contract tests.
- fake ACP runtime harness.
- outbound ACP client foundation.
- OpenCode ACP adapter.
- raw ACP transcript artifacts.
- Switchyard can run a local OpenCode-backed task through the same run API.

Not included:

- hosted node connectivity.
- debate orchestration.
- full inbound ACP server unless explicitly included in the release spec.
- approval workflow expansion, tool routing expansion, and memory APIs.
- PTY adapters and interactive Codex runtime sessions.

Local verification:

- fake ACP runtime contract tests pass.
- OpenCode doctor reports binary/version and availability.
- OpenCode run produces normalized events.
- OpenCode cancellation maps to the run lifecycle.
- raw ACP transcript artifact is stored.

Promotion criteria:

- ACP code lives behind protocol boundaries and does not leak OpenCode-specific assumptions into core.
- OpenCode is implemented as an adapter over the ACP foundation, not as a bespoke process parser.

### R6: Wrapper Runtime Integration

Status: shipped on `agent/phase-5-r6-wrapper-runtime-integration`.

Goal: prove Switchyard can coordinate a real wrapper runtime, not only local CLIs.

Why this release exists:

Switchyard is meant to normalize direct runtimes and wrapper runtimes. Generic HTTP proves the wrapper contract in isolation; AgentField now proves it against a real wrapper-style provider boundary without turning AgentField into Switchyard's control plane.

Release scope:

- `agentfield.async_rest` adapter using daemon-configured async REST execution.
- AgentField create-execution, status polling, result capture, and visible failure mapping.
- wrapper execution metadata preserved in normalized events, transcript artifacts, and result artifacts.
- AgentField runtime-mode manifest, seeded provider/runtime/model records, runtime-mode inference, and doctor/check reporting.
- fake AgentField server and local verification script for deterministic CI-safe coverage.
- local docs for fake verification and optional real AgentField smoke with spend warning.

Usable after this release:

- A configured AgentField target can be launched through normal `POST /runs` using `runtime: "agentfield"` and `adapterType: "http"`.
- `agentfield.async_rest` starts upstream async executions, polls terminal status, emits normalized status/output/completion/failure events, and stores sanitized transcript plus result payload artifacts.
- `GET /runtime-modes/agentfield.async_rest`, `POST /runtime-modes/agentfield.async_rest/check`, and `GET /doctor` expose configured/unconfigured AgentField availability without exposing API keys.
- Active cancel is reported truthfully as unsupported with `409 adapter_protocol_failed` and `reasonCode: agentfield_cancel_unsupported`; Switchyard timeouts still persist `timeout`.

Not included:

- verified upstream AgentField cancellation.
- OpenClaw or Paperclip.
- hosted worker execution or hosted/hybrid placement.
- debate orchestration, approvals, memory, tools, SDK, CLI, TUI, or dashboard work.
- AgentField memory, admin, node lifecycle, permissions, or Agentic APIs as Switchyard product surfaces.

Local verification:

- AgentField doctor reports configured/unconfigured states clearly.
- fake AgentField flow passes CI without uncontrolled model spend.
- local fake smoke can create an execution, poll it, normalize completion/failure, and retrieve transcript/result artifacts.
- active cancel returns `agentfield_cancel_unsupported`; post-start input returns `agentfield_input_unsupported`.
- Switchyard timeout persists `timeout` even though upstream cancellation is unsupported.

Promotion criteria:

- wrapper adapters follow Generic HTTP/runtime capability conventions.
- AgentField does not become a second control plane inside Switchyard.
- API keys are not exposed in doctor output, events, logs, transcripts, snapshots, or artifacts.

### R7: Middleware Foundation

Status: planned.

Goal: build the missing internal layers that debate, research, tools, approvals, and memory need.

Why this release exists:

The contracts already name memory, tools, approvals, evidence, messages, and context, but most are not usable product modules yet. Debate and advanced runtimes should not be built on prompt glue alone. This release turns the middleware layer into local, durable, inspectable behavior.

Release scope:

- context builder implementation.
- message router implementation.
- message API if needed for local inspection.
- memory v1 local store and API.
- evidence v1 local store and API.
- approval lifecycle API and events.
- tool invocation service and fake tool adapter.
- policy gates for risky actions.
- local persistence tests for each middleware store.
- development docs for middleware smoke behavior.

Usable after this release:

- context builder.
- message router.
- memory v1 API and local store.
- evidence v1 API and local store.
- approval lifecycle API.
- tool invocation service and fake tool adapter.
- policy gates for risky actions.
- runs can receive consistent context, store/search basic memory, preserve evidence, request approval, and record auditable fake tool calls.

Not included:

- vector memory unless explicitly scoped.
- full debate engine.
- real browser/search/GitHub/shell tool execution unless separately scoped.

Local verification:

- create/list/search memory records.
- create/list evidence records and attach them to run/debate-ready context.
- route a message between fake runs or channels.
- run a fake tool invocation through approval/policy flow.
- verify approval requested, approved/rejected, and resumed/denied event paths.

Promotion criteria:

- debate work can depend on real middleware services rather than new one-off storage.
- risky tool and runtime actions have an approval/policy path before real tools expand.

### R8: Interactive Coding Runtimes

Status: planned.

Goal: add richer coding-runtime behavior after the runtime capability and middleware foundations exist.

Why this release exists:

One-shot Codex exec-json is useful, but coding agents often need input, approvals, tool-call state, and session continuity. Interactive runtime support should be added only after capability reporting, middleware, and policy exist, otherwise each provider will become a brittle special case.

Release scope:

- Codex interactive runtime mode decision: structured process if available, PTY only if necessary.
- post-start input where Codex supports it or explicit unsupported semantics if it cannot.
- session state and resume behavior where available.
- approval bridging where exposed by the runtime.
- Claude Code adapter using SDK or stream-json after an approved live probe.
- tool-call and approval-pause normalization.
- richer transcript artifacts.
- runtime docs and local smoke commands.

Usable after this release:

- Codex interactive runtime mode if a safe structured/process/PTY strategy is selected.
- Claude Code adapter through SDK or stream-json after an approved live probe.
- post-start input where supported.
- session state and transcript artifacts.
- approval pause mapping where the runtime exposes it.
- local coding runtimes can move beyond one-shot execution where the provider supports it.

Not included:

- Cursor until local auth/keychain behavior is understood.
- unbounded autonomous multi-agent execution.
- hosted arbitrary subprocess execution.

Local verification:

- interactive-capable runtime mode reports distinct capabilities from `codex.exec_json`.
- post-start input succeeds where supported and returns clear `409` where unsupported.
- Claude doctor reports auth/config without leaking secrets.
- Claude or Codex interactive smoke produces normalized output and transcript artifacts.
- approval pauses are represented consistently if the runtime emits them.

Promotion criteria:

- no provider is promoted from one-shot to interactive unless local smoke proves input/session behavior.
- PTY use, if any, is explicitly local-only and policy-gated.

### R9: Debate V1

Status: planned.

Goal: build bounded multi-agent debate on top of runs, messages, context, evidence, and artifacts.

Why this release exists:

Debate is a product-level workflow, not just multiple prompts. It needs the run lifecycle, message routing, context building, evidence, artifacts, and stop limits to exist first. The first debate release should prove orchestration with fake participants before mixing expensive or stateful real runtimes.

Release scope:

- debate create/inspect/events routes.
- debate state storage.
- fake participant debate.
- participant run creation.
- bounded round executor.
- message router integration.
- evidence references.
- stop conditions and budget limits.
- judge/synthesizer placeholder or minimal deterministic fake judge for v1.
- final report artifact.
- local debate smoke docs.

Usable after this release:

- debate create/inspect/events routes.
- fake participant debate first.
- participant run creation.
- round executor.
- message router integration.
- evidence references.
- stop limits.
- final report artifact.
- Switchyard can complete a bounded two-participant fake debate and produce an auditable report artifact.

Not included:

- unbounded autonomous swarms.
- hosted/hybrid debate execution unless hosted has already shipped.
- complex research tools unless R7 explicitly shipped them.

Local verification:

- create a two-participant fake debate.
- stream or replay debate events.
- verify each participant run is traceable.
- verify stop limits terminate the debate.
- fetch final report artifact.

Promotion criteria:

- debate cannot bypass run/message/evidence/artifact primitives.
- every debate has hard limits and an inspectable final state.

### R10: Hosted And Hybrid Execution

Status: planned.

Goal: move from local product to deploy-anywhere product once local semantics are stable.

Why this release exists:

Hosted and hybrid execution multiply operational complexity. They should not come before the local API, runtime model, adapters, and middleware are stable. Once those semantics are proven locally, hosted mode can preserve the same client contract while moving execution into workers and connected nodes.

Release scope:

- hosted server app.
- hosted worker app.
- Postgres storage.
- Redis/BullMQ queue.
- object artifact store.
- hosted-safe fake runtime worker.
- local node app.
- node registration and heartbeat.
- hosted-to-local run assignment.
- local node policy enforcement.
- event and artifact sync rules.
- placement across local, hosted, and connected local nodes.

Usable after this release:

- hosted server app.
- hosted worker app.
- Postgres storage.
- Redis/BullMQ queue.
- object artifact store.
- local node app.
- hosted-to-local run assignment.
- placement across local, hosted, and connected local nodes.
- same public run contract can be exercised in local and hosted-like modes.

Not included:

- enterprise billing or multi-tenant authorization beyond required interface boundaries.
- hosted arbitrary subprocess/PTY execution without an explicit sandbox design.

Local verification:

- hosted-like server can create a fake run and worker completes it.
- Postgres-backed stores pass storage contract tests.
- queued run execution handles success, failure, retry, and cancellation.
- local node can accept and reject work by policy.
- events and artifacts sync according to policy.

Promotion criteria:

- clients do not need a different API for local versus hosted run creation.
- local-only runtime modes are not silently exposed as hosted-safe.

### R11: SDK, CLI, And Hardening

Status: planned.

Goal: make Switchyard easier to consume and operate once the API is stable.

Why this release exists:

SDK and CLI work should happen after the API has enough stability to avoid churn. This release packages the product for consumers and operators: typed clients, doctor commands, generated API docs, migrations, compatibility checks, and release hardening.

Release scope:

- TypeScript SDK.
- OpenAPI generation or equivalent typed contract output.
- CLI for doctor, local launch, runtime test, and debugging.
- migration policy and migration test strategy.
- adapter compatibility matrix automation.
- release packaging for local daemon.
- operational hardening for logs, errors, metrics, and recovery.

Usable after this release:

- TypeScript SDK.
- CLI doctor/local launch/runtime test/debug commands.
- OpenAPI generation.
- migration policy.
- adapter compatibility matrix automation.
- release packaging.
- app developers and operators can consume Switchyard without hand-written curl workflows.

Not included:

- broad UI/dashboard work unless separately scoped.

Local verification:

- SDK can create a run, inspect events, fetch artifacts, and handle typed errors against the local daemon.
- CLI can run doctor checks and launch a local fake run.
- OpenAPI/contract output matches implemented endpoints.
- migration tests protect existing local data.
- compatibility matrix checks run in CI-safe mode.

Promotion criteria:

- the documented local API and generated/typed client agree.
- release packaging can be installed and smoke-tested from a clean environment.

## Before Release Verification

Before cutting any release, verify the product from three levels.

### 1. Workspace Health

Run the full project checks:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

Also run:

```bash
git diff --check
```

### 2. Local Daemon Smoke

Use `docs/development/DEVELOPMENT.md` as the source of truth for copy-paste local smoke commands and expected outcomes.

At minimum, verify:

- daemon starts.
- `GET /health` returns `{"ok":true}`.
- fake runtime `POST /runs?wait=1` completes.
- a run can be inspected with `GET /runs/:id`.
- events can be replayed with `GET /runs/:id/events`.
- artifacts can be listed with `GET /runs/:id/artifacts`.
- registry lookups return expected seeded records.

### 3. Codex Manual Smoke

Use `docs/development/API.md` for the current Codex request body and response shape, and `docs/development/adapters/CODEX.md` for runtime-specific debugging.

For releases that claim Codex behavior, verify:

- `codex --version` works locally.
- `codex debug models` works or the daemon marks Codex unavailable without crashing.
- a read-only Codex `POST /runs?wait=1` returns a terminal run.
- `response.text` contains the final visible model answer when the run completes.
- transcript artifact metadata reports stored content.
- daemon logs include `codex.spawned`, `codex.stdout.first_line`, and `codex.exit` for a healthy run.

## Release Readiness Notes

Current release readiness:

- Local MVP is testable.
- Codex `exec --json` is usable for one-shot local runs.
- API docs exist for the local daemon.
- Development docs contain local smoke and inspection commands.
- Specs and implementation plans are no longer reliable as product truth because several plan checkboxes are stale.

Known release risks:

- Codex event shape depends on the local Codex CLI version.
- Local open-ended SSE (`GET /runs/:id/events?live=1`) is shipped for daemon use, but hosted production streaming remains unshipped.
- Runtime capability and doctor reporting are shipped for `fake.deterministic` and `codex.exec_json`, but only these two runtime modes are currently implemented.
- Artifact metadata/content endpoints are shipped (`GET /artifacts/:id`, `GET /artifacts/:id/content`), but HTTP `HEAD` and `Range` support is not implemented.
- There is no hosted deployment path yet.

## Source Map

Use these files for details:

- Product truth: `PRODUCT.md`
- User-facing changes: `CHANGELOG.md`
- Public overview: `README.md`
- API contract: `docs/development/API.md`
- Local setup and smoke: `docs/development/DEVELOPMENT.md`
- Codex debugging: `docs/development/adapters/CODEX.md`
- Architecture: `ARCHITECTURE.md`
- Adapter research: `docs/adapters/`
- Historical specs: `docs/superpowers/specs/`
- Historical implementation plans: `docs/superpowers/plans/`
