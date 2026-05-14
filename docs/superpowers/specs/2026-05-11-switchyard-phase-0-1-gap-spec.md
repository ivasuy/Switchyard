# Switchyard Phase 0/1 Gap Spec

Date: 2026-05-11

## Summary

The current implementation correctly covers the narrow in-memory fake-runtime path, but Phase 0 and Phase 1 are not complete against the master plan. This spec defines the missing work required before Phase 2 starts.

## Current State

Implemented:

- TypeScript pnpm monorepo scaffold.
- Shared `@switchyard/contracts` Zod schemas and inferred types.
- `@switchyard/core` ports plus run and runtime runner services.
- `@switchyard/testkit` fake runtime adapter and in-memory run/event/session stores.
- `@switchyard/protocol-rest` run routes for create, inspect, replay events, input, and cancel.
- `@switchyard/daemon` local Fastify app wired to in-memory stores and fake runtime.
- Passing `pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm lint`.

Missing:

- Phase 0.2 contract tests parse happy paths and a few invalid ids, but do not yet provide required-field negative coverage for every schema.
- Phase 0.3 service shell files are represented by one shared `shells.ts` file, not the explicit per-service files listed in the master plan.
- Phase 0.3 has a placement policy port, but no explicit placement-decision persistence port.
- Phase 0.4 lacks a reusable adapter contract test in `packages/core/test/runtime-adapter-contract.test.ts`.
- Phase 1.2 local SQLite/filesystem persistence does not exist.
- Phase 1.2 must persist runs, events, artifacts, messages, approvals, registry records, runtime sessions, and placement decisions.
- Phase 1.3 has REST run routes, but no artifact routes, no registry routes, and no protocol-level live SSE package.
- Phase 1.4 daemon is wired to in-memory stores, not local SQLite/filesystem storage.
- Fake runtime artifacts are returned by the adapter but never collected, stored, or exposed through REST.
- Fake runtime transcript content is not written to filesystem artifact storage.
- `POST /runs` starts the fake runtime synchronously and returns only after completion; the target API contract says run creation should return a run id immediately and clients observe progress through events.
- `GET /runs/:id/events` returns a finite replay response with an SSE content type; it does not support live streaming.

## Requirements

### Phase 0 Closure

1. Preserve the existing public source exports from `@switchyard/core`.
2. Add explicit service shell source files for the service names called out in the master plan.
3. Add a placement-decision store interface and in-memory implementation.
4. Add a reusable runtime adapter contract test helper or core test that future adapters can reuse.
5. Add required-field negative contract tests for every schema exported by `@switchyard/contracts`.
6. Keep fake adapter behavior deterministic and compatible with the shared adapter contract.

### Phase 1 Local Persistence

1. Add `@switchyard/storage` package.
2. Implement local SQLite-backed stores for:
   - runs
   - run events
   - runtime sessions
   - artifacts
   - messages
   - approvals
   - providers
   - runtimes
   - models
   - placement decisions
3. Store JSON payloads and metadata losslessly.
4. Add filesystem artifact storage for fake transcripts and write transcript content for completed fake runs.
5. Verify every local store survives re-instantiation.

### Phase 1 Runtime Artifact Flow

1. Extend the runtime runner dependencies to accept an artifact store.
2. After terminal runtime events, call adapter `artifacts(session)`.
3. Normalize artifact records to the actual run id.
4. Store artifact records.
5. Store artifact content when content is available.
6. Emit `artifact.created` events.
7. Expose stored artifacts through `GET /runs/:id/artifacts`.

### Phase 1 API Semantics

1. Keep `POST /runs` compatible with the README fake-run smoke path.
2. Add a queued async launch path so `POST /runs` can return immediately for long-running work.
3. Add a daemon-local in-process queue for the local MVP.
4. Create `packages/protocol-sse` and make `GET /runs/:id/events` support replay plus live events from the event bus.
5. Keep finite replay behavior testable without hanging Fastify injection tests.
6. Add registry REST routes for providers, runtimes, and models.
7. Keep `POST /runs` default behavior compatible by returning a completed fake run in local wait mode, while adding an explicit async mode for non-blocking launch.

### Phase 1 Daemon Wiring

1. Wire the daemon to local SQLite/filesystem storage by default.
2. Keep test-only in-memory app construction available for unit-level tests.
3. Add config values for:
   - host
   - port
   - data directory
   - SQLite file path
   - artifact directory
4. Add smoke tests for:
   - create fake run
   - event replay
   - live event streaming
   - artifact listing
   - artifact file content
   - persistence across app/store re-instantiation

## Non-Goals

- No real runtime adapters.
- No ACP/acpx implementation.
- No hosted Postgres/Redis/S3 storage.
- No debate engine.
- No auth.
- No approval workflow beyond existing schemas and ports.

## Completion Criteria

Phase 0/1 are considered closed when:

- `packages/storage` exists and passes persistence tests.
- Storage covers runs, events, sessions, artifacts, messages, approvals, registry records, and placement decisions.
- Daemon uses local SQLite/filesystem storage outside unit tests.
- Fake runtime artifact metadata and transcript content are stored and visible through REST/filesystem checks.
- `packages/protocol-sse` exists and is used by REST run events.
- `GET /runs/:id/events` can replay stored events and stream live events.
- Registry routes exist for providers, runtimes, and models.
- `POST /runs` keeps the README-compatible fake-run response and also has a non-blocking launch path.
- A fresh repo checkout can run `pnpm install`, `pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm lint`.
- README, CHANGELOG, and the master implementation plan accurately describe what is implemented.
