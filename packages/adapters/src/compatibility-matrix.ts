import { type RuntimeAdapter } from "@switchyard/core";
import { FakeRuntimeAdapter, runRuntimeAdapterContract } from "@switchyard/testkit";
import { ClaudeCodeAdapter, createClaudeCodeCliClient } from "./claude-code/index.js";
import { CodexExecJsonAdapter } from "./codex/codex-exec-json-adapter.js";
import { AgentFieldAsyncRestAdapter } from "./agentfield/agentfield-async-rest-adapter.js";
import { GenericHttpAsyncRestAdapter } from "./generic-http/generic-http-adapter.js";
import { OpenCodeAcpAdapter } from "./opencode/opencode-acp-adapter.js";

export type CompatibilityStatus = "pass" | "skip" | "fail";

export interface AdapterCompatibilityRow {
  runtimeModeId: string;
  runtimeModeSlug: string;
  adapterId: string;
  providerId: string;
  runtimeId: string;
  adapterType: string;
  kind: string;
  capabilities: string[];
  limitations: string[];
  placementSupport: {
    local: string;
    hosted: string;
    connectedLocalNode: string;
  };
  doctorStrategy: string;
  noSpendHarness: {
    type: string;
    mode?: string;
  };
  coveredScenarios: string[];
  ciStatus: CompatibilityStatus;
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

interface MatrixSeed {
  adapter: RuntimeAdapter;
  noSpendHarness: {
    type: string;
    mode?: string;
  };
  coveredScenarios: string[];
  evaluate: (adapter: RuntimeAdapter) => Promise<{ ciStatus: CompatibilityStatus; reason: string }>;
}

export async function generateCompatibilityMatrix(): Promise<AdapterCompatibilityMatrix> {
  const seeds = buildMatrixSeeds();
  const rows: AdapterCompatibilityRow[] = [];

  for (const seed of seeds) {
    const manifest = seed.adapter.manifest;
    assertManifestCompleteness(seed.adapter.id, manifest);
    const evaluation = await seed.evaluate(seed.adapter);
    rows.push({
      runtimeModeId: manifest.runtimeModeId,
      runtimeModeSlug: manifest.runtimeModeSlug,
      adapterId: manifest.adapterId,
      providerId: manifest.providerId,
      runtimeId: manifest.runtimeId,
      adapterType: manifest.adapterType,
      kind: manifest.kind,
      capabilities: [...manifest.capabilities],
      limitations: manifest.limitations.map((limitation) => `${limitation.code}: ${limitation.message}`),
      placementSupport: {
        local: manifest.placement.local.support,
        hosted: manifest.placement.hosted.support,
        connectedLocalNode: manifest.placement.connectedLocalNode.support
      },
      doctorStrategy: manifest.check.strategy,
      noSpendHarness: seed.noSpendHarness,
      coveredScenarios: [...seed.coveredScenarios],
      ciStatus: evaluation.ciStatus,
      reason: evaluation.reason
    });
  }

  validateCompatibilityRows(rows);

  const summary = {
    pass: rows.filter((row) => row.ciStatus === "pass").length,
    skip: rows.filter((row) => row.ciStatus === "skip").length,
    fail: rows.filter((row) => row.ciStatus === "fail").length
  };

  return {
    generatedAt: new Date(0).toISOString(),
    rows,
    summary
  };
}

export function validateCompatibilityRows(rows: readonly AdapterCompatibilityRow[]): void {
  const seenSlugs = new Set<string>();
  for (const row of rows) {
    if (!row.runtimeModeSlug || !row.runtimeModeId || !row.adapterId || !row.providerId || !row.runtimeId) {
      throw new Error("compatibility matrix row is missing one or more manifest identity fields");
    }
    if (seenSlugs.has(row.runtimeModeSlug)) {
      throw new Error(`duplicate runtimeModeSlug in compatibility matrix: ${row.runtimeModeSlug}`);
    }
    seenSlugs.add(row.runtimeModeSlug);

    if (!row.noSpendHarness.type || row.noSpendHarness.type.trim().length === 0) {
      throw new Error(`compatibility matrix row ${row.runtimeModeSlug} is missing noSpendHarness.type`);
    }
    if (row.coveredScenarios.length === 0) {
      throw new Error(`compatibility matrix row ${row.runtimeModeSlug} must declare coveredScenarios`);
    }
  }
}

function buildMatrixSeeds(): MatrixSeed[] {
  return [
    {
      adapter: new FakeRuntimeAdapter(),
      noSpendHarness: {
        type: "runtime-adapter-contract-harness",
        mode: "in_process_fake"
      },
      coveredScenarios: [
        "check",
        "start",
        "event_streaming",
        "cancel",
        "artifact_transcript"
      ],
      evaluate: async (adapter) => {
        try {
          await runRuntimeAdapterContract({
            adapter,
            runtime: "fake",
            provider: "test",
            model: "test-model",
            adapterType: "process"
          });
          return {
            ciStatus: "pass",
            reason: "runtime adapter contract harness passed"
          };
        } catch (error) {
          return {
            ciStatus: "fail",
            reason: error instanceof Error ? error.message : String(error)
          };
        }
      }
    },
    {
      adapter: new CodexExecJsonAdapter(),
      noSpendHarness: {
        type: "manifest_only",
        mode: "ci_skip"
      },
      coveredScenarios: ["manifest_coverage", "doctor_strategy"],
      evaluate: async () => ({
        ciStatus: "skip",
        reason: "ci_no_spend"
      })
    },
    {
      adapter: new ClaudeCodeAdapter({
        client: createClaudeCodeCliClient({
          command: "claude",
          permissionMode: "read_only",
          disabledTools: ["Bash", "WebFetch", "WebSearch"]
        }),
        liveProbe: false,
        requestTimeoutMs: 5000,
        maxBudgetUsd: 0.05
      }),
      noSpendHarness: {
        type: "manifest_only",
        mode: "ci_skip"
      },
      coveredScenarios: ["manifest_coverage", "doctor_strategy"],
      evaluate: async () => ({
        ciStatus: "skip",
        reason: "ci_no_spend"
      })
    },
    {
      adapter: new GenericHttpAsyncRestAdapter(),
      noSpendHarness: {
        type: "fake_http_server",
        mode: "check_only"
      },
      coveredScenarios: ["doctor_check", "config_validation", "availability_reason_codes"],
      evaluate: async (adapter) => evaluateCheckOnlyAdapter(adapter)
    },
    {
      adapter: new AgentFieldAsyncRestAdapter(),
      noSpendHarness: {
        type: "fake_http_server",
        mode: "check_only"
      },
      coveredScenarios: ["doctor_check", "config_validation", "availability_reason_codes"],
      evaluate: async (adapter) => evaluateCheckOnlyAdapter(adapter)
    },
    {
      adapter: new OpenCodeAcpAdapter(),
      noSpendHarness: {
        type: "fake_acp_process",
        mode: "ci_skip"
      },
      coveredScenarios: ["manifest_coverage", "doctor_strategy"],
      evaluate: async () => ({
        ciStatus: "skip",
        reason: "ci_no_spend"
      })
    }
  ];
}

async function evaluateCheckOnlyAdapter(adapter: RuntimeAdapter): Promise<{ ciStatus: CompatibilityStatus; reason: string }> {
  try {
    const check = await adapter.check({ timeoutMs: 1000, maxDiagnosticBytes: 4096 });
    if (check.ok) {
      return {
        ciStatus: "pass",
        reason: check.message ?? "check ok"
      };
    }
    const reasonCode = extractReasonCode(check.details);
    return {
      ciStatus: "skip",
      reason: reasonCode ?? check.message ?? "adapter unavailable in no-spend mode"
    };
  } catch (error) {
    return {
      ciStatus: "fail",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function assertManifestCompleteness(adapterId: string, manifest: RuntimeAdapter["manifest"]): void {
  if (
    !manifest.runtimeModeId ||
    !manifest.runtimeModeSlug ||
    !manifest.adapterId ||
    !manifest.providerId ||
    !manifest.runtimeId
  ) {
    throw new Error(`adapter ${adapterId} manifest is missing identity fields`);
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
