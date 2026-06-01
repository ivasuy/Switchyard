# Phase 23 / R24: Hosted Real Debate

**Date:** 2026-06-02
**Run:** `post-r11-remaining-20260530`
**Branch:** `agent/phase-23-r24-hosted-real-debate`
**Base commit:** `f67c42f` (`project: close phase 22`)
**Spec target:** `docs/superpowers/specs/2026-06-02-phase-23-r24-hosted-real-debate.md`

## Problem

R9 proved a bounded local fake debate workflow, and R21-R23 made hosted provider execution, hosted tools, and hosted runtime input/approval bridges usable for known worker-owned runtimes. The remaining provider-facing release gap is that debate is still fake-only and local-daemon-only, so it cannot yet compose real hosted participant runtimes or a bounded model judge through the same auditable run lifecycle.

R24 closes that gap without expanding the public API surface. It keeps `/debates`, `/debates/:id`, and `/debates/:id/events` as the only debate routes, adds hosted/server-safe debate execution and persistence, allows real participants only by explicit opt-in, and introduces internal deterministic/no-spend judge-runner plumbing that can optionally run a live model judge only when spend is explicitly confirmed.

## Priority Rationale

Hosted real debate is the highest-leverage remaining public release gap because it composes what already shipped instead of opening a new adapter family. R21 supplies known hosted provider activation, R22 supplies hosted/connected-node tool policy foundations, and R23 supplies worker-owned input/approval bridges for Claude and OpenCode. Shipping debate now validates those provider surfaces in a product workflow while keeping larger still-unshipped gaps, such as dashboard/TUI, hosted Codex interactive resume, AgentField/Generic HTTP bridges, browser automation, hosted repo, generic process/PTY adapters, and managed SaaS, outside this phase.

## Goals

- Reuse the existing `/debates` route family for local and hosted debate creation, inspection, and event replay/live streaming. Do not add new public participant, judge, or model route families.
- Extend debate execution from fake-only local runs to local and hosted participant runs for the already shipped hosted runtime modes: `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
- Keep fake deterministic participants and fake deterministic judging as the default for tests, smoke, preflight, and default canary.
- Require explicit opt-in for any real participant runtime and for any live model judge path. Missing opt-in must fail before provider dispatch.
- Add an internal bounded judge runner that uses existing run/runtime contracts and produces the existing `debate.judge.summary` event plus final report artifact. The judge runner must not be a public arbitrary model route.
- Preserve hard debate stop limits, participant turn limits, runtime timeout limits, cost/spend controls, quota enforcement, audit logging, ownership, event/message persistence, artifact/report traceability, and tenant isolation for hosted/server placement.
- Keep R23 hosted runtime bridge behavior intact for `claude_code.sdk` and `opencode.acp` participant runs that pause for runtime approval.
- Make unsupported runtime, judge, route, and spend states fail closed with named reason codes, never generic silent failure.

## Non-Goals

- No dashboard.
- No TUI.
- No new public `/debates/participants/real`, `/debates/judge`, `/model-judge`, `/judging`, `/participants`, `/judge`, or similar judging/participant route family.
- No public arbitrary `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` route.
- No public arbitrary process, shell, terminal, PTY, sandbox, or generic process/PTY product adapter.
- No terminal bridge, PTY automation, keyboard driving, screen scraping, alternate-screen replay, or hosted TUI automation.
- No hosted `codex.interactive`, Codex session-resume guarantee, or hosted Codex input/approval bridge beyond existing `codex.exec_json` fail-closed one-shot behavior.
- No AgentField hosted runtime bridge and no Generic HTTP hosted runtime bridge, except explicit fail-closed tests and product truth.
- No Cursor, OpenClaw, or Paperclip adapter.
- No browser automation.
- No hosted `repo` execution.
- No new hosted browser/search/GitHub/fetch/shell route expansion beyond the already shipped R22 tool surface.
- No unbounded autonomous swarms, recursive delegation, dynamic participant spawning, or background agent teams.
- No managed SaaS/public signup, payment provider integration, billing UI, invoices, checkout, webhooks, OAuth/OIDC/SAML/SSO/SCIM, session-cookie auth, browser login flow, or tenant self-service UI.
- No live provider spend in required tests, default smoke, default preflight, or default canary.

## Existing Context

R24 must extend the actual debate route family that exists today, not invent a parallel API. `packages/protocol-rest/src/debate-routes.ts` currently registers only the existing debate routes:

```ts
export function registerDebateRoutes(app: FastifyInstance, deps: DebateRouteDependencies): void {
  app.post("/debates", async (request, reply) => {
    try {
      const wait = shouldWaitForCompletion(request.query);
      const created = await deps.debateService.create(request.body, { wait });
      if (wait) {
        return reply.code(201).send(created);
      }
      queueMicrotask(() => {
        void deps.debateService.execute(created.debate.id).catch(() => {});
      });
      return reply.code(202).send({ debate: created.debate });
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.get("/debates/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    try {
      return await deps.debateService.inspect(id);
    } catch (error) {
      return sendFromServiceError(reply, error);
    }
  });

  app.get("/debates/:id/events", async (request, reply) => {
    await handleDebateEventsRequest(request, reply, deps);
  });
}
```

The current debate contract already stores participant run history, a judge result, stop reason, event ids, and final report metadata. R24 must preserve these shapes and extend them additively if needed:

```ts
export const debateParticipantSchema = z.object({
  id: participantIdSchema,
  runId: runIdSchema.optional(),
  runIds: z.array(runIdSchema).default([]),
  runtime: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  role: z.string().min(1),
  status: participantStatusSchema,
  turnsUsed: z.number().int().nonnegative()
});

export const debateSchema = z.object({
  id: debateIdSchema,
  topic: z.string().min(1),
  mode: debateModeSchema,
  status: debateStatusSchema,
  participants: z.array(debateParticipantSchema),
  limits: debateLimitsSchema,
  evidenceIds: z.array(evidenceIdSchema).default([]),
  messageIds: z.array(messageIdSchema).default([]),
  eventIds: z.array(eventIdSchema).default([]),
  finalReportArtifactId: artifactIdSchema.optional(),
  finalReportPath: z.string().optional(),
  stopReason: debateStopReasonSchema.optional(),
  judge: debateJudgeSchema.optional(),
```

The current service is intentionally fake-only. R24 must replace this specific guard with a closed, opt-in runtime matrix, not with arbitrary provider execution:

```ts
if (
  runtime !== FAKE_RUNTIME.runtime ||
  provider !== FAKE_RUNTIME.provider ||
  model !== FAKE_RUNTIME.model ||
  adapterType !== FAKE_RUNTIME.adapterType ||
  runtimeMode !== FAKE_RUNTIME.runtimeMode
) {
  throw new DebateServiceError("invalid_input", "Only fake deterministic participants are supported", [
    { path: `participants.${index}`, issue: "runtime/provider/model/adapterType/runtimeMode must match fake.deterministic defaults" }
  ]);
}
```

The current local participant run path creates normal runs and stores debate/participant metadata. R24 must continue to use normal run lifecycle records for every participant and judge run:

```ts
const run = await this.deps.runService.createRun({
  runtime: FAKE_RUNTIME.runtime,
  provider: FAKE_RUNTIME.provider,
  model: FAKE_RUNTIME.model,
  adapterType: FAKE_RUNTIME.adapterType,
  runtimeMode: FAKE_RUNTIME.runtimeMode,
  cwd: this.deps.defaultCwd,
  task: buildParticipantSeedTask(debate.topic, participant.role, participant.id),
  placement: "local",
  approvalPolicy: "default",
  timeoutSeconds: Math.min(60, debate.limits.maxDurationSeconds),
  metadata: {
    debateId: debate.id,
    participantId: participant.id,
    participantRole: participant.role,
    debateTopic: debate.topic,
    debateRunKind: "participant_seed",
```

Current development docs state the shipped R9 boundary. R24 must update this truth after implementation:

```md
- Debate V1 is fake-first and deterministic only.
- Exactly two participants are required per debate.
- Real participant runtimes (Codex/Claude/OpenCode/HTTP/AgentField) are rejected with `400 invalid_input`.
- `POST /debates?wait=1` executes a bounded local debate and returns `{ debate, events, finalReportArtifact }`.
```

The hosted server currently wires runs, hosted tools, artifacts, registry, and node routes, but not debate routes. R24 must register the existing debate routes in hosted/server mode with hosted auth, ownership, quota, audit, and durable stores:

```ts
registerRunRoutes(app, {
  runService,
  hostedRuns,
  runs,
  events,
  artifacts,
  eventBus,
  registry,
  registryService,
  ...(controlPlane ? { controlPlane } : {}),
  hostedRuntimeBridge: {
    createInputCommand: hostedRuntimeBridge.createInputCommand.bind(hostedRuntimeBridge)
  }
});

if (controlPlane && controlPlaneStoreInstance) {
  registerHostedToolRoutes(app, {
    hostedTools,
    runs,
    invocations,
    approvals,
    controlPlane,
    controlPlaneStore: controlPlaneStoreInstance,
```

The hosted runtime catalog is closed to fake plus three known provider modes. R24 must not expand this list to `codex.interactive`, AgentField, Generic HTTP, Cursor, OpenClaw, Paperclip, browser, repo, generic process, or PTY:

```ts
export type HostedRuntimeModeSlug = "fake.deterministic" | "codex.exec_json" | "claude_code.sdk" | "opencode.acp";
```

R23 bridge support is closed to Claude and OpenCode. Debate participant runs may rely on that shipped bridge behavior, but R24 must not create new bridge support for other modes:

```ts
export const hostedRuntimeBridgeSupportedModeSchema = z.enum(["claude_code.sdk", "opencode.acp"]);

export function isHostedRuntimeBridgeSupportedMode(
  runtimeMode: string,
  operation?: z.infer<typeof hostedRuntimeBridgeOperationSchema>
): boolean {
  if (!HOSTED_RUNTIME_BRIDGE_ALLOWED_MODES.has(runtimeMode)) {
    return false;
  }
```

The hosted OpenAPI contract already source-tests that no public hosted debate judging route exists. R24 must keep this protection while allowing the existing `/debates` route family:

```ts
expect(lower).not.toContain("/debates/participants/real");
expect(lower).not.toContain("/debates/judge");
expect(lower).not.toContain("/model-judge");
expect(lower).not.toContain("/judging");
```

Postgres currently has debate-aware events/artifacts but no durable `debates` table or `PostgresDebateStore`. R24 must add hosted debate state persistence before exposing hosted `/debates`:

```ts
CREATE TABLE IF NOT EXISTS run_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  run_id text,
  debate_id text,
  participant_id text,
  provider text,
  model text,
  sequence integer NOT NULL,
  payload jsonb NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_debate_seq_idx ON run_events(debate_id, sequence);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  run_id text,
  debate_id text,
  provider text,
  model text,
  type text NOT NULL,
```

## Product Decision Matrix

| Decision | R24 choice | Reason | Explicit rejection |
| --- | --- | --- | --- |
| Public API shape | Reuse `POST /debates`, `GET /debates/:id`, and `GET /debates/:id/events`. | Existing clients and docs already know this workflow. | No `/debates/participants/real`, `/debates/judge`, `/model-judge`, or new public judging route. |
| Real participant runtime opt-in | Default fake; real participants require request-level opt-in plus hosted provider gates when placement is hosted. | Prevent accidental spend while making provider debate usable. | No live provider participant by default. |
| Debate execution mode | Real runtime debates run asynchronously. `wait=1` remains fake/no-spend only. | Existing hosted real runs reject `wait=1`; route timeouts must not hold provider sessions. | No long blocking hosted provider wait path. |
| Participant turn model | One normal run per participant turn in R24. | Avoids durable multi-turn participant session/resume guarantees and keeps every turn traceable by run id. | No long-lived debate participant sessions, no hosted Codex interactive, no session-resume claim. |
| Judge model | Internal bounded judge runner using existing run/runtime contracts. Fake deterministic judge remains default. | Gives model-judge plumbing without a public arbitrary model endpoint. | No public `/model-judge`; no unbounded model choice route. |
| Live judge spend | Explicit request opt-in plus operator/provider/canary opt-in. | Judge runs can spend just like participant runs. | No live model judging in tests, default smoke, default preflight, or default canary. |
| Hosted persistence | Add durable Postgres debate state and hosted debate queue/outbox/readiness checks. | Hosted server cannot rely on in-memory microtasks or SQLite-only debate state. | No hosted debate with volatile state. |
| Runtime expansion | Closed to already shipped hosted runtime modes and fake defaults. | Keeps R24 provider-facing but not an adapter expansion release. | No AgentField/Generic HTTP bridge, Cursor/OpenClaw/Paperclip, browser, repo, generic process, or PTY. |

## Exact Runtime Matrix

| Runtime mode | Local debate participant | Hosted debate participant | Internal judge runner | R24 default tests/smoke/canary | R24 notes |
| --- | --- | --- | --- | --- | --- |
| `fake.deterministic` | Shipped, default. | Shipped, default no-spend hosted path. | Shipped deterministic judge default. | Required path. | Used for all required tests, smoke, preflight, and default canary. |
| `codex.exec_json` | Shipped opt-in one-shot participant turn. | Shipped opt-in one-shot participant turn using existing R21 hosted provider activation. | Shipped opt-in one-shot judge runner only with live-spend confirmation. | Fake substitutes only. | No post-start input, no approval bridge, no session resume. |
| `claude_code.sdk` | Shipped opt-in participant turn using existing local runtime lifecycle. | Shipped opt-in participant turn using existing R21/R23 hosted runtime and bridge gates. | Shipped opt-in judge runner only with live-spend confirmation. | Fake substitutes only. | Runtime approvals use existing approval routes. No hosted live-resume guarantee. |
| `opencode.acp` | Shipped opt-in participant turn using structured ACP runtime lifecycle. | Shipped opt-in participant turn using existing R21/R23 hosted ACP bridge gates. | Shipped opt-in judge runner only with live-spend confirmation. | Fake substitutes only. | Structured ACP only. No PTY, terminal, TUI, or screen driving. |
| `codex.interactive` | Unshipped for debate in R24. | Unshipped. | Unshipped. | Must fail closed. | Existing local-only runtime remains outside debate until session-resume semantics are separately shipped. |
| `agentfield.async_rest` | Unshipped for debate in R24. | Unshipped. | Unshipped. | Must fail closed. | Hosted bridge/callback contract remains unshipped. |
| `generic_http.async_rest` | Unshipped for debate in R24. | Unshipped. | Unshipped. | Must fail closed. | Hosted bridge/callback contract remains unshipped. |
| Cursor/OpenClaw/Paperclip | Unshipped. | Unshipped. | Unshipped. | Must fail closed. | Adapter families remain future scope. |
| Browser/repo/generic process/PTY | Unshipped. | Unshipped. | Unshipped. | Must fail closed. | No public arbitrary execution or automation routes. |

## API And Request Contract

The only public route family is still:

- `POST /debates`
- `POST /debates?wait=1`
- `GET /debates/:id`
- `GET /debates/:id/events`

R24 may add fields to the existing `POST /debates` body. The additive request contract is:

```json
{
  "topic": "Should Switchyard use hosted real debate now?",
  "participants": [
    {
      "role": "affirmative",
      "runtime": "claude_code",
      "provider": "anthropic",
      "model": "claude-code",
      "adapterType": "native",
      "runtimeMode": "claude_code.sdk",
      "placement": "hosted",
      "realRuntimeOptIn": true
    },
    {
      "role": "skeptic",
      "runtime": "opencode",
      "provider": "opencode",
      "model": "opencode-default",
      "adapterType": "acpx",
      "runtimeMode": "opencode.acp",
      "placement": "hosted",
      "realRuntimeOptIn": true
    }
  ],
  "judgeConfig": {
    "mode": "deterministic"
  },
  "evidenceIds": ["evidence_123"],
  "limits": {
    "maxRounds": 2,
    "maxTurnsPerAgent": 2,
    "maxTotalMessages": 4,
    "maxDurationSeconds": 60,
    "maxCostUsd": 0
  }
}
```

Request rules:

- Omitted participant runtime fields still default to `fake.deterministic`.
- `participants` must still contain exactly two entries.
- `participants[*].placement` defaults to `local` for local daemon and to the configured debate default for hosted server only when the runtime is `fake.deterministic`. Real hosted participants must explicitly set `placement: "hosted"`.
- A non-fake participant must set `realRuntimeOptIn: true`; otherwise creation fails with `debate_real_participant_opt_in_required` before run, queue, quota, or provider side effects.
- `judgeConfig` is optional and defaults to `{ "mode": "deterministic" }`.
- `judgeConfig.mode: "model"` requires `judgeConfig.realRuntimeOptIn: true` and `judgeConfig.confirmLiveProviderSpend: true`; otherwise judge creation fails with `debate_judge_live_spend_unconfirmed`.
- `judge` remains a reserved output field and must not be accepted as input.
- For real participant or live judge requests, `POST /debates?wait=1` must fail before provider side effects with `debate_wait_real_runtime_unsupported`. Fake deterministic `wait=1` remains supported.
- The response shape remains additive and compatible with R9: `{ debate }` for async create and `{ debate, events, finalReportArtifact }` for fake/no-spend wait mode.

## Architecture

R24 extends `DebateService` into a closed runtime orchestrator while preserving existing run, message, event, evidence, and artifact primitives. Debate creation validates the request, validates evidence before side effects, attaches hosted ownership when applicable, reserves debate quota if configured, persists the debate, and enqueues an internal debate execution job for async execution. The server does not instantiate real provider adapters for debate work.

Participant execution is one normal run per participant turn. The turn runner builds a bounded prompt from the debate topic, role, previous messages, evidence ids, and stop-limit snapshot. It creates a run with metadata including `debateId`, `participantId`, `participantRole`, `debateRunKind: "participant_turn"`, `debateRound`, and `debatePhase`. Local placement uses the existing local `RunService`; hosted placement uses the existing `HostedRunService`, provider activation gates, run queue, worker execution, and R23 hosted runtime bridge behavior where supported. When the run reaches a terminal status, the debate service extracts bounded runtime output from persisted `runtime.output` events, creates a routed message through `MessageRouter`, appends `debate.agent.argument` or `debate.agent.rebuttal`, and updates participant `runIds` and `turnsUsed`.

Judging is an internal runner, not a route. The default deterministic judge preserves the current no-spend behavior. A live model judge, when explicitly enabled, creates a normal run with metadata `debateRunKind: "judge"` and the selected closed runtime mode, then parses a bounded judge response into the existing `judge` object. Invalid, empty, overlarge, or missing judge output fails visibly with named judge errors. The final markdown report artifact must include debate id, stop reason, participant run ids per turn, judge run id when present, evidence ids, message ids, and the judge summary.

Hosted/server mode needs durable state before exposing `/debates`. R24 must add a Postgres debate store equivalent to `SqliteDebateStore`, a hosted debate execution queue/outbox or equivalent durable work claim path, readiness/preflight diagnostics for debate dependencies, ownership rows for the debate and derived resources, and audit records for admission, participant dispatch, judge dispatch, terminal success/failure, and denied attempts. If any hosted debate dependency is missing in staging/production, readiness and preflight fail closed.

## Data Flow Shadow Paths

### Flow 1: Debate Creation

- Happy path: Caller posts a valid two-participant fake or opt-in real debate. Evidence is validated before side effects, hosted auth/ownership/quota/audit checks pass, debate state is persisted, execution is queued or completed for fake `wait=1`, and the caller receives the existing debate response.
- Nil path: Request body is missing, null, array, or not an object. Return `400 invalid_input` with `{ path: "body", issue: "must be an object" }`; no debate, run, message, event, artifact, quota, or audit allow side effect is created.
- Empty path: `topic` is blank, participants array is missing or not exactly two, participant role is blank, or `evidenceIds` contains empty entries. Return `400 invalid_input`; no side effects beyond a denied audit record when hosted auth exists.
- Error path: Evidence is unknown, tenant lacks ownership, debate quota is exceeded, hosted debate store/queue is unavailable, real runtime opt-in is missing, provider activation is denied, or live judge spend is unconfirmed. Return the named failure (`evidence_not_found`, `tenant_access_denied`, `hosted_debate_quota_exceeded`, `hosted_debate_store_unavailable`, `hosted_debate_queue_unavailable`, `debate_real_participant_opt_in_required`, `provider_spend_limit_exceeded`, or `debate_judge_live_spend_unconfirmed`) before provider dispatch.

### Flow 2: Participant Turn Run

- Happy path: A participant turn creates a normal run, records placement, executes through the selected local or hosted runtime, reads bounded `runtime.output`, creates a routed message, appends debate events, updates participant `runIds`, and advances to the next turn or stop reason.
- Nil path: A participant record, run record, runtime output event list, or run id is missing during execution. The debate fails visibly with `debate_participant_run_missing` or `debate_participant_output_missing`; a failure judge/report is written where possible.
- Empty path: Participant runtime output exists but has no non-empty text after trimming. The debate fails with `debate_participant_output_empty` and does not invent a message.
- Error path: Run creation is denied, hosted queue enqueue fails, run times out, run fails, runtime waits past debate deadline, approval expires, output exceeds bounds, or tenant ownership cannot be attached. The debate records `debate_participant_run_failed`, `debate_participant_run_timeout`, `debate_runtime_approval_expired`, `debate_participant_output_too_large`, or `hosted_debate_ownership_attach_failed` and terminalizes without continuing silently.

### Flow 3: Internal Judge Runner

- Happy path: Deterministic judge or explicit live judge reads persisted messages/evidence, produces a bounded judge object, appends `debate.judge.summary`, optionally appends `debate.consensus`, writes the final report artifact, and terminalizes the debate.
- Nil path: `judgeConfig` is omitted. Use deterministic no-spend judge. If persisted messages are missing, judge returns a visible no-consensus summary with existing message ids only.
- Empty path: Live model judge returns blank output or a JSON object missing required summary/disagreement fields. Fail with `debate_judge_output_empty` or `debate_judge_output_invalid`; do not store a misleading successful judge result.
- Error path: Live judge runtime is not allowed, spend confirmation is missing, provider activation fails, judge run fails/timeouts, parse fails, output is over bounds, artifact write fails, or queue/store is unavailable. Use `debate_judge_runtime_unsupported`, `debate_judge_live_spend_unconfirmed`, `provider_runtime_policy_missing`, `debate_judge_run_failed`, `debate_judge_timeout`, `debate_judge_output_invalid`, `debate_judge_output_too_large`, `hosted_debate_artifact_write_failed`, or `hosted_debate_queue_unavailable`.

### Flow 4: Inspect, Events, Messages, And Artifacts

- Happy path: Authorized caller inspects a debate and receives debate state, ordered events, ordered messages, evidence records, artifacts, participant run ids, and final report metadata. Events replay/live streaming continues to filter by `debateId`.
- Nil path: Debate id does not exist or is not owned by the caller. Return `debate_not_found` or the existing no-leak tenant denial behavior before disclosing events/messages/artifacts.
- Empty path: Debate exists but has no events/messages yet because async execution is queued. Return the debate with empty arrays and status `created` or the current nonterminal status; do not synthesize fake events.
- Error path: Event store, message store, artifact store, or ownership lookup fails. Return a named store/auth error and increment low-cardinality diagnostics; do not leak cross-tenant resource existence.

### Flow 5: Preflight, Smoke, And Canary

- Happy path: Default preflight/smoke/canary runs a hosted fake debate with fake participants and deterministic judge, verifies event/message/artifact traceability, and reports live participant/judge checks as skipped unless explicitly requested.
- Nil path: Debate dependencies are omitted from configuration. Preflight/readiness returns `hosted_debate_inactive` when hosted debate is disabled or `hosted_debate_store_unavailable` when enabled but missing required stores.
- Empty path: Allowlist contains no real participant modes. Preflight still passes the fake debate path and reports real participant checks as inactive.
- Error path: Live debate canary is requested without `--confirm-live-provider-spend`, provider activation is missing, bridge readiness for Claude/OpenCode is missing, or hosted debate queue/store/object store is unavailable. Canary/preflight fails with `debate_live_canary_spend_unconfirmed`, `provider_runtime_policy_missing`, `hosted_runtime_bridge_store_unavailable`, `hosted_debate_queue_unavailable`, or `object_store_unavailable`.

## Named Failure Codes

R24 may reuse existing codes where exact. New or normalized codes expected from contracts, REST mappers, services, preflight, canary, and docs include:

- `debate_real_participant_opt_in_required`
- `debate_runtime_unsupported`
- `debate_wait_real_runtime_unsupported`
- `debate_participant_count_invalid`
- `debate_participant_placement_required`
- `debate_participant_run_missing`
- `debate_participant_run_failed`
- `debate_participant_run_timeout`
- `debate_participant_output_missing`
- `debate_participant_output_empty`
- `debate_participant_output_too_large`
- `debate_runtime_approval_expired`
- `debate_judge_config_invalid`
- `debate_judge_runtime_unsupported`
- `debate_judge_live_spend_unconfirmed`
- `debate_judge_run_failed`
- `debate_judge_timeout`
- `debate_judge_output_missing`
- `debate_judge_output_empty`
- `debate_judge_output_invalid`
- `debate_judge_output_too_large`
- `hosted_debate_store_unavailable`
- `hosted_debate_queue_unavailable`
- `hosted_debate_worker_unavailable`
- `hosted_debate_ownership_attach_failed`
- `hosted_debate_quota_exceeded`
- `hosted_debate_audit_unavailable`
- `hosted_debate_artifact_write_failed`
- `hosted_debate_event_persist_failed`
- `debate_live_canary_spend_unconfirmed`
- `debate_fake_canary_failed`

Existing codes that must remain visible and must not be collapsed:

- `invalid_input`
- `invalid_query`
- `debate_not_found`
- `evidence_not_found`
- `run_not_found`
- `placement_denied`
- `hosted_runtime_not_allowed`
- `hosted_real_runtime_disabled`
- `hosted_explicit_placement_required`
- `hosted_wait_unsupported`
- `provider_runtime_policy_missing`
- `provider_runtime_policy_unknown_mode`
- `provider_runtime_policy_disabled`
- `provider_command_policy_invalid`
- `provider_binary_unavailable`
- `provider_credentials_missing`
- `provider_spend_controls_invalid`
- `provider_prompt_too_large`
- `provider_spend_limit_exceeded`
- `hosted_runtime_bridge_store_unavailable`
- `hosted_runtime_bridge_worker_unavailable`
- `codex_exec_json_input_unsupported`
- `codex_exec_json_approval_bridge_unsupported`
- `hosted_codex_interactive_unshipped`
- `agentfield_bridge_unshipped`
- `generic_http_bridge_unshipped`
- `auth_required`
- `tenant_access_denied`
- `project_access_denied`
- `entitlement_denied`
- `quota_exceeded`
- `audit_log_unavailable`
- `queue_unavailable`
- `object_store_unavailable`
- `object_store_timeout`
- `adapter_protocol_failed`

No expected operator, tenant, quota, provider, participant, judge, store, queue, artifact, or bridge failure may surface only as `internal_error`.

## Security, Tenant, Quota, And Audit Posture

- Hosted `/debates` routes require the existing hosted API-key auth hooks in staging/production. `POST /debates` requires `runs:write`; `GET /debates/:id` and `GET /debates/:id/events` require `runs:read`.
- Debate ownership must be a first-class hosted resource ownership type or equivalent ownership record. The debate row, participant runs, judge run, run events, messages, artifacts, and derived approvals must attach to the same account, tenant, project, user, and API key before they are visible.
- Authorization must happen before debate existence, event existence, message existence, artifact existence, or approval scope is leaked.
- Debate admission reserves debate quotas when configured. Participant and judge runs must also consume existing run quotas and provider spend controls. Real participant and live judge requests must respect active runs, runs per hour, prompt size, timeout, and spend-control checks.
- R24 adds additive quota kinds `debates_per_hour` and `active_debates`. Omitted or zero quotas must remain backward compatible and must not break existing bootstrap fixtures.
- Denied debate creation records an audit denial when auth is present. Accepted debate creation, participant run dispatch, judge dispatch, terminal completion/failure, artifact write, and denied live spend attempts record audit events with redacted payloads.
- Audit payloads may include debate id, runtime mode, placement, operation, decision, reason code, request id, and byte counts. They must not include raw prompt text, provider output, credentials, env, command args, object keys, API keys, or approval secrets.
- Hosted server must not instantiate real provider adapters for debate participant or judge execution. Provider sessions remain worker-owned through existing run/worker runtime paths.
- Unsupported runtime or judge modes fail before queue enqueue, provider dispatch, quota consumption, and worker adapter dispatch.
- A stale participant or judge run must not be associated with a different debate or tenant. Run metadata and ownership must be checked before routing output into a debate message or judge result.

## Hard Limits

R24 must preserve the R9 hard stop posture and tighten it for live paths:

- Exactly two participants per debate.
- `topic` remains bounded to 2048 UTF-8 bytes unless CTO chooses a stricter bound.
- `participants[*].role` remains bounded to 64 UTF-8 bytes.
- `evidenceIds` remains bounded to at most 10 ids.
- `maxRounds` remains bounded to 1-3.
- `maxTurnsPerAgent` remains bounded to 1-3.
- `maxTotalMessages` remains bounded to 1-12.
- `maxDurationSeconds` remains bounded to 1-60 for default no-spend and must never exceed the selected runtime timeout.
- `maxSearchesPerAgent` remains 0 in R24. Real research/browser/search automation is not part of debate execution.
- `maxCostUsd` defaults to 0. Any value above 0 requires real runtime opt-in, spend confirmation where applicable, hosted provider spend controls, and audit.
- Every participant turn prompt and judge prompt must have byte limits before run creation.
- Every participant output and judge output must have byte limits before message/judge persistence.
- Every debate execution job must have a terminal timeout and reconciliation path. No active debate may remain stuck forever in `created`, `arguing`, `rebuttal`, or `judging`.

## No-Spend Verification

Required tests, smoke, preflight, and default canary must be deterministic and no-spend:

- Unit and integration tests use `fake.deterministic`, fake Claude, fake ACP, or no-spend fake hosted worker stores only.
- `POST /debates?wait=1` smoke uses fake deterministic participants and deterministic judge.
- Hosted/server smoke creates a hosted fake debate, verifies participant run ids, event ids, message ids, judge, stop reason, and final report artifact metadata, and performs no provider calls.
- Production preflight reports live participant and live judge checks as inactive/skipped unless explicitly configured.
- Default production canary runs fake hosted debate only and reports `debate_live_canary_skipped_default`.
- Live participant canary requires an explicit flag such as `--live-debate-runtimes`.
- Live judge canary requires explicit flags such as `--live-debate-judge --confirm-live-provider-spend`.
- If a live canary flag is supplied without spend confirmation, canary must fail fast with `debate_live_canary_spend_unconfirmed` before provider dispatch.

## Canary, Preflight, Readiness, And Docs

- Hosted server `/ready` must report hosted debate dependencies: Postgres debate store, event store, message store, artifact store/content, debate execution queue/outbox, run queue, control-plane ownership, quota, audit, route auth, and hosted runtime gate.
- Hosted worker readiness must report debate execution capability when the worker is expected to claim debate jobs: debate job claim, run dispatch, participant output collection, judge runner, artifact writer, and R23 bridge readiness for `claude_code.sdk`/`opencode.acp`.
- Production preflight must fail closed when hosted debate is enabled without API-key auth, Postgres/control-plane ownership, debate store, durable queue/outbox, run queue, object store, quota store, audit store, worker readiness, provider activation gates, or required bridge dependencies.
- Production canary must include a default fake hosted debate scenario and optional live participant/live judge scenarios gated by explicit flags and spend confirmation.
- Hosted OpenAPI must include the existing `/debates` route family if hosted debates are exposed, and must prove no forbidden public route families were added.
- `PRODUCT.md`, `README.md`, `docs/development/API.md`, `docs/development/DEVELOPMENT.md`, `deploy/production/README.md`, production manifest docs, and adapter docs must state the exact shipped/unshipped R24 boundary.
- Docs must say that AgentField/Generic HTTP debate bridges, hosted Codex interactive/session resume, public model judging routes, terminal/PTY/TUI automation, browser automation, hosted repo, generic process/PTY adapters, dashboard/TUI, and managed SaaS remain unshipped.

## Acceptance Criteria

- [ ] Hosted/server exposes debate create/inspect/events only through the existing `/debates` route family; no new participant, judge, model-judge, terminal, PTY, sandbox, process, shell, dashboard, or TUI route is added.
- [ ] Hosted/server registers existing debate routes with API-key auth, ownership-first access checks, quota, audit, durable Postgres debate state, and no cross-tenant resource leakage.
- [ ] `POST /debates?wait=1` remains supported for fake deterministic no-spend debates and rejects real participant or live judge requests with `debate_wait_real_runtime_unsupported` before provider side effects.
- [ ] Fake deterministic participants and deterministic judge remain the default and power all required tests, smoke, preflight, and default canary.
- [ ] Real participant runtimes require explicit request opt-in and pass the exact shipped runtime matrix; omitted opt-in fails with `debate_real_participant_opt_in_required`.
- [ ] Local and hosted participant turns for `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, and `opencode.acp` use normal run lifecycle records with debate/participant metadata and bounded prompts.
- [ ] Hosted real participant turns use existing `HostedRunService`, provider activation, provider spend controls, run queue, worker execution, and R23 bridge readiness. The server never constructs provider adapters.
- [ ] `codex.exec_json` participant turns remain one-shot and never claim post-start input, approval bridge, or session resume.
- [ ] `claude_code.sdk` and `opencode.acp` participant turns preserve existing hosted input/approval bridge behavior and terminalize visibly if approval/input waits exceed debate limits.
- [ ] `codex.interactive`, AgentField, Generic HTTP, Cursor, OpenClaw, Paperclip, browser, repo, generic process, and PTY debate runtime paths fail closed with named unsupported codes.
- [ ] Participant runtime output is read from persisted run events, bounded, redacted where needed, converted to durable messages through `MessageRouter`, and linked to debate events.
- [ ] Nil, empty, failed, timed-out, waiting-expired, overlarge, or unowned participant run output fails visibly with named participant errors and a failure report where possible.
- [ ] Internal judge runner supports deterministic fake default and opt-in live model judging through existing run/runtime contracts only.
- [ ] Live judge requires request-level opt-in, spend confirmation, provider activation, run quota, timeout, output bounds, and canary opt-in. Missing confirmation fails with `debate_judge_live_spend_unconfirmed`.
- [ ] Judge output is parsed into the existing `judge` object, with invalid/empty/overlarge output mapped to named judge errors.
- [ ] Final report artifacts include debate id, stop reason, participant ids, participant run ids, judge run id when present, evidence ids, message ids, and judge summary.
- [ ] Debate event replay/live streaming remains debate-scoped and ordered by persisted event sequence, including participant turn, judge summary, consensus, and artifact-created events.
- [ ] Hosted debate readiness, preflight, canary, metrics, logs, audit, docs, OpenAPI, and product truth match the exact shipped/unshipped boundary.
- [ ] Default test/smoke/preflight/canary paths perform no live provider calls and have assertions proving live paths are skipped unless explicitly confirmed.

## Required Tests

- Contract tests:
  - debate create input parses fake default, opt-in real participants, and deterministic/model `judgeConfig`;
  - `judge` remains reserved output and is rejected as input;
  - all R24 failure codes are in the closed HTTP error set and REST mappings;
  - hosted OpenAPI contains existing `/debates` routes only and excludes `/debates/participants/real`, `/debates/judge`, `/model-judge`, `/judging`, `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, `/sandbox`, dashboard, and TUI routes.
- Storage tests:
  - `PostgresDebateStore` create/get/update/list behavior matches `SqliteDebateStore`;
  - additive Postgres schema migration adds debate state without destructive SQL;
  - debate events/artifacts list by `debateId`;
  - hosted ownership rows can attach to debate resources and derived run/event/message/artifact resources.
- Core debate tests:
  - fake deterministic debate remains backward compatible;
  - real participant opt-in happy/nil/empty/error paths;
  - participant run failure, timeout, waiting expiry, missing output, empty output, and overlarge output;
  - one run per turn with correct `debateRunKind`, round, phase, participant id, and run id traceability;
  - deterministic judge default;
  - live judge opt-in denial without spend confirmation;
  - live judge fake-provider success through normal run lifecycle;
  - invalid/empty/overlarge judge output;
  - final report contains participant run ids and judge run id when present.
- Hosted/server route tests:
  - auth required in hosted mode;
  - `runs:write` required for create and `runs:read` required for inspect/events;
  - tenant mismatch does not leak debate existence;
  - unknown evidence fails before debate side effects;
  - missing real opt-in fails before run/queue/provider side effects;
  - hosted debate store/queue missing fails closed;
  - fake hosted debate creates durable state and can be inspected;
  - real hosted participant creates run jobs through `HostedRunService` only.
- Worker/queue tests:
  - hosted debate job claim and completion;
  - stale debate job recovery;
  - worker unavailable readiness failure;
  - participant run output collection from persisted events;
  - R23 bridge readiness required when allowlist includes `claude_code.sdk` or `opencode.acp`.
- Ops tests:
  - production preflight inactive/default fake pass;
  - production preflight fails when hosted debate is enabled without store, queue, auth, quota, audit, object store, worker readiness, provider activation, or bridge readiness;
  - default canary runs fake debate and skips live participant/judge paths;
  - live canary without spend confirmation fails before provider dispatch.
- Security/redaction tests:
  - audit/log/metric payloads contain low-cardinality ids/reason codes/byte counts only;
  - no raw prompt, raw provider output, credentials, env, command args, object keys, API keys, or approval secrets in logs, audit, event metadata, or artifact metadata;
  - source tests prove hosted server does not import or instantiate real provider adapters for debate execution.

Suggested verification command set for CTO to refine:

```bash
pnpm --filter @switchyard/contracts test
pnpm --filter @switchyard/core test -- debate
pnpm --filter @switchyard/protocol-rest test -- debate-routes
pnpm --filter @switchyard/storage test -- postgres-debate
pnpm --filter @switchyard/server test
pnpm --filter @switchyard/worker test
pnpm exec vitest run scripts/production-preflight.test.ts scripts/production-canary.test.ts
pnpm --filter @switchyard/contracts openapi:check
pnpm --filter @switchyard/contracts openapi:check:hosted
pnpm typecheck
pnpm test
pnpm build
pnpm lint
git diff --check
```

## Phase

### Phase 23: R24 Hosted Real Debate

**Goal:** Ship hosted/server-safe debate execution with opt-in real participant runtimes and internal bounded judge-runner plumbing through existing `/debates` routes, while preserving no-spend defaults and keeping all unshipped adapter, route, dashboard/TUI, PTY, browser, repo, and SaaS gaps out of scope.

**Acceptance:**

- Existing `/debates` routes support local fake, hosted fake, and opt-in local/hosted participant runs for the shipped runtime matrix.
- Real participant execution and live model judging are explicit opt-in and fail closed before provider dispatch when opt-in, provider activation, quota, bridge readiness, or spend confirmation is missing.
- Internal judge runner uses existing run/runtime contracts, defaults to deterministic no-spend behavior, and never creates a public model-judge route.
- Hosted debate state, events, messages, runs, artifacts, ownership, quota, audit, preflight, readiness, and canary behavior are durable and tenant-safe.
- Required tests, smoke, preflight, and default canary remain deterministic and no-spend.
- Product docs and OpenAPI truth match the shipped and unshipped runtime matrix.

**Non-goals (this phase):** Dashboard; TUI; public participant/judge/model-judge routes; public arbitrary exec/shell/process/command/PTY/terminal/sandbox routes; terminal/PTY/TUI automation; hosted `codex.interactive`; Codex session resume guarantees; AgentField/Generic HTTP hosted bridges; Cursor/OpenClaw/Paperclip; browser automation; hosted repo; generic process/PTY adapters; managed SaaS, billing, payments, signup, OAuth/OIDC/SAML/SSO/SCIM.

**Complexity:** L

## Required Product Truth After R24

After audit GREEN, product truth must say:

- R24 ships hosted/server-safe debate through the existing `/debates` route family.
- R24 ships fake deterministic hosted debate as the default no-spend path.
- R24 ships opt-in local and hosted debate participant runs for `fake.deterministic`, `codex.exec_json`, `claude_code.sdk`, and `opencode.acp`.
- R24 ships an internal bounded judge runner with deterministic fake default and live model judge only behind explicit opt-in and spend confirmation.
- Debate participant and judge execution use existing run/runtime contracts and preserve run/message/event/artifact traceability.
- Hosted debate requires durable Postgres debate state, ownership, quota, audit, queue/outbox, object-store, worker readiness, provider activation, and R23 bridge readiness where applicable.
- `codex.exec_json` remains one-shot, `codex.interactive` remains unshipped for hosted debate, and AgentField/Generic HTTP bridges remain unshipped.
- No dashboard/TUI, no public arbitrary execution routes, no PTY/terminal automation, no browser automation, no hosted repo, no generic process/PTY adapters, no public model judge route, and no managed SaaS/billing/OAuth ship in R24.

## Auditor Focus

Auditor must explicitly verify:

- No public `/debates/participants/real`, `/debates/judge`, `/model-judge`, `/judging`, `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, `/sandbox`, dashboard, or TUI route was added.
- Hosted OpenAPI exposes only the existing debate route family for debate behavior.
- Hosted server does not instantiate or call real provider adapters for participant or judge execution.
- Real participant and live judge paths require explicit opt-in and fail before provider dispatch when opt-in/spend/provider gates are missing.
- Default tests, smoke, preflight, and canary use only fake/no-spend runtimes.
- Hosted debate state is durable in Postgres and does not rely on server-local memory or SQLite-only stores.
- Debate ownership checks happen before existence leaks for inspect/events/artifacts/messages/runs.
- Participant and judge runs attach debate metadata and ownership before output is routed into messages or judge results.
- R23 bridge readiness is required for hosted Claude/OpenCode participant runs that can pause for input/approval.
- Stop limits, output bounds, timeouts, quota, audit, and artifact/report traceability are enforced for fake and real paths.
- Product docs do not overclaim hosted Codex interactive/session resume, AgentField/Generic HTTP bridges, browser automation, hosted repo, generic process/PTY adapters, dashboard/TUI, arbitrary execution, or managed SaaS/billing/OAuth.
