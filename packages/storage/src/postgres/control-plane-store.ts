import type {
  Account,
  ApiKeyStored,
  AuditLogEvent,
  BillingPlan,
  Project,
  QuotaReservation,
  ResourceOwnership,
  Tenant,
  User
} from "@switchyard/contracts";
import {
  accountSchema,
  apiKeyStoredSchema,
  auditLogEventSchema,
  billingPlanSchema,
  projectSchema,
  quotaReservationSchema,
  resourceOwnershipSchema,
  tenantSchema,
  userSchema
} from "@switchyard/contracts";
import type {
  ActiveNodeCountInput,
  ActiveRunCountInput,
  AppendAuditEventInput,
  AuditEventsPage,
  AuthBundle,
  AttachOwnershipInput,
  ControlPlaneBootstrapInput,
  ControlPlaneBootstrapSummary,
  ControlPlaneStore,
  ExpireReservationsInput,
  GetOwnershipInput,
  ListAuditEventsInput,
  ListOwnedResourceIdsInput,
  LoadApiKeyBundleInput,
  QuotaCriticalSectionScope,
  ReserveQuotaInput,
  TransitionQuotaReservationInput,
  UnownedResourceCounts
} from "@switchyard/core";
import { createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { PostgresDatabaseHandle } from "./database.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "timeout"]);
const ACTIVE_NODE_STATUSES = new Set(["online", "degraded"]);
const MAX_AUDIT_PAGE_LIMIT = 200;
const SYSTEM_USER_ID = "user_system";
const SYSTEM_API_KEY_ID = "api_key_system";
const SYSTEM_PROJECT_ID = "project_system";

type QuotaState = QuotaReservation["state"];
type QuotaUsageRow = {
  id: string;
  accountId: string;
  tenantId: string;
  projectId: string;
  quotaKind: QuotaReservation["quotaKind"];
  used: number;
  windowStart: string;
  windowEnd: string;
  updatedAt: string;
};
type ResourceType = ResourceOwnership["resourceType"];

interface BootstrapPayload {
  apiKeyPepper?: string;
  accounts: Account[];
  tenants: Tenant[];
  projects: Project[];
  users: User[];
  apiKeys: ApiKeyStored[];
  billingPlans: BillingPlan[];
}

interface BootstrapSummaryCounts {
  accounts: number;
  tenants: number;
  projects: number;
  users: number;
  apiKeys: number;
  billingPlans: number;
}

type Queryable = { query: PoolClient["query"] };

const VALID_TRANSITIONS: Record<QuotaState, readonly QuotaState[]> = {
  reserved: ["consumed", "released", "failed", "expired"],
  consumed: [],
  released: [],
  failed: [],
  expired: []
};

export class ControlPlaneStoreError extends Error {
  constructor(
    readonly code:
      | "control_plane_bootstrap_empty"
      | "control_plane_bootstrap_malformed"
      | "control_plane_bootstrap_duplicate"
      | "control_plane_bootstrap_zero_active"
      | "control_plane_bootstrap_inactive_plan"
      | "quota_exceeded"
      | "reservation_not_found"
      | "reservation_scope_mismatch"
      | "invalid_quota_transition"
      | "ownership_conflict"
      | "ownership_attach_failed"
      | "invalid_query",
    readonly safeDetails?: Record<string, unknown>
  ) {
    super(code);
  }
}

export class PostgresControlPlaneStore implements ControlPlaneStore {
  private readonly accounts = new Map<string, Account>();
  private readonly tenants = new Map<string, Tenant>();
  private readonly projects = new Map<string, Project>();
  private readonly users = new Map<string, User>();
  private readonly apiKeys = new Map<string, ApiKeyStored>();
  private readonly billingPlans = new Map<string, BillingPlan>();
  private readonly reservations = new Map<string, QuotaReservation>();
  private readonly usage = new Map<string, QuotaUsageRow>();
  private readonly ownership = new Map<string, ResourceOwnership>();
  private readonly auditEvents: AuditLogEvent[] = [];
  private readonly runStatusById = new Map<string, string>();
  private readonly nodeStateById = new Map<string, { status: string; heartbeatExpiresAt?: string }>();
  private readonly toolInvocationResourceIds = new Set<string>();
  private readonly approvalResourceIds = new Set<string>();
  private readonly criticalChains = new Map<string, Promise<void>>();

  constructor(private readonly handle?: PostgresDatabaseHandle) {}

  trackInMemoryResourceForOwnership(resourceType: ResourceType, resourceId: string): void {
    if (this.handle) {
      return;
    }
    if (resourceType === "tool_invocation") {
      this.toolInvocationResourceIds.add(resourceId);
      return;
    }
    if (resourceType === "approval") {
      this.approvalResourceIds.add(resourceId);
    }
  }

  async loadApiKeyBundleByHash(input: LoadApiKeyBundleInput): Promise<AuthBundle | null> {
    if (this.handle) {
      return this.loadApiKeyBundleByHashPostgres(input);
    }

    const matching = [...this.apiKeys.values()].filter(
      (entry) => entry.keyPrefix === input.keyPrefix && entry.secretHash === input.secretHash
    );
    if (matching.length === 0) {
      return null;
    }
    const bundles = matching
      .map((entry) => this.toAuthBundle(entry))
      .filter((entry): entry is AuthBundle => entry !== null);
    if (bundles.length === 0) {
      return null;
    }
    const first = bundles[0]!;
    const rest = bundles.slice(1);
    return {
      ...first,
      candidateBundles: [first, ...rest]
    };
  }

  async bootstrap(input: ControlPlaneBootstrapInput): Promise<ControlPlaneBootstrapSummary> {
    const payload = normalizeBootstrapPayload(input);
    validateBootstrapPayload(payload);

    if (this.handle) {
      await this.withTransaction(async (client) => {
        await upsertBootstrapPayload(client, payload);
      });
      return this.selectBootstrapSummaryFromPostgres(payload, (input as { accountIds?: readonly string[] }).accountIds);
    }

    this.accounts.clear();
    this.tenants.clear();
    this.projects.clear();
    this.users.clear();
    this.apiKeys.clear();
    this.billingPlans.clear();

    for (const plan of payload.billingPlans) this.billingPlans.set(plan.id, plan);
    for (const account of payload.accounts) this.accounts.set(account.id, account);
    for (const tenant of payload.tenants) this.tenants.set(tenant.id, tenant);
    for (const project of payload.projects) this.projects.set(project.id, project);
    for (const user of payload.users) this.users.set(user.id, user);
    for (const apiKey of payload.apiKeys) this.apiKeys.set(apiKey.id, apiKey);

    const summary = buildBootstrapSummary(payload, (input as { accountIds?: readonly string[] }).accountIds);
    ensureActiveCounts(summary.active);
    return summary;
  }

  async reserveQuota(input: ReserveQuotaInput): Promise<QuotaReservation> {
    if (this.handle) {
      return this.reserveQuotaPostgres(input);
    }

    const now = parseIso(input.now, "reserveQuota.now");
    const usageKey = quotaScopeKey(input.accountId, input.tenantId, input.projectId, input.quotaKind);
    const windowStart = new Date(now.getTime() - input.windowMs).toISOString();
    const windowEnd = new Date(now.getTime() + input.windowMs).toISOString();
    const existing = this.usage.get(usageKey);
    if (!existing || Date.parse(existing.windowEnd) <= now.getTime()) {
      this.usage.set(usageKey, {
        id: `quota_usage_${safeUuid()}`,
        accountId: input.accountId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        quotaKind: input.quotaKind,
        used: 0,
        windowStart,
        windowEnd,
        updatedAt: now.toISOString()
      });
    }
    const usage = this.usage.get(usageKey);
    if (!usage) {
      throw new ControlPlaneStoreError("quota_exceeded");
    }
    const pending = [...this.reservations.values()]
      .filter(
        (entry) =>
          entry.accountId === input.accountId &&
          entry.tenantId === input.tenantId &&
          entry.projectId === input.projectId &&
          entry.quotaKind === input.quotaKind &&
          entry.state === "reserved" &&
          Date.parse(entry.expiresAt) > now.getTime()
      )
      .reduce((sum, entry) => sum + entry.amount, 0);
    if (usage.used + pending + input.amount > input.maxAllowed) {
      throw new ControlPlaneStoreError("quota_exceeded");
    }
    const reservation = quotaReservationSchema.parse({
      id: `quota_reservation_${safeUuid()}`,
      accountId: input.accountId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      quotaKind: input.quotaKind,
      amount: input.amount,
      state: "reserved",
      reasonCode: input.reasonCode,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.reservationTtlMs).toISOString()
    });
    this.reservations.set(reservation.id, reservation);
    const ownerIds = resolveOwnershipActorIds(input.userId, input.apiKeyId);
    await this.attachOwnership({
      resourceType: "quota",
      resourceId: reservation.id,
      accountId: reservation.accountId,
      tenantId: reservation.tenantId,
      projectId: reservation.projectId,
      userId: ownerIds.userId,
      apiKeyId: ownerIds.apiKeyId,
      createdAt: reservation.createdAt
    });
    return reservation;
  }

  async transitionQuotaReservation(input: TransitionQuotaReservationInput): Promise<QuotaReservation> {
    if (this.handle) {
      return this.transitionQuotaReservationPostgres(input);
    }

    const current = this.reservations.get(input.reservationId);
    if (!current) {
      throw new ControlPlaneStoreError("reservation_not_found");
    }
    ensureReservationScopeMatch(current, input);
    ensureValidTransition(current.state, input.nextState);

    const now = parseIso(input.now, "transitionQuotaReservation.now").toISOString();
    const next = quotaReservationSchema.parse({
      ...current,
      state: input.nextState,
      reasonCode: input.reasonCode ?? current.reasonCode,
      finalizedAt: input.finalizedAt ?? now
    });
    this.reservations.set(next.id, next);
    if (input.nextState === "consumed" && next.quotaKind !== "connected_nodes") {
      const usageKey = quotaScopeKey(next.accountId, next.tenantId, next.projectId, next.quotaKind);
      const usage = this.usage.get(usageKey);
      if (usage) {
        usage.used += next.amount;
        usage.updatedAt = now;
      }
    }
    return next;
  }

  async withQuotaCriticalSection<T>(scope: QuotaCriticalSectionScope, fn: () => Promise<T>): Promise<T> {
    const key = quotaScopeKey(scope.accountId, scope.tenantId, scope.projectId, scope.quotaKind);
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
    if (this.handle) {
      return this.attachOwnershipPostgres(input);
    }

    const key = ownershipKey(input.resourceType, input.resourceId);
    const existing = this.ownership.get(key);
    if (existing) {
      if (!isSameOwner(existing, input)) {
        throw new ControlPlaneStoreError("ownership_conflict");
      }
      return existing;
    }

    const created = resourceOwnershipSchema.parse({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      accountId: input.accountId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      createdAt: input.createdAt ?? new Date().toISOString()
    });
    this.ownership.set(key, created);
    this.captureInMemoryResourceState(input);
    return created;
  }

  async getOwnership(input: GetOwnershipInput): Promise<ResourceOwnership | null> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT resource_type, resource_id, account_id, tenant_id, project_id, user_id, api_key_id, created_at
         FROM resource_ownership
         WHERE resource_type = $1 AND resource_id = $2`,
        [input.resourceType, input.resourceId]
      );
      return result.rows[0] ? rowToOwnership(result.rows[0]) : null;
    }
    return this.ownership.get(ownershipKey(input.resourceType, input.resourceId)) ?? null;
  }

  async listOwnedResourceIds(input: ListOwnedResourceIdsInput): Promise<readonly string[]> {
    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT resource_id
         FROM resource_ownership
         WHERE resource_type = $1
           AND account_id = $2
           AND tenant_id = $3
           AND project_id = $4
         ORDER BY resource_id ASC`,
        [input.resourceType, input.accountId, input.tenantId, input.projectId]
      );
      return result.rows.map((row) => String(row["resource_id"]));
    }
    return [...this.ownership.values()]
      .filter(
        (entry) =>
          entry.resourceType === input.resourceType &&
          entry.accountId === input.accountId &&
          entry.tenantId === input.tenantId &&
          entry.projectId === input.projectId
      )
      .map((entry) => entry.resourceId)
      .sort((a, b) => a.localeCompare(b));
  }

  async countActiveOwnedRuns(input: ActiveRunCountInput): Promise<number> {
    const nowMs = Date.parse(input.now ?? new Date().toISOString());
    let activeRuns = 0;

    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT COUNT(*)::int AS count
         FROM runs r
         JOIN resource_ownership o
           ON o.resource_type = 'run'
          AND o.resource_id = r.id
         WHERE o.account_id = $1
           AND o.tenant_id = $2
           AND o.project_id = $3
           AND r.status NOT IN ('completed', 'failed', 'cancelled', 'timeout')`,
        [input.accountId, input.tenantId, input.projectId]
      );
      activeRuns = Number(result.rows[0]?.["count"] ?? 0);
    } else {
      activeRuns = [...this.ownership.values()].filter((entry) => {
        if (entry.resourceType !== "run") {
          return false;
        }
        if (entry.accountId !== input.accountId || entry.tenantId !== input.tenantId || entry.projectId !== input.projectId) {
          return false;
        }
        const status = this.runStatusById.get(entry.resourceId) ?? "queued";
        return !TERMINAL_RUN_STATUSES.has(status);
      }).length;
    }

    if (!input.includeUnexpiredReservations) {
      return activeRuns;
    }

    const filteredKinds = input.reservationQuotaKinds ? new Set(input.reservationQuotaKinds) : null;
    if (this.handle) {
      const params: unknown[] = [input.accountId, input.tenantId, input.projectId, new Date(nowMs).toISOString()];
      let kindClause = "";
      if (filteredKinds && filteredKinds.size > 0) {
        const kinds = [...filteredKinds];
        params.push(kinds);
        kindClause = ` AND quota_kind = ANY($${params.length}::text[])`;
      }
      const result = await this.handle.pool.query(
        `SELECT COALESCE(SUM(amount), 0)::int AS amount
         FROM quota_reservations
         WHERE account_id = $1
           AND tenant_id = $2
           AND project_id = $3
           AND state = 'reserved'
           AND expires_at > $4${kindClause}`,
        params
      );
      return activeRuns + Number(result.rows[0]?.["amount"] ?? 0);
    }

    const reservationCount = [...this.reservations.values()]
      .filter((entry) => {
        if (entry.accountId !== input.accountId || entry.tenantId !== input.tenantId || entry.projectId !== input.projectId) {
          return false;
        }
        if (entry.state !== "reserved" || Date.parse(entry.expiresAt) <= nowMs) {
          return false;
        }
        if (filteredKinds && !filteredKinds.has(entry.quotaKind)) {
          return false;
        }
        return true;
      })
      .reduce((sum, entry) => sum + entry.amount, 0);
    return activeRuns + reservationCount;
  }

  async countActiveOwnedNodes(input: ActiveNodeCountInput): Promise<number> {
    const now = input.now ?? new Date().toISOString();
    const nowMs = Date.parse(now);
    if (this.handle) {
      const result = await this.handle.pool.query(
        `SELECT COUNT(*)::int AS count
         FROM nodes n
         JOIN resource_ownership o
           ON o.resource_type = 'node'
          AND o.resource_id = n.id
         WHERE o.account_id = $1
           AND o.tenant_id = $2
           AND o.project_id = $3
           AND n.status IN ('online', 'degraded')
           AND (n.heartbeat_expires_at IS NULL OR n.heartbeat_expires_at > $4)`,
        [input.accountId, input.tenantId, input.projectId, now]
      );
      return Number(result.rows[0]?.["count"] ?? 0);
    }
    return [...this.ownership.values()].filter((entry) => {
      if (entry.resourceType !== "node") {
        return false;
      }
      if (entry.accountId !== input.accountId || entry.tenantId !== input.tenantId || entry.projectId !== input.projectId) {
        return false;
      }
      const nodeState = this.nodeStateById.get(entry.resourceId) ?? { status: "online" };
      if (!ACTIVE_NODE_STATUSES.has(nodeState.status)) {
        return false;
      }
      if (nodeState.heartbeatExpiresAt && Date.parse(nodeState.heartbeatExpiresAt) <= nowMs) {
        return false;
      }
      return true;
    }).length;
  }

  async appendAuditEvent(input: AppendAuditEventInput): Promise<AuditLogEvent> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const event = auditLogEventSchema.parse({
      id: `audit_${safeUuid()}`,
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
      ipHash: input.ipHash,
      userAgent: input.userAgent,
      requestId: input.requestId,
      payload: input.payload,
      createdAt
    });

    if (this.handle) {
      await this.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO audit_log_events (
            id, account_id, tenant_id, project_id, actor_type, actor_user_id, api_key_id, event_type,
            resource_type, resource_id, decision, reason_code, ip_hash, user_agent, request_id, payload, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            event.id,
            event.accountId,
            event.tenantId,
            event.projectId ?? null,
            event.actorType,
            event.actorUserId ?? null,
            event.apiKeyId ?? null,
            event.eventType,
            event.resourceType ?? null,
            event.resourceId ?? null,
            event.decision,
            event.reasonCode ?? null,
            event.ipHash ?? null,
            event.userAgent ?? null,
            event.requestId ?? null,
            event.payload,
            event.createdAt
          ]
        );
        const ownerIds = resolveOwnershipActorIds(event.actorUserId, event.apiKeyId);
        const ownershipInput = {
          resourceType: "audit_log_event",
          resourceId: event.id,
          accountId: event.accountId,
          tenantId: event.tenantId,
          projectId: event.projectId ?? SYSTEM_PROJECT_ID,
          userId: ownerIds.userId,
          apiKeyId: ownerIds.apiKeyId,
          createdAt: event.createdAt,
          client
        } as AttachOwnershipInput & { client: Queryable };
        await this.attachOwnershipPostgres(ownershipInput);
      });
      return event;
    }
    this.auditEvents.push(event);
    const ownerIds = resolveOwnershipActorIds(event.actorUserId, event.apiKeyId);
    await this.attachOwnership({
      resourceType: "audit_log_event",
      resourceId: event.id,
      accountId: event.accountId,
      tenantId: event.tenantId,
      projectId: event.projectId ?? SYSTEM_PROJECT_ID,
      userId: ownerIds.userId,
      apiKeyId: ownerIds.apiKeyId,
      createdAt: event.createdAt
    });
    return event;
  }

  async listAuditEvents(input: ListAuditEventsInput): Promise<AuditEventsPage> {
    const parsed = parseAuditCursor(input.cursor);
    const limit = clampLimit(input.limit);
    if (this.handle) {
      const params: unknown[] = [input.accountId, input.tenantId];
      const where: string[] = ["account_id = $1", "tenant_id = $2"];
      if (input.projectId) {
        params.push(input.projectId);
        where.push(`project_id = $${params.length}`);
      }
      if (parsed) {
        params.push(parsed.createdAt, parsed.id);
        where.push(`(created_at < $${params.length - 1} OR (created_at = $${params.length - 1} AND id < $${params.length}))`);
      }
      params.push(limit + 1);
      const result = await this.handle.pool.query(
        `SELECT *
         FROM audit_log_events
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length}`,
        params
      );
      const rows = result.rows.map(rowToAuditLogEvent);
      const page = rows.slice(0, limit);
      const next = rows.length > limit ? page.at(-1) : undefined;
      return next
        ? {
            events: page,
            nextCursor: encodeAuditCursor(next.createdAt, next.id)
          }
        : { events: page };
    }

    const filtered = this.auditEvents
      .filter((event) => {
        if (event.accountId !== input.accountId || event.tenantId !== input.tenantId) {
          return false;
        }
        if (input.projectId && event.projectId !== input.projectId) {
          return false;
        }
        if (!parsed) {
          return true;
        }
        if (event.createdAt < parsed.createdAt) {
          return true;
        }
        return event.createdAt === parsed.createdAt && event.id < parsed.id;
      })
      .sort((left, right) => {
        if (left.createdAt === right.createdAt) {
          return right.id.localeCompare(left.id);
        }
        return left.createdAt > right.createdAt ? -1 : 1;
      });

    const page = filtered.slice(0, limit);
    const next = filtered.length > limit ? page.at(-1) : undefined;
    return next
      ? {
          events: page,
          nextCursor: encodeAuditCursor(next.createdAt, next.id)
        }
      : { events: page };
  }

  async countUnownedResources(): Promise<UnownedResourceCounts> {
    if (this.handle) {
      const [runs, runEvents, artifacts, toolInvocations, approvals, placements, nodes, assignments, auditEvents, quotaReservations] = await Promise.all([
        this.countUnownedByType("run", "runs"),
        this.countUnownedByType("run_event", "run_events"),
        this.countUnownedByType("artifact", "artifacts"),
        this.countUnownedByType("tool_invocation", "tool_invocations"),
        this.countUnownedByType("approval", "approvals"),
        this.countUnownedByType("placement_decision", "placement_decisions"),
        this.countUnownedByType("node", "nodes"),
        this.countUnownedByType("assignment", "assignments"),
        this.countUnownedByType("audit_log_event", "audit_log_events"),
        this.countUnownedByType("quota", "quota_reservations")
      ]);
      return {
        runs,
        runEvents,
        artifacts,
        toolInvocations,
        approvals,
        placements,
        nodes,
        assignments,
        auditEvents,
        quotaReservations
      } as UnownedResourceCounts;
    }

    const ownedKeySet = new Set(this.ownership.keys());
    const unownedToolInvocations = [...this.toolInvocationResourceIds].filter(
      (resourceId) => !ownedKeySet.has(ownershipKey("tool_invocation", resourceId))
    ).length;
    const unownedApprovals = [...this.approvalResourceIds].filter(
      (resourceId) => !ownedKeySet.has(ownershipKey("approval", resourceId))
    ).length;
    const unownedAudit = this.auditEvents.filter((event) => !ownedKeySet.has(ownershipKey("audit_log_event", event.id))).length;
    const unownedReservations = [...this.reservations.values()].filter(
      (entry) => !ownedKeySet.has(ownershipKey("quota", entry.id))
    ).length;
    return {
      runs: 0,
      runEvents: 0,
      artifacts: 0,
      toolInvocations: unownedToolInvocations,
      approvals: unownedApprovals,
      placements: 0,
      nodes: 0,
      assignments: 0,
      auditEvents: unownedAudit,
      quotaReservations: unownedReservations
    } as UnownedResourceCounts;
  }

  async expireStaleReservations(input: ExpireReservationsInput): Promise<number> {
    const now = parseIso(input.now, "expireStaleReservations.now").toISOString();
    if (this.handle) {
      const result = await this.handle.pool.query(
        `UPDATE quota_reservations
         SET state = 'expired',
             reason_code = CASE WHEN reason_code = '' THEN 'reservation_expired' ELSE reason_code END,
             finalized_at = COALESCE(finalized_at, $1),
             updated_at = $1
         WHERE state = 'reserved' AND expires_at <= $1`,
        [now]
      );
      return result.rowCount ?? 0;
    }
    let count = 0;
    for (const [id, entry] of this.reservations.entries()) {
      if (entry.state !== "reserved" || Date.parse(entry.expiresAt) > Date.parse(now)) {
        continue;
      }
      this.reservations.set(id, quotaReservationSchema.parse({
        ...entry,
        state: "expired",
        finalizedAt: now,
        reasonCode: entry.reasonCode || "reservation_expired"
      }));
      count += 1;
    }
    return count;
  }

  private async loadApiKeyBundleByHashPostgres(input: LoadApiKeyBundleInput): Promise<AuthBundle | null> {
    const result = await this.handle!.pool.query(
      `SELECT
        k.id AS api_key_id,
        k.account_id AS api_key_account_id,
        k.tenant_id AS api_key_tenant_id,
        k.project_id AS api_key_project_id,
        k.user_id AS api_key_user_id,
        k.name AS api_key_name,
        k.key_prefix AS api_key_key_prefix,
        k.secret_hash AS api_key_secret_hash,
        k.scopes AS api_key_scopes,
        k.status AS api_key_status,
        k.expires_at AS api_key_expires_at,
        k.last_used_at AS api_key_last_used_at,
        k.created_at AS api_key_created_at,
        k.revoked_at AS api_key_revoked_at,
        a.id AS account_id,
        a.name AS account_name,
        a.status AS account_status,
        a.billing_plan_id AS account_billing_plan_id,
        a.created_at AS account_created_at,
        a.updated_at AS account_updated_at,
        t.id AS tenant_id,
        t.account_id AS tenant_account_id,
        t.slug AS tenant_slug,
        t.display_name AS tenant_display_name,
        t.status AS tenant_status,
        t.created_at AS tenant_created_at,
        t.updated_at AS tenant_updated_at,
        p.id AS project_id,
        p.account_id AS project_account_id,
        p.tenant_id AS project_tenant_id,
        p.slug AS project_slug,
        p.display_name AS project_display_name,
        p.status AS project_status,
        p.created_at AS project_created_at,
        p.updated_at AS project_updated_at,
        u.id AS user_id,
        u.account_id AS user_account_id,
        u.tenant_id AS user_tenant_id,
        u.display_name AS user_display_name,
        u.email AS user_email,
        u.status AS user_status,
        u.created_at AS user_created_at,
        u.updated_at AS user_updated_at,
        b.id AS plan_id,
        b.slug AS plan_slug,
        b.display_name AS plan_display_name,
        b.status AS plan_status,
        b.entitlements AS plan_entitlements,
        b.quotas AS plan_quotas,
        b.created_at AS plan_created_at,
        b.updated_at AS plan_updated_at
       FROM api_keys k
       JOIN accounts a ON a.id = k.account_id
       JOIN tenants t ON t.id = k.tenant_id
       JOIN projects p ON p.id = k.project_id
       JOIN enterprise_users u ON u.id = k.user_id
       JOIN billing_plans b ON b.id = a.billing_plan_id
       WHERE k.key_prefix = $1
         AND k.secret_hash = $2`,
      [input.keyPrefix, input.secretHash]
    );

    const bundles = result.rows
      .map((row) => rowToAuthBundle(row))
      .filter((entry): entry is AuthBundle => entry !== null);
    if (bundles.length === 0) {
      return null;
    }
    const first = bundles[0]!;
    const rest = bundles.slice(1);
    return {
      ...first,
      candidateBundles: [first, ...rest]
    };
  }

  private toAuthBundle(apiKey: ApiKeyStored): AuthBundle | null {
    const account = this.accounts.get(apiKey.accountId);
    const tenant = this.tenants.get(apiKey.tenantId);
    const project = this.projects.get(apiKey.projectId);
    const user = this.users.get(apiKey.userId);
    if (!account || !tenant || !project || !user) {
      return null;
    }
    const plan = this.billingPlans.get(account.billingPlanId);
    if (!plan) {
      return null;
    }
    return { account, tenant, project, user, apiKey, plan };
  }

  private async reserveQuotaPostgres(input: ReserveQuotaInput): Promise<QuotaReservation> {
    const now = parseIso(input.now, "reserveQuota.now");
    return this.withTransaction(async (client) => {
      const usage = await this.lockOrCreateQuotaUsage(client, input, now);
      const pendingResult = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::int AS amount
         FROM quota_reservations
         WHERE account_id = $1
           AND tenant_id = $2
           AND project_id = $3
           AND quota_kind = $4
           AND state = 'reserved'
           AND expires_at > $5`,
        [input.accountId, input.tenantId, input.projectId, input.quotaKind, now.toISOString()]
      );
      const pending = Number(pendingResult.rows[0]?.["amount"] ?? 0);
      if (usage.used + pending + input.amount > input.maxAllowed) {
        throw new ControlPlaneStoreError("quota_exceeded");
      }
      const reservation = quotaReservationSchema.parse({
        id: `quota_reservation_${safeUuid()}`,
        accountId: input.accountId,
        tenantId: input.tenantId,
        projectId: input.projectId,
        quotaKind: input.quotaKind,
        amount: input.amount,
        state: "reserved",
        reasonCode: input.reasonCode,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + input.reservationTtlMs).toISOString()
      });
      await client.query(
        `INSERT INTO quota_reservations (
          id, account_id, tenant_id, project_id, quota_kind, amount, state, reason_code,
          created_at, updated_at, expires_at, finalized_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          reservation.id,
          reservation.accountId,
          reservation.tenantId,
          reservation.projectId,
          reservation.quotaKind,
          reservation.amount,
          reservation.state,
          reservation.reasonCode,
          reservation.createdAt,
          reservation.createdAt,
          reservation.expiresAt,
          reservation.finalizedAt ?? null
        ]
      );
      const ownerIds = resolveOwnershipActorIds(input.userId, input.apiKeyId);
      const ownershipInput = {
        resourceType: "quota",
        resourceId: reservation.id,
        accountId: reservation.accountId,
        tenantId: reservation.tenantId,
        projectId: reservation.projectId,
        userId: ownerIds.userId,
        apiKeyId: ownerIds.apiKeyId,
        createdAt: reservation.createdAt,
        client
      } as AttachOwnershipInput & { client: Queryable };
      await this.attachOwnershipPostgres(ownershipInput);
      return reservation;
    });
  }

  private async transitionQuotaReservationPostgres(input: TransitionQuotaReservationInput): Promise<QuotaReservation> {
    const now = parseIso(input.now, "transitionQuotaReservation.now").toISOString();
    return this.withTransaction(async (client) => {
      const selected = await client.query("SELECT * FROM quota_reservations WHERE id = $1 FOR UPDATE", [input.reservationId]);
      if (!selected.rows[0]) {
        throw new ControlPlaneStoreError("reservation_not_found");
      }
      const current = rowToQuotaReservation(selected.rows[0]);
      ensureReservationScopeMatch(current, input);
      ensureValidTransition(current.state, input.nextState);

      const next = quotaReservationSchema.parse({
        ...current,
        state: input.nextState,
        reasonCode: input.reasonCode ?? current.reasonCode,
        finalizedAt: input.finalizedAt ?? now
      });
      await client.query(
        `UPDATE quota_reservations
         SET state = $2,
             reason_code = $3,
             finalized_at = $4,
             updated_at = $5
         WHERE id = $1`,
        [next.id, next.state, next.reasonCode, next.finalizedAt ?? null, now]
      );
      if (next.state === "consumed" && next.quotaKind !== "connected_nodes") {
        const usage = await this.lockOrCreateQuotaUsage(
          client,
          {
            accountId: next.accountId,
            tenantId: next.tenantId,
            projectId: next.projectId,
            quotaKind: next.quotaKind,
            windowMs: 60 * 60 * 1_000
          },
          parseIso(now, "transitionQuotaReservation.now")
        );
        await client.query("UPDATE quota_usage SET used = $2, updated_at = $3 WHERE id = $1", [
          usage.id,
          usage.used + next.amount,
          now
        ]);
      }
      return next;
    });
  }

  private async lockOrCreateQuotaUsage(
    client: Queryable,
    input: Pick<ReserveQuotaInput, "accountId" | "tenantId" | "projectId" | "quotaKind" | "windowMs">,
    now: Date
  ): Promise<QuotaUsageRow> {
    const params = [input.accountId, input.tenantId, input.projectId, input.quotaKind];
    const current = await client.query(
      `SELECT * FROM quota_usage
       WHERE account_id = $1 AND tenant_id = $2 AND project_id = $3 AND quota_kind = $4
       FOR UPDATE`,
      params
    );
    if (!current.rows[0]) {
      const scopeKey = quotaScopeKey(input.accountId, input.tenantId, input.projectId, input.quotaKind);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [scopeKey]);
      const afterLock = await client.query(
        `SELECT * FROM quota_usage
         WHERE account_id = $1 AND tenant_id = $2 AND project_id = $3 AND quota_kind = $4
         FOR UPDATE`,
        params
      );
      if (!afterLock.rows[0]) {
        const inserted: QuotaUsageRow = {
          id: `quota_usage_${safeUuid()}`,
          accountId: input.accountId,
          tenantId: input.tenantId,
          projectId: input.projectId,
          quotaKind: input.quotaKind,
          used: 0,
          windowStart: new Date(now.getTime() - input.windowMs).toISOString(),
          windowEnd: new Date(now.getTime() + input.windowMs).toISOString(),
          updatedAt: now.toISOString()
        };
        await client.query(
          `INSERT INTO quota_usage (
            id, account_id, tenant_id, project_id, quota_kind, window_start, window_end, used, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            inserted.id,
            inserted.accountId,
            inserted.tenantId,
            inserted.projectId,
            inserted.quotaKind,
            inserted.windowStart,
            inserted.windowEnd,
            inserted.used,
            inserted.updatedAt
          ]
        );
        return inserted;
      }
      return normalizeUsageWindow(client, rowToQuotaUsage(afterLock.rows[0]), input.windowMs, now);
    }
    return normalizeUsageWindow(client, rowToQuotaUsage(current.rows[0]), input.windowMs, now);
  }

  private async attachOwnershipPostgres(input: AttachOwnershipInput): Promise<ResourceOwnership> {
    const client = extractClient(input) ?? this.handle!.pool;
    const createdAt = input.createdAt ?? new Date().toISOString();
    const inserted = await client.query(
      `INSERT INTO resource_ownership (
        resource_type, resource_id, account_id, tenant_id, project_id, user_id, api_key_id, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (resource_type, resource_id) DO NOTHING
      RETURNING *`,
      [
        input.resourceType,
        input.resourceId,
        input.accountId,
        input.tenantId,
        input.projectId,
        input.userId,
        input.apiKeyId,
        createdAt
      ]
    );
    if (inserted.rows[0]) {
      return rowToOwnership(inserted.rows[0]);
    }
    const existing = await client.query(
      `SELECT resource_type, resource_id, account_id, tenant_id, project_id, user_id, api_key_id, created_at
       FROM resource_ownership
       WHERE resource_type = $1 AND resource_id = $2`,
      [input.resourceType, input.resourceId]
    );
    if (!existing.rows[0]) {
      throw new ControlPlaneStoreError("ownership_attach_failed");
    }
    const row = rowToOwnership(existing.rows[0]);
    if (!isSameOwner(row, input)) {
      throw new ControlPlaneStoreError("ownership_conflict");
    }
    return row;
  }

  private async countUnownedByType(resourceType: ResourceType, table: string): Promise<number> {
    const result = await this.handle!.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM ${table} t
       LEFT JOIN resource_ownership o
         ON o.resource_type = $1
        AND o.resource_id = t.id
       WHERE o.resource_id IS NULL`,
      [resourceType]
    );
    return Number(result.rows[0]?.["count"] ?? 0);
  }

  private captureInMemoryResourceState(input: AttachOwnershipInput): void {
    const metadata = (input as { metadata?: Record<string, unknown> }).metadata;
    if (input.resourceType === "tool_invocation") {
      this.toolInvocationResourceIds.add(input.resourceId);
      return;
    }
    if (input.resourceType === "approval") {
      this.approvalResourceIds.add(input.resourceId);
      return;
    }
    if (!metadata) {
      return;
    }
    if (input.resourceType === "run") {
      const status = metadata["status"];
      if (typeof status === "string") {
        this.runStatusById.set(input.resourceId, status);
      }
      return;
    }
    if (input.resourceType === "node") {
      const status = typeof metadata["status"] === "string" ? metadata["status"] : "online";
      const heartbeatExpiresAt =
        typeof metadata["heartbeatExpiresAt"] === "string" ? metadata["heartbeatExpiresAt"] : undefined;
      const nextState: { status: string; heartbeatExpiresAt?: string } = { status };
      if (heartbeatExpiresAt) {
        nextState.heartbeatExpiresAt = heartbeatExpiresAt;
      }
      this.nodeStateById.set(input.resourceId, nextState);
    }
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.handle!.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async selectBootstrapSummaryFromPostgres(
    payload: BootstrapPayload,
    accountIds?: readonly string[]
  ): Promise<ControlPlaneBootstrapSummary> {
    const counts = buildBootstrapSummary(payload, accountIds);
    ensureActiveCounts(counts.active);
    return counts;
  }
}

async function upsertBootstrapPayload(client: Queryable, payload: BootstrapPayload): Promise<void> {
  for (const plan of payload.billingPlans) {
    await client.query(
      `INSERT INTO billing_plans (id, slug, display_name, status, entitlements, quotas, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         slug = EXCLUDED.slug,
         display_name = EXCLUDED.display_name,
         status = EXCLUDED.status,
         entitlements = EXCLUDED.entitlements,
         quotas = EXCLUDED.quotas,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [plan.id, plan.slug, plan.displayName, plan.status, plan.entitlements, plan.quotas, plan.createdAt, plan.updatedAt ?? null]
    );
  }
  for (const account of payload.accounts) {
    await client.query(
      `INSERT INTO accounts (id, name, status, billing_plan_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         billing_plan_id = EXCLUDED.billing_plan_id,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [account.id, account.name, account.status, account.billingPlanId, account.createdAt, account.updatedAt ?? null]
    );
  }
  for (const tenant of payload.tenants) {
    await client.query(
      `INSERT INTO tenants (id, account_id, slug, display_name, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         slug = EXCLUDED.slug,
         display_name = EXCLUDED.display_name,
         status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [tenant.id, tenant.accountId, tenant.slug, tenant.displayName, tenant.status, tenant.createdAt, tenant.updatedAt ?? null]
    );
  }
  for (const project of payload.projects) {
    await client.query(
      `INSERT INTO projects (id, account_id, tenant_id, slug, display_name, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         tenant_id = EXCLUDED.tenant_id,
         slug = EXCLUDED.slug,
         display_name = EXCLUDED.display_name,
         status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [
        project.id,
        project.accountId,
        project.tenantId,
        project.slug,
        project.displayName,
        project.status,
        project.createdAt,
        project.updatedAt ?? null
      ]
    );
  }
  for (const user of payload.users) {
    await client.query(
      `INSERT INTO enterprise_users (id, account_id, tenant_id, display_name, email, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         tenant_id = EXCLUDED.tenant_id,
         display_name = EXCLUDED.display_name,
         email = EXCLUDED.email,
         status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [
        user.id,
        user.accountId,
        user.tenantId,
        user.displayName,
        user.email ?? null,
        user.status ?? "active",
        user.createdAt,
        user.updatedAt ?? null
      ]
    );
  }
  for (const key of payload.apiKeys) {
    await client.query(
      `INSERT INTO api_keys (
        id, account_id, tenant_id, project_id, user_id, name, key_prefix, secret_hash, scopes, status,
        expires_at, last_used_at, created_at, revoked_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        tenant_id = EXCLUDED.tenant_id,
        project_id = EXCLUDED.project_id,
        user_id = EXCLUDED.user_id,
        name = EXCLUDED.name,
        key_prefix = EXCLUDED.key_prefix,
        secret_hash = EXCLUDED.secret_hash,
        scopes = EXCLUDED.scopes,
        status = EXCLUDED.status,
        expires_at = EXCLUDED.expires_at,
        last_used_at = EXCLUDED.last_used_at,
        created_at = EXCLUDED.created_at,
        revoked_at = EXCLUDED.revoked_at`,
      [
        key.id,
        key.accountId,
        key.tenantId,
        key.projectId,
        key.userId,
        key.name,
        key.keyPrefix,
        key.secretHash,
        key.scopes,
        key.status,
        key.expiresAt ?? null,
        key.lastUsedAt ?? null,
        key.createdAt,
        key.revokedAt ?? null
      ]
    );
  }
}

async function normalizeUsageWindow(
  client: Queryable,
  usage: QuotaUsageRow,
  windowMs: number,
  now: Date
): Promise<QuotaUsageRow> {
  if (Date.parse(usage.windowEnd) > now.getTime()) {
    return usage;
  }
  const reset: QuotaUsageRow = {
    ...usage,
    used: 0,
    windowStart: new Date(now.getTime() - windowMs).toISOString(),
    windowEnd: new Date(now.getTime() + windowMs).toISOString(),
    updatedAt: now.toISOString()
  };
  await client.query("UPDATE quota_usage SET used = $2, window_start = $3, window_end = $4, updated_at = $5 WHERE id = $1", [
    reset.id,
    reset.used,
    reset.windowStart,
    reset.windowEnd,
    reset.updatedAt
  ]);
  return reset;
}

function normalizeBootstrapPayload(input: ControlPlaneBootstrapInput): BootstrapPayload {
  const raw = input as Record<string, unknown>;
  const container = isRecord(raw["records"]) ? raw["records"] : raw;
  const pepper = typeof raw["apiKeyPepper"] === "string" && raw["apiKeyPepper"].trim().length > 0 ? raw["apiKeyPepper"] : undefined;
  const strictToolBootstrap = isStrictToolBootstrapMode(raw);
  const accounts = parseEntityArray(container["accounts"], accountSchema.parse);
  const tenants = parseEntityArray(container["tenants"], tenantSchema.parse);
  const projects = parseEntityArray(container["projects"], projectSchema.parse);
  const users = parseEntityArray(container["users"], (value) => normalizeBootstrapUser(value));
  const billingPlanRows = parseRecordArray(container["billingPlans"]);
  const billingPlans = billingPlanRows.map((entry) => billingPlanSchema.parse(entry));
  const apiKeys = parseEntityArray(container["apiKeys"], (value) => normalizeBootstrapApiKey(value, pepper));
  validateToolBootstrapFields({ strictToolBootstrap, billingPlanRows });

  if (
    accounts.length === 0 &&
    tenants.length === 0 &&
    projects.length === 0 &&
    users.length === 0 &&
    apiKeys.length === 0 &&
    billingPlans.length === 0
  ) {
    throw new ControlPlaneStoreError("control_plane_bootstrap_empty");
  }

  return pepper
    ? { apiKeyPepper: pepper, accounts, tenants, projects, users, apiKeys, billingPlans }
    : { accounts, tenants, projects, users, apiKeys, billingPlans };
}

function normalizeBootstrapUser(value: unknown): User {
  if (!isRecord(value)) {
    throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
  }
  const parsed = userSchema.safeParse(value);
  if (!parsed.success) {
    throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
  }
  const candidate = parsed.data;
  if (!candidate.accountId || !candidate.tenantId || !candidate.status) {
    throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
  }
  return candidate;
}

function normalizeBootstrapApiKey(value: unknown, pepper?: string): ApiKeyStored {
  if (!isRecord(value)) {
    throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
  }
  const row = { ...value };
  const rawKey = typeof row["rawKey"] === "string" ? row["rawKey"] : undefined;
  if (rawKey) {
    if (!pepper) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
    const prefix = deriveKeyPrefix(rawKey);
    row["keyPrefix"] = typeof row["keyPrefix"] === "string" && String(row["keyPrefix"]).length > 0 ? row["keyPrefix"] : prefix;
    row["secretHash"] =
      typeof row["secretHash"] === "string" && String(row["secretHash"]).length > 0
        ? row["secretHash"]
        : hashRawApiKey(rawKey, pepper);
    delete row["rawKey"];
  }
  const parsed = apiKeyStoredSchema.safeParse(row);
  if (!parsed.success) {
    throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
  }
  if (looksLikeRawKey(parsed.data.secretHash)) {
    throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
  }
  if (parsed.data.keyPrefix.length > 0 && parsed.data.secretHash.includes(parsed.data.keyPrefix) && looksLikeRawKey(parsed.data.secretHash)) {
    throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
  }
  return parsed.data;
}

function validateBootstrapPayload(payload: BootstrapPayload): void {
  assertUniqueIds(payload.accounts, "control_plane_bootstrap_duplicate");
  assertUniqueIds(payload.tenants, "control_plane_bootstrap_duplicate");
  assertUniqueIds(payload.projects, "control_plane_bootstrap_duplicate");
  assertUniqueIds(payload.users, "control_plane_bootstrap_duplicate");
  assertUniqueIds(payload.apiKeys, "control_plane_bootstrap_duplicate");
  assertUniqueIds(payload.billingPlans, "control_plane_bootstrap_duplicate");

  const accounts = new Map(payload.accounts.map((entry) => [entry.id, entry]));
  const plans = new Map(payload.billingPlans.map((entry) => [entry.id, entry]));
  for (const account of payload.accounts) {
    if (!plans.has(account.billingPlanId)) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
  }

  const tenants = new Map(payload.tenants.map((entry) => [entry.id, entry]));
  for (const tenant of payload.tenants) {
    if (!accounts.has(tenant.accountId)) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
  }

  const projects = new Map(payload.projects.map((entry) => [entry.id, entry]));
  for (const project of payload.projects) {
    const tenant = tenants.get(project.tenantId);
    if (!tenant) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
    if (!accounts.has(project.accountId) || tenant.accountId !== project.accountId) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
  }

  const users = new Map(payload.users.map((entry) => [entry.id, entry]));
  for (const user of payload.users) {
    if (!user.accountId || !user.tenantId) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
    const tenant = tenants.get(user.tenantId);
    if (!tenant || tenant.accountId !== user.accountId) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
  }

  for (const apiKey of payload.apiKeys) {
    const account = accounts.get(apiKey.accountId);
    const tenant = tenants.get(apiKey.tenantId);
    const project = projects.get(apiKey.projectId);
    const user = users.get(apiKey.userId);
    if (!account || !tenant || !project || !user) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
    if (tenant.accountId !== account.id) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
    if (project.accountId !== account.id || project.tenantId !== tenant.id) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
    if (user.accountId !== account.id || user.tenantId !== tenant.id) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
    const plan = plans.get(account.billingPlanId);
    if (!plan) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
    if (apiKey.status === "active" && plan.status !== "active") {
      throw new ControlPlaneStoreError("control_plane_bootstrap_inactive_plan");
    }
  }

  const summary = buildBootstrapSummary(payload, undefined);
  ensureActiveCounts(summary.active);
}

function validateToolBootstrapFields(input: {
  strictToolBootstrap: boolean;
  billingPlanRows: readonly Record<string, unknown>[];
}): void {
  if (!input.strictToolBootstrap) {
    return;
  }
  for (const row of input.billingPlanRows) {
    const entitlements = isRecord(row["entitlements"]) ? row["entitlements"] : null;
    const quotas = isRecord(row["quotas"]) ? row["quotas"] : null;
    if (!entitlements || !quotas) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }

    assertHasOwn(entitlements, "allowHostedTools");
    assertHasOwn(entitlements, "allowConnectedNodeTools");
    assertHasOwn(entitlements, "allowedToolTypes");
    assertHasOwn(entitlements, "allowToolArtifactContentRead");
    assertHasOwn(quotas, "maxToolInvocationsPerHour");
    assertHasOwn(quotas, "maxActiveToolInvocations");
    assertHasOwn(quotas, "maxToolArtifactBytesPerHour");
  }
}

function buildBootstrapSummary(payload: BootstrapPayload, accountIds?: readonly string[]): ControlPlaneBootstrapSummary {
  const scope = accountIds && accountIds.length > 0 ? new Set(accountIds) : null;
  const accountInScope = (accountId: string): boolean => (scope ? scope.has(accountId) : true);
  const tenantInScope = (tenant: Tenant): boolean => accountInScope(tenant.accountId);
  const projectInScope = (project: Project): boolean => accountInScope(project.accountId);
  const userInScope = (user: User): boolean => Boolean(user.accountId && accountInScope(user.accountId));
  const apiKeyInScope = (key: ApiKeyStored): boolean => accountInScope(key.accountId);
  const planIds = new Set(payload.accounts.filter((entry) => accountInScope(entry.id)).map((entry) => entry.billingPlanId));
  const planInScope = (plan: BillingPlan): boolean => planIds.has(plan.id);

  const total: BootstrapSummaryCounts = {
    accounts: payload.accounts.filter((entry) => accountInScope(entry.id)).length,
    tenants: payload.tenants.filter(tenantInScope).length,
    projects: payload.projects.filter(projectInScope).length,
    users: payload.users.filter(userInScope).length,
    apiKeys: payload.apiKeys.filter(apiKeyInScope).length,
    billingPlans: payload.billingPlans.filter(planInScope).length
  };
  const active: BootstrapSummaryCounts = {
    accounts: payload.accounts.filter((entry) => accountInScope(entry.id) && entry.status === "active").length,
    tenants: payload.tenants.filter((entry) => tenantInScope(entry) && entry.status === "active").length,
    projects: payload.projects.filter((entry) => projectInScope(entry) && entry.status === "active").length,
    users: payload.users.filter((entry) => userInScope(entry) && (entry.status ?? "active") === "active").length,
    apiKeys: payload.apiKeys.filter((entry) => apiKeyInScope(entry) && entry.status === "active").length,
    billingPlans: payload.billingPlans.filter((entry) => planInScope(entry) && entry.status === "active").length
  };
  return { total, active };
}

function ensureActiveCounts(active: BootstrapSummaryCounts): void {
  if (
    active.accounts <= 0 ||
    active.tenants <= 0 ||
    active.projects <= 0 ||
    active.users <= 0 ||
    active.apiKeys <= 0 ||
    active.billingPlans <= 0
  ) {
    throw new ControlPlaneStoreError("control_plane_bootstrap_zero_active", { active });
  }
}

function parseEntityArray<T>(value: unknown, parser: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => parser(entry));
}

function parseRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
    }
    return entry;
  });
}

function assertUniqueIds<T extends { id: string }>(
  values: readonly T[],
  code: "control_plane_bootstrap_duplicate"
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      throw new ControlPlaneStoreError(code);
    }
    seen.add(value.id);
  }
}

function parseIso(value: string | undefined, field: string): Date {
  const candidate = value ?? new Date().toISOString();
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) {
    throw new ControlPlaneStoreError("control_plane_bootstrap_malformed", { field });
  }
  return new Date(ms);
}

function ensureValidTransition(current: QuotaState, next: QuotaState): void {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new ControlPlaneStoreError("invalid_quota_transition");
  }
}

function ensureReservationScopeMatch(
  current: Pick<QuotaReservation, "accountId" | "tenantId" | "projectId">,
  input: Pick<TransitionQuotaReservationInput, "accountId" | "tenantId" | "projectId">
): void {
  if (current.accountId !== input.accountId || current.tenantId !== input.tenantId || current.projectId !== input.projectId) {
    throw new ControlPlaneStoreError("reservation_scope_mismatch");
  }
}

function parseAuditCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) {
    return null;
  }
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
      throw new Error("invalid");
    }
    if (!Number.isFinite(Date.parse(parsed.createdAt)) || parsed.id.trim().length === 0) {
      throw new Error("invalid");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ControlPlaneStoreError("invalid_query");
  }
}

function encodeAuditCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

function clampLimit(limit: number | undefined): number {
  const resolved = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : 50;
  if (resolved <= 0 || resolved > MAX_AUDIT_PAGE_LIMIT) {
    throw new ControlPlaneStoreError("invalid_query");
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertHasOwn(value: Record<string, unknown>, field: string): void {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    throw new ControlPlaneStoreError("control_plane_bootstrap_malformed");
  }
}

function isStrictToolBootstrapMode(raw: Record<string, unknown>): boolean {
  const explicit = typeof raw["deploymentMode"] === "string" ? raw["deploymentMode"] : undefined;
  const env = process.env["SWITCHYARD_DEPLOYMENT_MODE"];
  const mode = (explicit ?? env ?? "").toLowerCase();
  return mode === "staging" || mode === "production";
}

function ownershipKey(resourceType: ResourceType, resourceId: string): string {
  return `${resourceType}:${resourceId}`;
}

function resolveOwnershipActorIds(
  userId: string | undefined,
  apiKeyId: string | undefined
): { userId: string; apiKeyId: string } {
  return {
    userId: userId && userId.trim().length > 0 ? userId : SYSTEM_USER_ID,
    apiKeyId: apiKeyId && apiKeyId.trim().length > 0 ? apiKeyId : SYSTEM_API_KEY_ID
  };
}

function quotaScopeKey(accountId: string, tenantId: string, projectId: string, quotaKind: QuotaReservation["quotaKind"]): string {
  return `${accountId}:${tenantId}:${projectId}:${quotaKind}`;
}

function safeUuid(): string {
  return randomUUID().replaceAll("-", "_");
}

function hashRawApiKey(rawKey: string, pepper: string): string {
  return createHmac("sha256", pepper).update(rawKey).digest("hex");
}

function deriveKeyPrefix(rawKey: string): string {
  const trimmed = rawKey.trim();
  const parts = trimmed.split("_").filter((entry) => entry.length > 0);
  if (parts.length >= 2) {
    return `${parts[0]}_${parts[1]}`;
  }
  return trimmed.slice(0, Math.min(8, trimmed.length));
}

function looksLikeRawKey(value: string): boolean {
  return /^sk_[A-Za-z0-9_-]+$/.test(value.trim());
}

function isSameOwner(
  ownership: Pick<ResourceOwnership, "accountId" | "tenantId" | "projectId" | "userId" | "apiKeyId">,
  input: Pick<AttachOwnershipInput, "accountId" | "tenantId" | "projectId" | "userId" | "apiKeyId">
): boolean {
  return (
    ownership.accountId === input.accountId &&
    ownership.tenantId === input.tenantId &&
    ownership.projectId === input.projectId &&
    ownership.userId === input.userId &&
    ownership.apiKeyId === input.apiKeyId
  );
}

function extractClient(input: unknown): Queryable | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const candidate = input["client"];
  if (isRecord(candidate) && typeof candidate["query"] === "function") {
    return candidate as Queryable;
  }
  return undefined;
}

function rowToOwnership(row: Record<string, unknown>): ResourceOwnership {
  return resourceOwnershipSchema.parse({
    resourceType: row["resource_type"],
    resourceId: row["resource_id"],
    accountId: row["account_id"],
    tenantId: row["tenant_id"],
    projectId: row["project_id"],
    userId: row["user_id"],
    apiKeyId: row["api_key_id"],
    createdAt: row["created_at"]
  });
}

function rowToQuotaReservation(row: Record<string, unknown>): QuotaReservation {
  return quotaReservationSchema.parse({
    id: row["id"],
    accountId: row["account_id"],
    tenantId: row["tenant_id"],
    projectId: row["project_id"],
    quotaKind: row["quota_kind"],
    amount: row["amount"],
    state: row["state"],
    reasonCode: row["reason_code"],
    createdAt: row["created_at"],
    expiresAt: row["expires_at"],
    finalizedAt: row["finalized_at"] ?? undefined
  });
}

function rowToQuotaUsage(row: Record<string, unknown>): QuotaUsageRow {
  return {
    id: String(row["id"]),
    accountId: String(row["account_id"]),
    tenantId: String(row["tenant_id"]),
    projectId: String(row["project_id"]),
    quotaKind: row["quota_kind"] as QuotaReservation["quotaKind"],
    used: Number(row["used"]),
    windowStart: String(row["window_start"]),
    windowEnd: String(row["window_end"]),
    updatedAt: String(row["updated_at"])
  };
}

function rowToAuditLogEvent(row: Record<string, unknown>): AuditLogEvent {
  return auditLogEventSchema.parse({
    id: row["id"],
    accountId: row["account_id"],
    tenantId: row["tenant_id"],
    projectId: row["project_id"] ?? undefined,
    actorType: row["actor_type"],
    actorUserId: row["actor_user_id"] ?? undefined,
    apiKeyId: row["api_key_id"] ?? undefined,
    eventType: row["event_type"],
    resourceType: row["resource_type"] ?? undefined,
    resourceId: row["resource_id"] ?? undefined,
    decision: row["decision"],
    reasonCode: row["reason_code"] ?? undefined,
    ipHash: row["ip_hash"] ?? undefined,
    userAgent: row["user_agent"] ?? undefined,
    requestId: row["request_id"] ?? undefined,
    payload: row["payload"] ?? {},
    createdAt: row["created_at"]
  });
}

function rowToAuthBundle(row: Record<string, unknown>): AuthBundle | null {
  try {
    const account = accountSchema.parse({
      id: row["account_id"],
      name: row["account_name"],
      status: row["account_status"],
      billingPlanId: row["account_billing_plan_id"],
      createdAt: row["account_created_at"],
      updatedAt: row["account_updated_at"] ?? undefined
    });
    const tenant = tenantSchema.parse({
      id: row["tenant_id"],
      accountId: row["tenant_account_id"],
      slug: row["tenant_slug"],
      displayName: row["tenant_display_name"],
      status: row["tenant_status"],
      createdAt: row["tenant_created_at"],
      updatedAt: row["tenant_updated_at"] ?? undefined
    });
    const project = projectSchema.parse({
      id: row["project_id"],
      accountId: row["project_account_id"],
      tenantId: row["project_tenant_id"],
      slug: row["project_slug"],
      displayName: row["project_display_name"],
      status: row["project_status"],
      createdAt: row["project_created_at"],
      updatedAt: row["project_updated_at"] ?? undefined
    });
    const user = userSchema.parse({
      id: row["user_id"],
      accountId: row["user_account_id"],
      tenantId: row["user_tenant_id"],
      displayName: row["user_display_name"],
      email: row["user_email"] ?? undefined,
      status: row["user_status"] ?? "active",
      createdAt: row["user_created_at"],
      updatedAt: row["user_updated_at"] ?? undefined
    });
    const apiKey = apiKeyStoredSchema.parse({
      id: row["api_key_id"],
      accountId: row["api_key_account_id"],
      tenantId: row["api_key_tenant_id"],
      projectId: row["api_key_project_id"],
      userId: row["api_key_user_id"],
      name: row["api_key_name"],
      keyPrefix: row["api_key_key_prefix"],
      secretHash: row["api_key_secret_hash"],
      scopes: row["api_key_scopes"],
      status: row["api_key_status"],
      expiresAt: row["api_key_expires_at"] ?? undefined,
      lastUsedAt: row["api_key_last_used_at"] ?? undefined,
      createdAt: row["api_key_created_at"],
      revokedAt: row["api_key_revoked_at"] ?? undefined
    });
    const plan = billingPlanSchema.parse({
      id: row["plan_id"],
      slug: row["plan_slug"],
      displayName: row["plan_display_name"],
      status: row["plan_status"],
      entitlements: row["plan_entitlements"],
      quotas: row["plan_quotas"],
      createdAt: row["plan_created_at"],
      updatedAt: row["plan_updated_at"] ?? undefined
    });
    return { account, tenant, project, user, apiKey, plan };
  } catch {
    return null;
  }
}
