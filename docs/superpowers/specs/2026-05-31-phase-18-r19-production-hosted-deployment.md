# Phase 18 Spec: R19 Production Hosted Deployment

**Date:** 2026-05-31
**Run:** `post-r11-remaining-20260530`
**Branch:** `agent/phase-18-r19-production-hosted-deployment`
**Base commit:** `78f836b` (R18 audit-green close)
**Spec target:** `docs/superpowers/specs/2026-05-31-phase-18-r19-production-hosted-deployment.md`

## Problem

Switchyard now has a hosted/server control-plane foundation, self-hosted staging stack, S3/R2-compatible object storage, Redis-backed queueing, Postgres stores, connected-node scaffolding, and production fail-closed checks from R12-R18. It is still not production-operable as a hosted deployment because the deploy surface is staging-oriented, startup validation is incomplete for real production operations, migration and rollback gates are not explicit, canary verification is not a first-class no-spend workflow, and server/worker/node operational safety is spread across code and docs.

R19 makes Switchyard production-operable for the existing safe hosted boundary. The release is API/ops-first: production manifests, production preflight, hardened env validation, readiness/canary/runbooks, schema migration and rollback gates, secret redaction, queue/object-store/database checks, and deterministic no-spend verification. It does not expand the product into dashboard, TUI, payment collection, OAuth/SSO, arbitrary execution, hosted real tools, browser automation, runtime-specific approval bridges, or hosted debate.

## Priority Rationale

Production hosted deployment is the highest-priority next slice after R18 because R18 made hosted/server APIs tenant-aware but did not make the deployment itself operable.

- Operators need one documented production path that proves the server, worker, node, Postgres, Redis, object store, control plane, auth, quota, audit, and artifact paths are healthy before real traffic.
- Managed-hosting readiness depends on manifests, health checks, explicit migrations, rollback instructions, and canary workflows more than on another runtime adapter.
- Production safety must fail closed before worker claim, queue enqueue, artifact reads, or public API traffic when auth, schema, queue, object store, or hosted runtime gates are unsafe.
- Dashboard/TUI, payment providers, OAuth/SSO, public tenant self-service, and broader hosted execution would create more exposed surface before the deployment boundary is dependable.
- R19 keeps required checks no-spend and deterministic so every CI/audit run can verify the deployment contract without model providers, payment providers, AWS/R2, browser automation, or arbitrary process execution.

## Goals

- Add a production deployment manifest pack for the hosted server, worker, and optional connected node using production commands, explicit env files, health/readiness checks, persistent external services, and safe defaults.
- Harden production env validation for `apps/server`, `apps/worker`, and `apps/node`, including placeholder secret rejection, minimum-secret posture, auth/control-plane requirements, object-store requirements, queue/database requirements, hosted runtime allowlist rules, and production real-runtime denial.
- Add a production preflight/check workflow that validates config, schema compatibility, control-plane bootstrap, queue connectivity, object-store probes, and deployment manifests before traffic is accepted.
- Add migration gates for Postgres schema compatibility and additive migration safety, plus rollback gates that make unsupported schema/code combinations fail visibly.
- Make `/health`, `/ready`, worker readiness, node readiness, and production canary behavior explicit and orchestrator-friendly.
- Add a no-spend production canary that uses API-key auth and `fake.deterministic` hosted execution to verify run creation, queue claim, worker completion, artifact persistence/readback, metrics access, audit/ownership effects, and rollback-safe failure behavior.
- Ensure server, worker, node, preflight, readiness, canary, and config errors use named machine-readable reason codes and redacted diagnostics.
- Preserve existing local daemon behavior: local daemon, SDK, CLI, local metrics, local OpenAPI, local real tools, local Codex/Claude/OpenCode modes, and local debate remain no-auth and backwards compatible by default.
- Update product/development/API truth so R19 is described as production hosted deployment readiness for the existing safe hosted boundary, not as managed SaaS, production hosted real-runtime execution, or public self-service.

## Non-Goals

- No dashboard.
- No TUI.
- No payment provider integration, Stripe integration, invoices, checkout, webhooks, tax, dunning, subscription lifecycle, customer portal, metering export, or automated billing collection.
- No OAuth, OIDC, SAML, SSO, SCIM, passkeys, session cookies, browser login, user-password auth, email invites, or public identity provider setup.
- No public tenant signup, public tenant self-service, public API-key management UI, billing admin UI, or organization-management UI.
- No production arbitrary process execution, generic process runtime, generic PTY runtime, hosted subprocess execution, hosted PTY execution, or public `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` route.
- No production hosted real-runtime execution for `codex.exec_json`, `claude_code.sdk`, `opencode.acp`, `codex.interactive`, Generic HTTP, AgentField, arbitrary process, or PTY. Production remains `fake.deterministic` only in required manifests and required canaries.
- No hosted or connected-node real tools. The R17 real-tool surface remains local-daemon only.
- No browser automation.
- No Cursor, OpenClaw, or Paperclip adapter work.
- No runtime-specific approval bridge expansion for OpenCode, AgentField, Generic HTTP, hosted Codex, or hosted Claude/OpenCode.
- No hosted post-start input bridge, hosted cancel bridge for worker-owned real runs, or hosted approval bridge.
- No hosted debate with real participant runtimes or model judging.
- No presigned direct upload/download URLs, bucket provisioning automation, lifecycle policy management, provider-managed KMS setup, or CDN integration.
- No cloud-provider-specific Terraform, Pulumi, Helm, Fly, Render, Vercel, AWS, GCP, Azure, or Cloudflare deployment module. R19 may include provider-neutral production manifests and runbooks only.
- No required live calls to model providers, payment providers, AWS S3, Cloudflare R2, live GitHub, external search, hosted browser, or arbitrary commands in CI/audit verification.

## Existing Context

`PRODUCT.md` says production hosted deployment remains unshipped after R18:

```md
The product is usable locally for one-shot agent runs, bounded Claude Code interaction, fake deterministic debate execution, event inspection, artifact listing/content retrieval, cancellation, registry/runtime-mode lookups, durable middleware records, SDK/CLI workflows, OpenAPI contract export, clean local packaging smoke, the R10 hosted-like/hybrid node slice, the R12 self-hosted staging deployment foundation, and the R18 hosted enterprise auth/tenant/quota/audit control-plane baseline. It is not yet a managed hosted platform, and production hosted real-runtime execution remains forbidden.
```

`PRODUCT.md` also lists the next production-hosting gap directly:

```md
- Managed production hosted platform deployment with tenant isolation, cloud networking, production secrets, and operator controls.
- Production hosted real-runtime worker deployment for Codex, Claude Code, OpenCode, arbitrary process, or PTY execution.
- Production sandboxing for arbitrary subprocess/PTY workloads (R15 still ships no managed production arbitrary subprocess/PTY substrate).
```

The current self-hosted manifest is staging-oriented and uses development commands. R19 must not promote this file as production-ready without a production manifest boundary.

`deploy/self-hosted/docker-compose.yml`:

```yml
server:
  image: node:22-alpine
  working_dir: /workspace
  command: ["sh", "-lc", "corepack enable && pnpm install --frozen-lockfile && pnpm --filter @switchyard/server dev"]
  environment:
    SWITCHYARD_DEPLOYMENT_MODE: staging
    SWITCHYARD_POSTGRES_URL: postgres://switchyard:switchyard@postgres:5432/switchyard
    SWITCHYARD_REDIS_URL: redis://redis:6379/0
    SWITCHYARD_OBJECT_STORE_DIR: /var/switchyard/objects
    SWITCHYARD_NODE_SHARED_TOKEN: switchyard-node-token
    SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST: fake.deterministic
    SWITCHYARD_PORT: "4646"
```

The staging env example already names object-store and node settings. R19 should extend this pattern with production placeholders, redaction expectations, and production-only validation.

`deploy/self-hosted/.env.example`:

```text
SWITCHYARD_DEPLOYMENT_MODE=staging
SWITCHYARD_POSTGRES_URL=postgres://switchyard:***@postgres:5432/switchyard
SWITCHYARD_REDIS_URL=redis://redis:6379/0
SWITCHYARD_OBJECT_STORE_BACKEND=local
SWITCHYARD_OBJECT_STORE_DIR=/var/switchyard/objects
SWITCHYARD_NODE_SHARED_TOKEN=replace-me
SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic
```

Server config already fails closed in staging/production for several dependencies and for R18 hosted auth. R19 should build on this, not duplicate a second config system.

`apps/server/src/config.ts`:

```ts
if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
  requireVar(config.postgresUrl, "SWITCHYARD_POSTGRES_URL", config);
  requireVar(config.redisUrl, "SWITCHYARD_REDIS_URL", config);
  requireVar(config.nodeSharedToken, "SWITCHYARD_NODE_SHARED_TOKEN", config);
  requireVar(hostedRuntimeAllowlistEnv, "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST", config);
  if (config.serverAuthMode !== "api_key") {
    throw new ConfigError("config_forbidden:SWITCHYARD_SERVER_AUTH_MODE", "SWITCHYARD_SERVER_AUTH_MODE", buildSummary(config));
  }
  requireVar(config.apiKeyPepper, "SWITCHYARD_API_KEY_PEPPER", config);
  if (config.controlPlaneStore === "memory") {
    throw new ConfigError("config_forbidden:SWITCHYARD_CONTROL_PLANE_STORE", "SWITCHYARD_CONTROL_PLANE_STORE", buildSummary(config));
  }
}
```

Server readiness already checks Postgres, queue, object store, node token, hosted allowlist, hosted runtime gate, sandbox, control plane, quota, audit, and unowned resources. R19 should make these checks production-grade and part of preflight/canary/runbooks.

`apps/server/src/readiness.ts`:

```ts
checks.apiKeyAuth = strictControlPlane
  ? readinessCheck(controlPlane.mode === "enabled", "api_key_auth_disabled")
  : readinessCheck(true);

checks.controlPlaneStore = strictControlPlane
  ? readinessCheck(controlPlane.storeReady, "control_plane_store_unavailable")
  : readinessCheck(true);

checks.unownedResources = strictControlPlane
  ? readinessCheck(
      unownedVisibleTotal === 0,
      "unowned_resources_present",
      unownedVisibleTotal === 0 ? undefined : redactSecrets({ runs: unowned?.runs ?? 0 })
    )
  : readinessCheck(true);
```

Worker readiness exists but is not yet a deployment-facing production contract. R19 must make worker startup/claim behavior fail closed when readiness fails.

`apps/worker/src/worker.ts`:

```ts
ready: async () => {
  try {
    await postgresReady;
    if (postgres) {
      await probePostgresDatabase(postgres);
    }
    await queue.stats();
    if (config.objectStore.probe !== "disabled") {
      await artifactContent.probe();
    }
```

The hosted metrics surface is JSON and already includes dependency and queue counters. R19 should document and verify the production operator path to access it through admin API-key auth.

`apps/server/src/metrics.ts`:

```ts
queue: { available: true, enqueue: 0, claim: 0, ack: 0, retry: 0, failed: 0, exhausted: 0, queued: 0, claimed: 0 },
objectStore: { reads: 0, writes: 0, failures: 0, probeFailures: 0, authFailures: 0, unavailable: 0, digestMismatches: 0 },
controlPlane: { ready: 0, notReady: 0 },
dependencies: { ready: 0, notReady: 0 },
```

The current required no-spend verification set is R18-focused. R19 must add a production-hosted verification command without introducing live external provider calls.

`docs/development/DEVELOPMENT.md`:

```bash
pnpm --filter @switchyard/daemon test -- smoke
pnpm --filter @switchyard/sdk test -- client
pnpm --filter @switchyard/cli test -- run-cli
pnpm --filter @switchyard/contracts openapi:check
pnpm --filter @switchyard/contracts openapi:check:hosted
pnpm typecheck
git diff --check
```

## User/Operator Experience

R19 has no end-user UI. The user experience is the operator experience through files, commands, HTTP checks, and logs.

### Scenario 1: Production Preflight

An operator prepares a production env file and bootstrap file, then runs the R19 preflight command. The command validates server, worker, and node env, rejects placeholders and unsafe production values, checks schema compatibility, checks queue/object-store/database config with fake/no-spend probes in tests and real configured dependencies in operator-run environments, prints a redacted summary, and exits `0` only when production can accept traffic.

Failure examples:

- Missing `SWITCHYARD_SERVER_AUTH_MODE=api_key` returns `config_forbidden:SWITCHYARD_SERVER_AUTH_MODE`.
- `SWITCHYARD_API_KEY_PEPPER=replace-me` returns `secret_placeholder:SWITCHYARD_API_KEY_PEPPER`.
- `SWITCHYARD_OBJECT_STORE_PROBE=disabled` in production returns `config_invalid:SWITCHYARD_OBJECT_STORE_PROBE`.
- `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic,codex.exec_json` in production returns `hosted_real_runtime_production_forbidden`.
- Postgres schema is behind the code-required version returns `postgres_schema_migration_required`.
- Postgres schema is newer than this code supports returns `postgres_schema_version_unsupported`.

### Scenario 2: Production Deploy

An operator deploys server and worker containers from production manifests. The server exposes cheap liveness on `/health`, refuses `/ready` until all dependency, control-plane, schema, queue, object-store, hosted-runtime, and unowned-resource checks pass, and protects `/metrics` with an API key that has both `metrics:read` and `admin:read`. The worker performs the same production dependency and hosted-runtime-gate checks before claiming queue jobs. The optional node refuses to start in production without `SWITCHYARD_SERVER_URL`, `SWITCHYARD_NODE_SHARED_TOKEN`, capabilities, runtime-mode allowlist, and CWD-prefix allowlist.

### Scenario 3: Production Canary

After deploy, the operator runs a no-spend canary against the production URL with an admin/operator API key. The canary calls `/ready`, creates a `fake.deterministic` hosted run with `placement: "hosted"` and canary metadata, waits for worker completion through the existing run API, reads run events, reads artifact metadata and content, verifies authenticated `/metrics`, verifies an audit event or ownership trace exists for the canary run, and exits nonzero with a named reason if any step fails.

The canary creates durable audit/run/artifact records. R19 does not add delete APIs, so the runbook must treat canary records as expected production evidence and provide a query pattern to identify them by metadata.

### Scenario 4: Rollback

If deployment fails after migrations, the operator can roll back server/worker code while preserving additive schema changes. Old code must either operate safely against the additive schema or fail readiness with `postgres_schema_version_unsupported` before accepting traffic. Already-queued fake hosted jobs can complete after rollback if the worker gate and schema are compatible; otherwise workers stop claiming and the runbook tells operators to pause workers, drain or inspect the queue, and redeploy the last known-good image.

## Functional Requirements

### FR1: Production Deployment Manifest Pack

- Add a provider-neutral production deployment pack under `deploy/production/` or an equivalent explicit production path. It must be separate from `deploy/self-hosted/` so staging examples are not mistaken for production.
- The production pack must include server and worker manifests. A connected node manifest may be included only as an optional companion and must remain fake-runtime-only by default.
- Production manifests must use production commands, not `pnpm --filter ... dev`. Acceptable commands are built package entrypoints, `pnpm start` scripts that run built output, or an equivalent production Node entrypoint.
- Production manifests must include health/liveness checks for server `/health` and readiness checks for server `/ready`. Worker readiness must be represented by a command or startup gate that fails before job claiming.
- Production manifests must default `SWITCHYARD_DEPLOYMENT_MODE=production`, `SWITCHYARD_SERVER_AUTH_MODE=api_key`, `SWITCHYARD_CONTROL_PLANE_STORE=postgres`, `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic`, and `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled`.
- Production env examples must use placeholders that are visibly invalid, such as `replace-with-...`, and production config validation must reject those placeholders. Examples must not contain real-looking secrets.
- Production manifests must not declare public `/sandbox`, `/exec`, `/pty`, `/terminal`, browser, real-tool, payment, OAuth, or dashboard services.
- Production manifests must document required external dependencies: Postgres, Redis, and object storage. Required tests may use local containers or fakes, but docs must not imply that memory stores are production-acceptable.

### FR2: Hardened Production Config Validation

- `apps/server`, `apps/worker`, and `apps/node` must treat `SWITCHYARD_DEPLOYMENT_MODE=production` as stricter than local/test and at least as strict as staging.
- Production server validation must require:
  - `SWITCHYARD_POSTGRES_URL`
  - `SWITCHYARD_REDIS_URL`
  - `SWITCHYARD_OBJECT_STORE_BACKEND`
  - object-store backend-specific required keys
  - `SWITCHYARD_NODE_SHARED_TOKEN`
  - `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic` unless a future phase changes the production runtime boundary
  - `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled` or absent
  - `SWITCHYARD_SERVER_AUTH_MODE=api_key`
  - `SWITCHYARD_API_KEY_PEPPER`
  - `SWITCHYARD_CONTROL_PLANE_STORE=postgres`
  - `SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH` or `SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_JSON`
  - `SWITCHYARD_PUBLIC_METRICS` absent or false
- Production worker validation must require Postgres, Redis, object store, hosted runtime allowlist, fake-only production runtime boundary, valid sandbox config, valid worker idle interval, and valid adapter check posture for `fake.deterministic`.
- Production node validation must require `SWITCHYARD_SERVER_URL`, `SWITCHYARD_NODE_SHARED_TOKEN`, `SWITCHYARD_NODE_CAPABILITIES`, `SWITCHYARD_NODE_ALLOW_RUNTIME_MODES`, and `SWITCHYARD_NODE_ALLOW_CWD_PREFIXES`. Production node URLs must be `https://` unless the app is in local/test mode.
- Production validation must reject placeholder, low-signal, or known example secrets for API key pepper, node shared token, Postgres password-bearing URL, Redis password-bearing URL, object-store access keys, and object-store secret keys. `SWITCHYARD_API_KEY_PEPPER` and `SWITCHYARD_NODE_SHARED_TOKEN` must be at least 32 characters in production. Rejected values include at least `replace-me`, `replace-with-*`, `switchyard`, `password`, `secret`, `test`, `example`, and empty/whitespace strings.
- Production validation must not print raw secrets in thrown `ConfigError.redactedConfig`, startup logs, readiness diagnostics, metrics, or canary logs.
- Nil path: missing required env must fail at config load before binding server ports, claiming worker jobs, or registering nodes.
- Empty path: empty strings or whitespace env values must be treated as missing, not as configured.
- Error path: malformed URLs, invalid booleans, invalid numeric intervals, invalid object-store endpoints, failed bootstrap parse, or unsupported production runtime allowlists must return named config errors.

### FR3: Production Preflight

- Add a production preflight command or script, exposed through root `package.json`, that can be run before deploy.
- The command must accept an env file path or run from current process env. It must not require dashboard/TUI interaction.
- The preflight must validate server, worker, and optional node config through the same resolvers used at app startup.
- The preflight must validate the production manifest pack for required env keys and must fail if the manifest references development commands.
- The preflight must validate Postgres schema compatibility. It must distinguish:
  - `postgres_schema_ready`
  - `postgres_schema_migration_required`
  - `postgres_schema_version_unsupported`
  - `postgres_unavailable`
- The preflight must validate queue connectivity and report `queue_ready` or `queue_unavailable`.
- The preflight must validate object-store config and probe posture. In production, `SWITCHYARD_OBJECT_STORE_PROBE=disabled` is invalid.
- The preflight must validate control-plane bootstrap health: active account, tenant, project, user, API key, billing plan, node-token binding when node token is configured, quota store, audit store, and no unowned hosted resources.
- The preflight output must be structured JSON by default or support a `--json` flag. Human-readable output may be added, but machine-readable output is required.
- The preflight must exit nonzero on any failed check and include only redacted diagnostics.
- Required automated tests must run the preflight with fake or local deterministic dependency seams. They must not contact live AWS/R2, model providers, payment providers, external search, GitHub, hosted browsers, or arbitrary commands.

### FR4: Migration And Rollback Gates

- Add an explicit Postgres schema compatibility concept for hosted production. A version table or equivalent durable metadata must record the schema version R19 requires.
- The app must not silently accept production traffic against an incompatible schema. Server `/ready` must return `503` with a named schema code, and worker readiness must fail before claiming jobs.
- Migrations required by R19 must be additive. They may create new tables, indexes, or nullable columns. They must not drop tables, drop columns, rewrite existing data destructively, or make R18-owned nullable columns non-null without a backfill gate.
- If R19 adds a migration command, it must be idempotent and safe to run more than once.
- If startup still calls `ensurePostgresSchema`, production readiness must separately verify that the schema version is compatible. Startup-side schema creation alone is not enough to satisfy R19.
- Rollback docs must specify:
  - how to pause or scale down workers before rollback.
  - how to confirm queue claimed/queued counts.
  - how to deploy the prior server/worker image.
  - how to verify `/ready`, `/metrics`, and fake canary after rollback.
  - what to do if schema version is newer than the rolled-back code supports.
- Nil path: missing schema metadata in a new empty database may be migrated by the explicit migration step or reported as `postgres_schema_migration_required`.
- Empty path: an empty migration table is equivalent to missing metadata.
- Error path: database connection failure, permission denial, malformed schema metadata, or unsupported version must fail closed with named reasons and redacted diagnostics.

### FR5: Health, Readiness, Metrics, And Canary

- `/health` remains a cheap liveness endpoint and must not perform dependency probes.
- `/ready` remains the production dependency gate and must include schema compatibility in addition to existing Postgres, queue, object store, node token, hosted allowlist, hosted runtime gate, sandbox, auth, bootstrap, control-plane store, billing plan, quota, audit, and unowned-resource checks.
- `/ready` must never include raw secrets, raw URLs with embedded credentials, object keys, signed URLs, API keys, node tokens, provider output, or bootstrap secret hashes.
- Production `/metrics` must stay protected by API key auth requiring both `metrics:read` and `admin:read`. R19 must keep public metrics forbidden in production.
- Metrics must expose enough low-cardinality counters for canary/runbook use: dependency ready/not-ready, queue queued/claimed/failed/exhausted, object-store reads/writes/failures/probe failures/auth failures/unavailable/digest mismatches, hosted runtime accepted/denied/started/completed/failed/timeout/unsupported interaction/artifact persisted, auth failures/successes, quota reservations/releases/denials, and audit append/failure.
- Add a production canary command or script exposed through root `package.json`.
- The canary must call existing API surfaces only: `/ready`, `/runs`, `/runs/:id`, `/runs/:id/events`, `/runs/:id/artifacts`, `/artifacts/:id/content`, `/metrics`, and R18 enterprise routes when needed (`/auth/whoami`, `/entitlements`, `/audit/events`).
- The canary must use `fake.deterministic` with `placement: "hosted"` and must set metadata that identifies it as an R19 production canary.
- The canary must prove the worker completed the run and that artifact bytes can be read back.
- The canary must verify auth by using an API key. It must not rely on public hosted routes except `/health`.
- The canary must exit nonzero with a named reason on nil input, empty response, malformed response, auth denial, readiness denial, queue timeout, worker timeout, artifact missing, artifact digest/empty failure, metrics auth failure, audit lookup failure, or unexpected terminal run status.
- The canary must not call model providers, payment providers, AWS/R2 live endpoints in required tests, browser automation, external search, GitHub, or arbitrary process/PTY execution.

### FR6: Server Operational Safety

- Server startup must log a single redacted `server.listening` summary on success and a redacted `server.start_failed` summary on failure.
- Server must not bind and accept production traffic when config validation fails.
- Hosted run creation in production must continue to enforce API key auth, tenant/project ownership, entitlements, quotas, fake-only hosted runtime allowlist, queue availability, and object-store readiness before durable side effects where the existing architecture permits.
- `POST /runs?wait=1` may remain supported for fake deterministic hosted canary flows. It must not permit production hosted real-runtime wait flows.
- Hosted production must not register local-daemon-only middleware routes such as `/tools/invocations`.
- Hosted production must not add public `/sandbox`, `/exec`, `/pty`, `/terminal`, `/shell`, `/process`, `/command`, `/browser`, top-level `/search`, or tool-search execution routes.
- All server errors introduced or touched by R19 must use the existing unified error envelope.

### FR7: Worker Operational Safety

- Worker startup must validate production config before building adapters or touching queue jobs.
- Worker must run readiness checks before the first claim and must not claim queue jobs if Postgres, queue, object store, schema, sandbox, hosted runtime gate, or configured hosted adapters are not ready.
- Worker must keep production allowlist fake-only. Any non-fake runtime mode in production must fail before adapter construction or job claim.
- Worker logs must use hosted-safe redaction for stdout, stderr, task, cwd, command, token, provider output, signed URLs, object keys, and nested provider payloads.
- Worker must continue to revalidate queued job payload and durable run identity at claim time before adapter start.
- Worker startup or tick loops must surface queue stale-claim recovery and retry exhaustion through existing queue metrics or logs.
- Nil path: empty queue returns no work without error.
- Empty path: a queue job with missing payload or missing run id is discarded or failed with `queue_payload_invalid` and does not start adapters.
- Error path: queue unavailable, DB unavailable, object store unavailable, schema incompatible, or adapter readiness failure leaves the job unclaimed or terminally failed with a named reason according to the existing queue/run lifecycle.

### FR8: Node Operational Safety

- Production node startup must fail closed without server URL, shared token, capabilities, runtime-mode allowlist, and CWD-prefix allowlist.
- Production node must reject `http://` server URLs unless local/test mode is used. Production examples must use `https://`.
- Production node defaults remain `fake.deterministic` only. R19 must not add connected-node real tools or hosted real tools.
- Node policy must reject empty allowlists and overly broad CWD prefixes such as `/` in production.
- Node startup logs and error summaries must redact shared tokens and credentials in URLs.
- Nil path: missing node config fails before registration.
- Empty path: empty capability/runtime/CWD allowlists fail before registration.
- Error path: server auth failure, registration failure, policy denial, assignment claim failure, event sync failure, or artifact sync failure remains visible through named errors/logs and never expands execution permissions.

### FR9: Queue, Database, And Object Store Production Checks

- Postgres checks must cover connectivity, schema compatibility, control-plane store availability, quota store availability, audit store availability, and unowned hosted resource counts.
- Redis/queue checks must cover connectivity, stats retrieval, queued/claimed counts, failed/exhausted counts, and stale-claim recovery behavior.
- Object-store checks must cover backend config, HTTPS endpoint enforcement for S3-compatible staging/production, required bucket/region/credential fields, probe write/read/delete posture, missing content, empty content, auth failure, bucket-not-found, timeout, read failure, and digest mismatch.
- Required tests must use fakes, local stores, or deterministic injected clients. Optional live S3/R2/MinIO checks may be documented as operator-owned, but cannot be required for CI/audit.
- Readiness and canary diagnostics must include backend type, endpoint scheme/host, bucket, key prefix, timeout, probe mode, and boolean credential presence only. They must not include secrets or full object keys.

### FR10: Documentation And API Contract Boundary

- Hosted OpenAPI must remain the API source for hosted/server routes. R19 may update readiness/metrics schemas only if generated contract checks are updated.
- Local-daemon OpenAPI must remain no-auth by default and backwards compatible.
- Development docs must include copy/paste production preflight and canary commands, rollout and rollback steps, expected readiness/metrics shapes, and named failure codes.
- Product truth must state that R19 ships production hosted deployment readiness for the existing fake-safe hosted boundary, not a managed SaaS with public signup or production real-runtime execution.
- README must not overclaim managed hosted platform availability. It may say production deployment manifests and no-spend production canary now exist for self-hosted/managed-hosting-ready operation.

## Security/Safety Requirements

- Production hosted execution remains fake-only. `codex.exec_json`, `claude_code.sdk`, `opencode.acp`, `codex.interactive`, AgentField, Generic HTTP, process, PTY, browser, and real tools must be denied in production hosted/server/worker/node paths.
- API key auth remains mandatory for hosted/server protected routes in production.
- `/metrics` remains protected in production by `metrics:read` and `admin:read`.
- `SWITCHYARD_PUBLIC_METRICS=1` remains forbidden in production.
- Control-plane bootstrap must require active account, tenant, project, user, API key, and billing plan for production readiness.
- Existing unowned hosted resources must fail production readiness. R19 must not silently adopt them.
- Secrets must be redacted in:
  - config load failures.
  - startup success/failure logs.
  - readiness diagnostics.
  - preflight output.
  - canary output.
  - worker adapter logs.
  - node logs.
  - audit payloads touched by R19.
  - error envelopes touched by R19.
- Redaction must cover API keys, bearer tokens, secret hashes, node tokens, Postgres/Redis credentials, S3/R2 access keys and secret keys, signed URLs, object keys, provider output, stdout/stderr, task text, cwd, command, and keys containing `token`, `secret`, `password`, `authorization`, `apiKey`, `accessKey`, or `secretAccessKey`.
- Required test fixtures may contain fake secrets, but assertions must prove those fake secrets do not appear in serialized logs, readiness, preflight, canary, metrics, or error output.
- Production node URL policy must prefer HTTPS and must not train operators to send node tokens over public HTTP.
- Production manifests must not expose internal Postgres, Redis, object store, worker, or node ports publicly unless documented as local/private network only.

## Observability

- Server:
  - `server.listening` log includes host, port, deployment mode, and redacted config summary.
  - `server.start_failed` log includes named code and redacted config summary.
  - `/ready` emits one structured readiness object with `ok` and named checks.
  - `/metrics` exposes low-cardinality JSON counters and queue stats when authorized.
- Worker:
  - startup logs include deployment mode, queue name, hosted runtime allowlist, object-store backend, sandbox status, and redacted dependency posture.
  - readiness failure logs include named reason and redacted diagnostics.
  - claim/start/complete/fail paths preserve existing queue and hosted runtime metrics.
- Node:
  - startup logs include redacted server URL, capability count/list, runtime allowlist, CWD-prefix count/list, and deployment mode.
  - registration/heartbeat/claim/sync/complete failures are visible through named logs or returned node protocol errors.
- Preflight:
  - emits structured JSON with check names, status, reason code, and redacted diagnostics.
  - exits nonzero on any failed check.
- Canary:
  - emits structured JSON with step names, run id, artifact id, terminal status, metric authorization result, audit lookup result, elapsed time, and named failure code.
  - never emits task text beyond the static canary label, API keys, node tokens, DB/Redis credentials, object-store credentials, object keys, signed URLs, or raw artifact bytes.
- Alerts/operators should be able to key off:
  - readiness `ok=false`.
  - `postgres_schema_migration_required`.
  - `postgres_schema_version_unsupported`.
  - `queue_unavailable`.
  - queue exhausted count greater than zero.
  - object-store failures/probe failures/auth failures/unavailable/digest mismatches.
  - hosted runtime denied/failed/timeout.
  - auth failures.
  - quota denials.
  - audit append failures.
  - canary nonzero exit.

## Data Flow Shadow Paths

### Production Env File -> Config Resolvers -> App/Preflight Decision

- Happy path: well-formed production env with non-placeholder secrets, fake-only hosted allowlist, API-key auth, Postgres control plane, Redis, object store, and bootstrap produces a redacted config summary and allows preflight/startup to continue.
- Nil path: missing env file or missing required variable fails before startup with `config_required:<VAR>` or `env_file_missing`.
- Empty path: empty env file or empty string variables are treated as missing and fail with named config errors.
- Error path: malformed URLs, invalid booleans, invalid numbers, placeholder secrets, production public metrics, production real-runtime allowlist, or malformed bootstrap fail with named errors and redacted diagnostics.

### Postgres Schema -> Migration Gate -> Readiness

- Happy path: schema exists, version is supported, control-plane tables are present, quota/audit stores are usable, and readiness passes schema checks.
- Nil path: no schema metadata exists in production; preflight reports `postgres_schema_migration_required`.
- Empty path: migration metadata table exists but has no valid current version; readiness reports `postgres_schema_migration_required`.
- Error path: connection failure, permission denial, unsupported future version, malformed version row, or failed migration reports `postgres_unavailable`, `postgres_schema_version_unsupported`, or `postgres_schema_migration_failed`.

### Queue -> Worker Claim -> Run Execution

- Happy path: Redis stats succeeds, worker is ready, fake hosted job is claimed, durable run identity matches queue payload, fake adapter completes, job is acked, run terminal event is stored, artifact is persisted.
- Nil path: no queued job returns no work and keeps worker healthy.
- Empty path: queued job missing required payload fields fails with `queue_payload_invalid` and does not start adapters.
- Error path: Redis unavailable, stale claim exhausted, durable run missing, identity mismatch, schema incompatible, or object store failure produces named queue/run failure and does not silently drop work.

### Object Store -> Artifact Write/Read -> Canary Verification

- Happy path: runtime transcript artifact is written with metadata, canary reads artifact metadata and non-empty content, digest/size checks pass.
- Nil path: artifact record missing returns `artifact_not_found`.
- Empty path: content exists but is zero bytes or metadata says content is not stored returns `artifact_content_empty` or `missing_artifact_content`.
- Error path: auth failure, bucket missing, timeout, read failure, write failure, digest mismatch, or probe cleanup failure returns existing object-store reason codes and redacted diagnostics.

### API-Key Canary -> Hosted API -> Audit/Ownership Evidence

- Happy path: canary API key authenticates, entitlement/quota allow fake hosted run, ownership rows are attached, audit event is appended, metrics key scope is accepted, canary exits `0`.
- Nil path: no API key is provided; canary fails with `auth_required`.
- Empty path: empty API key or whitespace key fails with `auth_required` or `auth_invalid`.
- Error path: insufficient scopes, revoked key, inactive tenant/project/plan, quota denial, audit append failure, or ownership attach failure returns named auth/control-plane/quota/audit errors and no hidden side effects.

### Deployment Manifest -> Orchestrator -> Service Health

- Happy path: production manifest uses production command, starts server/worker with env, liveness checks pass, readiness passes, canary passes.
- Nil path: missing manifest or missing env reference fails preflight with `manifest_missing` or `manifest_env_missing`.
- Empty path: empty manifest, empty service list, or empty command fails preflight with `manifest_invalid`.
- Error path: manifest uses `pnpm dev`, exposes forbidden public route/service, omits health/readiness checks, omits worker startup gate, or references unsafe production env fails preflight with named manifest errors.

## Test/Verification Requirements

Required verification must be deterministic and no-spend.

- Unit/config tests:
  - production server rejects missing Postgres, Redis, object store, node token, auth mode, API key pepper, control-plane store, bootstrap, hosted allowlist, public metrics, placeholder secrets, and production real-runtime allowlists.
  - production worker rejects missing Postgres, Redis, object store, hosted allowlist, invalid worker intervals, placeholder secrets, and production real-runtime allowlists.
  - production node rejects missing server URL, shared token, capabilities, runtime allowlist, CWD prefixes, placeholder tokens, `http://` production server URLs, empty allowlists, and broad `/` CWD prefixes.
- Preflight tests:
  - valid production env with injected fake/local dependencies passes.
  - each nil/empty/error path in the env, manifest, schema, queue, object-store, and control-plane flows returns the expected named reason.
  - serialized preflight output does not contain fake secrets from fixtures.
- Readiness tests:
  - `/ready` returns `200 { ok: true }` when all production checks pass under deterministic dependencies.
  - `/ready` returns `503` with named codes for schema migration required, schema unsupported, queue unavailable, object store unavailable, auth disabled, bootstrap missing, quota store unavailable, audit store unavailable, unowned resources, hosted runtime denied, and sandbox invalid.
  - readiness diagnostics are redacted.
- Canary tests:
  - canary succeeds against an in-process or local deterministic hosted server/worker setup using fake runtime and API key auth.
  - canary fails with named reasons for missing API key, readiness failure, run create denial, worker timeout, artifact missing, artifact empty, metrics auth failure, and audit lookup failure.
  - canary output redacts API keys, node tokens, DB/Redis credentials, object-store credentials, object keys, signed URLs, task/cwd, and raw artifact bytes.
- Migration tests:
  - new empty Postgres-compatible test store reports migration required or migrates idempotently according to the chosen command.
  - migration command is idempotent.
  - unsupported future schema version fails readiness before traffic.
  - migration SQL/code is additive-only; tests or static checks reject `DROP TABLE`, `DROP COLUMN`, destructive rewrites, or production-only non-null backfills without an explicit gate.
- Deployment manifest tests:
  - production manifest validation rejects `pnpm dev`.
  - required server/worker services, env keys, health/readiness checks, and fake-only runtime settings are present.
  - forbidden services/routes/env toggles for dashboard, TUI, payment, OAuth, public exec/sandbox/PTY/terminal, browser, real tools, and hosted real runtime are absent.
- Contract/docs checks:
  - `pnpm --filter @switchyard/contracts openapi:check`
  - `pnpm --filter @switchyard/contracts openapi:check:hosted`
  - `pnpm typecheck`
  - `pnpm test` or focused package tests covering server, worker, node, storage, queue, contracts, and scripts
  - `git diff --check`

Required tests must not call payment providers, model providers, AWS/R2 live services, live GitHub, external search, browser automation, arbitrary process/PTY execution, or public network dependencies. Optional operator-owned live checks must be documented separately and clearly marked as not required for CI/audit.

## Rollout/Rollback

### Rollout

1. Build and publish server/worker/node artifacts or images from the R19 commit.
2. Prepare production env and bootstrap files. Use `fake.deterministic` as the only hosted runtime mode.
3. Run production preflight against the env and manifests. Do not deploy if any check fails.
4. Run the explicit Postgres migration command if preflight reports `postgres_schema_migration_required`.
5. Re-run preflight until schema, queue, object store, control plane, auth, and manifest checks pass.
6. Deploy server with readiness gating. Keep traffic off until `/ready` returns `ok=true`.
7. Deploy worker only after server readiness passes. Worker must pass readiness before claiming jobs.
8. Deploy optional node only when node token binding and node policy are configured.
9. Run production canary with an admin/operator API key.
10. Route production traffic only after canary passes.

### Rollback

1. Stop or scale down workers first to prevent new queue claims.
2. Capture `/metrics` queue `queued`, `claimed`, `failed`, and `exhausted` counts with an authorized metrics key.
3. Deploy the previous server/worker images.
4. If previous code supports the additive schema, verify `/ready` and run the fake hosted canary.
5. If previous code reports `postgres_schema_version_unsupported`, keep traffic off, redeploy R19, or run an operator-approved compatibility migration. R19 must not require destructive rollback migrations.
6. Re-enable workers only after server readiness and canary pass.
7. Record any exhausted or stuck queue jobs as operational follow-up; do not silently drop them.

Rollback must not delete audit events, ownership rows, quota reservations, run records, event records, artifact metadata, or object-store content.

## Documentation Updates

When R19 ships, update:

- `PRODUCT.md`: mark R19 production hosted deployment readiness shipped, state the exact production-safe hosted boundary, and keep the remaining gaps explicit.
- `README.md`: update hosted mode wording to mention production manifests, production preflight, and no-spend canary without claiming managed SaaS, public signup, payment integration, OAuth/SSO, or production real-runtime hosting.
- `docs/development/API.md`: document any readiness/metrics schema additions and production error codes.
- `docs/development/DEVELOPMENT.md`: add R19 production preflight, migration, rollout, rollback, canary, and no-spend verification commands.
- `deploy/production/README.md` or equivalent production runbook: document env keys, secret generation expectations, manifest usage, readiness/canary interpretation, rollback steps, and optional live dependency checks.
- Generated hosted OpenAPI artifacts if any hosted readiness/metrics or error schema changes are made.

No dashboard or TUI documentation should be added.

## Acceptance Criteria

- [ ] A production deployment manifest pack exists outside `deploy/self-hosted/`, uses production commands, includes server and worker deployment definitions, and defaults to fake-only hosted execution.
- [ ] Production server config fails closed for missing/empty/malformed required env, placeholder secrets, public metrics, missing auth/control-plane bootstrap, memory control-plane store, unsafe hosted runtime allowlist, and enabled hosted real-runtime execution.
- [ ] Production worker config fails closed for missing dependencies, placeholder secrets, unsafe hosted runtime allowlist, enabled hosted real-runtime execution, invalid worker settings, and readiness failures before claim.
- [ ] Production node config fails closed for missing token/server URL/capabilities/policy, empty allowlists, broad `/` CWD prefixes, placeholder token, and insecure production server URL.
- [ ] A production preflight command validates config, manifests, schema compatibility, queue, object store, control plane, auth, quota, audit, unowned resources, and hosted runtime gate with structured redacted output.
- [ ] Postgres schema migration compatibility is explicit, durable, idempotent, additive-only, and represented in `/ready` and worker readiness.
- [ ] `/ready` includes named schema checks and keeps all diagnostics redacted.
- [ ] Production `/metrics` remains API-key protected by `metrics:read` plus `admin:read`; public metrics remain forbidden.
- [ ] A no-spend production canary command verifies authenticated ready, fake hosted run creation, worker completion, events, artifacts, artifact content, metrics auth, and audit/ownership evidence.
- [ ] Canary and preflight failures have named reason codes and never leak API keys, node tokens, DB/Redis credentials, object-store credentials, object keys, signed URLs, task text, cwd, provider output, or raw artifact bytes.
- [ ] Production server/worker/node tests cover happy, nil, empty, and error paths for env/config, schema, queue, object store, manifest, and canary flows.
- [ ] Hosted/server OpenAPI checks pass after any readiness/metrics/error contract changes.
- [ ] Local daemon, SDK, CLI, local real tools, local runtime modes, and local debate remain no-auth and backwards compatible by default.
- [ ] Required verification is deterministic/no-spend and does not contact payment providers, model providers, AWS/R2 live services, live GitHub, external search, hosted browsers, or arbitrary process/PTY execution.
- [ ] Product/development/README docs describe R19 accurately and keep all non-goals explicit.

## Release Boundary

After R19, Switchyard should be production-operable as a self-hosted or managed-hosting-ready deployment for the existing safe hosted boundary:

- Hosted server and worker can be deployed from production manifests.
- Production env/config mistakes fail closed before traffic or job claims.
- Production readiness reports auth, control plane, schema, queue, object store, sandbox, runtime gate, quota, audit, and unowned-resource health.
- Operators have no-spend preflight and canary commands.
- Rollout and rollback are documented and guarded by schema compatibility checks.
- Production hosted execution remains `fake.deterministic` only in required manifests and required canaries.

The following remain unshipped after R19 and must not be accidentally pulled into implementation:

- managed SaaS control plane with public signup/self-service.
- payment provider integration.
- OAuth/OIDC/SAML/SSO/SCIM.
- dashboard or TUI.
- production hosted real-runtime execution.
- production arbitrary process/PTY execution or public execution routes.
- hosted/connected-node real tools.
- browser automation.
- Cursor/OpenClaw/Paperclip.
- runtime-specific approval bridge expansion.
- hosted debate with real participant runtimes or model judging.

## Implementation Phases

R19 should ship as one release with five implementation slices. Each slice must be independently testable, but the release is not complete until all acceptance criteria above pass.

### Slice 1: Production Config And Manifest Boundary

**Goal:** Add production manifests and fail-closed production env validation for server, worker, and node.

**Acceptance:**

- Production manifests use production commands and fake-only hosted execution.
- Server/worker/node config tests cover missing, empty, malformed, placeholder, and unsafe production values.
- Manifest validation rejects development commands and forbidden surfaces.

**Non-goals:** cloud-provider Terraform/Helm, dashboard, TUI, OAuth, payment, real-runtime production execution.

**Complexity:** M

### Slice 2: Schema, Preflight, And Rollback Gates

**Goal:** Add explicit Postgres schema compatibility and a production preflight command.

**Acceptance:**

- Preflight reports schema ready, migration required, unsupported version, Postgres unavailable, queue unavailable, object-store unavailable, and control-plane failures with named redacted output.
- Migration behavior is idempotent and additive-only.
- Rollback docs describe worker pause, queue inspection, prior image deploy, readiness, and canary verification.

**Non-goals:** destructive migrations, managed cloud database provisioning, automatic data adoption of unowned resources.

**Complexity:** L

### Slice 3: Readiness, Metrics, Worker, And Node Operational Safety

**Goal:** Make production readiness and operational gates complete for orchestrators.

**Acceptance:**

- `/ready` includes schema compatibility and remains redacted.
- Worker readiness fails before job claim on dependency/schema/runtime-gate failure.
- Node production safety rejects missing/empty/broad/insecure policy.
- Metrics remain protected in production and expose the counters needed by canary/runbooks.

**Non-goals:** new hosted user APIs, public metrics, real connected-node tools.

**Complexity:** M

### Slice 4: Production Canary

**Goal:** Add a deterministic no-spend production canary over existing hosted APIs.

**Acceptance:**

- Canary authenticates, verifies `/ready`, creates fake hosted run, observes completion, reads events/artifacts/content, checks metrics auth, checks audit/ownership evidence, and exits `0`.
- Canary failure cases are named and redacted.
- Canary tests use fake/local deterministic dependencies only.

**Non-goals:** live model/provider canary, payment canary, browser canary, real-runtime canary.

**Complexity:** M

### Slice 5: Docs And Contract Truth

**Goal:** Update product, README, API, development docs, runbooks, and OpenAPI artifacts to reflect R19 truth.

**Acceptance:**

- `PRODUCT.md`, `README.md`, `docs/development/API.md`, and `docs/development/DEVELOPMENT.md` accurately describe R19 and remaining gaps.
- Hosted OpenAPI checks pass if readiness/metrics/error schema changed.
- Docs contain copy/paste preflight, rollout, rollback, and canary commands.

**Non-goals:** dashboard/TUI docs, public tenant self-service docs, payment/OAuth setup docs.

**Complexity:** S
