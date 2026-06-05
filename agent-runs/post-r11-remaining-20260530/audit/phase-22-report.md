# Phase 22 Audit Report

**Spec:** docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md
**Plan:** docs/superpowers/plans/2026-06-01-phase-22-r23-hosted-runtime-bridges.md
**Phase branch:** agent/phase-22-r23-hosted-runtime-bridges
**Audit passes:** 1
**Date:** 2026-06-02

## Per-Task Verdicts

### P22-T1-contracts-openapi
- Final verdict: GREEN
- Files: contracts/openapi + hosted runtime bridge schema + route inventory tests
- Tests:
  - `pnpm --filter @switchyard/contracts test -- openapi.contract.test.ts endpoint-inventory.drift.test.ts http-error.contract.test.ts contracts.test.ts` passed on rerun
  - `pnpm --filter @switchyard/contracts openapi:check` passed
  - `pnpm --filter @switchyard/contracts openapi:check:hosted` passed
- Notes: Hosted route surface remains limited to existing run input and approval routes; supported hosted bridge modes remain `claude_code.sdk` and `opencode.acp`.

### P22-T2-storage-outbox
- Final verdict: GREEN
- Files: Postgres hosted runtime bridge command/payload stores and schema
- Tests:
  - `pnpm --filter @switchyard/storage test -- postgres-runtime-bridge-store.test.ts postgres-runtime-bridge-payload-store.test.ts postgres-schema-compat.test.ts storage-package.test.ts` passed
- Notes: Shared durable command and payload stores are present; stale non-idempotent claims fail closed with `hosted_runtime_bridge_non_idempotent_retry_blocked`.

### P22-T3-core-bridge-orchestration
- Final verdict: GREEN
- Files: hosted runtime bridge service, catalog, runner wiring
- Tests:
  - `pnpm --filter @switchyard/core test -- hosted-runtime-bridge-service.test.ts hosted-runtime-catalog.test.ts` passed
- Notes: Admission, idempotency, quota metadata, payload hashing, stale-claim reconciliation, and unsupported-mode denials are implemented in core.

### P22-T4-rest-server-admission
- Final verdict: GREEN
- Files: run routes, hosted approval routes, hosted server wiring
- Tests:
  - `pnpm --filter @switchyard/protocol-rest test -- run-routes.test.ts hosted-tool-routes.test.ts` passed
  - `pnpm --filter @switchyard/server test -- hosted-server.test.ts production-readiness.test.ts` passed
- Notes: Existing `POST /runs/:id/input` and approval endpoints are reused; approval ownership checks run before scope classification; no hosted `POST /approvals` was added.

### P22-T5-claude-hosted-bridge
- Final verdict: GREEN
- Files: Claude adapter + hosted wiring
- Tests:
  - `pnpm --filter @switchyard/adapters test -- claude-code-adapter.test.ts ...` passed
- Notes: Hosted Claude post-start input and approval resolution stay worker-owned and redacted.

### P22-T6-acp-permission-protocol
- Final verdict: GREEN
- Files: ACP stdio client and protocol tests
- Tests:
  - `pnpm --filter @switchyard/protocol-acpx test -- acp-stdio-client.test.ts protocol-framing.test.ts` passed
- Notes: `session/request_permission` is held and later answered explicitly; unsupported ACP requests still receive method-not-found.

### P22-T7-opencode-hosted-bridge
- Final verdict: GREEN
- Files: OpenCode ACP adapter + tests
- Tests:
  - `pnpm --filter @switchyard/adapters test -- ... opencode-acp-adapter.test.ts ...` passed
- Notes: Hosted OpenCode bridge is structured ACP JSON-RPC only; no PTY or terminal automation path was added.

### P22-T8-worker-bridge-orchestration
- Final verdict: GREEN
- Files: hosted worker bridge orchestration, readiness, adapter enablement
- Tests:
  - `pnpm --filter @switchyard/worker test -- hosted-worker.test.ts production-worker-readiness.test.ts` passed
- Notes: Worker-owned handoff uses shared command and payload stores across server and worker, with readiness/admission fail-closed behavior when stores are unavailable.

### P22-T9-ops-docs-product-truth
- Final verdict: GREEN
- Files: readiness, preflight, canary, docs, PRODUCT/README
- Tests:
  - `pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts` passed
- Notes: Product truth, readiness/preflight, and no-spend defaults match the shipped R23 bridge matrix.

## Aggregate Files Changed

- `PRODUCT.md` `+16/-9`
- `README.md` `+8/-2`
- `apps/server/src/app.ts` `+245/-4`
- `apps/server/src/readiness.ts` `+94/-0`
- `apps/server/test/hosted-server.test.ts` `+56/-1`
- `apps/server/test/production-readiness.test.ts` `+1/-1`
- `apps/worker/src/hosted-runtime-adapters.ts` `+3/-0`
- `apps/worker/src/worker.ts` `+334/-4`
- `apps/worker/test/hosted-worker.test.ts` `+427/-4`
- `apps/worker/test/production-worker-readiness.test.ts` `+31/-0`
- `deploy/production/manifest.json` `+4/-0`
- `deploy/production/production-manifest.test.ts` `+8/-0`
- `docs/development/DEVELOPMENT.md` `+16/-4`
- `docs/development/adapters/AGENTFIELD.md` `+2/-0`
- `docs/development/adapters/CLAUDE_CODE.md` `+3/-3`
- `docs/development/adapters/GENERIC_HTTP.md` `+2/-0`
- `docs/development/adapters/OPENCODE.md` `+5/-7`
- `docs/superpowers/plans/2026-06-01-phase-22-r23-hosted-runtime-bridges.md` `+808/-0`
- `docs/superpowers/specs/2026-06-01-phase-22-r23-hosted-runtime-bridges.md` `+737/-0`
- `packages/adapters/src/claude-code/claude-code-adapter.ts` `+41/-15`
- `packages/adapters/src/opencode/opencode-acp-adapter.ts` `+255/-16`
- `packages/contracts/src/hosted-runtime-bridge.ts` `+190/-0`
- `packages/core/src/services/hosted-runtime-bridge-service.ts` `+1138/-0`
- `packages/core/src/services/hosted-runtime-catalog.ts` `+44/-22`
- `packages/protocol-acpx/src/acp-stdio-client.ts` `+195/-3`
- `packages/protocol-rest/src/hosted-tool-routes.ts` `+128/-30`
- `packages/protocol-rest/src/run-routes.ts` `+101/-7`
- `packages/storage/src/postgres/hosted-runtime-bridge-command-store.ts` `+538/-0`
- `packages/storage/src/postgres/hosted-runtime-bridge-payload-store.ts` `+59/-0`
- `scripts/production-preflight.ts` `+184/-1`
- `scripts/production-canary.ts` `+40/-3`

## Integration Notes

- Hosted server remains the admission layer only. It persists bridge commands and shared payload-store entries, applies auth/ownership/quota/audit, and never instantiates provider adapters.
- Hosted worker remains the only owner of provider sessions. It stamps `hostedWorkerId`, reconciles stale bridge state, claims durable commands, revalidates payload hashes and session ownership, and dispatches through `RuntimeRunnerService.sendInput`.
- Hosted bridge support remains closed to `claude_code.sdk` and `opencode.acp`. Hosted `codex.exec_json` stays one-shot with named unsupported input/approval errors. Hosted `codex.interactive`, AgentField, and Generic HTTP bridges remain unshipped and fail closed.
- Approval list/get/approve/reject routes now safely mix tool approvals and supported runtime approvals without tenant leakage because ownership authorization happens before scope classification.
- Readiness/preflight/canary/doc truth all state that shared Postgres-backed command and payload stores are required for usable hosted runtime bridges.

## Deferred Concerns

- None.

## Merge Outcome

- Audit verdict is GREEN, but no merge was performed in this audit pass per instruction. `merge_done` remains `false` for runtime handling.
