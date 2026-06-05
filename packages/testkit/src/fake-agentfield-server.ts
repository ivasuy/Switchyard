import Fastify, { type FastifyInstance } from "fastify";

export type FakeAgentFieldScenario =
  | "happy"
  | "bridge_happy"
  | "bridge_capability_missing"
  | "health_http_500"
  | "health_degraded"
  | "invalid_health_json"
  | "oversized_health_response"
  | "discovery_unavailable"
  | "invalid_discovery_json"
  | "target_not_found"
  | "start_http_500"
  | "invalid_start_json"
  | "oversized_start_response"
  | "upstream_failed"
  | "upstream_cancelled"
  | "upstream_timeout"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "waiting_for_approval_duplicate"
  | "waiting_for_approval_malformed"
  | "unknown_status"
  | "invalid_status_json"
  | "oversized_status_response"
  | "oversized_result_response"
  | "bridge_input_http_500"
  | "bridge_input_invalid_json"
  | "bridge_input_malformed_response"
  | "bridge_input_oversized_response"
  | "bridge_input_timeout"
  | "bridge_approval_http_500"
  | "bridge_approval_invalid_json"
  | "bridge_approval_malformed_response"
  | "bridge_approval_oversized_response"
  | "bridge_approval_timeout"
  | "pending_forever"
  | "late_success"
  | "error_echo_secret";

export interface FakeAgentFieldServerOptions {
  host?: string;
  port?: number;
  scenario?: FakeAgentFieldScenario;
  expectedApiKey?: string;
  target?: string;
  lateSuccessPollCount?: number;
}

interface ExecutionState {
  executionId: string;
  target: string;
  pollCount: number;
}

export interface FakeAgentFieldServerStats {
  healthCalls: number;
  discoveryCalls: number;
  executeAsyncCalls: number;
  pollCalls: number;
  inputCalls: number;
  approvalResolutionCalls: number;
  lastInput: Record<string, unknown> | undefined;
  lastApprovalResolution: Record<string, unknown> | undefined;
  lastApprovalToken: string | undefined;
}

export interface FakeAgentFieldServerHandle {
  baseUrl: string;
  stats: FakeAgentFieldServerStats;
  close(): Promise<void>;
  url(path: string): string;
}

export async function startFakeAgentFieldServer(
  options: FakeAgentFieldServerOptions = {}
): Promise<FakeAgentFieldServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const scenario = options.scenario ?? "happy";
  const target = options.target ?? "research-agent.deep_analysis";
  const lateSuccessPollCount = Math.max(2, options.lateSuccessPollCount ?? 4);
  const app = Fastify({ logger: false });

  const stats: FakeAgentFieldServerStats = {
    healthCalls: 0,
    discoveryCalls: 0,
    executeAsyncCalls: 0,
    pollCalls: 0,
    inputCalls: 0,
    approvalResolutionCalls: 0,
    lastInput: undefined,
    lastApprovalResolution: undefined,
    lastApprovalToken: undefined
  };
  const executions = new Map<string, ExecutionState>();
  let executionCounter = 0;

  app.addHook("onRequest", async (request, reply) => {
    if (!options.expectedApiKey) {
      return;
    }
    const authorization = request.headers["authorization"];
    const expected = `Bearer ${options.expectedApiKey}`;
    if (authorization !== expected) {
      reply.code(401).send({
        error: "unauthorized"
      });
    }
  });

  app.get("/api/v1/health", async (_request, reply) => {
    stats.healthCalls += 1;
    if (scenario === "health_http_500") {
      return reply.code(500).send({
        status: "error"
      });
    }
    if (scenario === "invalid_health_json") {
      reply.type("application/json");
      return reply.send("not-json");
    }
    if (scenario === "oversized_health_response") {
      return reply.send({
        status: "ok",
        payload: oversizedPayload()
      });
    }
    if (scenario === "health_degraded") {
      return reply.send({
        status: "degraded",
        details: "degraded dependencies"
      });
    }
    return reply.send({
      status: "ok",
      service: "fake-agentfield"
    });
  });

  app.get("/api/v1/discovery/capabilities", async (_request, reply) => {
    stats.discoveryCalls += 1;
    if (scenario === "discovery_unavailable") {
      return reply.code(404).send({
        error: "not_found"
      });
    }
    if (scenario === "invalid_discovery_json") {
      reply.type("application/json");
      return reply.send("not-json");
    }
    return reply.send({
      targets: scenario === "target_not_found"
        ? ["other.target"]
        : [target, "summarizer.default"],
      supports_async_execution: true,
      ...(scenario === "bridge_happy"
        ? {
            switchyard_bridge: {
              input: true,
              approval_request: true,
              approval_resolution: true
            }
          }
        : {}),
      ...(scenario === "bridge_capability_missing"
        ? {
            switchyard_bridge: {
              input: true,
              approval_request: false,
              approval_resolution: true
            }
          }
        : {})
    });
  });

  app.post("/api/v1/execute/async/:target", async (request, reply) => {
    stats.executeAsyncCalls += 1;
    if (scenario === "start_http_500") {
      return reply.code(500).send({
        error: "start_failed"
      });
    }
    if (scenario === "invalid_start_json") {
      return reply.code(202).send({
        accepted: true
      });
    }
    if (scenario === "oversized_start_response") {
      return reply.code(202).send({
        execution_id: "exec_oversized_start",
        payload: oversizedPayload()
      });
    }
    const targetParam = (request.params as { target: string }).target;
    if (targetParam !== target) {
      return reply.code(404).send({
        error: "target_not_found"
      });
    }

    const executionId = `exec_${++executionCounter}`;
    executions.set(executionId, {
      executionId,
      target,
      pollCount: 0
    });
    return reply.code(202).send({
      execution_id: executionId,
      status: "queued"
    });
  });

  app.post("/api/v1/executions/:executionId/input", async (request, reply) => {
    stats.inputCalls += 1;
    stats.lastInput = isRecord(request.body) ? request.body : undefined;
    const executionId = (request.params as { executionId: string }).executionId;
    if (!executions.has(executionId)) {
      return reply.code(404).send({
        error: "execution_not_found"
      });
    }
    if (scenario === "bridge_input_http_500") {
      return reply.code(500).send({
        error: "input_failed"
      });
    }
    if (scenario === "bridge_input_invalid_json") {
      reply.type("application/json");
      return reply.send("not-json");
    }
    if (scenario === "bridge_input_malformed_response") {
      return reply.send({
        accepted: false
      });
    }
    if (scenario === "bridge_input_oversized_response") {
      return reply.send({
        accepted: true,
        payload: oversizedPayload()
      });
    }
    if (scenario === "bridge_input_timeout") {
      await sleep(1000);
    }
    return reply.code(202).send({
      accepted: true,
      input_id: `input_${stats.inputCalls}`
    });
  });

  app.post("/api/v1/executions/:executionId/approvals/:runtimeApprovalToken/resolve", async (request, reply) => {
    stats.approvalResolutionCalls += 1;
    stats.lastApprovalResolution = isRecord(request.body) ? request.body : undefined;
    stats.lastApprovalToken = (request.params as { runtimeApprovalToken: string }).runtimeApprovalToken;
    const executionId = (request.params as { executionId: string }).executionId;
    if (!executions.has(executionId)) {
      return reply.code(404).send({
        error: "execution_not_found"
      });
    }
    if (scenario === "bridge_approval_http_500") {
      return reply.code(500).send({
        error: "approval_failed"
      });
    }
    if (scenario === "bridge_approval_invalid_json") {
      reply.type("application/json");
      return reply.send("not-json");
    }
    if (scenario === "bridge_approval_malformed_response") {
      return reply.send({
        accepted: false
      });
    }
    if (scenario === "bridge_approval_oversized_response") {
      return reply.send({
        accepted: true,
        payload: oversizedPayload()
      });
    }
    if (scenario === "bridge_approval_timeout") {
      await sleep(1000);
    }
    return reply.code(202).send({
      accepted: true,
      resolution_id: `resolution_${stats.approvalResolutionCalls}`
    });
  });

  app.get("/api/v1/executions/:executionId", async (request, reply) => {
    stats.pollCalls += 1;
    const executionId = (request.params as { executionId: string }).executionId;
    const execution = executions.get(executionId);
    if (!execution) {
      return reply.code(404).send({
        error: "execution_not_found"
      });
    }
    execution.pollCount += 1;

    if (scenario === "invalid_status_json") {
      return reply.send({
        execution_id: executionId
      });
    }
    if (scenario === "oversized_status_response") {
      return reply.send({
        execution_id: executionId,
        status: "running",
        payload: oversizedPayload()
      });
    }

    const response = buildExecutionResponse({
      scenario,
      execution,
      lateSuccessPollCount,
      expectedApiKey: options.expectedApiKey
    });

    if (scenario === "oversized_result_response" && response.status === "succeeded") {
      return reply.send({
        ...response,
        result: {
          payload: oversizedPayload()
        }
      });
    }

    return reply.send(response);
  });

  await app.listen({ host, port });
  const address = app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host}:${actualPort}`;

  return {
    baseUrl,
    stats,
    close: async () => {
      await closeApp(app);
    },
    url: (path: string) => `${baseUrl}${path}`
  };
}

function buildExecutionResponse(input: {
  scenario: FakeAgentFieldScenario;
  execution: ExecutionState;
  lateSuccessPollCount: number;
  expectedApiKey: string | undefined;
}): Record<string, unknown> {
  const { scenario, execution, lateSuccessPollCount } = input;

  if (scenario === "pending_forever") {
    return {
      execution_id: execution.executionId,
      status: "pending"
    };
  }
  if (scenario === "waiting_for_input") {
    return {
      execution_id: execution.executionId,
      status: execution.pollCount === 1 ? "running" : "waiting_for_input"
    };
  }
  if (scenario === "waiting_for_approval" || scenario === "waiting_for_approval_duplicate") {
    return {
      execution_id: execution.executionId,
      status: execution.pollCount === 1 ? "running" : "waiting_for_approval",
      approval: {
        token: "af_approval_1",
        approval_type: "before_external_message",
        message: "AgentField requests permission to continue.",
        expires_at: "2026-06-04T20:00:00.000Z"
      }
    };
  }
  if (scenario === "waiting_for_approval_malformed") {
    return {
      execution_id: execution.executionId,
      status: execution.pollCount === 1 ? "running" : "waiting_for_approval",
      approval: {
        approval_type: "before_external_message",
        expires_at: "2026-06-04T20:00:00.000Z"
      }
    };
  }
  if (scenario === "unknown_status") {
    return {
      execution_id: execution.executionId,
      status: "mystery_state"
    };
  }

  if (execution.pollCount === 1) {
    return {
      execution_id: execution.executionId,
      status: "running"
    };
  }

  if (scenario === "upstream_failed") {
    return {
      execution_id: execution.executionId,
      status: "failed",
      error: {
        message: "upstream failed"
      }
    };
  }
  if (scenario === "upstream_cancelled") {
    return {
      execution_id: execution.executionId,
      status: "cancelled"
    };
  }
  if (scenario === "upstream_timeout") {
    return {
      execution_id: execution.executionId,
      status: "timeout"
    };
  }
  if (scenario === "error_echo_secret") {
    return {
      execution_id: execution.executionId,
      status: "failed",
      error: {
        message: `Authorization: Bearer ${input.expectedApiKey ?? "secret-token"}`
      }
    };
  }
  if (scenario === "late_success" && execution.pollCount < lateSuccessPollCount) {
    return {
      execution_id: execution.executionId,
      status: "pending"
    };
  }

  return {
    execution_id: execution.executionId,
    status: "succeeded",
    result: {
      text: "agentfield output",
      output_text: "agentfield output"
    }
  };
}

function oversizedPayload(): string {
  return "x".repeat(8192);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeApp(app: FastifyInstance): Promise<void> {
  try {
    await app.close();
  } catch {
    // best effort close for test helpers
  }
}
