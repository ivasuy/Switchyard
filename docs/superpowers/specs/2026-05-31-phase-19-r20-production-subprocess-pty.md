# Phase 19 / R20: Production Subprocess And PTY Sandbox Foundation

## Status

Active phase spec for branch `agent/phase-19-r20-production-subprocess-pty`.

## Priority Rationale

R19 made the hosted stack production-operable for the fake-safe worker boundary, but `PRODUCT.md` still marks production arbitrary subprocess/PTY execution as unshipped. This is the next dependency gap because production hosted Codex/Claude/OpenCode, generic process/PTY adapters, runtime-specific hosted approval bridges, and hosted real-tool expansion all need a hardened execution substrate first.

## Product Goal

Ship an internal, production-grade subprocess/PTY sandbox foundation that a hosted worker can run through policy, resource limits, readiness, metrics, artifact capture, and no-spend verification. This release does not expose public arbitrary execution APIs and does not enable production hosted provider runtimes yet.

## What Becomes Usable

- Operators can explicitly enable a production sandbox execution substrate for internally scheduled hosted worker jobs.
- The hosted worker can construct a real sandbox executor only when production config, policy, allowed executable rules, workspace roots, and resource limits pass fail-closed validation.
- Process and PTY sandbox jobs share typed contracts for commands, argv/env/stdin, PTY frames, cancellation, timeouts, output limits, artifact capture, transcript redaction, and terminal status mapping.
- Production readiness reports sandbox executor and policy readiness with named failure codes.
- Metrics and logs distinguish allowed, denied, timed-out, cancelled, failed, output-limited, and artifact-capture-failed sandbox jobs without leaking command text, cwd, env, stdout/stderr, object keys, or secrets.
- A deterministic no-spend production sandbox smoke command verifies the policy path, process path, PTY path, denial path, timeout/cancel path, transcript redaction, and no-public-route boundary.

## Non-Goals

- No dashboard or TUI.
- No managed SaaS/public signup or payment provider integration.
- No OAuth/OIDC/SAML/SSO/SCIM or browser login flow.
- No public `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` routes.
- No production hosted Codex/Claude/OpenCode execution in this phase.
- No Cursor, OpenClaw, Paperclip, browser automation, hosted search, GitHub, fetch, repo, or shell real-tool adapters.
- No hosted/connected-node real-tool execution.
- No hosted debate with real participant runtimes or model judging.
- No unbounded host shell access, shell interpolation, network namespace claims, container runtime claims, or OS-level isolation claims that are not enforced by code and tests in this phase.

## Required User-Visible Truth

After R20, `PRODUCT.md` must say:

- production subprocess/PTY sandbox foundation is shipped as an internal hosted worker substrate only.
- public arbitrary execution routes are still absent.
- production hosted Codex/Claude/OpenCode execution is still not shipped.
- generic process and PTY adapters are still not public product capabilities unless explicitly added by a later phase.

## Acceptance Criteria

1. Production sandbox config is fail-closed:
   - production requires an explicit sandbox backend/mode, allowed executable catalog or fake deterministic backend, workspace root allowlist, resource limits, and sandbox enablement.
   - placeholder, blank, relative, traversal, shell-name, and denylisted executable config fails before worker startup.
   - redacted summaries never include command text, cwd, env values, stdout/stderr, object keys, tokens, or credentials.

2. Sandbox executor supports process and PTY shapes behind the existing `HostedSandboxService` contract:
   - process execution is direct-spawn only, no shell interpolation.
   - PTY execution has bounded input frames, resize validation, timeout/cancel behavior, and deterministic fake/no-spend tests.
   - unsupported or unconfigured PTY backend fails with named codes instead of falling back to unsafe process execution.

3. Policy is deny-by-default:
   - arbitrary command ids remain denied unless an explicit policy maps them to an approved executable/catalog entry.
   - known dangerous command ids and shell/tool names remain denied.
   - policy decisions are auditable and redact sensitive fields.
   - public arbitrary execution routes remain absent from local and hosted OpenAPI.

4. Worker integration is internal and gated:
   - worker constructs the sandbox executor from config and reports sandbox readiness.
   - production claim readiness refuses work when sandbox config, policy, backend, or artifact content store is not usable.
   - sandbox jobs can write transcript/artifact content through the configured object store.
   - sandbox metrics remain low-cardinality.

5. Operational verification is no-spend:
   - `production:sandbox-smoke` exercises process, PTY, denied, timeout, cancel, output-limit, artifact, transcript redaction, readiness, and OpenAPI boundary checks.
   - smoke failures use named codes and redact diagnostics.
   - normal tests do not require Docker, paid APIs, browser automation, network access, or real provider CLIs.

## Verification Commands

- `pnpm --filter @switchyard/contracts test -- sandbox`
- `pnpm --filter @switchyard/core test -- hosted-sandbox-service`
- `pnpm --filter @switchyard/worker test -- production-config`
- `pnpm --filter @switchyard/worker test -- production-worker-readiness`
- `pnpm --filter @switchyard/worker test -- hosted-worker`
- `pnpm exec vitest run scripts/production-sandbox-smoke.test.ts`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm --filter @switchyard/contracts openapi:check:hosted`
- `pnpm typecheck`

## Phase Close Requirements

- Auditor must verify no public arbitrary execution routes were added.
- Auditor must verify production hosted real-runtime execution remains forbidden unless a later phase explicitly changes that product truth.
- Auditor must verify all new config/log/smoke diagnostics are redacted.
- `PRODUCT.md` and `PROJECT.md` must be updated after audit GREEN.
