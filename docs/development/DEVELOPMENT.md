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

## R22 No-Spend Verification (Copy/Paste)

These required checks are deterministic and no-spend. They must not call payment providers, model providers, AWS/R2 live services, live GitHub, external search, hosted browsers, or arbitrary process/PTY execution.

```bash
pnpm --filter @switchyard/daemon test -- smoke
pnpm --filter @switchyard/sdk test -- client
pnpm --filter @switchyard/cli test -- run-cli
pnpm production:sandbox-smoke
pnpm hosted-real-runtime:smoke
pnpm exec vitest run scripts/production-sandbox-smoke.test.ts
pnpm exec vitest run deploy/production/production-manifest.test.ts scripts/production-preflight.test.ts scripts/production-migrate.test.ts scripts/production-canary.test.ts
pnpm --filter @switchyard/contracts openapi:check
pnpm --filter @switchyard/contracts openapi:check:hosted
pnpm typecheck
git diff --check
```

Hosted OpenAPI regeneration/check (run only when hosted contract/docs output changes):

```bash
pnpm --filter @switchyard/contracts openapi:generate:hosted
pnpm --filter @switchyard/contracts openapi:check:hosted
```

## R23 Production Operator Commands

Preflight (required before deploy):

```bash
pnpm production:preflight -- --env-file deploy/production/.env --manifest deploy/production/manifest.json --include-node
```

Migrate (required before traffic):

```bash
pnpm production:migrate -- --env-file deploy/production/.env
```

Canary (required after server+worker are healthy):

```bash
pnpm production:canary -- --base-url https://replace-with-public-server-url --api-key replace-with-operator-api-key --timeout-ms 30000
```

Canary supports `SWITCHYARD_CANARY_API_KEY` as an alternative to `--api-key`.
For optional live external-tool probes use the spend-gated canary command with explicit env + flag confirmation:

```bash
SWITCHYARD_CONFIRM_LIVE_TOOL_CANARY=1 pnpm production:live-tool-canary
```

Optional live hosted-provider bridge probes are explicitly spend-gated and skipped by default:

```bash
SWITCHYARD_CONFIRM_LIVE_PROVIDER_BRIDGE_CANARY=1 pnpm production:canary -- --base-url https://replace-with-public-server-url --api-key replace-with-operator-api-key --live-provider-bridges --confirm-live-provider-spend
```

Sandbox smoke (required before enabling worker claims in production posture):

```bash
pnpm production:sandbox-smoke
```

Safe default sandbox env posture (required unless an operator intentionally enables real execution with policy):

- `SWITCHYARD_SANDBOX_REAL_EXECUTION=disabled`
- `SWITCHYARD_SANDBOX_COMMAND_POLICY_JSON` unset when real execution is disabled.
- If `SWITCHYARD_SANDBOX_REAL_EXECUTION=enabled`, `SWITCHYARD_SANDBOX_COMMAND_POLICY_JSON` must be present and valid or readiness fails closed (`sandbox_policy_missing`/`sandbox_policy_invalid`).

## R23 Hosted Rollout / Rollback

Rollout order (required):

1. Build/publish server, worker, and optional node images with compiled `dist` entrypoints.
2. Copy `deploy/production/.env.example` to `deploy/production/.env` and replace every `replace-with-*` placeholder.
3. Prepare bootstrap JSON from `deploy/production/bootstrap.example.json` and mount it to `SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH`.
4. Run `pnpm production:preflight -- --env-file deploy/production/.env --manifest deploy/production/manifest.json --include-node`.
5. Run `pnpm production:migrate -- --env-file deploy/production/.env`.
6. Deploy server, wait for `GET /health`, then verify `GET /ready`.
7. Deploy worker only after readiness is green.
8. Run `pnpm production:canary -- --base-url https://replace-with-public-server-url --api-key replace-with-operator-api-key`.

Fail-closed production behavior:

- Startup/readiness fails if auth/bootstrap/store/schema/runtime-gate requirements are unsafe.
- `GET /ready` is public and reports named machine codes under `checks.*` (including `checks.schema` diagnostics).
- `GET /metrics` is protected and requires API key auth with both `metrics:read` and `admin:read`.
- `SWITCHYARD_PUBLIC_METRICS=1` is forbidden in staging/production.
- Fake-only remains default (`SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic`, `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled`).
- Real tools remain disabled by default (`SWITCHYARD_HOSTED_REAL_TOOLS=disabled`, `SWITCHYARD_CONNECTED_NODE_REAL_TOOLS=disabled`, `SWITCHYARD_TOOL_ADAPTER_MODE=fake`).
- Production hosted provider activation is operator opt-in only for known provider modes (`codex.exec_json`, `claude_code.sdk`, `opencode.acp`) and requires provider policy, credential presence, and spend controls.
- Hosted runtime input/approval bridges for `claude_code.sdk` and `opencode.acp` require shared Postgres-backed hosted runtime bridge command and payload stores for server-to-worker handoff.
- Worker crash/stale claimed provider-input commands fail closed with `hosted_runtime_bridge_non_idempotent_retry_blocked` instead of blindly retrying provider input.
- Production hosted/connected-node tool activation is operator opt-in and requires explicit real-tool policy plus API-key auth, Postgres, Redis, object store, quota/audit readiness, worker claim readiness, and node readiness for connected-node tool placements.

R23 non-goals reminder:

- No managed SaaS/public signup, payments/webhooks, OAuth/OIDC/SAML/SSO/SCIM, dashboard, or TUI setup is shipped here.
- does not ship generic process/pty runtime adapters.
- does not ship cursor/openclaw/paperclip.
- does not ship hosted browser automation.
- does not ship hosted `repo` execution.
- does not ship hosted debate real participants or hosted model judging.
- hosted bridges remain unshipped for `codex.exec_json`, `codex.interactive`, `agentfield.async_rest`, and `generic_http.async_rest`.
- hosted `codex.interactive` remains local-only and unshipped.
- hosted live-resume guarantees are not shipped.
- does not ship hosted terminal bridge.
- No public `/exec`/`/sandbox`/`/terminal`/`/pty`/`/shell`/`/process`/`/command` routes are shipped here.
- R22 shipped real tools are exact-only: hosted worker `fetch/web_search/github/shell` and connected-node `fetch/web_search/github/repo/shell`.

R21 historical non-goal wording (kept for compatibility with previous release checks):

- does not ship generic process/pty runtime adapters.
- does not ship cursor/openclaw/paperclip.
- does not ship hosted browser/search/github/fetch/repo tools.
- does not ship hosted debate real participants or hosted model judging.
- does not ship hosted approval bridge, hosted input bridge, or hosted terminal bridge.

Rollback order:

1. Pause worker claims first (example with compose):
   - `docker compose -f deploy/production/docker-compose.yml stop worker`
2. Roll server back to the last known-good image.
3. Re-check readiness; if `checks.schema.code=postgres_schema_version_unsupported` or `postgres_schema_migration_required`, keep traffic blocked until compatible code is restored.
4. Roll worker back after server readiness is green.
5. Re-run canary and keep evidence.
6. To return to fake-only posture: set `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled`, set allowlist to `fake.deterministic`, restart server and worker, then rerun no-spend smoke.

Queue inspection while workers are paused:

```bash
BASE=https://replace-with-public-server-url
API_KEY=replace-with-operator-api-key
curl -s -H "Authorization: Bearer $API_KEY" -H "x-switchyard-api-key: $API_KEY" "$BASE/metrics" | python3 -m json.tool
curl -s -H "Authorization: Bearer $API_KEY" -H "x-switchyard-api-key: $API_KEY" "$BASE/runs?status=queued&limit=50" | python3 -m json.tool
curl -s -H "Authorization: Bearer $API_KEY" -H "x-switchyard-api-key: $API_KEY" "$BASE/runs?status=running&limit=50" | python3 -m json.tool
```

Canary evidence retention:

- Keep canary run/audit/artifact records as rollback and compliance evidence.
- Keep the `runId` returned by `production:canary` and use:
  - `GET /runs/:id`
  - `GET /runs/:id/events`
  - `GET /runs/:id/artifacts`
  - `GET /audit/events?limit=50` (and match the canary metadata in event payloads)

Optional live dependency checks:

- Optional live checks against operator-managed Postgres/Redis/object stores are operator-owned.
- Optional live checks are not required in CI/audit and must stay outside deterministic no-spend required verification.

## Runtime Capability Smoke

```bash
BASE=http://127.0.0.1:4545
curl -s "$BASE/runtime-modes" | python3 -m json.tool
curl -s "$BASE/runtime-modes/fake.deterministic" | python3 -m json.tool
curl -s "$BASE/runtime-modes/claude_code.sdk" | python3 -m json.tool
curl -s "$BASE/runtime-modes/codex.exec_json" | python3 -m json.tool
curl -s "$BASE/runtime-modes/codex.interactive" | python3 -m json.tool
curl -s "$BASE/runtime-modes/agentfield.async_rest" | python3 -m json.tool
curl -s "$BASE/runtime-modes/opencode.acp" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/claude_code.sdk/check" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/codex.exec_json/check" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/codex.interactive/check" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/agentfield.async_rest/check" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/opencode.acp/check" | python3 -m json.tool
curl -s "$BASE/doctor" | python3 -m json.tool
```

Notes:

- `fake.deterministic` is always locally available.
- `claude_code.sdk` is seeded in R8 and defaults to no-spend checks (`reasonCode: live_probe_disabled`) unless `SWITCHYARD_CLAUDE_CODE_LIVE_PROBE=1`.
- Claude live probe, when enabled, remains bounded by `SWITCHYARD_CLAUDE_CODE_MAX_BUDGET_USD` and `SWITCHYARD_CLAUDE_CODE_REQUEST_TIMEOUT_MS`.
- `codex.exec_json` is `available` only when both `codex --version` and `codex debug models` succeed with at least one model.
- `codex.interactive` check is no-spend by default; it validates command-shape support (`codex exec --help` + `codex exec resume --help`) and reports `resumeCommandShapeAvailable` separately from `liveResumeVerified`.
- Default no-spend doctor/check output must not be interpreted as live resume success. `liveResumeVerified` remains `false` unless a separate optional manual/live probe is explicitly run.
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

## Codex Interactive No-Spend Smoke

Use deterministic fake-backed smoke first:

```bash
pnpm --filter @switchyard/daemon test -- smoke
pnpm --filter @switchyard/adapters test -- codex-interactive-adapter
pnpm --filter @switchyard/testkit test -- fake-codex-interactive-session
```

Live daemon capability smoke (no prompt execution by default):

```bash
BASE=http://127.0.0.1:4545
curl -s "$BASE/runtime-modes/codex.interactive" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/codex.interactive/check" | python3 -m json.tool
curl -s "$BASE/doctor" | python3 -m json.tool
```

R16 Codex interactive boundaries:

- `codex.interactive` is explicit-only; omitted Codex mode remains `codex.exec_json`.
- `POST /runs?wait=1` with `runtimeMode: "codex.interactive"` is rejected (`interactive_wait_unsupported`).
- Hosted interactive create/input/approval bridges are not shipped.
- No PTY/TUI/terminal automation is shipped.

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

## R17 Middleware + Real Tool Smoke (No Spend)

Use deterministic tests first (no external spend, fake clients/factories only):

```bash
pnpm --filter @switchyard/contracts test -- contracts
pnpm --filter @switchyard/core test -- real-tool-policy
pnpm --filter @switchyard/core test -- real-tool-router
pnpm --filter @switchyard/adapters test -- real-tool-adapters
pnpm --filter @switchyard/daemon test -- hardening
pnpm --filter @switchyard/daemon test -- smoke
```

Run daemon with real tools disabled (default deny path):

```bash
SWITCHYARD_LOG_LEVEL=info pnpm --filter @switchyard/daemon dev
```

Run daemon with a local-only no-spend real-tool setup (command-catalog shell + allowlisted local fetch target):

```bash
cat > /tmp/switchyard-shell-catalog.json <<'JSON'
{
  "commands": [
    {
      "commandId": "local.date.utc",
      "executablePath": "/bin/date",
      "argv": ["-u"],
      "allowedCwdPrefixes": ["/repo"],
      "env": {"TZ": "UTC"},
      "maxArgs": 2
    }
  ]
}
JSON

SWITCHYARD_REAL_TOOLS_ENABLED=1 \
SWITCHYARD_REAL_TOOLS_APPROVAL_DEFAULT=required \
SWITCHYARD_FETCH_TOOL_ENABLED=1 \
SWITCHYARD_FETCH_ALLOW_HOSTS=127.0.0.1,localhost \
SWITCHYARD_FETCH_ALLOW_METHODS=GET,HEAD \
SWITCHYARD_FETCH_ALLOW_CONTENT_TYPES=text/plain,application/json \
SWITCHYARD_WEB_SEARCH_TOOL_ENABLED=0 \
SWITCHYARD_GITHUB_TOOL_ENABLED=0 \
SWITCHYARD_REPO_TOOL_ENABLED=0 \
SWITCHYARD_SHELL_TOOL_ENABLED=1 \
SWITCHYARD_SHELL_COMMAND_CATALOG_PATH=/tmp/switchyard-shell-catalog.json \
SWITCHYARD_SHELL_ALLOW_CWD_PREFIXES=/repo \
pnpm --filter @switchyard/daemon dev
```

Tool policy env matrix (local daemon):

- Global: `SWITCHYARD_REAL_TOOLS_ENABLED`, `SWITCHYARD_REAL_TOOLS_ALLOWED_PLACEMENTS`, `SWITCHYARD_REAL_TOOLS_APPROVAL_DEFAULT`, `SWITCHYARD_REAL_TOOLS_APPROVAL_EXPIRES_MS`, `SWITCHYARD_REAL_TOOLS_MAX_CONCURRENT`, `SWITCHYARD_REAL_TOOLS_MAX_INPUT_BYTES`, `SWITCHYARD_REAL_TOOLS_MAX_INLINE_OUTPUT_BYTES`, `SWITCHYARD_REAL_TOOLS_MAX_ARTIFACT_BYTES`, `SWITCHYARD_REAL_TOOLS_DEFAULT_TIMEOUT_MS`.
- Fetch: `SWITCHYARD_FETCH_TOOL_ENABLED`, `SWITCHYARD_FETCH_ALLOW_HOSTS`, `SWITCHYARD_FETCH_ALLOW_METHODS`, `SWITCHYARD_FETCH_ALLOW_CONTENT_TYPES`, `SWITCHYARD_FETCH_ALLOW_HEADERS`, `SWITCHYARD_FETCH_MAX_REDIRECTS`, `SWITCHYARD_FETCH_TIMEOUT_MS`, `SWITCHYARD_FETCH_MAX_RESPONSE_BYTES`.
- Web search: `SWITCHYARD_WEB_SEARCH_TOOL_ENABLED`, `SWITCHYARD_WEB_SEARCH_PROVIDER`, `SWITCHYARD_WEB_SEARCH_BASE_URL`, `SWITCHYARD_WEB_SEARCH_MAX_RESULTS`, `SWITCHYARD_WEB_SEARCH_TIMEOUT_MS`, `SWITCHYARD_WEB_SEARCH_MAX_RESPONSE_BYTES`.
- GitHub: `SWITCHYARD_GITHUB_TOOL_ENABLED`, `SWITCHYARD_GITHUB_TOKEN`, `SWITCHYARD_GITHUB_ALLOW_REPOS`, `SWITCHYARD_GITHUB_TIMEOUT_MS`, `SWITCHYARD_GITHUB_MAX_RESPONSE_BYTES`.
- Repo: `SWITCHYARD_REPO_TOOL_ENABLED`, `SWITCHYARD_REPO_GIT_BINARY`, `SWITCHYARD_REPO_ALLOW_CWD_PREFIXES`, `SWITCHYARD_REPO_MAX_PATHS`, `SWITCHYARD_REPO_TIMEOUT_MS`, `SWITCHYARD_REPO_MAX_OUTPUT_BYTES`.
- Shell: `SWITCHYARD_SHELL_TOOL_ENABLED`, `SWITCHYARD_SHELL_COMMAND_CATALOG_PATH`, `SWITCHYARD_SHELL_ALLOW_CWD_PREFIXES`, `SWITCHYARD_SHELL_TIMEOUT_MS`, `SWITCHYARD_SHELL_MAX_OUTPUT_BYTES`.

Request/approval smoke:

```bash
BASE=http://127.0.0.1:4545

RUN_ID=$(curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"fake","provider":"test","model":"test-model","adapterType":"process","cwd":"/repo","task":"r17 tool smoke"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["run"]["id"])')

# Deterministic safe path
curl -s -X POST "$BASE/tools/invocations" \
  -H 'content-type: application/json' \
  -d "{\"runId\":\"$RUN_ID\",\"type\":\"fake_echo\",\"input\":{\"text\":\"hello\"}}" \
  | python3 -m json.tool

# Real tool path queues approval by default
APPROVAL_JSON=$(curl -s -X POST "$BASE/tools/invocations" \
  -H 'content-type: application/json' \
  -d "{\"runId\":\"$RUN_ID\",\"type\":\"shell\",\"input\":{\"commandId\":\"local.date.utc\",\"cwd\":\"/repo\"}}")

echo "$APPROVAL_JSON" | python3 -m json.tool
APPROVAL_ID=$(echo "$APPROVAL_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["approval"]["id"])')

curl -s -X POST "$BASE/approvals/$APPROVAL_ID/approve" \
  -H 'content-type: application/json' \
  -d '{"actor":"local-user","reason":"r17 smoke"}' \
  | python3 -m json.tool
```

R17 middleware and tool boundaries:

- Memory search remains substring-only/case-insensitive (`GET /memory/search`); no vector memory search is shipped.
- Evidence APIs do not fetch remote content.
- Real tools are local-daemon only and deny-by-default until explicitly configured.
- Real tools are approval-by-default (`before_external_web_action` for web actions, `before_local_process_execution` for repo/shell).
- Shell tool is command-catalog only (`commandId`); raw command strings are rejected.
- Browser tool is known but unshipped and denied by policy.
- R22 ships hosted worker real tools (`fetch`, `web_search`, `github`, command-catalog `shell`) and connected-node real tools (`fetch`, `web_search`, `github`, `repo`, command-catalog `shell`) with policy/approval-first controls.
- Browser automation and hosted `repo` execution remain unshipped and denied (`browser_tool_unshipped`, `repo_hosted_unshipped`).
- Public `/sandbox`/`/exec`/`/pty`/`/terminal`/`/process`/`/shell`/`/command`/`/browser` routes and top-level tool-search execution routes remain unshipped.

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

R15 hosted real-runtime opt-in envs (self-hosted/staging only):

```bash
export SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST="fake.deterministic,codex.exec_json,claude_code.sdk,opencode.acp"
export SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled
```

Gate-disabled denial example (must reject before queue side effects):

```bash
curl -s -X POST "http://127.0.0.1:4646/runs" \
  -H 'content-type: application/json' \
  -d '{"runtime":"codex","provider":"openai","model":"gpt-5","adapterType":"process","runtimeMode":"codex.exec_json","cwd":"/repo","task":"must deny","placement":"hosted"}' | python3 -m json.tool
```

Expected with gate disabled: `409 placement_denied` detail `hosted_real_runtime_disabled`, and no hosted job execution occurs.

R14 hosted sandbox substrate smoke (fake/no-spend only):

```bash
pnpm sandbox:smoke
```

Expected: deterministic fake command allow path, real-command deny path, timeout terminalization, cancellation idempotency, transcript redaction, readiness check success, and sandbox metrics counter increments. No real subprocess/PTY/shell execution occurs in this smoke.

R15 hosted real-runtime no-spend smoke:

```bash
pnpm hosted-real-runtime:smoke
```

Expected: fake-factory hosted completion for Codex/Claude/OpenCode, one denied gate-disabled request with no queue side effects, one unsupported interaction that fails visibly (no waiting-state leak), and artifact content retrieval through existing artifact routes.

R10 storage/queue scope in this shipped slice:

- Hosted/hybrid verification defaults to deterministic memory substitutes.
- `SWITCHYARD_POSTGRES_URL` opts `apps/server` and `apps/worker` into real Postgres stores.
- `SWITCHYARD_REDIS_URL` opts `apps/server` and `apps/worker` into Redis/BullMQ queueing. `SWITCHYARD_QUEUE_NAME` overrides the queue name.
- `SWITCHYARD_OBJECT_STORE_BACKEND` selects `memory`, `local`, or `s3-compatible`.
- `SWITCHYARD_OBJECT_STORE_DIR` is required when backend is `local`.
- S3/R2-compatible artifact storage is shipped in R13 using explicit endpoint/region/bucket/static credential env vars (`SWITCHYARD_OBJECT_STORE_ENDPOINT`, `SWITCHYARD_OBJECT_STORE_REGION`, `SWITCHYARD_OBJECT_STORE_BUCKET`, `SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID`, `SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY`).

R15 non-goals reminder:

- No managed hosted platform or production hosted real-runtime support.
- No hosted arbitrary subprocess/PTY execution beyond the closed catalog modes above.
- No hosted browser/search/repo/GitHub/fetch tooling.
- No public `/sandbox`, `/exec`, `/pty`, or `/terminal` execution API.
- No hosted interactive Codex session bridge, hosted post-start input bridge, or hosted approval bridge.
- No hosted debate participant execution or model judging.

R13 object-store smoke posture:

- Required CI tests stay no-spend and use fake/in-memory seams only.
- Optional live S3/R2/MinIO smoke is operator-owned and never part of required checks.

R15 rollback and runbook:

- Disable hosted real runtime gate: set `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled`, restart server and worker, then verify `/ready` reports `checks.hostedRuntimeGate.code=hosted_real_runtime_disabled` when real modes remain allowlisted.
- Remove real modes from allowlist: set `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic`, restart server and worker, and verify hosted real create requests return `409 placement_denied`.
- Already-queued real hosted jobs fail closed at worker claim revalidation if gate/allowlist drift occurs before claim.
- Alert on `hostedRuntime.denied`, adapter start failures, run timeouts, unsupported interactions, object-store failures, and queue retry exhaustion.
