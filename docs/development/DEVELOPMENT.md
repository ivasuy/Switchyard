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

## SDK, CLI, And Contract Smoke

OpenAPI generation/check:

```bash
pnpm --filter @switchyard/contracts openapi:generate
pnpm --filter @switchyard/contracts openapi:check
```

CLI doctor and fake run:

```bash
pnpm --filter @switchyard/cli exec switchyard doctor --base-url http://127.0.0.1:4545
pnpm --filter @switchyard/cli exec switchyard run fake --wait --base-url http://127.0.0.1:4545
pnpm --filter @switchyard/cli exec switchyard runtime test
pnpm --filter @switchyard/cli exec switchyard contract export --output ./openapi.local-daemon.json
```

SDK quick one-liner:

```bash
node --import tsx -e 'import {SwitchyardClient} from \"@switchyard/sdk\"; const c=new SwitchyardClient({baseUrl:\"http://127.0.0.1:4545\"}); const r=await c.health(); console.log(r.ok);'
```

## Runtime Capability Smoke

```bash
BASE=http://127.0.0.1:4545
curl -s "$BASE/runtime-modes" | python3 -m json.tool
curl -s "$BASE/runtime-modes/fake.deterministic" | python3 -m json.tool
curl -s "$BASE/runtime-modes/claude_code.sdk" | python3 -m json.tool
curl -s "$BASE/runtime-modes/codex.exec_json" | python3 -m json.tool
curl -s "$BASE/runtime-modes/agentfield.async_rest" | python3 -m json.tool
curl -s "$BASE/runtime-modes/opencode.acp" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/claude_code.sdk/check" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/codex.exec_json/check" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/agentfield.async_rest/check" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/opencode.acp/check" | python3 -m json.tool
curl -s "$BASE/doctor" | python3 -m json.tool
```

Notes:

- `fake.deterministic` is always locally available.
- `claude_code.sdk` is seeded in R8 and defaults to no-spend checks (`reasonCode: live_probe_disabled`) unless `SWITCHYARD_CLAUDE_CODE_LIVE_PROBE=1`.
- Claude live probe, when enabled, remains bounded by `SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD` and `SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS`.
- `codex.exec_json` is `available` only when both `codex --version` and `codex debug models` succeed with at least one model.
- missing/slow/oversized Codex checks are bounded and reported as sanitized `unavailable`/`unknown`; daemon startup remains up.
- `opencode.acp` check runs `opencode --version`, ACP `initialize`, and ACP `session/new` only.
- Doctor/check does not send ACP `session/prompt`; prompt execution can spend model budget.
- `agentfield.async_rest` check runs bounded AgentField health/discovery probes and does not create executions.

Generic HTTP runtime checks:

- `generic_http.async_rest` is seeded on startup.
- With no `SWITCHYARD_GENERIC_HTTP_BASE_URL`, availability is `unavailable` with reason `generic_http_config_missing`.
- Active checks (`POST /runtime-modes/generic_http.async_rest/check`) use bounded HTTP health probes.

## Generic HTTP Local Smoke

Terminal 1 (fake wrapper):

```bash
pnpm --filter @switchyard/testkit fake-http-runtime -- --host 127.0.0.1 --port 5055
```

Terminal 2 (daemon):

```bash
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-r4-generic-http \
SWITCHYARD_GENERIC_HTTP_BASE_URL=http://127.0.0.1:5055 \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

Smoke calls:

```bash
BASE=http://127.0.0.1:4546
curl -s "$BASE/runtime-modes/generic_http.async_rest" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/generic_http.async_rest/check" | python3 -m json.tool
curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"generic_http","provider":"generic_http","model":"generic-http-default","adapterType":"http","cwd":"/repo","task":"r4 http smoke","timeoutSeconds":30}' \
  | python3 -m json.tool
```

R4 Generic HTTP boundaries:

- No post-start input (`POST /runs/:id/input` returns `409 adapter_protocol_failed`).
- No per-run base URL override; endpoint config is daemon env only.
- No webhooks and no remote artifact URL fetching.

## AgentField Local Smoke

Terminal 1 (fake AgentField):

```bash
pnpm --filter @switchyard/testkit fake-agentfield -- --host 127.0.0.1 --port 5057 --api-key af-local-key
```

Terminal 2 (daemon):

```bash
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-r6-agentfield \
SWITCHYARD_AGENTFIELD_BASE_URL=http://127.0.0.1:5057 \
SWITCHYARD_AGENTFIELD_API_KEY=af-local-key \
SWITCHYARD_AGENTFIELD_TARGET=research-agent.deep_analysis \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

Smoke calls:

```bash
BASE=http://127.0.0.1:4546
curl -s "$BASE/runtime-modes/agentfield.async_rest" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/agentfield.async_rest/check" | python3 -m json.tool
curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"agentfield","provider":"agentfield","model":"agentfield-default","adapterType":"http","cwd":"/repo","task":"r6 agentfield smoke","timeoutSeconds":30}' \
  | python3 -m json.tool
```

R6 AgentField boundaries:

- No post-start input (`POST /runs/:id/input` returns `409 adapter_protocol_failed` with `reasonCode: agentfield_input_unsupported`).
- Active cancel is unsupported (`POST /runs/:id/cancel` returns `409 adapter_protocol_failed` with `reasonCode: agentfield_cancel_unsupported`).
- No per-run base URL/API key/target overrides; endpoint and target config are daemon env only.
- No webhooks and no AgentField control-plane proxying for memory/admin/node lifecycle APIs.

## Claude Code Local Smoke

Claude-specific details live in [Claude Code Adapter Local Development](adapters/CLAUDE_CODE.md).

No-spend smoke:

```bash
BASE=http://127.0.0.1:4545
curl -s "$BASE/runtime-modes/claude_code.sdk" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/claude_code.sdk/check" | python3 -m json.tool
curl -s "$BASE/doctor" | python3 -m json.tool
```

Optional live-probe daemon run (manual, can spend budget):

```bash
SWITCHYARD_CLAUDE_CODE_LIVE_PROBE=1 \
SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD=0.05 \
SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS=5000 \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

R8 Claude boundaries:

- Supports post-start text input and runtime approval bridging.
- Uses bounded transcript persistence (1 MiB raw, 1 MiB normalized, 64 KiB normalized record).
- PTY/TUI automation is not implemented.

## OpenCode ACP Local Smoke

OpenCode-specific details live in [OpenCode ACP Local Development](adapters/OPENCODE.md).

Doctor-only smoke (no prompt spend):

```bash
BASE=http://127.0.0.1:4545
curl -s "$BASE/runtime-modes/opencode.acp" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/opencode.acp/check" | python3 -m json.tool
```

Optional run smoke (can spend model budget due `session/prompt`):

```bash
curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"opencode","provider":"opencode","model":"opencode-default","adapterType":"acpx","cwd":"/repo","task":"Return one short sentence.","timeoutSeconds":30}' \
  | python3 -m json.tool
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

Use the [API contract](API.md#create-run) for the real Codex request body.

## R7 Middleware Smoke

```bash
BASE=http://127.0.0.1:4545

MEMORY_ID=$(curl -s -X POST "$BASE/memory" \
  -H 'content-type: application/json' \
  -d '{"scope":"project","content":"R7 fake_echo is the only executable tool.","metadata":{"source":"r7-smoke"}}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["memory"]["id"])')

EVIDENCE_ID=$(curl -s -X POST "$BASE/evidence" \
  -H 'content-type: application/json' \
  -d '{"sourceType":"manual","title":"Local R7 smoke evidence","snippet":"fake tool path exercised","reliability":"primary"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["evidence"]["id"])')

MESSAGE_ID=$(curl -s -X POST "$BASE/messages" \
  -H 'content-type: application/json' \
  -d '{"channel":"r7-smoke","content":"middleware message"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["message"]["id"])')

curl -s "$BASE/memory/search?q=fake_echo" | python3 -m json.tool

curl -s -X POST "$BASE/context" \
  -H 'content-type: application/json' \
  -d "{\"target\":\"run\",\"memoryIds\":[\"$MEMORY_ID\"],\"evidenceIds\":[\"$EVIDENCE_ID\"],\"messageIds\":[\"$MESSAGE_ID\"]}" \
  | python3 -m json.tool

RUN_ID=$(curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d "{\"runtime\":\"fake\",\"provider\":\"test\",\"model\":\"test-model\",\"adapterType\":\"process\",\"cwd\":\"/repo\",\"task\":\"Use middleware context\",\"context\":{\"memoryIds\":[\"$MEMORY_ID\"],\"evidenceIds\":[\"$EVIDENCE_ID\"],\"messageIds\":[\"$MESSAGE_ID\"]}}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["run"]["id"])')

SAFE=$(curl -s -X POST "$BASE/tools/invocations" \
  -H 'content-type: application/json' \
  -d "{\"runId\":\"$RUN_ID\",\"type\":\"fake_echo\",\"input\":{\"text\":\"hello\"}}")
echo "$SAFE" | python3 -m json.tool

APPROVAL_JSON=$(curl -s -X POST "$BASE/tools/invocations" \
  -H 'content-type: application/json' \
  -d "{\"runId\":\"$RUN_ID\",\"type\":\"fake_echo\",\"input\":{\"text\":\"needs approval\",\"requiresApproval\":true}}")
APPROVAL_ID=$(echo "$APPROVAL_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["approval"]["id"])')
curl -s -X POST "$BASE/approvals/$APPROVAL_ID/approve" -H 'content-type: application/json' -d '{"actor":"local-user","reason":"ok"}' | python3 -m json.tool

curl -s -X POST "$BASE/tools/invocations" \
  -H 'content-type: application/json' \
  -d "{\"runId\":\"$RUN_ID\",\"type\":\"shell\",\"input\":{\"text\":\"echo blocked\"}}" \
  | python3 -m json.tool
```

R7 middleware boundaries:

- Memory search is substring-only and case-insensitive; no vector memory or embedding search.
- Evidence APIs do not fetch remote content.
- Only `fake_echo` executes in R7.
- Known real tools are denied with `tool_policy_denied` before adapter dispatch.
- Context packets persist only under `run.metadata.contextPacket` on run creation with `context`.

## R9 Debate Smoke (No Spend)

```bash
BASE=http://127.0.0.1:4545

EVIDENCE_ID=$(curl -s -X POST "$BASE/evidence" \
  -H 'content-type: application/json' \
  -d '{"sourceType":"manual","title":"Local debate smoke evidence","snippet":"fake debate must stay bounded","reliability":"primary"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["evidence"]["id"])')

DEBATE_ID=$(curl -s -X POST "$BASE/debates?wait=1" \
  -H 'content-type: application/json' \
  -d "{\"topic\":\"Should Switchyard prove fake debate before real runtimes?\",\"participants\":[{\"role\":\"affirmative\",\"runtime\":\"fake\",\"provider\":\"test\",\"model\":\"test-model\",\"adapterType\":\"process\",\"runtimeMode\":\"fake.deterministic\"},{\"role\":\"skeptic\",\"runtime\":\"fake\",\"provider\":\"test\",\"model\":\"test-model\",\"adapterType\":\"process\",\"runtimeMode\":\"fake.deterministic\"}],\"evidenceIds\":[\"$EVIDENCE_ID\"],\"limits\":{\"maxRounds\":2,\"maxTurnsPerAgent\":2,\"maxTotalMessages\":4,\"maxDurationSeconds\":30}}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["debate"]["id"])')

curl -s "$BASE/debates/$DEBATE_ID" | python3 -m json.tool
curl -N "$BASE/debates/$DEBATE_ID/events?live=1&stopAfter=20"
```

Expected:

- Debate reaches terminal fake deterministic state (`no_consensus` by default).
- Exactly two participant seed runs are present in `debate.participants[*].runId`.
- `debate.messageIds`, `debate.eventIds`, `debate.judge`, and `debate.stopReason` are populated.
- Final report artifact metadata is present in inspect output.

## R9 Negative Smoke

Unsupported runtime:

```bash
curl -s -X POST "$BASE/debates?wait=1" \
  -H 'content-type: application/json' \
  -d '{"topic":"bad runtime","participants":[{"role":"affirmative","runtime":"codex"},{"role":"skeptic"}]}'
```

Unknown evidence id:

```bash
curl -s -X POST "$BASE/debates?wait=1" \
  -H 'content-type: application/json' \
  -d '{"topic":"missing evidence","participants":[{"role":"affirmative"},{"role":"skeptic"}],"evidenceIds":["evidence_missing"]}'
```

Early stop on message cap:

```bash
curl -s -X POST "$BASE/debates?wait=1" \
  -H 'content-type: application/json' \
  -d '{"topic":"short debate","participants":[{"role":"affirmative"},{"role":"skeptic"}],"limits":{"maxTotalMessages":1}}' \
  | python3 -m json.tool
```

Expected:

- Unsupported runtime returns `400 invalid_input` with no debate side effects.
- Unknown evidence id returns `404 evidence_not_found` with no debate side effects.
- `maxTotalMessages: 1` returns terminal debate state with one routed message and `stopReason: "max_total_messages"`.

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
pnpm --filter @switchyard/protocol-acpx test
pnpm --filter @switchyard/protocol-acpx typecheck
pnpm --filter @switchyard/testkit test
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/daemon test
```

Full project checks:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

## R10 Hosted/Hybrid No-Spend Smoke

Hosted-like server smoke (`fake.deterministic` only):

```bash
pnpm --filter @switchyard/server dev
curl -s -X POST "http://127.0.0.1:4646/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"fake","provider":"test","model":"test-model","adapterType":"process","runtimeMode":"fake.deterministic","cwd":"/repo","task":"r10 hosted fake smoke","placement":"hosted"}' | python3 -m json.tool
```

Connected-node fake smoke:

```bash
pnpm --filter @switchyard/server dev
SWITCHYARD_SERVER_URL=http://127.0.0.1:4646 pnpm --filter @switchyard/node dev
```

Negative hosted local-runtime denial (Codex/Claude style runtime modes denied in hosted path):

```bash
curl -s -X POST "http://127.0.0.1:4646/runs" \
  -H 'content-type: application/json' \
  -d '{"runtime":"fake","provider":"test","model":"test-model","adapterType":"process","runtimeMode":"codex.exec_json","cwd":"/repo","task":"must deny","placement":"hosted"}' | python3 -m json.tool
```

Expected: `409 placement_denied` (or `400 invalid_input` if runtimeMode mapping is invalid before placement evaluation), and no hosted job execution occurs.

R10 storage/queue scope in this shipped slice:

- Hosted/hybrid verification defaults to deterministic memory substitutes.
- `SWITCHYARD_POSTGRES_URL` opts `apps/server` and `apps/worker` into real Postgres stores.
- `SWITCHYARD_REDIS_URL` opts `apps/server` and `apps/worker` into Redis/BullMQ queueing. `SWITCHYARD_QUEUE_NAME` overrides the queue name.
- `SWITCHYARD_OBJECT_STORE_DIR` opts into durable filesystem-backed object-compatible artifact content storage.
- S3/R2 network object-store client wiring is not shipped in R10.

R10 non-goals reminder:

- No hosted Codex/Claude/OpenCode/PTY/arbitrary subprocess execution.
- No hosted browser/search/repo/GitHub/fetch tooling.
- No hosted debate participant execution or model judging.
