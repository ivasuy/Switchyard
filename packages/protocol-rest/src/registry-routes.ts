import type { FastifyInstance } from "fastify";
import type { RegistryStore } from "@switchyard/core";

export interface RegistryRouteDependencies {
  registry: RegistryStore;
}

export function registerRegistryRoutes(app: FastifyInstance, deps: RegistryRouteDependencies): void {
  app.get("/providers/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const provider = await deps.registry.getProvider(id);
    if (!provider) {
      return reply.code(404).send({
        error: {
          code: "provider_not_found",
          message: `Provider not found: ${id}`
        }
      });
    }
    return { provider };
  });

  app.get("/runtimes/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const runtime = await deps.registry.getRuntime(id);
    if (!runtime) {
      return reply.code(404).send({
        error: {
          code: "runtime_not_found",
          message: `Runtime not found: ${id}`
        }
      });
    }
    return { runtime };
  });

  app.get("/models/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const model = await deps.registry.getModel(id);
    if (!model) {
      return reply.code(404).send({
        error: {
          code: "model_not_found",
          message: `Model not found: ${id}`
        }
      });
    }
    return { model };
  });
}
