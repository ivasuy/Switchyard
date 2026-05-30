# Audit Log: P11-T1 Production Hosting Foundation

- Date: 2026-05-31
- Iteration: 1
- Branch: `agent/phase-11-r12-production-hosting-foundation`
- Head: `ff52adf85dacc56deb7b6fe57f2b33c15eb959b4`
- Verdict: `NEEDS_REVISION`

## Scope Audited

- Phase 11 spec: `docs/superpowers/specs/2026-05-30-phase-11-r12-production-hosting-foundation.md`
- Phase 11 plan: `docs/superpowers/plans/2026-05-30-phase-11-r12-production-hosting-foundation.md`
- Phase commit range: `2d83a2c..ff52adf`

## Checks Run

- `git status --short` -> clean before audit artifacts
- `git rev-list --count main..HEAD` -> `93`
- `git diff --check` -> pass
- `pnpm --filter @switchyard/server test` -> pass
- `pnpm --filter @switchyard/worker test` -> pass
- `pnpm --filter @switchyard/node test` -> pass
- `pnpm --filter @switchyard/queue test` -> pass
- `pnpm --filter @switchyard/storage test` -> pass
- `pnpm --filter @switchyard/protocol-node test` -> pass
- `pnpm --filter @switchyard/contracts test` -> pass
- `pnpm --filter @switchyard/contracts openapi:check` -> pass
- `pnpm --filter @switchyard/core test` -> pass
- `pnpm --filter @switchyard/daemon test` -> pass
- `pnpm --filter @switchyard/sdk test` -> pass
- `pnpm --filter @switchyard/cli test` -> pass
- `pnpm --filter @switchyard/adapters test` -> pass
- `pnpm test` -> pass
- `pnpm typecheck` -> pass
- `rg -n "CodexExecJsonAdapter|ClaudeCodeAdapter|OpenCodeAcpAdapter|GenericHttpAsyncRestAdapter|AgentFieldAsyncRestAdapter|@switchyard/adapters|pty|browser|shell|github|fetch|repo" apps/worker/src` -> no matches
- `pnpm self-hosted:smoke` -> emitted `self_hosted_smoke_docker_unavailable`

## Redflags

### 1. Server and worker staging mode do not fail closed when `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` is missing

- Files:
  - `apps/server/src/config.ts:28-29`
  - `apps/server/src/config.ts:47-65`
  - `apps/worker/src/config.ts:22-25`
  - `apps/worker/src/config.ts:40-50`
- Problem:
  - Both loaders seed `hostedRuntimeAllowlist` with a fallback of `"fake.deterministic"`.
  - In `staging`/`production`, a missing env var therefore still produces a valid allowlist and startup succeeds instead of raising `config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`.
- Acceptance violated:
  - `Server, worker, and node parse explicit deployment modes; in staging/production, missing or blank required config fails startup with named errors and redacted output.`
- Direct proof:
  - `loadServerConfig({ SWITCHYARD_DEPLOYMENT_MODE: 'staging', SWITCHYARD_POSTGRES_URL: 'postgres://localhost/db', SWITCHYARD_REDIS_URL: 'redis://localhost:6379/0', SWITCHYARD_OBJECT_STORE_DIR: '/tmp/store', SWITCHYARD_NODE_SHARED_TOKEN: 'token' })` returned successfully (`SERVER_OK`).
  - `loadWorkerConfig({ SWITCHYARD_DEPLOYMENT_MODE: 'staging', SWITCHYARD_POSTGRES_URL: 'postgres://localhost/db', SWITCHYARD_REDIS_URL: 'redis://localhost:6379/0', SWITCHYARD_OBJECT_STORE_DIR: '/tmp/store' })` returned successfully (`WORKER_OK`).
- Required change:
  - Remove the allowlist fallback for staging/production validation and throw `config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` when the env is absent or blank.

### 2. Node staging mode does not require explicit capabilities/runtime-mode/cwd policy env vars

- File:
  - `apps/node/src/config.ts:26-31`
  - `apps/node/src/config.ts:46-65`
- Problem:
  - `loadNodeConfig()` falls back to defaults for `SWITCHYARD_NODE_CAPABILITIES`, `SWITCHYARD_NODE_ALLOW_RUNTIME_MODES`, and `SWITCHYARD_NODE_ALLOW_CWD_PREFIXES`.
  - In `staging`/`production`, the loader therefore accepts missing policy env vars instead of fail-closing on missing required config.
- Acceptance violated:
  - `Server, worker, and node parse explicit deployment modes; in staging/production, missing or blank required config fails startup with named errors and redacted output.`
- Direct proof:
  - `loadNodeConfig({ SWITCHYARD_DEPLOYMENT_MODE: 'staging', SWITCHYARD_SERVER_URL: 'http://localhost:4646', SWITCHYARD_NODE_SHARED_TOKEN: 'token' })` returned successfully (`missing_caps:OK`).
  - `loadNodeConfig({ ..., SWITCHYARD_NODE_CAPABILITIES: 'runtime.fake.deterministic' })` returned successfully (`missing_modes:OK`).
  - `loadNodeConfig({ ..., SWITCHYARD_NODE_CAPABILITIES: 'runtime.fake.deterministic', SWITCHYARD_NODE_ALLOW_RUNTIME_MODES: 'fake.deterministic' })` returned successfully (`missing_cwds:OK`).
- Required change:
  - Treat those env vars as explicitly required in staging/production. Missing or blank values must raise `config_required:SWITCHYARD_NODE_CAPABILITIES`, `config_required:SWITCHYARD_NODE_ALLOW_RUNTIME_MODES`, and `config_required:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES` respectively.

## Non-Blocking Notes

- `pnpm self-hosted:smoke` could not run the compose stack because the environment emitted the named prerequisite error `self_hosted_smoke_docker_unavailable`. That matched the expected failure mode for a missing Docker daemon, so this was not treated as a separate blocker on this pass.
