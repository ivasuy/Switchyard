import type { FastifyInstance } from "fastify";
import {
  auditEventsResponseSchema,
  entitlementsResponseSchema,
  whoamiResponseSchema
} from "@switchyard/contracts";
import { ControlPlaneError, type ControlPlaneService } from "@switchyard/core";
import { getHostedAuthContext } from "./hosted-auth.js";
import { HttpProblem, sendHttpError } from "./http-errors.js";

export interface EnterpriseRouteDependencies {
  controlPlane: ControlPlaneService;
}

export function registerEnterpriseRoutes(app: FastifyInstance, deps: EnterpriseRouteDependencies): void {
  app.get("/auth/whoami", async (request, reply) => {
    const auth = getHostedAuthContext(request);
    if (!auth) {
      return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
    }

    const payload = deps.controlPlane.whoami(auth);
    return whoamiResponseSchema.parse(payload);
  });

  app.get("/entitlements", async (request, reply) => {
    const auth = getHostedAuthContext(request);
    if (!auth) {
      return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
    }

    const payload = await deps.controlPlane.entitlementSnapshot(auth);
    return entitlementsResponseSchema.parse(payload);
  });

  app.get("/audit/events", async (request, reply) => {
    const auth = getHostedAuthContext(request);
    if (!auth) {
      return sendHttpError(reply, "auth_required", "auth_required", [{ path: "reasonCode", issue: "auth_required" }]);
    }

    const query = request.query as Record<string, unknown>;
    const limit = parseLimit(query["limit"]);
    const cursor = parseCursor(query["cursor"]);

    try {
      const listInput: Parameters<ControlPlaneService["listAuditEvents"]>[0] = { auth };
      if (limit !== undefined) {
        listInput.limit = limit;
      }
      if (cursor !== undefined) {
        listInput.cursor = cursor;
      }
      const payload = await deps.controlPlane.listAuditEvents(listInput);
      return auditEventsResponseSchema.parse(payload);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        return sendHttpError(reply, error.code, error.reasonCode, [{ path: "reasonCode", issue: error.reasonCode }]);
      }
      if (error instanceof Error && error.message === "invalid_query") {
        throw new HttpProblem("invalid_query", "Invalid query parameters", [
          { path: "cursor", issue: "must be an opaque cursor from a previous response" }
        ]);
      }
      throw error;
    }
  });
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 200) {
      throw new HttpProblem("invalid_query", "Invalid query parameters", [
        { path: "limit", issue: "must be an integer from 1 to 200" }
      ]);
    }
    return Math.floor(parsed);
  }
  throw new HttpProblem("invalid_query", "Invalid query parameters", [
    { path: "limit", issue: "must be an integer from 1 to 200" }
  ]);
}

function parseCursor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new HttpProblem("invalid_query", "Invalid query parameters", [
    { path: "cursor", issue: "must be a non-empty string" }
  ]);
}
