# Phase 9 Spec: R10 Hosted And Hybrid Execution

Date: 2026-05-30

Roadmap release: R10: Hosted And Hybrid Execution

Branch: `agent/phase-9-r10-hosted-and-hybrid-execution`

Previous phase head: `97ff493bd4a2cedfc5f20a801f1d6771aec6c190`

Spec target: `docs/superpowers/specs/2026-05-30-phase-9-r10-hosted-and-hybrid-execution.md`

## Summary

R10 makes Switchyard usable in hosted-like and hybrid deployments without changing the public run contract. A client should still create, inspect, stream, cancel, and fetch artifacts for a run through the same run API whether the execution is local, hosted-safe, or delegated to a connected local node.

The release is deliberately safety-first. Hosted execution only runs a hosted-safe deterministic fake runtime. Existing subprocess, PTY, local-auth, and workspace-sensitive adapters stay local-only or connected-local-node-only until an explicit sandbox design ships.

## Scope Gate

In scope:

- Hosted server app under `apps/server`.
- Hosted worker app under `apps/worker`.
- Postgres-backed storage for the hosted run contract, registry/runtime modes, events, sessions, artifacts, placement decisions, connected nodes, and node assignments.
- Redis/BullMQ-backed hosted run queue plus deterministic memory/fake substitutes for local tests.
- Object artifact content store with S3/R2-compatible production shape and deterministic memory substitute for tests.
- Hosted-safe fake runtime worker execution for `fake.deterministic`.
- Local node app under `apps/node`.
- Connected node registration, heartbeat, stale/offline detection, and inspectable node records.
- Hosted-to-local run assignment with polling/claim semantics that can run deterministically in tests.
- Local node policy enforcement before local execution and before event/artifact sync.
- Event sync and artifact sync rules for connected local nodes.
- Placement decisions across `local`, `hosted`, and `connected_local_node`.
- Public run API compatibility across local daemon and hosted-like server for `POST /runs`, `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`, `GET /runs/:id/artifacts`, `GET /artifacts/:id`, `GET /artifacts/:id/content`, `POST /runs/:id/cancel`, and supported `POST /runs/:id/input` behavior.
- Local smoke docs for fake hosted execution and fake connected-node execution.

Out of scope:

- SDK, CLI, TUI, dashboard, generated OpenAPI, packaging, and release hardening beyond R10 smoke docs.
- Enterprise billing, organizations, tenant management, OAuth, SSO, role-based access control, quota plans, or production multi-tenant authorization. R10 may add narrow auth/principal interfaces and shared-token node auth boundaries only.
- Hosted arbitrary subprocess, hosted PTY, hosted Codex, hosted Claude Code, hosted OpenCode process/ACP, or any cloud execution of local credentials/workspaces without a sandbox design.
- Production sandbox design for process/PTY workers.
- Hosted real debate participant execution, model judging, debate workers beyond preserving existing local debate code.
- Real browser/search/GitHub/repo/shell/fetch tooling in hosted mode.
- Remote artifact URL fetching or presigned direct-download APIs.
- Full production HA runbooks, autoscaling, dashboarding, or alerting beyond code-level logs/metrics/traces hooks and deterministic tests.

## Existing Context

R10 starts from Phase 8 closeout, where local R9 debate is shipped and hosted/hybrid remains explicitly deferred.

`PRODUCT.md` defines the exact R10 release surface:

```md
### R10: Hosted And Hybrid Execution

Release scope:

- hosted server app.
- hosted worker app.
- Postgres storage.
- Redis/BullMQ queue.
- object artifact store.
- hosted-safe fake runtime worker.
- local node app.
- node registration and heartbeat.
- hosted-to-local run assignment.
- local node policy enforcement.
- event and artifact sync rules.
- placement across local, hosted, and connected local nodes.
```

`PROJECT.md` Phase 8 says R9 intentionally did not ship hosted or hybrid execution:

```md
R9 remains fake-only: no hosted or hybrid execution, real participant runtimes,
real tools, model judging, swarms, SDK/CLI/TUI/dashboard work, or external
research automation shipped in this phase.
```

The public run object already contains the placement field that R10 must make real:

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

The current REST run route already accepts `placement` and defaults it to `local`, but it does not validate or enforce hosted/hybrid placement yet:

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

Runtime manifests already model placement facts across local, hosted, and connected local node:

```ts
export const runtimePlacementFactsSchema = z.object({
  local: runtimePlacementFactSchema,
  hosted: runtimePlacementFactSchema,
  connectedLocalNode: runtimePlacementFactSchema
});

export const runtimeModeSchema = z.object({
  slug: runtimeModeSlugSchema,
  adapterType: adapterTypeSchema,
  kind: runtimeModeKindSchema,
  capabilities: z.array(runtimeCapabilitySchema).min(1),
  placement: runtimePlacementFactsSchema,
  availability: runtimeAvailabilitySchema
});
```

The fake runtime is deterministic and safe for hosted worker tests, but its manifest still says hosted is unsupported. R10 must update that manifest only for the fake runtime and must not generalize that to process/PTY adapters:

```ts
readonly manifest: RuntimeAdapterManifest = {
  adapterId: "fake",
  runtimeModeSlug: "fake.deterministic",
  name: "Fake deterministic runtime",
  adapterType: "process",
  kind: "deterministic_fake",
  capabilities: ["run.start", "run.cancel", "event.normalized", "event.streaming", "artifact.transcript", "tool.fake_echo", "auth.none"],
  placement: {
    local: { support: "supported", reason: "In-process deterministic test adapter." },
    hosted: { support: "unsupported", reason: "Hosted worker execution is not shipped in R3." },
    connectedLocalNode: { support: "future", reason: "Hybrid node execution is planned for R10." }
  }
};
```

The fake runtime produces deterministic events and a transcript artifact that R10 can use for all hosted/hybrid smoke tests without model spend:

```ts
yield {
  id: "event_fake_output",
  type: "runtime.output",
  runId,
  sequence: 2,
  payload: { text: "fake runtime output" },
  createdAt
};

async artifacts(): Promise<Artifact[]> {
  return [
    {
      id: "artifact_fake_transcript",
      type: "transcript",
      path: "runs/run_fake/transcript.jsonl",
      metadata: {
        content: "{\"type\":\"runtime.output\",\"text\":\"fake runtime output\"}\n"
      },
      createdAt: "2026-05-11T00:00:00.000Z"
    }
  ];
}
```

Placement and node contracts exist, but placement behavior is still unimplemented and node storage is not wired:

```ts
export const placementDecisionSchema = z.object({
  decision: placementDecisionKindSchema,
  reason: z.string().min(1),
  mode: z.enum(["local", "hosted", "hybrid"]),
  targetNode: z.string().optional(),
  requiredCapabilities: z.array(z.string()),
  deniedCapabilities: z.array(z.string()),
  approvalRequired: z.boolean(),
  policyTrace: z.array(z.string())
});

export const nodeSchema = z.object({
  id: nodeIdSchema,
  mode: z.enum(["local", "hosted", "hybrid"]),
  status: nodeStatusSchema,
  capabilities: z.array(z.string()),
  createdAt: isoDateSchema,
  lastSeenAt: isoDateSchema.optional()
});
```

SQLite already persists placement decisions and run/event/artifact state. Postgres must preserve these logical shapes, not invent a second hosted-only run model:

```ts
export const placementDecisions = sqliteTable("placement_decisions", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  decision: text("decision").notNull(),
  reason: text("reason").notNull(),
  mode: text("mode").notNull(),
  targetNode: text("target_node"),
  requiredCapabilitiesJson: text("required_capabilities_json").notNull(),
  deniedCapabilitiesJson: text("denied_capabilities_json").notNull(),
  approvalRequired: integer("approval_required").notNull(),
  policyTraceJson: text("policy_trace_json").notNull(),
  createdAt: text("created_at").notNull()
});
```

The architecture document already reserves the R10 app/package shape:

```md
- `apps/node`: remote execution node for teams running workers on different servers.
- `apps/server`: hosted/team Switchyard API.
- `apps/worker`: hosted background worker process for queued runs, debate turns, tools, artifact extraction, memory extraction, and report generation.
- `packages/protocol-node`: hosted-to-node remote-control protocol for teams running Switchyard nodes on different servers.
- `packages/storage`: persistence implementations for in-memory tests, SQLite local mode, Postgres hosted mode, filesystem artifacts, and S3/R2-compatible object storage.
- `packages/queue`: local in-process queue and hosted Redis/BullMQ queue implementations.
```

## Architecture

R10 introduces three deployment app surfaces while keeping `packages/core` protocol-neutral:

- `apps/daemon` remains the local standalone gateway and keeps the current local behavior.
- `apps/server` is the hosted-like public gateway. It owns Fastify route wiring, Postgres stores, object artifact content, runtime registry/doctor data, placement decisions, node coordination, and Redis/BullMQ queue enqueueing.
- `apps/worker` consumes hosted run jobs and executes only hosted-safe runtime modes. In R10 that means `fake.deterministic` only.
- `apps/node` connects outward to the hosted server, registers capabilities, heartbeats, claims connected-local-node assignments, enforces local policy, runs local adapters, and syncs approved events/artifacts back to the hosted server.

The public run contract remains the center. The run id visible to clients is the only logical run id in every placement. Hosted workers and connected local nodes must execute under that same `run.id`; node-local generated run ids must not leak into hosted APIs.

Storage is split by deployment but not by product model. Local mode continues to use SQLite and filesystem artifacts. Hosted mode uses Postgres for durable metadata/events/sessions/registry/placement/nodes/assignments and object storage for artifact content. Redis/BullMQ coordinates hosted jobs, with memory/fake queue implementations used by deterministic tests.

Placement is explicit and inspectable. Every run created through `apps/server` must produce one placement decision record before execution is enqueued or assigned. If placement cannot be satisfied safely, the run must not disappear into a queue; it must be rejected with a named error before side effects, or it must be marked `failed` with an auditable `run.failed` event if the failure happens after run creation.

## User-Visible Behavior

Scenario 1: hosted-safe fake run on the hosted-like server

- Client sends the same `POST /runs?wait=1` body it would send to the local daemon, using `runtime: "fake"`, `provider: "test"`, `model: "test-model"`, `adapterType: "process"`, and optionally `placement: "hosted"`.
- Hosted server validates the runtime mode, records a placement decision of `hosted`, creates a `queued` run, and enqueues a hosted run job.
- Hosted worker claims the job, starts the fake runtime, writes events to Postgres, writes transcript content to the object artifact store, and terminalizes the run.
- Client receives the same shape as local mode: `201 { run, response }` for `wait=1`, `202 { run }` for async, `GET /runs/:id` with `{ run, events }`, SSE replay/live from `/runs/:id/events`, and artifact metadata/content through the existing artifact routes.

Scenario 2: local-only runtime explicitly requested as hosted

- Client requests `placement: "hosted"` for `codex.exec_json`, `claude_code.sdk`, `opencode.acp`, or any arbitrary subprocess/generic process/PTY/local-auth runtime mode.
- Server rejects before queueing with `409 placement_denied`.
- Response body uses the existing error envelope shape and includes a reason such as `hosted_runtime_not_allowed`.
- No hosted worker job is created.

Scenario 3: connected local node run

- A local node app starts with a server URL, node id, shared node token, capability list, and local policy.
- The node registers, heartbeats, and becomes eligible for `connected_local_node` placement.
- Client creates a run with `placement: "connected_local_node"` or omits placement when no hosted-safe runtime is available but a matching node is online.
- Hosted server creates a placement decision with `targetNode`, creates a node assignment, and leaves the run in `queued` until the node claims it.
- The local node claims the assignment, re-checks local policy, executes the run locally under the hosted run id, and syncs events/artifacts back to the hosted server.
- Client sees the connected-node run through the same hosted `/runs`, `/runs/:id/events`, and artifact APIs.

Scenario 4: local node denies work by policy

- Hosted server assigns a run to an online node whose advertised capabilities match.
- Before execution, the node detects a local policy violation such as a disallowed cwd prefix, disallowed runtime mode, denied adapter type, disabled artifact sync, or event sync policy violation.
- Node rejects the assignment with `node_policy_denied`.
- Hosted server marks the run `failed`, appends a `run.failed` event with `reasonCode: "node_policy_denied"`, and records the node policy trace with secrets redacted.

Scenario 5: node goes offline mid-run

- Node heartbeats expire while an assignment is active.
- Hosted server marks the node `offline` after the configured lease window.
- If the runtime mode is retryable on another node, the assignment may return to pending once. In R10 only fake deterministic connected-node assignments are retryable.
- If no eligible node exists or retry is exhausted, hosted server marks the run `failed` with `reasonCode: "node_assignment_lost"`.
- SSE clients see the failure event; `GET /runs/:id` shows a terminal failed run.

## Public API Contract

R10 must preserve these existing run endpoints in local and hosted-like modes:

- `POST /runs`
- `POST /runs?wait=1`
- `GET /runs`
- `GET /runs/:id`
- `GET /runs/:id/events`
- `GET /runs/:id/artifacts`
- `GET /artifacts/:id`
- `GET /artifacts/:id/content`
- `POST /runs/:id/cancel`
- `POST /runs/:id/input` for runtime modes that already support input

The request body for a hosted fake run is intentionally the same as the local fake run body:

```json
{
  "runtime": "fake",
  "provider": "test",
  "model": "test-model",
  "adapterType": "process",
  "runtimeMode": "fake.deterministic",
  "placement": "hosted",
  "cwd": "/repo",
  "task": "Hosted fake smoke",
  "timeoutSeconds": 30
}
```

The response body remains the current run response shape:

```json
{
  "run": {
    "id": "run_...",
    "runtime": "fake",
    "provider": "test",
    "model": "test-model",
    "adapterType": "process",
    "runtimeMode": "fake.deterministic",
    "cwd": "/repo",
    "task": "Hosted fake smoke",
    "status": "completed",
    "placement": "hosted",
    "approvalPolicy": "default",
    "timeoutSeconds": 30,
    "metadata": {},
    "createdAt": "2026-05-30T00:00:00.000Z",
    "startedAt": "2026-05-30T00:00:00.001Z",
    "endedAt": "2026-05-30T00:00:00.010Z"
  },
  "response": {
    "text": "fake runtime output",
    "outputs": [
      { "sequence": 3, "text": "fake runtime output" }
    ]
  }
}
```

New hosted/node endpoints are additive and may live in `packages/protocol-rest` or a new `packages/protocol-node` route group:

- `POST /nodes/register`
- `POST /nodes/:id/heartbeat`
- `GET /nodes`
- `GET /nodes/:id`
- `POST /nodes/:id/assignments/claim`
- `POST /nodes/:id/assignments/:assignmentId/reject`
- `POST /nodes/:id/assignments/:assignmentId/events`
- `POST /nodes/:id/assignments/:assignmentId/artifacts/manifest`
- `PUT /nodes/:id/assignments/:assignmentId/artifacts/:artifactId/content`
- `POST /nodes/:id/assignments/:assignmentId/complete`

Node control endpoints are not enterprise auth. They are an R10 interface boundary only: when `SWITCHYARD_NODE_SHARED_TOKEN` is configured, node requests must include `x-switchyard-node-token`; invalid or missing tokens return `401 node_auth_failed`. Tests may use a deterministic test token.

Node registration request:

```json
{
  "nodeId": "node_local_dev",
  "mode": "hybrid",
  "capabilities": [
    "runtime.fake.deterministic",
    "runtime.codex.exec_json",
    "artifact.sync",
    "event.sync"
  ],
  "policy": {
    "allowRuntimeModes": ["fake.deterministic", "codex.exec_json"],
    "denyAdapterTypes": ["pty"],
    "allowCwdPrefixes": ["/Users/example/project"],
    "eventSync": "all",
    "artifactSync": "metadata_and_content",
    "maxArtifactBytes": 1048576
  },
  "version": "0.0.0"
}
```

Assignment claim response:

```json
{
  "assignments": [
    {
      "id": "assignment_...",
      "run": {
        "id": "run_...",
        "runtime": "fake",
        "provider": "test",
        "model": "test-model",
        "adapterType": "process",
        "runtimeMode": "fake.deterministic",
        "placement": "connected_local_node",
        "cwd": "/Users/example/project",
        "task": "Connected node smoke",
        "timeoutSeconds": 30,
        "approvalPolicy": "default",
        "metadata": {},
        "status": "queued",
        "createdAt": "2026-05-30T00:00:00.000Z"
      }
    }
  ]
}
```

Event sync request:

```json
{
  "cursor": 1,
  "events": [
    {
      "id": "event_node_output",
      "type": "runtime.output",
      "runId": "run_...",
      "sequence": 2,
      "payload": { "text": "fake runtime output" },
      "createdAt": "2026-05-30T00:00:00.002Z"
    }
  ]
}
```

Artifact sync manifest:

```json
{
  "artifacts": [
    {
      "id": "artifact_fake_transcript",
      "type": "transcript",
      "path": "runs/run_.../transcript.jsonl",
      "contentType": "application/x-ndjson",
      "sizeBytes": 53,
      "sha256": "hex-encoded-digest",
      "syncContent": true
    }
  ]
}
```

## Placement Rules

Local daemon:

- Default placement remains `local`.
- Existing local fake, Codex, Claude Code, OpenCode, Generic HTTP, AgentField, and debate behavior must not regress.
- Local daemon may record placement decisions, but it must not require Postgres/Redis/object storage.

Hosted server:

- If `placement` is omitted, server chooses deterministically:
  1. `hosted` if the runtime mode has hosted placement support and the hosted worker allowlist permits it.
  2. `connected_local_node` if an online node advertises the runtime mode and local-node policy summary permits assignment.
  3. reject with `409 placement_denied` if neither path is safe.
- If `placement` is provided, it is strict. Explicit `hosted` must not silently fall back to a connected local node. Explicit `connected_local_node` must not silently fall back to hosted.
- `fake.deterministic` is the only hosted-supported runtime mode in R10.
- Arbitrary subprocess, generic process, PTY, local-auth, workspace-write, and danger-full-access runtime modes are hosted-denied unless they are routed to a connected local node and accepted by local node policy. The only R10 hosted exception is the in-process deterministic fake adapter behind `fake.deterministic`.
- Placement decisions must be stored with `runId`, `decision`, `reason`, `mode`, optional `targetNode`, required capabilities, denied capabilities, `approvalRequired`, `policyTrace`, and `createdAt`.

Connected local node selection:

- Eligible nodes have `status: "online"`, non-expired heartbeat, advertised runtime capability, and compatible policy summary.
- R10 deterministic tie-break is lexicographic `node.id` among eligible nodes.
- Stale nodes must not receive new assignments.
- Assignment rows must be durable in Postgres before a node can claim them.

Runtime manifest updates:

- Update `fake.deterministic` placement facts to:
  - local: supported.
  - hosted: supported, with reason naming hosted-safe deterministic fake worker.
  - connectedLocalNode: supported, with reason naming local node smoke/contract execution.
- Do not mark Codex, Claude Code, OpenCode, arbitrary subprocess, generic process, PTY, or local-auth runtime modes as hosted-supported.
- It is acceptable to mark local-only runtime modes as `connectedLocalNode: conditional` or `supported` only when the local node app can actually run and policy-gate them.

## Data Flows And Shadow Paths

### Data Flow 1: Hosted Run Create To Hosted Worker Completion

Happy path:

- Valid fake hosted run request arrives.
- Runtime mode inference resolves `fake.deterministic` if omitted.
- Placement decision is `hosted`.
- Run is created as `queued`.
- BullMQ job is enqueued.
- Hosted worker claims the job, updates run to `running`, appends events, writes artifact content to object storage, terminalizes `completed`, and publishes events to SSE subscribers.

Nil path:

- Missing request body returns `400 invalid_input` with details path `body`.
- Missing `runtime`, `provider`, `model`, `adapterType`, `cwd`, or `task` returns `400 invalid_input` with the specific field path.
- No run row, placement record, queue job, or artifact object is created.

Empty path:

- Empty strings for required fields return `400 invalid_input`.
- Empty `placement` is treated as omitted only if the key is absent; an empty-string placement returns `400 invalid_input`.
- Empty runtime-mode inference result returns `400 invalid_input` with reason `runtime_mode_unresolved`.

Error path:

- Postgres create failure returns `500 internal_error` and emits a sanitized server log `run.create.storage_failed`.
- Queue enqueue failure after run creation marks the run `failed`, appends `run.failed` with `reasonCode: "queue_enqueue_failed"`, and returns `500 internal_error` for synchronous create or leaves the failed run inspectable for async create.
- Worker retry exhaustion marks the run `failed` with `reasonCode: "worker_retry_exhausted"`.
- Object store write failure marks the run `failed` with `reasonCode: "object_store_write_failed"` unless the artifact was explicitly policy-marked metadata-only.

### Data Flow 2: Hosted Run Create To Connected Local Node Assignment

Happy path:

- Valid run request resolves to `connected_local_node`.
- Server records a placement decision with `targetNode`.
- Server creates a pending assignment row.
- Node claims assignment, executes under the hosted run id, syncs events/artifacts, and completes assignment.
- Hosted run reaches `completed` and clients see events/artifacts through hosted APIs.

Nil path:

- No eligible node returns `409 placement_denied` before run creation when placement is explicit.
- If placement was chosen after run creation and the node disappears before assignment creation, run becomes `failed` with `reasonCode: "node_not_available"`.

Empty path:

- Node with empty capability list can register but cannot receive assignments.
- Empty `allowRuntimeModes` means deny all local execution.
- Empty `allowCwdPrefixes` means deny all cwd-bound execution.

Error path:

- Node claim conflict returns `409 assignment_claim_conflict` to the losing node and leaves the assignment owned by the first claimant.
- Node policy rejection marks run failed with `reasonCode: "node_policy_denied"`.
- Heartbeat expiry during active execution marks node offline and the run failed with `reasonCode: "node_assignment_lost"` after the configured retry policy is exhausted.

### Data Flow 3: Node Registration And Heartbeat

Happy path:

- Node registers with id, mode, capabilities, policy summary, and version.
- Server upserts node, sets status `online`, stores `lastSeenAt`, returns heartbeat interval and lease expiry.
- Heartbeats refresh `lastSeenAt` and may update capabilities/policy summary.

Nil path:

- Missing registration body returns `400 invalid_input`.
- Missing node auth token when configured returns `401 node_auth_failed`.
- Missing node id lets server generate `node_<uuid>` and returns it to the node.

Empty path:

- Empty capabilities are accepted but node is non-assignable.
- Empty policy object uses deny-by-default values.

Error path:

- Malformed policy returns `400 invalid_input`.
- Storage failure returns `500 internal_error` and logs `node.register.storage_failed`.
- Heartbeat for unknown node returns `404 node_not_found`; the node must re-register.

### Data Flow 4: Event Sync

Happy path:

- Node sends event batches for the assigned run with monotonically increasing sequence numbers.
- Server validates node ownership, assignment state, event schema, run id, and next expected sequence.
- Duplicate retry with byte-equivalent event payload is idempotent.
- Server appends events and publishes to live SSE subscribers.

Nil path:

- Missing `events` returns `400 invalid_input`.
- Missing assignment returns `404 assignment_not_found`.

Empty path:

- Empty `events: []` returns `200 { accepted: true, appended: 0 }` and does not advance cursor.

Error path:

- Sequence gap returns `409 event_sync_gap`.
- Duplicate sequence with different payload returns `409 event_sync_conflict`.
- Event payload denied by node policy must either be redacted by the node before send or rejected with `node_policy_denied`; hosted server must not invent unredacted payloads.

### Data Flow 5: Artifact Sync

Happy path:

- Node sends manifest with artifact metadata, size, content type, digest, and `syncContent`.
- Server stores artifact metadata and, when `syncContent` is true and policy allows it, accepts content upload to the object artifact store.
- Server validates digest/size, records `contentStored: true`, and exposes content through `GET /artifacts/:id/content`.

Nil path:

- Missing manifest returns `400 invalid_input`.
- Missing content for `syncContent: true` leaves artifact metadata with `contentStored: false` and emits/records `artifact_sync_missing_content`.

Empty path:

- Empty artifact list returns `200 { accepted: true, artifacts: [] }`.
- Zero-byte artifact content is allowed only when size/digest match; otherwise `400 invalid_input`.

Error path:

- Artifact path escaping root or object key prefix returns `400 invalid_input`.
- Object store write failure records `artifact_sync_failed` and fails the run with `reasonCode: "artifact_sync_failed"` unless artifact sync was optional metadata-only.
- Digest mismatch returns `409 artifact_digest_mismatch` and fails the assignment.

### Data Flow 6: Cancellation

Happy path:

- Client calls `POST /runs/:id/cancel`.
- If queued hosted job has not started, server marks run `cancelled`, removes/discards job when supported, and appends `run.cancelled`.
- If hosted worker is running, worker observes cancellation before next event/artifact persistence and calls adapter cancel.
- If connected node is running, server records cancellation request; node receives it on heartbeat/claim poll, calls local adapter cancel, and syncs `run.cancelled`.

Nil path:

- Unknown run id returns `404 run_not_found`.

Empty path:

- Empty cancel body is valid and equivalent to no cancel reason.

Error path:

- Queue discard failure logs `run.cancel.queue_discard_failed` and still records cancellation intent.
- Node does not acknowledge cancellation before heartbeat expiry: server marks run failed with `reasonCode: "node_cancel_lost"` unless it had already reached a terminal state.
- Adapter cancel failure maps to `409 adapter_protocol_failed` for active local APIs or `run.failed` with `reasonCode: "adapter_cancel_failed"` in background worker/node paths.

## Storage Requirements

Postgres storage:

- Add hosted Postgres schema and stores under `packages/storage/src/postgres`.
- Implement at least the ports needed by hosted run execution: `RunStore`, `EventStore`, `SessionStore`, `ArtifactStore`, `RegistryStore`, `PlacementStore`, `NodeStore`, and a durable assignment store.
- Preserve logical field names and response shapes from the contracts package.
- Use JSONB for metadata/payload/policy arrays where Postgres supports it, but return the same TypeScript objects as SQLite stores.
- Store ISO strings externally; internal timestamptz usage is acceptable only if round-tripped responses remain ISO strings and deterministic tests can assert exact values with injected clocks.
- Add indexes for run listing, event replay by `(run_id, sequence)`, artifact lookup by run/debate, placement lookup by run, node heartbeat/status, and assignment claim by status/node.
- Contract tests must run against memory stores, SQLite stores, and Postgres stores. If no Postgres service is available, Postgres tests must skip with an explicit message rather than fail nondeterministically.

Object artifact store:

- Add an artifact content abstraction that both filesystem and object stores satisfy.
- Production object store shape must be S3/R2-compatible: endpoint, region, bucket, access key, secret key, force path style option.
- Deterministic tests must use an in-memory object store that verifies logical path normalization, digest, byte size, and content type.
- Object keys must be derived from safe logical paths, prefixed by run/debate id, and must reject absolute paths, `..`, backslashes, drive letters, and empty paths.
- Artifact metadata must record enough to inspect content status: `contentStored`, `storageBackend`, `objectKey` or safe local path, `sizeBytes`, `sha256`, and optional `syncDeniedReason`.

Queue:

- Expand the queue port beyond fire-and-forget enqueue so hosted workers can claim, retry, ack, fail, and inspect deterministic jobs.
- Provide Redis/BullMQ implementation for hosted app/worker.
- Provide memory queue implementation for tests and local hosted-like smoke when Redis is unavailable.
- Queue payloads must not include secret env vars, full auth headers, or object-store credentials.
- Retry policy must be bounded and visible: default max attempts 3, with failure reason persisted on the run after exhaustion.

Node and assignment storage:

- Add connected node records with id, mode, status, capabilities, policy summary, version, createdAt, lastSeenAt, heartbeatExpiresAt, and updatedAt.
- Add node assignment records with id, runId, nodeId, status, claimedAt, startedAt, completedAt, failedAt, retryCount, lastEventSequence, lastArtifactSyncAt, error, and createdAt.
- Assignment status values: `pending`, `claimed`, `running`, `completed`, `failed`, `cancelled`, `expired`.

## Security And Policy

- Hosted worker runtime allowlist defaults to `fake.deterministic` only.
- Hosted worker must not instantiate `CodexExecJsonAdapter`, `ClaudeCodeAdapter`, `OpenCodeAcpAdapter`, any PTY adapter, or any generic process adapter in R10.
- Hosted app must reject hosted placement for runtime modes whose placement facts are `unsupported`, `future`, or `unknown`.
- Connected local node must enforce local policy after claim and before execution. Hosted placement decisions are advisory; the local node is the final trust boundary.
- Node policy deny-by-default:
  - no allowed runtime mode means deny execution.
  - no allowed cwd prefix means deny cwd-bound execution.
  - no artifact sync policy means metadata only and no content upload.
  - no event sync policy means status-only sync.
- Policy traces must redact keys matching token, apiKey, authorization, password, and secret.
- Node shared token is an interface boundary only, not production enterprise auth. It must not be represented as full multi-tenant authorization.
- Hosted logs and errors must not include object store secrets, Redis URLs with credentials, database passwords, local file content, or provider credentials.
- Runtime mode registry must make hosted safety visible: clients can inspect placement facts and availability before creating runs.

## Error Contract

R10 must keep the existing error envelope:

```json
{
  "error": {
    "code": "snake_case_machine_code",
    "message": "human-readable explanation",
    "details": [
      { "path": "placement", "issue": "hosted runtime is not allowed" }
    ]
  }
}
```

Add or route these named error codes where needed:

- `placement_denied` - 409, placement cannot be satisfied safely.
- `node_auth_failed` - 401, node token missing or invalid.
- `node_not_found` - 404, heartbeat/claim/sync targets an unknown node.
- `assignment_not_found` - 404, sync targets an unknown assignment.
- `assignment_claim_conflict` - 409, two nodes attempted to claim the same assignment.
- `node_policy_denied` - 403 or run failure reason, local node policy rejected work or sync.
- `queue_unavailable` - 503 if server cannot enqueue before run creation; otherwise run failure reason `queue_enqueue_failed`.
- `event_sync_gap` - 409, node event sequence skipped.
- `event_sync_conflict` - 409, duplicate sequence had different content.
- `artifact_digest_mismatch` - 409, uploaded artifact content does not match manifest.
- `artifact_sync_failed` - 500 or run failure reason, artifact metadata/content sync failed after execution started.
- `hosted_runtime_not_allowed` - placement policy reason used under `placement_denied`.

Errors before run creation must not create partial run rows. Errors after run creation must leave an inspectable run with terminal state and a named `run.failed` or `run.cancelled` event.

## Observability

Structured logs:

- `hosted.server.started`
- `run.create.requested`
- `placement.decided`
- `placement.denied`
- `queue.enqueue.succeeded`
- `queue.enqueue.failed`
- `worker.job.claimed`
- `worker.job.retrying`
- `worker.job.exhausted`
- `node.registered`
- `node.heartbeat.accepted`
- `node.heartbeat.expired`
- `node.assignment.created`
- `node.assignment.claimed`
- `node.policy.denied`
- `event.sync.accepted`
- `event.sync.gap`
- `artifact.sync.accepted`
- `artifact.sync.failed`
- `object.write.failed`

Metrics/traces hooks:

- Run count by placement/status/runtimeMode.
- Placement denied count by reason.
- Queue latency from run created to job claimed.
- Worker execution duration by runtimeMode.
- Node heartbeat lag and offline count.
- Assignment age and active assignment count.
- Event sync lag by run/assignment.
- Artifact sync bytes and failures.
- Object store write latency and failure count.

Every log/metric/trace must use run id, placement, runtimeMode, assignment id, node id, and job id when available. Secret-bearing config values must be redacted.

## Local Verification

Required deterministic tests:

- Contract tests for Postgres stores using the same logical fixtures as SQLite stores. If real Postgres is unavailable, tests must use a documented memory substitute and skip real Postgres with a clear message.
- Queue contract tests against memory queue and Redis/BullMQ when `SWITCHYARD_TEST_REDIS_URL` is available.
- Object artifact store contract tests against in-memory object store and optional S3/R2-compatible endpoint when configured.
- Hosted server app test: `POST /runs?wait=1` fake hosted run completes, events replay, artifacts list, and artifact content fetch returns transcript content.
- Hosted worker test: success, runtime failure, retry exhaustion, queue unavailable, object write failure, and cancellation.
- Placement tests:
  - omitted placement chooses hosted for `fake.deterministic`;
  - explicit hosted rejects Codex/Claude/OpenCode/arbitrary subprocess/generic process/PTY/local-auth modes;
  - explicit connected node chooses online eligible node;
  - no eligible node returns `placement_denied`.
- Node tests:
  - registration/heartbeat makes node online;
  - heartbeat expiry marks node offline;
  - policy allow executes fake run and syncs events/artifacts;
  - policy deny marks run failed with `node_policy_denied`;
  - sync gap/conflict errors are deterministic.
- Public run contract tests compare local daemon fake run and hosted-like fake run response/event/artifact shapes.

Required smoke docs:

- Hosted-like fake run with memory queue/object store and test Postgres substitute or configured Postgres.
- Connected local node fake run with memory/fake infrastructure.
- Negative smoke: hosted Codex or hosted Claude request returns placement denial.

Suggested commands for downstream docs/tests:

```bash
pnpm --filter @switchyard/server test
pnpm --filter @switchyard/worker test
pnpm --filter @switchyard/node test
pnpm --filter @switchyard/storage test
pnpm --filter @switchyard/queue test
pnpm test
```

Real service tests should be opt-in through environment variables:

```text
SWITCHYARD_TEST_POSTGRES_URL=postgres://...
SWITCHYARD_TEST_REDIS_URL=redis://...
SWITCHYARD_TEST_OBJECT_STORE_ENDPOINT=http://127.0.0.1:9000
```

## Acceptance Criteria

- [ ] `apps/server` exists and can serve the public run/artifact/runtime registry contract for hosted-like mode.
- [ ] `apps/worker` exists and completes a queued hosted `fake.deterministic` run without executing arbitrary subprocesses or PTYs.
- [ ] `apps/node` exists and can register, heartbeat, claim one fake assignment, enforce local policy, and sync approved events/artifacts.
- [ ] Postgres storage implements the hosted run/event/session/artifact/registry/placement/node/assignment stores required by R10 and passes storage contract tests or skips only when real Postgres is explicitly unavailable.
- [ ] Redis/BullMQ queue implementation exists, with memory/fake queue substitutes for deterministic tests.
- [ ] Object artifact content store exists, with S3/R2-compatible production shape and memory substitute tests.
- [ ] `fake.deterministic` is hosted-safe and connected-node-capable; local-only runtimes are not silently exposed as hosted-safe.
- [ ] Public run create/get/list/events/artifacts/cancel contract works in local daemon and hosted-like fake mode with the same response envelopes.
- [ ] Placement decisions are stored and inspectable for hosted and connected-local-node runs.
- [ ] Hosted placement rejects Codex, Claude Code, OpenCode, arbitrary subprocess, generic process, PTY, local-auth, workspace-write, and danger-full-access modes unless they are explicitly routed to and accepted by a connected local node. The deterministic fake adapter remains the only hosted process-typed exception.
- [ ] Connected local node assignment is durable, policy-gated, heartbeat-aware, and deterministic in tests.
- [ ] Event sync enforces monotonic sequence/idempotent retry rules and publishes synced events to hosted SSE streams.
- [ ] Artifact sync enforces path safety, size/digest validation, policy, and object-store persistence rules.
- [ ] Queue success, failure, retry exhaustion, cancellation, node offline, policy denial, event sync gap, and artifact sync failure all produce named user-visible errors or terminal run events.
- [ ] Local smoke docs cover hosted-like fake execution, connected-node fake execution, and hosted local-runtime denial.

## Phase

### Phase 9: R10 Hosted And Hybrid Execution

Goal: Ship a safe hosted-like and hybrid execution slice that preserves the public run contract while supporting hosted fake worker execution and connected local-node execution.

Acceptance:

- Hosted server, hosted worker, local node, Postgres storage, Redis/BullMQ queue, object artifact store, placement, node registration/heartbeat, assignment, local policy enforcement, event sync, and artifact sync are implemented to the R10 boundary above.
- The same fake run can be exercised through local and hosted-like run APIs with equivalent response/event/artifact shapes.
- Hosted runtime safety is enforced: only `fake.deterministic` can run in hosted worker; local-only runtime modes are rejected from hosted placement.
- Deterministic local tests and smoke docs cover success, nil, empty, and error shadows for hosted worker and connected-node flows.

Non-goals this phase:

- SDK/CLI/TUI/dashboard packaging or hardening.
- Enterprise billing, org management, OAuth/SSO/RBAC, or full multi-tenant auth.
- Hosted subprocess/PTY/Codex/Claude/OpenCode execution.
- Real hosted debate, browser/search/repo/shell/fetch/GitHub tooling, or model judging.
- Production sandbox design, autoscaling, HA runbooks, direct presigned artifact URLs, or remote artifact URL fetching.

Complexity: L
