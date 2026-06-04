# Phase 23 Audit Report: R24 Hosted Real Debate

**Date:** 2026-06-04T18:28:32+05:30
**Branch:** agent/phase-23-r24-hosted-real-debate
**Audited head:** e724b61 stabilize endpoint inventory drift test timeout
**Spec:** docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md
**Plan:** docs/superpowers/plans/2026-06-02-phase-23-r24-hosted-real-debate.md
**Status:** GREEN

## Acceptance Evidence

- Hosted debate remains on the existing public route family only: `POST /debates`, `GET /debates/:id`, and `GET /debates/:id/events`.
- Hosted route wiring includes API-key auth, ownership checks, quota/audit admission, durable debate state, and debate-scoped SSE filtering.
- Debate create preauthorizes evidence before side effects and preserves no-leak behavior for unknown or unowned evidence.
- Non-fake participant modes require `realRuntimeOptIn: true`; hosted real participant execution requires `placement: "hosted"` and the existing hosted provider activation gates.
- Participant and judge child runs are idempotent across stale claims through durable child-run keys and relink behavior.
- Worker debate jobs handle stale claims, late child-run output, terminal failures, quota finalization, and bridge readiness.
- Deterministic fake judging is the default; live model judging is internal to debate creation and requires explicit spend confirmation.
- Production preflight and canary default to fake/no-spend hosted debate; live debate canary paths fail before provider dispatch unless spend is confirmed.
- Product, README, development, production, adapter docs, and contract assertions state the R24 shipped and unshipped boundary.

## Checks

- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm --filter @switchyard/contracts openapi:check:hosted`
- `pnpm --filter @switchyard/storage test -- postgres-debate`
- `pnpm --filter @switchyard/storage test -- postgres-run-store`
- `pnpm --filter @switchyard/storage test -- postgres-schema-compat`
- `pnpm --filter @switchyard/core test -- debate-real-runtime`
- `pnpm --filter @switchyard/core test -- debate-service`
- `pnpm --filter @switchyard/core test -- debate-judge-runner`
- `pnpm --filter @switchyard/protocol-rest test -- debate-routes`
- `pnpm --filter @switchyard/protocol-rest test -- hosted-auth`
- `pnpm --filter @switchyard/server test -- hosted-server`
- `pnpm --filter @switchyard/server test -- production-readiness`
- `pnpm --filter @switchyard/worker test -- hosted-worker`
- `pnpm --filter @switchyard/worker test -- production-worker-readiness`
- `pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts deploy/production/production-manifest.test.ts`
- `pnpm typecheck`
- `pnpm build`
- `pnpm lint`
- `git diff --check`
- Forbidden-route grep over hosted/local generated OpenAPI: no matches.

## Audit Fixes

- Restored current-product `fake-only remains default` wording without changing the R24 boundary.
- Made hosted runtime bridge approval tests wall-clock stable with deterministic test time.
- Updated stale hosted-boundary contract assertions so they match R22/R24 truth: hosted `fetch`, `web_search`, `github`, and command-catalog `shell` are shipped; hosted browser automation and hosted `repo` remain unshipped.
- Stabilized the endpoint inventory drift test timeout while preserving exact route-inventory equality.

## Redflags

- None.

## Deferred Concerns

- None.

## Residual Risk

Required verification stayed fake/no-spend by design. No live provider-spend debate canary was executed; live participant and live judge paths remain operator-owned and require explicit spend confirmation.
