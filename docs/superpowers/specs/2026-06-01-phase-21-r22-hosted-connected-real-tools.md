# Phase 21 / R22: Hosted And Connected-Node Real Tool Execution

**Date:** 2026-06-01
**Run:** `post-r11-remaining-20260530`
**Branch:** `agent/phase-21-r22-hosted-connected-real-tools`
**Spec target:** `docs/superpowers/specs/2026-06-01-phase-21-r22-hosted-connected-real-tools.md`

## Problem

R17 shipped production real tools only for the local daemon through `POST /tools/invocations`. R21 then activated production hosted execution for known provider runtimes, but tool execution in hosted/server and connected-node paths still remains unshipped product truth. Operators now need the same policy-first, approval-first, tenant-scoped tool contract in hosted and connected-node execution without exposing arbitrary command routes, browser automation, runtime terminal bridges, or generic process adapters.

R22 closes that gap with a narrow product slice: authenticated hosted tool invocation APIs, durable hosted tool approval records, hosted worker execution for safe tools, and connected-node tool assignments for node-owned execution. The release must preserve the R17 contract that every real tool is disabled by default, explicitly allowlisted, approval-by-default, bounded, audited, redacted, and no-spend/fake by default in tests.

## Goals

- Extend the existing R17 `POST /tools/invocations` tool contract into the hosted server API as an authenticated, tenant-scoped route.
- Add durable hosted `tool_invocations` and tool approval storage in Postgres, with ownership rows so list/get/resolve operations cannot leak cross-tenant existence.
- Execute hosted tools outside the hosted server request thread. The hosted server admits, authorizes, records, and dispatches; hosted worker or connected node performs external side effects after approval.
- Ship hosted worker execution for `fetch`, `web_search`, `github`, and command-catalog `shell` where explicitly enabled and policy allowlisted.
- Ship connected-node execution for `fetch`, `web_search`, `github`, `repo`, and command-catalog `shell` where the server and the node both explicitly allow the tool.
- Keep `browser` denied everywhere with `browser_tool_unshipped`.
- Keep hosted `repo` out of R22. Hosted repo inspection needs a separate workspace synchronization and hosted Git policy release; R22 must not weaken the R20 sandbox denylist that intentionally denies generic `git` command exposure.
- Keep shell execution limited to command-catalog policy. A request may name a configured `commandId` and bounded args; it may never supply a raw command, executable path, shell string, env, PTY, terminal config, or process factory.
- Enforce hosted API key auth, tenant/project ownership, entitlements, quotas, audit events, and redaction before any hosted or node external side effect.
- Add preflight, readiness, manifest, no-spend canary, OpenAPI, and product truth updates for this exact boundary.
- Preserve deterministic no-spend test behavior by default. CI, default smoke, preflight, and canary must use fake tool clients or local fake endpoints unless an operator explicitly opts into live external tool checks.

## Non-Goals

- No dashboard.
- No TUI.
- No public `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` arbitrary execution routes.
- No public top-level `/fetch`, `/search`, `/github`, `/repo`, `/browser`, or `/tools/:toolType` execution routes.
- No generic process runtime adapter.
- No generic PTY runtime adapter.
- No generic request-owned process, PTY, terminal, sandbox, executable, cwd, argv, env, shell string, or process factory.
- No Cursor adapter.
- No OpenClaw adapter.
- No Paperclip adapter.
- No hosted browser automation.
- No connected-node browser automation.
- No hosted `repo` tool execution in R22.
- No GitHub write operations, issue comments, PR creation, branch mutation, workflow dispatch, package publication, clone, fetch, pull, push, submodule update, checkout, reset, clean, apply, or commit.
- No hosted debate with real participants.
- No hosted model judging.
- No hosted runtime approval bridge expansion for Codex, Claude Code, OpenCode, AgentField, or Generic HTTP.
- No hosted post-start input bridge or terminal bridge for provider runtimes.
- No public generic hosted approval creation route. Hosted approval resolution in R22 is only for explicit tool approval records created by hosted tool invocation.
- No managed SaaS/public signup, payment provider integration, OAuth/OIDC/SAML/SSO/SCIM, session-cookie auth, or browser login flow.
- No duplicate S3/R2 object-store client work. R13 already shipped object-store client wiring; R22 reuses the existing artifact content store.
- No live external network/API/provider calls in required tests, default smoke, preflight, or default canary.

## Exact Shipped Tool Set

R22 ships these placement-specific tool capabilities:

| Tool type | Local daemon | Hosted worker | Connected node | R22 behavior |
| --- | --- | --- | --- | --- |
| `fetch` | Already shipped in R17 | Shipped in R22 | Shipped in R22 | HTTP(S) `GET`/`HEAD` only, allowlisted hosts, DNS/private-network/redirect protection, bounded output/artifacts. |
| `web_search` | Already shipped in R17 | Shipped in R22 | Shipped in R22 | Configured provider client only, fake/no-spend by default in tests, query/result bounds, no automatic page fetch. |
| `github` | Already shipped in R17 | Shipped in R22 | Shipped in R22 | Read-only allowlisted operations only, token from operator/node env or config, no mutations. |
| `repo` | Already shipped in R17 | Not shipped in R22 | Shipped in R22 | Read-only local Git inspection on the connected node that owns the workspace. Hosted worker denies with `repo_hosted_unshipped`. |
| `shell` | Already shipped in R17 | Shipped in R22 | Shipped in R22 | Command-catalog only; no raw command strings; hosted worker may run only configured non-PTY process commands through production tool policy. |
| `browser` | Denied in R17 | Denied in R22 | Denied in R22 | Always denied before adapter dispatch with `browser_tool_unshipped`. |
| `fake_echo` | Already shipped | Available for tests and no-spend smoke | Available for tests and no-spend smoke | Remains deterministic and safe. |

## Existing Context

`PRODUCT.md` records the current R21 state and the remaining R22 gap:

```md
Current product state: local daemon with shipped runtime modes `fake.deterministic`, `claude_code.sdk`, `codex.exec_json`, `codex.interactive`, `agentfield.async_rest`, `generic_http.async_rest`, and `opencode.acp`; shipped local middleware APIs for messages, memory, evidence, context packets, approvals, and fake tool invocations; shipped local deterministic Debate V1; shipped hosted-like worker execution for fake-only plus an internal sandbox substrate; shipped SDK/CLI/OpenAPI packaging and hardening; shipped self-hosted staging foundation for hosted/connected-node slice; shipped S3/R2-compatible object-store client wiring for hosted artifact content; shipped the R18 API-first hosted/server enterprise control-plane foundation; shipped R19 production hosted deployment readiness; shipped R20 internal production subprocess/PTY sandbox foundation plus production ops gates; and shipped R21 production hosted provider activation for the known provider set `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` with policy-first fail-closed checks. Fake-only remains default.
```

`PRODUCT.md` still marks hosted and connected-node tools as unshipped:

```md
Browser automation and hosted/connected-node real-tool execution are not shipped. R17 ships only local-daemon real tools (`fetch`, `web_search`, `github`, `repo`, command-catalog `shell`) through `POST /tools/invocations` with deny-by-default and approval-by-default policy.
```

`packages/contracts/src/tool.ts` already defines the public tool types and strict input shapes R22 must extend rather than replace:

```ts
export const toolTypeSchema = z.enum(["web_search", "fetch", "browser", "repo", "shell", "github", "fake_echo"]);
export const toolInvocationStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "denied"]);

export const shellToolInputSchema = z.object({
  commandId: nonEmptyTrimmedString.max(128),
  args: z.array(safeToolStringSchema).max(32).optional(),
  cwd: absolutePathLikeSchema
}).strict();
```

`packages/core/src/services/local-policy-gate.ts` shows the current R17 default posture R22 must preserve in hosted and node paths:

```ts
export function createDisabledRealToolPolicyConfig(): ResolvedRealToolPolicyConfig {
  return {
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

`packages/core/src/services/tool-router.ts` already persists queued tool approvals with a redacted execution plan hash. R22 must reuse this invariant when dispatching hosted worker and connected-node execution:

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

`packages/contracts/src/endpoint-inventory.ts` currently exposes tool invocation routes only on the local daemon inventory. Hosted server inventory reuses a narrow set of local routes and does not yet include tools or approvals:

```ts
withDefaults({
  method: "post",
  path: "/tools/invocations",
  operationId: "invokeTool",
  summary: "Invoke tool",
  tags: ["middleware"],
  requestBody: { schemaRef: "CreateToolInvocationRequest", required: true },
  noRequestBody: false,
  success: { status: 201, contentKind: "json", schemaRef: "ToolInvocationResponse", description: "Tool invocation result" }
}),
```

```ts
const HOSTED_SERVER_LOCAL_ROUTE_KEYS = new Set<string>([
  "POST /runs",
  "GET /runs",
  "GET /runs/:id",
  "GET /runs/:id/events",
  "GET /runs/:id/artifacts",
  "POST /runs/:id/input",
  "POST /runs/:id/cancel",
```

`packages/contracts/src/assignment.ts` currently claims only run assignments. R22 must extend this shape for tool assignments without breaking existing run assignment clients:

```ts
export const assignmentClaimResponseSchema = z.object({
  assignment: assignmentSchema.nullable(),
  run: runSchema.nullable()
});
```

`packages/contracts/src/enterprise.ts` currently has no tool scopes, tool entitlement fields, tool quotas, or tool ownership types. R22 must add those before hosted tool routes are public:

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

## Architecture

R22 adds a hosted and node execution layer around the existing R17 tool router. The local daemon keeps its current synchronous local behavior. The hosted server uses the same request schema and policy language, but it never performs external network, process, GitHub, search, repo, or shell side effects in the API request thread. It authenticates the caller, authorizes the run and target, reserves quota, resolves policy, persists the tool invocation and approval, writes ownership/audit records, then dispatches either a hosted worker tool job or a connected-node tool assignment after approval.

The core product boundary is:

```text
Hosted POST /tools/invocations
  -> hosted auth + tools:write scope
  -> require runId and authorize run ownership
  -> infer or validate target placement from run/target
  -> entitlement + quota preflight
  -> shared real-tool policy decision
  -> deny: persist denied invocation + audit, no external side effect
  -> approval_required: persist queued invocation + tool approval + ownership + audit
  -> approve: atomically resolve approval, revalidate policy/plan hash, dispatch execution
  -> hosted worker OR connected node executes with its own allowlisted adapter config
  -> terminal invocation + tool.result event + artifacts + audit + quota release/consume
```

The hosted worker path owns hosted execution for `fetch`, `web_search`, `github`, and command-catalog `shell`. The worker constructs adapters from operator config, fake/no-spend clients in tests, and the existing object artifact content store. Hosted worker `shell` must use a command-catalog execution plan only; it must not register a runtime adapter, PTY, terminal, generic process surface, or public sandbox route. Hosted worker `repo` is explicitly denied in R22 with `repo_hosted_unshipped`.

The connected-node path extends the existing assignment protocol. The server creates a `tool` assignment linked to a durable `toolInvocationId`. A node may claim it only if the node is tenant-owned, online, advertises the required tool capability, and its policy allows the target run/cwd/tool type. The node revalidates the tool with its local policy before adapter execution, uses node-owned credentials/config, syncs bounded `tool.call` and `tool.result` events plus artifacts through existing node sync routes, and completes the assignment with a terminal tool invocation patch. The server owns the durable invocation transition and rejects mismatched node results.

All hosted and connected-node tool artifacts use the R13 object-store/content-store wiring already present in the server/worker stack. R22 must not add a second S3/R2 client or a parallel object-store abstraction.

## Contracts And API Behavior

### Hosted Tool Routes

The hosted server must expose only this hosted middleware subset:

- `POST /tools/invocations`
- `GET /tools/invocations`
- `GET /tools/invocations/:id`
- `GET /approvals`
- `GET /approvals/:id`
- `POST /approvals/:id/approve`
- `POST /approvals/:id/reject`

The hosted server must not expose `POST /approvals` in R22. Hosted approval records are created only by hosted tool invocation. This prevents the hosted API from becoming a generic approval bridge for provider runtimes.

Hosted `POST /tools/invocations` uses the existing body shape with one additive target field:

```json
{
  "runId": "run_abc123",
  "type": "fetch",
  "target": { "placement": "hosted" },
  "input": {
    "url": "https://example.com/status.txt",
    "method": "GET",
    "captureContent": true
  }
}
```

Rules:

- `runId` is required on hosted server. Detached hosted tool invocations are rejected with `tool_run_required`.
- `target` is optional. If absent, target placement is inferred from the owned run's `placement`.
- `target.placement` may be `hosted` or `connected_local_node`.
- `target.placement` must match the run placement unless the run metadata explicitly marks tool offload as allowed. Default mismatch returns `tool_target_mismatch`.
- `target.nodeId` is optional for `connected_local_node`. If absent, the server selects an online owned node that advertises the exact tool capability and satisfies node policy.
- `placement: "local"` is not accepted by hosted server routes. Local daemon behavior remains separate and unchanged.
- Hosted server returns `202` for accepted queued/approval-required tool work. It must not block waiting for hosted worker or node execution.
- Hosted policy denial returns the existing error envelope with `tool_policy_denied`, persists a denied invocation when auth/run ownership succeeded, and includes the `toolInvocationId` in safe error details.
- Invalid body, missing run, auth failure, tenant mismatch, entitlement denial, quota exhaustion, and target selection failure return named errors and do not dispatch adapters.

### Hosted Tool Approval Routes

Hosted approval list/get/approve/reject routes are scoped to tool approval records only:

- A hosted approval is tool-scoped when its payload has a valid `toolInvocationId`.
- Runtime approvals with `runtimeApprovalToken` are not resolved by hosted approval routes in R22. They return `hosted_runtime_approval_bridge_unshipped` or `approval_scope_denied` and must not call `RuntimeRunnerService.sendInput`.
- `approve` atomically transitions the approval, revalidates the stored tool execution plan hash, dispatches exactly one hosted worker job or node assignment, and returns the approval plus invocation.
- `reject` transitions the approval to `rejected`, marks the queued invocation `denied` with `tool_approval_rejected`, emits `approval.rejected` and `tool.result`, and releases any reserved active tool quota.
- Expiration transitions pending tool approvals to `expired`, marks the queued invocation `denied` with `tool_approval_expired`, emits visible events, and releases active tool quota.
- Duplicate approve/reject returns `approval_not_pending` with no duplicate dispatch.

### OpenAPI Boundary

Hosted OpenAPI must add the hosted tool/approval subset above and keep these boundaries test-enforced:

- No public `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, `/sandbox`, `/browser`, `/search`, `/github`, `/fetch`, `/repo`, `/dashboard`, or `/tui` routes.
- No operation id containing `genericProcess`, `arbitraryProcess`, `terminal`, `pty`, `sandbox`, `dashboard`, or `tui`.
- Tool operation ids may remain generic (`invokeTool`, `listToolInvocations`, `getToolInvocation`) and must not be split into per-tool public operations.
- Hosted OpenAPI must not document `POST /approvals`.
- Hosted OpenAPI must mark tool routes as authenticated with API key security.
- Local daemon OpenAPI remains backwards compatible.

## Auth, Tenant, Entitlement, Quota, And Audit

R22 must add hosted tool access to the enterprise control plane before exposing hosted tool routes.

### Scopes

Add auth scopes:

- `tools:write` for `POST /tools/invocations`, `POST /approvals/:id/approve`, and `POST /approvals/:id/reject` when the approval is tool-scoped.
- `tools:read` for `GET /tools/invocations`, `GET /tools/invocations/:id`, `GET /approvals`, and `GET /approvals/:id` when the approval is tool-scoped.

Existing `runs:*`, `nodes:write`, `artifacts:read`, `registry:read`, `metrics:read`, `audit:read`, `entitlements:read`, and `admin:read` scopes keep their existing meaning.

### Entitlements

Add billing-plan entitlement fields with safe defaults:

- `allowHostedTools`: default `false`.
- `allowConnectedNodeTools`: default `false`.
- `allowedToolTypes`: default `[]`.
- `allowToolArtifactContentRead`: default follows `allowArtifactContentRead` only for owned tool artifacts; if absent in legacy bootstrap, treat as `false` in staging/production validation and `true` only in local/test fixtures that explicitly opt in.

Rules:

- Hosted worker target requires `allowHostedTools=true`.
- Connected-node target requires both `allowConnectedNodes=true` and `allowConnectedNodeTools=true`.
- `allowedToolTypes` must include the requested tool type.
- `browser` remains denied even if included by mistake.
- Legacy billing-plan bootstrap records in staging/production must fail closed until tool entitlements are explicit.

### Quotas

Add quota kinds:

- `tool_invocations_per_hour`
- `active_tool_invocations`
- `tool_artifact_bytes_per_hour`

Add billing-plan quota fields:

- `maxToolInvocationsPerHour`
- `maxActiveToolInvocations`
- `maxToolArtifactBytesPerHour`

Rules:

- Invalid/auth/run-not-found/tenant-denied requests do not create invocation rows or reserve quota.
- Policy-denied requests after successful auth and run ownership may persist a denied invocation and audit record, but do not consume invocation quota.
- Approval-required or dispatchable invocations reserve one `tool_invocations_per_hour` unit and count toward `active_tool_invocations` while `queued` or `running`.
- Rejection/expiration before execution releases active quota and marks the invocation `denied`.
- Completed/failed/cancelled execution consumes the invocation reservation and releases active quota.
- Tool artifact bytes are charged only for successfully stored owned artifact content.
- Quota store failures fail closed with `quota_store_unavailable` before dispatch.

### Ownership

Add resource ownership types:

- `tool_invocation`
- `approval`

Rules:

- `tool_invocation` ownership is attached immediately after invocation row creation and before returning a hosted response.
- Tool-created approval ownership is attached immediately after approval row creation.
- List/get routes must scope by ownership first, before checking existence-sensitive details.
- Approval resolution must authorize both the approval and linked invocation owner.
- Tool artifacts remain owned as `artifact` resources and linked to the run and invocation metadata.
- Node tool assignments remain owned as `assignment` resources.

### Audit

Add audit event types:

- `tool.invoke_allowed`
- `tool.invoke_denied`
- `tool.approval_requested`
- `tool.approval_resolved`
- `tool.execution_dispatched`
- `tool.execution_started`
- `tool.execution_completed`
- `tool.execution_failed`
- `tool.execution_cancelled`

Add audit resource types:

- `tool_invocation`
- `approval`

Audit payloads must be redacted and low-cardinality. They may include:

- route id
- tool type
- target placement
- target node id only when already authorized
- invocation id
- approval id
- reason code
- policy trace summary
- output/artifact size buckets

Audit payloads must not include:

- raw URLs with secret query parameters
- full search query if it may contain secrets; store a hash or length bucket
- GitHub token
- API keys
- env values
- raw stdout/stderr
- raw response bodies
- object-store keys unless already public-safe
- absolute cwd except policy summary

## Tool Policy Contract

R22 must factor R17's local `LocalPolicyGate` into a shared placement-aware real-tool policy resolver. Existing local behavior must remain compatible.

Minimum resolved policy shape:

```json
{
  "global": {
    "enabled": false,
    "allowedPlacements": ["local"],
    "approvalDefault": "required",
    "approvalExpiresMs": 300000,
    "maxConcurrentRealTools": 2,
    "maxInputBytes": 65536,
    "maxInlineOutputBytes": 32768,
    "maxArtifactBytes": 1048576,
    "defaultTimeoutMs": 30000
  },
  "placements": {
    "hosted": {
      "enabled": false,
      "allowedToolTypes": [],
      "repo": { "enabled": false, "reasonCode": "repo_hosted_unshipped" }
    },
    "connected_local_node": {
      "enabled": false,
      "allowedToolTypes": []
    }
  }
}
```

Operator config variables:

- `SWITCHYARD_HOSTED_REAL_TOOLS=disabled|enabled`, default `disabled`.
- `SWITCHYARD_CONNECTED_NODE_REAL_TOOLS=disabled|enabled`, default `disabled`.
- `SWITCHYARD_REAL_TOOL_POLICY_JSON` or `SWITCHYARD_REAL_TOOL_POLICY_PATH`, max 65536 bytes.
- `SWITCHYARD_TOOL_ADAPTER_MODE=fake|real`, default `fake` in test/local smoke and `real` only when production policy explicitly enables real tools.

Policy rules:

- Unknown placement returns `tool_target_invalid`.
- Hosted tools enabled without API-key hosted auth returns `tool_hosted_auth_required`.
- Hosted tools enabled without Postgres approval/tool stores returns `tool_store_unavailable`.
- Hosted tools enabled without queue/dispatcher readiness returns `tool_dispatch_unavailable`.
- Hosted `repo` always returns `repo_hosted_unshipped`.
- Connected-node tools enabled without a matching online node returns `tool_node_unavailable`.
- Node policy mismatch returns `node_policy_denied`.
- Tool disabled returns `tool_policy_denied` with `rule: "tool_disabled"`.
- Browser always returns `browser_tool_unshipped`.
- Shell policy must reject `command`, `executable`, `executablePath`, `shell`, `pty`, `terminal`, `env`, and `process` request fields with `shell_command_denied`.
- All execution plans must be hashable, redacted, immutable enough that approval cannot target one action and execute another, and safe to persist.

## Hosted Worker Execution

Hosted worker must execute tool jobs only after claim-time readiness and invocation revalidation.

Worker execution rules:

- Worker claims a tool job containing `toolInvocationId`, `runId`, target placement, tool type, execution plan hash, and attempt metadata.
- Worker reloads the invocation from Postgres, verifies status is `queued`, verifies approval is approved or policy explicitly allowed no-approval in non-production test config, and CAS transitions invocation to `running`.
- Worker re-runs policy with the stored request and compares execution plan hash.
- Worker constructs adapters from worker-owned config and env only.
- Worker does not trust request-owned credentials, executable paths, env, cwd prefixes, process factories, PTY config, terminal config, or raw shell strings.
- Worker emits `tool.call` when execution starts and exactly one terminal `tool.result`.
- Worker stores bounded artifacts under `runs/<runId>/tools/<toolInvocationId>/<artifactLogicalName>`.
- Worker updates invocation to `completed`, `failed`, `cancelled`, or `denied` with a named reason.
- Queue retry exhaustion terminalizes the invocation as `failed` with `tool_dispatch_retry_exhausted`.
- Worker restart reconciliation marks stale `running` hosted tool invocations as `failed` with `tool_worker_restarted` unless a valid in-flight job can be proven by the queue.

Hosted worker tool specifics:

- `fetch`: same R17 fetch adapter behavior, with DNS/private-network validation after every redirect. Fake fetch client is default in no-spend tests.
- `web_search`: configured provider client only. Missing provider returns `web_search_provider_unconfigured`. Fake search client is default in tests.
- `github`: read-only allowlisted operations only. Token comes from worker config/env and is never accepted in request input or sent to connected nodes.
- `shell`: command-catalog process execution only. Hosted shell must not use PTY. Hosted shell command policy must name absolute executable paths, fixed argv, allowed user args, cwd prefixes, env allowlist, timeout, output caps, and approval requirement. The default catalog is empty.
- `repo`: denied before dispatch with `repo_hosted_unshipped`.
- `browser`: denied before dispatch with `browser_tool_unshipped`.

## Connected-Node Execution

R22 must extend the node protocol to support tool assignments while preserving existing run assignment compatibility.

### Node Capability And Policy

Node registration and heartbeat may include capabilities:

- `tools.real`
- `tool.fetch`
- `tool.web_search`
- `tool.github`
- `tool.repo`
- `tool.shell`

Extend `NodePolicy` with:

- `allowToolTypes`: string array, default `[]`.
- `allowToolCwdPrefixes`: string array, default `[]`.
- `toolArtifactSync`: `none | metadata_only | full`, default existing `artifactSync`.
- `maxToolArtifactBytes`: positive integer optional.
- `toolApprovalRequired`: boolean, default `true`.

Rules:

- Capability claims are not sufficient. Server policy and node policy must both allow the tool.
- Node policy is redacted capability truth. It must not include tokens, env values, executable paths with secrets, or raw catalog contents.
- If a node advertises a tool capability but its policy denies the concrete request at claim time, it must reject the assignment with `node_policy_denied`.
- Nodes must load their own local tool config and credentials. Server must not send GitHub/search credentials or shell env secrets in assignment payloads.

### Assignment Contract

Extend assignment contracts additively:

- `assignment.kind`: `run | tool`, default `run` for existing rows and clients.
- `assignment.toolInvocationId`: optional, required when `kind = "tool"`.
- `assignmentClaimResponse.toolInvocation`: nullable tool assignment payload.

Tool claim response shape:

```json
{
  "assignment": {
    "id": "assignment_tool_123",
    "kind": "tool",
    "runId": "run_abc123",
    "nodeId": "node_abc123",
    "status": "claimed",
    "toolInvocationId": "tool_abc123",
    "lastEventSequence": 12,
    "createdAt": "2026-06-01T00:00:00.000Z"
  },
  "run": {
    "id": "run_abc123",
    "placement": "connected_local_node"
  },
  "toolInvocation": {
    "id": "tool_abc123",
    "type": "repo",
    "input": {
      "request": {
        "operation": "diff",
        "cwd": "/repo",
        "pathspec": ["packages/core/src/services/tool-router.ts"]
      },
      "executionPlanHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  }
}
```

Rules:

- Existing run assignment clients that ignore `kind` and `toolInvocation` must continue to claim run assignments.
- Node app must route `kind = "run"` to existing run execution and `kind = "tool"` to tool execution.
- Tool assignment payload must be bounded and redacted.
- For connected-node shell and GitHub/search tools, node uses node-owned config to build final adapter inputs. Server-sent payload must not contain secrets.
- Node must emit `tool.call` and `tool.result` events through existing event sync.
- Node must sync artifacts through existing manifest/content routes.
- `assignmentCompleteRequest` gains an optional `toolInvocation` terminal patch for `kind = "tool"`.
- Server rejects completion where assignment id, run id, node id, or tool invocation id do not match with `tool_assignment_mismatch`.
- If node completes assignment `failed`, server marks invocation `failed` with the node reason code or `tool_node_execution_failed`.
- If node disappears or assignment expires, server marks invocation `failed` with `tool_assignment_expired` or `tool_node_unavailable`.

### Connected-Node Tool Specifics

- `fetch`: node-owned adapter config, same R17 network policy, private-network denial by default.
- `web_search`: node-owned provider config, fake/no-spend client in tests, no page fetch.
- `github`: node-owned token/env, read-only allowlisted repos and operations.
- `repo`: node-owned local workspace only; cwd must be under node policy prefixes; fixed read-only Git argv; no network Git operations.
- `shell`: node-owned command catalog only; no raw commands, no request executable, no PTY, no terminal bridge.
- `browser`: denied with `browser_tool_unshipped`.

## Data Flows And Shadow Paths

### Flow 1: Hosted Tool Invocation Admission

- Happy path: API key has `tools:write`, run is owned by the tenant, body has a known tool type and valid input, target placement is hosted or connected-node, entitlement/quota/policy allow the request, and Switchyard persists a queued invocation plus tool approval or dispatchable invocation.
- Nil path: missing body, missing `runId`, missing `type`, missing `input`, or missing auth returns `invalid_input`, `tool_run_required`, or `auth_required`; no invocation, quota reservation, approval, queue job, node assignment, or adapter dispatch occurs.
- Empty path: empty input object, empty URL/query/owner/repo/command id/cwd/pathspec returns field-specific `invalid_input` or a named policy denial; no adapter dispatch occurs.
- Error path: control-plane store unavailable, quota store unavailable, malformed policy JSON, policy resolver exception, queue unavailable, or ownership attach failure returns `auth_store_unavailable`, `quota_store_unavailable`, `tool_policy_config_invalid`, `tool_policy_failed`, `tool_dispatch_unavailable`, or `ownership_attach_failed`; no external tool side effect occurs.

### Flow 2: Tool Approval Resolution

- Happy path: pending tool approval is owned by the tenant, not expired, approved once, policy revalidates to the same execution plan hash, and Switchyard dispatches exactly one hosted worker job or connected-node assignment.
- Nil path: missing approval id, missing linked invocation, missing ownership, or missing tool payload returns `approval_not_found`, `tool_invocation_not_found`, `resource_not_owned`, or `approval_scope_denied`; no dispatch occurs.
- Empty path: empty actor/reason/answers are accepted as absent after redaction; approval still resolves if all ownership and policy checks pass.
- Error path: duplicate approve/reject returns `approval_not_pending`; expired approval returns `approval_not_pending` after terminalizing with `tool_approval_expired`; policy hash mismatch returns `tool_policy_failed`; queue/assignment creation failure marks invocation `failed` with `tool_dispatch_failed` and emits audit.

### Flow 3: Hosted Worker Tool Execution

- Happy path: worker readiness passes, job is claimed, invocation is still queued, approval is approved, policy hash matches, adapter is configured, tool completes within timeout/size bounds, artifacts are stored, invocation becomes `completed`, and audit/metrics/events are emitted.
- Nil path: job references a missing run, missing invocation, missing approval, or missing adapter config; worker fails the job with `hosted_run_state_invalid`, `tool_invocation_not_found`, `approval_not_found`, or `tool_adapter_unavailable`.
- Empty path: upstream returns zero search results, empty HTTP body, empty stdout/stderr, or empty artifact candidate; invocation may complete with explicit empty output metadata and no raw content artifact.
- Error path: upstream timeout/rate limit/decode error, DNS/private-network denial, GitHub token missing, process spawn failure, non-zero exit, output flood, artifact write failure, object store failure, worker crash, or queue retry exhaustion maps to one terminal failed invocation with named reason and no silent loss.

### Flow 4: Connected-Node Tool Assignment

- Happy path: server selects an owned online node with required capability, node claims assignment, node revalidates local policy, executes with node-owned config, syncs events/artifacts, completes with a terminal invocation patch, and server marks invocation terminal.
- Nil path: no online node, missing node ownership, missing assignment, missing run, missing invocation, or node has no local tool config returns `tool_node_unavailable`, `assignment_not_found`, `run_not_found`, `tool_invocation_not_found`, or `tool_adapter_unavailable`.
- Empty path: node returns no events, no artifacts, zero stdout, zero results, or metadata-only artifacts; server records explicit empty output and completes or fails according to the terminal patch.
- Error path: node rejects policy, claim conflict, event sync gap, artifact digest mismatch, artifact content too large, node timeout, node offline, assignment expiry, or mismatched terminal patch maps to `node_policy_denied`, `assignment_claim_conflict`, `event_sync_gap`, `artifact_digest_mismatch`, `payload_too_large`, `tool_assignment_expired`, or `tool_assignment_mismatch`.

### Flow 5: Artifact And Content Storage

- Happy path: adapter output exceeds inline cap or capture is requested; bounded artifact content is written through the existing object artifact content store, digest/size metadata is stored, ownership is attached, and artifact ids appear in `tool.result`.
- Nil path: no object content store configured for hosted/worker path returns `object_store_unavailable`; execution fails unless output fits entirely inline and policy permits no artifact.
- Empty path: zero-byte response or empty process output stores no content artifact unless metadata-only artifact is explicitly useful; invocation can still complete with size `0`.
- Error path: write timeout, auth failure, bucket missing, digest mismatch, content too large, or redaction failure marks invocation `failed` with `object_store_timeout`, `object_store_auth_failed`, `object_store_bucket_not_found`, `artifact_digest_mismatch`, `tool_output_limit_exceeded`, or `tool_redaction_failed`.

### Flow 6: Readiness, Preflight, Manifest, And Canary

- Happy path: tools disabled by default reports ready; tools enabled with explicit policy, auth, stores, queue, worker/node capability, fake/no-spend adapter checks, and object store probe reports ready and preflight passes.
- Nil path: missing policy file, missing Postgres, missing Redis, missing API-key auth, missing bootstrap tool entitlements, missing object store, or missing node token returns a named readiness/preflight failure before traffic.
- Empty path: empty policy file, empty allowlists, empty shell catalog, empty node capability set, or empty hosted tool allowlist returns named fail-closed config errors.
- Error path: malformed JSON, invalid UTF-8, unreadable path, stale schema, adapter check failure, node heartbeat expiry, object store probe failure, or canary assertion failure returns deterministic diagnostics with redacted config summaries.

## Named Errors And Reason Codes

R22 must use stable reason codes in service errors, invocation errors, event payloads, audit events, readiness diagnostics, and tests:

- `tool_run_required`
- `tool_target_invalid`
- `tool_target_mismatch`
- `tool_hosted_auth_required`
- `tool_store_unavailable`
- `tool_dispatch_unavailable`
- `tool_dispatch_failed`
- `tool_dispatch_retry_exhausted`
- `tool_policy_denied`
- `tool_policy_config_invalid`
- `tool_policy_failed`
- `tool_real_tools_disabled`
- `tool_hosted_tools_disabled`
- `tool_connected_node_tools_disabled`
- `tool_approval_required`
- `tool_approval_rejected`
- `tool_approval_expired`
- `tool_adapter_unavailable`
- `tool_invocation_not_found`
- `tool_input_limit_exceeded`
- `tool_concurrency_limit_exceeded`
- `tool_output_limit_exceeded`
- `tool_artifact_write_failed`
- `tool_redaction_failed`
- `tool_worker_restarted`
- `tool_node_unavailable`
- `tool_node_execution_failed`
- `tool_assignment_expired`
- `tool_assignment_mismatch`
- `hosted_runtime_approval_bridge_unshipped`
- `approval_scope_denied`
- `repo_hosted_unshipped`
- `browser_tool_unshipped`
- Existing R17 tool-specific codes: `fetch_url_invalid`, `fetch_host_not_allowlisted`, `fetch_private_network_denied`, `fetch_redirect_denied`, `fetch_method_denied`, `fetch_content_type_denied`, `web_search_provider_unconfigured`, `web_search_query_invalid`, `github_token_missing`, `github_repo_not_allowlisted`, `github_operation_denied`, `github_not_found`, `github_rate_limited`, `repo_cwd_denied`, `repo_operation_denied`, `repo_pathspec_invalid`, `shell_command_denied`, `shell_command_not_configured`, `tool_process_spawn_failed`, `tool_process_nonzero_exit`, `tool_process_timeout`, `tool_process_cancelled`.

## User-Visible Behavior

- Hosted tools disabled by default: hosted `POST /tools/invocations` for any real tool returns a named policy denial after auth/run ownership, stores a denied invocation, records audit, and dispatches no adapter.
- Hosted fake/no-spend path: an explicitly enabled fake/test policy can invoke `fake_echo` or fake clients without live external calls.
- Hosted `fetch` happy path: user invokes `fetch` for an owned hosted run, receives a pending approval, approves it, worker performs bounded fetch after approval, and the invocation later shows `completed` with redacted summary and artifact ids.
- Hosted `github` missing token: approval may be denied at policy time with `github_token_missing`, or worker fails with `github_token_missing` if config changes after approval; no token is ever accepted in the request.
- Hosted `repo`: request is denied with `repo_hosted_unshipped`.
- Connected-node `repo` happy path: user invokes `repo` for an owned connected-node run, approval is created, node claims a tool assignment after approval, node executes read-only Git inspection in its local allowed cwd, and results sync back as events/artifacts.
- Connected-node unavailable: if no eligible node is online, the request fails or queued invocation fails visibly with `tool_node_unavailable`; it must not hang.
- Shell request with raw command fields: `shell` request containing `command`, `executable`, `executablePath`, `env`, `pty`, or `terminal` is denied with `shell_command_denied`.
- Browser request: every hosted or node `browser` invocation is denied with `browser_tool_unshipped`.
- Rejected/expired approval: invocation becomes `denied`; no worker or node adapter side effect occurs.
- Duplicate approval: second resolve returns `approval_not_pending` and does not dispatch a second job or assignment.
- Artifact write failure: invocation fails with a named reason; Switchyard must not report a successful tool while silently dropping needed output.

## Constraints

- Real hosted and node tools are disabled by default.
- Hosted/server and connected-node tools require explicit operator allowlists, tenant entitlements, quota, audit, and readiness.
- Production hosted routes require API-key auth and tool scopes.
- Hosted server must require `runId` for tool invocations.
- Hosted server must not execute real tool side effects in the API request thread.
- Every real tool requires approval by default. Any no-approval mode is test/local-only unless production policy explicitly allows a non-side-effect fake tool.
- Policy is checked before approval creation and rechecked before worker/node execution.
- Execution plan hash mismatch must deny execution.
- Connected nodes must revalidate local policy before execution.
- Output, artifact, input, body, event, log, and audit payload bounds are hard limits.
- Redaction must run before persistence of request input, approval payload, events, logs, artifact metadata, audit payloads, and inline outputs.
- No required test, smoke, canary, preflight, or readiness check may call live external APIs by default.
- OpenAPI must not expose arbitrary execution routes.
- Product docs must not claim browser automation, hosted repo, generic process/PTY adapters, arbitrary shell, dashboard, TUI, hosted debate real participants, or model judging.

## Readiness, Preflight, Manifest, Canary, And Docs

Readiness additions:

- Hosted server `/ready` adds `checks.tools` with redacted diagnostics: enabled flags, policy source kind, allowed placements, enabled tool types, store availability, queue availability, ownership support, quota support, audit support, and route auth support.
- Hosted worker `ready({ mode: "claim" })` adds `checks.tools` for policy parse, adapter construction, fake/no-spend adapter checks, object store, queue, and shell catalog/sandbox compatibility.
- Node startup/heartbeat reports redacted tool capability summary; server readiness should not require a node unless connected-node tools are enabled.

Preflight additions:

- `production:preflight` must fail closed if tools are enabled without explicit policy, API-key auth, Postgres, Redis, object store, control-plane bootstrap tool entitlements, quota support, audit support, route auth rules, or worker/node readiness hooks.
- Preflight must validate policy JSON/path, max bytes, unknown tool types, unknown placements, empty allowlists, invalid bounds, hosted repo denial, browser denial, shell catalog fields, and fake/no-spend adapter mode.

Manifest additions:

- Production manifest defaults remain tools disabled:

```json
{
  "tools": {
    "hostedRealTools": "disabled",
    "connectedNodeRealTools": "disabled",
    "policy": "required_when_enabled",
    "approvalDefault": "required",
    "adapterMode": "fake_for_smoke"
  }
}
```

Canary additions:

- Add deterministic no-spend canary coverage for hosted `fetch`, hosted `github`, hosted `shell` denial/allowlisted fake command, connected-node `repo`, connected-node unavailable denial, approval reject/expire, and artifact write.
- Live external tool canaries, if added for operators, must require explicit env confirmation and must not run in default CI/audit.

Docs/product truth:

- `PRODUCT.md` must move hosted/connected-node real tools from unshipped to shipped only for the R22 tool set and placements above.
- Product truth must still say browser automation is unshipped.
- Product truth must still say hosted `repo` is unshipped.
- Product truth must still say no dashboard/TUI, arbitrary execution routes, generic process/PTY adapters, Cursor/OpenClaw/Paperclip, hosted debate real participants, model judging, or hosted runtime approval/input/terminal bridge shipped in R22.

## Acceptance Criteria

- [ ] Local daemon R17 real-tool behavior remains backward compatible.
- [ ] Hosted server exposes authenticated `POST /tools/invocations`, `GET /tools/invocations`, and `GET /tools/invocations/:id`.
- [ ] Hosted server exposes authenticated tool-scoped approval list/get/approve/reject routes, but does not expose hosted `POST /approvals`.
- [ ] Hosted tool invocation requires `runId` and tenant ownership.
- [ ] Hosted tool routes enforce `tools:write` and `tools:read` scopes.
- [ ] Enterprise contracts add tool entitlements, quotas, ownership types, audit event types, and audit resource types.
- [ ] Tool entitlements and quotas are enforced before hosted or node external side effects.
- [ ] Hosted real tools are disabled by default and fail closed when policy is missing, empty, malformed, or unsafe.
- [ ] Connected-node real tools are disabled by default and fail closed when no eligible node is online or node policy denies the tool.
- [ ] Hosted worker can execute configured `fetch`, `web_search`, `github`, and command-catalog `shell` through stored execution plans after approval.
- [ ] Hosted worker denies `repo` with `repo_hosted_unshipped`.
- [ ] Connected node can execute configured `fetch`, `web_search`, `github`, `repo`, and command-catalog `shell` through tool assignments after approval.
- [ ] `browser` is denied in hosted and connected-node paths with `browser_tool_unshipped`.
- [ ] Shell accepts only command-catalog `commandId` and bounded args; raw command/executable/env/PTY/terminal request fields are denied.
- [ ] No public arbitrary execution routes are added to local or hosted OpenAPI.
- [ ] Approval approve/reject/expire resolves exactly once and cannot dispatch duplicate worker jobs or node assignments.
- [ ] Worker and node revalidate policy and execution plan hash before execution.
- [ ] Node assignment schema remains backward compatible for existing run assignments.
- [ ] Node tool assignment completion updates the durable invocation only when assignment/run/node/tool ids match.
- [ ] Hosted and node artifacts use existing object artifact content storage and attach ownership before content is visible.
- [ ] Logs, audit events, approval payloads, invocation records, events, and artifact metadata are bounded and redacted.
- [ ] Readiness, preflight, production manifest, and canary include R22 tool diagnostics and fail-closed checks.
- [ ] Default tests, smoke, preflight, and canary are deterministic and no-spend with fake adapters/clients.
- [ ] Product truth documents exactly what shipped and exactly what remains unshipped.

## Required Tests

All required tests must be deterministic and no-spend.

- Contract tests:
  - additive target field on tool invocation request;
  - hosted tool-scoped approval routes and no hosted `POST /approvals`;
  - tool scopes in auth scope schema;
  - tool entitlements, quotas, ownership types, audit event/resource types;
  - assignment `kind`, `toolInvocationId`, and nullable `toolInvocation` claim response;
  - hosted/local OpenAPI route boundary tests.
- Storage tests:
  - Postgres approvals store;
  - Postgres tool invocation store;
  - ownership for tool invocation and approval;
  - additive migration compatibility from pre-R22 schemas;
  - list/get filters and cursor pagination for hosted tool invocations/approvals.
- Core policy tests:
  - hosted tools disabled;
  - connected-node tools disabled;
  - hosted fetch/search/github/shell allowed with explicit policy;
  - hosted repo denied;
  - connected-node repo allowed with explicit policy;
  - browser denied;
  - plan hash stability and redaction;
  - nil/empty/error paths for every flow.
- Hosted server route tests:
  - auth required;
  - missing scope;
  - run not found;
  - tenant mismatch without existence leak;
  - missing `runId`;
  - target mismatch;
  - entitlement denied;
  - quota exceeded;
  - policy denied with persisted denied invocation;
  - approval queued;
  - approval reject/expire;
  - approval approve dispatches once;
  - runtime approval bridge remains unshipped.
- Hosted worker tests:
  - fake fetch happy/timeout/private IP/redirect denied/oversized;
  - fake search happy/zero results/provider unavailable/oversized;
  - fake GitHub happy/repo denied/token missing/rate limit;
  - shell catalog happy/unknown command/raw command denied/non-zero/timeout/output flood;
  - repo hosted denied;
  - stale running invocation reconciliation.
- Connected-node tests:
  - node capabilities and policy registration;
  - no eligible node;
  - node policy denied;
  - claim run assignment backward compatibility;
  - claim tool assignment payload;
  - repo happy path using fake process factory;
  - shell command-catalog happy/denied;
  - event sync gap;
  - artifact digest mismatch;
  - completion id mismatch;
  - node offline/assignment expiry terminalizes invocation.
- Redaction and security tests:
  - representative secret keys in request, URL query, headers, GitHub token, env, stdout/stderr, artifact metadata, audit payload, approval payload;
  - no private IP fetch after DNS and redirects;
  - no command injection through shell args or repo pathspecs;
  - no raw object-store keys in logs/audit.
- Ops tests:
  - server `/ready` tools disabled;
  - server `/ready` tools enabled missing policy;
  - worker claim readiness tools enabled;
  - production preflight fail-closed cases;
  - manifest defaults disabled;
  - deterministic no-spend production tool canary.

Suggested verification command set for implementation:

```bash
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/storage test
pnpm --filter @switchyard/core test -- tool
pnpm --filter @switchyard/protocol-rest test -- middleware
pnpm --filter @switchyard/protocol-node test
pnpm --filter @switchyard/server test
pnpm --filter @switchyard/worker test
pnpm --filter @switchyard/node test
pnpm --filter @switchyard/adapters test -- real-tool
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

## Task Themes

1. **Contracts, Storage, And OpenAPI**
   - Add hosted tool target contract, tool auth scopes, entitlements, quotas, audit/ownership types, Postgres approval/tool invocation stores, assignment kind/tool payload contracts, and route inventory/OpenAPI updates.
   - Complexity: M.

2. **Hosted Server Admission And Tool Approval Control Plane**
   - Add authenticated hosted tool routes, tool-scoped approval routes, run ownership authorization, entitlement/quota/audit enforcement, policy resolution, dispatch records, and no runtime approval bridge expansion.
   - Complexity: L.

3. **Hosted Worker Tool Executor**
   - Add worker tool job claiming, policy/hash revalidation, fake/no-spend adapter construction, hosted fetch/search/GitHub/shell execution, hosted repo denial, artifacts, events, metrics, readiness, and stale job reconciliation.
   - Complexity: L.

4. **Connected-Node Tool Assignments**
   - Add node tool capabilities/policy, assignment kind support, claim payloads, node-side tool executor, local policy revalidation, event/artifact sync, terminal invocation patching, and offline/expiry handling.
   - Complexity: L.

5. **Ops, Canary, Product Truth, And Regression Matrix**
   - Add fail-closed preflight/readiness/manifest/canary coverage, no-spend fake adapter acceptance, redaction/security tests, and product truth updates that keep browser/hosted repo/arbitrary process routes out of scope.
   - Complexity: M.

## Phase

### Phase 21: R22 Hosted And Connected-Node Real Tool Execution

**Goal:** Ship production-safe hosted and connected-node real-tool execution for the exact R22 tool set behind existing tool invocation and approval contracts, with tenant auth, quotas, audit, redaction, readiness, OpenAPI boundaries, and no-spend fake defaults.

**Acceptance:**

- Hosted server can admit and track authenticated, tenant-scoped tool invocations for owned runs.
- Hosted worker can execute configured hosted `fetch`, `web_search`, `github`, and command-catalog `shell` after approval.
- Connected nodes can execute configured `fetch`, `web_search`, `github`, `repo`, and command-catalog `shell` after approval.
- Hosted `repo`, all `browser` automation, arbitrary execution routes, generic process/PTY adapters, dashboard, and TUI remain unshipped and test-guarded.
- Tool approvals resolve exactly once; rejection/expiration prevents side effects.
- Every data flow has happy, nil, empty, and error-path tests using deterministic no-spend fakes.
- Readiness, preflight, manifest, canary, audit, metrics, OpenAPI, and product truth match the shipped boundary.

**Non-goals (this phase):** Dashboard; TUI; public arbitrary execution routes; generic process/PTY runtime adapters; request-owned shell/process/PTY/terminal/sandbox execution; browser automation; hosted repo; Cursor; OpenClaw; Paperclip; hosted debate real participants; model judging; hosted runtime approval/input/terminal bridges; managed SaaS/signup/payments/OAuth/SSO.

**Complexity:** L

## Future Trajectory

- R23 candidate: hosted repo execution after a dedicated hosted workspace synchronization, Git binary policy, and non-network Git inspection release.
- R23/R24 candidate: browser automation after a separate browser isolation, network, screenshot/video artifact, script restriction, and fake browser test design.
- Future candidate: live external tool canaries for operators, always behind explicit spend/network confirmation.
- Future candidate: richer tenant tool policy management surface. This remains API/config only in R22, with no dashboard or TUI.
