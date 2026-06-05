# Audit log: P2-T3-adapter-manifests-and-codex-checks

## 2026-05-29T19:10:35Z — Pass 1 (per-worktree)

**Verdict:** NEEDS_REVISION

**Files reviewed:**
- `packages/testkit/src/fake-runtime-adapter.ts`
- `packages/testkit/test/fake-runtime-adapter.test.ts`
- `packages/adapters/src/codex/types.ts`
- `packages/adapters/src/codex/codex-model-catalog.ts`
- `packages/adapters/src/codex/codex-exec-json-adapter.ts`
- `packages/adapters/src/index.ts`
- `packages/adapters/test/codex-model-catalog.test.ts`
- `packages/adapters/test/codex-exec-json-adapter.test.ts`

**Checks run:**
- `pnpm --filter @switchyard/testkit test` ✅
- `pnpm --filter @switchyard/adapters test` ✅
- `pnpm typecheck` ✅
- `pnpm test` ✅
- `pnpm build` ✅
- `pnpm lint` ✅

**Findings:**
- [high] `packages/adapters/src/codex/codex-exec-json-adapter.ts:156` — `CodexExecJsonAdapter.check()` drops `probe.optionalChecks` when converting a `CodexCatalogProbe` into `RuntimeAdapterCheck.details`.
  - Required change: include `optionalChecks` in the returned `details` payload so the doctor layer can distinguish required-success + optional-warning as `partial`.

**Required changes (if NEEDS_REVISION):**
1. Thread `probe.optionalChecks` through `CodexExecJsonAdapter.check()`.
2. Add regression coverage proving a partial Codex probe survives adapter conversion and reaches the doctor layer as warning diagnostics instead of being flattened to `available`.

**Notes:**
- Fake and Codex manifests otherwise stay within the R3 scope: `fake.deterministic` and `codex.exec_json` only, with no interactive/PTY/hosted claims.
- This omission causes the active-check redflag recorded in `P2-T6`.

## 2026-05-29T19:21:56Z — Pass 2 (re-audit)

**Verdict:** GREEN

**Checks run:**
- `pnpm --filter @switchyard/adapters test` ✅
- `pnpm --filter @switchyard/core test` ✅
- `pnpm typecheck` ✅
- `pnpm test` ✅
- `pnpm build` ✅
- `pnpm lint` ✅

**Findings:**
- None. Prior required changes resolved.

**Notes:**
- `CodexExecJsonAdapter.check()` now forwards `optionalChecks` in `RuntimeAdapterCheck.details`.
- Regression coverage exists in `packages/adapters/test/codex-exec-json-adapter.test.ts` for the optional-check forwarding path.
