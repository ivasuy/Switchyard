# Audit log: P5-T1-agentfield-async-rest-runtime

## 2026-05-30T09:56:00+05:30 — Pass 1 (per-worktree)

**Verdict:** NEEDS_REVISION

**Findings:**
- [high] `PRODUCT.md:533` — The R6 roadmap section still says `Status: planned.` even though this branch ships the AgentField runtime and `CHANGELOG.md` records the release as shipped.
  - Required change: Update the `### R6: Wrapper Runtime Integration` section in `PRODUCT.md` to shipped-tense product truth, matching the implemented and tested `agentfield.async_rest` behavior and the release notes.
- [high] `docs/development/API.md:598` — The public API guide still says only Generic HTTP and OpenCode transcripts are exposed through the artifact APIs, but this phase ships and tests AgentField transcript/result artifact retrieval through the same endpoints.
  - Required change: Correct the artifact retrieval documentation so AgentField is included anywhere the shipped artifact APIs are described, or rewrite the sentence so it is not false by omission.

**Required changes:**
1. Fix the R6 product-truth section in `PRODUCT.md` so the release is explicitly shipped rather than planned.
2. Fix the public API docs so AgentField artifact retrieval is documented accurately alongside the existing artifact endpoints.

**Notes:**
- Worktree was clean before audit-log writes and `HEAD` matched the requested implementation commit `17dd8e884181e8f34aa4dab694b191a13a7f15c2`.
- Focused Phase 5 checks passed: `git diff --check`, `pnpm --filter @switchyard/testkit test -- fake-agentfield`, `pnpm --filter @switchyard/testkit typecheck`, `pnpm --filter @switchyard/adapters test -- agentfield`, `pnpm --filter @switchyard/adapters test -- runtime-adapter-contracts`, `pnpm --filter @switchyard/core test -- registry-service`, `pnpm --filter @switchyard/contracts test -- contracts`, `pnpm --filter @switchyard/protocol-rest test -- run-routes`, `pnpm --filter @switchyard/daemon test -- smoke`, `pnpm --filter @switchyard/adapters typecheck`, and `pnpm --filter @switchyard/daemon typecheck`.
- Verified no new `scripts/codex-org` usage was introduced by the implementation commit, and the commit itself did not modify `PROJECT.md`.

## 2026-05-30T10:05:00+05:30 — Implementer revision response

**Status:** addressed pending auditor re-check

**Changes made:**
- Updated `PRODUCT.md` R6 roadmap section from planned wording to shipped-tense product truth for `agentfield.async_rest`, including implemented create/poll/status/result/artifact behavior, doctor/runtime-mode availability, unsupported active cancel, Switchyard timeout handling, and explicit out-of-scope boundaries.
- Updated `docs/development/API.md` artifact API wording so AgentField transcript/result artifacts are included alongside Generic HTTP and OpenCode artifacts.

**Verification:**
- `git diff --check` passed after the doc fixes.

## 2026-05-30T10:02:27+05:30 — Pass 2 (re-audit)

**Verdict:** GREEN

**Scope:**
- Re-checked only the two pass-1 redflags for `PRODUCT.md` and `docs/development/API.md`.
- Verified branch cleanliness and inspected the committed delta since pass 1.

**Verified:**
- `PRODUCT.md:533` now marks `### R6: Wrapper Runtime Integration` as `Status: shipped on \`agent/phase-5-r6-wrapper-runtime-integration\`.` and the surrounding section now matches the shipped `agentfield.async_rest` scope and boundaries required by the Phase 5 acceptance criteria.
- `docs/development/API.md:598` now documents that runtime transcript/result artifacts exposed through `GET /runs/:id/artifacts`, `GET /artifacts/:id`, and `GET /artifacts/:id/content` include AgentField transcript/result artifacts alongside Generic HTTP and OpenCode artifacts.
- `git log --oneline 17dd8e884181e8f34aa4dab694b191a13a7f15c2..HEAD` shows exactly one follow-up commit, `653a7d8 docs: fix r6 product truth`, and no unrelated implementation churn.
- `git diff --check` passed on the re-audited head.
- The worktree was clean before these audit-log updates, so only committed implementation changes were re-audited.

**Result:**
- All prior blocking findings for `P5-T1-agentfield-async-rest-runtime` are resolved.
