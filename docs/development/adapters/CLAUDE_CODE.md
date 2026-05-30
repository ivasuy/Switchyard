# Claude Code Adapter Local Development

This guide is only for Claude Code-specific local debugging. Use the [Official API Contract](../API.md) for endpoint shapes and [Local Development](../DEVELOPMENT.md) for daemon startup and general smoke commands.

## Current Claude Scope

Implemented:

- Runtime mode slug: `claude_code.sdk`.
- Adapter type: `native` (`sdk` kind).
- Local-only bounded interactive session behavior.
- Post-start text input for active runs.
- Session state patch persistence (`claudeSessionId`) through existing runtime session state.
- Runtime approval pause bridging to existing approvals API.
- Approval resolution callback from `/approvals/:id/approve` and `/approvals/:id/reject`.
- Raw and normalized transcript artifacts with strict size bounds.

Not implemented yet:

- PTY or TUI automation.
- Hosted Claude runtime execution.
- Unbounded live-prompt checks in doctor/smoke/CI.

## Safety Defaults

Default daemon behavior is no-spend-first:

- `SWITCHYARD_CLAUDE_CODE_LIVE_PROBE` defaults to `0`.
- Runtime-mode checks and `GET /doctor` show `reasonCode: live_probe_disabled` unless live probe is explicitly enabled.
- Adapter safety defaults use `permissionMode: read_only` and disabled tools `["Bash","WebFetch","WebSearch"]`.

Optional live probe (manual only):

- Set `SWITCHYARD_CLAUDE_CODE_LIVE_PROBE=1`.
- Budget is bounded via `SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD` (default `0.05`).
- Request timeout is bounded via `SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS` (default `5000`).

## Runtime Input Contract

- `POST /runs/:id/input` accepts text only.
- Public text limit is `65536` bytes (64 KiB).
- For terminal runs, core returns `reasonCode: runtime_input_not_active`.
- For missing runtime sessions, core returns `reasonCode: runtime_session_missing`.
- For empty text, core returns `reasonCode: runtime_input_empty`.

## Runtime Approval Bridge Contract

When Claude emits a runtime approval pause with a `runtimeApprovalToken`, Switchyard creates a normal pending approval record and marks the run/session `waiting_for_approval`.

Approval resolution payload sent back to runtime:

```json
{
  "type": "approval_resolution",
  "approvalId": "approval_...",
  "runtimeApprovalToken": "provider-local-token",
  "decision": "approved",
  "message": "approved by local-user"
}
```

`answers` from approve/reject bodies are forwarded when provided.

## Transcript Bounds

- Raw transcript cap: 1 MiB.
- Normalized transcript cap: 1 MiB.
- Per-normalized-record cap: 64 KiB.
- Unknown provider event flooding is bounded after the first 100 unknown events.

## Focused Verification

```bash
pnpm --filter @switchyard/adapters test -- claude-code-adapter
pnpm --filter @switchyard/adapters test -- runtime-adapter-contracts
pnpm --filter @switchyard/daemon test -- smoke
```

## No-Spend Smoke

```bash
BASE=http://127.0.0.1:4545
curl -s "$BASE/runtime-modes/claude_code.sdk" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/claude_code.sdk/check" | python3 -m json.tool
curl -s "$BASE/doctor" | python3 -m json.tool
```

Expected no-spend outcome: Claude mode remains install/auth-probed with `reasonCode: live_probe_disabled` unless live probe is manually enabled.
