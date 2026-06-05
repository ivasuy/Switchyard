# P4-T6 Audit Log

**Date:** 2026-05-30
**Final Verdict:** GREEN

## Blocking Finding

- `checkOpenCodeAcpAvailability()` misclassifies invalid ACP `initialize` payloads as `opencode_acp_session_new_failed` instead of `opencode_acp_initialize_failed`.
  - Spec contract: `docs/superpowers/specs/2026-05-29-phase-4-r5-acp-foundation-and-opencode.md:635` requires invalid initialize to map to `opencode_acp_initialize_failed`.
  - Plan contract: `docs/superpowers/plans/phase-4-r5-acp-foundation-and-opencode.md:603` requires the same reason code.
  - Implementation: `packages/adapters/src/opencode/opencode-doctor.ts:92-110` parses initialize before `session/new`, but the fallback at `packages/adapters/src/opencode/opencode-doctor.ts:204-213` returns `opencode_acp_session_new_failed` for schema failures raised during initialize parsing.
  - The shipped test locks in the wrong behavior at `packages/adapters/test/opencode-acp-adapter.test.ts:60-66`.

## Reproduction

- Final verification remained green, but a direct adapter check against the shipped fake invalid-initialize scenario reproduced the mismatch:
  - `pnpm exec tsx -e "...OpenCodeAcpAdapter({ processFactory: createFakeAcpProcessFactory({ scenario: 'invalid_initialize' }) ... }).check()..."`
  - Observed result: `reasonCode: "opencode_acp_session_new_failed"`.

## Required Change

- Map initialize schema failures to `opencode_acp_initialize_failed`.
- Update the corresponding adapter test so the doctor matrix matches the Phase 4 spec and plan.

## Non-Blocking Verification

- Verified the adapter remains OpenCode-local, `session/prompt` is not used in doctor/check, permission requests fail visibly as `acp_permission_request_unsupported`, and transcript artifacts remain retrievable for completed, cancelled, failed-after-start, and timeout-after-start runs.

## Pass 2 Verification

- Verified `HEAD` contains fix commit `2ca1a597f513c21ac4c7071e8593d0d358cc530f`.
- Verified the only committed delta since the prior audit head `b64568014f66b39baac947d5581bb8a8ffc2c0d2` is the targeted OpenCode doctor/test fix.
- Verified `git diff --check` passed on the phase worktree.
- Verified `pnpm --filter @switchyard/adapters test` passed.
- Verified `pnpm --filter @switchyard/protocol-acpx test` passed.
- Verified `pnpm typecheck` passed.
- Verified `packages/adapters/src/opencode/opencode-doctor.ts` now tracks failure stage and maps initialize-path failures to `opencode_acp_initialize_failed`, while preserving `opencode_acp_session_new_failed` for session-new failures.
- Verified `packages/adapters/test/opencode-acp-adapter.test.ts` now asserts both `invalid_initialize -> opencode_acp_initialize_failed` and `invalid_session_new -> opencode_acp_session_new_failed`.
- Reproduced the exact prior audit scenario directly with the shipped fake ACP process:
  - `invalid_initialize` now returns `reasonCode: "opencode_acp_initialize_failed"`.
  - `invalid_session_new` still returns `reasonCode: "opencode_acp_session_new_failed"`.

## Resolution

- Prior blocker resolved. The OpenCode doctor now reports initialize failures with the spec-required reason code without regressing the neighboring session-new mapping.
