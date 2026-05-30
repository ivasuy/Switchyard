# Audit Log: P13-T1 Hosted Sandbox Substrate

- Date: 2026-05-30
- Iteration: 1
- Branch: `agent/phase-13-r14-hosted-sandbox-substrate`
- Head: `89ebc85e55a3b16bd6698bfd513bf7363e3703c9`
- Verdict: `GREEN`

## Scope Audited

- Phase 13 spec: `docs/superpowers/specs/2026-05-30-phase-13-r14-hosted-sandbox-substrate.md`
- Phase 13 plan: `docs/superpowers/plans/2026-05-30-phase-13-r14-hosted-sandbox-substrate.md`
- Phase base from prior phase close: `c8f9b7c`
- Implementation commits audited:
  - `4db8f43da03545481cf43576dec2ab1321333d93`
  - `89ebc85e55a3b16bd6698bfd513bf7363e3703c9`

## Git Hygiene

- `git status --short` was clean before writing audit artifacts.
- `git diff --check` passed.
- `git diff --check c8f9b7c..HEAD` passed.
- The implementation commits named in the task are present on `HEAD`.

## Acceptance Audit

- `[GREEN]` Contracts shipped in `packages/contracts/src/sandbox.ts` and `packages/contracts/src/index.ts`, with request/policy/lifecycle/result/artifact/resource-limit/named-error exports and contract coverage in `packages/contracts/test/sandbox.contract.test.ts`.
- `[GREEN]` Core hosted sandbox boundary shipped in `packages/core/src/services/hosted-sandbox-service.ts` with deny-by-default policy, config resolution, request validation, timeout/cancel handling, transcript capture, and redaction helpers, plus coverage in `packages/core/test/hosted-sandbox-service.test.ts`.
- `[GREEN]` Shared redaction widened in `packages/core/src/services/local-policy-gate.ts` without removing the `runtimeApprovalToken` exception.
- `[GREEN]` Deterministic fake executor shipped in `packages/testkit/src/fake-hosted-sandbox-executor.ts` with scenario coverage in `packages/testkit/test/fake-hosted-sandbox-executor.test.ts`.
- `[GREEN]` Hosted server/worker wiring stays fake-only: `apps/worker/src/worker.ts` still registers only `FakeRuntimeAdapter` for actual hosted execution, while server/worker readiness and metrics expose sandbox diagnostics through `apps/server/src/readiness.ts`, `apps/server/src/metrics.ts`, `apps/server/test/hosted-server.test.ts`, and `apps/worker/test/hosted-worker.test.ts`.
- `[GREEN]` No-spend smoke command ships in `scripts/hosted-sandbox-smoke.ts` and `package.json`.
- `[GREEN]` Product and development docs describe the substrate as fake/no-spend only and keep real hosted runtime execution and production sandboxing unshipped.

## Boundary Checks

- OpenAPI path scan on `packages/contracts/openapi.local-daemon.json` found no path equal to or prefixed by `/sandbox`, `/exec`, `/pty`, or `/terminal`.
- Static forbidden-import scan found no `child_process`, `node:child_process`, `node-pty`, `@switchyard/adapters`, shell/browser/fetch/GitHub/repo execution clients, or similar real-execution hooks in:
  - `packages/core/src/services/hosted-sandbox-service.ts`
  - `packages/testkit/src/fake-hosted-sandbox-executor.ts`
  - `apps/worker/src/worker.ts`
- Hosted worker runtime registration remains `new Map<string, RuntimeAdapter>([["fake", new FakeRuntimeAdapter()]])` in `apps/worker/src/worker.ts`, so the shipped hosted runtime path is still fake-only.
- Server tests and OpenAPI contract both preserve the no-public-sandbox surface boundary.

## Checks Run

- `git diff --check` -> pass
- `pnpm --filter @switchyard/contracts test` -> pass
- `pnpm --filter @switchyard/contracts openapi:check` -> pass
- `pnpm --filter @switchyard/core test` -> pass
- `pnpm --filter @switchyard/testkit test` -> pass
- `pnpm --filter @switchyard/server test` -> pass
- `pnpm --filter @switchyard/worker test` -> pass
- `pnpm sandbox:smoke` -> pass
- `pnpm typecheck` -> pass
- OpenAPI forbidden-path scan -> pass
- Static forbidden-import scan -> pass

## Findings

- None.

## Deferred Concerns

- None.
