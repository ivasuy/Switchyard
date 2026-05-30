# Phase 5: R6 Wrapper Runtime Integration - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-29-phase-5-r6-wrapper-runtime-integration.md`
**Spec commit:** `19319e549d28fa60e05bc3bd0ca7ec141436c453`
**Branch:** `agent/phase-5-r6-wrapper-runtime-integration`
**Worktree:** `.worktrees/native-roadmap-20260529/phase-5-r6-wrapper-runtime-integration`
**Plan target:** `docs/superpowers/plans/phase-5-r6-wrapper-runtime-integration.md`
**Complexity:** M

## Goal

Ship R6 by adding `agentfield.async_rest` as a configured async REST wrapper runtime. A configured AgentField target must be launchable through the normal Switchyard run API, polled to terminal status, mapped into normalized events, checked through runtime doctor, and inspected through sanitized transcript/result artifacts.

R6 deliberately reuses the existing runtime-mode, adapter, doctor, runner, event, and artifact paths. It does not add OpenClaw, Paperclip, hosted workers, debate orchestration, webhooks, SDK/CLI/TUI/dashboard work, dynamic per-run AgentField routing, or a second control plane.

## Architecture

```text
POST /runs
  -> RegistryService infers agentfield.async_rest
  -> RuntimeRunnerService.start
  -> AgentFieldAsyncRestAdapter
       -> POST /api/v1/execute/async/{configuredTarget}
       -> GET /api/v1/executions/{executionId}
       -> normalized runtime.status/runtime.output/run.completed|failed events
       -> sanitized agentfield-transcript.jsonl artifact
       -> bounded raw AgentField result artifact
```

Doctor flow:

```text
POST /runtime-modes/agentfield.async_rest/check
  -> RuntimeDoctorService.checkRuntimeMode
  -> AgentFieldAsyncRestAdapter.check
       -> config presence validation
       -> GET /api/v1/health
       -> optional GET /api/v1/agents or target discovery diagnostic if implemented cheaply
  -> adapter-provided http_health availability
  -> stored runtime-mode availability snapshot
```

Cancellation and post-start input:

```text
POST /runs/:id/cancel while active
  -> AgentFieldAsyncRestAdapter.cancel
  -> AdapterProtocolError(reasonCode: agentfield_cancel_unsupported)
```

R6 must not mark active AgentField runs cancelled because no AgentField cancellation endpoint is verified in the spec. Post-start input returns `agentfield_input_unsupported`.

## Existing Anchors

- `packages/adapters/src/generic-http/generic-http-adapter.ts` is the nearest wrapper adapter for manifest shape, bounded HTTP calls, polling, visible failure mapping, transcript artifacts, and unsupported input behavior.
- `packages/adapters/src/generic-http/http-client.ts` provides a bounded JSON HTTP helper. The AgentField adapter may reuse it or extract a neutral helper only if the implementation stays small.
- `packages/adapters/src/substrates/transcript-recorder.ts` provides the artifact metadata-content convention.
- `packages/core/src/services/registry-service.ts` is the only runtime-mode inference point.
- `packages/core/src/services/runtime-doctor-service.ts` already consumes adapter-provided availability for HTTP health checks.
- `packages/core/src/services/runtime-runner-service.ts` already terminalizes adapter events and persists artifact content.
- `apps/daemon/src/config.ts` and `apps/daemon/src/app.ts` own daemon-level runtime configuration, adapter construction, registry seeding, and runtime-mode manifest seeding.
- `packages/testkit/src/fake-http-runtime-server.ts` is the deterministic fake wrapper server model, but AgentField should get a separate fake server so endpoint and payload shapes stay provider-specific.

## Task Graph

### Task P5-T1-agentfield-async-rest-runtime

`id`: `P5-T1-agentfield-async-rest-runtime`
`title`: Ship AgentField async REST adapter, daemon wiring, fake verification, and docs`

`files`:
- Create: `packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts`
- Create: `packages/adapters/src/agentfield/http-client.ts`
- Create: `packages/adapters/src/agentfield/types.ts`
- Create: `packages/adapters/src/agentfield/index.ts`
- Modify: `packages/adapters/src/index.ts`
- Create: `packages/adapters/test/agentfield-async-rest-adapter.test.ts`
- Modify: `packages/adapters/test/runtime-adapter-contracts.test.ts`
- Create: `packages/testkit/src/fake-agentfield-server.ts`
- Create: `packages/testkit/src/fake-agentfield-cli.ts`
- Modify: `packages/testkit/src/index.ts`
- Create: `packages/testkit/test/fake-agentfield-server.test.ts`
- Modify: `packages/testkit/package.json`
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`
- Modify: `packages/core/src/services/registry-service.ts`
- Modify: `packages/core/test/registry-service.test.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/protocol-rest/test/run-routes.test.ts`
- Create: `docs/development/adapters/AGENTFIELD.md`
- Modify: `docs/development/adapters/README.md`
- Modify: `docs/development/API.md`
- Modify: `docs/development/DEVELOPMENT.md`
- Modify: `PRODUCT.md`
- Modify: `CHANGELOG.md`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-5-r6-wrapper-runtime-integration.md`
- `PRODUCT.md`
- `PROJECT.md`
- `packages/core/src/ports/runtime-adapter.ts`
- `packages/adapters/src/generic-http/generic-http-adapter.ts`
- `packages/adapters/src/generic-http/http-client.ts`
- `packages/adapters/src/generic-http/types.ts`
- `packages/adapters/src/substrates/transcript-recorder.ts`
- `packages/core/src/services/registry-service.ts`
- `packages/core/src/services/runtime-doctor-service.ts`
- `packages/core/src/services/runtime-runner-service.ts`
- `apps/daemon/src/config.ts`
- `apps/daemon/src/app.ts`
- `packages/testkit/src/fake-http-runtime-server.ts`
- `docs/development/adapters/GENERIC_HTTP.md`

`instructions`: Implement `AgentFieldAsyncRestAdapter` as one configured HTTP wrapper adapter with manifest slug `agentfield.async_rest`, adapter id `agentfield`, provider id `provider_agentfield`, runtime id `runtime_agentfield`, runtime-mode id `runtime_mode_agentfield_async_rest`, adapter type `http`, and kind `async_rest`. Add daemon config from `SWITCHYARD_AGENTFIELD_BASE_URL`, `SWITCHYARD_AGENTFIELD_API_KEY`, `SWITCHYARD_AGENTFIELD_TARGET`, `SWITCHYARD_AGENTFIELD_REQUEST_TIMEOUT_MS`, `SWITCHYARD_AGENTFIELD_POLL_INTERVAL_MS`, and `SWITCHYARD_AGENTFIELD_MAX_RESPONSE_BYTES`. Base URL, API key, and target are daemon-level only; do not accept per-run base URL, key, target, or arbitrary headers.

The adapter must call `GET /api/v1/health` for checks, `GET /api/v1/discovery/capabilities?format=compact` for optional target diagnostics, `POST /api/v1/execute/async/{target}` to start, and `GET /api/v1/executions/{executionId}` to poll status/result. It must map queued/pending/running states to `runtime.status`, successful terminal states to output plus `run.completed`, and failed/cancelled/timeout terminal states to `run.failed` with `agentfield_status_failed`, `agentfield_upstream_cancelled`, or `agentfield_upstream_timeout`. Unknown or malformed AgentField payloads must fail visibly with named `agentfield_*` reason codes. Preserve `agentfieldExecutionId`, configured target, upstream status, and bounded upstream result/error payloads in normalized events and artifacts. Sanitize bearer tokens and API keys from transcripts, logs, event payloads, and artifacts.

Implement `send` as unsupported with `agentfield_input_unsupported`. Implement active `cancel` as unsupported with `agentfield_cancel_unsupported`; if the session is already terminal, return idempotently. Non-terminal polling continues until `RuntimeRunnerService` timeout; the adapter does not emit its own timeout unless upstream status is `timeout`. Do not claim upstream cancellation support in manifest capabilities. Build a deterministic fake AgentField server and `pnpm --filter @switchyard/testkit fake-agentfield` CLI for CI/local verification with all spec-required scenarios. Wire daemon seeding, runtime-mode inference, runtime doctor availability, REST route tests, app smoke tests, and docs. Keep the implementation inside existing Switchyard control planes.

If reusing the R4 Generic HTTP bounded request helper, first extract a neutral helper or wrap fetch/network failures so AgentField surfaces `agentfield_request_failed`, never `generic_http_request_failed`.

`acceptance`:
- `agentfield.async_rest` appears in runtime-mode registry output with the expected provider/runtime/model/manifest fields.
- `runtime: "agentfield"` plus `adapterType: "http"` infers `agentfield.async_rest`; mismatched explicit runtime modes are rejected.
- Explicit internal runtime-mode id `runtime_mode_agentfield_async_rest` is rejected in public create bodies.
- Unconfigured daemon reports unavailable doctor/runtime-mode state with reason `agentfield_config_missing`; invalid base URL reports `agentfield_config_invalid`; missing API key reports `agentfield_auth_missing`; missing target reports `agentfield_target_missing`.
- Configured fake AgentField health/discovery check reports available and never exposes the API key; doctor/check never creates an AgentField execution.
- A fake AgentField happy run starts, emits normalized status/output/completion events, stores sanitized transcript artifact content, stores a raw result artifact, and includes `agentfieldExecutionId` metadata.
- Upstream failed/cancelled/timeout/malformed/oversized responses fail visibly with named `agentfield_*` reasons.
- Active cancel returns `409 adapter_protocol_failed` with `agentfield_cancel_unsupported` and does not falsely mark the run cancelled.
- Post-start input returns `409 adapter_protocol_failed` with `agentfield_input_unsupported`.
- Switchyard timeout marks AgentField runs `timeout` even though upstream cancel is unsupported, and late upstream success does not overwrite the terminal state.
- AgentField artifacts are retrievable through `GET /runs/:id/artifacts`, `GET /artifacts/:id`, and `GET /artifacts/:id/content`.
- Fake AgentField CI path covers auth success/failure without uncontrolled model spend.
- Docs explain local fake verification and optional real AgentField smoke with explicit spend warning.
- `PRODUCT.md` and `CHANGELOG.md` record R6 as shipped without claiming OpenClaw, Paperclip, hosted workers, debate, or verified upstream cancellation.

`checks`:
- `pnpm --filter @switchyard/testkit test -- fake-agentfield`
- `pnpm --filter @switchyard/testkit typecheck`
- `pnpm --filter @switchyard/adapters test -- agentfield`
- `pnpm --filter @switchyard/adapters test -- runtime-adapter-contracts`
- `pnpm --filter @switchyard/core test -- registry-service`
- `pnpm --filter @switchyard/contracts test -- contracts`
- `pnpm --filter @switchyard/protocol-rest test -- run-routes`
- `pnpm --filter @switchyard/daemon test -- smoke`
- `pnpm --filter @switchyard/adapters typecheck`
- `pnpm --filter @switchyard/testkit typecheck`
- `pnpm --filter @switchyard/daemon typecheck`
- `git diff --check`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| config parsing | Missing or invalid AgentField config is reported as a generic runtime failure | unset base URL/API key/target or invalid URL | Validate in adapter constructor/check and daemon initial availability | Runtime-mode doctor shows `agentfield_config_missing` or `agentfield_config_invalid` |
| config parsing | Auth or target absence is collapsed into generic config missing | API key or target is unset/empty | Validate each required value separately | Doctor shows `agentfield_auth_missing` or `agentfield_target_missing` |
| `check` | Health check leaks bearer token or raw upstream details | upstream returns auth/config errors | Sanitize messages and never echo Authorization/API key | Doctor output is actionable without secrets |
| `check` | Health degraded is treated as hard unavailable | AgentField returns degraded JSON | Map to partial availability with `agentfield_health_degraded` | Operators see degraded but runnable state |
| `check` | Discovery outage blocks all execution | health succeeds but discovery 404/non-2xx/invalid/times out | Map to partial availability with `agentfield_discovery_unavailable` | Runtime remains runnable with warning |
| `check` | Missing configured target is ignored | discovery succeeds but excludes target | Map to unavailable `agentfield_target_not_found` | Operator sees target misconfiguration |
| HTTP client | AgentField network failure surfaces Generic HTTP reason code | shared helper throws `generic_http_request_failed` | Neutralize/extract helper or remap to `agentfield_request_failed` | Run/check shows provider-correct reason |
| `start` | Async create response has no execution id | malformed AgentField response | Reject with `agentfield_invalid_start_response` | Run fails visibly at start |
| `start` | Async create returns non-2xx or auth failure | AgentField returns 401/403/500 | Reject with `agentfield_start_failed` and sanitized transcript | Run fails with named start reason |
| `start` | Invalid custom input metadata reaches upstream | `metadata.agentfield.input` is not an object | Reject before HTTP request with `agentfield_input_invalid` | Run fails without creating execution |
| `start` | Header metadata corrupts request headers | workflow/session/actor metadata is non-string | Reject before HTTP request with `agentfield_header_metadata_invalid` | Run fails without creating execution |
| `events` polling | Unknown status loops forever | docs/runtime adds a new status | Treat unknown/malformed status as `agentfield_invalid_status_response` | Run fails instead of hanging |
| `events` polling | Empty polling never terminalizes | no terminal status before timeout | Continue polling until `RuntimeRunnerService` timeout; do not emit adapter timeout unless upstream status is `timeout` | Run is marked `timeout` by Switchyard |
| `events` polling | Upstream failed/cancelled/timeout statuses collapse into generic failure | terminal status is `failed`, `cancelled`, or `timeout` | Emit `agentfield_status_failed`, `agentfield_upstream_cancelled`, or `agentfield_upstream_timeout` | User sees the true upstream terminal reason |
| result mapping | Large result payload exhausts memory or bloats events | upstream returns huge result/error | Enforce max response bytes and bound event payloads; store bounded raw artifact only | Event remains small; artifact failure has named reason |
| artifacts | Terminal payload is valid but inaccessible through public artifact endpoints | artifact metadata/content handoff is wrong | Use existing `metadata.content` storage convention and test all artifact routes | User can inspect transcript/result content |
| transcript | Secret appears in artifact/log/event | Bearer/API key in request or upstream error | Redact before transcript append/logging/artifact metadata | Artifacts and logs contain `[REDACTED]` |
| `cancel` | Public cancel marks run cancelled without upstream verification | active AgentField session | Throw `AdapterProtocolError` reason `agentfield_cancel_unsupported`; return only for terminal sessions | API returns 409; run remains truthful |
| fake server | Tests depend on real AgentField or spend budget | CI lacks external service | Use fake AgentField server for all automated tests | CI remains deterministic and offline |

`observability`:
- `logs`: Adapter logs `agentfield.check`, `agentfield.start`, `agentfield.poll`, and `agentfield.request` with method/path/status/duration/reasonCode/target/execution id only. No raw request body, API key, Authorization header, or arbitrary headers.
- `success_metric`: Fake AgentField happy run reaches `run.completed`, stores transcript and result artifacts, and runtime-mode availability becomes `available`.
- `failure_metric`: Invalid config, auth failure, malformed responses, oversized responses, active cancel, and post-start input produce named reason codes in tests.

`test_cases`:
- `{ name: "manifest parses", lens: "happy", given: "new AgentField adapter", expect: "manifest slug agentfield.async_rest and no run.cancel capability" }`
- `{ name: "missing config unavailable", lens: "happy_shadow_nil", given: "no AgentField env", expect: "doctor availability reason agentfield_config_missing" }`
- `{ name: "auth and target config unavailable", lens: "happy_shadow_nil", given: "missing API key or target", expect: "agentfield_auth_missing or agentfield_target_missing" }`
- `{ name: "registry seeding and inference", lens: "integration", given: "daemon startup and public create payload without runtimeMode", expect: "AgentField provider/runtime/model/mode seeded and agentfield.async_rest inferred; internal id rejected" }`
- `{ name: "fake health available", lens: "happy", given: "fake server and API key", expect: "check ok and no key in details" }`
- `{ name: "doctor matrix", lens: "integration", given: "health degraded, target not found, discovery unavailable, timeout, and oversized health scenarios", expect: "agentfield_health_degraded, agentfield_target_not_found, agentfield_discovery_unavailable, check_timeout, or check_output_too_large" }`
- `{ name: "doctor does not execute", lens: "edge_no_spend", given: "fake server with request counters", expect: "check performs zero async create calls" }`
- `{ name: "happy async execution", lens: "integration", given: "fake start then running then succeeded result", expect: "status/output/completed events plus transcript/result artifacts" }`
- `{ name: "failed upstream execution", lens: "error_path", given: "fake failed status with error", expect: "run.failed with agentfield_status_failed metadata" }`
- `{ name: "upstream cancelled and timeout", lens: "error_path", given: "fake cancelled or timeout status", expect: "agentfield_upstream_cancelled or agentfield_upstream_timeout" }`
- `{ name: "custom input validation", lens: "error_path", given: "metadata.agentfield.input is array/string/null", expect: "agentfield_input_invalid before upstream create" }`
- `{ name: "header metadata validation", lens: "error_path", given: "workflow/session/actor metadata is non-string", expect: "agentfield_header_metadata_invalid before upstream create" }`
- `{ name: "malformed start response", lens: "error_path", given: "start response without execution id", expect: "agentfield_invalid_start_response" }`
- `{ name: "malformed poll response", lens: "error_path", given: "poll response without valid status", expect: "agentfield_invalid_status_response" }`
- `{ name: "unknown upstream status", lens: "error_path", given: "fake unknown status", expect: "agentfield_unknown_status" }`
- `{ name: "oversized response bounded", lens: "edge_oversized", given: "fake oversized start/poll/result body", expect: "agentfield_start_response_too_large, agentfield_status_response_too_large, or agentfield_result_too_large" }`
- `{ name: "base URL path prefix", lens: "edge_url", given: "base URL with /prefix and /prefix/", expect: "requests preserve prefix for /api/v1 endpoints" }`
- `{ name: "empty and missing result", lens: "happy_shadow_empty", given: "succeeded response with null or absent result", expect: "run completes and terminal response artifact is stored" }`
- `{ name: "active cancel unsupported", lens: "error_path", given: "cancel active AgentField run", expect: "409 adapter_protocol_failed reason agentfield_cancel_unsupported and run not marked cancelled" }`
- `{ name: "switchyard timeout persists", lens: "error_path", given: "fake pending until timeout and adapter cancel unsupported", expect: "run status timeout and at most one terminal event" }`
- `{ name: "late success after timeout ignored", lens: "edge_race", given: "fake success after Switchyard timeout", expect: "persisted run remains timeout" }`
- `{ name: "post-start input unsupported", lens: "error_path", given: "send input after start", expect: "409 adapter_protocol_failed reason agentfield_input_unsupported" }`
- `{ name: "artifact route retrieval", lens: "integration", given: "completed fake AgentField run", expect: "GET /runs/:id/artifacts, /artifacts/:id, and /artifacts/:id/content return transcript/result content" }`
- `{ name: "secret redaction", lens: "edge_security", given: "API key and upstream error echoing token", expect: "no token substring in events, check details, logs, transcript, or artifacts" }`
- `{ name: "existing runtime regression", lens: "integration", given: "fake, Codex fake process, Generic HTTP fake server, and OpenCode fake ACP tests", expect: "existing runtime contract and daemon smoke coverage remains green" }`

`integration_contracts`:
- `exports`:
  - `{ name: "AGENTFIELD_RUNTIME_MODE_SLUG", kind: "constant", signature: "\"agentfield.async_rest\"" }`
  - `{ name: "AgentFieldAsyncRestAdapter", kind: "class", signature: "new AgentFieldAsyncRestAdapter(options?: AgentFieldAsyncRestAdapterOptions)" }`
  - `{ name: "AgentFieldAsyncRestAdapterOptions", kind: "type", signature: "{ baseUrl?: string; apiKey?: string; target?: string; requestTimeoutMs?: number; pollIntervalMs?: number; maxResponseBytes?: number; logger?: RuntimeLogger; fetch?: typeof fetch }" }`
  - `{ name: "startFakeAgentFieldServer", kind: "function", signature: "(options?: FakeAgentFieldServerOptions) => Promise<FakeAgentFieldServerHandle>" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts`
  - `packages/testkit/src/fake-agentfield-server.ts`
  - `apps/daemon/src/config.ts`
  - `apps/daemon/src/app.ts`

## Integration Order

1. Slice 1: add fake AgentField server, fake CLI, testkit script, server tests, and bounded AgentField HTTP helper tests.
2. Slice 2: implement adapter manifest/start/poll/status mapping/input/cancel/artifacts against the fake server until adapter tests pass.
3. Slice 3: wire registry inference, daemon config/seeding, runtime-mode manifest seeding, and doctor checks.
4. Slice 4: add REST/daemon smoke coverage for runs, event terminalization, artifact routes, timeout, unsupported input, and unsupported cancel.
5. Slice 5: update docs, `PRODUCT.md`, and `CHANGELOG.md` only after fake CI passes.
6. Run the focused checks, then broad package typechecks.

## Non-Blocking Deferred Concerns

- Verified upstream AgentField cancellation remains deferred until a concrete endpoint is documented and tested.
- Real AgentField target schemas may vary; R6 supports `metadata.agentfield.input` as payload customization but keeps routing daemon-level.
- Webhooks, discovery-based routing, and hosted/hybrid placement remain later roadmap work.
