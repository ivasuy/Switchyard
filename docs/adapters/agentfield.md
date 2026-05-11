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

Good early wrapper adapter candidate after Generic HTTP exists.
