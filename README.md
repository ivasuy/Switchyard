<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-wordmark.svg">
    <img alt="Switchyard" src="docs/assets/logo-wordmark.svg" width="520">
  </picture>
</p>

Switchyard is a runtime gateway that exposes multiple agent runtimes and wrappers as one unified backend API.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-runtime-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/Fastify-API-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![Zod](https://img.shields.io/badge/Zod-contracts-3E67B1)](https://zod.dev/)
[![Postgres](https://img.shields.io/badge/Postgres-hosted_storage-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![SQLite](https://img.shields.io/badge/SQLite-local_storage-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![Redis](https://img.shields.io/badge/Redis-queues-DC382D?logo=redis&logoColor=white)](https://redis.io/)
[![pnpm](https://img.shields.io/badge/pnpm-workspaces-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

Instead of integrating separately with shipped runtime interfaces (Claude Code, Codex, OpenCode, AgentField, and Generic HTTP wrappers), applications integrate once with Switchyard.

```text
POST /runs
GET  /runs/:id
GET  /runs/:id/events
GET  /metrics
POST /debates
POST /runs/:id/approve
GET  /runs/:id/artifacts
GET  /artifacts/:id
GET  /artifacts/:id/content
```

R11 adds a shipped local TypeScript SDK (`@switchyard/sdk`), a shipped local CLI (`@switchyard/cli`), deterministic OpenAPI export/check under `@switchyard/contracts`, and startup/metrics hardening for local operations.

R18 adds the shipped API-first enterprise control-plane foundation for hosted/server APIs: API key auth, tenant/project ownership, plan/entitlement/quota contracts, audit events, hosted OpenAPI surface generation, and fail-closed staging/production readiness checks.

R19 ships production hosted deployment readiness for the existing safe hosted boundary: provider-neutral production manifests, explicit `production:preflight` and `production:migrate` gates, rollout/rollback runbook gates, API-key-protected hosted `/metrics`, named readiness/schema failure codes, and a deterministic no-spend `production:canary` flow (`fake.deterministic` only). This is self-hosted/managed-hosting-ready operability work, not a managed hosted platform or public tenant self-service launch.

R22 ships hosted/connected-node real-tool execution with policy-first controls for an exact boundary:

- hosted worker tools: `fetch`, `web_search`, `github`, command-catalog `shell`
- connected-node tools: `fetch`, `web_search`, `github`, `repo`, command-catalog `shell`

Production fake-only/no-spend remains the default posture for tests, smoke, preflight, and default canary.

R23 adds hosted runtime bridge support only for worker-owned `claude_code.sdk` and structured `opencode.acp` through existing `POST /runs/:id/input` and hosted approval resolution routes. Usable hosted bridges require shared Postgres-backed hosted runtime bridge command and payload stores across server and worker. Missing bridge command/payload stores fail closed in preflight/readiness/admission with named bridge-store errors (for example `hosted_runtime_bridge_store_unavailable`). Stale claimed non-idempotent provider input after worker crash is not blindly retried and fails closed with `hosted_runtime_bridge_non_idempotent_retry_blocked`. `codex.exec_json` remains one-shot with hosted input/approval unsupported. `codex.interactive` remains local-only and unshipped for hosted.

R23 boundary non-goals remain explicit:

- does not ship generic process/pty runtime adapters.
- does not ship cursor/openclaw/paperclip.
- does not ship hosted browser automation.
- does not ship hosted `repo` execution.
- does not ship hosted debate real participants or hosted model judging.
- does not ship any public arbitrary execution route (`/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, `/sandbox`).
- does not ship hosted `codex.interactive`.
- does not ship hosted Codex live-resume guarantees.
- does not ship hosted AgentField/Generic HTTP input or approval bridges.
- does not ship hosted terminal bridge, PTY/TUI automation, or dashboard/TUI surfaces.
- no managed SaaS/public signup, no payment-provider integration (invoices/checkout/webhooks), no OAuth/OIDC/SAML/SSO/SCIM, no dashboard, and no TUI.

Switchyard lets frontends, backends, CLIs, automations, bots, and internal systems treat every agent runtime like a backend service.

## Problem

Agent runtimes are becoming the worker layer for software work, research, automation, review, debugging, and multi-agent reasoning. The problem is that every runtime exposes a different interface:

- Some expose native APIs.
- Some speak ACP/acpx.
- Some are HTTP wrappers.
- Some are CLIs.
- Some require an interactive PTY.
- Some can run hosted.
- Some must run locally because they depend on local credentials, local repos, or local filesystem access.

Without a gateway, every application has to solve the same hard problems repeatedly:

- Starting and cancelling runtime sessions.
- Streaming output.
- Normalizing tool calls and results.
- Routing messages between agents.
- Handling human approvals.
- Storing transcripts, diffs, logs, screenshots, evidence, and final reports.
- Deciding whether work should run locally, hosted, or through a connected local node.
- Supporting multi-agent and multi-model debate without infinite loops.
- Hiding runtime-specific details from product code.

Switchyard exists to make that a platform concern instead of an application concern.

## What Switchyard Is

Switchyard is a deploy-anywhere agent runtime gateway.

It provides:

- One API for many runtimes.
- One event model for many output formats.
- One adapter contract for native APIs, acpx, HTTP, subprocess, and PTY.
- One debate engine for cross-provider and same-provider multi-model deliberation.
- One artifact model for transcripts, diffs, logs, screenshots, evidence packs, and proof reports.
- One approval and policy layer for risky actions.
- One placement layer for local, hosted, and hybrid execution.

Switchyard is not another agent framework. Runtimes do the actual work. Switchyard manages the work.

## One-Line Explanation

```text
Switchyard is a runtime gateway that exposes multiple agent runtimes and wrappers as one unified backend API.
```

## Mental Model

```text
Agent runtimes are workers.

Switchyard is the switchboard.

Apps call Switchyard.

Switchyard routes work to the right runtime,
streams events back,
lets runtimes communicate,
stores proof/artifacts,
and controls risky actions with approvals.
```

## Who Uses It

Switchyard is designed for:

- Web dashboards that need to run agent sessions.
- SaaS backends that want agent execution as an internal service.
- CLI tools that want a stable run/debate API.
- GitHub bots and CI pipelines.
- Developer automation tools.
- Research systems that compare multiple models.
- Internal ops tools that need approvals and audit trails.
- Teams that want hosted orchestration with local execution nodes.

Clients do not need to know how Claude Code, Codex, OpenCode, AgentField, or other integrated runtimes work internally. They only call Switchyard.

## Core API Surface

Switchyard exposes product-level endpoints:

```text
/runs
/debates
/runtimes
/models
/providers
/memory
/tools
/artifacts (planned, not implemented in local MVP)
/approvals
```

### Runs

A run is a single task executed by one runtime.

Example:

```json
{
  "runtime": "codex",
  "model": "gpt-5.5",
  "task": "Fix issue #123",
  "cwd": "/repo"
}
```

The client creates the run, streams events, sends input if needed, approves or rejects risky actions, and fetches artifacts when the run completes.

### Debates

A debate is a bounded multi-agent or multi-model discussion.

Example:

```json
{
  "topic": "Should we use JWT or sessions?",
  "participants": [
    {"provider": "claude", "model": "opus", "role": "architect"},
    {"provider": "codex", "model": "gpt-5.5", "role": "skeptic"},
    {"provider": "codex", "model": "gpt-5.3", "role": "implementer"}
  ]
}
```

Debates have hard limits: max rounds, max turns, max messages, max duration, max cost, tool/search budgets, and stop conditions. Unresolved disagreement is allowed.

### Registry

The registry tracks available runtimes, providers, models, adapters, and health state.

Example registry facts:

```text
Claude Code available: yes
Codex available: yes
OpenClaw URL configured: not shipped in R22
AgentField URL configured: yes
Paperclip adapter configured: not shipped in R22
```

The registry is also used by placement policy to decide where and how work should run.

## Runtime Targets

Switchyard is designed to normalize direct runtimes and wrapper runtimes.

Shipped runtime interfaces:

- Claude Code
- Codex CLI
- OpenCode
- AgentField async REST wrapper
- Generic HTTP async REST wrapper

Not shipped in R22:

- Cursor
- OpenClaw
- Paperclip
- Hosted browser automation
- Hosted `repo` tool execution

Switchyard treats them through the same lifecycle:

```text
check
start
send input
stream events
cancel
collect artifacts
```

## Developer Documentation

Local setup, test commands, prebuilt curl requests, PID checks, SQLite inspection, and Codex debugging live outside this product README:

- [Product truth and release roadmap](PRODUCT.md)
- [Development docs](docs/development/)
- [Adapter local debugging guides](docs/development/adapters/)

## SDK And CLI Quickstart

Install workspace dependencies:

```bash
pnpm install
```

SDK usage:

```ts
import { SwitchyardClient } from "@switchyard/sdk";

const client = new SwitchyardClient({ baseUrl: "http://127.0.0.1:4545" });
const created = await client.createRun(
  {
    runtime: "fake",
    provider: "test",
    model: "test-model",
    adapterType: "process",
    cwd: "/repo",
    task: "sdk smoke",
    timeoutSeconds: 30
  },
  { wait: true }
);
console.log(created.run.status);
```

CLI usage:

```bash
pnpm --filter @switchyard/cli exec switchyard doctor --base-url http://127.0.0.1:4545
pnpm --filter @switchyard/cli exec switchyard run fake --wait --base-url http://127.0.0.1:4545
pnpm --filter @switchyard/cli exec switchyard runtime test
pnpm --filter @switchyard/cli exec switchyard contract export --output ./openapi.local-daemon.json
pnpm --filter @switchyard/cli exec switchyard debug run <run_id> --base-url http://127.0.0.1:4545
```

## Deployment Modes

Switchyard is designed to run locally, hosted, or hybrid with the same API semantics.

### Local Mode

```text
App
 │
 ▼
Switchyard Local Gateway
 │
 ├── Local CLI runtimes
 │   ├── Claude Code
 │   ├── Codex
 │   └── OpenCode
 │
 ├── Local PTY sessions
 ├── Local HTTP wrappers
 └── Local acpx runtimes

Storage:
  SQLite + files
```

Best for developers, private repo automation, local credentials, and single-user setups.

### Hosted Mode

```text
App
 │
 ▼
Switchyard Hosted Gateway
 │
 ▼
Workers
 │
 └── fake.deterministic (shipped hosted-safe runtime)

Storage:
  Postgres + Redis/BullMQ + local object volume or S3/R2-compatible object store
```

Best for teams that need hosted orchestration while keeping the shipped hosted execution boundary fake-only.

### Hybrid Mode

```text
App
 │
 ▼
Hosted Switchyard
 │
 ├── shared state
 ├── users/orgs
 ├── approvals
 ├── dashboards
 └── cloud workflows
 │
 ▼
Local Switchyard Node
 │
 ├── Claude Code
 ├── Codex
 ├── OpenCode
 ├── local repo
 ├── local shell
 └── PTY sessions

Shared:
  state
  events
  artifacts
  approvals
```

Best for team UI plus local execution, private repositories, local credentials, developer workstation agents, and enterprise setups.

## Why Switchyard Matters

The runtime ecosystem is fragmented. Some tools are best at coding, some are best at research, some are wrappers around internal company workflows, and some are local-only. Applications should not be coupled to those differences.

Switchyard creates a stable backend boundary:

- Product teams build against Switchyard.
- Runtime teams can add adapters behind Switchyard.
- Users can choose local, hosted, or hybrid deployment.
- Agents can communicate through Switchyard instead of ad hoc integrations.
- Debates and reviews can be bounded, auditable, and artifact-backed.

The separation is the product:

```text
Runtime does the work.
Switchyard manages the work.
Adapters normalize every runtime.
The event bus preserves visibility.
The message router enables agent-to-agent coordination.
The policy layer controls risk.
The artifact manager preserves proof.
```
