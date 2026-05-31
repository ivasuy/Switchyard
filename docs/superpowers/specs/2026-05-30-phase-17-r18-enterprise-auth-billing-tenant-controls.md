# Phase 17 Spec: R18 Enterprise Auth, Billing, And Tenant Controls

**Date:** 2026-05-30
**Run:** `post-r11-remaining-20260530`
**Branch:** `agent/phase-17-r18-enterprise-auth-billing-tenant-controls`
**Spec target:** `docs/superpowers/specs/2026-05-30-phase-17-r18-enterprise-auth-billing-tenant-controls.md`

## Problem

Switchyard can now run local real tools and self-hosted/staging hosted runtimes, but the hosted server still behaves like a single-operator control plane. Production hosted execution cannot safely move forward until every hosted/server request has an authenticated actor, a tenant boundary, a project/resource owner, an entitlement decision, quota enforcement, and an audit trail for security-relevant actions.

R18 should ship the enterprise control-plane foundation, not a full SaaS product. The right slice is API-first and fail-closed for hosted/server APIs: contracts, API key authentication, tenant-scoped resource ownership, plan/entitlement/quota enforcement, redacted audit/log/error behavior, deterministic in-memory tests, and Postgres-capable persistence. Dashboard, TUI, payment-provider integration, managed production hosting, public tenant self-service, hosted tools, and arbitrary hosted process/PTY remain out of scope.

## Priority Rationale

Enterprise auth, billing, and tenant controls are the next highest-priority gap because hosted execution without a tenant boundary is unsafe:

- Hosted runs, connected nodes, artifacts, events, metrics, and future real hosted tools must not be visible across customers.
- Billing plans and quotas must be enforced before hosted/server side effects such as run creation, queue enqueue, node assignment, artifact reads that expose object-store keys, or real runtime execution.
- Production/staging config must fail before binding a server if auth, key hashing, control-plane bootstrap, or quota persistence is absent.
- Dashboard or TUI work before this phase would create more unauthenticated surface area.
- Payment integration before this phase would couple revenue state to an unproven identity and quota boundary.

## Goals

- Add first-class contracts for `Account`, `Tenant`, `Project`, `User`, `ApiKey`, `BillingPlan`, `EntitlementSnapshot`, `QuotaUsage`, and `AuditLogEvent`.
- Add API key authentication for hosted/server API routes. Staging and production must require it by default and fail closed if it is disabled or incompletely configured.
- Preserve local daemon backwards compatibility. The local daemon remains no-auth by default. Any local-daemon auth support must be explicitly configured and tested separately from the default no-auth path.
- Attach tenant/account/project/user ownership to hosted/server resources created through authenticated requests: runs, events, artifacts, placement decisions, connected nodes, assignments, and audit events.
- Enforce tenant/project scoping in reads, lists, event streams, artifact metadata/content reads, node routes, and run lifecycle mutations.
- Add billing-plan and entitlement contracts without payment-provider integration. Plans are assigned by operator/bootstrap data in R18.
- Enforce at least the R18 useful quota set before side effects: run creation rate/window, active run count, max timeout seconds, allowed placements/runtime modes, and connected-node count.
- Add audit-log events for security-relevant actions and expose a tenant-scoped read API for authorized callers.
- Redact API keys, bearer tokens, secret hashes, node tokens, object-store credentials, provider credentials, and sensitive query parameters from logs, audit payloads, error envelopes, readiness, metrics, and artifacts where R18 touches them.
- Keep required tests deterministic and no-spend. No test may contact a payment provider, model provider, hosted browser, real GitHub, external search, AWS, Cloudflare R2, or live network dependency.
- Update REST/OpenAPI boundaries so hosted/server auth, tenant, entitlement, quota, and audit behavior is visible in generated contracts while the local-daemon OpenAPI remains backwards compatible.
- Update product/development truth so R18 is described as an enterprise control-plane foundation, not as managed SaaS, payment collection, public self-service, dashboard, TUI, or hosted tools.

## Non-Goals

- No dashboard.
- No TUI.
- No payment provider integration, Stripe integration, invoices, checkout, webhooks, tax, metering export, subscription lifecycle, dunning, or customer portal.
- No public tenant signup, public tenant self-service UI, public API key creation UI, public billing admin UI, or organization-management UI.
- No managed production hosting platform.
- No hosted or connected-node real-tool execution.
- No hosted browser automation.
- No arbitrary process execution, generic process runtime, hosted subprocess execution, hosted PTY execution, public `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` execution APIs.
- No Cursor, OpenClaw, or Paperclip adapter work.
- No runtime-specific approval bridge expansion.
- No hosted post-start input bridge.
- No OAuth, OIDC, SAML, SSO, SCIM, passkeys, session cookies, user passwords, email invites, or browser login flow.
- No row-level security policy migration that assumes a specific managed Postgres provider. R18 can add tenant-aware SQL queries and indexes; database-native RLS can be a later hardening phase.
- No automatic adoption of existing unowned hosted/server data into a production tenant. Staging/production must fail readiness when unowned resources exist unless an operator runs an explicit migration outside R18 scope.
- No required live provider spend or external payment/network calls in tests.

## Existing Context

R18 starts after R17. `PROJECT.md` records that enterprise controls are still unshipped:

```md
The shipped boundary remains explicit: R17 does not ship hosted or connected-node real tools, browser automation, generic process/PTY runtimes, arbitrary shell/exec/pty/terminal/sandbox routes, Cursor/OpenClaw/Paperclip, runtime-specific approval bridges for OpenCode/AgentField/Generic HTTP/hosted Codex, managed production hosted platform, enterprise auth/billing/tenant controls, dashboard, or TUI.
```

The current contracts have only a small user shape and an `org_` id prefix. R18 should extend this rather than inventing a second identity namespace.

`packages/contracts/src/user.ts`:

```ts
export const userSchema = z.object({
  id: userIdSchema,
  organizationId: organizationIdSchema.optional(),
  displayName: z.string().min(1),
  createdAt: isoDateSchema
});
```

`packages/contracts/src/ids.ts`:

```ts
export const userIdSchema = idSchema("user");
export const organizationIdSchema = idSchema("org");
```

Hosted server config already has deployment modes and fail-closed staging/production checks for Postgres, Redis, object store, node token, and hosted runtime allowlists. R18 must add auth/control-plane checks to the same pattern.

`apps/server/src/config.ts`:

```ts
export type DeploymentMode = "local" | "test" | "staging" | "production";

if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
  requireVar(config.postgresUrl, "SWITCHYARD_POSTGRES_URL", config);
  requireVar(config.redisUrl, "SWITCHYARD_REDIS_URL", config);
  requireVar(config.nodeSharedToken, "SWITCHYARD_NODE_SHARED_TOKEN", config);
  requireVar(hostedRuntimeAllowlistEnv, "SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST", config);
}
```

The hosted server registers run, artifact, registry, node, health, ready, and metrics routes. It does not currently install any tenant/auth hook around them.

`apps/server/src/app.ts`:

```ts
app.get("/health", async () => ({ ok: true }));
app.get("/ready", async (_request, reply) => {
  const ready = await probeServerReadiness({ config, postgres, queue, artifactContent });
  if (!ready.ok) {
    metrics.inc("dependencies.notReady");
    return reply.code(503).send(ready);
  }
  metrics.inc("dependencies.ready");
  return ready;
});
app.get("/metrics", async () => {
  try {
    await metrics.captureQueue(queue);
    return metrics.toJSON();
  } catch {
    metrics.inc("errors.metricsCollection");
    metrics.markComponentUnavailable("queue");
    return metrics.toJSON();
  }
});
```

The current run route accepts public run creation and stores runs without tenant ownership. R18 must set ownership from the authenticated request context, not from client-supplied body fields.

`packages/protocol-rest/src/run-routes.ts`:

```ts
const createInput: Parameters<RunService["createRun"]>[0] = {
  runtime: body.runtime,
  provider: body.provider,
  model: body.model,
  adapterType: body.adapterType,
  cwd: body.cwd,
  task: renderedContext ? renderRunTask(body.task, renderedContext.rendered) : body.task,
  placement: body.placement ?? "local",
  approvalPolicy: body.approvalPolicy ?? "default",
  timeoutSeconds: body.timeoutSeconds ?? 600,
  metadata: renderedContext
    ? {
      ...metadata,
      originalTask: body.task,
      contextPacket: renderedContext.context
    }
    : metadata
};
```

Current public error envelopes are request-id aware. R18 must extend this enum instead of returning ad hoc auth errors.

`packages/protocol-rest/src/http-errors.ts`:

```ts
export type HttpErrorCode =
  | "run_not_found"
  | "debate_not_found"
  | "artifact_not_found"
  | "missing_artifact_content"
  | "provider_not_found"
  | "runtime_not_found"
  | "runtime_mode_not_found"
  | "model_not_found"
  | "message_not_found"
  | "memory_not_found"
  | "evidence_not_found"
  | "approval_not_found"
  | "tool_invocation_not_found"
```

Postgres stores already support in-memory fallback when no handle is supplied. R18 control-plane stores should follow this pattern for deterministic tests and local/test operation.

`packages/storage/src/postgres/run-store.ts`:

```ts
export class PostgresRunStore implements RunStore {
  private readonly items = new Map<string, Run>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  async create(run: Run): Promise<Run> {
    if (this.handle) {
      await this.upsert(run);
      return run;
    }
    this.items.set(run.id, run);
    return run;
  }
```

The existing Postgres schema has no tenant/account/project columns yet.

`packages/storage/src/postgres/schema.ts`:

```ts
export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  runtime: text("runtime").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  adapterType: text("adapter_type").notNull(),
  cwd: text("cwd").notNull(),
  task: text("task").notNull(),
  status: text("status").notNull(),
  placement: text("placement").notNull(),
  approvalPolicy: text("approval_policy").notNull(),
  timeoutSeconds: integer("timeout_seconds").notNull(),
  metadata: jsonb("metadata").notNull(),
  runtimeMode: text("runtime_mode"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  endedAt: text("ended_at")
}, (table) => [index("runs_created_idx").on(table.createdAt, table.id)]);
```

The local daemon route inventory and OpenAPI title are explicitly local. R18 must not silently make local daemon auth mandatory or convert the local-daemon OpenAPI into a hosted-server contract.

`packages/contracts/src/openapi.ts`:

```ts
const document: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Switchyard Local Daemon API",
    version: "0.0.0"
  },
  servers: [{ url: "http://127.0.0.1:4545" }],
  paths,
  components: {
    schemas: components
  }
};
```

Existing redaction helpers already cover key/token/password/secret patterns. R18 must reuse or extend them, not create a weaker auth-specific redactor.

`packages/core/src/services/local-policy-gate.ts`:

```ts
const SECRET_KEY_PATTERN = /(token|apikey|authorization|password|secret|credential|cookie|privatekey|accesskey|refreshtoken|idtoken|signature|sig)/i;

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry)) as T;
  }
  if (typeof value === "string") {
    return redactSignedUrl(value) as T;
  }
```

The node protocol already has a token hook but the token is global. R18 must not leave connected-node data globally readable in staging/production.

`packages/protocol-node/src/node-routes.ts`:

```ts
app.addHook("preHandler", async (request, reply) => {
  if (!request.url.startsWith("/nodes")) return;
  const token = request.headers["x-switchyard-node-token"];
  if (deps.requireAuth && !deps.sharedToken) {
    return sendHttpError(reply, "node_auth_required", "Node token is required");
  }
  if (!deps.sharedToken) return;
  if (typeof token !== "string" || !tokenMatches(token, deps.sharedToken)) {
    return sendHttpError(reply, "node_auth_failed", "Node token is invalid");
  }
});
```

## Architecture

R18 adds a hosted/server control-plane layer with four parts:

1. Contracts in `@switchyard/contracts` for identity, API keys, plans, entitlements, quotas, ownership, auth context, and audit events.
2. Core ports/services in `@switchyard/core` for API key verification, auth context creation, tenant/project authorization, entitlement decisions, quota reservations, and audit logging.
3. Storage adapters in `@switchyard/storage` for deterministic in-memory operation and Postgres-backed control-plane state.
4. Hosted server wiring in `apps/server` and `@switchyard/protocol-rest`/`@switchyard/protocol-node` that installs auth/tenant middleware before protected routes and uses scoped stores/services for reads and writes.

The local daemon remains unchanged by default:

```text
local daemon default
  -> no API key required
  -> no tenant required
  -> existing SQLite/in-memory routes continue to pass old tests
  -> optional daemon auth only if explicitly configured by operator
```

Hosted/server request flow:

```text
HTTP request
  -> request id header set
  -> public route bypass only for GET /health and GET /ready
  -> parse API key from Authorization: Bearer <key> or x-switchyard-api-key
  -> reject missing, malformed, conflicting, revoked, expired, or inactive key
  -> hash raw key with configured pepper and timing-safe compare
  -> load Account + Tenant + Project + User + BillingPlan + EntitlementSnapshot
  -> create AuthContext on request
  -> route validation rejects client-supplied owner overrides
  -> authorization checks scope + tenant/project ownership
  -> entitlement/quota preflight reserves capacity before side effects
  -> service writes tenant-owned resource rows
  -> audit log records decision with redacted payload
  -> response includes normal resource envelope, never raw auth/billing secrets
```

### Identity Contracts

R18 must add explicit id schemas:

- `accountIdSchema`: `account_...`
- `tenantIdSchema`: `tenant_...`
- `projectIdSchema`: `project_...`
- `apiKeyIdSchema`: `api_key_...`
- `billingPlanIdSchema`: `billing_plan_...`
- `quotaReservationIdSchema`: `quota_reservation_...`
- `auditLogEventIdSchema`: `audit_...`

`organizationIdSchema` may remain for backwards compatibility, but new enterprise contracts should use `tenantId` and `accountId`. If `organizationId` remains on `userSchema`, R18 should mark it as legacy alias in comments/tests and add `tenantId`/`accountId` optional fields without removing the old field.

Required shapes:

```ts
Account {
  id: account_...
  name: string
  status: "active" | "suspended" | "deleted"
  billingPlanId: billing_plan_...
  createdAt: ISO
  updatedAt?: ISO
}

Tenant {
  id: tenant_...
  accountId: account_...
  slug: lowercase slug
  displayName: string
  status: "active" | "suspended" | "deleted"
  createdAt: ISO
  updatedAt?: ISO
}

Project {
  id: project_...
  accountId: account_...
  tenantId: tenant_...
  slug: lowercase slug
  displayName: string
  status: "active" | "archived" | "deleted"
  createdAt: ISO
  updatedAt?: ISO
}

User {
  id: user_...
  accountId?: account_...
  tenantId?: tenant_...
  organizationId?: org_... // legacy compatibility
  displayName: string
  email?: string
  status?: "active" | "suspended" | "deleted"
  createdAt: ISO
  updatedAt?: ISO
}
```

### API Key Contracts

API keys are server credentials, not browser sessions.

Required `ApiKey` fields:

- `id`
- `accountId`
- `tenantId`
- `projectId`
- `userId`
- `name`
- `keyPrefix`: first safe display segment only, for audit/debug.
- `secretHash`: never returned by public APIs.
- `scopes`: string array.
- `status`: `active | revoked | expired`
- `expiresAt?`
- `lastUsedAt?`
- `createdAt`
- `revokedAt?`

Accepted request headers:

- `Authorization: Bearer <api-key>`
- `x-switchyard-api-key: <api-key>`

Rules:

- If both headers are present and differ, deny with `401 auth_conflict`.
- Query-string keys are never accepted. `?api_key=...`, `?token=...`, and `?authorization=...` must be denied or ignored and must be redacted from logs/errors.
- Raw API keys must never be persisted. Stores persist only `secretHash`, `keyPrefix`, and metadata.
- Hash raw keys using a configured pepper. Staging/production require a non-empty `SWITCHYARD_API_KEY_PEPPER`.
- Comparisons must use timing-safe comparison.
- Bootstrap loading may accept raw key material from env/file, but it must hash immediately, never log raw values, and never write raw values to Postgres, audit logs, errors, or metrics.
- Revoked, expired, deleted, suspended-account, suspended-tenant, archived-project, or deleted-user credentials deny before route side effects.

Required scopes for R18:

- `runs:write`: create/cancel/input hosted/server runs.
- `runs:read`: read/list runs, run events, and run artifacts.
- `artifacts:read`: read artifact metadata/content.
- `registry:read`: read providers/runtimes/models/runtime modes/doctor.
- `nodes:write`: register/heartbeat/claim/sync/complete connected-node assignments for a scoped project.
- `metrics:read`: read `/metrics`.
- `audit:read`: read `/audit/events`.
- `entitlements:read`: read `/entitlements`.
- `admin:read`: read `/auth/whoami` with administrative account/tenant data. `GET /auth/whoami` may also work with any valid key but should omit admin-only internals unless this scope is present.

### Ownership Contracts

Every hosted/server resource created after R18 must have:

- `accountId`
- `tenantId`
- `projectId`
- `createdByUserId` when there is a user actor.
- `apiKeyId` or `actorType` when the actor is a node/internal worker.

Resources in scope:

- `runs`
- `run_events`
- `artifacts`
- `placement_decisions`
- `nodes`
- `assignments`
- `audit_log_events`
- quota usage/reservations

Implementation may expose ownership as optional fields on public contracts for backwards compatibility, or keep public run/artifact/event shapes unchanged and store ownership in side tables. Either way, server route enforcement must use a durable ownership source, not trust `metadata`.

Staging/production behavior:

- Creating a resource without ownership is a bug and must fail before persistence.
- Reading/listing a resource without a matching auth context must return `404 run_not_found`/`404 artifact_not_found` where possible to avoid leaking ids, or `403 tenant_access_denied` for explicit cross-tenant list/filter attempts.
- Existing unowned rows make `/ready` fail with `unowned_resources_present` in staging/production.

Local/test behavior:

- Existing unowned resources remain readable when auth is disabled.
- Local daemon SQLite data must not require tenant fields.
- Tests may use deterministic tenant/project fixtures.

### Billing Plan, Entitlement, And Quota Contracts

R18 does not collect money. "Billing" means a durable plan and entitlement contract that future payment integration can update.

Required plan fields:

- `id`
- `slug`: examples `local_dev`, `team_staging`, `enterprise_standard`.
- `displayName`
- `status`: `active | archived`
- `entitlements`
- `quotas`
- `createdAt`
- `updatedAt?`

Required entitlements:

- allowed placements: `local`, `hosted`, `connected_local_node`
- allowed runtime modes
- hosted real runtime execution allowed: boolean
- connected nodes allowed: boolean
- artifact content reads allowed: boolean
- metrics read allowed: boolean
- audit read allowed: boolean

Required quotas:

- `maxRunsPerHour`
- `maxActiveRuns`
- `maxRunTimeoutSeconds`
- `maxConnectedNodes`
- `maxArtifactContentReadBytesPerHour`

Required enforcement:

- `POST /runs` must check allowed placement/runtime mode, max timeout, active-run count, and hourly run quota before `runs.create`, `placement_decisions.create`, or queue enqueue.
- Connected-node register/heartbeat/claim flows must check the node belongs to the request tenant/project and enforce max connected nodes before registration side effects.
- Artifact content reads must verify `artifacts:read`, tenant/project ownership, entitlement, and byte quota before returning content.
- Quota denial must return `429 quota_exceeded` with a safe reason code such as `runs_per_hour_exceeded`, `active_runs_exceeded`, `artifact_read_bytes_exceeded`, or `connected_nodes_exceeded`.
- Entitlement denial must return `403 entitlement_denied` with a safe reason code such as `placement_not_entitled`, `runtime_mode_not_entitled`, `hosted_real_runtime_not_entitled`, `node_not_entitled`, or `metrics_not_entitled`.
- A missing or inactive plan in staging/production must fail closed with `403 entitlement_denied` and audit `entitlement.denied`, not fall back to unlimited access.

Quota reservation behavior:

- Quota checks that can race must create a short-lived reservation before side effects.
- If downstream run creation or queue enqueue fails, release the reservation or mark it failed.
- If the process dies after reservation but before terminal update, a startup reconciliation or next check must expire stale reservations.
- Deterministic tests may use an in-memory quota clock.

### Audit Logs

R18 must add append-only audit events. These are separate from `run_events`; they are control-plane/security events, not runtime transcript events.

Required fields:

- `id`
- `accountId`
- `tenantId`
- `projectId?`
- `actorType`: `api_key | node_token | system`
- `actorUserId?`
- `apiKeyId?`
- `eventType`
- `resourceType?`
- `resourceId?`
- `decision`: `allow | deny | error`
- `reasonCode?`
- `ipHash?`
- `userAgent?`
- `requestId?`
- `payload`: redacted record
- `createdAt`

Minimum event types:

- `api_key.auth_failed`
- `api_key.auth_succeeded` for `GET /auth/whoami` and first use after process start; high-volume per-request success logging is optional.
- `tenant.access_denied`
- `run.create_allowed`
- `run.create_denied`
- `quota.denied`
- `entitlement.denied`
- `artifact.read_allowed`
- `artifact.read_denied`
- `node.auth_failed`
- `node.register_allowed`
- `node.register_denied`
- `config.fail_closed`
- `api_key.revoked` if a store method supports revocation in tests/internal code.

Audit storage rules:

- Never store raw API keys, raw node tokens, bearer headers, secret hashes, provider tokens, object-store credentials, or raw authorization headers.
- `ipHash` may be deterministic HMAC with a configured server secret. If no secret is configured in local/test, omit `ipHash` rather than storing raw IP addresses.
- Audit reads require `audit:read` and are always scoped to the caller's tenant/project unless `admin:read` plus account-wide scope is present.

### REST And OpenAPI Boundary

R18 must add server-hosted API contract truth. Acceptable implementation shapes:

- Add a second route inventory/document generator for hosted server, or
- Extend the current generator to accept a `surface` option while keeping local-daemon output stable.

Required routes in hosted/server OpenAPI:

- `GET /auth/whoami`: returns authenticated account/tenant/project/user/apiKey scopes and plan summary.
- `GET /entitlements`: returns current entitlement snapshot and safe quota usage for the authenticated tenant/project.
- `GET /audit/events`: returns tenant-scoped audit events with cursor pagination.

Protected hosted/server routes must include an OpenAPI security scheme:

```json
{
  "components": {
    "securitySchemes": {
      "SwitchyardApiKey": {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "Switchyard API key"
      }
    }
  }
}
```

`GET /health` and `GET /ready` may remain public for load balancers, but their response bodies must be redacted and low-cardinality. `/metrics` must require `metrics:read` in staging/production.

Forbidden public routes remain forbidden:

- `/tenant/signup`
- `/billing/checkout`
- `/billing/webhook`
- `/payments/*`
- `/dashboard/*`
- `/tui/*`
- `/exec`
- `/shell`
- `/process`
- `/command`
- `/pty`
- `/terminal`
- `/sandbox`

### Server Config

R18 adds these config concepts:

- `SWITCHYARD_SERVER_AUTH_MODE`: `disabled | api_key`.
- `SWITCHYARD_API_KEY_PEPPER`: required for `api_key` in staging/production.
- `SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH` or equivalent env JSON for deterministic bootstrap records.
- `SWITCHYARD_CONTROL_PLANE_STORE`: `memory | postgres`, with memory allowed only in local/test.
- `SWITCHYARD_AUDIT_IP_HASH_PEPPER`: optional in local/test, required in staging/production if IP hashes are recorded.
- `SWITCHYARD_PUBLIC_METRICS`: default false in staging/production.

Fail-closed rules:

- Staging/production must reject `SWITCHYARD_SERVER_AUTH_MODE=disabled`.
- Staging/production must reject missing API key pepper.
- Staging/production must reject memory control-plane store.
- Staging/production must reject zero active API keys, zero active tenants, zero active projects, or missing active billing plan.
- Staging/production must reject unowned hosted resources.
- Config error summaries must redact raw bootstrap secrets, pepper values, hashes, bearer tokens, node tokens, object-store secrets, and provider credentials.

### Local Daemon Compatibility

Required default behavior:

- Existing local daemon smoke tests continue to create/list/read fake runs without auth headers.
- Existing local daemon OpenAPI remains titled "Switchyard Local Daemon API" and does not require `SwitchyardApiKey` globally.
- Existing SDK/CLI local flows continue to work against `127.0.0.1:4545` without credentials.
- SQLite migrations remain additive and do not require tenant/account/project columns to be non-null for local daemon tables.

Optional behavior:

- If an implementer adds explicit local-daemon auth config, it must be disabled by default and must have tests for both default no-auth and explicit auth-required behavior.
- Optional local-daemon auth must not be used to satisfy hosted/server staging/production fail-closed requirements.

## User-Visible Behavior

Scenario: hosted server in staging without auth config.

- Operator starts `apps/server` with `SWITCHYARD_DEPLOYMENT_MODE=staging` and no API key pepper/bootstrap.
- Server startup fails or `/ready` returns 503 before accepting protected work.
- Logs include `config_required:SWITCHYARD_API_KEY_PEPPER` or `control_plane_bootstrap_missing` and a redacted config summary.
- No raw env values appear in logs.

Scenario: authenticated hosted run creation.

- Client calls `POST /runs` with `Authorization: Bearer sk_sw_test_alpha`.
- Server resolves account/tenant/project/user from the API key.
- Server checks `runs:write`, placement/runtime entitlement, max timeout, active runs, and hourly quota.
- Server creates a run owned by that tenant/project, appends `run.queued`, writes `run.create_allowed` audit event, and returns the normal `202 { run }` envelope.
- Response never includes the raw API key or secret hash.

Scenario: missing API key.

- Client calls `POST /runs` on hosted server in staging/production without credentials.
- Server returns `401 auth_required` before body-driven side effects.
- Audit records `api_key.auth_failed` with `decision: "deny"` and `reasonCode: "auth_required"` if enough tenant context can be inferred; otherwise it records a system/global redacted event.
- No run, placement decision, queue job, event, artifact, or quota reservation is created.

Scenario: cross-tenant run read.

- Tenant A creates `run_A`.
- Tenant B calls `GET /runs/run_A` with a valid API key.
- Server returns `404 run_not_found` or `403 tenant_access_denied` according to the route's leak policy, logs a low-cardinality authz metric, and appends `tenant.access_denied`.
- Tenant B cannot read run events, artifacts, artifact content, placement decisions, or assignment data for `run_A`.

Scenario: quota denial.

- Tenant A is on a plan with `maxRunsPerHour: 1`.
- Tenant A creates one run successfully.
- Tenant A immediately creates another run.
- Server returns `429 quota_exceeded` with detail `runs_per_hour_exceeded`.
- No second run row, event, placement decision, queue job, or assignment is created.
- Audit records `quota.denied`.

Scenario: local daemon compatibility.

- Developer starts the daemon with default config and calls existing SDK/CLI local fake run flows without an auth header.
- Requests succeed as before.
- No tenant/bootstrap file is required.
- Local daemon docs and OpenAPI do not claim production tenant isolation unless explicit auth config is enabled.

## Data Flows And Shadow Paths

| Flow | Happy path | Nil path | Empty path | Error path |
| --- | --- | --- | --- | --- |
| API key auth | Valid bearer key hashes to active key; request gains `AuthContext`; protected route continues. | Missing auth header on protected hosted route returns `401 auth_required`; no route side effects. | Empty bearer value or blank `x-switchyard-api-key` returns `401 auth_failed` with redacted audit. | Store unavailable returns `503 auth_store_unavailable` or startup/readiness fail; invalid/revoked/expired key returns `401 auth_failed`; raw key never appears. |
| Tenant-scoped run create | Auth context supplies owner; entitlement/quota pass; run/event/placement/queue rows include ownership. | Auth context missing cannot reach run create in hosted server; returns `401 auth_required`. | Body tries empty `tenantId`, `projectId`, or owner override; route rejects with `400 invalid_input` or ignores owner fields and uses auth context. | Quota/entitlement/store failure denies before side effects; queue failure releases reservation and marks run failed only if run was already created by an existing hosted path. |
| Tenant-scoped run read/list | Caller sees only runs owned by caller tenant/project. | Missing auth on hosted list returns `401 auth_required`. | Empty list for tenant returns `200 { runs: [], nextCursor: null }`, not global data. | Cross-tenant id returns `404 run_not_found` or `403 tenant_access_denied`; audit records denial. |
| Run events/SSE | Caller with `runs:read` streams/replays only owned run events. | Missing auth returns `401 auth_required` before opening SSE. | Owned run with no events returns bounded empty replay/stream behavior already used by SSE helpers. | Cross-tenant or deleted run returns safe denial; auth store failure closes with structured error before streaming. |
| Artifact metadata/content | Caller with `artifacts:read` and quota sees owned artifact metadata/content. | Missing auth returns `401 auth_required`. | Owned run with no artifacts returns `200 { artifacts: [] }`; missing content returns existing `missing_artifact_content`. | Cross-tenant artifact id returns `404 artifact_not_found`/`403 tenant_access_denied`; object store errors remain existing safe 503/409 codes; byte quota returns `429 quota_exceeded`. |
| Entitlement/quota lookup | Plan exists; service returns snapshot and usage; preflight enforces limits before side effects. | Missing plan in staging/production denies with `entitlement_denied` and readiness fails. | Plan with empty runtime/placement lists denies all hosted work with named reason. | Quota store unavailable fails closed; no unlimited fallback in staging/production. |
| Connected-node auth | Node token/API key maps to tenant/project; node routes write scoped node/assignment data. | Missing token in staging/production returns `401 node_auth_required`. | Empty token returns `401 node_auth_failed`. | Token not mapped to tenant/project or node quota exceeded denies before node registration/claim side effects. |
| Audit logging | Security action appends redacted audit event and route returns normal result. | No tenant context for failed unauthenticated request records system/global redacted event or increments audit failure metric. | Audit payload redacts to empty/safe object if all fields are sensitive. | Audit store failure must not leak secrets; for allow decisions it increments `audit.failures` and returns route result only if product behavior requires availability, but for deny decisions it must still return the denial. Staging/production readiness fails if audit store is unavailable. |
| Bootstrap config | Bootstrap records produce active account/tenant/project/user/key/plan. | Missing bootstrap/existing records in staging/production fails startup/readiness. | Empty bootstrap file fails with `control_plane_bootstrap_empty`. | Malformed JSON, duplicate ids, inactive plan, raw-secret persistence attempt, or missing pepper fails closed with redacted diagnostics. |

## Constraints

- Backwards compatibility: local daemon default no-auth behavior is mandatory.
- Security: all hosted/server protected routes must deny by default in staging/production.
- Isolation: tenant/project ownership must be enforced in store queries or durable scoped wrappers, not by filtering only after an unscoped fetch has leaked existence.
- Side effects: auth, entitlement, quota, and ownership checks happen before run creation, queue enqueue, assignment creation, artifact content read, or metrics/audit disclosure.
- Storage: in-memory stores are allowed for deterministic tests and local/test server mode; staging/production must use Postgres-capable stores.
- Migrations: Postgres schema additions are additive. Existing data is not silently assigned to a tenant in staging/production.
- OpenAPI: local daemon OpenAPI remains stable and unauthenticated by default; hosted/server OpenAPI documents auth security requirements and new enterprise routes.
- Logs/errors: no raw API key, node token, key hash, pepper, provider secret, object-store secret, signed URL secret query param, authorization header, cookie, or password may appear in public error envelopes, audit payloads, readiness, metrics, or app logs.
- Metrics: use low-cardinality counters only. Do not label metrics with tenant slug, account name, project slug, user email, API key prefix, run id, artifact id, or raw reason message.
- Tests: required checks must be no-spend and deterministic.

## Error Codes

R18 must extend shared HTTP error contracts with:

- `auth_required` -> 401
- `auth_failed` -> 401
- `auth_conflict` -> 401
- `auth_store_unavailable` -> 503
- `tenant_access_denied` -> 403
- `project_access_denied` -> 403
- `entitlement_denied` -> 403
- `quota_exceeded` -> 429
- `audit_log_unavailable` -> 503 if used as a blocking startup/readiness failure

Error details must use safe reason codes, not secret-bearing messages.

## Observability

Add low-cardinality hosted metrics:

- `auth.required`
- `auth.failed`
- `auth.succeeded`
- `auth.conflict`
- `tenant.denied`
- `entitlement.denied`
- `quota.denied`
- `quota.reserved`
- `quota.released`
- `audit.appended`
- `audit.failed`
- `controlPlane.ready`
- `controlPlane.notReady`

`/ready` must include redacted checks:

- `controlPlaneStore`
- `apiKeyAuth`
- `apiKeyPepper`
- `bootstrap`
- `billingPlan`
- `quotaStore`
- `auditStore`
- `unownedResources`

`/metrics` must require `metrics:read` in staging/production unless `SWITCHYARD_PUBLIC_METRICS=1` is explicitly set for non-production only. In production, public metrics must remain denied.

## Testing Requirements

Required no-spend checks:

- Contract tests for new identity/auth/billing/quota/audit schemas and error-code parity.
- OpenAPI tests proving hosted/server routes include security requirements and local-daemon OpenAPI remains backwards compatible.
- Server auth tests for missing, empty, malformed, conflicting, invalid, revoked, expired, inactive tenant, inactive project, and suspended account keys.
- Auth bypass denial tests for query-string keys, client-supplied `tenantId`/`projectId` overrides, and unauthenticated protected routes.
- Tenant isolation tests for runs, run lists, run events/SSE, run artifacts, artifact metadata/content, nodes, assignments, metrics, entitlements, and audit event reads.
- Quota denial tests for hourly run count, active runs, max timeout, connected nodes, and artifact read bytes.
- Entitlement denial tests for hosted placement, runtime mode, hosted real runtime gate, metrics read, audit read, and node registration.
- Audit redaction tests that seed obvious secrets and assert they do not appear in audit rows, error envelopes, logs captured by test logger, readiness, metrics, or OpenAPI examples.
- Fail-closed config tests for staging/production missing auth mode, pepper, bootstrap records, Postgres control-plane store, active plan, active API key, and unowned resources.
- Local daemon compatibility tests proving default daemon requests still work without auth and existing SDK/CLI fake run flows are not broken.
- Storage tests for in-memory and Postgres-capable stores, including list pagination and tenant-scoped lookups.
- No-spend assertions that required tests do not call payment providers, model providers, AWS/R2, live GitHub, external search, hosted browser, or arbitrary process/PTY.

Suggested commands for the implementation plan:

- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/protocol-rest test`
- `pnpm --filter @switchyard/protocol-node test`
- `pnpm --filter @switchyard/server test`
- `pnpm --filter @switchyard/daemon test`
- `pnpm typecheck`

## Acceptance Criteria

- [ ] `@switchyard/contracts` exports identity/auth/billing/quota/audit schemas and types with deterministic tests.
- [ ] Hosted/server API key auth accepts bearer or `x-switchyard-api-key`, rejects missing/empty/malformed/conflicting/query-string credentials, and never logs raw credentials.
- [ ] Staging/production server config fails closed when auth mode, pepper, bootstrap/control-plane records, active plan, active key, audit store, quota store, or tenant ownership checks are missing.
- [ ] Local daemon default behavior remains no-auth and all existing local daemon smoke/API flows continue to work without credentials.
- [ ] Hosted/server resource creation writes durable tenant/account/project/user ownership for runs, events, artifacts, placement decisions, nodes, assignments, quota records, and audit events.
- [ ] Tenant isolation tests prove one tenant cannot read/list/stream/mutate another tenant's runs, events, artifacts, nodes, assignments, metrics, entitlements, or audit logs.
- [ ] `POST /runs` enforces placement/runtime entitlements, max timeout, active-run quota, and hourly run quota before run/queue/assignment side effects.
- [ ] Connected-node routes preserve existing token behavior where allowed, but in staging/production the token/API key maps to tenant/project context and node quota is enforced.
- [ ] Artifact metadata/content reads enforce tenant/project ownership, `artifacts:read`, artifact-read entitlement, and artifact byte quota.
- [ ] `GET /auth/whoami`, `GET /entitlements`, and `GET /audit/events` exist for hosted/server APIs and are covered in OpenAPI.
- [ ] Hosted/server OpenAPI documents API key security for protected routes, while local-daemon OpenAPI remains backwards compatible and unauthenticated by default.
- [ ] Audit events are appended for auth failures, cross-tenant denials, entitlement denials, quota denials, allowed run creation, artifact access decisions, node auth/registration decisions, and fail-closed config decisions.
- [ ] Redaction tests prove raw API keys, node tokens, secret hashes, peppers, provider tokens, object-store credentials, authorization headers, cookies, and signed URL secret query params do not appear in logs, audit payloads, errors, readiness, metrics, or artifacts touched by R18.
- [ ] In-memory and Postgres-capable control-plane stores exist and follow existing store patterns.
- [ ] Required tests are deterministic and no-spend.
- [ ] Product/development docs update shipped truth: R18 ships API-first enterprise control-plane foundation only; it does not ship dashboard, TUI, payment provider integration, managed production hosting, hosted tools, public tenant self-service, browser automation, or arbitrary process/PTY.

## Phase

### Phase 17: R18 Enterprise Auth, Billing, And Tenant Controls

**Goal:** Ship an API-first enterprise control-plane foundation for hosted/server APIs while preserving local daemon no-auth defaults.

**Acceptance:**

- Add enterprise identity, API key, billing-plan, entitlement, quota, ownership, and audit contracts with deterministic contract tests.
- Add hosted/server API key auth and fail-closed staging/production config while keeping local daemon no-auth by default.
- Add in-memory and Postgres-capable control-plane stores plus tenant-scoped resource ownership for server-owned resources.
- Enforce tenant/project isolation on runs, events, artifacts, nodes, assignments, metrics, entitlements, and audit reads.
- Enforce plan entitlements and quotas before run creation, connected-node registration, and artifact content reads.
- Add redacted audit events for security-relevant decisions and tenant-scoped audit read APIs.
- Add hosted/server OpenAPI auth boundaries and preserve local-daemon OpenAPI compatibility.
- Add no-spend tests for auth bypass denial, tenant isolation, quota denial, redaction, fail-closed config, and local daemon compatibility.
- Update product/development truth to reflect the exact R18 shipped boundary.

**Non-goals (this phase):** dashboard, TUI, payment provider integration, managed production hosting, public tenant self-service UI, OAuth/OIDC/SAML/SSO/SCIM, hosted or connected-node real tools, browser automation, arbitrary process/PTY, public execution routes, Cursor/OpenClaw/Paperclip, runtime-specific approval bridge expansion.

**Complexity:** L

## Risks And Mitigations

- Risk: auth middleware breaks local daemon and SDK/CLI flows. Mitigation: local daemon auth remains disabled by default, local OpenAPI remains unchanged, and compatibility tests run explicitly.
- Risk: filtering after unscoped reads leaks resource existence. Mitigation: scoped store methods or durable ownership wrappers must perform tenant/project checks at lookup/list time.
- Risk: quota checks create partial side effects. Mitigation: quota reservations happen before side effects and are released/expired on failure.
- Risk: bootstrap secrets leak through config errors. Mitigation: reuse shared redaction, test all config summaries, and never persist raw keys.
- Risk: "billing" is mistaken for payments. Mitigation: product docs state R18 is plan/entitlement/quota only, with payment provider integration explicitly unshipped.
- Risk: audit logging failure blocks useful work or hides denials. Mitigation: readiness requires audit store availability in staging/production; runtime behavior records audit failures as metrics with safe errors.
- Risk: connected-node global token remains a cross-tenant hole. Mitigation: staging/production node auth maps token/API key to tenant/project and scopes node/assignment stores.

## Future Trajectory

R18 creates the boundary needed for future phases:

- Payment provider integration can update billing plans and quota limits without changing run/resource ownership.
- Managed production hosting can build on fail-closed auth/control-plane readiness.
- Public tenant self-service can add UI and key-management APIs after the storage/auth model is proven.
- Hosted tools and browser automation can be added after tenant quota/audit controls exist.
- OAuth/SSO/SCIM can map external identities into the R18 account/tenant/project/user contracts.
