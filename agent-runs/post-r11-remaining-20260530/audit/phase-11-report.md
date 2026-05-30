# Phase 11 Audit Report

- Phase: `11`
- Title: `R12 Production Hosting Foundation`
- Run: `post-r11-remaining-20260530`
- Branch: `agent/phase-11-r12-production-hosting-foundation`
- Auditor iteration: `2`
- Verdict: `GREEN`

## Summary

This rerun was scoped to the two redflags recorded in the prior audit commit `2a767bc`. Both are resolved at `2f742d5`: server and worker staging/production now require an explicit `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`, and node staging/production now require explicit `SWITCHYARD_NODE_CAPABILITIES`, `SWITCHYARD_NODE_ALLOW_RUNTIME_MODES`, and `SWITCHYARD_NODE_ALLOW_CWD_PREFIXES`.

I re-verified those fixes independently with direct missing and blank env probes, then re-ran the requested regression matrix. The branch stayed clean on `git diff --check`, all requested package and workspace tests passed, `pnpm typecheck` passed, the worker forbidden-import guard stayed clean, and the self-hosted smoke command produced the expected `self_hosted_smoke_docker_unavailable` observation with preserved diagnostics paths in this environment.

## Prior Redflags Resolved

1. `apps/server/src/config.ts:48-60` and `apps/worker/src/config.ts:41-52` now fail closed with `config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` when the allowlist env is missing or blank in staging/production.
2. `apps/node/src/config.ts:49-71` now fail closed with `config_required:SWITCHYARD_NODE_CAPABILITIES`, `config_required:SWITCHYARD_NODE_ALLOW_RUNTIME_MODES`, and `config_required:SWITCHYARD_NODE_ALLOW_CWD_PREFIXES` when those env vars are missing or blank in staging/production.

## Checks

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
- `pnpm self-hosted:smoke` -> `self_hosted_smoke_docker_unavailable` with diagnostics preserved
- forbidden worker import guard on `apps/worker/src` -> no matches

## Deferred Concerns

- None.

## Non-Blocking Observations

- Docker was unavailable in this audit environment, so the smoke command could not bring up the compose stack. The script behavior matched the requested contract by emitting the named prerequisite event and preserving diagnostic paths instead of failing opaquely.
