# Audit Log: P10-T1-r11-sdk-cli-hardening

Date: 2026-05-30
Iteration: 1
Verdict: GREEN
Revision audited: `56c52009b1776b8b996303c9a4a7fbb3f9f8d508`

## Scope

- Phase 10 / R11 SDK, CLI, And Hardening
- Worktree: `/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/native-roadmap-20260529/phase-10-r11-sdk-cli-and-hardening`
- Branch: `agent/phase-10-r11-sdk-cli-and-hardening`
- Spec: `docs/superpowers/specs/2026-05-30-phase-10-r11-sdk-cli-and-hardening.md`
- Plan: `docs/superpowers/plans/2026-05-30-phase-10-r11-sdk-cli-and-hardening.md`

## Checks Run

- `git status --short`
- `git diff --check`
- `pnpm install --lockfile-only`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm release:smoke-local`
- `pnpm typecheck`
- `pnpm test`
- `pnpm --filter @switchyard/cli exec node dist/bin.js runtime test`
- Direct probe: `daemon start` via CLI helper path and signal-driven shutdown behavior
- Direct review: Phase 10 delta vs Phase 9 head (`7633cb569eca8706ee169e6dc7291dc72831ed1f..HEAD`)
- Direct review: docs truth scan across `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `docs/development/API.md`, and `docs/development/DEVELOPMENT.md`

## Acceptance Verification

### 1. SDK lifecycle and typed error surface

Verified in:

- `packages/sdk/src/client.ts`
- `packages/sdk/src/errors.ts`
- `packages/sdk/src/client.test.ts`
- `pnpm test`
- `pnpm release:smoke-local`

Result:

- `@switchyard/sdk` ships `SwitchyardClient` with health, doctor, run lifecycle, event replay/live streaming, artifact metadata/content, registry discovery, and runtime-mode check methods.
- Artifact metadata (`GET /artifacts/:id`) and raw content (`GET /artifacts/:id/content`) remain separate in the client surface.
- Typed errors are implemented and exercised: `SwitchyardHttpError`, `SwitchyardNetworkError`, `SwitchyardDecodeError`, `SwitchyardTimeoutError`, `SwitchyardValidationError`, and `SwitchyardStreamError`.
- The smoke install proved the SDK works from a clean temp project against a launched local daemon, including `health`, `getRun`, `replayRunEvents`, `listRunArtifacts`, `getArtifact`, and `getArtifactContent`.

### 2. CLI commands

Verified in:

- `packages/cli/src/run-cli.ts`
- `packages/cli/src/run-cli.test.ts`
- `packages/cli/src/release-smoke-local.ts`
- `pnpm release:smoke-local`
- `pnpm --filter @switchyard/cli exec node dist/bin.js runtime test`

Result:

- `@switchyard/cli` ships the required commands: `doctor`, `daemon start`, `run fake`, `runtime test`, `debug run`, and `contract export`.
- The smoke path exercised `switchyard --help`, `contract export`, `doctor`, `run fake`, `debug run`, and daemon startup from packed tarballs in a clean temp install.
- `runtime test` runs locally and returns the deterministic no-spend compatibility matrix with pass/skip/fail rows and zero live-provider spend.
- CLI failure rendering preserves typed HTTP status/code/request-id information.

### 3. Deterministic contract output and drift protection

Verified in:

- `packages/contracts/src/endpoint-inventory.ts`
- `packages/contracts/src/openapi.ts`
- `packages/contracts/src/openapi-cli.ts`
- `packages/contracts/src/endpoint-inventory.drift.test.ts`
- `packages/contracts/src/openapi.contract.test.ts`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm test`

Result:

- Public local-daemon route descriptors live in `@switchyard/contracts`.
- OpenAPI 3.1 output is generated deterministically and committed at `packages/contracts/openapi.local-daemon.json`.
- Drift tests compare inventory routes against actual `createDaemonApp()` registration.
- Generator validation covers deterministic bytes, empty inventory rejection, unsupported content kinds, and unknown schema references.

### 4. SQLite migration policy and fixture preservation

Verified in:

- `packages/storage/src/sqlite/database.ts`
- `packages/storage/src/sqlite/database.hardening.test.ts`
- `pnpm test`

Result:

- SQLite schema versioning is explicit (`SQLITE_SCHEMA_VERSION = 11`) and migration policy helpers exist to reject destructive statements.
- Fixture tests cover representative pre-R3, pre-R7, pre-R9, and pre-R11 snapshots and preserve rows across the expected local tables.
- Zero-byte/corrupt-file guards and reopen-idempotency behavior are covered in the hardening suite.

### 5. Compatibility matrix and no-spend discipline

Verified in:

- `packages/adapters/src/compatibility-matrix.ts`
- `packages/adapters/src/compatibility-matrix.test.ts`
- `pnpm --filter @switchyard/cli exec node dist/bin.js runtime test`
- `pnpm test`

Result:

- The matrix is generated from shipped adapter manifests and deterministic fake/check-only harnesses.
- Fake native passes; Codex exec-json, Claude Code, and OpenCode are deterministically skipped in CI-safe no-spend mode; Generic HTTP and AgentField skip with explicit missing-config reasons.
- No required audit check triggered external provider usage or live API/model spend.

### 6. Packaging smoke and daemon hardening

Verified in:

- `packages/cli/src/release-smoke-local.ts`
- `apps/daemon/src/app.ts`
- `apps/daemon/src/main.ts`
- `apps/daemon/src/hardening.test.ts`
- `packages/protocol-rest/src/http-errors.ts`
- `packages/contracts/src/http-error.contract.test.ts`
- `packages/protocol-rest/src/http-errors.request-id.test.ts`
- `pnpm release:smoke-local`
- `pnpm test`

Result:

- The release smoke packs local tarballs, installs them into a clean temp app, rebuilds `better-sqlite3`, runs CLI help/export/doctor/fake/debug flows, launches the daemon, and imports the SDK successfully.
- Error envelopes include optional `requestId`; the daemon emits matching `x-request-id` headers.
- `/metrics` is implemented and tested with request/error counters, run-status counts, and startup-recovery counts.
- Startup recovery coverage includes interrupted active runs and idempotent subsequent startup.
- Structured recovery logs are emitted on daemon start.

### 7. Docs truth

Verified in:

- `README.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `docs/development/API.md`
- `docs/development/DEVELOPMENT.md`

Result:

- User-facing docs describe the shipped SDK, CLI, OpenAPI export/check, `/metrics`, and local no-spend workflow consistently with the Phase 10 implementation.

## Findings

No blocking findings.

## Final Verdict

- Worktree clean before and after audit checks.
- Required checks passed.
- Acceptance criteria are met on the committed Phase 10 branch state.
