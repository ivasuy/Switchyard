import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthContext } from "@switchyard/contracts";
import { ControlPlaneError, type ControlPlaneService, type EnterpriseScope } from "@switchyard/core";
import { sendHttpError, type HttpErrorCode, type HttpErrorDetail } from "./http-errors.js";

export interface HostedAuthDependencies {
  controlPlane?: ControlPlaneService;
  authRequired?: boolean;
  auditRouteDecisions?: boolean;
}

export interface HostedRouteAuthRequirement {
  routeId: string;
  scopes: readonly EnterpriseScope[];
  public: boolean;
}

export interface HostedRequestAuthState {
  requirement: HostedRouteAuthRequirement;
  auth: AuthContext;
}

interface RouteRule {
  method: string;
  routeId: string;
  scopes: readonly EnterpriseScope[];
  public?: boolean;
  matches: (pathname: string) => boolean;
}

const RULES: readonly RouteRule[] = [
  { method: "GET", routeId: "health", scopes: [], public: true, matches: exact("/health") },
  { method: "GET", routeId: "ready", scopes: [], public: true, matches: exact("/ready") },

  { method: "POST", routeId: "runs.create", scopes: ["runs:write"], matches: exact("/runs") },
  { method: "GET", routeId: "runs.list", scopes: ["runs:read"], matches: exact("/runs") },
  { method: "GET", routeId: "runs.get", scopes: ["runs:read"], matches: param("/runs/:id") },
  { method: "GET", routeId: "runs.events", scopes: ["runs:read"], matches: param("/runs/:id/events") },
  { method: "GET", routeId: "runs.artifacts", scopes: ["runs:read"], matches: param("/runs/:id/artifacts") },
  { method: "POST", routeId: "runs.input", scopes: ["runs:write"], matches: param("/runs/:id/input") },
  { method: "POST", routeId: "runs.cancel", scopes: ["runs:write"], matches: param("/runs/:id/cancel") },

  { method: "POST", routeId: "debates.create", scopes: ["runs:write"], matches: exact("/debates") },
  { method: "GET", routeId: "debates.get", scopes: ["runs:read"], matches: param("/debates/:id") },
  { method: "GET", routeId: "debates.events", scopes: ["runs:read"], matches: param("/debates/:id/events") },

  { method: "GET", routeId: "artifacts.get", scopes: ["artifacts:read"], matches: param("/artifacts/:id") },
  { method: "GET", routeId: "artifacts.content", scopes: ["artifacts:read"], matches: param("/artifacts/:id/content") },

  { method: "GET", routeId: "registry.providers", scopes: ["registry:read"], matches: exact("/providers") },
  { method: "GET", routeId: "registry.provider", scopes: ["registry:read"], matches: param("/providers/:id") },
  { method: "GET", routeId: "registry.runtimes", scopes: ["registry:read"], matches: exact("/runtimes") },
  { method: "GET", routeId: "registry.runtime", scopes: ["registry:read"], matches: param("/runtimes/:id") },
  { method: "GET", routeId: "registry.models", scopes: ["registry:read"], matches: exact("/models") },
  { method: "GET", routeId: "registry.model", scopes: ["registry:read"], matches: param("/models/:id") },
  { method: "GET", routeId: "registry.runtimeModes", scopes: ["registry:read"], matches: exact("/runtime-modes") },
  { method: "GET", routeId: "registry.runtimeMode", scopes: ["registry:read"], matches: param("/runtime-modes/:id") },
  { method: "POST", routeId: "registry.runtimeMode.check", scopes: ["registry:read"], matches: param("/runtime-modes/:id/check") },
  { method: "GET", routeId: "registry.doctor", scopes: ["registry:read"], matches: exact("/doctor") },

  { method: "GET", routeId: "auth.whoami", scopes: ["admin:read"], matches: exact("/auth/whoami") },
  { method: "GET", routeId: "entitlements.get", scopes: ["entitlements:read"], matches: exact("/entitlements") },
  { method: "GET", routeId: "audit.events", scopes: ["audit:read"], matches: exact("/audit/events") },

  { method: "POST", routeId: "tools.invocations.create", scopes: ["tools:write"], matches: exact("/tools/invocations") },
  { method: "GET", routeId: "tools.invocations.list", scopes: ["tools:read"], matches: exact("/tools/invocations") },
  { method: "GET", routeId: "tools.invocations.get", scopes: ["tools:read"], matches: param("/tools/invocations/:id") },
  { method: "GET", routeId: "tools.approvals.list", scopes: ["tools:read"], matches: exact("/approvals") },
  { method: "GET", routeId: "tools.approvals.get", scopes: ["tools:read"], matches: param("/approvals/:id") },
  { method: "POST", routeId: "tools.approvals.approve", scopes: ["tools:write"], matches: param("/approvals/:id/approve") },
  { method: "POST", routeId: "tools.approvals.reject", scopes: ["tools:write"], matches: param("/approvals/:id/reject") }
];

export function registerHostedAuthHooks(app: FastifyInstance, deps: HostedAuthDependencies): void {
  const controlPlane = deps.controlPlane;
  if (!controlPlane) {
    return;
  }

  app.addHook("onRequest", async (request, reply) => {
    const requirement = getHostedRouteAuthRequirement(request.method, routePathname(request));
    if (!requirement || requirement.public) {
      return;
    }

    let auth: AuthContext | undefined;
    try {
      const authInput: Parameters<ControlPlaneService["authenticateRequest"]>[0] = {
        headers: request.headers as Record<string, string | string[] | undefined>
      };
      const query = asRecord(request.query);
      if (query) {
        authInput.query = query;
      }
      auth = await controlPlane.authenticateRequest(authInput);
      for (const scope of requirement.scopes) {
        controlPlane.requireScope(auth, scope);
      }
      request.hostedAuth = { requirement, auth };

      if (deps.auditRouteDecisions) {
        await controlPlane.recordAudit({
          auth,
          eventType: "api_key.auth_succeeded",
          decision: "allow",
          reasonCode: "auth_allowed",
          resourceType: "auth",
          resourceId: requirement.routeId,
          requestId: request.id,
          payload: { routeId: requirement.routeId }
        });
      }
      return;
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        if (deps.auditRouteDecisions) {
          const eventType = error.code === "auth_required" || error.code === "auth_failed" || error.code === "auth_conflict"
            ? "api_key.auth_failed"
            : error.code === "tenant_access_denied"
              ? "tenant.access_denied"
              : error.code === "entitlement_denied"
                ? "entitlement.denied"
                : error.code === "quota_exceeded"
                  ? "quota.denied"
                  : "api_key.auth_failed";
          const auditInput: Parameters<ControlPlaneService["recordAudit"]>[0] = {
            eventType,
            decision: "deny",
            reasonCode: error.reasonCode,
            resourceType: "auth",
            resourceId: requirement.routeId,
            requestId: request.id,
            payload: {
              routeId: requirement.routeId,
              method: request.method,
              pathname: routePathname(request)
            }
          };
          if (auth) {
            auditInput.auth = auth;
          }
          await controlPlane.recordAudit(auditInput);
        }
        return sendHttpError(reply, error.code, error.reasonCode, controlPlaneDetails(error));
      }
      throw error;
    }
  });
}

export function getHostedRouteAuthRequirement(method: string, pathname: string): HostedRouteAuthRequirement | null {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = normalizePathname(pathname);
  for (const rule of RULES) {
    if (rule.method !== normalizedMethod) {
      continue;
    }
    if (!rule.matches(normalizedPath)) {
      continue;
    }
    return {
      routeId: rule.routeId,
      scopes: rule.scopes,
      public: rule.public === true
    };
  }
  return null;
}

export function getHostedAuthContext(request: FastifyRequest): AuthContext | undefined {
  return request.hostedAuth?.auth;
}

function controlPlaneDetails(error: ControlPlaneError): HttpErrorDetail[] | undefined {
  const details: HttpErrorDetail[] = [{ path: "reasonCode", issue: error.reasonCode }];
  if (error.safeDetails) {
    for (const [key, value] of Object.entries(error.safeDetails)) {
      details.push({ path: key, issue: String(value) });
    }
  }
  return details;
}

function routePathname(request: FastifyRequest): string {
  const rawRoute = (request.routeOptions as { url?: unknown } | undefined)?.url;
  if (typeof rawRoute === "string" && rawRoute.length > 0) {
    return normalizePathname(rawRoute);
  }

  const rawUrl = request.raw.url ?? request.url;
  return normalizePathname(rawUrl ?? "/");
}

function normalizePathname(pathname: string): string {
  const [withoutQuery] = pathname.split("?", 1);
  if (!withoutQuery || withoutQuery.length === 0) {
    return "/";
  }
  const normalized = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function controlToRegex(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        return "[^/]+";
      }
      return escapeRegex(segment);
    })
    .join("/");
  return new RegExp(`^${source}$`);
}

function exact(path: string): (pathname: string) => boolean {
  const normalized = normalizePathname(path);
  return (pathname) => normalizePathname(pathname) === normalized;
}

function param(path: string): (pathname: string) => boolean {
  const regex = controlToRegex(normalizePathname(path));
  return (pathname) => regex.test(normalizePathname(pathname));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

declare module "fastify" {
  interface FastifyRequest {
    hostedAuth?: HostedRequestAuthState;
  }
}

export function isHostedAuthErrorCode(code: HttpErrorCode): boolean {
  return code === "auth_required" ||
    code === "auth_failed" ||
    code === "auth_conflict" ||
    code === "auth_store_unavailable" ||
    code === "tenant_access_denied" ||
    code === "project_access_denied" ||
    code === "entitlement_denied" ||
    code === "quota_exceeded";
}
