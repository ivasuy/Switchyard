# Switchyard Architecture

Switchyard is a protocol-neutral runtime gateway. It exposes agent runtimes, wrapper runtimes, tools, debates, artifacts, and hosted execution through stable API surfaces while keeping runtime-specific behavior behind adapters.

Use this document for system structure. Use `PRODUCT.md` for the shipped product truth and `docs/development/API.md` for endpoint details.

## Current Boundary

The current repo is a TypeScript pnpm/Turborepo monorepo with four app entrypoints and shared packages.

Current shipped runtime modes:

- `fake.deterministic`
- `codex.exec_json`
- `codex.interactive` local-only
- `claude_code.sdk`
- `opencode.acp`
- `agentfield.async_rest`
- `generic_http.async_rest`

Current shipped deployment shapes:

- Local daemon: no-auth by default, SQLite metadata, filesystem artifact content, local runtime/tool adapters.
- Hosted server and worker: API-key protected in staging/production, Postgres metadata, Redis/BullMQ queueing, local or S3-compatible object artifact content, fake-first hosted execution, and explicit operator gates for real provider/tool/debate work.
- Connected node: outbound local node that claims hosted assignments, applies local policy, runs approved work, and syncs events/artifacts back.

Important non-goals remain part of the architecture boundary:

- No managed SaaS/public signup surface.
- No dashboard or TUI.
- No public arbitrary `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` route.
- No generic process/PTY product adapter.
- No hosted `codex.interactive`.
- No hosted browser automation and no hosted `repo` tool execution.
- No Cursor/OpenClaw/Paperclip adapter in the shipped repo.
- No public model-judge route. Live judging is internal to `POST /debates` and spend-gated.

## Runtime Mental Model

```text
+-------------------------------+
| Client apps, CLIs, bots, CI   |
+---------------+---------------+
                |
                | REST / SSE / SDK / CLI
                v
+-------------------------------+
| Switchyard API boundary       |
| local daemon or hosted server |
+---------------+---------------+
                |
                | validated contracts
                v
+-------------------------------+
| Core services                 |
| runs, debates, events,        |
| artifacts, messages, memory,  |
| evidence, approvals, tools,   |
| registry, placement           |
+---------------+---------------+
                |
      +---------+----------+
      |                    |
      v                    v
+-------------+      +----------------+
| Persistence |      | Adapter layer  |
| metadata +  |      | runtimes/tools |
| artifacts   |      +-------+--------+
+------+------+              |
       |                     |
       v                     v
 SQLite/Postgres       Codex, Claude Code,
 FS/S3-compatible      OpenCode, AgentField,
 Redis queue           Generic HTTP, tools
```

Runtime does the work. Switchyard manages the work: validation, placement, lifecycle, events, artifacts, approvals, quota/audit gates, and storage.

## Repository Structure

```text
switchyard/
  apps/
    daemon/       local Fastify gateway
    server/       hosted API gateway and node coordinator
    worker/       hosted queue worker
    node/         connected local node
  packages/
    contracts/    Zod schemas, TypeScript types, OpenAPI generation
    core/         protocol-neutral services and ports
    protocol-rest/ Fastify REST route groups
    protocol-sse/  SSE formatting and replay/live helpers
    protocol-node/ connected-node routes and client
    protocol-acpx/ ACP/acpx schemas, framing, stdio client
    adapters/     runtime adapters and real/fake tool adapters
    storage/      SQLite, Postgres, filesystem, S3-compatible storage
    queue/        in-memory and Redis/BullMQ queues
    sdk/          TypeScript client
    cli/          switchyard CLI
    testkit/      fake runtimes, fake stores, fixtures, harnesses
  deploy/
    self-hosted/  staging compose pack
    production/   production manifest, env, bootstrap examples
  docs/
    development/ API and local/operator guides
    adapters/     adapter notes and verification docs
    superpowers/  historical specs and plans
  scripts/        smoke, preflight, migration, canary commands
```

There is no checked-in `packages/policy` or `packages/protocol-ws` package. Policy lives in `packages/core` services and ports today. Bidirectional control uses existing REST routes such as `POST /runs/:id/input` and approval routes; a public WebSocket package is not shipped.

## Package Dependency Shape

```text
                         +--------------------+
                         | packages/contracts |
                         | schemas, types,    |
                         | OpenAPI            |
                         +----------+---------+
                                    ^
                                    |
        +---------------------------+---------------------------+
        |                           |                           |
+-------+------+          +---------+---------+        +--------+-------+
| protocol-*   |          | packages/core     |        | packages/sdk   |
| REST/SSE/node|          | services + ports  |        | typed client   |
| ACP helpers  |          +---------+---------+        +----------------+
+-------+------+                    ^
        ^                           |
        |                           |
+-------+------+          +---------+---------+
| apps/daemon  |          | packages/adapters |
| apps/server  |          | runtimes + tools  |
| apps/node    |          +---------+---------+
+-------+------+                    ^
        ^                           |
        |                           |
+-------+------+          +---------+---------+
| packages/    |          | packages/testkit  |
| storage/queue|          | fakes + harnesses |
+--------------+          +-------------------+
```

Design rule: route packages translate HTTP/protocol messages into core commands. Core owns behavior. Adapters and storage sit at the edges. Contracts keep shapes consistent across all of them.

## App Composition

### Local Daemon

```text
apps/daemon
  Fastify
    /health
    /metrics
    /runs
    /debates
    /messages
    /memory
    /evidence
    /context
    /approvals
    /tools/invocations
    /providers /runtimes /models /runtime-modes /doctor
    /artifacts/:id
  Core services
  Local adapters
    fake.deterministic
    codex.exec_json
    codex.interactive
    claude_code.sdk
    opencode.acp
    agentfield.async_rest
    generic_http.async_rest
    fetch/web_search/github/repo/shell tools
  SQLite stores
  Filesystem artifact content
```

The daemon is the local developer and local automation gateway. It defaults to no auth, no live spend, no real tools, and local-only storage unless configured otherwise.

### Hosted Server And Worker

```text
                 +----------------------+
Client/API key ->| apps/server          |
                 | Fastify hosted API   |
                 | auth, ownership,     |
                 | entitlement, quota,  |
                 | audit, placement     |
                 +----------+-----------+
                            |
                            | queue jobs
                            v
                 +----------------------+
                 | Redis / BullMQ       |
                 +----------+-----------+
                            |
                            | claim
                            v
                 +----------------------+
                 | apps/worker          |
                 | runtime/tool/debate  |
                 | execution            |
                 +----------+-----------+
                            |
       +--------------------+--------------------+
       |                                         |
       v                                         v
Postgres metadata                         Artifact content
runs/events/debates                       local object volume
nodes/ownership/audit                     or S3-compatible store
bridge commands/payloads
```

The hosted path is fake-first and fail-closed. Real provider runtimes, real hosted tools, wrapper bridges, and live debate participants require explicit operator configuration, readiness, quota/audit, and spend gates.

### Connected Node

```text
apps/node
  registers with apps/server
  sends heartbeat
  claims assignments
  applies local node policy
  executes local-approved run/tool work
  syncs events and artifact manifests/content
```

Connected nodes let a hosted/team Switchyard coordinate work that must happen on a local machine or private network. The node connects outward to the server; the server does not need inbound access to the node.

## Core Services

`packages/core` contains the protocol-neutral product behavior.

Key service groups:

- Run lifecycle: `RunService`, `RunLauncherService`, `RuntimeRunnerService`, `HostedRunService`, `HostedWorkerService`.
- Runtime catalog and readiness: `RegistryService`, `RuntimeCapabilityService`, `RuntimeDoctorService`, hosted runtime catalog and provider policy checks.
- Debate execution: `DebateService`, `DebateJudgeRunner`, debate output extraction, child-run linking.
- Middleware records: `MessageRouter`, `MemoryService`, `EvidenceService`, `ContextBuilder`, `ApprovalService`.
- Tools and policy: `ToolRouter`, `HostedToolService`, `LocalPolicyGate`, real-tool policy contracts.
- Hosted/hybrid coordination: `PlacementService`, `NodeCoordinatorService`, `LocalNodePolicyService`, `EventSyncService`, `ArtifactSyncService`.
- Runtime bridges: `HostedRuntimeBridgeService` for durable hosted input/approval command flow.
- Events/artifacts: `EventBus`, `EventService`, `ArtifactService`, content store ports.

Core depends on interfaces for persistence, queues, adapters, policy, and logging. App entrypoints choose concrete implementations.

## Protocol Surfaces

`packages/protocol-rest` owns Fastify route groups:

- Runs: `POST /runs`, `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`, `GET /runs/:id/artifacts`, `POST /runs/:id/input`, `POST /runs/:id/cancel`.
- Debates: `POST /debates`, `GET /debates/:id`, `GET /debates/:id/events`.
- Middleware: messages, memory, evidence, context, approvals, tool invocations.
- Registry: providers, runtimes, models, runtime modes, doctor.
- Artifacts: `GET /artifacts/:id`, `GET /artifacts/:id/content`.
- Hosted enterprise: `GET /auth/whoami`, `GET /entitlements`, `GET /audit/events`.
- Hosted tools subset: hosted-safe tool/approval routes.

`packages/protocol-sse` formats replay and bounded/open live event streams for run and debate events.

`packages/protocol-node` owns connected-node registration, heartbeat, assignment claim/reject/complete, event sync, artifact manifest sync, and artifact content upload.

`packages/protocol-acpx` owns outbound ACP/acpx framing, schemas, JSON-RPC, stdio client behavior, and transcript helpers used by ACP-capable adapters.

## Runtime And Tool Adapters

`packages/adapters` normalizes runtime-specific behavior into Switchyard events, sessions, artifacts, and errors.

Runtime adapters:

- `codex.exec_json`: local one-shot Codex CLI execution through `codex exec --json`.
- `codex.interactive`: explicit local-only Codex interactive process mode with bounded post-start input and approval/session-state handling.
- `claude_code.sdk`: structured Claude Code CLI/SDK-style stream handling.
- `opencode.acp`: OpenCode ACP subprocess integration.
- `agentfield.async_rest`: configured AgentField async REST wrapper.
- `generic_http.async_rest`: configured async REST wrapper.
- `fake.deterministic`: deterministic no-spend runtime used for tests, smoke, canary, and fake hosted debate.

Tool adapters:

- Local daemon: `fetch`, `web_search`, `github`, `repo`, command-catalog `shell`, and `fake_echo`.
- Hosted worker: `fetch`, `web_search`, `github`, command-catalog `shell`.
- Connected node: `fetch`, `web_search`, `github`, `repo`, command-catalog `shell`.

All real tools are deny-by-default and bounded. Approval is required by default unless explicit policy says otherwise.

## Persistence

Local mode:

- SQLite metadata stores in `packages/storage/src/sqlite`.
- Filesystem artifact content store.
- In-process queues and event bus.

Hosted mode:

- Postgres metadata stores in `packages/storage/src/postgres`.
- Redis/BullMQ queue in `packages/queue`.
- Local object-volume or S3-compatible artifact content backend.
- Hosted runtime bridge command and payload stores in Postgres.

Test mode:

- In-memory stores and fake runtimes in `packages/testkit`.

Storage contracts are additive and covered by migration/compatibility tests. Production readiness fails closed when required hosted dependencies are missing or schema compatibility is unsafe.

## Request Flow: Local Run

```text
Client
  |
  | POST /runs or POST /runs?wait=1
  v
apps/daemon Fastify route
  |
  | validate body with contracts
  v
RunService creates run + events
  |
  v
RunLauncherService / RuntimeRunnerService
  |
  | choose adapter from registry/runtimeMode
  v
Runtime adapter starts process/HTTP/ACP/fake runtime
  |
  | normalized events + artifacts
  v
Event store, event bus, artifact stores
  |
  +--> GET /runs/:id
  +--> GET /runs/:id/events
  +--> GET /runs/:id/artifacts
  +--> GET /artifacts/:id/content
```

## Request Flow: Hosted Run

```text
Client
  |
  | authenticated POST /runs
  v
apps/server
  |
  | auth, ownership, entitlement, quota, placement,
  | runtime/tool/provider policy, readiness gates
  v
Postgres run + event rows
  |
  v
Redis/BullMQ queued job
  |
  v
apps/worker claims job
  |
  | revalidates durable state before adapter start
  v
Fake or allowlisted provider adapter
  |
  v
events/artifacts persisted and streamed by server
```

Hosted execution must revalidate durable run state at claim time. This prevents stale queue payloads from starting work after policy, ownership, runtime, or readiness state changed.

## Request Flow: Hosted Runtime Bridge

```text
Client
  |
  | POST /runs/:id/input
  | POST /approvals/:id/approve
  v
apps/server
  |
  | validate ownership/quota/readiness
  v
Postgres bridge command store
  |
  | worker claims non-idempotent command once
  v
apps/worker
  |
  | applies command to active worker-owned session
  v
adapter session
```

Bridge support currently applies to worker-owned `claude_code.sdk`, `opencode.acp`, and conditionally `agentfield.async_rest` / `generic_http.async_rest` when wrapper config and advertised bridge capabilities are present. `codex.exec_json` remains one-shot. Hosted `codex.interactive` is not shipped.

## Request Flow: Debate

```text
Client
  |
  | POST /debates
  v
DebateService
  |
  | validate topic, participants, evidence,
  | runtime opt-in, placement, spend gates
  v
child runs per participant turn
  |
  | MessageRouter + EventBus
  v
bounded judge
  |
  | deterministic by default,
  | live model only with spend confirmation
  v
final report artifact
```

Hosted debate uses the same `/debates` route family as local debate. There is no public judge route.

## OpenAPI And Contract Ownership

`packages/contracts` owns shared schemas, endpoint inventory, and OpenAPI generation.

Commands:

```bash
pnpm --filter @switchyard/contracts openapi:generate
pnpm --filter @switchyard/contracts openapi:check
pnpm --filter @switchyard/contracts openapi:generate:hosted
pnpm --filter @switchyard/contracts openapi:check:hosted
```

Generated contract files:

- `packages/contracts/openapi.local-daemon.json`
- `packages/contracts/openapi.hosted-server.json`

When API routes or request/response shapes change, update contracts first, regenerate OpenAPI, then update `docs/development/API.md`.

## Operational Boundaries

Local verification:

```bash
pnpm typecheck
pnpm --filter @switchyard/contracts openapi:check
pnpm --filter @switchyard/contracts openapi:check:hosted
git diff --check
```

Production readiness commands:

```bash
pnpm production:preflight -- --env-file deploy/production/.env --manifest deploy/production/manifest.json --include-node
pnpm production:migrate -- --env-file deploy/production/.env
pnpm production:canary -- --base-url https://replace-with-public-server-url --api-key replace-with-operator-api-key
```

The production canary default is deterministic/no-spend hosted debate. Live provider/tool/debate probes require explicit confirmation flags.

## Documentation Map

- `README.md`: public overview and quickstart.
- `PRODUCT.md`: current shipped truth and roadmap history.
- `PROJECT.md`: phase-by-phase user-facing changelog.
- `docs/development/API.md`: implemented API contract and route constraints.
- `docs/development/DEVELOPMENT.md`: local setup, smoke checks, rollout/rollback commands.
- `docs/development/adapters/`: runtime-specific debugging notes.
- `deploy/production/README.md`: production manifest pack and operator boundary.
- `docs/superpowers/`: historical release specs/plans, not product truth.
