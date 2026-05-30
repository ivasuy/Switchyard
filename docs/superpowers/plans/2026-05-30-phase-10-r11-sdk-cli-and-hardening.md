# Phase 10: R11 SDK, CLI, And Hardening - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-10-r11-sdk-cli-and-hardening.md`
**Branch:** `agent/phase-10-r11-sdk-cli-and-hardening`
**Worktree:** `/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/native-roadmap-20260529/phase-10-r11-sdk-cli-and-hardening`
**Plan target:** `docs/superpowers/plans/2026-05-30-phase-10-r11-sdk-cli-and-hardening.md`
**Complexity:** L

## Goal

Ship R11 as a consumable and hardened local daemon product surface: TypeScript SDK, CLI, deterministic contract output, migration protection, adapter compatibility automation, clean local release packaging, and request/error/log/metric/recovery hardening.

## Scope Challenge

1. Existing code already covers most primitives: `packages/contracts` Zod schemas, `packages/protocol-rest` route groups, `packages/protocol-sse` SSE helpers, `apps/daemon` local wiring, `packages/storage` additive SQLite migrations, runtime adapter manifests, fake runtime/testkit harnesses, and current daemon/storage/adapter tests. R11 must package and harden these seams rather than create a second API.
2. Minimum scope is SDK, CLI, endpoint descriptors/OpenAPI, storage migration policy/version tests, adapter compatibility matrix, release smoke packaging, request ids, typed errors, metrics, structured logs, startup recovery, and docs. UI/dashboard/TUI, new adapters, hosted expansion, enterprise auth/billing, and live model/API spend remain out of scope.
3. Complexity check: this phase necessarily touches more than eight files and introduces more than two public components. A multi-task split would create contention in root/package manifests, contracts, daemon routes, storage migration surfaces, release scripts, and docs. Per the user's status update, this plan uses one implementer/reviewer task for the whole phase.
4. Built-in check: use Node 20 built-ins (`fetch`, `URL`, `AbortController`, `ReadableStream`, `node:util.parseArgs`, child process primitives), Fastify hooks/injection, Zod schemas and Zod 4 JSON Schema conversion, existing SSE helpers, existing adapter manifests, Vitest, and pnpm/Turbo. Do not add a CLI framework, custom URL/JSON parser, second SSE formatter, or second daemon protocol.
5. Distribution check: release packaging is explicit scope. The clean temp smoke must prove installed users consume built `dist` files, `.d.ts` types, and bins without workspace symlinks or `src/*.ts` exports.

## Architecture

`packages/contracts` becomes the local daemon contract inventory source. Endpoint descriptors define method, path template, query/body schema, success schema or raw/SSE marker, content type, error envelope, operation id, and surface tag. The OpenAPI generator emits deterministic OpenAPI 3.1 JSON, and `openapi:check` compares generated output to committed output and descriptor routes to real Fastify routes registered by `createDaemonApp`.

```text
contracts schemas
  -> endpoint descriptors
  -> OpenAPI 3.1 JSON and typed endpoint map
  -> SDK response decoding
  -> CLI contract export
  -> route drift check against createDaemonApp()
```

`@switchyard/sdk` is the only programmatic client. It talks to the local daemon over HTTP, validates successful JSON through contract schemas, preserves raw artifact bytes, parses replay/live SSE into `SwitchyardEvent` values, and exposes typed HTTP, network, decode, validation, and stream errors. It must not import daemon, storage, or protocol-rest internals.

`@switchyard/cli` is a thin operator surface over the SDK plus the packaged daemon binary. `doctor`, `run fake`, `runtimes test`, `debug run`, and `contract export` prove the public contract path. `daemon start` spawns `switchyard-daemon`, waits for `/health`, and reports named startup failures.

Operational hardening stays in the local daemon. Fastify hooks add bounded request ids, response headers, structured request logs, and request metrics. Protocol errors preserve the current envelope and add only optional `error.requestId`. `GET /metrics` returns deterministic local JSON. Startup recovery reconciles active persisted runs exactly once, appends `daemon_restarted` failure events, and records log/metric evidence.

## Existing Context

`package.json` confirms the repo is a pnpm/Turbo ESM TypeScript monorepo with `build`, `test`, `typecheck`, and `lint` scripts.

`packages/protocol-rest/src/run-routes.ts` is the real run route implementation SDK/CLI/contract output must describe. It already implements `POST /runs`, `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`, `GET /runs/:id/artifacts`, `POST /runs/:id/input`, and `POST /runs/:id/cancel`.

`packages/protocol-rest/src/artifact-routes.ts` separates `GET /artifacts/:id` metadata from `GET /artifacts/:id/content` raw content.

`packages/contracts/src/http-error.ts` has the existing closed error envelope. R11 may only add backward-compatible optional `requestId`.

`packages/storage/src/sqlite/database.ts` currently applies additive migrations without version records. R11 adds policy, schema versioning, fixtures, and corrupt/empty DB guards.

`apps/daemon/src/app.ts` registers the local Fastify app, seeds all shipped runtime manifests, creates stores, and contains the current narrow recovery hook.

`packages/testkit/src/runtime-adapter-contract-harness.ts` and `packages/adapters/test/runtime-adapter-contracts.test.ts` already provide no-spend fake process/server/client patterns for shipped runtime adapters.

## File Structure

- `package.json`, `pnpm-lock.yaml` - root scripts and lockfile updates for new packages, contract checks, compatibility checks, and release smoke.
- `packages/sdk/**` - new SDK package, typed client, errors, SSE parser, artifact content helpers, and tests.
- `packages/cli/**` - new CLI package, command parser, command helpers, daemon process launcher, formatters, typed CLI errors, and tests.
- `packages/contracts/package.json`, `packages/contracts/src/**`, `packages/contracts/openapi/**`, `packages/contracts/test/**` - endpoint descriptors, OpenAPI generation, metrics schema, HTTP request/response schemas, optional request id envelope, generated output, and tests.
- `tools/contract-check/**` - route drift and generated-output check entrypoint.
- `apps/daemon/package.json`, `apps/daemon/src/**`, `apps/daemon/test/**` - daemon bin metadata, request ids, metrics, structured logs, startup recovery, storage error surfacing, and tests.
- `packages/protocol-rest/src/**`, `packages/protocol-rest/test/**` - error envelope request ids, route hooks for metrics/logs, and route tests.
- `packages/storage/src/sqlite/**`, `packages/storage/test/**` - migration policy, schema versioning, SQL fixtures, corrupt/empty DB handling, and migration tests.
- `packages/adapters/package.json`, `packages/adapters/src/**`, `packages/adapters/test/**`, `packages/adapters/compatibility-matrix.*` - compatibility generator, no-spend matrix coverage, scripts, generated artifacts, and tests.
- `packages/testkit/src/**`, `packages/testkit/test/**` - reusable no-spend harness helpers only where required by compatibility/package smoke.
- `tools/release/**` - local release pack and clean-environment smoke automation.
- `PRODUCT.md`, `CHANGELOG.md`, `ARCHITECTURE.md`, `docs/development/**` - R11 product truth, API/operations docs, adapter docs, and verification commands.

## Task Graph

### Task P10-T1: Ship R11 SDK, CLI, Contracts, Packaging, And Hardening

**id:** `P10-T1-r11-sdk-cli-contracts-hardening`
**title:** Ship R11 SDK, CLI, contracts, packaging, and hardening

**Files (owned):**
- `package.json`
- `pnpm-lock.yaml`
- `apps/daemon/package.json`
- `apps/daemon/src/**`
- `apps/daemon/test/**`
- `packages/sdk/**`
- `packages/cli/**`
- `packages/contracts/package.json`
- `packages/contracts/src/**`
- `packages/contracts/openapi/**`
- `packages/contracts/test/**`
- `packages/protocol-rest/src/**`
- `packages/protocol-rest/test/**`
- `packages/storage/src/sqlite/**`
- `packages/storage/test/**`
- `packages/adapters/package.json`
- `packages/adapters/src/**`
- `packages/adapters/test/**`
- `packages/adapters/compatibility-matrix.json`
- `packages/adapters/compatibility-matrix.md`
- `packages/testkit/src/**`
- `packages/testkit/test/**`
- `tools/contract-check/**`
- `tools/release/**`
- `PRODUCT.md`
- `CHANGELOG.md`
- `ARCHITECTURE.md`
- `docs/development/**`

**Dependencies:** none

**Context files (must read before coding):**
- `docs/superpowers/specs/2026-05-30-phase-10-r11-sdk-cli-and-hardening.md` - source of all R11 acceptance and non-goals.
- `package.json` - root package scripts, package manager, dependency constraints, and pnpm/Turbo shape.
- `packages/contracts/src/index.ts` - current public schema export surface.
- `packages/contracts/src/http-error.ts` - current HTTP error envelope to extend compatibly.
- `packages/protocol-rest/src/run-routes.ts` - real run/event/artifact-list/input/cancel route behavior.
- `packages/protocol-rest/src/artifact-routes.ts` - real artifact metadata/content split.
- `apps/daemon/src/app.ts` - local daemon route registration, adapter wiring, storage creation, and current recovery hook.
- `packages/storage/src/sqlite/database.ts` - current SQLite schema SQL and additive migration list.
- `packages/testkit/src/runtime-adapter-contract-harness.ts` - existing no-spend adapter contract harness.
- `packages/adapters/test/runtime-adapter-contracts.test.ts` - existing fake process/server/client coverage for adapter modes.

**Instructions:**
1. Add `@switchyard/sdk` and `@switchyard/cli` package scaffolds in the existing ESM TypeScript style. Add `switchyard` and `switchyard-daemon` bin metadata without breaking daemon dev behavior.
2. Add local release pack and smoke scripts. The smoke must build required packages, install from disk in a temp directory outside the repo, start the daemon on an ephemeral port, run CLI doctor, run fake run, replay events through SDK or CLI, fetch artifact content, shut down, and preserve a report on failure.
3. Add contract request/response schemas, `metricsResponseSchema`, endpoint descriptors for every local daemon route in the spec plus `GET /metrics`, deterministic OpenAPI 3.1 generation, committed output, and `openapi:generate`/`openapi:check`. Represent SSE and raw artifact content accurately with content types and `x-switchyard-*` extensions where needed.
4. Make `openapi:check` compare generated output to committed output and compare descriptor method/path set against real Fastify routes from `createDaemonApp` using no-spend fake probes. Fail closed on unreadable route inventory.
5. Implement `SwitchyardClient` with default `http://127.0.0.1:4545`, native fetch, built-in `URL`, optional headers, typed response decoding, raw artifact bytes, replay SSE parsing, abortable live SSE iteration, and typed errors: `SwitchyardHttpError`, `SwitchyardNetworkError`, `SwitchyardDecodeError`, `SwitchyardValidationError`, and `SwitchyardStreamError`.
6. Implement CLI parsing with `node:util.parseArgs`. Required commands are `doctor`, `daemon start`, `run fake`, `runtimes test`, `debug run`, and `contract export`. Human output must be concise; `--json` output must be valid JSON.
7. Add SQLite migration policy, schema version tracking, SQL text fixtures for pre-R3/pre-R7/pre-R9/pre-R11, idempotent reopen tests, and zero-byte/corrupt DB rejection without overwrite. Destructive migration statements must fail tests.
8. Harden daemon request ids, error envelopes, structured logs, local metrics, and startup recovery. Recovery must cover `starting`, `running`, `waiting_for_input`, and `waiting_for_approval` runs with no terminal event, append exactly one `run.failed` event with `daemon_restarted`, and record log/metric evidence.
9. Add adapter compatibility matrix automation from real manifests and no-spend fake harnesses for `fake.deterministic`, `claude_code.sdk`, `codex.exec_json`, `agentfield.async_rest`, `generic_http.async_rest`, and `opencode.acp`. Generate deterministic JSON and markdown; fail on missing manifests, missing harnesses, live calls in CI-safe mode, uncovered capabilities, and output drift.
10. Update `PRODUCT.md`, `CHANGELOG.md`, `ARCHITECTURE.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, and adapter docs. Keep non-goals explicit and do not claim live non-fake execution as required coverage.

**Acceptance criteria:**
- [ ] SDK creates a fake run, inspects it, replays events, lists artifacts, fetches transcript content, cancel/send input where supported, and exposes typed HTTP/network/decode/validation/stream errors.
- [ ] SDK tests cover happy, nil, empty, and error paths for run creation, event replay/streaming, artifact metadata/content, and typed errors.
- [ ] CLI `doctor`, `daemon start`, `run fake`, `runtimes test`, `debug run`, and `contract export` exist with deterministic human and JSON behavior where requested.
- [ ] OpenAPI or equivalent typed contract output is deterministic and checked against real local daemon route registrations.
- [ ] Generated contract output includes local daemon success, SSE, raw artifact content, metrics, and error-envelope behavior.
- [ ] Migration tests open representative older SQLite schemas, preserve local data, and reject corrupt/empty DB files without overwrite.
- [ ] Adapter compatibility matrix covers all shipped runtime modes in CI-safe/no-spend mode and fails on missing manifests, missing harnesses, unsupported live calls, uncovered capabilities, or output drift.
- [ ] Local release packaging installs from disk in a clean temp environment and smoke-tests doctor, fake run, event replay, artifact content fetch, and shutdown.
- [ ] Logs include request ids and named operational events without leaking secrets or stack traces to users.
- [ ] Error envelopes preserve current behavior and add only optional request id metadata.
- [ ] `GET /metrics` returns deterministic local JSON counters/gauges and is covered by tests.
- [ ] Startup recovery reconciles interrupted local runs exactly once and records visible event/log/metric evidence.
- [ ] Required R11 product, API, development, architecture, changelog, and adapter docs are updated.

**Checks (must pass before GREEN):**
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm lint`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm --filter @switchyard/adapters compatibility:check`
- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/cli test`
- `pnpm --filter @switchyard/sdk test`
- `pnpm release:smoke-local`
- `git diff --check`

**Error rescue map:**

| Codepath | Failure | Exception shape | Rescue | User sees |
| --- | --- | --- | --- | --- |
| `SwitchyardClient.requestJson` | fetch rejects | native fetch error | throw `SwitchyardNetworkError` with method/url/cause | typed network error |
| `SwitchyardClient.requestJson` | HTTP error with valid envelope | parsed `HttpErrorEnvelope` | throw `SwitchyardHttpError` | status, code, message, details, requestId |
| `SwitchyardClient.requestJson` | HTTP error non-JSON body | body text | throw `SwitchyardDecodeError` with status and 4 KiB excerpt | typed decode error |
| `SwitchyardClient.requestJson` | success shape invalid | Zod error | throw `SwitchyardDecodeError` | endpoint and schema issue summary |
| SDK id validation | missing or empty id | client validation | throw `SwitchyardValidationError` before HTTP | field name and method |
| SDK SSE replay/live | empty replay response | no throw | return empty event list | empty event array |
| SDK SSE replay/live | malformed frame JSON | `SyntaxError` | throw `SwitchyardStreamError` with last event id | stream error |
| SDK live stream | abort signal fires | `AbortError` | cancel reader and release resources | iterator terminates or throws typed abort based on option |
| SDK artifact content | zero-byte content | no throw | return empty `Uint8Array` | empty content is not missing |
| CLI parser | invalid command/flag | `CliUsageError` | print command usage | stderr usage, exit 2 |
| `switchyard doctor` | daemon unreachable | `SwitchyardNetworkError` | fail non-zero with remediation | base URL and daemon start hint |
| `switchyard doctor` | invalid health/doctor payload | `SwitchyardDecodeError` | fail non-zero | invalid payload summary |
| `switchyard daemon start` | port occupied | child exit or bind error | report `daemon_port_in_use` | port and remediation |
| `switchyard daemon start` | empty data dir flag | `CliUsageError` | reject before spawn | `--data-dir must be non-empty` |
| `switchyard daemon start` | readiness timeout | `CliDaemonStartError` | terminate child and preserve logs | timeout and log path |
| `switchyard run fake` | empty task | no throw | use safe default `Switchyard CLI fake smoke` | output notes default task in JSON |
| `switchyard runtimes test` | non-fake without `--live` | no throw | check-only path | no run created, check-only message |
| `switchyard debug run` | missing run | `SwitchyardHttpError run_not_found` | print remediation | run id and base URL hint |
| `switchyard debug run` | missing artifact content | `SwitchyardHttpError missing_artifact_content` | keep metadata and print hint | content unavailable hint |
| `contract export` | output path unwritable | `CliFileError` | fail before partial write or remove partial | path and OS message |
| `generateOpenApi` | descriptor inventory empty | `contract_inventory_empty` | abort generation | inventory path and command |
| `generateOpenApi` | duplicate operation id | `contract_operation_duplicate` | abort generation | operation id and paths |
| `generateOpenApi` | schema cannot be represented | `contract_schema_unrepresentable` | require extension or fail | method/path and schema name |
| `openapi:check` | generated JSON differs | `contract_output_drift` | fail with regenerate command | output file path |
| `openapi:check` | descriptor missing real route | `contract_route_missing` | fail closed | method/path |
| `openapi:check` | real route lacks descriptor | `contract_descriptor_missing` | fail closed | method/path |
| `openSqliteStorage` | missing DB path | no exception | create current schema | normal startup |
| `openSqliteStorage` | zero-byte existing file | `SqliteMigrationError storage_database_empty` | do not write file | named storage error |
| `openSqliteStorage` | corrupt/non-SQLite file | `SqliteMigrationError storage_database_corrupt` | close handle and leave file in place | named storage error |
| `applyMigrations` | destructive statement | `SqliteMigrationError storage_migration_policy_violation` | abort before execution | migration id and blocked statement |
| `applyMigrations` | SQL execution fails | `SqliteMigrationError storage_migration_failed` | rollback current migration | migration id and SQLite message |
| request id hook | inbound id empty or too long | no throw | generate bounded request id | `x-request-id` header |
| daemon error handler | unexpected error | unknown throwable | log server-side, return `internal_error` | sanitized envelope with requestId |
| metrics endpoint | no activity | no throw | return zero counters/gauges | deterministic JSON zeros |
| startup recovery | active run has terminal event | no throw | skip reconciliation | no duplicate event |
| startup recovery | active run lacks terminal event | no throw | mark run/session failed, append one event | `daemon_restarted` event |
| compatibility generator | no adapters | `compatibility_matrix_empty` | abort generation | no adapters found |
| compatibility generator | manifest missing | `compatibility_manifest_invalid` | fail CI mode | adapter id and field |
| compatibility generator | no no-spend harness | `compatibility_harness_missing` | fail CI mode | runtime mode slug |
| compatibility generator | live call attempted | `compatibility_live_call_blocked` | fail before call leaves process | adapter and target |
| compatibility check | output drift | `compatibility_output_drift` | fail with regenerate command | output file path |
| release pack | package build fails | child exit with status/stderr excerpt | stop before packing and keep log | package and log path |
| release pack | release manifest points at source | `release_manifest_uses_source` | fail before smoke | package and offending field |
| release smoke | bundle path missing | `release_bundle_missing` | fail before install | missing path |
| release smoke | install fails | `release_install_failed` | keep temp report and skip daemon start | install command and report dir |
| release smoke | daemon readiness timeout | `release_daemon_ready_timeout` | kill child and keep logs | base URL and log path |

**Observability:**

```json
{
  "logs": [
    "http.request.start requestId=... method=GET path=/health",
    "http.request.complete requestId=... statusCode=200 durationMs=N",
    "runtime_mode.seeded runtimeMode=fake.deterministic state=available",
    "runtime_mode.check runtimeMode=fake.deterministic state=available",
    "run.created runId=... runtimeMode=fake.deterministic",
    "run.started runId=...",
    "run.completed runId=...",
    "artifact.persistence.failed runId=... artifactId=...",
    "storage.migration.start path=...",
    "storage.migration.success schemaVersion=N",
    "startup.recovery.completed runs=N sessions=N",
    "release.smoke.step name=fake-run status=passed"
  ],
  "success_metric": "all promotion checks pass and /metrics exposes non-missing counters/gauges with request ids in headers/logs",
  "failure_metric": "named error code for SDK, CLI, contract, storage, compatibility, daemon, or release path with report/log location when available"
}
```

**Test cases:**

| Name | Lens | Given | Expect |
| --- | --- | --- | --- |
| SDK fake run integration | integration | local daemon and `createRun(..., { wait: true })` | completed run and `response.text === 'fake runtime output'` |
| SDK missing run | error_path | `getRun('run_missing')` | `SwitchyardHttpError` status 404 code `run_not_found` |
| SDK empty id validation | happy_shadow_empty | `getRun('')` | `SwitchyardValidationError`, no HTTP call |
| SDK network failure | error_path | closed loopback port | `SwitchyardNetworkError` |
| SDK invalid success JSON | error_path | fetch mock returns malformed success body | `SwitchyardDecodeError` |
| SDK empty event replay | happy_shadow_empty | empty SSE response | empty event array |
| SDK malformed SSE | error_path | SSE frame with invalid JSON data | `SwitchyardStreamError` |
| SDK abort live stream | edge_abort | `streamRunEvents` with aborted `AbortSignal` | reader released and iterator terminates |
| SDK raw artifact bytes | happy | transcript artifact content | `Uint8Array` and content type preserved |
| CLI doctor human | happy | daemon on ephemeral port | human summary includes health and runtime summary |
| CLI doctor JSON | happy | `switchyard doctor --json` | stdout parses as JSON |
| CLI doctor unreachable | error_path | closed port | non-zero and remediation hint |
| CLI daemon readiness | integration | daemon starts on ephemeral port | prints base URL and pid |
| CLI daemon timeout | error_path | daemon child never ready | named timeout and child cleanup |
| CLI fake default task | happy_shadow_empty | `run fake --wait --task ""` | completed run using safe default |
| CLI runtime fake test | integration | `runtimes test fake.deterministic` | no-spend fake run and counts |
| CLI non-fake check only | happy | `runtimes test codex.exec_json` without `--live` | no run created |
| CLI debug missing run | error_path | `debug run run_missing` | run_not_found remediation |
| CLI debug restart recovery | edge_recovery | run has `daemon_restarted` event | recovery hint printed |
| Contract stable generation | happy | generator run twice | identical JSON bytes |
| Contract empty inventory | happy_shadow_empty | `generateOpenApi([])` | `contract_inventory_empty` |
| Contract duplicate operation | error_path | duplicate operation id fixture | `contract_operation_duplicate` |
| Contract SSE descriptor | happy | `/runs/{id}/events` descriptor | OpenAPI has `text/event-stream` |
| Contract raw artifact descriptor | happy | `/artifacts/{id}/content` descriptor | raw content plus extension marker |
| Contract route drift | integration | descriptor removed in fixture | missing method/path reported |
| Migration missing DB | happy_shadow_nil | nonexistent temp path | current schema and migration version created |
| Migration empty DB | happy_shadow_empty | zero-byte file | named storage error and file unchanged |
| Migration corrupt DB | error_path | non-SQLite file | named storage error and content unchanged |
| Migration pre-R3 fixture | integration | `pre-r3.sql` | old rows survive and new columns exist |
| Migration pre-R7 fixture | integration | `pre-r7.sql` | middleware tables/indexes exist |
| Migration pre-R9 fixture | integration | `pre-r9.sql` | debate rows survive |
| Migration pre-R11 fixture | integration | `pre-r11.sql` | version table added idempotently |
| Migration policy blocks drop | error_path | `DROP TABLE runs` statement | policy violation |
| Request id generated | happy_shadow_nil | `GET /health` without header | response has `x-request-id` |
| Request id honored | happy | `x-request-id: req_test` | response returns same id |
| Empty request id rejected | happy_shadow_empty | empty header | generated id |
| Error envelope request id | error_path | `GET /runs/run_missing` | `error.requestId` present |
| Unexpected error sanitized | error_path | route fixture throws stack-bearing error | `internal_error`, no stack in body |
| Metrics empty shape | happy_shadow_empty | fresh daemon `GET /metrics` | all required fields with zeros |
| Metrics count request | integration | call `/health`, then `/metrics` | count increments for `GET /health` |
| Recovery active run once | integration | DB with active run, restart twice | one `run.failed` event |
| Recovery waiting state | edge_recovery | DB with `waiting_for_input` no terminal event | run failed with `daemon_restarted` |
| Recovery terminal untouched | edge_recovery | completed run with terminal event | no extra terminal event |
| Compatibility shipped modes | happy | generated matrix | six required runtime mode slugs present |
| Compatibility empty matrix | happy_shadow_empty | no adapters fixture | `compatibility_matrix_empty` |
| Compatibility missing manifest | happy_shadow_nil | adapter fixture without manifest | invalid manifest error |
| Compatibility missing harness | error_path | manifest without harness | `compatibility_harness_missing` |
| Compatibility live blocked | error_path | harness attempts non-loopback or real model call | `compatibility_live_call_blocked` |
| Compatibility deterministic output | happy | generator run twice | JSON and markdown bytes match |
| Release dist exports | happy | packed manifests | public exports/types/bins point at dist |
| Release rejects source export | error_path | fixture manifest uses `src/index.ts` | `release_manifest_uses_source` |
| Release smoke | integration | built local bundle | doctor, fake run, event replay, artifact content, shutdown pass |
| Docs current truth | happy | read docs after implementation | R11 shipped behavior present and non-goals preserved |
| Docs no live-spend claim | error_path | scan adapter docs | required checks remain no-spend; live checks manual only |

**Integration contracts:**

```json
{
  "exports": [
    {
      "name": "SwitchyardClient",
      "kind": "class",
      "signature": "new SwitchyardClient(options?: { baseUrl?: string; fetch?: typeof fetch; headers?: HeadersInit })"
    },
    {
      "name": "SwitchyardHttpError",
      "kind": "class",
      "signature": "class SwitchyardHttpError extends Error { status: number; code: HttpErrorCode; details?: HttpErrorDetail[]; requestId?: string }"
    },
    {
      "name": "switchyard",
      "kind": "command",
      "signature": "switchyard <doctor|daemon start|run fake|runtimes test|debug run|contract export>"
    },
    {
      "name": "endpointDescriptors",
      "kind": "constant",
      "signature": "EndpointDescriptor[]"
    },
    {
      "name": "generateOpenApi",
      "kind": "function",
      "signature": "generateOpenApi(input: { surface: 'daemon-local' | 'server-hosted' | 'all' }) => OpenApiDocument"
    },
    {
      "name": "metricsResponseSchema",
      "kind": "constant",
      "signature": "z.ZodType<MetricsResponse>"
    },
    {
      "name": "SqliteMigrationError",
      "kind": "class",
      "signature": "new SqliteMigrationError(code: StorageMigrationErrorCode, message: string, options?: { migrationId?: string })"
    },
    {
      "name": "readSqliteMigrationInfo",
      "kind": "function",
      "signature": "readSqliteMigrationInfo(sqlite: Database.Database) => { schemaVersion: number; applied: Array<{ id: string; appliedAt: string }> }"
    },
    {
      "name": "buildCompatibilityMatrix",
      "kind": "function",
      "signature": "buildCompatibilityMatrix(input: CompatibilityMatrixInput) => Promise<CompatibilityMatrix>"
    },
    {
      "name": "pnpm release:smoke-local",
      "kind": "command",
      "signature": "pnpm release:smoke-local => clean temp install smoke report"
    }
  ],
  "imports_from_other_tasks": [],
  "file_paths_consumed_by_other_tasks": [
    "packages/sdk/src/index.ts",
    "packages/cli/src/main.ts",
    "packages/contracts/src/endpoint-inventory.ts",
    "packages/contracts/openapi/daemon-local.openapi.json",
    "packages/adapters/compatibility-matrix.json",
    "tools/release/smoke-local-release.ts"
  ]
}
```

## Phase-Level Promotion Checks

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
pnpm --filter @switchyard/contracts openapi:check
pnpm --filter @switchyard/adapters compatibility:check
pnpm --filter @switchyard/storage test
pnpm --filter @switchyard/cli test
pnpm --filter @switchyard/sdk test
pnpm release:smoke-local
git diff --check
```

## Risks

- This is a deliberately large single implementer task because the user requested one implementer/reviewer loop as the practical path. Reviewer and auditor should apply the promotion checks strictly because the task spans new packages, contracts, storage, daemon runtime behavior, packaging, and docs.
- Existing workspace manifests point at source files for local TypeScript execution. R11 packaging must prove dist-only installed artifacts even if workspace development keeps source-oriented resolution.
- Fastify route inventory may require parsing `printRoutes()` unless a structured registry is added. The route drift checker must fail closed if it cannot normalize routes.

## Self-Review

1. Spec coverage: all Phase 10 acceptance items are covered by the single task acceptance list and promotion checks.
2. Placeholder scan: no intentional placeholder instructions are left.
3. Type consistency: SDK, CLI, contract, metrics, storage, and compatibility export signatures are locked in the task integration contract.
4. Ownership disjoint: one task owns all implementation files, so there is no cross-task ownership conflict.
5. Context files real: every context file listed above exists in the worktree at plan-authoring time.
6. Acceptance testable: every acceptance item maps to a command or concrete test case.
7. Dependency order sane: one task has no dependency ordering problem; instructions are sequenced from scaffolding through docs.
8. Checks runnable: every listed promotion check is either existing or created by the task with exact package script names.
9. Error/rescue map present: all failure-prone SDK, CLI, contract, storage, daemon, compatibility, release, and docs flows are named.
10. Observability present: runtime and release behavior define logs, success metric, and failure metric.
11. Test cases enumerate acceptance: happy, nil, empty, error, edge, and integration cases cover every acceptance area and rescue path.
12. Integration contracts walk: there are no cross-task imports; exported public contracts are still specified for reviewer/auditor validation.
13. Contract types match: declared SDK/CLI/contract/storage/compatibility signatures are internally consistent.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] The task has acceptance criteria.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error rescue map entry has a matching error, shadow, edge, or integration test case.
- [x] There are no cross-task imports to resolve because this is a single-task plan.
- [x] Every context file path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is intentionally present.
- [x] Complexity L was challenged; the one-task path is chosen because it is the practical path for this manual Phase 10 run.
