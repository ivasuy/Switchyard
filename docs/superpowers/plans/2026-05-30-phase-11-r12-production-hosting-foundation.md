# Phase 11: R12 Production Hosting Foundation — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-11-r12-production-hosting-foundation.md`
**Branch:** `agent/phase-11-r12-production-hosting-foundation`
**Complexity:** L

## Goal

Make the existing R10 hosted-safe fake worker and connected-node slice staging/self-hosted deployable with fail-closed production config, dependency readiness, crash-recoverable queue semantics, persistent local object storage, hardened node contracts, and no hosted real runtime expansion.

## Scope Challenge

1. **Existing code already solves part of this:** `apps/server`, `apps/worker`, and `apps/node` already wire hosted run creation, worker execution, connected node assignment, Postgres-shaped stores, Redis/BullMQ queueing, and local object artifact content. R12 must extend those seams instead of creating a second hosted API or worker runtime.
2. **Minimum changes:** add deployment-mode validation, readiness, metrics, graceful loops, queue leases/recovery, Postgres/object probes, node auth/body/client hardening, contract inventory additions, and a self-hosted smoke harness. Defer real S3/R2 clients, hosted subprocesses, real hosted adapters, enterprise auth, dashboard, and TUI.
3. **Complexity check:** this phase necessarily touches more than 8 files because it crosses server, worker, node, queue, storage, contracts, and smoke artifacts. The user explicitly requested the same one-implementer/one-reviewer phase flow used for R11, so the plan uses one full-phase task with a strict internal order and mandatory module checkpoints. This is a review risk and is listed under `concerns`.
4. **Built-in check:** use Fastify `bodyLimit`, content-type parser hooks, `onClose`, `onResponse`, `setErrorHandler`, Node `AbortController`, Node `crypto.timingSafeEqual`, `node:timers/promises`, `pg` pool probes, existing BullMQ/ioredis dependencies, and existing Zod schemas. Do not add a command framework, queue library, S3 SDK, auth system, or dashboard.
5. **Distribution check:** the new self-hosted artifact must include a runnable local compose or equivalent harness, package scripts, smoke command, and docs that explain exact environment variables without exposing secrets.

## Architecture

R12 keeps the R10 split. `apps/server` remains the hosted API gateway for REST/node routes, placement, enqueueing, metadata stores, artifact reads, readiness, and hosted metrics. `apps/worker` remains the only hosted executor and continues to instantiate only `FakeRuntimeAdapter`; it consumes Redis jobs, revalidates the durable run row, writes events/artifacts through existing stores, and handles graceful stop. `apps/node` remains a connected local-node service that registers, heartbeats, claims, enforces local policy, syncs events/artifacts, and completes or rejects assignments.

```
POST /runs hosted fake
  │
  ▼
server config/readiness ──▶ Postgres stores ──▶ placement decision ──▶ Redis queue
  │                                                                        │
  ├── /health liveness                                                     ▼
  ├── /ready dependency probes                                      worker claim lease
  └── /metrics hosted counters                                      │
                                                                    ▼
                                                        durable fake-only validation
                                                                    │
                                                                    ▼
                                                        fake runtime + local object PV
                                                                    │
                                                                    ▼
                                                        ack, retry, fail, or exhaust
```

Connected nodes stay behind the shared token boundary. In staging/production, the server and node app both require `SWITCHYARD_NODE_SHARED_TOKEN`; route auth uses constant-time comparison and returns `node_auth_required` for missing credentials and `node_auth_failed` for invalid credentials. Node JSON routes and artifact content sync get explicit body limits before storage side effects.

```
node app ──register──▶ server /nodes/register
   │                     │
   ├─ heartbeat ────────▶ token + body limit + schema parse
   ├─ claim ───────────▶ assignment + run hydrate
   ├─ sync events ─────▶ monotonic cursor validation
   ├─ sync artifacts ──▶ path, size, sha256, object write
   └─ complete/reject ─▶ durable assignment state
```

State remains in existing packages. `packages/storage` owns Postgres schema/readiness helpers and the local object persistent-volume backend. `packages/queue` owns queue leases, stale-claim recovery, retry/exhaustion visibility, and stats for memory and Redis implementations. Redis queued-to-claimed transitions must be atomic: use BullMQ active/stalled semantics directly or a Redis Lua/transactional move that cannot lose a job between waiting removal and claimed lease persistence. `packages/contracts` owns additive hosted/node inventory and schemas while the default R11 local-daemon OpenAPI output remains unchanged.

`/metrics` is JSON in R12. It must return `application/json` with stable top-level keys `requests`, `errors`, `placement`, `queue`, `worker`, `objectStore`, `node`, `dependencies`, and `config`. Each key contains bounded counters/gauges only; do not include run task text, cwd, DSNs, token values, object keys, or high-cardinality labels. If one component's metric collection fails, the endpoint should remain 200 when possible, mark that component `available:false`, and increment `errors.metricsCollection`.

## File Structure

- `apps/server/src/config.ts` — parse `SWITCHYARD_DEPLOYMENT_MODE`, validate required production settings, and produce redacted config summaries.
- `apps/server/src/app.ts` — configure Fastify body limits, initialize production stores fail-closed, expose `/ready` and hosted `/metrics`, wire node auth requirements, and close dependencies on shutdown.
- `apps/server/src/main.ts` — start server with named config errors, redacted logging, and `SIGINT`/`SIGTERM` graceful close.
- `apps/server/src/readiness.ts` — server dependency probes for Postgres, Redis queue, local object directory, hosted allowlist, and node-token readiness.
- `apps/server/src/metrics.ts` — hosted counters/gauges for placement, queue, object, node, dependency, request, and error paths.
- `apps/server/test/hosted-server.test.ts` — config, readiness, metrics, body-limit, token, hosted fake, and restart-persistence coverage.
- `apps/worker/src/config.ts` — production-mode validation for Postgres, Redis, object directory, hosted allowlist, idle interval, lease, and concurrency.
- `apps/worker/src/worker.ts` — readiness probe method, bounded tick loop helper, queue recovery call, fake-only worker wiring, and deterministic stop.
- `apps/worker/src/main.ts` — signal-aware loop using `AbortController` and configurable idle interval/concurrency.
- `apps/worker/test/hosted-worker.test.ts` — graceful stop, config fail-closed, readiness, queue recovery, and expanded forbidden-import guard coverage.
- `apps/node/src/config.ts` — production-mode validation for server URL, shared token, node id, capabilities, local policy, idle interval, and body limits.
- `apps/node/src/app.ts` — deterministic start/tick/stop lifecycle, typed client error handling, bounded artifact sync, and redacted operational logs.
- `apps/node/src/main.ts` — signal-aware node loop with graceful stop.
- `apps/node/test/node-app.test.ts` — node lifecycle, policy denial, typed client errors, config fail-closed, and shutdown coverage.
- `packages/core/src/ports/queue.ts` — queue lease/stats/recovery contract shared by memory and Redis queues.
- `packages/core/src/services/hosted-worker-service.ts` — retry/exhaustion semantics that keep failed jobs inspectable and preserve fake-only validation.
- `packages/core/src/services/hosted-run-service.ts` — placement/queue observability hooks and no-side-effect denial behavior.
- `packages/core/test/hosted-worker-service.test.ts` and `packages/core/test/hosted-placement-service.test.ts` — queue failure, retry, exhaustion, denial, and observability unit coverage.
- `packages/queue/src/bullmq-run-queue.ts` — Redis-backed lease, stale-claim recovery, retry/fail/exhaust state, stats, and readiness probe using existing BullMQ/ioredis.
- `packages/queue/src/memory-run-queue.ts` — test/local parity for the expanded queue contract.
- `packages/queue/test/*` — deterministic memory queue tests plus opt-in Redis crash/recovery integration tests.
- `packages/storage/src/postgres/database.ts` — idempotent schema init plus `probePostgresDatabase` readiness helper.
- `packages/storage/src/local-object-artifact-content-store.ts` — persistent-volume validation, read/write probe, object-key safety, digest/size checks, and named errors.
- `packages/storage/src/object-artifact-content-store.ts` — keep the interface-level store injectable only; no network S3/R2 client wiring.
- `packages/storage/test/*` — Postgres readiness, object-store path/error/restart/digest coverage, and no-S3 dependency guard.
- `packages/protocol-node/src/node-routes.ts` — required-token mode, constant-time auth, route body limits, content parser, and named node/body errors.
- `packages/protocol-node/src/node-client.ts` — typed non-2xx/network/decode errors and raw artifact content response validation.
- `packages/protocol-node/test/node-routes.test.ts` — node auth, body limit, typed route errors, event/artifact sync, and token-redaction coverage.
- `packages/contracts/src/endpoint-inventory.ts` — add `put` support, hosted/node surface tags, and node endpoint descriptors without changing default local-daemon inventory.
- `packages/contracts/src/openapi.ts` — add schemas and generation options for hosted/node inventory while preserving local default output.
- `packages/contracts/src/node.ts`, `packages/contracts/src/assignment.ts`, and `packages/contracts/src/http-error.ts` — exported request/response/error schemas required by node contracts.
- `packages/contracts/src/*test.ts` — local OpenAPI compatibility, hosted/node inventory generation, node-route drift, and error-code drift coverage.
- `deploy/self-hosted/docker-compose.yml` — local self-hosted/staging stack for Postgres, Redis, server, worker, node, and shared object volume.
- `deploy/self-hosted/.env.example` — redacted sample variables with explicit fake-only hosted allowlist.
- `packages/testkit/src/self-hosted-smoke.ts` and tests — no-spend smoke runner for hosted fake and connected-node restart flows.
- `package.json` and package manifests only as required — add smoke scripts and workspace build/test wiring.
- `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `PRODUCT.md` — update user-facing truth after implementation is verified.

## Existing Context

- `docs/superpowers/specs/2026-05-30-phase-11-r12-production-hosting-foundation.md` defines the R12 goals, shadow paths, acceptance criteria, and non-goals.
- `PROJECT.md` Phase 10 records that R11 shipped SDK/CLI/local contracts but left production hosting unshipped.
- `apps/server/src/app.ts` currently falls back to `MemoryRunQueue` and `MemoryArtifactContentStore` when Redis/object config is absent and exposes only shallow `/health`.
- `apps/server/src/config.ts` currently has optional `postgresUrl`, `redisUrl`, `objectStoreDir`, and `nodeSharedToken`; R12 must add deployment-mode validation.
- `apps/worker/src/main.ts` currently loops forever with a fixed 200 ms sleep and no signal handling.
- `apps/worker/src/worker.ts` already uses `FakeRuntimeAdapter` only; R12 must preserve this import boundary.
- `packages/core/src/services/hosted-worker-service.ts` revalidates durable hosted fake state at claim time but currently calls `fail()` and then `ack()`, which removes failed queue visibility.
- `packages/queue/src/bullmq-run-queue.ts` currently removes waiting jobs during `claim()` and stores claimed data in a side hash with no lease recovery.
- `packages/storage/src/postgres/database.ts` creates existing R10 tables idempotently and should gain readiness probes, not a second hosted schema.
- `packages/storage/src/local-object-artifact-content-store.ts` writes object-shaped metadata to a local root and should become the self-hosted persistent-volume backend.
- `packages/protocol-node/src/node-routes.ts` has a shared-token pre-handler but treats missing token config as open routes; production must fail closed.
- `packages/protocol-node/src/node-client.ts` currently returns `response.json()` for every status and must become error-aware.
- `packages/contracts/src/endpoint-inventory.ts` currently supports only `get`/`post` and only `local_daemon`; node routes require `put` and an additive hosted/node surface.
- `packages/contracts/src/openapi.ts` defaults to `LOCAL_DAEMON_ROUTE_INVENTORY`; R12 must preserve that default for R11 compatibility.

## Task Graph

### Task P11-T1-production-hosting-foundation: Harden Hosted Fake, Worker, Node, Queue, Storage, Contracts, And Self-Hosted Smoke

**Files (owned):**

- Modify/create `apps/server/src/config.ts`
- Modify/create `apps/server/src/app.ts`
- Modify/create `apps/server/src/main.ts`
- Create `apps/server/src/readiness.ts`
- Create `apps/server/src/metrics.ts`
- Modify/create `apps/server/test/hosted-server.test.ts`
- Modify/create `apps/worker/src/config.ts`
- Modify/create `apps/worker/src/worker.ts`
- Modify/create `apps/worker/src/main.ts`
- Modify/create `apps/worker/test/hosted-worker.test.ts`
- Modify/create `apps/node/src/config.ts`
- Modify/create `apps/node/src/app.ts`
- Modify/create `apps/node/src/main.ts`
- Modify/create `apps/node/test/node-app.test.ts`
- Modify/create `packages/core/src/ports/queue.ts`
- Modify/create `packages/core/src/services/hosted-worker-service.ts`
- Modify/create `packages/core/src/services/hosted-run-service.ts`
- Modify/create `packages/core/test/hosted-worker-service.test.ts`
- Modify/create `packages/core/test/hosted-placement-service.test.ts`
- Modify/create `packages/queue/src/bullmq-run-queue.ts`
- Modify/create `packages/queue/src/memory-run-queue.ts`
- Modify/create `packages/queue/src/index.ts`
- Modify/create `packages/queue/test/*`
- Modify/create `packages/storage/src/postgres/database.ts`
- Modify/create `packages/storage/src/local-object-artifact-content-store.ts`
- Modify/create `packages/storage/src/object-artifact-content-store.ts`
- Modify/create `packages/storage/src/index.ts`
- Modify/create `packages/storage/test/*`
- Modify/create `packages/protocol-node/src/node-routes.ts`
- Modify/create `packages/protocol-node/src/node-client.ts`
- Modify/create `packages/protocol-node/src/index.ts`
- Modify/create `packages/protocol-node/test/node-routes.test.ts`
- Modify/create `packages/protocol-rest/src/http-errors.ts`
- Modify/create `packages/contracts/src/endpoint-inventory.ts`
- Modify/create `packages/contracts/src/openapi.ts`
- Modify/create `packages/contracts/src/node.ts`
- Modify/create `packages/contracts/src/assignment.ts`
- Modify/create `packages/contracts/src/http-error.ts`
- Modify/create `packages/contracts/src/*test.ts`
- Modify/create `packages/contracts/openapi.local-daemon.json`
- Create `deploy/self-hosted/docker-compose.yml`
- Create `deploy/self-hosted/.env.example`
- Create/modify `packages/testkit/src/self-hosted-smoke.ts`
- Create/modify `packages/testkit/src/self-hosted-smoke.test.ts`
- Modify/create `packages/testkit/src/index.ts`
- Modify `package.json`
- Modify package manifests and `pnpm-lock.yaml` only if scripts or existing dependency metadata require it
- Modify user-facing docs after verification: `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `PRODUCT.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md`

**Dependencies:** none

**Context files (MUST read before coding):**

- `docs/superpowers/specs/2026-05-30-phase-11-r12-production-hosting-foundation.md` — phase acceptance, shadow paths, and non-goals.
- `PROJECT.md` — prior shipped truth and R11 closeout.
- `package.json` — workspace scripts and existing no-spend check conventions.
- `apps/server/src/app.ts` — current hosted server wiring and shallow health route.
- `apps/server/src/config.ts` — current optional server env parsing.
- `apps/server/test/hosted-server.test.ts` — existing hosted fake run and config tests.
- `apps/worker/src/worker.ts` — current worker wiring and fake-only adapter imports.
- `apps/worker/src/main.ts` — current unbounded polling loop.
- `apps/worker/test/hosted-worker.test.ts` — current worker fake path and forbidden-import guard.
- `apps/node/src/app.ts` — current connected-node register/heartbeat/claim/sync/complete flow.
- `apps/node/src/config.ts` — current optional token and policy parsing.
- `apps/node/test/node-app.test.ts` — current node happy path and policy-denial tests.
- `packages/core/src/ports/queue.ts` — queue contract that memory and Redis implementations must share.
- `packages/core/src/services/hosted-worker-service.ts` — durable fake-only validation and retry behavior.
- `packages/core/src/services/hosted-run-service.ts` — placement/enqueue path and queue failure behavior.
- `packages/queue/src/bullmq-run-queue.ts` — current Redis queue claim/retry/ack implementation.
- `packages/queue/src/memory-run-queue.ts` — current local/test queue implementation.
- `packages/storage/src/postgres/database.ts` — current schema initialization and Postgres handle.
- `packages/storage/src/local-object-artifact-content-store.ts` — current local object write/read behavior.
- `packages/storage/src/object-artifact-content-store.ts` — interface-level S3/R2-shaped store that must remain unwired.
- `packages/protocol-node/src/node-routes.ts` — current shared-token hook and node routes.
- `packages/protocol-node/src/node-client.ts` — current success-shaped client.
- `packages/contracts/src/endpoint-inventory.ts` — current local-daemon-only inventory.
- `packages/contracts/src/openapi.ts` — current default local OpenAPI generation behavior.
- `packages/contracts/src/assignment.ts` — current node assignment request/response schemas.
- `packages/protocol-rest/src/http-errors.ts` — closed HTTP error code set and error envelope owner.
- `docs/development/API.md` — existing user-facing hosted/node truth that must be updated after verification.

**Instructions:**

Implement R12 in the Phase 11 worktree only. Keep hosted execution fake-only and no-spend. Do not add S3/R2 network clients, hosted Codex/Claude/OpenCode/Generic HTTP/AgentField execution, arbitrary subprocesses, PTYs, real tools, enterprise auth, dashboard, or TUI.

Internal implementation order:

1. Add `deploymentMode` parsing to server, worker, and node configs with values `local`, `test`, `staging`, and `production`. Default to `local`. Treat blank strings as missing. In `staging` and `production`, server and worker require `SWITCHYARD_POSTGRES_URL`, `SWITCHYARD_REDIS_URL`, `SWITCHYARD_OBJECT_STORE_DIR`, non-empty `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST`, and `fake.deterministic` in the allowlist. Server also requires `SWITCHYARD_NODE_SHARED_TOKEN` because node routes are mounted. Node requires `SWITCHYARD_SERVER_URL`, `SWITCHYARD_NODE_SHARED_TOKEN`, non-empty capabilities, non-empty allowed runtime modes, non-empty allowed cwd prefixes, and a valid idle interval. Throw named config errors such as `config_required:SWITCHYARD_POSTGRES_URL` and expose only redacted summaries.
2. Add liveness/readiness/metrics to `apps/server`. Keep `/health` dependency-free. Add `/ready` that probes Postgres with a simple query, Redis queue with a lightweight ping/stats call, local object store with a write/read/delete or write/read probe under a reserved probe key, hosted allowlist, and node token config. Add `/metrics` counters for requests, errors, placement decisions/denials, queue enqueue/claim/ack/retry/fail/exhaust/recovery, worker attempts when visible through queue state, object reads/writes/failures, node register/heartbeat/claim/sync/complete/reject, dependency readiness, and config failures.
3. Add graceful lifecycle to server, worker, and node mains. Use Node signal handlers, `AbortController`, and `node:timers/promises` sleeps so tests can stop loops deterministically. Worker config must support `SWITCHYARD_WORKER_IDLE_INTERVAL_MS`, `SWITCHYARD_WORKER_CONCURRENCY`, `SWITCHYARD_QUEUE_LEASE_MS`, and `SWITCHYARD_QUEUE_MAX_ATTEMPTS`. Node config must support `SWITCHYARD_NODE_IDLE_INTERVAL_MS` and artifact/body size bounds.
4. Expand `RunQueuePort` to make production behavior explicit: `claim` creates a bounded lease, `ack` removes completed work, `retry` requeues non-exhausted claimed work, `fail` records failed/exhausted work without deleting inspection data, `discard` removes known stale work, `getJob` returns queued/claimed/failed/exhausted state, `recoverStaleClaims` requeues or exhausts expired leases, and `stats` reports counts. Update memory and Redis queues together. Keep Redis implementation on existing BullMQ/ioredis dependencies; do not add a second queue library. For Redis, `claim` must atomically transition queued work to claimed lease state; a worker crash between removal from the waiting queue and claim persistence must be impossible or tested as recovered by the chosen BullMQ active/stalled mechanism.
5. Update `HostedWorkerService` so terminal/foreign/unsafe durable rows fail the run and leave named queue failure state inspectable. On execution failure, retry until max attempts, then mark the run failed with `worker_retry_exhausted` and queue state exhausted. Do not call `ack` after `fail` if that would delete failed state. Preserve durable validation that only `runtime: "fake"`, `runtimeMode: "fake.deterministic"`, `adapterType: "process"`, `placement: "hosted"`, and an allowlist containing `fake.deterministic` can execute.
6. Harden storage. Add `probePostgresDatabase(handle)` and keep `ensurePostgresSchema(handle)` idempotent. Add local object persistent-volume helpers that validate the root exists or can be created, reject traversal for logical paths and metadata object keys, return named errors for `object_store_unavailable`, `object_store_write_failed`, `artifact_content_not_found`, `artifact_digest_mismatch`, and `artifact_content_empty`, and verify `sizeBytes`/`sha256` on reads when metadata is present. Keep `ObjectArtifactContentStore` injectable only; add tests proving no AWS/R2 SDK dependency is required.
7. Harden node protocol. Use `crypto.timingSafeEqual` for token comparison with a length-safe branch. In staging/production, missing node shared-token configuration must fail before `createServerApp` finishes and before the listener starts. Keep `node_auth_required` route behavior only for explicit local/test route-registration cases where auth is required but no token was configured. Return `node_auth_failed` when a presented token is wrong. Add explicit Fastify JSON body limits and an `application/octet-stream` parser/body limit for artifact content. Oversized bodies must return `payload_too_large` or `invalid_input` before any coordinator, event, artifact, or storage side effect.
8. Harden `NodeClient`. Add `NodeClientHttpError`, `NodeClientNetworkError`, `NodeClientDecodeError`, and optional timeout support using `AbortController`. For non-2xx responses, parse the standard error envelope and throw typed errors with `status`, `code`, `message`, `details`, and `requestId`. For malformed success JSON, throw decode errors. For artifact content sync, verify JSON response shape and handle empty bodies explicitly.
9. Extend `packages/contracts` additively. Add `RouteMethod = "get" | "post" | "put"`, `EndpointSurface = "local_daemon" | "hosted_node"`, `HOSTED_NODE_ROUTE_INVENTORY`, and schema refs for node register, heartbeat, claim, reject, event sync, artifact manifest, artifact content sync, complete, ready, and hosted metrics. Keep `generateOpenApiDocument()` defaulting to the local daemon inventory and keep `openapi.local-daemon.json` compatible except for additive shared schema/error updates. Add a hosted/node generation test and a node-route drift test against a Fastify app with `registerNodeRoutes`.
10. Add self-hosted deployment artifacts. Provide `deploy/self-hosted/docker-compose.yml` for Postgres, Redis, server, worker, optional node, and a shared local object volume. The compose file must be runnable from a fresh checkout without published images: use Node 24-compatible images with the repository mounted read-only or build from an added local Dockerfile/Containerfile, run `corepack enable && pnpm install --frozen-lockfile && pnpm --filter <app> build` or equivalent workspace-safe commands, mount one named shared object volume into server and worker at the same path, expose only the server port, and set `SWITCHYARD_DEPLOYMENT_MODE=staging`, fake-only hosted allowlist, durable Postgres/Redis URLs, and a placeholder node token from `.env.example`. The smoke runner must detect `docker compose` or `docker-compose`, create a unique project name, wait for `/ready`, preserve logs/temp volume paths on failure, restart server/worker through compose, and run cleanup unless `SWITCHYARD_KEEP_SMOKE_STACK=1`. Provide a redacted `.env.example` with fake-only hosted allowlist and node token placeholders. Add `pnpm self-hosted:smoke` or an equivalent root/package script that starts the stack, waits for `/ready`, creates one hosted fake run with `placement: "hosted"`, verifies events/artifact content, restarts server/worker, verifies run/event/artifact persistence, starts or exercises a connected node assignment, and exits without external model/API spend.

Mandatory module checkpoints for the single implementer/reviewer phase:

1. Config/readiness/metrics checkpoint: server/worker/node production config, `/ready`, JSON `/metrics`, and lifecycle tests pass.
2. Queue/worker checkpoint: memory and Redis queue semantics, atomic claim/crash-window coverage, worker retry/exhaustion, and forbidden import guard pass.
3. Storage/node checkpoint: Postgres probes, local object PV hardening, node auth/body/client errors, and node sync error tests pass.
4. Contracts/smoke checkpoint: hosted/node contract inventory is opt-in, local OpenAPI default is preserved, self-hosted smoke script and compose mechanics are testable.
5. Docs/regression checkpoint: docs truth updated narrowly and R11 regression checks pass.
11. Update docs only after checks prove behavior. `API.md` must document `/ready`, hosted metrics, production config, node endpoint contracts, and new error codes. `DEVELOPMENT.md` must document self-hosted smoke commands. Product docs must keep R12 boundaries explicit: local object PV shipped, S3/R2 network clients and hosted real runtimes unshipped.

**Acceptance criteria:**

- [ ] Server, worker, and node parse explicit deployment modes; in staging/production, missing or blank required config fails startup with named errors and redacted output.
- [ ] Memory Postgres-shaped stores, memory queue, and memory artifact content are allowed only in local/test mode.
- [ ] Server exposes `/health`, `/ready`, and `/metrics`; `/health` is liveness-only and `/ready` reflects Postgres, Redis, object store, hosted allowlist, and node-token readiness.
- [ ] Server/worker/node mains handle `SIGINT` and `SIGTERM`, close dependencies, and have deterministic stop behavior in tests.
- [ ] Worker supports configurable idle interval, concurrency, queue lease, and max attempts without leaving unbounded loops in tests.
- [ ] Redis and memory queues support lease-based claim, ack, retry, fail/exhaust, stale-claim recovery, and inspectable failed/exhausted job state.
- [ ] Worker crash after claim and before ack is recoverable through stale lease recovery or bounded exhaustion after max attempts.
- [ ] Postgres schema initialization remains idempotent and readiness uses a real database probe when `SWITCHYARD_TEST_POSTGRES_URL` or self-hosted smoke is active.
- [ ] Hosted run metadata, events, artifacts, sessions, nodes, and assignments survive server and worker restart in self-hosted smoke.
- [ ] Local object artifact store validates paths/object keys, probes read/write, preserves metadata, survives restart, and returns named errors for missing, unreadable, empty-invalid, digest mismatch, and write failures.
- [ ] No AWS/R2/S3 SDK dependency or network object-store client is required or wired for the hosted smoke path.
- [ ] Hosted worker imports and instantiates only the fake deterministic runtime path; import-guard tests fail on Codex, Claude, OpenCode, Generic HTTP, AgentField, ACP process, browser, shell, search, GitHub, fetch, repo, generic process, or PTY adapter imports.
- [ ] Hosted API rejects any hosted unsafe runtime before queueing, and worker revalidates durable run rows before execution.
- [ ] Node routes require token configuration outside local/test, compare tokens with timing-safe comparison, return `node_auth_required` or `node_auth_failed`, and never log token values.
- [ ] `NodeClient` converts non-2xx, network, timeout, and decode failures into typed errors instead of returning success-shaped data.
- [ ] Node JSON routes and artifact content sync have explicit body limits; oversize requests fail before storage side effects.
- [ ] `packages/contracts` includes additive hosted/node endpoint inventory and schemas while preserving default local-daemon OpenAPI generation.
- [ ] Self-hosted smoke starts Postgres, Redis, shared object storage, server, worker, and connected node flow; it completes hosted fake and connected-node assignments with no external model/API spend.
- [ ] Logs and metrics include named placement, queue, worker, object, node, readiness, dependency, and config failure signals.
- [ ] Existing R11 SDK/CLI/local contract generation, local daemon behavior, storage fixture, adapter no-spend, packaging, `pnpm test`, and `pnpm typecheck` checks pass or are updated only for additive contract/error surfaces.

**Checks (must pass before GREEN):**

- `pnpm --filter @switchyard/server test`
- `pnpm --filter @switchyard/worker test`
- `pnpm --filter @switchyard/node test`
- `pnpm --filter @switchyard/queue test`
- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/protocol-node test`
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/contracts openapi:check`
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/daemon test`
- `pnpm --filter @switchyard/sdk test`
- `pnpm --filter @switchyard/cli test`
- `pnpm --filter @switchyard/adapters test`
- `pnpm self-hosted:smoke`
- `pnpm test`
- `pnpm typecheck`
- `git diff --check`
- `rg -n "CodexExecJsonAdapter|ClaudeCodeAdapter|OpenCodeAcpAdapter|GenericHttpAsyncRestAdapter|AgentFieldAsyncRestAdapter|@switchyard/adapters|pty|browser|shell|github|fetch|repo" apps/worker/src`

**Error rescue map:**

| Method / codepath | What can go wrong | Exception / condition | Rescue action | User sees |
| --- | --- | --- | --- | --- |
| `loadServerConfig`, `loadWorkerConfig`, `loadNodeConfig` | required staging/production env var missing or blank | explicit validation condition | throw `ConfigError` with `code: "config_required"` and `variable` | process exits non-zero with `config_required:<VAR>` and redacted config summary |
| config redaction | URL or token contains credentials | explicit redaction path | strip passwords, tokens, and query secrets before logs/errors | operator sees host/db/path presence only, never secret bytes |
| hosted allowlist validation | production allowlist empty or lacks `fake.deterministic` | explicit validation condition | throw `config_required:SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST` or `hosted_runtime_not_allowed` | startup fails before listening |
| server store selection | production config would fall back to memory store/queue/content | explicit deployment-mode branch | throw config error before app creation completes | startup fails; `/health` is never exposed on unsafe config |
| `/ready` Postgres probe | database unavailable/auth/schema failure | `pg` query rejection or schema init rejection | readiness component returns `{ ok:false, code:"postgres_unavailable" }` | `/ready` returns 503 with component failure and redacted DSN |
| `/ready` Redis probe | Redis unavailable or command timeout | ioredis/BullMQ rejection | readiness component returns `{ ok:false, code:"redis_unavailable" }` | `/ready` returns 503; metrics increments dependency failure |
| `/ready` object probe | object dir missing, unwritable, unreadable, or digest mismatch | fs `ENOENT`/`EACCES` or explicit digest mismatch | readiness component returns named object error | `/ready` returns 503 with object-store component code |
| `/metrics` collection | queue stats read fails | queue stats rejection | return metrics with `queue.available:false` and increment metrics failure counter | operator sees degraded metric instead of 500 where possible |
| `/metrics` schema | metric code tries to emit high-cardinality or secret values | explicit schema/redaction validation | reject unsafe labels/fields in tests and keep JSON counters/gauges bounded | operator sees stable JSON metrics without task/cwd/token/DSN/object-key leaks |
| `HostedRunService.createRun` | hosted unsafe runtime requested | placement decision reject | return `placement_denied` before run/queue side effect when possible | HTTP 409 with `hosted_runtime_not_allowed` detail |
| `HostedRunService.createRun` | Redis enqueue fails after run creation | queue enqueue rejection | mark run failed with `queue_enqueue_failed`, append event, return `queue_unavailable` | HTTP 503; run is visible as failed |
| `RunQueuePort.claim` | worker dies after claim before ack | lease expires | `recoverStaleClaims` requeues if attempts remain, exhausts if max attempts reached | metrics/logs show `queue.recovered` or `queue.exhausted`; run eventually completes or fails |
| `BullMqRunQueue.claim` | process fails between waiting removal and claimed lease persistence | injected crash-window failure | atomic claim implementation prevents the window, or recovery test proves no orphan by requeue/exhaust | queue state remains inspectable; no job disappears |
| `RunQueuePort.fail` | failed job state could be deleted by ack | explicit state invariant | do not call `ack` after `fail`; keep failed/exhausted state inspectable | operator can inspect reason code by job id |
| `BullMqRunQueue` | corrupt claimed payload in Redis | `JSON.parse` failure | move entry to failed/exhausted state with `queue_payload_invalid` and bounded raw sample | metrics/logs name invalid payload without leaking full body |
| `HostedWorkerService.processNext` | durable run missing, terminal, non-hosted, or unsafe | explicit durable validation | fail job/run with `hosted_run_state_invalid` or `hosted_runtime_not_allowed` | run failed event and queue reason code |
| `HostedWorkerService.processNext` | fake execution fails transiently | adapter/startRun error | retry until max attempts | run remains queued/running and metrics increments retry |
| `HostedWorkerService.processNext` | fake execution fails past max attempts | attempts >= maxAttempts | mark run failed with `worker_retry_exhausted`, fail/exhaust job | run failed event with exhaustion reason |
| worker loop sleep | shutdown during idle sleep | `AbortError` from timers/promises | break loop, call `worker.stop()` once | process exits cleanly |
| worker concurrency | in-flight tick fails during shutdown | promise rejection | wait bounded drain, fail/retry claimed job according to queue state, close dependencies | structured log names failed drain |
| `ensurePostgresSchema` | schema init query fails | `pg` query rejection | close pool and surface named readiness/startup failure | startup fails or `/ready` returns postgres failure |
| `probePostgresDatabase` | probe query fails after startup | `pg` query rejection | return readiness component failure without mutating schema or closing healthy app state | `/ready` returns postgres_unavailable and metrics increments dependency failure |
| `LocalObjectArtifactContentStore.writeBytes` | logical path escapes root | explicit path check | throw named `invalid_input` or `object_store_write_failed` | HTTP/node sync error with safe message |
| `LocalObjectArtifactContentStore.read` | file missing or unreadable | fs `ENOENT`/`EACCES` | throw `artifact_content_not_found` or `object_store_unavailable` | artifact content route returns 404/503 named error |
| `LocalObjectArtifactContentStore.read` | metadata digest/size mismatches bytes | explicit sha256/size check | throw `artifact_digest_mismatch` | assignment fails or content route reports digest mismatch |
| `LocalObjectArtifactContentStore.writeBytes` | zero-byte transcript without explicit zero-size metadata | explicit content check | throw `artifact_content_empty` | run/assignment fails with named reason |
| `ObjectArtifactContentStore` | accidental S3/R2 dependency added | import/dependency guard test | fail test if AWS/R2 SDK appears in package deps/imports for smoke path | developer sees no-S3 guard failure |
| node route preHandler | production token config missing | explicit dependency option | return `node_auth_required` before route handling | HTTP 401, no coordinator side effect |
| node route preHandler | token missing or invalid | timing-safe comparison false | return `node_auth_failed` | HTTP 401 and no token in logs |
| node JSON routes | body exceeds configured limit | Fastify body limit error | map to `payload_too_large` or `invalid_input` | HTTP 413/400 before service side effects |
| node artifact content route | binary body exceeds configured limit | Fastify content parser/body limit | return `payload_too_large` | HTTP 413 before artifact write |
| `NodeClient.post` register/heartbeat/claim | server returns non-2xx error envelope | response status >= 400 | throw `NodeClientHttpError` preserving code/details/requestId | node app logs typed remote error and leaves the tick idle or failed according to the command result |
| `NodeClient.post` assignment reject/complete/sync | server returns non-2xx error envelope | response status >= 400 | throw `NodeClientHttpError` preserving code/details/requestId | node app marks current assignment failed locally when possible and stops that tick |
| `NodeClient.post` | server returns malformed JSON success | JSON parse or schema validation failure | throw `NodeClientDecodeError` | node app completes assignment failed with decode reason |
| `NodeClient` fetch | network failure or timeout | fetch rejection or `AbortError` | throw `NodeClientNetworkError` or `NodeClientTimeoutError` | node app logs redacted server URL and retries on next tick |
| artifact sync service | manifest/content digest mismatch | explicit sha256/size check | fail assignment with `artifact_digest_mismatch` | node receives 409 and assignment is failed |
| event sync service | event sequence gap/conflict | existing `event_sync_gap` or `event_sync_conflict` | return typed HTTP error without appending conflicting event | node receives 409 and can fail assignment |
| OpenAPI generation | hosted/node schema ref missing | explicit schema lookup failure | fail contracts test and generation | developer sees missing schema ref |
| local OpenAPI compatibility | default generation includes hosted/node paths unexpectedly | route inventory/default option mismatch | fail local OpenAPI drift test | developer sees additive surface leaked into local contract |
| OpenAPI generation | unsupported method/content type appears in hosted/node inventory | explicit descriptor validation | fail contracts test before writing generated artifact | developer sees method/path/content type causing drift |
| self-hosted smoke | Docker/compose unavailable | child process exit or missing binary | fail `pnpm self-hosted:smoke` with named prerequisite error | operator sees exact missing prerequisite |
| self-hosted smoke | compose service fails readiness wait | readiness timeout | collect compose ps/logs, preserve temp paths, and fail named step | developer sees readiness timeout plus service logs |
| self-hosted smoke | server/worker restart loses artifact content | smoke assertion failure | fail smoke, preserve logs and temp volume path | developer sees persistence assertion failure |
| forbidden import guard | worker imports real adapters/tools | `rg` or test match | fail test/check before GREEN | reviewer sees exact forbidden import path |

**Observability:**

```json
{
  "logs": [
    "server.config.invalid code variable deploymentMode redactedConfig",
    "server.ready component status code latencyMs",
    "server.placement.decision runId decision reason runtimeMode",
    "server.queue.enqueue runId jobId runtimeMode",
    "queue.claim jobId runId attempts leaseExpiresAt",
    "queue.ack jobId runId",
    "queue.retry jobId runId attempts reasonCode",
    "queue.fail jobId runId reasonCode exhausted",
    "queue.recover_stale jobId runId action attempts",
    "worker.tick result idle|processed|retry|failed durationMs",
    "worker.shutdown signal inFlight drained",
    "object.write path storageBackend sizeBytes sha256",
    "object.read path sizeBytes digestVerified",
    "node.auth.failed reason requestId",
    "node.register nodeId capabilityCount",
    "node.heartbeat nodeId status",
    "node.claim nodeId assignmentId result",
    "node.sync.events assignmentId appended nextCursor",
    "node.sync.artifact assignmentId artifactId sizeBytes",
    "node.complete assignmentId status",
    "self_hosted_smoke.step name status durationMs"
  ],
  "success_metric": "self-hosted smoke completes hosted fake and connected-node flows, /ready is ok before run creation, restart persistence assertions pass, and forbidden worker import guard is clean",
  "failure_metric": "named counters for config_required, dependency readiness failures, queue retry/exhaustion, object store failures, node auth failures, payload_too_large, and hosted_runtime_not_allowed are incremented and visible through /metrics or smoke output"
}
```

**Test cases:**

- `{ "name": "server_local_mode_allows_memory_fallbacks", "lens": "happy_shadow_nil", "given": "createServerApp with deploymentMode local and no postgres/redis/object dir", "expect": "app starts, /health returns 200, hosted fake wait test still passes" }`
- `{ "name": "server_production_requires_postgres_redis_object_and_node_token", "lens": "happy_shadow_nil", "given": "loadServerConfig with SWITCHYARD_DEPLOYMENT_MODE=production and missing required vars", "expect": "ConfigError names each missing var and redacts secrets" }`
- `{ "name": "worker_production_requires_durable_dependencies", "lens": "happy_shadow_nil", "given": "loadWorkerConfig production without Postgres, Redis, or object dir", "expect": "ConfigError with config_required codes before worker creation" }`
- `{ "name": "node_production_requires_token_and_policy", "lens": "happy_shadow_nil", "given": "loadNodeConfig production without token or allowed runtime modes", "expect": "ConfigError before node start" }`
- `{ "name": "blank_env_treated_as_missing", "lens": "happy_shadow_empty", "given": "required env vars set to whitespace", "expect": "same config_required errors as unset vars" }`
- `{ "name": "config_redacts_credentials", "lens": "error_path", "given": "Postgres URL with password and node token", "expect": "error/log summary excludes password and token" }`
- `{ "name": "ready_reports_all_components_ok", "lens": "integration", "given": "server with test Postgres/Redis/object dir or self-hosted stack", "expect": "GET /ready returns 200 with postgres, redis, objectStore, hostedAllowlist, nodeToken all ok" }`
- `{ "name": "ready_reports_postgres_failure", "lens": "error_path", "given": "server readiness probe with unreachable Postgres", "expect": "GET /ready returns 503 and component code postgres_unavailable" }`
- `{ "name": "ready_reports_redis_failure", "lens": "error_path", "given": "server readiness probe with unreachable Redis", "expect": "GET /ready returns 503 and component code redis_unavailable" }`
- `{ "name": "ready_reports_object_store_failure", "lens": "error_path", "given": "object dir unwritable or digest probe mismatch", "expect": "GET /ready returns 503 with object-store code" }`
- `{ "name": "metrics_counts_hosted_operations", "lens": "happy", "given": "hosted fake run plus node register/claim/sync", "expect": "/metrics includes placement, queue, object, node, dependency, request, and error counters" }`
- `{ "name": "metrics_queue_stats_failure_degrades", "lens": "error_path", "given": "queue stats dependency rejects during /metrics", "expect": "/metrics returns stable JSON with queue.available false and errors.metricsCollection incremented" }`
- `{ "name": "metrics_schema_redacts_high_cardinality_values", "lens": "error_path", "given": "metrics inputs include task text, cwd, DSN, token, object key, and run id", "expect": "JSON metrics omit those values and expose only bounded counters/gauges" }`
- `{ "name": "server_graceful_shutdown_closes_dependencies", "lens": "integration", "given": "server main receives SIGTERM in test harness", "expect": "Fastify close, queue close, and Postgres close are called once" }`
- `{ "name": "worker_loop_stops_during_idle_sleep", "lens": "happy_shadow_empty", "given": "worker loop idling with AbortController aborted", "expect": "loop exits and stop closes queue/Postgres once" }`
- `{ "name": "worker_concurrency_drains_on_shutdown", "lens": "integration", "given": "two in-flight ticks and shutdown signal", "expect": "bounded drain completes or named drain failure is logged without dangling loop" }`
- `{ "name": "worker_concurrency_drain_failure", "lens": "error_path", "given": "in-flight tick rejects during shutdown", "expect": "claimed job is retried or failed according to queue state and drain failure is logged" }`
- `{ "name": "node_loop_stops_during_idle_sleep", "lens": "happy_shadow_empty", "given": "node loop idling and abort signal", "expect": "loop exits and node stop is called" }`
- `{ "name": "memory_queue_lease_retry_ack", "lens": "happy", "given": "enqueue, claim with lease, retry, claim again, ack", "expect": "attempts increment, ack removes completed job, stats reflect zero queued/claimed" }`
- `{ "name": "memory_queue_stale_recovery_requeues", "lens": "error_path", "given": "claimed job past lease with attempts below max", "expect": "recoverStaleClaims requeues and stats increments recovered" }`
- `{ "name": "memory_queue_stale_recovery_exhausts", "lens": "error_path", "given": "claimed job past lease at max attempts", "expect": "recoverStaleClaims marks exhausted with reason worker_retry_exhausted and getJob still returns it" }`
- `{ "name": "bullmq_claim_does_not_orphan_on_crash", "lens": "integration", "given": "Redis queue claim without ack followed by new queue instance and stale recovery", "expect": "job is requeued or exhausted by bounded policy, never permanently missing" }`
- `{ "name": "bullmq_atomic_claim_crash_window", "lens": "error_path", "given": "injected failure at queued-to-claimed transition boundary", "expect": "job is still queued, claimed, requeued, or exhausted; never absent from all states" }`
- `{ "name": "bullmq_failed_job_inspectable", "lens": "error_path", "given": "queue.fail called with reason", "expect": "getJob returns failed/exhausted state with reasonCode until discard" }`
- `{ "name": "bullmq_corrupt_claimed_payload", "lens": "error_path", "given": "invalid JSON in claimed hash", "expect": "recovery records queue_payload_invalid failure without throwing unhandled error" }`
- `{ "name": "hosted_worker_rejects_missing_run", "lens": "error_path", "given": "claimed job references absent run", "expect": "job failed with hosted_run_state_invalid and failed state remains inspectable" }`
- `{ "name": "hosted_worker_rejects_terminal_or_foreign_run", "lens": "error_path", "given": "claimed job references completed or local-placement run", "expect": "run/job fail with hosted_run_state_invalid" }`
- `{ "name": "hosted_worker_rejects_non_fake_runtime", "lens": "error_path", "given": "durable row runtimeMode codex.exec_json", "expect": "startRun is not called; run/job fail with hosted_runtime_not_allowed" }`
- `{ "name": "hosted_worker_retries_then_completes", "lens": "integration", "given": "startRun throws once then succeeds", "expect": "first tick retries, second tick completes and acks" }`
- `{ "name": "hosted_worker_exhausts_after_max_attempts", "lens": "error_path", "given": "startRun always throws and attempts reach max", "expect": "run failed with worker_retry_exhausted and queue exhausted state remains inspectable" }`
- `{ "name": "hosted_run_enqueue_failure_marks_run_failed", "lens": "error_path", "given": "queue.enqueue throws", "expect": "HTTP 503 queue_unavailable and run.failed event queue_enqueue_failed" }`
- `{ "name": "hosted_unsafe_runtime_not_queued", "lens": "error_path", "given": "POST /runs placement hosted runtimeMode codex.exec_json", "expect": "409 placement_denied and queue enqueue count unchanged" }`
- `{ "name": "postgres_schema_idempotent_and_probe", "lens": "integration", "given": "real Postgres URL or self-hosted Postgres", "expect": "ensurePostgresSchema twice succeeds and probe query returns ok" }`
- `{ "name": "postgres_schema_init_failure_closes_pool", "lens": "error_path", "given": "ensurePostgresSchema receives a handle whose query rejects", "expect": "startup surfaces postgres_unavailable/config failure and pool close is called once" }`
- `{ "name": "postgres_probe_failure_ready_component", "lens": "error_path", "given": "probePostgresDatabase query rejects after startup", "expect": "/ready returns postgres_unavailable without mutating schema" }`
- `{ "name": "postgres_restart_persists_hosted_rows", "lens": "integration", "given": "self-hosted server/worker restart after completed hosted run", "expect": "run, events, artifacts, sessions, nodes, assignments remain queryable" }`
- `{ "name": "local_object_store_rejects_path_traversal", "lens": "error_path", "given": "write path ../escape or metadata objectKey ../escape", "expect": "named invalid_input/object_store_write_failed and no file outside root" }`
- `{ "name": "local_object_store_probe_roundtrip", "lens": "happy", "given": "writable temp object dir", "expect": "probe writes, reads, verifies sha256, and cleans reserved probe object or leaves bounded probe metadata" }`
- `{ "name": "local_object_store_missing_content", "lens": "error_path", "given": "artifact metadata points to missing object", "expect": "artifact_content_not_found mapped to missing content response" }`
- `{ "name": "local_object_store_digest_mismatch", "lens": "error_path", "given": "stored bytes differ from artifact metadata sha256", "expect": "artifact_digest_mismatch and no empty content returned" }`
- `{ "name": "local_object_store_zero_byte_manifest_rules", "lens": "happy_shadow_empty", "given": "zero-byte artifact with sizeBytes 0 and transcript without explicit zero-size metadata", "expect": "explicit zero accepted; implicit empty transcript rejected with artifact_content_empty" }`
- `{ "name": "no_s3_dependency_for_hosted_smoke", "lens": "edge_no_network_object_client", "given": "package manifests and import graph", "expect": "no AWS/R2/S3 SDK dependency or app wiring is required" }`
- `{ "name": "worker_forbidden_import_guard_expanded", "lens": "edge_security_boundary", "given": "apps/worker/src source tree", "expect": "no forbidden adapter/tool/process/PTY imports or class names are present" }`
- `{ "name": "node_auth_required_when_token_config_missing", "lens": "error_path", "given": "registerNodeRoutes in requireAuth mode without shared token", "expect": "POST /nodes/register returns node_auth_required and coordinator not called" }`
- `{ "name": "node_auth_failed_constant_time_path", "lens": "error_path", "given": "wrong token and right-length wrong token", "expect": "401 node_auth_failed and no token log output" }`
- `{ "name": "node_auth_success", "lens": "happy", "given": "correct x-switchyard-node-token", "expect": "node register/heartbeat/claim routes proceed" }`
- `{ "name": "node_json_payload_too_large", "lens": "error_path", "given": "oversized JSON heartbeat body", "expect": "payload_too_large or invalid_input before coordinator call" }`
- `{ "name": "node_artifact_content_payload_too_large", "lens": "error_path", "given": "oversized octet-stream content sync", "expect": "payload_too_large before artifact write" }`
- `{ "name": "node_client_http_error_typed", "lens": "error_path", "given": "server returns 401 node_auth_failed", "expect": "NodeClientHttpError with status, code, message, requestId" }`
- `{ "name": "node_client_network_error_typed", "lens": "error_path", "given": "server URL on closed port", "expect": "NodeClientNetworkError and redacted URL in node app log" }`
- `{ "name": "node_client_timeout_error_typed", "lens": "error_path", "given": "fetch never resolves and timeout elapses", "expect": "NodeClientTimeoutError" }`
- `{ "name": "node_client_decode_error_typed", "lens": "error_path", "given": "200 response with malformed JSON", "expect": "NodeClientDecodeError and node assignment failure reason is bounded" }`
- `{ "name": "node_empty_claim_idles", "lens": "happy_shadow_empty", "given": "claim response { assignment:null, run:null }", "expect": "node tick returns false and does not reject or complete" }`
- `{ "name": "node_assignment_missing_run_rejects", "lens": "happy_shadow_nil", "given": "claim response with assignment and null run", "expect": "node rejects assignment_missing_run" }`
- `{ "name": "node_event_sync_gap_and_conflict", "lens": "error_path", "given": "event sequence gap or conflicting retry", "expect": "409 event_sync_gap/event_sync_conflict and no conflicting append" }`
- `{ "name": "node_artifact_digest_mismatch_fails_assignment", "lens": "error_path", "given": "artifact content bytes do not match manifest sha256", "expect": "409 artifact_digest_mismatch and assignment failed" }`
- `{ "name": "contracts_local_openapi_default_preserved", "lens": "integration", "given": "generateOpenApiDocument() default", "expect": "local daemon paths remain the default and hosted/node paths are absent unless requested" }`
- `{ "name": "contracts_local_openapi_leak_rejected", "lens": "error_path", "given": "default local OpenAPI generation includes hosted/node paths", "expect": "contracts test fails with leaked method/path" }`
- `{ "name": "contracts_hosted_node_inventory_generates", "lens": "integration", "given": "generateOpenApiDocument with hosted/node inventory", "expect": "node register, heartbeat, claim, reject, events, artifact manifest/content, complete paths and schemas present" }`
- `{ "name": "contracts_missing_schema_ref_rejected", "lens": "error_path", "given": "hosted/node descriptor with missing schema ref", "expect": "generation fails naming method/path/schema ref" }`
- `{ "name": "contracts_unsupported_method_or_content_rejected", "lens": "error_path", "given": "descriptor with unsupported method/content type", "expect": "generation fails before writing artifact" }`
- `{ "name": "contracts_put_method_supported", "lens": "happy", "given": "node artifact content PUT descriptor", "expect": "OpenAPI path renders put operation with binary request body" }`
- `{ "name": "contracts_node_route_drift", "lens": "integration", "given": "Fastify app with registerNodeRoutes", "expect": "HOSTED_NODE_ROUTE_INVENTORY method/path set equals registered node routes" }`
- `{ "name": "contracts_error_codes_include_r12", "lens": "integration", "given": "protocol-rest HTTP error codes", "expect": "contracts http error schema accepts node_auth_required, payload_too_large, queue_unavailable, hosted_runtime_not_allowed, object/artifact codes" }`
- `{ "name": "self_hosted_smoke_hosted_fake", "lens": "integration", "given": "compose stack with Postgres, Redis, server, worker, object volume", "expect": "POST /runs?wait=1 hosted fake completes with replayable events and artifact content" }`
- `{ "name": "self_hosted_smoke_compose_unavailable", "lens": "error_path", "given": "neither docker compose nor docker-compose exists", "expect": "pnpm self-hosted:smoke fails with named prerequisite error and no misleading partial success" }`
- `{ "name": "self_hosted_smoke_readiness_timeout", "lens": "error_path", "given": "server never reaches /ready before timeout", "expect": "smoke preserves compose ps/logs/temp volume path and names readiness timeout step" }`
- `{ "name": "self_hosted_smoke_restart_persistence", "lens": "integration", "given": "completed hosted fake run then server/worker restart", "expect": "run metadata, events, artifact metadata, and artifact content are still readable" }`
- `{ "name": "self_hosted_smoke_connected_node", "lens": "integration", "given": "server plus node app with token and fake capability", "expect": "connected_local_node assignment claims, syncs event/artifact, and completes without external spend" }`
- `{ "name": "self_hosted_smoke_no_external_model_spend", "lens": "edge_no_spend", "given": "smoke environment with no provider credentials", "expect": "only fake.deterministic runtime is used and smoke passes" }`
- `{ "name": "docs_production_truth_updated", "lens": "integration", "given": "docs after implementation", "expect": "API and development docs mention R12 shipped boundaries and keep S3/R2/hosted real runtimes unshipped" }`
- `{ "name": "r11_regression_checks", "lens": "integration", "given": "R11 SDK/CLI/contracts/daemon/storage/adapters checks", "expect": "existing checks pass with only additive contract/error changes" }`

**Integration contracts:**

```json
{
  "exports": [
    {
      "name": "DeploymentMode",
      "kind": "constant",
      "signature": "\"local\" | \"test\" | \"staging\" | \"production\""
    },
    {
      "name": "ConfigError",
      "kind": "class",
      "signature": "class ConfigError extends Error { code: string; variable?: string; redactedConfig?: Record<string, unknown> }"
    },
    {
      "name": "createServerApp",
      "kind": "function",
      "signature": "createServerApp(config: ServerConfig) => Promise<FastifyInstance>"
    },
    {
      "name": "createHostedWorker",
      "kind": "function",
      "signature": "createHostedWorker(config: WorkerConfig, deps?: WorkerTestDeps) => HostedWorkerApp"
    },
    {
      "name": "createNodeApp",
      "kind": "function",
      "signature": "createNodeApp(config: NodeAppConfig, deps?: NodeAppTestDeps) => NodeApp"
    },
    {
      "name": "RunQueuePort",
      "kind": "class",
      "signature": "interface RunQueuePort { enqueue(...); claim(options?: { leaseMs?: number }): Promise<RunQueueClaimedJob | undefined>; ack(jobId: string): Promise<void>; fail(jobId: string, error: QueueFailure): Promise<void>; retry(jobId: string): Promise<void>; discard(jobId: string): Promise<void>; getJob(jobId: string): Promise<RunQueueJobSnapshot | undefined>; recoverStaleClaims(options?: { now?: string }): Promise<RunQueueRecoveryResult>; stats(): Promise<RunQueueStats> }"
    },
    {
      "name": "BullMqRunQueue",
      "kind": "class",
      "signature": "new BullMqRunQueue(options: { redisUrl: string; queueName?: string; leaseMs?: number; maxAttempts?: number })"
    },
    {
      "name": "MemoryRunQueue",
      "kind": "class",
      "signature": "new MemoryRunQueue(options?: { leaseMs?: number; maxAttempts?: number; now?: () => string })"
    },
    {
      "name": "probePostgresDatabase",
      "kind": "function",
      "signature": "probePostgresDatabase(handle: PostgresDatabaseHandle) => Promise<{ ok: true }>"
    },
    {
      "name": "LocalObjectArtifactContentStore",
      "kind": "class",
      "signature": "new LocalObjectArtifactContentStore(root: string, keyPrefix?: string)"
    },
    {
      "name": "NodeClient",
      "kind": "class",
      "signature": "new NodeClient(options: { baseUrl: string; sharedToken?: string; fetchImpl?: typeof fetch; timeoutMs?: number })"
    },
    {
      "name": "NodeClientHttpError",
      "kind": "class",
      "signature": "class NodeClientHttpError extends Error { status: number; code: HttpErrorCode; details?: HttpErrorDetail[]; requestId?: string }"
    },
    {
      "name": "HOSTED_NODE_ROUTE_INVENTORY",
      "kind": "constant",
      "signature": "readonly RouteInventoryEntry[]"
    },
    {
      "name": "generateOpenApiDocument",
      "kind": "function",
      "signature": "generateOpenApiDocument(options?: { inventory?: readonly RouteInventoryEntry[] }) => OpenApiDocument"
    },
    {
      "name": "runSelfHostedSmoke",
      "kind": "function",
      "signature": "runSelfHostedSmoke(options?: { composeFile?: string; projectName?: string; timeoutMs?: number }) => Promise<SelfHostedSmokeResult>"
    }
  ],
  "imports_from_other_tasks": [],
  "file_paths_consumed_by_other_tasks": []
}
```

## Risks

- The user requested one implementer/reviewer for the whole phase. That intentionally exceeds the CTO prompt's preferred task granularity and creates review load. The mitigation is a single task with ordered modules, exact checks, and broad test enumeration.
- `pnpm self-hosted:smoke` depends on Docker or a compatible compose runtime. Unit tests should cover harness behavior without Docker, but the full GREEN check should require the real stack.
- Queue durability is the riskiest behavior change because current Redis claim removes waiting jobs. Reviewer should inspect claim/fail/ack invariants carefully and verify failed/exhausted jobs remain inspectable.
- OpenAPI must not leak hosted/node paths into the default local-daemon artifact. Keep hosted/node inventory opt-in unless the CLI explicitly asks for it.
- Local object persistent-volume support can look like S3 readiness if docs are imprecise. Docs and tests must state that S3/R2 network clients remain unshipped.

## Integration Points

The server, worker, and node apps share config semantics but keep app-specific validation. Queue contract changes flow from `packages/core/src/ports/queue.ts` into both `packages/queue` implementations and `HostedWorkerService`. Storage probes are imported by server and worker readiness/startup paths. Node route schemas come from `packages/contracts`; protocol-node owns route enforcement and NodeClient owns remote error behavior. Hosted/node contract inventory is generated from `packages/contracts` and drift-tested against `registerNodeRoutes`.

```
contracts schemas ──▶ protocol-node routes ──▶ server app
        │                    ▲                    │
        └── OpenAPI inventory│                    ├── readiness/metrics
                             │                    ├── Postgres stores
NodeClient ──▶ node app ─────┘                    ├── Redis queue
                                                  └── local object PV

RunQueuePort ──▶ MemoryRunQueue
      │        └── BullMqRunQueue
      └──▶ HostedWorkerService ──▶ fake-only RunService
```

## Acceptance Criteria (Phase-Level)

- [ ] Production-mode server/worker/node config is validated, redacted, and fail-closed.
- [ ] Server/worker/node lifecycle has readiness, graceful shutdown, and deterministic smoke behavior.
- [ ] Redis queue claim/retry/ack behavior is crash-recoverable and observable.
- [ ] Postgres and local object persistent-volume storage are readiness-checked and survive restart smoke.
- [ ] Node protocol auth, typed client errors, bounded bodies, and endpoint contracts are hardened.
- [ ] Self-hosted deployment smoke completes hosted fake and connected-node flows with no external model spend.
- [ ] Forbidden hosted real runtime/tool imports remain absent.

## Self-Review

1. Spec coverage: every Phase 11 acceptance criterion maps to the single full-phase task and phase-level criteria above.
2. Placeholder scan: no placeholder terms are intentionally present.
3. Type consistency: integration contracts use the same exported names consumed in instructions.
4. Ownership disjoint: only one task owns all phase files, so there is no cross-task overlap.
5. Context files real: all context files listed above exist in the worktree.
6. Acceptance testable: each acceptance item names a verifiable behavior or check.
7. Dependency order sane: the single task has no external task dependency and has an explicit internal order.
8. Checks runnable: package-level checks match existing workspace package names; `self-hosted:smoke` is part of the task's required script additions.
9. Error/rescue map present: runtime failure paths are named with rescue behavior and user-visible outcomes.
10. Observability present: logs and success/failure metrics cover new runtime paths.
11. Test cases enumerate acceptance: happy, nil, empty, error, edge, and integration cases cover every acceptance and rescue path.
12. Integration contracts walk: no imports from other tasks exist, so all cross-task imports resolve vacuously.
13. Contract types match: task exports and instructions use consistent names for queue, storage, node client, OpenAPI, and smoke runner contracts.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error rescue map entry has a matching test case in an error, nil, empty, edge, or integration lens.
- [x] Every integration contract import from another task resolves to a real export elsewhere; there are no cross-task imports.
- [x] Every context file path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is intentionally present.
- [x] Complexity is L; a sub-phase split was considered, but the user explicitly requested one implementer/reviewer for this phase.
