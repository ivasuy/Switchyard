# Official API Contract

This document covers the shipped API surfaces:

- Local daemon (`local_daemon` OpenAPI surface): no-auth by default, local-first runtime/middleware contract.
- Hosted server (`hosted_server` OpenAPI surface): API-key-authenticated enterprise control-plane foundation for tenant/project ownership, entitlements/quotas, and audit events.

R22 scope note: hosted and connected-node real-tool execution is now shipped for the exact R22 boundary:

- hosted worker: `fetch`, `web_search`, `github`, command-catalog `shell`
- connected node: `fetch`, `web_search`, `github`, `repo`, command-catalog `shell`

Fake/no-spend remains the default posture for required tests, smoke, preflight, and default canary.

R19 scope note: production hosted deployment readiness is shipped for the existing safe hosted boundary. This release is API/ops-first (manifests, preflight/migrate/canary, readiness/schema codes, rollback posture), not a managed SaaS launch.

R20 boundary note: production subprocess/PTY sandboxing is an internal hosted-worker substrate only. There is still no public arbitrary execution API on either local or hosted surfaces: no `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` route exists.

R24/R25 hosted boundary note:

- does not ship generic process/pty runtime adapters.
- does not ship cursor/openclaw/paperclip.
- does not ship hosted browser automation.
- does not ship hosted `repo` execution.
- hosted/server-safe debate ships only through `POST /debates`, `GET /debates/:id`, and `GET /debates/:id/events`.
- fake deterministic hosted debate is the default no-spend path.
- opt-in local/hosted debate participant runs are allowed only for `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, `opencode.acp`, `agentfield.async_rest`, and `generic_http.async_rest`.
- live model judging is internal to `POST /debates` and requires request opt-in plus `confirmLiveProviderSpend: true`; no public model judge route is shipped.
- wrapper hosted debate participants require hosted placement, `realRuntimeOptIn`, provider activation/spend gates, wrapper config/capability checks, bridge readiness, durable command/payload stores, queue/outbox, object store, ownership, quota, audit, and worker readiness.
- does not ship hosted `codex.interactive`, hosted terminal bridge, public model judge routes, dashboard/TUI, managed SaaS, billing, OAuth, SSO, or SCIM.

## R19 Production Hosted Deployment Readiness

Shipped hosted/server production-readiness capabilities:

- `SWITCHYARD_SERVER_AUTH_MODE=api_key` for hosted protected routes.
- `SWITCHYARD_API_KEY_PEPPER` hashing requirement in staging/production.
- `SWITCHYARD_CONTROL_PLANE_STORE=postgres` requirement in staging/production (`memory` remains local/test-only).
- `SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH` or bootstrap JSON env requirement before staging/production startup.
- Tenant/project ownership checks plus entitlement/quota contracts before hosted side effects.
- `GET /auth/whoami`, `GET /entitlements`, and `GET /audit/events` on hosted surface.
- Hosted `/metrics` requires authenticated operator/admin scope (`metrics:read` plus `admin:read`); `/health` and `/ready` remain public on hosted surface.
- Production preflight command (`pnpm production:preflight -- --env-file <path>`) validates env/manifest/config/schema/queue/object-store/control-plane/runtime-gate posture with redacted diagnostics.
- Production migration command (`pnpm production:migrate -- --env-file <path>`) runs additive Postgres schema migration with named status codes.
- Production canary command (`pnpm production:canary -- --base-url <https-url> --api-key <key>`) now defaults to authenticated ready/debate/events/artifacts/metrics/audit on fake deterministic hosted debate (`fake.deterministic`), with live debate probes skipped unless spend is explicitly confirmed.
- Production hosted real-runtime execution remains forbidden in R19.

Named production readiness and migration codes used by `/ready` and production operator workflows:

- `postgres_schema_ready`
- `postgres_schema_migration_required`
- `postgres_schema_version_unsupported`
- `postgres_unavailable`
- `queue_unavailable`
- `object_store_unavailable`
- `object_store_auth_failed`
- `object_store_bucket_not_found`
- `hosted_runtime_gate_failed`
- `hosted_real_runtime_production_forbidden`

Named production canary result codes:

- `canary_ok`
- `auth_required`
- `auth_invalid`
- `invalid_base_url`
- `ready_denied`
- `run_create_denied`
- `worker_timeout`
- `unexpected_terminal_status`
- `artifact_missing`
- `artifact_content_empty`
- `artifact_digest_mismatch`
- `metrics_auth_failed`
- `audit_lookup_failed`
- `malformed_response`
- `malformed_sse`

Local compatibility remains explicit:

- Local daemon defaults remain no-auth.
- Local OpenAPI (`local_daemon` surface) does not require `SwitchyardApiKey`.
- Local fake runs, SDK flows, CLI flows, and local real-tool policy behavior stay backwards compatible.
- `SWITCHYARD_PUBLIC_METRICS=1` remains forbidden in staging/production hosted posture.

OpenAPI commands:

```bash
pnpm --filter @switchyard/contracts openapi:generate
pnpm --filter @switchyard/contracts openapi:check
pnpm --filter @switchyard/contracts openapi:generate:hosted
pnpm --filter @switchyard/contracts openapi:check:hosted
```

## R10-R15 Hosted And Hybrid Execution (Safe Slice)

R10 adds hosted-like and connected-node execution surfaces while preserving the public run contract shape (`POST /runs`, `GET /runs`, `GET /runs/:id`, events/artifacts/cancel).

Safety boundaries in this shipped slice:

- Hosted worker execution defaults to `fake.deterministic`.
- R15 adds operator opt-in self-hosted/staging hosted worker execution for `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` when both `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` includes the mode and `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`.
- Hosted worker revalidates queue payload and durable run rows before adapter start (placement/status/runtime/provider/adapterType/runtimeMode/gate/allowlist/safety metadata).
- Production hosted real-runtime execution is forbidden in R15 and must fail closed at config/readiness/claim validation.
- R14 adds a hosted sandbox substrate that is internal-only and fake/no-spend (`switchyard.fake.*` command ids only); it is not a public execution API.
- In the R10-R15 safe slice, no hosted arbitrary subprocess/PTY execution, public sandbox execution route, hosted browser/search/repo/GitHub/fetch tooling, hosted debate participant execution, or model judging was shipped. R24 supersedes the debate item only through the existing `/debates` route family described below; public model judge routes remain unshipped.

R14 diagnostics additions:

- `GET /ready` includes `checks.sandbox` with `ok=true` or one of `sandbox_disabled`, `sandbox_policy_invalid`, or `sandbox_config_invalid`.
- `GET /metrics` includes low-cardinality `sandbox` counters (`jobs`, `allowed`, `denied`, `completed`, `failed`, `timeout`, `cancelled`, `outputTruncated`, `artifactTruncated`, `redactions`).
- There is still no public `/sandbox`, `/exec`, `/shell`, `/process`, `/command`, `/pty`, or `/terminal` route.

R15 diagnostics additions:

- `GET /ready` includes `checks.hostedRuntimeGate` with `ok=true` or one of `hosted_real_runtime_disabled`, `hosted_real_runtime_production_forbidden`, or `config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION`.
- `GET /metrics` includes low-cardinality `hostedRuntime` counters: `accepted`, `denied`, `started`, `completed`, `failed`, `timeout`, `unsupportedInteraction`, and `artifactPersisted`.

Node endpoints added in R10:

- `POST /nodes/register`
- `POST /nodes/:id/heartbeat`
- `GET /nodes`
- `GET /nodes/:id`
- `POST /nodes/:id/assignments/claim`
- `POST /nodes/:id/assignments/:assignmentId/reject`
- `POST /nodes/:id/assignments/:assignmentId/events`
- `POST /nodes/:id/assignments/:assignmentId/artifacts/manifest`
- `PUT /nodes/:id/assignments/:assignmentId/artifacts/:artifactId/content`
- `POST /nodes/:id/assignments/:assignmentId/complete`

When `SWITCHYARD_NODE_SHARED_TOKEN` is set, every `/nodes/*` route requires `x-switchyard-node-token`.

Hosted app infrastructure defaults to deterministic memory substitutes in local/test. `SWITCHYARD_POSTGRES_URL` opts into real Postgres stores, `SWITCHYARD_REDIS_URL` opts into Redis/BullMQ queueing, `SWITCHYARD_QUEUE_NAME` overrides the queue name, and object-store behavior is selected through:

- `SWITCHYARD_OBJECT_STORE_BACKEND=memory|local|s3-compatible`
- `SWITCHYARD_OBJECT_STORE_DIR` when backend is `local`
- `SWITCHYARD_OBJECT_STORE_ENDPOINT`, `SWITCHYARD_OBJECT_STORE_REGION`, `SWITCHYARD_OBJECT_STORE_BUCKET`, `SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID`, `SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY` when backend is `s3-compatible`

Base URL:

```text
http://127.0.0.1:4545
```

Current implementation status:

- Implemented: health, metrics, runs (create/get/list), run events (replay-only, bounded live, open-ended live), run artifacts (per-run listing, global metadata, content), run input, run cancellation, registry lookups (single-record and listing), runtime-mode/doctor checks, middleware foundation routes (messages, memory, evidence, context, approvals, tools), local-daemon real tool invocation routing for configured `fetch`/`web_search`/`github`/`repo`/command-catalog `shell` (deny-by-default, approval-by-default), and hosted/server-safe debate routes (`POST /debates`, `GET /debates/:id`, `GET /debates/:id/events`).
- Implemented runtimes: fake test runtime (`fake.deterministic`), local Claude Code structured runtime (`claude_code.sdk`, stream-json CLI client path), local Codex one-shot (`codex.exec_json`), local Codex interactive (`codex.interactive`), AgentField async REST wrapper (`agentfield.async_rest`), Generic HTTP async REST wrapper (`generic_http.async_rest`), and local OpenCode ACP (`opencode.acp`).
- Implemented packaging/hardening surfaces: `@switchyard/sdk`, `@switchyard/cli`, deterministic OpenAPI export/check in `@switchyard/contracts`, SQLite schema metadata/migration policy checks, and adapter compatibility matrix generation in no-spend mode.
- Not implemented yet: trace endpoint, dashboards, TUI, payment provider integration (invoices/checkout/webhooks), managed production hosting platform, public tenant self-service/signup, OAuth/OIDC/SAML/SSO/SCIM login flows, rate limiting, public `/exec`/`/shell`/`/process`/`/command`/`/sandbox`/`/pty`/`/terminal` APIs, hosted interactive Codex bridge, hosted post-start input bridge for `codex.exec_json`/`codex.interactive`, hosted approval bridge for `codex.exec_json`/`codex.interactive`, hosted active cancel bridge, per-run HTTP base URL/auth/target overrides, arbitrary wrapper endpoint execution, remote artifact URL fetching, browser automation, hosted `repo` execution, Cursor/OpenClaw/Paperclip adapters, hosted runtime expansion beyond known provider modes (`codex.exec_json`, `claude_code.sdk`, `opencode.acp`, `agentfield.async_rest`, `generic_http.async_rest`), and public model judge routes.

## Error Contract

Every 4xx and 5xx response uses one envelope:

```json
{
  "error": {
    "code": "snake_case_machine_code",
    "message": "human-readable explanation",
    "requestId": "req-1",
    "details": [
      { "path": "limit", "issue": "must be <= 200" }
    ]
  }
}
```

`details` is optional and is only present on validation failures. `requestId` is optional but emitted by the daemon when available and echoed in `x-request-id`.

Closed code set:

| Code | HTTP | Used for |
| --- | --- | --- |
| `run_not_found` | 404 | Unknown run id. |
| `debate_not_found` | 404 | Unknown debate id. |
| `debate_evidence_not_found_or_denied` | 404 | Debate evidence is missing or not owned by the caller. |
| `artifact_not_found` | 404 | Unknown artifact id. |
| `missing_artifact_content` | 404 | Artifact exists, content unavailable. |
| `provider_not_found` | 404 | Unknown provider id or slug. |
| `runtime_not_found` | 404 | Unknown runtime id or slug. |
| `runtime_mode_not_found` | 404 | Unknown runtime mode id or slug. |
| `model_not_found` | 404 | Unknown model id or slug. |
| `message_not_found` | 404 | Unknown message id. |
| `memory_not_found` | 404 | Unknown memory id. |
| `evidence_not_found` | 404 | Unknown evidence id. |
| `approval_not_found` | 404 | Unknown approval id. |
| `tool_invocation_not_found` | 404 | Unknown tool invocation id. |
| `debate_real_participant_opt_in_required` | 400 | Non-fake debate participant requested without real runtime opt-in. |
| `debate_runtime_unsupported` | 409 | Debate participant runtime is not in the allowed debate runtime set. |
| `debate_wait_real_runtime_unsupported` | 409 | `wait=1` was requested for real participant or live judge debate work. |
| `debate_participant_count_invalid` | 400 | Debate participant count is invalid. |
| `debate_participant_placement_required` | 400 | Real hosted debate participant did not explicitly request hosted placement. |
| `debate_participant_run_missing` | 409 | Debate participant child run is missing. |
| `debate_participant_run_failed` | 409 | Debate participant child run failed. |
| `debate_participant_run_timeout` | 409 | Debate participant child run timed out. |
| `debate_participant_output_missing` | 409 | Participant run produced no usable runtime output event. |
| `debate_participant_output_empty` | 409 | Participant run output was blank after trimming. |
| `debate_participant_output_too_large` | 409 | Participant output exceeded the debate extraction bound. |
| `debate_runtime_approval_expired` | 409 | Debate runtime approval expired before the participant or judge could continue. |
| `debate_child_run_link_failed` | 503 | Debate child run idempotency/ownership link failed. |
| `debate_judge_config_invalid` | 400 | `judgeConfig` is malformed. |
| `debate_judge_runtime_unsupported` | 409 | Requested live judge runtime is not allowed. |
| `debate_judge_live_spend_unconfirmed` | 400 | Live model judge requested without spend confirmation. |
| `debate_judge_run_failed` | 409 | Live judge child run failed. |
| `debate_judge_timeout` | 409 | Live judge child run timed out. |
| `debate_judge_output_missing` | 409 | Live judge produced no usable runtime output event. |
| `debate_judge_output_empty` | 409 | Live judge output was blank after trimming. |
| `debate_judge_output_invalid` | 409 | Live judge output could not be parsed into the bounded judge shape. |
| `debate_judge_output_too_large` | 409 | Live judge output exceeded the judge extraction bound. |
| `hosted_debate_store_unavailable` | 503 | Hosted durable debate store is unavailable. |
| `hosted_debate_queue_unavailable` | 503 | Hosted debate queue/outbox is unavailable. |
| `hosted_debate_worker_unavailable` | 503 | Hosted debate worker readiness failed. |
| `hosted_debate_ownership_attach_failed` | 503 | Hosted debate ownership attachment failed. |
| `hosted_debate_quota_exceeded` | 429 | Hosted debate quota was exceeded. |
| `hosted_debate_audit_unavailable` | 503 | Hosted debate audit store is unavailable. |
| `hosted_debate_artifact_write_failed` | 503 | Hosted debate final report artifact write failed. |
| `hosted_debate_event_persist_failed` | 503 | Hosted debate event persistence failed. |
| `debate_live_canary_spend_unconfirmed` | 400 | Production live debate canary requested without spend confirmation. |
| `debate_fake_canary_failed` | 503 | Production fake hosted debate canary failed. |
| `invalid_input` | 400 | Malformed body. |
| `invalid_query` | 400 | Malformed or out-of-range query parameter. |
| `tool_policy_denied` | 403 | Policy denied known real tools or denied risky action. |
| `adapter_protocol_failed` | 409 | Adapter cannot perform the requested action. |
| `approval_not_pending` | 409 | Approval was already resolved and cannot transition again. |
| `object_store_unavailable` | 503 | Artifact object store is unavailable. |
| `object_store_timeout` | 503 | Artifact object store operation timed out. |
| `object_store_auth_failed` | 503 | Artifact object store authentication failed. |
| `object_store_bucket_not_found` | 503 | Artifact object store bucket does not exist or is inaccessible. |
| `object_store_read_failed` | 503 | Artifact object store read failed. |
| `artifact_digest_mismatch` | 409 | Retrieved artifact content digest mismatch. |
| `artifact_content_empty` | 409 | Retrieved artifact content length/integrity mismatch. |
| `internal_error` | 500 | Unexpected server failure. |

All success bodies (`{run, events}`, `{accepted: true}`, etc.) are unchanged.

## Status Codes

| Status | Meaning |
| --- | --- |
| `200` | Query succeeded. |
| `201` | Run created and completed synchronously through `wait=1`. |
| `202` | Run accepted and launched asynchronously, or input accepted. |
| `400` | Validation failure on the body or query string. |
| `404` | Requested run/debate/artifact/provider/runtime/model is not found. |
| `409` | Request is valid, but the selected adapter cannot perform it. |
| `500` | Unexpected server failure. |

## R17 Middleware And Local Real Tool Constraints

- Memory search remains substring-only (`GET /memory/search`) and case-insensitive over `content`; vector/embedding search is not shipped.
- Evidence routes still store metadata only; Switchyard does not fetch remote evidence content in this slice.
- Real tools are local-daemon only through `/tools/invocations` and are deny-by-default (`SWITCHYARD_REAL_TOOLS_ENABLED=0` by default).
- Shipped real tools in R17: `fetch`, `web_search`, `github`, `repo`, command-catalog `shell`.
- `browser` remains known-but-unshipped and policy-denied.
- Real tools require approval by default and queue as `{ invocation, approval }` until resolved (`approve`, `reject`, or expire).
- R22 ships hosted worker and connected-node real tools for the exact tool set above; browser remains denied and hosted `repo` remains denied.
- No public arbitrary execution route exists: no `/sandbox`, `/exec`, `/pty`, `/terminal`, `/shell`, `/process`, `/command`, `/browser`, top-level `/search`, or `/tools/search`.
- Context packets are still persisted under `run.metadata.contextPacket` when `POST /runs` includes `context`.

Local daemon real-tool env keys:

- Global policy: `SWITCHYARD_REAL_TOOLS_ENABLED`, `SWITCHYARD_REAL_TOOLS_ALLOWED_PLACEMENTS`, `SWITCHYARD_REAL_TOOLS_APPROVAL_DEFAULT`, `SWITCHYARD_REAL_TOOLS_APPROVAL_EXPIRES_MS`, `SWITCHYARD_REAL_TOOLS_MAX_CONCURRENT`, `SWITCHYARD_REAL_TOOLS_MAX_INPUT_BYTES`, `SWITCHYARD_REAL_TOOLS_MAX_INLINE_OUTPUT_BYTES`, `SWITCHYARD_REAL_TOOLS_MAX_ARTIFACT_BYTES`, `SWITCHYARD_REAL_TOOLS_DEFAULT_TIMEOUT_MS`.
- Fetch: `SWITCHYARD_FETCH_TOOL_ENABLED`, `SWITCHYARD_FETCH_ALLOW_HOSTS`, `SWITCHYARD_FETCH_ALLOW_METHODS`, `SWITCHYARD_FETCH_ALLOW_CONTENT_TYPES`, `SWITCHYARD_FETCH_ALLOW_HEADERS`, `SWITCHYARD_FETCH_MAX_REDIRECTS`, `SWITCHYARD_FETCH_TIMEOUT_MS`, `SWITCHYARD_FETCH_MAX_RESPONSE_BYTES`.
- Web search: `SWITCHYARD_WEB_SEARCH_TOOL_ENABLED`, `SWITCHYARD_WEB_SEARCH_PROVIDER`, `SWITCHYARD_WEB_SEARCH_BASE_URL`, `SWITCHYARD_WEB_SEARCH_MAX_RESULTS`, `SWITCHYARD_WEB_SEARCH_TIMEOUT_MS`, `SWITCHYARD_WEB_SEARCH_MAX_RESPONSE_BYTES`.
- GitHub: `SWITCHYARD_GITHUB_TOOL_ENABLED`, `SWITCHYARD_GITHUB_TOKEN`, `SWITCHYARD_GITHUB_ALLOW_REPOS`, `SWITCHYARD_GITHUB_TIMEOUT_MS`, `SWITCHYARD_GITHUB_MAX_RESPONSE_BYTES`.
- Repo: `SWITCHYARD_REPO_TOOL_ENABLED`, `SWITCHYARD_REPO_GIT_BINARY`, `SWITCHYARD_REPO_ALLOW_CWD_PREFIXES`, `SWITCHYARD_REPO_MAX_PATHS`, `SWITCHYARD_REPO_TIMEOUT_MS`, `SWITCHYARD_REPO_MAX_OUTPUT_BYTES`.
- Shell: `SWITCHYARD_SHELL_TOOL_ENABLED`, `SWITCHYARD_SHELL_COMMAND_CATALOG_PATH`, `SWITCHYARD_SHELL_ALLOW_CWD_PREFIXES`, `SWITCHYARD_SHELL_TIMEOUT_MS`, `SWITCHYARD_SHELL_MAX_OUTPUT_BYTES`.

Tool invocation request/response envelope:

- Create: `POST /tools/invocations` with body `{ runId?, type, input, approvalPolicy? }`.
- Immediate completion: `201` with `{ invocation }`.
- Approval required: `202` with `{ invocation, approval }`.
- List: `GET /tools/invocations` returns `{ invocations, nextCursor }`.
- Get: `GET /tools/invocations/:id` returns `{ invocation }`.

## R24 Debate Constraints

- Debate routes are limited to the existing family: `POST /debates`, `GET /debates/:id`, and `GET /debates/:id/events`.
- No public model judge route is shipped: no `/debates/judge`, `/model-judge`, `/judging`, `/judge`, or equivalent route family.
- Exactly two participants are required per debate.
- Fake deterministic debate is the default no-spend path. Fake participants default to `runtime: "fake"`, `provider: "test"`, `model: "test-model"`, `adapterType: "process"`, and `runtimeMode: "fake.deterministic"`.
- Opt-in debate participant runs are allowed only for `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, `opencode.acp`, `agentfield.async_rest`, and `generic_http.async_rest`.
- Non-fake participant runtimes require `realRuntimeOptIn: true`; otherwise creation fails with `400 debate_real_participant_opt_in_required` before provider side effects.
- Hosted real participants require `placement: "hosted"`; otherwise creation fails with `400 debate_participant_placement_required`.
- Hosted debate participant execution uses existing hosted run/runtime contracts and preserves child run ids, message ids, event ids, evidence ids, and artifact ids.
- `codex.exec_json` remains one-shot. Hosted `codex.interactive` debate execution is unshipped.
- Wrapper hosted debate participants (`agentfield.async_rest` and `generic_http.async_rest`) are allowed only when hosted placement, `realRuntimeOptIn`, provider activation/spend gates, wrapper config/capability checks, bridge readiness, durable command/payload stores, queue/outbox, object store, ownership, quota, audit, and worker readiness all pass.
- `judgeConfig` defaults to `{ "mode": "deterministic" }` and uses the internal bounded deterministic judge.
- `judgeConfig.mode: "model"` is a live model judge request and requires `realRuntimeOptIn: true` plus `confirmLiveProviderSpend: true`; otherwise creation fails with `400 debate_judge_live_spend_unconfirmed`.
- `POST /debates?wait=1` is supported only for fake deterministic no-spend debates. Real participant or live judge requests with `wait=1` fail with `409 debate_wait_real_runtime_unsupported` before provider side effects.
- `evidenceIds` are validated before debate creation; unknown local evidence returns `404 evidence_not_found`, and hosted missing/denied evidence returns `404 debate_evidence_not_found_or_denied`, with no provider side effects.
- Hosted debate requires durable Postgres debate/message/evidence/job state, child-run idempotency, ownership preauthorization and attachment, quota, audit, queue/outbox, object store, worker readiness, provider activation, and hosted runtime bridge readiness where applicable.
- `POST /debates` returns `202 { debate }` after creation and executes asynchronously unless `wait=1` fake/no-spend mode is used.
- `GET /debates/:id` returns `{ debate, events, messages, evidence, artifacts }`.
- `GET /debates/:id/events` supports replay-only, `live=1`, `live=1&stopAfter=N`, and `Last-Event-ID` / `lastEventId`.
- Final report artifacts use `type: "summary"` and are written at `debates/<debateId>/final-report.md` when artifact content storage is configured.

## Debate Endpoints

Create and execute synchronously:

```bash
curl -s -X POST "http://127.0.0.1:4545/debates?wait=1" \
  -H 'content-type: application/json' \
  -d '{
    "topic": "Should Switchyard prove fake debate before real runtimes?",
    "participants": [
      { "role": "affirmative", "runtime": "fake", "provider": "test", "model": "test-model", "adapterType": "process", "runtimeMode": "fake.deterministic" },
      { "role": "skeptic", "runtime": "fake", "provider": "test", "model": "test-model", "adapterType": "process", "runtimeMode": "fake.deterministic" }
    ],
    "limits": { "maxRounds": 2, "maxTurnsPerAgent": 2, "maxTotalMessages": 4, "maxDurationSeconds": 30 }
  }'
```

Inspect:

```bash
DEBATE_ID=debate_replace_me
curl -s "http://127.0.0.1:4545/debates/$DEBATE_ID"
```

Replay debate SSE:

```bash
curl -s "http://127.0.0.1:4545/debates/$DEBATE_ID/events"
```

## Run Object

```json
{
  "id": "run_...",
  "runtime": "codex",
  "provider": "openai",
  "model": "gpt-5.5",
  "adapterType": "process",
  "runtimeMode": "codex.exec_json",
  "cwd": "/Users/example/project",
  "task": "Return one sentence describing this repository.",
  "status": "completed",
  "placement": "local",
  "approvalPolicy": "default",
  "timeoutSeconds": 120,
  "metadata": {},
  "createdAt": "2026-05-14T15:53:28.542Z",
  "startedAt": "2026-05-14T15:53:28.543Z",
  "endedAt": "2026-05-14T15:53:49.249Z"
}
```

Run statuses:

```text
queued
starting
running
waiting_for_input
waiting_for_approval
completed
failed
cancelled
timeout
```

Adapter types:

```text
native
acpx
http
webhook
process
pty
browser
```

## Health

```bash
curl -s http://127.0.0.1:4545/health
```

## Metrics

```bash
curl -s http://127.0.0.1:4545/metrics
```

## Create Run

Async:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs" \
  -H 'content-type: application/json' \
  -d '{
    "runtime": "codex",
    "provider": "openai",
    "model": "gpt-5.5",
    "adapterType": "process",
    "runtimeMode": "codex.exec_json",
    "cwd": "/Users/vasuyadav/Downloads/Projects/switchyard",
    "task": "Return one sentence describing this repository. Do not edit files.",
    "timeoutSeconds": 120
  }'
```

Synchronous wait-for-completion:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{ "runtime": "fake", "provider": "test", "model": "test-model", "adapterType": "process", "cwd": "/repo", "task": "Smoke" }'
```

`POST /runs?wait=1` returns `{run, response}` where `response.text` is the last normalized `runtime.output`. Async create returns `{run}` and the daemon launches the run in the background.

R16 interactive Codex guardrail:

- `POST /runs?wait=1` with `runtimeMode: "codex.interactive"` is rejected before durable side effects.
- Error envelope: `400 invalid_input` with `details: [{ "path": "wait", "issue": "interactive_wait_unsupported" }]`.
- Hosted placement for `codex.interactive` is rejected before create with `409 placement_denied` and `details: [{ "path": "placement", "issue": "hosted_runtime_not_allowed" }]`.

`POST /runs` also accepts optional `context` (`sections`, `memoryIds`, `evidenceIds`, `messageIds`). When present, the daemon builds a deterministic context packet (`target: "run"`), persists the rendered task in `run.task`, stores `metadata.originalTask`, and stores `metadata.contextPacket`. When `context` is absent, run behavior is unchanged from R6. Callers cannot provide `metadata.originalTask` or `metadata.contextPacket` when `context` is supplied.

`runtimeMode` is optional. If omitted, the daemon infers shipped runtime modes:

- `runtime: "fake"` -> `runtimeMode: "fake.deterministic"`
- `runtime: "claude_code"` and `adapterType: "native"` -> `runtimeMode: "claude_code.sdk"`
- `runtime: "codex"` and `adapterType: "process"` -> `runtimeMode: "codex.exec_json"`
- `runtime: "agentfield"` and `adapterType: "http"` -> `runtimeMode: "agentfield.async_rest"`
- `runtime: "generic_http"` and `adapterType: "http"` -> `runtimeMode: "generic_http.async_rest"`
- `runtime: "opencode"` and `adapterType: "acpx"` -> `runtimeMode: "opencode.acp"`

When provided, `runtimeMode` must be a runtime-mode slug (for example `codex.exec_json`), not an internal id like `runtime_mode_codex_exec_json`.
For OpenCode specifically, `runtime_mode_opencode_acp` is rejected with `400 invalid_input`; use slug `opencode.acp` or omit `runtimeMode` and let inference apply.

`codex.interactive` is explicit-only. It is never inferred from omitted `runtimeMode`; omitted Codex mode remains `codex.exec_json`.

Explicit `codex.interactive` create payload example (async only):

```bash
curl -s -X POST "http://127.0.0.1:4545/runs" \
  -H 'content-type: application/json' \
  -d '{
    "runtime": "codex",
    "provider": "openai",
    "model": "gpt-5.5",
    "adapterType": "process",
    "runtimeMode": "codex.interactive",
    "cwd": "/Users/vasuyadav/Downloads/Projects/switchyard",
    "task": "Inspect the repo and propose a minimal patch.",
    "timeoutSeconds": 120
  }'
```

Generic HTTP create payload example:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{
    "runtime": "generic_http",
    "provider": "generic_http",
    "model": "generic-http-default",
    "adapterType": "http",
    "cwd": "/repo",
    "task": "generic http smoke",
    "timeoutSeconds": 30
  }'
```

OpenCode ACP create payload example:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{
    "runtime": "opencode",
    "provider": "opencode",
    "model": "opencode-default",
    "adapterType": "acpx",
    "cwd": "/repo",
    "task": "Return one short sentence.",
    "timeoutSeconds": 30
  }'
```

`opencode-default` means OpenCode's current configured model; R5 does not select OpenCode models per run.

AgentField create payload example:

```bash
curl -s -X POST "http://127.0.0.1:4545/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{
    "runtime": "agentfield",
    "provider": "agentfield",
    "model": "agentfield-default",
    "adapterType": "http",
    "cwd": "/repo",
    "task": "Return one short sentence.",
    "timeoutSeconds": 30
  }'
```

## Get Run

```bash
RUN_ID=run_replace_me
curl -s "http://127.0.0.1:4545/runs/$RUN_ID"
```

Returns `{run, events}` with every persisted event.

## List Runs

```bash
curl -s "http://127.0.0.1:4545/runs?limit=50"
```

Response:

```json
{
  "runs": [ /* Run objects, newest first */ ],
  "nextCursor": "base64-opaque-or-null"
}
```

Sort order is `createdAt DESC, id DESC`. `nextCursor` is opaque; pass it back as `?before=...` to page.

Query parameters:

| Name | Type | Notes |
| --- | --- | --- |
| `status` | CSV of run status enum | Unknown values → `400 invalid_query`. |
| `runtime` | CSV of runtime slugs | E.g. `codex,fake`. |
| `provider` | CSV of provider slugs | E.g. `openai`. |
| `model` | CSV of model slugs | E.g. `gpt-5.5`. |
| `placement` | CSV of placement values | Currently always `local`. |
| `adapterType` | CSV of adapter types | `native,acpx,http,webhook,process,pty,browser`. |
| `since` | ISO-8601 timestamp | Inclusive lower bound on `createdAt`. |
| `until` | ISO-8601 timestamp | Exclusive upper bound on `createdAt`. |
| `limit` | integer | Default `50`, max `200`. |
| `before` | opaque cursor | From a previous response's `nextCursor`. |

Well-formed-but-unknown slug filter values match zero rows (200 with empty array). Empty result still returns `nextCursor: null`.

## Get Run Events

Three modes on the same endpoint:

| Query | Behavior |
| --- | --- |
| _(none)_ | Replay-only. SSE response of every persisted event, then connection closes. |
| `?live=1` | Replay-then-live. Replays persisted events, then keeps the connection open and streams new events as they reach the event bus. |
| `?live=1&stopAfter=N` | Bounded replay-then-live. Closes after `N` total events. |

```bash
RUN_ID=run_replace_me
curl -N "http://127.0.0.1:4545/runs/$RUN_ID/events?live=1"
```

Open-ended SSE contract:

- Response `Content-Type` is `text/event-stream; charset=utf-8`.
- Server emits an SSE comment heartbeat (`:\n\n`) every 15 seconds on otherwise-idle connections.
- Server closes the connection after 5 minutes with no events (idle timeout) with a clean `event: stream.idle` marker followed by EOF.
- On client disconnect, the server unsubscribes from the event bus and releases resources within 1 second.

Resumption: clients reconnect with the standard SSE `Last-Event-ID` header to receive only events with id greater than the supplied id. Resumption applies to all three modes.

## Get Run Artifacts

```bash
RUN_ID=run_replace_me
curl -s "http://127.0.0.1:4545/runs/$RUN_ID/artifacts"
```

Returns `{ artifacts: [ ... ] }`.

## Get Artifact

```bash
ARTIFACT_ID=artifact_replace_me
curl -s "http://127.0.0.1:4545/artifacts/$ARTIFACT_ID"
```

Returns:

```json
{
  "artifact": {
    "id": "artifact_...",
    "runId": "run_...",
    "type": "transcript",
    "path": "runs/run_.../transcript.jsonl",
    "metadata": { "contentStored": true },
    "createdAt": "..."
  }
}
```

Errors: `404 artifact_not_found`.

## Get Artifact Content

```bash
ARTIFACT_ID=artifact_replace_me
curl -s "http://127.0.0.1:4545/artifacts/$ARTIFACT_ID/content"
```

- Response `Content-Type` is chosen per artifact type:
  - `transcript` → `application/x-ndjson`
- Body is the raw stored content; no JSON wrapping.
- `HEAD` and `Range` requests are **not** supported.

Errors: `404 artifact_not_found`; if the record exists but `metadata.contentStored=false` or the backing file is missing, `404 missing_artifact_content`.

## List Providers / Runtimes / Models

```bash
curl -s "http://127.0.0.1:4545/providers?limit=50"
curl -s "http://127.0.0.1:4545/runtimes?provider=openai"
curl -s "http://127.0.0.1:4545/models?provider=openai"
```

Filter rules:

| Endpoint | Filters |
| --- | --- |
| `GET /providers` | `limit`, `before` |
| `GET /runtimes` | `provider` (CSV slug), `adapterType` (CSV), `limit`, `before` |
| `GET /models` | `provider` (CSV slug), `limit`, `before` — when `provider` is omitted, orphan models are included |

Responses:

```json
{ "providers": [ /* records */ ], "nextCursor": "...|null" }
{ "runtimes":  [ /* records */ ], "nextCursor": "...|null" }
{ "models":    [ /* records */ ], "nextCursor": "...|null" }
```

Registry list endpoints are shipped and return records as stored. Runtime capability and health reporting are also shipped through runtime-mode and doctor endpoints.

## Runtime Mode APIs

```bash
curl -s "http://127.0.0.1:4545/runtime-modes?provider=openai&availability=available"
curl -s "http://127.0.0.1:4545/runtime-modes/runtime_mode_codex_exec_json"
curl -s "http://127.0.0.1:4545/runtime-modes/codex.exec_json"
curl -s -X POST "http://127.0.0.1:4545/runtime-modes/codex.exec_json/check"
curl -s "http://127.0.0.1:4545/runtime-modes/claude_code.sdk"
curl -s -X POST "http://127.0.0.1:4545/runtime-modes/claude_code.sdk/check"
curl -s "http://127.0.0.1:4545/runtime-modes/opencode.acp"
curl -s -X POST "http://127.0.0.1:4545/runtime-modes/opencode.acp/check"
curl -s "http://127.0.0.1:4545/doctor"
```

Runtime mode list filters:

| Endpoint | Filters |
| --- | --- |
| `GET /runtime-modes` | `provider`, `runtime`, `adapterType`, `kind`, `availability`, `placement`, `capability`, `limit`, `before` |

`GET /doctor` is read-only and returns the latest stored snapshots. `POST /runtime-modes/:id/check` runs a fresh bounded check and updates stored availability.

OpenCode check behavior:

- runs `opencode --version`, ACP `initialize`, and ACP `session/new`.
- does not send ACP `session/prompt` (no model-budget spend during doctor checks).

Claude check behavior:

- default active check is no-spend-first and reports `reasonCode: live_probe_disabled`.
- optional live probe is disabled by default and requires explicit daemon env enablement.

Example `GET /runtime-modes?provider=openai` response:

```json
{
  "runtimeModes": [
    {
      "id": "runtime_mode_codex_exec_json",
      "slug": "codex.exec_json",
      "name": "Codex exec JSON",
      "providerId": "provider_openai",
      "runtimeId": "runtime_codex",
      "adapterId": "codex",
      "adapterType": "process",
      "kind": "one_shot_process",
      "status": "partial",
      "capabilities": [
        "run.start",
        "run.cancel",
        "run.timeout",
        "event.normalized",
        "event.streaming",
        "artifact.transcript",
        "artifact.raw_transcript",
        "model.catalog",
        "auth.local",
        "sandbox.read_only",
        "sandbox.workspace_write",
        "sandbox.danger_full_access"
      ],
      "limitations": [
        { "code": "one_shot_no_input", "message": "No post-start interactive input support in R3." }
      ],
      "placement": {
        "local": { "support": "supported", "reason": "Requires a PATH-reachable local codex binary and local workspace." },
        "hosted": { "support": "unsupported", "reason": "Hosted subprocess execution is not shipped in R3." },
        "connectedLocalNode": { "support": "future", "reason": "Hybrid node execution is planned for R10." }
      },
      "availability": {
        "state": "partial",
        "canRun": true,
        "installed": true,
        "auth": "configured",
        "version": "codex 0.0.0-test",
        "checkedAt": "2026-05-30T00:00:00.000Z",
        "reasonCode": "optional_check_failed",
        "message": "Optional runtime checks failed."
      },
      "docsPath": "docs/development/adapters/CODEX.md",
      "createdAt": "2026-05-30T00:00:00.000Z",
      "updatedAt": "2026-05-30T00:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Example `GET /runtime-modes/codex.exec_json` response:

```json
{
  "runtimeMode": {
    "id": "runtime_mode_codex_exec_json",
    "slug": "codex.exec_json",
    "name": "Codex exec JSON",
    "providerId": "provider_openai",
    "runtimeId": "runtime_codex",
    "adapterId": "codex",
    "adapterType": "process",
    "kind": "one_shot_process",
    "status": "partial",
    "capabilities": [
      "run.start",
      "run.cancel",
      "run.timeout",
      "event.normalized",
      "event.streaming",
      "artifact.transcript",
      "artifact.raw_transcript",
      "model.catalog",
      "auth.local",
      "sandbox.read_only",
      "sandbox.workspace_write",
      "sandbox.danger_full_access"
    ],
    "limitations": [
      { "code": "one_shot_no_input", "message": "No post-start interactive input support in R3." }
    ],
    "placement": {
      "local": { "support": "supported", "reason": "Requires a PATH-reachable local codex binary and local workspace." },
      "hosted": { "support": "unsupported", "reason": "Hosted subprocess execution is not shipped in R3." },
      "connectedLocalNode": { "support": "future", "reason": "Hybrid node execution is planned for R10." }
    },
    "availability": {
      "state": "partial",
      "canRun": true,
      "installed": true,
      "auth": "configured",
      "version": "codex 0.0.0-test",
      "checkedAt": "2026-05-30T00:00:00.000Z",
      "reasonCode": "optional_check_failed",
      "message": "Optional runtime checks failed."
    },
    "docsPath": "docs/development/adapters/CODEX.md",
    "createdAt": "2026-05-30T00:00:00.000Z",
    "updatedAt": "2026-05-30T00:00:00.000Z"
  }
}
```

Example `POST /runtime-modes/codex.exec_json/check` response:

```json
{
  "check": {
    "runtimeModeId": "runtime_mode_codex_exec_json",
    "runtimeMode": "codex.exec_json",
    "providerId": "provider_openai",
    "runtimeId": "runtime_codex",
    "state": "partial",
    "canRun": true,
    "installed": true,
    "auth": "configured",
    "version": "codex 0.0.0-test",
    "checkedAt": "2026-05-30T00:00:00.000Z",
    "reasonCode": "optional_check_failed",
    "message": "Optional runtime checks failed.",
    "capabilities": ["run.start", "run.cancel", "run.timeout", "event.normalized", "model.catalog", "auth.local"],
    "limitations": [{ "code": "one_shot_no_input", "message": "No post-start interactive input support in R3." }],
    "diagnostics": [
      {
        "code": "sandbox_policy_probe",
        "severity": "warning",
        "message": "optional sandbox probe failed"
      }
    ]
  }
}
```

`codex.interactive` doctor/check truth note:

- Default no-spend checks may report command-shape capability (`resumeCommandShapeAvailable: true`) while still reporting `liveResumeVerified: false`.
- Treat command-shape support and live resume verification as separate signals.
- Do not treat default no-spend output as proof that live local resume has already succeeded.

Example `GET /doctor` response:

```json
{
  "runtimeModes": [
    {
      "runtimeModeId": "runtime_mode_fake_deterministic",
      "runtimeMode": "fake.deterministic",
      "state": "available",
      "canRun": true,
      "checkedAt": "2026-05-30T00:00:00.000Z"
    },
    {
      "runtimeModeId": "runtime_mode_codex_exec_json",
      "runtimeMode": "codex.exec_json",
      "state": "partial",
      "canRun": true,
      "checkedAt": "2026-05-30T00:00:00.000Z"
    }
  ],
  "summary": {
    "available": 1,
    "installed": 0,
    "partial": 1,
    "unavailable": 0,
    "unsupported": 0,
    "unknown": 0
  }
}
```

Availability states:

```text
available
installed
partial
unavailable
unsupported
unknown
```

`partial` means required checks passed and at least one optional check failed. Timeout/oversized-output failures are bounded and return sanitized `unknown` or `unavailable` responses instead of hanging.

## Single-Record Registry Lookups

```bash
curl -s http://127.0.0.1:4545/providers/provider_openai
curl -s http://127.0.0.1:4545/runtimes/runtime_codex
curl -s http://127.0.0.1:4545/models/model_gpt_5_5
```

Slug shortcuts are accepted as well (e.g. `openai`, `codex`, `gpt_5_5`).

## Send Input

```bash
RUN_ID=run_replace_me
curl -s -X POST "http://127.0.0.1:4545/runs/$RUN_ID/input" \
  -H 'content-type: application/json' \
  -d '{"text":"continue"}'
```

Success returns `{"accepted":true}`.

`POST /runs/:id/input` request body contract:

- object with required non-empty `text` string.
- max size: 65536 bytes (64 KiB UTF-8).
- invalid shape/empty/oversized body returns `400 invalid_input` before adapter dispatch.

Mode behavior:

- `claude_code.sdk`: supports post-start input while run/session are active.
- `codex.interactive`: supports post-start text input while the run/session are active, with `runtime_input_in_flight` conflict protection per runtime session.
- `codex.exec_json` remains one-shot and returns `409 adapter_protocol_failed` for post-start input.
- `agentfield.async_rest` and `generic_http.async_rest`: support post-start input only for active sessions when the configured wrapper advertises bridge capability; hosted use is admitted through the existing hosted runtime bridge and `POST /runs/:id/input`.
- `opencode.acp`: returns `409 adapter_protocol_failed` for post-start input.

Core protocol safeguards (when REST validation is bypassed) include `runtime_input_not_active`, `runtime_session_missing`, `runtime_input_empty`, `runtime_input_too_large`, and `runtime_input_in_flight`.

Codex interactive input/stream/approval reason codes exposed through `409 adapter_protocol_failed` details include:

- `codex_resume_token_missing`
- `codex_resume_session_stale`
- `codex_stream_malformed`
- `codex_approval_bridge_unsupported`
- `runtime_input_in_flight`
- `hosted_input_unsupported` (unsupported hosted runtime boundary, including `codex.exec_json` and hosted `codex.interactive`)

For OpenCode input failures, response details include `reasonCode: opencode_input_unsupported`.

## Resolve Runtime Approval Pauses

Approvals continue to use the R7 approval store and lifecycle endpoints.

Approve:

```bash
APPROVAL_ID=approval_replace_me
curl -s -X POST "http://127.0.0.1:4545/approvals/$APPROVAL_ID/approve" \
  -H 'content-type: application/json' \
  -d '{"actor":"local-user","reason":"approved by operator","answers":{"selection":"continue"}}'
```

Reject:

```bash
APPROVAL_ID=approval_replace_me
curl -s -X POST "http://127.0.0.1:4545/approvals/$APPROVAL_ID/reject" \
  -H 'content-type: application/json' \
  -d '{"actor":"local-user","reason":"unsafe tool request","answers":{"selection":"deny"}}'
```

Notes:

- `answers` is optional and forwarded for runtime-linked approvals.
- Hosted runtime approvals reuse `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve`, and `POST /approvals/:id/reject`; hosted `POST /approvals` is not exposed.
- Wrapper runtime approval resolution for `agentfield.async_rest` and `generic_http.async_rest` is conditional on hosted bridge readiness and wrapper-advertised approval capabilities.
- If runtime callback delivery fails with an adapter protocol reason, REST returns `409 adapter_protocol_failed` with `reasonCode` details.
- Approval records remain one-shot: resolving an already-resolved approval returns `409 approval_not_pending`.
- Expired runtime approvals resolve to terminal `expired` status and later approve/reject attempts return `409 approval_not_pending`.
- Runtime approval request events with malformed `expiresAt` fail the run with `runtime_approval_expires_at_invalid`.

## Cancel Run

```bash
RUN_ID=run_replace_me
curl -s -X POST "http://127.0.0.1:4545/runs/$RUN_ID/cancel"
```

Cancellation semantics:

- Cancel is idempotent for terminal runs.
- `codex.interactive` cancel is supported for active `running`, `waiting_for_input`, and `waiting_for_approval` local runs through the existing run cancel route.
- For `generic_http.async_rest`, an upstream 2xx cancel acknowledgement alone is not terminal.
- For `opencode.acp`, cancellation is only accepted after ACP verifies `stopReason:"cancelled"`.
- Switchyard reports `cancelled` only after the adapter verifies terminal `cancelled` state.
- Unverified or failed cancellation returns `409 adapter_protocol_failed` and keeps the previous run state.
- `agentfield.async_rest` active cancel returns `409 adapter_protocol_failed` with reason `agentfield_cancel_unsupported`; timeout handling remains Switchyard-owned.
- OpenCode unverified cancel uses `reasonCode: acp_cancel_unverified`.
- Hosted cancel remains unsupported for active hosted real runs (`hosted_cancel_unsupported`).
- Hosted input and approval bridges are available only for the supported runtime modes admitted by the hosted runtime bridge; unsupported modes still fail visibly with `hosted_input_unsupported` or `hosted_runtime_approval_bridge_unshipped`.

Runtime transcript/result artifacts are exposed through the existing artifact APIs. This includes AgentField transcript/result artifacts, Generic HTTP transcripts, and OpenCode ACP transcripts:

- `GET /runs/:id/artifacts`
- `GET /artifacts/:id`
- `GET /artifacts/:id/content`

## Codex Metadata

| Key | Example | Notes |
| --- | --- | --- |
| `reasoningEffort` | `"low"` | Validated against the local model catalog when available. |
| `reasoningSummary` | `"auto"` | Passed through to Codex config overrides. |
| `verbosity` | `"low"` | Passed through to Codex config overrides. |
| `sandbox` | `"read-only"` | Passed to `codex exec --sandbox`. |
| `ignoreUserConfig` | `true` | Defaults to `true` for daemon-launched Codex runs. |
| `ignoreRules` | `false` | Defaults to `false`. |

See [Codex Adapter Local Development](adapters/CODEX.md) for Codex-specific logs, PID checks, and stuck-run diagnosis.
