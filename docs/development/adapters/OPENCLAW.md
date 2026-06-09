# OpenClaw Adapter Local Development

This guide is for the initial `openclaw.async_rest` adapter scaffold.

## Current Boundary

Shipped in this slice:

- Runtime adapter manifest for `openclaw.async_rest`.
- Operator-configured HTTP health check against `SWITCHYARD_OPENCLAW_BASE_URL`.
- API-key header support when an adapter instance is constructed with `apiKey`.
- Compatibility-matrix coverage.
- Safe start denial until OpenClaw run/status/event fixtures verify the upstream contract.

Not shipped in this slice:

- Real OpenClaw run creation.
- Event/status/artifact mapping.
- Hosted OpenClaw execution.
- Per-run OpenClaw URL/auth overrides.
- Runtime input, approval bridge, or cancellation.

## Check

The scaffold checks `GET /health` on the configured base URL.

Expected reason codes:

- `openclaw_config_missing`: no base URL configured.
- `openclaw_config_invalid`: base URL is invalid or not HTTP(S).
- `openclaw_health_unavailable`: health request failed or returned non-2xx.
- `openclaw_health_invalid`: health returned invalid JSON.
- `openclaw_health_too_large`: health response exceeded bounds.
- `openclaw_api_boundary_unverified`: health is reachable but execution remains blocked pending fixtures.

## Verification Needed Before Execution

- Verify the stable OpenClaw run creation/status/events/artifacts API.
- Add fake OpenClaw server fixtures for no-spend tests.
- Normalize OpenClaw events into Switchyard event records.
- Preserve wrapper transcripts/artifacts.
- Add daemon registry seeding only after fake/no-spend run execution passes.
