# Phase 12: R13 S3/R2 Network Object Store Client Wiring - Implementation Plan

**Spec:** `docs/superpowers/specs/2026-05-30-phase-12-r13-s3-r2-object-store-client.md`
**Branch:** `agent/phase-12-r13-s3-r2-object-store-client`
**Complexity:** L

## Goal

Ship an explicitly configured S3-compatible artifact content backend for hosted fake server/worker deployments while preserving memory and local object-volume behavior, no-spend CI, fake-only hosted execution, and the existing artifact HTTP API.

## Scope Challenge

1. **Existing code already solves part of this:** `ObjectArtifactContentStore` already implements artifact-content write/read shape over an injected object client. `LocalObjectArtifactContentStore` already has object-key metadata, probe, digest, missing-content, and empty-content semantics. `apps/server` and `apps/worker` already choose memory or local object content stores. R13 must extend those seams, not add a second artifact API or a parallel hosted worker.
2. **Minimum changes:** add one real S3-compatible client/factory in `packages/storage`, one shared object-store env parser/factory exported from `packages/storage`, server/worker config and wiring updates, readiness/metrics/error mapping, core artifact metadata preservation, deterministic fake-client tests, and product docs. Defer direct presigned URLs, bucket provisioning, MinIO compose profiles, managed hosted deployment, hosted real runtimes, broad tools/adapters, dashboard/TUI, enterprise auth, and tenant controls.
3. **Complexity check:** the phase touches more than 8 files because storage, core artifact metadata, REST error mapping, server, worker, tests, and docs all share one env/error contract. The user requested a per-phase implementer/reviewer loop and asked to prefer one coherent task unless there are truly independent write sets. There are no truly independent write sets: docs depend on final env names, app wiring depends on storage exports, readiness depends on store probes, and metadata preservation depends on core/app wiring. The plan therefore uses one task and records file-count risk under `concerns`.
4. **Built-in check:** use the official AWS SDK v3 S3 primitives for SigV4, request serialization, endpoint handling, and stream bodies. Hand-rolled SigV4 is too risky for AWS S3 and R2 compatibility, especially around canonical headers, path-style addressing, payload hashes, redirects, and retryable provider errors. Scope new SDK dependencies only to `packages/storage`: `@aws-sdk/client-s3` plus `@smithy/node-http-handler` for bounded Node timeouts. Do not add AWS credential-provider packages and do not use default credential chains.
5. **Distribution check:** `packages/storage/package.json` and `pnpm-lock.yaml` must be updated so server/worker consumers get the new storage exports through the existing workspace package. Self-hosted compose keeps the local object-volume default. Docs add commented AWS S3 and Cloudflare R2 examples with fake credentials only. No new CLI binary, hosted platform, dashboard, or TUI artifact ships in this phase.

## Architecture

R13 keeps artifact content behind the existing `ArtifactContentStore` port and existing REST routes. `packages/storage` owns the shared object-store env parser, redacted summary, store factory, and real S3-compatible object client. The server and worker both call that storage helper after parsing deployment mode, so staging/production fail closed with the same backend rules and redacted diagnostics. Memory remains local/test only, local filesystem object storage remains available, and S3-compatible storage is selected only by explicit env.

```text
SWITCHYARD_OBJECT_STORE_* env
  |
  v
packages/storage object-store config parser
  |        |          |
  |        |          +--> s3-compatible: S3Client(static credentials, endpoint, region)
  |        +-------------> local: LocalObjectArtifactContentStore(root, prefix)
  +----------------------> memory: MemoryArtifactContentStore(local/test only)
                              |
                              v
                  RuntimeRunnerService / ArtifactSyncService
                              |
                              v
       Artifact metadata: contentStored, storageBackend, objectKey, sizeBytes, sha256, contentType
                              |
                              v
      GET /runs/:id/artifacts, GET /artifacts/:id, GET /artifacts/:id/content
```

The S3 client wrapper must use only explicit Switchyard credentials. It must construct `S3Client` with a literal `{ accessKeyId, secretAccessKey }`, explicit `endpoint`, `region`, `forcePathStyle`, and a bounded `NodeHttpHandler`. It must not import `fromEnv`, `fromIni`, `defaultProvider`, shared credential files, profile chains, ECS/EC2 metadata providers, or any ambient AWS discovery. The wrapper maps SDK errors to named Switchyard errors and strips raw provider messages when those messages may include signed material.

Readiness probes the configured artifact content backend rather than only the local directory. For `s3-compatible`, `probe()` performs a bounded write-read-delete roundtrip under `keyPrefix/probes/<uuid>`, verifies sha256, and treats cleanup failure as `object_store_probe_cleanup_failed`. In staging/production probe disabling is rejected at config time. In local/test, memory is ready without network and probe disabling is allowed only when the resolved backend is not persistent.

Artifact metadata preservation is part of the data contract. `RuntimeRunnerService` currently accepts an artifact content callback that returns only a path, so `storageBackend`, `objectKey`, `sizeBytes`, `sha256`, and `contentType` are dropped for runtime-produced artifacts. R13 must update that callback contract to return `StoredArtifactContent` or an equivalent object and persist the full metadata shape already used by `ArtifactSyncService`.

## File Structure

- `packages/storage/package.json` - add AWS SDK v3 dependencies scoped only to storage.
- `pnpm-lock.yaml` - lock the storage-only SDK dependencies.
- `packages/storage/src/object-artifact-content-store.ts` - extend the existing object store to use metadata object keys on reads, verify size/digest, support delete/probe, normalize key prefixes, and map named object-store errors.
- `packages/storage/src/s3-compatible-object-client.ts` - new official-SDK client wrapper and test seam for fake S3 clients.
- `packages/storage/src/object-store-config.ts` - new shared env parser, redacted summary builder, backend resolver, and artifact-content store factory used by server and worker.
- `packages/storage/src/index.ts` - export the new client, parser, and factory.
- `packages/storage/test/artifact-content-store.test.ts` - preserve existing memory/local/injected-client tests and add metadata verification where the existing file is the nearest anchor.
- `packages/storage/test/s3-compatible-object-client.test.ts` - deterministic fake-S3-client tests for put/get/delete/probe, R2/AWS config, error mapping, timeout, and no ambient credentials.
- `packages/storage/test/object-store-config.test.ts` - shared env parser tests for backend inference, fail-closed staging/production, redaction, endpoint security, prefix safety, and probe rules.
- `packages/core/src/services/runtime-runner-service.ts` - preserve stored artifact metadata returned by content writes.
- `packages/core/test/core.test.ts` - update runtime artifact tests so metadata includes `storageBackend`, `objectKey`, `sizeBytes`, `sha256`, and `contentType`; keep metadata-only behavior.
- `packages/protocol-rest/src/http-errors.ts` - add closed public 503/409 error codes needed for object-store read/integrity failures.
- `packages/contracts/src/http-error.ts` - mirror the REST closed error-code set.
- `packages/protocol-rest/src/artifact-routes.ts` - map named object-store and integrity errors from artifact-content reads to safe envelopes without leaking object content or provider diagnostics.
- `packages/protocol-rest/test/artifact-routes.test.ts` - cover missing object, auth/unavailable/timeout, digest mismatch, empty mismatch, and no credential/content leakage.
- `apps/server/src/config.ts` - parse object-store config through the shared storage helper and include redacted object-store summary.
- `apps/server/src/app.ts` - instantiate artifact content via the shared factory, preserve full stored metadata in the runtime runner callback, instrument object-store reads/writes/failures, and pass a probeable store to readiness.
- `apps/server/src/readiness.ts` - probe memory/local/S3-compatible backends with named failures and redacted diagnostics.
- `apps/server/src/metrics.ts` - keep object-store counters low-cardinality and secret-free.
- `apps/server/test/hosted-server.test.ts` - server config, readiness, metrics, fake S3 integration, restart persistence, and redaction coverage.
- `apps/worker/src/config.ts` - mirror server object-store config parsing and redacted summary behavior.
- `apps/worker/src/worker.ts` - instantiate artifact content via the shared factory, preserve stored metadata in the runtime runner callback, and include object-store readiness in `ready()`.
- `apps/worker/test/hosted-worker.test.ts` - worker config, fake S3 write path, readiness, no forbidden imports, and redaction coverage.
- `PRODUCT.md` - move S3/R2 network object-store client wiring into shipped R13 truth and keep hosted real runtimes and managed platform items unshipped.
- `ARCHITECTURE.md` - update hosted artifact storage architecture from future work to explicit S3-compatible backend plus local object-volume compatibility.
- `README.md` - document high-level R13 capability and config examples with fake/redacted credentials.
- `docs/development/API.md` - update hosted infrastructure env docs, error table, and artifact content behavior.
- `docs/development/DEVELOPMENT.md` - add no-spend fake S3 test posture and explicit optional live/MinIO guidance.
- `deploy/self-hosted/.env.example` - keep local defaults and add commented S3/R2 examples with fake credentials.
- `CHANGELOG.md` - add an R13 entry because prior roadmap phases use this file for user-facing release truth.

`PROJECT.md` is not an implementer-owned file. The CEO phase-close step must append the Phase 12 block after audit using this plan path, the audit path, the branch, PR status, and any deferred concerns.

## Existing Context

`packages/storage/src/object-artifact-content-store.ts` already has the store seam but no network client:

```ts
export class ObjectArtifactContentStore implements ArtifactContentStore {
  constructor(
    private readonly config: ObjectArtifactContentStoreConfig,
    private readonly client: ObjectClient
  ) {}
}
```

`packages/storage/src/local-object-artifact-content-store.ts` already returns object-shaped metadata and verifies local reads:

```ts
return {
  path: safePath,
  storageBackend: "object",
  objectKey,
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  contentType: options?.contentType ?? "application/octet-stream"
};
```

`packages/core/src/services/runtime-runner-service.ts` currently drops stored metadata because its callback returns only `string`:

```ts
artifactContent?: {
  writeText(path: string, content: string): Promise<string>;
};
```

`apps/server/src/app.ts` currently selects only local dir or memory:

```ts
const artifactContent: ArtifactContentStore = config.objectStoreDir
  ? new LocalObjectArtifactContentStore(config.objectStoreDir)
  : forcePersistent
    ? (() => {
      throw new Error("config_required:SWITCHYARD_OBJECT_STORE_DIR");
    })()
    : new MemoryArtifactContentStore();
```

`apps/server/src/readiness.ts` currently checks only local object directory access:

```ts
if (input.config.objectStoreDir) {
  await access(input.config.objectStoreDir, constants.R_OK | constants.W_OK);
  checks.objectStore = { ok: true };
}
```

`PROJECT.md` Phase 11 records the user-facing boundary to replace after this phase closes:

```md
The shipped boundary remains explicit: R12 does not ship S3/R2 network object-store clients.
```

## Task Graph

### Task P12-T1-s3-r2-object-store-client-wiring: Wire S3-Compatible Artifact Content Storage End To End

**Files (owned):**

- Modify `packages/storage/package.json`
- Modify `pnpm-lock.yaml`
- Modify `packages/storage/src/object-artifact-content-store.ts`
- Create `packages/storage/src/s3-compatible-object-client.ts`
- Create `packages/storage/src/object-store-config.ts`
- Modify `packages/storage/src/index.ts`
- Modify `packages/storage/test/artifact-content-store.test.ts`
- Create `packages/storage/test/s3-compatible-object-client.test.ts`
- Create `packages/storage/test/object-store-config.test.ts`
- Modify `packages/core/src/services/runtime-runner-service.ts`
- Modify `packages/core/test/core.test.ts`
- Modify `packages/protocol-rest/src/http-errors.ts`
- Modify `packages/contracts/src/http-error.ts`
- Modify `packages/protocol-rest/src/artifact-routes.ts`
- Modify `packages/protocol-rest/test/artifact-routes.test.ts`
- Modify `apps/server/src/config.ts`
- Modify `apps/server/src/app.ts`
- Modify `apps/server/src/readiness.ts`
- Modify `apps/server/src/metrics.ts`
- Modify `apps/server/test/hosted-server.test.ts`
- Modify `apps/worker/src/config.ts`
- Modify `apps/worker/src/worker.ts`
- Modify `apps/worker/test/hosted-worker.test.ts`
- Modify `PRODUCT.md`
- Modify `ARCHITECTURE.md`
- Modify `README.md`
- Modify `docs/development/API.md`
- Modify `docs/development/DEVELOPMENT.md`
- Modify `deploy/self-hosted/.env.example`
- Modify `CHANGELOG.md`

**Dependencies:** none

**Context files (MUST read before coding):**

- `docs/superpowers/specs/2026-05-30-phase-12-r13-s3-r2-object-store-client.md` - phase goals, env contract, shadow paths, non-goals, and acceptance.
- `PROJECT.md` - Phase 11 shipped truth and CEO-owned closeout format; read only, do not edit in this task.
- `packages/storage/src/object-artifact-content-store.ts` - existing injected-client object store seam to extend.
- `packages/storage/src/local-object-artifact-content-store.ts` - existing object metadata, probe, digest, and named local error behavior to mirror for S3-compatible storage.
- `packages/core/src/services/runtime-runner-service.ts` - runtime artifact persistence callback that currently drops store metadata.
- `apps/server/src/config.ts` - current hosted fail-closed config parser to extend through shared object-store config.
- `apps/server/src/app.ts` - current artifact-content store construction and runtime runner callback.
- `apps/server/src/readiness.ts` - current readiness dependency shape and object-store check to replace.
- `apps/worker/src/config.ts` - worker config parser that must mirror server object-store semantics.
- `apps/worker/src/worker.ts` - worker artifact-content construction and fake-only import boundary.
- `packages/protocol-rest/src/artifact-routes.ts` - existing public artifact content route that must remain the only artifact content API.
- `packages/protocol-rest/src/http-errors.ts` - closed REST error set and status mapping.
- `packages/contracts/src/http-error.ts` - contract-owned error-code schema that must stay in sync with REST.
- `PRODUCT.md` - owner-facing current truth section that still lists S3/R2 as unshipped.
- `docs/development/DEVELOPMENT.md` - local no-spend smoke and hosted storage scope docs to update.

**Instructions:**

1. Add the storage-only AWS SDK dependencies in `packages/storage/package.json`: `@aws-sdk/client-s3` and `@smithy/node-http-handler`. Update `pnpm-lock.yaml` with pnpm. Do not add AWS SDK dependencies to the root, server, worker, core, protocol-rest, or contracts packages.
2. In `packages/storage`, implement a small S3-compatible object client wrapper around `S3Client`, `PutObjectCommand`, `GetObjectCommand`, and `DeleteObjectCommand`. The wrapper must accept static `accessKeyId` and `secretAccessKey` from Switchyard config only, explicit `endpoint`, `region`, `bucket`, `forcePathStyle`, `keyPrefix`, and `requestTimeoutMs`. It must expose `putObject`, `getObject`, `deleteObject`, and be injectable so tests can use a deterministic fake client without network.
3. Do not implement custom SigV4. Use official SDK request construction because custom signing is too risky for AWS S3/R2 compatibility. Also do not import SDK credential providers, profile readers, metadata credential providers, or environment credential helpers.
4. Extend `ObjectArtifactContentStore` rather than replacing it. Preserve the injected-client test path. Add read behavior that prefers `artifact.metadata.objectKey` when present, verifies `sizeBytes` and `sha256` when present, returns zero bytes only when metadata size is `0`, maps missing content to `artifact_content_not_found`, maps integrity mismatches to `artifact_digest_mismatch` or `artifact_content_empty`, and maps write/read/delete/provider failures to named object-store errors.
5. Add `probe()` to object-backed stores without widening the core `ArtifactContentStore` port unless the app helper needs a local `ProbeableArtifactContentStore` type. `probe()` must write, read, verify digest, and delete `probes/<uuid>` under the configured prefix. Cleanup failure must become `object_store_probe_cleanup_failed`.
6. Add `packages/storage/src/object-store-config.ts` with a shared resolver for server and worker:
   - Allowed backend values: `memory`, `local`, `s3-compatible`.
   - `staging` and `production` require explicit `SWITCHYARD_OBJECT_STORE_BACKEND=local|s3-compatible`; `memory` is rejected.
   - Local/test inference: unset backend plus `SWITCHYARD_OBJECT_STORE_DIR` means `local`; unset backend plus no dir means `memory`.
   - `s3-compatible` requires endpoint, region, bucket, access key id, secret access key, and positive timeout.
   - Reject endpoint userinfo/query strings. Reject HTTP endpoints in staging/production. Allow `http://127.0.0.1`, `http://localhost`, and Docker-network HTTP only in local/test.
   - Parse `SWITCHYARD_OBJECT_STORE_FORCE_PATH_STYLE` as `0`, `1`, `true`, or `false`; default to `true`.
   - Normalize `SWITCHYARD_OBJECT_STORE_KEY_PREFIX` to default `artifacts` and reject absolute paths, `..`, backslashes, Windows drive prefixes, empty path segments, leading slash, trailing slash ambiguity, and empty normalized prefix.
   - Parse `SWITCHYARD_OBJECT_STORE_PROBE` as `write_read_delete` or `disabled`; reject `disabled` in staging/production.
   - Return a redacted summary containing backend, endpoint scheme/host, region, bucket, keyPrefix, forcePathStyle, hasAccessKeyId, hasSecretAccessKey, requestTimeoutMs, probe, and warning code `object_store_dir_ignored` when S3 wins over a set local dir.
7. Wire `apps/server/src/config.ts` and `apps/worker/src/config.ts` to the shared resolver. Keep app-specific config fields for Postgres, Redis, host, port, node token, and idle interval. Config errors must use named `config_required:*` or `config_invalid:*` codes and include redacted summaries without raw keys, secrets, full credential-bearing endpoints, or object content.
8. Wire `apps/server/src/app.ts` and `apps/worker/src/worker.ts` to the shared storage factory. For server and worker runtime runner callbacks, return the full `StoredArtifactContent` result to core rather than only `stored.path`.
9. Update `RuntimeRunnerService` so the artifact content callback returns stored metadata. Persist `contentStored=true`, `storageBackend`, `objectKey`, `sizeBytes`, `sha256`, and `contentType` into artifact metadata, and keep the artifact path as the normalized logical path unless an older callback explicitly returns a string. Preserve metadata-only artifacts with `contentStored=false`.
10. Update `packages/protocol-rest` and `packages/contracts` closed error sets for public object-store read/integrity failures: `object_store_unavailable`, `object_store_timeout`, `object_store_auth_failed`, `object_store_bucket_not_found`, `object_store_read_failed`, `artifact_digest_mismatch`, and `artifact_content_empty`. Use 503 for object-store availability/auth/bucket/timeout/read failures and 409 for integrity failures. Keep missing object mapped to public `missing_artifact_content`.
11. Update `apps/server/src/readiness.ts` to accept a probeable object-store dependency and report `checks.objectStore` with `ok`, `code`, and redacted diagnostics. For memory in local/test, report ok without network. For local and S3-compatible, call the store probe. Do not include endpoint paths, bucket in metrics labels, object keys, credentials, signed headers, request bodies, response bodies, or artifact content.
12. Keep `HostedMetrics` low-cardinality. Increment object-store writes, reads, failures, probe failures, auth failures, unavailable states, and digest mismatches as bounded counters. The JSON metrics body must not contain bucket names, object keys, endpoints, access key fragments, secret fragments, run ids, or artifact content.
13. Add deterministic tests. Required tests must use fake S3 clients or local in-memory request seams only. No required test may contact AWS, Cloudflare, MinIO, Docker, or paid/external network.
14. Preserve hosted worker safety. `apps/worker/src/worker.ts` must still import/register only `FakeRuntimeAdapter`; the existing forbidden-import test must remain and should add checks for any new storage code not importing runtime adapters, PTY, shell, browser, fetch, GitHub, or repo tooling.
15. Update docs after tests pass. `PRODUCT.md` must mark R13 S3/R2 object-store client wiring as shipped and keep managed hosted deployment, hosted real runtimes, arbitrary subprocess/PTY, enterprise controls, broad adapters/tools, real tools, runtime-specific approval bridges, hosted real-runtime debate/model judging, dashboard, and TUI unshipped. `PROJECT.md` must not be edited by the implementer; CEO phase-close owns it.

**Acceptance criteria:**

- [ ] `packages/storage` exports a real S3-compatible object client/factory using official AWS SDK v3 primitives and only explicit Switchyard credentials.
- [ ] AWS SDK dependencies are scoped to `packages/storage`; no server/worker/root dependency receives the SDK directly.
- [ ] `ObjectArtifactContentStore` supports put/get/delete/probe through the real client and still supports the existing injected fake client tests.
- [ ] Shared object-store config supports `SWITCHYARD_OBJECT_STORE_BACKEND=memory|local|s3-compatible`, endpoint, region, bucket, access key id, secret access key, force path style, key prefix, request timeout, and probe mode.
- [ ] Staging/production require explicit `local` or `s3-compatible` backend and reject implicit memory, missing backend, missing fields, insecure endpoints, unsafe prefixes, invalid booleans, invalid timeouts, and disabled probe.
- [ ] Local/test compatibility remains: unset backend plus object dir infers local; unset backend plus no dir infers memory.
- [ ] Server and worker use the same object-store resolver and redacted summary shape.
- [ ] Hosted fake run artifacts written through server or worker preserve `contentStored`, `storageBackend`, `objectKey`, `sizeBytes`, `sha256`, and `contentType`.
- [ ] `GET /artifacts/:id/content` remains the only artifact-content download API and returns content from S3-compatible storage through Switchyard.
- [ ] Object-store read errors map to safe public envelopes: missing object to `missing_artifact_content`, availability/auth/bucket/timeout/read failures to 503 object-store errors, and digest/empty mismatch to 409 integrity errors.
- [ ] `/ready` probes S3-compatible storage with write-read-delete, reports named redacted failures, and rejects disabled probes in staging/production.
- [ ] Metrics count object-store reads, writes, failures, auth failures, unavailable states, probe failures, and digest mismatches without high-cardinality or secret-bearing labels.
- [ ] Required tests are no-spend and use fake S3 clients or deterministic local seams only.
- [ ] Optional live/MinIO smoke, if documented, is opt-in only and never part of normal CI.
- [ ] Hosted worker execution remains fake-only and forbidden adapter/import tests continue to pass.
- [ ] Product, architecture, README, API, development, self-hosted env, and changelog docs reflect R13 shipped truth and remaining non-goals.
- [ ] CEO phase-close can append `PROJECT.md` with plan path, audit path, branch/PR status, and deferred concerns because the implementer docs state the shipped boundary clearly.

**Checks (must pass before GREEN):**

- `pnpm --filter @switchyard/storage test`
- `pnpm --filter @switchyard/core test`
- `pnpm --filter @switchyard/protocol-rest test`
- `pnpm --filter @switchyard/contracts test`
- `pnpm --filter @switchyard/server test`
- `pnpm --filter @switchyard/worker test`
- `pnpm typecheck`
- `pnpm release:smoke-local`
- `git diff --check`

**Error rescue map:**

| Codepath | Failure | Exception shape | Rescue action | User sees |
| --- | --- | --- | --- | --- |
| `resolveObjectStoreConfig` | backend missing in staging/production | `ObjectStoreConfigError("config_required:SWITCHYARD_OBJECT_STORE_BACKEND")` | Stop startup before stores are created; include redacted object-store summary | Startup failure with named config code and no memory fallback |
| `resolveObjectStoreConfig` | unsupported backend or memory in staging/production | `ObjectStoreConfigError("config_invalid:SWITCHYARD_OBJECT_STORE_BACKEND")` | Stop startup before stores are created | Startup failure with backend code only |
| `resolveObjectStoreConfig` | required S3 field empty | `ObjectStoreConfigError("config_required:SWITCHYARD_OBJECT_STORE_*")` | Stop startup and omit raw secret values | Startup failure naming the missing variable |
| `resolveObjectStoreConfig` | malformed endpoint, userinfo/query, or HTTP in staging/production | `ObjectStoreConfigError("config_invalid:SWITCHYARD_OBJECT_STORE_ENDPOINT")` | Stop startup and include only endpoint scheme/host when safe | Startup failure with redacted endpoint diagnostics |
| `resolveObjectStoreConfig` | invalid boolean flag | `ObjectStoreConfigError("config_invalid:SWITCHYARD_OBJECT_STORE_FORCE_PATH_STYLE")` | Stop startup | Startup failure naming the invalid flag |
| `resolveObjectStoreConfig` | unsafe key prefix | `ObjectStoreConfigError("config_invalid:SWITCHYARD_OBJECT_STORE_KEY_PREFIX")` | Stop startup before object writes | Startup failure naming prefix config |
| `resolveObjectStoreConfig` | invalid timeout | `ObjectStoreConfigError("config_invalid:SWITCHYARD_OBJECT_STORE_REQUEST_TIMEOUT_MS")` | Stop startup | Startup failure naming timeout config |
| `createS3CompatibleObjectClient` | SDK would use ambient credentials | code review and tests detect forbidden credential provider imports | Use literal static credentials from Switchyard config only | No ambient AWS profile or metadata credentials are used |
| `S3CompatibleObjectClient.putObject` | provider rejects auth or permission | named error `object_store_auth_failed` | Redact provider details, increment failure/auth metrics, fail required artifact write | Run/job fails visibly with safe object-store code |
| `S3CompatibleObjectClient.putObject` | bucket missing/inaccessible | named error `object_store_bucket_not_found` | Redact provider details, increment failure metrics, fail required artifact write | Run/job fails visibly with bucket code |
| `S3CompatibleObjectClient.putObject` | network unavailable or unknown SDK transport failure | named error `object_store_unavailable` or `object_store_write_failed` | Redact provider details, increment failure metrics | Run/job fails with object-store write/unavailable code |
| `S3CompatibleObjectClient.getObject` | object missing | named error `artifact_content_not_found` | Map route to `missing_artifact_content` | `404 missing_artifact_content` |
| `S3CompatibleObjectClient.getObject` | auth, bucket, timeout, or network failure | named object-store error | Map route to 503 safe envelope, increment read/failure metrics | `503 object_store_*` without credentials |
| `ObjectArtifactContentStore.read` | body sha256 differs from artifact metadata | `Error("artifact_digest_mismatch")` | Do not return bytes; increment digest mismatch metric | `409 artifact_digest_mismatch` |
| `ObjectArtifactContentStore.read` | body empty but metadata expects non-zero size | `Error("artifact_content_empty")` | Do not return bytes; increment failure metric | `409 artifact_content_empty` |
| `ObjectArtifactContentStore.probe` | write/read/delete probe cannot reach store | named object-store error | `/ready` reports 503 with named code and redacted diagnostics | `checks.objectStore.ok=false` with safe code |
| `ObjectArtifactContentStore.probe` | delete cleanup fails after successful read | `Error("object_store_probe_cleanup_failed")` | Treat as not ready in staging/production; log prefix only | `503 object_store_probe_cleanup_failed` |
| `RuntimeRunnerService.persistArtifacts` | content write throws for required artifact | named object-store error or existing write error | Keep existing run failure behavior; do not create artifact metadata claiming stored content | Run/job fails visibly instead of silently losing content |
| `registerArtifactRoutes` | artifact record exists but stored object read fails | named error from content store | Map to safe closed HTTP code; never include object body or SDK message | Existing artifact API returns safe error envelope |
| `HostedMetrics.toJSON` | metrics include secret/high-cardinality labels | test snapshot failure | Remove labels and keep bounded counters only | Metrics JSON contains no bucket, key, endpoint, credentials, run id, or content |

**Observability:**

```json
{
  "logs": [
    "warn: object_store.config object_store_dir_ignored when s3-compatible wins over SWITCHYARD_OBJECT_STORE_DIR",
    "warn: object_store.probe_failed with backend and safe code only",
    "error: object_store.write_failed with backend and safe code only",
    "error: object_store.read_failed with backend and safe code only",
    "error: object_store.integrity_failed with code artifact_digest_mismatch or artifact_content_empty"
  ],
  "success_metric": "Hosted metrics objectStore counters show writes/reads/probe success while /ready checks.objectStore.ok=true",
  "failure_metric": "Hosted metrics objectStore.failures/probeFailures/authFailures/unavailable/digestMismatches increment and /ready or artifact routes expose named safe errors"
}
```

**Test cases:**

- `{ "name": "s3 client put get delete happy path", "lens": "happy", "given": "S3CompatibleObjectClient with fake SDK client and bucket/key/body/contentType", "expect": "PutObject/GetObject/DeleteObject commands are sent with configured bucket, key, body, content type, endpoint config, and static credentials" }`
- `{ "name": "aws endpoint config", "lens": "happy", "given": "endpoint https://s3.us-east-1.amazonaws.com region us-east-1 forcePathStyle false", "expect": "config parses and redacted summary includes scheme https, host s3.us-east-1.amazonaws.com, region us-east-1, no secrets" }`
- `{ "name": "r2 endpoint config", "lens": "happy", "given": "endpoint https://account.r2.cloudflarestorage.com region auto forcePathStyle true", "expect": "config parses and redacted summary includes region auto and no credentials" }`
- `{ "name": "local test backend inference memory", "lens": "happy_shadow_nil", "given": "deploymentMode test with no backend and no object dir", "expect": "resolved backend memory and no required persistent config error" }`
- `{ "name": "local test backend inference local", "lens": "happy", "given": "deploymentMode local with SWITCHYARD_OBJECT_STORE_DIR set and backend unset", "expect": "resolved backend local with that dir" }`
- `{ "name": "staging backend required", "lens": "happy_shadow_nil", "given": "deploymentMode staging without SWITCHYARD_OBJECT_STORE_BACKEND", "expect": "throws config_required:SWITCHYARD_OBJECT_STORE_BACKEND" }`
- `{ "name": "staging rejects memory backend", "lens": "error_path", "given": "deploymentMode staging backend memory", "expect": "throws config_invalid:SWITCHYARD_OBJECT_STORE_BACKEND" }`
- `{ "name": "s3 required fields", "lens": "happy_shadow_empty", "given": "backend s3-compatible with blank endpoint, region, bucket, access key, or secret", "expect": "throws matching config_required code and redacted summary omits raw values" }`
- `{ "name": "endpoint rejects unsafe forms", "lens": "error_path", "given": "endpoint with userinfo, query string, malformed URL, or http in production", "expect": "throws config_invalid:SWITCHYARD_OBJECT_STORE_ENDPOINT" }`
- `{ "name": "local http endpoint allowed for fake server", "lens": "happy", "given": "deploymentMode test endpoint http://127.0.0.1:9000", "expect": "config parses for no-spend local fake S3 testing" }`
- `{ "name": "force path style parsing", "lens": "happy", "given": "flag values 0, 1, true, false", "expect": "booleans parse correctly; garbage value throws config_invalid:SWITCHYARD_OBJECT_STORE_FORCE_PATH_STYLE" }`
- `{ "name": "key prefix normalization", "lens": "edge_prefix", "given": "prefix artifacts/team-a", "expect": "object key artifacts/team-a/runs/run_1/transcript.jsonl" }`
- `{ "name": "key prefix rejects traversal", "lens": "error_path", "given": "prefix /abs, ../x, a//b, a/, a\\\\b, C:\\\\x, or empty normalized prefix", "expect": "throws config_invalid:SWITCHYARD_OBJECT_STORE_KEY_PREFIX" }`
- `{ "name": "timeout parsing", "lens": "error_path", "given": "timeout 0, -1, NaN, Infinity, or blank when explicit", "expect": "throws config_invalid:SWITCHYARD_OBJECT_STORE_REQUEST_TIMEOUT_MS" }`
- `{ "name": "probe disabled rejected in staging", "lens": "error_path", "given": "deploymentMode staging probe disabled", "expect": "throws config_invalid:SWITCHYARD_OBJECT_STORE_PROBE" }`
- `{ "name": "object store write metadata", "lens": "happy", "given": "write text transcript through ObjectArtifactContentStore", "expect": "stored result contains path, storageBackend object, objectKey, sizeBytes, sha256, and contentType" }`
- `{ "name": "zero byte object", "lens": "happy_shadow_empty", "given": "write and read Buffer.alloc(0) with metadata sizeBytes 0", "expect": "read returns 200-equivalent empty body and content type" }`
- `{ "name": "missing object read", "lens": "error_path", "given": "artifact metadata points at absent fake object", "expect": "store throws artifact_content_not_found and REST maps to missing_artifact_content" }`
- `{ "name": "auth denied read and write", "lens": "error_path", "given": "fake S3 client rejects with auth-style error", "expect": "named object_store_auth_failed with no access key or secret in error output" }`
- `{ "name": "bucket missing read and write", "lens": "error_path", "given": "fake S3 client rejects with NoSuchBucket-style error", "expect": "named object_store_bucket_not_found" }`
- `{ "name": "timeout read and write", "lens": "error_path", "given": "fake S3 client rejects with timeout/abort error", "expect": "named object_store_timeout" }`
- `{ "name": "digest mismatch", "lens": "error_path", "given": "stored bytes sha256 differs from artifact metadata sha256", "expect": "artifact_digest_mismatch and no corrupted body returned" }`
- `{ "name": "empty mismatch", "lens": "error_path", "given": "downloaded object is empty but metadata sizeBytes is positive", "expect": "artifact_content_empty and no empty body returned" }`
- `{ "name": "probe happy path", "lens": "happy", "given": "fake S3 client accepts put/get/delete for probe object", "expect": "probe returns ok true and deletes probe key" }`
- `{ "name": "probe cleanup failure", "lens": "error_path", "given": "fake S3 client put/get succeeds and delete fails", "expect": "probe throws object_store_probe_cleanup_failed" }`
- `{ "name": "runtime runner preserves stored metadata", "lens": "integration", "given": "fake adapter returns transcript content and artifactContent.writeText returns StoredArtifactContent", "expect": "created artifact metadata has contentStored true, storageBackend, objectKey, sizeBytes, sha256, and contentType" }`
- `{ "name": "runtime runner metadata-only artifact", "lens": "happy_shadow_nil", "given": "adapter artifact metadata has no content field", "expect": "no content write attempted and contentStored is false or absent as existing behavior requires" }`
- `{ "name": "server and worker redacted summary parity", "lens": "integration", "given": "same S3/R2 env passed to loadServerConfig and loadWorkerConfig", "expect": "objectStore redacted summaries match except app-specific fields and contain no raw key, secret, userinfo, or query string" }`
- `{ "name": "server readiness s3 ok", "lens": "integration", "given": "server app with fake S3 probeable backend", "expect": "GET /ready returns 200 and checks.objectStore.ok true" }`
- `{ "name": "server readiness s3 auth failure", "lens": "error_path", "given": "probe fake client auth failure", "expect": "GET /ready returns 503 with checks.objectStore.code object_store_auth_failed and no secrets" }`
- `{ "name": "server readiness s3 unavailable", "lens": "error_path", "given": "probe fake client network failure", "expect": "GET /ready returns 503 with object_store_unavailable" }`
- `{ "name": "server readiness bucket missing", "lens": "error_path", "given": "probe fake client bucket error", "expect": "GET /ready returns 503 with object_store_bucket_not_found" }`
- `{ "name": "hosted fake run with fake s3 content", "lens": "integration", "given": "server/worker or wait path configured with fake S3-compatible store", "expect": "run completes, artifacts list transcript, content endpoint returns transcript bytes from object store" }`
- `{ "name": "restart persistence against same fake s3", "lens": "integration", "given": "artifact metadata persisted and app objects recreated against same fake object map", "expect": "GET /artifacts/:id/content still returns stored bytes" }`
- `{ "name": "metrics redact object store", "lens": "error_path", "given": "metrics after read/write/probe failures", "expect": "objectStore counters increment and JSON contains no bucket, key, endpoint, credential fragment, run id, or content" }`
- `{ "name": "worker forbidden imports remain absent", "lens": "error_path", "given": "read apps/worker/src/worker.ts source", "expect": "does not contain adapters package, Codex, Claude, OpenCode, Generic HTTP, AgentField, PTY, shell, browser, fetch, GitHub, or repo imports" }`
- `{ "name": "docs shipped truth updated", "lens": "integration", "given": "PRODUCT, ARCHITECTURE, README, API, DEVELOPMENT, env example, and CHANGELOG", "expect": "S3/R2 object-store client wiring is shipped, fake-only hosted runtime boundary remains explicit, and PROJECT.md is left for CEO closeout" }`

**Integration contracts:**

```json
{
  "exports": [
    {
      "name": "createS3CompatibleObjectClient",
      "kind": "function",
      "signature": "createS3CompatibleObjectClient(config: S3CompatibleObjectClientConfig, deps?: { s3Client?: { send(command: unknown): Promise<unknown> } }) => ObjectClient"
    },
    {
      "name": "resolveObjectStoreConfig",
      "kind": "function",
      "signature": "resolveObjectStoreConfig(env: NodeJS.ProcessEnv, options: { deploymentMode: 'local' | 'test' | 'staging' | 'production' }) => ResolvedObjectStoreConfig"
    },
    {
      "name": "createArtifactContentStoreFromObjectConfig",
      "kind": "function",
      "signature": "createArtifactContentStoreFromObjectConfig(config: ResolvedObjectStoreConfig) => ArtifactContentStore & { probe?: () => Promise<{ ok: true }> }"
    },
    {
      "name": "ObjectArtifactContentStore.probe",
      "kind": "function",
      "signature": "probe() => Promise<{ ok: true }>"
    },
    {
      "name": "RuntimeRunnerDependencies.artifactContent.writeText",
      "kind": "function",
      "signature": "writeText(path: string, content: string, options?: { contentType?: string }) => Promise<StoredArtifactContent | string>"
    }
  ],
  "imports_from_other_tasks": [],
  "file_paths_consumed_by_other_tasks": []
}
```

## Risks

- **Single-task breadth:** This one task owns more than 8 files. Splitting would create dependent worktrees that all need the same env/error contract and would increase merge risk. Mitigation: strict internal order, storage-first tests, then core metadata, then app wiring, then docs.
- **AWS SDK behavior drift:** SDK error names can vary across providers and versions. Mitigation: map by explicit Smithy metadata/status/name patterns in one helper and test with fake SDK errors that cover AWS and R2-style failures.
- **Credential leakage:** Provider errors can contain request metadata. Mitigation: never surface raw SDK messages from object-store errors, use redacted summaries, and add negative tests for access key, secret, signed headers, userinfo/query endpoint, bucket/key in metrics, and artifact content.
- **Readiness probe side effects:** Probe delete failure can leave an object. Mitigation: use a `probes/<uuid>` prefix, fail readiness on cleanup failure in staging/production, and document least-privilege delete permission for probe keys.
- **Package dependency footprint:** Adding AWS SDK could accidentally bleed into app packages. Mitigation: dependency scoped only to `packages/storage`, with package manifest and lockfile review in acceptance.
- **Runtime boundary regression:** App wiring changes must not import real adapters into the hosted worker. Mitigation: preserve and expand forbidden-import tests.

## Integration Points

The implementation order should be storage first, then core metadata preservation, then REST error mapping, then server/worker wiring, then docs. `packages/storage` exports the only object-store config parser and store factory. `apps/server/src/config.ts` and `apps/worker/src/config.ts` consume the parser and store only the resolved object-store config plus redacted summary. `apps/server/src/app.ts` and `apps/worker/src/worker.ts` consume the store factory and pass the resulting store to `RuntimeRunnerService`. `RuntimeRunnerService` consumes `StoredArtifactContent` and writes metadata that `packages/protocol-rest/src/artifact-routes.ts` later uses for safe content reads. `apps/server/src/readiness.ts` consumes the probeable store. Metrics wrap app-level reads/writes/probes and remain separate from storage internals.

```text
packages/storage exports
  |
  +--> apps/server config/app/readiness/metrics
  |
  +--> apps/worker config/worker
  |
  +--> packages/core RuntimeRunnerService metadata
          |
          v
      artifact stores
          |
          v
packages/protocol-rest artifact content route
```

No task imports from another task because this phase intentionally uses one coherent task.

## Phase-Level Acceptance Criteria

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

## Self-Review

1. Spec coverage: pass. The single task covers storage client, config, server/worker wiring, readiness, metrics, metadata, tests, docs, and non-goals.
2. Placeholder scan: pass. No placeholder work items remain.
3. Type consistency: pass. `StoredArtifactContent` is the shared return shape for content writes, with legacy string return compatibility explicitly called out.
4. Ownership disjoint: pass. There is one task, so there is no cross-task file overlap.
5. Context files real: pass. All context files listed above exist in this worktree.
6. Acceptance testable: pass. Each acceptance item maps to a command or named test case.
7. Dependency order sane: pass. One task includes an internal storage-to-docs implementation order.
8. Checks runnable: pass. Commands are workspace pnpm commands already used by existing packages, plus `git diff --check`.
9. Error/rescue map present: pass. Startup, config, network, read/write, probe, integrity, metadata, route, and metrics failures are enumerated.
10. Observability present: pass. Logs and metrics are specified with redaction boundaries.
11. Test cases enumerate acceptance: pass. Happy, nil, empty, error, edge, and integration lenses cover the error/rescue map and acceptance criteria.
12. Integration contracts walk: pass. There are no imports from other tasks; internal exports are listed for app/core consumption.
13. Contract types match: pass. Storage exports use `ResolvedObjectStoreConfig`, `ObjectClient`, and `StoredArtifactContent`; app/core/protocol consumers use those shapes.

## Plan Completeness Self-Test

- [x] Every acceptance criterion in the spec has at least one task that delivers it.
- [x] Every task has at least one acceptance criterion.
- [x] Every acceptance criterion has at least one test case.
- [x] Every error rescue map entry has a matching test case in `lens: error_path` or `lens: happy_shadow_*`.
- [x] Every integration contract import from another task resolves to a real export elsewhere; there are no cross-task imports in this one-task phase.
- [x] Every context file path exists in the project.
- [x] No task edits a file owned by another task.
- [x] No placeholder text is present.
- [x] Complexity is L and a sub-phase split was considered; the plan keeps one task because the user requested one coherent task and the write sets are not truly independent.
