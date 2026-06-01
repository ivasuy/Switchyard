import { describe, expect, it } from "vitest";
import { PostgresHostedRuntimeBridgeCommandStore, HostedRuntimeBridgeCommandStoreError } from "../src/index.js";
import type { CreateHostedRuntimeBridgeCommandInput } from "../src/postgres/hosted-runtime-bridge-command-store.js";

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

  it("returns undefined for unknown id and empty listByRun for unknown run", async () => {
    const store = new PostgresHostedRuntimeBridgeCommandStore();

    await expect(store.get("missing")).resolves.toBeUndefined();
    await expect(store.listByRun("run_missing")).resolves.toEqual([]);
  });
});
