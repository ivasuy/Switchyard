# Phase 15 Spec: R16 Interactive Codex And Approval Bridges

**Date:** 2026-05-30
**Run:** post-r11-remaining-20260530
**Branch:** `agent/phase-15-r16-interactive-codex-and-approval-bridges`
**Spec target:** `docs/superpowers/specs/2026-05-30-phase-15-r16-interactive-codex-and-approval-bridges.md`

## Problem

Switchyard now has local runtime modes, middleware approval records, Claude Code interactive input/approval behavior, fake hosted execution, and opt-in self-hosted/staging real hosted execution for known modes. The largest remaining runtime gap is Codex: `codex.exec_json` is reliable for one-shot runs, but it cannot accept post-start input, cannot resume a Codex session through Switchyard, and cannot bridge Codex permission/approval pauses into Switchyard approvals.

R16 should close the narrow Codex interaction gap without turning Switchyard into a public terminal, PTY, shell, or managed hosted platform. The release must add a separate bounded local Codex interactive mode only if the adapter can be proven through deterministic no-spend fake Codex process/session factories. Runtime-specific approval/session-resume support must be truthful: if a local Codex capability is not wired, the registry, docs, and API errors must say so.

## Goals

- Preserve `codex.exec_json` as the default one-shot Codex mode with unchanged API behavior, runtime-mode slug, process args, closed stdin, unsupported input semantics, and transcript path.
- Add a separate explicit Codex runtime mode, `codex.interactive`, only for local bounded interaction. It must never be selected by inference when callers omit `runtimeMode`; omitted Codex mode stays `codex.exec_json`.
- Support local post-start text input for `codex.interactive` when a bounded Codex session factory is available. The implementation may use a real local Codex headless capability such as `codex exec resume --json` or a local app-server/control protocol only after no-spend probes and fake factories prove the data flow.
- Persist Codex session state patches, including a discovered Codex thread/session id, with the same bounded and redacted session-state rules already used by the runtime runner.
- Add a runtime-specific Codex resume bridge where local Codex exposes a resumable session id or thread id. Missing, malformed, or stale resume tokens must fail visibly.
- Establish the shared runtime approval bridge contract for Codex and future OpenCode/AgentField/Generic HTTP wiring: runtime approval request event shape, approval lifecycle mapping, resolution payload shape, expiration behavior, stale-session behavior, and unsupported-bridge failure codes.
- Wire Codex approval bridging only where the local Codex driver actually supports a non-PTY approval request/resolution path. If the real local Codex bridge is unsupported, `codex.interactive` must not overclaim live approval support; it must fail with a named reason and document the limitation.
- Keep all required tests and default smoke no-spend by using fake Codex session/process streams and fake approval-resolution paths.
- Update product/development docs in the implementation phase so they say exactly what shipped and what remains unshipped.

## Non-Goals

- No change to `codex.exec_json` one-shot semantics.
- No automatic promotion from `codex.exec_json` to `codex.interactive`.
- No dashboard.
- No TUI.
- No public PTY route.
- No public terminal route.
- No public `/sandbox`, `/exec`, `/pty`, `/terminal`, shell, generic process, or arbitrary command execution API.
- No arbitrary PTY/generic process adapter.
- No Codex TUI automation, alternate-screen scraping, keyboard-driving, or public terminal bridge.
- No real browser/search/fetch/repo/shell/GitHub tool execution.
- No hosted post-start input bridge. Hosted real runs remain worker-owned start-to-terminal jobs unless a later release ships a hosted bridge.
- No hosted Codex interactive sessions.
- No hosted approval bridge for Codex, OpenCode, AgentField, or Generic HTTP.
- No managed production hosted platform, tenant controls, billing, enterprise RBAC, organization management, or production arbitrary subprocess sandboxing.
- No Cursor, OpenClaw, Paperclip, browser/search, or broad wrapper-runtime expansion.
- No live provider prompt spend in required tests, default smoke, or default doctor checks.

## Current Truth

`PROJECT.md` Phase 14 records the release immediately before this phase: R15 shipped opt-in self-hosted/staging hosted real execution for known one-shot/provider modes, but did not ship interactive Codex, session resume, approval bridges, hosted input, dashboard, or TUI.

```md
R15 does not ship managed production hosted platform deployment, production arbitrary subprocess/PTY sandboxing, arbitrary hosted subprocess execution, generic process/PTY adapters, public `/sandbox`, `/exec`, `/pty`, or `/terminal` APIs, hosted Generic HTTP/AgentField/Cursor/OpenClaw/Paperclip/browser/search/fetch/GitHub/repo/shell execution, real shell/browser/search/GitHub/fetch/repo tools, interactive Codex sessions, Codex session resume or approval bridge, hosted post-start input bridge, enterprise auth/billing/tenant controls, hosted debate with real participants/model judging, dashboard, or TUI.
```

`PRODUCT.md` states the same Codex boundary: Claude is interactive, while Codex remains one-shot.

```md
- `claude_code.sdk`: local bounded interactive Claude Code runtime mode with post-start input, session-state patches, runtime approval bridging, normalized tool events, and dual transcript artifacts (daemon default path uses structured `claude -p` stream-json IO).
- `codex.exec_json`: local non-interactive Codex CLI execution through `codex exec --json`.
```

```md
R8 Codex boundary note:

- Codex remains one-shot `codex.exec_json`. Interactive mode promotion and resume/runtime-approval bridging are deferred.
```

The shared adapter contract already has `start`, `send`, `cancel`, `events`, and `artifacts`; R16 should use this contract instead of adding a terminal route.

`packages/core/src/ports/runtime-adapter.ts`:

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

The core runner already persists waiting states, accepts post-start input, applies bounded session-state patches, and creates approval records from runtime approval events. R16 must harden and generalize this, not fork a Codex-only control plane.

`packages/core/src/services/runtime-runner-service.ts`:

```ts
if (status === "waiting_for_input" || status === "waiting_for_approval") {
  const updated = await this.updateRunAndSessionStatus(runId, status, session);
  this.log("info", "runtime.status.waiting", { runId, status });
  return updated;
}
```

```ts
const rawPatch = event.payload["sessionStatePatch"];
if (rawPatch === undefined || rawPatch === null) {
  return { session };
}
if (!isPlainObject(rawPatch)) {
  this.log("warn", "runtime.session_state_rejected", { runId, reasonCode: "session_state_patch_rejected" });
  return { session, reasonCode: "session_state_patch_rejected" };
}
```

```ts
const token = event.payload["runtimeApprovalToken"];
if (typeof token !== "string" || token.trim().length === 0) {
  return { reasonCode: "runtime_approval_token_missing" };
}
if (!this.deps.runtimeApprovals) {
  return { reasonCode: "runtime_approval_bridge_unconfigured" };
}
```

`codex.exec_json` is explicitly one-shot and must stay that way.

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

```ts
limitations: [
  { code: "one_shot_no_input", message: "codex.exec_json does not support post-start input." },
  { code: "local_only", message: "This mode runs a local Codex CLI process and is not hosted-safe in R8." },
  { code: "no_approval_bridge", message: "Approval bridge integration is not shipped for codex.exec_json in R8." },
  { code: "no_session_resume", message: "Session resume remains deferred for codex.exec_json in R8." }
],
```

```ts
const processSession = this.processRunner.start({
  processFactory: this.processFactory,
  args,
  cwd,
  env: process.env,
  stdin: "close",
```

Existing tests confirm fake Codex process fixtures already provide no-spend coverage for one-shot Codex behavior. R16 should extend that style for interactive/session factories.

`packages/adapters/test/codex-exec-json-adapter.test.ts`:

```ts
fake.stdout.write("{\"type\":\"thread.started\",\"thread_id\":\"thread_1\"}\n");
fake.stdout.write("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}\n");
fake.stdout.write("{\"type\":\"turn.completed\"}\n");
```

Claude proves the current runtime approval bridge shape. R16 should extract the reusable contract from this behavior without making every runtime pretend it supports approval resolution.

`packages/adapters/src/claude-code/claude-code-adapter.ts`:

```ts
if (input["type"] === "approval_resolution") {
  const runtimeApprovalToken = input["runtimeApprovalToken"];
  if (typeof runtimeApprovalToken !== "string" || !stored.pendingRuntimeApprovalTokens.has(runtimeApprovalToken)) {
    throw new AdapterProtocolError("Runtime approval pause is not active.", {
      reasonCode: "runtime_approval_pause_not_active"
    });
  }
```

OpenCode, AgentField, and Generic HTTP currently reject post-start input or permission requests explicitly. R16 may add shared contracts for future bridge support, but must not advertise real bridge support for these runtimes unless wired and tested.

`packages/adapters/src/opencode/opencode-acp-adapter.ts`:

```ts
if (event.type === "permission_request") {
  const terminal = eventForFailure(runId, sequence++, "acp_permission_request_unsupported");
  stored.terminal = terminal;
  stored.promptActive = false;
```

`packages/adapters/src/generic-http/generic-http-adapter.ts`:

```ts
async send(_session: Record<string, unknown>, _input: Record<string, unknown>): Promise<void> {
  throw new AdapterProtocolError("Generic HTTP async REST does not support input after start", {
    reasonCode: "generic_http_input_unsupported"
  });
}
```

`packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts`:

```ts
async send(_session: Record<string, unknown>, _input: Record<string, unknown>): Promise<void> {
  throw new AdapterProtocolError("agentfield.async_rest does not support POST /runs/:id/input in R6.", {
    reasonCode: "agentfield_input_unsupported"
  });
}
```

Local no-spend Codex capability probes on this worktree show Codex CLI `0.134.0` has one-shot `exec --json`, `exec resume --json`, app-server tooling, and approval policy flags, but no verified public Switchyard-level approval bridge yet.

```text
codex-cli 0.134.0
```

```text
Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]

Arguments:
  [SESSION_ID]
          Conversation/session id (UUID) or thread name. UUIDs take precedence if it parses. If
          omitted, use --last to pick the most recent recorded session

Options:
      --json
          Print events to stdout as JSONL
```

```text
Commands:
  app-server      [experimental] Run the app server or related tooling
  remote-control  [experimental] Manage the app-server daemon with remote control enabled
  mcp-server      Start Codex as an MCP server (stdio)
  resume          Resume a previous interactive session (picker by default; use --last to continue
                  the most recent)
```

```text
      --ask-for-approval <APPROVAL_POLICY>
          Configure when the model requires human approval before executing a command

          Possible values:
          - untrusted
          - on-failure
          - on-request
          - never
```

The local Codex feature list shows approval-related internals are not a simple stable public Switchyard bridge. This means R16 must gate real Codex approval support behind a driver capability check and keep unsupported behavior explicit.

```text
exec_permission_approvals               under development  false
guardian_approval                       stable             true
tool_call_mcp_elicitation               stable             true
tui_app_server                          removed            true
```

## Architecture

R16 is a local runtime-adapter release, not a new execution surface. The public API remains `POST /runs`, `GET /runs/:id`, `GET /runs/:id/events`, `POST /runs/:id/input`, `POST /runs/:id/cancel`, and the existing approval routes. No route named `/pty`, `/terminal`, `/exec`, `/sandbox`, or equivalent may be added.

`codex.exec_json` remains the inferred Codex mode. Requests with `runtime: "codex"`, `provider: "openai"`, `adapterType: "process"`, and no `runtimeMode` must still infer `codex.exec_json`. `codex.interactive` must require an explicit `runtimeMode: "codex.interactive"` so existing callers never change behavior silently.

Because the runtime runner selects adapters by `run.runtime`, R16 should introduce a Codex router/multiplexer behind the existing `"codex"` adapter key rather than replacing `CodexExecJsonAdapter` behavior. The router dispatches:

- `runtimeMode` absent or `codex.exec_json` -> existing `CodexExecJsonAdapter`.
- `runtimeMode: "codex.interactive"` -> new bounded Codex interactive session adapter.
- Any other Codex runtime mode -> `AdapterProtocolError` with reason `codex_runtime_mode_unsupported`.

The daemon registry should seed both Codex mode manifests:

| Mode | Runtime | Provider | Adapter type | Kind | Default selection | Minimum truthful capability |
|---|---|---|---|---|---|---|
| `codex.exec_json` | `codex` | `openai` | `process` | `one_shot_process` | inferred default | one-shot `run.start`, `run.cancel`, `run.timeout`, normalized events, transcript |
| `codex.interactive` | `codex` | `openai` | `process` | `interactive_process` | explicit only | local `run.input`, `session.state`, `session.resume` only when the active driver proves support |

The `codex.interactive` implementation should be built around a small `CodexInteractiveSessionFactory` port with fake and real implementations. The fake implementation is required for tests and smoke. The real implementation is allowed only for local use and must prove its support through no-spend checks:

- The Codex binary is PATH-reachable.
- `codex --version` returns a version string.
- `codex exec --help` exposes `--json`.
- `codex exec resume --help` exposes `--json` and accepts a session id/thread name argument.
- If an app-server/control-protocol driver is used, its generated schema or runtime handshake must expose named session start, user input, approval request, approval resolution, terminal, and cancel messages before `approval.bridge` is advertised.
- If only `codex exec resume --json` is wired, R16 may advertise `run.input`, `session.state`, and `session.resume`, but must not advertise real `approval.bridge`.

The interactive adapter must treat every Codex turn as a bounded stream. It may start one subprocess/session per turn, but every turn must have:

- no shell interpolation;
- bounded timeout;
- bounded stdout/stderr bytes;
- bounded transcript bytes;
- explicit stdin behavior;
- normalized terminal or waiting event;
- session id/thread id extraction before any resume is attempted;
- redacted logs and artifacts.

The Codex interactive runtime should use existing Switchyard statuses:

- `running` when a turn is actively streaming;
- `waiting_for_input` when the adapter has a resumable session and is ready for `POST /runs/:id/input`;
- `waiting_for_approval` when the runtime emitted an approval request and the bridge is active;
- terminal status only when the run completes/fails/cancels/times out or a session cannot continue.

### Runtime Approval Bridge Contract

R16 should define one shared contract that adapters can implement without forcing every runtime to support it immediately.

Runtime approval request events:

```json
{
  "type": "approval.requested",
  "payload": {
    "runtimeApprovalToken": "opaque-runtime-token",
    "approvalType": "before_destructive_command",
    "runtimeMode": "codex.interactive",
    "bridge": "codex",
    "summary": "Codex wants permission to run a command",
    "toolName": "shell",
    "toolInput": { "command": "redacted-or-bounded" },
    "expiresAt": "2026-05-30T12:34:56.000Z"
  }
}
```

Approval records created from runtime events must store:

- `runId`;
- `approvalType`;
- `status: "pending"`;
- redacted `payload.runtimeApprovalToken`;
- `payload.runtimeMode`;
- `payload.runtimeSessionId`;
- `payload.externalSessionKey` when present;
- optional `payload.expiresAt`;
- bounded summary/tool/request details.

Approval resolution sends the existing `approval_resolution` payload through `RunService.sendInput` into the active adapter:

```json
{
  "type": "approval_resolution",
  "approvalId": "approval_...",
  "runId": "run_...",
  "runtimeApprovalToken": "opaque-runtime-token",
  "decision": "approved",
  "message": "approved by local-user"
}
```

Denied approvals use `decision: "rejected"` and must resume or fail the runtime through the same adapter-specific resolution path. An unsupported runtime bridge must not leave the run pending forever.

### Session Resume Contract

Codex session state patches must use bounded, non-secret keys. The expected patch shape is:

```json
{
  "status": "running",
  "sessionStatePatch": {
    "codexThreadId": "thread_1",
    "codexResumeMode": "exec_resume_json"
  }
}
```

The runner already treats `codexThreadId` as a candidate `externalSessionKey`; R16 should keep that behavior and add tests that prove a Codex interactive run can resume from the stored key. The adapter must reject resume attempts when the key is missing, blank, malformed for the selected driver, stale, or points at a terminal/unknown session.

### Shared Contract For OpenCode, AgentField, And Generic HTTP

R16 may add shared types/helpers/tests for future approval bridges across `opencode.acp`, `agentfield.async_rest`, and `generic_http.async_rest`, but real runtime support remains unshipped unless each adapter is wired and tested. Current behavior must stay truthful:

- `opencode.acp` permission requests continue to fail visibly unless the ACP approval bridge is fully wired.
- `agentfield.async_rest` continues to reject post-start input and cancellation where unsupported.
- `generic_http.async_rest` continues to reject post-start input unless its wrapper API contract is explicitly extended.
- Hosted approval/input bridges remain unsupported for all real hosted modes in R16.

## User-Visible Behavior

- A caller creates a normal Codex run without `runtimeMode`. Switchyard infers `codex.exec_json`; the run behaves exactly as before. `POST /runs/:id/input` returns `409 adapter_protocol_failed` with reason `codex_input_unsupported`.
- A caller creates a local explicit `codex.interactive` run. If the local Codex interactive driver check passes, the run starts, streams normalized Codex output, stores a Codex thread/session key, and transitions to `waiting_for_input` after the turn is ready for more input.
- A caller posts `{"text":"continue with the previous answer"}` to a `waiting_for_input` `codex.interactive` run. Switchyard validates the body, sends it to the active Codex interactive adapter, resumes the stored Codex session, streams normalized output, and returns to `waiting_for_input` or a terminal state.
- A caller posts no body, a non-object body, missing `text`, blank `text`, or text over 64 KiB to `/runs/:id/input`. Switchyard rejects before adapter dispatch with `400 invalid_input` and a path-specific detail.
- A caller posts input after a run is terminal. Switchyard returns `409 adapter_protocol_failed` with reason `runtime_input_not_active`.
- A Codex interactive runtime emits an approval request and the bridge is supported. Switchyard persists an approval, emits `approval.requested`, moves the run/session to `waiting_for_approval`, and waits for `POST /approvals/:id/approve` or `POST /approvals/:id/reject`.
- The user approves an active runtime approval. Switchyard stores `approved`, emits `approval.approved`, sends an `approval_resolution` payload to the active adapter, and the run returns to `running` or a terminal state.
- The user rejects an active runtime approval. Switchyard stores `rejected`, emits `approval.rejected`, sends a rejected `approval_resolution`, and the runtime either continues with denial context or fails with a named provider denial reason.
- An approval expires before resolution. Switchyard marks it `expired`, emits an approval event with `status: "expired"`, and sends a rejected/expired resolution when the runtime bridge can accept it; if the runtime session is gone, the run fails with `runtime_approval_expired` rather than staying in `waiting_for_approval`.
- Codex emits an approval request but the real bridge is unsupported. Switchyard fails the run with `codex_approval_bridge_unsupported` or `runtime_approval_bridge_unconfigured`, persists transcript artifacts, and docs/registry limitations make clear that live Codex approval bridging is not shipped for that driver.
- A resume token is missing from Codex output. The run fails with `codex_resume_token_missing` before it can enter `waiting_for_input`.
- A resume token is stale or rejected by local Codex. The run fails with `codex_resume_session_stale` and persists a bounded transcript with redacted stderr/diagnostics.
- A hosted real runtime run receives `/runs/:id/input` or a runtime approval pause. Switchyard returns/fails with `hosted_input_unsupported` or `hosted_approval_bridge_unsupported`; it must not proxy input from server to worker in R16.

## Data Flows And Shadow Paths

### Flow 1: Create `codex.interactive` Run

- Happy path: Valid local run with explicit `runtimeMode: "codex.interactive"` starts the Codex interactive driver, stores a runtime session, streams normalized events, captures bounded artifacts, and reaches `waiting_for_input` or terminal.
- Nil path: Missing `runtimeMode` uses `codex.exec_json`; no interactive behavior is silently selected.
- Empty path: Empty `task`, `cwd`, `model`, `runtime`, or `provider` is rejected by existing create-run validation before adapter dispatch.
- Error path: Missing Codex binary, unsupported local driver, unsupported resume capability, bad JSONL, process timeout, or unsupported approval bridge fails the run with a named reason and emits a terminal event.

### Flow 2: Post-Start Input

- Happy path: Non-empty `text` under 64 KiB for an active `codex.interactive` session is accepted, sent to the adapter, and produces new normalized events.
- Nil path: Missing request body or missing `text` returns `400 invalid_input`; adapter is not called.
- Empty path: Blank or whitespace-only `text` returns `400 invalid_input`; adapter is not called.
- Error path: Terminal run, missing runtime session, stale Codex session, unsupported hosted bridge, oversized text, or adapter rejection maps to `409 adapter_protocol_failed` or `400 invalid_input` with the exact reason code.

### Flow 3: Approval Bridge

- Happy path: Runtime emits a request with `runtimeApprovalToken`; Switchyard persists a pending approval, transitions to `waiting_for_approval`, accepts approve/reject once, sends resolution to the runtime, and resumes/fails visibly.
- Nil path: Missing approval token fails the run with `runtime_approval_token_missing`.
- Empty path: Blank token fails the run with `runtime_approval_token_missing`; blank approval reason is allowed but replaced with the existing default message.
- Error path: Unsupported bridge, invalid approval type, expired approval, duplicate resolution, stale session, terminal run, or adapter resolution failure returns/stores a named error. No approval remains silently pending without a run state that explains why.

### Flow 4: Session State And Resume

- Happy path: Runtime emits a plain-object `sessionStatePatch` with `codexThreadId`; Switchyard stores it, sets `externalSessionKey` when absent, and later passes it to the adapter for resume.
- Nil path: Missing patch is ignored without changing session state.
- Empty path: Empty patch is ignored without failure.
- Error path: Non-object patch, secret-key patch, function/symbol value, patch over 16 KiB, missing resume token before waiting, or stale resume token fails or rejects with `session_state_patch_rejected`, `session_state_patch_too_large`, `codex_resume_token_missing`, or `codex_resume_session_stale`.

### Flow 5: Transcripts And Artifacts

- Happy path: Raw and normalized Codex interactive transcripts are persisted with runtime/mode metadata, redaction markers, byte counts, and truncation markers when bounded.
- Nil path: Adapter with no artifact content still emits a metadata-only transcript artifact or a named `artifact.created` absence reason in logs; the run does not crash after terminal state.
- Empty path: Empty transcript content is stored as an empty bounded artifact with metadata that explains `emptyTranscript: true`.
- Error path: Artifact path escape, content-store failure, oversized transcript, or redaction failure produces a named failure and never logs raw secrets.

## Failure Modes And Reason Codes

R16 implementation and docs must use stable reason codes for these cases:

| Case | Reason code | User/API behavior |
|---|---|---|
| Codex one-shot receives input | `codex_input_unsupported` | `409 adapter_protocol_failed`; existing behavior preserved |
| Interactive mode requested but local driver unsupported | `codex_interactive_driver_unsupported` | mode check unavailable/partial; run fails before waiting |
| Missing resume token/session id | `codex_resume_token_missing` | run fails; no `waiting_for_input` |
| Resume token rejected/stale | `codex_resume_session_stale` | run fails; bounded transcript preserved |
| Runtime approval token missing | `runtime_approval_token_missing` | run fails |
| Approval type invalid | `runtime_approval_type_invalid` | run fails |
| Runtime approval bridge not configured | `runtime_approval_bridge_unconfigured` | run fails |
| Codex approval bridge unsupported by selected driver | `codex_approval_bridge_unsupported` | run fails; registry/docs state limitation |
| Approval expired before resolution | `runtime_approval_expired` | approval becomes expired; run resumes with rejection or fails visibly |
| Approval resolved twice | `approval_not_pending` | second resolution returns `409` |
| Approval resolution after terminal run | `runtime_approval_pause_not_active` | `409 adapter_protocol_failed` |
| Post-start input after terminal run | `runtime_input_not_active` | `409 adapter_protocol_failed` |
| Hosted post-start input attempted | `hosted_input_unsupported` | `409 adapter_protocol_failed` |
| Hosted runtime approval bridge attempted | `hosted_approval_bridge_unsupported` | terminal failure or `409`, never pending forever |
| Session-state patch rejected | `session_state_patch_rejected` | run fails through existing runner behavior |
| Session-state patch too large | `session_state_patch_too_large` | run fails through existing runner behavior |
| Transcript too large | `codex_transcript_truncated` | artifact contains truncation marker and metadata |
| Secret-like field in logs/artifacts | `secret_redaction_required` | test failure; implementation must redact before persist/log |

## Constraints

- Required tests and smoke must be deterministic and no-spend.
- Required checks must not send live Codex prompts.
- The local real Codex driver must be opt-in by capability detection; unsupported local capabilities must produce unavailable/partial doctor status, not a false `available`.
- `codex.interactive` must be local-only in R16.
- Hosted post-start input and hosted runtime approvals are explicitly unsupported.
- All public input bodies stay bounded by existing 64 KiB route/core limits unless a stricter adapter limit is needed.
- Session-state patches stay bounded by the existing 16 KiB runner limit and secret-key rejection pattern.
- Codex interactive transcript artifacts must be capped at 1 MiB each for raw and normalized transcript content, with deterministic truncation markers.
- Logs must not contain raw prompts, raw post-start input, raw tool input, auth tokens, bearer tokens, object keys, environment variables, or unbounded stdout/stderr.
- No shell interpolation for Codex subprocesses.
- No public PTY/TUI route and no public arbitrary shell/tool execution.
- Existing `POST /runs?wait=1` behavior must not wait forever on an intentionally interactive run. For `codex.interactive`, either reject `wait=1` with a named reason such as `interactive_wait_unsupported`, or return once the run reaches the first `waiting_for_input`/terminal state with a bounded response. The implementation must choose one behavior and test it.

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

## Required Tests And Smoke

Required tests must be no-spend and deterministic:

- Adapter tests for a fake `CodexInteractiveSessionFactory`:
  - start -> output -> `codexThreadId` patch -> `waiting_for_input`;
  - input -> resume -> output -> `waiting_for_input`;
  - terminal completion;
  - missing token;
  - stale token;
  - approval requested -> approved;
  - approval requested -> denied;
  - approval expired;
  - unsupported approval bridge;
  - transcript truncation;
  - secret redaction.
- Core runner tests:
  - session-state patch happy/nil/empty/error;
  - approval bridge happy/denied/expired/unsupported/missing token/terminal run;
  - no duplicate approval resolution side effects.
- REST tests:
  - `codex.exec_json` unsupported input remains `409`;
  - `codex.interactive` input validation covers body missing, text missing, empty, too large, terminal, active;
  - hosted real input remains `hosted_input_unsupported`;
  - approval approve/reject/expired/stale mapping returns stable envelopes.
- Daemon smoke:
  - fake Codex interactive mode can run without Codex binary or provider spend;
  - registry exposes `codex.exec_json` and conditionally exposes/checks `codex.interactive`;
  - docs/product truth smoke does not claim unsupported bridge support.
- Boundary tests:
  - no public `/sandbox`, `/exec`, `/pty`, `/terminal`;
  - no arbitrary shell/tool execution route;
  - no raw secret logging/artifact persistence for representative `apiKey`, `authorization`, `token`, `password`, and object-key values.

Suggested command set for the implementation phase:

```bash
pnpm --filter @switchyard/adapters test -- codex
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test -- smoke
pnpm --filter @switchyard/adapters test -- compatibility
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

## Operational Concerns

Operators should be able to diagnose Codex interactive availability through runtime-mode and doctor routes without spending model budget. Doctor output must distinguish:

- Codex binary missing;
- `exec --json` available but `exec resume --json` missing;
- app-server/control protocol present but unsupported for approval resolution;
- approval bridge unsupported;
- fake/no-spend harness available;
- live real driver disabled by default.

Startup recovery must treat `waiting_for_input` and `waiting_for_approval` runs as interrupted, as the daemon already does, and terminalize them with a visible `daemon_restarted` failure rather than pretending a local Codex process survived a restart.

Metrics/logs should continue to count `waiting_for_input` and `waiting_for_approval` run statuses. Add low-cardinality log events for `codex.interactive.start`, `codex.interactive.resume`, `codex.interactive.waiting_for_input`, `codex.interactive.approval_requested`, `codex.interactive.approval_resolved`, `codex.interactive.unsupported_bridge`, and `codex.interactive.stale_session`. These logs must use run/session ids and reason codes, not raw prompt text.

## Documentation/Product Truth

Implementation must update product and development docs to say:

- `codex.exec_json` is still one-shot and default.
- `codex.interactive` is a separate explicit local mode if and only if the adapter and local capability check are wired.
- Which `codex.interactive` capabilities shipped: post-start input, session state, session resume, approval bridge if wired.
- Which Codex capabilities remain unshipped: TUI/PTY automation, hosted interactive Codex, hosted input bridge, unsupported approval bridge paths, arbitrary shell/tool execution.
- OpenCode/AgentField/Generic HTTP approval bridges are contract-defined only unless their adapters are explicitly wired and tested.
- Dashboard and TUI are still out of scope.
- Managed production hosted platform, enterprise controls, arbitrary process/PTY, and real tools remain out of scope.

## Future Trajectory

R16 should leave clean seams for future runtime bridges without forcing premature support:

- OpenCode ACP permission requests can later map into the same approval bridge contract once ACP resolution is implemented and tested.
- AgentField and Generic HTTP wrappers can later opt into a wrapper-level approval contract with explicit endpoint shapes.
- Hosted input/approval bridges can later be added through server/worker/node messaging, but R16 must not begin that protocol.
- A true Codex app-server protocol adapter can replace or augment an `exec resume --json` driver if local Codex exposes a stable headless contract.
- Dashboard/TUI can later visualize `waiting_for_input` and `waiting_for_approval`, but R16 remains API/runtime-only.

## Phase

### Phase 15: R16 Interactive Codex And Approval Bridges

**Goal:** Add a truthful local Codex interactive/session-resume slice and shared approval bridge contract while preserving one-shot Codex and excluding hosted/UI/PTY/tool expansion.

**Acceptance:**

- `codex.exec_json` remains one-shot default behavior.
- `codex.interactive` is explicit-only, local-only, and no-spend testable with fake Codex session/process factories.
- Post-start input, waiting states, session-state patches, resume tokens, approval resolution, expiration, stale sessions, and unsupported bridges have named behavior and deterministic tests.
- Transcripts/artifacts are bounded and redacted.
- Hosted input/approval, dashboard, TUI, arbitrary PTY/generic process, real tools, enterprise controls, and managed production hosted platform remain unshipped and documented.

**Non-goals (this phase):** Hosted post-start input bridge; public PTY/TUI/terminal route; arbitrary process/shell/tool execution; OpenCode/AgentField/Generic HTTP real approval bridge support unless fully wired and tested; dashboard; TUI; managed production hosted platform.

**Complexity:** L
