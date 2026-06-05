# Phase 13 Spec: R14 Hosted Sandbox Substrate For Process/PTY

**Date:** 2026-05-30
**Run:** post-r11-remaining-20260530
**Branch:** `agent/phase-13-r14-hosted-sandbox-substrate`
**Base:** Phase 12/R13 closed at `c8f9b7c`
**Spec target:** `docs/superpowers/specs/2026-05-30-phase-13-r14-hosted-sandbox-substrate.md`

## Problem

Switchyard can now run a self-hosted fake worker slice and store artifacts through local object volumes or S3/R2-compatible object storage, but it still has no hosted-safe substrate for process-like or PTY-like execution. That is the next blocking gap before hosted Codex, Claude Code, OpenCode, generic process, PTY, browser/search, fetch, GitHub, or repo tools can be considered.

R14 should add the safety substrate first: a policy-gated, fake/no-spend hosted sandbox execution layer with resource-limit contracts, deny-by-default command policy, redacted logs, deterministic lifecycle handling, timeout/cancellation behavior, output/artifact capture, and exhaustive tests. R14 must not ship arbitrary hosted subprocess execution or any real hosted runtime.

## Goals

- Define a hosted sandbox job contract that can represent process-like and PTY-like jobs without executing real host commands in R14.
- Add a deny-by-default sandbox policy gate that only allows deterministic fake command ids and rejects unknown, shell, real CLI, network, browser, repository, GitHub, fetch, and provider-runtime commands before execution.
- Add a fake/no-spend sandbox executor that simulates stdout, stderr, PTY frames, artifacts, exits, timeouts, cancellation, and resource-limit breaches deterministically.
- Establish resource-limit fields and enforcement behavior for wall time, output bytes, artifact bytes, input bytes, environment size, PTY dimensions, and future CPU/memory declarations.
- Capture sanitized sandbox logs and transcripts as Switchyard artifacts without leaking secrets, command payloads marked secret, signed object-store details, or raw env values.
- Integrate the substrate into hosted worker construction as an available internal dependency for future hosted adapters, while keeping hosted worker runtime execution restricted to `fake.deterministic`.
- Surface lifecycle and failure states through existing run events, artifact metadata, worker logs, readiness checks, and metrics in a low-cardinality way.
- Add deterministic tests for happy, nil, empty, and error paths for every sandbox data flow.
- Update product/development docs after implementation so Switchyard truth says "fake hosted sandbox substrate exists" without implying real hosted execution is safe.

## Non-Goals

- No arbitrary hosted subprocess execution.
- No real hosted PTY execution.
- No public `/sandbox`, `/exec`, `/pty`, `/terminal`, or equivalent arbitrary-execution API.
- No hosted Codex, Claude Code, OpenCode, Generic HTTP, AgentField, Cursor, OpenClaw, Paperclip, generic process, generic PTY, browser/search, shell, fetch, GitHub, or repo adapter execution.
- No real shell/browser/search/GitHub/fetch/repo tool execution.
- No `child_process.spawn`, `node-pty`, shell interpolation, process tree management, container runtime, Firecracker, Docker, Kubernetes, gVisor, nsjail, seccomp, cgroups, or production kernel sandboxing in the hosted worker path.
- No interactive Codex promotion, Codex session resume, Codex approval bridge, or runtime-specific approval bridges.
- No hosted debate with real participant runtimes or model judging.
- No managed hosted platform, enterprise organizations, OAuth, SSO, RBAC, billing, tenant quotas, tenant isolation controls, dashboard, or TUI.
- No network calls or external provider spend in required tests.

## Current Truth

R14 starts from the R13 closeout. `PROJECT.md` records that R13 shipped S3/R2-compatible artifact content, but hosted subprocess/PTY execution and hosted real runtimes remain out of scope:

```md
The shipped boundary remains explicit: R13 does not ship managed hosted deployment, hosted Codex/Claude/OpenCode execution, arbitrary hosted subprocess/PTY execution, enterprise auth/billing/tenant controls, broad adapters/tools, runtime-specific approval bridges, hosted real-runtime debate/model judging, dashboard, or TUI.
```

`PRODUCT.md` lists the exact remaining hosted runtime gaps:

```md
- Hosted real-runtime worker deployment for Codex, Claude Code, OpenCode, arbitrary process, or PTY execution.
- Production sandboxing for arbitrary subprocess/PTY workloads.
- Generic process adapter.
- PTY adapter.
- Hosted Codex execution.
- Hosted Claude Code/OpenCode execution.
```

The hosted worker currently constructs only the fake adapter. This boundary must remain true after R14:

`apps/worker/src/worker.ts`:

```ts
const adapters = new Map<string, RuntimeAdapter>([["fake", new FakeRuntimeAdapter()]]);
const runner = new RuntimeRunnerService({
  runs,
  events,
  sessions,
  adapters,
  artifacts,
  artifactContent: {
    writeText: async (path, content) => {
      return artifactContent.writeText(path, content, { contentType: "application/x-ndjson" });
    }
  }
});
```

The durable hosted worker service rejects any hosted durable row that is not the fake deterministic mode:

`packages/core/src/services/hosted-worker-service.ts`:

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

The existing process substrate is local-adapter-owned. It starts a process through an injected factory and sends `SIGTERM` on cancel; R14 must not put this substrate behind hosted worker real execution:

`packages/adapters/src/substrates/process-runner.ts`:

```ts
const process = input.processFactory(input.args, { cwd: input.cwd, env: input.env });
if (input.stdin === "close") {
  process.stdin.end();
}
```

`packages/adapters/src/substrates/process-runner.ts`:

```ts
const cancel = () => {
  if (cancelled) {
    return;
  }
  cancelled = true;
  process.kill("SIGTERM");
};
```

The current runtime contract already has the placement and adapter vocabulary R14 needs to prepare future hosted process/PTY modes:

`packages/contracts/src/run.ts`:

```ts
export const adapterTypeSchema = z.enum(["native", "acpx", "http", "webhook", "process", "pty", "browser"]);
export const runStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
  "timeout"
]);
export const executionPlacementSchema = z.enum(["local", "hosted", "connected_local_node"]);
```

Tool execution is already deny-by-default for real tools, and that same product posture should guide sandbox policy:

`packages/core/src/services/tool-router.ts`:

```ts
const REAL_TOOL_TYPES = new Set(["web_search", "fetch", "browser", "repo", "shell", "github"]);
const KNOWN_TOOL_TYPES = new Set([...REAL_TOOL_TYPES, "fake_echo"]);
```

## Architecture

R14 should add a hosted sandbox substrate, not a hosted runtime. The substrate is an internal typed dependency that future hosted runtime adapters can call. It should not be exposed as an arbitrary execution API and should not accept user-supplied command strings from REST clients.

The implementation should introduce a small set of serializable contracts, preferably in `packages/contracts`, for:

- `SandboxJobRequest`
- `SandboxPolicyDecision`
- `SandboxJobLifecycleEvent`
- `SandboxJobResult`
- `SandboxCapturedArtifact`
- `SandboxResourceLimits`
- `SandboxNamedError`

The core service should live in the core/storage/testkit boundary rather than inside a specific adapter. A reasonable shape is:

- `HostedSandboxService`: validates a job, applies policy, invokes an executor, maps lifecycle events, records metrics/log payloads, and returns a result.
- `HostedSandboxPolicy`: deny-by-default command and capability policy.
- `FakeHostedSandboxExecutor`: deterministic no-spend executor used by R14 and all required tests.
- `HostedSandboxTranscript`: redacted transcript/artifact formatter for stdout, stderr, PTY frames, lifecycle events, and resource-limit events.

The hosted worker may construct this substrate and expose it to future adapter wiring internally, but the only runtime adapter registered in the hosted worker remains `FakeRuntimeAdapter`. R14 must add tests proving the worker still does not import real adapters, `child_process`, `node-pty`, shell/browser/fetch/GitHub/repo tools, or `@switchyard/adapters` for hosted execution.

The fake executor simulates process/PTY behavior from typed scenarios. It must not call OS commands. It should produce output frames and artifacts from fixture data, deterministic clocks, and explicit scenario ids. The scenarios should include at least: success with stdout/stderr, success with no output, nonzero exit, policy denial, timeout, cancellation before start, cancellation while running, output truncation, artifact truncation, secret redaction, and fake PTY resize/input echo.

## User-Visible Behavior

- Operator/developer verification: running the R14 test/smoke command proves the hosted worker can construct the sandbox substrate, deny unsafe jobs, execute deterministic fake jobs, capture output/artifacts, and report named failures without external spend.
- Hosted fake worker behavior: existing hosted `fake.deterministic` runs continue to complete. No new hosted real runtime becomes runnable from `POST /runs`.
- Denied hosted real runtime: requests for hosted `codex.exec_json`, `claude_code.sdk`, `opencode.acp`, generic process, PTY, browser, search, fetch, GitHub, repo, or real tools still fail with the existing hosted placement/allowlist errors before any sandbox job is created.
- Sandbox diagnostics: when the fake sandbox substrate is exercised by tests or future internal callers, lifecycle logs and metrics use sandbox job ids, run ids, command ids, statuses, and named reason codes only. They do not log raw env values, secrets, full stdin, full stdout, full stderr, or artifact content.
- Artifact capture: successful, failed-after-start, cancelled, and timeout fake sandbox jobs can produce transcript artifacts through the existing artifact content store. Artifact metadata includes safe fields such as sandbox job id, command id, exit code, truncation flags, byte counts, content type, `storageBackend`, `objectKey`, `sizeBytes`, and `sha256`.
- No product overclaim: docs and release notes must state that R14 creates a fake/no-spend safety substrate only. It is not a production sandbox and does not make arbitrary hosted code execution safe.

## Sandbox And Policy Contract

### Job Request

R14 sandbox requests should be typed, serializable, and generated by trusted Switchyard code, not passed through from public users as arbitrary shell commands.

Required fields:

- `jobId`: Switchyard id, generated before policy evaluation.
- `runId`: optional link to a Switchyard run.
- `runtimeMode`: optional runtime mode slug for future adapter association.
- `adapterType`: `process` or `pty`.
- `commandId`: a symbolic command id. R14 fake ids are not OS commands.
- `argv`: string array, default `[]`, max 32 entries, max 256 bytes per entry.
- `cwd`: declared workspace path, must be absolute, normalized, and used only as metadata by the fake executor in R14.
- `env`: record of explicit env vars, default `{}`, max 32 keys. Values are never inherited from `process.env` in R14.
- `stdin`: optional string input, max 64 KiB, redacted in logs unless marked safe.
- `pty`: optional for `adapterType: "pty"` with `cols` 20-240, `rows` 5-80, and input frames with bounded byte sizes.
- `resourceLimits`: required or defaulted by config.
- `artifactPolicy`: transcript and artifact capture options.
- `createdAt`: ISO timestamp.

### Allowlist

R14 should allow only deterministic fake command ids:

- `switchyard.fake.echo`
- `switchyard.fake.stderr`
- `switchyard.fake.exit`
- `switchyard.fake.sleep`
- `switchyard.fake.artifact`
- `switchyard.fake.output_flood`
- `switchyard.fake.pty_echo`

Every other command id is denied before execution with `sandbox_command_denied`.

The policy must explicitly deny common real-command and runtime ids even if they are passed as strings:

- `sh`, `bash`, `zsh`, `fish`, `cmd`, `powershell`, `pwsh`
- `node`, `python`, `python3`, `ruby`, `perl`, `go`, `cargo`, `npm`, `pnpm`, `yarn`
- `codex`, `claude`, `opencode`, `git`, `gh`, `curl`, `wget`, `ssh`, `scp`
- `browser`, `web_search`, `fetch`, `repo`, `github`, `shell`

### Policy Decision

Policy returns one of:

- `allow`: fake command id is allowed and resource limits are valid.
- `deny`: no execution; result has `status: "failed"` and named reason.
- `requires_approval`: reserved for future real-runtime phases; R14 must not produce this decision for sandbox jobs.

Policy traces must be redacted with the existing secret-key pattern plus sandbox-specific redaction for env, stdin, argv entries marked secret, bearer-like strings, URLs with userinfo/query secrets, and object-store signed material.

### Data Flow Shadow Paths

| Flow | Happy path | Nil path | Empty path | Error path |
|---|---|---|---|---|
| Sandbox job request -> validation -> policy decision | Complete fake request validates and is allowed. | Missing request object fails with `sandbox_request_missing`. | Present request with empty `commandId`, empty `cwd`, or non-object env fails with `sandbox_request_invalid`. | Schema/normalization error fails before execution with `sandbox_request_invalid` and redacted details. |
| Policy decision -> executor dispatch | Allowed fake command dispatches to `FakeHostedSandboxExecutor`. | Missing policy decision is treated as internal `sandbox_policy_missing`. | Empty allowlist denies with `sandbox_command_denied`. | Policy service throw maps to `sandbox_policy_failed`; no executor call occurs. |
| Fake executor -> output events -> transcript | Fake command emits bounded stdout/stderr/PTY frames and terminal result. | No output generator yields completed result with empty transcript metadata. | Empty stdout/stderr are preserved as zero-byte counts without false failure. | Executor scenario failure maps to `sandbox_process_failed` or a more specific named error. |
| Runtime cancellation/timeout -> terminal result | Cancel during running fake job emits `cancelled`; timeout emits `timeout`. | Cancel for missing job returns `sandbox_job_not_found` to internal caller. | Cancel after terminal is idempotent and returns the terminal result. | Executor cancellation failure maps to `sandbox_cancel_failed` and the run/job is made terminal. |
| Transcript/artifact capture -> artifact store | Transcript writes through configured artifact content store and metadata includes digest/size. | No artifact store configured in local unit tests returns result with `contentStored: false`. | Empty transcript writes a valid zero-frame transcript when capture is enabled. | Write/read/digest failures keep named object-store/artifact errors and do not leak content. |

## Resource Limits

R14 limits are enforced by contract and fake executor behavior. They do not claim kernel-level CPU or memory isolation.

Default limits:

| Limit | Default | Max in R14 | Behavior on breach |
|---|---:|---:|---|
| `wallTimeMs` | `30000` | `120000` | Executor cancels and returns `sandbox_timeout`. |
| `stdoutBytes` | `65536` | `1048576` | Truncate stream, set `stdoutTruncated=true`, continue unless command requires strict output. |
| `stderrBytes` | `65536` | `1048576` | Truncate stream, set `stderrTruncated=true`, continue. |
| `combinedOutputBytes` | `131072` | `1048576` | Stop output capture and return `sandbox_output_limit_exceeded` if command keeps emitting. |
| `artifactBytes` | `1048576` | `1048576` | Refuse artifact with `sandbox_artifact_too_large`. |
| `stdinBytes` | `65536` | `65536` | Reject request with `sandbox_stdin_too_large`. |
| `argvCount` | `32` | `32` | Reject request with `sandbox_argv_too_large`. |
| `argvEntryBytes` | `256` | `256` | Reject request with `sandbox_argv_too_large`. |
| `envKeys` | `32` | `32` | Reject request with `sandbox_env_too_large`. |
| `envValueBytes` | `4096` | `4096` | Reject request with `sandbox_env_too_large`. |
| `ptyCols` | `80` | `240` | Reject request with `sandbox_pty_invalid`. |
| `ptyRows` | `24` | `80` | Reject request with `sandbox_pty_invalid`. |
| `cpuMs` | `1000` | `10000` | Declaration only in R14; fake executor can simulate `sandbox_cpu_limit_exceeded`. |
| `memoryMiB` | `256` | `1024` | Declaration only in R14; fake executor can simulate `sandbox_memory_limit_exceeded`. |

Configuration should allow tightening defaults for tests and local hosted worker runs:

- `SWITCHYARD_SANDBOX_ENABLED`: default `true` in `local`/`test`; required explicit in `staging`/`production` once real runtimes ship. In R14, `false` should make internal sandbox execution fail with `sandbox_disabled`.
- `SWITCHYARD_SANDBOX_DEFAULT_TIMEOUT_MS`
- `SWITCHYARD_SANDBOX_MAX_TIMEOUT_MS`
- `SWITCHYARD_SANDBOX_MAX_OUTPUT_BYTES`
- `SWITCHYARD_SANDBOX_MAX_ARTIFACT_BYTES`
- `SWITCHYARD_SANDBOX_FAKE_COMMAND_ALLOWLIST`

In R14 staging/production, the sandbox still remains fake-only. Enabling this config does not authorize real subprocess/PTY execution.

## Lifecycle And Observability

### Lifecycle States

Sandbox job lifecycle states:

- `created`
- `policy_denied`
- `starting`
- `running`
- `cancelling`
- `cancelled`
- `completed`
- `failed`
- `timeout`

State transitions must be monotonic. Terminal states are `policy_denied`, `cancelled`, `completed`, `failed`, and `timeout`. Cancellation after terminal is idempotent. Timeout after terminal is ignored. Artifact capture occurs only after start, cancellation, timeout, or failure-after-start; policy-denied jobs may emit a small metadata-only audit artifact only if the artifact policy says to preserve denied decisions.

### Events

R14 should avoid expanding public event types unless implementation requires it. Prefer existing events:

- `runtime.status` payloads for sandbox lifecycle transitions.
- `runtime.output` payloads for stdout, stderr, and PTY output frames.
- `artifact.created` for transcript/artifact capture.
- `run.failed`, `run.cancelled`, `run.completed` for run terminal state when a sandbox-backed future adapter uses the substrate.

Sandbox-specific internal lifecycle events may exist as typed contract objects, but if they are persisted to public run event streams they must be mapped into the existing public event types above.

### Logs

Required log names:

- `sandbox.policy.denied`
- `sandbox.job.started`
- `sandbox.job.output_truncated`
- `sandbox.job.artifact_captured`
- `sandbox.job.completed`
- `sandbox.job.failed`
- `sandbox.job.cancelled`
- `sandbox.job.timeout`
- `sandbox.redaction.applied`

Logs may include:

- `jobId`
- `runId`
- `runtimeMode`
- `adapterType`
- `commandId`
- `status`
- `reasonCode`
- `durationMs`
- byte counts
- truncation booleans

Logs must not include raw env values, secrets, raw stdin, full output, artifact content, signed URLs, object-store credentials, provider API keys, or unredacted argv entries marked secret.

### Metrics

Hosted metrics should add a low-cardinality `sandbox` group:

```json
{
  "sandbox": {
    "jobs": 0,
    "allowed": 0,
    "denied": 0,
    "completed": 0,
    "failed": 0,
    "timeout": 0,
    "cancelled": 0,
    "outputTruncated": 0,
    "artifactTruncated": 0,
    "redactions": 0
  }
}
```

Metric labels or keys must not contain command arguments, cwd, env keys/values, artifact paths with run-specific ids, endpoints, bucket names, user ids, tenant ids, prompts, or output text.

### Readiness

`/ready` should include a sandbox check in hosted server/worker contexts once the substrate is wired:

- `checks.sandbox.ok=true` when fake sandbox config is valid and at least one fake command is allowlisted.
- `checks.sandbox.ok=false, code="sandbox_disabled"` when internal sandbox execution is disabled.
- `checks.sandbox.ok=false, code="sandbox_policy_invalid"` when the fake allowlist is empty or contains non-fake command ids.
- `checks.sandbox.ok=false, code="sandbox_config_invalid"` when resource limits are invalid.

Readiness must not run real commands.

## Security And Redaction Requirements

- R14 must not introduce any hosted path that imports or calls `child_process.spawn`, `exec`, `fork`, `node-pty`, shell wrappers, browser automation, network fetch, GitHub clients, or repository filesystem tools.
- The fake sandbox executor must not inherit `process.env`. Any env in the request is explicit, bounded, redacted, and used only as fake metadata.
- Sandbox requests must reject shell strings. Commands are symbolic ids plus argv arrays; no shell parsing, interpolation, globbing, redirection, pipes, or command substitution.
- `cwd` is metadata only in R14, but it must still be absolute and normalized so future real execution cannot inherit unsafe path semantics.
- Secret redaction must apply recursively to env, argv metadata, stdin metadata, output metadata, policy traces, errors, logs, readiness diagnostics, metrics, events, and artifact metadata.
- Redaction keys include the existing pattern for `token`, `apiKey`, `authorization`, `password`, and `secret`, plus `credential`, `cookie`, `session`, `privateKey`, `accessKey`, `refreshToken`, and `idToken`.
- Redaction values must use a stable marker such as `[REDACTED]`; do not hash secrets into logs.
- Transcript content may contain user-like output from fake scenarios, so tests must include secret-looking strings and verify they are redacted before persistence.
- Artifact metadata must not include raw env, raw stdin, signed object-store material, provider credentials, full endpoint URLs with query/userinfo, or full output.
- Sandbox policy must fail closed. If validation, config, policy, executor construction, redaction, or artifact setup fails before execution, no fake executor should run.

## Failure Modes And Named Errors

Every failure path must use a named reason code. These codes should be represented in contracts or a closed local enum so tests can catch drift.

| Code | Trigger | User/operator visible behavior |
|---|---|---|
| `sandbox_disabled` | Sandbox substrate disabled by config. | Readiness fails for sandbox; internal caller receives failed result. |
| `sandbox_request_missing` | Internal caller passes nil request. | No execution; failed result with redacted details. |
| `sandbox_request_invalid` | Schema, cwd, adapter type, command id, argv, env, stdin, pty, or limit validation fails. | No execution; failed result with field-level details. |
| `sandbox_command_denied` | Command id is not in fake allowlist or matches a real command/tool/runtime. | No execution; policy trace says deny. |
| `sandbox_policy_invalid` | Configured fake allowlist contains non-fake command ids or is empty. | Readiness fails; no execution. |
| `sandbox_policy_failed` | Policy service throws unexpectedly. | No execution; failed result and error log. |
| `sandbox_policy_missing` | Executor dispatch is attempted without a policy decision. | Internal error path; no execution. |
| `sandbox_resource_limit_invalid` | Requested limits exceed configured max or are non-positive. | No execution; validation failure. |
| `sandbox_stdin_too_large` | Input exceeds 64 KiB. | No execution; validation failure. |
| `sandbox_argv_too_large` | Too many args or oversized arg. | No execution; validation failure. |
| `sandbox_env_too_large` | Too many env keys or oversized value. | No execution; validation failure. |
| `sandbox_pty_invalid` | PTY requested with invalid cols/rows/input frame. | No execution; validation failure. |
| `sandbox_process_failed` | Fake command simulates nonzero exit or process failure. | Terminal failed result; transcript preserved when enabled. |
| `sandbox_timeout` | Wall time limit expires. | Terminal timeout result; cancellation path invoked; transcript preserved. |
| `sandbox_cancelled` | Caller cancels before/during fake execution. | Terminal cancelled result; idempotent after terminal. |
| `sandbox_cancel_failed` | Executor fails to acknowledge cancellation. | Terminal failed result with reason code. |
| `sandbox_output_limit_exceeded` | Output exceeds combined limit after truncation policy. | Failed result or completed with truncation according to command policy; metric increments. |
| `sandbox_artifact_too_large` | Fake artifact exceeds artifact limit. | Artifact rejected; job fails unless artifact is optional. |
| `sandbox_artifact_capture_failed` | Artifact content store write fails with non-object-store error. | Job terminal result includes named failure; content not leaked. |
| `sandbox_redaction_failed` | Redaction utility throws or detects unserializable data. | Fail closed before persistence. |
| `sandbox_job_not_found` | Cancellation/inspection for unknown internal job id. | Internal caller gets named miss; no public 404 route in R14. |
| `hosted_runtime_not_allowed` | Existing hosted worker receives non-fake runtime. | Existing placement/worker denial remains unchanged. |
| `object_store_write_failed` | Existing artifact content store write failure. | Existing object-store error mapping preserved. |
| `artifact_digest_mismatch` | Existing artifact read integrity check fails. | Existing artifact error mapping preserved. |

## Test And Smoke Requirements

R14 is not complete unless normal CI remains deterministic, no-spend, and no-network by default.

Required unit coverage:

- Contract validation for `SandboxJobRequest`, `SandboxResourceLimits`, `SandboxJobResult`, lifecycle states, and named errors.
- Policy allow/deny tests for every fake command id and denied real command id listed in this spec.
- Nil, empty, and invalid request tests for each meaningful field: request object, command id, argv, cwd, env, stdin, pty, resource limits, and artifact policy.
- Redaction tests for env, argv metadata, stdin metadata, stdout, stderr, PTY frames, errors, policy traces, logs, events, and artifact metadata.
- Fake executor tests for success, empty output, stderr output, nonzero exit, output flood/truncation, artifact capture, artifact too large, timeout, cancellation before start, cancellation during running, cancellation after terminal, and fake PTY input/resize.
- Resource-limit tests proving default limits, max limits, config override parsing, and invalid config failures.
- Lifecycle monotonicity tests proving terminal states cannot be overwritten by late output, late timeout, late cancel, or late artifact writes.
- Artifact tests proving transcripts are written through the existing artifact content store, include digest/size metadata, handle empty transcript, and preserve named errors on write failure.

Required integration coverage:

- Hosted worker construction includes the fake sandbox substrate but still registers only `FakeRuntimeAdapter`.
- Existing hosted fake run test still passes with `placement: "hosted"` and `fake.deterministic`.
- Hosted worker still denies durable `codex.exec_json`, `claude_code.sdk`, `opencode.acp`, `generic_http.async_rest`, `agentfield.async_rest`, `process`, `pty`, browser, search, fetch, GitHub, repo, and shell requests before execution.
- Static test scans hosted worker and hosted sandbox files to ensure no real process/PTY/browser/network execution imports are present in R14.
- `/ready` reports sandbox ok/failure states without running real commands.
- `/metrics` includes sandbox counters without high-cardinality labels or secret-bearing fields.

Required smoke coverage:

- A no-spend sandbox smoke should exercise the fake executor end to end and prove: allowed fake job completes, denied real command fails before execution, timeout becomes terminal, cancellation is idempotent, transcript artifact is captured and redacted, and metrics/readiness reflect outcomes.
- The smoke must run without Docker, AWS, R2, model providers, browser binaries, GitHub tokens, shell commands, or real subprocess execution.
- Optional self-hosted smoke may include the sandbox readiness check in the existing compose-backed path, but Docker availability must not be required for normal CI.

## Docs And Product Updates Required

When R14 ships, update:

- `PRODUCT.md`
  - Move "fake/no-spend hosted sandbox substrate for future process/PTY jobs" into current truth.
  - Keep "arbitrary hosted subprocess/PTY execution", "production sandboxing for arbitrary subprocess/PTY workloads", "hosted Codex/Claude/OpenCode", "generic process adapter", and "PTY adapter" in not-shipped truth.
  - Fix the snapshot source if it still points at an older phase while describing newer capability.
- `ARCHITECTURE.md`
  - Add the hosted sandbox substrate as a safety layer between hosted worker and future process/PTY adapters.
  - State that R14 uses only a fake executor and no kernel/container sandbox.
- `docs/development/DEVELOPMENT.md`
  - Add the deterministic no-spend R14 sandbox test/smoke command.
  - Document the readiness/metrics fields added for sandbox status.
- `docs/development/API.md`
  - Update only if implementation changes public readiness/metrics shape or error-code contract. Do not document a public sandbox execution API because R14 must not add one.
- `CHANGELOG.md`
  - Add a release entry that says R14 shipped the fake hosted sandbox safety substrate, not real hosted execution.
- `packages/contracts/openapi.local-daemon.json`
  - Regenerate only if public contracts change.

## Acceptance Criteria

- [ ] A typed hosted sandbox contract exists for fake process-like and PTY-like jobs, resource limits, lifecycle events, results, artifacts, policy decisions, and named errors.
- [ ] Sandbox policy is deny-by-default and allows only deterministic fake command ids.
- [ ] Real command/tool/runtime ids are explicitly denied before execution.
- [ ] The R14 fake executor performs deterministic no-spend stdout/stderr/PTY/artifact/failure/timeout/cancel scenarios without OS process execution.
- [ ] Resource limits are validated and enforced in fake execution behavior, including output/artifact truncation or named failure.
- [ ] Logs, metrics, events, policy traces, errors, and artifact metadata are redacted and bounded.
- [ ] Timeout and cancellation produce terminal, idempotent lifecycle outcomes and preserve transcripts when capture is enabled.
- [ ] Hosted worker still registers only the fake runtime adapter and still rejects hosted real runtimes before execution.
- [ ] `/ready` and `/metrics` include sandbox diagnostics/counters without running real commands or leaking secrets.
- [ ] Existing hosted fake run behavior remains backward compatible.
- [ ] Normal CI and smoke coverage are no-spend and deterministic.
- [ ] Product docs are updated to describe the fake substrate accurately and keep real hosted execution out of scope.

## Phase

### Phase 13: R14 Hosted Sandbox Substrate For Process/PTY

**Goal:** Add the fake/no-spend hosted sandbox safety substrate and verification contracts needed before R15 real hosted runtime wiring.

**Acceptance:**

- Deny-by-default sandbox policy, fake executor, resource-limit contracts, lifecycle mapping, redacted transcript/artifact capture, readiness/metrics, and deterministic tests ship together.
- Hosted worker remains fake-only for actual hosted run execution.
- No public arbitrary-execution API or real hosted runtime ships.

**Non-goals (this phase):** real subprocess/PTY execution, hosted Codex/Claude/OpenCode, real tools, production kernel/container sandboxing, managed hosted platform, enterprise controls, dashboard, and TUI.

**Complexity:** L

## Future Roadmap Ordering After R14

R14 should unblock the next hosted-runtime work, but it does not make that work safe by itself. Recommended ordering:

1. **R15: Hosted real-runtime pilot behind sandbox substrate.** Wire one real hosted runtime path first, preferably the narrowest non-interactive process path, behind explicit opt-in config, stronger isolation, and the R14 policy/resource/artifact contracts. Codex/Claude/OpenCode should not all ship at once.
2. **R16: Hosted interactive session, resume, and approval bridge.** Add runtime-specific approval bridges and session resume only after the hosted real-runtime pilot proves terminal lifecycle, artifacts, cancellation, and policy enforcement.
3. **R17: Real tools behind policy.** Add shell/browser/search/fetch/GitHub/repo tools one by one with approval policy, audit trails, evidence capture, and sandbox/network restrictions.
4. **R18: Hosted debate with real runtimes and model judging.** Reuse real hosted runtime controls and tool policy rather than creating a parallel debate execution path.
5. **R19: Enterprise tenant controls.** Add organizations, RBAC, tenant quotas, billing, audit retention, and secrets management after runtime/tool blast radius is understood.
6. **R20: Managed hosted deployment.** Add managed production deployment, cloud networking, operational runbooks, and tenant isolation once the worker/sandbox/runtime boundary is mature.
7. **R21: Dashboard/TUI.** Build visual operations surfaces after the underlying hosted/runtime/tool states are trustworthy and stable.

## Risks

- A fake substrate can create false confidence if docs or code imply production sandboxing. Mitigation: name it fake/no-spend throughout product docs and keep arbitrary execution blocked.
- If the contract is too process-specific, PTY and interactive runtime work may fork later. Mitigation: include PTY frames and terminal dimensions now, but keep fake implementation small.
- If policy and resource limits live only in adapter code, future runtimes may bypass them. Mitigation: put policy and limits in shared contracts/core service and require hosted adapters to call it.
- Redaction gaps are easy to miss in transcripts and artifacts. Mitigation: make secret-looking fixture strings part of normal tests across logs, events, metrics, and artifact metadata.
- Adding public APIs in R14 would invite arbitrary-exec misuse. Mitigation: no public sandbox execution route in this phase.
