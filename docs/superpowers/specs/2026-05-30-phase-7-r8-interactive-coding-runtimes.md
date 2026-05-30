# Phase 7 Spec: R8 Interactive Coding Runtimes

Date: 2026-05-30

Roadmap release: R8: Interactive Coding Runtimes

Branch: `agent/phase-7-r8-interactive-coding-runtimes`

Previous phase head: `agent/phase-6-r7-middleware-foundation`

Spec target: `docs/superpowers/specs/2026-05-30-phase-7-r8-interactive-coding-runtimes.md`

## Summary

R8 adds the first bounded interactive coding-runtime path on top of the shipped runtime capability and middleware layers. The release must prove post-start input, session state, approval pauses, and richer transcript behavior through deterministic tests, while keeping real model spend and PTY behavior explicitly gated.

The product decision for this phase is conservative:

- Claude Code is the interactive runtime target for R8, using the TypeScript Agent SDK as the primary adapter path because it exposes streaming input, sessions, and approval callbacks.
- Claude Code stream-json CLI remains the fallback only if SDK installation or runtime loading is blocked; the fallback must still be structured JSONL, not PTY.
- Codex remains `codex.exec_json` for now. A no-spend local probe shows Codex has interactive TUI commands and one-shot `exec resume --json`, but no proven structured long-lived post-start input surface. R8 must not promote a `codex.interactive` or PTY mode unless a structured no-TUI path is proven in code and smoke.

## Scope Gate

In scope:

- Add runtime capability vocabulary for interactive input, session state/resume, tool-call normalization, and approval bridging.
- Add core runner behavior for adapter-emitted waiting states, runtime approval pauses, runtime approval resolution, and session state patches.
- Add a Claude Code runtime mode, adapter, doctor check, deterministic fake client/process harness, event mapper, transcript artifacts, and daemon registration.
- Implement post-start input for Claude Code where the SDK structured streaming input path is used; keep exact `409` unsupported semantics for modes that cannot accept input.
- Persist useful session state when the provider exposes it, including Claude session id and any Codex thread/session id observed in JSONL events.
- Add Codex interactive decision documentation and optional one-shot resume support only where `codex exec resume --json` can be exercised safely through fake fixtures.
- Normalize tool calls, tool results, approval pauses, and AskUserQuestion-style clarification pauses into existing Switchyard event and approval records.
- Add richer raw plus normalized transcript artifacts for the new Claude path and preserve existing transcript behavior for shipped modes.
- Update local runtime docs and smoke commands. Default smoke and tests must use fakes or no-spend checks.

Out of scope:

- Cursor.
- OpenClaw, Paperclip, browser/search, GitHub, shell, repo mutation, or other real tool expansion.
- Unbounded autonomous multi-agent execution, debate orchestration, background agent teams, or hosted worker scheduling.
- Hosted arbitrary subprocess or PTY execution.
- A broad generic PTY substrate.
- Promoting Codex to `codex.interactive` without a proven structured/headless interactive path.
- Running live Claude or Codex model prompts in automated tests, default doctor checks, or default local smoke.
- Exposing secrets, auth tokens, API keys, raw auth JSON, full local environment, or unredacted tool inputs in logs, doctor output, transcripts, or artifacts.

## Existing Context

This spec is based on real files in this worktree plus no-spend local CLI probes run on 2026-05-30.

`PRODUCT.md` defines the R8 release target:

```md
### R8: Interactive Coding Runtimes

Status: planned.

Goal: add richer coding-runtime behavior after the runtime capability and middleware foundations exist.
```

`PRODUCT.md` also names the release scope:

```md
- Codex interactive runtime mode decision: structured process if available, PTY only if necessary.
- post-start input where Codex supports it or explicit unsupported semantics if it cannot.
- session state and resume behavior where available.
- approval bridging where exposed by the runtime.
- Claude Code adapter using SDK or stream-json after an approved live probe.
- tool-call and approval-pause normalization.
- richer transcript artifacts.
- runtime docs and local smoke commands.
```

`packages/core/src/ports/runtime-adapter.ts` is the adapter contract R8 must extend without breaking shipped adapters:

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

`packages/contracts/src/run.ts` already has waiting statuses that R8 can make meaningful:

```ts
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
```

`packages/contracts/src/session.ts` already persists runtime session state:

```ts
export const runtimeSessionSchema = z.object({
  id: sessionIdSchema,
  runId: runIdSchema,
  runtime: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  protocol: runtimeProtocolSchema,
  status: runtimeSessionStatusSchema,
  externalSessionKey: z.string().min(1).optional(),
  processId: z.number().int().positive().optional(),
  runtimeMode: runtimeModeSlugSchema.nullable().optional(),
  state: z.record(z.string(), z.unknown()).default({}),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema.optional()
});
```

`packages/contracts/src/registry.ts` has runtime-mode kinds but does not yet have explicit interactive capability names:

```ts
export const runtimeModeKindSchema = z.enum([
  "deterministic_fake",
  "one_shot_process",
  "interactive_process",
  "pty",
  "acp",
  "sdk",
  "sync_http",
  "async_rest",
  "browser_backed"
]);

export const runtimeCapabilitySchema = z.enum([
  "run.start",
  "run.cancel",
  "run.timeout",
  "event.normalized",
  "event.streaming",
  "artifact.transcript",
  "artifact.raw_transcript",
  "model.catalog",
  "tool.fake_echo",
  "auth.none",
  "auth.local",
  "auth.api_key",
  "sandbox.read_only",
  "sandbox.workspace_write",
  "sandbox.danger_full_access"
]);
```

`packages/protocol-rest/src/run-routes.ts` already exposes the post-start input endpoint and maps adapter protocol failures to a `409` envelope:

```ts
app.post("/runs/:id/input", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const run = await deps.runs.get(id);
  if (!run) {
    return sendHttpError(reply, "run_not_found", `Run not found: ${id}`);
  }

  try {
    await deps.runService.sendInput(id, parseInputBody(request.body));
  } catch (error) {
    if (error instanceof AdapterProtocolError) {
      return sendHttpError(
        reply,
        "adapter_protocol_failed",
        error.message,
        adapterProtocolDetails(error)
      );
    }
    throw error;
  }
  return reply.code(202).send({ accepted: true });
});
```

`packages/adapters/src/codex/codex-exec-json-adapter.ts` proves existing Codex behavior and explicitly excludes input/resume/approval bridge claims:

```ts
limitations: [
  { code: "one_shot_no_input", message: "codex.exec_json does not support post-start input." },
  { code: "local_only", message: "This mode runs a local Codex CLI process and is not hosted-safe in R3." },
  { code: "no_approval_bridge", message: "Approval bridge integration is not shipped for codex.exec_json in R3." },
  { code: "no_session_resume", message: "Session resume is not shipped for codex.exec_json in R3." }
],
```

`docs/adapters/codex.md` currently says the same product truth:

```md
Implemented for non-interactive local `codex exec --json` runs. Interactive sessions, approval bridging, PTY support, and hosted process execution are not implemented yet.
```

`docs/adapters/claude-code.md` records the intended integration order:

```md
## Preferred Protocol

- Primary: Claude Agent SDK if the SDK surface is stable.
- Fallback: `claude -p --output-format stream-json`.
- Last resort: PTY, local-only by policy.
```

No-spend local Codex probe on 2026-05-30:

```text
codex-cli 0.134.0
Commands:
  exec            Run Codex non-interactively [aliases: e]
  mcp-server      Start Codex as an MCP server (stdio)
  app-server      [experimental] Run the app server or related tooling
  remote-control  [experimental] Manage the app-server daemon with remote control enabled
  resume          Resume a previous interactive session (picker by default; use --last to continue
                  the most recent)
  fork            Fork a previous interactive session (picker by default; use --last to fork the
                  most recent)
```

No-spend local Codex `exec resume` probe on 2026-05-30:

```text
Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]

Arguments:
  [SESSION_ID]
          Conversation/session id (UUID) or thread name.
  [PROMPT]
          Prompt to send after resuming the session. If `-` is used, read from stdin

Options:
      --json
          Print events to stdout as JSONL
```

No-spend local Claude Code probe on 2026-05-30:

```text
2.1.156 (Claude Code)
--input-format <format>       Input format (only works with --print):
                              "text" (default), or "stream-json"
--output-format <format>      Output format (only works with --print):
                              "text" (default), "json", or "stream-json"
--include-partial-messages    Include partial message chunks as they arrive
--max-budget-usd <amount>     Maximum dollar amount to spend on API calls
-r, --resume [value]          Resume a conversation by session ID
--session-id <uuid>           Use a specific session ID for the conversation
```

Official Claude Code documentation aligns with the local probe: Agent SDK supports streaming input, sessions, permissions, and approvals; `claude -p` supports `stream-json`, `--continue`, and `--resume`. R8 should treat official documentation as volatile and pin observed local behavior in tests before marking a runtime mode available.

## Product Terms

Interactive runtime mode:

- A runtime mode whose manifest includes `run.input` and whose adapter can accept `POST /runs/:id/input` while the run is active.
- It must not be inferred from a TUI command alone. A terminal UI with no structured input/output contract is not enough.

Session state:

- Provider/session identifiers and small JSON state patches stored in `runtime_sessions.external_session_key` and `runtime_sessions.state`.
- State must be redacted, bounded, and safe to expose in artifacts or debug output.

Resume:

- Starting a new provider turn using a provider-exposed session id from a previous run.
- Resume is not the same as post-start input. A one-shot resume path can have `session.resume` without `run.input`.

Approval bridge:

- A runtime asks for permission or user input through a structured callback/event.
- Switchyard persists a normal `approval` record, marks the run/session as `waiting_for_approval`, and resolves the provider pause when `POST /approvals/:id/approve` or `/reject` is called.
- If a provider only fails or blocks without exposing a structured callback, R8 must record `no_approval_bridge` and return a visible failure or unsupported response.

Richer transcript:

- Raw provider stream plus normalized Switchyard-side events, input acknowledgements, session state updates, and approval pause/resolution entries.
- Richer transcripts must remain redacted and bounded. They complement raw transcripts; they do not replace raw transcript preservation.

Approved live probe:

- A deliberately user-enabled run of a real provider prompt for compatibility verification.
- Automated tests, default doctor, default local smoke, and CI must not run live model prompts.

## Architecture

R8 builds on the existing adapter contract instead of adding a new orchestration system. The core addition is a runtime interaction layer inside `RuntimeRunnerService` and `ApprovalService`:

1. Adapters may emit `runtime.status` payloads with `status: "waiting_for_input"` or `status: "waiting_for_approval"`, plus an optional `sessionStatePatch`.
2. The runner persists state patches to `runtime_sessions.state` and updates run/session status for waiting states.
3. Adapters may emit `approval.requested` with a `runtimeApprovalToken`, `approvalType`, `toolName`, sanitized `toolInput`, and optional `question`/`options` metadata. The runner creates or delegates to `ApprovalService` to create a normal persisted approval record.
4. `ApprovalService.approve` and `ApprovalService.reject` continue to append existing lifecycle events. When the approval payload links to a runtime pause, the service sends a structured `approval_resolution` input to the active runtime session.
5. Runtime adapters decide how to resolve provider callbacks. If the provider callback can accept allow/deny decisions, the adapter resumes. If it cannot, the adapter fails visibly with a provider-specific reason code.

The first true interactive provider is Claude Code through a new `claude_code.sdk` runtime mode:

- Adapter id: `claude_code`
- Provider id: `provider_anthropic`
- Runtime id: `runtime_claude_code`
- Runtime mode id: `runtime_mode_claude_code_sdk`
- Runtime mode slug: `claude_code.sdk`
- Adapter type: `native`
- Runtime mode kind: `sdk`
- Placement: local conditional, hosted unsupported, connected local node future
- Default permission stance for smoke: read-only or plan-like, with no write/shell permissions unless request metadata explicitly widens allowed tools or permission mode

The implementation should prefer the TypeScript Agent SDK because it provides streaming input, sessions, and approval callbacks. If SDK install/import is not viable in the implementation worktree, the fallback is a structured CLI adapter around `claude -p --output-format stream-json --input-format stream-json`; the fallback must keep the same runtime mode slug only if it supports `run.input` in fake and live-probe smoke. If it cannot support approval callbacks, its manifest must omit `approval.bridge` and include `no_approval_bridge`.

Codex remains a one-shot structured process in R8. The implementation may add one-shot resume support to `CodexExecJsonAdapter` via `codex exec resume --json <session> <prompt>` if fake-process tests prove argument construction and event mapping. It must not add a `codex.interactive` runtime mode, PTY mode, or hosted mode in this phase. If a structured Codex app-server, exec-server, remote-control, or MCP-server route is investigated during implementation, the result must be documented as a decision and the runtime mode must stay unavailable unless post-start input and transcript behavior are smoke-proven without TUI scraping.

## Contract Changes

Extend `runtimeCapabilitySchema` with these literal values:

- `run.input`
- `session.state`
- `session.resume`
- `approval.bridge`
- `tool.call.normalized`
- `tool.result.normalized`
- `user.question`

Add no new run statuses; use the existing `waiting_for_input` and `waiting_for_approval`.

Add no new event types unless implementation proves the existing event vocabulary cannot express the behavior. Preferred mapping:

- Provider text deltas: `runtime.output`
- Provider lifecycle/status/retry/session updates: `runtime.status`
- Provider tool call start: `tool.call`
- Provider tool result/completion/failure: `tool.result`
- Provider approval or user-question pause: `approval.requested`
- Approval lifecycle: existing `approval.approved`, `approval.rejected`, `approval.expired`

Add a small internal event payload convention. This is a payload convention, not a new top-level contract type:

```json
{
  "status": "waiting_for_approval",
  "runtimeApprovalToken": "provider-local-token",
  "approvalType": "before_destructive_command",
  "providerToolName": "Bash",
  "toolInput": { "command": "rm tmp.txt" },
  "question": null,
  "sessionStatePatch": {
    "claudeSessionId": "redacted-or-provider-session-id"
  }
}
```

Approval resolution input sent to adapters:

```json
{
  "type": "approval_resolution",
  "approvalId": "approval_...",
  "runtimeApprovalToken": "provider-local-token",
  "decision": "approved",
  "updatedInput": { "command": "rm tmp.txt" },
  "message": "approved by local-user"
}
```

Post-start user input accepted by REST:

```json
{
  "text": "Please continue, but keep the changes read-only."
}
```

The runner sends provider input to SDK-backed Claude as:

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

For R8 REST input remains text-only. Image attachments, binary attachments, arbitrary SDK message injection, and parent tool-use routing are out of scope.

## User-Visible Behavior

Scenario: inspect runtime modes.

- User calls `GET /runtime-modes`.
- `codex.exec_json` still appears as one-shot process and does not claim `run.input`.
- `claude_code.sdk` appears as an SDK-backed local conditional runtime mode with `run.input`, `session.state`, `approval.bridge`, `event.streaming`, `artifact.transcript`, and `artifact.raw_transcript` when the SDK path is implemented.
- If Claude Code is installed but no approved live probe has been run, doctor may report `installed` or `partial` with `reasonCode: "live_probe_required"`; it must not claim live model run availability from version checks alone.

Scenario: post-start input on supported runtime.

- User creates a Claude Code run asynchronously.
- While the run is active, user calls `POST /runs/:id/input` with `{ "text": "continue with option A" }`.
- Switchyard returns `202 { "accepted": true }`, appends a normalized input acknowledgement to the rich transcript, and the adapter forwards a structured user message to the SDK input queue.
- If the run is already terminal, Switchyard returns `409 adapter_protocol_failed` with `reasonCode: "runtime_input_not_active"`.

Scenario: post-start input on unsupported runtime.

- User calls `POST /runs/:id/input` for `codex.exec_json`, `opencode.acp`, `agentfield.async_rest`, `generic_http.async_rest`, or `fake.deterministic`.
- Switchyard returns the existing `409 adapter_protocol_failed` envelope with the adapter-specific reason code, for example `codex_input_unsupported`.
- The run status is not changed by the failed input attempt.

Scenario: Claude asks for approval.

- Claude SDK callback asks to use a tool not pre-approved by policy.
- Adapter emits a sanitized approval-pause event.
- Switchyard persists a normal approval record, marks the run and session `waiting_for_approval`, and publishes `approval.requested`.
- User approves with `POST /approvals/:id/approve`.
- Switchyard publishes `approval.approved`, sends an `approval_resolution` input to the adapter, and the SDK callback resumes with allow or deny.
- If the provider callback disappears before resolution, approval resolution returns `409 adapter_protocol_failed` with `reasonCode: "runtime_approval_pause_not_active"` and the run fails visibly or remains terminal if already ended.

Scenario: Claude asks a clarification question.

- Adapter maps AskUserQuestion-style input to `approval.requested` with `approvalType: "before_external_message"` and payload fields `question`, `options`, `multiSelect`, and `responseFormat: "ask_user_question"`.
- User approval response can carry structured answers in the existing approval resolution body `reason` or in a future UI field; in R8 REST may accept a JSON body extension `{ "answers": { ... } }` only if this can be added without breaking current approve/reject shapes.
- If no structured answer field is added, the adapter denies with a message from `reason` and records `user_question_text_response_only` in the transcript. This limitation must be documented.

Scenario: local smoke without model spend.

- Developer runs deterministic adapter/core tests.
- No real Claude or Codex prompt is executed.
- Fake Claude client fixtures cover output streaming, post-start input, tool call events, approval pause/resume, approval reject, empty output, malformed stream event, timeout, cancel, and transcript capture.

## Data Flow Shadow Paths

Runtime mode registration:

- Happy path: daemon starts, seeds `claude_code.sdk`, `GET /runtime-modes/claude_code.sdk` shows the manifest and current availability.
- Nil path: Claude adapter is not registered in the adapter map; doctor returns `unsupported` with `reasonCode: "adapter_not_registered"` and daemon startup does not crash.
- Empty path: manifest has an empty capability array; schema validation fails in tests before daemon registration.
- Error path: SDK import throws or CLI version check fails; doctor returns `unavailable` or `partial` with redacted diagnostics and no secret leakage.

Post-start input:

- Happy path: active Claude run receives non-empty `text`, returns `202`, and transcript records a redacted input acknowledgement.
- Nil path: request body is missing or not an object; REST returns `400 invalid_input` with `path: "body"`.
- Empty path: `{ "text": "" }` or whitespace-only text returns `400 invalid_input` with `path: "text"`.
- Error path: adapter rejects because run is terminal, missing session, unsupported mode, or provider input queue is closed; REST returns `409 adapter_protocol_failed` with a specific `reasonCode`.

Provider event stream:

- Happy path: provider text, status, tool, approval, completion, and usage events map to normalized Switchyard events in sequence.
- Nil path: event payload is null or missing required type; adapter maps to `runtime.status` with `status: "provider_event_unknown"` and includes bounded raw type metadata.
- Empty path: provider completes without output; run completes if provider says success and transcript records `empty_output: true`.
- Error path: malformed JSON, SDK exception, stream abort, or process exit before terminal event yields `run.failed` with a provider-specific reason code and transcript artifact when any bytes were captured.

Approval pause and resolution:

- Happy path: provider approval callback pauses, Switchyard approval is persisted, user approves/rejects, provider resumes, and transcript records both pause and resolution.
- Nil path: approval event lacks `runtimeApprovalToken`; runner stores a failed `approval.requested` normalization event and fails the run with `runtime_approval_token_missing`.
- Empty path: approval payload has no tool name, question, or reason; approval is created with `reasonCode: "runtime_approval_payload_empty"` and severity warning in transcript.
- Error path: approval resolution arrives after provider callback timed out or run terminalized; API returns `409 approval_not_pending` or `409 adapter_protocol_failed` with `runtime_approval_pause_not_active`.

Session state and resume:

- Happy path: Claude SDK exposes a session id; runner stores it as `externalSessionKey` and `state.claudeSessionId`. A later run can pass `metadata.resumeSessionId` and adapter resumes through provider-supported resume options.
- Nil path: provider exposes no session id; run still works, but manifest omits `session.resume` or records limitation `session_id_not_exposed`.
- Empty path: caller passes an empty `metadata.resumeSessionId`; run creation returns `400 invalid_input`.
- Error path: provider rejects resume id; run fails with `provider_resume_failed`, the transcript records the redacted resume id hash, and no new session id is persisted.

Transcript persistence:

- Happy path: raw and normalized transcript artifacts are stored under `runs/<runId>/...`, with content written through the artifact content store when configured.
- Nil path: artifact store is absent in in-memory harness; adapter still returns artifact metadata but REST `GET /runs/:id/artifacts` returns the existing empty list behavior.
- Empty path: provider emitted no bytes; normalized transcript still includes start, terminal, and empty-output markers.
- Error path: artifact path normalization fails or content write throws; run fails visibly after terminal event with `run.failed` and logger event `runtime.transcript_persist_failed`.

Doctor and live probe:

- Happy path: no-spend doctor detects version/auth state and reports `installed` or `available` according to configured probe level.
- Nil path: command path is missing; doctor returns `unavailable`, `installed: false`, `auth: "unknown"`, `reasonCode: "binary_unavailable"`.
- Empty path: command returns empty output; doctor returns `unknown` with `reasonCode: "check_empty_output"`.
- Error path: check times out, output exceeds diagnostic limit, or auth JSON cannot be parsed; doctor returns bounded diagnostic codes and does not log raw secrets.

## Implementation Requirements

### Contracts

- Add runtime capability enum values listed in Contract Changes.
- Add tests proving existing shipped runtime manifests still parse unchanged.
- Add tests proving `claude_code.sdk` manifest parses with `run.input`, `session.state`, and `approval.bridge`.
- Do not remove or rename existing statuses, event types, runtime mode kinds, or existing capability values.

### Core Runner And Approval Bridge

- `RuntimeRunnerService` must update persisted run/session status to `waiting_for_input` or `waiting_for_approval` when normalized adapter events request those states.
- `RuntimeRunnerService` must merge bounded `sessionStatePatch` objects into `runtime_sessions.state`; patches must reject arrays, functions, huge payloads, and keys containing secrets such as `token`, `apiKey`, `authorization`, or `password`.
- `sendInput` must return specific adapter protocol errors for terminal runs, missing sessions, unsupported input, empty input, and closed provider input queue.
- Approval bridge must persist normal `Approval` records. It must not invent a second approval store.
- Approval resolution must be idempotent at the API boundary: a second approval/reject attempt for the same approval returns existing `409 approval_not_pending`.
- Approval bridge must not auto-approve provider tool calls unless the run approval policy or provider permission mode explicitly allows it.
- If a runtime emits an approval pause but the bridge is not configured, the run fails with `runtime_approval_bridge_unconfigured` rather than hanging.

### Claude Code Adapter

- Add `packages/adapters/src/claude-code/` with adapter, event mapper, doctor, types, transcript helper usage, and deterministic fake client/process fixtures.
- Register exports in `packages/adapters/src/index.ts`.
- Register daemon config in `apps/daemon/src/config.ts`:
  - `SWITCHYARD_CLAUDE_CODE_COMMAND` for CLI fallback or doctor version checks.
  - `SWITCHYARD_CLAUDE_CODE_LIVE_PROBE` default `0`.
  - `SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD` default bounded for live runs and probes.
  - `SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS`.
- Seed provider/runtime/model/runtime-mode records in `apps/daemon/src/app.ts`.
- Doctor default must run no model prompt. It can run `claude --version` and `claude auth status --json` only if raw output is parsed and redacted before logging/persistence.
- Live probe can run a tiny prompt only when explicitly enabled by env/config. It must pass `--max-budget-usd`, disable broad tools, and record `reasonCode: "live_probe_disabled"` when not enabled.
- SDK adapter must use streaming input. If the SDK path cannot be implemented in this phase, CLI fallback must use stream-json input and output. Plain text parsing and PTY are not acceptable fallbacks.
- Adapter must reject relative `cwd`, missing task, empty task, unsupported permission mode, and unsupported tool configuration with `AdapterProtocolError` reason codes.
- Adapter must default to safe/read-only or plan-like permissions for smoke. Write/shell/bypass modes require explicit metadata/config and must be reflected in transcript metadata.
- Adapter must never pass `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, or equivalent bypass behavior from untrusted run metadata.
- Adapter must map provider usage/cost/session data when present, but redact account ids, tokens, auth helper output, and environment.

### Codex Decision And Resume Boundary

- Keep `codex.exec_json` as one-shot. Its manifest must still omit `run.input` and `approval.bridge`.
- Update Codex limitations from stale R3 wording to current phase wording without claiming new behavior.
- If implementing one-shot resume support, it must be behind explicit run metadata `resumeSessionId` and use `codex exec resume --json`, not TUI `codex resume`.
- `POST /runs/:id/input` for Codex continues to return `409 adapter_protocol_failed` with `reasonCode: "codex_input_unsupported"`.
- Add a local decision note in Codex docs: structured post-start input not proven; PTY not selected in R8.

### Tool And Approval Normalization

- Normalize provider tool starts as `tool.call` with sanitized provider tool name and input summary.
- Normalize provider tool terminal states as `tool.result`.
- Do not execute Switchyard real tools as part of Claude approval bridging. Provider tools remain provider-managed unless future phases route them into Switchyard tool adapters.
- For provider requests equivalent to user questions, persist as approvals with `approvalType: "before_external_message"` and payload `responseFormat: "ask_user_question"`.
- If the provider exposes a defer/resume mechanism for long-lived approval pauses, record the capability only after fake and live-probe coverage. Otherwise keep runtime process alive within `timeoutSeconds` and fail visibly on timeout.

### Transcripts And Artifacts

- Preserve existing raw transcript artifacts for Codex, OpenCode, AgentField, Generic HTTP, and fake runtimes.
- New Claude adapter must emit at least one transcript artifact and should emit both:
  - raw provider transcript: `runs/<runId>/claude-code-raw-transcript.jsonl`
  - normalized transcript: `runs/<runId>/claude-code-normalized-transcript.jsonl`
- Normalized transcript entries must include bounded records for start, output, status, tool call, tool result, approval pause, approval resolution, input accepted, terminal, stderr/warnings, and provider errors.
- Artifact metadata must include `runtime`, `mode`, `runtimeMode`, `transcriptVersion: "r8.v1"`, and redaction status.
- Secret redaction tests must scan JSON stringified events, logs where accessible, transcripts, and artifact metadata for configured fake secrets.

### Documentation And Smoke

Implementation must update:

- `docs/adapters/claude-code.md`
- `docs/adapters/codex.md`
- `docs/development/adapters/README.md`
- a new `docs/development/adapters/CLAUDE_CODE.md`
- `docs/development/DEVELOPMENT.md`
- `PRODUCT.md` R8 status text only if the implementation phase closes as shipped

Smoke docs must include:

- no-spend doctor commands.
- fake/deterministic test commands.
- explicit opt-in live Claude probe command with cost warning and max budget.
- `POST /runs/:id/input` examples for supported and unsupported modes.
- approval-pause example using deterministic fake fixtures or a documented SDK fake, not a real destructive tool.

## Constraints

- Default tests and smoke must not execute real model prompts.
- PTY is not allowed in R8 unless a separate implementation decision proves no structured path exists and the user explicitly accepts local-only PTY risk. This spec does not authorize PTY work.
- Hosted arbitrary subprocess execution remains out of scope.
- Runtime docs and manifests must not overclaim. Availability must reflect actual local checks.
- All new external dependency additions must be justified by the Claude SDK path. If the SDK dependency is added, package lock changes belong to the implementation phase, not this spec.
- Existing public endpoints and shipped runtime modes must remain backward compatible.
- SQLite migrations must be additive only if required; prefer existing `runtime_sessions.state_json` and existing approval tables.
- Runtime logs must be bounded and redacted.

## Acceptance Criteria

- [ ] `GET /runtime-modes/claude_code.sdk` returns a runtime mode with local conditional placement, SDK kind, `run.input`, `session.state`, `approval.bridge`, streaming events, transcript capabilities, and no hosted support.
- [ ] `GET /runtime-modes/codex.exec_json` still reports one-shot behavior and does not claim `run.input`, `approval.bridge`, or PTY support.
- [ ] `POST /runtime-modes/claude_code.sdk/check` performs no model-spend prompt by default and reports installed/auth/live-probe state without leaking secrets.
- [ ] An explicit live-probe path exists but is off by default and uses a bounded max budget.
- [ ] Deterministic Claude fake tests prove start, streaming output, post-start input, session id persistence, empty output, malformed event failure, cancellation, timeout, transcript capture, and artifact retrieval.
- [ ] Deterministic approval tests prove provider approval pause creates a persisted approval, marks the run/session waiting, approve resumes provider execution, reject denies provider execution, and stale approval resolution fails visibly.
- [ ] `POST /runs/:id/input` returns `202` for active supported Claude sessions and appends a redacted input acknowledgement to the normalized transcript.
- [ ] `POST /runs/:id/input` returns `400 invalid_input` for missing, non-object, empty, or whitespace-only input bodies.
- [ ] `POST /runs/:id/input` returns `409 adapter_protocol_failed` with provider-specific `reasonCode` for terminal runs, missing sessions, closed input queues, and unsupported runtime modes.
- [ ] Claude adapter transcripts include raw and normalized artifacts and never include fake auth tokens/API keys in tests.
- [ ] Codex one-shot behavior and existing Codex adapter tests remain green.
- [ ] If Codex one-shot resume is implemented, fake-process tests prove `codex exec resume --json` argument construction and failure mapping; if not implemented, docs explicitly say resume remains deferred.
- [ ] Daemon startup seeds Claude Code provider/runtime/model/runtime-mode records and existing fake/Codex/OpenCode/AgentField/Generic HTTP seeding still works.
- [ ] Runtime doctor summary includes Claude Code state without crashing when Claude is missing, auth is missing, SDK import fails, or live probe is disabled.
- [ ] Docs include no-spend smoke, opt-in live smoke, unsupported-input examples, approval-pause semantics, and the Codex no-PTY decision.
- [ ] `pnpm --filter @switchyard/contracts test`, `pnpm --filter @switchyard/core test`, `pnpm --filter @switchyard/adapters test`, `pnpm --filter @switchyard/protocol-rest test`, `pnpm --filter @switchyard/daemon test`, and root `pnpm typecheck` pass.

## Test Cases

- `happy_claude_fake_streaming_input`: create fake Claude run, stream output, send input, receive follow-up output, complete.
- `happy_claude_fake_approval_approve`: fake provider pauses for tool approval, approval record persists, approve resumes, run completes.
- `happy_claude_fake_approval_reject`: fake provider pauses, reject resumes denial path, run completes or fails with provider-denied status according to fake fixture.
- `happy_claude_session_state`: fake provider emits session id, runner stores `externalSessionKey` and state patch.
- `happy_shadow_nil_input`: `POST /runs/:id/input` with no body returns `400 invalid_input`.
- `happy_shadow_empty_input`: `POST /runs/:id/input` with empty text returns `400 invalid_input`.
- `error_input_after_terminal`: supported runtime completes, later input returns `409 runtime_input_not_active`.
- `error_unsupported_codex_input`: Codex input still returns `409 codex_input_unsupported`.
- `error_claude_malformed_json`: fake provider emits malformed stream record, adapter emits `run.failed` and transcript persists captured bytes.
- `error_approval_token_missing`: adapter approval event lacks token, runner fails visibly with `runtime_approval_token_missing`.
- `error_approval_stale_resolution`: approval is resolved after run terminalizes, API returns `409`.
- `error_secret_redaction`: fake env/API key/auth output appears in fake provider source data but not in events, doctor output, logs captured by test, transcripts, or artifact metadata.
- `integration_daemon_registry`: daemon app exposes Claude mode alongside existing modes and doctor summary counts it.
- `integration_docs_smoke_commands`: documented smoke commands use fake/no-spend paths by default.

## Implementation Phase

### Phase 7: R8 Interactive Coding Runtimes

Goal: Ship one bounded interactive coding-runtime release centered on Claude Code SDK/structured streaming, with core input/approval/session normalization and a documented Codex no-PTY decision.

Acceptance:

- Claude Code runtime mode, doctor, adapter, daemon registration, deterministic tests, docs, and smoke are shipped.
- Core runner supports post-start input status, approval pause/resolution, session state patching, and clear unsupported semantics.
- Codex remains one-shot unless safe one-shot resume is explicitly implemented and tested; no Codex PTY mode ships.
- Existing R5-R7 runtime and middleware behavior remains green.

Non-goals:

- Cursor.
- Hosted subprocess/PTY execution.
- Debate/multi-agent orchestration.
- Real tools routed through Switchyard.
- Default live provider spend.

Complexity: M

## Open Concerns

- Claude Code SDK package/API may have shifted since local docs and CLI help were checked. The implementation must isolate SDK usage behind a small adapter port and keep fake fixtures as the stable contract.
- Claude Code approval callbacks are best supported by the SDK, not necessarily by CLI stream-json. If the implementation falls back to CLI, it may need to omit `approval.bridge` and document that limitation.
- Codex has promising experimental surfaces (`app-server`, `remote-control`, `exec-server`, `mcp-server`), but none are approved by this spec for R8 because post-start input/session/approval semantics were not proven without TUI scraping.
- Existing `GET /runs/:id` does not expose runtime session details. R8 can persist state for future use and transcripts, but a public session-inspection API is deferred unless needed for acceptance.
- Approval answers for AskUserQuestion may need a small REST body extension on approve/reject. If that extension is too invasive, R8 should ship text-only response semantics and document it.

## Source Notes

- Local files read: `PRODUCT.md`, `PROJECT.md`, `docs/adapters/codex.md`, `docs/adapters/claude-code.md`, runtime adapter/core/REST/storage files under `packages/` and daemon wiring under `apps/daemon/src/app.ts`.
- No-spend local probes run: `codex --version`, `codex --help`, `codex exec --help`, `codex resume --help`, `codex exec resume --help`, `claude --version`, `claude --help`, `claude -p --help`, `claude doctor --help`, `claude auth status --help`.
- Official Claude Code docs checked for Agent SDK, streaming input, stream-json, sessions, and approvals.
