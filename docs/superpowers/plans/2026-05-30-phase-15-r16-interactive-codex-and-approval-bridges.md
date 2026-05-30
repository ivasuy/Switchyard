# Phase 15: R16 Interactive Codex And Approval Bridges - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-15-r16-interactive-codex-and-approval-bridges.md`
**Branch:** `agent/phase-15-r16-interactive-codex-and-approval-bridges`
**Complexity:** L

## Goal

Ship a separate explicit local-only `codex.interactive` runtime mode with no-spend fake coverage for post-start input, session state, resume, and approval bridge behavior while preserving `codex.exec_json` one-shot semantics and keeping hosted/UI/PTY/tool expansion out of scope.

## Architecture

R16 stays inside the existing runtime adapter contract. `codex.exec_json` remains the inferred Codex default and keeps its current class, args, closed stdin, unsupported input reason, transcript path, and tests. A new Codex adapter router is registered under adapter id `codex`; it dispatches `runtimeMode` absent or `codex.exec_json` to the existing `CodexExecJsonAdapter`, and explicit `codex.interactive` to a new bounded interactive adapter. Unknown Codex modes fail with `codex_runtime_mode_unsupported`.

`codex.interactive` is a local process-backed mode. Its real driver is an `exec_resume_json` driver built around no-shell `codex exec --json` for the first turn and `codex exec resume --json <session> <prompt>` for resumed turns when local checks prove support. The fake driver implements the same `CodexInteractiveSessionFactory` contract and is the required path for automated tests and daemon smoke. The default real driver advertises post-start input, session state, and session resume only after no-spend capability checks. It does not advertise `approval.bridge` unless the injected driver exposes a tested non-PTY approval request and resolution path.

The existing `RuntimeRunnerService` remains the state machine owner. It already persists `waiting_for_input`, `waiting_for_approval`, and bounded `sessionStatePatch` updates. R16 hardens that flow by passing `runtimeMode` into adapter sessions, preserving `AdapterProtocolError.reasonCode` in failed run events, and ensuring runtime approval payloads carry bounded `runtimeMode`, `runtimeSessionId`, `externalSessionKey`, and `expiresAt` fields. `ApprovalService` remains the approval lifecycle owner and gains deterministic expiration handling for runtime approval records.

Interactive create uses async `POST /runs` only. `POST /runs?wait=1` with `runtimeMode: "codex.interactive"` is rejected before durable side effects with `interactive_wait_unsupported`, because the existing runner intentionally keeps the adapter event stream open while the run waits for input or approval. This preserves current async background behavior without creating a terminal, PTY, or public process bridge.

```
POST /runs runtimeMode=codex.interactive
  |
  v
run-routes validation --reject wait=1--> 400 invalid_input(interactive_wait_unsupported)
  |
  v
RunService.createRun -> RuntimeRunnerService.start
  |
  v
CodexAdapterRouter.start -> CodexInteractiveAdapter.start
  |
  v
CodexInteractiveSessionFactory.startTurn
  |
  +--> runtime.status(sessionStatePatch.codexThreadId)
  +--> runtime.output
  +--> runtime.status(waiting_for_input) OR approval.requested OR terminal
        |
        +--> POST /runs/:id/input text -> adapter.send -> factory.resumeTurn
        +--> POST /approvals/:id/approve|reject -> ApprovalService -> runService.sendInput(approval_resolution)
```

## Scope Challenge

1. Existing code already solves most of the state machine: `RuntimeRunnerService` handles waiting states, input bounds, session-state patching, approval events, artifact persistence, cancellation, and startup recovery. The plan extends those paths rather than adding a Codex-only control plane.
2. The minimum product slice is explicit local `codex.interactive`, fake factory tests, daemon registry wiring, REST guardrails, and docs truth. Hosted input bridges, public PTY/terminal routes, dashboard/TUI, arbitrary shell/tool execution, and OpenCode/AgentField/Generic HTTP bridge implementations stay out.
3. Complexity exceeds the 8-file smell because this phase crosses adapter, core runner, REST route, daemon registry, testkit, and docs boundaries. The plan splits ownership into six disjoint tasks. Only two new production abstractions are introduced: `CodexInteractiveSessionFactory` and `CodexAdapterRouter`.
4. Built-in reuse: use existing `RuntimeRunnerService`, `ApprovalService`, `RuntimeCapabilityService`, `RuntimeDoctorService`, `RegistryService`, Fastify routes, Zod schemas, `ProcessRunner`, `TranscriptRecorder`, and Claude transcript bounds helpers. Use Node `child_process.spawn` with `shell: false`; do not add a PTY or generic process library.
5. Distribution check: no new package, binary, container, or public route is introduced. Existing package build/test/typecheck/lint scripts remain the distribution checks.

## File Structure

- `packages/core/src/services/runtime-runner-service.ts` - Preserve adapter reason codes, pass `runtimeMode` to adapter sessions, and harden runtime approval/session-state payload behavior.
- `packages/core/src/services/approval-service.ts` - Add runtime approval expiration handling through the existing approval lifecycle and runtime resolution sender.
- `packages/core/test/runtime-approval-session-r16.test.ts` - Focused core tests for R16 session state, approval expiration, duplicate resolution, stale runtime sessions, and reason-code persistence.
- `packages/testkit/src/fake-codex-interactive-session.ts` - No-spend fake Codex interactive session/process factory with deterministic start, resume, approval, stale, terminal, and transcript scenarios.
- `packages/testkit/test/fake-codex-interactive-session.test.ts` - Unit coverage for the fake factory.
- `packages/adapters/src/codex/codex-interactive-session-factory.ts` - Shared Codex interactive driver contract and real `exec_resume_json` factory implementation.
- `packages/adapters/src/codex/codex-interactive-adapter.ts` - Runtime adapter for explicit `codex.interactive`.
- `packages/adapters/src/codex/codex-interactive-doctor.ts` - No-spend local capability check for version/help/resume/help and approval bridge support state.
- `packages/adapters/src/codex/codex-adapter-router.ts` - Router preserving `codex.exec_json` default behavior while dispatching explicit interactive sessions.
- `packages/adapters/src/codex/types.ts` - Shared Codex runtime types extended with interactive option types.
- `packages/adapters/src/index.ts` - Export new Codex interactive/router types.
- `packages/adapters/test/codex-interactive-adapter.test.ts` - Adapter tests with fake Codex interactive factories.
- `packages/adapters/test/codex-exec-json-adapter.test.ts` - Regression assertions that one-shot semantics stay unchanged.
- `apps/daemon/src/app.ts` - Wire router, seed `codex.interactive`, inject fake factory for tests, and expose no-spend doctor/registry truth.
- `apps/daemon/test/smoke.test.ts` - Daemon smoke for fake Codex interactive no-spend create/input/approval/check behavior.
- `packages/adapters/src/compatibility-matrix.ts` - Add no-spend compatibility matrix row for `codex.interactive`.
- `packages/adapters/src/compatibility-matrix.test.ts` - Matrix assertions for explicit local interactive Codex coverage.
- `packages/protocol-rest/src/run-routes.ts` - Reject `codex.interactive` with `wait=1`, enforce hosted input/create boundaries, and preserve public text-only input validation.
- `packages/protocol-rest/src/middleware-routes.ts` - Map approval expiration/runtime-resolution errors into existing error envelopes.
- `packages/protocol-rest/test/run-routes.test.ts` - REST tests for input validation, terminal/hosted boundaries, wait guard, and explicit runtime-mode validation.
- `packages/protocol-rest/test/middleware-routes.test.ts` - Approval approve/reject/expired/stale route mapping tests.
- `packages/contracts/src/openapi.contract.test.ts` - Strengthen public route boundary guard against terminal/PTY/sandbox/exec/shell/process routes and operation ids.
- `PRODUCT.md` - Current product truth update.
- `CHANGELOG.md` - R16 release entry.
- `docs/development/API.md` - Local API contract and runtime-mode truth update.
- `docs/development/DEVELOPMENT.md` - No-spend local smoke and operational notes.
- `docs/development/adapters/CODEX.md` - Codex-specific local debugging and boundaries.
- `docs/adapters/codex.md` - Adapter status update.
- `ARCHITECTURE.md` - Architecture reference truth for local interactive Codex and excluded hosted/UI/PTY surfaces.

## Existing Context

`packages/core/src/services/runtime-runner-service.ts` already persists waiting states:

```ts
if (status === "waiting_for_input" || status === "waiting_for_approval") {
  const updated = await this.updateRunAndSessionStatus(runId, status, session);
  this.log("info", "runtime.status.waiting", { runId, status });
  return updated;
}
```

The same file already rejects unsafe session-state patches and selects `codexThreadId` as an external session key:

```ts
const rawPatch = event.payload["sessionStatePatch"];
if (rawPatch === undefined || rawPatch === null) {
  return { session };
}
...
const codex = patch["codexThreadId"];
if (typeof codex === "string" && codex.trim().length > 0) {
  return codex.trim();
}
```

`packages/core/src/services/approval-service.ts` already resolves runtime approvals through `runtimeResolutionSender`:

```ts
await this.deps.runtimeResolutionSender(resolutionPayload);
this.deps.logger?.info("runtime.approval_resolution.sent", {
  approvalId: persisted.id,
  runId,
  decision: status
});
```

`packages/adapters/src/codex/codex-exec-json-adapter.ts` is the one-shot behavior that must not change:

```ts
const processSession = this.processRunner.start({
  processFactory: this.processFactory,
  args,
  cwd,
  env: process.env,
  stdin: "close",
```

Its manifest explicitly lacks interactive capabilities:

```ts
limitations: [
  { code: "one_shot_no_input", message: "codex.exec_json does not support post-start input." },
  { code: "no_approval_bridge", message: "Approval bridge integration is not shipped for codex.exec_json in R8." },
  { code: "no_session_resume", message: "Session resume remains deferred for codex.exec_json in R8." }
],
```

`packages/protocol-rest/src/run-routes.ts` already enforces text body bounds and hosted input rejection for known hosted real modes:

```ts
if (isHostedRealRun(run)) {
  ...
  return sendHttpError(reply, "adapter_protocol_failed", "Hosted input bridge is not supported", [
    { path: "reasonCode", issue: "hosted_input_unsupported" }
  ]);
}
```

`packages/core/src/services/registry-service.ts` already keeps omitted Codex mode inference on `codex.exec_json`:

```ts
if (input.runtime === "codex" && input.adapterType === "process") {
  return "codex.exec_json";
}
```

`apps/daemon/src/app.ts` currently registers only `CodexExecJsonAdapter` under adapter id `codex` and seeds only `codex.exec_json`. R16 must replace that map value with the router while seeding both manifests.

## Task Graph

### Task P15-T1-runtime-approval-session-core: Harden RuntimeRunnerService and ApprovalService bridges

**Files (owned):**
- Modify: `packages/core/src/services/runtime-runner-service.ts`
- Modify: `packages/core/src/services/approval-service.ts`
- Create: `packages/core/test/runtime-approval-session-r16.test.ts`

**Dependencies:** none

**Context files (MUST read before coding):**
- `docs/superpowers/specs/2026-05-30-phase-15-r16-interactive-codex-and-approval-bridges.md` - reason codes, acceptance, and non-goal boundary.
- `packages/core/src/services/runtime-runner-service.ts` - current waiting-state, session patch, input, artifact, and approval bridge behavior.
- `packages/core/src/services/approval-service.ts` - current approval create/approve/reject/runtime resolution behavior.
- `packages/core/test/core.test.ts` - existing in-memory store helpers and runner lifecycle patterns to mirror in the new focused test file.
- `packages/contracts/src/run.ts` - run status vocabulary.
- `packages/contracts/src/approval.ts` - approval status/type vocabulary.
- `packages/core/src/services/local-policy-gate.ts` - existing `redactSecrets` helper used by both services.

**Instructions:**
1. Add tests first in `packages/core/test/runtime-approval-session-r16.test.ts` using local in-memory stores copied or minimally factored from `core.test.ts`. Keep this file focused on R16 behavior so no other task needs to edit `core.test.ts`.
2. In `RuntimeRunnerService.failRun`, when the caught error is an `AdapterProtocolError`, include `reasonCode: error.reasonCode` in the final `run.failed` payload in addition to the current human-readable `error` field. Keep existing non-adapter error payloads unchanged.
3. In `RuntimeRunnerService.adapterSession`, include `runtimeMode: session.runtimeMode` so `CodexAdapterRouter.send/cancel/events/artifacts` can dispatch after start and after persisted session lookup.
4. In `handleRuntimeApproval`, preserve the existing token/type validation and add bounded payload enrichment before calling `runtimeApprovals.create`: `runtimeMode`, `runtimeSessionId`, `externalSessionKey`, and `expiresAt` when present and valid. If `expiresAt` is present but not a parseable ISO date, fail the run with `runtime_approval_type_invalid` or a new specific `runtime_approval_expires_at_invalid` reason only if that new reason is added to docs and tests. Prefer `runtime_approval_type_invalid` only for invalid approval type.
5. Keep session-state patch rules unchanged except add tests for `codexThreadId`: nil patch is ignored, empty patch is ignored, safe patch stores state and sets `externalSessionKey`, non-object patch fails with `session_state_patch_rejected`, secret-like key fails with `session_state_patch_rejected`, and over-16 KiB patch fails with `session_state_patch_too_large`.
6. In `ApprovalService`, add deterministic runtime approval expiration without adding routes. When `create()` sees `payload.expiresAt` for a runtime approval, store the redacted payload and schedule a local timer if the date is in the future. If the date is in the past, atomically transition pending -> expired after create, emit `approval.expired`, and send a rejected runtime resolution with message `expired by Switchyard` when `runtimeApprovalToken` and `runId` are present.
7. In `approve()` and `reject()`, check pending approval expiration before resolving. If expired, atomically update pending -> expired, emit `approval.expired`, send the rejected runtime resolution when possible, and throw `ApprovalServiceError("approval_not_pending", ...)` so the existing route contract remains a 409 for late user actions.
8. Guard timers so duplicate expiration and user resolution cannot both send side effects. Reuse `updateIfStatus(id, "pending", ...)` and the existing `withResolutionLock`.
9. Log only low-cardinality fields: approval id, run id, decision/status, reason code. Do not log prompt text, post-start input text, tool input, approval payload content, or runtime token values.

**Acceptance criteria:**
- [ ] AdapterProtocolError startup failures persist `run.failed.payload.reasonCode`.
- [ ] Adapter sessions passed into `send` include the stored `runtimeMode`.
- [ ] `codexThreadId` session-state patches set `session.externalSessionKey` once and do not overwrite an existing external key.
- [ ] Nil and empty session-state patches do not fail runs.
- [ ] Non-object, secret-key, unsafe-value, and oversized session-state patches fail with stable reason codes.
- [ ] Runtime approval events with valid token/type create a pending approval and move run/session to `waiting_for_approval`.
- [ ] Runtime approval events with missing or blank token fail with `runtime_approval_token_missing`.
- [ ] Runtime approval events with invalid approval type fail with `runtime_approval_type_invalid`.
- [ ] Approval approve/reject sends one `approval_resolution` payload and duplicate resolution returns `approval_not_pending`.
- [ ] Expired runtime approvals transition to `expired`, emit `approval.expired`, send a rejected runtime resolution when possible, and do not remain pending.
- [ ] Stale runtime session errors during resolution surface `runtime_approval_pause_not_active` without resetting approval status to pending.

**Checks (must pass before GREEN):**
- `pnpm --filter @switchyard/core test -- runtime-approval-session-r16`
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/core typecheck`

**error_rescue_map:**
- `RuntimeRunnerService.failRun` | Adapter throws `AdapterProtocolError` with reason | `AdapterProtocolError` | Persist `run.failed` with both `error` and `reasonCode`; mark run/session failed | API/events show failed run with stable reason code.
- `RuntimeRunnerService.adapterSession` | Runtime mode missing on old session | undefined field | Include `runtimeMode` only when present; router falls back to stored in-memory session mapping for active start | Existing runs continue; new interactive sends can dispatch by mode.
- `applySessionStatePatchIfPresent` | Patch missing or null | no exception | Ignore patch and continue | Run proceeds normally.
- `applySessionStatePatchIfPresent` | Patch is empty object | no exception | Ignore patch and continue | Run proceeds normally.
- `applySessionStatePatchIfPresent` | Patch is non-object/array/function/symbol/secret-key | no throw; explicit rejection | Emit failed event with `session_state_patch_rejected` | Run fails visibly.
- `applySessionStatePatchIfPresent` | Patch exceeds 16 KiB | explicit size check | Emit failed event with `session_state_patch_too_large` | Run fails visibly.
- `handleRuntimeApproval` | Token missing or blank | explicit check | Convert to failed event `runtime_approval_token_missing` | Run fails visibly.
- `handleRuntimeApproval` | Approval bridge not configured | explicit check | Convert to failed event `runtime_approval_bridge_unconfigured` | Run fails visibly.
- `handleRuntimeApproval` | Approval type invalid | Zod parse failure | Convert to failed event `runtime_approval_type_invalid` | Run fails visibly.
- `ApprovalService.resolve` | Approval already resolved or expired | `ApprovalServiceError` code `approval_not_pending` | Return existing 409 behavior through route layer | User sees approval cannot transition again.
- `ApprovalService.expirePendingRuntimeApproval` | Runtime session stale during expiration resolution | `AdapterProtocolError` from runtime sender | Keep approval expired, emit/log warning with reason code, do not rethrow from timer | User sees approval expired and run later fails or times out visibly.
- `ApprovalService.create` | `expiresAt` is in the past | explicit date comparison | Persist then expire immediately using the same transition path | User sees expired approval and approval event.

**observability:**
- Logs: `runtime.session_state.updated`, `runtime.session_state_rejected`, `runtime.approval.requested`, `runtime.approval_resolution.sent`, `approval.expired`, `approval.expiration_resolution_failed`.
- Success metric: pending runtime approvals either resolve to approved/rejected or expire with one terminal approval event.
- Failure metric: any `waiting_for_approval` run with no pending approval and no terminal event after expiration is a test failure.

**test_cases:**
- `adapter reason code survives startup failure` | `error_path` | Adapter `start()` throws `AdapterProtocolError("unsupported", { reasonCode: "codex_interactive_driver_unsupported" })` | final event is `run.failed` with `payload.reasonCode`.
- `adapter session includes runtime mode` | `happy` | Stored run/session has `runtimeMode: "codex.interactive"` and `sendInput()` is called | fake adapter receives `session.runtimeMode === "codex.interactive"`.
- `codex thread id patch sets external session key` | `happy` | runtime.status payload has `{ sessionStatePatch: { codexThreadId: "thread_1" } }` | session state has `codexThreadId` and `externalSessionKey` is `thread_1`.
- `existing external session key is not overwritten` | `edge_existing_key` | session already has external key and patch has new `codexThreadId` | external key stays unchanged, state still stores patch.
- `nil patch ignored` | `happy_shadow_nil` | runtime.status has no `sessionStatePatch` | run does not fail.
- `empty patch ignored` | `happy_shadow_empty` | runtime.status has `{ sessionStatePatch: {} }` | run does not fail.
- `non-object patch rejected` | `error_path` | patch is an array | run fails with `session_state_patch_rejected`.
- `secret-key patch rejected` | `error_path` | patch has `{ token: "secret" }` | run fails with `session_state_patch_rejected` and logs do not contain secret.
- `oversized patch rejected` | `error_path` | patch serializes above 16 KiB | run fails with `session_state_patch_too_large`.
- `runtime approval missing token fails` | `error_path` | approval.requested lacks `runtimeApprovalToken` | run fails with `runtime_approval_token_missing`.
- `runtime approval invalid type fails` | `error_path` | approval.requested has `approvalType: "shell_root"` | run fails with `runtime_approval_type_invalid`.
- `runtime approval happy creates pending approval` | `happy` | approval.requested has token/type/expiresAt | approval store has pending record and run/session enter `waiting_for_approval`.
- `approval approved sends resolution once` | `happy` | approve pending runtime approval | runtime sender sees one `decision: "approved"` payload.
- `approval rejected sends resolution once` | `happy` | reject pending runtime approval | runtime sender sees one `decision: "rejected"` payload.
- `duplicate approval resolution blocked` | `edge_duplicate_resolution` | approve same approval twice | second call throws `approval_not_pending`, sender call count remains one.
- `expired approval sends rejected resolution` | `edge_expired` | pending approval expires before user action | status becomes `expired`, event `approval.expired` is emitted, sender sees rejected expiration payload.
- `stale runtime session during approval resolution` | `error_path` | runtime sender throws `AdapterProtocolError` reason `runtime_approval_pause_not_active` | approval status does not return to pending and route/core caller sees named reason where synchronous.

**integration_contracts:**
- Exports:
  - `RuntimeRunnerService.adapterSession(session: RuntimeSession) => Record<string, unknown> including runtimeMode?: string`
  - `ApprovalService.approve(id, input?) => Promise<ResolveApprovalResult>`
  - `ApprovalService.reject(id, input?) => Promise<ResolveApprovalResult>`
- Imports from other tasks: none.
- File paths consumed by other tasks:
  - `packages/core/src/services/runtime-runner-service.ts` consumed by Task P15-T3 and P15-T5 through adapter `send()` session shape.
  - `packages/core/src/services/approval-service.ts` consumed by Task P15-T5 route error mapping and Task P15-T4 daemon wiring.

### Task P15-T2-fake-codex-interactive-harness: Add deterministic no-spend Codex interactive fake factory

**Files (owned):**
- Create: `packages/testkit/src/fake-codex-interactive-session.ts`
- Modify: `packages/testkit/src/index.ts`
- Create: `packages/testkit/test/fake-codex-interactive-session.test.ts`

**Dependencies:** none

**Context files (MUST read before coding):**
- `docs/superpowers/specs/2026-05-30-phase-15-r16-interactive-codex-and-approval-bridges.md` - fake coverage requirements and reason codes.
- `packages/testkit/src/fake-claude-code-client.ts` - queue-based fake interactive client pattern.
- `packages/testkit/src/fake-claude-code-cli.ts` - process-like fake with stdin/stdout control.
- `packages/testkit/src/fake-runtime-adapter.ts` - deterministic fake adapter style and no-spend constraints.
- `packages/testkit/src/index.ts` - export surface.
- `packages/testkit/test/fake-runtime-adapter.test.ts` - local test style for testkit package.

**Instructions:**
1. Add `createFakeCodexInteractiveSessionFactory(scenario?)` that returns `{ factory, state }`. The factory must be structurally compatible with the interface exported by Task P15-T3:
   - `check(input) => Promise<{ ok: boolean; availability: ..., diagnostics: ... }>`
   - `startTurn(input) => Promise<CodexInteractiveTurn>`
   - `resumeTurn(input) => Promise<CodexInteractiveTurn>`
   - `resolveApproval(input) => Promise<void>`
   - `cancel(input) => Promise<void>`
2. The fake must never spawn a process, execute a command, read a real file, call the network, or require a Codex binary.
3. Provide deterministic scenarios:
   - default start emits `thread.started`, assistant output, and `turn.completed`, then waits for input using `codexThreadId: "thread_1"`;
   - resume emits `thread.started` for the same thread, assistant output containing a redacted marker, and waits again;
   - terminal completion emits `run.completed`;
   - missing token omits `thread_id`;
   - stale token rejects resume with reason `codex_resume_session_stale`;
   - approval requested emits a fake runtime approval request token;
   - approval approved completes;
   - approval denied fails with provider denial reason;
   - approval expired supports the core expiration path by accepting rejected resolution;
   - unsupported approval bridge rejects resolution with `codex_approval_bridge_unsupported`;
   - transcript truncation emits more than 1 MiB of deterministic content without secrets;
   - secret redaction scenario includes representative `apiKey`, `authorization`, `token`, `password`, and object-key-looking values for downstream redaction tests.
4. Track state fields for assertions: `starts`, `resumes`, `resolvedApprovals`, `cancelled`, `prompts`, `commands`, `rawInputs`, `checkCalls`, `liveProviderCalls`.
5. Ensure any stored prompt/input text in fake state is either a count or a redacted marker unless a test explicitly asserts text routing. Tests must not snapshot raw secrets.

**Acceptance criteria:**
- [ ] Fake factory check succeeds without Codex binary or provider calls.
- [ ] Default fake start emits a thread/session id and waiting-for-input eligible events.
- [ ] Fake resume records the resume token and input count, not raw unbounded text.
- [ ] Missing-token and stale-token scenarios produce named failures for adapter tests.
- [ ] Approval requested/approved/denied/expired/unsupported scenarios are deterministic.
- [ ] Fake transcript scenarios can drive adapter truncation and redaction tests.
- [ ] `packages/testkit/src/index.ts` exports the fake factory and its public state/scenario types.

**Checks (must pass before GREEN):**
- `pnpm --filter @switchyard/testkit test -- fake-codex-interactive-session`
- `pnpm --filter @switchyard/testkit typecheck`

**error_rescue_map:**
- `createFakeCodexInteractiveSessionFactory.check` | Scenario requests unavailable driver | no exception | Return `ok: false` with `reasonCode: codex_interactive_driver_unsupported` | Adapter/doctor sees unavailable without spending.
- `startTurn` | Scenario missing thread id | no exception from fake | Emit provider events without `thread_id`; adapter must fail with `codex_resume_token_missing` | Run fails visibly in adapter/core tests.
- `resumeTurn` | Resume token missing or blank | `AdapterProtocolError`-shaped error or structural error with reason code | Reject with `codex_resume_token_missing` | API/events show named failure through adapter.
- `resumeTurn` | Resume token stale | reason-coded rejection | Reject with `codex_resume_session_stale` | API/events show named failure.
- `resolveApproval` | Bridge unsupported | reason-coded rejection | Reject with `codex_approval_bridge_unsupported` | Run fails visibly; registry/docs say unsupported.
- `resolveApproval` | Token not pending | reason-coded rejection | Reject with `runtime_approval_pause_not_active` | Route returns 409 through approval service.
- `cancel` | Already terminal | no exception | Mark cancellation call and return | Cancel remains idempotent.

**observability:**
- Logs: none from testkit fake by default. State counters provide deterministic observability for tests.
- Success metric: fake state `liveProviderCalls` remains `0` for every required smoke/test.
- Failure metric: any fake scenario that records a nonzero shell command or network call is a test failure.

**test_cases:**
- `default check is no spend` | `happy` | call `factory.check()` | `ok === true`, `state.liveProviderCalls.length === 0`.
- `start emits thread id and output` | `happy` | call `startTurn()` and drain events | events include `thread.started` with `thread_1` and assistant output.
- `resume records resume token` | `happy` | call `resumeTurn({ codexThreadId: "thread_1", text: "continue" })` | `state.resumes[0].codexThreadId === "thread_1"`.
- `missing token scenario` | `error_path` | start with scenario `missingToken` | events contain no usable thread id.
- `stale token scenario` | `error_path` | resume with stale scenario | promise rejects with reason `codex_resume_session_stale`.
- `approval approved scenario` | `happy` | approval scenario then resolve approved | `state.resolvedApprovals[0].decision === "approved"`.
- `approval denied scenario` | `happy` | approval scenario then resolve rejected | terminal provider event indicates denial.
- `unsupported approval bridge scenario` | `error_path` | resolve approval with unsupported scenario | rejects with `codex_approval_bridge_unsupported`.
- `transcript truncation fixture` | `edge_transcript_bounds` | start with long transcript scenario | raw event bytes exceed 1 MiB deterministically.
- `secret redaction fixture` | `edge_secret_redaction` | start with secret scenario | events contain representative secret-shaped values for adapter redaction tests.

**integration_contracts:**
- Exports:
  - `createFakeCodexInteractiveSessionFactory(scenario?: FakeCodexInteractiveScenario) => { factory: CodexInteractiveSessionFactoryLike; state: FakeCodexInteractiveState }`
  - `FakeCodexInteractiveScenario` type
  - `FakeCodexInteractiveState` type
- Imports from other tasks: none. Use structural TypeScript compatibility rather than importing adapter package types to avoid a package cycle.
- File paths consumed by other tasks:
  - `packages/testkit/src/fake-codex-interactive-session.ts` consumed by Task P15-T3 adapter tests and Task P15-T4 daemon smoke.

### Task P15-T3-codex-interactive-adapter: Add explicit local Codex interactive adapter and router

**Files (owned):**
- Create: `packages/adapters/src/codex/codex-interactive-session-factory.ts`
- Create: `packages/adapters/src/codex/codex-interactive-adapter.ts`
- Create: `packages/adapters/src/codex/codex-interactive-doctor.ts`
- Create: `packages/adapters/src/codex/codex-adapter-router.ts`
- Modify: `packages/adapters/src/codex/types.ts`
- Modify: `packages/adapters/src/index.ts`
- Create: `packages/adapters/test/codex-interactive-adapter.test.ts`
- Modify: `packages/adapters/test/codex-exec-json-adapter.test.ts`

**Dependencies:** `P15-T1-runtime-approval-session-core`, `P15-T2-fake-codex-interactive-harness`

**Context files (MUST read before coding):**
- `docs/superpowers/specs/2026-05-30-phase-15-r16-interactive-codex-and-approval-bridges.md` - interactive mode contract, reason codes, and non-goals.
- `packages/adapters/src/codex/codex-exec-json-adapter.ts` - existing one-shot behavior to preserve and helper patterns to reuse.
- `packages/adapters/src/codex/codex-jsonl-parser.ts` - Codex JSONL event normalization.
- `packages/adapters/src/substrates/process-runner.ts` - existing no-shell process runner.
- `packages/adapters/src/substrates/transcript-recorder.ts` - transcript metadata pattern.
- `packages/adapters/src/claude-code/claude-code-adapter.ts` - existing input/approval adapter behavior and transcript model.
- `packages/adapters/test/codex-exec-json-adapter.test.ts` - fake process style and one-shot regression coverage.

**Instructions:**
1. Add `CODEX_INTERACTIVE_RUNTIME_MODE_SLUG = "codex.interactive"` and typed driver contracts in `codex-interactive-session-factory.ts`. Lock these signatures:
   - `CodexInteractiveSessionFactory.check(input: { command: string; timeoutMs?: number; maxDiagnosticBytes?: number; runtimeMode?: string }) => Promise<CodexInteractiveDriverCheck>`
   - `startTurn(input: CodexInteractiveTurnInput) => Promise<CodexInteractiveTurn>`
   - `resumeTurn(input: CodexInteractiveResumeInput) => Promise<CodexInteractiveTurn>`
   - `resolveApproval(input: CodexInteractiveApprovalResolution) => Promise<void>`
   - `cancel(input: CodexInteractiveCancelInput) => Promise<void>`
   - `CodexInteractiveTurn.events() => AsyncIterable<CodexInteractiveProviderEvent>`
2. Implement a real local `CodexExecResumeJsonSessionFactory` using `spawn(command, args, { shell: false })` through `ProcessRunner`. Do not use PTY, `shell: true`, string command interpolation, app-server remote control, public terminal input, or arbitrary command execution.
3. Real driver check must be no-spend: verify binary/version, `codex exec --help` includes `--json`, and `codex exec resume --help` includes `--json`. If approval bridge is not supported by the selected driver, return availability `state: "partial"` or `state: "installed"` with `reasonCode: "codex_approval_bridge_unsupported"` and do not include `approval.bridge` in the manifest.
4. Implement `CodexInteractiveAdapter` with manifest:
   - `runtimeModeId: "runtime_mode_codex_interactive"`
   - `runtimeModeSlug: "codex.interactive"`
   - `kind: "interactive_process"`
   - `adapterType: "process"`
   - default capabilities: `run.start`, `run.input`, `run.cancel`, `run.timeout`, `session.state`, `session.resume`, `event.normalized`, `event.streaming`, `artifact.transcript`, `artifact.raw_transcript`, `auth.local`, and sandbox capabilities matching supported metadata.
   - include `approval.bridge` only when constructed with a driver capability flag that tests prove.
   - placement hosted unsupported with reason `codex.interactive is local-only in R16`.
5. Adapter start must require explicit `request.runtimeMode === "codex.interactive"`, absolute or existing cwd behavior matching current Codex policy, non-empty task, and metadata that does not inject command/process/pty/terminal options. Start the first turn, stream normalized Codex events, extract `thread_id`/session id, emit `runtime.status` with `sessionStatePatch: { codexThreadId, codexResumeMode: "exec_resume_json" }`, and enter `waiting_for_input` only after a resume token exists.
6. Adapter send must accept only:
   - `{ text: string }` for post-start input. Require active non-terminal stored session and a persisted `externalSessionKey` or `state.codexThreadId`; otherwise throw `codex_resume_token_missing`.
   - `{ type: "approval_resolution", runtimeApprovalToken, decision, message }` when a pending runtime approval token exists and the driver supports approval resolution. Unsupported bridge throws `codex_approval_bridge_unsupported`. Missing/stale token throws `runtime_approval_pause_not_active`.
7. Resume turns must use stored `codexThreadId`, call `factory.resumeTurn`, and stream events back through the same adapter event iterator. Stale driver rejection maps to `codex_resume_session_stale` and terminalizes the run with transcript artifacts.
8. Approval request mapping must convert provider approval events into Switchyard `approval.requested` with bounded/redacted payload fields: `runtimeApprovalToken`, `approvalType`, `runtimeMode`, `bridge: "codex"`, `summary`, `toolName`, bounded `toolInput`, `expiresAt` when present. Missing provider token maps to a failed run with `runtime_approval_token_missing`.
9. Transcript artifacts must include raw and normalized Codex interactive transcripts at:
   - `runs/<runId>/codex-interactive-raw-transcript.jsonl`
   - `runs/<runId>/codex-interactive-normalized-transcript.jsonl`
   Cap each at 1 MiB with deterministic `transcript.truncated` marker and metadata containing `runtime: "codex"`, `mode: "interactive"`, `runtimeMode: "codex.interactive"`, byte counts, truncation booleans, and redaction booleans.
10. Add `CodexAdapterRouter` with `id = "codex"`. `start` dispatches by `request.runtimeMode`; absent or `codex.exec_json` uses existing exec adapter, `codex.interactive` uses interactive adapter, unknown Codex mode throws `codex_runtime_mode_unsupported`. `check` dispatches by `config.runtimeMode`. `send/cancel/events/artifacts` dispatch by `session.runtimeMode` or internal `sessionId -> mode` map.
11. Do not modify `CodexExecJsonAdapter` behavior except adding regression tests. Its args, stdin close, unsupported input error, manifest limitations, and transcript path must remain byte-for-byte compatible unless tests prove the existing behavior was already flexible.

**Acceptance criteria:**
- [ ] `CodexExecJsonAdapter` tests still prove one-shot manifest, args, closed stdin, unsupported input, and transcript path.
- [ ] `CodexAdapterRouter` defaults omitted/`codex.exec_json` requests to existing exec adapter.
- [ ] `codex.interactive` start requires explicit runtime mode and never changes inference.
- [ ] Fake `codex.interactive` start emits normalized output, stores `codexThreadId`, and enters `waiting_for_input`.
- [ ] Fake post-start text resumes the stored session and emits output without raw input in logs/artifacts.
- [ ] Terminal completion prevents further input with `runtime_input_not_active`.
- [ ] Missing resume token fails with `codex_resume_token_missing`.
- [ ] Stale resume token fails with `codex_resume_session_stale`.
- [ ] Approval requested/approved/denied/expired/unsupported bridge/stale token paths are covered with fake factories.
- [ ] Unsupported real approval bridge is truthful in manifest/check limitations and throws `codex_approval_bridge_unsupported` if provider asks for approval.
- [ ] Raw and normalized transcripts are redacted, capped, and include truncation metadata.

**Checks (must pass before GREEN):**
- `pnpm --filter @switchyard/adapters test -- codex-interactive-adapter`
- `pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter`
- `pnpm --filter @switchyard/adapters test -- codex`
- `pnpm --filter @switchyard/adapters typecheck`

**error_rescue_map:**
- `CodexInteractiveAdapter.start` | runtimeMode absent or not `codex.interactive` | `AdapterProtocolError` | Throw `codex_runtime_mode_unsupported` for wrong explicit mode; router sends absent mode to exec adapter | Existing Codex callers still get `codex.exec_json`.
- `CodexInteractiveAdapter.start` | local driver check unsupported | `AdapterProtocolError` | Throw `codex_interactive_driver_unsupported` before waiting | Run fails visibly.
- `CodexInteractiveAdapter.start` | provider stream never emits thread id before wait | explicit check | Emit failed event/throw `codex_resume_token_missing` | Run fails and cannot enter waiting.
- `CodexInteractiveAdapter.send(text)` | session already terminal | `AdapterProtocolError` | Throw `runtime_input_not_active` | Route returns 409.
- `CodexInteractiveAdapter.send(text)` | text missing/blank/oversized | core/route validation before adapter or adapter protocol check | Throw `runtime_input_empty` or `runtime_input_too_large` only if route did not catch | User sees 400 from public route or 409 from internal path.
- `CodexInteractiveAdapter.send(text)` | stored resume token missing | `AdapterProtocolError` | Throw `codex_resume_token_missing` | Run/input fails visibly.
- `CodexInteractiveAdapter.send(text)` | driver rejects resume as stale | `AdapterProtocolError` | Throw/emit `codex_resume_session_stale`; persist transcript | Run fails visibly.
- `CodexInteractiveAdapter.send(approval_resolution)` | bridge unsupported | `AdapterProtocolError` | Throw `codex_approval_bridge_unsupported`; do not leave pending token active | Approval route returns 409 or run fails visibly.
- `CodexInteractiveAdapter.send(approval_resolution)` | token stale/not pending | `AdapterProtocolError` | Throw `runtime_approval_pause_not_active` | Approval route returns 409.
- `CodexInteractiveAdapter.events` | invalid JSONL/provider record | `AdapterProtocolError` or failed event | Emit `run.failed` with bounded diagnostics | Run fails visibly; transcript is preserved.
- `CodexInteractiveAdapter.artifacts` | transcript over 1 MiB | explicit cap | Persist truncated transcript with marker | User sees artifact metadata `truncated: true`.
- `CodexAdapterRouter` | session mode cannot be determined | `AdapterProtocolError` | Throw `codex_runtime_mode_unsupported` | Input/cancel fails visibly.

**observability:**
- Logs: `codex.interactive.start`, `codex.interactive.resume`, `codex.interactive.waiting_for_input`, `codex.interactive.approval_requested`, `codex.interactive.approval_resolved`, `codex.interactive.unsupported_bridge`, `codex.interactive.stale_session`, `codex.interactive.exit`, `codex.interactive.transcript_truncated`.
- Success metric: fake interactive adapter tests complete without live provider calls and produce `waiting_for_input` plus resumable session state.
- Failure metric: any artifact/log contains representative raw secrets or any adapter uses `shell: true`, PTY, terminal, or arbitrary command metadata.

**test_cases:**
- `router preserves omitted codex mode` | `happy_shadow_nil` | `start({ runtimeMode: undefined })` | exec adapter receives request and uses existing args.
- `router preserves explicit exec_json` | `happy` | `start({ runtimeMode: "codex.exec_json" })` | exec adapter receives request.
- `router rejects unknown codex mode` | `error_path` | `start({ runtimeMode: "codex.pty" })` | rejects with `codex_runtime_mode_unsupported`.
- `interactive manifest explicit local mode` | `happy` | instantiate adapter | manifest slug `codex.interactive`, hosted support `unsupported`, no public PTY capability.
- `fake start waits for input with thread id` | `happy` | fake default scenario | events include runtime output, session patch `codexThreadId`, and `waiting_for_input`.
- `fake input resumes previous session` | `happy` | send `{ text: "continue" }` after first wait | fake state records resume token and events include resumed output.
- `terminal completion blocks input` | `error_path` | terminal scenario then send text | rejects with `runtime_input_not_active`.
- `missing resume token fails before waiting` | `error_path` | fake missing-token scenario | run/event failure reason `codex_resume_token_missing`.
- `stale resume token fails visibly` | `error_path` | fake stale scenario on send | reason `codex_resume_session_stale`.
- `approval requested maps to Switchyard approval event` | `happy` | fake approval scenario | event type `approval.requested` with bounded token/type/mode/bridge.
- `approval approved resumes runtime` | `happy` | send approval resolution approved | fake state has approved decision and run completes or returns running.
- `approval denied maps provider denial` | `happy` | send rejected decision | run fails with provider denial reason or returns denial output per fake scenario.
- `approval expired resolution accepted` | `edge_expired` | send rejected expiration message | fake state records rejected resolution with expiration message.
- `unsupported approval bridge fails` | `error_path` | fake unsupported bridge emits approval | adapter fails with `codex_approval_bridge_unsupported`.
- `transcript truncates deterministically` | `edge_transcript_bounds` | fake long transcript | artifact metadata marks truncation and content contains truncation marker.
- `secret redaction` | `edge_secret_redaction` | fake secret scenario | raw/normalized artifacts and logs do not contain secret values.
- `exec-json regression unsupported input` | `error_path` | `CodexExecJsonAdapter.send()` | still throws `CodexInputUnsupportedError` reason `codex_input_unsupported`.

**integration_contracts:**
- Exports:
  - `CODEX_INTERACTIVE_RUNTIME_MODE_SLUG` constant with value `"codex.interactive"`
  - `CodexInteractiveSessionFactory` interface with methods described above.
  - `CodexExecResumeJsonSessionFactory` class implementing `CodexInteractiveSessionFactory`.
  - `CodexInteractiveAdapter` class implementing `RuntimeAdapter`.
  - `CodexAdapterRouter` class implementing `RuntimeAdapter`.
- Imports from other tasks:
  - From `P15-T1-runtime-approval-session-core`: adapter send receives `session.runtimeMode?: string` and `session.externalSessionKey?: string`.
  - From `P15-T2-fake-codex-interactive-harness`: `createFakeCodexInteractiveSessionFactory(...)` structural fake for tests.
- File paths consumed by other tasks:
  - `packages/adapters/src/codex/codex-interactive-session-factory.ts` consumed by Task P15-T4 daemon options and smoke.
  - `packages/adapters/src/codex/codex-adapter-router.ts` consumed by Task P15-T4 daemon wiring.
  - `packages/adapters/src/index.ts` consumed by app and test imports.

### Task P15-T4-daemon-registry-compatibility: Wire daemon registry, doctor, and no-spend smoke

**Files (owned):**
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`
- Modify: `packages/adapters/src/compatibility-matrix.ts`
- Modify: `packages/adapters/src/compatibility-matrix.test.ts`

**Dependencies:** `P15-T2-fake-codex-interactive-harness`, `P15-T3-codex-interactive-adapter`

**Context files (MUST read before coding):**
- `apps/daemon/src/app.ts` - current adapter map, Codex probe, registry seeding, runtime-mode capability seeding, approval service wiring, and startup recovery.
- `apps/daemon/test/smoke.test.ts` - existing no-spend daemon smoke style for Claude/OpenCode/Codex.
- `packages/core/src/services/runtime-capability-service.ts` - manifest seeding API.
- `packages/core/src/services/runtime-doctor-service.ts` - `adapter.check({ runtimeMode })` dispatch behavior.
- `packages/adapters/src/compatibility-matrix.ts` - current matrix seeds and no-spend pass/skip patterns.
- `packages/adapters/src/compatibility-matrix.test.ts` - current deterministic matrix assertions.
- `packages/testkit/src/fake-claude-code-client.ts` - existing no-spend interactive fake factory pattern to mirror when consuming the Task P15-T2 fake export.

**Instructions:**
1. Replace the daemon adapter map entry `["codex", new CodexExecJsonAdapter(...)]` with a `CodexAdapterRouter` wrapping the existing `CodexExecJsonAdapter` and a new `CodexInteractiveAdapter`.
2. Add optional `CreateDaemonAppOptions.codexInteractiveSessionFactory` and `codexInteractiveApprovalBridge` only for tests/injection. Default production/local construction uses `CodexExecResumeJsonSessionFactory` and real no-spend checks. Do not add a hosted bridge, public route, process route, or terminal route.
3. Seed both Codex runtime mode manifests through `RuntimeCapabilityService.seedManifests`: `codex.exec_json` with the current availability and `codex.interactive` with the interactive adapter check availability. If the check cannot prove `exec resume --json`, seed `codex.interactive` as `unavailable` or `partial` with `canRun: false` and reason `codex_interactive_driver_unsupported` or `codex_resume_unsupported`. If approval bridge is unsupported but input/resume is supported, seed as `partial` with `canRun: true` and limitation `codex_approval_bridge_unsupported`.
4. Keep omitted Codex runtime inference unchanged by relying on `RegistryService`: no mode still becomes `codex.exec_json`.
5. Add daemon logs for `runtime_mode.seeded` with `runtimeMode: "codex.interactive"` and low-cardinality state only.
6. Extend daemon smoke with fake Codex interactive no-spend:
   - list runtime modes includes both `codex.exec_json` and `codex.interactive`;
   - `POST /runtime-modes/codex.interactive/check` returns the fake check without binary/provider spend;
   - omitted Codex mode still stores `runtimeMode: "codex.exec_json"`;
   - explicit `codex.interactive` async run reaches `waiting_for_input`;
   - `POST /runs/:id/input` resumes and reaches `waiting_for_input` again or terminal per fake scenario;
   - fake approval request creates approval and approve/reject resolves through existing approval routes;
   - no fake state field indicates shell command, network call, live provider call, or PTY use.
7. Extend compatibility matrix with a `codex.interactive` row using fake/no-spend harness type `fake_codex_interactive_session_factory`. Its `ciStatus` should be `pass` when the fake adapter contract passes, or `skip` only if the matrix intentionally avoids running interaction. Prefer `pass` because the fake harness is deterministic.
8. Update matrix tests: expected rows include seven modes after adding `codex.interactive`; summary counts update accordingly; covered scenarios include `start_waiting_for_input`, `post_start_input`, `session_resume`, `approval_resolution_fake`, and `transcript_bounds`.

**Acceptance criteria:**
- [ ] Daemon registers a Codex router but keeps adapter id `codex`.
- [ ] Runtime-mode list exposes both `codex.exec_json` and `codex.interactive`.
- [ ] Omitted Codex create requests still infer `codex.exec_json`.
- [ ] Explicit `codex.interactive` is local-only and uses fake factory in no-spend smoke.
- [ ] Doctor/check does not report `codex.interactive.canRun=true` unless the active driver proves start/resume capability without a live prompt.
- [ ] `approval.bridge` is present in the seeded `codex.interactive` capabilities only when the constructed driver supports and tests approval resolution.
- [ ] Compatibility matrix includes deterministic no-spend coverage for `codex.interactive`.
- [ ] Daemon startup recovery still includes `waiting_for_input` and `waiting_for_approval` runs in interrupted-run reconciliation.

**Checks (must pass before GREEN):**
- `pnpm --filter @switchyard/daemon test -- smoke`
- `pnpm --filter @switchyard/adapters test -- compatibility`
- `pnpm --filter @switchyard/daemon typecheck`
- `pnpm --filter @switchyard/adapters typecheck`

**error_rescue_map:**
- `createDaemonApp` | Interactive adapter check unsupported | no exception | Seed `codex.interactive` unavailable/partial with reason; daemon still starts | User sees runtime mode unavailable/partial.
- `createDaemonApp` | Fake factory injected for tests | no exception | Seed based on fake check; no real Codex binary required | Smoke runs no-spend.
- `RuntimeDoctorService.checkRuntimeMode("codex.interactive")` | Router cannot dispatch mode | `AdapterProtocolError` or check failure | Return check with reason `codex_interactive_driver_unsupported` or `adapter_not_registered` | User sees named doctor failure.
- `POST /runtime-modes/codex.interactive/check` | Approval bridge unsupported | check details | Return partial/installed state, not false available approval support | User sees limitation.
- `compatibility matrix` | Fake interactive contract fails | thrown assertion | Row status `fail` with reason in test output | CI fails before release.
- `daemon smoke interactive input` | run never reaches waiting state | timeout in test helper | Fail smoke; no hanging open process | Implementer sees deterministic test failure.

**observability:**
- Logs: `runtime_mode.seeded` for `codex.interactive`, `runtime_mode.check` for `codex.interactive`, and existing `runtime.status.waiting`.
- Success metric: no-spend smoke confirms `fake.state.liveProviderCalls.length === 0` and `fake.state.commands.length === 0`.
- Failure metric: doctor reports `available` with `approval.bridge` while constructed driver has unsupported approval bridge.

**test_cases:**
- `runtime mode list includes interactive codex` | `happy` | daemon with fake interactive factory | `/runtime-modes` includes both Codex slugs.
- `interactive check is no spend` | `happy` | `POST /runtime-modes/codex.interactive/check` | status 200, fake check count increments, live provider count is zero.
- `omitted codex mode remains exec_json` | `happy_shadow_nil` | create Codex run without `runtimeMode` | run stores `runtimeMode: "codex.exec_json"`.
- `explicit interactive reaches waiting_for_input` | `happy` | create async `codex.interactive` fake run | run status becomes `waiting_for_input`.
- `interactive input resumes` | `happy` | post text to waiting run | fake resume count increments and run returns to waiting or terminal.
- `interactive approval approve path` | `happy` | fake emits approval request | approval pending record exists; approve sends resolution; run resumes/completes.
- `interactive approval reject path` | `happy` | fake emits approval request | reject sends rejected resolution; run fails/continues with denial per fake scenario.
- `compatibility matrix has codex interactive row` | `integration` | `generateCompatibilityMatrix()` | row slug `codex.interactive`, no-spend harness `fake_codex_interactive_session_factory`.
- `startup recovery still handles waiting statuses` | `integration` | existing sqlite recovery smoke with waiting statuses | waiting runs terminalize as `daemon_restarted`.

**integration_contracts:**
- Exports:
  - Daemon `CreateDaemonAppOptions.codexInteractiveSessionFactory?: CodexInteractiveSessionFactory`
  - Compatibility row for `runtimeModeSlug: "codex.interactive"`
- Imports from other tasks:
  - From `P15-T3-codex-interactive-adapter`: `CodexAdapterRouter`, `CodexInteractiveAdapter`, `CodexExecResumeJsonSessionFactory`, `CODEX_INTERACTIVE_RUNTIME_MODE_SLUG`.
  - From `P15-T2-fake-codex-interactive-harness`: `createFakeCodexInteractiveSessionFactory`.
- File paths consumed by other tasks:
  - `apps/daemon/src/app.ts` behavior consumed by Task P15-T5 REST integration tests and Task P15-T6 docs.

### Task P15-T5-rest-contract-boundaries: Guard REST input, approvals, hosted boundaries, and OpenAPI route surface

**Files (owned):**
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Modify: `packages/protocol-rest/src/middleware-routes.ts`
- Modify: `packages/protocol-rest/test/run-routes.test.ts`
- Modify: `packages/protocol-rest/test/middleware-routes.test.ts`
- Modify: `packages/contracts/src/openapi.contract.test.ts`

**Dependencies:** `P15-T1-runtime-approval-session-core`, `P15-T4-daemon-registry-compatibility`

**Context files (MUST read before coding):**
- `docs/superpowers/specs/2026-05-30-phase-15-r16-interactive-codex-and-approval-bridges.md` - REST behavior, non-goals, and reason-code table.
- `packages/protocol-rest/src/run-routes.ts` - create/input/cancel route validation and hosted input behavior.
- `packages/protocol-rest/src/middleware-routes.ts` - approval route error mapping.
- `packages/protocol-rest/test/run-routes.test.ts` - existing run route harness and hosted input tests.
- `packages/protocol-rest/test/middleware-routes.test.ts` - approval route tests and error mapping style.
- `packages/contracts/src/openapi.contract.test.ts` - existing public route boundary guard.
- `packages/contracts/src/endpoint-inventory.ts` - current generated route inventory.

**Instructions:**
1. In `POST /runs`, after runtime mode inference and registry lookup but before `RunService.createRun`, reject `wait=1` when `runtimeMode === "codex.interactive"` with `400 invalid_input`, detail `{ path: "wait", issue: "interactive_wait_unsupported" }`, and no durable run side effects. This is the chosen R16 wait behavior.
2. In `POST /runs`, reject explicit `placement: "hosted"` for `codex.interactive` or any mode whose registry placement facts say `hosted.support === "unsupported"` with `placement_denied` or `invalid_input` details carrying `hosted_input_unsupported` or `hosted_runtime_not_allowed`. Use existing hosted error envelope patterns; do not create a hosted bridge.
3. Keep public `POST /runs/:id/input` text-only. It must reject missing body, non-object body, missing text, non-string text, blank text, and over-64 KiB text with `400 invalid_input` before adapter dispatch.
4. Preserve `codex.exec_json` input behavior: a local one-shot Codex run receiving input returns `409 adapter_protocol_failed` with reason `codex_input_unsupported` when active, or `runtime_input_not_active` when terminal.
5. Add `codex.interactive` input tests for active waiting run, terminal run, missing session, stale session, oversized text, hosted placement, and unsupported mode. Tests can use fake services/adapters; do not need a real daemon.
6. In `middleware-routes.ts`, ensure approval expiration and stale runtime-resolution errors from Task P15-T1 map into existing envelopes: `approval_not_pending` remains 409, `AdapterProtocolError` remains `409 adapter_protocol_failed` with `details.reasonCode`.
7. Strengthen `openapi.contract.test.ts` so generated OpenAPI has no public path or operation id for `/sandbox`, `/exec`, `/pty`, `/terminal`, `/shell`, `/process`, `/command`, generic process, arbitrary process, or terminal control. Keep `/tools/invocations` allowed because R7 fake tool invocation is a shipped middleware route and policy-denies real tools.
8. Do not add any route, SDK method, CLI command, WebSocket, dashboard, TUI, terminal, or PTY surface.

**Acceptance criteria:**
- [ ] `POST /runs?wait=1` with explicit `codex.interactive` returns `400 invalid_input` and creates no run.
- [ ] `POST /runs` without `runtimeMode` for Codex still creates/infer-validates `codex.exec_json`.
- [ ] `POST /runs/:id/input` validation covers nil, empty, oversized, active, terminal, missing-session, stale-session, hosted-unsupported, and one-shot unsupported paths.
- [ ] Hosted post-start input for real hosted runs still returns `hosted_input_unsupported`.
- [ ] Hosted create for `codex.interactive` is rejected; no worker/server bridge is introduced.
- [ ] Approval approve/reject/expired/stale mappings return stable envelopes and do not leak runtime tokens.
- [ ] OpenAPI route guard proves no public terminal/PTY/sandbox/exec/shell/process route or operation id exists.

**Checks (must pass before GREEN):**
- `pnpm --filter @switchyard/protocol-rest test -- run-routes`
- `pnpm --filter @switchyard/protocol-rest test -- middleware-routes`
- `pnpm --filter @switchyard/contracts test -- openapi.contract`
- `pnpm --filter @switchyard/protocol-rest typecheck`
- `pnpm --filter @switchyard/contracts typecheck`

**error_rescue_map:**
- `POST /runs?wait=1` | `runtimeMode === "codex.interactive"` | explicit route check | Reject before create with `interactive_wait_unsupported` | User sees 400 and no run id.
- `POST /runs` | hosted placement for local-only mode | placement facts check | Reject before create with hosted/local-only reason | User sees no hosted bridge.
- `parseInputBody` | body missing/null/array/non-object | `HttpProblem` | Return `400 invalid_input` path `body` | User sees validation error.
- `parseInputBody` | `text` missing/non-string/blank | `HttpProblem` | Return `400 invalid_input` path `text` | User sees validation error.
- `parseInputBody` | text over 64 KiB | `HttpProblem` | Return `400 invalid_input` path `text` | User sees validation error.
- `POST /runs/:id/input` | terminal local run | `AdapterProtocolError` from core | Return 409 reason `runtime_input_not_active` | User sees named conflict.
- `POST /runs/:id/input` | hosted real run | explicit hosted guard | Return 409 reason `hosted_input_unsupported` | User sees named unsupported bridge.
- `approval routes` | approval expired or duplicate | `ApprovalServiceError` | Return 409 `approval_not_pending` | User sees approval cannot transition.
- `approval routes` | stale runtime pause | `AdapterProtocolError` | Return 409 with reason `runtime_approval_pause_not_active` | User sees named stale-session conflict.
- `OpenAPI generation` | forbidden route accidentally added | test assertion failure | Fail contract test | Release blocks before shipping.

**observability:**
- Logs: existing Fastify request ids and error envelope metrics. No new runtime logs in route layer.
- Success metric: no test fixture observes adapter dispatch for invalid public input bodies or `wait=1` interactive create.
- Failure metric: generated OpenAPI includes any forbidden route or operation id token.

**test_cases:**
- `wait one rejected for codex interactive` | `error_path` | `POST /runs?wait=1` with explicit `codex.interactive` | 400 with detail `interactive_wait_unsupported`, run store empty.
- `omitted codex mode remains exec_json` | `happy_shadow_nil` | `POST /runs` Codex without runtimeMode | create input uses `codex.exec_json`.
- `input body missing` | `happy_shadow_nil` | `POST /runs/:id/input` with no body | 400 invalid_input.
- `input text missing` | `happy_shadow_nil` | payload `{}` | 400 invalid_input path `text`.
- `input text blank` | `happy_shadow_empty` | payload `{ "text": "   " }` | 400 invalid_input path `text`.
- `input text oversized` | `error_path` | payload 65537 bytes | 400 invalid_input path `text`.
- `active interactive input accepted` | `happy` | waiting `codex.interactive` run and fake run service | 202 `{ accepted: true }`.
- `terminal interactive input rejected` | `error_path` | completed run | 409 reason `runtime_input_not_active`.
- `one-shot codex input unsupported` | `error_path` | active `codex.exec_json` adapter throws | 409 reason `codex_input_unsupported`.
- `hosted input unsupported` | `error_path` | hosted real run | 409 reason `hosted_input_unsupported`.
- `hosted interactive create rejected` | `error_path` | placement hosted and `codex.interactive` | create rejected before queue/runner.
- `approval expired route mapping` | `edge_expired` | approve expired approval | 409 `approval_not_pending`, stored status `expired`.
- `approval stale runtime route mapping` | `error_path` | approval service throws AdapterProtocolError | 409 reason `runtime_approval_pause_not_active`.
- `OpenAPI forbidden path guard` | `integration` | generated document | no path starts with forbidden tokens.
- `OpenAPI forbidden operation guard` | `integration` | generated document | no operation id contains forbidden execution tokens.

**integration_contracts:**
- Exports:
  - REST route behavior only; no new exported functions required.
- Imports from other tasks:
  - From `P15-T1-runtime-approval-session-core`: `ApprovalService` may throw `approval_not_pending` for expired approvals and `AdapterProtocolError` for stale runtime resolution.
  - From `P15-T4-daemon-registry-compatibility`: registry includes `codex.interactive` placement facts and mode validation.
- File paths consumed by other tasks:
  - `packages/protocol-rest/src/run-routes.ts` and `packages/protocol-rest/src/middleware-routes.ts` consumed by docs in Task P15-T6.

### Task P15-T6-docs-product-truth: Update product, development, adapter, and architecture truth

**Files (owned):**
- Modify: `PRODUCT.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/development/API.md`
- Modify: `docs/development/DEVELOPMENT.md`
- Modify: `docs/development/adapters/CODEX.md`
- Modify: `docs/adapters/codex.md`
- Modify: `ARCHITECTURE.md`

**Dependencies:** `P15-T3-codex-interactive-adapter`, `P15-T4-daemon-registry-compatibility`, `P15-T5-rest-contract-boundaries`

**Context files (MUST read before coding):**
- `docs/superpowers/specs/2026-05-30-phase-15-r16-interactive-codex-and-approval-bridges.md` - authoritative release goals/non-goals.
- `PRODUCT.md` - current product truth and roadmap status.
- `CHANGELOG.md` - release-history style.
- `docs/development/API.md` - official local API contract and runtime-mode examples.
- `docs/development/DEVELOPMENT.md` - local smoke and operator notes.
- `docs/development/adapters/CODEX.md` - Codex-specific debugging guide.
- `docs/adapters/codex.md` - high-level adapter status.
- `ARCHITECTURE.md` - target/current architecture reference.

**Instructions:**
1. Update current product truth to include `codex.interactive` only as a separate explicit local runtime mode. Keep `codex.exec_json` described as default one-shot Codex mode.
2. State exactly which `codex.interactive` capabilities shipped from implementation: post-start text input, `waiting_for_input`, bounded session-state patches, Codex resume token/session id handling, fake/no-spend approval bridge tests, and live approval bridge support only if the real driver advertises `approval.bridge`.
3. State exactly which capabilities remain unshipped: Codex TUI/PTY automation, public terminal/PTY route, hosted interactive Codex, hosted post-start input bridge, hosted approval bridge, arbitrary shell/tool execution, generic process/PTY adapter, dashboard, TUI, enterprise controls, and managed hosted platform.
4. Update API docs:
   - `runtimeMode` inference list still maps omitted Codex to `codex.exec_json`.
   - Add explicit `codex.interactive` create example using async `POST /runs`.
   - Document `POST /runs?wait=1` rejection for `codex.interactive` with `interactive_wait_unsupported`.
   - Document input validation and reason codes for `codex_input_unsupported`, `codex_resume_token_missing`, `codex_resume_session_stale`, `codex_approval_bridge_unsupported`, `runtime_approval_expired`, `hosted_input_unsupported`, and `hosted_approval_bridge_unsupported`.
5. Update development docs with no-spend fake smoke and real driver doctor notes. Required smoke commands must not send live Codex prompts by default.
6. Update Codex adapter docs with real local check requirements: `codex --version`, `codex exec --help --json`, and `codex exec resume --help --json`. Explain approval bridge truth: contract exists, fake coverage exists, real bridge only if driver supports non-PTY request/resolution.
7. Update architecture to say R16 is API/runtime-only, not UI or terminal. The adapter uses the existing runtime adapter contract and approval service, not a public PTY.
8. Update changelog with an R16 entry using the repo's style and no overclaiming.

**Acceptance criteria:**
- [ ] Docs say `codex.exec_json` remains one-shot default and unchanged.
- [ ] Docs say `codex.interactive` is explicit-only, local-only, and no-spend fake-testable.
- [ ] Docs describe exact post-start input, waiting state, session state, resume, approval, expiration, stale session, unsupported bridge, and transcript behaviors that shipped.
- [ ] Docs do not claim hosted post-start input, hosted approval, public PTY/terminal, dashboard/TUI, arbitrary shell/tool execution, managed hosted platform, or enterprise controls.
- [ ] OpenCode/AgentField/Generic HTTP docs/product truth do not claim real approval bridges unless their adapters were implemented and tested in this phase.
- [ ] Development smoke commands default to fake/no-spend and explicitly label any real Codex prompt as optional/manual.

**Checks (must pass before GREEN):**
- `rg -n "interactive Codex runtime mode promotion|Codex remains one-shot|deferred" PRODUCT.md docs/development docs/adapters ARCHITECTURE.md`
- `rg -n "/pty|/terminal|/exec|/sandbox|dashboard|TUI|hosted post-start input|managed production hosted" PRODUCT.md docs/development/API.md docs/development/DEVELOPMENT.md docs/development/adapters/CODEX.md docs/adapters/codex.md ARCHITECTURE.md`
- `git diff --check`

**error_rescue_map:**
- `PRODUCT.md current truth` | Overclaims live real Codex approval bridge | docs review failure | Phrase support conditionally based on manifest/check capability | User sees truthful product state.
- `docs/development/API.md` | Omits `wait=1` interactive rejection | docs review failure | Add explicit error envelope example | User can avoid hanging requests.
- `docs/development/DEVELOPMENT.md` | Smoke command can spend live provider budget by default | docs review failure | Use fake/no-spend smoke first and label real runs optional/manual | User avoids accidental spend.
- `docs/development/adapters/CODEX.md` | Suggests PTY/TUI/terminal workaround | docs review failure | State PTY/TUI/terminal are unshipped and out of R16 | User does not expect unsupported surfaces.
- `ARCHITECTURE.md` | Describes hosted interactive bridge as shipped | docs review failure | Keep hosted bridge in future trajectory only | Product truth stays aligned.

**observability:**
- Logs: not applicable for docs.
- Success metric: docs contain `codex.interactive` and `interactive_wait_unsupported`, and forbidden surfaces are described only as unshipped boundaries.
- Failure metric: docs contain stale "Codex interactive deferred" wording without R16 nuance or claim a hosted/TUI/PTY feature as shipped.

**test_cases:**
- `product truth lists codex interactive explicit-only` | `happy` | read `PRODUCT.md` | includes `codex.interactive` explicit local wording and default `codex.exec_json`.
- `API docs document wait rejection` | `happy` | read `docs/development/API.md` | includes `interactive_wait_unsupported`.
- `development smoke is no spend` | `happy` | read `docs/development/DEVELOPMENT.md` | fake/no-spend Codex interactive smoke is default.
- `Codex adapter docs state real approval condition` | `happy` | read `docs/development/adapters/CODEX.md` | approval bridge is conditional on non-PTY driver capability.
- `boundaries remain unshipped` | `edge_boundary_truth` | grep docs | hosted input bridge, public PTY/terminal, dashboard/TUI, arbitrary shell/tool execution are marked unshipped.
- `OpenCode AgentField Generic HTTP bridge truth` | `edge_truth_other_runtimes` | grep product/docs | no real approval bridge claim for these runtimes.

**integration_contracts:**
- Exports: none.
- Imports from other tasks:
  - From `P15-T3-codex-interactive-adapter`: final runtime-mode slug, capabilities, limitations, transcript artifact paths, reason codes.
  - From `P15-T4-daemon-registry-compatibility`: final doctor/registry behavior.
  - From `P15-T5-rest-contract-boundaries`: final REST error envelopes and `wait=1` behavior.
- File paths consumed by other tasks: none.

## Risks

- R16 intentionally spans more than 8 files. The split keeps file ownership disjoint, but integration risk is real around the router/session mode handoff and approval expiration side effects.
- Real Codex approval bridging may remain unsupported if local Codex only exposes TUI or unstable internals. The plan permits fake coverage and shared contract coverage without overclaiming live support.
- `POST /runs?wait=1` rejection for `codex.interactive` is a deliberate product choice to avoid a hung HTTP request while preserving the existing background runner model.

## Integration Points

- Task P15-T1 must land before adapter send/resume tests rely on `session.runtimeMode`.
- Task P15-T2 provides the no-spend fake factory consumed by adapter tests and daemon smoke.
- Task P15-T3 exports the adapter/router/factory contracts consumed by daemon wiring and docs.
- Task P15-T4 wires the router into the daemon and proves registry/doctor/no-spend smoke.
- Task P15-T5 locks the public route boundary and wait/input/approval behavior.
- Task P15-T6 updates truth after implementation details are stable.

Contract walk:

- `P15-T3` imports fake factory from `P15-T2`; `P15-T2` exports `createFakeCodexInteractiveSessionFactory`.
- `P15-T4` imports `CodexAdapterRouter`, `CodexInteractiveAdapter`, `CodexExecResumeJsonSessionFactory`, and `CODEX_INTERACTIVE_RUNTIME_MODE_SLUG` from `P15-T3`; `P15-T3` exports each through `packages/adapters/src/index.ts`.
- `P15-T5` relies on `P15-T4` registry placement facts for `codex.interactive`; `P15-T4` seeds the runtime mode.
- `P15-T3` relies on `P15-T1` adapter session shape including `runtimeMode`; `P15-T1` exports that behavior through `RuntimeRunnerService.adapterSession`.

## Acceptance Criteria

- [ ] `codex.exec_json` remains the inferred default for Codex requests without `runtimeMode`, and all existing Codex one-shot tests continue to pass.
- [ ] `codex.interactive` is seeded as a separate runtime mode only when explicitly addressed by slug; request validation rejects internal ids and mismatched runtime/provider/adapterType.
- [ ] The daemon/registry/doctor surfaces do not mark `codex.interactive` as runnable unless the active driver proves the required local capability without live prompt spend.
- [ ] Local `codex.interactive` supports post-start input with deterministic fake Codex session/process factories and persists `waiting_for_input` states.
- [ ] `POST /runs/:id/input` covers happy, nil, empty, oversized, terminal-run, missing-session, stale-session, unsupported-mode, and hosted-unsupported paths.
- [ ] Codex session-state patches persist `codexThreadId`/external session keys and reject non-object, secret-key, oversized, and unsafe patches.
- [ ] Codex resume succeeds in fake tests and fails visibly for missing and stale resume tokens.
- [ ] Runtime approval request, approve, deny, duplicate resolution, expiration, unsupported bridge, stale session, terminal run, and missing token are covered by deterministic tests.
- [ ] `waiting_for_approval` states are persisted for active runtime approvals and are cleared by approved/denied/expired/terminal outcomes.
- [ ] Approval payloads, resolution payloads, logs, and transcripts are redacted and bounded.
- [ ] Codex interactive raw and normalized transcript artifacts are bounded, contain truncation metadata when capped, and preserve enough event context for debugging.
- [ ] Hosted real runtime runs still reject post-start input with `hosted_input_unsupported`; hosted approval bridging remains unsupported and fail-visible.
- [ ] OpenCode/AgentField/Generic HTTP docs/manifests do not claim approval bridge support unless adapter wiring and no-spend tests exist.
- [ ] OpenAPI/route tests continue to prove no public `/sandbox`, `/exec`, `/pty`, or `/terminal` routes exist.
- [ ] Product/development docs say exactly which Codex interactive/session/approval behaviors shipped, and list dashboard, TUI, hosted input bridge, arbitrary PTY/generic process, real tools, enterprise controls, and managed production hosted platform as unshipped.

## Phase Checks

Implementation phase should run these exact checks before audit:

```bash
pnpm --filter @switchyard/testkit test -- fake-codex-interactive-session
pnpm --filter @switchyard/adapters test -- codex-interactive-adapter
pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter
pnpm --filter @switchyard/adapters test -- codex
pnpm --filter @switchyard/adapters test -- compatibility
pnpm --filter @switchyard/core test -- runtime-approval-session-r16
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/protocol-rest test -- run-routes
pnpm --filter @switchyard/protocol-rest test -- middleware-routes
pnpm --filter @switchyard/contracts test -- openapi.contract
pnpm --filter @switchyard/daemon test -- smoke
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

## Self-Review

1. Spec coverage: every spec acceptance criterion maps to at least one task above.
2. Placeholder scan: no placeholder markers or unspecified edge-case instructions remain.
3. Type consistency: cross-task contracts use `CodexInteractiveSessionFactory`, `CodexAdapterRouter`, `runtimeMode`, and approval resolution shapes consistently.
4. Ownership disjoint: no two tasks own the same file.
5. Context files real: all context files were verified in this worktree or repository root.
6. Acceptance testable: every acceptance item names a command, status, reason code, artifact path, or doc text.
7. Dependency order sane: fake harness and core session shape precede adapter; adapter precedes daemon; daemon/core precede REST/docs.
8. Checks runnable: commands use existing pnpm package scripts and current package names.
9. Error/rescue map present: every task includes explicit failure paths and user-visible results.
10. Observability present: runtime tasks include logs/metrics or deterministic fake state; docs task explains non-runtime observability.
11. Test cases enumerate acceptance: each task has happy, nil/empty, error, edge, or integration test cases tied to acceptance and rescue paths.
12. Integration contracts walk: each import from another task resolves to an export in that task.
13. Contract types match: exported/imported signatures match across task descriptions.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error_rescue_map entry has a matching error, edge, nil, empty, or integration test case.
- [x] Every integration_contracts.imports_from_other_tasks resolves to a real export elsewhere in the plan.
- [x] Every context_files path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is used.
- [x] Complexity is L; the phase is split into six disjoint tasks and the complexity concern is surfaced for architect review.
