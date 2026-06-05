# Phase 13: R14 Hosted Sandbox Substrate For Process/PTY - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-13-r14-hosted-sandbox-substrate.md`
**Branch:** `agent/phase-13-r14-hosted-sandbox-substrate`
**Complexity:** L

## Goal

Ship a fake/no-spend hosted sandbox substrate for future process-like and PTY-like jobs, with typed contracts, deny-by-default policy, deterministic fake execution scenarios, resource limits, redaction, readiness/metrics hooks, smoke coverage, and product truth that keeps real hosted execution unshipped.

## Scope Challenge

1. **Existing code already solves part of this:** `packages/contracts/src/run.ts` already names `process`, `pty`, and hosted placement vocabulary. `packages/core/src/services/hosted-worker-service.ts` already rejects hosted durable rows unless they are `fake.deterministic`. `apps/worker/src/worker.ts` already registers only `FakeRuntimeAdapter`. `packages/core/src/services/local-policy-gate.ts` already has recursive key-based redaction, and `RuntimeRunnerService` already knows how to persist transcript artifact content through `ArtifactContentStore`. R14 must extend these seams instead of adding a public execution route or reusing the local adapter process runner.
2. **Minimum changes:** add sandbox schemas in contracts, one core hosted sandbox service boundary with policy/config/redaction helpers, one deterministic fake executor in testkit, server/worker config and readiness wiring, server low-cardinality metrics shape, a no-spend smoke script, static forbidden-import tests, and docs. Defer real subprocess/PTY execution, kernel/container sandboxing, public sandbox APIs, hosted Codex/Claude/OpenCode, real tools, managed hosting, dashboard, TUI, and enterprise controls.
3. **Complexity check:** this phase touches more than 8 files because the same contract spans schemas, core policy/service behavior, fake executor tests, hosted app readiness/metrics, smoke, and docs. Splitting into parallel worktrees would create dependent edits to the same contracts and app boundaries. Per the user request, the plan uses one coherent implementer/reviewer task with mandatory internal checkpoints.
4. **Built-in check:** use Zod for serializable contract validation, Node `path` utilities for absolute/normalized `cwd`, `Buffer.byteLength` for byte limits, `crypto.createHash("sha256")` for artifact digests through the existing artifact-content stores, `AbortController` for cancellation signals, and the existing `ArtifactContentStore`, `ArtifactStore`, `RuntimeLogger`, server `HostedMetrics`, and readiness patterns. Do not add shell parsers, command interpolation, process tree code, `child_process`, `node-pty`, browser automation, fetch clients, or container runtime abstractions.
5. **Distribution check:** no new package, binary, public API, container, or deploy artifact ships. Add only a root no-spend smoke script, for example `pnpm sandbox:smoke`, implemented with in-process fake executor/testkit dependencies. No required check uses Docker, AWS, R2, model providers, browser binaries, GitHub tokens, shell commands, or real subprocess execution.

## Architecture

R14 adds an internal hosted sandbox substrate, not a hosted runtime. Contracts live in `@switchyard/contracts` so future hosted adapters get a stable request/result vocabulary. Core owns validation, defaulting, policy, redaction, lifecycle normalization, metrics/log hooks, and artifact capture. Testkit owns the deterministic fake executor used by app wiring, unit tests, and the smoke command. The hosted worker constructs the substrate and checks its configuration, but the actual hosted run path remains the existing `FakeRuntimeAdapter` only.

```text
Trusted internal caller
  |
  v
SandboxJobRequest schema and resource-limit defaults
  |
  v
HostedSandboxPolicy deny-by-default command/capability decision
  |                 |
  | deny            | allow fake command id only
  v                 v
SandboxJobResult    FakeHostedSandboxExecutor
failed/no execute      |
                       v
             stdout/stderr/PTY/lifecycle/fake artifacts
                       |
                       v
        HostedSandboxService redaction + limit enforcement
                       |
                       v
        optional transcript artifact content + safe metadata
                       |
                       v
        logs, metrics counters, readiness, smoke assertions
```

The policy accepts only symbolic fake command ids: `switchyard.fake.echo`, `switchyard.fake.stderr`, `switchyard.fake.exit`, `switchyard.fake.sleep`, `switchyard.fake.artifact`, `switchyard.fake.output_flood`, and `switchyard.fake.pty_echo`. Explicit real-command, tool, and runtime ids such as shell names, language runtimes, `codex`, `claude`, `opencode`, `git`, `gh`, `curl`, `browser`, `web_search`, `fetch`, `repo`, `github`, and `shell` are denied before executor dispatch with `sandbox_command_denied`.

The fake executor is deterministic and scenario-driven. It returns lifecycle frames, output frames, exit status, fake PTY frames, and fake artifacts from typed request data and fixture strings. It never calls OS commands, inherits no `process.env`, and uses explicit request env only as bounded metadata. Cancellation and timeout are modeled through abort signals and active job tracking in `HostedSandboxService`, so cancellation before start, during execution, and after terminal are testable without sleeping.

Readiness checks validate sandbox config and policy allowlist only. They do not execute jobs. Metrics are counters only: no labels, command args, cwd, env keys/values, bucket names, endpoints, run ids, prompts, output text, or artifact content. Docs must describe the result as a fake/no-spend safety substrate and keep production sandboxing and real hosted execution explicitly unshipped.

CPU and memory are validation-only declarations in R14. The service must validate that `cpuMs` and `memoryMiB` are positive and within configured/spec maximums, then carry them as metadata for future real isolation work. The fake executor must not claim CPU or memory enforcement, must not simulate `sandbox_cpu_limit_exceeded` or `sandbox_memory_limit_exceeded`, and tests must assert only bounds validation for those two fields.

R14 must not add a public sandbox execution surface. There is no `/sandbox`, `/exec`, `/pty`, `/terminal`, or equivalent route, and no public OpenAPI route is added for sandbox jobs. Existing public readiness and metrics responses may include sandbox fields through server tests/docs; if the local daemon OpenAPI is generated or checked, it must remain deterministic and must not include a sandbox execution operation.

## File Structure

- `packages/contracts/src/sandbox.ts` - new Zod schemas, typed constants, lifecycle state enum, fake command allowlist, resource-limit contract, result contract, captured artifact contract, policy decision contract, and closed named-error enum.
- `packages/contracts/src/index.ts` - export the sandbox contract module.
- `packages/contracts/test/sandbox.contract.test.ts` - contract validation tests for request/resource/result/lifecycle/named-error schemas and command ids.
- `packages/core/src/services/hosted-sandbox-service.ts` - new core service, executor port, policy implementation, config resolver, readiness helper, limit defaulting/validation, lifecycle monotonicity, artifact capture, metrics/log hooks, and sandbox-specific redaction.
- `packages/core/src/services/local-policy-gate.ts` - extend the shared secret-key pattern to include sandbox-required key names while preserving `runtimeApprovalToken` behavior.
- `packages/core/src/index.ts` - export the hosted sandbox service and helper types.
- `packages/core/test/hosted-sandbox-service.test.ts` - unit tests for policy, validation, resource limits, lifecycle monotonicity, redaction, artifact capture, cancellation, timeout, and static forbidden imports in core/testkit sandbox files.
- `packages/testkit/src/fake-hosted-sandbox-executor.ts` - deterministic fake executor implementing the core executor port for process-like and PTY-like scenarios.
- `packages/testkit/src/index.ts` - export the fake hosted sandbox executor.
- `packages/testkit/test/fake-hosted-sandbox-executor.test.ts` - focused fake executor scenario tests.
- `apps/server/src/config.ts` - parse sandbox env config and include a redacted summary.
- `apps/server/src/readiness.ts` - add `checks.sandbox` based on sandbox config/policy validation without running commands.
- `apps/server/src/metrics.ts` - add low-cardinality sandbox counters.
- `apps/server/src/app.ts` - construct the fake sandbox substrate for future hosted adapters, pass sandbox readiness dependencies, and keep no public sandbox route.
- `apps/server/test/hosted-server.test.ts` - readiness, metrics, config, hosted denial, no public sandbox API, and redaction tests.
- `apps/worker/src/config.ts` - parse sandbox env config and include a redacted summary.
- `apps/worker/src/worker.ts` - construct the fake sandbox substrate as an internal dependency while keeping runtime adapters map to `FakeRuntimeAdapter` only.
- `apps/worker/test/hosted-worker.test.ts` - worker readiness, hosted fake compatibility, denial before execution, and forbidden-import tests.
- `scripts/hosted-sandbox-smoke.ts` - no-spend end-to-end smoke for allowed fake job, denied real command, timeout, cancellation idempotency, artifact capture/redaction, metrics, and readiness.
- `package.json` - add `sandbox:smoke` script that runs the smoke through `tsx`.
- `PRODUCT.md` - mark fake/no-spend hosted sandbox substrate as shipped and keep real hosted execution not shipped.
- `ARCHITECTURE.md` - document the hosted sandbox substrate as a safety layer, fake-only in R14, with no kernel/container sandbox.
- `docs/development/DEVELOPMENT.md` - add no-spend sandbox smoke command, readiness field, and metrics field.
- `docs/development/API.md` - update hosted readiness/metrics shape only; do not document a public sandbox execution API.
- `CHANGELOG.md` - add R14 release entry and safety boundaries.

`PROJECT.md` is not implementer-owned. CEO phase-close appends the Phase 13 block after audit.

## Existing Context

`packages/contracts/src/run.ts` already has the placement and adapter vocabulary this substrate prepares for:

```ts
export const adapterTypeSchema = z.enum(["native", "acpx", "http", "webhook", "process", "pty", "browser"]);
export const executionPlacementSchema = z.enum(["local", "hosted", "connected_local_node"]);
```

`packages/core/src/services/hosted-worker-service.ts` is the durable hosted execution guard that must remain true:

```ts
if (run.runtime !== "fake") {
  return "hosted_runtime_not_allowed";
}
if (run.runtimeMode !== "fake.deterministic") {
  return "hosted_runtime_not_allowed";
}
if (run.adapterType !== "process") {
  return "hosted_runtime_not_allowed";
}
```

`apps/worker/src/worker.ts` currently registers only the fake runtime adapter:

```ts
const adapters = new Map<string, RuntimeAdapter>([["fake", new FakeRuntimeAdapter()]]);
```

`packages/adapters/src/substrates/process-runner.ts` is local-adapter-owned and must not be used by hosted sandbox execution in R14:

```ts
const process = input.processFactory(input.args, { cwd: input.cwd, env: input.env });
process.kill("SIGTERM");
```

`apps/server/src/readiness.ts` already returns a checks map and named dependency codes:

```ts
export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, { ok: boolean; code?: string; diagnostics?: Record<string, unknown> }>;
}
```

`apps/server/src/metrics.ts` already uses low-cardinality nested counters:

```ts
objectStore: { reads: 0, writes: 0, failures: 0, probeFailures: 0, authFailures: 0, unavailable: 0, digestMismatches: 0 }
```

`packages/core/src/services/local-policy-gate.ts` already has recursive key redaction but the pattern is narrower than the R14 sandbox spec:

```ts
const SECRET_KEY_PATTERN = /(token|apikey|authorization|password|secret)/i;
```

## Task Graph

### Task P13-T1-hosted-sandbox-substrate: Add Fake Hosted Sandbox Substrate End To End

**Files (owned):**

- Create `packages/contracts/src/sandbox.ts`
- Modify `packages/contracts/src/index.ts`
- Create `packages/contracts/test/sandbox.contract.test.ts`
- Create `packages/core/src/services/hosted-sandbox-service.ts`
- Modify `packages/core/src/services/local-policy-gate.ts`
- Modify `packages/core/src/index.ts`
- Create `packages/core/test/hosted-sandbox-service.test.ts`
- Create `packages/testkit/src/fake-hosted-sandbox-executor.ts`
- Modify `packages/testkit/src/index.ts`
- Create `packages/testkit/test/fake-hosted-sandbox-executor.test.ts`
- Modify `apps/server/src/config.ts`
- Modify `apps/server/src/readiness.ts`
- Modify `apps/server/src/metrics.ts`
- Modify `apps/server/src/app.ts`
- Modify `apps/server/test/hosted-server.test.ts`
- Modify `apps/worker/src/config.ts`
- Modify `apps/worker/src/worker.ts`
- Modify `apps/worker/test/hosted-worker.test.ts`
- Create `scripts/hosted-sandbox-smoke.ts`
- Modify `package.json`
- Modify `PRODUCT.md`
- Modify `ARCHITECTURE.md`
- Modify `docs/development/DEVELOPMENT.md`
- Modify `docs/development/API.md`
- Modify `CHANGELOG.md`

**Dependencies:** none

**Context files (MUST read before coding):**

- `docs/superpowers/specs/2026-05-30-phase-13-r14-hosted-sandbox-substrate.md` - phase goals, non-goals, required fake command ids, resource limits, named errors, readiness/metrics, and acceptance.
- `packages/contracts/src/run.ts` - existing adapter type, run status, and hosted placement schemas to reference instead of redefining.
- `packages/core/src/services/hosted-worker-service.ts` - durable hosted worker allowlist that must remain `fake.deterministic` only.
- `apps/worker/src/worker.ts` - hosted worker construction path that must keep registering only `FakeRuntimeAdapter`.
- `apps/server/src/readiness.ts` - existing readiness shape to extend with `checks.sandbox`.
- `apps/server/src/metrics.ts` - existing nested metrics counter shape to extend with a sandbox group.
- `packages/core/src/services/local-policy-gate.ts` - existing redaction helper and special `runtimeApprovalToken` exception to preserve.
- `PRODUCT.md` - owner-facing shipped/not-shipped truth; preserve fake-only hosted boundary and avoid production sandbox overclaim.
- `ARCHITECTURE.md` - architecture safety posture for hosted subprocess/PTY work; add the fake substrate without claiming kernel/container isolation.
- `docs/development/API.md` - public API truth; update readiness/metrics shape only and do not document a sandbox execution API.
- `docs/development/DEVELOPMENT.md` - local no-spend smoke guidance; add the sandbox smoke and keep required checks fake-only.
- `CHANGELOG.md` - user-facing release entry; say fake/no-spend substrate shipped and real hosted execution remains unshipped.

**Instructions:**

Internal checkpoint order:

1. Contracts first. Add `packages/contracts/src/sandbox.ts` with Zod schemas and exported types/constants for sandbox job request, normalized resource limits, policy decision, lifecycle event, result, captured artifact, PTY frame/input, fake command ids, lifecycle states, terminal states, and named errors. Export it from `packages/contracts/src/index.ts`. Run `pnpm --filter @switchyard/contracts test`.
2. Core service second. Add `HostedSandboxService`, `HostedSandboxExecutorPort`, `HostedSandboxPolicy`, `resolveHostedSandboxConfig`, `checkHostedSandboxReadiness`, `redactSandboxValue`, and transcript/artifact helpers in `packages/core/src/services/hosted-sandbox-service.ts`. Export from `packages/core/src/index.ts`. Extend the shared redaction key pattern in `local-policy-gate.ts` to include `credential`, `cookie`, `session`, `privateKey`, `accessKey`, `refreshToken`, and `idToken`.
3. Fake executor third. Add `FakeHostedSandboxExecutor` in testkit. It must implement deterministic scenarios for every allowed fake command id and must not import `child_process`, `node:child_process`, `node-pty`, `@switchyard/adapters`, shell wrappers, browser automation, fetch clients, GitHub clients, or repo tooling.
4. Resource limits and lifecycle fourth. Enforce default and max limits from config for wall time, stdout, stderr, combined output, artifact bytes, stdin bytes, argv count, argv entry bytes, env keys, env value bytes, and PTY cols/rows. Treat CPU and memory as validation-only declarations: validate positive values and max bounds, persist/carry them as safe metadata, and do not simulate CPU or memory breach outcomes in R14. Terminal states are monotonic. Late output, late timeout, late cancel, and late artifact writes must not overwrite a terminal result.
5. Artifact capture fifth. When transcript capture is enabled and an artifact content store is present, write a JSONL transcript with redacted lifecycle/output records and metadata from `StoredArtifactContent`. When no artifact content store is provided, return `contentStored: false`. Fake artifacts obey `artifactBytes` and fail with `sandbox_artifact_too_large` before persistence when oversized.
6. App wiring sixth. Add `sandbox` config to server and worker config with env names from the spec. Server `/ready` adds `checks.sandbox`. Server `/metrics` adds a sandbox group with counters from the spec. Worker `ready()` must preserve compatibility with existing callers by returning `{ ok: boolean; reason?: string; checks?: { sandbox?: { ok: boolean; code?: string; diagnostics?: Record<string, unknown> } } }`; existing tests that read only `.ok` must continue passing. Add worker tests for sandbox ok, disabled, policy-invalid, and config-invalid readiness states.
7. Public hosted denial seventh. Add explicit `POST /runs` tests for public hosted real-runtime denial, separate from worker durable-row denial. These tests must assert a safe error envelope, no queue enqueue, no sandbox executor call, no artifact writes, and no run/event side effects beyond the safe rejected response path.
8. Hosted worker boundary eighth. Preserve `HostedWorkerService` behavior: hosted durable rows for `codex.exec_json`, `claude_code.sdk`, `opencode.acp`, `generic_http.async_rest`, `agentfield.async_rest`, `process`, `pty`, browser, search, fetch, GitHub, repo, and shell fail before `startRun` and before any sandbox executor dispatch.
9. Public API boundary ninth. Add a no-public-route/OpenAPI check: injected calls to `/sandbox`, `/exec`, `/pty`, and `/terminal` return not found; no route registration contains those paths; `pnpm --filter @switchyard/contracts openapi:check` remains deterministic and contains no sandbox execution operation.
10. Smoke and docs last. Add `pnpm sandbox:smoke`, update product/development/API/changelog/architecture docs, and do not edit `PROJECT.md`.

Mandatory implementation/review checkpoints:

1. **Contracts checkpoint:** contracts schemas and malformed request tests pass with `pnpm --filter @switchyard/contracts test`.
2. **Core checkpoint:** policy, validation, resource-limit, redaction, lifecycle, artifact, timeout/cancel, and failure-injection tests pass with `pnpm --filter @switchyard/core test`.
3. **Testkit checkpoint:** deterministic fake executor scenarios and forbidden-import checks pass with `pnpm --filter @switchyard/testkit test`.
4. **App wiring checkpoint:** public `POST /runs` denial, worker durable-row denial, worker readiness shape, server readiness/metrics, no public route, and hosted fake compatibility pass with `pnpm --filter @switchyard/server test` and `pnpm --filter @switchyard/worker test`.
5. **OpenAPI and smoke/docs checkpoint:** `pnpm --filter @switchyard/contracts openapi:check`, `pnpm sandbox:smoke`, `pnpm typecheck`, and `git diff --check` pass after docs are updated.

Contract shape to implement:

```ts
execute(request: SandboxJobRequestInput, options?: { signal?: AbortSignal }) => Promise<SandboxJobResult>
cancel(jobId: string) => Promise<SandboxJobResult | { status: "failed"; reasonCode: "sandbox_job_not_found" }>
checkHostedSandboxReadiness(config: ResolvedHostedSandboxConfig) => { ok: boolean; code?: SandboxNamedError }
```

Sample allowed process-like request:

```json
{
  "jobId": "sandbox_job_echo_1",
  "runId": "run_sandbox_smoke",
  "runtimeMode": "fake.deterministic",
  "adapterType": "process",
  "commandId": "switchyard.fake.echo",
  "argv": ["hello"],
  "cwd": "/repo",
  "env": {"SAFE_ENV": "visible", "API_TOKEN": "secret-value"},
  "stdin": "input secret=abc",
  "resourceLimits": {"wallTimeMs": 30000, "stdoutBytes": 65536, "stderrBytes": 65536, "combinedOutputBytes": 131072, "artifactBytes": 1048576, "stdinBytes": 65536, "argvCount": 32, "argvEntryBytes": 256, "envKeys": 32, "envValueBytes": 4096, "ptyCols": 80, "ptyRows": 24, "cpuMs": 1000, "memoryMiB": 256},
  "artifactPolicy": {"captureTranscript": true, "captureDeniedDecision": false},
  "createdAt": "2026-05-30T00:00:00.000Z"
}
```

Expected result properties for that request: policy decision `allow`, terminal status `completed`, stdout text containing only fake deterministic output, redacted env/stdin metadata, transcript artifact metadata with safe `storageBackend`, `objectKey`, `sizeBytes`, `sha256`, and no raw secret values.

**Acceptance criteria:**

- [ ] `@switchyard/contracts` exports sandbox schemas/types for job requests, policy decisions, lifecycle events, results, captured artifacts, resource limits, fake command ids, lifecycle states, and named errors.
- [ ] Sandbox request validation covers nil, empty, malformed, wrong-type, oversized, and valid process/PTY requests with named reason codes before policy/executor, including wrong-type `env`, `argv`, `artifactPolicy`, `createdAt`, `adapterType`, and invalid `adapterType`/`pty` combinations.
- [ ] Sandbox policy is deny-by-default and allows only the seven deterministic fake command ids listed in the spec.
- [ ] Explicit real command/tool/runtime ids are denied with `sandbox_command_denied` before executor dispatch.
- [ ] `HostedSandboxService` applies config defaults, validates resource limits, invokes policy before executor, tracks terminal lifecycle monotonicity, handles timeout/cancel idempotently, redacts all safe surfaces, and captures transcript/artifact metadata.
- [ ] `FakeHostedSandboxExecutor` deterministically simulates stdout, stderr, empty output, nonzero exit, output flood, timeout, cancel before start, cancel while running, cancel after terminal, fake artifact, artifact too large, and PTY input/resize/echo without OS process execution.
- [ ] Resource-limit config parses `SWITCHYARD_SANDBOX_*` env vars, rejects invalid values, rejects empty/non-fake allowlists, validates CPU/memory declaration bounds only, and reports redacted config summaries.
- [ ] Server `/ready` includes `checks.sandbox` with `ok=true`, `sandbox_disabled`, `sandbox_policy_invalid`, or `sandbox_config_invalid` without running commands.
- [ ] Server `/metrics` includes the sandbox counters from the spec and no high-cardinality or secret-bearing fields.
- [ ] Worker `ready()` returns `ok`, optional `reason`, and optional `checks.sandbox`, preserving existing callers that read only `ok`.
- [ ] Worker constructs the fake sandbox substrate but still registers only `FakeRuntimeAdapter` for actual hosted run execution.
- [ ] Existing hosted fake runs remain backward compatible.
- [ ] Hosted non-fake runtime/mode requests remain denied before `startRun` and before sandbox executor dispatch.
- [ ] Public `POST /runs` hosted real-runtime requests are denied before enqueue, sandbox executor dispatch, artifact writes, and event side effects.
- [ ] Static tests prove the hosted sandbox path and worker path do not import `child_process`, `node:child_process`, `node-pty`, `@switchyard/adapters`, browser automation, fetch clients, GitHub clients, repo tooling, or shell execution wrappers.
- [ ] No public `/sandbox`, `/exec`, `/pty`, `/terminal`, or equivalent arbitrary execution route is added.
- [ ] OpenAPI remains deterministic when checked and contains no public sandbox execution operation.
- [ ] `pnpm sandbox:smoke` exercises allowed fake job, denied real command, timeout, cancellation idempotency, transcript artifact capture/redaction, readiness, and metrics with no external spend.
- [ ] Docs and product truth say R14 ships only a fake/no-spend hosted sandbox substrate, while real hosted subprocess/PTY, production sandboxing, hosted Codex/Claude/OpenCode, real tools, managed platform, enterprise controls, dashboard, and TUI remain unshipped.

**Checks (must pass before GREEN):**

- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/testkit test`
- `pnpm --filter @switchyard/server test`
- `pnpm --filter @switchyard/worker test`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm sandbox:smoke`
- `pnpm typecheck`
- `git diff --check`

No required check may run Docker, AWS, R2, live model providers, browser binaries, GitHub network calls, shell commands through the sandbox, real subprocess execution, or real PTY execution.

**Error rescue map:**

| Codepath | Failure | Exception shape | Rescue action | User sees |
| --- | --- | --- | --- | --- |
| `resolveHostedSandboxConfig` | sandbox disabled | no throw; config has `enabled=false` | Readiness returns `sandbox_disabled`; `HostedSandboxService.execute` returns failed result before validation/execution | `/ready` shows `checks.sandbox.ok=false`, internal caller gets `sandbox_disabled` |
| `resolveHostedSandboxConfig` | invalid boolean, timeout, output, artifact, or allowlist env | `ConfigError` or sandbox config error code `sandbox_config_invalid` | Stop app startup for invalid env; include only redacted config summary | Startup/test failure names the invalid variable without secret values |
| `checkHostedSandboxReadiness` | allowlist empty or contains non-fake command id | `{ ok:false, code:"sandbox_policy_invalid" }` | Do not execute any command; report readiness failure | `/ready` shows `sandbox_policy_invalid` |
| `HostedSandboxService.execute` | request object is null or undefined | result reason `sandbox_request_missing` | Return failed result before policy and before executor | Internal caller receives named failed result |
| `HostedSandboxService.execute` | command id, cwd, env, argv, stdin, PTY, artifact policy, or schema invalid | result reason `sandbox_request_invalid` or field-specific named limit code | Return failed result with redacted field details before policy and executor | Internal caller receives validation reason and no executor call occurs |
| `HostedSandboxService.execute` | requested limits exceed configured max or are non-positive | result reason `sandbox_resource_limit_invalid` | Return failed result before policy and executor | Internal caller receives limit reason |
| `HostedSandboxPolicy.decide` | command id unknown or real command/tool/runtime id | policy decision `deny`, reason `sandbox_command_denied` | Return failed result and emit `sandbox.policy.denied` log with safe ids only | Internal caller sees denied result; executor count remains zero |
| `HostedSandboxPolicy.decide` | policy helper throws unexpectedly | result reason `sandbox_policy_failed` | Catch the specific policy exception, log safe code, return failed result, no executor call | Internal caller sees `sandbox_policy_failed` |
| `HostedSandboxService.dispatch` | executor dispatch attempted without allow decision | result reason `sandbox_policy_missing` | Fail closed and do not call executor | Internal caller sees `sandbox_policy_missing` |
| `FakeHostedSandboxExecutor.execute` | nonzero fake exit or scenario failure | result reason `sandbox_process_failed` | Produce failed terminal result and preserve redacted transcript when capture is enabled | Internal caller sees failed result with exit code |
| `FakeHostedSandboxExecutor.execute` | wall time exceeds limit | result status `timeout`, reason `sandbox_timeout` | Abort active fake job, mark terminal, preserve transcript | Internal caller sees timeout terminal result |
| `HostedSandboxService.cancel` | unknown job id | result reason `sandbox_job_not_found` | Return named miss, no public route added | Internal caller sees `sandbox_job_not_found` |
| `HostedSandboxService.cancel` | active job cancel succeeds | result status `cancelled`, reason `sandbox_cancelled` | Abort active fake job and make later cancel idempotent | Internal caller sees terminal cancelled result |
| `HostedSandboxService.cancel` | executor fails to acknowledge cancellation | result reason `sandbox_cancel_failed` | Force terminal failed result, clear active job, log safe code | Internal caller sees `sandbox_cancel_failed` |
| `HostedSandboxService.captureOutput` | stdout/stderr exceeds per-stream limit | truncation flags | Truncate stream, increment `sandbox.outputTruncated`, continue unless combined limit breaches | Result metadata shows truncation without leaked full output |
| `HostedSandboxService.captureOutput` | combined output limit exceeds after truncation | result reason `sandbox_output_limit_exceeded` | Stop output capture and terminalize according to command policy | Internal caller sees named output-limit result |
| `HostedSandboxService.captureArtifacts` | fake artifact bytes exceed limit | result reason `sandbox_artifact_too_large` | Refuse artifact before content-store write | Internal caller sees artifact-size failure |
| `HostedSandboxService.captureArtifacts` | artifact content write fails | result reason `sandbox_artifact_capture_failed` or existing object-store code | Do not include content, preserve named error, log safe code only | Internal caller sees named artifact capture failure |
| `redactSandboxValue` | unserializable value or redaction utility throws | result reason `sandbox_redaction_failed` | Fail closed before persistence/logging when detected before execution; after start, terminalize failed and omit raw value | Internal caller sees redaction failure without raw payload |
| `apps/worker HostedWorkerService` | durable row is hosted non-fake runtime/mode/adapter | existing reason `hosted_runtime_not_allowed` | Fail run and queue job before `startRun`; no sandbox executor dispatch | Run event has `hosted_runtime_not_allowed`, no run started |
| `apps/server HostedRunService` | public hosted real runtime request | `HostedRunServiceError("placement_denied"|"hosted_runtime_not_allowed")` | Deny before enqueueing, before sandbox executor dispatch, before artifact writes, and before run/event side effects | Client sees safe placement denial and no queued job exists |
| `apps/server route table/OpenAPI` | sandbox execution route accidentally added | route registration or OpenAPI drift test failure | Remove the public route/operation; keep sandbox substrate internal | `/sandbox`, `/exec`, `/pty`, and `/terminal` are not found |

**Observability:**

```json
{
  "logs": [
    "warn: sandbox.policy.denied with jobId, runId, runtimeMode, adapterType, commandId, reasonCode",
    "info: sandbox.job.started with jobId, runId, runtimeMode, adapterType, commandId",
    "warn: sandbox.job.output_truncated with jobId, stream, byte counts, truncation booleans",
    "info: sandbox.job.artifact_captured with jobId, artifact count, byte counts, contentStored",
    "info: sandbox.job.completed with jobId, durationMs, exitCode",
    "warn: sandbox.job.failed with jobId, reasonCode",
    "info: sandbox.job.cancelled with jobId, reasonCode",
    "warn: sandbox.job.timeout with jobId, wallTimeMs",
    "info: sandbox.redaction.applied with jobId and field category only"
  ],
  "success_metric": "server /metrics sandbox counters include jobs, allowed, completed, redactions, and readiness shows checks.sandbox.ok=true for valid fake allowlist",
  "failure_metric": "sandbox denied, failed, timeout, cancelled, outputTruncated, artifactTruncated, and redactions counters increment without labels or secret-bearing values"
}
```

**Test cases:**

- `{ "name": "contract accepts complete process job", "lens": "happy", "given": "sandboxJobRequestSchema.parse(process request with switchyard.fake.echo)", "expect": "valid request with process adapterType and resource limits" }`
- `{ "name": "contract accepts complete pty job", "lens": "happy", "given": "sandboxJobRequestSchema.parse(pty request with cols 80 rows 24 and switchyard.fake.pty_echo)", "expect": "valid request with PTY frame contract" }`
- `{ "name": "missing request fails", "lens": "happy_shadow_nil", "given": "HostedSandboxService.execute(undefined)", "expect": "failed result reasonCode sandbox_request_missing and executor calls 0" }`
- `{ "name": "empty command and cwd fail", "lens": "happy_shadow_empty", "given": "request with empty commandId or empty cwd", "expect": "sandbox_request_invalid before policy/executor" }`
- `{ "name": "malformed env wrong type", "lens": "error_path", "given": "request env is string, array, null, or contains non-string value", "expect": "sandbox_request_invalid before policy/executor and executor calls 0" }`
- `{ "name": "malformed argv wrong type", "lens": "error_path", "given": "request argv is string, object, null, or contains non-string entries", "expect": "sandbox_request_invalid before policy/executor and executor calls 0" }`
- `{ "name": "malformed artifact policy wrong type", "lens": "error_path", "given": "artifactPolicy is string, null, or has non-boolean capture flags", "expect": "sandbox_request_invalid before policy/executor and executor calls 0" }`
- `{ "name": "malformed createdAt wrong type", "lens": "error_path", "given": "createdAt missing, number, or non-ISO string", "expect": "sandbox_request_invalid before policy/executor and executor calls 0" }`
- `{ "name": "malformed adapter type", "lens": "error_path", "given": "adapterType is browser, http, native, object, null, or empty string", "expect": "sandbox_request_invalid before policy/executor and executor calls 0" }`
- `{ "name": "invalid adapter pty combinations", "lens": "error_path", "given": "adapterType process with pty input, adapterType pty without pty config, or pty command with process adapter", "expect": "sandbox_pty_invalid or sandbox_request_invalid before policy/executor and executor calls 0" }`
- `{ "name": "invalid cwd normalization fails", "lens": "error_path", "given": "cwd relative path, Windows drive, or path with traversal", "expect": "sandbox_request_invalid before executor" }`
- `{ "name": "argv too large", "lens": "error_path", "given": "33 argv entries or one arg over 256 bytes", "expect": "sandbox_argv_too_large before executor" }`
- `{ "name": "env too large", "lens": "error_path", "given": "33 env keys or env value over 4096 bytes", "expect": "sandbox_env_too_large before executor" }`
- `{ "name": "stdin too large", "lens": "error_path", "given": "stdin over 64 KiB", "expect": "sandbox_stdin_too_large before executor" }`
- `{ "name": "pty dimensions invalid", "lens": "error_path", "given": "cols below 20 or above 240, rows below 5 or above 80", "expect": "sandbox_pty_invalid before executor" }`
- `{ "name": "resource limit invalid", "lens": "error_path", "given": "wallTimeMs 0 or over configured max", "expect": "sandbox_resource_limit_invalid before executor" }`
- `{ "name": "cpu memory declarations validate bounds only", "lens": "edge_resource_limits", "given": "cpuMs and memoryMiB within bounds, then below/above bounds", "expect": "valid bounds pass as metadata; invalid bounds return sandbox_resource_limit_invalid; no fake CPU or memory breach simulation exists" }`
- `{ "name": "policy service failure", "lens": "error_path", "given": "policy dependency throws while deciding an otherwise valid request", "expect": "sandbox_policy_failed, executor calls 0, safe log only" }`
- `{ "name": "policy decision missing", "lens": "error_path", "given": "dispatch path receives no allow/deny decision through explicit test seam", "expect": "sandbox_policy_missing, executor calls 0" }`
- `{ "name": "allow every fake command id", "lens": "happy", "given": "policy decisions for seven switchyard.fake.* ids", "expect": "allow decisions and executor dispatch permitted" }`
- `{ "name": "deny every real command id", "lens": "error_path", "given": "sh, bash, zsh, node, python3, npm, pnpm, codex, claude, opencode, git, gh, curl, wget, ssh, browser, web_search, fetch, repo, github, shell", "expect": "sandbox_command_denied and executor calls 0" }`
- `{ "name": "empty allowlist invalid", "lens": "happy_shadow_empty", "given": "SWITCHYARD_SANDBOX_FAKE_COMMAND_ALLOWLIST empty", "expect": "readiness code sandbox_policy_invalid" }`
- `{ "name": "non fake allowlist invalid", "lens": "error_path", "given": "allowlist contains bash", "expect": "readiness code sandbox_policy_invalid" }`
- `{ "name": "config disabled", "lens": "happy_shadow_nil", "given": "SWITCHYARD_SANDBOX_ENABLED=false", "expect": "readiness code sandbox_disabled and execute returns sandbox_disabled" }`
- `{ "name": "config defaults", "lens": "happy", "given": "local/test env with no sandbox vars", "expect": "enabled true, default limits, full fake allowlist" }`
- `{ "name": "config invalid numeric values", "lens": "error_path", "given": "negative timeout, zero output bytes, artifact max over R14 max", "expect": "sandbox_config_invalid or named config error with redacted summary" }`
- `{ "name": "fake echo stdout", "lens": "happy", "given": "switchyard.fake.echo with argv hello", "expect": "completed result with stdout frame and no stderr" }`
- `{ "name": "fake stderr output", "lens": "happy", "given": "switchyard.fake.stderr", "expect": "completed result with stderr byte counts" }`
- `{ "name": "fake empty output", "lens": "happy_shadow_empty", "given": "switchyard.fake.echo with empty argv and empty stdin", "expect": "completed result with zero output counts and transcript metadata" }`
- `{ "name": "fake nonzero exit", "lens": "error_path", "given": "switchyard.fake.exit argv exitCode=7", "expect": "failed result reasonCode sandbox_process_failed and exitCode 7" }`
- `{ "name": "fake output flood truncates", "lens": "edge_output_limit", "given": "switchyard.fake.output_flood with low stdout/stderr/combined limits", "expect": "truncation flags and sandbox_output_limit_exceeded when combined limit breaches" }`
- `{ "name": "fake artifact capture", "lens": "happy", "given": "switchyard.fake.artifact with transcript capture enabled and memory artifact content store", "expect": "captured artifact metadata has contentStored true, storageBackend, sizeBytes, sha256, contentType" }`
- `{ "name": "fake artifact too large", "lens": "error_path", "given": "switchyard.fake.artifact artifact bytes exceed limit", "expect": "sandbox_artifact_too_large before content write" }`
- `{ "name": "timeout terminal", "lens": "error_path", "given": "switchyard.fake.sleep with wallTimeMs smaller than scenario duration", "expect": "timeout result reasonCode sandbox_timeout and later output ignored" }`
- `{ "name": "cancel before start", "lens": "edge_cancel", "given": "pre-aborted signal passed to execute", "expect": "cancelled result reasonCode sandbox_cancelled and no output frames" }`
- `{ "name": "cancel during running", "lens": "edge_cancel", "given": "start fake sleep then call cancel(jobId)", "expect": "cancelled result, active job cleared, transcript preserved" }`
- `{ "name": "cancel after terminal idempotent", "lens": "edge_cancel", "given": "cancel(jobId) after completed result", "expect": "same terminal result returned without new events" }`
- `{ "name": "cancel missing job", "lens": "happy_shadow_nil", "given": "cancel unknown job id", "expect": "sandbox_job_not_found" }`
- `{ "name": "cancel acknowledgement failure", "lens": "error_path", "given": "executor test seam rejects or ignores cancellation acknowledgement", "expect": "sandbox_cancel_failed, active job cleared, terminal failed result" }`
- `{ "name": "fake pty echo", "lens": "happy", "given": "switchyard.fake.pty_echo with input and resize frame", "expect": "PTY output frames preserve dimensions within bounds and redacted text" }`
- `{ "name": "secret redaction env argv stdin output errors", "lens": "error_path", "given": "secret-looking token/apiKey/authorization/password/secret/credential/cookie/session/privateKey/accessKey/refreshToken/idToken values in env, argv metadata, stdin, stdout, stderr, PTY frames, errors, policy traces, artifact metadata", "expect": "persisted/logged/result metadata uses [REDACTED] and no raw sentinel appears" }`
- `{ "name": "bearer and signed URL redaction", "lens": "error_path", "given": "output contains Bearer token and URL with userinfo/query signature", "expect": "redacted output in transcript and metadata" }`
- `{ "name": "redaction failure fail closed", "lens": "error_path", "given": "unserializable value passed in metadata path that redactor rejects", "expect": "sandbox_redaction_failed and no persistence of raw value" }`
- `{ "name": "lifecycle monotonic terminal", "lens": "edge_lifecycle", "given": "executor attempts output, timeout, cancel, artifact after completed", "expect": "completed remains terminal and late frames ignored or recorded as ignored diagnostics without state overwrite" }`
- `{ "name": "artifact write failure named", "lens": "error_path", "given": "artifact content store writeText throws object_store_write_failed", "expect": "result reason sandbox_artifact_capture_failed or preserved object_store_write_failed with no content leak" }`
- `{ "name": "no artifact store configured", "lens": "happy_shadow_nil", "given": "capture enabled with no artifactContent dependency", "expect": "result contentStored false and no throw" }`
- `{ "name": "empty transcript artifact", "lens": "happy_shadow_empty", "given": "empty-output job with capture enabled", "expect": "valid zero-frame or metadata-only transcript according to contract and digest metadata when written" }`
- `{ "name": "server readiness sandbox ok", "lens": "integration", "given": "test server config with default sandbox", "expect": "GET /ready returns checks.sandbox.ok true" }`
- `{ "name": "server readiness sandbox disabled", "lens": "integration", "given": "server config sandbox enabled false", "expect": "GET /ready 503 with checks.sandbox.code sandbox_disabled" }`
- `{ "name": "server metrics sandbox counters", "lens": "integration", "given": "server metrics snapshot after sandbox smoke/service increments", "expect": "sandbox group includes jobs allowed denied completed failed timeout cancelled outputTruncated artifactTruncated redactions and no labels" }`
- `{ "name": "worker readiness shape remains compatible", "lens": "integration", "given": "createHostedWorker default config and existing tests that read ready().ok", "expect": "ready returns ok true, optional checks.sandbox.ok true, and existing ok-only callers still pass" }`
- `{ "name": "worker readiness sandbox disabled", "lens": "integration", "given": "worker config sandbox enabled false", "expect": "ready returns ok false or reason plus checks.sandbox.code sandbox_disabled without running commands" }`
- `{ "name": "worker readiness policy invalid", "lens": "integration", "given": "worker config fake command allowlist empty or non-fake", "expect": "ready returns checks.sandbox.code sandbox_policy_invalid and no execution" }`
- `{ "name": "worker readiness config invalid", "lens": "integration", "given": "worker config invalid sandbox numeric/env values", "expect": "loadWorkerConfig or ready path reports sandbox_config_invalid with redacted diagnostics" }`
- `{ "name": "worker constructs sandbox but keeps fake adapter only", "lens": "integration", "given": "createHostedWorker default config", "expect": "ready ok with sandbox check and source contains only FakeRuntimeAdapter registration" }`
- `{ "name": "hosted fake run still works", "lens": "integration", "given": "queued hosted fake.deterministic run", "expect": "worker tick completes existing fake run" }`
- `{ "name": "hosted real runtime denied before execution", "lens": "error_path", "given": "queued hosted codex.exec_json, claude_code.sdk, opencode.acp, generic_http.async_rest, agentfield.async_rest, process, pty, browser, search, fetch, github, repo, shell rows", "expect": "hosted_runtime_not_allowed, no run.started event, startRun not called, sandbox executor calls 0" }`
- `{ "name": "public post runs hosted real runtime denied before enqueue", "lens": "error_path", "given": "POST /runs placement hosted with codex.exec_json, claude_code.sdk, opencode.acp, generic_http.async_rest, agentfield.async_rest, process, pty, browser, search, fetch, github, repo, or shell", "expect": "safe placement_denied or hosted_runtime_not_allowed error, queue enqueue count 0, sandbox executor calls 0, artifact writes 0, no run/event side effects" }`
- `{ "name": "static forbidden imports", "lens": "error_path", "given": "read worker, hosted sandbox service, and fake executor source files", "expect": "no child_process, node:child_process, node-pty, @switchyard/adapters, shell wrapper, browser automation, fetch client, GitHub client, or repo tooling imports" }`
- `{ "name": "no public sandbox route", "lens": "integration", "given": "server route table or injected calls to /sandbox /exec /pty /terminal", "expect": "404 and no route registration" }`
- `{ "name": "openapi has no sandbox execution operation", "lens": "integration", "given": "pnpm --filter @switchyard/contracts openapi:check and generated local daemon OpenAPI JSON", "expect": "OpenAPI remains deterministic and contains no /sandbox, /exec, /pty, /terminal, or sandbox execution operationId" }`
- `{ "name": "sandbox smoke", "lens": "integration", "given": "pnpm sandbox:smoke", "expect": "allowed fake completes, real command denied before executor, timeout terminal, cancel idempotent, transcript redacted, readiness ok, metrics updated" }`
- `{ "name": "docs product truth", "lens": "integration", "given": "PRODUCT ARCHITECTURE DEVELOPMENT API CHANGELOG", "expect": "fake/no-spend sandbox substrate marked shipped and real hosted execution/non-goals remain unshipped" }`

**Integration contracts:**

```json
{
  "exports": [
    {
      "name": "sandboxJobRequestSchema",
      "kind": "constant",
      "signature": "z.ZodType<SandboxJobRequest>"
    },
    {
      "name": "sandboxNamedErrorSchema",
      "kind": "constant",
      "signature": "z.ZodEnum<[closed SandboxNamedError values]>"
    },
    {
      "name": "HostedSandboxService",
      "kind": "class",
      "signature": "new HostedSandboxService(deps: { config: ResolvedHostedSandboxConfig; executor: HostedSandboxExecutorPort; artifactContent?: ArtifactContentStore; artifacts?: ArtifactStore; logger?: RuntimeLogger; metrics?: SandboxMetricsSink; now?: () => string })"
    },
    {
      "name": "HostedSandboxService.execute",
      "kind": "function",
      "signature": "execute(request: unknown, options?: { signal?: AbortSignal }) => Promise<SandboxJobResult>"
    },
    {
      "name": "HostedSandboxService.cancel",
      "kind": "function",
      "signature": "cancel(jobId: string) => Promise<SandboxJobResult>"
    },
    {
      "name": "resolveHostedSandboxConfig",
      "kind": "function",
      "signature": "resolveHostedSandboxConfig(input: { env?: NodeJS.ProcessEnv; deploymentMode: 'local' | 'test' | 'staging' | 'production' }) => ResolvedHostedSandboxConfig"
    },
    {
      "name": "checkHostedSandboxReadiness",
      "kind": "function",
      "signature": "checkHostedSandboxReadiness(config: ResolvedHostedSandboxConfig) => { ok: boolean; code?: SandboxNamedError }"
    },
    {
      "name": "FakeHostedSandboxExecutor",
      "kind": "class",
      "signature": "new FakeHostedSandboxExecutor(options?: { clock?: () => string }) implements HostedSandboxExecutorPort"
    }
  ],
  "imports_from_other_tasks": [],
  "file_paths_consumed_by_other_tasks": []
}
```

## Risks

- **Single-task breadth:** This one task owns more than 8 files. Splitting would force cross-worktree edits to the same schemas, config names, readiness shape, and docs truth. Mitigation: mandatory checkpoint order with package tests after each layer.
- **False confidence from fake substrate:** A fake executor can be mistaken for production sandboxing. Mitigation: docs and release truth must repeatedly say fake/no-spend substrate only, no arbitrary hosted execution, no kernel/container isolation.
- **Policy bypass risk in future adapters:** If future code calls the fake executor directly, policy can be skipped. Mitigation: fake executor lives in testkit, core service owns policy, and app wiring constructs the service, not the executor alone, for future adapter dependency injection.
- **Redaction gaps:** Output and artifact content can carry secret-like strings. Mitigation: redaction tests cover env, argv metadata, stdin metadata, stdout, stderr, PTY frames, policy traces, errors, logs, metrics, events, and artifact metadata with unique sentinels.
- **Static import tests can be brittle:** Denied command ids include words like shell and fetch, while import tests need to target execution imports. Mitigation: static tests should scan import declarations and known adapter class/package names, not fail on policy-deny string constants.
- **Readiness ambiguity:** Readiness must not run commands. Mitigation: readiness validates config and fake allowlist only; the smoke command exercises execution separately.
- **CPU and memory declarations can be overclaimed:** CPU and memory fields are validation-only declarations in R14, while wall time/output/input/artifact/PTY dimensions have fake behavior. Mitigation: result/docs/tests must say CPU and memory are bounded metadata only, with no fake or real enforcement in this phase.

## Integration Points

The one-task internal order is part of the implementation contract:

1. Contracts establish stable names and Zod schemas.
2. Core service consumes contracts and owns policy, config, redaction, lifecycle, limits, artifact capture, logs, and metric sink increments.
3. Testkit fake executor implements the core executor port and remains the only executor used in R14 app wiring and smoke.
4. Server and worker parse the same sandbox env contract and construct the fake substrate. Server exposes readiness/metrics; worker exposes `ready()` as `{ ok, reason?, checks? }`. Neither exposes a public sandbox execution API.
5. Public `POST /runs` hosted real-runtime denial is tested before enqueue and separately from worker durable-row denial.
6. Existing hosted run execution remains `RunService` plus `RuntimeRunnerService` with a map containing only `FakeRuntimeAdapter`.
7. OpenAPI remains deterministic and contains no sandbox execution operation.
8. Docs are updated only after behavior and tests are stable.

No task imports from another task because this phase intentionally uses one coherent task.

## Phase-Level Acceptance Criteria

- [ ] A typed hosted sandbox contract exists for fake process-like and PTY-like jobs, resource limits, lifecycle events, results, artifacts, policy decisions, and named errors.
- [ ] Sandbox policy is deny-by-default and allows only deterministic fake command ids.
- [ ] Real command/tool/runtime ids are explicitly denied before execution.
- [ ] The R14 fake executor performs deterministic no-spend stdout/stderr/PTY/artifact/failure/timeout/cancel scenarios without OS process execution.
- [ ] Resource limits are validated and enforced in fake execution behavior for wall time, output, input, env, argv, artifact, and PTY dimensions, while CPU/memory are validation-only declarations.
- [ ] Logs, metrics, events, policy traces, errors, and artifact metadata are redacted and bounded.
- [ ] Timeout and cancellation produce terminal, idempotent lifecycle outcomes and preserve transcripts when capture is enabled.
- [ ] Hosted worker still registers only the fake runtime adapter and still rejects hosted real runtimes before execution.
- [ ] Public `POST /runs` hosted real-runtime denial is verified before queue enqueue and separate from worker durable-row denial.
- [ ] Worker readiness preserves `ok` compatibility and adds optional `checks.sandbox`.
- [ ] `/ready` and `/metrics` include sandbox diagnostics/counters without running real commands or leaking secrets.
- [ ] Existing hosted fake run behavior remains backward compatible.
- [ ] Normal CI and smoke coverage are no-spend and deterministic.
- [ ] Product docs are updated to describe the fake substrate accurately and keep real hosted execution out of scope.

## Self-Review

1. Spec coverage: pass. The single task covers contracts, deny-by-default policy, fake executor scenarios, malformed request validation, resource-limit config/validation with CPU/memory validation-only semantics, redaction, artifact capture, readiness/metrics, worker readiness shape, public hosted denial before enqueue, hosted worker fake-only boundary, no public API/OpenAPI route, no-spend smoke, and docs truth.
2. Placeholder scan: pass. No placeholder work items remain.
3. Type consistency: pass. Contracts export the schemas consumed by core, core exports the executor/service/config contracts consumed by testkit and apps, and testkit implements the executor port.
4. Ownership disjoint: pass. There is one task, so there is no cross-task file overlap.
5. Context files real: pass. All context files listed for the task exist in this worktree.
6. Acceptance testable: pass. Every acceptance item maps to package tests, smoke, static scans, or docs checks.
7. Dependency order sane: pass. One task has explicit implementation/review checkpoints from contracts to core to testkit to apps to OpenAPI/smoke/docs.
8. Checks runnable: pass. Commands are existing package test/typecheck/openapi commands plus the new root smoke script created by the task.
9. Error/rescue map present: pass. Config, validation, malformed request, policy, policy missing, executor, cancellation, timeout, output, artifact, redaction, public hosted denial, worker durable denial, and route/OpenAPI failures are enumerated.
10. Observability present: pass. Logs, readiness, and metrics counters are specified with no secret-bearing or high-cardinality fields.
11. Test cases enumerate acceptance: pass. Happy, nil, empty, malformed, error, edge, and integration lenses cover the acceptance criteria and rescue paths, including architect iteration 1 additions.
12. Integration contracts walk: pass. There are no cross-task imports; all exports are internal to the one task and consumed by files owned by the same task.
13. Contract types match: pass. `SandboxJobRequest`, `SandboxJobResult`, `ResolvedHostedSandboxConfig`, `HostedSandboxExecutorPort`, and fake executor signatures are consistent across contracts, core, testkit, apps, and smoke.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error rescue map entry has a matching test case in `lens: error_path` or `lens: happy_shadow_*`.
- [x] Every integration contract import from another task resolves to a real export elsewhere; there are no cross-task imports in this one-task phase.
- [x] Every context file path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is present.
- [x] Complexity is L and a sub-phase split was considered; the plan keeps one task because the user requested one coherent task and the write sets are not truly independent.
