# Phase 4 Spec: R5 ACP Foundation And OpenCode

Date: 2026-05-29

Roadmap release: R5: ACP Foundation And OpenCode

Branch: `agent/phase-4-r5-acp-foundation-and-opencode`

Previous phase head: `agent/phase-3-r4-shared-runtime-substrates-and-generic-http` at `158134454be02d724cb2904918d10a35d96a50cb`

Spec target: `docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md`

## Summary

R5 adds Switchyard's structured ACP/acpx foundation and proves it with a local OpenCode ACP adapter. After this release, Switchyard can run a local OpenCode-backed task through the existing run API, normalize ACP session updates into Switchyard events, cancel an active ACP prompt through the run lifecycle, and store raw ACP protocol transcript artifacts.

This is not a hosted-node, debate, SDK, CLI, TUI, PTY, interactive Codex, approval, memory, or tool-expansion release. The value is the ACP protocol boundary: OpenCode must sit on top of a reusable outbound ACP client and JSON-RPC framing package, not a bespoke OpenCode process parser.

## Scope Gate

In scope:

- New package `packages/protocol-acpx`.
- Newline-delimited JSON-RPC 2.0 framing for ACP stdio.
- ACP request/response/notification parsing, correlation, timeouts, and named protocol errors.
- Raw ACP transcript recorder that captures inbound/outbound JSON-RPC lines and stderr safely.
- Fake ACP runtime harness for deterministic contract tests.
- Outbound ACP stdio client foundation used by adapters.
- ACP session update to Switchyard event mapping.
- OpenCode doctor/check support for binary/version plus bounded ACP initialize and `session/new` probe.
- OpenCode ACP runtime adapter over the ACP foundation.
- Daemon config, registry seeding, runtime-mode inference, and run API wiring for `opencode.acp`.
- Local OpenCode smoke docs and API/development docs updates during implementation closeout.

Out of scope:

- Hosted node connectivity.
- Debate orchestration.
- Full inbound ACP server.
- Streamable HTTP or WebSocket ACP transports.
- PTY adapter or generic PTY substrate.
- Interactive Codex or Codex ACP.
- SDK/CLI product surface, TUI product work, dashboard work, or PR automation.
- Switchyard approval workflow expansion, tool routing expansion, memory APIs, policy expansion, or MCP server management.
- Per-run OpenCode binary path, per-run ACP transport overrides, or arbitrary environment injection.
- OpenCode session resume/load/fork/list exposed through Switchyard.
- OpenCode model catalog seeding beyond one default model record named `opencode-default`.

## External Protocol References

This spec uses the current ACP public documentation as protocol ground truth:

- ACP overview: `https://agentclientprotocol.com/protocol/overview`
- ACP initialization: `https://agentclientprotocol.com/protocol/initialization`
- ACP session setup: `https://agentclientprotocol.com/protocol/session-setup`
- ACP prompt turn and cancellation: `https://agentclientprotocol.com/protocol/prompt-turn`
- ACP transports: `https://agentclientprotocol.com/protocol/transports`
- OpenCode ACP support: `https://opencode.ubitools.com/acp/`

The R5 implementation must treat those as protocol references, but keep Switchyard behavior pinned to the acceptance criteria below so future ACP additions do not silently expand R5 scope.

## Existing Context

This spec is based on the R4 code in this worktree after `1581344`, not on target architecture alone.

`packages/core/src/ports/runtime-adapter.ts` is still the lifecycle boundary every runtime uses:

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

`packages/contracts/src/run.ts` already reserves `acpx` as a public adapter type, so R5 should use it instead of inventing another adapter type:

```ts
export const adapterTypeSchema = z.enum(["native", "acpx", "http", "webhook", "process", "pty", "browser"]);
```

`packages/contracts/src/registry.ts` already has the runtime kind and raw transcript vocabulary R5 needs:

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

`packages/core/src/services/registry-service.ts` currently infers shipped run modes in one place:

```ts
function inferRuntimeMode(input: { runtime: string; adapterType: AdapterType }): string | undefined {
  if (input.runtime === "fake") {
    return "fake.deterministic";
  }
  if (input.runtime === "codex" && input.adapterType === "process") {
    return "codex.exec_json";
  }
  if (input.runtime === "generic_http" && input.adapterType === "http") {
    return "generic_http.async_rest";
  }
  return undefined;
}
```

R5 adds only the next inference: `runtime: "opencode"` plus `adapterType: "acpx"` maps to `opencode.acp`.

`packages/adapters/src/generic-http/generic-http-adapter.ts` is the manifest pattern OpenCode should follow, with ACP-specific ids and capabilities:

```ts
readonly manifest: RuntimeAdapterManifest = {
  adapterId: "generic_http",
  providerId: "provider_generic_http",
  runtimeId: "runtime_generic_http",
  runtimeModeId: "runtime_mode_generic_http_async_rest",
  runtimeModeSlug: GENERIC_HTTP_RUNTIME_MODE_SLUG,
  name: "Generic HTTP async REST",
  adapterType: "http",
  kind: "async_rest",
  capabilities: [
    "run.start",
    "run.cancel",
    "run.timeout",
    "event.normalized",
    "event.streaming",
    "artifact.transcript",
    "auth.none",
    "auth.api_key"
  ],
  check: {
    strategy: "http_health",
    required: ["base_url_configured", "http_health"],
    optional: ["auth_token_present"]
  }
};
```

`packages/adapters/src/substrates/transcript-recorder.ts` currently records R4 process and HTTP transcripts:

```ts
appendProcessStdout(line: string): void {
  if (line.length > 0) {
    this.lines.push(`${line}\n`);
  }
}

appendHttpRequest(entry: HttpTranscriptRequestEntry): void {
  this.lines.push(`${JSON.stringify({
    type: "http.request",
    method: entry.method,
    path: entry.path,
    status: entry.status,
    durationMs: entry.durationMs,
    bytes: entry.bytes,
    maxBytes: entry.maxBytes,
    reasonCode: entry.reasonCode,
    message: entry.message
  })}\n`);
}
```

R5 may extend this recorder or add an ACP-specific recorder in `packages/protocol-acpx`, but the runner handoff must stay the same: adapters return `metadata.content`, and `RuntimeRunnerService` persists it through the artifact content store.

`docs/adapters/opencode.md` already records the local OpenCode facts R5 must convert into shipped product behavior:

```md
## Preferred Protocol

- Primary: ACP/acpx through `opencode acp`.
- Fallback: CLI/process only if ACP is unavailable.

## Verified Local Facts

- Binary: `/opt/homebrew/bin/opencode`
- Version: `1.3.15`
- ACP initialize succeeded locally.
- `session/new` succeeded and returned a session id and current model.
- `session/prompt` was not run because it could spend model budget.
```

The current local probe in this Phase 4 worktree confirms that `opencode --version` returns `1.3.15`, and that `opencode acp` accepts `initialize` and `session/new` without sending a prompt. Real response samples:

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "mcpCapabilities": { "http": true, "sse": true },
      "promptCapabilities": { "embeddedContext": true, "image": true },
      "sessionCapabilities": { "fork": {}, "list": {}, "resume": {} }
    },
    "authMethods": [
      {
        "description": "Run `opencode auth login` in the terminal",
        "name": "Login with opencode",
        "id": "opencode-login"
      }
    ],
    "agentInfo": { "name": "OpenCode", "version": "1.3.15" }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "ses_189c6264fffeKsdlTYOaj2GcQp",
    "models": {
      "currentModelId": "opencode/big-pickle",
      "availableModels": [
        { "modelId": "opencode/big-pickle", "name": "OpenCode Zen/Big Pickle" },
        { "modelId": "opencode/gpt-5.5", "name": "OpenCode Zen/GPT-5.5" }
      ]
    },
    "modes": {
      "availableModes": [
        { "id": "build", "name": "build", "description": "The default agent. Executes tools based on configured permissions." },
        { "id": "plan", "name": "plan", "description": "Plan mode. Disallows all edit tools." }
      ],
      "currentModeId": "build"
    },
    "_meta": {
      "opencode": {
        "modelId": "opencode/big-pickle",
        "variant": null,
        "availableVariants": ["low", "medium", "high"]
      }
    }
  }
}
```

The same local probe emitted stderr about a missing user-local notify script while returning valid ACP stdout. R5 doctor may surface bounded stderr as a warning diagnostic, but it must not fail a successful initialize/session-new probe solely because stderr contained non-fatal local logging.

## Product Terms

ACP:

- Agent Client Protocol over JSON-RPC 2.0.
- R5 implements stdio ACP only. Streamable HTTP and custom transports are out of scope.
- The agent subprocess must write only valid newline-delimited JSON-RPC messages to stdout. Stderr is diagnostic logging.

acpx:

- Switchyard's adapter type and package naming for ACP execution paths.
- Public run payloads use `adapterType: "acpx"`.
- The package is named `@switchyard/protocol-acpx` to leave room for protocol helpers beyond one adapter.

Outbound ACP client:

- A Switchyard-owned client that launches an ACP-compatible subprocess, sends JSON-RPC requests/notifications, correlates responses, handles agent notifications, and records transcripts.
- It is not a full inbound ACP server.

Raw ACP transcript:

- A newline-delimited artifact that records each ACP JSON-RPC line with direction and transport metadata.
- It is raw enough for debugging protocol order and payload shape, but must not store environment dumps, auth tokens, or arbitrary daemon config.

OpenCode ACP adapter:

- A local adapter that launches `opencode acp`, initializes ACP, creates a new ACP session, sends one prompt derived from the Switchyard run task, streams session updates, maps the prompt response to a Switchyard terminal event, and returns transcript artifacts.

## Runtime Mode Contract

R5 adds one shipped runtime mode:

| Runtime mode slug | Runtime mode id | Provider | Runtime | Adapter id | Adapter type | Kind | Meaning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `opencode.acp` | `runtime_mode_opencode_acp` | `provider_opencode` | `runtime_opencode` | `opencode` | `acpx` | `acp` | Local OpenCode subprocess using ACP over stdio. |

Seeded registry records:

- Provider: `provider_opencode`, name `OpenCode`, `authMode: "local"`.
- Runtime: `runtime_opencode`, name `OpenCode`, `adapterType: "acpx"`, `providerId: "provider_opencode"`.
- Model: `model_opencode_default`, provider `provider_opencode`, `modelName: "opencode-default"`, `supportsTools: true`, `supportsStreaming: true`, `supportsBrowser: false`.

Run creation inference:

- `runtime: "opencode"` plus `adapterType: "acpx"` infers `runtimeMode: "opencode.acp"`.
- Explicit `runtimeMode: "opencode.acp"` must match `runtime: "opencode"`, `provider: "opencode"`, and `adapterType: "acpx"`.
- Explicit internal id `runtime_mode_opencode_acp` remains invalid in public `POST /runs` bodies.
- Existing fake, Codex, and Generic HTTP inference behavior must remain unchanged.

OpenCode manifest:

```json
{
  "adapterId": "opencode",
  "providerId": "provider_opencode",
  "runtimeId": "runtime_opencode",
  "runtimeModeId": "runtime_mode_opencode_acp",
  "runtimeModeSlug": "opencode.acp",
  "name": "OpenCode ACP",
  "adapterType": "acpx",
  "kind": "acp",
  "capabilities": [
    "run.start",
    "run.cancel",
    "run.timeout",
    "event.normalized",
    "event.streaming",
    "artifact.transcript",
    "artifact.raw_transcript",
    "auth.local"
  ],
  "limitations": [
    { "code": "one_prompt_per_run", "message": "opencode.acp sends one ACP prompt per Switchyard run in R5." },
    { "code": "no_post_start_input", "message": "opencode.acp does not support POST /runs/:id/input in R5." },
    { "code": "no_switchyard_approval_bridge", "message": "ACP permission requests are failed visibly because Switchyard approval workflow is not shipped in R5." },
    { "code": "configured_local_binary_only", "message": "OpenCode command is daemon-level local configuration, not per run." },
    { "code": "no_session_resume", "message": "OpenCode ACP session load/resume/fork/list are not exposed through Switchyard in R5." }
  ],
  "placement": {
    "local": { "support": "conditional", "reason": "Requires a PATH-reachable local opencode binary and local OpenCode authentication/configuration." },
    "hosted": { "support": "future", "reason": "Hosted execution is not shipped in R5." },
    "connectedLocalNode": { "support": "future", "reason": "Hybrid local-node execution is not shipped in R5." }
  },
  "docsPath": "docs/development/adapters/OPENCODE.md",
  "check": {
    "strategy": "custom",
    "required": ["binary_version", "acp_initialize", "acp_session_new"],
    "optional": ["stderr_warning"]
  }
}
```

No new runtime capabilities should be added in R5 unless they are required to represent this manifest. In particular, do not add `run.input`, `session.resume`, `approval.*`, `tool.*`, `hosted`, or `mcp.*` capabilities.

## Daemon Configuration

OpenCode settings are daemon-level only:

| Variable | Required | Default | Behavior |
| --- | --- | --- | --- |
| `SWITCHYARD_OPENCODE_COMMAND` | No | `opencode` | Command used for `opencode --version` and `opencode acp`. May be an absolute path. |
| `SWITCHYARD_ACP_REQUEST_TIMEOUT_MS` | No | `5000` | Timeout for initialize, session/new, prompt response waits, and client method responses. |
| `SWITCHYARD_ACP_CANCEL_TIMEOUT_MS` | No | `5000` | Maximum time for `session/cancel` verification before public cancel fails with `adapter_protocol_failed`. |
| `SWITCHYARD_ACP_MAX_MESSAGE_BYTES` | No | `1048576` | Maximum bytes accepted from one ACP stdout line or stderr chunk before failing the run. |

Configuration rules:

- `opencode acp` args are fixed in R5 as `["acp"]`.
- Run metadata must not override the OpenCode command, ACP args, request timeout, cancel timeout, or max message bytes.
- The adapter must launch subprocesses with `shell: false`.
- The adapter must not pass arbitrary run metadata into environment variables.
- Logs may include run id, session id, external ACP session id, process id, method, stop reason, reason code, and bounded stderr snippets.
- Logs must not include full environment values, auth tokens, or unbounded JSON-RPC payloads.

## `packages/protocol-acpx` Scope

The new package owns reusable ACP protocol behavior. It should be usable by OpenCode now and by future ACP adapters without OpenCode-specific assumptions.

Package shape:

- `packages/protocol-acpx/package.json`
- `packages/protocol-acpx/tsconfig.json`
- `packages/protocol-acpx/src/index.ts`
- `packages/protocol-acpx/src/json-rpc.ts`
- `packages/protocol-acpx/src/acp-schemas.ts`
- `packages/protocol-acpx/src/acp-stdio-client.ts`
- `packages/protocol-acpx/src/acp-transcript.ts`
- `packages/protocol-acpx/test/*.test.ts`

Dependencies:

- May depend on `zod` and `@switchyard/contracts`.
- Should not depend on OpenCode adapter files.
- Must not depend on `@switchyard/core`; protocol errors are package-local and adapters translate them into core adapter errors.

JSON-RPC framing rules:

- Accept only one JSON-RPC message per stdout line.
- Lines are UTF-8 and newline-delimited.
- Reject embedded newlines before write.
- Enforce `jsonrpc: "2.0"`.
- Requests have `method` and optional `id`; notifications are requests without `id`.
- Responses have `id` and exactly one of `result` or `error`.
- Correlate responses by id; unknown ids are `acp_unknown_response_id`.
- Duplicate ids for in-flight requests are `acp_duplicate_request_id`.
- Malformed JSON is `acp_invalid_json`.
- Structurally invalid JSON-RPC is `acp_invalid_message`.
- JSON-RPC error responses become `AcpResponseError` with sanitized code, message, and data.
- Request timeouts are `acp_request_timeout`.
- Transport close with in-flight requests is `acp_transport_closed`.
- Oversized stdout/stderr is `acp_message_too_large`.

Minimal ACP schemas:

- `initialize` params and response, including `protocolVersion`, `clientCapabilities`, `clientInfo`, `agentCapabilities`, `agentInfo`, and `authMethods`.
- `session/new` params and response, including `cwd`, `mcpServers`, `sessionId`, optional `models`, optional `modes`, and `_meta`.
- `session/prompt` params and response, including text prompt content and `stopReason`.
- `session/cancel` notification params.
- `session/update` notification with a permissive discriminated `update.sessionUpdate` string and typed handling for known R5 mappings.
- Agent-to-client requests are parsed enough to identify `session/request_permission` and any unknown method.

R5 client capabilities sent during initialize:

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": {
      "readTextFile": false,
      "writeTextFile": false
    },
    "terminal": false
  },
  "clientInfo": {
    "name": "switchyard",
    "title": "Switchyard",
    "version": "0.0.0"
  }
}
```

R5 session/new params:

```json
{
  "cwd": "/absolute/path/to/workspace",
  "mcpServers": []
}
```

R5 session/prompt params:

```json
{
  "sessionId": "ses_...",
  "prompt": [
    {
      "type": "text",
      "text": "Run task text from POST /runs"
    }
  ]
}
```

R5 does not send `session/load`, `session/resume`, `session/fork`, `session/list`, `session/set_mode`, terminal methods, filesystem methods, or MCP server definitions.

## Outbound ACP Client Behavior

The outbound client is process-backed and stdio-only.

Startup:

1. Spawn the configured command with fixed args `["acp"]`, `shell: false`, and the run `cwd`.
2. Start stdout line reader, stderr capture, response correlation, and transcript recording before sending any request.
3. Send `initialize` with protocol version 1 and minimal client capabilities.
4. Require initialize response protocol version 1. Any other protocol version is `acp_protocol_version_unsupported`.
5. Send `session/new` with absolute `cwd` and empty `mcpServers`.
6. Store the ACP `sessionId` as `externalSessionKey`.
7. Return Switchyard `sessionId`, optional `processId`, and `externalSessionKey`.

Prompt:

1. `events(session)` first yields any stored status events from initialize/session creation.
2. It sends `session/prompt` with one text block from the run task.
3. It yields normalized events for each `session/update`.
4. It waits for the `session/prompt` response.
5. It maps the prompt `stopReason` to exactly one terminal Switchyard event.

Cancellation:

- `cancel(session)` sends ACP `session/cancel` notification when a prompt is active.
- It returns only after the prompt response is observed with `stopReason: "cancelled"` or an already observed terminal cancelled state exists.
- If no active prompt exists, cancel is idempotent and returns.
- If the prompt response does not confirm cancellation before `SWITCHYARD_ACP_CANCEL_TIMEOUT_MS`, throw `AdapterProtocolError` with reason `acp_cancel_unverified`.
- The public run stays in its previous state when cancel verification fails.
- When cancellation succeeds through the public cancel route, Switchyard must persist the raw ACP transcript artifact for the cancelled run.

Shutdown:

- After terminal prompt response, close stdin and wait briefly for process exit.
- On timeout or public cancellation, best-effort send `session/cancel`, then SIGTERM the subprocess if it remains alive.
- Process kill is idempotent.
- Non-zero process exit before terminal prompt response yields `run.failed` with `acp_process_exit`.

Agent-to-client requests:

- `session/request_permission` is not supported in R5.
- If received, the client must respond with JSON-RPC error `-32601` (`Method not found`) using the same request id, emit `run.failed` with reason `acp_permission_request_unsupported`, and attempt to cancel the prompt.
- Unknown agent-to-client methods must respond with `-32601`, emit `runtime.status` with `status: "acp_client_method_unsupported"` when non-fatal, and fail the run if the method blocks prompt completion.
- This behavior must be tested with the fake ACP harness. Do not add an approval UI or policy workflow.

## ACP Event Mapping

All adapter-emitted events are still normalized by `RuntimeRunnerService`. The adapter payloads must be stable and inspectable.

Initialization and session setup:

| ACP condition | Switchyard event |
| --- | --- |
| initialize succeeded | `runtime.status` with `status: "acp_initialized"`, `protocolVersion`, `agentName`, `agentVersion` |
| session/new succeeded | `runtime.status` with `status: "acp_session_started"`, `acpSessionId`, optional `currentModelId`, optional `currentModeId` |
| initialize/session-new failed | `run.failed` with named reason code |

Session updates:

| ACP `sessionUpdate` | Switchyard event |
| --- | --- |
| `agent_message_chunk` with text content | `runtime.output` with `text`, `acpSessionId`, `acpUpdateType` |
| `plan` | `runtime.status` with `status: "acp_plan"`, `entries` |
| `tool_call` | `runtime.status` with `status: "acp_tool_call"`, `toolCallId`, `title`, `kind`, `toolStatus` |
| `tool_call_update` | `runtime.status` with `status: "acp_tool_call_update"`, `toolCallId`, `toolStatus` |
| `session_info_update` | `runtime.status` with `status: "acp_session_info_update"`, title/update metadata |
| `current_mode_update` | `runtime.status` with `status: "acp_mode_update"`, mode id/name when present |
| `available_commands_update` | `runtime.status` with `status: "acp_available_commands_update"`, count and command names only |
| unknown update type | `runtime.status` with `status: "acp_update"`, `acpUpdateType` |

Prompt response:

| ACP stop reason | Switchyard terminal event |
| --- | --- |
| `end_turn` | `run.completed` with `status: "completed"` and `stopReason: "end_turn"` |
| `max_tokens` | `run.completed` with `status: "completed"` and `stopReason: "max_tokens"` |
| `max_turn_requests` | `run.completed` with `status: "completed"` and `stopReason: "max_turn_requests"` |
| `cancelled` | `run.cancelled` with `status: "cancelled"` and `stopReason: "cancelled"` |
| `refusal` | `run.failed` with `status: "failed"`, `error: "acp_refusal"`, and `stopReason: "refusal"` |
| unknown stop reason | `run.failed` with `status: "failed"` and `error: "acp_unknown_stop_reason"` |

Rules:

- The adapter must yield at most one terminal event per run.
- Empty output is allowed. A prompt can complete without any `runtime.output`; `POST /runs?wait=1` then returns `response.text: null`.
- Unknown ACP update types are never ignored silently.
- Tool and permission events must not create Switchyard tool executions or approval requests in R5.
- Payloads must be bounded and sanitized before logging. Full raw JSON-RPC remains in the transcript artifact, subject to transcript redaction rules.

## Raw ACP Transcript Artifacts

Every OpenCode ACP run that starts an ACP subprocess must return a transcript artifact.

Path:

- `runs/<runId>/opencode-acp-transcript.jsonl`

Type:

- `transcript`

Metadata:

```json
{
  "runtime": "opencode",
  "mode": "acp",
  "runtimeMode": "opencode.acp",
  "protocol": "acp",
  "transport": "stdio",
  "transcriptVersion": "r5.acp.v1",
  "acpSessionId": "ses_..."
}
```

Content format:

```jsonl
{"type":"acp.message","direction":"out","id":0,"method":"initialize","jsonrpc":"2.0","raw":"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",...}"}
{"type":"acp.message","direction":"in","id":0,"jsonrpc":"2.0","raw":"{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{...}}"}
{"type":"acp.message","direction":"out","id":1,"method":"session/new","jsonrpc":"2.0","raw":"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"session/new\",...}"}
{"type":"acp.stderr","text":"bounded stderr diagnostic"}
```

Transcript rules:

- Include direction, id when present, method when present, byte length, timestamp, and raw JSON-RPC line.
- Do not include process environment variables.
- Do not include auth tokens.
- Redact `Authorization`, `Bearer ...`, env-like keys ending in `_TOKEN`, `_KEY`, or `_SECRET`, and configured OpenCode command path only if it contains a token-like segment.
- Do not store lines over `SWITCHYARD_ACP_MAX_MESSAGE_BYTES`; record a metadata line with `reasonCode: "acp_message_too_large"` and fail the run.
- Stderr is captured as bounded diagnostic transcript lines. Non-fatal stderr does not fail the run.
- Runner must strip `metadata.content`, store the content through existing artifact content storage, set `contentStored`, and emit `artifact.created`.
- Cancelled runs must also get transcript artifacts. If current runner behavior skips artifacts on public cancel, R5 must adjust the runner or cancel flow so verified ACP cancellations persist transcripts.

## OpenCode Doctor And Availability

`OpenCodeAcpAdapter.check()` must be bounded and must not send `session/prompt`.

Check steps:

1. Run `<command> --version` with the configured check timeout.
2. Launch `<command> acp` with `shell: false`.
3. Send `initialize`.
4. Send `session/new` with a temporary absolute cwd and empty `mcpServers`.
5. Kill/close the ACP process after the probe.
6. Return adapter-provided availability details for `RuntimeDoctorService`.

Doctor mapping:

| Condition | State | canRun | installed | auth | reasonCode |
| --- | --- | --- | --- | --- | --- |
| command missing | `unavailable` | false | false | `unknown` | `opencode_binary_unavailable` |
| `--version` times out | `unknown` | false | false | `unknown` | `check_timeout` |
| `--version` returns no version | `unavailable` | false | true | `unknown` | `opencode_version_unavailable` |
| ACP process exits before initialize | `unavailable` | false | true | `unknown` | `opencode_acp_unavailable` |
| initialize returns invalid JSON-RPC | `unavailable` | false | true | `unknown` | `opencode_acp_initialize_failed` |
| initialize negotiates unsupported protocol version | `unavailable` | false | true | `unknown` | `acp_protocol_version_unsupported` |
| `session/new` fails auth/config | `unavailable` | false | true | `missing` | `opencode_auth_required` |
| `session/new` returns invalid shape | `unavailable` | false | true | `unknown` | `opencode_acp_session_new_failed` |
| initialize and `session/new` succeed, stderr empty | `available` | true | true | `configured` | null |
| initialize and `session/new` succeed, stderr non-empty | `partial` | true | true | `configured` | `opencode_stderr_warning` |

`RuntimeDoctorService` must generalize adapter-provided availability mapping for `check.strategy: "custom"` or `details.availability`. It must not interpret `opencode.acp` as Codex binary/model-catalog output. It must sanitize and bound all messages before returning `POST /runtime-modes/:id/check` or persisting availability.

`GET /doctor` remains read-only and returns the latest stored snapshots. `POST /runtime-modes/opencode.acp/check` runs a fresh bounded OpenCode check and updates stored availability.

## OpenCode Run Behavior

Public create payload:

```json
{
  "runtime": "opencode",
  "provider": "opencode",
  "model": "opencode-default",
  "adapterType": "acpx",
  "runtimeMode": "opencode.acp",
  "cwd": "/absolute/path/to/repo",
  "task": "Summarize this repository in one sentence.",
  "timeoutSeconds": 120
}
```

Rules:

- `cwd` must be absolute for ACP. If public REST accepts a relative path today, the OpenCode adapter must fail visibly with `opencode_cwd_not_absolute`.
- `task` must be non-empty. Existing REST validation already enforces this; adapter tests must still cover defensive nil/empty handling.
- `model: "opencode-default"` means "use OpenCode's configured current model." R5 does not select OpenCode models per run.
- OpenCode returned current model id should be recorded in `runtime.status` and transcript metadata when available.
- `POST /runs?wait=1` returns the last `runtime.output` text in `response.text`, same as other runtimes.
- `POST /runs/:id/input` returns `409 adapter_protocol_failed` with reason `opencode_input_unsupported`.
- Timeout uses existing `RuntimeRunnerService` timeout behavior, then best-effort ACP cancel and process SIGTERM.

## Fake ACP Runtime Harness

R5 must add deterministic fake ACP infrastructure under `packages/testkit`.

Required files:

- `packages/testkit/src/fake-acp-runtime-cli.ts`
- `packages/testkit/src/fake-acp-runtime.ts` or equivalent process factory helpers
- `packages/testkit/test/fake-acp-runtime.test.ts`

Behavior:

- Implements ACP stdio over newline-delimited JSON-RPC.
- Responds to `initialize`.
- Responds to `session/new`.
- Handles `session/prompt` by emitting `session/update` notifications and then a prompt response.
- Handles `session/cancel` by returning the active prompt response with `stopReason: "cancelled"`.
- Can emit stderr diagnostics.
- Can emit agent-to-client `session/request_permission` request for unsupported-permission tests.
- Does not call external services.

Required scenarios:

| Scenario | Behavior |
| --- | --- |
| `happy` | initialize, session/new, session/prompt update, `stopReason: "end_turn"`. |
| `empty_output` | prompt response completes without output updates. |
| `prompt_failed` | prompt returns JSON-RPC error or `stopReason: "refusal"`. |
| `cancelled` | active prompt confirms `stopReason: "cancelled"` after `session/cancel`. |
| `cancel_unverified` | cancel notification does not produce cancelled prompt response before timeout. |
| `invalid_json` | stdout emits malformed JSON. |
| `invalid_initialize` | initialize response is missing protocol fields. |
| `invalid_session_new` | session/new response lacks `sessionId`. |
| `permission_request` | agent calls `session/request_permission`; adapter fails visibly. |
| `stderr_warning` | stderr emits a warning while ACP messages succeed. |
| `oversized_message` | stdout line exceeds max message bytes. |

## Data Flow Shadow Paths

Every meaningful R5 data flow must have happy, nil, empty, and error coverage.

### Run request to ACP prompt

Happy:

- Public run payload has absolute `cwd`, non-empty `task`, runtime `opencode`, provider `opencode`, model `opencode-default`, adapterType `acpx`.
- Runtime mode is inferred as `opencode.acp`, adapter initializes ACP, creates a session, sends one prompt, and emits normalized output/completion.

Nil:

- `runtimeMode` is absent.
- Registry inference supplies `opencode.acp`; no public internal id is required.

Empty:

- Optional `metadata` is absent or `{}`.
- Adapter sends no extra ACP metadata and run still works.

Error:

- `cwd` is relative, OpenCode binary is missing, ACP initialize fails, or session/new fails.
- Run becomes `failed` with a named reason code; no queued/running hang.

### ACP stdout line to JSON-RPC message

Happy:

- A valid JSON-RPC response or notification line is parsed, correlated, recorded in transcript, and dispatched.

Nil:

- stdout closes before a response to an in-flight request.
- In-flight request rejects as `acp_transport_closed`; run fails visibly.

Empty:

- Blank stdout lines are ignored and are not recorded as transcript messages.

Error:

- Malformed JSON, invalid JSON-RPC envelope, unknown response id, duplicate in-flight id, or oversized line fails with named protocol error and transcript marker.

### ACP session/update to Switchyard event

Happy:

- `agent_message_chunk` with text maps to `runtime.output`.

Nil:

- Notification lacks `params` or `update`.
- Run fails with `acp_invalid_session_update`.

Empty:

- Known update type has no displayable text.
- Emit `runtime.status` with the update type instead of empty `runtime.output`.

Error:

- Unknown update type is not ignored; it maps to `runtime.status` with `status: "acp_update"` and `acpUpdateType`.

### Prompt response to terminal run state

Happy:

- `stopReason: "end_turn"` maps to `run.completed`.

Nil:

- Prompt response never arrives before run timeout.
- Existing runner timeout marks run `timeout`; adapter best-effort cancels/kills process.

Empty:

- Prompt response is `{ "stopReason": "end_turn" }` after no output updates.
- Run completes and `response.text` is null.

Error:

- Prompt response is JSON-RPC error, unknown stop reason, or `refusal`.
- Run fails with `acp_prompt_error`, `acp_unknown_stop_reason`, or `acp_refusal`.

### Cancellation to lifecycle

Happy:

- Public cancel sends `session/cancel`, OpenCode responds to prompt with `stopReason: "cancelled"`, runner stores run `cancelled`, session `cancelled`, terminal event, and transcript artifact.

Nil:

- Cancel is called after run is already terminal.
- Runner returns current run and does not call adapter cancel again.

Empty:

- Cancel notification has no body beyond `sessionId`.
- This is valid ACP and should verify through prompt response.

Error:

- Cancel does not verify, process exits early, or JSON-RPC errors.
- Public cancel returns `409 adapter_protocol_failed`, previous run state is preserved, and no false `cancelled` state is persisted.

### Transcript artifact persistence

Happy:

- Adapter returns `opencode-acp-transcript.jsonl` with inline `metadata.content`; runner stores content and emits `artifact.created`.

Nil:

- No ACP session id was created because initialize failed after process start.
- Transcript still records initialize traffic and path omits `acpSessionId` metadata.

Empty:

- OpenCode returns no output updates.
- Transcript still contains initialize, session/new, prompt request, and prompt response.

Error:

- Artifact content store fails or path normalization rejects a path.
- Failure is visible in tests/logs and must not rewrite an already terminal run to a different terminal state.

## Acceptance Criteria

- [ ] `packages/protocol-acpx` exists, builds, typechecks, and exports JSON-RPC framing, ACP schemas, outbound stdio client, transcript helpers, and named protocol errors.
- [ ] JSON-RPC framing contract tests cover valid request/response/notification, malformed JSON, invalid envelopes, response id mismatch, duplicate ids, timeout, transport close, and oversized lines.
- [ ] Fake ACP runtime harness supports happy, empty output, prompt failed, cancelled, cancel unverified, invalid JSON, invalid initialize, invalid session/new, permission request, stderr warning, and oversized message scenarios.
- [ ] Runtime adapter contract harness runs against fake runtime, Codex fake process, Generic HTTP fake server, and OpenCode ACP fake process without calling real model APIs.
- [ ] `opencode.acp` runtime mode manifest parses through existing contracts with `adapterType: "acpx"` and `kind: "acp"`.
- [ ] Registry seeding creates OpenCode provider/runtime/model records and runtime-mode records with stored availability snapshots.
- [ ] `RegistryService` infers `opencode.acp` for omitted runtime mode and rejects internal id `runtime_mode_opencode_acp` in public create bodies.
- [ ] `RuntimeDoctorService` handles adapter-provided custom availability for OpenCode without Codex model-catalog assumptions.
- [ ] `POST /runtime-modes/opencode.acp/check` reports binary/version plus ACP initialize/session-new availability and never sends a prompt.
- [ ] OpenCode doctor output redacts tokens/env-like secrets and bounds stderr/diagnostic output.
- [ ] OpenCode ACP adapter launches `opencode acp` with `shell: false`, initializes, creates a session, sends one prompt, streams updates, and maps terminal stop reasons as specified.
- [ ] `POST /runs?wait=1` with OpenCode ACP can complete a local run and return normalized events through the same run API.
- [ ] OpenCode `agent_message_chunk` updates produce `runtime.output`; plan/tool/mode/session-info/unknown updates produce visible `runtime.status` events.
- [ ] `POST /runs/:id/cancel` for an active OpenCode ACP run maps to ACP `session/cancel`, verifies `stopReason: "cancelled"`, stores run/session cancellation, and persists transcript artifacts.
- [ ] Unverified ACP cancellation returns `409 adapter_protocol_failed` and does not silently mark the run cancelled.
- [ ] Raw ACP transcript artifact is stored at `runs/<runId>/opencode-acp-transcript.jsonl`, retrievable through `GET /runs/:id/artifacts`, `GET /artifacts/:id`, and `GET /artifacts/:id/content`.
- [ ] Existing fake, Codex, Generic HTTP, REST, SSE, storage, and daemon tests continue to pass.
- [ ] Docs update `PRODUCT.md`, `CHANGELOG.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, and `docs/development/adapters/OPENCODE.md` when R5 ships.

## Implementation Slices For CTO

### Slice 1: Protocol ACPX Package

Goal: Ship the protocol package as a tested foundation with no OpenCode-specific assumptions.

Acceptance:

- `@switchyard/protocol-acpx` package is present in the workspace.
- JSON-RPC framing, ACP minimal schemas, transcript helpers, and outbound stdio client are covered by unit tests.
- Package exports are stable enough for adapters and fake harness to import.

Non-goals:

- No OpenCode adapter.
- No daemon wiring.
- No full inbound server.

Complexity: M

### Slice 2: Fake ACP Runtime And Contract Harness

Goal: Add deterministic ACP runtime infrastructure and extend adapter contract coverage for ACP behavior.

Acceptance:

- Fake ACP runtime supports all required scenarios.
- Contract tests prove ACP client behavior without real OpenCode or model calls.
- Permission request and cancel-unverified paths fail visibly.

Non-goals:

- No real OpenCode process.
- No approval workflow.

Complexity: M

### Slice 3: OpenCode ACP Adapter And Doctor

Goal: Build OpenCode as an adapter over `@switchyard/protocol-acpx`.

Acceptance:

- OpenCode manifest matches `opencode.acp`.
- Doctor runs version plus initialize/session-new only.
- Run behavior maps ACP updates and prompt stop reasons into Switchyard events.
- Transcripts are returned for completed, failed, timeout, and cancelled started sessions.

Non-goals:

- No model selection.
- No session resume/load/fork/list.
- No post-start input.

Complexity: L

### Slice 4: Daemon, Registry, REST, And Artifact Wiring

Goal: Make `opencode.acp` usable through the shipped local daemon run API.

Acceptance:

- Daemon parses ACP/OpenCode config, registers adapter, seeds provider/runtime/model/mode records, and exposes doctor/runtime-mode routes.
- Public run create inference works.
- Public cancellation persists verified cancellation and transcript artifacts.
- Existing REST contracts and error envelope stay unchanged.

Non-goals:

- No new public endpoints.
- No hosted placement.

Complexity: M

### Slice 5: Docs And Local Smoke

Goal: Document exactly how to verify R5 locally and update product truth when shipped.

Acceptance:

- OpenCode local adapter docs include env vars, smoke commands, healthy logs, common failures, and transcript inspection.
- API docs include `opencode.acp` create/check/cancel examples.
- Product/changelog/development docs mark R5 shipped only after tests and smoke pass.

Non-goals:

- No marketing site or dashboard docs.

Complexity: S

## Local Verification

Required focused checks:

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

Manual OpenCode smoke must be documented and run only when the local `opencode` binary is available:

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
  -d '{"runtime":"opencode","provider":"opencode","model":"opencode-default","adapterType":"acpx","cwd":"'"$(pwd)"'","task":"Return one short sentence describing this repository. Do not edit files.","timeoutSeconds":120}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["run"]["id"])')
curl -s "$BASE/runs/$RUN_ID/artifacts" | python3 -m json.tool
```

Manual smoke risk:

- `session/prompt` can spend model budget. Docs must say this explicitly and keep the prompt read-only.
- Doctor/check must not spend model budget because it stops after initialize and session/new.

## Promotion Criteria

- ACP code lives behind `packages/protocol-acpx` and adapter boundaries.
- OpenCode is implemented as an adapter over the ACP foundation, not as a bespoke parser in daemon or core.
- Core does not gain OpenCode-specific assumptions.
- Run API shape remains stable.
- Cancellation never lies: a run is marked cancelled only after ACP cancellation is verified or a terminal cancelled event is observed.
- Raw ACP transcript artifacts are stored for completed, failed, timeout-after-start, and cancelled OpenCode ACP runs.
- All expected failure modes have named reason codes and tests.
