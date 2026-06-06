# Paperclip Adapter Local Development

This guide is for the initial `paperclip.async_rest` adapter scaffold.

## Current Boundary

Shipped in this slice:

- Runtime adapter manifest for `paperclip.async_rest`.
- Operator-configured HTTP health check against `SWITCHYARD_PAPERCLIP_BASE_URL`.
- API-key header support when an adapter instance is constructed with `apiKey`.
- Compatibility-matrix coverage.
- Safe start denial until Paperclip run/status/event fixtures verify the upstream contract.

Not shipped in this slice:

- Real Paperclip run creation.
- Event/status/artifact mapping.
- Hosted Paperclip execution.
- Per-run Paperclip URL/auth overrides.
- Runtime input, approval bridge, or cancellation.

## Check

The scaffold checks `GET /health` on the configured base URL.

Expected reason codes:

- `paperclip_config_missing`: no base URL configured.
- `paperclip_config_invalid`: base URL is invalid or not HTTP(S).
- `paperclip_health_unavailable`: health request failed or returned non-2xx.
- `paperclip_health_invalid`: health returned invalid JSON.
- `paperclip_health_too_large`: health response exceeded bounds.
- `paperclip_api_boundary_unverified`: health is reachable but execution remains blocked pending fixtures.

## Verification Needed Before Execution

- Verify the stable Paperclip run creation/status/events/artifacts API or source boundary.
- Add fake Paperclip server fixtures for no-spend tests.
- Normalize Paperclip events into Switchyard event records.
- Preserve wrapper transcripts/artifacts.
- Add daemon registry seeding only after fake/no-spend run execution passes.
