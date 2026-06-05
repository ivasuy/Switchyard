# Phase 16 / R17 Audit Log

**Date:** 2026-05-31
**Run:** `post-r11-remaining-20260530`
**Branch:** `agent/phase-16-r17-production-tools-and-adapter-expansion`
**Latest Verdict:** `GREEN`

## Pass 1

**Verdict:** `NEEDS_REVISION`

### Checks Run

- `git diff --check` against `a1bafa6..6100d32` — passed
- `pnpm --filter @switchyard/contracts test` — passed
- `pnpm --filter @switchyard/contracts openapi:check` — passed
- `pnpm --filter @switchyard/core test` — passed
- `pnpm --filter @switchyard/adapters test` — passed
- `pnpm --filter @switchyard/daemon test` — passed
- `pnpm --filter @switchyard/protocol-rest test` — passed
- `pnpm --filter @switchyard/server test` — passed
- `pnpm --filter @switchyard/worker test` — passed
- `pnpm --filter @switchyard/node test` — passed
- `pnpm --filter @switchyard/sdk build` — passed
- `pnpm typecheck` — passed

### Findings

#### 1. REST acceptance matrix for real tools is missing

`packages/protocol-rest/test/middleware-routes.test.ts:258-314` only exercised one real-tool denial path for `shell` plus the legacy `fake_echo` approval flow. The Phase 16 plan requires a per-tool REST matrix for `fetch`, `web_search`, `github`, `repo`, and `shell`, covering happy, nil/missing, empty, policy denied, approval rejected, approval expired, adapter timeout/failure, oversize, and redaction cases.

#### 2. Daemon smoke never proves the five configured real tools

`apps/daemon/test/smoke.test.ts:218-335` still ran the legacy R7 middleware smoke path. Inside that smoke it only exercised `fake_echo` plus a denied `shell` request; there was no configured no-spend approval/complete path for `fetch`, `web_search`, `github`, `repo`, or `shell`.

#### 3. Adapter test coverage is far short of the required R17 matrix

`packages/adapters/test/real-tool-adapters.test.ts:17-275` covered only a subset of the required fake/no-spend adapter matrix, so the adapter task was not complete.

## Pass 2 Re-Audit

**Verdict:** `GREEN`
**Commit Reviewed:** `4594420a5143b570822c61183d338cf2abdf8946`

### Checks Run

- `git status --short` — clean before audit-log updates
- `git diff --check` — passed
- `pnpm --filter @switchyard/contracts test` — passed
- `pnpm --filter @switchyard/contracts openapi:check` — passed
- `pnpm --filter @switchyard/core test` — passed
- `pnpm --filter @switchyard/adapters test` — passed
- `pnpm --filter @switchyard/daemon test` — passed
- `pnpm --filter @switchyard/protocol-rest test` — passed
- `pnpm --filter @switchyard/server test` — passed
- `pnpm --filter @switchyard/worker test` — passed
- `pnpm --filter @switchyard/node test` — passed
- `pnpm --filter @switchyard/sdk build` — passed
- `pnpm typecheck` — passed

### Resolution Verification

#### 1. REST acceptance matrix resolved

`packages/protocol-rest/test/middleware-routes.test.ts` now includes a committed end-to-end fake-adapter matrix for `fetch`, `web_search`, `github`, `repo`, and `shell`, covering:

- happy approval-to-complete flows
- missing and empty input rejection
- policy-denied cases
- approval reject and approval expiry terminalization
- timeout/failure and oversize error mapping
- redaction checks on stored/listed invocation payloads

This closes the prior acceptance gap.

#### 2. Daemon no-spend smoke resolved

`apps/daemon/test/smoke.test.ts` now exercises configured no-spend approval/completion flows for all five shipped real tools with fake injected fetch/search/GitHub/process dependencies. The smoke proves the local-daemon route shape and approval types without spending or opening new surfaces.

This closes the prior daemon-smoke gap.

#### 3. Adapter acceptance matrix resolved

`packages/adapters/test/real-tool-adapters.test.ts` now materially expands the committed no-spend matrix, including:

- fetch `HEAD`, allowlisted redirect follow, redirect denial, 404/500 mapping, content-type denial, and response-byte cap
- web search provider failure, malformed payload, and oversize payload
- GitHub happy path, not-found/403/timeout mapping, and response-byte cap
- local-process cancellation, output flood, spawn error, and literal shell-argument handling

This closes the prior adapter-coverage gap.

### Boundary Spot Checks Preserved

- Local-daemon-only product truth and docs remain intact.
- OpenAPI still preserves `GET /memory/search` / `searchMemory` and keeps `/tools/invocations` as the only public tool execution route.
- Hosted server/worker and connected-node defaults still do not expose or advertise real-tool execution.
- Previously green core guards remain covered by unchanged tests: real tools disabled by default, deny-by-default/approval-by-default policy, immutable `executionPlanHash`, direct and approval-resume `maxConcurrentRealTools`, and direct-input `maxInputBytes`.
