# Generic HTTP Adapter

## Target

Generic HTTP lets Switchyard integrate custom agents and wrappers that expose run/status/events-style APIs.

## Preferred Protocol

- HTTP create/status/events/cancel/artifacts endpoints.
- Polling-based async REST lifecycle in R4.

## Shipped Contract (`generic_http.async_rest`)

- Start remote execution with `POST /v1/runs`.
- Poll events with `GET /v1/runs/:id/events` and cursor/dedupe fallback.
- Poll terminal status with `GET /v1/runs/:id` when events are empty or `terminal=true` without terminal event.
- Cancel execution with verified-terminal semantics (`POST /v1/runs/:id/cancel` + terminal status verification).
- Collect artifacts and transcript with `GET /v1/runs/:id/artifacts`.
- Bridge post-start input only to configured wrappers that advertise the R25 input capability.
- Bridge runtime approval resolution only to configured wrappers that advertise the R25 approval request/resolution capabilities.

## Runtime Constraints

- Base URL and auth token are daemon-configured only.
- Per-run endpoint overrides are out of scope.
- Per-run auth token/base URL overrides are out of scope.
- Arbitrary wrapper endpoint execution is out of scope.
- Webhook callbacks are out of scope.

## Development Guide

- Canonical implementation/debugging reference: `docs/development/adapters/GENERIC_HTTP.md`.

## Status

Implemented as wrapper runtime mode `generic_http.async_rest`.

R25 hosted wrapper boundary:

- Hosted input/approval bridges are conditional through the existing hosted runtime bridge and public `POST /runs/:id/input` plus approval list/get/approve/reject routes.
- Hosted debate participants are allowed only through the existing `/debates` route family with hosted placement, `realRuntimeOptIn`, provider activation/spend gates, wrapper config/capability checks, bridge readiness, durable command/payload stores, queue/outbox, object store, ownership, quota, audit, and worker readiness.
- Hosted active cancel bridge is not shipped.
- Public model judge routes, browser automation, generic process/PTY adapters, dashboard/TUI surfaces, and managed SaaS remain unshipped.
