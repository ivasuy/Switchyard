# Phase 21: R22 Hosted And Connected-Node Real Tool Execution - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-06-01-phase-21-r22-hosted-connected-real-tools.md`  
**Branch:** `agent/phase-21-r22-hosted-connected-real-tools`  
**Base/spec commit:** `89d86b2`  
**Complexity:** L

## Goal

Ship authenticated, tenant-scoped, approval-first hosted and connected-node real-tool execution for the exact R22 tool set, while preserving disabled-by-default policy, deterministic no-spend tests, and explicit denial guards for browser automation, hosted repo, arbitrary execution routes, generic process/PTY adapters, dashboard, TUI, Cursor, OpenClaw, Paperclip, hosted debate real participants, and model judging.

## Scope Challenge

1. Existing code already solves the local R17 tool contract, strict tool input schemas, redaction helper, approval lifecycle, local `ToolRouter`, real tool adapters, enterprise auth/control-plane primitives, hosted route auth, node assignment protocol, object artifact content store, worker queue/readiness, production manifest, preflight, and canary structure. R22 extends those surfaces instead of adding a parallel API, auth stack, object-store client, queue framework, or process abstraction.
2. The minimum shippable change is: additive contracts and stores, placement-aware tool policy, deferred hosted dispatch after exactly-once tool approval, hosted worker execution for `fetch`, `web_search`, `github`, command-catalog `shell`, connected-node assignments for `fetch`, `web_search`, `github`, `repo`, command-catalog `shell`, and ops/product truth. Browser automation and hosted repo are only denial/test-guard work in R22.
3. Complexity smell is real: the phase must touch more than eight files because contracts, storage, core services, REST routes, worker, node protocol, node app, adapters, scripts, deploy artifacts, and docs must agree. The plan controls blast radius with seven disjoint tasks, explicit dependencies, and one exported integration surface per layer. Broad tasks include reviewer pass/fail subtask matrices.
4. Built-in and existing dependencies are sufficient: Zod for schema validation, Fastify hooks for auth, existing `ControlPlaneService` for tenant/scopes/quota/audit, existing `ToolRouter` for invocation records and approval payload shape, existing BullMQ/memory queue package for worker jobs, existing node assignment sync routes, existing `redactSecrets`, Node `URL`, `crypto`, `path`, and `fs` utilities, existing adapters/testkit fakes, and existing OpenAPI generation scripts. No new runtime dependency is planned.
5. Distribution impact stays in existing packages and deploy artifacts. No new public package, dashboard, TUI, browser service, arbitrary exec route, generic process/PTY adapter, or hosted repo workspace artifact ships. New commands, if any, are wired through existing scripts only when deterministic/no-spend by default.

## Architecture

R22 layers hosted and connected-node tool execution around the R17 tool model. The local daemon keeps its existing `POST /tools/invocations` behavior. Hosted server routes use the same additive request schema, but the server never performs external network, search, GitHub, repo, or shell side effects in the request thread. It authenticates the API key, checks `tools:*` scope, authorizes the owned run, checks tool entitlements and quota-store availability, resolves placement-aware tool policy, persists a redacted invocation, creates a tool-scoped approval when required, attaches ownership, records audit, and dispatches only after approval resolves through a durable idempotent dispatch outbox keyed by `approvalId` and `toolInvocationId`.

The policy boundary is placement-aware and fail-closed. Hosted worker policy can allow `fetch`, `web_search`, `github`, `shell`, and `fake_echo`. Hosted `repo` always denies with `repo_hosted_unshipped`. Connected-node policy can allow `fetch`, `web_search`, `github`, `repo`, `shell`, and `fake_echo` only when both server policy and node policy permit the request. `browser` always denies with `browser_tool_unshipped`. Shell is command-catalog only; request-owned raw command, executable, env, PTY, terminal, process, or shell string fields deny before approval creation or adapter dispatch.

Execution is asynchronous outside the hosted server request. Hosted worker jobs contain only `toolInvocationId`, `runId`, placement, tool type, execution plan hash, and attempt metadata. The worker reloads durable state, verifies approval and plan hash, transitions the invocation with compare-and-set, executes using worker-owned config/fake clients by default, stores bounded artifacts through the existing object artifact content store, emits `tool.call` and exactly one `tool.result`, and terminalizes failures with named reason codes. Connected nodes receive `kind: "tool"` assignments with redacted invocation payloads, revalidate local policy, execute with node-owned config, sync events/artifacts through existing node routes, and complete only when assignment/run/node/tool ids match.

```
Hosted API
  -> API key auth + tools scope
  -> run ownership + target placement validation
  -> entitlement + quota availability preflight
  -> placement-aware tool policy
  -> denied invocation with no quota reservation OR queued invocation + tool approval with invocation/active quota reservation
  -> approve/reject/expire exactly once through dispatch outbox
  -> hosted worker job OR connected-node tool assignment from idempotent dispatch key
  -> tool.call + adapter execution + artifact storage
  -> artifact-byte quota after successful storage
  -> tool.result + audit + quota finalize/release
```

Side-effect ordering is strict:

```
auth -> ownership -> entitlement -> quota availability preflight -> policy
  -> denied invocation/audit with no quota reservation
  OR invocation row -> ownership rows -> approval row -> approval ownership
  -> invocation/hourly + active quota reservation -> audit -> response
  -> approval CAS -> policy/hash revalidation -> dispatch outbox upsert
  -> hosted enqueue OR connected-node assignment creation -> execution side effect
  -> artifact storage -> artifact-byte quota consume -> terminal result/audit/quota release
```

## File Structure

- `packages/contracts/src/tool.ts` - additive hosted tool target schema and response/list contracts.
- `packages/contracts/src/enterprise.ts` - tool scopes, entitlements, quotas, ownership types, audit event/resource types.
- `packages/contracts/src/assignment.ts` and `packages/contracts/src/node.ts` - additive tool assignment kind, tool payload, node tool capabilities, and node policy fields.
- `packages/contracts/src/http-error.ts`, `endpoint-inventory.ts`, `openapi.ts`, generated OpenAPI JSON, and contract tests - named R22 errors and local/hosted OpenAPI boundary.
- `packages/core/src/ports/*` and `packages/storage/src/postgres/*` - durable Postgres and memory-backed store support for hosted tool invocations, approvals, dispatch outbox records, ownership, quotas, and tool assignments.
- `packages/core/src/services/local-policy-gate.ts`, `tool-router.ts`, `approval-service.ts`, `node-coordinator-service.ts`, and a new hosted tool service file - placement-aware policy, redacted immutable execution plans, deferred dispatch, idempotent connected-node assignment creation, exactly-once approval outcomes, audit/quota hooks, and local backward compatibility.
- `packages/protocol-rest/src/hosted-tool-routes.ts`, `hosted-auth.ts`, and server app/config/readiness files - authenticated hosted tool and tool-scoped approval routes.
- `packages/queue/*`, `apps/worker/*`, and `packages/adapters/src/tools/*` - hosted worker tool job queue, fake/no-spend adapter construction, hosted execution, artifact storage, stale running reconciliation, and worker readiness.
- `packages/protocol-node/*`, `packages/core/src/services/local-node-policy-service.ts`, and `apps/node/*` - connected-node tool assignment claim/sync/complete and node-side tool executor.
- `scripts/production-preflight.ts`, `production-canary.ts`, `production-manifest.ts`, `deploy/production/*`, `PRODUCT.md`, `README.md`, and development docs - ops checks, deterministic no-spend canary, manifest defaults, and product truth.

## Existing Context

`docs/superpowers/specs/2026-06-01-phase-21-r22-hosted-connected-real-tools.md` defines the exact R22 tool set, non-goals, side-effect ordering, approval behavior, connected-node assignment shape, named reason codes, readiness/preflight/canary requirements, and required no-spend tests.

`packages/contracts/src/tool.ts` already defines the R17 public tool types and strict local input shapes:

```ts
export const toolTypeSchema = z.enum(["web_search", "fetch", "browser", "repo", "shell", "github", "fake_echo"]);
export const toolInvocationStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "denied"]);
export const shellToolInputSchema = z.object({
  commandId: nonEmptyTrimmedString.max(128),
  args: z.array(safeToolStringSchema).max(32).optional(),
  cwd: absolutePathLikeSchema
}).strict();
```

`packages/core/src/services/tool-router.ts` already persists queued tool approvals with a redacted execution plan and hash:

```ts
const executionPlanHash = hashExecutionPlan(decision.executionPlan);
const invocation: ToolInvocation = {
  id: invocationId,
  runId: input.runId,
  type: input.type as ToolInvocation["type"],
  status: "queued",
  approvalId,
  input: redactSecrets({
    request: normalizedInput,
    reasonCode: decision.reasonCode,
    policyTrace: decision.policyTrace,
    executionPlan: decision.executionPlan,
    executionPlanHash
  }),
```

`packages/core/src/services/local-policy-gate.ts` is the R17 default posture that must remain backward compatible while gaining placements:

```ts
global: {
  enabled: false,
  allowedPlacements: ["local"],
  approvalDefault: "required",
  approvalExpiresMs: 300_000,
  maxConcurrentRealTools: 2,
  maxInputBytes: 65_536,
  maxInlineOutputBytes: 32_768,
  maxArtifactBytes: 1_048_576,
  defaultTimeoutMs: 30_000
},
```

`packages/contracts/src/endpoint-inventory.ts` exposes local tool routes and hosted server routes separately. Hosted server currently reuses only selected local routes and does not include tools or approvals.

`packages/contracts/src/enterprise.ts` currently has no `tools:*` scopes, no tool entitlements, no tool quotas, and no `tool_invocation` or `approval` ownership type:

```ts
export const authScopeSchema = z.enum([
  "runs:write",
  "runs:read",
  "artifacts:read",
  "registry:read",
  "nodes:write",
  "metrics:read",
  "audit:read",
  "entitlements:read",
  "admin:read"
]);
```

`packages/contracts/src/assignment.ts` currently claims only run assignments:

```ts
export const assignmentClaimResponseSchema = z.object({
  assignment: assignmentSchema.nullable(),
  run: runSchema.nullable()
});
```

`packages/protocol-rest/src/hosted-auth.ts` centralizes hosted route scopes through Fastify `onRequest` hooks. R22 must add tool route scope rules here before body parsing.

`packages/protocol-node/src/node-routes.ts` already enforces node auth, ownership, assignment claim, event sync, artifact sync, and assignment completion for run assignments. R22 must extend this path additively for `kind: "tool"`.

`apps/server/src/readiness.ts`, `scripts/production-preflight.ts`, `scripts/production-canary.ts`, and `deploy/production/manifest.json` are the R19/R21 ops anchors. R22 extends these anchors with tools-disabled defaults and no-spend fake canary behavior.

## Task Graph

### Task P21-T1-contracts-openapi

```json
{
  "id": "P21-T1-contracts-openapi",
  "title": "Add hosted tool contracts and OpenAPI boundaries",
  "files": [
    "packages/contracts/src/tool.ts",
    "packages/contracts/src/enterprise.ts",
    "packages/contracts/src/assignment.ts",
    "packages/contracts/src/node.ts",
    "packages/contracts/src/http-error.ts",
    "packages/contracts/src/index.ts",
    "packages/contracts/src/endpoint-inventory.ts",
    "packages/contracts/src/openapi.ts",
    "packages/contracts/src/openapi.contract.test.ts",
    "packages/contracts/src/endpoint-inventory.drift.test.ts",
    "packages/contracts/src/http-error.contract.test.ts",
    "packages/contracts/openapi.local-daemon.json",
    "packages/contracts/openapi.hosted-server.json"
  ],
  "dependencies": [],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-21-r22-hosted-connected-real-tools.md",
    "packages/contracts/src/tool.ts",
    "packages/contracts/src/enterprise.ts",
    "packages/contracts/src/assignment.ts",
    "packages/contracts/src/node.ts",
    "packages/contracts/src/http-error.ts",
    "packages/contracts/src/endpoint-inventory.ts",
    "packages/contracts/src/openapi.ts"
  ],
  "instructions": "Extend contracts additively. Add a strict optional tool target object to every create tool invocation variant with placement hosted or connected_local_node and optional nodeId only for connected_local_node. Keep runId optional for local schema compatibility; hosted routes will require it. Add tools:write and tools:read scopes. Add billing entitlement fields allowHostedTools, allowConnectedNodeTools, allowedToolTypes, and allowToolArtifactContentRead with fail-closed schema defaults for hosted/staging bootstrap validation and explicit test fixtures. Add quota kinds tool_invocations_per_hour, active_tool_invocations, and tool_artifact_bytes_per_hour plus billing quota fields maxToolInvocationsPerHour, maxActiveToolInvocations, and maxToolArtifactBytesPerHour. Add resource ownership type tool_invocation and ensure approval is valid as a resource ownership type. Add audit event/resource types from the spec. Extend assignment schema with kind run|tool defaulting to run, optional toolInvocationId required when kind is tool, nullable claim response toolInvocation payload, and optional assignmentCompleteRequest.toolInvocation terminal patch. Extend NodePolicy with allowToolTypes, allowToolCwdPrefixes, toolArtifactSync, maxToolArtifactBytes, and toolApprovalRequired. Add named R22 error codes to the contracts HTTP error schema. Update hosted endpoint inventory with POST/GET /tools/invocations, GET /tools/invocations/:id, GET /approvals, GET /approvals/:id, POST /approvals/:id/approve, and POST /approvals/:id/reject. Do not add hosted POST /approvals. Keep local daemon inventory backward compatible. Regenerate OpenAPI and assert hosted routes use API key security while no forbidden public arbitrary execution, browser, dashboard, or TUI route appears.",
  "acceptance": [
    "CreateToolInvocationRequest accepts target.placement hosted and connected_local_node and rejects placement local on hosted-specific helper validation.",
    "Existing local daemon request bodies without target remain valid.",
    "authScopeSchema accepts tools:write and tools:read and rejects unknown tool scopes.",
    "Billing entitlements and quotas include the R22 tool fields and parse fixtures with explicit enabled and disabled values.",
    "quotaKindSchema accepts tool_invocations_per_hour, active_tool_invocations, and tool_artifact_bytes_per_hour.",
    "resourceOwnershipTypeSchema accepts tool_invocation and approval.",
    "auditEventTypeSchema and auditResourceTypeSchema accept every R22 tool audit type/resource from the spec.",
    "assignmentSchema remains compatible with existing run assignment fixtures and parses tool assignment fixtures with toolInvocationId.",
    "assignmentClaimResponseSchema includes nullable toolInvocation while existing run assignment clients can ignore it.",
    "Node policy schemas parse tool capability summaries without secrets or raw catalogs.",
    "Hosted OpenAPI includes only the R22 hosted tool and tool-scoped approval subset and excludes hosted POST /approvals.",
    "Hosted and local OpenAPI contain no public /exec, /shell, /process, /command, /pty, /terminal, /sandbox, /browser, /search, /github, /fetch, /repo, /dashboard, or /tui route.",
    "Operation ids do not include genericProcess, arbitraryProcess, terminal, pty, sandbox, dashboard, or tui."
  ],
  "checks": [
    "pnpm --filter @switchyard/contracts test -- openapi.contract.test.ts endpoint-inventory.drift.test.ts http-error.contract.test.ts",
    "pnpm --filter @switchyard/contracts openapi:check",
    "pnpm --filter @switchyard/contracts openapi:check:hosted",
    "pnpm --filter @switchyard/contracts typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "createToolInvocationRequestSchema.parse",
      "failure": "target is malformed, has placement local in hosted validation, has nodeId for hosted placement, or omits required tool input fields",
      "exception": "ZodError",
      "rescue": "Reject before route/service side effects and return invalid_input with field path details.",
      "user_sees": "400 invalid_input; no invocation, approval, quota reservation, queue job, assignment, or adapter dispatch."
    },
    {
      "codepath": "enterprise contract schemas",
      "failure": "bootstrap or entitlement fixture omits explicit tool fields in hosted/staging mode",
      "exception": "ZodError or production bootstrap validation failure",
      "rescue": "Fail closed so tools are not exposed with legacy implicit access.",
      "user_sees": "readiness/preflight code control_plane_bootstrap_malformed or entitlement_denied with tool entitlement reason."
    },
    {
      "codepath": "assignmentClaimResponseSchema.parse",
      "failure": "tool assignment omits toolInvocationId or toolInvocation payload shape is not redacted/bounded",
      "exception": "ZodError",
      "rescue": "Reject the response in contracts/tests before protocol-node can ship incompatible payloads.",
      "user_sees": "test failure before release; runtime returns invalid_input or assignment_not_found for malformed node exchanges."
    },
    {
      "codepath": "OpenAPI hosted inventory generation",
      "failure": "hosted POST /approvals or forbidden arbitrary execution/browser/dashboard/TUI route is added",
      "exception": "Vitest assertion failure",
      "rescue": "Remove the route from hosted inventory or mark it local-only before release.",
      "user_sees": "No public hosted route for generic approval creation or arbitrary execution appears in generated docs."
    }
  ],
  "observability": {
    "logs": [],
    "success_metric": "contracts.openapi.boundary.r22 passes for hosted and local surfaces",
    "failure_metric": "contracts.openapi.boundary.r22 fails on forbidden route, missing security, or schema drift"
  },
  "test_cases": [
    {
      "name": "hosted target parses",
      "lens": "happy",
      "given": "createToolInvocationRequestSchema receives { runId, type: 'fetch', target: { placement: 'hosted' }, input: valid fetch input }",
      "expect": "schema parses and preserves target.placement hosted"
    },
    {
      "name": "connected-node target parses with node id",
      "lens": "happy",
      "given": "createToolInvocationRequestSchema receives { runId, type: 'repo', target: { placement: 'connected_local_node', nodeId }, input: valid repo input }",
      "expect": "schema parses and preserves nodeId"
    },
    {
      "name": "local request remains compatible",
      "lens": "happy_shadow_nil",
      "given": "existing R17 local request with no target",
      "expect": "schema parses"
    },
    {
      "name": "malformed target fails",
      "lens": "error_path",
      "given": "target placement local, unknown placement, nodeId on hosted, or empty nodeId",
      "expect": "schema rejects with invalid target details"
    },
    {
      "name": "tool enterprise fields parse",
      "lens": "happy",
      "given": "billing plan fixture with allowHostedTools false, allowConnectedNodeTools false, allowedToolTypes [], allowToolArtifactContentRead false, and tool quotas",
      "expect": "billingPlanSchema parses"
    },
    {
      "name": "tool scopes parse",
      "lens": "happy",
      "given": "tools:read and tools:write",
      "expect": "authScopeSchema parses both"
    },
    {
      "name": "tool ownership and audit types parse",
      "lens": "happy",
      "given": "resourceOwnershipType tool_invocation and audit event tool.execution_completed",
      "expect": "enterprise schemas parse"
    },
    {
      "name": "run assignment backward compatibility",
      "lens": "happy_shadow_empty",
      "given": "existing assignment fixture without kind and without toolInvocation",
      "expect": "assignment parses as kind run or default-compatible shape"
    },
    {
      "name": "tool assignment requires tool invocation",
      "lens": "error_path",
      "given": "assignment kind tool without toolInvocationId",
      "expect": "assignmentSchema rejects"
    },
    {
      "name": "hosted OpenAPI tool subset",
      "lens": "integration",
      "given": "generated hosted-server OpenAPI",
      "expect": "contains R22 tool routes and tool-scoped approval routes, excludes POST /approvals"
    },
    {
      "name": "forbidden public routes absent",
      "lens": "integration",
      "given": "generated local and hosted OpenAPI",
      "expect": "forbidden arbitrary execution, browser, dashboard, and TUI routes are absent"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "ToolInvocationTarget",
        "kind": "type",
        "signature": "{ placement: 'hosted' | 'connected_local_node'; nodeId?: string }"
      },
      {
        "name": "CreateToolInvocationRequest",
        "kind": "type",
        "signature": "existing discriminated union by type plus optional target?: ToolInvocationTarget"
      },
      {
        "name": "Assignment",
        "kind": "type",
        "signature": "Assignment & { kind?: 'run' | 'tool'; toolInvocationId?: string }"
      },
      {
        "name": "AssignmentClaimResponse",
        "kind": "type",
        "signature": "{ assignment: Assignment | null; run: Run | null; toolInvocation: ToolInvocation | null }"
      },
      {
        "name": "EnterpriseToolControls",
        "kind": "schema",
        "signature": "auth scopes tools:read/tools:write, tool entitlements, tool quotas, tool ownership/audit resource types"
      }
    ],
    "imports_from_other_tasks": [],
    "file_paths_consumed_by_other_tasks": [
      "packages/contracts/src/tool.ts",
      "packages/contracts/src/enterprise.ts",
      "packages/contracts/src/assignment.ts",
      "packages/contracts/src/node.ts",
      "packages/contracts/src/http-error.ts",
      "packages/contracts/src/endpoint-inventory.ts"
    ]
  }
}
```

Reviewer pass/fail slices:

- Contracts: target schema, tool scopes, entitlements, quotas, audit, ownership, node policy, assignment payload.
- OpenAPI: hosted route subset, local backward compatibility, API key security, forbidden route and operation-id denial.
- Boundary: browser denied by contract coverage, hosted repo not exposed as a hosted success route, no per-tool public top-level routes.

### Task P21-T2-storage-control-plane

```json
{
  "id": "P21-T2-storage-control-plane",
  "title": "Add durable tool stores, dispatch outbox, ownership, quotas, and assignment storage",
  "files": [
    "packages/core/src/ports/tool-invocation-store.ts",
    "packages/core/src/ports/approval-store.ts",
    "packages/core/src/ports/control-plane-store.ts",
    "packages/core/src/ports/node-assignment-store.ts",
    "packages/core/src/ports/tool-dispatch-outbox-store.ts",
    "packages/storage/src/postgres/schema.ts",
    "packages/storage/src/postgres/database.ts",
    "packages/storage/src/postgres/tool-invocation-store.ts",
    "packages/storage/src/postgres/approval-store.ts",
    "packages/storage/src/postgres/assignment-store.ts",
    "packages/storage/src/postgres/tool-dispatch-outbox-store.ts",
    "packages/storage/src/postgres/control-plane-store.ts",
    "packages/storage/src/index.ts",
    "packages/storage/test/postgres-hosted-tool-store.test.ts",
    "packages/testkit/src/middleware-stores.ts",
    "packages/testkit/src/fake-stores.ts"
  ],
  "dependencies": [
    "P21-T1-contracts-openapi"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-21-r22-hosted-connected-real-tools.md",
    "packages/core/src/ports/tool-invocation-store.ts",
    "packages/core/src/ports/approval-store.ts",
    "packages/core/src/ports/control-plane-store.ts",
    "packages/storage/src/postgres/schema.ts",
    "packages/storage/src/postgres/control-plane-store.ts",
    "packages/storage/src/postgres/assignment-store.ts",
    "packages/testkit/src/middleware-stores.ts"
  ],
  "instructions": "Add Postgres-capable storage for hosted tool invocations and approvals following existing memory-fallback store patterns. Add table definitions for tool_invocations and approvals if absent, indexes for runId/status/approvalId/createdAt pagination, and schema compatibility coverage for pre-R22 additive migrations. Add a durable tool dispatch outbox table/store keyed uniquely by approvalId plus toolInvocationId, with target placement, executionPlanHash, dispatch status, attempt count, last error code, and created/updated timestamps. Extend assignment storage with kind and toolInvocationId while defaulting existing rows to kind run. Extend control-plane ports/store for tool quota availability checks, quota reservation/finalization helpers or generic quota kind support, resource ownership counts for tool_invocation and approval, and bootstrap validation that tool entitlements/quotas are explicit in staging/production. In memory/testkit stores, add list/get pagination filters needed by hosted routes, connected-node claims, and dispatch outbox retry. Ownership attach for tool_invocation and approval must happen before list/get can expose rows; where an implementation cannot make resource and ownership fully transactional, it must expose a helper for service-level cleanup/failure handling. The dispatch outbox must let core recover when approval CAS succeeds but queue enqueue or connected-node assignment creation times out: retry must find the existing outbox row by approvalId/toolInvocationId and continue without duplicate side effects.",
  "acceptance": [
    "PostgresToolInvocationStore supports create, get, update, updateIfStatus, list by runId/type/status/approvalId with stable cursor pagination, and listByApproval.",
    "PostgresApprovalStore supports create, get, update, updateIfStatus, list by runId/status/approvalType with stable cursor pagination, and tool-only filtering can be implemented without scanning unrelated tenants in service code.",
    "Postgres schema adds tool_invocations and approvals additively and preserves existing pre-R22 fixture compatibility.",
    "Postgres schema adds a durable dispatch outbox additively with a unique approvalId/toolInvocationId key and stable retry query ordering.",
    "Assignment storage persists kind and toolInvocationId and returns run assignment rows correctly when those fields are absent in older rows.",
    "Control-plane ownership supports tool_invocation and approval and countUnownedResources reports unowned tool invocations and approvals.",
    "Control-plane quota reservation accepts the three R22 quota kinds and keeps reserved/consumed/released/failed/expired state transitions unchanged.",
    "Bootstrap validation fails closed in staging/production when tool entitlement or quota fields are missing or legacy-empty.",
    "In-memory testkit stores match the Postgres behavior for list/get/updateIfStatus and pagination.",
    "In-memory and Postgres dispatch outbox stores support upsert, getByApprovalAndInvocation, markDispatching, markDispatched, markFailedRetryable, and listRetryable without duplicate rows.",
    "Storage tests prove cross-tenant list/get cannot leak existence when service code filters by owned ids first."
  ],
  "checks": [
    "pnpm --filter @switchyard/storage test -- postgres-hosted-tool-store.test.ts",
    "pnpm --filter @switchyard/storage typecheck",
    "pnpm --filter @switchyard/testkit typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "PostgresToolInvocationStore.create",
      "failure": "Postgres insert fails, schema missing, duplicate id, or invalid JSON payload",
      "exception": "pg error or ZodError",
      "rescue": "Propagate a typed storage failure to the service so the hosted route can return tool_store_unavailable before dispatch.",
      "user_sees": "503 tool_store_unavailable; no queue job, node assignment, or adapter side effect."
    },
    {
      "codepath": "PostgresApprovalStore.updateIfStatus",
      "failure": "duplicate approve/reject/expire races a pending approval transition",
      "exception": "no exception; zero updated rows",
      "rescue": "Return null so ApprovalService maps to approval_not_pending without duplicate dispatch.",
      "user_sees": "409 approval_not_pending and no second worker job or node assignment."
    },
    {
      "codepath": "ControlPlaneStore.attachOwnership",
      "failure": "ownership conflict or storage unavailable after invocation or approval row creation",
      "exception": "ControlPlaneStoreError ownership_conflict or ownership_attach_failed",
      "rescue": "Service marks the newly created invocation denied/failed where possible, releases quota, audits ownership_attach_failed, and returns a safe error.",
      "user_sees": "500 ownership_attach_failed or internal_error with reasonCode details; resource is not visible cross-tenant."
    },
    {
      "codepath": "AssignmentStore.claim",
      "failure": "tool assignment row is stale, expired, already claimed, or missing toolInvocationId",
      "exception": "no exception for conflict; validation error for malformed row",
      "rescue": "Return null for conflicts and let coordinator return assignment_claim_conflict or assignment_not_found.",
      "user_sees": "409 assignment_claim_conflict or 404 assignment_not_found."
    },
    {
      "codepath": "ToolDispatchOutboxStore.upsertByApprovalAndInvocation",
      "failure": "approval CAS already succeeded but enqueue/assignment creation timed out, then approval resolve is retried",
      "exception": "unique constraint conflict or retryable store error",
      "rescue": "Return the existing outbox row for the same approvalId/toolInvocationId and let core continue from the stored dispatch status instead of inserting a duplicate.",
      "user_sees": "No duplicate worker job or node assignment; approval resolve eventually returns the existing dispatch result or a retryable tool_dispatch_failed state."
    },
    {
      "codepath": "Bootstrap validation",
      "failure": "legacy billing plan omits tool entitlements or quotas in staging/production",
      "exception": "ControlPlaneStoreError control_plane_bootstrap_malformed",
      "rescue": "Fail closed during startup/readiness before hosted tools can be routed.",
      "user_sees": "readiness/preflight control_plane_bootstrap_malformed."
    }
  ],
  "observability": {
    "logs": [
      "storage.tool_invocation.create.failed reason=<low-cardinality>",
      "storage.approval.cas.miss status=<expected>",
      "storage.tool_dispatch_outbox.retry status=<status> reason=<low-cardinality>",
      "control_plane.ownership.attach_failed resourceType=<type>"
    ],
    "success_metric": "storage.hosted_tool_store.operations.status.pass",
    "failure_metric": "storage.hosted_tool_store.operations.status.fail.reason.<code>"
  },
  "test_cases": [
    {
      "name": "create and list tool invocation by approval",
      "lens": "happy",
      "given": "A created queued invocation with approvalId",
      "expect": "get, list, and listByApproval return the row with stable cursor"
    },
    {
      "name": "empty invocation list is safe",
      "lens": "happy_shadow_empty",
      "given": "No invocations for a filter",
      "expect": "list returns [] and nextCursor null"
    },
    {
      "name": "missing invocation returns undefined",
      "lens": "happy_shadow_nil",
      "given": "get('tool_missing')",
      "expect": "undefined without throwing"
    },
    {
      "name": "approval compare-and-set prevents duplicate resolution",
      "lens": "error_path",
      "given": "Two updateIfStatus calls for the same pending approval",
      "expect": "exactly one returns an approved/rejected record and the other returns null"
    },
    {
      "name": "pre-R22 assignment row defaults to run",
      "lens": "happy_shadow_nil",
      "given": "Assignment row with no kind and no toolInvocationId",
      "expect": "store returns kind run or default-compatible assignment shape"
    },
    {
      "name": "tool assignment stores toolInvocationId",
      "lens": "happy",
      "given": "Assignment kind tool with toolInvocationId",
      "expect": "create/get/claim preserve toolInvocationId"
    },
    {
      "name": "dispatch outbox is idempotent",
      "lens": "error_path",
      "given": "upsert dispatch outbox twice with the same approvalId and toolInvocationId after a simulated enqueue timeout",
      "expect": "one durable outbox row, attempt count advances, and retryable listing returns one item"
    },
    {
      "name": "quota kinds reserve and transition",
      "lens": "happy",
      "given": "tool_invocations_per_hour, active_tool_invocations, and tool_artifact_bytes_per_hour reservations",
      "expect": "reserveQuota and transitionQuotaReservation preserve existing state machine"
    },
    {
      "name": "tool ownership filters existence",
      "lens": "integration",
      "given": "Two tenants with tool_invocation ownership rows",
      "expect": "listOwnedResourceIds and service-facing filters expose only owned ids"
    },
    {
      "name": "legacy bootstrap fails closed in production",
      "lens": "error_path",
      "given": "Production bootstrap billing plan without explicit tool entitlements or quotas",
      "expect": "bootstrap fails with control_plane_bootstrap_malformed"
    },
    {
      "name": "storage unavailable maps before dispatch",
      "lens": "error_path",
      "given": "Tool store create throws",
      "expect": "service can map to tool_store_unavailable and dispatch count remains zero"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "PostgresToolInvocationStore",
        "kind": "class",
        "signature": "new PostgresToolInvocationStore(handle?: PostgresDatabaseHandle) implements ToolInvocationStore"
      },
      {
        "name": "PostgresApprovalStore",
        "kind": "class",
        "signature": "new PostgresApprovalStore(handle?: PostgresDatabaseHandle) implements ApprovalStore"
      },
      {
        "name": "ToolInvocationStore.updateIfStatus",
        "kind": "function",
        "signature": "updateIfStatus(id: string, expectedStatus: ToolInvocation['status'], value: ToolInvocation) => Promise<ToolInvocation | null>"
      },
      {
        "name": "NodeAssignmentStore tool fields",
        "kind": "interface",
        "signature": "Assignment rows preserve kind?: 'run' | 'tool' and toolInvocationId?: string"
      },
      {
        "name": "ControlPlaneStore tool ownership/quota support",
        "kind": "interface",
        "signature": "existing quota/ownership methods accept R22 tool quota kinds and resource types"
      },
      {
        "name": "ToolDispatchOutboxStore",
        "kind": "interface",
        "signature": "upsertByApprovalAndInvocation(input) / getByApprovalAndInvocation(approvalId, toolInvocationId) / markDispatching(id) / markDispatched(id, dispatchId) / markFailedRetryable(id, reasonCode) / listRetryable(limit) => Promise<ToolDispatchOutboxRecord[]>"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P21-T1-contracts-openapi",
        "name": "EnterpriseToolControls",
        "signature": "auth scopes tools:read/tools:write, tool entitlements, tool quotas, tool ownership/audit resource types"
      },
      {
        "from_task": "P21-T1-contracts-openapi",
        "name": "Assignment",
        "signature": "Assignment & { kind?: 'run' | 'tool'; toolInvocationId?: string }"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/storage/src/postgres/tool-invocation-store.ts",
      "packages/storage/src/postgres/approval-store.ts",
      "packages/storage/src/postgres/tool-dispatch-outbox-store.ts",
      "packages/core/src/ports/control-plane-store.ts",
      "packages/core/src/ports/node-assignment-store.ts",
      "packages/core/src/ports/tool-dispatch-outbox-store.ts",
      "packages/testkit/src/middleware-stores.ts"
    ]
  }
}
```

Reviewer pass/fail slices:

- Store behavior: create/get/list/update/CAS/pagination for invocation and approval stores.
- Migration: schema additive compatibility and pre-R22 assignment rows.
- Safety: ownership first, quota transitions, bootstrap fail-closed, no cross-tenant existence leak.

### Task P21-T3-core-tool-policy-approval-dispatch

```json
{
  "id": "P21-T3-core-tool-policy-approval-dispatch",
  "title": "Add placement-aware policy, idempotent dispatch, and connected-node assignment creation",
  "files": [
    "packages/core/src/services/local-policy-gate.ts",
    "packages/core/src/services/tool-router.ts",
    "packages/core/src/services/approval-service.ts",
    "packages/core/src/services/hosted-tool-service.ts",
    "packages/core/src/services/node-coordinator-service.ts",
    "packages/core/src/index.ts",
    "packages/core/test/hosted-tool-policy.test.ts",
    "packages/core/test/tool-approval-dispatch.test.ts",
    "packages/core/test/tool-router-local-compat.test.ts"
  ],
  "dependencies": [
    "P21-T1-contracts-openapi",
    "P21-T2-storage-control-plane"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-21-r22-hosted-connected-real-tools.md",
    "packages/core/src/services/local-policy-gate.ts",
    "packages/core/src/services/tool-router.ts",
    "packages/core/src/services/approval-service.ts",
    "packages/core/src/services/node-coordinator-service.ts",
    "packages/core/src/services/control-plane-service.ts",
    "packages/core/src/ports/policy.ts",
    "packages/testkit/src/middleware-stores.ts"
  ],
  "instructions": "Refactor the existing local policy gate into a placement-aware resolver without breaking the local daemon. Keep the current disabled default for global.enabled false and allowedPlacements local. Add hosted and connected_local_node placement config with disabled defaults, hosted repo denial, connected-node default deny, browser always denied, and shell raw-field rejection before execution plans are built. Extend ToolRouter or wrap it through a HostedToolService so local mode keeps synchronous behavior while hosted mode persists queued/denied invocations and approvals, then calls an injected dispatch callback only after a tool-scoped approval is approved and the executionPlanHash revalidates. Hosted invoke must require runId, validate target placement against run placement/offload metadata, perform entitlement and quota-store availability preflight before policy, but reserve hourly invocation and active tool quotas only after policy allows approval-required or dispatchable work. Policy-denied invocations must not reserve quota. Artifact-byte quota is not reserved here; it is consumed only by worker/node artifact storage after content is stored. Attach ownership for tool_invocation and approval before response, record audit, and return 202 for accepted queued work. Add a core dispatch outbox use path keyed by approvalId/toolInvocationId so approval CAS success followed by hosted enqueue or connected-node assignment timeout can be retried without duplicate side effects. Move connected-node assignment creation into this task by extending NodeCoordinatorService with createToolAssignment and idempotency-key support; T4 can depend on this export before it wires connected_local_node approval dispatch. Rejection and expiration must mark invocation denied and release active quota. Duplicate approval resolve must return approval_not_pending without duplicate dispatch. Runtime approvals must not be resolved through hosted tool paths.",
  "acceptance": [
    "Local daemon ToolRouter behavior remains backward compatible for existing R17 fake and real-tool tests.",
    "Disabled hosted tools deny with tool_hosted_tools_disabled or tool_policy_denied after successful auth/run ownership and persist a denied invocation when configured to do so.",
    "Disabled connected-node tools deny with tool_connected_node_tools_disabled or tool_policy_denied.",
    "Hosted repo denies with repo_hosted_unshipped before dispatch.",
    "Browser denies with browser_tool_unshipped before dispatch for hosted and connected-node placements.",
    "Shell input containing command, executable, executablePath, shell, pty, terminal, env, or process fields denies with shell_command_denied before approval creation.",
    "Hosted invocation without runId returns tool_run_required before any invocation, quota, approval, queue job, assignment, or adapter side effect.",
    "Target placement mismatch returns tool_target_mismatch before dispatch.",
    "Tool entitlements and quota-store availability are checked before policy; hourly invocation and active tool quotas are reserved only for policy-allowed approval-required or dispatchable work; policy-denied invocations reserve no quota.",
    "Approval approve transitions pending to approved exactly once, revalidates execution plan hash, upserts one dispatch outbox record keyed by approvalId/toolInvocationId, dispatches exactly one job or assignment, and consumes/releases quota correctly.",
    "Approval CAS success followed by enqueue success plus markDispatched timeout, enqueue timeout, or assignment creation timeout is recoverable by retrying from the durable dispatch outbox with the same idempotency key and without duplicate worker jobs or node assignments.",
    "NodeCoordinatorService.createToolAssignment exists before hosted server admission wiring and creates idempotent tool assignments linked to toolInvocationId.",
    "Approval reject and expire mark queued invocation denied with tool_approval_rejected or tool_approval_expired and dispatch nothing.",
    "Runtime approvals with runtimeApprovalToken return hosted_runtime_approval_bridge_unshipped or approval_scope_denied in hosted tool mode.",
    "Audit payloads and invocation/approval payloads are redacted and bounded."
  ],
  "checks": [
    "pnpm --filter @switchyard/core test -- hosted-tool-policy.test.ts tool-approval-dispatch.test.ts tool-router-local-compat.test.ts",
    "pnpm --filter @switchyard/core typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "HostedToolService.invoke",
      "failure": "missing runId on hosted route",
      "exception": "ServiceError code tool_run_required",
      "rescue": "Return before quota reservation, invocation create, approval create, audit allow, queue, assignment, or adapter dispatch.",
      "user_sees": "400 or 409 tool_run_required depending existing HTTP mapping."
    },
    {
      "codepath": "placement-aware policy resolver",
      "failure": "policy JSON/path missing, empty, malformed, unknown tool type, unknown placement, invalid bounds, hosted repo enabled, or browser enabled",
      "exception": "Error with reason tool_policy_config_invalid or explicit denial reason",
      "rescue": "Fail closed before execution plan creation and expose redacted policy trace.",
      "user_sees": "tool_policy_config_invalid, repo_hosted_unshipped, browser_tool_unshipped, or tool_policy_denied."
    },
    {
      "codepath": "ToolRouter approval resolution",
      "failure": "stored execution plan hash differs from re-resolved policy plan",
      "exception": "no exception; hash comparison mismatch",
      "rescue": "Mark invocation denied/failed with tool_policy_failed and do not call dispatch.",
      "user_sees": "Invocation terminal error tool_policy_failed."
    },
    {
      "codepath": "dispatch outbox after approval CAS",
      "failure": "approval CAS succeeds but hosted enqueue succeeds and markDispatched times out, hosted enqueue times out, or connected-node assignment creation times out before the route observes a dispatched outbox state",
      "exception": "ToolDispatchError retryable timeout or queue/assignment store timeout",
      "rescue": "Persist or reuse the approvalId/toolInvocationId outbox row, retry with the same idempotency key until markDispatched succeeds or a non-retryable failure is recorded, and ensure hosted queue enqueue plus connected-node assignment creation both dedupe by that key.",
      "user_sees": "At most one worker job or node assignment exists; retry either marks the existing dispatch id as dispatched or fails visibly with tool_dispatch_failed without duplicate side effects."
    },
    {
      "codepath": "NodeCoordinatorService.createToolAssignment",
      "failure": "no owned online node, node lacks capability, node policy denies target, duplicate dispatch key, or assignment store unavailable",
      "exception": "NodeCoordinatorError or store error",
      "rescue": "Return tool_node_unavailable, node_policy_denied, existing assignment for same idempotency key, or tool_dispatch_unavailable before node exposure.",
      "user_sees": "tool_node_unavailable, node_policy_denied, existing dispatch id, or tool_dispatch_unavailable."
    },
    {
      "codepath": "ApprovalService.resolve hosted tool mode",
      "failure": "duplicate approve/reject, expired approval, runtime approval token, or missing linked invocation",
      "exception": "ServiceError approval_not_pending, approval_scope_denied, hosted_runtime_approval_bridge_unshipped, or tool_invocation_not_found",
      "rescue": "Return named error and keep dispatch count at zero for non-pending/non-tool approvals.",
      "user_sees": "409 approval_not_pending, approval_scope_denied, hosted_runtime_approval_bridge_unshipped, or tool_invocation_not_found."
    },
    {
      "codepath": "quota reservation/finalization",
      "failure": "quota store unavailable, active tool quota exceeded, hourly invocation quota exceeded, or artifact byte quota exceeded",
      "exception": "ControlPlaneError quota_exceeded or quota_store_unavailable",
      "rescue": "Fail before dispatch for availability/active/hourly quota errors; reserve active/hourly only after policy allow; consume artifact bytes only after successful content storage; release or fail reservations on downstream errors.",
      "user_sees": "429 quota_exceeded or 503 quota_store_unavailable with reasonCode details."
    },
    {
      "codepath": "redaction before persistence",
      "failure": "secret-like URL query, token, env, stdout/stderr, or raw object key would be persisted",
      "exception": "test assertion failure or ServiceError tool_redaction_failed if redaction cannot produce safe payload",
      "rescue": "Redact using existing redactSecrets before any store/audit/event call; fail closed on redaction errors.",
      "user_sees": "Redacted details or tool_redaction_failed; no raw secret in persisted records."
    }
  ],
  "observability": {
    "logs": [
      "tool.invoke.admitted routeId=<route> placement=<placement> toolType=<type>",
      "tool.invoke.denied reason=<reasonCode> placement=<placement> toolType=<type>",
      "tool.dispatch.outbox.upserted status=<status> target=<target>",
      "tool.approval.resolved status=<approved|rejected|expired> placement=<placement>",
      "tool.execution.dispatched target=<hosted|connected_local_node> toolType=<type>"
    ],
    "success_metric": "tool.lifecycle.outcome.<queued|approved|dispatched|completed>.placement.<placement>.tool_type.<type>",
    "failure_metric": "tool.lifecycle.outcome.<denied|failed>.reason.<reasonCode>.placement.<placement>.tool_type.<type>"
  },
  "test_cases": [
    {
      "name": "local router remains compatible",
      "lens": "integration",
      "given": "Existing local ToolRouter fake_echo approval and allow paths",
      "expect": "status codes and persisted records match R17 behavior"
    },
    {
      "name": "missing hosted run id blocks side effects",
      "lens": "happy_shadow_nil",
      "given": "Hosted invoke with valid type/input and no runId",
      "expect": "tool_run_required and zero invocation, approval, quota, dispatch calls"
    },
    {
      "name": "empty input is rejected by schema or policy",
      "lens": "happy_shadow_empty",
      "given": "fetch with empty url, web_search with empty query, shell with empty commandId",
      "expect": "invalid_input or named policy denial and no dispatch"
    },
    {
      "name": "hosted disabled default denies",
      "lens": "happy",
      "given": "Owned hosted run and default disabled real-tool policy",
      "expect": "denied invocation with tool_hosted_tools_disabled or tool_policy_denied and no dispatch"
    },
    {
      "name": "connected-node disabled default denies",
      "lens": "happy",
      "given": "Owned connected-node run and default disabled connected-node tools",
      "expect": "denied invocation with tool_connected_node_tools_disabled or tool_policy_denied and no assignment"
    },
    {
      "name": "browser denied everywhere",
      "lens": "error_path",
      "given": "Hosted and connected-node browser requests",
      "expect": "browser_tool_unshipped before approval or dispatch"
    },
    {
      "name": "hosted repo denied",
      "lens": "error_path",
      "given": "Hosted target repo request with otherwise permissive policy",
      "expect": "repo_hosted_unshipped before dispatch"
    },
    {
      "name": "shell raw fields denied",
      "lens": "error_path",
      "given": "Shell input includes command, executable, executablePath, shell, pty, terminal, env, or process field",
      "expect": "shell_command_denied and no approval"
    },
    {
      "name": "approval approve dispatches once",
      "lens": "happy",
      "given": "Pending tool approval and two concurrent approve calls",
      "expect": "one approved result, one approval_not_pending, one dispatch call"
    },
    {
      "name": "approval CAS enqueue markDispatched timeout recovers",
      "lens": "error_path",
      "given": "Approval CAS succeeds, dispatch outbox row is written, hosted enqueue succeeds but markDispatched times out, then resolve is retried with the same idempotency key",
      "expect": "retry reuses the existing approvalId/toolInvocationId outbox row and queue idempotency key, returns the existing hosted queue job, and leaves exactly one queue job"
    },
    {
      "name": "approval CAS assignment creation timeout recovers",
      "lens": "error_path",
      "given": "Approval CAS succeeds, dispatch outbox row is written, connected-node assignment creation times out before markDispatched, then resolve is retried with the same idempotency key",
      "expect": "retry reuses the existing approvalId/toolInvocationId outbox row and creates at most one tool assignment"
    },
    {
      "name": "connected-node assignment creation is available to dispatch",
      "lens": "happy",
      "given": "Approved connected_local_node tool invocation with an owned online node advertising the required capability",
      "expect": "NodeCoordinatorService.createToolAssignment returns one kind tool assignment linked to toolInvocationId"
    },
    {
      "name": "connected-node no eligible node fails before assignment exposure",
      "lens": "happy_shadow_empty",
      "given": "Approved connected_local_node tool invocation with no owned online node advertising the required capability",
      "expect": "NodeCoordinatorService.createToolAssignment returns tool_node_unavailable and creates no assignment"
    },
    {
      "name": "approval reject prevents side effects",
      "lens": "happy",
      "given": "Pending tool approval rejected",
      "expect": "invocation denied with tool_approval_rejected and zero dispatch calls"
    },
    {
      "name": "approval expiration prevents side effects",
      "lens": "error_path",
      "given": "Pending tool approval past expiresAt",
      "expect": "invocation denied with tool_approval_expired and active quota released"
    },
    {
      "name": "execution plan hash mismatch blocks dispatch",
      "lens": "error_path",
      "given": "Stored approval hash and re-resolved policy hash differ",
      "expect": "tool_policy_failed and zero dispatch calls"
    },
    {
      "name": "runtime approval bridge remains unshipped",
      "lens": "error_path",
      "given": "Hosted approval payload contains runtimeApprovalToken but no toolInvocationId",
      "expect": "hosted_runtime_approval_bridge_unshipped or approval_scope_denied and no RuntimeRunnerService.sendInput"
    },
    {
      "name": "secrets are redacted before persistence",
      "lens": "integration",
      "given": "Request URL with token query, GitHub token-like field, env-like field, and secret stdout candidate",
      "expect": "invocation, approval, audit, log, and event payloads contain [REDACTED] or hashes only"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "resolveRealToolPolicyConfig",
        "kind": "function",
        "signature": "resolveRealToolPolicyConfig(input: { source?: string | object; placement?: 'local' | 'hosted' | 'connected_local_node' }) => ResolvedRealToolPolicyConfig"
      },
      {
        "name": "HostedToolService",
        "kind": "class",
        "signature": "new HostedToolService(deps).invoke(input) => Promise<{ statusCode: 202; invocation: ToolInvocation; approval?: Approval }>"
      },
      {
        "name": "HostedToolService.resolveApproval",
        "kind": "function",
        "signature": "resolveApproval(approvalId: string, decision: 'approved' | 'rejected', input?: ResolveApprovalInput) => Promise<{ approval: Approval; invocation: ToolInvocation | null }>"
      },
      {
        "name": "ToolDispatchCallback",
        "kind": "function",
        "signature": "(input: { invocation: ToolInvocation; approvalId: string; target: ToolInvocationTarget; executionPlanHash: string; idempotencyKey: string }) => Promise<{ dispatchId: string; target: 'hosted' | 'connected_local_node' }> where idempotencyKey is the stable dispatch outbox id or approvalId/toolInvocationId key"
      },
      {
        "name": "NodeCoordinatorService.createToolAssignment",
        "kind": "function",
        "signature": "createToolAssignment(input: { runId: string; toolInvocationId: string; nodeId?: string; requiredCapability: string; idempotencyKey: string }) => Promise<Assignment>"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P21-T1-contracts-openapi",
        "name": "CreateToolInvocationRequest",
        "signature": "existing discriminated union by type plus optional target?: ToolInvocationTarget"
      },
      {
        "from_task": "P21-T2-storage-control-plane",
        "name": "PostgresToolInvocationStore",
        "signature": "new PostgresToolInvocationStore(handle?: PostgresDatabaseHandle) implements ToolInvocationStore"
      },
      {
        "from_task": "P21-T2-storage-control-plane",
        "name": "ControlPlaneStore tool ownership/quota support",
        "signature": "existing quota/ownership methods accept R22 tool quota kinds and resource types"
      },
      {
        "from_task": "P21-T2-storage-control-plane",
        "name": "ToolDispatchOutboxStore",
        "signature": "upsertByApprovalAndInvocation(input) / getByApprovalAndInvocation(approvalId, toolInvocationId) / markDispatching(id) / markDispatched(id, dispatchId) / markFailedRetryable(id, reasonCode) / listRetryable(limit) => Promise<ToolDispatchOutboxRecord[]>"
      },
      {
        "from_task": "P21-T2-storage-control-plane",
        "name": "NodeAssignmentStore tool fields",
        "signature": "Assignment rows preserve kind?: 'run' | 'tool' and toolInvocationId?: string"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/services/hosted-tool-service.ts",
      "packages/core/src/services/tool-router.ts",
      "packages/core/src/services/node-coordinator-service.ts",
      "packages/core/src/services/local-policy-gate.ts",
      "packages/core/src/index.ts"
    ]
  }
}
```

Reviewer pass/fail slices:

- Policy: default deny, hosted allow, connected-node allow, hosted repo deny, browser deny, shell raw-field deny.
- Approval/dispatch: approve/reject/expire exactly once, runtime approval bridge denied, plan hash revalidation, dispatch outbox recovery, connected-node assignment creation export.
- Safety: side-effect ordering, quota availability/reservation/consume ordering, audit/redaction, local compatibility.

### Task P21-T4-hosted-server-admission

```json
{
  "id": "P21-T4-hosted-server-admission",
  "title": "Wire hosted server tool routes and control plane admission",
  "files": [
    "packages/protocol-rest/src/hosted-tool-routes.ts",
    "packages/protocol-rest/src/hosted-auth.ts",
    "packages/protocol-rest/src/index.ts",
    "packages/protocol-rest/test/hosted-tool-routes.test.ts",
    "apps/server/src/app.ts",
    "apps/server/src/config.ts",
    "apps/server/src/readiness.ts",
    "apps/server/test/hosted-tools.test.ts",
    "apps/server/test/production-config.test.ts",
    "apps/server/test/production-readiness.test.ts"
  ],
  "dependencies": [
    "P21-T1-contracts-openapi",
    "P21-T2-storage-control-plane",
    "P21-T3-core-tool-policy-approval-dispatch",
    "P21-T5-hosted-worker-tool-executor"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-21-r22-hosted-connected-real-tools.md",
    "packages/contracts/src/http-error.ts",
    "packages/protocol-rest/src/hosted-auth.ts",
    "packages/protocol-rest/src/middleware-routes.ts",
    "packages/core/src/ports/queue.ts",
    "apps/server/src/app.ts",
    "apps/server/src/config.ts",
    "apps/server/src/readiness.ts",
    "apps/server/test/hosted-server.test.ts"
  ],
  "instructions": "Add a hosted-only route module for the R22 tool subset instead of exposing the local middleware module wholesale. Register POST /tools/invocations, GET /tools/invocations, GET /tools/invocations/:id, GET /approvals, GET /approvals/:id, POST /approvals/:id/approve, and POST /approvals/:id/reject only when hosted control plane is available. Do not register hosted POST /approvals. Update hosted-auth route rules so tool write/read routes require tools:write/tools:read during onRequest before body parsing. Server app must construct Postgres tool/approval stores, HostedToolService, and a dispatch callback that enqueues a hosted worker tool job for hosted placement or calls the T3 NodeCoordinatorService.createToolAssignment export for connected_local_node placement. The dispatch callback must receive and forward the T3 approvalId/toolInvocationId idempotency key; it must not invent a separate node assignment API in this task. Admission must authorize run ownership before existence-sensitive list/get details, apply entitlements and quota-store availability preflight, then rely on T3 to reserve active/hourly quotas only for policy-allowed queued work, attach ownership rows before returning, and return 202 for queued/approval-required work. Approval list/get must be tool-only, ownership-first, paginated, and must deny or hide runtime approvals without leaking existence. Readiness/config must report checks.tools with redacted enabled flags, policy source kind, allowed placements/tool types, store availability, queue availability, ownership support, quota support, audit support, and route auth support. Default/local tests use fake/no-spend adapters and memory stores.",
  "acceptance": [
    "Hosted server registers the R22 tool routes and does not register hosted POST /approvals.",
    "tools:write is required for POST /tools/invocations and approve/reject of tool-scoped approvals.",
    "tools:read is required for listing/getting tool invocations and tool-scoped approvals.",
    "Approval list/get tests explicitly cover tools:read, ownership-first scoping, tool-only filtering, runtime approval denial, cursor pagination without existence leak, and cross-tenant approval ids.",
    "Auth failure, missing scope, invalid body, missing runId, run not found, tenant mismatch, entitlement denial, quota exhaustion, and target selection failure occur before dispatch.",
    "List/get tool invocation routes scope by ownership before returning not-found or resource details.",
    "List/get approval routes expose only tool-scoped approvals owned by the tenant and deny runtime approvals.",
    "POST /tools/invocations returns 202 for accepted queued/approval-required work and includes invocation plus approval when approval is required.",
    "Policy denial after auth/run ownership persists a denied invocation, attaches ownership, audits tool.invoke_denied, and returns safe toolInvocationId details.",
    "Approval approve calls the T3 core exactly-once dispatch path with the approvalId/toolInvocationId idempotency key and returns approval plus invocation without blocking for worker/node execution.",
    "For hosted placement, the approval dispatch callback forwards the exact T3 idempotencyKey into ToolJobPayload.idempotencyKey and ToolJobPayload.approvalId before calling enqueueTool, so route retry after markDispatched timeout observes one hosted queue job.",
    "Approval reject marks invocation denied and returns approval plus invocation.",
    "Readiness reports checks.tools and fails closed in staging/production when tools are enabled but auth, stores, queue, quota, audit, or policy are missing.",
    "Request/audit/log details are redacted and low-cardinality."
  ],
  "checks": [
    "pnpm --filter @switchyard/protocol-rest test -- hosted-tool-routes.test.ts",
    "pnpm --filter @switchyard/server test -- hosted-tools.test.ts production-config.test.ts production-readiness.test.ts",
    "pnpm --filter @switchyard/protocol-rest typecheck",
    "pnpm --filter @switchyard/server typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "registerHostedAuthHooks onRequest for tool routes",
      "failure": "missing API key, invalid key, query credential, auth store unavailable, or missing tools scope",
      "exception": "ControlPlaneError",
      "rescue": "Return auth/tenant/scope error before body parsing and audit route denial when possible.",
      "user_sees": "401 auth_required/auth_failed/auth_conflict, 403 tenant_access_denied, or 503 auth_store_unavailable."
    },
    {
      "codepath": "POST /tools/invocations hosted route",
      "failure": "invalid body, missing runId, target mismatch, entitlement denied, quota exceeded, policy denied, store unavailable, ownership attach failure, or queue/assignment dispatcher unavailable",
      "exception": "HttpProblem, ControlPlaneError, or ServiceError",
      "rescue": "Map to named HTTP error; release/fail quota reservations on downstream failures; do not dispatch unless approval is approved.",
      "user_sees": "invalid_input, tool_run_required, tool_target_mismatch, entitlement_denied, quota_exceeded, tool_policy_denied, tool_store_unavailable, ownership_attach_failed, or tool_dispatch_unavailable."
    },
    {
      "codepath": "GET /tools/invocations/:id and GET /approvals/:id",
      "failure": "resource exists for a different tenant",
      "exception": "no exception; authorization result denied",
      "rescue": "Authorize ownership first and return not_found or tenant_access_denied without leaking fields.",
      "user_sees": "404 tool_invocation_not_found/approval_not_found or 403 tenant_access_denied according to existing control-plane convention."
    },
    {
      "codepath": "GET /approvals and GET /approvals/:id hosted tool routes",
      "failure": "caller lacks tools:read, approval id belongs to another tenant, approval is runtime-scoped, cursor crosses tenant boundary, or filter would include non-tool approvals",
      "exception": "ControlPlaneError or ServiceError approval_scope_denied",
      "rescue": "Authenticate and check tools:read first, resolve owned approval ids before loading records, filter to toolInvocationId-bearing approvals only, and return not_found/scope_denied without resource payload.",
      "user_sees": "403 missing_scope, 404 approval_not_found, approval_scope_denied, or hosted_runtime_approval_bridge_unshipped with no cross-tenant or runtime approval details."
    },
    {
      "codepath": "POST /approvals/:id/approve hosted route",
      "failure": "approval is runtime-scoped, already resolved, expired, missing linked invocation, policy hash mismatch, dispatch create fails, or hosted enqueue succeeds but markDispatched times out before route completion",
      "exception": "ServiceError",
      "rescue": "Return named error; if dispatch fails or markDispatched times out after approval CAS, rely on T3 dispatch outbox retry and T5 queue idempotency, retry with the same idempotency key, and mark invocation failed with tool_dispatch_failed only for non-retryable dispatch failure.",
      "user_sees": "approval_scope_denied, hosted_runtime_approval_bridge_unshipped, approval_not_pending, tool_policy_failed, or tool_dispatch_failed."
    },
    {
      "codepath": "readiness checks.tools",
      "failure": "tools enabled but policy/auth/store/queue/quota/audit/ownership/route auth is unavailable",
      "exception": "no exception; readiness check false",
      "rescue": "Return 503 readiness with redacted diagnostic code before traffic should be routed.",
      "user_sees": "ready=false with tools check code such as tool_hosted_auth_required, tool_store_unavailable, tool_dispatch_unavailable, quota_store_unavailable, or audit_store_unavailable."
    }
  ],
  "observability": {
    "logs": [
      "hosted.tools.route.admit routeId=<route> toolType=<type> placement=<placement>",
      "hosted.tools.route.deny routeId=<route> reason=<reasonCode>",
      "hosted.tools.approval.resolve routeId=<route> decision=<approved|rejected>",
      "hosted.tools.dispatch.created target=<hosted|connected_local_node>"
    ],
    "success_metric": "hostedTools.route.outcome.accepted.route.<routeId>",
    "failure_metric": "hostedTools.route.outcome.denied.reason.<reasonCode>"
  },
  "test_cases": [
    {
      "name": "hosted tool route requires auth",
      "lens": "happy_shadow_nil",
      "given": "POST /tools/invocations without API key",
      "expect": "auth_required before body parsing"
    },
    {
      "name": "hosted tool route requires scope",
      "lens": "error_path",
      "given": "API key without tools:write invokes tool",
      "expect": "tenant_access_denied missing_scope and no side effects"
    },
    {
      "name": "approval list requires tools read",
      "lens": "error_path",
      "given": "API key with tools:write but without tools:read calls GET /approvals",
      "expect": "missing_scope and no approval records are loaded"
    },
    {
      "name": "missing run id rejected",
      "lens": "happy_shadow_nil",
      "given": "Hosted POST /tools/invocations with valid body except runId",
      "expect": "tool_run_required and zero dispatch"
    },
    {
      "name": "tenant mismatch does not leak invocation",
      "lens": "error_path",
      "given": "Tenant B gets Tenant A tool invocation id",
      "expect": "not found or tenant denied without invocation payload"
    },
    {
      "name": "approval list is ownership first and tool only",
      "lens": "integration",
      "given": "Tenant owns one tool approval, another tenant owns one tool approval, and same tenant has one runtime approval",
      "expect": "GET /approvals returns only the owned tool approval, not the cross-tenant approval or runtime approval"
    },
    {
      "name": "approval get cross tenant id does not leak",
      "lens": "error_path",
      "given": "Tenant B calls GET /approvals/:id with Tenant A tool approval id",
      "expect": "approval_not_found or tenant_access_denied without approval payload, status, run id, or tool invocation id"
    },
    {
      "name": "approval get runtime approval denied",
      "lens": "error_path",
      "given": "Tenant calls GET /approvals/:id for an owned runtime approval without toolInvocationId",
      "expect": "approval_scope_denied or hosted_runtime_approval_bridge_unshipped and no RuntimeRunnerService bridge"
    },
    {
      "name": "approval pagination has no existence leak",
      "lens": "integration",
      "given": "Cursor pagination over mixed tenant and mixed scope approvals",
      "expect": "page boundaries and nextCursor are computed over owned tool approvals only"
    },
    {
      "name": "entitlement denied before dispatch",
      "lens": "error_path",
      "given": "allowHostedTools false or allowedToolTypes missing fetch",
      "expect": "entitlement_denied and zero dispatch"
    },
    {
      "name": "quota exceeded before dispatch",
      "lens": "error_path",
      "given": "maxActiveToolInvocations reached",
      "expect": "quota_exceeded and zero dispatch"
    },
    {
      "name": "policy denied persists denied invocation",
      "lens": "happy",
      "given": "Owned run and hosted fetch denied by policy",
      "expect": "safe error details include toolInvocationId, invocation is denied, ownership exists, audit tool.invoke_denied exists"
    },
    {
      "name": "approval queued response",
      "lens": "happy",
      "given": "Owned run and hosted fetch allowed but approval required",
      "expect": "202 with invocation queued and approval pending"
    },
    {
      "name": "approve dispatches once",
      "lens": "integration",
      "given": "Pending tool approval and two approve route calls",
      "expect": "one dispatch record, one approval_not_pending response"
    },
    {
      "name": "approve retry after hosted enqueue markDispatched timeout dedupes queue job",
      "lens": "integration",
      "given": "Pending hosted tool approval where enqueueTool returns a job but the T3 dispatch outbox markDispatched call times out, followed by a retry using the same approvalId/toolInvocationId idempotency key",
      "expect": "retry returns or records the existing queue dispatch id; memory queue job count for that idempotency key remains exactly one"
    },
    {
      "name": "reject terminalizes invocation",
      "lens": "happy",
      "given": "Pending tool approval rejected",
      "expect": "approval rejected, invocation denied with tool_approval_rejected, no dispatch"
    },
    {
      "name": "runtime approval route denied",
      "lens": "error_path",
      "given": "Approval payload has runtimeApprovalToken and no toolInvocationId",
      "expect": "hosted_runtime_approval_bridge_unshipped or approval_scope_denied"
    },
    {
      "name": "hosted POST approvals absent",
      "lens": "integration",
      "given": "Hosted app routes",
      "expect": "POST /approvals returns not found or is not registered"
    },
    {
      "name": "readiness tools disabled is ready",
      "lens": "happy",
      "given": "Default tools disabled config",
      "expect": "checks.tools ok with hostedRealTools disabled and connectedNodeRealTools disabled"
    },
    {
      "name": "readiness tools enabled without store fails",
      "lens": "error_path",
      "given": "Tools enabled but no Postgres tool store",
      "expect": "ready 503 with tool_store_unavailable"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "registerHostedToolRoutes",
        "kind": "function",
        "signature": "registerHostedToolRoutes(app: FastifyInstance, deps: HostedToolRouteDependencies) => void"
      },
      {
        "name": "HostedToolRouteDependencies",
        "kind": "type",
        "signature": "{ hostedTools: HostedToolService; controlPlane: ControlPlaneService }"
      },
      {
        "name": "checks.tools readiness shape",
        "kind": "constant",
        "signature": "{ ok: boolean; code?: string; diagnostics: { hostedRealTools, connectedNodeRealTools, policySourceKind, allowedPlacements, enabledToolTypes, storeAvailable, queueAvailable, ownershipAvailable, quotaAvailable, auditAvailable, routeAuthAvailable } }"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P21-T1-contracts-openapi",
        "name": "CreateToolInvocationRequest",
        "signature": "existing discriminated union by type plus optional target?: ToolInvocationTarget"
      },
      {
        "from_task": "P21-T2-storage-control-plane",
        "name": "PostgresToolInvocationStore",
        "signature": "new PostgresToolInvocationStore(handle?: PostgresDatabaseHandle) implements ToolInvocationStore"
      },
      {
        "from_task": "P21-T3-core-tool-policy-approval-dispatch",
        "name": "HostedToolService",
        "signature": "new HostedToolService(deps).invoke(input) => Promise<{ statusCode: 202; invocation: ToolInvocation; approval?: Approval }>"
      },
      {
        "from_task": "P21-T3-core-tool-policy-approval-dispatch",
        "name": "ToolDispatchCallback",
        "signature": "(input: { invocation: ToolInvocation; approvalId: string; target: ToolInvocationTarget; executionPlanHash: string; idempotencyKey: string }) => Promise<{ dispatchId: string; target: 'hosted' | 'connected_local_node' }> where hosted placement passes idempotencyKey into ToolJobPayload.idempotencyKey"
      },
      {
        "from_task": "P21-T5-hosted-worker-tool-executor",
        "name": "ToolQueuePort",
        "signature": "enqueueTool(payload: ToolJobPayload, options?: { maxAttempts?: number }) => Promise<ToolJobPayload & { jobId: string }>; payload includes approvalId and idempotencyKey and enqueue dedupes by idempotencyKey"
      },
      {
        "from_task": "P21-T5-hosted-worker-tool-executor",
        "name": "ToolJobPayload",
        "signature": "{ approvalId: string; toolInvocationId: string; runId: string; placement: 'hosted'; toolType: ToolInvocation['type']; executionPlanHash: string; idempotencyKey: string; createdAt?: string }"
      },
      {
        "from_task": "P21-T3-core-tool-policy-approval-dispatch",
        "name": "NodeCoordinatorService.createToolAssignment",
        "signature": "createToolAssignment(input: { runId: string; toolInvocationId: string; nodeId?: string; requiredCapability: string; idempotencyKey: string }) => Promise<Assignment>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/protocol-rest/src/hosted-tool-routes.ts",
      "apps/server/src/readiness.ts"
    ]
  }
}
```

Reviewer pass/fail slices:

- Routes/auth: scope rules, route registration, POST `/approvals` absence.
- Admission: side-effect ordering, ownership, entitlements, quota availability/reservation ordering, policy, denied invocation persistence.
- Approval list/get: `tools:read`, ownership-first scoping, tool-only filtering, runtime approval denial, pagination/no existence leak, cross-tenant ids.
- Approval resolve: approve/reject/expire, runtime approval denial, dispatch outbox/idempotency key propagation, dispatch exactly once.
- Readiness: `checks.tools` disabled-ready and enabled-fail-closed states.

Subtask matrix:

| Slice | Files | Must pass |
| --- | --- | --- |
| Route registration and auth | `packages/protocol-rest/src/hosted-tool-routes.ts`, `packages/protocol-rest/src/hosted-auth.ts`, `packages/protocol-rest/test/hosted-tool-routes.test.ts` | R22 hosted routes present, hosted `POST /approvals` absent, `tools:write`/`tools:read` enforced before body parsing. |
| Admission and ownership | `packages/protocol-rest/src/hosted-tool-routes.ts`, `apps/server/test/hosted-tools.test.ts` | run ownership before existence-sensitive details, entitlement/quota availability preflight, policy-denied invocation persistence, no dispatch before approval. |
| Approval list/get | `packages/protocol-rest/test/hosted-tool-routes.test.ts`, `apps/server/test/hosted-tools.test.ts` | tool-only approval filters, cross-tenant id denial/no leak, runtime approval denial, cursor pagination over owned tool approvals only. |
| Approval resolve and dispatch | `apps/server/src/app.ts`, `apps/server/test/hosted-tools.test.ts` | dispatch callback forwards T3 idempotency key into hosted ToolJobPayload and connected-node assignment contracts; duplicate approval and post-enqueue markDispatched timeout retries do not duplicate side effects. |
| Readiness/config | `apps/server/src/config.ts`, `apps/server/src/readiness.ts`, server production tests | disabled tools ready, enabled tools fail closed on missing auth/store/queue/quota/audit/policy. |

### Task P21-T5-hosted-worker-tool-executor

```json
{
  "id": "P21-T5-hosted-worker-tool-executor",
  "title": "Execute hosted worker tool jobs and export placement-neutral tool adapters",
  "files": [
    "packages/core/src/ports/queue.ts",
    "packages/queue/src/index.ts",
    "packages/queue/src/memory-run-queue.ts",
    "packages/queue/src/bullmq-run-queue.ts",
    "packages/queue/test/run-queue.test.ts",
    "apps/worker/src/config.ts",
    "apps/worker/src/worker.ts",
    "apps/worker/src/ready.ts",
    "apps/worker/src/hosted-tool-adapters.ts",
    "apps/worker/test/hosted-tool-worker.test.ts",
    "apps/worker/test/production-config.test.ts",
    "apps/worker/test/production-worker-readiness.test.ts",
    "packages/adapters/src/tools/index.ts",
    "packages/adapters/src/tools/fetch-tool-adapter.ts",
    "packages/adapters/src/tools/web-search-tool-adapter.ts",
    "packages/adapters/src/tools/github-tool-adapter.ts",
    "packages/adapters/src/tools/shell-catalog-tool-adapter.ts",
    "packages/adapters/src/tools/local-process-tool-executor.ts",
    "packages/adapters/test/hosted-real-tool-adapters.test.ts",
    "packages/testkit/src/fake-echo-tool-adapter.ts"
  ],
  "dependencies": [
    "P21-T1-contracts-openapi",
    "P21-T2-storage-control-plane",
    "P21-T3-core-tool-policy-approval-dispatch"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-21-r22-hosted-connected-real-tools.md",
    "apps/worker/src/worker.ts",
    "apps/worker/src/config.ts",
    "packages/core/src/services/hosted-worker-service.ts",
    "packages/core/src/ports/queue.ts",
    "packages/adapters/src/tools/fetch-tool-adapter.ts",
    "packages/adapters/src/tools/shell-catalog-tool-adapter.ts"
  ],
  "instructions": "Extend the existing queue abstraction with tool jobs or a typed tool-job channel while preserving run job behavior. Tool queue payloads must carry approvalId and a required idempotencyKey supplied by T3/T4; use the dispatch outbox id when available, otherwise a stable approvalId/toolInvocationId key. Memory and BullMQ queues must dedupe enqueueTool by that key: if enqueue succeeds but the route/core times out before markDispatched, retrying enqueueTool with the same key returns the existing job id/payload and does not append, push, or create another queued job. Implement hosted worker tool execution that claims tool jobs, reloads invocation/run/approval from durable stores, verifies status queued, verifies approval approved unless an explicit test/local fake no-approval policy allows it, re-runs placement-aware policy with stored request, compares executionPlanHash, and compare-and-set transitions queued to running before adapter invocation. Construct hosted tool adapters from worker-owned config only. In packages/adapters/src/tools/index.ts, export a placement-neutral adapter factory contract with separate hosted and connected-node config shapes: buildHostedToolAdapters must accept HostedToolAdapterConfig, not the whole WorkerConfig, and buildNodeToolAdapters must accept NodeToolAdapterConfig that contains only node-owned credentials/config/cwd policy/command catalog. T6 may import buildNodeToolAdapters, but it must never pass WorkerConfig or hosted credentials to connected-node execution. Use fake/no-spend clients by default in tests and local smoke. Hosted fetch, web_search, github, shell, and fake_echo may execute when policy/config allow. Hosted repo must fail before adapter dispatch with repo_hosted_unshipped. Browser must fail with browser_tool_unshipped. Hosted shell must be command-catalog process execution only, no PTY, no terminal, no raw command strings, no request-owned executable/env. Store bounded artifacts through existing object artifact content store under runs/<runId>/tools/<toolInvocationId>/<safeName>. Consume tool_artifact_bytes_per_hour only after content is successfully stored and ownership is attached. Emit tool.call on start and exactly one terminal tool.result. Reconcile stale running hosted tool invocations on startup/retry exhaustion.",
  "acceptance": [
    "Existing run queue tests continue to pass and run job payload compatibility is preserved.",
    "ToolJobPayload includes approvalId and idempotencyKey, and enqueueTool rejects missing or empty idempotencyKey before storing a tool job.",
    "MemoryRunQueue and BullMqRunQueue dedupe tool enqueue by idempotencyKey so enqueue success followed by dispatch outbox markDispatched timeout and route retry leaves exactly one queue job.",
    "Worker claim readiness fails closed when tools are enabled but policy, stores, queue, object store, fake/real adapter config, or shell catalog is invalid.",
    "Hosted worker loads invocation and approval from durable stores and rejects missing or non-queued state before adapter dispatch.",
    "Hosted worker compares stored executionPlanHash with re-resolved policy hash before execution.",
    "Hosted fetch fake client covers success, timeout, private IP denial, redirect denial, and oversized response without live network.",
    "Hosted web_search fake client covers success, zero results, provider unavailable, and oversized output without live provider calls.",
    "Hosted GitHub fake client covers read-only success, repo denied, missing token, rate limit, and no mutations.",
    "Hosted shell command-catalog executor covers allowlisted fake command, unknown command, raw command denial, non-zero exit, timeout, output flood, and no PTY.",
    "Adapter exports include a placement-neutral factory plus buildHostedToolAdapters(HostedToolAdapterConfig) and buildNodeToolAdapters(NodeToolAdapterConfig), with tests proving node config cannot be WorkerConfig or hosted credentials.",
    "Hosted repo returns repo_hosted_unshipped and browser returns browser_tool_unshipped before adapter invocation.",
    "Artifacts are redacted, size-bounded, digest-recorded, owned before content is visible, stored through the existing object artifact content store, and charged to artifact-byte quota only after successful storage.",
    "Queue retry exhaustion terminalizes invocation failed with tool_dispatch_retry_exhausted.",
    "Worker restart reconciliation marks stale running hosted tool invocations failed with tool_worker_restarted unless a valid in-flight job is proven.",
    "Logs and metrics use low-cardinality labels only."
  ],
  "checks": [
    "pnpm --filter @switchyard/queue test -- run-queue.test.ts",
    "pnpm --filter @switchyard/queue test -- run-queue.test.ts -t \"tool enqueue dedupes after markDispatched timeout\"",
    "pnpm --filter @switchyard/adapters test -- hosted-real-tool-adapters.test.ts",
    "pnpm --filter @switchyard/worker test -- hosted-tool-worker.test.ts production-config.test.ts production-worker-readiness.test.ts",
    "pnpm --filter @switchyard/queue typecheck",
    "pnpm --filter @switchyard/adapters typecheck",
    "pnpm --filter @switchyard/worker typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "enqueueTool idempotency",
      "failure": "enqueue succeeds but dispatch outbox markDispatched times out, then hosted approval dispatch retries with the same approvalId/toolInvocationId idempotency key",
      "exception": "no exception for duplicate idempotency key; validation error for missing key",
      "rescue": "Return the existing tool job payload/jobId for duplicate idempotencyKey and do not append or push another job to the memory or BullMQ queue.",
      "user_sees": "One hosted worker job exists for the approval/invocation; retry can mark the existing dispatch id as dispatched without a duplicate tool side effect."
    },
    {
      "codepath": "worker tool job claim",
      "failure": "missing invocation, missing run, missing approval, non-queued invocation, unapproved approval, or CAS conflict",
      "exception": "no exception for CAS miss; ServiceError for missing state",
      "rescue": "Fail job or skip duplicate, terminalize invocation when safe, and do not call adapter.",
      "user_sees": "tool_invocation_not_found, hosted_run_state_invalid, approval_not_found, approval_not_pending, or tool_dispatch_failed."
    },
    {
      "codepath": "policy/hash revalidation",
      "failure": "policy now denies, execution plan hash changed, hosted repo requested, browser requested, or shell raw-field detected",
      "exception": "ServiceError or policy denial result",
      "rescue": "Mark invocation denied/failed with named reason and ack/fail job without adapter dispatch.",
      "user_sees": "tool_policy_denied, tool_policy_failed, repo_hosted_unshipped, browser_tool_unshipped, or shell_command_denied."
    },
    {
      "codepath": "fetch/web_search/github adapters",
      "failure": "timeout, private network, redirect denial, provider unavailable, missing token, repo denied, rate limit, decode error, or oversized output",
      "exception": "AdapterProtocolError or Error carrying reasonCode",
      "rescue": "Catch explicit adapter reason, redact payload, mark invocation failed, emit one tool.result.",
      "user_sees": "fetch_private_network_denied, fetch_redirect_denied, web_search_provider_unconfigured, github_token_missing, github_repo_not_allowlisted, github_rate_limited, or tool_output_limit_exceeded."
    },
    {
      "codepath": "hosted shell executor",
      "failure": "unknown commandId, disallowed cwd, spawn failure, non-zero exit, timeout, output flood, cancellation, request raw command/env/PTY/terminal field",
      "exception": "Tool process error with reasonCode",
      "rescue": "Kill process when needed, bound output, redact stdout/stderr, mark invocation failed or denied.",
      "user_sees": "shell_command_not_configured, repo_cwd_denied, tool_process_spawn_failed, tool_process_nonzero_exit, tool_process_timeout, tool_output_limit_exceeded, tool_process_cancelled, or shell_command_denied."
    },
    {
      "codepath": "artifact storage",
      "failure": "object store unavailable, write timeout, auth failed, bucket missing, digest mismatch, content too large, or redaction failure",
      "exception": "Error with object_store_* or artifact_* code",
      "rescue": "Mark invocation failed with tool_artifact_write_failed or specific object-store reason and do not report completed output. Consume artifact-byte quota only after the object-store write, digest verification, and ownership attach succeed.",
      "user_sees": "object_store_unavailable, object_store_timeout, object_store_auth_failed, object_store_bucket_not_found, artifact_digest_mismatch, tool_output_limit_exceeded, or tool_redaction_failed."
    },
    {
      "codepath": "queue retry exhaustion and restart reconciliation",
      "failure": "tool job retries exhausted or stale running invocation found",
      "exception": "queue recovery result",
      "rescue": "Terminalize invocation with tool_dispatch_retry_exhausted or tool_worker_restarted and emit tool.result once.",
      "user_sees": "failed tool invocation with visible named reason."
    }
  ],
  "observability": {
    "logs": [
      "hosted.worker.tool.claimed toolType=<type> attempt=<bucket>",
      "hosted.worker.tool.revalidated toolType=<type>",
      "hosted.worker.tool.failed reason=<reasonCode> toolType=<type>",
      "hosted.worker.tool.artifact.stored sizeBucket=<bucket>"
    ],
    "success_metric": "hostedWorker.tool.outcome.completed.tool_type.<type>",
    "failure_metric": "hostedWorker.tool.outcome.failed.reason.<reasonCode>.tool_type.<type>"
  },
  "test_cases": [
    {
      "name": "run queue compatibility",
      "lens": "integration",
      "given": "Existing run enqueue/claim/ack/fail/retry tests",
      "expect": "unchanged behavior"
    },
    {
      "name": "tool enqueue dedupes after markDispatched timeout",
      "lens": "integration",
      "given": "enqueueTool receives ToolJobPayload with approvalId approval_1, toolInvocationId tool_1, and idempotencyKey dispatch_approval_1_tool_1, then T3 markDispatched times out and enqueueTool is retried with the same payload/key",
      "expect": "memory queue and BullMQ-backed queue return the same job id or payload and expose exactly one queued/claimed job for that idempotencyKey"
    },
    {
      "name": "claim missing invocation fails",
      "lens": "happy_shadow_nil",
      "given": "Tool job references absent toolInvocationId",
      "expect": "job failed with tool_invocation_not_found and no adapter call"
    },
    {
      "name": "empty upstream result completes safely",
      "lens": "happy_shadow_empty",
      "given": "Fake search returns zero results or fetch returns empty body",
      "expect": "invocation completed with explicit empty metadata and no raw content artifact unless requested"
    },
    {
      "name": "policy hash mismatch blocks worker",
      "lens": "error_path",
      "given": "Stored hash differs after policy revalidation",
      "expect": "invocation denied/failed with tool_policy_failed and no adapter call"
    },
    {
      "name": "fake fetch success",
      "lens": "happy",
      "given": "Hosted fetch with fake client and allowlisted host",
      "expect": "tool.call, completed invocation, tool.result, optional artifact"
    },
    {
      "name": "fake fetch private network denied",
      "lens": "error_path",
      "given": "Fetch URL resolves to private IP or redirect target becomes private",
      "expect": "failed invocation with fetch_private_network_denied"
    },
    {
      "name": "fake web search provider unavailable",
      "lens": "error_path",
      "given": "No web search provider config",
      "expect": "web_search_provider_unconfigured"
    },
    {
      "name": "fake github missing token",
      "lens": "error_path",
      "given": "GitHub adapter has no worker-owned token",
      "expect": "github_token_missing and no token in logs"
    },
    {
      "name": "node adapter factory rejects hosted config",
      "lens": "error_path",
      "given": "buildNodeToolAdapters is called with a WorkerConfig-shaped object or hosted credential names",
      "expect": "typecheck or runtime config validation rejects it; node factory accepts only NodeToolAdapterConfig with node-owned cwd policy, command catalog, and credential references"
    },
    {
      "name": "hosted shell fake command succeeds",
      "lens": "happy",
      "given": "Command catalog entry for safe fake command and bounded args",
      "expect": "completed invocation and bounded output"
    },
    {
      "name": "hosted shell raw command denied",
      "lens": "error_path",
      "given": "Request input includes command or executablePath",
      "expect": "shell_command_denied before process spawn"
    },
    {
      "name": "hosted repo denied",
      "lens": "error_path",
      "given": "Hosted repo tool job",
      "expect": "repo_hosted_unshipped and adapter count zero"
    },
    {
      "name": "browser denied",
      "lens": "error_path",
      "given": "Hosted browser tool job",
      "expect": "browser_tool_unshipped and adapter count zero"
    },
    {
      "name": "artifact write failure fails invocation",
      "lens": "error_path",
      "given": "Adapter returns artifact candidate and object store write throws object_store_timeout",
      "expect": "failed invocation with object_store_timeout or tool_artifact_write_failed"
    },
    {
      "name": "stale running reconciliation",
      "lens": "error_path",
      "given": "Running hosted tool invocation at worker startup with no valid in-flight job",
      "expect": "failed with tool_worker_restarted and one tool.result"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "ToolQueuePort",
        "kind": "interface",
        "signature": "enqueueTool(payload: ToolJobPayload, options?: { maxAttempts?: number }) => Promise<ToolJobPayload & { jobId: string }> / claimTool() / ackTool(jobId) / failTool(jobId, error) / recoverStaleToolClaims(); enqueueTool dedupes by payload.idempotencyKey"
      },
      {
        "name": "ToolJobPayload",
        "kind": "type",
        "signature": "{ approvalId: string; toolInvocationId: string; runId: string; placement: 'hosted'; toolType: ToolInvocation['type']; executionPlanHash: string; idempotencyKey: string; createdAt?: string }"
      },
      {
        "name": "buildHostedToolAdapters",
        "kind": "function",
        "signature": "buildHostedToolAdapters(config: HostedToolAdapterConfig, deps?: HostedToolAdapterDeps) => Map<string, ToolAdapter>"
      },
      {
        "name": "buildNodeToolAdapters",
        "kind": "function",
        "signature": "buildNodeToolAdapters(config: NodeToolAdapterConfig, deps?: NodeToolAdapterDeps) => Map<string, ToolAdapter>"
      },
      {
        "name": "ToolAdapterFactoryConfig",
        "kind": "type",
        "signature": "HostedToolAdapterConfig and NodeToolAdapterConfig are placement-specific and exclude WorkerConfig/hosted credentials from node execution"
      },
      {
        "name": "HostedToolWorker execution behavior",
        "kind": "function",
        "signature": "createHostedWorker(config).tick() claims run jobs and tool jobs without changing public worker API"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P21-T2-storage-control-plane",
        "name": "PostgresToolInvocationStore",
        "signature": "new PostgresToolInvocationStore(handle?: PostgresDatabaseHandle) implements ToolInvocationStore"
      },
      {
        "from_task": "P21-T3-core-tool-policy-approval-dispatch",
        "name": "resolveRealToolPolicyConfig",
        "signature": "resolveRealToolPolicyConfig(input: { source?: string | object; placement?: 'local' | 'hosted' | 'connected_local_node' }) => ResolvedRealToolPolicyConfig"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/core/src/ports/queue.ts",
      "apps/worker/src/hosted-tool-adapters.ts",
      "packages/adapters/src/tools/index.ts"
    ]
  }
}
```

Reviewer pass/fail slices:

- Queue: run compatibility and tool job semantics.
- Worker state machine: claim, state reload, approval check, hash check, CAS, retry/restart.
- Tools: fetch, web_search, github, shell, fake_echo success/error, hosted repo denial, browser denial.
- Adapter factory: hosted config stays worker-owned; node factory is placement-neutral/node-owned and rejects WorkerConfig or hosted credentials.
- Artifacts/observability: bounded storage, redaction, low-cardinality logs/metrics.

Subtask matrix:

| Slice | Files | Must pass |
| --- | --- | --- |
| Queue compatibility | `packages/core/src/ports/queue.ts`, `packages/queue/src/*`, `packages/queue/test/run-queue.test.ts` | Existing run job semantics unchanged and tool job channel is typed/idempotent by ToolJobPayload.idempotencyKey for memory and BullMQ queues. |
| Hosted worker state machine | `apps/worker/src/worker.ts`, `apps/worker/test/hosted-tool-worker.test.ts` | reload state, approval check, hash check, queued-to-running CAS, retry exhaustion, stale-running reconciliation. |
| Adapter factory | `packages/adapters/src/tools/index.ts`, adapter tests | `buildHostedToolAdapters(HostedToolAdapterConfig)` and `buildNodeToolAdapters(NodeToolAdapterConfig)` expose separate config shapes; node factory has no `WorkerConfig` or hosted credential dependency. |
| Hosted tool adapters | tool adapter files and adapter tests | fake/no-spend fetch/search/GitHub/shell/fake_echo success and named failures, hosted repo/browser denial before dispatch. |
| Artifacts and quota | worker tests plus object-store fakes | content stored through existing object store, ownership attached before visibility, artifact-byte quota consumed only after successful storage. |
| Worker readiness/config | `apps/worker/src/config.ts`, `apps/worker/src/ready.ts`, production worker tests | enabled tools fail closed on missing policy/store/queue/object-store/adapter/shell catalog config. |

### Task P21-T6-connected-node-tool-assignments

```json
{
  "id": "P21-T6-connected-node-tool-assignments",
  "title": "Add connected-node tool assignment execution",
  "files": [
    "packages/core/src/services/local-node-policy-service.ts",
    "packages/protocol-node/src/node-client.ts",
    "packages/protocol-node/src/node-routes.ts",
    "packages/protocol-node/src/index.ts",
    "packages/protocol-node/test/node-routes.test.ts",
    "apps/node/src/config.ts",
    "apps/node/src/app.ts",
    "apps/node/test/node-app.test.ts",
    "apps/node/test/production-config.test.ts"
  ],
  "dependencies": [
    "P21-T1-contracts-openapi",
    "P21-T2-storage-control-plane",
    "P21-T3-core-tool-policy-approval-dispatch",
    "P21-T5-hosted-worker-tool-executor"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-21-r22-hosted-connected-real-tools.md",
    "packages/contracts/src/assignment.ts",
    "packages/core/src/services/node-coordinator-service.ts",
    "packages/core/src/services/local-node-policy-service.ts",
    "packages/protocol-node/src/node-routes.ts",
    "apps/node/src/app.ts",
    "apps/node/src/config.ts"
  ],
  "instructions": "Extend the connected-node path additively. Node registration/heartbeat may advertise tools.real, tool.fetch, tool.web_search, tool.github, tool.repo, and tool.shell plus redacted NodePolicy tool fields. T3 owns NodeCoordinatorService.createToolAssignment; this task must not reimplement assignment creation. Instead, extend claim, sync, completion, local-node policy, and node app execution for tool assignments created by that T3 service. Claim response includes nullable toolInvocation payload only for kind tool. Server-side node routes must authorize node, assignment, run, and tool invocation ownership before exposing payloads. Assignment completion accepts optional toolInvocation terminal patch for kind tool and rejects mismatched assignment id, run id, node id, or tool invocation id with tool_assignment_mismatch. Node app routes kind run to existing run execution and kind tool to a new node-side tool execution path using buildNodeToolAdapters(NodeToolAdapterConfig) from T5. NodeToolAdapterConfig must be built only from apps/node config, local node policy, node-owned credentials, node-owned cwd policy, and node-owned command catalog; it must not use WorkerConfig, hosted worker env, hosted credentials, server-sent credentials, or request-owned executable/cwd/env policy. Connected-node repo is local workspace read-only only; shell is command-catalog only; fetch/search/github use node-owned config; browser denies. Node syncs tool.call/tool.result events and artifacts through existing event/artifact routes. Node offline or assignment expiry terminalizes invocation with tool_assignment_expired or tool_node_unavailable.",
  "acceptance": [
    "Existing run assignment clients continue to claim and complete run assignments without toolInvocation payload requirements.",
    "Node registration/heartbeat accepts redacted tool capabilities and tool policy fields and rejects secret-like policy fields.",
    "Server selects only owned, online nodes advertising the required capability and satisfying server-side node policy.",
    "Tool assignment claim response includes assignment kind tool, run, and redacted toolInvocation payload with executionPlanHash.",
    "Node revalidates local policy before executing a tool and rejects with node_policy_denied on mismatch.",
    "Connected-node repo executes only read-only local Git inspection under allowed cwd prefixes and fixed argv.",
    "Connected-node shell executes only node-owned command catalog entries with bounded args and no raw command/env/PTY/terminal request fields.",
    "Connected-node fetch/search/github use node-owned config and deterministic fake clients in tests, never hosted worker config or hosted credentials.",
    "Node app constructs buildNodeToolAdapters(NodeToolAdapterConfig) from node-owned config/cwd policy/command catalog only, and tests reject WorkerConfig-shaped or hosted-credential inputs.",
    "Browser assignment denies with browser_tool_unshipped.",
    "Event sync accepts tool.call and tool.result with monotonic sequence and rejects gaps with event_sync_gap.",
    "Artifact sync preserves digest, size, metadata-only/full policy, and rejects digest mismatch or oversized content.",
    "Assignment complete updates durable invocation only when assignment/run/node/tool ids match.",
    "Node offline or assignment expiry terminalizes invocation with tool_assignment_expired or tool_node_unavailable.",
    "Server never sends GitHub/search tokens, shell env secrets, executable path secrets, or raw catalog contents in assignment payloads."
  ],
  "checks": [
    "pnpm --filter @switchyard/protocol-node test -- node-routes.test.ts",
    "pnpm --filter @switchyard/node test -- node-app.test.ts production-config.test.ts",
    "pnpm --filter @switchyard/protocol-node typecheck",
    "pnpm --filter @switchyard/node typecheck",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "POST /nodes/:id/assignments/claim",
      "failure": "node not owned, assignment not owned, run not owned, tool invocation not owned, claim conflict, or tool payload missing",
      "exception": "ControlPlaneError, NodeCoordinatorError, or ZodError",
      "rescue": "Rollback claim where possible and return named error without leaking payload.",
      "user_sees": "node_not_found, assignment_not_found, run_not_found, tool_invocation_not_found, assignment_claim_conflict, tenant_access_denied, or invalid_input."
    },
    {
      "codepath": "node-side tool executor",
      "failure": "local policy denies, adapter missing, WorkerConfig or hosted credentials are supplied, repo cwd denied, shell command denied, fake provider unavailable, browser requested, timeout, output flood",
      "exception": "Error carrying reasonCode",
      "rescue": "Reject invalid adapter config before execution, sync tool.result failed with named reason where assignment is already claimed, and complete assignment failed; no secret payloads are sent.",
      "user_sees": "node_policy_denied, tool_adapter_unavailable, repo_cwd_denied, shell_command_denied, web_search_provider_unconfigured, browser_tool_unshipped, tool_process_timeout, or tool_output_limit_exceeded."
    },
    {
      "codepath": "assignment event/artifact sync",
      "failure": "event cursor gap, duplicate/conflicting sequence, artifact digest mismatch, content too large, metadata-only policy, object-store failure",
      "exception": "EventSyncError, ArtifactSyncError, or payload size guard",
      "rescue": "Reject sync with named error and keep invocation non-terminal until completion or expiry.",
      "user_sees": "event_sync_gap, event_sync_conflict, artifact_digest_mismatch, payload_too_large, artifact_sync_failed, or object_store_unavailable."
    },
    {
      "codepath": "assignment complete for kind tool",
      "failure": "assignment id, run id, node id, or tool invocation id mismatch",
      "exception": "ServiceError tool_assignment_mismatch",
      "rescue": "Reject completion and leave invocation unchanged for retry/expiry.",
      "user_sees": "tool_assignment_mismatch."
    },
    {
      "codepath": "expireStale node/assignment",
      "failure": "node heartbeat expires or tool assignment expires before completion",
      "exception": "no exception; expiry sweep result",
      "rescue": "Mark node offline, fail assignment, terminalize invocation with tool_assignment_expired or tool_node_unavailable.",
      "user_sees": "failed tool invocation with visible expiry reason."
    }
  ],
  "observability": {
    "logs": [
      "node.tool.assignment.claimed toolType=<type>",
      "node.tool.execution.configured source=node-owned",
      "node.tool.execution.rejected reason=<reasonCode>",
      "node.tool.assignment.completed status=<status> reason=<reasonCode>"
    ],
    "success_metric": "connectedNode.tool.outcome.completed.tool_type.<type>",
    "failure_metric": "connectedNode.tool.outcome.failed.reason.<reasonCode>.tool_type.<type>"
  },
  "test_cases": [
    {
      "name": "run assignment backward compatibility",
      "lens": "integration",
      "given": "Existing node run assignment claim response without toolInvocation",
      "expect": "node app executes run path unchanged"
    },
    {
      "name": "node registers tool capabilities",
      "lens": "happy",
      "given": "Node register includes tools.real and tool.repo with tool policy fields",
      "expect": "server stores redacted capability/policy summary"
    },
    {
      "name": "secret-like node policy rejected or redacted",
      "lens": "error_path",
      "given": "Node policy includes token/env/raw catalog secret",
      "expect": "invalid_input or stored redacted payload with no secret"
    },
    {
      "name": "no eligible node",
      "lens": "happy_shadow_empty",
      "given": "Connected-node tool request and no online owned node with capability",
      "expect": "tool_node_unavailable and no hanging assignment"
    },
    {
      "name": "claim tool assignment payload",
      "lens": "happy",
      "given": "Owned online node claims pending tool assignment",
      "expect": "response has kind tool, run, and redacted toolInvocation payload"
    },
    {
      "name": "node policy denied",
      "lens": "error_path",
      "given": "Node advertises tool.repo but allowToolTypes excludes repo at claim time",
      "expect": "node_policy_denied and assignment rejected/failed"
    },
    {
      "name": "node adapter factory uses node-owned config",
      "lens": "error_path",
      "given": "Node app tries to build adapters from WorkerConfig, hosted credential names, or server-sent token fields",
      "expect": "config validation rejects before execution; buildNodeToolAdapters receives only NodeToolAdapterConfig"
    },
    {
      "name": "connected repo happy path",
      "lens": "happy",
      "given": "Repo diff request under allowed cwd with fake process factory",
      "expect": "tool.call and tool.result sync, invocation completed"
    },
    {
      "name": "connected shell raw command denied",
      "lens": "error_path",
      "given": "Shell payload includes raw command field",
      "expect": "shell_command_denied and no process spawn"
    },
    {
      "name": "connected browser denied",
      "lens": "error_path",
      "given": "Browser tool assignment",
      "expect": "browser_tool_unshipped"
    },
    {
      "name": "event sync gap",
      "lens": "error_path",
      "given": "Node syncs tool.result with skipped sequence",
      "expect": "event_sync_gap"
    },
    {
      "name": "artifact digest mismatch",
      "lens": "error_path",
      "given": "Node manifest digest differs from uploaded content",
      "expect": "artifact_digest_mismatch"
    },
    {
      "name": "completion id mismatch",
      "lens": "error_path",
      "given": "Tool completion patch references different invocation id",
      "expect": "tool_assignment_mismatch and invocation unchanged"
    },
    {
      "name": "assignment expiry terminalizes invocation",
      "lens": "error_path",
      "given": "Tool assignment expires before node completes",
      "expect": "invocation failed with tool_assignment_expired"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "NodeClient.claim",
        "kind": "function",
        "signature": "claim(nodeId: string, input?: AssignmentClaimRequest) => Promise<AssignmentClaimResponse>"
      },
      {
        "name": "Node tool execution path",
        "kind": "function",
        "signature": "executeToolAssignment(input: { assignment: Assignment; run: Run; toolInvocation: ToolInvocation }) => Promise<NodeExecutionResult>"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P21-T1-contracts-openapi",
        "name": "AssignmentClaimResponse",
        "signature": "{ assignment: Assignment | null; run: Run | null; toolInvocation: ToolInvocation | null }"
      },
      {
        "from_task": "P21-T2-storage-control-plane",
        "name": "NodeAssignmentStore tool fields",
        "signature": "Assignment rows preserve kind?: 'run' | 'tool' and toolInvocationId?: string"
      },
      {
        "from_task": "P21-T3-core-tool-policy-approval-dispatch",
        "name": "NodeCoordinatorService.createToolAssignment",
        "signature": "createToolAssignment(input: { runId: string; toolInvocationId: string; nodeId?: string; requiredCapability: string; idempotencyKey: string }) => Promise<Assignment>"
      },
      {
        "from_task": "P21-T5-hosted-worker-tool-executor",
        "name": "buildNodeToolAdapters",
        "signature": "buildNodeToolAdapters(config: NodeToolAdapterConfig, deps?: NodeToolAdapterDeps) => Map<string, ToolAdapter>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "packages/protocol-node/src/node-client.ts",
      "apps/node/src/app.ts"
    ]
  }
}
```

Reviewer pass/fail slices:

- Protocol: additive claim/complete contracts and backward-compatible run assignment clients.
- Node protocol/policy: T3-created tool assignments claim correctly, advertised capabilities are redacted, local policy revalidates before execution.
- Execution: repo, shell, fetch/search/github fake paths, browser denial, no secret transfer, node adapter factory uses node-owned config only.
- Sync: events, artifacts, completion mismatch, expiry/offline terminalization.

Subtask matrix:

| Slice | Files | Must pass |
| --- | --- | --- |
| Protocol claim/complete | `packages/protocol-node/src/node-routes.ts`, `packages/protocol-node/src/node-client.ts`, protocol-node tests | Existing run assignment clients still work; tool assignments include bounded `toolInvocation`; completion id mismatches fail with `tool_assignment_mismatch`. |
| Node capability and policy | `packages/core/src/services/local-node-policy-service.ts`, protocol-node tests | capabilities/policy are redacted, secret-like fields rejected, local policy denies mismatched tools/cwd. |
| Node adapter construction | `apps/node/src/config.ts`, `apps/node/src/app.ts`, node tests | node builds `NodeToolAdapterConfig` from node-owned config only; WorkerConfig, hosted credentials, and server-sent secrets are rejected. |
| Node tool execution | `apps/node/src/app.ts`, node tests | repo/shell/fetch/search/GitHub fake paths work with node-owned config; browser denied; raw shell fields never spawn. |
| Sync and terminalization | protocol-node routes and node tests | tool.call/tool.result sequences, artifact digest/size policy, completion mismatch, offline/expiry terminal states. |

### Task P21-T7-ops-canary-docs-product-truth

```json
{
  "id": "P21-T7-ops-canary-docs-product-truth",
  "title": "Add ops gates, canary, manifest, and product truth",
  "files": [
    "scripts/production-preflight.ts",
    "scripts/production-preflight.test.ts",
    "scripts/production-canary.ts",
    "scripts/production-canary.test.ts",
    "scripts/production-manifest.ts",
    "deploy/production/manifest.json",
    "deploy/production/production-manifest.test.ts",
    "deploy/production/.env.example",
    "deploy/production/bootstrap.example.json",
    "deploy/production/README.md",
    "package.json",
    "PRODUCT.md",
    "README.md",
    "docs/development/API.md",
    "docs/development/DEVELOPMENT.md"
  ],
  "dependencies": [
    "P21-T1-contracts-openapi",
    "P21-T2-storage-control-plane",
    "P21-T3-core-tool-policy-approval-dispatch",
    "P21-T4-hosted-server-admission",
    "P21-T5-hosted-worker-tool-executor",
    "P21-T6-connected-node-tool-assignments"
  ],
  "context_files": [
    "docs/superpowers/specs/2026-06-01-phase-21-r22-hosted-connected-real-tools.md",
    "scripts/production-preflight.ts",
    "scripts/production-canary.ts",
    "scripts/production-manifest.ts",
    "deploy/production/manifest.json",
    "PRODUCT.md",
    "README.md",
    "docs/development/API.md"
  ],
  "instructions": "Extend production ops and documentation for the exact R22 boundary. Production manifest defaults must keep hostedRealTools and connectedNodeRealTools disabled, require explicit policy when enabled, keep approvalDefault required, and use fake adapter mode for smoke/canary by default. Preflight must fail closed if tools are enabled without explicit policy, API-key auth, Postgres, Redis, object store, control-plane bootstrap tool entitlements, quota support, audit support, route auth, worker claim readiness, or node readiness when connected-node tools are enabled. Validate policy JSON/path max 65536 bytes, unknown tool types, unknown placements, empty allowlists, invalid bounds, hosted repo denial, browser denial, shell catalog fields, fake/no-spend adapter mode, and node adapter config separation so connected-node checks cannot source WorkerConfig or hosted credentials. Canary must be deterministic/no-spend by default and cover hosted fetch, hosted github, hosted shell deny/allowlisted fake command, connected-node repo, connected-node unavailable denial, approval reject/expire, and artifact write. Any live external tool canary must require explicit env confirmation and must not run in CI/audit default. Update PRODUCT.md and docs to say R22 ships hosted worker tools for fetch/web_search/github/command-catalog shell and connected-node tools for fetch/web_search/github/repo/command-catalog shell, while browser automation, hosted repo, dashboard/TUI, arbitrary execution routes, generic process/PTY adapters, Cursor/OpenClaw/Paperclip, hosted debate real participants, model judging, and hosted runtime approval/input/terminal bridges remain unshipped.",
  "acceptance": [
    "Production manifest validates with tools disabled by default and forbidden surfaces unchanged.",
    "production:preflight passes disabled-tools default when existing production prerequisites are satisfied or returns existing prerequisite failures without attempting live tools.",
    "production:preflight fails closed with named tool diagnostics when tools are enabled but policy/auth/stores/queue/object store/bootstrap quota/audit/worker/node requirements are missing.",
    "Preflight validates policy source size, malformed JSON, unknown placement/tool type, empty allowlists, invalid bounds, hosted repo denial, browser denial, shell catalog safety, fake/no-spend adapter mode, and connected-node adapter config separation from WorkerConfig/hosted credentials.",
    "Default production canary performs no live external network/API/provider calls beyond the configured Switchyard server.",
    "Default production canary covers hosted fetch fake path, hosted github fake/missing token path, hosted shell denial and allowlisted fake command, connected-node repo fake path, connected-node unavailable denial, approval reject/expire, and artifact write.",
    "Live external tool canary mode, if exposed, requires explicit confirmation env/flag and is absent from default CI/audit checks.",
    "PRODUCT.md updates shipped truth for R22 exact placements and tool set.",
    "PRODUCT.md and docs explicitly keep browser automation, hosted repo, arbitrary execution routes, generic process/PTY adapters, dashboard, TUI, Cursor, OpenClaw, Paperclip, hosted debate real participants, model judging, and hosted runtime approval/input/terminal bridges unshipped.",
    "Docs state tests, smoke, preflight, and default canary are deterministic/no-spend by default."
  ],
  "checks": [
    "pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts deploy/production/production-manifest.test.ts",
    "pnpm typecheck",
    "pnpm test",
    "pnpm build",
    "git diff --check"
  ],
  "error_rescue_map": [
    {
      "codepath": "runProductionPreflight",
      "failure": "tools enabled with missing policy, auth, stores, queue, object store, bootstrap entitlements, quota, audit, route auth, worker readiness, node readiness, malformed policy, or unsafe shell catalog",
      "exception": "ConfigError or validation result",
      "rescue": "Return fail check with named tool code and redacted diagnostics; do not attempt live tool side effects.",
      "user_sees": "production:preflight fails with codes such as tool_policy_config_invalid, tool_hosted_auth_required, tool_store_unavailable, tool_dispatch_unavailable, quota_store_unavailable, audit_store_unavailable, repo_hosted_unshipped, browser_tool_unshipped, or shell_command_denied."
    },
    {
      "codepath": "validateProductionManifest",
      "failure": "manifest adds forbidden service/surface or claims tools enabled by default",
      "exception": "manifest validation error",
      "rescue": "Fail manifest validation until defaults and forbidden surface list are corrected.",
      "user_sees": "manifest_forbidden_surface, manifest_forbidden_command, or manifest_invalid."
    },
    {
      "codepath": "runProductionCanary default mode",
      "failure": "server auth invalid, ready false, hosted fake tool denied unexpectedly, approval reject/expire mismatch, connected node unavailable assertion mismatch, artifact write/read mismatch, malformed response",
      "exception": "fetch/parse/assertion error captured as step failure",
      "rescue": "Return structured canary failure with step name, code, status, and redacted details.",
      "user_sees": "canary result code auth_required, ready_denied, tool_canary_denied, approval_canary_failed, artifact_digest_mismatch, malformed_response, or related R22 named code."
    },
    {
      "codepath": "live external tool canary gate",
      "failure": "operator requests live external tool canary without explicit confirmation",
      "exception": "no exception; input validation failure",
      "rescue": "Abort before external call and require explicit confirmation env/flag.",
      "user_sees": "tool_live_canary_config_missing or provider_canary_config_missing."
    },
    {
      "codepath": "product truth update",
      "failure": "docs overclaim browser automation, hosted repo, arbitrary exec, generic process/PTY, dashboard/TUI, Cursor/OpenClaw/Paperclip, hosted debate real participants, model judging, or hosted runtime bridges",
      "exception": "doc/product truth test assertion failure",
      "rescue": "Correct wording before release.",
      "user_sees": "Product docs accurately reflect R22 boundary."
    }
  ],
  "observability": {
    "logs": [
      "production.preflight.tools.check name=<check> status=<pass|fail|skip> code=<code>",
      "production.canary.tools.step name=<step> status=<pass|fail|info> code=<code>",
      "production.manifest.tools.validation status=<pass|fail>"
    ],
    "success_metric": "ops.r22_tools.checks.status.pass",
    "failure_metric": "ops.r22_tools.checks.status.fail.code.<code>"
  },
  "test_cases": [
    {
      "name": "manifest default tools disabled",
      "lens": "happy",
      "given": "deploy/production/manifest.json",
      "expect": "tools.hostedRealTools disabled, connectedNodeRealTools disabled, policy required_when_enabled, approvalDefault required, adapterMode fake_for_smoke"
    },
    {
      "name": "manifest forbidden surfaces remain absent",
      "lens": "integration",
      "given": "production manifest services and forbiddenSurfaces",
      "expect": "no dashboard, tui, exec, shell, process, command, pty, terminal, sandbox, browser, search, github, fetch, repo public service/surface"
    },
    {
      "name": "preflight disabled tools no live call",
      "lens": "happy",
      "given": "Production env with tools disabled and fake dependency probes",
      "expect": "preflight passes or fails only existing prerequisite mocks and records no live tool calls"
    },
    {
      "name": "preflight enabled missing policy fails",
      "lens": "happy_shadow_nil",
      "given": "SWITCHYARD_HOSTED_REAL_TOOLS=enabled without policy JSON/path",
      "expect": "tool_policy_config_invalid or policy required code"
    },
    {
      "name": "preflight empty allowlist fails",
      "lens": "happy_shadow_empty",
      "given": "Policy with hosted enabled and allowedToolTypes []",
      "expect": "fail-closed config code for empty allowlist"
    },
    {
      "name": "preflight hosted repo denial",
      "lens": "error_path",
      "given": "Policy attempts hosted repo enabled",
      "expect": "repo_hosted_unshipped"
    },
    {
      "name": "preflight browser denial",
      "lens": "error_path",
      "given": "Policy attempts browser enabled",
      "expect": "browser_tool_unshipped"
    },
    {
      "name": "preflight unsafe shell catalog fails",
      "lens": "error_path",
      "given": "Shell catalog has raw shell string, relative executable, env secret, or PTY flag",
      "expect": "shell_command_denied or tool_policy_config_invalid"
    },
    {
      "name": "canary hosted fetch fake",
      "lens": "happy",
      "given": "Fake server canary route stubs hosted fetch flow",
      "expect": "canary step passes without external network call"
    },
    {
      "name": "canary approval reject and expire",
      "lens": "integration",
      "given": "Pending approval canary fixtures",
      "expect": "reject and expire steps mark invocation denied and dispatch count zero"
    },
    {
      "name": "canary connected-node unavailable",
      "lens": "error_path",
      "given": "Connected-node tool request with no eligible node",
      "expect": "tool_node_unavailable is treated as expected denial step"
    },
    {
      "name": "live canary requires confirmation",
      "lens": "error_path",
      "given": "Live external tool canary requested without explicit confirmation",
      "expect": "canary aborts before external calls"
    },
    {
      "name": "product truth exact shipped set",
      "lens": "integration",
      "given": "PRODUCT.md and docs",
      "expect": "state hosted worker fetch/web_search/github/shell and connected-node fetch/web_search/github/repo/shell shipped, with hosted repo and browser unshipped"
    }
  ],
  "integration_contracts": {
    "exports": [
      {
        "name": "runProductionPreflight R22 tools checks",
        "kind": "function",
        "signature": "runProductionPreflight(options) => Promise<ProductionPreflightResult> including tools checks"
      },
      {
        "name": "runProductionCanary R22 tools mode",
        "kind": "function",
        "signature": "runProductionCanary(options) => Promise<ProductionCanaryResult> with deterministic no-spend tool steps by default"
      },
      {
        "name": "ProductionManifest tools posture",
        "kind": "type",
        "signature": "{ tools: { hostedRealTools: 'disabled' | 'enabled'; connectedNodeRealTools: 'disabled' | 'enabled'; policy: 'required_when_enabled'; approvalDefault: 'required'; adapterMode: 'fake_for_smoke' | 'real_explicit' } }"
      }
    ],
    "imports_from_other_tasks": [
      {
        "from_task": "P21-T4-hosted-server-admission",
        "name": "checks.tools readiness shape",
        "signature": "{ ok: boolean; code?: string; diagnostics: { hostedRealTools, connectedNodeRealTools, policySourceKind, allowedPlacements, enabledToolTypes, storeAvailable, queueAvailable, ownershipAvailable, quotaAvailable, auditAvailable, routeAuthAvailable } }"
      },
      {
        "from_task": "P21-T5-hosted-worker-tool-executor",
        "name": "ToolQueuePort",
        "signature": "enqueueTool(payload: ToolJobPayload, options?: { maxAttempts?: number }) => Promise<ToolJobPayload & { jobId: string }> / claimTool() / ackTool(jobId) / failTool(jobId, error) / recoverStaleToolClaims(); enqueueTool dedupes by payload.idempotencyKey"
      },
      {
        "from_task": "P21-T3-core-tool-policy-approval-dispatch",
        "name": "NodeCoordinatorService.createToolAssignment",
        "signature": "createToolAssignment(input: { runId: string; toolInvocationId: string; nodeId?: string; requiredCapability: string; idempotencyKey: string }) => Promise<Assignment>"
      },
      {
        "from_task": "P21-T6-connected-node-tool-assignments",
        "name": "Node tool execution path",
        "signature": "executeToolAssignment(input: { assignment: Assignment; run: Run; toolInvocation: ToolInvocation }) => Promise<NodeExecutionResult>"
      }
    ],
    "file_paths_consumed_by_other_tasks": [
      "scripts/production-preflight.ts",
      "scripts/production-canary.ts",
      "deploy/production/manifest.json",
      "PRODUCT.md"
    ]
  }
}
```

Reviewer pass/fail slices:

- Ops: manifest defaults, preflight enabled/disabled behavior, policy validation, no live calls.
- Canary: hosted fake tool paths, connected-node fake/unavailable paths, approval reject/expire, artifact write.
- Product truth: exact shipped set and exact unshipped boundary.

## Architect Review Reconciliation

- Accepted: connected-node dispatch ordering is reconciled by moving `NodeCoordinatorService.createToolAssignment` and the idempotent assignment-creation contract into P21-T3, before P21-T4 wires hosted approval dispatch.
- Accepted: P21-T4 now has explicit approval list/get acceptance and tests for `tools:read`, ownership-first scoping, tool-only filtering, runtime approval denial, pagination without existence leak, and cross-tenant approval ids.
- Accepted: connected-node adapter construction now imports `buildNodeToolAdapters(NodeToolAdapterConfig)` from the shared adapter factory contract instead of `buildHostedToolAdapters(WorkerConfig)`, and T6 requires node-owned config/credentials/cwd policy/command catalog.
- Accepted: quota ordering is explicit: entitlement and quota-store availability preflight may happen before policy, hourly/active quota reservation happens only for policy-allowed queued/dispatchable work, and artifact-byte quota is consumed only after successful content storage.
- Accepted: durable dispatch idempotency uses a dispatch outbox keyed by `approvalId` and `toolInvocationId`, with tests for approval CAS success followed by enqueue or assignment creation timeout and retry recovery without duplicate side effects.
- Accepted: hosted queue idempotency is now explicit in P21-T5: `ToolJobPayload` carries `approvalId` and `idempotencyKey`, memory and BullMQ queues dedupe `enqueueTool` by that key, and P21-T3/P21-T4 require the same key to flow from dispatch outbox through hosted enqueue so enqueue success plus `markDispatched` timeout retries leave one queue job.
- Partial: P21-T4, P21-T5, and P21-T6 remain broad because the phase boundary is cross-layer, but each now includes a subtask matrix with reviewer pass/fail slices instead of splitting ownership across overlapping files.
- Accepted: `packages/contracts/src/http-error.ts` is now listed as a context file for contracts and hosted-route error mapping tasks where R22 named errors are used.
- Rejected: none.

## Risks

- **Cross-layer blast radius:** R22 spans contracts, storage, core, server, worker, node, adapters, ops, and docs. Mitigation: schema/storage tasks land first; server, worker, and node import the locked contracts; ops waits for all runtime tasks.
- **Approval double-dispatch:** Approval resolution races or post-CAS enqueue/assignment timeouts can create duplicate worker jobs or node assignments. Mitigation: store-level `updateIfStatus` CAS, durable dispatch outbox keyed by approvalId/toolInvocationId, service-level per-approval locks, explicit `ToolJobPayload.idempotencyKey`, memory/BullMQ queue dedupe by that key, idempotent assignment dispatch keys, and tests with concurrent approve/reject/expire plus enqueue success followed by `markDispatched` timeout recovery.
- **Tenant existence leak:** Hosted list/get routes can reveal cross-tenant tool ids if ownership is checked after resource load. Mitigation: route/service tests require ownership-first filtering and not-found/denied behavior without payload leak.
- **Policy drift after approval:** Operator policy changes between approval and execution can execute a different action. Mitigation: immutable redacted execution plans plus `executionPlanHash` revalidation in hosted worker and connected-node dispatch.
- **Accidental public execution surface:** Shell work can drift into raw command execution or public `/shell` style routes. Mitigation: command-catalog only, OpenAPI forbidden route tests, manifest forbidden surface tests, raw field denial tests.
- **Connected-node credential boundary:** Node execution could accidentally reuse hosted worker config or hosted credentials. Mitigation: placement-neutral adapter factory with separate `HostedToolAdapterConfig` and `NodeToolAdapterConfig`, node-owned config/cwd policy/command catalog only, and tests that reject WorkerConfig-shaped node adapter inputs.
- **No-spend test regression:** Fetch/search/GitHub canary tests may accidentally call live services. Mitigation: fake clients by default, explicit live confirmation gate, and tests that count fetch/provider calls.

## Integration Points

- T1 exports additive contracts that every later task imports. No later task edits `packages/contracts/*`.
- T2 exports durable stores, dispatch outbox, tool ownership/quota support, and assignment persistence. T3, T4, T5, and T6 import these store contracts.
- T3 exports `HostedToolService`, placement-aware policy resolution, the idempotent `ToolDispatchCallback` contract, and `NodeCoordinatorService.createToolAssignment`. T4 wires the callback to hosted queue enqueue or the already-defined T3 node assignment creation surface; T5/T6 perform actual execution.
- T5 owns hosted queue idempotency, hosted worker execution, and shared tool adapter factory exports. It imports T3 policy/hash behavior and T2 stores, exposes `ToolQueuePort.enqueueTool(payload)` with required `ToolJobPayload.approvalId` and `ToolJobPayload.idempotencyKey`, dedupes memory/BullMQ tool jobs by that key, and exposes separate hosted and node adapter config contracts.
- T4 registers hosted routes and constructs services from T1/T2/T3/T5. It owns hosted admission, approval list/get/resolve routes, and readiness only; its dispatch callback passes the exact T3 idempotency key into T5 hosted queue payloads and does not implement adapters, node assignment creation, or node execution.
- T6 owns connected-node protocol/app execution. It imports T1 assignment contracts, T2 assignment storage, T3-created assignment semantics, and T5 `buildNodeToolAdapters` with node-owned config only.
- T7 owns operator and product truth artifacts. It imports readiness/queue/node contracts from T3/T4/T5/T6 and does not change runtime code.

## Phase-Level Acceptance Criteria

- [ ] Local daemon R17 real-tool behavior remains backward compatible.
- [ ] Hosted server exposes authenticated `POST /tools/invocations`, `GET /tools/invocations`, and `GET /tools/invocations/:id`.
- [ ] Hosted server exposes authenticated tool-scoped approval list/get/approve/reject routes, but does not expose hosted `POST /approvals`.
- [ ] Hosted tool invocation requires `runId` and tenant ownership.
- [ ] Hosted tool routes enforce `tools:write` and `tools:read` scopes.
- [ ] Enterprise contracts add tool entitlements, quotas, ownership types, audit event types, and audit resource types.
- [ ] Tool entitlements and quota availability are enforced before hosted or node external side effects; active/hourly quota is reserved only after policy allows queued/dispatchable work, and artifact-byte quota is consumed only after successful storage.
- [ ] Hosted real tools are disabled by default and fail closed when policy is missing, empty, malformed, or unsafe.
- [ ] Connected-node real tools are disabled by default and fail closed when no eligible node is online or node policy denies the tool.
- [ ] Hosted worker can execute configured `fetch`, `web_search`, `github`, and command-catalog `shell` through stored execution plans after approval.
- [ ] Hosted worker denies `repo` with `repo_hosted_unshipped`.
- [ ] Connected node can execute configured `fetch`, `web_search`, `github`, `repo`, and command-catalog `shell` through tool assignments after approval.
- [ ] `browser` is denied in hosted and connected-node paths with `browser_tool_unshipped`.
- [ ] Shell accepts only command-catalog `commandId` and bounded args; raw command/executable/env/PTY/terminal request fields are denied.
- [ ] No public arbitrary execution routes are added to local or hosted OpenAPI.
- [ ] Approval approve/reject/expire resolves exactly once, uses durable dispatch outbox idempotency keyed by approvalId/toolInvocationId, threads that key into hosted queue payloads, and cannot dispatch duplicate worker jobs or node assignments even when enqueue succeeds but markDispatched times out or assignment creation times out after approval CAS.
- [ ] Worker and node revalidate policy and execution plan hash before execution.
- [ ] Node assignment schema remains backward compatible for existing run assignments.
- [ ] Node tool assignment completion updates the durable invocation only when assignment/run/node/tool ids match.
- [ ] Hosted and node artifacts use existing object artifact content storage and attach ownership before content is visible.
- [ ] Logs, audit events, approval payloads, invocation records, events, and artifact metadata are bounded and redacted.
- [ ] Readiness, preflight, production manifest, and canary include R22 tool diagnostics and fail-closed checks.
- [ ] Default tests, smoke, preflight, and canary are deterministic and no-spend with fake adapters/clients.
- [ ] Product truth documents exactly what shipped and exactly what remains unshipped.

## Cross-Task Verification

- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/core test -- hosted-tool tool-approval tool-router dispatch-outbox node-coordinator`
- `pnpm --filter @switchyard/protocol-rest test -- hosted-tool`
- `pnpm --filter @switchyard/server test -- hosted-tools production-config production-readiness`
- `pnpm --filter @switchyard/queue test`
- `pnpm --filter @switchyard/queue test -- run-queue.test.ts -t "tool enqueue dedupes after markDispatched timeout"`
- `pnpm --filter @switchyard/adapters test -- hosted-real-tool`
- `pnpm --filter @switchyard/worker test -- hosted-tool-worker production`
- `pnpm --filter @switchyard/protocol-node test`
- `pnpm --filter @switchyard/node test`
- `pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts deploy/production/production-manifest.test.ts`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm --filter @switchyard/contracts openapi:check:hosted`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `git diff --check`

## Self-Review

1. Spec coverage: every acceptance criterion maps to T1 through T7 and the phase-level checklist above.
2. Placeholder scan: no placeholder markers are present.
3. Type consistency: cross-task imports reference matching exports in integration contracts.
4. Ownership disjoint: no task owns a file owned by another task.
5. Context files real: all context files are existing repository paths and are verified in the worktree.
6. Acceptance testable: each acceptance item has observable behavior or a named command/test.
7. Dependency order sane: contracts and storage precede core; T3 owns connected-node assignment creation and dispatch outbox use; T5 owns hosted queue idempotency before T4 wires hosted dispatch into the queue; node depends on core and adapter exports; ops depends on all runtime tasks.
8. Checks runnable: commands use existing package scripts and Vitest entry points.
9. Error/rescue maps present: each task has explicit named failure modes and user-visible results.
10. Observability present: runtime tasks specify low-cardinality logs and metrics; pure contract/storage tasks specify test/operation metrics.
11. Test cases enumerate acceptance: happy, nil, empty, error, edge, and integration paths are covered per task.
12. Integration contracts walk: every import resolves to an export in an earlier or declared dependency task.
13. Contract types match: `ToolInvocationTarget`, `AssignmentClaimResponse`, `HostedToolService`, idempotent `ToolDispatchCallback`, `ToolDispatchOutboxStore`, `NodeCoordinatorService.createToolAssignment`, `ToolQueuePort.enqueueTool`, `ToolJobPayload.approvalId`, `ToolJobPayload.idempotencyKey`, and `buildNodeToolAdapters(NodeToolAdapterConfig)` have matching signatures across tasks.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test_case.
- [x] Every error_rescue_map entry has a matching test_case in `lens: error_path` or `lens: happy_shadow_*`.
- [x] Every integration_contracts.imports_from_other_tasks resolves to a real export elsewhere in the task graph.
- [x] Every context_files path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is present.
- [x] Complexity is L; split into sub-phases was considered and rejected because the R22 shipped boundary requires contracts, admission, execution, node sync, and ops truth to land together behind disabled defaults.
