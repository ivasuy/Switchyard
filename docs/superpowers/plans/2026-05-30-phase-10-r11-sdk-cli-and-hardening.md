# Phase 10: R11 SDK, CLI, And Hardening — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-10-r11-sdk-cli-and-hardening.md`
**Branch:** `agent/phase-10-r11-sdk-cli-and-hardening`
**Complexity:** L

## Goal

Ship the consumable local Switchyard surface: TypeScript SDK, CLI workflows, deterministic contract output, migration protection, no-spend adapter compatibility automation, local packaging smoke coverage, and operational hardening without expanding hosted/runtime scope.

## Architecture

R11 packages the existing local daemon contract rather than creating a second API. The SDK imports `@switchyard/contracts` schemas and performs fetch/decode/error normalization at the boundary. The CLI imports the SDK for user-facing commands and imports daemon helpers only for local launch/test flows. Contract output is generated from a route inventory shared by tests so drift is caught deterministically.

```
CLI command ──▶ SDK client ──▶ local daemon REST/SSE/raw content
    │              │                    │
    │              ├── Zod decode       ├── request id/error envelope
    │              ├── typed errors     ├── metrics endpoint
    │              └── artifact bytes   └── recovery logs
    │
    ├── contract export ──▶ route inventory ──▶ OpenAPI 3.1 JSON
    ├── compatibility ───▶ adapter manifests + fake harnesses
    └── package smoke ───▶ clean temp pnpm install/run
```

SQLite schema protection stays in `packages/storage`: additive migrations remain the only allowed local policy, schema versioning becomes explicit, and fixture tests verify old local data opens and preserves rows. Operational hardening stays at protocol/daemon boundaries: request ids are attached to error envelopes, local metrics are exposed, startup recovery logs interrupted runs, and all new CLI/debug output avoids secrets and avoids live model/API spend.

## File Structure

- `packages/contracts/src/http-error.ts` — add optional `requestId` typing and reconcile the enum with every error code emitted by `protocol-rest`.
- `packages/contracts/src/endpoint-inventory.ts` — public local-daemon endpoint descriptors owned by the contracts package.
- `packages/contracts/src/openapi.ts` — deterministic OpenAPI 3.1 generation from the public endpoint descriptors and contract schemas.
- `packages/contracts/src/*test.ts` — OpenAPI determinism, route drift, and error-code drift tests.
- `packages/contracts/src/cli.ts` or `packages/contracts/src/openapi-cli.ts` — local script entry for `pnpm --filter @switchyard/contracts openapi:check` / export.
- `packages/protocol-rest/src/http-errors.ts` — include request ids in all structured HTTP errors.
- `packages/protocol-rest/src/*test.ts` — request id, metrics, and route registration snapshot tests that compare against `packages/contracts`.
- `apps/daemon/src/app.ts` — expose `/metrics`, attach request ids, preserve startup recovery behavior, and keep `createDaemonApp` testable.
- `apps/daemon/src/main.ts` — export a reusable daemon start helper for the CLI while preserving the current executable entry.
- `apps/daemon/src/*test.ts` — daemon hardening and startup recovery tests.
- `packages/storage/src/sqlite/database.ts` — explicit schema metadata/version helpers and additive migration policy surface.
- `packages/storage/src/sqlite/*test.ts` — fixture migration tests proving old data survives open/reopen.
- `packages/sdk/*` — new `@switchyard/sdk` package with typed client, errors, SSE replay helper, artifact content helper, and tests against `createDaemonApp`.
- `packages/cli/*` — new `@switchyard/cli` package with `switchyard` binary, command parser, SDK-backed commands, contract export, packaging smoke script/tests.
- `packages/adapters/src/compatibility-matrix.ts` — CI-safe adapter manifest matrix using real manifests and fake/no-spend harnesses.
- `packages/adapters/src/*test.ts` — compatibility matrix tests.
- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `turbo.json`, relevant `tsconfig.json` files — workspace/package wiring only.
- `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, relevant adapter docs, `PROJECT.md` — user-facing truth updates after implementation/audit.

## Existing Context

- `packages/contracts/src/run.ts` and `packages/contracts/src/artifact.ts` already define the public run/artifact schemas. SDK response parsing must import these schemas.
- `packages/contracts/src/http-error.ts` already defines the public error envelope and should only gain backward-compatible optional fields.
- `packages/contracts/src/http-error.ts` currently lags `packages/protocol-rest/src/http-errors.ts`; implementation must add all existing emitted error codes before SDK/OpenAPI decode paths depend on it.
- `packages/protocol-rest/src/run-routes.ts` registers `POST /runs`, list/get/events/artifacts/input/cancel. Contract inventory must match these real routes.
- `packages/protocol-rest/src/artifact-routes.ts` separates artifact metadata at `GET /artifacts/:id` from raw content at `GET /artifacts/:id/content`; SDK must keep those separate.
- `apps/daemon/src/app.ts` exports `createDaemonApp(config?, options?)`, which tests and CLI local launch can reuse without shelling out.
- `apps/daemon/src/main.ts` currently starts the daemon directly with `loadDaemonConfig()` and `createConsoleLogger()`.
- `packages/storage/src/sqlite/database.ts` owns current additive SQLite DDL and additive migrations.
- `packages/testkit/src/runtime-adapter-contract-harness.ts` already provides the no-spend runtime adapter contract harness.
- `packages/adapters/src/index.ts` exports shipped adapters and is the correct place to anchor the compatibility matrix.

## Task Graph

### Task P10-T1-r11-sdk-cli-hardening: Ship SDK, CLI, Contracts, Packaging, And Hardening

**Files (owned):**

- Create/modify `packages/sdk/**`
- Create/modify `packages/cli/**`
- Create/modify `packages/contracts/src/endpoint-inventory.ts`
- Create/modify `packages/contracts/src/openapi.ts`
- Create/modify `packages/contracts/src/*test.ts`
- Modify `packages/protocol-rest/src/http-errors.ts`
- Modify `packages/protocol-rest/src/index.ts`
- Modify `packages/contracts/src/http-error.ts`
- Modify `apps/daemon/src/app.ts`
- Modify `apps/daemon/src/main.ts`
- Create/modify `apps/daemon/src/*.test.ts`
- Modify `packages/storage/src/sqlite/database.ts`
- Create/modify `packages/storage/src/sqlite/*.test.ts`
- Create/modify `packages/adapters/src/compatibility-matrix.ts`
- Create/modify `packages/adapters/src/*.test.ts`
- Modify workspace/package wiring files only as required: `package.json`, `pnpm-lock.yaml`, `turbo.json`, package `tsconfig.json`
- Modify user-facing docs only after implementation truth is known: `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, relevant adapter docs

**Dependencies:** none

**Context files (MUST read before coding):**

- `docs/superpowers/specs/2026-05-30-phase-10-r11-sdk-cli-and-hardening.md`
- `PRODUCT.md`
- `PROJECT.md`
- `package.json`
- `pnpm-workspace.yaml`
- `apps/daemon/src/app.ts`
- `apps/daemon/src/main.ts`
- `apps/daemon/src/config.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/run.ts`
- `packages/contracts/src/event.ts`
- `packages/contracts/src/artifact.ts`
- `packages/contracts/src/http-error.ts`
- `packages/protocol-rest/src/run-routes.ts`
- `packages/protocol-rest/src/artifact-routes.ts`
- `packages/protocol-rest/src/registry-routes.ts`
- `packages/protocol-rest/src/middleware-routes.ts`
- `packages/protocol-rest/src/debate-routes.ts`
- `packages/protocol-rest/src/http-errors.ts`
- `packages/protocol-rest/src/index.ts`
- `packages/storage/src/sqlite/database.ts`
- `packages/storage/src/sqlite/schema.ts`
- `packages/testkit/src/runtime-adapter-contract-harness.ts`
- `packages/testkit/src/fake-runtime-adapter.ts`
- `packages/adapters/src/index.ts`

**Instructions:**

Implement the full R11 release in the Phase 10 worktree only. Keep all required checks local and no-spend. Do not add UI, dashboard, TUI, new runtime adapters, hosted runtime expansion, or live model/API checks.

SDK:

- Add a workspace package named `@switchyard/sdk`.
- Export a `SwitchyardClient` that accepts `{ baseUrl, fetch?, headers?, timeoutMs? }`.
- Implement typed methods for local daemon acceptance: `health()`, `doctor()`, `createRun()`, `getRun()`, `listRuns()`, `listRunEvents()`, `streamRunEvents()` or equivalent live SSE helper, `replayRunEvents()` or equivalent replay helper, `listRunArtifacts()`, `getArtifact()`, `getArtifactContent()`, `sendRunInput()`, `cancelRun()`, provider/runtime/model/runtime-mode discovery, and runtime mode checks.
- Preserve artifact metadata/content separation. `getArtifact()` returns decoded metadata. `getArtifactContent()` returns raw bytes/text plus content type.
- Decode JSON responses with existing `@switchyard/contracts` schemas where schemas already exist. If a response has no pre-existing schema, create the smallest local SDK parser or add a contract schema only if it is genuinely part of the public contract.
- Export typed errors: `SwitchyardHttpError`, `SwitchyardNetworkError`, `SwitchyardDecodeError`, and `SwitchyardTimeoutError`. HTTP errors must preserve `status`, `code`, `message`, `details`, and optional `requestId`.
- Before SDK error decoding, reconcile `packages/contracts/src/http-error.ts` with every key emitted by `packages/protocol-rest/src/http-errors.ts`, including middleware, memory, message, approval, and tool error codes. Add a drift test so this cannot regress.

CLI:

- Add a workspace package named `@switchyard/cli` with a `switchyard` bin.
- Use boring Node APIs and the SDK; do not introduce a command framework unless already installed or strongly justified.
- Commands required: `doctor`, `daemon start`, `run fake`, `runtime test`, `debug run`, and `contract export`.
- `doctor` calls local daemon `/doctor` when available and prints deterministic JSON by default or a concise human format if a flag is added.
- `daemon start` starts the local daemon through exported daemon helpers and exits cleanly on `SIGINT`/`SIGTERM`.
- `run fake` creates a deterministic fake run and can wait for completion using existing daemon semantics.
- `runtime test` runs a CI-safe no-spend runtime mode check or adapter compatibility matrix entry. It must not call live external providers.
- `debug run <id>` prints run metadata, recent events, artifacts, and typed error/request-id details.
- `contract export` writes deterministic OpenAPI 3.1 JSON to stdout or a provided path.

Contract output:

- Add public endpoint descriptors in `packages/contracts`, not `packages/protocol-rest`. Protocol-rest may have route-registration snapshot tests, but the generated public contract belongs to `@switchyard/contracts`.
- Generate deterministic OpenAPI 3.1 JSON from that inventory. Use stable key ordering and add `openapi:generate` / `openapi:check` package scripts.
- Represent SSE and raw artifact content correctly with content types and `x-switchyard-*` extensions when OpenAPI cannot express behavior fully.
- Add a drift test that compares inventory paths/methods to routes registered by `createDaemonApp()`.
- Add a generator validation test for empty inventories, unsupported content types, and schema conversion failures.
- If hosted/node R10 routes are included, tag them as a separate surface and do not expand SDK/CLI required acceptance to cover hosted execution.

Migration policy:

- Add explicit local schema metadata/versioning in SQLite. Keep the current migration style additive.
- Provide a programmatic migration policy export that blocks destructive operations by policy.
- Add fixture migration tests for representative pre-R3, pre-R7, pre-R9, and pre-R11 SQL snapshots. They must preserve rows across runs, events, sessions, artifacts, registry, middleware, debate, and placement tables when those tables exist in the snapshot.
- Add corrupt/zero-byte DB failure tests and reopen-idempotency tests. Migration failure must abort visibly and never silently overwrite a configured database.

Adapter compatibility matrix:

- Add a CI-safe matrix generated from real adapter manifests and fake harness inputs.
- Cover at least fake native, Codex exec-json in fake/no-spend mode where possible, OpenCode fake ACP, generic HTTP fake server, AgentField fake server, and Claude Code fake client. If a real adapter cannot be run without external dependencies, mark the matrix row as `skipped` with a deterministic reason instead of failing silently.

Packaging and smoke:

- Ensure the SDK and CLI packages typecheck/build in the workspace.
- Add a clean temporary smoke test that packs or links the local packages, installs them into a temp project, imports the SDK, invokes the CLI help/contract export, and proves no hand-written curl workflow is required.
- Keep the test deterministic and local. Avoid global installs and external network requirements.

Operational hardening:

- Add request ids to error envelopes as a backward-compatible optional field.
- Expose local metrics sufficient for acceptance: request count/error count and run status counts are enough.
- Ensure startup recovery of interrupted runs is logged and covered by tests for `starting`, `running`, `waiting_for_input`, and `waiting_for_approval` runs, failed active sessions, already-terminal no-op, duplicate-startup idempotency, corrupt-row visible failure, and recovery metrics/log counts.
- Use structured logs for new CLI/daemon hardening paths without leaking credentials.

Internal implementation order:

1. Reconcile contract/protocol error codes and add request-id-compatible error envelope tests.
2. Move public endpoint inventory/OpenAPI generation into `packages/contracts`; wire contract scripts and drift tests against `createDaemonApp()`.
3. Add daemon hardening: request ids, metrics, and full startup recovery idempotency.
4. Add SQLite schema metadata/versioning, migration policy, fixture matrix, and corrupt DB behavior.
5. Add SDK typed client and tests against the hardened daemon.
6. Add adapter compatibility matrix and CLI commands backed by SDK/contracts/matrix.
7. Add clean temp packaging smoke and docs truth updates.

**Acceptance criteria:**

- [ ] `@switchyard/sdk` can create a fake local run, inspect it, replay/list events, fetch artifact metadata/content, and raise typed HTTP/network/decode errors against an in-process local daemon.
- [ ] `@switchyard/cli` supports `doctor`, `daemon start`, `run fake`, `runtime test`, `debug run`, and `contract export`.
- [ ] Contract output is deterministic OpenAPI 3.1 or equivalent typed contract JSON and drift-tested against actual local daemon routes.
- [ ] SQLite migration policy/schema versioning is explicit and fixture migration tests preserve old local data.
- [ ] Adapter compatibility matrix runs in CI-safe/no-spend mode and reports deterministic pass/skip/fail rows.
- [ ] Local release packaging smoke installs/uses SDK and CLI from a clean temp environment.
- [ ] Request ids, hardened error envelopes, metrics, structured logs, and startup recovery tests are present.
- [ ] No UI/TUI/dashboard, no live external model/API spend, and no hosted runtime expansion is introduced.

**Checks (must pass before GREEN):**

- `pnpm install --lockfile-only`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm --filter @switchyard/sdk test`
- `pnpm --filter @switchyard/cli test`
- `pnpm --filter @switchyard/protocol-rest test`
- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/adapters test`
- `pnpm --filter @switchyard/daemon test`
- `pnpm test`
- `pnpm typecheck`
- `git diff --check`

**Error rescue map:**

| Method / codepath | What can go wrong | Exception / condition | Rescue action | User sees |
| --- | --- | --- | --- | --- |
| SDK HTTP request | Daemon unreachable | `TypeError` or fetch rejection | Throw `SwitchyardNetworkError` with URL/method | CLI prints daemon unreachable with command hint |
| SDK HTTP request | Timeout | `AbortError` from `AbortController` | Throw `SwitchyardTimeoutError` | CLI prints timeout and configured timeout seconds |
| SDK HTTP request | 4xx/5xx with error envelope | HTTP status plus decoded `httpErrorEnvelopeSchema` | Throw `SwitchyardHttpError` with code/details/requestId | CLI prints code/message/requestId |
| SDK input validation | Missing run/artifact id or invalid options | explicit validation condition | Throw `SwitchyardValidationError` or reuse `SwitchyardDecodeError` only for remote decode failures | CLI prints usage or invalid argument message |
| SDK SSE stream | Malformed SSE frame or abort signal | parse condition or `AbortError` | Close reader, throw typed decode/timeout error without yielding partial events | CLI debug reports stream failure with request id when available |
| SDK HTTP request | 4xx/5xx malformed body | JSON parse or schema decode failure | Throw `SwitchyardDecodeError` containing status/request id if present | CLI prints invalid daemon response |
| SDK JSON decode | Successful response shape drift | Zod parse failure or explicit validation failure | Throw `SwitchyardDecodeError` | Tests fail; user gets contract drift message |
| SDK artifact content | Raw content not JSON | non-JSON content type | Return bytes/text without JSON decode | User receives content plus content type |
| CLI command parsing | Missing/invalid args | explicit validation condition | Exit 2 with command-specific message | Concise usage error |
| CLI daemon start | Port already in use | Fastify listen error code | Exit non-zero and preserve error code/message | Port-in-use message |
| CLI daemon start | Readiness timeout after listen attempt | explicit timeout condition | Close server if opened and exit non-zero | Readiness timeout message |
| CLI contract export | Output path unwritable | filesystem `EACCES`/`ENOENT` | Exit non-zero, do not partial-write where possible | File write failure message |
| OpenAPI generation | Unsupported route content type | explicit inventory validation failure | Throw at generation/test time | Contract test failure names route |
| OpenAPI generation | Empty inventory or schema conversion failure | explicit validation failure | Throw at generation/test time | Contract test failure names inventory/schema issue |
| Route drift test | Registered route missing from inventory | route set mismatch | Fail test with method/path diff | Developer sees exact drift |
| SQLite migration | Existing DB has no metadata table | metadata table absent | Create metadata and set current version after additive migrations | Startup continues; test proves rows preserved |
| SQLite migration | Destructive migration proposed | policy validation sees drop/rename/destructive SQL | Reject migration in tests/helpers | Test failure names forbidden statement |
| SQLite migration | Corrupt or zero-byte DB | sqlite open/query failure or explicit file-size check | Abort startup; never overwrite configured DB | CLI/daemon prints named storage failure |
| SQLite migration | Additive migration fails midway | sqlite migration exception | Roll back current statement/transaction and leave visible failure | Startup fails with migration error |
| Compatibility matrix | Adapter cannot run CI-safe | manifest row lacks fake harness | Return skipped with reason | CLI/test report shows deterministic skip |
| Startup recovery | Interrupted runs exist | run/session status active on boot | Mark/record recovery according to existing behavior and log count | Operator sees structured recovery log |
| Startup recovery | Daemon restarts twice over same interrupted run | existing terminal event/recovered marker | No duplicate terminal event; metrics/log count stays stable | Operator sees idempotent recovery count |

**Observability:**

```json
{
  "logs": [
    "daemon.request.error includes requestId, method, path, status, error.code",
    "daemon.startup.recovered_runs includes count and run ids or bounded sample",
    "cli.command.failed includes command, error class, and requestId when present",
    "compatibility.matrix.completed includes pass/skip/fail counts"
  ],
  "success_metric": "local contract, SDK, CLI, migration, packaging, and adapter matrix tests pass without network/API spend",
  "failure_metric": "typed SDK/CLI errors include class, code/status when applicable, and requestId for daemon HTTP failures"
}
```

**Test cases:**

- `{ "name": "sdk_fake_run_lifecycle", "lens": "integration", "given": "in-process createDaemonApp and SwitchyardClient", "expect": "createRun returns a run; getRun/listRunEvents/listRunArtifacts/getArtifact/getArtifactContent succeed" }`
- `{ "name": "sdk_http_error_typed", "lens": "error_path", "given": "getRun for missing id", "expect": "SwitchyardHttpError with run_not_found, status 404, optional requestId" }`
- `{ "name": "sdk_all_daemon_error_codes_typed", "lens": "error_path", "given": "each error code emitted by protocol-rest", "expect": "contracts httpErrorEnvelopeSchema accepts it and SDK returns SwitchyardHttpError, not SwitchyardDecodeError" }`
- `{ "name": "sdk_network_error_typed", "lens": "error_path", "given": "client pointed at closed localhost port", "expect": "SwitchyardNetworkError" }`
- `{ "name": "sdk_timeout_error_typed", "lens": "error_path", "given": "fetch never resolves and timeoutMs elapses", "expect": "SwitchyardTimeoutError" }`
- `{ "name": "sdk_decode_error_typed", "lens": "error_path", "given": "fetch returns malformed JSON for a JSON endpoint", "expect": "SwitchyardDecodeError" }`
- `{ "name": "sdk_validation_error_missing_ids", "lens": "error_path", "given": "empty run id or artifact id", "expect": "typed validation/argument error before fetch" }`
- `{ "name": "sdk_stream_abort_and_malformed_sse", "lens": "error_path", "given": "aborted stream and malformed SSE frame", "expect": "reader closes and typed error is raised without partial event" }`
- `{ "name": "sdk_cancel_and_send_input_supported_or_typed_unsupported", "lens": "integration", "given": "fake local run", "expect": "cancel and send input return accepted/supported state or typed unsupported/adapter error" }`
- `{ "name": "cli_doctor_json", "lens": "integration", "given": "local daemon URL", "expect": "doctor command prints deterministic JSON and exits 0" }`
- `{ "name": "cli_run_fake_wait", "lens": "integration", "given": "local daemon URL", "expect": "run fake creates and completes a fake run without external API spend" }`
- `{ "name": "cli_runtime_test_no_spend", "lens": "happy_shadow_nil", "given": "no external credentials", "expect": "runtime test uses fake/no-spend matrix and reports pass/skip rows" }`
- `{ "name": "cli_debug_missing_run", "lens": "error_path", "given": "missing run id", "expect": "typed HTTP error output includes run_not_found and requestId when available" }`
- `{ "name": "cli_debug_remediation_codes", "lens": "error_path", "given": "known SDK error classes", "expect": "debug/doctor output includes deterministic remediation code without leaking secrets" }`
- `{ "name": "cli_invalid_args", "lens": "error_path", "given": "missing command args", "expect": "exit 2, stderr usage, stdout empty for JSON commands" }`
- `{ "name": "cli_daemon_start_port_in_use", "lens": "error_path", "given": "requested port already bound", "expect": "non-zero exit and port-in-use message" }`
- `{ "name": "cli_daemon_start_readiness_timeout", "lens": "error_path", "given": "daemon never becomes ready", "expect": "server closed and readiness timeout printed" }`
- `{ "name": "cli_contract_export_unwritable", "lens": "error_path", "given": "unwritable output path", "expect": "non-zero exit and no partial contract file" }`
- `{ "name": "contract_export_deterministic", "lens": "happy", "given": "two OpenAPI generations", "expect": "byte-identical JSON" }`
- `{ "name": "contract_route_drift", "lens": "integration", "given": "createDaemonApp registered routes", "expect": "inventory methods/paths match local daemon route set" }`
- `{ "name": "contract_empty_inventory_rejected", "lens": "error_path", "given": "empty endpoint descriptor list", "expect": "generator validation fails before writing output" }`
- `{ "name": "contract_unsupported_content_type_rejected", "lens": "error_path", "given": "descriptor with unsupported content type", "expect": "generator validation names method/path" }`
- `{ "name": "contract_schema_conversion_failure", "lens": "error_path", "given": "descriptor with unsupported schema reference", "expect": "generator validation names schema reference" }`
- `{ "name": "artifact_content_openapi_extension", "lens": "edge_raw_content", "given": "GET /artifacts/:id/content", "expect": "OpenAPI content types or x-switchyard extension documents raw content" }`
- `{ "name": "sqlite_pre_r3_fixture_migration", "lens": "integration", "given": "pre-R3 SQLite snapshot", "expect": "runs/events/artifacts/registry rows preserved and schema version recorded" }`
- `{ "name": "sqlite_pre_r7_fixture_migration", "lens": "integration", "given": "pre-R7 SQLite snapshot", "expect": "sessions/runtime modes/registry rows preserved and schema version recorded" }`
- `{ "name": "sqlite_pre_r9_fixture_migration", "lens": "integration", "given": "pre-R9 SQLite snapshot", "expect": "middleware/debate/placement-capable rows preserved and schema version recorded" }`
- `{ "name": "sqlite_pre_r11_fixture_migration", "lens": "integration", "given": "pre-R11 SQLite snapshot without metadata table", "expect": "all current rows preserved and schema version recorded" }`
- `{ "name": "sqlite_destructive_policy_rejected", "lens": "error_path", "given": "DROP TABLE/ALTER TABLE RENAME migration statement", "expect": "policy helper rejects it" }`
- `{ "name": "sqlite_corrupt_or_zero_byte_rejected", "lens": "error_path", "given": "corrupt and zero-byte configured DB files", "expect": "startup fails visibly and does not overwrite" }`
- `{ "name": "sqlite_migration_reopen_idempotent", "lens": "integration", "given": "migrated fixture opened twice", "expect": "schema version and preserved row counts unchanged" }`
- `{ "name": "adapter_matrix_ci_safe", "lens": "integration", "given": "real adapter manifests with fake harnesses", "expect": "deterministic pass/skip/fail matrix and no live provider spend" }`
- `{ "name": "package_smoke_clean_temp", "lens": "integration", "given": "temporary project", "expect": "SDK import, CLI help, and contract export work from packed/linked local packages" }`
- `{ "name": "package_smoke_dist_exports", "lens": "integration", "given": "clean temp install outside repo", "expect": "installed SDK/CLI exports resolve to dist/package exports, not workspace src symlinks" }`
- `{ "name": "daemon_error_request_id", "lens": "error_path", "given": "invalid local daemon request", "expect": "error envelope includes requestId and SDK preserves it" }`
- `{ "name": "daemon_metrics", "lens": "happy", "given": "health/error/run requests", "expect": "metrics endpoint reports request/error/run status counts" }`
- `{ "name": "daemon_startup_recovery_state_matrix", "lens": "integration", "given": "starting/running/waiting_for_input/waiting_for_approval runs and active sessions", "expect": "all are recovered to terminal/non-active state with structured log and metric counts" }`
- `{ "name": "daemon_startup_recovery_idempotent", "lens": "integration", "given": "same interrupted DB opened twice", "expect": "no duplicate terminal events and stable recovery counts" }`
- `{ "name": "daemon_startup_recovery_corrupt_row_visible", "lens": "error_path", "given": "persisted active row with invalid status/payload", "expect": "startup fails or reports named recovery failure instead of silent success" }`

**Integration contracts:**

```json
{
  "exports": [
    {
      "name": "SwitchyardClient",
      "kind": "class",
      "signature": "new SwitchyardClient(options: SwitchyardClientOptions)"
    },
    {
      "name": "SwitchyardHttpError",
      "kind": "class",
      "signature": "class SwitchyardHttpError extends Error { status: number; code: HttpErrorCode; details?: HttpErrorDetail[]; requestId?: string }"
    },
    {
      "name": "generateOpenApiDocument",
      "kind": "function",
      "signature": "generateOpenApiDocument(options?: { surface?: 'local-daemon' | 'hosted-node' | 'all' }) => OpenApiDocument",
      "owner": "packages/contracts"
    },
    {
      "name": "LOCAL_DAEMON_ROUTE_INVENTORY",
      "kind": "constant",
      "signature": "readonly RouteInventoryEntry[]",
      "owner": "packages/contracts"
    },
    {
      "name": "runCompatibilityMatrix",
      "kind": "function",
      "signature": "runCompatibilityMatrix(options?: { ciSafe?: boolean }) => Promise<CompatibilityMatrixResult>"
    },
    {
      "name": "SQLITE_SCHEMA_VERSION",
      "kind": "constant",
      "signature": "number"
    },
    {
      "name": "validateSqliteMigrationPolicy",
      "kind": "function",
      "signature": "validateSqliteMigrationPolicy(statements: readonly string[]) => void"
    }
  ],
  "imports_from_other_tasks": [],
  "file_paths_consumed_by_other_tasks": []
}
```

## Risks

- This is a large single task because the user requested one implementer/reviewer pair per phase. The implementer must keep changes modular, follow the internal order above, and use checkpoint commits or at least clearly separated file groups so reviewer/auditor can isolate failures.
- Package smoke can be slow if it performs full workspace packing. Prefer deterministic local temp import/bin smoke with workspace build artifacts unless a stricter pack test is easy and fast.
- OpenAPI cannot fully model SSE behavior and arbitrary raw artifact bytes; document those responses with correct content types plus `x-switchyard-*` extensions.
- Some real runtime adapters cannot be executed CI-safe without local binaries or credentials. Matrix rows should explicitly skip with stable reasons rather than overclaiming pass coverage.

## Integration Points

The CLI depends on the SDK and `@switchyard/contracts` contract generator. The SDK depends on contracts and fetch only. The daemon/protocol hardening is independent but required for typed SDK/CLI request-id behavior. Storage migration tests are independent except for daemon startup recovery coverage. The adapter compatibility matrix is independent but exposed through the CLI `runtime test` path.

```
contracts ─┬─▶ contracts/openapi ─────▶ cli contract export
           ├─▶ sdk ───────────────────▶ cli doctor/run/debug
           └─▶ daemon errors/metrics

storage sqlite ─▶ daemon startup recovery
adapters/testkit ─▶ compatibility matrix ─▶ cli runtime test
```

## Acceptance Criteria (Phase-Level)

- [ ] TypeScript SDK can create a run, inspect events, fetch artifacts, and handle typed errors against local daemon.
- [ ] CLI can run doctor checks and launch a local fake run.
- [ ] OpenAPI/contract output matches implemented endpoints.
- [ ] Migration tests protect existing local data.
- [ ] Compatibility matrix checks run CI-safe mode.
- [ ] Release packaging can be installed and smoke-tested from a clean environment.
- [ ] App developers and operators can consume Switchyard without hand-written curl workflows.
