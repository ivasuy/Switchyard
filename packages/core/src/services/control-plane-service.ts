import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ApiKeyPublic,
  ApiKeyStored,
  AuditEventsResponse,
  AuditLogEvent,
  AuthContext,
  EntitlementSnapshot,
  EntitlementsResponse,
  HttpErrorCode,
  QuotaReservation,
  ResourceOwnership,
  WhoamiResponse
} from "@switchyard/contracts";
import { httpErrorCodeSchema } from "@switchyard/contracts";
import { isRealHostedRuntimeMode } from "./hosted-runtime-catalog.js";
import { redactSecrets } from "./local-policy-gate.js";
import type {
  ActiveNodeCountInput,
  ActiveRunCountInput,
  AppendAuditEventInput,
  AuthBundle,
  ControlPlaneStore,
  ListAuditEventsInput as StoreListAuditEventsInput,
  QuotaCriticalSectionScope,
  ReserveQuotaInput,
  TransitionQuotaReservationInput
} from "../ports/control-plane-store.js";

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "timeout"] as const;

const HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1_000;

const STATUS_BY_CODE: Record<HttpErrorCode, number> = Object.assign(
  Object.fromEntries(httpErrorCodeSchema.options.map((code) => [code, 500])) as Record<HttpErrorCode, number>,
  {
  run_not_found: 404,
  debate_not_found: 404,
  artifact_not_found: 404,
  missing_artifact_content: 404,
  provider_not_found: 404,
  runtime_not_found: 404,
  runtime_mode_not_found: 404,
  model_not_found: 404,
  message_not_found: 404,
  memory_not_found: 404,
  evidence_not_found: 404,
  approval_not_found: 404,
  tool_invocation_not_found: 404,
  approval_not_pending: 409,
  tool_policy_denied: 403,
  tool_policy_config_invalid: 403,
  tool_policy_failed: 409,
  tool_adapter_unavailable: 500,
  approval_required: 409,
  unsupported_tool: 409,
  invalid_input: 400,
  invalid_query: 400,
  adapter_protocol_failed: 409,
  internal_error: 500,
  placement_denied: 409,
  node_auth_required: 401,
  node_auth_failed: 401,
  node_not_found: 404,
  assignment_not_found: 404,
  assignment_claim_conflict: 409,
  node_policy_denied: 403,
  queue_unavailable: 503,
  event_sync_gap: 409,
  event_sync_conflict: 409,
  object_store_unavailable: 503,
  object_store_timeout: 503,
  object_store_auth_failed: 503,
  object_store_bucket_not_found: 503,
  object_store_read_failed: 503,
  artifact_digest_mismatch: 409,
  artifact_content_empty: 409,
  artifact_sync_failed: 500,
  hosted_runtime_not_allowed: 409,
  payload_too_large: 413,
  auth_required: 401,
  auth_failed: 401,
  auth_conflict: 401,
  auth_store_unavailable: 503,
  tenant_access_denied: 403,
  project_access_denied: 403,
  entitlement_denied: 403,
  quota_exceeded: 429,
  audit_log_unavailable: 503
}
);

const FORBIDDEN_QUERY_CREDENTIAL_KEYS = new Set(["api_key", "token", "authorization"]);

const EXTRA_SECRET_KEY_PATTERN = /(pepper|secrethash|private|credential|passwd)/i;

export type EnterpriseScope = AuthContext["apiKey"]["scopes"][number];
type OwnershipType = ResourceOwnership["resourceType"];
type AuditActorType = "api_key" | "node_token" | "system";
type AuditDecision = "allow" | "deny" | "error";

export interface ControlPlaneServiceInput {
  store: ControlPlaneStore;
  apiKeyPepper: string;
  now?: () => string;
}

export interface AuthenticateRequestInput {
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  now?: string;
}

export interface AuthorizeResourceInput {
  auth: AuthContext;
  resourceType: OwnershipType;
  resourceId: string;
  notFoundCode?: HttpErrorCode;
}

export type AuthorizeResourceResult =
  | { ok: true; ownership: ResourceOwnership }
  | {
      ok: false;
      decision: "not_found" | "denied";
      code: HttpErrorCode;
      reasonCode: string;
    };

export interface EnsureOwnedOrAttachFromRunInput {
  auth: AuthContext;
  resourceType: OwnershipType;
  resourceId: string;
  runId: string;
}

export type EnsureOwnedResult =
  | { ok: true; ownership: ResourceOwnership; created: boolean }
  | { ok: false; reasonCode: "ownership_attach_failed"; code: "ownership_attach_failed" };

export interface PreflightRunCreateInput {
  auth: AuthContext;
  placement: "hosted" | "local" | "connected_local_node";
  runtimeMode: string;
  timeoutSeconds: number;
  now?: string;
}

export interface ReleaseQuotaReservationInput {
  auth: AuthContext;
  reservationId: string;
  outcome: "consumed" | "released" | "failed" | "expired";
  reasonCode?: string;
  now?: string;
}

export interface PreflightArtifactContentReadInput {
  auth: AuthContext;
  artifactId: string;
  expectedBytes: number;
  now?: string;
}

export interface PreflightNodeRegisterInput {
  auth: AuthContext;
  nodeId: string;
  now?: string;
}

export interface ControlPlaneListAuditEventsInput {
  auth: AuthContext;
  limit?: number;
  cursor?: string;
}

export interface RecordAuditInput {
  auth?: AuthContext;
  accountId?: string;
  tenantId?: string;
  projectId?: string;
  actorType?: AuditActorType;
  eventType: string;
  decision: AuditDecision;
  reasonCode?: string;
  resourceType?: string;
  resourceId?: string;
  requestId?: string;
  userAgent?: string;
  ipHash?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export type RecordAuditResult =
  | { ok: true; event: AuditLogEvent }
  | { ok: false; reasonCode: "audit_append_failed"; error: ControlPlaneError };

export class ControlPlaneError extends Error {
  readonly code: HttpErrorCode;
  readonly reasonCode: string;
  readonly statusCode: number;
  readonly safeDetails?: Record<string, unknown>;

  constructor(code: HttpErrorCode, reasonCode: string, message?: string, safeDetails?: Record<string, unknown>) {
    super(message ?? reasonCode);
    this.code = code;
    this.reasonCode = reasonCode;
    this.statusCode = STATUS_BY_CODE[code];
    if (safeDetails) {
      this.safeDetails = safeDetails;
    }
  }
}

export class ControlPlaneService {
  private readonly now: () => string;

  constructor(private readonly input: ControlPlaneServiceInput) {
    this.now = input.now ?? (() => new Date().toISOString());
  }

  async authenticateRequest(input: AuthenticateRequestInput): Promise<AuthContext> {
    denyQueryCredentials(input.query);
    const extracted = extractApiKey(input.headers);
    const now = input.now ?? this.now();
    const keyPrefix = deriveKeyPrefix(extracted);
    const secretHash = hashApiKey(extracted, this.input.apiKeyPepper);

    let bundle: AuthBundle | null;
    try {
      bundle = await this.input.store.loadApiKeyBundleByHash({ keyPrefix, secretHash, now });
    } catch {
      throw new ControlPlaneError("auth_store_unavailable", "auth_store_unavailable");
    }

    if (!bundle) {
      throw new ControlPlaneError("auth_failed", "invalid_api_key");
    }

    const matched = matchCandidateBundle(secretHash, bundle);
    if (!matched) {
      throw new ControlPlaneError("auth_failed", "invalid_api_key");
    }

    validateBundleIsActive(matched, now);

    return buildAuthContext(matched, now);
  }

  requireScope(auth: AuthContext, scope: EnterpriseScope): void {
    if (!auth.apiKey.scopes.includes(scope)) {
      throw new ControlPlaneError("tenant_access_denied", "missing_scope", "missing_scope", { scope });
    }
    const entitlement = normalizeEntitlement(auth);

    if (scope === "artifacts:read" && !entitlement.allowArtifactContentRead) {
      throw new ControlPlaneError("entitlement_denied", "artifact_content_read_disabled");
    }
    if (scope === "nodes:write" && !entitlement.allowConnectedNodes) {
      throw new ControlPlaneError("entitlement_denied", "connected_nodes_disabled");
    }
    if (scope === "metrics:read" && !entitlement.allowMetricsRead) {
      throw new ControlPlaneError("entitlement_denied", "metrics_read_disabled");
    }
    if (scope === "audit:read" && !entitlement.allowAuditRead) {
      throw new ControlPlaneError("entitlement_denied", "audit_read_disabled");
    }
  }

  async authorizeResource(input: AuthorizeResourceInput): Promise<AuthorizeResourceResult> {
    const ownership = await this.input.store.getOwnership({
      resourceType: input.resourceType,
      resourceId: input.resourceId
    });
    if (!ownership) {
      return {
        ok: false,
        decision: "not_found",
        code: input.notFoundCode ?? "project_access_denied",
        reasonCode: "resource_not_owned"
      };
    }

    const auth = input.auth;
    const mismatch =
      ownership.accountId !== auth.account.id ||
      ownership.tenantId !== auth.tenant.id ||
      ownership.projectId !== auth.project.id;

    if (mismatch) {
      return {
        ok: false,
        decision: "denied",
        code: "tenant_access_denied",
        reasonCode: "tenant_mismatch"
      };
    }

    return { ok: true, ownership };
  }

  async ensureOwnedOrAttachFromRun(input: EnsureOwnedOrAttachFromRunInput): Promise<EnsureOwnedResult> {
    const existing = await this.input.store.getOwnership({
      resourceType: input.resourceType,
      resourceId: input.resourceId
    });

    if (existing) {
      const sameOwner =
        existing.accountId === input.auth.account.id &&
        existing.tenantId === input.auth.tenant.id &&
        existing.projectId === input.auth.project.id &&
        existing.userId === input.auth.user.id &&
        existing.apiKeyId === input.auth.apiKey.id;
      if (!sameOwner) {
        return { ok: false, reasonCode: "ownership_attach_failed", code: "ownership_attach_failed" };
      }
      return { ok: true, ownership: existing, created: false };
    }

    try {
      const attached = await this.input.store.attachOwnership({
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        accountId: input.auth.account.id,
        tenantId: input.auth.tenant.id,
        projectId: input.auth.project.id,
        userId: input.auth.user.id,
        apiKeyId: input.auth.apiKey.id,
        createdAt: this.now()
      });
      return { ok: true, ownership: attached, created: true };
    } catch {
      return { ok: false, reasonCode: "ownership_attach_failed", code: "ownership_attach_failed" };
    }
  }

  async preflightRunCreate(input: PreflightRunCreateInput): Promise<QuotaReservation> {
    this.requireScope(input.auth, "runs:write");

    const entitlement = normalizeEntitlement(input.auth);
    if (!entitlement.allowedPlacements.includes(input.placement)) {
      throw new ControlPlaneError("entitlement_denied", "placement_not_allowed");
    }
    if (!entitlement.allowedRuntimeModes.includes(input.runtimeMode)) {
      throw new ControlPlaneError("entitlement_denied", "runtime_mode_not_allowed");
    }
    if (input.placement === "hosted" && isRealHostedRuntimeMode(input.runtimeMode) && !entitlement.allowHostedRealRuntime) {
      throw new ControlPlaneError("entitlement_denied", "hosted_real_runtime_disabled");
    }
    if (input.timeoutSeconds > entitlement.maxRunTimeoutSeconds) {
      throw new ControlPlaneError("quota_exceeded", "run_timeout_exceeded");
    }

    const scope: QuotaCriticalSectionScope = {
      accountId: input.auth.account.id,
      tenantId: input.auth.tenant.id,
      projectId: input.auth.project.id,
      quotaKind: "runs_per_hour"
    };

    return this.input.store.withQuotaCriticalSection(scope, async () => {
      const now = input.now ?? this.now();
      await this.input.store.expireStaleReservations({ now });

      const activePressureInput: ActiveRunCountInput = {
        accountId: input.auth.account.id,
        tenantId: input.auth.tenant.id,
        projectId: input.auth.project.id,
        now,
        includeUnexpiredReservations: true,
        reservationQuotaKinds: ["runs_per_hour", "active_runs"]
      };
      const activePressure = await this.input.store.countActiveOwnedRuns(activePressureInput);
      if (activePressure >= entitlement.maxActiveRuns) {
        throw new ControlPlaneError("quota_exceeded", "active_runs_exceeded");
      }

      const reserveInput: ReserveQuotaInput = {
        accountId: input.auth.account.id,
        tenantId: input.auth.tenant.id,
        projectId: input.auth.project.id,
        userId: input.auth.user.id,
        apiKeyId: input.auth.apiKey.id,
        quotaKind: "runs_per_hour",
        amount: 1,
        maxAllowed: entitlement.maxRunsPerHour,
        windowMs: HOUR_MS,
        reservationTtlMs: DEFAULT_RESERVATION_TTL_MS,
        reasonCode: "run_create",
        now
      };

      try {
        return await this.input.store.reserveQuota(reserveInput);
      } catch (error) {
        if (isQuotaExceededError(error)) {
          throw new ControlPlaneError("quota_exceeded", "runs_per_hour_exceeded");
        }
        throw error;
      }
    });
  }

  async releaseQuotaReservation(input: ReleaseQuotaReservationInput): Promise<QuotaReservation> {
    this.ensureSameProject(input.auth, input.auth.account.id, input.auth.tenant.id, input.auth.project.id);
    const transition: TransitionQuotaReservationInput = {
      reservationId: input.reservationId,
      accountId: input.auth.account.id,
      tenantId: input.auth.tenant.id,
      projectId: input.auth.project.id,
      nextState: input.outcome,
      now: input.now ?? this.now()
    };
    if (input.reasonCode) {
      transition.reasonCode = input.reasonCode;
    }
    try {
      return await this.input.store.transitionQuotaReservation(transition);
    } catch (error) {
      if (error instanceof Error && error.message === "reservation_scope_mismatch") {
        throw new ControlPlaneError("tenant_access_denied", "reservation_scope_mismatch");
      }
      throw error;
    }
  }

  async preflightArtifactContentRead(input: PreflightArtifactContentReadInput): Promise<QuotaReservation> {
    this.requireScope(input.auth, "artifacts:read");
    const entitlement = normalizeEntitlement(input.auth);
    if (!entitlement.allowArtifactContentRead) {
      throw new ControlPlaneError("entitlement_denied", "artifact_content_read_disabled");
    }

    const authz = await this.authorizeResource({
      auth: input.auth,
      resourceType: "artifact",
      resourceId: input.artifactId,
      notFoundCode: "artifact_not_found"
    });
    if (!authz.ok) {
      throw new ControlPlaneError(authz.code, authz.reasonCode);
    }

    if (!Number.isFinite(input.expectedBytes) || input.expectedBytes <= 0) {
      throw new ControlPlaneError("quota_exceeded", "artifact_read_bytes_exceeded");
    }

    const scope: QuotaCriticalSectionScope = {
      accountId: input.auth.account.id,
      tenantId: input.auth.tenant.id,
      projectId: input.auth.project.id,
      quotaKind: "artifact_read_bytes_per_hour"
    };

    return this.input.store.withQuotaCriticalSection(scope, async () => {
      const now = input.now ?? this.now();
      await this.input.store.expireStaleReservations({ now });
      const reserveInput: ReserveQuotaInput = {
        accountId: input.auth.account.id,
        tenantId: input.auth.tenant.id,
        projectId: input.auth.project.id,
        userId: input.auth.user.id,
        apiKeyId: input.auth.apiKey.id,
        quotaKind: "artifact_read_bytes_per_hour",
        amount: Math.ceil(input.expectedBytes),
        maxAllowed: entitlement.maxArtifactContentReadBytesPerHour,
        windowMs: HOUR_MS,
        reservationTtlMs: DEFAULT_RESERVATION_TTL_MS,
        reasonCode: "artifact_content_read",
        now
      };

      try {
        return await this.input.store.reserveQuota(reserveInput);
      } catch (error) {
        if (isQuotaExceededError(error)) {
          throw new ControlPlaneError("quota_exceeded", "artifact_read_bytes_exceeded");
        }
        throw error;
      }
    });
  }

  async preflightNodeRegister(input: PreflightNodeRegisterInput): Promise<QuotaReservation> {
    this.requireScope(input.auth, "nodes:write");
    const entitlement = normalizeEntitlement(input.auth);
    if (!entitlement.allowConnectedNodes) {
      throw new ControlPlaneError("entitlement_denied", "connected_nodes_disabled");
    }

    const existing = await this.input.store.getOwnership({ resourceType: "node", resourceId: input.nodeId });
    if (existing) {
      const mismatch =
        existing.accountId !== input.auth.account.id ||
        existing.tenantId !== input.auth.tenant.id ||
        existing.projectId !== input.auth.project.id;
      if (mismatch) {
        throw new ControlPlaneError("tenant_access_denied", "tenant_mismatch");
      }
    }

    const scope: QuotaCriticalSectionScope = {
      accountId: input.auth.account.id,
      tenantId: input.auth.tenant.id,
      projectId: input.auth.project.id,
      quotaKind: "connected_nodes"
    };

    return this.input.store.withQuotaCriticalSection(scope, async () => {
      const now = input.now ?? this.now();
      await this.input.store.expireStaleReservations({ now });

      const activeNodeInput: ActiveNodeCountInput = {
        accountId: input.auth.account.id,
        tenantId: input.auth.tenant.id,
        projectId: input.auth.project.id,
        now
      };
      const activeNodes = await this.input.store.countActiveOwnedNodes(activeNodeInput);
      if (activeNodes >= entitlement.maxConnectedNodes) {
        throw new ControlPlaneError("quota_exceeded", "connected_nodes_exceeded");
      }

      const reserveInput: ReserveQuotaInput = {
        accountId: input.auth.account.id,
        tenantId: input.auth.tenant.id,
        projectId: input.auth.project.id,
        userId: input.auth.user.id,
        apiKeyId: input.auth.apiKey.id,
        quotaKind: "connected_nodes",
        amount: 1,
        maxAllowed: entitlement.maxConnectedNodes,
        windowMs: HOUR_MS,
        reservationTtlMs: DEFAULT_RESERVATION_TTL_MS,
        reasonCode: "node_register",
        now
      };

      try {
        return await this.input.store.reserveQuota(reserveInput);
      } catch (error) {
        if (isQuotaExceededError(error)) {
          throw new ControlPlaneError("quota_exceeded", "connected_nodes_exceeded");
        }
        throw error;
      }
    });
  }

  whoami(auth: AuthContext): WhoamiResponse {
    return { auth };
  }

  async entitlementSnapshot(auth: AuthContext): Promise<EntitlementsResponse> {
    return { entitlement: auth.entitlement };
  }

  async listAuditEvents(input: ControlPlaneListAuditEventsInput): Promise<AuditEventsResponse> {
    this.requireScope(input.auth, "audit:read");
    const params: StoreListAuditEventsInput = {
      accountId: input.auth.account.id,
      tenantId: input.auth.tenant.id,
      projectId: input.auth.project.id
    };
    if (typeof input.limit === "number") {
      params.limit = input.limit;
    }
    if (typeof input.cursor === "string") {
      params.cursor = input.cursor;
    }
    const page = await this.input.store.listAuditEvents(params);
    return {
      events: [...page.events],
      nextCursor: page.nextCursor
    };
  }

  async recordAudit(input: RecordAuditInput): Promise<RecordAuditResult> {
    const resolved = resolveAuditOwner(input);
    const payload = redactAuditPayload(input.payload ?? {});
    const appendInput: AppendAuditEventInput = {
      accountId: resolved.accountId,
      tenantId: resolved.tenantId,
      actorType: resolved.actorType,
      eventType: input.eventType,
      decision: input.decision,
      payload,
      createdAt: input.createdAt ?? this.now()
    };
    if (resolved.projectId) appendInput.projectId = resolved.projectId;
    if (resolved.actorUserId) appendInput.actorUserId = resolved.actorUserId;
    if (resolved.apiKeyId) appendInput.apiKeyId = resolved.apiKeyId;
    if (input.resourceType) appendInput.resourceType = input.resourceType;
    if (input.resourceId) appendInput.resourceId = input.resourceId;
    if (input.reasonCode) appendInput.reasonCode = input.reasonCode;
    if (input.requestId) appendInput.requestId = input.requestId;
    if (input.userAgent) appendInput.userAgent = input.userAgent;
    if (input.ipHash) appendInput.ipHash = input.ipHash;

    try {
      const event = (await this.input.store.appendAuditEvent(appendInput)) as AuditLogEvent;
      return { ok: true, event };
    } catch {
      return {
        ok: false,
        reasonCode: "audit_append_failed",
        error: new ControlPlaneError("audit_log_unavailable", "audit_append_failed")
      };
    }
  }

  private ensureSameProject(auth: AuthContext, accountId: string, tenantId: string, projectId: string): void {
    if (auth.account.id !== accountId || auth.tenant.id !== tenantId || auth.project.id !== projectId) {
      throw new ControlPlaneError("tenant_access_denied", "tenant_mismatch");
    }
  }
}

export function hashApiKey(rawKey: string, pepper: string): string {
  return createHmac("sha256", pepper).update(rawKey).digest("hex");
}

function matchCandidateBundle(secretHash: string, bundle: AuthBundle): AuthBundle | null {
  const candidates = bundle.candidateBundles && bundle.candidateBundles.length > 0 ? bundle.candidateBundles : [bundle];
  let matched: AuthBundle | null = null;
  for (const candidate of candidates) {
    const isMatch = secureHashEquals(candidate.apiKey.secretHash, secretHash);
    if (isMatch && !matched) {
      matched = candidate;
    }
  }
  return matched;
}

function validateBundleIsActive(bundle: AuthBundle, now: string): void {
  const apiKey = bundle.apiKey;
  if (apiKey.status !== "active") {
    throw new ControlPlaneError("auth_failed", apiKey.status === "revoked" ? "api_key_revoked" : "api_key_inactive");
  }
  if (apiKey.expiresAt && Date.parse(apiKey.expiresAt) <= Date.parse(now)) {
    throw new ControlPlaneError("auth_failed", "api_key_expired");
  }

  if (bundle.account.status !== "active") {
    throw new ControlPlaneError("auth_failed", "account_inactive");
  }
  if (bundle.tenant.status !== "active") {
    throw new ControlPlaneError("auth_failed", "tenant_inactive");
  }
  if (bundle.project.status !== "active") {
    throw new ControlPlaneError("auth_failed", "project_inactive");
  }
  if ((bundle.user.status ?? "active") !== "active") {
    throw new ControlPlaneError("auth_failed", "user_inactive");
  }

  if (bundle.plan.status !== "active") {
    throw new ControlPlaneError("entitlement_denied", "plan_inactive");
  }
}

function buildAuthContext(bundle: AuthBundle, now: string): AuthContext {
  const publicKey: ApiKeyPublic = {
    id: bundle.apiKey.id,
    accountId: bundle.apiKey.accountId,
    tenantId: bundle.apiKey.tenantId,
    projectId: bundle.apiKey.projectId,
    userId: bundle.apiKey.userId,
    name: bundle.apiKey.name,
    keyPrefix: bundle.apiKey.keyPrefix,
    scopes: [...bundle.apiKey.scopes],
    status: bundle.apiKey.status,
    createdAt: bundle.apiKey.createdAt
  };
  if (bundle.apiKey.expiresAt) (publicKey as Record<string, unknown>).expiresAt = bundle.apiKey.expiresAt;
  if (bundle.apiKey.revokedAt) (publicKey as Record<string, unknown>).revokedAt = bundle.apiKey.revokedAt;
  if ((bundle.apiKey as Record<string, unknown>).updatedAt) {
    (publicKey as Record<string, unknown>).updatedAt = (bundle.apiKey as Record<string, unknown>).updatedAt;
  }
  if ((bundle.apiKey as Record<string, unknown>).lastUsedAt) {
    (publicKey as Record<string, unknown>).lastUsedAt = (bundle.apiKey as Record<string, unknown>).lastUsedAt;
  }

  const normalized = normalizePlan(bundle.plan);
  const entitlementRecord: Record<string, unknown> = {
    accountId: bundle.account.id,
    tenantId: bundle.tenant.id,
    projectId: bundle.project.id,
    planId: bundle.plan.id,
    planName: normalized.planName,
    planSlug: normalized.planSlug,
    planDisplayName: normalized.planName,
    planStatus: bundle.plan.status,
    allowedPlacements: normalized.allowedPlacements,
    allowedRuntimeModes: normalized.allowedRuntimeModes,
    allowHostedRealRuntime: normalized.allowHostedRealRuntime,
    maxTimeoutSeconds: normalized.maxRunTimeoutSeconds,
    maxRunsPerHour: normalized.maxRunsPerHour,
    maxActiveRuns: normalized.maxActiveRuns,
    maxConnectedNodes: normalized.maxConnectedNodes,
    maxArtifactContentReadBytesPerHour: normalized.maxArtifactContentReadBytesPerHour,
    entitlements: {
      allowedPlacements: normalized.allowedPlacements,
      allowedRuntimeModes: normalized.allowedRuntimeModes,
      allowHostedRealRuntime: normalized.allowHostedRealRuntime,
      allowConnectedNodes: normalized.allowConnectedNodes,
      allowArtifactContentRead: normalized.allowArtifactContentRead,
      allowMetricsRead: normalized.allowMetricsRead,
      allowAuditRead: normalized.allowAuditRead
    },
    quotas: {
      maxRunsPerHour: normalized.maxRunsPerHour,
      maxActiveRuns: normalized.maxActiveRuns,
      maxRunTimeoutSeconds: normalized.maxRunTimeoutSeconds,
      maxConnectedNodes: normalized.maxConnectedNodes,
      maxArtifactContentReadBytesPerHour: normalized.maxArtifactContentReadBytesPerHour
    },
    scopes: [...bundle.apiKey.scopes],
    capturedAt: now
  };
  const entitlement = entitlementRecord as EntitlementSnapshot;

  return {
    account: bundle.account,
    tenant: bundle.tenant,
    project: bundle.project,
    user: bundle.user,
    apiKey: publicKey,
    entitlement
  };
}

interface NormalizedEntitlement {
  planName: string;
  planSlug: string;
  allowedPlacements: string[];
  allowedRuntimeModes: string[];
  allowHostedRealRuntime: boolean;
  allowConnectedNodes: boolean;
  allowArtifactContentRead: boolean;
  allowMetricsRead: boolean;
  allowAuditRead: boolean;
  maxRunsPerHour: number;
  maxActiveRuns: number;
  maxRunTimeoutSeconds: number;
  maxConnectedNodes: number;
  maxArtifactContentReadBytesPerHour: number;
}

function normalizePlan(plan: AuthBundle["plan"]): NormalizedEntitlement {
  const raw = plan as unknown as Record<string, unknown>;
  const entitlements = asRecord(raw.entitlements);
  const quotas = asRecord(raw.quotas);
  return {
    planName: asString(raw.displayName ?? raw.name, "plan"),
    planSlug: asString(raw.slug ?? raw.name ?? "plan", "plan"),
    allowedPlacements: asStringArray(entitlements?.allowedPlacements ?? raw.allowedPlacements),
    allowedRuntimeModes: asStringArray(entitlements?.allowedRuntimeModes ?? raw.allowedRuntimeModes),
    allowHostedRealRuntime: asBoolean(entitlements?.allowHostedRealRuntime ?? raw.allowHostedRealRuntime),
    allowConnectedNodes: asBoolean(entitlements?.allowConnectedNodes ?? (asNumber(quotas?.maxConnectedNodes ?? raw.maxConnectedNodes, 0) > 0)),
    allowArtifactContentRead: asBoolean(
      entitlements?.allowArtifactContentRead ??
        (asNumber(quotas?.maxArtifactContentReadBytesPerHour ?? raw.maxArtifactContentReadBytesPerHour, 0) > 0)
    ),
    allowMetricsRead: asBoolean(entitlements?.allowMetricsRead ?? false),
    allowAuditRead: asBoolean(entitlements?.allowAuditRead ?? true),
    maxRunsPerHour: asNumber(quotas?.maxRunsPerHour ?? raw.maxRunsPerHour, 0),
    maxActiveRuns: asNumber(quotas?.maxActiveRuns ?? raw.maxActiveRuns, 0),
    maxRunTimeoutSeconds: asNumber(quotas?.maxRunTimeoutSeconds ?? raw.maxRunTimeoutSeconds ?? raw.maxTimeoutSeconds, 0),
    maxConnectedNodes: asNumber(quotas?.maxConnectedNodes ?? raw.maxConnectedNodes, 0),
    maxArtifactContentReadBytesPerHour: asNumber(
      quotas?.maxArtifactContentReadBytesPerHour ?? raw.maxArtifactContentReadBytesPerHour,
      0
    )
  };
}

function normalizeEntitlement(auth: AuthContext): NormalizedEntitlement {
  const raw = auth.entitlement as unknown as Record<string, unknown>;
  const entitlements = asRecord(raw.entitlements);
  const quotas = asRecord(raw.quotas);
  return {
    planName: asString(raw.planDisplayName ?? raw.planName, "plan"),
    planSlug: asString(raw.planSlug ?? raw.planName ?? "plan", "plan"),
    allowedPlacements: asStringArray(entitlements?.allowedPlacements ?? raw.allowedPlacements),
    allowedRuntimeModes: asStringArray(entitlements?.allowedRuntimeModes ?? raw.allowedRuntimeModes),
    allowHostedRealRuntime: asBoolean(entitlements?.allowHostedRealRuntime ?? raw.allowHostedRealRuntime),
    allowConnectedNodes: asBoolean(entitlements?.allowConnectedNodes ?? (asNumber(quotas?.maxConnectedNodes ?? raw.maxConnectedNodes, 0) > 0)),
    allowArtifactContentRead: asBoolean(
      entitlements?.allowArtifactContentRead ??
        (asNumber(quotas?.maxArtifactContentReadBytesPerHour ?? raw.maxArtifactContentReadBytesPerHour, 0) > 0)
    ),
    allowMetricsRead: asBoolean(entitlements?.allowMetricsRead ?? false),
    allowAuditRead: asBoolean(entitlements?.allowAuditRead ?? true),
    maxRunsPerHour: asNumber(quotas?.maxRunsPerHour ?? raw.maxRunsPerHour, 0),
    maxActiveRuns: asNumber(quotas?.maxActiveRuns ?? raw.maxActiveRuns, 0),
    maxRunTimeoutSeconds: asNumber(quotas?.maxRunTimeoutSeconds ?? raw.maxRunTimeoutSeconds ?? raw.maxTimeoutSeconds, 0),
    maxConnectedNodes: asNumber(quotas?.maxConnectedNodes ?? raw.maxConnectedNodes, 0),
    maxArtifactContentReadBytesPerHour: asNumber(
      quotas?.maxArtifactContentReadBytesPerHour ?? raw.maxArtifactContentReadBytesPerHour,
      0
    )
  };
}

function denyQueryCredentials(query: Record<string, unknown> | undefined): void {
  if (!query) {
    return;
  }
  for (const key of Object.keys(query)) {
    if (FORBIDDEN_QUERY_CREDENTIAL_KEYS.has(key.toLowerCase())) {
      throw new ControlPlaneError("auth_failed", "query_credentials_not_allowed");
    }
  }
}

function extractApiKey(headers: Record<string, string | string[] | undefined> | undefined): string {
  const authorization = readHeader(headers, "authorization");
  const xApiKey = readHeader(headers, "x-switchyard-api-key");

  const bearerKey = parseBearerAuthorization(authorization);
  const headerKey = parseHeaderApiKey(xApiKey);

  if (!bearerKey && !headerKey) {
    throw new ControlPlaneError("auth_required", "auth_required");
  }

  if (bearerKey && headerKey && bearerKey !== headerKey) {
    throw new ControlPlaneError("auth_conflict", "conflicting_credentials");
  }

  const resolved = bearerKey ?? headerKey;
  if (!resolved) {
    throw new ControlPlaneError("auth_required", "auth_required");
  }

  if (resolved.trim().length === 0) {
    throw new ControlPlaneError("auth_failed", "blank_key_material");
  }
  return resolved;
}

function parseBearerAuthorization(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ControlPlaneError("auth_failed", "malformed_authorization");
  }

  const parts = trimmed.split(/\s+/);
  const scheme = parts[0] ?? "";
  if (parts.length !== 2 || !/^bearer$/i.test(scheme)) {
    throw new ControlPlaneError("auth_failed", "malformed_authorization");
  }

  const keyMaterial = (parts[1] ?? "").trim();
  if (keyMaterial.length === 0 || /^bearer$/i.test(keyMaterial)) {
    throw new ControlPlaneError("auth_failed", "malformed_authorization");
  }

  return keyMaterial;
}

function parseHeaderApiKey(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ControlPlaneError("auth_failed", "blank_key_material");
  }
  return trimmed;
}

function deriveKeyPrefix(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed.length === 0) {
    throw new ControlPlaneError("auth_failed", "blank_key_material");
  }
  const parts = trimmed.split("_").filter((entry) => entry.length > 0);
  if (parts.length >= 2) {
    return `${parts[0]}_${parts[1]}`;
  }
  return trimmed.slice(0, Math.min(8, trimmed.length));
}

function readHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  headerName: string
): string | undefined {
  if (!headers) {
    return undefined;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== headerName.toLowerCase()) {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return "";
      }
      const first = value[0];
      return typeof first === "string" ? first : "";
    }
    return undefined;
  }

  return undefined;
}

function secureHashEquals(stored: string, computed: string): boolean {
  if (!isHexDigest(stored) || !isHexDigest(computed)) {
    return false;
  }
  if (stored.length !== computed.length) {
    return false;
  }

  const storedBuffer = Buffer.from(stored, "hex");
  const computedBuffer = Buffer.from(computed, "hex");
  if (storedBuffer.length !== computedBuffer.length) {
    return false;
  }
  try {
    return timingSafeEqual(storedBuffer, computedBuffer);
  } catch {
    return false;
  }
}

function isHexDigest(value: string): boolean {
  return value.length % 2 === 0 && /^[a-f0-9]+$/i.test(value);
}

function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof ControlPlaneError) {
    return error.code === "quota_exceeded";
  }
  return error instanceof Error && error.message.includes("quota_exceeded");
}

function resolveAuditOwner(input: RecordAuditInput): {
  accountId: string;
  tenantId: string;
  projectId: string | undefined;
  actorType: AuditActorType;
  actorUserId: string | undefined;
  apiKeyId: string | undefined;
} {
  if (input.auth) {
    return {
      accountId: input.auth.account.id,
      tenantId: input.auth.tenant.id,
      projectId: input.auth.project.id,
      actorType: input.actorType ?? "api_key",
      actorUserId: input.auth.user.id,
      apiKeyId: input.auth.apiKey.id
    };
  }

  if (!input.accountId || !input.tenantId) {
    throw new ControlPlaneError("audit_log_unavailable", "audit_owner_missing");
  }

  return {
    accountId: input.accountId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    actorType: input.actorType ?? "system",
    actorUserId: undefined,
    apiKeyId: undefined
  };
}

function redactAuditPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactSecrets(payload);
  return deepRedactExtraSecrets(redacted) as Record<string, unknown>;
}

function deepRedactExtraSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => deepRedactExtraSecrets(entry));
  }
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (EXTRA_SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = deepRedactExtraSecrets(entry);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}
