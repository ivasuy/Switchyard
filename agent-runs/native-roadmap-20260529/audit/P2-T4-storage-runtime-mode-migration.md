# Audit log: P2-T4-storage-runtime-mode-migration

## 2026-05-29T19:10:35Z — Pass 1 (per-worktree)

**Verdict:** GREEN

**Files reviewed:**
- `packages/storage/src/sqlite/schema.ts`
- `packages/storage/src/sqlite/database.ts`
- `packages/storage/src/sqlite/registry-store.ts`
- `packages/storage/src/sqlite/run-store.ts`
- `packages/storage/src/sqlite/session-store.ts`
- `packages/storage/test/sqlite-storage.test.ts`
- `packages/testkit/src/fake-stores.ts`

**Checks run:**
- `pnpm --filter @switchyard/storage test` ✅
- `pnpm --filter @switchyard/testkit test` ✅
- `pnpm typecheck` ✅
- `pnpm test` ✅
- `pnpm build` ✅
- `pnpm lint` ✅

**Findings:**
- None.

**Notes:**
- Migration is additive: `runtime_modes` table plus nullable `runtime_mode` columns on `runs` and `runtime_sessions`.
- Pre-R3 reopen coverage exists in `packages/storage/test/sqlite-storage.test.ts`.
- Runtime mode JSON fields are validated on read through `runtimeModeSchema.parse()`, so malformed persisted rows fail loudly instead of leaking invalid public records.
