# Audit log: P2-T2-core-capability-doctor-services

## 2026-05-29T19:10:35Z — Pass 1 (per-worktree)

**Verdict:** GREEN

**Files reviewed:**
- `packages/core/src/ports/registry-store.ts`
- `packages/core/src/ports/runtime-adapter.ts`
- `packages/core/src/services/registry-service.ts`
- `packages/core/src/services/runtime-capability-service.ts`
- `packages/core/src/services/runtime-doctor-service.ts`
- `packages/core/src/services/run-service.ts`
- `packages/core/src/index.ts`
- `packages/core/test/core.test.ts`

**Checks run:**
- `pnpm --filter @switchyard/core test` ✅
- `pnpm typecheck` ✅
- `pnpm test` ✅
- `pnpm build` ✅
- `pnpm lint` ✅

**Findings:**
- None in the core service layer.

**Notes:**
- Runtime modes are first-class records in the registry service layer.
- Doctor summaries count `available`, `installed`, `partial`, `unavailable`, `unsupported`, and `unknown`.
- `RegistryService.inferAndValidateRuntimeMode()` keeps run creation backward compatible while enforcing slug-only explicit `runtimeMode` input.
