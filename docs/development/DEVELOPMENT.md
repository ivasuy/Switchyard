# Local Development

This guide is for running and debugging Switchyard locally. For endpoint request and response shapes, use the [Official API Contract](API.md).

## Install

```bash
cd /Users/vasuyadav/Downloads/Projects/switchyard
pnpm install
```

## Start The Daemon

Default local daemon:

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

Default local data directory when using the daemon package script:

```text
apps/daemon/.switchyard
```

## Health Check

```bash
curl -s http://127.0.0.1:4545/health
```

Expected:

```json
{"ok":true}
```

## Quick Smoke

Use the fake runtime first when you only want to verify daemon routing:

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

Expected:

```json
{
  "run": {"status": "completed"},
  "response": {
    "text": "fake runtime output",
    "outputs": [
      {"sequence": 3, "text": "fake runtime output"}
    ]
  }
}
```

Use the [API contract](API.md#create-and-wait) for the real Codex request body.

## Inspect A Run

```bash
RUN_ID=run_replace_me
curl -s "http://127.0.0.1:4545/runs/$RUN_ID"
curl -s "http://127.0.0.1:4545/runs/$RUN_ID/events"
curl -s "http://127.0.0.1:4545/runs/$RUN_ID/artifacts"
```

For the official response shapes, see [Get Run](API.md#get-run), [Get Run Events](API.md#get-run-events), and [Get Run Artifacts](API.md#get-run-artifacts).

## Watch Events From Curl

`POST /runs?wait=1` returns one final JSON response; it does not stream.

For a bounded SSE-formatted event capture:

```bash
RUN_ID=run_replace_me
curl -N "http://127.0.0.1:4545/runs/$RUN_ID/events?live=1&stopAfter=20"
```

For local polling:

```bash
RUN_ID=run_replace_me
watch -n 1 "curl -s http://127.0.0.1:4545/runs/$RUN_ID/events"
```

## Local Smoke Walkthrough

Copy-paste these commands against a fresh `pnpm dev:daemon` instance. Each step asserts relative changes, so the walkthrough works regardless of pre-existing local state.

```bash
BASE=http://127.0.0.1:4545

BEFORE=$(curl -s "$BASE/runs?limit=200" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["runs"]))')

RUN_ID=$(curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"fake","provider":"test","model":"test-model","adapterType":"process","cwd":"/repo","task":"smoke"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["run"]["id"])')

AFTER=$(curl -s "$BASE/runs?limit=200" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["runs"]))')
test "$AFTER" -eq "$((BEFORE + 1))" && echo "list grew by 1: ok"

curl -s "$BASE/providers"        | head -c 200; echo
curl -s "$BASE/runtimes"         | head -c 200; echo
curl -s "$BASE/models?provider=test" | head -c 200; echo

ARTIFACT_ID=$(curl -s "$BASE/runs/$RUN_ID/artifacts" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["artifacts"][0]["id"])')

curl -s "$BASE/artifacts/$ARTIFACT_ID"           | head -c 200; echo
curl -s -i "$BASE/artifacts/$ARTIFACT_ID/content" | head -n 6

# Error envelope retrofit checks
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/runs/run_missing_id"
curl -s "$BASE/runs?status=banana"                # 400 invalid_query, details[0].path = "status"
curl -s "$BASE/artifacts/artifact_missing/content" # 404 artifact_not_found

# Open-ended SSE. Ctrl-C closes the stream; the server unsubscribes within 1s.
curl -N "$BASE/runs/$RUN_ID/events?live=1"
# Bounded for tests / scripted assertions:
curl -N "$BASE/runs/$RUN_ID/events?live=1&stopAfter=20"
```

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

Find daemon and Codex child processes:

```bash
ps -ax -o pid,ppid,stat,etime,command | rg 'codex exec --json|node --disable-warning=DEP0205 --import tsx src/main.ts'
```

Codex-specific stuck-state interpretation lives in [Codex Adapter Local Development](adapters/CODEX.md).

## Verification

Focused docs-safe checks:

```bash
git diff --check
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test
```

Full project checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```
