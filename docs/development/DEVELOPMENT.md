# Switchyard Local Development

This guide is for running and debugging Switchyard locally. The README is product-facing; keep operational commands here.

## Guide Map

- Use this file for project-wide setup, daemon startup, health checks, generic curls, database inspection, and verification.
- Use [Codex Adapter Local Development](adapters/CODEX.md) for Codex-specific curls, model metadata, PID checks, and stuck-run debugging.
- Add future adapter guides under `docs/development/adapters/` with one file per adapter.

## Install

```bash
cd /Users/vasuyadav/Downloads/Projects/switchyard
pnpm install
```

## Start The Daemon

Default daemon:

```bash
SWITCHYARD_LOG_LEVEL=info pnpm --filter @switchyard/daemon dev
```

Isolated daemon on another port with temp storage:

```bash
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-local-dev \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

When started with `pnpm --filter @switchyard/daemon dev`, the default data directory is `apps/daemon/.switchyard`.

## Health

```bash
curl -s http://127.0.0.1:4545/health
```

Expected:

```json
{"ok":true}
```

## Fake Runtime Smoke Test

This does not spend model usage:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{
    "runtime": "fake",
    "provider": "test",
    "model": "test-model",
    "adapterType": "process",
    "cwd": "/repo",
    "task": "Test Switchyard locally",
    "timeoutSeconds": 30
  }'
```

Expected status: `completed`. With `wait=1`, the JSON response also includes a `response` object:

```json
{
  "response": {
    "text": "fake runtime output",
    "outputs": [
      {"sequence": 3, "text": "fake runtime output"}
    ]
  }
}
```

## Registry Checks

```bash
curl -s http://127.0.0.1:4545/providers/provider_openai
curl -s http://127.0.0.1:4545/runtimes/runtime_codex
curl -s http://127.0.0.1:4545/models/model_gpt_5_5
```

## Run Inspection

```bash
RUN_ID=run_replace_me
curl -s "http://127.0.0.1:4545/runs/$RUN_ID"
curl -s "http://127.0.0.1:4545/runs/$RUN_ID/events"
curl -s "http://127.0.0.1:4545/runs/$RUN_ID/artifacts"
```

Cancel a run:

```bash
RUN_ID=run_replace_me
curl -s -X POST "http://127.0.0.1:4545/runs/$RUN_ID/cancel"
```

## Event Streaming Behavior

`POST /runs?wait=1` is not streamed. It waits for the run to finish and returns one final JSON response with `run` metadata and `response.text`.

`response.text` is the last normalized `runtime.output` text. `response.outputs` contains every normalized output event in order with its event sequence.

`GET /runs/:id/events` returns Server-Sent Events formatted output. Today it is primarily an SSE-compatible event replay. `live=1&stopAfter=N` can include bounded live events, but it is not yet an open-ended streaming connection.

Bounded live event capture:

```bash
RUN_ID=run_replace_me
curl -N "http://127.0.0.1:4545/runs/$RUN_ID/events?live=1&stopAfter=20"
```

For now, if you want to watch progress from curl, create the run asynchronously and poll/re-run the events request:

```bash
RUN_ID=run_replace_me
watch -n 1 "curl -s http://127.0.0.1:4545/runs/$RUN_ID/events"
```

Codex responses appear in the wait response under `response.text` and in the event log as `runtime.output` events. Completed runs also expose the raw transcript artifact through `/runs/:id/artifacts`.

## SQLite Inspection

Default database:

```bash
DB=apps/daemon/.switchyard/switchyard.sqlite
```

Recent runs:

```bash
sqlite3 "$DB" "select id,runtime,provider,model,status,cwd,substr(task,1,80),created_at,started_at,ended_at from runs order by created_at desc limit 10;"
```

Session and process PID:

```bash
RUN_ID=run_replace_me
sqlite3 "$DB" "select id,run_id,status,process_id,created_at,updated_at from runtime_sessions where run_id='$RUN_ID';"
```

Events:

```bash
RUN_ID=run_replace_me
sqlite3 "$DB" "select sequence,type,payload_json,created_at from run_events where run_id='$RUN_ID' order by sequence;"
```

Artifacts:

```bash
RUN_ID=run_replace_me
sqlite3 "$DB" "select id,type,path,metadata_json,created_at from artifacts where run_id='$RUN_ID';"
```

## Process Checks

```bash
ps -ax -o pid,ppid,stat,etime,command | rg 'codex exec --json|node --disable-warning=DEP0205 --import tsx src/main.ts'
```

## Adapter Debugging

Use adapter-specific guides for model-running curl requests, healthy log shape, stuck-state diagnosis, and runtime-specific notes:

- [Codex Adapter Local Development](adapters/CODEX.md)

## Verification

```bash
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test
pnpm test
pnpm typecheck
pnpm build
```
