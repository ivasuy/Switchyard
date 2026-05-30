# Phase 14: R15 Hosted Real Runtime Execution - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-14-r15-hosted-real-runtime-execution.md`
**Branch:** `agent/phase-14-r15-hosted-real-runtime-execution`
**Complexity:** L

## Goal
Ship operator opt-in self-hosted/staging hosted worker execution for the existing runtime modes `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`, while preserving fake defaults, fail-closed production posture, no-spend required verification, and the existing public API boundary.

## Scope Challenge

1. Existing code already solves most of the runtime work. `CodexExecJsonAdapter`, `ClaudeCodeAdapter`, `OpenCodeAcpAdapter`, `RuntimeRunnerService`, artifact persistence, hosted queueing, registry inference, readiness, and metrics already exist. R15 must wire those pieces behind closed gates instead of adding a generic process, PTY, shell, tool, or hosted sandbox API.
2. Minimum change set: add one shared closed hosted runtime catalog/policy module, reuse it from server config, worker config, placement, queue claim revalidation, registry seeding, readiness, and tests. Defer all managed-platform, production real hosted runtime, enterprise, dashboard, TUI, public sandbox, arbitrary process, generic PTY, tool, and runtime-specific approval bridge work.
3. Complexity check: the phase touches more than eight files because the acceptance criteria span core policy, server config/API, worker construction, contract tests, smoke, and product truth. The plan keeps each task under eight owned files and prevents overlapping ownership. One shared core catalog is the only new cross-package abstraction.
4. Built-in check: use existing Zod schemas, existing `RuntimeCapabilityService`, existing `PlacementService`, existing `RuntimeRunnerService`, existing adapter fake factories, existing Fastify error envelopes, and existing artifact stores. Do not roll new route contracts, process supervisors, queues, OpenAPI generators, or object-store clients.
5. Distribution check: no new package is introduced. Add one root smoke script, `hosted-real-runtime:smoke`, to the existing root `package.json`. If `@switchyard/worker` imports `@switchyard/adapters`, update `apps/worker/package.json` and `pnpm-lock.yaml`.

## Architecture

R15 is a closed-catalog hosted worker wiring release. The public control plane remains `POST /runs`, run/event/artifact routes, registry/runtime-mode routes, `/ready`, and `/metrics`. The server seeds known runtime-mode records and makes placement decisions. The worker owns provider adapter execution. The server must not register real provider adapters into its own `RuntimeRunnerService`, so `?wait=1` cannot accidentally run provider CLIs in the server process.

```text
POST /runs
  |
  v
runtimeMode inference -> hosted catalog policy -> placement decision
  |                         |
  |                         +-- disabled gate / production / omitted hosted placement / wait=1 -> existing error envelope, no queue job
  v
durable run + placement record + queue payload
  |
  v
worker claim -> durable row reload -> catalog/allowlist/gate/safety revalidation
  |                         |
  |                         +-- stale/tampered/unsafe row -> named run.failed, no adapter start
  v
existing adapter -> RuntimeRunnerService -> events/sessions/artifacts/object store
```

The shared catalog contains exactly four executable hosted modes: `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`. It must export the named union `HostedRuntimeModeSlug` and the catalog constant as `Record<HostedRuntimeModeSlug, HostedRuntimeCatalogEntry>`. T2, T3, and T4 must import that exact type/signature instead of re-declaring slug strings or widening the key type. Only the three real modes require `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`; all real modes are forbidden in `production` at config load and claim revalidation. Fake remains the local/test default when `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` is absent.

`codex.exec_json` is allowed only as one-shot `codex exec --json`. Hosted metadata defaults to `sandbox: "read-only"` and rejects `workspace-write` and `danger-full-access`. `claude_code.sdk` uses read-only permission mode with `Bash`, `WebFetch`, and `WebSearch` disabled. `opencode.acp` keeps conservative ACP capabilities: no file write bridge, no terminal bridge, and no MCP servers. Provider approval/tool/input pauses that R15 cannot service must fail visibly and never leave hosted real runs waiting indefinitely.

## File Structure

- `packages/core/src/services/hosted-runtime-catalog.ts` - new shared closed catalog, `HostedRuntimeModeSlug` union, config/gate validation helpers, real-mode predicates, runtime-mode manifests, hosted safety checks, and claim preparation.
- `packages/core/src/services/placement-service.ts` - keep fake default placement but require explicit hosted placement for real hosted runtime modes.
- `packages/core/src/services/hosted-run-service.ts` - enforce real gate, explicit placement, `?wait=1` denial, and no-queue side effects before durable hosted job creation.
- `packages/core/src/services/hosted-worker-service.ts` - replace fake-only claim validation with catalog-backed durable row revalidation and hosted safety preparation before adapter start.
- `apps/server/src/config.ts` - parse shared real-runtime gate and closed allowlist for server startup.
- `apps/server/src/app.ts` - seed hosted runtime registry records from the shared catalog, keep server runner fake-only, wire hosted placement metrics.
- `apps/server/src/readiness.ts` and `apps/server/src/metrics.ts` - expose non-secret hosted runtime gate readiness and low-cardinality hosted runtime counters.
- `packages/protocol-rest/src/run-routes.ts` - preserve route shapes while rejecting hosted real input/cancel claims that R15 cannot service.
- `apps/worker/src/config.ts` - parse shared real-runtime gate plus existing provider command/timeout env vars for worker construction.
- `apps/worker/src/hosted-runtime-adapters.ts` - new worker-only adapter factory that constructs only allowlisted catalog adapters and accepts fake factories for tests.
- `apps/worker/src/worker.ts` - use the worker adapter factory, pass gate policy into claim revalidation, and expose adapter readiness.
- `scripts/hosted-real-runtime-smoke.ts` - no-spend in-process hosted server/worker smoke using fake provider factories.
- `packages/contracts/src/openapi.contract.test.ts` - generated OpenAPI no-route guard for `/sandbox`, `/exec`, `/pty`, `/terminal`, and arbitrary execution surfaces.
- `PRODUCT.md`, `CHANGELOG.md`, `ARCHITECTURE.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md` - update product truth and operator docs without overclaiming production hosted real-runtime support.

## Existing Context

`apps/worker/src/worker.ts` currently registers only fake:

```ts
const adapters = new Map<string, RuntimeAdapter>([["fake", new FakeRuntimeAdapter()]]);
```

`packages/core/src/services/hosted-worker-service.ts` currently denies every non-fake hosted job:

```ts
if (run.runtime !== "fake") {
  return "hosted_runtime_not_allowed";
}
if (run.runtimeMode !== "fake.deterministic") {
  return "hosted_runtime_not_allowed";
}
```

`apps/server/src/config.ts` and `apps/worker/src/config.ts` already parse `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` and fail closed in staging/production when it is absent or empty. R15 must narrow values to the closed catalog and add `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION`.

`packages/core/src/services/registry-service.ts` already infers the three real runtime modes:

```ts
if (input.runtime === "codex" && input.adapterType === "process") return "codex.exec_json";
if (input.runtime === "opencode" && input.adapterType === "acpx") return "opencode.acp";
if (input.runtime === "claude_code" && input.adapterType === "native") return "claude_code.sdk";
```

`packages/adapters/src/codex/codex-exec-json-adapter.ts`, `packages/adapters/src/claude-code/claude-code-adapter.ts`, and `packages/adapters/src/opencode/opencode-acp-adapter.ts` are the only real adapters in R15 scope. Do not instantiate Generic HTTP, AgentField, Cursor, OpenClaw, Paperclip, browser, search, fetch, GitHub, repo, shell, generic process, or generic PTY adapters in hosted worker construction.

`apps/server/test/hosted-server.test.ts` already protects the public sandbox boundary:

```ts
for (const route of ["/sandbox", "/exec", "/pty", "/terminal"]) {
  const res = await app.inject({ method: "POST", url: route, payload: {} });
  expect(res.statusCode).toBe(404);
}
```

## Task Graph

### Task P14-T1-hosted-runtime-policy

**id:** `P14-T1-hosted-runtime-policy`

**title:** Add shared hosted runtime catalog and claim policy

**files:**

- Create: `packages/core/src/services/hosted-runtime-catalog.ts`
- Modify: `packages/core/src/services/placement-service.ts`
- Modify: `packages/core/src/services/hosted-run-service.ts`
- Modify: `packages/core/src/services/hosted-worker-service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/hosted-runtime-catalog.test.ts`
- Test: `packages/core/test/hosted-placement-service.test.ts`
- Test: `packages/core/test/hosted-worker-service.test.ts`

**dependencies:** []

**context_files:**

- `docs/superpowers/specs/2026-05-30-phase-14-r15-hosted-real-runtime-execution.md` - source of R15 scope, env contract, acceptance, non-goals, safety posture.
- `packages/core/src/services/placement-service.ts` - existing hosted/default placement behavior that must keep fake default and reject implicit real hosted placement.
- `packages/core/src/services/hosted-run-service.ts` - existing hosted run creation and queue enqueue path that must deny real `?wait=1` before side effects.
- `packages/core/src/services/hosted-worker-service.ts` - existing fake-only claim revalidation and stale-claim failure behavior.
- `packages/core/src/services/runtime-capability-service.ts` - existing manifest-to-runtime-mode conversion used by server seeding.
- `packages/contracts/src/registry.ts` - runtime-mode placement/capability/availability schema constraints.
- `packages/contracts/src/run.ts` - run row fields used during durable claim revalidation and safety metadata checks.

**instructions:**

1. Create `hosted-runtime-catalog.ts` in core. Export a named union `HostedRuntimeModeSlug = "fake.deterministic" | "codex.exec_json" | "claude_code.sdk" | "opencode.acp"` and export `HOSTED_RUNTIME_CATALOG: Record<HostedRuntimeModeSlug, HostedRuntimeCatalogEntry>`. Each entry must include runtime mode slug, runtime, provider, provider id, runtime id, adapter id, adapter type, kind, hosted support class, `requiresRealRuntimeGate`, production allowance, safe limitations, and a manifest-like object usable by `RuntimeCapabilityService`.
2. Export predicates and helpers with stable names:
   - `isKnownHostedRuntimeMode(slug: string): slug is HostedRuntimeModeSlug`
   - `isRealHostedRuntimeMode(slug: string | undefined): boolean`
   - `getHostedRuntimeCatalogEntry(slug: string | undefined): HostedRuntimeCatalogEntry | undefined`
   - `validateHostedRuntimeAllowlist(input: { allowlist: string[]; deploymentMode: "local" | "test" | "staging" | "production"; realRuntimeExecution: "enabled" | "disabled" }): HostedRuntimeConfigValidation`
   - `prepareHostedRunForExecution(input: { run: Run; queuePayload: { runId: string; placement?: string; runtimeMode?: string }; allowlist: string[]; deploymentMode: string; realRuntimeExecution: "enabled" | "disabled" }): { ok: true; run: Run; reasonCode?: undefined } | { ok: false; reasonCode: string }`
3. `validateHostedRuntimeAllowlist` must return or throw named codes matching the spec: `config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`, `config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`, `config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION`, `hosted_real_runtime_disabled`, and `hosted_real_runtime_production_forbidden`. Keep config summaries non-secret.
4. Update `PlacementService.decide` so omitted placement may still default fake hosted when fake is allowlisted, but omitted placement for any real R15 mode rejects with reason `hosted_explicit_placement_required`. Explicit `placement:"hosted"` still requires catalog mode support and allowlist membership.
5. Update `HostedRunService` dependencies to accept deployment mode, real-runtime gate, optional metrics/logger, and use the catalog helper before durable run creation. For real hosted runtime modes:
   - require `input.placement === "hosted"`;
   - reject `options.wait === true` with reason `hosted_wait_unsupported`;
   - reject disabled gate, production posture, unknown mode, allowlist miss, and catalog mismatch before `runService.createRun` and before queue enqueue.
6. Update `HostedWorkerService` dependencies to accept deployment mode, real-runtime gate, optional metrics/logger. Replace `validateDurableRun` with catalog-backed revalidation:
   - queue payload run id must match durable row;
   - queue payload placement must be `hosted`;
   - durable row placement must be `hosted`;
   - durable status must be `queued` before a fresh start;
   - durable `runtimeMode` must exist for real modes and equal queue payload runtime mode when payload includes one;
   - durable runtime/provider/adapterType/runtimeMode must match the catalog entry;
   - runtime mode must be allowlisted;
   - real modes require gate enabled and non-production deployment;
   - Codex metadata defaults `sandbox` to `read-only` and rejects `workspace-write`, `danger-full-access`, per-run `command`, per-run `binary`, per-run `processFactory`, and any PTY-shaped metadata keys.
7. When `prepareHostedRunForExecution` returns a mutated safe run, `HostedWorkerService` must persist the prepared row before `startRun(run.id)` and must do so conditionally. Use a compare-and-update path or equivalent reload-and-compare guard that verifies `id`, `status`, `placement`, `runtime`, `runtimeMode`, `provider`, and `adapterType` still match the prepared source row immediately before update. If any field changed, fail the job/run with `hosted_run_state_invalid` and do not call `startRun`.
8. After the conditional durable-row update succeeds, call `startRun(run.id)` exactly once. If the conditional update fails because the row was claimed, cancelled, terminalized, moved to another placement, or changed to another runtime/provider/adapter type, treat it as stale state rather than retrying adapter start.
9. Do not add a public sandbox API, public process API, public PTY API, generic process adapter, or generic PTY adapter.

**acceptance:**

- [ ] Closed catalog accepts exactly `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
- [ ] Real hosted modes require explicit allowlist membership and `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`.
- [ ] Production rejects real hosted modes both at config validation helper level and worker claim revalidation level.
- [ ] Omitted placement can still default hosted for fake when fake is allowlisted, but omitted placement for real modes is rejected before run creation.
- [ ] `?wait=1` for hosted real modes is rejected before durable run or queue side effects.
- [ ] Worker claim revalidation checks queue payload, durable placement, durable status, runtimeMode, runtime, provider, adapterType, allowlist, gate, production posture, and safety metadata before adapter start.
- [ ] Prepared durable-row metadata updates are conditional on unchanged `id`, `status`, `placement`, `runtime`, `runtimeMode`, `provider`, and `adapterType`; mismatch fails with `hosted_run_state_invalid` and no adapter start.
- [ ] Unsafe hosted Codex sandbox metadata fails before adapter start; missing Codex sandbox is persisted as `read-only`.
- [ ] Tampered queue payloads and stale durable rows fail with named `run.failed` events when a run row exists.

**checks:**

- `pnpm --filter @switchyard/core test -- hosted-runtime-catalog hosted-placement-service hosted-worker-service`
- `pnpm --filter @switchyard/core typecheck`

**error_rescue_map:**

| codepath | failure | exception | rescue | user_sees |
|---|---|---|---|---|
| `validateHostedRuntimeAllowlist` | unknown allowlist slug | `ConfigError` caller wraps helper result | fail startup with `config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` and redacted summary | server/worker startup fails with named config code |
| `validateHostedRuntimeAllowlist` | real mode allowlisted while real gate disabled in staging | `ConfigError` caller wraps helper result | fail startup with `hosted_real_runtime_disabled` | operator sees fail-closed config error |
| `validateHostedRuntimeAllowlist` | production has real gate enabled or real mode allowlisted | `ConfigError` caller wraps helper result | fail startup with `config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION` or `hosted_real_runtime_production_forbidden` | operator sees production posture is forbidden |
| `PlacementService.decide` | real mode omitted placement would default hosted | no throw | return reject `hosted_explicit_placement_required` | client gets existing placement denial envelope |
| `HostedRunService.createRun` | hosted real `?wait=1` | `HostedRunServiceError` | reject before `runService.createRun` and before queue enqueue | `409 placement_denied` with `hosted_wait_unsupported` detail |
| `HostedWorkerService.processNext` | missing durable run | no throw | fail queue job with `hosted_run_state_invalid`, do not call adapter | queue failure is inspectable, no run exists |
| `HostedWorkerService.processNext` | terminal or non-queued durable row | no throw | fail existing run only when non-terminal, fail queue job with `hosted_run_state_invalid` | stale job cannot restart completed work |
| `HostedWorkerService.persistPreparedRun` | durable row changes after preparation and before adapter start | no throw or conditional update miss | fail run/job with `hosted_run_state_invalid`, do not call adapter | stale or tampered job is terminally rejected |
| `prepareHostedRunForExecution` | unsafe Codex sandbox metadata | no throw | return `hosted_codex_sandbox_denied`, fail run before `run.started` | run terminal event has named denial |
| `prepareHostedRunForExecution` | safe Codex sandbox absent | no throw | return prepared run with metadata sandbox `read-only` | run executes with read-only Codex sandbox |
| `HostedWorkerService.handleRunFailure` | object store write failure after adapter start | `Error` message containing `object_store_write_failed` | preserve existing retry/exhaustion behavior and named failure event on exhaustion | run eventually fails with visible object-store reason |
| `HostedWorkerService.handleRunFailure` | queue retry attempts exhausted after repeated worker failures | no throw | mark run failed with `worker_retry_exhausted` and fail queue job | run has terminal failure and queue exhaustion is inspectable |

**observability:**

```json
{
  "logs": [
    "info hosted.runtime.placement.accepted {runtimeMode, adapterId, adapterType}",
    "warn hosted.runtime.placement.denied {runtimeMode, reasonCode}",
    "info hosted.worker.claim.revalidated {runId, runtimeMode, adapterId}",
    "warn hosted.worker.claim.rejected {runId, runtimeMode, reasonCode}",
    "warn hosted.worker.interaction.unsupported {runId, runtimeMode, reasonCode}"
  ],
  "success_metric": "hosted runtime accepted and revalidated counters increase only for catalog modes",
  "failure_metric": "denied/rejected counters increase with low-cardinality reasonCode and no adapter start"
}
```

**test_cases:**

| name | lens | given | expect |
|---|---|---|---|
| accepts only closed hosted catalog slugs | happy | catalog slug list | exactly four slugs and expected runtime/provider/adapter fields |
| rejects unknown allowlist slug | error_path | allowlist `fake.deterministic,generic_http.async_rest` | config validation returns `config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` |
| keeps local fake default | happy_shadow_nil | local config helper with no allowlist env | allowlist resolves to `["fake.deterministic"]`, real gate disabled |
| rejects staging real mode without gate | error_path | staging allowlist `fake.deterministic,codex.exec_json`, gate disabled | `hosted_real_runtime_disabled` |
| rejects production real mode | error_path | production allowlist `codex.exec_json`, gate enabled | production forbidden code |
| rejects implicit real hosted placement | error_path | PlacementService with no requested placement and `codex.exec_json` allowlisted | decision reject `hosted_explicit_placement_required` |
| preserves fake default hosted placement | happy | PlacementService with no requested placement and `fake.deterministic` allowlisted | decision `hosted` |
| rejects hosted real wait | error_path | HostedRunService create with `placement:"hosted"`, `wait:true`, `codex.exec_json` | rejects before run creation and queue enqueue |
| rejects missing durable run | error_path | claimed queue job points at absent run id | queue job failed with `hosted_run_state_invalid`, adapter not called |
| revalidates happy Codex claim | integration | queued durable Codex hosted row with gate enabled and safe metadata | startRun called once after metadata defaults to read-only |
| conditionally persists prepared Codex metadata | integration | queued Codex row has no sandbox metadata and row remains unchanged during compare-and-update | durable row is updated to read-only sandbox before `startRun` |
| rejects concurrent row mutation before adapter start | error_path | queued Codex row is changed to `status:"cancelled"` or different `runtimeMode` after preparation but before update | job/run fail with `hosted_run_state_invalid`, no `startRun` |
| rejects unsafe Codex sandbox | error_path | queued durable Codex hosted row with metadata `sandbox:"danger-full-access"` | run failed, no `run.started` |
| rejects tampered queue runtime mode | error_path | queue payload `opencode.acp`, durable row `codex.exec_json` | run failed with `hosted_run_state_invalid`, no adapter call |
| rejects stale terminal row | error_path | queue payload points at completed run | queue failed, adapter not called |
| rejects non-queued durable row | error_path | queue payload points at `status:"running"` hosted real row | run/job fail with `hosted_run_state_invalid`, adapter not called |
| preserves object-store write failure | error_path | adapter starts and artifact write throws `object_store_write_failed` | job retries or exhausts according to attempts, run failure reason stays named |
| records queue retry exhaustion | error_path | claimed job has attempts equal maxAttempts and `startRun` throws | run failed with `worker_retry_exhausted`, queue job failed |

**integration_contracts:**

```json
{
  "exports": [
    {
      "name": "HostedRuntimeModeSlug",
      "kind": "constant",
      "signature": "\"fake.deterministic\" | \"codex.exec_json\" | \"claude_code.sdk\" | \"opencode.acp\""
    },
    {
      "name": "HOSTED_RUNTIME_CATALOG",
      "kind": "constant",
      "signature": "Record<HostedRuntimeModeSlug, HostedRuntimeCatalogEntry>"
    },
    {
      "name": "validateHostedRuntimeAllowlist",
      "kind": "function",
      "signature": "(input: HostedRuntimeConfigInput) => HostedRuntimeConfigValidation"
    },
    {
      "name": "prepareHostedRunForExecution",
      "kind": "function",
      "signature": "(input: HostedRunPreparationInput) => HostedRunPreparationResult"
    },
    {
      "name": "isRealHostedRuntimeMode",
      "kind": "function",
      "signature": "(slug: string | undefined) => boolean"
    }
  ],
  "imports_from_other_tasks": [],
  "file_paths_consumed_by_other_tasks": [
    "packages/core/src/services/hosted-runtime-catalog.ts",
    "packages/core/src/services/hosted-run-service.ts",
    "packages/core/src/services/hosted-worker-service.ts"
  ]
}
```

### Task P14-T2-server-placement-api-readiness

**id:** `P14-T2-server-placement-api-readiness`

**title:** Wire server config, registry, API guards, readiness, and metrics

**files:**

- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/readiness.ts`
- Modify: `apps/server/src/metrics.ts`
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Test: `apps/server/test/hosted-server.test.ts`
- Test: `packages/protocol-rest/test/run-routes.test.ts`

**dependencies:** [`P14-T1-hosted-runtime-policy`]

**context_files:**

- `docs/superpowers/specs/2026-05-30-phase-14-r15-hosted-real-runtime-execution.md` - server-side config, readiness, placement, and public API requirements.
- `apps/server/src/config.ts` - existing fail-closed staging/production config parsing and redacted summary shape.
- `apps/server/src/app.ts` - current fake-only server runner, registry seeding, hosted service construction, queue metrics, artifact routes.
- `apps/server/src/readiness.ts` - current dependency checks and hosted allowlist readiness.
- `packages/protocol-rest/src/run-routes.ts` - current `POST /runs`, input, cancel, and hosted error mapping.
- `apps/server/test/hosted-server.test.ts` - existing hosted fake, config, readiness, metrics, and 404 sandbox boundary tests.
- `packages/protocol-rest/test/run-routes.test.ts` - route harness for runtimeMode inference and input/cancel envelope assertions.

**instructions:**

1. Extend `ServerConfig` with `hostedRealRuntimeExecution: "enabled" | "disabled"` and a redacted gate summary. Parse `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION`; only exact `enabled` enables real hosted runtimes, while unset, empty, and `disabled` mean disabled.
2. Reuse `validateHostedRuntimeAllowlist` from Task T1. In staging/production, keep required Postgres, Redis, node shared token, object store, and explicit allowlist checks. Replace the old universal fake-required check with closed catalog validation. Fake hosted placement remains possible only when `fake.deterministic` is allowlisted.
3. Keep redacted config summaries limited to deployment mode, queue name, allowlist, real gate state, booleans for configured dependencies, object-store summary, sandbox summary, and non-secret timeout numbers. Do not include provider credentials, object-store secrets, signed URLs, prompts, raw env, command arguments, or user home paths.
4. Update server app registry seeding. Seed provider/runtime/model records for test fake plus OpenAI/Codex, Anthropic/Claude Code, and OpenCode. Seed runtime-mode records from the shared hosted catalog with real modes marked hosted `conditional` and limitations that say self-hosted/staging opt-in only. The seeded availability wording must say these records are discoverable for worker-owned self-hosted/staging execution only; it must not imply server-local provider execution, managed production hosting, or production support. Keep the server `adapters` map fake-only.
5. Pass deployment mode and real gate into `HostedRunService`. Wire optional metrics/logger so placement accepted/denied and hosted runtime counters are low-cardinality.
6. Preserve `POST /runs` response shapes. In `packages/protocol-rest/src/run-routes.ts`, ensure hosted real runtime denial maps through the existing error envelope with `placement_denied` or `hosted_runtime_not_allowed`, and include detail issue values such as `hosted_wait_unsupported` and `hosted_explicit_placement_required` when provided by core.
7. Guard `POST /runs/:id/input` for queued, active, and terminal hosted real runtime rows. If R15 has no hosted worker input bridge, queued and active hosted real runs must return the existing adapter protocol error envelope with reason `hosted_input_unsupported` or `hosted_interaction_unsupported`; terminal hosted real rows must use the existing terminal/invalid-state error envelope. In all states, do not call `runService.sendInput` and do not return success while dropping input.
8. Guard `POST /runs/:id/cancel` for queued, active, and terminal hosted real runtime rows. Queued hosted real cancellation may use the existing verified queued-run cancellation path if it prevents later worker claim; it must not claim provider cancellation. Active hosted real runtime cancellation must return the existing adapter protocol error envelope with reason `hosted_cancel_unsupported` unless a verified worker-owned cancel bridge is implemented in this same task. Terminal hosted real rows must use the existing terminal/idempotent terminal behavior and must not emit a new provider-cancel claim.
9. Extend `/ready` with `checks.hostedRuntimeGate` and keep `checks.hostedAllowlist` backward compatible. Add codes `hosted_real_runtime_disabled` and `hosted_real_runtime_production_forbidden`. Readiness must not run live provider prompts.
10. Extend `/metrics` JSON with a `hostedRuntime` object containing `accepted`, `denied`, `started`, `completed`, `failed`, `timeout`, `unsupportedInteraction`, and `artifactPersisted` counters initialized to zero. Do not use run ids, job ids, cwd, prompt text, usernames, provider account ids, object keys, command paths, or model output as labels or keys.

**acceptance:**

- [ ] Server config accepts only closed catalog allowlist values and parses `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION`.
- [ ] Staging/production still require Postgres, Redis, node token, object-store config, and hosted allowlist before startup.
- [ ] Production rejects real hosted runtime enablement and real runtime allowlist entries at config load.
- [ ] Server registry lists `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` with hosted placement `conditional` and wording limited to worker-owned self-hosted/staging availability, not server-local provider execution or managed production support.
- [ ] Server runner remains fake-only and does not register real provider adapters.
- [ ] Explicit hosted real placement with gates enabled enqueues exactly one job and returns the existing accepted run shape.
- [ ] Omitted placement, disabled gate, production mode, unknown mode, registry mismatch, and `?wait=1` reject before queue side effects.
- [ ] Hosted real input/cancel routes cover queued, active, and terminal rows and never claim delivery or provider cancellation without a verified worker bridge.
- [ ] `/ready` and `/metrics` include hosted runtime additions without leaking secrets or prompts.
- [ ] `/sandbox`, `/exec`, `/pty`, and `/terminal` remain absent and return 404.

**checks:**

- `pnpm --filter @switchyard/server test -- hosted-server`
- `pnpm --filter @switchyard/protocol-rest test -- run-routes`
- `pnpm --filter @switchyard/server typecheck`
- `pnpm --filter @switchyard/protocol-rest typecheck`

**error_rescue_map:**

| codepath | failure | exception | rescue | user_sees |
|---|---|---|---|---|
| `loadServerConfig` | invalid gate value | `ConfigError` | fail startup with `config_invalid:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION` and redacted summary | operator sees named config error |
| `loadServerConfig` | production real mode configured | `ConfigError` | fail startup before app creation | operator sees production forbidden code |
| `createServerApp` | registry seeding fails | `Error` from registry store | fail app creation and do not serve partial registry | startup fails visibly |
| `HostedRunService.createRun` through `/runs` | placement denied | `HostedRunServiceError` | map to existing `placement_denied` envelope with details | client sees 409 and no run/queue side effect |
| `HostedRunService.createRun` through `/runs` | queue enqueue fails after durable fake or real hosted run creation | `HostedRunServiceError` code `queue_unavailable` | preserve existing fail-created-run behavior with `queue_enqueue_failed` | client sees queue unavailable, run is failed |
| `/runs/:id/input` | hosted real queued or active run without input bridge | `AdapterProtocolError` | return 409 `adapter_protocol_failed` with reason `hosted_input_unsupported` | client sees input not accepted |
| `/runs/:id/input` | hosted real terminal run | existing terminal state error | preserve terminal rejection and do not call adapter input | client sees terminal-state rejection |
| `/runs/:id/cancel` | hosted real queued run | no throw if existing queued cancel path is verified; otherwise `AdapterProtocolError` | cancel queued run before claim or return `hosted_cancel_unsupported`; never claim provider cancel | client sees queued cancellation or explicit unsupported cancel |
| `/runs/:id/cancel` | hosted real active run without verified cancel | `AdapterProtocolError` | return 409 `adapter_protocol_failed` with reason `hosted_cancel_unsupported` | client sees cancellation not claimed |
| `/runs/:id/cancel` | hosted real terminal run | existing terminal/idempotent behavior | preserve current terminal response without provider-cancel claim | client sees existing terminal cancel response |
| `/ready` | real gate disabled for real allowlist | no throw | return 503 with `checks.hostedRuntimeGate.code` | operator sees readiness denial |
| `/metrics` | queue stats unavailable | existing catch branch | mark queue unavailable and return metrics JSON | operator gets metrics with queue unavailable flag |

**observability:**

```json
{
  "logs": [
    "info hosted.runtime.config.accepted {deploymentMode, gateState, allowlistCount}",
    "warn hosted.runtime.config.rejected {deploymentMode, reasonCode}",
    "info hosted.runtime.placement.accepted {runtimeMode, reasonCode}",
    "warn hosted.runtime.placement.denied {runtimeMode, reasonCode}"
  ],
  "success_metric": "metrics.hostedRuntime.accepted increments for accepted explicit hosted real requests",
  "failure_metric": "metrics.hostedRuntime.denied increments for gate, placement, wait, production, or registry mismatch denials"
}
```

**test_cases:**

| name | lens | given | expect |
|---|---|---|---|
| parses staging real gate | happy | staging env with Postgres, Redis, object store, token, allowlist `fake.deterministic,codex.exec_json`, gate `enabled` | config loads, redacted summary has no secrets |
| rejects invalid real gate value | error_path | env `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=yes` | config error `config_invalid:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION` |
| rejects production gate | error_path | production env with gate `enabled` | `config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION` |
| rejects unknown allowlist | error_path | allowlist `fake.deterministic,generic_http.async_rest` | `config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` |
| lists hosted real registry records | integration | GET `/runtime-modes` after app creation | records include three real modes with hosted `conditional` and self-hosted/staging-worker wording only |
| fails closed on registry seeding failure | error_path | registry store throws while seeding `opencode.acp` | app creation fails and no partial app is served |
| accepts explicit hosted Codex when gate enabled | happy | POST `/runs` with `placement:"hosted"`, `codex.exec_json`, gate enabled | 202, queued hosted run, one queue enqueue |
| rejects omitted hosted placement for Codex | error_path | POST `/runs` with Codex fields and no placement | 409, no run rows, no queue enqueue |
| rejects hosted real wait | error_path | POST `/runs?wait=1` with hosted Codex and gate enabled | 409 with `hosted_wait_unsupported`, no queue enqueue |
| rejects disabled gate before side effects | error_path | hosted Claude request with real mode allowlisted but gate disabled | 409, no run rows, no queue enqueue |
| surfaces queue enqueue failure | error_path | hosted Codex request passes placement but queue `enqueue` throws | response is `queue_unavailable`, run is failed with `queue_enqueue_failed` |
| keeps hosted fake wait behavior | happy | POST `/runs?wait=1` fake hosted | 201 completed |
| queued input bridge unsupported | error_path | queued hosted real run row then POST `/runs/:id/input` | 409 `adapter_protocol_failed`, `hosted_input_unsupported`, `sendInput` not called |
| active input bridge unsupported | error_path | active hosted real run row then POST `/runs/:id/input` | 409 `adapter_protocol_failed`, `hosted_input_unsupported`, `sendInput` not called |
| terminal input keeps terminal rejection | error_path | completed hosted real run row then POST `/runs/:id/input` | existing terminal-state error, no input bridge call |
| queued cancel does not claim provider cancel | error_path | queued hosted real run row then POST `/runs/:id/cancel` | queued run is cancelled before claim or explicit unsupported response; no provider cancel call is reported |
| active cancel bridge unsupported | error_path | active hosted real run row then POST `/runs/:id/cancel` | 409 `adapter_protocol_failed`, `hosted_cancel_unsupported` |
| terminal cancel keeps terminal behavior | error_path | completed hosted real run row then POST `/runs/:id/cancel` | existing terminal/idempotent response, no provider cancel claim |
| readiness reports disabled real gate | error_path | allowlist includes `codex.exec_json`, gate disabled | `/ready` returns 503 with `checks.hostedRuntimeGate.code === "hosted_real_runtime_disabled"` |
| readiness shows gate state | integration | GET `/ready` for enabled staging config | `checks.hostedRuntimeGate.ok === true` |
| metrics includes hosted runtime object | integration | GET `/metrics` | `hostedRuntime` counters exist and are numbers |
| metrics survives queue stats failure | error_path | queue `stats` throws during metrics capture | metrics JSON returned with queue unavailable and hostedRuntime counters still present |
| public sandbox routes absent | error_path | POST forbidden routes | all 404 |

**integration_contracts:**

```json
{
  "exports": [
    {
      "name": "ServerConfig.hostedRealRuntimeExecution",
      "kind": "constant",
      "signature": "'enabled' | 'disabled'"
    },
    {
      "name": "HostedMetricsSnapshot.hostedRuntime",
      "kind": "constant",
      "signature": "{ accepted: number; denied: number; started: number; completed: number; failed: number; timeout: number; unsupportedInteraction: number; artifactPersisted: number }"
    }
  ],
  "imports_from_other_tasks": [
    {
      "from_task": "P14-T1-hosted-runtime-policy",
      "name": "validateHostedRuntimeAllowlist",
      "signature": "(input: HostedRuntimeConfigInput) => HostedRuntimeConfigValidation"
    },
    {
      "from_task": "P14-T1-hosted-runtime-policy",
      "name": "HostedRuntimeModeSlug",
      "signature": "\"fake.deterministic\" | \"codex.exec_json\" | \"claude_code.sdk\" | \"opencode.acp\""
    },
    {
      "from_task": "P14-T1-hosted-runtime-policy",
      "name": "HOSTED_RUNTIME_CATALOG",
      "signature": "Record<HostedRuntimeModeSlug, HostedRuntimeCatalogEntry>"
    },
    {
      "from_task": "P14-T1-hosted-runtime-policy",
      "name": "isRealHostedRuntimeMode",
      "signature": "(slug: string | undefined) => boolean"
    }
  ],
  "file_paths_consumed_by_other_tasks": [
    "apps/server/src/config.ts",
    "apps/server/src/app.ts",
    "packages/protocol-rest/src/run-routes.ts"
  ]
}
```

### Task P14-T3-worker-real-adapter-construction

**id:** `P14-T3-worker-real-adapter-construction`

**title:** Construct allowlisted hosted worker adapters with fake factories for tests

**files:**

- Modify: `apps/worker/src/config.ts`
- Create: `apps/worker/src/hosted-runtime-adapters.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/package.json`
- Modify: `pnpm-lock.yaml`
- Test: `apps/worker/test/hosted-worker.test.ts`

**dependencies:** [`P14-T1-hosted-runtime-policy`]

**context_files:**

- `docs/superpowers/specs/2026-05-30-phase-14-r15-hosted-real-runtime-execution.md` - worker adapter construction, provider config, fake factory, readiness, and no-spend requirements.
- `apps/worker/src/config.ts` - existing worker config parser and redacted summary shape.
- `apps/worker/src/worker.ts` - current fake-only hosted worker construction, artifact content wiring, readiness, and service dependencies.
- `packages/adapters/src/codex/codex-exec-json-adapter.ts` - existing Codex adapter options and fake process factory seam.
- `packages/adapters/src/claude-code/claude-code-adapter.ts` - existing Claude adapter options, read-only permission mode, disabled tools, and fake client seam.
- `packages/adapters/src/opencode/opencode-acp-adapter.ts` - existing OpenCode ACP adapter options, conservative ACP capabilities, and fake process factory seam.
- `apps/worker/test/hosted-worker.test.ts` - existing worker fake processing, static forbidden adapter import test, and denial cases.

**instructions:**

1. Extend `WorkerConfig` with the shared real-runtime gate, existing provider config blocks, and redacted summary fields:
   - `hostedRealRuntimeExecution: "enabled" | "disabled"`
   - `claudeCode.command` from `SWITCHYARD_CLAUDE_CODE_COMMAND`, default `claude`
   - `claudeCode.requestTimeoutMs` from `SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS`, default `5000`
   - `claudeCode.liveProbe` from `SWITCHYARD_CLAUDE_CODE_LIVE_PROBE`, default false
   - `claudeCode.maxBudgetUsd` from `SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD`, default `0.05`
   - `opencode.command` from `SWITCHYARD_OPENCODE_COMMAND`, default `opencode`
   - `acp.requestTimeoutMs` from `SWITCHYARD_ACP_REQUEST_TIMEOUT_MS`, default `5000`
   - `acp.cancelTimeoutMs` from `SWITCHYARD_ACP_CANCEL_TIMEOUT_MS`, default `5000`
   - `acp.maxMessageBytes` from `SWITCHYARD_ACP_MAX_MESSAGE_BYTES`, default `1048576`
2. Reuse the shared allowlist validator from Task T1. Invalid numeric provider config must fail startup with named `config_invalid:<ENV_NAME>` errors and redacted summaries. Do not add a Codex command env var in R15.
3. Add `apps/worker/src/hosted-runtime-adapters.ts`. Export `buildHostedWorkerAdapters(config, deps?)` that always adds `FakeRuntimeAdapter` and conditionally adds:
   - `CodexExecJsonAdapter` under key `codex` only when `codex.exec_json` passes catalog allowlist and gate checks;
   - `ClaudeCodeAdapter` under key `claude_code` only when `claude_code.sdk` passes catalog allowlist and gate checks;
   - `OpenCodeAcpAdapter` under key `opencode` only when `opencode.acp` passes catalog allowlist and gate checks.
4. Adapter construction must be operator-level only. It must not accept per-run command strings, per-run process factories, per-run binary paths, shell snippets, PTY config, tool adapters, browser adapters, search/fetch/GitHub/repo adapters, Generic HTTP, AgentField, Cursor, OpenClaw, Paperclip, generic process, or generic PTY adapters.
5. `CodexExecJsonAdapter` must use its default command and fake `processFactory` only from test-only dependency injection. `ClaudeCodeAdapter` must use `permissionMode:"read_only"` and disabled tools containing `Bash`, `WebFetch`, and `WebSearch`. `OpenCodeAcpAdapter` must use the existing conservative ACP adapter defaults, no MCP servers, no terminal bridge, no file-write bridge.
6. Wrap any adapter-facing logger passed to hosted real adapters with a hosted-safe logger. The wrapper must redact or drop raw `stdout`, `stderr`, task text, cwd, command arguments, provider output chunks/events, full command strings, env values, credentials, tokens, object keys, signed URLs, and user home paths before they reach worker logs. Allowed fields are low-cardinality values such as `runId`, `runtimeMode`, `adapterId`, `adapterType`, `reasonCode`, attempt counts, and coarse byte counts.
7. `buildHostedWorkerAdapters` must expose a no-spend `checkConfiguredHostedAdapters` helper or equivalent readiness result. Checks can construct adapters and run fake/no-spend checks supplied by tests; production readiness must not send live prompts. Claude live probe remains disabled unless explicitly enabled, and required tests must not enable it against a live provider.
8. Update `createHostedWorker` to call `buildHostedWorkerAdapters`, pass deployment mode and gate into `HostedWorkerService`, and expose readiness checks:
   - `checks.hostedRuntimeGate`
   - `checks.hostedRuntimeAdapters`
   - existing `checks.sandbox`
9. Update the static forbidden import test to allow imports of only `CodexExecJsonAdapter`, `ClaudeCodeAdapter`, `OpenCodeAcpAdapter`, and `createClaudeCodeCliClient` from `@switchyard/adapters`. It must still reject Generic HTTP, AgentField, Cursor, OpenClaw, Paperclip, browser, search, fetch, GitHub, repo, shell, generic process, generic PTY, and `node-pty`.
10. Add `@switchyard/adapters` as a workspace dependency of `@switchyard/worker` and update the lockfile.

**acceptance:**

- [ ] Worker config enforces the closed allowlist, real gate, production denial, and existing staging/production dependency requirements.
- [ ] Worker always constructs fake and constructs real adapters only for allowlisted real catalog modes with gate enabled outside production.
- [ ] Worker real adapter construction uses only `CodexExecJsonAdapter`, `ClaudeCodeAdapter`, and `OpenCodeAcpAdapter`.
- [ ] Worker construction tests inject fake Codex process factory, fake Claude client/probes, and fake OpenCode ACP process factory with no live provider requirement.
- [ ] Claude construction uses read-only permission mode and disables `Bash`, `WebFetch`, and `WebSearch`.
- [ ] OpenCode construction keeps conservative ACP behavior with no terminal, file-write, or MCP bridge.
- [ ] Hosted adapter logging is wrapped so raw stdout, stderr, task text, cwd, command arguments, provider output, env values, credentials, signed URLs, and object keys never reach logs.
- [ ] Worker readiness reports hosted runtime gate and adapter construction facts without prompts or secrets.
- [ ] Hosted real fake-factory executions persist terminal run state, sessions, events, and transcript artifacts through existing stores.
- [ ] Worker static source tests still prove no forbidden adapters or real tools are imported.

**checks:**

- `pnpm --filter @switchyard/worker test -- hosted-worker`
- `pnpm --filter @switchyard/worker typecheck`
- `pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter claude-code-adapter opencode-acp-adapter`

**error_rescue_map:**

| codepath | failure | exception | rescue | user_sees |
|---|---|---|---|---|
| `loadWorkerConfig` | invalid provider timeout | `ConfigError` | fail startup with `config_invalid:<ENV_NAME>` and redacted summary | operator sees exact env var failure |
| `loadWorkerConfig` | production real mode or gate | `ConfigError` | fail startup before queue consumer starts | operator sees production forbidden code |
| `buildHostedWorkerAdapters` | real mode allowlisted but gate disabled | no throw in readiness path, config error in load path | do not construct real adapter, report `hosted_real_runtime_disabled` | readiness fails or startup fails according to deployment mode |
| `buildHostedWorkerAdapters` | fake test factory absent | no throw | use existing production adapter defaults for operator-level command config | worker starts without test-only override |
| `buildHostedWorkerAdapters` | provider binary missing or adapter construction/start fails | `Error` or adapter-specific startup error | terminalize run through existing runner failure path with reason `adapter_start_failed` or provider-specific binary reason | run shows failed terminal event and queue retry policy applies |
| `createHostedSafeLogger` | adapter tries to log raw stdout/stderr/task/cwd/command/provider output | no throw | redact/drop unsafe fields before forwarding log event | operator logs contain only low-cardinality sanitized fields |
| `CodexExecJsonAdapter.start` through worker | fake process emits malformed JSONL | `AdapterProtocolError` through runner failure path | existing runner terminalizes failed run and artifacts are persisted when available | run shows failed terminal event |
| `ClaudeCodeAdapter` or `OpenCodeAcpAdapter` stream handling | provider stream is malformed or violates schema | `AdapterProtocolError` through runner failure path | terminalize failed run and persist safe diagnostic reason without raw provider payload | run shows failed terminal event |
| `ClaudeCodeAdapter.events` through worker | approval request emitted with no hosted approval bridge | `AdapterProtocolError` or mapped failed event | fail visibly with named reason, do not wait forever | run status failed with unsupported interaction reason |
| `OpenCodeAcpAdapter.events` through worker | ACP permission request emitted | existing failed event | terminalize failed run with ACP permission unsupported reason | run status failed and artifacts available when produced |
| `RuntimeRunnerService` run timeout | adapter does not reach terminal state before timeout | timeout error or existing timeout result | persist timeout terminal state and ack/fail queue according to existing runner semantics | run status is `timeout` with named timeout event |
| `RuntimeRunnerService` artifact persistence | object-store write failure | `Error` with `object_store_write_failed` | preserve existing object-store mapping and retry/exhaustion behavior | run fails visibly or retry exhaustion is inspectable |
| `RuntimeRunnerService` artifact persistence | object-store auth failure | `Error` with `object_store_auth_failed` or mapped auth code | fail closed without leaking credentials, preserve retry/exhaustion semantics | run fails visibly with auth reason |
| `RuntimeRunnerService` artifact persistence | object-store unavailable failure | `Error` with `object_store_unavailable` | fail closed and retry until queue policy exhausts | run failure or retry state is inspectable |
| `RuntimeRunnerService` artifact persistence | object-store timeout failure | `Error` with `object_store_timeout` | fail closed and preserve timeout reason without content leakage | run fails visibly with timeout reason |
| `RuntimeRunnerService` artifact persistence | object-store digest mismatch | `Error` with `object_store_digest_mismatch` | discard unsafe content metadata and fail run/job with named reason | run fails visibly with digest reason |

**observability:**

```json
{
  "logs": [
    "info hosted.worker.adapter.constructed {runtimeMode, adapterId, adapterType}",
    "info hosted.worker.adapter.starting {runId, runtimeMode, adapterId}",
    "error hosted.worker.adapter.failed {runId, runtimeMode, reasonCode}",
    "info hosted.worker.artifact.persisted {runId, runtimeMode, artifactType, sizeBytes}"
  ],
  "success_metric": "configured adapter readiness returns ok for fake-factory Codex, Claude, and OpenCode tests",
  "failure_metric": "adapter readiness returns per-mode reason codes without running live prompts"
}
```

**test_cases:**

| name | lens | given | expect |
|---|---|---|---|
| worker parses real gate env | happy | staging env with allowlist `fake.deterministic,opencode.acp` and gate enabled | config loads with redacted gate summary |
| worker rejects production real allowlist | error_path | production env allowlist `claude_code.sdk` | config error before worker creation |
| worker rejects invalid timeout | error_path | `SWITCHYARD_ACP_REQUEST_TIMEOUT_MS=0` | config invalid for that env var |
| builds fake-only by default | happy_shadow_nil | test config with no allowlist env | adapter map has fake only |
| readiness reports disabled gate without constructing real adapter | error_path | allowlist contains `codex.exec_json`, gate disabled in readiness path | real adapter absent and mode code is `hosted_real_runtime_disabled` |
| builds all allowlisted real adapters with fakes | happy | gate enabled, allowlist contains all four modes, fake factories supplied | adapter map has fake, codex, claude_code, opencode |
| does not construct non-allowlisted real adapter | edge_allowlist | allowlist `fake.deterministic,codex.exec_json` | no Claude or OpenCode adapter exists |
| uses production defaults when fake factories absent | happy_shadow_nil | allowlist contains Codex and no test process factory is supplied | adapter uses operator/default command config, not per-run factory |
| Claude construction is read-only | integration | fake Claude client and hosted worker config | fake live probe sees read-only and disabled tools, or adapter options are asserted |
| hosted Codex completes with fake JSONL | integration | queued Codex hosted run, fake process emits terminal JSONL | run completed, session persisted, transcript artifact stored |
| hosted provider binary failure fails visibly | error_path | allowlisted Codex adapter start throws missing binary/provider command error | run failed with adapter/provider binary reason, queue policy applies |
| hosted Codex malformed JSONL fails visibly | error_path | fake Codex process emits malformed JSONL | run failed, no raw JSONL output in logs |
| hosted provider malformed stream fails visibly | error_path | fake Claude or OpenCode emits malformed provider event stream | run failed with protocol reason, raw provider payload redacted |
| hosted real run timeout is terminal | error_path | fake provider never emits terminal event until configured timeout | run status `timeout`, timeout event persisted, queue does not hang |
| hosted Claude unsupported approval fails visibly | error_path | fake Claude client emits approval token | run failed, no waiting state remains |
| hosted OpenCode permission request fails visibly | error_path | fake ACP runtime scenario `permission_request` | run failed with ACP permission reason |
| hosted adapter logger redacts unsafe fields | error_path | fake adapter logger event includes stdout, stderr, task, cwd, argv, provider output, token, signed URL, object key | forwarded log omits/redacts unsafe values and keeps only low-cardinality fields |
| object-store write failure fails visibly | error_path | fake artifact content store throws `object_store_write_failed` | run fails or retries with named write reason |
| object-store auth failure fails visibly | error_path | fake artifact content store throws `object_store_auth_failed` | run fails without credential leakage |
| object-store unavailable failure retries then exhausts | error_path | fake artifact content store throws `object_store_unavailable` until max attempts | queue exhaustion is visible and run terminalizes with named reason |
| object-store timeout failure fails visibly | error_path | fake artifact content store throws `object_store_timeout` | run fails with timeout reason and no content leakage |
| object-store digest mismatch fails closed | error_path | fake artifact content store reports digest mismatch | run fails with digest reason and no artifact content served |
| static forbidden imports stay denied | error_path | read `apps/worker/src/worker.ts` and adapter factory source | no Generic HTTP, AgentField, browser, search, fetch, GitHub, repo, shell, generic process, generic PTY imports |
| readiness exposes adapter facts | integration | worker.ready with gate enabled and fake factories | `checks.hostedRuntimeAdapters.ok === true`, no prompt spend |

**integration_contracts:**

```json
{
  "exports": [
    {
      "name": "buildHostedWorkerAdapters",
      "kind": "function",
      "signature": "(config: WorkerConfig, deps?: HostedWorkerAdapterFactoryDeps) => Map<string, RuntimeAdapter>"
    },
    {
      "name": "checkConfiguredHostedAdapters",
      "kind": "function",
      "signature": "(config: WorkerConfig, deps?: HostedWorkerAdapterFactoryDeps) => Promise<{ ok: boolean; modes: Record<HostedRuntimeModeSlug, { ok: boolean; code?: string }> }>"
    },
    {
      "name": "WorkerConfig.hostedRealRuntimeExecution",
      "kind": "constant",
      "signature": "'enabled' | 'disabled'"
    }
  ],
  "imports_from_other_tasks": [
    {
      "from_task": "P14-T1-hosted-runtime-policy",
      "name": "validateHostedRuntimeAllowlist",
      "signature": "(input: HostedRuntimeConfigInput) => HostedRuntimeConfigValidation"
    },
    {
      "from_task": "P14-T1-hosted-runtime-policy",
      "name": "HostedRuntimeModeSlug",
      "signature": "\"fake.deterministic\" | \"codex.exec_json\" | \"claude_code.sdk\" | \"opencode.acp\""
    },
    {
      "from_task": "P14-T1-hosted-runtime-policy",
      "name": "HOSTED_RUNTIME_CATALOG",
      "signature": "Record<HostedRuntimeModeSlug, HostedRuntimeCatalogEntry>"
    }
  ],
  "file_paths_consumed_by_other_tasks": [
    "apps/worker/src/hosted-runtime-adapters.ts",
    "apps/worker/src/worker.ts"
  ]
}
```

### Task P14-T4-no-spend-smoke-openapi-docs

**id:** `P14-T4-no-spend-smoke-openapi-docs`

**title:** Add no-spend smoke, OpenAPI guard, and product truth updates

**files:**

- Create: `scripts/hosted-real-runtime-smoke.ts`
- Modify: `package.json`
- Modify: `packages/contracts/src/openapi.contract.test.ts`
- Modify: `PRODUCT.md`
- Modify: `CHANGELOG.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/development/API.md`
- Modify: `docs/development/DEVELOPMENT.md`

**dependencies:** [`P14-T1-hosted-runtime-policy`, `P14-T2-server-placement-api-readiness`, `P14-T3-worker-real-adapter-construction`]

**context_files:**

- `docs/superpowers/specs/2026-05-30-phase-14-r15-hosted-real-runtime-execution.md` - no-spend smoke, OpenAPI boundary, public compatibility, and docs truth requirements.
- `package.json` - existing root smoke script conventions: `self-hosted:smoke` and `sandbox:smoke`.
- `scripts/hosted-sandbox-smoke.ts` - current no-spend standalone smoke style and assertion helper pattern.
- `packages/contracts/src/openapi.contract.test.ts` - existing generated OpenAPI tests.
- `PRODUCT.md` - current product truth still lists hosted real-runtime execution as unshipped.
- `docs/development/API.md` - public API boundary and runtime-mode placement wording.
- `docs/development/DEVELOPMENT.md` - hosted smoke docs and negative hosted runtime denial examples.

**instructions:**

1. Add root script `hosted-real-runtime:smoke` pointing to `tsx scripts/hosted-real-runtime-smoke.ts`.
2. Implement the smoke as deterministic in-process test harness code. It must not require Docker, AWS, R2, live Codex, live Claude, live OpenCode, browser binaries, GitHub tokens, shell tools, or model spend.
3. The smoke must use fake provider factories:
   - Codex fake process emits valid JSONL and terminal completion.
   - Claude fake client emits normal completion and an unsupported approval scenario.
   - OpenCode fake ACP process emits completion.
4. The smoke must exercise:
   - hosted `codex.exec_json` completion;
   - hosted `claude_code.sdk` completion;
   - hosted `opencode.acp` completion;
   - denied production or gate-disabled request before queue side effects;
   - unsupported interaction failing visibly;
   - artifact listing and raw content retrieval through existing artifact routes for at least one completed real hosted run.
5. The smoke may construct an in-memory Fastify route harness and a worker service directly, but it must use the same core services and route modules as the app: `HostedRunService`, `HostedWorkerService`, `RunService`, `RuntimeRunnerService`, `registerRunRoutes`, and `registerArtifactRoutes`. Do not create a parallel public API.
6. Extend `packages/contracts/src/openapi.contract.test.ts` so generated OpenAPI paths do not contain `/sandbox`, `/exec`, `/pty`, `/terminal`, or a public arbitrary execution route. Also assert operation ids do not include sandbox, terminal, arbitrary exec, generic process, or PTY execution operations.
7. Update `PRODUCT.md` current truth:
   - R15 shipped self-hosted/staging opt-in hosted worker execution for `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
   - It is not managed production hosted platform support.
   - Production real hosted runtime execution remains forbidden.
   - Arbitrary process/PTY, generic process/PTY, public sandbox API, real tools, interactive Codex/session resume/approval bridge, hosted approval bridge, dashboard, TUI, enterprise auth/billing/tenant controls remain unshipped.
8. Update `CHANGELOG.md` under Unreleased with added/changed/safety boundary bullets for the R15 scope.
9. Update `ARCHITECTURE.md`, `docs/development/API.md`, and `docs/development/DEVELOPMENT.md` with exact env names, request examples, readiness/metrics additions, no-spend smoke command, and negative boundary examples. Keep public route shapes unchanged. Do not document a public sandbox API.
10. Add deployment rollback and runbook notes. Rollback for real hosted runtime exposure is to set `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled` or remove real modes from `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`, restart server/worker, and verify `/ready` reports the disabled gate. Queued real jobs must fail closed at worker claim revalidation if allowlist/gate drift occurs before claim. Operators should alert on hosted real placement denials, adapter failures, run timeouts, unsupported interactions, object-store failures, and queue retry exhaustion.

**acceptance:**

- [ ] `pnpm hosted-real-runtime:smoke` runs without live providers, Docker, cloud object stores, browser binaries, GitHub tokens, shell tools, or model spend.
- [ ] Smoke completes hosted fake-factory Codex, Claude, and OpenCode runs through the queue/worker path and verifies events/artifacts via existing routes.
- [ ] Smoke verifies one denied production or gate-disabled request has no queue side effect.
- [ ] Smoke verifies one unsupported interaction fails visibly and does not remain waiting.
- [ ] Generated OpenAPI tests fail if `/sandbox`, `/exec`, `/pty`, `/terminal`, or public arbitrary execution route appears.
- [ ] Product truth says R15 is self-hosted/staging opt-in only and production real hosted runtime remains forbidden.
- [ ] Docs include env names, allowlist examples, readiness/metrics additions, no-spend smoke command, and non-goal boundaries.
- [ ] Docs include rollback/runbook steps for disabling the real gate or removing real modes from the allowlist, and alert guidance for failures/timeouts/unsupported interactions/object-store failures/retry exhaustion.
- [ ] Docs do not claim managed hosted platform, arbitrary process/PTY, public sandbox API, real tools, interactive Codex, hosted approval bridge, dashboard, TUI, enterprise auth, billing, or tenant controls.

**checks:**

- `pnpm hosted-real-runtime:smoke`
- `pnpm --filter @switchyard/contracts test -- openapi.contract`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm --filter @switchyard/server test -- hosted-server`
- `pnpm --filter @switchyard/worker test -- hosted-worker`

**error_rescue_map:**

| codepath | failure | exception | rescue | user_sees |
|---|---|---|---|---|
| `scripts/hosted-real-runtime-smoke.ts` | fake Codex process does not complete | `Error` from smoke assertion | print `hosted_real_runtime_smoke_codex_failed:<reason>` and exit nonzero | operator sees named smoke failure |
| smoke denied request | queue side effect occurs despite denial | `Error` from smoke assertion | print `hosted_real_runtime_smoke_denial_side_effect` and exit nonzero | operator sees safety regression |
| smoke artifact retrieval | artifact missing or content empty | `Error` from smoke assertion | print `hosted_real_runtime_smoke_artifact_failed:<runtimeMode>` and exit nonzero | operator sees artifact regression |
| smoke unsupported interaction | run remains waiting | `Error` from smoke assertion | print `hosted_real_runtime_smoke_waiting_state_leak` and exit nonzero | operator sees interaction boundary regression |
| OpenAPI guard | forbidden route appears | Vitest assertion failure | fail contracts test | implementer sees route inventory regression |
| docs update | stale unshipped wording remains for R15 real hosted known modes | reviewer finding | update truth text without removing non-goal boundaries | user sees accurate product truth |

**observability:**

```json
{
  "logs": [
    "stdout hosted-real-runtime:smoke OK",
    "stderr hosted_real_runtime_smoke_<named_failure>"
  ],
  "success_metric": "smoke exits 0 after three fake-provider hosted completions, one denial, one unsupported interaction, and artifact retrieval",
  "failure_metric": "smoke exits nonzero with stable named failure prefix"
}
```

**test_cases:**

| name | lens | given | expect |
|---|---|---|---|
| smoke hosted Codex | integration | fake Codex JSONL process, gate enabled, allowlist includes Codex | run completed, transcript artifact content fetched |
| smoke hosted Claude | integration | fake Claude client completion | run completed, normalized/raw transcript artifacts exist |
| smoke hosted OpenCode | integration | fake ACP happy process | run completed, ACP transcript artifact exists |
| smoke names Codex incomplete failure | error_path | fake Codex smoke process exits without terminal completion | smoke exits nonzero with `hosted_real_runtime_smoke_codex_failed` |
| smoke denied gate-disabled request | error_path | real hosted request with gate disabled | placement denied, queue length unchanged |
| smoke detects denial side effect | error_path | denied request still enqueues or creates hidden hosted work | smoke exits nonzero with `hosted_real_runtime_smoke_denial_side_effect` |
| smoke unsupported interaction | error_path | fake Claude approval or ACP permission request | run failed with named reason, not waiting |
| smoke detects missing artifact content | error_path | completed smoke run has no artifact or empty content | smoke exits nonzero with `hosted_real_runtime_smoke_artifact_failed:<runtimeMode>` |
| smoke detects waiting-state leak | error_path | unsupported interaction leaves run in waiting state | smoke exits nonzero with `hosted_real_runtime_smoke_waiting_state_leak` |
| OpenAPI forbidden route guard | error_path | generated document | no forbidden paths and no forbidden operation ids |
| docs env contract | happy | read docs after update | exact env names and examples present |
| docs non-goal boundary | edge_docs_truth | read product truth after update | production real hosted runtime and arbitrary process/PTY remain explicitly unshipped |
| docs rollback runbook | happy | read development docs after update | rollback says disable gate or remove real modes from allowlist; queued real jobs fail closed at claim; alerts cover placement denials, adapter failures, timeouts, unsupported interactions, object-store failures, and retry exhaustion |

**integration_contracts:**

```json
{
  "exports": [
    {
      "name": "hosted-real-runtime:smoke",
      "kind": "constant",
      "signature": "root package script invoking tsx scripts/hosted-real-runtime-smoke.ts"
    }
  ],
  "imports_from_other_tasks": [
    {
      "from_task": "P14-T1-hosted-runtime-policy",
      "name": "HostedRuntimeModeSlug",
      "signature": "\"fake.deterministic\" | \"codex.exec_json\" | \"claude_code.sdk\" | \"opencode.acp\""
    },
    {
      "from_task": "P14-T1-hosted-runtime-policy",
      "name": "HOSTED_RUNTIME_CATALOG",
      "signature": "Record<HostedRuntimeModeSlug, HostedRuntimeCatalogEntry>"
    },
    {
      "from_task": "P14-T2-server-placement-api-readiness",
      "name": "ServerConfig.hostedRealRuntimeExecution",
      "signature": "'enabled' | 'disabled'"
    },
    {
      "from_task": "P14-T3-worker-real-adapter-construction",
      "name": "buildHostedWorkerAdapters",
      "signature": "(config: WorkerConfig, deps?: HostedWorkerAdapterFactoryDeps) => Map<string, RuntimeAdapter>"
    }
  ],
  "file_paths_consumed_by_other_tasks": []
}
```

## Integration Points

- T1 is the shared contract. T2, T3, and T4 must import `HostedRuntimeModeSlug`, `HOSTED_RUNTIME_CATALOG: Record<HostedRuntimeModeSlug, HostedRuntimeCatalogEntry>`, hosted runtime predicates, and validation helpers from `@switchyard/core`, not copy slug lists or widen the catalog key type.
- T2 seeds runtime-mode records from T1 catalog. T3 constructs runtime adapters based on T1 catalog and worker config. T4 smoke exercises T2 API behavior and T3 worker behavior together.
- Server-side `RuntimeRunnerService` remains fake-only. Worker-side `RuntimeRunnerService` gets fake plus allowlisted real adapters.
- `RuntimeRunnerService` already persists events, sessions, terminal states, and artifacts. R15 should not create a second persistence path.
- `packages/protocol-rest/src/run-routes.ts` keeps public response shapes and error envelope ownership. New denial details must be additive.

## Phase-Level Acceptance Criteria

- [ ] Server and worker config parse a closed hosted runtime allowlist containing only `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
- [ ] Real hosted runtime execution requires both explicit allowlist membership and `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`.
- [ ] Production fails closed when any real hosted runtime is allowlisted or real runtime execution is enabled.
- [ ] Staging/production continue to require persistent dependencies and hosted allowlist config before startup.
- [ ] Runtime-mode registry records exist for the three real modes in hosted server contexts with conditional self-hosted/staging placement.
- [ ] Placement accepts hosted real runtime requests only with explicit `placement:"hosted"`, passing gates, known catalog mode, and no `?wait=1`.
- [ ] Hosted worker constructs only fake plus allowlisted real adapters from the approved set.
- [ ] Queue claim revalidation reloads durable rows and verifies placement, status, runtimeMode, runtime, provider, adapterType, allowlist, gate, production posture, and safety metadata before adapter start.
- [ ] Worker persists prepared hosted safety metadata only with a conditional durable-row update; any id/status/placement/runtime/runtimeMode/provider/adapterType mismatch fails `hosted_run_state_invalid` and skips adapter start.
- [ ] Codex hosted runs default to read-only sandbox metadata and reject workspace-write/danger-full-access metadata before execution.
- [ ] Claude hosted construction uses read-only permission mode and disables `Bash`, `WebFetch`, and `WebSearch`.
- [ ] OpenCode hosted construction keeps conservative ACP behavior with no terminal, MCP, or file-write bridge.
- [ ] Unsupported provider approval/tool/input states fail visibly and do not stay waiting.
- [ ] Hosted worker logs are sanitized so raw stdout, stderr, task text, cwd, command arguments, provider output, env values, object keys, signed URLs, and credentials do not appear.
- [ ] Completed, failed-after-start, timeout, and unsupported-interaction hosted real runs persist events, run terminal state, session state, and artifacts through existing stores.
- [ ] Artifact content for hosted real runtime transcripts is written through configured artifact content and fetched through existing artifact routes.
- [ ] Public run/event/artifact/runtime-mode response shapes remain backward compatible.
- [ ] No public `/sandbox`, `/exec`, `/pty`, `/terminal`, or arbitrary execution route is added.
- [ ] No real shell/browser/search/GitHub/fetch/repo tool execution is wired in server or worker.
- [ ] Required tests and smoke use fake process/client factories and require no live provider spend.
- [ ] Runbook docs explain disabling the real gate or removing real modes from the allowlist, worker claim fail-closed behavior for already queued real jobs, and alerts for failures, timeouts, unsupported interactions, object-store failures, and retry exhaustion.
- [ ] Docs and product truth are updated without overclaiming production, managed hosting, public sandbox, arbitrary process/PTY, real tools, dashboard, or TUI.

## Risks

- Real runtime allowlist can accidentally cause provider spend. Mitigation: explicit real gate, explicit hosted placement, no `?wait=1`, fake defaults, and no-spend required tests.
- Server and worker can drift on accepted modes. Mitigation: one shared core catalog and config validator.
- Provider adapters can emit interactive or approval states R15 cannot service. Mitigation: terminalize unsupported interactions with named failures and test those paths.
- Codex process support can be mistaken for arbitrary subprocess support. Mitigation: catalog-only construction, no per-run command, shell false through existing adapter, no generic process/PTY adapter, and public route guards.
- Artifact persistence can fail after provider work. Mitigation: preserve named object-store failures, queue retry/exhaustion semantics, and visible terminal failure.
- Phase complexity is L. Mitigation: four disjoint file-ownership tasks and a no-spend cross-task smoke before phase close.

## Self-Review Results

1. Spec coverage: all R15 acceptance criteria map to T1 through T4 and phase-level acceptance above.
2. Banned placeholder scan: no deferred implementation markers are used in task instructions.
3. Type consistency: T1 exports are referenced by matching signatures in T2, T3, and T4.
4. Ownership disjoint: no task owns a file owned by another task.
5. Context files real: every listed context path exists in this worktree.
6. Acceptance testable: each task acceptance item is command-verifiable or assertion-verifiable.
7. Dependency order sane: T1 first, T2 and T3 depend on T1, T4 depends on all implementation tasks.
8. Checks runnable: commands use existing pnpm workspace filters and root script conventions.
9. Error/rescue maps present: every task has named failure paths and user-visible outcomes.
10. Observability present: every runtime behavior task has logs or metrics.
11. Test cases enumerate acceptance: happy, nil/default, empty/disabled, error, edge, and integration lenses are listed.
12. Integration contracts walk: all imports from other tasks resolve to exports defined in earlier tasks.
13. Contract types match: imported signatures match exported signatures.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error rescue entry has a matching error, edge, nil/default, disabled, or integration test case.
- [x] Every integration import from another task resolves to a real export in this plan.
- [x] Every context file path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No banned placeholder text is present.
- [x] Complexity is L and split into four disjoint workstreams rather than one risky overlapping task.
