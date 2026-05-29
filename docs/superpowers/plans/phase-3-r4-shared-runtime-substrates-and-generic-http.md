# Phase 3: R4 Shared Runtime Substrates And Generic HTTP - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-29-phase-3-r4-shared-runtime-substrates-and-generic-http.md`
**Spec commit:** `13add384688e2e1bacbbe33df79b3923ac951c0e`
**Branch:** `agent/phase-3-r4-shared-runtime-substrates-and-generic-http`
**Complexity:** L
**Plan target:** `docs/superpowers/plans/phase-3-r4-shared-runtime-substrates-and-generic-http.md`

## Goal

Ship R4 by extracting reusable runtime substrate code from the existing Codex process adapter, adding the `generic_http.async_rest` HTTP-wrapper runtime mode, and proving process plus HTTP adapter shapes through shared contracts, deterministic fake infrastructure, REST/daemon wiring, transcripts, cancellation, timeout, artifacts, and docs.

## Scope Challenge

- Existing code already solves the public run lifecycle through `RuntimeRunnerService`, `RuntimeAdapter`, REST run routes, SQLite/in-memory stores, runtime-mode registry records, runtime doctor checks, Codex `exec --json`, and transcript artifact persistence. R4 must reuse those seams instead of adding another run engine.
- Minimum viable R4 is one reusable process substrate, one strict Generic HTTP async REST adapter, one fake HTTP wrapper test server, one capability slug, and docs. No ACP, PTY, hosted worker, SDK, CLI, full Codex interactive mode, approval bridge, tools, memory, debate, webhooks, dynamic per-run endpoint override, or remote artifact URL fetching.
- Complexity smell is real: the release crosses more than eight files and more than two new modules because it spans contracts, core lifecycle, adapters, testkit, daemon, REST, and docs. The mitigation is package-shaped ownership with no overlapping file edits and each implementation task kept at eight owned files or fewer.
- Built-in check: use Node `URL`, `AbortController`, native `fetch`, `setTimeout` cleanup, `readline`, Fastify injection, and existing Zod schemas. Do not add a custom URL parser, scheduler, HTTP framework, event bus, storage layer, or schema package.
- Distribution check: no new published package or public binary is introduced. The only manual utility is a testkit package script, `pnpm --filter @switchyard/testkit fake-http-runtime -- --host 127.0.0.1 --port 5055`, backed by testkit source.

## Architecture

R4 keeps `RuntimeRunnerService` as the single lifecycle owner. Adapters still implement `check`, `start`, `send`, `cancel`, `events`, `tools`, and `artifacts`. Core learns two lifecycle improvements only: adapter-emitted `run.cancelled` is terminal, and adapter protocol failures are a generic error class that REST can map to `409 adapter_protocol_failed` for unsupported input and cancel failure.

Process-backed flow:

```text
CodexExecJsonAdapter
  -> ProcessRunner(shell:false, stdin:end)
  -> AsyncLineQueue(stdout lines)
  -> JsonlEventParser(parse + map + terminal stop)
  -> TranscriptRecorder(raw stdout + stderr)
  -> RuntimeRunnerService(normalized events + artifacts)
```

HTTP-wrapper flow:

```text
POST /runs
  -> RegistryService infers generic_http.async_rest
  -> RuntimeRunnerService.start
  -> GenericHttpAsyncRestAdapter
       POST /v1/runs
       poll GET /events?cursor=...
       fallback GET /status
       optional POST /cancel
       GET /artifacts
  -> RuntimeRunnerService persists events and transcript artifacts
```

Transcript content remains adapter-owned and artifact persistence remains runner-owned. Adapters hand off inline content through `artifact.metadata.content`; the runner removes that field, writes content through the configured artifact content store, and stores `contentStored`.

Generic HTTP configuration is daemon-level only:

```text
SWITCHYARD_GENERIC_HTTP_BASE_URL
SWITCHYARD_GENERIC_HTTP_AUTH_TOKEN
SWITCHYARD_GENERIC_HTTP_REQUEST_TIMEOUT_MS
SWITCHYARD_GENERIC_HTTP_POLL_INTERVAL_MS
SWITCHYARD_GENERIC_HTTP_MAX_RESPONSE_BYTES
```

The Generic HTTP adapter must never read base URL, auth token, request timeout, poll interval, or max response bytes from run metadata.

Runtime doctor checks must stop assuming every non-fake mode is Codex-shaped. `RuntimeDoctorService` must branch on `mode.check.strategy` or `mode.slug`: `binary_version` and `binary_version_and_model_catalog` keep the existing Codex mapping, `none` keeps fake deterministic mapping, and `http_health` consumes sanitized adapter-provided availability/check details from `adapter.check()` for `generic_http.async_rest`. The doctor must not require `version` or `models` for HTTP health modes, and it must never surface auth tokens through `details`, diagnostics, logs, doctor responses, or persisted availability.

Generic HTTP cancellation is verified-terminal, not acknowledgement-terminal. A 2xx cancel response, an empty cancel body, or `{}` only means the wrapper accepted the cancel request. `GenericHttpAsyncRestAdapter.cancel()` must return only after it verifies terminal `cancelled` through the status endpoint or through adapter-owned in-memory session state that was already set from an observed cancelled wrapper event; otherwise it throws `AdapterProtocolError` and `RuntimeRunnerService.cancel()` leaves the run in its previous state. `RuntimeRunnerService` marks a non-terminal run `cancelled` only after `adapter.cancel()` returns, and cancel against an already terminal run is idempotent without a second adapter call.

## File Structure

- `packages/contracts/src/registry.ts` - adds the `auth.api_key` capability and parses the full Generic HTTP runtime-mode record.
- `packages/core/src/errors.ts` - exposes a generic adapter protocol error used by process and HTTP adapters.
- `packages/core/src/services/runtime-timeout.ts` - core-owned timeout and abort helper so core doctor checks and adapters can share one bounded behavior without core depending on adapters.
- `packages/core/src/services/runtime-runner-service.ts` - terminalizes adapter-emitted `run.cancelled` and preserves timeout/artifact behavior.
- `packages/adapters/src/substrates/*.ts` - process runner, async line queue, JSONL harness, transcript recorder, and adapter timeout wrapper.
- `packages/adapters/src/codex/codex-exec-json-adapter.ts` - delegates process plumbing to substrates while keeping public Codex behavior unchanged.
- `packages/testkit/src/fake-http-runtime-server.ts` - deterministic loopback HTTP wrapper server for CI and manual smoke.
- `packages/testkit/src/runtime-adapter-contract-harness.ts` - reusable adapter contract checks for fake, Codex, and Generic HTTP.
- `packages/adapters/src/generic-http/*.ts` - strict async REST client adapter and HTTP response validation.
- `packages/protocol-rest/src/run-routes.ts` - maps generic adapter protocol failures for input and cancel.
- `apps/daemon/src/config.ts` and `apps/daemon/src/app.ts` - parse Generic HTTP environment config, register the adapter, and seed registry records.
- `docs/development/adapters/GENERIC_HTTP.md` - local Generic HTTP wrapper guide.

## Existing Context

`packages/core/src/ports/runtime-adapter.ts` is already the adapter boundary:

```ts
export interface RuntimeAdapter {
  readonly id: string;
  readonly manifest: RuntimeAdapterManifest;
  check(config?: Record<string, unknown>): Promise<RuntimeAdapterCheck>;
  start(request: Record<string, unknown>): Promise<RuntimeStartResult>;
  send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void>;
  cancel(session: Record<string, unknown>): Promise<void>;
  events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent>;
  tools(session: Record<string, unknown>): Promise<string[]>;
  artifacts(session: Record<string, unknown>): Promise<Artifact[]>;
}
```

`packages/adapters/src/codex/codex-exec-json-adapter.ts` currently owns reusable process logic inline: `AsyncLineQueue`, `spawn(..., shell:false)`, immediate `child.stdin.end()`, stdout line capture, stderr capture, SIGTERM cancel, JSONL parsing, exit handling, and transcript construction.

`packages/core/src/services/runtime-runner-service.ts` already owns queued/running/terminal states, timeout, event publication, sessions, and artifact content storage. It currently terminalizes `run.completed` and `run.failed`; R4 extends that set to adapter-emitted `run.cancelled`.

`packages/core/src/services/registry-service.ts` currently infers only `fake.deterministic` and `codex.exec_json`. R4 adds `runtime: "generic_http"` with `adapterType: "http"` -> `generic_http.async_rest`.

`apps/daemon/src/app.ts` currently registers fake and Codex adapters, seeds fake and Codex provider/runtime/model records, seeds runtime manifests, and wires registry/doctor/run REST routes. Generic HTTP should follow that pattern.

`packages/core/src/services/runtime-doctor-service.ts` is currently Codex-shaped after the fake branch: it expects binary-style `version`, `models`, and optional checks for non-fake modes. R4 must add an explicit `http_health` mapping path for adapter-provided availability.

`packages/testkit/src/fake-runtime-adapter.ts` currently lets `send()` return success even though the manifest does not declare an approved post-start input capability. R4 must change that behavior to throw `AdapterProtocolError` instead of adding a forbidden `run.input` capability.

## Task Graph

### Task P3-T1-contracts-runtime-mode-and-inference

`id`: `P3-T1-contracts-runtime-mode-and-inference`
`title`: Add Generic HTTP capability contracts and runtime-mode inference
`files`:
- Modify: `packages/contracts/src/registry.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/core/src/services/registry-service.ts`
- Create: `packages/core/test/registry-service.test.ts`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-3-r4-shared-runtime-substrates-and-generic-http.md` - exact Generic HTTP runtime-mode contract and capability list.
- `packages/contracts/src/registry.ts` - current capability, availability, and runtime-mode schemas.
- `packages/contracts/test/contracts.test.ts` - existing runtime-mode contract fixtures and negative tests.
- `packages/core/src/services/registry-service.ts` - current fake/Codex mode inference and explicit slug validation.
- `packages/protocol-rest/test/run-routes.test.ts` - public run-create behavior that consumes `RegistryService`.

`instructions`: Add only `auth.api_key` to `runtimeCapabilitySchema`. Do not add `run.input`, `session.resume`, `webhook`, `hosted`, `tool.*`, or approval capability strings. Extend contract tests with a complete `generic_http.async_rest` runtime-mode fixture matching the spec: provider `provider_generic_http`, runtime `runtime_generic_http`, adapter id `generic_http`, adapter type `http`, kind `async_rest`, capabilities including `auth.none` and `auth.api_key`, limitations `no_post_start_input`, `configured_endpoint_only`, and `no_webhooks`, and docs path `docs/development/adapters/GENERIC_HTTP.md`. Add negative contract tests for unsupported capability strings. Extend `RegistryService.inferAndValidateRuntimeMode` so omitted runtime mode infers `generic_http.async_rest` only when `runtime === "generic_http"` and `adapterType === "http"`. Explicit `generic_http.async_rest` must match runtime `generic_http`, provider `generic_http`, and adapter type `http`; explicit internal id `runtime_mode_generic_http_async_rest` remains invalid.

`acceptance`:
- `auth.api_key` parses as a runtime capability and unsupported strings such as `run.input`, `session.resume`, `webhook.callback`, and `tool.invoke` still reject.
- `runtimeModeSchema` parses the full `generic_http.async_rest` fixture from the spec.
- `RegistryService` infers `generic_http.async_rest` for `runtime: "generic_http"` plus `adapterType: "http"`.
- Explicit `generic_http.async_rest` rejects mismatched runtime, provider, or adapter type with typed `invalid_input` details.
- Explicit `runtime_mode_generic_http_async_rest` rejects as an internal id rather than a public slug.
- Existing fake and Codex inference behavior remains unchanged.

`checks`:
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/contracts typecheck`
- `pnpm --filter @switchyard/core test -- registry-service`
- `pnpm --filter @switchyard/core typecheck`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `runtimeCapabilitySchema` | Capability set expands beyond R4 scope | Zod accepts `run.input` or future tool capability | Add closed-enum negative tests and include only `auth.api_key` | Runtime-mode API does not advertise unshipped features |
| `runtimeModeSchema` Generic HTTP fixture | Runtime-mode shape cannot represent async REST HTTP mode | Contract test throws for `adapterType: "http"` or `kind: "async_rest"` | Reuse existing `adapterTypeSchema` and `runtimeModeKindSchema`; only add missing capability string | Clients can parse the shipped Generic HTTP mode |
| `RegistryService.inferAndValidateRuntimeMode` | Public create accepts internal runtime-mode ids | Validation helper accepts `runtime_mode_generic_http_async_rest` | Keep slug parser rejection for `runtime_mode_*` ids with `path: "runtimeMode"` | `POST /runs` returns `400 invalid_input` before launch |
| `RegistryService` explicit match | Mismatch launches the wrong adapter | Explicit Generic HTTP slug with process adapter returns success | Compare stored mode runtime id, provider id, and adapter type | Caller gets a clear validation error |

`observability`:
- `logs`: No runtime logs are added in this task; later daemon logs will include the new slug and reason codes.
- `success_metric`: Contracts and registry tests prove the new mode is representable and inferable without touching runtime dispatch.
- `failure_metric`: Any unsupported capability parse success or mismatch inference success fails focused tests.

`test_cases`:
- `{ name: "auth api key capability parses", lens: "happy", given: "runtimeCapabilitySchema.parse('auth.api_key')", expect: "returns auth.api_key" }`
- `{ name: "future capability strings reject", lens: "error_path", given: "run.input, session.resume, webhook.callback, tool.invoke", expect: "each schema parse throws" }`
- `{ name: "generic http runtime mode fixture parses", lens: "happy", given: "complete spec fixture for generic_http.async_rest", expect: "runtimeModeSchema.parse succeeds with http adapter type and async_rest kind" }`
- `{ name: "infer generic http runtime mode", lens: "happy", given: "runtime generic_http, provider generic_http, adapterType http", expect: "inferAndValidateRuntimeMode returns generic_http.async_rest" }`
- `{ name: "empty runtime mode keeps backward compatibility", lens: "happy_shadow_empty", given: "no runtimeMode field for fake and Codex inputs", expect: "fake and Codex inference still returns existing slugs" }`
- `{ name: "internal generic http id rejected", lens: "error_path", given: "runtimeMode runtime_mode_generic_http_async_rest", expect: "typed validation error with path runtimeMode" }`
- `{ name: "generic http mismatch rejected", lens: "integration", given: "runtime codex, provider openai, adapterType process, runtimeMode generic_http.async_rest", expect: "typed validation error" }`

`integration_contracts`:
- `exports`:
  - `{ name: "runtimeCapabilitySchema", kind: "constant", signature: "z.enum(['run.start','run.cancel','run.timeout','event.normalized','event.streaming','artifact.transcript','artifact.raw_transcript','model.catalog','tool.fake_echo','auth.none','auth.local','auth.api_key','sandbox.read_only','sandbox.workspace_write','sandbox.danger_full_access'])" }`
  - `{ name: "RegistryService.inferAndValidateRuntimeMode", kind: "function", signature: "(input: { runtime: string; provider: string; adapterType: AdapterType; runtimeMode?: string }) => Promise<string | undefined>" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/contracts/src/registry.ts`
  - `packages/core/src/services/registry-service.ts`

### Task P3-T2-core-runner-protocol-timeout

`id`: `P3-T2-core-runner-protocol-timeout`
`title`: Generalize core protocol errors, timeouts, and cancellation terminalization
`files`:
- Modify: `packages/core/src/errors.ts`
- Create: `packages/core/src/services/runtime-timeout.ts`
- Modify: `packages/core/src/services/runtime-doctor-service.ts`
- Modify: `packages/core/src/services/runtime-runner-service.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/core.test.ts`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-3-r4-shared-runtime-substrates-and-generic-http.md` - core lifecycle expectations and cancellation/timeout requirements.
- `packages/core/src/errors.ts` - existing domain error helper and stable `adapter_protocol_failed` code.
- `packages/core/src/services/runtime-runner-service.ts` - current terminalization, timeout, artifact persistence, send input, and cancel logic.
- `packages/core/src/services/runtime-doctor-service.ts` - current inline timeout helper for bounded active checks.
- `packages/core/test/core.test.ts` - existing lifecycle, timeout, cancellation, artifact, and doctor tests.
- `packages/core/src/ports/runtime-adapter.ts` - adapter shape used by runner and test fakes.

`instructions`: Add `AdapterProtocolError` or an equivalent named core error carrying code `adapter_protocol_failed`, a public message, optional reason code, and sanitized details. Keep `createNotImplementedError` source-compatible. Move the inline doctor timeout logic into `runtime-timeout.ts` with `TimeoutError`, `withTimeout`, and an abort helper that clears timers in success and failure paths. Update `RuntimeDoctorService` to use the shared helper and to branch availability mapping by `mode.check.strategy` and mode slug. `none` keeps the existing fake deterministic result. `binary_version` and `binary_version_and_model_catalog` keep the existing Codex-shaped `version`/`models` mapping. `http_health` consumes only sanitized adapter-provided `details.availability` and `details.diagnostics` from `adapter.check()` and must not require `version` or `models`; this is the path for `generic_http.async_rest`. The accepted `details.availability` shape is `{ state, canRun, installed, auth, reasonCode, message, version? }` with the same enum values as `RuntimeAvailability`, and the doctor must sanitize the message and diagnostics through `maxDiagnosticBytes` before persisting. Update `RuntimeRunnerService` so adapter-emitted `run.cancelled` terminalizes the run and session as `cancelled`, appends exactly one `run.cancelled` event, and persists transcript artifacts just like completed/failed terminal events. Change `RuntimeRunnerService.cancel()` to be idempotent for already terminal runs and to update a non-terminal run to `cancelled` only after `adapter.cancel()` returns; if `adapter.cancel()` throws `AdapterProtocolError`, the run and session remain in their previous state. Keep timeout behavior unchanged: status `timeout`, session `failed`, a normalized `run.failed` payload with `status: "timeout"` and `error: "runtime_timeout"`, and best-effort upstream cancel. Keep artifact persistence failure after terminalization from rewriting completed/cancelled/failed runs.

`acceptance`:
- `AdapterProtocolError` is exported from `@switchyard/core`, has code `adapter_protocol_failed`, and can be detected by REST without checking adapter-specific class names.
- `RuntimeDoctorService` uses the shared timeout helper and existing doctor timeout/output-bound tests still pass.
- `RuntimeDoctorService` maps `generic_http.async_rest` through `http_health` adapter-provided availability details instead of Codex binary/version/model logic.
- Generic HTTP doctor mapping covers missing config, invalid config, check timeout, health non-2xx, invalid health JSON, oversized health body, success without auth token, success with auth token, and proves no token appears in doctor output, stored availability, diagnostics, or logs.
- Adapter-emitted `run.cancelled` terminalizes the run as `cancelled`, marks the session `cancelled`, appends one terminal event, and persists transcript artifacts.
- `RuntimeRunnerService.cancel()` does not mark a run cancelled when adapter cancel fails and returns already terminal runs without calling adapter cancel again.
- Completed and failed terminal events keep existing behavior and sequence ordering.
- Runner timeout behavior still emits `run.failed` with `runtime_timeout`, marks run `timeout`, and calls adapter cancel best-effort.
- Artifact persistence errors after terminalization do not rewrite a completed, failed, cancelled, or timeout run to a different terminal status.

`checks`:
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/core typecheck`
- `pnpm --filter @switchyard/core build`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `AdapterProtocolError` | REST cannot distinguish expected adapter action failures | Generic `Error` bubbles to 500 | Use a named exported class with code `adapter_protocol_failed` | Unsupported input and cancel failure return `409 adapter_protocol_failed` |
| `withTimeout` | Timer leaks or timeout fires after success | Tests observe unresolved timers or late rejection | Clear timer in both promise branches and expose `TimeoutError` | Doctor checks remain bounded without noisy late failures |
| `RuntimeDoctorService` `http_health` mapping | Generic HTTP check is interpreted as Codex and becomes `binary_unavailable` | Adapter returns no `version` or `models` | Branch on `mode.check.strategy === "http_health"` or `mode.slug === "generic_http.async_rest"` and consume adapter-provided availability | Doctor reports exact Generic HTTP reason codes instead of a false binary error |
| `RuntimeDoctorService` output sanitization | Auth token leaks through check details, diagnostics, logs, or persisted availability | Adapter details include bearer token in message by mistake | Truncate and redact `Authorization`, `Bearer`, and configured token substrings before buildCheck/update/log | Doctor and runtime-mode APIs are safe to expose |
| `RuntimeRunnerService` terminal event handling | `run.cancelled` from adapter is ignored or converted to failed | Generic HTTP cancellation test leaves run running or failed | Include `run.cancelled` in terminal event branch and map terminal status by event type | `POST /runs/:id/cancel` can persist cancellation through adapter events |
| `RuntimeRunnerService.cancel` | 2xx upstream cancel acknowledgement silently marks run cancelled even though wrapper still runs | Adapter returns before terminal verification or throws after partial cancel | Require adapter success before state update; return terminal runs unchanged; leave state unchanged on `AdapterProtocolError` | Public cancel returns failure without lying about run state |
| `timeoutRun` | Upstream cancel failure hides timeout terminalization | Adapter cancel throws during timeout path | Keep best-effort catch, log warning, and continue timeout terminalization | Run becomes `timeout` instead of hanging |
| `persistArtifacts` after terminal | Artifact failure rewrites a successful terminal run | Unsafe path or content-store throw changes run to failed | Existing terminal guard remains; extend tests for cancelled terminal state | Run state stays terminal while artifact failure is visible in logs/tests |

`observability`:
- `logs`: Existing `run.started`, `runtime.session.started`, `runtime.output`, terminal event logs, `runtime.cancel_after_timeout_failed`, and `run.timeout` remain. Add no secret-bearing fields.
- `success_metric`: Core tests show one terminal event per run for completed, failed, cancelled, and timeout paths.
- `failure_metric`: Any duplicate terminal event, lost cancellation, leaked timeout, or terminal status rewrite fails core tests.

`test_cases`:
- `{ name: "adapter protocol error has stable code", lens: "happy", given: "new AdapterProtocolError('unsupported input')", expect: "code adapter_protocol_failed and public message preserved" }`
- `{ name: "withTimeout success clears timer", lens: "happy", given: "withTimeout(Promise.resolve('ok'), 50)", expect: "resolves ok and does not later reject" }`
- `{ name: "withTimeout timeout rejects with TimeoutError", lens: "error_path", given: "never-resolving promise and 5ms timeout", expect: "rejects TimeoutError" }`
- `{ name: "doctor uses shared timeout", lens: "integration", given: "hung adapter check and short checkTimeoutMs", expect: "doctor reasonCode check_timeout" }`
- `{ name: "doctor http health missing config", lens: "happy_shadow_nil", given: "generic_http.async_rest mode with http_health and adapter details availability reason generic_http_config_missing", expect: "state unavailable, canRun false, installed false, auth unknown" }`
- `{ name: "doctor http health invalid config", lens: "error_path", given: "adapter details availability reason generic_http_config_invalid", expect: "state unavailable, canRun false, installed false, auth unknown" }`
- `{ name: "doctor http health non 2xx", lens: "error_path", given: "adapter details availability reason generic_http_health_unavailable", expect: "state unavailable, canRun false, installed true" }`
- `{ name: "doctor http health invalid json", lens: "error_path", given: "adapter details availability reason generic_http_health_invalid", expect: "state unknown, canRun false, installed true" }`
- `{ name: "doctor http health oversized body", lens: "error_path", given: "adapter details outputBytes above maxDiagnosticBytes or reason check_output_too_large", expect: "state unknown and reasonCode check_output_too_large" }`
- `{ name: "doctor http health success no auth", lens: "happy", given: "adapter details availability available auth not_required", expect: "state available, canRun true, installed true, auth not_required" }`
- `{ name: "doctor http health success with auth redacts token", lens: "edge_auth", given: "adapter details availability available auth configured and messages containing a fake bearer token", expect: "state available, auth configured, token absent from returned check, stored availability, diagnostics, and logger payloads" }`
- `{ name: "adapter emitted run.cancelled terminalizes", lens: "happy", given: "adapter.events yields runtime.status then run.cancelled", expect: "run status cancelled, session cancelled, events include one run.cancelled" }`
- `{ name: "cancel adapter protocol failure preserves state", lens: "error_path", given: "active run and adapter.cancel throws AdapterProtocolError", expect: "runner.cancel rejects and stored run remains running" }`
- `{ name: "cancel already terminal idempotent", lens: "edge_cancel", given: "completed, failed, timeout, and cancelled runs with sessions", expect: "runner.cancel returns current run and adapter.cancel is not called" }`
- `{ name: "cancelled run persists transcript artifact", lens: "integration", given: "adapter emits run.cancelled and returns transcript artifact content", expect: "artifact.created follows terminal event and contentStored is set when content store is configured" }`
- `{ name: "timeout path unchanged", lens: "error_path", given: "adapter never yields terminal before timeoutSeconds", expect: "run timeout, session failed, run.failed payload runtime_timeout, adapter.cancel called" }`

`integration_contracts`:
- `exports`:
  - `{ name: "AdapterProtocolError", kind: "class", signature: "new AdapterProtocolError(message: string, options?: { reasonCode?: string; details?: Record<string, unknown> })" }`
  - `{ name: "withTimeout", kind: "function", signature: "withTimeout<T>(promise: Promise<T>, timeoutMs: number, label?: string) => Promise<T>" }`
  - `{ name: "TimeoutError", kind: "class", signature: "extends Error" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/core/src/errors.ts`
  - `packages/core/src/services/runtime-timeout.ts`
  - `packages/core/src/services/runtime-runner-service.ts`
  - `packages/core/src/index.ts`

### Task P3-T3-process-substrates-and-codex-regression

`id`: `P3-T3-process-substrates-and-codex-regression`
`title`: Extract shared process substrates and keep Codex exec-json behavior stable
`files`:
- Create: `packages/adapters/src/substrates/async-line-queue.ts`
- Create: `packages/adapters/src/substrates/process-runner.ts`
- Create: `packages/adapters/src/substrates/jsonl-event-parser.ts`
- Create: `packages/adapters/src/substrates/transcript-recorder.ts`
- Create: `packages/adapters/src/substrates/timeout.ts`
- Modify: `packages/adapters/src/codex/codex-exec-json-adapter.ts`
- Modify: `packages/adapters/test/codex-exec-json-adapter.test.ts`
- Create: `packages/adapters/test/substrates.test.ts`

`dependencies`:
- `P3-T2-core-runner-protocol-timeout`

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-3-r4-shared-runtime-substrates-and-generic-http.md` - required substrate modules and Codex extraction rules.
- `packages/adapters/src/codex/codex-exec-json-adapter.ts` - inline process logic to extract.
- `packages/adapters/src/codex/codex-jsonl-parser.ts` - Codex-specific JSONL mapping that must remain unchanged.
- `packages/adapters/test/codex-exec-json-adapter.test.ts` - CI-safe fake process tests and regression expectations.
- `packages/core/src/services/runtime-doctor-service.ts` - current inline timeout behavior that Task P3-T2 extracts into a shared helper.
- `packages/adapters/package.json` - package dependencies and scripts.

`instructions`: Extract generic queue, process, JSONL harness, transcript, and timeout behavior under `packages/adapters/src/substrates/`. `process-runner.ts` must use shell-free spawn options, expose pid only when numeric, close stdin according to an explicit close policy, capture stdout lines and stderr chunks, resolve exit/error once, support idempotent SIGTERM cancellation, and drain stdout/stderr/exit before artifacts. `jsonl-event-parser.ts` must skip empty lines, map parsed JSON objects through an injected mapper, stop after the first terminal mapped event, and yield exactly one sanitized `run.failed` when JSON parse or mapper errors occur. `transcript-recorder.ts` must support native process lines, stderr JSON entries, HTTP request/event entries for the later Generic HTTP task, and `transcriptVersion: "r4.v1"` metadata helpers without accepting auth headers or full env dumps. Refactor `CodexExecJsonAdapter` to delegate process queue/drain/transcript/JSONL harness behavior to substrates while preserving args, `shell: false`, immediate stdin close, logging names, unsupported input behavior, transcript path `runs/<runId>/codex-transcript.jsonl`, raw stdout JSONL content, stderr content, and current tests.

`acceptance`:
- Codex still launches `codex exec --json` with `shell: false`, closes stdin immediately, and preserves all current argument-building behavior.
- Codex logs remain compatible: `codex.spawned`, `codex.stderr`, `codex.stdout.first_line`, `codex.exit`, and `codex.process_error`.
- Codex transcript path remains `runs/<runId>/codex-transcript.jsonl`; metadata keeps `runtime: "codex"` and `mode: "exec-json"` and may add `runtimeMode` and `transcriptVersion`.
- Substrate tests cover stdout line capture, stderr capture, missing numeric pid, process error, non-zero exit, idempotent cancellation, drain, empty stdout lines, JSON parse failure, mapper failure, terminal stop, and late transcript capture.
- Existing Codex tests pass without calling the real Codex CLI.
- No public generic process adapter or runtime mode is introduced.

`checks`:
- `pnpm --filter @switchyard/adapters test -- substrates`
- `pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter`
- `pnpm --filter @switchyard/adapters test`
- `pnpm --filter @switchyard/adapters typecheck`
- `pnpm --filter @switchyard/adapters build`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `ProcessRunner.start` | Spawns through shell or leaves stdin open | Test observes `shell !== false` or `stdin.writableEnded === false` | Force shell-free spawn and explicit `stdin: close` policy | Codex does not hang waiting for stdin and no shell interpolation is added |
| `ProcessRunner.captureStdout` | Empty lines create spurious events | Adapter emits event for blank stdout | Skip empty lines before queueing while preserving later transcript lines as specified | Empty process noise does not become runtime output |
| `ProcessRunner.cancel` | Double cancel throws or sends repeated signals | Second cancel rejects | Track cancellation flag and send SIGTERM once | Cancel endpoint is idempotent at adapter layer |
| `JsonlEventParser` parse failure | Invalid JSONL yields multiple terminal failures | Two `run.failed` events appear | Mark terminal after first parser error and stop yielding | User sees one clear run failure |
| `JsonlEventParser` mapper failure | Mapper exception leaks stack or raw object | Event payload includes stack trace or full raw line | Sanitize error message and include bounded reason | User sees a bounded failure message |
| `TranscriptRecorder` | Secrets are recorded from HTTP headers or env | Transcript contains Authorization or env dump | Do not accept raw headers/env APIs; expose sanitized HTTP entry helper only | Transcript artifacts do not leak auth tokens |
| Codex refactor | Late stdout/stderr after terminal is lost | Existing late-output test fails | Drain process streams independently from event iterator terminal return | Transcript remains reconstructable |

`observability`:
- `logs`: Preserve existing Codex log names and add substrate tests that assert adapter logs are still emitted at equivalent points.
- `success_metric`: Codex regression tests and substrate tests pass with fake process factories only.
- `failure_metric`: Any real Codex invocation, changed transcript path, missing stderr, duplicate terminal event, or changed log name fails tests.

`test_cases`:
- `{ name: "process runner uses shell false and closes stdin", lens: "happy", given: "fake process factory captures options", expect: "shell false and stdin closed" }`
- `{ name: "process runner handles missing pid", lens: "happy_shadow_nil", given: "fake child without numeric pid", expect: "start result has no processId and events still stream" }`
- `{ name: "stdout empty lines skipped", lens: "happy_shadow_empty", given: "stdout emits blank lines then exit", expect: "no mapped events for blank lines" }`
- `{ name: "non-zero exit without terminal fails", lens: "error_path", given: "stderr auth failed and exit code 1", expect: "one run.failed with exitCode and bounded stderr" }`
- `{ name: "invalid jsonl fails once", lens: "error_path", given: "stdout not-json then turn.completed", expect: "one run.failed and no later run.completed" }`
- `{ name: "mapper error fails once", lens: "error_path", given: "valid JSON object whose mapper throws", expect: "one sanitized run.failed" }`
- `{ name: "terminal event stops yielding", lens: "happy", given: "mapped run.completed then runtime.output", expect: "iterator yields run.completed only" }`
- `{ name: "late bytes captured in transcript", lens: "edge_late_output", given: "turn.completed then delayed stdout and stderr before drain", expect: "artifact transcript contains both delayed chunks" }`
- `{ name: "cancel idempotent", lens: "edge_cancel", given: "call cancel twice", expect: "fake child kill called once with SIGTERM" }`

`integration_contracts`:
- `exports`:
  - `{ name: "AsyncLineQueue", kind: "class", signature: "push(item: string): void; close(): void; next(): Promise<IteratorResult<string>>; [Symbol.asyncIterator](): AsyncIterator<string>" }`
  - `{ name: "ProcessRunner", kind: "class", signature: "start(input: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; stdin: 'close' | 'inherit'; context?: Record<string, unknown> }) => ProcessRunSession" }`
  - `{ name: "parseJsonlEvents", kind: "function", signature: "parseJsonlEvents(lines: AsyncIterable<string>, mapper: (record, context) => SwitchyardEvent, options) => AsyncIterable<SwitchyardEvent>" }`
  - `{ name: "TranscriptRecorder", kind: "class", signature: "appendProcessStdout(line: string): void; appendProcessStderr(text: string): void; appendHttpRequest(entry): void; appendHttpEvent(entry): void; content(): string; metadata(input): Record<string, unknown>" }`
  - `{ name: "withAdapterTimeout", kind: "function", signature: "withAdapterTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) => Promise<T>" }`
- `imports_from_other_tasks`:
  - `{ from_task: "P3-T2-core-runner-protocol-timeout", name: "withTimeout", signature: "withTimeout<T>(promise: Promise<T>, timeoutMs: number, label?: string) => Promise<T>" }`
- `file_paths_consumed_by_other_tasks`:
  - `packages/adapters/src/substrates/async-line-queue.ts`
  - `packages/adapters/src/substrates/process-runner.ts`
  - `packages/adapters/src/substrates/jsonl-event-parser.ts`
  - `packages/adapters/src/substrates/transcript-recorder.ts`
  - `packages/adapters/src/substrates/timeout.ts`

### Task P3-T4-testkit-fake-http-and-contract-harness

`id`: `P3-T4-testkit-fake-http-and-contract-harness`
`title`: Add deterministic fake HTTP wrapper server and reusable adapter contract harness
`files`:
- Create: `packages/testkit/src/fake-http-runtime-server.ts`
- Create: `packages/testkit/src/fake-http-runtime-cli.ts`
- Create: `packages/testkit/src/runtime-adapter-contract-harness.ts`
- Modify: `packages/testkit/src/fake-runtime-adapter.ts`
- Modify: `packages/testkit/src/index.ts`
- Create: `packages/testkit/test/fake-http-runtime-server.test.ts`
- Modify: `packages/testkit/test/fake-runtime-adapter.test.ts`
- Modify: `packages/testkit/package.json`

`dependencies`:
- `P3-T2-core-runner-protocol-timeout`

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-3-r4-shared-runtime-substrates-and-generic-http.md` - fake wrapper API, scenarios, and testkit script requirement.
- `packages/testkit/src/fake-runtime-adapter.ts` - existing deterministic adapter style and manifest.
- `packages/testkit/test/fake-runtime-adapter.test.ts` - existing fake adapter lifecycle tests to upgrade into contract harness use.
- `packages/testkit/src/index.ts` - existing testkit export surface.
- `packages/testkit/package.json` - package scripts and dependency declaration.
- `packages/core/src/ports/runtime-adapter.ts` - adapter interface the contract harness validates.

`instructions`: Add a Fastify-backed loopback fake HTTP runtime server that binds to an ephemeral port by default, never calls external services, and stores run state in memory. Expose `startFakeHttpRuntimeServer(options)` returning `{ baseUrl, close, url(path) }`. Implement exactly the wrapper endpoints from the spec: `GET /health`, `POST /v1/runs`, `GET /v1/runs/:externalRunId`, `GET /v1/runs/:externalRunId/events?cursor=...`, `POST /v1/runs/:externalRunId/cancel`, and `GET /v1/runs/:externalRunId/artifacts`. Support deterministic scenarios through helper options: `happy`, `empty_events`, `upstream_failed`, `start_http_500`, `invalid_start_json`, `invalid_events_json`, `invalid_status_json`, `invalid_artifacts_json`, `cancellation`, `cancel_failure`, `cancel_false`, `cancel_404_nonterminal`, `cancel_accepted_but_status_running`, `timeout_no_terminal`, `unsafe_artifact_name`, `terminal_flag_without_terminal_event`, `events_without_ids`, `health_http_500`, `invalid_health_json`, `oversized_health_response`, `oversized_start_response`, `oversized_status_response`, `oversized_events_response`, `oversized_cancel_response`, `oversized_artifacts_response`, and `missing_base_url` where missing base URL is represented by not starting the server. Add optional bearer auth assertion when an expected token is configured. Change `FakeRuntimeAdapter.send()` to throw `AdapterProtocolError` with reason `fake_input_unsupported` because its manifest has no approved post-start input capability; do not add `run.input` or reinterpret `tool.fake_echo` as post-start input. Add a dev-only CLI script `fake-http-runtime` in testkit package scripts. Add a reusable async adapter contract harness that verifies manifest parseability, bounded check, start session id, exactly one terminal event, unsupported input protocol error when no approved input capability exists, idempotent cancel, safe transcript artifact paths, and transcript content handoff. Use the harness for `FakeRuntimeAdapter` in testkit tests.

`acceptance`:
- Fake server starts on loopback with an ephemeral port and closes cleanly in tests.
- Each required endpoint returns the shape and status semantics in the spec.
- Expected bearer auth is enforced without logging or returning the token.
- All required scenarios are deterministic and selectable through helper options rather than public Switchyard API changes.
- Oversized-body scenarios exist for health, start, status, events, cancel, and artifacts endpoints.
- `FakeRuntimeAdapter.send()` throws `AdapterProtocolError` when called because R4 has no approved post-start input capability.
- `pnpm --filter @switchyard/testkit fake-http-runtime -- --host 127.0.0.1 --port 5055` starts the fake wrapper for manual smoke.
- Contract harness runs against `FakeRuntimeAdapter` and remains reusable by the adapters package.

`checks`:
- `pnpm --filter @switchyard/testkit test`
- `pnpm --filter @switchyard/testkit typecheck`
- `pnpm --filter @switchyard/testkit build`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `startFakeHttpRuntimeServer` | Binds public interface or fixed port by default | Server listens on non-loopback or port conflict | Default host to `127.0.0.1` and port `0`; CLI accepts explicit host/port | CI does not need privileged ports or network |
| fake auth middleware | Token leaks into response or assertion message | Test body contains expected token | Compare Authorization header but return generic 401 message | Auth smoke can verify behavior without secret exposure |
| `/v1/runs` start | Invalid scenario state creates nondeterministic external ids | Two test runs collide unexpectedly | Generate stable per-server incrementing ids with run state map | Adapter tests are repeatable |
| `/events` cursor handling | Duplicate events are emitted incorrectly by fake server | Cursor after `evt_1` returns `evt_1` again | Use event id index to return only events after cursor | Adapter duplicate-handling tests are meaningful |
| oversized response scenarios | Adapter cannot prove per-endpoint body bounds | Fake only covers health body overflow | Return deterministic payloads above configured byte limits for health, start, status, events, cancel, and artifacts | Adapter tests prove every endpoint is bounded |
| `FakeRuntimeAdapter.send` | Contract harness passes unsupported input for an adapter without input support | Fake `send()` silently resolves | Throw `AdapterProtocolError` reason `fake_input_unsupported` unless a future approved input capability exists | Public input behavior is honest for fake and Generic HTTP |
| contract harness terminal check | Harness accepts duplicate terminal events | Adapter emits completed and failed but test passes | Count terminal events and assert exactly one | Adapter contract catches lifecycle bugs |
| contract harness input check | Harness requires send success for every adapter | Generic HTTP and fake have no input capability | Check manifest capabilities and require `AdapterProtocolError` when no approved input capability is present | Harness matches R4 capability surface |
| CLI script | Script keeps process alive after test close or ignores SIGINT | Manual smoke cannot stop cleanly | Register SIGINT/SIGTERM handlers that close Fastify before exit | Developer can stop fake wrapper predictably |

`observability`:
- `logs`: Fake server CLI prints base URL and selected scenario; tests do not depend on console output.
- `success_metric`: Testkit tests cover every scenario and contract harness passes against fake runtime.
- `failure_metric`: Any external network call, token echo, scenario nondeterminism, or unclosed server handle fails tests.

`test_cases`:
- `{ name: "health happy", lens: "happy", given: "GET /health on happy server", expect: "200 ok true and capabilities array" }`
- `{ name: "auth token enforced", lens: "edge_auth", given: "expected token configured and missing Authorization header", expect: "401 without token echo; correct bearer succeeds" }`
- `{ name: "start returns external id", lens: "happy", given: "POST /v1/runs with valid body", expect: "externalRunId non-empty and status running" }`
- `{ name: "empty events scenario", lens: "happy_shadow_empty", given: "events endpoint before status terminal", expect: "events [] and status later completed" }`
- `{ name: "invalid start json scenario", lens: "error_path", given: "invalid_start_json", expect: "malformed or missing externalRunId response" }`
- `{ name: "invalid events shape scenario", lens: "error_path", given: "invalid_events_json", expect: "events endpoint returns malformed body for adapter validation" }`
- `{ name: "invalid status json scenario", lens: "error_path", given: "invalid_status_json", expect: "status endpoint returns malformed body for adapter validation" }`
- `{ name: "oversized endpoint scenarios", lens: "error_path", given: "oversized_health_response, oversized_start_response, oversized_status_response, oversized_events_response, oversized_cancel_response, oversized_artifacts_response", expect: "each endpoint returns a body larger than a small test maxResponseBytes" }`
- `{ name: "cancel failure scenario", lens: "error_path", given: "cancel_failure", expect: "cancel endpoint returns failure and status remains non-terminal" }`
- `{ name: "cancel accepted but status running scenario", lens: "error_path", given: "cancel_accepted_but_status_running", expect: "cancel endpoint 2xx empty and subsequent status remains running" }`
- `{ name: "cancel false scenario", lens: "error_path", given: "cancel_false", expect: "cancel endpoint returns cancelled false and subsequent status remains running" }`
- `{ name: "cancel 404 nonterminal scenario", lens: "error_path", given: "cancel_404_nonterminal", expect: "cancel endpoint 404 and subsequent status remains running" }`
- `{ name: "timeout no terminal scenario", lens: "edge_timeout", given: "timeout_no_terminal", expect: "events [] and status running across polls" }`
- `{ name: "terminal flag without terminal event scenario", lens: "edge_events", given: "terminal_flag_without_terminal_event", expect: "events response has terminal true without completed, failed, or cancelled event" }`
- `{ name: "events without ids scenario", lens: "edge_events", given: "events_without_ids", expect: "events omit id fields and may omit nextCursor for cursor fallback tests" }`
- `{ name: "unsafe artifact name scenario", lens: "edge_artifact_safety", given: "unsafe_artifact_name", expect: "artifact name includes path traversal for adapter sanitization test" }`
- `{ name: "fake adapter send unsupported", lens: "error_path", given: "FakeRuntimeAdapter.send(session,{text:'continue'})", expect: "throws AdapterProtocolError reason fake_input_unsupported" }`
- `{ name: "fake adapter contract harness", lens: "integration", given: "FakeRuntimeAdapter and contract harness", expect: "manifest, check, start, events, cancel, and transcript artifact checks pass" }`

`integration_contracts`:
- `exports`:
  - `{ name: "startFakeHttpRuntimeServer", kind: "function", signature: "(options?: FakeHttpRuntimeServerOptions) => Promise<{ baseUrl: string; url(path: string): string; close(): Promise<void> }>" }`
  - `{ name: "FakeHttpRuntimeScenario", kind: "type", signature: "'happy' | 'empty_events' | 'upstream_failed' | 'start_http_500' | 'invalid_start_json' | 'invalid_status_json' | 'invalid_events_json' | 'invalid_artifacts_json' | 'cancellation' | 'cancel_failure' | 'cancel_false' | 'cancel_404_nonterminal' | 'cancel_accepted_but_status_running' | 'timeout_no_terminal' | 'unsafe_artifact_name' | 'terminal_flag_without_terminal_event' | 'events_without_ids' | 'health_http_500' | 'invalid_health_json' | 'oversized_health_response' | 'oversized_start_response' | 'oversized_status_response' | 'oversized_events_response' | 'oversized_cancel_response' | 'oversized_artifacts_response'" }`
  - `{ name: "runRuntimeAdapterContract", kind: "function", signature: "(input: RuntimeAdapterContractInput) => Promise<void>" }`
- `imports_from_other_tasks`:
  - `{ from_task: "P3-T2-core-runner-protocol-timeout", name: "AdapterProtocolError", signature: "new AdapterProtocolError(message: string, options?: { reasonCode?: string; details?: Record<string, unknown> })" }`
- `file_paths_consumed_by_other_tasks`:
  - `packages/testkit/src/fake-http-runtime-server.ts`
  - `packages/testkit/src/runtime-adapter-contract-harness.ts`
  - `packages/testkit/src/index.ts`
  - `packages/testkit/package.json`

### Task P3-T5-generic-http-adapter

`id`: `P3-T5-generic-http-adapter`
`title`: Implement Generic HTTP async REST adapter and adapter contract coverage
`files`:
- Create: `packages/adapters/src/generic-http/types.ts`
- Create: `packages/adapters/src/generic-http/http-client.ts`
- Create: `packages/adapters/src/generic-http/generic-http-adapter.ts`
- Create: `packages/adapters/src/generic-http/index.ts`
- Modify: `packages/adapters/src/index.ts`
- Create: `packages/adapters/test/generic-http-adapter.test.ts`
- Create: `packages/adapters/test/runtime-adapter-contracts.test.ts`
- Modify: `packages/adapters/package.json`

`dependencies`:
- `P3-T1-contracts-runtime-mode-and-inference`
- `P3-T2-core-runner-protocol-timeout`
- `P3-T3-process-substrates-and-codex-regression`
- `P3-T4-testkit-fake-http-and-contract-harness`

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-3-r4-shared-runtime-substrates-and-generic-http.md` - Generic HTTP wrapper API, config, mapping, transcript, and scenario rules.
- `packages/core/src/ports/runtime-adapter.ts` - adapter interface and manifest shape.
- `packages/contracts/src/event.ts` - normalized event types the adapter must emit.
- `packages/contracts/src/artifact.ts` - supported artifact types and metadata rules.
- `packages/adapters/src/codex/codex-exec-json-adapter.ts` - current adapter implementation pattern for sessions, artifacts, logging, and defensive validation.
- `packages/testkit/src/index.ts` - exported fake HTTP server and contract harness from Task P3-T4.
- `packages/adapters/test/codex-exec-json-adapter.test.ts` - current transcript and lifecycle regression behavior that Generic HTTP contract tests should not weaken.

`instructions`: Implement `GenericHttpAsyncRestAdapter` with id `generic_http`, manifest slug `generic_http.async_rest`, adapter type `http`, kind `async_rest`, spec capability and limitation lists, docs path `docs/development/adapters/GENERIC_HTTP.md`, and check strategy `http_health`. The constructor must accept daemon-supplied config: `baseUrl`, optional `authToken`, `requestTimeoutMs`, `pollIntervalMs`, `maxResponseBytes`, optional logger, and optional fetch implementation for tests. Validate base URL with `URL` and require `http:` or `https:`. Health check maps missing, invalid, timeout, non-2xx, invalid JSON, oversized, and success states through sanitized `RuntimeAdapterCheck.details.availability` using the shape consumed by Task P3-T2: `{ state, canRun, installed, auth, reasonCode, message, version? }`. Start sends the exact request body from the spec, with empty metadata as `{}` and no config overrides from run metadata. The shared HTTP reader must enforce `maxResponseBytes` for health, start, status, events, cancel, and artifacts. Oversized health maps to `check_output_too_large`; oversized run endpoints map to endpoint-specific reasons `generic_http_start_response_too_large`, `generic_http_status_response_too_large`, `generic_http_events_response_too_large`, `generic_http_cancel_response_too_large`, and `generic_http_artifacts_response_too_large`. Logs and transcripts for oversized failures record method, path, status when known, byte count, max bytes, and reason code, never full response bodies.

Poll events with cursor, dedupe wrapper event ids, fallback to status when events are empty, normalize supported wrapper event types, turn unknown wrapper event types into `runtime.status` with `status: "unknown_event"`, and yield at most one terminal Switchyard event. If event ids are absent, use a per-session dedupe key built from canonical event summary fields and omit `payload.sourceEventId`; if `nextCursor` is absent, use the last seen wrapper event id when present and otherwise continue with local dedupe without inventing a public wrapper cursor. If an events response says `terminal: true` without a terminal wrapper event, call status once: terminal status produces the matching terminal Switchyard event, and non-terminal or invalid status yields one `run.failed` with `generic_http_invalid_events_response`. Cancel posts wrapper cancel but treats 2xx empty, `{}`, or `{ cancelled: true }` as acknowledgement only. `GenericHttpAsyncRestAdapter.cancel()` must verify terminal cancelled status through status or existing adapter session state before it returns; `{ cancelled: false }`, timeout, connection error, oversized cancel body, invalid cancel JSON, non-terminal 4xx/5xx, and 404 followed by non-terminal status all throw `AdapterProtocolError` reason `generic_http_cancel_failed`. If adapter session state already records terminal `completed`, `failed`, `cancelled`, or `timeout`, cancel returns without another HTTP request. Artifacts fetch inline string content only, sanitize unsafe file names, convert unknown types to `raw_log`, return wrapper artifacts under `runs/<runId>/generic-http/`, and always include adapter transcript at `runs/<runId>/generic-http-transcript.jsonl`. `send` must throw `AdapterProtocolError` with reason `generic_http_input_unsupported`.

`acceptance`:
- Manifest matches the spec and parses through runtime-mode contracts.
- `check()` covers missing config, invalid config, health success, health non-2xx, health timeout, invalid health JSON, oversized health response, and optional auth token.
- Happy path against the fake HTTP server yields normalized `runtime.status`, `runtime.output`, and `run.completed`, stores `externalSessionKey`, and returns transcript artifacts.
- Upstream failed path yields one `run.failed` with sanitized wrapper error.
- Cancellation verifies terminal cancelled state before adapter `cancel()` returns; 2xx acknowledgement alone, `{ cancelled: false }`, timeout, oversized cancel response, and 404 plus non-terminal status all fail visibly without marking the run cancelled.
- Cancel is idempotent after adapter session state is already terminal.
- Timeout path continues polling until the runner timeout and adapter cancel is attempted.
- Invalid and oversized start/events/status/cancel/artifacts responses fail with named Generic HTTP reason codes and bounded transcript/log summaries.
- Events handling covers `terminal: true` with no terminal event, absent event ids, duplicate ids, absent cursors, and cursor fallback.
- Unsupported post-start input throws `AdapterProtocolError`.
- Adapter contract harness passes for Codex with fake process, fake runtime, and Generic HTTP with fake server.

`reviewer_auditor_focus`: This task stays intact because it owns one adapter package boundary and exactly eight files, but it is dense. Reviewer and auditor must explicitly check: every HTTP endpoint enforces `maxResponseBytes`; every failure reason is endpoint-specific; cancel does not terminalize on 2xx acknowledgement alone; absent ids/cursors do not duplicate events; `terminal: true` without a terminal event is status-verified; `send()` rejects without `run.input`; and no auth token appears in thrown errors, logs, doctor details, or transcript artifacts.

`checks`:
- `pnpm --filter @switchyard/adapters test -- generic-http-adapter`
- `pnpm --filter @switchyard/adapters test -- runtime-adapter-contracts`
- `pnpm --filter @switchyard/adapters test`
- `pnpm --filter @switchyard/adapters typecheck`
- `pnpm --filter @switchyard/adapters build`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| constructor/config parse | Base URL missing, empty, invalid, or non-http | `URL` parse throws or protocol check fails | Store unavailable check details with `generic_http_config_missing` or `generic_http_config_invalid`; do not throw from manifest access | Runtime mode exists but doctor reports unavailable |
| HTTP client response reader | Wrapper sends oversized body | Byte count exceeds `maxResponseBytes` | Abort read and return/throw reason `check_output_too_large` or endpoint-specific invalid response code | Public check/run failure is bounded |
| health check | Health timeout or non-2xx | `TimeoutError` or HTTP status outside 2xx | Map timeout to `check_timeout`, non-2xx to `generic_http_health_unavailable` | Doctor reports unavailable or unknown without 500 |
| start | Missing task, invalid start response, or oversized start body | Defensive validation fails, JSON missing `externalRunId`, or body exceeds limit | Throw named error `generic_http_invalid_start_response`, `generic_http_start_failed`, or `generic_http_start_response_too_large` | Run fails visibly instead of staying queued/running |
| events poll | Malformed events response, required field missing, oversized body, or `terminal: true` without terminal event | Shape validation fails or body exceeds limit | Yield one `run.failed` with `generic_http_invalid_events_response` or `generic_http_events_response_too_large` and record transcript summary | Run terminalizes failed with named reason |
| events dedupe | Duplicate or absent wrapper event ids create duplicate Switchyard events | Same source id appears twice or no ids/cursor exist | Keep a per-session seen set keyed by wrapper id or canonical event summary, skip duplicates, append duplicate transcript note | Event stream has one normalized event per logical wrapper event |
| events cursor fallback | Wrapper omits `nextCursor` and event ids | Adapter repeats the same response forever | Use last wrapper id when present; otherwise rely on local dedupe and status fallback to avoid duplicate output | Poll loop remains bounded by timeout and does not duplicate visible events |
| status fallback | External cancellation without Switchyard cancel request | Status `cancelled` arrives before adapter cancel flag | Emit `run.failed` with `generic_http_upstream_cancelled` | Unexpected upstream state is visible |
| cancel | Wrapper cancel acknowledgement is not terminal | 2xx empty, `{}`, or `{ cancelled: true }` arrives while status remains running | Treat response as acknowledgement only and verify terminal cancelled status before returning | Public cancel does not lie about cancellation |
| cancel | Wrapper cancel fails or times out | `{ cancelled: false }`, non-terminal 4xx/5xx, timeout, connection error, invalid JSON, oversized body | Throw `AdapterProtocolError` reason `generic_http_cancel_failed`, except oversized body uses `generic_http_cancel_response_too_large`; for 404 check status once | Public cancel returns `409` and run is not silently cancelled |
| artifacts | Unsafe name, unknown type, malformed response, or oversized artifacts body | Name has slash/path traversal, type not supported, shape invalid, or body exceeds limit | Replace unsafe name, convert unknown type to `raw_log`, fail malformed or oversized with named reason | Artifact paths stay under run root and failures are bounded |
| transcript and errors | Auth token leaks | Transcript, thrown error, logger payload, or check details includes Authorization value | Record method/path/status/duration/reason only, redact bearer-token patterns, and never accept raw headers | Artifact content, logs, doctor, and error responses are safe to inspect |

`observability`:
- `logs`: `generic_http.check`, `generic_http.request`, `generic_http.start`, `generic_http.events`, `generic_http.status`, `generic_http.cancel`, `generic_http.artifacts`, each with run id when available, method, URL pathname, status, duration, external run id, and reason code. No auth token, full response body, or raw stack trace.
- `success_metric`: Adapter tests prove every required fake-server scenario maps to the expected normalized event, run failure reason, check state, or artifact output.
- `failure_metric`: Any leaked bearer token, duplicate terminal event, unbounded response, unsafe artifact path, or silent invalid wrapper response fails tests.

`test_cases`:
- `{ name: "manifest parses", lens: "happy", given: "new GenericHttpAsyncRestAdapter(valid config).manifest", expect: "matches generic_http.async_rest spec and runtimeModeSchema parses" }`
- `{ name: "missing base url check unavailable", lens: "happy_shadow_nil", given: "adapter with no baseUrl", expect: "check ok false details reasonCode generic_http_config_missing" }`
- `{ name: "empty base url treated missing", lens: "happy_shadow_empty", given: "baseUrl empty string", expect: "generic_http_config_missing" }`
- `{ name: "invalid base url check unavailable", lens: "error_path", given: "baseUrl ftp://example.test", expect: "generic_http_config_invalid" }`
- `{ name: "health success no auth", lens: "happy", given: "fake server happy without token", expect: "check ok true auth not_required or equivalent details" }`
- `{ name: "health success with auth", lens: "edge_auth", given: "fake server expected token and adapter authToken", expect: "Authorization sent, check ok true, token absent from logs/details/transcript" }`
- `{ name: "health non-2xx", lens: "error_path", given: "fake health non-2xx", expect: "reasonCode generic_http_health_unavailable" }`
- `{ name: "health timeout", lens: "error_path", given: "fake fetch that never resolves and requestTimeoutMs 5", expect: "reasonCode check_timeout and no token in message" }`
- `{ name: "health invalid json", lens: "error_path", given: "invalid_health_json scenario", expect: "reasonCode generic_http_health_invalid" }`
- `{ name: "health oversized body", lens: "error_path", given: "oversized_health_response and maxResponseBytes 32", expect: "reasonCode check_output_too_large with no body text in details/logs" }`
- `{ name: "happy run completes", lens: "integration", given: "POST /runs request through adapter against happy fake server", expect: "runtime.status, runtime.output, run.completed and transcript artifact" }`
- `{ name: "empty events fallback status completes", lens: "happy_shadow_empty", given: "empty_events scenario", expect: "adapter polls status and yields run.completed" }`
- `{ name: "upstream failed emits run failed", lens: "error_path", given: "upstream_failed scenario", expect: "one run.failed with sanitized error" }`
- `{ name: "invalid start response fails", lens: "error_path", given: "invalid_start_json scenario", expect: "generic_http_invalid_start_response" }`
- `{ name: "oversized start response fails", lens: "error_path", given: "oversized_start_response and maxResponseBytes 32", expect: "generic_http_start_response_too_large and transcript has bounded summary only" }`
- `{ name: "invalid events response fails", lens: "error_path", given: "invalid_events_json scenario", expect: "generic_http_invalid_events_response" }`
- `{ name: "invalid status response fails", lens: "error_path", given: "invalid_status_json scenario after empty events", expect: "generic_http_invalid_status_response" }`
- `{ name: "oversized status response fails", lens: "error_path", given: "oversized_status_response and maxResponseBytes 32", expect: "generic_http_status_response_too_large" }`
- `{ name: "oversized events response fails", lens: "error_path", given: "oversized_events_response and maxResponseBytes 32", expect: "generic_http_events_response_too_large" }`
- `{ name: "terminal true without terminal event status verifies", lens: "edge_events", given: "terminal_flag_without_terminal_event with status completed", expect: "adapter emits run.completed once after status verification" }`
- `{ name: "terminal true without terminal event nonterminal fails", lens: "error_path", given: "terminal_flag_without_terminal_event with status running", expect: "one run.failed with generic_http_invalid_events_response" }`
- `{ name: "absent event ids and cursor dedupe", lens: "edge_events", given: "events_without_ids repeated across polls", expect: "no duplicate Switchyard events and payload.sourceEventId omitted" }`
- `{ name: "cancel success after verified status", lens: "happy", given: "cancellation scenario and adapter.cancel", expect: "cancel request accepted, status verified cancelled, adapter.cancel returns" }`
- `{ name: "cancel 2xx empty with status still running fails", lens: "error_path", given: "cancel_accepted_but_status_running scenario", expect: "AdapterProtocolError reason generic_http_cancel_failed" }`
- `{ name: "cancel false fails", lens: "error_path", given: "cancel_false scenario", expect: "AdapterProtocolError reason generic_http_cancel_failed" }`
- `{ name: "cancel timeout fails", lens: "error_path", given: "cancel request timeout", expect: "AdapterProtocolError reason generic_http_cancel_failed and no token in error" }`
- `{ name: "cancel 404 nonterminal fails", lens: "error_path", given: "cancel_404_nonterminal scenario", expect: "status checked once, AdapterProtocolError reason generic_http_cancel_failed" }`
- `{ name: "cancel oversized body fails", lens: "error_path", given: "oversized_cancel_response and maxResponseBytes 32", expect: "AdapterProtocolError reason generic_http_cancel_response_too_large" }`
- `{ name: "cancel already terminal idempotent", lens: "edge_cancel", given: "adapter session state already completed, failed, timeout, or cancelled", expect: "adapter.cancel returns without HTTP cancel call" }`
- `{ name: "cancel failure protocol error", lens: "error_path", given: "cancel_failure scenario", expect: "AdapterProtocolError reason generic_http_cancel_failed" }`
- `{ name: "unsupported input", lens: "error_path", given: "adapter.send(session,{text:'continue'})", expect: "AdapterProtocolError reason generic_http_input_unsupported" }`
- `{ name: "unsafe artifact sanitized", lens: "edge_artifact_safety", given: "unsafe_artifact_name scenario", expect: "artifact path under runs/<runId>/generic-http/ and metadata.originalName stored" }`
- `{ name: "oversized artifacts response fails bounded", lens: "error_path", given: "oversized_artifacts_response and maxResponseBytes 32", expect: "generic_http_artifacts_response_too_large and transcript/log summary omits body" }`
- `{ name: "token never leaks across adapter surfaces", lens: "edge_security", given: "authToken secret-r4-token and wrapper failures for health, start, events, status, cancel, artifacts", expect: "secret absent from thrown errors, logs, check details, and transcript content" }`
- `{ name: "adapter contract suite", lens: "integration", given: "contract harness for Codex fake process and Generic HTTP fake server", expect: "exactly one terminal event and transcript artifact for each adapter shape" }`

`integration_contracts`:
- `exports`:
  - `{ name: "GenericHttpAsyncRestAdapter", kind: "class", signature: "constructor(options?: GenericHttpAsyncRestAdapterOptions); implements RuntimeAdapter" }`
  - `{ name: "GenericHttpAsyncRestAdapterOptions", kind: "type", signature: "{ baseUrl?: string; authToken?: string; requestTimeoutMs?: number; pollIntervalMs?: number; maxResponseBytes?: number; logger?: RuntimeLogger; fetch?: typeof fetch }" }`
  - `{ name: "GENERIC_HTTP_RUNTIME_MODE_SLUG", kind: "constant", signature: "'generic_http.async_rest'" }`
- `imports_from_other_tasks`:
  - `{ from_task: "P3-T1-contracts-runtime-mode-and-inference", name: "runtimeCapabilitySchema", signature: "z.enum(['run.start','run.cancel','run.timeout','event.normalized','event.streaming','artifact.transcript','artifact.raw_transcript','model.catalog','tool.fake_echo','auth.none','auth.local','auth.api_key','sandbox.read_only','sandbox.workspace_write','sandbox.danger_full_access'])" }`
  - `{ from_task: "P3-T2-core-runner-protocol-timeout", name: "AdapterProtocolError", signature: "new AdapterProtocolError(message: string, options?: { reasonCode?: string; details?: Record<string, unknown> })" }`
  - `{ from_task: "P3-T3-process-substrates-and-codex-regression", name: "TranscriptRecorder", signature: "appendProcessStdout(line: string): void; appendProcessStderr(text: string): void; appendHttpRequest(entry): void; appendHttpEvent(entry): void; content(): string; metadata(input): Record<string, unknown>" }`
  - `{ from_task: "P3-T4-testkit-fake-http-and-contract-harness", name: "startFakeHttpRuntimeServer", signature: "(options?: FakeHttpRuntimeServerOptions) => Promise<{ baseUrl: string; url(path: string): string; close(): Promise<void> }>" }`
  - `{ from_task: "P3-T4-testkit-fake-http-and-contract-harness", name: "runRuntimeAdapterContract", signature: "(input: RuntimeAdapterContractInput) => Promise<void>" }`
- `file_paths_consumed_by_other_tasks`:
  - `packages/adapters/src/generic-http/generic-http-adapter.ts`
  - `packages/adapters/src/index.ts`
  - `packages/adapters/package.json`

### Task P3-T6-rest-daemon-generic-http-wiring

`id`: `P3-T6-rest-daemon-generic-http-wiring`
`title`: Wire Generic HTTP through REST, daemon config, registry seeding, doctor, runs, cancel, and artifacts
`files`:
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Modify: `packages/protocol-rest/test/run-routes.test.ts`
- Modify: `packages/protocol-rest/test/registry-routes.test.ts`
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`

`dependencies`:
- `P3-T1-contracts-runtime-mode-and-inference`
- `P3-T2-core-runner-protocol-timeout`
- `P3-T4-testkit-fake-http-and-contract-harness`
- `P3-T5-generic-http-adapter`

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-3-r4-shared-runtime-substrates-and-generic-http.md` - daemon env config, REST behavior, and smoke commands.
- `packages/protocol-rest/src/run-routes.ts` - current create/input/cancel route behavior and error mapping.
- `packages/protocol-rest/test/run-routes.test.ts` - existing wait, inference, unsupported input, and cancel tests.
- `apps/daemon/src/config.ts` - current env parser.
- `apps/daemon/src/app.ts` - current adapter registration, registry seeding, doctor, and artifact route wiring.
- `apps/daemon/test/smoke.test.ts` - current local smoke, registry, doctor, and artifact content tests.
- `packages/testkit/src/index.ts` - fake HTTP server helper for daemon tests.

`instructions`: Extend daemon config with Generic HTTP env fields and defaults: base URL optional, auth token optional, request timeout `5000`, poll interval `100`, max response bytes `1048576`. Instantiate `GenericHttpAsyncRestAdapter` with config and logger, register it under adapter id/runtime key `generic_http`, and seed provider/runtime/model records for `provider_generic_http`, `runtime_generic_http`, and `model_generic_http_default`. Seed the Generic HTTP manifest through `RuntimeCapabilityService` with initial availability: missing base URL is `unavailable`, `canRun: false`, `installed: false`, `auth: "unknown"`, reason `generic_http_config_missing`; valid configured base URL can start as `unknown` or active-check-derived when tests call `POST /runtime-modes/generic_http.async_rest/check`. Active check and `GET /doctor` must exercise the Task P3-T2 `http_health` doctor path, so missing config, invalid config, fake health success, fake health non-2xx, invalid health JSON, timeout, oversized health response, auth-token configured, and no-token cases report Generic HTTP reason codes rather than Codex binary reason codes. REST create already asks `RegistryService` for runtime mode inference; add route tests for Generic HTTP inference and mismatch. Replace Codex-specific unsupported-input mapping in `run-routes.ts` with generic `AdapterProtocolError` mapping for input and cancel. Wrap `POST /runs/:id/cancel` adapter protocol failures into `409 adapter_protocol_failed`; because Task P3-T5 verifies terminal cancellation before `adapter.cancel()` returns, this route must never mark the run cancelled for 2xx-only upstream acknowledgements, `{ cancelled: false }`, timeout, 404 plus non-terminal status, or oversized cancel responses. Add daemon smoke tests using fake HTTP server config for runtime mode lookup, check availability, `GET /doctor`, `POST /runs?wait=1`, events, artifacts, artifact content, cancellation, failure, timeout, cancel failure, and missing config.

`acceptance`:
- Daemon startup seeds Generic HTTP provider/runtime/model/runtime-mode records even when base URL is missing.
- `GET /runtime-modes/generic_http.async_rest` works by slug and returns the Generic HTTP manifest.
- `POST /runtime-modes/generic_http.async_rest/check` returns exact Generic HTTP availability for missing config, invalid config, fake-server success, non-2xx, invalid JSON, timeout, oversized health body, success without auth, and success with auth.
- `GET /doctor` includes Generic HTTP in summary counts and never leaks auth token in response bodies or captured logger payloads.
- `POST /runs?wait=1` with `runtime: "generic_http"`, `provider: "generic_http"`, `model: "generic-http-default"`, and `adapterType: "http"` completes against the fake server and returns `response.text`.
- Async `POST /runs` launches Generic HTTP in the background and run events are retrievable through existing SSE endpoint.
- `POST /runs/:id/input` returns `409 adapter_protocol_failed` for Generic HTTP.
- `POST /runs/:id/cancel` persists `cancelled` only after verified terminal cancellation; 2xx-only acknowledgement with status still running, `{ cancelled: false }`, timeout, 404 plus non-terminal status, oversized cancel body, and cancel failure return `409 adapter_protocol_failed`.
- `POST /runs/:id/cancel` against an already terminal run is idempotent and does not call the wrapper cancel endpoint again.
- `GET /runs/:id/artifacts`, `GET /artifacts/:id`, and `GET /artifacts/:id/content` expose Generic HTTP transcript content.
- Existing fake and Codex daemon smoke tests keep passing.

`checks`:
- `pnpm --filter @switchyard/protocol-rest test`
- `pnpm --filter @switchyard/protocol-rest typecheck`
- `pnpm --filter @switchyard/daemon test`
- `pnpm --filter @switchyard/daemon typecheck`
- `pnpm --filter @switchyard/daemon build`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `loadDaemonConfig` | Empty base URL becomes invalid URL instead of missing config | `new URL('')` is attempted at startup | Normalize missing or whitespace-only env to undefined | Runtime mode exists and check says config missing |
| `createDaemonApp` adapter map | Adapter registered under wrong key | Runner says `Runtime adapter not found: generic_http` | Register map key `generic_http` matching public run runtime | Generic HTTP runs launch |
| registry seeding | Provider/runtime/model missing or wrong ids | Runtime-mode route returns dangling provider/runtime ids | Seed exact ids before manifest upsert | Registry APIs show coherent Generic HTTP records |
| `POST /runs/:id/input` | Adapter-specific error name check misses Generic HTTP | Generic unsupported input returns 500 | Map exported `AdapterProtocolError` to `409 adapter_protocol_failed` | Caller sees stable error envelope |
| `POST /runs/:id/cancel` | Cancel acknowledgement marks run cancelled before wrapper terminal state | Upstream returns 2xx empty while status remains running | Let runner update only after adapter verifies terminal cancellation and map protocol error to 409 | Failed or unverified cancellation is visible and run state remains previous state |
| `POST /runs/:id/cancel` idempotency | Already terminal run triggers another wrapper cancel | User retries cancel after completion or timeout | Runner returns current terminal run without adapter call | Retry is safe and does not create misleading upstream traffic |
| daemon doctor | Auth token leaks through config/details/logs | Test finds token in response or logs | Pass token only to adapter constructor; adapter details/logs omit token | Doctor output is safe |
| artifact content | Generic HTTP transcript inline content not written out | Artifact metadata still includes `content` or content endpoint 404 | Reuse runner artifact content store and assert `contentStored: true` | Artifact content endpoint returns transcript bytes |

`observability`:
- `logs`: Existing `runtime_mode.seeded` logs add Generic HTTP slug, adapter id, and availability state. Generic HTTP adapter logs include method/path/status/duration/reason code but not auth token or response body.
- `success_metric`: Daemon smoke covers missing config, active check, happy run, failure, cancellation, timeout, events, artifacts, and content endpoint.
- `failure_metric`: Any startup 500, missing seeded record, Generic HTTP token in output, cancel-state mismatch, or artifact content miss fails daemon tests.

`test_cases`:
- `{ name: "missing config seeded unavailable", lens: "happy_shadow_nil", given: "createDaemonApp with no Generic HTTP env", expect: "runtime mode exists with reason generic_http_config_missing" }`
- `{ name: "invalid config active check unavailable", lens: "error_path", given: "Generic HTTP env base URL ftp://example.test", expect: "POST check returns generic_http_config_invalid without startup 500" }`
- `{ name: "generic http active check available", lens: "happy", given: "fake server baseUrl in config", expect: "POST /runtime-modes/generic_http.async_rest/check returns available canRun true" }`
- `{ name: "generic http active check health non 2xx", lens: "error_path", given: "health_http_500 fake server", expect: "POST check returns generic_http_health_unavailable" }`
- `{ name: "generic http active check invalid json", lens: "error_path", given: "invalid_health_json fake server", expect: "POST check returns generic_http_health_invalid" }`
- `{ name: "generic http active check timeout", lens: "error_path", given: "fake server delayed beyond request timeout", expect: "POST check returns check_timeout" }`
- `{ name: "generic http active check oversized", lens: "error_path", given: "oversized_health_response with low max bytes", expect: "POST check returns check_output_too_large" }`
- `{ name: "generic http active check auth redaction", lens: "edge_auth", given: "auth token configured and failing fake health", expect: "token absent from response body and captured logs" }`
- `{ name: "doctor counts generic http", lens: "integration", given: "daemon with fake server config", expect: "doctor summary includes Generic HTTP state" }`
- `{ name: "run wait completes", lens: "integration", given: "POST /runs?wait=1 Generic HTTP payload", expect: "201, run completed, response.text fake http output" }`
- `{ name: "async run events retrievable", lens: "integration", given: "POST /runs then GET /runs/:id/events", expect: "SSE contains runtime.output and run.completed" }`
- `{ name: "input unsupported maps 409", lens: "error_path", given: "POST /runs/:id/input for Generic HTTP", expect: "409 adapter_protocol_failed" }`
- `{ name: "cancel success persists cancelled", lens: "happy", given: "active Generic HTTP run and POST cancel", expect: "200 run.status cancelled and event run.cancelled" }`
- `{ name: "cancel failure maps 409", lens: "error_path", given: "cancel_failure fake scenario", expect: "409 adapter_protocol_failed and run not silently cancelled" }`
- `{ name: "cancel 2xx running maps 409", lens: "error_path", given: "cancel_accepted_but_status_running fake scenario", expect: "409 adapter_protocol_failed and stored run is not cancelled" }`
- `{ name: "cancel false maps 409", lens: "error_path", given: "cancel_false fake scenario", expect: "409 adapter_protocol_failed and stored run is not cancelled" }`
- `{ name: "cancel 404 nonterminal maps 409", lens: "error_path", given: "cancel_404_nonterminal fake scenario", expect: "409 adapter_protocol_failed and stored run is not cancelled" }`
- `{ name: "cancel already terminal idempotent", lens: "edge_cancel", given: "completed Generic HTTP run and POST cancel", expect: "200 current terminal run and fake server cancel count unchanged" }`
- `{ name: "artifact content endpoint returns transcript", lens: "integration", given: "completed Generic HTTP run", expect: "artifact metadata contentStored true and content contains generic-http transcript line" }`
- `{ name: "explicit generic http runtime mode accepted", lens: "happy", given: "POST /runs with runtimeMode generic_http.async_rest and matching fields", expect: "run.runtimeMode generic_http.async_rest" }`
- `{ name: "generic http explicit id rejected", lens: "error_path", given: "runtimeMode runtime_mode_generic_http_async_rest", expect: "400 invalid_input path runtimeMode" }`

`integration_contracts`:
- `exports`:
  - `{ name: "DaemonConfig.genericHttp", kind: "type", signature: "{ baseUrl?: string; authToken?: string; requestTimeoutMs: number; pollIntervalMs: number; maxResponseBytes: number }" }`
  - `{ name: "registerRunRoutes AdapterProtocolError mapping", kind: "route behavior", signature: "AdapterProtocolError => HTTP 409 adapter_protocol_failed for input and cancel" }`
- `imports_from_other_tasks`:
  - `{ from_task: "P3-T1-contracts-runtime-mode-and-inference", name: "RegistryService.inferAndValidateRuntimeMode", signature: "(input: { runtime: string; provider: string; adapterType: AdapterType; runtimeMode?: string }) => Promise<string | undefined>" }`
  - `{ from_task: "P3-T2-core-runner-protocol-timeout", name: "AdapterProtocolError", signature: "new AdapterProtocolError(message: string, options?: { reasonCode?: string; details?: Record<string, unknown> })" }`
  - `{ from_task: "P3-T4-testkit-fake-http-and-contract-harness", name: "startFakeHttpRuntimeServer", signature: "(options?: FakeHttpRuntimeServerOptions) => Promise<{ baseUrl: string; url(path: string): string; close(): Promise<void> }>" }`
  - `{ from_task: "P3-T5-generic-http-adapter", name: "GenericHttpAsyncRestAdapter", signature: "constructor(options?: GenericHttpAsyncRestAdapterOptions); implements RuntimeAdapter" }`
- `file_paths_consumed_by_other_tasks`:
  - `apps/daemon/src/config.ts`
  - `apps/daemon/src/app.ts`
  - `packages/protocol-rest/src/run-routes.ts`

### Task P3-T7-development-docs-generic-http

`id`: `P3-T7-development-docs-generic-http`
`title`: Update local development and API docs for Generic HTTP
`files`:
- Modify: `docs/development/API.md`
- Modify: `docs/development/DEVELOPMENT.md`
- Modify: `docs/development/adapters/README.md`
- Modify: `docs/development/adapters/CODEX.md`
- Create: `docs/development/adapters/GENERIC_HTTP.md`

`dependencies`:
- `P3-T6-rest-daemon-generic-http-wiring`

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-3-r4-shared-runtime-substrates-and-generic-http.md` - exact public and smoke contract for R4 docs.
- `docs/development/API.md` - current local daemon API contract and examples.
- `docs/development/DEVELOPMENT.md` - current smoke and verification guide.
- `docs/development/adapters/README.md` - adapter guide index.
- `docs/development/adapters/CODEX.md` - Codex debugging guide that must acknowledge shared process substrate without changing public behavior.
- `docs/adapters/generic-http.md` - prior Generic HTTP research note to convert into shipped local development guidance.

`instructions`: Update shipped-tense development docs to include Generic HTTP while keeping ACP, PTY, interactive Codex, hosted worker execution, SDK, CLI, tools, memory, debate, webhooks, per-run base URL overrides, and remote artifact URL fetching explicitly unshipped. In `API.md`, add Generic HTTP run-create example, runtime-mode inference bullet, runtime-mode/doctor example snippets, unsupported input behavior, verified-terminal cancel behavior, cancel failure behavior, and artifact transcript content behavior. In `DEVELOPMENT.md`, add the two-terminal fake wrapper plus daemon smoke from the spec, including `SWITCHYARD_GENERIC_HTTP_BASE_URL`. In adapter docs index, add Generic HTTP as implemented. In `CODEX.md`, mention that R4 moved common process plumbing into shared substrates while preserving Codex `exec --json` behavior, logs, and transcript path. Create `GENERIC_HTTP.md` with config variables, wrapper API contract, fake wrapper manual smoke, expected logs, common stuck states, secret-safety rules, bounded response rules, and focused verification commands.

`acceptance`:
- Docs show `generic_http.async_rest` as shipped and locally verifiable.
- API docs include Generic HTTP request payload and inference behavior.
- Local development docs include exact fake HTTP wrapper startup and daemon startup commands.
- Generic HTTP adapter guide lists all daemon env vars, defaults, and no-secret transcript/log rules.
- Docs clearly state unshipped boundaries: no webhooks, no dynamic per-run base URL, no post-start input, no remote artifact URL fetching, no ACP/PTY/interactive Codex/hosted execution.
- Final verification commands include `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm lint`, and `git diff --check`.

`checks`:
- `git diff --check docs/development/API.md docs/development/DEVELOPMENT.md docs/development/adapters/README.md docs/development/adapters/CODEX.md docs/development/adapters/GENERIC_HTTP.md`
- `pnpm --filter @switchyard/daemon test`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `docs/development/API.md` | Docs show unimplemented per-run base URL or webhooks | Text search finds per-run override as supported | State base URL is daemon env only and webhooks are not shipped | Users do not build against non-existent API |
| `docs/development/DEVELOPMENT.md` | Smoke commands omit fake wrapper or required env | Manual smoke cannot reach Generic HTTP runtime | Include terminal 1 fake wrapper and terminal 2 daemon with base URL | Developer can verify R4 locally |
| `docs/development/adapters/GENERIC_HTTP.md` | Secret token appears in transcript/log examples | Example includes Authorization value in logs/transcript | Use redacted wording and state tokens are never logged/stored | Docs reinforce secret boundary |
| `docs/development/adapters/CODEX.md` | Codex docs imply behavior changed | Manual smoke or log names no longer match | Phrase substrate extraction as internal only and preserve existing log names | Codex users keep same debugging workflow |

`observability`:
- `logs`: Documentation names expected `generic_http.*` and existing Codex log events so operators know what to inspect.
- `success_metric`: A developer can copy the documented fake wrapper and daemon commands and run the documented curl sequence.
- `failure_metric`: Docs mention unshipped features as shipped or omit required Generic HTTP config.

`test_cases`:
- `{ name: "api docs include generic run payload", lens: "happy", given: "read API.md", expect: "contains runtime generic_http, provider generic_http, adapterType http, model generic-http-default" }`
- `{ name: "development docs include fake wrapper smoke", lens: "integration", given: "read DEVELOPMENT.md", expect: "contains testkit fake-http-runtime command and SWITCHYARD_GENERIC_HTTP_BASE_URL" }`
- `{ name: "generic guide lists env vars", lens: "happy", given: "read GENERIC_HTTP.md", expect: "all five Generic HTTP env vars and defaults are documented" }`
- `{ name: "docs state unsupported input", lens: "error_path", given: "read API and GENERIC_HTTP docs", expect: "POST input returns 409 adapter_protocol_failed for Generic HTTP" }`
- `{ name: "docs state verified cancel", lens: "edge_cancel", given: "read API and GENERIC_HTTP docs", expect: "2xx wrapper cancel acknowledgement alone is not enough; Switchyard reports cancelled only after verified terminal cancellation" }`
- `{ name: "docs state no per-run base url", lens: "edge_security", given: "read Generic HTTP guide", expect: "base URL comes only from daemon env and metadata cannot override it" }`

`integration_contracts`:
- `exports`:
  - `{ name: "Generic HTTP local docs", kind: "document", signature: "docs/development/adapters/GENERIC_HTTP.md describes R4 Generic HTTP setup, API, logs, smoke, and limits" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`: []
- `document_dependencies`:
  - `{ from_task: "P3-T5-generic-http-adapter", subject: "GenericHttpAsyncRestAdapter manifest, verified cancel behavior, bounded HTTP responses, and token redaction" }`
  - `{ from_task: "P3-T6-rest-daemon-generic-http-wiring", subject: "daemon env names, REST behavior, doctor output, and smoke command behavior" }`

### Task P3-T8-product-architecture-release-docs

`id`: `P3-T8-product-architecture-release-docs`
`title`: Update product, changelog, architecture, and adapter research truth for R4
`files`:
- Modify: `PRODUCT.md`
- Modify: `CHANGELOG.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/adapters/README.md`
- Modify: `docs/adapters/generic-http.md`

`dependencies`:
- `P3-T6-rest-daemon-generic-http-wiring`

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-3-r4-shared-runtime-substrates-and-generic-http.md` - R4 product truth, promotion criteria, and docs checklist.
- `PROJECT.md` - prior phase summaries and user-facing release train state.
- `PRODUCT.md` - current product truth and R4 roadmap entry.
- `CHANGELOG.md` - current unreleased section.
- `ARCHITECTURE.md` - runtime adapter layer and roadmap references.
- `docs/adapters/README.md` - adapter research status table.
- `docs/adapters/generic-http.md` - Generic HTTP research note.

`instructions`: Update owner-facing truth after implementation closeout. `PRODUCT.md` must move Generic HTTP from not shipped to shipped current product state, list shipped runtime modes `fake.deterministic`, `codex.exec_json`, and `generic_http.async_rest`, describe shared process substrates and Generic HTTP wrapper behavior, and preserve explicit unshipped boundaries. `CHANGELOG.md` must add R4 entries under Unreleased for shared substrates, Generic HTTP adapter, fake HTTP wrapper, contract harness, daemon env config, runtime-mode/doctor wiring, cancellation terminalization, and docs. `ARCHITECTURE.md` must update the adapter layer description to say process substrates exist and Generic HTTP is implemented as a strict async REST wrapper mode. Adapter research docs must mark Generic HTTP implemented for R4 and keep other wrappers deferred. Do not edit `PROJECT.md`; CEO updates it at phase close.

`acceptance`:
- `PRODUCT.md` current snapshot and shipped runtime lists include `generic_http.async_rest`.
- `PRODUCT.md` no longer lists Generic HTTP adapter as missing while still listing ACP, PTY, hosted, SDK/CLI, dashboard, debate, tools, memory, approvals, and interactive Codex as unshipped.
- `CHANGELOG.md` Unreleased section has clear Added/Changed bullets for R4.
- `ARCHITECTURE.md` reflects shared adapter substrates and implemented Generic HTTP without claiming hosted safety beyond local configured wrapper mode.
- `docs/adapters/README.md` and `docs/adapters/generic-http.md` mark Generic HTTP implemented and point to development docs.
- `PROJECT.md` is untouched by this task.

`checks`:
- `git diff --check PRODUCT.md CHANGELOG.md ARCHITECTURE.md docs/adapters/README.md docs/adapters/generic-http.md`
- `git diff -- PROJECT.md`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `PRODUCT.md` current truth | Generic HTTP appears in both shipped and missing lists | Text scan finds contradictory status | Remove missing entry and add shipped runtime wording in one current-state section | Owner sees one product truth |
| `CHANGELOG.md` | R4 hidden under old R3 bullets | Unreleased section lacks Generic HTTP entries | Add explicit R4 Added and Changed bullets | Release history explains what changed |
| `ARCHITECTURE.md` | Architecture claims full generic wrapper platform or hosted mode | Text implies webhooks/per-run base URL/hosted worker shipped | State strict async REST local/configured wrapper mode only | Future implementers do not overbuild from docs |
| adapter research docs | Generic HTTP still says ready for contract design | Status table outdated | Mark implemented and link to `docs/development/adapters/GENERIC_HTTP.md` | Adapter status matches code |
| `PROJECT.md` | CTO edits phase-close source of truth | Git diff includes PROJECT.md | Revert only this task's accidental PROJECT.md edit before GREEN | CEO remains sole PROJECT.md owner |

`observability`:
- `logs`: Docs describe the runtime and adapter logs produced by implementation tasks; no runtime code changes in this task.
- `success_metric`: Product truth and architecture agree with implemented R4 shipped/unshipped boundary.
- `failure_metric`: Docs contradict each other or claim non-goal features as shipped.

`test_cases`:
- `{ name: "product shipped list includes generic http", lens: "happy", given: "read PRODUCT.md", expect: "generic_http.async_rest listed with fake and codex shipped modes" }`
- `{ name: "product missing list excludes generic http", lens: "happy", given: "read PRODUCT.md What Does Not Exist Yet", expect: "Generic HTTP adapter is not listed as missing" }`
- `{ name: "non-goals remain unshipped", lens: "edge_scope", given: "read PRODUCT.md and ARCHITECTURE.md", expect: "ACP, PTY, hosted, SDK, CLI, debate, tools, memory, approval, interactive Codex remain unshipped" }`
- `{ name: "changelog has R4 bullets", lens: "happy", given: "read CHANGELOG.md Unreleased", expect: "mentions shared runtime substrates, Generic HTTP, fake HTTP server, contract harness, runtime-mode/doctor wiring, and docs" }`
- `{ name: "adapter research status updated", lens: "happy", given: "read docs/adapters/README.md and docs/adapters/generic-http.md", expect: "Generic HTTP status is implemented and links to development guide" }`
- `{ name: "project md untouched", lens: "edge_ownership", given: "git diff -- PROJECT.md", expect: "empty diff" }`

`integration_contracts`:
- `exports`:
  - `{ name: "R4 product truth", kind: "document", signature: "PRODUCT.md and CHANGELOG.md describe R4 shipped surface and boundaries" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`: []
- `document_dependencies`:
  - `{ from_task: "P3-T5-generic-http-adapter", subject: "implemented Generic HTTP runtime behavior and strict R4 boundaries" }`
  - `{ from_task: "P3-T6-rest-daemon-generic-http-wiring", subject: "daemon, REST, runtime-mode, doctor, and smoke behavior" }`

## Integration Points

- Task order: `P3-T1` and `P3-T2` can start independently. `P3-T3` depends on `P3-T2`. `P3-T4` depends on `P3-T2`. `P3-T5` depends on `P3-T1`, `P3-T2`, `P3-T3`, and `P3-T4`. `P3-T6` depends on `P3-T1`, `P3-T2`, `P3-T4`, and `P3-T5`. Docs tasks `P3-T7` and `P3-T8` depend on `P3-T6`.
- Runtime dispatch remains keyed by public run `runtime`, so daemon must register the Generic HTTP adapter under map key `generic_http`.
- Generic HTTP manifests and registry records must use exact ids from the spec. Run payloads use slugs: provider `generic_http`, runtime `generic_http`, model `generic-http-default`, adapter type `http`, runtime mode `generic_http.async_rest`.
- `AdapterProtocolError` is the cross-task bridge from adapters/core to REST. Adapter-specific error-name checks should not remain as the only mapping path.
- `RuntimeDoctorService` must route `http_health` checks through adapter-provided availability details; Generic HTTP must not pass through the Codex binary/version/model branch.
- Generic HTTP cancel must be verified-terminal before `RuntimeRunnerService` marks the run cancelled. A 2xx wrapper acknowledgement alone is not an integration contract.
- Task `P3-T5` remains one task because it owns one adapter package boundary and eight files, but review and audit must use its `reviewer_auditor_focus` checklist before GREEN.
- The fake HTTP wrapper is only in testkit and docs. It is not a Switchyard product daemon, public REST route, hosted worker, or adapter dependency at runtime.
- No storage migration is required unless implementation changes persisted shapes beyond existing R3 nullable `runtimeMode` and artifact metadata. R4 transcript metadata additions are additive JSON metadata only.

## Phase Acceptance Criteria

- `codex.exec_json` still passes existing tests and smoke checks after process substrate extraction.
- Process-backed adapter code no longer owns generic queue, drain, transcript, timeout, and JSONL harness logic inline.
- Generic HTTP is registered as `generic_http.async_rest` and appears in runtime mode and doctor APIs.
- Generic HTTP doctor/check maps missing config, invalid config, timeout, non-2xx, invalid JSON, oversized health body, success without auth, and success with auth through `http_health` without token leakage.
- Generic HTTP can complete, fail, verified-cancel, timeout, output events, and produce artifacts against the fake HTTP wrapper server.
- Generic HTTP rejects 2xx-only cancel acknowledgement with non-terminal status, `{ cancelled: false }`, timeout, 404 plus non-terminal status, and oversized cancel response without silently marking the run cancelled.
- Generic HTTP enforces oversized-body bounds on health, start, status, events, cancel, and artifacts with endpoint-specific reason codes and bounded logs/transcripts.
- Generic HTTP event polling handles `terminal: true` without a terminal event, absent event ids, duplicate event ids, absent cursors, and cursor fallback without duplicate visible events.
- Transcript artifacts are stored for both Codex and Generic HTTP runs through the existing artifact content store path.
- Adapter contract tests are reusable and run against fake, Codex with fake process, and Generic HTTP with fake server.
- Fake and Generic HTTP post-start input fail with `AdapterProtocolError`; R4 does not add `run.input`.
- Product/API/development docs say Generic HTTP is shipped and ACP, PTY, full Codex interactive, hosted execution, SDK/CLI, debate, tools, memory, and approval remain unshipped.

## Final Verification

Focused checks:

```bash
git diff --check
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/testkit test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test
```

Full workspace checks before promotion:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

Manual Generic HTTP smoke that implementation must make valid:

```bash
pnpm --filter @switchyard/testkit fake-http-runtime -- --host 127.0.0.1 --port 5055
```

```bash
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-r4-generic-http \
SWITCHYARD_GENERIC_HTTP_BASE_URL=http://127.0.0.1:5055 \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

```bash
BASE=http://127.0.0.1:4546
curl -s "$BASE/runtime-modes/generic_http.async_rest" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/generic_http.async_rest/check" | python3 -m json.tool
RUN_ID=$(curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"generic_http","provider":"generic_http","model":"generic-http-default","adapterType":"http","cwd":"/repo","task":"r4 http smoke","timeoutSeconds":30}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["run"]["id"])')
curl -s "$BASE/runs/$RUN_ID/events" | head -n 20
curl -s "$BASE/runs/$RUN_ID/artifacts" | python3 -m json.tool
```

## Risks

- Codex process extraction can regress subtle behavior: stdin closure, fake process ordering, late stderr capture, invalid JSONL failure ordering, and transcript path. Task `P3-T3` is deliberately regression-heavy.
- Generic HTTP can sprawl into a general integration framework. This plan keeps one strict wrapper contract, daemon-level config only, inline artifacts only, no webhooks, and no dynamic endpoint/auth maps.
- Core timeout helper placement is constrained by package dependency direction. Core owns the timeout primitive; adapters expose an adapter substrate wrapper so core never imports from adapters.
- Runtime doctor checks are currently Codex-biased for non-fake modes. Task `P3-T2` explicitly adds `http_health` availability mapping so Generic HTTP does not report false binary failures.
- Cancel semantics can lie if upstream acknowledgement is treated as terminal state. Tasks `P3-T2`, `P3-T5`, and `P3-T6` pin verified-terminal cancellation and failure-preserves-state tests.
- Generic HTTP token leakage can cross several surfaces at once. Tasks `P3-T2`, `P3-T4`, `P3-T5`, `P3-T6`, and `P3-T7` include log, doctor, error, transcript, and docs redaction coverage.
- The phase is large. The task split keeps ownership disjoint, but integration sequencing matters and auditor should run full workspace checks after merge.

## Self-Review

- Spec coverage: every promotion criterion maps to at least one task: contracts/inference `P3-T1`, core doctor and runner lifecycle `P3-T2`, Codex substrates `P3-T3`, fake server/contracts `P3-T4`, Generic HTTP adapter `P3-T5`, REST/daemon `P3-T6`, docs `P3-T7` and `P3-T8`.
- Placeholder scan: no unresolved placeholders remain.
- Type consistency: Generic HTTP slug, ids, adapter id, provider id, runtime id, model id, `AdapterProtocolError`, `runtimeCapabilitySchema`, `TranscriptRecorder`, `startFakeHttpRuntimeServer`, and `runRuntimeAdapterContract` signatures are consistent across tasks.
- Ownership disjoint: no file is owned by more than one task.
- Context files real: all context paths listed above exist in this worktree before implementation starts.
- Acceptance testable: each task has objective checks and enumerated test cases.
- Dependency order: cross-task imports only point to earlier dependency tasks.
- Checks runnable: commands use existing pnpm package scripts and final workspace scripts.
- Error/rescue maps present: every runtime task has failure-specific rescue rows and user-visible behavior.
- Observability present: runtime tasks name logs and success/failure metrics; docs-only tasks explain log documentation.
- Test cases enumerate happy, nil, empty, error, edge, and integration paths required by the spec, including doctor HTTP availability mapping, verified cancel failure modes, oversized endpoint bodies, absent event ids/cursors, and token redaction.
- Integration contracts walk: every `imports_from_other_tasks` entry resolves to an export in the named task.
- Contract types match: task import signatures match exporter signatures in this plan.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error-rescue entry has matching error, nil, empty, edge, or integration test coverage.
- [x] Every cross-task import resolves to a task export.
- [x] Every context file path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text remains.
- [x] Complexity is L and the phase remains one release because the spec explicitly defines R4 as the substrate plus Generic HTTP wrapper validation slice; `P3-T5` stays single because it owns one adapter boundary and eight files, with reviewer/auditor focus called out.
