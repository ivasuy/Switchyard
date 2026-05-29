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
- Reject post-start input in R4 (`adapter_protocol_failed`, reason `generic_http_input_unsupported`).

## Runtime Constraints

- Base URL and auth token are daemon-configured only.
- Per-run endpoint overrides are out of scope.
- Webhook callbacks are out of scope.

## Development Guide

- Canonical implementation/debugging reference: `docs/development/adapters/GENERIC_HTTP.md`.

## Status

Implemented local slice in R4 as runtime mode `generic_http.async_rest`.
