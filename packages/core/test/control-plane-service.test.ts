import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ActiveNodeCountInput,
  ActiveRunCountInput,
  AppendAuditEventInput,
  AttachOwnershipInput,
  AuditEventsPage,
  AuthBundle,
  ControlPlaneStore,
  ExpireReservationsInput,
  GetOwnershipInput,
  ListAuditEventsInput as StoreListAuditEventsInput,
  ListOwnedResourceIdsInput,
  LoadApiKeyBundleInput,
  QuotaCriticalSectionScope,
  ReserveQuotaInput,
  TransitionQuotaReservationInput
} from "../src/ports/control-plane-store.js";
import {
  ControlPlaneError,
  ControlPlaneService,
  TERMINAL_RUN_STATUSES,
  hashApiKey
} from "../src/services/control-plane-service.js";
import type {
  Account,
  ApiKeyStored,
  AuditLogEvent,
  AuthContext,
  BillingPlan,
  EnterpriseScope,
  Project,
  QuotaReservation,
  ResourceOwnership,
  Tenant,
  User
} from "@switchyard/contracts";
import {
  billingPlanSchema as billingPlanSchemaRuntime,
  entitlementSnapshotSchema as entitlementSnapshotSchemaRuntime
} from "@switchyard/contracts";

const NOW = "2026-05-31T10:00:00.000Z";

function iso(minutesFromNow: number): string {
  return new Date(Date.parse(NOW) + minutesFromNow * 60_000).toISOString();
}

function digest(raw: string, pepper: string): string {
  return createHmac("sha256", pepper).update(raw).digest("hex");
}

function createPlan(overrides?: Partial<BillingPlan>): BillingPlan {
  return {
    id: "billing_plan_1",
    slug: "enterprise_standard",
    displayName: "Enterprise",
    status: "active",
    entitlements: {
      allowedPlacements: ["hosted", "local", "connected_local_node"],
      allowedRuntimeModes: ["fake.deterministic", "codex.exec_json"],
      allowHostedRealRuntime: false,
      allowConnectedNodes: true,
      allowArtifactContentRead: true,
      allowMetricsRead: false,
      allowAuditRead: true
    },
    quotas: {
      maxRunsPerHour: 10,
      maxActiveRuns: 2,
      maxRunTimeoutSeconds: 120,
      maxConnectedNodes: 1,
      maxArtifactContentReadBytesPerHour: 2048
    },
    createdAt: "2026-05-31T00:00:00.000Z",
    ...overrides
  };
}

function createBaseBundle(rawKey: string, pepper: string, overrides?: Partial<AuthBundle>): AuthBundle {
  const account: Account = {
    id: "account_1",
    name: "Acme",
    status: "active",
    billingPlanId: "billing_plan_1",
    createdAt: "2026-05-31T00:00:00.000Z"
  };
  const tenant: Tenant = {
    id: "tenant_1",
    accountId: "account_1",
    slug: "acme",
    displayName: "Acme",
    status: "active",
    createdAt: "2026-05-31T00:00:00.000Z"
  };
  const project: Project = {
    id: "project_1",
    accountId: "account_1",
    tenantId: "tenant_1",
    slug: "prod",
    displayName: "Production",
    status: "active",
    createdAt: "2026-05-31T00:00:00.000Z"
  };
  const user: User = {
    id: "user_1",
    accountId: "account_1",
    tenantId: "tenant_1",
    displayName: "Vasu",
    email: "vasu@example.com",
    status: "active",
    createdAt: "2026-05-31T00:00:00.000Z"
  };
  const apiKey: ApiKeyStored = {
    id: "api_key_1",
    accountId: "account_1",
    tenantId: "tenant_1",
    projectId: "project_1",
    userId: "user_1",
    name: "primary",
    keyPrefix: "sk_sw",
    secretHash: digest(rawKey, pepper),
    scopes: ["runs:write", "artifacts:read", "nodes:write", "audit:read", "entitlements:read"],
    status: "active",
    createdAt: "2026-05-31T00:00:00.000Z"
  };
  const plan = createPlan();
  return {
    account,
    tenant,
    project,
    user,
    apiKey,
    plan,
    ...overrides
  };
}

function createSecondBundle(rawKey: string, pepper: string): AuthBundle {
  return createBaseBundle(rawKey, pepper, {
    account: {
      id: "account_2",
      name: "Beta",
      status: "active",
      billingPlanId: "billing_plan_2",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    tenant: {
      id: "tenant_2",
      accountId: "account_2",
      slug: "beta",
      displayName: "Beta",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    project: {
      id: "project_2",
      accountId: "account_2",
      tenantId: "tenant_2",
      slug: "staging",
      displayName: "Staging",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    user: {
      id: "user_2",
      accountId: "account_2",
      tenantId: "tenant_2",
      displayName: "Beta User",
      email: "beta@example.com",
      status: "active",
      createdAt: "2026-05-31T00:00:00.000Z"
    },
    apiKey: {
      ...createBaseBundle(rawKey, pepper).apiKey,
      id: "api_key_2",
      accountId: "account_2",
      tenantId: "tenant_2",
      projectId: "project_2",
      userId: "user_2",
      secretHash: digest(rawKey, pepper)
    },
    plan: {
      ...createPlan({
        id: "billing_plan_2"
      })
    }
  });
}

class InMemoryControlPlaneStore implements ControlPlaneStore {
  readonly bundles: AuthBundle[] = [];
  readonly reservations = new Map<string, QuotaReservation>();
  readonly ownership = new Map<string, ResourceOwnership>();
  readonly auditEvents: AuditLogEvent[] = [];
  readonly usage = new Map<string, { used: number; windowStartedAt: string; windowEndsAt: string }>();

  loadCalls = 0;
  throwOnLoad = false;
  withDelayMs = 0;

  private criticalChains = new Map<string, Promise<void>>();

  async loadApiKeyBundleByHash(_input: LoadApiKeyBundleInput): Promise<AuthBundle | null> {
    this.loadCalls += 1;
    if (this.throwOnLoad) {
      throw new Error("store unavailable");
    }
    const prefix = _input.keyPrefix;
    const matching = this.bundles.filter((bundle) => bundle.apiKey.keyPrefix === prefix);
    if (matching.length === 0) {
      return null;
    }
    const [first, ...rest] = matching;
    return {
      ...first,
      candidateBundles: [first, ...rest]
    };
  }

  async bootstrap() {
    return {
      total: { accounts: 1, tenants: 1, projects: 1, users: 1, apiKeys: 1, billingPlans: 1 },
      active: { accounts: 1, tenants: 1, projects: 1, users: 1, apiKeys: 1, billingPlans: 1 }
    };
  }

  async reserveQuota(input: ReserveQuotaInput): Promise<QuotaReservation> {
    const scope = `${input.accountId}:${input.tenantId}:${input.projectId}:${input.quotaKind}`;
    const nowMs = Date.parse(input.now ?? NOW);
    const windowStartMs = nowMs - input.windowMs;
    const currentWindow = this.usage.get(scope);
    if (!currentWindow || Date.parse(currentWindow.windowEndsAt) <= nowMs) {
      this.usage.set(scope, {
        used: 0,
        windowStartedAt: new Date(windowStartMs).toISOString(),
        windowEndsAt: new Date(nowMs + input.windowMs).toISOString()
      });
    }
    const usage = this.usage.get(scope);
    if (!usage) {
      throw new Error("missing usage window");
    }
    const reserved = [...this.reservations.values()].filter(
      (row) =>
        row.accountId === input.accountId &&
        row.tenantId === input.tenantId &&
        row.projectId === input.projectId &&
        row.quotaKind === input.quotaKind &&
        row.state === "reserved" &&
        Date.parse(row.expiresAt) > nowMs
    );
    const pending = reserved.reduce((sum, row) => sum + row.amount, 0);
    const nextTotal = usage.used + pending + input.amount;
    if (nextTotal > input.maxAllowed) {
      throw new Error("quota_exceeded");
    }

    if (this.withDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.withDelayMs));
    }

    const reservation: QuotaReservation = {
      id: `quota_reservation_${this.reservations.size + 1}`,
      accountId: input.accountId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      quotaKind: input.quotaKind,
      amount: input.amount,
      state: "reserved",
      reasonCode: input.reasonCode,
      createdAt: input.now ?? NOW,
      expiresAt: new Date(nowMs + input.reservationTtlMs).toISOString()
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  async transitionQuotaReservation(input: TransitionQuotaReservationInput): Promise<QuotaReservation> {
    const current = this.reservations.get(input.reservationId);
    if (!current) {
      throw new Error("reservation_not_found");
    }
    const sameScope =
      current.accountId === input.accountId &&
      current.tenantId === input.tenantId &&
      current.projectId === input.projectId;
    if (!sameScope) {
      throw new Error("reservation_scope_mismatch");
    }
    const next: QuotaReservation = {
      ...current,
      state: input.nextState,
      finalizedAt: input.finalizedAt ?? input.now ?? NOW,
      reasonCode: input.reasonCode ?? current.reasonCode
    };
    this.reservations.set(current.id, next);
    if (input.nextState === "consumed") {
      const scope = `${current.accountId}:${current.tenantId}:${current.projectId}:${current.quotaKind}`;
      const usage = this.usage.get(scope);
      if (usage) {
        usage.used += current.amount;
      }
    }
    return next;
  }

  async withQuotaCriticalSection<T>(scope: QuotaCriticalSectionScope, fn: () => Promise<T>): Promise<T> {
    const key = `${scope.accountId}:${scope.tenantId}:${scope.projectId}:${scope.quotaKind}`;
    const prior = this.criticalChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const baton = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.criticalChains.set(key, prior.then(() => baton));
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async attachOwnership(input: AttachOwnershipInput): Promise<ResourceOwnership> {
    const key = `${input.resourceType}:${input.resourceId}`;
    const existing = this.ownership.get(key);
    if (existing) {
      const matches =
        existing.accountId === input.accountId &&
        existing.tenantId === input.tenantId &&
        existing.projectId === input.projectId &&
        existing.userId === input.userId &&
        existing.apiKeyId === input.apiKeyId;
      if (!matches) {
        throw new Error("ownership_conflict");
      }
      return existing;
    }
    const created: ResourceOwnership = {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      accountId: input.accountId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      createdAt: input.createdAt ?? NOW
    };
    this.ownership.set(key, created);
    return created;
  }

  async getOwnership(input: GetOwnershipInput): Promise<ResourceOwnership | null> {
    return this.ownership.get(`${input.resourceType}:${input.resourceId}`) ?? null;
  }

  async listOwnedResourceIds(input: ListOwnedResourceIdsInput): Promise<readonly string[]> {
    return [...this.ownership.values()]
      .filter(
        (entry) =>
          entry.resourceType === input.resourceType &&
          entry.accountId === input.accountId &&
          entry.tenantId === input.tenantId &&
          entry.projectId === input.projectId
      )
      .map((entry) => entry.resourceId);
  }

  async countActiveOwnedRuns(input: ActiveRunCountInput): Promise<number> {
    const ownedRunCount = [...this.ownership.values()].filter(
      (entry) =>
        entry.resourceType === "run" &&
        entry.accountId === input.accountId &&
        entry.tenantId === input.tenantId &&
        entry.projectId === input.projectId &&
        !TERMINAL_RUN_STATUSES.includes((entry.metadata?.status as any) ?? "queued")
    ).length;

    if (!input.includeUnexpiredReservations) {
      return ownedRunCount;
    }

    const nowMs = Date.parse(input.now ?? NOW);
    const reservations = [...this.reservations.values()].filter(
      (reservation) =>
        reservation.accountId === input.accountId &&
        reservation.tenantId === input.tenantId &&
        reservation.projectId === input.projectId &&
        reservation.state === "reserved" &&
        Date.parse(reservation.expiresAt) > nowMs &&
        (input.reservationQuotaKinds?.includes(reservation.quotaKind) ?? true)
    );
    return ownedRunCount + reservations.length;
  }

  async countActiveOwnedNodes(input: ActiveNodeCountInput): Promise<number> {
    const nowMs = Date.parse(input.now ?? NOW);
    return [...this.ownership.values()].filter((entry) => {
      if (entry.resourceType !== "node") {
        return false;
      }
      if (
        entry.accountId !== input.accountId ||
        entry.tenantId !== input.tenantId ||
        entry.projectId !== input.projectId
      ) {
        return false;
      }
      const heartbeatExpiresAt = entry.metadata?.heartbeatExpiresAt;
      if (typeof heartbeatExpiresAt !== "string") {
        return true;
      }
      return Date.parse(heartbeatExpiresAt) > nowMs;
    }).length;
  }

  async appendAuditEvent(input: AppendAuditEventInput): Promise<AuditLogEvent> {
    const event: AuditLogEvent = {
      id: `audit_${this.auditEvents.length + 1}`,
      accountId: input.accountId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      apiKeyId: input.apiKeyId,
      eventType: input.eventType,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      decision: input.decision,
      reasonCode: input.reasonCode,
      requestId: input.requestId,
      payload: input.payload,
      createdAt: input.createdAt ?? NOW
    };
    this.auditEvents.push(event);
    return event;
  }

  async listAuditEvents(input: StoreListAuditEventsInput): Promise<AuditEventsPage> {
    const filtered = this.auditEvents.filter(
      (event) =>
        event.accountId === input.accountId &&
        event.tenantId === input.tenantId &&
        (input.projectId ? event.projectId === input.projectId : true)
    );
    const limit = input.limit ?? 50;
    return {
      events: filtered.slice(0, limit),
      nextCursor: filtered.length > limit ? "next" : undefined
    };
  }

  async countUnownedResources() {
    return {
      runs: 0,
      runEvents: 0,
      artifacts: 0,
      placements: 0,
      nodes: 0,
      assignments: 0,
      auditEvents: 0,
      quotaReservations: 0
    };
  }

  async expireStaleReservations(input: ExpireReservationsInput): Promise<number> {
    const nowMs = Date.parse(input.now ?? NOW);
    let expired = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.state === "reserved" && Date.parse(reservation.expiresAt) <= nowMs) {
        this.reservations.set(reservation.id, {
          ...reservation,
          state: "expired",
          finalizedAt: input.now ?? NOW,
          reasonCode: "reservation_expired"
        });
        expired += 1;
      }
    }
    return expired;
  }
}

function createServiceFixture(rawKey = "sk_sw_test_alpha") {
  const pepper = "pepper_123";
  const store = new InMemoryControlPlaneStore();
  store.bundles.push(createBaseBundle(rawKey, pepper));
  const service = new ControlPlaneService({
    store,
    apiKeyPepper: pepper,
    now: () => NOW
  });
  return { service, store, rawKey, pepper };
}

describe("hashApiKey", () => {
  it("produces deterministic hmac-sha256 digest", () => {
    expect(hashApiKey("sk_sw_test_alpha", "pepper_123")).toBe(digest("sk_sw_test_alpha", "pepper_123"));
  });
});

describe("ControlPlaneService.authenticateRequest", () => {
  it("accepts bearer and x-switchyard-api-key with identical auth context", async () => {
    const { service, rawKey } = createServiceFixture();
    const bearer = await service.authenticateRequest({
      headers: {
        authorization: `Bearer ${rawKey}`
      }
    });
    const header = await service.authenticateRequest({
      headers: {
        "x-switchyard-api-key": rawKey
      }
    });
    expect(bearer.apiKey.id).toBe(header.apiKey.id);
    expect(bearer.tenant.id).toBe("tenant_1");
  });

  it("accepts duplicate matching headers and rejects conflicting headers", async () => {
    const { service, rawKey } = createServiceFixture();
    await expect(
      service.authenticateRequest({
        headers: {
          authorization: `Bearer ${rawKey}`,
          "x-switchyard-api-key": rawKey
        }
      })
    ).resolves.toBeDefined();

    await expect(
      service.authenticateRequest({
        headers: {
          authorization: `Bearer ${rawKey}`,
          "x-switchyard-api-key": "sk_sw_other"
        }
      })
    ).rejects.toMatchObject({
      code: "auth_conflict",
      reasonCode: "conflicting_credentials"
    });
  });

  it("rejects missing, blank, malformed, wrong-scheme, duplicate bearer, whitespace-only, and query credentials", async () => {
    const { service, store } = createServiceFixture();

    await expect(service.authenticateRequest({ headers: {} })).rejects.toMatchObject({
      code: "auth_required"
    });
    await expect(service.authenticateRequest({ headers: { authorization: "Bearer " } })).rejects.toMatchObject({
      code: "auth_failed",
      reasonCode: "malformed_authorization"
    });
    await expect(service.authenticateRequest({ headers: { authorization: "Basic abc" } })).rejects.toMatchObject({
      code: "auth_failed",
      reasonCode: "malformed_authorization"
    });
    await expect(
      service.authenticateRequest({ headers: { authorization: "Bearer Bearer sk_sw_test_alpha" } })
    ).rejects.toMatchObject({
      code: "auth_failed",
      reasonCode: "malformed_authorization"
    });
    await expect(
      service.authenticateRequest({ headers: { "x-switchyard-api-key": " \t " } })
    ).rejects.toMatchObject({
      code: "auth_failed",
      reasonCode: "blank_key_material"
    });
    await expect(
      service.authenticateRequest({ query: { api_key: "sk_sw_test_alpha" }, headers: {} })
    ).rejects.toMatchObject({
      code: "auth_failed",
      reasonCode: "query_credentials_not_allowed"
    });

    expect(store.loadCalls).toBe(0);
  });

  it("maps store failures to auth_store_unavailable", async () => {
    const { service, store, rawKey } = createServiceFixture();
    store.throwOnLoad = true;

    await expect(
      service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } })
    ).rejects.toMatchObject({
      code: "auth_store_unavailable"
    });
  });

  it("handles revoked, expired, and inactive states with safe denial", async () => {
    const { service, rawKey, store, pepper } = createServiceFixture();
    store.bundles.length = 0;
    store.bundles.push(
      createBaseBundle(rawKey, pepper, {
        apiKey: {
          ...createBaseBundle(rawKey, pepper).apiKey,
          status: "revoked"
        }
      })
    );

    await expect(
      service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } })
    ).rejects.toMatchObject({
      code: "auth_failed",
      reasonCode: "api_key_revoked"
    });

    store.bundles[0] = createBaseBundle(rawKey, pepper, {
      apiKey: {
        ...createBaseBundle(rawKey, pepper).apiKey,
        status: "active",
        expiresAt: iso(-1)
      }
    });
    await expect(
      service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } })
    ).rejects.toMatchObject({
      code: "auth_failed",
      reasonCode: "api_key_expired"
    });

    store.bundles[0] = createBaseBundle(rawKey, pepper, {
      account: { ...createBaseBundle(rawKey, pepper).account, status: "suspended" }
    });
    await expect(
      service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } })
    ).rejects.toMatchObject({
      code: "auth_failed",
      reasonCode: "account_inactive"
    });

    store.bundles[0] = createBaseBundle(rawKey, pepper, {
      tenant: { ...createBaseBundle(rawKey, pepper).tenant, status: "suspended" }
    });
    await expect(
      service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } })
    ).rejects.toMatchObject({
      code: "auth_failed",
      reasonCode: "tenant_inactive"
    });

    store.bundles[0] = createBaseBundle(rawKey, pepper, {
      project: { ...createBaseBundle(rawKey, pepper).project, status: "archived" }
    });
    await expect(
      service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } })
    ).rejects.toMatchObject({
      code: "auth_failed",
      reasonCode: "project_inactive"
    });

    store.bundles[0] = createBaseBundle(rawKey, pepper, {
      user: { ...createBaseBundle(rawKey, pepper).user, status: "deleted" }
    });
    await expect(
      service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } })
    ).rejects.toMatchObject({
      code: "auth_failed",
      reasonCode: "user_inactive"
    });

    store.bundles[0] = createBaseBundle(rawKey, pepper, {
      plan: {
        ...createPlan(),
        status: "archived"
      }
    });
    await expect(
      service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } })
    ).rejects.toMatchObject({
      code: "entitlement_denied",
      reasonCode: "plan_inactive"
    });
  });

  it("compares prefix collisions safely and ignores malformed stored hashes", async () => {
    const { service, store, rawKey, pepper } = createServiceFixture();
    const otherKey = "sk_sw_test_beta";

    store.bundles.length = 0;
    store.bundles.push(
      createBaseBundle(otherKey, pepper, {
        apiKey: {
          ...createBaseBundle(otherKey, pepper).apiKey,
          id: "api_key_bad",
          secretHash: "this-is-not-hex"
        }
      }),
      createBaseBundle(rawKey, pepper, {
        apiKey: {
          ...createBaseBundle(rawKey, pepper).apiKey,
          id: "api_key_good",
          secretHash: digest(rawKey, pepper)
        }
      })
    );

    const auth = await service.authenticateRequest({
      headers: {
        authorization: `Bearer ${rawKey}`
      }
    });
    expect(auth.apiKey.id).toBe("api_key_good");
  });
});

describe("ControlPlaneService authz + quota preflights", () => {
  it("enforces run preflight entitlements and reservations", async () => {
    const { service, store, rawKey } = createServiceFixture();
    const auth = await service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } });

    const reservation = await service.preflightRunCreate({
      auth,
      placement: "hosted",
      runtimeMode: "fake.deterministic",
      timeoutSeconds: 60,
      now: NOW
    });

    expect(reservation.state).toBe("reserved");
    expect(reservation.quotaKind).toBe("runs_per_hour");

    await service.releaseQuotaReservation({
      auth,
      reservationId: reservation.id,
      outcome: "consumed",
      reasonCode: "run_created",
      now: NOW
    });

    expect(store.reservations.get(reservation.id)?.state).toBe("consumed");
  });

  it("serializes concurrent run reservations under max=1", async () => {
    const { service, store, rawKey } = createServiceFixture();
    const auth = await service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } });
    auth.entitlement.quotas.maxRunsPerHour = 1;
    auth.entitlement.quotas.maxActiveRuns = 10;
    store.withDelayMs = 20;

    const [first, second] = await Promise.allSettled([
      service.preflightRunCreate({
        auth,
        placement: "hosted",
        runtimeMode: "fake.deterministic",
        timeoutSeconds: 60,
        now: NOW
      }),
      service.preflightRunCreate({
        auth,
        placement: "hosted",
        runtimeMode: "fake.deterministic",
        timeoutSeconds: 60,
        now: NOW
      })
    ]);

    const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
    const rejected = [first, second].filter((result) => result.status === "rejected") as Array<PromiseRejectedResult>;

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: "quota_exceeded",
      reasonCode: "runs_per_hour_exceeded"
    });
  });

  it("denies hosted real runtime when entitlement disallows it before reservation", async () => {
    const { service, store, rawKey, pepper } = createServiceFixture();
    store.bundles[0] = createBaseBundle(rawKey, pepper, {
      plan: createPlan({
        entitlements: {
          ...createPlan().entitlements,
          allowHostedRealRuntime: false,
          allowedRuntimeModes: ["codex.exec_json"]
        }
      })
    });
    const auth = await service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } });

    await expect(
      service.preflightRunCreate({
        auth,
        placement: "hosted",
        runtimeMode: "codex.exec_json",
        timeoutSeconds: 60,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: "entitlement_denied",
      reasonCode: "hosted_real_runtime_disabled"
    });
    expect(store.reservations.size).toBe(0);
  });

  it("enforces artifact preflight ownership, entitlement, and byte quota", async () => {
    const { service, rawKey } = createServiceFixture();
    const auth = await service.authenticateRequest({ headers: { authorization: `Bearer ${rawKey}` } });

    await service.ensureOwnedOrAttachFromRun({
      auth,
      resourceType: "artifact",
      resourceId: "artifact_1",
      runId: "run_1"
    });

    const reservation = await service.preflightArtifactContentRead({
      auth,
      artifactId: "artifact_1",
      expectedBytes: 1024,
      now: NOW
    });

    expect(reservation.quotaKind).toBe("artifact_read_bytes_per_hour");

    await expect(
      service.preflightArtifactContentRead({
        auth,
        artifactId: "artifact_1",
        expectedBytes: 2048,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: "quota_exceeded",
      reasonCode: "artifact_read_bytes_exceeded"
    });
  });

  it("enforces node registration quota and project ownership", async () => {
    const { service, rawKey } = createServiceFixture();
    const auth = await service.authenticateRequest({ headers: { authorization: `Bearer ${rawKey}` } });

    const first = await service.preflightNodeRegister({ auth, nodeId: "node_1", now: NOW });
    expect(first.state).toBe("reserved");

    await expect(
      service.preflightNodeRegister({ auth, nodeId: "node_2", now: NOW })
    ).rejects.toMatchObject({
      code: "quota_exceeded",
      reasonCode: "connected_nodes_exceeded"
    });
  });

  it("rejects cross-tenant reservation transitions", async () => {
    const { service, store, rawKey, pepper } = createServiceFixture();
    const rawKey2 = "sk_sw_test_bravo";
    store.bundles.push(createSecondBundle(rawKey2, pepper));

    const tenantOneAuth = await service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } });
    const tenantTwoAuth = await service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey2 } });

    const reservation = await service.preflightRunCreate({
      auth: tenantOneAuth,
      placement: "hosted",
      runtimeMode: "fake.deterministic",
      timeoutSeconds: 60,
      now: NOW
    });

    await expect(
      service.releaseQuotaReservation({
        auth: tenantTwoAuth,
        reservationId: reservation.id,
        outcome: "released",
        now: NOW
      })
    ).rejects.toMatchObject({
      code: "tenant_access_denied",
      reasonCode: "reservation_scope_mismatch"
    });
  });

  it("requireScope denies missing scope safely", () => {
    const { service } = createServiceFixture();
    const plan = createPlan();
    const auth = {
      ...createBaseBundle("sk_sw_scope", "pepper_123"),
      apiKey: {
        ...createBaseBundle("sk_sw_scope", "pepper_123").apiKey,
        scopes: ["runs:read"] satisfies EnterpriseScope[]
      },
      entitlement: {
        accountId: "account_1",
        tenantId: "tenant_1",
        projectId: "project_1",
        planId: plan.id,
        planSlug: plan.slug,
        planDisplayName: plan.displayName,
        planStatus: plan.status,
        entitlements: plan.entitlements,
        quotas: plan.quotas,
        scopes: ["runs:read"] satisfies EnterpriseScope[],
        capturedAt: NOW
      }
    } as AuthContext;

    expect(() => service.requireScope(auth, "artifacts:read")).toThrowError(ControlPlaneError);
    expect(() => service.requireScope(auth, "artifacts:read")).toThrowError(/missing_scope/);
  });
});

describe("ControlPlaneService ownership and audit", () => {
  it("returns typed ownership_attach_failed result on attach errors", async () => {
    const { service, rawKey, store } = createServiceFixture();
    const auth = await service.authenticateRequest({ headers: { "x-switchyard-api-key": rawKey } });

    await store.attachOwnership({
      resourceType: "run",
      resourceId: "run_conflict",
      accountId: "account_2",
      tenantId: "tenant_2",
      projectId: "project_2",
      userId: "user_2",
      apiKeyId: "api_key_2",
      createdAt: NOW
    });

    const result = await service.ensureOwnedOrAttachFromRun({
      auth,
      resourceType: "run",
      resourceId: "run_conflict",
      runId: "run_conflict"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasonCode).toBe("ownership_attach_failed");
    }
  });

  it("redacts secrets in audit payloads and supports system fallback", async () => {
    const { service, rawKey } = createServiceFixture();
    const auth = await service.authenticateRequest({
      headers: {
        authorization: `Bearer ${rawKey}`
      }
    });

    await service.recordAudit({
      auth,
      eventType: "run.create_allowed",
      decision: "allow",
      payload: {
        authorization: `Bearer ${rawKey}`,
        apiKey: rawKey,
        secretHash: digest(rawKey, "pepper_123"),
        pepper: "pepper_123",
        cookie: "session=123",
        providerToken: "tok_abc",
        signedUrl: "https://example.com/download?sig=abc&token=secret",
        nested: {
          objectStoreSecret: "supersecret"
        }
      }
    });

    const stored = (await service.listAuditEvents({ auth, limit: 10 })).events[0];
    const payload = JSON.stringify(stored.payload);
    expect(payload).not.toContain(rawKey);
    expect(payload).not.toContain("pepper_123");
    expect(payload).not.toContain("tok_abc");
    expect(payload).toContain("[REDACTED]");

    await expect(
      service.recordAudit({
        eventType: "api_key.auth_failed",
        decision: "deny",
        accountId: "account_1",
        tenantId: "tenant_1",
        payload: { token: "should-hide" }
      })
    ).resolves.toMatchObject({
      ok: true
    });
  });
});

describe("@switchyard/contracts package-root runtime enterprise schemas", () => {
  it("parses R18 enterprise plan and entitlement fixtures via package root import", () => {
    const plan = billingPlanSchemaRuntime.parse({
      id: "billing_plan_runtime_1",
      slug: "enterprise_runtime",
      displayName: "Enterprise Runtime",
      status: "active",
      entitlements: {
        allowedPlacements: ["hosted", "local", "connected_local_node"],
        allowedRuntimeModes: ["fake.deterministic", "codex.exec_json"],
        allowHostedRealRuntime: true,
        allowConnectedNodes: true,
        allowArtifactContentRead: true,
        allowMetricsRead: true,
        allowAuditRead: true
      },
      quotas: {
        maxRunsPerHour: 100,
        maxActiveRuns: 25,
        maxRunTimeoutSeconds: 1800,
        maxConnectedNodes: 5,
        maxArtifactContentReadBytesPerHour: 1048576
      },
      createdAt: "2026-05-31T00:00:00.000Z"
    });

    const entitlement = entitlementSnapshotSchemaRuntime.parse({
      accountId: "account_runtime_1",
      tenantId: "tenant_runtime_1",
      projectId: "project_runtime_1",
      planId: plan.id,
      planSlug: plan.slug,
      planDisplayName: plan.displayName,
      entitlements: plan.entitlements,
      quotas: plan.quotas,
      scopes: ["runs:write", "audit:read"],
      capturedAt: "2026-05-31T00:00:00.000Z"
    });

    expect(entitlement.planSlug).toBe("enterprise_runtime");
    expect(entitlement.entitlements.allowHostedRealRuntime).toBe(true);
  });
});
