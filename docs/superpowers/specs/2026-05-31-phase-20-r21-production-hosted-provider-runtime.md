# Phase 20 / R21: Production Hosted Provider Runtime Activation

**Date:** 2026-05-31
**Run:** `post-r11-remaining-20260530`
**Branch:** `agent/phase-20-r21-production-hosted-provider-runtime`
**Base commit:** `43bad60` (`docs: close phase 19 r20 product truth (R20 audit-green)`)
**Spec target:** `docs/superpowers/specs/2026-05-31-phase-20-r21-production-hosted-provider-runtime.md`

## Problem

Switchyard now has a production-operable hosted stack for fake-only execution from R19 and an internal worker-only subprocess/PTY sandbox substrate from R20. The remaining release gap is that production hosted real-runtime execution is still forbidden, even for the known provider modes that already have local and self-hosted/staging adapter paths.

R21 activates production hosted provider execution for self-hosted operators only, and only for the closed known provider modes `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`. The default production posture remains fake-only and disabled for real runtimes. Production real-runtime execution becomes allowable only when an operator supplies explicit env opt-in, a closed runtime allowlist, provider-specific command policy, readiness/preflight proof, provider credentials, and spend controls.

## Priority Rationale

R20 made the worker-side execution substrate explicit and fail-closed. That makes R21 the next useful public-release gap to close because operators can now safely choose known hosted provider runtimes without exposing arbitrary process APIs or adding dashboard/TUI work.

- R21 converts the existing R15 self-hosted/staging real-runtime path into a production-safe operator-owned path.
- The work directly depends on R19 production deployment readiness and R20 worker execution policy.
- It preserves the public API boundary: users still create normal runs; no public shell, PTY, sandbox, command, or terminal route is introduced.
- It avoids adapter sprawl by activating only known modes with existing semantics: Codex exec-json, Claude Code, and OpenCode ACP.
- It gives operators rollback and preflight proof before any provider spend or queue claim happens.

## Scope Decision

Production hosted real-runtime execution is allowed after R21 only when all of these are true:

- `SWITCHYARD_DEPLOYMENT_MODE=production`.
- `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`.
- `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` contains only `fake.deterministic` plus an explicit subset of `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
- A provider runtime policy is configured for every real hosted runtime in the allowlist.
- Provider command resolution is operator-owned and immutable before adapter start: no request-owned executable, cwd, env, argv, binary path, shell string, PTY, terminal, or process-factory value is trusted.
- Production preflight passes before deploy.
- Server `/ready` and worker claim readiness both pass after deploy.
- Provider credential presence, redacted configuration summaries, and spend controls pass.
- The operator runs the no-spend R21 hosted provider smoke in CI/audit and a provider-specific production canary before routing real traffic to that provider mode.

If any gate fails, Switchyard must fail closed with a named reason code before durable side effects when possible, before queue claim when already queued, and before adapter process start in all cases.

## Goals

- Allow production hosted execution for exactly three known provider modes: `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
- Keep `fake.deterministic` as the default and only automatically safe production hosted runtime.
- Preserve explicit hosted placement for real modes. Real hosted runtimes must never be selected by implicit placement inference.
- Replace current production forbids with stricter allow rules: opt-in env, closed allowlist, provider policy, credential presence, spend controls, preflight, readiness, and adapter checks.
- Reuse the R20 policy-resolved command handoff shape for provider subprocesses where applicable, without weakening the generic sandbox denylist or exposing generic process/PTY adapters.
- Keep provider process construction worker-owned and provider-specific.
- Make Codex production hosted execution read-only by default and deny request metadata that attempts to inject sandbox, command, PTY, terminal, cwd, argv, env, or process details.
- Keep Claude Code production hosted execution in read-only permission mode with `Bash`, `WebFetch`, and `WebSearch` disabled unless a later phase explicitly adds hosted tool policy.
- Keep OpenCode ACP production hosted execution one-prompt-per-run with no hosted terminal bridge, no hosted approval bridge, and visible failure for unsupported permission/input states.
- Add operator preflight/readiness/canary/smoke coverage for production provider runtime activation.
- Add rollback behavior that lets operators return to fake-only production by changing env/config and restarting server/worker.
- Preserve no dashboard/TUI and no public arbitrary execution APIs.
- Preserve tenant entitlement, quota, audit, metrics, and artifact ownership behavior for hosted real runs.

## Non-Goals

- No dashboard.
- No TUI.
- No public `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` APIs.
- No generic process runtime adapter.
- No generic PTY runtime adapter.
- No request-owned executable, cwd, env, argv, binary path, shell string, PTY config, terminal config, or process factory.
- No Cursor, OpenClaw, or Paperclip.
- No hosted browser, hosted search, hosted GitHub, hosted fetch, hosted repo, or hosted shell tools.
- No hosted or connected-node real tools. The R17 real-tool surface remains local-daemon only.
- No Generic HTTP or AgentField hosted production activation in R21.
- No `codex.interactive` hosted production activation.
- No hosted post-start input bridge.
- No hosted runtime approval bridge.
- No hosted terminal bridge.
- No hosted debate with real participants.
- No hosted model judging.
- No managed SaaS/public signup, payment provider integration, OAuth/OIDC/SAML/SSO/SCIM, public tenant self-service, or dashboard-based operator controls.
- No live provider calls in normal CI/audit tests. Live provider canaries are operator-run and must require explicit spend confirmation.
- No claims of OS/container/microVM isolation beyond what the code actually enforces and tests.

## Existing Context

`PRODUCT.md` currently records the R20 baseline and explicitly says production hosted real-runtime execution remains forbidden:

```md
Current product state: local daemon with shipped runtime modes `fake.deterministic`, `claude_code.sdk`, `codex.exec_json`, `codex.interactive`, `agentfield.async_rest`, `generic_http.async_rest`, and `opencode.acp`; shipped local middleware APIs for messages, memory, evidence, context packets, approvals, and fake tool invocations; shipped local deterministic Debate V1; shipped hosted-like worker execution for the fake-only boundary plus an internal worker sandbox substrate; shipped SDK/CLI/OpenAPI packaging and hardening; shipped self-hosted staging foundation for hosted/connected-node slice; shipped S3/R2-compatible object-store client wiring for hosted artifact content; shipped the R18 API-first hosted/server enterprise control-plane foundation; shipped R19 production hosted deployment readiness (provider-neutral production manifest pack, fail-closed production preflight/migration gates, explicit schema/readiness diagnostics, and deterministic no-spend production canary); and shipped R20 internal production subprocess/PTY sandbox foundation plus production ops gates (policy-first worker substrate, fail-closed readiness, deterministic no-spend production sandbox smoke). Hosted provider execution remains unshipped and production-forbidden in current product truth.
```

`packages/core/src/services/hosted-runtime-catalog.ts` already has a closed catalog containing only fake plus the three known hosted real modes. R21 must keep this closed set and change production rules without adding generic runtime expansion:

```ts
export type HostedRuntimeModeSlug = "fake.deterministic" | "codex.exec_json" | "claude_code.sdk" | "opencode.acp";
export type HostedDeploymentMode = "local" | "test" | "staging" | "production";
export type HostedRealRuntimeExecution = "enabled" | "disabled";
```

The same catalog currently marks the real modes as production-forbidden. R21 must replace this with production-conditional support, not unconditional support:

```ts
"codex.exec_json": {
  runtimeModeSlug: "codex.exec_json",
  runtime: "codex",
  provider: "openai",
  adapterId: "codex",
  adapterType: "process",
  kind: "one_shot_process",
  hostedSupport: "conditional",
  requiresRealRuntimeGate: true,
  productionAllowed: false,
```

Current production config validation still forces fake-only allowlists and rejects the real-runtime gate in production:

```ts
if (config.deploymentMode === "production") {
  enforceProductionValidation(validateProductionFakeOnlyAllowlist(config.hostedRuntimeAllowlist), config);

  if (config.hostedRealRuntimeExecution !== "disabled") {
    throw new ConfigError(
      "config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
      "SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION",
      buildSummary(config)
    );
  }
}
```

The worker adapter factory already constructs provider adapters for the three known modes, but explicitly disables them in production. R21 must remove that blanket production block and replace it with provider-specific policy checks:

```ts
function shouldEnableRealMode(config: WorkerConfig, mode: HostedRuntimeModeSlug): boolean {
  if (!isRealHostedRuntimeMode(mode)) {
    return true;
  }
  if (config.deploymentMode === "production") {
    return false;
  }
  if (config.hostedRealRuntimeExecution !== "enabled") {
    return false;
  }
  return config.hostedRuntimeAllowlist.includes(mode);
}
```

R20 introduced the deny-by-default sandbox policy and immutable resolved-command handoff. R21 must reuse the handoff pattern for provider subprocess construction where applicable, while keeping generic sandbox execution denied for provider binaries:

```ts
const resolvedCommand: SandboxResolvedCommand = {
  commandId: policy.commandId,
  adapterType: policy.adapterType,
  executablePath: policy.executablePath,
  argv,
  cwd: input.request.cwd,
  env: { ...input.request.env },
  allowStdin: policy.allowStdin,
  allowPtyInput: policy.allowPtyInput,
  isolation: policy.isolation,
  networkPolicy: policy.networkPolicy
};
```

The R20 sandbox contract intentionally denylists direct generic command ids and common provider executable names:

```ts
export const SANDBOX_REAL_COMMAND_DENYLIST = [
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "go",
  "cargo",
  "npm",
  "pnpm",
  "yarn",
  "codex",
  "claude",
  "opencode",
  "git",
  "gh",
  "curl",
  "wget",
  "ssh",
  "scp",
  "browser",
  "web_search",
  "fetch",
  "repo",
  "github",
  "shell"
]
```

Production manifests are currently fake-only. R21 must update the production manifest pack only as an operator opt-in example, with fake-only remaining the example default:

```json
"policy": {
  "runtimeAllowlist": ["fake.deterministic"],
  "hostedRealRuntimeExecution": "disabled",
  "objectStoreProbe": "write_read_delete",
  "sandboxExecution": {
    "realExecution": "disabled",
    "commandPolicy": "required_when_enabled",
    "networkPolicy": "disabled"
  }
}
```

Existing entitlement checks already have a hosted-real-runtime control and runtime-mode allowlist. R21 must preserve these checks and add provider spend controls around them:

```ts
if (input.placement === "hosted" && isRealHostedRuntimeMode(input.runtimeMode) && !entitlement.allowHostedRealRuntime) {
  throw new ControlPlaneError("entitlement_denied", "hosted_real_runtime_disabled");
}
if (input.timeoutSeconds > entitlement.maxRunTimeoutSeconds) {
  throw new ControlPlaneError("quota_exceeded", "run_timeout_exceeded");
}
```

## Architecture

R21 keeps Switchyard's public run API shape unchanged. Hosted real-runtime activation is a server/worker/operator-control feature, not a new public execution API. A user still creates a run with `placement: "hosted"` and one of the known runtime mode slugs. The server performs control-plane entitlement/quota checks, hosted placement checks, runtime allowlist checks, provider activation checks, and queue enqueue. The worker revalidates the queued run, resolves provider command policy, checks provider credentials and adapter readiness, then starts the provider adapter.

The R21 provider runtime policy is a closed worker/server config contract. It must not accept request-supplied executable paths, cwd prefixes, env values, argv, command ids, process factories, terminal settings, or PTY settings. For subprocess-backed provider modes, the policy resolver should produce an immutable command handoff derived only from operator config and the run's already-validated runtime mode. This handoff may reuse `SandboxResolvedCommand` where the existing R20 type fits. Where provider execution needs semantics the generic sandbox contract deliberately does not expose, such as model-provider network egress, R21 must keep a provider-specific resolver rather than widening the generic sandbox policy or generic process/PTY product surface.

Codex, Claude Code, and OpenCode stay provider-specific. `codex.exec_json` maps to the Codex exec-json adapter and remains one-shot with no hosted post-start input. `claude_code.sdk` maps to the Claude Code adapter in read-only permission mode with dangerous tools disabled. `opencode.acp` maps to the OpenCode ACP adapter with no hosted terminal, input, or approval bridge. Any unsupported provider prompt state that would require a hosted bridge must terminalize visibly with a named reason and must not leave the run stuck in `waiting_for_input` or `waiting_for_approval`.

Operational state remains in existing stores: Postgres for run/event/artifact/control-plane metadata, Redis/BullMQ for hosted queueing, and configured object storage for artifact content. R21 adds provider activation checks to production preflight, server readiness, worker readiness, metrics, smoke, canary, and rollback docs. Metrics must stay low-cardinality: counts by runtime mode slug and reason code are allowed; raw commands, cwd, env, task text, provider output, object keys, and credentials are not.

## Provider Runtime Policy Contract

R21 should add a closed provider runtime policy config. Exact file names are CTO-owned, but the product contract is:

- The policy is optional when real runtime execution is disabled.
- The policy is required when production `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled` and any real runtime appears in `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`.
- Every allowlisted real runtime must have one enabled policy entry.
- Unknown runtime keys fail with `provider_runtime_policy_unknown_mode`.
- Missing entries fail with `provider_runtime_policy_missing`.
- Empty entries fail with `provider_runtime_policy_empty`.
- Malformed JSON fails with `provider_runtime_policy_malformed`.
- Disabled entries for allowlisted runtimes fail with `provider_runtime_policy_disabled`.
- Policy cannot include raw secret values. It may name required env vars and credential profiles only.
- Policy cannot include request-derived command fields.
- Policy must include provider spend controls or point to an existing entitlement/quota profile that enforces them.

Minimum logical shape:

```json
{
  "codex.exec_json": {
    "enabled": true,
    "executablePath": "/usr/local/bin/codex",
    "cwdPrefixes": ["/srv/switchyard/work"],
    "envAllowlist": ["HOME", "PATH", "CODEX_HOME", "OPENAI_API_KEY"],
    "requiredEnv": ["OPENAI_API_KEY"],
    "fixedArgs": ["exec", "--json"],
    "allowUserArgs": false,
    "spendControls": {
      "maxActiveRuns": 2,
      "maxRunsPerHour": 20,
      "maxRunTimeoutSeconds": 300,
      "maxPromptBytes": 60000
    }
  },
  "claude_code.sdk": {
    "enabled": true,
    "executablePath": "/usr/local/bin/claude",
    "cwdPrefixes": ["/srv/switchyard/work"],
    "envAllowlist": ["HOME", "PATH", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"],
    "requiredEnv": ["ANTHROPIC_API_KEY"],
    "permissionMode": "read_only",
    "disabledTools": ["Bash", "WebFetch", "WebSearch"],
    "spendControls": {
      "maxActiveRuns": 1,
      "maxRunsPerHour": 10,
      "maxRunTimeoutSeconds": 300,
      "maxPromptBytes": 60000
    }
  },
  "opencode.acp": {
    "enabled": true,
    "executablePath": "/usr/local/bin/opencode",
    "cwdPrefixes": ["/srv/switchyard/work"],
    "envAllowlist": ["HOME", "PATH", "OPENCODE_CONFIG_DIR"],
    "requiredEnv": [],
    "spendControls": {
      "maxActiveRuns": 2,
      "maxRunsPerHour": 20,
      "maxRunTimeoutSeconds": 300,
      "maxPromptBytes": 60000
    }
  }
}
```

This JSON is illustrative of the contract. Implementation can split it into env vars, a JSON file, or typed config helpers, but the resulting behavior must match the fields and failures above.

## User-Visible Behavior

### Scenario 1: Default Production Remains Fake-Only

An operator deploys production with the existing default:

```text
SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic
SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled
```

Expected behavior:

- `fake.deterministic` hosted runs continue to work.
- Creating a hosted `codex.exec_json`, `claude_code.sdk`, or `opencode.acp` run returns `409 placement_denied` or `hosted_runtime_not_allowed` before durable run/queue side effects.
- Worker readiness passes only for fake hosted execution.
- No provider adapters are constructed.
- `/ready` reports hosted runtime gate healthy for fake-only mode.

### Scenario 2: Operator Enables Production Codex

The operator sets:

```text
SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic,codex.exec_json
SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled
```

and supplies a valid provider policy entry for `codex.exec_json`, required credentials, and spend controls.

Expected behavior:

- `production:preflight` passes provider runtime policy, credential presence, spend controls, adapter check, hosted runtime gate, object store, queue, schema, and control-plane checks.
- Server `/ready` includes passing provider runtime diagnostics for `codex.exec_json`.
- Worker claim readiness includes passing provider adapter and provider policy checks before claiming jobs.
- `POST /runs` with explicit `placement: "hosted"` and `runtimeMode: "codex.exec_json"` enqueues the run.
- The worker revalidates the queued run, resolves the operator-owned Codex command handoff, starts the Codex adapter, writes normalized events and bounded artifacts, and completes/fails the run visibly.
- `POST /runs?wait=1` remains denied for hosted real modes with `hosted_wait_unsupported`.
- `POST /runs/:id/input` remains unsupported for `codex.exec_json`.

### Scenario 3: Missing Provider Policy

The operator enables real runtime execution and allowlists `claude_code.sdk`, but does not configure a Claude provider policy.

Expected behavior:

- Server and worker config fail with `provider_runtime_policy_missing:claude_code.sdk`, or readiness fails with that code before traffic/queue claims.
- `production:preflight` emits `providerRuntimePolicy` failure and skips provider adapter checks.
- No worker starts Claude Code.
- No raw env, command, or cwd details appear in logs or readiness diagnostics.

### Scenario 4: Provider Binary Or Credential Not Available

The provider policy is present but the binary is missing, credentials are absent, or adapter check fails.

Expected behavior:

- Preflight fails with a named code such as `provider_binary_unavailable`, `provider_credentials_missing`, `adapter_check_failed`, `binary_version_unavailable`, `model_catalog_unavailable`, `live_probe_disabled`, or the adapter-specific reason.
- Worker readiness fails before claim with the same redacted diagnostics.
- If a run was queued before drift, claim revalidation fails the run and queue job with a named reason such as `hosted_runtime_adapter_unavailable` or `provider_credentials_missing`.
- Switchyard does not fall back to fake execution or local execution.

### Scenario 5: Unsupported Hosted Bridge State

An OpenCode ACP runtime emits a permission request, or Claude Code emits a state requiring hosted approval/input bridging that R21 does not ship.

Expected behavior:

- The run terminalizes as failed with a named reason such as `hosted_approval_bridge_unsupported`, `hosted_input_bridge_unsupported`, or the existing adapter-specific unsupported code.
- The run must not remain indefinitely in `waiting_for_input` or `waiting_for_approval`.
- Runtime approval records must not be created for hosted provider runs in R21.
- The event stream and artifacts show a redacted failure trail.

### Scenario 6: Rollback To Fake-Only

An operator needs to disable production provider execution.

Expected behavior:

- Setting `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled` and `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic`, then restarting server and worker, returns production to fake-only mode.
- New hosted real-runtime creates are denied before durable side effects.
- Already queued real hosted jobs fail closed at worker claim revalidation with `hosted_real_runtime_disabled` or `hosted_runtime_not_allowed`.
- Active provider subprocesses are allowed to finish, time out, or be cancelled through existing run cancellation semantics; rollback docs must tell operators to pause workers first when they need a hard stop.
- Metrics and audit events identify denied/failed real-runtime runs by runtime mode and reason code only.

## Data Flows And Shadow Paths

### Data Flow 1: Env And Provider Policy To Production Config

- Happy path: production env enables real runtime execution, allowlist contains only known modes, provider policy has entries for every real mode, credentials are present by env name, spend controls are bounded, and redacted config is emitted.
- Nil path: env var or provider policy is missing. Config/preflight fails with `config_required:*` or `provider_runtime_policy_missing` before server port binding, worker queue claiming, or adapter construction.
- Empty path: env var is whitespace, allowlist is empty, JSON file is empty, or policy entry has no fields. Config/preflight fails with `config_required:*`, `config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`, `provider_runtime_policy_empty`, or `provider_runtime_policy_malformed`.
- Error path: JSON parse fails, executable path is malformed, credential env is absent, spend controls are invalid, unknown runtime mode is present, or adapter check fails. Preflight/readiness returns the named reason, redacts diagnostics, and blocks runtime activation.

### Data Flow 2: Hosted Run Create To Queue Enqueue

- Happy path: authenticated operator/user has entitlement, quota, allowed placement, allowed runtime mode, `allowHostedRealRuntime=true`, explicit `placement: "hosted"`, and runtime mode in the production allowlist. Server creates run, ownership, placement record, quota reservation, audit event, and queue job.
- Nil path: `runtimeMode` is missing or cannot be inferred. Existing runtime-mode validation fails before hosted real placement.
- Empty path: `placement` or `runtimeMode` is an empty string. Request fails with `invalid_input` or `hosted_runtime_not_allowed`.
- Error path: entitlement denies hosted real runtime, quota is exhausted, runtime allowlist drifted, `wait=1` is used, or placement is not explicit. Server returns named `entitlement_denied`, `quota_exceeded`, `placement_denied`, `hosted_wait_unsupported`, or `hosted_explicit_placement_required` and releases any reservation already made.

### Data Flow 3: Queue Claim To Provider Adapter Start

- Happy path: worker readiness is green, queued run still matches its queue payload, runtime is allowlisted, real-runtime gate is enabled, provider policy resolves an immutable command handoff, provider credentials are present, adapter check passes, and the adapter starts.
- Nil path: run is missing from storage or queue payload lacks a run id. Worker fails the queue job with `hosted_run_state_invalid`.
- Empty path: provider policy has zero enabled entries or required env list is empty for a runtime that requires credentials. Worker fails readiness or claim with `provider_runtime_policy_empty` or `provider_credentials_missing`.
- Error path: run state changed before claim, provider policy denies cwd/env/argv, binary is unavailable, adapter throws, object store write fails, or timeout/cancel occurs. Worker writes terminal run state and events with named reason codes; queue ack/retry/fail semantics remain explicit.

### Data Flow 4: Provider Output To Events And Artifacts

- Happy path: adapter emits normalized runtime events; transcript artifacts are bounded, redacted, stored in the configured object store, and visible through existing artifact APIs.
- Nil path: provider exits successfully with no output. Run completes with `text: null`/empty outputs where the adapter contract allows it, and artifacts may be absent only if the adapter contract says no artifact was produced.
- Empty path: transcript artifact is empty. Empty artifact content must not be treated as a successful transcript unless the adapter declares no artifact; otherwise fail with `artifact_content_empty` or adapter-specific artifact failure.
- Error path: provider stream parse fails, output exceeds bounds, artifact write fails, credential leaks are detected, or raw provider error includes secrets. Switchyard terminalizes with `runtime_error`, `runtime_output_limit_exceeded`, `object_store_write_failed`, `sandbox_redaction_failed`, or adapter-specific named code and stores only redacted diagnostics.

### Data Flow 5: Preflight/Canary To Operator Decision

- Happy path: preflight passes, readiness passes, no-spend smoke passes, and an operator-run provider canary with explicit spend confirmation completes for each enabled runtime.
- Nil path: canary base URL, API key, or runtime mode is missing. Command exits nonzero with `provider_canary_config_missing`.
- Empty path: canary runtime list is empty. Command exits nonzero with `provider_canary_runtime_empty`.
- Error path: provider canary sees create denial, timeout, missing artifact, failed run, auth failure, quota failure, metrics auth failure, or audit ownership failure. Command exits nonzero with a named `provider_canary_*` code and redacted diagnostics.

## Functional Requirements

### FR1: Production Runtime Catalog Boundary

- Keep the hosted runtime catalog closed to exactly `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
- Mark `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` as production-conditional, not production-unconditional.
- Unknown hosted modes such as `generic_http.async_rest`, `agentfield.async_rest`, `codex.interactive`, `cursor`, `openclaw`, `paperclip`, `browser`, `fetch`, `github`, `repo`, `shell`, `process`, and `pty` must fail allowlist validation.
- `validateHostedRuntimeAllowlist` must permit production real modes only when `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled` and provider policy validation passes.
- Production with real modes in the allowlist and gate disabled must fail with `hosted_real_runtime_disabled`.
- Production with gate enabled and no real modes may pass but must not construct provider adapters.
- Production with real modes and missing provider policy must fail with provider policy reason codes.

### FR2: Provider Runtime Policy And Command Resolution

- Add provider-specific policy resolution for `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
- The provider resolver must derive executable path, fixed args, cwd prefixes, env allowlist, required env names, permission mode/tool restrictions, and spend controls from operator config only.
- Request body, run metadata, and queue payload must never supply executable path, cwd prefix, env values, argv, process factory, command id, shell string, PTY, terminal, or provider binary.
- For subprocess-backed provider modes, use the R20 resolved-command handoff pattern where applicable so adapter construction receives a prevalidated immutable command plan.
- Do not remove provider executable names from the generic sandbox denylist.
- Do not widen public sandbox command policy to make `codex`, `claude`, or `opencode` generic commands.
- If the R20 `SandboxResolvedCommand` type cannot represent a provider-specific requirement, implement a closed provider-resolved command type rather than broadening generic sandbox execution.
- Provider policy diagnostics must redact executable parent directories if they reveal home paths, all env values, object keys, tokens, cwd, task text, stdout, stderr, and raw provider output.

### FR3: Server-Side Admission

- Real hosted runtimes require explicit `placement: "hosted"`.
- Real hosted runtimes must reject `wait=1` before durable run/queue side effects with `hosted_wait_unsupported`.
- Real hosted runtimes must pass the existing control-plane checks:
  - `runs:write` scope.
  - placement entitlement includes `hosted`.
  - runtime-mode entitlement includes the requested mode.
  - `allowHostedRealRuntime=true`.
  - per-hour, active-run, and timeout quotas.
- Server placement denial must use existing HTTP envelopes and named reason codes.
- Server must not create queue jobs or run records when provider activation is denied before side effects.
- If side effects happen and a later server error occurs, existing quota release, ownership attach, audit, and terminalization cleanup must remain correct.

### FR4: Worker Claim Revalidation

- Worker claim readiness must run before queue claim in strict hosted production mode.
- Worker must revalidate queued run state, placement, runtime mode, allowlist, real-runtime gate, provider policy, and adapter readiness before adapter start.
- If production config drifts after enqueue, the worker must fail the run/job with `hosted_real_runtime_disabled`, `hosted_runtime_not_allowed`, `provider_runtime_policy_missing`, `provider_credentials_missing`, or another named reason.
- Worker must not retry permanently on policy/config denials. Retry is allowed for transient adapter/provider failures until existing queue retry limits are exhausted.
- Worker logs for claim accepted/denied must include run id, runtime mode, and reason code only.

### FR5: Provider-Specific Runtime Semantics

- `codex.exec_json`:
  - One-shot only.
  - No hosted post-start input.
  - No hosted interactive session.
  - No hosted approval bridge.
  - Read-only sandbox posture must be enforced or injected from trusted policy.
  - Deny metadata keys that attempt to set sandbox write access, command, binary, process factory, PTY, terminal, cwd, argv, args, env, or shell behavior.

- `claude_code.sdk`:
  - Worker-owned adapter only.
  - Read-only permission mode.
  - `Bash`, `WebFetch`, and `WebSearch` disabled for R21 production hosted execution.
  - No hosted runtime approval bridge.
  - No hosted post-start input bridge.
  - Live probe remains disabled by default unless operator explicitly enables it and spend controls permit it.

- `opencode.acp`:
  - Worker-owned ACP adapter only.
  - One prompt per hosted run.
  - No terminal bridge.
  - No hosted post-start input bridge.
  - No hosted approval bridge.
  - ACP permission requests fail visibly and terminally rather than waiting indefinitely.

### FR6: Readiness, Preflight, Canary, And Smoke

- `production:preflight` must add provider runtime checks when real modes are enabled:
  - hosted runtime gate.
  - provider runtime policy.
  - provider command resolution.
  - provider credential presence by env name.
  - provider spend controls.
  - adapter availability checks.
  - redaction scan for diagnostics.
- Server `/ready` must include provider runtime activation diagnostics when real modes are enabled.
- Worker readiness must include provider policy and adapter diagnostics before claim.
- Existing `hosted-real-runtime:smoke` must be extended or complemented so CI/audit can exercise production-mode gates with fake process/client factories and no live provider spend.
- Add an operator-run provider canary path that can target one runtime mode at a time in production. It must require explicit spend confirmation such as `--confirm-provider-spend` or an equivalent env flag.
- Provider canary must create a small tagged hosted run, wait for terminal state through existing APIs, read events, read artifact metadata/content when expected, verify metrics authorization, verify audit/ownership trace, and exit nonzero on named failures.
- Canary records are durable production evidence and must be discoverable by metadata/tag. R21 does not add delete APIs.

### FR7: Provider Spend Controls

- Production real runtime activation must require spend controls for every enabled real runtime.
- Minimum controls:
  - max active runs per runtime mode.
  - max runs per hour per runtime mode.
  - max run timeout seconds.
  - max prompt bytes.
  - optional provider live-probe budget, default disabled.
- Existing R18 entitlement/quota checks must remain enforced. Provider spend controls are additive and must not replace tenant quotas.
- Spend-control failures must be named, such as `provider_spend_controls_missing`, `provider_spend_controls_invalid`, `provider_spend_limit_exceeded`, or `provider_prompt_too_large`.
- Metrics must expose counts for provider runs accepted, denied, failed, timed out, cancelled, and spend-control-denied by runtime mode and reason code only.

### FR8: Credential Redaction And Secret Handling

- Provider credentials must come from operator-managed environment variables or mounted secret files, not from request bodies, run metadata, queue payloads, canary command arguments, or provider policy JSON values.
- Config summaries, readiness diagnostics, preflight output, logs, metrics, events, and artifacts must not include raw API keys, access tokens, bearer strings, secret file contents, object-store keys, signed URLs, env values, stdout/stderr containing credentials, or provider config directories containing user home paths.
- Existing hosted safe logger behavior must cover provider adapter logs in production.
- Redaction tests must include nested objects and provider-specific error payloads.

### FR9: Public API And Product Boundary

- Local and hosted OpenAPI must remain free of public `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, and `/sandbox` execution routes.
- No public generic process/PTY adapter appears in registry/runtime-mode APIs.
- No Cursor/OpenClaw/Paperclip/browser/search/GitHub/fetch/repo hosted tool modes appear as hosted production runtime modes.
- Debate APIs remain fake participant/model-judge only; hosted real participants and model judging remain unshipped.
- `PRODUCT.md` must be updated during implementation/phase close to say R21 ships production hosted provider runtime activation for the known providers only, with fake-only disabled-by-default posture preserved.

## Error Codes

R21 may reuse existing codes where exact, but must add or normalize these named failures as needed:

- `provider_runtime_policy_missing`
- `provider_runtime_policy_empty`
- `provider_runtime_policy_malformed`
- `provider_runtime_policy_unknown_mode`
- `provider_runtime_policy_disabled`
- `provider_command_policy_invalid`
- `provider_command_denied`
- `provider_binary_unavailable`
- `provider_credentials_missing`
- `provider_credentials_invalid`
- `provider_spend_controls_missing`
- `provider_spend_controls_invalid`
- `provider_spend_limit_exceeded`
- `provider_prompt_too_large`
- `hosted_runtime_adapter_unavailable`
- `hosted_approval_bridge_unsupported`
- `hosted_input_bridge_unsupported`
- `provider_canary_config_missing`
- `provider_canary_runtime_empty`
- `provider_canary_create_denied`
- `provider_canary_timeout`
- `provider_canary_run_failed`
- `provider_canary_artifact_missing`
- `provider_canary_metrics_failed`
- `provider_canary_audit_failed`

No new code may collapse these into generic "internal error" for expected operator/config/runtime failures.

## Constraints

- Production default remains fake-only with real runtime execution disabled.
- Normal CI/audit must stay no-spend and deterministic.
- Live provider canaries must be explicit operator actions.
- New checks must preserve existing local daemon behavior and local SDK/CLI workflows.
- All production checks must fail closed before server listen, worker claim, queue enqueue, adapter construction, or provider subprocess start when the failure is knowable at that stage.
- Provider subprocesses must use direct spawn or provider SDK/CLI client paths already used by adapters. No shell interpolation.
- Public API contracts must remain backward compatible except for newly allowed production hosted real-runtime creates under explicit operator config.
- No broad adapter registry expansion.
- No dashboard/TUI.
- No changes to root/current branch; R21 work stays on `agent/phase-20-r21-production-hosted-provider-runtime`.

## Acceptance Criteria

- [ ] Production config permits `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` only when `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`, allowlist is closed, provider policy is valid, credentials are present, and spend controls are valid.
- [ ] Production config still accepts fake-only defaults and does not construct provider adapters when real runtime execution is disabled.
- [ ] Unknown or out-of-scope hosted modes fail validation and readiness with named reason codes.
- [ ] Server admission denies hosted real runtime creates without explicit `placement: "hosted"` and denies `wait=1` before durable side effects.
- [ ] Existing entitlement, quota, ownership, audit, and reservation release behavior remains correct for hosted real runtimes.
- [ ] Worker claim revalidation blocks drifted, denied, or unavailable provider runtime jobs before adapter start and terminalizes queued runs visibly.
- [ ] Provider command resolution is operator-owned and immutable; request-owned executable/cwd/env/argv/process/PTY/terminal values are ignored or denied.
- [ ] Codex, Claude Code, and OpenCode production hosted semantics match FR5.
- [ ] Preflight, server readiness, worker readiness, smoke, and provider canary paths cover happy, nil, empty, and error paths.
- [ ] Provider spend controls are enforced before provider start and are additive to existing tenant quotas.
- [ ] Logs, metrics, readiness, preflight output, events, and artifacts redact credentials and sensitive provider command details.
- [ ] Local and hosted OpenAPI checks prove no public arbitrary execution routes were added.
- [ ] Tests prove no Generic HTTP, AgentField, Cursor, OpenClaw, Paperclip, browser, search, GitHub, fetch, repo, shell, generic process, generic PTY, hosted debate real participants, or model judging was activated.
- [ ] `PRODUCT.md` and `PROJECT.md` accurately describe R21 after implementation without claiming managed SaaS, dashboard/TUI, arbitrary execution, generic adapters, hosted tools, or hosted debate/model judging.

## Verification Expectations

CTO should turn these into exact task checks, but R21 must include coverage equivalent to:

- `pnpm --filter @switchyard/core test -- hosted-runtime-catalog`
- `pnpm --filter @switchyard/core test -- hosted-worker-service`
- `pnpm --filter @switchyard/core test -- production-config-guards`
- `pnpm --filter @switchyard/server test -- production-config`
- `pnpm --filter @switchyard/server test -- production-readiness`
- `pnpm --filter @switchyard/worker test -- production-config`
- `pnpm --filter @switchyard/worker test -- production-worker-readiness`
- `pnpm --filter @switchyard/worker test -- hosted-worker`
- `pnpm exec vitest run scripts/production-preflight.test.ts`
- `pnpm exec vitest run scripts/hosted-real-runtime-smoke.test.ts` or equivalent no-spend R21 production-mode smoke test
- `pnpm hosted-real-runtime:smoke`
- `pnpm production:preflight`
- `pnpm production:provider-runtime-canary --runtime-mode <mode> --confirm-provider-spend` or equivalent operator-run command documented as live-spend
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm --filter @switchyard/contracts openapi:check:hosted`
- `pnpm typecheck`
- `git diff --check`

Tests must include:

- happy path for each of `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` using fake provider clients/process factories in no-spend mode.
- nil config path for missing env/policy/credentials.
- empty config path for blank allowlist/empty policy/empty runtime list.
- error path for malformed policy, unknown runtime, missing binary, adapter check failure, provider bridge unsupported, object-store artifact failure, quota failure, entitlement denial, and spend-control denial.
- rollback path from real-enabled production to fake-only production.
- redaction assertions over config summaries, readiness diagnostics, preflight output, adapter logs, and failure events.
- OpenAPI absence checks for all forbidden execution route tokens.

## Implementation Task Expectations For CTO

This is not a full implementation plan. CTO should write the plan next with task graph, dependencies, context files, integration contracts, error rescue maps, observability, and test cases. Expected task groupings:

1. **Catalog and config gates**
   - Replace production fake-only forbids with closed conditional production allow rules.
   - Add provider runtime policy parsing/validation and spend-control validation.
   - Update server/worker redacted config summaries.

2. **Provider command policy and adapter construction**
   - Add provider-specific resolved command/policy handoff for Codex, Claude Code, and OpenCode.
   - Keep generic sandbox denylist intact.
   - Ensure adapter factories construct real providers in production only after policy, credential, and gate checks pass.

3. **Admission, readiness, and worker revalidation**
   - Update server hosted-run preflight.
   - Update worker claim readiness and claim-time failure behavior.
   - Add readiness diagnostics and metrics for provider runtime activation.

4. **Operations, smoke, canary, rollback, and docs**
   - Extend production preflight and manifest examples.
   - Add or extend no-spend hosted real runtime smoke for production-mode gates.
   - Add operator-run live provider canary with explicit spend confirmation.
   - Update `PRODUCT.md`, deployment docs, and `PROJECT.md` only at the appropriate phase close.

5. **Boundary and regression tests**
   - Add redaction, no-public-route, no-generic-adapter, no-hosted-tool, and no-hosted-debate regression tests.
   - Keep normal CI no-spend.

## Phase

### Phase 20: R21 Production Hosted Provider Runtime Activation

**Goal:** Activate production hosted execution for the known provider modes `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` for self-hosted operators, while preserving fake-only defaults and all public arbitrary-execution exclusions.

**Acceptance:**

- Production fake-only default still works and remains disabled for real runtimes.
- Production real runtime activation works only with explicit env opt-in, closed allowlist, provider policy, credential presence, spend controls, readiness/preflight proof, and provider-specific config.
- Codex, Claude Code, and OpenCode hosted production runs execute through worker-owned provider adapters with no request-owned executable/cwd/env/argv trust.
- Worker-side provider subprocesses use R20-style resolved command handoff where applicable without creating generic process/PTY product adapters.
- Server admission, worker claim revalidation, readiness, preflight, no-spend smoke, operator canary, rollback, metrics, and redaction are all covered.
- Public arbitrary execution APIs remain absent.
- Dashboard/TUI, hosted tools, generic adapters, Cursor/OpenClaw/Paperclip, and hosted debate real participants/model judging remain out of scope.

**Non-goals (this phase):**

- No dashboard/TUI.
- No public arbitrary execution APIs.
- No generic process/PTY runtime.
- No hosted tools or browser/search/GitHub/fetch/repo/shell execution.
- No `codex.interactive` hosted production activation.
- No Generic HTTP or AgentField hosted production activation.
- No hosted approval/input/terminal bridge.
- No hosted debate real participants or model judging.
- No managed SaaS/payment/OAuth/SSO work.

**Complexity:** L

## Required Product Truth After R21

After audit GREEN, product truth must say:

- R21 ships production hosted provider runtime activation for the known modes `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
- Production real-runtime execution is disabled by default and fake-only unless explicitly enabled by a self-hosted operator.
- Activation requires closed runtime allowlist, provider runtime policy, command policy/resolved handoff, provider credentials, spend controls, preflight/readiness proof, and provider-specific canary.
- Public arbitrary execution APIs remain absent.
- Generic process/PTY adapters remain unshipped.
- Hosted tools, Cursor/OpenClaw/Paperclip, hosted browser/search/GitHub/fetch/repo/shell, and hosted debate real participants/model judging remain unshipped.

## Auditor Focus

Auditor must explicitly verify:

- No public `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` route was added.
- Production hosted real-runtime execution cannot activate with only `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`; it also needs allowlist, provider policy, credentials, spend controls, and readiness proof.
- Unknown modes and out-of-scope modes are rejected.
- Generic sandbox denylist still blocks provider binaries as arbitrary commands.
- Provider command handoff does not trust request-owned executable/cwd/env/argv/process/PTY/terminal fields.
- Provider credentials and sensitive command details are redacted.
- Worker claim revalidation fails closed after config drift.
- Normal CI/audit tests remain no-spend.
- Product docs do not overclaim dashboard/TUI, public arbitrary execution, hosted tools, generic adapters, managed SaaS, or hosted debate/model judging.
