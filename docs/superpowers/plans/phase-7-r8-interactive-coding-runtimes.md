# Phase 7: R8 Interactive Coding Runtimes - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-7-r8-interactive-coding-runtimes.md`
**Branch:** `agent/phase-7-r8-interactive-coding-runtimes`
**Worktree:** `.worktrees/native-roadmap-20260529/phase-7-r8-interactive-coding-runtimes`
**Plan target:** `docs/superpowers/plans/phase-7-r8-interactive-coding-runtimes.md`
**Complexity:** M
**Task branch:** `agent/phase-7-r8-interactive-coding-runtimes--task-P7-T1-interactive-coding-runtimes`
**Task worktree:** `.worktrees/native-roadmap-20260529/P7-T1-interactive-coding-runtimes`

## Goal

Ship one bounded R8 vertical slice: `claude_code.sdk` as the first interactive coding runtime, core post-start input and runtime approval/session normalization, richer redacted transcripts, and a current Codex no-PTY decision. Default tests and smoke stay deterministic and no-spend.

## Scope Challenge

1. Existing code already covers most infrastructure. R8 should extend `RuntimeRunnerService`, `ApprovalService`, `runtimeCapabilitySchema`, the runtime-mode registry, adapter manifests, and transcript/artifact conventions instead of adding a second orchestration path.
2. Minimum viable change set: capability enum expansion, runner waiting/session-state/approval handling, REST input validation, Claude Code adapter and fake client harness, daemon seeding/doctor config, Codex limitation/doc updates, and smoke docs. Codex one-shot resume is explicitly not implemented in this phase because it is optional in the spec and would add a second provider behavior path.
3. Complexity smell: the phase touches more than 8 files because the user requested one implementer/reviewer for the whole phase. The plan keeps one task but splits implementation into deterministic internal slices with exact checks.
4. Built-in check: use existing Zod schemas, `URL`, `AbortController`, `EventBus`, `ApprovalStore`, `RuntimeSession.state`, `AdapterProtocolError`, `TranscriptRecorder` conventions, Fastify route patterns, and Vitest. Do not add a PTY substrate, hosted subprocess runner, Cursor path, or a separate approval store.
5. Distribution check: no new CLI binary or hosted artifact ships. If the Claude Agent SDK package is added, it must be `@anthropic-ai/claude-agent-sdk` per current official TypeScript Agent SDK docs and must be justified in the implementation diff. If the SDK cannot be imported, the shipped real runtime reports a bounded unavailable/partial doctor state while fake tests still prove the Switchyard contract.

## Architecture

R8 keeps Switchyard's existing control plane. Adapters emit normalized events, the runner persists run/session state and artifacts, and R7 approvals remain the only approval store.

```text
POST /runs
  -> RegistryService infers claude_code.sdk
  -> RuntimeRunnerService.start
  -> ClaudeCodeSdkAdapter
       -> injected fake client in tests
       -> Claude Agent SDK client in local opt-in use
       -> normalized runtime.output/runtime.status/tool.call/tool.result/approval.requested/run.* events
       -> raw + normalized transcript artifacts
```

Post-start input:

```text
POST /runs/:id/input { "text": "continue" }
  -> protocol-rest validates body and non-empty text
  -> RunService.sendInput
  -> RuntimeRunnerService checks non-terminal run and active session
  -> adapter.send({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })
  -> Claude transcript records input_accepted
```

Runtime approval bridge:

```text
Claude SDK canUseTool / AskUserQuestion
  -> adapter emits approval.requested with runtimeApprovalToken
  -> RuntimeRunnerService validates token, persists normal Approval, marks run/session waiting_for_approval
  -> POST /approvals/:id/approve or /reject
  -> ApprovalService records lifecycle event
  -> runtimeApprovalResolver sends { type: "approval_resolution", approvalId, runtimeApprovalToken, decision, ... }
  -> adapter resolves the pending provider callback or returns AdapterProtocolError
```

Session state:

```text
adapter event payload sessionStatePatch
  -> RuntimeRunnerService validates bounded object patch
  -> rejects arrays, huge payloads, and secret-looking keys
  -> merges into runtime_sessions.state
  -> copies claudeSessionId to externalSessionKey when present
```

Codex remains one-shot. `codex.exec_json` keeps `run.input`, `approval.bridge`, `session.resume`, and PTY absent from its manifest. This phase updates stale R3 wording and docs but does not implement `codex exec resume --json`.

## File Structure

- `packages/contracts/src/registry.ts` - add R8 runtime capability literals.
- `packages/contracts/test/contracts.test.ts` - prove new capabilities parse and existing modes still parse.
- `packages/core/src/services/runtime-runner-service.ts` - handle waiting states, bounded session state patches, runtime approval creation, terminal input checks, and approval-resolution sends.
- `packages/core/src/services/approval-service.ts` - add runtime approval resolution support and optional structured `answers` / `updatedInput` resolution payloads.
- `packages/core/test/core.test.ts` - runner tests for waiting states, session patching, runtime approval bridge, input errors, transcript artifact behavior, and unsupported semantics.
- `packages/core/test/middleware-services.test.ts` - approval service tests for runtime approval resolution and existing tool approval one-shot behavior.
- `packages/protocol-rest/src/run-routes.ts` - validate text-only run input body and preserve 409 adapter protocol envelope.
- `packages/protocol-rest/src/middleware-routes.ts` - accept approval resolution extensions and map adapter protocol failures to 409.
- `packages/protocol-rest/test/run-routes.test.ts` - REST input body and unsupported/terminal/missing-session coverage.
- `packages/protocol-rest/test/middleware-routes.test.ts` - approval resolution extension and stale resolution coverage.
- `packages/adapters/src/claude-code/claude-code-adapter.ts` - Claude Code SDK runtime adapter with fake-first client injection, input queue, approval callback bridge, cancellation, and artifact listing.
- `packages/adapters/src/claude-code/claude-code-doctor.ts` - no-spend Claude version/auth/sdk/live-probe availability checks with redacted diagnostics.
- `packages/adapters/src/claude-code/claude-code-event-mapper.ts` - SDK message to Switchyard event normalization.
- `packages/adapters/src/claude-code/claude-code-transcript.ts` - raw and normalized `r8.v1` transcript recorder with redaction.
- `packages/adapters/src/claude-code/types.ts` - internal client, SDK message, approval, transcript, and config types.
- `packages/adapters/src/claude-code/index.ts` - Claude Code adapter exports.
- `packages/adapters/src/index.ts` - package export registration.
- `packages/adapters/src/codex/codex-exec-json-adapter.ts` - update stale limitation text only; keep behavior one-shot.
- `packages/adapters/test/claude-code-adapter.test.ts` - deterministic fake Claude client coverage for streaming, input, approvals, session state, errors, cancellation, timeout, transcripts, and redaction.
- `packages/adapters/test/codex-exec-json-adapter.test.ts` - assert no R8 Codex overclaim and updated limitation text.
- `packages/adapters/test/runtime-adapter-contracts.test.ts` - add Claude adapter contract and support active input before terminal drain.
- `packages/testkit/src/fake-claude-code-client.ts` - deterministic fake Claude SDK client and scenarios.
- `packages/testkit/src/runtime-adapter-contract-harness.ts` - interactive-aware contract behavior for adapters with `run.input`.
- `packages/testkit/src/index.ts` - export fake Claude client.
- `packages/testkit/test/fake-claude-code-client.test.ts` - fake client scenario tests.
- `apps/daemon/src/config.ts` - Claude Code daemon env config.
- `apps/daemon/src/app.ts` - adapter construction, registry seeding, runtime-mode manifest seeding, initial availability, approval resolver wiring, and doctor summary.
- `apps/daemon/test/smoke.test.ts` - daemon smoke for Claude registry, no-spend doctor, fake run/input/approval/transcript, Codex no-input, and secret redaction.
- `docs/adapters/claude-code.md` - implementation truth and no-PTY decision.
- `docs/adapters/codex.md` - current R8 Codex decision and no resume/no PTY status.
- `docs/development/adapters/README.md` - add Claude Code guide.
- `docs/development/adapters/CLAUDE_CODE.md` - local no-spend/fake/opt-in-live Claude guide.
- `docs/development/adapters/CODEX.md` - current no-interactive/no-resume/no-PTY wording.
- `docs/development/DEVELOPMENT.md` - R8 smoke commands.
- `docs/development/API.md` - text-only input and runtime approval bridge examples.
- `PRODUCT.md` - R8 shipped status and current product truth after implementation passes.
- `CHANGELOG.md` - R8 release entry after implementation passes.

## Existing Context

These are the ground-truth anchors the implementer must read before coding:

- `docs/superpowers/specs/2026-05-30-phase-7-r8-interactive-coding-runtimes.md` - full R8 product contract, acceptance, constraints, and non-goals.
- `PRODUCT.md` - current product truth: shipped modes are fake, Codex exec-json, AgentField, Generic HTTP, OpenCode ACP, and R7 middleware.
- `PROJECT.md` - prior phase closeouts and branch/audit truth.
- `packages/core/src/ports/runtime-adapter.ts` - adapter contract: `start`, `send`, `events`, `artifacts`, and manifest shape.
- `packages/core/src/services/runtime-runner-service.ts` - lifecycle, session creation, terminalization, artifacts, current `sendInput` behavior.
- `packages/core/src/services/approval-service.ts` - existing approval lifecycle and one-shot pending guard.
- `packages/protocol-rest/src/run-routes.ts` - current `/runs/:id/input` route and adapter protocol error envelope.
- `packages/protocol-rest/src/middleware-routes.ts` - existing approval approve/reject body shape and service-error mapping.
- `packages/contracts/src/registry.ts` - runtime mode kinds, capability enum, availability/doctor schemas.
- `packages/contracts/src/run.ts` and `packages/contracts/src/session.ts` - existing waiting run/session statuses.
- `packages/contracts/src/event.ts` and `packages/contracts/src/approval.ts` - existing event and approval vocabularies to reuse.
- `packages/adapters/src/codex/codex-exec-json-adapter.ts` - one-shot process adapter and unsupported input behavior.
- `packages/adapters/src/opencode/opencode-acp-adapter.ts` and `packages/protocol-acpx/src/acp-stdio-client.ts` - local structured subprocess, doctor, transcript, and permission-request failure patterns.
- `packages/adapters/src/substrates/transcript-recorder.ts` - current transcript metadata/content convention.
- `packages/adapters/test/opencode-acp-adapter.test.ts`, `packages/adapters/test/codex-exec-json-adapter.test.ts`, and `apps/daemon/test/smoke.test.ts` - fake-first adapter and daemon test patterns.
- `docs/adapters/claude-code.md`, `docs/adapters/codex.md`, `docs/development/adapters/CODEX.md`, and `docs/development/adapters/OPENCODE.md` - existing adapter documentation boundaries.

External docs checked for current SDK vocabulary:

- Official TypeScript Agent SDK reference: `https://platform.claude.com/docs/en/agent-sdk/typescript`
- Official Claude Code streaming input guide: `https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode`
- Official Claude Code approvals/user input guide: `https://code.claude.com/docs/en/agent-sdk/user-input`

## Task Graph

### Task P7-T1: Ship R8 Interactive Coding Runtimes

`id`: `P7-T1-interactive-coding-runtimes`
`title`: Ship Claude Code SDK interactive runtime, core input/approval/session bridge, Codex no-PTY decision, and docs

`files`:
- Modify: `packages/contracts/src/registry.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/core/src/services/runtime-runner-service.ts`
- Modify: `packages/core/src/services/approval-service.ts`
- Modify: `packages/core/test/core.test.ts`
- Modify: `packages/core/test/middleware-services.test.ts`
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Modify: `packages/protocol-rest/src/middleware-routes.ts`
- Modify: `packages/protocol-rest/test/run-routes.test.ts`
- Modify: `packages/protocol-rest/test/middleware-routes.test.ts`
- Create: `packages/adapters/src/claude-code/claude-code-adapter.ts`
- Create: `packages/adapters/src/claude-code/claude-code-doctor.ts`
- Create: `packages/adapters/src/claude-code/claude-code-event-mapper.ts`
- Create: `packages/adapters/src/claude-code/claude-code-transcript.ts`
- Create: `packages/adapters/src/claude-code/types.ts`
- Create: `packages/adapters/src/claude-code/index.ts`
- Modify: `packages/adapters/src/index.ts`
- Modify: `packages/adapters/src/codex/codex-exec-json-adapter.ts`
- Create: `packages/adapters/test/claude-code-adapter.test.ts`
- Modify: `packages/adapters/test/codex-exec-json-adapter.test.ts`
- Modify: `packages/adapters/test/runtime-adapter-contracts.test.ts`
- Create: `packages/testkit/src/fake-claude-code-client.ts`
- Modify: `packages/testkit/src/runtime-adapter-contract-harness.ts`
- Modify: `packages/testkit/src/index.ts`
- Create: `packages/testkit/test/fake-claude-code-client.test.ts`
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`
- Modify: `docs/adapters/claude-code.md`
- Modify: `docs/adapters/codex.md`
- Modify: `docs/development/adapters/README.md`
- Create: `docs/development/adapters/CLAUDE_CODE.md`
- Modify: `docs/development/adapters/CODEX.md`
- Modify: `docs/development/DEVELOPMENT.md`
- Modify: `docs/development/API.md`
- Modify: `PRODUCT.md`
- Modify: `CHANGELOG.md`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-30-phase-7-r8-interactive-coding-runtimes.md`
- `PRODUCT.md`
- `PROJECT.md`
- `packages/core/src/ports/runtime-adapter.ts`
- `packages/core/src/services/runtime-runner-service.ts`
- `packages/core/src/services/approval-service.ts`
- `packages/protocol-rest/src/run-routes.ts`
- `packages/protocol-rest/src/middleware-routes.ts`
- `packages/contracts/src/registry.ts`
- `packages/contracts/src/run.ts`
- `packages/contracts/src/session.ts`
- `packages/contracts/src/event.ts`
- `packages/contracts/src/approval.ts`
- `packages/adapters/src/codex/codex-exec-json-adapter.ts`
- `packages/adapters/src/opencode/opencode-acp-adapter.ts`
- `packages/protocol-acpx/src/acp-stdio-client.ts`
- `packages/adapters/src/substrates/transcript-recorder.ts`
- `packages/adapters/test/opencode-acp-adapter.test.ts`
- `packages/adapters/test/codex-exec-json-adapter.test.ts`
- `apps/daemon/src/config.ts`
- `apps/daemon/src/app.ts`
- `apps/daemon/test/smoke.test.ts`
- `docs/adapters/claude-code.md`
- `docs/adapters/codex.md`
- `docs/development/adapters/CODEX.md`
- `docs/development/adapters/OPENCODE.md`

`instructions`: Implement R8 as one vertical slice with the internal slices below. Keep all automated tests fake-first and no-spend. Do not run live Claude or Codex prompts in tests, default doctor checks, or default smoke. Do not add Cursor, hosted subprocess execution, a generic PTY substrate, or a Codex PTY/interactive runtime mode.

Internal slice 1 - contracts and manifests:

1. Add these exact `runtimeCapabilitySchema` values in `packages/contracts/src/registry.ts`: `run.input`, `session.state`, `session.resume`, `approval.bridge`, `tool.call.normalized`, `tool.result.normalized`, and `user.question`.
2. Add contract tests proving existing shipped mode manifests still parse and a `claude_code.sdk` runtime mode parses with kind `sdk`, adapter type `native`, local conditional placement, hosted unsupported placement, and capabilities `run.input`, `session.state`, `approval.bridge`, `event.streaming`, `artifact.transcript`, and `artifact.raw_transcript`.
3. Do not add run statuses, session statuses, event types, or approval types unless an existing schema makes an R8 acceptance impossible. The existing `waiting_for_input`, `waiting_for_approval`, `tool.call`, `tool.result`, and `approval.requested` values are sufficient.

Internal slice 2 - runner input, waiting state, session patch, and runtime approval bridge:

1. Extend `RuntimeRunnerService` dependencies with optional `approvals` and optional runtime approval resolver support. In daemon wiring, pass the existing R7 `ApprovalStore`; do not add a second approval persistence path.
2. In the adapter-event loop, handle non-terminal `runtime.status` payloads with `status: "waiting_for_input"` or `status: "waiting_for_approval"` by updating both persisted run status and session status to the matching waiting state before appending the normalized event. A later non-terminal status that is not waiting should return a waiting run/session to `running` / `active` unless the run is terminal.
3. Implement bounded `sessionStatePatch` handling on any adapter event payload. Accept only plain objects, reject arrays, functions, huge JSON payloads, and keys matching `/token|apiKey|authorization|password|secret/i`. Merge valid patches into `runtime_sessions.state`, redact string values before logs/transcripts, and copy `claudeSessionId` to `externalSessionKey` when it is a non-empty string.
4. If an adapter emits `approval.requested`, require `payload.runtimeApprovalToken` as a non-empty string. If missing, append a failed normalization event or fail the run with `runtime_approval_token_missing`; do not hang.
5. For a valid runtime approval event, create a normal pending `Approval` record with `approvalType` from payload or `before_external_message` for AskUserQuestion-style events. Persist sanitized payload fields: `runtimeApproval: true`, `runtimeApprovalToken`, `approvalType`, `providerToolName`, `toolName`, `toolInput`, `question`, `options`, `multiSelect`, `responseFormat`, `reasonCode`, and `sessionStatePatch` when safe.
6. Append/publish one `approval.requested` event with `approvalId`, `approvalType`, and safe metadata. Mark run/session `waiting_for_approval`.
7. Update `RuntimeRunnerService.sendInput` to reject terminal runs with `AdapterProtocolError` reason `runtime_input_not_active`, missing sessions with `runtime_session_missing`, and closed or unsupported provider paths through the adapter's own `AdapterProtocolError`. Do not preempt adapter-specific unsupported reason codes for active unsupported runtimes.
8. Keep `RunService.sendInput` as a thin delegation unless types require a small signature adjustment.

Internal slice 3 - approval resolution:

1. Extend `ApprovalService.ResolveApprovalInput` to accept optional `answers?: Record<string, unknown>` and `updatedInput?: Record<string, unknown>` in addition to `actor` and `reason`.
2. After the existing pending-to-approved/rejected transition, if the approval payload has `runtimeApproval: true` and a `runId`, send a structured input through the runtime resolver:

```json
{
  "type": "approval_resolution",
  "approvalId": "approval_...",
  "runtimeApprovalToken": "provider-local-token",
  "decision": "approved",
  "updatedInput": { "command": "safe command" },
  "answers": { "choice": "A" },
  "message": "approved by local-user"
}
```

3. Preserve existing one-shot approval semantics: resolving the same approval twice returns `409 approval_not_pending`.
4. If the adapter reports a stale or closed runtime approval pause, surface `409 adapter_protocol_failed` with reason `runtime_approval_pause_not_active`, log `approval.runtime_resolution_failed`, and do not create a new approval store path.
5. Extend `packages/protocol-rest/src/middleware-routes.ts` to parse optional `answers` and `updatedInput` objects on approve/reject and to map `AdapterProtocolError` to the existing 409 envelope.

Internal slice 4 - REST input validation:

1. Update `parseInputBody` in `packages/protocol-rest/src/run-routes.ts` so missing body, non-object body, `{}`, missing `text`, non-string `text`, empty string, or whitespace-only `text` returns `400 invalid_input` with `path: "body"` or `path: "text"` as appropriate.
2. Keep R8 REST input text-only. Do not accept image attachments, binary attachments, raw SDK messages, or parent tool-use routing.
3. Preserve existing adapter protocol envelope for active unsupported input: `409 adapter_protocol_failed` with `details: [{ path: "reasonCode", issue: "<provider_reason>" }]`.

Internal slice 5 - Claude Code adapter:

1. Add `ClaudeCodeSdkAdapter` with adapter id `claude_code`, provider id `provider_anthropic`, runtime id `runtime_claude_code`, runtime mode id `runtime_mode_claude_code_sdk`, slug `claude_code.sdk`, adapter type `native`, kind `sdk`, and docs path `docs/development/adapters/CLAUDE_CODE.md`.
2. Manifest capabilities must include `run.start`, `run.cancel`, `run.timeout`, `run.input`, `session.state`, `approval.bridge`, `event.normalized`, `event.streaming`, `artifact.transcript`, `artifact.raw_transcript`, `tool.call.normalized`, `tool.result.normalized`, `user.question`, `auth.local`, and `sandbox.read_only`.
3. Manifest must not include `sandbox.workspace_write` or `sandbox.danger_full_access` by default. Wider permissions require explicit trusted daemon config or run metadata and must be represented in transcript metadata.
4. Implement a small `ClaudeCodeClientPort` in `types.ts`. Tests inject a fake client. Production code may dynamically import `@anthropic-ai/claude-agent-sdk` only behind this port. If import or SDK initialization fails, doctor/start return named `claude_sdk_unavailable` or `claude_sdk_import_failed` errors. Do not hard-fail daemon startup.
5. Use streaming input mode for supported runs. Convert REST input text to this exact shape:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "Please continue, but keep the changes read-only." }
    ]
  },
  "parent_tool_use_id": null
}
```

6. Reject relative `cwd`, missing run id, missing task, empty task, unsupported permission mode, unsupported tool configuration, and bypass permission modes with `AdapterProtocolError` reason codes prefixed `claude_`.
7. Never pass `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `bypassPermissions`, or equivalent bypass behavior from untrusted run metadata.
8. Default smoke permission mode is read-only or plan-like. Write/shell/bypass modes are not allowed in default smoke.
9. Map SDK messages to existing Switchyard events:
   - text deltas and final assistant text -> `runtime.output`
   - session, lifecycle, usage, cost, retry, and unknown provider messages -> `runtime.status`
   - tool use start -> `tool.call`
   - tool result/completion/failure -> `tool.result`
   - permission callback and AskUserQuestion -> `approval.requested`
   - success -> `run.completed`
   - provider refusal, malformed event, SDK exception, stream abort, or provider failure -> `run.failed`
10. Unknown or null provider events must not throw unbounded raw payloads. Emit `runtime.status` with `status: "provider_event_unknown"` and bounded raw type metadata.
11. `send` must reject terminal/closed queues with `AdapterProtocolError` reason `claude_input_queue_closed` or `runtime_input_not_active`.
12. `cancel` must interrupt/close the active query when supported and be idempotent after terminal state.
13. `artifacts` must emit two transcript artifacts when a run has started:
   - `runs/<runId>/claude-code-raw-transcript.jsonl`
   - `runs/<runId>/claude-code-normalized-transcript.jsonl`
14. Transcript metadata must include `runtime: "claude_code"`, `mode: "sdk"`, `runtimeMode: "claude_code.sdk"`, `transcriptVersion: "r8.v1"`, and `redacted: true`.
15. Redact account ids, tokens, auth helper output, environment values, tool input secrets, and fake secrets from events, logs, transcripts, and artifact metadata.

Internal slice 6 - Claude doctor and daemon wiring:

1. Add daemon config:
   - `SWITCHYARD_CLAUDE_CODE_COMMAND`, default `claude`
   - `SWITCHYARD_CLAUDE_CODE_LIVE_PROBE`, default `0`
   - `SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD`, default bounded and low
   - `SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS`
2. Doctor default must not run a model prompt. It may run `claude --version` and `claude auth status --json` only with bounded output and redaction. If auth JSON is malformed, return `unknown` or `partial` with `claude_auth_status_invalid`.
3. If live probe is disabled, return `installed` or `partial` with `reasonCode: "live_probe_disabled"` or `reasonCode: "live_probe_required"` and `canRun: false` unless SDK import/auth checks prove enough for local run availability without spend.
4. If live probe is explicitly enabled, pass `--max-budget-usd`, use a tiny read-only prompt, disable broad tools, bound timeout/output, redact diagnostics, and record opt-in state. Do not use live probe in tests.
5. Seed provider/runtime/model/runtime-mode records:
   - provider `provider_anthropic`, auth mode `local`
   - runtime `runtime_claude_code`, adapter type `native`
   - model `model_claude_code_default`
   - runtime mode `claude_code.sdk`
6. Register adapter in the daemon adapter map under `claude_code` and include its manifest in capability seeding.
7. Wire `ApprovalService` with a runtime approval resolver that sends `approval_resolution` through `RunService.sendInput` / `RuntimeRunnerService.sendInput`.

Internal slice 7 - Codex decision boundary:

1. Keep `codex.exec_json` one-shot and do not implement `codex.interactive`, PTY, hosted execution, or Switchyard approval bridge.
2. Update stale R3/R4 limitation strings in `CodexExecJsonAdapter` and docs to R8 wording: local one-shot, no post-start input, no approval bridge, no session resume, no PTY, no hosted subprocess.
3. Keep `POST /runs/:id/input` for Codex returning `409 adapter_protocol_failed` with `reasonCode: "codex_input_unsupported"`.
4. Add tests proving `codex.exec_json` omits `run.input`, `approval.bridge`, `session.resume`, and PTY support after R8.
5. Document that `codex exec resume --json` remains a future one-shot resume candidate and is not shipped in R8.

Internal slice 8 - docs and product truth:

1. Update docs after tests pass. Docs must include no-spend doctor commands, fake deterministic test commands, opt-in live Claude probe with cost warning and max budget, supported/unsupported input examples, approval-pause semantics, transcript/artifact inspection, and the Codex no-PTY/no-resume decision.
2. `PRODUCT.md` and `CHANGELOG.md` may mark R8 shipped only after all checks pass. Do not update `PROJECT.md`; CEO owns phase closeout.

`acceptance`:
- `GET /runtime-modes/claude_code.sdk` returns a runtime mode with local conditional placement, hosted unsupported placement, SDK kind, `run.input`, `session.state`, `approval.bridge`, streaming events, transcript capabilities, and no hosted support.
- `GET /runtime-modes/codex.exec_json` still reports one-shot behavior and does not claim `run.input`, `approval.bridge`, `session.resume`, or PTY support.
- `POST /runtime-modes/claude_code.sdk/check` performs no model-spend prompt by default and reports installed/auth/sdk/live-probe state without leaking secrets.
- An explicit opt-in live Claude probe path exists, is off by default, uses a bounded max budget, and is not used by tests.
- Deterministic Claude fake tests prove start, streaming output, post-start input, session id persistence, empty output, malformed event failure, cancellation, timeout, transcript capture, and artifact retrieval.
- Deterministic approval tests prove provider approval pause creates a persisted approval, marks the run/session waiting, approve resumes provider execution, reject denies provider execution, and stale approval resolution fails visibly.
- `POST /runs/:id/input` returns `202` for active supported Claude sessions and appends a redacted input acknowledgement to the normalized transcript.
- `POST /runs/:id/input` returns `400 invalid_input` for missing, non-object, empty, or whitespace-only input bodies.
- `POST /runs/:id/input` returns `409 adapter_protocol_failed` with provider-specific `reasonCode` for terminal runs, missing sessions, closed input queues, and unsupported runtime modes.
- Claude adapter transcripts include raw and normalized artifacts and never include fake auth tokens, API keys, authorization headers, passwords, or secret values in tests.
- Codex one-shot behavior and existing Codex adapter tests remain green.
- Codex one-shot resume is not implemented in R8 and docs explicitly say resume remains deferred.
- Daemon startup seeds Claude Code provider/runtime/model/runtime-mode records and existing fake/Codex/OpenCode/AgentField/Generic HTTP seeding still works.
- Runtime doctor summary includes Claude Code state without crashing when Claude is missing, auth is missing, SDK import fails, or live probe is disabled.
- Docs include no-spend smoke, opt-in live smoke, unsupported-input examples, approval-pause semantics, transcript inspection, and the Codex no-PTY decision.
- `pnpm --filter @switchyard/contracts test`, `pnpm --filter @switchyard/core test`, `pnpm --filter @switchyard/adapters test`, `pnpm --filter @switchyard/protocol-rest test`, `pnpm --filter @switchyard/daemon test`, and root `pnpm typecheck` pass.

`checks`:
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/protocol-rest test -- run-routes`
- `pnpm --filter @switchyard/protocol-rest test -- middleware-routes`
- `pnpm --filter @switchyard/adapters test -- claude-code`
- `pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter`
- `pnpm --filter @switchyard/adapters test -- runtime-adapter-contracts`
- `pnpm --filter @switchyard/testkit test -- fake-claude-code-client`
- `pnpm --filter @switchyard/daemon test -- smoke`
- `pnpm --filter @switchyard/contracts typecheck`
- `pnpm --filter @switchyard/core typecheck`
- `pnpm --filter @switchyard/protocol-rest typecheck`
- `pnpm --filter @switchyard/adapters typecheck`
- `pnpm --filter @switchyard/testkit typecheck`
- `pnpm --filter @switchyard/daemon typecheck`
- `pnpm typecheck`
- `git diff --check`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| capability schema expansion | Existing shipped manifests fail to parse | Zod enum rejection | Add only listed capability literals and preserve all existing literals | Existing runtime modes still list successfully |
| daemon runtime-mode seeding | Claude adapter missing from adapter map | `adapter_not_registered` doctor state | Seed mode and adapter together; doctor returns unsupported if map entry is absent | `/runtime-modes/claude_code.sdk/check` returns structured unsupported state |
| Claude doctor version check | Claude command missing | spawn/ENOENT or non-zero exit | Return unavailable `binary_unavailable`; redact diagnostics | Doctor shows missing local Claude without crashing |
| Claude doctor auth check | Auth JSON empty, malformed, or contains secrets | JSON parse error or oversized output | Return `claude_auth_status_invalid` or `check_output_too_large`; redact output before logs | Doctor remains bounded and no secret leaks |
| Claude live probe | Default doctor spends model budget | misconfigured probe flag | Gate live probe on `SWITCHYARD_CLAUDE_CODE_LIVE_PROBE=1` only | Default check reports live probe disabled |
| SDK import | Agent SDK package unavailable or API shifted | dynamic import error | Return `claude_sdk_import_failed` from check/start; fake tests continue through client port | Runtime mode does not overclaim live availability |
| adapter start validation | Relative cwd or empty task enters provider | invalid request input | Throw `AdapterProtocolError` with `claude_cwd_not_absolute` or `claude_task_required` | Run fails visibly before provider work |
| permission mode mapping | Bypass permissions accepted from untrusted metadata | unsafe metadata | Reject bypass mode with `claude_permission_mode_unsupported` | Run fails before unsafe provider launch |
| provider stream | Null or unknown SDK event shape | malformed provider event | Emit bounded `runtime.status` or fail with `claude_provider_event_malformed` | Run has visible status/failure and transcript |
| provider stream | Provider completes without output | empty output | Complete if provider reports success and transcript records `empty_output: true` | Run completes with empty-output marker |
| provider stream | SDK exception or stream abort | thrown provider error | Emit `run.failed` with provider-specific reason and preserve captured transcript | Run is terminal with diagnostic artifact |
| post-start input REST | Missing/non-object/empty/whitespace text | invalid request body | Return `400 invalid_input` with body/text path | API caller gets validation detail |
| post-start input core | Run already terminal | terminal run status | Throw `AdapterProtocolError` reason `runtime_input_not_active` | API returns 409 without mutating run |
| post-start input core | Runtime session missing | missing session row | Throw `AdapterProtocolError` reason `runtime_session_missing` | API returns 409 with reason detail |
| post-start input adapter | Claude queue closed | closed input queue | Throw `AdapterProtocolError` reason `claude_input_queue_closed` | API returns 409 with provider reason |
| unsupported input | Codex/OpenCode/AgentField/Generic HTTP/fake receive input while active | adapter-specific unsupported path | Preserve existing adapter `AdapterProtocolError` reason codes | API returns 409 such as `codex_input_unsupported` |
| waiting state update | Run remains `running` while provider waits | unhandled `waiting_for_approval` or `waiting_for_input` | Runner persists run/session waiting state before event append | `GET /runs/:id` shows waiting status |
| session state patch | Patch contains array, huge payload, or secret key | invalid patch | Reject patch and fail run with `runtime_session_state_patch_invalid` | Run fails visibly; unsafe state not persisted |
| session state patch | Provider exposes no session id | absent provider session id | Continue run; omit `session.resume` if no resumable id exists | Runtime works without resume claim |
| approval event | Runtime approval token missing | malformed approval request | Fail run with `runtime_approval_token_missing` | Run does not hang waiting on unresolvable approval |
| approval bridge | Approval store not configured | missing runner dependency | Fail run with `runtime_approval_bridge_unconfigured` | Visible failure instead of hang |
| approval payload | Empty approval payload has no tool/question/reason | underspecified provider callback | Create approval with `runtime_approval_payload_empty` warning in payload/transcript | User sees pending approval with reason code |
| approval resolution | Provider callback expired before approve/reject | adapter stale token | Throw `AdapterProtocolError` reason `runtime_approval_pause_not_active` | API returns 409 and logs resolution failure |
| approval resolution | Same approval resolved twice | non-pending approval | Preserve existing `approval_not_pending` path | Second approve/reject returns 409 conflict |
| AskUserQuestion | Structured answers omitted | text-only reason body | Send denial/answer message from reason and record limitation `user_question_text_response_only` if answers absent | User can answer through REST without schema breakage |
| transcript persistence | Artifact path unsafe or write fails | artifact normalization/write error | Use safe relative paths and existing artifact content store; fail visibly only after terminal event per current runner behavior | Artifact route remains safe |
| transcript redaction | Fake secrets appear in events/logs/artifacts | token/apiKey/password/authorization in source data | Redact recursively before logs, transcripts, artifact metadata, and approval payloads | Tests find no secret substrings |
| Codex limitation update | Manifest overclaims interactivity | accidental `run.input` or `approval.bridge` | Add negative tests for omitted capabilities | Codex remains one-shot in registry |

`observability`:
- `logs`: `runtime.session.started`, `runtime.session_state_patch_applied`, `runtime.waiting_state`, `runtime.input.accepted`, `runtime.approval_requested`, `runtime.approval_resolution_sent`, `runtime.approval_resolution_failed`, `claude_code.check`, `claude_code.start`, `claude_code.input`, `claude_code.cancel`, `claude_code.provider_error`, and `runtime.transcript_persist_failed`. Logs include run id, session id, runtime mode, reason code, bounded byte counts, and no raw secrets.
- `success_metric`: fake Claude daemon smoke starts a run, streams output, accepts input, persists session state, bridges approval approve/reject, and retrieves raw plus normalized transcripts.
- `failure_metric`: validation, unsupported input, terminal input, missing session, SDK import failure, malformed provider event, stale approval resolution, timeout, and redaction paths emit named reason codes covered by tests.

`test_cases`:
- `{ name: "capability literals parse", lens: "happy", given: "runtimeCapabilitySchema.parse for run.input/session.state/session.resume/approval.bridge/tool.call.normalized/tool.result.normalized/user.question", expect: "all parse" }`
- `{ name: "existing manifests still parse", lens: "integration", given: "fake, codex.exec_json, generic_http.async_rest, agentfield.async_rest, opencode.acp manifests", expect: "runtimeModeSchema parse succeeds unchanged" }`
- `{ name: "claude manifest parses", lens: "happy", given: "new ClaudeCodeSdkAdapter manifest", expect: "sdk kind, native adapter, local conditional, hosted unsupported, R8 capabilities" }`
- `{ name: "claude doctor missing binary", lens: "happy_shadow_nil", given: "fake doctor command missing", expect: "unavailable binary_unavailable and no throw" }`
- `{ name: "claude doctor no spend", lens: "edge_no_spend", given: "doctor with fake command counters and live probe disabled", expect: "zero prompt calls and reason live_probe_disabled or live_probe_required" }`
- `{ name: "claude doctor redaction", lens: "edge_security", given: "auth output includes token/apiKey/authorization/password/secret", expect: "check details/log captures do not contain raw secret" }`
- `{ name: "claude SDK import unavailable", lens: "error_path", given: "default client loader import fails", expect: "check/start reports claude_sdk_import_failed without daemon crash" }`
- `{ name: "claude fake streaming input", lens: "happy", given: "fake Claude run emits init/output, send input while active, emits follow-up output and success", expect: "events include runtime.output before and after input and run.completed" }`
- `{ name: "claude input acknowledgement transcript", lens: "integration", given: "POST /runs/:id/input text continue", expect: "202 and normalized transcript contains input_accepted without raw secrets" }`
- `{ name: "claude session state", lens: "happy", given: "fake provider emits claudeSessionId patch", expect: "session.externalSessionKey and state.claudeSessionId persist" }`
- `{ name: "session patch rejects secret keys", lens: "edge_security", given: "sessionStatePatch contains apiKey/token/password/authorization/secret", expect: "run.failed runtime_session_state_patch_invalid and state unchanged" }`
- `{ name: "session patch rejects arrays and huge payloads", lens: "error_path", given: "sessionStatePatch array or JSON over configured bound", expect: "run.failed runtime_session_state_patch_invalid" }`
- `{ name: "waiting for input status", lens: "integration", given: "adapter emits runtime.status waiting_for_input", expect: "run and session statuses become waiting_for_input" }`
- `{ name: "waiting for approval status", lens: "integration", given: "adapter emits approval pause", expect: "run and session statuses become waiting_for_approval and approval persists" }`
- `{ name: "approval approve resumes provider", lens: "happy", given: "fake provider pauses with runtimeApprovalToken then approve", expect: "approval.approved event, approval_resolution sent, provider completes" }`
- `{ name: "approval reject denies provider", lens: "happy", given: "fake provider pauses then reject", expect: "approval.rejected event, denial sent, provider completes or fails with fake denied status" }`
- `{ name: "approval token missing", lens: "error_path", given: "adapter emits approval.requested without runtimeApprovalToken", expect: "run.failed runtime_approval_token_missing" }`
- `{ name: "approval bridge unconfigured", lens: "error_path", given: "runner without approvals store receives runtime approval", expect: "run.failed runtime_approval_bridge_unconfigured" }`
- `{ name: "stale approval resolution", lens: "error_path", given: "approve after provider callback expired", expect: "409 adapter_protocol_failed runtime_approval_pause_not_active and no duplicate approval" }`
- `{ name: "approval resolved twice", lens: "error_path", given: "approve same approval twice", expect: "second call 409 approval_not_pending" }`
- `{ name: "ask user question mapping", lens: "integration", given: "fake provider asks AskUserQuestion with options", expect: "approvalType before_external_message and payload responseFormat ask_user_question" }`
- `{ name: "input missing body", lens: "happy_shadow_nil", given: "POST /runs/:id/input with no body", expect: "400 invalid_input path body" }`
- `{ name: "input empty text", lens: "happy_shadow_empty", given: "POST /runs/:id/input with empty or whitespace text", expect: "400 invalid_input path text" }`
- `{ name: "input terminal run", lens: "error_path", given: "send input after supported Claude run completed", expect: "409 reason runtime_input_not_active" }`
- `{ name: "input missing session", lens: "error_path", given: "run exists but session missing", expect: "409 reason runtime_session_missing" }`
- `{ name: "input closed queue", lens: "error_path", given: "fake Claude active run with closed input queue", expect: "409 reason claude_input_queue_closed" }`
- `{ name: "unsupported Codex input", lens: "error_path", given: "POST input to codex.exec_json", expect: "409 reason codex_input_unsupported and run status unchanged" }`
- `{ name: "unsupported OpenCode input", lens: "error_path", given: "POST input to opencode.acp", expect: "409 reason opencode_input_unsupported" }`
- `{ name: "tool call normalization", lens: "happy", given: "fake Claude tool start and result", expect: "tool.call then tool.result with sanitized provider tool name and input summary" }`
- `{ name: "empty output success", lens: "happy_shadow_empty", given: "fake provider succeeds without output", expect: "run.completed and normalized transcript empty_output true" }`
- `{ name: "malformed provider event", lens: "error_path", given: "fake provider emits malformed record", expect: "run.failed claude_provider_event_malformed and transcript captures bounded raw record" }`
- `{ name: "provider stream abort", lens: "error_path", given: "fake client throws mid-stream", expect: "run.failed claude_stream_aborted and raw transcript artifact exists" }`
- `{ name: "cancel active Claude", lens: "happy", given: "cancel while fake Claude running", expect: "provider interrupted, run.cancelled or timeout-safe terminal path, artifact available" }`
- `{ name: "timeout active Claude", lens: "error_path", given: "fake Claude hangs", expect: "runner marks timeout and cancel called once" }`
- `{ name: "transcript artifacts", lens: "integration", given: "completed fake Claude run", expect: "GET /runs/:id/artifacts lists raw and normalized transcript; content route returns JSONL" }`
- `{ name: "secret redaction", lens: "edge_security", given: "fake source data includes SECRET_TOKEN, apiKey, Authorization, password", expect: "no raw secret in events, approvals, logs captured by test, transcripts, or artifact metadata" }`
- `{ name: "daemon registry", lens: "integration", given: "createDaemonApp with unavailable Codex and default Claude config", expect: "runtime modes include claude_code.sdk alongside existing modes" }`
- `{ name: "daemon doctor summary", lens: "integration", given: "POST check for claude_code.sdk with missing/partial fake states", expect: "doctor summary counts state and daemon remains healthy" }`
- `{ name: "Codex no overclaim", lens: "integration", given: "Codex manifest after R8", expect: "omits run.input, approval.bridge, session.resume, PTY and docs say resume deferred" }`
- `{ name: "docs smoke commands no spend", lens: "edge_docs", given: "R8 docs", expect: "default commands use fake/no-spend doctor and live command is opt-in with cost warning" }`

`integration_contracts`:
- `exports`:
  - `{ name: "CLAUDE_CODE_RUNTIME_MODE_SLUG", kind: "constant", signature: "\"claude_code.sdk\"" }`
  - `{ name: "ClaudeCodeSdkAdapter", kind: "class", signature: "new ClaudeCodeSdkAdapter(options?: ClaudeCodeSdkAdapterOptions)" }`
  - `{ name: "ClaudeCodeSdkAdapterOptions", kind: "type", signature: "{ command?: string; requestTimeoutMs?: number; liveProbe?: boolean; maxBudgetUsd?: number; clientFactory?: ClaudeCodeClientFactory; doctorProcessFactory?: ProcessFactory; logger?: RuntimeLogger }" }`
  - `{ name: "checkClaudeCodeAvailability", kind: "function", signature: "(input: ClaudeCodeDoctorInput) => Promise<RuntimeAdapterCheck>" }`
  - `{ name: "mapClaudeCodeMessageToSwitchyardEvents", kind: "function", signature: "(input: { runId: string; message: unknown; sequence: number }) => SwitchyardEvent[]" }`
  - `{ name: "ClaudeCodeTranscriptRecorder", kind: "class", signature: "appendRaw(entry), appendNormalized(entry), rawArtifact(runId), normalizedArtifact(runId)" }`
  - `{ name: "createFakeClaudeCodeClientFactory", kind: "function", signature: "(options?: FakeClaudeCodeClientOptions) => ClaudeCodeClientFactory" }`
  - `{ name: "RuntimeRunnerService", kind: "class", signature: "sendInput(runId: string, input: Record<string, unknown>) => Promise<void>; start(run: Run) => Promise<Run>" }`
  - `{ name: "ApprovalService", kind: "class", signature: "approve(id, input?: ResolveApprovalInput) => Promise<ResolveApprovalResult>; reject(id, input?: ResolveApprovalInput) => Promise<ResolveApprovalResult>" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/adapters/src/claude-code/claude-code-adapter.ts`
  - `packages/adapters/src/claude-code/claude-code-doctor.ts`
  - `packages/testkit/src/fake-claude-code-client.ts`
  - `packages/core/src/services/runtime-runner-service.ts`
  - `packages/core/src/services/approval-service.ts`
  - `apps/daemon/src/app.ts`

## Risks

- The official Claude Agent SDK surface is evolving. Keep SDK calls behind `ClaudeCodeClientPort` and make fake fixtures the stable Switchyard contract.
- The current runtime adapter contract has `send()` but no explicit "active input accepted" event. R8 records input acknowledgement in the normalized transcript and logs; it does not add a new public event type.
- Approval resolution after the provider callback expires may happen after the approval row is no longer pending. The API still returns a 409 and the transcript/logs record the stale provider pause reason.
- One implementer owns all files because the user requested one task for the phase. The internal slices and checks are mandatory to keep review/audit tractable.

## Integration Points

- `RuntimeRunnerService` remains the only lifecycle owner for run/session status changes and artifact persistence.
- `ApprovalService` remains the only approval lifecycle API; runtime approvals are normal `Approval` records with a runtime payload marker.
- `ClaudeCodeSdkAdapter` consumes core's existing adapter contract and emits only existing event types.
- `RuntimeDoctorService` consumes Claude adapter custom availability exactly like AgentField/OpenCode custom checks.
- `RegistryService` must infer `runtime: "claude_code"` plus `adapterType: "native"` to `claude_code.sdk`, and explicit internal id `runtime_mode_claude_code_sdk` must be rejected in public create bodies.
- `CodexExecJsonAdapter` behavior stays one-shot; only limitation text and docs change.

## Phase-Level Acceptance Criteria

- [ ] `claude_code.sdk` runtime mode, doctor, adapter, daemon registration, deterministic tests, docs, and smoke are shipped.
- [ ] Core runner supports post-start input status, approval pause/resolution, session state patching, and clear unsupported semantics.
- [ ] Codex remains one-shot; no Codex PTY or interactive runtime mode ships.
- [ ] Existing R5-R7 runtime and middleware behavior remains green.
- [ ] Default tests and smoke do not run live Claude or Codex prompts.
- [ ] Docs clearly separate fake/no-spend verification from opt-in live probe commands.

## Self Review

1. Spec coverage: every R8 acceptance criterion maps to `P7-T1-interactive-coding-runtimes`.
2. Placeholder scan: no placeholder markers or unspecified edge handling is present.
3. Type consistency: exported Claude and core signatures are named once in integration contracts.
4. Ownership disjoint: one task owns all listed files, so there is no cross-task overlap.
5. Context files real: all context paths listed above exist in this worktree.
6. Acceptance testable: each acceptance item has a concrete route, manifest, event, artifact, or command check.
7. Dependency order sane: the single task has no dependencies and uses internal slice order.
8. Checks runnable: commands use existing pnpm package scripts and repository test patterns.
9. Error/rescue map present: every failure-prone codepath has a named rescue and user-visible result.
10. Observability present: logs, success metric, and failure metric are specified.
11. Test cases enumerate acceptance: happy, nil, empty, error, edge, and integration cases are listed.
12. Integration contracts walk: there are no imports from other tasks; all exports are owned by this task.
13. Contract types match: `sendInput`, `ApprovalService`, and Claude adapter signatures align with existing port shapes.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error_rescue_map entry has a matching `error_path`, `happy_shadow_*`, `edge_*`, or integration test case.
- [x] Every `integration_contracts.imports_from_other_tasks` resolves to a real export elsewhere; this task has none.
- [x] Every `context_files` path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is present.
- [x] Complexity is M in the spec; the only complexity smell is one requested end-to-end task touching many files, called out under Risks.
