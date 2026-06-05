# Phase 9: R10 Hosted And Hybrid Execution - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-9-r10-hosted-and-hybrid-execution.md`
**Spec commit:** `57a8c980641519cac927f38f9299a3ef5ab9c43f`
**Branch:** `agent/phase-9-r10-hosted-and-hybrid-execution`
**Worktree:** `/Users/vasuyadav/Downloads/Projects/switchyard/.worktrees/native-roadmap-20260529/phase-9-r10-hosted-and-hybrid-execution`
**Plan target:** `docs/superpowers/plans/2026-05-30-phase-9-r10-hosted-and-hybrid-execution.md`
**Complexity:** L

## Goal

Ship a safe hosted-like and hybrid execution slice that preserves the existing public run/artifact/event contract while adding hosted fake worker execution, connected local-node assignment, deterministic memory substitutes, and opt-in real Postgres/Redis/object-store integrations.

## Scope Challenge

1. Existing code already partially solves R10 through `RunService`, `RuntimeRunnerService`, `RunLauncherService`, `EventBus`, `RegistryService`, runtime manifests, run/event/artifact/session/registry/placement ports, SQLite stores, filesystem artifact content storage, local Fastify run/artifact routes, and fake deterministic runtime/testkit stores. R10 must extend these seams and must not create a second public run model or a hosted-only run response shape.
2. The minimum viable R10 is hosted server app, hosted worker app, local node app, Postgres metadata stores, queue port expansion plus BullMQ/memory implementations, object artifact content store plus memory substitute, placement policy, node registration/heartbeat/assignment/sync routes, local node policy enforcement, deterministic tests, and smoke docs. SDK/CLI/TUI/dashboard, enterprise auth, billing, hosted real subprocesses, hosted PTY, hosted Codex, hosted Claude, hosted OpenCode, browser/search/repo/shell/fetch/GitHub tools, model judging, and production sandbox design stay out of scope.
3. The phase necessarily touches more than eight files and introduces more than two new services because the R10 release surface crosses apps, storage, queueing, node protocol, placement, sync, and docs. This is a real complexity concern. It is kept as one task because the user requested one implementer/reviewer for this phase; splitting would force cross-worktree edits to shared contracts, run-route dependencies, stores, and app wiring.
4. Built-in and established project pieces to use: Zod schemas for contracts, Fastify route style plus `HttpProblem`/`sendHttpError`, existing run route response envelope, existing SSE formatter/streamer, existing `RuntimeRunnerService` for actual runtime execution, existing `RegistryService` runtime-mode inference, existing `RuntimeCapabilityService` manifest seeding, existing `redactSecrets`, Drizzle-style store mapping, existing `FilesystemArtifactContentStore.safePath` behavior, Vitest, and testkit in-memory stores. Use BullMQ for Redis-backed hosted jobs and `pg` with Drizzle/Postgres dialect for Postgres; do not build custom Redis or SQL clients.
5. Distribution check: R10 adds three workspace apps and two workspace packages, all covered by existing `apps/*` and `packages/*` workspace globs. Add package scripts for `build`, `typecheck`, `test`, and `dev` only. Do not add SDK/CLI package distribution or release packaging in this phase.

## Architecture

R10 keeps the run id as the single logical identity across local, hosted, and connected-node execution. `apps/daemon` remains local and SQLite/filesystem backed. `apps/server` is the hosted-like Fastify gateway: it wires the same public run/artifact/registry routes, Postgres metadata stores or deterministic memory substitutes, object artifact content, placement decisions, node coordination routes, and a queue launcher. `apps/worker` consumes hosted run jobs and executes only the hosted-safe deterministic fake runtime. `apps/node` connects outward to the hosted server, registers/heartbeats, claims assignments, enforces local policy, runs local adapters through the existing runtime runner, and syncs allowed events/artifacts back to the hosted server.

```text
POST /runs on apps/server
  -> validate body and infer runtimeMode
  -> PlacementService.decide(input)
       hosted fake?             -> create run + placement + enqueue hosted job
       connected node eligible? -> create run + placement + assignment
       unsafe or unavailable?   -> reject before run creation
  -> same public response shape as local daemon
```

Hosted worker execution is intentionally narrow. The worker constructs a `RuntimeRunnerService` with a map containing only `fake.deterministic`. It must not import or instantiate `CodexExecJsonAdapter`, `ClaudeCodeAdapter`, `OpenCodeAcpAdapter`, `GenericHttpAsyncRestAdapter`, `AgentFieldAsyncRestAdapter`, PTY, shell, browser, network search, repo, GitHub, or model-judging code paths. The fake adapter manifest is updated to mark hosted and connected-local-node support, but only for `fake.deterministic`.

```text
Redis/BullMQ or MemoryRunQueue
  -> HostedWorkerService.claim(job)
  -> RuntimeRunnerService.start(run)
       EventStore.append + EventBus.publish
       ArtifactStore.create
       ArtifactContentStore.writeText
  -> ack / retry / fail with named run.failed reason
```

Connected-node execution is hybrid by design. The hosted server records a durable node assignment before a node can claim it. A node is eligible only when it is online, heartbeat-fresh, advertises the runtime capability, and has a compatible policy summary. The local node then re-checks its full local policy after claim and before execution; the local node is the final trust boundary for workspace paths, local credentials, event sync, and artifact sync. Synced events preserve the hosted run id and are validated for monotonic sequence/idempotent retry. Synced artifacts are stored as normal artifact metadata and content objects after path, digest, size, and policy checks.

```text
apps/node
  -> POST /nodes/register
  -> heartbeat / claim loop
  -> LocalNodePolicyService.decide(run, policy)
       deny -> reject assignment, hosted run.failed node_policy_denied
       allow -> RuntimeRunnerService.start(run with hosted run id)
  -> event sync batches
  -> artifact manifest + content sync
  -> complete assignment
```

Postgres, Redis, and object storage are production-shaped but fake-first. Tests must pass using memory queue, memory object store, and memory/Postgres-substitute stores without external services. Real Postgres, Redis, and S3/R2-compatible tests are opt-in through the environment variables from the spec and must skip with a clear message when not configured.

## File Structure

- `packages/contracts/src/node.ts` - expands connected-node records with policy summary, heartbeat lease, version, and timestamps.
- `packages/contracts/src/assignment.ts` - adds durable node assignment schemas, statuses, claim payloads, sync payloads, and response shapes.
- `packages/contracts/src/placement.ts` - keeps the current placement decision shape and adds request/trace helper schemas for hosted placement.
- `packages/contracts/src/http-error.ts` - adds R10 named error codes to the closed envelope schema.
- `packages/contracts/src/registry.ts` - keeps all local-only runtime placement facts intact while allowing fake hosted and connected-node support.
- `packages/contracts/src/index.ts` - exports new assignment/node contract symbols.
- `packages/contracts/test/contracts.test.ts` - proves R10 node, assignment, placement, error-code, and fake manifest shapes parse.
- `packages/core/src/ports/queue.ts` - expands the fire-and-forget queue port into a bounded run-job queue contract with enqueue, claim/process, ack, fail, retry, cancel/discard, and inspect semantics.
- `packages/core/src/ports/artifact-content-store.ts` - defines the shared artifact content abstraction used by filesystem, memory, and object stores.
- `packages/core/src/ports/node-store.ts` - replaces the generic-only node store alias with methods for upsert, get, list, markOffline, and eligible-node queries.
- `packages/core/src/ports/node-assignment-store.ts` - defines durable assignment create, claim, update, complete, fail, cancel, expire, and query methods.
- `packages/core/src/services/placement-service.ts` - implements deterministic hosted/local-node placement decisions and denial traces.
- `packages/core/src/services/hosted-run-service.ts` - creates hosted/connected runs through the same `RunService` contract and coordinates placement side effects.
- `packages/core/src/services/hosted-worker-service.ts` - processes hosted queue jobs with the fake-only runtime runner and bounded retry/failure mapping.
- `packages/core/src/services/node-coordinator-service.ts` - owns node registration, heartbeat, stale detection, assignment creation/claim/reject/complete, and cancellation intent.
- `packages/core/src/services/local-node-policy-service.ts` - enforces deny-by-default local node policy and redacts policy traces.
- `packages/core/src/services/event-sync-service.ts` - validates assignment ownership, monotonic event sequences, idempotent retries, and event publication.
- `packages/core/src/services/artifact-sync-service.ts` - validates artifact manifests, safe paths, size/digest/content policy, object writes, and artifact events.
- `packages/core/src/index.ts` - exports the new ports/services.
- `packages/core/test/hosted-placement-service.test.ts` - placement allow/deny/selection coverage.
- `packages/core/test/hosted-worker-service.test.ts` - hosted worker success, retry, failure, cancellation, allowlist, and object-store failure coverage.
- `packages/core/test/node-coordinator-service.test.ts` - node registration, heartbeat, expiry, assignment, claim conflict, and offline behavior coverage.
- `packages/core/test/local-node-policy-service.test.ts` - allow/deny policy coverage with redaction assertions.
- `packages/core/test/sync-services.test.ts` - event and artifact sync validation coverage.
- `packages/storage/package.json` - adds Postgres and object-store dependencies only in storage.
- `packages/storage/src/postgres/database.ts` - opens Postgres connections and exposes a testable database wrapper.
- `packages/storage/src/postgres/schema.ts` - defines Postgres tables/indexes for runs, events, sessions, artifacts, registry, placement, nodes, and assignments.
- `packages/storage/src/postgres/run-store.ts` - Postgres `RunStore`.
- `packages/storage/src/postgres/event-store.ts` - Postgres `EventStore` with run/debate sequence listing.
- `packages/storage/src/postgres/session-store.ts` - Postgres `SessionStore`.
- `packages/storage/src/postgres/artifact-store.ts` - Postgres `ArtifactStore`.
- `packages/storage/src/postgres/registry-store.ts` - Postgres `RegistryStore`.
- `packages/storage/src/postgres/placement-store.ts` - Postgres `PlacementStore`.
- `packages/storage/src/postgres/node-store.ts` - Postgres connected-node store.
- `packages/storage/src/postgres/assignment-store.ts` - Postgres node assignment store.
- `packages/storage/src/object-artifact-content-store.ts` - S3/R2-compatible artifact content writer/reader.
- `packages/storage/src/memory-artifact-content-store.ts` - deterministic memory artifact content store with path/digest/size validation.
- `packages/storage/src/index.ts` - exports Postgres and object/memory content stores.
- `packages/storage/test/postgres-storage.test.ts` - shared storage contract coverage with real Postgres skipped unless configured.
- `packages/storage/test/artifact-content-store.test.ts` - memory and optional object-store content tests.
- `packages/storage/test/storage-package.test.ts` - package export checks for R10 stores.
- `packages/queue/package.json` - new queue package manifest.
- `packages/queue/tsconfig.json` - queue package TypeScript config.
- `packages/queue/src/index.ts` - exports queue implementations and types.
- `packages/queue/src/memory-run-queue.ts` - deterministic memory queue with retry/cancel/inspect support.
- `packages/queue/src/bullmq-run-queue.ts` - Redis/BullMQ implementation.
- `packages/queue/test/run-queue.test.ts` - memory queue and optional Redis/BullMQ contract tests.
- `packages/protocol-node/package.json` - new node protocol package manifest.
- `packages/protocol-node/tsconfig.json` - node protocol TypeScript config.
- `packages/protocol-node/src/index.ts` - exports routes/client helpers.
- `packages/protocol-node/src/node-routes.ts` - Fastify routes for node register, heartbeat, claim, reject, event sync, artifact sync, and complete.
- `packages/protocol-node/src/node-client.ts` - local node client for outbound server calls with shared-token header support.
- `packages/protocol-node/test/node-routes.test.ts` - node route success and negative coverage.
- `packages/protocol-rest/src/run-routes.ts` - adds a hosted orchestrator/launcher dependency while preserving local daemon behavior.
- `packages/protocol-rest/src/artifact-routes.ts` - reads content from the shared artifact content abstraction without changing response envelopes.
- `packages/protocol-rest/src/http-errors.ts` - maps R10 runtime error codes to HTTP statuses.
- `packages/protocol-rest/test/run-routes.test.ts` - proves local route behavior is unchanged and hosted placement routes through the orchestrator.
- `packages/protocol-rest/test/artifact-routes.test.ts` - proves object-backed content errors use existing envelopes.
- `packages/testkit/src/fake-runtime-adapter.ts` - updates only the fake manifest placement facts to hosted/connected support.
- `packages/testkit/src/fake-stores.ts` - adds in-memory node and assignment stores plus queue/object helpers where package boundaries need test fixtures.
- `packages/testkit/src/hosted-test-harness.ts` - shared fake hosted/server/worker/node harness for deterministic integration tests.
- `packages/testkit/src/index.ts` - exports R10 test helpers.
- `apps/server/package.json` - hosted server app manifest.
- `apps/server/tsconfig.json` - hosted server TypeScript config.
- `apps/server/src/config.ts` - hosted server config with memory defaults and opt-in Postgres/Redis/object-store envs.
- `apps/server/src/app.ts` - Fastify app wiring public run/artifact/registry routes and node routes.
- `apps/server/src/main.ts` - app entrypoint with sanitized startup logging.
- `apps/server/test/hosted-server.test.ts` - hosted fake run, placement denial, node flow, and public contract tests.
- `apps/worker/package.json` - hosted worker app manifest.
- `apps/worker/tsconfig.json` - hosted worker TypeScript config.
- `apps/worker/src/config.ts` - worker config with hosted fake allowlist.
- `apps/worker/src/worker.ts` - hosted worker service wiring.
- `apps/worker/src/main.ts` - worker entrypoint.
- `apps/worker/test/hosted-worker.test.ts` - worker success/error/retry/cancel tests.
- `apps/node/package.json` - connected local node app manifest.
- `apps/node/tsconfig.json` - node app TypeScript config.
- `apps/node/src/config.ts` - local node config and policy parsing.
- `apps/node/src/app.ts` - node claim/execute/sync loop using protocol-node client.
- `apps/node/src/main.ts` - node entrypoint.
- `apps/node/test/node-app.test.ts` - registration, heartbeat, policy allow/deny, fake execution, and sync tests.
- `docs/development/API.md` - documents hosted-like public compatibility, node endpoints, R10 errors, and safety boundaries.
- `docs/development/DEVELOPMENT.md` - adds no-spend hosted fake, connected-node fake, and negative placement smoke commands.
- `PRODUCT.md` - updates current truth from planned R10 to shipped safe hosted/hybrid slice after implementation.
- `CHANGELOG.md` - adds the R10 release entry after implementation.
- `ARCHITECTURE.md` - updates target/current architecture boundaries for apps/server, apps/worker, apps/node, Postgres, queue, object storage, and node protocol.
- `pnpm-lock.yaml` - records package dependency changes.

## Existing Context

`packages/contracts/src/run.ts` already contains the public placement field. R10 must make this real without changing response shape:

```ts
export const executionPlacementSchema = z.enum(["local", "hosted", "connected_local_node"]);
export const runSchema = z.object({
  id: runIdSchema,
  runtime: z.string().min(1),
  status: runStatusSchema,
  placement: executionPlacementSchema,
  runtimeMode: runtimeModeSlugSchema.optional()
});
```

`packages/protocol-rest/src/run-routes.ts` already accepts `placement` and defaults it to `local`. The hosted server must reuse this route contract and route through a hosted orchestrator only when configured:

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
  metadata: renderedContext ? { ...metadata, originalTask: body.task, contextPacket: renderedContext.context } : metadata
};
```

`packages/core/src/services/runtime-runner-service.ts` is the only runtime execution loop to reuse for hosted fake workers and local nodes:

```ts
const adapter = this.deps.adapters.get(run.runtime);
await this.deps.runs.update(started);
await this.appendAndPublish(this.eventForRun(started, "run.started", sequence++, {}));
const startResult = await adapter.start({ runId: started.id, runtime: started.runtime, runtimeMode: started.runtimeMode });
```

`packages/storage/src/sqlite/schema.ts` already persists the logical local model. Postgres must preserve these shapes and add node assignments:

```ts
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  runtime: text("runtime").notNull(),
  placement: text("placement").notNull(),
  runtimeMode: text("runtime_mode")
});

export const placementDecisions = sqliteTable("placement_decisions", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  decision: text("decision").notNull(),
  targetNode: text("target_node"),
  policyTraceJson: text("policy_trace_json").notNull()
});
```

`packages/testkit/src/fake-runtime-adapter.ts` is safe for hosted tests, but only its manifest placement facts should change:

```ts
placement: {
  local: { support: "supported", reason: "In-process deterministic test adapter." },
  hosted: { support: "unsupported", reason: "Hosted worker execution is not shipped in R3." },
  connectedLocalNode: { support: "future", reason: "Hybrid node execution is planned for R10." }
}
```

`apps/daemon/src/app.ts` shows the dependency wiring pattern to mirror in `apps/server` while keeping local daemon behavior intact:

```ts
registerRunRoutes(app, {
  ...stores,
  eventBus,
  launcher,
  runService,
  contextBuilder,
  registry: stores.registry,
  registryService
});
```

`packages/storage/src/filesystem-artifact-content-store.ts` already rejects unsafe local paths. The object store must enforce the same logical-path rules before deriving object keys:

```ts
if (/^[A-Za-z]:/.test(logicalPath) || isAbsolute(logicalPath) || logicalPath.includes("\\")) {
  throw new Error("Artifact path escapes root");
}
```

## Task Graph

### Task P9-T1-hosted-hybrid-execution

`id`: `P9-T1-hosted-hybrid-execution`
`title`: Ship safe hosted and connected-node execution slice`

`files`:
- Modify: `packages/contracts/src/node.ts`
- Create: `packages/contracts/src/assignment.ts`
- Modify: `packages/contracts/src/placement.ts`
- Modify: `packages/contracts/src/http-error.ts`
- Modify: `packages/contracts/src/registry.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/core/src/ports/queue.ts`
- Create: `packages/core/src/ports/artifact-content-store.ts`
- Modify: `packages/core/src/ports/node-store.ts`
- Create: `packages/core/src/ports/node-assignment-store.ts`
- Modify: `packages/core/src/services/placement-service.ts`
- Create: `packages/core/src/services/hosted-run-service.ts`
- Create: `packages/core/src/services/hosted-worker-service.ts`
- Create: `packages/core/src/services/node-coordinator-service.ts`
- Create: `packages/core/src/services/local-node-policy-service.ts`
- Create: `packages/core/src/services/event-sync-service.ts`
- Create: `packages/core/src/services/artifact-sync-service.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/hosted-placement-service.test.ts`
- Create: `packages/core/test/hosted-worker-service.test.ts`
- Create: `packages/core/test/node-coordinator-service.test.ts`
- Create: `packages/core/test/local-node-policy-service.test.ts`
- Create: `packages/core/test/sync-services.test.ts`
- Modify: `packages/storage/package.json`
- Create: `packages/storage/src/postgres/database.ts`
- Create: `packages/storage/src/postgres/schema.ts`
- Create: `packages/storage/src/postgres/run-store.ts`
- Create: `packages/storage/src/postgres/event-store.ts`
- Create: `packages/storage/src/postgres/session-store.ts`
- Create: `packages/storage/src/postgres/artifact-store.ts`
- Create: `packages/storage/src/postgres/registry-store.ts`
- Create: `packages/storage/src/postgres/placement-store.ts`
- Create: `packages/storage/src/postgres/node-store.ts`
- Create: `packages/storage/src/postgres/assignment-store.ts`
- Create: `packages/storage/src/object-artifact-content-store.ts`
- Create: `packages/storage/src/memory-artifact-content-store.ts`
- Modify: `packages/storage/src/index.ts`
- Create: `packages/storage/test/postgres-storage.test.ts`
- Create: `packages/storage/test/artifact-content-store.test.ts`
- Modify: `packages/storage/test/storage-package.test.ts`
- Create: `packages/queue/package.json`
- Create: `packages/queue/tsconfig.json`
- Create: `packages/queue/src/index.ts`
- Create: `packages/queue/src/memory-run-queue.ts`
- Create: `packages/queue/src/bullmq-run-queue.ts`
- Create: `packages/queue/test/run-queue.test.ts`
- Create: `packages/protocol-node/package.json`
- Create: `packages/protocol-node/tsconfig.json`
- Create: `packages/protocol-node/src/index.ts`
- Create: `packages/protocol-node/src/node-routes.ts`
- Create: `packages/protocol-node/src/node-client.ts`
- Create: `packages/protocol-node/test/node-routes.test.ts`
- Modify: `packages/protocol-rest/src/run-routes.ts`
- Modify: `packages/protocol-rest/src/artifact-routes.ts`
- Modify: `packages/protocol-rest/src/http-errors.ts`
- Modify: `packages/protocol-rest/test/run-routes.test.ts`
- Modify: `packages/protocol-rest/test/artifact-routes.test.ts`
- Modify: `packages/testkit/src/fake-runtime-adapter.ts`
- Modify: `packages/testkit/src/fake-stores.ts`
- Create: `packages/testkit/src/hosted-test-harness.ts`
- Modify: `packages/testkit/src/index.ts`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/main.ts`
- Create: `apps/server/test/hosted-server.test.ts`
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/src/config.ts`
- Create: `apps/worker/src/worker.ts`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/test/hosted-worker.test.ts`
- Create: `apps/node/package.json`
- Create: `apps/node/tsconfig.json`
- Create: `apps/node/src/config.ts`
- Create: `apps/node/src/app.ts`
- Create: `apps/node/src/main.ts`
- Create: `apps/node/test/node-app.test.ts`
- Modify: `docs/development/API.md`
- Modify: `docs/development/DEVELOPMENT.md`
- Modify: `PRODUCT.md`
- Modify: `CHANGELOG.md`
- Modify: `ARCHITECTURE.md`
- Modify: `pnpm-lock.yaml`

`dependencies`: []

`context_files`:
- `docs/superpowers/specs/2026-05-30-phase-9-r10-hosted-and-hybrid-execution.md` - source of R10 scope, safety constraints, data flows, errors, observability, and acceptance.
- `PROJECT.md` - confirms Phase 8 closeout and that hosted/hybrid was intentionally deferred before R10.
- `PRODUCT.md` - product truth for shipped local modes and R10 planned boundaries; update only after tests prove R10.
- `packages/protocol-rest/src/run-routes.ts` - public run API contract, wait/async behavior, input/cancel behavior, and error-envelope style to preserve.
- `packages/core/src/services/runtime-runner-service.ts` - existing runtime execution loop that hosted worker and local node must reuse.
- `packages/core/src/services/local-policy-gate.ts` - existing redaction helper and deny-by-default policy style.
- `packages/storage/src/sqlite/schema.ts` - logical metadata shapes that Postgres must preserve.
- `packages/storage/src/filesystem-artifact-content-store.ts` - safe artifact path rules to mirror for object storage.
- `packages/core/src/ports/queue.ts` - current minimal queue port to expand in place.
- `packages/testkit/src/fake-runtime-adapter.ts` - deterministic fake runtime and manifest to update safely.
- `apps/daemon/src/app.ts` - existing app wiring pattern; local daemon behavior must not regress.

`instructions`: Implement R10 in sequential, test-first slices inside this one task:

1. Contract first. Add `assignmentSchema` with statuses `pending`, `claimed`, `running`, `completed`, `failed`, `cancelled`, and `expired`; include `id`, `runId`, `nodeId`, `status`, `claimedAt`, `startedAt`, `completedAt`, `failedAt`, `retryCount`, `lastEventSequence`, `lastArtifactSyncAt`, `error`, and `createdAt`. Expand node records with `policy`, `version`, `heartbeatExpiresAt`, and `updatedAt`. Add request/response schemas for node register, heartbeat, assignment claim, assignment reject, event sync, artifact manifest, artifact content upload metadata, and complete. Add R10 HTTP error codes to both contract and REST closed sets: `placement_denied`, `node_auth_failed`, `node_not_found`, `assignment_not_found`, `assignment_claim_conflict`, `node_policy_denied`, `queue_unavailable`, `event_sync_gap`, `event_sync_conflict`, `artifact_digest_mismatch`, `artifact_sync_failed`, and `hosted_runtime_not_allowed`.
2. Update only the fake runtime placement manifest. `fake.deterministic` becomes local supported, hosted supported with reason naming hosted-safe deterministic fake worker, and connectedLocalNode supported with reason naming local node smoke execution. Do not mark Codex, Claude Code, OpenCode, Generic HTTP, AgentField, PTY, browser, local-auth, workspace-write, or danger-full-access modes as hosted-supported. Add contract/testkit tests that inspect the seeded fake runtime mode and one local-only runtime mode.
3. Expand ports without breaking local code. `RunQueuePort` must support `enqueue`, `process` or `claim`, `ack`, `fail`, `retry`, `discard`, and `getJob` with a default max attempts of 3 and secret-free payloads `{ jobId, runId, placement, runtimeMode, createdAt }`. Add `ArtifactContentStore` with `writeText`, `writeBytes`, `read`, and safe metadata return `{ path, storageBackend, objectKey?, sizeBytes, sha256, contentType }`. Add `NodeStore` and `NodeAssignmentStore` methods needed by node coordination. Keep old local code compiling by adapting the old queue shape through the new interface where needed.
4. Implement deterministic placement. `PlacementService.decide(input)` takes runtime mode, requested placement, registry placement facts, hosted allowlist, online nodes, policy summaries, and current time. Omitted placement chooses hosted first only when the runtime mode has hosted support and is in the allowlist; otherwise it chooses the lexicographically first eligible connected node; otherwise it returns a reject decision with reason `hosted_runtime_not_allowed` or `no_eligible_node`. Explicit placement is strict and must never silently fall back. Store one placement decision record for every created hosted or connected-node run before enqueueing or assignment creation.
5. Preserve the local daemon public contract. `apps/daemon` continues to use SQLite/filesystem stores, direct `RunLauncherService`, and local placement default. Local daemon may record placement decisions when the existing local run path can do so without requiring Postgres, Redis, object storage, or node services. Existing local fake, Codex, Claude, OpenCode, AgentField, Generic HTTP, middleware, and debate tests must remain green.
6. Add Postgres stores under `packages/storage/src/postgres`. Use the same logical shapes as SQLite for runs, events, sessions, artifacts, registry, and placement. Add node and assignment tables. Use JSONB for metadata/payload/policy arrays, indexes for run listing, event replay `(run_id, sequence)`, artifact lookup by run/debate, placement by run, node heartbeat/status, and assignment claim by status/node. Round-trip ISO strings exactly in returned TypeScript objects. Real Postgres tests run only when `SWITCHYARD_TEST_POSTGRES_URL` is set; otherwise tests use a deterministic memory substitute and skip real Postgres with a visible message.
7. Add object artifact content storage. `MemoryArtifactContentStore` validates safe logical paths, byte size, SHA-256, and content type. `ObjectArtifactContentStore` has S3/R2-compatible config: endpoint, region, bucket, access key, secret key, and force path style. Derive object keys from safe logical paths prefixed by run or debate id. Reject absolute paths, empty paths, `..`, backslashes, drive letters, and root escapes before writing. Metadata on artifacts must include `contentStored`, `storageBackend`, `objectKey` or safe local path, `sizeBytes`, `sha256`, and optional `syncDeniedReason`.
8. Add queue package. `MemoryRunQueue` provides deterministic tests for enqueue, claim/process, retry, ack, fail, discard, cancellation intent, and inspect. `BullMqRunQueue` wraps BullMQ/Redis with bounded attempts and secret-free payloads. Real Redis tests run only when `SWITCHYARD_TEST_REDIS_URL` is set; otherwise memory tests remain the default.
9. Add hosted server app. `apps/server` loads config with memory defaults and opt-in Postgres/Redis/object-store envs. It wires Fastify, error envelopes, registry seeding, hosted-safe fake runtime mode, `HostedRunService`, public run/artifact/runtime registry routes, and `registerNodeRoutes`. For `POST /runs?wait=1`, hosted fake mode should synchronously wait for the memory queue worker in tests and return the existing `{ run, response }` shape. For async `POST /runs`, return `202 { run }` after enqueue or assignment creation. Hosted placement denial must return `409 placement_denied` before run creation.
10. Add hosted worker app. `apps/worker` constructs `HostedWorkerService` with only `FakeRuntimeAdapter` in its adapter map. At job claim time, before calling `RuntimeRunnerService.start`, the worker must re-read the run row from the store and validate all of these facts from durable state, not just from the queue payload: `run.placement === "hosted"`, `run.runtime === "fake"`, `run.runtimeMode === "fake.deterministic"`, `run.adapterType` equals the fake manifest adapter type, the hosted runtime allowlist contains `fake.deterministic`, and the run is still non-terminal. If any validation fails, fail the job and the run with `reasonCode:"hosted_runtime_not_allowed"` or `reasonCode:"hosted_run_state_invalid"` without instantiating local-only adapters. Add a test that fails if the worker imports or registers Codex, Claude Code, OpenCode, Generic HTTP, AgentField, PTY, browser, or shell-backed adapters. Worker success starts the existing runtime runner, appends events, writes artifacts to the configured artifact content store, and terminalizes the run. Queue retry exhaustion marks the run failed with `reasonCode:"worker_retry_exhausted"`. Object write failure marks the run failed with `reasonCode:"object_store_write_failed"` unless the artifact was explicitly metadata-only.
11. Add node protocol routes and client. Routes must include `POST /nodes/register`, `POST /nodes/:id/heartbeat`, `GET /nodes`, `GET /nodes/:id`, `POST /nodes/:id/assignments/claim`, `POST /nodes/:id/assignments/:assignmentId/reject`, `POST /nodes/:id/assignments/:assignmentId/events`, `POST /nodes/:id/assignments/:assignmentId/artifacts/manifest`, `PUT /nodes/:id/assignments/:assignmentId/artifacts/:artifactId/content`, and `POST /nodes/:id/assignments/:assignmentId/complete`. When `SWITCHYARD_NODE_SHARED_TOKEN` is configured, every node route requires `x-switchyard-node-token`; missing or invalid tokens return `401 node_auth_failed`.
12. Implement node coordination. Registration upserts a node, accepts empty capabilities as non-assignable, uses deny-by-default policy when policy is empty, and generates a `node_` id when omitted. Heartbeats refresh `lastSeenAt`, `heartbeatExpiresAt`, capabilities, and policy summary. Stale detection marks nodes offline and prevents new assignments. Assignment creation is durable before claim. Claim conflict returns `409 assignment_claim_conflict`. Active heartbeat expiry fails or retries only fake deterministic connected-node assignments once; after retry exhaustion or no eligible node, mark run failed with `reasonCode:"node_assignment_lost"`.
13. Add connected local node app. `apps/node` reads server URL, node id, shared token, capabilities, and local policy. It registers, heartbeats, claims assignments, re-checks full local policy, runs allowed assignments locally under the hosted run id, syncs events/artifacts, and completes or rejects. For R10, connected-node smoke must support `fake.deterministic`; local-only real runtimes may be advertised only when the node app can run them through existing local adapters and policy-gate them. Do not execute hosted arbitrary subprocesses in `apps/server` or `apps/worker`.
14. Enforce local node policy before execution and sync. Deny when `allowRuntimeModes` is empty or missing the run mode, `denyAdapterTypes` contains the adapter type, `allowCwdPrefixes` is empty or does not prefix the run cwd, event sync is disabled for the event payload, artifact sync is metadata-only while content upload is requested, or max artifact bytes would be exceeded. Redact keys matching token, apiKey, authorization, password, and secret in policy traces and logs. Node policy denial rejects the assignment and marks the hosted run failed with `reasonCode:"node_policy_denied"`.
15. Implement event sync rules. Validate node auth, assignment ownership, assignment state, event schema, hosted run id, and monotonic sequence. Empty event arrays return `{ accepted:true, appended:0 }`. Duplicate retry with byte-equivalent event payload is idempotent. Sequence gaps return `409 event_sync_gap`. Duplicate sequence with different payload returns `409 event_sync_conflict`. Accepted events append to the hosted event store and publish to the hosted event bus so `/runs/:id/events?live=1` sees them.
16. Implement artifact sync rules. Manifest entries include id, type, path, contentType, sizeBytes, sha256, and `syncContent`. Empty artifact lists return `{ accepted:true, artifacts:[] }`. Missing content for `syncContent:true` stores metadata with `contentStored:false` and records `artifact_sync_missing_content`. Zero-byte content is allowed only when size and digest match. Path escape returns `400 invalid_input`. Digest mismatch returns `409 artifact_digest_mismatch` and fails the assignment. Object-store write failure records `artifact_sync_failed` and fails the run with `reasonCode:"artifact_sync_failed"` unless the artifact was metadata-only.
17. Implement cancellation across placements. Unknown run returns `404 run_not_found`. Empty cancel body is valid. Queued hosted jobs are discarded when possible, run becomes `cancelled`, and `run.cancelled` is appended. Active hosted worker jobs observe cancellation before the next event/artifact persistence and call adapter cancel. Connected-node cancellation records intent; node receives it on heartbeat/claim poll, calls local adapter cancel, and syncs `run.cancelled`. Queue discard failure logs `run.cancel.queue_discard_failed` but keeps cancellation intent.
18. Keep error side effects honest. Errors before run creation create no run, placement, job, assignment, event, or artifact. Errors after run creation leave an inspectable terminal run with named `run.failed` or `run.cancelled` event. Map queue unavailable before creation to `503 queue_unavailable`; map hosted runtime unsafe to `409 placement_denied` with `hosted_runtime_not_allowed` in details.
19. Add docs and product truth. `docs/development/API.md` must document hosted-like compatibility, node endpoints, R10 error codes, placement behavior, and safety non-goals. `docs/development/DEVELOPMENT.md` must include copy-paste no-spend smoke for hosted fake memory mode, connected-node fake mode, and negative hosted Codex/Claude denial. `PRODUCT.md`, `CHANGELOG.md`, and `ARCHITECTURE.md` must state R10 shipped safe hosted/hybrid fake-first execution and must not claim SDK/CLI, enterprise auth, hosted subprocess/PTY/Codex/Claude/OpenCode, real tools, hosted debate, model judging, or production sandbox support.

`intra_task_checkpoints`:
- Checkpoint 1 - contracts and fake manifest: complete contract/node/assignment/error-code/fake placement changes; run `pnpm --filter @switchyard/contracts test` and targeted fake manifest tests before moving to core service work.
- Checkpoint 2 - core placement, policy, worker safety, and sync services: complete placement, hosted worker claim-time validation, node coordinator, local node policy, event sync, and artifact sync; run `pnpm --filter @switchyard/core test` before touching storage or apps.
- Checkpoint 3 - storage, object store, and queue: complete Postgres stores, memory/object content stores, memory queue, BullMQ queue, and optional-service skip behavior; run `pnpm --filter @switchyard/storage test` and `pnpm --filter @switchyard/queue test`, with real Postgres/Redis/object-store tests opt-in only through spec env vars.
- Checkpoint 4 - protocol and app integration: complete `packages/protocol-node`, hosted route integration, `apps/server`, `apps/worker`, and `apps/node`; run `pnpm --filter @switchyard/protocol-node test`, `pnpm --filter @switchyard/protocol-rest test`, `pnpm --filter @switchyard/server test`, `pnpm --filter @switchyard/worker test`, `pnpm --filter @switchyard/node test`, and `pnpm --filter @switchyard/daemon test`.
- Checkpoint 5 - docs and product truth: update `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, `PRODUCT.md`, `CHANGELOG.md`, and `ARCHITECTURE.md`; run docs smoke/overclaim tests, `pnpm typecheck`, `pnpm test`, and `git diff --check`.

`acceptance`:
- `apps/server` exists and serves the public run/artifact/runtime registry contract for hosted-like mode.
- `apps/worker` exists and completes queued hosted `fake.deterministic` runs without arbitrary subprocess, PTY, Codex, Claude, OpenCode, real tools, network/browser/search/GitHub/repo/fetch, or model judging.
- `apps/node` exists and can register, heartbeat, claim one fake assignment, enforce local policy, and sync approved events/artifacts.
- Postgres storage implements hosted run/event/session/artifact/registry/placement/node/assignment stores and tests either pass against configured Postgres or skip real Postgres only when explicitly unavailable.
- Redis/BullMQ queue implementation exists with deterministic memory queue substitute.
- Object artifact content store exists with S3/R2-compatible production shape and deterministic memory substitute.
- `fake.deterministic` is hosted-safe and connected-node-capable; local-only runtimes are not exposed as hosted-safe.
- Public run create/get/list/events/artifacts/cancel contract works in local daemon and hosted-like fake mode with the same response envelopes.
- Placement decisions are stored and inspectable for hosted and connected-local-node runs.
- Hosted placement rejects Codex, Claude Code, OpenCode, arbitrary subprocess, generic process, PTY, local-auth, workspace-write, and danger-full-access modes unless explicitly routed to and accepted by a connected local node.
- Connected local node assignment is durable, policy-gated, heartbeat-aware, and deterministic in tests.
- Event sync enforces monotonic sequence/idempotent retry rules and publishes synced events to hosted SSE streams.
- Artifact sync enforces path safety, size/digest validation, policy, and object-store persistence rules.
- Queue success, failure, retry exhaustion, cancellation, node offline, policy denial, event sync gap, and artifact sync failure all produce named user-visible errors or terminal run events.
- Local smoke docs cover hosted-like fake execution, connected-node fake execution, and hosted local-runtime denial.

`checks`:
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/queue test`
- `pnpm --filter @switchyard/protocol-node test`
- `pnpm --filter @switchyard/protocol-rest test`
- `pnpm --filter @switchyard/server test`
- `pnpm --filter @switchyard/worker test`
- `pnpm --filter @switchyard/node test`
- `pnpm --filter @switchyard/daemon test`
- `pnpm typecheck`
- `pnpm test`
- `git diff --check`

`error_rescue_map`:
- `{ codepath: "registerRunRoutes/create hosted body parse", failure: "missing or non-object body", exception: "HttpProblem invalid_input", rescue: "return 400 with details path body and create no run, placement, job, assignment, event, or artifact", user_sees: "400 invalid_input" }`
- `{ codepath: "registerRunRoutes/create required fields", failure: "missing or empty runtime/provider/model/adapterType/cwd/task or empty-string placement", exception: "HttpProblem invalid_input", rescue: "return field-specific 400 before side effects", user_sees: "400 invalid_input with details path" }`
- `{ codepath: "RegistryService.inferAndValidateRuntimeMode", failure: "runtime mode omitted and cannot be inferred", exception: "RuntimeModeValidationError invalid_input", rescue: "return 400 runtime_mode_unresolved before side effects", user_sees: "400 invalid_input" }`
- `{ codepath: "PlacementService.decide hosted", failure: "requested hosted placement for local-only runtime", exception: "PlacementDeniedError placement_denied", rescue: "reject before run creation with reason hosted_runtime_not_allowed", user_sees: "409 placement_denied" }`
- `{ codepath: "PlacementService.decide connected node", failure: "no eligible online node", exception: "PlacementDeniedError placement_denied", rescue: "reject explicit connected placement before run creation; fail existing run with node_not_available only if failure occurs after creation", user_sees: "409 placement_denied or terminal run.failed node_not_available" }`
- `{ codepath: "PostgresRunStore.create", failure: "database insert fails", exception: "pg/Drizzle database error", rescue: "return 500 internal_error, log run.create.storage_failed with sanitized details, create no queue job", user_sees: "500 internal_error" }`
- `{ codepath: "RunQueuePort.enqueue", failure: "queue unavailable before run creation", exception: "QueueUnavailableError", rescue: "return 503 queue_unavailable before run creation", user_sees: "503 queue_unavailable" }`
- `{ codepath: "RunQueuePort.enqueue after run create", failure: "enqueue fails after run is durable", exception: "QueueEnqueueError", rescue: "mark run failed, append run.failed reasonCode queue_enqueue_failed, return 500 for wait path", user_sees: "500 internal_error or inspectable failed run" }`
- `{ codepath: "HostedWorkerService.claim validation", failure: "queued payload or durable run row is mutated after enqueue, placement is not hosted, runtime/runtimeMode/adapterType no longer match fake.deterministic, allowlist does not contain fake.deterministic, or run is already terminal", exception: "HostedRuntimeNotAllowedError or HostedRunStateInvalidError", rescue: "re-read run at claim time, reject before RuntimeRunnerService.start, fail job and run with hosted_runtime_not_allowed or hosted_run_state_invalid; do not instantiate local adapters", user_sees: "run.failed hosted_runtime_not_allowed or hosted_run_state_invalid" }`
- `{ codepath: "HostedWorkerService.retry", failure: "job exceeds max attempts", exception: "QueueRetryExhaustedError", rescue: "mark run failed with reasonCode worker_retry_exhausted and ack terminal job", user_sees: "run.failed worker_retry_exhausted" }`
- `{ codepath: "HostedWorkerService.artifact persistence", failure: "adapter terminal event arrives before artifact content persistence completes", exception: "ObjectStoreWriteError or ArtifactStoreError", rescue: "terminal run remains inspectable; artifact failure appends named failure event or marks run failed with object_store_write_failed when content is required", user_sees: "terminal run plus artifact failure reason, not a hanging worker" }`
- `{ codepath: "ArtifactContentStore.writeText/writeBytes", failure: "object store write fails", exception: "ObjectStoreWriteError", rescue: "mark run failed reasonCode object_store_write_failed unless metadata-only policy applies", user_sees: "run.failed object_store_write_failed" }`
- `{ codepath: "NodeAuthGuard", failure: "shared token missing or invalid when configured", exception: "HttpProblem node_auth_failed", rescue: "return 401 before node/assignment side effects", user_sees: "401 node_auth_failed" }`
- `{ codepath: "NodeCoordinatorService.register", failure: "malformed policy", exception: "ZodError/HttpProblem invalid_input", rescue: "return 400 and do not upsert node", user_sees: "400 invalid_input" }`
- `{ codepath: "NodeCoordinatorService.heartbeat", failure: "unknown node", exception: "NodeNotFoundError", rescue: "return 404 and require node to re-register", user_sees: "404 node_not_found" }`
- `{ codepath: "NodeCoordinatorService.claim", failure: "two nodes claim same assignment", exception: "AssignmentClaimConflictError", rescue: "first claimant keeps assignment; losing node gets 409", user_sees: "409 assignment_claim_conflict" }`
- `{ codepath: "NodeCoordinatorService.expireStale", failure: "assignment expires while a node claim/complete request is racing", exception: "AssignmentExpiredError or AssignmentClaimConflictError", rescue: "use compare-and-set status transitions; terminal assignment status wins once and run receives exactly one terminal event", user_sees: "single terminal run state without duplicate failure/completion events" }`
- `{ codepath: "LocalNodePolicyService.decide", failure: "runtime/cwd/adapter/event/artifact policy denied", exception: "NodePolicyDeniedError", rescue: "reject assignment, redact trace, mark hosted run failed reasonCode node_policy_denied", user_sees: "run.failed node_policy_denied or 403 node_policy_denied" }`
- `{ codepath: "EventSyncService.appendBatch", failure: "missing events property", exception: "HttpProblem invalid_input", rescue: "return 400 without advancing cursor", user_sees: "400 invalid_input" }`
- `{ codepath: "EventSyncService.appendBatch", failure: "sequence gap", exception: "EventSyncGapError", rescue: "return 409 without appending any later event", user_sees: "409 event_sync_gap" }`
- `{ codepath: "EventSyncService.appendBatch", failure: "duplicate sequence with different payload", exception: "EventSyncConflictError", rescue: "return 409 and preserve existing event", user_sees: "409 event_sync_conflict" }`
- `{ codepath: "ArtifactSyncService.acceptManifest", failure: "path escapes root or object key prefix", exception: "HttpProblem invalid_input", rescue: "reject manifest/content before object write", user_sees: "400 invalid_input" }`
- `{ codepath: "ArtifactSyncService.acceptContent", failure: "digest or size mismatch", exception: "ArtifactDigestMismatchError", rescue: "return 409, fail assignment, fail run reasonCode artifact_digest_mismatch", user_sees: "409 artifact_digest_mismatch and failed run" }`
- `{ codepath: "ArtifactSyncService.metadataAfterObjectWrite", failure: "object write succeeds but artifact metadata insert/update fails", exception: "ArtifactStoreError", rescue: "record artifact_sync_failed, fail assignment/run, and leave object key trace for cleanup without exposing credentials", user_sees: "run.failed artifact_sync_failed" }`
- `{ codepath: "HostedRunService.cancel", failure: "queue discard fails", exception: "QueueDiscardError", rescue: "log run.cancel.queue_discard_failed, record cancellation intent, append run.cancelled when safe", user_sees: "run cancellation remains inspectable" }`
- `{ codepath: "Node cancellation", failure: "node does not acknowledge cancellation before heartbeat expiry", exception: "NodeAssignmentLostError", rescue: "mark run failed reasonCode node_cancel_lost unless terminal state already exists", user_sees: "run.failed node_cancel_lost" }`
- `{ codepath: "config/logging", failure: "secret-bearing config or policy trace would be logged", exception: "no throw; leak risk", rescue: "always pass through redactSecrets and omit Redis URLs, DB passwords, object-store credentials, provider credentials, and local file content", user_sees: "sanitized diagnostics only" }`

`observability`:
- `logs`: `hosted.server.started`, `run.create.requested`, `placement.decided`, `placement.denied`, `queue.enqueue.succeeded`, `queue.enqueue.failed`, `worker.job.claimed`, `worker.job.retrying`, `worker.job.exhausted`, `node.registered`, `node.heartbeat.accepted`, `node.heartbeat.expired`, `node.assignment.created`, `node.assignment.claimed`, `node.policy.denied`, `event.sync.accepted`, `event.sync.gap`, `artifact.sync.accepted`, `artifact.sync.failed`, `object.write.failed`, `run.cancel.queue_discard_failed`.
- `success_metric`: hosted fake and connected-node fake runs complete through the same public response/event/artifact shapes as local fake runs; placement decisions and assignment records are inspectable.
- `failure_metric`: placement denial count by reason, failed queue jobs by reason, worker retry exhaustion count, node offline count, event sync gap/conflict count, artifact digest/write failure count, and object write failure count.

`test_cases`:
- `{ name: "hosted fake wait run completes", lens: "happy", given: "POST /runs?wait=1 with fake.deterministic placement hosted on apps/server memory infra", expect: "201 with completed run, response.text fake runtime output, replay events, artifact metadata, and artifact content" }`
- `{ name: "hosted fake async run completes through worker", lens: "happy", given: "POST /runs with fake.deterministic placement hosted then process memory queue", expect: "202 queued run becomes completed and has transcript artifact" }`
- `{ name: "hosted registry runtime-mode and doctor endpoints match public contract", lens: "integration", given: "apps/server memory infrastructure after fake runtime-mode seeding", expect: "GET /providers, /runtimes, /models, /runtime-modes, /runtime-modes/fake.deterministic, POST /runtime-modes/fake.deterministic/check, and GET /doctor return existing envelope shapes with hosted fake placement visible and local-only runtime modes not hosted-supported" }`
- `{ name: "omitted placement chooses hosted fake", lens: "happy", given: "POST /runs without placement for fake.deterministic on hosted server", expect: "stored placement decision decision hosted and run.placement hosted" }`
- `{ name: "explicit hosted rejects local runtimes", lens: "error_path", given: "POST /runs placement hosted for codex.exec_json, claude_code.sdk, opencode.acp, generic_http.async_rest, pty, or danger-full-access capability fixture", expect: "409 placement_denied with hosted_runtime_not_allowed and no job" }`
- `{ name: "hosted worker rejects mutated run after enqueue", lens: "error_path", given: "enqueue hosted fake job, then mutate durable run row to placement local, runtime codex, runtimeMode codex.exec_json, wrong adapterType, missing allowlist entry, or terminal status before worker claim", expect: "worker re-reads durable row, never calls RuntimeRunnerService.start, never instantiates local adapters, and fails run/job with hosted_runtime_not_allowed or hosted_run_state_invalid" }`
- `{ name: "missing body has no side effects", lens: "happy_shadow_nil", given: "POST /runs with no body", expect: "400 invalid_input and empty run/placement/job/assignment stores" }`
- `{ name: "empty placement invalid", lens: "happy_shadow_empty", given: "POST /runs placement empty string", expect: "400 invalid_input and no side effects" }`
- `{ name: "queue unavailable before create", lens: "error_path", given: "hosted queue adapter throws QueueUnavailableError before run creation", expect: "503 queue_unavailable and no run row" }`
- `{ name: "queue enqueue failure after create", lens: "error_path", given: "enqueue fails after run create in controlled harness", expect: "run.failed with queue_enqueue_failed and no orphan pending job" }`
- `{ name: "Postgres run create failure is sanitized", lens: "error_path", given: "PostgresRunStore.create throws during hosted run create", expect: "500 internal_error, sanitized run.create.storage_failed log, and no queue job or artifact object" }`
- `{ name: "duplicate BullMQ job is idempotent or rejected safely", lens: "edge_duplicate_job", given: "same runId appears in two BullMQ jobs", expect: "only one worker execution reaches RuntimeRunnerService.start; duplicate job acks/skips or fails without duplicate terminal events/artifacts" }`
- `{ name: "worker retry exhausted", lens: "error_path", given: "worker job fails three times", expect: "run.failed reasonCode worker_retry_exhausted" }`
- `{ name: "terminal event before artifact content remains inspectable", lens: "edge_terminal_before_artifact", given: "fake adapter emits run.completed before artifact content write completes", expect: "terminal run remains inspectable and required artifact write failure produces object_store_write_failed or artifact_sync_failed instead of a hanging worker" }`
- `{ name: "object write failure fails hosted run", lens: "error_path", given: "artifact content store write throws for hosted fake transcript", expect: "run.failed object_store_write_failed" }`
- `{ name: "queued cancellation succeeds", lens: "happy", given: "cancel hosted run before worker starts", expect: "run.cancelled event and queue job discarded or cancellation intent recorded" }`
- `{ name: "queue discard failure still records cancellation intent", lens: "error_path", given: "HostedRunService.cancel sees QueueDiscardError for queued hosted job", expect: "run.cancel.queue_discard_failed is logged, cancellation intent is durable, and user sees inspectable cancellation or terminal state" }`
- `{ name: "node cancellation lost acknowledgement", lens: "error_path", given: "connected node receives cancellation intent but misses acknowledgement until heartbeat expiry", expect: "run.failed node_cancel_lost unless node already synced a terminal cancelled/completed/failed event" }`
- `{ name: "node registers and heartbeats", lens: "happy", given: "POST /nodes/register then heartbeat with valid token", expect: "node online with heartbeatExpiresAt and refreshed lastSeenAt" }`
- `{ name: "node registration malformed policy", lens: "error_path", given: "POST /nodes/register with malformed policy shape or invalid sync enum", expect: "400 invalid_input and no node upsert" }`
- `{ name: "unknown node heartbeat", lens: "error_path", given: "POST /nodes/node_missing/heartbeat", expect: "404 node_not_found and node must re-register" }`
- `{ name: "node auth missing denied", lens: "error_path", given: "node route call without token when token configured", expect: "401 node_auth_failed and no node/assignment mutation" }`
- `{ name: "empty node capabilities non-assignable", lens: "happy_shadow_empty", given: "register node with capabilities []", expect: "node online but placement finds no eligible node" }`
- `{ name: "heartbeat expiry marks offline", lens: "edge_stale_node", given: "registered node past heartbeatExpiresAt", expect: "node status offline and no new assignment" }`
- `{ name: "connected placement chooses lexicographic node", lens: "happy", given: "two eligible online nodes node_b and node_a", expect: "placement targetNode node_a" }`
- `{ name: "claim conflict deterministic", lens: "error_path", given: "two claim attempts for same assignment", expect: "first claim succeeds, second 409 assignment_claim_conflict" }`
- `{ name: "stale assignment expiry race is single-terminal", lens: "edge_stale_assignment_race", given: "assignment expiry and node claim/complete race in deterministic harness", expect: "compare-and-set transition produces one final assignment status and one terminal run event" }`
- `{ name: "node policy allow executes fake", lens: "integration", given: "apps/node with allowRuntimeModes fake.deterministic and cwd prefix match", expect: "assignment completes, hosted run completed, synced runtime.output and artifact content visible" }`
- `{ name: "node policy empty denies", lens: "happy_shadow_empty", given: "node policy allowRuntimeModes []", expect: "assignment rejected and run.failed node_policy_denied" }`
- `{ name: "node policy cwd denial", lens: "error_path", given: "assignment cwd outside allowCwdPrefixes", expect: "run.failed node_policy_denied with redacted trace" }`
- `{ name: "event sync empty batch", lens: "happy_shadow_empty", given: "events [] for claimed assignment", expect: "200 accepted true appended 0 and cursor unchanged" }`
- `{ name: "event sync sequence gap", lens: "error_path", given: "next expected sequence 2 but node sends 4", expect: "409 event_sync_gap and no append" }`
- `{ name: "event sync duplicate idempotent", lens: "edge_idempotent_retry", given: "same sequence and byte-equivalent event resent", expect: "200 accepted true appended 0 or duplicate acknowledged without conflict" }`
- `{ name: "event sync duplicate conflict", lens: "error_path", given: "same sequence with different payload", expect: "409 event_sync_conflict" }`
- `{ name: "artifact manifest empty", lens: "happy_shadow_empty", given: "artifacts []", expect: "200 accepted true artifacts []" }`
- `{ name: "artifact path escape rejected", lens: "error_path", given: "manifest path ../secret or absolute path", expect: "400 invalid_input and no object write" }`
- `{ name: "artifact digest mismatch", lens: "error_path", given: "uploaded content sha256 differs from manifest", expect: "409 artifact_digest_mismatch and failed assignment" }`
- `{ name: "artifact zero byte allowed when digest matches", lens: "edge_zero_byte", given: "sizeBytes 0 and sha256 of empty content", expect: "contentStored true and content fetch returns empty body" }`
- `{ name: "object write success then metadata failure", lens: "error_path", given: "object content write succeeds but ArtifactStore.create or update throws", expect: "assignment/run fail with artifact_sync_failed and logs include object key cleanup trace without credentials" }`
- `{ name: "local and hosted fake contract equivalence", lens: "integration", given: "same fake run through apps/daemon and apps/server", expect: "matching run response envelope, event types/order semantics, artifact list shape, and content body" }`
- `{ name: "local and hosted list cancel live SSE and artifact error parity", lens: "integration", given: "equivalent fake runs through apps/daemon and apps/server, plus missing artifact content path", expect: "GET /runs filters, POST /runs/:id/cancel, /runs/:id/events?live=1&stopAfter=N, /runs/:id/artifacts, /artifacts/:id, and /artifacts/:id/content use equivalent envelopes and error codes" }`
- `{ name: "Postgres tests skip only when unavailable", lens: "integration", given: "SWITCHYARD_TEST_POSTGRES_URL unset", expect: "storage test reports explicit skip and memory contract still runs" }`
- `{ name: "Redis tests skip only when unavailable", lens: "integration", given: "SWITCHYARD_TEST_REDIS_URL unset", expect: "queue test reports explicit skip and memory queue contract passes" }`
- `{ name: "Object store tests skip only when unavailable", lens: "integration", given: "object store env unset", expect: "memory object store tests pass and real object store test reports explicit skip" }`
- `{ name: "docs smoke commands are present", lens: "integration", given: "read docs/development/DEVELOPMENT.md after R10 docs update", expect: "copy-paste smoke commands exist for hosted fake memory mode, connected-node fake mode, and negative hosted Codex or Claude placement denial" }`
- `{ name: "docs and product truth do not overclaim", lens: "integration", given: "scan docs/development/API.md, docs/development/DEVELOPMENT.md, PRODUCT.md, CHANGELOG.md, and ARCHITECTURE.md", expect: "docs do not claim SDK/CLI, enterprise auth, real hosted subprocess/PTY/Codex/Claude/OpenCode, real tools, hosted debate, model judging, or production sandbox support" }`
- `{ name: "secret-bearing diagnostics are redacted", lens: "error_path", given: "config, node policy, queue URL, database URL, object-store config, or provider credential contains token/apiKey/authorization/password/secret", expect: "logs, errors, policy traces, events, and artifacts contain [REDACTED] or omit the value" }`

`integration_contracts`:
- `exports`:
  - `{ name: "assignmentSchema", kind: "constant", signature: "Zod schema for node assignment records with status pending|claimed|running|completed|failed|cancelled|expired" }`
  - `{ name: "RunQueuePort", kind: "interface", signature: "enqueue(job), process(handler), ack(jobId), fail(jobId, error), retry(jobId), discard(jobId), getJob(jobId)" }`
  - `{ name: "ArtifactContentStore", kind: "interface", signature: "writeText(path, text, metadata?) => StoredArtifactContent; writeBytes(path, bytes, metadata?) => StoredArtifactContent; read(artifact) => { body, contentType }" }`
  - `{ name: "NodeStore", kind: "interface", signature: "upsert(node), get(id), list(filter), markOffline(id, at), listEligible(input)" }`
  - `{ name: "NodeAssignmentStore", kind: "interface", signature: "create(record), get(id), claim(input), update(record), complete(id), fail(id), cancel(id), expireStale(now), listClaimable(nodeId)" }`
  - `{ name: "PlacementService", kind: "class", signature: "decide(input) => PlacementDecisionRecord draft with decision hosted|connected_local_node|local|reject" }`
  - `{ name: "HostedRunService", kind: "class", signature: "createRun(input, { wait }) => { run, response? } using public RunService shapes" }`
  - `{ name: "HostedWorkerService", kind: "class", signature: "process(job) => Promise<void> with fake-only RuntimeRunnerService execution" }`
  - `{ name: "NodeCoordinatorService", kind: "class", signature: "register, heartbeat, list, get, createAssignment, claim, reject, complete, expireStale, cancelIntent" }`
  - `{ name: "LocalNodePolicyService", kind: "class", signature: "decide(run, policy, syncIntent?) => allow|deny with redacted policyTrace" }`
  - `{ name: "EventSyncService", kind: "class", signature: "appendBatch(nodeId, assignmentId, { cursor, events }) => { accepted, appended, nextCursor }" }`
  - `{ name: "ArtifactSyncService", kind: "class", signature: "acceptManifest(nodeId, assignmentId, manifest), acceptContent(nodeId, assignmentId, artifactId, bytes) with path/digest/size/policy validation" }`
  - `{ name: "MemoryRunQueue", kind: "class", signature: "deterministic RunQueuePort implementation" }`
  - `{ name: "BullMqRunQueue", kind: "class", signature: "Redis/BullMQ RunQueuePort implementation" }`
  - `{ name: "PostgresRunStore/PostgresEventStore/PostgresSessionStore/PostgresArtifactStore/PostgresRegistryStore/PostgresPlacementStore/PostgresNodeStore/PostgresAssignmentStore", kind: "class", signature: "Postgres implementations of existing core ports" }`
  - `{ name: "MemoryArtifactContentStore", kind: "class", signature: "ArtifactContentStore implementation with in-memory bytes and digest validation" }`
  - `{ name: "ObjectArtifactContentStore", kind: "class", signature: "ArtifactContentStore implementation for S3/R2-compatible object storage" }`
  - `{ name: "registerNodeRoutes", kind: "function", signature: "registerNodeRoutes(app, deps) => void" }`
  - `{ name: "createServerApp", kind: "function", signature: "createServerApp(config?, options?) => Promise<FastifyInstance>" }`
  - `{ name: "createHostedWorker", kind: "function", signature: "createHostedWorker(config?, options?) => Promise<{ start, stop }>" }`
  - `{ name: "createNodeApp", kind: "function", signature: "createNodeApp(config?, options?) => Promise<{ start, stop, tick }>" }`
- `imports_from_other_tasks`: []
- `file_paths_consumed_by_other_tasks`:
  - `packages/contracts/src/assignment.ts`
  - `packages/core/src/services/hosted-run-service.ts`
  - `packages/core/src/services/hosted-worker-service.ts`
  - `packages/core/src/services/node-coordinator-service.ts`
  - `packages/core/src/services/event-sync-service.ts`
  - `packages/core/src/services/artifact-sync-service.ts`
  - `packages/queue/src/index.ts`
  - `packages/protocol-node/src/index.ts`
  - `apps/server/src/app.ts`
  - `apps/worker/src/worker.ts`
  - `apps/node/src/app.ts`

## Risks

- Single-task execution is larger than the CTO sizing heuristic. This follows the user's one implementer/reviewer preference, but reviewer/auditor should pay special attention to missed cross-package exports, accidental hosted adapter imports, and docs overclaiming.
- Postgres/Redis/object storage introduce optional external integrations. Deterministic memory substitutes are mandatory for default CI; real service tests must skip explicitly when environment variables are absent.
- The hosted worker safety boundary is the most important regression risk. Tests must prove that hosted workers cannot instantiate or import local-auth/process/PTY/model-backed adapters beyond the deterministic fake adapter.

## Integration Points

The hosted server reuses `registerRunRoutes` through a hosted run orchestrator dependency instead of forking the route contract. The hosted worker reuses `RuntimeRunnerService` with a fake-only adapter map. The local node reuses `RuntimeRunnerService` after `LocalNodePolicyService` allows the assignment. `EventSyncService` and `ArtifactSyncService` write into the same hosted stores used by public run routes so `GET /runs/:id`, `/runs/:id/events`, `/runs/:id/artifacts`, `/artifacts/:id`, and `/artifacts/:id/content` work for hosted and connected-node runs without client-side branching.

## Acceptance Criteria

- [ ] Hosted server, hosted worker, local node, Postgres storage, Redis/BullMQ queue, object artifact store, placement, node registration/heartbeat, assignment, local policy enforcement, event sync, and artifact sync are implemented to the R10 boundary.
- [ ] The same fake run can be exercised through local and hosted-like run APIs with equivalent response/event/artifact shapes.
- [ ] Hosted runtime safety is enforced: only `fake.deterministic` can run in hosted worker; local-only runtime modes are rejected from hosted placement.
- [ ] Deterministic local tests and smoke docs cover success, nil, empty, and error shadows for hosted worker and connected-node flows.

## Self-Review

1. Spec coverage: every R10 acceptance bullet maps to Task `P9-T1-hosted-hybrid-execution`.
2. Placeholder scan: no placeholder markers are present.
3. Type consistency: all new imports are within the single task, and exported names are locked in integration contracts.
4. Ownership disjoint: one task owns every listed file, so there is no overlap.
5. Context files real: verified all listed context paths exist in this worktree.
6. Acceptance testable: every acceptance bullet has matching tests/checks.
7. Dependency order sane: single task has no dependencies.
8. Checks runnable: commands target workspace package scripts and existing root scripts.
9. Error/rescue map present: every major runtime, storage, queue, node, sync, cancel, and safety failure path has a named rescue.
10. Observability present: logs and metrics hooks are specified with run/node/assignment/job context.
11. Test cases enumerate acceptance: test cases cover hosted, node, queue, object, sync, cancel, nil, empty, and error paths.
12. Integration contracts walk: no cross-task imports exist; all exported contracts are owned by the task.
13. Contract types match: single-task exports use existing run/event/artifact/store shapes and new assignment/node contracts.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test_case.
- [x] Every error_rescue_map entry has a matching test_case in `lens: error_path`, `lens: happy_shadow_nil`, `lens: happy_shadow_empty`, `lens: edge_*`, or `lens: integration`.
- [x] Every integration_contracts.imports_from_other_tasks resolves to a real export elsewhere, or the import list is empty because there is one task.
- [x] Every context_files path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text appears in this plan.
- [x] Complexity is L; single-task scope is retained by user request and flagged under Risks.
