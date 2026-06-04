# AgentField Adapter

## Target

AgentField should be treated as a wrapper/runtime target that can execute async reasoner workflows and report results back to Switchyard.

## Preferred Protocol

- Primary: async REST execution flow.
- Secondary: CLI-backed integration for local verification.

## Verified Local Facts

- CLI: `/Users/vasuyadav/.agentfield/bin/af`
- Version: `0.1.77`
- CLI help and async REST shape were checked.

## Implementation Notes

- Map create-execution, poll/status, result, and failure to Switchyard run events.
- Treat AgentField as a wrapper runtime, not as Switchyard's own control plane.
- Preserve execution metadata and result payloads as artifacts.

## Status

Implemented as wrapper runtime mode `agentfield.async_rest`.

R25 hosted wrapper boundary:

- Local and hosted runs use daemon/operator-configured AgentField base URL, API key, and target only.
- Hosted input/approval bridges are conditional through the existing hosted runtime bridge and public `POST /runs/:id/input` plus approval list/get/approve/reject routes.
- Hosted debate participants are allowed only through the existing `/debates` route family with hosted placement, `realRuntimeOptIn`, provider activation/spend gates, wrapper config/capability checks, bridge readiness, durable command/payload stores, queue/outbox, object store, ownership, quota, audit, and worker readiness.
- Per-run AgentField URL, target, endpoint, or auth overrides are not shipped.
- Arbitrary AgentField endpoint execution is not shipped.
- Public model judge routes, browser automation, generic process/PTY adapters, dashboard/TUI surfaces, and managed SaaS remain unshipped.
