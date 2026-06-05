# Phase 12 Spec: R13 S3/R2 Network Object Store Client Wiring

**Date:** 2026-05-30
**Run:** post-r11-remaining-20260530
**Branch:** `agent/phase-12-r13-s3-r2-object-store-client`
**Base:** Phase 11/R12 closed at `6a09d4e`
**Spec target:** `docs/superpowers/specs/2026-05-30-phase-12-r13-s3-r2-object-store-client.md`

## Problem

R12 made the fake-only hosted slice self-hostable, but artifact content still depends on memory or a shared local object-volume path. That blocks realistic hosted/server-worker deployments because the server and worker must co-mount the same filesystem to write and read transcript/result artifacts.

R13 should wire a real S3-compatible object-store client for artifact content while preserving the current safety boundary: hosted runtime execution remains fake-only, no arbitrary hosted subprocess or PTY execution ships, and normal CI must not require AWS, R2, MinIO, paid network services, or external credentials.

## Goals

- Add a real S3-compatible artifact content client in `packages/storage` and wire it through the existing `ObjectArtifactContentStore`.
- Support AWS S3 and Cloudflare R2-style endpoints through explicit config, including endpoint, region, bucket, credentials, key prefix, request timeout, and path-style behavior.
- Wire the network object backend into `apps/server` and `apps/worker` without changing public artifact routes or run APIs.
- Keep local/test defaults deterministic and no-spend: memory and local object-volume backends remain available; normal CI uses fake clients or a deterministic fake S3-compatible server.
- Preserve existing artifact content behavior: `GET /runs/:id/artifacts`, `GET /artifacts/:id`, and `GET /artifacts/:id/content` continue to work for hosted fake runs.
- Add redacted diagnostics for config, readiness, metrics, and startup failures without exposing access keys, secret keys, signed headers, request bodies, object content, or full credential-bearing endpoints.
- Add named failure modes for config, network, auth, bucket, read/write, missing content, digest mismatch, timeout, and unavailable object-store states.
- Keep R13 product docs honest: S3/R2 network object-store client wiring becomes shipped; hosted real runtimes, managed hosted platform, enterprise controls, dashboard/TUI, broad adapters, and real tools remain unshipped.

## Non-Goals

- No managed hosted platform deployment.
- No hosted arbitrary subprocess execution.
- No hosted PTY execution.
- No hosted Codex, Claude Code, OpenCode, Generic HTTP, AgentField, Cursor, OpenClaw, Paperclip, browser, search, shell, fetch, GitHub, repo, generic process, or generic PTY adapters.
- No real shell/browser/search/GitHub/fetch/repo tool execution.
- No interactive Codex runtime promotion, Codex session resume, Codex approval bridge, or runtime-specific approval bridges.
- No hosted debate with real participant runtimes or model judging.
- No enterprise organizations, OAuth, SSO, RBAC, billing, quotas, tenant controls, or multi-tenant authorization changes.
- No dashboard, TUI, or broad visual monitoring surface.
- No presigned direct upload/download URLs.
- No HTTP `HEAD` or `Range` artifact-content support.
- No bucket creation, bucket policy management, lifecycle rule management, object lock, CDN integration, or provider-side encryption/KMS automation. Operators may configure those at the provider level.
- No required external network spend in normal CI.

## Current Truth

R13 starts from the R12 phase branch where the product truth explicitly says S3/R2 network storage is not yet shipped.

`PRODUCT.md` currently lists S3/R2 as not existing:

```md
- S3/R2 network object storage backing. R12 ships a shared local object-volume backend for self-hosted smoke; real S3/R2 clients remain unwired.
```

`PROJECT.md` Phase 11 records the shipped R12 boundary:

```md
The shipped boundary remains explicit: R12 does not ship managed hosted deployment, hosted Codex/Claude/OpenCode execution, arbitrary hosted subprocess/PTY execution, S3/R2 network object-store clients, enterprise auth/billing/tenant controls, broad adapters/tools, hosted real-runtime debate/model judging, dashboard, or TUI.
```

The storage package already has an S3/R2-shaped store, but it only accepts an injected client. There is no real network client factory or app config wiring yet.

`packages/storage/src/object-artifact-content-store.ts`:

```ts
export interface ObjectArtifactContentStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  keyPrefix?: string;
}

interface ObjectClient {
  putObject(input: { bucket: string; key: string; body: Buffer; contentType: string }): Promise<void>;
  getObject(input: { bucket: string; key: string }): Promise<{ body: Buffer; contentType?: string }>;
}
```

Server and worker config currently select the local object-volume backend by `SWITCHYARD_OBJECT_STORE_DIR` only.

`apps/server/src/config.ts`:

```ts
const objectStoreDir = optional(env["SWITCHYARD_OBJECT_STORE_DIR"]);
if (objectStoreDir) config.objectStoreDir = objectStoreDir;

if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
  requireVar(config.postgresUrl, "SWITCHYARD_POSTGRES_URL", config);
  requireVar(config.redisUrl, "SWITCHYARD_REDIS_URL", config);
  requireVar(config.objectStoreDir, "SWITCHYARD_OBJECT_STORE_DIR", config);
}
```

`apps/worker/src/config.ts` has the same local-only object-store requirement:

```ts
const objectStoreDir = optional(env["SWITCHYARD_OBJECT_STORE_DIR"]);
if (objectStoreDir) config.objectStoreDir = objectStoreDir;

if (config.deploymentMode === "staging" || config.deploymentMode === "production") {
  requireVar(config.postgresUrl, "SWITCHYARD_POSTGRES_URL", config);
  requireVar(config.redisUrl, "SWITCHYARD_REDIS_URL", config);
  requireVar(config.objectStoreDir, "SWITCHYARD_OBJECT_STORE_DIR", config);
}
```

The server and worker currently instantiate `LocalObjectArtifactContentStore` when `objectStoreDir` is set, otherwise memory in non-persistent modes.

`apps/server/src/app.ts`:

```ts
const artifactContent: ArtifactContentStore = config.objectStoreDir
  ? new LocalObjectArtifactContentStore(config.objectStoreDir)
  : forcePersistent
    ? (() => {
      throw new Error("config_required:SWITCHYARD_OBJECT_STORE_DIR");
    })()
    : new MemoryArtifactContentStore();
```

The deterministic test coverage proves the object-store abstraction with an injected fake client, not with a real network client.

`packages/storage/test/artifact-content-store.test.ts`:

```ts
const store = new ObjectArtifactContentStore(
  {
    endpoint: "https://example.test",
    region: "auto",
    bucket: "switchyard",
    accessKeyId: "key",
    secretAccessKey: "secret",
    forcePathStyle: true,
    keyPrefix: "artifacts"
  },
  {
    async putObject(input) {
      objects.set(`${input.bucket}/${input.key}`, { body: input.body, contentType: input.contentType });
    },
    async getObject(input) {
      const hit = objects.get(`${input.bucket}/${input.key}`);
      if (!hit) throw new Error("not found");
      return hit;
    }
  }
);
```

The artifact-content route already exposes content through the existing HTTP surface. R13 should not invent a second artifact API.

`packages/protocol-rest/src/artifact-routes.ts`:

```ts
app.get("/artifacts/:id/content", async (request, reply) => {
  const artifact = await deps.artifacts.get(id);
  if (!artifact) {
    return sendHttpError(reply, "artifact_not_found", `Artifact not found: ${id}`);
  }

  const storedFlag = (artifact.metadata as Record<string, unknown> | undefined)?.["contentStored"];
  if (storedFlag === false) {
    return sendHttpError(reply, "missing_artifact_content", `Artifact has no stored content: ${id}`);
  }
```

## Architecture

R13 is an app wiring and storage-client release, not a new runtime release.

`packages/storage` should add a real S3-compatible object client around the AWS SDK v3 S3 primitives. The existing `ObjectArtifactContentStore` remains the artifact-content store shape, but its client should be constructible from explicit Switchyard config instead of only from tests. The real client must use explicit static credentials supplied through Switchyard config; it must not fall back to ambient AWS profiles, default credential provider chains, instance metadata, or unbounded environment discovery.

The server and worker should share one small object-store config parser/factory so their behavior cannot drift. The factory should select one of three backends:

- `memory`: deterministic local/test-only default when no persistent object config is requested.
- `local`: current R12 filesystem-backed object-compatible store selected by `SWITCHYARD_OBJECT_STORE_DIR`.
- `s3-compatible`: new network backend selected by explicit S3/R2 config.

In `staging` and `production`, `SWITCHYARD_OBJECT_STORE_BACKEND` must be explicit and must be either `local` or `s3-compatible`. `memory` is allowed only for `local` and `test`. If `s3-compatible` is selected, endpoint, region, bucket, access key id, and secret access key are required. For AWS S3, operators pass an explicit regional endpoint such as `https://s3.us-east-1.amazonaws.com`. For Cloudflare R2, operators pass their account endpoint and `region=auto`.

Artifact logical paths remain the product model. The backend maps paths like `runs/<runId>/transcript.jsonl` to object keys under the configured prefix. The object key should remain inspectable in artifact metadata, but secrets and signed request details must never be stored in artifact metadata. The write path should preserve `storageBackend`, `objectKey`, `sizeBytes`, `sha256`, and `contentType` in artifact metadata when the artifact content store returns them. This aligns runtime-produced artifacts with the metadata already produced by connected-node artifact sync.

`/ready` should probe the configured object store. For `s3-compatible`, the default probe in staging/production is a bounded write-read-delete probe under `<keyPrefix>/probes/<uuid>`. Local/test may disable network probes for unit tests, but production must fail readiness if object storage cannot be reached, authenticated, written, read, or cleaned up. Metrics remain JSON and low-cardinality; they should count object-store reads, writes, probe failures, auth failures, unavailable states, and digest mismatches without labels containing bucket names, keys, endpoints, or run ids.

## User-Visible Behavior

- Hosted fake run with S3/R2 configured: the operator starts server and worker with `SWITCHYARD_OBJECT_STORE_BACKEND=s3-compatible`; `/ready` reports `objectStore.ok=true`; a `fake.deterministic` hosted run completes; `GET /runs/:id/artifacts` lists the transcript; `GET /artifacts/:id/content` streams the transcript from S3/R2 through Switchyard.
- R2-style config: the operator sets an R2 account endpoint, `SWITCHYARD_OBJECT_STORE_REGION=auto`, bucket, credentials, and key prefix; behavior is the same as S3, with redacted diagnostics showing only backend, sanitized endpoint host, region, bucket presence/name per redaction policy, key prefix, path-style flag, and credential presence.
- Local/test with no object store: existing deterministic memory behavior stays available. Tests and local no-spend development do not contact AWS, R2, or MinIO unless an explicit optional smoke flag is set.
- Local object-volume deployment: existing `SWITCHYARD_OBJECT_STORE_DIR` behavior keeps working when `SWITCHYARD_OBJECT_STORE_BACKEND=local` or when local/test compatibility infers local from the directory.
- Misconfigured staging/production startup: missing backend, endpoint, bucket, region, credentials, or local directory fails fast with a named `config_required:*` or `config_invalid:*` error and a redacted config summary.
- Runtime boundary: hosted server and worker still only run `fake.deterministic`. Attempts to run hosted Codex, Claude, OpenCode, Generic HTTP, AgentField, subprocess, PTY, shell, browser, fetch, GitHub, repo, or real tools remain denied by the existing placement/runtime allowlist behavior.

## Config And Env Contract

### Shared Server/Worker Variables

| Env var | Required when | Allowed values / format | Behavior |
|---|---|---|---|
| `SWITCHYARD_OBJECT_STORE_BACKEND` | Required in `staging`/`production`; optional in `local`/`test` | `memory`, `local`, `s3-compatible` | Selects artifact content backend. `memory` is rejected outside `local`/`test`. |
| `SWITCHYARD_OBJECT_STORE_DIR` | Required when backend is `local` | Absolute or process-relative filesystem path | Existing local object-volume root. Must be readable/writable and path-safe. |
| `SWITCHYARD_OBJECT_STORE_ENDPOINT` | Required when backend is `s3-compatible` | URL | Explicit S3-compatible endpoint. `https` is required in `staging`/`production`; `http://127.0.0.1`, `http://localhost`, and Docker-network HTTP endpoints are allowed only in `local`/`test` or optional MinIO smoke. Userinfo and query strings are invalid. |
| `SWITCHYARD_OBJECT_STORE_REGION` | Required when backend is `s3-compatible` | Non-empty string | AWS regions such as `us-east-1`; R2 uses `auto`. |
| `SWITCHYARD_OBJECT_STORE_BUCKET` | Required when backend is `s3-compatible` | Non-empty bucket name | Target bucket. R13 does not create buckets. |
| `SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID` | Required when backend is `s3-compatible` | Non-empty string | Static access key id. Must be redacted from all diagnostics. |
| `SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY` | Required when backend is `s3-compatible` | Non-empty string | Static secret. Must be redacted from all diagnostics. |
| `SWITCHYARD_OBJECT_STORE_FORCE_PATH_STYLE` | Optional | `0`, `1`, `true`, `false` | Defaults to `true` for MinIO/R2-compatible behavior unless explicitly set. |
| `SWITCHYARD_OBJECT_STORE_KEY_PREFIX` | Optional | Safe relative prefix, default `artifacts` | Prepended to logical artifact paths. Must reject absolute paths, `..`, backslashes, Windows drives, empty segments after normalization, and leading/trailing slash ambiguity. |
| `SWITCHYARD_OBJECT_STORE_REQUEST_TIMEOUT_MS` | Optional | Positive integer, default `5000` | Bound for S3/R2 operations and readiness probes. |
| `SWITCHYARD_OBJECT_STORE_PROBE` | Optional | `write_read_delete`, `disabled` | `write_read_delete` required by default in `staging`/`production`; `disabled` allowed only in `local`/`test`. |

### Compatibility Rules

- Existing R12 local object-volume deployments may continue using `SWITCHYARD_OBJECT_STORE_DIR` in local/test. In staging/production, operators must set `SWITCHYARD_OBJECT_STORE_BACKEND=local` explicitly to avoid silent fallback.
- If both `SWITCHYARD_OBJECT_STORE_BACKEND=s3-compatible` and `SWITCHYARD_OBJECT_STORE_DIR` are set, the S3-compatible backend wins and diagnostics should include a non-secret warning code `object_store_dir_ignored`.
- If backend is unset in local/test and `SWITCHYARD_OBJECT_STORE_DIR` is set, infer `local`.
- If backend is unset in local/test and no directory is set, infer `memory`.
- Server and worker config parsers must produce the same redacted summary fields for object storage.

### Redacted Summary Shape

Redacted config summaries may include:

```json
{
  "objectStore": {
    "backend": "s3-compatible",
    "endpointScheme": "https",
    "endpointHost": "s3.us-east-1.amazonaws.com",
    "region": "us-east-1",
    "bucket": "switchyard-artifacts",
    "keyPrefix": "artifacts",
    "forcePathStyle": true,
    "hasAccessKeyId": true,
    "hasSecretAccessKey": true,
    "requestTimeoutMs": 5000,
    "probe": "write_read_delete"
  }
}
```

Redacted summaries must not include:

- Raw access key id.
- Raw secret access key.
- Authorization headers.
- Signed URLs.
- Full endpoint strings with query strings or userinfo.
- Request/response bodies.
- Artifact content.
- Object-store SDK stack traces containing signed canonical requests.

## Security And Redaction Requirements

- The network object-store client must use only explicit Switchyard object-store credentials. It must not load `AWS_PROFILE`, `AWS_SHARED_CREDENTIALS_FILE`, default profile chains, ECS/EC2 metadata credentials, or process-wide AWS env values unless those values are explicitly copied into the Switchyard env vars above.
- In `staging` and `production`, S3-compatible endpoints must be HTTPS. HTTP is allowed only for local/test fake servers or optional MinIO smoke.
- Config errors, readiness reports, metrics, logs, test snapshots, artifact metadata, run events, node sync errors, and HTTP error envelopes must never expose credentials or signed request material.
- Object keys may appear in artifact metadata because they are part of artifact diagnostics, but they must be derived only from normalized logical artifact paths and safe key prefixes.
- Reads should verify metadata when available: if artifact metadata includes `sha256` or `sizeBytes`, the downloaded bytes must match. Mismatch is a named integrity failure.
- Writes should return and preserve `storageBackend`, `objectKey`, `sizeBytes`, `sha256`, and `contentType`; no bucket credentials or endpoints should be stored with the artifact.
- Bucket provisioning and IAM policy are operator-owned. Docs should recommend least privilege for the configured prefix: put/get/delete probe objects and put/get artifact objects.
- Readiness probes must delete probe objects after success where the backend supports delete. Probe cleanup failure should be visible as `object_store_probe_cleanup_failed` but must not expose object body or credentials.
- The implementation must keep hosted worker imports fake-only. Tests must continue proving worker code does not import hosted real runtime adapters, PTY, shell, browser, fetch, GitHub, or repo tooling.

## Data Flow Shadow Paths

### Config Env To Artifact Content Store

| Path | Input | Required behavior |
|---|---|---|
| Happy | Complete `s3-compatible` config with endpoint, region, bucket, keys, prefix, timeout | Server/worker start; redacted summary reports backend and non-secret diagnostics; no network call is made before readiness/probe. |
| Nil | Backend missing in staging/production | Startup fails with `config_required:SWITCHYARD_OBJECT_STORE_BACKEND`; no memory fallback. |
| Empty | Empty endpoint, region, bucket, access key, secret, or prefix after trimming | Startup fails with the matching `config_required:*` or `config_invalid:*` code; redacted summary omits raw values. |
| Error | Endpoint URL malformed, unsupported backend, invalid timeout, unsafe prefix, HTTP endpoint in production | Startup fails with named `config_invalid:*`; process does not start partially wired. |

### Artifact Content Write

| Path | Input | Required behavior |
|---|---|---|
| Happy | Runtime artifact has content and safe logical path | Content is uploaded to the configured backend, metadata records `contentStored=true`, `storageBackend=object`, `objectKey`, `sizeBytes`, `sha256`, and `contentType`; `artifact.created` event is emitted. |
| Nil | Artifact has no `metadata.content` | Existing behavior remains: metadata artifact may be stored, `contentStored` is false or absent, and no object write is attempted. |
| Empty | Artifact content is `""` or zero bytes | Store zero-byte content successfully with size `0`; reads return an empty body if metadata also says size `0`. |
| Error | PutObject/network/auth/bucket/timeout failure | The run must not silently complete with missing expected content. Emit or persist a visible failure with named object-store code; no secret appears in the event, log, or HTTP response. |

### Artifact Content Read

| Path | Input | Required behavior |
|---|---|---|
| Happy | Artifact exists and object exists | `GET /artifacts/:id/content` returns bytes with stored content type. |
| Nil | Artifact id does not exist | Existing `artifact_not_found` envelope remains. |
| Empty | Object exists and is zero bytes | Return HTTP 200 with an empty body only when stored metadata size is `0`; otherwise return named empty/mismatch failure. |
| Error | Object missing, auth denied, bucket missing, network timeout, digest mismatch | Missing object maps to `missing_artifact_content`; auth/bucket/network/timeout failures map to a 503-style object-store error; digest/size mismatch maps to `artifact_digest_mismatch` or `artifact_content_empty` without exposing content. |

### Readiness Probe

| Path | Input | Required behavior |
|---|---|---|
| Happy | Configured backend accepts write-read-delete probe | `/ready` returns 200 with `checks.objectStore.ok=true`; metrics increments dependency ready. |
| Nil | No persistent object config in staging/production | Startup fails before `/ready`; local/test may report memory backend. |
| Empty | Bucket/prefix config empty or invalid | Startup fails with config error, not a late readiness mystery. |
| Error | Probe cannot authenticate, write, read, verify, delete, or reach endpoint | `/ready` returns 503 with `checks.objectStore.code` set to the named failure; diagnostics remain redacted. |

## Failure Modes And Named Errors

| Code | Trigger | Surface |
|---|---|---|
| `config_required:SWITCHYARD_OBJECT_STORE_BACKEND` | Backend missing in staging/production | Startup failure with redacted config summary. |
| `config_invalid:SWITCHYARD_OBJECT_STORE_BACKEND` | Unsupported backend or `memory` outside local/test | Startup failure. |
| `config_required:SWITCHYARD_OBJECT_STORE_ENDPOINT` | S3-compatible backend without endpoint | Startup failure. |
| `config_invalid:SWITCHYARD_OBJECT_STORE_ENDPOINT` | Malformed URL, userinfo/query present, HTTP in staging/production | Startup failure. |
| `config_required:SWITCHYARD_OBJECT_STORE_REGION` | S3-compatible backend without region | Startup failure. |
| `config_required:SWITCHYARD_OBJECT_STORE_BUCKET` | S3-compatible backend without bucket | Startup failure. |
| `config_required:SWITCHYARD_OBJECT_STORE_ACCESS_KEY_ID` | S3-compatible backend without access key id | Startup failure. |
| `config_required:SWITCHYARD_OBJECT_STORE_SECRET_ACCESS_KEY` | S3-compatible backend without secret key | Startup failure. |
| `config_invalid:SWITCHYARD_OBJECT_STORE_FORCE_PATH_STYLE` | Non-boolean flag value | Startup failure. |
| `config_invalid:SWITCHYARD_OBJECT_STORE_KEY_PREFIX` | Unsafe or empty normalized prefix | Startup failure. |
| `config_invalid:SWITCHYARD_OBJECT_STORE_REQUEST_TIMEOUT_MS` | Missing, non-finite, zero, or negative timeout after parsing | Startup failure. |
| `object_store_unavailable` | DNS, TCP, TLS, service unavailable, local fake server down, or unexpected SDK transport failure | `/ready` 503; read/write failure event/log with redacted diagnostics. |
| `object_store_timeout` | Operation exceeds configured timeout | `/ready` 503 or artifact read/write failure. |
| `object_store_auth_failed` | Provider returns auth/permission denial | `/ready` 503; artifact read/write failure; no key details. |
| `object_store_bucket_not_found` | Bucket missing or inaccessible as missing bucket | `/ready` 503; artifact read/write failure. |
| `object_store_write_failed` | PutObject fails after config succeeds | Run failure or artifact sync failure with redacted code. |
| `object_store_read_failed` | GetObject fails for non-missing, non-auth reasons | HTTP object-store error; metrics failure count. |
| `object_store_probe_cleanup_failed` | Delete probe object fails after successful write/read | `/ready` 503 in staging/production unless explicitly downgraded in local/test; log redacted key prefix only. |
| `artifact_content_not_found` | Object key missing for an artifact that claims stored content | Existing public `missing_artifact_content` envelope. |
| `artifact_digest_mismatch` | Downloaded bytes do not match stored digest | Public error envelope; do not return corrupted bytes. |
| `artifact_content_empty` | Downloaded object is empty but metadata expects non-zero bytes | Public error envelope; do not return corrupted bytes. |

If new public HTTP error codes are needed, they must be added to `packages/protocol-rest/src/http-errors.ts` with explicit statuses. Object-store availability/auth/bucket/timeout failures should be 503 from readiness and artifact-content reads, except integrity mismatches should remain conflict-style failures.

## Test And Smoke Requirements

Normal required checks must not contact AWS, Cloudflare, MinIO, or any paid/external network.

Required deterministic tests:

- `packages/storage` unit tests for the S3-compatible client using a fake S3-compatible HTTP server or SDK request handler:
  - PutObject/GetObject/DeleteObject happy path.
  - AWS-style endpoint config.
  - R2-style `region=auto` endpoint config.
  - Path-style flag behavior.
  - Key prefix normalization.
  - Content type preservation.
  - Zero-byte object behavior.
  - Missing object.
  - Auth denied.
  - Bucket missing.
  - Timeout.
  - Digest mismatch.
  - Delete/probe cleanup failure.
- Existing injected-client `ObjectArtifactContentStore` tests remain and still pass.
- Server config tests:
  - staging requires explicit backend.
  - `memory` rejected in staging/production.
  - local/test compatibility inference for `memory` and `local`.
  - complete S3/R2 config parses into redacted summaries.
  - secrets do not appear in thrown errors, summaries, logs, readiness JSON, or snapshots.
- Worker config tests mirror server config tests.
- Server/worker integration test with deterministic fake S3 backend:
  - create a hosted `fake.deterministic` run;
  - worker writes transcript content to fake object store;
  - server lists artifacts and fetches content through `GET /artifacts/:id/content`;
  - restart/recreate app objects against the same fake store and fetch the same artifact content.
- Readiness tests:
  - object-store happy probe returns 200.
  - auth failure returns 503 with `object_store_auth_failed`.
  - endpoint unavailable returns 503 with `object_store_unavailable`.
  - bucket missing returns 503 with `object_store_bucket_not_found`.
  - disabled probe rejected in staging/production.
- Metrics tests:
  - object-store read/write/failure counters increment.
  - metrics do not contain bucket names, object keys, endpoints, or credential fragments.
- Boundary tests:
  - hosted worker still does not import real runtime adapters, PTY, shell, browser, fetch, GitHub, or repo tooling.
  - hosted runtime allowlist remains `fake.deterministic` only in required tests.

Optional local smoke:

- Add an opt-in MinIO-compatible smoke path, gated by an explicit env flag such as `SWITCHYARD_OBJECT_STORE_MINIO_SMOKE=1` or a compose profile. This smoke may use Docker/MinIO when available, but absence of Docker or MinIO must produce a named prerequisite skip/failure and must not fail normal CI.
- Existing `pnpm self-hosted:smoke` should continue to run with the local object-volume backend by default. A separate documented variant may run the same fake hosted flow against MinIO/S3-compatible config.

Recommended required command set for CTO planning:

- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/server test`
- `pnpm --filter @switchyard/worker test`
- `pnpm typecheck`
- Existing no-spend smoke checks that do not require Docker or external object storage.

## Docs And Product Updates Required

R13 implementation must update product-facing truth after tests pass:

- `PRODUCT.md`
  - Move S3/R2 network object-store client wiring out of "What Does Not Exist Yet".
  - Add an R13 shipped section explaining supported S3-compatible artifact content storage, fake-only hosted runtime boundary, no-spend test posture, and remaining gaps.
  - Keep managed hosted deployment, hosted real runtimes, arbitrary subprocess/PTY, enterprise controls, broad adapters/tools, real tools, runtime-specific approval bridges, hosted real-runtime debate/model judging, dashboard, and TUI listed as unshipped.
- `ARCHITECTURE.md`
  - Update hosted artifact storage from "future adapter work" to "S3-compatible backend available through explicit config".
  - Preserve local daemon and local object-volume behavior.
- `README.md` and development docs
  - Document the new env vars.
  - Show AWS S3 and Cloudflare R2 examples with fake/redacted credentials only.
  - State that normal tests use fake/no-spend object-store substitutes.
- `deploy/self-hosted/.env.example`
  - Keep the local object-volume defaults.
  - Add commented S3/R2 config examples without real secrets.
- `deploy/self-hosted/docker-compose.yml` or companion compose override
  - If MinIO optional smoke is added, keep it behind an explicit profile or separate command.
- `CHANGELOG.md`
  - Add the R13 entry only if the implementation phase's release convention expects changelog updates.

## Acceptance Criteria

- [ ] `packages/storage` exports a real S3-compatible object client/factory that can back `ObjectArtifactContentStore`.
- [ ] `apps/server` and `apps/worker` can select `memory`, `local`, or `s3-compatible` object artifact content storage from the shared env contract.
- [ ] Staging/production config fails closed when object-store backend/config is missing, invalid, insecure, or implicitly memory-backed.
- [ ] AWS S3-style and Cloudflare R2-style endpoint configs are represented in tests and docs.
- [ ] Hosted `fake.deterministic` runs can write artifact content to the S3-compatible backend and serve it through existing artifact-content routes.
- [ ] Artifact metadata preserves backend, object key, size, digest, and content type without storing credentials or signed request details.
- [ ] `/ready` reports object-store dependency status with named redacted failure codes.
- [ ] Object-store errors are named, visible, and mapped consistently across startup, readiness, artifact write, artifact read, and smoke diagnostics.
- [ ] Normal CI remains deterministic and no-spend; optional MinIO/S3 smoke is opt-in.
- [ ] Redaction tests prove access keys, secret keys, signed headers, endpoint userinfo/query, and artifact content do not leak into logs, summaries, readiness, metrics, events, or HTTP errors.
- [ ] Hosted worker execution remains fake-only, and forbidden adapter/import tests remain in place.
- [ ] Product docs are updated to reflect R13 shipped truth and remaining non-goals.

## Phase 12: R13 S3/R2 Network Object Store Client Wiring

**Goal:** Wire a real S3-compatible artifact content backend into the fake-only hosted server/worker slice while preserving deterministic no-spend CI and explicit hosted runtime non-goals.

**Acceptance:**

- S3-compatible storage client, config parser, server wiring, worker wiring, readiness, metrics, redaction, and deterministic tests are delivered.
- AWS S3 and Cloudflare R2 endpoint examples are documented through explicit config.
- Existing local object-volume and memory test behavior remains compatible.
- Hosted fake run artifacts are retrievable through existing artifact endpoints when backed by the S3-compatible store.
- Hosted real runtime execution remains denied and unshipped.

**Non-goals for this phase:** managed hosted platform, hosted real runtimes, arbitrary subprocess/PTY, real tools/adapters, enterprise controls, dashboard/TUI, direct presigned artifact URLs, and hosted debate/model judging.

**Complexity:** L

## Future Roadmap Ordering After R13

1. **R14 Enterprise Auth, Tenant, And Quota Foundation** - add organizations/projects/API tokens/RBAC-lite/audit boundaries before exposing managed hosted surfaces or shared object prefixes to multiple tenants.
2. **R15 Managed Hosted Deployment** - production cloud deployment, secrets management, migrations, backups, health/runbooks, autoscaling posture, and operational rollout for the fake-only hosted slice.
3. **R16 Hosted Sandbox And Arbitrary Process/PTY Safety Design** - define isolation, filesystem/network policy, resource limits, approval gates, and audit behavior before any hosted real runtime executes.
4. **R17 Hosted Codex/Claude/OpenCode And Runtime Approval Bridges** - promote specific real runtimes only after sandbox and operational controls exist; include Codex session resume and interactive approval handling for hosted Codex.
5. **R18 Real Tool Execution And Broad Adapters** - shell/browser/search/GitHub/fetch/repo and additional wrapper adapters behind tenant policy, auditing, and spend controls.
6. **R19 Hosted Debate With Real Runtimes And Model Judging** - move debate beyond fake participants only after real runtime execution, object storage, tenant controls, and tool policies are proven.
7. **Later: Dashboard/TUI** - build operator/user interfaces after the hosted substrate and product truth are stable enough to display honestly.
