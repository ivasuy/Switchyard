# Phase 17 Audit Report

**Status:** `GREEN`
**Spec:** `docs/superpowers/specs/2026-05-30-phase-17-r18-enterprise-auth-billing-tenant-controls.md`
**Plan:** `docs/superpowers/plans/2026-05-30-phase-17-r18-enterprise-auth-billing-tenant-controls.md`
**Branch:** `agent/phase-17-r18-enterprise-auth-billing-tenant-controls`
**Audit pass:** 2
**Date:** 2026-05-31

## Commits / Tasks Covered

- `P17-T1` enterprise contracts/errors — `3dbbb17`, `2a71316`
- `P17-T2` core control-plane service — `18621cc`, `dfb77dc`
- `P17-T3` storage ownership/control-plane store — `adba472`, `9d921be`
- `P17-T4` hosted REST auth/tenant/quota/audit — `22851b4`, `5150380`, `c92e5b1`
- `P17-T5` node tenant controls — `3dbb0a8`, `bdf81d2`
- `P17-T6` server config/readiness/metrics wiring — `fac0fd5`, `5184bac`
- `P17-T7` hosted OpenAPI contract — `9ef92e3`
- `P17-T8` local compat/docs/no-spend — `392595b`
- Pass-2 fix commit — `d764afa5f64c268cebae488d4fb7369d3854e621`

## Checks

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

## Acceptance Coverage Summary

- Hosted/server API-key auth, local no-auth defaults, hosted OpenAPI generation, metrics protection, and no-spend compatibility checks are implemented and test-covered.
- Pass-1 blockers are resolved:
  - hosted artifact content authorization now runs before artifact existence/content-state branches;
  - quota reservations and audit events now receive durable `resource_ownership`, and readiness fails on unowned counts for those classes.

## Re-Audit Outcome

- Artifact ownership now gates `/artifacts/:id/content` before artifact existence/content-state checks at [artifact-routes.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/protocol-rest/src/artifact-routes.ts:79).
- Quota reservations now carry actor ownership context from preflight and attach durable `quota` ownership rows in the store at [control-plane-service.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/core/src/services/control-plane-service.ts:376) and [control-plane-store.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/storage/src/postgres/control-plane-store.ts:243).
- Audit events now attach durable `audit_log_event` ownership rows and readiness includes unowned `auditEvents` and `quotaReservations` in the fail-closed gate at [control-plane-store.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/packages/storage/src/postgres/control-plane-store.ts:506) and [readiness.ts](/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/post-r11-remaining-20260530/phase-17-r18-enterprise-auth-billing-tenant-controls/apps/server/src/readiness.ts:207).

## Deferred Concerns

- None.

## Non-Blocking Observations

- The full required phase check matrix passed again on pass 2, including the new regression coverage for both original findings.
