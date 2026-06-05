# Phase 11 Spec: R12 Production Hosting Foundation

**Date:** 2026-05-30
**Run:** post-r11-remaining-20260530
**Branch:** `agent/phase-11-r12-production-hosting-foundation`
**Spec target:** `docs/superpowers/specs/2026-05-30-phase-11-r12-production-hosting-foundation.md`

## Problem

R10 proved the hosted-like and connected-node execution shape, but it is still a development slice: memory fallbacks are allowed, dependency health is shallow, worker polling has no production lifecycle, Redis queue recovery is not crash-safe enough, the object store path is local-only, and node protocol contracts are not in the generated contract surface. R11 packaged the local daemon, SDK, CLI, and contracts, but did not turn the hosted server/worker/node apps into a staging/self-hosted deployment unit.

R12 should make the existing hosted-safe fake runtime slice production-deployable enough for staging and self-hosted operators. It must harden the server/worker/node boundaries before Switchyard adds hosted real runtimes, network object stores, enterprise controls, hosted debate, or production adapters.

## Priority Rationale

Production hosting foundation is the next highest-priority gap because every major remaining hosted feature depends on trustworthy deployable boundaries:

- Hosted Codex/Claude/OpenCode and arbitrary subprocess/PTY execution need worker isolation, queue recovery, object persistence, dependency readiness, and fail-fast config before they can be safe.
- S3/R2 object storage, enterprise auth/billing/tenant controls, hosted debate, and model judging all require stable server/worker/node process contracts and observable operational states.
- Dashboard and TUI work would create surface area before the hosting substrate can be operated, so they remain explicitly out of scope.
- Broad new adapters would multiply failure modes before production hosting can name, expose, and recover from them.

## Goals

- Make `apps/server`, `apps/worker`, and `apps/node` runnable as staging/self-hosted services with validated configuration, graceful shutdown, readiness checks, and deterministic startup failure when required dependencies are absent.
- Preserve the R10 public run contract while hardening hosted fake execution through Postgres metadata, Redis queueing, and persistent local object artifact content.
- Keep hosted worker runtime execution restricted to `fake.deterministic` and prove forbidden real runtime imports remain absent from the worker.
- Make Redis queue behavior recover from worker crash/restart without losing or permanently orphaning hosted jobs.
- Make Postgres schema initialization and store use visible, idempotent, and readiness-checked for hosted server and worker processes.
- Make local object artifact storage production-honest for a shared persistent volume, including path validation, metadata preservation, restart persistence, and clear errors when content is unavailable.
- Harden connected-node protocol operation with required production token configuration, typed contracts for node endpoints, error-aware client behavior, and bounded request bodies.
- Provide self-hosted deployment artifacts and smoke checks that start server, worker, Postgres, Redis, and shared object storage, then complete a hosted fake run and a connected-node assignment without external model spend.
- Add logs and metrics for placement, queue, worker, object store, node heartbeat, assignment, readiness, and dependency failures.

## Non-Goals

- No arbitrary hosted subprocess execution.
- No hosted PTY execution.
- No hosted Codex, Claude Code, OpenCode, Generic HTTP, AgentField, Cursor, OpenClaw, Paperclip, browser, search, shell, fetch, GitHub, repo, generic process, or generic PTY adapters.
- No interactive Codex runtime promotion, Codex approval bridge, Codex session resume, or runtime-specific approval bridges.
- No hosted debate with real participant runtimes or model judging.
- No enterprise organizations, OAuth, SSO, RBAC, billing, quotas, tenant controls, or multi-tenant authorization beyond the existing node shared-token boundary.
- No dashboard, TUI, or broad visual monitoring surface.
- No S3/R2 network object store client wiring in R12. R12 may harden the object-store interface and local object-backed persistent volume behavior, but the real network client remains a separate roadmap item.
- No production sandbox design for executing untrusted code. R12 must not imply that hosted real code execution is safe.
- No remote API spend in required tests.

## Existing Context

R12 starts from the R11 branch head where the final product truth says the hosted-like slice exists but production hosting and S3/R2 remain unshipped.

`PROJECT.md` Phase 10 records the R11 closeout:

```md
R11 is now shipped on the phase branch. Switchyard adds the consumable local product surface on top of the audited daemon API: `@switchyard/sdk`, `@switchyard/cli`, contracts-owned OpenAPI 3.1 generation, no-spend adapter compatibility automation, local release packaging smoke, and operational hardening.
```

`PRODUCT.md` records the remaining hosted gaps:

```md
Production-grade hosted server deployment.
Production-grade hosted worker deployment.
S3/R2 network object storage backing. R10 ships memory and filesystem-backed object-compatible artifact stores.
```

The hosted server already wires the right components, but dependency-backed stores are optional and `/health` is shallow.

`apps/server/src/app.ts`:

```ts
const postgres = config.postgresUrl ? openPostgresDatabase(config.postgresUrl) : undefined;
if (postgres) {
  await ensurePostgresSchema(postgres);
  app.addHook("onClose", async () => {
    await postgres.close();
  });
}

const queue: RunQueuePort & { close?: () => Promise<void> } = config.redisUrl
  ? new BullMqRunQueue({ redisUrl: config.redisUrl, queueName: config.queueName ?? "switchyard-hosted-runs" })
  : new MemoryRunQueue();
```

`apps/server/src/app.ts`:

```ts
const artifactContent: ArtifactContentStore = config.objectStoreDir
  ? new LocalObjectArtifactContentStore(config.objectStoreDir)
  : new MemoryArtifactContentStore();

app.get("/health", async () => ({ ok: true }));
```

Current server config accepts optional Postgres, Redis, object directory, and node token. R12 must distinguish local development from staging/production so memory fallbacks cannot silently become production behavior.

`apps/server/src/config.ts`:

```ts
export interface ServerConfig {
  host: string;
  port: number;
  nodeSharedToken?: string;
  hostedRuntimeAllowlist: string[];
  postgresUrl?: string;
  redisUrl?: string;
  queueName?: string;
  objectStoreDir?: string;
}
```

The worker can process hosted fake runs, but the main loop has no signal handling, no configurable idle interval/concurrency, and no production readiness lifecycle.

`apps/worker/src/main.ts`:

```ts
const worker = createHostedWorker(loadWorkerConfig());

while (true) {
  const worked = await worker.tick();
  if (!worked) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
```

The worker service correctly revalidates durable run state and keeps hosted execution fake-only. R12 must preserve this boundary.

`packages/core/src/services/hosted-worker-service.ts`:

```ts
private validateDurableRun(run: Run): "hosted_runtime_not_allowed" | "hosted_run_state_invalid" | undefined {
  const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "timeout";
  if (terminal) {
    return "hosted_run_state_invalid";
  }
  if (run.placement !== "hosted") {
    return "hosted_run_state_invalid";
  }
  if (run.runtime !== "fake") {
    return "hosted_runtime_not_allowed";
  }
  if (run.runtimeMode !== "fake.deterministic") {
    return "hosted_runtime_not_allowed";
  }
  if (run.adapterType !== "process") {
    return "hosted_runtime_not_allowed";
  }
  if (!this.deps.hostedRuntimeAllowlist.includes("fake.deterministic")) {
    return "hosted_runtime_not_allowed";
  }
  return undefined;
}
```

Redis queue support exists, but the current implementation removes waiting jobs during claim and stores claimed state in a side hash. R12 must define recovery behavior for worker death after claim and before ack.

`packages/queue/src/bullmq-run-queue.ts`:

```ts
async claim(): Promise<RunQueueClaimedJob | undefined> {
  const waiting = await this.queue.getWaiting(0, 10);
  for (const job of waiting) {
    const data = job.data as BullMqJobData;
    await job.remove();
    const claimed: BullMqJobData = {
      ...data,
      attempts: data.attempts + 1
    };
    await this.connection.hset(this.claimedKey, job.id!, JSON.stringify(claimed));
    return {
      id: job.id!,
      payload: claimed.payload,
      attempts: claimed.attempts,
      maxAttempts: claimed.maxAttempts
    };
  }
  return undefined;
}
```

Postgres metadata storage exists and creates the R10 tables directly. R12 should keep this idempotent but add deployment readiness around it rather than creating a second hosted data model.

`packages/storage/src/postgres/database.ts`:

```ts
export function openPostgresDatabase(connectionString: string): PostgresDatabaseHandle {
  const pool = new Pool({ connectionString });
  const db = drizzle({ client: pool, schema });
  return {
    pool,
    db,
    real: true,
    close: async () => {
      await pool.end();
    }
  };
}
```

`packages/storage/src/postgres/database.ts`:

```sql
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  runtime text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  adapter_type text NOT NULL,
  cwd text NOT NULL,
  task text NOT NULL,
  status text NOT NULL,
  placement text NOT NULL,
  approval_policy text NOT NULL,
  timeout_seconds integer NOT NULL,
  metadata jsonb NOT NULL,
  runtime_mode text,
  created_at text NOT NULL,
  started_at text,
  ended_at text
);
```

The object artifact store already has an abstract S3/R2-shaped class, but it receives an injected client and no real network client is wired in the apps.

`packages/storage/src/object-artifact-content-store.ts`:

```ts
export interface ObjectArtifactContentStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  keyPrefix?: string;
}

interface ObjectClient {
  putObject(input: { bucket: string; key: string; body: Buffer; contentType: string }): Promise<void>;
  getObject(input: { bucket: string; key: string }): Promise<{ body: Buffer; contentType?: string }>;
}
```

The local object store already writes object-shaped metadata to a filesystem root. R12 should make this a supported self-hosted persistent-volume backend, not silently in-memory.

`packages/storage/src/local-object-artifact-content-store.ts`:

```ts
return {
  path: safePath,
  storageBackend: "object",
  objectKey,
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  contentType: options?.contentType ?? "application/octet-stream"
};
```

The connected node app already registers, heartbeats, claims, enforces local policy, syncs events/artifacts, and completes assignments. R12 should make this service operationally configurable and token-hardened, not add real runtime adapters.

`apps/node/src/app.ts`:

```ts
await client.heartbeat(nodeId, { capabilities: config.capabilities, policy: config.policy });
const claimed = await client.claim(nodeId);
const assignment = claimed.assignment;
const run = claimed.run;
if (!assignment) {
  return false;
}
if (!run) {
  await client.reject(nodeId, assignment.id, { reason: "assignment_missing_run" });
  return true;
}
```

`apps/node/src/config.ts`:

```ts
export interface NodeAppConfig {
  serverUrl: string;
  sharedToken?: string;
  nodeId?: string;
  capabilities: string[];
  policy: NodePolicy;
}
```

Node routes have a shared-token boundary, but R12 must require it outside local development, avoid leaking token values, and put these routes into the contract inventory.

`packages/protocol-node/src/node-routes.ts`:

```ts
app.addHook("preHandler", async (request, reply) => {
  if (!request.url.startsWith("/nodes")) return;
  if (!deps.sharedToken) return;
  const token = request.headers["x-switchyard-node-token"];
  if (token !== deps.sharedToken) {
    return sendHttpError(reply, "node_auth_failed", "Node token is invalid");
  }
});
```

Contracts currently describe only the local daemon endpoint surface and only `get`/`post` methods. R12 must extend this without breaking R11 local OpenAPI output.

`packages/contracts/src/endpoint-inventory.ts`:

```ts
export type RouteMethod = "get" | "post";

export type ResponseContentKind = "json" | "sse" | "binary" | "text";

export type EndpointSurface = "local_daemon";
```

The public run contract already has the placement enum R12 must preserve.

`packages/contracts/src/run.ts`:

```ts
export const executionPlacementSchema = z.enum(["local", "hosted", "connected_local_node"]);

export const runSchema = z.object({
  id: runIdSchema,
  runtime: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  adapterType: adapterTypeSchema,
  cwd: z.string().min(1),
  task: z.string().min(1),
  status: runStatusSchema,
  placement: executionPlacementSchema,
  approvalPolicy: z.string().min(1),
  timeoutSeconds: z.number().int().positive(),
  metadata: metadataSchema.default({}),
  runtimeMode: runtimeModeSlugSchema.optional(),
  createdAt: isoDateSchema,
  startedAt: isoDateSchema.optional(),
  endedAt: isoDateSchema.optional()
});
```

Current tests prove the happy local fake paths and optional live dependency checks, but they do not prove a full staging/self-hosted process deployment.

`apps/server/test/hosted-server.test.ts`:

```ts
const response = await app.inject({
  method: "POST",
  url: "/runs?wait=1",
  payload: {
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "hosted test",
    placement: "hosted"
  }
});
expect(response.statusCode).toBe(201);
expect(response.json().run.status).toBe("completed");
```

`packages/storage/test/postgres-storage.test.ts`:

```ts
const url = process.env["SWITCHYARD_TEST_POSTGRES_URL"];
if (!url) {
  expect("SKIPPED_SWITCHYARD_TEST_POSTGRES_URL_UNSET").toContain("SKIPPED");
  return;
}
```

## Architecture

R12 keeps the R10 component split and makes the boundaries operable. `apps/server` remains the hosted API gateway that owns REST/node routes, placement decisions, registry seeding, Postgres-backed metadata stores, Redis queue enqueueing, and artifact content reads. `apps/worker` remains the only hosted executor and continues to run only `fake.deterministic`; it consumes Redis jobs, revalidates durable run state, starts the existing `RunService`, writes events/artifacts through the shared stores, and reports named queue/run/object-store failures. `apps/node` remains a connected local node that polls the server, enforces local policy, and syncs events/artifacts for assignments.

`packages/queue` owns hosted job durability semantics. R12 should make the `RunQueuePort` behavior explicit for production: enqueue is idempotent per generated job id, claim creates a lease or uses BullMQ active job semantics, ack removes only successfully completed work, retry preserves attempts, stale claimed work can be reclaimed, and exhausted jobs remain inspectable by reason code. Memory queue behavior stays for tests and local development only.

`packages/storage` owns Postgres schema creation/readiness and artifact content backends. R12 should keep the existing Postgres table shapes and add readiness/probe helpers around them. For artifact content, R12 should support `LocalObjectArtifactContentStore` as the self-hosted persistent-volume backend and require an explicit shared directory outside local development. The existing `ObjectArtifactContentStore` remains an interface-level building block; no AWS SDK, S3, or R2 client is wired in this phase.

`packages/protocol-node` and `packages/contracts` must make the hosted/node contract explicit. Node endpoints should remain protected by `x-switchyard-node-token`, but token presence becomes mandatory in staging/production. The contracts package should add hosted/node endpoint inventory and schemas while preserving the R11 local daemon OpenAPI artifact and route drift tests.

## User-Visible Behavior

- A self-hosted operator can start Postgres, Redis, a shared artifact directory, `apps/server`, and `apps/worker`, then create a hosted fake run through `POST /runs` with `placement: "hosted"`. The run completes, events are replayable, artifact metadata is visible, and artifact content remains readable after server/worker restart.
- A connected-node operator can start `apps/node` with `SWITCHYARD_SERVER_URL`, a node token, capabilities, and a local policy. The node registers, heartbeats, claims eligible assignments, syncs events/artifacts, and completes or rejects assignments with named reasons.
- `/health` reports process liveness without dependency checks. `/ready` reports dependency readiness for Postgres, Redis, object storage, and node route configuration. `/metrics` reports counters/gauges useful for hosted operation without requiring a dashboard.
- If a staging/production service is missing required config, it fails at startup with a named config error and redacted environment summary. It must not silently fall back to memory stores.
- If Redis/Postgres/object storage is unavailable after startup, readiness fails and run/job failures are named in HTTP errors, events, logs, and metrics.
- If a hosted run requests any runtime other than `fake.deterministic`, the API returns a placement denial and no hosted unsafe work is queued.

## Data Flows And Shadow Paths

### Hosted Run Creation: REST Request -> Placement -> Queue -> Worker -> Run Result

- Happy path: valid hosted `fake.deterministic` request with Postgres, Redis, and object directory ready creates a `hosted` run, records a placement decision, enqueues one job, worker claims it, run reaches `completed`, `runtime.output` is replayable, and transcript content can be fetched.
- Nil path: missing request body, missing runtime fields, or missing production dependency config is rejected before side effects with `invalid_input` or `config_required`; no run, placement, queue job, or artifact is created.
- Empty path: empty hosted allowlist in staging/production rejects hosted run creation with `hosted_runtime_not_allowed`; empty queue makes the worker return idle and emit an idle metric without changing run state.
- Error path: Redis enqueue failure marks the just-created run `failed` with `queue_enqueue_failed`; worker start failure retries until `worker_retry_exhausted`; object write failure produces `object_store_write_failed`; Postgres write failure returns a named HTTP error and readiness flips false.

### Worker Queue Processing: Redis Job -> Durable Run Validation -> Execution -> Ack/Retry

- Happy path: claimed job references a non-terminal hosted `fake.deterministic` run, execution succeeds, queue ack removes the job, and no retry state remains.
- Nil path: claim returns no job, so the worker sleeps for configured idle interval and reports no-op work.
- Empty path: job payload has no `runtimeMode` or empty runtime mode and durable run lookup cannot prove `fake.deterministic`; worker fails the run/job with `hosted_runtime_not_allowed`.
- Error path: worker process dies after claim and before ack; lease recovery requeues the job or marks it failed after max attempts. Terminal/foreign-placement/stale jobs become `hosted_run_state_invalid` and remain visible in metrics/logs.

### Artifact Content: Runtime Artifact -> Local Object Store -> Metadata -> Read API

- Happy path: worker writes transcript bytes under the configured shared object directory, metadata records `storageBackend`, `objectKey`, `sizeBytes`, `sha256`, and `contentType`, and server reads content by artifact id after restart.
- Nil path: staging/production starts without `SWITCHYARD_OBJECT_STORE_DIR`, or with a path unavailable to server or worker, so startup fails with `object_store_dir_required` or readiness fails with `object_store_unavailable`.
- Empty path: zero-byte content is accepted only when the artifact manifest explicitly says `sizeBytes: 0`; otherwise transcript artifacts require non-empty content and fail with `artifact_content_empty`.
- Error path: path traversal, permission denied, digest mismatch, missing file, or read/write failure produces `artifact_sync_failed`, `artifact_digest_mismatch`, `artifact_content_not_found`, or `object_store_write_failed` instead of returning empty content.

### Connected Node: Register -> Heartbeat -> Claim -> Sync -> Complete

- Happy path: node sends a valid token, registers capabilities/policy, heartbeats before expiry, claims an assignment for an eligible runtime, syncs monotonic events, syncs artifact manifest/content within policy, and completes assignment.
- Nil path: missing token in staging/production fails with `node_auth_required` before route handling; missing run for an assignment makes the node reject with `assignment_missing_run`.
- Empty path: empty claim response returns `{ assignment: null, run: null }` and the node idles; empty event sync with a correct cursor is accepted with `appended: 0`; empty artifact manifest is accepted and records no content work.
- Error path: invalid token returns `node_auth_failed`; stale heartbeat expires the node and assignments; event sequence gap returns `event_sync_gap`; conflicting sequence returns `event_sync_conflict`; digest mismatch returns `artifact_digest_mismatch` and fails the assignment.

### Deployment Startup: Env -> Config -> Dependency Probes -> Service Ready

- Happy path: staging/self-hosted env includes deployment mode, Postgres URL, Redis URL, shared object directory, hosted allowlist, queue name, and node token where applicable. Server and worker start, run schema initialization idempotently, and readiness passes.
- Nil path: required env var missing in staging/production produces a startup error named `config_required:<name>`.
- Empty path: env var present but empty or whitespace is treated as missing; empty comma-separated lists are accepted only when that disables optional local features, not for `hostedRuntimeAllowlist` in production.
- Error path: dependency connection timeout, auth failure, schema init failure, unwritable artifact dir, or Redis command failure is reported in readiness and logs with redacted URLs/secrets.

## Constraints

- Hosted execution remains fake-only. The worker must not import or instantiate Codex, Claude Code, OpenCode, Generic HTTP, AgentField, ACP process, browser, shell, search, GitHub, fetch, repo, generic process, or PTY adapters.
- R12 must preserve R11 SDK/CLI/local OpenAPI compatibility for local daemon endpoints.
- R12 may add hosted/node contract inventory, but must not remove or rename existing local contract refs.
- Required tests must be deterministic and no-spend. Live Postgres/Redis checks remain opt-in through environment variables or the new self-hosted smoke harness.
- Production-like startup must fail closed. Memory store, memory queue, and memory artifact content fallback are allowed only in explicit local/test mode.
- Secrets and credentials must not appear in logs, metrics, errors, generated smoke output, or test snapshots.
- Health/readiness and metrics must be usable without a dashboard.
- Deployment artifacts must support self-hosted/staging operation, not claim cloud HA, autoscaling, multi-region, tenancy, or managed service integration.

## Acceptance Criteria

- [ ] `apps/server`, `apps/worker`, and `apps/node` have explicit deployment modes. In staging/production mode, missing Postgres/Redis/object-store/node-token requirements fail startup with named, redacted config errors.
- [ ] Server exposes liveness `/health`, dependency-aware `/ready`, and hosted metrics without weakening existing run, registry, artifact, or node routes.
- [ ] Worker has graceful shutdown on `SIGINT`/`SIGTERM`, configurable idle interval and concurrency, and deterministic stop behavior that does not leave in-process loops running in tests.
- [ ] Redis queue behavior is crash-recoverable: claimed-but-unacked jobs can be requeued or failed after a bounded lease/max-attempt policy, and failed/exhausted jobs remain inspectable by reason code.
- [ ] Postgres readiness uses real database probes, schema initialization remains idempotent, and hosted run/event/artifact/session/node/assignment data survives server and worker restart in integration smoke.
- [ ] Local object artifact content store is a supported self-hosted persistent-volume backend with path traversal protection, write/read probes, content metadata preservation, restart persistence, and named errors for missing/unreadable content.
- [ ] `ObjectArtifactContentStore` remains unwired to real S3/R2 network clients in R12; tests prove no AWS/R2 SDK dependency is required for the hosted smoke path.
- [ ] Hosted worker still runs only `fake.deterministic`; import-guard tests fail if Codex, Claude, OpenCode, Generic HTTP, AgentField, browser, shell, search, GitHub, fetch, repo, process, or PTY adapters are imported by `apps/worker`.
- [ ] Node protocol requires shared token outside local/test mode, uses constant-time comparison or equivalent token-hardening, returns `node_auth_required`/`node_auth_failed`, and never logs the token.
- [ ] `packages/contracts` includes hosted/node endpoint inventory and schemas for node registration, heartbeat, claim, reject, event sync, artifact manifest/content sync, and completion while preserving local daemon OpenAPI compatibility.
- [ ] `NodeClient` handles non-2xx HTTP errors through typed error envelopes instead of blindly returning `response.json()` success-shaped data.
- [ ] Request body limits are explicit for node artifact content sync and JSON node routes; oversize payloads fail with `payload_too_large` or `invalid_input` before storage side effects.
- [ ] Self-hosted deployment artifacts can start Postgres, Redis, shared object storage, server, worker, and optional node; a smoke check completes one hosted fake run and one connected-node assignment without external model spend.
- [ ] Restart smoke proves a completed hosted run's metadata, events, artifacts, and artifact content remain available after server/worker restart.
- [ ] Logs and metrics include named counters/events for placement decisions, placement denials, queue enqueue/claim/ack/retry/fail, worker attempts/exhaustion, object-store reads/writes/failures, node register/heartbeat/claim/sync/complete/reject, dependency readiness, and config failures.
- [ ] Existing R11 checks for SDK/CLI/local contract generation, local daemon behavior, adapter compatibility no-spend matrix, storage fixtures, and packaging smoke still pass or are intentionally updated only for additive contract surfaces.

## Phase

### Phase 11: R12 Production Hosting Foundation

**Goal:** Turn the existing R10 hosted-like fake-worker and connected-node slice into a staging/self-hosted deployment foundation while keeping hosted execution fake-only.

**Acceptance:**

- Production-mode server/worker/node config is validated, redacted, and fail-closed.
- Server/worker/node lifecycle has readiness, graceful shutdown, and deterministic smoke behavior.
- Redis queue claim/retry/ack behavior is crash-recoverable and observable.
- Postgres and local object persistent-volume storage are readiness-checked and survive restart smoke.
- Node protocol auth, typed client errors, bounded bodies, and endpoint contracts are hardened.
- Self-hosted deployment smoke completes hosted fake and connected-node flows with no external model spend.
- Forbidden hosted real runtime/tool imports remain absent.

**Non-goals for this phase:** arbitrary hosted subprocess/PTY execution, hosted Codex/Claude/OpenCode, S3/R2 network client wiring, real tools, enterprise auth/billing/tenant controls, hosted real-runtime debate/model judging, dashboard, and TUI.

**Complexity:** L

## Implementation Lanes For CTO Planning

1. **Config, lifecycle, readiness, and metrics:** add deployment-mode config validation, redacted config errors, `/ready`, hosted metrics, graceful shutdown, and worker/node loop controls.
2. **Queue durability:** update `packages/queue` and worker service semantics for lease/reclaim/retry/exhaustion with memory and Redis coverage.
3. **Postgres and object persistence:** add dependency probes, object-dir validation, persistent artifact restart smoke, and named object read/write errors without S3/R2 network wiring.
4. **Node protocol hardening and contracts:** require token outside local/test mode, harden `NodeClient`, extend contract inventory/openapi-compatible schema ownership for node routes, add body limits and drift tests.
5. **Self-hosted deployment smoke:** add container/compose or equivalent local staging harness plus no-spend smoke covering server, worker, Postgres, Redis, object volume, hosted fake run, and connected-node assignment.

## Future Roadmap After R12

1. **R13 S3/R2 Network Object Store Client Wiring:** wire the existing `ObjectArtifactContentStore` to a real S3-compatible client for AWS S3 and Cloudflare R2, with presigned/direct-download decisions kept explicit and tested separately from local object volume behavior.
2. **R14 Hosted Sandbox Substrate For Process/PTY:** design and ship sandbox boundaries, workspace isolation, resource limits, network policy, secret isolation, and audit logs before any hosted real runtime is allowed.
3. **R15 Hosted Real Runtime Execution:** enable hosted Codex, Claude Code, and OpenCode only after R14 sandboxing, with separate allowlists, runtime capability checks, transcript limits, and failure-mode parity with local runs.
4. **R16 Interactive Codex And Approval Bridges:** promote Codex beyond `codex.exec_json` into interactive/session-resume modes and add runtime-specific approval bridges for Codex, OpenCode, AgentField, and Generic HTTP.
5. **R17 Production Tool And Adapter Expansion:** add real shell/browser/search/GitHub/fetch/repo tools and Cursor/OpenClaw/Paperclip/browser/search/generic process/generic PTY adapters behind policy, approvals, and adapter-specific no-spend/live smoke gates.
6. **R18 Enterprise Auth, Billing, And Tenant Controls:** add organizations, users, SSO/OAuth, RBAC, audit logs, quotas, billing boundaries, and tenant-scoped storage/queue isolation once hosted runtime behavior is trustworthy.
7. **R19 Hosted Debate With Real Participants And Model Judging:** move Debate V1 from fake local participants to hosted/hybrid participant runtimes, real evidence/tool access, model judging, budgets, and audit artifacts.
8. **Dashboard/TUI Reconsideration:** dashboard and TUI stay out of scope until the hosted substrate and operator APIs are stable enough that a UI is a presentation layer, not a substitute for missing operations.

## Checks CTO Should Require

- `pnpm --filter @switchyard/server test`
- `pnpm --filter @switchyard/worker test`
- `pnpm --filter @switchyard/node test`
- `pnpm --filter @switchyard/queue test`
- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/protocol-node test`
- `pnpm --filter @switchyard/contracts test`
- `pnpm typecheck`
- No-spend self-hosted smoke that starts dependencies and completes hosted fake plus connected-node flows.
- Optional real dependency checks gated by `SWITCHYARD_TEST_POSTGRES_URL` and `SWITCHYARD_TEST_REDIS_URL`.
