# Audit Log: P11-T1 Production Hosting Foundation

- Date: 2026-05-31
- Iteration: 2
- Branch: `agent/phase-11-r12-production-hosting-foundation`
- Head: `2f742d5`
- Verdict: `GREEN`

## Scope Audited

- Phase 11 spec: `docs/superpowers/specs/2026-05-30-phase-11-r12-production-hosting-foundation.md`
- Phase 11 plan: `docs/superpowers/plans/2026-05-30-phase-11-r12-production-hosting-foundation.md`
- Re-audit scope: verify only the two prior redflags recorded at `2a767bc`
- Phase commit range inspected: `2a767bc..2f742d5`

## Prior Redflags Re-Verified

### 1. Server and worker staging mode now fail closed when `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` is missing or blank

- `apps/server/src/config.ts:28-29` still keeps the local/test fallback, but `apps/server/src/config.ts:48-60` now explicitly requires the raw env in staging/production before accepting the parsed allowlist.
- `apps/worker/src/config.ts:22-25` still keeps the local/test fallback, but `apps/worker/src/config.ts:41-52` now explicitly requires the raw env in staging/production before accepting the parsed allowlist.
- Direct probe results:
  - missing server allowlist -> `config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`
  - blank server allowlist -> `config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`
  - missing worker allowlist -> `config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`
  - blank worker allowlist -> `config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`
- Regression coverage:
  - `apps/server/test/hosted-server.test.ts:121-138`
  - `apps/worker/test/hosted-worker.test.ts:83-99`

### 2. Node staging mode now requires explicit capabilities, runtime-mode allowlist, and cwd-prefix allowlist env vars

- `apps/node/src/config.ts:24-26` reads the raw env values, and `apps/node/src/config.ts:49-71` now requires them explicitly in staging/production before accepting the parsed defaults for local/test mode.
- Direct probe results:
  - missing capabilities -> `config_required:SWITCHYARD_NODE_CAPABILITIES`
  - blank capabilities -> `config_required:SWITCHYARD_NODE_CAPABILITIES`
  - missing runtime-mode allowlist -> `config_required:SWITCHYARD_NODE_ALLOW_RUNTIME_MODES`
  - blank runtime-mode allowlist -> `config_required:SWITCHYARD_NODE_ALLOW_RUNTIME_MODES`
  - missing cwd-prefix allowlist -> `config_required:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES`
  - blank cwd-prefix allowlist -> `config_required:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES`
- Regression coverage:
  - `apps/node/test/node-app.test.ts:129-172`

## Checks Run

- `git status --short` -> clean before audit artifacts
- `git diff --check` -> pass
- direct `tsx` loader probes for server/worker/node missing and blank env handling -> pass
- `pnpm --filter @switchyard/server test` -> pass
- `pnpm --filter @switchyard/worker test` -> pass
- `pnpm --filter @switchyard/node test` -> pass
- `pnpm --filter @switchyard/queue test` -> pass
- `pnpm --filter @switchyard/storage test` -> pass
- `pnpm --filter @switchyard/protocol-node test` -> pass
- `pnpm --filter @switchyard/contracts test` -> pass
- `pnpm --filter @switchyard/contracts openapi:check` -> pass
- `pnpm --filter @switchyard/core test` -> pass
- `pnpm test` -> pass
- `pnpm typecheck` -> pass
- `pnpm self-hosted:smoke` -> emitted `self_hosted_smoke_docker_unavailable` and preserved diagnostics paths
- forbidden worker import guard (`rg -n "CodexExecJsonAdapter|ClaudeCodeAdapter|OpenCodeAcpAdapter|GenericHttpAsyncRestAdapter|AgentFieldAsyncRestAdapter|@switchyard/adapters|pty|browser|shell|github|fetch|repo" apps/worker/src`) -> no matches

## Observations

- The re-audit stayed within pass-2 scope and did not raise new findings beyond the previously recorded redflags.
- `pnpm self-hosted:smoke` was blocked by the local Docker prerequisite, but it failed with the named `self_hosted_smoke_docker_unavailable` event and printed preserved diagnostics and volume-inspect paths. That matches the requested audit handling for this environment.

## Deferred Concerns

- None.
