import { describe, expect, it } from "vitest";
import type { ControlPlaneBootstrapInput } from "@switchyard/core";
import { hashApiKey } from "@switchyard/core";
import {
  PostgresControlPlaneStore,
  ensurePostgresSchema,
  openPostgresDatabase
} from "../src/index.js";

const NOW = "2026-05-31T10:00:00.000Z";
const RAW_KEY = "sk_sw_test_alpha";
const PEPPER = "pepper_123";

function createBootstrapInput(overrides?: {
  accountStatus?: "active" | "suspended" | "deleted";
  tenantStatus?: "active" | "suspended" | "deleted";
  projectStatus?: "active" | "archived" | "deleted";
  userStatus?: "active" | "suspended" | "deleted";
  apiKeyStatus?: "active" | "revoked" | "expired";
  planStatus?: "active" | "archived";
  includeRawKey?: boolean;
  secretHash?: string;
}): ControlPlaneBootstrapInput {
  const accountStatus = overrides?.accountStatus ?? "active";
  const tenantStatus = overrides?.tenantStatus ?? "active";
  const projectStatus = overrides?.projectStatus ?? "active";
  const userStatus = overrides?.userStatus ?? "active";
  const apiKeyStatus = overrides?.apiKeyStatus ?? "active";
  const planStatus = overrides?.planStatus ?? "active";
  const secretHash = overrides?.secretHash ?? hashApiKey(RAW_KEY, PEPPER);
  const apiKey: Record<string, unknown> = {
    id: "api_key_1",
    accountId: "account_1",
    tenantId: "tenant_1",
    projectId: "project_1",
    userId: "user_1",
    name: "primary",
    keyPrefix: "sk_sw",
    secretHash,
    scopes: ["runs:write", "runs:read", "audit:read", "artifacts:read", "nodes:write"],
    status: apiKeyStatus,
    createdAt: NOW
  };
  if (overrides?.includeRawKey) {
    apiKey["rawKey"] = RAW_KEY;
  }

  return {
    apiKeyPepper: PEPPER,
    accounts: [
      {
        id: "account_1",
        name: "Acme",
        status: accountStatus,
        billingPlanId: "billing_plan_1",
        createdAt: NOW
      }
    ],
    tenants: [
      {
        id: "tenant_1",
        accountId: "account_1",
        slug: "acme",
        displayName: "Acme",
        status: tenantStatus,
        createdAt: NOW
      }
    ],
    projects: [
      {
        id: "project_1",
        accountId: "account_1",
        tenantId: "tenant_1",
        slug: "production",
        displayName: "Production",
        status: projectStatus,
        createdAt: NOW
      }
    ],
    users: [
      {
        id: "user_1",
        accountId: "account_1",
        tenantId: "tenant_1",
        displayName: "Owner",
        email: "owner@example.com",
        status: userStatus,
        createdAt: NOW
      }
    ],
    apiKeys: [apiKey],
    billingPlans: [
      {
        id: "billing_plan_1",
        slug: "enterprise_standard",
        displayName: "Enterprise",
        status: planStatus,
        entitlements: {
          allowedPlacements: ["hosted", "local", "connected_local_node"],
          allowedRuntimeModes: ["fake.deterministic"],
          allowHostedRealRuntime: false,
          allowConnectedNodes: true,
          allowArtifactContentRead: true,
          allowMetricsRead: false,
          allowAuditRead: true
        },
        quotas: {
          maxRunsPerHour: 10,
          maxActiveRuns: 2,
          maxRunTimeoutSeconds: 300,
          maxConnectedNodes: 1,
          maxArtifactContentReadBytesPerHour: 2_048
        },
        createdAt: NOW
      }
    ]
  } as unknown as ControlPlaneBootstrapInput;
}

function createApiKeyRecord(input: {
  id: string;
  userId: string;
  secretHash: string;
  keyPrefix?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    accountId: "account_1",
    tenantId: "tenant_1",
    projectId: "project_1",
    userId: input.userId,
    name: input.id,
    keyPrefix: input.keyPrefix ?? "sk_sw",
    secretHash: input.secretHash,
    scopes: ["runs:write", "runs:read", "audit:read", "artifacts:read", "nodes:write"],
    status: "active",
    createdAt: NOW
  };
}

describe("PostgresControlPlaneStore (in-memory fallback)", () => {
  it("bootstraps active records and resolves api key bundle by prefix/hash", async () => {
    const store = new PostgresControlPlaneStore();
    const summary = await store.bootstrap(createBootstrapInput({ includeRawKey: true }));

    expect(summary.active.accounts).toBeGreaterThan(0);
    expect(summary.active.tenants).toBeGreaterThan(0);
    expect(summary.active.projects).toBeGreaterThan(0);
    expect(summary.active.users).toBeGreaterThan(0);
    expect(summary.active.apiKeys).toBeGreaterThan(0);
    expect(summary.active.billingPlans).toBeGreaterThan(0);

    const bundle = await store.loadApiKeyBundleByHash({
      keyPrefix: "sk_sw",
      secretHash: hashApiKey(RAW_KEY, PEPPER),
      now: NOW
    });

    expect(bundle?.apiKey.keyPrefix).toBe("sk_sw");
    expect(bundle?.apiKey.secretHash).toBe(hashApiKey(RAW_KEY, PEPPER));
    expect(bundle?.apiKey.secretHash).not.toBe(RAW_KEY);
    expect(JSON.stringify(bundle)).not.toContain(RAW_KEY);
  });

  it("returns null for wrong hash and only hash-matching candidates for same-prefix collisions", async () => {
    const store = new PostgresControlPlaneStore();
    const firstRaw = "sk_sw_test_alpha";
    const secondRaw = "sk_sw_test_beta";
    const firstHash = hashApiKey(firstRaw, PEPPER);
    const secondHash = hashApiKey(secondRaw, PEPPER);

    const bootstrap = createBootstrapInput();
    (bootstrap as unknown as { users: Array<Record<string, unknown>> }).users.push({
      id: "user_2",
      accountId: "account_1",
      tenantId: "tenant_1",
      displayName: "Owner 2",
      email: "owner2@example.com",
      status: "active",
      createdAt: NOW
    });
    (bootstrap as unknown as { apiKeys: Array<Record<string, unknown>> }).apiKeys = [
      createApiKeyRecord({ id: "api_key_1", userId: "user_1", secretHash: firstHash }),
      createApiKeyRecord({ id: "api_key_2", userId: "user_2", secretHash: secondHash })
    ];
    await store.bootstrap(bootstrap);

    const wrongHash = await store.loadApiKeyBundleByHash({
      keyPrefix: "sk_sw",
      secretHash: hashApiKey("sk_sw_test_wrong", PEPPER),
      now: NOW
    });
    expect(wrongHash).toBeNull();

    const matched = await store.loadApiKeyBundleByHash({
      keyPrefix: "sk_sw",
      secretHash: firstHash,
      now: NOW
    });
    expect(matched?.apiKey.id).toBe("api_key_1");
    expect(matched?.apiKey.secretHash).toBe(firstHash);
    expect(matched?.candidateBundles?.every((entry) => entry.apiKey.secretHash === firstHash)).toBe(true);
  });

  it("rejects empty bootstrap", async () => {
    const store = new PostgresControlPlaneStore();
    await expect(
      store.bootstrap(
        {
          accounts: [],
          tenants: [],
          projects: [],
          users: [],
          apiKeys: [],
          billingPlans: []
        } as unknown as ControlPlaneBootstrapInput
      )
    ).rejects.toMatchObject({ code: "control_plane_bootstrap_empty" });
  });

  it("rejects duplicate ids and malformed relations", async () => {
    const store = new PostgresControlPlaneStore();
    const duplicate = createBootstrapInput();
    (duplicate as unknown as { tenants: Array<Record<string, unknown>> }).tenants.push({
      id: "tenant_1",
      accountId: "account_1",
      slug: "dup",
      displayName: "Dup",
      status: "active",
      createdAt: NOW
    });
    await expect(store.bootstrap(duplicate)).rejects.toMatchObject({ code: "control_plane_bootstrap_duplicate" });

    const malformed = createBootstrapInput();
    (malformed as unknown as { projects: Array<Record<string, unknown>> }).projects[0] = {
      id: "project_1",
      accountId: "account_missing",
      tenantId: "tenant_1",
      slug: "production",
      displayName: "Production",
      status: "active",
      createdAt: NOW
    };
    await expect(store.bootstrap(malformed)).rejects.toMatchObject({ code: "control_plane_bootstrap_malformed" });
  });

  it("rejects zero-active and inactive-plan linkage for active key", async () => {
    const zeroActive = new PostgresControlPlaneStore();
    await expect(
      zeroActive.bootstrap(
        createBootstrapInput({
          accountStatus: "suspended",
          tenantStatus: "suspended",
          projectStatus: "archived",
          userStatus: "suspended",
          apiKeyStatus: "revoked",
          planStatus: "archived"
        })
      )
    ).rejects.toMatchObject({ code: "control_plane_bootstrap_zero_active" });

    const inactivePlan = new PostgresControlPlaneStore();
    await expect(inactivePlan.bootstrap(createBootstrapInput({ planStatus: "archived" }))).rejects.toMatchObject({
      code: "control_plane_bootstrap_inactive_plan"
    });
  });

  it("rejects raw-secret persistence attempts", async () => {
    const store = new PostgresControlPlaneStore();
    await expect(store.bootstrap(createBootstrapInput({ secretHash: RAW_KEY }))).rejects.toMatchObject({
      code: "control_plane_bootstrap_malformed"
    });
  });

  it("supports ownership attach/get/list and conflict checks", async () => {
    const store = new PostgresControlPlaneStore();
    await store.attachOwnership({
      resourceType: "run",
      resourceId: "run_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      userId: "user_1",
      apiKeyId: "api_key_1",
      createdAt: NOW
    });
    await store.attachOwnership({
      resourceType: "run",
      resourceId: "run_2",
      accountId: "account_2",
      tenantId: "tenant_2",
      projectId: "project_2",
      userId: "user_2",
      apiKeyId: "api_key_2",
      createdAt: NOW
    });

    const same = await store.attachOwnership({
      resourceType: "run",
      resourceId: "run_1",
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      userId: "user_1",
      apiKeyId: "api_key_1",
      createdAt: NOW
    });
    expect(same.resourceId).toBe("run_1");

    await expect(
      store.attachOwnership({
        resourceType: "run",
        resourceId: "run_1",
        accountId: "account_2",
        tenantId: "tenant_2",
        projectId: "project_2",
        userId: "user_2",
        apiKeyId: "api_key_2",
        createdAt: NOW
      })
    ).rejects.toMatchObject({ code: "ownership_conflict" });

    expect(await store.getOwnership({ resourceType: "run", resourceId: "run_1" })).toMatchObject({
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1"
    });
    expect(
      await store.listOwnedResourceIds({
        resourceType: "run",
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1"
      })
    ).toEqual(["run_1"]);
  });

  it("serializes quota reservations under max=1 and validates transitions", async () => {
    const store = new PostgresControlPlaneStore();
    const scope = {
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      quotaKind: "connected_nodes" as const
    };
    const reserveInput = {
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      quotaKind: "connected_nodes" as const,
      amount: 1,
      maxAllowed: 1,
      windowMs: 60_000,
      reservationTtlMs: 60_000,
      reasonCode: "node_register",
      now: NOW
    };

    const [first, second] = await Promise.allSettled([
      store.withQuotaCriticalSection(scope, async () => store.reserveQuota(reserveInput)),
      store.withQuotaCriticalSection(scope, async () => store.reserveQuota(reserveInput))
    ]);
    const fulfilled = [first, second].filter((entry) => entry.status === "fulfilled");
    const rejected = [first, second].filter((entry) => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reservation = (fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value;
    const consumed = await store.transitionQuotaReservation({
      reservationId: reservation.id,
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      nextState: "consumed",
      now: NOW
    });
    expect(consumed.state).toBe("consumed");

    await expect(
      store.transitionQuotaReservation({
        reservationId: reservation.id,
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1",
        nextState: "released",
        now: NOW
      })
    ).rejects.toMatchObject({ code: "invalid_quota_transition" });
  });

  it("allows replacing consumed connected_nodes reservation within the same hour when no active nodes exist", async () => {
    const store = new PostgresControlPlaneStore();
    const reserveInput = {
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      quotaKind: "connected_nodes" as const,
      amount: 1,
      maxAllowed: 1,
      windowMs: 60 * 60 * 1_000,
      reservationTtlMs: 5 * 60 * 1_000,
      reasonCode: "node_register",
      now: NOW
    };

    const first = await store.reserveQuota(reserveInput);
    await store.transitionQuotaReservation({
      reservationId: first.id,
      accountId: first.accountId,
      tenantId: first.tenantId,
      projectId: first.projectId,
      nextState: "consumed",
      now: NOW
    });

    const second = await store.reserveQuota({
      ...reserveInput,
      now: new Date(Date.parse(NOW) + 30_000).toISOString()
    });
    expect(second.state).toBe("reserved");
  });

  it("expires stale reservations", async () => {
    const store = new PostgresControlPlaneStore();
    await store.reserveQuota({
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      quotaKind: "runs_per_hour",
      amount: 1,
      maxAllowed: 5,
      windowMs: 60_000,
      reservationTtlMs: 10,
      reasonCode: "run_create",
      now: NOW
    });
    const expired = await store.expireStaleReservations({ now: new Date(Date.parse(NOW) + 1000).toISOString() });
    expect(expired).toBe(1);
  });

  it("appends/lists tenant-scoped audit events and rejects malformed cursor", async () => {
    const store = new PostgresControlPlaneStore();
    await store.appendAuditEvent({
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      actorType: "api_key",
      actorUserId: "user_1",
      apiKeyId: "api_key_1",
      eventType: "api_key.auth_succeeded",
      decision: "allow",
      payload: { ok: true },
      createdAt: NOW
    });
    await store.appendAuditEvent({
      accountId: "account_2",
      tenantId: "tenant_2",
      projectId: "project_2",
      actorType: "api_key",
      actorUserId: "user_2",
      apiKeyId: "api_key_2",
      eventType: "api_key.auth_succeeded",
      decision: "allow",
      payload: { ok: true },
      createdAt: NOW
    });

    const page = await store.listAuditEvents({
      accountId: "account_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      limit: 10
    });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.tenantId).toBe("tenant_1");

    await expect(
      store.listAuditEvents({
        accountId: "account_1",
        tenantId: "tenant_1",
        cursor: "%%%not-base64%%%"
      })
    ).rejects.toMatchObject({ code: "invalid_query" });
  });
});

describe("PostgresControlPlaneStore (real Postgres optional)", () => {
  it("runs when SWITCHYARD_TEST_POSTGRES_URL is configured and skips safely otherwise", async () => {
    const url = process.env["SWITCHYARD_TEST_POSTGRES_URL"];
    if (!url) {
      expect("SKIPPED_SWITCHYARD_TEST_POSTGRES_URL_UNSET").toContain("SKIPPED");
      return;
    }

    const opened = openPostgresDatabase(url);
    try {
      await ensurePostgresSchema(opened);
      const store = new PostgresControlPlaneStore(opened);
      await store.bootstrap(createBootstrapInput());
      const bundle = await store.loadApiKeyBundleByHash({
        keyPrefix: "sk_sw",
        secretHash: hashApiKey(RAW_KEY, PEPPER),
        now: NOW
      });
      expect(bundle?.tenant.id).toBe("tenant_1");
    } finally {
      await opened.close();
    }
  });
});
