# Phase 24: R25 Hosted Wrapper Runtime Bridges - Implementation Plan

**Spec:** docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md
**Branch:** agent/phase-24-r25-hosted-wrapper-bridges
**Base/spec commit:** 2502825 (`spec: add phase 24 hosted wrapper bridges`)
**Complexity:** L

## Goal

Ship conditional hosted input and approval bridges for `agentfield.async_rest` and `generic_http.async_rest`, and admit those modes as opt-in hosted debate participants only when wrapper, bridge, worker, provider, spend, ownership, quota, audit, preflight, and readiness gates pass.

## Scope Challenge

1. Existing code already solves the durable bridge spine. R25 must extend `HostedRuntimeBridgeService`, the Postgres bridge command and payload stores, `RuntimeRunnerService` approval creation, hosted run admission, worker bridge claim/apply, hosted runtime catalog, provider activation policy, and production preflight/canary. No second bridge table, queue, route family, or worker loop is needed.
2. Minimum shippable change is a closed widening from two bridge modes to four bridge modes, wrapper adapter `send()` and approval event support, hosted catalog/policy/readiness activation, server/worker admission, debate matrix admission, no-spend ops checks, and docs truth. Browser, repo, generic process, generic PTY, public model judge routes, dashboard/TUI, managed SaaS, and hosted `codex.interactive` remain out of scope.
3. Complexity smell is real: the phase necessarily crosses contracts, core, adapters, server, worker, debate, ops scripts, and docs. The plan splits this into ten disjoint slices so no implementer owns both wrapper adapters or both server and worker paths. No new durable service is introduced.
4. Built-in and existing primitives are enough: Zod schemas, Fastify route registration, existing route inventory/OpenAPI generation, built-in `URL`, existing `fetch` plus adapter request helpers, existing transcript recorder, existing bridge stores, existing control-plane ownership/quota/audit hooks, and existing readiness/preflight/canary structures.
5. Distribution impact stays in existing packages and scripts. No new package, binary, container, dashboard, TUI, route family, public arbitrary execution API, public model judge route, managed auth surface, or billing artifact ships.

## Architecture

R25 keeps the public API boring and narrow. The only user-facing bridge surfaces remain `POST /runs/:id/input` and the existing approval list/get/approve/reject endpoints. The server remains the admission layer for hosted input and approval resolution: auth, ownership, entitlement, quota reservation, idempotency, payload hashing, redacted command metadata, audit, and durable bridge command/payload persistence all happen before the worker can contact an upstream wrapper. Unsupported or unready paths fail closed with named codes before provider dispatch.

The worker remains the only component that owns wrapper sessions. The worker constructs `GenericHttpAsyncRestAdapter` and `AgentFieldAsyncRestAdapter` only when runtime mode, allowlist, provider policy, wrapper config, and bridge capability checks pass. The existing bridge claim loop loads a durable command payload, revalidates worker/session ownership, recomputes the payload hash, calls `RuntimeRunnerService.sendInput()`, and the adapter maps the dispatch payload to either wrapper input or wrapper approval-resolution endpoints. Wrapper approval requests are normalized to `approval.requested` events so the existing runtime runner creates owned approval records.

Hosted debate uses the same child-run path R24 shipped. R25 only widens `DebateRuntimeMatrix` to admit `agentfield.async_rest` and `generic_http.async_rest` when the request has `realRuntimeOptIn: true`, `placement: "hosted"`, and runtime/provider/adapterType fields matching the hosted catalog. Debate readiness treats wrapper participants as bridge-dependent because R25 only considers them debate-safe when input and approval semantics can be represented through Switchyard. `POST /debates?wait=1` remains fake-only and rejects wrapper participants before child-run creation.

```
POST /runs/:id/input
  -> hosted auth and run ownership
  -> bridge mode and wrapper capability admission
  -> quota reserve, audit, command row, payload row
  -> worker claim loop
  -> session owner/runtime hash revalidation
  -> adapter.send(session, payload)
  -> configured wrapper endpoint only
  -> complete/fail command, finalize quota, delete payload

wrapper approval request
  -> adapter emits approval.requested
  -> RuntimeRunnerService creates owned approval
  -> POST /approvals/:id/approve or /reject
  -> durable approval_resolution bridge command
  -> worker applies configured wrapper resolution endpoint
```

## File Structure

- `packages/contracts/src/hosted-runtime-bridge.ts` - closed bridge mode/reason/readiness contract for Claude, OpenCode, AgentField, and Generic HTTP.
- `packages/contracts/src/provider-runtime-policy.ts` - closed provider/wrapper activation policy vocabulary for known hosted real modes without command-style overrides for wrappers.
- `packages/core/src/services/hosted-runtime-catalog.ts` - hosted runtime catalog entries and allowlist behavior for conditional wrapper modes.
- `packages/adapters/src/generic-http/*` - Generic HTTP wrapper capability discovery, input apply, approval event mapping, approval resolution apply, and redacted transcripts.
- `packages/adapters/src/agentfield/*` - AgentField discovery-based bridge capability, input apply, polled approval mapping, approval resolution apply, and redacted transcripts.
- `packages/testkit/src/fake-http-runtime-server.ts` and `packages/testkit/src/fake-agentfield-server.ts` - no-spend wrapper bridge fake servers for adapter, worker, preflight, and canary tests.
- `packages/core/src/services/hosted-runtime-bridge-service.ts` and `runtime-runner-service.ts` - wrapper admission validation, dynamic capability hooks, session state, and approval creation semantics.
- `packages/protocol-rest` plus `apps/server` - existing route admission, hosted auth/ownership/quota/audit/readiness wiring, and route-boundary tests.
- `apps/worker` - wrapper config loading, hosted adapter construction, bridge readiness, claim/apply, and debate worker gates.
- `packages/core/src/services/debate-*` and `packages/protocol-rest/src/debate-routes.ts` - hosted debate matrix and wrapper participant admission.
- `scripts/production-preflight.ts`, `scripts/production-canary.ts`, and tests - no-spend default ops checks plus explicit live wrapper spend gates.
- Product and adapter docs - shipped/unshipped truth after implementation.

## Existing Context

The implementation must read the spec and the actual code seams below before editing. The excerpts are anchors, not replacement for reading the files.

`packages/contracts/src/hosted-runtime-bridge.ts`
```ts
export const hostedRuntimeBridgeSupportedModeSchema = z.enum(["claude_code.sdk", "opencode.acp"]);
export function isHostedRuntimeBridgeSupportedMode(runtimeMode: string, operation?: z.infer<typeof hostedRuntimeBridgeOperationSchema>): boolean
```

`packages/core/src/services/hosted-runtime-catalog.ts`
```ts
export type HostedRuntimeModeSlug = "fake.deterministic" | "codex.exec_json" | "claude_code.sdk" | "opencode.acp";
```

`packages/adapters/src/generic-http/generic-http-adapter.ts`
```ts
async send(_session: Record<string, unknown>, _input: Record<string, unknown>): Promise<void> {
  throw new AdapterProtocolError("Generic HTTP async REST does not support input after start", {
    reasonCode: "generic_http_input_unsupported"
  });
}
```

`packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts`
```ts
async send(_session: Record<string, unknown>, _input: Record<string, unknown>): Promise<void> {
  throw new AdapterProtocolError("agentfield.async_rest does not support POST /runs/:id/input in R6.", {
    reasonCode: "agentfield_input_unsupported"
  });
}
```

`packages/core/src/services/hosted-runtime-bridge-service.ts`
```ts
function reasonForUnsupportedMode(runtimeMode: string, operation: HostedRuntimeBridgeCommand["operation"]): string {
  if (runtimeMode === "agentfield.async_rest") return "agentfield_bridge_unshipped";
  if (runtimeMode === "generic_http.async_rest") return "generic_http_bridge_unshipped";
}
```

`packages/core/src/services/debate-runtime-matrix.ts`
```ts
const ALLOWED_DEBATE_RUNTIME_MODES = new Set<HostedRuntimeModeSlug>([
  "fake.deterministic",
  "codex.exec_json",
  "claude_code.sdk",
  "opencode.acp"
]);
```

`packages/storage/src/postgres/database.ts`
```sql
CREATE TABLE IF NOT EXISTS hosted_runtime_bridge_commands (...);
CREATE TABLE IF NOT EXISTS hosted_runtime_bridge_payloads (...);
```

`PRODUCT.md`
```md
AgentField and Generic HTTP hosted bridges remain unshipped pending durable callback contracts.
AgentField and Generic HTTP hosted debate bridges are not shipped.
```

## Task Graph

### Task P24-T1-contracts-openapi-error-boundary

```json
{
  "id": "P24-T1-contracts-openapi-error-boundary",
  "title": "Widen hosted bridge contracts and public route boundary",
  "files": [
    "packages/contracts/src/hosted-runtime-bridge.ts",
    "packages/contracts/src/http-error.ts",
    "packages/contracts/src/openapi.ts",
    "packages/contracts/src/endpoint-inventory.ts",
    "packages/contracts/src/openapi.contract.test.ts",
    "packages/contracts/src/http-error.contract.test.ts",
    "packages/contracts/src/endpoint-inventory.drift.test.ts",
    "packages/contracts/openapi.local-daemon.json",
    "packages/contracts/openapi.hosted-server.json",
    "packages/protocol-rest/src/http-errors.ts"
  ],
  "dependencies": [],
  "context_files": [
    "docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md",
    "packages/contracts/src/hosted-runtime-bridge.ts",
    "packages/contracts/src/http-error.ts",
    "packages/contracts/src/openapi.ts",
    "packages/contracts/src/endpoint-inventory.ts",
    "packages/protocol-rest/src/http-errors.ts",
    "packages/contracts/src/openapi.contract.test.ts"
  ],
  "instructions": "Read the spec sections Contracts, Product/API Boundary, Failure Codes, and Test Strategy. Extend the closed hosted bridge supported-mode enum to include agentfield.async_rest and generic_http.async_rest while keeping operation enum exactly input and approval_resolution. Add wrapper-specific bridge reason codes from the spec to hostedRuntimeBridgeReasonCodeSchema and httpErrorCodeSchema, including runtime_input_empty, runtime_input_too_large, agentfield_bridge_capability_missing, agentfield_bridge_config_missing, agentfield_input_failed, agentfield_invalid_input_response, agentfield_input_response_too_large, agentfield_approval_request_invalid, agentfield_approval_resolution_failed, agentfield_invalid_approval_response, agentfield_approval_response_too_large, generic_http_bridge_capability_missing, generic_http_bridge_config_missing, generic_http_input_failed, generic_http_invalid_input_response, generic_http_input_response_too_large, generic_http_approval_request_invalid, generic_http_approval_resolution_failed, generic_http_invalid_approval_response, generic_http_approval_response_too_large, and provider_bridge_live_canary_spend_unconfirmed. Map 400 only for invalid_input and provider_bridge_live_canary_spend_unconfirmed, 429 for bridge quota, 502 for malformed or oversized wrapper responses, 503 for wrapper config/upstream/dependency failures, and 409 for unsupported operation, empty/too-large input, capability missing in admission, approval invalid, expiry, and stale bridge safety failures. Extend readiness check names with wrapper_config and wrapper_bridge_capability. Keep route inventory and hosted OpenAPI using only existing /runs/:id/input, /approvals list/get/approve/reject, and /debates routes; add negative tests for forbidden public route families.",
  "acceptance": [
    "hostedRuntimeBridgeSupportedModeSchema includes exactly claude_code.sdk, opencode.acp, agentfield.async_rest, and generic_http.async_rest.",
    "isHostedRuntimeBridgeSupportedMode returns true for wrapper input and approval_resolution as statically admissible known modes, and false for codex.exec_json, codex.interactive, browser, repo, process, PTY, shell, Cursor, OpenClaw, Paperclip, and unknown slugs.",
    "All R25 bridge failure codes parse through contract and REST HTTP error mapping with spec-aligned status classes.",
    "Hosted bridge readiness schema includes wrapper_config and wrapper_bridge_capability without removing existing R23 check names.",
    "Hosted OpenAPI includes no new public runtime-bridge, input, approval, session, exec, shell, process, command, PTY, terminal, sandbox, browser, repo, judge, model-judge, judging, dashboard, or TUI route.",
    "Hosted OpenAPI continues to expose approval list/get/approve/reject and proves POST /approvals is absent."
  ],
  "checks": [
    "pnpm --filter @switchyard/contracts test",
    "pnpm --filter @switchyard/contracts openapi:check",
    "pnpm --filter @switchyard/contracts openapi:check:hosted",
    "pnpm --filter @switchyard/protocol-rest typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "hostedRuntimeBridgeSupportedModeSchema",
      "failure": "unknown runtime slug is accepted by mistake",
      "exception": "ZodError in contract tests",
      "rescue": "Keep z.enum closed to the four exact supported bridge modes.",
      "user_sees": "409 adapter_protocol_failed with hosted_runtime_bridge_operation_unsupported for unknown modes"
    },
    {
      "codepath": "protocol REST HTTP error mapping",
      "failure": "new wrapper reason code falls through to internal_error or wrong HTTP status",
      "exception": "http-error contract test failure",
      "rescue": "Add the code to contracts and STATUS_BY_CODE with spec-aligned 400, 409, 429, 502, or 503 status.",
      "user_sees": "Named error envelope with reasonCode instead of generic 500"
    },
    {
      "codepath": "OpenAPI and endpoint inventory",
      "failure": "forbidden public route is added or POST /approvals appears",
      "exception": "OpenAPI or endpoint inventory drift test failure",
      "rescue": "Remove the route from public registration/inventory and keep bridge behavior behind existing run/approval/debate routes.",
      "user_sees": "Stable public API boundary with no arbitrary execution or public judge surface"
    }
  ],
  "observability": {
    "logs": [
      "contract test failure names missing R25 reason code",
      "OpenAPI drift test reports offending forbidden route path"
    ],
    "success_metric": "contracts and OpenAPI checks pass with the exact R25 bridge mode set and no forbidden public routes",
    "failure_metric": "any wrapper bridge code maps to internal_error or any forbidden public route appears"
  },
  "test_cases": [
    {
      "name": "known wrapper modes are bridge-supported",
      "lens": "happy",
      "given": "isHostedRuntimeBridgeSupportedMode('agentfield.async_rest','input') and generic_http approval_resolution",
      "expect": "returns true for both wrapper modes and operations"
    },
    {
      "name": "codex and unsafe modes remain unsupported",
      "lens": "error_path",
      "given": "codex.exec_json, codex.interactive, browser.session, repo.checkout, process.exec, terminal, pty, cursor",
      "expect": "returns false and maps through named unsupported or unshipped codes"
    },
    {
      "name": "R25 wrapper failure codes have statuses",
      "lens": "integration",
      "given": "the R25 failure code table from the spec",
      "expect": "httpErrorCodeSchema parses every code and protocolStatusFor returns non-500 status for expected client/provider/dependency failures"
    },
    {
      "name": "readiness schema accepts wrapper checks",
      "lens": "happy_shadow_nil",
      "given": "hostedRuntimeBridgeReadinessReportSchema with wrapper_config and wrapper_bridge_capability checks",
      "expect": "schema parses without dropping existing command_store, command_outbox, worker_claim, adapter_capability, session_reconciliation, approval_sender"
    },
    {
      "name": "hosted route boundary remains closed",
      "lens": "integration",
      "given": "generated hosted OpenAPI",
      "expect": "existing approval routes and /runs/{id}/input exist, POST /approvals is absent, and all forbidden route substrings are absent"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "R25 hosted bridge supported modes",
        "kind": "constant",
        "signature": "hostedRuntimeBridgeSupportedModeSchema = z.enum(['claude_code.sdk','opencode.acp','agentfield.async_rest','generic_http.async_rest'])"
      },
      {
        "name": "R25 bridge HTTP error vocabulary",
        "kind": "constant",
        "signature": "httpErrorCodeSchema and STATUS_BY_CODE include all wrapper bridge reason codes from the spec"
      },
      {
        "name": "R25 bridge readiness names",
        "kind": "constant",
        "signature": "hostedRuntimeBridgeReadinessCheckNameSchema includes wrapper_config and wrapper_bridge_capability"
      }
    ],
    "imports_from_other_tasks": [],
    "file_paths_consumed_by_other_tasks": [
      "packages/contracts/src/hosted-runtime-bridge.ts",
      "packages/contracts/src/http-error.ts",
      "packages/protocol-rest/src/http-errors.ts"
    ]
  }
}
```

### Task P24-T2-catalog-provider-policy

```json
{
  "id": "P24-T2-catalog-provider-policy",
  "title": "Add conditional hosted wrapper catalog and provider policy gates",
  "files": [
    "packages/contracts/src/provider-runtime-policy.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts",
    "packages/core/src/services/provider-runtime-policy.ts",
    "packages/core/src/services/production-config-guards.ts",
    "packages/core/test/hosted-runtime-catalog.test.ts",
    "packages/core/test/provider-runtime-policy.test.ts",
    "packages/core/test/production-config-guards.test.ts"
  ],
  "dependencies": [
    "P24-T1-contracts-openapi-error-boundary"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md",
    "packages/contracts/src/provider-runtime-policy.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts",
    "packages/core/src/services/provider-runtime-policy.ts",
    "packages/core/test/hosted-runtime-catalog.test.ts",
    "packages/core/test/provider-runtime-policy.test.ts"
  ],
  "instructions": "Read the Runtime Matrix and Readiness sections. Extend the hosted catalog closed type to include agentfield.async_rest and generic_http.async_rest. Add catalog entries with runtime/provider/adapterType/kind exactly from the spec, hostedSupport conditional, requiresRealRuntimeGate true, productionAllowed false, adapterType http, kind async_rest, auth.api_key, event.streaming, event.normalized, run.start, run.input, run.timeout, approval.bridge, artifact.transcript, and no public hosted active-cancel bridge claim. Extend providerRuntimeModeSchema and provider activation policy to include wrapper modes as known real hosted modes. Wrapper policy entries must use operator-configured baseUrl/auth/target env references and spend controls, not executablePath, fixedArgs, cwdPrefixes, argv, shell, command, process factory, PTY, env override, or per-run URL fields. Keep production activation fail-closed unless the mode is allowlisted, hosted real runtime execution is enabled, policy is valid, required wrapper env references resolve, spend controls are valid, and wrapper production activation is valid. Keep productionAllowed false until activation passes.",
  "acceptance": [
    "HOSTED_RUNTIME_CATALOG contains exactly fake.deterministic, codex.exec_json, claude_code.sdk, opencode.acp, agentfield.async_rest, and generic_http.async_rest.",
    "Wrapper catalog entries advertise conditional hosted support and bridge capabilities without claiming public active cancel, browser, repo, process, PTY, terminal, dashboard, TUI, or model judge support.",
    "validateHostedRuntimeAllowlist accepts wrapper modes only when hosted real runtime execution is enabled and production activation passes where required.",
    "Provider/wrapper policy rejects unknown modes, missing wrapper policy, missing required env references, invalid spend controls, command-style wrapper policy fields, and per-run endpoint override fields.",
    "Provider activation redacted summaries include wrapper mode status and reason codes without base URLs containing credentials, tokens, API keys, command strings, argv, cwd, or env values.",
    "Existing Codex, Claude, OpenCode, and fake catalog/policy tests keep passing."
  ],
  "checks": [
    "pnpm --filter @switchyard/contracts test -- provider-runtime-policy",
    "pnpm --filter @switchyard/core test -- hosted-runtime-catalog provider-runtime-policy production-config-guards",
    "pnpm --filter @switchyard/core typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "validateHostedRuntimeAllowlist",
      "failure": "wrapper mode allowlisted while hosted real runtime execution is disabled",
      "exception": "HostedRuntimeConfigValidation { ok:false, code:'hosted_real_runtime_disabled' }",
      "rescue": "Reject before hosted run admission or worker construction.",
      "user_sees": "503 or startup config failure with hosted_real_runtime_disabled"
    },
    {
      "codepath": "providerRuntimePolicySchema",
      "failure": "wrapper policy includes executablePath, fixedArgs, argv, cwdPrefixes, allowUserArgs true, shell, pty, command, processFactory, or per-run endpoint fields",
      "exception": "ZodError classified as provider_command_policy_invalid",
      "rescue": "Reject the policy as invalid; do not silently ignore unsafe fields.",
      "user_sees": "Fail-closed provider_command_policy_invalid before provider dispatch"
    },
    {
      "codepath": "validateProviderRuntimeActivation",
      "failure": "required wrapper env reference is missing or blank",
      "exception": "ProviderRuntimeActivationResult valid=false with provider_credentials_missing or wrapper config reason",
      "rescue": "Mark that mode not ready and fail production startup/preflight when allowlisted.",
      "user_sees": "Wrapper runtime not configured, no upstream call is made"
    },
    {
      "codepath": "hosted catalog entry",
      "failure": "wrapper catalog accidentally advertises run.cancel as hosted active cancel or hosted browser/repo/process/PTY capability",
      "exception": "catalog test failure",
      "rescue": "Remove the capability or add limitation no_hosted_cancel_bridge; keep only spec-listed wrapper capabilities.",
      "user_sees": "Registry reports truthful conditional bridge support only"
    }
  ],
  "observability": {
    "logs": [
      "provider activation diagnostics include modeStatuses for wrapper modes with reason codes only",
      "catalog tests report exact unexpected capability or missing limitation"
    ],
    "success_metric": "allowlist and provider activation distinguish fake-only, wrapper-disabled, wrapper-config-missing, and wrapper-ready cases",
    "failure_metric": "wrapper allowlist passes without explicit hosted real runtime and valid policy, or redacted summary leaks secrets"
  },
  "test_cases": [
    {
      "name": "catalog contains wrapper modes",
      "lens": "happy",
      "given": "Object.keys(HOSTED_RUNTIME_CATALOG).sort()",
      "expect": "six exact modes including agentfield.async_rest and generic_http.async_rest"
    },
    {
      "name": "wrapper mode requires real runtime gate",
      "lens": "error_path",
      "given": "allowlist ['fake.deterministic','agentfield.async_rest'] with hostedRealRuntimeExecution disabled",
      "expect": "hosted_real_runtime_disabled before admission"
    },
    {
      "name": "wrapper production requires activation",
      "lens": "error_path",
      "given": "production allowlist generic_http.async_rest with no provider policy",
      "expect": "provider_runtime_policy_missing"
    },
    {
      "name": "valid wrapper policy activates without command resolution",
      "lens": "happy",
      "given": "policy entry for generic_http.async_rest with enabled true, required env references, endpoint env var names, and spendControls",
      "expect": "activation valid and enabledRealModes includes generic_http.async_rest; no executablePath required"
    },
    {
      "name": "unsafe wrapper policy fields are rejected",
      "lens": "error_path",
      "given": "agentfield.async_rest policy containing executablePath or perRunBaseUrl",
      "expect": "provider_command_policy_invalid or provider_runtime_policy_malformed"
    },
    {
      "name": "redacted summary has no secrets",
      "lens": "edge_redaction",
      "given": "env includes wrapper API key, token, and credential-bearing URL",
      "expect": "JSON.stringify(redactedSummary) excludes raw secret values and credential-bearing URL"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "HostedRuntimeModeSlug",
        "kind": "constant",
        "signature": "'fake.deterministic' | 'codex.exec_json' | 'claude_code.sdk' | 'opencode.acp' | 'agentfield.async_rest' | 'generic_http.async_rest'"
      },
      {
        "name": "ProviderRuntimeMode",
        "kind": "constant",
        "signature": "'codex.exec_json' | 'claude_code.sdk' | 'opencode.acp' | 'agentfield.async_rest' | 'generic_http.async_rest'"
      },
      {
        "name": "isHostedRuntimeProductionAllowed",
        "kind": "function",
        "signature": "isHostedRuntimeProductionAllowed(slug: HostedRuntimeModeSlug, activation?: ProviderRuntimeActivationResult) => boolean"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P24-T1-contracts-openapi-error-boundary",
        "name": "R25 bridge HTTP error vocabulary",
        "signature": "httpErrorCodeSchema and STATUS_BY_CODE include all wrapper bridge reason codes from the spec"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/services/hosted-runtime-catalog.ts",
      "packages/contracts/src/provider-runtime-policy.ts",
      "packages/core/src/services/provider-runtime-policy.ts"
    ]
  }
}
```

### Task P24-T3-generic-http-wrapper-bridge-adapter

```json
{
  "id": "P24-T3-generic-http-wrapper-bridge-adapter",
  "title": "Implement Generic HTTP wrapper bridge adapter support",
  "files": [
    "packages/adapters/src/generic-http/generic-http-adapter.ts",
    "packages/adapters/src/generic-http/types.ts",
    "packages/adapters/test/generic-http-adapter.test.ts",
    "packages/testkit/src/fake-http-runtime-server.ts",
    "packages/testkit/test/fake-http-runtime-server.test.ts"
  ],
  "dependencies": [
    "P24-T1-contracts-openapi-error-boundary",
    "P24-T2-catalog-provider-policy"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md",
    "packages/adapters/src/generic-http/generic-http-adapter.ts",
    "packages/adapters/src/generic-http/http-client.ts",
    "packages/adapters/src/generic-http/types.ts",
    "packages/adapters/test/generic-http-adapter.test.ts",
    "packages/testkit/src/fake-http-runtime-server.ts"
  ],
  "instructions": "Read the Generic HTTP Wrapper Bridge Contract. Extend check() so /health capability discovery reads capabilities and reports bridge readiness only when input, approval_request, and approval_resolution are present. Keep ordinary run.start runnable when bridge capabilities are missing, but expose reasonCode generic_http_bridge_capability_missing for bridge readiness. Update manifest placement.hosted to conditional and capabilities/limitations to match the hosted catalog. Implement send(session, input) so type input calls POST /v1/runs/:externalRunId/input with switchyardRunId, bridgeCommandId, idempotencyKey, type, and text; type approval_resolution calls POST /v1/runs/:externalRunId/approvals/:runtimeApprovalToken/resolve with switchyardRunId, bridgeCommandId, idempotencyKey, decision, message, and answers. Reject missing/empty/oversized text before upstream dispatch with runtime_input_empty or runtime_input_too_large. Map approval.requested wrapper events with runtimeApprovalToken, approvalType, message, expiresAt, and optional answers to Switchyard approval.requested events. runtime.status waiting_for_input, running, and resumed must be normalized without terminalizing. Unknown wrapper events still become runtime.status unknown_event. Extend the fake HTTP server with bridge-ready and bridge-missing scenarios, input/approval endpoints, malformed responses, oversized responses, timeout/request failure hooks, duplicate approval events, and stats proving whether upstream dispatch happened.",
  "acceptance": [
    "Generic HTTP check() returns ok for ordinary happy health and exposes bridge capability details when health includes input, approval_request, and approval_resolution.",
    "Missing bridge health capabilities fail bridge readiness with generic_http_bridge_capability_missing without breaking ordinary async run start tests.",
    "send() applies non-empty input to the configured wrapper input endpoint and records only bounded/redacted transcript metadata.",
    "send() applies approval_resolution to the configured wrapper approval resolve endpoint and validates accepted responses.",
    "send() rejects missing, whitespace-only, and >64KiB text before network dispatch with runtime_input_empty or runtime_input_too_large.",
    "Generic HTTP events map approval.requested and waiting_for_input correctly and dedupe duplicate approval events by event id.",
    "Upstream 5xx, timeout/request failure, invalid JSON, malformed accepted response, and oversized response map to Generic HTTP R25 reason codes.",
    "Per-run base URL, auth token, target, path, header, command, cwd, argv, executable, env, process, PTY, browser, repo, and sandbox overrides remain ignored or rejected."
  ],
  "checks": [
    "pnpm --filter @switchyard/testkit test -- fake-http-runtime-server",
    "pnpm --filter @switchyard/adapters test -- generic-http-adapter",
    "pnpm --filter @switchyard/adapters typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "GenericHttpAsyncRestAdapter.check",
      "failure": "health response lacks input or approval bridge capabilities",
      "exception": "RuntimeAdapterCheck ok=false for bridge readiness details",
      "rescue": "Return reasonCode generic_http_bridge_capability_missing in details while preserving ordinary availability signal when start/status/events are present.",
      "user_sees": "Readiness/preflight says Generic HTTP bridge not ready"
    },
    {
      "codepath": "GenericHttpAsyncRestAdapter.send input",
      "failure": "text is missing, blank, or over 64 KiB",
      "exception": "AdapterProtocolError with runtime_input_empty or runtime_input_too_large",
      "rescue": "Reject before calling fetch and before appending raw text to logs.",
      "user_sees": "409 adapter_protocol_failed with specific reasonCode"
    },
    {
      "codepath": "GenericHttpAsyncRestAdapter.send upstream input",
      "failure": "wrapper returns non-2xx, request fails, or times out",
      "exception": "GenericHttpRequestError or non-ok GenericHttpRequestResult",
      "rescue": "Throw AdapterProtocolError generic_http_input_failed and append redacted transcript request metadata.",
      "user_sees": "503 adapter_protocol_failed with generic_http_input_failed"
    },
    {
      "codepath": "GenericHttpAsyncRestAdapter.send upstream input response",
      "failure": "response is invalid JSON, malformed, or too large",
      "exception": "GenericHttpInvalidJsonError or GenericHttpResponseTooLargeError",
      "rescue": "Map to generic_http_invalid_input_response or generic_http_input_response_too_large.",
      "user_sees": "502 adapter_protocol_failed with malformed or too-large reasonCode"
    },
    {
      "codepath": "GenericHttpAsyncRestAdapter.events approval.requested",
      "failure": "approval event lacks runtimeApprovalToken, approvalType, or expiresAt",
      "exception": "AdapterProtocolError converted to run.failed event",
      "rescue": "Emit run.failed with generic_http_approval_request_invalid instead of creating an unresolvable approval.",
      "user_sees": "Run fails with Generic HTTP approval request invalid"
    },
    {
      "codepath": "GenericHttpAsyncRestAdapter.send approval_resolution",
      "failure": "wrapper resolution endpoint fails, returns invalid JSON, malformed body, or oversized body",
      "exception": "GenericHttpRequestError, GenericHttpInvalidJsonError, GenericHttpResponseTooLargeError, or non-ok response",
      "rescue": "Map to generic_http_approval_resolution_failed, generic_http_invalid_approval_response, or generic_http_approval_response_too_large.",
      "user_sees": "Approval resolution command fails with named Generic HTTP reason"
    }
  ],
  "observability": {
    "logs": [
      "generic_http.bridge.input with runId, externalRunId, bridgeCommandId, status, durationMs, no raw text",
      "generic_http.bridge.approval.requested with runId, sourceEventId, approvalType, no token secrets beyond runtimeApprovalToken",
      "generic_http.bridge.approval.resolved with runId, bridgeCommandId, decision, status"
    ],
    "success_metric": "bridge input and approval resolution fake-server stats show exactly one upstream call per admitted command",
    "failure_metric": "adapter throws a wrapper-specific reason code and fake-server stats show zero calls for invalid local payloads"
  },
  "test_cases": [
    {
      "name": "bridge-ready health advertises capabilities",
      "lens": "happy",
      "given": "fake server health capabilities include input, approval_request, approval_resolution",
      "expect": "check() ok true and details include bridgeCapable true"
    },
    {
      "name": "missing bridge capability is fail-closed",
      "lens": "happy_shadow_nil",
      "given": "fake server health omits input",
      "expect": "bridge readiness reason generic_http_bridge_capability_missing and no provider execution is created by check()"
    },
    {
      "name": "input send posts configured endpoint",
      "lens": "happy",
      "given": "started session and send({ text:'continue', type:'input', bridgeCommandId:'cmd_1', idempotencyKey:'idem_1' })",
      "expect": "fake server records POST /v1/runs/:id/input with switchyardRunId, bridgeCommandId, idempotencyKey, type input, text continue"
    },
    {
      "name": "empty input rejected before upstream",
      "lens": "happy_shadow_empty",
      "given": "send input with text '   '",
      "expect": "AdapterProtocolError runtime_input_empty and fake server input call count remains 0"
    },
    {
      "name": "oversized input rejected before upstream",
      "lens": "edge_size_limit",
      "given": "send input with 64KiB plus one byte UTF-8 text",
      "expect": "AdapterProtocolError runtime_input_too_large and fake server input call count remains 0"
    },
    {
      "name": "approval requested event maps to Switchyard event",
      "lens": "integration",
      "given": "wrapper event approval.requested with token/type/message/expiresAt",
      "expect": "adapter yields approval.requested payload with runtimeApprovalToken, approvalType, message, expiresAt and sourceEventId"
    },
    {
      "name": "approval resolution posts configured endpoint",
      "lens": "happy",
      "given": "send approval_resolution payload with runtimeApprovalToken, decision approved, message, answers",
      "expect": "fake server records POST /v1/runs/:externalRunId/approvals/:runtimeApprovalToken/resolve and response accepted true"
    },
    {
      "name": "malformed approval event fails visibly",
      "lens": "error_path",
      "given": "wrapper approval.requested event without runtimeApprovalToken",
      "expect": "run.failed event with generic_http_approval_request_invalid"
    },
    {
      "name": "redaction excludes secrets and raw text",
      "lens": "edge_redaction",
      "given": "auth token and input text containing Authorization header",
      "expect": "logs and transcript metadata omit token and raw text"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "GenericHttpAsyncRestAdapter.send",
        "kind": "function",
        "signature": "send(session: Record<string, unknown>, input: { type: 'input'|'approval_resolution'; text?: string; bridgeCommandId?: string; idempotencyKey?: string; runtimeApprovalToken?: string; decision?: 'approved'|'rejected'; message?: string; answers?: Record<string, unknown> }) => Promise<void>"
      },
      {
        "name": "Generic HTTP bridge fake server",
        "kind": "function",
        "signature": "startFakeHttpRuntimeServer({ scenario: 'bridge_happy' | 'bridge_capability_missing' | 'approval_request' | ... }) => Promise<FakeHttpRuntimeServerHandle>"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P24-T1-contracts-openapi-error-boundary",
        "name": "R25 bridge HTTP error vocabulary",
        "signature": "httpErrorCodeSchema and STATUS_BY_CODE include all wrapper bridge reason codes from the spec"
      },
      {
        "from_task": "P24-T2-catalog-provider-policy",
        "name": "HostedRuntimeModeSlug",
        "signature": "'fake.deterministic' | 'codex.exec_json' | 'claude_code.sdk' | 'opencode.acp' | 'agentfield.async_rest' | 'generic_http.async_rest'"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/adapters/src/generic-http/generic-http-adapter.ts",
      "packages/testkit/src/fake-http-runtime-server.ts"
    ]
  }
}
```

### Task P24-T4-agentfield-wrapper-bridge-adapter

```json
{
  "id": "P24-T4-agentfield-wrapper-bridge-adapter",
  "title": "Implement AgentField wrapper bridge adapter support",
  "files": [
    "packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts",
    "packages/adapters/src/agentfield/types.ts",
    "packages/adapters/test/agentfield-async-rest-adapter.test.ts",
    "packages/testkit/src/fake-agentfield-server.ts",
    "packages/testkit/test/fake-agentfield-server.test.ts"
  ],
  "dependencies": [
    "P24-T1-contracts-openapi-error-boundary",
    "P24-T2-catalog-provider-policy"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md",
    "packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts",
    "packages/adapters/src/agentfield/http-client.ts",
    "packages/adapters/src/agentfield/types.ts",
    "packages/adapters/test/agentfield-async-rest-adapter.test.ts",
    "packages/testkit/src/fake-agentfield-server.ts"
  ],
  "instructions": "Read the AgentField Wrapper Bridge Contract. Extend check() so health still proves ordinary execution, but bridge readiness is true only when discovery/capabilities?format=compact returns switchyard_bridge.input, switchyard_bridge.approval_request, and switchyard_bridge.approval_resolution true. Discovery unavailable can remain ordinary-runnable but bridge readiness must fail closed with agentfield_bridge_capability_missing. Update manifest placement.hosted to conditional and capabilities/limitations to match catalog. Implement send(session, input) for input and approval_resolution. Input posts to /api/v1/executions/:executionId/input with switchyardRunId, bridgeCommandId, idempotencyKey, type input, and input.text. Approval resolution posts to /api/v1/executions/:executionId/approvals/:runtimeApprovalToken/resolve with switchyardRunId, bridgeCommandId, idempotencyKey, decision, message, and answers. Reject missing/empty/oversized text before network dispatch. Map polled waiting_for_input to runtime.status waiting_for_input. Map waiting_for_approval with valid approval object to approval.requested. waiting_for_approval without token/type/expiry must fail the run with agentfield_approval_request_invalid. Extend the fake AgentField server with bridge discovery, input endpoint, approval resolution endpoint, waiting input, waiting approval, malformed approval, upstream failure, invalid JSON, oversized response, timeout/request failure, and stats.",
  "acceptance": [
    "AgentField discovery advertises bridge capability and check() exposes bridge-ready details only when switchyard_bridge input, approval_request, and approval_resolution are true.",
    "Discovery unavailable or missing switchyard_bridge keeps ordinary execution behavior but bridge readiness fails with agentfield_bridge_capability_missing.",
    "send() applies input to the configured execution input endpoint and never accepts per-run base URL/API key/target overrides.",
    "send() applies approval_resolution to the configured execution approval resolve endpoint and validates accepted responses.",
    "send() rejects missing, whitespace-only, and >64KiB text before network dispatch with runtime_input_empty or runtime_input_too_large.",
    "Polling maps waiting_for_input to runtime.status and valid waiting_for_approval to approval.requested.",
    "Invalid waiting_for_approval payload emits run.failed with agentfield_approval_request_invalid and creates no unresolvable approval.",
    "Upstream 5xx, timeout/request failure, invalid JSON, malformed accepted response, and oversized response map to AgentField R25 reason codes.",
    "Logs, events, transcripts, and artifacts redact API keys, Authorization headers, raw text, and upstream response bodies."
  ],
  "checks": [
    "pnpm --filter @switchyard/testkit test -- fake-agentfield-server",
    "pnpm --filter @switchyard/adapters test -- agentfield-async-rest-adapter",
    "pnpm --filter @switchyard/adapters typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "AgentFieldAsyncRestAdapter.check",
      "failure": "discovery unavailable or switchyard_bridge capability missing",
      "exception": "RuntimeAdapterCheck bridge details not ready",
      "rescue": "Return bridge reason agentfield_bridge_capability_missing while keeping ordinary health/discovery runnable behavior as current tests expect.",
      "user_sees": "Readiness/preflight says AgentField bridge not ready"
    },
    {
      "codepath": "AgentFieldAsyncRestAdapter.send input",
      "failure": "text missing, blank, or over 64 KiB",
      "exception": "AdapterProtocolError runtime_input_empty or runtime_input_too_large",
      "rescue": "Reject before upstream fetch and do not log raw text.",
      "user_sees": "409 adapter_protocol_failed with specific reasonCode"
    },
    {
      "codepath": "AgentFieldAsyncRestAdapter.send upstream input",
      "failure": "AgentField input endpoint returns non-2xx or request fails",
      "exception": "AgentFieldRequestError or non-ok AgentFieldRequestResult",
      "rescue": "Throw AdapterProtocolError agentfield_input_failed and append redacted transcript metadata.",
      "user_sees": "503 adapter_protocol_failed with agentfield_input_failed"
    },
    {
      "codepath": "AgentFieldAsyncRestAdapter.send input response",
      "failure": "response invalid JSON, malformed, or too large",
      "exception": "AgentFieldInvalidJsonError or AgentFieldResponseTooLargeError",
      "rescue": "Map to agentfield_invalid_input_response or agentfield_input_response_too_large.",
      "user_sees": "502 adapter_protocol_failed with malformed or too-large reasonCode"
    },
    {
      "codepath": "AgentFieldAsyncRestAdapter.events waiting_for_approval",
      "failure": "approval object is missing token, approval_type, message, or expires_at",
      "exception": "invalid polled state mapped to failure event",
      "rescue": "Emit run.failed with agentfield_approval_request_invalid and mark session terminal failed.",
      "user_sees": "Run fails with AgentField approval request invalid"
    },
    {
      "codepath": "AgentFieldAsyncRestAdapter.send approval_resolution",
      "failure": "resolution endpoint fails, returns invalid JSON, malformed body, or oversized body",
      "exception": "AgentFieldRequestError, AgentFieldInvalidJsonError, AgentFieldResponseTooLargeError, or non-ok response",
      "rescue": "Map to agentfield_approval_resolution_failed, agentfield_invalid_approval_response, or agentfield_approval_response_too_large.",
      "user_sees": "Approval resolution command fails with named AgentField reason"
    }
  ],
  "observability": {
    "logs": [
      "agentfield.bridge.input with runId, executionId, bridgeCommandId, status, durationMs, no raw text",
      "agentfield.bridge.approval.requested with runId, approvalType, executionId, no API key",
      "agentfield.bridge.approval.resolved with runId, bridgeCommandId, decision, status"
    ],
    "success_metric": "fake AgentField stats show exactly one upstream input or approval resolution call per valid command",
    "failure_metric": "invalid local payloads make zero upstream calls and throw named reason codes"
  },
  "test_cases": [
    {
      "name": "bridge-ready discovery advertises capabilities",
      "lens": "happy",
      "given": "fake discovery includes switchyard_bridge true for input, approval_request, approval_resolution",
      "expect": "check() details include bridgeCapable true and executeAsyncCalls is 0"
    },
    {
      "name": "missing bridge discovery capability is fail-closed",
      "lens": "happy_shadow_nil",
      "given": "discovery lacks switchyard_bridge",
      "expect": "bridge reason agentfield_bridge_capability_missing and ordinary health remains checked"
    },
    {
      "name": "input send posts configured execution endpoint",
      "lens": "happy",
      "given": "started session and send input text continue with bridgeCommandId and idempotencyKey",
      "expect": "fake server records POST /api/v1/executions/:executionId/input with input.text continue"
    },
    {
      "name": "empty input rejected before upstream",
      "lens": "happy_shadow_empty",
      "given": "send input with text ' '",
      "expect": "AdapterProtocolError runtime_input_empty and fake server input count 0"
    },
    {
      "name": "waiting for input maps to runtime status",
      "lens": "integration",
      "given": "poll response status waiting_for_input",
      "expect": "adapter yields runtime.status payload status waiting_for_input"
    },
    {
      "name": "waiting approval maps to approval requested",
      "lens": "integration",
      "given": "poll response status waiting_for_approval with approval token/type/message/expires_at",
      "expect": "adapter yields approval.requested with runtimeApprovalToken and expiresAt"
    },
    {
      "name": "malformed approval poll fails",
      "lens": "error_path",
      "given": "waiting_for_approval without approval token",
      "expect": "run.failed with agentfield_approval_request_invalid"
    },
    {
      "name": "approval resolution posts configured endpoint",
      "lens": "happy",
      "given": "send approval_resolution payload with token and decision rejected",
      "expect": "fake server records POST /api/v1/executions/:executionId/approvals/:runtimeApprovalToken/resolve"
    },
    {
      "name": "redaction excludes API key and raw input",
      "lens": "edge_redaction",
      "given": "api key and text containing Authorization header",
      "expect": "events, logs, transcript, and artifacts exclude raw secret values"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "AgentFieldAsyncRestAdapter.send",
        "kind": "function",
        "signature": "send(session: Record<string, unknown>, input: { type: 'input'|'approval_resolution'; text?: string; bridgeCommandId?: string; idempotencyKey?: string; runtimeApprovalToken?: string; decision?: 'approved'|'rejected'; message?: string; answers?: Record<string, unknown> }) => Promise<void>"
      },
      {
        "name": "AgentField bridge fake server",
        "kind": "function",
        "signature": "startFakeAgentFieldServer({ scenario: 'bridge_happy' | 'bridge_capability_missing' | 'waiting_for_input' | 'waiting_for_approval' | ... }) => Promise<FakeAgentFieldServerHandle>"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P24-T1-contracts-openapi-error-boundary",
        "name": "R25 bridge HTTP error vocabulary",
        "signature": "httpErrorCodeSchema and STATUS_BY_CODE include all wrapper bridge reason codes from the spec"
      },
      {
        "from_task": "P24-T2-catalog-provider-policy",
        "name": "HostedRuntimeModeSlug",
        "signature": "'fake.deterministic' | 'codex.exec_json' | 'claude_code.sdk' | 'opencode.acp' | 'agentfield.async_rest' | 'generic_http.async_rest'"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/adapters/src/agentfield/agentfield-async-rest-adapter.ts",
      "packages/testkit/src/fake-agentfield-server.ts"
    ]
  }
}
```

### Task P24-T5-core-bridge-admission-apply

```json
{
  "id": "P24-T5-core-bridge-admission-apply",
  "title": "Extend core bridge admission, apply, and runtime approval semantics",
  "files": [
    "packages/core/src/services/hosted-runtime-bridge-service.ts",
    "packages/core/src/services/runtime-runner-service.ts",
    "packages/core/test/hosted-runtime-bridge-service.test.ts",
    "packages/core/test/runtime-approval-session-r16.test.ts"
  ],
  "dependencies": [
    "P24-T1-contracts-openapi-error-boundary",
    "P24-T2-catalog-provider-policy",
    "P24-T3-generic-http-wrapper-bridge-adapter",
    "P24-T4-agentfield-wrapper-bridge-adapter"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md",
    "packages/core/src/services/hosted-runtime-bridge-service.ts",
    "packages/core/src/services/runtime-runner-service.ts",
    "packages/core/test/hosted-runtime-bridge-service.test.ts",
    "packages/core/test/runtime-approval-session-r16.test.ts",
    "packages/contracts/src/hosted-runtime-bridge.ts"
  ],
  "instructions": "Read Hosted Input Bridge, Hosted Approval Bridge, Data And Durability, and Shadow-Path Requirements. Reuse the existing HostedRuntimeBridgeService and payload store. Tighten createInputCommand validation so missing body and missing text return invalid_input with body.text details, whitespace-only text returns runtime_input_empty, and text over 64 KiB UTF-8 returns runtime_input_too_large before quota or command writes. Build worker dispatch payloads with switchyardRunId, bridgeCommandId, idempotencyKey, type input, and text for wrapper input. For approval_resolution, include switchyardRunId, bridgeCommandId, idempotencyKey, approvalId, runtimeApprovalToken, decision, message, and answers. Add dynamic wrapper capability admission hooks so wrapper modes can fail with agentfield_bridge_capability_missing or generic_http_bridge_capability_missing when server/worker readiness says the current session is not bridge-capable. Preserve existing Claude/OpenCode behavior and stale non-idempotent recovery. Extend runtime runner approval.requested handling to accept wrapper events, create durable owned approvals, store runtimeApprovalToken/runtimeMode/runtimeSessionId/expiresAt, and transition sessions/runs between waiting_for_input, waiting_for_approval, and running for wrapper status events.",
  "acceptance": [
    "Wrapper input command admission stores runtimeMode agentfield.async_rest or generic_http.async_rest in existing hosted_runtime_bridge_commands.",
    "Raw worker payload hash is computed over the bounded dispatch payload, while redactedPayload omits raw text, tokens, API keys, Authorization headers, base URLs with credentials, env values, command strings, argv, cwd overrides, and provider response bodies.",
    "Missing body or missing text returns invalid_input with body.text issue and creates no command, quota reservation, audit allow, or payload.",
    "Whitespace-only text and over-64KiB text return runtime_input_empty or runtime_input_too_large before quota or command writes.",
    "Same idempotency key and same wrapper payload returns duplicate true with same command id; same key and different payload returns hosted_runtime_bridge_payload_mismatch.",
    "Worker claim/apply revalidates session ownership, runtime mode, runtimeSessionId, payload hash, and runtime runner sendInput before completing command.",
    "Stale claimed wrapper command recovery preserves hosted_runtime_bridge_non_idempotent_retry_blocked and finalizes quota without retrying provider input.",
    "Wrapper approval.requested events create owned pending approvals and resolution commands use existing approval endpoints.",
    "Expired approvals map to existing ACP expiry behavior or wrapper-specific expiry mapped to the same HTTP behavior."
  ],
  "checks": [
    "pnpm --filter @switchyard/core test -- hosted-runtime-bridge-service runtime-approval-session-r16",
    "pnpm --filter @switchyard/core typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "HostedRuntimeBridgeService.createInputCommand",
      "failure": "body is nil, non-object, or missing body.text",
      "exception": "HostedRuntimeBridgeServiceError code invalid_input",
      "rescue": "Reject before run lookup side effects that reveal data, before quota reserve, command create, payload put, and worker dispatch.",
      "user_sees": "400 invalid_input with details.path body.text and issue required for hosted wrapper input"
    },
    {
      "codepath": "HostedRuntimeBridgeService.createInputCommand",
      "failure": "text is whitespace-only or over 64 KiB UTF-8",
      "exception": "HostedRuntimeBridgeServiceError adapter_protocol_failed with runtime_input_empty or runtime_input_too_large",
      "rescue": "Reject before quota reserve, command create, payload put, audit allow, and upstream dispatch.",
      "user_sees": "409 adapter_protocol_failed with runtime_input_empty or runtime_input_too_large"
    },
    {
      "codepath": "HostedRuntimeBridgeService.createInputCommand",
      "failure": "wrapper session lacks hostedBridgeCapable or mode-specific capability",
      "exception": "HostedRuntimeBridgeServiceError adapter_protocol_failed with agentfield_bridge_capability_missing or generic_http_bridge_capability_missing",
      "rescue": "Reject before command creation and audit deny with runtimeMode and operation only.",
      "user_sees": "409 or 503 adapter_protocol_failed with wrapper bridge capability missing"
    },
    {
      "codepath": "HostedRuntimeBridgeService.claimAndApplyNext",
      "failure": "claimed worker does not own session or runtimeSessionId mismatches",
      "exception": "session ownership/mismatch condition",
      "rescue": "Fail command, finalize quota, delete payload, terminalize run with hosted_runtime_session_lost or hosted_runtime_session_state_incomplete.",
      "user_sees": "Run fails closed instead of provider input going to wrong session"
    },
    {
      "codepath": "HostedRuntimeBridgeService.claimAndApplyNext",
      "failure": "payload row missing or payload hash mismatch",
      "exception": "undefined payload or recomputed hash mismatch",
      "rescue": "Fail command with hosted_runtime_bridge_store_unavailable or hosted_runtime_bridge_payload_mismatch; delete payload if present.",
      "user_sees": "409 or 503 named bridge failure and no blind provider dispatch"
    },
    {
      "codepath": "RuntimeRunnerService approval.requested handling",
      "failure": "wrapper approval event is missing token/type/expiry or ownership attach fails",
      "exception": "AdapterProtocolError or HostedRuntimeBridgeServiceError approval_ownership_attach_failed",
      "rescue": "Do not create a pending unresolvable approval; fail or reject approval and surface named reason.",
      "user_sees": "Run/approval fails with wrapper approval invalid or ownership attach failed"
    }
  ],
  "observability": {
    "logs": [
      "hosted.runtime_bridge.admission allow/deny with runId, runtimeMode, operation, commandId, requestId, reasonCode, no raw text",
      "hosted.runtime_bridge.claimed/completed/failed/reconciled with commandId, runId, runtimeMode, operation, reasonCode",
      "runtime.approval.requested for wrapper runtime approvals with runId, approvalId, runtimeMode, approvalType, no raw token secrets beyond runtimeApprovalToken"
    ],
    "success_metric": "admitted wrapper commands complete and payload rows are deleted after apply",
    "failure_metric": "failed commands have named reasonCode, quota finalized, payload deleted, and no raw text in command metadata"
  },
  "test_cases": [
    {
      "name": "admits Generic HTTP input command",
      "lens": "happy",
      "given": "active hosted generic_http.async_rest run and worker-owned bridge-capable session",
      "expect": "command runtimeMode generic_http.async_rest, operation input, payload row includes type input and text"
    },
    {
      "name": "admits AgentField approval resolution command",
      "lens": "happy",
      "given": "pending runtime approval for active hosted agentfield.async_rest run",
      "expect": "approval transitions to approved or rejected and command operation approval_resolution is queued"
    },
    {
      "name": "missing text no side effects",
      "lens": "happy_shadow_nil",
      "given": "createInputCommand body {}",
      "expect": "invalid_input body.text; commands, payloads, quota reservations, and runner calls remain zero"
    },
    {
      "name": "empty text no side effects",
      "lens": "happy_shadow_empty",
      "given": "createInputCommand body { text:'   ' }",
      "expect": "runtime_input_empty; commands and quota reservations remain zero"
    },
    {
      "name": "overlarge text no side effects",
      "lens": "edge_size_limit",
      "given": "createInputCommand text over 64 KiB UTF-8",
      "expect": "runtime_input_too_large; no command or payload created"
    },
    {
      "name": "idempotency mismatch rejected",
      "lens": "error_path",
      "given": "same idempotency key with different wrapper dispatch payload",
      "expect": "hosted_runtime_bridge_payload_mismatch and no second quota reservation"
    },
    {
      "name": "worker applies original payload and deletes payload row",
      "lens": "integration",
      "given": "server-admitted secret-bearing wrapper input command and worker claim",
      "expect": "runtimeRunner.sendInput receives original bounded payload, command completes, payload store empty, persisted redactedPayload has no raw text"
    },
    {
      "name": "session not owned terminalizes run",
      "lens": "error_path",
      "given": "claimed command for worker_b while session hostedWorkerId is worker_a",
      "expect": "command failed hosted_runtime_bridge_session_not_owned and run reasonCode hosted_runtime_session_lost"
    },
    {
      "name": "stale claim is not retried",
      "lens": "error_path",
      "given": "claimed wrapper command lease expired before reconciliation",
      "expect": "hosted_runtime_bridge_non_idempotent_retry_blocked and quota finalized"
    },
    {
      "name": "wrapper approval requested creates owned approval",
      "lens": "integration",
      "given": "adapter emits approval.requested with runtimeApprovalToken, approvalType, expiresAt",
      "expect": "approval record pending with runtimeMode, runtimeSessionId, token, ownership attached from run"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "HostedRuntimeBridgeService.createInputCommand",
        "kind": "function",
        "signature": "createInputCommand({ runId, body, auth?, requestId?, idempotencyKey? }) => Promise<{ accepted: true; commandId: string; duplicate: boolean }>"
      },
      {
        "name": "HostedRuntimeBridgeService.resolveRuntimeApproval",
        "kind": "function",
        "signature": "resolveRuntimeApproval({ approvalId, decision, body?, auth?, requestId?, idempotencyKey? }) => Promise<{ approval: Approval; commandId: string; duplicate: boolean }>"
      },
      {
        "name": "RuntimeRunnerService wrapper approval handling",
        "kind": "function",
        "signature": "approval.requested events with runtimeApprovalToken create owned runtime approval records and session status waiting_for_approval"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P24-T3-generic-http-wrapper-bridge-adapter",
        "name": "GenericHttpAsyncRestAdapter.send",
        "signature": "send(session: Record<string, unknown>, input: { type: 'input'|'approval_resolution'; text?: string; bridgeCommandId?: string; idempotencyKey?: string; runtimeApprovalToken?: string; decision?: 'approved'|'rejected'; message?: string; answers?: Record<string, unknown> }) => Promise<void>"
      },
      {
        "from_task": "P24-T4-agentfield-wrapper-bridge-adapter",
        "name": "AgentFieldAsyncRestAdapter.send",
        "signature": "send(session: Record<string, unknown>, input: { type: 'input'|'approval_resolution'; text?: string; bridgeCommandId?: string; idempotencyKey?: string; runtimeApprovalToken?: string; decision?: 'approved'|'rejected'; message?: string; answers?: Record<string, unknown> }) => Promise<void>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/services/hosted-runtime-bridge-service.ts",
      "packages/core/src/services/runtime-runner-service.ts"
    ]
  }
}
```

### Task P24-T6-server-rest-admission-readiness

```json
{
  "id": "P24-T6-server-rest-admission-readiness",
  "title": "Wire server REST admission, auth, quota, audit, and readiness",
  "files": [
    "packages/protocol-rest/src/run-routes.ts",
    "packages/protocol-rest/src/hosted-tool-routes.ts",
    "packages/protocol-rest/test/run-routes.test.ts",
    "packages/protocol-rest/test/hosted-tool-routes.test.ts",
    "apps/server/src/config.ts",
    "apps/server/src/app.ts",
    "apps/server/src/readiness.ts",
    "apps/server/test/hosted-server.test.ts",
    "apps/server/test/production-config.test.ts",
    "apps/server/test/production-readiness.test.ts"
  ],
  "dependencies": [
    "P24-T1-contracts-openapi-error-boundary",
    "P24-T2-catalog-provider-policy",
    "P24-T5-core-bridge-admission-apply"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md",
    "packages/protocol-rest/src/run-routes.ts",
    "packages/protocol-rest/src/hosted-tool-routes.ts",
    "apps/server/src/app.ts",
    "apps/server/src/readiness.ts",
    "packages/protocol-rest/test/run-routes.test.ts",
    "apps/server/test/production-readiness.test.ts"
  ],
  "instructions": "Read Product/API Boundary and Auth, Ownership, Quota, And Audit. Reuse POST /runs/:id/input for wrapper input and existing /approvals routes for runtime approval resolution. Do not add public routes. Server admission must authorize run or approval ownership before fetching underlying objects in hosted mode. For hosted wrapper input, call HostedRuntimeBridgeService.createInputCommand and return 202 { accepted:true, bridgeCommandId }. For wrapper runtime approvals, existing hosted tool approval routes must continue to route runtime-scoped approvals to resolveRuntimeApproval and return bridgeCommandId. Ensure POST /runs?wait=1 remains denied for hosted wrapper real runs before durable queue/provider side effects. Extend server config and readiness so wrapper allowlists validate provider activation, shared bridge command/payload stores, ownership, quota, audit, route auth, worker claim/readiness, wrapper_config, and wrapper_bridge_capability. Add audit records for allow and deny decisions with ids/reason codes only. Add route-boundary and no-leak tests proving auth/ownership denial happens before existence or capability probing.",
  "acceptance": [
    "POST /runs/:id/input admits active hosted AgentField and Generic HTTP bridge input and returns bridgeCommandId through the existing route.",
    "Missing hosted bridge dependencies return hosted_runtime_bridge_store_unavailable or hosted_runtime_bridge_worker_unavailable and create no command.",
    "Unsupported codex.exec_json, codex.interactive, browser, repo, process, PTY, shell, sandbox, Cursor, OpenClaw, Paperclip, and unknown runtime modes remain denied with named reason codes.",
    "Approval list/get/approve/reject expose and resolve wrapper runtime approvals only when caller owns the approval and the bridge service is configured.",
    "Ownership and auth denial occur before run, approval, command, store, or capability existence probing leaks.",
    "Hosted wrapper run creation with wait=1 rejects before run persistence, queue enqueue, or provider dispatch.",
    "Server readiness reports wrapper bridge dependencies with wrapper_config and wrapper_bridge_capability checks and fails closed when wrapper modes are allowlisted but not ready.",
    "Audit events for bridge admission, approval resolution, and denial contain route id, resource id, reason code, runtimeMode, operation, requestId, and no raw text/secrets."
  ],
  "checks": [
    "pnpm --filter @switchyard/protocol-rest test -- run-routes hosted-tool-routes",
    "pnpm --filter @switchyard/server test -- hosted-server production-config production-readiness",
    "pnpm --filter @switchyard/protocol-rest typecheck",
    "pnpm --filter @switchyard/server typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "POST /runs/:id/input hosted route",
      "failure": "caller unauthenticated or unowned run id",
      "exception": "ControlPlaneError or authorizeResource not ok",
      "rescue": "Return auth_required, run_not_found, or access denied before deps.runs.get and before bridge service call.",
      "user_sees": "401, 403, or no-leak 404 with requestId"
    },
    {
      "codepath": "POST /runs/:id/input hosted route",
      "failure": "hostedRuntimeBridge dependency missing",
      "exception": "dependency guard returns false",
      "rescue": "Return adapter_protocol_failed with hosted_runtime_bridge_store_unavailable; do not call local runService.sendInput.",
      "user_sees": "503 named bridge unavailable response"
    },
    {
      "codepath": "approval approve/reject hosted route",
      "failure": "runtime approval is not owned or not runtime-scoped",
      "exception": "authorizeResource denial or classifyApprovalScope non-runtime/non-tool",
      "rescue": "Deny before resolution; runtime approvals use bridge service, tool approvals use hosted tool service, unknown scope returns approval_scope_denied.",
      "user_sees": "No-leak denial or approval_scope_denied"
    },
    {
      "codepath": "POST /runs?wait=1 hosted wrapper",
      "failure": "wait=1 requested with agentfield.async_rest or generic_http.async_rest hosted run",
      "exception": "placement/admission validation error",
      "rescue": "Reject before createRun, quota reserve, queue enqueue, or provider dispatch.",
      "user_sees": "400 or 409 named wait/hosted wrapper denial"
    },
    {
      "codepath": "probeServerReadiness runtimeBridge",
      "failure": "wrapper mode allowlisted but command store, payload store, worker readiness, route auth, wrapper_config, or wrapper_bridge_capability missing",
      "exception": "ReadyResponse ok=false",
      "rescue": "Return 503 /ready with first failing named code and redacted diagnostics.",
      "user_sees": "/ready shows named bridge dependency failure"
    }
  ],
  "observability": {
    "logs": [
      "hosted.runtime_bridge.admission allow/deny with routeId runs.input and no raw text",
      "hosted.runtime_bridge.approval_resolved allow/deny with approvalId, commandId, runtimeMode, decision, no answers values when secret-like",
      "server.readiness hostedRuntimeBridge diagnostics with failed check names and reason codes"
    ],
    "success_metric": "hosted wrapper bridge admission returns bridgeCommandId and no local dispatch occurs",
    "failure_metric": "denied requests return named error before side effects and audit deny is recorded"
  },
  "test_cases": [
    {
      "name": "admits hosted Generic HTTP input route",
      "lens": "happy",
      "given": "owned active hosted generic_http.async_rest run and bridge service spy",
      "expect": "202 { accepted:true, bridgeCommandId } and runService.sendInput not called"
    },
    {
      "name": "admits hosted AgentField input route",
      "lens": "happy",
      "given": "owned active hosted agentfield.async_rest run and bridge service spy",
      "expect": "createInputCommand called with runId, body.text, auth, requestId, idempotencyKey"
    },
    {
      "name": "missing input text reaches core invalid_input",
      "lens": "happy_shadow_nil",
      "given": "POST /runs/:id/input payload {}",
      "expect": "400 invalid_input with body.text detail and bridge service creates no command"
    },
    {
      "name": "unowned run no-leak",
      "lens": "error_path",
      "given": "hosted auth denies run ownership",
      "expect": "route does not call runs.get or hostedRuntimeBridge.createInputCommand"
    },
    {
      "name": "runtime approval resolve routed through bridge",
      "lens": "integration",
      "given": "owned approval payload runtimeApprovalToken and runtimeMode generic_http.async_rest",
      "expect": "POST /approvals/:id/approve returns approval plus bridgeCommandId"
    },
    {
      "name": "approval ownership denial before get",
      "lens": "error_path",
      "given": "authorizeResource returns approval_not_found for hidden approval",
      "expect": "approvals.get and resolveRuntimeApproval are not called"
    },
    {
      "name": "wait hosted wrapper rejected before side effects",
      "lens": "error_path",
      "given": "POST /runs?wait=1 placement hosted runtimeMode agentfield.async_rest",
      "expect": "non-2xx response, createRun spy not called, queue spy not called"
    },
    {
      "name": "server readiness wrapper bridge checks fail closed",
      "lens": "integration",
      "given": "allowlist includes generic_http.async_rest and workerReadiness adapterCapability false",
      "expect": "ready ok false with hostedRuntimeBridge code generic_http_bridge_capability_missing or hosted_runtime_bridge_operation_unsupported"
    },
    {
      "name": "route inventory has no new bridge routes",
      "lens": "integration",
      "given": "server app route list after registration",
      "expect": "only existing /runs/:id/input and approval routes; no /runtime-bridge, /session, /model-judge, /exec, /pty, dashboard, or TUI"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "hosted wrapper input REST admission",
        "kind": "function",
        "signature": "POST /runs/:id/input -> 202 { accepted: true, bridgeCommandId: string } for owned active hosted wrapper bridge runs"
      },
      {
        "name": "hosted wrapper approval resolution REST admission",
        "kind": "function",
        "signature": "POST /approvals/:id/(approve|reject) -> { approval: Approval, bridgeCommandId: string } for owned runtime approvals"
      },
      {
        "name": "server hostedRuntimeBridge readiness",
        "kind": "function",
        "signature": "getServerRuntimeBridgeReadiness(deps) => { status: 'ready'|'not_ready'; checks: HostedRuntimeBridgeReadinessCheck[] }"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P24-T5-core-bridge-admission-apply",
        "name": "HostedRuntimeBridgeService.createInputCommand",
        "signature": "createInputCommand({ runId, body, auth?, requestId?, idempotencyKey? }) => Promise<{ accepted: true; commandId: string; duplicate: boolean }>"
      },
      {
        "from_task": "P24-T5-core-bridge-admission-apply",
        "name": "HostedRuntimeBridgeService.resolveRuntimeApproval",
        "signature": "resolveRuntimeApproval({ approvalId, decision, body?, auth?, requestId?, idempotencyKey? }) => Promise<{ approval: Approval; commandId: string; duplicate: boolean }>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/protocol-rest/src/run-routes.ts",
      "packages/protocol-rest/src/hosted-tool-routes.ts",
      "apps/server/src/readiness.ts"
    ]
  }
}
```

### Task P24-T7-worker-wrapper-bridge-readiness

```json
{
  "id": "P24-T7-worker-wrapper-bridge-readiness",
  "title": "Wire worker wrapper adapter construction, claim, and readiness",
  "files": [
    "apps/worker/src/config.ts",
    "apps/worker/src/hosted-runtime-adapters.ts",
    "apps/worker/src/worker.ts",
    "apps/worker/src/ready.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts",
    "apps/worker/test/production-config.test.ts"
  ],
  "dependencies": [
    "P24-T2-catalog-provider-policy",
    "P24-T3-generic-http-wrapper-bridge-adapter",
    "P24-T4-agentfield-wrapper-bridge-adapter",
    "P24-T5-core-bridge-admission-apply"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md",
    "apps/worker/src/config.ts",
    "apps/worker/src/hosted-runtime-adapters.ts",
    "apps/worker/src/worker.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts"
  ],
  "instructions": "Read Worker tests and Readiness. Add worker config fields for Generic HTTP and AgentField wrapper base URL/token/API key/target/timeouts/max response bytes using the same env names as daemon docs. Redact these values in WorkerConfig.redactedSummary. buildHostedWorkerAdapters must construct GenericHttpAsyncRestAdapter and AgentFieldAsyncRestAdapter only when shouldEnableRealMode passes for the mode and wrapper config/policy gates pass. Production should require provider/wrapper activation and valid env references; test/staging should still require explicit allowlist and hosted real runtime enabled. checkConfiguredHostedAdapters must include both wrapper modes and call adapter.check() without creating provider executions. getWorkerRuntimeBridgeReadiness must compute adapterCapabilities per required bridge mode, including wrapper_config and wrapper_bridge_capability checks. createHostedWorker adapterRuntimeModes must include wrapper modes only when adapters are actually constructed. The bridge loop remains before tools and run claims. Stamp session state for wrapper runs with hostedWorkerId, hostedRuntimeSessionId, hostedBridgeCapable, runtimeMode, and externalSessionKey after start.",
  "acceptance": [
    "Worker config loads Generic HTTP and AgentField wrapper env values, validates positive numeric bounds, and redacts base URLs with credentials, auth tokens, API keys, and targets where secret-like.",
    "Worker constructs Generic HTTP and AgentField adapters only when mode is allowlisted, hosted real runtime execution is enabled, provider/wrapper policy activation passes, and wrapper config is present.",
    "Worker does not construct wrapper adapters for fake-only default, unknown modes, disabled hosted real runtime execution, or production activation failure.",
    "Worker adapter checks call wrapper health/discovery only and do not create upstream executions by default.",
    "Worker readiness reports wrapper_config and wrapper_bridge_capability failures for wrapper modes with mode-specific reason codes.",
    "Worker bridge loop claims and applies wrapper input and approval resolution only for the worker-owned runtime session.",
    "Worker hosted debate readiness becomes not ready when wrapper bridge readiness is required and unavailable.",
    "Hosted real active cancel remains unsupported for active AgentField/Generic HTTP wrapper runs; queued hosted runs may still cancel before claim."
  ],
  "checks": [
    "pnpm --filter @switchyard/worker test -- hosted-worker production-worker-readiness production-config",
    "pnpm --filter @switchyard/worker typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "loadWorkerConfig wrapper env parsing",
      "failure": "base URL invalid, API key/token missing, target missing, timeout invalid, poll interval invalid, or max response bytes invalid",
      "exception": "ConfigError with config_invalid or wrapper config reason",
      "rescue": "Fail startup/preflight with redacted summary; do not construct wrapper adapter.",
      "user_sees": "Worker readiness/preflight wrapper_config failure"
    },
    {
      "codepath": "buildHostedWorkerAdapters",
      "failure": "wrapper mode not allowlisted or hosted real runtime disabled",
      "exception": "shouldEnableRealMode false",
      "rescue": "Skip adapter construction and report not_allowlisted or hosted_real_runtime_disabled in adapter checks.",
      "user_sees": "Mode unavailable; no provider call"
    },
    {
      "codepath": "checkConfiguredHostedAdapters",
      "failure": "adapter.check reports missing bridge capability",
      "exception": "RuntimeAdapterCheck ok=false or bridge detail false",
      "rescue": "Return mode status code agentfield_bridge_capability_missing or generic_http_bridge_capability_missing.",
      "user_sees": "Worker /ready or preflight shows wrapper bridge capability missing"
    },
    {
      "codepath": "createHostedWorker bridge loop",
      "failure": "claimed command belongs to another worker/session",
      "exception": "HostedRuntimeBridgeService claim validation failure",
      "rescue": "Core fails command and terminalizes run; worker tick returns true and logs reason.",
      "user_sees": "Run fails closed with session ownership reason"
    },
    {
      "codepath": "session owner stamping after start",
      "failure": "adapter start returns no externalSessionKey or session update compare fails",
      "exception": "adapter start result/session store update failure",
      "rescue": "Fail run with hosted_runtime_session_state_incomplete and do not report bridge-ready session.",
      "user_sees": "Run fails closed; input bridge remains unavailable"
    }
  ],
  "observability": {
    "logs": [
      "worker.runtime_bridge.reconcile with workerId, reconciled, failed",
      "worker.ready hostedRuntimeBridge diagnostics with bridgeModes and failed checks",
      "hosted adapter construction logs mode ids and readiness reason codes without wrapper URLs or credentials"
    ],
    "success_metric": "worker readiness ready when wrapper mode allowlisted, adapter constructed, bridge capability check passes, and bridge stores are present",
    "failure_metric": "worker readiness not ready with first failing named wrapper_config or wrapper_bridge_capability code"
  },
  "test_cases": [
    {
      "name": "fake-only default constructs no wrapper adapters",
      "lens": "happy_shadow_nil",
      "given": "base worker config with allowlist fake.deterministic",
      "expect": "adapters has fake only and wrapper mode status not_allowlisted or inactive"
    },
    {
      "name": "Generic HTTP adapter constructed when gated",
      "lens": "happy",
      "given": "allowlist generic_http.async_rest, hosted real enabled, valid activation, base URL config",
      "expect": "adapters has generic_http and adapterRuntimeModes includes generic_http.async_rest"
    },
    {
      "name": "AgentField adapter constructed when gated",
      "lens": "happy",
      "given": "allowlist agentfield.async_rest, hosted real enabled, valid activation, base URL/API key/target config",
      "expect": "adapters has agentfield and adapterRuntimeModes includes agentfield.async_rest"
    },
    {
      "name": "missing wrapper config fails readiness",
      "lens": "error_path",
      "given": "allowlist agentfield.async_rest without SWITCHYARD_AGENTFIELD_BASE_URL",
      "expect": "worker readiness false with agentfield_bridge_config_missing or wrapper_config failure"
    },
    {
      "name": "missing bridge capability fails readiness",
      "lens": "error_path",
      "given": "fake wrapper server health/discovery lacks bridge capability",
      "expect": "worker hostedRuntimeBridge check adapter_capability or wrapper_bridge_capability false with mode-specific reason"
    },
    {
      "name": "adapter checks do not create executions",
      "lens": "integration",
      "given": "fake AgentField server with stats and worker ready check",
      "expect": "health/discovery calls happen, executeAsyncCalls remains 0"
    },
    {
      "name": "bridge command is applied before run queue claim",
      "lens": "integration",
      "given": "queued bridge command and queued hosted run in same worker tick",
      "expect": "bridge runtimeRunner.sendInput called and run queue claim waits until next tick"
    },
    {
      "name": "wrapper session ownership stamped",
      "lens": "integration",
      "given": "started hosted generic_http.async_rest run",
      "expect": "session state includes hostedWorkerId, hostedRuntimeSessionId, hostedBridgeCapable true, runtimeMode, externalSessionKey"
    },
    {
      "name": "logs redact wrapper config",
      "lens": "edge_redaction",
      "given": "worker config contains API key, token, and credential-bearing URL",
      "expect": "readiness and adapter construction diagnostics omit raw secret values"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "buildHostedWorkerAdapters wrapper modes",
        "kind": "function",
        "signature": "buildHostedWorkerAdapters(config, deps?) => Map<string, RuntimeAdapter> containing generic_http and agentfield only when gated"
      },
      {
        "name": "checkConfiguredHostedAdapters wrapper statuses",
        "kind": "function",
        "signature": "checkConfiguredHostedAdapters(config, deps?) => Promise<{ ok: boolean; modes: Record<HostedRuntimeModeSlug, { ok: boolean; code?: string }> }>"
      },
      {
        "name": "getWorkerRuntimeBridgeReadiness wrapper checks",
        "kind": "function",
        "signature": "getWorkerRuntimeBridgeReadiness({ commandStore, workerClaim, sessionReconciliation, approvalSender, adapterCapabilities }) => HostedRuntimeBridgeReadinessReport"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P24-T3-generic-http-wrapper-bridge-adapter",
        "name": "GenericHttpAsyncRestAdapter.send",
        "signature": "send(session: Record<string, unknown>, input: { type: 'input'|'approval_resolution'; text?: string; bridgeCommandId?: string; idempotencyKey?: string; runtimeApprovalToken?: string; decision?: 'approved'|'rejected'; message?: string; answers?: Record<string, unknown> }) => Promise<void>"
      },
      {
        "from_task": "P24-T4-agentfield-wrapper-bridge-adapter",
        "name": "AgentFieldAsyncRestAdapter.send",
        "signature": "send(session: Record<string, unknown>, input: { type: 'input'|'approval_resolution'; text?: string; bridgeCommandId?: string; idempotencyKey?: string; runtimeApprovalToken?: string; decision?: 'approved'|'rejected'; message?: string; answers?: Record<string, unknown> }) => Promise<void>"
      },
      {
        "from_task": "P24-T5-core-bridge-admission-apply",
        "name": "HostedRuntimeBridgeService.createInputCommand",
        "signature": "createInputCommand({ runId, body, auth?, requestId?, idempotencyKey? }) => Promise<{ accepted: true; commandId: string; duplicate: boolean }>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "apps/worker/src/hosted-runtime-adapters.ts",
      "apps/worker/src/worker.ts",
      "apps/worker/src/config.ts"
    ]
  }
}
```

### Task P24-T8-debate-wrapper-runtime-matrix

```json
{
  "id": "P24-T8-debate-wrapper-runtime-matrix",
  "title": "Admit hosted wrapper debate participants under gates",
  "files": [
    "packages/core/src/services/debate-runtime-matrix.ts",
    "packages/core/src/services/debate-service.ts",
    "packages/core/test/debate-real-runtime.test.ts",
    "packages/core/test/debate-service.test.ts",
    "packages/protocol-rest/src/debate-routes.ts",
    "packages/protocol-rest/test/debate-routes.test.ts"
  ],
  "dependencies": [
    "P24-T2-catalog-provider-policy",
    "P24-T5-core-bridge-admission-apply",
    "P24-T6-server-rest-admission-readiness",
    "P24-T7-worker-wrapper-bridge-readiness"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md",
    "packages/core/src/services/debate-runtime-matrix.ts",
    "packages/core/src/services/debate-service.ts",
    "packages/core/test/debate-real-runtime.test.ts",
    "packages/protocol-rest/src/debate-routes.ts",
    "packages/protocol-rest/test/debate-routes.test.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts"
  ],
  "instructions": "Read Hosted Debate Contract, Orchestration, and Shadow-Path Requirements. Widen ALLOWED_DEBATE_RUNTIME_MODES to include agentfield.async_rest and generic_http.async_rest. Remove the stale classifyUnsupportedDebateRuntime special-case denial for those two modes only when runtimeMode and runtime/provider/adapterType match catalog. Keep codex.interactive, browser, repo, process, PTY, shell, sandbox, Cursor, OpenClaw, Paperclip, and unknown slugs denied. Wrapper participants must require realRuntimeOptIn true and placement hosted. Their runtime/provider/adapterType must match catalog: agentfield/agentfield/http and generic_http/generic_http/http. Debate service must continue creating normal child runs with debate metadata and no per-run wrapper URL/auth/target overrides. POST /debates?wait=1 must reject wrapper participants before debate, child run, queue, quota, or provider side effects. Hosted debate readiness must treat wrapper modes as bridge-required and provider/spend-gated.",
  "acceptance": [
    "normalizeDebateRuntime admits agentfield.async_rest and generic_http.async_rest only with realRuntimeOptIn true, placement hosted, and matching catalog fields.",
    "normalizeDebateRuntime keeps fake deterministic defaults and existing Codex/Claude/OpenCode behavior unchanged.",
    "codex.interactive, browser, repo, process, PTY, shell, sandbox, Cursor, OpenClaw, Paperclip, and unknown debate runtime modes remain denied with named codes.",
    "Wrapper debate participants create child runs with runtimeMode, runtime, provider, model, adapterType, placement, and debate metadata preserved.",
    "No per-run base URL, API key, target, headers, command, cwd override, argv, env, PTY, browser, repo, or sandbox metadata can be supplied through debate participants.",
    "POST /debates?wait=1 rejects wrapper participants before child-run creation and before provider dispatch.",
    "Missing/empty/overlarge/unowned wrapper output uses existing debate participant output failure codes.",
    "Hosted debate readiness/preflight requires wrapper bridge readiness when wrapper modes are allowlisted or requested."
  ],
  "checks": [
    "pnpm --filter @switchyard/core test -- debate-real-runtime debate-service",
    "pnpm --filter @switchyard/protocol-rest test -- debate-routes",
    "pnpm --filter @switchyard/core typecheck",
    "pnpm --filter @switchyard/protocol-rest typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "normalizeDebateRuntime",
      "failure": "wrapper participant omits realRuntimeOptIn true",
      "exception": "DebateRuntimeMatrixError debate_real_participant_opt_in_required",
      "rescue": "Reject before debate side effects.",
      "user_sees": "400 debate_real_participant_opt_in_required"
    },
    {
      "codepath": "normalizeDebateRuntime",
      "failure": "wrapper participant placement is missing, local, or connected_local_node",
      "exception": "DebateRuntimeMatrixError debate_participant_placement_required",
      "rescue": "Reject before child-run creation.",
      "user_sees": "400 debate_participant_placement_required"
    },
    {
      "codepath": "normalizeDebateRuntime",
      "failure": "runtime/provider/adapterType do not match wrapper catalog entry",
      "exception": "DebateRuntimeMatrixError debate_runtime_unsupported",
      "rescue": "Reject before provider side effects and do not infer arbitrary HTTP endpoints.",
      "user_sees": "409 debate_runtime_unsupported"
    },
    {
      "codepath": "POST /debates?wait=1",
      "failure": "wrapper participant requested in wait mode",
      "exception": "DebateServiceError debate_real_runtime_wait_unsupported or existing wait restriction code",
      "rescue": "Reject before quota reserve, debate create, child run create, queue enqueue, or provider dispatch.",
      "user_sees": "400 or 409 wait-mode denial"
    },
    {
      "codepath": "DebateService child output extraction",
      "failure": "wrapper child run completes with missing, blank, overlarge, wrong-debate, or wrong-child output",
      "exception": "DebateOutputError",
      "rescue": "Use existing debate_participant_output_missing, empty, too_large, or unowned codes and fail/advance debate according to existing R24 behavior.",
      "user_sees": "Debate fails or records participant output failure with named code"
    }
  ],
  "observability": {
    "logs": [
      "debate.participant.wrapper.admitted with debateId, participantRole, runtimeMode, no provider secrets",
      "debate.participant.wrapper.denied with reasonCode and participant path",
      "existing debate child-run and participant output logs include runtimeMode"
    ],
    "success_metric": "wrapper participants produce normal child runs and existing debate output extraction consumes runtime.output events",
    "failure_metric": "wrapper participant denial occurs before child-run creation or provider dispatch"
  },
  "test_cases": [
    {
      "name": "admits AgentField hosted debate participant",
      "lens": "happy",
      "given": "participant runtimeMode agentfield.async_rest, placement hosted, realRuntimeOptIn true, model agentfield-default",
      "expect": "normalizeDebateRuntime returns runtime agentfield, provider agentfield, adapterType http, isRealRuntime true"
    },
    {
      "name": "admits Generic HTTP hosted debate participant",
      "lens": "happy",
      "given": "participant runtimeMode generic_http.async_rest, placement hosted, realRuntimeOptIn true",
      "expect": "normalizeDebateRuntime returns runtime generic_http, provider generic_http, adapterType http"
    },
    {
      "name": "missing opt-in rejected",
      "lens": "happy_shadow_nil",
      "given": "agentfield.async_rest participant without realRuntimeOptIn",
      "expect": "debate_real_participant_opt_in_required"
    },
    {
      "name": "missing hosted placement rejected",
      "lens": "happy_shadow_empty",
      "given": "generic_http.async_rest participant with realRuntimeOptIn true and no placement",
      "expect": "debate_participant_placement_required"
    },
    {
      "name": "catalog mismatch rejected",
      "lens": "error_path",
      "given": "generic_http.async_rest participant with runtime agentfield or adapterType process",
      "expect": "debate_runtime_unsupported before side effects"
    },
    {
      "name": "unsafe runtime modes remain denied",
      "lens": "error_path",
      "given": "codex.interactive, browser.session, repo.checkout, process.exec, terminal, shell, sandbox, pty, cursor",
      "expect": "same unshipped/unsupported codes as R24 except wrapper modes are now admitted only under gates"
    },
    {
      "name": "wait mode rejects wrappers before child runs",
      "lens": "integration",
      "given": "POST /debates?wait=1 with Generic HTTP hosted participant",
      "expect": "non-2xx response, debate store and runService createRun spy not called"
    },
    {
      "name": "wrapper child run metadata preserved",
      "lens": "integration",
      "given": "async hosted debate with AgentField participant",
      "expect": "child run metadata contains debateChildRunKey, debateId, participantRole, runtimeMode agentfield.async_rest, placement hosted"
    },
    {
      "name": "wrapper output failure codes reused",
      "lens": "error_path",
      "given": "completed wrapper child run with blank runtime.output",
      "expect": "debate_participant_output_empty"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "normalizeDebateRuntime wrapper support",
        "kind": "function",
        "signature": "normalizeDebateRuntime(participant, index, options?) => DebateParticipantRuntimeConfig admitting wrapper modes only under hosted real opt-in gates"
      },
      {
        "name": "wrapper debate child run contract",
        "kind": "constant",
        "signature": "child run metadata includes debateChildRunKey and runtimeMode agentfield.async_rest|generic_http.async_rest with placement hosted"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P24-T2-catalog-provider-policy",
        "name": "HostedRuntimeModeSlug",
        "signature": "'fake.deterministic' | 'codex.exec_json' | 'claude_code.sdk' | 'opencode.acp' | 'agentfield.async_rest' | 'generic_http.async_rest'"
      },
      {
        "from_task": "P24-T6-server-rest-admission-readiness",
        "name": "server hostedRuntimeBridge readiness",
        "signature": "getServerRuntimeBridgeReadiness(deps) => { status: 'ready'|'not_ready'; checks: HostedRuntimeBridgeReadinessCheck[] }"
      },
      {
        "from_task": "P24-T7-worker-wrapper-bridge-readiness",
        "name": "getWorkerRuntimeBridgeReadiness wrapper checks",
        "signature": "getWorkerRuntimeBridgeReadiness({ commandStore, workerClaim, sessionReconciliation, approvalSender, adapterCapabilities }) => HostedRuntimeBridgeReadinessReport"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/services/debate-runtime-matrix.ts",
      "packages/core/src/services/debate-service.ts"
    ]
  }
}
```

### Task P24-T9-production-preflight-canary-gates

```json
{
  "id": "P24-T9-production-preflight-canary-gates",
  "title": "Extend production preflight and canary no-spend gates",
  "files": [
    "scripts/production-preflight.ts",
    "scripts/production-preflight.test.ts",
    "scripts/production-canary.ts",
    "scripts/production-canary.test.ts",
    "scripts/production-manifest.ts"
  ],
  "dependencies": [
    "P24-T2-catalog-provider-policy",
    "P24-T6-server-rest-admission-readiness",
    "P24-T7-worker-wrapper-bridge-readiness",
    "P24-T8-debate-wrapper-runtime-matrix"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md",
    "scripts/production-preflight.ts",
    "scripts/production-preflight.test.ts",
    "scripts/production-canary.ts",
    "scripts/production-canary.test.ts",
    "scripts/production-manifest.ts"
  ],
  "instructions": "Read Readiness, Preflight, And Canary. Update production preflight so bridgeRequired includes agentfield.async_rest and generic_http.async_rest. Default preflight remains no-spend. When wrapper modes are allowlisted, preflight must require hosted real runtime execution enabled, valid provider/wrapper policy, required wrapper env values redacted, bridge command/payload stores, queue, auth, quota, audit, worker readiness, adapter capability, wrapper_config, and wrapper_bridge_capability. It may call wrapper health/discovery no-spend probes, but must not create upstream executions unless an explicit live probe flag already exists or is introduced with spend confirmation. Update hosted debate readiness labels from R23 bridge to current hosted bridge while preserving compatibility. Production canary default remains fake hosted debate and reports live provider bridge probes as skipped. Change live provider bridge spend gating so --live-provider-bridges without --confirm-live-provider-spend fails before fetch/provider dispatch with provider_bridge_live_canary_spend_unconfirmed. Keep provider_bridge_live_canary_config_missing for missing runtime config after spend confirmation. If an optional no-spend fake wrapper canary is added, it must be explicitly marked fake/no-spend and not become default.",
  "acceptance": [
    "pnpm production:preflight remains fake/no-spend by default and marks wrapper bridge checks inactive when wrappers are not allowlisted.",
    "Preflight fails closed when agentfield.async_rest or generic_http.async_rest is allowlisted without hosted real runtime execution enabled.",
    "Preflight fails closed with wrapper config/capability reason when wrapper env or health/discovery bridge capability is missing.",
    "Preflight passes with fake/no-spend wrapper dependencies and valid bridge readiness diagnostics.",
    "Hosted debate preflight requires hosted bridge readiness when wrapper modes are allowlisted.",
    "pnpm production:canary remains fake hosted debate/no-spend by default and skips provider bridge probes by default.",
    "Live provider bridge canary requested without spend confirmation returns provider_bridge_live_canary_spend_unconfirmed before any fetch call.",
    "Live provider bridge canary with spend confirmation but missing live config returns provider_bridge_live_canary_config_missing without raw secrets.",
    "Manifest/runtime posture checks accept wrapper modes only as explicit operator allowlist entries and reject stale unknown modes."
  ],
  "checks": [
    "pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts",
    "pnpm typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "appendHostedRuntimeBridgeCheck",
      "failure": "wrapper mode allowlisted but hosted real runtime execution disabled",
      "exception": "preflight check status fail hosted_real_runtime_disabled",
      "rescue": "Fail preflight before dependency probes or provider dispatch.",
      "user_sees": "hostedRuntimeBridge fail hosted_real_runtime_disabled"
    },
    {
      "codepath": "appendHostedRuntimeBridgeCheck",
      "failure": "wrapper_config or wrapper_bridge_capability missing from readiness diagnostics",
      "exception": "preflight check status fail with wrapper reason",
      "rescue": "Fail bridge readiness with agentfield_bridge_config_missing, generic_http_bridge_config_missing, agentfield_bridge_capability_missing, or generic_http_bridge_capability_missing.",
      "user_sees": "Named wrapper readiness failure"
    },
    {
      "codepath": "runProductionCanary input.liveProviderBridges",
      "failure": "live provider bridge flag supplied without confirm-live-provider-spend or SWITCHYARD_CONFIRM_LIVE_PROVIDER_BRIDGE_CANARY=1",
      "exception": "early canary result ok=false code provider_bridge_live_canary_spend_unconfirmed",
      "rescue": "Return before creating FetchState or invoking fetchImpl.",
      "user_sees": "Canary refused before spend"
    },
    {
      "codepath": "runProductionCanary live provider bridge config",
      "failure": "spend confirmed but live wrapper runtime is not configured for canary",
      "exception": "canary result ok=false provider_bridge_live_canary_config_missing",
      "rescue": "Fail with config-missing code and redacted details.",
      "user_sees": "Canary reports missing live provider bridge config"
    },
    {
      "codepath": "production manifest runtime posture",
      "failure": "manifest allowlist contains unknown wrapper-like or unsafe runtime",
      "exception": "manifest validation fail",
      "rescue": "Reject manifest posture before config and dependency checks.",
      "user_sees": "Manifest/preflight names invalid runtime posture"
    }
  ],
  "observability": {
    "logs": [
      "production preflight check hostedRuntimeBridge diagnostics include bridgeModes and failedChecks",
      "production canary step input.liveProviderBridges fail provider_bridge_live_canary_spend_unconfirmed",
      "production canary providerBridges info provider_bridge_skipped_default by default"
    ],
    "success_metric": "default preflight/canary make no live wrapper execution calls and still pass fake hosted debate path",
    "failure_metric": "live provider bridge flag without confirmation returns before fetchImpl is called"
  },
  "test_cases": [
    {
      "name": "default preflight wrapper inactive",
      "lens": "happy_shadow_nil",
      "given": "fake-only server and worker configs",
      "expect": "hostedRuntimeBridge pass hosted_runtime_bridge_inactive and no wrapper health execution"
    },
    {
      "name": "preflight requires hosted real runtime for wrappers",
      "lens": "error_path",
      "given": "allowlist generic_http.async_rest and hostedRealRuntimeExecution disabled",
      "expect": "hostedRuntimeBridge fail hosted_real_runtime_disabled"
    },
    {
      "name": "preflight reports wrapper bridge capability missing",
      "lens": "error_path",
      "given": "readiness diagnostics wrapper_bridge_capability false generic_http_bridge_capability_missing",
      "expect": "hostedRuntimeBridge fail generic_http_bridge_capability_missing"
    },
    {
      "name": "preflight passes wrapper bridge ready",
      "lens": "happy",
      "given": "allowlist wrappers, activation valid, readiness checks all ok including wrapper_config and wrapper_bridge_capability",
      "expect": "hostedRuntimeBridge pass hosted_runtime_bridge_ready and hostedDebate bridge check ready"
    },
    {
      "name": "default canary skips provider bridge probes",
      "lens": "happy_shadow_nil",
      "given": "runProductionCanary without liveProviderBridges",
      "expect": "step providerBridges info provider_bridge_skipped_default and fake hosted debate still runs"
    },
    {
      "name": "live provider bridge canary spend unconfirmed",
      "lens": "error_path",
      "given": "runProductionCanary liveProviderBridges true without confirm and fetch spy",
      "expect": "provider_bridge_live_canary_spend_unconfirmed and fetch spy not called"
    },
    {
      "name": "live provider bridge canary config missing after confirmation",
      "lens": "error_path",
      "given": "liveProviderBridges true and confirmLiveProviderSpend true but no live wrapper config",
      "expect": "provider_bridge_live_canary_config_missing with redacted details"
    },
    {
      "name": "manifest accepts explicit wrapper posture",
      "lens": "integration",
      "given": "production manifest runtimeAllowlist includes fake.deterministic and agentfield.async_rest",
      "expect": "valid only when hosted real runtime and policy fields align"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "production preflight wrapper bridge gate",
        "kind": "function",
        "signature": "appendHostedRuntimeBridgeCheck(checks, { allowlist, hostedRealRuntimeExecution, serverAuthMode, hostedRuntimeGate }) includes wrapper modes"
      },
      {
        "name": "production canary bridge spend gate",
        "kind": "function",
        "signature": "runProductionCanary({ liveProviderBridges: true, confirmLiveProviderSpend?: boolean }) fails with provider_bridge_live_canary_spend_unconfirmed before fetch when unconfirmed"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P24-T6-server-rest-admission-readiness",
        "name": "server hostedRuntimeBridge readiness",
        "signature": "getServerRuntimeBridgeReadiness(deps) => { status: 'ready'|'not_ready'; checks: HostedRuntimeBridgeReadinessCheck[] }"
      },
      {
        "from_task": "P24-T7-worker-wrapper-bridge-readiness",
        "name": "checkConfiguredHostedAdapters wrapper statuses",
        "signature": "checkConfiguredHostedAdapters(config, deps?) => Promise<{ ok: boolean; modes: Record<HostedRuntimeModeSlug, { ok: boolean; code?: string }> }>"
      },
      {
        "from_task": "P24-T8-debate-wrapper-runtime-matrix",
        "name": "normalizeDebateRuntime wrapper support",
        "signature": "normalizeDebateRuntime(participant, index, options?) => DebateParticipantRuntimeConfig admitting wrapper modes only under hosted real opt-in gates"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "scripts/production-preflight.ts",
      "scripts/production-canary.ts"
    ]
  }
}
```

### Task P24-T10-product-operator-adapter-docs

```json
{
  "id": "P24-T10-product-operator-adapter-docs",
  "title": "Update product, operator, and adapter truth",
  "files": [
    "PRODUCT.md",
    "CHANGELOG.md",
    "docs/development/API.md",
    "docs/development/DEVELOPMENT.md",
    "docs/development/adapters/AGENTFIELD.md",
    "docs/development/adapters/GENERIC_HTTP.md",
    "docs/adapters/agentfield.md",
    "docs/adapters/generic-http.md"
  ],
  "dependencies": [
    "P24-T1-contracts-openapi-error-boundary",
    "P24-T2-catalog-provider-policy",
    "P24-T3-generic-http-wrapper-bridge-adapter",
    "P24-T4-agentfield-wrapper-bridge-adapter",
    "P24-T5-core-bridge-admission-apply",
    "P24-T6-server-rest-admission-readiness",
    "P24-T7-worker-wrapper-bridge-readiness",
    "P24-T8-debate-wrapper-runtime-matrix",
    "P24-T9-production-preflight-canary-gates"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-04-phase-24-r25-hosted-wrapper-runtime-bridges.md",
    "PRODUCT.md",
    "docs/development/API.md",
    "docs/development/DEVELOPMENT.md",
    "docs/development/adapters/AGENTFIELD.md",
    "docs/development/adapters/GENERIC_HTTP.md",
    "docs/adapters/agentfield.md"
  ],
  "instructions": "Update product truth after implementation, not before code tasks land. Replace R24 statements saying AgentField and Generic HTTP hosted bridges/debate bridges are unshipped with precise R25 truth: hosted runtime input and approval bridges for agentfield.async_rest and generic_http.async_rest ship only when wrapper bridge contracts, shared bridge stores, worker ownership, readiness, auth, quota, audit, and spend gates pass. Document both as conditional hosted wrapper modes disabled/no-spend by default and operator-configured only. Document hosted debate admission for wrapper modes only through existing /debates routes with realRuntimeOptIn true, placement hosted, matching catalog fields, and all gates passing. Update adapter docs with wrapper bridge endpoint contracts, capability discovery, failure codes, fake/no-spend smoke commands, and no per-run override boundary. Keep all non-goals explicit: no dashboard/TUI, no hosted codex.interactive, no Codex hosted input/approval bridge, no browser automation, no hosted repo execution, no generic process/PTY product adapters, no arbitrary public execution routes, no Cursor/OpenClaw/Paperclip, no managed SaaS/auth/billing expansion, and no public model judge route.",
  "acceptance": [
    "PRODUCT.md current state says R25 ships AgentField/Generic HTTP hosted wrapper bridges and opt-in hosted debate eligibility under gates.",
    "PRODUCT.md removes stale statements that AgentField and Generic HTTP hosted bridges or debate bridges remain unshipped, except historical phase notes that clearly say R23/R24 at the time.",
    "Development API docs list existing routes only and state no new public bridge/input/approval/session/execution/judge routes were added.",
    "Development operator docs describe no-spend default preflight/canary, wrapper bridge readiness failures, and explicit live spend confirmation command.",
    "AgentField docs describe discovery switchyard_bridge capability, input endpoint, approval poll/resolve contract, failure codes, and no per-run base URL/API key/target overrides.",
    "Generic HTTP docs describe /health capabilities, input endpoint, approval event/resolve contract, failure codes, and no arbitrary endpoint safety claim.",
    "Adapter summary docs state R25 shipped hosted wrapper bridges and hosted debate eligibility, while remaining non-goals stay explicit.",
    "Docs contain no secrets, real API keys, credential-bearing URLs, or claims of managed SaaS/dashboard/TUI/public judge support."
  ],
  "checks": [
    "rg -n \"AgentField and Generic HTTP hosted bridges remain unshipped|AgentField and Generic HTTP hosted debate bridges are not shipped|Generic HTTP hosted debate bridges are unshipped|AgentField hosted debate bridges are unshipped\" PRODUCT.md docs/development/API.md docs/development/DEVELOPMENT.md docs/development/adapters/AGENTFIELD.md docs/development/adapters/GENERIC_HTTP.md docs/adapters/agentfield.md docs/adapters/generic-http.md",
    "rg -n \"/runtime-bridge|/model-judge|/judging|dashboard|TUI|codex.interactive\" PRODUCT.md docs/development/API.md docs/development/DEVELOPMENT.md docs/development/adapters/AGENTFIELD.md docs/development/adapters/GENERIC_HTTP.md docs/adapters/agentfield.md docs/adapters/generic-http.md",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "PRODUCT.md truth update",
      "failure": "stale R24 unshipped statement remains in current product state",
      "exception": "doc truth grep failure",
      "rescue": "Replace with R25 conditional shipped wording and keep historical phase notes scoped by phase heading.",
      "user_sees": "Product docs accurately describe R25 shipped boundary"
    },
    {
      "codepath": "docs/development/API.md route docs",
      "failure": "docs imply a new public /runtime-bridge, /approval POST create, /session, /exec, /pty, /browser, /repo, /judge, or /model-judge route",
      "exception": "route-boundary doc review failure",
      "rescue": "Rewrite to say existing routes are reused and forbidden routes remain unshipped.",
      "user_sees": "No accidental public API overclaim"
    },
    {
      "codepath": "adapter docs",
      "failure": "docs imply arbitrary Generic HTTP endpoints, per-run URL override, or AgentField target override are safe",
      "exception": "adapter doc review failure",
      "rescue": "State operator-configured endpoints only and no per-run override boundary.",
      "user_sees": "Operators understand the wrapper mode is configured and gated"
    },
    {
      "codepath": "operator docs",
      "failure": "live canary instructions omit spend confirmation",
      "exception": "doc command review failure",
      "rescue": "Include SWITCHYARD_CONFIRM_LIVE_PROVIDER_BRIDGE_CANARY=1 and --confirm-live-provider-spend in live example, plus no-spend default command.",
      "user_sees": "Live spend cannot be triggered by following incomplete docs"
    }
  ],
  "observability": {
    "logs": [],
    "success_metric": "docs truth grep finds no stale current-state unshipped claims for wrapper bridges and explicit non-goals remain present",
    "failure_metric": "docs overclaim forbidden public routes, managed SaaS, dashboard/TUI, hosted codex.interactive, or arbitrary execution"
  },
  "test_cases": [
    {
      "name": "product truth current state updated",
      "lens": "happy",
      "given": "PRODUCT.md current product state",
      "expect": "mentions R25 hosted wrapper bridges and wrapper debate eligibility under gates"
    },
    {
      "name": "stale current unshipped claims removed",
      "lens": "happy_shadow_empty",
      "given": "grep stale unshipped phrases outside historical R23/R24 sections",
      "expect": "no matches in current-state or adapter current docs"
    },
    {
      "name": "public route boundary documented",
      "lens": "integration",
      "given": "docs/development/API.md",
      "expect": "lists existing /runs/:id/input, /approvals routes, /debates routes; states no new public bridge/session/execution/judge routes"
    },
    {
      "name": "AgentField bridge docs cover capability discovery",
      "lens": "happy",
      "given": "docs/development/adapters/AGENTFIELD.md",
      "expect": "documents switchyard_bridge input/approval_request/approval_resolution and fail-closed capability code"
    },
    {
      "name": "Generic HTTP bridge docs cover health capabilities",
      "lens": "happy",
      "given": "docs/development/adapters/GENERIC_HTTP.md",
      "expect": "documents health capabilities input, approval_request, approval_resolution and resolve endpoint"
    },
    {
      "name": "live canary docs require spend confirmation",
      "lens": "edge_no_spend",
      "given": "docs/development/DEVELOPMENT.md production canary section",
      "expect": "default no-spend command first, live wrapper command includes env confirmation and --confirm-live-provider-spend"
    },
    {
      "name": "non-goals remain explicit",
      "lens": "integration",
      "given": "PRODUCT.md and development docs",
      "expect": "dashboard/TUI, hosted codex.interactive, Codex hosted bridge, browser, repo, process/PTY, public arbitrary routes, Cursor/OpenClaw/Paperclip, managed SaaS, public model judge all remain unshipped"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "R25 product truth",
        "kind": "constant",
        "signature": "PRODUCT.md and docs describe conditional hosted wrapper bridges and wrapper debate eligibility under gates"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P24-T9-production-preflight-canary-gates",
        "name": "production canary bridge spend gate",
        "signature": "runProductionCanary({ liveProviderBridges: true, confirmLiveProviderSpend?: boolean }) fails with provider_bridge_live_canary_spend_unconfirmed before fetch when unconfirmed"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "PRODUCT.md",
      "docs/development/API.md",
      "docs/development/DEVELOPMENT.md",
      "docs/development/adapters/AGENTFIELD.md",
      "docs/development/adapters/GENERIC_HTTP.md"
    ]
  }
}
```

## Integration Points

- T1 publishes the closed bridge mode/error/readiness vocabulary. T2 consumes it in hosted catalog and provider policy. T3 and T4 consume both to map adapter failures to known codes.
- T3 and T4 define the adapter-level `send()` contract. T5 relies on that contract by dispatching typed `input` and `approval_resolution` payloads through `RuntimeRunnerService.sendInput()`.
- T5 keeps durable bridge admission/apply semantics centralized. T6 calls only `createInputCommand()` and `resolveRuntimeApproval()` through existing REST routes. T7 constructs adapters and runs `claimAndApplyNext()` through the existing worker bridge loop.
- T8 depends on T2/T6/T7 so debate participant admission matches the hosted catalog and preflight/readiness gates.
- T9 reads server/worker readiness diagnostics from T6/T7 and debate runtime behavior from T8. T10 documents only what all prior tasks ship.

Contract walk:

- `P24-T3 GenericHttpAsyncRestAdapter.send` is imported by T5 and T7 with the same `send(session, input) => Promise<void>` signature.
- `P24-T4 AgentFieldAsyncRestAdapter.send` is imported by T5 and T7 with the same `send(session, input) => Promise<void>` signature.
- `P24-T5 HostedRuntimeBridgeService.createInputCommand` and `resolveRuntimeApproval` are imported by T6 with matching result shapes.
- `P24-T6 getServerRuntimeBridgeReadiness` and `P24-T7 getWorkerRuntimeBridgeReadiness` are imported by T8/T9 as readiness reports using `HostedRuntimeBridgeReadinessCheck[]`.
- `P24-T2 HostedRuntimeModeSlug` is imported by T3/T4/T7/T8 and includes the same six-mode union throughout.

## Phase-Level Acceptance Criteria

- [ ] `agentfield.async_rest` and `generic_http.async_rest` are known conditional hosted runtime modes with explicit hosted catalog entries and no per-run endpoint overrides.
- [ ] Hosted input for active AgentField/Generic HTTP runs is admitted through `POST /runs/:id/input`, persisted through existing hosted bridge stores, applied by the owning worker, and observable through existing run/events APIs.
- [ ] Hosted runtime approvals for AgentField/Generic HTTP are created from wrapper polling/events, owned by the caller's tenant/project, resolvable through existing approval endpoints, and applied by the owning worker through wrapper resolution endpoints.
- [ ] Hosted debate accepts AgentField/Generic HTTP participants only with explicit real-runtime opt-in, hosted placement, matching catalog fields, and all wrapper/readiness/spend gates passing.
- [ ] Fake/no-spend remains the default for required tests, smoke, preflight, and canary.
- [ ] Live wrapper/provider canary requires explicit spend confirmation and fails before provider dispatch without it.
- [ ] Endpoint inventory and OpenAPI prove no new public execution, bridge, browser, repo, PTY, terminal, dashboard/TUI, or public judge routes were added.
- [ ] Product truth lists what R25 shipped and what remains unshipped.

## Plan-Level Verification Commands

Run these after all task branches are integrated:

```bash
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/server test
pnpm --filter @switchyard/worker test
pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

## Risks

- Cross-package blast radius is high. Mitigation: ten disjoint tasks, no new bridge storage, no new public routes, and all wrapper behavior behind existing catalog/policy/readiness gates.
- Provider policy schema changes can accidentally make command-style fields required for HTTP wrappers. Mitigation: T2 explicitly rejects command-style wrapper policy fields and tests wrapper activation without executablePath/fixedArgs/cwdPrefixes.
- Adapter `send()` overload could confuse input and approval-resolution payloads. Mitigation: T3/T4/T5 lock `type: 'input' | 'approval_resolution'` dispatch contracts and test malformed/missing fields before upstream dispatch.
- Debate widening could admit wrappers without bridge readiness. Mitigation: T8 only widens matrix; T6/T7/T9 require bridge readiness and provider/spend gates before hosted wrapper debate is ready.
- Docs can overclaim arbitrary Generic HTTP safety. Mitigation: T10 requires operator-configured wrapper endpoints only and no per-run overrides in every adapter doc.

## Architect Review Checklist / Gates

1. **Ground truth gate:** Every task context file exists and anchors a real implementation seam.
2. **Scope gate:** No task adds dashboard/TUI, public arbitrary execution route, public model judge route, hosted `codex.interactive`, browser/repo/generic process/generic PTY adapter, managed SaaS/auth/billing expansion, or per-run wrapper endpoint override.
3. **Route boundary gate:** T1/T6 prove no forbidden public route appears in route inventory, OpenAPI, or app route tests.
4. **No-spend gate:** T3/T4 fake servers, T7 adapter checks, and T9 preflight/canary default paths create no live provider executions.
5. **Fail-closed gate:** Missing stores, queue, ownership, quota, audit, route auth, worker claim, wrapper config, wrapper capability, provider activation, and spend confirmation all produce named denials before provider dispatch.
6. **Auth/ownership gate:** Server route tests prove run and approval ownership denial happens before existence/capability probing.
7. **Durability gate:** R25 reuses existing hosted bridge command/payload stores; command payload hash, idempotency mismatch, stale claim recovery, quota finalization, and payload deletion are tested for wrapper modes.
8. **Adapter contract gate:** Generic HTTP and AgentField both support input and approval resolution through configured upstream endpoints only, and both emit valid approval.requested events or named invalid approval failures.
9. **Debate gate:** Wrapper participants require realRuntimeOptIn, hosted placement, matching catalog fields, bridge readiness, provider/spend gates, and `wait=1` denial before child-run creation.
10. **Observability gate:** New logs and metrics are low-cardinality and redacted; no raw text, tokens, API keys, Authorization headers, credential-bearing URLs, command strings, argv, cwd overrides, env values, or provider response bodies are emitted.
11. **Docs truth gate:** Product/operator/adapter docs describe R25 shipped boundaries and list all preserved non-goals.

## CTO Self-Review

1. **Spec coverage:** Pass. Each phase acceptance item maps to T1-T10 and the phase-level checklist.
2. **Placeholder scan:** Pass. No placeholder markers or unspecified edge handling is used.
3. **Type consistency:** Pass. Cross-task exports/imports use matching signatures.
4. **Ownership disjoint:** Pass. No task owns the same file as another task.
5. **Context files real:** Pass. Context files were selected from existing worktree paths.
6. **Acceptance testable:** Pass. Every acceptance item names verifiable behavior or command output.
7. **Dependency order sane:** Pass. Contracts/catalog land before adapters, core, server/worker, debate, ops, and docs.
8. **Checks runnable:** Pass. Commands use existing pnpm package filters and script tests.
9. **Error/rescue maps present:** Pass. Every runtime-behavior task has named failure modes and user-visible outcomes.
10. **Observability present:** Pass. Runtime tasks include logs and success/failure metrics; docs-only task has empty logs and doc truth metrics.
11. **Test cases enumerate acceptance:** Pass. Happy, nil, empty, error, edge, and integration paths are enumerated per task.
12. **Integration contracts walk:** Pass. Every `imports_from_other_tasks` entry resolves to an export in another task.
13. **Contract types match:** Pass. Adapter `send()`, bridge service, readiness, and catalog/provider mode signatures are consistent.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test_case.
- [x] Every error_rescue_map entry has a matching test_case with `lens: error_path`, `happy_shadow_nil`, `happy_shadow_empty`, or an explicit edge lens.
- [x] Every integration_contracts.imports_from_other_tasks resolves to a real export elsewhere in this plan.
- [x] Every context_files path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is present.
- [x] Complexity is L and was split into ten disjoint tasks; no XL re-split is needed because the spec is a single bridge release and no task introduces a parallel subsystem.
