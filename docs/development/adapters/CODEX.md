# Codex Adapter Local Development

This guide is only for Codex-specific local debugging. Use the [Official API Contract](../API.md) for endpoint shapes and [Local Development](../DEVELOPMENT.md) for daemon startup, SQLite, process, and verification commands.
Manual smoke in this file depends on a locally installed `codex` CLI on your machine (`PATH`-reachable). It does not cover hosted Codex execution or interactive sessions.

## Current Codex Scope

Implemented:

- Local non-interactive `codex exec --json`.
- Runtime mode slug: `codex.exec_json` (one-shot, local-only, not hosted-safe in R4).
- Process adapter mode through `adapterType: "process"`.
- Shared process substrate usage (`ProcessRunner`, JSONL parser harness, transcript recorder, adapter timeout wrapper) with unchanged public Codex behavior.
- JSONL stdout parsing into Switchyard events.
- Raw stdout/stderr transcript artifact capture.
- Model and reasoning metadata mapping.
- Child process PID logging.
- Timeout and daemon-restart terminalization.
- Runtime doctor checks that never run model tasks (`POST /runtime-modes/:id/check`) and are bounded by timeout/output limits.

Not implemented yet:

- Interactive Codex sessions.
- Codex interactive runtime-mode promotion and resume-mode workflow.
- Post-start input for Codex `exec --json`.
- PTY fallback.
- Approval bridging.
- Hosted Codex process execution.

R3 check behavior:

- missing Codex binary: reported as `unavailable` (`binary_unavailable`).
- model catalog unavailable/empty: reported as `unavailable` (`model_catalog_unavailable`).
- optional check failure with required checks passing: reported as `partial` (`optional_check_failed`).
- hung/slow/oversized checks: bounded and sanitized as `unknown`/`unavailable` with stable reason codes.

R4 Codex compatibility note:

- Shared process substrate extraction is internal-only.
- Public Codex adapter behavior is preserved: `codex exec --json`, `shell: false`, immediate stdin close, log names (`codex.spawned`, `codex.stderr`, `codex.stdout.first_line`, `codex.exit`, `codex.process_error`), and transcript path `runs/<runId>/codex-transcript.jsonl`.

## Request Metadata

Current Codex metadata keys:

| Key | Example | Behavior |
| --- | --- | --- |
| `reasoningEffort` | `"low"` | Maps to `model_reasoning_effort`. |
| `reasoningSummary` | `"auto"` | Maps to `model_reasoning_summary`. |
| `verbosity` | `"low"` | Maps to Codex verbosity config. |
| `sandbox` | `"read-only"` | Passed to `codex exec --sandbox`. |
| `ignoreUserConfig` | `true` | Defaults to `true` to avoid local MCP/hooks/user config surprises. |
| `ignoreRules` | `false` | Defaults to `false`. |

Recommended local smoke payload:

```json
{
  "runtime": "codex",
  "provider": "openai",
  "model": "gpt-5.5",
  "adapterType": "process",
  "cwd": "/Users/vasuyadav/Downloads/Projects/switchyard",
  "task": "Return one sentence describing this repository. Do not edit files.",
  "metadata": {
    "reasoningEffort": "low",
    "reasoningSummary": "auto",
    "verbosity": "low",
    "sandbox": "read-only",
    "ignoreUserConfig": true
  },
  "timeoutSeconds": 120
}
```

Use it with [Create Run](../API.md#create-run) when you want the final answer in `response.text`.

## Healthy Log Shape

A healthy Codex run should look like this:

```text
INFO run.started runId="run_..." runtime="codex" model="gpt-5.5" timeoutSeconds=120
INFO codex.spawned runId="run_..." pid=7896 ... ignoreUserConfig=true
INFO runtime.session.started runId="run_..." sessionId="session_..." processId=7896
WARN codex.stderr runId="run_..." pid=7896 text="Reading additional input from stdin..."
INFO codex.stdout.first_line runId="run_..." pid=7896
INFO runtime.status runId="run_..." sequence=2 status="thread_started"
INFO runtime.status runId="run_..." sequence=3 status="turn_started"
INFO runtime.output runId="run_..." sequence=...
INFO run.completed runId="run_..." sequence=...
INFO codex.exit runId="run_..." pid=7896 code=0
```

`Reading additional input from stdin...` is normal when it is followed quickly by `codex.stdout.first_line`. If that line appears and no `codex.stdout.first_line` follows, the child is waiting before JSONL output.

## Common Stuck States

`curl` cannot connect:

- Daemon is not running, is on a different port, or failed to bind.
- Check [Local Development](../DEVELOPMENT.md#health-check).

Run has only `run.queued` and `run.started`:

- Adapter started but no normalized runtime event arrived.
- Check daemon logs for `codex.spawned`, `codex.stderr`, and `codex.stdout.first_line`.
- Check `runtime_sessions.process_id`, then verify the process with `ps`.

`codex.spawned` appears but no `codex.stdout.first_line`:

- Codex has not emitted JSONL yet.
- If stderr says `Reading additional input from stdin...` and no first line follows, suspect stdin or Codex startup.
- The adapter closes stdin immediately; if this regresses, run `pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter`.

`codex.stdout.first_line` appears but no completion:

- Codex started correctly.
- The model may be reasoning, running tools, or waiting on a runtime condition.
- Watch `runtime.output`, inspect events, and use the PID to confirm the process is still alive.

Run becomes `timeout`:

- `timeoutSeconds` elapsed before a terminal event.
- Inspect `/events`, `/artifacts`, daemon logs, and the transcript artifact path.

Run is `running` after daemon restart:

- This should be reconciled on startup by the daemon.
- Expected log: `WARN run.reconciled_interrupted runId="run_..."`.

## Focused Verification

```bash
pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/daemon test
```

## Known Good Local Smoke

On 2026-05-14, the fixed adapter was verified with an isolated daemon on port `4546`.

Observed result:

- Run status: `completed`.
- Runtime: `codex`.
- Model: `gpt-5.5`.
- Mode: `exec --json`.
- Stdin behavior: Codex printed `Reading additional input from stdin...`, then emitted `codex.stdout.first_line` immediately because the adapter closed stdin.
- Final output: `Switchyard is a TypeScript pnpm monorepo for a deploy-anywhere agent runtime gateway that exposes many agent runtimes and wrappers through one unified backend API.`
