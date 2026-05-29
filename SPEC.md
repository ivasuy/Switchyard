# SPEC: Local Gateway Completeness (R2)

Make the local daemon inspectable and verifiable through HTTP without
requiring SQLite inspection or known seeded IDs. Add run listing,
registry listing, global artifact lookup, and local artifact content
retrieval. Standardize the error contract across every endpoint. Ship
open-ended local SSE while keeping the existing bounded mode for
deterministic tests. Preserve the existing fake runtime and Codex
`exec --json` runtime behavior.

## Goals

- A developer can find runs by HTTP filter without knowing seeded IDs
  or opening SQLite.
- A developer can list providers, runtimes, and models from HTTP.
- A developer can fetch artifact metadata by artifact id and stream
  artifact content from HTTP.
- Every 4xx and 5xx response uses one error shape with a closed set
  of machine codes.
- One explicit, documented SSE story: open-ended live is the default,
  bounded `stopAfter` is preserved for tests.
- Every shipped endpoint has both route-level tests and a daemon
  smoke that hits real HTTP.

## Non-Goals

This release does not include:

- New runtime providers or adapters.
- Hosted execution, hosted workers, or hybrid placement.
- SDK, CLI, dashboard, or TUI.
- Debate, memory, tools, approvals, or runtime capability
  infrastructure (R3+).
- Generic HTTP adapter (R4).
- Interactive Codex sessions or post-start input for `exec --json`.
- OpenAPI generation (deferred to R11).
- Authentication or authorization on local endpoints. Daemon is
  bound to `127.0.0.1` only.
- Rate limiting on any endpoint.
- Pre-validating filter values against registry contents. Filter
  values are validated for shape only (well-formed slug, enum
  membership for `status`); unknown-but-well-formed values match
  zero records rather than erroring.

## Endpoint Scope

### `GET /runs`

List runs newest-first with cursor pagination.

Query parameters:

| Name | Type | Notes |
| --- | --- | --- |
| `status` | CSV of run status enum | Any of `queued,starting,running,waiting_for_input,waiting_for_approval,completed,failed,cancelled,timeout`. Unknown values → `400 invalid_query`. |
| `runtime` | CSV of runtime slugs | E.g. `codex,fake`. Slug, not registry id. Well-formed unknown slugs match zero rows. |
| `provider` | CSV of provider slugs | E.g. `openai`. Slug, not registry id. |
| `model` | CSV of model slugs | E.g. `gpt-5.5`. |
| `placement` | CSV of placement values | Currently always `local`; reserved for R10 hosted/hybrid. |
| `adapterType` | CSV of adapter types | `native,acpx,http,webhook,process,pty,browser`. |
| `since` | ISO-8601 timestamp | Inclusive lower bound on `createdAt`. |
| `until` | ISO-8601 timestamp | Exclusive upper bound on `createdAt`. `since > until` → `400 invalid_query`. |
| `limit` | integer | Default `50`, max `200`. Out of range → `400 invalid_query`. |
| `before` | opaque cursor | From a previous response's `nextCursor`. Malformed → `400 invalid_query`. |

Response (`200`):

```json
{
  "runs": [ /* Run objects, newest first */ ],
  "nextCursor": "base64-opaque-or-null"
}
```

Sort order is `createdAt DESC, id DESC`. `nextCursor` is an opaque
base64 encoding of `{createdAt, id}` of the last returned row.
Callers must treat the cursor as opaque; the server reserves the
right to change the encoding without contract change.

### `GET /providers`, `GET /runtimes`, `GET /models`

Cursor-paginated listings of registry records.

| Endpoint | Filters | Notes |
| --- | --- | --- |
| `GET /providers` | `limit`, `before` | No content filters in R2. |
| `GET /runtimes` | `provider` (CSV slug), `adapterType` (CSV), `limit`, `before` | |
| `GET /models` | `provider` (CSV slug), `limit`, `before` | When `provider` is omitted, response includes models whose provider is not yet seeded (orphan models). When `provider` is present, orphan models are excluded. |

Response envelopes:

```json
{ "providers": [ /* records */ ], "nextCursor": "...|null" }
{ "runtimes":  [ /* records */ ], "nextCursor": "...|null" }
{ "models":    [ /* records */ ], "nextCursor": "...|null" }
```

R2 returns registry records as stored. Availability, health,
capability, and partial-support reporting are R3 territory and must
not be added here.

### `GET /artifacts/:id`

Global artifact metadata lookup. Same body shape as items in
`GET /runs/:id/artifacts`.

```json
{
  "artifact": {
    "id": "artifact_...",
    "runId": "run_...",
    "type": "transcript",
    "path": "runs/run_.../transcript.jsonl",
    "metadata": { "contentStored": true },
    "createdAt": "..."
  }
}
```

Errors:

- Missing record → `404 artifact_not_found`.

`GET /runs/:id/artifacts` is retained as a convenience listing for a
single run.

### `GET /artifacts/:id/content`

Stream artifact bytes from local storage.

- Response `Content-Type` is chosen per artifact type:
  - `transcript` → `application/x-ndjson`
  - Future artifact types declare their own type when introduced.
- Body is the raw stored content; no JSON wrapping.
- `HEAD` and `Range` requests are **not** supported in R2.

Errors:

- Missing record → `404 artifact_not_found`.
- Record exists but `metadata.contentStored=false` or backing file
  is missing → `404 missing_artifact_content`.

### `GET /runs/:id/events` (SSE decision)

Three modes on the same endpoint:

| Query | Behavior |
| --- | --- |
| _(none)_ | Replay-only. SSE response of every persisted event, then connection closes. Today's behavior. |
| `?live=1` | Replay-then-live. Replays persisted events, then keeps the connection open and streams new events as they reach the event bus. |
| `?live=1&stopAfter=N` | Bounded replay-then-live. Closes after `N` total events. Existing behavior, preserved for deterministic tests. |

Resumption: clients reconnect with the standard SSE `Last-Event-ID`
header to receive only events with sequence greater than the supplied
id. Resumption applies to all three modes.

Open-ended SSE contract:

- Server sends an SSE comment heartbeat (`:\n\n`) every **15 seconds**
  on otherwise-idle connections.
- Server closes the connection after **5 minutes** with no events
  emitted (idle timeout). Idle close is a clean `event: stream.idle`
  marker followed by EOF.
- On client disconnect (TCP close, abort, browser navigation away),
  the server **must** unsubscribe from the event bus and release
  all per-connection resources within 1 second.

A leak test under `apps/daemon` must verify that after 50
connect/disconnect cycles, the event bus has zero residual
subscribers and the process has no leaked file descriptors above
baseline.

## Error Contract

All 4xx and 5xx responses from the daemon use this shape:

```json
{
  "error": {
    "code": "snake_case_machine_code",
    "message": "human-readable explanation",
    "details": [
      { "path": "limit", "issue": "must be <= 200" }
    ]
  }
}
```

`details` is optional and is present only when the error is a
validation failure with field-level information.

Closed code set for R2:

| Code | HTTP | Used for |
| --- | --- | --- |
| `run_not_found` | 404 | Unknown run id. |
| `artifact_not_found` | 404 | Unknown artifact id. |
| `missing_artifact_content` | 404 | Artifact exists, content unavailable. |
| `provider_not_found` | 404 | Unknown provider id or slug in single-record lookup. |
| `runtime_not_found` | 404 | Unknown runtime id or slug in single-record lookup. |
| `model_not_found` | 404 | Unknown model id or slug in single-record lookup. |
| `invalid_input` | 400 | Malformed body (bad JSON, schema violation on `POST /runs`, `POST /runs/:id/input`). |
| `invalid_query` | 400 | Malformed or out-of-range query parameter. |
| `adapter_protocol_failed` | 409 | Adapter cannot perform the requested action (existing Codex post-start input case; preserved). |
| `internal_error` | 500 | Unexpected server failure. Replaces any default Fastify error payload. |

Retrofit rule: **every** existing 4xx and 5xx response across the
daemon is converted to this shape in R2. Success bodies
(`{run, events}`, `{accepted: true}`, etc.) are unchanged.

Behavior rules:

- Empty list result with valid filters → `200` with empty array and
  `nextCursor: null`, not `404`.
- Invalid filter value (bad enum, bad cursor, bad ISO, bad
  numeric) → `400 invalid_query` with `details` naming the offending
  field.
- Validation errors should pass through Zod issue paths via `details`
  where contracts already produce them, normalized to
  `{path, issue}`.

## Implementation Scope

Files and packages expected to change:

- `packages/contracts` — schemas for list query parameters, list
  response envelopes, artifact lookup response, unified error shape,
  closed error-code enum.
- `packages/storage` — list queries on run, provider, runtime, model
  stores with cursor-based keyset reads; artifact content read by id.
- `packages/protocol-rest` — new route groups for run list, registry
  lists, artifact metadata/content; error-handling middleware that
  enforces the unified shape across all routes.
- `packages/protocol-sse` — open-ended live mode, heartbeat, idle
  timeout, disconnect cleanup, `Last-Event-ID` handling.
- `apps/daemon` — wire new routes, install error middleware, add the
  SSE cleanup leak test.

Cursor encoding is implemented once in `packages/protocol-rest` (or a
small helper in `packages/contracts`) and reused by every list
endpoint.

## Tests

Required coverage:

- Route-level tests in `packages/protocol-rest` for every new
  endpoint, exercising:
  - default and explicit filter combinations,
  - cursor round-trip (decode-encode stability),
  - `400 invalid_query` for each documented invalid-input path,
  - `404` variants and the `missing_artifact_content` distinction,
  - empty result envelopes,
  - content-type selection per artifact type.
- Route-level tests for the unified error shape on representative
  legacy endpoints to lock the retrofit in place.
- SSE tests in `packages/protocol-sse` for:
  - replay-only mode,
  - bounded `stopAfter`,
  - open-ended replay-then-live with synthetic events,
  - `Last-Event-ID` resumption,
  - heartbeat cadence (15s, mocked clock),
  - idle close after 5min (mocked clock),
  - per-connection cleanup on disconnect.
- Daemon smoke in `apps/daemon` for every shipped local endpoint,
  hitting real HTTP against a real Fastify instance with real
  storage. Smokes assert **relative** changes (create N runs, list,
  assert count grew by N), not absolute counts, so the suite runs
  against any pre-existing local state.
- A standalone SSE leak test (50 connect/disconnect cycles, zero
  residual subscribers, no fd growth above baseline).

## Documentation Updates

When this release ships:

- `docs/development/API.md`
  - Rewrite the existing "Registry Lookups", "Get Run Artifacts",
    and "Get Run Events" sections in-place.
  - Add new sections: "List Runs", "List Providers / Runtimes /
    Models", "Get Artifact", "Get Artifact Content".
  - Add an "Error Contract" section documenting the shape, the
    closed code set, and the retrofit.
  - Remove the "Not implemented yet" bullets for items now shipped:
    run listing, registry listing, artifact-by-id, open-ended SSE.
- `docs/development/DEVELOPMENT.md`
  - Add a "Local Smoke Walkthrough" section with copy-paste curl
    commands that exercise every shipped endpoint end-to-end.
    Commands must work against any existing local state by
    asserting relative changes.
- `PRODUCT.md`
  - Move "Run listing", "Registry listing", and
    "Artifact-by-id endpoint" out of "What Does Not Exist Yet" into
    the appropriate "What Exists Today" subsections.
  - Update the "Events And Artifacts" subsection so it no longer
    says open-ended production streaming is missing.
  - Leave "Open-ended production SSE streams" in the missing list
    only if R2 ships open-ended local SSE without the hosted story
    — local open-ended SSE is shipped; production hosted streaming
    still belongs to R10.
- `CHANGELOG.md`
  - Add a user-facing entry listing the new endpoints, the SSE
    behavior, and the error-contract change (call out the retrofit
    as a breaking change to any caller depending on prior 4xx
    bodies).

## Local Verification

Promotion requires all of:

- `pnpm typecheck && pnpm test && pnpm build && pnpm lint` pass.
- Against a fresh `pnpm dev:daemon` instance:
  - Create one fake and one Codex run.
  - `GET /runs` returns both without knowing their ids; filters by
    `status`, `runtime`, `since`/`until` narrow the result.
  - `GET /providers`, `GET /runtimes`, `GET /models` each return
    seeded records; `GET /models?provider=openai` narrows
    correctly.
  - `GET /artifacts/:id` returns metadata for an artifact found via
    `GET /runs/:id/artifacts`.
  - `GET /artifacts/:id/content` streams the transcript with
    `Content-Type: application/x-ndjson`.
  - `GET /runs/:id/events?live=1` streams new events on a freshly
    started run, then closes within 1 second of `curl -N`
    interruption.
  - `GET /runs/:id/events?live=1&stopAfter=20` still closes
    deterministically.
  - `GET /runs/missing_id` returns `404 run_not_found` with the new
    error shape.
  - `GET /runs?status=banana` returns `400 invalid_query` with
    `details[0].path = "status"`.
  - `GET /artifacts/missing_id/content` returns
    `404 artifact_not_found`; an artifact with `contentStored=false`
    returns `404 missing_artifact_content`.
- The SSE leak test in `apps/daemon` passes.

## Promotion Criteria

R2 is shippable when:

- Every endpoint listed above is implemented, tested at both layers,
  and documented in `docs/development/API.md`.
- `docs/development/DEVELOPMENT.md` has a copy-paste smoke
  walkthrough that exercises the whole local gateway and works
  against any existing state.
- `PRODUCT.md` accurately reflects the new "What Exists Today"
  surface and removes the now-shipped items from "What Does Not
  Exist Yet".
- `CHANGELOG.md` documents the new endpoints, SSE behavior, and the
  error-contract retrofit.
- No new runtime providers, hosted execution, SDK, CLI, dashboard,
  debate, memory, tools, approvals, runtime capability
  infrastructure, Generic HTTP, OpenAPI generation, auth, or rate
  limiting are introduced.
