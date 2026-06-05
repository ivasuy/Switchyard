# Phase 19 / R20 Implementation Plan: Production Subprocess And PTY Sandbox Foundation

## Phase

- Branch: `agent/phase-19-r20-production-subprocess-pty`
- Spec: `docs/superpowers/specs/2026-05-31-phase-19-r20-production-subprocess-pty.md`
- Scope: worker-internal production sandbox substrate for process and PTY-shaped jobs.
- Explicit non-goals: dashboard, TUI, public arbitrary execution routes, hosted Codex/Claude/OpenCode production execution, generic process/PTY public runtime adapters, hosted tools, browser automation, Cursor/OpenClaw/Paperclip, hosted debate.

## Architecture

Operator env/manifest resolves into `ResolvedHostedSandboxConfig`. `HostedSandboxPolicy` remains the single trust boundary. Allowed production jobs receive a policy-owned `SandboxResolvedCommand`; executors never trust request-owned executable path, cwd, env, or argv. `HostedSandboxService` continues normalizing terminal status, output limits, cancellation, transcript capture, artifacts, metrics, and redaction. The worker constructs this service internally only; no HTTP routes are added.

PTY is driver-injected and fail-closed in R20. Node has no PTY builtin, so absence of an explicit PTY driver must report `sandbox_pty_unavailable`, not silently degrade to process execution.

## Verification

- `pnpm --filter @switchyard/contracts test -- sandbox.contract.test.ts`
- `pnpm --filter @switchyard/core test -- hosted-sandbox-service.test.ts`
- `pnpm --filter @switchyard/adapters test -- production-hosted-sandbox-executor.test.ts substrates.test.ts`
- `pnpm --filter @switchyard/worker test -- hosted-worker.test.ts production-worker-readiness.test.ts production-config.test.ts`
- `pnpm --filter @switchyard/server test -- hosted-server.test.ts production-config.test.ts production-readiness.test.ts`
- `pnpm exec vitest run scripts/production-preflight.test.ts deploy/production/production-manifest.test.ts`
- `pnpm exec vitest run scripts/production-sandbox-smoke.test.ts`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm --filter @switchyard/contracts openapi:check:hosted`
- `pnpm production:sandbox-smoke`
- `pnpm typecheck`

## Task Graph

### P19-T1-sandbox-contract-policy

```json
{
  "id": "P19-T1-sandbox-contract-policy",
  "title": "Extend sandbox contracts for production command policy",
  "files": [
    "packages/contracts/src/sandbox.ts",
    "packages/contracts/test/sandbox.contract.test.ts"
  ],
  "dependencies": [],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-19-r20-production-subprocess-pty.md",
    "PRODUCT.md",
    "packages/contracts/src/sandbox.ts",
    "packages/contracts/test/sandbox.contract.test.ts",
    "packages/core/src/services/hosted-sandbox-service.ts",
    "scripts/hosted-sandbox-smoke.ts"
  ],
  "instructions": "Extend the existing sandbox contract in place. Add schemas/types for real sandbox execution mode, isolation driver, disabled-only network policy, command policy entries, and policy-resolved commands. A policy entry must include commandId, adapterType process|pty, absolute normalized executablePath, fixedArgs default [], allowUserArgs default false, cwdPrefixes as non-empty absolute normalized paths, envAllowlist default [], allowStdin default false, allowPtyInput default false, isolation { driver: none|container|microvm|external, required: boolean }, and networkPolicy limited to disabled for R20. Reject blank executable paths, placeholder paths/segments, relative paths, traversal paths, shell/tool basenames, and absolute denylisted executables such as /bin/bash, /usr/bin/sh, /usr/bin/python, /usr/bin/codex, /usr/bin/claude, and /usr/bin/opencode. Add named errors: sandbox_real_execution_disabled, sandbox_executable_denied, sandbox_cwd_denied, sandbox_env_denied, sandbox_pty_unavailable, sandbox_spawn_failed, sandbox_isolation_unavailable. Preserve existing fake command ids and request/result behavior.",
  "acceptance": [
    "Existing fake process and fake PTY request tests still pass unchanged.",
    "Valid production process and PTY command policy entries parse only with absolute normalized executablePath and non-empty absolute cwdPrefixes.",
    "Blank, placeholder, shell/tool basename, absolute denylisted, relative, and traversing executable paths are rejected.",
    "Relative cwd prefixes, traversing cwd prefixes, unsupported network policy values, and malformed env allowlist entries are rejected.",
    "New named sandbox errors parse and unknown errors remain rejected.",
    "No public route, OpenAPI path, runtime adapter, or worker behavior is introduced."
  ],
  "checks": [
    "pnpm --filter @switchyard/contracts test -- sandbox.contract.test.ts",
    "pnpm --filter @switchyard/contracts typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "sandboxCommandPolicyEntrySchema.parse",
      "failure": "relative or traversing executablePath/cwdPrefixes",
      "exception": "ZodError",
      "rescue": "Reject policy before config/readiness can mark sandbox ready.",
      "user_sees": "sandbox_policy_invalid; no job executes."
    },
    {
      "codepath": "sandboxCommandPolicyEntrySchema.parse",
      "failure": "blank, placeholder, shell/tool basename, or absolute denylisted executable path",
      "exception": "ZodError",
      "rescue": "Reject the policy entry before config/readiness can mark sandbox ready.",
      "user_sees": "sandbox_executable_denied or sandbox_policy_invalid; no job executes."
    },
    {
      "codepath": "sandboxCommandPolicyEntrySchema.parse",
      "failure": "networkPolicy is not disabled",
      "exception": "ZodError",
      "rescue": "Reject network-enabled policy because R20 makes no network sandbox claim.",
      "user_sees": "sandbox_policy_invalid with redacted diagnostics."
    },
    {
      "codepath": "sandboxNamedErrorSchema.parse",
      "failure": "unknown sandbox error supplied",
      "exception": "ZodError",
      "rescue": "Reject unknown codes to keep readiness/metrics low-cardinality.",
      "user_sees": "test/review failure, not a runtime route."
    }
  ],
  "observability": {
    "logs": [],
    "success_metric": "Contract tests cover fake compatibility plus production policy positive and negative schemas.",
    "failure_metric": "Zod rejects invalid production command policy before runtime execution."
  },
  "test_cases": [
    {
      "name": "keeps fake command contract stable",
      "lens": "happy",
      "given": "Existing switchyard.fake.echo process request",
      "expect": "sandboxJobRequestSchema parses and fake command ids remain stable."
    },
    {
      "name": "parses valid production process policy",
      "lens": "happy",
      "given": "commandId deploy.safe.echo, adapterType process, executablePath /usr/bin/printf, cwdPrefixes ['/srv/switchyard/work'], networkPolicy disabled",
      "expect": "sandboxCommandPolicyEntrySchema parses with defaults."
    },
    {
      "name": "parses valid production pty policy",
      "lens": "happy",
      "given": "adapterType pty with allowPtyInput true",
      "expect": "schema parses."
    },
    {
      "name": "rejects unsafe paths and network",
      "lens": "error_path",
      "given": "relative executable, traversing cwd prefix, or networkPolicy enabled",
      "expect": "ZodError."
    },
    {
      "name": "rejects denylisted and placeholder executable config",
      "lens": "error_path",
      "given": "executablePath /bin/bash, /usr/bin/python, codex, /usr/bin/opencode, /srv/switchyard/example-command, or a blank path",
      "expect": "ZodError or sandbox policy validation failure before worker startup."
    },
    {
      "name": "parses new named errors",
      "lens": "happy",
      "given": "sandbox_real_execution_disabled, sandbox_executable_denied, sandbox_cwd_denied, sandbox_env_denied, sandbox_pty_unavailable, sandbox_spawn_failed, and sandbox_isolation_unavailable",
      "expect": "every R20 named error parses through sandboxNamedErrorSchema; unknown errors still throw."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "sandboxRealExecutionModeSchema",
        "kind": "constant",
        "signature": "z.enum(['disabled','enabled'])"
      },
      {
        "name": "sandboxCommandPolicyEntrySchema",
        "kind": "constant",
        "signature": "Zod schema for one allowlisted production process or PTY command"
      },
      {
        "name": "sandboxResolvedCommandSchema",
        "kind": "constant",
        "signature": "Zod schema for policy-approved executablePath, argv, cwd, env, adapterType, pty policy, and isolation metadata"
      },
      {
        "name": "SandboxCommandPolicyEntry",
        "kind": "type",
        "signature": "z.infer<typeof sandboxCommandPolicyEntrySchema>"
      },
      {
        "name": "SandboxResolvedCommand",
        "kind": "type",
        "signature": "z.infer<typeof sandboxResolvedCommandSchema>"
      }
    ],
    "imports_from_other_tasks": [],
    "file_paths_consumed_by_other_tasks": [
      "packages/contracts/src/sandbox.ts"
    ]
  }
}
```

### P19-T2-core-sandbox-policy-gate

```json
{
  "id": "P19-T2-core-sandbox-policy-gate",
  "title": "Add core production sandbox policy gate",
  "files": [
    "packages/core/src/services/hosted-sandbox-service.ts",
    "packages/core/test/hosted-sandbox-service.test.ts"
  ],
  "dependencies": [
    "P19-T1-sandbox-contract-policy"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-19-r20-production-subprocess-pty.md",
    "PRODUCT.md",
    "packages/contracts/src/sandbox.ts",
    "packages/core/src/services/hosted-sandbox-service.ts",
    "packages/core/test/hosted-sandbox-service.test.ts",
    "packages/testkit/src/fake-hosted-sandbox-executor.ts",
    "scripts/hosted-sandbox-smoke.ts"
  ],
  "instructions": "Extend HostedSandboxService and HostedSandboxPolicy in place. Keep core free of child_process, node-pty, @switchyard/adapters, browser, fetch, github, repo, and shell imports. Extend ResolvedHostedSandboxConfig with realExecution: { mode, commandPolicy, ptyDriverConfigured, redactedSummary }. resolveHostedSandboxConfig defaults real execution to disabled and parses SWITCHYARD_SANDBOX_REAL_EXECUTION plus SWITCHYARD_SANDBOX_COMMAND_POLICY_JSON. Treat JSON-in-env as a small operator catalog: enforce maximum JSON bytes, maximum entry count, duplicate commandId rejection, and redacted parse diagnostics that expose only code/path/counts. If real execution is enabled without valid non-empty policy, config.valid must be false with sandbox_policy_missing or sandbox_policy_invalid. Reject policy entries with placeholder executable paths, shell/tool basenames, absolute denylisted executables, or isolation.required=true unless the selected isolation driver is actually implemented/configured; use sandbox_executable_denied or sandbox_isolation_unavailable before worker startup. Change HostedSandboxPolicy.decide to inspect full SandboxJobRequest. Fake commands retain existing behavior. Non-fake commands are denied unless real execution is enabled and commandId exactly matches policy whose adapterType, cwd prefix, env keys, stdin, argv, and PTY input settings allow the request. Pass resolvedCommand to executor options. Extend HostedSandboxExecutorOutput with optional reasonCode so executor-specific named failures survive normalization.",
  "acceptance": [
    "Fake sandbox behavior remains backwards compatible.",
    "Real execution disabled denies non-fake commandIds with sandbox_real_execution_disabled before executor invocation.",
    "Real execution enabled with matching policy passes resolvedCommand to executor.",
    "Policy denies cwd outside prefixes with sandbox_cwd_denied and env keys outside envAllowlist with sandbox_env_denied.",
    "Policy denies stdin or PTY input when disabled by policy.",
    "Oversized policy JSON, duplicate commandId entries, placeholder paths, shell/tool basenames, absolute denylisted executables, and unsupported required isolation all fail config/readiness before executor invocation.",
    "Malformed policy diagnostics are redacted and never echo executablePath, cwd, argv, env, stdin, or raw JSON.",
    "Policy exceptions become sandbox_policy_failed.",
    "Executor output reasonCode values such as sandbox_pty_unavailable and sandbox_spawn_failed are preserved.",
    "Core source still contains no real execution imports."
  ],
  "checks": [
    "pnpm --filter @switchyard/core test -- hosted-sandbox-service.test.ts",
    "pnpm --filter @switchyard/core typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "resolveHostedSandboxConfig",
      "failure": "unsupported SWITCHYARD_SANDBOX_REAL_EXECUTION",
      "exception": "explicit validation branch",
      "rescue": "Return config.valid=false with sandbox_config_invalid.",
      "user_sees": "worker/server config or preflight fails before execution."
    },
    {
      "codepath": "resolveHostedSandboxConfig",
      "failure": "real execution enabled but policy missing or malformed",
      "exception": "SyntaxError or ZodError",
      "rescue": "Set sandbox_policy_missing or sandbox_policy_invalid with redacted diagnostics.",
      "user_sees": "readiness/preflight reports named sandbox code."
    },
    {
      "codepath": "resolveHostedSandboxConfig",
      "failure": "policy JSON is oversized, has too many entries, or contains duplicate commandId values",
      "exception": "explicit validation branch",
      "rescue": "Set sandbox_policy_invalid with counts-only redacted diagnostics.",
      "user_sees": "readiness/preflight reports sandbox_policy_invalid without raw policy contents."
    },
    {
      "codepath": "resolveHostedSandboxConfig",
      "failure": "policy executable is a shell/tool basename, an absolute denylisted executable, or a placeholder path",
      "exception": "explicit validation branch",
      "rescue": "Set sandbox_executable_denied or sandbox_policy_invalid before readiness can pass.",
      "user_sees": "worker startup/readiness fails before any process starts."
    },
    {
      "codepath": "resolveHostedSandboxConfig",
      "failure": "policy requires unsupported isolation driver",
      "exception": "explicit validation branch",
      "rescue": "Set sandbox_isolation_unavailable and keep sandbox readiness fail-closed.",
      "user_sees": "readiness/preflight reports sandbox_isolation_unavailable."
    },
    {
      "codepath": "HostedSandboxPolicy.decide",
      "failure": "non-fake command while real execution disabled",
      "exception": "no throw",
      "rescue": "Return deny decision with sandbox_real_execution_disabled.",
      "user_sees": "internal failed SandboxJobResult; no public route."
    },
    {
      "codepath": "HostedSandboxPolicy.decide",
      "failure": "cwd/env/stdin/pty violates policy",
      "exception": "no throw",
      "rescue": "Return low-cardinality deny reason and never call executor.",
      "user_sees": "named sandbox failure with redacted diagnostics."
    },
    {
      "codepath": "dispatchExecution",
      "failure": "executor throws unexpected error",
      "exception": "Error",
      "rescue": "Map to sandbox_process_failed unless timeout/abort is known; redact error payload.",
      "user_sees": "failed SandboxJobResult with named reason."
    }
  ],
  "observability": {
    "logs": [
      "info sandbox.job.started with jobId, runId, runtimeMode, adapterType, commandId only",
      "warn sandbox.job.output_truncated with byte counts only",
      "warn sandbox.job.artifact_capture_failed with named reason only"
    ],
    "success_metric": "sandbox.jobs, sandbox.allowed, and sandbox.completed increment for allowed completed jobs.",
    "failure_metric": "sandbox.denied, sandbox.failed, sandbox.timeout, sandbox.cancelled increment by terminal outcome."
  },
  "test_cases": [
    {
      "name": "fake allowlist remains compatible",
      "lens": "happy",
      "given": "Default config and switchyard.fake.echo",
      "expect": "completed and executor called once."
    },
    {
      "name": "real disabled denies non-fake",
      "lens": "happy_shadow_nil",
      "given": "Default config and commandId deploy.safe.echo",
      "expect": "sandbox_real_execution_disabled and executor not called."
    },
    {
      "name": "real enabled requires policy",
      "lens": "error_path",
      "given": "SWITCHYARD_SANDBOX_REAL_EXECUTION=enabled without policy",
      "expect": "config invalid and readiness sandbox_policy_missing."
    },
    {
      "name": "policy JSON is bounded and deterministic",
      "lens": "error_path",
      "given": "oversized JSON, duplicate commandId entries, malformed JSON, or too many command policy entries",
      "expect": "config invalid with sandbox_policy_invalid and diagnostics contain only counts/paths/codes."
    },
    {
      "name": "denylisted executable config fails before startup",
      "lens": "error_path",
      "given": "policy executablePath /bin/bash, /usr/bin/sh, /usr/bin/python, /usr/bin/codex, /usr/bin/claude, or /usr/bin/opencode",
      "expect": "config invalid with sandbox_executable_denied or sandbox_policy_invalid and executor not called."
    },
    {
      "name": "unsupported isolation requirement fails closed",
      "lens": "error_path",
      "given": "policy isolation { driver: 'microvm', required: true } without a configured supported driver",
      "expect": "readiness fails with sandbox_isolation_unavailable before worker claim."
    },
    {
      "name": "real policy passes resolved command",
      "lens": "happy",
      "given": "Enabled policy for deploy.safe.echo and cwd under prefix",
      "expect": "executor receives resolvedCommand."
    },
    {
      "name": "policy denials are named",
      "lens": "error_path",
      "given": "cwd outside prefix, env outside allowlist, stdin/pty input disabled",
      "expect": "named denial and executor not called."
    },
    {
      "name": "executor reason survives normalization",
      "lens": "integration",
      "given": "executor returns reasonCode sandbox_pty_unavailable",
      "expect": "SandboxJobResult.reasonCode is sandbox_pty_unavailable."
    },
    {
      "name": "core keeps forbidden imports absent",
      "lens": "edge_boundary",
      "given": "hosted-sandbox-service.ts source",
      "expect": "no child_process, node-pty, @switchyard/adapters, browser, fetch, github, repo, or shell imports."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "HostedSandboxExecutorPort",
        "kind": "interface",
        "signature": "execute(request: SandboxJobRequest & { resourceLimits: SandboxResourceLimits }, options?: { signal?: AbortSignal; resolvedCommand?: SandboxResolvedCommand }) => Promise<HostedSandboxExecutorOutput>"
      },
      {
        "name": "HostedSandboxExecutorOutput",
        "kind": "interface",
        "signature": "{ status; reasonCode?; exitCode?; stdout?; stderr?; artifacts?; metadata? }"
      },
      {
        "name": "HostedSandboxPolicy",
        "kind": "class",
        "signature": "decide(input: { request: SandboxJobRequest; limits: SandboxResourceLimits }) => SandboxPolicyDecision & { resolvedCommand?: SandboxResolvedCommand }"
      },
      {
        "name": "HostedSandboxService",
        "kind": "class",
        "signature": "new HostedSandboxService({ config, executor, ...deps })"
      },
      {
        "name": "resolveHostedSandboxConfig",
        "kind": "function",
        "signature": "resolveHostedSandboxConfig(input) => ResolvedHostedSandboxConfig"
      },
      {
        "name": "checkHostedSandboxReadiness",
        "kind": "function",
        "signature": "checkHostedSandboxReadiness(config) => { ok: boolean; code?: SandboxNamedError }"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P19-T1-sandbox-contract-policy",
        "name": "SandboxCommandPolicyEntry",
        "signature": "z.infer<typeof sandboxCommandPolicyEntrySchema>"
      },
      {
        "from_task": "P19-T1-sandbox-contract-policy",
        "name": "SandboxResolvedCommand",
        "signature": "z.infer<typeof sandboxResolvedCommandSchema>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/services/hosted-sandbox-service.ts"
    ]
  }
}
```

### P19-T3-production-sandbox-executor

```json
{
  "id": "P19-T3-production-sandbox-executor",
  "title": "Add production process and PTY executor substrate",
  "files": [
    "packages/adapters/src/sandbox/production-hosted-sandbox-executor.ts",
    "packages/adapters/src/index.ts",
    "packages/adapters/test/production-hosted-sandbox-executor.test.ts"
  ],
  "dependencies": [
    "P19-T1-sandbox-contract-policy",
    "P19-T2-core-sandbox-policy-gate"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-19-r20-production-subprocess-pty.md",
    "PRODUCT.md",
    "packages/core/src/services/hosted-sandbox-service.ts",
    "packages/adapters/src/substrates/process-runner.ts",
    "packages/adapters/src/tools/local-process-tool-executor.ts",
    "packages/adapters/test/substrates.test.ts",
    "packages/adapters/test/real-tool-adapters.test.ts",
    "packages/adapters/src/index.ts"
  ],
  "instructions": "Create a new adapter substrate, not a runtime adapter. Export ProductionHostedSandboxExecutor plus process and PTY factory interfaces from packages/adapters/src/index.ts. The executor implements HostedSandboxExecutorPort and requires options.resolvedCommand for real execution. Process execution uses node:child_process.spawn through an injectable factory, shell:false, stdio pipes, exact argv/cwd/env from resolvedCommand, bounded output collection, stdin write only when policy allowed, and AbortSignal kill handling. PTY execution uses an injectable ptyFactory; when absent, return status failed with sandbox_pty_unavailable. PTY driver spawn errors, close failures, stream/data errors, write failures, resize failures, and abort cleanup must return named low-cardinality sandbox reason codes and must never fall back to process execution. Stdin write failures in the process path must also map to named sandbox failure and clean up the child. Do not register runtime adapters, add public APIs, invoke provider CLIs, or import testkit from production source.",
  "acceptance": [
    "Process execution calls spawn with shell:false and policy-resolved executablePath, argv, cwd, env.",
    "Injection-like argv entries remain literal argv entries.",
    "Missing resolvedCommand fails before spawn.",
    "Spawn errors map to sandbox_spawn_failed.",
    "Non-zero close returns failed with exitCode and sandbox_process_failed.",
    "AbortSignal cancellation kills child and settles cleanly.",
    "Output collection is bounded.",
    "PTY without ptyFactory returns sandbox_pty_unavailable.",
    "PTY spawn, close, stream/data, write, resize, and abort cleanup failures return named sandbox failures and never fall back to process execution.",
    "Process stdin write failure kills/cleans up the child and returns a named sandbox failure.",
    "PTY fake driver receives input and resize frames in order.",
    "Executor is exported for worker construction but no runtime adapter map changes are made."
  ],
  "checks": [
    "pnpm --filter @switchyard/adapters test -- production-hosted-sandbox-executor.test.ts substrates.test.ts",
    "pnpm --filter @switchyard/adapters typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "ProductionHostedSandboxExecutor.execute",
      "failure": "options.resolvedCommand missing",
      "exception": "no throw",
      "rescue": "Return failed output with sandbox_policy_missing.",
      "user_sees": "failed SandboxJobResult; no process spawned."
    },
    {
      "codepath": "runProcess",
      "failure": "spawn emits error",
      "exception": "Error event",
      "rescue": "Return sandbox_spawn_failed with redacted metadata.",
      "user_sees": "sandbox_spawn_failed."
    },
    {
      "codepath": "runProcess",
      "failure": "non-zero exit",
      "exception": "close event code != 0",
      "rescue": "Return failed with exitCode and bounded output.",
      "user_sees": "sandbox_process_failed."
    },
    {
      "codepath": "runProcess",
      "failure": "AbortSignal fires",
      "exception": "abort event",
      "rescue": "SIGTERM once, cleanup listener, let service classify timeout/cancel.",
      "user_sees": "timeout or cancelled."
    },
    {
      "codepath": "runPty",
      "failure": "no ptyFactory",
      "exception": "no throw",
      "rescue": "Return sandbox_pty_unavailable.",
      "user_sees": "sandbox_pty_unavailable; no PTY starts."
    },
    {
      "codepath": "runPty",
      "failure": "ptyFactory.spawn throws/emits error, PTY stream errors, or PTY closes with failure",
      "exception": "Error event or thrown Error",
      "rescue": "Return sandbox_process_failed or sandbox_pty_unavailable with redacted metadata and never retry as process.",
      "user_sees": "failed SandboxJobResult with named reason."
    },
    {
      "codepath": "runPty",
      "failure": "PTY write or resize fails after spawn",
      "exception": "Error from write/resize",
      "rescue": "Kill/close PTY, cleanup listeners, return sandbox_process_failed with redacted metadata.",
      "user_sees": "failed SandboxJobResult with named reason; no fallback execution."
    },
    {
      "codepath": "runProcess",
      "failure": "stdin write fails or stream errors",
      "exception": "Error event or rejected write",
      "rescue": "Kill child, cleanup listeners, return sandbox_process_failed with redacted metadata.",
      "user_sees": "failed SandboxJobResult with named reason."
    }
  ],
  "observability": {
    "logs": [
      "info sandbox.executor.process.started with jobId, commandId, adapterType only",
      "info sandbox.executor.process.completed with durationMs, exitCode, outputBytes only",
      "warn sandbox.executor.process.failed with reasonCode only",
      "warn sandbox.executor.pty.unavailable with jobId and commandId only"
    ],
    "success_metric": "Allowed process and fake-PTY-driver executions return completed output through service.",
    "failure_metric": "spawn, pty unavailable, output flood, nonzero, abort, missing policy produce named reasons."
  },
  "test_cases": [
    {
      "name": "spawns process without shell",
      "lens": "happy",
      "given": "resolved command argv ['safe','; rm -rf /']",
      "expect": "fake processFactory records shell:false and literal argv."
    },
    {
      "name": "missing resolved command fails before spawn",
      "lens": "happy_shadow_nil",
      "given": "execute without resolvedCommand",
      "expect": "failed sandbox_policy_missing and processFactory not called."
    },
    {
      "name": "spawn error and nonzero are named",
      "lens": "error_path",
      "given": "fake child error or code 7",
      "expect": "sandbox_spawn_failed or sandbox_process_failed with exitCode."
    },
    {
      "name": "abort kills process",
      "lens": "error_path",
      "given": "AbortController aborts while child pending",
      "expect": "kill called once and executor settles."
    },
    {
      "name": "output flood remains bounded",
      "lens": "edge_output_limit",
      "given": "stdout larger than combinedOutputBytes",
      "expect": "returned output bounded for service classification."
    },
    {
      "name": "pty unavailable and fake pty driver paths",
      "lens": "happy",
      "given": "pty without factory, then pty with fake factory and frames",
      "expect": "sandbox_pty_unavailable first; fake factory receives dimensions/write/resize second."
    },
    {
      "name": "pty driver failures are fail-closed",
      "lens": "error_path",
      "given": "ptyFactory spawn throws, data stream errors, close failure, write failure, resize failure, and abort",
      "expect": "named sandbox failure, listeners cleaned up, and no process fallback."
    },
    {
      "name": "stdin write failure is named",
      "lens": "error_path",
      "given": "process stdin emits error while writing allowed stdin",
      "expect": "child is killed/cleaned up and result reasonCode is sandbox_process_failed."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "ProductionHostedSandboxExecutor",
        "kind": "class",
        "signature": "new ProductionHostedSandboxExecutor(options?: { processFactory?: SandboxProcessFactory; ptyFactory?: SandboxPtyFactory; logger?: RuntimeLogger }) implements HostedSandboxExecutorPort"
      },
      {
        "name": "SandboxProcessFactory",
        "kind": "interface",
        "signature": "spawn(executablePath: string, argv: string[], options: { cwd: string; env: Record<string,string>; shell: false; stdio: ['pipe','pipe','pipe'] }) => ChildLike"
      },
      {
        "name": "SandboxPtyFactory",
        "kind": "interface",
        "signature": "spawn(executablePath: string, argv: string[], options: { cwd: string; env: Record<string,string>; cols: number; rows: number }) => PtyLike"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P19-T2-core-sandbox-policy-gate",
        "name": "HostedSandboxExecutorPort",
        "signature": "execute(request: SandboxJobRequest & { resourceLimits: SandboxResourceLimits }, options?: { signal?: AbortSignal; resolvedCommand?: SandboxResolvedCommand }) => Promise<HostedSandboxExecutorOutput>"
      },
      {
        "from_task": "P19-T1-sandbox-contract-policy",
        "name": "SandboxResolvedCommand",
        "signature": "z.infer<typeof sandboxResolvedCommandSchema>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/adapters/src/sandbox/production-hosted-sandbox-executor.ts",
      "packages/adapters/src/index.ts"
    ]
  }
}
```

### P19-T4-worker-internal-sandbox-wiring

```json
{
  "id": "P19-T4-worker-internal-sandbox-wiring",
  "title": "Wire worker-internal sandbox service and readiness",
  "files": [
    "apps/worker/src/sandbox.ts",
    "apps/worker/src/worker.ts",
    "apps/worker/src/config.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts",
    "apps/worker/test/production-config.test.ts"
  ],
  "dependencies": [
    "P19-T2-core-sandbox-policy-gate",
    "P19-T3-production-sandbox-executor"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-19-r20-production-subprocess-pty.md",
    "PRODUCT.md",
    "apps/worker/src/worker.ts",
    "apps/worker/src/config.ts",
    "apps/worker/src/hosted-runtime-adapters.ts",
    "apps/worker/test/hosted-worker.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts",
    "packages/testkit/src/fake-hosted-sandbox-executor.ts"
  ],
  "instructions": "Add apps/worker/src/sandbox.ts as the worker factory for HostedSandboxService. Use FakeHostedSandboxExecutor when config.sandbox.realExecution.mode is disabled and ProductionHostedSandboxExecutor when enabled. Tests may inject processFactory and ptyFactory through createHostedWorker deps. Update worker.ts to construct through this factory and include sandbox readiness diagnostics that expose only mode, policy count, and pty driver availability. Do not register process or PTY runtime adapters. Keep production hosted Codex/Claude/OpenCode gating unchanged.",
  "acceptance": [
    "Default worker config still processes hosted fake deterministic jobs.",
    "Worker readiness passes with default fake-only sandbox config.",
    "Worker readiness fails with sandbox_policy_missing when real execution is enabled without policy.",
    "Worker can construct production sandbox service with injected fake processFactory for internal service test.",
    "No generic process, PTY, shell, browser, Cursor, OpenClaw, Paperclip, Codex hosted, Claude hosted, or OpenCode hosted behavior is added beyond existing gates.",
    "hosted-runtime-adapters.ts remains limited to fake, codex.exec_json, claude_code.sdk, and opencode.acp.",
    "Production claim readiness refuses jobs when sandbox gate is not ready."
  ],
  "checks": [
    "pnpm --filter @switchyard/worker test -- hosted-worker.test.ts production-worker-readiness.test.ts production-config.test.ts",
    "pnpm --filter @switchyard/worker typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "createWorkerHostedSandboxService",
      "failure": "real execution disabled",
      "exception": "no throw",
      "rescue": "Use FakeHostedSandboxExecutor.",
      "user_sees": "readiness passes with disabled real execution summary."
    },
    {
      "codepath": "createWorkerHostedSandboxService",
      "failure": "real execution enabled but config invalid",
      "exception": "ConfigError or readiness false",
      "rescue": "Fail startup/readiness before queue claim.",
      "user_sees": "sandbox_policy_missing, sandbox_policy_invalid, or sandbox_config_invalid."
    },
    {
      "codepath": "worker.ready/tick",
      "failure": "sandbox readiness fails during strict claim readiness",
      "exception": "no throw",
      "rescue": "Return ok:false and do not claim work.",
      "user_sees": "checks.sandbox.code."
    },
    {
      "codepath": "worker.ready",
      "failure": "PTY policy requires driver but no driver configured",
      "exception": "no throw",
      "rescue": "Expose sandbox_pty_unavailable and do not start PTY.",
      "user_sees": "checks.sandbox.code."
    },
    {
      "codepath": "buildHostedWorkerAdapters",
      "failure": "generic process/PTY adapter accidentally registered",
      "exception": "test failure",
      "rescue": "Keep adapter map unchanged.",
      "user_sees": "no new runtime mode or public route."
    }
  ],
  "observability": {
    "logs": [
      "worker readiness JSON checks.sandbox with ok/code and redacted summary"
    ],
    "success_metric": "worker readiness ok when fake-only or valid production sandbox posture is present.",
    "failure_metric": "worker readiness fails before queue claim when sandbox posture is invalid."
  },
  "test_cases": [
    {
      "name": "default fake worker still completes",
      "lens": "happy",
      "given": "existing hosted fake queued job",
      "expect": "tick true and run completed."
    },
    {
      "name": "real enabled missing policy blocks readiness",
      "lens": "error_path",
      "given": "SWITCHYARD_SANDBOX_REAL_EXECUTION=enabled without policy",
      "expect": "sandbox_policy_missing."
    },
    {
      "name": "strict claim skips queue on sandbox failure",
      "lens": "integration",
      "given": "production worker invalid sandbox and instrumented queue",
      "expect": "tick false and claim not called."
    },
    {
      "name": "production executor can be injected",
      "lens": "happy",
      "given": "enabled policy plus injected fake processFactory",
      "expect": "internal execute completes."
    },
    {
      "name": "hosted runtime adapters unchanged",
      "lens": "edge_boundary",
      "given": "staging config allowlisting known hosted runtimes",
      "expect": "adapter map lacks generic process, pty, shell, browser, Cursor, OpenClaw, Paperclip."
    },
    {
      "name": "production real runtime prohibition remains",
      "lens": "edge_regression",
      "given": "production with SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=enabled",
      "expect": "existing config_forbidden behavior."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "createWorkerHostedSandboxService",
        "kind": "function",
        "signature": "createWorkerHostedSandboxService(config: WorkerConfig, deps?: { processFactory?: SandboxProcessFactory; ptyFactory?: SandboxPtyFactory; logger?: RuntimeLogger }) => HostedSandboxService"
      },
      {
        "name": "loadWorkerConfig",
        "kind": "function",
        "signature": "loadWorkerConfig(env?: NodeJS.ProcessEnv) => WorkerConfig with sandbox: ResolvedHostedSandboxConfig"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P19-T2-core-sandbox-policy-gate",
        "name": "HostedSandboxService",
        "signature": "new HostedSandboxService({ config, executor, ...deps })"
      },
      {
        "from_task": "P19-T3-production-sandbox-executor",
        "name": "ProductionHostedSandboxExecutor",
        "signature": "new ProductionHostedSandboxExecutor(options?: { processFactory?: SandboxProcessFactory; ptyFactory?: SandboxPtyFactory; logger?: RuntimeLogger }) implements HostedSandboxExecutorPort"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "apps/worker/src/sandbox.ts",
      "apps/worker/src/config.ts"
    ]
  }
}
```

### P19-T5-production-ops-boundary-gates

```json
{
  "id": "P19-T5-production-ops-boundary-gates",
  "title": "Add production ops gates and public surface guards",
  "files": [
    "apps/server/src/config.ts",
    "apps/server/src/readiness.ts",
    "apps/server/test/hosted-server.test.ts",
    "apps/server/test/production-config.test.ts",
    "apps/server/test/production-readiness.test.ts",
    "scripts/production-manifest.ts",
    "scripts/production-preflight.ts",
    "scripts/production-preflight.test.ts",
    "deploy/production/manifest.json",
    "deploy/production/.env.example"
  ],
  "dependencies": [
    "P19-T1-sandbox-contract-policy",
    "P19-T2-core-sandbox-policy-gate",
    "P19-T4-worker-internal-sandbox-wiring"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-19-r20-production-subprocess-pty.md",
    "PRODUCT.md",
    "apps/server/src/config.ts",
    "apps/server/src/readiness.ts",
    "apps/server/test/hosted-server.test.ts",
    "scripts/production-manifest.ts",
    "scripts/production-preflight.ts",
    "deploy/production/manifest.json",
    "deploy/production/.env.example"
  ],
  "instructions": "Extend R19 production posture without adding execution surface. Server config/readiness may parse/report sandbox config posture but must not execute sandbox work. Production manifest validation must include sandboxExecution policy posture and keep public arbitrary execution surfaces forbidden. Add SWITCHYARD_SANDBOX_REAL_EXECUTION=disabled to examples as safe default. If env enables real sandbox execution, preflight requires valid command policy and disabled network policy before dependency checks. Add route guards for /shell, /process, and /command in addition to /sandbox, /exec, /pty, /terminal. Hosted OpenAPI remains free of these paths.",
  "acceptance": [
    "Production manifest default remains valid with fake.deterministic runtime allowlist, hosted real runtime disabled, and sandbox real execution disabled.",
    "Manifest validation fails if service names or forbiddenSurfaces expose sandbox, exec, shell, process, command, pty, or terminal.",
    "Production preflight emits sandboxGate pass for disabled posture and valid fake-only sandbox readiness.",
    "Production preflight emits sandbox_policy_missing or sandbox_policy_invalid when real sandbox execution is enabled without valid policy.",
    "Hosted server POST to /exec, /shell, /process, /command, /pty, /terminal, /sandbox returns 404.",
    "Hosted OpenAPI has no forbidden public route path.",
    "Server readiness exposes sandbox diagnostics without raw command policy, env values, cwd, argv, executable paths.",
    "Production hosted real runtime execution remains forbidden for Codex, Claude Code, OpenCode."
  ],
  "checks": [
    "pnpm --filter @switchyard/server test -- hosted-server.test.ts production-config.test.ts production-readiness.test.ts",
    "pnpm exec vitest run scripts/production-preflight.test.ts deploy/production/production-manifest.test.ts",
    "pnpm --filter @switchyard/contracts openapi:check",
    "pnpm --filter @switchyard/contracts openapi:check:hosted"
  ],
  "error_rescue_map": [
    {
      "codepath": "validateProductionManifest",
      "failure": "manifest declares forbidden arbitrary execution service or omits forbidden path posture",
      "exception": "no throw",
      "rescue": "Return manifest_forbidden_surface.",
      "user_sees": "preflight fails before dependencies."
    },
    {
      "codepath": "runProductionPreflight",
      "failure": "sandbox real execution enabled but policy missing/invalid",
      "exception": "ConfigError or readiness code",
      "rescue": "Record sandboxGate fail and skip downstream execution checks.",
      "user_sees": "named preflight failure with redacted diagnostics."
    },
    {
      "codepath": "server readiness",
      "failure": "sandbox config invalid",
      "exception": "no throw",
      "rescue": "Return checks.sandbox ok:false with low-cardinality code.",
      "user_sees": "GET /ready 503 with checks.sandbox.code."
    },
    {
      "codepath": "hosted server routing/OpenAPI",
      "failure": "accidental public arbitrary execution route exists",
      "exception": "test/check failure",
      "rescue": "Remove route/inventory entry before merge.",
      "user_sees": "no public route in R20."
    }
  ],
  "observability": {
    "logs": [
      "production preflight check sandboxGate pass|fail with code",
      "server readiness checks.sandbox code and redacted summary"
    ],
    "success_metric": "production preflight includes sandboxGate=pass for safe disabled or valid enabled posture.",
    "failure_metric": "preflight and /ready expose sandbox_policy_missing, sandbox_policy_invalid, sandbox_config_invalid, sandbox_pty_unavailable before work is claimed."
  },
  "test_cases": [
    {
      "name": "default production manifest remains valid",
      "lens": "happy",
      "given": "deploy/production/manifest.json with sandboxExecution disabled",
      "expect": "validation ok."
    },
    {
      "name": "forbidden service names and route posture fail",
      "lens": "error_path",
      "given": "service shell or missing /command forbidden surface",
      "expect": "manifest_forbidden_surface."
    },
    {
      "name": "preflight sandbox gate pass/fail",
      "lens": "integration",
      "given": "disabled posture then enabled-without-policy posture",
      "expect": "pass then sandbox_policy_missing."
    },
    {
      "name": "public routes absent",
      "lens": "edge_boundary",
      "given": "hosted server and generated OpenAPI",
      "expect": "no /exec, /shell, /process, /command, /pty, /terminal, /sandbox."
    },
    {
      "name": "production real runtime remains forbidden",
      "lens": "edge_regression",
      "given": "production env with hosted real runtimes enabled",
      "expect": "existing forbidden config/readiness behavior."
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "validateProductionManifest",
        "kind": "function",
        "signature": "validateProductionManifest(path: string) => Promise<ProductionManifestValidationResult>"
      },
      {
        "name": "runProductionPreflight",
        "kind": "function",
        "signature": "runProductionPreflight(options?: PreflightOptions) => Promise<ProductionPreflightResult>"
      },
      {
        "name": "loadServerConfig",
        "kind": "function",
        "signature": "loadServerConfig(env?: NodeJS.ProcessEnv) => ServerConfig with sandbox posture"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P19-T2-core-sandbox-policy-gate",
        "name": "checkHostedSandboxReadiness",
        "signature": "checkHostedSandboxReadiness(config) => { ok: boolean; code?: SandboxNamedError }"
      },
      {
        "from_task": "P19-T4-worker-internal-sandbox-wiring",
        "name": "loadWorkerConfig",
        "signature": "loadWorkerConfig(env?: NodeJS.ProcessEnv) => WorkerConfig with sandbox: ResolvedHostedSandboxConfig"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "scripts/production-manifest.ts",
      "scripts/production-preflight.ts",
      "deploy/production/manifest.json"
    ]
  }
}
```

### P19-T6-smoke-docs-product-truth

```json
{
  "id": "P19-T6-smoke-docs-product-truth",
  "title": "Update no-spend smoke and product truth",
  "files": [
    "scripts/hosted-sandbox-smoke.ts",
    "scripts/production-sandbox-smoke.test.ts",
    "package.json",
    "PRODUCT.md",
    "CHANGELOG.md",
    "ARCHITECTURE.md",
    "docs/development/API.md",
    "docs/development/DEVELOPMENT.md",
    "deploy/production/README.md"
  ],
  "dependencies": [
    "P19-T1-sandbox-contract-policy",
    "P19-T2-core-sandbox-policy-gate",
    "P19-T3-production-sandbox-executor",
    "P19-T4-worker-internal-sandbox-wiring",
    "P19-T5-production-ops-boundary-gates"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-05-31-phase-19-r20-production-subprocess-pty.md",
    "PRODUCT.md",
    "CHANGELOG.md",
    "ARCHITECTURE.md",
    "docs/development/API.md",
    "docs/development/DEVELOPMENT.md",
    "scripts/hosted-sandbox-smoke.ts",
    "deploy/production/README.md"
  ],
  "instructions": "Keep this task docs and no-spend verification only. Add a root package.json `production:sandbox-smoke` script and deterministic `scripts/production-sandbox-smoke.test.ts`. Extend hosted-sandbox-smoke or create a production smoke wrapper to cover existing fake behavior plus process, PTY, denied, timeout, cancel, output-limit, artifact, transcript redaction, readiness, local OpenAPI boundary, hosted OpenAPI boundary, default real-execution disabled posture, enabled-without-policy readiness failure, denied non-fake command while disabled, and fake PTY echo. Update PRODUCT.md and CHANGELOG.md to state R20 shipped an internal production sandbox foundation and ops gates, not public routes or hosted provider execution. Update ARCHITECTURE.md for worker-only sandbox construction, policy-first resolved command handoff, and PTY driver fail-closed boundary. Update API docs to explicitly say no /exec, /shell, /process, /command, /pty, /terminal, or /sandbox API exists. Update development and production docs with production:sandbox-smoke, preflight commands, and safe default env posture.",
  "acceptance": [
    "pnpm production:sandbox-smoke prints sandbox:smoke OK or production:sandbox-smoke OK.",
    "scripts/production-sandbox-smoke.test.ts covers process, PTY, denied, timeout, cancel, output-limit, artifact, transcript redaction, readiness, local OpenAPI boundary, hosted OpenAPI boundary, disabled real execution, and enabled-without-policy failure without live provider spend.",
    "PRODUCT.md snapshot and R20 section distinguish shipped internal foundation from unshipped public routes/adapters.",
    "CHANGELOG.md includes R20 summary and non-goals.",
    "ARCHITECTURE.md states worker-only sandbox construction and PTY driver fail-closed behavior.",
    "API docs state no public arbitrary subprocess/PTY routes exist.",
    "Development and production docs document production:sandbox-smoke, preflight, safe default env posture.",
    "Docs do not claim hosted Codex/Claude/OpenCode, Cursor/OpenClaw/Paperclip, browser, real tools, public arbitrary execution APIs, dashboard/TUI, or hosted debate shipped."
  ],
  "checks": [
    "pnpm production:sandbox-smoke",
    "pnpm exec vitest run scripts/production-sandbox-smoke.test.ts",
    "pnpm --filter @switchyard/contracts openapi:check",
    "pnpm --filter @switchyard/contracts openapi:check:hosted",
    "pnpm typecheck"
  ],
  "error_rescue_map": [
    {
      "codepath": "production-sandbox-smoke",
      "failure": "default sandbox readiness not ok or real disabled denial regresses",
      "exception": "assertion Error",
      "rescue": "Exit non-zero with sandbox_smoke_failed.",
      "user_sees": "operator sees failing smoke assertion."
    },
    {
      "codepath": "production-sandbox-smoke enabled-without-policy",
      "failure": "readiness passes without policy",
      "exception": "assertion Error",
      "rescue": "Fail smoke because policy gate regressed.",
      "user_sees": "sandbox_smoke_failed with expected sandbox_policy_missing."
    },
    {
      "codepath": "documentation update",
      "failure": "docs claim forbidden public routes or hosted provider execution shipped",
      "exception": "review/audit finding",
      "rescue": "Revise docs to exact R20 boundary wording.",
      "user_sees": "accurate product truth."
    }
  ],
  "observability": {
    "logs": [
      "production:sandbox-smoke OK or sandbox:smoke OK on success",
      "sandbox_smoke_failed:<reason> on failure"
    ],
    "success_metric": "no-spend smoke validates fake execution plus fail-closed real sandbox posture.",
    "failure_metric": "smoke exits non-zero on readiness, denial, redaction, timeout, cancel, or policy-gate regression."
  },
  "test_cases": [
    {
      "name": "production smoke still completes",
      "lens": "happy",
      "given": "default fake echo/artifact/timeout/cancel",
      "expect": "production:sandbox-smoke exits 0 and prints an OK marker."
    },
    {
      "name": "real execution disabled is explicit",
      "lens": "happy_shadow_empty",
      "given": "default env",
      "expect": "realExecution.mode disabled and readiness ok."
    },
    {
      "name": "enabled without policy fails readiness",
      "lens": "error_path",
      "given": "SWITCHYARD_SANDBOX_REAL_EXECUTION=enabled without policy",
      "expect": "sandbox_policy_missing."
    },
    {
      "name": "non-fake denied with disabled real execution",
      "lens": "error_path",
      "given": "service.execute commandId deploy.safe.echo",
      "expect": "sandbox_real_execution_disabled or command denial; no real process."
    },
    {
      "name": "fake PTY remains deterministic",
      "lens": "happy",
      "given": "switchyard.fake.pty_echo input abc",
      "expect": "completed deterministic output."
    },
    {
      "name": "docs forbid route claims",
      "lens": "edge_boundary",
      "given": "PRODUCT.md and API docs",
      "expect": "public arbitrary execution routes and provider execution remain non-goals."
    },
    {
      "name": "production smoke guards both OpenAPI surfaces",
      "lens": "edge_boundary",
      "given": "generated local and hosted OpenAPI documents",
      "expect": "no /exec, /shell, /process, /command, /pty, /terminal, or /sandbox paths exist."
    }
  ],
  "integration_contracts": {
    "exports": [],
    "imports_from_other_tasks": [
      {
        "from_task": "P19-T2-core-sandbox-policy-gate",
        "name": "resolveHostedSandboxConfig",
        "signature": "resolveHostedSandboxConfig(input) => ResolvedHostedSandboxConfig"
      },
      {
        "from_task": "P19-T2-core-sandbox-policy-gate",
        "name": "checkHostedSandboxReadiness",
        "signature": "checkHostedSandboxReadiness(config) => { ok: boolean; code?: SandboxNamedError }"
      },
      {
        "from_task": "P19-T3-production-sandbox-executor",
        "name": "ProductionHostedSandboxExecutor",
        "signature": "new ProductionHostedSandboxExecutor(options?: { processFactory?: SandboxProcessFactory; ptyFactory?: SandboxPtyFactory; logger?: RuntimeLogger }) implements HostedSandboxExecutorPort"
      }
    ],
    "file_paths_consumed_by_other_tasks": []
  }
}
```

## Architect Review Focus

- Confirm driver-injected PTY with `sandbox_pty_unavailable` fail-closed behavior is sufficient for R20 foundation scope.
- Confirm explicit internal production sandbox real execution does not imply hosted Codex/Claude/OpenCode or public arbitrary execution routes.
- Check whether JSON-in-env command policy is acceptable for R20, or whether a policy file path must be added before implementation.
