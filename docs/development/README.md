# Development Documentation

This directory is the local developer center for Switchyard. Start here when you need to know what the app can do today.

## Read In This Order

1. [Product Truth](../../PRODUCT.md): current shipped surface, release roadmap, and owner-facing release checklist.
2. [Official API Contract](API.md): implemented HTTP endpoints, request bodies, response shapes, event semantics, and current limitations.
3. [Local Development](DEVELOPMENT.md): install, start the daemon, health checks, local storage, process checks, and verification commands.
4. [Codex Adapter Local Development](adapters/CODEX.md): Codex-specific metadata, healthy log shape, PID checks, and stuck-run diagnosis.
5. [Architecture](../../ARCHITECTURE.md): repo structure, runtime structure, package responsibilities, and current deployment boundaries.

## Current Developer Surface

Today an app can:

- Start local runs with `POST /runs`.
- Start and wait for synchronous fake/one-shot runs with `POST /runs?wait=1`.
- Use shipped local runtime modes: `fake.deterministic`, `codex.exec_json`, explicit local-only `codex.interactive`, `claude_code.sdk`, `opencode.acp`, `agentfield.async_rest`, and `generic_http.async_rest`.
- Read the final answer from `response.text` when the selected adapter emits one.
- List runs with `GET /runs`.
- Inspect full run events with `GET /runs/:id`.
- Replay and stream SSE-formatted run events with `GET /runs/:id/events`.
- Fetch transcript artifacts with `GET /runs/:id/artifacts`.
- Fetch artifact metadata and content with `GET /artifacts/:id` and `GET /artifacts/:id/content`.
- Send supported post-start input with `POST /runs/:id/input`.
- Cancel a run with `POST /runs/:id/cancel`.
- Check provider, runtime, model, runtime-mode, and doctor records.
- Use local middleware APIs for messages, memory, evidence, context packets, approvals, and tool invocations.
- Run fake deterministic debates locally or through the hosted-safe `/debates` route family.
- Use the SDK and CLI for no-spend local workflows.

Today an app cannot yet:

- Use a full trace endpoint.
- Use dashboard or TUI surfaces.
- Use public arbitrary `/exec`, `/shell`, `/process`, `/command`, `/pty`, `/terminal`, or `/sandbox` routes.
- Use hosted `codex.interactive`.
- Use generic process/PTY product adapters.
- Execute Cursor, OpenClaw, or Paperclip runs; current adapter scaffolds are manifest/check only.
- Use hosted browser automation or hosted `repo` execution.
- Use a public model judge route.
- Use managed SaaS signup, payment-provider billing, OAuth/OIDC/SAML/SSO/SCIM, or tenant self-service UI.

## Document Ownership

- `PRODUCT.md` is the owner-facing product truth and release roadmap.
- `README.md` is product-facing.
- `ARCHITECTURE.md` is the centralized system architecture and repo/runtime structure reference.
- `docs/development/API.md` is the centralized app-facing API contract.
- `docs/development/DEVELOPMENT.md` is the centralized local operations guide.
- `docs/development/adapters/` contains runtime-specific debugging notes only.
