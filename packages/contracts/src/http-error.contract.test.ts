import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { R18_HTTP_ERROR_CODES, httpErrorCodeSchema, httpErrorEnvelopeSchema } from "./http-error.js";
import {
  ACP_RUNTIME_BRIDGE_REASON_CODES,
  HOSTED_RUNTIME_BRIDGE_REASON_CODES
} from "./hosted-runtime-bridge.js";

const R22_TOOL_ERROR_CODES = [
  "tool_run_required",
  "tool_target_invalid",
  "tool_target_mismatch",
  "tool_hosted_auth_required",
  "tool_store_unavailable",
  "tool_dispatch_unavailable",
  "tool_dispatch_failed",
  "tool_dispatch_retry_exhausted",
  "tool_real_tools_disabled",
  "tool_hosted_tools_disabled",
  "tool_connected_node_tools_disabled",
  "tool_approval_required",
  "tool_approval_rejected",
  "tool_approval_expired",
  "tool_input_limit_exceeded",
  "tool_concurrency_limit_exceeded",
  "tool_output_limit_exceeded",
  "tool_artifact_write_failed",
  "tool_redaction_failed",
  "tool_worker_restarted",
  "tool_node_unavailable",
  "tool_node_execution_failed",
  "tool_assignment_expired",
  "tool_assignment_mismatch",
  "hosted_runtime_approval_bridge_unshipped",
  "approval_scope_denied",
  "repo_hosted_unshipped",
  "browser_tool_unshipped"
] as const;

function protocolErrorCodes(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const protocolFile = join(here, "../../protocol-rest/src/http-errors.ts");
  const source = readFileSync(protocolFile, "utf8");
  const match = source.match(/export type HttpErrorCode =([\s\S]*?)\n\nexport interface HttpErrorDetail/);
  if (!match || !match[1]) {
    throw new Error("failed to locate protocol-rest HttpErrorCode union");
  }
  return [...match[1].matchAll(/\|\s+"([a-z0-9_]+)"/g)].map((entry) => entry[1] ?? "").filter(Boolean).sort();
}

function protocolStatusFor(code: string): number {
  const here = dirname(fileURLToPath(import.meta.url));
  const protocolFile = join(here, "../../protocol-rest/src/http-errors.ts");
  const source = readFileSync(protocolFile, "utf8");
  const matcher = new RegExp(`${code}:\\s*(\\d+)`);
  const match = source.match(matcher);
  if (!match || !match[1]) {
    throw new Error(`failed to locate status mapping for ${code}`);
  }
  return Number(match[1]);
}

describe("http error contract", () => {
  it("accepts requestId in the HTTP error envelope", () => {
    const parsed = httpErrorEnvelopeSchema.parse({
      error: {
        code: "run_not_found",
        message: "missing",
        requestId: "req_123"
      }
    });
    expect(parsed.error.requestId).toBe("req_123");
  });

  it("matches all protocol-rest HTTP error codes", () => {
    const contractCodes = [...httpErrorCodeSchema.options];
    const routeCodes = protocolErrorCodes();

    expect([...contractCodes].sort()).toEqual(expect.arrayContaining(routeCodes));
    expect([...routeCodes].sort()).toEqual(routeCodes);
  });

  it("includes all R18 enterprise HTTP errors and protocol status mappings", () => {
    for (const code of R18_HTTP_ERROR_CODES) {
      expect(httpErrorCodeSchema.parse(code)).toBe(code);
    }

    expect(protocolStatusFor("auth_required")).toBe(401);
    expect(protocolStatusFor("auth_failed")).toBe(401);
    expect(protocolStatusFor("auth_conflict")).toBe(401);
    expect(protocolStatusFor("auth_store_unavailable")).toBe(503);
    expect(protocolStatusFor("tenant_access_denied")).toBe(403);
    expect(protocolStatusFor("project_access_denied")).toBe(403);
    expect(protocolStatusFor("entitlement_denied")).toBe(403);
    expect(protocolStatusFor("quota_exceeded")).toBe(429);
    expect(protocolStatusFor("audit_log_unavailable")).toBe(503);
  });

  it("includes all named R22 tool HTTP errors in the contracts schema", () => {
    for (const code of R22_TOOL_ERROR_CODES) {
      expect(httpErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  it("includes all named R23 hosted runtime bridge and ACP reason codes", () => {
    for (const code of HOSTED_RUNTIME_BRIDGE_REASON_CODES) {
      expect(httpErrorCodeSchema.parse(code)).toBe(code);
    }
    for (const code of ACP_RUNTIME_BRIDGE_REASON_CODES) {
      expect(httpErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  it("maps hosted_runtime_bridge_non_idempotent_retry_blocked through adapter_protocol_failed conflict status", () => {
    expect(httpErrorCodeSchema.parse("hosted_runtime_bridge_non_idempotent_retry_blocked")).toBe(
      "hosted_runtime_bridge_non_idempotent_retry_blocked"
    );
    expect(protocolStatusFor("adapter_protocol_failed")).toBe(409);
  });
});
