# Module Coverage Audit

Date: 2026-05-11

This audit checks the Switchyard architecture diagram against the current spec and master implementation plan.

## Result

The initial plan covered the main runtime gateway shape, but four areas were under-specified:

- Context Builder
- Session Store / runtime session management
- Event Bus as distinct from event persistence
- Evidence handling as a first-class debate/research module

The spec and master plan now represent these as explicit modules.

## Diagram Coverage

| Diagram block | Planned module/package | Status |
|---|---|---|
| Client/App Layer | REST, SSE, WebSocket, acpx, SDK, CLI | Covered |
| Public Gateway API | `packages/protocol-rest`, `protocol-sse`, `protocol-ws`, `protocol-acpx` | Covered |
| Run Manager | `packages/core/src/services/run-service.ts` | Covered |
| Debate / Deliberation Manager | `packages/core/src/services/debate-service.ts` | Covered |
| Provider / Model Registry | `registry-service`, `registry-store`, registry contracts | Covered |
| Runtime Registry | `registry-service`, runtime adapter metadata, doctor routes | Covered |
| Event Bus | `event-bus`, `event-service`, `event-store`, SSE/WS fanout | Covered |
| Session Store | `session-service`, `session-store`, runtime session contracts | Covered |
| Debate Store | `debate-store`, debate contracts | Covered |
| Message Router | `message-router`, `message-store`, message contracts | Covered |
| Tool Router | `tool-router`, `tool-adapter`, tool contracts, tool policy | Covered |
| Context Builder | `context-builder`, `context-source`, context packet contracts | Covered |
| Approval / Policy Layer | `approval-service`, `approval-store`, `packages/policy` | Covered |
| Memory Layer | `memory-service`, `memory-store`, memory contracts | Covered |
| Artifact Manager | `artifact-service`, `artifact-store`, artifact contracts | Covered |
| Runtime Registry | `registry-service`, adapter package metadata | Covered |
| Runtime Adapter Layer | `packages/adapters`, `runtime-adapter`, adapter target folders | Covered |
| Direct Runtime Targets | OpenCode, Claude Code, Codex, Cursor, Browser/Search folders | Covered |
| Wrapper Runtime Targets | OpenClaw, Paperclip, AgentField, Generic HTTP folders | Covered |
| Inter-provider Communication | `message-router`, channels, handoffs, delivery receipts | Covered |
| Same-provider Model Debate | `debate-service`, participant/model contracts | Covered |
| Debate Evidence Handling | `evidence-service`, `evidence-store`, evidence contracts | Covered |
| Local Storage | SQLite and filesystem storage packages | Covered |
| Hosted Storage | Postgres, Redis/BullMQ, S3/R2 storage packages | Covered |
| Hybrid Connectivity | `node-store`, connected node contracts, Phase 8 | Covered |

## Notes

`registry-service` intentionally covers both provider/model registry and runtime registry. These can split later if the code grows too large, but they share capability metadata and doctor results in the first implementation.

`event-service` and `event-bus` are separate. The event service owns validation, sequencing, persistence, and replay. The event bus owns live publication to SSE, WebSocket, workers, debate orchestration, approvals, artifacts, and memory extraction.

`context-builder` is a core service because every protocol and adapter needs consistent context packets. It owns task prompts, debate prompts, participant role prompts, provider/model-specific formatting, repo context, memory injection, skill injection, evidence injection, runtime-specific formatting, and approval instructions.
