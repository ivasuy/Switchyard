# Phase 10 Spec: R11 SDK, CLI, And Hardening

Date: 2026-05-30

Run: `native-roadmap-20260529`

Roadmap release: R11: SDK, CLI, And Hardening

Branch: `agent/phase-10-r11-sdk-cli-and-hardening`

Previous phase head: `7633cb569eca8706ee169e6dc7291dc72831ed1f`

Spec target: `docs/superpowers/specs/2026-05-30-phase-10-r11-sdk-cli-and-hardening.md`

## Problem

Switchyard now has enough local daemon and R10 hosted-like/hybrid API surface to be consumed without hand-written curl commands, but app developers and operators still lack stable client tooling, generated contract output, release packaging, and operational guardrails. R11 turns the current local daemon into a consumable product surface: a TypeScript SDK, CLI workflows, endpoint contract generation, migration protection, adapter compatibility automation, local release packaging, and observability/recovery hardening.

This release must stay narrow. It packages and hardens the existing API; it does not introduce a broad UI, dashboard, new hosted execution modes, new model-backed runtime behavior, or external service dependencies.

## Goals

- Ship a TypeScript SDK that can create local daemon runs, inspect/replay events, fetch artifact metadata/content, and expose typed HTTP/network/decode errors.
- Ship a CLI that can run doctor checks, start a local daemon, launch a deterministic fake run, run a no-spend runtime test, and debug a run from the local daemon.
- Generate OpenAPI 3.1 contract output, or an equivalent typed contract artifact if OpenAPI cannot represent a response exactly, from the same schema inventory used by tests.
- Prove generated contract output matches the routes actually registered by the local daemon and shared REST protocol packages.
- Formalize migration policy and tests so existing local SQLite data survives R11 schema changes and daemon restarts.
- Automate an adapter compatibility matrix in CI-safe/no-spend mode from real adapter manifests and fake harnesses.
- Package the local daemon, CLI, SDK, and required local dependencies so a clean temporary environment can install and smoke-test them deterministically.
- Harden logs, error envelopes, metrics, startup recovery, and debug output so failures are named, visible, and actionable.

## Non-Goals

- No broad UI, dashboard, TUI, web console, or visual monitoring surface.
- No new runtime adapters, runtime capabilities, hosted runtime expansion, hosted Codex/Claude/OpenCode execution, production sandboxing, model judging, or real tool execution.
- No enterprise auth, OAuth, billing, multi-tenant authorization, quotas, or hosted production operations.
- No remote API spend during required tests. Codex, Claude, OpenCode, Generic HTTP, and AgentField coverage must use existing fake clients/processes/servers unless a developer manually opts into live checks outside required CI.
- No SDK-first rewrite of the daemon or route handlers. R11 must package and test the existing contract, not create a second API.
- No destructive migration of local data. Column/table drops, renames, and lossy backfills are blocked unless a future spec explicitly approves them.

## Existing Context

R11 is explicitly planned in `PRODUCT.md` as the packaging and hardening release:

```md
### R11: SDK, CLI, And Hardening

Release scope:

- TypeScript SDK.
- OpenAPI generation or equivalent typed contract output.
- CLI for doctor, local launch, runtime test, and debugging.
- migration policy and migration test strategy.
- adapter compatibility matrix automation.
- release packaging for local daemon.
- operational hardening for logs, errors, metrics, and recovery.
```

`PROJECT.md` Phase 9 records the R10 closeout boundary R11 must start from:

```md
R10 is now shipped on the phase branch. Switchyard adds hosted-like and
connected-node execution while preserving the existing public run contract.
```

The workspace is a pnpm/Turborepo TypeScript monorepo. New SDK/CLI packages must follow this package shape instead of inventing a different build system:

`package.json`:

```json
{
  "name": "switchyard",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.4",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Existing public schemas live in `packages/contracts`. SDK and generated contract output must import these schemas rather than duplicating type definitions:

`packages/contracts/src/run.ts`:

```ts
export const runSchema = z.object({
  id: runIdSchema,
  runtime: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  adapterType: adapterTypeSchema,
  cwd: z.string().min(1),
  task: z.string().min(1),
  status: runStatusSchema,
  placement: executionPlacementSchema,
  approvalPolicy: z.string().min(1),
  timeoutSeconds: z.number().int().positive(),
  metadata: metadataSchema.default({}),
  runtimeMode: runtimeModeSlugSchema.optional(),
  createdAt: isoDateSchema,
  startedAt: isoDateSchema.optional(),
  endedAt: isoDateSchema.optional()
});
```

`packages/contracts/src/artifact.ts`:

```ts
export const artifactSchema = z.object({
  id: artifactIdSchema,
  runId: runIdSchema.optional(),
  debateId: debateIdSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  type: artifactTypeSchema,
  path: z.string().min(1),
  metadata: metadataSchema.default({}),
  createdAt: isoDateSchema
});
```

The current HTTP error envelope is already structured. R11 must type this in the SDK and may only add backward-compatible optional fields such as `requestId`:

`packages/contracts/src/http-error.ts`:

```ts
export const httpErrorEnvelopeSchema = z.object({
  error: z.object({
    code: httpErrorCodeSchema,
    message: z.string().min(1),
    details: z.array(httpErrorDetailSchema).optional()
  })
});
```

The local run route is hand-written today. Contract generation must be checked against these real registered routes:

`packages/protocol-rest/src/run-routes.ts`:

```ts
app.post("/runs", async (request, reply) => {
  const wait = shouldWaitForCompletion(request.query);
  const body = parseCreateRunBody(request.body);
  const renderedContext = body.context
    ? await buildRunContext(body, deps.contextBuilder)
    : undefined;
  const runtimeMode = await inferRuntimeMode(body, deps.registryService);
  const metadata = body.metadata ?? {};
  const createInput: Parameters<RunService["createRun"]>[0] = {
    runtime: body.runtime,
    provider: body.provider,
    model: body.model,
    adapterType: body.adapterType,
    cwd: body.cwd,
    task: renderedContext ? renderRunTask(body.task, renderedContext.rendered) : body.task,
    placement: body.placement ?? "local",
    approvalPolicy: body.approvalPolicy ?? "default",
    timeoutSeconds: body.timeoutSeconds ?? 600,
    metadata: renderedContext
      ? { ...metadata, originalTask: body.task, contextPacket: renderedContext.context }
      : metadata
  };
});
```

Artifact metadata and raw content are separate endpoints. The SDK must preserve that distinction:

`packages/protocol-rest/src/artifact-routes.ts`:

```ts
app.get("/artifacts/:id", async (request, reply) => {
  const artifact = await deps.artifacts.get(id);
  if (!artifact) {
    return sendHttpError(reply, "artifact_not_found", `Artifact not found: ${id}`);
  }
  return { artifact };
});

app.get("/artifacts/:id/content", async (request, reply) => {
  const payload = await deps.artifactContent.read(artifact);
  const contentType = payload.contentType || contentTypeForArtifact(artifact.type);
  return reply.header("content-type", contentType).send(payload.body);
});
```

The daemon registers these local REST surfaces today:

```text
GET /health
POST /runs
GET /runs
GET /runs/:id
GET /runs/:id/events
GET /runs/:id/artifacts
POST /runs/:id/input
POST /runs/:id/cancel
GET /artifacts/:id
GET /artifacts/:id/content
GET /providers
GET /providers/:id
GET /runtimes
GET /runtimes/:id
GET /models
GET /models/:id
GET /runtime-modes
GET /runtime-modes/:id
POST /runtime-modes/:id/check
GET /doctor
POST /messages
GET /messages
GET /messages/:id
POST /memory
GET /memory
GET /memory/:id
GET /memory/search
POST /evidence
GET /evidence
GET /evidence/:id
POST /context
POST /approvals
GET /approvals
GET /approvals/:id
POST /approvals/:id/approve
POST /approvals/:id/reject
POST /tools/invocations
GET /tools/invocations
GET /tools/invocations/:id
POST /debates
GET /debates/:id
GET /debates/:id/events
```

R10 also registers `/nodes/*` routes in `apps/server` through `packages/protocol-node`. R11 contract output may include those as a separate hosted/node surface, but the required SDK and CLI acceptance is local-daemon-only unless explicitly called out below.

SQLite storage already uses additive migrations and a small additive migration list:

`packages/storage/src/sqlite/database.ts`:

```ts
const additiveMigrations: Array<{ table: string; column: string; statement: string }> = [
  {
    table: "runtimes",
    column: "provider_id",
    statement: "ALTER TABLE runtimes ADD COLUMN provider_id TEXT"
  },
  {
    table: "runs",
    column: "runtime_mode",
    statement: "ALTER TABLE runs ADD COLUMN runtime_mode TEXT"
  },
  {
    table: "runtime_sessions",
    column: "runtime_mode",
    statement: "ALTER TABLE runtime_sessions ADD COLUMN runtime_mode TEXT"
  }
];
```

Adapter contract coverage already exists in no-spend form:

`packages/adapters/test/runtime-adapter-contracts.test.ts`:

```ts
it("passes for codex adapter with fake process", async () => {
  const adapter = new CodexExecJsonAdapter({
    processFactory: () => {
      const fake = new FakeCodexProcess();
      queueMicrotask(() => {
        fake.stdout.write("{\"type\":\"thread.started\",\"thread_id\":\"thread_1\"}\n");
        fake.stdout.write("{\"type\":\"turn.completed\"}\n");
        fake.stdout.end();
        fake.stderr.end();
        fake.emit("exit", 0, null);
      });
      return fake as never;
    }
  });
});
```

The fake runtime is the required deterministic smoke target for SDK, CLI, compatibility, and packaging tests:

`packages/testkit/src/fake-runtime-adapter.ts`:

```ts
yield {
  id: "event_fake_output",
  type: "runtime.output",
  runId,
  sequence: 2,
  payload: { text: "fake runtime output" },
  createdAt
};
```

## Architecture

R11 adds two public packages and hardens existing daemon/protocol packages:

- `packages/sdk` (`@switchyard/sdk`) exports a `SwitchyardClient`, request/response types, schema-validated response helpers, SSE event replay/stream helpers, artifact content helpers, and typed errors.
- `packages/cli` (`@switchyard/cli`) exposes the `switchyard` binary. It depends on the SDK and the packaged daemon entrypoint, not on curl or shell-only behavior.
- `packages/contracts` becomes the source of contract output. It owns endpoint descriptors, shared request/response schemas, OpenAPI 3.1 generation, and contract drift tests.
- `apps/daemon` exposes an installable local daemon binary, request/log/metrics middleware, and startup recovery behavior.
- `packages/adapters` and `packages/testkit` produce a deterministic compatibility matrix from adapter manifests and fake harness scenarios.
- `packages/storage` owns migration policy enforcement and migration fixture tests for local SQLite data.

The SDK and CLI talk to the local daemon over HTTP using the documented base URL, defaulting to `http://127.0.0.1:4545`. The SDK must not import daemon internals or storage internals. The CLI may spawn the packaged daemon binary for `daemon start` and clean local smoke workflows, but all run, doctor, debug, and artifact behavior must still go through the HTTP/SDK layer so CLI behavior proves the public contract.

OpenAPI generation must not be hand-maintained prose. A typed endpoint inventory must define method, path, query/body schemas, success response schemas, error envelope, content types, SSE/raw response flags, and surface tags (`daemon-local`, `server-hosted`, `node-protocol`). Tests must compare this inventory with the real Fastify route registrations from `createDaemonApp` and, where included, `createServerApp`.

Operational hardening stays local and deterministic. Logs are structured, errors are named, metrics are local process counters/gauges, and startup recovery only reconciles local persisted state that the daemon owns.

## User-Visible Behavior

- SDK happy path: an app creates `new SwitchyardClient({ baseUrl })`, calls `createRun({ wait: true, runtime: "fake", provider: "test", model: "test-model", adapterType: "process", cwd: "/repo", task: "Smoke" })`, receives a typed completed run with `response.text === "fake runtime output"`, replays events, lists artifacts, and fetches transcript content.
- SDK error path: an app calls `getRun("run_missing")` and catches `SwitchyardHttpError` with `status === 404`, `code === "run_not_found"`, a sanitized message, optional details, and optional request id.
- CLI doctor path: `switchyard doctor --base-url http://127.0.0.1:4545` checks `/health`, `/doctor`, and runtime-mode inventory, then prints a concise human summary and exits non-zero when the daemon is unreachable or the health payload is invalid. `--json` emits a machine-readable result.
- CLI local launch path: `switchyard daemon start --port 4545 --data-dir <dir>` starts the packaged local daemon with visible readiness output and clear failure messages for occupied ports, unwritable data directories, or startup timeouts.
- CLI fake-run path: `switchyard run fake --wait --cwd /repo --task "Smoke"` creates a deterministic fake run through the local daemon and prints the run id, final status, final response text, event count, and artifact count.
- CLI runtime test path: `switchyard runtimes test fake.deterministic` runs a no-spend check and deterministic fake run. Non-fake runtime tests default to doctor/check-only and must label any opt-in live execution as manual.
- CLI debug path: `switchyard debug run <run_id>` prints run status, event timeline, artifact list, content availability, and named remediation hints for missing run, missing artifact content, adapter protocol failure, timeout, and daemon restart recovery cases.
- Contract output path: `pnpm --filter @switchyard/contracts openapi:generate` writes deterministic OpenAPI output, and `openapi:check` fails if committed/generated output differs from endpoint descriptors or real route registration.
- Packaging path: a clean temporary directory can install the local release bundle, run `switchyard daemon start`, run `switchyard doctor`, create a fake run, fetch its artifact content, stop the daemon, and remove the temp data dir without external model/API calls.

## Data Flow Shadow Paths

| Flow | Happy path | Nil path | Empty path | Error path |
| --- | --- | --- | --- | --- |
| SDK request body to `POST /runs` | Valid run request returns typed `{ run }` for async or `{ run, response }` for `wait=1`. | Missing body or missing required fields throws `SwitchyardHttpError` with `invalid_input`; SDK does not retry. | Empty string fields such as `task: ""` or `cwd: ""` return `invalid_input`; SDK exposes `details[].path`. | Network failure throws `SwitchyardNetworkError`; invalid success JSON throws `SwitchyardDecodeError`; HTTP error JSON throws `SwitchyardHttpError`. |
| SDK event replay/stream | `getRunEvents(runId)` parses SSE replay into typed `SwitchyardEvent[]`; `streamRunEvents` yields typed events and supports `Last-Event-ID`. | Missing `runId` is rejected client-side as `SwitchyardValidationError` before HTTP. | Replay with no events returns an empty array for helper mode; streaming mode closes cleanly when the server ends. | Malformed SSE frame throws `SwitchyardStreamError` with last event id if known; 404 throws `run_not_found`. |
| SDK artifact fetch | `listRunArtifacts`, `getArtifact`, and `getArtifactContent` return typed metadata plus raw body/content type. | Missing artifact id is rejected client-side. | Zero artifacts returns `[]`; zero-byte content returns an empty `Uint8Array` or empty string without treating it as missing. | `artifact_not_found` and `missing_artifact_content` remain distinct typed HTTP errors; unsupported content type does not corrupt bytes. |
| CLI daemon launch | CLI spawns packaged daemon, waits for `/health`, prints base URL and pid, and exits according to foreground/detached mode. | Missing port/data-dir options use documented defaults. | Empty `--data-dir ""` or invalid numeric flags fail argument validation before spawn. | Port in use, unwritable directory, child exit, and readiness timeout each produce a named CLI error and non-zero exit. |
| CLI fake run | CLI uses SDK to create `fake.deterministic` `wait=1`, then prints final text/events/artifacts. | Missing daemon base URL uses default local URL. | Empty task defaults to a safe `"Switchyard CLI fake smoke"` task only for the fake-run command. | Daemon unreachable, invalid response, timeout, and typed HTTP errors print user-readable remediation and preserve machine-readable JSON with `--json`. |
| Contract output | Endpoint inventory generates deterministic OpenAPI JSON and typed endpoint map. | Missing endpoint descriptor for a registered route fails `openapi:check`. | Empty route inventory fails generation with a named `contract_inventory_empty` error. | Schema conversion failure, raw/SSE unsupported shape, or drift between descriptors and Fastify route list fails CI with method/path details. |
| SQLite migration | Existing DB opens, additive migrations apply once, data remains queryable, and schema version is recorded. | Missing DB path creates a new DB with current schema. | Empty zero-byte DB path fails with a clear corrupt/invalid database error and does not overwrite it. | Migration error aborts daemon startup, logs `storage.migration.failed`, leaves original DB readable, and points to backup/recovery guidance. |
| Compatibility matrix | CI builds matrix from every registered adapter manifest and fake harness scenario. | Missing manifest or runtimeModeSlug fails matrix generation. | No adapters found fails with `compatibility_matrix_empty`. | Any live network/model dependency in required CI mode fails the test; fake harness failure names adapter, scenario, and capability. |
| Release packaging smoke | Clean temp install starts daemon, runs doctor, fake run, event replay, artifact content fetch, then shutdown. | Missing release tarball/bundle path fails before install. | Empty package directory fails with `release_bundle_empty`. | Install failure, missing bin, daemon startup failure, smoke failure, or non-deterministic output exits non-zero and leaves logs in the temp report dir. |
| Logs/errors/metrics/recovery | Requests get request ids, logs are structured, metrics increment, interrupted active runs reconcile on startup. | Missing request id header generates one. | Empty metrics registry still returns valid zero counters/gauges. | Unhandled errors are sanitized, emit `internal_error` with request id, log details server-side, and never leak stack traces to SDK/CLI users. |

## Functional Requirements

### TypeScript SDK

- Add `packages/sdk` with package name `@switchyard/sdk`, ESM output, `.d.ts` types, and exports from `dist`.
- Public SDK exports must include:
  - `SwitchyardClient`
  - `SwitchyardHttpError`
  - `SwitchyardNetworkError`
  - `SwitchyardDecodeError`
  - `SwitchyardValidationError`
  - `SwitchyardStreamError`
  - endpoint request/response types re-exported from `@switchyard/contracts`
- `SwitchyardClient` must support:
  - `health()`
  - `doctor()`
  - `listRuntimeModes(query?)`
  - `checkRuntimeMode(idOrSlug)`
  - `createRun(input, { wait?: boolean })`
  - `listRuns(query?)`
  - `getRun(id)`
  - `getRunEvents(id, options?)`
  - `streamRunEvents(id, options?)`
  - `listRunArtifacts(id)`
  - `getArtifact(id)`
  - `getArtifactContent(id, options?)`
  - `cancelRun(id)`
  - `sendRunInput(id, input)`
- Success responses must be parsed through `packages/contracts` schemas. Unknown success shapes must throw `SwitchyardDecodeError`.
- Error responses must be parsed through the HTTP error envelope. Known error envelopes throw `SwitchyardHttpError`; non-JSON error bodies throw `SwitchyardDecodeError` with HTTP status and response excerpt capped at 4 KiB.
- The SDK must preserve raw artifact bytes. Text helpers may decode UTF-8, but binary fetch must not coerce through JSON or lose bytes.
- The SDK must support replay-only SSE parsing for required tests. Open-ended live stream support must be abortable with `AbortSignal` and must not leak readers after abort.
- The SDK must not depend on daemon internals, storage internals, or Node-only APIs except where explicitly documented. Node 20+ is the minimum supported runtime for R11 SDK tests.

### CLI

- Add `packages/cli` with package name `@switchyard/cli`, ESM output, `.d.ts` types for reusable command helpers, and bin `switchyard`.
- CLI commands required in R11:
  - `switchyard doctor [--base-url URL] [--json] [--active-fake-check]`
  - `switchyard daemon start [--host HOST] [--port PORT] [--data-dir DIR] [--artifact-dir DIR] [--foreground] [--ready-timeout-ms MS]`
  - `switchyard run fake [--base-url URL] [--cwd DIR] [--task TEXT] [--timeout-seconds N] [--wait] [--json]`
  - `switchyard runtimes test <runtimeMode> [--base-url URL] [--json] [--live]`
  - `switchyard debug run <runId> [--base-url URL] [--include-artifact-content] [--json]`
  - `switchyard contract export [--surface daemon-local|server-hosted|all] [--out PATH]`
- `doctor` default behavior is no-spend and must not create model runs. It checks `/health`, `/doctor`, and runtime-mode list shape. `--active-fake-check` may call `POST /runtime-modes/fake.deterministic/check`.
- `runtimes test fake.deterministic` must run a full deterministic fake run. For any other runtime mode, required CI behavior is check-only unless `--live` is supplied; `--live` must print a spend/external-dependency warning and is not used in required tests.
- `daemon start` must start the local daemon package with the same default host/port/data-dir semantics as `apps/daemon/src/config.ts`. It must surface occupied port, invalid directory, and readiness timeout as named CLI errors.
- `debug run` must fetch the run, replay events, list artifacts, and optionally fetch content. It must distinguish `run_not_found`, `missing_artifact_content`, `adapter_protocol_failed`, `runtime_timeout`, `placement_denied`, and daemon-restart recovery failure events.
- `--json` output must be valid JSON on stdout with errors sent to stderr unless the command is itself returning a JSON error payload. Human output must not require color support.
- CLI tests must use Fastify injection or spawned local daemons on ephemeral ports with temp data dirs. No test may assume port 4545 is free.

### Contract Output

- Add a typed endpoint inventory owned by `packages/contracts`. Each endpoint descriptor must include:
  - `surface`
  - `operationId`
  - HTTP method
  - path template
  - query schema
  - request body schema or explicit no-body marker
  - success status codes
  - success response schema or raw response marker
  - response content type
  - error envelope schema
  - tags
- Generate deterministic OpenAPI 3.1 JSON for the local daemon surface. SSE endpoints must use `text/event-stream` and reference the event schema. Artifact content must be represented as raw binary/string content with per-artifact content-type notes.
- The contract generator must fail on endpoint descriptors that cannot be faithfully represented in OpenAPI. If an endpoint needs supplemental typed metadata, emit a deterministic `x-switchyard-*` extension rather than omitting behavior.
- Contract output must include at minimum all local daemon endpoints listed in Existing Context and the new `GET /metrics` endpoint introduced by R11.
- `openapi:check` must compare:
  - generated output against committed output,
  - endpoint descriptor method/path set against Fastify route registrations from `createDaemonApp`,
  - schemas used by SDK methods against endpoint descriptor schemas.
- Hosted/server/node route output may be included as a separate surface, but local daemon output is the R11 promotion gate.

### Migration Policy And Tests

- Add a migration policy document or code-level policy checked by tests. The policy must state:
  - SQLite migrations are additive by default.
  - New columns need defaults or nullable handling for old rows.
  - New tables and indexes must be idempotent.
  - Drops, renames, lossy conversions, and destructive rebuilds are blocked in R11.
  - Startup must abort on migration failure rather than silently starting with partial schema.
- Introduce schema version tracking for local SQLite migrations if absent today. Version records must be idempotent and readable by CLI doctor/debug output.
- Add migration fixtures created from SQL snapshots, not opaque binaries, for representative pre-R3, pre-R7, pre-R9, and pre-R11 local data shapes. Tests must open each fixture with current `openSqliteStorage`, assert data survives, assert new columns/tables exist, and assert reopening applies no duplicate side effects.
- Migration tests must verify existing runs, events, sessions, artifacts, registry rows, middleware rows, debate rows, and placement rows remain readable after migration.
- Corrupt or empty database files must not be overwritten. The daemon and CLI doctor must report a named storage error and leave the file in place.
- New indexes needed for SDK/CLI list/debug workflows must be added idempotently and included in migration tests.

### Adapter Compatibility Matrix

- Add a CI-safe matrix generator that reads all runtime adapter manifests registered in daemon/testkit coverage and emits deterministic JSON plus a human-readable table.
- Required matrix fields:
  - adapter id
  - provider id
  - runtime id
  - runtime mode id and slug
  - adapter type and kind
  - capabilities
  - limitations
  - placement support
  - doctor check strategy
  - no-spend harness type
  - covered scenarios
  - CI status
- Required covered scenarios per adapter where the capability applies:
  - happy run completes or reaches documented terminal state,
  - nil/missing required launch fields are rejected before adapter dispatch,
  - empty post-start input is rejected or documented unsupported,
  - upstream/process/protocol error is surfaced as a named `AdapterProtocolError` or runtime failure event,
  - artifact paths are safe relative paths,
  - cancel is idempotent or returns documented unsupported error.
- The matrix must fail CI when a registered adapter lacks a manifest, lacks a fake/no-spend harness, claims a capability not covered by tests, or uses live network/model calls in required mode.
- The matrix must include current shipped modes: `fake.deterministic`, `claude_code.sdk`, `codex.exec_json`, `agentfield.async_rest`, `generic_http.async_rest`, and `opencode.acp`.

### Local Daemon Release Packaging

- Package outputs must be installable and smoke-tested from a clean temporary environment without invoking unpublished source files directly.
- Public package outputs must use built `dist` files and `.d.ts` types. Public package `exports` must not point at `src/*.ts` in the release artifact.
- The local release bundle must include:
  - `@switchyard/contracts`
  - `@switchyard/sdk`
  - `@switchyard/cli`
  - an installable local daemon package or deployed daemon bundle with bin `switchyard-daemon`
  - all internal packages needed to run the local daemon without relying on workspace symlinks
- Required clean-environment smoke:
  - create a temp directory outside the repository,
  - install the local release bundle/tarballs from disk,
  - start the daemon on an ephemeral port with a temp data dir,
  - run `switchyard doctor`,
  - run `switchyard run fake --wait`,
  - replay events through SDK or CLI,
  - fetch transcript artifact content,
  - stop the daemon,
  - assert no external model/API calls were made.
- Packaging smoke must be deterministic. Any use of wall-clock timestamps in generated files must be either absent or normalized in checked outputs.

### Logs, Errors, Metrics, And Recovery

- Add request id handling for local daemon HTTP requests:
  - honor inbound `x-request-id` if it is a non-empty bounded string,
  - generate one otherwise,
  - include it in response headers,
  - include it in error envelopes as a backward-compatible optional field,
  - include it in request completion/failure logs.
- Preserve the current structured HTTP error envelope and closed code set. New R11 errors must be named and added to contracts/docs/tests. Unhandled errors must never leak stack traces or raw secrets to SDK/CLI output.
- Add structured local daemon logs for:
  - request start/complete/fail,
  - daemon listening,
  - runtime-mode seeded/check,
  - run created/started/terminalized,
  - artifact persistence success/failure,
  - migration start/success/failure,
  - startup recovery counts.
- Add local metrics endpoint `GET /metrics` returning deterministic JSON with at least:
  - HTTP request counts by method/path/status class,
  - run counts by status/runtimeMode,
  - active run gauge,
  - active SSE connection gauge,
  - artifact persistence failure count,
  - doctor check counts by runtimeMode/state,
  - startup recovery counts.
- `GET /metrics` must be local-daemon-only in R11 and must not require a dashboard. Empty counters/gauges must return zeros, not missing fields.
- Startup recovery must reconcile active persisted states after daemon restart. Runs in `starting`, `running`, `waiting_for_input`, or `waiting_for_approval` with no terminal event must be marked `failed`, active sessions must be marked `failed`, and a `run.failed` event with payload `{ "status": "failed", "error": "daemon_restarted" }` must be appended once. Already-terminal runs must not receive duplicate terminal events.
- Recovery must log and metric the count of reconciled runs and sessions. Corrupt rows must fail visibly with storage error logs rather than silently skipping unknown state.

## Constraints

- Required test and smoke paths must be CI-safe and no-spend.
- Required network usage is loopback only. External API calls, model calls, and remote downloads are not part of R11 acceptance.
- CLI and SDK default to `http://127.0.0.1:4545`, but tests must use ephemeral ports.
- Public packages must support Node 20+ ESM.
- Contract output must be deterministic across repeated generation on the same commit.
- SDK and CLI must treat artifact content as raw data, not JSON.
- Do not change existing successful API response envelopes except through backward-compatible optional fields.
- Do not break existing docs-safe checks: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm lint`, and `git diff --check`.
- Do not broaden the product into UI/dashboard work.

## Acceptance Criteria

- [ ] `@switchyard/sdk` can create a `fake.deterministic` run against a local daemon, inspect the run, replay events, list artifacts, fetch transcript content, cancel/send input where supported, and expose typed HTTP/network/decode/validation/stream errors.
- [ ] SDK tests cover happy, nil, empty, and error paths for run creation, event replay/streaming, artifact metadata/content, and typed errors.
- [ ] `switchyard doctor` checks local daemon health/runtime summary and returns useful human and JSON output.
- [ ] `switchyard daemon start` launches a packaged local daemon on an ephemeral or requested port and reports readiness or named startup errors.
- [ ] `switchyard run fake --wait` launches a deterministic fake run and reports status, final text, event count, and artifact count.
- [ ] `switchyard runtimes test fake.deterministic` runs no-spend runtime validation; non-fake runtime testing remains check-only unless explicitly `--live`.
- [ ] `switchyard debug run <run_id>` prints run status, events, artifacts, content availability, and named remediation hints.
- [ ] OpenAPI or equivalent typed contract output is generated deterministically from endpoint descriptors and checked against real local daemon route registrations.
- [ ] Generated contract output includes local daemon success, SSE, raw artifact content, metrics, and error-envelope behavior.
- [ ] Migration tests open representative older SQLite schemas, apply current migrations, preserve existing local data, and reject corrupt/empty DB files without overwrite.
- [ ] Adapter compatibility matrix automation covers all shipped runtime modes in CI-safe/no-spend mode and fails on missing manifests, missing harnesses, or unsupported live calls.
- [ ] Local daemon release packaging can be installed from disk in a clean temp environment and smoke-tested with doctor, fake run, event replay, artifact content fetch, and shutdown.
- [ ] Logs include request ids and named operational events without leaking secrets or stack traces to users.
- [ ] Error envelopes preserve current behavior and add only backward-compatible optional request id metadata.
- [ ] `GET /metrics` returns deterministic local JSON counters/gauges and is covered by tests.
- [ ] Startup recovery reconciles active interrupted local runs exactly once and records visible event/log/metric evidence.
- [ ] `PRODUCT.md`, `CHANGELOG.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, and relevant adapter docs are updated during implementation closeout to reflect shipped R11 behavior.
- [ ] Full release verification passes: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm lint`, `git diff --check`, contract generation check, compatibility matrix check, migration fixture tests, and clean-environment package smoke.

## Phase

### Phase 10: R11 SDK, CLI, And Hardening

**Goal:** Package and harden the existing local Switchyard daemon API for developers and operators through SDK, CLI, generated contract output, migration protection, compatibility automation, release packaging, and operational recovery.

**Acceptance:**

- Ship `@switchyard/sdk` with typed run/event/artifact/doctor methods and typed error classes against the local daemon.
- Ship `@switchyard/cli` with doctor, daemon start, fake run, runtime test, debug run, and contract export commands.
- Generate deterministic local daemon OpenAPI/typed contract output and fail CI on drift from implemented routes.
- Protect existing SQLite local data through explicit migration policy, schema versioning, and fixture-based migration tests.
- Produce a CI-safe/no-spend adapter compatibility matrix for all shipped runtime modes.
- Build an installable local release bundle and smoke-test it from a clean temporary environment.
- Add request ids, hardened error handling, local metrics, structured logs, and startup recovery tests.

**Non-goals (this phase):**

- No UI/dashboard/TUI.
- No new runtime adapters or hosted runtime expansion.
- No external model/API spend in required checks.
- No enterprise auth/billing/multi-tenant controls.
- No destructive local data migrations.

**Complexity:** L

## Promotion Checks

Run these before R11 can be marked shipped:

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

If command names differ after implementation, the implementation plan must define exact equivalents and keep the same verification coverage.

## Open Concerns

- The repository currently has public package `exports` pointing at `src/index.ts` for several internal packages. R11 must decide whether release packaging rewrites those to `dist` for all package tarballs or uses a local deploy bundle that materializes internal dependencies. Either path is acceptable only if the clean-environment smoke proves users do not depend on workspace symlinks.
- OpenAPI cannot naturally express all SSE and raw artifact-content behavior. R11 must either represent these with accurate content types plus `x-switchyard-*` extensions or emit an additional typed contract artifact. It must not omit the behavior.
- The R10 server/node route surface is implemented but not required for the R11 SDK/CLI local-daemon acceptance. If contract generation includes server/node routes, they must be tagged as a separate surface and must not expand SDK/CLI scope.
