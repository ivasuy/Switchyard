# P4-T4 Audit Log

**Date:** 2026-05-30
**Final Verdict:** GREEN

## Verification

- Verified `RegistryService.inferAndValidateRuntimeMode()` infers `opencode.acp` only for `runtime: "opencode"` plus `adapterType: "acpx"` in `packages/core/src/services/registry-service.ts`.
- Verified explicit internal ids such as `runtime_mode_opencode_acp` are rejected from public bodies.
- Verified contract tests cover the `opencode.acp` runtime-mode fixture and negative capability parsing.
- Verified `pnpm --filter @switchyard/contracts test` and `pnpm --filter @switchyard/core test` passed during the phase audit.

## Notes

- Existing fake, Codex, and Generic HTTP inference paths remain intact.
