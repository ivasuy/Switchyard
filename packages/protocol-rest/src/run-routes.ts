import type { FastifyInstance } from "fastify";
import type { ArtifactStore, EventBus, EventStore, RunLauncherService, RunService, RunStore } from "@switchyard/core";
import { adapterTypeSchema } from "@switchyard/contracts";
import { formatSseEvent } from "./sse.js";

export interface RunRouteDependencies {
  runService: RunService;
  runs: RunStore;
  events: EventStore;
  artifacts?: ArtifactStore;
  eventBus?: EventBus;
  launcher?: RunLauncherService;
}

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDependencies): void {
  app.post("/runs", async (request, reply) => {
    const wait = request.query && typeof request.query === "object" && (request.query as Record<string, unknown>)["wait"] === "1";
    const body = createRunBody(request.body);
    const run = await deps.runService.createRun({
      runtime: body.runtime,
      provider: body.provider,
      model: body.model,
      adapterType: body.adapterType,
      cwd: body.cwd,
      task: body.task,
      placement: body.placement ?? "local",
      approvalPolicy: body.approvalPolicy ?? "default",
      timeoutSeconds: body.timeoutSeconds ?? 600,
      metadata: body.metadata ?? {}
    });
    if (wait) {
      const completed = await deps.runService.startRun(run.id);
      return reply.code(201).send({ run: completed });
    }
    deps.launcher?.launch(run);
    return reply.code(202).send({ run });
  });

  app.get("/runs/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = await deps.runs.get(id);
    if (!run) {
      return reply.code(404).send({ error: { code: "run_not_found", message: `Run not found: ${id}` } });
    }

    const events = await deps.events.listByRun(id);
    return { run, events };
  });

  app.get("/runs/:id/events", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = await deps.runs.get(id);
    if (!run) {
      return reply.code(404).send({ error: { code: "run_not_found", message: `Run not found: ${id}` } });
    }

    const events = await deps.events.listByRun(id);
    const body = events.map(formatSseEvent).join("");

    return reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(body);
  });

  app.get("/runs/:id/artifacts", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = await deps.runs.get(id);
    if (!run) {
      return reply.code(404).send({ error: { code: "run_not_found", message: `Run not found: ${id}` } });
    }
    if (!deps.artifacts) {
      return { artifacts: [] };
    }
    return { artifacts: await deps.artifacts.listByRun(id) };
  });

  app.post("/runs/:id/input", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = await deps.runs.get(id);
    if (!run) {
      return reply.code(404).send({ error: { code: "run_not_found", message: `Run not found: ${id}` } });
    }

    await deps.runService.sendInput(id, inputBody(request.body));
    return reply.code(202).send({ accepted: true });
  });

  app.post("/runs/:id/cancel", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = await deps.runs.get(id);
    if (!run) {
      return reply.code(404).send({ error: { code: "run_not_found", message: `Run not found: ${id}` } });
    }

    const cancelled = await deps.runService.cancelRun(id);
    return reply.send({ run: cancelled });
  });
}

interface CreateRunBody {
  runtime: string;
  provider: string;
  model: string;
  adapterType: "native" | "acpx" | "http" | "webhook" | "process" | "pty" | "browser";
  cwd: string;
  task: string;
  placement?: "local" | "hosted" | "connected_local_node" | undefined;
  approvalPolicy?: string | undefined;
  timeoutSeconds?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

function createRunBody(value: unknown): CreateRunBody {
  if (!value || typeof value !== "object") {
    throw new Error("Request body must be an object");
  }
  const body = value as Record<string, unknown>;
  return {
    runtime: requiredString(body, "runtime"),
    provider: requiredString(body, "provider"),
    model: requiredString(body, "model"),
    adapterType: adapterTypeSchema.parse(body["adapterType"]),
    cwd: requiredString(body, "cwd"),
    task: requiredString(body, "task"),
    placement: typeof body["placement"] === "string" ? body["placement"] as CreateRunBody["placement"] : undefined,
    approvalPolicy: typeof body["approvalPolicy"] === "string" ? body["approvalPolicy"] : undefined,
    timeoutSeconds: typeof body["timeoutSeconds"] === "number" ? body["timeoutSeconds"] : undefined,
    metadata: isRecord(body["metadata"]) ? body["metadata"] : undefined
  };
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function inputBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Input body must be an object");
  }
  return value;
}
