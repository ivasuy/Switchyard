# Phase 11 Audit Report

- Phase: `11`
- Title: `R12 Production Hosting Foundation`
- Run: `post-r11-remaining-20260530`
- Branch: `agent/phase-11-r12-production-hosting-foundation`
- Auditor iteration: `1`
- Verdict: `NEEDS_REVISION`

## Summary

The Phase 11 branch is mergeable from a git hygiene and regression-check standpoint: the worktree was clean before audit artifacts, `git diff --check` passed, targeted package tests passed, `pnpm test` passed, `pnpm typecheck` passed, `openapi:check` passed, and the worker forbidden-import guard remained clean. The self-hosted smoke also failed with the expected named Docker prerequisite error instead of an unhandled compose failure.

The blocking issue is acceptance compliance for fail-closed staging/production config. Server and worker silently accept a missing `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`, and node silently accepts missing capabilities/runtime-mode/cwd policy env vars by falling back to defaults. The spec and plan both require those values to be explicit in staging/production and to fail startup with named `config_required:*` errors when absent or blank.

## Checks

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
- `pnpm self-hosted:smoke` -> `self_hosted_smoke_docker_unavailable`

## Redflags

1. `apps/server/src/config.ts:28-29`, `apps/server/src/config.ts:47-65`, `apps/worker/src/config.ts:22-25`, and `apps/worker/src/config.ts:40-50` let staging/production boot without an explicit `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` because the loaders inject a default `"fake.deterministic"`. This violates the required fail-closed staging/production config contract.
2. `apps/node/src/config.ts:26-31` and `apps/node/src/config.ts:46-65` let staging/production boot without explicit `SWITCHYARD_NODE_CAPABILITIES`, `SWITCHYARD_NODE_ALLOW_RUNTIME_MODES`, and `SWITCHYARD_NODE_ALLOW_CWD_PREFIXES` because the loader injects defaults. This violates the same fail-closed config acceptance requirement.

## Deferred Concerns

- None. The config enforcement gaps are acceptance blockers for this phase rather than follow-up work.

## Non-Blocking Observations

- The self-hosted smoke prerequisite handling is correct for this environment: the script emitted `self_hosted_smoke_docker_unavailable` and preserved diagnostics, which matches the requested audit behavior when Docker is unavailable.
