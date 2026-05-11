# Switchyard Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Switchyard as a deploy-anywhere agent runtime gateway with stable REST/SSE/acpx APIs, local/hosted/hybrid execution modes, runtime adapters, artifacts, approvals, and bounded multi-agent debate.

**Architecture:** Switchyard is a TypeScript monorepo with shared protocol-neutral core packages and separate local/hosted entrypoints. Protocols and adapters sit at the edge; core owns runs, debates, events, messages, artifacts, approvals, memory, placement, and policy. Implementation proceeds from fake runtimes and contract tests to real adapters, hosted workers, debate, and hybrid nodes.

**Tech Stack:** TypeScript, Node.js, pnpm workspaces, Turborepo, Fastify, Zod, Drizzle, SQLite, Postgres, Redis/BullMQ, S3/R2-compatible artifact storage, Vitest, ACP/acpx, SSE, WebSocket, child process, PTY.

---

## Scope Strategy

Switchyard is too large to implement as one undifferentiated plan. This master plan defines phases and subphases that each produce working, testable software. Each phase should later get its own narrow execution plan before code is written.

The first real implementation should start with **Phase -1** and **Phase 0**:

- Phase -1 proves current adapter surfaces so we do not build against stale assumptions.
- Phase 0 creates the monorepo, contracts, core domain, fake adapter, and test harness.

Do not begin with Codex, debate, memory graph, hosted workers, or PTY. Those depend on stable contracts and event normalization.

## Repository Shape

Final monorepo shape. Create the top-level package folders early even when some modules only contain contracts/ports at first. That prevents the first implementation phases from accidentally treating runs as the whole product.

```text
switchyard/
  apps/
    daemon/
      src/
        app.ts
        config.ts
        main.ts
    node/
      src/
        app.ts
        config.ts
        connection-client.ts
        job-runner.ts
        artifact-sync.ts
        main.ts
    server/
      src/
        app.ts
        config.ts
        main.ts
    worker/
      src/
        main.ts
        run-worker.ts
        debate-worker.ts
        tool-worker.ts
  packages/
    adapters/
      src/
        common/
        opencode/
        claude-code/
        codex/
        cursor/
        openclaw/
        paperclip/
        agentfield/
        browser-search/
        generic-http/
        process/
        pty/
    cli/
      src/
        commands/
    contracts/
      src/
        approval.ts
        artifact.ts
        budget.ts
        debate.ts
        error.ts
        event.ts
        evidence.ts
        ids.ts
        memory.ts
        message.ts
        node.ts
        node-control.ts
        placement.ts
        registry.ts
        run.ts
        session.ts
        tool.ts
        user.ts
    core/
      src/
        services/
          approval-service.ts
          artifact-service.ts
          context-builder.ts
          debate-service.ts
          event-bus.ts
          event-service.ts
          evidence-service.ts
          memory-service.ts
          message-router.ts
          node-service.ts
          placement-service.ts
          remote-control-service.ts
          registry-service.ts
          run-service.ts
          session-service.ts
          tool-router.ts
        ports/
          approval-store.ts
          artifact-store.ts
          context-source.ts
          debate-store.ts
          event-store.ts
          evidence-store.ts
          memory-store.ts
          message-store.ts
          node-control-channel.ts
          node-store.ts
          queue.ts
          registry-store.ts
          run-store.ts
          runtime-adapter.ts
          session-store.ts
          tool-adapter.ts
    policy/
      src/
        approval-policy.ts
        budget-policy.ts
        node-policy.ts
        placement-policy.ts
        runtime-policy.ts
        tool-policy.ts
    protocol-acpx/
      src/
    protocol-node/
      src/
        control-channel.ts
        node-client.ts
        node-server.ts
        replay.ts
    protocol-rest/
      src/
          approval-routes.ts
          artifact-routes.ts
          debate-routes.ts
          context-routes.ts
          memory-routes.ts
          message-routes.ts
          registry-routes.ts
          run-routes.ts
          session-routes.ts
          tool-routes.ts
    protocol-sse/
      src/
    protocol-ws/
      src/
    queue/
      src/
        bullmq-queue.ts
        local-queue.ts
    sdk/
      src/
    storage/
      src/
        filesystem/
        memory/
        postgres/
        sqlite/
        s3/
    testkit/
      src/
        fake-adapters/
        fake-stores/
        fixtures/
  docs/
    adapters/
      verification/
    decisions/
    superpowers/
      plans/
      specs/
```

Package ownership:

- `packages/contracts`: Zod schemas and generated TypeScript types for every public/core object. No business logic.
- `packages/core`: protocol-neutral domain services and ports. No Fastify, Redis, Drizzle, S3, filesystem, or runtime-specific code.
- `packages/adapters`: runtime and tool adapter implementations. Adapters depend on contracts/core ports but do not call REST handlers or storage implementations directly.
- `packages/protocol-rest`: REST route groups for runs, debates, messages, tools, memory, artifacts, approvals, providers, models, runtimes, and nodes.
- `packages/protocol-sse`: stream fanout, replay cursors, event filtering, and SSE formatting.
- `packages/protocol-ws`: interactive bidirectional channels for terminal input, runtime steering, attach/detach, and debate-room messages.
- `packages/protocol-acpx`: inbound ACP/acpx server and outbound ACP/acpx client. It only translates protocol messages to core commands/events.
- `packages/protocol-node`: remote-control protocol between hosted/team Switchyard and connected Switchyard nodes running on other servers. It owns authenticated node connection, heartbeat, command delivery, event sync, cancellation, artifact-sync manifests, and reconnect replay.
- `packages/storage`: repository implementations for SQLite, Postgres, filesystem artifacts, object storage artifacts, and in-memory tests.
- `packages/queue`: local and hosted queue abstractions.
- `packages/policy`: placement, approval, runtime safety, remote-node, tool, and budget policies.
- `packages/sdk`: typed client for frontend/backend consumers.
- `packages/cli`: developer/admin commands for doctor, local launch, runtime test, and debugging.
- `packages/testkit`: fake runtimes, fake adapters, fixture events, fake stores, and shared adapter contract tests.
- `apps/daemon`: local Switchyard gateway using SQLite, filesystem artifacts, local queue, and local-capable adapters.
- `apps/node`: remote Switchyard execution node for teams running workloads on different servers. It connects outward to hosted/team Switchyard, receives assigned work, enforces local node policy, runs server-local adapters, streams approved events, and syncs approved artifacts.
- `apps/server`: hosted Switchyard API using Postgres, Redis/BullMQ, object storage, and hosted-safe adapters.
- `apps/worker`: hosted background workers for runs, debates, tools, artifact extraction, memory extraction, and report generation.

Core service ownership:

- `run-service`: creates runs, starts/cancels sessions, sends input, tracks run status.
- `debate-service`: creates debates, manages participants, rounds, stop conditions, and final reports.
- `session-service`: tracks runtime session ids, external wrapper session ids, process ids, protocol state, attach/detach state, and runtime session metadata.
- `event-service`: validates, stores, sequences, and replays normalized events.
- `event-bus`: publishes live events to SSE, WebSocket, workers, debate manager, approval service, artifact manager, and memory extraction.
- `message-router`: direct messages, broadcasts, channels, handoffs, debate-room messages, delivery receipts.
- `node-service`: connected-node registration, heartbeat, capability tracking, availability, and lifecycle state.
- `remote-control-service`: hosted-to-node command assignment, acknowledgement tracking, cancellation, disconnect handling, event ingestion, and artifact sync coordination.
- `artifact-service`: transcript, diff, log, screenshot, evidence, and proof artifact lifecycle.
- `approval-service`: pending approval creation, resolution, resume/reject behavior.
- `memory-service`: memory search, remember, extraction requests, graph queries.
- `tool-router`: search, fetch, browser, repo, shell, GitHub, and future tool routing with policy checks.
- `registry-service`: providers, models, runtimes, capabilities, doctor results.
- `placement-service`: local/hosted/connected-node placement decisions and policy traces.
- `context-builder`: builds task prompts, debate prompts, participant role prompts, provider/model formatting, repo context, memory injection, skill injection, evidence injection, runtime-specific formatting, and approval instructions.
- `evidence-service`: stores, deduplicates, cites, and retrieves evidence items for debates, research tasks, and browser/search tool outputs.

Diagram coverage audit:

- Client/app layer: represented by REST, SSE, WebSocket, SDK, CLI, and protocol packages.
- Public Gateway API: represented by `protocol-rest`, `protocol-sse`, `protocol-ws`, `protocol-acpx`, and route groups for every API family.
- Run Manager: `run-service`.
- Debate/Deliberation Manager: `debate-service`.
- Provider/Model Registry: `registry-service` plus `registry-store`.
- Runtime Registry: `registry-service` plus runtime adapter metadata.
- Event Bus: `event-bus` plus `event-service` and `event-store`.
- Session Store: `session-service` plus `session-store`.
- Debate Store: `debate-store`.
- Message Router: `message-router`.
- Tool Router: `tool-router` plus `tool-adapter`.
- Context Builder: `context-builder` plus `context-source`.
- Approval/Policy Layer: `approval-service`, `approval-store`, and `packages/policy`.
- Memory Layer: `memory-service` and `memory-store`.
- Artifact Manager: `artifact-service` and `artifact-store`.
- Runtime Adapter Layer: `packages/adapters` plus `runtime-adapter`.
- Storage Layer: `packages/storage` and concrete SQLite/Postgres/filesystem/S3 implementations.

## Phase -1: Adapter Research and Verification

**Goal:** Convert current web research into version-pinned adapter contracts before implementation.

**Why this starts first:** Runtime surfaces are volatile. Building adapters from memory would create brittle code and wrong abstractions.

### Phase -1.1: Create Adapter Research Records

**Files:**

- Create: `docs/adapters/README.md`
- Create: `docs/adapters/opencode.md`
- Create: `docs/adapters/claude-code.md`
- Create: `docs/adapters/codex.md`
- Create: `docs/adapters/cursor.md`
- Create: `docs/adapters/agentfield.md`
- Create: `docs/adapters/openclaw.md`
- Create: `docs/adapters/generic-http.md`

**Steps:**

- [ ] Record each adapter's current official docs URL.
- [ ] Record install command, auth mechanism, command/API shape, streaming format, cancellation behavior, session persistence, artifact extraction, local/hosted suitability, and known risks.
- [ ] Mark unverified adapters as `status: deferred`.
- [ ] Commit research docs with message `docs: add adapter research records`.

**Exit criteria:**

- Every first-wave adapter has a research file.
- No adapter is marked implementation-ready without command/API verification.

### Phase -1.2: Verify OpenCode ACP

**Files:**

- Create: `docs/adapters/verification/opencode-acp.md`

**Steps:**

- [ ] Run `opencode --version` and record output.
- [ ] Run `opencode acp` through a small JSON-RPC stdio harness.
- [ ] Capture `initialize`, `session/new`, `session/prompt`, `session/cancel` behavior.
- [ ] Save raw transcript shape in the verification doc.
- [ ] Decide whether OpenCode remains the first real adapter.
- [ ] Commit with message `docs: verify opencode acp surface`.

**Exit criteria:**

- We know the exact JSON-RPC messages required to start and prompt OpenCode through ACP.

### Phase -1.3: Verify Claude Code SDK/Headless

**Files:**

- Create: `docs/adapters/verification/claude-code.md`

**Steps:**

- [ ] Verify `@anthropic-ai/claude-agent-sdk` install and import shape.
- [ ] Verify CLI fallback: `claude -p --output-format stream-json`.
- [ ] Capture output event types, session id behavior, cancellation behavior, tool call shape, and approval callback behavior.
- [ ] Decide whether the first Claude adapter uses SDK or stream-json CLI.
- [ ] Commit with message `docs: verify claude code integration surface`.

**Exit criteria:**

- Claude Code adapter path is chosen without relying on PTY.

### Phase -1.4: Verify Codex and Cursor Parser Risks

**Files:**

- Create: `docs/adapters/verification/codex.md`
- Create: `docs/adapters/verification/cursor.md`

**Steps:**

- [ ] Run `codex --version` and record output.
- [ ] Run a tiny `codex exec --json` command in a disposable repo and capture JSONL.
- [ ] Record parser risks and approval behavior.
- [ ] Run `cursor-agent --version` and record output.
- [ ] Run `cursor-agent -p --output-format stream-json` with a harmless prompt and capture event shape.
- [ ] Commit with message `docs: verify codex and cursor parser surfaces`.

**Exit criteria:**

- Codex and Cursor remain planned adapters, but implementation does not start until parser contracts are explicit.

### Phase -1.5: Verify Wrapper Runtimes

**Files:**

- Create: `docs/adapters/verification/agentfield.md`
- Create: `docs/adapters/verification/openclaw.md`
- Create: `docs/adapters/verification/paperclip.md`

**Steps:**

- [ ] Verify AgentField async REST flow: create execution, poll execution, capture result.
- [ ] Verify OpenClaw gateway/session API boundary or mark as deferred if API is not stable.
- [ ] Verify Paperclip API boundary or mark as deferred if source/API is not available.
- [ ] Commit with message `docs: verify wrapper runtime adapter surfaces`.

**Exit criteria:**

- Generic HTTP and AgentField can proceed early.
- OpenClaw/Paperclip are not allowed to block foundation work.

## Phase 0: Contract and Monorepo Foundation

**Goal:** Create the repo foundation, shared contracts, core ports, fake adapter, and test harness.

### Phase 0.1: Workspace Scaffold

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `vitest.config.ts`

**Steps:**

- [ ] Configure pnpm workspaces for `apps/*` and `packages/*`.
- [ ] Configure strict TypeScript.
- [ ] Configure shared test command.
- [ ] Run `pnpm install`.
- [ ] Run `pnpm test` and expect no tests or a passing empty suite.
- [ ] Commit with message `chore: scaffold switchyard workspace`.

**Exit criteria:**

- A new package can be added and tested without custom setup.

### Phase 0.2: Contract Package

**Files:**

- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/ids.ts`
- Create: `packages/contracts/src/run.ts`
- Create: `packages/contracts/src/debate.ts`
- Create: `packages/contracts/src/event.ts`
- Create: `packages/contracts/src/evidence.ts`
- Create: `packages/contracts/src/message.ts`
- Create: `packages/contracts/src/artifact.ts`
- Create: `packages/contracts/src/approval.ts`
- Create: `packages/contracts/src/memory.ts`
- Create: `packages/contracts/src/tool.ts`
- Create: `packages/contracts/src/budget.ts`
- Create: `packages/contracts/src/node.ts`
- Create: `packages/contracts/src/user.ts`
- Create: `packages/contracts/src/registry.ts`
- Create: `packages/contracts/src/placement.ts`
- Create: `packages/contracts/src/error.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/*.test.ts`

**Steps:**

- [ ] Write failing tests for every schema's required fields.
- [ ] Implement branded id schemas for run, debate, participant, message, event, artifact, approval, provider, model, runtime, node, memory, tool, user, and organization ids.
- [ ] Implement run status, runtime session status, debate status, event type, adapter type, tool type, artifact type, approval status, memory scope, evidence source type, placement decision, budget status, and error code enums.
- [ ] Implement Zod schemas.
- [ ] Export inferred TypeScript types.
- [ ] Run `pnpm --filter @switchyard/contracts test`.
- [ ] Commit with message `feat: add shared domain contracts`.

**Exit criteria:**

- All public/internal data shapes have one source of truth.

### Phase 0.3: Core Ports

**Files:**

- Create: `packages/core/package.json`
- Create: `packages/core/src/ports/runtime-adapter.ts`
- Create: `packages/core/src/ports/tool-adapter.ts`
- Create: `packages/core/src/ports/context-source.ts`
- Create: `packages/core/src/ports/run-store.ts`
- Create: `packages/core/src/ports/debate-store.ts`
- Create: `packages/core/src/ports/event-store.ts`
- Create: `packages/core/src/ports/evidence-store.ts`
- Create: `packages/core/src/ports/artifact-store.ts`
- Create: `packages/core/src/ports/message-store.ts`
- Create: `packages/core/src/ports/approval-store.ts`
- Create: `packages/core/src/ports/memory-store.ts`
- Create: `packages/core/src/ports/registry-store.ts`
- Create: `packages/core/src/ports/node-store.ts`
- Create: `packages/core/src/ports/session-store.ts`
- Create: `packages/core/src/ports/queue.ts`
- Create: `packages/core/src/ports/policy.ts`
- Create: `packages/core/src/services/approval-service.ts`
- Create: `packages/core/src/services/artifact-service.ts`
- Create: `packages/core/src/services/context-builder.ts`
- Create: `packages/core/src/services/debate-service.ts`
- Create: `packages/core/src/services/event-bus.ts`
- Create: `packages/core/src/services/event-service.ts`
- Create: `packages/core/src/services/evidence-service.ts`
- Create: `packages/core/src/services/memory-service.ts`
- Create: `packages/core/src/services/message-router.ts`
- Create: `packages/core/src/services/placement-service.ts`
- Create: `packages/core/src/services/registry-service.ts`
- Create: `packages/core/src/services/run-service.ts`
- Create: `packages/core/src/services/session-service.ts`
- Create: `packages/core/src/services/tool-router.ts`
- Create: `packages/core/src/index.ts`

**Steps:**

- [ ] Define `RuntimeAdapter` with `check`, `start`, `send`, `cancel`, `events`, `tools`, and `artifacts`.
- [ ] Define `ToolAdapter` with `check`, `invoke`, `cancel`, and `artifacts`.
- [ ] Define repository interfaces for runs, runtime sessions, debates, events, messages, artifacts, approvals, memory, evidence, registry records, connected nodes, and placement decisions.
- [ ] Define queue interface for local/hosted execution.
- [ ] Define policy interface for placement and approval gates.
- [ ] Create service shells for run, session, debate, event, event bus, message routing, artifact, approval, memory, evidence, tool routing, registry, placement, and context building.
- [ ] Ensure service shells depend only on ports and contracts, even if later-phase methods initially throw `NotImplementedError`-style domain errors.
- [ ] Commit with message `feat: define core ports`.

**Exit criteria:**

- Core can be tested against fake implementations before real storage/adapters exist.

### Phase 0.4: Fake Runtime and Testkit

**Files:**

- Create: `packages/testkit/package.json`
- Create: `packages/testkit/src/fake-runtime-adapter.ts`
- Create: `packages/testkit/src/fake-stores.ts`
- Create: `packages/testkit/src/fixtures.ts`
- Create: `packages/testkit/src/index.ts`
- Create: `packages/core/test/runtime-adapter-contract.test.ts`

**Steps:**

- [ ] Implement fake adapter that emits deterministic queued/running/output/tool/completed events.
- [ ] Implement in-memory stores.
- [ ] Write shared adapter contract test.
- [ ] Run core/testkit tests.
- [ ] Commit with message `test: add fake runtime adapter contract`.

**Exit criteria:**

- Any future adapter can be tested against the same contract.

## Phase 1: Local Gateway MVP

**Goal:** Ship a local Switchyard daemon that can create fake runs, stream events, persist state, and store artifacts.

Status note, 2026-05-11: Phase 1 is complete when the storage-backed fake daemon, artifact listing, and replay/live event behavior in the Phase 0/1 gap plan are merged and verified.

### Phase 1.1: Core Run Service

**Files:**

- Create: `packages/core/src/services/run-service.ts`
- Create: `packages/core/src/services/event-service.ts`
- Create: `packages/core/test/run-service.test.ts`

**Steps:**

- [ ] Test `createRun` creates queued run and emits `run.queued`.
- [ ] Test `startRun` selects adapter and emits lifecycle events.
- [ ] Test `sendInput` calls adapter `send`.
- [ ] Test `cancelRun` calls adapter `cancel` and stores cancellation.
- [ ] Implement minimal services against ports.
- [ ] Commit with message `feat: add core run service`.

**Exit criteria:**

- Runs work through core using fake storage and fake adapter.

### Phase 1.2: Local SQLite and Filesystem Storage

**Files:**

- Create: `packages/storage/package.json`
- Create: `packages/storage/src/sqlite/schema.ts`
- Create: `packages/storage/src/sqlite/run-repository.ts`
- Create: `packages/storage/src/sqlite/event-repository.ts`
- Create: `packages/storage/src/filesystem-artifact-store.ts`
- Create: `packages/storage/test/sqlite-storage.test.ts`

**Steps:**

- [ ] Add Drizzle SQLite schema for runs, run_events, artifacts, messages, approvals, registry records.
- [ ] Implement run/event repositories.
- [ ] Implement filesystem artifact store.
- [ ] Test persistence across repository re-instantiation.
- [ ] Commit with message `feat: add local sqlite storage`.

**Exit criteria:**

- Local runs and events survive process restart.

### Phase 1.3: REST and SSE Packages

**Files:**

- Create: `packages/protocol-rest/package.json`
- Create: `packages/protocol-rest/src/run-routes.ts`
- Create: `packages/protocol-rest/src/registry-routes.ts`
- Create: `packages/protocol-rest/src/artifact-routes.ts`
- Create: `packages/protocol-sse/package.json`
- Create: `packages/protocol-sse/src/sse-stream.ts`
- Create: `packages/protocol-rest/test/run-routes.test.ts`

**Steps:**

- [ ] Test `POST /runs` validates request and returns run id.
- [ ] Test `GET /runs/:id` returns stored run state.
- [ ] Test `GET /runs/:id/events` streams stored and live events.
- [ ] Test `POST /runs/:id/input`.
- [ ] Test `POST /runs/:id/cancel`.
- [ ] Commit with message `feat: add run rest and sse protocols`.

**Exit criteria:**

- Protocol code translates requests into core commands without owning business logic.

### Phase 1.4: Daemon App

**Files:**

- Create: `apps/daemon/package.json`
- Create: `apps/daemon/src/config.ts`
- Create: `apps/daemon/src/app.ts`
- Create: `apps/daemon/src/main.ts`
- Create: `apps/daemon/test/smoke.test.ts`

**Steps:**

- [ ] Wire Fastify, local SQLite storage, filesystem artifacts, fake adapter, REST routes, and SSE.
- [ ] Add `pnpm --filter @switchyard/daemon dev`.
- [ ] Add smoke test for create-run to completed artifact.
- [ ] Commit with message `feat: add local daemon mvp`.

**Exit criteria:**

- A user can run local Switchyard and create/stream/fetch a fake run.

## Phase 2: acpx Protocol Foundation

**Goal:** Add inbound and outbound acpx support using fake runtimes before real runtime adapters.

### Phase 2.1: ACP Transport and JSON-RPC Core

**Files:**

- Create: `packages/protocol-acpx/package.json`
- Create: `packages/protocol-acpx/src/json-rpc.ts`
- Create: `packages/protocol-acpx/src/types.ts`
- Create: `packages/protocol-acpx/test/json-rpc.test.ts`

**Steps:**

- [ ] Implement JSON-RPC request/response/notification parsing.
- [ ] Validate error handling.
- [ ] Preserve raw protocol messages for artifacts.
- [ ] Commit with message `feat: add acpx json-rpc foundation`.

**Exit criteria:**

- acpx package can safely parse and emit JSON-RPC without runtime-specific logic.

### Phase 2.2: Outbound ACP Client Adapter Base

**Files:**

- Create: `packages/protocol-acpx/src/acp-client.ts`
- Create: `packages/adapters/src/acp-runtime-adapter.ts`
- Create: `packages/protocol-acpx/test/acp-client.test.ts`

**Steps:**

- [ ] Test initialize/session/new/session/prompt/session/cancel flow against fake ACP subprocess.
- [ ] Map ACP session updates to Switchyard events.
- [ ] Commit with message `feat: add outbound acp runtime adapter base`.

**Exit criteria:**

- Fake ACP runtime can be driven through Switchyard adapter contract.

### Phase 2.3: Inbound ACP Server Surface

**Files:**

- Create: `packages/protocol-acpx/src/acp-server.ts`
- Create: `packages/protocol-acpx/test/acp-server.test.ts`

**Steps:**

- [ ] Accept ACP initialize.
- [ ] Map `session/new` to Switchyard run creation.
- [ ] Map `session/prompt` to run input.
- [ ] Map `session/cancel` to run cancellation.
- [ ] Emit `session/update` notifications from Switchyard events.
- [ ] Commit with message `feat: expose switchyard as acp runtime`.

**Exit criteria:**

- External ACP-compatible clients can treat Switchyard as a runtime surface.

## Phase 3: First Real Adapter: OpenCode ACP

**Goal:** Validate the real structured runtime path with OpenCode.

### Phase 3.1: OpenCode Doctor

**Files:**

- Create: `packages/adapters/src/opencode/opencode-doctor.ts`
- Create: `packages/adapters/test/opencode-doctor.test.ts`

**Steps:**

- [ ] Detect `opencode` binary.
- [ ] Capture version.
- [ ] Verify `opencode acp` starts.
- [ ] Return actionable doctor errors.
- [ ] Commit with message `feat: add opencode doctor`.

**Exit criteria:**

- Switchyard can tell users whether OpenCode ACP is usable.

### Phase 3.2: OpenCode ACP Adapter

**Files:**

- Create: `packages/adapters/src/opencode/opencode-acp-adapter.ts`
- Create: `packages/adapters/test/opencode-acp-adapter.test.ts`

**Steps:**

- [ ] Implement adapter using ACP client base.
- [ ] Map cwd, model, prompt, cancellation, and events.
- [ ] Store raw ACP transcript as artifact.
- [ ] Run adapter contract test.
- [ ] Commit with message `feat: add opencode acp adapter`.

**Exit criteria:**

- Real OpenCode run works through `/runs` and SSE.

## Phase 4: Claude Code Adapter

**Goal:** Integrate Claude Code through SDK/headless streaming before PTY.

### Phase 4.1: Claude Doctor

**Files:**

- Create: `packages/adapters/src/claude-code/claude-code-doctor.ts`
- Create: `packages/adapters/test/claude-code-doctor.test.ts`

**Steps:**

- [ ] Detect SDK availability or `claude` binary.
- [ ] Verify auth signals without printing secrets.
- [ ] Report chosen integration path: SDK or CLI stream-json.
- [ ] Commit with message `feat: add claude code doctor`.

### Phase 4.2: Claude SDK/Headless Adapter

**Files:**

- Create: `packages/adapters/src/claude-code/claude-code-adapter.ts`
- Create: `packages/adapters/test/claude-code-adapter.test.ts`

**Steps:**

- [ ] Implement SDK path if Phase -1 chose SDK.
- [ ] Implement CLI stream-json fallback if needed.
- [ ] Normalize text deltas, tool calls, tool results, approval pauses, completion, and failure.
- [ ] Preserve raw stream as artifact.
- [ ] Commit with message `feat: add claude code adapter`.

**Exit criteria:**

- Claude Code can run through Switchyard without PTY parsing.

## Phase 5: Hosted Gateway MVP

**Goal:** Run the same API in hosted mode with Postgres, Redis/BullMQ, object storage, and workers.

### Phase 5.1: Postgres Storage

**Files:**

- Create: `packages/storage/src/postgres/schema.ts`
- Create: `packages/storage/src/postgres/*.ts`
- Create: `packages/storage/test/postgres-storage.test.ts`

**Steps:**

- [ ] Mirror SQLite repository behavior in Postgres.
- [ ] Add migration path.
- [ ] Run storage contract tests against Postgres.
- [ ] Commit with message `feat: add postgres storage`.

### Phase 5.2: Queue and Worker

**Files:**

- Create: `packages/queue/src/bullmq-queue.ts`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/src/run-worker.ts`
- Create: `apps/worker/test/run-worker.test.ts`

**Steps:**

- [ ] Queue run execution after `POST /runs`.
- [ ] Worker claims run and starts adapter.
- [ ] Stream worker events back to event store.
- [ ] Test retry/cancel paths.
- [ ] Commit with message `feat: add hosted run worker`.

### Phase 5.3: Server App

**Files:**

- Create: `apps/server/package.json`
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/main.ts`
- Create: `apps/server/test/smoke.test.ts`

**Steps:**

- [ ] Wire Fastify, Postgres, Redis queue, object artifact store, REST, SSE.
- [ ] Run same create-run smoke test against hosted-like app.
- [ ] Commit with message `feat: add hosted server mvp`.

**Exit criteria:**

- Same client contract works in local and hosted modes.

## Phase 6: Wrapper and Process Adapter Expansion

**Goal:** Add easy wrapper adapters and controlled process fallbacks.

Subphases:

- Phase 6.1: Generic HTTP adapter.
- Phase 6.2: AgentField async REST adapter.
- Phase 6.3: Browser/Search adapter.
- Phase 6.4: Process adapter.
- Phase 6.5: Codex adapter after JSONL parser verification.
- Phase 6.6: Cursor adapter after stream parser verification.
- Phase 6.7: PTY adapter with explicit local-only policy.
- Phase 6.8: OpenClaw adapter once API boundary is verified.
- Phase 6.9: Paperclip adapter once API boundary is verified.

Each subphase must:

- [ ] Add doctor.
- [ ] Add adapter implementation.
- [ ] Add adapter contract tests.
- [ ] Add raw transcript/artifact persistence.
- [ ] Add placement policy facts.
- [ ] Add docs in `docs/adapters/<target>.md`.
- [ ] Commit independently.

## Phase 7: Debate Engine

**Goal:** Implement bounded multi-agent and multi-model debate over existing run/message/event primitives.

Subphases:

- Phase 7.1: Debate contracts and stores.
- Phase 7.2: Debate REST/SSE API.
- Phase 7.3: Participant run creation and placement.
- Phase 7.4: Round executor.
- Phase 7.5: Message router integration.
- Phase 7.6: Evidence store.
- Phase 7.7: Repeated-claim and low-new-information stopping.
- Phase 7.8: Judge/synthesizer flow.
- Phase 7.9: Final report artifact.

Exit criteria:

- A two-participant fake debate completes with transcript and report.
- A mixed real/fake debate can run with strict max rounds and cancellation.

## Phase 8: Hybrid Node Connectivity

**Goal:** Let hosted Switchyard coordinate connected local Switchyard nodes.

Subphases:

- Phase 8.1: Connected node registry.
- Phase 8.2: Node authentication and heartbeat.
- Phase 8.3: Hosted-to-local run request protocol.
- Phase 8.4: Local policy enforcement before execution.
- Phase 8.5: Event sync from local node to hosted server.
- Phase 8.6: Artifact sync policy.
- Phase 8.7: Hybrid placement decisions.

Exit criteria:

- Hosted API can create a run placed on a local node.
- Local node can reject work by policy.
- Events and artifacts sync only when policy allows.

## Phase 9: Policy, Approval, Memory, Tools, SDK, and CLI Completion

**Goal:** Complete the higher-level product modules after execution primitives are stable.

Subphases:

- Phase 9.1: Approval API and approval event flow.
- Phase 9.2: Tool router for search, fetch, browser, and repo tools.
- Phase 9.3: Memory search, remember, extract, and graph APIs.
- Phase 9.4: TypeScript SDK.
- Phase 9.5: CLI for doctor, local launch, runtime test, and debugging.
- Phase 9.6: Observability: logs, metrics, traces, and doctor endpoints.
- Phase 9.7: Security hardening and sandbox policy.

Exit criteria:

- Frontends/backends can build on the SDK.
- Risky actions pause and resume through approval APIs.
- Tool calls and memory operations are auditable.

## Phase 10: Product Hardening

**Goal:** Make Switchyard reliable enough to run real workloads.

Subphases:

- Phase 10.1: Failure recovery and idempotency.
- Phase 10.2: Event replay and stream resume.
- Phase 10.3: Artifact retention policies.
- Phase 10.4: Migration strategy.
- Phase 10.5: Adapter compatibility matrix automation.
- Phase 10.6: Load tests for SSE and worker queues.
- Phase 10.7: Security review.
- Phase 10.8: Release packaging for local and hosted modes.

## Start Here

The next concrete work should be:

1. Execute Phase -1.1 through Phase -1.5 to lock adapter facts.
2. Write a narrow Phase 0 execution plan with exact file contents and tests.
3. Implement Phase 0 only.
4. Do not start real adapters until the fake adapter and contract tests are passing.

## Plan Self-Review

Spec coverage:

- Deploy-anywhere local/hosted/hybrid model: covered by phases 1, 5, and 8.
- REST/SSE/acpx protocols: covered by phases 1, 2, and 5.
- Runtime adapters: covered by phases -1, 3, 4, and 6.
- Debate engine: covered by phase 7.
- Storage/artifacts: covered by phases 1 and 5.
- Policy/approvals/memory/tools: covered by phase 9.
- Observability/hardening: covered by phase 10.

Known intentional gaps:

- This is a master plan, not the final task-by-task execution plan for every source file in every phase.
- Each phase needs its own execution plan before implementation begins.
