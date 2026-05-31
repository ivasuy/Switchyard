# Phase 17 Audit Log: Enterprise Auth, Billing, And Tenant Controls

**Date:** 2026-05-31
**Branch:** `agent/phase-17-r18-enterprise-auth-billing-tenant-controls`
**Audit pass:** 1
**Verdict:** `NEEDS_REVISION`

## Scope

- Phase commits audited: `3dbbb17`, `2a71316`, `18621cc`, `dfb77dc`, `adba472`, `9d921be`, `22851b4`, `5150380`, `c92e5b1`, `3dbb0a8`, `bdf81d2`, `fac0fd5`, `5184bac`, `9ef92e3`, `392595b`
- Tasks covered: `P17-T1` through `P17-T8`
- Working tree status: clean
- `git diff --check`: pass

## Checks

- `pnpm --filter @switchyard/contracts test` — pass
- `pnpm --filter @switchyard/contracts openapi:check` — pass
- `pnpm --filter @switchyard/contracts openapi:check:hosted` — pass
- `pnpm --filter @switchyard/core test` — pass
- `pnpm --filter @switchyard/storage test` — pass
- `pnpm --filter @switchyard/protocol-rest test` — pass
- `pnpm --filter @switchyard/protocol-node test` — pass
- `pnpm --filter @switchyard/server test` — pass
- `pnpm --filter @switchyard/daemon test` — pass
- `pnpm --filter @switchyard/sdk test` — pass
- `pnpm --filter @switchyard/cli test` — pass
- `pnpm typecheck` — pass

## Redflags

### 1. Hosted artifact content route leaks cross-tenant artifact existence/state before ownership enforcement

- Severity: critical
- Tasks: `P17-T4`, `P17-T6`
- Files: `packages/protocol-rest/src/artifact-routes.ts`
- Evidence:
  - [packages/protocol-rest/src/artifact-routes.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/protocol-rest/src/artifact-routes.ts:80) fetches the artifact row before any tenant/project authorization.
  - [packages/protocol-rest/src/artifact-routes.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/protocol-rest/src/artifact-routes.ts:85) returns `missing_artifact_content` immediately when `contentStored === false`.
  - Ownership, scope, entitlement, and byte-quota checks do not run until [packages/protocol-rest/src/artifact-routes.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/protocol-rest/src/artifact-routes.ts:91).
- Why this blocks:
  - The phase acceptance requires artifact metadata/content reads to enforce tenant/project ownership, `artifacts:read`, entitlement, and byte quota before exposure.
  - An authenticated caller from another tenant can probe a guessed artifact id and distinguish an existing artifact with no stored content from a nonexistent artifact without ever passing ownership authorization.
- Required change:
  - Enforce ownership authorization before any artifact existence/content-state branch that can affect the response, and add a regression test covering an unowned artifact with `contentStored === false`.

### 2. Quota reservations and audit events are never attached into `resource_ownership`, and readiness ignores those unowned counts

- Severity: critical
- Tasks: `P17-T2`, `P17-T3`, `P17-T6`
- Files: `packages/core/src/services/control-plane-service.ts`, `packages/storage/src/postgres/control-plane-store.ts`, `apps/server/src/readiness.ts`
- Evidence:
  - `preflightRunCreate`, `preflightArtifactContentRead`, and `preflightNodeRegister` reserve quota via `store.reserveQuota(...)` with no ownership attach path: [packages/core/src/services/control-plane-service.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/core/src/services/control-plane-service.ts:359), [packages/core/src/services/control-plane-service.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/core/src/services/control-plane-service.ts:451), [packages/core/src/services/control-plane-service.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/core/src/services/control-plane-service.ts:503).
  - `reserveQuota()` writes `quota_reservations` rows but never creates `resource_ownership` rows for resource type `quota`: [packages/storage/src/postgres/control-plane-store.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/storage/src/postgres/control-plane-store.ts:187).
  - `recordAudit()` only appends audit rows; it never attaches `resource_ownership` for `audit_log_event`: [packages/core/src/services/control-plane-service.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/core/src/services/control-plane-service.ts:570), [packages/storage/src/postgres/control-plane-store.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/storage/src/postgres/control-plane-store.ts:470).
  - The store explicitly counts unowned `audit_log_event` and `quota` resources: [packages/storage/src/postgres/control-plane-store.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/storage/src/postgres/control-plane-store.ts:591).
  - `/ready` then ignores those two categories and only sums runs, run events, artifacts, placements, nodes, and assignments: [apps/server/src/readiness.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/apps/server/src/readiness.ts:207).
- Why this blocks:
  - The plan acceptance explicitly requires durable ownership for runs, events, artifacts, placement decisions, nodes, assignments, quota records, and audit events.
  - The plan also requires staging/production readiness to fail closed on unowned hosted resources. As written, quota reservations and audit events remain permanently unowned and readiness still reports green for that exact gap.
- Required change:
  - Create durable ownership rows for quota reservations and audit log events at creation time, then include `auditEvents` and `quotaReservations` in the readiness unowned-resource gate. Add regression tests that prove `/ready` fails when either class is unowned.

## Notes

- The required package and typecheck matrix passed; the remaining blockers are acceptance/security gaps that the current tests do not exercise.
- No deferred concerns recorded on pass 1.

## Re-Audit Pass 2

**Date:** 2026-05-31
**Commit reviewed:** `d764afa5f64c268cebae488d4fb7369d3854e621`
**Verdict:** `GREEN`

### Resolution Check

1. Artifact content authorization ordering
   - Resolved. Hosted `GET /artifacts/:id/content` now authorizes the artifact before any existence or `contentStored` branching at [packages/protocol-rest/src/artifact-routes.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/protocol-rest/src/artifact-routes.ts:79).
   - Regression coverage added for the exact unowned `contentStored=false` case in [packages/protocol-rest/test/artifact-routes.test.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/protocol-rest/test/artifact-routes.test.ts:200).

2. Quota/audit durable ownership and readiness gating
   - Resolved. Quota preflight now passes actor ownership context into reservations at [packages/core/src/services/control-plane-service.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/core/src/services/control-plane-service.ts:376).
   - Resolved. Quota reservations attach `resource_ownership` rows in the store at [packages/storage/src/postgres/control-plane-store.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/storage/src/postgres/control-plane-store.ts:243).
   - Resolved. Audit events attach `resource_ownership` rows in both Postgres and in-memory paths at [packages/storage/src/postgres/control-plane-store.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/storage/src/postgres/control-plane-store.ts:506).
   - Resolved. Readiness now includes unowned `auditEvents` and `quotaReservations` in the fail-closed total at [apps/server/src/readiness.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/apps/server/src/readiness.ts:207).
   - Regression coverage added in [packages/core/test/control-plane-service.test.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/core/test/control-plane-service.test.ts:1002), [packages/storage/test/control-plane-store.test.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/storage/test/control-plane-store.test.ts:338), and [apps/server/test/hosted-server.test.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/apps/server/test/hosted-server.test.ts:677).

### Pass 2 Checks

- `git diff --check` — pass
- `pnpm --filter @switchyard/contracts test` — pass
- `pnpm --filter @switchyard/contracts openapi:check` — pass
- `pnpm --filter @switchyard/contracts openapi:check:hosted` — pass
- `pnpm --filter @switchyard/core test` — pass
- `pnpm --filter @switchyard/storage test` — pass
- `pnpm --filter @switchyard/protocol-rest test` — pass
- `pnpm --filter @switchyard/protocol-node test` — pass
- `pnpm --filter @switchyard/server test` — pass
- `pnpm --filter @switchyard/daemon test` — pass
- `pnpm --filter @switchyard/sdk test` — pass
- `pnpm --filter @switchyard/cli test` — pass
- `pnpm typecheck` — pass
