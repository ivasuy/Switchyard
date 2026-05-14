# Switchyard Design

Date: 2026-05-11

## Summary

Switchyard is a deploy-anywhere agent runtime gateway. It exposes one stable API for running agent sessions, coordinating multi-agent and multi-model debates, routing messages between runtimes, managing approvals, storing artifacts, and normalizing events across many agent runtimes and wrapper systems.

Switchyard can run in three deployment modes:

- Local gateway: a single-machine service for local CLIs, repository access, subprocesses, PTY sessions, filesystem artifacts, and SQLite.
- Hosted gateway: a team/server deployment with Postgres, Redis/BullMQ, object storage, shared auth, workers, and remote access.
- Hybrid gateway: a hosted Switchyard coordinates with one or more local Switchyard nodes for local-only runtimes.

The API contract stays the same across modes. Frontends, backends, CLIs, and automation systems should call the same run, debate, runtime, model, artifact, tool, memory, approval, and event endpoints regardless of where Switchyard is deployed.

## Product Name

The product name is Switchyard.

The name fits the system because the product routes runtime sessions, model messages, debate-room events, artifacts, tools, and approvals across many provider and runtime targets. It has an infrastructure feel without implying that the product is limited to only debate, only agents, or only one provider.

## Architecture

Switchyard is a protocol-neutral agent runtime gateway with one stable public API and multiple deployment modes. The core domain model is:

- Run
- Debate
- RuntimeAdapter
- Provider
- Model
- Message
- Event
- Artifact
- Approval
- MemoryItem
- EvidenceItem
- RuntimeSession
- ContextPacket
- PlacementDecision

The central design rule is that protocols and runtime implementations live at the edges. REST, SSE, WebSocket, acpx, HTTP, subprocess, and PTY all translate into the same internal command and event model.

In local mode, Switchyard uses SQLite and filesystem artifacts and can directly control local CLIs, subprocesses, PTY sessions, repository tools, and local-only runtime adapters.

In hosted mode, Switchyard uses Postgres, Redis/BullMQ, object storage, hosted workers, and hosted-safe runtime adapters.

In hybrid mode, a hosted Switchyard coordinates with one or more local Switchyard nodes. This allows team-visible state, shared artifacts, and hosted APIs while still supporting local-only runtimes such as developer CLIs or repository-local workflows.

## Architecture Diagram

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
| Placement     |   | Event Bus       |
| Policy        |   | Message Router  |
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

Storage:
Local mode:  SQLite + filesystem artifacts
Hosted mode: Postgres + Redis/BullMQ + S3/R2
Hybrid mode: hosted server + local Switchyard nodes
```

## Deployment Modes

```text
Local Mode
App -> Switchyard Local Gateway -> Local CLI / PTY / HTTP / acpx runtimes
                         |
                    SQLite + files

Hosted Mode
App -> Switchyard Hosted Gateway -> Workers -> hosted-safe runtimes
                         |
              Postgres + Redis + object storage

Hybrid Mode
App -> Hosted Switchyard -> Local Switchyard Node -> local-only runtimes
              |
       shared state/artifacts/events
```

## Tech Stack

Switchyard will use:

- TypeScript on Node.js, strict mode.
- pnpm workspaces and Turborepo for the monorepo.
- Fastify for the API server.
- Zod for runtime contracts and TypeScript schema inference.
- Generated OpenAPI from the contract layer.
- Fastify streaming responses for SSE.
- WebSocket support only for interactive bidirectional control.
- A dedicated acpx protocol package for inbound server behavior and outbound client behavior.
- Drizzle ORM for Postgres and SQLite.
- Postgres for hosted mode.
- SQLite for local mode.
- Redis and BullMQ for hosted queues.
- A local queue abstraction backed by SQLite or an in-process queue for local mode.
- Filesystem artifacts locally.
- S3/R2-compatible object storage for hosted artifacts.
- Vitest for unit tests, contract tests, adapter integration tests, and smoke tests.

## Why This Stack

TypeScript and Node.js fit Switchyard because the product is a protocol and IO gateway. The system needs streaming APIs, JSON contracts, SDK sharing, fast adapter development, child process control, PTY fallback, WebSocket/SSE support, and many external SDK/API integrations. TypeScript keeps backend code, protocol contracts, SDK types, and future frontend consumers aligned.

Fastify is a good fit because it is lightweight, fast, and plugin-oriented. Switchyard has many API surfaces, but each surface should stay modular: runs, debates, providers, models, runtimes, tools, memory, artifacts, approvals, SSE, WebSocket, and acpx bridging.

Zod is the contract source of truth. It gives runtime validation and TypeScript types from the same definitions, which is important because Switchyard translates between protocols and must reject malformed messages at every boundary.

Drizzle is preferred over a heavier ORM because it supports both Postgres and SQLite cleanly while keeping SQL visible. Switchyard needs one storage abstraction that can work in local, hosted, and hybrid deployments.

Redis and BullMQ are enough for hosted job orchestration without adding heavier infrastructure early. They support delayed jobs, retries, worker pools, and operational visibility for run execution, debate rounds, tool calls, artifact extraction, and memory extraction.

Filesystem and S3/R2-compatible artifact stores keep the artifact model consistent across local and hosted modes. The core artifact service should not care whether bytes live on disk or in object storage.

acpx is first-class because Switchyard is both a consumer and provider of structured agent runtime protocol behavior. Switchyard should be able to control acpx-compatible runtimes and also present itself as an acpx-compatible runtime to external tools.

## Protocols

Switchyard defines protocols in three layers.

### Public Product API

REST is used for commands and queries:

- Create runs and debates.
- Inspect run and debate state.
- Send input and messages.
- Cancel or stop work.
- Approve or reject pending actions.
- List providers, models, and runtimes.
- Search tools and memory.
- Fetch artifacts, transcripts, diffs, proof reports, and debate reports.

SSE is used for normalized event streams:

- runtime.output
- runtime.status
- tool.call
- tool.result
- message.sent
- debate.round.started
- debate.agent.argument
- debate.agent.rebuttal
- debate.evidence.added
- debate.judge.summary
- debate.consensus
- approval.requested
- run.completed

WebSocket is reserved for interactive bidirectional control:

- Terminal input.
- Live runtime steering.
- Debate-room messages.
- Session attach and detach.
- Multi-agent chat and control.

### Agent Runtime Protocol

acpx is both inbound and outbound:

- Inbound acpx lets external agent clients treat Switchyard as an agent runtime.
- Outbound acpx lets Switchyard control acpx-compatible runtimes through a structured adapter.

Switchyard also supports:

- Native SDK/API adapters where runtimes expose official APIs.
- HTTP and webhook adapters for wrappers and remote runtimes.

### Fallback Execution Protocols

Switchyard supports fallback execution paths:

- Subprocess for non-interactive CLI runtimes.
- PTY for interactive terminal-style runtimes.
- Browser/search/tool adapters behind the same normalized event contract.

The important rule is that every protocol translates into Switchyard's internal command and event model. REST, SSE, WebSocket, acpx, HTTP, subprocess, and PTY must not each invent separate semantics.

## Runtime Adapter Targets

The architecture includes the full runtime target set from the product module:

- Claude Code adapter.
- Codex CLI adapter.
- OpenCode adapter.
- OpenClaw adapter.
- Paperclip adapter.
- AgentField adapter.
- Cursor adapter as future or experimental support.
- Browser/Search adapter.
- Process adapter.
- Generic HTTP adapter.

The preferred adapter path is native SDK/API, acpx, or HTTP/webhook when a runtime supports structured control. Subprocess and PTY are fallbacks for runtimes that only expose terminal behavior.

## Adapter Research Snapshot

Research date: 2026-05-11.

Adapter details are implementation-critical and can change quickly. Before coding each runtime adapter, Switchyard should verify the current command/API shape against official docs and a local smoke test. The design target remains the full adapter registry, but implementation order should follow confidence and protocol quality.

### Current Integration Matrix

| Target | Preferred integration | Fallback | Placement bias | Confidence | Implementation note |
|---|---|---|---|---|---|
| OpenCode | ACP via `opencode acp` | CLI/process | local or hosted worker with installed binary | High | Best first real ACP adapter. Official docs describe JSON-RPC over stdio. |
| Claude Code | TypeScript Agent SDK or `claude -p --output-format stream-json` | PTY/process | local first, hosted only with explicit sandbox/credentials | High | Use SDK/headless path before PTY. Supports programmatic control and streaming output. |
| Codex CLI | `codex exec --json` after local format validation | PTY/process | local first | Medium | Approval modes and local execution are documented; parser must be version-tested because JSON output schema has had drift concerns. |
| Cursor | `cursor-agent -p --output-format stream-json` | PTY/process | local first | Medium | Headless CLI exists; keep experimental until tested locally. |
| OpenClaw | HTTP/gateway adapter | process for local dev only | hosted or local | Medium | Treat OpenClaw as a wrapper runtime with its own sessions, workspace, queue, skills, and tool policy. |
| AgentField | REST API adapter, async execution preferred | HTTP sync for fast tasks | hosted or local | High | Treat as wrapper runtime; async execution is preferred for long-running LLM workflows. |
| Paperclip | HTTP adapter after API verification | none | hosted or local | Low | Keep in registry but do not implement until public/current API is verified. |
| Browser/Search | Native library/API adapter | process | hosted-safe with network policy | High | Implement as policy-constrained tool/runtime adapter with evidence artifacts. |
| Generic HTTP | HTTP adapter | none | hosted-safe | High | First wrapper adapter candidate and useful for tests. |
| Process | Node child process | none | local or sandboxed hosted worker | High | Fallback for non-interactive CLIs. |
| PTY | Node PTY package | process when non-interactive | local first | High | Required for interactive terminal runtimes, but should remain fallback because terminal parsing is brittle. |

### Source Notes

- Agent Client Protocol standardizes editor/agent communication and supports local subprocess JSON-RPC over stdio plus remote HTTP/WebSocket scenarios: <https://agentclientprotocol.com/get-started/introduction> and <https://agentclientprotocol.com/protocol/overview>.
- ACP sessions use `session/new`, `session/load`, `session/resume`, `session/close`, `cwd`, MCP server configuration, and capability checks: <https://agentclientprotocol.com/protocol/session-setup>.
- OpenCode documents `opencode acp` as an ACP-compatible subprocess using JSON-RPC over stdio: <https://opencode.ai/docs/acp/>.
- Claude Code documents programmatic usage through the Agent SDK and CLI `claude -p`, including stream JSON output: <https://code.claude.com/docs/en/headless> and <https://code.claude.com/docs/en/agent-sdk/overview>.
- Codex CLI is documented as a local terminal coding agent with approval modes; repository code indicates `codex exec --json` emits JSONL, but parser behavior must be locally verified before relying on it: <https://help.openai.com/en/articles/11096431-openai-codex-cli-getting-tarted> and <https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs>.
- Cursor documents headless CLI usage with `cursor-agent -p` and `--output-format stream-json`: <https://docs.cursor.com/en/cli/headless>.
- OpenClaw documents a self-hosted gateway/runtime with workspace, sessions, streaming, queue behavior, skills, and tool policy: <https://docs.openclaw.ai/concepts/agent>.
- AgentField documents REST execution APIs and recommends async execution for LLM/long-running work: <https://agentfield.ai/api/rest-api/overview>.

### Implementation Consequences

OpenCode should be the first real adapter because it validates Switchyard's ACP client path with a documented ACP runtime.

Claude Code should use Agent SDK/headless integration first. PTY is only for interactive fallback.

Codex should not be the first adapter despite being important. Its adapter needs a parser spike around the current JSONL event format, approval behavior, and artifact extraction.

Generic HTTP and AgentField should be early wrapper adapters because they validate hosted-safe runtime integration without local terminal control.

OpenClaw and Paperclip remain part of the target registry, but they should not block the foundation. OpenClaw can follow once its gateway API boundary is confirmed; Paperclip waits for API verification.

Process and PTY adapters should be local-first by policy. Hosted subprocess/PTY execution requires an explicit sandboxed worker design.

## Placement Policy

Switchyard uses placement decisions to decide where a run, debate participant, tool call, or runtime session should execute.

Placement inputs include:

- Runtime capabilities.
- Provider and model availability.
- Whether the runtime is local-only.
- Whether the runtime is hosted-safe.
- Workspace and repository access requirements.
- Data sensitivity.
- Approval policy.
- Tool policy.
- User or team settings.
- Cost and budget limits.

Placement outputs include:

- Execute locally.
- Execute hosted.
- Execute through a connected local node.
- Reject as not allowed.
- Wait for approval.

This allows a debate to contain a mix of hosted participants, HTTP/acpx participants, and local-only runtime participants without changing the public API.

## Module Boundaries

Switchyard should be a monorepo with hard ownership boundaries:

- `apps/server`: hosted gateway API, hosted workers, and hosted configuration.
- `apps/daemon`: local gateway/node process for local CLI, PTY, repository, and filesystem access.
- `apps/worker`: hosted background workers for runs, debates, tools, artifact extraction, memory extraction, and report generation.
- `packages/contracts`: Zod schemas, event envelopes, REST/acpx contract types, OpenAPI generation, and all run, runtime session, debate, message, event, artifact, approval, memory, evidence, context, tool, registry, placement, node, user, and budget schemas.
- `packages/core`: protocol-neutral services for runs, runtime sessions, debates, messages, placement, approvals, artifacts, memory, evidence, context building, tools, registry, event handling, event publishing, and connected nodes.
- `packages/protocol-rest`: REST route handlers for runs, sessions, debates, messages, tools, memory, artifacts, approvals, providers, models, runtimes, context, and nodes.
- `packages/protocol-sse`: event stream fanout, replay cursors, event filtering, and SSE formatting.
- `packages/protocol-ws`: interactive bidirectional channels for terminal input, runtime steering, attach/detach, and debate-room messages.
- `packages/protocol-acpx`: inbound acpx server and outbound acpx client.
- `packages/adapters`: runtime and tool adapter interfaces plus adapters for the full runtime target set.
- `packages/storage`: Postgres, SQLite, filesystem artifacts, object storage artifacts, event log, and repositories.
- `packages/queue`: BullMQ/Redis queue implementation and local queue abstraction.
- `packages/policy`: placement, approval, budget, tool, and runtime safety policies.
- `packages/sdk`: TypeScript client SDK for frontends and backends.
- `packages/cli`: admin and developer CLI for doctor, runtime test, local launch, and debugging.
- `packages/testkit`: fake runtimes, fake adapters, fixture events, fake stores, and shared contract tests.

Core must not know whether a command came from REST, acpx, WebSocket, or a local CLI. Protocol packages translate external messages into core commands and stream core events back out.

The module map must cover every major block in the architecture diagram:

- Run Manager maps to `run-service`.
- Debate/Deliberation Manager maps to `debate-service`.
- Provider/Model Registry and Runtime Registry map to `registry-service`.
- Event Bus maps to `event-bus`, `event-service`, and `event-store`.
- Session Store maps to `session-service` and `session-store`.
- Debate Store maps to `debate-store`.
- Message Router maps to `message-router`.
- Tool Router maps to `tool-router`.
- Context Builder maps to `context-builder` and context source ports.
- Approval/Policy Layer maps to `approval-service`, approval store, and `packages/policy`.
- Memory Layer maps to `memory-service` and `memory-store`.
- Artifact Manager maps to `artifact-service` and artifact stores.
- Runtime Adapter Layer maps to `packages/adapters` and the runtime adapter port.
- Storage Layer maps to `packages/storage`.

## Core APIs

The public API should be stable enough for any frontend, backend, CLI, or automation client to build against. Deployment mode must not change endpoint semantics.

### Run API

- `POST /runs`: create a runtime-backed agent run.
- `GET /runs/:id`: inspect run state.
- `GET /runs/:id/events`: stream normalized run events.
- `POST /runs/:id/input`: send user input or steering instructions.
- `POST /runs/:id/message`: send a message to one runtime session.
- `POST /runs/:id/broadcast`: broadcast a message to linked sessions.
- `POST /runs/:id/cancel`: cancel the run.
- `POST /runs/:id/approve`: approve or reject a pending action for the run.
- `GET /runs/:id/artifacts`: list artifacts produced by the run.

Run creation accepts runtime, provider, model, task, cwd, skills, tools, approval policy, placement hints, budget, timeout, and metadata. The response returns a run id immediately. Long-running work is observed through events.

### Debate API

- `POST /debates`: create a bounded debate.
- `GET /debates/:id`: inspect debate state.
- `GET /debates/:id/events`: stream debate events.
- `POST /debates/:id/message`: inject user instruction, evidence, or a question.
- `POST /debates/:id/stop`: stop the debate early.
- `GET /debates/:id/report`: fetch the final report.

Debate creation accepts topic, mode, participants, roles, tools, limits, evidence policy, judge configuration, placement hints, and metadata. Every debate has explicit stop conditions.

### Registry APIs

- `GET /providers`: list providers and health state.
- `GET /models`: list available models across providers and runtimes.
- `GET /providers/:id/models`: list provider-specific models.
- `GET /models/:id/doctor`: verify a model/runtime/auth combination.
- `GET /runtimes`: list runtime adapters.
- `GET /runtimes/:id/doctor`: verify binary, auth, protocol, and health.
- `POST /runtimes/:id/test`: test runtime launch and event streaming.

The registry is not only configuration. It is a source of placement facts: which runtimes can execute locally, hosted, through acpx, through HTTP, or through fallback process control.

### Message, Tool, Memory, Artifact, and Approval APIs

- `POST /channels/:channel/message`: send an inter-provider, same-provider, or debate-room message.
- `POST /tools/search`: perform search through the tool router.
- `POST /tools/fetch`: fetch URL, docs, article, or GitHub file content.
- `POST /tools/browser`: run browser automation.
- `POST /tools/repo`: perform repository search, diff, and file-read operations.
- `POST /memory/search`: retrieve memory.
- `POST /memory/remember`: store memory.
- `POST /memory/extract`: extract memory from a completed run or debate.
- `GET /memory/graph`: inspect memory relationships.
- `GET /artifacts/:run_id`: list artifacts.
- `GET /artifacts/:run_id/transcript`: fetch run transcript.
- `GET /artifacts/:run_id/diff`: fetch diff artifact.
- `GET /artifacts/:run_id/proof`: fetch proof-of-work report.
- `GET /approvals`: list pending approvals.
- `POST /approvals/:id/approve`: approve an action.
- `POST /approvals/:id/reject`: reject an action.

## Domain Contracts

Switchyard's core domain should be built around explicit contracts rather than framework-specific request objects.

### Run

A run represents one runtime-backed execution session.

Required fields:

- id
- runtime
- provider
- model
- adapter_type
- cwd
- task
- status
- placement
- approval_policy
- timeout_seconds
- created_at
- started_at
- ended_at

Run statuses:

- queued
- starting
- running
- waiting_for_input
- waiting_for_approval
- completed
- failed
- cancelled
- timeout

### RuntimeAdapter

Every runtime adapter implements the same contract:

- `check(config)`: verify binary, auth, protocol, and model availability.
- `start(request)`: start a runtime-backed run.
- `send(session, input)`: send input to a running session.
- `cancel(session)`: cancel a running session.
- `events(session)`: stream normalized runtime events.
- `tools(session)`: expose runtime-supported tools.
- `artifacts(session)`: collect transcript, diff, logs, screenshots, or results.

Adapters must not write directly to API responses. They emit normalized events and artifacts into core services.

### Debate

A debate represents a bounded deliberation room with participants, roles, rounds, evidence, and a final report.

Required fields:

- id
- topic
- mode
- status
- participants
- max_rounds
- max_turns_per_agent
- max_searches_per_agent
- max_total_messages
- max_duration_seconds
- max_cost_usd
- require_citations
- stop_on_consensus
- stop_on_low_new_information
- created_at
- completed_at

Debate statuses:

- created
- context_building
- researching
- arguing
- rebuttal
- judging
- consensus_found
- no_consensus
- stopped_by_user
- completed
- failed

### PlacementDecision

A placement decision records where and how a unit of work should execute.

Required fields:

- decision
- reason
- mode
- target_node
- required_capabilities
- denied_capabilities
- approval_required
- policy_trace

Allowed decisions:

- local
- hosted
- connected_local_node
- reject
- wait_for_approval

## acpx Responsibilities

Switchyard treats acpx as a first-class runtime protocol in both directions.

### Inbound acpx

Inbound acpx lets external agent clients connect to Switchyard as if Switchyard itself were an agent runtime. Inbound messages are translated into core commands such as create run, send input, cancel, and stream events.

Inbound acpx must preserve:

- Session identity.
- Message ordering.
- Cancellation semantics.
- Tool call boundaries.
- Approval pauses.
- Artifact references.
- Error causes.

### Outbound acpx

Outbound acpx lets Switchyard control acpx-compatible runtimes through the adapter layer. Outbound acpx is the preferred path when a runtime supports it because it is more structured than subprocess or PTY control.

Outbound acpx must map:

- Switchyard run creation to acpx session start.
- Switchyard input to acpx message send.
- acpx runtime output to normalized Switchyard events.
- acpx tool calls and results to tool events.
- acpx completion and failure to run status transitions.

### acpx Boundary Rule

The acpx package should not contain business logic for debates, memory, approvals, placement, or artifacts. It only translates between acpx protocol messages and core commands/events.

## Debate Engine

Switchyard supports cross-provider debate, same-provider model debate, mixed-model panels, and judge-and-jury flows.

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

Debate state must allow unresolved disagreement. Consensus is not required for completion.

## Debate Flow

Debate execution follows a bounded state machine:

1. Create debate and validate participants, tools, limits, and placement constraints.
2. Build shared context from topic, user instructions, memory, repository context, and supplied evidence.
3. Start participant runtime sessions using placement decisions.
4. Run independent research turns where allowed by the debate mode.
5. Store claims, evidence, citations, and uncertainty markers.
6. Share arguments through the message router.
7. Run rebuttal turns where participants challenge or refine claims.
8. Collapse repeated claims and detect low-new-information loops.
9. Ask judge or synthesizer for final synthesis.
10. Persist final report, transcript, evidence table, disagreements, and artifacts.
11. Emit terminal debate event.

Stop conditions are hard limits, not suggestions:

- Max rounds reached.
- Max turns per agent reached.
- Max total messages reached.
- Max duration reached.
- Max cost reached.
- Consensus found when `stop_on_consensus` is enabled.
- Low-new-information threshold reached.
- Judge terminates.
- User stops debate.
- Required participant fails and policy says the debate cannot continue.

## Message Router

The message router handles direct messages, channel messages, broadcast messages, debate-room messages, runtime-to-runtime handoff, and model-to-model handoff.

Every routed message should record:

- Source run or participant.
- Destination run, participant, channel, or debate room.
- Provider and model identity.
- Content.
- Attachments and artifact references.
- Delivery mode.
- Delivery status.
- Created and delivered timestamps.

Delivery modes include:

- Structured protocol message.
- acpx message.
- HTTP callback.
- Provider-specific prompt injection.
- Queued message until runtime ready.
- Terminal input for PTY runtime.

The router is responsible for preserving auditability. It is not responsible for deciding whether a message is allowed. Policy makes that decision before routing.

## Event Model

Every event uses a normalized envelope:

- id
- type
- run_id
- debate_id
- participant_id
- provider
- model
- sequence
- payload
- created_at

The event bus stores important events and streams live events to SSE and WebSocket clients. Event replay should be possible from persisted event logs.

Event ordering is per run, per debate, and per participant. Global ordering is useful but not required for correctness. Clients should rely on stream sequence fields within the relevant scope.

Important events are persisted. High-volume raw output can be compacted into transcript artifacts while retaining enough event metadata for replay, debugging, and audit.

## Storage

Local mode uses SQLite for metadata and event records, plus filesystem artifacts.

Hosted mode uses Postgres for metadata and event records, Redis/BullMQ for queued work, and S3/R2-compatible object storage for artifacts.

Hybrid mode combines hosted shared state with local node execution. The placement and policy layers decide which metadata and artifacts are synced back to hosted storage.

### Storage Tables

The initial relational schema should include:

- runs
- run_events
- providers
- models
- runtimes
- debates
- debate_participants
- debate_messages
- evidence_items
- runtime_sessions
- messages
- approvals
- memory_items
- context_packets
- artifacts
- artifact_blobs
- tool_invocations
- connected_nodes
- placement_decisions

The schema should store provider and model identity redundantly on events, messages, artifacts, and debate records. That redundancy is intentional because providers and model aliases can change over time.

### Artifact Layout

Artifacts should use a logical path independent of storage backend:

- `runs/{run_id}/transcript.jsonl`
- `runs/{run_id}/events.jsonl`
- `runs/{run_id}/logs/{name}.log`
- `runs/{run_id}/diffs/{name}.diff`
- `runs/{run_id}/proof/report.md`
- `debates/{debate_id}/transcript.jsonl`
- `debates/{debate_id}/evidence/{evidence_id}.json`
- `debates/{debate_id}/report.md`

The artifact manager maps logical paths to filesystem paths in local mode and object keys in hosted mode.

## Security and Policy

Switchyard needs policy enforcement before work crosses trust boundaries.

Policy gates include:

- Before destructive shell command.
- Before commit.
- Before push.
- Before PR creation.
- Before external web action.
- Before sending an external message.
- Before spending budget.
- Before cross-runtime delegation.
- Before same-provider model delegation.
- Before syncing local artifacts to hosted storage.
- Before exposing local repository data to hosted participants.

Hosted mode must not execute arbitrary subprocess or PTY workloads unless the deployment explicitly enables a sandboxed worker class for that purpose.

Local mode may execute subprocess and PTY adapters, but approval policy still applies. Local does not mean unrestricted.

Hybrid mode must treat connected local nodes as explicit trust boundaries. The hosted server can request work from a local node, but the local node enforces local policy before executing or syncing artifacts.

## Observability

Switchyard should produce operational visibility for both local and hosted deployments:

- Structured logs with run_id, debate_id, participant_id, provider, model, runtime, and adapter.
- Metrics for run count, debate count, adapter failures, queue latency, event lag, runtime duration, and artifact storage failures.
- Traces around run start, adapter calls, tool calls, debate turns, placement decisions, and artifact writes.
- Doctor endpoints for runtime, provider, model, storage, queue, artifact store, and acpx health.

Observability must avoid leaking secrets, prompts marked private, local file contents, or provider credentials.

## Error Handling

Switchyard should distinguish:

- Validation errors.
- Runtime unavailable errors.
- Model/provider unavailable errors.
- Placement policy denials.
- Approval-required pauses.
- Tool policy denials.
- Adapter launch failures.
- Adapter protocol failures.
- Runtime timeout.
- User cancellation.
- Debate budget exhaustion.
- Artifact persistence failures.

Every failed run or debate should preserve enough event and artifact data to explain what happened.

Errors should use stable machine-readable codes and human-readable messages. Public API errors should include a request id and, when available, run_id or debate_id.

## Client SDK

The TypeScript SDK should be generated from or directly backed by the shared contract package. It should support:

- Creating and inspecting runs.
- Creating and inspecting debates.
- Subscribing to SSE streams.
- Sending run input.
- Sending debate messages.
- Approving or rejecting actions.
- Fetching artifacts and reports.
- Listing providers, models, and runtimes.

The SDK should hide deployment mode differences. A client points at a Switchyard base URL and receives the same contract whether that URL is local, hosted, or hybrid.

## Testing

Testing should include:

- Unit tests for core domain services and policies.
- Contract tests for Zod schemas, REST requests/responses, SSE events, and acpx messages.
- Storage tests against SQLite and Postgres.
- Adapter interface tests using fake runtimes.
- Integration tests for HTTP, subprocess, PTY, and acpx adapter paths.
- End-to-end smoke tests for a simple run.
- End-to-end smoke tests for a bounded debate.
- Artifact persistence tests for filesystem and object storage backends.
- Placement-policy tests for local, hosted, and hybrid execution decisions.

## Verification Criteria

The design is ready to implement when these smoke tests are possible:

- Start Switchyard in local mode.
- Create a fake-runtime run through `POST /runs`.
- Stream events through `GET /runs/:id/events`.
- Send input through `POST /runs/:id/input`.
- Complete the run and fetch transcript artifacts.
- Start Switchyard in hosted-like mode with Postgres, Redis, and object storage substitutes.
- Run the same API flow without client contract changes.
- Create a two-participant fake-runtime debate.
- Stream debate events.
- Produce a final report artifact.
- Exercise an inbound acpx session mapped to a Switchyard run.
- Exercise an outbound acpx fake adapter mapped to normalized Switchyard events.

## Phased Roadmap

The architecture includes the full module map, but implementation should be phased so each stage produces a runnable proof.

### Phase -1: Adapter Research and Verification

Goal: turn current web research into implementation-ready adapter contracts.

Scope:

- Record exact versions and commands for OpenCode, Claude Code, Codex CLI, Cursor CLI, OpenClaw, AgentField, and Generic HTTP.
- Verify OpenCode ACP startup with `opencode acp` and capture the initialize/session/prompt flow.
- Verify Claude Code TypeScript Agent SDK or `claude -p --output-format stream-json` event shape.
- Verify Codex `exec --json` event shape and preserve raw JSONL logs as artifacts.
- Verify Cursor headless stream JSON behavior.
- Verify AgentField async REST flow and polling shape.
- Identify OpenClaw and Paperclip public API boundaries before scheduling implementation.
- Update adapter matrix with version, command, transport, auth, streaming format, session persistence, cancellation behavior, and artifact extraction.

Exit criteria:

- Each Phase 1-4 adapter has a confirmed command/API surface.
- Unverified adapters are explicitly marked deferred.
- Parser risks are documented before code is written.
- The first implementation target remains OpenCode ACP unless local verification fails.

### Phase 0: Repository and Contract Foundation

Goal: create the monorepo foundation and protocol-neutral domain contracts.

Scope:

- pnpm workspace and Turborepo setup.
- TypeScript strict configuration.
- `packages/contracts` with Zod schemas for runs, debates, events, messages, artifacts, approvals, memory, tools, providers, models, runtimes, nodes, budgets, users, and placement.
- `packages/contracts` also includes runtime sessions, evidence items, context packets, tool invocations, and artifact blob metadata.
- `packages/core` with domain ports and service shells for runs, runtime sessions, debates, messages, events, event bus, artifacts, approvals, memory, evidence, context building, tools, registry, placement, and nodes.
- `packages/storage` interfaces.
- `packages/adapters` runtime/tool interfaces and fake adapter.
- `packages/policy` interfaces for placement, approval, budget, runtime, and tool policy.
- `packages/testkit` fake stores, fake adapters, and fixture events.
- Basic test harness.

Exit criteria:

- Contract tests pass.
- Fake adapter can emit normalized events into core services.

### Phase 1: Local Gateway MVP

Goal: prove the API can run locally with stable contracts.

Scope:

- `apps/daemon` local gateway.
- Fastify REST routes for runs, providers, models, runtimes, artifacts, and SSE.
- SQLite storage implementation.
- Filesystem artifact store.
- Local queue abstraction.
- Fake adapter and process adapter.
- Basic doctor command.

Exit criteria:

- `POST /runs` starts a fake run.
- `GET /runs/:id/events` streams events.
- `GET /runs/:id/artifacts` returns transcript artifacts.
- Local run state survives process restart when persisted.

### Phase 2: acpx Protocol Foundation

Goal: make acpx a first-class inbound and outbound protocol.

Scope:

- `packages/protocol-acpx`.
- Inbound acpx server mapped to core run commands.
- Outbound acpx client adapter.
- acpx contract tests.
- Fake acpx runtime for integration tests.

Exit criteria:

- External acpx client can create and drive a Switchyard run.
- Switchyard can drive a fake acpx runtime and normalize its events.

### Phase 3: First Real ACP Adapter

Goal: validate the real ACP client path with OpenCode.

Scope:

- OpenCode adapter using `opencode acp`.
- ACP initialize/session/prompt/cancel mapping.
- Event normalization from ACP session updates.
- Raw protocol log artifact.
- Adapter doctor check for binary, auth/config, and version.

Exit criteria:

- Switchyard can start an OpenCode-backed run.
- Events stream through Switchyard SSE.
- Cancellation and completion are normalized.
- Raw ACP transcript is stored as an artifact.

### Phase 4: Claude Code Adapter

Goal: integrate Claude Code through the most structured current path.

Scope:

- Claude Code TypeScript Agent SDK adapter, or CLI stream-json adapter if SDK integration is blocked.
- Tool-call and output normalization.
- Session id capture and resume behavior where supported.
- Approval/policy mapping.
- Raw stream artifact.

Exit criteria:

- Switchyard can start a Claude Code-backed run.
- Streaming output appears as normalized events.
- Tool calls and approval pauses are represented without PTY parsing.

### Phase 5: Hosted Gateway MVP

Goal: run the same API in hosted mode.

Scope:

- `apps/server` hosted API.
- Postgres storage implementation.
- Redis/BullMQ queue implementation.
- S3/R2-compatible artifact store abstraction.
- Hosted worker process.
- Event fanout through Redis pub/sub or equivalent.

Exit criteria:

- Same run API flow works against hosted mode.
- Worker executes queued fake runs.
- Events stream to SSE clients.
- Artifacts persist through object storage adapter.

### Phase 6: Runtime Adapter Expansion

Goal: add real runtime targets without changing the core API.

Scope:

- Generic HTTP adapter.
- AgentField REST adapter.
- Codex CLI adapter after JSONL/parser verification.
- Cursor headless adapter after stream verification.
- Browser/Search adapter.
- Process and PTY fallback adapters.
- Doctor checks per adapter.

Later adapters:

- OpenClaw.
- Paperclip.
- AgentField.
- Cursor experimental adapter.

Exit criteria:

- Each adapter passes the shared adapter contract test.
- Each adapter supports check, start, send where applicable, cancel, events, and artifacts.

### Phase 7: Debate Engine

Goal: implement bounded multi-agent and multi-model debate.

Scope:

- Debate creation API.
- Participant assignment.
- Round execution.
- Message router integration.
- Evidence collection.
- Judge/synthesizer flow.
- Stop conditions.
- Debate report artifacts.

Exit criteria:

- Two or more fake participants can complete a debate.
- Same-provider model debate and cross-provider debate are represented in the contract.
- Debate report includes final answer, confidence, arguments, counterarguments, evidence, disagreements, and transcript references.

### Phase 8: Hybrid Node Connectivity

Goal: allow hosted Switchyard to coordinate connected local Switchyard nodes.

Scope:

- Local node registration.
- Secure node connection.
- Placement decisions targeting connected local nodes.
- Remote run request from hosted to local.
- Local policy enforcement.
- Artifact and event sync rules.

Exit criteria:

- Hosted API can create a run placed on a connected local node.
- Local node can reject work based on local policy.
- Events and artifacts sync according to policy.

### Phase 9: Memory, Tools, Approval, and SDK Completion

Goal: complete the higher-level product modules.

Scope:

- Memory search, remember, extract, and graph APIs.
- Tool router for search, fetch, browser, and repo tools.
- Approval API and policy gates.
- TypeScript SDK.
- CLI for doctor, local launch, runtime tests, and debugging.

Exit criteria:

- Frontend/backend consumers can use the SDK for runs, debates, events, approvals, and artifacts.
- Approval-required actions pause and resume correctly.
- Tool calls are policy-checked and auditable.

## Non-Goals for First Implementation

The first implementation should not attempt:

- A full production UI.
- Billing.
- Multi-tenant enterprise authorization beyond the interface boundaries.
- Perfect support for every named runtime adapter.
- Vector memory as a dependency for run/debate execution.
- Arbitrary hosted subprocess execution without an explicit sandbox design.
- Cursor adapter completeness before a stable headless/runtime interface exists.

These are intentionally deferred so the gateway contract, event model, adapter contract, and deployment modes are proven first.

## Initial Implementation Direction

The design includes the full module map, but implementation should start by establishing the shared contracts, core command/event model, storage abstraction, REST/SSE API, acpx package boundary, and fake runtime adapter. Real runtime adapters can then be added behind the same contract without changing the public API.

The first usable proof should allow a frontend, backend, or CLI to create a run through the REST API, stream normalized events, fetch artifacts, and exercise the same flow in local and hosted-like modes.
