# P7-T1 R8 Interactive Coding Runtimes Audit Log

**Date:** 2026-05-30
**Pass:** 1
**Verdict:** GREEN

## Scope

- Audited committed Phase 7 changes at `e7dba0344dd700e7cf9551106adad0a079941ef1` against:
  - `docs/superpowers/specs/2026-05-30-phase-7-r8-interactive-coding-runtimes.md`
  - `docs/superpowers/plans/2026-05-30-phase-7-r8-interactive-coding-runtimes.md`
- Focused on the shipped boundary called out for audit:
  - no-spend Claude doctor defaults
  - structured Claude runtime path without PTY/TUI automation
  - Codex one-shot boundary and unsupported input semantics
  - no overclaim of `session.resume`
  - post-start input, runtime approvals, transcript bounds
  - daemon/REST/doctor wiring and product/docs truth

## Verification

- Mergeability:
  - `git status --short --branch` in the phase worktree was clean at the audited head
  - `git diff --check` passed
  - `git rev-list --count main..HEAD` returned `58`
- Required verification:
  - `pnpm typecheck` passed
  - `pnpm --filter @switchyard/contracts test` passed
  - `pnpm --filter @switchyard/core test -- core` passed
  - `pnpm --filter @switchyard/core test -- middleware-services` passed
  - `pnpm --filter @switchyard/adapters test -- claude-code-adapter` passed
  - `pnpm --filter @switchyard/adapters test -- claude-code-cli-client` passed
  - `pnpm --filter @switchyard/adapters test -- claude-code-transcript-bounds` passed
  - `pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter` passed
  - `pnpm --filter @switchyard/adapters test -- runtime-adapter-contracts` passed
  - `pnpm --filter @switchyard/testkit test` passed
  - `pnpm --filter @switchyard/daemon test -- smoke` passed
  - `pnpm test` passed for the full workspace
- No-spend CLI probes:
  - `claude --help` shows structured `--print`, `--input-format stream-json`, `--output-format stream-json`, `--max-budget-usd`, `--resume`, and permission controls
  - `codex --help` shows interactive surfaces exist in the CLI generally, but the shipped Switchyard path remains separate
  - `codex exec resume --help` confirms one-shot `--json` resume exists locally, but the implementation correctly keeps it deferred from the shipped runtime mode

## Findings

- No blocking findings.

## Notes

- `packages/adapters/src/claude-code/claude-code-adapter.ts` and `packages/adapters/src/claude-code/claude-code-cli-client.ts` keep the Claude runtime on a structured stream-json path and do not introduce PTY/TUI automation.
- `packages/contracts/test/contracts.test.ts` and the Claude manifest keep `session.resume` out of shipped `claude_code.sdk` capabilities while `docs/*`, `PRODUCT.md`, and `CHANGELOG.md` state that resume remains deferred.
- `packages/core/src/services/runtime-runner-service.ts`, `packages/core/src/services/approval-service.ts`, and daemon smoke coverage prove post-start input, runtime approval bridging, waiting statuses, and bounded transcript/session behavior without adding a second approval store or unbounded spend defaults.
- `packages/adapters/src/codex/codex-exec-json-adapter.ts` preserves `codex.exec_json` as one-shot and keeps `POST /runs/:id/input` unsupported with `codex_input_unsupported`.
