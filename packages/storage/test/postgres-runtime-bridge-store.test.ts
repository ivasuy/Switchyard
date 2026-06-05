import { describe, expect, it } from "vitest";
import { PostgresHostedRuntimeBridgeCommandStore, HostedRuntimeBridgeCommandStoreError } from "../src/index.js";
import type { CreateHostedRuntimeBridgeCommandInput } from "../src/postgres/hosted-runtime-bridge-command-store.js";
import type { PostgresDatabaseHandle } from "../src/postgres/database.js";

function makeCreateInput(overrides: Partial<CreateHostedRuntimeBridgeCommandInput> = {}): CreateHostedRuntimeBridgeCommandInput {
  return {
    runId: "run_1",
    runtimeSessionId: "session_1",
    runtimeMode: "claude_code.sdk",
    operation: "input",
    idempotencyKey: `idem_${Math.random().toString(16).slice(2)}`,
    payloadHash: `hash_${Math.random().toString(16).slice(2)}`,
    payloadBytes: 128,
    redactedPayload: { kind: "text", bytes: 128, redacted: true },
    accountId: "account_1",
    tenantId: "tenant_1",
    projectId: "project_1",
    userId: "user_1",
    apiKeyId: "api_key_1",
    maxAttempts: 3,
    expiresAt: "2026-06-01T10:10:00.000Z",
    ...overrides
  };
}

describe("postgres hosted runtime bridge command store", () => {
  it("creates, claims once, and blocks second claim", async () => {
    const store = new PostgresHostedRuntimeBridgeCommandStore();
    const created = await store.create(makeCreateInput({ idempotencyKey: "idem_claim_once" }));
    expect(created.duplicate).toBe(false);
    expect(created.command.status).toBe("queued");

    const claimed = await store.claimNext({
      workerId: "worker_1",
      leaseMs: 30_000,
      now: "2026-06-01T10:00:00.000Z"
    });
    expect(claimed?.id).toBe(created.command.id);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.workerId).toBe("worker_1");
    expect(claimed?.leaseUntil).toBe("2026-06-01T10:00:30.000Z");

    const secondClaim = await store.claimNext({
      workerId: "worker_2",
      leaseMs: 30_000,
      now: "2026-06-01T10:00:01.000Z"
    });
    expect(secondClaim).toBeUndefined();
  });

  it("deduplicates same idempotency key with same payload hash", async () => {
    const store = new PostgresHostedRuntimeBridgeCommandStore();
    const input = makeCreateInput({ idempotencyKey: "idem_same", payloadHash: "hash_same" });
    const first = await store.create(input);
    const second = await store.create(input);

    expect(first.command.id).toBe(second.command.id);
    expect(second.duplicate).toBe(true);

    const byRun = await store.listByRun(input.runId);
    expect(byRun).toHaveLength(1);
  });

  it("rejects duplicate idempotency key with different payload hash", async () => {
    const store = new PostgresHostedRuntimeBridgeCommandStore();
    await store.create(makeCreateInput({ idempotencyKey: "idem_mismatch", payloadHash: "hash_a" }));

    await expect(
      store.create(makeCreateInput({ idempotencyKey: "idem_mismatch", payloadHash: "hash_b" }))
    ).rejects.toMatchObject({
      code: "hosted_runtime_bridge_payload_mismatch"
    } satisfies Partial<HostedRuntimeBridgeCommandStoreError>);

    const existing = await store.getByIdempotencyKey("idem_mismatch");
    expect(existing?.payloadHash).toBe("hash_a");
  });

  it("stores only redacted payload summary and ignores raw extras", async () => {
    const store = new PostgresHostedRuntimeBridgeCommandStore();
    const created = await store.create({
      ...makeCreateInput({ idempotencyKey: "idem_redacted", payloadHash: "hash_redacted" }),
      redactedPayload: { kind: "text", redacted: true, bytes: 222 }
    } as CreateHostedRuntimeBridgeCommandInput & {
      rawText: string;
      token: string;
      env: Record<string, string>;
      providerOutput: string;
    });

    const persisted = await store.get(created.command.id);
    expect(persisted?.redactedPayload).toEqual({ kind: "text", redacted: true, bytes: 222 });
    expect(persisted).not.toHaveProperty("rawText");
    expect(persisted).not.toHaveProperty("token");
    expect(persisted).not.toHaveProperty("env");
    expect(persisted).not.toHaveProperty("providerOutput");
  });

  it("keeps distinct payload hashes even when redacted payload summaries match", async () => {
    const store = new PostgresHostedRuntimeBridgeCommandStore();
    const summary = { kind: "approval_resolution", redacted: true, bytes: 64 };

    const first = await store.create(
      makeCreateInput({
        idempotencyKey: "idem_hash_1",
        payloadHash: "hash_secret_a",
        redactedPayload: summary
      })
    );
    const second = await store.create(
      makeCreateInput({
        idempotencyKey: "idem_hash_2",
        payloadHash: "hash_secret_b",
        redactedPayload: summary
      })
    );

    expect(first.command.payloadHash).not.toBe(second.command.payloadHash);
  });

  it("expires stale queued commands and skips them during claim", async () => {
    const store = new PostgresHostedRuntimeBridgeCommandStore();
    const created = await store.create(
      makeCreateInput({
        idempotencyKey: "idem_expire",
        expiresAt: "2026-06-01T09:59:59.000Z"
      })
    );

    const result = await store.expireStale({ now: "2026-06-01T10:00:00.000Z" });
    expect(result).toEqual({ expired: 1 });

    const claim = await store.claimNext({
      workerId: "worker_1",
      leaseMs: 10_000,
      now: "2026-06-01T10:00:00.000Z"
    });
    expect(claim).toBeUndefined();

    const after = await store.get(created.command.id);
    expect(after?.status).toBe("expired");
    expect(after?.reasonCode).toBe("hosted_runtime_bridge_command_expired");
  });

  it("fails stale claimed commands with non-idempotent retry blocked by default", async () => {
    const store = new PostgresHostedRuntimeBridgeCommandStore();
    const created = await store.create(
      makeCreateInput({
        idempotencyKey: "idem_stale_claim",
        expiresAt: "2026-06-01T10:20:00.000Z"
      })
    );

    const claimed = await store.claimNext({
      workerId: "worker_1",
      leaseMs: 1,
      now: "2026-06-01T10:00:00.000Z"
    });
    expect(claimed?.id).toBe(created.command.id);

    const recovered = await store.recoverStaleClaims({
      now: "2026-06-01T10:00:01.000Z",
      nonIdempotentPolicy: "fail"
    });
    expect(recovered).toEqual({ recovered: 0, failed: 1 });

    const after = await store.get(created.command.id);
    expect(after?.status).toBe("failed");
    expect(after?.reasonCode).toBe("hosted_runtime_bridge_non_idempotent_retry_blocked");
  });

  it("completes if claimed and blocks second completion or further claim", async () => {
    const store = new PostgresHostedRuntimeBridgeCommandStore();
    const created = await store.create(makeCreateInput({ idempotencyKey: "idem_complete_once" }));

    const claimed = await store.claimNext({
      workerId: "worker_1",
      leaseMs: 10_000,
      now: "2026-06-01T10:00:00.000Z"
    });
    expect(claimed?.id).toBe(created.command.id);

    const completed = await store.complete({
      commandId: created.command.id,
      workerId: "worker_1",
      now: "2026-06-01T10:00:01.000Z"
    });
    expect(completed?.status).toBe("completed");

    const again = await store.complete({
      commandId: created.command.id,
      workerId: "worker_1",
      now: "2026-06-01T10:00:02.000Z"
    });
    expect(again).toBeNull();

    const claimAfterComplete = await store.claimNext({
      workerId: "worker_2",
      leaseMs: 10_000,
      now: "2026-06-01T10:00:03.000Z"
    });
    expect(claimAfterComplete).toBeUndefined();
  });

  it("clears lease semantics for retryable requeue and terminal fail", async () => {
    const store = new PostgresHostedRuntimeBridgeCommandStore();
    const created = await store.create(makeCreateInput({ idempotencyKey: "idem_fail_lease" }));

    await store.claimNext({
      workerId: "worker_1",
      leaseMs: 10_000,
      now: "2026-06-01T10:00:00.000Z"
    });

    const retryable = await store.fail({
      commandId: created.command.id,
      workerId: "worker_1",
      reasonCode: "transient_error",
      retryable: true,
      now: "2026-06-01T10:00:01.000Z"
    });
    expect(retryable?.status).toBe("queued");
    expect(retryable?.leaseUntil).toBeUndefined();
    expect(retryable?.workerId).toBeUndefined();

    await store.claimNext({
      workerId: "worker_2",
      leaseMs: 10_000,
      now: "2026-06-01T10:00:02.000Z"
    });

    const terminal = await store.fail({
      commandId: created.command.id,
      workerId: "worker_2",
      reasonCode: "fatal_error",
      retryable: false,
      now: "2026-06-01T10:00:03.000Z"
    });
    expect(terminal?.status).toBe("failed");
    expect(terminal?.leaseUntil).toBeUndefined();
  });

  it("postgres fail query clears lease_until for both retryable and terminal transitions", async () => {
    const queryLog: string[] = [];
    const statusById = new Map<string, "claimed" | "queued" | "failed">([["command_1", "claimed"]]);
    const workerById = new Map<string, string | null>([["command_1", "worker_1"]]);

    const handle = {
      pool: {
        query: async (sql: string, params?: ReadonlyArray<unknown>) => {
          queryLog.push(sql);
          if (!params) {
            return { rows: [], rowCount: 0 };
          }
          const id = String(params[0]);
          const nextStatus = params[1] as "queued" | "failed";
          const reasonCode = String(params[2]);
          const now = String(params[3]);
          const workerId = params[4] === null || params[4] === undefined ? null : String(params[4]);

          const currentStatus = statusById.get(id);
          const currentWorker = workerById.get(id) ?? null;
          if (currentStatus !== "claimed") {
            return { rows: [], rowCount: 0 };
          }
          if (workerId !== null && workerId !== currentWorker) {
            return { rows: [], rowCount: 0 };
          }

          statusById.set(id, nextStatus);
          workerById.set(id, nextStatus === "queued" ? null : currentWorker);

          return {
            rows: [
              {
                id,
                run_id: "run_1",
                approval_id: null,
                runtime_session_id: "session_1",
                runtime_mode: "claude_code.sdk",
                operation: "input",
                status: nextStatus,
                idempotency_key: "idem_postgres_fail",
                payload_hash: "hash_postgres_fail",
                payload_bytes: 128,
                redacted_payload: { kind: "text", redacted: true },
                account_id: "account_1",
                tenant_id: "tenant_1",
                project_id: "project_1",
                user_id: "user_1",
                api_key_id: "api_key_1",
                worker_id: nextStatus === "queued" ? null : currentWorker,
                lease_until: null,
                attempts: 1,
                max_attempts: 3,
                reason_code: reasonCode,
                expires_at: "2026-06-01T10:10:00.000Z",
                created_at: "2026-06-01T10:00:00.000Z",
                updated_at: now
              }
            ],
            rowCount: 1
          };
        }
      },
      db: {} as PostgresDatabaseHandle["db"],
      real: true as const,
      close: async () => {}
    } satisfies PostgresDatabaseHandle;

    const store = new PostgresHostedRuntimeBridgeCommandStore(handle);

    const retryable = await store.fail({
      commandId: "command_1",
      workerId: "worker_1",
      reasonCode: "retryable_error",
      retryable: true,
      now: "2026-06-01T10:00:01.000Z"
    });
    expect(retryable?.status).toBe("queued");
    expect(retryable?.leaseUntil).toBeUndefined();
    expect(retryable?.workerId).toBeUndefined();

    statusById.set("command_1", "claimed");
    workerById.set("command_1", "worker_2");

    const terminal = await store.fail({
      commandId: "command_1",
      workerId: "worker_2",
      reasonCode: "fatal_error",
      retryable: false,
      now: "2026-06-01T10:00:02.000Z"
    });
    expect(terminal?.status).toBe("failed");
    expect(terminal?.leaseUntil).toBeUndefined();

    expect(queryLog[0]).toContain("lease_until = NULL");
    expect(queryLog[1]).toContain("lease_until = NULL");
  });

  it("returns undefined for unknown id and empty listByRun for unknown run", async () => {
    const store = new PostgresHostedRuntimeBridgeCommandStore();

    await expect(store.get("missing")).resolves.toBeUndefined();
    await expect(store.listByRun("run_missing")).resolves.toEqual([]);
  });
});
