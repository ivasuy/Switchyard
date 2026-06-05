# Phase 2 Spec: R3 Runtime Capability Infrastructure

Date: 2026-05-29

Roadmap release: R3: Runtime Capability Infrastructure

Branch: `agent/phase-2-r3-runtime-capability-infrastructure`

Previous phase head: `agent/phase-1-r0-r2-verification-and-release-truth-reconciliation` at `6687954e2c7361ba2eb14b31182c4e46d0fb358d`

Spec target: `docs/superpowers/specs/2026-05-29-phase-2-r3-runtime-capability-infrastructure.md`

## Summary

R3 adds the capability layer Switchyard needs before connecting more adapters. After this phase, clients can inspect the exact runtime modes this local Switchyard instance knows about, what each mode can do, where it can run, and whether local prerequisites are currently satisfied.

The release must make `codex.exec_json` explicit as a local one-shot process mode. It must not describe "Codex" as broadly interactive or hosted-safe. The fake runtime must report deterministic capabilities. Existing run creation for `fake` and `codex` must continue to work.

## Scope Gate

In scope:

- Runtime mode vocabulary and records, starting with `fake.deterministic` and `codex.exec_json`.
- Adapter manifest shape that declares capabilities, limitations, placement facts, and check behavior.
- Runtime-mode registry APIs for listing and single lookup.
- Doctor/check API for safe runtime inspection.
- Availability states that distinguish `available`, `installed`, `unavailable`, `unsupported`, `partial`, and `unknown`.
- Registry storage/schema updates for capability records.
- Placement facts for `local`, `hosted`, and `connected_local_node`.
- Clear public wording for provider, runtime, runtime mode, model, and adapter.
- Backward-compatible run creation that can infer `codex.exec_json` from the existing Codex payload.

Out of scope:

- Full interactive Codex runtime.
- PTY support.
- OpenCode, Claude Code, AgentField, Generic HTTP, OpenClaw, Paperclip, Cursor, or other broad adapter expansion.
- Hosted worker execution.
- Hybrid node execution.
- Policy enforcement that rejects all unavailable runtime runs before launch.
- SDK, CLI, dashboard, OpenAPI generation, auth, rate limiting, debate, memory, tools, or approval workflow expansion.

## Ground Truth From Current Code

This spec is based on the current worktree files, not on aspirational architecture alone.

Current registry contracts in `packages/contracts/src/registry.ts` are provider/runtime/model only:

```ts
export const registryStatusSchema = z.enum(["available", "unavailable", "degraded", "unknown"]);
export const authModeSchema = z.enum(["none", "local", "api_key", "oauth", "custom"]);

export const providerSchema = z.object({
  id: providerIdSchema,
  name: z.string().min(1),
  authMode: authModeSchema,
  status: registryStatusSchema
});

export const runtimeSchema = z.object({
  id: runtimeIdSchema,
  name: z.string().min(1),
  adapterType: adapterTypeSchema,
  status: registryStatusSchema,
  providerId: providerIdSchema.optional()
});
```

Current adapters implement the protocol-neutral interface in `packages/core/src/ports/runtime-adapter.ts`:

```ts
export interface RuntimeAdapter {
  readonly id: string;
  check(config?: Record<string, unknown>): Promise<RuntimeAdapterCheck>;
  start(request: Record<string, unknown>): Promise<RuntimeStartResult>;
  send(session: Record<string, unknown>, input: Record<string, unknown>): Promise<void>;
  cancel(session: Record<string, unknown>): Promise<void>;
  events(session: Record<string, unknown>): AsyncIterable<SwitchyardEvent>;
  tools(session: Record<string, unknown>): Promise<string[]>;
  artifacts(session: Record<string, unknown>): Promise<Artifact[]>;
}
```

Current local API docs say registry records are returned as stored, and that health/capability/partial-support reporting is R3+:

```json
{ "providers": [ /* records */ ], "nextCursor": "...|null" }
{ "runtimes":  [ /* records */ ], "nextCursor": "...|null" }
{ "models":    [ /* records */ ], "nextCursor": "...|null" }
```

R3 must build on this shape instead of replacing it.

## Product Terms

Provider:

- The organization, product owner, or auth boundary behind models or runtimes.
- Current examples: `provider_test`, `provider_openai`.
- Public slug examples: `test`, `openai`.
- A provider does not prove a runnable mode by itself.

Runtime:

- A family of executable targets exposed through Switchyard.
- Current examples: `runtime_fake`, `runtime_codex`.
- Public slug examples: `fake`, `codex`.
- A runtime can have one or more runtime modes. Runtime status is an aggregate and must not imply every possible mode is implemented.

Runtime mode:

- The exact implemented way Switchyard can run or inspect a runtime.
- Public slug examples: `fake.deterministic`, `codex.exec_json`.
- Future vocabulary examples, not implemented in R3: `codex.interactive`, `opencode.acp`, `agentfield.async_rest`, `generic_http.sync`.
- A mode is the unit clients use to decide what this instance can actually run.

Model:

- A model identifier and feature facts under a provider.
- Current Codex model records come from `codex debug models` when available.
- A model does not imply every runtime mode can use it.

Adapter:

- Switchyard code that implements the `RuntimeAdapter` interface for a mode or set of modes.
- Current adapter IDs are `fake` and `codex`.
- R3 adds a manifest contract so adapters declare what they support instead of relying on broad runtime names.

## Runtime Mode Vocabulary

R3 must introduce a public runtime mode slug vocabulary.

Slug rules:

- Lowercase ASCII.
- Two or more dot-separated segments.
- Segment characters: `a-z`, `0-9`, underscore, hyphen.
- Regex: `^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$`.

Required R3 records:

| Runtime mode slug | Runtime mode id | Provider | Runtime | Adapter type | Meaning |
| --- | --- | --- | --- | --- | --- |
| `fake.deterministic` | `runtime_mode_fake_deterministic` | `provider_test` | `runtime_fake` | `process` | Deterministic local test mode used for smoke and contract coverage. |
| `codex.exec_json` | `runtime_mode_codex_exec_json` | `provider_openai` | `runtime_codex` | `process` | Local one-shot non-interactive `codex exec --json`. |

Reserved vocabulary examples only:

- `codex.interactive`
- `codex.pty`
- `opencode.acp`
- `agentfield.async_rest`
- `generic_http.sync`
- `generic_http.async_rest`

Reserved examples must not be seeded as available records in R3 unless the implementation genuinely supports them.

## Public Contract

### New Schemas

Add contract schemas in `packages/contracts`, exported from `packages/contracts/src/index.ts`.

Suggested names:

- `runtimeModeSlugSchema`
- `runtimeModeIdSchema`
- `runtimeModeKindSchema`
- `runtimeCapabilitySchema`
- `runtimeLimitationSchema`
- `runtimePlacementFactsSchema`
- `runtimeAvailabilitySchema`
- `runtimeDoctorCheckSchema`
- `runtimeModeSchema`
- `listRuntimeModesQuerySchema`
- `listRuntimeModesResponseSchema`
- `doctorSummaryResponseSchema`

Runtime mode kind enum:

```ts
z.enum([
  "deterministic_fake",
  "one_shot_process",
  "interactive_process",
  "pty",
  "acp",
  "sdk",
  "sync_http",
  "async_rest",
  "browser_backed"
])
```

Availability state enum:

```ts
z.enum([
  "available",
  "installed",
  "unavailable",
  "unsupported",
  "partial",
  "unknown"
])
```

Placement support enum:

```ts
z.enum(["supported", "unsupported", "conditional", "future", "unknown"])
```

Capability strings are deliberately small and explicit in R3. The initial allowed strings must include:

```text
run.start
run.cancel
run.timeout
event.normalized
event.streaming
artifact.transcript
artifact.raw_transcript
model.catalog
tool.fake_echo
auth.none
auth.local
sandbox.read_only
sandbox.workspace_write
sandbox.danger_full_access
```

Do not add a generic `interactive` capability unless a real interactive mode ships.

### Runtime Mode Record

Public runtime mode records use this shape:

```json
{
  "id": "runtime_mode_codex_exec_json",
  "slug": "codex.exec_json",
  "name": "Codex exec JSON",
  "providerId": "provider_openai",
  "runtimeId": "runtime_codex",
  "adapterId": "codex",
  "adapterType": "process",
  "kind": "one_shot_process",
  "status": "available",
  "capabilities": [
    "run.start",
    "run.cancel",
    "run.timeout",
    "event.normalized",
    "event.streaming",
    "artifact.transcript",
    "artifact.raw_transcript",
    "model.catalog",
    "auth.local",
    "sandbox.read_only",
    "sandbox.workspace_write",
    "sandbox.danger_full_access"
  ],
  "limitations": [
    {
      "code": "one_shot_no_input",
      "message": "codex.exec_json does not support post-start input."
    },
    {
      "code": "local_only",
      "message": "This mode runs a local Codex CLI process and is not hosted-safe in R3."
    }
  ],
  "placement": {
    "local": {
      "support": "supported",
      "reason": "Requires a PATH-reachable local codex binary and local workspace."
    },
    "hosted": {
      "support": "unsupported",
      "reason": "Hosted subprocess execution is not shipped in R3."
    },
    "connectedLocalNode": {
      "support": "future",
      "reason": "Hybrid node execution is planned for R10."
    }
  },
  "availability": {
    "state": "available",
    "canRun": true,
    "installed": true,
    "auth": "configured",
    "version": "codex-cli 0.130.0",
    "checkedAt": "2026-05-29T00:00:00.000Z",
    "reasonCode": null,
    "message": null
  },
  "docsPath": "docs/development/adapters/CODEX.md",
  "createdAt": "2026-05-29T00:00:00.000Z",
  "updatedAt": "2026-05-29T00:00:00.000Z"
}
```

Rules:

- `status` mirrors `availability.state` unless a storage-only record has not been checked, in which case both are `unknown`.
- `canRun` is true only when this exact mode can be started through the current Switchyard instance.
- `installed` is true only when the required local binary/library/endpoint is present.
- `auth` is one of `not_required`, `configured`, `missing`, `unknown`.
- `reasonCode` is nullable and machine-readable.
- `message` is nullable and human-readable. It must not contain secrets, full environment dumps, local token paths, or private prompt text.
- `createdAt` and `updatedAt` are ISO strings.

### Adapter Manifest Shape

Each adapter added or updated in R3 must provide a static manifest object. The exact implementation can be a method, exported constant, or constructor field, but the CTO plan must choose one pattern and apply it consistently to fake and Codex.

Suggested TypeScript shape:

```ts
export interface RuntimeAdapterManifest {
  adapterId: string;
  providerId: string;
  runtimeId: string;
  runtimeModeId: string;
  runtimeModeSlug: string;
  name: string;
  adapterType: AdapterType;
  kind: RuntimeModeKind;
  capabilities: RuntimeCapability[];
  limitations: RuntimeLimitation[];
  placement: RuntimePlacementFacts;
  docsPath?: string;
  check: {
    strategy: "none" | "binary_version" | "binary_version_and_model_catalog" | "http_health" | "custom";
    required: string[];
    optional: string[];
  };
}
```

Manifest rules:

- A manifest declares intended capabilities and limitations; a doctor check reports current availability.
- A manifest must be deterministic and safe to read without executing a model task.
- A manifest must be included in tests so future adapters cannot skip capability declaration.
- If an adapter implements multiple modes later, each mode gets its own manifest record.
- `codex.exec_json` must declare `one_shot_no_input`; it must not declare `run.input`, `session.resume`, approval bridging, PTY, or hosted support.

### Required Manifests

`fake.deterministic`:

- Provider: `provider_test`.
- Runtime: `runtime_fake`.
- Adapter ID: `fake`.
- Kind: `deterministic_fake`.
- Capabilities: `run.start`, `run.cancel`, `event.normalized`, `event.streaming`, `artifact.transcript`, `tool.fake_echo`, `auth.none`.
- Limitations: deterministic output only; no real model or provider auth.
- Placement: `local` supported, `hosted` unsupported in R3, `connectedLocalNode` future.
- Availability: always `available`, `canRun: true`, `installed: true`, `auth: "not_required"` in local daemon/testkit.

`codex.exec_json`:

- Provider: `provider_openai`.
- Runtime: `runtime_codex`.
- Adapter ID: `codex`.
- Kind: `one_shot_process`.
- Capabilities: start, cancel, timeout, normalized/streaming events, transcript/raw transcript artifacts, model catalog, local auth, supported sandbox strings.
- Limitations: one-shot, no post-start input, local-only, no approval bridge, no session resume.
- Placement: `local` supported when available, `hosted` unsupported in R3, `connectedLocalNode` future.
- Availability check:
  - `codex --version` fails or binary missing: `state: "unavailable"`, `canRun: false`, `installed: false`, `reasonCode: "binary_unavailable"`.
  - `codex --version` succeeds but `codex debug models` fails or returns no usable models: `state: "unavailable"`, `canRun: false`, `installed: true`, `reasonCode: "model_catalog_unavailable"`.
  - both version and model catalog succeed with at least one model: `state: "available"`, `canRun: true`, `installed: true`, `reasonCode: null`.
  - adapter compiled out or manifest registered without implementation: `state: "unsupported"`, `canRun: false`, `reasonCode: "adapter_not_registered"`.

## REST API

R3 keeps existing REST style: Fastify routes, JSON success envelopes, cursor pagination, slug shortcuts for single-record lookups, and unified error envelopes.

### `GET /runtime-modes`

List runtime mode capability records.

Query parameters:

| Name | Type | Notes |
| --- | --- | --- |
| `provider` | CSV slug or provider id | Same slug-to-id behavior as `GET /runtimes?provider=openai`. |
| `runtime` | CSV slug or runtime id | Slugs like `codex`; ids like `runtime_codex`. Unknown well-formed values match zero rows. |
| `adapterType` | CSV adapter type enum | Same enum as current runs and runtimes. |
| `kind` | CSV runtime mode kind enum | Unknown enum values produce `400 invalid_query`. |
| `availability` | CSV availability state enum | Filters `availability.state`. |
| `placement` | CSV execution placement enum | Matches modes where that placement support is `supported` or `conditional`. |
| `capability` | CSV capability string | Matches modes containing every requested capability. Unknown well-formed capability strings match zero rows. |
| `limit` | integer | Default `50`, max `200`. |
| `before` | opaque cursor | From previous response. |

Response:

```json
{
  "runtimeModes": [
    {
      "id": "runtime_mode_fake_deterministic",
      "slug": "fake.deterministic",
      "name": "Fake deterministic runtime",
      "providerId": "provider_test",
      "runtimeId": "runtime_fake",
      "adapterId": "fake",
      "adapterType": "process",
      "kind": "deterministic_fake",
      "status": "available",
      "capabilities": ["run.start", "run.cancel", "event.normalized", "artifact.transcript", "tool.fake_echo", "auth.none"],
      "limitations": [
        { "code": "deterministic_only", "message": "Outputs are fixed for local smoke and contract tests." }
      ],
      "placement": {
        "local": { "support": "supported", "reason": "In-process deterministic test adapter." },
        "hosted": { "support": "unsupported", "reason": "Hosted worker execution is not shipped in R3." },
        "connectedLocalNode": { "support": "future", "reason": "Hybrid node execution is planned for R10." }
      },
      "availability": {
        "state": "available",
        "canRun": true,
        "installed": true,
        "auth": "not_required",
        "version": null,
        "checkedAt": "2026-05-29T00:00:00.000Z",
        "reasonCode": null,
        "message": null
      },
      "createdAt": "2026-05-29T00:00:00.000Z",
      "updatedAt": "2026-05-29T00:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

### `GET /runtime-modes/:id`

Return one runtime mode by id or slug.

Accepted examples:

- `/runtime-modes/runtime_mode_codex_exec_json`
- `/runtime-modes/codex.exec_json`

Response:

```json
{
  "runtimeMode": {
    "id": "runtime_mode_codex_exec_json",
    "slug": "codex.exec_json",
    "runtimeId": "runtime_codex",
    "providerId": "provider_openai",
    "adapterId": "codex",
    "adapterType": "process",
    "kind": "one_shot_process",
    "status": "available",
    "capabilities": ["run.start", "run.cancel", "run.timeout", "event.normalized", "artifact.transcript", "model.catalog", "auth.local"],
    "limitations": [
      { "code": "one_shot_no_input", "message": "codex.exec_json does not support post-start input." }
    ],
    "availability": {
      "state": "available",
      "canRun": true,
      "installed": true,
      "auth": "configured",
      "version": "codex-cli 0.130.0",
      "checkedAt": "2026-05-29T00:00:00.000Z",
      "reasonCode": null,
      "message": null
    }
  }
}
```

### `POST /runtime-modes/:id/check`

Run a safe doctor check for one runtime mode and return the fresh result. The check must not execute a model task, mutate the user's workspace, open an interactive session, or leak secrets. It may update the stored availability snapshot for that runtime mode.

Accepted examples:

- `/runtime-modes/runtime_mode_codex_exec_json/check`
- `/runtime-modes/codex.exec_json/check`

Response:

```json
{
  "check": {
    "runtimeModeId": "runtime_mode_codex_exec_json",
    "runtimeMode": "codex.exec_json",
    "providerId": "provider_openai",
    "runtimeId": "runtime_codex",
    "state": "available",
    "canRun": true,
    "installed": true,
    "auth": "configured",
    "version": "codex-cli 0.130.0",
    "checkedAt": "2026-05-29T00:00:00.000Z",
    "capabilities": ["run.start", "run.cancel", "run.timeout", "event.normalized", "artifact.transcript", "model.catalog", "auth.local"],
    "limitations": [
      { "code": "one_shot_no_input", "message": "codex.exec_json does not support post-start input." }
    ],
    "diagnostics": [
      { "code": "binary_version_ok", "severity": "info", "message": "codex --version succeeded." },
      { "code": "model_catalog_ok", "severity": "info", "message": "codex debug models returned at least one model." }
    ]
  }
}
```

Failure to find the local Codex binary is still a successful HTTP response if the mode exists:

```json
{
  "check": {
    "runtimeModeId": "runtime_mode_codex_exec_json",
    "runtimeMode": "codex.exec_json",
    "providerId": "provider_openai",
    "runtimeId": "runtime_codex",
    "state": "unavailable",
    "canRun": false,
    "installed": false,
    "auth": "unknown",
    "version": null,
    "checkedAt": "2026-05-29T00:00:00.000Z",
    "capabilities": ["run.start", "run.cancel", "run.timeout", "event.normalized", "artifact.transcript", "model.catalog", "auth.local"],
    "limitations": [
      { "code": "one_shot_no_input", "message": "codex.exec_json does not support post-start input." }
    ],
    "diagnostics": [
      { "code": "binary_unavailable", "severity": "error", "message": "codex binary is not available on PATH." }
    ]
  }
}
```

Unexpected check-service failures use the unified `500 internal_error` envelope. Expected runtime unavailability must not throw a 500.

### `GET /doctor`

Return a read-only summary of the latest stored runtime-mode check snapshots. This endpoint does not run fresh checks; use `POST /runtime-modes/:id/check` for an active check.

Response:

```json
{
  "runtimeModes": [
    {
      "runtimeModeId": "runtime_mode_fake_deterministic",
      "runtimeMode": "fake.deterministic",
      "state": "available",
      "canRun": true,
      "checkedAt": "2026-05-29T00:00:00.000Z"
    },
    {
      "runtimeModeId": "runtime_mode_codex_exec_json",
      "runtimeMode": "codex.exec_json",
      "state": "available",
      "canRun": true,
      "checkedAt": "2026-05-29T00:00:00.000Z"
    }
  ],
  "summary": {
    "available": 2,
    "installed": 0,
    "partial": 0,
    "unavailable": 0,
    "unsupported": 0,
    "unknown": 0
  }
}
```

## Error Behavior

Extend the closed HTTP error code set with:

| Code | HTTP | Used for |
| --- | --- | --- |
| `runtime_mode_not_found` | 404 | Unknown runtime mode id or slug in single-record/check routes. |

Rules:

- List endpoints with valid filters return `200` and an empty array when nothing matches.
- Malformed runtime mode filters return `400 invalid_query` with `details`.
- Malformed `POST /runtime-modes/:id/check` body, if a body is accepted later, returns `400 invalid_input`.
- Missing runtime mode on lookup or check returns `404 runtime_mode_not_found`.
- Runtime prerequisite failures such as missing binary, missing auth, or model catalog failure return `200` with `state: "unavailable"` or `state: "partial"` in the check payload.
- Public diagnostics must be sanitized. They may include stable reason codes and short messages, not secrets, full env output, private paths to credentials, prompt text, or full stack traces.

## Registry And Storage

R3 should add runtime mode storage rather than overloading the existing `runtimes` table with opaque JSON blobs only.

Required SQLite changes:

- Add a `runtime_modes` table.
- Add an additive nullable `runtime_mode` column to `runs`.
- Add an additive nullable `runtime_mode` column to `runtime_sessions`.

Suggested `runtime_modes` columns:

```text
id TEXT PRIMARY KEY NOT NULL
slug TEXT NOT NULL UNIQUE
name TEXT NOT NULL
provider_id TEXT NOT NULL
runtime_id TEXT NOT NULL
adapter_id TEXT NOT NULL
adapter_type TEXT NOT NULL
kind TEXT NOT NULL
status TEXT NOT NULL
capabilities_json TEXT NOT NULL
limitations_json TEXT NOT NULL
placement_json TEXT NOT NULL
availability_json TEXT NOT NULL
docs_path TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Indexes:

- `runtime_modes_slug_idx` unique on `slug`.
- `runtime_modes_provider_id_idx` on `provider_id`.
- `runtime_modes_runtime_id_idx` on `runtime_id`.
- `runtime_modes_status_idx` on `status`.

Migration rules:

- Use additive migrations only.
- Preserve existing records in `providers`, `runtimes`, and `models`.
- Existing rows in `runs` and `runtime_sessions` can have `runtime_mode` null.
- New `fake` runs should store `runtimeMode: "fake.deterministic"` when inferred.
- New `codex` runs should store `runtimeMode: "codex.exec_json"` when inferred.
- Reopening an existing SQLite database must not fail if it lacks R3 columns.
- In-memory stores in `packages/testkit` must implement the same runtime-mode registry interface.

## Core Services And Ports

Add a protocol-neutral capability/doctor layer under `packages/core`.

Suggested interfaces:

- `RuntimeModeRegistryStore`: create/upsert/get/list runtime mode records.
- `RuntimeCapabilityService`: converts manifests and check results into runtime mode records.
- `RuntimeDoctorService`: runs safe checks and returns sanitized `RuntimeDoctorCheck` objects.

The current `RegistryStore` can either be extended or paired with a new runtime-mode store. The CTO plan should prefer the smaller change that keeps existing provider/runtime/model methods stable.

Required behavior:

- Startup seeding upserts fake and Codex runtime mode records from manifests.
- Startup Codex probing may refresh the stored availability snapshot.
- `RuntimeDoctorService` uses adapter manifests and `adapter.check()` where applicable.
- Check-service results should not require a real model run.
- Check-service results must be deterministic in tests through injected fake check providers, like current daemon tests inject `codexProbe`.

## Run Creation Compatibility

Existing request bodies remain valid:

```json
{
  "runtime": "codex",
  "provider": "openai",
  "model": "gpt-5.5",
  "adapterType": "process",
  "cwd": "/repo",
  "task": "Return one sentence."
}
```

R3 may add optional `runtimeMode` to run creation:

```json
{
  "runtime": "codex",
  "runtimeMode": "codex.exec_json",
  "provider": "openai",
  "model": "gpt-5.5",
  "adapterType": "process",
  "cwd": "/repo",
  "task": "Return one sentence."
}
```

Rules:

- If `runtimeMode` is absent, infer it for shipped modes:
  - `runtime: "fake"` -> `fake.deterministic`
  - `runtime: "codex"` plus `adapterType: "process"` -> `codex.exec_json`
- If `runtimeMode` is present, it must exist and match the supplied `runtime`, `provider`, and `adapterType`; mismatch returns `400 invalid_input`.
- `GET /runs` and `GET /runs/:id` may include optional `runtimeMode` on new records. Older persisted records may omit it or return null.
- R3 does not need to reject all run creation against unavailable modes before launch. The inspection API is the product capability. Existing launch-time failure semantics can remain, but tests must prove the registry/doctor API clearly reports unavailability.
- `POST /runs/:id/input` for Codex `exec-json` remains `409 adapter_protocol_failed`.

## Data Flow Shadow Paths

Every implementation task should cover these paths.

### Startup manifest seeding

Happy:

- Fake and Codex manifests are read.
- `provider_test`, `runtime_fake`, `provider_openai`, `runtime_codex`, `runtime_mode_fake_deterministic`, and `runtime_mode_codex_exec_json` exist.

Nil:

- Optional docs path or version is absent.
- Record still stores null and passes schema.

Empty:

- Codex model catalog returns an empty model array.
- `codex.exec_json` is not marked available.

Error:

- Codex probe throws.
- Daemon startup still succeeds, and `codex.exec_json` reports `unavailable` with a sanitized diagnostic.

### Runtime mode listing

Happy:

- `GET /runtime-modes?provider=openai&availability=available` returns `codex.exec_json` when checks pass.

Nil:

- `before` is absent.
- Endpoint uses first page defaults.

Empty:

- `GET /runtime-modes?runtime=missing-but-well-formed` returns `runtimeModes: []`.

Error:

- `GET /runtime-modes?availability=banana` returns `400 invalid_query`.

### Runtime mode lookup

Happy:

- Lookup works by id and by slug.

Nil:

- Optional `docsPath`, `version`, `reasonCode`, and `message` can be null/absent according to schema.

Empty:

- Capabilities array must not be empty for registered shipped modes.

Error:

- Unknown id or slug returns `404 runtime_mode_not_found`.

### Doctor check

Happy:

- `POST /runtime-modes/codex.exec_json/check` returns `available` when version and model catalog probes pass.

Nil:

- `version` is null for fake runtime and does not fail schema.

Empty:

- Empty diagnostics array is allowed for fake; empty Codex model catalog produces unavailable.

Error:

- Missing binary/model probe failure returns `200` with unavailable state; unexpected service bug returns `500 internal_error`.

### Run creation mode inference

Happy:

- Existing fake and Codex run requests still complete/fail as they did before, and new runs store the inferred mode.

Nil:

- Existing persisted runs with null `runtime_mode` still parse and list.

Empty:

- No runtime mode filter on `GET /runs` preserves current list behavior.

Error:

- Present but mismatched `runtimeMode` returns `400 invalid_input`.

## Test Requirements

Contracts:

- Add required-field negatives for runtime mode, availability, placement facts, limitations, and doctor check schemas.
- Parse happy records for `fake.deterministic` and `codex.exec_json`.
- Reject invalid runtime mode slugs and invalid availability states.
- Extend HTTP error code schema for `runtime_mode_not_found`.

Adapters:

- Fake adapter exposes a deterministic manifest.
- Codex adapter exposes a `codex.exec_json` manifest with the one-shot/no-input/local-only limitations.
- Codex check mapping covers:
  - version and model catalog success -> available/canRun true.
  - missing binary -> unavailable/canRun false.
  - model catalog failure -> unavailable/canRun false.
  - thrown probe -> sanitized unavailable, not uncaught throw.
- CI-safe tests must not call the real Codex CLI.

Core:

- Capability/doctor service converts manifests into stored records.
- Doctor service catches expected adapter check failures.
- Mode inference maps existing run requests to runtime mode slugs.
- Mismatched explicit runtime mode is rejected by the appropriate layer.

Storage:

- SQLite persists runtime mode records across reopen.
- Additive migration handles pre-R3 databases without the new table/columns.
- In-memory store list filtering matches SQLite behavior.
- Cursor pagination is stable by runtime mode id or slug, matching existing registry style.

REST:

- `GET /runtime-modes` supports filters, pagination, empty result, and invalid query handling.
- `GET /runtime-modes/:id` supports id and slug lookup.
- `POST /runtime-modes/:id/check` returns fresh checks and updates stored availability snapshot.
- `GET /doctor` returns latest stored summaries and counts.
- `runtime_mode_not_found` uses the unified error envelope.
- Existing registry route tests continue to pass after provider/runtime/model records remain backward-compatible.

Daemon:

- Startup with unavailable injected Codex probe still succeeds.
- Startup with available injected Codex probe marks `codex.exec_json` available and seeds models.
- Startup with model-probe failure marks `codex.exec_json` unavailable without crashing.
- Existing fake `POST /runs?wait=1` still completes.
- Existing Codex run creation path still uses the Codex adapter and keeps unsupported input as `409`.

Docs checked by release implementation:

- `PRODUCT.md`
- `CHANGELOG.md`
- `docs/development/API.md`
- `docs/development/DEVELOPMENT.md`
- `docs/development/adapters/CODEX.md`
- `docs/adapters/README.md`
- `ARCHITECTURE.md` if architecture wording changes

## Local Verification Commands

Focused checks:

```bash
git diff --check
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/storage test
pnpm --filter @switchyard/protocol-rest test
pnpm --filter @switchyard/adapters test
pnpm --filter @switchyard/daemon test
```

Full workspace checks before promotion:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm lint
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

Manual Codex availability check when local Codex is expected:

```bash
codex --version
codex debug models
curl -s -X POST "$BASE/runtime-modes/codex.exec_json/check" | python3 -m json.tool
```

Expected:

- `codex.exec_json.availability.state` is `available` only when both local probes pass.
- Missing Codex or failed model probing reports `unavailable` without daemon crash.
- `fake.deterministic` is always available in the local daemon.
- Existing fake run creation still completes.

## Promotion Criteria

R3 is done only when:

- `GET /runtime-modes` and `GET /doctor` let owners see what this instance can actually run.
- `codex.exec_json` is the only Codex runtime mode advertised as available.
- A failed Codex binary/model probe never crashes daemon startup or doctor checks.
- Fake runtime capabilities are deterministic and testable.
- Existing run creation still works for fake and Codex.
- Every adapter in the codebase declares capabilities through a manifest.
- No future mode is marked supported unless that exact mode is implemented.
- Product/API/development docs are updated during implementation closeout.

## Risks And Decisions

Decisions:

- Runtime mode is a first-class record, not a free-form label embedded only in runtime metadata.
- `codex.exec_json` model catalog failure is not available in R3, because clients cannot know which model slugs are runnable.
- Existing run creation remains backward-compatible and may infer runtime mode.
- Doctor checks are safe inspection only. They do not run model tasks.
- `GET /doctor` is read-only over stored snapshots; active checks use `POST /runtime-modes/:id/check`.

Risks:

- The current Codex probe treats version success plus model-catalog failure as `ok: true`; R3 must tighten that mapping at the capability layer without regressing existing parser tests.
- SQLite migrations are currently hand-rolled additive SQL; CTO should keep the migration small and verify reopen behavior against pre-R3 databases.
- Adding optional `runtimeMode` to run records can break exact-object tests if tests are not updated deliberately.
- Capability strings can grow messy if R3 over-generalizes. Keep the first list small and add only what fake and Codex need.
