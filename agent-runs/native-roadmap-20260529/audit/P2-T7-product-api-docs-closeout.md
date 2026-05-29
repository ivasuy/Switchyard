# Audit log: P2-T7-product-api-docs-closeout

## 2026-05-29T19:10:35Z — Pass 1 (per-worktree)

**Verdict:** NEEDS_REVISION

**Files reviewed:**
- `PRODUCT.md`
- `CHANGELOG.md`
- `docs/development/API.md`
- `docs/development/DEVELOPMENT.md`
- `docs/development/adapters/CODEX.md`
- `docs/adapters/README.md`
- `ARCHITECTURE.md`

**Checks run:**
- `git diff --check` ✅
- `pnpm --filter @switchyard/protocol-rest test` ✅
- `pnpm --filter @switchyard/daemon test` ✅
- `pnpm typecheck` ✅
- `pnpm test` ✅
- `pnpm build` ✅
- `pnpm lint` ✅

**Findings:**
- [high] `CHANGELOG.md:5` — the Unreleased section still says `No unreleased changes.` even though this phase adds the R3 runtime capability infrastructure. This misses the explicit T7 acceptance gate.
  - Required change: replace the placeholder with an actual Unreleased R3 entry for the shipped runtime capability work.
- [high] `PRODUCT.md:101` and `PRODUCT.md:120` — the current product truth is not aligned with shipped R3 behavior. It lists shipped runtime modes as `fake`/`codex.exec_json` instead of the two shipped mode slugs, and the implemented-endpoints list omits `GET /runtime-modes`, `GET /runtime-modes/:id`, `POST /runtime-modes/:id/check`, and `GET /doctor`.
  - Required change: update the current-truth sections so they name only `fake.deterministic` and `codex.exec_json` as shipped runtime modes and include the new capability/doctor endpoints in the implemented API list.
- [high] `docs/development/API.md:294` — the API contract still says capability and partial-support reporting are `R3+`, which is stale after this phase ships; the runtime-mode section also lacks example payloads even though T7 acceptance requires endpoint examples.
  - Required change: remove the stale future-tense R3 note and add concrete example payloads for `GET /runtime-modes`, `GET /runtime-modes/:id`, `POST /runtime-modes/:id/check`, and `GET /doctor` that match the shipped response shapes.

**Required changes (if NEEDS_REVISION):**
1. Turn the changelog placeholder into a real Unreleased R3 entry.
2. Bring `PRODUCT.md` current-truth sections in line with the shipped runtime-mode vocabulary and capability endpoints.
3. Bring `docs/development/API.md` fully into shipped-tense R3 truth and add response examples for the runtime-mode/doctor endpoints.

**Notes:**
- `docs/development/DEVELOPMENT.md`, `docs/development/adapters/CODEX.md`, and `docs/adapters/README.md` are generally aligned with the shipped R3 scope.
