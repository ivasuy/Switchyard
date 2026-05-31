# Phase 18: R19 Production Hosted Deployment - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-31-phase-18-r19-production-hosted-deployment.md`
**Branch:** `agent/phase-18-r19-production-hosted-deployment`
**Complexity:** L

## Goal

Ship production-operability for the existing safe hosted boundary: provider-neutral production manifests, fail-closed production config, explicit Postgres schema/migration gates, production readiness, worker/node operational gates, no-spend preflight/canary commands, and product/API/development truth, while production hosted execution remains `fake.deterministic` only.

## Scope Challenge

1. Existing code already partially solves this through `apps/server/src/config.ts`, `apps/server/src/readiness.ts`, `apps/server/src/app.ts`, `apps/worker/src/config.ts`, `apps/worker/src/worker.ts`, `apps/node/src/config.ts`, `packages/storage/src/postgres/database.ts`, `packages/storage/src/object-store-config.ts`, hosted metrics, R18 control-plane bootstrap/readiness, hosted OpenAPI generation, and `deploy/self-hosted/`. Extend those paths; do not create a parallel config system, second readiness schema, new web server, new queue abstraction, or provider-specific deploy stack.
2. Minimum useful change: production manifests outside `deploy/self-hosted/`, stricter production env validation, explicit schema compatibility and migration command, readiness/schema checks, worker claim gates, node production policy gates, preflight/canary scripts, and docs. Dashboard, TUI, payments, OAuth/SSO/SCIM, public tenant self-service, production hosted real runtimes, public exec/sandbox/terminal routes, hosted/connected-node real tools, browser automation, Cursor/OpenClaw/Paperclip, runtime-specific approval bridges, hosted debate/model judging, and provider-specific Terraform/Helm/Fly/Render/AWS modules stay out.
3. Complexity smell: this phase necessarily touches more than 8 files because production operability spans deploy artifacts, server/worker/node config, storage schema gates, readiness, scripts, contracts, and docs. The plan contains 6 task-scoped worktrees with disjoint file ownership and no new runtime services beyond one shared production-config guard helper and one Postgres schema-compatibility helper.
4. Built-in check: use existing Zod contracts/OpenAPI generator, Fastify routes/hooks, Node `URL`, Node `crypto`, Node `fs/promises`, global `fetch`, existing `pg`/Drizzle-shaped Postgres handle, existing BullMQ queue adapter, existing object-store resolver/probe, existing `redactSecrets`, existing Vitest scripts, and JSON for machine-readable production manifest validation. Do not add YAML parsers, cloud SDKs beyond the existing storage S3 client, auth frameworks, logging frameworks, payment SDKs, browser automation, PTY packages, or shell/process execution surfaces.
5. Distribution check: no new npm package or managed hosted artifact ships. Distribution changes are provider-neutral files under `deploy/production/`, root package scripts for `production:preflight`, `production:migrate`, and `production:canary`, and updated hosted OpenAPI JSON when schema docs change. Local daemon, SDK, CLI, local metrics, local OpenAPI, local real tools, local runtimes, and local debate remain no-auth/backwards compatible by default.

## Architecture

R19 is an ops boundary around the existing hosted/server stack. Production manifests start only the hosted server, hosted worker, optional connected node, and private dependencies. Production config validation rejects missing/empty/placeholder/unsafe values before server binding, worker job claims, or node registration. Production runtime policy remains fake-only: `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic` and `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled`.

```text
env file + production manifest
  -> production preflight
       -> server/worker/node config resolvers
       -> manifest JSON validation
       -> Postgres schema compatibility
       -> queue stats
       -> object-store probe
       -> control-plane bootstrap/store/quota/audit/unowned checks
       -> redacted JSON verdict
  -> production deploy
       -> /health cheap liveness
       -> /ready dependency/schema/control-plane gate
       -> worker ready before first claim
       -> optional node HTTPS/policy gate before registration
  -> production canary
       -> API-key auth
       -> /ready
       -> fake hosted run
       -> worker completion
       -> events + artifact metadata/content
       -> protected /metrics
       -> audit/ownership evidence
```

Postgres schema compatibility is explicit and durable. `ensurePostgresSchema` may keep creating additive tables for existing local/test/staging compatibility, but production readiness and worker readiness must call a separate compatibility helper that reads `schema_metadata` and returns one of `postgres_schema_ready`, `postgres_schema_migration_required`, `postgres_schema_version_unsupported`, `postgres_schema_malformed`, or `postgres_unavailable`. The migration command is idempotent, writes the R19 schema version after additive table/index creation, and is safe to rerun.

The canary uses only existing hosted HTTP APIs. It does not invoke model providers, payment providers, AWS/R2 live endpoints in tests, GitHub, search, browsers, arbitrary commands, PTY, real tools, or real runtimes. It writes durable run/audit/artifact records intentionally; docs make those records expected production evidence and identify them with metadata.

## File Structure

- `deploy/production/*` - provider-neutral production manifest pack, invalid-placeholder env example, bootstrap example, machine-readable manifest JSON, manifest tests, and production runbook.
- `packages/core/src/services/production-config-guards.ts` - shared placeholder/minimum-secret/production URL and allowlist guard helpers used by server, worker, and node config.
- `apps/server/src/config.ts`, `apps/worker/src/config.ts`, `apps/node/src/config.ts` - stricter production validation while preserving local/test defaults.
- `packages/storage/src/postgres/database.ts`, `schema.ts`, `index.ts` - Postgres schema metadata, compatibility check, migration command surface, and additive-migration policy.
- `apps/server/src/app.ts`, `readiness.ts`, `metrics.ts`, `main.ts` - production schema readiness, redacted startup logs, and preserved protected metrics.
- `apps/worker/src/worker.ts`, `main.ts`, `ready.ts` - worker readiness before claims and orchestrator-friendly readiness command.
- `apps/node/src/main.ts` - redacted node startup/failure logs.
- `scripts/production-preflight.ts`, `production-migrate.ts`, `production-canary.ts` - no-spend operator commands with dependency injection for deterministic tests.
- `packages/contracts/src/openapi.ts`, `openapi.contract.test.ts`, `packages/contracts/openapi.hosted-server.json` - hosted readiness/metrics contract truth if shape changes.
- `PRODUCT.md`, `README.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md` - R19 product/API/development truth.

## Existing Context

`apps/server/src/config.ts` already has staging/production fail-closed auth and dependency checks:

```ts
if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
  requireVar(config.postgresUrl, "SWITCHYARD_POSTGRES_URL", config);
  requireVar(config.redisUrl, "SWITCHYARD_REDIS_URL", config);
  requireVar(config.nodeSharedToken, "SWITCHYARD_NODE_SHARED_TOKEN", config);
  requireVar(hostedRuntimeAllowlistEnv, "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST", config);
  if (config.serverAuthMode !== "api_key") {
    throw new ConfigError("config_forbidden:SWITCHYARD_SERVER_AUTH_MODE", "SWITCHYARD_SERVER_AUTH_MODE", buildSummary(config));
  }
}
```

`apps/server/src/readiness.ts` already returns a structured `{ ok, checks }` object and redacts diagnostics:

```ts
checks.unownedResources = strictControlPlane
  ? readinessCheck(unownedVisibleTotal === 0, "unowned_resources_present", ...)
  : readinessCheck(true);
```

`apps/worker/src/worker.ts` has a readiness method but `tick()` currently goes directly to queue processing after `postgresReady`:

```ts
tick: async () => {
  await postgresReady;
  return service.processNext();
}
```

`apps/node/src/config.ts` already requires node URL/token/capabilities/runtime/CWD allowlists for staging/production, but it does not yet require HTTPS or reject broad production CWD prefixes:

```ts
if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
  requireVar(optional(env["SWITCHYARD_SERVER_URL"]), "SWITCHYARD_SERVER_URL", config);
  requireVar(sharedToken, "SWITCHYARD_NODE_SHARED_TOKEN", config);
}
```

`packages/storage/src/postgres/database.ts` currently creates tables but has no durable schema compatibility metadata:

```ts
export async function ensurePostgresSchema(handle: PostgresDatabaseHandle): Promise<void> {
  await handle.pool.query(`CREATE TABLE IF NOT EXISTS runs (...); ...`);
}
```

`deploy/self-hosted/docker-compose.yml` is explicitly staging-oriented and uses dev commands:

```yml
command: ["sh", "-lc", "corepack enable && pnpm install --frozen-lockfile && pnpm --filter @switchyard/server dev"]
environment:
  SWITCHYARD_DEPLOYMENT_MODE: staging
```

## Task Graph

### Task P18-T1-production-manifest-pack: Add Production Manifest Pack

**id:** `P18-T1-production-manifest-pack`
**title:** `Add production manifest pack`

**files:**
- Create: `deploy/production/docker-compose.yml`
- Create: `deploy/production/manifest.json`
- Create: `deploy/production/.env.example`
- Create: `deploy/production/bootstrap.example.json`
- Create: `deploy/production/README.md`
- Create: `deploy/production/production-manifest.test.ts`

**dependencies:** []

**context_files:**
- `docs/superpowers/specs/2026-05-31-phase-18-r19-production-hosted-deployment.md` - R19 manifest and production boundary requirements.
- `deploy/self-hosted/docker-compose.yml` - staging compose shape that must not be promoted as production.
- `deploy/self-hosted/.env.example` - existing env naming pattern and object-store examples.
- `apps/server/src/main.ts` - production server entrypoint and startup log behavior.
- `apps/worker/src/worker.ts` - current worker readiness behavior; production manifest must rely on the R19 worker readiness gate from P18-T4.
- `package.json` - root script style and existing smoke command naming.

**instructions:**
1. Create `deploy/production/manifest.json` as the machine-readable production manifest source used by preflight. It must define `server`, `worker`, and optional `node` services with production commands, required env keys, expected health/readiness checks, private dependency references, and forbidden-surface assertions.
2. Create `deploy/production/docker-compose.yml` as a provider-neutral production example, separate from `deploy/self-hosted/`. It may use placeholder image names such as `replace-with-switchyard-server-image`, but it must not use `pnpm ... dev`, `pnpm install`, bind-mounted source, dashboard/TUI/payment/OAuth/browser/tool services, or public internal dependency ports. Server command should run built output such as `node apps/server/dist/main.js`; worker command should run a built readiness gate from P18-T4 before `node apps/worker/dist/main.js`; optional node command should run `node apps/node/dist/main.js`.
3. Add health/liveness checks for server `/health` and readiness checks for server `/ready` using Node 22 global `fetch` or another production-safe built-in available in the container image. Worker readiness must be represented by `node apps/worker/dist/ready.js` or the equivalent built command owned by P18-T4.
4. Add `.env.example` with visibly invalid placeholders (`replace-with-...`) for every production secret and required setting. Defaults must include `SWITCHYARD_DEPLOYMENT_MODE=production`, `SWITCHYARD_SERVER_AUTH_MODE=api_key`, `SWITCHYARD_CONTROL_PLANE_STORE=postgres`, `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic`, `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled`, `SWITCHYARD_OBJECT_STORE_PROBE=write_read_delete`, and `SWITCHYARD_PUBLIC_METRICS=0` or absent.
5. Add `bootstrap.example.json` with one active account, tenant, project, user, API key record using `rawKey` placeholder, active billing plan allowing only `fake.deterministic`, and a node-token binding placeholder. No real-looking secret or hash should appear.
6. Write `deploy/production/README.md` as the production runbook: dependency requirements, secret generation expectations, preflight/migrate/canary commands from P18-T5, rollout order, rollback order, readiness/metrics interpretation, canary record retention, and optional live dependency checks clearly marked as operator-owned and not CI/audit-required.
7. Write `production-manifest.test.ts` with deterministic tests that JSON-parse `manifest.json` and text-scan `docker-compose.yml`/`.env.example` for required defaults, production commands, required health/readiness checks, fake-only runtime posture, invalid placeholders, and forbidden services/routes/toggles.

**acceptance:**
- `deploy/production/` exists and is separate from `deploy/self-hosted/`.
- Server and worker production service definitions exist; node is optional and fake-only by default.
- No production manifest command includes `dev`, `pnpm install`, or source bind mounts.
- Production defaults include production deployment mode, API-key auth, Postgres control-plane store, fake-only hosted runtime allowlist, hosted real runtime disabled, and non-disabled object-store probe.
- Env/bootstrap examples use invalid placeholders and no real-looking secrets.
- Manifests do not declare dashboard, TUI, payment, OAuth, browser, real-tool, public exec/sandbox/PTY/terminal, or hosted real-runtime services.
- Manifest tests are deterministic and no-spend.

**checks:**
- `pnpm exec vitest run deploy/production/production-manifest.test.ts`
- `git diff --check deploy/production`

**error_rescue_map:**
- `{ "codepath": "manifest.json parse", "failure": "manifest missing or malformed JSON", "exception": "SyntaxError", "rescue": "Fail manifest test/preflight with manifest_missing or manifest_invalid", "user_sees": "Preflight JSON includes check=manifest status=fail code=manifest_invalid" }`
- `{ "codepath": "production command validation", "failure": "service command uses dev/install/source bind mount", "exception": "Vitest assertion failure", "rescue": "Replace with built Node entrypoint command", "user_sees": "Production runbook shows built artifact commands only" }`
- `{ "codepath": "env example validation", "failure": "placeholder looks usable or secret is omitted", "exception": "Vitest assertion failure", "rescue": "Use replace-with-* placeholders and include all required env keys", "user_sees": "Operators cannot accidentally copy a valid-looking example secret" }`
- `{ "codepath": "forbidden surface scan", "failure": "manifest declares dashboard/TUI/payment/OAuth/exec/browser/real-tool/real-runtime service", "exception": "Vitest assertion failure", "rescue": "Remove service/env toggle from production manifest", "user_sees": "R19 deploy pack remains API/ops-only" }`

**observability:**
- `logs`: []
- `success_metric`: `production manifest test passes and manifest JSON lists server/worker plus optional node with fake-only production posture`
- `failure_metric`: `manifest validation failure code such as manifest_invalid, manifest_forbidden_command, or manifest_forbidden_surface`

**test_cases:**
- `{ "name": "manifest has production server and worker", "lens": "happy", "given": "JSON.parse(deploy/production/manifest.json)", "expect": "services.server and services.worker exist with deploymentMode production" }`
- `{ "name": "optional node is fake-only", "lens": "happy", "given": "manifest services.node if present", "expect": "runtime allowlist is fake.deterministic and no real-tool capability appears" }`
- `{ "name": "dev commands rejected", "lens": "error_path", "given": "docker-compose.yml text", "expect": "does not contain pnpm install, pnpm --filter @switchyard/server dev, or @switchyard/worker dev" }`
- `{ "name": "health and readiness checks present", "lens": "integration", "given": "docker-compose.yml text", "expect": "server healthcheck references /health and /ready; worker references built readiness gate" }`
- `{ "name": "env example uses invalid placeholders", "lens": "happy_shadow_empty", "given": "deploy/production/.env.example", "expect": "required secrets use replace-with-* and not switchyard/password/secret/test/example" }`
- `{ "name": "forbidden production services absent", "lens": "edge_boundary", "given": "manifest services and compose text", "expect": "no dashboard, tui, payment, oauth, browser, exec, sandbox, pty, terminal, real tool, or hosted real runtime service" }`

**integration_contracts:**
- `exports`:
  - `{ "name": "productionManifestJson", "kind": "constant", "signature": "deploy/production/manifest.json => { services: { server: ServiceManifest; worker: ServiceManifest; node?: ServiceManifest }, requiredEnv: string[], forbiddenSurfaces: string[] }", "file": "deploy/production/manifest.json" }`
  - `{ "name": "productionEnvExample", "kind": "constant", "signature": "deploy/production/.env.example with production defaults and invalid placeholders", "file": "deploy/production/.env.example" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`: ["deploy/production/manifest.json", "deploy/production/.env.example", "deploy/production/docker-compose.yml", "deploy/production/README.md"]

### Task P18-T2-production-config-hardening: Harden Production Config Validation

**id:** `P18-T2-production-config-hardening`
**title:** `Harden production config validation`

**files:**
- Create: `packages/core/src/services/production-config-guards.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/worker/src/config.ts`
- Modify: `apps/node/src/config.ts`
- Create: `packages/core/test/production-config-guards.test.ts`
- Create: `apps/server/test/production-config.test.ts`
- Create: `apps/worker/test/production-config.test.ts`
- Create: `apps/node/test/production-config.test.ts`

**dependencies:** []

**context_files:**
- `docs/superpowers/specs/2026-05-31-phase-18-r19-production-hosted-deployment.md` - FR2/FR6/FR7/FR8 and production secret rules.
- `apps/server/src/config.ts` - current server config resolver and ConfigError shape.
- `apps/worker/src/config.ts` - current worker config resolver and hosted runtime gate.
- `apps/node/src/config.ts` - current node config resolver and local defaults.
- `packages/storage/src/object-store-config.ts` - existing object-store backend/probe/HTTPS validation to reuse.
- `packages/core/src/services/hosted-runtime-catalog.ts` - existing hosted runtime allowlist validation and fake-only production rule.

**instructions:**
1. Add shared core helpers that return structured validation failures rather than throwing app-specific errors: `validateProductionSecret`, `validateProductionUrlCredential`, `validateProductionFakeOnlyAllowlist`, `validateProductionHttpsUrl`, `validateProductionCwdPrefixes`, and `isPlaceholderSecret`. Reuse existing `redactSecrets` for any summary payload.
2. Placeholder/low-signal strings rejected in production must include empty/whitespace, `replace-me`, `replace-with-*`, `switchyard`, `password`, `secret`, `test`, and `example` case-insensitively. `SWITCHYARD_API_KEY_PEPPER` and `SWITCHYARD_NODE_SHARED_TOKEN` must be at least 32 characters in production.
3. Server production validation must require Postgres, Redis, object-store backend-specific settings via the existing resolver, node shared token, hosted allowlist exactly `fake.deterministic`, hosted real runtime disabled or absent, API-key auth, API-key pepper, Postgres control-plane store, bootstrap path or JSON, and public metrics absent/false. Reject placeholder credentials in API-key pepper, node token, Postgres URL password, Redis URL password, S3 access key id, and S3 secret access key. Keep staging at least as strict as today but do not break existing local/test no-auth defaults.
4. Worker production validation must require Postgres, Redis, object store, non-disabled object-store probe via existing resolver, hosted allowlist exactly `fake.deterministic`, hosted real runtime disabled or absent, valid sandbox config, valid idle interval, and fake deterministic adapter-check posture. Reject placeholder URL credentials and S3 credentials.
5. Node production validation must require `SWITCHYARD_SERVER_URL`, `SWITCHYARD_NODE_SHARED_TOKEN`, `SWITCHYARD_NODE_CAPABILITIES`, `SWITCHYARD_NODE_ALLOW_RUNTIME_MODES`, and `SWITCHYARD_NODE_ALLOW_CWD_PREFIXES`. Production server URL must be `https://`. Runtime allowlist must be exactly `fake.deterministic`. CWD prefixes must be non-empty and must reject `/`, `.`/`..`, blank strings, backslash paths, and drive-root-style values in production.
6. Ensure all `ConfigError.redactedConfig` payloads expose only booleans, counts, deployment mode, endpoint scheme/host from existing redacted object-store summary, and allowlist names. They must not include raw URLs with credentials, API keys, node tokens, object keys, or raw bootstrap values.
7. Add focused production config tests for happy, nil, empty, placeholder, malformed, unsafe allowlist, public metrics, bad URL, invalid numeric, and redaction paths. Include explicit local/test compatibility assertions for no-auth local daemon-adjacent behavior: defaults continue to parse without API keys, Postgres, Redis, object store, or node token.

**acceptance:**
- Production server rejects missing/empty/malformed Postgres, Redis, object store, node token, auth mode, API-key pepper, control-plane store, bootstrap, public metrics, placeholder secrets, unsafe hosted runtime allowlists, and enabled hosted real runtime execution.
- Production worker rejects missing dependencies, placeholder secrets, unsafe hosted runtime allowlist, enabled hosted real runtime execution, disabled object-store probe, invalid worker settings, and invalid sandbox config.
- Production node rejects missing server URL/token/capabilities/runtime/CWD policy, empty allowlists, broad `/` CWD prefixes, placeholder token, non-fake runtime allowlist, and insecure `http://` URL.
- Config errors use named codes and redacted summaries.
- Local/test server, worker, and node defaults remain backwards compatible.

**checks:**
- `pnpm --filter @switchyard/core test -- production-config-guards`
- `pnpm --filter @switchyard/server test -- production-config`
- `pnpm --filter @switchyard/worker test -- production-config`
- `pnpm --filter @switchyard/node test -- production-config`
- `pnpm --filter @switchyard/core typecheck`
- `pnpm --filter @switchyard/server typecheck`
- `pnpm --filter @switchyard/worker typecheck`
- `pnpm --filter @switchyard/node typecheck`

**error_rescue_map:**
- `{ "codepath": "loadServerConfig production required vars", "failure": "nil or whitespace env value", "exception": "ConfigError code=config_required:<VAR>", "rescue": "Treat optional('   ') as undefined and fail before app binding", "user_sees": "Startup/preflight fails with config_required:<VAR> and redacted config" }`
- `{ "codepath": "loadServerConfig production secrets", "failure": "placeholder or short API pepper/node token/URL credential", "exception": "ConfigError code=secret_placeholder:<VAR> or secret_too_short:<VAR>", "rescue": "Reject and include only has<Secret>=true/counts in summary", "user_sees": "Startup/preflight fails with named secret code and no raw secret" }`
- `{ "codepath": "loadServerConfig hosted runtime gate", "failure": "production allowlist contains codex/claude/opencode or real runtime enabled", "exception": "ConfigError code=hosted_real_runtime_production_forbidden or config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION", "rescue": "Require exact fake.deterministic and disabled real-runtime flag", "user_sees": "Production startup/preflight refuses unsafe runtime posture" }`
- `{ "codepath": "loadWorkerConfig object-store probe", "failure": "production object-store probe disabled", "exception": "ConfigError code=config_invalid:SWITCHYARD_OBJECT_STORE_PROBE", "rescue": "Propagate existing object-store resolver failure with redacted object-store summary", "user_sees": "Worker/preflight fails before job claim" }`
- `{ "codepath": "loadNodeConfig production URL", "failure": "http:// server URL in production", "exception": "ConfigError code=config_invalid:SWITCHYARD_SERVER_URL", "rescue": "Allow http only in local/test; require https in production", "user_sees": "Node refuses to register over insecure production URL" }`
- `{ "codepath": "loadNodeConfig CWD policy", "failure": "empty or broad cwd prefix", "exception": "ConfigError code=config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES", "rescue": "Reject /, blank, dot segments, and root-like values", "user_sees": "Node startup/preflight fails before registration" }`

**observability:**
- `logs`: ["config load failures are surfaced by existing server/worker/node start_failed logs from P18-T4 with ConfigError.code and redactedConfig"]
- `success_metric`: `all production config tests pass and local/test compatibility tests prove defaults unchanged`
- `failure_metric`: `ConfigError code frequency by named config/secret variable in preflight output or startup logs`

**test_cases:**
- `{ "name": "valid production server env parses", "lens": "happy", "given": "production env with Postgres/Redis/local object store, api_key auth, postgres control plane, bootstrap JSON, 32+ char pepper/token, fake.deterministic allowlist", "expect": "loadServerConfig returns deploymentMode production and redacted summary has booleans only" }`
- `{ "name": "missing production server postgres fails", "lens": "happy_shadow_nil", "given": "delete SWITCHYARD_POSTGRES_URL", "expect": "throws config_required:SWITCHYARD_POSTGRES_URL" }`
- `{ "name": "empty production server pepper fails", "lens": "happy_shadow_empty", "given": "SWITCHYARD_API_KEY_PEPPER='   '", "expect": "throws config_required:SWITCHYARD_API_KEY_PEPPER or secret_placeholder:SWITCHYARD_API_KEY_PEPPER without leaking value" }`
- `{ "name": "placeholder production secrets rejected", "lens": "error_path", "given": "pepper replace-with-pepper, node token replace-me, Postgres password=password", "expect": "throws secret_placeholder for the matching variable and serialized error omits raw values" }`
- `{ "name": "production public metrics forbidden", "lens": "error_path", "given": "SWITCHYARD_PUBLIC_METRICS=1", "expect": "throws config_forbidden:SWITCHYARD_PUBLIC_METRICS" }`
- `{ "name": "production real runtime allowlist rejected", "lens": "error_path", "given": "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic,codex.exec_json", "expect": "throws hosted_real_runtime_production_forbidden" }`
- `{ "name": "valid production worker env parses", "lens": "happy", "given": "production worker env with fake.deterministic, Redis, Postgres, object store, probe write_read_delete", "expect": "loadWorkerConfig returns production and hostedRealRuntimeExecution disabled" }`
- `{ "name": "worker disabled probe rejected", "lens": "error_path", "given": "SWITCHYARD_OBJECT_STORE_PROBE=disabled in production", "expect": "throws config_invalid:SWITCHYARD_OBJECT_STORE_PROBE" }`
- `{ "name": "node production requires https", "lens": "error_path", "given": "SWITCHYARD_SERVER_URL=http://server:4646 with production mode", "expect": "throws config_invalid:SWITCHYARD_SERVER_URL" }`
- `{ "name": "node broad cwd rejected", "lens": "error_path", "given": "SWITCHYARD_NODE_ALLOW_CWD_PREFIXES=/", "expect": "throws config_invalid:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES" }`
- `{ "name": "local defaults unchanged", "lens": "integration", "given": "loadServerConfig({}), loadWorkerConfig({}), loadNodeConfig({ SWITCHYARD_DEPLOYMENT_MODE:'local' })", "expect": "no auth/dependency requirements and fake local defaults preserved" }`

**integration_contracts:**
- `exports`:
  - `{ "name": "validateProductionSecret", "kind": "function", "signature": "validateProductionSecret(input: { variable: string; value?: string; minLength?: number }) => { ok: true } | { ok: false; code: string; variable: string }", "file": "packages/core/src/services/production-config-guards.ts" }`
  - `{ "name": "validateProductionUrlCredential", "kind": "function", "signature": "validateProductionUrlCredential(input: { variable: string; value?: string; credential: 'password' }) => { ok: true } | { ok: false; code: string; variable: string }", "file": "packages/core/src/services/production-config-guards.ts" }`
  - `{ "name": "validateProductionFakeOnlyAllowlist", "kind": "function", "signature": "validateProductionFakeOnlyAllowlist(allowlist: readonly string[]) => { ok: true } | { ok: false; code: string; variable: 'SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST' }", "file": "packages/core/src/services/production-config-guards.ts" }`
  - `{ "name": "validateProductionHttpsUrl", "kind": "function", "signature": "validateProductionHttpsUrl(input: { variable: string; value?: string }) => { ok: true } | { ok: false; code: string; variable: string }", "file": "packages/core/src/services/production-config-guards.ts" }`
  - `{ "name": "validateProductionCwdPrefixes", "kind": "function", "signature": "validateProductionCwdPrefixes(prefixes: readonly string[]) => { ok: true } | { ok: false; code: string; variable: 'SWITCHYARD_NODE_ALLOW_CWD_PREFIXES' }", "file": "packages/core/src/services/production-config-guards.ts" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`: ["apps/server/src/config.ts", "apps/worker/src/config.ts", "apps/node/src/config.ts", "packages/core/src/services/production-config-guards.ts"]

### Task P18-T3-postgres-schema-migration-gates: Add Postgres Schema Compatibility And Migration Gates

**id:** `P18-T3-postgres-schema-migration-gates`
**title:** `Add Postgres schema compatibility and migration gates`

**files:**
- Modify: `packages/storage/src/postgres/database.ts`
- Modify: `packages/storage/src/postgres/schema.ts`
- Modify: `packages/storage/src/index.ts`
- Create: `packages/storage/test/postgres-schema-compat.test.ts`
- Create: `packages/storage/test/postgres-migration-policy.test.ts`

**dependencies:** []

**context_files:**
- `docs/superpowers/specs/2026-05-31-phase-18-r19-production-hosted-deployment.md` - FR4 schema compatibility and rollback gate requirements.
- `packages/storage/src/postgres/database.ts` - current `ensurePostgresSchema` and `probePostgresDatabase` behavior.
- `packages/storage/src/postgres/schema.ts` - Drizzle table declarations that need schema metadata.
- `packages/storage/src/sqlite/database.ts` - existing schema metadata and additive migration policy pattern.
- `packages/storage/src/sqlite/database.hardening.test.ts` - destructive migration policy test style.
- `packages/storage/test/postgres-storage.test.ts` - current Postgres real/fake test pattern.

**instructions:**
1. Add `POSTGRES_SCHEMA_VERSION = 19` and a durable `schema_metadata` table with key/value/updated_at columns. Export a typed compatibility result:
   `type PostgresSchemaCompatibility = { ok: true; code: 'postgres_schema_ready'; version: number } | { ok: false; code: 'postgres_schema_migration_required' | 'postgres_schema_version_unsupported' | 'postgres_schema_malformed' | 'postgres_unavailable'; version?: number; diagnostics?: Record<string, unknown> }`.
2. Keep `ensurePostgresSchema(handle)` idempotent and additive for existing local/test/staging compatibility, but do not rely on startup-side schema creation as the production gate. Add `migratePostgresSchema(handle)` that runs additive table/index creation and writes `schema_metadata('schema_version') = POSTGRES_SCHEMA_VERSION`.
3. Add `checkPostgresSchemaCompatibility(handle, options?)` that probes DB connectivity, reads schema metadata, treats missing table/missing row/empty row as `postgres_schema_migration_required`, treats numeric versions greater than `POSTGRES_SCHEMA_VERSION` as `postgres_schema_version_unsupported`, treats malformed values as `postgres_schema_malformed`, and returns `postgres_schema_ready` only for supported current version.
4. Add `assertPostgresMigrationSqlAdditive(sql)` or equivalent static guard that rejects `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, destructive `ALTER COLUMN ... SET NOT NULL`, and broad rewrite statements. Use it against every SQL block owned by the migration command in tests.
5. Ensure all diagnostics are redacted and low-cardinality: code, expectedVersion, actualVersion, and metadata presence only. Never include connection strings, table contents, SQL text with secrets, or row payloads in readiness/preflight outputs.
6. Tests must use deterministic fake Postgres handles for missing metadata, empty metadata, malformed metadata, ready version, future version, unavailable database, idempotent migration, and destructive SQL rejection. The optional `SWITCHYARD_TEST_POSTGRES_URL` real-Postgres test may verify compatibility/migration when configured but must skip otherwise.

**acceptance:**
- Postgres schema compatibility has durable metadata and a version constant.
- Empty/missing metadata reports `postgres_schema_migration_required`.
- Future metadata reports `postgres_schema_version_unsupported`.
- Malformed metadata reports `postgres_schema_malformed`.
- Unavailable database reports `postgres_unavailable`.
- Migration is idempotent and writes the current schema version.
- Migration SQL is additive-only and destructive statements are rejected by tests.
- Existing Postgres store tests remain compatible.

**checks:**
- `pnpm --filter @switchyard/storage test -- postgres-schema`
- `pnpm --filter @switchyard/storage test -- postgres-migration-policy`
- `pnpm --filter @switchyard/storage test -- postgres-storage`
- `pnpm --filter @switchyard/storage typecheck`

**error_rescue_map:**
- `{ "codepath": "checkPostgresSchemaCompatibility", "failure": "database connection/query fails", "exception": "pg Error or fake handle rejection", "rescue": "Return { ok:false, code:'postgres_unavailable' } with redacted diagnostics", "user_sees": "/ready/preflight shows postgres_unavailable" }`
- `{ "codepath": "checkPostgresSchemaCompatibility", "failure": "schema_metadata table or schema_version row missing", "exception": "SQL undefined row or relation missing", "rescue": "Return postgres_schema_migration_required", "user_sees": "Preflight tells operator to run production:migrate" }`
- `{ "codepath": "checkPostgresSchemaCompatibility", "failure": "schema_version empty or non-numeric", "exception": "Number parse failure", "rescue": "Return postgres_schema_malformed", "user_sees": "/ready/preflight fails closed with schema metadata malformed" }`
- `{ "codepath": "checkPostgresSchemaCompatibility", "failure": "schema_version greater than supported", "exception": "explicit version comparison", "rescue": "Return postgres_schema_version_unsupported", "user_sees": "Rollback runbook keeps traffic off or redeploys compatible code" }`
- `{ "codepath": "migratePostgresSchema", "failure": "migration partially already applied", "exception": "no throw for IF NOT EXISTS/idempotent metadata upsert", "rescue": "Rerun additive migration and upsert version", "user_sees": "production:migrate can be rerun safely" }`
- `{ "codepath": "assertPostgresMigrationSqlAdditive", "failure": "destructive SQL appears in migration block", "exception": "Error destructive_migration_blocked", "rescue": "Remove destructive statement or split into explicit future operator gate", "user_sees": "CI/audit blocks destructive production migration" }`

**observability:**
- `logs`: ["schema compatibility consumers log only code, expectedVersion, actualVersion, and metadataPresent"]
- `success_metric`: `postgres_schema_ready returned with version 19 after migration`
- `failure_metric`: `postgres_schema_migration_required, postgres_schema_version_unsupported, postgres_schema_malformed, postgres_unavailable`

**test_cases:**
- `{ "name": "ready schema version passes", "lens": "happy", "given": "fake handle returns schema_version 19", "expect": "{ ok:true, code:'postgres_schema_ready', version:19 }" }`
- `{ "name": "missing metadata table requires migration", "lens": "happy_shadow_nil", "given": "fake handle throws relation does not exist on metadata read", "expect": "{ ok:false, code:'postgres_schema_migration_required' }" }`
- `{ "name": "empty metadata row requires migration", "lens": "happy_shadow_empty", "given": "fake handle returns no schema_version row", "expect": "{ ok:false, code:'postgres_schema_migration_required' }" }`
- `{ "name": "malformed metadata fails closed", "lens": "error_path", "given": "fake handle returns value='not-a-number'", "expect": "{ ok:false, code:'postgres_schema_malformed' }" }`
- `{ "name": "future schema unsupported", "lens": "error_path", "given": "fake handle returns value='20'", "expect": "{ ok:false, code:'postgres_schema_version_unsupported', version:20 }" }`
- `{ "name": "postgres unavailable", "lens": "error_path", "given": "fake handle query rejects on select 1", "expect": "{ ok:false, code:'postgres_unavailable' }" }`
- `{ "name": "migration is idempotent", "lens": "integration", "given": "call migratePostgresSchema twice against fake handle", "expect": "both calls succeed and final metadata version is 19" }`
- `{ "name": "destructive SQL blocked", "lens": "edge_migration_policy", "given": "DROP TABLE runs; ALTER TABLE runs DROP COLUMN task; ALTER TABLE runs ALTER COLUMN runtime SET NOT NULL", "expect": "assertPostgresMigrationSqlAdditive throws destructive_migration_blocked" }`

**integration_contracts:**
- `exports`:
  - `{ "name": "POSTGRES_SCHEMA_VERSION", "kind": "constant", "signature": "POSTGRES_SCHEMA_VERSION: 19", "file": "packages/storage/src/postgres/database.ts" }`
  - `{ "name": "checkPostgresSchemaCompatibility", "kind": "function", "signature": "checkPostgresSchemaCompatibility(handle: PostgresDatabaseHandle) => Promise<PostgresSchemaCompatibility>", "file": "packages/storage/src/postgres/database.ts" }`
  - `{ "name": "migratePostgresSchema", "kind": "function", "signature": "migratePostgresSchema(handle: PostgresDatabaseHandle) => Promise<{ ok: true; version: number }>", "file": "packages/storage/src/postgres/database.ts" }`
  - `{ "name": "assertPostgresMigrationSqlAdditive", "kind": "function", "signature": "assertPostgresMigrationSqlAdditive(sql: string) => void", "file": "packages/storage/src/postgres/database.ts" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`: ["packages/storage/src/postgres/database.ts", "packages/storage/src/index.ts"]

### Task P18-T4-readiness-worker-node-operability: Wire Production Readiness And Operational Gates

**id:** `P18-T4-readiness-worker-node-operability`
**title:** `Wire production readiness and operational gates`

**files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/readiness.ts`
- Modify: `apps/server/src/metrics.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/main.ts`
- Create: `apps/worker/src/ready.ts`
- Modify: `apps/node/src/main.ts`
- Create: `apps/server/test/production-readiness.test.ts`
- Create: `apps/worker/test/production-worker-readiness.test.ts`

**dependencies:** ["P18-T2-production-config-hardening", "P18-T3-postgres-schema-migration-gates"]

**context_files:**
- `docs/superpowers/specs/2026-05-31-phase-18-r19-production-hosted-deployment.md` - FR5/FR6/FR7/FR8/FR9 and observability rules.
- `apps/server/src/app.ts` - current `/health`, `/ready`, `/metrics`, auth, queue, object-store, and control-plane wiring.
- `apps/server/src/readiness.ts` - existing structured readiness checks.
- `apps/server/src/metrics.ts` - existing hosted metrics counters required by canary/runbooks.
- `apps/worker/src/worker.ts` - current worker `ready()` and `tick()` behavior.
- `apps/node/src/main.ts` - current node startup loop lacking redacted start/failure summaries.
- `packages/storage/src/postgres/database.ts` - schema compatibility exports from P18-T3.

**instructions:**
1. Add a schema check to `probeServerReadiness`. When production/staging has a Postgres handle, call `checkPostgresSchemaCompatibility`; report `checks.schema = { ok: true, code:'postgres_schema_ready', diagnostics:{ version, expectedVersion } }` on success and `ok:false` with the compatibility code on failure. Local/test without Postgres should remain ready.
2. Ensure `/health` stays cheap and does not call dependency probes. Add tests proving `/health` returns `{ ok:true }` even when injected readiness dependencies would fail.
3. Keep `/ready` redacted. Diagnostics may include backend type, endpoint scheme/host, bucket, key prefix, timeout, probe mode, credential-presence booleans, schema expected/actual version, and unowned counts. They must not include raw URLs with credentials, object keys, signed URLs, API keys, node tokens, provider output, task text, cwd, or bootstrap secret hashes.
4. Preserve production `/metrics` protection. If metrics schema is unchanged, keep counters already present; if adding schema counters, keep them low-cardinality and update P18-T6 contracts. Tests must prove production/staging metrics require API key auth with both `metrics:read` and `admin:read`, and `SWITCHYARD_PUBLIC_METRICS=1` remains forbidden by P18-T2.
5. In the worker, run readiness before the first claim and before each `service.processNext()` in production/staging. If readiness fails, do not call `queue.claim()` and return `false` or exit on startup according to `main.ts` behavior. The reason must be named (`postgres_unavailable`, `postgres_schema_migration_required`, `postgres_schema_version_unsupported`, `queue_unavailable`, `object_store_unavailable`, `sandbox_config_invalid`, `hosted_real_runtime_production_forbidden`, or adapter check code).
6. Add `apps/worker/src/ready.ts` as an orchestrator-friendly readiness command that loads worker config, builds the worker, calls `ready()`, prints structured redacted JSON, exits `0` on ready and nonzero on failure, and closes resources. This is the command referenced by P18-T1 manifests.
7. Harden `apps/worker/src/main.ts` startup: config validation errors and production readiness failures log `worker.start_failed` with code and redacted config/checks before any claim. Local/test behavior remains compatible.
8. Harden `apps/node/src/main.ts` startup logs: log `node.started` on successful config/start with redacted summary, and `node.start_failed` on config/register errors. Do not add real tool or real runtime capability.
9. Add deterministic tests with fake queues/stores/probes: server readiness schema ready/migration-required/unsupported/unavailable, redaction, metrics auth, health cheapness, worker no-claim on readiness failure, worker empty queue happy path, and worker invalid payload behavior remains named and no adapter starts.

**acceptance:**
- `/ready` includes a named schema check and returns 503 for migration required, future schema, malformed schema, or Postgres unavailable in production/staging.
- `/health` remains cheap liveness.
- `/ready` and worker readiness diagnostics are redacted.
- Production metrics remain API-key protected by `metrics:read` plus `admin:read`.
- Worker does not claim jobs when DB, queue, object store, schema, sandbox, hosted runtime gate, or adapter readiness fails.
- Worker readiness command exists and is usable from production manifests.
- Node startup/failure logs redact shared tokens and credentialed URLs.
- No hosted middleware tool routes or public exec/sandbox/PTY/terminal/browser/search routes are added.

**checks:**
- `pnpm --filter @switchyard/server test -- production-readiness`
- `pnpm --filter @switchyard/worker test -- production-worker-readiness`
- `pnpm --filter @switchyard/server test -- hosted-server`
- `pnpm --filter @switchyard/worker test -- hosted-worker`
- `pnpm --filter @switchyard/node test -- node-app`
- `pnpm --filter @switchyard/server typecheck`
- `pnpm --filter @switchyard/worker typecheck`
- `pnpm --filter @switchyard/node typecheck`

**error_rescue_map:**
- `{ "codepath": "GET /health", "failure": "dependency unavailable", "exception": "none; dependency probes must not run", "rescue": "Return { ok:true } without probing", "user_sees": "Orchestrator liveness stays cheap" }`
- `{ "codepath": "GET /ready schema check", "failure": "schema migration required", "exception": "PostgresSchemaCompatibility ok=false code=postgres_schema_migration_required", "rescue": "Return 503 with checks.schema.code", "user_sees": "Readiness blocks traffic until production:migrate runs" }`
- `{ "codepath": "GET /ready diagnostics", "failure": "secret appears in serialized readiness", "exception": "Vitest redaction assertion failure", "rescue": "Run diagnostics through redactSecrets and only include safe summaries", "user_sees": "No secrets leak from readiness" }`
- `{ "codepath": "GET /metrics auth hook", "failure": "missing or insufficient API key", "exception": "ControlPlaneError auth_required/auth_failed/entitlement_denied", "rescue": "Return existing HTTP error envelope before metrics body", "user_sees": "401/403 error envelope; metrics not exposed" }`
- `{ "codepath": "worker.tick production readiness gate", "failure": "queue/schema/object-store/sandbox/runtime readiness fails", "exception": "Ready result ok=false", "rescue": "Do not call queue.claim; log named readiness failure; return false or exit at startup", "user_sees": "Worker remains idle/unready and no job is claimed" }`
- `{ "codepath": "worker queue payload", "failure": "missing payload or run id", "exception": "existing queue/run validation error", "rescue": "Discard/fail with queue_payload_invalid and never start adapters", "user_sees": "Run/job fails visibly with named reason, not silent drop" }`
- `{ "codepath": "node main startup", "failure": "register/auth/policy/config failure", "exception": "ConfigError or NodeClientError", "rescue": "Log node.start_failed with code and redacted summary, exit nonzero", "user_sees": "Node does not register or claim assignments under unsafe config" }`

**observability:**
- `logs`: ["server.listening", "server.start_failed", "worker.started", "worker.start_failed", "worker.readiness_failed", "node.started", "node.start_failed"]
- `success_metric`: `/ready ok=true increments dependencies.ready/controlPlane.ready; worker ready prints ok=true; canary-visible metrics counters remain present`
- `failure_metric`: `/ready ok=false increments dependencies.notReady/controlPlane.notReady; worker readiness failure reason codes; auth.required/auth.failed for metrics denial`

**test_cases:**
- `{ "name": "health is cheap", "lens": "happy", "given": "server with readiness dependencies that would throw", "expect": "GET /health returns 200 { ok:true } and dependency spies are not called" }`
- `{ "name": "ready includes schema ready", "lens": "happy", "given": "production/staging app with schema compatibility ready", "expect": "GET /ready 200 and checks.schema.code is postgres_schema_ready or omitted only when local/test" }`
- `{ "name": "ready reports migration required", "lens": "happy_shadow_nil", "given": "schema metadata missing", "expect": "GET /ready 503 with checks.schema.code=postgres_schema_migration_required" }`
- `{ "name": "ready reports unsupported future schema", "lens": "error_path", "given": "schema compatibility returns version 20", "expect": "GET /ready 503 with checks.schema.code=postgres_schema_version_unsupported" }`
- `{ "name": "readiness redacts credentials", "lens": "error_path", "given": "credentialed Postgres/Redis/object-store/node/bootstrap fixture", "expect": "JSON.stringify(/ready body) does not contain fake secrets, URLs with passwords, object keys, or raw hashes" }`
- `{ "name": "metrics require admin metrics scopes", "lens": "integration", "given": "hosted auth app with no auth, metrics-only key, and admin key", "expect": "no auth denied, metrics-only denied, admin succeeds" }`
- `{ "name": "worker no-claim on schema failure", "lens": "error_path", "given": "worker ready returns postgres_schema_migration_required and queue claim spy", "expect": "tick returns false and claim spy not called" }`
- `{ "name": "worker empty queue is healthy", "lens": "happy_shadow_empty", "given": "ready dependencies pass and queue.claim returns null", "expect": "tick returns false without error" }`
- `{ "name": "worker invalid payload does not start adapter", "lens": "error_path", "given": "claimed job missing runId or durable run", "expect": "job failed/discarded with queue_payload_invalid or existing named lifecycle reason and adapter spy not called" }`
- `{ "name": "node startup logs are redacted", "lens": "error_path", "given": "node config/register failure with token and credentialed URL", "expect": "node.start_failed payload omits token and URL credentials" }`

**integration_contracts:**
- `exports`:
  - `{ "name": "ReadinessReport", "kind": "type", "signature": "{ ok: boolean; checks: Record<string, { ok: boolean; code?: string; diagnostics?: Record<string, unknown> }> } with checks.schema for production Postgres compatibility", "file": "apps/server/src/readiness.ts" }`
  - `{ "name": "worker ready command", "kind": "function", "signature": "node apps/worker/dist/ready.js => stdout JSON { ok:boolean, reason?:string, checks?:object } and exit code 0/1", "file": "apps/worker/src/ready.ts" }`
- `imports_from_other_tasks`:
  - `{ "from_task": "P18-T2-production-config-hardening", "name": "production config guard helpers", "signature": "validateProduction* helpers exported from @switchyard/core" }`
  - `{ "from_task": "P18-T3-postgres-schema-migration-gates", "name": "checkPostgresSchemaCompatibility", "signature": "checkPostgresSchemaCompatibility(handle: PostgresDatabaseHandle) => Promise<PostgresSchemaCompatibility>" }`
- `file_paths_consumed_by_other_tasks`: ["apps/server/src/readiness.ts", "apps/worker/src/ready.ts", "apps/server/src/metrics.ts"]

### Task P18-T5-preflight-and-canary-commands: Add Production Preflight, Migration, And Canary Commands

**id:** `P18-T5-preflight-and-canary-commands`
**title:** `Add production preflight, migration, and canary commands`

**files:**
- Modify: `package.json`
- Create: `scripts/production-preflight.ts`
- Create: `scripts/production-migrate.ts`
- Create: `scripts/production-canary.ts`
- Create: `scripts/production-ops.test.ts`

**dependencies:** ["P18-T1-production-manifest-pack", "P18-T2-production-config-hardening", "P18-T3-postgres-schema-migration-gates", "P18-T4-readiness-worker-node-operability"]

**context_files:**
- `docs/superpowers/specs/2026-05-31-phase-18-r19-production-hosted-deployment.md` - FR3/FR4/FR5 preflight, migration, canary, and no-spend constraints.
- `package.json` - root script naming pattern for self-hosted and hosted smoke commands.
- `scripts/self-hosted-smoke.ts` - existing fetch/poll/error style and named failure pattern.
- `deploy/self-hosted/docker-compose.yml` - existing staging manifest style; the new production manifest contract comes from P18-T1 integration exports.
- `apps/server/src/config.ts` - server config resolver from P18-T2.
- `apps/worker/src/config.ts` - worker config resolver from P18-T2.
- `apps/node/src/config.ts` - node config resolver from P18-T2.
- `packages/storage/src/postgres/database.ts` - schema compatibility and migration exports from P18-T3.

**instructions:**
1. Add root scripts:
   - `production:preflight`: `tsx scripts/production-preflight.ts`
   - `production:migrate`: `tsx scripts/production-migrate.ts`
   - `production:canary`: `tsx scripts/production-canary.ts`
2. `production-preflight.ts` must accept `--env-file <path>`, `--manifest <path>`, `--include-node`, and `--json` (JSON default is acceptable). It must parse env files without executing shell code, merge with current process env, and validate server/worker/optional node config through the actual resolvers from P18-T2.
3. Preflight must JSON-parse `deploy/production/manifest.json` and validate required env keys, production commands, no dev commands, health/readiness checks, fake-only runtime posture, object-store probe posture, and forbidden surfaces. Use the JSON manifest as the structured source rather than ad hoc YAML parsing.
4. Preflight must check Postgres schema compatibility using P18-T3, queue connectivity via the existing queue adapter stats path, object-store probe via the existing object-store factory, and control-plane bootstrap/readiness posture. Production CLI runs use real configured dependencies; tests inject deterministic fakes. Output shape:
   `{ ok:boolean, checks:[{ name:string, status:'pass'|'fail'|'skip', code:string, diagnostics?:object }], summary:{ deploymentMode:'production', manifest:string, checkedAt:string } }`.
5. `production-migrate.ts` must accept `--env-file <path>` and run only the idempotent P18-T3 migration against the configured Postgres URL. It must print redacted JSON and exit nonzero with named codes on missing env, unavailable Postgres, or migration failure.
6. `production-canary.ts` must accept `--base-url`, `--api-key` or `SWITCHYARD_CANARY_API_KEY`, `--timeout-ms`, and `--json`. It must call only `/ready`, `/runs`, `/runs/:id`, `/runs/:id/events`, `/runs/:id/artifacts`, `/artifacts/:id/content`, `/metrics`, `/auth/whoami`, `/entitlements`, and `/audit/events`.
7. Canary create payload must use `runtime:"fake"`, `provider:"test"`, `model:"test-model"`, `adapterType:"process"`, `runtimeMode:"fake.deterministic"`, `placement:"hosted"`, `cwd:"/repo"`, static task label `r19 production canary`, and metadata including `{ switchyardCanary: "r19-production", canaryId, startedAt }`.
8. Canary must poll run detail until `completed` or timeout, parse SSE replay from `/runs/:id/events`, fetch artifact metadata/content, verify non-empty content without printing bytes, call protected `/metrics` with the same API key, and verify audit/ownership evidence by finding the canary run id or canary metadata in `/audit/events` output where the R18 route supports it.
9. Every failure returns a named code: `env_file_missing`, `env_file_empty`, `config_check_failed`, `manifest_missing`, `manifest_invalid`, `postgres_schema_migration_required`, `postgres_schema_version_unsupported`, `postgres_unavailable`, `queue_unavailable`, `object_store_unavailable`, `control_plane_bootstrap_missing`, `auth_required`, `auth_invalid`, `ready_denied`, `run_create_denied`, `worker_timeout`, `artifact_missing`, `artifact_content_empty`, `artifact_digest_mismatch`, `metrics_auth_failed`, `audit_lookup_failed`, `unexpected_terminal_status`, or `malformed_response`.
10. Tests must instantiate exported runner functions with fake env, fake dependencies, and fake fetch. They must not call live AWS/R2, model providers, payment providers, GitHub, search, browsers, arbitrary commands, PTY, or public network dependencies.

**acceptance:**
- Root production preflight, migration, and canary commands exist.
- Preflight validates app config, manifest, schema compatibility, queue, object store, control plane, auth, quota, audit, unowned resources, and hosted runtime gate with structured redacted output.
- Migration command is idempotent and delegates to P18-T3 migration.
- Canary verifies authenticated readiness, fake hosted run creation, worker completion, events, artifacts, artifact content, metrics auth, and audit/ownership evidence.
- Preflight/canary failures have named reason codes and redacted diagnostics.
- Required tests are deterministic/no-spend.

**checks:**
- `pnpm exec vitest run scripts/production-ops.test.ts`
- `pnpm production:preflight -- --env-file deploy/production/.env.example --manifest deploy/production/manifest.json --json` must fail with expected placeholder/config codes, not with parse/runtime errors.
- `pnpm typecheck`
- `git diff --check scripts package.json`

**error_rescue_map:**
- `{ "codepath": "readEnvFile", "failure": "missing env file", "exception": "ENOENT", "rescue": "Return env_file_missing and do not run dependency checks", "user_sees": "Preflight/migrate JSON check envFile status fail code env_file_missing" }`
- `{ "codepath": "readEnvFile", "failure": "empty env file", "exception": "explicit empty content check", "rescue": "Return env_file_empty", "user_sees": "Preflight/migrate JSON shows env_file_empty" }`
- `{ "codepath": "config resolver checks", "failure": "server/worker/node config throws ConfigError", "exception": "ConfigError", "rescue": "Convert to failed check with error.code and redactedConfig", "user_sees": "Preflight JSON names config_required/secret_placeholder/config_forbidden without secrets" }`
- `{ "codepath": "manifest validation", "failure": "manifest missing/malformed/unsafe", "exception": "ENOENT, SyntaxError, explicit validation failure", "rescue": "Return manifest_missing, manifest_invalid, manifest_forbidden_command, or manifest_forbidden_surface", "user_sees": "Preflight blocks deploy before traffic" }`
- `{ "codepath": "schema check", "failure": "migration required or unsupported", "exception": "PostgresSchemaCompatibility ok=false", "rescue": "Return the compatibility code and do not mark preflight ok", "user_sees": "Operator sees production:migrate or rollback guidance code" }`
- `{ "codepath": "queue stats check", "failure": "Redis unavailable or stats timeout", "exception": "BullMQ/ioredis Error", "rescue": "Return queue_unavailable with redacted host diagnostics", "user_sees": "Preflight fails before deploy" }`
- `{ "codepath": "object-store probe", "failure": "auth/bucket/timeout/read/write/delete failure", "exception": "object store Error message", "rescue": "Return existing object_store_* or artifact_* reason code with redacted summary", "user_sees": "Preflight fails with backend/host/bucket/probe only" }`
- `{ "codepath": "canary input", "failure": "missing or empty API key/base URL", "exception": "explicit validation failure", "rescue": "Return auth_required or invalid_input without making HTTP calls", "user_sees": "Canary exits nonzero with named input code" }`
- `{ "codepath": "canary HTTP response parse", "failure": "empty or malformed JSON/SSE response", "exception": "SyntaxError or explicit shape check", "rescue": "Return malformed_response with step name", "user_sees": "Canary JSON identifies bad step without raw body" }`
- `{ "codepath": "canary worker wait", "failure": "run never completes before timeout", "exception": "timeout loop", "rescue": "Return worker_timeout and include runId only", "user_sees": "Canary exits nonzero; durable run id can be inspected" }`
- `{ "codepath": "canary artifact content", "failure": "missing, empty, digest mismatch, or object-store error", "exception": "HTTP 404/409/503 or empty body", "rescue": "Return artifact_missing, artifact_content_empty, artifact_digest_mismatch, or object-store code", "user_sees": "Canary identifies artifact failure without printing bytes/object keys" }`
- `{ "codepath": "canary metrics/audit", "failure": "metrics denied or audit evidence missing", "exception": "HTTP 401/403 or no matching audit record", "rescue": "Return metrics_auth_failed or audit_lookup_failed", "user_sees": "Canary shows auth/evidence failure with no API key leak" }`

**observability:**
- `logs`: ["preflight JSON check results", "migration JSON result", "canary JSON steps with elapsedMs/runId/artifactId/terminalStatus"]
- `success_metric`: `preflight ok=true, migration version=19, canary ok=true with ready/run/events/artifact/metrics/audit steps pass`
- `failure_metric`: `named preflight/canary codes listed in failed check/step`

**test_cases:**
- `{ "name": "preflight valid fake dependencies passes", "lens": "happy", "given": "valid production env plus injected schema-ready queue/object/control-plane fakes", "expect": "ok=true and all checks pass" }`
- `{ "name": "preflight missing env file", "lens": "happy_shadow_nil", "given": "--env-file /missing", "expect": "ok=false code=env_file_missing and no dependency fakes called" }`
- `{ "name": "preflight empty env file", "lens": "happy_shadow_empty", "given": "empty temp env file", "expect": "ok=false code=env_file_empty" }`
- `{ "name": "preflight placeholder secrets redacted", "lens": "error_path", "given": "env with replace-with-pepper and fake DB passwords", "expect": "ok=false, code secret_placeholder, serialized output omits raw values" }`
- `{ "name": "preflight schema migration required", "lens": "error_path", "given": "schema fake returns postgres_schema_migration_required", "expect": "ok=false and schema check code matches" }`
- `{ "name": "preflight manifest dev command rejected", "lens": "error_path", "given": "manifest fake with command containing dev", "expect": "ok=false code=manifest_forbidden_command" }`
- `{ "name": "migration idempotent", "lens": "integration", "given": "fake Postgres migration runner called twice", "expect": "both return ok=true version=19" }`
- `{ "name": "canary happy path", "lens": "happy", "given": "fake fetch sequence for ready, whoami, entitlements, run create/detail completed, SSE events, artifacts, content, metrics, audit", "expect": "ok=true with runId and artifactId; no raw artifact bytes in output" }`
- `{ "name": "canary missing api key", "lens": "happy_shadow_nil", "given": "no --api-key and no env key", "expect": "ok=false code=auth_required and fetch not called" }`
- `{ "name": "canary readiness denied", "lens": "error_path", "given": "GET /ready returns 503", "expect": "ok=false code=ready_denied" }`
- `{ "name": "canary worker timeout", "lens": "error_path", "given": "run detail stays queued/running until timeout", "expect": "ok=false code=worker_timeout and runId present" }`
- `{ "name": "canary artifact empty", "lens": "happy_shadow_empty", "given": "artifact content response 200 with zero bytes", "expect": "ok=false code=artifact_content_empty" }`
- `{ "name": "canary metrics auth failure", "lens": "error_path", "given": "GET /metrics returns 403", "expect": "ok=false code=metrics_auth_failed" }`
- `{ "name": "canary audit missing", "lens": "error_path", "given": "GET /audit/events returns no matching run/canary evidence", "expect": "ok=false code=audit_lookup_failed" }`
- `{ "name": "canary output redacts secrets", "lens": "error_path", "given": "fake API key, node token, DB URL, object key, signed URL, raw bytes in fake responses", "expect": "JSON.stringify(result) omits all raw secrets and bytes" }`

**integration_contracts:**
- `exports`:
  - `{ "name": "runProductionPreflight", "kind": "function", "signature": "runProductionPreflight(options: { envFile?: string; manifestPath?: string; includeNode?: boolean; deps?: PreflightDeps }) => Promise<ProductionPreflightResult>", "file": "scripts/production-preflight.ts" }`
  - `{ "name": "runProductionMigration", "kind": "function", "signature": "runProductionMigration(options: { envFile?: string; deps?: MigrationDeps }) => Promise<ProductionMigrationResult>", "file": "scripts/production-migrate.ts" }`
  - `{ "name": "runProductionCanary", "kind": "function", "signature": "runProductionCanary(options: { baseUrl: string; apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch }) => Promise<ProductionCanaryResult>", "file": "scripts/production-canary.ts" }`
- `imports_from_other_tasks`:
  - `{ "from_task": "P18-T1-production-manifest-pack", "name": "productionManifestJson", "signature": "deploy/production/manifest.json machine-readable manifest" }`
  - `{ "from_task": "P18-T2-production-config-hardening", "name": "loadServerConfig/loadWorkerConfig/loadNodeConfig production behavior", "signature": "load*Config(env) throws ConfigError with code/redactedConfig or returns config" }`
  - `{ "from_task": "P18-T3-postgres-schema-migration-gates", "name": "checkPostgresSchemaCompatibility/migratePostgresSchema", "signature": "schema compatibility and migration functions exported from @switchyard/storage" }`
  - `{ "from_task": "P18-T4-readiness-worker-node-operability", "name": "ReadinessReport and worker ready command", "signature": "ready JSON shapes consumed by preflight/runbook/canary" }`
- `file_paths_consumed_by_other_tasks`: ["scripts/production-preflight.ts", "scripts/production-migrate.ts", "scripts/production-canary.ts", "package.json"]

### Task P18-T6-contract-docs-product-truth: Update Hosted Contracts And Product Truth

**id:** `P18-T6-contract-docs-product-truth`
**title:** `Update hosted contracts and product truth`

**files:**
- Modify: `packages/contracts/src/openapi.ts`
- Modify: `packages/contracts/src/openapi.contract.test.ts`
- Modify: `packages/contracts/openapi.hosted-server.json`
- Modify: `PRODUCT.md`
- Modify: `README.md`
- Modify: `docs/development/API.md`
- Modify: `docs/development/DEVELOPMENT.md`

**dependencies:** ["P18-T1-production-manifest-pack", "P18-T2-production-config-hardening", "P18-T3-postgres-schema-migration-gates", "P18-T4-readiness-worker-node-operability", "P18-T5-preflight-and-canary-commands"]

**context_files:**
- `docs/superpowers/specs/2026-05-31-phase-18-r19-production-hosted-deployment.md` - docs and API truth requirements.
- `PRODUCT.md` - current R18 product truth and unshipped production hosted gap.
- `README.md` - public product overview wording that must not overclaim managed SaaS.
- `docs/development/API.md` - hosted API/readiness/metrics/error boundary docs.
- `docs/development/DEVELOPMENT.md` - current no-spend verification and rollout/rollback docs.
- `packages/contracts/src/openapi.ts` - current ReadyResponse and HostedMetricsResponse schemas.
- `packages/contracts/src/openapi.contract.test.ts` - hosted `/health`/`/ready` public and `/metrics` protected tests.

**instructions:**
1. Update hosted OpenAPI only if the R19 readiness/metrics/error schema changed. At minimum, make `ReadyResponse` documentation/schema allow `checks.schema` diagnostics and named schema codes without making local-daemon OpenAPI auth-protected. Keep `/health` and `/ready` public in hosted OpenAPI; keep `/metrics` protected with `SwitchyardApiKey` and `x-switchyard-required-scopes: ["metrics:read","admin:read"]`.
2. Regenerate `packages/contracts/openapi.hosted-server.json` with `pnpm --filter @switchyard/contracts openapi:generate:hosted` if OpenAPI output changes. Do not change local OpenAPI unless a local contract actually changed.
3. Update `PRODUCT.md`: R19 is shipped as production hosted deployment readiness for the existing safe hosted boundary. State exactly that production hosted execution remains `fake.deterministic` only in required manifests/canaries; managed SaaS, public signup, payments, OAuth/SSO/SCIM, dashboard/TUI, production real runtimes, arbitrary process/PTY, public exec/sandbox/terminal routes, hosted/connected-node real tools, browser automation, Cursor/OpenClaw/Paperclip, runtime-specific approval bridges, and hosted debate/model judging remain unshipped.
4. Update `README.md` wording to mention production manifests, production preflight, explicit migration/rollback gates, and no-spend production canary for self-hosted/managed-hosting-ready operation without claiming a managed hosted platform or public tenant self-service.
5. Update `docs/development/API.md` with R19 production readiness codes, metrics protection, preflight/canary surfaces, and explicit no-auth local daemon compatibility.
6. Update `docs/development/DEVELOPMENT.md` with copy/paste commands for `production:preflight`, `production:migrate`, `production:canary`, deterministic no-spend verification, rollout, rollback, worker pause/queue inspection, readiness/metrics interpretation, and canary evidence retention. Clearly mark optional live dependency checks as operator-owned and not required in CI/audit.
7. Docs must not add dashboard/TUI/payment/OAuth/public signup/browser/exec/sandbox/real-runtime setup instructions.

**acceptance:**
- Hosted OpenAPI checks pass and preserve hosted `/metrics` auth requirements.
- Local daemon OpenAPI/no-auth defaults remain documented and unchanged.
- Product truth marks R19 shipped without overclaiming managed SaaS or production real-runtime hosting.
- README accurately describes production deploy readiness and no-spend canary.
- API/development docs include named failure codes, preflight/migration/canary commands, rollout/rollback steps, and deterministic no-spend verification.
- Docs keep every R19 non-goal explicit.

**checks:**
- `pnpm --filter @switchyard/contracts openapi:check:hosted`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm --filter @switchyard/contracts test -- openapi.contract`
- `pnpm typecheck`
- `git diff --check PRODUCT.md README.md docs/development/API.md docs/development/DEVELOPMENT.md packages/contracts`

**error_rescue_map:**
- `{ "codepath": "hosted OpenAPI ReadyResponse", "failure": "schema no longer matches /ready body", "exception": "OpenAPI contract or generated diff failure", "rescue": "Update SCHEMA_BY_REF.ReadyResponse and regenerate hosted OpenAPI", "user_sees": "Hosted API docs match readiness response" }`
- `{ "codepath": "hosted /metrics security", "failure": "metrics route becomes public or loses scopes", "exception": "OpenAPI contract assertion failure", "rescue": "Restore security scheme and required scopes", "user_sees": "Operators see metrics requires API key with metrics/admin scopes" }`
- `{ "codepath": "PRODUCT.md truth", "failure": "docs overclaim managed SaaS or production real runtime", "exception": "docs review/audit finding", "rescue": "Replace wording with production-readiness for fake-safe hosted boundary", "user_sees": "Product truth accurately states shipped and unshipped surfaces" }`
- `{ "codepath": "DEVELOPMENT.md commands", "failure": "copy/paste command references missing script", "exception": "docs command check failure", "rescue": "Align docs with package.json scripts from P18-T5", "user_sees": "Operator commands run as documented" }`
- `{ "codepath": "docs redaction/examples", "failure": "example includes real-looking secret", "exception": "docs grep/review finding", "rescue": "Use replace-with-* placeholders and no raw credential examples", "user_sees": "Docs do not train unsafe secret handling" }`

**observability:**
- `logs`: []
- `success_metric`: `hosted OpenAPI check passes and docs list production preflight/migrate/canary verification`
- `failure_metric`: `OpenAPI drift, docs overclaim, or missing non-goal discovered by contract/docs checks`

**test_cases:**
- `{ "name": "hosted ready schema supports schema check", "lens": "integration", "given": "generateOpenApiDocument({ surface:'hosted_server' })", "expect": "ReadyResponse schema allows checks.schema with ok/code/diagnostics" }`
- `{ "name": "hosted metrics stays protected", "lens": "integration", "given": "hosted OpenAPI /metrics operation", "expect": "security includes SwitchyardApiKey and required scopes metrics:read/admin:read" }`
- `{ "name": "hosted health and ready remain public", "lens": "integration", "given": "hosted OpenAPI /health and /ready", "expect": "security is undefined" }`
- `{ "name": "local OpenAPI remains no-auth", "lens": "integration", "given": "generateOpenApiDocument({ surface:'local_daemon' })", "expect": "no SwitchyardApiKey security scheme is required for local daemon routes" }`
- `{ "name": "product truth marks R19 boundary", "lens": "happy", "given": "PRODUCT.md text", "expect": "mentions R19 production hosted deployment readiness and fake.deterministic-only production hosted execution" }`
- `{ "name": "docs keep non-goals explicit", "lens": "edge_boundary", "given": "PRODUCT/README/API/DEVELOPMENT text", "expect": "does not claim managed SaaS, payments, OAuth, dashboard/TUI, production real runtimes, public exec/sandbox/terminal, hosted real tools, browser automation, Cursor/OpenClaw/Paperclip, runtime approval bridges, or hosted debate/model judging" }`
- `{ "name": "development docs include commands", "lens": "happy", "given": "docs/development/DEVELOPMENT.md", "expect": "contains pnpm production:preflight, production:migrate, production:canary, openapi checks, typecheck, git diff --check" }`
- `{ "name": "docs examples use invalid placeholders", "lens": "error_path", "given": "docs and README production snippets", "expect": "use replace-with-* placeholders and no switchyard/password/secret/test/example as secret values" }`

**integration_contracts:**
- `exports`:
  - `{ "name": "hosted ReadyResponse OpenAPI schema", "kind": "constant", "signature": "ReadyResponse: { ok:boolean, checks: Record<string,{ok:boolean, code?:string, diagnostics?:object}> }", "file": "packages/contracts/src/openapi.ts" }`
  - `{ "name": "R19 product truth", "kind": "constant", "signature": "PRODUCT.md documents R19 as production hosted deployment readiness for fake-safe hosted boundary", "file": "PRODUCT.md" }`
- `imports_from_other_tasks`:
  - `{ "from_task": "P18-T1-production-manifest-pack", "name": "production manifest/runbook paths", "signature": "deploy/production/README.md and manifest paths for docs cross-reference" }`
  - `{ "from_task": "P18-T3-postgres-schema-migration-gates", "name": "schema compatibility codes", "signature": "postgres_schema_ready|postgres_schema_migration_required|postgres_schema_version_unsupported|postgres_schema_malformed|postgres_unavailable" }`
  - `{ "from_task": "P18-T5-preflight-and-canary-commands", "name": "production command scripts", "signature": "pnpm production:preflight|production:migrate|production:canary" }`
- `file_paths_consumed_by_other_tasks`: []

## Integration Points

- P18-T1 produces the deploy pack and machine-readable manifest that P18-T5 preflight validates and P18-T6 docs reference.
- P18-T2 hardens the app config resolvers in place. P18-T5 must call those same resolvers rather than reimplementing validation.
- P18-T3 exports schema compatibility/migration helpers. P18-T4 uses compatibility in readiness/worker gates; P18-T5 uses compatibility and migration in operator commands; P18-T6 documents the codes.
- P18-T4 keeps `/health`, `/ready`, `/metrics`, worker readiness, and node startup behavior aligned with the production manifest and canary.
- P18-T5 canary uses only existing hosted APIs and must not require new canary-only server routes.
- P18-T6 owns public truth after implementation and must update hosted OpenAPI only where response schemas actually changed.

## Phase-Level Acceptance Criteria

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

## Phase Checks

- `pnpm exec vitest run deploy/production/production-manifest.test.ts scripts/production-ops.test.ts`
- `pnpm --filter @switchyard/core test -- production-config-guards`
- `pnpm --filter @switchyard/server test -- production-config`
- `pnpm --filter @switchyard/server test -- production-readiness`
- `pnpm --filter @switchyard/worker test -- production-config`
- `pnpm --filter @switchyard/worker test -- production-worker-readiness`
- `pnpm --filter @switchyard/node test -- production-config`
- `pnpm --filter @switchyard/storage test -- postgres-schema`
- `pnpm --filter @switchyard/storage test -- postgres-migration-policy`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm --filter @switchyard/contracts openapi:check:hosted`
- `pnpm typecheck`
- `git diff --check`

## Risks

- The phase exceeds the 8-file complexity smell because production operability cuts across deployment, app config, storage schema gates, readiness, scripts, contracts, and docs. The mitigation is package-scoped tasks with disjoint ownership and explicit integration contracts.
- `ensurePostgresSchema` currently creates schema opportunistically. R19 must not let that hide production migration requirements; readiness/preflight must use explicit schema metadata compatibility.
- The production manifest pack includes both human-friendly compose and machine-readable JSON. Audit must ensure they stay aligned through manifest tests and preflight validation.
- Required CI/audit checks remain no-spend and cannot prove a live operator's Postgres/Redis/S3 credentials. Docs must separate deterministic required checks from optional live dependency checks.

## Self-Review Checklist

1. Spec coverage: every R19 acceptance criterion maps to at least one task and phase check.
2. Placeholder scan: no task uses vague filler wording.
3. Type consistency: integration contracts for config guards, schema compatibility, readiness, and scripts use matching signatures.
4. Ownership disjoint: no file appears in more than one task's `files` list.
5. Context files real: every `context_files` path exists before implementation.
6. Acceptance testable: every task acceptance item names objective checks or observable outcomes.
7. Dependency order sane: T4 depends on config/schema; T5 depends on manifests/config/schema/readiness; T6 depends on implementation surfaces.
8. Checks runnable: checks use existing pnpm/vitest/typecheck/openapi scripts or root dev dependencies.
9. Error/rescue maps present: every runtime/config/script task has named failures and user-visible outcomes.
10. Observability present: server/worker/node/preflight/canary runtime behavior has logs and metrics/failure codes.
11. Test cases enumerate acceptance: happy, nil, empty, error, edge, and integration paths are listed per task.
12. Integration contracts walk: every import from another task resolves to an export in that task.
13. Contract types match: `checkPostgresSchemaCompatibility`, `ReadinessReport`, and production command runner signatures are consistent where consumed.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test_case.
- [x] Every error_rescue_map entry has a matching test_case in `lens: error_path` or `lens: happy_shadow_*`.
- [x] Every integration_contracts.imports_from_other_tasks resolves to a real export elsewhere in this plan.
- [x] Every context_files path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No banned placeholder or vague filler wording is present.
- [x] Complexity is L; splitting into sub-phases was considered, but one release is appropriate because preflight, readiness, migration, canary, manifests, and docs must agree for production operability.
