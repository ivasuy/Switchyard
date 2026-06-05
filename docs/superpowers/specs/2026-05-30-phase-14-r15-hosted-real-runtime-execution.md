# Phase 14 Spec: R15 Hosted Real Runtime Execution

**Date:** 2026-05-30
**Run:** post-r11-remaining-20260530
**Branch:** `agent/phase-14-r15-hosted-real-runtime-execution`
**Base:** Phase 13/R14 closed at `a42998a`
**Spec target:** `docs/superpowers/specs/2026-05-30-phase-14-r15-hosted-real-runtime-execution.md`

## Problem

Switchyard has a self-hosted staging foundation, S3/R2-compatible artifact storage, and an internal fake hosted sandbox substrate, but hosted worker execution is still restricted to `fake.deterministic`. Operators cannot yet run the existing provider runtime modes through the hosted server/queue/worker path, so the hosted surface remains useful for fake smoke and connected-node flows but not for real Codex, Claude Code, or OpenCode execution.

R15 should add the smallest safe real-runtime slice: opt-in self-hosted/staging hosted worker execution for known existing provider modes only: `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`. This is not a managed hosted platform, not production arbitrary subprocess/PTY sandboxing, and not a public sandbox API.

## Goals

- Allow a self-hosted or staging operator to explicitly enable hosted worker execution for `codex.exec_json`, `claude_code.sdk`, and/or `opencode.acp`.
- Preserve fake-only defaults: local/test default to `fake.deterministic`; staging/production fail closed unless operator config is explicit.
- Keep production fail-closed for real hosted runtimes. `SWITCHYARD_DEPLOYMENT_MODE=production` may continue fake-hosted operation but must reject real hosted runtime enablement in R15.
- Reuse existing runtime adapters and their existing fake process/client factories for deterministic tests:
  - `CodexExecJsonAdapter`
  - `ClaudeCodeAdapter`
  - `OpenCodeAcpAdapter`
- Add a small hosted runtime catalog that maps runtime-mode slugs to expected run fields, adapter ids, adapter types, provider/runtime ids, safe hosted limitations, and construction config.
- Revalidate every queued hosted job against the durable run row after queue claim and before adapter start.
- Persist real hosted runtime events, terminal state, sessions, artifacts, artifact content, and named failure reasons through the same Postgres/object-store paths used by hosted fake runs.
- Keep the public run, event, artifact, registry, runtime-mode, readiness, and metrics route shapes compatible.
- Add deterministic no-spend tests and smoke coverage using fake process/client factories. Required CI must not run live provider prompts or require provider spend.

## Non-Goals

- No arbitrary hosted subprocess execution.
- No generic process adapter.
- No real hosted PTY execution.
- No generic PTY adapter.
- No public `/sandbox`, `/exec`, `/pty`, `/terminal`, or equivalent public arbitrary-execution API.
- No production arbitrary subprocess/PTY sandboxing.
- No managed hosted platform.
- No enterprise organizations, OAuth, SSO, RBAC, billing, tenant quotas, tenant isolation controls, or secrets-management product surface.
- No dashboard.
- No TUI.
- No Cursor, OpenClaw, Paperclip, Generic HTTP, AgentField, browser, search, fetch, GitHub, repo, or shell hosted runtime execution.
- No real shell/browser/search/GitHub/fetch/repo tool execution.
- No Switchyard-hosted real tool adapters beyond the existing deny-by-default/fake tool posture.
- No interactive Codex promotion, Codex session resume, Codex approval bridge, Codex PTY/TUI automation, or Codex long-running input bridge.
- No hosted runtime-specific approval bridge. Provider approval/tool/permission events must fail visibly rather than waiting silently.
- No hosted post-start input bridge between server and worker. R15 real hosted runs are worker-owned start-to-terminal executions.
- No hosted debate with real participant runtimes or model judging.
- No public API contract rewrite or breaking response-shape changes.
- No required live provider spend in tests or default smoke.

## Current Truth

`PROJECT.md` Phase 13 says R14 shipped only a fake/no-spend hosted sandbox substrate. Real hosted runtime execution remains unshipped:

```md
R14 does not ship managed hosted deployment, production arbitrary subprocess/PTY execution, hosted Codex/Claude/OpenCode execution, Cursor/OpenClaw/Paperclip/browser/search/fetch/GitHub/repo/generic process/generic PTY adapters, real shell/browser/search/GitHub/fetch/repo tool execution, interactive Codex runtime/session-resume/approval bridges, enterprise auth/billing/tenant controls, hosted debate with real participant runtimes or model judging, dashboard, or TUI.
```

`PRODUCT.md` records the same remaining gap:

```md
- Hosted real-runtime worker deployment for Codex, Claude Code, OpenCode, arbitrary process, or PTY execution.
- Production sandboxing for arbitrary subprocess/PTY workloads (R14 ships only a fake/no-spend substrate and validation contracts).
```

The hosted worker currently registers only the fake adapter and constructs the R14 fake sandbox substrate as an unused internal dependency.

`apps/worker/src/worker.ts`:

```ts
const adapters = new Map<string, RuntimeAdapter>([["fake", new FakeRuntimeAdapter()]]);
const _hostedSandbox = new HostedSandboxService({
  config: config.sandbox,
  executor: new FakeHostedSandboxExecutor()
});
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

The worker service hard-codes fake-only claim validation. R15 must replace this with a closed known-mode validator, not loosen it into arbitrary process support.

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
if (!this.deps.hostedRuntimeAllowlist.includes("fake.deterministic")) {
  return "hosted_runtime_not_allowed";
}
```

The server/worker config already has a single hosted runtime allowlist and fails closed in staging/production when it is missing or empty. It currently requires `fake.deterministic` in staging/production.

`apps/worker/src/config.ts`:

```ts
const hostedRuntimeAllowlistEnv = optional(env["SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST"]);
const config: WorkerConfig = {
  deploymentMode,
  hostedRuntimeAllowlist: parseCsv(hostedRuntimeAllowlistEnv, "fake.deterministic"),
  queueName: optional(env["SWITCHYARD_QUEUE_NAME"]) ?? "switchyard-hosted-runs",
  idleIntervalMs: Number(optional(env["SWITCHYARD_WORKER_IDLE_MS"]) ?? "200"),
  objectStore: {} as ResolvedObjectStoreConfig,
  sandbox: resolveHostedSandboxConfig({ env, deploymentMode }),
  redactedSummary: {}
};
```

`apps/worker/src/config.ts`:

```ts
if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
  requireVar(config.postgresUrl, "SWITCHYARD_POSTGRES_URL", config);
  requireVar(config.redisUrl, "SWITCHYARD_REDIS_URL", config);
  requireVar(hostedRuntimeAllowlistEnv, "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST", config);
  if (config.hostedRuntimeAllowlist.length === 0) {
    throw new ConfigError(
      "config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
      "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
      buildSummary(config)
    );
  }
  if (!config.hostedRuntimeAllowlist.includes("fake.deterministic")) {
    throw new ConfigError(
      "config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
      "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST",
      buildSummary(config)
    );
  }
}
```

The existing provider adapters have the exact runtime modes R15 may use. R15 must not invent a generic process/PTY adapter.

`packages/adapters/src/codex/codex-exec-json-adapter.ts`:

```ts
readonly id = "codex";
readonly manifest: RuntimeAdapterManifest = {
  adapterId: "codex",
  providerId: "provider_openai",
  runtimeId: "runtime_codex",
  runtimeModeId: "runtime_mode_codex_exec_json",
  runtimeModeSlug: "codex.exec_json",
  name: "Codex exec JSON",
  adapterType: "process",
  kind: "one_shot_process",
```

`packages/adapters/src/claude-code/claude-code-adapter.ts`:

```ts
readonly id = "claude_code";
readonly manifest: RuntimeAdapterManifest = {
  adapterId: "claude_code",
  providerId: "provider_anthropic",
  runtimeId: "runtime_claude_code",
  runtimeModeId: "runtime_mode_claude_code_sdk",
  runtimeModeSlug: CLAUDE_CODE_RUNTIME_MODE_SLUG,
  name: "Claude Code SDK",
  adapterType: "native",
  kind: "sdk",
```

`packages/adapters/src/opencode/opencode-acp-adapter.ts`:

```ts
readonly id = "opencode";
readonly manifest: RuntimeAdapterManifest = {
  adapterId: "opencode",
  providerId: "provider_opencode",
  runtimeId: "runtime_opencode",
  runtimeModeId: "runtime_mode_opencode_acp",
  runtimeModeSlug: OPENCODE_ACP_RUNTIME_MODE_SLUG,
  name: "OpenCode ACP",
  adapterType: "acpx",
  kind: "acp",
```

The public run route already supports hosted placement without adding a separate hosted execution API. R15 should use this route and keep its response shape stable.

`packages/protocol-rest/src/run-routes.ts`:

```ts
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
    ? {
      ...metadata,
      originalTask: body.task,
      contextPacket: renderedContext.context
    }
    : metadata
};
```

The registry service already infers the three real runtime modes from existing request fields:

`packages/core/src/services/registry-service.ts`:

```ts
if (input.runtime === "codex" && input.adapterType === "process") {
  return "codex.exec_json";
}
if (input.runtime === "opencode" && input.adapterType === "acpx") {
  return "opencode.acp";
}
if (input.runtime === "claude_code" && input.adapterType === "native") {
  return "claude_code.sdk";
}
```

The R14 public API boundary is already tested by route 404 checks. R15 must keep this true.

`apps/server/test/hosted-server.test.ts`:

```ts
for (const route of ["/sandbox", "/exec", "/pty", "/terminal"]) {
  const res = await app.inject({ method: "POST", url: route, payload: {} });
  expect(res.statusCode).toBe(404);
}
```

## Architecture

R15 is a hosted worker adapter-wiring release with additional gates. It does not create a new public execution surface and does not make arbitrary process execution safe. The public control plane remains `POST /runs`, `GET /runs/:id`, event replay/live SSE, artifact listing/content, runtime-mode registry routes, `/ready`, and `/metrics`.

Add a closed hosted runtime catalog shared by server, worker, placement, and tests. The catalog should contain exactly these R15 executable real modes:

| Runtime mode | Runtime | Provider | Adapter type | Adapter id | Hosted R15 support |
|---|---|---|---|---|---|
| `fake.deterministic` | `fake` | `test` | `process` | `fake` | supported default |
| `codex.exec_json` | `codex` | `openai` | `process` | `codex` | conditional self-hosted/staging only |
| `claude_code.sdk` | `claude_code` | `anthropic` | `native` | `claude_code` | conditional self-hosted/staging only |
| `opencode.acp` | `opencode` | `opencode` | `acpx` | `opencode` | conditional self-hosted/staging only |

The hosted server should seed registry/runtime-mode records for the three known real modes so `POST /runs` can infer and validate them through the existing registry service. The server should not register real provider adapters in its `RuntimeRunnerService` for hosted execution. Real hosted execution is worker-owned. This avoids `?wait=1` accidentally running provider CLIs in the server process and keeps session ownership in one process.

The hosted worker should build a runtime adapter map from the catalog and resolved config. The map always contains fake. It may contain `codex`, `claude_code`, and/or `opencode` only when all real-runtime gates pass. The construction path must accept fake process/client/probe factories for tests, but production construction must use the existing adapters with operator-level commands/config only. Per-run command strings, per-run process factories, arbitrary shell commands, and per-run PTY configuration are never accepted.

`HostedWorkerService` should replace fake-only validation with catalog-backed validation:

- Durable run exists.
- Queue payload placement is `hosted`.
- Durable row placement is `hosted`.
- Durable row status is `queued` before starting a fresh claim.
- Durable `runtimeMode` exists and equals queue payload `runtimeMode` when the payload includes it.
- Durable `runtime`, `provider`, `adapterType`, and `runtimeMode` match the catalog entry.
- Runtime mode is in `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`.
- If runtime mode is real, `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled` is set and deployment mode is `staging`, `local`, or `test`.
- If deployment mode is `production`, real runtime modes are rejected at config load and at claim revalidation.
- Hosted real runtime metadata passes the hosted safety policy for that mode.

The R14 `HostedSandboxService` remains internal fake/no-spend substrate. R15 real provider adapters may use their existing provider-specific process or SDK transports, but R15 must not route them through a public sandbox API and must not expose arbitrary command execution. The product claim is "operator opt-in known provider runtimes in self-hosted/staging," not "production sandbox for arbitrary subprocesses."

## Configuration Contract

### Existing Shared Config Kept

`SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` remains the admission allowlist used by server placement and worker claim revalidation. R15 narrows accepted values to the closed catalog:

- `fake.deterministic`
- `codex.exec_json`
- `claude_code.sdk`
- `opencode.acp`

Unknown values fail config with `config_invalid:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`.

### New Real Runtime Gate

Add `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION`.

| Value | Meaning |
|---|---|
| unset / empty / `disabled` | Real hosted runtime modes are not constructible and are not placeable. Fake behavior remains unchanged. |
| `enabled` | Real hosted runtime modes may be used only in `local`, `test`, or `staging` when also listed in `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`. |

Rules:

- In `production`, `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled` is invalid and startup fails with `config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION`.
- In `production`, `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` containing any real runtime mode is invalid even if the real-runtime gate is unset.
- In `staging`, any real runtime mode in `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` requires `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`.
- In `local` and `test`, missing allowlist keeps the current fake default. Real modes still require explicit allowlist plus explicit gate.
- Real runtime modes require explicit `placement: "hosted"` in the run request. Omitted placement must not default to hosted for real modes, even if the allowlist contains them.
- `?wait=1` is supported for existing hosted fake behavior only. For hosted real runtime modes, `?wait=1` must fail before queue side effects using the existing error envelope shape, with `error.code` set to `placement_denied` or `hosted_runtime_not_allowed` and details containing `hosted_wait_unsupported`.

### Provider Runtime Config

Use existing adapter config names where they already exist:

| Env var | Applies to | Behavior |
|---|---|---|
| `SWITCHYARD_CLAUDE_CODE_COMMAND` | `claude_code.sdk` | Operator-configured command. Default remains `claude`. |
| `SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS` | `claude_code.sdk` | Bounded request timeout. Invalid values fail config. |
| `SWITCHYARD_CLAUDE_CODE_LIVE_PROBE` | `claude_code.sdk` | Must default to off. Required tests must not enable it against a live provider. |
| `SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD` | `claude_code.sdk` | Only used if live probe is explicitly enabled. |
| `SWITCHYARD_OPENCODE_COMMAND` | `opencode.acp` | Operator-configured command. Default remains `opencode`. |
| `SWITCHYARD_ACP_REQUEST_TIMEOUT_MS` | `opencode.acp` | Bounded ACP request timeout. |
| `SWITCHYARD_ACP_CANCEL_TIMEOUT_MS` | `opencode.acp` | Bounded ACP cancel timeout. |
| `SWITCHYARD_ACP_MAX_MESSAGE_BYTES` | `opencode.acp` | Bounded ACP message size. |

R15 does not require a new Codex command env var. Hosted `codex.exec_json` may use the adapter default command `codex`, with fake process factory injection for tests. If implementation adds a Codex command env var anyway, it must be operator-level only, must not accept shell fragments, and must be named consistently in server/worker redacted config summaries.

Redacted config summaries may include deployment mode, allowlisted runtime modes, gate state, command presence/default-vs-custom booleans, timeout numbers, and live-probe state. They must not include provider credentials, auth tokens, home directory secrets, raw command arguments, full environment, prompts, object-store credentials, or signed URLs.

## Hosted Safety Policy

R15 real hosted runtimes run with conservative provider options:

- `codex.exec_json`
  - Allowed only as one-shot `exec --json`.
  - No post-start input.
  - No session resume.
  - No approval bridge.
  - Hosted metadata must reject `sandbox: "workspace-write"` and `sandbox: "danger-full-access"`.
  - Hosted metadata must default to `sandbox: "read-only"` when no safe sandbox is specified.
  - Per-run command overrides are rejected.
- `claude_code.sdk`
  - Use the existing `ClaudeCodeAdapter`.
  - Hosted worker construction must use `permissionMode: "read_only"`.
  - Hosted worker construction must keep `disabledTools` including `Bash`, `WebFetch`, and `WebSearch`.
  - No hosted approval bridge is wired in R15.
  - If the provider asks for approval, tool execution, or an interactive pause that cannot be served by the worker-owned one-shot path, the run fails terminally with a named reason such as `hosted_interaction_unsupported` or existing `runtime_approval_bridge_unconfigured`.
- `opencode.acp`
  - Use the existing `OpenCodeAcpAdapter`.
  - Keep ACP client capabilities conservative: no file-system write bridge, no terminal bridge, no MCP servers.
  - No post-start public input path.
  - Permission/tool/interactive flows that cannot complete start-to-terminal fail visibly.

The hosted worker must not instantiate `GenericHttpAsyncRestAdapter`, `AgentFieldAsyncRestAdapter`, generic process/PTY adapters, browser automation, GitHub clients, fetch/search tools, shell tool adapters, or repo adapters.

## User-Visible Behavior

- Default local/test behavior: hosted fake runs still work with no real-runtime gate. Hosted real runtime requests are rejected with the existing error envelope and no queue side effects.
- Staging opt-in behavior: an operator sets `SWITCHYARD_DEPLOYMENT_MODE=staging`, persistent Postgres/Redis/object-store config, `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`, and `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic,codex.exec_json` or another catalog subset. A `POST /runs` request with `placement:"hosted"` and matching runtime fields returns the existing accepted run response; the worker claims the job and executes it.
- Production behavior: setting `SWITCHYARD_DEPLOYMENT_MODE=production` with any real hosted runtime enabled fails config before the server or worker can accept jobs. Production fake-hosted behavior remains governed by the existing fake allowlist.
- Hosted real runtime request without explicit placement: rejected before queue side effects. R15 does not silently spend provider budget because a runtime mode was allowlisted.
- Hosted real runtime request with `?wait=1`: rejected before queue side effects. Clients must poll or stream events through the existing event API.
- Provider binary/auth/config failure: run becomes `failed`; `run.failed` is persisted with a named reason; queue retry/exhaustion behavior remains visible.
- Provider emits normal output and terminal event: events are persisted in sequence; run terminal state is persisted; adapter transcript artifacts are written through the configured artifact content store; `GET /runs/:id/artifacts` and `GET /artifacts/:id/content` keep their existing response shapes.
- Provider emits approval/tool/input-required event that R15 cannot service: run fails visibly with a named reason; it must not remain indefinitely in `waiting_for_input` or `waiting_for_approval`.
- Public sandbox/API boundary: `/sandbox`, `/exec`, `/pty`, and `/terminal` still return 404. No public sandbox execution API exists in R15.

## Data Flow Shadow Paths

| Flow | Happy path | Nil path | Empty path | Error path |
|---|---|---|---|---|
| Env config -> resolved hosted runtime gates | Staging config has explicit real gate and allowlisted catalog modes; server/worker load and redacted summaries agree. | Gate missing means real modes are disabled; fake default remains local/test only. | Empty allowlist in staging/production fails `config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`; empty gate is treated as disabled. | Unknown runtime mode, production real enablement, invalid timeout, or unsafe command config fails startup with named config error and redacted summary. |
| `POST /runs` -> placement -> queue enqueue | Explicit hosted real request with matching runtime/provider/adapter/runtimeMode and gates passes placement and enqueues one hosted job. | Missing `runtimeMode` is inferred from existing registry rules; missing `placement` for real mode rejects before enqueue. | Empty task/cwd/runtime/provider/model still uses existing `invalid_input`; empty runtime allowlist denies placement. | Registry mismatch, unsupported hosted support, `?wait=1`, queue enqueue failure, or real gate disabled returns existing error envelope and does not create hidden side effects. |
| Queue claim -> durable run revalidation -> adapter start | Worker claims job, reloads run, verifies catalog match and allowlist/gate, then starts exactly the selected adapter. | Missing durable run fails queue job with `hosted_run_state_invalid` and no adapter start. | Empty/missing job payload runtimeMode must be reconciled with durable row; empty durable runtimeMode for real modes fails. | Terminal/non-queued row, placement mismatch, runtime mismatch, production real row, unsafe metadata, or allowlist drift fails run/job before `run.started`. |
| Adapter events -> event/session/run persistence | Provider fake factory emits normalized events; worker persists session, events, terminal run state, and artifact events in order. | Adapter returns no output but terminal completion still persists `run.completed`; no artifact is acceptable if adapter has none. | Empty stdout/stderr/transcript content is stored with zero-byte/empty metadata semantics and no false failure. | Adapter start/event error, provider malformed stream, timeout, unsupported interaction, or artifact write failure produces named `run.failed`/`timeout` state and queue retry/exhaustion semantics. |
| Artifact metadata/content -> REST retrieval | Transcript/raw transcript artifacts store metadata with `storageBackend`, `objectKey`, `sizeBytes`, `sha256`, and `contentType`; REST reads content through existing route. | Adapter returns no artifacts; `GET /runs/:id/artifacts` returns an empty array. | Empty transcript content is stored or marked contentStored according to existing artifact rules. | Object-store write/read/auth/timeout/digest failures use existing object-store/artifact error mapping and do not leak content or credentials. |
| Public API inventory -> route behavior | Existing run, event, artifact, registry, ready, and metrics routes continue to work. | No sandbox route exists; route lookup returns 404. | Empty body to forbidden sandbox-like routes still returns 404 because routes are absent. | OpenAPI/endpoint inventory tests fail if `/sandbox`, `/exec`, `/pty`, `/terminal`, or a public arbitrary-exec route appears. |

## Acceptance Criteria

- [ ] Server and worker config parse a closed hosted runtime allowlist containing only `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
- [ ] Real hosted runtime execution requires both explicit allowlist membership and `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`.
- [ ] `SWITCHYARD_DEPLOYMENT_MODE=production` fails closed when any real hosted runtime is allowlisted or real runtime execution is enabled.
- [ ] Staging/production still require Postgres, Redis, object-store, and hosted allowlist config before startup.
- [ ] Config summaries and readiness diagnostics redact credentials, tokens, prompts, full env, signed URLs, and object-store secrets.
- [ ] Runtime-mode registry records exist for `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` in hosted server contexts with hosted placement marked conditional/self-hosted-staging, not managed production.
- [ ] Placement accepts hosted real runtime requests only when `placement:"hosted"` is explicit, gates pass, the runtime mode is catalog-known, and `?wait=1` is not requested.
- [ ] Placement rejects omitted placement, disabled real gate, production mode, unknown modes, registry mismatches, and `?wait=1` before queue side effects.
- [ ] Hosted worker constructs real runtime adapters only for allowlisted catalog modes and always constructs fake.
- [ ] Hosted worker real adapter construction uses existing adapters: `CodexExecJsonAdapter`, `ClaudeCodeAdapter`, and `OpenCodeAcpAdapter`.
- [ ] Hosted worker construction tests can inject fake Codex process factories, fake Claude clients/probes, and fake OpenCode ACP process factories.
- [ ] Hosted worker does not instantiate Generic HTTP, AgentField, Cursor, OpenClaw, Paperclip, browser, search, fetch, GitHub, repo, shell, generic process, or generic PTY adapters.
- [ ] Queue claim revalidation reloads the durable run and verifies placement, status, runtimeMode, runtime, provider, adapterType, allowlist, gate, production posture, and hosted safety metadata before `startRun`.
- [ ] Tampered queue payloads and stale durable rows fail before any adapter call and persist a named failure event when a run row exists.
- [ ] `codex.exec_json` hosted runs default to read-only sandbox metadata and reject workspace-write/danger-full-access metadata before execution.
- [ ] `claude_code.sdk` hosted construction uses read-only permission mode and disables Bash/WebFetch/WebSearch.
- [ ] `opencode.acp` hosted construction uses conservative ACP capabilities and no terminal/MCP/file-write bridge.
- [ ] Provider approval/tool/input-required states that cannot be serviced in R15 fail visibly and do not leave hosted real runs stuck waiting.
- [ ] Completed, failed-after-start, timeout, and unsupported-interaction hosted real runs persist events, run terminal state, session state, and artifacts through the existing stores.
- [ ] Artifact content for hosted real runtime transcripts is written through the configured artifact content store and can be fetched through existing artifact routes.
- [ ] Object-store write/auth/unavailable/timeout/digest failures remain named and do not leak credentials or artifact content.
- [ ] Public run/event/artifact/runtime-mode response shapes remain backward compatible.
- [ ] No public `/sandbox`, `/exec`, `/pty`, `/terminal`, or arbitrary-execution route is added.
- [ ] No public sandbox API appears in generated OpenAPI or endpoint inventory.
- [ ] No real shell/browser/search/GitHub/fetch/repo tool execution is wired in server or worker.
- [ ] Required unit/integration/smoke tests use fake process/client factories and require no live provider spend.
- [ ] Optional live-provider smoke, if added, is opt-in, clearly named, disabled by default, budget-bounded where applicable, and not required by CI.

## Required Tests And Smoke

Normal CI must remain deterministic and no-spend.

Required unit coverage:

- Config parser matrix for local/test/staging/production, absent gate, empty gate, enabled gate, empty allowlist, unknown allowlist mode, real mode in production, real mode in staging, invalid timeout, and redacted summary.
- Hosted runtime catalog tests proving only four slugs are accepted and each maps to the expected runtime/provider/adapter fields.
- Placement tests for explicit hosted real acceptance, omitted placement rejection, `?wait=1` rejection, gate-disabled rejection, production rejection, unknown runtime rejection, and queue enqueue failure without hidden side effects.
- Hosted worker service tests for each catalog mode: happy claim, missing run, terminal run, non-queued run, mismatched queue payload, mismatched runtime/provider/adapterType, allowlist drift, production real row, unsafe Codex sandbox metadata, and unsupported interaction.
- Adapter construction tests with fake factories for Codex, Claude Code, and OpenCode. These tests must assert no live provider command is required.
- Static/source tests proving worker imports only the approved real adapters and does not import generic process/PTY/browser/search/fetch/GitHub/repo/tool adapters.
- Artifact/event tests proving transcript/raw transcript artifacts persist and can be read through existing artifact APIs for fake Codex, fake Claude, and fake OpenCode executions.
- Error tests for adapter start failure, malformed event stream, object-store write failure, timeout, unsupported approval/tool/input pause, and queue retry exhaustion.
- OpenAPI/endpoint inventory tests proving no public sandbox or arbitrary-execution API is added.

Required smoke coverage:

- Add a no-spend hosted real runtime smoke path that starts the hosted server/worker test harness with fake process/client factories and runs:
  - `codex.exec_json` hosted completion with fake JSONL process output.
  - `claude_code.sdk` hosted completion with fake Claude client events.
  - `opencode.acp` hosted completion with fake ACP process.
  - one denied production/gate-disabled request before queue side effects.
  - one unsupported interaction that fails visibly.
  - artifact listing/content retrieval for at least one completed real hosted run.
- The smoke must not require Docker, AWS, R2, live Codex, live Claude, live OpenCode, browser binaries, GitHub tokens, shell tools, or model spend.
- Existing `self-hosted:smoke` and `sandbox:smoke` behavior must remain compatible. R15 may add a separate smoke command rather than modifying those paths.

Suggested required checks for the CTO plan:

- `pnpm --filter @switchyard/core test -- hosted-worker-service`
- `pnpm --filter @switchyard/server test -- hosted-server`
- `pnpm --filter @switchyard/worker test -- hosted-worker`
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/adapters test`
- new no-spend hosted real runtime smoke command

## Observability

Logs should use stable low-cardinality names:

- `hosted.runtime.config.accepted`
- `hosted.runtime.config.rejected`
- `hosted.runtime.placement.accepted`
- `hosted.runtime.placement.denied`
- `hosted.worker.claim.revalidated`
- `hosted.worker.claim.rejected`
- `hosted.worker.adapter.constructed`
- `hosted.worker.adapter.starting`
- `hosted.worker.adapter.failed`
- `hosted.worker.interaction.unsupported`
- `hosted.worker.artifact.persisted`

Log fields may include `runId`, `jobId`, `runtimeMode`, `adapterId`, `adapterType`, `status`, `reasonCode`, `attempts`, `maxAttempts`, and coarse byte counts. Logs must not include prompts, full task text, stdout/stderr content, raw provider events, env values, credentials, tokens, object content, signed URLs, command arguments, or user home secrets.

Metrics should extend existing hosted metrics without high-cardinality labels:

```json
{
  "hostedRuntime": {
    "accepted": 0,
    "denied": 0,
    "started": 0,
    "completed": 0,
    "failed": 0,
    "timeout": 0,
    "unsupportedInteraction": 0,
    "artifactPersisted": 0
  }
}
```

Metric keys or labels must not include run ids, job ids, prompt text, cwd, usernames, provider account ids, object keys, command paths, or model-output text.

Readiness should expose only non-secret readiness facts:

- `hostedRuntimeGate.ok=true` when gate/allowlist/deployment posture is internally consistent.
- `hostedRuntimeGate.ok=false, code="hosted_real_runtime_disabled"` when real modes are configured without the real gate.
- `hostedRuntimeGate.ok=false, code="hosted_real_runtime_production_forbidden"` when production attempts real modes.
- `hostedRuntimeAdapters.ok=true` when all configured adapters can be constructed with no-spend checks.
- `hostedRuntimeAdapters.ok=false` with per-mode reason codes when construction or no-spend checks fail.

Readiness must not run live prompts by default.

## Public API Compatibility

R15 must preserve these existing route shapes:

- `POST /runs`
- `GET /runs`
- `GET /runs/:id`
- `GET /runs/:id/events`
- `GET /runs/:id/artifacts`
- `GET /artifacts/:id`
- `GET /artifacts/:id/content`
- `POST /runs/:id/cancel`
- `POST /runs/:id/input`
- `GET /runtime-modes`
- `GET /runtime-modes/:id`
- `POST /runtime-modes/:id/check`
- `GET /ready`
- `GET /metrics`

R15 may add optional fields inside existing readiness/metrics JSON objects and may add runtime-mode records. It must not remove fields, rename fields, change run/event/artifact schemas, or change the HTTP error envelope shape.

`POST /runs/:id/input` must not claim delivery to a hosted worker session in R15. If a hosted real runtime is active and there is no supported input bridge, the route should fail visibly using the existing error envelope. It must not return success while dropping input.

`POST /runs/:id/cancel` must not claim verified provider cancellation unless a verified worker-owned cancel path exists. If only queued cancellation is implemented, active hosted real runtime cancellation must fail visibly with the existing error envelope and detail `hosted_cancel_unsupported`. It must not report success while provider execution continues.

## Security Requirements

- Real hosted runtimes are self-hosted/staging opt-in only.
- Production mode rejects real hosted runtime execution in R15.
- Worker never accepts user-supplied command strings.
- Worker never accepts per-run process factories, per-run binary paths, per-run shell snippets, or per-run PTY config.
- Worker provider commands are operator config only and must be executed without shell interpolation.
- Hosted real runtime policy rejects Codex workspace-write/danger-full-access metadata.
- Claude hosted construction keeps read-only permission mode and disabled dangerous tools.
- OpenCode hosted construction keeps conservative ACP capabilities and no terminal/file-write/MCP bridge.
- Real Switchyard tool execution remains denied except existing fake tool behavior outside this hosted worker path.
- Artifact/event/log/redaction rules must treat provider events as untrusted.
- Any config, placement, revalidation, adapter construction, provider stream, artifact, or object-store failure must fail closed and named.

## Phase

### Phase 14: R15 Hosted Real Runtime Execution

**Goal:** Add opt-in self-hosted/staging hosted worker execution for `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` using existing adapters, while preserving fail-closed production posture and public API compatibility.

**Acceptance:**

- Config gates, allowlists, runtime catalog, placement rules, worker adapter construction, and claim revalidation are implemented for fake plus the three known real runtime modes.
- Hosted real runtime execution persists events/artifacts through existing stores and uses deterministic fake factories in required tests/smoke.
- Production real hosted runtime execution, arbitrary process/PTY, public sandbox API, real tools, managed hosted platform, dashboard, and TUI remain out of scope.

**Non-goals (this phase):** arbitrary process/PTY, generic process/PTY adapters, public sandbox/exec/terminal routes, production managed hosted real-runtime platform, enterprise auth/billing/tenant controls, real shell/browser/search/GitHub/fetch/repo tools, interactive Codex/session resume/approval bridge, hosted runtime approval bridge, dashboard, and TUI.

**Complexity:** L

## Risks

- Allowlist configuration could accidentally cause provider spend. Mitigation: require explicit real gate, explicit hosted placement, no `?wait=1`, and no default hosted placement for real modes.
- Server and worker could diverge on which modes are allowed. Mitigation: shared closed catalog and shared config validation tests.
- Provider adapters can emit interactive/approval states the hosted worker cannot service. Mitigation: terminalize unsupported interactions with named failures; do not leave waiting states.
- Codex process execution could be mistaken for arbitrary subprocess support. Mitigation: catalog-only provider adapter construction, no per-run command, no shell interpolation, no generic process/PTY adapter.
- Hosted real runtime docs could overclaim production readiness. Mitigation: phase docs and product truth must say self-hosted/staging opt-in, not managed production hosted platform or production sandboxing.
- Artifact persistence can fail after provider execution completes. Mitigation: preserve named object-store failures, queue retry/exhaustion semantics, and visible run failure rather than silent missing transcripts.
