# Audit log: P2-T5-rest-runtime-mode-and-run-compat-api

## 2026-05-29T19:10:35Z — Pass 1 (per-worktree)

**Verdict:** GREEN

**Files reviewed:**
- `packages/protocol-rest/src/registry-helpers.ts`
- `packages/protocol-rest/src/registry-routes.ts`
- `packages/protocol-rest/src/run-routes.ts`
- `packages/protocol-rest/src/http-errors.ts`
- `packages/protocol-rest/src/index.ts`
- `packages/protocol-rest/test/registry-routes.test.ts`
- `packages/protocol-rest/test/run-routes.test.ts`
- `packages/protocol-rest/test/list-routes.test.ts`

**Checks run:**
- `pnpm --filter @switchyard/protocol-rest test` ✅
- `pnpm typecheck` ✅
- `pnpm test` ✅
- `pnpm build` ✅
- `pnpm lint` ✅

**Findings:**
- None in the REST surface itself.

**Notes:**
- `GET /runtime-modes`, `GET /runtime-modes/:id`, `POST /runtime-modes/:id/check`, and `GET /doctor` are mounted in the existing Fastify style.
- Explicit `runtimeMode` validation is slug-only and backward-compatible when omitted.
- Missing runtime-mode lookups return `404 runtime_mode_not_found`.
