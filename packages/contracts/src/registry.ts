import { z } from "zod";
import { adapterTypeSchema } from "./run.js";
import { providerIdSchema, runtimeIdSchema } from "./ids.js";

export const registryStatusSchema = z.enum(["available", "unavailable", "degraded", "unknown"]);
export const authModeSchema = z.enum(["none", "local", "api_key", "oauth", "custom"]);

export const providerSchema = z.object({
  id: providerIdSchema,
  name: z.string().min(1),
  authMode: authModeSchema,
  status: registryStatusSchema
});

export const runtimeSchema = z.object({
  id: runtimeIdSchema,
  name: z.string().min(1),
  adapterType: adapterTypeSchema,
  status: registryStatusSchema
});

export const modelSchema = z.object({
  id: z.string().min(1),
  providerId: providerIdSchema,
  modelName: z.string().min(1),
  supportsTools: z.boolean().default(false),
  supportsStreaming: z.boolean().default(false),
  supportsBrowser: z.boolean().default(false),
  status: registryStatusSchema
});

export type Provider = z.infer<typeof providerSchema>;
export type RuntimeTarget = z.infer<typeof runtimeSchema>;
export type Model = z.infer<typeof modelSchema>;
