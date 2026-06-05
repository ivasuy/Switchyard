# Audit Log: P12-T1 S3/R2 Object Store Client Wiring

- Date: 2026-05-31
- Iteration: 1
- Branch: `agent/phase-12-r13-s3-r2-object-store-client`
- Head: `b7cbca73b0e98c8babb81cba3dbc505e5391614a`
- Verdict: `NEEDS_REVISION`

## Scope Audited

- Phase 12 spec: `docs/superpowers/specs/2026-05-30-phase-12-r13-s3-r2-object-store-client.md`
- Phase 12 plan: `docs/superpowers/plans/2026-05-30-phase-12-r13-s3-r2-object-store-client.md`
- Phase base from prior phase close: `6a09d4e`
- Implementation commits audited:
  - `d143f071fc2d14e6bdb632ea8a55c8fbbef200d0`
  - `b7cbca73b0e98c8babb81cba3dbc505e5391614a`

## Git Hygiene

- `git status --short` was clean before writing audit artifacts.
- `git diff --check` passed before writing audit artifacts.
- The implementation commits named in the task are present on `HEAD`.

## Redflags

### 1. Local/test S3 endpoint validation is too permissive and accepts arbitrary HTTP hosts

- Acceptance requires local/test HTTP endpoints to be limited to `http://127.0.0.1`, `http://localhost`, and Docker-network HTTP endpoints only.
- `packages/storage/src/object-store-config.ts:288-307` only rejects non-HTTP(S), userinfo, query strings, and non-HTTPS in staging/production. It does not restrict which `http://` hosts are allowed in local/test.
- Direct verification on this worktree head:
  - `http://evil.example.com => OK http://evil.example.com`
  - `http://minio => OK http://minio`
  - `http://127.0.0.1:9000 => OK http://127.0.0.1:9000`
- That means the parser currently accepts arbitrary cleartext remote endpoints in local/test instead of the explicit allowlist described by the spec/plan.
- Coverage gap: `packages/storage/test/object-store-config.test.ts:80-133` checks staging HTTP rejection and a few malformed endpoint cases, but it does not assert that non-local HTTP hosts are rejected in local/test.

Required change:
- Tighten `parseEndpoint()` so local/test accepts only the explicit HTTP host classes allowed by the contract.
- Add regression coverage that rejects representative invalid local/test HTTP hosts such as `http://evil.example.com` while preserving allowed cases like `http://127.0.0.1:9000`, `http://localhost:9000`, and the intended Docker-network form.

### 2. `GetObject` body streaming is not bounded by the configured total timeout

- Acceptance requires Put/Get/Delete/probe operations to obey total operation timeout semantics, including the full `GetObject` read path, not just the SDK `send()` call.
- `packages/storage/src/s3-compatible-object-client.ts:61-85` applies `withTimeout()` only around `client.send(...)`. The subsequent `toBuffer(response.Body)` call at `:77` runs outside that timeout window.
- `packages/storage/src/s3-compatible-object-client.ts:104-155` can await indefinitely on a hanging Node/Web stream body, which leaves `getObject()` unresolved even when `requestTimeoutMs` is very small.
- Direct verification on this worktree head with `requestTimeoutMs: 25` and a `getReader().read()` that never resolves returned:
  - `pending:151`
- That violates the plan/spec requirement that retries and body conversion remain bounded by `SWITCHYARD_OBJECT_STORE_REQUEST_TIMEOUT_MS`, and it undermines the readiness promptness contract when probes depend on `getObject()`.
- Coverage gap: `packages/storage/test/s3-compatible-object-client.test.ts:137-216` only proves timeout mapping when `send()` itself hangs. It does not cover a hung body stream after `send()` succeeds.

Required change:
- Enforce the timeout across the full `getObject()` lifecycle, including body conversion/stream draining, and ensure the hanging body path rejects with `object_store_timeout`.
- Add a regression test for a hanging stream body and, if readiness uses the same path, a readiness-level regression proving prompt failure inside the configured timeout budget.

## Checks Run

- `git status --short` -> clean before audit artifacts
- `git diff --check` -> pass
- `pnpm --filter @switchyard/storage test` -> pass
- `pnpm --filter @switchyard/core test` -> pass
- `pnpm --filter @switchyard/protocol-rest test` -> pass
- `pnpm --filter @switchyard/contracts test` -> pass
- `pnpm --filter @switchyard/server test` -> pass
- `pnpm --filter @switchyard/worker test` -> pass
- `pnpm typecheck` -> pass
- `pnpm release:smoke-local` -> pass
- direct endpoint parser probe -> fail (`http://evil.example.com` and `http://minio` accepted)
- direct `getObject()` hanging-body timeout probe -> fail (`pending:151` with `requestTimeoutMs: 25`)

## Deferred Concerns

- None.

## 2026-05-30T20:39:46Z — Pass 2 (re-audit)

**Verdict:** GREEN

**Findings:**
- None. The two prior redflags are resolved on `5bddac656019eaa0b5ad819bbe9059f7cb2aa25e`.

**Verification:**
- `[GREEN] packages/storage/src/object-store-config.ts:288-319` now rejects non-loopback local/test HTTP endpoints and keeps loopback-only HTTP support.
  - Direct probe: `http://evil.example.com` -> `config_invalid:SWITCHYARD_OBJECT_STORE_ENDPOINT`
  - Direct probe: `http://minio:9000` -> `config_invalid:SWITCHYARD_OBJECT_STORE_ENDPOINT`
  - Direct probe: `http://localhost:9000`, `http://127.0.0.1:9000`, `http://[::1]:9000` -> accepted
  - Regression coverage: `packages/storage/test/object-store-config.test.ts:80-167`
- `[GREEN] packages/storage/src/s3-compatible-object-client.ts:61-189` now keeps the timeout guard around the full `getObject()` lifecycle, including body drain/conversion.
  - Direct probe with a hanging web-style reader and `requestTimeoutMs: 25` -> `object_store_timeout` after 27ms
  - Direct probe with a hanging Node `Readable` and `requestTimeoutMs: 25` -> `object_store_timeout` after 28ms
  - Regression coverage: `packages/storage/test/s3-compatible-object-client.test.ts:137-253`
- Targeted storage rerun: `pnpm --filter @switchyard/storage test` -> pass
- Full acceptance matrix rerun on `HEAD` -> all pass

**Notes:**
- AWS SDK dependency scope remains limited to `packages/storage` (`packages/storage/package.json:24-32`) and is guarded by `packages/storage/test/storage-package.test.ts:31-85`.
- No ambient/default AWS credential-provider imports or env/profile discovery helpers were found in the audited codebase; the S3 client still uses explicit literal credentials only (`packages/storage/src/s3-compatible-object-client.ts:33-45`).
- Hosted worker remains fake-only via the `FakeRuntimeAdapter`-only map in `apps/worker/src/worker.ts:55-76`, with denial coverage for non-fake hosted runtime execution in `apps/worker/test/hosted-worker.test.ts:49-100`.
- Product/docs truth remains aligned with the shipped R13 boundary in `PRODUCT.md:1038-1054`, `README.md:303-307`, and `docs/development/DEVELOPMENT.md:560-563`.
