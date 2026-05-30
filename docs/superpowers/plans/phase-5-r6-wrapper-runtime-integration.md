# Phase 5: R6 Wrapper Runtime Integration - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-29-phase-5-r6-wrapper-runtime-integration.md`
**Spec commit:** `19319e5`
**Branch:** `agent/phase-5-r6-wrapper-runtime-integration`
**Planner worktree:** `/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/native-roadmap-20260529/phase-5-r6-wrapper-runtime-integration`
**Task branch:** `agent/phase-5-r6-wrapper-runtime-integration--task-P5-T1-agentfield-r6-end-to-end`
**Task worktree:** `/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/native-roadmap-20260529/P5-T1-agentfield-r6-end-to-end`
**Plan target:** `docs/superpowers/plans/phase-5-r6-wrapper-runtime-integration.md`
**Complexity:** L

## Goal

Ship R6 by adding a configured `agentfield.async_rest` runtime mode that runs AgentField async executions through the existing Switchyard run, doctor, event, timeout, artifact, and REST surfaces without turning AgentField into a second Switchyard control plane.

## Scope Challenge

1. Existing code already solves the public lifecycle through `RuntimeAdapter`, `RuntimeRunnerService`, `RegistryService`, `RuntimeDoctorService`, REST routes, artifact content storage, and daemon registry seeding. R6 must plug AgentField into those seams instead of adding provider-specific daemon orchestration.
2. Minimum viable R6 is one AgentField async REST adapter, daemon-level AgentField config, one runtime-mode inference and manifest path, deterministic fake AgentField control-plane coverage, end-to-end daemon smoke tests, and docs. Webhooks, dynamic target routing, AgentField admin/memory/permission APIs, hosted workers, SDK, CLI, dashboard, and TUI work stay out of scope.
3. Complexity exceeds the normal 5-7 context-file and 8-file planning smell because this native run explicitly requires one implementer-sized task covering R6 end-to-end. Mitigation: one task owns every changed file, uses existing runtime boundaries, and keeps all provider-specific logic under `packages/adapters/src/agentfield/` plus daemon/test/docs wiring.
4. Built-in check: use Node `URL`, `AbortController`, native `fetch`, Fastify injection tests, existing `AdapterProtocolError`, existing artifact `metadata.content` handoff, existing registry/doctor services, and existing runtime timeout behavior. Do not add an HTTP framework, scheduler, queue, storage layer, SDK, OpenAPI generator, or custom URL parser.
5. Distribution check: the only new executable surface is a private testkit script, `pnpm --filter @switchyard/testkit fake-agentfield -- --host 127.0.0.1 --port 5065 --target switchyard.echo --token fake-agentfield-key`. No public CLI, npm package, container, or hosted deployment artifact ships in R6.

## Architecture

AgentField remains an adapter behind the existing runtime boundary:

```text
POST /runs
  -> RegistryService infers agentfield.async_rest
  -> RuntimeRunnerService.start
  -> AgentFieldAsyncRestAdapter
       validate daemon config and allowed metadata
       POST /api/v1/execute/async/{configured target}
       poll GET /api/v1/executions/{execution_id}
       normalize queued/pending/running/succeeded/failed/cancelled/timeout
  -> RuntimeRunnerService persists normalized events and adapter artifacts
```

Doctor/check is bounded and budget-safe:

```text
POST /runtime-modes/agentfield.async_rest/check
  -> RuntimeDoctorService.checkRuntimeMode
  -> AgentFieldAsyncRestAdapter.check
       validate daemon config
       GET /api/v1/health
       optionally GET /api/v1/discovery/capabilities?format=compact
       never POST /api/v1/execute/async/{target}
  -> custom availability snapshot and sanitized diagnostics
```

Artifacts stay adapter-owned and runner-persisted:

```text
AgentField transcript recorder
  -> runs/<runId>/agentfield-transcript.jsonl
  -> metadata.content handoff
  -> RuntimeRunnerService strips content and writes filesystem content

Terminal AgentField status body
  -> stable pretty JSON
  -> runs/<runId>/agentfield-result.json
  -> metadata.content handoff
```

Secret handling is a release gate. The adapter may log or store run id, execution id, AgentField run id, target, source status, HTTP method/path/status, duration, byte count, and named reason code. It must never log, return, or persist bearer tokens, API keys, arbitrary request headers, full request bodies, webhook secrets, or environment values.

## File Structure

- `packages/adapters/src/substrates/http-json-client.ts` - shared bounded JSON HTTP helper using native `fetch`, `AbortController`, max-byte enforcement, raw text return, and provider-supplied reason codes.
- `packages/adapters/src/generic-http/http-client.ts` - compatibility wrapper around the shared HTTP helper that preserves Generic HTTP behavior and error class imports.
- `packages/adapters/src/generic-http/generic-http-adapter.ts` - narrow import adjustment only if needed after helper extraction; Generic HTTP behavior must remain unchanged.
- `packages/adapters/src/agentfield/index.ts` - AgentField adapter barrel exports.
- `packages/adapters/src/agentfield/types.ts` - AgentField option/session/status/transcript types and scenario-neutral helpers.
- `packages/adapters/src/agentfield/http-client.ts` - AgentField-specific bounded request wrapper, base-URL path-prefix resolution, bearer auth, workflow/session/actor headers, and sanitization.
- `packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts` - runtime adapter implementation, manifest, check/start/events/send/cancel/tools/artifacts.
- `packages/adapters/src/index.ts` - exports AgentField adapter.
- `packages/adapters/test/agentfield-async-rest-adapter.test.ts` - adapter manifest, doctor, event mapping, artifact, unsupported input/cancel, timeout, and redaction tests.
- `packages/adapters/test/runtime-adapter-contracts.test.ts` - adds AgentField fake-server coverage to the shared adapter contract harness.
- `packages/testkit/src/fake-agentfield-server.ts` - deterministic fake AgentField control-plane server for all R6 scenarios.
- `packages/testkit/src/fake-agentfield-cli.ts` - private local fake AgentField CLI script entry.
- `packages/testkit/src/index.ts` - exports fake AgentField server helpers.
- `packages/testkit/package.json` - adds `fake-agentfield` package script.
- `packages/testkit/test/fake-agentfield-server.test.ts` - fake server health/discovery/auth/create/status/scenario coverage.
- `packages/core/src/services/registry-service.ts` - adds the one new inference rule for `runtime: "agentfield"` plus `adapterType: "http"`.
- `packages/core/test/registry-service.test.ts` - covers AgentField inference, explicit slug validation, mismatch rejection, and internal id rejection.
- `apps/daemon/src/config.ts` - parses daemon-level AgentField env vars.
- `apps/daemon/src/app.ts` - registers AgentField adapter, initial availability, provider/runtime/model/runtime-mode records, manifest seeding, and startup logs.
- `apps/daemon/test/smoke.test.ts` - end-to-end AgentField fake server, doctor, run, events, artifacts, timeout, unsupported input/cancel, internal id, and redaction smoke coverage.
- `apps/daemon/test/sse-leak.test.ts` - updates config fixtures for the new required `agentfield` config shape if the type changes.
- `docs/development/adapters/AGENTFIELD.md` - new safe local AgentField development guide.
- `docs/development/adapters/README.md` - lists AgentField as implemented after R6 ships.
- `docs/adapters/README.md` - updates adapter status from verified candidate to implemented local slice.
- `docs/development/API.md` - documents `agentfield.async_rest` create/check/input/cancel/artifact behavior.
- `docs/development/DEVELOPMENT.md` - adds mandatory fake AgentField verification and optional real smoke warnings.
- `PRODUCT.md` - updates product truth from R6 planned to shipped after tests pass.
- `CHANGELOG.md` - adds R6 user-facing release entry after tests pass.

## Existing Context

`packages/core/src/ports/runtime-adapter.ts` is still the only adapter lifecycle boundary. AgentField must implement `check`, `start`, `send`, `cancel`, `events`, `tools`, and `artifacts` here, not a daemon-specific runner.

`packages/adapters/src/generic-http/generic-http-adapter.ts` is the closest shipped HTTP wrapper adapter. Reuse its manifest shape, bounded request discipline, transcript artifact handoff, `AdapterProtocolError` behavior, and daemon-level config rule. Do not copy its cancellation capability, because R6 explicitly does not verify upstream AgentField cancellation.

`packages/adapters/src/generic-http/http-client.ts` already has the bounded response reader and timeout pattern. R6 should extract this into a neutral substrate or wrap it without creating a divergent unbounded fetch implementation.

`packages/core/src/services/runtime-runner-service.ts` already persists adapter artifacts through `metadata.content`, strips that field from stored metadata, writes content with `artifactContent.writeText`, catches timeout cancel failures, and terminalizes adapter-emitted events. R6 should rely on this behavior for AgentField transcript/result artifacts and Switchyard timeout semantics.

`packages/core/src/services/registry-service.ts` currently infers `fake.deterministic`, `codex.exec_json`, `generic_http.async_rest`, and `opencode.acp`. R6 adds exactly one inference: `runtime: "agentfield"` with `adapterType: "http"` -> `agentfield.async_rest`.

`apps/daemon/src/app.ts` is the single wiring point for adapters, initial availability, provider/runtime/model seeding, manifest seeding, doctor, REST, and artifact content readers. AgentField config belongs here through `loadDaemonConfig`, not in per-run metadata.

`packages/testkit/src/fake-http-runtime-server.ts` is the loopback fake-wrapper model. AgentField needs a separate fake server because endpoint paths, statuses, health/discovery semantics, auth, and result artifacts differ from Generic HTTP.

## Task Graph

### Task P5-T1-agentfield-r6-end-to-end

`id`: `P5-T1-agentfield-r6-end-to-end`
`title`: Implement AgentField async REST runtime end to end

`files`:
- Create: `packages/adapters/src/substrates/http-json-client.ts`
- Modify: `packages/adapters/src/generic-http/http-client.ts`
- Modify: `packages/adapters/src/generic-http/generic-http-adapter.ts`
- Create: `packages/adapters/src/agentfield/index.ts`
- Create: `packages/adapters/src/agentfield/types.ts`
- Create: `packages/adapters/src/agentfield/http-client.ts`
- Create: `packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts`
- Modify: `packages/adapters/src/index.ts`
- Create: `packages/adapters/test/agentfield-async-rest-adapter.test.ts`
- Modify: `packages/adapters/test/runtime-adapter-contracts.test.ts`
- Create: `packages/testkit/src/fake-agentfield-server.ts`
- Create: `packages/testkit/src/fake-agentfield-cli.ts`
- Modify: `packages/testkit/src/index.ts`
- Modify: `packages/testkit/package.json`
- Create: `packages/testkit/test/fake-agentfield-server.test.ts`
- Modify: `packages/core/src/services/registry-service.ts`
- Modify: `packages/core/test/registry-service.test.ts`
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`
- Modify: `apps/daemon/test/sse-leak.test.ts`
- Create: `docs/development/adapters/AGENTFIELD.md`
- Modify: `docs/development/adapters/README.md`
- Modify: `docs/adapters/README.md`
- Modify: `docs/development/API.md`
- Modify: `docs/development/DEVELOPMENT.md`
- Modify: `PRODUCT.md`
- Modify: `CHANGELOG.md`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-5-r6-wrapper-runtime-integration.md` - exact R6 AgentField contract, reason codes, fake scenarios, acceptance criteria, and non-goals.
- `PRODUCT.md` - current product truth showing R6 planned and current shipped modes before implementation closeout.
- `PROJECT.md` - prior phase summaries and branch history through R5.
- `packages/core/src/ports/runtime-adapter.ts` - adapter lifecycle interface AgentField must implement.
- `packages/core/src/services/runtime-runner-service.ts` - terminalization, timeout, session persistence, and artifact `metadata.content` handoff behavior.
- `packages/core/src/services/registry-service.ts` - existing runtime-mode inference and public slug validation.
- `packages/adapters/src/generic-http/generic-http-adapter.ts` - nearest shipped async REST wrapper adapter pattern.
- `packages/adapters/src/generic-http/http-client.ts` - bounded fetch, timeout, max-byte, and JSON parse behavior to reuse or extract.
- `packages/testkit/src/fake-http-runtime-server.ts` - fake wrapper server shape and package-script model for local CI.
- `apps/daemon/src/config.ts` - daemon-level environment parsing pattern.
- `apps/daemon/src/app.ts` - adapter registration, registry seeding, doctor wiring, and artifact content wiring.
- `packages/protocol-rest/src/run-routes.ts` - existing `AdapterProtocolError` to `409 adapter_protocol_failed` mapping for input/cancel.

`instructions`: Implement R6 as one sequential task. Start by writing failing focused tests for the fake AgentField server, AgentField adapter, runtime adapter contract, registry inference, daemon smoke, unsupported input, unsupported active cancel, timeout, artifact retrieval, and secret redaction. Then implement the smallest code changes that make those tests pass.

Extract a neutral bounded JSON HTTP helper into `packages/adapters/src/substrates/http-json-client.ts` before adding AgentField HTTP calls. It must use native `fetch`, `AbortController`, and a streaming byte limit. It must return status, ok flag, parsed body, raw text, byte count, and duration. It must accept provider-specific reason codes for request failure, invalid JSON, and oversized responses so Generic HTTP keeps existing `generic_http_*` reasons while AgentField uses `agentfield_*` reasons. Keep `packages/adapters/src/generic-http/http-client.ts` as a compatibility wrapper so existing Generic HTTP tests and imports remain stable.

Create `AgentFieldAsyncRestAdapter` under `packages/adapters/src/agentfield/`. Its manifest must match the spec exactly: adapter id `agentfield`, provider id `provider_agentfield`, runtime id `runtime_agentfield`, runtime mode id `runtime_mode_agentfield_async_rest`, slug `agentfield.async_rest`, adapter type `http`, kind `async_rest`, capabilities `run.start`, `run.timeout`, `event.normalized`, `event.streaming`, `artifact.transcript`, and `auth.api_key`. Do not add `run.cancel`, `run.input`, webhook, approval, tool, memory, hosted, or AgentField-specific capability strings.

AgentField config is daemon-level only. Add `agentfield` config to `DaemonConfig` with `baseUrl`, `apiKey`, `target`, `requestTimeoutMs`, `pollIntervalMs`, and `maxResponseBytes`. Parse `SWITCHYARD_AGENTFIELD_BASE_URL`, `SWITCHYARD_AGENTFIELD_API_KEY`, and `SWITCHYARD_AGENTFIELD_TARGET` with trim-to-absent semantics. Parse numeric defaults as `5000`, `1000`, and `1048576`. Do not read base URL, API key, target, timeout, poll interval, max response bytes, health path, status path, or arbitrary headers from run metadata.

Implement `check()` so initial missing/invalid config and active checks map to the spec's availability table. Health checks call only `GET /api/v1/health`. Optional discovery calls only `GET /api/v1/discovery/capabilities?format=compact` after health succeeds and target is configured. Doctor/check must never create an AgentField execution. Discovery must remain diagnostic only: target present returns available; target absent returns unavailable `agentfield_target_not_found`; discovery unavailable after healthy health returns partial `agentfield_discovery_unavailable` with `canRun: true`.

Implement `start()` so the adapter allocates a session and transcript before any AgentField request. Convert AgentField-specific validation and upstream start failures into a pending terminal failure stored in the session, then return a session so `events()` can yield a named `run.failed` and `artifacts()` can return the transcript. It is acceptable to throw only for impossible Switchyard contract violations such as missing `runId`, `task`, or `cwd` from the runner. Validate `metadata.agentfield.input` as a JSON object when present. Reject arrays, strings, numbers, booleans, and null with `agentfield_input_invalid`. Validate `metadata.agentfield.workflowId`, `sessionId`, and `actorId` as strings when present; reject non-strings with `agentfield_header_metadata_invalid`. Send only `Authorization: Bearer <apiKey>`, `Accept`, `Content-Type`, `X-Workflow-ID`, `X-Session-ID`, and `X-Actor-ID`. Use metadata string values when present, otherwise default to `switchyard:<runId>` for workflow/session and `switchyard` for actor.

Implement AgentField base URL resolution so a configured base URL may include a path prefix. Resolve `/api/v1/...` relative to that prefix instead of discarding it. Use Node `URL` for parsing and joining; add tests for a base URL like `http://127.0.0.1:5065/prefix`.

For start requests, post to `/api/v1/execute/async/{target}` using the configured daemon target as one encoded path segment. The request body is `{ "input": metadata.agentfield.input }` when the input object is present, including `{}`. Otherwise send `{ "input": { "task": <task>, "cwd": <cwd>, "switchyardRunId": <runId> } }`. Never send `webhook` and never forward arbitrary metadata as headers or fields. Require a non-empty string `execution_id`; store it as `RuntimeStartResult.externalSessionKey`; preserve optional `run_id`, `workflow_id`, `target`, and `status`.

Implement `events()` as a poll loop over `GET /api/v1/executions/{execution_id}`. Emit deduped `runtime.status` events for `queued`, `pending`, and `running` when status and bounded progress metadata change. Map `succeeded` to optional bounded `runtime.output` plus `run.completed`. Map `failed`, `cancelled`, `timeout`, unknown status, invalid status response, non-2xx status response, oversized status response, and result oversized to exactly one visible terminal `run.failed` with the named reason code. A terminal start response must be handled without requiring a second poll. A succeeded response without `result` or with `result: null` completes without a `runtime.output` and produces `response.text: null`.

Normalize result text deterministically. String result emits the string with `resultFormat: "text"`. Object, array, number, and boolean result emit stable compact JSON with `resultFormat: "json"`. If normalized result text exceeds `maxResponseBytes`, emit a `runtime.status` with `status: "agentfield_result_oversized"`, then fail with `agentfield_result_too_large`, and do not store full result content.

Implement an AgentField transcript recorder that writes newline-delimited JSON entries with `type: "agentfield.request"`, `type: "agentfield.status"`, and `type: "agentfield.result"` rather than the Generic HTTP `http.request` type. Record method, path, status, duration, byte count, max byte count, execution id, source status, target, result byte count, and reason code. Never include auth headers, API keys, arbitrary headers, full request body, full health body, full discovery catalog, or environment values. `artifacts()` must always return `runs/<runId>/agentfield-transcript.jsonl` for sessions created by `start()`, including completed, failed-after-start, upstream failed, upstream timeout, upstream cancelled, and Switchyard timeout-after-start runs.

Return a wrapper result payload artifact at `runs/<runId>/agentfield-result.json` whenever a terminal AgentField status body is valid JSON and within `maxResponseBytes`. Use type `raw_log`, metadata `payloadKind: "terminal_status_response"`, and stable pretty JSON with two-space indentation in `metadata.content`. Include runtime, runtime mode, configured target, execution id, AgentField run id, workflow id, and source status when present. Do not store request headers or API keys.

Implement unsupported behavior exactly. `send()` throws `AdapterProtocolError` reason `agentfield_input_unsupported`. `cancel()` returns without error after the adapter has already terminalized; otherwise it throws `AdapterProtocolError` reason `agentfield_cancel_unsupported`. Because the manifest does not include `run.cancel`, active public cancel returns `409 adapter_protocol_failed`, and `RuntimeRunnerService.timeoutRun()` still catches the adapter cancel error and marks the run `timeout`.

Add a deterministic fake AgentField server in testkit with endpoints `GET /api/v1/health`, `GET /api/v1/discovery/capabilities?format=compact`, `POST /api/v1/execute/async/:target`, and `GET /api/v1/executions/:executionId`. Add the private script `fake-agentfield`. Cover scenarios `happy`, `empty_result`, `string_result`, `upstream_failed`, `upstream_cancelled`, `upstream_timeout`, `pending_until_switchyard_timeout`, `start_http_500`, `invalid_start_json`, `invalid_status_json`, `unknown_status`, `health_http_500`, `health_degraded`, `invalid_health_json`, `target_not_found`, `discovery_unavailable`, `oversized_health_response`, `oversized_start_response`, `oversized_status_response`, `oversized_result`, and `auth_required`. The fake server must stay loopback-only in tests, in-memory, no subprocesses, no external network, no real AgentField, no LLMs, and no webhooks.

Wire daemon records for provider `provider_agentfield`, runtime `runtime_agentfield`, model `model_agentfield_default`, and runtime mode `runtime_mode_agentfield_async_rest`. Seed initial availability as unavailable for missing/invalid base URL, missing API key, or missing target, and unknown with message "Run POST /runtime-modes/agentfield.async_rest/check to verify AgentField availability." when all required config is present. Register the adapter under runtime key `agentfield` and seed its manifest through `RuntimeCapabilityService`.

Update docs only after fake/mocked checks pass. `PRODUCT.md` must mark R6 shipped and list `agentfield.async_rest` as usable only when configured. `CHANGELOG.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, `docs/development/adapters/README.md`, `docs/development/adapters/AGENTFIELD.md`, and `docs/adapters/README.md` must document fake smoke, optional real smoke with explicit model-spend warning, reason codes, unsupported input/cancel, artifact inspection, env vars, and non-goals. Do not claim hosted workers, OpenClaw, Paperclip, AgentField webhooks, upstream cancellation, AgentField memory/admin/permissions, SDK, CLI, dashboard, or TUI.

`acceptance`:
- `agentfield.async_rest` manifest parses through `runtimeModeSchema` with `adapterType: "http"` and `kind: "async_rest"`.
- AgentField provider/runtime/model/runtime-mode records are seeded on daemon startup with correct ids and initial availability.
- `RegistryService` infers `agentfield.async_rest` when runtime mode is omitted for `runtime: "agentfield"` plus `adapterType: "http"`.
- Public create rejects internal id `runtime_mode_agentfield_async_rest` and rejects explicit slug mismatches for runtime, provider, or adapter type.
- Daemon config supports all six `SWITCHYARD_AGENTFIELD_*` variables with trim-to-absent and documented defaults.
- `POST /runtime-modes/agentfield.async_rest/check` covers missing config, invalid config, missing auth, missing target, healthy, degraded, target not found, discovery unavailable, timeout, network failure, invalid JSON, and oversized states with sanitized named reason codes.
- Doctor/check never creates an AgentField execution and fake server tests assert execution count remains zero during check.
- AgentField adapter creates async executions with `POST /api/v1/execute/async/{target}` and polls `GET /api/v1/executions/{execution_id}`.
- Queued, pending, and running statuses become bounded deduped `runtime.status` events.
- Succeeded result maps to bounded `runtime.output` plus `run.completed`; missing and null result still complete with no output.
- Failed, upstream cancelled, upstream timeout, unknown status, malformed status, and oversized status map to named visible `run.failed` events.
- AgentField emits at most one terminal event per run in adapter and daemon tests.
- `POST /runs/:id/input` returns `409 adapter_protocol_failed` with reason `agentfield_input_unsupported`.
- Active `POST /runs/:id/cancel` returns `409 adapter_protocol_failed` with reason `agentfield_cancel_unsupported` and does not mark the run cancelled.
- Switchyard timeout marks AgentField runs `timeout` even though adapter cancel throws `agentfield_cancel_unsupported`.
- AgentField transcript artifact is stored and retrievable for completed, failed-after-start, upstream failed, upstream timeout, upstream cancelled, and Switchyard timeout-after-start runs.
- AgentField terminal payload artifact is stored and retrievable when the terminal status body is valid JSON and within byte bounds.
- `GET /runs/:id/artifacts`, `GET /artifacts/:id`, and `GET /artifacts/:id/content` expose AgentField transcript and result payload content.
- AgentField API key and bearer auth are absent from check output, events, logs captured by tests, transcript content, artifact metadata, artifact content, and snapshots.
- Fake AgentField server covers all required R6 scenarios without external network calls, subprocesses, real AgentField, webhooks, or model spend.
- Runtime adapter contract harness passes for fake runtime, Codex fake process, Generic HTTP fake server, OpenCode fake ACP process, and AgentField fake server.
- Existing fake, Codex, Generic HTTP, OpenCode, REST, SSE, storage, and daemon tests continue to pass.
- Docs update product truth and local verification only after mocked/fake AgentField flow passes focused checks.

`checks`:
- `git diff --check`
- `pnpm --filter @switchyard/testkit test -- fake-agentfield`
- `pnpm --filter @switchyard/testkit typecheck`
- `pnpm --filter @switchyard/adapters test -- agentfield`
- `pnpm --filter @switchyard/adapters test -- runtime-adapter-contracts`
- `pnpm --filter @switchyard/adapters typecheck`
- `pnpm --filter @switchyard/core test -- registry-service`
- `pnpm --filter @switchyard/core typecheck`
- `pnpm --filter @switchyard/protocol-rest test`
- `pnpm --filter @switchyard/daemon test`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm lint`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `loadDaemonConfig` | Env var exists but trims to empty | Empty string | Treat as absent and seed unavailable reason for the missing value | Runtime mode exists but doctor says unavailable with a named reason |
| `parseAgentFieldBaseUrl` | Base URL missing, malformed, or non-http protocol | URL parse error or explicit protocol check | Do not issue HTTP request; return unavailable `agentfield_config_missing` or `agentfield_config_invalid` | Check response names the config issue |
| `AgentFieldAsyncRestAdapter.check` | API key missing | Explicit config check | Do not call health; return unavailable `agentfield_auth_missing` | Doctor says auth is missing |
| `AgentFieldAsyncRestAdapter.check` | Target missing | Explicit config check | Do not call health; return unavailable `agentfield_target_missing` | Doctor says target is missing |
| `GET /api/v1/health` | Network, DNS, TLS, or connection refused | `HttpRequestError` reason `agentfield_request_failed` | Return unknown/unavailable with sanitized bounded message | Doctor/check remains 200 with safe reason |
| `GET /api/v1/health` | Request timeout | Abort-driven request error | Return unknown `check_timeout` | Doctor/check remains bounded and safe |
| `GET /api/v1/health` | Non-2xx or unhealthy JSON | HTTP status or body status check | Return unavailable `agentfield_health_unavailable` | Doctor names upstream health failure |
| `GET /api/v1/health` | Invalid JSON, empty body, or unrecognized shape | `HttpInvalidJsonError` or shape check | Return unknown `agentfield_health_invalid` | Doctor names invalid health body without body dump |
| `GET /api/v1/health` | Response exceeds max bytes | `HttpResponseTooLargeError` | Return unknown `check_output_too_large`; transcript/log record byte count only | Doctor names oversized check output |
| `GET /api/v1/health` | Health reports degraded | Body `status: "degraded"` | Return partial `agentfield_health_degraded`, `canRun: true` | Doctor shows partial but runnable |
| `GET /api/v1/discovery/capabilities` | Discovery absent, 404, non-2xx, invalid JSON, or timeout after healthy health | HTTP/request/parser error | Return partial `agentfield_discovery_unavailable`, `canRun: true` | Doctor warns discovery unavailable without blocking runs |
| `GET /api/v1/discovery/capabilities` | Discovery succeeds and target is absent | Target scan miss | Return unavailable `agentfield_target_not_found` | Doctor says configured target is not found |
| `start` metadata validation | `metadata.agentfield.input` is not an object | Explicit shape check | Store pending failure `agentfield_input_invalid`; do not call AgentField | Run fails visibly and transcript has validation reason |
| `start` header metadata validation | workflow/session/actor metadata is not a string | Explicit shape check | Store pending failure `agentfield_header_metadata_invalid`; do not call AgentField | Run fails visibly with named reason |
| `POST /api/v1/execute/async/{target}` | Start returns non-2xx | HTTP status check | Store pending failure `agentfield_start_failed`; transcript records request summary | Run fails instead of hanging |
| `POST /api/v1/execute/async/{target}` | Start body invalid, empty, or missing execution id | Parser or shape check | Store pending failure `agentfield_invalid_start_response` | Run fails with named parser reason |
| `POST /api/v1/execute/async/{target}` | Start response exceeds max bytes | `HttpResponseTooLargeError` | Store pending failure `agentfield_start_response_too_large`; no body dump | Run fails with oversized reason |
| `GET /api/v1/executions/{execution_id}` | Status response invalid, empty, missing status, or malformed JSON | Parser or shape check | Yield one `run.failed` with `agentfield_invalid_status_response` | Run fails visibly |
| `GET /api/v1/executions/{execution_id}` | Status response exceeds max bytes | `HttpResponseTooLargeError` | Yield one `run.failed` with `agentfield_status_response_too_large` | Run fails with oversized reason |
| `GET /api/v1/executions/{execution_id}` | Upstream status is `failed` | Terminal status mapping | Yield `run.failed` `agentfield_status_failed` with sanitized upstream code/message | User sees upstream failure summary |
| `GET /api/v1/executions/{execution_id}` | Upstream status is `cancelled` | Terminal status mapping | Yield `run.failed` `agentfield_upstream_cancelled` | User sees upstream cancellation without false Switchyard cancellation |
| `GET /api/v1/executions/{execution_id}` | Upstream status is `timeout` | Terminal status mapping | Yield `run.failed` `agentfield_upstream_timeout` | User sees upstream timeout |
| `GET /api/v1/executions/{execution_id}` | Unknown status string | Terminal status mapping | Yield `run.failed` `agentfield_unknown_status` | User sees unknown upstream status failure |
| `normalizeResult` | Result text exceeds max bytes | Explicit byte check | Emit status `agentfield_result_oversized`, fail `agentfield_result_too_large`, do not store full result | User sees named result-size failure |
| `events` poll loop | Non-terminal status repeats forever | Runner deadline | Let `RuntimeRunnerService` timeout call adapter cancel best-effort and mark run `timeout` | User sees Switchyard timeout |
| `send` | Public post-start input is used | `AdapterProtocolError` | Throw reason `agentfield_input_unsupported` | REST returns 409 with reason code |
| `cancel` | Active public cancel is used | `AdapterProtocolError` | Throw reason `agentfield_cancel_unsupported`; do not mutate adapter terminal state | REST returns 409 and run remains non-cancelled |
| `artifacts` transcript | Transcript could contain API key or auth header | Sanitization miss | Redact bearer/API key strings before appending any line; tests assert absence | Artifact is useful without leaking secrets |
| `artifacts` result payload | Terminal payload cannot be serialized or is oversized | JSON stringify or byte check | Omit full result artifact when unsafe; keep transcript with reason | User sees failure/status and no secret/body leak |

`observability`:
- `logs`: `agentfield.check`, `agentfield.request`, `agentfield.start`, `agentfield.status`, `agentfield.result`, `agentfield.failure`, `runtime_mode.seeded`, and existing `runtime_mode.check`, `run.started`, `runtime.output`, `run.failed`, `run.timeout`, and artifact logs. Allowed fields are run id, runtime mode, target, execution id, AgentField run id, source status, HTTP method, URL pathname, status code, duration, byte count, and reason code.
- `success_metric`: Fake AgentField happy run reaches `run.completed`, stores transcript and result artifacts with `contentStored: true`, and `agentfield.async_rest` check is available without creating executions.
- `failure_metric`: Any leaked fake API key, duplicate terminal event, unbounded response, missing transcript after start, false cancelled run, or doctor execution creation fails focused tests.

`test_cases`:
- `{ name: "manifest parses", lens: "happy", given: "AgentFieldAsyncRestAdapter.manifest", expect: "runtimeModeSchema.parse succeeds with slug agentfield.async_rest" }`
- `{ name: "config missing states", lens: "happy_shadow_nil", given: "adapter check without baseUrl, apiKey, or target", expect: "agentfield_config_missing, agentfield_auth_missing, and agentfield_target_missing covered without HTTP calls" }`
- `{ name: "empty env becomes missing", lens: "happy_shadow_empty", given: "env vars containing whitespace", expect: "config omits values and initial availability uses missing reason codes" }`
- `{ name: "invalid base url", lens: "error_path", given: "SWITCHYARD_AGENTFIELD_BASE_URL=ftp://x", expect: "agentfield_config_invalid and no request attempted" }`
- `{ name: "health healthy and discovery target present", lens: "happy", given: "fake happy server and configured target", expect: "check state available, canRun true, diagnostics include health and discovery ok" }`
- `{ name: "health degraded", lens: "edge_health", given: "fake health_degraded", expect: "partial canRun true reason agentfield_health_degraded" }`
- `{ name: "health non 2xx", lens: "error_path", given: "fake health_http_500", expect: "unavailable agentfield_health_unavailable" }`
- `{ name: "health invalid json", lens: "error_path", given: "fake invalid_health_json", expect: "unknown agentfield_health_invalid" }`
- `{ name: "health oversized", lens: "error_path", given: "fake oversized_health_response and small max bytes", expect: "unknown check_output_too_large" }`
- `{ name: "discovery unavailable stays partial", lens: "edge_discovery", given: "fake discovery_unavailable", expect: "partial canRun true reason agentfield_discovery_unavailable" }`
- `{ name: "target not found", lens: "error_path", given: "fake target_not_found", expect: "unavailable canRun false reason agentfield_target_not_found" }`
- `{ name: "doctor does not create execution", lens: "integration", given: "POST /runtime-modes/agentfield.async_rest/check", expect: "fake server execution count remains zero" }`
- `{ name: "registry inference", lens: "happy", given: "runtime agentfield provider agentfield adapterType http without runtimeMode", expect: "agentfield.async_rest" }`
- `{ name: "internal runtime mode id rejected", lens: "error_path", given: "runtimeMode runtime_mode_agentfield_async_rest", expect: "400 invalid_input details path runtimeMode" }`
- `{ name: "runtime mode mismatch rejected", lens: "error_path", given: "runtime codex with runtimeMode agentfield.async_rest", expect: "400 invalid_input mismatch" }`
- `{ name: "default input body", lens: "happy_shadow_empty", given: "run metadata absent", expect: "fake server receives input.task, input.cwd, and input.switchyardRunId" }`
- `{ name: "custom input object", lens: "happy", given: "metadata.agentfield.input object", expect: "request body is exactly { input: object }" }`
- `{ name: "invalid input metadata", lens: "error_path", given: "metadata.agentfield.input is array, string, number, boolean, or null", expect: "run.failed agentfield_input_invalid and no upstream execution" }`
- `{ name: "invalid header metadata", lens: "error_path", given: "workflowId/sessionId/actorId non-string", expect: "run.failed agentfield_header_metadata_invalid and no upstream execution" }`
- `{ name: "base url path prefix", lens: "edge_url", given: "baseUrl http://host/prefix and fake server mounted with prefix", expect: "requests hit /prefix/api/v1 paths" }`
- `{ name: "happy run completes", lens: "integration", given: "daemon wait=1 against fake happy server", expect: "run completed, response.text compact JSON, runtime.status/output/completed events" }`
- `{ name: "terminal start response", lens: "edge_start_terminal", given: "fake start returns status succeeded with result", expect: "run completes without second poll" }`
- `{ name: "empty result", lens: "happy_shadow_empty", given: "fake empty_result", expect: "run completed and response.text null" }`
- `{ name: "string result", lens: "happy", given: "fake string_result", expect: "runtime.output text equals source string resultFormat text" }`
- `{ name: "upstream failed", lens: "error_path", given: "fake upstream_failed", expect: "run.failed agentfield_status_failed with sanitized upstream error" }`
- `{ name: "upstream cancelled", lens: "error_path", given: "fake upstream_cancelled", expect: "run.failed agentfield_upstream_cancelled, not run.cancelled" }`
- `{ name: "upstream timeout", lens: "error_path", given: "fake upstream_timeout", expect: "run.failed agentfield_upstream_timeout" }`
- `{ name: "invalid start response", lens: "error_path", given: "fake invalid_start_json", expect: "run.failed agentfield_invalid_start_response and transcript artifact" }`
- `{ name: "start http 500", lens: "error_path", given: "fake start_http_500", expect: "run.failed agentfield_start_failed and transcript artifact" }`
- `{ name: "start oversized", lens: "error_path", given: "fake oversized_start_response", expect: "run.failed agentfield_start_response_too_large" }`
- `{ name: "invalid status response", lens: "error_path", given: "fake invalid_status_json", expect: "run.failed agentfield_invalid_status_response and no hang" }`
- `{ name: "status oversized", lens: "error_path", given: "fake oversized_status_response", expect: "run.failed agentfield_status_response_too_large" }`
- `{ name: "unknown status", lens: "error_path", given: "fake unknown_status", expect: "run.failed agentfield_unknown_status" }`
- `{ name: "oversized result", lens: "error_path", given: "fake oversized_result", expect: "runtime.status agentfield_result_oversized then run.failed agentfield_result_too_large" }`
- `{ name: "dedupe running statuses", lens: "edge_dedupe", given: "fake repeats same running response before success", expect: "one runtime.status for unchanged status metadata" }`
- `{ name: "switchyard timeout", lens: "error_path", given: "fake pending_until_switchyard_timeout and timeoutSeconds 1", expect: "run status timeout, run.failed runtime_timeout, transcript artifact retrievable" }`
- `{ name: "unsupported input", lens: "error_path", given: "POST /runs/:id/input for AgentField", expect: "409 adapter_protocol_failed reason agentfield_input_unsupported" }`
- `{ name: "unsupported active cancel", lens: "error_path", given: "POST /runs/:id/cancel while running", expect: "409 adapter_protocol_failed reason agentfield_cancel_unsupported and run not cancelled" }`
- `{ name: "cancel after terminal idempotent", lens: "happy", given: "POST /runs/:id/cancel after AgentField run completed", expect: "200 current terminal run and adapter cancel not called" }`
- `{ name: "transcript artifact content", lens: "integration", given: "completed and failed-after-start AgentField runs", expect: "agentfield-transcript.jsonl retrievable via artifact content API" }`
- `{ name: "result artifact content", lens: "integration", given: "terminal valid status body", expect: "agentfield-result.json raw_log retrievable with pretty JSON content" }`
- `{ name: "secret redaction", lens: "edge_security", given: "fake token secret-agentfield-key in config and upstream errors", expect: "token absent from check JSON, events, logs captured by tests, transcript content, artifact metadata, and result content" }`
- `{ name: "fake server auth required", lens: "error_path", given: "fake auth_required with missing or wrong bearer token", expect: "401 maps to sanitized agentfield_health_unavailable or agentfield_start_failed" }`
- `{ name: "runtime adapter contract includes AgentField", lens: "integration", given: "runRuntimeAdapterContract with fake AgentField happy server", expect: "exactly one terminal event, send throws AdapterProtocolError, terminal cancel no-ops, artifacts safe" }`
- `{ name: "docs reflect shipped scope", lens: "integration", given: "updated docs", expect: "AgentField fake smoke exists, optional real smoke has spend warning, non-goals remain explicit" }`

`integration_contracts`:
- `exports`:
  - `{ name: "AGENTFIELD_RUNTIME_MODE_SLUG", kind: "constant", signature: "\"agentfield.async_rest\"" }`
  - `{ name: "AgentFieldAsyncRestAdapter", kind: "class", signature: "new AgentFieldAsyncRestAdapter(options?: AgentFieldAsyncRestAdapterOptions) implements RuntimeAdapter" }`
  - `{ name: "AgentFieldAsyncRestAdapterOptions", kind: "type", signature: "{ baseUrl?: string; apiKey?: string; target?: string; requestTimeoutMs?: number; pollIntervalMs?: number; maxResponseBytes?: number; logger?: RuntimeLogger; fetch?: typeof fetch }" }`
  - `{ name: "requestJson", kind: "function", signature: "(input: HttpJsonRequestInput) => Promise<{ status: number; ok: boolean; body: unknown; text: string; bytes: number; durationMs: number }>" }`
  - `{ name: "startFakeAgentFieldServer", kind: "function", signature: "(options?: FakeAgentFieldServerOptions) => Promise<FakeAgentFieldServerHandle>" }`
  - `{ name: "FakeAgentFieldScenario", kind: "type", signature: "union of required R6 fake AgentField scenario strings" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/adapters/src/agentfield/index.ts`
  - `packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts`
  - `packages/testkit/src/fake-agentfield-server.ts`
  - `apps/daemon/src/config.ts`
  - `apps/daemon/src/app.ts`

## Risks

- **Single-task breadth:** The native run explicitly requests one implementer-sized task, but the release touches adapter, testkit, core, daemon, and docs. Mitigation is one file owner and a sequential TDD checklist rather than parallel worktrees.
- **Start-failure artifact gap:** `RuntimeRunnerService` only persists artifacts after `adapter.start()` returns a session. The plan requires AgentField-specific validation and upstream start failures to be represented as pending session failures emitted by `events()` so transcript artifacts can still be collected.
- **Secret leakage:** AgentField uses bearer auth. Redaction tests must inspect check payloads, persisted events, captured logs, transcript artifact content, result artifact content, and artifact metadata.
- **Base URL prefix handling:** Native `new URL("/api/...", base)` would drop path prefixes. The AgentField HTTP client must join base path prefixes deliberately while still using `URL` parsing.
- **No upstream cancellation:** Active public cancel returns `409`; Switchyard timeout still marks local timeout. Docs must explain that upstream work may continue until AgentField or the configured target stops it.

## Integration Points

- `AgentFieldAsyncRestAdapter` is exported from `@switchyard/adapters` and registered in daemon `adapters` under key `agentfield`.
- `RegistryService.inferAndValidateRuntimeMode` returns `agentfield.async_rest` for omitted runtime mode only when `runtime === "agentfield"` and `adapterType === "http"`.
- `RuntimeCapabilityService.seedManifests` receives the AgentField manifest and initial availability under `agentfield.async_rest`.
- `RuntimeDoctorService` already accepts custom adapter-provided availability; AgentField `check()` must return `details.availability` and sanitized `details.diagnostics`.
- `RuntimeRunnerService` consumes AgentField events and artifacts without provider-specific changes beyond the existing timeout/cancel/artifact behavior.
- REST input and cancel routes already map `AdapterProtocolError` to `409 adapter_protocol_failed`; AgentField only needs correct reason codes.
- Artifact content APIs require no new route because the adapter returns `metadata.content` and safe relative paths.

## Acceptance Criteria

- [ ] `agentfield.async_rest` manifest parses through existing contracts with `adapterType: "http"` and `kind: "async_rest"`.
- [ ] AgentField provider/runtime/model/runtime-mode records are seeded on daemon startup.
- [ ] `RegistryService` infers `agentfield.async_rest` for omitted runtime mode and rejects internal id `runtime_mode_agentfield_async_rest` in public create bodies.
- [ ] Daemon config supports all six `SWITCHYARD_AGENTFIELD_*` variables.
- [ ] `POST /runtime-modes/agentfield.async_rest/check` reports all specified config, health, discovery, timeout, and oversized states with sanitized reason codes.
- [ ] Doctor/check never creates an AgentField execution and never spends model budget.
- [ ] AgentField adapter creates async executions and polls execution status through the documented `/api/v1` paths.
- [ ] AgentField status, output, completion, failure, upstream cancelled, upstream timeout, unknown status, result oversized, unsupported input, unsupported cancel, Switchyard timeout, transcript artifact, result artifact, and secret-redaction paths are covered by focused and daemon tests.
- [ ] Fake AgentField server covers all required scenarios without external network calls or model spend.
- [ ] Runtime adapter contract harness includes AgentField along with fake, Codex, Generic HTTP, and OpenCode.
- [ ] Existing shipped runtime behavior and tests continue to pass.
- [ ] Product/API/development docs are updated after fake verification passes and do not overclaim out-of-scope AgentField surfaces.

## Self-Review Checklist

1. Spec coverage: Pass. Each R6 acceptance criterion maps to the single task acceptance, checks, and test cases.
2. Placeholder scan: Pass. No placeholder text is intentionally present.
3. Type consistency: Pass. Adapter, fake server, HTTP helper, registry, and daemon contracts are named with explicit signatures.
4. Ownership disjoint: Pass. There is one task, so there is no overlapping task ownership.
5. Context files real: Pass. All listed context files exist in this worktree.
6. Acceptance testable: Pass. Each acceptance item names observable API responses, artifacts, events, or test commands.
7. Dependency order sane: Pass. The single task has no dependencies.
8. Checks runnable: Pass. Commands use existing pnpm package filters and scripts, with `fake-agentfield` added by the task.
9. Error/rescue map present: Pass. Runtime behavior has named codepaths, exceptions, rescues, and user-visible results.
10. Observability present: Pass. Logs, success metric, and failure metric are specified.
11. Test cases enumerate acceptance: Pass. Happy, nil, empty, error, edge, and integration lenses cover acceptance and rescue paths.
12. Integration contracts walk: Pass. There are no cross-task imports; exported contracts are consumed inside this same task and by daemon/tests.
13. Contract types match: Pass. Manifest ids, runtime-mode slug, adapter constructor, HTTP helper, and fake server signatures are consistent.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error_rescue_map entry has a matching `error_path`, `happy_shadow_*`, or edge test case.
- [x] Every `integration_contracts.imports_from_other_tasks` resolves to a real export elsewhere because the list is empty for the one-task native run.
- [x] Every `context_files` path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is intentionally present.
- [x] Complexity is L and the one-task shape is intentional because this native run requested one implementer-sized task covering R6 end-to-end.
