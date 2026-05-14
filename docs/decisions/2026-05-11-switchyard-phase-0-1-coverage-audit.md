# Switchyard Phase 0/1 Coverage Audit

Date: 2026-05-11

Audited documents:

- `docs/superpowers/specs/2026-05-11-switchyard-design.md`
- `docs/superpowers/plans/2026-05-11-switchyard-master-implementation-plan.md`
- `docs/superpowers/specs/2026-05-11-switchyard-phase-0-1-gap-spec.md`
- `docs/superpowers/plans/2026-05-11-switchyard-phase-0-1-gap-implementation-plan.md`

## Verdict

Not fully covered yet.

The Phase 0/1 gap spec and implementation plan cover the main gaps from the previous review, but they do not fully close the master Phase 0/1 plan. The current plan should be revised before implementation starts.

## Coverage Matrix

| Requirement | Current Plan Coverage | Status |
|---|---:|---|
| Phase 0.1 workspace scaffold | Existing implementation, no new work needed | Covered |
| Phase 0.2 contract package | Existing implementation, but required-field negative coverage is thin | Partial |
| Phase 0.3 explicit service shell files | Task 1 | Covered |
| Phase 0.3 repository interfaces including placement decisions | Existing `PolicyPort`, but no placement-decision store | Partial |
| Phase 0.4 reusable adapter contract test | Task 1 | Covered |
| Phase 1.1 run service lifecycle | Existing tests plus Task 5 | Covered |
| Phase 1.2 SQLite schema for runs/events/artifacts/messages/approvals/registry records | Tasks 2-3 cover runs/events/sessions/artifacts only | Gap |
| Phase 1.2 filesystem artifact store | Task 4 creates a content store, but daemon/runtime never uses it | Gap |
| Phase 1.2 persistence across re-instantiation | Task 3 covers runs/events/sessions/artifacts only | Partial |
| Phase 1.3 REST run routes | Task 6 | Covered |
| Phase 1.3 artifact routes | Task 6 adds `GET /runs/:id/artifacts` inside run routes | Partial |
| Phase 1.3 registry routes | Not planned | Gap |
| Phase 1.3 protocol-sse package | Plan adds `packages/protocol-rest/src/sse.ts`, not `packages/protocol-sse` | Gap |
| Phase 1.3 stored and live events | Plan formats replay, but does not implement a live stream subscription path | Gap |
| Phase 1.4 daemon SQLite/filesystem wiring | Task 7 | Partial |
| Phase 1.4 smoke test for completed artifact | Task 7 lists artifact metadata, but does not verify artifact file content | Partial |
| Public API returns run id immediately | Task 6 adds async path | Partial |
| README fake-run compatibility | Plan changes route behavior but does not update README curl to use `wait=1` or keep default compatibility | Gap |

## Specific Defects In The Current Plan

1. `InMemoryArtifactStore` is referenced in Task 7 but never added to `@switchyard/testkit` or imported.
2. `FilesystemArtifactContentStore` is constructed and discarded in daemon wiring; no service writes fake transcript content to disk.
3. Runtime artifact collection stores metadata only. It does not persist content, so "filesystem artifacts" are not actually fulfilled.
4. `GET /runs/:id/events` remains replay-only in the plan. The `EventBus` is introduced, but route code does not subscribe and stream new events.
5. `POST /runs` default behavior changes from `201 completed` to `202 queued`, while README still documents the old completed response. The plan needs an explicit compatibility decision.
6. `packages/protocol-sse` is required by the master plan but not created.
7. `registry-routes.ts` and registry route tests are required by the master Phase 1.3 file list but not planned.
8. SQLite storage omits `messages`, `approvals`, and `registry records`, which the master Phase 1.2 schema explicitly includes.
9. Contract tests do not yet satisfy "failing tests for every schema's required fields"; the gap plan does not add that coverage.
10. Placement decision persistence is ambiguous: the core has `PolicyPort`, but the master Phase 0.3 says repository interfaces should include placement decisions.

## Required Plan Revisions Before Execution

1. Add a Phase 0 contract coverage task for required-field negative tests across all contract schemas.
2. Add a core placement decision store interface or explicitly mark it deferred with rationale.
3. Add `InMemoryArtifactStore` to `@switchyard/testkit`.
4. Expand `@switchyard/storage` schema and stores to include messages, approvals, providers, runtimes, and models.
5. Add persistence tests for messages, approvals, providers, runtimes, and models.
6. Add a real artifact content write path for fake runtime transcripts.
7. Add `packages/protocol-sse` with replay plus live stream helper.
8. Update REST routes to use the protocol-sse helper for replay/live events.
9. Add registry routes and tests for providers, runtimes, and models.
10. Decide and document `POST /runs` compatibility:
    - Keep default `wait=1` behavior for fake/local README compatibility, or
    - Update README and tests to expect `202 queued` by default.
11. Add smoke coverage that verifies artifact metadata and artifact file content.

## Recommendation

Revise the gap spec and implementation plan before writing code. The complete option is to close all listed gaps now because each one is still a Phase 0/1 lake, not a Phase 2 ocean.
