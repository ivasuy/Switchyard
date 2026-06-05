import type { FastifyInstance, FastifyReply } from "fastify";
import type {
  ListModelsFilter,
  ListProvidersFilter,
  ListRuntimeModesFilter,
  ListRuntimesFilter,
  RegistryService,
  RegistryStore
} from "@switchyard/core";
import {
  decodeCursor,
  encodeCursor,
  LIST_LIMIT_DEFAULT,
  listModelsQuerySchema,
  listProvidersQuerySchema,
  listRuntimeModesQuerySchema,
  listRuntimesQuerySchema
} from "@switchyard/contracts";
import { ZodError } from "zod";
import { HttpProblem, sendHttpError, zodIssuesToDetails } from "./http-errors.js";
import { resolveProviderIds, resolveRuntimeIds } from "./registry-helpers.js";

export interface RegistryRouteDependencies {
  registry: RegistryStore;
  doctor: {
    checkRuntimeMode: (idOrSlug: string) => Promise<unknown>;
    summarize: () => Promise<unknown>;
  };
  registryService: RegistryService;
}

export function registerRegistryRoutes(app: FastifyInstance, deps: RegistryRouteDependencies): void {
  if (!deps.doctor) {
    throw new Error("registry routes require doctor dependency");
  }
  if (!deps.registryService) {
    throw new Error("registry routes require registryService dependency");
  }

  app.get("/providers", async (request, reply) => {
    const query = parseQuery(request.query, listProvidersQuerySchema);
    const limit = query.limit ?? LIST_LIMIT_DEFAULT;
    const filter: ListProvidersFilter = { limit };
    if (query.before) filter.before = decodeRegistryCursor(query.before);
    const result = await deps.registry.listProviders(filter);
    return reply.send({ providers: result.providers, nextCursor: result.nextCursor ? encodeRegistryCursor(result.nextCursor.id) : null });
  });

  app.get("/runtimes", async (request, reply) => {
    const query = parseQuery(request.query, listRuntimesQuerySchema);
    const limit = query.limit ?? LIST_LIMIT_DEFAULT;
    const filter: ListRuntimesFilter = { limit };
    const providerIds = resolveProviderIds(query.provider);
    if (providerIds) filter.providerIds = providerIds;
    if (query.adapterType) filter.adapterType = query.adapterType;
    if (query.before) filter.before = decodeRegistryCursor(query.before);
    const result = await deps.registry.listRuntimes(filter);
    return reply.send({ runtimes: result.runtimes, nextCursor: result.nextCursor ? encodeRegistryCursor(result.nextCursor.id) : null });
  });

  app.get("/models", async (request, reply) => {
    const query = parseQuery(request.query, listModelsQuerySchema);
    const limit = query.limit ?? LIST_LIMIT_DEFAULT;
    const filter: ListModelsFilter = { limit };
    const providerIds = resolveProviderIds(query.provider);
    if (providerIds) filter.providerIds = providerIds;
    if (query.before) filter.before = decodeRegistryCursor(query.before);
    const result = await deps.registry.listModels(filter);
    return reply.send({ models: result.models, nextCursor: result.nextCursor ? encodeRegistryCursor(result.nextCursor.id) : null });
  });

  app.get("/runtime-modes", async (request, reply) => {
    const query = parseQuery(request.query, listRuntimeModesQuerySchema);
    const limit = query.limit ?? LIST_LIMIT_DEFAULT;
    const filter: ListRuntimeModesFilter = { limit };
    const providerIds = resolveProviderIds(query.provider);
    const runtimeIds = resolveRuntimeIds(query.runtime);
    if (providerIds) filter.providerIds = providerIds;
    if (runtimeIds) filter.runtimeIds = runtimeIds;
    if (query.adapterType) filter.adapterType = query.adapterType;
    if (query.kind) filter.kind = query.kind;
    if (query.availability) filter.availability = query.availability;
    if (query.placement) filter.placement = query.placement;
    if (query.capability) filter.capability = query.capability;
    if (query.before) filter.before = decodeRegistryCursor(query.before);
    const result = await deps.registry.listRuntimeModes(filter);
    return reply.send({
      runtimeModes: result.runtimeModes,
      nextCursor: result.nextCursor ? encodeRegistryCursor(result.nextCursor.id) : null
    });
  });

  app.get("/providers/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const provider = await lookupProvider(deps.registry, id);
    if (!provider) return sendHttpError(reply, "provider_not_found", `Provider not found: ${id}`);
    return { provider };
  });

  app.get("/runtimes/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const runtime = await lookupRuntime(deps.registry, id);
    if (!runtime) return sendHttpError(reply, "runtime_not_found", `Runtime not found: ${id}`);
    return { runtime };
  });

  app.get("/models/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const model = await lookupModel(deps.registry, id);
    if (!model) return sendHttpError(reply, "model_not_found", `Model not found: ${id}`);
    return { model };
  });

  app.get("/runtime-modes/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const mode = await deps.registry.getRuntimeMode(id);
    if (!mode) {
      return sendHttpError(reply, "runtime_mode_not_found", `Runtime mode not found: ${id}`);
    }
    return { runtimeMode: mode };
  });

  app.post("/runtime-modes/:id/check", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const mode = await deps.registry.getRuntimeMode(id);
    if (!mode) {
      return sendHttpError(reply, "runtime_mode_not_found", `Runtime mode not found: ${id}`);
    }
    const check = await deps.doctor.checkRuntimeMode(id);
    return reply.send({ check });
  });

  app.get("/doctor", async (_request, reply) => {
    const summary = await deps.doctor.summarize();
    return reply.send(summary);
  });
}

async function lookupProvider(registry: RegistryStore, idOrSlug: string) {
  const direct = await registry.getProvider(idOrSlug);
  if (direct) return direct;
  if (!idOrSlug.startsWith("provider_")) return registry.getProvider(`provider_${idOrSlug}`);
  return undefined;
}

async function lookupRuntime(registry: RegistryStore, idOrSlug: string) {
  const direct = await registry.getRuntime(idOrSlug);
  if (direct) return direct;
  if (!idOrSlug.startsWith("runtime_")) return registry.getRuntime(`runtime_${idOrSlug}`);
  return undefined;
}

async function lookupModel(registry: RegistryStore, idOrSlug: string) {
  const direct = await registry.getModel(idOrSlug);
  if (direct) return direct;
  if (!idOrSlug.startsWith("model_")) return registry.getModel(`model_${idOrSlug}`);
  return undefined;
}

function parseQuery<T>(value: unknown, schema: { parse: (value: unknown) => T }): T {
  try {
    return schema.parse(value ?? {});
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpProblem("invalid_query", "Invalid query parameters", zodIssuesToDetails(error));
    }
    throw error;
  }
}

function encodeRegistryCursor(id: string): string {
  return encodeCursor({ id });
}

function decodeRegistryCursor(cursor: string): { id: string } {
  try {
    return decodeCursor(cursor, ["id"] as const);
  } catch {
    throw new HttpProblem("invalid_query", "Malformed cursor", [
      { path: "before", issue: "must be an opaque cursor from a previous response" }
    ]);
  }
}

export type { FastifyReply };
