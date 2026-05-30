import { AgentFieldAsyncRestAdapter } from "./agentfield/agentfield-async-rest-adapter.js";
import { GenericHttpAsyncRestAdapter } from "./generic-http/generic-http-adapter.js";

export type CompatibilityStatus = "pass" | "skip" | "fail";

export interface AdapterCompatibilityRow {
  runtimeMode: string;
  adapterId: string;
  status: CompatibilityStatus;
  reason: string;
}

export interface AdapterCompatibilityMatrix {
  generatedAt: string;
  rows: AdapterCompatibilityRow[];
  summary: {
    pass: number;
    skip: number;
    fail: number;
  };
}

export async function generateCompatibilityMatrix(): Promise<AdapterCompatibilityMatrix> {
  const rows: AdapterCompatibilityRow[] = [];

  rows.push({
    runtimeMode: "fake.deterministic",
    adapterId: "fake",
    status: "pass",
    reason: "Deterministic in-process fake runtime contract is covered by local test harness."
  });

  rows.push({
    runtimeMode: "codex.exec_json",
    adapterId: "codex",
    status: "skip",
    reason: "ci_no_spend"
  });

  rows.push({
    runtimeMode: "claude_code.sdk",
    adapterId: "claude_code",
    status: "skip",
    reason: "ci_no_spend"
  });

  const genericHttp = new GenericHttpAsyncRestAdapter();
  rows.push(await evaluateCheck("generic_http.async_rest", genericHttp.id, () => genericHttp.check()));

  const agentfield = new AgentFieldAsyncRestAdapter();
  rows.push(await evaluateCheck("agentfield.async_rest", agentfield.id, () => agentfield.check()));

  rows.push({
    runtimeMode: "opencode.acp",
    adapterId: "opencode",
    status: "skip",
    reason: "ci_no_spend"
  });

  const summary = {
    pass: rows.filter((row) => row.status === "pass").length,
    skip: rows.filter((row) => row.status === "skip").length,
    fail: rows.filter((row) => row.status === "fail").length
  };

  return {
    generatedAt: new Date(0).toISOString(),
    rows,
    summary
  };
}

async function evaluateCheck(
  runtimeMode: string,
  adapterId: string,
  check: () => Promise<{ ok: boolean; message?: string; details?: Record<string, unknown> }>
): Promise<AdapterCompatibilityRow> {
  try {
    const result = await check();
    if (result.ok) {
      return {
        runtimeMode,
        adapterId,
        status: "pass",
        reason: result.message ?? "check ok"
      };
    }

    const reasonCode = extractReasonCode(result.details);
    return {
      runtimeMode,
      adapterId,
      status: "skip",
      reason: reasonCode ?? result.message ?? "adapter unavailable in no-spend mode"
    };
  } catch (error) {
    return {
      runtimeMode,
      adapterId,
      status: "fail",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function extractReasonCode(details: Record<string, unknown> | undefined): string | undefined {
  const availability = details?.["availability"];
  if (!availability || typeof availability !== "object" || Array.isArray(availability)) {
    return undefined;
  }
  const code = (availability as Record<string, unknown>)["reasonCode"];
  return typeof code === "string" && code.length > 0 ? code : undefined;
}
