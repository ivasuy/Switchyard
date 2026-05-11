# Switchyard Architecture

Switchyard is a protocol-neutral runtime gateway. Its job is to expose many agent runtimes and wrappers through one stable backend API while preserving runtime-specific capabilities behind adapters.

The core architectural idea is separation:

```text
Runtime does the work.
Switchyard manages the work.
Adapters normalize every runtime.
Provider/model registry describes what can run.
Placement policy decides where it should run.
Event bus streams what happened.
Message router lets agents talk.
Artifacts preserve proof.
Approvals control risky actions.
```

## High-Level Architecture

```text
Frontend / Backend / CLI / Automation
        |
        | REST / SSE / WebSocket / acpx
        v
+-----------------------------+
|        Switchyard API       |
|  Runs Debates Registry etc. |
+--------------+--------------+
               |
               v
+-----------------------------+
|      Gateway Core Domain    |
| Run Debate Message Event    |
| Artifact Approval Memory    |
+--------------+--------------+
               |
        +------+------+
        |             |
        v             v
+---------------+   +----------------+
| Placement     |   | Event Bus      |
| Policy        |   | Message Router |
+-------+-------+   +--------+-------+
        |                    |
        v                    v
+-----------------------------+
|      Runtime Adapter Layer  |
| acpx Native HTTP Process PTY|
+--------------+--------------+
               |
   +-----------+-----------+
   |           |           |
   v           v           v
Claude/Codex  OpenCode    Wrappers
OpenClaw      AgentField  Browser/Search
Paperclip     Cursor      Generic HTTP
```

## Layer-by-Layer Design

### Client Layer

```text
Frontend / Backend / CLI / Automation
```

These are the consumers of Switchyard:

- Web dashboards.
- SaaS backends.
- CLI tools.
- GitHub bots.
- CI pipelines.
- Local developer apps.
- Internal ops systems.

They do not integrate with each runtime directly. They call Switchyard through stable APIs.

### Public Protocol Layer

```text
REST / SSE / WebSocket / acpx
```

Switchyard supports multiple public protocols because different clients need different interaction patterns.

#### REST

REST is used for commands and queries:

```text
POST /runs
GET  /runs/:id
POST /runs/:id/input
POST /runs/:id/cancel
POST /runs/:id/approve
GET  /runs/:id/artifacts

POST /debates
GET  /debates/:id
POST /debates/:id/message
POST /debates/:id/stop
GET  /debates/:id/report

GET  /runtimes
GET  /providers
GET  /models
POST /tools/search
POST /memory/search
```

REST is simple, app-friendly, cacheable where appropriate, and works with every frontend/backend stack.

#### SSE

SSE is used for one-way live streaming from Switchyard to clients:

```text
GET /runs/:id/events
GET /debates/:id/events
```

Typical events:

```text
run.started
runtime.output
runtime.status
tool.call
tool.result
file.changed
message.sent
approval.requested
debate.round.started
debate.agent.argument
debate.agent.rebuttal
debate.evidence.added
debate.judge.summary
run.completed
```

SSE is preferred over WebSocket when most traffic is server to client. It is easier to operate, easier to retry, and maps naturally to event streams.

#### WebSocket

WebSocket is reserved for bidirectional interactive control:

- Browser terminal input.
- Live runtime steering.
- Debate-room chat/control.
- Session attach and detach.
- Manual input into PTY runtimes.

WebSocket is not the default event mechanism. It is used when clients need to send repeated live input while receiving live output.

#### acpx

acpx is the structured agent-runtime protocol path.

Switchyard supports acpx in both directions:

- Inbound acpx: external agent clients can treat Switchyard as an agent runtime.
- Outbound acpx: Switchyard can control acpx-compatible runtimes through a structured adapter.

This makes Switchyard useful both to normal application clients and to agent-native tools.

### Switchyard API Layer

```text
+-----------------------------+
|        Switchyard API       |
|  Runs Debates Registry etc. |
+-----------------------------+
```

The API layer is the public product boundary. It owns request validation, auth hooks, route wiring, response formatting, and protocol translation.

It does not own core business logic. It converts incoming REST, WebSocket, or acpx messages into core commands and streams core events back to clients.

### Gateway Core Domain

```text
+-----------------------------+
|      Gateway Core Domain    |
| Run Debate Message Event    |
| Artifact Approval Memory    |
+-----------------------------+
```

The core domain is the heart of Switchyard. It is protocol-neutral and deployment-mode neutral.

Core objects:

- `Run`: one runtime-backed execution.
- `Debate`: a bounded multi-agent or multi-model discussion.
- `Message`: direct, broadcast, channel, handoff, or debate-room communication.
- `Event`: normalized output or lifecycle transition.
- `Artifact`: transcript, diff, screenshot, log, evidence pack, or report.
- `Approval`: human-in-the-loop gate.
- `MemoryItem`: reusable cross-run or project knowledge.
- `Provider`: model provider identity and auth mode.
- `Model`: model capability and health metadata.
- `RuntimeAdapter`: executable runtime integration.
- `PlacementDecision`: where and how work should run.

Core services should not know whether a request came from REST, acpx, WebSocket, or a local CLI.

## Placement Policy

```text
+---------------+
| Placement     |
| Policy        |
+---------------+
```

Placement policy decides where and how a task should run.

Questions it answers:

```text
Should this run locally or hosted?
Should this use Claude Code or Codex?
Should this use acpx, HTTP, subprocess, or PTY?
Should this run in OpenClaw or directly in Codex?
Should this use GPT-5.5 or GPT-5.3?
Should this run through a local node because repo files are private?
Should this pause for approval?
```

Example:

```text
Task:
  "Fix this local repo bug"

Placement:
  local Switchyard node
  Codex adapter
  cwd = local repo
  acpx if available
  PTY fallback if needed
```

Example:

```text
Task:
  "Run SWE-AF on this GitHub repo"

Placement:
  AgentField adapter
  hosted or local depending on config and policy
```

Example:

```text
Task:
  "Search web and debate next president of India"

Placement:
  browser/search adapter
  multiple model participants
  debate manager
  max rounds/cost limits
```

Placement is explicit so Switchyard can support local, hosted, and hybrid deployment without changing the client API.

## Event Bus and Message Router

```text
+----------------+
| Event Bus      |
| Message Router |
+----------------+
```

### Event Bus

The event bus receives raw or adapter-level runtime events and broadcasts normalized events to:

- SSE clients.
- WebSocket clients.
- Storage.
- Approval engine.
- Artifact manager.
- Debate manager.
- Memory extractor.

Example event:

```json
{
  "type": "tool.call",
  "run_id": "run_123",
  "tool": "bash",
  "command": "npm test"
}
```

Events use a stable envelope:

```text
id
type
run_id
debate_id
participant_id
provider
model
sequence
payload
created_at
```

Event ordering is scoped by run, debate, and participant. Clients should rely on sequence fields in the relevant stream rather than assuming perfect global ordering.

### Message Router

The message router handles agent-to-agent communication:

```text
Claude Code -> Codex
Codex GPT-5.5 -> Codex GPT-5.3
OpenClaw -> AgentField
Paperclip -> Claude Code
```

It supports:

- Direct messages.
- Broadcast messages.
- Channels.
- Handoffs.
- Debate-room messages.
- Queued delivery.

The router records source, destination, provider/model identity, attachments, delivery mode, delivery status, and timestamps. Policy decides whether a message is allowed; the router handles delivery.

## Runtime Adapter Layer

```text
+-----------------------------+
|      Runtime Adapter Layer  |
| acpx Native HTTP Process PTY|
+-----------------------------+
```

Every runtime is different, so Switchyard normalizes them through adapters.

### Adapter Contract

Every adapter implements:

```text
check(config)
start(request)
send(session, input)
cancel(session)
events(session)
tools(session)
artifacts(session)
```

Adapters must emit normalized events and artifacts. They should not leak runtime-specific output formats into the core domain.

### Native

Use an official SDK/API when a runtime provides one.

Native is preferred because it is usually the most reliable and least lossy path.

### acpx / ACP

Use a structured agent protocol where available.

acpx is better than terminal scraping because it can preserve structured runtime concepts:

```text
message
status
tool call
tool result
artifact
approval pause
completion
failure
```

Good targets:

- Codex when acpx-compatible.
- Claude Code when acpx-compatible.
- OpenCode when acpx-compatible.
- OpenClaw when acpx-compatible.
- Cursor if a stable headless/acpx interface exists.

### HTTP / Webhook

Use HTTP for wrapper products and deployed agent services:

- OpenClaw Gateway.
- Paperclip.
- AgentField.
- Custom agents.
- Generic HTTP workers.

HTTP adapters map external run/status/events APIs into Switchyard's normalized lifecycle.

### Process

Use process execution when a runtime is a non-interactive CLI command:

```text
spawn process
capture stdout/stderr
wait for exit
map output to events
collect logs/artifacts
```

Good targets:

- `codex exec`
- `opencode run`
- Custom shell agents.

### PTY

Use PTY when a runtime requires an interactive terminal:

```text
fake terminal
send keyboard input
stream terminal output
resize terminal
attach/detach session
```

PTY is powerful but messy, so it is the fallback path for interactive agents.

## Runtime Targets

Switchyard supports direct runtimes and wrapper runtimes.

### Direct Runtimes

These do the actual work:

- Claude Code.
- Codex CLI.
- OpenCode.
- Cursor.
- Gemini or other CLI runtimes.
- Browser/Search agent.

### Wrapper Runtimes

These are systems that themselves wrap agents:

- OpenClaw.
- Paperclip.
- AgentField.
- SWE-AF style systems.
- Generic HTTP agents.

Switchyard treats wrappers like normal runtime targets:

```text
start
stream
send input
cancel
collect artifacts
```

Example:

```text
Switchyard
-> Paperclip adapter
-> Paperclip
-> Claude Code
```

Example:

```text
Switchyard
-> AgentField adapter
-> SWE-AF
-> Claude Code / OpenCode
```

## Adapter Research Snapshot

Research date: 2026-05-11.

Adapter details are time-sensitive. Switchyard should treat every real adapter as a versioned integration and keep a small compatibility matrix in the codebase once implementation starts.

### Current Findings

| Target | Best first integration path | Fallback | Placement bias | Confidence | Notes |
|---|---|---|---|---|---|
| OpenCode | ACP via `opencode acp` | CLI/process | local or hosted worker with installed binary | High | OpenCode documents ACP support through JSON-RPC over stdio. This should be the first real ACP adapter. |
| Claude Code | TypeScript Agent SDK or `claude -p --output-format stream-json` | PTY/process | local first, hosted only with explicit credentials/sandbox | High | Claude Code exposes a current Agent SDK and programmatic CLI path with streaming JSON. Treat SDK as preferred over terminal scraping. |
| Codex CLI | `codex exec --json` / process adapter after local validation | PTY/process | local first | Medium | Codex is local-terminal oriented with approval modes. Its JSON output should be version-tested because public issues show schema/documentation drift concerns. |
| Cursor | `cursor-agent -p --output-format stream-json` | PTY/process | local first | Medium | Cursor documents headless CLI and streaming JSON. Treat as experimental until command behavior is tested locally. |
| OpenClaw | HTTP/gateway adapter | process only for local dev | hosted or local depending on deployment | Medium | OpenClaw is itself a gateway with sessions, workspace, streaming, queue behavior, skills, and tool policy. Switchyard should integrate at its gateway boundary, not by controlling its internals. |
| AgentField | REST API adapter, async execution preferred | HTTP sync for fast tasks | hosted or local | High | AgentField exposes REST execution APIs with async execution for long-running LLM workflows. Switchyard should treat it as a wrapper runtime. |
| Paperclip | HTTP adapter | none until API verified | hosted or local | Low | Needs source verification before implementation. Keep as planned adapter, not first implementation target. |
| Browser/Search | Native library/API adapter | process | hosted-safe with policy | High | Should be implemented as a Switchyard tool/runtime adapter with strict network and evidence policy. |
| Generic HTTP | HTTP adapter | none | hosted-safe | High | Easiest wrapper adapter. Useful for tests and third-party integrations. |
| Process | Node child process | none | local or sandboxed hosted worker | High | Useful fallback for non-interactive CLIs. |
| PTY | Node PTY package | process when non-interactive | local first | High | Required for interactive runtimes but should be fallback because parsing terminal state is brittle. |

### Sources

- Agent Client Protocol introduction and overview: <https://agentclientprotocol.com/get-started/introduction>, <https://agentclientprotocol.com/protocol/overview>
- ACP session setup and capability rules: <https://agentclientprotocol.com/protocol/session-setup>
- OpenCode ACP and CLI docs: <https://opencode.ai/docs/acp/>, <https://opencode.ai/docs/cli/>
- Claude Code programmatic usage and Agent SDK docs: <https://code.claude.com/docs/en/headless>, <https://code.claude.com/docs/en/agent-sdk/overview>
- OpenAI Codex CLI docs/help and repo implementation references: <https://help.openai.com/en/articles/11096431-openai-codex-cli-getting-tarted>, <https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs>
- Cursor headless CLI docs: <https://docs.cursor.com/en/cli/headless>
- OpenClaw agent runtime docs: <https://docs.openclaw.ai/concepts/agent>
- AgentField REST API docs: <https://agentfield.ai/api/rest-api/overview>

### Architecture Implications

The first real adapter should be OpenCode over ACP because it directly validates Switchyard's structured protocol path.

Claude Code should not start with PTY. Use the TypeScript Agent SDK or streaming JSON CLI first, then keep PTY as an interactive fallback.

Codex should be integrated through a process adapter only after a local spike confirms the current `codex exec --json` event format. Switchyard must version its Codex parser and preserve raw JSONL logs as artifacts.

Hosted mode must avoid arbitrary PTY/subprocess execution by default. Process and PTY adapters should run locally or inside an explicitly sandboxed hosted worker class.

OpenClaw, Paperclip, AgentField, and Generic HTTP should be treated as wrapper runtimes. Their adapters should target their public HTTP/session APIs and normalize their outputs into Switchyard events.

## Debate Engine

Switchyard supports:

- Cross-provider debate.
- Same-provider model debate.
- Mixed-model panels.
- Judge-and-jury workflows.

The debate manager owns:

- Debate room creation.
- Participant assignment.
- Provider/model/role mapping.
- Round state.
- Turn budgets.
- Search and tool budgets.
- Duration and cost limits.
- Evidence collection.
- Repeated-claim collapse.
- Low-new-information stopping.
- Judge synthesis.
- Final report generation.

Debate completion does not require consensus. A high-quality final report can preserve unresolved disagreements.

## Storage Modes

### Local Mode

```text
SQLite + filesystem artifacts
```

Used for:

- Local developer machines.
- Single-user daemon mode.
- Private repository access.
- CLI-first workflows.

Stores:

- Runs.
- Events.
- Messages.
- Approvals.
- Memory.
- Transcripts.
- Diffs.
- Logs.
- Screenshots.
- Evidence.

### Hosted Mode

```text
Postgres + Redis/BullMQ + S3/R2
```

Used for:

- Team deployment.
- Multi-user apps.
- Hosted APIs.
- Background workers.
- Shared state.

Postgres stores durable metadata and events.

Redis/BullMQ handles queues and background jobs.

S3/R2 stores large artifacts.

### Hybrid Mode

```text
hosted server + local Switchyard nodes
```

Used when hosted Switchyard needs to control local-only runtimes:

```text
Hosted Switchyard
-> asks Local Switchyard Node
-> local node runs Claude Code/Codex on private repo
-> streams events/artifacts back
```

Hybrid mode matters because local logins, private filesystems, local credentials, repository checkouts, and PTY sessions often cannot run safely in the cloud.

## Deployment Diagrams

### Local Mode

```text
App -> Switchyard Local Gateway -> Local CLI / PTY / HTTP / acpx runtimes
                         |
                    SQLite + files
```

### Hosted Mode

```text
App -> Switchyard Hosted Gateway -> Workers -> hosted-safe runtimes
                         |
              Postgres + Redis + object storage
```

### Hybrid Mode

```text
App -> Hosted Switchyard -> Local Switchyard Node -> local-only runtimes
              |
       shared state/artifacts/events
```

## Repository Shape

Switchyard is a TypeScript monorepo. Protocol, storage, and runtime-specific code stay at the edge; `packages/core` owns the protocol-neutral product model.

```text
switchyard/
  apps/
    daemon/
    node/
    server/
    worker/
  packages/
    adapters/
    cli/
    contracts/
    core/
    policy/
    protocol-acpx/
    protocol-node/
    protocol-rest/
    protocol-sse/
    protocol-ws/
    queue/
    sdk/
    storage/
    testkit/
  docs/
    adapters/
    decisions/
    superpowers/
```

### Apps

- `apps/daemon`: local standalone Switchyard gateway. It wires local Fastify routes, SQLite, filesystem artifacts, local queues, local policy, and local-capable adapters.
- `apps/node`: remote execution node for teams running workers on different servers. It connects outward to hosted/team Switchyard, receives assigned work, enforces node policy, runs local/server-local adapters, and syncs approved events/artifacts.
- `apps/server`: hosted/team Switchyard API. It owns public API serving, org/team auth hooks, node coordination, Postgres, Redis/BullMQ, object storage, and hosted-safe adapters.
- `apps/worker`: hosted background worker process for queued runs, debate turns, tools, artifact extraction, memory extraction, and report generation.

### Core Packages

- `packages/contracts`: Zod schemas and TypeScript types for every shared object: runs, sessions, debates, events, messages, artifacts, approvals, memory, evidence, tools, registry, placement, nodes, node-control, users, budgets, context, and errors.
- `packages/core`: protocol-neutral services and ports. It contains run, session, debate, event, message, artifact, approval, memory, evidence, tool, registry, placement, node, remote-control, and context services.
- `packages/policy`: placement, approval, runtime safety, remote-node, tool, and budget policies.
- `packages/testkit`: fake adapters, fake stores, fixtures, and shared contract tests so the system can be built before real runtime integrations exist.

### Protocol Packages

- `packages/protocol-rest`: Fastify REST route groups for runs, debates, providers, models, runtimes, nodes, messages, tools, memory, artifacts, sessions, context, and approvals.
- `packages/protocol-sse`: event stream formatting, replay cursors, filtering, reconnect behavior, and server-to-client event delivery.
- `packages/protocol-ws`: bidirectional control for terminal input, runtime steering, session attach/detach, and debate-room messages.
- `packages/protocol-acpx`: inbound ACP/acpx server and outbound ACP/acpx client. It translates between ACP messages and Switchyard core commands/events.
- `packages/protocol-node`: hosted-to-node remote-control protocol for teams running Switchyard nodes on different servers. It handles authenticated node connection, heartbeat, command delivery, cancellation, event sync, artifact sync manifests, and reconnect replay.

### Runtime and Integration Packages

- `packages/adapters`: runtime and tool integrations. Adapter folders include `opencode`, `claude-code`, `codex`, `cursor`, `openclaw`, `paperclip`, `agentfield`, `browser-search`, `generic-http`, `process`, and `pty`.
- `packages/storage`: persistence implementations for in-memory tests, SQLite local mode, Postgres hosted mode, filesystem artifacts, and S3/R2-compatible object storage.
- `packages/queue`: local in-process queue and hosted Redis/BullMQ queue implementations.
- `packages/sdk`: typed client for frontend, backend, CLI, automation, and third-party consumers.
- `packages/cli`: developer/admin commands for doctor, local launch, runtime test, adapter verification, and debugging.

### Important File Responsibilities

- `apps/*/src/config.ts`: reads deployment-specific configuration.
- `apps/*/src/app.ts`: composes dependency wiring for that app.
- `apps/*/src/main.ts`: process entrypoint.
- `apps/node/src/connection-client.ts`: maintains the outbound remote-control connection to hosted/team Switchyard.
- `apps/node/src/job-runner.ts`: executes remotely assigned work through core services and adapters.
- `apps/node/src/artifact-sync.ts`: applies node artifact sync policy before uploading outputs.
- `apps/worker/src/run-worker.ts`: claims and executes hosted run jobs.
- `apps/worker/src/debate-worker.ts`: executes debate rounds and judge synthesis.
- `apps/worker/src/tool-worker.ts`: executes queued or long-running tool calls.
- `packages/contracts/src/*.ts`: one source of truth for domain shapes and boundary validation.
- `packages/core/src/ports/*.ts`: interfaces for stores, queues, policies, adapters, context sources, and remote-control channels.
- `packages/core/src/services/*.ts`: product behavior that remains independent of REST, SSE, WebSocket, acpx, storage, and runtime implementations.
- `packages/protocol-node/src/control-channel.ts`: long-lived authenticated server-node channel.
- `packages/protocol-node/src/node-client.ts`: node-side client used by `apps/node`.
- `packages/protocol-node/src/node-server.ts`: hosted/server-side node coordinator.
- `packages/protocol-node/src/replay.ts`: missed command/event replay after reconnect.

## Tech Stack

Switchyard uses:

- TypeScript on Node.js, strict mode.
- pnpm workspaces and Turborepo.
- Fastify for REST, SSE, and server composition.
- Zod for runtime contracts and TypeScript schema inference.
- Generated OpenAPI from contract schemas.
- WebSocket support only for interactive bidirectional control.
- Dedicated acpx protocol package.
- Drizzle ORM for Postgres and SQLite.
- Postgres for hosted metadata and events.
- SQLite for local metadata and events.
- Redis/BullMQ for hosted job orchestration.
- Filesystem artifact storage locally.
- S3/R2-compatible object storage hosted.
- Vitest for unit, contract, adapter, and smoke tests.

## Why This Stack

### TypeScript and Node.js

Switchyard is a protocol and IO gateway. It needs streaming APIs, JSON contracts, SDK sharing, adapter development, child process control, PTY fallback, WebSocket/SSE support, and many external SDK/API integrations.

TypeScript lets backend contracts, SDK types, and future frontend consumers share the same model. Node.js is a practical fit for IO-heavy runtime orchestration.

### Fastify

Fastify is lightweight, fast, and plugin-oriented. Switchyard has many API surfaces: runs, debates, providers, models, runtimes, tools, memory, artifacts, approvals, SSE, WebSocket, and acpx bridging. Fastify lets those surfaces stay modular.

### Zod

Zod is the source of truth for runtime validation and TypeScript types. Switchyard translates between protocols, so every boundary needs validation.

### Drizzle

Drizzle supports Postgres and SQLite while keeping SQL understandable. That matters because Switchyard must run locally, hosted, and hybrid without maintaining two unrelated persistence layers.

### Redis and BullMQ

Redis/BullMQ provide practical hosted job orchestration for run execution, debate rounds, tool calls, artifact extraction, retries, and worker pools.

### Filesystem and S3/R2 Artifacts

Artifacts should have one logical model regardless of backend. Local mode maps logical artifact paths to files. Hosted mode maps them to object storage keys.

### acpx

acpx gives Switchyard a structured agent-runtime protocol path. It is better than PTY where available and lets Switchyard operate as both:

```text
an API gateway for normal apps
an agent-runtime surface for agent-native clients
```

## Security and Policy

Switchyard must enforce policy before work crosses trust boundaries.

Policy gates include:

- Before destructive shell commands.
- Before commit.
- Before push.
- Before PR creation.
- Before external web actions.
- Before sending external messages.
- Before spending budget.
- Before cross-runtime delegation.
- Before same-provider model delegation.
- Before syncing local artifacts to hosted storage.
- Before exposing local repository data to hosted participants.

Hosted mode must not execute arbitrary subprocess or PTY workloads unless explicitly deployed with a sandboxed worker class.

Local mode may execute subprocess and PTY adapters, but approval policy still applies.

Hybrid mode treats local nodes as trust boundaries. Hosted Switchyard can request work, but the local node enforces local policy before executing or syncing artifacts.

## Observability

Switchyard should expose:

- Structured logs with run, debate, participant, provider, model, runtime, and adapter identifiers.
- Metrics for run counts, debate counts, adapter failures, queue latency, event lag, runtime duration, and artifact failures.
- Traces around run start, adapter calls, tool calls, debate turns, placement decisions, and artifact writes.
- Doctor endpoints for runtime, provider, model, storage, queue, artifact store, and acpx health.

Observability must not leak secrets, private prompts, local file contents, or provider credentials.

## Recommended Build Order

The architecture includes the full product map, but implementation should prove the foundation first:

0. Adapter research matrix and local command verification.
1. Contract foundation.
2. Local gateway with fake runtime.
3. acpx inbound and outbound protocol package.
4. First real ACP adapter: OpenCode.
5. Claude Code SDK/headless adapter.
6. Hosted gateway with workers.
7. Generic HTTP and AgentField adapters.
8. Codex and Cursor process/headless adapters after parser spikes.
9. Debate engine.
10. Hybrid node connectivity.
11. Memory, tools, approvals, SDK, and CLI completion.

Each phase should produce a runnable proof rather than only internal scaffolding.

For the detailed phase/subphase plan, use [the master implementation plan](./docs/superpowers/plans/2026-05-11-switchyard-master-implementation-plan.md).

For the diagram-to-module checklist, use [the module coverage audit](./docs/decisions/2026-05-11-module-coverage-audit.md).
