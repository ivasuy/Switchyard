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

type QuotaReservationState = QuotaReservation["state"];
type OwnershipResourceType = ResourceOwnership["resourceType"];

export interface AuthBundle {
  account: Account;
  tenant: Tenant;
  project: Project;
  user: User;
  apiKey: ApiKeyStored;
  plan: BillingPlan;
  candidateBundles?: readonly AuthBundle[];
}

export interface LoadApiKeyBundleInput {
  keyPrefix: string;
  secretHash: string;
  now?: string;
}

export interface ControlPlaneBootstrapInput {
  accountIds?: readonly string[];
}

export interface ControlPlaneBootstrapSummary {
  total: {
    accounts: number;
    tenants: number;
    projects: number;
    users: number;
    apiKeys: number;
    billingPlans: number;
  };
  active: {
    accounts: number;
    tenants: number;
    projects: number;
    users: number;
    apiKeys: number;
    billingPlans: number;
  };
}

export interface ReserveQuotaInput {
  accountId: string;
  tenantId: string;
  projectId: string;
  quotaKind: QuotaReservation["quotaKind"];
  amount: number;
  maxAllowed: number;
  windowMs: number;
  reservationTtlMs: number;
  reasonCode: string;
  now?: string;
}

export interface TransitionQuotaReservationInput {
  reservationId: string;
  accountId: string;
  tenantId: string;
  projectId: string;
  nextState: QuotaReservationState;
  reasonCode?: string;
  now?: string;
  finalizedAt?: string;
}

export interface QuotaCriticalSectionScope {
  accountId: string;
  tenantId: string;
  projectId: string;
  quotaKind: QuotaReservation["quotaKind"];
}

export interface AttachOwnershipInput {
  resourceType: OwnershipResourceType;
  resourceId: string;
  accountId: string;
  tenantId: string;
  projectId: string;
  userId: string;
  apiKeyId: string;
  createdAt?: string;
}

export interface GetOwnershipInput {
  resourceType: OwnershipResourceType;
  resourceId: string;
}

export interface ListOwnedResourceIdsInput {
  resourceType: OwnershipResourceType;
  accountId: string;
  tenantId: string;
  projectId: string;
}

export interface ActiveRunCountInput {
  accountId: string;
  tenantId: string;
  projectId: string;
  now?: string;
  includeUnexpiredReservations?: boolean;
  reservationQuotaKinds?: readonly QuotaReservation["quotaKind"][];
}

export interface ActiveNodeCountInput {
  accountId: string;
  tenantId: string;
  projectId: string;
  now?: string;
}

export interface AppendAuditEventInput {
  accountId: string;
  tenantId: string;
  projectId?: string;
  actorType: "api_key" | "node_token" | "system";
  actorUserId?: string;
  apiKeyId?: string;
  eventType: string;
  resourceType?: string;
  resourceId?: string;
  decision: "allow" | "deny" | "error";
  reasonCode?: string;
  ipHash?: string;
  userAgent?: string;
  requestId?: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface ListAuditEventsInput {
  accountId: string;
  tenantId: string;
  projectId?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditEventsPage {
  events: readonly AuditLogEvent[];
  nextCursor?: string;
}

export interface UnownedResourceCounts {
  runs: number;
  runEvents: number;
  artifacts: number;
  placements: number;
  nodes: number;
  assignments: number;
  auditEvents: number;
  quotaReservations: number;
}

export interface ExpireReservationsInput {
  now?: string;
}

export interface ControlPlaneStore {
  loadApiKeyBundleByHash(input: LoadApiKeyBundleInput): Promise<AuthBundle | null>;
  bootstrap(input: ControlPlaneBootstrapInput): Promise<ControlPlaneBootstrapSummary>;
  reserveQuota(input: ReserveQuotaInput): Promise<QuotaReservation>;
  transitionQuotaReservation(input: TransitionQuotaReservationInput): Promise<QuotaReservation>;
  withQuotaCriticalSection<T>(scope: QuotaCriticalSectionScope, fn: () => Promise<T>): Promise<T>;
  attachOwnership(input: AttachOwnershipInput): Promise<ResourceOwnership>;
  getOwnership(input: GetOwnershipInput): Promise<ResourceOwnership | null>;
  listOwnedResourceIds(input: ListOwnedResourceIdsInput): Promise<readonly string[]>;
  countActiveOwnedRuns(input: ActiveRunCountInput): Promise<number>;
  countActiveOwnedNodes(input: ActiveNodeCountInput): Promise<number>;
  appendAuditEvent(input: AppendAuditEventInput): Promise<AuditLogEvent>;
  listAuditEvents(input: ListAuditEventsInput): Promise<AuditEventsPage>;
  countUnownedResources(): Promise<UnownedResourceCounts>;
  expireStaleReservations(input: ExpireReservationsInput): Promise<number>;
}
