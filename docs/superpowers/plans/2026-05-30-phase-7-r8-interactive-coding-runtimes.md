# Phase 7: R8 Interactive Coding Runtimes - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-7-r8-interactive-coding-runtimes.md`
**Spec commit:** `e99b1cb`
**Branch:** `agent/phase-7-r8-interactive-coding-runtimes`
**Worktree:** `.worktrees/native-roadmap-20260529/phase-7-r8-interactive-coding-runtimes`
**Plan target:** `docs/superpowers/plans/2026-05-30-phase-7-r8-interactive-coding-runtimes.md`
**Complexity:** M

## Goal

Ship one bounded, fake-first interactive coding-runtime release centered on `claude_code.sdk`: Switchyard can report Claude Code runtime capability, accept text post-start input for active Claude sessions, persist bounded session state, normalize approval pauses into existing approvals, store raw plus normalized transcripts, and keep Codex as `codex.exec_json` with explicit unsupported interactive semantics.

## Scope Challenge

1. Existing code already partially solves the phase through `RuntimeRunnerService`, `ApprovalService`, `RuntimeDoctorService`, runtime manifests, `POST /runs/:id/input`, `runtime_sessions.state`, artifact persistence, and the R7 approval store. R8 should extend these seams and must not add a second run loop, approval table, PTY substrate, or real tool router.
2. Minimum viable R8 is contracts plus core interaction semantics, a Claude Code adapter behind a fakeable client port, daemon registration/config/doctor wiring, REST input validation, deterministic tests, and docs. Codex one-shot resume is deferred because it is not needed to prove post-start input and would expand the adapter blast radius.
3. The phase touches more than eight files because the capability spans contracts, core, adapters, daemon, REST, and docs. This is acceptable as a medium cross-package slice because file ownership is split by existing package boundaries and no task owns another task's files.
4. Built-in and established project pieces to use: Zod enums for contract expansion, existing `AdapterProtocolError` for 409 semantics, existing run/session statuses, existing `ApprovalService`/approval store, existing event vocabulary, existing `TranscriptRecorder` and artifact content store, existing `RuntimeDoctorService` custom availability path, existing Fastify route pattern, and Vitest fake fixtures.
5. Distribution check: R8 does not add a public CLI binary or hosted artifact. If the implementation adds the official Claude Code TypeScript SDK package, the dependency and lockfile changes belong to the adapter task and must be justified by a deterministic import/adapter test. No automated check or smoke command may run a live Claude or Codex prompt by default.

## Architecture

R8 keeps the public control plane unchanged and makes the existing runtime spine understand interactive states. Adapters continue to expose `start`, `send`, `cancel`, `events`, and `artifacts`. The new convention is carried through normalized event payloads, not new top-level event types: `runtime.status` can request `waiting_for_input` or carry `sessionStatePatch`; `approval.requested` can carry a `runtimeApprovalToken`; `tool.call` and `tool.result` remain the normalized tool event types.

```text
Claude SDK or structured stream-json fake
  -> ClaudeCodeAdapter
       raw provider stream -> raw transcript
       mapped events       -> runtime.output | runtime.status | tool.call | tool.result | approval.requested | run.*
  -> RuntimeRunnerService
       sessionStatePatch -> runtime_sessions.state / externalSessionKey
       waiting status    -> runs.status + runtime_sessions.status
       approval pause    -> ApprovalService.create(...)
  -> REST/event/artifact APIs already shipped
```

Post-start input remains text-only in REST for R8:

```text
POST /runs/:id/input {"text":"continue"}
  -> validate body and non-empty text
  -> RuntimeRunnerService.sendInput
       terminal run?       -> AdapterProtocolError reasonCode runtime_input_not_active
       missing session?    -> AdapterProtocolError reasonCode runtime_session_missing
       unsupported mode?   -> adapter-specific AdapterProtocolError
       active Claude run?  -> adapter.send({ type: "user", message: ... })
  -> 202 {"accepted":true}
```

Approval bridge uses the R7 approval store. Runtime approvals are normal `approval` records whose payload includes a redacted runtime linkage. Resolving the approval calls back into the active runtime through the same `sendInput` boundary with `type: "approval_resolution"`. If the callback is gone, the resolution fails with a specific adapter protocol reason and never auto-approves.

```text
provider approval callback
  -> approval.requested(runtimeApprovalToken, approvalType, sanitized payload)
  -> ApprovalService.create pending approval
  -> run/session waiting_for_approval
  -> POST /approvals/:id/approve|reject
  -> ApprovalService emits lifecycle event
  -> RuntimeRunnerService.sendInput({ type:"approval_resolution", decision })
  -> provider resumes or fails visibly
```

## File Structure

- `packages/contracts/src/registry.ts` - expands runtime capability literals for interactive input, session state/resume, approval bridge, normalized tools, and user questions.
- `packages/contracts/test/contracts.test.ts` - proves old manifests still parse and `claude_code.sdk` parses with the new capabilities.
- `packages/core/src/services/runtime-runner-service.ts` - persists waiting states and bounded session state patches, creates runtime approval records, and normalizes send-input failures.
- `packages/core/src/services/approval-service.ts` - preserves R7 tool approval behavior and optionally sends runtime approval resolutions for linked runtime pauses.
- `packages/core/test/core.test.ts` - covers runner waiting states, session patch validation, input failure reasons, runtime approval creation, and stale callback behavior.
- `packages/core/test/middleware-services.test.ts` - covers approval resolution idempotence and runtime-resolution hooks without regressing fake tool approval flow.
- `packages/adapters/src/claude-code/*` - new Claude Code SDK/structured stream adapter, doctor, event mapper, types, and transcript handling.
- `packages/adapters/src/codex/*` - retains `codex.exec_json`, updates R8 limitation wording, and persists observed Codex thread id only as one-shot session state.
- `packages/testkit/src/fake-claude-code-*` - deterministic fake Claude client/process fixtures for streaming, input, approval, malformed event, timeout, cancel, and secret-redaction coverage.
- `apps/daemon/src/config.ts` and `apps/daemon/src/app.ts` - wires Claude config, adapter registration, registry seeding, runtime-mode inference, doctor snapshots, and approval bridge callbacks.
- `packages/protocol-rest/src/run-routes.ts` and `packages/protocol-rest/src/middleware-routes.ts` - validates text-only input and allows runtime approval answers without breaking current approve/reject bodies.
- `docs/adapters/claude-code.md`, `docs/development/adapters/CLAUDE_CODE.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, `docs/adapters/codex.md`, `docs/development/adapters/README.md`, `PRODUCT.md`, and `CHANGELOG.md` - document the shipped R8 boundary, fake/no-spend smoke, opt-in live probe, unsupported modes, and Codex no-PTY decision.

## Existing Context

`packages/core/src/ports/runtime-adapter.ts` is the contract to preserve:

```ts
start(request: Record<string, unknown>): Promise<RuntimeStartResult>;
send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void>;
events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent>;
artifacts(session: Record<string, unknown>): Promise<Artifact[]>;
```

`packages/contracts/src/run.ts` and `packages/contracts/src/session.ts` already include `waiting_for_input` and `waiting_for_approval`; R8 must make these states meaningful without adding new statuses.

`packages/protocol-rest/src/run-routes.ts` already maps `AdapterProtocolError` from `POST /runs/:id/input` to a `409 adapter_protocol_failed` envelope and should keep that response shape.

`packages/core/src/services/approval-service.ts` already persists approvals and emits `approval.requested`, `approval.approved`, and `approval.rejected`; runtime approval bridging must use this service rather than a second approval store.

`packages/adapters/src/codex/codex-exec-json-adapter.ts` currently throws `CodexInputUnsupportedError` with `reasonCode: "codex_input_unsupported"` from `send()`. R8 must keep that behavior and must not add `codex.interactive` or PTY automation.

## Task Graph

### Task P7-T1-runtime-interaction-core

`id`: `P7-T1-runtime-interaction-core`
`title`: Extend contracts and core runtime interaction semantics`

`files`:
- Modify: `packages/contracts/src/registry.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/core/src/services/runtime-runner-service.ts`
- Modify: `packages/core/src/services/approval-service.ts`
- Modify: `packages/core/test/core.test.ts`
- Modify: `packages/core/test/middleware-services.test.ts`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-30-phase-7-r8-interactive-coding-runtimes.md` - source of R8 contracts, shadow paths, and acceptance.
- `packages/contracts/src/registry.ts` - current runtime-mode capability enum and manifest schema.
- `packages/contracts/src/run.ts` - existing run statuses that must be reused.
- `packages/contracts/src/session.ts` - existing runtime session status and state shape.
- `packages/core/src/services/runtime-runner-service.ts` - current run loop, input, session, artifact, timeout, and event handling.
- `packages/core/src/services/approval-service.ts` - current R7 approval lifecycle and fake tool resolution behavior.
- `packages/core/src/services/local-policy-gate.ts` - existing exported recursive secret redaction helper.

`instructions`: Add the R8 capability literals to `runtimeCapabilitySchema`: `run.input`, `session.state`, `session.resume`, `approval.bridge`, `tool.call.normalized`, `tool.result.normalized`, and `user.question`. Update contract tests so shipped fake, Codex, Generic HTTP, AgentField, and OpenCode manifests still parse, while a new `claude_code.sdk` manifest parses with SDK kind, local conditional placement, and the interactive capabilities. Keep existing statuses, event types, runtime-mode kinds, and capability values unchanged.

Extend `RuntimeRunnerService` rather than adding a new orchestrator. It must detect normalized adapter events with `payload.status` equal to `waiting_for_input` or `waiting_for_approval` and update both the persisted run and the runtime session to the matching waiting state. When a later normal `runtime.status` or `runtime.output` arrives for the same non-terminal run, it may move waiting runs back to `running`. Terminal events continue to own final state.

Add bounded session state patch handling inside the runner. A `sessionStatePatch` payload must be a plain object, must be small enough to JSON-stringify under a fixed bound such as 16 KiB, must not be an array, and must reject keys containing case-insensitive `token`, `apiKey`, `authorization`, `password`, or `secret`. Accepted patches are recursively redacted with `redactSecrets`, merged over existing `runtime_sessions.state`, and persisted. If a patch contains a non-empty `claudeSessionId` or `codexThreadId`, store it in state; only set `externalSessionKey` when it is absent and the chosen value is a safe non-empty string.

Add an optional runtime approval bridge dependency to the runner with a minimal interface that can create approvals from adapter-emitted pauses. When the runner sees `approval.requested` with `runtimeApprovalToken`, `approvalType`, and redacted payload fields, it must create a normal pending approval through that bridge, update run/session status to `waiting_for_approval`, and publish exactly one `approval.requested` event for the persisted approval. If a runtime approval event has no `runtimeApprovalToken`, fail the run visibly with `runtime_approval_token_missing`. If no approval bridge is configured, fail the run with `runtime_approval_bridge_unconfigured`.

Extend `ApprovalService` with an optional runtime-resolution sender. For approvals whose payload includes `runtimeApprovalToken`, approval id, and run id, `approve` and `reject` should preserve the existing one-shot pending check, emit existing lifecycle events, then call the runtime sender with:

```json
{
  "type": "approval_resolution",
  "approvalId": "approval_...",
  "runtimeApprovalToken": "provider-local-token",
  "decision": "approved",
  "message": "approved by local-user"
}
```

Include `reason` as the message when provided. If the runtime sender rejects with `AdapterProtocolError`, return that error to REST and keep the approval resolved; a second approve/reject attempt must still return `approval_not_pending`. Existing fake tool approval resolution must remain green.

Tighten `RuntimeRunnerService.sendInput`: terminal runs throw `AdapterProtocolError` with `reasonCode: "runtime_input_not_active"`; missing session throws `reasonCode: "runtime_session_missing"`; empty text input throws `reasonCode: "runtime_input_empty"` if it reaches core; adapter-specific unsupported input reason codes pass through from adapters. The runner should not mutate run status after a failed input attempt.

`acceptance`:
- New R8 capability literals parse and shipped runtime manifests remain backward compatible.
- `claude_code.sdk` manifest fixture parses with `run.input`, `session.state`, `approval.bridge`, `tool.call.normalized`, `tool.result.normalized`, `user.question`, streaming events, and transcript capabilities.
- Runner persists `waiting_for_input` and `waiting_for_approval` on normalized adapter status events.
- Runner merges safe `sessionStatePatch` objects into `runtime_sessions.state` and rejects arrays, oversized patches, functions, and secret-bearing keys.
- Runtime approval pauses create normal pending approval records and mark run/session waiting.
- Missing runtime approval token and missing approval bridge fail the run visibly with specific reason codes.
- Approval approve/reject sends `approval_resolution` input for linked runtime approvals while preserving R7 fake tool approval behavior.
- `sendInput` returns specific `AdapterProtocolError` reason codes for terminal runs, missing sessions, empty input, and adapter unsupported modes.

`checks`:
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/core test -- core`
- `pnpm --filter @switchyard/core test -- middleware-services`
- `pnpm --filter @switchyard/core typecheck`

`error_rescue_map`:
- `{ codepath: "runtimeCapabilitySchema", failure: "new capability is missing or old capability is renamed", exception: "ZodError in manifest parsing", rescue: "add only the R8 literals and keep all old enum values", user_sees: "runtime-mode APIs keep old modes and can show claude_code.sdk capabilities" }`
- `{ codepath: "RuntimeRunnerService.handleWaitingStatus", failure: "adapter emits waiting status but persisted run remains running", exception: "no throw; state drift", rescue: "update run and session status before publishing the normalized event", user_sees: "GET /runs/:id shows waiting_for_input or waiting_for_approval" }`
- `{ codepath: "RuntimeRunnerService.mergeSessionStatePatch", failure: "patch is null, array, oversized, function-bearing, or secret-keyed", exception: "AdapterProtocolError or run.failed payload reason", rescue: "reject patch, redact payload, fail run when patch came from provider event", user_sees: "run.failed with bounded reason instead of leaked or corrupt state" }`
- `{ codepath: "RuntimeRunnerService.handleRuntimeApproval", failure: "runtime approval token missing", exception: "AdapterProtocolError reasonCode runtime_approval_token_missing", rescue: "fail run and session, append run.failed", user_sees: "approval pause is not left hanging" }`
- `{ codepath: "RuntimeRunnerService.handleRuntimeApproval", failure: "approval bridge not configured", exception: "AdapterProtocolError reasonCode runtime_approval_bridge_unconfigured", rescue: "fail run and session", user_sees: "visible failed run instead of an indefinite wait" }`
- `{ codepath: "ApprovalService.resolve runtime sender", failure: "provider callback already closed", exception: "AdapterProtocolError reasonCode runtime_approval_pause_not_active", rescue: "surface 409 through REST; do not retry or auto-approve", user_sees: "approval is resolved but runtime resolution failure is explicit" }`
- `{ codepath: "RuntimeRunnerService.sendInput", failure: "terminal run, missing session, empty text, unsupported adapter, or closed provider queue", exception: "AdapterProtocolError with specific reasonCode", rescue: "return 409 through existing REST mapping except body validation handled by REST", user_sees: "named reasonCode and unchanged run state" }`

`observability`:
- `logs`: `runtime.status.waiting`, `runtime.session_state.updated`, `runtime.session_state_rejected`, `runtime.approval.requested`, `runtime.approval_resolution.sent`, `runtime.input.rejected`; logs include run id, session id, approval id, reason code, and no raw secrets.
- `success_metric`: core tests prove waiting-state persistence, state patch persistence, approval pause/resolution, and explicit unsupported input reason codes.
- `failure_metric`: any provider interaction shadow path produces a named run failure or `AdapterProtocolError` rather than a hanging run.

`test_cases`:
- `{ name: "claude manifest capability parses", lens: "happy", given: "runtimeModeSchema.parse claude_code.sdk fixture", expect: "capabilities include run.input, session.state, approval.bridge, tool.call.normalized, tool.result.normalized, user.question" }`
- `{ name: "old manifests still parse", lens: "integration", given: "fake/codex/generic_http/agentfield/opencode manifest fixtures", expect: "no ZodError and existing capability arrays unchanged except wording-only Codex limitations" }`
- `{ name: "runner persists waiting for input", lens: "happy", given: "adapter emits runtime.status status waiting_for_input", expect: "run.status and session.status become waiting_for_input" }`
- `{ name: "runner persists waiting for approval", lens: "happy", given: "adapter emits runtime.status status waiting_for_approval", expect: "run.status and session.status become waiting_for_approval" }`
- `{ name: "session state patch stored", lens: "happy", given: "runtime.status with sessionStatePatch claudeSessionId", expect: "runtime_sessions.state.claudeSessionId stored and externalSessionKey set when empty" }`
- `{ name: "session state patch rejects nil", lens: "happy_shadow_nil", given: "sessionStatePatch null", expect: "no state mutation and bounded warning or failed run per event source" }`
- `{ name: "session state patch rejects empty", lens: "happy_shadow_empty", given: "sessionStatePatch {}", expect: "no state mutation and run continues" }`
- `{ name: "session state patch rejects secret key", lens: "error_path", given: "sessionStatePatch contains apiKey or authorization", expect: "run.failed with session_state_patch_rejected and no secret in events" }`
- `{ name: "runtime approval creates approval", lens: "happy", given: "approval.requested with runtimeApprovalToken", expect: "pending approval persisted and run/session waiting_for_approval" }`
- `{ name: "approval token missing fails", lens: "error_path", given: "approval.requested without runtimeApprovalToken", expect: "run.failed with runtime_approval_token_missing" }`
- `{ name: "approval bridge missing fails", lens: "error_path", given: "runtime approval with no bridge dependency", expect: "run.failed runtime_approval_bridge_unconfigured" }`
- `{ name: "approval approve sends runtime resolution", lens: "integration", given: "pending runtime approval approved", expect: "runtime sender receives approval_resolution approved" }`
- `{ name: "approval reject sends runtime resolution", lens: "integration", given: "pending runtime approval rejected", expect: "runtime sender receives approval_resolution rejected" }`
- `{ name: "approval not pending remains one shot", lens: "error_path", given: "approve same approval twice", expect: "second call rejects approval_not_pending and sends no second runtime input" }`
- `{ name: "send input after terminal", lens: "error_path", given: "completed run then sendInput", expect: "AdapterProtocolError reasonCode runtime_input_not_active" }`
- `{ name: "send input missing session", lens: "error_path", given: "running run without runtime session", expect: "AdapterProtocolError reasonCode runtime_session_missing" }`

`integration_contracts`:
- `exports`:
  - `{ name: "RuntimeRunnerService", kind: "class", signature: "start(run) persists waiting states, sessionStatePatch, runtime approvals, artifacts, and terminal events; sendInput(runId, input) => Promise<void>" }`
  - `{ name: "ApprovalService", kind: "class", signature: "create(input), approve(id, input), reject(id, input); runtime-linked approvals optionally send approval_resolution through a runtime sender" }`
  - `{ name: "RuntimeApprovalBridge", kind: "type", signature: "createRuntimeApproval(input) => Promise<Approval>" }`
  - `{ name: "RuntimeApprovalResolutionSender", kind: "type", signature: "sendRuntimeApprovalResolution(runId, input) => Promise<void>" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/core/src/services/runtime-runner-service.ts`
  - `packages/core/src/services/approval-service.ts`
  - `packages/contracts/src/registry.ts`

### Task P7-T2-claude-code-adapter

`id`: `P7-T2-claude-code-adapter`
`title`: Add fake-first Claude Code adapter and preserve Codex one-shot boundary`

`files`:
- Create: `packages/adapters/src/claude-code/types.ts`
- Create: `packages/adapters/src/claude-code/claude-code-adapter.ts`
- Create: `packages/adapters/src/claude-code/claude-code-doctor.ts`
- Create: `packages/adapters/src/claude-code/claude-code-event-mapper.ts`
- Create: `packages/adapters/src/claude-code/index.ts`
- Modify: `packages/adapters/src/index.ts`
- Modify: `packages/adapters/src/substrates/transcript-recorder.ts`
- Modify: `packages/adapters/src/codex/codex-exec-json-adapter.ts`
- Modify: `packages/adapters/src/codex/codex-jsonl-parser.ts`
- Create: `packages/adapters/test/claude-code-adapter.test.ts`
- Modify: `packages/adapters/test/codex-exec-json-adapter.test.ts`
- Modify: `packages/adapters/test/runtime-adapter-contracts.test.ts`
- Create: `packages/testkit/src/fake-claude-code-client.ts`
- Create: `packages/testkit/src/fake-claude-code-cli.ts`
- Modify: `packages/testkit/src/index.ts`
- Modify: `packages/testkit/package.json`
- Modify if SDK dependency is added: `packages/adapters/package.json`
- Modify if SDK dependency is added: `pnpm-lock.yaml`

`dependencies`: ["P7-T1-runtime-interaction-core"]

`context_files`:
- `docs/superpowers/specs/2026-05-30-phase-7-r8-interactive-coding-runtimes.md` - adapter requirements, no-spend constraints, and event mappings.
- `packages/core/src/ports/runtime-adapter.ts` - adapter interface and manifest shape.
- `packages/adapters/src/codex/codex-exec-json-adapter.ts` - process adapter, transcript, unsupported input, and manifest pattern to preserve.
- `packages/adapters/src/opencode/opencode-acp-adapter.ts` - structured local runtime with doctor, cancellation, transcript, and external session key pattern.
- `packages/adapters/src/substrates/transcript-recorder.ts` - existing transcript helper to reuse and extend with R8 metadata.
- `packages/testkit/src/fake-runtime-adapter.ts` - deterministic fake runtime style and unsupported input behavior.
- `packages/testkit/src/runtime-adapter-contract-harness.ts` - shared adapter contract tests to update for `run.input`.

`instructions`: Create `packages/adapters/src/claude-code/` around a small `ClaudeCodeClient` port so tests never need the real SDK or CLI. The default adapter must target `runtimeModeSlug: "claude_code.sdk"`, `runtimeModeId: "runtime_mode_claude_code_sdk"`, `providerId: "provider_anthropic"`, `runtimeId: "runtime_claude_code"`, `adapterId: "claude_code"`, `adapterType: "native"`, and `kind: "sdk"`. Its manifest must include `run.start`, `run.cancel`, `run.timeout`, `run.input`, `session.state`, `approval.bridge`, `event.normalized`, `event.streaming`, `artifact.transcript`, `artifact.raw_transcript`, `tool.call.normalized`, `tool.result.normalized`, `user.question`, and `auth.local`. Placement is local `conditional`, hosted `unsupported`, connected local node `future`.

Prefer the official Claude Code TypeScript SDK for the production client when the package and API can be verified in the implementation worktree. Isolate all SDK-specific imports in one loader/client file and keep tests on the fake client. If the SDK dependency is added, update `packages/adapters/package.json` and `pnpm-lock.yaml`, and add a no-model-spend import/client-construction test. If the SDK cannot be used safely, implement only a structured `claude -p --output-format stream-json --input-format stream-json` fallback if fake process tests prove post-start input, session id, and transcript behavior. Do not implement plain text parsing, terminal scraping, PTY automation, broad shell permissions, or any live prompt in tests.

The adapter must validate absolute `cwd`, non-empty task, text-only input, supported permission mode, and safe tool configuration. Default permission posture is read-only or plan-like. Reject any metadata attempting dangerous bypass flags such as `dangerously-skip-permissions` with `AdapterProtocolError` reason `claude_permission_bypass_denied`. Write/shell/bypass behavior is not accepted from untrusted run metadata.

Map fake SDK/stream events deterministically:

```json
{ "type": "assistant_text_delta", "text": "hello" }
{ "type": "session", "sessionId": "claude-session-1" }
{ "type": "tool_call", "id": "tool-1", "name": "Bash", "input": { "command": "pwd" } }
{ "type": "tool_result", "id": "tool-1", "status": "completed", "output": "ok" }
{ "type": "approval_required", "token": "pause-1", "approvalType": "before_destructive_command", "toolName": "Bash", "toolInput": { "command": "rm tmp.txt" } }
{ "type": "ask_user_question", "token": "question-1", "question": "Pick an option", "options": ["A", "B"] }
{ "type": "completed", "usage": { "inputTokens": 1, "outputTokens": 2 } }
```

Expected normalized outputs: text deltas become `runtime.output`; session events become `runtime.status` with `sessionStatePatch`; tool starts/results become `tool.call` and `tool.result`; approval and question pauses become `approval.requested` with redacted payload; completion/failure/cancel become terminal run events. Unknown provider events become bounded `runtime.status` with `status: "provider_event_unknown"` and no raw secrets. Malformed JSON in stream-json fallback yields `run.failed` with `reasonCode: "claude_stream_malformed"`.

Implement `send()` for active Claude sessions. For `{ text: "continue" }`, enqueue a structured SDK user message shaped like the spec. For `{ type: "approval_resolution", ... }`, resolve the stored provider approval callback if still active; if not active, throw `AdapterProtocolError` with `reasonCode: "runtime_approval_pause_not_active"`. If the input queue is closed, throw `reasonCode: "claude_input_queue_closed"`. `cancel()` must be idempotent and make fake sessions emit or settle as cancelled.

Artifacts must include two transcript artifacts when content exists:

- `runs/<runId>/claude-code-raw-transcript.jsonl`
- `runs/<runId>/claude-code-normalized-transcript.jsonl`

Both artifact metadata records include `runtime: "claude_code"`, `mode: "sdk"`, `runtimeMode: "claude_code.sdk"`, `transcriptVersion: "r8.v1"`, and a redaction marker. The normalized transcript includes start, output, status, input accepted, tool call, tool result, approval pause, approval resolution, terminal, warning, and provider error entries. Secret redaction tests must scan JSON-stringified events, artifacts, and transcripts for fake auth tokens.

Update Codex only within the one-shot boundary. Keep `send()` returning `CodexInputUnsupportedError` with `reasonCode: "codex_input_unsupported"`. Update stale R3 limitation wording to R8 wording. Do not add `codex.interactive`, PTY, or default resume. If `codex-jsonl-parser` sees a `thread_id`, include `sessionStatePatch: { codexThreadId: "..." }` on the normalized status event so core can persist observed one-shot state.

`acceptance`:
- `ClaudeCodeAdapter.manifest` declares the exact `claude_code.sdk` mode, SDK kind, local conditional placement, no hosted support, and required R8 capabilities.
- Claude doctor/check performs no model prompt by default and returns installed/auth/live-probe state with redacted diagnostics.
- Fake Claude tests cover start, streaming output, post-start input, session id persistence, approval pause/resume, approval reject, AskUserQuestion mapping, empty output, malformed event failure, timeout, cancel, transcript artifacts, artifact metadata, and secret redaction.
- `send()` accepts text input for active fake Claude sessions and records a normalized transcript input acknowledgement.
- Approval resolution input resumes or denies the fake provider callback and stale resolution returns `runtime_approval_pause_not_active`.
- Adapter contract harness passes for Claude without calling a real provider.
- Existing Codex adapter tests remain green and prove `codex.exec_json` still omits `run.input`, `approval.bridge`, and PTY support.
- Optional SDK dependency additions are covered by fake/no-spend tests and do not run live prompts.

`checks`:
- `pnpm --filter @switchyard/adapters test -- claude-code-adapter`
- `pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter`
- `pnpm --filter @switchyard/adapters test -- runtime-adapter-contracts`
- `pnpm --filter @switchyard/testkit test`
- `pnpm --filter @switchyard/adapters typecheck`
- `pnpm --filter @switchyard/testkit typecheck`

`error_rescue_map`:
- `{ codepath: "ClaudeCodeAdapter.start", failure: "cwd is relative, task is empty, unsupported permission mode, unsafe tool config, or dangerous bypass flag", exception: "AdapterProtocolError with claude_* reasonCode", rescue: "reject before provider client starts", user_sees: "409 adapter_protocol_failed with reasonCode and no provider side effect" }`
- `{ codepath: "ClaudeCodeDoctor.check", failure: "command missing, SDK import fails, auth missing, empty output, timeout, output too large, or auth JSON malformed", exception: "bounded check result, no throw for expected checks", rescue: "return unavailable, installed, partial, or unknown with redacted diagnostics", user_sees: "runtime-mode check response with no secret leakage and no prompt spend" }`
- `{ codepath: "ClaudeCodeEventMapper.map", failure: "provider event is null, missing type, unknown type, malformed stream JSON, or empty output", exception: "run.failed for malformed JSON; runtime.status provider_event_unknown for unknown structured object", rescue: "emit bounded normalized event and preserve captured raw bytes", user_sees: "visible failed run or warning status plus transcript" }`
- `{ codepath: "ClaudeCodeAdapter.send text", failure: "missing session, terminal session, empty text, closed input queue", exception: "AdapterProtocolError reasonCode claude_session_missing, runtime_input_not_active, runtime_input_empty, or claude_input_queue_closed", rescue: "do not mutate transcript except optional rejected-input marker with redacted reason", user_sees: "409 adapter_protocol_failed or core validation failure" }`
- `{ codepath: "ClaudeCodeAdapter.send approval_resolution", failure: "runtimeApprovalToken not active or provider callback throws", exception: "AdapterProtocolError reasonCode runtime_approval_pause_not_active or claude_approval_resolution_failed", rescue: "record normalized failure marker and surface protocol error", user_sees: "approval resolution failure is explicit" }`
- `{ codepath: "ClaudeCodeAdapter.cancel", failure: "cancel after terminal or provider cancel exception", exception: "none for idempotent terminal; AdapterProtocolError for active unverified cancel", rescue: "terminal sessions no-op; active fake emits run.cancelled or protocol error", user_sees: "cancel remains idempotent for terminal runs" }`
- `{ codepath: "Claude transcript artifacts", failure: "artifact path unsafe, content empty, or transcript contains fake secret", exception: "test failure or AdapterProtocolError before artifact return", rescue: "safe relative paths, empty-output marker, recursive redaction before content and metadata", user_sees: "artifact list contains safe raw/normalized transcript without secrets" }`
- `{ codepath: "CodexExecJsonAdapter", failure: "R8 changes accidentally add interactive claims", exception: "manifest test failure", rescue: "keep one-shot manifest and CodexInputUnsupportedError", user_sees: "Codex input continues to return codex_input_unsupported" }`

`observability`:
- `logs`: `claude_code.check`, `claude_code.start`, `claude_code.input.accepted`, `claude_code.approval.pause`, `claude_code.approval.resolved`, `claude_code.cancel`, `claude_code.stream_error`, `claude_code.transcript.persisted`; logs include ids and reason codes only.
- `success_metric`: fake Claude adapter contract and focused adapter tests pass without live SDK/CLI prompt spend.
- `failure_metric`: malformed provider events, stale approvals, closed queues, unsafe config, and secret-redaction cases fail with named reason codes and bounded transcripts.

`test_cases`:
- `{ name: "manifest exposes claude sdk mode", lens: "happy", given: "new ClaudeCodeAdapter()", expect: "manifest slug claude_code.sdk, kind sdk, capabilities include run.input/session.state/approval.bridge and hosted unsupported" }`
- `{ name: "doctor no live prompt disabled", lens: "happy_shadow_empty", given: "check with liveProbe false and fake version/auth probes", expect: "installed or partial with reasonCode live_probe_disabled and no prompt invocation" }`
- `{ name: "doctor command missing", lens: "happy_shadow_nil", given: "fake version probe binary unavailable", expect: "availability unavailable reasonCode binary_unavailable" }`
- `{ name: "fake streaming output", lens: "happy", given: "fake event assistant_text_delta then completed", expect: "runtime.output then run.completed" }`
- `{ name: "fake post-start input", lens: "happy", given: "active fake session and send text continue", expect: "structured user message queued and normalized transcript input accepted entry" }`
- `{ name: "fake session state", lens: "happy", given: "fake session event with sessionId", expect: "runtime.status has sessionStatePatch.claudeSessionId" }`
- `{ name: "fake approval approve", lens: "happy", given: "approval_required then approval_resolution approved", expect: "approval pause event, callback allow path, run completes" }`
- `{ name: "fake approval reject", lens: "happy", given: "approval_required then approval_resolution rejected", expect: "callback deny path and terminal provider-denied status or failed event per fixture" }`
- `{ name: "fake user question", lens: "integration", given: "ask_user_question event", expect: "approval.requested approvalType before_external_message with responseFormat ask_user_question" }`
- `{ name: "empty provider output", lens: "happy_shadow_empty", given: "fake provider completes without text", expect: "run.completed and normalized transcript empty_output true" }`
- `{ name: "malformed stream json", lens: "error_path", given: "fake stream-json line not JSON", expect: "run.failed reasonCode claude_stream_malformed and raw transcript captured" }`
- `{ name: "input after closed queue", lens: "error_path", given: "send after fake provider terminal", expect: "AdapterProtocolError claude_input_queue_closed or runtime_input_not_active" }`
- `{ name: "stale approval resolution", lens: "error_path", given: "approval_resolution after callback removed", expect: "AdapterProtocolError runtime_approval_pause_not_active" }`
- `{ name: "cancel active fake", lens: "error_path", given: "cancel before completion", expect: "run.cancelled and transcript terminal cancelled marker" }`
- `{ name: "secret redaction", lens: "edge_security", given: "fake auth token in provider event and auth output", expect: "no raw token in events, logs captured by test, transcripts, or artifact metadata" }`
- `{ name: "codex remains one shot", lens: "integration", given: "CodexExecJsonAdapter manifest and send", expect: "no run.input/approval.bridge/PTY capability and send throws codex_input_unsupported" }`
- `{ name: "codex thread state patch", lens: "happy", given: "thread.started JSONL with thread_id", expect: "runtime.status payload includes sessionStatePatch.codexThreadId" }`

`integration_contracts`:
- `exports`:
  - `{ name: "CLAUDE_CODE_RUNTIME_MODE_SLUG", kind: "constant", signature: "\"claude_code.sdk\"" }`
  - `{ name: "ClaudeCodeAdapter", kind: "class", signature: "new ClaudeCodeAdapter(options?: ClaudeCodeAdapterOptions) implements RuntimeAdapter" }`
  - `{ name: "checkClaudeCodeAvailability", kind: "function", signature: "(options: ClaudeCodeDoctorOptions) => Promise<RuntimeAdapterCheck>" }`
  - `{ name: "mapClaudeCodeEventToSwitchyardEvent", kind: "function", signature: "(event, context) => SwitchyardEvent" }`
  - `{ name: "createFakeClaudeCodeClient", kind: "function", signature: "(scenario) => ClaudeCodeClient for deterministic tests" }`
- `imports_from_other_tasks`:
  - `{ from_task: "P7-T1-runtime-interaction-core", name: "RuntimeRunnerService", signature: "consumes runtime.status sessionStatePatch and approval.requested payload convention emitted by ClaudeCodeAdapter" }`
- `file_paths_consumed_by_other_tasks`:
  - `packages/adapters/src/claude-code/index.ts`
  - `packages/testkit/src/fake-claude-code-client.ts`
  - `packages/adapters/src/codex/codex-exec-json-adapter.ts`

### Task P7-T3-daemon-rest-wiring

`id`: `P7-T3-daemon-rest-wiring`
`title`: Wire Claude runtime mode through daemon, REST validation, doctor, and smoke tests`

`files`:
- Modify: `packages/core/src/services/registry-service.ts`
- Modify: `packages/core/test/registry-service.test.ts`
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Modify: `packages/protocol-rest/src/middleware-routes.ts`
- Modify: `packages/protocol-rest/test/run-routes.test.ts`
- Modify: `packages/protocol-rest/test/middleware-routes.test.ts`
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`

`dependencies`: ["P7-T1-runtime-interaction-core", "P7-T2-claude-code-adapter"]

`context_files`:
- `docs/superpowers/specs/2026-05-30-phase-7-r8-interactive-coding-runtimes.md` - REST, daemon, doctor, config, and smoke requirements.
- `packages/protocol-rest/src/run-routes.ts` - current run creation, runtime-mode inference, input route, and error mapping.
- `packages/protocol-rest/src/middleware-routes.ts` - current approval approve/reject route bodies and service error mapping.
- `packages/core/src/services/registry-service.ts` - current runtime-mode inference rules.
- `packages/core/src/services/runtime-doctor-service.ts` - current custom adapter availability mapping and redaction.
- `apps/daemon/src/config.ts` - current daemon environment config pattern.
- `apps/daemon/src/app.ts` - current adapter map, registry seeding, capability seeding, doctor, runner, approvals, and middleware wiring.
- `apps/daemon/test/smoke.test.ts` - daemon smoke expectations for seeded modes, checks, artifacts, persistence, and unsupported input.

`instructions`: Add runtime-mode inference for `runtime: "claude_code"` with `adapterType: "native"` to `claude_code.sdk`. Keep all existing inference rules unchanged and continue rejecting runtime-mode ids such as `runtime_mode_claude_code_sdk` in request bodies.

Tighten `parseInputBody` in `packages/protocol-rest/src/run-routes.ts` for R8 text-only input. Missing body, non-object body, missing `text`, non-string `text`, empty text, or whitespace-only text must return `400 invalid_input` with details path `body` or `text`. Valid text bodies pass through as `{ text }`. Approval resolution objects are internal core-to-adapter inputs and are not accepted by the public run input endpoint.

Optionally extend approval approve/reject route bodies with `answers` only if it can be added without breaking current `{ actor, reason }` callers. If added, `answers` must be an object, recursively redacted by `ApprovalService`, and forwarded only for runtime approvals with `responseFormat: "ask_user_question"`. If not added, tests and docs must prove text-only question response semantics through `reason`.

Add Claude daemon config:

- `SWITCHYARD_CLAUDE_CODE_COMMAND`, default `claude`
- `SWITCHYARD_CLAUDE_CODE_LIVE_PROBE`, default `0`
- `SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD`, default bounded and nonzero only for explicit live probe
- `SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS`, default `5000`

Instantiate `ClaudeCodeAdapter` with daemon config and logger. For tests, allow `createDaemonApp` options to inject a fake Claude client/probe so daemon smoke does not use the real SDK, CLI, or model. Seed `provider_anthropic`, `runtime_claude_code`, `model_claude_code_default`, and `runtime_mode_claude_code_sdk`. Initial availability should be `unknown` or `installed/partial` according to no-spend check inputs, with `reasonCode: "live_probe_disabled"` when live probe is off. Register the manifest with `RuntimeCapabilityService` alongside existing fake, Codex, AgentField, Generic HTTP, and OpenCode modes.

Wire the runtime approval bridge without creating a second approval store. The runner should be able to create runtime approvals through the same `ApprovalService`, and `ApprovalService` should be able to send runtime resolution input through the active runner. Preserve existing fake tool approval routing through `ToolRouter`.

Update daemon smoke tests:

- runtime modes list includes `claude_code.sdk` plus existing five modes.
- `GET /runtime-modes/claude_code.sdk` returns the expected manifest and local conditional placement.
- `POST /runtime-modes/claude_code.sdk/check` uses fake/no-spend probes and reports live probe disabled without secrets.
- async fake Claude run accepts `POST /runs/:id/input` while active and later completes.
- fake Claude approval pause persists an approval, marks run/session waiting, approve resumes, reject denies, stale resolution returns 409.
- artifact retrieval returns raw and normalized Claude transcript artifacts with content stored when filesystem artifact store is configured.
- existing unsupported input tests still return adapter-specific reason codes for fake, Codex, AgentField, Generic HTTP, and OpenCode.

`acceptance`:
- Runtime-mode inference accepts `claude_code.sdk` for `claude_code/native` and keeps all prior inference behavior.
- `POST /runs/:id/input` returns `400 invalid_input` for missing, non-object, missing text, non-string text, empty text, and whitespace-only text.
- `POST /runs/:id/input` returns `202` for active fake-backed Claude sessions and appends an input acknowledgement to the normalized transcript.
- `POST /runs/:id/input` returns existing `409 adapter_protocol_failed` reason codes for unsupported modes and terminal Claude runs.
- Daemon config loads Claude env vars with safe defaults and does not enable live prompt probes by default.
- Daemon seeds Claude provider/runtime/model/runtime-mode records without breaking fake/Codex/OpenCode/AgentField/Generic HTTP seeding.
- Runtime doctor summary and active check include Claude Code state and do not crash when Claude is missing, auth missing, SDK import fails, or live probe disabled.
- Runtime approval pause/resolution works through existing REST approval endpoints and stale resolution fails visibly.
- Filesystem artifact smoke can retrieve Claude raw and normalized transcript artifacts.

`checks`:
- `pnpm --filter @switchyard/core test -- registry-service`
- `pnpm --filter @switchyard/protocol-rest test -- run-routes`
- `pnpm --filter @switchyard/protocol-rest test -- middleware-routes`
- `pnpm --filter @switchyard/daemon test -- smoke`
- `pnpm --filter @switchyard/protocol-rest typecheck`
- `pnpm --filter @switchyard/daemon typecheck`

`error_rescue_map`:
- `{ codepath: "RegistryService.inferAndValidateRuntimeMode", failure: "Claude runtime mode omitted or internal id supplied", exception: "RuntimeModeValidationError", rescue: "infer claude_code.sdk for claude_code/native; reject runtime_mode_* ids with invalid_input", user_sees: "valid Claude run bodies work and invalid mode ids get 400" }`
- `{ codepath: "parseInputBody", failure: "missing body, non-object body, missing text, non-string text, empty text, whitespace text", exception: "HttpProblem invalid_input", rescue: "return path-specific details before core", user_sees: "400 invalid_input without touching run state" }`
- `{ codepath: "createDaemonApp Claude config", failure: "SDK import fails, command missing, auth missing, live probe disabled", exception: "bounded RuntimeAdapterCheck result", rescue: "seed mode with unavailable, installed, partial, or unknown and redacted reasonCode", user_sees: "daemon starts and doctor reports actionable Claude state" }`
- `{ codepath: "seedClaudeRegistry", failure: "provider/runtime/model/mode already exist from prior daemon start", exception: "unique constraint or stale record", rescue: "use existing create/update pattern and upsert manifest", user_sees: "restarting daemon preserves registry and updates availability" }`
- `{ codepath: "approval bridge wiring", failure: "runner and approval service need each other", exception: "undefined callback or runtime_approval_bridge_unconfigured", rescue: "wire through narrow closure or optional sender after both services exist; add smoke coverage", user_sees: "runtime approvals create normal approvals and resolve through existing endpoints" }`
- `{ codepath: "daemon smoke fake Claude run", failure: "async run completes before input can be sent", exception: "409 runtime_input_not_active", rescue: "fake client scenario waits for input before completion", user_sees: "supported input path is testable deterministically" }`
- `{ codepath: "artifact retrieval", failure: "transcript metadata content not stored or path unsafe", exception: "artifact route 404 missing_artifact_content or artifact path error", rescue: "use existing artifact content store and safe `runs/<runId>/...` paths", user_sees: "GET /artifacts/:id/content streams transcript bytes" }`

`observability`:
- `logs`: `runtime_mode.seeded` for `claude_code.sdk`, `claude_code.check`, `runtime.input.accepted`, `runtime.input.rejected`, `runtime.approval.bridge_configured`, `runtime.approval.bridge_failed`, and artifact persistence warnings with no secrets.
- `success_metric`: daemon smoke proves Claude runtime-mode discovery/check, fake run input, approval approve/reject, stale resolution, transcript retrieval, and all prior mode seeds.
- `failure_metric`: invalid public input returns 400, unsupported modes return 409 with reasonCode, missing Claude binary/check failures are reflected in doctor without daemon crash.

`test_cases`:
- `{ name: "infer claude runtime mode", lens: "happy", given: "POST /runs with runtime claude_code adapterType native and no runtimeMode", expect: "created run.runtimeMode is claude_code.sdk" }`
- `{ name: "reject claude runtime mode id", lens: "error_path", given: "runtimeMode runtime_mode_claude_code_sdk", expect: "400 invalid_input runtimeMode slug error" }`
- `{ name: "input body missing", lens: "happy_shadow_nil", given: "POST /runs/:id/input without JSON body", expect: "400 invalid_input path body" }`
- `{ name: "input body empty text", lens: "happy_shadow_empty", given: "{\"text\":\"   \"}", expect: "400 invalid_input path text" }`
- `{ name: "input supported active claude", lens: "happy", given: "async fake Claude run paused for input", expect: "POST input returns 202 and normalized transcript records input accepted" }`
- `{ name: "input terminal claude", lens: "error_path", given: "completed fake Claude run then input", expect: "409 adapter_protocol_failed reasonCode runtime_input_not_active" }`
- `{ name: "unsupported codex input unchanged", lens: "error_path", given: "codex.exec_json run input", expect: "409 reasonCode codex_input_unsupported" }`
- `{ name: "unsupported other modes unchanged", lens: "integration", given: "fake/generic_http/agentfield/opencode input", expect: "409 with adapter-specific reasonCode and unchanged run state" }`
- `{ name: "daemon config defaults", lens: "happy_shadow_empty", given: "loadDaemonConfig({})", expect: "Claude command claude, liveProbe false, bounded timeout and budget defaults" }`
- `{ name: "daemon config trims env", lens: "happy", given: "Claude env vars with spaces", expect: "trimmed command and numeric timeout/budget" }`
- `{ name: "daemon seeds claude mode", lens: "integration", given: "createDaemonApp with fake Claude probe", expect: "runtime-modes contains claude_code.sdk and existing modes" }`
- `{ name: "doctor claude live disabled", lens: "happy_shadow_empty", given: "POST /runtime-modes/claude_code.sdk/check with liveProbe false", expect: "no fake prompt call and reasonCode live_probe_disabled" }`
- `{ name: "doctor claude missing binary", lens: "happy_shadow_nil", given: "fake probe binary unavailable", expect: "state unavailable and daemon still starts" }`
- `{ name: "approval pause route", lens: "integration", given: "fake Claude approval pause", expect: "GET approval pending and run status waiting_for_approval" }`
- `{ name: "approval approve resumes", lens: "happy", given: "POST /approvals/:id/approve", expect: "approval.approved event, provider resumes, run completes" }`
- `{ name: "approval reject denies", lens: "happy", given: "POST /approvals/:id/reject", expect: "approval.rejected event and provider denial path" }`
- `{ name: "approval stale resolution", lens: "error_path", given: "resolve approval after callback timed out or run terminalized", expect: "409 approval_not_pending or adapter_protocol_failed runtime_approval_pause_not_active" }`
- `{ name: "claude transcript content retrieval", lens: "integration", given: "filesystem artifact store and completed fake Claude run", expect: "raw and normalized transcript artifacts can be fetched by content endpoint" }`

`integration_contracts`:
- `exports`:
  - `{ name: "RegistryService", kind: "class", signature: "inferAndValidateRuntimeMode({ runtime: 'claude_code', adapterType: 'native' }) => 'claude_code.sdk'" }`
  - `{ name: "registerRunRoutes", kind: "function", signature: "POST /runs/:id/input accepts only { text: non-empty string } publicly" }`
  - `{ name: "createDaemonApp", kind: "function", signature: "wires ClaudeCodeAdapter, runtime-mode seed, doctor, runner, approval bridge, artifact store" }`
- `imports_from_other_tasks`:
  - `{ from_task: "P7-T1-runtime-interaction-core", name: "RuntimeRunnerService", signature: "start/sendInput plus runtime approval bridge behavior" }`
  - `{ from_task: "P7-T1-runtime-interaction-core", name: "ApprovalService", signature: "approve/reject optionally send approval_resolution" }`
  - `{ from_task: "P7-T2-claude-code-adapter", name: "ClaudeCodeAdapter", signature: "new ClaudeCodeAdapter(options?: ClaudeCodeAdapterOptions) implements RuntimeAdapter" }`
  - `{ from_task: "P7-T2-claude-code-adapter", name: "CLAUDE_CODE_RUNTIME_MODE_SLUG", signature: "\"claude_code.sdk\"" }`
- `file_paths_consumed_by_other_tasks`:
  - `apps/daemon/src/app.ts`
  - `packages/protocol-rest/src/run-routes.ts`

### Task P7-T4-r8-docs-and-release-truth

`id`: `P7-T4-r8-docs-and-release-truth`
`title`: Document R8 runtime boundaries, no-spend smoke, and Codex no-PTY decision`

`files`:
- Modify: `docs/adapters/claude-code.md`
- Modify: `docs/adapters/codex.md`
- Modify: `docs/development/adapters/README.md`
- Create: `docs/development/adapters/CLAUDE_CODE.md`
- Modify: `docs/development/API.md`
- Modify: `docs/development/DEVELOPMENT.md`
- Modify: `PRODUCT.md`
- Modify: `CHANGELOG.md`

`dependencies`: ["P7-T1-runtime-interaction-core", "P7-T2-claude-code-adapter", "P7-T3-daemon-rest-wiring"]

`context_files`:
- `docs/superpowers/specs/2026-05-30-phase-7-r8-interactive-coding-runtimes.md` - source of shipped scope, non-goals, acceptance, and docs requirements.
- `PRODUCT.md` - owner-facing product truth and R8 roadmap text.
- `PROJECT.md` - prior phase closeout context and branch/audit wording style.
- `docs/adapters/claude-code.md` - current planned Claude adapter note to update.
- `docs/adapters/codex.md` - current Codex implemented boundary and unsupported input wording.
- `docs/development/API.md` - public REST contract to update for Claude mode, input validation, approval semantics, and artifacts.
- `docs/development/DEVELOPMENT.md` - copy-paste local smoke source of truth.
- `docs/development/adapters/README.md` - adapter guide index to include Claude Code.

`instructions`: Update docs only after the code tasks' acceptance is met in the implementation branch. Keep wording precise: `claude_code.sdk` is the first bounded interactive runtime path; Codex remains `codex.exec_json`; no `codex.interactive`, PTY, hosted subprocess, real tools, Cursor, OpenClaw, Paperclip, browser/search/GitHub/shell/repo/fetch, or default live model spend ships in R8.

`docs/adapters/claude-code.md` should move from planned to implemented-for-R8 with the actual adapter boundary: SDK-backed primary path if implemented, structured stream-json fallback only if implemented, fake-first tests, no PTY, no broad permission bypass, doctor no-spend behavior, opt-in live probe, supported post-start text input, approval bridge semantics, AskUserQuestion limitation, raw and normalized transcript artifacts, and secret redaction.

Create `docs/development/adapters/CLAUDE_CODE.md` with focused local development guidance:

- environment variables and safe defaults.
- no-spend doctor commands.
- fake/deterministic test commands.
- async run plus `POST /runs/:id/input` example for supported Claude sessions.
- approval pause example using deterministic fake fixtures or documented test fixture behavior, not a destructive real tool.
- explicit opt-in live probe command with cost warning and max budget.
- artifact retrieval commands for raw and normalized transcripts.
- unsupported cases and reason codes.

Update `docs/adapters/codex.md` with the R8 decision: `codex.exec_json` is one-shot and structured, `POST /runs/:id/input` remains unsupported with `codex_input_unsupported`, one-shot resume remains deferred unless implemented by Task P7-T2 tests, PTY/TUI automation is not selected, and experimental Codex surfaces are not promoted.

Update `docs/development/API.md` with `claude_code.sdk` runtime-mode examples, capability values, doctor/check semantics, input validation errors, supported and unsupported input examples, approval pause/resolution behavior, AskUserQuestion text-only limitation if no `answers` field ships, and transcript artifact metadata. Update `docs/development/DEVELOPMENT.md` with no-spend runtime capability smoke and fake Claude smoke. Update adapter README with Claude Code status.

Update `PRODUCT.md` and `CHANGELOG.md` in shipped tense only when the implementation phase is ready to land. Product truth must say `claude_code.sdk` exists as local conditional, fake-first/no-spend verified, with post-start input and approval bridge where SDK structured callbacks are implemented. It must also say Codex remains one-shot and interactive Codex/PTY remain unshipped.

`acceptance`:
- Docs name `claude_code.sdk` and list its actual capabilities, placement, doctor behavior, post-start text input, approval bridge semantics, and transcript artifacts.
- Docs preserve `codex.exec_json` as one-shot and explicitly reject Codex PTY/TUI automation in R8.
- Smoke commands are fake/no-spend by default and any live Claude probe is opt-in with cost warning and max budget.
- API docs include 400 input validation examples and 409 unsupported/terminal input examples.
- API and development docs include approval-pause semantics and stale-resolution behavior.
- Product truth and changelog are updated in shipped tense only after implementation checks pass.
- No docs claim hosted execution, real tool routing, broad permission bypass, Cursor/OpenClaw/Paperclip, or live prompt execution in default tests.

`checks`:
- `git diff --check`
- `rg -n "claude_code\\.sdk|codex_input_unsupported|live_probe_disabled|runtime_input_not_active" docs/adapters docs/development PRODUCT.md CHANGELOG.md`
- `! rg -n "codex\\.interactive|PTY support is implemented|hosted Claude|default live Claude prompt|dangerously-skip-permissions is allowed" docs/adapters docs/development PRODUCT.md CHANGELOG.md`
- `pnpm typecheck`

`error_rescue_map`:
- `{ codepath: "docs runtime wording", failure: "docs overclaim Codex interactive, PTY, hosted, or real tools", exception: "documentation review failure", rescue: "replace with explicit R8 non-goal wording and unsupported reason codes", user_sees: "product truth matches shipped runtime behavior" }`
- `{ codepath: "docs smoke commands", failure: "default smoke can spend Claude or Codex tokens", exception: "review or smoke failure", rescue: "move live provider command under opt-in warning with max budget and keep default fake/no-spend commands", user_sees: "safe copy-paste verification path" }`
- `{ codepath: "API input docs", failure: "missing 400/409 examples or wrong envelope", exception: "route test/doc mismatch", rescue: "copy exact error envelope shape and reasonCode details from tests", user_sees: "clients know how to handle invalid and unsupported input" }`
- `{ codepath: "approval docs", failure: "runtime approval bridge sounds like real Switchyard tool execution", exception: "product truth mismatch", rescue: "state provider tools remain provider-managed and Switchyard only normalizes approval lifecycle", user_sees: "no false claim of shell/browser/GitHub execution" }`
- `{ codepath: "PRODUCT/CHANGELOG closeout", failure: "R8 marked shipped before implementation checks pass", exception: "release-truth review failure", rescue: "keep planned wording until implementation branch is green, then update shipped summary", user_sees: "PRODUCT.md remains owner-facing truth" }`

`observability`:
- `logs`: no runtime logs from docs task; docs must describe the runtime logs added by code tasks by event name and reason code.
- `success_metric`: a developer can follow no-spend docs to inspect `claude_code.sdk`, run fake checks/tests, see unsupported Codex input, and understand opt-in live probe risk.
- `failure_metric`: docs contain overclaims, missing error envelopes, or copy-paste commands that run live prompts by default.

`test_cases`:
- `{ name: "docs mention claude runtime mode", lens: "happy", given: "rg claude_code.sdk docs/adapters docs/development PRODUCT.md", expect: "runtime mode documented with capabilities and placement" }`
- `{ name: "docs mention no-spend doctor", lens: "happy", given: "DEVELOPMENT.md Claude smoke", expect: "doctor/check commands do not run prompts by default" }`
- `{ name: "docs mention opt-in live probe", lens: "edge_cost", given: "CLAUDE_CODE.md", expect: "cost warning, max budget env, and explicit live probe flag" }`
- `{ name: "docs unsupported codex input", lens: "integration", given: "codex docs and API docs", expect: "codex_input_unsupported and no codex.interactive claim" }`
- `{ name: "docs input validation", lens: "error_path", given: "API send input section", expect: "400 invalid_input for missing/non-object/empty text and 409 runtime_input_not_active example" }`
- `{ name: "docs approval pause", lens: "integration", given: "API and Claude Code adapter docs", expect: "approval.requested, approve/reject, stale resolution semantics, provider-managed tools" }`
- `{ name: "docs transcript artifacts", lens: "happy", given: "API and Claude dev guide", expect: "raw and normalized transcript paths plus artifact content retrieval commands" }`
- `{ name: "docs avoid overclaims", lens: "edge_security", given: "rg forbidden overclaim phrases", expect: "no hosted/PTY/default-live/bypass claims" }`

`integration_contracts`:
- `exports`:
  - `{ name: "R8 documentation surface", kind: "constant", signature: "docs describe claude_code.sdk, Codex one-shot boundary, no-spend smoke, approval/input/artifact semantics" }`
- `imports_from_other_tasks`:
  - `{ from_task: "P7-T2-claude-code-adapter", name: "CLAUDE_CODE_RUNTIME_MODE_SLUG", signature: "\"claude_code.sdk\"" }`
  - `{ from_task: "P7-T3-daemon-rest-wiring", name: "registerRunRoutes", signature: "public POST /runs/:id/input accepts only text and returns documented 400/409 envelopes" }`
- `file_paths_consumed_by_other_tasks`: []

## Risks

- Claude Code SDK package/API volatility is real. Keep SDK usage behind a tiny client port, keep fake fixtures as the stable contract, and report partial/unavailable doctor state rather than overclaiming live availability.
- Approval callbacks are strongest through the SDK. If an implementation falls back to CLI stream-json and cannot prove structured approval callbacks, the manifest must omit `approval.bridge`, docs must state the limitation, and acceptance should fail rather than silently overclaim.
- Runtime approval resolution has a service-cycle risk between runner and approval service. Use narrow callback interfaces and tests around daemon wiring to avoid a broad dependency knot.
- R8 touches many existing packages. The split keeps ownership disjoint, but the auditor must run full root typecheck and the package checks listed below after task branches merge.

## Integration Points

Task P7-T1 defines the contract and core behavior consumed by all other tasks. Task P7-T2 emits the event payload conventions that P7-T1 handles and exports the Claude adapter. Task P7-T3 wires the adapter, registry, doctor, REST validation, and approval callbacks. Task P7-T4 documents only the behavior implemented and tested by the first three tasks.

Cross-task import walk:

- P7-T2 imports no code from P7-T1 at compile time beyond existing public core/contracts exports, but its emitted events must match P7-T1 payload conventions.
- P7-T3 imports `ClaudeCodeAdapter` and `CLAUDE_CODE_RUNTIME_MODE_SLUG` from P7-T2.
- P7-T3 uses the extended `RuntimeRunnerService` and `ApprovalService` behaviors from P7-T1.
- P7-T4 consumes P7-T2 and P7-T3 behavior for docs only.

## Phase-Level Acceptance

- [ ] `GET /runtime-modes/claude_code.sdk` returns a runtime mode with local conditional placement, SDK kind, `run.input`, `session.state`, `approval.bridge`, streaming events, transcript capabilities, and no hosted support.
- [ ] `GET /runtime-modes/codex.exec_json` still reports one-shot behavior and does not claim `run.input`, `approval.bridge`, `codex.interactive`, or PTY support.
- [ ] `POST /runtime-modes/claude_code.sdk/check` performs no model-spend prompt by default and reports installed/auth/live-probe state without leaking secrets.
- [ ] An explicit live-probe path exists, is off by default, and uses a bounded max budget.
- [ ] Deterministic Claude fake tests prove start, streaming output, post-start input, session id persistence, empty output, malformed event failure, cancellation, timeout, transcript capture, and artifact retrieval.
- [ ] Deterministic approval tests prove provider approval pause creates a persisted approval, marks the run/session waiting, approve resumes provider execution, reject denies provider execution, and stale approval resolution fails visibly.
- [ ] `POST /runs/:id/input` returns `202` for active supported Claude sessions and appends a redacted input acknowledgement to the normalized transcript.
- [ ] `POST /runs/:id/input` returns `400 invalid_input` for missing, non-object, missing text, non-string text, empty text, or whitespace-only input bodies.
- [ ] `POST /runs/:id/input` returns `409 adapter_protocol_failed` with provider-specific `reasonCode` for terminal runs, missing sessions, closed input queues, and unsupported runtime modes.
- [ ] Claude adapter transcripts include raw and normalized artifacts and never include fake auth tokens or API keys in tests.
- [ ] Codex one-shot behavior and existing Codex adapter tests remain green.
- [ ] Codex one-shot resume is deferred and docs explicitly say resume remains deferred.
- [ ] Daemon startup seeds Claude Code provider/runtime/model/runtime-mode records and existing fake/Codex/OpenCode/AgentField/Generic HTTP seeding still works.
- [ ] Runtime doctor summary includes Claude Code state without crashing when Claude is missing, auth is missing, SDK import fails, or live probe is disabled.
- [ ] Docs include no-spend smoke, opt-in live smoke, unsupported-input examples, approval-pause semantics, and the Codex no-PTY decision.
- [ ] `pnpm --filter @switchyard/contracts test`, `pnpm --filter @switchyard/core test`, `pnpm --filter @switchyard/adapters test`, `pnpm --filter @switchyard/protocol-rest test`, `pnpm --filter @switchyard/daemon test`, and root `pnpm typecheck` pass.

## Phase-Level Checks

- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/adapters test`
- `pnpm --filter @switchyard/testkit test`
- `pnpm --filter @switchyard/protocol-rest test`
- `pnpm --filter @switchyard/daemon test`
- `pnpm typecheck`
- `git diff --check`

## Self-Review

1. Spec coverage: every acceptance criterion maps to P7-T1, P7-T2, P7-T3, or P7-T4.
2. Gap-marker scan: no deferred-detail markers or vague edge-case instructions remain.
3. Type consistency: `claude_code.sdk`, `RuntimeRunnerService`, `ApprovalService`, `ClaudeCodeAdapter`, and `registerRunRoutes` contracts match across tasks.
4. Ownership disjoint: no file is owned by more than one task.
5. Context files real: all listed context files exist in the phase worktree.
6. Acceptance testable: each acceptance item is observable through tests, HTTP checks, artifacts, docs, or typecheck.
7. Dependency order sane: contracts/core first, adapter second, daemon/REST third, docs last.
8. Checks runnable: checks use existing pnpm package scripts and Vitest filters from the worktree root.
9. Error/rescue present: every task includes runtime or documentation failure paths with user-visible outcomes.
10. Observability present: runtime tasks list logs and metrics; docs task lists documentation success and failure metrics.
11. Test cases enumerate acceptance: each task includes happy, nil, empty, error, security, and integration test cases for its acceptance.
12. Integration contracts walk: P7-T3 imports resolve to P7-T1 and P7-T2 exports; P7-T4 imports documentation facts from P7-T2 and P7-T3.
13. Contract types match: exported names and signatures match import references.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error_rescue_map entry has a matching test case in `error_path`, `happy_shadow_nil`, `happy_shadow_empty`, `edge_security`, `edge_cost`, or `integration` lenses.
- [x] Every `integration_contracts.imports_from_other_tasks` resolves to an export in another task.
- [x] Every `context_files` path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No deferred-detail marker text remains.
- [x] Complexity is medium but cross-package; it is split by existing package/documentation boundaries rather than sub-phased.
