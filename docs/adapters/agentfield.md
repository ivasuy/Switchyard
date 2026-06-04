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

Implemented as local wrapper runtime mode `agentfield.async_rest`.

R24 hosted debate boundary:

- AgentField hosted debate bridges are unshipped.
- AgentField hosted input/approval bridges are unshipped.
- AgentField remains outside the R24 hosted debate participant allowlist.
- Public model judge routes, browser automation, generic process/PTY adapters, dashboard/TUI surfaces, and managed SaaS remain unshipped.
