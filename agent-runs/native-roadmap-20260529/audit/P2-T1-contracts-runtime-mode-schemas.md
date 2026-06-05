# Audit log: P2-T1-contracts-runtime-mode-schemas

## 2026-05-29T19:10:35Z — Pass 1 (per-worktree)

**Verdict:** GREEN

**Files reviewed:**
- `packages/contracts/src/ids.ts`
- `packages/contracts/src/registry.ts`
- `packages/contracts/src/run.ts`
- `packages/contracts/src/session.ts`
- `packages/contracts/src/list-queries.ts`
- `packages/contracts/src/http-error.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/test/contracts.test.ts`

**Checks run:**
- `pnpm --filter @switchyard/contracts test` ✅
- `pnpm typecheck` ✅
- `pnpm test` ✅
- `pnpm build` ✅
- `pnpm lint` ✅

**Findings:**
- None.

**Notes:**
- `runtimeModeSlugSchema` accepts shipped slugs and rejects malformed/internal-id forms.
- `runSchema` and `runtimeSessionSchema` preserve pre-R3 compatibility through optional and nullable-compatible `runtimeMode` handling.
- `runtime_mode_not_found` is present in the closed HTTP error code set.
