# Switchyard Production Manifest Pack (R19)

This directory contains a provider-neutral production example for the hosted server, hosted worker, and optional connected node. It is intentionally API/ops-only and keeps production hosted runtime execution fake-only (`fake.deterministic`).

The worker service uses the currently available built entrypoint (`node apps/worker/dist/main.js`). The R19 P18-T4 worker readiness task owns the startup/claim gate that must fail before queue claiming.

## Included Files

- `docker-compose.yml`: production-shaped compose example with built entrypoints and runtime checks.
- `manifest.json`: machine-readable manifest consumed by production preflight checks.
- `.env.example`: required production variables with intentionally invalid placeholders.
- `bootstrap.example.json`: control-plane bootstrap example with fake-only runtime plan and placeholder `rawKey`/node token values.

## Production Dependency Requirements

Bring your own production-grade dependencies:

- Postgres (required for control plane and run/event/artifact metadata).
- Redis (required for hosted queue claim/ack).
- Object storage (required for artifact content store and probe).

The compose file keeps Postgres/Redis private and does not expose their ports publicly. Replace these containers with managed services as needed.

## Secret and Placeholder Policy

All placeholders in `.env.example` and `bootstrap.example.json` are intentionally invalid (`replace-with-*`). Production startup/preflight must reject these values.

Generate unique high-entropy values for at least:

- `SWITCHYARD_API_KEY_PEPPER`
- `SWITCHYARD_NODE_SHARED_TOKEN`
- Postgres/Redis credentials
- Object-store credentials
- Bootstrap API key and node token records

## Runtime Boundary (R19)

Production runtime policy is fake-only:

- `SWITCHYARD_HOSTED_RUNTIME_ALLOWLIST=fake.deterministic`
- `SWITCHYARD_HOSTED_REAL_RUNTIME_EXECUTION=disabled`

Do not enable hosted real runtime modes in this phase.

## Rollout Order

1. Build and publish server/worker/node images with compiled `dist` entrypoints.
2. Copy `.env.example` to `.env` and replace every `replace-with-*` value.
3. Prepare bootstrap JSON from `bootstrap.example.json` and mount it as `SWITCHYARD_CONTROL_PLANE_BOOTSTRAP_PATH`.
4. Run preflight:
   - `pnpm tsx scripts/production-preflight.ts --env-file deploy/production/.env`
5. Run migrations:
   - `pnpm tsx scripts/production-migrate.ts --env-file deploy/production/.env`
6. Deploy server and wait for `/health` success.
7. Verify readiness gate:
   - `docker compose -f deploy/production/docker-compose.yml --profile ops-check run --rm server-ready`
8. Deploy worker.
9. Optionally deploy node:
   - `docker compose -f deploy/production/docker-compose.yml --profile optional-node up -d node`
10. Run canary:
    - `pnpm tsx scripts/production-canary.ts --base-url https://replace-with-public-server-url --api-key replace-with-operator-api-key`

## Rollback Order

1. Pause worker to stop new queue claims.
2. Roll server image back to last known-good release.
3. Re-run readiness checks; if schema mismatch appears, keep traffic blocked until compatible code is restored.
4. Roll worker image back after server readiness is green.
5. Keep canary and readiness evidence records; do not delete them.

## Readiness and Metrics Interpretation

- `/health`: liveness only.
- `/ready`: dependency + control-plane + schema + queue + object-store + runtime gate.
- `/metrics`: must be accessed with API key that includes both `metrics:read` and `admin:read`.

## Canary Record Retention

Canary runs are expected durable evidence in production. Query them by canary metadata/tag and retain them for audit and rollback diagnostics.

## CI/Audit Boundary

CI/audit verification for this pack must remain no-spend and deterministic. Live provider checks are operator-owned and should run only against operator-managed environments.
