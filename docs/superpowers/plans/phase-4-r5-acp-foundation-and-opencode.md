# Phase 4: R5 ACP Foundation And OpenCode - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md`
**Spec commit:** `887d8c024a6e5832f669c3dc236eacceab754ef5`
**Branch:** `agent/phase-4-r5-acp-foundation-and-opencode`
**Worktree:** `.worktrees/native-roadmap-20260529/phase-4-r5-acp-foundation-and-opencode`
**Plan target:** `docs/superpowers/plans/phase-4-r5-acp-foundation-and-opencode.md`
**Complexity:** L

## Goal

Ship R5 by adding Switchyard's reusable outbound ACP/acpx protocol foundation and proving it with a local `opencode.acp` runtime mode. After this phase, a local OpenCode ACP subprocess can be checked without sending prompts, started through the existing run API, streamed through normalized events, cancelled only after ACP cancellation is verified, and inspected through raw ACP transcript artifacts.

R5 remains a local stdio ACP release only. It does not add hosted node connectivity, debate orchestration, an inbound ACP server, streamable HTTP/WebSocket ACP transports, PTY, interactive Codex, SDK/CLI product surface, approval workflow expansion, tools, memory, or MCP management.

## Scope Challenge

- Existing code already owns the public run lifecycle through `RuntimeRunnerService`, `RuntimeAdapter`, REST run routes, runtime-mode registry records, runtime doctor checks, artifact content storage, and daemon seeding. R5 must reuse those boundaries and add ACP as one adapter family, not a parallel run engine.
- Minimum viable R5 is one new `@switchyard/protocol-acpx` package, a deterministic fake ACP runtime harness, one OpenCode adapter over the ACP client, one `opencode.acp` runtime-mode registry path, verified cancellation with transcript persistence, and docs. No approval bridge, no tools, no model selection, no session resume/load/fork/list, and no arbitrary per-run environment/config overrides.
- Complexity exceeds eight files at release level because R5 crosses a new package, testkit, adapters, core lifecycle/doctor behavior, daemon wiring, REST tests, and docs. Mitigation: each implementer owns disjoint files, each task is package-shaped, and no file is assigned to more than one task.
- Built-in check: use Node `child_process.spawn`, `readline`, `AbortController`, existing `withTimeout`, existing Zod schemas, existing stores, existing Fastify injection tests, and existing artifact content storage. Do not add a JSON-RPC framework, process manager, storage layer, queue, SDK generator, or extra HTTP framework.
- Distribution check: the only new workspace package is private `@switchyard/protocol-acpx`; there is no public binary or CLI product. The fake ACP CLI is a testkit script for deterministic tests, not a shipped user-facing command.

## Architecture

R5 keeps `RuntimeRunnerService` as the lifecycle owner. The new ACP package owns protocol mechanics only; adapters translate ACP outcomes into Switchyard events and artifacts.

```text
POST /runs
  -> RegistryService infers opencode.acp
  -> RuntimeRunnerService.start
  -> OpenCodeAcpAdapter
       -> @switchyard/protocol-acpx AcpStdioClient
       -> spawn configured command with fixed ["acp"], shell:false
       -> initialize
       -> session/new
       -> session/prompt
       -> session/update notifications
       -> prompt response stopReason
  -> normalized events
  -> transcript artifacts through existing artifact content store
```

Doctor flow:

```text
POST /runtime-modes/opencode.acp/check
  -> RuntimeDoctorService.checkRuntimeMode
  -> OpenCodeAcpAdapter.check
       -> <command> --version
       -> <command> acp
       -> initialize
       -> session/new
       -> close/kill process
       -> no session/prompt
  -> adapter-provided custom availability
  -> stored runtime-mode availability snapshot
```

Cancellation flow:

```text
POST /runs/:id/cancel
  -> RuntimeRunnerService.cancel
  -> OpenCodeAcpAdapter.cancel
       -> session/cancel notification
       -> wait for prompt response stopReason:"cancelled"
       -> fail with AdapterProtocolError(acp_cancel_unverified) if not verified
  -> mark run/session cancelled only after adapter returns
  -> persist opencode-acp-transcript.jsonl with allow-cancelled artifact persistence
```

Permission request flow:

```text
ACP agent request session/request_permission
  -> protocol client sends JSON-RPC error -32601 with same id
  -> OpenCode adapter yields run.failed error acp_permission_request_unsupported
  -> adapter best-effort cancels active prompt
  -> no Switchyard approval request is created in R5
```

Transcript confidentiality rule:

```text
ACP stdout/stderr
  -> redact and bound first
  -> transcript JSONL raw/text fields store only redacted transport payloads
  -> artifact content store never receives pre-redaction secrets, env dumps, or unbounded JSON-RPC
```

## Existing R4 Anchors

- `packages/core/src/ports/runtime-adapter.ts` is the adapter lifecycle boundary and already supports `adapterType: "acpx"` through contracts.
- `packages/contracts/src/registry.ts` already includes `kind: "acp"` and `artifact.raw_transcript`; R5 should not add new capabilities unless a test proves the manifest cannot parse.
- `packages/core/src/services/registry-service.ts` already infers fake, Codex, and Generic HTTP modes; R5 adds only `runtime: "opencode"` plus `adapterType: "acpx"` -> `opencode.acp`.
- `packages/core/src/services/runtime-doctor-service.ts` already consumes adapter-provided availability for Generic HTTP details; R5 generalizes that path for `check.strategy: "custom"` and `opencode.acp`.
- `packages/core/src/services/runtime-runner-service.ts` already terminalizes adapter-emitted `run.cancelled` and persists artifacts after terminal adapter events; R5 closes the public-cancel transcript gap.
- `packages/adapters/src/generic-http/generic-http-adapter.ts` is the manifest, bounded check, verified cancel, transcript, and unsupported-input pattern for OpenCode to follow.
- `packages/testkit/src/runtime-adapter-contract-harness.ts` is the shared adapter contract surface that must cover OpenCode ACP with a fake process.
- `apps/daemon/src/app.ts` seeds providers, runtimes, models, runtime-mode manifests, active doctor services, adapters, and local artifact content storage.

## Task Graph

### Task P4-T1-protocol-acpx-framing-schemas-transcripts

`id`: `P4-T1-protocol-acpx-framing-schemas-transcripts`
`title`: Add protocol-acpx package framing, schemas, errors, and transcript helpers

`files`:
- Create: `packages/protocol-acpx/package.json`
- Create: `packages/protocol-acpx/tsconfig.json`
- Create: `packages/protocol-acpx/src/json-rpc.ts`
- Create: `packages/protocol-acpx/src/acp-schemas.ts`
- Create: `packages/protocol-acpx/src/acp-transcript.ts`
- Create: `packages/protocol-acpx/test/protocol-framing.test.ts`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md` - exact ACP framing, schema, transcript, and named-error requirements.
- `pnpm-workspace.yaml` - confirms `packages/*` workspaces already include the new package path.
- `packages/contracts/src/registry.ts` - existing runtime capabilities and `artifact.raw_transcript` vocabulary.
- `packages/adapters/src/substrates/transcript-recorder.ts` - R4 transcript handoff pattern and metadata-content convention.
- `packages/contracts/src/artifact.ts` - artifact type schema and transcript type.

`instructions`: Create private workspace package `@switchyard/protocol-acpx` with `build`, `typecheck`, `test`, and `lint` scripts consistent with the existing packages. Implement newline-delimited JSON-RPC 2.0 helpers and package-local named protocol errors without importing `@switchyard/core`. JSON-RPC parsing must enforce `jsonrpc: "2.0"`, request/notification/response shapes, exactly one of `result` or `error`, no embedded newlines on writes, malformed JSON as `acp_invalid_json`, invalid envelopes as `acp_invalid_message`, and JSON-RPC error responses as `AcpResponseError` with sanitized code/message/data. Implement minimal ACP Zod schemas for initialize, `session/new`, `session/prompt`, `session/cancel`, `session/update`, and agent-to-client requests, permissive where the spec allows future ACP shape. Implement raw ACP transcript helpers that write JSONL entries for inbound/outbound ACP messages and stderr with timestamp, direction, id, method, byte length, redacted raw line, redaction metadata, and oversized-marker support. The `raw` field means "redacted raw JSON-RPC line"; it must never store the pre-redaction line if it contained tokens, env-like secrets, configured token-like command path segments, or other redactable material. Do not implement process spawning, in-flight request correlation, or OpenCode-specific behavior in this task; duplicate in-flight ids and unknown response ids are owned by T2's stdio client.

`acceptance`:
- `@switchyard/protocol-acpx` exists as a private package and local tests import its source files.
- JSON-RPC helpers parse valid requests, notifications, success responses, and error responses.
- JSON-RPC helpers reject malformed JSON, invalid envelopes, embedded-newline outbound payloads, missing ids on responses, both `result` and `error`, and oversized raw lines with the spec's named reason codes.
- ACP schemas parse the R5 initialize, `session/new`, `session/prompt`, `session/cancel`, known `session/update`, unknown `session/update`, and `session/request_permission` shapes.
- Transcript helpers emit newline-delimited entries with `type: "acp.message"` or `type: "acp.stderr"`, direction, id/method when present, byte length, timestamp, and redacted raw/text.
- Transcript redaction covers `Authorization`, `Bearer ...`, env-like keys ending in `_TOKEN`, `_KEY`, `_SECRET`, and token-like command path segments without storing environment dumps.
- Transcript `raw` stores redacted raw JSON-RPC only; tests must prove pre-redaction secret values are absent from in-memory transcript content and from the returned artifact metadata content string.
- No OpenCode adapter, daemon wiring, approval bridge, or inbound ACP server appears in this package.

`checks`:
- `pnpm --filter @switchyard/protocol-acpx test -- protocol-framing`
- `pnpm --filter @switchyard/protocol-acpx typecheck`
- `pnpm --filter @switchyard/protocol-acpx lint`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `parseJsonRpcLine` | Malformed stdout line crashes with generic JSON error | `SyntaxError` | Catch parse errors and throw `AcpProtocolError` reason `acp_invalid_json` | Run fails with a named ACP parse reason instead of a 500 |
| `validateJsonRpcMessage` | ACP response with bad envelope is accepted | Invalid or ambiguous message shape | Strictly enforce JSON-RPC 2.0 response/request rules in one helper | Invalid protocol output fails visibly |
| `AcpResponseError` | JSON-RPC errors leak arbitrary data | Error data includes secrets or huge payload | Sanitize and bound message/data before exposing | REST/events show a safe reason |
| `AcpTranscriptRecorder.appendMessage` | Transcript stores tokens or env values | Raw JSON contains Authorization/Bearer/env-like keys | Redact in raw transcript helper before storing content | Artifact remains useful without leaking secrets |
| `AcpTranscriptRecorder.appendOversized` | Oversized line is omitted with no clue | Line exceeds max bytes | Write metadata marker with `reasonCode: "acp_message_too_large"` and byte count | Artifact explains why the run failed |

`observability`:
- `logs`: No runtime logs are added in this task; transcript helpers expose sanitized metadata for adapters to log later.
- `success_metric`: Protocol framing tests prove valid ACP messages parse and transcript JSONL lines are bounded/redacted.
- `failure_metric`: Any invalid JSON-RPC envelope, redaction miss, or oversized marker omission fails package tests.

`test_cases`:
- `{ name: "valid json-rpc shapes parse", lens: "happy", given: "request, notification, success response, and error response lines", expect: "typed parsed messages with jsonrpc 2.0" }`
- `{ name: "blank line ignored by caller contract", lens: "happy_shadow_empty", given: "empty stdout line", expect: "documented as ignored and not recorded as acp.message" }`
- `{ name: "malformed json rejects", lens: "error_path", given: "stdout line '{bad'", expect: "AcpProtocolError reason acp_invalid_json" }`
- `{ name: "invalid envelope rejects", lens: "error_path", given: "response with result and error", expect: "AcpProtocolError reason acp_invalid_message" }`
- `{ name: "response error sanitizes data", lens: "error_path", given: "JSON-RPC error containing Authorization and API_TOKEN", expect: "AcpResponseError data/message redacted" }`
- `{ name: "transcript redacts bearer token", lens: "edge_redaction", given: "raw message with Bearer secret", expect: "transcript raw contains Bearer [REDACTED]" }`
- `{ name: "transcript raw never stores pre-redaction secret", lens: "edge_redaction", given: "raw JSON-RPC with Authorization, API_TOKEN, and safe fields", expect: "content() includes safe fields and redacted placeholders but not the original secret substrings" }`
- `{ name: "oversized transcript marker", lens: "edge_oversized", given: "line over max bytes", expect: "metadata line with reasonCode acp_message_too_large" }`
- `{ name: "permission request schema", lens: "integration", given: "agent-to-client session/request_permission request", expect: "method and id are parseable for unsupported-method response" }`

`integration_contracts`:
- `exports`:
  - `{ name: "AcpProtocolError", kind: "class", signature: "new AcpProtocolError(reasonCode: string, message: string, details?: Record<string, unknown>)" }`
  - `{ name: "AcpResponseError", kind: "class", signature: "new AcpResponseError(input: { code: number | string; message: string; data?: unknown })" }`
  - `{ name: "parseJsonRpcLine", kind: "function", signature: "(line: string, options?: { maxBytes?: number }) => JsonRpcMessage" }`
  - `{ name: "serializeJsonRpcMessage", kind: "function", signature: "(message: JsonRpcMessage, options?: { maxBytes?: number }) => string" }`
  - `{ name: "acpInitializeResultSchema", kind: "constant", signature: "z.ZodType for minimal ACP initialize result" }`
  - `{ name: "acpSessionNewResultSchema", kind: "constant", signature: "z.ZodType for minimal ACP session/new result" }`
  - `{ name: "acpSessionUpdateNotificationSchema", kind: "constant", signature: "z.ZodType for R5 session/update notification handling" }`
  - `{ name: "AcpTranscriptRecorder", kind: "class", signature: "appendMessage(direction, rawLine, parsed?), appendStderr(text), appendOversized(direction, byteLength), content(), metadata(input)" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/protocol-acpx/src/json-rpc.ts`
  - `packages/protocol-acpx/src/acp-schemas.ts`
  - `packages/protocol-acpx/src/acp-transcript.ts`

### Task P4-T2-protocol-acpx-stdio-client-and-workspace-deps

`id`: `P4-T2-protocol-acpx-stdio-client-and-workspace-deps`
`title`: Add outbound ACP stdio client and workspace dependency wiring

`files`:
- Create: `packages/protocol-acpx/src/index.ts`
- Create: `packages/protocol-acpx/src/acp-stdio-client.ts`
- Create: `packages/protocol-acpx/test/acp-stdio-client.test.ts`
- Modify: `packages/adapters/package.json`
- Modify: `packages/testkit/package.json`
- Modify: `pnpm-lock.yaml`

`dependencies`: [`P4-T1-protocol-acpx-framing-schemas-transcripts`]

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md` - outbound ACP client startup, prompt, cancel, timeout, stderr, and permission request behavior.
- `packages/adapters/src/substrates/process-runner.ts` - existing process-backed adapter runner shape, lifecycle hooks, and idempotent kill pattern.
- `packages/adapters/src/substrates/async-line-queue.ts` - existing async line queue pattern for process-backed adapters.
- `packages/adapters/src/substrates/transcript-recorder.ts` - R4 transcript capture and artifact handoff convention.
- `packages/core/src/services/runtime-timeout.ts` - existing timeout helper behavior to mirror without importing core.
- `packages/adapters/package.json` - existing adapter package dependency/script style.
- `packages/testkit/package.json` - existing testkit package dependency/script style.

`instructions`: Implement `AcpStdioClient` as a reusable process-backed stdio ACP client with no OpenCode assumptions and no `@switchyard/core` dependency. It must spawn the configured command with fixed args provided by the adapter, `shell: false`, and explicit `cwd`; start stdout, stderr, response correlation, and transcript recording before the first request; send requests/notifications; enforce request and cancel timeouts; reject oversized stdout/stderr; reject duplicate ids; reject unknown response ids; reject transport close with in-flight requests; expose notifications to adapters through an async iterator or callback; respond to unsupported agent-to-client requests with JSON-RPC error `-32601` using the same id; and close/kill idempotently. Correlation keys must preserve JSON-RPC id type so numeric `1` and string `"1"` are distinct in-flight ids. Add a package barrel exporting the T1 and T2 public API, including explicit re-exports for T1 helpers used by testkit (`parseJsonRpcLine`, `serializeJsonRpcMessage`, `AcpProtocolError`, `AcpResponseError`, and `AcpTranscriptRecorder`) with the exact T1 signatures below. Add workspace dependencies from adapters and testkit to `@switchyard/protocol-acpx`, add the testkit fake ACP script entry, and update `pnpm-lock.yaml`. Do not add daemon config or OpenCode adapter code in this task.

`acceptance`:
- `@switchyard/protocol-acpx` exports JSON-RPC helpers, ACP schemas, transcript helpers, `AcpStdioClient`, client option types, and named errors from `src/index.ts`.
- Client request/response correlation resolves matching responses and rejects unknown response ids, duplicate in-flight ids, request timeout, transport close, malformed JSON, invalid envelopes, response errors, and oversized stdout/stderr with named ACP reason codes.
- Client correlation supports two or more concurrent in-flight requests whose responses arrive out of order; interleaved `session/update` notifications and `session/request_permission` requests are routed as client events and do not consume either response.
- Client correlation does not conflate numeric JSON-RPC ids with string ids that render similarly, such as `1` and `"1"`.
- Client records every outbound request/notification, inbound response/notification/request, stderr diagnostic, and oversized marker in the transcript.
- Client ignores blank stdout lines and does not record them as ACP messages.
- Client has a test-only process factory so adapters and testkit can run fake ACP processes without real OpenCode.
- Unsupported agent-to-client methods receive JSON-RPC error `-32601`; `session/request_permission` is surfaced distinctly so the OpenCode adapter can fail the run with `acp_permission_request_unsupported`.
- `packages/adapters` and `packages/testkit` declare workspace dependency on `@switchyard/protocol-acpx`; no root scripts or public binaries are added.

`checks`:
- `pnpm --filter @switchyard/protocol-acpx test`
- `pnpm --filter @switchyard/protocol-acpx typecheck`
- `pnpm --filter @switchyard/adapters typecheck`
- `pnpm --filter @switchyard/testkit typecheck`
- `git diff --check`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `AcpStdioClient.start` | Request sent before readers/transcript are active | Lost initialize response or missing transcript first line | Attach stdout/stderr handlers and transcript before first write | Doctor/run failures include complete protocol transcript |
| `AcpStdioClient.request` | Hung request never settles | ACP process never responds | Race pending request with timeout and reject `acp_request_timeout` | Run/check fails instead of hanging |
| stdout reader | Process closes with pending requests | EOF before response | Reject all pending requests with `acp_transport_closed` | Run fails with transport-close reason |
| stdout reader | Agent emits oversized message | Line exceeds max bytes | Append oversized marker, reject `acp_message_too_large`, close client | Run fails and artifact records why |
| response correlation | Out-of-order response resolves the wrong request | Two pending ids receive responses in reverse order with notifications between them | Key pending requests by typed id and dispatch notifications/agent requests outside response resolution | Each adapter operation sees its own response |
| response correlation | Numeric and string ids collide | Pending ids `1` and `"1"` coexist | Include id type in the correlation key | Protocol mismatch is caught instead of misrouting a response |
| `registerPendingRequest` | Duplicate in-flight request id corrupts correlation | Same id registered twice | Throw `acp_duplicate_request_id` before write | Adapter fails before sending ambiguous protocol state |
| `resolveResponseId` | Unknown response id is ignored silently | Response id has no pending request | Throw/record `acp_unknown_response_id` | Transcript and run failure identify protocol mismatch |
| stderr capture | Local warning becomes fatal | OpenCode writes benign stderr while stdout succeeds | Record bounded stderr diagnostics without failing by itself | Doctor can return partial warning instead of unavailable |
| client request handler | Permission request blocks prompt forever | `session/request_permission` waits for approval | Respond `-32601`, surface permission request event/error to adapter | Run fails visibly; no approval UI is implied |
| `close`/`kill` | Double cleanup throws | Cancel plus timeout both try to kill | Make process close/kill idempotent | Cancellation and timeout cleanup are stable |

`observability`:
- `logs`: Client exposes structured lifecycle hooks for adapter logs: method, id, process id, reason code, byte counts, and stderr snippet. It does not log full raw JSON-RPC payloads.
- `success_metric`: Protocol package tests cover all client correlation, timeout, close, stderr, oversized, and unsupported-client-method paths.
- `failure_metric`: Any unresolved pending request, missing transcript entry, or unbounded stderr capture fails tests.

`test_cases`:
- `{ name: "initialize request resolves", lens: "happy", given: "fake process returns response id 0", expect: "request promise resolves and transcript has out/in entries" }`
- `{ name: "out-of-order concurrent correlation", lens: "integration", given: "two in-flight requests ids 0 and 1; fake emits session/update notification, session/request_permission request id req-1, response id 1, then response id 0", expect: "second request resolves with response id 1, first request resolves with response id 0, notification and permission request are yielded as events, and neither response is consumed by those events" }`
- `{ name: "numeric and string ids are distinct", lens: "edge_correlation", given: "pending request id 1 and pending request id \"1\"", expect: "responses resolve their matching typed ids and duplicate-id detection does not conflate them" }`
- `{ name: "notification has no response", lens: "happy_shadow_nil", given: "session/cancel notification", expect: "client writes message without registering pending request" }`
- `{ name: "blank stdout ignored", lens: "happy_shadow_empty", given: "fake process writes blank line then valid response", expect: "blank line not recorded, response resolves" }`
- `{ name: "request timeout rejects", lens: "error_path", given: "fake process never responds", expect: "AcpProtocolError reason acp_request_timeout" }`
- `{ name: "transport close rejects pending", lens: "error_path", given: "fake process exits before response", expect: "AcpProtocolError reason acp_transport_closed" }`
- `{ name: "unknown response id fails", lens: "error_path", given: "response id 99 without pending request", expect: "reason acp_unknown_response_id" }`
- `{ name: "duplicate id fails", lens: "error_path", given: "two requests with same explicit id", expect: "reason acp_duplicate_request_id" }`
- `{ name: "permission request gets -32601", lens: "integration", given: "agent sends session/request_permission request", expect: "client writes JSON-RPC error response and surfaces unsupported permission event" }`
- `{ name: "stderr warning captured", lens: "edge_stderr", given: "stderr text while response succeeds", expect: "transcript has acp.stderr and request still resolves" }`
- `{ name: "oversized stderr fails", lens: "edge_oversized", given: "stderr chunk over max bytes", expect: "reason acp_message_too_large and transcript marker" }`

`integration_contracts`:
- `exports`:
  - `{ name: "AcpProtocolError", kind: "class", signature: "new AcpProtocolError(reasonCode: string, message: string, details?: Record<string, unknown>)" }`
  - `{ name: "AcpResponseError", kind: "class", signature: "new AcpResponseError(input: { code: number | string; message: string; data?: unknown })" }`
  - `{ name: "parseJsonRpcLine", kind: "function", signature: "(line: string, options?: { maxBytes?: number }) => JsonRpcMessage" }`
  - `{ name: "serializeJsonRpcMessage", kind: "function", signature: "(message: JsonRpcMessage, options?: { maxBytes?: number }) => string" }`
  - `{ name: "AcpTranscriptRecorder", kind: "class", signature: "appendMessage(direction, rawLine, parsed?), appendStderr(text), appendOversized(direction, byteLength), content(), metadata(input)" }`
  - `{ name: "AcpStdioClient", kind: "class", signature: "constructor(options: AcpStdioClientOptions); start(): Promise<void>; request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>; notify(method: string, params?: unknown): Promise<void>; notifications(): AsyncIterable<AcpNotification>; close(): Promise<void>; kill(): void; transcript(): AcpTranscriptRecorder" }`
  - `{ name: "createAcpStdioClient", kind: "function", signature: "(options: AcpStdioClientOptions) => AcpStdioClient" }`
  - `{ name: "AcpClientEvent", kind: "type", signature: "union for notification, unsupported_request, permission_request, stderr, close, error" }`
- `imports_from_other_tasks`:
  - `{ from_task: "P4-T1-protocol-acpx-framing-schemas-transcripts", name: "parseJsonRpcLine", signature: "(line: string, options?: { maxBytes?: number }) => JsonRpcMessage" }`
  - `{ from_task: "P4-T1-protocol-acpx-framing-schemas-transcripts", name: "serializeJsonRpcMessage", signature: "(message: JsonRpcMessage, options?: { maxBytes?: number }) => string" }`
  - `{ from_task: "P4-T1-protocol-acpx-framing-schemas-transcripts", name: "AcpProtocolError", signature: "new AcpProtocolError(reasonCode: string, message: string, details?: Record<string, unknown>)" }`
  - `{ from_task: "P4-T1-protocol-acpx-framing-schemas-transcripts", name: "AcpResponseError", signature: "new AcpResponseError(input: { code: number | string; message: string; data?: unknown })" }`
  - `{ from_task: "P4-T1-protocol-acpx-framing-schemas-transcripts", name: "AcpTranscriptRecorder", signature: "appendMessage(direction, rawLine, parsed?), appendStderr(text), appendOversized(direction, byteLength), content(), metadata(input)" }`
- `file_paths_consumed_by_other_tasks`:
  - `packages/protocol-acpx/src/index.ts`
  - `packages/protocol-acpx/src/acp-stdio-client.ts`
  - `packages/adapters/package.json`
  - `packages/testkit/package.json`

### Task P4-T3-fake-acp-runtime-and-contract-harness

`id`: `P4-T3-fake-acp-runtime-and-contract-harness`
`title`: Add deterministic fake ACP runtime and contract-harness fixtures

`files`:
- Create: `packages/testkit/src/fake-acp-runtime-cli.ts`
- Create: `packages/testkit/src/fake-acp-runtime.ts`
- Modify: `packages/testkit/src/index.ts`
- Create: `packages/testkit/test/fake-acp-runtime.test.ts`

`dependencies`: [`P4-T2-protocol-acpx-stdio-client-and-workspace-deps`]

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md` - required fake ACP scenarios and contract coverage.
- `packages/testkit/src/fake-http-runtime-server.ts` - R4 deterministic fake runtime pattern and scenario style.
- `packages/testkit/src/runtime-adapter-contract-harness.ts` - current adapter contract checks.
- `packages/adapters/test/runtime-adapter-contracts.test.ts` - downstream contract suite that will import the fake ACP runtime in the adapter task.
- `packages/testkit/package.json` - existing testkit script and dependency style.

`instructions`: Add a deterministic fake ACP runtime under testkit that implements newline-delimited JSON-RPC over stdio and never calls external services. The fake must respond to `initialize`, `session/new`, and `session/prompt`; emit `session/update` notifications; handle `session/cancel` by returning active prompt response `stopReason: "cancelled"` for the cancelled scenario; optionally emit bounded stderr diagnostics; optionally emit `session/request_permission`; and support invalid/oversized protocol scenarios. Expose a process factory, CLI helper, and fake-ACP-specific fixture helpers that downstream adapter tests can pass into the existing ACP-ready `runtime-adapter-contract-harness`. Do not claim or require new generic harness behavior in this task; use the current harness as a ground-truth context file and add fake-specific imports/regression tests around it.

`acceptance`:
- Fake ACP supports scenarios: `happy`, `empty_output`, `prompt_failed`, `cancelled`, `cancel_unverified`, `invalid_json`, `invalid_initialize`, `invalid_session_new`, `permission_request`, `stderr_warning`, and `oversized_message`.
- Fake ACP emits valid initialize/session-new responses and a deterministic `sessionId`.
- Fake ACP `happy` emits at least one `agent_message_chunk` update and prompt response `stopReason: "end_turn"`.
- Fake ACP `empty_output` completes with no output updates.
- Fake ACP `cancelled` confirms cancellation via prompt response `stopReason: "cancelled"` only after `session/cancel`.
- Fake ACP `cancel_unverified` accepts/observes cancel but does not produce cancelled prompt response before timeout.
- Fake ACP `permission_request` sends an agent-to-client request with an id so the client can respond `-32601`.
- Fake ACP `stderr_warning` writes stderr while ACP stdout remains valid.
- Existing runtime adapter contract harness remains the generic assertion surface; T3 adds fake ACP fixture exports and regression coverage that later OpenCode adapter contract tests can consume without requiring `run.input`.

`checks`:
- `pnpm --filter @switchyard/testkit test -- fake-acp-runtime`
- `pnpm --filter @switchyard/testkit typecheck`
- `pnpm --filter @switchyard/testkit lint`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| fake `initialize` | Fake diverges from ACP schema | Adapter tests pass against unrealistic protocol | Use protocol-acpx serializers/schemas for fake messages | Contract failures catch real ACP shape regressions |
| fake `session/prompt` | Terminal response emitted before updates deterministically race | Adapter misses streaming behavior | Emit scripted updates before prompt response in happy scenario | Adapter event mapping is tested |
| fake cancellation | Cancel test marks run cancelled without ACP confirmation | Fake immediately returns success on cancel call | Require prompt response `stopReason:"cancelled"` for cancelled scenario and omit it in unverified scenario | Public cancel semantics remain verified-terminal |
| fake permission request | Permission request looks like notification and cannot be answered | Missing request id | Send proper agent-to-client request with id | Client can return `-32601` and adapter can fail visibly |
| fake stderr warning | Non-fatal stderr path untested | Warning omitted | Scenario writes stderr with valid ACP success responses | OpenCode doctor partial behavior is testable |
| fake contract fixture | Fake ACP process cannot be used by the existing harness | Fixture omits deterministic cwd/task/session controls | Export a fixture/process factory that downstream adapter tests can plug into the existing ACP-ready harness | OpenCode contract tests exercise fake ACP without real model APIs |

`observability`:
- `logs`: Fake runtime does not add production logs; tests assert stderr transcript capture through adapter/client.
- `success_metric`: Fake ACP tests cover all required scenarios without real OpenCode or model APIs.
- `failure_metric`: Any missing fake scenario, schema-incompatible fake message, or contract harness false positive fails testkit tests.

`test_cases`:
- `{ name: "fake happy protocol", lens: "happy", given: "scenario happy", expect: "initialize, session/new, update, end_turn response" }`
- `{ name: "fake empty output", lens: "happy_shadow_empty", given: "scenario empty_output", expect: "prompt response end_turn with no agent_message_chunk" }`
- `{ name: "fake cancelled", lens: "integration", given: "active prompt then session/cancel", expect: "prompt response stopReason cancelled" }`
- `{ name: "fake cancel unverified", lens: "error_path", given: "session/cancel in cancel_unverified scenario", expect: "no cancelled response before timeout" }`
- `{ name: "fake prompt failed", lens: "error_path", given: "scenario prompt_failed returns a session/prompt JSON-RPC error", expect: "AcpStdioClient surfaces AcpResponseError; downstream OpenCode adapter maps it to run.failed reason acp_prompt_error with transcript preserved" }`
- `{ name: "fake invalid json", lens: "error_path", given: "scenario invalid_json writes malformed stdout after process start", expect: "client-visible AcpProtocolError reason acp_invalid_json; downstream adapter maps it to a failed run/check reason without hanging" }`
- `{ name: "fake invalid initialize", lens: "error_path", given: "scenario invalid_initialize", expect: "initialize response missing required protocol fields" }`
- `{ name: "fake invalid session new", lens: "error_path", given: "scenario invalid_session_new returns session/new result without sessionId", expect: "client schema rejects it and downstream OpenCode doctor/start maps it to opencode_acp_session_new_failed" }`
- `{ name: "fake permission request", lens: "error_path", given: "scenario permission_request", expect: "agent-to-client request session/request_permission with id" }`
- `{ name: "fake stderr warning", lens: "edge_stderr", given: "scenario stderr_warning", expect: "stderr diagnostic and successful ACP stdout" }`
- `{ name: "fake oversized message", lens: "edge_oversized", given: "scenario oversized_message", expect: "stdout line larger than configured limit" }`

`integration_contracts`:
- `exports`:
  - `{ name: "startFakeAcpRuntimeProcess", kind: "function", signature: "(options: FakeAcpRuntimeOptions) => AcpTestProcessHandle" }`
  - `{ name: "createFakeAcpProcessFactory", kind: "function", signature: "(options: FakeAcpRuntimeOptions) => AcpProcessFactory" }`
  - `{ name: "FakeAcpRuntimeScenario", kind: "type", signature: "happy | empty_output | prompt_failed | cancelled | cancel_unverified | invalid_json | invalid_initialize | invalid_session_new | permission_request | stderr_warning | oversized_message" }`
- `imports_from_other_tasks`:
  - `{ from_task: "P4-T2-protocol-acpx-stdio-client-and-workspace-deps", name: "serializeJsonRpcMessage", signature: "(message: JsonRpcMessage, options?: { maxBytes?: number }) => string" }`
  - `{ from_task: "P4-T2-protocol-acpx-stdio-client-and-workspace-deps", name: "parseJsonRpcLine", signature: "(line: string, options?: { maxBytes?: number }) => JsonRpcMessage" }`
  - `{ from_task: "P4-T2-protocol-acpx-stdio-client-and-workspace-deps", name: "AcpStdioClient", signature: "constructor(options: AcpStdioClientOptions); start(): Promise<void>; request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>; notify(method: string, params?: unknown): Promise<void>; notifications(): AsyncIterable<AcpNotification>; close(): Promise<void>; kill(): void; transcript(): AcpTranscriptRecorder" }`
  - `{ from_task: "P4-T2-protocol-acpx-stdio-client-and-workspace-deps", name: "AcpProtocolError", signature: "new AcpProtocolError(reasonCode: string, message: string, details?: Record<string, unknown>)" }`
  - `{ from_task: "P4-T2-protocol-acpx-stdio-client-and-workspace-deps", name: "AcpResponseError", signature: "new AcpResponseError(input: { code: number | string; message: string; data?: unknown })" }`
- `file_paths_consumed_by_other_tasks`:
  - `packages/testkit/src/fake-acp-runtime.ts`
  - `packages/testkit/src/index.ts`

### Task P4-T4-opencode-contracts-and-runtime-mode-inference

`id`: `P4-T4-opencode-contracts-and-runtime-mode-inference`
`title`: Add opencode.acp contract fixtures and runtime-mode inference

`files`:
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/core/src/services/registry-service.ts`
- Modify: `packages/core/test/registry-service.test.ts`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md` - `opencode.acp` runtime-mode contract, provider/runtime/model ids, inference rules, and capability non-goals.
- `packages/contracts/src/run.ts` - public adapter type enum already includes `acpx`.
- `packages/contracts/src/registry.ts` - runtime kind/capability schemas that should already represent ACP.
- `packages/core/src/services/registry-service.ts` - current fake/Codex/Generic HTTP inference and explicit slug validation.
- `packages/core/test/registry-service.test.ts` - existing registry service fixture pattern.

`instructions`: Add contract tests proving the complete `opencode.acp` runtime-mode fixture parses with `adapterType: "acpx"`, `kind: "acp"`, capabilities exactly from the spec, limitations exactly from the spec, placement facts, docs path `docs/development/adapters/OPENCODE.md`, and stored availability shape. Extend `RegistryService.inferAndValidateRuntimeMode` so omitted `runtimeMode` infers `opencode.acp` only when `runtime === "opencode"` and `adapterType === "acpx"`. Explicit `opencode.acp` must match runtime `opencode`, provider `opencode`, and adapter type `acpx`; explicit internal id `runtime_mode_opencode_acp` remains invalid in public bodies. Do not add `run.input`, `session.resume`, `approval.*`, `tool.*`, `hosted`, `mcp.*`, or any new runtime capability strings.

`acceptance`:
- Contract tests parse the full `opencode.acp` fixture with `adapterType: "acpx"` and `kind: "acp"`.
- Contract tests assert unsupported future strings such as `run.input`, `session.resume`, `approval.request`, `tool.invoke`, `hosted.run`, and `mcp.server` still reject.
- `RegistryService` infers `opencode.acp` for `runtime: "opencode"` plus `adapterType: "acpx"`.
- Explicit `opencode.acp` rejects mismatched runtime, provider, or adapter type with typed `invalid_input` details.
- Explicit `runtime_mode_opencode_acp` rejects as an internal id rather than a public slug.
- Existing fake, Codex, and Generic HTTP inference behavior remains unchanged.

`checks`:
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/contracts typecheck`
- `pnpm --filter @switchyard/core test -- registry-service`
- `pnpm --filter @switchyard/core typecheck`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `runtimeModeSchema` fixture | ACP mode cannot be represented | Contract fixture parse fails | Reuse existing `acpx`, `acp`, and raw transcript capability enums; only adjust schema if truly missing | Runtime-mode API can expose `opencode.acp` |
| capability enum | Scope creep capabilities become public | Schema accepts unshipped strings | Add explicit negative tests and do not extend enum | Clients do not see approval/tool/session features in R5 |
| `inferRuntimeMode` | OpenCode create without runtimeMode stays undefined | Missing inference branch | Add exact runtime/adapter branch only | `POST /runs` can infer `opencode.acp` |
| explicit slug validation | Mismatched runtime launches wrong adapter | `opencode.acp` accepted with `adapterType:"process"` | Compare stored mode runtime id, provider id, and adapter type | Caller gets `400 invalid_input` |
| internal id validation | Public bodies accept internal ids | `runtime_mode_opencode_acp` parsed as slug | Preserve `runtime_mode_` rejection path | Public API remains slug-only |

`observability`:
- `logs`: No runtime logs are added in this task.
- `success_metric`: Focused contract and registry tests prove `opencode.acp` is representable and inferable without runtime dispatch.
- `failure_metric`: Any unshipped capability acceptance or mismatch inference success fails focused tests.

`test_cases`:
- `{ name: "opencode runtime mode fixture parses", lens: "happy", given: "complete spec fixture for opencode.acp", expect: "runtimeModeSchema.parse succeeds" }`
- `{ name: "acpx adapter type already public", lens: "happy", given: "adapterTypeSchema.parse('acpx')", expect: "returns acpx" }`
- `{ name: "future capability strings reject", lens: "error_path", given: "run.input, session.resume, approval.request, tool.invoke, hosted.run, mcp.server", expect: "each schema parse throws" }`
- `{ name: "infer opencode runtime mode", lens: "happy_shadow_nil", given: "runtime opencode, adapterType acpx, no runtimeMode", expect: "opencode.acp" }`
- `{ name: "explicit opencode runtime mode accepts match", lens: "integration", given: "runtime opencode, provider opencode, adapterType acpx, runtimeMode opencode.acp", expect: "opencode.acp" }`
- `{ name: "internal opencode id rejected", lens: "error_path", given: "runtimeMode runtime_mode_opencode_acp", expect: "invalid_input path runtimeMode" }`
- `{ name: "opencode mismatch rejected", lens: "error_path", given: "runtime codex, adapterType process, runtimeMode opencode.acp", expect: "invalid_input path runtimeMode" }`

`integration_contracts`:
- `exports`:
  - `{ name: "RegistryService.inferAndValidateRuntimeMode", kind: "function", signature: "(input: { runtime: string; provider: string; adapterType: AdapterType; runtimeMode?: string }) => Promise<string | undefined>" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/core/src/services/registry-service.ts`
  - `packages/contracts/test/contracts.test.ts`

### Task P4-T5-core-doctor-rest-and-cancelled-artifacts

`id`: `P4-T5-core-doctor-rest-and-cancelled-artifacts`
`title`: Generalize custom doctor availability and persist verified-cancel artifacts

`files`:
- Modify: `packages/core/src/services/runtime-doctor-service.ts`
- Modify: `packages/core/src/services/runtime-runner-service.ts`
- Modify: `packages/core/test/core.test.ts`
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Modify: `packages/protocol-rest/test/run-routes.test.ts`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md` - doctor custom availability, cancel verification, transcript persistence, and public error behavior.
- `packages/core/src/errors.ts` - existing `AdapterProtocolError` class and reason-code fields.
- `packages/core/src/services/runtime-doctor-service.ts` - current Generic HTTP adapter-provided availability mapping.
- `packages/core/src/services/runtime-runner-service.ts` - current public cancel and terminal artifact persistence behavior.
- `packages/protocol-rest/src/run-routes.ts` - current input/cancel `AdapterProtocolError` mapping to `409 adapter_protocol_failed`.
- `packages/core/test/core.test.ts` - existing runner cancellation, timeout, artifact, and doctor coverage.

`instructions`: Generalize `RuntimeDoctorService` so any mode with `mode.check.strategy === "custom"` or `details.availability` consumes adapter-provided availability without falling through to Codex binary/model-catalog assumptions. Preserve existing Generic HTTP reason codes and tests, but make the fallback invalid-availability reason generic enough for OpenCode. Sanitize and bound all adapter-provided availability messages, versions, and diagnostics, including `Authorization`, `Bearer ...`, env-like `_TOKEN`, `_KEY`, `_SECRET` keys, and configured-token substrings when present in details. Update `RuntimeRunnerService.cancel()` so a non-terminal public cancel still marks the run/session cancelled only after `adapter.cancel()` returns, but then persists adapter artifacts using the existing artifact content store and publishes `artifact.created` events even though the run is now cancelled. If `adapter.cancel()` throws `AdapterProtocolError`, preserve the previous run/session state and do not persist false cancellation artifacts. Keep already-terminal cancel idempotent and keep timeout behavior unchanged. Update REST input/cancel protocol-failure responses to include reason-code details when present on `AdapterProtocolError` while preserving the closed `409 adapter_protocol_failed` envelope.

`acceptance`:
- `RuntimeDoctorService` maps `opencode.acp` custom availability details without requiring Codex-style `version` plus `models`.
- Custom doctor mapping supports OpenCode states: unavailable, unknown, partial, and available; `partial` with `reasonCode: "opencode_stderr_warning"` remains `canRun: true`.
- Doctor output, persisted availability, diagnostics, and logs redact token-like and env-like secrets and bound diagnostic sizes.
- `RuntimeRunnerService.cancel()` persists transcript artifacts after verified public cancellation and emits `artifact.created` after `run.cancelled`.
- Public cancel failure from `AdapterProtocolError` returns `409 adapter_protocol_failed`, includes reason-code detail, leaves run/session state unchanged, and does not emit a false `run.cancelled`.
- Cancel against already terminal runs remains idempotent and does not call adapter cancel again.
- Public cancel changes include regression coverage for existing fake, Codex process, and Generic HTTP adapters so verified-cancel artifact persistence does not change their cancellation contracts.
- Terminal/cancel races persist at most one terminal state and exactly one transcript/artifact record for a started ACP session, even when adapter terminalization and public cancel complete in the same tick.
- Timeout still marks run `timeout`, session `failed`, emits `run.failed` with `runtime_timeout`, and best-effort calls adapter cancel.
- Existing fake, Codex, Generic HTTP, REST, and artifact tests continue to pass.

`checks`:
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/core typecheck`
- `pnpm --filter @switchyard/protocol-rest test -- run-routes`
- `pnpm --filter @switchyard/protocol-rest typecheck`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `RuntimeDoctorService.runBoundedCheck` | OpenCode custom check interpreted as Codex binary check | Missing models makes mode unavailable | Branch on `check.strategy === "custom"` or `details.availability` before Codex mapping | Doctor reports OpenCode-specific availability |
| doctor sanitization | OpenCode stderr or details leak tokens | Details contain Bearer/API_TOKEN/SECRET | Redact and truncate all messages, versions, and diagnostics before response/storage/logging | Check output is safe to inspect |
| `RuntimeRunnerService.cancel` | Verified ACP cancel loses transcript | Existing cancel returns after marking cancelled and start loop skips artifacts | Persist adapter artifacts in public cancel path with cancelled-run allowance | Cancelled OpenCode runs expose transcript artifact |
| `RuntimeRunnerService.cancel` | Unverified cancel lies | Adapter cancel throws but run is marked cancelled | Update run/session only after adapter returns; rethrow `AdapterProtocolError` | Public cancel returns 409 and state stays previous |
| artifact persistence after cancel | Artifact failure rewrites cancelled run | Content store throws after terminal update | Preserve terminal state and make artifact failure visible in tests/logs | Run stays cancelled; artifact issue is diagnosable |
| terminal/cancel race | Both event loop and public cancel persist terminal artifacts | Adapter terminal event and cancel response complete together | Deduplicate by run terminal state and artifact path/content key before emitting `artifact.created` | Caller sees one terminal result and one transcript artifact |
| REST error mapping | Reason code hidden from caller | AdapterProtocolError reasonCode omitted | Add `details: [{ path:"reasonCode", issue: reasonCode }]` or equivalent stable detail | Caller sees why input/cancel failed |

`observability`:
- `logs`: Existing doctor `runtime_mode.check`, runner terminal event, timeout, and cancel warning logs remain. Added cancel artifact path must log only run id, runtime, session id, reason code, and artifact path, never raw transcript content.
- `success_metric`: Core tests prove one terminal event, cancelled transcript artifact persistence, unchanged state on cancel failure, and custom doctor partial/available mapping.
- `failure_metric`: Any duplicate terminal event, false cancellation, leaked secret, missing cancelled artifact, or Codex fallback for OpenCode custom checks fails tests.

`test_cases`:
- `{ name: "custom availability available", lens: "happy", given: "adapter.check details.availability state available", expect: "RuntimeDoctorCheck available canRun true" }`
- `{ name: "custom availability partial stderr", lens: "happy_shadow_empty", given: "availability partial reason opencode_stderr_warning with warning diagnostic", expect: "canRun true and warning diagnostic" }`
- `{ name: "custom availability missing details", lens: "error_path", given: "custom adapter returns ok without availability", expect: "unknown state with generic invalid custom-check reason" }`
- `{ name: "doctor redacts env secrets", lens: "edge_redaction", given: "message includes API_KEY and Bearer token", expect: "response/storage/logs omit secret values" }`
- `{ name: "verified public cancel persists artifact", lens: "integration", given: "adapter.cancel returns and artifacts include transcript content", expect: "run cancelled and artifact.created emitted with stored content" }`
- `{ name: "unverified cancel preserves state", lens: "error_path", given: "adapter.cancel throws AdapterProtocolError reason acp_cancel_unverified", expect: "409 from REST and run remains running or later terminal state" }`
- `{ name: "public cancel regressions for existing adapters", lens: "integration", given: "fake, Codex fake process, and Generic HTTP fake server runs exercise their existing public cancel paths", expect: "their previous terminal/idempotency/error semantics remain unchanged after RuntimeRunnerService.cancel changes" }`
- `{ name: "terminal cancel race stores transcript once", lens: "edge_race", given: "adapter emits terminal event while public cancel verification returns in the same tick", expect: "exactly one terminal run state and exactly one artifact.created event for the transcript path" }`
- `{ name: "already terminal cancel idempotent", lens: "happy_shadow_nil", given: "cancel completed run", expect: "existing run returned and adapter cancel not called" }`
- `{ name: "timeout behavior unchanged", lens: "integration", given: "adapter never emits terminal event", expect: "run timeout, session failed, runtime_timeout event" }`

`integration_contracts`:
- `exports`:
  - `{ name: "RuntimeDoctorService.checkRuntimeMode", kind: "function", signature: "(idOrSlug: string) => Promise<RuntimeDoctorCheck> with custom details.availability support" }`
  - `{ name: "RuntimeRunnerService.cancel", kind: "function", signature: "(runId: string) => Promise<Run> that persists artifacts after verified cancellation" }`
  - `{ name: "registerRunRoutes", kind: "function", signature: "maps AdapterProtocolError to 409 adapter_protocol_failed with reason-code detail when available" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/core/src/services/runtime-doctor-service.ts`
  - `packages/core/src/services/runtime-runner-service.ts`
  - `packages/protocol-rest/src/run-routes.ts`

### Task P4-T6-opencode-acp-adapter

`id`: `P4-T6-opencode-acp-adapter`
`title`: Implement OpenCode ACP adapter over protocol-acpx

`files`:
- Create: `packages/adapters/src/opencode/index.ts`
- Create: `packages/adapters/src/opencode/types.ts`
- Create: `packages/adapters/src/opencode/opencode-acp-adapter.ts`
- Create: `packages/adapters/src/opencode/opencode-doctor.ts`
- Create: `packages/adapters/src/opencode/opencode-event-mapper.ts`
- Modify: `packages/adapters/src/index.ts`
- Create: `packages/adapters/test/opencode-acp-adapter.test.ts`
- Modify: `packages/adapters/test/runtime-adapter-contracts.test.ts`

`dependencies`: [`P4-T2-protocol-acpx-stdio-client-and-workspace-deps`, `P4-T3-fake-acp-runtime-and-contract-harness`, `P4-T5-core-doctor-rest-and-cancelled-artifacts`]

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md` - OpenCode manifest, doctor matrix, run behavior, event mapping, transcript artifact contract, and failure reason codes.
- `packages/adapters/src/generic-http/generic-http-adapter.ts` - manifest, check, unsupported input, verified cancel, artifact, and logging pattern.
- `packages/adapters/src/codex/codex-exec-json-adapter.ts` - process-backed local adapter and transcript artifact pattern.
- `packages/adapters/test/runtime-adapter-contracts.test.ts` - shared adapter contract suite to extend with OpenCode ACP fake process.
- `packages/adapters/src/index.ts` - current package export barrel that must add OpenCode exports.
- `docs/adapters/opencode.md` - verified local OpenCode facts and pre-R5 implementation notes.

`instructions`: Add `OpenCodeAcpAdapter` with manifest exactly matching the spec: adapter id `opencode`, provider `provider_opencode`, runtime `runtime_opencode`, mode id `runtime_mode_opencode_acp`, slug `opencode.acp`, adapter type `acpx`, kind `acp`, capabilities including `artifact.raw_transcript`, limitations, placement, docs path, and custom check metadata. The adapter must launch configured OpenCode command with fixed args `["acp"]`, `shell: false`, daemon-level options only, and no arbitrary run metadata in env. `check()` must run `<command> --version`, launch ACP, send `initialize`, send `session/new`, close/kill, and never send `session/prompt`; non-fatal stderr maps to partial `opencode_stderr_warning`. Doctor-created ACP sessions are transient: do not persist them as Switchyard run/session state, and always attempt close/kill cleanup after success, partial, timeout, or failure. `start()` must require absolute `cwd`, non-empty task, initialize protocol version 1, create ACP session with `{ cwd, mcpServers: [] }`, store external ACP session id, and return Switchyard session data. `events()` must first yield stored initialize/session status events, then send one `session/prompt` text block from the run task, stream `session/update` notifications through the event mapper, wait for prompt response, and yield exactly one terminal event from stopReason. Updates received before the prompt response must be emitted before the terminal event; updates received after a terminal decision may be recorded in the transcript/logs but must not create a second terminal or reorder the already emitted terminal. `send()` must throw `AdapterProtocolError` reason `opencode_input_unsupported`. `cancel()` must send `session/cancel` notification only for active prompts, return idempotently when no prompt is active or already terminal, and otherwise return only after observing prompt response `stopReason: "cancelled"`; unverified cancellation throws `AdapterProtocolError` reason `acp_cancel_unverified`. Permission requests must be answered `-32601`, yield `run.failed` reason `acp_permission_request_unsupported`, and attempt best-effort cancel. Permission/public-cancel race rule: first verified terminal cause wins under the adapter's session state lock. If `session/request_permission` is observed before verified `stopReason:"cancelled"`, the run fails with `acp_permission_request_unsupported` and later public cancel is idempotent; if verified cancel is observed first, the run cancels and later permission activity cannot overwrite it. `artifacts()` must always return `runs/<runId>/opencode-acp-transcript.jsonl` after an ACP subprocess starts, including completed, failed-after-start, timeout-after-start, and cancelled sessions.

Implementation sub-sequence for this large task:

1. Build `opencode-doctor.ts` first with the exact spec doctor matrix and no-prompt assertions for every probe path.
2. Add manifest/types and package exports without run lifecycle behavior.
3. Add `opencode-event-mapper.ts` for session/update and prompt stopReason mapping, including prompt response/update ordering tests.
4. Add `OpenCodeAcpAdapter.start()` and `events()` over `AcpStdioClient`, including run-path stderr capture that does not fail successful prompts.
5. Add `send()`, verified `cancel()`, permission-request handling, and deterministic permission/cancel race coverage.
6. Add transcript `artifacts()` coverage for completed, failed-after-start, timeout-after-start, cancelled, stderr, and redaction cases, then wire the existing runtime adapter contract suite to the fake ACP fixture.

`acceptance`:
- OpenCode manifest parses through existing contracts and includes no unshipped capabilities.
- Adapter check matrix covers every spec row with exact state/canRun/installed/auth/reasonCode expectations and a no-prompt assertion for each row: command missing, version timeout, no version, ACP exits before initialize, invalid initialize JSON-RPC, unsupported protocol version, auth/config failure on `session/new`, invalid session/new shape, success, and success with stderr warning partial.
- `check()` never sends `session/prompt`; fake runtime tests assert no prompt is received during every doctor probe path, including failures before initialize and failures at `session/new`.
- Doctor-created ACP sessions are transient and cleanup is attempted after success, partial warning, timeout, and failure paths.
- `start()` fails relative `cwd` with reason `opencode_cwd_not_absolute` and does not pass run metadata into env.
- `events()` maps initialize/session-new to `runtime.status`, known session updates to specified `runtime.output`/`runtime.status` payloads, unknown updates to visible `runtime.status`, and prompt stop reasons to exactly one terminal event.
- `events()` allows empty output and `POST /runs?wait=1` can later return `response.text: null`.
- Run-path non-fatal stderr is captured in the raw ACP transcript and bounded diagnostics without failing an otherwise successful prompt.
- Prompt response/update ordering is deterministic: all updates observed before prompt response are yielded before the terminal event, and post-terminal updates cannot emit a second terminal event.
- Permission request scenario fails visibly with `run.failed` error `acp_permission_request_unsupported` and no approval request/tool execution is created.
- Permission-request/public-cancel races follow the first-verified-terminal-wins rule and are covered by fake ACP tests.
- Verified cancel scenario yields `run.cancelled`; unverified cancel throws `AdapterProtocolError` reason `acp_cancel_unverified`.
- Transcript artifact path, metadata, content, stderr lines, cancellation transcript, failed-after-start transcript, timeout-after-start transcript, and redaction rules match the spec.
- Shared runtime adapter contract suite passes for fake runtime, Codex fake process, Generic HTTP fake server, and OpenCode ACP fake process.

`checks`:
- `pnpm --filter @switchyard/adapters test -- opencode`
- `pnpm --filter @switchyard/adapters test -- runtime-adapter-contracts`
- `pnpm --filter @switchyard/adapters typecheck`
- `pnpm --filter @switchyard/adapters lint`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `OpenCodeAcpAdapter.check` | Doctor spends model budget | Check accidentally sends `session/prompt` | Implement check with version, initialize, session/new only; fake asserts prompt count zero | Doctor is safe to run locally |
| `OpenCodeAcpAdapter.check` | Doctor-created ACP process/session leaks | Probe succeeds or fails before cleanup | Always attempt close/kill in `finally`; never persist doctor sessions as run sessions | Repeated checks do not accumulate local processes |
| doctor stderr | Benign OpenCode local stderr marks unavailable | Notify-script warning on stderr | Return custom availability `partial`, `canRun:true`, reason `opencode_stderr_warning` | Runtime mode is runnable with warning diagnostics |
| `start` cwd validation | ACP receives relative cwd | Public REST allows relative cwd | Validate absolute cwd in adapter and throw `opencode_cwd_not_absolute` | Run fails fast with named reason |
| run stderr | Successful run fails because stderr has local warning | OpenCode writes diagnostic stderr while prompt succeeds | Record bounded stderr in transcript and logs; do not fail unless stderr exceeds max bytes | Run completes and artifact shows warning context |
| event mapper | Unknown ACP update is dropped | New ACP update type appears | Emit `runtime.status` `status:"acp_update"` with `acpUpdateType` | Caller sees protocol activity |
| prompt/update ordering | Prompt response terminal appears before already-read updates | Response and notifications are interleaved in same read cycle | Drain queued notifications in read order before yielding terminal response | Client sees output/status before terminal event |
| stopReason mapper | Unknown stop reason completes incorrectly | Future stop reason | Yield `run.failed` error `acp_unknown_stop_reason` | Run does not falsely succeed |
| permission request | OpenCode waits for unsupported approval | `session/request_permission` not answered | Client returns `-32601`, adapter fails run and cancels | Run fails visibly; no approval UI implied |
| permission/cancel race | Permission failure and public cancel fight over terminal state | Permission request arrives while cancel is verifying | Apply first-verified-terminal-wins under session state lock | Run deterministically fails or cancels, never both |
| cancel | Public cancel marks cancelled without ACP confirmation | Prompt response never says cancelled | Throw `AdapterProtocolError` reason `acp_cancel_unverified` | REST returns 409 and state is preserved |
| artifacts | Failed/cancelled/timeout sessions lose raw protocol | Adapter only returns artifacts on completed terminal | Store transcript recorder per session and always return transcript after subprocess start | Artifacts exist for debugging failures, timeout, and cancellation |

`observability`:
- `logs`: Adapter logs `opencode.check`, `opencode.acp.start`, `opencode.acp.prompt`, `opencode.acp.cancel`, `opencode.acp.terminal`, and `opencode.acp.protocol_error` with run id, session id, ACP session id, process id, method, stop reason, reason code, and bounded stderr snippets only.
- `success_metric`: Adapter tests prove doctor no-prompt behavior, event mapping, verified cancellation, permission failure, transcript content, and contract harness compatibility.
- `failure_metric`: Any prompt sent by doctor, false cancellation, missing transcript, dropped unknown update, or permission request hang fails adapters tests.

`test_cases`:
- `{ name: "doctor command missing no prompt", lens: "error_path", given: "configured command does not exist", expect: "state unavailable, canRun false, installed false, auth unknown, reason opencode_binary_unavailable, no session/prompt attempted" }`
- `{ name: "doctor version timeout no prompt", lens: "error_path", given: "<command> --version exceeds check timeout", expect: "state unknown, canRun false, installed false, auth unknown, reason check_timeout, no session/prompt attempted" }`
- `{ name: "doctor no version no prompt", lens: "error_path", given: "<command> --version exits without parseable version", expect: "state unavailable, canRun false, installed true, auth unknown, reason opencode_version_unavailable, no session/prompt attempted" }`
- `{ name: "doctor acp exits before initialize no prompt", lens: "error_path", given: "ACP process exits before initialize response", expect: "state unavailable, canRun false, installed true, auth unknown, reason opencode_acp_unavailable, fake prompt count 0" }`
- `{ name: "doctor invalid initialize json-rpc no prompt", lens: "error_path", given: "fake ACP invalid_json or invalid initialize envelope during initialize", expect: "state unavailable, canRun false, installed true, auth unknown, reason opencode_acp_initialize_failed, fake prompt count 0" }`
- `{ name: "doctor unsupported protocol no prompt", lens: "error_path", given: "initialize succeeds with protocolVersion other than 1", expect: "state unavailable, canRun false, installed true, auth unknown, reason acp_protocol_version_unsupported, fake prompt count 0" }`
- `{ name: "doctor auth required no prompt", lens: "error_path", given: "session/new returns auth/config JSON-RPC error", expect: "state unavailable, canRun false, installed true, auth missing, reason opencode_auth_required, fake prompt count 0" }`
- `{ name: "doctor invalid session new no prompt", lens: "error_path", given: "session/new result lacks sessionId", expect: "state unavailable, canRun false, installed true, auth unknown, reason opencode_acp_session_new_failed, fake prompt count 0" }`
- `{ name: "doctor available no prompt", lens: "happy", given: "version, initialize, and session/new succeed with empty stderr", expect: "state available, canRun true, installed true, auth configured, reasonCode null, fake prompt count 0" }`
- `{ name: "doctor stderr partial no prompt", lens: "happy_shadow_empty", given: "version, initialize, and session/new succeed with bounded stderr", expect: "state partial, canRun true, installed true, auth configured, reason opencode_stderr_warning, fake prompt count 0" }`
- `{ name: "doctor cleanup attempted", lens: "edge_cleanup", given: "success, stderr partial, timeout, and session/new failure check probes", expect: "client close/kill attempted and no doctor ACP session stored as a Switchyard run/session" }`
- `{ name: "relative cwd fails", lens: "error_path", given: "start cwd 'repo'", expect: "run.failed or thrown reason opencode_cwd_not_absolute" }`
- `{ name: "happy prompt maps output", lens: "happy", given: "fake ACP happy run", expect: "runtime.output text and run.completed stopReason end_turn" }`
- `{ name: "empty output completes null response", lens: "happy_shadow_empty", given: "fake ACP empty_output run", expect: "run.completed with no runtime.output" }`
- `{ name: "run stderr warning captured", lens: "edge_stderr", given: "fake ACP writes bounded stderr during a successful prompt", expect: "run.completed and transcript includes acp.stderr without failing success" }`
- `{ name: "known update types map", lens: "integration", given: "plan, tool_call, tool_call_update, session_info_update, current_mode_update, available_commands_update", expect: "visible runtime.status payloads" }`
- `{ name: "unknown update visible", lens: "edge_unknown_update", given: "sessionUpdate new_future_type", expect: "runtime.status acp_update with acpUpdateType" }`
- `{ name: "prompt updates precede terminal", lens: "edge_ordering", given: "fake emits two session/update notifications then prompt response in one flush", expect: "adapter yields both updates before the terminal event" }`
- `{ name: "post-terminal update cannot create second terminal", lens: "edge_ordering", given: "fake emits prompt response then a late session/update", expect: "exactly one terminal event; late update is transcript/log context only" }`
- `{ name: "refusal fails", lens: "error_path", given: "prompt response stopReason refusal", expect: "run.failed error acp_refusal" }`
- `{ name: "prompt json-rpc error fails", lens: "error_path", given: "fake ACP prompt_failed scenario", expect: "run.failed error acp_prompt_error and transcript remains available" }`
- `{ name: "permission request unsupported", lens: "error_path", given: "fake ACP permission_request", expect: "run.failed acp_permission_request_unsupported and JSON-RPC -32601 response" }`
- `{ name: "permission cancel race permission first", lens: "edge_race", given: "permission request is observed before verified cancelled prompt response while public cancel is in flight", expect: "single terminal run.failed acp_permission_request_unsupported; later cancel is idempotent cleanup" }`
- `{ name: "permission cancel race cancel first", lens: "edge_race", given: "verified cancelled prompt response is observed before permission request handling terminalizes", expect: "single terminal run.cancelled; later permission activity cannot overwrite terminal state" }`
- `{ name: "verified cancel", lens: "integration", given: "active prompt then adapter.cancel", expect: "cancel returns after stopReason cancelled" }`
- `{ name: "cancel unverified", lens: "error_path", given: "fake ACP cancel_unverified", expect: "AdapterProtocolError reason acp_cancel_unverified" }`
- `{ name: "failed after start transcript", lens: "integration", given: "fake invalid_json or prompt_failed after ACP subprocess starts", expect: "artifacts() returns opencode-acp-transcript.jsonl with initialize/prompt context and redacted raw lines" }`
- `{ name: "timeout after start transcript", lens: "integration", given: "started fake ACP prompt never returns before runtime timeout", expect: "best-effort cancel/kill occurs and artifacts() still returns opencode-acp-transcript.jsonl" }`
- `{ name: "transcript artifact redacted", lens: "edge_redaction", given: "raw ACP/stderr with Bearer token", expect: "artifact content redacts token and has metadata r5.acp.v1" }`

`integration_contracts`:
- `exports`:
  - `{ name: "OPENCODE_ACP_RUNTIME_MODE_SLUG", kind: "constant", signature: "\"opencode.acp\"" }`
  - `{ name: "OpenCodeAcpAdapter", kind: "class", signature: "implements RuntimeAdapter; constructor(options?: OpenCodeAcpAdapterOptions)" }`
  - `{ name: "mapAcpSessionUpdateToSwitchyardEvent", kind: "function", signature: "(input: { runId: string; acpSessionId?: string; update: unknown; sequence: number }) => SwitchyardEvent" }`
  - `{ name: "checkOpenCodeAcpAvailability", kind: "function", signature: "(options: OpenCodeAcpCheckOptions) => Promise<RuntimeAdapterCheck>" }`
- `imports_from_other_tasks`:
  - `{ from_task: "P4-T2-protocol-acpx-stdio-client-and-workspace-deps", name: "AcpStdioClient", signature: "constructor(options: AcpStdioClientOptions); start(): Promise<void>; request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>; notify(method: string, params?: unknown): Promise<void>; notifications(): AsyncIterable<AcpNotification>; close(): Promise<void>; kill(): void; transcript(): AcpTranscriptRecorder" }`
  - `{ from_task: "P4-T3-fake-acp-runtime-and-contract-harness", name: "createFakeAcpProcessFactory", signature: "(options: FakeAcpRuntimeOptions) => AcpProcessFactory" }`
  - `{ from_task: "P4-T5-core-doctor-rest-and-cancelled-artifacts", name: "RuntimeDoctorService.checkRuntimeMode", signature: "(idOrSlug: string) => Promise<RuntimeDoctorCheck> with custom details.availability support" }`
- `file_paths_consumed_by_other_tasks`:
  - `packages/adapters/src/opencode/index.ts`
  - `packages/adapters/src/opencode/opencode-acp-adapter.ts`
  - `packages/adapters/src/index.ts`

### Task P4-T7-daemon-opencode-wiring-and-rest-smoke

`id`: `P4-T7-daemon-opencode-wiring-and-rest-smoke`
`title`: Wire opencode.acp through daemon config, registry seeding, doctor, and run API

`files`:
- Modify: `apps/daemon/src/config.ts`
- Modify: `apps/daemon/src/app.ts`
- Modify: `apps/daemon/test/smoke.test.ts`

`dependencies`: [`P4-T3-fake-acp-runtime-and-contract-harness`, `P4-T4-opencode-contracts-and-runtime-mode-inference`, `P4-T5-core-doctor-rest-and-cancelled-artifacts`, `P4-T6-opencode-acp-adapter`]

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md` - daemon env vars, registry records, API behavior, and local smoke requirements.
- `apps/daemon/src/config.ts` - current daemon env parsing for Generic HTTP.
- `apps/daemon/src/app.ts` - current adapter registration, registry seeding, capability seeding, doctor service, and artifact content wiring.
- `apps/daemon/test/smoke.test.ts` - current daemon smoke coverage and Generic HTTP lifecycle pattern.
- `packages/adapters/src/index.ts` - current adapter package export surface imported by daemon.
- `packages/testkit/src/fake-http-runtime-server.ts` - fake runtime injection and daemon smoke pattern to mirror for ACP.

`instructions`: Extend daemon config with daemon-level OpenCode/ACP settings: `SWITCHYARD_OPENCODE_COMMAND` default `opencode`, `SWITCHYARD_ACP_REQUEST_TIMEOUT_MS` default `5000`, `SWITCHYARD_ACP_CANCEL_TIMEOUT_MS` default `5000`, and `SWITCHYARD_ACP_MAX_MESSAGE_BYTES` default `1048576`. Do not allow per-run OpenCode command, ACP args, timeouts, max message bytes, or env injection. Register `OpenCodeAcpAdapter` under adapter key/runtime `opencode` with configured command and timeouts. Seed provider `provider_opencode`, runtime `runtime_opencode`, model `model_opencode_default`, and runtime mode `opencode.acp` using the adapter manifest and an initial stored availability snapshot. Add `opencode.acp` to capability-service seeding and logs. Keep `GET /doctor` read-only; `POST /runtime-modes/opencode.acp/check` must run the bounded adapter check and update stored availability. Add daemon smoke tests using fake ACP process injection: runtime-mode list includes `opencode.acp`, active check does not send prompts, partial stderr warning is stored, run create infers runtime mode when omitted, explicit internal id rejects, wait=1 happy run returns normalized output and artifact records retrievable through `GET /runs/:id/artifacts`, `GET /artifacts/:id`, and `GET /artifacts/:id/content`, input returns 409 `opencode_input_unsupported`, verified cancel persists transcript artifacts exactly once, failed-after-start and timeout-after-start runs persist transcript artifacts, and unverified cancel returns 409 without false cancellation.

`acceptance`:
- `loadDaemonConfig()` parses all OpenCode/ACP env vars with defaults and trims command only at daemon config boundary.
- Adapter map includes `opencode` and existing fake/Codex/Generic HTTP adapters remain registered unchanged.
- Daemon seeds OpenCode provider/runtime/model/mode records with correct ids, names, auth mode `local`, adapter type `acpx`, kind `acp`, model `opencode-default`, and manifest capabilities/limitations.
- `/runtime-modes` includes `opencode.acp`; `/runtime-modes/opencode.acp` returns seeded availability; `/doctor` summary counts it.
- `POST /runtime-modes/opencode.acp/check` uses fake ACP check in tests, updates stored availability, surfaces partial stderr warning, and never sends a prompt.
- `POST /runs?wait=1` with `runtime:"opencode"`, `provider:"opencode"`, `model:"opencode-default"`, `adapterType:"acpx"`, absolute cwd, and no explicit runtimeMode infers `opencode.acp` and completes through fake ACP.
- Explicit `runtime_mode_opencode_acp` in public create body returns `400 invalid_input`.
- `POST /runs/:id/input` for OpenCode returns `409 adapter_protocol_failed` with reason `opencode_input_unsupported`.
- Verified public cancel persists `runs/<runId>/opencode-acp-transcript.jsonl` exactly once; the artifact list entry is retrievable through `GET /runs/:id/artifacts`, the artifact record is retrievable through `GET /artifacts/:id`, and stored content is retrievable through `GET /artifacts/:id/content`.
- Failed-after-start OpenCode ACP runs persist a raw transcript artifact retrievable through `GET /artifacts/:id` and `GET /artifacts/:id/content`.
- Timeout-after-start OpenCode ACP runs persist a raw transcript artifact retrievable through `GET /artifacts/:id` and `GET /artifacts/:id/content`.
- Unverified public cancel returns `409 adapter_protocol_failed`, leaves run state non-cancelled, and does not emit false cancellation.

`checks`:
- `pnpm --filter @switchyard/daemon test`
- `pnpm --filter @switchyard/daemon typecheck`
- `pnpm --filter @switchyard/protocol-rest test`
- `pnpm --filter @switchyard/core test -- registry-service`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| config parsing | Per-run metadata overrides local command | Run metadata contains command/env | Do not read OpenCode/ACP settings from run metadata; only `DaemonConfig` | Runs cannot inject local commands |
| adapter registration | `opencode.acp` seeded but no adapter registered | Doctor check says adapter not registered | Add `["opencode", new OpenCodeAcpAdapter(...)]` before service creation | Runtime mode can check and run |
| registry seeding | OpenCode records missing model or wrong adapter type | `POST /runs` mismatch validation fails | Seed provider/runtime/model/mode from manifest and default model record | Public payload works with `opencode-default` |
| active check | Doctor sends prompt | Fake prompt count increments | Use adapter `check()` only and assert prompt count zero | Check is budget-safe |
| public cancel | Cancel transcript not persisted or duplicated | Existing runner skips artifacts after cancellation, or terminal/cancel race persists twice | Depend on T5 and assert artifact list, `GET /artifacts/:id`, and content after cancel with exactly one transcript artifact | Cancelled runs remain debuggable without duplicate artifacts |
| failed/timeout after start | Transcript only exists for successful runs | Started ACP subprocess fails or times out before terminal success | Assert REST artifact retrieval for failed-after-start and timeout-after-start cases | Operators can inspect protocol history for failures/timeouts |
| unverified cancel | Daemon returns cancelled on failed ACP verify | Adapter cancel throws but REST returns 200 | Map `AdapterProtocolError` to 409 and assert stored run state | Caller sees cancel failed and run state is honest |

`observability`:
- `logs`: Startup emits `runtime_mode.seeded` for `opencode.acp`; checks log runtime mode, state, and reason code; runs log existing runner events plus OpenCode adapter logs. Logs must not contain raw transcripts, env values, or auth tokens.
- `success_metric`: Daemon smoke proves `opencode.acp` is discoverable, checkable, runnable, cancellable, and artifact records/content are retrievable through REST.
- `failure_metric`: Any prompt during doctor check, missing runtime-mode seed, false cancellation, missing/duplicate cancelled transcript, missing failed/timeout transcript, or internal id acceptance fails daemon tests.

`test_cases`:
- `{ name: "config defaults", lens: "happy_shadow_nil", given: "empty env", expect: "opencode command and ACP timeout defaults" }`
- `{ name: "runtime mode seeded", lens: "happy", given: "createDaemonApp with fake ACP options", expect: "/runtime-modes includes opencode.acp" }`
- `{ name: "doctor no prompt", lens: "integration", given: "POST /runtime-modes/opencode.acp/check", expect: "fake prompt count 0 and availability updated" }`
- `{ name: "stderr warning partial stored", lens: "edge_stderr", given: "fake ACP stderr_warning check", expect: "runtime mode availability partial reason opencode_stderr_warning" }`
- `{ name: "run inference opencode", lens: "happy_shadow_nil", given: "POST /runs?wait=1 without runtimeMode", expect: "run.runtimeMode opencode.acp and completed output" }`
- `{ name: "internal mode id rejected", lens: "error_path", given: "runtimeMode runtime_mode_opencode_acp", expect: "400 invalid_input path runtimeMode" }`
- `{ name: "input unsupported", lens: "error_path", given: "POST /runs/:id/input on OpenCode run", expect: "409 adapter_protocol_failed reason opencode_input_unsupported" }`
- `{ name: "verified cancel stores retrievable artifact", lens: "integration", given: "active OpenCode fake run then cancel", expect: "run cancelled; exactly one transcript appears in GET /runs/:id/artifacts; GET /artifacts/:id returns metadata/path; GET /artifacts/:id/content returns redacted JSONL" }`
- `{ name: "failed after start stores retrievable artifact", lens: "integration", given: "fake ACP invalid_json or prompt_failed run through daemon after subprocess start", expect: "run failed and transcript artifact is retrievable through GET /artifacts/:id and content route" }`
- `{ name: "timeout after start stores retrievable artifact", lens: "integration", given: "fake ACP run starts but prompt never returns before timeout", expect: "run timeout/failed per runner contract and transcript artifact is retrievable through GET /artifacts/:id and content route" }`
- `{ name: "cancel unverified stays honest", lens: "error_path", given: "fake cancel_unverified then POST cancel", expect: "409 and stored run not cancelled" }`

`integration_contracts`:
- `exports`:
  - `{ name: "loadDaemonConfig", kind: "function", signature: "(env?: NodeJS.ProcessEnv) => DaemonConfig with opencode ACP settings" }`
  - `{ name: "createDaemonApp", kind: "function", signature: "(config?: DaemonConfig, options?: CreateDaemonAppOptions) => Promise<FastifyInstance> with opencode adapter registration" }`
- `imports_from_other_tasks`:
  - `{ from_task: "P4-T4-opencode-contracts-and-runtime-mode-inference", name: "RegistryService.inferAndValidateRuntimeMode", signature: "(input: { runtime: string; provider: string; adapterType: AdapterType; runtimeMode?: string }) => Promise<string | undefined>" }`
  - `{ from_task: "P4-T5-core-doctor-rest-and-cancelled-artifacts", name: "RuntimeRunnerService.cancel", signature: "(runId: string) => Promise<Run> that persists artifacts after verified cancellation" }`
  - `{ from_task: "P4-T6-opencode-acp-adapter", name: "OpenCodeAcpAdapter", signature: "implements RuntimeAdapter; constructor(options?: OpenCodeAcpAdapterOptions)" }`
  - `{ from_task: "P4-T3-fake-acp-runtime-and-contract-harness", name: "createFakeAcpProcessFactory", signature: "(options: FakeAcpRuntimeOptions) => AcpProcessFactory" }`
- `file_paths_consumed_by_other_tasks`:
  - `apps/daemon/src/config.ts`
  - `apps/daemon/src/app.ts`

### Task P4-T8-r5-docs-and-local-smoke-guide

`id`: `P4-T8-r5-docs-and-local-smoke-guide`
`title`: Update R5 product truth, API docs, development docs, and OpenCode smoke guide

`files`:
- Modify: `PRODUCT.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/development/API.md`
- Modify: `docs/development/DEVELOPMENT.md`
- Create: `docs/development/adapters/OPENCODE.md`
- Modify: `docs/development/adapters/README.md`
- Modify: `docs/adapters/opencode.md`

`dependencies`: [`P4-T7-daemon-opencode-wiring-and-rest-smoke`]

`context_files`:
- `docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md` - docs acceptance, smoke commands, shipped/non-shipped scope, and warnings.
- `PRODUCT.md` - current shipped product truth and non-shipped list.
- `CHANGELOG.md` - release entry style.
- `docs/development/API.md` - current API contract and runtime-mode examples.
- `docs/development/DEVELOPMENT.md` - local startup and verification commands.
- `docs/development/adapters/GENERIC_HTTP.md` - adapter docs structure and local smoke style.
- `docs/adapters/opencode.md` - pre-R5 OpenCode research facts to convert into shipped behavior.

`instructions`: Update docs only after code tasks and required automated checks pass. Move R5 from planned to shipped in `PRODUCT.md`, including new private package `@switchyard/protocol-acpx`, shipped runtime mode `opencode.acp`, local OpenCode ACP constraints, doctor/check behavior, raw ACP transcript artifacts, verified cancellation semantics, and unchanged non-goals. Add a dated R5 changelog entry. Update API docs with `opencode.acp` runtime-mode inference, create/check/cancel examples, transcript artifact retrieval, and `409 adapter_protocol_failed` examples for unsupported input and unverified cancel. Update development docs with final verification commands and manual smoke commands. Create `docs/development/adapters/OPENCODE.md` with env vars, doctor/check safety note, local smoke, transcript inspection, healthy logs, partial stderr warning, common failures, and explicit note that `session/prompt` can spend model budget while doctor/check does not. Update adapter README and research doc to point to the shipped local guide. Do not describe hosted execution, approval workflows, tool routing, memory, PTY, session resume/load/fork/list, or model selection as shipped.

`acceptance`:
- `PRODUCT.md` lists `@switchyard/protocol-acpx` and `opencode.acp` as shipped current truth and removes ACP/OpenCode from the "does not exist yet" list.
- `PRODUCT.md` still lists hosted workers, approval workflow expansion, tools, memory, PTY, inbound ACP server, and interactive Codex as not shipped.
- `CHANGELOG.md` has a dated R5 entry summarizing ACPX package, fake ACP harness, OpenCode ACP adapter, doctor, daemon wiring, verified cancellation, and raw ACP transcripts.
- `docs/development/API.md` documents `opencode.acp` inference, create/check/cancel examples, unsupported input behavior, unverified cancel behavior, and artifact/content retrieval.
- `docs/development/DEVELOPMENT.md` includes R5 final verification commands and local smoke commands without requiring prompt-spending smoke unless the developer opts in.
- `docs/development/adapters/OPENCODE.md` includes env vars, smoke commands, healthy output, `opencode_stderr_warning` partial behavior, no-prompt doctor guarantee, transcript inspection, and common failure reason codes.
- Docs consistently state `opencode-default` means OpenCode's configured current model and R5 does not select OpenCode models per run.
- Docs do not claim hosted node connectivity, debate, inbound ACP server, PTY, interactive Codex, SDK/CLI product, approvals, tools, memory, or MCP management are shipped.

`checks`:
- `git diff --check`
- `rg "opencode.acp" PRODUCT.md CHANGELOG.md docs/development/API.md docs/development/DEVELOPMENT.md docs/development/adapters/OPENCODE.md`
- `rg "session/prompt can spend model budget|Doctor/check does not send session/prompt" docs/development/adapters/OPENCODE.md docs/development/DEVELOPMENT.md`
- `rg "approval workflow|hosted|PTY|interactive Codex" PRODUCT.md docs/development/API.md docs/development/adapters/OPENCODE.md`

`error_rescue_map`:

| codepath | failure | exception | rescue | user_sees |
| --- | --- | --- | --- | --- |
| `PRODUCT.md` | Product truth overclaims R5 | Hosted/approval/tool/memory language appears shipped | Keep shipped list narrow and non-shipped list explicit | Owner sees exact current capability |
| `API.md` | Public payload examples use internal ids | Example uses `runtime_mode_opencode_acp` | Use slug `opencode.acp` and call out internal id rejection | API users copy working payloads |
| `OPENCODE.md` doctor docs | Developer thinks check spends model budget | Check guide omits no-prompt note | State initialize/session-new only and no `session/prompt` | Developers can safely run doctor |
| `OPENCODE.md` smoke docs | Prompt smoke can spend budget without warning | Curl prompt appears as routine check | Mark prompt smoke optional and read-only; separate doctor smoke from run smoke | Developers make informed local smoke choice |
| docs failure reasons | Permission/cancel failures look like bugs | Reason codes omitted | Document `acp_permission_request_unsupported`, `acp_cancel_unverified`, `opencode_stderr_warning`, `opencode_input_unsupported` | Operators can diagnose expected R5 constraints |

`observability`:
- `logs`: Docs list expected structured log names and safe fields for OpenCode checks, start, prompt, cancel, terminal, and protocol errors.
- `success_metric`: Docs allow a developer to verify runtime-mode discovery, no-prompt check, optional run smoke, cancellation, and artifact content retrieval locally.
- `failure_metric`: Any doc example using internal ids, claiming unshipped features, or omitting model-budget warning fails docs checks.

`test_cases`:
- `{ name: "product truth updated", lens: "happy", given: "PRODUCT.md", expect: "opencode.acp shipped and ACP/OpenCode removed from not-shipped list" }`
- `{ name: "non-goals preserved", lens: "edge_scope", given: "PRODUCT.md and API docs", expect: "hosted, approval expansion, tools, memory, PTY, inbound ACP remain not shipped" }`
- `{ name: "api create example", lens: "integration", given: "API docs OpenCode create curl", expect: "uses runtime opencode, provider opencode, model opencode-default, adapterType acpx, runtimeMode opencode.acp" }`
- `{ name: "doctor no prompt warning", lens: "happy_shadow_nil", given: "OPENCODE.md doctor section", expect: "states check sends initialize/session-new only" }`
- `{ name: "prompt budget warning", lens: "edge_cost", given: "OPENCODE.md run smoke section", expect: "states session/prompt can spend model budget" }`
- `{ name: "transcript inspection documented", lens: "integration", given: "OPENCODE.md", expect: "GET /runs/:id/artifacts, GET /artifacts/:id, and GET /artifacts/:id/content commands for opencode-acp-transcript.jsonl" }`

`integration_contracts`:
- `exports`: []
- `imports_from_other_tasks`:
  - `{ from_task: "P4-T7-daemon-opencode-wiring-and-rest-smoke", name: "createDaemonApp", signature: "(config?: DaemonConfig, options?: CreateDaemonAppOptions) => Promise<FastifyInstance> with opencode adapter registration" }`
  - `{ from_task: "P4-T6-opencode-acp-adapter", name: "OpenCodeAcpAdapter", signature: "implements RuntimeAdapter; constructor(options?: OpenCodeAcpAdapterOptions)" }`
  - `{ from_task: "P4-T6-opencode-acp-adapter", name: "checkOpenCodeAcpAvailability", signature: "(options: OpenCodeAcpCheckOptions) => Promise<RuntimeAdapterCheck>" }`
- `file_paths_consumed_by_other_tasks`: []

## Final Verification

Required automated checks before R5 is called complete:

```bash
pnpm --filter @switchyard/protocol-acpx test
pnpm --filter @switchyard/protocol-acpx typecheck
pnpm --filter @switchyard/testkit test -- fake-acp-runtime
pnpm --filter @switchyard/adapters test -- opencode
pnpm --filter @switchyard/adapters test -- runtime-adapter-contracts
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

Manual OpenCode smoke is optional and local-binary dependent. It must be documented as potentially model-budget-spending only for the run prompt, not for doctor/check:

```bash
opencode --version
```

```bash
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-r5-opencode \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

```bash
BASE=http://127.0.0.1:4546
curl -s "$BASE/runtime-modes/opencode.acp" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/opencode.acp/check" | python3 -m json.tool
RUN_ID=$(curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"opencode","provider":"opencode","model":"opencode-default","adapterType":"acpx","runtimeMode":"opencode.acp","cwd":"'"$(pwd)"'","task":"Return one short sentence describing this repository. Do not edit files.","timeoutSeconds":120}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["run"]["id"])')
curl -s "$BASE/runs/$RUN_ID/artifacts" | python3 -m json.tool
```

## Promotion Criteria

- ACP protocol behavior lives in `@switchyard/protocol-acpx`, not in daemon/core.
- OpenCode uses the ACP client foundation, not bespoke stdout parsing.
- Core gains protocol-neutral doctor/cancel lifecycle improvements only.
- Runtime-mode public API remains slug-based and rejects internal ids.
- Doctor/check never sends `session/prompt`.
- Cancellation never lies: public cancellation is persisted only after ACP verifies `stopReason: "cancelled"`.
- Cancelled, failed-after-start, timeout-after-start, and completed OpenCode ACP runs have raw transcript artifacts.
- Transcript artifact `raw` fields contain redacted raw JSON-RPC only; pre-redaction secret values are never stored in artifact content.
- Permission requests fail visibly with `acp_permission_request_unsupported`; no approval workflow is implied.
- OpenCode stderr warning can produce partial availability without failing successful initialize/session-new.
- Existing fake, Codex, Generic HTTP, REST, SSE, storage, and daemon behavior remains green.

## CTO Self Review

13-item review after architect iteration 2 second revision:

1. Spec coverage: pass. The plan maps ACPX package, fake ACP, OpenCode doctor/run/cancel, daemon/REST, artifacts, and docs to concrete tasks.
2. Placeholder scan: pass. No TBD/TODO/vague placeholder language remains.
3. Type consistency: pass. T2 imports exactly match T1 exports, T2 explicitly re-exports helpers consumed by T3, T6 imports the exact T5 custom doctor contract name, and T8 imports existing T6/T7 export names instead of docs-source placeholders.
4. Ownership disjoint: pass. Removing T3 ownership of `packages/testkit/src/runtime-adapter-contract-harness.ts` avoids a stale generic-harness edit claim; no task owns the same file as another.
5. Context files real: pass. All `context_files` entries are existing worktree files and remain ground-truth anchors.
6. Acceptance testable: pass. Added doctor matrix, fake ACP scenario, REST artifact retrieval, race, and transcript redaction criteria are objectively verifiable.
7. Dependency order sane: pass. T3 depends on T2 re-exports; T6 depends on protocol/testkit/core lifecycle; T7 depends on registry/core/adapter wiring.
8. Checks runnable: pass. Checks use existing `pnpm --filter` package commands and `git diff --check`.
9. Error/rescue map present: pass. New race, cleanup, ordering, correlation, and artifact paths have rescue rows; duplicate in-flight request ids and unknown response ids now sit in T2 with the client correlation owner.
10. Observability present: pass. Runtime tasks specify safe logs/metrics and explicitly avoid raw transcript/env/token logging.
11. Test cases enumerate acceptance: pass. Architect-required cases for T2, T3, T6, and T7 are explicit, including T2 error-path tests for duplicate in-flight ids and unknown response ids.
12. Integration contracts walk: pass. Each `imports_from_other_tasks` name resolves to a listed export in the referenced task.
13. Contract types match: pass. Cross-task signatures were aligned for T1/T2 helpers, T3 fake factory, T4 registry inference, T5 cancel/custom doctor, and T6 adapter exports.

9-item plan completeness self-test:

1. Every acceptance criterion in the spec has at least one task that delivers it: pass.
2. Every task has at least one acceptance criterion: pass.
3. Every acceptance criterion has at least one matching `test_case`: pass for phase-risk level; high-cardinality matrices are represented by explicit row cases in T6.
4. Every `error_rescue_map` entry has matching error, edge, or shadow test coverage: pass; T2 covers `acp_duplicate_request_id` and `acp_unknown_response_id`.
5. Every `integration_contracts.imports_from_other_tasks` resolves to a real export elsewhere in the plan: pass; T8 now imports `createDaemonApp`, `OpenCodeAcpAdapter`, and `checkOpenCodeAcpAvailability`.
6. Every `context_files` path exists in the project: pass.
7. No task edits a file owned by another task: pass.
8. No placeholder text (`TBD`, `TODO`, "similar to", vague "edge cases") remains: pass.
9. Complexity is L and was challenged: pass. T6 remains one task but now has an explicit sub-sequence to manage doctor, lifecycle, mapping, cancel, permission, and artifact responsibilities without overlapping file ownership.
