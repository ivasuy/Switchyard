# Codex Adapter Local Development

This guide is for debugging local `codex exec --json` runs through the Switchyard daemon.

Start with the generic [Switchyard Local Development](../DEVELOPMENT.md) guide if the daemon is not already running.

## Start The Daemon

Default local daemon:

```bash
SWITCHYARD_LOG_LEVEL=info pnpm --filter @switchyard/daemon dev
```

Isolated daemon on another port with temp storage:

```bash
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-codex-debug \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

With `pnpm --filter @switchyard/daemon dev`, the default data directory is `apps/daemon/.switchyard` because pnpm runs the daemon from `apps/daemon`.

## Health And Registry

```bash
curl -s http://127.0.0.1:4545/health
curl -s http://127.0.0.1:4545/providers/provider_openai
curl -s http://127.0.0.1:4545/runtimes/runtime_codex
curl -s http://127.0.0.1:4545/models/model_gpt_5_5
```

If Codex is installed and `codex debug models` works, the OpenAI provider and Codex runtime should be `available`, and model records should be seeded from the local catalog.

## Safe Fake Run

Use this first to verify daemon routing without spending Codex usage:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{
    "runtime": "fake",
    "provider": "test",
    "model": "test-model",
    "adapterType": "process",
    "cwd": "/repo",
    "task": "Smoke test Switchyard locally",
    "timeoutSeconds": 30
  }'
```

Expected status: `completed`.

## Codex Live Run

This runs a real local Codex model task and may spend Codex usage:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{
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
  }'
```

`ignoreUserConfig` defaults to `true` for daemon-launched Codex runs. Keep it enabled unless you intentionally want local MCP servers, hooks, and user config loaded into the child Codex process.

The returned JSON includes the final visible response under `response.text` and all normalized output chunks under `response.outputs`:

```json
{
  "run": {"status": "completed"},
  "response": {
    "text": "Switchyard is a TypeScript monorepo...",
    "outputs": [
      {"sequence": 17, "text": "Switchyard is a TypeScript monorepo..."}
    ]
  }
}
```

## Async Run Pattern

Create a run without waiting:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs" \
  -H 'content-type: application/json' \
  -d '{
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
  }'
```

Then inspect it:

```bash
RUN_ID=run_replace_me
curl -s "http://127.0.0.1:4545/runs/$RUN_ID"
curl -s "http://127.0.0.1:4545/runs/$RUN_ID/events"
curl -s "http://127.0.0.1:4545/runs/$RUN_ID/artifacts"
```

Cancel a stuck run:

```bash
RUN_ID=run_replace_me
curl -s -X POST "http://127.0.0.1:4545/runs/$RUN_ID/cancel"
```

## Curl Streaming

`POST /runs?wait=1` is not streamed. It blocks until the run finishes and then returns one final JSON response containing `run` metadata plus `response.text`.

Codex output is also normalized into `runtime.output` events. Fetch them with:

```bash
RUN_ID=run_replace_me
curl -s "http://127.0.0.1:4545/runs/$RUN_ID/events"
```

The route returns Server-Sent Events formatted output. Current live mode is bounded by `stopAfter`; it is not yet an open-ended streaming connection:

```bash
RUN_ID=run_replace_me
curl -N "http://127.0.0.1:4545/runs/$RUN_ID/events?live=1&stopAfter=20"
```

For local watching, create the run without `wait=1`, then poll events:

```bash
RUN_ID=run_replace_me
watch -n 1 "curl -s http://127.0.0.1:4545/runs/$RUN_ID/events"
```

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

## Process Checks

Find daemon and Codex child processes:

```bash
ps -ax -o pid,ppid,stat,etime,command | rg 'codex exec --json|node --disable-warning=DEP0205 --import tsx src/main.ts'
```

Read the relationship:

```text
<daemon-pid> ... node --disable-warning=DEP0205 --import tsx src/main.ts
<codex-pid> <daemon-pid> ... codex exec --json ...
```

If the Codex PID exists but events stop at `run.started`, inspect daemon logs and SQLite. If the Codex PID is gone but the run is still `running`, restart the daemon; startup reconciliation marks interrupted persisted runs as failed with `daemon_restarted`.

## SQLite Checks

Default database path:

```bash
DB=apps/daemon/.switchyard/switchyard.sqlite
```

If using `SWITCHYARD_DATA_DIR`, use:

```bash
DB=/private/tmp/switchyard-codex-debug/switchyard.sqlite
```

Recent runs:

```bash
sqlite3 "$DB" "select id,runtime,provider,model,status,cwd,substr(task,1,80),created_at,started_at,ended_at from runs order by created_at desc limit 10;"
```

Session and process PID for one run:

```bash
RUN_ID=run_replace_me
sqlite3 "$DB" "select id,run_id,status,process_id,created_at,updated_at from runtime_sessions where run_id='$RUN_ID';"
```

Events for one run:

```bash
RUN_ID=run_replace_me
sqlite3 "$DB" "select sequence,type,payload_json,created_at from run_events where run_id='$RUN_ID' order by sequence;"
```

Artifacts:

```bash
RUN_ID=run_replace_me
sqlite3 "$DB" "select id,type,path,metadata_json,created_at from artifacts where run_id='$RUN_ID';"
```

## Common Stuck States

`curl` cannot connect:

- Daemon is not running, is on a different port, or failed to bind.
- Check `pnpm --filter @switchyard/daemon dev` output and `curl -s http://127.0.0.1:4545/health`.

Run has only `run.queued` and `run.started`:

- Adapter started but no normalized runtime event arrived.
- Check daemon logs for `codex.spawned`, `codex.stderr`, and `codex.stdout.first_line`.
- Check `runtime_sessions.process_id`, then verify the process with `ps`.

`codex.spawned` appears but no `codex.stdout.first_line`:

- Codex has not emitted JSONL yet.
- If stderr says `Reading additional input from stdin...` and no first line follows, suspect stdin or Codex startup.
- The adapter closes stdin immediately; if this regresses, run `pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter`.

`codex.stdout.first_line` appears but no completion:

- Codex started correctly. The model may be reasoning, running tools, or waiting on a runtime condition.
- Watch `runtime.output`, inspect events, and use the PID to confirm the process is still alive.

Run becomes `timeout`:

- `timeoutSeconds` elapsed before a terminal event.
- Inspect `/events`, `/artifacts`, daemon logs, and the transcript artifact path.

Run is `running` after daemon restart:

- This should be reconciled on startup by the daemon.
- Expected log: `WARN run.reconciled_interrupted runId="run_..."`.

## Verification Commands

```bash
pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/daemon test
pnpm typecheck
pnpm test
pnpm build
```

## Known Good Local Smoke

On 2026-05-14, the fixed adapter was verified with an isolated daemon on port `4546`.

Observed result:

- Run status: `completed`
- Runtime: `codex`
- Model: `gpt-5.5`
- Mode: `exec --json`
- Stdin behavior: Codex printed `Reading additional input from stdin...`, then emitted `codex.stdout.first_line` immediately because the adapter closed stdin.
- Final output: `Switchyard is a TypeScript pnpm monorepo for a deploy-anywhere agent runtime gateway that exposes many agent runtimes and wrappers through one unified backend API.`
