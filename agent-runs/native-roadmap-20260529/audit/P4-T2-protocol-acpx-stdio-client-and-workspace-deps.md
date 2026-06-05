# P4-T2 Audit Log

**Date:** 2026-05-30
**Final Verdict:** GREEN

## Verification

- Verified `AcpStdioClient` in `packages/protocol-acpx/src/acp-stdio-client.ts` is protocol-scoped and reusable, with no OpenCode command default.
- Verified request correlation, typed id separation, permission-request surfacing, unsupported-method `-32601` replies, transcript capture, and idempotent close/kill behavior through the shipped tests.
- Verified adapters and testkit depend on `@switchyard/protocol-acpx` through workspace dependencies.
- Verified `pnpm --filter @switchyard/protocol-acpx test`, `pnpm --filter @switchyard/testkit test`, and `pnpm --filter @switchyard/adapters test` passed during the phase audit.

## Notes

- The client keeps ACP mechanics generic. OpenCode-specific launch and lifecycle behavior stays in the adapter layer.
