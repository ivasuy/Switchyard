# OpenCode ACP Local Development

This guide is only for OpenCode ACP local debugging. Use the [Official API Contract](../API.md) for endpoint shapes and [Local Development](../DEVELOPMENT.md) for daemon startup and full verification commands.

R21 hosted note: `opencode.acp` is in the known provider set for production hosted execution, but activation is operator opt-in only. Fake-only remains default, no-spend smoke is required before rollout, spend-gated canary is required before real traffic, and rollback returns to fake-only by config restart.

## Current OpenCode Scope

Implemented in R5:

- Runtime mode slug: `opencode.acp`.
- Adapter type: `acpx`.
- Local OpenCode subprocess launch through `opencode acp` (`shell: false`).
- ACP initialize/session-new/session-prompt/session-cancel flow through `@switchyard/protocol-acpx`.
- Runtime-mode doctor check with bounded `opencode --version`, ACP `initialize`, and ACP `session/new`.
- Raw ACP transcript artifacts at `runs/<runId>/opencode-acp-transcript.jsonl`.
- Verified cancellation: public cancel returns success only after ACP confirms `stopReason:"cancelled"`.

Not implemented in R5:

- Hosted runtime expansion beyond the R21 known-provider opt-in slice.
- Hosted approval bridge/input bridge/terminal bridge for ACP permission requests.
- Post-start input (`POST /runs/:id/input` is unsupported).
- Session resume/load/fork/list exposure through Switchyard.
- Per-run OpenCode command or ACP transport/env overrides.

## Daemon Environment Variables

```text
SWITCHYARD_OPENCODE_COMMAND=opencode
SWITCHYARD_ACP_REQUEST_TIMEOUT_MS=5000
SWITCHYARD_ACP_CANCEL_TIMEOUT_MS=5000
SWITCHYARD_ACP_MAX_MESSAGE_BYTES=1048576
```

These are daemon-level settings only.

## Doctor Safety

`POST /runtime-modes/opencode.acp/check` is budget-safe by design:

- Runs `opencode --version`.
- Starts ACP and sends `initialize` + `session/new`.
- Does **not** send `session/prompt`.

Doctor/check does not send session/prompt.
session/prompt can spend model budget.

## Local Smoke

Start daemon:

```bash
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-r5-opencode \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

Runtime mode + doctor:

```bash
BASE=http://127.0.0.1:4546
curl -s "$BASE/runtime-modes/opencode.acp" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/opencode.acp/check" | python3 -m json.tool
```

Optional prompt smoke (may spend budget):

```bash
curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"opencode","provider":"opencode","model":"opencode-default","adapterType":"acpx","cwd":"/repo","task":"Return one short sentence.","timeoutSeconds":30}' \
  | python3 -m json.tool
```

`opencode-default` means OpenCode's current configured model; R5 does not select OpenCode models per run.

## Transcript Inspection

```bash
RUN_ID=run_replace_me
curl -s "$BASE/runs/$RUN_ID/artifacts" | python3 -m json.tool
ARTIFACT_ID=artifact_replace_me
curl -s "$BASE/artifacts/$ARTIFACT_ID" | python3 -m json.tool
curl -s "$BASE/artifacts/$ARTIFACT_ID/content"
```

## Common Reason Codes

- `opencode_input_unsupported`: `POST /runs/:id/input` is not shipped for `opencode.acp`.
- `acp_permission_request_unsupported`: ACP permission request received; approval bridge is out of scope in R5.
- `acp_cancel_unverified`: cancel request sent but ACP did not confirm cancelled terminal state before timeout.
- `opencode_stderr_warning`: check succeeded but non-fatal OpenCode stderr diagnostics were observed.

## Healthy Log Signals

- `runtime_mode.seeded` for `opencode.acp` during daemon startup.
- `runtime_mode.check` entries with state/reasonCode for OpenCode checks.
- Run lifecycle logs (`run.started`, `runtime.session.started`, `run.completed`/`run.cancelled`/`run.failed`).
