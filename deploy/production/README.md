# Switchyard Production Manifest Pack (R25)

This directory contains a production operator manifest pack for hosted server, hosted worker, and optional connected node. It is API/ops-only and keeps the checked-in default fake-only (`fake.deterministic`) and no-spend.

The worker service uses the currently available built entrypoint (`node apps/worker/dist/main.js`). Worker readiness must fail closed before queue claiming when runtime/sandbox/control-plane requirements are not satisfied.

## Included Files

- `docker-compose.yml`: production-shaped compose example with built entrypoints and runtime checks.
- `manifest.json`: machine-readable manifest consumed by production preflight checks.
- `.env.example`: required production variables with intentionally invalid placeholders.
- `bootstrap.example.json`: control-plane bootstrap example with fake-only runtime plan and placeholder `rawKey`/node token values.

## Production Dependency Requirements

Bring your own production-grade dependencies:

- Postgres (required for control plane and run/event/artifact metadata).
- Redis (required for hosted queue claim/ack).
- Object storage (required for artifact content store and probe).

The compose file keeps Postgres/Redis private and does not expose their ports publicly. Replace these containers with managed services as needed.

## Secret and Placeholder Policy

All placeholders in `.env.example` and `bootstrap.example.json` are intentionally invalid (`replace-with-*`). Production startup/preflight must reject these values.

Generate unique high-entropy values for at least:

- `SWITCHYARD_API_KEY_PEPPER`
- `SWITCHYARD_NODE_SHARED_TOKEN`
- Postgres/Redis credentials
- Object-store credentials
- Bootstrap API key and node token records

## Runtime, Tool, And Debate Boundary (R25)

Checked-in production defaults are fake-only:

- `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic`
- `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled`
- `SWITCHYARD_SANDBOX_REAL_EXECUTION=disabled` (safe default)

R25 keeps hosted runtime defaults fake-only and allows explicit provider opt-in for exactly:

- `codex.exec_json`
- `claude_code.sdk`
- `opencode.acp`
- `agentfield.async_rest`
- `generic_http.async_rest`

Provider activation requires:

- `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`
- allowlist includes fake plus explicit provider modes
- `SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON` or `SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH`
- required provider credentials by env var name (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
- spend controls in provider policy (`maxActiveRuns`, `maxRunsPerHour`, `maxRunTimeoutSeconds`, `maxPromptBytes`)
- production preflight, readiness, smoke, and no-spend canary checks passing

R22 hosted/connected-node real-tool execution ships only for:

- hosted worker tools: `fetch`, `web_search`, `github`, command-catalog `shell`
- connected-node tools: `fetch`, `web_search`, `github`, `repo`, command-catalog `shell`

R24/R25 hosted debate ships through the existing route family only:

- `POST /debates`
- `GET /debates/:id`
- `GET /debates/:id/events`

Fake deterministic hosted debate is the default no-spend path for production preflight and canary. Opt-in live debate participant runs are allowed only for `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, `opencode.acp`, `agentfield.async_rest`, and `generic_http.async_rest`. Live debate participants require request-level `realRuntimeOptIn: true`; hosted live participants require `placement: "hosted"` plus provider activation. Wrapper participants also require configured wrapper endpoints, advertised input/approval bridge capabilities, durable bridge command/payload stores, queue/outbox, object store, ownership, quota, audit, and worker readiness. The internal bounded judge runner defaults to deterministic no-spend judging; live model judging requires request opt-in and `confirmLiveProviderSpend: true`.

Hosted debate readiness requires:

- API-key auth and tenant/project ownership.
- Durable Postgres debate/message/evidence/job state.
- Child-run idempotency and evidence ownership preauthorization.
- Ownership, quota, and audit stores.
- Queue/outbox and worker readiness.
- Object-store readiness for final report artifacts.
- Provider activation for live participant, wrapper participant, or live judge probes.
- R23 bridge command/payload stores when `claude_code.sdk` or `opencode.acp` are allowlisted.
- R25 wrapper bridge config/capability checks when `agentfield.async_rest` or `generic_http.async_rest` are allowlisted.

R25 still does not ship:

- browser automation (`browser_tool_unshipped`)
- hosted `repo` execution (`repo_hosted_unshipped`)
- generic `/exec` `/shell` `/process` `/command` `/pty` `/terminal` `/sandbox` public routes
- dashboard or TUI surfaces are not shipped
- generic process/PTY adapters are not shipped
- hosted runtime terminal bridges
- executable Cursor/OpenClaw/Paperclip runtime integration beyond manifest/check scaffolds
- hosted `codex.interactive`
- arbitrary AgentField/Generic HTTP endpoint execution, per-run wrapper URL/auth overrides, or wrapper webhooks
- public model judge routes are not shipped (`/debates/judge`, `/model-judge`, `/judging`, `/judge`, or equivalent route family)
- managed SaaS/public signup, billing, OAuth, SSO, or SCIM are not shipped

## Rollout Order

1. Build and publish server/worker/node images with compiled `dist` entrypoints.
2. Copy `.env.example` to `.env` and replace every `replace-with-*` value.
3. Prepare bootstrap JSON from `bootstrap.example.json` and mount it as `SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH`.
4. Run preflight:
   - `pnpm tsx scripts/production-preflight.ts --env-file deploy/production/.env`
5. Run migrations:
   - `pnpm tsx scripts/production-migrate.ts --env-file deploy/production/.env`
6. Deploy server and wait for `/health` success.
7. Verify readiness gate:
   - `docker compose -f deploy/production/docker-compose.yml --profile ops-check run --rm server-ready`
8. Deploy worker.
9. Optionally deploy node:
   - `docker compose -f deploy/production/docker-compose.yml --profile optional-node up -d node`
10. Run default R25 canary (fake hosted debate, deterministic/no-spend):
    - `pnpm tsx scripts/production-canary.ts --base-url https://replace-with-public-server-url --api-key replace-with-operator-api-key`
11. Run production sandbox smoke:
    - `pnpm production:sandbox-smoke`
12. Run production hosted provider smoke (deterministic/no-spend):
    - `pnpm hosted-real-runtime:smoke`
13. Optional live external-tool canary (requires explicit env + flag confirmation):
    - `SWITCHYARD_CONFIRM_LIVE_TOOL_CANARY=1 pnpm production:live-tool-canary -- --base-url https://replace-with-public-server-url --api-key replace-with-operator-api-key --live-external-tools --confirm-live-tool-spend`
14. Optional live debate participant canary (requires explicit spend confirmation; skipped by default):
    - `pnpm production:canary -- --base-url https://replace-with-public-server-url --api-key replace-with-operator-api-key --live-debate-runtimes --confirm-live-provider-spend`
15. Optional live debate judge canary (requires explicit spend confirmation; skipped by default):
    - `pnpm production:canary -- --base-url https://replace-with-public-server-url --api-key replace-with-operator-api-key --live-debate-judge --confirm-live-provider-spend`

If `--live-debate-runtimes` or `--live-debate-judge` is supplied without `--confirm-live-provider-spend`, canary fails before provider dispatch with `debate_live_canary_spend_unconfirmed`.

## Rollback Order

1. Pause worker to stop new queue claims.
2. Roll server image back to last known-good release.
3. Re-run readiness checks; if schema mismatch appears, keep traffic blocked until compatible code is restored.
4. Roll worker image back after server readiness is green.
5. Keep canary and readiness evidence records; do not delete them.
6. To rollback provider runtime activation to fake-only:
   - Set `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic`
   - Set `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled`
   - Unset `SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON/PATH`
   - Restart server and worker

## Readiness and Metrics Interpretation

- `/health`: liveness only.
- `/ready`: dependency + control-plane + schema + queue + object-store + runtime gate + hosted debate readiness.
- `/metrics`: must be accessed with API key that includes both `metrics:read` and `admin:read`.

## Canary Record Retention

Canary runs and default fake hosted debate records are expected durable evidence in production. Query them by canary metadata/tag and retain them for audit and rollback diagnostics.

## Provider Policy Example (Opt-In Only)

This is an operator-owned example. Do not check live credentials into git.

```json
{
  "version": 1,
  "modes": {
    "codex.exec_json": {
      "enabled": true,
      "executablePath": "/usr/local/bin/codex",
      "cwdPrefixes": ["/srv/switchyard/work"],
      "envAllowlist": ["OPENAI_API_KEY", "PATH"],
      "requiredEnv": ["OPENAI_API_KEY"],
      "fixedArgs": ["exec", "--json"],
      "allowUserArgs": false,
      "sandbox": "read_only",
      "spendControls": {
        "maxActiveRuns": 2,
        "maxRunsPerHour": 20,
        "maxRunTimeoutSeconds": 300,
        "maxPromptBytes": 60000
      }
    }
  }
}
```

## CI/Audit Boundary

CI/audit verification for this pack must remain no-spend and deterministic. Live external-tool checks are operator-owned and should run only against operator-managed environments with explicit confirmation.
