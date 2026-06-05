# Audit log: P2-T6-daemon-startup-capability-wiring

## 2026-05-29T19:10:35Z — Pass 1 (per-worktree)

**Verdict:** NEEDS_REVISION

**Files reviewed:**
- `apps/daemon/src/app.ts`
- `apps/daemon/test/smoke.test.ts`
- `packages/adapters/src/codex/codex-exec-json-adapter.ts`

**Checks run:**
- `pnpm --filter @switchyard/daemon test` ✅
- `pnpm typecheck` ✅
- `pnpm test` ✅
- `pnpm build` ✅
- `pnpm lint` ✅
- Manual reproduction:
  - `pnpm exec tsx -e 'import { createDaemonApp } from "./apps/daemon/src/app.ts"; void (async () => { const app = await createDaemonApp(undefined, { codexProbe: { ok:false, models:[], message:"missing" }, probeCodexCatalog: async () => ({ ok:true, version:"codex 0.0.0-test", models:[{ slug:"gpt-5.5", supportedReasoningLevels:["low"] }], optionalChecks:{ sandbox_policy_probe:{ ok:false, message:"optional sandbox probe failed" } } }) }); const res = await app.inject({ method:"POST", url:"/runtime-modes/codex.exec_json/check" }); console.log(res.statusCode); console.log(res.body); await app.close(); })();'` ❌

**Findings:**
- [high] `packages/adapters/src/codex/codex-exec-json-adapter.ts:156` + `apps/daemon/test/smoke.test.ts:249` — active Codex doctor checks cannot report `partial` because the adapter strips optional probe results, and the daemon smoke suite only exercises active checks for `available` and timeout cases. Reproduced behavior: `POST /runtime-modes/codex.exec_json/check` returns `state:"available"` for a probe that has required checks passing and `optionalChecks.sandbox_policy_probe.ok === false`.
  - Required change: preserve optional probe warnings end-to-end and add daemon coverage proving active check responses and subsequent `/doctor` snapshots become `partial` with `reasonCode:"optional_check_failed"` and warning diagnostics.

**Required changes (if NEEDS_REVISION):**
1. Fix the adapter-to-doctor data flow so active checks can surface `partial`.
2. Add a daemon smoke test for the active partial-check path, not just startup partial seeding.

**Notes:**
- Startup partial seeding is implemented and covered.
- The failing behavior is specifically the active check path required by the Phase 2 acceptance criteria.

## 2026-05-29T19:21:56Z — Pass 2 (re-audit)

**Verdict:** GREEN

**Checks run:**
- `pnpm --filter @switchyard/daemon test` ✅
- `pnpm --filter @switchyard/protocol-rest test` ✅
- `pnpm --filter @switchyard/core test` ✅
- `pnpm typecheck` ✅
- `pnpm test` ✅
- `pnpm build` ✅
- `pnpm lint` ✅
- Manual reproduction of active partial-check path ✅

**Findings:**
- None. Prior required changes resolved.

**Notes:**
- `apps/daemon/test/smoke.test.ts` now covers the active partial-check path.
- Manual recheck confirmed `POST /runtime-modes/codex.exec_json/check` returns `state:"partial"` with warning diagnostics, and subsequent `GET /doctor` reports `summary.partial: 1`.
