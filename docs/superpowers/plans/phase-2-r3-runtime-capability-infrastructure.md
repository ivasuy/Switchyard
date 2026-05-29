# Phase 2 Implementation Plan: R3 Runtime Capability Infrastructure

Date: 2026-05-29

Phase: 2

Roadmap release: R3 Runtime Capability Infrastructure

Branch: `agent/phase-2-r3-runtime-capability-infrastructure`

Spec: `docs/superpowers/specs/2026-05-29-phase-2-r3-runtime-capability-infrastructure.md`

Spec commit: `c82a0ccf38e2e16e5dcb752229092e876c3c54a1`

Plan target: `docs/superpowers/plans/phase-2-r3-runtime-capability-infrastructure.md`

## CTO Scope Challenge

- Existing code check: current registry contracts and stores only model provider/runtime/model records; REST registry routes are Fastify route groups with cursor helpers; SQLite migrations are hand-rolled additive SQL; daemon startup seeds fake and Codex records; Codex probing currently reports `ok: true` when version works but model catalog fails.
- Minimal-change choice: add runtime modes as first-class records and keep provider/runtime/model methods stable. Do not change runtime dispatch keys from `fake`/`codex`; add optional `runtimeMode` to runs and sessions for inspection and compatibility.
- Complexity bound: total release necessarily crosses more than 8 files, but each task owns 8 or fewer files and no file is owned by more than one task.
- Built-in check: every task has focused package checks; final promotion includes `git diff --check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm lint`.
- Distribution check: one implementer per task, disjoint ownership, dependencies explicit. Tasks can run in parallel only after their dependencies are satisfied.
- Scope rejection: no interactive Codex, PTY, Generic HTTP, ACP, hosted execution, SDK, CLI, dashboard, auth/rate limiting, OpenAPI generation, or new broad adapters in R3.

## Architecture Decisions

- Runtime mode is the new unit of advertised capability: `fake.deterministic` and `codex.exec_json` only.
- Adapter manifests are static and safe to read; doctor checks are active, sanitized, and never execute a model task.
- `GET /doctor` reads stored snapshots only; `POST /runtime-modes/:id/check` performs a fresh check and updates the stored snapshot.
- `codex.exec_json` is unavailable when the binary is missing or the model catalog is unusable. The existing lower-level probe can keep its parser behavior, but the capability layer must tighten availability mapping.
- Partial availability is concrete in R3: all required checks pass, at least one optional check fails, `state: "partial"`, `canRun: true`, `installed: true`, and `reasonCode: "optional_check_failed"`. Doctor summaries and daemon startup/check paths must count this state.
- Active local doctor checks must be bounded by timeout and output limits. A hung/slow required probe returns a sanitized `unknown` or `unavailable` check result, never an indefinite request.
- Run creation remains backward-compatible. When `runtimeMode` is omitted, the API infers `fake.deterministic` or `codex.exec_json`; when supplied in `POST /runs`, it accepts the runtime mode slug only, not the internal `runtime_mode_*` id, and it must match runtime/provider/adapter type.

## Task Graph

```json
[
  {
    "id": "P2-T1-contracts-runtime-mode-schemas",
    "title": "Add runtime mode, availability, doctor, and run/session contract schemas",
    "files": [
      "packages/contracts/src/ids.ts",
      "packages/contracts/src/registry.ts",
      "packages/contracts/src/run.ts",
      "packages/contracts/src/session.ts",
      "packages/contracts/src/list-queries.ts",
      "packages/contracts/src/http-error.ts",
      "packages/contracts/src/index.ts",
      "packages/contracts/test/contracts.test.ts"
    ],
    "dependencies": [],
    "context_files": [
      "docs/superpowers/specs/2026-05-29-phase-2-r3-runtime-capability-infrastructure.md",
      "packages/contracts/src/registry.ts",
      "packages/contracts/src/run.ts",
      "packages/contracts/src/list-queries.ts",
      "packages/contracts/src/http-error.ts",
      "packages/contracts/test/contracts.test.ts"
    ],
    "instructions": "Add public Zod schemas and inferred types for runtime mode slugs, ids, kinds, capabilities, limitations, placement facts, availability snapshots, doctor diagnostics/checks, runtime mode records, list runtime mode queries/responses, and doctor summary responses. Extend `runSchema` and `runtimeSessionSchema` with optional nullable-compatible `runtimeMode` runtime mode slug values while preserving old rows that omit it or expose null for pre-R3 storage rows. Add `runtime_mode_not_found` to the closed HTTP code schema. Keep capability strings small and limited to the spec list; do not add generic interactive capabilities. Export all new schemas/types from `index.ts`.",
    "acceptance": [
      "`runtimeModeSlugSchema` accepts `fake.deterministic` and `codex.exec_json` and rejects single-segment, uppercase, whitespace, and malformed dot slugs.",
      "`runtimeModeSchema` parses complete fake and Codex records with required capabilities, limitations, placement, availability, createdAt, and updatedAt fields.",
      "`runtimeAvailabilitySchema` only accepts `available`, `installed`, `unavailable`, `unsupported`, `partial`, and `unknown`.",
      "`runtimeDoctorCheckSchema` parses available and unavailable Codex doctor payloads without requiring secrets or stack traces.",
      "`runSchema` parses old records without `runtimeMode`, new records with a runtime mode slug, and rejects internal runtime mode ids in the public run field.",
      "`runtimeSessionSchema` parses new sessions with a runtime mode slug and old/null session records without breaking pre-R3 storage compatibility.",
      "`httpErrorCodeSchema` includes `runtime_mode_not_found` without changing existing codes."
    ],
    "checks": [
      "pnpm --filter @switchyard/contracts test",
      "pnpm --filter @switchyard/contracts typecheck",
      "pnpm --filter @switchyard/contracts build"
    ],
    "error_rescue_map": [
      {
        "codepath": "packages/contracts/src/registry.ts runtime mode schemas",
        "failure": "Runtime mode records become too permissive or accept future modes as available.",
        "exception": "Zod parse succeeds for malformed slug or unsupported capability.",
        "rescue": "Use closed enums for R3 states/capabilities and a strict regex for slugs; add negative tests for future/reserved examples.",
        "user_sees": "Clients receive precise R3 capability records and cannot mistake reserved modes for shipped modes."
      },
      {
        "codepath": "packages/contracts/src/run.ts and session.ts optional runtimeMode",
        "failure": "Existing persisted run/session records no longer parse.",
        "exception": "Contract tests fail when `runtimeMode` is absent.",
        "rescue": "Keep `runtimeMode` optional in public schemas and let storage return null/omitted for pre-R3 rows.",
        "user_sees": "Old local data remains readable after upgrade."
      }
    ],
    "observability": {
      "logs": [
        "No runtime logs added in this task; schemas enable later API and daemon logs to carry runtimeMode and availability."
      ],
      "success_metric": "Contract tests cover happy, nil, empty, and error parsing paths for runtime mode and doctor payloads.",
      "failure_metric": "Any schema regression blocks downstream package typecheck or public contract tests."
    },
    "test_cases": [
      {
        "name": "fake runtime mode record parses",
        "lens": "happy",
        "given": "A complete `fake.deterministic` runtime mode record with `auth.none` and fake echo capability.",
        "expect": "`runtimeModeSchema.parse` succeeds and preserves all required fields."
      },
      {
        "name": "codex unavailable doctor parses",
        "lens": "happy_shadow_empty",
        "given": "A `codex.exec_json` doctor check with empty model catalog diagnostics and `state: unavailable`.",
        "expect": "The doctor schema succeeds with `canRun: false`, null version, and sanitized diagnostics."
      },
      {
        "name": "codex available doctor parses",
        "lens": "happy",
        "given": "A `codex.exec_json` doctor check with version, at least one model catalog diagnostic, `state: available`, `canRun: true`, `installed: true`, and `auth: configured`.",
        "expect": "The doctor schema succeeds and preserves version, capabilities, limitations, and info diagnostics."
      },
      {
        "name": "codex runtime mode full fixture parses",
        "lens": "happy",
        "given": "A complete record with id `runtime_mode_codex_exec_json`, slug `codex.exec_json`, one-shot limitations, local/hosted/connectedLocalNode placement facts, available availability, createdAt, and updatedAt.",
        "expect": "`runtimeModeSchema.parse` succeeds and the parsed record includes the Codex limitation and placement facts."
      },
      {
        "name": "new run with runtimeMode slug parses",
        "lens": "happy",
        "given": "A new run object with `runtimeMode: fake.deterministic`.",
        "expect": "`runSchema.parse` succeeds and preserves the slug."
      },
      {
        "name": "new run rejects runtimeMode id",
        "lens": "error_path",
        "given": "A new run object with `runtimeMode: runtime_mode_fake_deterministic`.",
        "expect": "`runSchema.parse` rejects because POST /runs and Run records expose runtime mode slugs, not internal ids."
      },
      {
        "name": "old run record remains valid",
        "lens": "happy_shadow_nil",
        "given": "An R2 run object without `runtimeMode`.",
        "expect": "`runSchema.parse` succeeds and does not require the new field."
      },
      {
        "name": "new runtime session with runtimeMode slug parses",
        "lens": "happy",
        "given": "A runtime session object with `runtimeMode: codex.exec_json`.",
        "expect": "`runtimeSessionSchema.parse` succeeds and preserves the slug."
      },
      {
        "name": "old and null runtime session compatibility",
        "lens": "happy_shadow_nil",
        "given": "One R2 runtime session without `runtimeMode` and one storage-shaped session with `runtimeMode: null`.",
        "expect": "`runtimeSessionSchema.parse` succeeds for both compatibility cases."
      },
      {
        "name": "malformed runtime mode slug rejects",
        "lens": "error_path",
        "given": "Values such as `codex`, `Codex.exec_json`, `.codex`, and `codex..exec_json`.",
        "expect": "`runtimeModeSlugSchema.parse` throws."
      },
      {
        "name": "unknown availability state rejects",
        "lens": "edge_invalid_enum",
        "given": "A runtime mode record with `availability.state: degraded`.",
        "expect": "Parsing fails because R3 availability uses the new closed state set."
      },
      {
        "name": "runtime mode not found code parses",
        "lens": "edge_error_code",
        "given": "The string `runtime_mode_not_found` and an error envelope using that code.",
        "expect": "`httpErrorCodeSchema` and `httpErrorEnvelopeSchema` parse the new code."
      }
    ],
    "acceptance_test_map": [
      {
        "acceptance": "runtimeModeSlugSchema accepts valid R3 slugs and rejects malformed slugs",
        "tests": [
          "malformed runtime mode slug rejects",
          "new run rejects runtimeMode id"
        ]
      },
      {
        "acceptance": "runtimeModeSchema parses complete fake and Codex records",
        "tests": [
          "fake runtime mode record parses",
          "codex runtime mode full fixture parses"
        ]
      },
      {
        "acceptance": "runtimeAvailabilitySchema accepts the R3 state set",
        "tests": [
          "unknown availability state rejects",
          "codex runtime mode full fixture parses"
        ]
      },
      {
        "acceptance": "runtimeDoctorCheckSchema parses available and unavailable Codex payloads",
        "tests": [
          "codex available doctor parses",
          "codex unavailable doctor parses"
        ]
      },
      {
        "acceptance": "runSchema parses old and new runtimeMode forms",
        "tests": [
          "new run with runtimeMode slug parses",
          "old run record remains valid",
          "new run rejects runtimeMode id"
        ]
      },
      {
        "acceptance": "runtimeSessionSchema parses new, old, and null runtimeMode session forms",
        "tests": [
          "new runtime session with runtimeMode slug parses",
          "old and null runtime session compatibility"
        ]
      },
      {
        "acceptance": "httpErrorCodeSchema includes runtime_mode_not_found",
        "tests": [
          "runtime mode not found code parses"
        ]
      }
    ],
    "integration_contracts": {
      "exports": [
        {
          "name": "runtimeModeSlugSchema",
          "kind": "constant",
          "signature": "z.ZodString"
        },
        {
          "name": "runtimeModeSchema",
          "kind": "constant",
          "signature": "z.ZodObject<RuntimeMode>"
        },
        {
          "name": "runtimeDoctorCheckSchema",
          "kind": "constant",
          "signature": "z.ZodObject<RuntimeDoctorCheck>"
        },
        {
          "name": "listRuntimeModesQuerySchema",
          "kind": "constant",
          "signature": "z.ZodObject<ListRuntimeModesQuery>"
        },
        {
          "name": "doctorSummaryResponseSchema",
          "kind": "constant",
          "signature": "z.ZodObject<DoctorSummaryResponse>"
        },
        {
          "name": "runtimeModeIdSchema",
          "kind": "constant",
          "signature": "idSchema(\"runtime_mode\")"
        }
      ],
      "imports_from_other_tasks": [],
      "file_paths_consumed_by_other_tasks": [
        "packages/contracts/src/registry.ts",
        "packages/contracts/src/run.ts",
        "packages/contracts/src/list-queries.ts",
        "packages/contracts/src/http-error.ts",
        "packages/contracts/src/index.ts"
      ]
    }
  },
  {
    "id": "P2-T2-core-capability-doctor-services",
    "title": "Add manifest-aware core ports, capability service, doctor service, and mode inference",
    "files": [
      "packages/core/src/ports/registry-store.ts",
      "packages/core/src/ports/runtime-adapter.ts",
      "packages/core/src/services/registry-service.ts",
      "packages/core/src/services/runtime-capability-service.ts",
      "packages/core/src/services/runtime-doctor-service.ts",
      "packages/core/src/services/run-service.ts",
      "packages/core/src/index.ts",
      "packages/core/test/core.test.ts"
    ],
    "dependencies": [
      "P2-T1-contracts-runtime-mode-schemas"
    ],
    "context_files": [
      "docs/superpowers/specs/2026-05-29-phase-2-r3-runtime-capability-infrastructure.md",
      "packages/core/src/ports/registry-store.ts",
      "packages/core/src/ports/runtime-adapter.ts",
      "packages/core/src/services/run-service.ts",
      "packages/core/test/core.test.ts"
    ],
    "instructions": "Extend the core registry port with runtime-mode create/upsert/get/list/update availability methods while keeping existing provider/runtime/model methods stable. Add `RuntimeAdapterManifest` to the runtime adapter port and require adapters to expose a deterministic `manifest`. Add `RuntimeCapabilityService` to convert manifests plus availability snapshots into stored runtime mode records and seed them. Add `RuntimeDoctorService` to look up a runtime mode, call the matching adapter's `check()` safely, map expected failures into sanitized doctor checks, and update stored availability. Doctor checks must support bounded execution through injected `checkTimeoutMs` and `maxDiagnosticBytes` options; hung/slow required checks must resolve as sanitized `unknown` or `unavailable` results, never wait forever. Define partial availability concretely: if all required manifest checks pass and any optional manifest check fails, return `state: partial`, `canRun: true`, `installed: true`, `reasonCode: optional_check_failed`, and warning diagnostics. Add small mode inference/validation helpers, exposed through `RegistryService` or a focused helper in the same service layer, for `fake` -> `fake.deterministic` and `codex` + `process` -> `codex.exec_json`. Extend `CreateRunInput` and `RunService.createRun` to preserve optional runtime mode slugs on new run records without changing dispatch semantics; explicit runtime mode ids are not accepted for run creation.",
    "acceptance": [
      "Existing provider/runtime/model registry port methods remain source-compatible except for implementers that must add runtime-mode methods.",
      "Core services can seed runtime modes from manifests with unknown or supplied availability and do not execute model work.",
      "Doctor service maps missing adapter/manifest to `unsupported` with `adapter_not_registered` and expected adapter check failures to non-throwing unavailable/partial states.",
      "Codex version success plus zero models maps to `unavailable` with `model_catalog_unavailable` at the capability layer.",
      "Optional check failure with all required checks passing maps to `partial` and is counted in doctor summaries.",
      "Hung or over-output active checks are bounded and map to sanitized `unknown` or `unavailable` states with `check_timeout` or `check_output_too_large` reason codes.",
      "Mode inference returns shipped R3 slugs only, rejects explicit runtime-mode ids for `POST /runs`, and rejects explicit runtime-mode mismatches with a typed validation error that REST can turn into `400 invalid_input`.",
      "RunService stores `runtimeMode` when provided and preserves old create behavior when it is absent."
    ],
    "checks": [
      "pnpm --filter @switchyard/core test",
      "pnpm --filter @switchyard/core typecheck",
      "pnpm --filter @switchyard/core build"
    ],
    "error_rescue_map": [
      {
        "codepath": "RuntimeDoctorService.checkRuntimeMode",
        "failure": "Expected local prerequisite failures throw as 500s instead of doctor payloads.",
        "exception": "Adapter check rejects for binary/model failures.",
        "rescue": "Catch adapter check errors, classify known expected failures, sanitize message, and return a successful doctor check with unavailable state.",
        "user_sees": "`POST /runtime-modes/codex.exec_json/check` reports unavailable instead of crashing the daemon."
      },
      {
        "codepath": "RuntimeDoctorService bounded active checks",
        "failure": "A hung Codex model catalog probe keeps the HTTP request open indefinitely.",
        "exception": "Core doctor timeout test does not resolve within the configured `checkTimeoutMs`.",
        "rescue": "Wrap adapter checks in a timeout race; truncate diagnostic messages to `maxDiagnosticBytes`; map required timeout before prerequisite classification to `unknown/check_timeout` and model-catalog timeout after version success to `unavailable/model_catalog_unavailable` or `check_timeout`.",
        "user_sees": "Doctor check returns a bounded sanitized response even when local Codex hangs."
      },
      {
        "codepath": "RuntimeDoctorService partial availability mapping",
        "failure": "Optional check failure downgrades a runnable mode to unavailable.",
        "exception": "Core test with required checks passing and optional check failing returns `unavailable` instead of `partial`.",
        "rescue": "Separate required and optional diagnostics before computing state; only required failures set `canRun: false`.",
        "user_sees": "Clients can distinguish runnable-with-warning from not runnable."
      },
      {
        "codepath": "runtime mode inference helper",
        "failure": "Explicit `runtimeMode` does not match runtime/provider/adapterType or uses an internal id and still launches.",
        "exception": "Validation helper returns success for mismatched values.",
        "rescue": "Require the public runtime mode slug shape for run create, lookup the stored mode by slug, compare runtime/provider/adapter type against supplied request, and surface a stable validation error.",
        "user_sees": "Malformed run create request gets `400 invalid_input` before launch."
      }
    ],
    "observability": {
      "logs": [
        "Doctor service should expose structured reason codes to daemon logs in Task P2-T6, but not log secrets itself.",
        "Timeout and output-limit diagnostics should log only stable reason codes and byte/timeout counts, not command output bodies."
      ],
      "success_metric": "Core tests prove manifest seeding, check mapping, partial mapping, timeout/output bounding, sanitized failures, and mode inference without real Codex CLI calls.",
      "failure_metric": "Any uncaught doctor check exception or missing runtime-mode store method fails core tests."
    },
    "test_cases": [
      {
        "name": "seed fake and codex manifests",
        "lens": "happy",
        "given": "Two manifests and a fake in-memory registry store.",
        "expect": "Capability service upserts `runtime_mode_fake_deterministic` and `runtime_mode_codex_exec_json`."
      },
      {
        "name": "manifest optional docs path",
        "lens": "happy_shadow_nil",
        "given": "A manifest without `docsPath` and an unknown availability snapshot.",
        "expect": "A valid runtime mode record is produced with null/omitted docs path."
      },
      {
        "name": "empty codex model catalog is unavailable",
        "lens": "happy_shadow_empty",
        "given": "Adapter check returns version and `models: []`.",
        "expect": "Doctor check state is `unavailable`, `installed: true`, `canRun: false`, reason `model_catalog_unavailable`."
      },
      {
        "name": "optional check failure is partial",
        "lens": "edge_partial",
        "given": "A manifest with required checks `binary_version` and `model_catalog` passing and optional check `sandbox_policy_probe` failing.",
        "expect": "Doctor check state is `partial`, `canRun: true`, `installed: true`, reason `optional_check_failed`, and diagnostics include a warning."
      },
      {
        "name": "hung active check times out",
        "lens": "error_path",
        "given": "An adapter check promise that never resolves and a short injected `checkTimeoutMs`.",
        "expect": "Doctor service resolves with `state: unknown`, `canRun: false`, reason `check_timeout`, and sanitized diagnostics."
      },
      {
        "name": "oversized check output is sanitized",
        "lens": "edge_output_bound",
        "given": "An adapter check failure with diagnostic output larger than `maxDiagnosticBytes`.",
        "expect": "Doctor service truncates/sanitizes public diagnostics and uses `check_output_too_large` when output bounds are exceeded."
      },
      {
        "name": "adapter not registered",
        "lens": "error_path",
        "given": "A stored runtime mode whose adapter id is absent from the adapter map.",
        "expect": "Doctor check returns `unsupported`, not an uncaught error."
      },
      {
        "name": "explicit mismatch rejected",
        "lens": "integration",
        "given": "A run create input with runtime `fake` and runtimeMode `codex.exec_json`.",
        "expect": "Validation helper rejects with details for REST to expose as `invalid_input`."
      },
      {
        "name": "explicit runtimeMode id rejected for run create",
        "lens": "error_path",
        "given": "A run create input with `runtimeMode: runtime_mode_codex_exec_json`.",
        "expect": "Validation helper rejects because run creation accepts runtime mode slugs only."
      }
    ],
    "integration_contracts": {
      "exports": [
        {
          "name": "RuntimeAdapterManifest",
          "kind": "interface",
          "signature": "{ adapterId: string; providerId: string; runtimeId: string; runtimeModeId: string; runtimeModeSlug: string; name: string; adapterType: AdapterType; kind: RuntimeModeKind; capabilities: RuntimeCapability[]; limitations: RuntimeLimitation[]; placement: RuntimePlacementFacts; docsPath?: string; check: { strategy: string; required: string[]; optional: string[] } }"
        },
        {
          "name": "RuntimeCapabilityService",
          "kind": "class",
          "signature": "constructor({ registry, clock? }); upsertManifest(manifest, availability?): Promise<RuntimeMode>; seedManifests(manifests, availabilityBySlug?): Promise<RuntimeMode[]>"
        },
        {
          "name": "RuntimeDoctorService",
          "kind": "class",
          "signature": "constructor({ registry, adapters, clock?, logger?, checkTimeoutMs?, maxDiagnosticBytes? }); checkRuntimeMode(idOrSlug: string): Promise<RuntimeDoctorCheck>; summarize(): Promise<DoctorSummaryResponse>"
        },
        {
          "name": "RegistryService",
          "kind": "class",
          "signature": "inferAndValidateRuntimeMode(input: { runtime: string; provider: string; adapterType: AdapterType; runtimeMode?: string }): Promise<string | undefined> // runtimeMode is a public slug only"
        }
      ],
      "imports_from_other_tasks": [
        {
          "from_task": "P2-T1-contracts-runtime-mode-schemas",
          "name": "RuntimeMode, RuntimeDoctorCheck, RuntimeAvailability, RuntimeCapability, RuntimeLimitation, RuntimePlacementFacts, RuntimeModeKind",
          "signature": "types exported from @switchyard/contracts"
        }
      ],
      "file_paths_consumed_by_other_tasks": [
        "packages/core/src/ports/registry-store.ts",
        "packages/core/src/ports/runtime-adapter.ts",
        "packages/core/src/services/runtime-capability-service.ts",
        "packages/core/src/services/runtime-doctor-service.ts",
        "packages/core/src/services/registry-service.ts",
        "packages/core/src/services/run-service.ts",
        "packages/core/src/index.ts"
      ]
    }
  },
  {
    "id": "P2-T3-adapter-manifests-and-codex-checks",
    "title": "Add deterministic fake and Codex exec-json manifests plus CI-safe check mapping",
    "files": [
      "packages/testkit/src/fake-runtime-adapter.ts",
      "packages/testkit/test/fake-runtime-adapter.test.ts",
      "packages/adapters/src/codex/types.ts",
      "packages/adapters/src/codex/codex-model-catalog.ts",
      "packages/adapters/src/codex/codex-exec-json-adapter.ts",
      "packages/adapters/src/index.ts",
      "packages/adapters/test/codex-model-catalog.test.ts",
      "packages/adapters/test/codex-exec-json-adapter.test.ts"
    ],
    "dependencies": [
      "P2-T1-contracts-runtime-mode-schemas",
      "P2-T2-core-capability-doctor-services"
    ],
    "context_files": [
      "docs/superpowers/specs/2026-05-29-phase-2-r3-runtime-capability-infrastructure.md",
      "packages/testkit/src/fake-runtime-adapter.ts",
      "packages/adapters/src/codex/codex-exec-json-adapter.ts",
      "packages/adapters/src/codex/codex-model-catalog.ts",
      "packages/adapters/test/codex-model-catalog.test.ts"
    ],
    "instructions": "Add static manifests to `FakeRuntimeAdapter` and `CodexExecJsonAdapter` using the `RuntimeAdapterManifest` pattern from core. The fake manifest must advertise `fake.deterministic`, deterministic fake capabilities, `auth.none`, and R3 placement facts. The Codex manifest must advertise only `codex.exec_json`, one-shot process capabilities, local auth, sandbox capability strings, transcript/model catalog capabilities, and limitations for one-shot/no-input/local-only/no approval bridge/no session resume. Tighten Codex check behavior or expose enough probe details so the core doctor service can distinguish binary unavailable, model catalog unavailable, optional-check partial, timeout, output-limit, and available-with-models states. `probeCodexCatalog` must accept injected `timeoutMs` and `maxBufferBytes` options and pass bounded options to `execFile`; hung or excessive-output probes must return sanitized probe details for doctor mapping. Keep all adapter tests CI-safe by using mocks/fake process factories only.",
    "acceptance": [
      "Every concrete adapter in the codebase exposes a manifest and satisfies the updated `RuntimeAdapter` interface.",
      "Fake manifest exactly names `runtime_mode_fake_deterministic` and `fake.deterministic` and is always locally available through check behavior.",
      "Codex manifest exactly names `runtime_mode_codex_exec_json` and `codex.exec_json` and does not advertise interactive, PTY, hosted, approval bridge, or resume capabilities.",
      "Codex probe/check tests cover binary failure, model catalog failure or empty catalog, optional check failure, timeout, output-limit failure, thrown probe, and success with models.",
      "Existing Codex start/events/artifacts behavior and unsupported input behavior continue to pass."
    ],
    "checks": [
      "pnpm --filter @switchyard/testkit test",
      "pnpm --filter @switchyard/testkit typecheck",
      "pnpm --filter @switchyard/adapters test",
      "pnpm --filter @switchyard/adapters typecheck",
      "pnpm --filter @switchyard/adapters build"
    ],
    "error_rescue_map": [
      {
        "codepath": "CodexExecJsonAdapter.manifest",
        "failure": "Manifest overstates Codex support and suggests interactive or hosted capability.",
        "exception": "Manifest test finds forbidden capability or unsupported placement marked supported.",
        "rescue": "Use the spec's exact capability and limitation lists; add negative assertions for interactive, PTY, hosted, approval bridge, and resume terms.",
        "user_sees": "Clients see `codex.exec_json` as local one-shot only."
      },
      {
        "codepath": "probeCodexCatalog/check mapping",
        "failure": "Model catalog failure is treated as available.",
        "exception": "Check test returns `ok: true` with zero models and no unavailable reason.",
        "rescue": "Keep parser probe compatibility if needed, but expose details that core maps to `model_catalog_unavailable`; add adapter-level coverage for empty and failed model catalog.",
        "user_sees": "Doctor API does not claim Codex can run when runnable models are unknown."
      },
      {
        "codepath": "probeCodexCatalog bounded execFile calls",
        "failure": "A slow `codex debug models` command hangs active doctor checks.",
        "exception": "Adapter probe timeout test never resolves or leaks raw stderr/stdout.",
        "rescue": "Pass `timeout` and `maxBuffer` to `execFile`, classify timeout/maxBuffer errors with stable reason codes, and include only sanitized short messages in probe details.",
        "user_sees": "Codex doctor checks finish promptly with a safe diagnostic."
      }
    ],
    "observability": {
      "logs": [
        "Existing Codex logs remain: `codex.spawned`, `codex.stderr`, `codex.stdout.first_line`, `codex.exit`, `codex.process_error`.",
        "Doctor-specific logs are wired in daemon task after services are registered."
      ],
      "success_metric": "Adapter package and testkit package compile with required manifests and all fake/Codex adapter tests pass without a real Codex CLI.",
      "failure_metric": "Any manifest omission fails adapter/testkit tests or TypeScript checks."
    },
    "test_cases": [
      {
        "name": "fake manifest deterministic",
        "lens": "happy",
        "given": "A new `FakeRuntimeAdapter` instance.",
        "expect": "The manifest contains `fake.deterministic`, deterministic fake kind, fake echo capability, and local supported placement."
      },
      {
        "name": "codex manifest local one-shot only",
        "lens": "happy",
        "given": "A new `CodexExecJsonAdapter` instance.",
        "expect": "The manifest contains `codex.exec_json`, one-shot kind, local supported placement, hosted unsupported placement, and the one-shot/no-input limitations."
      },
      {
        "name": "codex missing binary check",
        "lens": "error_path",
        "given": "Mocked `codex --version` failure.",
        "expect": "Check/probe details allow doctor mapping to `binary_unavailable` with no thrown exception."
      },
      {
        "name": "codex empty models check",
        "lens": "happy_shadow_empty",
        "given": "Version succeeds but `codex debug models` fails or returns an empty model array.",
        "expect": "Check/probe details include version and empty models so the doctor layer marks unavailable."
      },
      {
        "name": "codex optional check warning",
        "lens": "edge_partial",
        "given": "Required version and model catalog probes succeed while an optional probe fixture fails.",
        "expect": "Check/probe details preserve required success and optional warning so the doctor layer marks `partial` rather than unavailable."
      },
      {
        "name": "codex probe timeout is bounded",
        "lens": "error_path",
        "given": "Mocked `execFile` never calls back or reports an ETIMEDOUT-style error under a short timeout.",
        "expect": "`probeCodexCatalog` resolves with sanitized timeout details and no raw command output."
      },
      {
        "name": "codex probe output too large",
        "lens": "edge_output_bound",
        "given": "Mocked `codex debug models` exceeds `maxBufferBytes`.",
        "expect": "`probeCodexCatalog` returns sanitized output-limit details that the doctor service can map to `check_output_too_large` or unavailable."
      },
      {
        "name": "codex real run path unchanged",
        "lens": "integration",
        "given": "Existing fake Codex process emits JSONL and stderr.",
        "expect": "Existing events, transcript artifact, and unsupported input tests still pass."
      }
    ],
    "integration_contracts": {
      "exports": [
        {
          "name": "FakeRuntimeAdapter.manifest",
          "kind": "constant",
          "signature": "RuntimeAdapterManifest for fake.deterministic"
        },
        {
          "name": "CodexExecJsonAdapter.manifest",
          "kind": "constant",
          "signature": "RuntimeAdapterManifest for codex.exec_json"
        },
        {
          "name": "probeCodexCatalog",
          "kind": "function",
          "signature": "(command?: string, options?: { timeoutMs?: number; maxBufferBytes?: number }) => Promise<CodexCatalogProbe>"
        }
      ],
      "imports_from_other_tasks": [
        {
          "from_task": "P2-T2-core-capability-doctor-services",
          "name": "RuntimeAdapterManifest",
          "signature": "interface exported from @switchyard/core"
        },
        {
          "from_task": "P2-T1-contracts-runtime-mode-schemas",
          "name": "RuntimeCapability and RuntimeModeKind",
          "signature": "types exported from @switchyard/contracts"
        }
      ],
      "file_paths_consumed_by_other_tasks": [
        "packages/testkit/src/fake-runtime-adapter.ts",
        "packages/adapters/src/codex/codex-exec-json-adapter.ts",
        "packages/adapters/src/codex/codex-model-catalog.ts",
        "packages/adapters/src/index.ts"
      ]
    }
  },
  {
    "id": "P2-T4-storage-runtime-mode-migration",
    "title": "Persist runtime modes and nullable runtimeMode on runs/sessions with additive SQLite migrations",
    "files": [
      "packages/storage/src/sqlite/schema.ts",
      "packages/storage/src/sqlite/database.ts",
      "packages/storage/src/sqlite/registry-store.ts",
      "packages/storage/src/sqlite/run-store.ts",
      "packages/storage/src/sqlite/session-store.ts",
      "packages/storage/test/sqlite-storage.test.ts",
      "packages/testkit/src/fake-stores.ts"
    ],
    "dependencies": [
      "P2-T1-contracts-runtime-mode-schemas",
      "P2-T2-core-capability-doctor-services"
    ],
    "context_files": [
      "docs/superpowers/specs/2026-05-29-phase-2-r3-runtime-capability-infrastructure.md",
      "packages/storage/src/sqlite/schema.ts",
      "packages/storage/src/sqlite/database.ts",
      "packages/storage/src/sqlite/registry-store.ts",
      "packages/storage/src/sqlite/run-store.ts",
      "packages/testkit/src/fake-stores.ts"
    ],
    "instructions": "Add a `runtime_modes` SQLite table with the spec columns and indexes. Add nullable `runtime_mode` columns to `runs` and `runtime_sessions` through additive migrations. Extend `SqliteRegistryStore` and `InMemoryRegistryStore` to implement runtime-mode upsert/get-by-id-or-slug/list/update availability methods with equivalent filtering and cursor behavior. Extend run/session stores to write `runtimeMode` when present and parse old rows with null/absent runtime_mode. Use structured JSON serialization for capabilities, limitations, placement, and availability. Keep existing provider/runtime/model records and indexes intact.",
    "acceptance": [
      "Opening a pre-R3 SQLite database creates `runtime_modes` and adds nullable `runtime_mode` columns without losing existing run/session/provider/runtime/model data.",
      "SQLite persists runtime mode records across close/reopen and can update only availability/status after a doctor check.",
      "SQLite and in-memory runtime mode list filtering match for provider, runtime, adapterType, kind, availability, placement, capability, limit, and before cursor.",
      "Storage parity tests explicitly cover placement filtering, availability filtering, filtered pagination, and capability filtering across SQLite and in-memory stores.",
      "Malformed `capabilities_json`, `availability_json`, and `placement_json` rows fail clearly instead of returning invalid public records.",
      "Run and session stores include `runtimeMode` on new records and omit or null it for old records.",
      "Existing storage tests for all stores continue to pass."
    ],
    "checks": [
      "pnpm --filter @switchyard/storage test",
      "pnpm --filter @switchyard/storage typecheck",
      "pnpm --filter @switchyard/storage build",
      "pnpm --filter @switchyard/testkit test",
      "pnpm --filter @switchyard/testkit typecheck"
    ],
    "error_rescue_map": [
      {
        "codepath": "packages/storage/src/sqlite/database.ts additive migrations",
        "failure": "Reopening an older SQLite database fails because new columns/table are missing.",
        "exception": "SQLite reports no such column/table during store operations.",
        "rescue": "Use `CREATE TABLE IF NOT EXISTS` for `runtime_modes`; extend additive migration helper to check `PRAGMA table_info` per table before adding `runs.runtime_mode` and `runtime_sessions.runtime_mode`.",
        "user_sees": "Existing local daemon databases upgrade cleanly."
      },
      {
        "codepath": "SqliteRegistryStore runtime mode JSON mapping",
        "failure": "Stored JSON fields parse into wrong shapes or throw on null.",
        "exception": "Runtime mode reopen test fails schema parse.",
        "rescue": "Centralize row<->record conversion and validate through `runtimeModeSchema.parse` in tests with explicit nil/empty cases.",
        "user_sees": "Runtime mode API returns stable, schema-valid records after restart."
      },
      {
        "codepath": "SqliteRegistryStore runtime mode filtering",
        "failure": "SQLite and in-memory stores return different pages or filter results.",
        "exception": "Parity tests disagree for placement, availability, capability, or paginated filtered results.",
        "rescue": "Keep filtering predicates in one helper where possible; if SQLite needs SQL JSON post-filtering, over-fetch deterministically and apply the same predicate before cursor calculation.",
        "user_sees": "REST list results are stable regardless of storage backend."
      }
    ],
    "observability": {
      "logs": [
        "No new logs in storage; daemon logs migration/open failures through existing startup error handling."
      ],
      "success_metric": "Storage tests prove runtime mode persistence across reopen and pre-R3 additive migration behavior.",
      "failure_metric": "Database open or runtime mode list/update failures fail storage tests before daemon integration."
    },
    "test_cases": [
      {
        "name": "runtime mode persists across reopen",
        "lens": "happy",
        "given": "A SQLite store upserts fake and Codex runtime modes, closes, and reopens.",
        "expect": "Both modes are returned by id and slug with JSON fields intact."
      },
      {
        "name": "pre-R3 database migrates",
        "lens": "happy_shadow_nil",
        "given": "A hand-created database with R2 `runs` and `runtime_sessions` schema only.",
        "expect": "Opening storage adds nullable columns and existing rows read without runtimeMode."
      },
      {
        "name": "empty filtered mode list",
        "lens": "happy_shadow_empty",
        "given": "A runtime filter for a well-formed missing runtime id.",
        "expect": "List returns `runtimeModes: []` and `nextCursor: null`."
      },
      {
        "name": "availability filter parity",
        "lens": "edge_filtering",
        "given": "Fake available, Codex unavailable, and a synthetic partial runtime mode in SQLite and in-memory stores.",
        "expect": "Filtering by `availability=partial` returns the same single mode and cursor shape in both stores."
      },
      {
        "name": "placement filter parity",
        "lens": "edge_filtering",
        "given": "Runtime modes with local supported, hosted unsupported, and connectedLocalNode conditional placement facts.",
        "expect": "Filtering by placement returns modes whose placement support is `supported` or `conditional` in both stores."
      },
      {
        "name": "filtered pagination parity",
        "lens": "edge_pagination",
        "given": "Three runtime modes matching `adapterType=process` and `limit=1` with repeated cursor paging.",
        "expect": "SQLite and in-memory stores return the same ordered ids and nextCursor progression."
      },
      {
        "name": "invalid availability JSON guarded",
        "lens": "error_path",
        "given": "A row with malformed `availability_json` inserted manually for test.",
        "expect": "Store conversion fails the test clearly rather than returning invalid contract data."
      },
      {
        "name": "invalid capabilities JSON guarded",
        "lens": "error_path",
        "given": "A row with malformed `capabilities_json` inserted manually for test.",
        "expect": "Store conversion fails clearly and never returns a public runtime mode with bogus capabilities."
      },
      {
        "name": "invalid placement JSON guarded",
        "lens": "error_path",
        "given": "A row with malformed `placement_json` inserted manually for test.",
        "expect": "Store conversion fails clearly and never returns a public runtime mode with bogus placement facts."
      },
      {
        "name": "capability filter requires all requested capabilities",
        "lens": "edge_filtering",
        "given": "Filters `capability=run.start,model.catalog` against fake and Codex modes.",
        "expect": "Only `codex.exec_json` is returned."
      }
    ],
    "integration_contracts": {
      "exports": [
        {
          "name": "SqliteRegistryStore",
          "kind": "class",
          "signature": "implements RegistryStore including runtime-mode methods"
        },
        {
          "name": "InMemoryRegistryStore",
          "kind": "class",
          "signature": "implements RegistryStore including runtime-mode methods with SQLite-equivalent filtering"
        },
        {
          "name": "SqliteRunStore",
          "kind": "class",
          "signature": "stores optional Run.runtimeMode in runs.runtime_mode"
        },
        {
          "name": "SqliteSessionStore",
          "kind": "class",
          "signature": "stores optional RuntimeSession.runtimeMode in runtime_sessions.runtime_mode"
        }
      ],
      "imports_from_other_tasks": [
        {
          "from_task": "P2-T1-contracts-runtime-mode-schemas",
          "name": "RuntimeMode and RuntimeAvailability",
          "signature": "types exported from @switchyard/contracts"
        },
        {
          "from_task": "P2-T2-core-capability-doctor-services",
          "name": "RegistryStore runtime-mode methods",
          "signature": "interface implemented by SQLite and in-memory stores"
        }
      ],
      "file_paths_consumed_by_other_tasks": [
        "packages/storage/src/sqlite/registry-store.ts",
        "packages/storage/src/sqlite/run-store.ts",
        "packages/storage/src/sqlite/session-store.ts",
        "packages/testkit/src/fake-stores.ts"
      ]
    }
  },
  {
    "id": "P2-T5-rest-runtime-mode-and-run-compat-api",
    "title": "Expose runtime mode list/lookup/check/doctor routes and run creation compatibility",
    "files": [
      "packages/protocol-rest/src/registry-helpers.ts",
      "packages/protocol-rest/src/registry-routes.ts",
      "packages/protocol-rest/src/run-routes.ts",
      "packages/protocol-rest/src/http-errors.ts",
      "packages/protocol-rest/src/index.ts",
      "packages/protocol-rest/test/registry-routes.test.ts",
      "packages/protocol-rest/test/run-routes.test.ts",
      "packages/protocol-rest/test/list-routes.test.ts"
    ],
    "dependencies": [
      "P2-T1-contracts-runtime-mode-schemas",
      "P2-T2-core-capability-doctor-services",
      "P2-T4-storage-runtime-mode-migration"
    ],
    "context_files": [
      "docs/superpowers/specs/2026-05-29-phase-2-r3-runtime-capability-infrastructure.md",
      "packages/protocol-rest/src/registry-routes.ts",
      "packages/protocol-rest/src/run-routes.ts",
      "packages/protocol-rest/src/http-errors.ts",
      "packages/protocol-rest/test/list-routes.test.ts",
      "packages/protocol-rest/test/run-routes.test.ts"
    ],
    "instructions": "Extend REST wiring in the existing style. Add `GET /runtime-modes`, `GET /runtime-modes/:id`, `POST /runtime-modes/:id/check`, and `GET /doctor`. Keep this as one task because ownership is exactly the existing registry/run REST seam and remains within 8 files; do not split unless implementation proves route coupling unmanageable. Route dependencies must require the registry store, doctor service, and registry service/runtime-mode validator; fail fast at route registration in tests if doctor/check wiring is absent. Query parsing must use the contract schemas and cursor helpers; provider/runtime slug resolution should mirror existing provider behavior and add runtime slug/id resolution. Add `runtime_mode_not_found` to REST status mapping. Extend `POST /runs` body parsing with optional `runtimeMode`; if absent infer shipped modes through core; if present accept only runtime mode slug values, reject internal `runtime_mode_*` ids, validate existence, and match against runtime/provider/adapterType before calling `RunService.createRun`. Keep existing run list behavior when no runtime mode filter exists.",
    "acceptance": [
      "`GET /runtime-modes` supports provider, runtime, adapterType, kind, availability, placement, capability, limit, and before filters.",
      "`GET /runtime-modes/:id` supports runtime mode id and slug lookup with tests for both forms.",
      "`POST /runtime-modes/:id/check` returns `200` with fresh unavailable states for expected local prerequisite failures and updates stored availability through the doctor service.",
      "`GET /doctor` returns latest stored runtime-mode snapshots and counts, including `partial`, without running fresh checks.",
      "Malformed query values return `400 invalid_query`; unknown lookup and unknown check ids return `404 runtime_mode_not_found`.",
      "Route registration requires doctor/check dependencies so active check routes cannot be accidentally mounted without an implementation.",
      "Existing fake and Codex run request bodies remain valid; explicit mismatched `runtimeMode` or internal runtime mode id returns `400 invalid_input`."
    ],
    "checks": [
      "pnpm --filter @switchyard/protocol-rest test",
      "pnpm --filter @switchyard/protocol-rest typecheck",
      "pnpm --filter @switchyard/protocol-rest build",
      "pnpm --filter @switchyard/protocol-rest lint"
    ],
    "error_rescue_map": [
      {
        "codepath": "GET /runtime-modes query parsing",
        "failure": "Unknown enum values match zero rows instead of returning invalid_query.",
        "exception": "Route test for `availability=banana` returns 200.",
        "rescue": "Use `listRuntimeModesQuerySchema` closed enums for kind/availability/placement/adapterType and keep slug-like freeform only for provider/runtime/capability where spec allows zero rows.",
        "user_sees": "Bad filters get actionable validation errors."
      },
      {
        "codepath": "POST /runtime-modes/:id/check",
        "failure": "Missing binary/model catalog reports HTTP 500.",
        "exception": "Doctor route test sees `internal_error` for expected unavailable check.",
        "rescue": "Treat `RuntimeDoctorService` expected check results as success payloads; reserve `internal_error` for actual service bugs.",
        "user_sees": "Local owners can diagnose unavailable runtimes through the API."
      },
      {
        "codepath": "registerRegistryRoutes dependency wiring",
        "failure": "Runtime mode check routes are mounted without a doctor service and fail at request time.",
        "exception": "Route harness can register runtime mode routes without doctor/check dependencies.",
        "rescue": "Make the doctor service dependency required in TypeScript and assert route registration throws a clear error if a JS caller omits it.",
        "user_sees": "Daemon startup fails fast during development instead of exposing broken doctor routes."
      },
      {
        "codepath": "POST /runs runtimeMode validation",
        "failure": "A mismatched explicit mode or internal runtime mode id launches the wrong adapter.",
        "exception": "Run route test returns 202/201 for runtime `fake` plus `runtimeMode: codex.exec_json` or id `runtime_mode_codex_exec_json`.",
        "rescue": "Validate slug shape before lookup, then compare mode runtime/provider/adapterType before createRun and throw `HttpProblem(\"invalid_input\", ...)` with details.",
        "user_sees": "Clients get a 400 and can correct their request before work starts."
      }
    ],
    "observability": {
      "logs": [
        "REST uses unified error envelope; daemon task adds service-level doctor logs."
      ],
      "success_metric": "Protocol REST tests cover runtime mode listing, lookup, check, doctor summary, invalid filters, not found, and run compatibility.",
      "failure_metric": "Any route error-envelope mismatch or runtimeMode compatibility regression fails REST tests."
    },
    "test_cases": [
      {
        "name": "list runtime modes by provider and availability",
        "lens": "happy",
        "given": "Seeded fake and Codex modes with Codex available.",
        "expect": "`GET /runtime-modes?provider=openai&availability=available` returns only `codex.exec_json`."
      },
      {
        "name": "runtime mode lookup by id",
        "lens": "happy",
        "given": "`GET /runtime-modes/runtime_mode_codex_exec_json` against a seeded registry.",
        "expect": "The route returns 200 with `runtimeMode.slug: codex.exec_json`."
      },
      {
        "name": "runtime mode lookup by slug",
        "lens": "happy",
        "given": "`GET /runtime-modes/codex.exec_json` against a seeded registry.",
        "expect": "The route returns 200 with `runtimeMode.id: runtime_mode_codex_exec_json`."
      },
      {
        "name": "default list pagination",
        "lens": "happy_shadow_nil",
        "given": "`GET /runtime-modes` without `before` or `limit`.",
        "expect": "The route uses default limit and returns a valid nullable cursor."
      },
      {
        "name": "well-formed missing runtime filter",
        "lens": "happy_shadow_empty",
        "given": "`GET /runtime-modes?runtime=missing-but-well-formed`.",
        "expect": "The route returns 200 with an empty runtimeModes array."
      },
      {
        "name": "invalid availability query",
        "lens": "error_path",
        "given": "`GET /runtime-modes?availability=banana`.",
        "expect": "The route returns `400 invalid_query` with details path `availability`."
      },
      {
        "name": "unknown runtime mode lookup returns 404",
        "lens": "error_path",
        "given": "`GET /runtime-modes/missing.mode`.",
        "expect": "The route returns `404 runtime_mode_not_found` through the unified envelope."
      },
      {
        "name": "unknown runtime mode check returns 404",
        "lens": "error_path",
        "given": "`POST /runtime-modes/missing.mode/check`.",
        "expect": "The route returns `404 runtime_mode_not_found` and does not call the adapter check."
      },
      {
        "name": "doctor route read-only",
        "lens": "integration",
        "given": "Stored fake available and Codex unavailable snapshots.",
        "expect": "`GET /doctor` returns counts and does not call the active check service."
      },
      {
        "name": "doctor route counts partial",
        "lens": "edge_partial",
        "given": "Stored fake available, Codex partial, and one unavailable snapshot.",
        "expect": "`GET /doctor` returns `summary.partial: 1` and preserves the partial runtime mode summary entry."
      },
      {
        "name": "check route returns partial",
        "lens": "edge_partial",
        "given": "Doctor service stub returns required checks passing and optional check failed for `codex.exec_json`.",
        "expect": "`POST /runtime-modes/codex.exec_json/check` returns 200 with `state: partial`, `canRun: true`, and warning diagnostics."
      },
      {
        "name": "registry routes require doctor dependency",
        "lens": "error_path",
        "given": "A test harness calls `registerRegistryRoutes(app, { registry })` without doctor/check services.",
        "expect": "Registration fails fast or TypeScript rejects the call; no broken active check endpoint is mounted."
      },
      {
        "name": "run create infers mode",
        "lens": "integration",
        "given": "Existing fake `POST /runs?wait=1` body without runtimeMode.",
        "expect": "Run completes and returned/stored run includes `runtimeMode: fake.deterministic`."
      },
      {
        "name": "run create accepts runtimeMode slug",
        "lens": "integration",
        "given": "A fake run create body with `runtimeMode: fake.deterministic`.",
        "expect": "The route creates the run and stores the slug."
      },
      {
        "name": "run create rejects runtimeMode id",
        "lens": "error_path",
        "given": "A fake run create body with `runtimeMode: runtime_mode_fake_deterministic`.",
        "expect": "The route returns `400 invalid_input` with details path `runtimeMode`."
      }
    ],
    "integration_contracts": {
      "exports": [
        {
          "name": "registerRegistryRoutes",
          "kind": "function",
          "signature": "(app: FastifyInstance, deps: { registry: RegistryStore; doctor: RuntimeDoctorService; registryService: RegistryService }) => void"
        },
        {
          "name": "registerRunRoutes",
          "kind": "function",
          "signature": "existing signature extended to accept registry/registryService for runtimeMode slug inference and validation"
        },
        {
          "name": "resolveRuntimeIds",
          "kind": "function",
          "signature": "(slugs?: readonly string[]) => string[] | undefined"
        }
      ],
      "imports_from_other_tasks": [
        {
          "from_task": "P2-T1-contracts-runtime-mode-schemas",
          "name": "listRuntimeModesQuerySchema and runtimeModeSlugSchema",
          "signature": "schemas exported from @switchyard/contracts"
        },
        {
          "from_task": "P2-T2-core-capability-doctor-services",
          "name": "RuntimeDoctorService and RegistryService",
          "signature": "services exported from @switchyard/core"
        },
        {
          "from_task": "P2-T4-storage-runtime-mode-migration",
          "name": "RegistryStore runtime-mode implementation",
          "signature": "runtime mode methods on SQLite/in-memory stores"
        }
      ],
      "file_paths_consumed_by_other_tasks": [
        "packages/protocol-rest/src/registry-routes.ts",
        "packages/protocol-rest/src/run-routes.ts",
        "packages/protocol-rest/src/http-errors.ts",
        "packages/protocol-rest/src/index.ts"
      ]
    }
  },
  {
    "id": "P2-T6-daemon-startup-capability-wiring",
    "title": "Wire daemon startup manifest seeding, runtime doctor services, and stored availability refresh",
    "files": [
      "apps/daemon/src/app.ts",
      "apps/daemon/test/smoke.test.ts"
    ],
    "dependencies": [
      "P2-T2-core-capability-doctor-services",
      "P2-T3-adapter-manifests-and-codex-checks",
      "P2-T4-storage-runtime-mode-migration",
      "P2-T5-rest-runtime-mode-and-run-compat-api"
    ],
    "context_files": [
      "docs/superpowers/specs/2026-05-29-phase-2-r3-runtime-capability-infrastructure.md",
      "apps/daemon/src/app.ts",
      "apps/daemon/test/smoke.test.ts",
      "packages/adapters/src/codex/codex-exec-json-adapter.ts",
      "packages/testkit/src/fake-runtime-adapter.ts"
    ],
    "instructions": "Instantiate fake and Codex adapters before capability seeding so their manifests are available. Seed existing provider/runtime/model records as today, then upsert runtime mode records from adapter manifests through `RuntimeCapabilityService`. Convert startup Codex probe results into the Codex runtime mode availability snapshot: binary unavailable -> unavailable/installed false, version success with no usable models -> unavailable/installed true/model_catalog_unavailable, version plus at least one model -> available/canRun true, and required checks passing with optional check failure -> partial/canRun true/optional_check_failed. Register `RuntimeDoctorService` with the REST routes as a required dependency. Ensure daemon startup and active checks are bounded by injected timeout/output settings; startup succeeds when Codex probe throws, times out, outputs too much, or reports unavailable, and messages/diagnostics are sanitized. Existing fake and Codex run dispatch must still use the `fake` and `codex` adapter keys.",
    "acceptance": [
      "Clean in-memory and SQLite daemon startup seeds providers, runtimes, models, and both runtime modes.",
      "Unavailable Codex probe does not crash startup and stores `codex.exec_json` as unavailable with sanitized reason.",
      "Available Codex probe marks provider/runtime and `codex.exec_json` available and seeds model records.",
      "Partial Codex probe/check marks `codex.exec_json` partial, keeps `canRun: true`, and increments `/doctor` partial counts.",
      "Hung or over-output Codex startup/check probes finish within the configured bound and store sanitized unknown/unavailable availability.",
      "`GET /runtime-modes`, lookup routes, active check route, and `GET /doctor` are reachable from the daemon app.",
      "Existing fake `POST /runs?wait=1` completes and stores inferred `runtimeMode`.",
      "Existing Codex exec-json `POST /runs/:id/input` remains `409 adapter_protocol_failed` for exec-json mode."
    ],
    "checks": [
      "pnpm --filter @switchyard/daemon test",
      "pnpm --filter @switchyard/daemon typecheck",
      "pnpm --filter @switchyard/daemon build",
      "pnpm --filter @switchyard/daemon lint"
    ],
    "error_rescue_map": [
      {
        "codepath": "createDaemonApp startup Codex probing",
        "failure": "Probe rejection prevents local daemon startup.",
        "exception": "Daemon smoke test with throwing probe rejects `createDaemonApp`.",
        "rescue": "Wrap injected/live probe call and convert expected failures to unavailable Codex runtime mode availability before route registration.",
        "user_sees": "Daemon starts even when local Codex is missing."
      },
      {
        "codepath": "createDaemonApp bounded startup check",
        "failure": "A hung Codex probe blocks daemon startup indefinitely.",
        "exception": "Daemon smoke test with a never-resolving probe exceeds the configured startup check timeout.",
        "rescue": "Apply the same check timeout/output bounds used by active doctor checks during startup seeding and store `unknown/check_timeout` or `unavailable/model_catalog_unavailable` depending on which required probe is unresolved.",
        "user_sees": "Daemon starts and reports the local runtime check as unknown/unavailable instead of hanging."
      },
      {
        "codepath": "startup seeding order",
        "failure": "Runtime modes are missing because routes register before manifests are seeded.",
        "exception": "`GET /runtime-modes/fake.deterministic` returns 404 in daemon smoke.",
        "rescue": "Seed provider/runtime/model records and manifest runtime modes before `registerRegistryRoutes`; keep startup seeding idempotent through upserts.",
        "user_sees": "Capability API works immediately after daemon starts."
      }
    ],
    "observability": {
      "logs": [
        "Log `runtime_mode.seeded` with runtimeMode, adapterId, state.",
        "Log `runtime_mode.check` with runtimeMode, state, canRun, reasonCode.",
        "Do not log secrets, environment dumps, token paths, private prompts, or full stack traces in diagnostics."
      ],
      "success_metric": "Daemon smoke tests prove runtime mode API and run compatibility under available and unavailable injected Codex probes.",
      "failure_metric": "Daemon startup rejection, missing runtime modes, or unsanitized diagnostics fail smoke tests."
    },
    "test_cases": [
      {
        "name": "startup seeds runtime modes",
        "lens": "happy",
        "given": "Daemon app with available Codex probe.",
        "expect": "`GET /runtime-modes` returns fake and Codex modes and `GET /doctor` counts both available."
      },
      {
        "name": "startup unavailable Codex",
        "lens": "error_path",
        "given": "Daemon app with unavailable or throwing Codex probe.",
        "expect": "App starts; Codex mode lookup returns `unavailable`; fake remains available."
      },
      {
        "name": "startup empty model catalog",
        "lens": "happy_shadow_empty",
        "given": "Version probe succeeds with `models: []`.",
        "expect": "`codex.exec_json` is unavailable with reason `model_catalog_unavailable` and no model records are seeded."
      },
      {
        "name": "startup partial codex availability",
        "lens": "edge_partial",
        "given": "Injected Codex probe reports version and model catalog success plus an optional sandbox-policy warning.",
        "expect": "`codex.exec_json` is stored as `partial`, canRun true, and `GET /doctor` reports `summary.partial: 1`."
      },
      {
        "name": "active check partial codex availability",
        "lens": "edge_partial",
        "given": "Daemon starts with Codex unavailable, then active doctor check returns required probes passing and one optional warning.",
        "expect": "`POST /runtime-modes/codex.exec_json/check` returns `partial`, canRun true, and a later `GET /doctor` reports `summary.partial: 1`."
      },
      {
        "name": "startup hung codex probe bounded",
        "lens": "error_path",
        "given": "Injected Codex probe/check never resolves and daemon is configured with a short check timeout.",
        "expect": "App starts; `codex.exec_json` reports `unknown` or `unavailable` with sanitized `check_timeout` diagnostics."
      },
      {
        "name": "active check hung codex probe bounded",
        "lens": "error_path",
        "given": "Daemon starts with Codex unavailable and active doctor check uses a never-resolving probe.",
        "expect": "`POST /runtime-modes/codex.exec_json/check` returns within the configured timeout and `GET /doctor` reflects the sanitized result."
      },
      {
        "name": "fake run still completes",
        "lens": "integration",
        "given": "Existing fake `POST /runs?wait=1` payload.",
        "expect": "Response status 201, run completed, response text preserved, runtimeMode stored."
      },
      {
        "name": "codex exec-json input remains unsupported",
        "lens": "integration",
        "given": "A stored/started Codex exec-json run and `POST /runs/:id/input` with any object body.",
        "expect": "Daemon returns `409 adapter_protocol_failed` with the existing Codex exec-json no-input message."
      },
      {
        "name": "active check updates stored availability",
        "lens": "integration",
        "given": "Codex mode starts unavailable then active check service returns available.",
        "expect": "`POST /runtime-modes/codex.exec_json/check` returns available and a later `GET /doctor` reflects updated counts."
      }
    ],
    "integration_contracts": {
      "exports": [
        {
          "name": "createDaemonApp",
          "kind": "function",
          "signature": "existing signature extended internally to wire capability/doctor services; injected codexProbe/probeCodexCatalog test hooks preserved"
        }
      ],
      "imports_from_other_tasks": [
        {
          "from_task": "P2-T2-core-capability-doctor-services",
          "name": "RuntimeCapabilityService, RuntimeDoctorService, RegistryService",
          "signature": "services exported from @switchyard/core"
        },
        {
          "from_task": "P2-T3-adapter-manifests-and-codex-checks",
          "name": "FakeRuntimeAdapter.manifest and CodexExecJsonAdapter.manifest",
          "signature": "RuntimeAdapterManifest properties"
        },
        {
          "from_task": "P2-T5-rest-runtime-mode-and-run-compat-api",
          "name": "registerRegistryRoutes/registerRunRoutes",
          "signature": "route registration functions with runtime mode dependencies"
        }
      ],
      "file_paths_consumed_by_other_tasks": [
        "apps/daemon/src/app.ts"
      ]
    }
  },
  {
    "id": "P2-T7-product-api-docs-closeout",
    "title": "Update product, API, development, and adapter docs for R3 capability inspection",
    "files": [
      "PRODUCT.md",
      "CHANGELOG.md",
      "docs/development/API.md",
      "docs/development/DEVELOPMENT.md",
      "docs/development/adapters/CODEX.md",
      "docs/adapters/README.md",
      "ARCHITECTURE.md"
    ],
    "dependencies": [
      "P2-T5-rest-runtime-mode-and-run-compat-api",
      "P2-T6-daemon-startup-capability-wiring"
    ],
    "context_files": [
      "docs/superpowers/specs/2026-05-29-phase-2-r3-runtime-capability-infrastructure.md",
      "PRODUCT.md",
      "CHANGELOG.md",
      "docs/development/API.md",
      "docs/development/DEVELOPMENT.md",
      "docs/development/adapters/CODEX.md",
      "docs/adapters/README.md"
    ],
    "instructions": "Update docs after implementation behavior is known. `PRODUCT.md` must state that R3 runtime capability inspection is shipped and name `fake.deterministic` plus `codex.exec_json` as the only shipped runtime modes. `CHANGELOG.md` should add an Unreleased R3 entry. `docs/development/API.md` must document runtime mode records, list/lookup/check/doctor endpoints, query parameters, error code `runtime_mode_not_found`, optional `runtimeMode` in run objects, runtimeMode slug-only create-run semantics, partial availability, timeout/output-bounded active checks, and compatibility rules. `docs/development/DEVELOPMENT.md` must add local smoke curls for `/runtime-modes`, active check, and `/doctor`. `docs/development/adapters/CODEX.md` must clearly say Codex R3 support is local one-shot `exec --json`, doctor checks do not run tasks, checks are bounded, and unavailable/unknown checks are expected when binary/catalog probes are absent, slow, or too large. `docs/adapters/README.md` and `ARCHITECTURE.md` must use precise provider/runtime/runtime mode/model/adapter wording without claiming future modes are available.",
    "acceptance": [
      "Docs list `GET /runtime-modes`, `GET /runtime-modes/:id`, `POST /runtime-modes/:id/check`, and `GET /doctor` with example payloads.",
      "Docs explain provider, runtime, runtime mode, model, and adapter distinctions in owner-facing language.",
      "Docs state `codex.exec_json` is local one-shot, non-interactive, and not hosted-safe in R3.",
      "Docs state `POST /runs.runtimeMode` accepts runtime mode slugs such as `codex.exec_json`, not internal runtime mode ids.",
      "Docs explain `partial`, `unknown`, and timeout/output-bound doctor check behavior.",
      "Docs do not claim interactive Codex, PTY, Generic HTTP, ACP, hosted, SDK, CLI, dashboard, auth/rate limiting, or OpenAPI generation are shipped.",
      "Development docs include the final full workspace verification commands and local daemon smoke curls from the spec.",
      "`CHANGELOG.md` no longer says there are no unreleased changes."
    ],
    "checks": [
      "git diff --check",
      "pnpm --filter @switchyard/protocol-rest test",
      "pnpm --filter @switchyard/daemon test"
    ],
    "error_rescue_map": [
      {
        "codepath": "docs/development/API.md runtime mode docs",
        "failure": "API docs drift from implemented response shape.",
        "exception": "Manual comparison or route tests show fields documented but not returned.",
        "rescue": "Base examples on contract schemas and daemon smoke JSON, and keep optional/null fields clear.",
        "user_sees": "Curl examples match actual daemon responses."
      },
      {
        "codepath": "PRODUCT.md current snapshot",
        "failure": "Product truth overstates future adapters or hosted execution.",
        "exception": "Scope audit finds out-of-scope modes marked as implemented.",
        "rescue": "Use explicit shipped-mode list and move future modes to Not Implemented/roadmap wording.",
        "user_sees": "Owners know exactly what this local instance can inspect and run."
      }
    ],
    "observability": {
      "logs": [
        "Docs should reference daemon logs `runtime_mode.seeded` and `runtime_mode.check` once Task P2-T6 adds them."
      ],
      "success_metric": "Docs provide enough curl commands for an owner to inspect runtime modes and doctor state without SQLite spelunking.",
      "failure_metric": "Docs mention shipped support for any out-of-scope R3 item or omit the new endpoints."
    },
    "test_cases": [
      {
        "name": "api docs include runtime mode examples",
        "lens": "happy",
        "given": "A reader follows the API doc examples.",
        "expect": "They can list modes, lookup fake/Codex modes, run a check, and read doctor counts."
      },
      {
        "name": "docs handle missing Codex",
        "lens": "error_path",
        "given": "Local Codex binary or model catalog is unavailable.",
        "expect": "Docs describe expected unavailable doctor payload and no daemon crash."
      },
      {
        "name": "docs preserve old run body",
        "lens": "happy_shadow_nil",
        "given": "A user sends the old fake or Codex run create payload without runtimeMode.",
        "expect": "Docs explain inference and backward compatibility."
      },
      {
        "name": "docs clarify runtimeMode slug only",
        "lens": "edge_contract",
        "given": "A user wants to pass `runtimeMode` to `POST /runs`.",
        "expect": "Docs show slug examples and state internal `runtime_mode_*` ids are only for lookup/storage records, not run creation bodies."
      },
      {
        "name": "docs describe partial and bounded checks",
        "lens": "edge_partial",
        "given": "An optional Codex check fails or a local check times out.",
        "expect": "Docs explain `partial` for optional failures, `unknown`/`unavailable` for bounded required check failures, and sanitized diagnostics."
      },
      {
        "name": "docs do not advertise future modes",
        "lens": "edge_scope_guard",
        "given": "Search docs for `interactive`, `pty`, `generic_http`, `acp`, and `hosted`.",
        "expect": "Occurrences are clearly marked as not shipped or future, not available."
      }
    ],
    "integration_contracts": {
      "exports": [
        {
          "name": "R3 documentation",
          "kind": "constant",
          "signature": "User-facing docs describing runtime capability inspection and verification"
        }
      ],
      "imports_from_other_tasks": [
        {
          "from_task": "P2-T5-rest-runtime-mode-and-run-compat-api",
          "name": "REST endpoint behavior",
          "signature": "runtime mode and doctor route response shapes"
        },
        {
          "from_task": "P2-T6-daemon-startup-capability-wiring",
          "name": "Daemon smoke behavior",
          "signature": "local verification commands and runtime mode availability outcomes"
        }
      ],
      "file_paths_consumed_by_other_tasks": []
    }
  }
]
```

## Execution Order

1. `P2-T1-contracts-runtime-mode-schemas`
2. `P2-T2-core-capability-doctor-services`
3. `P2-T3-adapter-manifests-and-codex-checks` and `P2-T4-storage-runtime-mode-migration` can proceed after T2.
4. `P2-T5-rest-runtime-mode-and-run-compat-api` after T4.
5. `P2-T6-daemon-startup-capability-wiring` after T3, T4, and T5.
6. `P2-T7-product-api-docs-closeout` after T5 and T6.

## Final Verification

Focused checks:

```bash
git diff --check
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/core test
pnpm --filter @switchyard/storage test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/testkit test
pnpm --filter @switchyard/daemon test
```

Full workspace checks before promotion:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

Local daemon smoke:

```bash
SWITCHYARD_PORT=4546 \
SWITCHYARD_DATA_DIR=/private/tmp/switchyard-r3-capabilities \
SWITCHYARD_LOG_LEVEL=info \
pnpm --filter @switchyard/daemon dev
```

In another shell:

```bash
BASE=http://127.0.0.1:4546

curl -s "$BASE/health"
curl -s "$BASE/runtime-modes" | python3 -m json.tool
curl -s "$BASE/runtime-modes/fake.deterministic" | python3 -m json.tool
curl -s "$BASE/runtime-modes/codex.exec_json" | python3 -m json.tool
curl -s -X POST "$BASE/runtime-modes/codex.exec_json/check" | python3 -m json.tool
curl -s "$BASE/doctor" | python3 -m json.tool

curl -s -X POST "$BASE/runs?wait=1" \
  -H 'content-type: application/json' \
  -d '{"runtime":"fake","provider":"test","model":"test-model","adapterType":"process","cwd":"/repo","task":"r3 smoke"}' \
  | python3 -m json.tool
```

Expected smoke results:

- `fake.deterministic` is always available.
- `codex.exec_json` is available only when `codex --version` and `codex debug models` both succeed with at least one model.
- Missing Codex or failed model catalog reports unavailable through runtime mode/doctor payloads without daemon crash.
- Old fake and Codex run create bodies still work; new run records include inferred `runtimeMode`.

## Plan Self-Review

13-item CTO self-review:

1. Spec alignment: pass.
2. R3-only scope: pass.
3. Existing-code grounding: pass.
4. Minimal change path: pass.
5. Disjoint task ownership: pass.
6. Context files present for every task: pass.
7. Dependencies complete: pass.
8. Acceptance criteria concrete: pass.
9. Focused checks per task: pass.
10. Error rescue maps present: pass.
11. Observability included: pass.
12. Test cases cover happy, nil, empty, error, and integration paths: pass.
13. Final broad verification includes typecheck, test, build, lint, and diff whitespace: pass.

9-item plan completeness self-test:

1. Every task has `id`: pass.
2. Every task has `title`: pass.
3. Every task has disjoint `files`: pass.
4. Every task has `dependencies`: pass.
5. Every task has non-empty `context_files`: pass.
6. Every task has `instructions`: pass.
7. Every task has `acceptance` and `checks`: pass.
8. Every task has `error_rescue_map`, `observability`, and `test_cases`: pass.
9. Every task has `integration_contracts`: pass.

## Concerns

- `AGENTS.md` and `prompts/cto.md` are not present in this phase worktree; this plan uses the user-provided AGENTS text and the runtime constraints supplied with the task, without reading the root checkout.
- `pnpm lint` may only execute packages that define a `lint` script. The final broad check is still included because the phase requirement explicitly asks for it.
- Runtime-mode migration touches hand-written SQLite SQL and Drizzle table definitions together; implementers should treat the pre-R3 reopen test as blocking.
