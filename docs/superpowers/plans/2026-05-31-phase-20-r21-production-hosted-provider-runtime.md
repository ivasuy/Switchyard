# Phase 20: R21 Production Hosted Provider Runtime Activation — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-31-phase-20-r21-production-hosted-provider-runtime.md`
**Branch:** `agent/phase-20-r21-production-hosted-provider-runtime`
**Base/spec commit:** `9d984edf55e33346a473a83fe5049aa8f7bf4a45`
**Complexity:** L

## Goal

Ship production-safe hosted runtime activation for the closed known provider set `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`, while keeping production fake-only by default and preserving a fail-closed boundary against request-owned executable, cwd, env, argv, process, PTY, terminal, browser, search, GitHub, fetch, repo, dashboard, TUI, and public command surfaces.

## Scope Challenge

1. Existing code already solves the closed runtime catalog, hosted run admission flow, R18 entitlement and quota checks, R19 production preflight/readiness/canary structure, R20 worker sandbox policy substrate, provider adapters, adapter redaction, OpenAPI route drift tests, and deployment manifest checks. This plan extends those surfaces instead of adding a parallel runtime system.
2. The minimum shippable change is a provider policy contract, core activation gates, provider-specific adapter command handoff, server/worker config wiring, worker claim revalidation, server admission side-effect ordering, ops preflight/smoke/canary coverage, and product truth updates. Dashboard/TUI work, generic process/PTY adapters, hosted tools, hosted debate real participants, model judging, and new providers stay out of scope.
3. The phase necessarily touches more than eight files because the production gate spans contracts, core, adapters, worker, server, scripts, deploy artifacts, and docs. The risk is controlled by eight disjoint implementer tasks with explicit dependency order and file ownership. No task owns a file owned by another task.
4. Built-ins and existing dependencies are sufficient: Zod for schemas, Node `path` and `fs` for policy path loading, existing Fastify readiness/preflight patterns, existing runtime adapter interfaces, existing safe logger redaction, existing Vitest packages, and existing OpenAPI inventory tests. No new runtime dependency is planned.
5. Distribution impact is limited to existing packages and deployment artifacts. No new package, binary, container, public route, or public API artifact is introduced. New scripts are wired through `package.json` only when they are deterministic by default or explicitly spend-gated for live provider canary execution.

## Architecture

R21 is an opt-in policy gate layered on top of the R19/R20 hosted production stack. The policy source is operator-owned config, either `SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON` or `SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH`. Exactly one policy source is allowed when production real runtime activation is enabled; using both fails closed with `provider_runtime_policy_malformed`. The parsed policy maps known runtime modes to provider-specific immutable command policy, cwd prefixes, env allowlist, required env names, permission posture, disabled hosted tool settings, and spend controls. Credential values are never stored in the policy; the policy names required environment variables and the runtime checks presence.

Production startup and readiness become conditional rather than fake-only. `SWITCHYARD_DEPLOYMENT_MODE=production`, `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`, a closed allowlist containing only `fake.deterministic` plus an explicit subset of the three known provider modes, a valid policy for every real mode, present required env vars, and valid spend controls are all required. Any unknown mode, disabled policy entry, malformed policy, missing credential, missing spend limit, invalid command policy, or provider binary problem fails before adapter start. Default production with no explicit real-runtime gate remains fake-only.

The server uses the same policy resolver for admission and readiness, but never constructs provider processes. Hosted real run creation performs cheap hosted-real preflight before durable side effects where possible: explicit hosted placement, `wait=1` denial, known-mode allowlist, gate, provider policy activation, prompt size spend control, and entitlement/quota checks. The worker repeats the same activation checks at claim time so rollback to fake-only after queueing causes queued real-provider jobs to fail closed before adapter invocation.

Provider adapters receive a resolved provider command object, not request-owned process data. Codex remains one-shot exec-json with read-only sandbox policy. Claude Code runs read-only with `Bash`, `WebFetch`, and `WebSearch` disabled and with hosted approval/input bridges unsupported. OpenCode ACP remains one-prompt-per-run with no hosted terminal, input, or approval bridge. Tests stay deterministic and no-spend by default; live provider canary execution requires an explicit runtime mode, policy, provider credentials, spend controls, and `--confirm-provider-spend`.

```
operator env/policy
  │
  ▼
contracts schema ──▶ core activation resolver ──▶ server config/readiness
  │                         │                           │
  │                         │                           ▼
  │                         │                  hosted run preflight
  │                         │                           │
  ▼                         ▼                           ▼
worker config/readiness ─▶ worker claim revalidation ─▶ provider adapter
                                  │                         │
                                  ▼                         ▼
                         fail closed before start      events/artifacts
```

## File Structure

- `packages/contracts/src/provider-runtime-policy.ts` — closed Zod schema, failure code schema, provider policy types, and resolved command contract for known provider runtime activation.
- `packages/contracts/src/index.ts` — exports the new provider policy contract.
- `packages/contracts/test/provider-runtime-policy.contract.test.ts` — deterministic schema coverage for valid and invalid provider policies.
- `packages/core/src/services/provider-runtime-policy.ts` — pure core resolver for policy source, activation checks, spend checks, and provider command resolution.
- `packages/core/src/services/hosted-runtime-catalog.ts` — changes production real modes from blanket-forbidden to policy-conditional.
- `packages/core/src/services/production-config-guards.ts` — replaces fake-only production allowlist validation with provider-aware production validation.
- `packages/core/src/index.ts` — exports the core provider policy resolver.
- `packages/core/test/provider-runtime-policy.test.ts` — activation, credential, spend, and command resolution tests.
- `packages/core/test/hosted-runtime-catalog.test.ts` — catalog production allow/deny regression tests.
- `packages/core/test/production-config-guards.test.ts` — production config validation regression tests.
- `packages/adapters/src/codex/codex-exec-json-adapter.ts` and `packages/adapters/src/codex/types.ts` — Codex hosted provider command handoff and read-only enforcement.
- `packages/adapters/src/claude-code/claude-code-cli-client.ts`, `packages/adapters/src/claude-code/claude-code-adapter.ts`, and `packages/adapters/src/claude-code/types.ts` — Claude Code hosted provider command handoff, env filtering, read-only permission mode, and unsupported bridge behavior.
- `packages/adapters/src/opencode/opencode-acp-adapter.ts` and `packages/adapters/src/opencode/types.ts` — OpenCode ACP hosted provider command handoff and unsupported approval/input behavior.
- `packages/adapters/src/index.ts` — adapter type exports required by worker wiring.
- `apps/worker/src/config.ts` — parses production provider policy config and enforces worker startup gates.
- `apps/worker/src/hosted-runtime-adapters.ts` — builds production real provider adapters only after provider activation succeeds.
- `apps/worker/src/worker.ts` — readiness and claim gate wiring.
- `packages/core/src/services/hosted-worker-service.ts` — claim-time provider policy and spend revalidation before adapter start.
- `apps/server/src/config.ts` — parses production provider policy config and enforces server startup gates.
- `apps/server/src/readiness.ts` — redacted provider activation readiness diagnostics.
- `apps/server/src/app.ts`, `packages/core/src/services/hosted-run-service.ts`, and `packages/protocol-rest/src/run-routes.ts` — hosted real admission gates, side-effect ordering, and unsupported bridge reason codes.
- `scripts/production-preflight.ts`, `scripts/hosted-real-runtime-smoke.ts`, `scripts/production-canary.ts`, `scripts/production-manifest.ts`, `package.json`, and `deploy/production/*` — production operator checks, no-spend smoke, explicit live canary, and manifest/env docs.
- `packages/contracts/src/openapi.contract.test.ts`, `packages/contracts/src/endpoint-inventory.drift.test.ts`, generated OpenAPI JSON, `PRODUCT.md`, `README.md`, and `docs/development/*` — public surface guardrails and product truth.

## Existing Context

`packages/core/src/services/hosted-runtime-catalog.ts` already defines the exact known provider set. R21 must not expand this set:

```ts
export type HostedRuntimeModeSlug = "fake.deterministic" | "codex.exec_json" | "claude_code.sdk" | "opencode.acp";
```

The same catalog currently marks real modes as production-forbidden. R21 changes this to production-conditional, not production-open:

```ts
hostedSupport: "conditional",
requiresRealRuntimeGate: true,
productionAllowed: false,
```

`apps/server/src/config.ts` and `apps/worker/src/config.ts` currently reject production real runtime activation:

```ts
if (config.deploymentMode === "production") {
  enforceProductionValidation(validateProductionFakeOnlyAllowlist(config.hostedRuntimeAllowlist), config);
  if (config.hostedRealRuntimeExecution !== "disabled") {
    throw new ConfigError("config_forbidden:SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION", ...);
  }
}
```

`apps/worker/src/hosted-runtime-adapters.ts` has the adapter construction path but blocks real modes in production:

```ts
if (config.deploymentMode === "production") {
  return false;
}
```

`packages/contracts/src/sandbox.ts` intentionally denylists provider executables for generic sandbox command policies:

```ts
export const SANDBOX_REAL_COMMAND_DENYLIST = [
  "sh",
  "bash",
  "zsh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "go",
  "cargo",
  "npm",
  "pnpm",
  "yarn",
  "codex",
  "claude",
  "opencode"
];
```

`packages/protocol-rest/src/run-routes.ts` currently parses run creation before hosted service preflight. R21 must ensure hosted real mode denials that can be decided before durable side effects happen before quota reservation and run persistence:

```ts
const preflight = await deps.controlPlane.preflightRunCreate(preflightInput);
```

`scripts/production-preflight.ts`, `scripts/production-canary.ts`, and `deploy/production/manifest.json` are the R19/R20 operator verification anchors. R21 extends those anchors; it does not replace them with live-spend defaults.

## Task Graph

### P20-T1-provider-policy-contracts

```json
{
  "id": "P20-T1-provider-policy-contracts",
  "title": "Add closed provider runtime policy contracts",
  "files": [
    "packages/contracts/src/provider-runtime-policy.ts",
    "packages/contracts/src/index.ts",
    "packages/contracts/test/provider-runtime-policy.contract.test.ts"
  ],
  "dependencies": [],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-20-r21-production-hosted-provider-runtime.md",
    "packages/contracts/src/sandbox.ts",
    "packages/contracts/src/enterprise.ts",
    "packages/contracts/src/index.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts"
  ],
  "instructions": "Create a new contract module for R21 provider runtime activation. Define a closed provider runtime mode schema with exactly codex.exec_json, claude_code.sdk, and opencode.acp. Define providerRuntimePolicySchema for a JSON object { version: 1, modes: Record<known real mode, entry> } with strict object validation so unknown mode keys fail with provider_runtime_policy_unknown_mode. Each entry must include enabled, executablePath, cwdPrefixes, envAllowlist, requiredEnv, fixedArgs where applicable, allowUserArgs fixed false, spendControls, and provider-specific permission fields. Codex fixedArgs must be exactly ['exec','--json'] and sandbox must be read_only. Claude permissionMode must be read_only and disabledTools must include Bash, WebFetch, and WebSearch. OpenCode fixedArgs must be exactly ['acp'] and onePromptPerRun must be true. Credentials must be represented only as required env var names, never raw secret values. Add a providerResolvedCommandSchema for worker-owned adapter handoff with runtimeMode, executablePath, argv, cwd, env, envKeys, allowUserArgs false, and redactedSummary. Add a providerRuntimeFailureCodeSchema covering every named code in the R21 spec. Export inferred types through packages/contracts/src/index.ts. Do not modify the generic sandbox contract or remove the R20 provider executable denylist.",
  "acceptance": [
    "Valid policies parse for codex.exec_json, claude_code.sdk, and opencode.acp with provider-specific required fields.",
    "Unknown provider mode keys, fake.deterministic entries, Cursor/OpenClaw/Paperclip entries, and generic process/PTY entries are rejected.",
    "Entries with allowUserArgs true, relative executablePath, empty cwdPrefixes, relative cwdPrefixes, invalid env var names, missing spendControls, or raw credential-like fields are rejected.",
    "Codex policy rejects non-read-only sandbox values or fixedArgs other than ['exec','--json'].",
    "Claude policy rejects permissionMode values other than read_only and rejects missing Bash, WebFetch, or WebSearch disabled tools.",
    "OpenCode policy rejects fixedArgs other than ['acp'] and rejects onePromptPerRun false.",
    "The new failure code schema accepts all R21 named provider codes and rejects unknown provider codes.",
    "The contract index exports every schema and type needed by core, adapters, worker, server, and scripts."
  ],
  "checks": [
    "pnpm --filter @switchyard/contracts test -- provider-runtime-policy.contract.test.ts",
    "pnpm --filter @switchyard/contracts typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "providerRuntimePolicySchema.parse",
      "failure": "policy is missing, empty, malformed, or contains unknown mode keys",
      "exception": "ZodError",
      "rescue": "Reject before core config can mark provider runtime activation ready.",
      "user_sees": "provider_runtime_policy_missing, provider_runtime_policy_empty, provider_runtime_policy_malformed, or provider_runtime_policy_unknown_mode."
    },
    {
      "codepath": "providerRuntimeModePolicySchema.parse",
      "failure": "entry enables request-owned args, invalid executable, invalid cwd prefix, invalid env name, raw secret field, or missing spend controls",
      "exception": "ZodError",
      "rescue": "Reject the entry as invalid command policy.",
      "user_sees": "provider_command_policy_invalid or provider_spend_controls_missing."
    },
    {
      "codepath": "providerRuntimeFailureCodeSchema.parse",
      "failure": "unregistered provider failure code is used",
      "exception": "ZodError",
      "rescue": "Fail tests so runtime code cannot emit high-cardinality unknown provider codes.",
      "user_sees": "test failure before release."
    }
  ],
  "observability": {
    "logs": [],
    "success_metric": "Contract tests prove valid known provider policies parse and invalid modes/process shapes fail.",
    "failure_metric": "Zod rejects malformed or out-of-scope provider policy shapes before runtime activation."
  },
  "test_cases": [
    {
      "name": "parses valid codex policy",
      "lens": "happy",
      "given": "A version 1 policy with codex.exec_json enabled, executablePath /opt/switchyard/bin/codex, cwdPrefixes ['/srv/switchyard/work'], requiredEnv ['OPENAI_API_KEY'], fixedArgs ['exec','--json'], sandbox read_only, allowUserArgs false, and complete spendControls",
      "expect": "providerRuntimePolicySchema parses and returns a typed codex entry."
    },
    {
      "name": "parses valid claude policy",
      "lens": "happy",
      "given": "A claude_code.sdk entry with read_only permissionMode and disabledTools containing Bash, WebFetch, and WebSearch",
      "expect": "providerRuntimePolicySchema parses."
    },
    {
      "name": "parses valid opencode policy",
      "lens": "happy",
      "given": "An opencode.acp entry with fixedArgs ['acp'] and onePromptPerRun true",
      "expect": "providerRuntimePolicySchema parses."
    },
    {
      "name": "rejects empty or unknown policy",
      "lens": "happy_shadow_empty",
      "given": "A policy with no modes, fake.deterministic, cursor.sdk, opencode.shell, or a generic process adapter key",
      "expect": "ZodError maps to provider_runtime_policy_empty or provider_runtime_policy_unknown_mode."
    },
    {
      "name": "rejects command policy escape hatches",
      "lens": "error_path",
      "given": "An entry with allowUserArgs true, relative executablePath, blank cwdPrefixes, relative cwd prefix, env name containing '=', or a credential value field",
      "expect": "ZodError maps to provider_command_policy_invalid."
    },
    {
      "name": "rejects provider-specific unsafe settings",
      "lens": "error_path",
      "given": "Codex sandbox workspace-write, Claude missing Bash disabled tool, or OpenCode onePromptPerRun false",
      "expect": "ZodError."
    },
    {
      "name": "validates provider failure codes",
      "lens": "happy",
      "given": "Every named provider code from the R21 spec",
      "expect": "providerRuntimeFailureCodeSchema parses each code and rejects made_up_provider_code."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "providerRuntimeModeSchema",
        "kind": "constant",
        "signature": "z.enum(['codex.exec_json','claude_code.sdk','opencode.acp'])"
      },
      {
        "name": "providerRuntimePolicySchema",
        "kind": "constant",
        "signature": "Zod schema for versioned strict provider runtime policy"
      },
      {
        "name": "providerRuntimeFailureCodeSchema",
        "kind": "constant",
        "signature": "Zod schema for R21 provider failure codes"
      },
      {
        "name": "providerResolvedCommandSchema",
        "kind": "constant",
        "signature": "Zod schema for worker-owned provider command handoff"
      },
      {
        "name": "ProviderRuntimePolicy",
        "kind": "type",
        "signature": "z.infer<typeof providerRuntimePolicySchema>"
      },
      {
        "name": "ProviderRuntimeMode",
        "kind": "type",
        "signature": "z.infer<typeof providerRuntimeModeSchema>"
      },
      {
        "name": "ProviderResolvedCommand",
        "kind": "type",
        "signature": "z.infer<typeof providerResolvedCommandSchema>"
      },
      {
        "name": "ProviderRuntimeFailureCode",
        "kind": "type",
        "signature": "z.infer<typeof providerRuntimeFailureCodeSchema>"
      }
    ],
    "imports_from_other_tasks": [],
    "file_paths_consumed_by_other_tasks": [
      "packages/contracts/src/provider-runtime-policy.ts",
      "packages/contracts/src/index.ts"
    ]
  }
}
```

### P20-T2-core-policy-catalog-gates

```json
{
  "id": "P20-T2-core-policy-catalog-gates",
  "title": "Implement core provider activation policy gates",
  "files": [
    "packages/core/src/services/provider-runtime-policy.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts",
    "packages/core/src/services/production-config-guards.ts",
    "packages/core/src/index.ts",
    "packages/core/test/provider-runtime-policy.test.ts",
    "packages/core/test/hosted-runtime-catalog.test.ts",
    "packages/core/test/production-config-guards.test.ts"
  ],
  "dependencies": [
    "P20-T1-provider-policy-contracts"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-20-r21-production-hosted-provider-runtime.md",
    "packages/contracts/src/index.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts",
    "packages/core/src/services/production-config-guards.ts",
    "packages/core/test/hosted-runtime-catalog.test.ts",
    "packages/core/test/production-config-guards.test.ts",
    "packages/contracts/src/sandbox.ts"
  ],
  "instructions": "Add a pure core provider runtime policy service. It should parse policy content supplied by callers, not read process env directly except through explicit input maps. Define ProviderRuntimePolicyResolutionInput with deploymentMode, hostedRealRuntimeExecution, hostedRuntimeAllowlist, policyJson, policyPathContents, env, and binaryProbe callback. Enforce that production real activation requires exactly one policy source, closed real mode allowlist, provider policy entry enabled for every real mode, required env presence, spend controls, and command policy validity. If real modes are absent, production fake-only remains valid with no policy. Update hosted-runtime-catalog so known real modes are production conditional: productionAllowed should become true only through activation result, while unknown modes remain denied. Replace validateProductionFakeOnlyAllowlist with provider-aware validation that preserves fake-only default and rejects production real runtime gate when provider activation is incomplete. Build provider resolved commands without using the generic R20 sandbox command schema because that schema intentionally denylists provider binaries; do not weaken the sandbox denylist. Export resolveProviderRuntimePolicy, validateProviderRuntimeActivation, buildProviderResolvedCommand, checkProviderSpendControlsForRun, and ProviderRuntimeActivationResult from core index.",
  "acceptance": [
    "Production fake-only config with no policy remains valid.",
    "Production with SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION disabled rejects any real hosted runtime allowlist entry.",
    "Production with the real-runtime gate enabled rejects missing policy, both policy sources set, empty policy, malformed policy, unknown runtime mode, disabled policy entry, missing required env, invalid spend controls, and invalid command policy.",
    "Production with gate enabled, closed allowlist, valid policy, required env, and passing binaryProbe allows exactly the selected known real modes.",
    "Unknown hosted runtime mode strings still fail closed before policy lookup.",
    "Staging and test behavior for R15 real runtime activation remains compatible except for stronger policy validation when a production policy is explicitly supplied.",
    "Provider spend checks reject prompt bytes over maxPromptBytes and active/hourly counters over configured limits.",
    "All diagnostics are code-first and redact executablePath, cwd, env values, prompt text, stdout, stderr, artifact object keys, and raw policy JSON."
  ],
  "checks": [
    "pnpm --filter @switchyard/core test -- provider-runtime-policy.test.ts hosted-runtime-catalog.test.ts production-config-guards.test.ts",
    "pnpm --filter @switchyard/core typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "resolveProviderRuntimePolicy",
      "failure": "both JSON and path policy sources are present",
      "exception": "explicit conflict branch",
      "rescue": "Return invalid activation with provider_runtime_policy_malformed and redacted source summary.",
      "user_sees": "config/preflight/readiness failure; no provider process starts."
    },
    {
      "codepath": "resolveProviderRuntimePolicy",
      "failure": "policy source missing or empty while production real mode is allowlisted",
      "exception": "explicit missing branch",
      "rescue": "Return invalid activation with provider_runtime_policy_missing or provider_runtime_policy_empty.",
      "user_sees": "startup or preflight failure with named provider code."
    },
    {
      "codepath": "validateProviderRuntimeActivation",
      "failure": "unknown mode, disabled policy entry, missing required env, invalid spend controls, binary probe unavailable",
      "exception": "explicit validation branch",
      "rescue": "Return failed activation and list redacted per-mode reasons.",
      "user_sees": "provider_runtime_policy_unknown_mode, provider_runtime_policy_disabled, provider_credentials_missing, provider_spend_controls_invalid, or provider_binary_unavailable."
    },
    {
      "codepath": "buildProviderResolvedCommand",
      "failure": "requested cwd outside cwdPrefixes, request tries command/env/argv injection, or required env absent",
      "exception": "explicit policy denial branch",
      "rescue": "Deny before adapter invocation.",
      "user_sees": "provider_command_denied or provider_credentials_missing."
    },
    {
      "codepath": "checkProviderSpendControlsForRun",
      "failure": "prompt too large, active run limit exceeded, hourly run limit exceeded, or timeout exceeds maximum",
      "exception": "explicit spend branch",
      "rescue": "Deny before durable side effects when called by server and before adapter start when called by worker.",
      "user_sees": "provider_prompt_too_large or provider_spend_limit_exceeded."
    }
  ],
  "observability": {
    "logs": [
      "info provider_runtime_policy_resolved with deploymentMode, enabledModes count, policySource kind, and redacted mode statuses",
      "warn provider_runtime_activation_denied with low-cardinality reason code and runtimeMode",
      "info provider_runtime_spend_check_passed with runtimeMode and limit names only"
    ],
    "success_metric": "provider_runtime_activation_ready{runtime_mode} increments for valid known provider modes.",
    "failure_metric": "provider_runtime_activation_denied{reason,runtime_mode} increments for fail-closed activation decisions."
  },
  "test_cases": [
    {
      "name": "fake-only production remains valid",
      "lens": "happy_shadow_empty",
      "given": "production, hostedRealRuntimeExecution disabled, allowlist ['fake.deterministic'], no provider policy",
      "expect": "activation valid with enabledRealModes []."
    },
    {
      "name": "missing policy denies production real",
      "lens": "error_path",
      "given": "production, gate enabled, allowlist ['fake.deterministic','codex.exec_json'], no policy source",
      "expect": "provider_runtime_policy_missing."
    },
    {
      "name": "policy source conflict denies activation",
      "lens": "error_path",
      "given": "production real mode with both policyJson and policyPathContents",
      "expect": "provider_runtime_policy_malformed."
    },
    {
      "name": "valid codex production activation",
      "lens": "happy",
      "given": "production, gate enabled, codex allowlisted, valid codex policy, OPENAI_API_KEY present, binaryProbe returns ok",
      "expect": "activation valid and buildProviderResolvedCommand returns codex exec --json read-only handoff."
    },
    {
      "name": "credential and binary failures are named",
      "lens": "error_path",
      "given": "valid policy with missing OPENAI_API_KEY or binaryProbe false",
      "expect": "provider_credentials_missing or provider_binary_unavailable."
    },
    {
      "name": "spend controls deny oversized prompt",
      "lens": "error_path",
      "given": "maxPromptBytes 100 and prompt length 101 bytes",
      "expect": "provider_prompt_too_large before adapter start."
    },
    {
      "name": "sandbox denylist remains untouched",
      "lens": "integration",
      "given": "R20 sandbox command policy tries executablePath /usr/bin/opencode",
      "expect": "sandbox schema still rejects it; provider policy resolver can separately validate provider command handoff."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "resolveProviderRuntimePolicy",
        "kind": "function",
        "signature": "(input: ProviderRuntimePolicyResolutionInput) => ProviderRuntimePolicyResolutionResult"
      },
      {
        "name": "validateProviderRuntimeActivation",
        "kind": "function",
        "signature": "(input: ProviderRuntimeActivationInput) => ProviderRuntimeActivationResult"
      },
      {
        "name": "buildProviderResolvedCommand",
        "kind": "function",
        "signature": "(input: BuildProviderResolvedCommandInput) => ProviderResolvedCommand | ProviderRuntimePolicyDenied"
      },
      {
        "name": "checkProviderSpendControlsForRun",
        "kind": "function",
        "signature": "(input: ProviderSpendControlsRunInput) => ProviderSpendControlsDecision"
      },
      {
        "name": "ProviderRuntimeActivationResult",
        "kind": "type",
        "signature": "{ valid: boolean; enabledRealModes: ProviderRuntimeMode[]; reasons: ProviderRuntimeActivationReason[]; redactedSummary: Record<string, unknown> }"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P20-T1-provider-policy-contracts",
        "name": "ProviderRuntimePolicy",
        "signature": "z.infer<typeof providerRuntimePolicySchema>"
      },
      {
        "from_task": "P20-T1-provider-policy-contracts",
        "name": "ProviderResolvedCommand",
        "signature": "z.infer<typeof providerResolvedCommandSchema>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/services/provider-runtime-policy.ts",
      "packages/core/src/services/hosted-runtime-catalog.ts",
      "packages/core/src/services/production-config-guards.ts",
      "packages/core/src/index.ts"
    ]
  }
}
```

### P20-T3-adapter-command-handoff

```json
{
  "id": "P20-T3-adapter-command-handoff",
  "title": "Add provider-specific adapter command handoff",
  "files": [
    "packages/adapters/src/codex/codex-exec-json-adapter.ts",
    "packages/adapters/src/codex/types.ts",
    "packages/adapters/src/claude-code/claude-code-cli-client.ts",
    "packages/adapters/src/claude-code/claude-code-adapter.ts",
    "packages/adapters/src/claude-code/types.ts",
    "packages/adapters/src/opencode/opencode-acp-adapter.ts",
    "packages/adapters/src/opencode/types.ts",
    "packages/adapters/src/index.ts",
    "packages/adapters/test/codex-exec-json-adapter.test.ts",
    "packages/adapters/test/claude-code-cli-client.test.ts",
    "packages/adapters/test/claude-code-adapter.test.ts",
    "packages/adapters/test/opencode-acp-adapter.test.ts"
  ],
  "dependencies": [
    "P20-T1-provider-policy-contracts"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-20-r21-production-hosted-provider-runtime.md",
    "packages/contracts/src/index.ts",
    "packages/adapters/src/codex/codex-exec-json-adapter.ts",
    "packages/adapters/src/claude-code/claude-code-cli-client.ts",
    "packages/adapters/src/claude-code/claude-code-adapter.ts",
    "packages/adapters/src/opencode/opencode-acp-adapter.ts",
    "packages/protocol-acpx/src/acp-stdio-client.ts",
    "packages/adapters/test/codex-exec-json-adapter.test.ts",
    "packages/adapters/test/claude-code-cli-client.test.ts",
    "packages/adapters/test/claude-code-adapter.test.ts",
    "packages/adapters/test/opencode-acp-adapter.test.ts"
  ],
  "instructions": "Extend existing provider adapters to accept an optional hosted provider command handoff object typed from contracts. Do not add a generic process adapter and do not accept request-owned command, cwd, env, argv, processFactory, PTY, terminal, binary, or shell metadata. Codex must spawn the resolved executable with fixed exec-json arguments, force read-only sandbox in hosted provider mode, validate cwd against the resolved handoff, filter env to the resolved env keys, and reject metadata that tries to override command, binary, cwd, env, args, argv, sandbox, processFactory, PTY, terminal, or shell behavior. Claude CLI client must spawn the resolved executable with filtered env, read-only permission mode, and disabled Bash/WebFetch/WebSearch. Claude adapter must surface hosted_approval_bridge_unsupported for approval-required states and hosted_input_bridge_unsupported for post-start input attempts in hosted provider mode. OpenCode ACP must pass filtered env into AcpStdioClient, keep one prompt per run, and map permission requests or post-start input to hosted_approval_bridge_unsupported or hosted_input_bridge_unsupported. Tests must use fake process/client factories and must not call live provider binaries.",
  "acceptance": [
    "Codex hosted provider mode spawns only the resolved executable path with operator-owned fixed args and read-only sandbox.",
    "Codex rejects metadata attempts to inject command, binary, processFactory, PTY, terminal, cwd, argv, args, env, or unsafe sandbox options before spawn.",
    "Claude hosted provider mode uses read-only permission mode and disables Bash, WebFetch, and WebSearch.",
    "Claude hosted provider mode maps approval-required and post-start input states to hosted_approval_bridge_unsupported or hosted_input_bridge_unsupported.",
    "OpenCode hosted provider mode runs one ACP prompt per run, passes only filtered env, and maps permission/input bridge states to hosted_approval_bridge_unsupported or hosted_input_bridge_unsupported.",
    "Adapter logs and errors redact stdout, stderr, prompt text, cwd, executable path, argv, env values, object keys, token-like values, and home paths.",
    "Existing staging/test provider adapter tests remain compatible when hosted provider command handoff is absent."
  ],
  "checks": [
    "pnpm --filter @switchyard/adapters test -- codex-exec-json-adapter.test.ts claude-code-cli-client.test.ts claude-code-adapter.test.ts opencode-acp-adapter.test.ts",
    "pnpm --filter @switchyard/adapters typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "CodexExecJsonAdapter.start",
      "failure": "hosted metadata contains command, binary, cwd, env, argv, args, processFactory, PTY, terminal, shell, or unsafe sandbox override",
      "exception": "explicit validation branch",
      "rescue": "Emit run.failed before spawn.",
      "user_sees": "provider_command_denied."
    },
    {
      "codepath": "CodexExecJsonAdapter.start",
      "failure": "spawn fails or resolved executable is unavailable",
      "exception": "ChildProcess error event",
      "rescue": "Map to existing adapter failure with provider_binary_unavailable when hosted handoff is active.",
      "user_sees": "provider_binary_unavailable or provider_command_denied with redacted details."
    },
    {
      "codepath": "createClaudeCodeCliClient",
      "failure": "resolved cwd/env/permission settings are missing or approval mode is requested",
      "exception": "explicit validation branch",
      "rescue": "Reject before process creation or map approval requirement to hosted_approval_bridge_unsupported.",
      "user_sees": "provider_command_denied or hosted_approval_bridge_unsupported."
    },
    {
      "codepath": "ClaudeCodeAdapter.send",
      "failure": "post-start input is attempted in hosted provider mode",
      "exception": "explicit unsupported bridge branch",
      "rescue": "Reject the input bridge call without touching provider process state.",
      "user_sees": "hosted_input_bridge_unsupported."
    },
    {
      "codepath": "OpenCodeAcpAdapter.start",
      "failure": "ACP permission request arrives or client requests interactive input",
      "exception": "ACP protocol event",
      "rescue": "Fail the run visibly because R21 has no hosted approval or terminal bridge.",
      "user_sees": "hosted_approval_bridge_unsupported or hosted_input_bridge_unsupported."
    }
  ],
  "observability": {
    "logs": [
      "info hosted_provider_adapter_start with runtimeMode, adapterId, policySource, and redacted command summary",
      "warn hosted_provider_adapter_denied with runtimeMode and low-cardinality reason",
      "warn hosted_provider_bridge_unsupported with runtimeMode and bridge kind"
    ],
    "success_metric": "hosted_provider_adapter_started{runtime_mode} increments after command policy validation and before provider start.",
    "failure_metric": "hosted_provider_adapter_failed{runtime_mode,reason} increments for policy, binary, spawn, approval bridge, and input bridge failures."
  },
  "test_cases": [
    {
      "name": "codex uses resolved command",
      "lens": "happy",
      "given": "A fake processFactory and ProviderResolvedCommand for codex.exec_json",
      "expect": "spawn receives the resolved executable path, exec --json fixed args, read-only sandbox flag, resolved cwd, and filtered env only."
    },
    {
      "name": "codex rejects metadata escape",
      "lens": "error_path",
      "given": "Run metadata with command, env, argv, cwd, processFactory, PTY, terminal, or sandbox workspace-write",
      "expect": "run.failed emits provider_command_denied before fake processFactory is called."
    },
    {
      "name": "claude enforces read-only tools",
      "lens": "happy",
      "given": "Claude hosted command handoff",
      "expect": "CLI args include read-only permission posture and disabled Bash/WebFetch/WebSearch."
    },
    {
      "name": "claude approval unsupported",
      "lens": "error_path",
      "given": "A fake Claude stream event that requests approval in hosted mode",
      "expect": "run.failed with hosted_approval_bridge_unsupported."
    },
    {
      "name": "opencode filters env",
      "lens": "happy",
      "given": "ProviderResolvedCommand env contains only OPENCODE_API_KEY",
      "expect": "AcpStdioClient receives filtered env and no unrelated process.env values."
    },
    {
      "name": "opencode permission unsupported",
      "lens": "error_path",
      "given": "ACP permission request event",
      "expect": "run.failed with hosted_approval_bridge_unsupported."
    },
    {
      "name": "existing non-hosted tests still pass",
      "lens": "integration",
      "given": "Adapter constructors without hosted provider command handoff",
      "expect": "Existing staging/test fake process tests still pass."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "CodexExecJsonAdapterOptions.hostedProviderCommand",
        "kind": "type",
        "signature": "ProviderResolvedCommand | undefined"
      },
      {
        "name": "ClaudeCodeCliClientOptions.hostedProviderCommand",
        "kind": "type",
        "signature": "ProviderResolvedCommand | undefined"
      },
      {
        "name": "ClaudeCodeAdapterOptions.hostedProviderCommand",
        "kind": "type",
        "signature": "ProviderResolvedCommand | undefined"
      },
      {
        "name": "OpenCodeAcpAdapterOptions.hostedProviderCommand",
        "kind": "type",
        "signature": "ProviderResolvedCommand | undefined"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P20-T1-provider-policy-contracts",
        "name": "ProviderResolvedCommand",
        "signature": "z.infer<typeof providerResolvedCommandSchema>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/adapters/src/codex/types.ts",
      "packages/adapters/src/claude-code/types.ts",
      "packages/adapters/src/opencode/types.ts",
      "packages/adapters/src/index.ts"
    ]
  }
}
```

### P20-T4-worker-config-claim-readiness

```json
{
  "id": "P20-T4-worker-config-claim-readiness",
  "title": "Wire worker provider policy, readiness, and claim gates",
  "files": [
    "apps/worker/src/config.ts",
    "apps/worker/src/hosted-runtime-adapters.ts",
    "apps/worker/src/worker.ts",
    "apps/worker/test/production-config.test.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts",
    "packages/core/src/services/hosted-worker-service.ts",
    "packages/core/test/hosted-worker-service.test.ts"
  ],
  "dependencies": [
    "P20-T1-provider-policy-contracts",
    "P20-T2-core-policy-catalog-gates",
    "P20-T3-adapter-command-handoff"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-20-r21-production-hosted-provider-runtime.md",
    "apps/worker/src/config.ts",
    "apps/worker/src/hosted-runtime-adapters.ts",
    "apps/worker/src/worker.ts",
    "packages/core/src/services/hosted-worker-service.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts",
    "packages/core/src/services/production-config-guards.ts",
    "apps/worker/test/production-config.test.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts",
    "packages/core/test/hosted-worker-service.test.ts"
  ],
  "instructions": "Update worker config to parse the provider runtime policy source and validate production activation with the core resolver. Default production stays fake-only. Production real provider modes should be accepted only when the deployment mode, real runtime gate, allowlist, policy, credentials, spend controls, and binary checks pass. Build provider adapters in production only for activated modes, passing ProviderResolvedCommand handoff options from the core resolver into adapter constructors. Extend worker readiness so strict production readiness includes providerRuntimePolicy and providerRuntimeAdapters checks with redacted summaries. Extend HostedWorkerService so every queue claim revalidates the run's runtime mode against current provider activation, spend controls, prompt size, adapter availability, and command handoff before persisting start state or invoking the adapter. Treat provider policy, activation, credential, prompt size, bridge unsupported, and command denials as non-retryable job failures. Preserve R18/R19 queue ownership, artifacts, metrics, audit, and fake deterministic behavior.",
  "acceptance": [
    "Worker production fake-only startup remains valid without provider policy.",
    "Worker production real allowlist startup fails for missing policy, malformed policy, disabled entry, missing credentials, invalid spend controls, or unavailable provider binary.",
    "Worker builds Codex, Claude, and OpenCode adapters in production only when each mode is explicitly allowlisted and activated by policy.",
    "Worker readiness reports provider runtime activation status with named codes and redacted summaries.",
    "Worker claim revalidates provider activation before run start so rollback to fake-only fails queued real-provider jobs before adapter invocation.",
    "Worker claim spend checks reject oversized prompts, active limit violations, hourly limit violations, and timeout violations before adapter invocation.",
    "Provider policy denials mark job/run failed without retry loops.",
    "Existing fake deterministic hosted worker tests continue to pass."
  ],
  "checks": [
    "pnpm --filter @switchyard/worker test -- production-config.test.ts hosted-worker.test.ts production-worker-readiness.test.ts",
    "pnpm --filter @switchyard/core test -- hosted-worker-service.test.ts",
    "pnpm --filter @switchyard/worker typecheck",
    "pnpm --filter @switchyard/core typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "loadWorkerConfig",
      "failure": "production real runtime gate enabled without valid provider policy, credentials, spend controls, or binary",
      "exception": "ConfigError",
      "rescue": "Fail worker startup and expose redacted config summary.",
      "user_sees": "worker process exits with provider_runtime_policy_missing, provider_credentials_missing, provider_spend_controls_invalid, or provider_binary_unavailable."
    },
    {
      "codepath": "buildHostedWorkerAdapters",
      "failure": "adapter requested for a real mode that is not activated by current provider policy",
      "exception": "explicit adapter gate branch",
      "rescue": "Do not register the adapter and mark readiness failed for that runtime mode.",
      "user_sees": "hosted_runtime_adapter_unavailable or provider_runtime_policy_disabled."
    },
    {
      "codepath": "HostedWorkerService.processNext",
      "failure": "queued run claims a real provider mode after operator rollback to fake-only",
      "exception": "claim revalidation denial",
      "rescue": "Fail the run and queue job as non-retryable before adapter.start.",
      "user_sees": "provider_runtime_policy_disabled or hosted_runtime_adapter_unavailable."
    },
    {
      "codepath": "HostedWorkerService.processNext",
      "failure": "prompt, active run count, hourly run count, or timeout exceeds provider spend controls",
      "exception": "spend denial branch",
      "rescue": "Fail the run and queue job as non-retryable before adapter.start.",
      "user_sees": "provider_prompt_too_large or provider_spend_limit_exceeded."
    },
    {
      "codepath": "createHostedWorker.readiness",
      "failure": "provider adapter check fails after config accepted",
      "exception": "adapter check result",
      "rescue": "Mark readiness unhealthy so production worker does not claim jobs.",
      "user_sees": "readiness check providerRuntimeAdapters failed with redacted details."
    }
  ],
  "observability": {
    "logs": [
      "info worker_provider_runtime_policy_loaded with enabled mode count and policy source kind",
      "warn worker_provider_runtime_claim_denied with runtimeMode and reason code",
      "info worker_provider_runtime_adapter_registered with runtimeMode and adapterId",
      "warn worker_provider_runtime_readiness_failed with reason code"
    ],
    "success_metric": "worker_provider_runtime_claim_allowed{runtime_mode} increments before adapter start.",
    "failure_metric": "worker_provider_runtime_claim_denied{runtime_mode,reason} increments for activation, spend, adapter, credential, and command denials."
  },
  "test_cases": [
    {
      "name": "fake-only worker startup",
      "lens": "happy_shadow_empty",
      "given": "production worker env with fake allowlist and no provider policy",
      "expect": "loadWorkerConfig succeeds and adapters include fake only."
    },
    {
      "name": "real worker startup missing policy",
      "lens": "error_path",
      "given": "production worker env with gate enabled and codex allowlisted but no policy source",
      "expect": "ConfigError with provider_runtime_policy_missing."
    },
    {
      "name": "worker registers activated codex",
      "lens": "happy",
      "given": "production worker env with codex allowlisted, valid policy, required env, and fake passing binaryProbe",
      "expect": "buildHostedWorkerAdapters registers codex adapter with hostedProviderCommand."
    },
    {
      "name": "worker readiness fails adapter unavailable",
      "lens": "error_path",
      "given": "activated mode whose adapter check returns unavailable",
      "expect": "strict readiness fails providerRuntimeAdapters."
    },
    {
      "name": "claim rollback fails before adapter",
      "lens": "integration",
      "given": "A queued codex run and current worker config rolled back to fake-only",
      "expect": "HostedWorkerService fails the run with provider_runtime_policy_disabled and adapter.start is not called."
    },
    {
      "name": "claim spend prompt limit",
      "lens": "error_path",
      "given": "A codex run whose prompt bytes exceed maxPromptBytes",
      "expect": "provider_prompt_too_large before start state and before adapter.start."
    },
    {
      "name": "provider policy denial non-retryable",
      "lens": "error_path",
      "given": "Missing required provider env during claim revalidation",
      "expect": "job is failed without retry and run error code is provider_credentials_missing."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "WorkerConfig.providerRuntimeActivation",
        "kind": "type",
        "signature": "ProviderRuntimeActivationResult"
      },
      {
        "name": "buildHostedWorkerAdapters",
        "kind": "function",
        "signature": "(config: WorkerConfig) => HostedWorkerAdapters"
      },
      {
        "name": "HostedWorkerService provider claim revalidation",
        "kind": "function",
        "signature": "processNext() revalidates ProviderRuntimeActivationResult before adapter.start"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P20-T2-core-policy-catalog-gates",
        "name": "resolveProviderRuntimePolicy",
        "signature": "(input: ProviderRuntimePolicyResolutionInput) => ProviderRuntimePolicyResolutionResult"
      },
      {
        "from_task": "P20-T2-core-policy-catalog-gates",
        "name": "buildProviderResolvedCommand",
        "signature": "(input: BuildProviderResolvedCommandInput) => ProviderResolvedCommand | ProviderRuntimePolicyDenied"
      },
      {
        "from_task": "P20-T3-adapter-command-handoff",
        "name": "CodexExecJsonAdapterOptions.hostedProviderCommand",
        "signature": "ProviderResolvedCommand | undefined"
      },
      {
        "from_task": "P20-T3-adapter-command-handoff",
        "name": "ClaudeCodeCliClientOptions.hostedProviderCommand",
        "signature": "ProviderResolvedCommand | undefined"
      },
      {
        "from_task": "P20-T3-adapter-command-handoff",
        "name": "ClaudeCodeAdapterOptions.hostedProviderCommand",
        "signature": "ProviderResolvedCommand | undefined"
      },
      {
        "from_task": "P20-T3-adapter-command-handoff",
        "name": "OpenCodeAcpAdapterOptions.hostedProviderCommand",
        "signature": "ProviderResolvedCommand | undefined"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "apps/worker/src/config.ts",
      "apps/worker/src/hosted-runtime-adapters.ts",
      "apps/worker/src/worker.ts",
      "packages/core/src/services/hosted-worker-service.ts"
    ]
  }
}
```

### P20-T5-server-config-readiness

```json
{
  "id": "P20-T5-server-config-readiness",
  "title": "Wire server provider policy config and readiness",
  "files": [
    "apps/server/src/config.ts",
    "apps/server/src/readiness.ts",
    "apps/server/test/production-config.test.ts",
    "apps/server/test/production-readiness.test.ts"
  ],
  "dependencies": [
    "P20-T1-provider-policy-contracts",
    "P20-T2-core-policy-catalog-gates"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-20-r21-production-hosted-provider-runtime.md",
    "apps/server/src/config.ts",
    "apps/server/src/readiness.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts",
    "packages/core/src/services/production-config-guards.ts",
    "apps/server/test/production-config.test.ts",
    "apps/server/test/production-readiness.test.ts"
  ],
  "instructions": "Update server config to parse provider runtime policy sources and validate production activation with the core resolver. Server config must preserve fake-only production defaults and must allow production real provider modes only when the operator gate, closed allowlist, policy, credentials, spend controls, and provider command checks pass. The server must not instantiate provider adapters or spawn provider processes. Extend readiness with providerRuntimeActivation status and redacted diagnostics so operators can see whether the server is admitting provider runs. Ensure diagnostics report source kind, enabled mode count, reason codes, and policy version without raw JSON, executable paths, cwd paths, env values, tokens, or object keys.",
  "acceptance": [
    "Server production fake-only startup remains valid without provider policy.",
    "Server production real allowlist startup fails for missing policy, malformed policy, disabled entry, missing credentials, invalid spend controls, unknown runtime mode, or invalid command policy.",
    "Server production real allowlist startup succeeds for an explicitly activated known provider mode without constructing provider adapters.",
    "Server readiness includes providerRuntimeActivation with redacted status.",
    "Server readiness fails in production when provider activation is required but invalid.",
    "Existing R19 production preflight, schema, queue, object store, control-plane, and sandbox readiness behavior remains intact."
  ],
  "checks": [
    "pnpm --filter @switchyard/server test -- production-config.test.ts production-readiness.test.ts",
    "pnpm --filter @switchyard/server typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "loadServerConfig",
      "failure": "production real runtime gate enabled without valid provider activation",
      "exception": "ConfigError",
      "rescue": "Fail server startup with named provider code and redacted summary.",
      "user_sees": "server process exits with provider_runtime_policy_missing, provider_credentials_missing, provider_spend_controls_invalid, provider_runtime_policy_unknown_mode, or provider_command_policy_invalid."
    },
    {
      "codepath": "createReadinessProbe",
      "failure": "provider activation becomes invalid in readiness inputs",
      "exception": "readiness status branch",
      "rescue": "Return unhealthy readiness and keep diagnostics redacted.",
      "user_sees": "/ready shows providerRuntimeActivation failed with named reason only."
    },
    {
      "codepath": "server config summary builder",
      "failure": "diagnostics accidentally include raw policy JSON, executablePath, cwd, env value, token, or object key",
      "exception": "test assertion failure",
      "rescue": "Fail tests before release.",
      "user_sees": "no runtime exposure; CI blocks the change."
    }
  ],
  "observability": {
    "logs": [
      "info server_provider_runtime_policy_loaded with policy source kind and enabled mode count",
      "warn server_provider_runtime_config_denied with low-cardinality reason code",
      "info server_provider_runtime_readiness_ready with enabled mode count"
    ],
    "success_metric": "server_provider_runtime_activation_ready{runtime_mode} increments during readiness.",
    "failure_metric": "server_provider_runtime_activation_failed{runtime_mode,reason} increments for config/readiness denials."
  },
  "test_cases": [
    {
      "name": "fake-only server startup",
      "lens": "happy_shadow_empty",
      "given": "production server env with fake allowlist and no provider policy",
      "expect": "loadServerConfig succeeds and providerRuntimeActivation.enabledRealModes is empty."
    },
    {
      "name": "server real startup missing policy",
      "lens": "error_path",
      "given": "production server env with gate enabled and claude_code.sdk allowlisted but no policy",
      "expect": "ConfigError with provider_runtime_policy_missing."
    },
    {
      "name": "server real startup valid policy",
      "lens": "happy",
      "given": "production server env with opencode.acp allowlisted, valid policy, required env, and passing binary probe",
      "expect": "loadServerConfig succeeds and no adapter is constructed."
    },
    {
      "name": "readiness redacts policy details",
      "lens": "integration",
      "given": "A valid policy containing executablePath, cwdPrefixes, and env var names",
      "expect": "readiness output includes mode status and reason codes but not raw paths, env values, or raw JSON."
    },
    {
      "name": "readiness fails invalid activation",
      "lens": "error_path",
      "given": "production readiness with provider activation invalid due missing required env",
      "expect": "providerRuntimeActivation check is unhealthy with provider_credentials_missing."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "ServerConfig.providerRuntimeActivation",
        "kind": "type",
        "signature": "ProviderRuntimeActivationResult"
      },
      {
        "name": "readiness providerRuntimeActivation check",
        "kind": "function",
        "signature": "() => ReadinessCheckResult with redacted provider activation summary"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P20-T2-core-policy-catalog-gates",
        "name": "resolveProviderRuntimePolicy",
        "signature": "(input: ProviderRuntimePolicyResolutionInput) => ProviderRuntimePolicyResolutionResult"
      },
      {
        "from_task": "P20-T2-core-policy-catalog-gates",
        "name": "validateProviderRuntimeActivation",
        "signature": "(input: ProviderRuntimeActivationInput) => ProviderRuntimeActivationResult"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "apps/server/src/config.ts",
      "apps/server/src/readiness.ts"
    ]
  }
}
```

### P20-T6-server-admission-side-effects

```json
{
  "id": "P20-T6-server-admission-side-effects",
  "title": "Enforce hosted real admission before side effects",
  "files": [
    "apps/server/src/app.ts",
    "packages/core/src/services/hosted-run-service.ts",
    "packages/core/test/hosted-run-service.test.ts",
    "packages/protocol-rest/src/run-routes.ts",
    "packages/protocol-rest/test/run-routes.test.ts",
    "apps/server/test/hosted-server.test.ts"
  ],
  "dependencies": [
    "P20-T1-provider-policy-contracts",
    "P20-T2-core-policy-catalog-gates",
    "P20-T5-server-config-readiness"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-20-r21-production-hosted-provider-runtime.md",
    "apps/server/src/app.ts",
    "packages/core/src/services/hosted-run-service.ts",
    "packages/core/src/services/control-plane-service.ts",
    "packages/core/src/services/hosted-runtime-catalog.ts",
    "packages/core/src/services/production-config-guards.ts",
    "packages/protocol-rest/src/run-routes.ts",
    "packages/protocol-rest/test/run-routes.test.ts",
    "apps/server/test/hosted-server.test.ts"
  ],
  "instructions": "Wire server-side hosted real admission to the provider activation result from server config. Add or move a cheap preflight path so hosted real provider requests are denied before quota reservation and run persistence when the denial can be decided from request and config: implicit placement, wait=1, unknown runtime mode, real-runtime gate disabled, mode not allowlisted, provider policy invalid, prompt bytes over provider maxPromptBytes, and missing hosted placement. Preserve R18 control-plane entitlement, quota, ownership, and audit behavior for allowed runs. Hosted real runs must still require explicit placement=hosted and must never be selected by automatic placement inference. Update input route behavior so hosted real post-start input returns hosted_input_bridge_unsupported. Keep approval route behavior fail-closed with hosted_approval_bridge_unsupported when approval is requested for hosted provider modes. Do not add any public exec, shell, process, command, PTY, terminal, sandbox, browser, search, GitHub, fetch, repo, dashboard, or TUI route.",
  "acceptance": [
    "Hosted real provider run creation with implicit placement is denied before queue/run side effects.",
    "Hosted real provider run creation with wait=1 is denied before quota reservation and run persistence.",
    "Hosted real provider run creation with disabled gate, unknown mode, missing policy, disabled policy entry, or prompt over maxPromptBytes is denied before adapter work and before durable side effects where the request shape permits.",
    "Allowed hosted real provider run creation still passes entitlement, quota, ownership, audit, queue, and artifact contracts from R18/R19.",
    "Post-start input for hosted real provider runs returns hosted_input_bridge_unsupported.",
    "Hosted approval bridge attempts for provider modes return hosted_approval_bridge_unsupported.",
    "No public forbidden route or OpenAPI operation is introduced."
  ],
  "checks": [
    "pnpm --filter @switchyard/core test -- hosted-run-service.test.ts",
    "pnpm --filter @switchyard/protocol-rest test -- run-routes.test.ts",
    "pnpm --filter @switchyard/server test -- hosted-server.test.ts",
    "pnpm --filter @switchyard/core typecheck",
    "pnpm --filter @switchyard/protocol-rest typecheck",
    "pnpm --filter @switchyard/server typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "run-routes POST /runs preflight",
      "failure": "hosted real mode requested with implicit placement or wait=1",
      "exception": "explicit request validation branch",
      "rescue": "Return 400/409 style preflight denial before control-plane reservation and run persistence.",
      "user_sees": "hosted_real_runtime_requires_explicit_placement or hosted_wait_unsupported."
    },
    {
      "codepath": "HostedRunService.createRun",
      "failure": "mode not allowlisted, provider gate disabled, policy invalid, or prompt too large",
      "exception": "HostedRunPreflightError",
      "rescue": "Fail before queue enqueue and before adapter dispatch.",
      "user_sees": "hosted_runtime_mode_not_allowed, provider_runtime_policy_missing, provider_runtime_policy_disabled, provider_prompt_too_large, or provider_spend_limit_exceeded."
    },
    {
      "codepath": "controlPlane.preflightRunCreate integration",
      "failure": "quota reservation succeeds but later persistence/enqueue fails",
      "exception": "existing service error branch",
      "rescue": "Preserve existing reservation release and audit failure behavior.",
      "user_sees": "existing run creation failure response with no leaked provider details."
    },
    {
      "codepath": "POST /runs/:id/input",
      "failure": "input sent to hosted real provider run",
      "exception": "explicit unsupported bridge branch",
      "rescue": "Reject without queueing input or touching provider process state.",
      "user_sees": "hosted_input_bridge_unsupported."
    },
    {
      "codepath": "approval route integration",
      "failure": "approval requested for hosted provider run",
      "exception": "explicit unsupported bridge branch",
      "rescue": "Reject or fail the run with a named unsupported bridge code.",
      "user_sees": "hosted_approval_bridge_unsupported."
    }
  ],
  "observability": {
    "logs": [
      "info hosted_real_preflight_passed with runtimeMode, placement hosted, and tenant scope",
      "warn hosted_real_preflight_denied with runtimeMode and reason code",
      "warn hosted_real_bridge_unsupported with bridge kind and runtimeMode"
    ],
    "success_metric": "hosted_real_preflight_passed{runtime_mode} increments for admitted provider runs.",
    "failure_metric": "hosted_real_preflight_denied{runtime_mode,reason} increments for request, policy, spend, and bridge denials."
  },
  "test_cases": [
    {
      "name": "implicit placement denied before side effects",
      "lens": "error_path",
      "given": "POST /runs with runtimeMode codex.exec_json and no placement=hosted",
      "expect": "Response denies explicit placement requirement and fake repositories record no reservation, run, queue, or audit side effects."
    },
    {
      "name": "wait one denied before reservation",
      "lens": "error_path",
      "given": "POST /runs with placement hosted, runtimeMode claude_code.sdk, wait=1",
      "expect": "hosted_wait_unsupported and no quota reservation."
    },
    {
      "name": "oversized prompt denied",
      "lens": "error_path",
      "given": "Valid provider activation but prompt bytes exceed maxPromptBytes",
      "expect": "provider_prompt_too_large before run persistence."
    },
    {
      "name": "allowed run preserves control-plane behavior",
      "lens": "integration",
      "given": "Valid opencode hosted provider request with entitlement and quota available",
      "expect": "Run persisted, queue job enqueued, audit recorded, and tenant ownership preserved."
    },
    {
      "name": "hosted provider input unsupported",
      "lens": "error_path",
      "given": "POST /runs/:id/input for active hosted codex run",
      "expect": "hosted_input_bridge_unsupported."
    },
    {
      "name": "no forbidden public routes",
      "lens": "integration",
      "given": "Server route table after R21",
      "expect": "No /exec, /shell, /process, /command, /pty, /terminal, /sandbox, /browser, /search, /github, /fetch, /repo, /dashboard, or /tui route is present."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "HostedRunService provider preflight",
        "kind": "function",
        "signature": "createRun(input: HostedRunCreateInput) performs provider activation and spend preflight before queue enqueue"
      },
      {
        "name": "run-routes hosted real early preflight",
        "kind": "function",
        "signature": "POST /runs rejects request-shape hosted real denials before controlPlane.preflightRunCreate"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P20-T2-core-policy-catalog-gates",
        "name": "checkProviderSpendControlsForRun",
        "signature": "(input: ProviderSpendControlsRunInput) => ProviderSpendControlsDecision"
      },
      {
        "from_task": "P20-T5-server-config-readiness",
        "name": "ServerConfig.providerRuntimeActivation",
        "signature": "ProviderRuntimeActivationResult"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/services/hosted-run-service.ts",
      "packages/protocol-rest/src/run-routes.ts",
      "apps/server/src/app.ts"
    ]
  }
}
```

### P20-T7-ops-smoke-canary-manifest

```json
{
  "id": "P20-T7-ops-smoke-canary-manifest",
  "title": "Extend production ops checks for provider runtime activation",
  "files": [
    "scripts/production-preflight.ts",
    "scripts/production-preflight.test.ts",
    "scripts/hosted-real-runtime-smoke.ts",
    "scripts/production-canary.ts",
    "scripts/production-canary.test.ts",
    "scripts/production-manifest.ts",
    "deploy/production/manifest.json",
    "deploy/production/.env.example",
    "deploy/production/README.md",
    "deploy/production/production-manifest.test.ts",
    "package.json"
  ],
  "dependencies": [
    "P20-T1-provider-policy-contracts",
    "P20-T2-core-policy-catalog-gates",
    "P20-T4-worker-config-claim-readiness",
    "P20-T5-server-config-readiness",
    "P20-T6-server-admission-side-effects"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-20-r21-production-hosted-provider-runtime.md",
    "scripts/production-preflight.ts",
    "scripts/production-preflight.test.ts",
    "scripts/hosted-real-runtime-smoke.ts",
    "scripts/production-canary.ts",
    "scripts/production-canary.test.ts",
    "scripts/production-manifest.ts",
    "deploy/production/manifest.json",
    "deploy/production/.env.example",
    "deploy/production/README.md",
    "deploy/production/production-manifest.test.ts",
    "package.json"
  ],
  "instructions": "Extend production operator checks without making live provider calls the default. Production preflight must validate provider policy activation when real modes are enabled and keep fake-only production valid. hosted-real-runtime-smoke must run deterministic no-spend provider activation coverage using fake process/client factories and should exercise production-mode config, server preflight, worker readiness, and adapter handoff for the three known modes. production-canary must keep the R19 fake canary default and add provider mode canary support that requires --runtime-mode for one of the known real modes plus --confirm-provider-spend before any live provider run is submitted. Add provider_canary_* named failures for missing config, runtime empty, create denied, timeout, run failed, artifact missing, metrics failed, and audit failed. Update production manifest validation so the checked-in manifest stays fake-only by default but documents a separate explicit opt-in provider activation posture. Update deploy env example and README with rollback instructions, policy source examples, no-spend smoke, and live canary spend confirmation. Do not add browser/search/GitHub/fetch/repo hosted tools or forbidden public routes to the manifest.",
  "acceptance": [
    "production-preflight passes fake-only production and fails invalid provider activation with named provider codes.",
    "hosted-real-runtime-smoke exercises all three known provider modes in deterministic no-spend mode using fake process/client factories.",
    "production-canary default behavior remains fake-only and no-spend.",
    "production-canary provider mode requires --confirm-provider-spend and refuses live provider execution without it.",
    "production-canary provider mode validates run creation, completion, artifact, metrics, and audit checks with provider_canary_* failures.",
    "The checked-in production manifest remains fake-only by default and forbids public command, shell, PTY, terminal, sandbox, browser, search, GitHub, fetch, repo, dashboard, TUI, hosted tools, and hosted debate real surfaces.",
    "Deploy README and .env.example document explicit opt-in policy, credentials by env var name, spend controls, preflight, smoke, canary, and rollback to fake-only.",
    "Package scripts expose deterministic provider smoke and explicit provider canary commands without making live provider checks part of default CI."
  ],
  "checks": [
    "pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts deploy/production/production-manifest.test.ts",
    "pnpm hosted-real-runtime:smoke",
    "pnpm production:preflight",
    "pnpm typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "production-preflight provider runtime check",
      "failure": "provider activation invalid in production env",
      "exception": "preflight check result",
      "rescue": "Fail preflight before deploy cutover with named provider code.",
      "user_sees": "production preflight failure with provider_runtime_policy_missing, provider_credentials_missing, provider_spend_controls_invalid, provider_binary_unavailable, or provider_command_policy_invalid."
    },
    {
      "codepath": "hosted-real-runtime-smoke",
      "failure": "deterministic adapter handoff, server preflight, or worker readiness regression",
      "exception": "smoke assertion failure",
      "rescue": "Exit non-zero before live provider spend.",
      "user_sees": "smoke failure naming the runtime mode and failed gate."
    },
    {
      "codepath": "production-canary provider mode",
      "failure": "--runtime-mode is a real provider mode but --confirm-provider-spend is absent",
      "exception": "argument validation branch",
      "rescue": "Abort before creating a run.",
      "user_sees": "provider_canary_config_missing with a confirmation hint."
    },
    {
      "codepath": "production-canary provider mode",
      "failure": "run creation denied, timeout, run failed, artifact missing, metrics missing, or audit missing",
      "exception": "canary check branch",
      "rescue": "Return named provider_canary_* failure and include run id only when available.",
      "user_sees": "provider_canary_create_denied, provider_canary_timeout, provider_canary_run_failed, provider_canary_artifact_missing, provider_canary_metrics_failed, or provider_canary_audit_failed."
    },
    {
      "codepath": "production-manifest validation",
      "failure": "manifest advertises forbidden public surface or default real-provider activation",
      "exception": "manifest validation failure",
      "rescue": "Fail manifest tests before release.",
      "user_sees": "CI failure; deploy artifact is not shipped."
    }
  ],
  "observability": {
    "logs": [
      "info production_preflight_provider_runtime_ready with enabled mode count",
      "warn production_preflight_provider_runtime_failed with reason code",
      "info hosted_real_runtime_smoke_mode_passed with runtimeMode",
      "warn production_provider_canary_failed with runtimeMode and provider_canary_* code"
    ],
    "success_metric": "production_provider_preflight_ready{runtime_mode} and production_provider_canary_passed{runtime_mode}.",
    "failure_metric": "production_provider_preflight_failed{reason,runtime_mode} and production_provider_canary_failed{reason,runtime_mode}."
  },
  "test_cases": [
    {
      "name": "preflight fake-only still passes",
      "lens": "happy_shadow_empty",
      "given": "production env with fake allowlist and no provider policy",
      "expect": "production-preflight provider check passes as disabled."
    },
    {
      "name": "preflight invalid provider policy fails",
      "lens": "error_path",
      "given": "production env with gate enabled and opencode allowlisted but no policy",
      "expect": "provider_runtime_policy_missing."
    },
    {
      "name": "no-spend smoke covers known modes",
      "lens": "happy",
      "given": "hosted-real-runtime-smoke with fake factories",
      "expect": "codex.exec_json, claude_code.sdk, and opencode.acp each pass server preflight, worker readiness, and adapter handoff without live provider calls."
    },
    {
      "name": "provider canary requires spend confirmation",
      "lens": "error_path",
      "given": "production-canary --runtime-mode codex.exec_json without --confirm-provider-spend",
      "expect": "provider_canary_config_missing before run creation."
    },
    {
      "name": "provider canary success path",
      "lens": "integration",
      "given": "production-canary with runtime mode, confirmation, policy, credentials, and fake HTTP server returning run success",
      "expect": "canary verifies run, artifact, metrics, and audit checks."
    },
    {
      "name": "manifest remains fake-only by default",
      "lens": "integration",
      "given": "checked-in deploy/production/manifest.json",
      "expect": "default runtime posture is fake-only and forbidden surfaces are absent."
    },
    {
      "name": "manifest rejects forbidden hosted tools",
      "lens": "error_path",
      "given": "A manifest fixture adding browser/search/GitHub/fetch/repo hosted tool surfaces",
      "expect": "production-manifest test fails."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "production preflight provider runtime check",
        "kind": "function",
        "signature": "checkProviderRuntimeActivation(env: Record<string,string|undefined>) => PreflightCheckResult"
      },
      {
        "name": "hosted-real-runtime smoke",
        "kind": "function",
        "signature": "deterministic no-spend smoke covering codex.exec_json, claude_code.sdk, opencode.acp"
      },
      {
        "name": "production provider canary mode",
        "kind": "function",
        "signature": "production-canary --runtime-mode <known-provider-mode> --confirm-provider-spend"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P20-T2-core-policy-catalog-gates",
        "name": "resolveProviderRuntimePolicy",
        "signature": "(input: ProviderRuntimePolicyResolutionInput) => ProviderRuntimePolicyResolutionResult"
      },
      {
        "from_task": "P20-T4-worker-config-claim-readiness",
        "name": "WorkerConfig.providerRuntimeActivation",
        "signature": "ProviderRuntimeActivationResult"
      },
      {
        "from_task": "P20-T5-server-config-readiness",
        "name": "ServerConfig.providerRuntimeActivation",
        "signature": "ProviderRuntimeActivationResult"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "scripts/production-preflight.ts",
      "scripts/hosted-real-runtime-smoke.ts",
      "scripts/production-canary.ts",
      "deploy/production/manifest.json",
      "deploy/production/.env.example",
      "deploy/production/README.md",
      "package.json"
    ]
  }
}
```

### P20-T8-boundary-product-truth

```json
{
  "id": "P20-T8-boundary-product-truth",
  "title": "Lock public surface boundaries and update product truth",
  "files": [
    "packages/contracts/src/openapi.contract.test.ts",
    "packages/contracts/src/endpoint-inventory.drift.test.ts",
    "packages/contracts/openapi.local-daemon.json",
    "packages/contracts/openapi.hosted-server.json",
    "PRODUCT.md",
    "README.md",
    "docs/development/API.md",
    "docs/development/DEVELOPMENT.md",
    "docs/development/adapters/CODEX.md",
    "docs/development/adapters/CLAUDE_CODE.md",
    "docs/development/adapters/OPENCODE.md"
  ],
  "dependencies": [
    "P20-T1-provider-policy-contracts",
    "P20-T2-core-policy-catalog-gates",
    "P20-T3-adapter-command-handoff",
    "P20-T4-worker-config-claim-readiness",
    "P20-T5-server-config-readiness",
    "P20-T6-server-admission-side-effects",
    "P20-T7-ops-smoke-canary-manifest"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-20-r21-production-hosted-provider-runtime.md",
    "packages/contracts/src/openapi.contract.test.ts",
    "packages/contracts/src/endpoint-inventory.drift.test.ts",
    "packages/contracts/openapi.local-daemon.json",
    "packages/contracts/openapi.hosted-server.json",
    "PRODUCT.md",
    "README.md",
    "docs/development/API.md",
    "docs/development/DEVELOPMENT.md",
    "docs/development/adapters/CODEX.md",
    "docs/development/adapters/CLAUDE_CODE.md",
    "docs/development/adapters/OPENCODE.md"
  ],
  "instructions": "Add public-surface regression tests and update product truth to match R21. OpenAPI and endpoint inventory tests must assert that hosted server and local daemon specs do not contain public /exec, /shell, /process, /command, /pty, /terminal, /sandbox, /browser, /search, /github, /fetch, /repo, /dashboard, or /tui routes or operation ids. Add text assertions or documentation review checks that R21 does not ship generic process/PTY adapters, Cursor, OpenClaw, Paperclip, hosted tools, hosted debate real participants, or hosted model judging. Regenerate or update OpenAPI JSON only if required by test changes; do not add public routes. Update PRODUCT.md and README/development docs to say production hosted provider execution is shipped only for known providers, fake-only remains default, activation is operator opt-in, live checks are spend-gated, and rollback is fake-only by config restart. Do not edit PROJECT.md; CEO owns phase-close entries.",
  "acceptance": [
    "OpenAPI contract tests fail if any forbidden public route or operation id appears.",
    "Endpoint inventory drift tests fail if dashboard/TUI or arbitrary execution routes appear.",
    "Generated OpenAPI JSON remains free of forbidden public route paths and hosted tool surfaces.",
    "PRODUCT.md states R21 shipped known provider production activation while fake-only remains default.",
    "README and development docs explain explicit opt-in, known provider set, provider policy, no-spend smoke, spend-gated canary, and rollback.",
    "Docs explicitly say R21 does not ship generic process/PTY runtime adapters, Cursor, OpenClaw, Paperclip, browser/search/GitHub/fetch/repo hosted tools, hosted debate real participants, hosted model judging, hosted approval bridge, hosted input bridge, or hosted terminal bridge.",
    "PROJECT.md is not modified by implementers."
  ],
  "checks": [
    "pnpm --filter @switchyard/contracts test -- openapi.contract.test.ts endpoint-inventory.drift.test.ts",
    "pnpm --filter @switchyard/contracts openapi:check",
    "pnpm --filter @switchyard/contracts openapi:check:hosted",
    "pnpm typecheck",
    "git diff -- PROJECT.md"
  ],
  "error_rescue_map": [
    {
      "codepath": "openapi forbidden surface assertions",
      "failure": "generated OpenAPI contains forbidden public route or operation id",
      "exception": "test assertion failure",
      "rescue": "Fail tests before release and remove the public surface from implementation.",
      "user_sees": "CI failure; no public route ships."
    },
    {
      "codepath": "endpoint inventory drift assertions",
      "failure": "endpoint inventory contains dashboard, TUI, arbitrary execution, sandbox, browser, search, GitHub, fetch, or repo hosted route",
      "exception": "test assertion failure",
      "rescue": "Fail tests before release and remove route drift.",
      "user_sees": "CI failure; no endpoint drift ships."
    },
    {
      "codepath": "product truth update",
      "failure": "docs claim default real-provider production activation or omit opt-in/spend-gated caveat",
      "exception": "review/test finding",
      "rescue": "Correct product truth before GREEN.",
      "user_sees": "accurate docs explaining fake-only default and explicit opt-in."
    },
    {
      "codepath": "PROJECT.md ownership guard",
      "failure": "implementer edits PROJECT.md",
      "exception": "git diff check",
      "rescue": "Revert only the implementer's PROJECT.md change; CEO will update at phase close.",
      "user_sees": "PROJECT.md remains CEO-owned source of truth."
    }
  ],
  "observability": {
    "logs": [],
    "success_metric": "OpenAPI checks pass and product truth contains R21 known-provider opt-in language.",
    "failure_metric": "OpenAPI or endpoint inventory tests fail on forbidden public surface drift."
  },
  "test_cases": [
    {
      "name": "openapi rejects public shell route",
      "lens": "error_path",
      "given": "A generated OpenAPI fixture containing /shell",
      "expect": "openapi.contract.test.ts fails."
    },
    {
      "name": "openapi rejects hosted tools",
      "lens": "error_path",
      "given": "A generated OpenAPI fixture containing /browser, /search, /github, /fetch, or /repo",
      "expect": "openapi.contract.test.ts fails."
    },
    {
      "name": "endpoint inventory rejects dashboard or TUI",
      "lens": "error_path",
      "given": "Endpoint inventory fixture with /dashboard or /tui",
      "expect": "endpoint-inventory.drift.test.ts fails."
    },
    {
      "name": "openapi remains clean",
      "lens": "happy",
      "given": "R21 generated local-daemon and hosted-server OpenAPI JSON",
      "expect": "No forbidden route or operation id exists."
    },
    {
      "name": "product truth states opt-in",
      "lens": "happy",
      "given": "PRODUCT.md after R21",
      "expect": "Known provider production activation is described as operator opt-in and fake-only remains default."
    },
    {
      "name": "docs list non-goals",
      "lens": "integration",
      "given": "README and development docs after R21",
      "expect": "No claims for generic process/PTY adapters, Cursor/OpenClaw/Paperclip, hosted tools, hosted debate real participants, hosted judging, hosted input, hosted approval, or hosted terminal bridges."
    },
    {
      "name": "project md untouched",
      "lens": "integration",
      "given": "git diff -- PROJECT.md",
      "expect": "No diff from this task."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "forbidden public surface OpenAPI assertions",
        "kind": "function",
        "signature": "OpenAPI tests assert absence of route path and operation id patterns"
      },
      {
        "name": "R21 product truth",
        "kind": "constant",
        "signature": "Docs state known provider opt-in activation and fake-only default"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P20-T1-provider-policy-contracts",
        "name": "providerRuntimeModeSchema",
        "signature": "z.enum(['codex.exec_json','claude_code.sdk','opencode.acp'])"
      },
      {
        "from_task": "P20-T7-ops-smoke-canary-manifest",
        "name": "production provider canary mode",
        "signature": "production-canary --runtime-mode <known-provider-mode> --confirm-provider-spend"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/contracts/src/openapi.contract.test.ts",
      "packages/contracts/src/endpoint-inventory.drift.test.ts",
      "PRODUCT.md",
      "README.md",
      "docs/development/API.md",
      "docs/development/DEVELOPMENT.md",
      "docs/development/adapters/CODEX.md",
      "docs/development/adapters/CLAUDE_CODE.md",
      "docs/development/adapters/OPENCODE.md"
    ]
  }
}
```

## Integration Points

- T1 contracts are the only schema source for provider policy shape, failure codes, and resolved command handoff.
- T2 consumes T1 and exports the provider activation resolver used by server config, worker config, hosted run admission, claim revalidation, preflight, smoke, and canary.
- T3 consumes T1 and updates provider adapters to accept the resolved command handoff. It does not import core, avoiding a circular dependency.
- T4 consumes T2 and T3 to build worker adapters and revalidate claims before adapter start.
- T5 consumes T2 to validate server config and readiness without constructing provider processes.
- T6 consumes T2 and T5 to enforce server admission and no-side-effect denials.
- T7 consumes T2, T4, T5, and T6 to verify production activation and operator workflows without default live provider spend.
- T8 consumes T1 and T7 to update public surface tests and product truth after implementation surfaces are stable.

## Phase Acceptance Criteria

- Production defaults to fake-only unless operator explicitly enables `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled`, allowlists known real modes, and supplies valid provider policy, credentials, spend controls, and readiness/preflight proof.
- Exactly `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` can be production-hosted real provider modes.
- Unknown provider modes, Cursor, OpenClaw, Paperclip, generic process/PTY runtime adapters, browser/search/GitHub/fetch/repo hosted tools, hosted debate real participants, hosted model judging, dashboard/TUI, and public command/shell/PTY/sandbox routes remain absent.
- Provider execution is known-mode only and fail-closed. No request-owned executable, cwd, env, argv, processFactory, PTY, terminal, binary, or shell string is trusted.
- Server admission denies hosted real wait=1, implicit placement, unavailable policy, unavailable adapter, and spend violations before durable side effects whenever those denials can be determined before persistence.
- Worker claim revalidation denies policy, adapter, credentials, and spend failures before provider adapter start.
- Codex hosted provider execution is exec-json and read-only by default.
- Claude Code hosted provider execution is read-only with Bash, WebFetch, and WebSearch disabled.
- OpenCode ACP hosted provider execution is one-prompt-per-run with no hosted terminal, input, or approval bridge.
- Preflight, readiness, no-spend smoke, and spend-confirmed provider canary cover activation and rollback.
- Tests are deterministic and no-spend by default. Live provider canary execution is explicit and budget-gated.
- Product truth and docs reflect that R21 is production known-provider opt-in, not public SaaS or generic arbitrary execution.

## Risks and Concerns

- The phase is complexity L because production activation spans multiple packages and deployment artifacts. Splitting into eight disjoint tasks is preferable to another sub-phase because every task is a narrow extension of an existing R19/R20 seam and the task dependencies make the integration order explicit.
- Provider binary probing can be environment-sensitive. The plan requires injectable probes in core tests and config code so deterministic tests do not depend on local Codex, Claude, or OpenCode installation.
- Policy source handling can leak sensitive operator config if diagnostics echo raw JSON. Every task that reports config status requires redacted summaries and tests against raw executable paths, cwd prefixes, env values, prompt text, stdout, stderr, tokens, object keys, and raw policy JSON.
- Admission side-effect ordering is subtle because R18 quota reservation already happens in the run route. T6 explicitly tests no-reservation/no-run/no-queue/no-audit for request-shape denials and preserves existing reservation release behavior for later failures.

## Self-Review Checklist

1. Spec coverage: covered by T1 through T8 and phase acceptance criteria.
2. Vague marker scan: no incomplete marker text is intentionally present.
3. Type consistency: T1 provider contracts match T2 core resolver signatures, T3 adapter options, T4 worker config, T5 server config, T6 admission, T7 scripts, and T8 docs.
4. Ownership disjoint: every owned file appears in exactly one task.
5. Context files real: every context file path is an existing project file before implementation.
6. Acceptance testable: every acceptance item is command-checkable, response-checkable, or doc/test assertion-checkable.
7. Dependency order sane: tasks are topologically ordered from contracts to core to adapters/config/admission to ops/docs.
8. Checks runnable: checks use existing package filters, Vitest, OpenAPI checks, or existing package scripts.
9. Error/rescue maps present: every task includes explicit failure codepaths and user-visible outcomes.
10. Observability present: runtime tasks specify logs and metrics; pure contract/docs tasks specify test-based observability.
11. Test cases enumerate acceptance: every acceptance cluster has a matching happy, shadow, error, or integration test case.
12. Integration contracts walk: every import listed resolves to an export in an earlier dependency task.
13. Contract types match: `ProviderRuntimePolicy`, `ProviderResolvedCommand`, `ProviderRuntimeActivationResult`, and spend decision signatures are consistent across tasks.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error_rescue_map entry has a matching test case with `lens` `error_path`, `happy_shadow_empty`, or `integration`.
- [x] Every integration contract import resolves to a real export elsewhere.
- [x] Every context file path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No incomplete marker text is present.
- [x] Complexity is L and has been challenged; the phase remains one phase with disjoint tasks because no single task crosses package boundaries without a stable contract dependency.

## Architect Revision 1

Architect verdict was GREEN with `implementation_ready=false`. CTO accepts all required revisions and integrates them as task addenda rather than changing the task IDs. Task IDs stay stable for worktree dispatch, and T3/T7 now have subtask-level implementation and review matrices so their behavior can be built and reviewed independently inside the existing non-overlapping file ownership boundaries.

### Reconciliation Decisions

- Accepted: add missing task test cases for adapter redaction, worker spend checks, server startup failures, server admission side-effect ordering, and provider canary failures.
- Accepted: require every error rescue row to have an explicit `error_path`, `happy_shadow_empty`, or `integration` test in the same task.
- Accepted: update T4 integration contracts to consume every adapter `hostedProviderCommand` option exported by T3: Codex, Claude CLI client, Claude adapter, and OpenCode ACP adapter.
- Accepted: add lifecycle metrics requirements and tests for accepted, denied, failed, timed out, cancelled, and spend-control-denied provider runs.
- Accepted: add provider policy path handling ownership and tests for unreadable path, empty file, oversized file, invalid JSON, invalid UTF-8, and source-kind-only redacted diagnostics.
- Accepted with structure instead of split: T3 and T7 keep their task IDs to avoid dispatch churn, but implementers and reviewers must use the subtask matrices below as independent review slices.
- Accepted: add a compact state transition diagram for provider denial, bridge unsupported, timeout, cancellation, and rollback drift.

### State Transition Diagram

This diagram is part of the implementation contract for T4, T6, and T7.

```text
POST /runs or queue claim
  |
  +-- provider policy / allowlist / credential / spend denial
  |      |
  |      +-- server-known denial -> DENIED before reservation, run row, audit row, queue job
  |      |
  |      +-- worker drift denial -> FAILED terminal event before adapter.start
  |
  +-- accepted
         |
         +-- adapter starts -> RUNNING
                |
                +-- bridge unsupported -> FAILED(reason=hosted_approval_bridge_unsupported
                |                         or hosted_input_bridge_unsupported)
                |
                +-- provider timeout -> TIMED_OUT(reason=provider_run_timeout)
                |
                +-- user/runtime cancellation -> CANCELLED(reason=run_cancelled)
                |
                +-- provider failure -> FAILED(reason=<provider failure code>)
                |
                +-- provider success -> COMPLETED

rollback drift path:
QUEUED(real provider) -> operator restarts fake-only -> worker claim revalidation
  -> FAILED(reason=hosted_real_runtime_disabled or hosted_runtime_not_allowed)
     before adapter.start, with no fallback to fake or local execution.
```

### Cross-Cutting Lifecycle Metrics Contract

Tasks T2, T4, T5, T6, and T7 must use low-cardinality lifecycle metrics for provider-hosted runs. Exact metric names may follow the existing metrics helper style, but the required logical series is:

- `provider_run_lifecycle_total{runtime_mode,reason,outcome}` where `outcome` is one of `accepted`, `denied`, `failed`, `timed_out`, `cancelled`, or `spend_control_denied`.
- `runtime_mode` must be one of `codex.exec_json`, `claude_code.sdk`, or `opencode.acp`. `fake.deterministic` can be omitted from provider-only metrics.
- `reason` must be one of the named failure codes or a fixed success reason such as `accepted`, `completed`, `provider_run_timeout`, or `run_cancelled`.
- Forbidden metric label values: run id, tenant id, project id, user id, prompt text, cwd, executable path, argv, env key, env value, object key, provider output, stdout, stderr, API key, token, or policy path.

Required lifecycle metric tests:

- T4 must test worker metrics for claim accepted, claim denied by rollback drift, adapter failure, provider timeout, provider cancellation, and spend-control denial.
- T6 must test server metrics for admission accepted, request-shape denial, provider-policy denial, and spend-control denial before side effects.
- T7 must test canary/preflight metrics assertions for provider canary success, create denial, timeout, failed run, metrics failure, and audit failure.

### Provider Policy Path Handling Contract

Tasks T2, T4, T5, and T7 must treat policy source loading as a first-class failure surface.

- T2 owns pure content validation. It must expose a maximum provider policy byte limit for callers and return redacted diagnostics that contain only `source_kind` (`json`, `path`, or `none`), policy version when parsed, enabled mode count, runtime mode slugs, and reason codes.
- T4 owns worker config path loading tests for unreadable path, empty file, oversized file, invalid JSON, invalid UTF-8, both JSON and path source present, and source-kind-only redaction.
- T5 owns server config path loading tests for unreadable path, empty file, oversized file, invalid JSON, invalid UTF-8, both JSON and path source present, and source-kind-only redaction.
- T7 owns preflight path handling tests so operator-facing output reports named failures without printing the path, raw JSON, executable path, cwd, env values, tokens, or file contents.

Required named mappings:

- unreadable path -> `provider_runtime_policy_missing` or `provider_runtime_policy_malformed` with `source_kind=path`.
- empty file -> `provider_runtime_policy_empty` with `source_kind=path`.
- oversized file -> `provider_runtime_policy_malformed` with `source_kind=path`.
- invalid JSON -> `provider_runtime_policy_malformed` with `source_kind=path`.
- invalid UTF-8 -> `provider_runtime_policy_malformed` with `source_kind=path`.
- both JSON and path present -> `provider_runtime_policy_malformed` with `source_kind` summary only.

### T3 Subtask Matrix

T3 remains one task because it owns adapter package files exclusively. Implementer and reviewer must treat these slices as independently reviewable:

| Slice | Owned files | Required behavior | Required tests |
|---|---|---|---|
| T3a Adapter option contracts | `packages/adapters/src/codex/types.ts`, `packages/adapters/src/claude-code/types.ts`, `packages/adapters/src/opencode/types.ts`, `packages/adapters/src/index.ts` | Export `hostedProviderCommand?: ProviderResolvedCommand` for Codex, Claude CLI client, Claude adapter, and OpenCode ACP adapter without importing core. | Typecheck proves all four option contracts compile and remain importable by worker. |
| T3b Codex command handoff | `packages/adapters/src/codex/codex-exec-json-adapter.ts`, `packages/adapters/test/codex-exec-json-adapter.test.ts` | Use resolved executable, fixed `exec --json`, filtered env, read-only posture, and metadata injection denial before spawn. | Happy command handoff, metadata escape denial, spawn unavailable, nested provider error redaction, and log redaction. |
| T3c Claude CLI handoff | `packages/adapters/src/claude-code/claude-code-cli-client.ts`, `packages/adapters/test/claude-code-cli-client.test.ts` | Use resolved executable, filtered env, read-only permission mode, disabled Bash/WebFetch/WebSearch, and no approval/input enablement. | CLI arg construction, missing handoff field denial, spawn unavailable, provider stderr redaction, and no unrelated `process.env` leakage. |
| T3d Claude adapter hosted bridge failures | `packages/adapters/src/claude-code/claude-code-adapter.ts`, `packages/adapters/test/claude-code-adapter.test.ts` | Terminalize hosted approval/input states with named unsupported bridge codes. | Approval-required event fails terminally, post-start input fails terminally, timeout remains timeout, cancellation remains cancellation, and logs stay redacted. |
| T3e OpenCode ACP handoff | `packages/adapters/src/opencode/opencode-acp-adapter.ts`, `packages/adapters/test/opencode-acp-adapter.test.ts` | Pass filtered env to ACP stdio client, enforce one prompt per hosted run, and map permission/input states to unsupported bridge codes. | Env filtering, permission request failure, post-start input failure, ACP client spawn failure, transcript redaction, and existing non-hosted tests still pass. |

Additional T3 test cases that amend `test_cases`:

```json
[
  {
    "name": "adapter logs redact hosted command details",
    "lens": "error_path",
    "given": "Codex, Claude, and OpenCode hosted provider runs emit start, denial, spawn failure, and provider error logs containing executable path, cwd, argv, env values, prompt text, stdout, stderr, token-like strings, object keys, and a home path in the fake payload",
    "expect": "Captured logs and emitted errors include runtimeMode and reason code only; sensitive fields are absent or replaced by redaction markers."
  },
  {
    "name": "adapter provider error payload redaction",
    "lens": "error_path",
    "given": "Nested provider error objects include API key-like strings, bearer tokens, cwd, stdout, stderr, command argv, and prompt text",
    "expect": "run.failed reason is named and redacted diagnostics do not contain raw sensitive values."
  },
  {
    "name": "adapter timeout and cancellation preserve lifecycle reasons",
    "lens": "integration",
    "given": "Fake provider process times out or receives cancellation while hostedProviderCommand is active",
    "expect": "Terminal events use provider_run_timeout or run_cancelled and do not remap to provider_command_denied."
  }
]
```

### T4 Addendum: Spend, Metrics, Path, And Adapter Contracts

T4 `integration_contracts.imports_from_other_tasks` must include all of these T3 exports and reviewers must reject the task if any are missing:

```json
[
  {
    "from_task": "P20-T3-adapter-command-handoff",
    "name": "CodexExecJsonAdapterOptions.hostedProviderCommand",
    "signature": "ProviderResolvedCommand | undefined"
  },
  {
    "from_task": "P20-T3-adapter-command-handoff",
    "name": "ClaudeCodeCliClientOptions.hostedProviderCommand",
    "signature": "ProviderResolvedCommand | undefined"
  },
  {
    "from_task": "P20-T3-adapter-command-handoff",
    "name": "ClaudeCodeAdapterOptions.hostedProviderCommand",
    "signature": "ProviderResolvedCommand | undefined"
  },
  {
    "from_task": "P20-T3-adapter-command-handoff",
    "name": "OpenCodeAcpAdapterOptions.hostedProviderCommand",
    "signature": "ProviderResolvedCommand | undefined"
  }
]
```

Additional T4 acceptance:

- Worker claim spend checks must cover prompt bytes, active run count, hourly run count, and requested timeout seconds before adapter invocation.
- Worker lifecycle metrics must emit accepted, denied, failed, timed out, cancelled, and spend-control-denied outcomes with only `runtime_mode`, `reason`, and fixed outcome labels.
- Worker config path loading must fail closed for unreadable path, empty file, oversized file, invalid JSON, invalid UTF-8, and JSON/path source conflict with source-kind-only diagnostics.

Additional T4 test cases:

```json
[
  {
    "name": "claim spend active limit",
    "lens": "error_path",
    "given": "Provider policy maxActiveRuns is 1 and active count for codex.exec_json is already 1",
    "expect": "HostedWorkerService fails before start state and before adapter.start with provider_spend_limit_exceeded and outcome spend_control_denied."
  },
  {
    "name": "claim spend hourly limit",
    "lens": "error_path",
    "given": "Provider policy maxRunsPerHour is 2 and the hourly counter for claude_code.sdk is already 2",
    "expect": "HostedWorkerService fails before adapter.start with provider_spend_limit_exceeded and outcome spend_control_denied."
  },
  {
    "name": "claim spend timeout limit",
    "lens": "error_path",
    "given": "Provider policy maxRunTimeoutSeconds is 300 and queued run timeout is 301",
    "expect": "HostedWorkerService fails before adapter.start with provider_spend_limit_exceeded and does not retry."
  },
  {
    "name": "worker policy path failures are redacted",
    "lens": "error_path",
    "given": "Worker config points to unreadable, empty, oversized, invalid JSON, and invalid UTF-8 policy files in separate cases",
    "expect": "ConfigError uses the mapped provider policy code and diagnostics contain source_kind=path without raw path or file contents."
  },
  {
    "name": "worker lifecycle metrics outcomes",
    "lens": "integration",
    "given": "Fake worker runs for accepted, rollback-denied, adapter-failed, timed-out, cancelled, and spend-denied provider jobs",
    "expect": "provider lifecycle metrics use runtime_mode and reason labels only and cover all six outcomes."
  }
]
```

### T5 Addendum: Server Startup Failure Variants

Additional T5 acceptance:

- Server config startup failure tests must cover every production provider activation variant: missing policy, both policy sources, unreadable policy path, empty policy file, oversized policy file, invalid JSON, invalid UTF-8, unknown runtime mode, disabled entry, missing credentials, invalid spend controls, invalid command policy, real mode with gate disabled, and out-of-scope hosted mode in allowlist.
- `/ready` diagnostics must include source kind, enabled mode count, runtime mode slugs, and reason codes only.

Additional T5 test cases:

```json
[
  {
    "name": "server startup rejects policy source conflict",
    "lens": "error_path",
    "given": "SWITCHYARD_PROVIDER_RUNTIME_POLICY_JSON and SWITCHYARD_PROVIDER_RUNTIME_POLICY_PATH are both set",
    "expect": "ConfigError provider_runtime_policy_malformed and diagnostics do not include either source value."
  },
  {
    "name": "server startup rejects unreadable policy path",
    "lens": "error_path",
    "given": "Production real activation points to a path that cannot be read",
    "expect": "ConfigError provider_runtime_policy_missing or provider_runtime_policy_malformed with source_kind=path only."
  },
  {
    "name": "server startup rejects empty oversized invalid json and invalid utf8 policy files",
    "lens": "error_path",
    "given": "Separate policy files that are empty, exceed the configured byte limit, contain malformed JSON, or contain invalid UTF-8",
    "expect": "ConfigError maps to provider_runtime_policy_empty or provider_runtime_policy_malformed with no raw content in logs/readiness."
  },
  {
    "name": "server startup rejects activation matrix failures",
    "lens": "error_path",
    "given": "Unknown mode, disabled policy entry, missing required env, invalid spend controls, invalid command policy, real mode with gate disabled, and generic_http.async_rest allowlist cases",
    "expect": "ConfigError uses the matching named reason code for each case."
  },
  {
    "name": "server readiness diagnostics are source-kind-only",
    "lens": "integration",
    "given": "Readiness runs with path-sourced provider policy and a failing required env",
    "expect": "providerRuntimeActivation reports source_kind=path, runtime mode, and provider_credentials_missing without raw path, env value, executable path, cwd, or JSON."
  }
]
```

### T6 Addendum: Admission Side-Effect Ordering

Additional T6 acceptance:

- For request-shape and config-known denials, tests must assert no quota reservation, run row, ownership row, audit row, queue job, artifact row, or adapter invocation occurred.
- For failures after a quota reservation has legitimately happened, tests must assert the existing reservation release path and audit semantics remain correct.
- Provider spend denials at server admission must cover prompt bytes, active run count, hourly run count, and timeout seconds where those counters are available to the server.
- Server admission lifecycle metrics must cover accepted, denied, and spend-control-denied outcomes with low-cardinality `runtime_mode` and `reason` labels.

Additional T6 test cases:

```json
[
  {
    "name": "disabled gate denied before all side effects",
    "lens": "error_path",
    "given": "POST /runs placement=hosted runtimeMode=codex.exec_json while real-runtime gate is disabled",
    "expect": "hosted_real_runtime_disabled and fake repositories show zero reservation, run, ownership, audit, queue, artifact, and adapter calls."
  },
  {
    "name": "missing provider policy denied before all side effects",
    "lens": "error_path",
    "given": "POST /runs placement=hosted runtimeMode=claude_code.sdk with production gate enabled but invalid activation",
    "expect": "provider_runtime_policy_missing and no durable or queue side effects."
  },
  {
    "name": "server spend active hourly timeout denials",
    "lens": "error_path",
    "given": "Valid provider activation but active, hourly, or timeout spend controls are exceeded before admission",
    "expect": "provider_spend_limit_exceeded, outcome spend_control_denied, and no run/queue side effects."
  },
  {
    "name": "later enqueue failure releases reservation",
    "lens": "integration",
    "given": "Allowed hosted provider run where control-plane reservation succeeds and queue enqueue then throws",
    "expect": "Reservation release is called once, run is terminalized or absent per existing service contract, and diagnostics are redacted."
  },
  {
    "name": "approval bridge denial has no approval side effects",
    "lens": "error_path",
    "given": "Approval route request for a hosted provider run",
    "expect": "hosted_approval_bridge_unsupported and no runtime approval record is created."
  },
  {
    "name": "server lifecycle metrics admission outcomes",
    "lens": "integration",
    "given": "Accepted hosted provider run, wait=1 denial, missing-policy denial, and spend denial",
    "expect": "Lifecycle metrics emit accepted, denied, and spend_control_denied outcomes with runtime_mode and reason only."
  }
]
```

### T7 Subtask Matrix

T7 remains one task because it owns scripts and deployment artifacts exclusively. Implementer and reviewer must use these independent slices:

| Slice | Owned files | Required behavior | Required tests |
|---|---|---|---|
| T7a Preflight provider checks | `scripts/production-preflight.ts`, `scripts/production-preflight.test.ts` | Validate provider activation, path handling, credentials, spend controls, adapter availability, redaction, and fake-only default. | Fake-only pass, missing policy, unreadable path, invalid UTF-8, binary unavailable, invalid spend, redaction. |
| T7b No-spend hosted smoke | `scripts/hosted-real-runtime-smoke.ts` | Exercise production-mode config, server preflight, worker readiness, adapter handoff, rollback drift, timeout, cancellation, and lifecycle metrics using fake clients. | Known modes pass, rollback drift fails before adapter, timeout metric, cancellation metric, no live provider calls. |
| T7c Provider canary | `scripts/production-canary.ts`, `scripts/production-canary.test.ts` | One runtime mode per invocation, explicit spend confirmation, run create, wait, events, artifacts, metrics auth, audit ownership, and named failure exits. | Every `provider_canary_*` failure listed below plus success path. |
| T7d Manifest and deployment docs | `scripts/production-manifest.ts`, `deploy/production/manifest.json`, `deploy/production/.env.example`, `deploy/production/README.md`, `deploy/production/production-manifest.test.ts` | Keep checked-in manifest fake-only by default; document explicit provider opt-in, policy examples, credentials by env name, spend controls, canary, and rollback. | Manifest default fake-only, opt-in example valid, forbidden surfaces rejected, rollback text present. |
| T7e Package scripts | `package.json` | Expose deterministic provider smoke and spend-confirmed provider canary without adding live provider checks to default CI. | Script inventory test or package assertion proves defaults remain no-spend. |

Additional T7 test cases:

```json
[
  {
    "name": "canary missing base url api key or runtime",
    "lens": "error_path",
    "given": "production-canary lacks base URL, API key, or --runtime-mode for provider mode",
    "expect": "provider_canary_config_missing before any HTTP run creation."
  },
  {
    "name": "canary empty runtime list",
    "lens": "happy_shadow_empty",
    "given": "production-canary receives an empty provider runtime list or blank --runtime-mode",
    "expect": "provider_canary_runtime_empty before any HTTP run creation."
  },
  {
    "name": "canary create denied",
    "lens": "error_path",
    "given": "Fake hosted API returns 409 hosted_runtime_not_allowed for provider canary create",
    "expect": "provider_canary_create_denied with redacted response diagnostics."
  },
  {
    "name": "canary timeout",
    "lens": "error_path",
    "given": "Fake hosted API leaves the canary run non-terminal past timeout",
    "expect": "provider_canary_timeout."
  },
  {
    "name": "canary run failed",
    "lens": "error_path",
    "given": "Fake hosted API returns terminal failed run with provider error reason",
    "expect": "provider_canary_run_failed and no provider output leakage."
  },
  {
    "name": "canary artifact missing",
    "lens": "error_path",
    "given": "Canary run completes but expected artifact metadata or content is absent",
    "expect": "provider_canary_artifact_missing."
  },
  {
    "name": "canary metrics failed",
    "lens": "error_path",
    "given": "Metrics endpoint returns unauthorized, unavailable, or missing provider lifecycle series",
    "expect": "provider_canary_metrics_failed."
  },
  {
    "name": "canary audit failed",
    "lens": "error_path",
    "given": "Audit lookup lacks ownership trace or canary tag",
    "expect": "provider_canary_audit_failed."
  },
  {
    "name": "preflight policy path redaction",
    "lens": "error_path",
    "given": "production-preflight uses unreadable, oversized, invalid JSON, and invalid UTF-8 policy path fixtures",
    "expect": "Named provider policy failures with source_kind=path and no raw path, JSON, executable path, cwd, env value, or token in output."
  }
]
```

### Error Rescue Coverage Addendum

Reviewers must verify the following coverage before GREEN:

- T1 error rescue rows are covered by policy parse, command escape, provider-specific unsafe setting, and failure-code schema tests.
- T2 error rescue rows are covered by missing policy, empty policy, policy source conflict, unknown mode, disabled entry, missing env, invalid spend controls, binary unavailable, command denial, prompt too large, active limit, hourly limit, and timeout limit tests.
- T3 error rescue rows are covered by metadata injection denial, spawn unavailable, missing handoff validation, approval bridge unsupported, input bridge unsupported, ACP permission request unsupported, timeout, cancellation, and redaction tests.
- T4 error rescue rows are covered by worker startup failure variants, adapter gate denial, rollback drift claim denial, prompt/active/hourly/timeout spend denial, adapter readiness failure, non-retryable policy denial, lifecycle metric, and path handling tests.
- T5 error rescue rows are covered by server startup failure variants, readiness invalid activation, source-kind-only diagnostics, and redaction tests.
- T6 error rescue rows are covered by implicit placement, wait=1, disabled gate, missing policy, prompt/active/hourly/timeout spend denials, allowed-run preservation, later enqueue failure reservation release, input bridge unsupported, approval bridge unsupported, no-forbidden-route, and lifecycle metric tests.
- T7 error rescue rows are covered by preflight provider failures, no-spend smoke assertions, spend-confirmation denial, every provider canary failure variant, manifest forbidden-surface rejection, and path redaction tests.
- T8 error rescue rows are covered by OpenAPI forbidden route fixtures, endpoint inventory forbidden route fixtures, product truth assertions, and `PROJECT.md` diff guard.

### Architect Revision 1 Self-Review

1. Spec coverage: all original acceptance criteria remain covered by T1 through T8, with additional coverage for architect-noted missing variants.
2. Placeholder scan: this revision adds no deferred implementation markers.
3. Type consistency: T4 now imports every T3 adapter `hostedProviderCommand` option contract using the same `ProviderResolvedCommand | undefined` signature exported by T3.
4. Ownership disjoint: no file ownership changes were made; T3 and T7 are structured internally without adding cross-task file overlap.
5. Context files real: no new context file paths were introduced by this revision.
6. Acceptance testable: every added acceptance item names an observable response, metric, side-effect absence, redaction assertion, or command result.
7. Dependency order sane: addenda preserve the existing T1 -> T2/T3 -> T4/T5 -> T6 -> T7 -> T8 order.
8. Checks runnable: no new check command depends on live provider spend; live provider canary remains explicit.
9. Error/rescue map present: every architect-noted failure branch has a required error-path or integration test in the owning task.
10. Observability present: lifecycle metrics are now explicit for accepted, denied, failed, timed out, cancelled, and spend-control-denied provider runs.
11. Test cases enumerate acceptance: each new acceptance cluster has matching test cases in the owning task addendum.
12. Integration contracts walk: T4 imports resolve to T3 exports; all previous cross-task imports remain unchanged.
13. Contract types match: provider policy, activation, resolved command, adapter option, and canary contracts retain the existing signatures.

### Architect Revision 1 Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case, including architect-added criteria.
- [x] Every error_rescue_map entry has a matching `error_path`, `happy_shadow_empty`, or `integration` test requirement.
- [x] Every integration contract import resolves to a real export elsewhere.
- [x] Every context file path still exists in the project; this revision adds no new context file path.
- [x] No task edits a file owned by another task.
- [x] No incomplete marker text is present in this revision.
- [x] Complexity remains L; oversized T3 and T7 now have subtask-level implementation/review matrices rather than new worktree splits.
